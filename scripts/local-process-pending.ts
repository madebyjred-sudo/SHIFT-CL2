/**
 * local-process-pending — corre el pipeline de transcripción desde la máquina
 * local en vez de Cloud Run.
 *
 * Por qué existe:
 *   YouTube bloquea las IPs de egress de Cloud Run/GCP/AWS. yt-dlp (y la lib
 *   youtube-transcript) reciben "Sign in to confirm you're not a bot" incluso
 *   con cookies de un usuario autenticado. La única solución estable es
 *   correr la descarga desde una IP residencial — la de tu Mac sirve.
 *
 *   Este script reproduce exactamente lo que hace el endpoint
 *   /api/internal/process-pending en producción, pero usando processSession()
 *   desde tu Mac. La lógica de Supabase (insert segments, marcar
 *   pending_review, correr LLM review, escanear menciones) corre igual,
 *   simplemente la llamada a yt-dlp ocurre acá y no en el contenedor.
 *
 * Uso:
 *   cd /Users/juan/Downloads/shift-cl2
 *   set -a; source infra/deploy/.env.production; set +a
 *   YT_COOKIES_PATH=/Users/juan/AGENTS/CL2/secrets/youtube-cookies.txt \
 *     npx tsx scripts/local-process-pending.ts [--limit=10] [--skip-llm]
 *
 * Args:
 *   --limit=N      procesa máximo N sesiones (default: 5)
 *   --skip-llm     no corre LLM review (más rápido, útil para smoke test)
 *   --dry-run      lista las sesiones que procesaría sin tocarlas
 *
 * Salida:
 *   Reporta por consola progreso por sesión + summary final.
 *   En Supabase: sessions.status pasa de pending → pending_review,
 *   transcript_segments se llenan, transcripciones_review se backfilla
 *   via el trigger admin_transcripciones_queue view.
 */

import { createClient } from '@supabase/supabase-js';
import { processSession } from '../apps/api/src/jobs/transcriptProcess.js';

interface CliArgs {
  limit: number;
  skipLlm: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { limit: 5, skipLlm: false, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--limit=')) out.limit = Number(arg.split('=')[1]);
    else if (arg === '--skip-llm') out.skipLlm = true;
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  // Validate env upfront so we fail fast with a clear message.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      '✗ Faltan envs: NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.\n' +
        '  Ejecutá: set -a; source infra/deploy/.env.production; set +a',
    );
    process.exit(1);
  }
  if (!process.env.YT_COOKIES_PATH) {
    console.warn(
      '⚠ YT_COOKIES_PATH no está set — yt-dlp puede fallar con bot check.\n' +
        '  Ejecutá con: YT_COOKIES_PATH=/Users/juan/AGENTS/CL2/secrets/youtube-cookies.txt',
    );
  }
  if (!args.skipLlm && !process.env.OPENROUTER_API_KEY) {
    console.error(
      '✗ Falta OPENROUTER_API_KEY (necesario para LLM review). Usá --skip-llm para saltar.',
    );
    process.exit(1);
  }

  const supa = createClient(url, key, { auth: { persistSession: false } });

  // ── Step 1: query pending sessions ─────────────────────────────────────
  // Procesamos en orden: las más recientes primero (fecha desc) para que el
  // operador vea cosas relevantes en la cola al abrir /admin/transcripts.
  const { data: pending, error: queryErr } = await supa
    .from('sessions')
    .select('id, youtube_video_id, status, fecha, comision, metadata')
    .in('status', ['pending', 'transcript_not_ready'])
    .not('youtube_video_id', 'is', null)
    .order('fecha', { ascending: false, nullsFirst: false })
    .limit(args.limit);

  if (queryErr) {
    console.error('✗ Query falló:', queryErr.message);
    process.exit(1);
  }
  if (!pending || pending.length === 0) {
    console.log('ℹ Sin sesiones pendientes. Nada que hacer.');
    return;
  }

  console.log(`→ Encontradas ${pending.length} sesiones para procesar:\n`);
  for (const s of pending) {
    const meta = (s.metadata ?? {}) as Record<string, unknown>;
    const title =
      (meta.raw_title as string | undefined) ?? s.youtube_video_id ?? s.id;
    console.log(
      `   · ${s.fecha ?? '???'} · ${s.status} · ${s.youtube_video_id} · ${String(title).slice(0, 70)}`,
    );
  }

  if (args.dryRun) {
    console.log('\n[dry-run] No se proceso nada.');
    return;
  }

  // ── Step 2: process each session ────────────────────────────────────────
  console.log('');
  let ok = 0;
  let notReady = 0;
  let failed = 0;
  const startBatch = Date.now();

  for (const s of pending) {
    const label = `${s.fecha ?? '???'}/${s.youtube_video_id}`;
    const startMs = Date.now();
    console.log(`→ ${label} — procesando...`);
    try {
      const result = await processSession(s.id, { skipLlmReview: args.skipLlm });
      const dur = ((Date.now() - startMs) / 1000).toFixed(1);
      if (result.status === 'success') {
        ok++;
        console.log(
          `   ✓ ${label} — ${result.segments_inserted} segments + ${result.corrections_inserted} correcciones (${dur}s)`,
        );
      } else if (result.status === 'transcript_not_ready') {
        notReady++;
        console.log(`   ⚠ ${label} — transcript_not_ready (${dur}s)`);
      } else {
        failed++;
        console.log(`   ✗ ${label} — ${result.status}: ${result.error ?? 'unknown'}`);
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`   ✗ ${label} — exception: ${msg.slice(0, 200)}`);
    }
  }

  const totalSec = ((Date.now() - startBatch) / 1000).toFixed(1);
  console.log(
    `\n→ Done. ${ok} ok · ${notReady} not_ready · ${failed} failed · ${totalSec}s total`,
  );
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
