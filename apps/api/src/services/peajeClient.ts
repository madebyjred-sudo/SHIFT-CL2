/**
 * Peaje client — fire-and-forget hand-off from CL2 chat to Cerebro's Peaje
 * (the institutional flywheel that distills insights into Punto Medio).
 *
 * Why this exists: every chat turn that lands in Supabase as raw
 * messages stays trapped there. The Peaje at ${CEREBRO_BASE_URL}/peaje/ingest
 * runs the conversation through the LLM-based Pattern Extractor (Kimi K2.6
 * since 2026-04-25), strips PII (deterministic Layer 2), categorizes into
 * the 4 macro buckets, and persists to peaje_insights. From there the
 * 90-day consolidation cron generates dynamic RAG that flows back into
 * the system prompts of every tenant — including CL2's Lexa/Atlas.
 *
 * Connecting CL2 to the Peaje is what turns CL2 from "a chat over the SIL"
 * into "a node of the Shift Punto Medio multi-tenant intelligence graph".
 *
 * Failure mode: NEVER blocks or fails the user-facing chat. The flywheel
 * is best-effort observability/intelligence, not a critical path. If the
 * Peaje is down or slow, the user sees a normal chat completion and we
 * just lose ONE insight extraction (catch-all-and-warn-log).
 */
import { withTimeout, ResilienceError } from './resilience.js';

const CEREBRO_BASE_URL = process.env.CEREBRO_BASE_URL ?? 'https://shift-cerebro.up.railway.app';
const CEREBRO_TENANT = process.env.CEREBRO_TENANT ?? 'cl2';
const PEAJE_TIMEOUT_MS = 8_000;
// Allow ops to disable the hand-off without a redeploy (e.g. during a
// cerebro outage). Default: enabled.
const PEAJE_ENABLED = (process.env.PEAJE_ENABLED ?? 'true').toLowerCase() !== 'false';

export interface PeajeChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface PeajeIngestArgs {
  /** Conversation id from Supabase. Used as sessionId on the Peaje side. */
  sessionId: string;
  agentId: string;
  /** All turns of the conversation up to (and not including) the assistant
   *  reply we just produced. The Peaje appends `response` to the synthetic
   *  conversation it builds. */
  messages: PeajeChatMessage[];
  /** The final assistant text we just streamed to the user. */
  response: string;
  /** Optional override; defaults to CEREBRO_TENANT env (cl2 in this repo). */
  tenantId?: string;
}

/**
 * Fire-and-forget POST to /peaje/ingest. Returns a Promise that resolves
 * even on failure (after logging). The caller can `void` it without
 * awaiting; we still return a Promise so observability hooks (e.g. tests)
 * can assert on completion.
 */
export async function firePeajeIngest(args: PeajeIngestArgs): Promise<void> {
  if (!PEAJE_ENABLED) return;
  // Bail early when the conversation isn't worth distilling — short pings,
  // single-emoji acks, etc. Mirrors the threshold inside cerebro's
  // process_auto_ingest (peaje/ingest.py).
  const lastUser = [...args.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (lastUser.length < 20 && args.response.length < 50) return;

  const payload = {
    tenantId: args.tenantId ?? CEREBRO_TENANT,
    sessionId: args.sessionId,
    agentId: args.agentId,
    messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
    response: args.response,
  };

  try {
    await withTimeout(
      async (signal) => {
        const res = await fetch(`${CEREBRO_BASE_URL}/peaje/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-Id': payload.tenantId,
          },
          body: JSON.stringify(payload),
          signal,
        });
        if (!res.ok) {
          // Read but discard body — error logging happens in caller.
          await res.text().catch(() => '');
          throw new Error(`peaje ingest ${res.status}`);
        }
      },
      { ms: PEAJE_TIMEOUT_MS, label: 'peaje:ingest' },
    );
  } catch (err) {
    // Best-effort: log so we can spot Peaje outages in our own logs, but
    // never propagate — the user already got their chat reply.
    const code =
      err instanceof ResilienceError ? err.code : (err as Error)?.message ?? 'unknown';
    console.warn(`[peaje] ingest failed (${code}) — flywheel skipped this turn`);
  }
}
