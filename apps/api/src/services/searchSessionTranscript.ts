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
