/**
 * Smoke test: verifica que SA JSON + GCP_PROJECT_ID + Vertex AI API enabled.
 * No toca Supabase. Llama gemini-embedding-001 con un texto chiquito.
 *
 * Run: npx tsx -r dotenv/config scripts/smoke-vertex.ts dotenv_config_path=.env.local
 */
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';

const project = process.env.GCP_PROJECT_ID;
const location = process.env.GCP_LOCATION ?? 'us-central1';
// Override via SMOKE_MODEL env to test alternatives
const model = process.env.SMOKE_MODEL ?? process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const dim = Number(process.env.SMOKE_DIM ?? process.env.VERTEX_EMBEDDING_DIM ?? 3072);

console.log('[smoke] project=%s location=%s model=%s dim=%s', project, location, model, dim);
console.log('[smoke] credentials=%s', process.env.GOOGLE_APPLICATION_CREDENTIALS);

if (!project) {
  console.error('FAIL: GCP_PROJECT_ID not set');
  process.exit(1);
}

const client = new PredictionServiceClient({
  apiEndpoint: `${location}-aiplatform.googleapis.com`,
});

const endpoint = `projects/${project}/locations/${location}/publishers/google/models/${model}`;
const instance = helpers.toValue({
  content: 'Sesión del Plenario sobre el proyecto de modernización eléctrica',
  task_type: 'RETRIEVAL_QUERY',
});
const parameters = helpers.toValue({ outputDimensionality: dim });

(async () => {
  try {
    const [response] = await client.predict({
      endpoint,
      instances: instance ? [instance] : [],
      parameters,
    });
    const decoded = helpers.fromValue(response.predictions?.[0] as never) as {
      embeddings?: { values?: number[] };
    };
    const values = decoded?.embeddings?.values;
    if (!values) {
      console.error('FAIL: no embeddings.values in response');
      process.exit(1);
    }
    console.log('OK: got %d-dim vector. first 3 values: [%s]', values.length, values.slice(0, 3).join(', '));
    console.log('Vertex AI ready. Procedé con migrations + seed.');
  } catch (err) {
    console.error('FAIL:', (err as Error).message);
    process.exit(1);
  }
})();
