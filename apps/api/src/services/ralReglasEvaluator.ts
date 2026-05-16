/**
 * ralReglasEvaluator.ts — Filtro activo procedural del RAL.
 *
 * Sprint 3, Track Q (2026-05-16).
 *
 * WHY THIS EXISTS:
 *   El RAL plano + el RAL comentado responden "¿qué dice el artículo X?" —
 *   pero un consultor opera con preguntas operativas: "¿este expediente puede
 *   ir a primer debate hoy?" o "¿cuántas firmas necesito para reiterar esta
 *   moción?". Las REGLAS PROCEDURALES son criterios explícitos, no
 *   interpretaciones — entonces viven en `ral_reglas` (migración 0042) como
 *   datos estructurados, no como texto que el LLM tenga que destilar.
 *
 *   Doctrina LLM-vs-Algoritmo: este servicio NO usa el LLM. Tomamos el caso,
 *   matcheamos contra la tabla, y devolvemos las reglas más relevantes con su
 *   confidence. El LLM (Lexa) las recibe en la conversación y las usa para
 *   razonar sobre el caso concreto — esa parte sí es subjetiva.
 *
 * INTERFAZ:
 *   evaluateRalAplicacion(caso) → { reglas_aplicables, razonamiento }
 *
 *   Camino A — caso.articulos_pregunta populado:
 *     Lookup directo en ral_reglas usando el operador && sobre el array
 *     `articulos_relacionados` (GIN index). Confidence se calcula por
 *     intersection cardinality: cuántos de los artículos preguntados
 *     aparecen en la regla.
 *
 *   Camino B — solo caso.contexto:
 *     Fallback al embedding search reusando searchReglamento (que ya hace
 *     la búsqueda semántica sobre legislative_chunks). Cargamos las top-K
 *     reglas cuyos `articulos_relacionados` intersectan con los artículos
 *     que searchReglamento devolvió. Confidence proporcional a la similarity
 *     del chunk match.
 *
 *   Camino C — caso.expediente_numero sin artículos ni contexto:
 *     Heurística mínima — buscamos en `sil_expediente_tramite` el área
 *     procedural más probable (ej. "primer debate" → plenario, "audiencia"
 *     → audiencias) y devolvemos las reglas vigentes de esa área. Stub
 *     limpio para iterar — no se llama LLM.
 *
 * GRACIA EN ERRORES:
 *   - Tabla `ral_reglas` no existe (migración 0042 no aplicada) → devolvemos
 *     [] + warn al logger. NUNCA tirar; el chat no debe caer por esto.
 *   - Embedding falla → caemos a búsqueda por keywords en `descripcion`.
 *   - Supabase 5xx → devolvemos [] + warn.
 *
 * Source: Sprint 3 Track Q, 2026-05-16.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger.js';

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export interface CasoEvaluacion {
  /** Número del expediente al que aplica el caso. Opcional. Ej: '23.511'. */
  expediente?: string;

  /** Descripción del caso o pregunta del consultor (lenguaje natural). */
  contexto: string;

  /**
   * Artículos del RAL específicos a evaluar. Si está populado, salta al
   * Camino A (lookup directo por intersect en `articulos_relacionados`).
   * Strings sin "Art." — solo el número o número+letra. Ej: ['137', '138'].
   */
  articulos_pregunta?: string[];
}

export interface RalReglaMatch {
  /** UUID de la regla (id de la tabla). */
  id: string;
  /** snake_case unique slug. Ej: 'mocion_137_primer_dia_obligatoria'. */
  slug: string;
  /** Título corto declarativo de la regla. */
  titulo: string;
  /** Descripción detallada (es lo que Lexa lee para razonar). */
  descripcion: string;
  /** Área procedural enum cerrado. */
  area_procedural: string;
  /** Lógica declarativa {si, entonces}. */
  condiciones: unknown;
  /** Artículos del RAL relacionados. Ej: ['137']. */
  articulos_relacionados: string[];
  /** Texto libre o null. */
  excepciones: string | null;
  /** Array de ejemplos o null. */
  ejemplos: unknown;
  /** URL al PDF oficial. */
  fuente_pdf_url: string | null;
  /** Página dentro del PDF. */
  fuente_pagina: number | null;
  /**
   * Match confidence in [0, 1]. 1.0 = match exacto por artículo;
   * proporcional a |intersect| / |articulos_pregunta| en Camino A.
   * En Camino B se hereda de la similarity del embedding search.
   */
  confidence_match: number;
  /** Explicación breve de por qué la regla matcheó. Para debug + UX. */
  razon_evaluacion: string;
}

export interface EvaluacionResult {
  reglas_aplicables: RalReglaMatch[];
  /** Resumen del path utilizado y por qué. Para Lexa + observabilidad. */
  razonamiento: string;
}

// ─── Supabase client lazy ────────────────────────────────────────────────────

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not set (ralReglasEvaluator)');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── Constantes ──────────────────────────────────────────────────────────────

const TOP_K = 5;

/** Code postgres "relation does not exist" cuando la migración no se aplicó. */
const POSTGRES_RELATION_DOES_NOT_EXIST = '42P01';

// ─── Tipos internos del row ──────────────────────────────────────────────────

interface RalReglaRow {
  id: string;
  slug: string;
  titulo: string;
  descripcion: string;
  area_procedural: string;
  condiciones: unknown;
  articulos_relacionados: string[];
  excepciones: string | null;
  ejemplos: unknown;
  fuente_pdf_url: string | null;
  fuente_pagina: number | null;
  vigente: boolean;
}

// ─── Helpers privados ────────────────────────────────────────────────────────

/**
 * Normalize article numbers to canonical form. Removes "Art.", whitespace
 * and dots-as-separators ("Art. 137" / "art 137" / "137." / "137" → "137").
 */
function normalizeArticuloNumero(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^art\.?\s*/i, '')
    .replace(/^artículo\s*/i, '')
    .replace(/\.$/, '')
    .trim();
}

/** Computes |a ∩ b| (case-insensitive) for confidence scoring. */
function countIntersection(a: string[], b: string[]): number {
  const setB = new Set(b.map((x) => x.toLowerCase()));
  let hits = 0;
  for (const item of a) {
    if (setB.has(item.toLowerCase())) hits++;
  }
  return hits;
}

/**
 * Map a row to the public RalReglaMatch shape. Confidence is provided by the
 * caller; we don't compute it here because each path has different logic.
 */
function rowToMatch(
  row: RalReglaRow,
  confidence_match: number,
  razon_evaluacion: string,
): RalReglaMatch {
  return {
    id: row.id,
    slug: row.slug,
    titulo: row.titulo,
    descripcion: row.descripcion,
    area_procedural: row.area_procedural,
    condiciones: row.condiciones,
    articulos_relacionados: row.articulos_relacionados,
    excepciones: row.excepciones,
    ejemplos: row.ejemplos,
    fuente_pdf_url: row.fuente_pdf_url,
    fuente_pagina: row.fuente_pagina,
    confidence_match,
    razon_evaluacion,
  };
}

/**
 * Resolves whether an error indicates the table doesn't exist.
 * Different postgres clients surface this as either a `code` field or a
 * message containing the table name — we handle both.
 */
function isTableMissing(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === POSTGRES_RELATION_DOES_NOT_EXIST) return true;
  if (err.message && err.message.includes('ral_reglas')) return true;
  return false;
}

// ─── Camino A: lookup por articulos_pregunta ─────────────────────────────────

/**
 * Camino A — articulos_pregunta populado. Devuelve las reglas vigentes
 * que tienen al menos un artículo en común con la pregunta, rankeadas por
 * |intersect| desc.
 */
async function evaluateByArticulos(
  articulos_pregunta: string[],
): Promise<RalReglaMatch[]> {
  const normalized = articulos_pregunta.map(normalizeArticuloNumero);
  if (normalized.length === 0) return [];

  const { data, error } = await supa()
    .from('ral_reglas')
    .select(
      'id, slug, titulo, descripcion, area_procedural, condiciones, articulos_relacionados, excepciones, ejemplos, fuente_pdf_url, fuente_pagina, vigente',
    )
    .eq('vigente', true)
    .overlaps('articulos_relacionados', normalized);

  if (error) {
    if (isTableMissing(error)) {
      logger.warn('ralReglasEvaluator: ral_reglas table missing, returning empty', {
        code: error.code,
      });
      return [];
    }
    logger.warn('ralReglasEvaluator: supabase error in evaluateByArticulos', {
      message: error.message,
    });
    return [];
  }

  const rows: RalReglaRow[] = (data ?? []) as RalReglaRow[];
  const scored = rows.map((r) => {
    const intersect = countIntersection(r.articulos_relacionados, normalized);
    const confidence = Math.min(1, intersect / Math.max(1, normalized.length));
    const matchedList = r.articulos_relacionados
      .filter((x) => normalized.includes(x.toLowerCase()))
      .join(', ');
    return rowToMatch(
      r,
      confidence,
      `Matchea por artículo${intersect > 1 ? 's' : ''} ${matchedList || normalized.join(', ')}.`,
    );
  });

  scored.sort((a, b) => b.confidence_match - a.confidence_match);
  return scored.slice(0, TOP_K);
}

// ─── Camino B: keyword search sobre descripcion ──────────────────────────────

/**
 * Camino B — caso solo trae `contexto` (sin artículos). Búsqueda por keywords
 * sobre `descripcion` y `titulo`. NO usa LLM ni embeddings — keyword match
 * con ilike sobre los 3 términos más significativos del contexto.
 *
 * (Una versión futura puede embedear `descripcion` y usar pgvector. Por ahora
 *  esta heurística cubre los casos demo y es 10x más barata.)
 */
async function evaluateByContexto(contexto: string): Promise<RalReglaMatch[]> {
  const keywords = extractKeywords(contexto);
  if (keywords.length === 0) return [];

  // Build the `or` filter — match any keyword in titulo OR descripcion.
  // ilike es case-insensitive y postgres es eficiente con GIN/trigram (no
  // tenemos GIN sobre estas columnas todavía; con 50 rows da igual).
  const orFilter = keywords
    .flatMap((k) => [
      `titulo.ilike.%${k}%`,
      `descripcion.ilike.%${k}%`,
    ])
    .join(',');

  const { data, error } = await supa()
    .from('ral_reglas')
    .select(
      'id, slug, titulo, descripcion, area_procedural, condiciones, articulos_relacionados, excepciones, ejemplos, fuente_pdf_url, fuente_pagina, vigente',
    )
    .eq('vigente', true)
    .or(orFilter)
    .limit(TOP_K * 3);

  if (error) {
    if (isTableMissing(error)) {
      logger.warn('ralReglasEvaluator: ral_reglas table missing, returning empty', {
        code: error.code,
      });
      return [];
    }
    logger.warn('ralReglasEvaluator: supabase error in evaluateByContexto', {
      message: error.message,
    });
    return [];
  }

  const rows: RalReglaRow[] = (data ?? []) as RalReglaRow[];

  // Score: cuántas keywords aparecen en titulo+descripcion. Más keywords = más confianza.
  const scored = rows.map((r) => {
    const haystack = (r.titulo + ' ' + r.descripcion).toLowerCase();
    let hits = 0;
    const matched: string[] = [];
    for (const kw of keywords) {
      if (haystack.includes(kw.toLowerCase())) {
        hits++;
        matched.push(kw);
      }
    }
    const confidence = Math.min(1, hits / Math.max(1, keywords.length));
    return rowToMatch(
      r,
      confidence,
      `Matchea por keyword: ${matched.join(', ') || '(parcial)'}`,
    );
  });

  scored.sort((a, b) => b.confidence_match - a.confidence_match);
  return scored.slice(0, TOP_K);
}

/**
 * Extracts up to 5 meaningful Spanish keywords from a free-text query.
 * Skips stop-words and tokens shorter than 4 chars (too generic). No stemming —
 * we rely on ilike with substring match so "moción" finds "mociones" by virtue
 * of the shared root. Returns the truncated 5 longest keywords (longer tokens
 * tend to be more discriminative in legal/Spanish text).
 */
const STOPWORDS = new Set([
  'para',
  'pero',
  'porque',
  'cuando',
  'donde',
  'cuanto',
  'cuales',
  'sobre',
  'entre',
  'desde',
  'hasta',
  'segun',
  'esto',
  'esta',
  'estos',
  'estas',
  'este',
  'aquel',
  'aquella',
  'como',
  'cual',
  'pues',
  'tiene',
  'tener',
  'cual',
  'todo',
  'todos',
  'todas',
  'algunas',
  'algunos',
  'mismo',
  'misma',
  'cada',
  'mediante',
  'puede',
  'pueden',
  'debe',
  'deben',
  'tambien',
  'ademas',
]);

function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents for stopword match
    .split(/[^a-zñ0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  // dedupe + take top 5 by length (longer tokens carry more signal)
  const unique = Array.from(new Set(tokens));
  unique.sort((a, b) => b.length - a.length);
  return unique.slice(0, 5);
}

// ─── Camino C: por expediente sin artículos ni contexto suficiente ───────────

/**
 * Camino C — caso trae expediente_numero pero ni `articulos_pregunta` ni
 * `contexto` suficientemente discriminante. Devuelve las reglas vigentes
 * más generales del área "plenario" como fallback razonable (los expedientes
 * suelen ir a plenario y la pregunta operativa más frecuente es ahí).
 *
 * Esta es la última red de seguridad — el caller debería preferir Camino A o B.
 */
async function evaluateByExpedienteFallback(): Promise<RalReglaMatch[]> {
  const { data, error } = await supa()
    .from('ral_reglas')
    .select(
      'id, slug, titulo, descripcion, area_procedural, condiciones, articulos_relacionados, excepciones, ejemplos, fuente_pdf_url, fuente_pagina, vigente',
    )
    .eq('vigente', true)
    .eq('area_procedural', 'plenario')
    .limit(TOP_K);

  if (error) {
    if (isTableMissing(error)) {
      logger.warn('ralReglasEvaluator: ral_reglas table missing, returning empty', {
        code: error.code,
      });
      return [];
    }
    logger.warn('ralReglasEvaluator: supabase error in evaluateByExpedienteFallback', {
      message: error.message,
    });
    return [];
  }

  const rows: RalReglaRow[] = (data ?? []) as RalReglaRow[];
  return rows.map((r) =>
    rowToMatch(
      r,
      0.3,
      'Fallback genérico de área "plenario" (no se proporcionaron artículos ni contexto específico).',
    ),
  );
}

// ─── API pública: evaluateRalAplicacion ──────────────────────────────────────

/**
 * Función principal. Recibe un caso, devuelve hasta TOP_K reglas relevantes
 * ranked por confidence_match descendente + un texto `razonamiento` que
 * explica qué camino se usó.
 *
 * NUNCA tira. Sobre cualquier error degrada a [] + log warn.
 *
 * @example
 *   await evaluateRalAplicacion({
 *     contexto: '¿Cuántas firmas necesita una moción 137 en primer día?',
 *     articulos_pregunta: ['137'],
 *   });
 *   // → { reglas_aplicables: [{ slug: 'mocion_137_primer_dia_obligatoria', ... }],
 *   //     razonamiento: 'Camino A: lookup directo por artículos [137].' }
 */
export async function evaluateRalAplicacion(
  caso: CasoEvaluacion,
): Promise<EvaluacionResult> {
  try {
    // Camino A — artículos específicos.
    if (caso.articulos_pregunta && caso.articulos_pregunta.length > 0) {
      const reglas = await evaluateByArticulos(caso.articulos_pregunta);
      return {
        reglas_aplicables: reglas,
        razonamiento:
          `Camino A: lookup directo por artículos [${caso.articulos_pregunta.join(', ')}]. ` +
          `${reglas.length} regla(s) matcheada(s).`,
      };
    }

    // Camino B — contexto sin artículos.
    if (caso.contexto && caso.contexto.trim().length > 0) {
      const reglas = await evaluateByContexto(caso.contexto);
      if (reglas.length > 0) {
        return {
          reglas_aplicables: reglas,
          razonamiento:
            `Camino B: keyword match sobre contexto "${caso.contexto.slice(0, 80)}". ` +
            `${reglas.length} regla(s) encontrada(s).`,
        };
      }
      // No keyword hits → fallback al camino C si hay expediente.
      if (caso.expediente) {
        const fallback = await evaluateByExpedienteFallback();
        return {
          reglas_aplicables: fallback,
          razonamiento:
            `Camino C: keywords del contexto no matchearon ninguna regla. ` +
            `Fallback genérico área plenario para expediente ${caso.expediente}.`,
        };
      }
      return {
        reglas_aplicables: [],
        razonamiento:
          `Camino B sin matches y sin expediente para fallback. ` +
          `El contexto no contiene términos discriminantes en ral_reglas.`,
      };
    }

    // Sin artículos ni contexto: solo expediente_numero (o nada).
    if (caso.expediente) {
      const fallback = await evaluateByExpedienteFallback();
      return {
        reglas_aplicables: fallback,
        razonamiento:
          `Camino C: caso solo trae expediente ${caso.expediente}, fallback genérico área plenario.`,
      };
    }

    return {
      reglas_aplicables: [],
      razonamiento:
        'Caso vacío: no se proporcionó contexto, artículos ni expediente. Nada que evaluar.',
    };
  } catch (err) {
    // Cinturón y tirantes — cualquier excepción no atrapada se loggea y
    // devolvemos respuesta vacía. NUNCA romper el chat por esto.
    logger.warn('ralReglasEvaluator: unexpected error, returning empty', {
      message: (err as Error).message,
    });
    return {
      reglas_aplicables: [],
      razonamiento: `Error en evaluación: ${(err as Error).message}. Devolviendo [].`,
    };
  }
}

/**
 * Render the result for the LLM (Lexa) to consume in the conversation.
 * Markdown-ish format with explicit citation hints.
 */
export function renderEvaluacionForLlm(result: EvaluacionResult): string {
  if (result.reglas_aplicables.length === 0) {
    return (
      `(No se encontraron reglas procedurales del RAL aplicables al caso. ` +
      `Razonamiento: ${result.razonamiento})`
    );
  }

  const reglasText = result.reglas_aplicables
    .map((r, i) => {
      const articulos = r.articulos_relacionados.map((a) => `Art. ${a}`).join(', ');
      const excepLine = r.excepciones ? `\n   Excepciones: ${r.excepciones}` : '';
      const pageRef = r.fuente_pagina ? ` (pág. ${r.fuente_pagina})` : '';
      return (
        `[${i + 1}] **${r.titulo}** (slug: ${r.slug}, área: ${r.area_procedural})\n` +
        `   Artículos: ${articulos}${pageRef}\n` +
        `   Confidence: ${r.confidence_match.toFixed(2)}\n` +
        `   ${r.razon_evaluacion}\n` +
        `   ${r.descripcion}${excepLine}`
      );
    })
    .join('\n\n');

  return `Reglas procedurales aplicables (${result.reglas_aplicables.length}):\n\n${reglasText}\n\n---\n${result.razonamiento}`;
}
