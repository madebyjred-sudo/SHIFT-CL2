/**
 * voteSummaryParser — extrae votaciones formales desde el bloque
 * `metadata.resumen.acuerdos` (texto narrativo LLM-generado por sesión).
 *
 * Por qué existe (Wave 4 #7, derivado del audit Tier 2):
 *   El transcripto Gemini a veces pierde los momentos exactos de votación
 *   (ej: en la sesión 21-may-2026 el "52 votos a favor" del expediente
 *   24.998 NO quedó en ningún chunk transcript). Pero el resumen LLM
 *   por sesión SÍ captura todas las votaciones porque procesa el audio
 *   completo, no chunks individuales.
 *
 *   Este parser convierte ese texto narrativo en estructura. El job
 *   `ingest-synthetic-vote-chunks.ts` usa el output para crear chunks
 *   sintéticos embedded — citables por Lexa con la misma rigor que un
 *   chunk transcript real.
 *
 * Estrategia:
 *   1. Split el texto por oraciones.
 *   2. Para cada oración, detectar verbo decisorio (aprobó/rechazó/desechó)
 *      + expediente referenciado + conteo de votos a favor / en contra.
 *   3. Si una oración tiene varios expedientes ("se aprobaron los
 *      expedientes X y Y"), emitir un vote por cada uno con el mismo
 *      conteo. Conservador en captura.
 *   4. Descartar oraciones sin expediente claro (acta de sesión, moción
 *      de orden procedural, etc.) — no hay nada que linkear.
 *
 * Falsos positivos aceptados:
 *   "Se aprobó una moción de orden con 50 votos" sin expediente → descartado.
 *   "Se aprobó el acta de la sesión anterior" → descartado.
 */

import { extractExpedienteMentions } from './voteExtractor.js';

export type VoteDecision =
  | 'aprobado_1er_debate'
  | 'aprobado_2do_debate'
  | 'aprobado_2do_definitivo'
  | 'aprobado_mocion'
  | 'rechazado'
  | 'desechado'
  | 'aprobado';  // default cuando no podemos discriminar

export interface ExtractedVote {
  /** Expediente al que se asocia la votación. Formato canonical "NN.NNN". */
  expediente: string;
  /** Tipo de decisión. */
  decision: VoteDecision;
  /** Votos a favor, si el texto los menciona. null si no aparece. */
  votos_a_favor: number | null;
  /** Votos en contra, si el texto los menciona. null si no aparece. */
  votos_en_contra: number | null;
  /** Oración original de donde se extrajo. Para citar fuente. */
  fuente_oracion: string;
}

/**
 * Verbos decisorios que detectamos. Cada uno mapea a una VoteDecision base;
 * el contexto adyacente refina (ej: "aprobado" + "en segundo debate" →
 * 'aprobado_2do_debate').
 *
 * Nota técnica importante: NO usamos `\b` al final porque en JavaScript
 * regex (incluso con flag `u`), `\b` se define en términos del set ASCII
 * `[a-zA-Z0-9_]`. Caracteres acentuados como `ó` quedan FUERA → no hay
 * `\b` entre `ó` y un espacio. Eso hacía que "aprobó" no matcheara.
 * El lookahead `(?=[\s.,;:)¡!?]|$)` reemplaza ese rol de "frontera derecha".
 */
const DECISION_RE = /\b(aprob(?:[óo]|aron|ad[oa]s?)|rechaz(?:[óo]|ad[oa]s?|aron)|desech(?:[óo]|ad[oa]s?|aron))(?=[\s.,;:)¡!?]|$)/iu;

/** Detecta "X votos a favor" / "X a favor" — captura el número. */
const VOTOS_FAVOR_RE = /\b(\d+|cero)\s+(?:votos?\s+)?a\s+favor\b/iu;
/** Detecta "X votos en contra" / "X en contra". */
const VOTOS_CONTRA_RE = /\b(\d+|cero)\s+(?:votos?\s+)?en\s+contra\b/iu;

/** Refinadores de decisión basados en contexto. */
const DEBATE_2DO_RE = /\bsegundo\s+(?:y\s+definitivo\s+)?debate\b/iu;
const DEBATE_2DO_DEF_RE = /\bsegundo\s+y\s+definitivo\s+debate\b/iu;
const DEBATE_1ER_RE = /\bprimer\s+debate\b/iu;
const MOCION_RE = /\bmoci[oó]n\b/iu;

function parseNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  if (s.toLowerCase() === 'cero') return 0;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split en oraciones, respetando puntos abreviados ("Art." "Exp.").
 * Conservador: prefiere oraciones más largas a un over-split que rompa
 * la asociación verbo↔expediente.
 */
function splitSentences(text: string): string[] {
  if (!text) return [];
  // Reemplazar puntos abreviados conocidos antes del split.
  const protected_ = text
    .replace(/\bArt\./giu, 'Art@@')
    .replace(/\bExp\./giu, 'Exp@@')
    .replace(/\bN°\./giu, 'N°@@')
    .replace(/\bSr\./giu, 'Sr@@')
    .replace(/\bSra\./giu, 'Sra@@')
    .replace(/\bDr\./giu, 'Dr@@');
  const raw = protected_
    .split(/(?<=[.;])\s+(?=[A-ZÁÉÍÓÚÑ])/u)
    .map((s) => s.replace(/@@/g, '.').trim())
    .filter((s) => s.length > 0);
  return raw;
}

/**
 * Clasifica el tipo de decisión leyendo el verbo + contexto adyacente.
 */
function classifyDecision(sentence: string, verbMatch: string): VoteDecision {
  const v = verbMatch.toLowerCase();
  const isRechazo = /^rechaz/.test(v);
  const isDesecho = /^desech/.test(v);
  if (isRechazo) return 'rechazado';
  if (isDesecho) return 'desechado';

  // Es alguna forma de "aprobar". Refinar por contexto.
  if (DEBATE_2DO_DEF_RE.test(sentence)) return 'aprobado_2do_definitivo';
  if (DEBATE_2DO_RE.test(sentence)) return 'aprobado_2do_debate';
  if (DEBATE_1ER_RE.test(sentence)) return 'aprobado_1er_debate';
  if (MOCION_RE.test(sentence)) return 'aprobado_mocion';
  return 'aprobado';
}

/**
 * Parsea el texto completo de `metadata.resumen.acuerdos` y devuelve la
 * lista de votaciones identificables. Una oración con múltiples
 * expedientes emite un voto por cada uno (mismo conteo).
 *
 * @example
 * parseVotesFromAcuerdos("Se aprobó en segundo debate el expediente 24.998 con 52 votos a favor.")
 * // → [{ expediente:'24.998', decision:'aprobado_2do_debate', votos_a_favor:52, votos_en_contra:null, fuente_oracion:'...' }]
 */
/**
 * Regex laxa de fallback — captura cualquier `NN.NNN` en una oración SIN
 * requerir el anchor léxico ("expediente"/"proyecto"/etc). Solo se usa
 * cuando ya se confirmó que la oración tiene decisión Y al menos UN
 * expediente con anchor; entonces los demás NN.NNN cercanos son
 * probablemente expedientes adicionales mencionados en cascada
 * ("los expedientes 22.111 y 22.222") o entre paréntesis.
 *
 * Trade-off: puede capturar números de 5 dígitos que NO son expedientes
 * (códigos, fechas en formato YYYY-MM-DD, etc). Pero la pre-condición
 * "ya hay 1 expediente con anchor" limita el riesgo — esas oraciones
 * son votaciones formales, los números cercanos son del mismo dominio.
 */
const NUMERO_LAXO_RE = /\b(\d{2}[.,]\d{3})\b/g;

function normalizeNumero(raw: string): string {
  const digits = raw.replace(/[.,]/g, '');
  return `${digits.slice(0, 2)}.${digits.slice(2)}`;
}

export function parseVotesFromAcuerdos(text: string): ExtractedVote[] {
  if (!text || typeof text !== 'string') return [];
  const out: ExtractedVote[] = [];

  for (const sentence of splitSentences(text)) {
    const decisionMatch = DECISION_RE.exec(sentence);
    if (!decisionMatch) continue;

    const anchored = extractExpedienteMentions(sentence);
    if (anchored.length === 0) continue;

    // Cobertura adicional: en oraciones con plural "los expedientes X y Y",
    // el anchor solo precede al primero. Hacemos una segunda pasada laxa
    // y mergeamos sin perder los anchored.
    const seen = new Set<string>(anchored);
    const expedientes = [...anchored];
    NUMERO_LAXO_RE.lastIndex = 0;
    let lax: RegExpExecArray | null;
    while ((lax = NUMERO_LAXO_RE.exec(sentence)) !== null) {
      const n = normalizeNumero(lax[1]);
      if (!seen.has(n)) {
        seen.add(n);
        expedientes.push(n);
      }
    }

    const decision = classifyDecision(sentence, decisionMatch[1]);

    const favorMatch = VOTOS_FAVOR_RE.exec(sentence);
    const contraMatch = VOTOS_CONTRA_RE.exec(sentence);
    const votos_a_favor = parseNumber(favorMatch?.[1] ?? null);
    const votos_en_contra = parseNumber(contraMatch?.[1] ?? null);

    for (const exp of expedientes) {
      out.push({
        expediente: exp,
        decision,
        votos_a_favor,
        votos_en_contra,
        fuente_oracion: sentence,
      });
    }
  }

  return out;
}

/**
 * Renderiza un voto extraído como texto natural — usado como `content`
 * del chunk sintético. Diseñado para que Lexa lo cite de manera natural.
 */
export function renderVoteAsChunkContent(
  vote: ExtractedVote,
  ctx: { fecha: string | null; tipo_sesion: string | null },
): string {
  const decisionTexto: Record<VoteDecision, string> = {
    aprobado_1er_debate: 'Se aprobó en primer debate',
    aprobado_2do_debate: 'Se aprobó en segundo debate',
    aprobado_2do_definitivo: 'Se aprobó en segundo y definitivo debate',
    aprobado_mocion: 'Se aprobó moción relacionada',
    aprobado: 'Se aprobó',
    rechazado: 'Fue rechazado',
    desechado: 'Fue desechado',
  };

  const head = `RESULTADO DE VOTACIÓN OFICIAL — ${decisionTexto[vote.decision]} el expediente N° ${vote.expediente}`;

  const conteoPartes: string[] = [];
  if (vote.votos_a_favor != null) conteoPartes.push(`${vote.votos_a_favor} votos a favor`);
  if (vote.votos_en_contra != null) conteoPartes.push(`${vote.votos_en_contra} en contra`);
  const conteo = conteoPartes.length > 0 ? `con ${conteoPartes.join(', ')}` : '(votos no especificados en el acta resumida)';

  const sesionInfo = ctx.fecha
    ? `Acuerdo formal del ${ctx.tipo_sesion ?? 'Plenario'} del ${ctx.fecha}.`
    : `Acuerdo formal de la sesión.`;

  return `${head}, ${conteo}. ${sesionInfo} Fuente: resumen oficial de acuerdos.\n\nContexto: "${vote.fuente_oracion}"`;
}
