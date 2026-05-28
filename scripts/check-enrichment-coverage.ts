import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function countDistinct(table: string, col: string = 'expediente_id'): Promise<number> {
  const ids = new Set<string>();
  let off = 0;
  while (true) {
    const { data, error } = await supa.from(table).select(col).range(off, off + 999);
    if (error) { console.log(`Error querying ${table}: ${error.message}`); return 0; }
    if (!data || data.length === 0) break;
    for (const r of data) ids.add(String((r as any)[col]));
    if (data.length < 1000) break;
    off += 1000;
  }
  return ids.size;
}

async function run() {
  const tables = [
    { table: 'sil_expediente_tramite', label: 'Tramitación' },
    { table: 'sil_expediente_proponentes', label: 'Proponentes' },
    { table: 'sil_expediente_consultas', label: 'Consultas' },
    { table: 'sil_expediente_documentos', label: 'Documentos (enrich)' },
    { table: 'sil_expediente_fechas_vigentes', label: 'Fechas estimadas' },
    { table: 'sil_expediente_audiencias', label: 'Audiencias' },
    { table: 'sil_expediente_actas_indexadas', label: 'Actas comisión' },
    { table: 'sil_expediente_consultas_sala', label: 'Consultas Sala IV' },
    { table: 'sil_expediente_orden_dia_apariciones', label: 'Orden del día' },
  ];

  console.log('=== COBERTURA DE ENRICHMENT (6 tabs) ===\n');
  for (const { table, label } of tables) {
    const count = await countDistinct(table);
    console.log(`${label.padEnd(25)} | ${String(count).padStart(6)} expedientes`);
  }

  // Check a recent expediente (25.590) to see what tabs it has
  const numero = '25.590';
  console.log(`\n=== DETALLE DEL EXPEDIENTE ${numero} ===`);
  for (const { table, label } of tables) {
    const { data, count } = await supa.from(table).select('*', { count: 'exact' }).eq('expediente_id', numero);
    console.log(`${label.padEnd(25)} | ${count ?? 0} rows`);
  }

  // Check an older one that should have full enrichment (24.604)
  const numero2 = '24.604';
  console.log(`\n=== DETALLE DEL EXPEDIENTE ${numero2} ===`);
  for (const { table, label } of tables) {
    const { data, count } = await supa.from(table).select('*', { count: 'exact' }).eq('expediente_id', numero2);
    console.log(`${label.padEnd(25)} | ${count ?? 0} rows`);
  }
}
run().catch(console.error);
