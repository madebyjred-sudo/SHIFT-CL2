/**
 * verify-vote-linkages.ts — quick smoke verifying que el backfill Wave 4 #4
 * dejó metadata.votando_expediente en chunks de votación. Imprime 5 muestras
 * y un summary.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const { data, error } = await supa
    .from('legislative_chunks')
    .select('id, session_id, chunk_index, content, metadata')
    .eq('source_type', 'transcript')
    .not('metadata->>votando_expediente', 'is', null)
    .limit(5);

  if (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }

  console.log(`Sample con votando_expediente set (${data?.length ?? 0} muestras):\n`);
  for (const r of data ?? []) {
    const meta = r.metadata as Record<string, unknown>;
    const exp = meta.votando_expediente;
    const fecha = meta.fecha;
    const snippet = (r.content as string).slice(0, 200).replace(/\s+/g, ' ');
    console.log(`  chunk ${r.id.slice(0, 8)} · sesion ${(r.session_id as string).slice(0, 8)} · fecha ${fecha}`);
    console.log(`  votando_expediente: ${exp}`);
    console.log(`  content: "${snippet}…"\n`);
  }

  // Aggregate count
  const { count: totalEnriched } = await supa
    .from('legislative_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('source_type', 'transcript')
    .not('metadata->>votando_expediente', 'is', null);
  console.log(`Total chunks transcript con votando_expediente: ${totalEnriched ?? '?'}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
