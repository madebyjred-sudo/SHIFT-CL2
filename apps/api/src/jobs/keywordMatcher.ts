/**
 * keywordMatcher.ts
 *
 * Cron job: cada 30 min recorre los watches `entity_type='tema'` y matchea
 * (ILIKE) la keyword (entity_id) contra varias fuentes recientes del corpus.
 * Cuando hay match, emite `centinela_eventos` con `event_type='keyword_match'`.
 *
 * Por qué ILIKE y no embeddings:
 *   - Las keywords de un consultor son específicas y suelen ser sustantivos
 *     concretos ("PANI", "recurso hídrico"). La búsqueda exacta es lo que
 *     él espera — no quiere "PANI" devuelva mociones sobre "PANI" pero
 *     tampoco sobre conceptos relacionados que no usen la palabra.
 *   - Más simple y rápido. Si más adelante hace falta semántica, se agrega
 *     un segundo matcher (`keywordSemanticMatcher`).
 *
 * Fuentes que recorre (todas con filtro temporal últimos 7 días):
 *   1. sessions.metadata.resumen — resumen ejecutivo de plenarios y comisiones
 *   2. sil_expedientes — título de expedientes nuevos
 *   3. sil_mociones — asunto de mociones recientes
 *   4. agenda_legislativa — expediente_titulo + contexto_extracto
 *
 * Idempotencia: dedup_key cubre (event_type, keyword, source, source_id).
 * Re-correr el cron no duplica eventos.
 *
 * IMPORTANTE — keyword vs entity_id:
 *   El entity_id en watchlist suele ser un slug ("recurso_hidrico"), pero
 *   metadata.label trae el texto humano ("Recurso hídrico · agua"). Para
 *   matchear usamos label si está, fallback al entity_id reemplazando _ por
 *   espacio.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../services/logger.js';

const LOOKBACK_DAYS = 7;
const MAX_RESULTS_PER_KEYWORD_PER_SOURCE = 10;

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for keywordMatcher');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

export interface KeywordMatcherResult {
  watches_processed: number;
  keywords_unique: number;
  matches_inserted: number;
  matches_skipped_dup: number;
  errors: string[];
  duration_ms: number;
}

interface WatchRow {
  user_id: string;
  entity_id: string;
  metadata: Record<string, unknown> | null;
  lista_id: string | null;
}

/**
 * Genera términos de búsqueda desde el entity_id y la metadata. Un watch
 * con entity_id='recurso_hidrico' y metadata.label='Recurso hídrico · agua'
 * genera ['recurso hidrico', 'recurso hídrico', 'agua'].
 */
function buildSearchTerms(w: WatchRow): string[] {
  const out = new Set<string>();
  // Slug → espacio (caso típico: "recurso_hidrico" → "recurso hidrico")
  const fromId = w.entity_id.replace(/_/g, ' ').trim();
  if (fromId) out.add(fromId);

  const label = (w.metadata?.label as string | undefined) ?? '';
  // El label puede tener múltiples términos separados por · o coma.
  // Ejemplo: "Recurso hídrico · agua" → ['recurso hídrico', 'agua']
  for (const part of label.split(/[·,;|]/)) {
    const p = part.trim();
    if (p.length >= 3) out.add(p);
  }
  return [...out];
}

/**
 * Construye un dedup_key estable para un match.
 *   keyword_match:<keyword_slug>:<source>:<source_id>
 */
function dedupKey(keyword: string, source: string, sourceId: string): string {
  const slug = keyword.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 60);
  return `keyword_match:${slug}:${source}:${sourceId}`;
}

export async function runKeywordMatcher(): Promise<KeywordMatcherResult> {
  const start = Date.now();
  const s = supa();
  const errors: string[] = [];
  let matches_inserted = 0;
  let matches_skipped_dup = 0;

  // 1. Cargar TODOS los watches `entity_type='tema'`.
  const { data: watches, error: wErr } = await s
    .from('centinela_watchlist')
    .select('user_id, entity_id, metadata, lista_id')
    .eq('entity_type', 'tema');

  if (wErr) {
    return {
      watches_processed: 0,
      keywords_unique: 0,
      matches_inserted: 0,
      matches_skipped_dup: 0,
      errors: [`load_watches: ${wErr.message}`],
      duration_ms: Date.now() - start,
    };
  }

  const rows = (watches ?? []) as WatchRow[];
  if (rows.length === 0) {
    return {
      watches_processed: 0,
      keywords_unique: 0,
      matches_inserted: 0,
      matches_skipped_dup: 0,
      errors: [],
      duration_ms: Date.now() - start,
    };
  }

  // 2. Por cada watch, construir términos de búsqueda + matchear fuentes.
  const lookbackIso = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const lookbackDate = lookbackIso.slice(0, 10);
  const uniqueKeywords = new Set<string>();

  for (const w of rows) {
    const terms = buildSearchTerms(w);
    for (const t of terms) uniqueKeywords.add(t.toLowerCase());

    for (const term of terms) {
      // ── 2.1 sessions.metadata.resumen.ejecutivo / puntos_clave / acuerdos
      try {
        const { data: sess } = await s
          .from('sessions')
          .select('id, fecha, tipo, comision, metadata')
          .gte('fecha', lookbackDate)
          .eq('status', 'indexed')
          .limit(MAX_RESULTS_PER_KEYWORD_PER_SOURCE);

        for (const row of sess ?? []) {
          const meta = (row as { metadata?: Record<string, unknown> }).metadata ?? {};
          const resumen = (meta.resumen ?? {}) as Record<string, unknown>;
          const haystack = [
            (resumen.ejecutivo as string | undefined) ?? '',
            ...((resumen.puntos_clave as string[] | undefined) ?? []),
            ...((resumen.acuerdos as string[] | undefined) ?? []),
          ]
            .join(' ')
            .toLowerCase();
          if (haystack.includes(term.toLowerCase())) {
            const r = row as { id: string; fecha: string | null; tipo: string | null; comision: string | null };
            const inserted = await insertMatch(s, {
              user_id: w.user_id,
              keyword: term,
              source: 'session',
              source_id: r.id,
              expediente_id: null,
              payload: {
                keyword: term,
                entity_id: w.entity_id,
                lista_id: w.lista_id,
                session_id: r.id,
                fecha: r.fecha,
                tipo: r.tipo,
                comision: r.comision,
                excerpt: ((resumen.ejecutivo as string | undefined) ?? '').slice(0, 240),
              },
            });
            if (inserted === 'inserted') matches_inserted++;
            else if (inserted === 'duplicate') matches_skipped_dup++;
          }
        }
      } catch (e) {
        errors.push(`session_match[${term}]: ${(e as Error).message}`);
      }

      // ── 2.2 sil_expedientes — título nuevos últimos 7d
      try {
        const { data: exps } = await s
          .from('sil_expedientes')
          .select('id, numero, titulo, fecha_presentacion, comision')
          .gte('scraped_at', lookbackIso)
          .ilike('titulo', `%${term}%`)
          .limit(MAX_RESULTS_PER_KEYWORD_PER_SOURCE);

        for (const row of exps ?? []) {
          const r = row as { id: number; numero: string; titulo: string | null; fecha_presentacion: string | null; comision: string | null };
          const inserted = await insertMatch(s, {
            user_id: w.user_id,
            keyword: term,
            source: 'sil_expediente',
            source_id: String(r.id),
            expediente_id: r.id,
            payload: {
              keyword: term,
              entity_id: w.entity_id,
              lista_id: w.lista_id,
              expediente_numero: r.numero,
              titulo: r.titulo,
              fecha_presentacion: r.fecha_presentacion,
              comision: r.comision,
            },
          });
          if (inserted === 'inserted') matches_inserted++;
          else if (inserted === 'duplicate') matches_skipped_dup++;
        }
      } catch (e) {
        errors.push(`expediente_match[${term}]: ${(e as Error).message}`);
      }

      // ── 2.3 sil_mociones — asunto últimas 24h
      try {
        const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString();
        const { data: mocs } = await s
          .from('sil_mociones')
          .select('id, expediente_numero, asunto, scraped_at')
          .gte('scraped_at', yesterdayIso)
          .ilike('asunto', `%${term}%`)
          .limit(MAX_RESULTS_PER_KEYWORD_PER_SOURCE);

        for (const row of mocs ?? []) {
          const r = row as { id: string; expediente_numero: string | null; asunto: string | null; scraped_at: string };
          const inserted = await insertMatch(s, {
            user_id: w.user_id,
            keyword: term,
            source: 'mocion',
            source_id: r.id,
            expediente_id: null,
            payload: {
              keyword: term,
              entity_id: w.entity_id,
              lista_id: w.lista_id,
              mocion_id: r.id,
              expediente_numero: r.expediente_numero,
              asunto: (r.asunto ?? '').slice(0, 240),
            },
          });
          if (inserted === 'inserted') matches_inserted++;
          else if (inserted === 'duplicate') matches_skipped_dup++;
        }
      } catch (e) {
        errors.push(`mocion_match[${term}]: ${(e as Error).message}`);
      }
    }
  }

  const result: KeywordMatcherResult = {
    watches_processed: rows.length,
    keywords_unique: uniqueKeywords.size,
    matches_inserted,
    matches_skipped_dup,
    errors,
    duration_ms: Date.now() - start,
  };

  logger.info('keyword_matcher_complete', {
    watches: rows.length,
    keywords: uniqueKeywords.size,
    inserted: matches_inserted,
    dup: matches_skipped_dup,
    errors_count: errors.length,
    ms: result.duration_ms,
  });

  return result;
}

async function insertMatch(
  s: SupabaseClient,
  m: {
    user_id: string;
    keyword: string;
    source: 'session' | 'sil_expediente' | 'mocion' | 'agenda';
    source_id: string;
    expediente_id: number | null;
    payload: Record<string, unknown>;
  },
): Promise<'inserted' | 'duplicate' | 'error'> {
  const dk = dedupKey(m.keyword, m.source, m.source_id);
  const { error } = await s.from('centinela_eventos').insert({
    event_type: 'keyword_match',
    priority: 'medium',
    expediente_id: m.expediente_id,
    payload: m.payload,
    source_url: null,
    detected_at: new Date().toISOString(),
    materia: m.keyword,
    dedup_key: dk,
    user_id: m.user_id,
  });
  if (error) {
    // Unique violation = duplicado idempotente
    if (error.code === '23505' || /duplicate/i.test(error.message)) {
      return 'duplicate';
    }
    return 'error';
  }
  return 'inserted';
}
