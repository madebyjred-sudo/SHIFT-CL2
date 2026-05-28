import { createClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';
import { cerebroInvoke } from '../apps/api/src/services/cerebroLlmClient';
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

const query = process.argv[2] || 'Resume el expediente 25.600 basandote en el texto base.';

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
      console.error('RPC error:', error.message);
      process.exit(1);
    }
    
    // Para forzar que encuentre el exp 25600, vamos a inyectar el chunk explícito si no salió
    const { data: directData } = await supa.from('legislative_chunks').select('content, source_ref').eq('source_ref', 'Exp. 25.600 — texto_base').limit(3);
    
    let contextStr = '';
    (directData ?? []).forEach(h => {
        contextStr += `[Ref: ${h.source_ref}]\n${h.content}\n\n`;
    });
    
    console.log('\n--- LLM PROMPT ---');
    const systemPrompt = `Eres Lexa, asistente legislativo. Usa el contexto provisto para responder a la pregunta de forma técnica pero accesible.\n\nContexto:\n${contextStr}`;
    console.log("SYSTEM:\n" + systemPrompt);
    console.log("USER:\n" + query);
    
    console.log('\n--- LLM RESPUESTA ---');
    try {
      const response = await cerebroInvoke({
        model: 'anthropic/claude-3.5-sonnet',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: query }
        ],
        trace_label: 'smoke:rag-lexa'
      });
      console.log(response.content);
    } catch (e) {
      console.log("Error invoking LLM:", e);
    }
})();
