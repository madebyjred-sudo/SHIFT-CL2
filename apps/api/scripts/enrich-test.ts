/**
 * Quick test del enricher contra 2 expedientes recientes que el usuario vio
 * vacíos en la UI (25.577 y 25.420). Verifica que después de correr el job
 * la tabla `sil_expediente_proponentes` queda poblada.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { enrichExpediente } from '../src/jobs/silEnrichExpediente.js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supa = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  for (const numero of ['25.577', '25.420', '25.545']) {
    console.log(`\n→ ${numero}`);
    const result = await enrichExpediente(supa, numero);
    console.log(JSON.stringify(result, null, 2));
    // Verify proponentes persisted
    const { data: rows } = await supa
      .from('sil_expediente_proponentes')
      .select('firma_orden, diputado_nombre')
      .eq('expediente_id', numero)
      .order('firma_orden');
    console.log(`  proponentes en DB: ${rows?.length}`);
    for (const r of rows ?? []) console.log(`    ${r.firma_orden}. ${r.diputado_nombre}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
