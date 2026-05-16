#!/usr/bin/env npx tsx
/**
 * seed-lista-despacho.ts — Sprint 3 Track R, fallback de demo.
 *
 * Si el crawler real no encuentra la lista de despacho en SharePoint
 * (porque el título cambió, la lista no existe todavía, o el endpoint
 * no devuelve nada), corremos este seed para tener 20 items demo y
 * que la UI no quede vacía durante la demo cliente.
 *
 * USAGE:
 *   npx tsx apps/api/scripts/seed-lista-despacho.ts
 *
 *   # Modo dry-run: muestra los items pero NO inserta.
 *   DRY_RUN=1 npx tsx apps/api/scripts/seed-lista-despacho.ts
 *
 * ENV VARS:
 *   NEXT_PUBLIC_SUPABASE_URL      Required.
 *   SUPABASE_SERVICE_ROLE_KEY     Required.
 *   DRY_RUN                       '1' = print + exit, no DB writes.
 *   SEED_EVEN_IF_NOT_EMPTY        '1' = corre aunque ya haya rows.
 *
 * INVARIANTES:
 *   - Idempotente: corre 2 veces = mismo resultado (UNIQUE protege).
 *   - NO toca expedientes que el cliente ya tenga reales — sólo inserta
 *     filas con expediente_id en su tabla cuando coincida con un row real.
 *     Para que no rompa el FK on `sil_expedientes(numero)`, antes de
 *     insertar verifica que cada expediente existe; si no existe, lo
 *     loggea y skipea.
 *   - Por defecto, si la tabla ya tiene >0 rows reales, NO corre (para
 *     no poluir prod). Override con SEED_EVEN_IF_NOT_EMPTY=1.
 *
 * Source: AGENTS/CL2/sprints/2026-05-16-sprint-2-3-design-doc.md Track R.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { logger } from '../src/services/logger.js';

// ─── Los 20 expedientes demo del cliente ───────────────────────────────────
//
// Los números son inventados pero realistas (siguen el patrón "23.xxx" o
// "24.xxx" del SIL Costa Rica). Coverage:
//   - 12 en status='a_despacho' (los que están esperando decisión hoy)
//   - 4 devueltos a comisión
//   - 2 remitidos a plenario
//   - 1 archivado
//   - 1 caduca cuatrienal

interface DemoItem {
  expediente_id: string;
  fecha_entrada: string;
  fecha_salida: string | null;
  status:
    | 'a_despacho'
    | 'devuelto_a_comision'
    | 'remitido_plenario'
    | 'archivado'
    | 'caduca_cuatrienal';
  fuente_pdf_url: string | null;
  comentario_diputado: string | null;
}

const DEMO_ITEMS: DemoItem[] = [
  // Activos a despacho (12)
  { expediente_id: '23.511', fecha_entrada: '2026-05-08', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: 'Pendiente decisión Presidente' },
  { expediente_id: '23.234', fecha_entrada: '2026-05-06', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '23.789', fecha_entrada: '2026-04-29', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '23.901', fecha_entrada: '2026-04-22', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: 'Donovan pidió monitorear' },
  { expediente_id: '24.012', fecha_entrada: '2026-04-15', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '24.103', fecha_entrada: '2026-04-08', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '24.157', fecha_entrada: '2026-04-01', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '24.201', fecha_entrada: '2026-03-25', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: 'Carlos lo trajo del SIL' },
  { expediente_id: '24.245', fecha_entrada: '2026-03-18', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '24.289', fecha_entrada: '2026-03-11', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '24.301', fecha_entrada: '2026-03-04', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '24.355', fecha_entrada: '2026-02-26', fecha_salida: null, status: 'a_despacho', fuente_pdf_url: null, comentario_diputado: null },

  // Devueltos a comisión (4)
  { expediente_id: '23.412', fecha_entrada: '2026-02-12', fecha_salida: '2026-03-05', status: 'devuelto_a_comision', fuente_pdf_url: null, comentario_diputado: 'Devuelto: faltaba dictamen Hacienda' },
  { expediente_id: '23.567', fecha_entrada: '2026-01-22', fecha_salida: '2026-02-18', status: 'devuelto_a_comision', fuente_pdf_url: null, comentario_diputado: null },
  { expediente_id: '23.678', fecha_entrada: '2026-01-08', fecha_salida: '2026-02-02', status: 'devuelto_a_comision', fuente_pdf_url: null, comentario_diputado: 'Reformulación texto sustitutivo' },
  { expediente_id: '23.823', fecha_entrada: '2025-12-15', fecha_salida: '2026-01-12', status: 'devuelto_a_comision', fuente_pdf_url: null, comentario_diputado: null },

  // Remitidos a plenario (2)
  { expediente_id: '23.156', fecha_entrada: '2025-11-20', fecha_salida: '2025-12-10', status: 'remitido_plenario', fuente_pdf_url: null, comentario_diputado: 'Pasó a primer debate' },
  { expediente_id: '23.298', fecha_entrada: '2025-10-08', fecha_salida: '2025-10-29', status: 'remitido_plenario', fuente_pdf_url: null, comentario_diputado: null },

  // Archivado (1)
  { expediente_id: '22.834', fecha_entrada: '2025-09-15', fecha_salida: '2025-11-05', status: 'archivado', fuente_pdf_url: null, comentario_diputado: 'Archivado: dictamen negativo unánime' },

  // Caduca cuatrienal (1)
  { expediente_id: '20.412', fecha_entrada: '2021-08-15', fecha_salida: '2025-08-15', status: 'caduca_cuatrienal', fuente_pdf_url: null, comentario_diputado: 'Plazo de 4 años vencido' },
];

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    logger.error('seed-lista-despacho: missing supabase env');
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const dryRun = process.env.DRY_RUN === '1';

  // 1. Guard: si ya hay rows reales (no de seed), NO correr salvo override.
  if (!process.env.SEED_EVEN_IF_NOT_EMPTY) {
    const { count } = await db
      .from('lista_despacho_items')
      .select('id', { count: 'exact', head: true });
    if ((count ?? 0) > 0) {
      logger.info('seed-lista-despacho: tabla ya tiene rows, abortando', {
        count,
        hint: 'usar SEED_EVEN_IF_NOT_EMPTY=1 para forzar.',
      });
      process.exit(0);
    }
  }

  // 2. Filtrar expedientes que NO existen en sil_expedientes para no romper FK.
  const numeros = DEMO_ITEMS.map((i) => i.expediente_id);
  const { data: existing } = await db
    .from('sil_expedientes')
    .select('numero')
    .in('numero', numeros);

  const exists = new Set(
    ((existing ?? []) as Array<{ numero: string }>).map((r) => r.numero),
  );

  const insertable = DEMO_ITEMS.filter((i) => exists.has(i.expediente_id));
  const skipped = DEMO_ITEMS.filter((i) => !exists.has(i.expediente_id));

  if (skipped.length > 0) {
    logger.warn('seed-lista-despacho: algunos expedientes no existen en sil_expedientes', {
      total_demo: DEMO_ITEMS.length,
      skipped_count: skipped.length,
      skipped_numeros: skipped.map((s) => s.expediente_id),
      hint: 'corré bulk SIL para esos expedientes o ajustá los números demo.',
    });
  }

  if (dryRun) {
    logger.info('seed-lista-despacho: DRY RUN — items que se insertarían:', {
      count: insertable.length,
      items: insertable,
    });
    process.exit(0);
  }

  // 3. Upsert idempotente.
  const rows = insertable.map((i) => ({
    expediente_id: i.expediente_id,
    fecha_entrada: i.fecha_entrada,
    fecha_salida: i.fecha_salida,
    status: i.status,
    fuente_pdf_url: i.fuente_pdf_url,
    comentario_diputado: i.comentario_diputado,
    raw: { seed: true, seeded_at: new Date().toISOString() },
  }));

  const { data: inserted, error } = await db
    .from('lista_despacho_items')
    .upsert(rows, {
      onConflict: 'expediente_id,fecha_entrada',
      ignoreDuplicates: true,
    })
    .select('id, expediente_id, status');

  if (error) {
    logger.error('seed-lista-despacho: upsert failed', { error: error.message });
    process.exit(1);
  }

  logger.info('seed-lista-despacho: done', {
    inserted: (inserted ?? []).length,
    attempted: rows.length,
    skipped_fk: skipped.length,
  });
  process.exit(0);
}

main().catch((err) => {
  logger.error('seed-lista-despacho: fatal', { error: (err as Error).message });
  process.exit(1);
});
