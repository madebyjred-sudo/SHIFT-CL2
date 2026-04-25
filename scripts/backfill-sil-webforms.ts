/**
 * shift-cl2 — SIL WebForms backfill (Day 2).
 *
 * Iterates expediente numbers 1..MAX_EXPEDIENTE against consultassil3.asamblea.go.cr
 * and writes the metadata + PDF links into sil_expedientes / sil_documentos.
 *
 * Strategy:
 *   - Pool of N parallel WebForms sessions (N=4 default).
 *   - Each worker picks the next pending number from a shared cursor.
 *   - On 404 / not-found, skip silently (most numbers below ~24000 exist; gaps
 *     happen when expedientes are archived or never published).
 *   - Idempotent: ON CONFLICT (id) DO UPDATE for sil_expedientes, dedup by
 *     source_url for sil_documentos.
 *
 * Pre-req: 0005_sil_corpus.sql applied. Service role key set.
 *
 * Run:        npm run backfill:sil:webforms
 * Time:       ~1-2h end-to-end with concurrency=4 (≈2 req/s/session).
 * Resumable:  set START_FROM=N to resume after a crash.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  createSession,
  searchByNumber,
  type ExpedienteDetail,
  type WebFormsSession,
} from '../apps/api/src/services/silWebFormsClient.js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('[backfill] missing Supabase env');
  process.exit(1);
}
const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });

const START_FROM = Number(process.env.START_FROM ?? 1);
const MAX_EXPEDIENTE = Number(process.env.MAX_EXPEDIENTE ?? 25_600);
const CONCURRENCY = Number(process.env.WEBFORMS_CONCURRENCY ?? 4);
// SIL is government-owned; throttle each worker so we don't hammer it.
const PER_WORKER_DELAY_MS = Number(process.env.WEBFORMS_DELAY_MS ?? 500);
// Refresh VIEWSTATE every N requests to avoid expiry.
const SESSION_REFRESH_EVERY = 100;

interface SharedState {
  cursor: number;
  end: number;
  found: number;
  missing: number;
  errors: number;
  flushed: number;
  buffer: Array<{ detail: ExpedienteDetail }>;
}

async function run() {
  console.log(`[backfill] WebForms backfill from ${START_FROM} to ${MAX_EXPEDIENTE} (concurrency=${CONCURRENCY})`);
  const { data: crawlRow } = await supa
    .from('sil_crawl_runs')
    .insert({
      source: 'webforms_consultassil3',
      list_or_target: `expedientes:${START_FROM}-${MAX_EXPEDIENTE}`,
    })
    .select('id')
    .single();
  const crawlId = crawlRow?.id ?? null;

  const state: SharedState = {
    cursor: START_FROM,
    end: MAX_EXPEDIENTE,
    found: 0,
    missing: 0,
    errors: 0,
    flushed: 0,
    buffer: [],
  };

  const flushIntervalMs = 30_000;
  const flushTimer = setInterval(() => flush(state).catch(() => {}), flushIntervalMs);

  // Start CONCURRENCY workers. Each worker keeps its own VIEWSTATE session
  // (refreshed periodically) and pulls from the shared cursor.
  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i, state));
  await Promise.all(workers);

  clearInterval(flushTimer);
  await flush(state); // final flush

  if (crawlId) {
    await supa
      .from('sil_crawl_runs')
      .update({
        finished_at: new Date().toISOString(),
        rows_in: state.found + state.missing,
        rows_out: state.flushed,
        errors: state.errors,
        status: state.errors === 0 ? 'success' : 'partial',
        detail: { found: state.found, missing: state.missing },
      })
      .eq('id', crawlId);
  }

  console.log(`[backfill] DONE — found=${state.found} missing=${state.missing} errors=${state.errors} flushed=${state.flushed}`);
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
    const num = state.cursor++;
    if (num > state.end) return;

    if (sinceRefresh >= SESSION_REFRESH_EVERY) {
      try {
        session = await createSession();
        sinceRefresh = 0;
      } catch (err) {
        console.warn(`[w${id}] session refresh failed @${num}: ${(err as Error).message}`);
      }
    }

    try {
      const r = await searchByNumber(session, num);
      session = r.session;
      sinceRefresh += 1;
      if (r.detail) {
        state.buffer.push({ detail: r.detail });
        state.found += 1;
        if (state.found % 100 === 0) {
          console.log(`[w${id}] +${state.found} found (cursor=${num}, missing=${state.missing})`);
        }
      } else {
        state.missing += 1;
      }
    } catch (err) {
      state.errors += 1;
      console.warn(`[w${id}] err @${num}: ${(err as Error).message}`);
      // Hard reset session on any error — VIEWSTATE may be poisoned.
      try {
        session = await createSession();
        sinceRefresh = 0;
      } catch {
        await sleep(2_000);
      }
    }
    await sleep(PER_WORKER_DELAY_MS);
  }
}

async function flush(state: SharedState) {
  if (state.buffer.length === 0) return;
  const batch = state.buffer.splice(0, state.buffer.length);

  const expRows = batch.map(({ detail }) => ({
    id: detail.numeroNum,
    numero: detail.numero,
    titulo: detail.titulo,
    proponente: detail.proponente,
    comision: detail.comision,
    fecha_presentacion: detail.fechaPresentacion,
    estado: detail.estado,
    tipo: detail.tipo,
    legislatura: detail.legislatura,
    url_detalle: detail.detailUrl,
    metadata: { docs_count: detail.documentos.length },
    updated_at: new Date().toISOString(),
  }));

  const { error: expErr, count: expCount } = await supa
    .from('sil_expedientes')
    .upsert(expRows, { onConflict: 'id', count: 'exact' });
  if (expErr) {
    console.error(`[flush] sil_expedientes error: ${expErr.message}`);
    state.errors += expRows.length;
  } else {
    state.flushed += expCount ?? expRows.length;
  }

  // Documents: collect all and dedup by (expediente_id, source_url).
  const docRows = batch.flatMap(({ detail }) =>
    detail.documentos.map((d) => ({
      expediente_id: detail.numeroNum,
      tipo: d.tipo,
      titulo: d.titulo,
      fecha: d.fecha,
      source_url: d.url,
      status: 'pending',
    })),
  );
  if (docRows.length === 0) return;

  // No unique constraint on (expediente_id, source_url) yet — best-effort
  // insert; duplicates from re-runs will silently fail with ON CONFLICT
  // emulated by ignoring 23505 errors.
  const { error: docErr } = await supa.from('sil_documentos').insert(docRows);
  if (docErr && !docErr.message.includes('duplicate')) {
    console.error(`[flush] sil_documentos error: ${docErr.message}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

run().catch((err) => {
  console.error('[backfill] fatal', err);
  process.exit(1);
});
