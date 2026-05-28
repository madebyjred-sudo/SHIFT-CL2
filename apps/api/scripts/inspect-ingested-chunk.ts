/**
 * Pull a single ingested chunk back from legislative_chunks via session_id
 * (indexed) and inspect its metadata + embedding shape.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

(async () => {
  // Transcript: known session id from probe
  const sessionId = '01e33561-056d-46dc-b870-6b983424c25a';
  const { data, error } = await s
    .from('legislative_chunks')
    .select('id, source_type, source_ref, chunk_index, content, embedding, metadata, created_at')
    .eq('session_id', sessionId)
    .order('chunk_index', { ascending: true })
    .limit(5);
  if (error) {
    console.log('ERR:', error.message);
    process.exit(1);
  }
  console.log(`Transcript chunks for session ${sessionId.slice(0, 8)}: ${data?.length ?? 0}`);
  for (const row of data ?? []) {
    const r = row as Record<string, unknown>;
    const emb = r.embedding;
    let dim = 0;
    let firstFloats: number[] = [];
    if (typeof emb === 'string') {
      const parts = emb.replace(/^\[/, '').replace(/\]$/, '').split(',');
      dim = parts.length;
      firstFloats = parts.slice(0, 5).map(Number);
    }
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const content = String(r.content ?? '');
    console.log(`
  id=${(r.id as string).slice(0, 8)} source_type=${r.source_type} source_ref=${r.source_ref} chunk_index=${r.chunk_index}
    subtype=${meta.subtype} session_id=${(meta.session_id as string)?.slice(0, 8)} comision=${meta.comision} fecha=${meta.fecha}
    start=${meta.start} end=${meta.end} word_count=${meta.word_count} segments=${(meta.segment_ids as unknown[])?.length}
    content (first 200 chars): ${content.slice(0, 200).replace(/\n/g, ' ')}
    embedding dim=${dim} first5=${JSON.stringify(firstFloats)}`);
  }
})();
