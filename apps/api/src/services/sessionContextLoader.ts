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
  /**
   * Transcripción completa formateada con timecodes ([HH:MM:SS] texto).
   * Cuando está presente, el caller la inyecta DIRECTO en el system prompt
   * y el modelo lee/cita la transcripción sin necesidad de tool de búsqueda.
   * Solo poblada para sesiones UUID (Supabase) con transcript_segments
   * razonablemente pequeño (< ~150k tokens). Para sesiones más grandes
   * (>10h video) queda null y el caller cae al path de tool keyword search.
   */
  transcript_with_timecodes?: string | null;
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
// Cap defensivo para el transcript inline. Sonnet 4.6 acepta 200k tokens;
// reservamos ~150k para messages history + tools + agent persona. 600k chars
// ≈ 150k tokens (regla 4 chars/token). Si el transcript excede, devolvemos
// null y el caller cae al path de tool keyword search (sesiones de 10h+).
const MAX_TRANSCRIPT_CHARS = 600_000;

function formatTs(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Carga todos los transcript_segments de una sesión, paginado para superar
 * el cap de 1000 de PostgREST, y devuelve un blob de texto con timecodes
 * embebidos. Devuelve null si el blob excede MAX_TRANSCRIPT_CHARS.
 */
async function loadFullTranscript(sessionUuid: string): Promise<string | null> {
  type Seg = { start_seconds: number; text: string };
  const all: Seg[] = [];
  const PAGE = 1000;
  for (let off = 0; off < 50_000; off += PAGE) {
    const { data, error } = await supa()
      .from('transcript_segments')
      .select('start_seconds, text')
      .eq('session_id', sessionUuid)
      .order('segment_idx', { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) return null;
    if (!data || data.length === 0) break;
    all.push(...(data as Seg[]));
    if (data.length < PAGE) break;
  }
  if (all.length === 0) return null;

  // Agrupamos segments consecutivos en bloques de ~30s para reducir el
  // ratio overhead/content. Sin esto cada línea es "[00:00:05] palabra"
  // y la mitad del prompt son timecodes.
  const blocks: Array<{ ts: number; texts: string[] }> = [];
  for (const seg of all) {
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock || seg.start_seconds - lastBlock.ts >= 30) {
      blocks.push({ ts: seg.start_seconds, texts: [(seg.text ?? '').trim()] });
    } else {
      lastBlock.texts.push((seg.text ?? '').trim());
    }
  }
  const text = blocks
    .map((b) => `[${formatTs(b.ts)}] ${b.texts.filter(Boolean).join(' ')}`)
    .join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) return null;
  return text;
}

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

  // Cargar el transcript completo. Si falla o es muy grande, queda null y
  // el caller cae al path de tool keyword (sesiones de 10h+).
  const transcriptText = await loadFullTranscript(uuid);

  const ctx: SessionContext = {
    id: 0, // marker — UUID-backed; los callers que necesiten el uuid lo tienen aparte
    titulo: title,
    fecha: data.fecha ?? data.created_at?.slice(0, 10) ?? '',
    duration_s: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
    // status 'indexed' = visible al equipo (similar a estado=1 legacy "Finalizada")
    estado: data.status === 'indexed' ? 1 : data.status === 'pending_review' ? 0 : 0,
    youtube_id: data.youtube_video_id,
    resumen_ejecutivo: meta.resumen?.ejecutivo ?? null,
    transcript_with_timecodes: transcriptText,
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

  // Refactor 2026-05-12: incluir transcript completo en system prompt cuando
  // cabe en context window. Antes obligamos al modelo a usar tool de
  // keyword-search → devuelve 8 extractos sueltos → modelo no puede narrar
  // y termina con stop+vacío. Pasándole el transcript completo, lee y
  // responde directo, citando timecodes inline. Mismo patrón que tendría
  // un humano: "tenés la transcripción ahí, leéla".
  if (ctx.transcript_with_timecodes) {
    lines.push(
      '',
      '=== TRANSCRIPCIÓN COMPLETA DE LA SESIÓN ===',
      'Cada línea empieza con [HH:MM:SS] o [MM:SS] — usá esos timecodes para citar.',
      '',
      ctx.transcript_with_timecodes,
      '',
      '=== FIN DE TRANSCRIPCIÓN ===',
    );
  }

  lines.push(
    '',
    `Cuando el usuario pregunte por "esta sesión", "la sesión actual" o algo similar sin nombrar otra, asumí que se refiere a la sesión "${ctx.titulo}" (ID interno: ${uuid.slice(0, 8)}…).`,
  );

  if (ctx.transcript_with_timecodes) {
    lines.push(
      '',
      'INSTRUCCIONES PARA RESPONDER:',
      '1. La transcripción completa de esta sesión está ARRIBA en este mismo prompt. Léela y respondé directamente con base en ella — no digas "no tengo acceso a la transcripción".',
      '2. Citá los timecodes entre paréntesis después de cada afirmación (ej: "La presidenta abrió la sesión a las 14:08 (0:00:30)").',
      '3. Si el usuario pregunta "qué pasó en esta sesión", armá una narrativa breve (3-6 párrafos) que cubra lo principal: apertura, temas tratados, intervenciones clave, decisiones tomadas, cierre.',
      '4. Si no encontrás algo específico en la transcripción, decilo: "no encontré referencia a X en esta sesión", no inventes.',
    );
  } else {
    // Fallback path para sesiones grandes que no cabe el transcript completo.
    lines.push(
      '',
      'IMPORTANTE: la transcripción de esta sesión es muy larga para incluir completa. Usá la tool `search_session_transcript` con términos de búsqueda relevantes para obtener extractos con timecodes.',
    );
  }
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
