/**
 * Audit log writer.
 *
 * Every admin write hits this so the Auditoría section reflects real
 * activity. Failures here are logged but never thrown — we'd rather
 * complete the user's action than block it on a bookkeeping write.
 */
import type { Request } from 'express';
import { createClient } from '@supabase/supabase-js';
import { logger } from './logger.js';
import { getUserFromRequest } from './auth.js';

interface AuditEvent {
  actor_id?: string | null;
  actor_email?: string | null;
  actor_kind?: 'human' | 'system';
  verb: string;
  resource: string;
  resource_kind?: string;
  resource_id?: string | null;
  ip?: string | null;
  result?: 'ok' | 'error' | 'retry';
  metadata?: Record<string, unknown>;
}

let _client: ReturnType<typeof createClient> | null = null;
function supa() {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for audit_log');
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

export async function audit(event: AuditEvent): Promise<void> {
  try {
    // Cast through unknown — supabase-js v2 default schema typing infers
    // `never` for tables not in the (un-generated) Database type. Until
    // we wire `supabase gen types` into the build, every insert into
    // an admin-console table needs this escape hatch.
    const payload = {
      actor_id: event.actor_id ?? null,
      actor_email: event.actor_email ?? null,
      actor_kind: event.actor_kind ?? 'human',
      verb: event.verb,
      resource: event.resource,
      resource_kind: event.resource_kind ?? null,
      resource_id: event.resource_id ?? null,
      ip: event.ip ?? null,
      result: event.result ?? 'ok',
      metadata: event.metadata ?? {},
    };
    const client = supa() as unknown as { from: (t: string) => { insert: (v: unknown) => Promise<{ error: { message: string } | null }> } };
    const { error } = await client.from('audit_log').insert(payload);
    if (error) logger.warn('audit_insert_failed', { error: error.message, verb: event.verb });
  } catch (err) {
    logger.warn('audit_throw', { error: (err as Error).message, verb: event.verb });
  }
}

/** Convenience: extract actor + ip from a request, fill the rest.
 *  Anonymous traffic gets actor_id=null + actor_kind='system' so the
 *  log still shows the verb but can be filtered out of human review. */
export async function auditFromReq(
  req: Request,
  partial: Omit<AuditEvent, 'actor_id' | 'actor_email' | 'ip'>,
): Promise<void> {
  const user = await getUserFromRequest(req).catch(() => null);
  const ip =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.socket?.remoteAddress ??
    null;
  await audit({
    ...partial,
    actor_id: user?.id ?? null,
    actor_email: user?.email ?? null,
    actor_kind: partial.actor_kind ?? (user ? 'human' : 'system'),
    ip,
  });
}
