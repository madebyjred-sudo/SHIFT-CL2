/**
 * embed-sil-docs-pending.ts
 *
 * Genera chunks + embeddings para los rows en `sil_documentos` que aún NO
 * tienen chunks asociados en `legislative_chunks`. Esto cierra el gap entre
 * "doc descargado" (visible en /sil browse) y "doc citable por Lexa/Atlas"
 * (requiere chunks indexed con embedding vector).
 *
 * Puede correr **en paralelo** al bulk download-sil-pdf-only.ts: cada vez
 * que el bulk inserta un row en sil_documentos, este script lo recoge en
 * la siguiente iteración y lo embede. Diseñado para ser idempotente:
 * verifica que no haya chunks previos antes de generar nuevos.
 *
 * Uso:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   node --max-old-space-size=8192 --env-file=.env.local \
 *     --import tsx scripts/embed-sil-docs-pending.ts
 *
 * Env opcionales:
 *   POLL_INTERVAL_MS  (default 30000)  — espera entre passes cuando no
 *                                        hay docs pendientes
 *   ONE_SHOT=1                          — corre un solo pass y exit
 *   MAX_DOCS_PER_RUN  (default 200)    — cap por pass
 *   CHUNK_CHARS       (default 1500)
 */
import { createClient } from '@supabase/supabase-js';
import { PredictionServiceClient, helpers } from '@google-cloud/aiplatform';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const GCP_PROJECT = process.env.GCP_PROJECT_ID ?? 'sincere-burner-475520-g7';
const GCP_LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const EMBED_MODEL = process.env.VERTEX_EMBEDDING_MODEL ?? 'gemini-embedding-001';
const EMBED_DIM = Number(process.env.VERTEX_EMBEDDING_DIM ?? 3072);
const VERTEX_CONCURRENCY = Number(process.env.VERTEX_CONCURRENCY ?? 4);
const VERTEX_ENDPOINT = `projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${EMBED_MODEL}`;

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 30_000);
const ONE_SHOT = process.env.ONE_SHOT === '1';
const MAX_DOCS_PER_RUN = Number(process.env.MAX_DOCS_PER_RUN ?? 200);
const CHUNK_CHARS = Number(process.env.CHUNK_CHARS ?? 1500);

const vertex = new PredictionServiceClient({
  apiEndpoint: `${GCP_LOCATION}-aiplatform.googleapis.com`,
});

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

async function embedOne(text: string): Promise<number[]> {
  const instance = helpers.toValue({ content: text, task_type: 'RETRIEVAL_DOCUMENT' });
  const parameters = helpers.toValue({ outputDimensionality: EMBED_DIM });
  const [response] = await vertex.predict({
    endpoint: VERTEX_ENDPOINT,
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

async function embedBatch(texts: string[]): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  const queue = texts.map((t, i) => ({ t, i }));
  await Promise.all(
    Array.from({ length: Math.min(VERTEX_CONCURRENCY, texts.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        let attempt = 0;
        while (true) {
          try { out[item.i] = await embedOne(item.t); break; }
          catch (err) {
            attempt += 1;
            if (attempt >= 3) {
              console.warn(`embed failed after 3 attempts: ${(err as Error).message}`);
              out[item.i] = new Array(EMBED_DIM).fill(0); // zero vector — won't match anything
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

async function fetchPendingDocs(limit: number): Promise<SilDoc[]> {
  // Estrategia: tomar TODOS los sil_documentos donde text_chars > 100 (suficiente
  // texto para chunkar) y luego filtrar localmente los que NO tienen chunks
  // asociados. Más simple que un JOIN — para 10k docs es barato.
  //
  // Idempotencia: el filtro local detecta los que ya tienen chunks via
  // metadata->>sil_doc_id (cuando 0030 esté) o via metadata->>sil_expediente_id +
  // metadata->>sil_doc_kind + metadata->>sil_doc_index (compat con 0006).
  const { data: docs, error } = await supa
    .from('sil_documentos')
    .select('id, expediente_id, tipo, titulo, source_url, gcs_path, text_extracted, text_chars, status, metadata')
    .gte('text_chars', 100)
    .order('created_at', { ascending: false })
    .limit(limit * 3); // overfetch, filter locally
  if (error) throw new Error(`fetchPendingDocs: ${error.message}`);
  if (!docs || docs.length === 0) return [];

  // ¿Cuáles ya tienen chunks?
  const expIds = Array.from(new Set(docs.map((d) => d.expediente_id)));
  const indexedExpIds = new Set<number>();
  for (let i = 0; i < expIds.length; i += 200) {
    const chunk = expIds.slice(i, i + 200);
    const { data, error: e2 } = await supa
      .from('legislative_chunks')
      .select('metadata')
      .eq('source_type', 'sil_expediente')
      .in('metadata->>sil_expediente_id', chunk.map(String));
    if (e2) {
      // metadata->>sil_expediente_id no es buscable directamente con .in
      // Fallback: query por source_ref que sí podemos construir.
      break;
    }
    for (const c of data ?? []) {
      const m = c.metadata as Record<string, unknown> | null;
      const eid = Number(m?.sil_expediente_id);
      if (Number.isFinite(eid)) indexedExpIds.add(eid);
    }
  }

  // Fallback más confiable: query agrupado por source_ref pattern
  const numeros = Array.from(new Set(docs.map((d) => `Exp. ${expIdToNumero(d.expediente_id)}`)));
  for (let i = 0; i < numeros.length; i += 100) {
    const slice = numeros.slice(i, i + 100);
    const { data } = await supa
      .from('legislative_chunks')
      .select('source_ref, metadata')
      .eq('source_type', 'sil_expediente')
      .in('source_ref', slice.map((n) => n + ' — texto_base'));
    for (const c of data ?? []) {
      const m = c.metadata as Record<string, unknown> | null;
      const eid = Number(m?.sil_expediente_id);
      if (Number.isFinite(eid)) indexedExpIds.add(eid);
    }
  }

  const pending = docs.filter((d) => !indexedExpIds.has(d.expediente_id));
  return pending.slice(0, limit) as SilDoc[];
}

function expIdToNumero(id: number): string {
  // SIL numerates like "21.450"; the id is the integer without dots.
  // For 5-digit ids, format is "XX.XXX". For 4-digit, "X.XXX".
  const s = String(id);
  if (s.length <= 3) return s;
  const head = s.slice(0, s.length - 3);
  const tail = s.slice(-3);
  return `${head}.${tail}`;
}

async function processDoc(doc: SilDoc, exp: Expediente | null, stats: Stats): Promise<void> {
  const text = doc.text_extracted ?? '';
  if (text.length < 100) {
    stats.skipped_no_text += 1;
    return;
  }

  const chunks = chunkText(text, CHUNK_CHARS);
  if (chunks.length === 0) {
    stats.skipped_no_chunks += 1;
    return;
  }

  let embeddings: number[][];
  try {
    embeddings = await embedBatch(chunks.map((c) => c.text));
  } catch (err) {
    stats.errors += 1;
    console.warn(`[doc ${doc.id} exp ${doc.expediente_id}] embed failed: ${(err as Error).message}`);
    return;
  }

  const sourceRef = `Exp. ${expIdToNumero(doc.expediente_id)} — ${doc.tipo}`;
  const sourceType = doc.tipo === 'texto_base' ? 'sil_expediente'
                  : doc.tipo.startsWith('dictamen') ? 'sil_dictamen'
                  : 'sil_dictamen';
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
      embedded_by: 'embed-sil-docs-pending',
    },
  }));

  // Insert en slices de 30 para mantenerlo bajo el límite vector size
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 30) {
    const slice = rows.slice(i, i + 30);
    const { error } = await supa.from('legislative_chunks').insert(slice);
    if (error) {
      stats.errors += slice.length;
      console.warn(`[doc ${doc.id}] chunks insert failed: ${error.message}`);
      return;
    }
    inserted += slice.length;
  }

  // Mark doc as embedded
  await supa.from('sil_documentos').update({ status: 'embedded' }).eq('id', doc.id);

  stats.docs_embedded += 1;
  stats.chunks_created += inserted;
}

interface Stats {
  docs_embedded: number;
  chunks_created: number;
  errors: number;
  skipped_no_text: number;
  skipped_no_chunks: number;
}

async function passOnce(): Promise<{ processed: number; stats: Stats }> {
  const stats: Stats = {
    docs_embedded: 0, chunks_created: 0, errors: 0,
    skipped_no_text: 0, skipped_no_chunks: 0,
  };
  const pending = await fetchPendingDocs(MAX_DOCS_PER_RUN);
  if (pending.length === 0) return { processed: 0, stats };

  // Fetch expedientes en bulk para enriquecer metadata
  const expIds = Array.from(new Set(pending.map((d) => d.expediente_id)));
  const { data: exps } = await supa
    .from('sil_expedientes')
    .select('id, numero, comision, estado, fecha_presentacion')
    .in('id', expIds);
  const expMap = new Map<number, Expediente>();
  for (const e of (exps ?? []) as Expediente[]) expMap.set(e.id, e);

  console.log(`[embed] pass: ${pending.length} docs to embed`);
  for (const doc of pending) {
    await processDoc(doc, expMap.get(doc.expediente_id) ?? null, stats);
    if ((stats.docs_embedded + stats.errors) % 10 === 0) {
      console.log(
        `[embed] progress: docs=${stats.docs_embedded} chunks=${stats.chunks_created}` +
        ` errs=${stats.errors} skip=${stats.skipped_no_text + stats.skipped_no_chunks}`,
      );
    }
  }
  return { processed: pending.length, stats };
}

async function main() {
  console.log(`[embed] start. model=${EMBED_MODEL}/${EMBED_DIM}d max_per_pass=${MAX_DOCS_PER_RUN} one_shot=${ONE_SHOT}`);

  let totalDocs = 0;
  let totalChunks = 0;
  let totalErrors = 0;
  while (true) {
    const t0 = Date.now();
    const { processed, stats } = await passOnce();
    const dur = Math.round((Date.now() - t0) / 1000);
    totalDocs += stats.docs_embedded;
    totalChunks += stats.chunks_created;
    totalErrors += stats.errors;
    console.log(
      `[embed] pass DONE in ${dur}s — processed=${processed} embedded=${stats.docs_embedded}` +
      ` chunks=${stats.chunks_created} errors=${stats.errors}` +
      ` skipped=${stats.skipped_no_text + stats.skipped_no_chunks}` +
      ` | TOTAL: docs=${totalDocs} chunks=${totalChunks} errs=${totalErrors}`,
    );

    if (ONE_SHOT) break;
    if (processed === 0) {
      // No hay pendientes — espera y vuelve a chequear
      console.log(`[embed] sin pendientes, sleep ${POLL_INTERVAL_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  console.log(`[embed] DONE — total docs=${totalDocs} chunks=${totalChunks} errors=${totalErrors}`);
}

main().catch((e) => { console.error('[embed] fatal', e); process.exit(1); });
