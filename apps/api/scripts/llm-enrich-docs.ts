/**
 * llm-enrich-docs.ts — CLI runner del job `runLlmEnrichDocs`.
 *
 * Usage:
 *   # Test 10 docs (NO escribe a DB)
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 npx tsx apps/api/scripts/llm-enrich-docs.ts --limit 10
 *
 *   # Dry-run sin LLM (sólo cuenta candidates + corre regex POR TANTO local)
 *   npx tsx apps/api/scripts/llm-enrich-docs.ts --limit 50 --dry-run
 *
 *   # Producción — los 22k
 *   npx tsx apps/api/scripts/llm-enrich-docs.ts
 *
 *   # Solo dictamenes (filtrar)
 *   npx tsx apps/api/scripts/llm-enrich-docs.ts --tipo dictamen_mayoria
 */
import 'dotenv/config';
import { runLlmEnrichDocs } from '../src/jobs/llmEnrichDocs.js';

function parseArgs(argv: string[]) {
  const out: { limit?: number; dry_run?: boolean; tipo?: string[]; concurrency?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--dry-run') out.dry_run = true;
    else if (a === '--tipo') out.tipo = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  console.log('[llm-enrich-docs] args:', args);

  const result = await runLlmEnrichDocs({
    limit: args.limit,
    dry_run: args.dry_run,
    tipo_filter: args.tipo,
    concurrency: args.concurrency,
  });

  console.log('\n========== RESULTADO ==========');
  console.log(JSON.stringify(result, null, 2));

  // Proyección de costo (Haiku 4.5 OpenRouter):
  // - prompt:     $1.00 / 1M input tokens
  // - completion: $5.00 / 1M output tokens
  // (rates 2026-05-17. Verificar en https://openrouter.ai/anthropic/claude-haiku-4.5)
  const inCost = (result.tokens_in_total / 1_000_000) * 1.0;
  const outCost = (result.tokens_out_total / 1_000_000) * 5.0;
  console.log(`\nCosto observado:    $${(inCost + outCost).toFixed(4)} USD`);
  console.log(`  in:  ${result.tokens_in_total} tokens  →  $${inCost.toFixed(4)}`);
  console.log(`  out: ${result.tokens_out_total} tokens  →  $${outCost.toFixed(4)}`);

  if (result.docs_evaluados > 0 && !args.dry_run) {
    const PENDING_TOTAL = 22249; // pending resumen al inicio del job
    const factor = PENDING_TOTAL / result.docs_evaluados;
    const projectedIn = result.tokens_in_total * factor;
    const projectedOut = result.tokens_out_total * factor;
    const projCost = (projectedIn / 1_000_000) * 1.0 + (projectedOut / 1_000_000) * 5.0;
    console.log(`\nProyección a 22,249 docs:`);
    console.log(`  in:  ~${Math.round(projectedIn).toLocaleString()} tokens`);
    console.log(`  out: ~${Math.round(projectedOut).toLocaleString()} tokens`);
    console.log(`  costo total proyectado: ~$${projCost.toFixed(2)} USD`);
    const projTimeMs = (result.duration_ms / result.docs_evaluados) * PENDING_TOTAL;
    console.log(`  tiempo proyectado: ~${(projTimeMs / 1000 / 60).toFixed(1)} min`);
  }
}

main().catch((err) => {
  console.error('llm-enrich-docs failed:', err);
  process.exit(1);
});
