import { createClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';
import 'dotenv/config';

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
  const decoded = helpers.fromValue(res.predictions?.[0] as never) as any;
  return decoded?.embeddings?.values ?? [];
}

const query = process.argv[2] || 'Resumen del expediente 25.600';

(async () => {
    console.log('\n[query]', query);
    const vec = await embed(query);
    const { data, error } = await supa.rpc('match_chunks', {
      query_embedding: vec,
      match_count: 5,
      filter_session_id: null,
      filter_comision: null,
      filter_fecha_from: null,
      filter_fecha_to: null,
    });
    if (error) {
      console.error('  RPC error:', error.message);
      process.exit(1);
    }
    const hits = (data ?? []) as Array<{ similarity: number; comision: string; content: string, source_ref: string }>;
    if (!hits.length) {
      console.error('  NO HITS');
      return;
    }
    hits.forEach((h, i) => {
      console.log(`  [${i + 1}] sim=${(h.similarity * 100).toFixed(1)}% [${h.source_ref}] ${h.content.slice(0, 150)}...`);
    });
})();
