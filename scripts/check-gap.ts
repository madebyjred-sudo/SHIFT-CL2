import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  const { data: exps, error } = await supa.from('sil_expedientes')
    .select('id, numero, titulo, fecha_presentacion')
    .gte('id', 25346)
    .lte('id', 25554)
    .order('id', { ascending: true });

  if (error) {
    console.error("Error querying sil_expedientes:", error);
    return;
  }

  console.log(`Total exps in DB between 25.346 and 25.554: ${exps?.length}`);

  let missingTitle = 0;
  let missingDate = 0;
  for (const e of exps || []) {
    if (!e.titulo) missingTitle++;
    if (!e.fecha_presentacion) missingDate++;
  }
  console.log(`Missing titles: ${missingTitle}, Missing dates: ${missingDate}`);

  // Query sil_documentos for this range
  const { data: docs } = await supa.from('sil_documentos')
    .select('expediente_id')
    .gte('expediente_id', 25346)
    .lte('expediente_id', 25554);
    
  const expsWithDocs = new Set(docs?.map(d => d.expediente_id));
  console.log(`Exps with docs in sil_documentos: ${expsWithDocs.size}`);

  // Print the first few missing ones
  const missingExps = [];
  for (let i = 25347; i < 25554; i++) {
    if (!exps?.find(e => e.id === i)) {
      missingExps.push(i);
    }
  }
  console.log(`Ids completely missing from sil_expedientes: ${missingExps.length} (${missingExps.slice(0, 10).join(', ')}...)`);
}

run().catch(console.error);
