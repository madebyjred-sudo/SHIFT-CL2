/**
 * legalDocChunker.ts
 *
 * Heurística "POR TANTO" — Track G del Sprint 1 CL2 v3
 *
 * Ahorra 85-90% de tokens en documentos jurídicos (resoluciones Sala
 * Constitucional, dictámenes Procuraduría, sentencias) extrayendo solo
 * el encabezado + la sección dispositiva (POR TANTO / CONCLUSIONES / FALLO).
 *
 * Cita del cliente (transcripción 50:39):
 * "Del por tanto, es tal cual como la como el resumen. Ahí viene ya los si
 * tiene provicios de constitucionalidad o no tiene. Entonces se puede como
 * la I ahorrarse o más o menos toda esta... se puede ir aquí al por tanto y
 * ver qué es lo que dicen los magistrados."
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DocClass =
  | 'resolucion_sala_constitucional'
  | 'resolucion_procuraduria'
  | 'dictamen_comision'
  | 'sentencia_tribunal'
  | 'generico';

export type ChunkStrategy = 'por_tanto' | 'standard' | 'paragrafo';

export type SectionLabel =
  | 'encabezado'
  | 'considerando'
  | 'por_tanto'
  | 'firmas'
  | 'otro';

export interface LegalChunk {
  index: number;
  section: SectionLabel;
  text: string;
  tokens_estimate: number;
}

export interface ChunkedLegalDoc {
  doc_class: DocClass;
  strategy: ChunkStrategy;
  chunks: LegalChunk[];
  /** Texto completo — siempre guardamos el original */
  text_full: string;
  /** Encabezado + sección dispositiva (skip de considerandos) */
  text_resumido: string;
  /** Solo la decisión (desde marker hasta fin del doc) */
  por_tanto_text?: string;
  /** Inferencia del sentido de la decisión */
  decision_inferida?: string | null;
  tokens_full_estimate: number;
  tokens_resumido_estimate: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Markers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markers dispositivos por tipo de documento jurídico costarricense.
 * Orden de búsqueda: más específico al más genérico.
 */
const DISPOSITIVO_MARKERS: Record<string, RegExp> = {
  // Sala Constitucional, tribunales generales, Asamblea Legislativa
  por_tanto: /\bPOR\s+TANTO\s*[:.\-]?/m,
  por_tanto_lc: /\bPor\s+tanto\s*[:.\-]?/m,
  // Sentencias formales
  fallo: /\bFALLO\s*[:.\-]?/m,
  fallo_lc: /\bFallo\s*[:.\-]?/m,
  // Procuraduría General de la República
  conclusiones: /\bCONCLUSIONES\s*[:.\-]?/m,
  conclusion: /\bCONCLUSI[OÓ]N\s*[:.\-]?/m,
  // Dictámenes de comisión legislativa
  recomienda: /\bRECOMIENDA\s*[:.\-]?/m,
  recomienda_lc: /\bRecomienda\s*[:.\-]?/m,
};

const CONSIDERANDO_MARKER = /\b(CONSIDERANDO|Considerando)\s*[:.\-]?/m;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rough token estimate (~4 chars per token, industry heuristic).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Chunk text into fixed-size slices (fallback for non-legal docs).
 */
function standardChunk(text: string, chunkSize = 2000): LegalChunk[] {
  const chunks: LegalChunk[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    const slice = text.slice(i, i + chunkSize);
    chunks.push({
      index: chunks.length,
      section: 'otro',
      text: slice,
      tokens_estimate: estimateTokens(slice),
    });
  }
  return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision inference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Infers the outcome from the dispositiva section.
 * Returns null when the pattern is ambiguous or absent.
 */
export function inferDecision(porTantoText: string): string | null {
  const lower = porTantoText.toLowerCase();

  // Order matters: more specific patterns first
  if (/inconstitucionalidad\s+parcial/.test(lower)) return 'inconstitucional_parcial';
  if (/inconstitucionalidad|inconstitucional/.test(lower)) return 'inconstitucional';
  if (/sin\s+lugar/.test(lower)) return 'sin_lugar';
  if (/parcialmente|parcial/.test(lower)) return 'parcial';
  if (/con\s+lugar/.test(lower)) return 'con_lugar';
  if (/desestima/.test(lower)) return 'desestimada';
  if (/se\s+evacua/.test(lower)) return 'evacuada';
  if (/se\s+rechaza|rechaz[ao]/.test(lower)) return 'rechazada';

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Doc classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classifies the document type using filename hints + content heuristics.
 * Searches only the first 800 chars of text to keep it fast.
 */
export function detectDocClass(text: string, fileName?: string): DocClass {
  const header = text.slice(0, 800).toLowerCase();
  const fileNameLower = (fileName ?? '').toLowerCase();

  // 1. Filename signals (strongest signal)
  if (
    fileNameLower.includes('sala constitucional') ||
    fileNameLower.includes('sala_constitucional') ||
    fileNameLower.includes('resolución sala') ||
    fileNameLower.includes('voto')
  ) {
    return 'resolucion_sala_constitucional';
  }

  if (
    fileNameLower.includes('procuradur') ||
    fileNameLower.includes('dictamen')
  ) {
    // distinguish Procuraduría from generic dictamen
    if (fileNameLower.includes('procuradur')) return 'resolucion_procuraduria';
    return 'dictamen_comision';
  }

  // 2. Content signals on first 800 chars
  if (
    (header.includes('sala constitucional') || header.includes('sala iv')) &&
    (header.includes('corte suprema') || header.includes('magistrad'))
  ) {
    return 'resolucion_sala_constitucional';
  }

  if (
    header.includes('procuradur') &&
    (header.includes('general') || header.includes('república') || header.includes('republica'))
  ) {
    return 'resolucion_procuraduria';
  }

  if (header.includes('dictamen') || header.includes('comisión') || header.includes('comision')) {
    return 'dictamen_comision';
  }

  // 3. Structural signals — has both CONSIDERANDO and a dispositivo marker
  const hasConsiderando = CONSIDERANDO_MARKER.test(text);
  const hasDispositivo = Object.values(DISPOSITIVO_MARKERS).some(r => r.test(text));

  if (hasConsiderando && hasDispositivo) {
    return 'sentencia_tribunal';
  }

  return 'generico';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export interface ChunkOptions {
  fileName?: string;
  /** Max chars for encabezado when CONSIDERANDO marker is not found */
  encabezadoFallbackChars?: number;
}

/**
 * Main entry point.
 *
 * For generic docs: applies standard fixed-size chunking.
 * For legal docs: extracts encabezado + sección dispositiva, skipping
 * the (often huge) CONSIDERANDO body.
 */
export function chunkLegalDoc(text: string, opts?: ChunkOptions): ChunkedLegalDoc {
  const doc_class = detectDocClass(text, opts?.fileName);
  const fallbackChars = opts?.encabezadoFallbackChars ?? 1500;

  // ── Generic: no legal structure ──────────────────────────────────────────
  if (doc_class === 'generico') {
    const text_resumido = text.slice(0, 2000);
    return {
      doc_class,
      strategy: 'standard',
      chunks: standardChunk(text),
      text_full: text,
      text_resumido,
      tokens_full_estimate: estimateTokens(text),
      tokens_resumido_estimate: estimateTokens(text_resumido),
    };
  }

  // ── Legal doc: find encabezado ────────────────────────────────────────────
  let encabezadoEnd = fallbackChars;
  const considMatch = CONSIDERANDO_MARKER.exec(text);
  if (considMatch?.index !== undefined && considMatch.index < 3000) {
    encabezadoEnd = considMatch.index;
  }
  const encabezado = text.slice(0, encabezadoEnd).trim();

  // ── Find dispositivo marker (last / highest index wins for edge cases) ────
  let dispositiveIndex: number | null = null;
  for (const regex of Object.values(DISPOSITIVO_MARKERS)) {
    // We want the *last* occurrence of any marker (some docs repeat headers)
    const matches = [...text.matchAll(new RegExp(regex.source, 'gm'))];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      if (lastMatch.index !== undefined) {
        if (dispositiveIndex === null || lastMatch.index > dispositiveIndex) {
          dispositiveIndex = lastMatch.index;
        }
      }
    }
  }

  // ── Fallback: no dispositivo marker found ─────────────────────────────────
  if (dispositiveIndex === null) {
    const text_resumido = encabezado;
    return {
      doc_class,
      strategy: 'standard',
      chunks: standardChunk(text),
      text_full: text,
      text_resumido,
      tokens_full_estimate: estimateTokens(text),
      tokens_resumido_estimate: estimateTokens(text_resumido),
    };
  }

  // ── Extract sección dispositiva ───────────────────────────────────────────
  const porTantoText = text.slice(dispositiveIndex).trim();

  // ── Build resumido ─────────────────────────────────────────────────────────
  const text_resumido = `${encabezado}\n\n[...CONSIDERANDOS OMITIDOS...]\n\n${porTantoText}`;

  // ── Build chunks ──────────────────────────────────────────────────────────
  const chunks: LegalChunk[] = [
    {
      index: 0,
      section: 'encabezado',
      text: encabezado,
      tokens_estimate: estimateTokens(encabezado),
    },
  ];

  // Split dispositiva by blank lines; filter trivial fragments
  const porTantoParas = porTantoText
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 20);

  for (const [i, para] of porTantoParas.entries()) {
    chunks.push({
      index: i + 1,
      section: 'por_tanto',
      text: para,
      tokens_estimate: estimateTokens(para),
    });
  }

  return {
    doc_class,
    strategy: 'por_tanto',
    chunks,
    text_full: text,
    text_resumido,
    por_tanto_text: porTantoText,
    decision_inferida: inferDecision(porTantoText),
    tokens_full_estimate: estimateTokens(text),
    tokens_resumido_estimate: estimateTokens(text_resumido),
  };
}
