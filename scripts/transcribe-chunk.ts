/**
 * transcribe-chunk.ts — retry de un chunk individual cuando el chunked
 * principal falla (JSON malformed de Gemini, etc.). Pide solo el rango
 * [startS, endS] y mergea con un transcript existente.
 *
 * Uso:
 *   GOOGLE_APPLICATION_CREDENTIALS=/tmp/shift-cl2-vertex-key.json \
 *     npx tsx scripts/transcribe-chunk.ts <videoId> <startS> <endS> <existingJsonPath>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchTranscriptViaGemini } from '../apps/api/src/services/geminiVideoTranscript.js';

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

async function main() {
  const [videoId, startStr, endStr, jsonPath] = process.argv.slice(2);
  if (!videoId || !startStr || !endStr || !jsonPath) {
    console.error('Uso: tsx scripts/transcribe-chunk.ts <videoId> <startS> <endS> <jsonPath>');
    process.exit(1);
  }
  const startS = Number(startStr);
  const endS = Number(endStr);

  console.log(`→ retry chunk ${startS}s-${endS}s del video ${videoId}`);
  const segs = await fetchTranscriptViaGemini(videoId, {
    startOffsetS: startS,
    endOffsetS: endS,
    model: 'gemini-2.5-flash',
  });
  console.log(`  ${segs.length} segmentos nuevos`);

  // Merge con el JSON existente
  const existing = JSON.parse(await readFile(jsonPath, 'utf-8')) as Array<{ start_seconds: number; text: string }>;
  console.log(`  existing: ${existing.length} segmentos`);

  const merged = [...existing, ...segs];
  merged.sort((a, b) => (a.start_seconds ?? 0) - (b.start_seconds ?? 0));
  console.log(`  merged: ${merged.length} segmentos`);

  await writeFile(jsonPath, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`✓ ${jsonPath}`);

  // Regenerar el .md desde el JSON
  const mdPath = jsonPath.replace(/\.json$/, '.md');
  const mdLines: string[] = [
    `# Transcripción · ${videoId}`,
    ``,
    `Source: https://www.youtube.com/watch?v=${videoId}`,
    `Segmentos: ${merged.length}`,
    `Re-merged: ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
  ];
  for (const seg of merged) {
    const t = fmtTime(seg.start_seconds ?? 0);
    mdLines.push(`**[${t}]** ${seg.text ?? ''}`);
    mdLines.push('');
  }
  await writeFile(mdPath, mdLines.join('\n'), 'utf-8');
  console.log(`✓ ${mdPath}`);
}

main().catch((err) => {
  console.error('✗ falló:', err.message ?? err);
  process.exit(1);
});
