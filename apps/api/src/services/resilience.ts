/**
 * Generic resilience helpers — timeouts + retry with exponential backoff.
 *
 * Use sparingly: only on idempotent operations (HTTP GET-equivalent calls,
 * embedding requests, non-stream LLM completions). Never on streaming reads,
 * since a mid-stream retry would duplicate tokens already sent to the client.
 *
 * Errors are normalized to ResilienceError so callers can distinguish
 * timeouts (recoverable in a future attempt) from upstream failures
 * (probably-not-recoverable in this turn).
 */

export class ResilienceError extends Error {
  constructor(
    message: string,
    public readonly code: 'timeout' | 'upstream' | 'aborted',
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResilienceError';
  }
}

interface WithTimeoutOpts {
  ms: number;
  label: string;
  signal?: AbortSignal;
}

/**
 * Wrap a Promise with a timeout. The wrapped operation is racing the timer —
 * if you need actual cancellation (e.g. fetch), pass an AbortController.signal
 * to the underlying call and link it via `signal`.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: WithTimeoutOpts,
): Promise<T> {
  const ctrl = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else opts.signal.addEventListener('abort', () => ctrl.abort(opts.signal!.reason), { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error(`${opts.label} timeout after ${opts.ms}ms`)), opts.ms);

  try {
    return await fn(ctrl.signal);
  } catch (err) {
    if (ctrl.signal.aborted) {
      const reason = ctrl.signal.reason;
      const isTimeout = reason instanceof Error && reason.message.includes('timeout');
      throw new ResilienceError(
        isTimeout ? `${opts.label} timed out after ${opts.ms}ms` : `${opts.label} aborted`,
        isTimeout ? 'timeout' : 'aborted',
        reason,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface RetryOpts {
  attempts: number;
  baseDelayMs: number;
  label: string;
  /** Return false to stop retrying (e.g. 4xx that won't change on retry). */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/**
 * Run fn with up to `attempts` tries. Backoff is base * 2^(attempt-1).
 * Default shouldRetry only stops on ResilienceError(code='aborted').
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  const should =
    opts.shouldRetry ??
    ((err) => !(err instanceof ResilienceError && err.code === 'aborted'));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === opts.attempts || !should(err, attempt)) break;
      const delay = opts.baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[retry] ${opts.label} attempt ${attempt} failed (${(err as Error).message}); retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
