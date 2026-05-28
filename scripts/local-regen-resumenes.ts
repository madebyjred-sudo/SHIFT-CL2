/**
 * local-regen-resumenes — regenera resumen LLM para sessions sin metadata.resumen.
 *
 * Por qué local:
 *   Cloud Run timeout 60s no alcanza para LLM call de plenarias largas.
 *   Esto corre desde la Mac usando el mismo `generateAndPersistResumen` del
 *   pipeline production, con Vertex Gemini fallback automático si OR sin
 *   créditos.
 *
 * Uso:
 *   cd /Users/juan/Downloads/shift-cl2
 *   set -a; source infra/deploy/.env.production; set +a
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json npx tsx scripts/local-regen-resumenes.ts
 *
 * Selecciona sesiones tipo='plenario'|'extraordinaria' con status='indexed'
 * y metadata->resumen IS NULL, ordenadas por fecha DESC.
 */

import { createClient } from '@supabase/supabase-js';
import { _generateAndPersistResumen } from '../apps/api/src/jobs/transcriptProcess.js';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface SessionRow {
  id: string;
  fecha: string | null;
  tipo: string | null;
  comision: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  youtube_video_id: string | null;
}

async function loadSegments(sessionId: string) {
  const { data, error } = await sb
    .from('transcript_segments')
    .select('start_seconds, text')
    .eq('session_id', sessionId)
    .order('start_seconds', { ascending: true });
  if (error) throw new Error(`load segments: ${error.message}`);
  return (data ?? []) as Array<{ start_seconds: number; text: string }>;
}

async function main() {
  const force = process.argv.includes('--force');
  const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 15);

  console.log(`[regen] looking for ${limit} sessions sin resumen (force=${force})`);

  // Pick sessions
  let q = sb
    .from('sessions')
    .select('id, fecha, tipo, comision, status, metadata, youtube_video_id')
    .in('tipo', ['plenario', 'extraordinaria'])
    .eq('status', 'indexed');
  if (!force) {
    // Solo las que NO tienen resumen
    q = q.is('metadata->resumen', null);
  }
  q = q.order('fecha', { ascending: false }).limit(limit);

  const { data: sessions, error } = await q;
  if (error) throw new Error(`query: ${error.message}`);

  const list = (sessions ?? []) as unknown as SessionRow[];
  console.log(`[regen] found ${list.length} sessions`);

  let success = 0;
  let failed = 0;
  const t0 = Date.now();

  for (const s of list) {
    const tag = `[${s.fecha ?? '?'} ${s.tipo} ${s.id.slice(0, 8)}]`;
    console.log(`\n${tag} loading segments...`);
    const segments = await loadSegments(s.id);
    console.log(`${tag} ${segments.length} segments — calling LLM...`);

    const t = Date.now();
    try {
      const result = await _generateAndPersistResumen(s as unknown as Parameters<typeof _generateAndPersistResumen>[0], segments, { force });
      const dt = ((Date.now() - t) / 1000).toFixed(1);
      if (result.generated) {
        console.log(`${tag} ✓ generated via ${result.provider} in ${dt}s`);
        success++;
      } else {
        console.log(`${tag} ⚠ skipped: ${result.reason} (${dt}s)`);
      }
    } catch (e) {
      const dt = ((Date.now() - t) / 1000).toFixed(1);
      console.error(`${tag} ✗ failed in ${dt}s:`, (e as Error).message);
      failed++;
    }
  }

  const totalMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\n=== RESUMEN: ${success} OK, ${failed} fail en ${totalMin}min ===`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
