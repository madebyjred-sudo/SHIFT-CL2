/**
 * fechaDictamenExtractor — busca "fecha estimada de dictamen" dentro del
 * texto plano de un documento del SIL.
 *
 * Pedido 07 del cliente:
 *   "FECHA ESTIMADA DE DICTAMEN SIEMPRE ESTÁ DENTRO DE LOS DOCUMENTOS Y
 *   NORMALMENTE ES TENTATIVA NO OFICIAL PERO ES UN PROCESO QUE ELLOS
 *   HACEN MANUAL. PARTE DEL TRABAJO DE REPORTE DE ORDEN DEL DÍA ES ESTO."
 *
 * Carlos (Pedido 16g):
 *   "Ahí tenés en ese 24982 en negrita, fecha para dictaminar."
 *
 * Carlos (Pedido 16h):
 *   "Esa fecha para dictaminar es un aproximado. Puede variar... cada
 *   cierto tiempo están recalculando."
 *
 * Diseño:
 *   1. PASS 1 — regex sobre `text_extracted`. Cazamos cualquier mención de
 *      "fecha estimada", "fecha para dictaminar", "se dictaminará", etc.
 *      seguida de una fecha en formato español. Capturamos también un
 *      ventana de contexto (±80 chars) para mostrar en el frontend.
 *   2. PASS 2 — Si encontramos múltiples candidatos en el mismo doc,
 *      preferimos el más cercano al inicio del documento (es la fecha
 *      "principal" — los anexos repiten la fecha al final).
 *   3. CONFIDENCE — 0.9 cuando la línea contiene "FECHA ESTIMADA" exact
 *      (la convención del SIL). 0.7 cuando es "fecha para dictaminar"
 *      o "se dictaminará el". 0.5 para patrones más laxos.
 *   4. VISUAL_MARKER — NO se detecta acá (requiere parsear DOCX XML, ver
 *      `fechaDictamenBoldDetector.ts` para Phase 2). Acá retornamos
 *      visualMarker=null y un job aparte lo actualiza.
 *
 * NO usamos LLM por defecto — el regex es suficiente para >95% de los
 * documentos. El cliente quería que esto fuera procesable a escala (no
 * gastando tokens en 22k docs).
 */

import { logger } from './logger.js';

export interface FechaDictamenCandidate {
  /** Fecha en formato ISO YYYY-MM-DD */
  valor_fecha: string;
  /** El texto original tal como aparece en el documento. */
  valor_texto_original: string;
  /** Ventana de contexto (±80 chars) alrededor del match. */
  contexto: string;
  /** Posición en el documento (0-1, 0=inicio, 1=fin). Útil para preferir matches al principio. */
  position_ratio: number;
  /** Confianza heurística (0-1) basada en qué tan específico fue el patrón. */
  confidence: number;
  /** Patrón que matcheó — para debug. */
  pattern_id: string;
}

const SPANISH_MONTH: Record<string, string> = {
  ene: '01', enero: '01',
  feb: '02', febrero: '02',
  mar: '03', marzo: '03',
  abr: '04', abril: '04',
  may: '05', mayo: '05',
  jun: '06', junio: '06',
  jul: '07', julio: '07',
  ago: '08', agosto: '08',
  sep: '09', set: '09', septiembre: '09', setiembre: '09',
  oct: '10', octubre: '10',
  nov: '11', noviembre: '11',
  dic: '12', diciembre: '12',
};

/**
 * Convierte una fecha en español a ISO. Acepta:
 *   - "14 de mayo de 2026"
 *   - "14 de mayo del 2026"
 *   - "14-may-2026" / "14-may.-2026"
 *   - "14/05/2026" / "14-05-2026" / "14.05.2026"
 *   - "2026-05-14"
 *
 * Retorna null si no puede parsear o si el año está fuera de 1990-2050
 * (filtro defensivo: el SIL ocasionalmente tiene typos como "2424" en
 * lugar de "2024").
 */
function spanishDateToISO(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/[ ]/g, ' ');

  // "14 de mayo de 2026" / "14 de mayo del 2026"
  const m1 = s.match(/^(\d{1,2})\s+de\s+([a-zñé]+)\s+de(?:l)?\s+(\d{4})$/);
  if (m1) {
    const [, d, m, y] = m1;
    const month = SPANISH_MONTH[m];
    if (month && isReasonableYear(y)) return `${y}-${month}-${d.padStart(2, '0')}`;
  }

  // "14-may-2026" / "14 may 2026" / "14/may/2026" / "14-may.-2026"
  const m2 = s.match(/^(\d{1,2})[\s\-\/](?:de\s+)?([a-zñé]+)\.?[\s\-\/](?:de(?:l)?\s+)?(\d{4})$/);
  if (m2) {
    const [, d, m, y] = m2;
    const monthKey = m.length > 3 ? m.slice(0, 3) : m;
    const month = SPANISH_MONTH[monthKey] ?? SPANISH_MONTH[m];
    if (month && isReasonableYear(y)) return `${y}-${month}-${d.padStart(2, '0')}`;
  }

  // "14/05/2026" / "14-05-2026" / "14.05.2026" — dd/mm/yyyy (formato CR)
  const m3 = s.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
  if (m3) {
    const [, d, m, y] = m3;
    if (isReasonableYear(y) && Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  // ISO ya
  const m4 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m4 && isReasonableYear(m4[1])) return m4[0];

  return null;
}

function isReasonableYear(y: string): boolean {
  const n = Number(y);
  return n >= 1990 && n <= 2050;
}

// ─── Patrones ─────────────────────────────────────────────────────────────
// Cada patrón captura un grupo `fecha` que después pasamos a spanishDateToISO.
//
// Ordenados por especificidad (más específico primero → mayor confidence).
//
// IMPORTANTE: el flag `gi` (global + insensitive) es necesario para iterar
// varios matches en el mismo doc. JavaScript exige que el regex tenga `g`
// para usar `matchAll`.

interface PatternDef {
  id: string;
  re: RegExp;
  confidence: number;
}

// Fragmento de fecha en español — se compone en cada patrón porque
// JavaScript no soporta backreferences a sub-grupos nombrados entre regex.
// El grupo captura es siempre `(?<fecha>...)`.
//
// Acepta:
//   - "14 de mayo de 2026" / "14 de mayo del 2026"
//   - "14-may-2026" / "14-may.-2026" / "14 may 2026"
//   - "14/05/2026" / "14-05-2026"
//   - "2026-05-14"
const FECHA_FRAG =
  '(?<fecha>(?:\\d{1,2}\\s+de\\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\\s+de(?:l)?\\s+\\d{4})'
  + '|(?:\\d{1,2}[\\s\\-\\/](?:de\\s+)?(?:ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)\\.?[\\s\\-\\/](?:de(?:l)?\\s+)?\\d{4})'
  + '|(?:\\d{1,2}[\\/\\.\\-]\\d{1,2}[\\/\\.\\-]\\d{4})'
  + '|(?:\\d{4}-\\d{2}-\\d{2}))';

const PATTERNS: PatternDef[] = [
  // FECHA ESTIMADA DE DICTAMEN / FECHA ESTIMADA: <fecha>
  // Convención canónica que usan los analistas del SIL al imprimir órdenes del día.
  {
    id: 'fecha_estimada_canonical',
    re: new RegExp(
      `(?:^|[\\.\\s\\:])fecha\\s+estimada\\s+(?:de\\s+)?dictamen(?:\\s*[:\\.\\-]\\s*|\\s+del?\\s+|\\s+)${FECHA_FRAG}`,
      'gi',
    ),
    confidence: 0.95,
  },
  // "Fecha tentativa de dictamen" — variante manual
  {
    id: 'fecha_tentativa',
    re: new RegExp(
      `(?:^|[\\.\\s\\:])fecha\\s+tentativa\\s+(?:de\\s+)?dictamen(?:\\s*[:\\.\\-]\\s*|\\s+del?\\s+|\\s+)${FECHA_FRAG}`,
      'gi',
    ),
    confidence: 0.92,
  },
  // "Fecha para dictaminar: 14 de mayo de 2026" (Carlos, Pedido 16g)
  {
    id: 'fecha_para_dictaminar',
    re: new RegExp(
      `(?:^|[\\.\\s\\:])fecha\\s+para\\s+dictaminar(?:\\s*[:\\.\\-]\\s*|\\s+del?\\s+|\\s+)${FECHA_FRAG}`,
      'gi',
    ),
    confidence: 0.88,
  },
  // "se dictaminará el 14 de mayo de 2026" / "se debe dictaminar el ..."
  {
    id: 'se_dictaminara_el',
    re: new RegExp(
      `(?:^|[\\.\\s])se\\s+(?:debe\\s+)?dictaminar(?:\\s*\\(?\\s*á\\s*\\)?)?\\s+(?:el|antes\\s+del|hasta\\s+el)\\s+${FECHA_FRAG}`,
      'gi',
    ),
    confidence: 0.75,
  },
  // "para dictaminar antes del 14 de mayo de 2026"
  {
    id: 'para_dictaminar_antes_del',
    re: new RegExp(
      `(?:^|[\\.\\s])para\\s+dictaminar(?:\\s+este\\s+expediente)?\\s+(?:el|antes\\s+del|hasta\\s+el)\\s+${FECHA_FRAG}`,
      'gi',
    ),
    confidence: 0.72,
  },
  // "deadline dictamen: 14/05/2026" — variante informal
  {
    id: 'deadline_dictamen',
    re: new RegExp(
      `(?:^|[\\.\\s])deadline\\s+(?:para\\s+)?(?:el\\s+)?dictamen(?:\\s*[:\\.\\-]\\s*|\\s+del?\\s+|\\s+)${FECHA_FRAG}`,
      'gi',
    ),
    confidence: 0.65,
  },
];

/**
 * Extrae candidatos a "fecha estimada de dictamen" de un texto.
 *
 * Retorna 0 o más candidatos. Caller decide cuál usar (típico: el de
 * mayor confidence × más cerca del inicio del documento).
 *
 * Performance: ~100ms para textos de 500k chars. No usa LLM.
 */
export function extractFechasDictamen(text: string): FechaDictamenCandidate[] {
  // Threshold defensivo: textos muy cortos no van a tener una fecha estimada
  // útil. 20 chars cubre los strings de test legítimos (e.g. el frag
  // canonical mínimo "fecha estimada de dictamen: 14/05/2026" = 38 chars)
  // mientras descarta noise de PDFs corruptos (0-5 chars).
  if (!text || text.length < 20) return [];
  const out: FechaDictamenCandidate[] = [];
  const textLen = text.length;

  for (const pattern of PATTERNS) {
    for (const m of text.matchAll(pattern.re)) {
      const matchStart = m.index ?? 0;
      const matched = m[0];
      const fechaRaw = m.groups?.fecha;
      if (!fechaRaw) continue;

      const valorFecha = spanishDateToISO(fechaRaw);
      if (!valorFecha) continue;

      // Filtro defensivo: si la fecha es del pasado (más de 6 meses),
      // probablemente no es la fecha estimada actual sino una histórica.
      // Pero igual la guardamos — el caller decide. Solo logueamos.
      const today = new Date();
      const fechaDate = new Date(valorFecha);
      const monthsAgo = (today.getTime() - fechaDate.getTime()) / (1000 * 60 * 60 * 24 * 30);
      if (monthsAgo > 12) {
        // Es probable que sea una fecha de antaño en un documento antiguo —
        // bajamos un poco la confidence pero la incluímos. El cliente puede
        // verificar visualmente.
      }

      // Ventana de contexto: ±80 chars alrededor del match.
      const ctxStart = Math.max(0, matchStart - 80);
      const ctxEnd = Math.min(textLen, matchStart + matched.length + 80);
      const contexto = text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();

      out.push({
        valor_fecha: valorFecha,
        valor_texto_original: matched.trim(),
        contexto,
        position_ratio: textLen > 0 ? matchStart / textLen : 0,
        confidence: pattern.confidence,
        pattern_id: pattern.id,
      });
    }
  }

  return out;
}

/**
 * Elige el candidato "principal" de un set de matches. Estrategia:
 *   1. Si hay un canonical (`fecha_estimada_canonical`), usar el más cercano
 *      al inicio del doc.
 *   2. Si no, el de mayor confidence × (1 - position_ratio × 0.3).
 *      (Penaliza levemente los matches al final del doc — anexos.)
 *   3. Si hay tied, el primero en orden de aparición.
 *
 * Retorna null si el array está vacío.
 */
export function pickPrimaryFechaDictamen(candidates: FechaDictamenCandidate[]): FechaDictamenCandidate | null {
  if (candidates.length === 0) return null;

  // Prioridad 1: cualquier canonical match al inicio del doc.
  const canonicals = candidates.filter((c) => c.pattern_id === 'fecha_estimada_canonical');
  if (canonicals.length > 0) {
    return canonicals.sort((a, b) => a.position_ratio - b.position_ratio)[0];
  }

  // Prioridad 2: score = confidence × (1 - position_ratio × 0.3)
  const scored = candidates.map((c) => ({
    c,
    score: c.confidence * (1 - c.position_ratio * 0.3),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0].c;
}

/**
 * Convenience: extrae + elige principal en una sola llamada.
 */
export function extractPrimaryFechaDictamen(text: string): FechaDictamenCandidate | null {
  const candidates = extractFechasDictamen(text);
  if (candidates.length === 0) return null;
  const primary = pickPrimaryFechaDictamen(candidates);
  if (primary && process.env.DEBUG_FECHA_EXTRACTOR === '1') {
    logger.info('fecha_dictamen_extracted', {
      valor_fecha: primary.valor_fecha,
      pattern: primary.pattern_id,
      confidence: primary.confidence,
      contexto: primary.contexto.slice(0, 200),
    });
  }
  return primary;
}
