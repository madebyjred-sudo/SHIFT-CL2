import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { enrichExpediente } from '../src/jobs/silEnrichExpediente.js';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  for (const numero of ['23.511', '25.577', '25.420']) {
    console.log(`\n=== ${numero} ===`);
    const r = await enrichExpediente(supa, numero);
    console.log('result:', JSON.stringify(r));
    const { data: docs } = await supa.from('sil_expediente_documentos').select('tipo,titulo,fecha').eq('expediente_id', numero);
    console.log(`docs: ${docs?.length}`);
    for (const d of (docs ?? []).slice(0, 5)) console.log('  -', d.tipo, '|', (d.titulo ?? '').slice(0, 50), '|', d.fecha);
    const { data: auds } = await supa.from('sil_expediente_audiencias').select('fecha,hora,comision').eq('expediente_id', numero);
    console.log(`audiencias: ${auds?.length}`);
    for (const a of auds ?? []) console.log('  -', a.fecha, a.hora ?? '', a.comision ?? '');
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
