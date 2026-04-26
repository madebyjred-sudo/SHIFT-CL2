/**
 * Feature flag cache + reader.
 *
 * Reads from `feature_flags` (Supabase) on first miss, caches with a
 * short TTL. Writes go through this module too so a save invalidates
 * the cache without a manual refresh.
 *
 * The cache is per-process — fine for single-instance deploys, eventual
 * consistency on multi-instance. TTL is small (10s) so divergence
 * windows are tiny if/when we scale out.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

interface FlagsCache {
  data: Record<string, unknown>;
  loadedAt: number;
}

const CACHE_TTL_MS = 10_000;
let cache: FlagsCache | null = null;
let inflight: Promise<Record<string, unknown>> | null = null;

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for feature_flags');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

export async function loadFlags(force = false): Promise<Record<string, unknown>> {
  if (!force && cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inflight && !force) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await supa().from('feature_flags').select('key, value');
      if (error) throw new Error(error.message);
      const out: Record<string, unknown> = {};
      for (const row of data ?? []) out[row.key as string] = row.value;
      cache = { data: out, loadedAt: Date.now() };
      return out;
    } catch (err) {
      logger.warn('feature_flags_load_failed', { error: (err as Error).message });
      return cache?.data ?? {};
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getFlag<T = unknown>(key: string, fallback: T): Promise<T> {
  const flags = await loadFlags();
  return (flags[key] as T) ?? fallback;
}

export async function setFlag(
  key: string,
  value: unknown,
  updatedBy: string | null,
): Promise<void> {
  const { error } = await supa()
    .from('feature_flags')
    .upsert({ key, value, updated_by: updatedBy, updated_at: new Date().toISOString() })
    .select();
  if (error) throw new Error(error.message);
  // Invalidate cache so the next read sees the new value.
  cache = null;
}

export function invalidateFlags(): void {
  cache = null;
}
