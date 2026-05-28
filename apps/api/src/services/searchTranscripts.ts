import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { embedQuery } from './embeddings.js';
import { withRetry, withTimeout } from './resilience.js';
import { extractExpedienteMentions } from './voteExtractor.js';

/**
 * Per-chunk metadata jsonb. Shape varies by source_type:
 *   - transcript chunks → { start, end, word_count, title }
 *     `start` and `end` are seconds (numeric) into the plenary video,
 *     allowing the LLM to cite an exact HH:MM:SS timecode rather than
 *     just "según la sesión #84".
 *   - sil_* chunks → { sil_doc_id, sil_doc_tipo, sil_doc_titulo,
 *     sil_doc_fecha, expediente_numero, ... } — see process-sil-docs.ts.
 *   - reglamento chunks → { articulo_numero, articulo_titulo,
 *     articulo_full_title, ... } — see index-reglamento.ts.
 *
 * Kept loose on purpose: callers cherry-pick the fields they need and
 * absent ones are tolerated. The tool dispatcher in openRouterClient.ts
 * is the single place that turns this into citation strings.
 */
export interface ChunkMetadata {
  // transcript
  start?: number;
  end?: number;
  word_count?: number;
  title?: string;
  // transcript — Wave 4 #4 (2026-05-26): expediente que se estaba debatiendo
  // en el momento de la votación, asignado heurísticamente vía voteExtractor.
  // null/undefined si el chunk no es de votación o no había expediente
  // mencionado en chunks previos. Permite que Lexa cite "votación del expediente
  // X (sesión Y · HH:MM)" aún cuando el N° no aparezca literal en el chunk.
  votando_expediente?: string;
  // sil_*
  sil_doc_id?: string;
  sil_doc_tipo?: string;
  sil_doc_titulo?: string;
  sil_doc_fecha?: string;
  sil_doc_url?: string;
  expediente_numero?: string;
  expediente_titulo?: string;
  expediente_url?: string;
  comision?: string;
  estado?: string;
  fecha_presentacion?: string;
  // reglamento
  reglamento?: boolean;
  articulo_numero?: number | string;
  articulo_titulo?: string;
  articulo_full_title?: string;
  url?: string;
  // catch-all for forward compatibility
  [key: string]: unknown;
}

export interface ChunkHit {
  chunk_id: string;
  session_id: string;
  source_ref: string;
  chunk_index: number;
  content: string;
  similarity: number;
  fecha: string;
  comision: string;
  tipo: string;
  video_url: string | null;
  transcript_url: string | null;
  // Exposed by match_chunks_v3. Carries per-chunk timecodes for transcripts
  // (start/end in seconds) so the LLM can cite a precise HH:MM:SS pointer
  // into the plenary video — not "según la sesión #84" pero "según la
  // sesión #84 · 01:23:45".
  metadata?: ChunkMetadata | null;
  // Surfaced by match_chunks_v3 for transcript chunks; null for SIL/Reglamento.
  // null-safe access at the dispatcher; helps the renderer decide which
  // citation flavor to emit (timecode vs article-number vs doc-type).
  source_type?: string | null;
}

export interface SearchArgs {
  query: string;
  top_k?: number;
  comision?: string;
  fecha_from?: string;
  fecha_to?: string;
  /** Número de expediente para pre-fetch exacto en chunks de votación */
  expediente_numero?: string;
}

let _supa: SupabaseClient | null = null;

function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

/**
 * Embed query via Vertex AI then call match_chunks_v3 RPC. Returns top-K
 * chunks WITH per-chunk metadata (jsonb) so the dispatcher can emit precise
 * citations:
 *   - transcript → [Sesión #N · HH:MM:SS] from metadata.start
 *   - sil_*      → [Exp. N · tipo_doc · fecha] from metadata.expediente_numero etc.
 *   - reglamento → [Art. N] from metadata.articulo_numero
 *
 * Failure mode: if match_chunks_v3 isn't yet applied to the target DB
 * (migration 0026), we fall back to match_chunks (no metadata) so the
 * tool keeps working with degraded citations. This preserves staging vs
 * prod migration drift without breaking the demo flow.
 */
export async function searchTranscripts(args: SearchArgs): Promise<ChunkHit[]> {
  // 2026-05-26: subido de 5→12. Lawyer test L9 ("qué votación en plenaria
  // 21 may") demostró que con k=5 los chunks con "56 votos a favor" se
  // pierden en queries genéricas. Plenarias tienen ~1000 chunks; k=12
  // da mejor cobertura sin saturar el context.
  const topK = args.top_k ?? 12;

  // 2026-05-26 Wave 4 #7 follow-up: exact-lookup fallback para queries que
  // mencionan expediente N° específico. El HNSW index pgvector falla en
  // queries amplias (>20s sin filter de fecha) — pero los chunks sintéticos
  // de votación tienen `metadata.votando_expediente` set y un partial index
  // sobre ese campo permite lookup directo en <100ms.
  //
  // Cuando la query menciona "expediente 24.998" (o similar), pre-fetch
  // los chunks asociados y los retornamos primero, antes del semantic search.
  // Si la semántica retorna en tiempo, mergeamos. Si timeoutea, al menos
  // tenemos los exact hits.
  //
  // Garantía: el usuario recibe respuesta correcta para el caso más común
  // (preguntar por un expediente específico), incluso si el HNSW falla.
  const mentionedExpedientes = extractExpedienteMentions(args.query);
  const exactHits: ChunkHit[] = [];
  // Pre-fetch exacto por expediente: ya sea detectado en query o pasado explícitamente
  const expedientesToPrefetch = new Set<string>(mentionedExpedientes);
  if (args.expediente_numero) {
    expedientesToPrefetch.add(args.expediente_numero);
  }
  if (expedientesToPrefetch.size > 0) {
    for (const exp of expedientesToPrefetch) {
      const { data, error } = await supa()
        .from('legislative_chunks')
        .select('id, session_id, source_ref, source_type, chunk_index, content, metadata')
        .eq('source_type', 'transcript')
        .eq('metadata->>votando_expediente', exp)
        .limit(3);
      if (error) {
        // Log but don't throw — degraded mode acceptable.
        continue;
      }
      for (const row of (data ?? []) as Array<{
        id: string;
        session_id: string;
        source_ref: string;
        source_type: string;
        chunk_index: number;
        content: string;
        metadata: ChunkMetadata | null;
      }>) {
        exactHits.push({
          chunk_id: row.id,
          session_id: row.session_id,
          source_ref: row.source_ref,
          chunk_index: row.chunk_index,
          content: row.content,
          similarity: 1.0, // Exact match — máxima prioridad.
          fecha: (row.metadata?.fecha as string) ?? '',
          comision: (row.metadata?.comision as string) ?? '',
          tipo: (row.metadata?.tipo as string) ?? '',
          video_url: null,
          transcript_url: null,
          metadata: row.metadata,
          source_type: row.source_type,
        });
      }
    }
  }

  const queryEmbedding = await embedQuery(args.query);

  // 2026-05-26 audit asesor bug #6 simétrico: Lexa puede pasar comision/fecha
  // como string vacío "" en lugar de omitirlos. El RPC con filter="" matchea
  // ningún row (text) o crashea (date). Normalizamos defensivamente igual que
  // searchExpedientes. Ver decisions/2026-05-26-audit-asesor-7-bugs-en-cascada.md
  const cleanComision = (args.comision ?? '').trim() || null;
  const cleanFechaFrom = (args.fecha_from ?? '').trim() || null;
  const cleanFechaTo = (args.fecha_to ?? '').trim() || null;

  const semanticHits = await withRetry(
    () =>
      withTimeout(
        async (signal) => {
          // 2026-05-28: filter by source_type='transcript' so transcripts only
          // compete against transcripts in the ranking. Without this filter,
          // SIL/reglamento chunks (denser metadata, higher similarity scores)
          // drown out transcript chunks for conversational queries.
          const v3 = await supa()
            .rpc('match_chunks_v3', {
              query_embedding: queryEmbedding,
              match_count: topK,
              filter_session_id: null,
              filter_comision: cleanComision,
              filter_fecha_from: cleanFechaFrom,
              filter_fecha_to: cleanFechaTo,
              filter_source_type: 'transcript',
              filter_source_ref_prefix: null,
            })
            .abortSignal(signal);
          if (!v3.error) {
            return (v3.data ?? []) as ChunkHit[];
          }
          // PostgREST emits 42883 (function does not exist) before 0026 is
          // applied. Anything else is a real failure; rethrow.
          const msg = v3.error.message ?? '';
          const code = (v3.error as { code?: string }).code ?? '';
          if (!(code === '42883' || /does not exist/i.test(msg))) {
            throw new Error(`match_chunks_v3 rpc: ${msg}`);
          }

          // Fallback path — no metadata, no source_type filter. Degraded but
          // keeps search working if the RPC is temporarily unavailable.
          console.warn('[searchTranscripts] match_chunks_v3 unavailable (42883) — falling back to match_chunks v1 without source_type filter. Transcripts may be drowned by SIL/reglamento hits.');
          const v1 = await supa()
            .rpc('match_chunks', {
              query_embedding: queryEmbedding,
              match_count: topK,
              filter_session_id: null,
              filter_comision: cleanComision,
              filter_fecha_from: cleanFechaFrom,
              filter_fecha_to: cleanFechaTo,
            })
            .abortSignal(signal);
          if (v1.error) throw new Error(`match_chunks fallback: ${v1.error.message}`);
          return (v1.data ?? []) as ChunkHit[];
        },
        // 2026-05-26 Wave 4 #7: subido de 8s → 20s. El HNSW index pgvector
        // sobre 800k+ chunks toma ~10s en queries amplias (sin session_id
        // filter). 8s causaba aborts en queries legítimas y Lexa devolvía
        // "no encontré". 20s deja margen para el 95-percentil. Sentry alerta
        // si excede consistentemente — entonces investigar REINDEX o
        // particionar el index por source_type.
        { ms: 20_000, label: 'supabase:match_chunks_v3' },
      ),
    { attempts: 2, baseDelayMs: 300, label: 'supabase:match_chunks_v3' },
  ).catch((err) => {
    // Si el semantic search falla (timeout, etc), seguimos con los exact hits.
    // No queremos que el user vea "no encontré" cuando tenemos chunks exact-match.
    if (exactHits.length > 0) return [] as ChunkHit[];
    throw err; // Re-throw si no hay nada de fallback.
  });

  // Merge: exact hits primero (similarity=1.0), luego semantic, dedup por chunk_id.
  const seenIds = new Set(exactHits.map((h) => h.chunk_id));
  const merged = [
    ...exactHits,
    ...semanticHits.filter((h) => !seenIds.has(h.chunk_id)),
  ];
  return merged.slice(0, topK);
}
