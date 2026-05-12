/**
 * Session-scoped transcript search — quick keyword retrieval over the
 * ElevenLabs transcript of a single legacy plenaria.
 *
 * Why: Phase 1 of docs/issues/001 gave Lexa the executive summary as a
 * system message — enough for "resumí la sesión", not enough for "qué dijo
 * X en el minuto Y". Real semantic retrieval (Phase 3 — pgvector embeddings)
 * is days of work and out of scope before the 2026-05-08 demo. This is the
 * pragmatic shortcut: when the chat is scoped to a session, give Lexa a
 * tool that fetches that session's transcript, scores segments by keyword
 * overlap, and returns the top-K with timecodes.
 *
 * Trade-offs:
 *  - Keyword match misses synonyms and paraphrase. Demo-acceptable because
 *    legislative speech is formulaic and the user usually knows the term.
 *  - Per-call we walk every segment of one session (≤ ~1500 segments for a
 *    long plenario). Fast in-process; transcript blob is LRU-cached.
 *  - No cross-session search — that's still `search_transcripts` over
 *    `legislative_chunks`.
 */
import {
  fetchTranscriptJson,
  getTranscripcionById,
  wordsToSegments,
  type TranscriptSegment,
} from './legacyCl2Client.js';

export interface SessionTranscriptHit {
  index: number;
  start: number;       // seconds
  end: number;
  text: string;
  score: number;       // raw match count (debugging — not surfaced to model)
}

export interface SessionTranscriptResult {
  session_id: number;
  titulo: string;
  fecha: string;
  youtube_id: string | null;
  duration_s: number;
  total_segments: number;
  hits: SessionTranscriptHit[];
}

// Light Spanish stopword list — keeps the keyword set focused on content
// words. Not exhaustive; just enough so "que dijo X" doesn't waste matches
// on "que" / "dijo".
const STOPWORDS = new Set([
  'a','al','algo','algún','alguna','algunas','alguno','algunos','ante','antes',
  'aquel','aquella','aquellos','aquellas','aquí','así','aún',
  'cada','como','con','contra','cual','cuales','cuando','de','del','desde','donde',
  'durante','el','la','los','las','en','entre','era','eran','es','esa','esas','ese',
  'esos','esta','estas','este','estos','está','están','fue','fueron','ha','han',
  'hasta','hay','la','las','le','les','lo','los','más','me','mi','mis','muy',
  'nada','ni','no','nos','o','para','pero','poco','por','porque','que','quien',
  'quienes','qué','sin','sobre','su','sus','también','tan','te','tu','tus','un',
  'una','uno','unos','y','ya','yo','dijo','dice','dicen','dijeron',
]);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9áéíóúñü\s]/giu, ' ');
}

function tokenize(s: string): string[] {
  return normalize(s)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Score each segment by how many distinct query tokens appear in its text.
 * Distinct (set) keeps a sentence with one repeated word from outranking
 * one with two different matches. Substring match (not whole-word) — better
 * recall on inflected forms ("votación" matches "votaciones").
 */
function scoreSegment(segText: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const norm = normalize(segText);
  let score = 0;
  for (const tok of queryTokens) {
    if (norm.includes(tok)) score += 1;
  }
  return score;
}

export async function searchSessionTranscript(
  sessionId: number,
  query: string,
  topK = 6,
): Promise<SessionTranscriptResult | null> {
  const t = await getTranscripcionById(sessionId);
  if (!t || !t.transcripcion) return null;

  const blob = await fetchTranscriptJson(t.transcripcion);
  const segments = wordsToSegments(blob.words);

  const queryTokens = Array.from(new Set(tokenize(query)));
  const scored: SessionTranscriptHit[] = segments
    .map((s: TranscriptSegment) => ({
      index: s.index,
      start: s.start,
      end: s.end,
      text: s.text,
      score: scoreSegment(s.text, queryTokens),
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.start - b.start))
    .slice(0, Math.max(1, Math.min(topK, 10)));

  // Re-sort returned hits chronologically — the model reads them more
  // coherently when timecodes increase monotonically. Score ordering only
  // matters for the slice above.
  scored.sort((a, b) => a.start - b.start);

  const ytMatch = (t.youtube ?? '').match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);

  return {
    session_id: t.id,
    titulo: t.titulo,
    fecha: t.fecha,
    youtube_id: ytMatch ? ytMatch[1] : null,
    duration_s: t.duration,
    total_segments: segments.length,
    hits: scored,
  };
}

/**
 * Versión Supabase de searchSessionTranscript — para sesiones nuevas con
 * UUID (no legacy int). Bug 2026-05-12: el tool search_session_transcript
 * solo soportaba sesiones legacy, entonces al preguntar "qué pasa en esta
 * sesión" en una sesión UUID Lexa respondía "no encontré nada en el corpus"
 * porque no tenía ninguna tool para leer el transcript.
 *
 * Lee directo de `transcript_segments` (paginado para superar el cap de
 * 1000 de PostgREST) y aplica el mismo algoritmo de keyword scoring.
 */
export async function searchSessionTranscriptByUuid(
  sessionUuid: string,
  query: string,
  topK = 6,
): Promise<SessionTranscriptResult | null> {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for searchSessionTranscriptByUuid');
  const sb = createClient(url, key);

  // 1) Metadata de la sesión (título, fecha, yt_id)
  const { data: sess, error: sessErr } = await sb
    .from('sessions')
    .select('id, youtube_video_id, fecha, metadata')
    .eq('id', sessionUuid)
    .maybeSingle();
  if (sessErr || !sess) return null;

  const meta = (sess.metadata ?? {}) as { raw_title?: string; sesion_label?: string; duration_seconds?: number };
  const titulo = meta.raw_title || meta.sesion_label || `Sesión ${sessionUuid.slice(0, 8)}`;

  // 2) Paginar segments hasta agotar (cap PostgREST = 1000 por request)
  type Seg = { segment_idx: number; start_seconds: number; end_seconds: number; text: string };
  const all: Seg[] = [];
  const PAGE = 1000;
  for (let off = 0; off < 50_000; off += PAGE) {
    const { data: page, error } = await sb
      .from('transcript_segments')
      .select('segment_idx, start_seconds, end_seconds, text')
      .eq('session_id', sessionUuid)
      .order('segment_idx', { ascending: true })
      .range(off, off + PAGE - 1);
    if (error) throw new Error(`segments fetch: ${error.message}`);
    if (!page || page.length === 0) break;
    all.push(...(page as Seg[]));
    if (page.length < PAGE) break;
  }

  if (all.length === 0) {
    return {
      session_id: 0,
      titulo,
      fecha: sess.fecha ?? '',
      youtube_id: sess.youtube_video_id,
      duration_s: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
      total_segments: 0,
      hits: [],
    };
  }

  const queryTokens = Array.from(new Set(tokenize(query)));
  const scored: SessionTranscriptHit[] = all
    .map((s) => ({
      index: s.segment_idx,
      start: Number(s.start_seconds),
      end: Number(s.end_seconds),
      text: s.text ?? '',
      score: scoreSegment(s.text ?? '', queryTokens),
    }))
    .filter((h) => h.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.start - b.start))
    .slice(0, Math.max(1, Math.min(topK, 10)));

  scored.sort((a, b) => a.start - b.start);

  return {
    session_id: 0, // UUID-backed, los callers usan el sessionUuid aparte
    titulo,
    fecha: sess.fecha ?? '',
    youtube_id: sess.youtube_video_id,
    duration_s: typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0,
    total_segments: all.length,
    hits: scored,
  };
}
