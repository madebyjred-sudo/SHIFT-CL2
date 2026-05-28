/**
 * Backfill masivo del enricher sobre todos los expedientes con id >= 25000
 * que no tienen proponentes registrados. Estos son los expedientes recientes
 * descubiertos por el crawler pero sin enriched data.
 *
 * Estima: ~593 expedientes × 4s/expediente ≈ 40 min total.
 *
 * Ejecutar:
 *   set -a && source .env.local && set +a
 *   tsx apps/api/scripts/enrich-recientes.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { enrichExpedientesBulk } from '../src/jobs/silEnrichExpediente.js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supa = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function main() {
  // Find target: expedientes con id >= 25000 que NO tienen proponentes
  const { data: withProp } = await supa.from('sil_expediente_proponentes').select('expediente_id');
  const enrichedSet = new Set((withProp ?? []).map((r) => r.expediente_id as string));

  const { data: candidates } = await supa
    .from('sil_expedientes')
    .select('numero, id')
    .gte('id', 25000)
    .order('id', { ascending: false });

  const targets = (candidates ?? [])
    .filter((r) => !enrichedSet.has(r.numero as string))
    .map((r) => r.numero as string);

  console.log(`Total candidatos: ${candidates?.length} | ya con proponentes: ${enrichedSet.size} | a enriquecer: ${targets.length}`);
  if (targets.length === 0) {
    console.log('Nada que hacer.');
    return;
  }

  const t0 = Date.now();
  const result = await enrichExpedientesBulk(supa, targets, { politenessMs: 700 });
  const elapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\nDONE en ${elapsed} min. enriched=${result.enriched} no_prop=${result.no_proponentes} not_found=${result.not_found} failed=${result.failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
