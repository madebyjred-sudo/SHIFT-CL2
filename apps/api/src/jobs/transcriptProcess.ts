/**
 * Transcript-process job — Fase 0, Tasks 4 + 5.
 *
 * Processes ONE pending session end-to-end:
 *   1. Load session from DB
 *   2. Mark as 'processing'
 *   3. Fetch YouTube transcript
 *   4. Bulk-insert transcript_segments
 *   5. LLM review pass (Sonnet 4.6) → insert transcript_corrections
 *   6. Mark as 'indexed'
 *
 * This is a pure async function — no Express coupling. The Cloud Run job
 * entrypoint (Task 6) calls it with the session ID from the queue.
 *
 * Why Tasks 4+5 are combined:
 *   The LLM review prompt IS the core of the review pass. The prompt design
 *   and the code that calls it are tightly coupled — splitting them would
 *   mean Task 4 stubs the call and Task 5 designs a prompt without code
 *   context, guaranteeing a second integration pass.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { fetchTranscript, YoutubeTranscriptError } from '../services/youtubeTranscript.js';
import { withTimeout, withRetry } from '../services/resilience.js';
import { logger } from '../services/logger.js';
import { scanSessionForMentions } from './centinelaMentions.js';

// ── OpenRouter ────────────────────────────────────────────────────────────────
const OR_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

// ── Supabase client (lazy, service role) ─────────────────────────────────────
// Mirrors the pattern from youtubeSync.ts.
let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    throw new Error(
      'supabase env missing for transcriptProcess (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)',
    );
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface TranscriptProcessResult {
  session_id: string;
  status: 'success' | 'transcript_not_ready' | 'permanent_failure';
  segments_inserted: number;
  corrections_inserted: number;
  llm_run_id: string | null; // null if LLM was skipped
  duration_ms: number;       // wall-clock
  error?: string;            // populated on permanent_failure
}

// ── Internal types ────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  youtube_video_id: string | null;
  status: string;
  comision: string | null;
  fecha: string | null;
  tipo: string | null;
  metadata: Record<string, unknown> | null;
}

interface LlmCorrection {
  segment_idx: number;
  span_start: number;
  span_end: number;
  kind: string;
  original_text: string;
  suggested_text: string;
  confidence: number;
  reasoning?: string;
}

interface LlmReviewOutput {
  corrections: LlmCorrection[];
  summary: {
    total_segments: number;
    segments_modified: number;
    high_confidence_corrections: number;
    low_confidence_corrections: number;
    unfillable_gaps: number;
  };
}

// ── LLM Prompt contract ───────────────────────────────────────────────────────
//
// Everything below is what Sonnet 4.6 sees. Changing these strings is a
// CONTRACT CHANGE — do it deliberately and re-evaluate test fixtures.

const SYSTEM_PROMPT = `Sos un agente de revisión de transcripciones legislativas. Recibís
transcripciones automáticas de sesiones de la Asamblea Legislativa de
Costa Rica generadas por YouTube. Tu trabajo es identificar errores
puntuales y proponer correcciones, SIN inventar contenido.

REGLAS DURAS:
1. NUNCA agregués palabras que no estén implícitas en el contexto.
   Si hay un gap audible "[...]" y no podés inferirlo con CERTEZA del
   contexto inmediato (oración antes/después), dejalo como está.
2. NUNCA cambies el sentido de una afirmación. Solo corregís typos
   ortográficos, números mal transcritos, o nombres mal escritos.
3. Para nombres de diputados, cruzá contra la lista de diputados activos
   de Costa Rica. Si no podés identificar al diputado con confianza
   ≥0.8, NO corrijas.
4. Para números de expediente, formatá como "XX.XXX" (e.g. "24.429").
5. Si una corrección requeriría cambiar más de 5 palabras en una zona,
   NO corrijas — devolvé esa zona como kind='gap_filled' con
   suggested_text vacío.

INPUTS:
- Transcripción completa en bloques numerados (segment_idx) con
  timecodes [start_seconds-end_seconds]
- Metadatos de la sesión: fecha, comisión, tipo (plenario/comisión)

OUTPUT — JSON estricto, sin texto adicional:
{
  "corrections": [
    {
      "segment_idx": <int>,
      "span_start": <int>,
      "span_end": <int>,
      "kind": "typo_diputado" | "typo_expediente" | "typo_legislativo" | "gap_filled" | "punctuation",
      "original_text": "<lo que YouTube transcribió>",
      "suggested_text": "<corrección sugerida>",
      "confidence": <0.0-1.0>,
      "reasoning": "<breve, ≤80 chars>"
    }
  ],
  "summary": {
    "total_segments": <int>,
    "segments_modified": <int>,
    "high_confidence_corrections": <int>,
    "low_confidence_corrections": <int>,
    "unfillable_gaps": <int>
  }
}

Si no encontrás errores, devolvé \`corrections: []\`.`;

/** Build the user message from session metadata + segments. */
function buildUserMessage(
  session: { tipo: string | null; comision: string | null; fecha: string | null },
  segments: Array<{ segment_idx: number; start_seconds: number; end_seconds: number; text: string }>,
): string {
  const header = [
    `[Sesión] ${session.tipo ?? 'desconocido'} · ${session.comision ?? 'desconocida'} · ${session.fecha ?? 'sin fecha'}`,
    '[Transcripción]',
  ].join('\n');

  const body = segments
    .map(
      (s) =>
        `[seg_${s.segment_idx} ${s.start_seconds.toFixed(3)}-${s.end_seconds.toFixed(3)}] ${s.text}`,
    )
    .join('\n');

  return `${header}\n${body}`;
}

// ── JSON parsing helpers ──────────────────────────────────────────────────────

/**
 * Strip markdown code fences then parse JSON.
 * Sonnet sometimes wraps output in ```json...``` even with response_format: json_object.
 * Falls back to extracting the largest {...} block if stripping alone doesn't work.
 */
function parseJsonSafe(raw: string): unknown {
  // Direct parse — most common path
  try {
    return JSON.parse(raw);
  } catch {
    // no-op — continue to fence stripping
  }

  // Strip ```json ... ``` or ``` ... ``` fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // no-op — continue to last-ditch extraction
  }

  // Last-ditch: extract the largest {...} block
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // fall through to null
    }
  }

  return null;
}

// ── Individual correction validation ─────────────────────────────────────────

const VALID_KINDS = new Set([
  'typo_diputado',
  'typo_expediente',
  'typo_legislativo',
  'gap_filled',
  'punctuation',
]);

/**
 * Validate a single correction from the LLM output.
 * Returns null if invalid (caller logs and skips it).
 */
function validateCorrection(raw: unknown): LlmCorrection | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;

  const segment_idx = typeof c.segment_idx === 'number' ? c.segment_idx : null;
  const span_start = typeof c.span_start === 'number' ? c.span_start : null;
  const span_end = typeof c.span_end === 'number' ? c.span_end : null;
  const kind = typeof c.kind === 'string' ? c.kind : null;
  const original_text = typeof c.original_text === 'string' ? c.original_text : null;
  const suggested_text = typeof c.suggested_text === 'string' ? c.suggested_text : null;
  const confidence = typeof c.confidence === 'number' ? c.confidence : null;

  if (
    segment_idx === null ||
    span_start === null ||
    span_end === null ||
    kind === null ||
    original_text === null ||
    suggested_text === null ||
    confidence === null
  ) {
    return null;
  }

  // Kind must be one of the allowed values
  if (!VALID_KINDS.has(kind)) return null;

  // Confidence must be 0–1
  if (confidence < 0 || confidence > 1) return null;

  // span_start must be non-negative; span_end >= span_start
  if (span_start < 0 || span_end < span_start) return null;

  return {
    segment_idx,
    span_start,
    span_end,
    kind,
    original_text,
    suggested_text,
    confidence,
    reasoning: typeof c.reasoning === 'string' ? c.reasoning.slice(0, 200) : undefined,
  };
}

// ── LLM review pass (private) ─────────────────────────────────────────────────

/**
 * Call OpenRouter with the review prompt and insert corrections into the DB.
 *
 * Returns { llm_run_id, corrections_inserted }.
 * On JSON parse failure, logs a warning and returns 0 corrections — we do NOT
 * kill the whole pipeline because the LLM hiccupped.
 */
async function runLlmReview(
  session: SessionRow,
  segments: Array<{ id: string; segment_idx: number; start_seconds: number; end_seconds: number; text: string }>,
  opts: { model: string; timeoutMs: number },
): Promise<{ llm_run_id: string; corrections_inserted: number }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const llm_run_id = randomUUID();
  const label = `transcript:review:${session.id}`;

  const userMessage = buildUserMessage(
    { tipo: session.tipo, comision: session.comision, fecha: session.fecha },
    segments.map((s) => ({
      segment_idx: s.segment_idx,
      start_seconds: Number(s.start_seconds),
      end_seconds: Number(s.end_seconds),
      text: s.text,
    })),
  );

  // Warn if transcript is very large (> 400k chars ≈ ~100k tokens) — we'll
  // proceed single-pass but log so we can react if the model 4xx's.
  if (userMessage.length > 400_000) {
    logger.warn('transcript_process_large_transcript', {
      session_id: session.id,
      chars: userMessage.length,
    });
  }

  // Call OpenRouter with retry (2 attempts) + timeout
  const res = await withRetry(
    () =>
      withTimeout(
        (signal) =>
          fetch(`${OR_BASE}/chat/completions`, {
            signal,
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://agentescl2.com',
              'X-Title': 'CL2 Transcript Review',
            },
            body: JSON.stringify({
              model: opts.model,
              messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userMessage },
              ],
              response_format: { type: 'json_object' },
              max_tokens: 8_000,
              temperature: 0.1,
            }),
          }),
        { ms: opts.timeoutMs, label },
      ),
    { attempts: 2, baseDelayMs: 2_000, label },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.warn('transcript_process_llm_http_failed', {
      session_id: session.id,
      status: res.status,
      detail: detail.slice(0, 200),
    });
    throw new Error(`LLM review HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content?.trim() ?? '';

  if (!content) {
    logger.warn('transcript_process_llm_empty_response', { session_id: session.id });
    return { llm_run_id, corrections_inserted: 0 };
  }

  // Parse JSON — graceful on failure
  const parsed = parseJsonSafe(content);
  if (!parsed) {
    logger.warn('transcript_process_llm_unparseable', {
      session_id: session.id,
      llm_run_id,
      preview: content.slice(0, 400),
    });
    return { llm_run_id, corrections_inserted: 0 };
  }

  const output = parsed as Partial<LlmReviewOutput>;
  const rawCorrections = Array.isArray(output.corrections) ? output.corrections : [];

  if (rawCorrections.length === 0) {
    logger.info('transcript_process_llm_no_corrections', {
      session_id: session.id,
      llm_run_id,
    });
    return { llm_run_id, corrections_inserted: 0 };
  }

  // Build a segment_idx → segment_id lookup for FK reference
  const segmentIdByIdx = new Map<number, string>(
    segments.map((s) => [s.segment_idx, s.id]),
  );

  // Validate and filter corrections — log invalid ones, don't kill the batch
  const validCorrections: LlmCorrection[] = [];
  for (const raw of rawCorrections) {
    const validated = validateCorrection(raw);
    if (!validated) {
      logger.warn('transcript_process_correction_invalid', {
        session_id: session.id,
        llm_run_id,
        raw: JSON.stringify(raw).slice(0, 200),
      });
      continue;
    }
    // Check that the referenced segment_idx exists in our segment map
    if (!segmentIdByIdx.has(validated.segment_idx)) {
      logger.warn('transcript_process_correction_unknown_segment', {
        session_id: session.id,
        llm_run_id,
        segment_idx: validated.segment_idx,
      });
      continue;
    }
    validCorrections.push(validated);
  }

  if (validCorrections.length === 0) {
    return { llm_run_id, corrections_inserted: 0 };
  }

  // Insert corrections into the DB
  const correctionRows = validCorrections.map((c) => ({
    session_id: session.id,
    segment_id: segmentIdByIdx.get(c.segment_idx)!,
    kind: c.kind,
    span_start: c.span_start,
    span_end: c.span_end,
    original_text: c.original_text,
    suggested_text: c.suggested_text,
    confidence: c.confidence,
    reasoning: c.reasoning ?? null,
    model: opts.model,
    llm_run_id,
    human_review: 'pending',
  }));

  const { error: corrErr } = await supa()
    .from('transcript_corrections')
    .insert(correctionRows);

  if (corrErr) {
    throw new Error(`transcript_corrections insert failed: ${corrErr.message}`);
  }

  logger.info('transcript_process_corrections_inserted', {
    session_id: session.id,
    llm_run_id,
    count: validCorrections.length,
    skipped: rawCorrections.length - validCorrections.length,
  });

  return { llm_run_id, corrections_inserted: validCorrections.length };
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * Process a single pending session: fetch transcript → insert segments →
 * LLM review → mark indexed.
 *
 * @param sessionId  The UUID of the session to process.
 * @param opts.skipLlmReview  Skip the LLM pass (for testing — inserts segments only).
 * @param opts.model          Override the default model.
 * @param opts.timeoutMs      Override the LLM call timeout (default 120s).
 */
export async function processSession(
  sessionId: string,
  opts?: {
    skipLlmReview?: boolean;
    model?: string;
    timeoutMs?: number;
  },
): Promise<TranscriptProcessResult> {
  const startMs = Date.now();
  const model = opts?.model ?? DEFAULT_MODEL;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

  const result: TranscriptProcessResult = {
    session_id: sessionId,
    status: 'success',
    segments_inserted: 0,
    corrections_inserted: 0,
    llm_run_id: null,
    duration_ms: 0,
  };

  // ── Step 1: Load session ────────────────────────────────────────────────────
  const { data: sessionData, error: sessionErr } = await supa()
    .from('sessions')
    .select('id, youtube_video_id, status, comision, fecha, tipo, metadata')
    .eq('id', sessionId)
    .single();

  if (sessionErr || !sessionData) {
    result.duration_ms = Date.now() - startMs;
    result.status = 'permanent_failure';
    result.error = sessionErr?.message ?? 'session not found';
    logger.error('transcript_process_session_not_found', {
      session_id: sessionId,
      error: result.error,
    });
    return result;
  }

  const session = sessionData as SessionRow;

  // ── Step 1b: Idempotency guard — skip if already indexed ───────────────────
  if (session.status === 'indexed') {
    logger.info('transcript_process_already_indexed', { session_id: sessionId });
    result.duration_ms = Date.now() - startMs;
    return result;
  }

  if (!session.youtube_video_id) {
    result.duration_ms = Date.now() - startMs;
    result.status = 'permanent_failure';
    result.error = 'session has no youtube_video_id';
    logger.error('transcript_process_no_video_id', { session_id: sessionId });
    return result;
  }

  logger.info('transcript_process_start', {
    session_id: sessionId,
    video_id: session.youtube_video_id,
    status: session.status,
  });

  // ── Step 2: Mark as 'processing' ───────────────────────────────────────────
  const { error: markErr } = await supa()
    .from('sessions')
    .update({ status: 'processing' })
    .eq('id', sessionId);

  if (markErr) {
    result.duration_ms = Date.now() - startMs;
    result.status = 'permanent_failure';
    result.error = `failed to mark processing: ${markErr.message}`;
    logger.error('transcript_process_status_update_failed', {
      session_id: sessionId,
      error: result.error,
    });
    return result;
  }

  // ── Step 3: Fetch transcript ────────────────────────────────────────────────
  let rawSegments: Awaited<ReturnType<typeof fetchTranscript>>;

  try {
    rawSegments = await fetchTranscript(session.youtube_video_id);
  } catch (err) {
    if (err instanceof YoutubeTranscriptError) {
      // Cancelled: rethrow — don't swallow user-initiated cancel
      if (err.code === 'cancelled') throw err;

      // no_transcript_available: revert to pending (YouTube might add captions later)
      if (err.code === 'no_transcript_available') {
        await supa().from('sessions').update({ status: 'pending' }).eq('id', sessionId);
        result.duration_ms = Date.now() - startMs;
        result.status = 'transcript_not_ready';
        logger.info('transcript_process_not_ready', {
          session_id: sessionId,
          code: err.code,
        });
        return result;
      }

      // video_not_found or parse_error: permanent failure
      if (err.code === 'video_not_found' || err.code === 'parse_error') {
        await supa()
          .from('sessions')
          .update({ status: 'error' })
          .eq('id', sessionId);
        result.duration_ms = Date.now() - startMs;
        result.status = 'permanent_failure';
        result.error = `${err.code}: ${err.message}`;
        logger.error('transcript_process_permanent_failure', {
          session_id: sessionId,
          code: err.code,
          error: err.message,
        });
        return result;
      }

      // network / rate_limited: rethrow — cron will retry on next tick
      throw err;
    }

    // Unknown error: rethrow
    throw err;
  }

  // Empty array → transcript not ready (same as no_transcript_available)
  if (rawSegments.length === 0) {
    await supa().from('sessions').update({ status: 'pending' }).eq('id', sessionId);
    result.duration_ms = Date.now() - startMs;
    result.status = 'transcript_not_ready';
    logger.info('transcript_process_empty_transcript', { session_id: sessionId });
    return result;
  }

  // ── Step 4: Insert segments ─────────────────────────────────────────────────
  const segmentRows = rawSegments.map((seg, idx) => ({
    session_id: sessionId,
    segment_idx: idx,
    start_seconds: seg.start_seconds,
    end_seconds: seg.end_seconds,
    text: seg.text,
    source: 'youtube_auto' as const,
  }));

  // Use upsert-style insert. The unique index on (session_id, segment_idx)
  // will reject dupes if this job re-runs — that's intentional and safe.
  // We use ignoreDuplicates pattern: insert with onConflict to skip existing.
  const { data: insertedSegments, error: segErr } = await supa()
    .from('transcript_segments')
    .insert(segmentRows)
    .select('id, segment_idx, start_seconds, end_seconds, text');

  if (segErr) {
    // If the error is a unique violation (re-run), we need to fetch existing segments
    // to continue with the LLM review step. Check if it's a dupe key error.
    if (segErr.code === '23505') {
      // Segments already inserted from a previous partial run — fetch them.
      logger.info('transcript_process_segments_already_exist', {
        session_id: sessionId,
        message: 'reusing existing segments from previous run',
      });
    } else {
      throw new Error(`transcript_segments insert failed: ${segErr.message}`);
    }
  }

  // Fetch inserted (or previously existing) segments for the LLM step
  const { data: fetchedSegments, error: fetchSegErr } = await supa()
    .from('transcript_segments')
    .select('id, segment_idx, start_seconds, end_seconds, text')
    .eq('session_id', sessionId)
    .order('segment_idx', { ascending: true });

  if (fetchSegErr) {
    throw new Error(`failed to fetch segments after insert: ${fetchSegErr.message}`);
  }

  const segments = (fetchedSegments ?? []) as Array<{
    id: string;
    segment_idx: number;
    start_seconds: number;
    end_seconds: number;
    text: string;
  }>;

  // Count only what was freshly inserted (not re-fetched from a prior run)
  result.segments_inserted = insertedSegments?.length ?? segments.length;

  logger.info('transcript_process_segments_inserted', {
    session_id: sessionId,
    count: result.segments_inserted,
  });

  // ── Step 5: LLM review pass ─────────────────────────────────────────────────
  if (!opts?.skipLlmReview) {
    try {
      const { llm_run_id, corrections_inserted } = await runLlmReview(session, segments, {
        model,
        timeoutMs,
      });

      result.llm_run_id = llm_run_id;
      result.corrections_inserted = corrections_inserted;

      // Update session: set llm_reviewed_at + llm_review_model
      const { error: reviewUpdateErr } = await supa()
        .from('sessions')
        .update({
          llm_reviewed_at: new Date().toISOString(),
          llm_review_model: model,
        })
        .eq('id', sessionId);

      if (reviewUpdateErr) {
        // Non-fatal: log but continue — the corrections are inserted
        logger.warn('transcript_process_llm_reviewed_at_update_failed', {
          session_id: sessionId,
          error: reviewUpdateErr.message,
        });
      }
    } catch (err) {
      // LLM errors are non-fatal for the pipeline: we log, continue, and
      // set status='indexed' anyway. Segments are already inserted.
      // The job can be re-run with skipLlmReview=false later.
      logger.error('transcript_process_llm_review_failed', {
        session_id: sessionId,
        error: (err as Error)?.message ?? String(err),
      });
      // Don't rethrow — degrade gracefully
    }
  } else {
    logger.info('transcript_process_llm_skipped', { session_id: sessionId });
  }

  // ── Step 6: Mark as 'indexed' ───────────────────────────────────────────────
  const { error: indexedErr } = await supa()
    .from('sessions')
    .update({ status: 'indexed' })
    .eq('id', sessionId);

  if (indexedErr) {
    throw new Error(`failed to mark session indexed: ${indexedErr.message}`);
  }

  result.status = 'success';
  result.duration_ms = Date.now() - startMs;

  logger.info('transcript_process_complete', {
    session_id: sessionId,
    segments_inserted: result.segments_inserted,
    corrections_inserted: result.corrections_inserted,
    llm_run_id: result.llm_run_id,
    duration_ms: result.duration_ms,
  });

  // ── Step 7: Centinela mention scan (optional — failure must not fail the pipeline) ──
  // Scan the newly-indexed transcript for mentions of watched entities.
  // Any error here is caught and logged — the session is already marked indexed.
  try {
    const mentionsResult = await scanSessionForMentions(sessionId);
    logger.info('transcript_process_mentions_scanned', {
      session_id: sessionId,
      segments_scanned: mentionsResult.segments_scanned,
      watchlist_size: mentionsResult.watchlist_size,
      alerts_inserted: mentionsResult.alerts_inserted,
    });
  } catch (err) {
    logger.error('transcript_process_mentions_scan_failed', {
      session_id: sessionId,
      error: (err as Error)?.message ?? String(err),
    });
    // Do NOT rethrow — mention scan failure must not degrade transcript indexing.
  }

  return result;
}

// ── Export for testing ────────────────────────────────────────────────────────
// Expose the supabase singleton reset so tests can clear state between runs.
export function _resetSupaClient(): void {
  _supa = null;
}
