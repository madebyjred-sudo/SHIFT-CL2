/**
 * SIL data access from the BFF — read paths used by Cerebro tools.
 *
 * Three flavors:
 *   1. searchExpedientes(query) — full-text search over sil_expedientes
 *      (Spanish tsvector index). Cheap, instant. No embeddings needed.
 *   2. getExpedienteById(num)   — direct lookup with attached docs.
 *   3. searchSilCorpus(query)   — RAG over legislative_chunks where
 *      source_type starts with 'sil_'. Pulls the embedding from Vertex
 *      and reuses match_chunks RPC (filter not yet exposed; we filter in
 *      memory with a small over-fetch).
 *
 * Live fallback (`fetchExpedienteLive`) lives in silWebFormsClient — call
 * it only when the DB miss is fresh (worker not yet caught up).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withRetry, withTimeout } from './resilience.js';
import { embedQuery } from './embeddings.js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set (silClient)');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

const SUPA_TIMEOUT_MS = 5_000;

export interface SilExpedienteRow {
  id: number;
  numero: string;
  titulo: string | null;
  proponente: string | null;
  comision: string | null;
  fecha_presentacion: string | null;
  estado: string | null;
  tipo: string | null;
  legislatura: string | null;
  url_detalle: string;
}

export interface SilExpedienteFull extends SilExpedienteRow {
  documentos: SilDocumentoRow[];
}

export interface SilDocumentoRow {
  id: string;
  expediente_id: number;
  tipo: string;
  titulo: string | null;
  fecha: string | null;
  source_url: string;
  status: string;
  text_chars: number | null;
  /** gs://bucket/path — set once process-sil-docs has mirrored the original. */
  gcs_path: string | null;
}

/** Lightweight chunk hit from legislative_chunks for SIL-sourced rows. */
export interface SilChunkHit {
  chunk_id: string;
  source_type: string;                  // 'sil_expediente' | 'sil_dictamen' | …
  source_ref: string;                   // human readable, e.g. "Expediente 22.293"
  content: string;
  similarity: number;
  fecha: string | null;
  comision: string | null;
  tipo: string | null;
  expediente_numero: string | null;
  url_detalle: string | null;
}

// ─── Full-text search over expedientes ────────────────────────────────

/**
 * Spanish tsvector keyword search. Use for "what's the latest expediente
 * about minería" type queries — cheaper than RAG and the title carries
 * enough signal for most metadata-style questions.
 *
 * Returns top-K rows ordered by ts_rank. Pass `comision` or year filters
 * for tighter scopes.
 */
export async function searchExpedientes(args: {
  query: string;
  k?: number;
  comision?: string;
  fecha_from?: string;
  fecha_to?: string;
}): Promise<SilExpedienteRow[]> {
  const k = Math.min(Math.max(args.k ?? 10, 1), 50);

  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          // Use Postgres `websearch_to_tsquery` for natural language input.
          // Supabase exposes this via .textSearch with config 'spanish'.
          let q = supa()
            .from('sil_expedientes')
            .select('id, numero, titulo, proponente, comision, fecha_presentacion, estado, tipo, legislatura, url_detalle')
            .textSearch(
              'titulo_proponente_tsv',  // virtual: see migration index
              args.query,
              { type: 'websearch', config: 'spanish' },
            )
            .limit(k)
            .abortSignal(signal);
          if (args.comision) q = q.eq('comision', args.comision);
          if (args.fecha_from) q = q.gte('fecha_presentacion', args.fecha_from);
          if (args.fecha_to) q = q.lte('fecha_presentacion', args.fecha_to);
          const { data, error } = await q;
          if (error) {
            // textSearch on a non-tsvector column will fail. Fall back to ilike on titulo.
            const fb = await supa()
              .from('sil_expedientes')
              .select('id, numero, titulo, proponente, comision, fecha_presentacion, estado, tipo, legislatura, url_detalle')
              .ilike('titulo', `%${args.query}%`)
              .limit(k);
            if (fb.error) throw new Error(fb.error.message);
            return (fb.data ?? []) as SilExpedienteRow[];
          }
          return (data ?? []) as SilExpedienteRow[];
        },
        { ms: SUPA_TIMEOUT_MS, label: 'sil:search_expedientes' },
      ),
    { attempts: 2, baseDelayMs: 250, label: 'sil:search_expedientes' },
  );
}

// ─── Direct expediente lookup ─────────────────────────────────────────

/**
 * Pull a single expediente plus its attached documents. Used when Lexa/Atlas
 * have already identified an expediente (via search) and need the full
 * structure for analysis. Returns null when not in DB.
 */
export async function getExpedienteById(numero: number): Promise<SilExpedienteFull | null> {
  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const { data: exp, error: e1 } = await supa()
            .from('sil_expedientes')
            .select('id, numero, titulo, proponente, comision, fecha_presentacion, estado, tipo, legislatura, url_detalle')
            .eq('id', numero)
            .abortSignal(signal)
            .maybeSingle();
          if (e1) throw new Error(e1.message);
          if (!exp) return null;

          const { data: docs, error: e2 } = await supa()
            .from('sil_documentos')
            .select('id, expediente_id, tipo, titulo, fecha, source_url, status, text_chars, gcs_path')
            .eq('expediente_id', numero)
            .order('fecha', { ascending: false, nullsFirst: false })
            .abortSignal(signal);
          if (e2) throw new Error(e2.message);

          return { ...(exp as SilExpedienteRow), documentos: (docs ?? []) as SilDocumentoRow[] };
        },
        { ms: SUPA_TIMEOUT_MS, label: 'sil:get_expediente' },
      ),
    { attempts: 2, baseDelayMs: 250, label: 'sil:get_expediente' },
  );
}

// ─── Semantic RAG over the SIL corpus ─────────────────────────────────

/**
 * Embedding-based retrieval. Used when the user's question is open-ended
 * ("how has Costa Rica handled X?", "what was decided about Y?") and a
 * keyword title match wouldn't catch the right expediente.
 *
 * Strategy: pull top 2*K from match_chunks then filter to SIL sources only
 * (until match_chunks gains a source_type filter param in 0006).
 */
export async function searchSilCorpus(args: {
  query: string;
  k?: number;
}): Promise<SilChunkHit[]> {
  const k = Math.min(Math.max(args.k ?? 6, 1), 20);
  const queryEmbedding = await embedQuery(args.query);

  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const { data, error } = await supa()
            .rpc('match_chunks', {
              query_embedding: queryEmbedding,
              match_count: k * 2,
              filter_session_id: null,
              filter_comision: null,
              filter_fecha_from: null,
              filter_fecha_to: null,
            })
            .abortSignal(signal);
          if (error) throw new Error(`match_chunks: ${error.message}`);
          const hits = (data ?? []) as Array<SilChunkHit & { source_type?: string }>;
          // Until 0006 adds the source_type filter to the RPC, drop non-SIL
          // hits in memory. Over-fetched 2x to compensate.
          return hits
            .filter((h) => typeof h.source_type === 'string' && h.source_type.startsWith('sil_'))
            .slice(0, k);
        },
        { ms: 8_000, label: 'sil:search_corpus' },
      ),
    { attempts: 2, baseDelayMs: 300, label: 'sil:search_corpus' },
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

// ─── Reglamento de la Asamblea (procedural knowledge layer) ───────────

export interface ReglamentoHit {
  chunk_id: string;
  articulo_numero: number | null;
  articulo_titulo: string | null;
  articulo_full_title: string;
  content: string;
  similarity: number;
  url: string | null;
}

/**
 * Semantic search over the indexed Reglamento de la Asamblea Legislativa
 * de Costa Rica. Each chunk in the table corresponds to one full article
 * (e.g. "Artículo 113.- Presentación del proyecto"). When Lexa receives a
 * procedural question ("¿cuál es el plazo para dictamen?", "¿cómo se
 * tramita una moción de fondo?"), this is the tool to call.
 *
 * Uses match_chunks_v2 (LEFT JOIN — works for chunks without session_id).
 * Falls through gracefully to an empty array if the v2 RPC isn't applied
 * yet (migration 0007), so the chat doesn't crash on a fresh deploy.
 */
export async function searchReglamento(args: {
  query: string;
  k?: number;
}): Promise<ReglamentoHit[]> {
  const k = Math.min(Math.max(args.k ?? 5, 1), 15);
  const queryEmbedding = await embedQuery(args.query);

  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const { data, error } = await supa()
            .rpc('match_chunks_v2', {
              query_embedding: queryEmbedding,
              match_count: k * 2, // overfetch slightly to allow ref filtering
              filter_session_id: null,
              filter_source_type: null, // accept either 'reglamento' or 'metadata'
              filter_source_ref_prefix: 'Reglamento Asamblea',
            })
            .abortSignal(signal);
          if (error) {
            // Graceful fallback: if migration 0007 isn't applied yet the
            // v2 function is missing. Don't crash the chat — return empty
            // and warn-log. Operator sees this in /health/deep eventually.
            if (error.message.includes('match_chunks_v2') || error.code === '42883') {
              console.warn('[searchReglamento] match_chunks_v2 not found — apply migration 0007. Returning empty.');
              return [] as ReglamentoHit[];
            }
            throw new Error(`match_chunks_v2: ${error.message}`);
          }
          const hits = (data ?? []) as Array<{
            chunk_id: string;
            source_type?: string;
            source_ref?: string;
            content: string;
            similarity: number;
            metadata?: Record<string, unknown> | null;
          }>;
          return hits.slice(0, k).map((h) => {
            const md = (h.metadata ?? {}) as Record<string, unknown>;
            return {
              chunk_id: h.chunk_id,
              articulo_numero: typeof md.articulo_numero === 'number' ? md.articulo_numero : null,
              articulo_titulo: typeof md.articulo_titulo === 'string' ? md.articulo_titulo : null,
              articulo_full_title:
                typeof md.articulo_full_title === 'string'
                  ? md.articulo_full_title
                  : (h.source_ref ?? 'Reglamento'),
              content: h.content,
              similarity: h.similarity,
              url: typeof md.url === 'string' ? md.url : null,
            };
          });
        },
        { ms: 8_000, label: 'reglamento:search' },
      ),
    { attempts: 2, baseDelayMs: 250, label: 'reglamento:search' },
  );
}

export function renderReglamentoForLlm(hits: ReglamentoHit[]): string {
  if (hits.length === 0) return '(sin coincidencias en el Reglamento)';
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] ${h.articulo_full_title} (similaridad ${(h.similarity * 100).toFixed(0)}%)\n${h.content}`,
    )
    .join('\n\n---\n\n');
}

/**
 * Render a list of expedientes as a markdown bullet list for the LLM
 * (compact, citation-friendly). Each line includes the canonical SIL URL
 * so the model can decide whether to surface it.
 */
export function renderExpedientesForLlm(rows: SilExpedienteRow[]): string {
  if (rows.length === 0) return '(sin resultados en SIL)';
  return rows
    .map((r, i) => {
      const fecha = r.fecha_presentacion ?? 's/f';
      const titulo = r.titulo ?? '(sin título)';
      const proponente = r.proponente ?? 's/proponente';
      return `[${i + 1}] Exp. ${r.numero} (${fecha}) — ${titulo}\n    Proponente: ${proponente} · Comisión: ${r.comision ?? '—'} · Estado: ${r.estado ?? '—'}\n    ${r.url_detalle}`;
    })
    .join('\n\n');
}

export function renderExpedienteFullForLlm(exp: SilExpedienteFull): string {
  const head = `Expediente ${exp.numero} — ${exp.titulo ?? '(sin título)'}\n`
    + `Fecha: ${exp.fecha_presentacion ?? '—'} · Estado: ${exp.estado ?? '—'} · Tipo: ${exp.tipo ?? '—'}\n`
    + `Proponente: ${exp.proponente ?? '—'} · Comisión: ${exp.comision ?? '—'}\n`
    + `URL: ${exp.url_detalle}\n`;
  if (exp.documentos.length === 0) return head + '\n(sin documentos adjuntos en DB)';
  const docs = exp.documentos
    .map((d, i) => `  [${i + 1}] ${d.tipo}: ${d.titulo ?? '(s/título)'} ${d.fecha ?? ''} — ${d.source_url}`)
    .join('\n');
  return `${head}\nDocumentos:\n${docs}`;
}
