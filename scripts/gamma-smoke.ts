// Smoke test for Gamma API integration.
//
// Runs end-to-end: createGeneration → poll → return exportUrl. Uses a tiny
// hardcoded markdown so we don't burn many credits.
//
// Usage:
//   set -a && source .env.local && set +a
//   npx tsx scripts/gamma-smoke.ts
import { generateAndWait } from '../apps/api/src/services/gammaApi.ts';

const SAMPLE = `# Cerebro Legislativo 2.0 — Smoke Test

Sistema de IA para legisladores costarricenses.

---

# Lo que hace

- Indexa expedientes del SIL
- Transcribe sesiones de YouTube
- Detecta menciones y plazos
- Genera presentaciones con Gamma

---

# Próximos pasos

- Demo a Oscar el 8 de mayo
- Lanzamiento beta a 10 diputados
`;

async function main() {
  const t0 = Date.now();
  console.log('[gamma-smoke] start');
  console.log('[gamma-smoke] input chars:', SAMPLE.length);

  const result = await generateAndWait(
    {
      inputText: SAMPLE,
      format: 'presentation',
      exportAs: 'pptx',
      cardSplit: 'inputTextBreaks',
      textMode: 'preserve',
      textOptions: { language: 'es-419' },
      imageOptions: { source: 'aiGenerated' },
      cardOptions: { dimensions: '16x9' },
    },
    { maxDurationMs: 5 * 60 * 1000 },
  );

  console.log('[gamma-smoke] DONE', JSON.stringify(result, null, 2));
  console.log(`[gamma-smoke] elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log('\n→ Open in browser:');
  console.log('   gamma deck:', result.gammaUrl);
  console.log('   pptx download:', result.exportUrl);
}

main().catch((e) => {
  console.error('[gamma-smoke] ERROR:', e?.message ?? e);
  if (e?.code) console.error('         code:', e.code);
  if (e?.httpStatus) console.error('         http:', e.httpStatus);
  process.exit(1);
});
