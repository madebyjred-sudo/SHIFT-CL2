/**
 * scripts/test-transcript-granularity.ts
 *
 * Test local: pega a Vertex Gemini sobre UN chunk (5 min) de una sesión
 * conocida y reporta:
 *   - cuántos segments devolvió
 *   - avg dur por segment
 *   - avg chars
 *   - coverage del rango
 *
 * Sirve para validar el SYSTEM_INSTRUCTION nuevo ANTES de deployar.
 * Si genera ~50-100 segments por 300s → fix funcionó. Si genera <30, el
 * modelo sigue ignorando la instrucción de granularidad.
 *
 * Costo por corrida: 1 chunk Pro ≈ $0.02
 *
 * Run:
 *   cd apps/api
 *   set -a && source ../../infra/deploy/.env.production && set +a
 *   export GOOGLE_APPLICATION_CREDENTIALS=/Users/juan/AGENTS/CL2/secrets/shift-cl2-vertex.json
 *   npx tsx ../../scripts/test-transcript-granularity.ts <youtube_video_id> [startS] [endS]
 *
 * Ejemplo:
 *   npx tsx scripts/test-transcript-granularity.ts uFMTFpU1GMI 0 300
 */
import 'dotenv/config';

const videoId = process.argv[2];
const startS = Number(process.argv[3] ?? 0);
const endS = Number(process.argv[4] ?? 300);

if (!videoId) {
  console.error('Usage: tsx test-transcript-granularity.ts <youtube_video_id> [startS] [endS]');
  process.exit(1);
}

async function main() {
  // Importamos dinámicamente desde apps/api para que use el SYSTEM_INSTRUCTION nuevo
  const { fetchTranscriptViaGemini } = await import(
    '../apps/api/src/services/geminiVideoTranscript.ts' as string
  );

  console.log(`\n→ Testing video ${videoId} range ${startS}s-${endS}s (${endS - startS}s window)`);
  console.log(`  Using gemini-2.5-pro · SYSTEM_INSTRUCTION new (granular 3-8s)`);
  console.log(`  Esperando ~50-100 segments si el fix funcionó.\n`);

  const t0 = Date.now();
  const segments = await fetchTranscriptViaGemini(videoId, {
    startOffsetS: startS,
    endOffsetS: endS,
    model: 'gemini-2.5-pro',
  });
  const elapsedMs = Date.now() - t0;

  const totalChars = segments.reduce((a, s) => a + s.text.length, 0);
  const avgChars = Math.round(totalChars / Math.max(segments.length, 1));
  const durations = segments.map((s) => s.end_seconds - s.start_seconds);
  const avgDur = durations.reduce((a, b) => a + b, 0) / Math.max(durations.length, 1);
  const minDur = Math.min(...durations);
  const maxDur = Math.max(...durations);
  const longSegs = segments.filter((s) => s.end_seconds - s.start_seconds > 10).length;
  const veryLongSegs = segments.filter((s) => s.end_seconds - s.start_seconds > 30).length;
  const lastEnd = segments[segments.length - 1]?.end_seconds ?? startS;
  const coverage = (lastEnd - startS) / (endS - startS);

  console.log('═══════════════════ RESULTS ═══════════════════');
  console.log(`Segments returned: ${segments.length}`);
  console.log(`Coverage: ${(coverage * 100).toFixed(1)}% (last_end=${lastEnd.toFixed(1)}s, target=${endS}s)`);
  console.log(`Avg duration: ${avgDur.toFixed(1)}s · min ${minDur.toFixed(1)}s · max ${maxDur.toFixed(1)}s`);
  console.log(`Avg chars per segment: ${avgChars}`);
  console.log(`Total chars: ${totalChars}`);
  console.log(`Segments >10s: ${longSegs}  Segments >30s: ${veryLongSegs}`);
  console.log(`Elapsed: ${elapsedMs}ms`);
  console.log('═══════════════════════════════════════════════');

  // Verdict
  if (segments.length >= 40 && avgDur <= 10 && coverage >= 0.8) {
    console.log('\n✅ PASA: granularidad correcta + buena cobertura.\n');
  } else if (segments.length < 20) {
    console.log('\n❌ FALLA: granularidad insuficiente. Modelo ignora SYSTEM_INSTRUCTION.\n');
  } else if (avgDur > 15) {
    console.log('\n⚠️  WARNING: segments demasiado largos (avg >15s).\n');
  } else if (coverage < 0.6) {
    console.log('\n⚠️  WARNING: coverage incompleta (<60%).\n');
  } else {
    console.log('\n🟡 MIXED: algunos indicadores OK, otros mejorables.\n');
  }

  console.log('First 3 segments preview:');
  for (const s of segments.slice(0, 3)) {
    console.log(`  [${s.start_seconds.toFixed(1)}-${s.end_seconds.toFixed(1)}] ${s.text.slice(0, 100)}`);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
