/**
 * local-generate-summaries — genera el resumen estructurado de las sesiones.
 *
 * Por qué existe:
 *   El pipeline ElevenLabs legacy hacía dos cosas en serie: transcribía + un
 *   LLM aparte generaba un resumen ejecutivo con 3 cards (ejecutivo / puntos
 *   clave / acuerdos+mociones). Cuando movimos a YouTube transcript pipeline
 *   en mayo 2026 nos quedamos solo con la transcripción; este script cierra
 *   el gap llamando a OpenRouter (Sonnet 4.6) con el texto completo y
 *   guardando el resultado en `sessions.metadata.resumen`. El endpoint
 *   /api/sessions/:id devuelve eso al frontend que ya sabe pintar las 3
 *   cards (ver SesionViewPage → ResumenBody).
 *
 * Por qué corre LOCAL y no en Cloud Run:
 *   Mismo motivo que local-process-pending: las plenarias largas (12K+
 *   palabras, 3-4h) implican llamadas LLM de 30-60s y prompts de 50-80K
 *   tokens. Las Cloud Run requests tienen timeout práctico de 60s y
 *   prefirimos no pelearnos con eso para 4 sesiones. Cuando provisionemos
 *   el job-runner async (post-demo), este script muere y vive como un
 *   worker.
 *
 * Uso:
 *   cd /Users/juan/Downloads/shift-cl2
 *   set -a; source infra/deploy/.env.production; set +a
 *   npx tsx scripts/local-generate-summaries.ts [--id=<uuid>] [--limit=N] [--force]
 *
 * Flags:
 *   --id=<uuid>   procesa solo esa sesión
 *   --limit=N     procesa máximo N sesiones indexed sin resumen (default 5)
 *   --force       regenera incluso si ya hay metadata.resumen
 *   --dry-run     lista lo que haría sin llamar al LLM
 */

import { createClient } from '@supabase/supabase-js';

const OR_BASE = 'https://openrouter.ai/api/v1';
const MODEL = 'anthropic/claude-sonnet-4-6';
// Sonnet 4.6 acepta 200K tokens. Una plenaria de 4h ~ 15K palabras ~ 22K
// tokens. Cabe sin tocar (no necesitamos chunking en este momento).
const TIMEOUT_MS = 180_000; // 3 min — generación con razonamiento extendido

const SYSTEM_PROMPT = `Sos un analista parlamentario senior para CL2 Consultoría,
firma de asuntos públicos en Costa Rica. Te paso la transcripción completa
de una sesión de la Asamblea Legislativa de Costa Rica. Devolvé un resumen
estructurado en JSON, sin texto adicional.

REGLAS DURAS:
1. NUNCA inventes nombres de diputados, números de expediente, o acuerdos
   que no estén explícitamente en la transcripción.
2. Cuando hay dudas sobre un nombre o número, NO lo incluyas — la firma
   citará este resumen literalmente y un error puntual cuesta credibilidad.
3. Los expedientes citados deben formatearse como "XX.XXX" (e.g. "24.429").
4. Mantené tono editorial neutral. Nada de "lamentablemente", "afortunadamente",
   ni adjetivos calificativos. Solo hechos.
5. Si la sesión no tiene contenido legislativo sustantivo (e.g. fue una sesión
   solemne de homenaje, o una entrevista corta), llená los campos lo mejor
   que puedas y dejá los faltantes vacíos en lugar de inventar.

OUTPUT — JSON estricto:
{
  "ejecutivo": "<párrafo 4-7 oraciones. Estilo briefing de prensa. Qué se discutió, qué ambiente había, en qué quedó la sesión.>",
  "puntos_clave": "<lista markdown con bullets '- '. 5-10 puntos. Cada bullet es una oración con dato concreto: 'El diputado X propuso Y', 'La votación fue 38 a favor', 'Se discutió el expediente 24.429'. Sin adjetivos vacíos.>",
  "acuerdos": "<lista markdown con bullets '- '. Solo acuerdos formales, votaciones, designaciones, mociones aprobadas o rechazadas. Cada bullet empieza con verbo: 'Aprobó X', 'Rechazó Y', 'Eligió a Z presidente'. Si no hubo acuerdos formales, ponelo en una sola línea: 'No se tomaron acuerdos formales durante la sesión.'>"
}`;

interface CliArgs {
  id: string | null;
  limit: number;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { id: null, limit: 5, force: false, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--id=')) out.id = arg.slice('--id='.length);
    else if (arg.startsWith('--limit=')) out.limit = Number(arg.slice('--limit='.length));
    else if (arg === '--force') out.force = true;
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function logger(s: string) {
  process.stdout.write(s.endsWith('\n') ? s : s + '\n');
}

async function generateSummaryForSession(args: {
  supa: ReturnType<typeof createClient>;
  sessionId: string;
  sessionLabel: string;
  apiKey: string;
}): Promise<{ ok: true; bodyLen: number } | { ok: false; error: string }> {
  const { supa, sessionId, sessionLabel, apiKey } = args;

  // 1) Fetch segments y armá el texto plano numerado por timestamp.
  const { data: segs, error: segErr } = await supa
    .from('transcript_segments')
    .select('segment_idx, start_seconds, text')
    .eq('session_id', sessionId)
    .order('segment_idx', { ascending: true });
  if (segErr) return { ok: false, error: `segments fetch: ${segErr.message}` };
  const rows = (segs ?? []) as Array<{ segment_idx: number; start_seconds: number; text: string }>;
  if (rows.length === 0) return { ok: false, error: 'no_segments' };

  const formatTs = (s: number) => {
    const h = Math.floor(s / 3600).toString().padStart(2, '0');
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${h}:${m}:${sec}`;
  };
  const transcriptText = rows
    .map((r) => `[${formatTs(Number(r.start_seconds))}] ${r.text}`)
    .join('\n');

  // 2) Llamada a OpenRouter con timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let llmJson: { choices?: Array<{ message?: { content?: string } }> } | null = null;
  try {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://agentescl2.com',
        'X-Title': 'CL2 Session Summary',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Sesión: ${sessionLabel}\n\nTRANSCRIPCIÓN:\n${transcriptText}`,
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 4_000,
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `LLM HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    llmJson = await res.json();
  } catch (err) {
    return { ok: false, error: `LLM call failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }

  const content = llmJson?.choices?.[0]?.message?.content?.trim() ?? '';
  if (!content) return { ok: false, error: 'empty_llm_response' };

  // 3) Parseo del JSON — Sonnet a veces envuelve en ```json``` aunque pidas json_object
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    try {
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]) as Record<string, unknown>;
    }
  }
  if (!parsed) return { ok: false, error: 'unparseable_llm_json' };

  const resumen = {
    ejecutivo: typeof parsed.ejecutivo === 'string' ? parsed.ejecutivo : null,
    puntos_clave: typeof parsed.puntos_clave === 'string' ? parsed.puntos_clave : null,
    acuerdos: typeof parsed.acuerdos === 'string' ? parsed.acuerdos : null,
    raw: JSON.stringify(parsed),
    generated_at: new Date().toISOString(),
    model: MODEL,
  };

  // 4) Update metadata.resumen — preserva el resto del metadata.
  const { data: cur } = await supa.from('sessions').select('metadata').eq('id', sessionId).maybeSingle();
  const curMeta = (cur?.metadata ?? {}) as Record<string, unknown>;
  const nextMeta = { ...curMeta, resumen };
  const { error: upErr } = await supa.from('sessions').update({ metadata: nextMeta }).eq('id', sessionId);
  if (upErr) return { ok: false, error: `update failed: ${upErr.message}` };

  return {
    ok: true,
    bodyLen:
      (resumen.ejecutivo?.length ?? 0) +
      (resumen.puntos_clave?.length ?? 0) +
      (resumen.acuerdos?.length ?? 0),
  };
}

async function main() {
  const args = parseArgs(process.argv);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!url || !key) {
    logger('✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.');
    process.exit(1);
  }
  if (!apiKey) {
    logger('✗ OPENROUTER_API_KEY missing.');
    process.exit(1);
  }

  const supa = createClient(url, key, { auth: { persistSession: false } });

  // 1) Construir lista de sesiones a procesar.
  let targets: Array<{ id: string; label: string; hasResumen: boolean }> = [];

  if (args.id) {
    const { data, error } = await supa
      .from('sessions')
      .select('id, metadata')
      .eq('id', args.id)
      .maybeSingle();
    if (error || !data) {
      logger(`✗ no encontré la sesión ${args.id}: ${error?.message ?? 'not_found'}`);
      process.exit(1);
    }
    const m = (data.metadata ?? {}) as { raw_title?: string; sesion_label?: string; resumen?: unknown };
    targets = [
      {
        id: data.id as string,
        label: m.raw_title || m.sesion_label || data.id.slice(0, 8),
        hasResumen: !!m.resumen,
      },
    ];
  } else {
    // Sesiones publicadas o en cola, sin resumen aún. Las plenarias largas
    // tienen prioridad — son las que aportan al cliente.
    const { data, error } = await supa
      .from('sessions')
      .select('id, fecha, status, metadata')
      .in('status', ['indexed', 'pending_review'])
      .order('fecha', { ascending: false, nullsFirst: false })
      .limit(200);
    if (error) {
      logger(`✗ query failed: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{
      id: string;
      fecha: string | null;
      status: string;
      metadata: Record<string, unknown> | null;
    }>;
    targets = rows
      .map((r) => {
        const m = (r.metadata ?? {}) as {
          raw_title?: string;
          sesion_label?: string;
          duration_seconds?: number;
          resumen?: unknown;
        };
        return {
          id: r.id,
          label: m.raw_title || m.sesion_label || r.id.slice(0, 8),
          dur: typeof m.duration_seconds === 'number' ? m.duration_seconds : 0,
          hasResumen: !!m.resumen,
        };
      })
      // Filter: necesita transcript suficiente (>=10 min) o que sea plenaria nombrada
      .filter((t) => t.dur >= 600 || /sesi[oó]n\s+(ordinaria|extraordinaria|solemne)/i.test(t.label))
      .filter((t) => args.force || !t.hasResumen)
      .slice(0, args.limit)
      .map(({ id, label, hasResumen }) => ({ id, label, hasResumen }));
  }

  if (targets.length === 0) {
    logger('ℹ Nada que procesar (ya tienen resumen, no son plenarias, o el filtro las descartó).');
    logger('  Usá --force para regenerar.');
    return;
  }

  logger(`→ ${targets.length} sesión(es) a procesar:`);
  for (const t of targets) {
    logger(`   · ${t.id.slice(0, 8)} · ${t.label.slice(0, 70)}${t.hasResumen ? ' (regen)' : ''}`);
  }

  if (args.dryRun) {
    logger('\n[dry-run] No se llamó al LLM.');
    return;
  }

  // 2) Procesa de a uno (la API de OpenRouter rate-limita; paralelizar
  //    no acelera mucho y aumenta el riesgo de 429).
  const startBatch = Date.now();
  let ok = 0;
  let failed = 0;
  for (const t of targets) {
    logger(`\n→ ${t.label.slice(0, 60)}`);
    const t0 = Date.now();
    const result = await generateSummaryForSession({
      supa,
      sessionId: t.id,
      sessionLabel: t.label,
      apiKey,
    });
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    if (result.ok) {
      ok++;
      logger(`   ✓ resumen guardado (${result.bodyLen} chars, ${dur}s)`);
    } else {
      failed++;
      logger(`   ✗ ${result.error}`);
    }
  }

  const totalSec = ((Date.now() - startBatch) / 1000).toFixed(1);
  logger(`\n→ Done. ${ok} ok · ${failed} failed · ${totalSec}s total`);
}

main().catch((err) => {
  logger(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
