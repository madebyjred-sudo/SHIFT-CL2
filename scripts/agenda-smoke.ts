// Live smoke test for agendaScrape — boots WebForms, fetches DOCXs, parses
// expedientes. Defaults to dryRun=true (no DB writes).
//
// Usage:
//   set -a && source .env.local && set +a
//   npx tsx scripts/agenda-smoke.ts             # dryRun
//   npx tsx scripts/agenda-smoke.ts --commit    # actually upsert
import { scrapeAgenda } from '../apps/api/src/jobs/agendaScrape.ts';

async function main() {
  const commit = process.argv.includes('--commit');
  const includeRealized = process.argv.includes('--include-realized');
  const t0 = Date.now();
  console.log(`[agenda-smoke] start dryRun=${!commit} includeRealized=${includeRealized}`);
  const r = await scrapeAgenda({ dryRun: !commit, daysAhead: 14, includeRealized });
  console.log(JSON.stringify(r, null, 2));
  console.log(`[agenda-smoke] elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('[agenda-smoke] error:', e);
  process.exit(1);
});
