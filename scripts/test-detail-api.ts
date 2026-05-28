import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// Simulate what the API endpoint does after the fix
const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function testExpedienteDetail(numero: string) {
  console.log(`\n=== TESTING EXPEDIENTE ${numero} ===`);

  // Get the expediente
  const { data: general } = await supa.from('sil_expedientes')
    .select('*').eq('numero', numero).single();
  if (!general) { console.log('NOT FOUND'); return; }

  // Query sil_expediente_documentos (enrichment)
  const { data: enrichDocs } = await supa.from('sil_expediente_documentos')
    .select('*').eq('expediente_id', numero);

  // Query sil_documentos (bulk download)
  const { data: bulkDocs } = await supa.from('sil_documentos')
    .select('id, expediente_id, tipo, titulo, source_url, gcs_path, status, text_chars, doc_class')
    .eq('expediente_id', general.id);

  console.log(`  Enrich docs: ${(enrichDocs ?? []).length}`);
  console.log(`  Bulk docs:   ${(bulkDocs ?? []).length}`);

  // Merge logic (same as the fix)
  const enrichKeys = new Set(
    (enrichDocs ?? []).map((d: any) => `${d.tipo}::${(d.titulo ?? '').toLowerCase().slice(0, 40)}`),
  );
  const extraDocs = (bulkDocs ?? []).filter((bd: any) => {
    const key = `${bd.tipo}::${((bd.titulo as string) ?? '').toLowerCase().slice(0, 40)}`;
    return !enrichKeys.has(key);
  });
  
  console.log(`  Extra from bulk (non-duplicate): ${extraDocs.length}`);
  console.log(`  TOTAL merged: ${(enrichDocs ?? []).length + extraDocs.length}`);

  // Query enrichment tables
  const tables = [
    { table: 'sil_expediente_tramite', label: 'Tramitación' },
    { table: 'sil_expediente_proponentes', label: 'Proponentes' },
    { table: 'sil_expediente_consultas', label: 'Consultas' },
  ];
  for (const { table, label } of tables) {
    const { count } = await supa.from(table).select('*', { count: 'exact', head: true }).eq('expediente_id', numero);
    console.log(`  ${label}: ${count ?? 0} rows`);
  }
}

async function run() {
  // Test several expedientes from different years
  const nums = ['25.600', '25.590', '25.436', '25.346', '24.604', '23.511', '22.991'];
  for (const n of nums) {
    await testExpedienteDetail(n);
  }
}
run().catch(console.error);
