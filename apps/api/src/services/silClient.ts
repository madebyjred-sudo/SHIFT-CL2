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
import { rerankItems } from './rerankClient.js';

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

/**
 * Datos paralelos al estado del expediente que el SIL guarda. Estos campos
 * son la fuente de verdad sobre HITOS FORMALES (no estado físico actual).
 * Un asesor legislativo experimentado los consulta antes que `estado`:
 *
 *   • numero_ley         — si NO null → expediente ES LEY publicada
 *   • numero_archivado   — si NO null → fue archivado (no avanzó)
 *   • fecha_publicacion  — fecha de publicación en La Gaceta
 *   • numero_gaceta      — número de Gaceta donde salió
 *   • fecha_dispensa     — fast-track legislativo (dispensa de trámite)
 *   • numero_acuerdo     — número de acuerdo legislativo (no ley)
 *   • numero_alcance     — alcance/modificación posterior
 *   • vencimiento_ordinario / cuatrienal — plazos legales para dictaminar
 *   • comisiones         — historial completo de pase entre comisiones
 *   • proponentes        — todos los co-firmantes (estado.proponente es solo el primero)
 */
export interface SilExtras {
  numero_ley?: number | null;
  numero_archivado?: number | null;
  fecha_publicacion?: string | null;
  numero_gaceta?: number | null;
  fecha_dispensa?: string | null;
  numero_acuerdo?: number | null;
  numero_alcance?: number | null;
  vencimiento_ordinario?: string | null;
  vencimiento_cuatrienal?: string | null;
  comisiones?: Array<{ fecha: string; organo: string }>;
  proponentes?: string[];
}

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
  extras?: SilExtras | null;
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
            .select('id, numero, titulo, proponente, comision, fecha_presentacion, estado, tipo, legislatura, url_detalle, extras')
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
 * Embedding-based retrieval over the SIL corpus + Reglamento + plenarias.
 *
 * Calls match_chunks_hybrid (migration 0009) which does Reciprocal Rank
 * Fusion of pgvector dense similarity AND Postgres ts_rank_cd over a
 * Spanish tsvector — captures both semantic queries ("traslado de
 * riesgos") and queries with rare tokens that don't survive embedding
 * ("Ley 6727", "Exp. 22.290", "ÁREA VIII", "CCSS").
 *
 * Falls back gracefully to match_chunks_v2 dense-only when 0009 isn't
 * applied yet (function-not-found error 42883). Final fallback to []
 * when the original match_chunks (v1) is the only one available.
 */
export async function searchSilCorpus(args: {
  query: string;
  k?: number;
}): Promise<SilChunkHit[]> {
  const k = Math.min(Math.max(args.k ?? 6, 1), 20);
  // Over-fetch for the reranker — give the cross-encoder N*5 candidates
  // (capped at 30) so it has material to re-order. The final returned
  // top-K is k.
  const overFetch = Math.min(30, Math.max(k * 5, 12));
  const queryEmbedding = await embedQuery(args.query);

  const candidates = await withRetry(
    () =>
      withTimeout(
        async (signal) => {
          // Path A: hybrid (0009 applied).
          const { data, error } = await supa()
            .rpc('match_chunks_hybrid', {
              query_embedding: queryEmbedding,
              query_text: args.query,
              match_count: overFetch,
              filter_session_id: null,
              filter_source_type: null,
              filter_source_ref_prefix: null,
              rrf_k: 60,
            })
            .abortSignal(signal);
          if (error) {
            // 42883 = function does not exist. Caller may not have applied 0009.
            if (error.code === '42883' || error.message.includes('match_chunks_hybrid')) {
              return await fallbackDenseOnly(queryEmbedding, overFetch, signal);
            }
            throw new Error(`match_chunks_hybrid: ${error.message}`);
          }
          const hits = (data ?? []) as Array<SilChunkHit & { source_type?: string }>;
          return hits.filter((h) => typeof h.source_type === 'string' && h.source_type.startsWith('sil_'));
        },
        { ms: 8_000, label: 'sil:search_corpus' },
      ),
    { attempts: 2, baseDelayMs: 300, label: 'sil:search_corpus' },
  );

  // Cross-encoder rerank — falls through to identity (top-K untouched)
  // when VOYAGE_API_KEY is missing, so this is safe to leave on by
  // default. Demo with the key set wins; demo without it doesn't break.
  if (candidates.length <= 1) return candidates.slice(0, k);
  return rerankItems(args.query, candidates, k);
}

async function fallbackDenseOnly(
  queryEmbedding: number[],
  k: number,
  signal: AbortSignal,
): Promise<SilChunkHit[]> {
  console.warn('[searchSilCorpus] 0009 not applied — falling back to dense-only via match_chunks_v2');
  const { data, error } = await supa()
    .rpc('match_chunks_v2', {
      query_embedding: queryEmbedding,
      match_count: k * 3,
      filter_session_id: null,
      filter_source_type: null,
      filter_source_ref_prefix: null,
    })
    .abortSignal(signal);
  if (error) {
    if (error.code === '42883' || error.message.includes('match_chunks_v2')) {
      console.warn('[searchSilCorpus] match_chunks_v2 also missing — apply migration 0007. Returning empty.');
      return [];
    }
    throw new Error(`match_chunks_v2 fallback: ${error.message}`);
  }
  const hits = (data ?? []) as Array<SilChunkHit & { source_type?: string }>;
  return hits
    .filter((h) => typeof h.source_type === 'string' && h.source_type.startsWith('sil_'))
    .slice(0, k);
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
  const overFetch = Math.min(20, Math.max(k * 4, 10));
  const queryEmbedding = await embedQuery(args.query);

  const candidates = await withRetry(
    () =>
      withTimeout(
        async (signal) => {
          // Path A: hybrid (preferred — handles "Art. 113", "moción 240"
          // exact matches better than dense alone).
          let data: unknown[] | null = null;
          let usedFallback = false;

          const hybrid = await supa()
            .rpc('match_chunks_hybrid', {
              query_embedding: queryEmbedding,
              query_text: args.query,
              match_count: overFetch,
              filter_session_id: null,
              filter_source_type: null,
              filter_source_ref_prefix: 'Reglamento Asamblea',
              rrf_k: 60,
            })
            .abortSignal(signal);

          if (hybrid.error) {
            if (hybrid.error.code === '42883' || hybrid.error.message.includes('match_chunks_hybrid')) {
              usedFallback = true;
            } else {
              throw new Error(`match_chunks_hybrid: ${hybrid.error.message}`);
            }
          } else {
            data = hybrid.data as unknown[];
          }

          // Path B: dense-only fallback when 0009 isn't applied yet.
          if (usedFallback) {
            const v2 = await supa()
              .rpc('match_chunks_v2', {
                query_embedding: queryEmbedding,
                match_count: overFetch,
                filter_session_id: null,
                filter_source_type: null,
                filter_source_ref_prefix: 'Reglamento Asamblea',
              })
              .abortSignal(signal);
            if (v2.error) {
              if (v2.error.code === '42883' || v2.error.message.includes('match_chunks_v2')) {
                console.warn('[searchReglamento] neither hybrid nor v2 RPC found — apply migrations 0007/0009. Returning empty.');
                return [] as ReglamentoHit[];
              }
              throw new Error(`match_chunks_v2: ${v2.error.message}`);
            }
            data = v2.data as unknown[];
          }

          const hits = (data ?? []) as Array<{
            chunk_id: string;
            source_type?: string;
            source_ref?: string;
            content: string;
            similarity?: number;       // v2 path
            dense_similarity?: number; // hybrid path
            rrf_score?: number;        // hybrid path
            metadata?: Record<string, unknown> | null;
          }>;
          return hits.map((h) => {
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
              similarity: h.dense_similarity ?? h.similarity ?? 0,
              url: typeof md.url === 'string' ? md.url : null,
            };
          });
        },
        { ms: 8_000, label: 'reglamento:search' },
      ),
    { attempts: 2, baseDelayMs: 250, label: 'reglamento:search' },
  );

  if (candidates.length <= 1) return candidates.slice(0, k);
  return rerankItems(args.query, candidates, k);
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

/**
 * Renderiza un expediente para el LLM. CRÍTICO: incluye una sección
 * "ESTATUS FORMAL" al frente que interpreta los campos de `extras` y dice
 * en lenguaje natural si el expediente ES LEY, fue ARCHIVADO, tiene
 * dispensa, o sigue en trámite. Sin esto el LLM responde mirando solo
 * `estado` (que es la comisión física actual) y se equivoca cuando un
 * expediente avanzó a ley pero el listing no lo refleja inmediato.
 *
 * Este renderer es la base de "conocimiento procedural legislativo" —
 * cualquier heurística nueva que aprendamos del cliente (Ronald, equipo
 * CL2) debe sumarse acá para que TODOS los agentes la usen.
 */
export function renderExpedienteFullForLlm(exp: SilExpedienteFull): string {
  const e = (exp.extras ?? {}) as SilExtras;

  // ── Sección 1: estatus formal (lo que un asesor mira primero) ───────
  const status: string[] = [];
  if (e.numero_ley) {
    status.push(`✅ ES LEY · publicada como Ley N° ${e.numero_ley}` +
      (e.fecha_publicacion ? ` el ${e.fecha_publicacion}` : '') +
      (e.numero_gaceta ? ` en La Gaceta N° ${e.numero_gaceta}` : ''));
  }
  if (e.numero_archivado) {
    status.push(`📦 ARCHIVADO · número de archivo ${e.numero_archivado} (no avanzó a ley)`);
  }
  if (e.fecha_dispensa) {
    status.push(`⚡ DISPENSA DE TRÁMITE · fecha ${e.fecha_dispensa} (fast-track, votado sin esperar comisión)`);
  }
  if (e.numero_acuerdo) {
    status.push(`📋 ACUERDO LEGISLATIVO N° ${e.numero_acuerdo} (acuerdo de cámara, NO ley)`);
  }
  if (e.numero_alcance) {
    status.push(`🔁 TIENE ALCANCE/MODIFICACIÓN N° ${e.numero_alcance} (la ley fue modificada después de publicarse)`);
  }

  // Vencimientos solo si NO es ley ni archivado (esos plazos ya no aplican)
  if (!e.numero_ley && !e.numero_archivado) {
    if (e.vencimiento_ordinario) {
      status.push(`⏳ Vencimiento plazo ordinario para dictamen: ${e.vencimiento_ordinario}`);
    }
    if (e.vencimiento_cuatrienal) {
      status.push(`⏳ Vencimiento plazo cuatrienal (caducidad legislativa): ${e.vencimiento_cuatrienal}`);
    }
  }

  // Si NADA de lo anterior aplica, declaramos el estatus en negativo
  // para que el LLM no asuma "es ley" por defecto.
  if (status.length === 0) {
    status.push(`🟡 EN TRÁMITE · todavía NO es ley ni fue archivado. Estado físico actual: ${exp.estado ?? 'sin estado'}.`);
  }

  // ── Sección 2: identificación ───────────────────────────────────────
  const head = `Expediente ${exp.numero} — ${exp.titulo ?? '(sin título)'}\n`
    + `Fecha presentación: ${exp.fecha_presentacion ?? '—'} · Tipo: ${exp.tipo ?? '—'}\n`
    + `Proponente principal: ${exp.proponente ?? '—'}\n`
    + (e.proponentes && e.proponentes.length > 1
      ? `Co-firmantes (total ${e.proponentes.length}): ${e.proponentes.slice(0, 5).join(', ')}${e.proponentes.length > 5 ? '…' : ''}\n`
      : '')
    + `Comisión física actual: ${exp.comision ?? '—'}\n`
    + `URL oficial: ${exp.url_detalle}\n`;

  // ── Sección 3: historial de pase entre comisiones (si hay) ──────────
  let historial = '';
  if (e.comisiones && e.comisiones.length > 0) {
    const pasos = e.comisiones.slice(-8); // últimos 8 pases
    historial = `\nHistorial de pase (últimos ${pasos.length}):\n`
      + pasos.map((c) => `  · ${c.fecha} → ${c.organo}`).join('\n')
      + '\n';
  }

  // ── Sección 4: documentos adjuntos ──────────────────────────────────
  let docsSection = '';
  if (exp.documentos.length === 0) {
    docsSection = '\n(sin documentos adjuntos indexados en la base)';
  } else {
    docsSection = '\nDocumentos:\n' + exp.documentos
      .map((d, i) => `  [${i + 1}] ${d.tipo}: ${d.titulo ?? '(s/título)'} ${d.fecha ?? ''} — ${d.source_url}`)
      .join('\n');
  }

  return `ESTATUS FORMAL:\n${status.map((s) => '  ' + s).join('\n')}\n\n${head}${historial}${docsSection}`;
}
