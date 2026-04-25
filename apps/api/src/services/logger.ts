/**
 * Structured logger — JSON lines on stdout / stderr.
 *
 * Why structured: lets us pipe API logs into any aggregator (Loki, Datadog,
 * Vector) without parsing free-text. Each log line carries a request_id so
 * a single chat turn can be traced across persistence + upstream calls.
 *
 * Use `logger.with({ requestId, agent })` to bind context once per request,
 * then call `.info/.warn/.error` without re-passing the ids.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown>;

interface LogLine {
  ts: string;
  level: LogLevel;
  msg: string;
  [k: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function emit(level: LogLevel, msg: string, ctx: LogContext) {
  if (LEVEL_RANK[level] < LEVEL_RANK[MIN_LEVEL]) return;
  const line: LogLine = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...ctx,
  };
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'warn') console.error(out);
  else console.log(out);
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  with(extra: LogContext): Logger;
}

function build(base: LogContext): Logger {
  return {
    debug: (msg, ctx) => emit('debug', msg, { ...base, ...(ctx ?? {}) }),
    info: (msg, ctx) => emit('info', msg, { ...base, ...(ctx ?? {}) }),
    warn: (msg, ctx) => emit('warn', msg, { ...base, ...(ctx ?? {}) }),
    error: (msg, ctx) => emit('error', msg, { ...base, ...(ctx ?? {}) }),
    with: (extra) => build({ ...base, ...extra }),
  };
}

export const logger: Logger = build({});
