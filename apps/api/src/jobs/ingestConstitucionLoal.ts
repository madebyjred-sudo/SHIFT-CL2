/**
 * ingestConstitucionLoal — chunkea la Constitución Política CR (197 arts.) y la LOAL
 *   (~100 arts.) a `legislative_chunks` para que Lexa los pueda citar.
 *
 * Wave 4 #2 (2026-05-26).
 *
 * Por qué este job existe (lawyer audit 2026-05-26):
 *   Lexa fallaba ante preguntas sobre tratados internacionales, elección
 *   de magistrados de la Sala IV, plazo de resello tras veto, inmunidad
 *   parlamentaria, juramentación. Esas materias están en la Constitución
 *   y en la LOAL — no en el Reglamento (lo único indexado hasta hoy).
 *
 * Estrategia:
 *   1. Leer el texto plano de cada cuerpo desde apps/api/scripts/data/.
 *      Constitución: constitucion-cr.txt (extraída del PDF TSE de
 *      noviembre 1949 + reformas).
 *      LOAL: loal-cr.txt (placeholder hasta que Juan ingiera el texto).
 *   2. Parsear por `Artículo N` — cada artículo es 1 chunk. Esto es
 *      consistente con cómo está indexado el Reglamento (1 art = 1 chunk)
 *      y le da a Lexa citación directa por número de artículo.
 *   3. Embedar vía `embedDocuments` (Vertex Gemini, 3072d, mismo modelo
 *      que el resto del corpus).
 *   4. INSERT con source_type='constitucion' o 'loal'. Idempotente:
 *      borra todos los chunks del source_type antes de re-insertar.
 *
 * Cuándo correr:
 *   Solo on-demand (ejecución manual). NO se programa como cron porque
 *   estos textos son normativos vigentes que cambian solo con reformas
 *   constitucionales o legislativas, eventos raros con dispatch manual.
 *
 * Idempotencia:
 *   Antes de insertar, DELETE por source_type. Re-run siempre llega al
 *   mismo estado final.
 *
 * Requiere:
 *   - Migración 0050 aplicada (source_type allowlist).
 *   - GOOGLE_APPLICATION_CREDENTIALS + GCP_PROJECT_ID.
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (service role,
 *     no anon — borrar + insertar requiere bypass de RLS).
 *
 * Tests:
 *   `apps/api/src/jobs/ingestConstitucionLoal.test.ts` cubre el parser
 *   (pura) — el ingest + embed se prueba con --dry / --probe en CLI.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { embedDocuments } from '../services/embeddings.js';
import { logger } from '../services/logger.js';

// ─── Types ────────────────────────────────────────────────────────────

export type LegalSourceType = 'constitucion' | 'loal';

export interface ParsedArticle {
  /** Número del artículo (string para preservar "121 bis" si aparece). */
  articulo_numero: string;
  /** Variante entera cuando es parseable — útil para chunk_index. */
  articulo_numero_int: number;
  /** Línea entera del header, ej. "Artículo 121.-". */
  articulo_header: string;
  /** Texto completo del artículo (sin el header), normalizado. */
  content: string;
  /** Título o capítulo más cercano arriba del artículo (si lo detectamos). */
  titulo_seccion: string | null;
}

export interface IngestSummary {
  source_type: LegalSourceType;
  articles_parsed: number;
  articles_inserted: number;
  articles_deleted: number;
  /** Sample primer artículo para verificación post-run. */
  sample_first_article: ParsedArticle | null;
}

// ─── Pure parser (testable sin mocks) ─────────────────────────────────

/**
 * Parsea texto plano de la Constitución o LOAL en artículos individuales.
 *
 * Reconoce variantes del header:
 *   - "Artículo 1- ..."     (Constitución TSE PDF)
 *   - "Artículo 121.- ..."  (RAL convention)
 *   - "Artículo 121°.- ..." (LOAL antiguo)
 *   - "ARTICULO 1." / "Art. 1°" → toleramos casing y abreviatura.
 *
 * Para cada artículo capturamos también el último encabezado de Título
 * o Capítulo que apareció antes (metadata.titulo_seccion). Esto da
 * contexto al chunk sin meter el artículo entero en el header.
 *
 * NO normaliza acentos (preserva "Artículo") porque el corpus español
 * de Vertex Gemini los espera; tampoco trunca contenido.
 *
 * Limpieza:
 *   - Notas a pie ("Nota: Reformado..." en la Constitución TSE) se
 *     incluyen como parte del artículo — son información oficial.
 *   - Líneas con solo encabezado de pie de página repetido del PDF
 *     ("CONSTITUCIÓN POLÍTICA DE LA REPÚBLICA DE COSTA RICA") se
 *     filtran porque rompen la coherencia del chunk.
 */
export function parseArticles(raw: string): ParsedArticle[] {
  // Regex que matchea el INICIO de un artículo en línea propia.
  // Captura número (1, 121, 121 bis). Solo aceptamos las formas con
  // mayúscula inicial: "Artículo", "ARTÍCULO", "ARTICULO", "Art."
  // — NUNCA lowercase "artículo" (eso típicamente aparece a mitad de
  // párrafo: "...la Sala indicada en el artículo 10." en Const. Art. 48).
  // El flag `m` ancla `^` a inicio de línea; sin `i` para evitar falsos
  // positivos. El separador acepta ".-", "-", ".", "°.-".
  const HEADER_RE = /^[ \t]*(?:Artículo|ARTÍCULO|ARTICULO|Art\.)\s+(\d+(?:\s*(?:bis|ter|quater))?)\s*[°ºo]?\s*[.\-]+\s*/gm;
  // Detector de Títulos/Capítulos para metadata.titulo_seccion.
  const SECTION_RE = /^[ \t]*(TÍTULO\s+[IVXLCDM\d]+[^\n]*|TITULO\s+[IVXLCDM\d]+[^\n]*|Capítulo\s+(?:Único|[IVXLCDM\d]+)[^\n]*)$/gm;

  // Recolecto secciones con su posición para asignar al artículo el más
  // reciente arriba en el texto.
  const sections: Array<{ pos: number; title: string }> = [];
  let sm: RegExpExecArray | null;
  while ((sm = SECTION_RE.exec(raw)) !== null) {
    sections.push({ pos: sm.index, title: sm[0].trim() });
  }
  SECTION_RE.lastIndex = 0;

  // Recolecto headers de artículo con offsets.
  const headers: Array<{ pos: number; numero: string; numeroInt: number; headerEnd: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = HEADER_RE.exec(raw)) !== null) {
    const numeroRaw = m[1].trim().replace(/\s+/g, ' ');
    const numeroInt = Number.parseInt(numeroRaw.replace(/[^\d]/g, ''), 10);
    if (!Number.isInteger(numeroInt) || numeroInt <= 0) continue;
    headers.push({
      pos: m.index,
      numero: numeroRaw,
      numeroInt,
      headerEnd: m.index + m[0].length,
    });
  }

  const articles: ParsedArticle[] = [];
  for (let i = 0; i < headers.length; i++) {
    const cur = headers[i];
    const next = headers[i + 1];
    const sliceEnd = next ? next.pos : raw.length;
    const body = raw.slice(cur.headerEnd, sliceEnd).trim();
    const cleaned = cleanArticleBody(body);
    if (cleaned.length < 5) continue; // skip noise (header sin texto real)

    // Buscar última sección arriba del artículo.
    let titulo_seccion: string | null = null;
    for (const s of sections) {
      if (s.pos < cur.pos) titulo_seccion = s.title;
      else break;
    }

    articles.push({
      articulo_numero: cur.numero,
      articulo_numero_int: cur.numeroInt,
      articulo_header: `Artículo ${cur.numero}.-`,
      content: cleaned,
      titulo_seccion,
    });
  }

  return articles;
}

/**
 * Limpia el body de un artículo:
 *   - Colapsa runs de whitespace en single space (pero preserva newlines
 *     dobles que separan párrafos legales).
 *   - Quita líneas de footer repetidas del PDF TSE.
 *   - Trim total.
 *
 * Esto NO trunca contenido. Mantenemos las notas de reforma porque son
 * información oficial vigente.
 */
function cleanArticleBody(body: string): string {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => {
      // Footers conocidos del PDF TSE (repiten en cada página).
      if (/^_+$/.test(l)) return false;
      if (/^CONSTITUCI[ÓO]N POL[ÍI]TICA DE LA REP[ÚU]BLICA DE COSTA RICA$/i.test(l)) return false;
      if (/^Tribunal Supremo de Elecciones$/i.test(l)) return false;
      if (/^Normativa$/i.test(l) && l.length < 15) return false;
      if (/^www\.tse\.go\.cr$/i.test(l)) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ─── Supabase wiring ──────────────────────────────────────────────────

function supa(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('ingestConstitucionLoal: supabase env missing');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Resuelve `apps/api/scripts/data/<file>` relativo a este módulo TS/JS.
// FYI: tras `tsc` el archivo termina en `apps/api/dist/jobs/`, así que
// resolvemos siempre relativo al cwd del proceso si no encuentra al lado.
function resolveDataPath(filename: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dev (tsx): src/jobs → src/../scripts/data
  // prod (node dist/): dist/jobs → ../scripts/data (cuando build copia)
  const candidates = [
    path.resolve(here, '..', '..', 'scripts', 'data', filename),
    path.resolve(process.cwd(), 'apps', 'api', 'scripts', 'data', filename),
    path.resolve(process.cwd(), 'scripts', 'data', filename),
  ];
  return candidates[0]; // el primero; el caller valida existencia.
}

async function readSource(filename: string): Promise<string | null> {
  const candidates = [
    resolveDataPath(filename),
    path.resolve(process.cwd(), 'apps', 'api', 'scripts', 'data', filename),
    path.resolve(process.cwd(), 'scripts', 'data', filename),
  ];
  for (const p of candidates) {
    try {
      const stat = await fs.stat(p);
      if (stat.isFile() && stat.size > 1000) {
        return await fs.readFile(p, 'utf8');
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ─── Insert helper ────────────────────────────────────────────────────

interface InsertChunk {
  session_id: null;
  source_type: LegalSourceType;
  source_ref: string;
  chunk_index: number;
  content: string;
  embedding: string;
  metadata: Record<string, unknown>;
}

const INSERT_BATCH = 50;

async function clearSourceType(s: SupabaseClient, sourceType: LegalSourceType): Promise<number> {
  const { data, error } = await s
    .from('legislative_chunks')
    .delete()
    .eq('source_type', sourceType)
    .select('id');
  if (error) throw new Error(`clear ${sourceType} failed: ${error.message}`);
  return data?.length ?? 0;
}

async function insertChunks(
  s: SupabaseClient,
  rows: InsertChunk[],
  label: string,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const slice = rows.slice(i, i + INSERT_BATCH);
    const { error, data } = await s
      .from('legislative_chunks')
      .insert(slice)
      .select('id');
    if (error) throw new Error(`insert ${label} batch ${i}: ${error.message}`);
    inserted += data?.length ?? slice.length;
  }
  return inserted;
}

// ─── Public titles for source_ref / metadata ──────────────────────────

const SOURCE_TITLE: Record<LegalSourceType, string> = {
  constitucion: 'Constitución Política de la República de Costa Rica',
  loal: 'Ley Orgánica del Poder Legislativo de Costa Rica',
};

const SOURCE_URL: Record<LegalSourceType, string | null> = {
  // FYI: TSE hospeda la versión oficial vigente; cualquier reforma futura
  // mantendría el path estable. Si se mueve, vuelve null y Lexa solo
  // muestra el número de artículo sin link.
  constitucion: 'https://www.tse.go.cr/pdf/normativa/constitucion.pdf',
  loal: null, // se setea cuando Juan ingiera el texto.
};

// ─── Orchestrator ─────────────────────────────────────────────────────

export interface IngestOptions {
  /** Si está set, procesa solo este source_type. Default: ambos. */
  only?: LegalSourceType;
  /** Si true, no llama Vertex ni Supabase write. Imprime conteos. */
  dry_run?: boolean;
  /** Si está set, procesa solo los primeros N artículos por fuente. */
  probe_limit?: number;
}

/**
 * Punto de entrada del job. Devuelve resumen por source_type.
 * Si LOAL no tiene archivo todavía, se omite limpiamente — la Constitución
 * se ingesta igual. El caller decide si esto es OK (script CLI sí lo
 * permite; el cron — si en el futuro se programa — debería abortar).
 */
export async function runIngestConstitucionLoal(opts: IngestOptions = {}): Promise<IngestSummary[]> {
  const sources: LegalSourceType[] = opts.only
    ? [opts.only]
    : ['constitucion', 'loal'];

  const out: IngestSummary[] = [];

  for (const sourceType of sources) {
    const filename = sourceType === 'constitucion' ? 'constitucion-cr.txt' : 'loal-cr.txt';
    const raw = await readSource(filename);
    if (!raw) {
      logger.warn('ingest_constitucion_loal_source_missing', {
        source_type: sourceType,
        filename,
        hint: 'Si querés LOAL, mirá scripts/data/loal-cr.txt.README — la Constitución funciona sin LOAL.',
      });
      out.push({
        source_type: sourceType,
        articles_parsed: 0,
        articles_inserted: 0,
        articles_deleted: 0,
        sample_first_article: null,
      });
      continue;
    }

    let articles = parseArticles(raw);
    if (opts.probe_limit && opts.probe_limit > 0) {
      articles = articles.slice(0, opts.probe_limit);
    }

    logger.info('ingest_constitucion_loal_parsed', {
      source_type: sourceType,
      articles_parsed: articles.length,
      first_numero: articles[0]?.articulo_numero ?? null,
      last_numero: articles[articles.length - 1]?.articulo_numero ?? null,
    });

    if (opts.dry_run) {
      out.push({
        source_type: sourceType,
        articles_parsed: articles.length,
        articles_inserted: 0,
        articles_deleted: 0,
        sample_first_article: articles[0] ?? null,
      });
      continue;
    }

    // Embed (Vertex Gemini 3072d via embedDocuments). El header se
    // antepone al content para que el embedding capture el ancla "Art. N"
    // en la representación vectorial — mismo trick que index-reglamento.
    const texts = articles.map((a) => `${a.articulo_header} ${a.content}`);
    const embeddings = await embedDocuments(texts);

    const s = supa();

    // Idempotencia: clear antes de insert. El RPC delete es seguro acá
    // porque el universo total (Constitución ~200 + LOAL ~100 = 300) es
    // chiquito comparado con los 825k chunks totales — no hay riesgo de
    // statement timeout, a diferencia de RAL (ver ingest-ral-chunks.ts).
    const deleted = await clearSourceType(s, sourceType);

    const rows: InsertChunk[] = articles.map((a, idx) => ({
      session_id: null,
      source_type: sourceType,
      source_ref: `${SOURCE_TITLE[sourceType]} · Artículo ${a.articulo_numero}`,
      chunk_index: idx,
      content: `${a.articulo_header} ${a.content}`,
      embedding: JSON.stringify(embeddings[idx]),
      metadata: {
        subtype: sourceType === 'constitucion' ? 'constitucion_articulo' : 'loal_articulo',
        articulo_numero: a.articulo_numero,
        articulo_numero_int: a.articulo_numero_int,
        articulo_header: a.articulo_header,
        titulo_seccion: a.titulo_seccion,
        doc: SOURCE_TITLE[sourceType],
        url: SOURCE_URL[sourceType],
        embedded_at: new Date().toISOString(),
        embedded_by: 'ingestConstitucionLoal',
      },
    }));

    const inserted = await insertChunks(s, rows, sourceType);

    logger.info('ingest_constitucion_loal_complete', {
      source_type: sourceType,
      articles_parsed: articles.length,
      articles_inserted: inserted,
      articles_deleted: deleted,
    });

    out.push({
      source_type: sourceType,
      articles_parsed: articles.length,
      articles_inserted: inserted,
      articles_deleted: deleted,
      sample_first_article: articles[0] ?? null,
    });
  }

  return out;
}
