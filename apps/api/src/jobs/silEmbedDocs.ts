/**
 * silEmbedDocs — genera chunks + embeddings para docs en `sil_documentos`
 *   que aún NO tienen chunks asociados en `legislative_chunks`.
 *
 * Diseñado para correr como Cloud Scheduler job (vía endpoint en centinela.ts).
 * Modo one-shot: procesa hasta N docs pendientes y retorna.
 *
 * Pipeline:
 *   1. Listar sil_documentos con text_chars >= 100.
 *   2. Filtrar los que NO tienen chunks en legislative_chunks.
 *   3. Chunk texto, generar embeddings vía Vertex AI.
 *   4. Insertar en legislative_chunks.
 *   5. Marcar sil_documentos.status = 'embedded'.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';
import { logger } from '../services/logger.js';

export interface SilEmbedResult {
  started_at: string;
  finished_at: string;
  docs_pending: number;
  docs_embedded: number;
  chunks_created: number;
  errors: number;
  skipped_no_text: number;
  skipped_no_chunks: number;
}

interface SilDoc {
  id: string;
  expediente_id: number;
  tipo: string;
  titulo: string | null;
  source_url: string | null;
  gcs_path: string | null;
  text_extracted: string | null;
  text_chars: number;
  status: string;
  metadata: Record<string, unknown> | null;
}

interface Expediente {
  id: number;
  numero: string;
  comision: string | null;
  estado: string | null;
  fecha_presentacion: string | null;
}

function supa(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('silEmbedDocs: missing Supabase creds');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function vertexClient() {
  const project = process.env.GCP_PROJECT_ID ?? 'sincere-burner-475520-g7';
  const location = process.env.GCP_LOCATION ?? 'us-central1';
  const model = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
  const endpoint = `projects/${project}/locations/${location}/publishers/google/models/${model}`;
  return {
    client: new PredictionServiceClient({ apiEndpoint: `${location}-aiplatform.googleapis.com` }),
    endpoint,
    dim: Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072),
    concurrency: Number(process.env.VERTEX_CONCURRENCY ?? 4),
  };
}

function chunkText(text: string, maxChars: number): Array<{ text: string; index: number }> {
  if (!text) return [];
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: Array<{ text: string; index: number }> = [];
  let buf = '';
  let idx = 0;
  const flush = () => {
    const t = buf.trim();
    if (t.length >= 100) chunks.push({ text: t, index: idx++ });
    buf = '';
  };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      if (buf) flush();
      for (let i = 0; i < p.length; i += maxChars) {
        chunks.push({ text: p.slice(i, i + maxChars).trim(), index: idx++ });
      }
      continue;
    }
    if (buf.length + p.length + 2 > maxChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return chunks;
}

async function embedOne(client: ReturnType<typeof vertexClient>, text: string): Promise<number[]> {
  const instance = helpers.toValue({ content: text, task_type: 'RETRIEVAL_DOCUMENT' });
  const parameters = helpers.toValue({ outputDimensionality: client.dim });
  const [response] = await client.client.predict({
    endpoint: client.endpoint,
    instances: instance ? [instance] : [],
    parameters,
  });
  const decoded = helpers.fromValue(response.predictions?.[0] as never) as {
    embeddings?: { values?: number[] };
  };
  const values = decoded?.embeddings?.values;
  if (!values || !Array.isArray(values)) throw new Error('vertex: missing values');
  return values;
}

async function embedBatch(client: ReturnType<typeof vertexClient>, texts: string[]): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  const queue = texts.map((t, i) => ({ t, i }));
  await Promise.all(
    Array.from({ length: Math.min(client.concurrency, texts.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        let attempt = 0;
        while (true) {
          try {
            out[item.i] = await embedOne(client, item.t);
            break;
          } catch (err) {
            attempt += 1;
            if (attempt >= 3) {
              logger.warn('sil_embed_vertex_failed', { error: (err as Error).message });
              out[item.i] = new Array(client.dim).fill(0);
              break;
            }
            await new Promise((r) => setTimeout(r, 500 * attempt));
          }
        }
      }
    }),
  );
  return out;
}

function expIdToNumero(id: number): string {
  const s = String(id);
  if (s.length <= 3) return s;
  return `${s.slice(0, s.length - 3)}.${s.slice(-3)}`;
}

async function fetchPendingDocs(s: SupabaseClient, limit: number): Promise<SilDoc[]> {
  const { data: docs, error } = await s
    .from('sil_documentos')
    .select('id, expediente_id, tipo, titulo, source_url, gcs_path, text_extracted, text_chars, status, metadata')
    .gte('text_chars', 100)
    .order('created_at', { ascending: false })
    .limit(limit * 3);
  if (error) throw new Error(`fetchPendingDocs: ${error.message}`);
  if (!docs || docs.length === 0) return [];

  // Which ones already have chunks? Check via legislative_chunks source_ref pattern
  const expIds = Array.from(new Set(docs.map((d) => d.expediente_id)));
  const indexedExpIds = new Set<number>();

  for (let i = 0; i < expIds.length; i += 200) {
    const chunk = expIds.slice(i, i + 200);
    const { data, error: e2 } = await s
      .from('legislative_chunks')
      .select('metadata')
      .eq('source_type', 'sil_expediente')
      .in('metadata->>sil_expediente_id', chunk.map(String));
    if (e2) break;
    for (const c of data ?? []) {
      const m = c.metadata as Record<string, unknown> | null;
      const eid = Number(m?.sil_expediente_id);
      if (Number.isFinite(eid)) indexedExpIds.add(eid);
    }
  }

  // Fallback via source_ref
  const numeros = Array.from(new Set(docs.map((d) => `Exp. ${expIdToNumero(d.expediente_id)}`)));
  for (let i = 0; i < numeros.length; i += 100) {
    const slice = numeros.slice(i, i + 100);
    const { data } = await s
      .from('legislative_chunks')
      .select('source_ref, metadata')
      .eq('source_type', 'sil_expediente')
      .in('source_ref', slice.map((n) => `${n} — texto_base`));
    for (const c of data ?? []) {
      const m = c.metadata as Record<string, unknown> | null;
      const eid = Number(m?.sil_expediente_id);
      if (Number.isFinite(eid)) indexedExpIds.add(eid);
    }
  }

  const pending = docs.filter((d) => !indexedExpIds.has(d.expediente_id));
  return pending.slice(0, limit) as SilDoc[];
}

async function processDoc(
  s: SupabaseClient,
  client: ReturnType<typeof vertexClient>,
  doc: SilDoc,
  exp: Expediente | null,
  stats: { docs_embedded: number; chunks_created: number; errors: number; skipped_no_text: number; skipped_no_chunks: number },
): Promise<void> {
  const text = doc.text_extracted ?? '';
  if (text.length < 100) {
    stats.skipped_no_text += 1;
    return;
  }

  const chunks = chunkText(text, 1500);
  if (chunks.length === 0) {
    stats.skipped_no_chunks += 1;
    return;
  }

  let embeddings: number[][];
  try {
    embeddings = await embedBatch(client, chunks.map((c) => c.text));
  } catch (err) {
    stats.errors += 1;
    logger.warn('sil_embed_batch_failed', { docId: doc.id, expediente: doc.expediente_id, error: (err as Error).message });
    return;
  }

  const sourceRef = `Exp. ${expIdToNumero(doc.expediente_id)} — ${doc.tipo}`;
  const sourceType = doc.tipo === 'texto_base' ? 'sil_expediente' : 'sil_dictamen';
  const expNumero = exp?.numero ?? expIdToNumero(doc.expediente_id);

  const rows = chunks.map((c, ci) => ({
    session_id: null,
    source_type: sourceType,
    source_ref: sourceRef,
    chunk_index: c.index,
    content: c.text,
    embedding: embeddings[ci] as unknown as string,
    metadata: {
      sil_expediente_numero: expNumero,
      sil_expediente_id: doc.expediente_id,
      sil_doc_kind: doc.tipo,
      sil_doc_index: 0,
      sil_doc_filename: doc.titulo,
      sil_doc_gcs_path: doc.gcs_path,
      sil_doc_id: doc.id,
      comision: exp?.comision ?? null,
      estado: exp?.estado ?? null,
      fecha_presentacion: exp?.fecha_presentacion ?? null,
      embedded_at: new Date().toISOString(),
      embedded_by: 'silEmbedDocs',
    },
  }));

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 30) {
    const slice = rows.slice(i, i + 30);
    const { error } = await s.from('legislative_chunks').insert(slice);
    if (error) {
      stats.errors += slice.length;
      logger.warn('sil_embed_insert_failed', { docId: doc.id, error: error.message });
      return;
    }
    inserted += slice.length;
  }

  await s.from('sil_documentos').update({ status: 'embedded' }).eq('id', doc.id);
  stats.docs_embedded += 1;
  stats.chunks_created += inserted;
}

export async function runSilEmbedDocs(opts: {
  limit?: number;
  chunkChars?: number;
} = {}): Promise<SilEmbedResult> {
  const startedAt = new Date().toISOString();
  const s = supa();
  const client = vertexClient();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const chunkChars = Math.max(opts.chunkChars ?? 1500, 500);

  logger.info('sil_embed_start', { limit, chunkChars, model: process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001' });

  const pending = await fetchPendingDocs(s, limit);
  if (pending.length === 0) {
    return {
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      docs_pending: 0,
      docs_embedded: 0,
      chunks_created: 0,
      errors: 0,
      skipped_no_text: 0,
      skipped_no_chunks: 0,
    };
  }

  const expIds = Array.from(new Set(pending.map((d) => d.expediente_id)));
  const { data: exps } = await s
    .from('sil_expedientes')
    .select('id, numero, comision, estado, fecha_presentacion')
    .in('id', expIds);
  const expMap = new Map<number, Expediente>();
  for (const e of (exps ?? []) as Expediente[]) expMap.set(e.id, e);

  const stats = {
    docs_embedded: 0,
    chunks_created: 0,
    errors: 0,
    skipped_no_text: 0,
    skipped_no_chunks: 0,
  };

  logger.info('sil_embed_pending', { count: pending.length });
  for (const doc of pending) {
    await processDoc(s, client, doc, expMap.get(doc.expediente_id) ?? null, stats);
    if ((stats.docs_embedded + stats.errors) % 10 === 0) {
      logger.info('sil_embed_progress', {
        docs: stats.docs_embedded,
        chunks: stats.chunks_created,
        errors: stats.errors,
      });
    }
  }

  const result: SilEmbedResult = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    docs_pending: pending.length,
    docs_embedded: stats.docs_embedded,
    chunks_created: stats.chunks_created,
    errors: stats.errors,
    skipped_no_text: stats.skipped_no_text,
    skipped_no_chunks: stats.skipped_no_chunks,
  };

  logger.info('sil_embed_complete', { ...result });
  return result;
}
