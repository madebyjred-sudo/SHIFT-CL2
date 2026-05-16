/**
 * ordenDiaSectionParser.ts — pedido 16c del cliente.
 *
 * Pedido 16c (Jred, 35:14):
 *   "Yo desearía que cuando me pase la lista del orden del día, ahí sí me
 *    me detalle dónde está, en cuál capítulo está, si está en primero,
 *    segundo o tercer debate."
 *
 * El parser secciona automáticamente el texto del orden del día en los
 * tres capítulos del reglamento (Asamblea Legislativa CR):
 *
 *   CAPÍTULO PRIMERO — Discusión y aprobación del Acta
 *   CAPÍTULO SEGUNDO — Suspensión de derechos y garantías constitucionales,
 *                      régimen interior de la Asamblea, etc.
 *   CAPÍTULO TERCERO — Discusión de Proyectos de Ley
 *
 * Dentro de cada capítulo se identifican subsecciones cuando aplica:
 *   PRIMER DEBATE / SEGUNDO DEBATE / TERCER DEBATE.
 *
 * Por cada expediente listado, se devuelve {numero, titulo, debate, capitulo}
 * para que la matriz pueda decir exactamente "el expediente 23.511 está en
 * SEGUNDO DEBATE en el CAPÍTULO TERCERO de la sesión del 14/05/2026".
 */

export type CapituloLabel =
  | 'capitulo_primero'
  | 'capitulo_segundo'
  | 'capitulo_tercero'
  | 'sin_clasificar';

export type DebateLabel =
  | 'primer_debate'
  | 'segundo_debate'
  | 'tercer_debate'
  | 'mocion_orden'
  | 'sin_clasificar';

export interface OrdenDiaEntry {
  expediente_numero: string;
  titulo: string;
  capitulo: CapituloLabel;
  capitulo_titulo: string;
  debate: DebateLabel;
  /** posición absoluta en el texto, útil para citar el documento */
  offset: number;
}

export interface OrdenDiaSection {
  capitulo: CapituloLabel;
  titulo: string;
  /** texto crudo de la sección, sin parsear */
  raw_text: string;
  /** texto detectado al inicio de la sección (ej. "CAPÍTULO PRIMERO"). */
  encabezado: string;
  /** entries detectados dentro de la sección */
  entries: OrdenDiaEntry[];
}

export interface ParsedOrdenDia {
  /** todas las entradas en orden secuencial */
  entries: OrdenDiaEntry[];
  /** secciones detectadas (puede haber 0..N) */
  sections: OrdenDiaSection[];
  /** mensajes de diagnóstico */
  warnings: string[];
}

// ─── Regex constants ─────────────────────────────────────────────────────────

// Just the marker. Including trailing context in the regex causes
// `matchAll` con `g` flag a saltarse el siguiente CAPÍTULO si está dentro
// de los siguientes 200 chars — el slice por boundaries ya lee el contexto.
const RE_CAPITULO = /\bCAP[IÍ]TULO\s+(PRIMERO|SEGUNDO|TERCERO|I{1,3})\b/gm;

const RE_DEBATE: Record<DebateLabel, RegExp> = {
  primer_debate: /\bPRIMER(?:OS?)?\s+DEBATE/,
  segundo_debate: /\bSEGUNDO(?:S?)\s+DEBATE/,
  tercer_debate: /\bTERCER(?:OS?)?\s+DEBATE/,
  mocion_orden: /\bMOCIONES?\s+DE\s+ORDEN\b/,
  sin_clasificar: /^$/,
};

// expediente numero patrón canónico CR: 2-5 dígitos + "." + 3 dígitos (ej "23.511")
const RE_EXPEDIENTE = /\b(\d{2,5}\.\d{3})\b/g;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeCapituloLabel(raw: string): CapituloLabel {
  const u = raw.trim().toUpperCase();
  if (/PRIMERO|^I$/.test(u)) return 'capitulo_primero';
  if (/SEGUNDO|^II$/.test(u)) return 'capitulo_segundo';
  if (/TERCERO|^III$/.test(u)) return 'capitulo_tercero';
  return 'sin_clasificar';
}

function detectDebate(snippet: string): DebateLabel {
  if (RE_DEBATE.primer_debate.test(snippet)) return 'primer_debate';
  if (RE_DEBATE.segundo_debate.test(snippet)) return 'segundo_debate';
  if (RE_DEBATE.tercer_debate.test(snippet)) return 'tercer_debate';
  if (RE_DEBATE.mocion_orden.test(snippet)) return 'mocion_orden';
  return 'sin_clasificar';
}

/** Cleans line/page breaks into single spaces, leaves text otherwise intact. */
function normalizeWhitespace(text: string): string {
  return text.replace(/[\t ]/g, ' ').replace(/\r/g, '');
}

// ─── Main parser ─────────────────────────────────────────────────────────────

export function parseOrdenDia(rawText: string): ParsedOrdenDia {
  const text = normalizeWhitespace(rawText);
  const warnings: string[] = [];
  const sections: OrdenDiaSection[] = [];

  // 1) find all CAPÍTULO markers
  const capituloMatches = [...text.matchAll(RE_CAPITULO)];
  if (capituloMatches.length === 0) {
    warnings.push('no_capitulo_markers_found');
  }

  // 2) slice text by capitulo boundaries
  for (let i = 0; i < capituloMatches.length; i++) {
    const m = capituloMatches[i];
    if (!m || m.index === undefined) continue;
    const next = capituloMatches[i + 1];
    const sliceEnd = next?.index ?? text.length;
    const slice = text.slice(m.index, sliceEnd);
    const headerLine = slice.split('\n')[0]?.trim() ?? '';
    const capLabel = normalizeCapituloLabel(m[1] ?? '');

    sections.push({
      capitulo: capLabel,
      titulo: headerLine,
      raw_text: slice,
      encabezado: headerLine,
      entries: [],
    });
  }

  // 3) if no sections detected, fall back to a single "sin_clasificar" bucket
  if (sections.length === 0) {
    sections.push({
      capitulo: 'sin_clasificar',
      titulo: '(sin secciones detectadas)',
      raw_text: text,
      encabezado: '',
      entries: [],
    });
  }

  // 4) attach expediente entries to each section, with debate sub-detection
  const allEntries: OrdenDiaEntry[] = [];
  for (const section of sections) {
    const expMatches = [...section.raw_text.matchAll(RE_EXPEDIENTE)];
    for (const em of expMatches) {
      if (em.index === undefined) continue;
      const numero = em[1] ?? '';

      // Snippet around the match — gives us debate signal + titulo guess
      const snippetStart = Math.max(0, em.index - 240);
      const snippetEnd = Math.min(section.raw_text.length, em.index + 240);
      const snippet = section.raw_text.slice(snippetStart, snippetEnd);

      const debate = detectDebate(snippet);

      // Titulo guess: extract from end of numero up to next expediente OR
      // up to next debate marker OR up to ~360 chars, whichever comes first.
      // Sin este corte por marker el titulo "se chorrea" al siguiente bloque.
      const afterStart = em.index + numero.length;
      const afterRaw = section.raw_text.slice(afterStart, afterStart + 800);
      // Find earliest cutoff in afterRaw
      const reNextExp = /\b\d{2,5}\.\d{3}\b/;
      const reDebateMarker = /\b(PRIMER(?:OS?)?|SEGUNDO(?:S?)|TERCER(?:OS?)?)\s+DEBATE\b|\bMOCIONES?\s+DE\s+ORDEN\b|\bCAP[IÍ]TULO\s+(PRIMERO|SEGUNDO|TERCERO)\b/;
      const nextExpMatch = reNextExp.exec(afterRaw);
      const nextDebateMatch = reDebateMarker.exec(afterRaw);
      let cutoff = afterRaw.length;
      if (nextExpMatch?.index !== undefined) cutoff = Math.min(cutoff, nextExpMatch.index);
      if (nextDebateMatch?.index !== undefined) cutoff = Math.min(cutoff, nextDebateMatch.index);
      const titulo = afterRaw
        .slice(0, cutoff)
        .replace(/^[\s\-–—:.,]+/, '')
        .replace(/\s+/g, ' ')
        .slice(0, 240)
        .trim();

      const entry: OrdenDiaEntry = {
        expediente_numero: numero,
        titulo: titulo || '(sin título extraído)',
        capitulo: section.capitulo,
        capitulo_titulo: section.titulo,
        debate,
        offset: em.index,
      };
      section.entries.push(entry);
      allEntries.push(entry);
    }
  }

  // 5) de-dup by (numero+capitulo): the same expediente can list twice if
  //    "Conoce y se aprueba..." appears in both header + ranking grid.
  const seen = new Set<string>();
  const dedupEntries: OrdenDiaEntry[] = [];
  for (const e of allEntries) {
    const key = `${e.expediente_numero}|${e.capitulo}|${e.debate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupEntries.push(e);
  }
  // Replace per-section entries with dedup'd subset
  for (const section of sections) {
    section.entries = section.entries.filter((e) =>
      dedupEntries.some(
        (d) =>
          d.expediente_numero === e.expediente_numero &&
          d.capitulo === e.capitulo &&
          d.debate === e.debate &&
          d.offset === e.offset,
      ),
    );
  }

  return {
    entries: dedupEntries,
    sections,
    warnings,
  };
}
