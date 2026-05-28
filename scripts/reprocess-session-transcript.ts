/**
 * reprocess-session-transcript.ts — Borra segments + chunks de una sesión y la
 * vuelve a procesar desde cero. Útil cuando una sesión quedó con transcript
 * truncado o con calidad degradada (e.g., muchos [inaudible] de Gemini).
 *
 * Uso:
 *   SESSION_ID=3e65413f-... NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *     node --env-file=.env.local --import tsx scripts/reprocess-session-transcript.ts
 *
 * Lo que hace (en orden):
 *   1. Borra transcript_segments donde session_id = X
 *   2. Borra legislative_chunks asociadas (matching session_id en metadata)
 *   3. Update sessions.status = 'pending' para que processSession lo tome
 *   4. Llama processSession(X) — re-fetcha usando TRANSCRIPT_FETCH_STRATEGY
 *      (por defecto: yt-dlp → Gemini → lib). Aplica quality gates; si todo
 *      falla marca la sesión como transcript_broken.
 */
import { createClient } from '@supabase/supabase-js';
import { processSession } from '../apps/api/src/jobs/transcriptProcess.js';

const SESSION_ID = process.env.SESSION_ID;
if (!SESSION_ID) {
  console.error('Falta SESSION_ID env var');
  process.exit(1);
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(`[reprocess] sesión ${SESSION_ID}`);

  // 1. Borra segments existentes
  const { count: segsBefore } = await sb
    .from('transcript_segments')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', SESSION_ID);
  console.log(`  segments antes de borrar: ${segsBefore}`);
  const { error: delSegErr } = await sb
    .from('transcript_segments')
    .delete()
    .eq('session_id', SESSION_ID);
  if (delSegErr) throw new Error(`borrar segments: ${delSegErr.message}`);
  console.log(`  ✓ segments borrados`);

  // 2. Borra chunks asociados (session_id puede estar en metadata)
  const { count: chunksBefore } = await sb
    .from('legislative_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', SESSION_ID);
  if ((chunksBefore ?? 0) > 0) {
    console.log(`  chunks antes de borrar: ${chunksBefore}`);
    const { error: delChunkErr } = await sb
      .from('legislative_chunks')
      .delete()
      .eq('session_id', SESSION_ID);
    if (delChunkErr) throw new Error(`borrar chunks: ${delChunkErr.message}`);
    console.log(`  ✓ chunks borrados`);
  } else {
    console.log(`  no hay chunks asociados a esta sesión`);
  }

  // 3. Borra rows en transcripciones_review (si las hubiera)
  const { error: delRevErr } = await sb
    .from('transcripciones_review')
    .delete()
    .eq('session_id', SESSION_ID);
  if (delRevErr) console.warn(`  warn borrar review: ${delRevErr.message}`);

  // 4. Reset status a 'pending' para que processSession proceda
  const { error: updErr } = await sb
    .from('sessions')
    .update({ status: 'pending' })
    .eq('id', SESSION_ID);
  if (updErr) throw new Error(`update status: ${updErr.message}`);
  console.log(`  ✓ status reseteado a 'pending'`);

  // 5. Disparar processSession
  console.log(`  llamando processSession()...`);
  const t0 = Date.now();
  const result = await processSession(SESSION_ID);
  const dur = Math.round((Date.now() - t0) / 1000);

  console.log(`\n[reprocess] resultado:`);
  console.log(`  status: ${result.status}`);
  console.log(`  segments_inserted: ${result.segments_inserted}`);
  console.log(`  corrections_inserted: ${result.corrections_inserted}`);
  console.log(`  duration: ${dur}s`);
  if (result.error) console.log(`  error: ${result.error}`);
}

main().catch((e) => {
  console.error('[reprocess] fatal:', e);
  process.exit(1);
});
