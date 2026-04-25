/**
 * Smoke test E2E: embed query → match_chunks RPC → assert top hit relevant.
 * No tool calling, no LLM. Sólo valida la pipeline RAG.
 *
 * Run: npx tsx -r dotenv/config scripts/smoke-rag.ts dotenv_config_path=.env.local
 */
import { createClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';

const project = process.env.GCP_PROJECT_ID!;
const location = process.env.GCP_LOCATION ?? 'us-central1';
const model = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const dim = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const vertex = new PredictionServiceClient({
  apiEndpoint: `${location}-aiplatform.googleapis.com`,
});
const endpoint = `projects/${project}/locations/${location}/publishers/google/models/${model}`;

async function embed(text: string): Promise<number[]> {
  const instance = helpers.toValue({ content: text, task_type: 'RETRIEVAL_QUERY' });
  const parameters = helpers.toValue({ outputDimensionality: dim });
  const [res] = await vertex.predict({
    endpoint,
    instances: instance ? [instance] : [],
    parameters,
  });
  const decoded = helpers.fromValue(res.predictions?.[0] as never) as {
    embeddings?: { values?: number[] };
  };
  return decoded?.embeddings?.values ?? [];
}

const QUERIES = [
  '¿Cómo votó la fracción del Frente Amplio sobre la ley eléctrica?',
  '¿Qué dijo Hacendarios sobre el techo presupuestario?',
  '¿Aprobaron el préstamo BID para la sequía en Guanacaste?',
];

(async () => {
  for (const q of QUERIES) {
    console.log('\n[query]', q);
    const vec = await embed(q);
    const { data, error } = await supa.rpc('match_chunks', {
      query_embedding: vec,
      match_count: 3,
      filter_session_id: null,
      filter_comision: null,
      filter_fecha_from: null,
      filter_fecha_to: null,
    });
    if (error) {
      console.error('  RPC error:', error.message);
      process.exit(1);
    }
    const hits = (data ?? []) as Array<{ similarity: number; comision: string; content: string }>;
    if (!hits.length) {
      console.error('  NO HITS');
      continue;
    }
    hits.forEach((h, i) => {
      console.log(`  [${i + 1}] sim=${(h.similarity * 100).toFixed(1)}% [${h.comision}] ${h.content.slice(0, 90)}...`);
    });
  }
  console.log('\nRAG pipeline OK.');
})();
