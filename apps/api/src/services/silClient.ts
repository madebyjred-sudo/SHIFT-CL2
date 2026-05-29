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
import { normalizeSilEstado } from './silEstadoNormalizer.js';
import { logger } from './logger.js';

/**
 * Convierte `sil_expedientes.estado` (string crudo del SIL) a texto coherente
 * para el LLM. El SIL guarda ahí la "ubicación física actual" que puede ser:
 *   - "ARCHIVO" / "PLENARIO" → estados canonical
 *   - Nombre de comisión "JUVENTUD (ÁREA II)" → ubicación física, NO estado
 *
 * Para el LLM mostramos:
 *   - "plenario" / "archivo" → texto explícito
 *   - "en_comision" → omitir (la sección "Comisión física actual" ya lo dice)
 *   - null → "sin estado registrado"
 *
 * Wave 4 Tier 2 C audit (2026-05-26).
 */
function renderEstadoForLlm(raw: string | null | undefined): string | null {
  const canonical = normalizeSilEstado(raw);
  if (canonical === 'plenario') return '🏛️ En debate plenario';
  if (canonical === 'archivo') return '📦 Archivado';
  if (canonical === 'en_comision') return null; // El campo "Comisión" lo cubre.
  return null;
}
import { embedQuery } from './embeddings.js';
import { rerankItems } from './rerankClient.js';
import { extractDateRangeFromQuery } from './yearExtractor.js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set (silClient)');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// 2026-05-26 audit asesor bug 5b: subido de 5s → 20s.
// search_sil_expedientes_by_text RPC desde Cloud Run a veces toma 6-10s
// (postgres tokenization + GIN scan + ranking sobre 21k rows). Timeout
// de 5s abortaba silenciosamente retornando []. Consistencia con
// sil:search_corpus que ya estaba en 20s.
const SUPA_TIMEOUT_MS = 20_000;

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

  // 2026-05-26 Wave 4 #1: year hard-filter.
  // Si el caller (Lexa) no pasó fecha_from/to explícitos, intentamos
  // extraer el año mencionado en la query y aplicarlo como hard-filter.
  // Esto cierra el gap audit-D4: "iniciativas de 2018 sobre seguridad"
  // antes devolvía expedientes de cualquier año ranqueados; ahora
  // limita el WHERE a expedientes con fecha_presentacion en 2018.
  // Los filtros explícitos del caller siempre ganan sobre la extracción.
  // 2026-05-26 audit asesor bugs 4 + 6: Lexa a veces pasa string vacío en
  // los filtros opcionales en lugar de omitirlos. PostgREST + el RPC
  // tratan "" como filtro real:
  //   - fecha_from="" → cast date "" → "invalid input syntax for type date"
  //   - comision=""   → match e.comision = '' → 0 rows (ninguna comisión
  //                     real es string vacío)
  // Normalizamos los 3 filtros opcionales: trim + empty → null.
  const cleanFechaFrom = (args.fecha_from ?? '').trim() || null;
  const cleanFechaTo = (args.fecha_to ?? '').trim() || null;
  const cleanComision = (args.comision ?? '').trim() || null;
  const yearRange = (!cleanFechaFrom && !cleanFechaTo)
    ? extractDateRangeFromQuery(args.query)
    : {};
  const effectiveFechaFrom = cleanFechaFrom ?? yearRange.fecha_from ?? null;
  const effectiveFechaTo = cleanFechaTo ?? yearRange.fecha_to ?? null;

  // Detección de "número de expediente". Lexa suele pasar el query con
  // el número crudo ("23.511", "24.018", "Exp. 25.262"). El full-text
  // en español stemming NO matchea esos tokens — los devuelve 0 hits y
  // Lexa reporta "no encontré expedientes". Antes del path full-text,
  // intentamos un lookup directo por número/id. Si encuentra, devolvemos
  // ese row (lo importante es el match). Si no, caemos al full-text
  // normal para queries de texto natural.
  const numTokens = args.query.match(/\d[\d.,\s-]*\d|\d/g) ?? [];
  if (numTokens.length > 0) {
    const ids: number[] = [];
    const numeros: string[] = [];
    for (const tok of numTokens) {
      const digits = tok.replace(/\D/g, '');
      if (digits.length >= 4 && digits.length <= 6) {
        const n = Number(digits);
        if (Number.isInteger(n) && n > 0) ids.push(n);
        // Formato canónico SIL: NN.NNN o N.NNN (números con punto cada 3 dígitos)
        if (digits.length === 5) numeros.push(`${digits[0]}${digits[1]}.${digits.slice(2)}`);
        else if (digits.length === 6) numeros.push(`${digits.slice(0, 3)}.${digits.slice(3)}`);
        else if (digits.length === 4) numeros.push(`${digits[0]}.${digits.slice(1)}`);
      }
    }
    if (ids.length > 0 || numeros.length > 0) {
      try {
        const orParts: string[] = [];
        if (ids.length > 0) orParts.push(`id.in.(${ids.join(',')})`);
        if (numeros.length > 0) orParts.push(`numero.in.(${numeros.map((n) => `"${n}"`).join(',')})`);
        const lookup = await withTimeout(
          async (signal) => {
            const res = await supa()
              .from('sil_expedientes')
              .select('id, numero, titulo, proponente, comision, fecha_presentacion, estado, tipo, legislatura, url_detalle, extras')
              .or(orParts.join(','))
              .limit(k)
              .abortSignal(signal);
            return res;
          },
          { ms: SUPA_TIMEOUT_MS, label: 'sil:search_expedientes:lookup_by_number' },
        );
        if (!lookup.error && lookup.data && lookup.data.length > 0) {
          return lookup.data as SilExpedienteRow[];
        }
      } catch {
        // Lookup directo fall — continuar con full-text
      }
    }
  }

  // 2026-05-26 audit asesor bug 6: refactor a fetch directo a PostgREST.
  // Antes usaba supa.rpc() pero retornaba 0 hits desde Cloud Run aunque
  // el RPC funciona desde fetch directo + SQL psql + Supabase JS local.
  // Causa raíz no identificada (singleton stale? abortSignal issue?
  // schema cache?), pero descartamos al cliente JS como fuente al hacer
  // fetch directo. Si esto retorna 0 también, el problema es server-side.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error('Supabase env not set for searchExpedientes');
  }

  return withRetry(
    () =>
      withTimeout(
        async (signal) => {
          const t0 = Date.now();
          const reqBody = {
            query_text: args.query,
            match_limit: k,
            filter_comision: cleanComision,
            filter_fecha_from: effectiveFechaFrom ?? null,
            filter_fecha_to: effectiveFechaTo ?? null,
          };
          const bodyStr = JSON.stringify(reqBody);
          // Log preview del body + key info para diagnóstico bug #6.
          logger.info('sil_search_expedientes_req', {
            query: args.query,
            body_preview: bodyStr.slice(0, 200),
            body_len: bodyStr.length,
            key_prefix: serviceKey.slice(0, 10),
            url_host: new URL(supabaseUrl).host,
          });
          const res = await fetch(
            `${supabaseUrl}/rest/v1/rpc/search_sil_expedientes_by_text`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`,
                'Accept-Profile': 'public',
                'Content-Profile': 'public',
              },
              body: bodyStr,
              signal,
            },
          );
          const ms = Date.now() - t0;
          const rawText = await res.text();
          if (!res.ok) {
            logger.warn('sil_search_expedientes_http_error', {
              query: args.query,
              status: res.status,
              raw: rawText.slice(0, 300),
              ms,
            });
            throw new Error(`search_sil_expedientes_by_text HTTP ${res.status}: ${rawText.slice(0, 200)}`);
          }
          let data: Array<SilExpedienteRow & { rank?: number }>;
          try {
            data = JSON.parse(rawText) as Array<SilExpedienteRow & { rank?: number }>;
          } catch (parseErr) {
            logger.warn('sil_search_expedientes_parse_error', {
              query: args.query,
              raw: rawText.slice(0, 300),
              err: (parseErr as Error).message,
              ms,
            });
            throw new Error(`search_sil_expedientes_by_text parse: ${(parseErr as Error).message}`);
          }
          logger.info('sil_search_expedientes_ok', {
            query: args.query,
            limit: k,
            comision: cleanComision,
            fecha_from: effectiveFechaFrom ?? null,
            fecha_to: effectiveFechaTo ?? null,
            hits: data.length,
            top_numeros: data.slice(0, 5).map((h) => h.numero),
            raw_len: rawText.length,
            ms,
          });
          // RPC retorna un campo extra `rank` que la interface no espera.
          // Lo pelamos antes de retornar para no contaminar el shape.
          return data.map(({ rank: _rank, ...row }) => row as SilExpedienteRow);
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
/**
 * Normaliza un número de expediente al formato canónico SIL (NN.NNN).
 * Acepta: "24009", "24.009", "Exp. 24,009", "24-009", etc.
 * Devuelve: "24.009" (5 dígitos → 2+punto+3) o el string limpio si no aplica.
 */
export function normalizeExpedienteNumero(input: string | number | undefined): string | null {
  if (input === undefined || input === null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  // Extraer solo dígitos
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 5) {
    return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  }
  if (digits.length === 6) {
    return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  }
  if (digits.length === 4) {
    return `${digits[0]}.${digits.slice(1)}`;
  }
  // Si ya tiene punto y es válido, devolverlo limpio
  const withDot = raw.replace(/[^\d.]/g, '');
  if (/^\d{1,3}\.\d{3}$/.test(withDot)) return withDot;
  return digits.length > 0 ? digits : null;
}

export async function searchSilCorpus(args: {
  query: string;
  k?: number;
  expediente_numero?: string;
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
          const normalizedNum = normalizeExpedienteNumero(args.expediente_numero);
          const filterPrefix = normalizedNum ? `Exp. ${normalizedNum}` : null;
          const { data, error } = await supa()
            .rpc('match_chunks_hybrid', {
              query_embedding: queryEmbedding,
              query_text: args.query,
              match_count: overFetch,
              filter_session_id: null,
              filter_source_type: null,
              filter_source_ref_prefix: filterPrefix,
              rrf_k: 60,
            })
            .abortSignal(signal);
          if (error) {
            // 42883 = function does not exist. Caller may not have applied 0009.
            if (error.code === '42883' || error.message.includes('match_chunks_hybrid')) {
              return await fallbackDenseOnly(queryEmbedding, overFetch, filterPrefix, signal);
            }
            throw new Error(`match_chunks_hybrid: ${error.message}`);
          }
          const hits = (data ?? []) as Array<SilChunkHit & { source_type?: string }>;
          return hits.filter((h) => typeof h.source_type === 'string' && h.source_type.startsWith('sil_'));
        },
        // 2026-05-26 Wave 4 #7 follow-up: 8s → 20s. Igual que searchTranscripts,
        // HNSW pgvector p95 ~10s en queries amplias. Doctrina cliente:
        // resultado correcto > rapidez; bajamos después de validar.
        { ms: 120_000, label: 'sil:search_corpus' },
      ),
    { attempts: 1, baseDelayMs: 300, label: 'sil:search_corpus' },
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
  filterPrefix: string | null,
  signal: AbortSignal,
): Promise<SilChunkHit[]> {
  console.warn('[searchSilCorpus] 0009 not applied — falling back to dense-only via match_chunks_v2');
  const { data, error } = await supa()
    .rpc('match_chunks_v2', {
      query_embedding: queryEmbedding,
      match_count: k * 3,
      filter_session_id: null,
      filter_source_type: null,
      filter_source_ref_prefix: filterPrefix,
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
  // 2026-05-26: subido de 5→12 para mejor recall en queries procedurales.
  // Lawyer tests L1/L4/L5 demostraron que k=5 traía 5 artículos con
  // keyword overlap pero ninguno relevante. Con k=12 el LLM tiene más
  // candidatos para filtrar en el Pass.
  const k = Math.min(Math.max(args.k ?? 12, 1), 20);
  const overFetch = Math.min(30, Math.max(k * 4, 15));
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
              filter_source_type: 'reglamento',
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
                filter_source_type: 'reglamento',
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
        // 2026-05-26 Wave 4 #7 follow-up: 8s → 20s. Mismo razonamiento que sil:search_corpus.
        { ms: 20_000, label: 'reglamento:search' },
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
      // ESTATUS FORMAL — leído de extras jsonb. La doctrina del YAML
      // de Lexa (lexa.yaml) dice que esto es lo PRIMERO que el LLM debe
      // ver: el campo `estado` solo dice qué comisión tiene el papel
      // físico HOY, NO si es ley. La verdad sobre "¿es ley?" está
      // en extras.numero_ley.
      const e = (r.extras ?? {}) as SilExtras;
      let estatusFormal = '';
      if (e.numero_ley) {
        const gaceta = e.numero_gaceta ? ` · Gaceta N° ${e.numero_gaceta}` : '';
        const pub = e.fecha_publicacion ? ` · publicada ${e.fecha_publicacion}` : '';
        estatusFormal = `\n    ✅ ES LEY · N° ${e.numero_ley}${gaceta}${pub}`;
      } else if (e.numero_archivado) {
        estatusFormal = `\n    📦 ARCHIVADO · N° ${e.numero_archivado}`;
      } else if (e.numero_acuerdo) {
        estatusFormal = `\n    📋 ACUERDO LEGISLATIVO N° ${e.numero_acuerdo}`;
      } else if (e.fecha_dispensa) {
        estatusFormal = `\n    ⚡ DISPENSA DE TRÁMITE · ${e.fecha_dispensa}`;
      } else {
        estatusFormal = `\n    🟡 EN TRÁMITE`;
      }
      const alcance = e.numero_alcance ? `\n    🔁 Tiene Alcance N° ${e.numero_alcance}` : '';
      // Wave 4 Tier 2 C: omitir el campo "estado" cuando es nombre de comisión
      // — la sección "Comisión" ya lo muestra. Solo mostrar cuando es canonical
      // (plenario / archivo).
      const estadoRender = renderEstadoForLlm(r.estado);
      const estadoStr = estadoRender ? ` · ${estadoRender}` : '';
      return `[${i + 1}] Exp. ${r.numero} (${fecha}) — ${titulo}${estatusFormal}${alcance}\n    Proponente: ${proponente} · Comisión: ${r.comision ?? '—'}${estadoStr}\n    ${r.url_detalle}`;
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
  // Wave 4 Tier 2 C: si `exp.estado` es nombre de comisión, NO lo repetimos
  // acá (la sección "Comisión física actual" ya lo dice). Solo mostramos
  // valores canonical (plenario/archivo) o el literal si es algo distinto.
  if (status.length === 0) {
    const estadoRender = renderEstadoForLlm(exp.estado);
    if (estadoRender) {
      status.push(`🟡 EN TRÁMITE · todavía NO es ley ni fue archivado. ${estadoRender}.`);
    } else {
      status.push(`🟡 EN TRÁMITE · todavía NO es ley ni fue archivado (en comisión técnica — ver abajo).`);
    }
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
  // Pedido 16k del cliente (Donovan, 19:00):
  //   "Los textos sustitutivos, estos informes de primer día de mociones, todo
  //    esto uno tiene acceso directamente desde el SIL, igual aquí como texto
  //    sustitutivo te da la te lo descarga..."
  //
  // Doctrina: cuando un expediente tiene `texto_sustitutivo`, ese es el texto
  // VIGENTE del proyecto. El texto original quedó superseded. Lexa debe
  // basarse en el sustitutivo para responder "qué dice el proyecto", citar
  // articulado, etc. Por eso separamos los documentos en dos bloques + le
  // damos una instrucción explícita al LLM sobre cuál usar primero.

  // Prioridad por tipo. Más bajo = más prioritario (se lista primero).
  // texto_sustitutivo + dictamen_mayoria son el "estado vigente" del proyecto.
  const TIPO_PRIORIDAD: Record<string, number> = {
    texto_sustitutivo: 0,
    dictamen_mayoria: 1,
    dictamen_minoria: 2,
    mocion_177: 3,
    mocion_137_segundo_dia: 4,
    mocion_138: 4,
    mocion_137_primer_dia: 5,
    informe_subcomision: 6,
    informe_servicios_tecnicos: 7,
  };

  let docsSection = '';
  if (exp.documentos.length === 0) {
    docsSection = '\n(sin documentos adjuntos indexados en la base)';
  } else {
    const sorted = [...exp.documentos].sort((a, b) => {
      const pa = TIPO_PRIORIDAD[a.tipo] ?? 99;
      const pb = TIPO_PRIORIDAD[b.tipo] ?? 99;
      if (pa !== pb) return pa - pb;
      // dentro del mismo tipo, el más reciente arriba
      const fa = a.fecha ?? '';
      const fb = b.fecha ?? '';
      return fb.localeCompare(fa);
    });

    const sustitutivos = sorted.filter((d) => d.tipo === 'texto_sustitutivo');
    const dictamenesMayoria = sorted.filter((d) => d.tipo === 'dictamen_mayoria');

    const lines: string[] = [];
    if (sustitutivos.length > 0 || dictamenesMayoria.length > 0) {
      lines.push('Documentos (orden de prioridad — usar PRIMERO los de la cima):');
      lines.push(
        '  IMPORTANTE: cuando exista un "texto_sustitutivo" o un "dictamen_mayoria",',
      );
      lines.push(
        '  ese ES el texto vigente del proyecto. Cualquier referencia al articulado o al',
      );
      lines.push(
        '  contenido del proyecto debe basarse en el sustitutivo más reciente, no en el',
      );
      lines.push(
        '  texto original. El original quedó SUPERSEDED en el momento que la comisión',
      );
      lines.push(
        '  aprobó el sustitutivo. Citá fecha de sustitutivo cuando el cliente pregunte.',
      );
    } else {
      lines.push('Documentos:');
    }

    for (let i = 0; i < sorted.length; i++) {
      const d = sorted[i];
      // 2026-05-26: render explícito para que Lexa surface dictámenes
      // correctamente. L7 (24.018) demostró que con "dictamen_mayoria"
      // crudo, Lexa dijo "no encontré dictamen final" porque no asoció
      // los términos. Usamos etiquetas descriptivas + equivalencias.
      const prefix = d.tipo === 'texto_sustitutivo'
        ? '★ TEXTO VIGENTE (sustitutivo, este es el articulado actual)'
        : d.tipo === 'dictamen_mayoria'
        ? '◆ DICTAMEN FINAL (de mayoría, este es el dictamen que llegó a votación)'
        : d.tipo === 'dictamen_minoria'
        ? '◇ DICTAMEN MINORÍA'
        : d.tipo === 'redaccion_final'
        ? '✎ REDACCIÓN FINAL'
        : '  ';
      lines.push(`  ${prefix}\n     [${i + 1}] ${d.titulo ?? '(s/título)'} ${d.fecha ?? ''} — ${d.source_url}`);
    }

    docsSection = '\n' + lines.join('\n');
  }

  return `ESTATUS FORMAL:\n${status.map((s) => '  ' + s).join('\n')}\n\n${head}${historial}${docsSection}`;
}

// ─── RAL Comentado — search con interpretaciones oficiales ────────────────────
//
// Track F, Sprint 1 — 2026-05-14.
// Extiende el conocimiento procedimental de Lexa del "RAL plano" al
// "RAL Comentado con jurisprudencia interna de la Asamblea".
//
// El tool search_ral_comentado (SEARCH_RAL_COMENTADO_TOOL en openRouterClient)
// llama a esta función. El resultado incluye:
//   - Texto normativo del artículo o inciso.
//   - Interpretaciones oficiales adheridas (resoluciones Presidencia, Sala IV).
//   - Cita textual a la fuente (acta plenaria, voto, etc.).
//   - URL al PDF de origen.
//
// Diferencia con searchReglamento:
//   searchReglamento          → búsqueda semántica sobre legislative_chunks
//                               (el RAL plano indexado como chunks de embedding).
//   searchRalComentado        → lookup directo en ral_articulos + JOIN a
//                               ral_interpretaciones (tables de la migración 0035).
//                               Más preciso para lookup por número de artículo.
//                               Cubre interpretaciones que no están en los chunks.
//
// Cascada: intentar búsqueda en ral_articulos primero. Si la tabla no existe
// (migración 0035 no aplicada), caer de vuelta a searchReglamento.

export interface RalComentadoHit {
  articulo_numero: string;
  articulo_inciso: string | null;
  capitulo: string | null;
  texto_normativo: string;
  edicion: string;
  source_pdf: string | null;
  source_pagina: number | null;
  vigente: boolean;
  interpretaciones: RalInterpretacionHit[];
}

export interface RalInterpretacionHit {
  texto: string;
  fuente_tipo: string;
  fuente_cita: string | null;
  fuente_fecha: string | null;
  fuente_pdf: string | null;
}

/**
 * Busca artículos del RAL Comentado, devolviendo texto normativo +
 * interpretaciones oficiales adheridas.
 *
 * @param args.articulo_numero  Si se especifica, lookup directo por número
 *                               de artículo (ej: '137'). Más preciso.
 * @param args.inciso           Inciso específico dentro del artículo (ej: '3').
 *                               Solo se usa si articulo_numero también se pasa.
 * @param args.query            Si no hay articulo_numero, búsqueda semántica
 *                               vía searchReglamento (fallback).
 * @param args.k                Número máximo de artículos a retornar (default 5).
 *
 * @returns Array de hits con artículo + interpretaciones.
 *          Vacío si la migración 0035 no está aplicada (graceful fallback).
 */
export async function searchRalComentado(args: {
  articulo_numero?: string;
  inciso?: string;
  query?: string;
  k?: number;
}): Promise<RalComentadoHit[]> {
  const k = Math.min(Math.max(args.k ?? 5, 1), 15);
  const db = supa();

  try {
    let articulosQuery = db
      .from('ral_articulos')
      .select('id, numero, inciso, capitulo, texto_normativo, edicion, source_pdf, source_pagina, vigente')
      .eq('vigente', true)
      .limit(k);

    if (args.articulo_numero) {
      // Lookup directo por número de artículo.
      articulosQuery = articulosQuery.eq('numero', args.articulo_numero);
      if (args.inciso) {
        articulosQuery = articulosQuery.eq('inciso', args.inciso);
      }
    } else if (args.query) {
      // Sin número específico: búsqueda por texto normativo con ilike.
      // Para búsqueda semántica completa usar searchReglamento (que usa embeddings).
      // Acá cubrimos el caso de "busca el artículo sobre mociones de fondo".
      const keywords = args.query.toLowerCase().split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
      for (const kw of keywords) {
        articulosQuery = articulosQuery.ilike('texto_normativo', `%${kw}%`);
      }
    } else {
      // Sin query ni número → retornar primeros artículos vigentes.
      articulosQuery = articulosQuery.order('numero', { ascending: true });
    }

    const { data: articulos, error: artErr } = await articulosQuery;

    if (artErr) {
      if (artErr.code === '42P01' || artErr.message.includes('ral_articulos')) {
        // Tabla no existe → migración 0035 no aplicada. Fallback gracioso.
        console.warn('[searchRalComentado] ral_articulos table missing — apply migration 0035. Returning empty.');
        return [];
      }
      throw new Error(`searchRalComentado ral_articulos: ${artErr.message}`);
    }

    if (!articulos || articulos.length === 0) return [];

    // Para cada artículo, cargar sus interpretaciones.
    const articuloIds = articulos.map((a: { id: string }) => a.id);
    const { data: interps, error: interpErr } = await db
      .from('ral_interpretaciones')
      .select('articulo_id, texto_interpretacion, fuente_tipo, fuente_cita, fuente_fecha, fuente_pdf, vigente')
      .in('articulo_id', articuloIds)
      .eq('vigente', true);

    if (interpErr && interpErr.code !== '42P01') {
      // Log warn pero no fallar — mejor devolver artículo sin interpretaciones
      // que no devolver nada.
      console.warn('[searchRalComentado] Failed to load interpretaciones:', interpErr.message);
    }

    const interpsByArticuloId = new Map<string, RalInterpretacionHit[]>();
    for (const interp of interps ?? []) {
      const list = interpsByArticuloId.get(interp.articulo_id) ?? [];
      list.push({
        texto: interp.texto_interpretacion,
        fuente_tipo: interp.fuente_tipo,
        fuente_cita: interp.fuente_cita ?? null,
        fuente_fecha: interp.fuente_fecha ?? null,
        fuente_pdf: interp.fuente_pdf ?? null,
      });
      interpsByArticuloId.set(interp.articulo_id, list);
    }

    return articulos.map((a: {
      id: string;
      numero: string;
      inciso: string | null;
      capitulo: string | null;
      texto_normativo: string;
      edicion: string;
      source_pdf: string | null;
      source_pagina: number | null;
      vigente: boolean;
    }) => ({
      articulo_numero: a.numero,
      articulo_inciso: a.inciso,
      capitulo: a.capitulo,
      texto_normativo: a.texto_normativo,
      edicion: a.edicion,
      source_pdf: a.source_pdf,
      source_pagina: a.source_pagina,
      vigente: a.vigente,
      interpretaciones: interpsByArticuloId.get(a.id) ?? [],
    }));
  } catch (err) {
    // Fallback gracioso — no romper el chat si la tabla no existe.
    console.warn('[searchRalComentado] error, returning empty:', (err as Error).message);
    return [];
  }
}

/**
 * Renderiza los resultados del RAL Comentado para el LLM.
 *
 * Formato:
 *   **Art. 137 — Mociones de fondo** (RAL Comentado 5ta Edición, pág. 142)
 *   Capítulo: ...
 *   Texto: ...
 *
 *   Interpretaciones oficiales:
 *   [1] RESOLUCIÓN DE LA PRESIDENCIA
 *       Cita: Acta Sesión Plenaria Ordinaria 091 del 01-11-2012, pág. 44
 *       Texto: ...
 *
 *   [Fuente PDF: https://...]
 */
export function renderRalComentadoForLlm(hits: RalComentadoHit[]): string {
  if (hits.length === 0) return '(sin resultados en el RAL Comentado)';

  return hits.map((h) => {
    const artRef = h.articulo_inciso
      ? `Art. ${h.articulo_numero}, inciso ${h.articulo_inciso}`
      : `Art. ${h.articulo_numero}`;
    const pageRef = h.source_pagina ? `, pág. ${h.source_pagina}` : '';
    const header = `**${artRef}** (${h.edicion}${pageRef})`;
    const capLine = h.capitulo ? `Capítulo: ${h.capitulo}\n` : '';
    const textoLine = `Texto normativo:\n${h.texto_normativo}`;

    let interpsSection = '';
    if (h.interpretaciones.length > 0) {
      const TIPO_LABEL: Record<string, string> = {
        resolucion_presidencia: 'RESOLUCIÓN DE LA PRESIDENCIA',
        sentencia_sala_constitucional: 'SENTENCIA SALA CONSTITUCIONAL',
        criterio_servicios_tecnicos: 'CRITERIO SERVICIOS TÉCNICOS',
        otro: 'OTRA FUENTE',
      };
      const interpLines = h.interpretaciones.map((interp, i) => {
        const label = TIPO_LABEL[interp.fuente_tipo] ?? interp.fuente_tipo.toUpperCase();
        const citaLine = interp.fuente_cita ? `    Cita: ${interp.fuente_cita}\n` : '';
        const fechaLine = interp.fuente_fecha ? `    Fecha: ${interp.fuente_fecha}\n` : '';
        const pdfLine = interp.fuente_pdf ? `    PDF: ${interp.fuente_pdf}\n` : '';
        return `  [${i + 1}] ${label}\n${citaLine}${fechaLine}${pdfLine}    Texto: ${interp.texto.slice(0, 600)}`;
      }).join('\n\n');
      interpsSection = `\n\nInterpretaciones oficiales:\n${interpLines}`;
    } else {
      interpsSection = '\n\n(Sin interpretaciones oficiales indexadas para este artículo)';
    }

    const pdfRef = h.source_pdf ? `\n\n[Fuente PDF: ${h.source_pdf}]` : '';

    return `${header}\n${capLine}${textoLine}${interpsSection}${pdfRef}`;
  }).join('\n\n═══════════════════════════════════\n\n');
}

// ─── Constitución Política + LOAL ─────────────────────────────────────
//
// Wave 4 #2 (2026-05-26).
// Lawyer audit reveló gaps: Lexa no podía responder sobre tratados
// internacionales, elección magistrados Sala IV, plazo resello tras veto,
// inmunidad parlamentaria, juramentación. Ese conocimiento NO vive ni en
// el Reglamento Asamblea ni en el RAL Comentado — vive en la Constitución
// y en la Ley Orgánica del Poder Legislativo (LOAL).
//
// El job `apps/api/src/jobs/ingestConstitucionLoal.ts` carga ambos cuerpos
// en `legislative_chunks` con source_type='constitucion' o 'loal'.
// Esta función es el read-path: query → embedding → match_chunks_hybrid
// con filtro `source_type IN ('constitucion','loal')`.

export interface ConstitucionLoalHit {
  chunk_id: string;
  source_type: 'constitucion' | 'loal';
  /** Número del artículo. String para preservar "121 bis" si aparece. */
  articulo_numero: string | null;
  /** Variante entera del número (útil para ordenar). */
  articulo_numero_int: number | null;
  /** Título o capítulo más cercano (ej. "TÍTULO IV - DERECHOS Y GARANTÍAS"). */
  titulo_seccion: string | null;
  /** Nombre completo del cuerpo normativo. */
  doc: string;
  /** Texto completo del artículo (incluyendo header). */
  content: string;
  /** Score (rrf o dense similarity, según path). */
  similarity: number;
  /** URL oficial del PDF/HTML cuando está indexada. */
  url: string | null;
}

/**
 * Búsqueda híbrida sobre la Constitución Política CR (197 arts) y la
 * Ley Orgánica del Poder Legislativo (~100 arts).
 *
 * Misma estrategia que `searchReglamento`:
 *   - Path A (preferido): match_chunks_hybrid (migración 0009) con
 *     filter_source_type=null + filtro post-hoc por source_type ∈
 *     {constitucion, loal}.
 *   - Path B (fallback): match_chunks_v2 dense-only cuando 0009 no está.
 *
 * El RPC no soporta `filter_source_type IN (...)` (solo single value)
 * así que pedimos sin filtro y filtramos los hits en memoria. Es seguro
 * porque overFetch = max(k*5, 15) y la fracción de chunks de estos
 * cuerpos sobre los 825k totales es <0.04% — pero en el ranking semántico
 * dominan cuando la query es procedural-constitucional.
 *
 * Reranking opcional vía cross-encoder (rerankItems). Si VOYAGE_API_KEY
 * no está set, retorna identidad — mismo contrato que searchReglamento.
 */
export async function searchConstitucionLoal(args: {
  query: string;
  k?: number;
}): Promise<ConstitucionLoalHit[]> {
  const k = Math.min(Math.max(args.k ?? 8, 1), 15);
  // Optional: 2026-05-26 — overfetch elevado a max(k*8, 24) porque la
  // Constitución tiene artículos chiquitos (avg ~500 chars) y la búsqueda
  // semántica empieza con 30-40 candidatos heterogéneos del corpus
  // completo (transcripts, SIL, etc.) antes del filtro por source_type.
  // FYI: si esto resulta caro en latencia, bajar a k*5 y registrar miss-rate.
  const overFetch = Math.min(60, Math.max(k * 8, 24));
  const queryEmbedding = await embedQuery(args.query);

  const candidates = await withRetry(
    () =>
      withTimeout(
        async (signal) => {
          let raw: unknown[] | null = null;
          let usedFallback = false;

          // Path A: hybrid.
          const hybrid = await supa()
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

          if (hybrid.error) {
            if (hybrid.error.code === '42883' || hybrid.error.message.includes('match_chunks_hybrid')) {
              usedFallback = true;
            } else {
              throw new Error(`match_chunks_hybrid: ${hybrid.error.message}`);
            }
          } else {
            raw = hybrid.data as unknown[];
          }

          // Path B: v2 dense fallback.
          if (usedFallback) {
            const v2 = await supa()
              .rpc('match_chunks_v2', {
                query_embedding: queryEmbedding,
                match_count: overFetch,
                filter_session_id: null,
                filter_source_type: null,
                filter_source_ref_prefix: null,
              })
              .abortSignal(signal);
            if (v2.error) {
              if (v2.error.code === '42883' || v2.error.message.includes('match_chunks_v2')) {
                console.warn('[searchConstitucionLoal] hybrid + v2 missing — apply 0007/0009. Returning empty.');
                return [] as ConstitucionLoalHit[];
              }
              throw new Error(`match_chunks_v2: ${v2.error.message}`);
            }
            raw = v2.data as unknown[];
          }

          type RawHit = {
            chunk_id: string;
            source_type?: string;
            source_ref?: string;
            content: string;
            similarity?: number;
            dense_similarity?: number;
            rrf_score?: number;
            metadata?: Record<string, unknown> | null;
          };
          const hits = (raw ?? []) as RawHit[];
          const filtered = hits.filter(
            (h) => h.source_type === 'constitucion' || h.source_type === 'loal',
          );
          return filtered.map<ConstitucionLoalHit>((h) => {
            const md = (h.metadata ?? {}) as Record<string, unknown>;
            return {
              chunk_id: h.chunk_id,
              source_type: h.source_type as 'constitucion' | 'loal',
              articulo_numero:
                typeof md.articulo_numero === 'string' ? md.articulo_numero : null,
              articulo_numero_int:
                typeof md.articulo_numero_int === 'number' ? md.articulo_numero_int : null,
              titulo_seccion:
                typeof md.titulo_seccion === 'string' ? md.titulo_seccion : null,
              doc:
                typeof md.doc === 'string'
                  ? md.doc
                  : h.source_ref ?? (h.source_type === 'constitucion' ? 'Constitución Política' : 'LOAL'),
              content: h.content,
              similarity: h.rrf_score ?? h.dense_similarity ?? h.similarity ?? 0,
              url: typeof md.url === 'string' ? md.url : null,
            };
          });
        },
        // 2026-05-26 Wave 4 #7 follow-up: 8s → 20s. Mismo razonamiento que sil:search_corpus.
        { ms: 20_000, label: 'constitucion_loal:search' },
      ),
    { attempts: 2, baseDelayMs: 250, label: 'constitucion_loal:search' },
  );

  if (candidates.length <= 1) return candidates.slice(0, k);
  // Rerank — same contract as searchReglamento (identity when no key).
  // The rerankItems helper accepts any object with `content`; safe.
  return rerankItems(args.query, candidates, k);
}

/**
 * Render para el LLM. Lexa cita inline con "[Art. N (Const)]" o
 * "[Art. N (LOAL)]" para que el lector distinga el cuerpo de origen.
 */
export function renderConstitucionLoalForLlm(hits: ConstitucionLoalHit[]): string {
  if (hits.length === 0) return '(sin coincidencias en la Constitución ni en la LOAL)';
  return hits
    .map((h, i) => {
      const tag = h.source_type === 'constitucion' ? 'Const' : 'LOAL';
      const artRef = h.articulo_numero ? `Art. ${h.articulo_numero}` : 'Artículo';
      const seccion = h.titulo_seccion ? ` · ${h.titulo_seccion}` : '';
      const sim = (h.similarity * 100).toFixed(0);
      return `[${i + 1}] ${artRef} (${tag})${seccion} — similaridad ${sim}%\n${h.content}`;
    })
    .join('\n\n---\n\n');
}
