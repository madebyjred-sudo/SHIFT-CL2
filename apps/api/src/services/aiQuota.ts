/**
 * Per-user daily AI quota checks.
 *
 * Backed by `ai_call_log` (migration 0017). Every billable LLM/TTS/STT
 * call goes through `requireQuota()` first; if the user is under their
 * route-prefix daily cap, the call proceeds + we log it. If over, we
 * 429.
 *
 * Why route-prefixed counts (not a single global count): different
 * routes have different cost profiles. Voice STT is ~$0.40/hr;
 * workspace LLM transforms are ~$0.001-0.01 each. Capping them
 * separately lets us be lenient where it's cheap and strict where it
 * isn't — without exposing one cost line to abuse via the other.
 *
 * In-memory fallback: if the DB call fails, we FAIL OPEN (allow the
 * call). The alternative — failing closed on a transient DB hiccup —
 * locks legit users out. Cost-runaway risk is bounded because the
 * provider-side rate limits and the per-IP rate-limit middleware
 * still apply.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
import type { Response } from 'express';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for aiQuota');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// Default daily caps per route-prefix. Tune via env without redeploy.
// Reasoning:
//   workspace.* — chat / transform / architect / classifier all share
//     a 200-call ceiling. Heavy users will burn this fast; we'd rather
//     get a support ping than auto-charge OpenRouter.
//   voice.*    — STT is per-minute pricing, 60 calls (≈30-60 min of
//     audio) is a generous day for a single user.
//   chat.*     — main /api/chat/stream. 200 turns/day is plenty for
//     research workflows.
const CAPS: Record<string, number> = {
  'workspace.': Number(process.env.AI_QUOTA_WORKSPACE_DAILY ?? 200),
  'voice.':     Number(process.env.AI_QUOTA_VOICE_DAILY     ?? 60),
  'chat.':      Number(process.env.AI_QUOTA_CHAT_DAILY      ?? 200),
};

function capForRoute(route: string): number {
  for (const prefix of Object.keys(CAPS)) {
    if (route.startsWith(prefix)) return CAPS[prefix];
  }
  return Number(process.env.AI_QUOTA_DEFAULT_DAILY ?? 500);
}

function prefixForRoute(route: string): string {
  for (const prefix of Object.keys(CAPS)) {
    if (route.startsWith(prefix)) return prefix;
  }
  return '';
}

export interface QuotaState {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Read-only quota check. Use from /quota endpoints; doesn't log a call.
 */
export async function getUserQuota(userId: string, route: string): Promise<QuotaState> {
  const limit = capForRoute(route);
  try {
    const prefix = prefixForRoute(route);
    const { data, error } = await supa().rpc(
      'ai_calls_user_daily_count',
      { uid: userId, route_prefix: prefix || null },
    );
    if (error) throw error;
    const used = Number(data ?? 0);
    return { used, limit, remaining: Math.max(0, limit - used) };
  } catch (err) {
    logger.warn('ai_quota_read_failed', { userId, route, error: (err as Error).message });
    return { used: 0, limit, remaining: limit };
  }
}

/**
 * Cap-and-log. Call BEFORE dispatching the upstream LLM/TTS/STT call.
 *
 * Returns:
 *   - `'ok'` and writes the response NEVER — caller proceeds.
 *   - `'denied'` after writing a 429 response — caller should `return`.
 *
 * On DB failure we fail OPEN (return 'ok' without logging) to avoid
 * blocking legit users on a transient outage.
 */
export async function requireQuota(
  userId: string,
  route: string,
  res: Response,
): Promise<'ok' | 'denied'> {
  const limit = capForRoute(route);
  const prefix = prefixForRoute(route);
  try {
    const { data, error } = await supa().rpc(
      'ai_calls_user_daily_count',
      { uid: userId, route_prefix: prefix || null },
    );
    if (error) throw error;
    const used = Number(data ?? 0);
    if (used >= limit) {
      res.status(429).json({
        ok: false,
        error: 'daily_quota_exhausted',
        route,
        used,
        limit,
        message: `Llegaste al límite diario de ${limit} ${labelFor(route)}. Volvé en 24 horas.`,
      });
      return 'denied';
    }
  } catch (err) {
    logger.warn('ai_quota_check_failed_fail_open', { userId, route, error: (err as Error).message });
    return 'ok';
  }
  return 'ok';
}

/**
 * Log a successful (or attempted) call. Call AFTER the upstream
 * dispatch — even on upstream failure so abuse-via-rapid-retries
 * still counts. Errors here are silent: a missing log row is a much
 * smaller problem than blocking the user's response.
 */
export async function logAiCall(
  userId: string,
  route: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await supa().from('ai_call_log').insert({
      user_id: userId,
      route,
      tokens_in: Number(meta.tokens_in ?? 0) || 0,
      tokens_out: Number(meta.tokens_out ?? 0) || 0,
      meta,
    });
  } catch (err) {
    logger.warn('ai_quota_log_failed', { userId, route, error: (err as Error).message });
  }
}

function labelFor(route: string): string {
  if (route.startsWith('workspace.')) return 'operaciones de Hojas';
  if (route.startsWith('voice.'))     return 'transcripciones de voz';
  if (route.startsWith('chat.'))      return 'turnos de chat';
  return 'llamadas IA';
}
