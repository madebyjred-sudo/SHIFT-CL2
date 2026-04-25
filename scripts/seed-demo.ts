/**
 * shift-cl2 — Seed demo data with REAL Vertex AI embeddings
 *
 * Inserta:
 *   - 3 sessions (Plenario #120 marzo 2026, Hacendarios, Extraordinaria)
 *   - 5 chunks por session, embeddings gemini-embedding-001 (3072d, multilingual)
 *
 * Pre-req:
 *   - migration 0001_init.sql aplicada en Supabase
 *   - GOOGLE_APPLICATION_CREDENTIALS apunta a SA JSON con permiso aiplatform.user
 *   - GCP_PROJECT_ID set (usually shift-cl2 or your GCP project)
 *
 * Run: npm run seed:demo
 *
 * Demo Oscar 2026-05-08 antes de migrar dataset real (Sprint 3).
 */

import { createClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const gcpProject = process.env.GCP_PROJECT_ID;

if (!supabaseUrl || !supabaseKey) {
  console.error('[seed] missing Supabase env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(1);
}
if (!gcpProject) {
  console.error('[seed] missing GCP_PROJECT_ID (needed for Vertex AI embeddings)');
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('[seed] missing GOOGLE_APPLICATION_CREDENTIALS (path to GCP service account JSON)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

const GCP_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);

const vertex = new PredictionServiceClient({
  apiEndpoint: `${GCP_LOCATION}-aiplatform.googleapis.com`,
});
const VERTEX_ENDPOINT = `projects/${gcpProject}/locations/${GCP_LOCATION}/publishers/google/models/${EMBED_MODEL}`;

const DEMO_SESSIONS = [
  {
    legacy_video_id: 'demo-plenario-120-2026-03-04',
    fecha: '2026-03-04',
    comision: 'Plenario',
    tipo: 'plenario' as const,
    video_url: 'https://www.youtube.com/watch?v=DEMO_PLENARIO_120',
    transcript_url: 'gs://sesiones-transcripciones-uc1/plenario-120.txt',
    status: 'indexed' as const,
    chunks: [
      'En la sesión número 120 del Plenario, con fecha 4 de marzo de 2026, se discutió el Proyecto de Ley 23.456, "Ley de Modernización del Sistema Eléctrico Nacional". El diputado Pérez presentó la moción de fondo destacando la urgencia de actualizar la red eléctrica.',
      'La fracción del Frente Amplio expresó preocupaciones sobre la apertura del mercado eléctrico al sector privado, argumentando que podría afectar las tarifas de los usuarios residenciales.',
      'La votación en primer debate concluyó con 38 votos a favor, 12 en contra y 7 abstenciones. El expediente pasa a la Comisión de Asuntos Hacendarios para análisis presupuestario.',
      'Durante la discusión se aprobó por unanimidad la moción de orden número 4, que solicita un estudio actuarial al ICE sobre el impacto tarifario del proyecto en los próximos cinco años.',
      'El presidente del Plenario clausuró la sesión a las 18:42, convocando a la siguiente sesión ordinaria para el miércoles 11 de marzo a las 15:00.',
    ],
  },
  {
    legacy_video_id: 'demo-hacendarios-2026-03-11',
    fecha: '2026-03-11',
    comision: 'Hacendarios',
    tipo: 'comision' as const,
    video_url: 'https://www.youtube.com/watch?v=DEMO_HACENDARIOS',
    transcript_url: 'gs://sesiones-transcripciones-uc1/hacendarios-2026-03-11.txt',
    status: 'indexed' as const,
    chunks: [
      'La Comisión de Asuntos Hacendarios sesionó el 11 de marzo de 2026 para analizar el dictamen del Proyecto 23.456 remitido por el Plenario.',
      'La Contraloría General de la República presentó un informe técnico señalando observaciones sobre la sostenibilidad fiscal del fondo de transición energética propuesto en el artículo 12.',
      'La diputada Rodríguez (PUSC) presentó moción de modificación al artículo 12 para incluir un techo presupuestario anual de ₡15.000 millones, evitando compromisos plurianuales sin aval de Hacienda.',
      'El representante del Ministerio de Hacienda confirmó que el proyecto requiere dictamen técnico previo de la Dirección General de Presupuesto Nacional antes de su segundo debate en Plenario.',
      'La comisión aprobó por mayoría calificada (5-2) el dictamen afirmativo de mayoría, con la modificación al artículo 12 incorporada. El expediente regresa al Plenario para segundo debate.',
    ],
  },
  {
    legacy_video_id: 'demo-extraordinaria-2026-03-18',
    fecha: '2026-03-18',
    comision: 'Plenario',
    tipo: 'extraordinaria' as const,
    video_url: 'https://www.youtube.com/watch?v=DEMO_EXTRA_2026',
    transcript_url: 'gs://sesiones-transcripciones-uc1/extra-2026-03-18.txt',
    status: 'indexed' as const,
    chunks: [
      'Sesión extraordinaria del 18 de marzo de 2026 convocada por el Poder Ejecutivo para discutir el Decreto Ejecutivo 44.123 sobre estado de emergencia hidrológica en la región Chorotega.',
      'El Ministro de Ambiente expuso el plan de contingencia que requiere la aprobación legislativa de un crédito extraordinario por USD 35 millones del BID.',
      'La diputada Mora (PLN) cuestionó la falta de evaluación de impacto ambiental en las obras de captación previstas en el plan, solicitando que se incorpore SETENA en el proceso.',
      'Se aprobó en primer y segundo debate, por trámite de urgencia, el Convenio de Préstamo BID-CR-2026-001 con 47 votos a favor y 8 en contra.',
      'La sesión clausuró con la lectura del comunicado oficial del Plenario reafirmando el compromiso con las comunidades afectadas por la sequía en Guanacaste.',
    ],
  },
];

async function embedOne(text: string): Promise<number[]> {
  const instance = helpers.toValue({ content: text, task_type: 'RETRIEVAL_DOCUMENT' });
  const parameters = helpers.toValue({ outputDimensionality: EMBED_DIM });
  const [response] = await vertex.predict({
    endpoint: VERTEX_ENDPOINT,
    instances: instance ? [instance] : [],
    parameters,
  });
  const prediction = response.predictions?.[0];
  if (!prediction) throw new Error('vertex: no prediction returned');
  const decoded = helpers.fromValue(prediction as never) as {
    embeddings?: { values?: number[] };
  };
  const values = decoded?.embeddings?.values;
  if (!values) throw new Error('vertex: missing embeddings.values');
  return values;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  // gemini-embedding-001 accepts 1 instance per request — parallelize sequentially
  // with concurrency 4 to stay within QPS quotas during seed.
  const out: number[][] = new Array(texts.length);
  const queue = texts.map((t, i) => ({ t, i }));
  const workers = Array.from({ length: Math.min(4, texts.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      out[item.i] = await embedOne(item.t);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  console.log(`[seed] start. provider=vertex model=${EMBED_MODEL} dim=${EMBED_DIM} location=${GCP_LOCATION}`);

  let totalChunks = 0;
  let totalSessions = 0;

  for (const s of DEMO_SESSIONS) {
    const { chunks, ...sessionRow } = s;

    const { data: session, error: sErr } = await supabase
      .from('sessions')
      .upsert(sessionRow, { onConflict: 'legacy_video_id' })
      .select('id')
      .single();

    if (sErr || !session) {
      console.error(`[seed] failed session ${s.legacy_video_id}`, sErr);
      continue;
    }

    await supabase.from('legislative_chunks').delete().eq('session_id', session.id);

    console.log(`[seed] embedding ${chunks.length} chunks for ${s.legacy_video_id}...`);
    const embeddings = await embedBatch(chunks);

    const rows = chunks.map((content, idx) => ({
      session_id: session.id,
      source_type: 'transcript' as const,
      source_ref: s.legacy_video_id,
      chunk_index: idx,
      content,
      embedding: embeddings[idx] as unknown as string,
      metadata: { fecha: s.fecha, comision: s.comision, demo: true },
    }));

    const { error: cErr } = await supabase.from('legislative_chunks').insert(rows);
    if (cErr) {
      console.error(`[seed] failed chunks ${s.legacy_video_id}`, cErr);
      continue;
    }

    console.log(`[seed]   ✓ ${s.legacy_video_id}: 1 session + ${chunks.length} chunks`);
    totalSessions++;
    totalChunks += chunks.length;
  }

  console.log(`[seed] done. ${totalSessions} sessions, ${totalChunks} chunks with real Vertex AI embeddings.`);
  console.log('[seed] next: apply 0002_match_chunks.sql to enable RAG search.');
}

main().catch((err) => {
  console.error('[seed] fatal', err);
  process.exit(1);
});
