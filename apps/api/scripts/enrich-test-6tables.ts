/**
 * Test del enricher extendido contra los 3 expedientes de referencia.
 * Verifica que las 6 tablas auxiliares (audiencias, orden_dia_apariciones,
 * fechas_vigentes [via view], actas_indexadas, tramite, convocatoria) tienen
 * filas después de correr.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { enrichExpediente } from '../src/jobs/silEnrichExpediente.js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supa = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const TARGETS = ['23.511', '25.577', '25.420'];

async function countFor(table: string, numero: string): Promise<number | string> {
  const { count, error } = await supa
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('expediente_id', numero);
  if (error) return `ERR ${error.message}`;
  return count ?? 0;
}

async function main() {
  for (const numero of TARGETS) {
    console.log(`\n→ Running enricher for ${numero}`);
    const result = await enrichExpediente(supa, numero);
    console.log('  enrichResult:', JSON.stringify(result, null, 2));
  }

  console.log('\n\n═══ DB row counts AFTER enrich ═══');
  const tables = [
    'sil_expediente_audiencias',
    'sil_expediente_orden_dia_apariciones',
    'sil_expediente_fechas_vigentes',
    'sil_expediente_actas_indexadas',
    'sil_expediente_tramite',
    'sil_expediente_convocatoria',
  ];
  console.log('expediente   |', tables.map((t) => t.replace('sil_expediente_', '').padEnd(22)).join(' | '));
  for (const numero of TARGETS) {
    const counts = await Promise.all(tables.map((t) => countFor(t, numero)));
    console.log(numero.padEnd(12), '|', counts.map((c) => String(c).padEnd(22)).join(' | '));
  }

  // Spot-check audiencias for 23.511 (where SIL grvConvocatoria is rich)
  console.log('\n═══ Sample audiencias for 23.511 ═══');
  const { data: aud } = await supa
    .from('sil_expediente_audiencias')
    .select('fecha, comision, asistente_nombre, asistente_cargo, asistente_organizacion')
    .eq('expediente_id', '23.511')
    .order('fecha', { ascending: true })
    .limit(5);
  for (const r of aud ?? []) console.log(' ', r);

  // Spot-check tramite for 25.577
  console.log('\n═══ Sample tramite for 25.577 ═══');
  const { data: tr } = await supa
    .from('sil_expediente_tramite')
    .select('orden, organo_legislativo, fecha_inicio, descripcion')
    .eq('expediente_id', '25.577')
    .order('orden', { ascending: true });
  for (const r of tr ?? []) console.log(' ', r);

  // Spot-check fechas_vigentes (view)
  console.log('\n═══ Sample fechas_vigentes for all ═══');
  const { data: fv } = await supa
    .from('sil_expediente_fechas_vigentes')
    .select('expediente_id, campo, valor_fecha, valor_texto_original');
  for (const r of fv ?? []) console.log(' ', r);
}

main().catch((e) => { console.error(e); process.exit(1); });
