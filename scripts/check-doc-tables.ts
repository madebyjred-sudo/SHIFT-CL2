import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  // Check sil_expediente_documentos schema
  const { data: edSample } = await supa.from('sil_expediente_documentos')
    .select('*').limit(2);
  console.log('=== sil_expediente_documentos sample ===');
  console.log(JSON.stringify(edSample, null, 2));

  // Check sil_documentos schema
  const { data: dSample } = await supa.from('sil_documentos')
    .select('*').limit(2);
  console.log('\n=== sil_documentos sample ===');
  console.log(JSON.stringify(dSample, null, 2));

  // Count how many expedientes have docs in each table
  const edIds = new Set<string>();
  let off = 0;
  while (true) {
    const { data } = await supa.from('sil_expediente_documentos').select('expediente_id').range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) edIds.add(r.expediente_id as string);
    if (data.length < 1000) break;
    off += 1000;
  }
  console.log(`\nsil_expediente_documentos: ${edIds.size} unique expedientes`);

  const dIds = new Set<number>();
  off = 0;
  while (true) {
    const { data } = await supa.from('sil_documentos').select('expediente_id').range(off, off + 999);
    if (!data || data.length === 0) break;
    for (const r of data) dIds.add(r.expediente_id as number);
    if (data.length < 1000) break;
    off += 1000;
  }
  console.log(`sil_documentos: ${dIds.size} unique expedientes`);

  // How many are ONLY in sil_documentos (not in sil_expediente_documentos)?
  let onlyInDocs = 0;
  for (const id of dIds) {
    const numStr = id.toString().replace(/(\d+)(\d{3})$/, '$1.$2');
    if (!edIds.has(numStr) && !edIds.has(id.toString())) onlyInDocs++;
  }
  console.log(`Only in sil_documentos (missing from detail): ${onlyInDocs}`);
}
run().catch(console.error);
