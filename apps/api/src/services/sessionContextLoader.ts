/**
 * Session context loader — builds the system message that scopes a chat
 * conversation to a specific legacy plenaria.
 *
 * Why: when the user opens chat from `/sesiones/:id`, every turn must know
 * which session it's about. Phase 1 of docs/issues/001: instead of stuffing
 * the metadata into `user.content` (the duct-tape we're replacing), we fetch
 * it once on the server, build a clean system message, and inject it into
 * the LLM call. `messages.content` in DB stays the user's actual question.
 *
 * Cache: session metadata is small (≪ 10 KB after parseResumen) and changes
 * infrequently. A small in-memory LRU avoids hitting the legacy API on
 * every turn of the same conversation.
 */
import { getTranscripcionById } from './legacyCl2Client.js';

export interface SessionContext {
  id: number;
  titulo: string;
  fecha: string;
  duration_s: number;
  estado: number;
  youtube_id: string | null;
  resumen_ejecutivo: string | null;
}

const CACHE_MAX = 50;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — resumen rarely changes mid-demo
const cache = new Map<number, { ctx: SessionContext; expiresAt: number }>();

function extractYouTubeId(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = input.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Resumen is a single markdown blob with emoji headers; we only need the
// "ejecutivo" section for the system prompt — puntos/acuerdos would bloat it.
function extractEjecutivo(md: string | null | undefined): string | null {
  if (!md) return null;
  const m = md.match(/🧾[^\n]*\n([\s\S]*?)(?=(?:📌|⚖️|$))/);
  return m ? m[1].trim() : null;
}

export async function loadSessionContext(id: number): Promise<SessionContext | null> {
  const now = Date.now();
  const hit = cache.get(id);
  if (hit && hit.expiresAt > now) {
    cache.delete(id);
    cache.set(id, hit); // touch (LRU)
    return hit.ctx;
  }

  const t = await getTranscripcionById(id);
  if (!t) return null;

  const ctx: SessionContext = {
    id: t.id,
    titulo: t.titulo,
    fecha: t.fecha,
    duration_s: t.duration,
    estado: t.estado,
    youtube_id: extractYouTubeId(t.youtube),
    resumen_ejecutivo: extractEjecutivo(t.resumen),
  };

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, { ctx, expiresAt: now + CACHE_TTL_MS });
  return ctx;
}

/**
 * Drop a single session from the in-process cache. Call after we know the
 * legacy row changed (e.g. resumen regenerated, transcript reprocessed) so
 * the next chat turn picks up the fresh metadata instead of a 10-min stale
 * snapshot. Safe no-op if the entry isn't cached.
 */
export function invalidateSessionContext(id: number): boolean {
  return cache.delete(id);
}

/** Drop the entire cache. Used by tests and by ops endpoints (future). */
export function clearSessionContextCache(): void {
  cache.clear();
}

/** Diagnostics for /health/deep — exposes cache fill, never the entries. */
export function sessionContextCacheStats(): { size: number; max: number; ttl_ms: number } {
  return { size: cache.size, max: CACHE_MAX, ttl_ms: CACHE_TTL_MS };
}

// ── UUID variant (post-mayo 2026, Supabase sessions) ───────────────────────

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for sessionContextLoader');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// Cache separado para UUIDs — mismo TTL, dimension distinta.
const uuidCache = new Map<string, { ctx: SessionContext; expiresAt: number }>();

/**
 * Carga el contexto de una sesión nueva (Supabase). Devuelve la misma shape
 * SessionContext que la versión legacy para que el caller no tenga que
 * branchear más allá del fetch. `id` se setea como 0 (no aplica numérico)
 * y el title incluye la pista que necesita el modelo.
 */
export async function loadSessionContextByUuid(uuid: string): Promise<SessionContext | null> {
  const now = Date.now();
  const hit = uuidCache.get(uuid);
  if (hit && hit.expiresAt > now) {
    uuidCache.delete(uuid);
    uuidCache.set(uuid, hit);
    return hit.ctx;
  }

  const { data, error } = await supa()
    .from('sessions')
    .select('id, youtube_video_id, fecha, status, metadata, created_at')
    .eq('id', uuid)
    .maybeSingle();
  if (error || !data) return null;

  const meta = (data.metadata ?? {}) as {
    raw_title?: string;
    sesion_label?: string;
    duration_seconds?: number;
    resumen?: { ejecutivo?: string };
  };
  const title = meta.raw_title || meta.sesion_label || `Sesión ${uuid.slice(0, 8)}`;

  const ctx: SessionContext = {
    id: 0, // marker — UUID-backed; los callers que necesiten el uuid lo tienen aparte
    titulo: title,
    fecha: data.fecha ?? data.created_at?.slice(0, 10) ?? '',
    duration_s: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
    // status 'indexed' = visible al equipo (similar a estado=1 legacy "Finalizada")
    estado: data.status === 'indexed' ? 1 : data.status === 'pending_review' ? 0 : 0,
    youtube_id: data.youtube_video_id,
    resumen_ejecutivo: meta.resumen?.ejecutivo ?? null,
  };

  if (uuidCache.size >= CACHE_MAX) {
    const oldest = uuidCache.keys().next().value;
    if (oldest !== undefined) uuidCache.delete(oldest);
  }
  uuidCache.set(uuid, { ctx, expiresAt: now + CACHE_TTL_MS });
  return ctx;
}

/**
 * Igual que buildSessionSystemPrompt pero para sesiones nuevas (UUID). La
 * única diferencia es cómo referenciamos la sesión — por título, no por
 * `#N`. El modelo recibe lo mismo: contexto + instrucción de scope.
 */
export function buildSessionSystemPromptByUuid(uuid: string, ctx: SessionContext): string {
  const lines: string[] = [
    `Contexto de la sesión activa (vinculada a esta conversación):`,
    `- Sesión: "${ctx.titulo}"`,
    `- Fecha: ${fmtDate(ctx.fecha)}`,
    `- Duración: ${fmtDuration(ctx.duration_s)}`,
    `- Estado: ${ctx.estado === 1 ? 'Publicada al equipo' : 'En revisión por operador'}`,
  ];
  if (ctx.youtube_id) {
    lines.push(`- Video original: https://www.youtube.com/watch?v=${ctx.youtube_id}`);
  }
  if (ctx.resumen_ejecutivo) {
    lines.push('', 'Resumen ejecutivo de la sesión:', ctx.resumen_ejecutivo);
  }
  lines.push(
    '',
    `Cuando el usuario pregunte por "esta sesión", "la sesión actual" o algo similar sin nombrar otra, asumí que se refiere a la sesión "${ctx.titulo}" (ID interno: ${uuid.slice(0, 8)}…). No le repitas al usuario el resumen completo a menos que lo pida explícitamente.`,
    '',
    'IMPORTANTE: para responder preguntas sobre el CONTENIDO de esta sesión (qué se dijo, quién intervino, qué pasó en determinado momento, qué temas se trataron, etc.) usá la tool `search_session_transcript` con términos de búsqueda relevantes. Esa tool lee el transcript real de esta sesión y devuelve extractos con timecodes. No respondas "no encontré la información" sin haber llamado a la tool primero.',
  );
  return lines.join('\n');
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-CR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Build the system message that scopes the conversation to this session.
 * Kept short so it doesn't crowd the agent persona — the executive summary
 * is the only context-heavy field, and that's what the user actually wants
 * the model to know about.
 */
export function buildSessionSystemPrompt(ctx: SessionContext): string {
  const lines: string[] = [
    `Contexto de la sesión activa (vinculada a esta conversación):`,
    `- Sesión legislativa #${ctx.id}: ${ctx.titulo}`,
    `- Fecha: ${fmtDate(ctx.fecha)}`,
    `- Duración: ${fmtDuration(ctx.duration_s)}`,
    `- Estado: ${ctx.estado === 1 ? 'Finalizada' : 'En proceso'}`,
  ];
  if (ctx.youtube_id) {
    lines.push(`- Video: https://www.youtube.com/watch?v=${ctx.youtube_id}`);
  }
  if (ctx.resumen_ejecutivo) {
    lines.push('', 'Resumen ejecutivo de la sesión:', ctx.resumen_ejecutivo);
  }
  lines.push(
    '',
    'Cuando el usuario pregunte por "esta sesión", "la sesión actual" o algo similar sin nombrar otra, asumí que se refiere a la sesión #' +
      ctx.id +
      '. No le repitas al usuario el resumen completo a menos que lo pida explícitamente.',
  );
  return lines.join('\n');
}
