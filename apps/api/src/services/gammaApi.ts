/**
 * Gamma API client — generate decks (PPTX/PDF/PNG) from text content.
 *
 * Why this exists: CL2 produces a lot of structured text (workspace canvases,
 * Centinela digests, chat answers with citations) that legislators want to
 * present. Gamma turns that text into a polished deck in 1-3 minutes — far
 * cheaper and faster than building a slide-rendering engine ourselves.
 *
 * API shape (verified 2026-04-29 against developers.gamma.app):
 *
 *   POST /v1.0/generations          → { generationId }
 *   GET  /v1.0/generations/{id}     → { status, exportUrl?, gammaUrl?, error? }
 *
 *   Auth: X-API-KEY header (no Bearer).
 *   Polling: every 5s, terminal states 'completed' | 'failed', cap at 5min.
 *   Export URLs are signed and expire in ~1 week.
 *
 * Best practices baked in (per Gamma docs):
 *   - Markdown headings + bullets produce the cleanest layout
 *   - "\n---\n" forces a slide break; pair with cardSplit:'inputTextBreaks'
 *   - When the input is free-form, use cardSplit:'auto' + numCards
 *   - Prefer textMode:'preserve' for structured input we control;
 *     textMode:'generate' lets Gamma rephrase
 *
 * MODULE CONTRACT:
 *   - Pure functions, no Express coupling.
 *   - Throws GammaApiError with .code on every failure path.
 *   - withTimeout + withRetry on every HTTP call.
 */

import { withTimeout, withRetry } from './resilience.js';
import { logger } from './logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const GAMMA_BASE = 'https://public-api.gamma.app/v1.0';
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_DURATION_MS = 5 * 60 * 1000; // 5 min ceiling per Gamma docs

// ── Public types ──────────────────────────────────────────────────────────────

export type GammaFormat = 'presentation' | 'document' | 'social' | 'webpage';
export type GammaExportAs = 'pptx' | 'pdf' | 'png';
export type GammaTextMode = 'generate' | 'condense' | 'preserve';
export type GammaCardSplit = 'inputTextBreaks' | 'auto';

export interface CreateGenerationInput {
  /** Required. 1-400_000 chars. Markdown allowed. \n---\n forces slide break. */
  inputText: string;
  /** How Gamma should treat the input. Defaults: generate. */
  textMode?: GammaTextMode;
  /** Output format. Defaults: presentation. */
  format?: GammaFormat;
  /** Auto-export. If set, response status will include exportUrl when done. */
  exportAs?: GammaExportAs;
  /** How to split content across cards. Defaults: auto. */
  cardSplit?: GammaCardSplit;
  /** Target slide count when cardSplit='auto'. Range 1-60 (Pro), 1-75 (Ultra). */
  numCards?: number;
  /** Theme ID from /themes endpoint. Optional. */
  themeId?: string;
  /** Free-form guidance for the model. 0-5000 chars. */
  additionalInstructions?: string;
  /** Text generation tuning. */
  textOptions?: {
    amount?: 'brief' | 'medium' | 'detailed';
    language?: string; // BCP-47, e.g. 'es-CR'
    tone?: string;
    audience?: string;
  };
  /** Image sourcing. */
  imageOptions?: {
    source?: 'aiGenerated' | 'unsplash' | 'web' | 'placeholder' | 'noImages';
    style?: string;
    model?: string;
  };
  /** Card layout. */
  cardOptions?: {
    dimensions?: '16x9' | '4x3' | 'fluid' | 'a4' | 'letter';
  };
}

export interface CreateGenerationResponse {
  generationId: string;
  warnings?: string;
}

export interface GenerationStatus {
  generationId: string;
  /** 'pending' | 'running' | 'completed' | 'failed' (we treat anything not
   *  in {completed, failed} as still in flight). */
  status: string;
  /** Available when status='completed'. */
  gammaId?: string;
  gammaUrl?: string;
  /** Available when exportAs was set on the create call AND status='completed'. */
  exportUrl?: string;
  /** Present when status='failed'. */
  error?: { message?: string; code?: string };
  credits?: { used?: number; remaining?: number };
}

export type GammaErrorCode =
  | 'auth'              // 401 — bad / missing API key
  | 'insufficient_credits' // 402
  | 'forbidden'         // 403 — feature unavailable on plan
  | 'bad_request'       // 400
  | 'rate_limited'      // 429
  | 'upstream'          // 5xx
  | 'timeout'           // poll exceeded ceiling
  | 'network'           // fetch threw
  | 'failed'            // Gamma reported status='failed'
  | 'no_export_url';    // generation completed but no exportUrl present

export class GammaApiError extends Error {
  constructor(
    message: string,
    public readonly code: GammaErrorCode,
    public readonly httpStatus?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GammaApiError';
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.GAMMA_API_KEY;
  if (!key) {
    throw new GammaApiError(
      'GAMMA_API_KEY not set in environment',
      'auth',
    );
  }
  return key;
}

async function gammaFetch<T>(
  path: string,
  init: RequestInit,
  label: string,
): Promise<T> {
  const url = `${GAMMA_BASE}${path}`;
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          let res: Response;
          try {
            res = await fetch(url, {
              ...init,
              signal,
              headers: {
                ...(init.headers as Record<string, string> | undefined),
                'X-API-KEY': getApiKey(),
                Accept: 'application/json',
              },
            });
          } catch (err) {
            throw new GammaApiError(
              `${label} network error: ${(err as Error).message}`,
              'network',
              undefined,
              err,
            );
          }

          if (res.status === 401)
            throw new GammaApiError(`${label}: invalid API key`, 'auth', 401);
          if (res.status === 402)
            throw new GammaApiError(
              `${label}: insufficient Gamma credits`,
              'insufficient_credits',
              402,
            );
          if (res.status === 403)
            throw new GammaApiError(
              `${label}: forbidden (feature not available on plan)`,
              'forbidden',
              403,
            );
          if (res.status === 429)
            throw new GammaApiError(`${label}: rate limited`, 'rate_limited', 429);
          if (res.status === 400) {
            const body = await res.text().catch(() => '');
            throw new GammaApiError(
              `${label} bad request: ${body.slice(0, 300)}`,
              'bad_request',
              400,
            );
          }
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new GammaApiError(
              `${label} upstream ${res.status}: ${body.slice(0, 300)}`,
              'upstream',
              res.status,
            );
          }

          return (await res.json()) as T;
        },
        { ms: REQUEST_TIMEOUT_MS, label },
      ),
    {
      attempts: RETRY_ATTEMPTS,
      baseDelayMs: RETRY_BASE_MS,
      label,
      shouldRetry: (err) => {
        if (err instanceof GammaApiError) {
          // Retry transient. Never retry auth/credits/forbidden/bad_request.
          return err.code === 'rate_limited' || err.code === 'upstream' || err.code === 'network';
        }
        return true;
      },
    },
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Kick off a generation. Async — returns the generationId you'll poll on.
 *
 * Common patterns:
 *   - One-shot PPTX from a structured doc:
 *       createGeneration({
 *         inputText: '# Title\n\n...\n---\n# Section 2\n...',
 *         format: 'presentation',
 *         exportAs: 'pptx',
 *         cardSplit: 'inputTextBreaks',
 *         textMode: 'preserve',
 *         textOptions: { language: 'es-CR' }
 *       });
 *
 *   - Auto-paced from chat answer:
 *       createGeneration({
 *         inputText: rawAnswerMarkdown,
 *         format: 'presentation',
 *         exportAs: 'pptx',
 *         cardSplit: 'auto',
 *         numCards: 8,
 *         textMode: 'condense'
 *       });
 */
export async function createGeneration(
  input: CreateGenerationInput,
): Promise<CreateGenerationResponse> {
  if (!input.inputText || input.inputText.length === 0) {
    throw new GammaApiError('inputText is required', 'bad_request');
  }
  if (input.inputText.length > 400_000) {
    throw new GammaApiError(
      `inputText too long (${input.inputText.length} chars; max 400000)`,
      'bad_request',
    );
  }

  return gammaFetch<CreateGenerationResponse>(
    '/generations',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    'gamma:createGeneration',
  );
}

/**
 * One-shot status check. Most callers want pollUntilComplete instead.
 */
export async function getGenerationStatus(
  generationId: string,
): Promise<GenerationStatus> {
  return gammaFetch<GenerationStatus>(
    `/generations/${encodeURIComponent(generationId)}`,
    { method: 'GET' },
    `gamma:getStatus:${generationId}`,
  );
}

/**
 * Poll a generation until it terminates or the ceiling is hit. Returns the
 * final status object on success; throws GammaApiError(timeout|failed) on
 * non-success terminals.
 *
 * Polling cadence is fixed at 5s — Gamma's recommended interval. The 5min
 * ceiling matches their typical 1-3min completion time with slack.
 */
export async function pollUntilComplete(
  generationId: string,
  opts?: { intervalMs?: number; maxDurationMs?: number; signal?: AbortSignal },
): Promise<GenerationStatus> {
  const intervalMs = opts?.intervalMs ?? POLL_INTERVAL_MS;
  const maxDurationMs = opts?.maxDurationMs ?? POLL_MAX_DURATION_MS;
  const startedAt = Date.now();

  // Tiny initial delay — Gamma's status endpoint sometimes 404s for ~1s
  // after createGeneration returns while the row is being committed.
  await sleep(1_000, opts?.signal);

  while (true) {
    if (opts?.signal?.aborted) {
      throw new GammaApiError(
        'gamma:poll aborted by caller',
        'timeout',
      );
    }
    if (Date.now() - startedAt > maxDurationMs) {
      throw new GammaApiError(
        `gamma:poll timeout after ${Math.round(maxDurationMs / 1000)}s — generation ${generationId} still in flight`,
        'timeout',
      );
    }

    const status = await getGenerationStatus(generationId);
    if (status.status === 'completed') {
      return status;
    }
    if (status.status === 'failed') {
      throw new GammaApiError(
        `gamma:generation failed — ${status.error?.message ?? 'no detail'}`,
        'failed',
      );
    }

    // Still running; keep polling.
    logger.info('gamma_poll_tick', {
      generationId,
      status: status.status,
      elapsed_s: Math.round((Date.now() - startedAt) / 1000),
    });
    await sleep(intervalMs, opts?.signal);
  }
}

/**
 * Convenience wrapper: create + poll + return the export URL in one call.
 *
 * Use this for synchronous flows where the caller wants to block until the
 * file is ready (e.g. a "Generate PPTX" button that returns the download
 * link). For async flows, use createGeneration + return the generationId
 * to the client and let them poll.
 *
 * @throws GammaApiError if exportAs was not set or the URL never appears.
 */
export async function generateAndWait(
  input: CreateGenerationInput,
  opts?: { intervalMs?: number; maxDurationMs?: number; signal?: AbortSignal },
): Promise<{ generationId: string; gammaUrl?: string; exportUrl: string }> {
  if (!input.exportAs) {
    throw new GammaApiError(
      'generateAndWait requires exportAs (pptx|pdf|png) — caller wants a downloadable file',
      'bad_request',
    );
  }

  const created = await createGeneration(input);
  logger.info('gamma_generation_created', { generationId: created.generationId });

  const final = await pollUntilComplete(created.generationId, opts);
  if (!final.exportUrl) {
    throw new GammaApiError(
      `gamma:generation ${created.generationId} completed but no exportUrl present`,
      'no_export_url',
    );
  }

  logger.info('gamma_generation_complete', {
    generationId: created.generationId,
    gammaUrl: final.gammaUrl,
    credits_used: final.credits?.used,
    credits_remaining: final.credits?.remaining,
  });

  return {
    generationId: created.generationId,
    gammaUrl: final.gammaUrl,
    exportUrl: final.exportUrl,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GammaApiError('aborted', 'timeout'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new GammaApiError('aborted', 'timeout'));
      },
      { once: true },
    );
  });
}
