/**
 * transcribe-video.ts — Standalone transcription via Vertex Gemini.
 *
 * Reusa apps/api/src/services/geminiVideoTranscript.ts (la receta que
 * usamos para plenarias CL2). Tomá el video ID de YouTube, devuelve
 * transcripción con timestamps + escribe markdown y JSON al disco.
 *
 * Uso:
 *   GOOGLE_APPLICATION_CREDENTIALS=/tmp/shift-cl2-vertex-key.json \
 *     npx tsx scripts/transcribe-video.ts <videoId> [outDir]
 *
 * Ejemplo:
 *   npx tsx scripts/transcribe-video.ts 956DPSPX4wg ~/Downloads/
 *
 * Outputs:
 *   <outDir>/<videoId>.transcript.json  — segmentos crudos con timestamps
 *   <outDir>/<videoId>.transcript.md    — texto plano legible
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import {
  fetchTranscriptViaGemini,
  fetchTranscriptViaGeminiChunked,
  type GeminiSegment,
} from '../apps/api/src/services/geminiVideoTranscript.js';

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function getVideoDuration(videoId: string): number {
  // yt-dlp local da metadatos sin bajar el video. Si falla, devolvemos 0
  // y el caller cae al non-chunked path.
  try {
    const out = execSync(
      `yt-dlp --skip-download --print "%(duration)s" "https://www.youtube.com/watch?v=${videoId}"`,
      { encoding: 'utf-8', timeout: 30_000 },
    ).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function main() {
  const videoId = process.argv[2];
  const outDir = process.argv[3] ?? resolve(process.env.HOME ?? '.', 'Downloads');

  if (!videoId) {
    console.error('Uso: npx tsx scripts/transcribe-video.ts <videoId> [outDir]');
    process.exit(1);
  }

  if (!existsSync(outDir)) {
    await mkdir(outDir, { recursive: true });
  }

  const durationS = getVideoDuration(videoId);
  console.log(`→ video: ${videoId}`);
  console.log(`→ duración: ${durationS > 0 ? `${fmtTime(durationS)} (${durationS}s)` : 'desconocida'}`);
  console.log(`→ outDir: ${outDir}`);

  const start = Date.now();
  let segments: GeminiSegment[];

  if (durationS > 0) {
    segments = await fetchTranscriptViaGeminiChunked(videoId, durationS, {
      windowS: 600,
      onProgress: (done, total) => {
        process.stdout.write(`  chunk ${done}/${total} ✓\n`);
      },
    });
  } else {
    segments = await fetchTranscriptViaGemini(videoId);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✓ ${segments.length} segmentos en ${elapsed}s`);

  // Escribir JSON crudo
  const jsonPath = resolve(outDir, `${videoId}.transcript.json`);
  await writeFile(jsonPath, JSON.stringify(segments, null, 2), 'utf-8');
  console.log(`  → ${jsonPath}`);

  // Escribir Markdown legible
  const mdLines: string[] = [
    `# Transcripción · ${videoId}`,
    ``,
    `Source: https://www.youtube.com/watch?v=${videoId}`,
    `Duración: ${durationS > 0 ? fmtTime(durationS) : 'desconocida'}`,
    `Segmentos: ${segments.length}`,
    `Generado: ${new Date().toISOString()}`,
    `Modelo: Vertex Gemini (Flash o Pro según duración)`,
    ``,
    `---`,
    ``,
  ];
  for (const seg of segments) {
    const t = fmtTime(seg.start_seconds ?? 0);
    const speaker = (seg as any).speaker ? `**${(seg as any).speaker}**: ` : '';
    mdLines.push(`**[${t}]** ${speaker}${seg.text ?? ''}`);
    mdLines.push('');
  }
  const mdPath = resolve(outDir, `${videoId}.transcript.md`);
  await writeFile(mdPath, mdLines.join('\n'), 'utf-8');
  console.log(`  → ${mdPath}`);
}

main().catch((err) => {
  console.error('✗ falló:', err.message ?? err);
  if ((err as any)?.cause) console.error('  cause:', (err as any).cause);
  process.exit(1);
});
