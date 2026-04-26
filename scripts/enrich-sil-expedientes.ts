/**
 * shift-cl2 — Enrich sil_expedientes via the WebForms detail panel.
 *
 * The bulk webforms backfill captured only (numero, titulo) from the
 * search grid. This script iterates the existing sil_expedientes rows,
 * fires the Select$0 postback per expediente, parses the inline detail
 * panel, and UPDATEs the row with proponente, tipo, fechas, número de
 * gaceta/ley, comisiones, etc.
 *
 * Pre-req: 0008_sil_expediente_extras applied (idempotent if not — the
 * extras column write will fail and the row keeps its NULL extras, but
 * the hot-path columns still update).
 *
 * Run:        npm run enrich:sil
 * Time:       ~1h45min for 21k expedientes (concurrency 4, 500ms/worker).
 * Resumable:  set START_FROM=N or RESUME_NULL=1 (default) to pick up only
 *             expedientes whose proponente is still NULL.
 */
import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  createSession,
  searchByNumber,
  selectExpedienteDetail,
  type WebFormsSession,
} from '../apps/api/src/services/silWebFormsClient.js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('[enrich] Supabase env missing'); process.exit(1); }
const supa: SupabaseClient = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

const CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY ?? 4);
const PER_WORKER_DELAY_MS = Number(process.env.ENRICH_DELAY_MS ?? 500);
const SESSION_REFRESH_EVERY = 100;
const RESUME_NULL = (process.env.RESUME_NULL ?? '1') === '1';
const START_FROM = process.env.START_FROM ? Number(process.env.START_FROM) : null;
const ENRICH_LIMIT = process.env.ENRICH_LIMIT ? Number(process.env.ENRICH_LIMIT) : Number.POSITIVE_INFINITY;

interface Stats {
  scanned: number;
  enriched: number;
  errors: number;
  skipped: number;
}

async function fetchTargets(): Promise<number[]> {
  // Two SELECTs because Postgres limits us to 1000 rows per page even with
  // service-role; we paginate to grab everything that's still NULL.
  const ids: number[] = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    let q = supa
      .from('sil_expedientes')
      .select('id')
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (RESUME_NULL) q = q.is('proponente', null);
    if (START_FROM != null) q = q.gte('id', START_FROM);
    const { data, error } = await q;
    if (error) throw new Error(`fetchTargets: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) ids.push((r as { id: number }).id);
    if (data.length < pageSize) break;
    offset += pageSize;
    if (ids.length >= ENRICH_LIMIT) break;
  }
  return ids.slice(0, ENRICH_LIMIT === Number.POSITIVE_INFINITY ? ids.length : ENRICH_LIMIT);
}

interface SharedState {
  cursor: number;
  ids: number[];
  stats: Stats;
}

async function worker(id: number, state: SharedState) {
  let session: WebFormsSession;
  try {
    session = await createSession();
  } catch (err) {
    console.error(`[w${id}] cannot bootstrap session: ${(err as Error).message}`);
    return;
  }
  let sinceRefresh = 0;

  while (true) {
    const i = state.cursor++;
    if (i >= state.ids.length) return;
    const num = state.ids[i];

    if (sinceRefresh >= SESSION_REFRESH_EVERY) {
      try { session = await createSession(); sinceRefresh = 0; }
      catch (err) { console.warn(`[w${id}] refresh failed @${num}: ${(err as Error).message}`); }
    }

    try {
      const r1 = await searchByNumber(session, num);
      session = r1.session;
      sinceRefresh += 1;
      if (!r1.detail) {
        state.stats.skipped += 1;
        continue;
      }
      const r2 = await selectExpedienteDetail(session, num);
      session = r2.session;
      sinceRefresh += 1;
      if (!r2.enriched) {
        state.stats.skipped += 1;
        continue;
      }

      const e = r2.enriched;
      // Build patch — touch only fields we actually got non-null values for.
      const patch: Record<string, unknown> = {};
      if (e.titulo != null && e.titulo.length > 0) patch.titulo = e.titulo;
      if (e.proponente) patch.proponente = e.proponente;
      if (e.tipo) patch.tipo = e.tipo;
      if (e.fechaPresentacion) patch.fecha_presentacion = e.fechaPresentacion;
      // Estado is a derived field — last comisión organo is a strong signal.
      const lastOrgano = e.comisiones[e.comisiones.length - 1]?.organo;
      if (lastOrgano) patch.estado = lastOrgano;
      const firstNonArchive = e.comisiones.find((c) => !/ARCHIVO/i.test(c.organo));
      if (firstNonArchive) patch.comision = firstNonArchive.organo;

      patch.extras = {
        fecha_publicacion: e.fechaPublicacion,
        numero_gaceta: e.numeroGaceta,
        numero_alcance: e.numeroAlcance,
        numero_archivado: e.numeroArchivado,
        vencimiento_cuatrienal: e.vencimientoCuatrienal,
        vencimiento_ordinario: e.vencimientoOrdinario,
        fecha_dispensa: e.fechaDispensa,
        numero_ley: e.numeroLey,
        numero_acuerdo: e.numeroAcuerdo,
        proponentes: e.proponentes,
        comisiones: e.comisiones,
      };
      patch.updated_at = new Date().toISOString();

      const { error: upErr } = await supa
        .from('sil_expedientes')
        .update(patch)
        .eq('id', num);
      if (upErr) {
        // If `extras` column doesn't exist yet (0008 not applied), retry without it.
        if (upErr.message.includes('extras')) {
          delete (patch as { extras?: unknown }).extras;
          const { error: retryErr } = await supa
            .from('sil_expedientes')
            .update(patch)
            .eq('id', num);
          if (retryErr) {
            state.stats.errors += 1;
            console.warn(`[w${id}] update @${num} failed (retry): ${retryErr.message}`);
            continue;
          }
        } else {
          state.stats.errors += 1;
          console.warn(`[w${id}] update @${num} failed: ${upErr.message}`);
          continue;
        }
      }
      state.stats.enriched += 1;
      if (state.stats.enriched % 200 === 0) {
        const pct = ((state.stats.enriched / state.ids.length) * 100).toFixed(1);
        console.log(`[w${id}] +${state.stats.enriched}/${state.ids.length} (${pct}%) @${num} — ${e.proponente ?? '(s/proponente)'}`);
      }
    } catch (err) {
      state.stats.errors += 1;
      console.warn(`[w${id}] err @${num}: ${(err as Error).message}`);
      try { session = await createSession(); sinceRefresh = 0; }
      catch { await new Promise((r) => setTimeout(r, 2_000)); }
    }
    await new Promise((r) => setTimeout(r, PER_WORKER_DELAY_MS));
  }
}

async function main() {
  console.log(`[enrich] start. concurrency=${CONCURRENCY} delay=${PER_WORKER_DELAY_MS}ms resume=${RESUME_NULL}${START_FROM != null ? ` start=${START_FROM}` : ''}`);
  const ids = await fetchTargets();
  console.log(`[enrich] targets: ${ids.length} expedientes`);
  if (ids.length === 0) { console.log('[enrich] nothing to do'); return; }

  const { data: crawlRow } = await supa
    .from('sil_crawl_runs')
    .insert({
      source: 'webforms_consultassil3',
      list_or_target: `enrich:${ids.length} ids`,
    })
    .select('id')
    .single();
  const crawlId = crawlRow?.id ?? null;

  const state: SharedState = {
    cursor: 0,
    ids,
    stats: { scanned: ids.length, enriched: 0, errors: 0, skipped: 0 },
  };
  const startTs = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i, state)));
  const minutes = Math.round((Date.now() - startTs) / 60_000);

  if (crawlId) {
    await supa
      .from('sil_crawl_runs')
      .update({
        finished_at: new Date().toISOString(),
        rows_in: state.stats.scanned,
        rows_out: state.stats.enriched,
        errors: state.stats.errors,
        status: state.stats.errors === 0 ? 'success' : 'partial',
        detail: state.stats,
      })
      .eq('id', crawlId);
  }

  console.log(`\n[enrich] DONE in ${minutes} min — enriched=${state.stats.enriched} skipped=${state.stats.skipped} errors=${state.stats.errors}`);
}

main().catch((err) => { console.error('[enrich] fatal', err); process.exit(1); });
