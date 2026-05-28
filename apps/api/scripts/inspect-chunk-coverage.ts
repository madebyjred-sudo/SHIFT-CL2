/**
 * Check coverage: how many chunks per source_type, and which session IDs have
 * transcript_segments but no legislative_chunks coverage yet.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const s = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  // Use raw SQL via RPC if available; otherwise paginate.
  const types = ['transcript', 'sil_expediente', 'sil_dictamen', 'sil_mocion', 'sil_votacion', 'sil_acta', 'sil_ley', 'reglamento', 'pdf', 'web', 'metadata'];
  for (const t of types) {
    const { count, error } = await s
      .from('legislative_chunks')
      .select('id', { count: 'exact', head: true })
      .eq('source_type', t);
    console.log('  ', t, '=', count, error ? '(err: ' + error.message + ')' : '');
  }

  // Sessions counts
  const { count: sessTotal } = await s
    .from('sessions')
    .select('*', { count: 'exact', head: true });
  console.log('\nsessions total:', sessTotal);

  const { count: sessIndexed } = await s
    .from('sessions')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'indexed');
  console.log('sessions indexed:', sessIndexed);

  // Sessions whose transcript_segments exist
  const { data: distinctSessions } = await s
    .from('transcript_segments')
    .select('session_id', { count: 'exact' })
    .limit(0);
  console.log('transcript_segments accessible (via head):', distinctSessions);

  // Try to find unique session_ids in transcript_segments by sampling head
  const { data: sample } = await s
    .from('transcript_segments')
    .select('session_id')
    .limit(1000);
  const uniq = new Set((sample ?? []).map((r) => (r as { session_id: string }).session_id));
  console.log('sample unique session ids in 1k transcript rows:', uniq.size);

  // For one sample session, how many segments + how many existing transcript chunks?
  const oneSession = [...uniq][0];
  if (oneSession) {
    const { count: segCount } = await s
      .from('transcript_segments')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', oneSession);
    const { count: chunkCount } = await s
      .from('legislative_chunks')
      .select('*', { count: 'exact', head: true })
      .eq('session_id', oneSession)
      .eq('source_type', 'transcript');
    console.log(`\nsample session ${oneSession}: segments=${segCount} transcript chunks=${chunkCount}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
