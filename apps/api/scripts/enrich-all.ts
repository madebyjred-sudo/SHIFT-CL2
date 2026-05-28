/**
 * Backfill MASIVO del enricher sobre TODOS los expedientes que aparecen
 * en el catálogo (= tienen al menos un documento indexado, ~6.508 al
 * 2026-05-17) y que aún no tienen proponentes registrados.
 *
 * Cobertura objetivo: 6.508 expedientes (lo que el usuario ve en /sil).
 * Ya enriched al arrancar: ~53.
 * A procesar: ~6.455.
 *
 * Estimación: 6.455 × ~4s = ~7 horas en single-worker. Si arrancamos en
 * background y dejamos correr en paralelo al cron horario, queda completo
 * en ~3-4 días sin tocar nada.
 *
 * Ejecutar:
 *   set -a && source .env.local && set +a
 *   nohup tsx apps/api/scripts/enrich-all.ts > /tmp/enrich-all.log 2>&1 &
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { enrichExpedientesBulk } from '../src/jobs/silEnrichExpediente.js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supa = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function pageAllDocs(): Promise<Set<number>> {
  const PAGE = 1000;
  const ids = new Set<number>();
  for (let offset = 0; offset < 200_000; offset += PAGE) {
    const { data, error } = await supa
      .from('sil_documentos')
      .select('expediente_id')
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`pageAllDocs offset ${offset}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) ids.add(r.expediente_id as number);
    if (data.length < PAGE) break;
  }
  return ids;
}

async function main() {
  // 1) Set de expedientes que están en el catálogo (tienen ≥1 doc)
  console.log('Indexando expedientes con docs...');
  const expIdsConDoc = await pageAllDocs();
  console.log(`expedientes con docs (en catálogo): ${expIdsConDoc.size}`);

  // 2) Pull todos los expedientes con sus numeros, filtrar al set anterior
  const expedientes: Array<{ id: number; numero: string }> = [];
  for (let offset = 0; offset < 50_000; offset += 1000) {
    const { data, error } = await supa
      .from('sil_expedientes')
      .select('id, numero')
      .order('id', { ascending: false })
      .range(offset, offset + 999);
    if (error) throw new Error(`pull exp offset ${offset}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      if (expIdsConDoc.has(r.id as number)) {
        expedientes.push({ id: r.id as number, numero: r.numero as string });
      }
    }
    if (data.length < 1000) break;
  }
  console.log(`expedientes en catálogo a considerar: ${expedientes.length}`);

  // 3) Set de los YA COMPLETOS: tienen proponentes Y documentos. Los que
  //    solo tienen proponentes (los 1.069 del pass anterior) necesitan
  //    re-procesarse para añadir los documentos descubiertos por el parser
  //    extendido. Audiencias se popula desde agenda_legislativa — no requiere
  //    SIL call extra, así que la rellenamos también en el reproceso.
  const propSet = new Set<string>();
  for (let off = 0; off < 50_000; off += 1000) {
    const { data } = await supa.from('sil_expediente_proponentes').select('expediente_id').range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) propSet.add(r.expediente_id as string);
    if (data.length < 1000) break;
  }
  const docsSet = new Set<string>();
  for (let off = 0; off < 50_000; off += 1000) {
    const { data } = await supa.from('sil_expediente_documentos').select('expediente_id').range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) docsSet.add(r.expediente_id as string);
    if (data.length < 1000) break;
  }
  console.log(`con proponentes: ${propSet.size} | con documentos: ${docsSet.size}`);

  // 4) Target = en catálogo Y le falta proponentes O documentos. Los que
  //    ya tienen ambos los skipeamos (idempotente — re-procesar no rompe
  //    pero gasta tiempo SIL sin ganancia).
  const targets = expedientes
    .filter((e) => !propSet.has(e.numero) || !docsSet.has(e.numero))
    .map((e) => e.numero);
  console.log(`a enriquecer: ${targets.length}`);
  if (targets.length === 0) {
    console.log('Nada que hacer.');
    return;
  }

  const t0 = Date.now();
  let done = 0;
  let lastReportAt = Date.now();

  // Reusa el bulk pero reporta cada N
  // Lo más simple: procesar en chunks y log progress
  const CHUNK = 50;
  const total = { enriched: 0, not_found: 0, failed: 0, no_proponentes: 0 };
  for (let i = 0; i < targets.length; i += CHUNK) {
    const slice = targets.slice(i, i + CHUNK);
    const result = await enrichExpedientesBulk(supa, slice, { politenessMs: 600, maxFailuresInARow: 12 });
    total.enriched += result.enriched;
    total.not_found += result.not_found;
    total.failed += result.failed;
    total.no_proponentes += result.no_proponentes;
    done += slice.length;
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / elapsed;
    const remaining = (targets.length - done) / rate;
    const eta = new Date(Date.now() + remaining * 1000).toISOString();
    if (Date.now() - lastReportAt > 60_000) {
      console.log(`  progress: ${done}/${targets.length} (${(100*done/targets.length).toFixed(1)}%) | enriched=${total.enriched} not_found=${total.not_found} failed=${total.failed} | ETA ${eta}`);
      lastReportAt = Date.now();
    }
  }
  const elapsedMin = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\nDONE en ${elapsedMin} min. enriched=${total.enriched} no_prop=${total.no_proponentes} not_found=${total.not_found} failed=${total.failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
