/**
 * Inspect schemas for tables involved in the RAL/transcript -> legislative_chunks
 * ingest pipeline. Read-only.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const s = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const tables = [
  'ral_articulos',
  'ral_interpretaciones',
  'ral_reglas',
  'transcript_segments',
  'sessions',
  'legislative_chunks',
];

async function main() {
  for (const t of tables) {
    console.log('\n=== ' + t + ' ===');
    const { data, error, count } = await s
      .from(t)
      .select('*', { count: 'exact' })
      .limit(1);
    if (error) {
      console.log('  ERR:', error.message);
      continue;
    }
    console.log('  rows total:', count);
    if (data && data.length > 0) {
      console.log('  columns:', Object.keys(data[0]).join(', '));
      // Truncate embedding etc.
      const sample = { ...data[0] };
      for (const k of Object.keys(sample)) {
        const v = (sample as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.length > 300) {
          (sample as Record<string, unknown>)[k] = v.slice(0, 300) + '...[truncated]';
        }
      }
      console.log('  sample:', JSON.stringify(sample, null, 2).slice(0, 2000));
    } else {
      console.log('  (empty)');
    }
  }

  // Distinct source_types currently in legislative_chunks
  console.log('\n=== legislative_chunks source_type distribution ===');
  const { data: chunkData, error: chunkErr } = await s
    .from('legislative_chunks')
    .select('source_type')
    .limit(5000);
  if (chunkErr) {
    console.log('  ERR:', chunkErr.message);
  } else {
    const counts: Record<string, number> = {};
    for (const row of chunkData ?? []) {
      const t = (row as { source_type: string }).source_type;
      counts[t] = (counts[t] ?? 0) + 1;
    }
    console.log('  ', counts);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
