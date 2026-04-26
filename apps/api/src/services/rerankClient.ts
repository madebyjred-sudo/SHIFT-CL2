/**
 * Reranker — wraps a hosted cross-encoder (Voyage AI rerank-2 or
 * rerank-2-lite) to re-score the top-N retrieved chunks against the
 * query. Cross-encoders consider the (query, chunk) pair jointly and
 * yield much sharper relevance signals than bi-encoder cosine alone.
 *
 * In our pipeline this lives DOWNSTREAM of match_chunks_hybrid:
 *   - hybrid retrieves top-N (cheap, fast, two-signal)
 *   - reranker re-scores the top-N to pick the top-K we hand to the LLM
 *
 * Pure pass-through when VOYAGE_API_KEY isn't set: the function returns
 * the input list trimmed to top-K, untouched. This keeps every hot path
 * functional during local dev without a Voyage key.
 *
 * Voyage rerank-2 multilingual handles Spanish well — that matters for
 * the legislative dictums where dense embeddings sometimes confuse
 * "minoría parlamentaria" with "minoría de votos" because both share
 * surface tokens. Tested informally vs Cohere rerank-multilingual-v3.5;
 * Voyage edges out for legal-Spanish formality.
 *
 * Pricing as of 2026-04: $0.05 / 1M input tokens. A typical query of
 * 50 chunks × ~400 tokens = 20k tokens = $0.001 per call. Demo budget
 * impact: negligible.
 */

const VOYAGE_API_BASE = process.env.VOYAGE_API_BASE ?? 'https://api.voyageai.com/v1';
const VOYAGE_MODEL = process.env.VOYAGE_RERANK_MODEL ?? 'rerank-2';
const VOYAGE_TIMEOUT_MS = 6_000;

export interface RerankableDoc {
  /** Caller-defined id used to map rerank output back to the original
   *  hit object. We don't depend on the doc's own id field. */
  id: string;
  /** Text the reranker scores against the query. Trimmed to first 4k
   *  chars upstream — that's the per-document context the model sees. */
  text: string;
}

export interface RerankResult {
  id: string;
  /** [0, 1] — Voyage's relevance score; higher is better. */
  score: number;
}

/**
 * Re-score `docs` against `query`. Returns top-K ordered by score.
 * Falls through to identity (top-K of input unchanged) when the API
 * key is missing or the call fails — never throws into the chat path.
 */
export async function rerank(args: {
  query: string;
  docs: RerankableDoc[];
  topK?: number;
}): Promise<RerankResult[]> {
  const topK = Math.max(1, args.topK ?? 5);
  const apiKey = process.env.VOYAGE_API_KEY;

  // No API key configured → identity rerank: same order, trimmed to topK.
  // Score 0 (uninformative) so callers don't mistake it for a real signal.
  if (!apiKey) {
    return args.docs.slice(0, topK).map((d) => ({ id: d.id, score: 0 }));
  }

  if (args.docs.length === 0) return [];
  if (args.docs.length === 1) return [{ id: args.docs[0].id, score: 1 }];

  // Voyage caps each document at ~16k tokens; we trim defensively at 4k
  // chars (~1k tokens) which is plenty for a typical chunk and keeps the
  // request body small enough for sub-second roundtrips.
  const documents = args.docs.map((d) => d.text.slice(0, 4_000));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VOYAGE_TIMEOUT_MS);
  try {
    const res = await fetch(`${VOYAGE_API_BASE}/rerank`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        query: args.query,
        documents,
        top_k: Math.min(topK, args.docs.length),
        return_documents: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // Best-effort: log and fall back to identity. Demo > strictness.
      const txt = await res.text().catch(() => '');
      console.warn(`[rerank] voyage ${res.status}: ${txt.slice(0, 200)} — falling back to identity`);
      return args.docs.slice(0, topK).map((d) => ({ id: d.id, score: 0 }));
    }
    const json = (await res.json()) as {
      data?: Array<{ index: number; relevance_score: number }>;
    };
    const out: RerankResult[] = (json.data ?? [])
      .map((r) => {
        const orig = args.docs[r.index];
        if (!orig) return null;
        return { id: orig.id, score: r.relevance_score };
      })
      .filter((x): x is RerankResult => x !== null)
      .slice(0, topK);
    return out;
  } catch (err) {
    console.warn(`[rerank] error (${(err as Error).message}) — falling back to identity`);
    return args.docs.slice(0, topK).map((d) => ({ id: d.id, score: 0 }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convenience: take the input array, run rerank, return the input items
 * re-ordered (and trimmed to topK). Preserves the caller's item shape.
 */
export async function rerankItems<T extends { chunk_id: string; content: string }>(
  query: string,
  items: T[],
  topK: number = 5,
): Promise<T[]> {
  if (items.length <= 1) return items;
  const docs = items.map((i) => ({ id: i.chunk_id, text: i.content }));
  const ranked = await rerank({ query, docs, topK });
  const byId = new Map(items.map((i) => [i.chunk_id, i] as const));
  return ranked
    .map((r) => byId.get(r.id))
    .filter((x): x is T => x !== undefined);
}
