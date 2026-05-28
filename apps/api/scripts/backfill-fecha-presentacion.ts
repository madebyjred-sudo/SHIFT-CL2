/**
 * backfill-fecha-presentacion.ts — pulls fecha_presentacion para expedientes
 * que el ingest viejo dejó en NULL.
 *
 * El SIL scraper `silWebFormsClient.ts` extrae fechaPresentacion correctamente
 * pero el job de ingest no lo persiste a `sil_expedientes.fecha_presentacion`.
 * Este script remedia el hueco para los 53 expedientes afectados (numeros
 * 25.540-25.592 al 2026-05-17).
 *
 * Ejecutar:
 *   set -a && source .env.local && set +a
 *   tsx apps/api/scripts/backfill-fecha-presentacion.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  createSession,
  searchByNumber,
  selectExpedienteDetail,
} from '../src/services/silWebFormsClient.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data: targets, error } = await supa
    .from('sil_expedientes')
    .select('id, numero')
    .is('fecha_presentacion', null)
    .gte('id', 25000)
    .order('id', { ascending: false });
  if (error) throw error;
  console.log(`Backfill candidates: ${targets?.length}`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let session = await createSession();

  for (const exp of targets ?? []) {
    const num = exp.numero as string;
    const numInt = parseInt(num.replace('.', ''), 10);
    try {
      const searched = await searchByNumber(session, numInt);
      session = searched.session;
      let fecha: string | null = searched.detail?.fechaPresentacion ?? null;
      if (!fecha) {
        // Si el listado no trajo la fecha, hacer click para ver el detalle enriched
        const enriched = await selectExpedienteDetail(session, numInt);
        session = enriched.session;
        fecha = enriched.enriched?.fechaPresentacion ?? null;
        // re-crear session limpia para próxima búsqueda
        session = await createSession();
      }
      if (!fecha) {
        console.warn(`[${num}] no fecha encontrada en SIL oficial`);
        skipped++;
        continue;
      }
      const { error: upErr } = await supa
        .from('sil_expedientes')
        .update({ fecha_presentacion: fecha })
        .eq('id', exp.id);
      if (upErr) {
        console.error(`[${num}] update failed: ${upErr.message}`);
        failed++;
      } else {
        console.log(`[${num}] fecha = ${fecha} ✓`);
        updated++;
      }
    } catch (e) {
      console.error(`[${num}] fatal: ${(e as Error).message}`);
      failed++;
      // recrear sesión si el server cerró la cookie
      try { session = await createSession(); } catch { /* noop */ }
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  console.log(`\nDONE. updated=${updated} skipped=${skipped} failed=${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
