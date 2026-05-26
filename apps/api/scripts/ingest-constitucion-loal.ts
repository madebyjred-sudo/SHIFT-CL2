/**
 * CLI runner for the Constitución + LOAL ingest job.
 *
 * Wave 4 #2 (2026-05-26) — sister of scripts/index-reglamento.ts. La
 * lógica real vive en `apps/api/src/jobs/ingestConstitucionLoal.ts` (job
 * importable + testable). Este wrapper solo parsea flags + invoca.
 *
 * Flags:
 *   --dry        Parser only, no Vertex, no Supabase write.
 *   --probe      Limita a primeros 5 artículos por fuente (sanity check
 *                barato antes del run completo).
 *   --only=constitucion / --only=loal   procesa solo ese cuerpo.
 *
 * Run desde la raíz del monorepo:
 *
 *   cd /Users/juan/Downloads/shift-cl2
 *
 *   # Dry run (sin tocar Supabase ni Vertex)
 *   npx tsx -r dotenv/config apps/api/scripts/ingest-constitucion-loal.ts \
 *     dotenv_config_path=.env.local --dry
 *
 *   # Probe (5 primeros artículos cada uno, con embeds reales)
 *   npx tsx -r dotenv/config apps/api/scripts/ingest-constitucion-loal.ts \
 *     dotenv_config_path=.env.local --probe
 *
 *   # Full ingest (197 Constitución + ~100 LOAL si el archivo existe)
 *   npx tsx -r dotenv/config apps/api/scripts/ingest-constitucion-loal.ts \
 *     dotenv_config_path=.env.local
 *
 * Costo Vertex Gemini embedding (3072d, ~$0.00002 / 1k chars):
 *   - Constitución 197 arts * ~1500 chars promedio = ~300k chars ≈ $0.006
 *   - LOAL ~100 arts * ~800 chars = ~80k chars ≈ $0.002
 *   Total: <$0.01 por full run. Re-ejecutable sin preocuparse.
 *
 * Pre-requisitos (env):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GCP_PROJECT_ID
 *   GOOGLE_APPLICATION_CREDENTIALS (path a SA json)
 *
 * Migration 0050_constitucion_loal_source_type.sql DEBE estar aplicada en
 * el Supabase target. Si no, el INSERT explota con
 * `legislative_chunks_source_type_check` violation.
 */
import 'dotenv/config';
import {
  runIngestConstitucionLoal,
  type LegalSourceType,
} from '../src/jobs/ingestConstitucionLoal.js';

function parseArgs(argv: string[]): {
  dry: boolean;
  probe: boolean;
  only: LegalSourceType | undefined;
} {
  const dry = argv.includes('--dry');
  const probe = argv.includes('--probe');
  let only: LegalSourceType | undefined;
  for (const a of argv) {
    if (a === '--only=constitucion') only = 'constitucion';
    if (a === '--only=loal') only = 'loal';
  }
  return { dry, probe, only };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[ingest-c-loal] start. dry=${args.dry} probe=${args.probe} only=${args.only ?? 'both'}`);

  const t0 = Date.now();
  const results = await runIngestConstitucionLoal({
    dry_run: args.dry,
    probe_limit: args.probe ? 5 : undefined,
    only: args.only,
  });

  for (const r of results) {
    console.log(
      `[ingest-c-loal] ${r.source_type.padEnd(12)} ` +
        `parsed=${r.articles_parsed} ` +
        `inserted=${r.articles_inserted} ` +
        `deleted_pre=${r.articles_deleted}` +
        (r.sample_first_article
          ? ` · first="${r.sample_first_article.articulo_header} ${r.sample_first_article.content.slice(0, 60)}…"`
          : ''),
    );
  }

  console.log(`[ingest-c-loal] DONE in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((err) => {
  console.error('[ingest-c-loal] fatal', err);
  process.exit(1);
});
