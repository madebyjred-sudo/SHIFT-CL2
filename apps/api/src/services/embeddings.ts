/**
 * Vertex AI embeddings service — drop-in for OpenAI text-embedding-3-large.
 *
 * Model: gemini-embedding-001 (3072d, multilingual, GA Q1 2026).
 * Same dimensionality as text-embedding-3-large → no migration on pgvector schema.
 *
 * Auth: GOOGLE_APPLICATION_CREDENTIALS env var → SA JSON. Reuse same SA used for GCS.
 *
 * task_type matters for retrieval quality:
 *   - RETRIEVAL_DOCUMENT for chunks at index time
 *   - RETRIEVAL_QUERY for user query at search time
 *
 * gemini-embedding-001 accepts 1 instance per request. We parallelize with
 * concurrency limit to respect QPS quotas (default 600 QPM = 10 QPS).
 */

import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';
import { withTimeout, withRetry } from './resilience.js';

const DEFAULT_LOCATION = 'us-central1';
const DEFAULT_MODEL = 'gemini-embedding-001';
const DEFAULT_DIM = 3072;
const CONCURRENCY = 8;
// Subido de 15s → 30s (2026-05-25). El cold start de Vertex AI puede
// superar 15s en la primera invocación del proceso Cloud Run, y eso
// hace que search_transcripts falle con "timeout" — Lexa reporta al
// usuario "error de tiempo de respuesta del sistema" y no puede citar
// transcripciones. El call promedio de Vertex Gemini embed cuando está
// caliente es 200-500ms; 30s da margen para 1-2 retries en cold start.
const EMBED_TIMEOUT_MS = 30_000;
const EMBED_RETRY_ATTEMPTS = 3;
const EMBED_RETRY_BASE_MS = 400;

export type EmbedTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

let _client: PredictionServiceClient | null = null;

function client(): PredictionServiceClient {
  if (_client) return _client;
  const location = process.env.GCP_LOCATION ?? DEFAULT_LOCATION;
  _client = new PredictionServiceClient({
    apiEndpoint: `${location}-aiplatform.googleapis.com`,
  });
  return _client;
}

function endpointPath(): string {
  const project = process.env.GCP_PROJECT_ID;
  if (!project) throw new Error('GCP_PROJECT_ID not set');
  const location = process.env.GCP_LOCATION ?? DEFAULT_LOCATION;
  const model = process.env.VERTEX_EMBEDDING_MODEL ?? DEFAULT_MODEL;
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`;
}

async function embedOne(text: string, taskType: EmbedTaskType): Promise<number[]> {
  const dim = Number(process.env.VERTEX_EMBEDDING_DIM ?? DEFAULT_DIM);
  const instance = helpers.toValue({ content: text, task_type: taskType });
  const parameters = helpers.toValue({ outputDimensionality: dim });

  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          // The Google client doesn't accept AbortSignal directly, so we race
          // it against a Promise that rejects on abort. Not perfect cancellation,
          // but the call still gets cleaned up by GC after timeout.
          const abortPromise = new Promise<never>((_, reject) => {
            const onAbort = () => reject(signal.reason ?? new Error('aborted'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          });
          const callPromise = client().predict({
            endpoint: endpointPath(),
            instances: instance ? [instance] : [],
            parameters,
          });
          const [response] = await Promise.race([callPromise, abortPromise]);
          const prediction = response.predictions?.[0];
          if (!prediction) throw new Error('vertex predict: no predictions returned');
          const decoded = helpers.fromValue(prediction as never) as {
            embeddings?: { values?: number[] };
          };
          const values = decoded?.embeddings?.values;
          if (!values || !Array.isArray(values)) {
            throw new Error('vertex predict: missing embeddings.values');
          }
          return values;
        },
        { ms: EMBED_TIMEOUT_MS, label: `vertex embed (${taskType})` },
      ),
    {
      attempts: EMBED_RETRY_ATTEMPTS,
      baseDelayMs: EMBED_RETRY_BASE_MS,
      label: `vertex embed (${taskType})`,
    },
  );
}

async function inChunks<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Embed a single query (RETRIEVAL_QUERY task type). */
export async function embedQuery(text: string): Promise<number[]> {
  return embedOne(text, 'RETRIEVAL_QUERY');
}

/** Embed multiple documents (RETRIEVAL_DOCUMENT). Parallelized w/ concurrency. */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return inChunks(texts, CONCURRENCY, (t) => embedOne(t, 'RETRIEVAL_DOCUMENT'));
}
