/**
 * silDiscovery — descubre expedientes nuevos en el SIL oficial e inserta
 *   las filas faltantes en `sil_expedientes` con `fecha_presentacion` ya
 *   populada.
 *
 * Por qué este job existe:
 *   `centinelaSilSync` solo refresca expedientes en watchlist (~10 entidades).
 *   El crawler de SharePoint trae documentos pero no descubre nuevos
 *   expedientes en el catálogo. Sin este job, el SIL nunca se actualiza
 *   solo — depende de que un humano corra un backfill manual. Resultado
 *   en prod: hueco de 11 días entre la última corrida y hoy (bug 2026-05-17).
 *
 * Estrategia:
 *   1. Buscar `max(numero_num)` actual en DB.
 *   2. Probar números consecutivos hacia arriba contra SIL WebForms.
 *   3. Si el SIL devuelve detalle → upsert con fecha_presentacion.
 *   4. Si 5 candidatos consecutivos vuelven vacío → asumir que no hay más
 *      y parar.
 *   5. Cap defensivo en 200 candidatos por run para no saturar al SIL ni
 *      al cron de Cloud Run si el SIL devuelve datos basura.
 *
 * Cuándo correr:
 *   Diario a las 7am Costa Rica (después de horario hábil de Asamblea,
 *   antes del horario de trabajo del consultor que va a ver el catálogo).
 *
 * Idempotencia:
 *   El upsert usa `numero` como conflict key. Si el job descubre un número
 *   que ya existe (race con un backfill manual), simplemente actualiza la
 *   fila — no duplica.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  createSession,
  searchByNumber,
  selectExpedienteDetail,
  type ExpedienteDetail,
} from '../services/silWebFormsClient.js';
import { logger } from '../services/logger.js';

const MAX_CONSECUTIVE_EMPTY = 5;
const MAX_CANDIDATES_PER_RUN = 200;
const POLITENESS_DELAY_MS = 800;

interface DiscoveryResult {
  started_at: string;
  finished_at: string;
  starting_numero: number;
  ending_numero: number;
  discovered_count: number;
  empty_count: number;
  failed_count: number;
  new_numeros: string[];
}

function supa(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('silDiscovery: missing Supabase creds in env');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function getCurrentMaxNumero(s: SupabaseClient): Promise<number> {
  // Tomamos los 100 con numero más alto y elegimos el max real (numero está
  // formateado "25.592" — el sort ascii puede mentir si hay "9.999" vs
  // "10.001"). Convertimos a int para tener orden real.
  const { data, error } = await s
    .from('sil_expedientes')
    .select('numero')
    .order('id', { ascending: false })
    .limit(100);
  if (error) throw new Error(`getCurrentMaxNumero: ${error.message}`);
  let max = 0;
  for (const r of data ?? []) {
    const num = String(r.numero ?? '').replace('.', '');
    const n = parseInt(num, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function formatNumero(n: number): string {
  // SIL display format: "25.592". Inserta el punto entre miles y resto.
  const s = String(n);
  if (s.length <= 3) return s;
  return `${s.slice(0, s.length - 3)}.${s.slice(s.length - 3)}`;
}

async function upsertExpediente(s: SupabaseClient, detail: ExpedienteDetail): Promise<void> {
  // `sil_expedientes.id` es INTEGER NOT NULL sin default (ver
  // migration 0005_sil_corpus.sql: "the expediente number itself"). Hay que
  // calcular id = parseInt(numero sin punto) — convención en toda la tabla
  // (verificado en prod 2026-05-18: id=25592 ↔ numero="25.592").
  // Sin esto la insert peta con 23502 null value in column "id".
  const idInt = parseInt(String(detail.numero).replace(/\./g, ''), 10);
  if (!Number.isFinite(idInt) || idInt <= 0) {
    throw new Error(`upsert ${detail.numero}: cannot derive integer id from numero`);
  }
  const { error } = await s.from('sil_expedientes').upsert(
    {
      id: idInt,
      numero: detail.numero,
      titulo: detail.titulo,
      proponente: detail.proponente,
      comision: detail.comision,
      fecha_presentacion: detail.fechaPresentacion,
      estado: detail.estado,
      tipo: detail.tipo,
      legislatura: detail.legislatura,
      url_detalle: detail.detailUrl,
      scraped_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'numero' },
  );
  if (error) throw new Error(`upsert ${detail.numero}: ${error.message}`);
}

export async function runSilDiscovery(): Promise<DiscoveryResult> {
  const startedAt = new Date().toISOString();
  const s = supa();
  const startNum = (await getCurrentMaxNumero(s)) + 1;
  const newNumeros: string[] = [];
  let consecutiveEmpty = 0;
  let failedCount = 0;
  let emptyCount = 0;
  let endingNumero = startNum - 1;

  logger.info('sil_discovery_start', { starting_at: formatNumero(startNum) });

  let session = await createSession();
  for (let i = 0; i < MAX_CANDIDATES_PER_RUN; i++) {
    const candidate = startNum + i;
    const candidateStr = formatNumero(candidate);
    try {
      const searched = await searchByNumber(session, candidate);
      session = searched.session;
      // El listado del SIL devuelve null detail cuando no hay match.
      let detail = searched.detail;
      // Si tenemos numero+titulo del row pero falta fecha, hacer click para
      // expandir y traer la fechaPresentacion.
      if (detail && !detail.fechaPresentacion) {
        const enriched = await selectExpedienteDetail(session, candidate);
        session = enriched.session;
        if (enriched.enriched?.fechaPresentacion) {
          detail = { ...detail, fechaPresentacion: enriched.enriched.fechaPresentacion };
        }
        // Re-crear sesión para próxima búsqueda (el postback consumió el state)
        session = await createSession();
      }
      if (!detail) {
        consecutiveEmpty++;
        emptyCount++;
        logger.info('sil_discovery_empty', { numero: candidateStr, consecutive: consecutiveEmpty });
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          logger.info('sil_discovery_stop_empty_streak', { last_numero: candidateStr });
          endingNumero = candidate;
          break;
        }
        await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS));
        continue;
      }
      consecutiveEmpty = 0;
      await upsertExpediente(s, detail);
      newNumeros.push(detail.numero);
      endingNumero = candidate;
      logger.info('sil_discovery_found', { numero: detail.numero, fecha: detail.fechaPresentacion });
    } catch (e) {
      failedCount++;
      logger.warn('sil_discovery_candidate_failed', { numero: candidateStr, error: (e as Error).message });
      // Reiniciar sesión si la cookie se corrompió.
      try { session = await createSession(); } catch { /* noop */ }
    }
    await new Promise((r) => setTimeout(r, POLITENESS_DELAY_MS));
  }

  const result: DiscoveryResult = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    starting_numero: startNum,
    ending_numero: endingNumero,
    discovered_count: newNumeros.length,
    empty_count: emptyCount,
    failed_count: failedCount,
    new_numeros: newNumeros,
  };
  logger.info('sil_discovery_complete', { ...result });
  return result;
}
