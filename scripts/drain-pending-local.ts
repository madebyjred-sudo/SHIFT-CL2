/**
 * drain-pending-local.ts — corre processSession desde IP local porque
 * Cloud Run egress está bloqueado por YouTube para scraping de transcripts.
 *
 * Lee sessions con status='pending' AND source='youtube' de Supabase prod,
 * para cada una corre el pipeline completo (fetchTranscript + LLM review +
 * insert segments + insert corrections), guarda en Supabase prod.
 *
 * Uso:
 *   set -a && source .env.local && set +a
 *   npx tsx scripts/drain-pending-local.ts [--limit=N] [--skip-llm]
 *
 * Por default procesa hasta 50 sessions secuencialmente.
 */
import { createClient } from '@supabase/supabase-js';
import { processSession } from '../apps/api/src/jobs/transcriptProcess.js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const LIMIT = Number(args.get('limit') ?? 50);
const SKIP_LLM = args.get('skip-llm') === 'true';

async function main() {
  const supa = createClient(SUPA_URL!, SUPA_KEY!, { auth: { persistSession: false } });

  const { data: pending, error } = await supa
    .from('sessions')
    .select('id, youtube_video_id')
    .eq('status', 'pending')
    .eq('source', 'youtube')
    .order('created_at', { ascending: true })
    .limit(LIMIT);

  if (error) throw error;
  if (!pending || pending.length === 0) {
    console.log('[drain] no pending sessions');
    return;
  }

  console.log(`[drain] processing ${pending.length} sessions ${SKIP_LLM ? '(SKIP LLM)' : 'with LLM review'}`);
  const t0 = Date.now();
  const results = { success: 0, not_ready: 0, failed: 0, total_segments: 0, total_corrections: 0 };

  for (let i = 0; i < pending.length; i++) {
    const s = pending[i] as { id: string; youtube_video_id: string | null };
    const t = Date.now();
    process.stdout.write(`[${i + 1}/${pending.length}] ${s.youtube_video_id} ... `);
    try {
      const r = await processSession(s.id, { skipLlmReview: SKIP_LLM });
      const dur = ((Date.now() - t) / 1000).toFixed(1);
      if (r.status === 'success') {
        results.success++;
        results.total_segments += r.segments_inserted;
        results.total_corrections += r.corrections_inserted;
        console.log(`✅ ${r.segments_inserted} segs, ${r.corrections_inserted} corr (${dur}s)`);
      } else if (r.status === 'transcript_not_ready') {
        results.not_ready++;
        console.log(`⏳ not ready (${dur}s)`);
      } else {
        results.failed++;
        console.log(`❌ ${r.error?.slice(0, 60)} (${dur}s)`);
      }
    } catch (err) {
      results.failed++;
      console.log(`💥 ${(err as Error).message?.slice(0, 60)}`);
    }
    // Throttle entre requests para no abusar de YouTube
    await new Promise((r) => setTimeout(r, 1500));
  }

  const totalMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log('');
  console.log(`[drain] DONE in ${totalMin} min`);
  console.log(`        success: ${results.success}, not_ready: ${results.not_ready}, failed: ${results.failed}`);
  console.log(`        total segments inserted: ${results.total_segments}`);
  console.log(`        total corrections inserted: ${results.total_corrections}`);
}

main().catch((err) => {
  console.error('[drain] fatal:', err);
  process.exit(1);
});
