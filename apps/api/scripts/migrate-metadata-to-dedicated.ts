#!/usr/bin/env npx tsx
/**
 * migrate-metadata-to-dedicated.ts — Sprint 2 Track H.
 *
 * Lee `sil_expedientes.metadata` jsonb y escribe a las tablas dedicadas que
 * 0037 + 0038 crearon. Idempotente: usa upsert/unique constraints para no
 * duplicar al re-correr.
 *
 * Origen del workaround:
 *   El Sprint v3 (15-16 may) escribió todos los datos nuevos en
 *   `sil_expedientes.metadata` jsonb para no bloquear demo. Esta migración
 *   los desplaza a las tablas con FK + tipo + RLS + índices.
 *
 * Datos cubiertos:
 *   metadata.fechas_extraidas.vigente            → sil_expediente_fechas_extraidas (0037)
 *   metadata.fechas_extraidas.historial          → sil_expediente_fechas_extraidas con superseded_by
 *   metadata.audiencias                          → sil_expediente_audiencias (0038)
 *   metadata.actas_comision                      → sil_expediente_actas_indexadas (0038)
 *   metadata.consultas_sala_constitucional       → sil_expediente_consultas_sala (0038)
 *   metadata.orden_dia_apariciones               → sil_expediente_orden_dia_apariciones (0038)
 *
 * NO se borra el metadata después — el BFF tiene fallback que lo lee si la
 * tabla está vacía. Borrarlo es un paso posterior cuando confiemos en el
 * pipeline real (cron crawler poblando las tablas).
 *
 * USAGE:
 *   npx tsx apps/api/scripts/migrate-metadata-to-dedicated.ts
 *   npx tsx apps/api/scripts/migrate-metadata-to-dedicated.ts --dry-run
 *   npx tsx apps/api/scripts/migrate-metadata-to-dedicated.ts --expediente=23.511
 *
 * ENV:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

// ─── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const expedienteFilter = args.find((a) => a.startsWith('--expediente='))?.split('=')[1];

console.log('[migrate-metadata-to-dedicated]', {
  dry_run: DRY_RUN,
  filter: expedienteFilter ?? 'todos',
});

// ─── Helpers ───────────────────────────────────────────────────────────────

type Row = Record<string, any>;
let stats = {
  expedientes_visitados: 0,
  fechas_inserted: 0,
  audiencias_inserted: 0,
  actas_inserted: 0,
  sala_inserted: 0,
  orden_dia_inserted: 0,
  errores: [] as string[],
};

async function upsert(table: string, rows: Row[], onConflict?: string): Promise<number> {
  if (rows.length === 0) return 0;
  if (DRY_RUN) {
    console.log(`  [DRY] ${table}: would insert ${rows.length} rows`);
    return rows.length;
  }
  const q = sb.from(table).upsert(rows, { onConflict, ignoreDuplicates: false });
  const { error, count } = await q.select('id', { count: 'exact', head: true });
  if (error) {
    stats.errores.push(`${table}: ${error.message}`);
    console.error(`  ✗ ${table}:`, error.message);
    return 0;
  }
  console.log(`  ✓ ${table}: ${rows.length} rows`);
  return rows.length;
}

// ─── Per-expediente migration ──────────────────────────────────────────────

async function migrateOne(numero: string, meta: Row): Promise<void> {
  stats.expedientes_visitados += 1;
  console.log(`\n── ${numero} ──`);

  // 1. Fechas extraídas (vigente + historial + otras)
  const f = meta.fechas_extraidas ?? {};
  const fechasRows: Row[] = [];

  // Vigente
  if (f.vigente?.valor_fecha) {
    fechasRows.push({
      expediente_id: numero,
      campo: f.vigente.campo ?? 'fecha_dictamen_estimada',
      valor_fecha: f.vigente.valor_fecha,
      valor_texto_original: f.vigente.valor_texto_original ?? null,
      fuente_documento_url: f.vigente.fuente_documento_url ?? null,
      fuente_pagina: f.vigente.fuente_pagina ?? null,
      extraction_method: f.vigente.extraction_method ?? 'manual',
      extraction_confidence: f.vigente.extraction_confidence ?? 0.5,
      visual_marker: f.vigente.visual_marker ?? null,
      superseded_by: null,
    });
  }

  // Otras fechas (cuatrienal, vence_subcomision)
  for (const [campo, valor] of Object.entries(f.otras_fechas ?? {})) {
    if (typeof valor === 'string' && /^\d{4}-\d{2}-\d{2}/.test(valor)) {
      fechasRows.push({
        expediente_id: numero,
        campo,
        valor_fecha: valor,
        extraction_method: 'manual',
        extraction_confidence: 0.6,
        superseded_by: null,
      });
    }
  }

  // Historial — cada entrada vieja queda como una fila marcada superseded
  // por el id de la siguiente. Acá insertamos solo las filas; el linking
  // queda en un pase secundario (TODO si se necesita).
  for (const h of f.historial ?? []) {
    if (h.valor_fecha) {
      fechasRows.push({
        expediente_id: numero,
        campo: 'fecha_dictamen_estimada',
        valor_fecha: h.valor_fecha,
        valor_texto_original: h.detectado ?? null,
        extraction_method: 'manual',
        extraction_confidence: 0.5,
        superseded_reason: h.razon ?? 'historial_seed',
        superseded_by: null, // placeholder; linking real es un futuro pass
      });
    }
  }
  stats.fechas_inserted += await upsert('sil_expediente_fechas_extraidas', fechasRows);

  // 2. Audiencias
  const audiencias = (meta.audiencias ?? []).map((a: Row) => ({
    expediente_id: numero,
    fecha: a.fecha,
    hora: a.hora ?? null,
    comision: a.comision,
    asistente_nombre: a.asistente_nombre,
    asistente_cargo: a.asistente_cargo ?? null,
    asistente_organizacion: a.asistente_organizacion ?? null,
    posicion_estimada: a.posicion_estimada ?? null,
  }));
  stats.audiencias_inserted += await upsert(
    'sil_expediente_audiencias',
    audiencias,
    'expediente_id,fecha,comision,asistente_nombre',
  );

  // 3. Actas con speakers
  const actas = (meta.actas_comision ?? []).map((a: Row) => ({
    expediente_id: numero,
    acta_numero: a.acta_numero,
    comision: a.comision,
    fecha_sesion: a.fecha_sesion,
    acta_pdf_url: a.url ?? a.acta_pdf_url,
    speakers: a.speakers ?? [],
  }));
  stats.actas_inserted += await upsert(
    'sil_expediente_actas_indexadas',
    actas,
    'expediente_id,acta_numero,comision',
  );

  // 4. Consultas a Sala Constitucional
  const sala = (meta.consultas_sala_constitucional ?? []).map((s: Row) => ({
    expediente_id: numero,
    numero_resolucion: s.numero_resolucion ?? `seed-${Math.random().toString(36).slice(2, 10)}`,
    fecha_resolucion: s.fecha_resolucion ?? s.fecha,
    fecha_consulta: s.fecha_consulta ?? null,
    decision: s.decision ?? 'sin_clasificar',
    por_tanto_extracto: s.por_tanto_extracto ?? '',
    magistrados: Array.isArray(s.magistrados)
      ? s.magistrados
      : typeof s.magistrados === 'string'
        ? s.magistrados.split(',').map((m: string) => m.trim())
        : [],
    voto_completo_url: s.voto_completo_url ?? null,
    tipo_consulta: s.tipo_consulta ?? null,
  }));
  stats.sala_inserted += await upsert(
    'sil_expediente_consultas_sala',
    sala,
    'expediente_id,numero_resolucion',
  );

  // 5. Orden día apariciones
  const ordenDia = (meta.orden_dia_apariciones ?? []).map((o: Row) => ({
    expediente_id: numero,
    fecha_sesion: o.fecha_sesion,
    hora: o.hora ?? null,
    numero_sesion: o.numero_sesion ?? null,
    tipo_sesion: o.tipo_sesion ?? 'ordinaria',
    capitulo: o.capitulo,
    capitulo_titulo: o.capitulo_titulo ?? null,
    debate: o.debate,
    orden_pdf_url: o.orden_pdf_url ?? null,
    contexto_extracto: o.contexto_extracto ?? null,
  }));
  stats.orden_dia_inserted += await upsert(
    'sil_expediente_orden_dia_apariciones',
    ordenDia,
    'expediente_id,fecha_sesion,capitulo,debate',
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let q = sb
    .from('sil_expedientes')
    .select('numero, metadata')
    .not('metadata', 'is', null);
  if (expedienteFilter) q = q.eq('numero', expedienteFilter);

  const { data: rows, error } = await q;
  if (error) {
    console.error('FATAL:', error.message);
    process.exit(1);
  }

  // Filter rows that actually have payload to migrate
  const withPayload = (rows ?? []).filter((r: Row) => {
    const m = r.metadata ?? {};
    return !!(
      m.fechas_extraidas ||
      m.audiencias?.length ||
      m.actas_comision?.length ||
      m.consultas_sala_constitucional?.length ||
      m.orden_dia_apariciones?.length
    );
  });

  console.log(`Encontrados ${withPayload.length} expedientes con metadata Sprint v3 a migrar.`);

  for (const r of withPayload) {
    try {
      await migrateOne(r.numero, r.metadata ?? {});
    } catch (e) {
      stats.errores.push(`${r.numero}: ${(e as Error).message}`);
      console.error(`✗ ${r.numero}:`, (e as Error).message);
    }
  }

  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(JSON.stringify(stats, null, 2));
  console.log('========================================');

  if (DRY_RUN) {
    console.log('\nDry run completo. Re-correr SIN --dry-run para aplicar.');
  } else if (stats.errores.length > 0) {
    console.log('\nSe completó con errores. Revisar arriba.');
    process.exit(1);
  } else {
    console.log('\n✓ Migración limpia. metadata jsonb queda como fallback.');
    console.log('  Próximo paso: monitorear /api/expedientes/:numero/full ._source');
    console.log('  → debería decir tabla_dedicada para los 5 campos.');
  }
}

main().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
