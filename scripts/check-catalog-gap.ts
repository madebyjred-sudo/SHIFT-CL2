import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  // 1. Check total expedientes
  const { count: totalExp } = await supa.from('sil_expedientes').select('id', { count: 'exact', head: true });
  console.log(`Total expedientes en sil_expedientes: ${totalExp}`);

  // 2. Check latest expedientes
  const { data: latest } = await supa.from('sil_expedientes')
    .select('id, numero, titulo, fecha_presentacion')
    .order('id', { ascending: false })
    .limit(10);
  console.log('\nÚltimos 10 expedientes:');
  for (const e of latest ?? []) {
    console.log(`  ${e.numero} | ${e.fecha_presentacion} | ${(e.titulo ?? '').slice(0, 60)}`);
  }

  // 3. Check total docs in sil_documentos
  const { count: totalDocs } = await supa.from('sil_documentos').select('id', { count: 'exact', head: true });
  console.log(`\nTotal docs en sil_documentos: ${totalDocs}`);

  // 4. Check if 25.600 has docs
  const { data: exp25600 } = await supa.from('sil_expedientes')
    .select('id, numero, titulo, fecha_presentacion')
    .eq('numero', '25.600')
    .single();
  console.log(`\nExp 25.600: ${JSON.stringify(exp25600)}`);

  if (exp25600) {
    const { data: docs25600, count: docsCount } = await supa.from('sil_documentos')
      .select('id, tipo, titulo', { count: 'exact' })
      .eq('expediente_id', exp25600.id);
    console.log(`Docs en sil_documentos para 25.600: ${docsCount}`);
    for (const d of docs25600 ?? []) {
      console.log(`  ${d.tipo} | ${d.titulo}`);
    }

    // Also check sil_expediente_documentos (the other table)
    const { data: detailDocs, count: detailCount } = await supa.from('sil_expediente_documentos')
      .select('*', { count: 'exact' })
      .eq('expediente_id', '25.600');
    console.log(`Docs en sil_expediente_documentos para 25.600: ${detailCount}`);
    for (const d of detailDocs ?? []) {
      console.log(`  ${JSON.stringify(d)}`);
    }
  }

  // 5. Check the count mismatch - how many unique expedientes in sil_documentos?
  const docExpIds = new Set<number>();
  let off = 0;
  while (true) {
    const { data: chunk } = await supa.from('sil_documentos').select('expediente_id').range(off, off + 999);
    if (!chunk || chunk.length === 0) break;
    for (const r of chunk) docExpIds.add(r.expediente_id as number);
    if (chunk.length < 1000) break;
    off += 1000;
  }
  console.log(`\nDistinct expediente_ids en sil_documentos: ${docExpIds.size}`);

  // 6. Check how many show "1 doc" on the catalog (expedientes that have a doc row in sil_documentos)
  // Check what ID range the docs cover
  const idsArr = Array.from(docExpIds).sort((a, b) => b - a);
  console.log(`Rango de IDs con docs: ${idsArr[idsArr.length - 1]} - ${idsArr[0]}`);
  console.log(`IDs más altos con docs: ${idsArr.slice(0, 10).join(', ')}`);
}
run().catch(console.error);
