/**
 * Agent override cache (enabled flag + optional model swap).
 *
 * Same pattern as feature_flags.ts: in-memory cache with short TTL,
 * hit Supabase on miss/invalidation. Read by the chat router on every
 * request to gate disabled agents and to swap models when overridden.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

export interface AgentOverride {
  agent_id: string;
  enabled: boolean;
  model: string | null;
}

const CACHE_TTL_MS = 10_000;
let cache: { data: Map<string, AgentOverride>; loadedAt: number } | null = null;
let inflight: Promise<Map<string, AgentOverride>> | null = null;

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for agent_overrides');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

export async function loadOverrides(): Promise<Map<string, AgentOverride>> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await supa()
        .from('agent_overrides')
        .select('agent_id, enabled, model');
      if (error) throw new Error(error.message);
      const map = new Map<string, AgentOverride>();
      for (const row of data ?? []) {
        map.set(row.agent_id as string, {
          agent_id: row.agent_id as string,
          enabled: row.enabled as boolean,
          model: (row.model as string | null) ?? null,
        });
      }
      cache = { data: map, loadedAt: Date.now() };
      return map;
    } catch (err) {
      logger.warn('agent_overrides_load_failed', { error: (err as Error).message });
      return cache?.data ?? new Map();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getOverride(agentId: string): Promise<AgentOverride | null> {
  const map = await loadOverrides();
  return map.get(agentId) ?? null;
}

export async function setOverride(
  agentId: string,
  patch: { enabled?: boolean; model?: string | null },
  updatedBy: string | null,
): Promise<AgentOverride> {
  const current = (await getOverride(agentId)) ?? { agent_id: agentId, enabled: true, model: null };
  const next: AgentOverride = {
    agent_id: agentId,
    enabled: patch.enabled ?? current.enabled,
    model: patch.model !== undefined ? patch.model : current.model,
  };
  const { error } = await supa()
    .from('agent_overrides')
    .upsert({
      agent_id: agentId,
      enabled: next.enabled,
      model: next.model,
      updated_by: updatedBy,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(error.message);
  cache = null; // invalidate
  return next;
}
