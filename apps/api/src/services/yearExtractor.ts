/**
 * yearExtractor — detecta menciones de años en queries en español y
 * retorna rangos de fecha ISO aplicables como filtros en SIL.
 *
 * Por qué existe (Wave 4 #1, 2026-05-26):
 *   Corpus audit reveló que cuando el usuario dice "iniciativas de
 *   2018 sobre seguridad ciudadana", search_sil_expedientes hace
 *   semantic search global y devuelve expedientes de cualquier año
 *   ranqueados por similitud. El año 2018 NO pesa fuerte en el
 *   embedding → resultado: Lexa contesta "no encontré de 2018".
 *
 * Solución: hard-filter en SQL. Si extraemos un año del query, lo
 * convertimos a fecha_from/fecha_to ISO y forzamos WHERE en la
 * consulta a Supabase. El semantic search corre sobre el subset
 * filtrado, no sobre el universo entero.
 *
 * Patrones soportados:
 *   - "en 2018", "del 2018", "de 2018", "en el 2018", "del año 2018"
 *   - "entre 2018 y 2020", "del 2018 al 2020"
 *   - "antes de 2020"
 *   - "después de 2020", "desde 2020"
 *   - "2018-2020" (rango con guión)
 */

export interface DateRange {
  fecha_from?: string; // ISO YYYY-MM-DD
  fecha_to?: string; // ISO YYYY-MM-DD
}

const YEAR_RE = /\b(19|20)\d{2}\b/;
const VALID_YEAR_MIN = 1900;
const VALID_YEAR_MAX = 2100;

function isValidYear(y: number): boolean {
  return Number.isInteger(y) && y >= VALID_YEAR_MIN && y <= VALID_YEAR_MAX;
}

function startOfYear(y: number): string {
  return `${y}-01-01`;
}

function endOfYear(y: number): string {
  return `${y}-12-31`;
}

/**
 * Parsea la query para detectar menciones de año/años y devuelve
 * un rango de fechas ISO. Si no encuentra nada, retorna {} (sin filtro).
 *
 * Order matters — rangos explícitos (entre X y Y, antes de X) pesan
 * más que mención simple de año.
 */
export function extractDateRangeFromQuery(query: string): DateRange {
  const q = query.toLowerCase().trim();
  if (q.length === 0) return {};

  // 1. Rango "entre AAAA y AAAA" / "del AAAA al AAAA" / "AAAA-AAAA"
  const rangeMatch = q.match(
    /(?:entre|del?)\s+(?:el\s+a[ñn]o\s+)?(19\d{2}|20\d{2})\s+(?:y|al|hasta)\s+(?:el\s+a[ñn]o\s+)?(19\d{2}|20\d{2})|(19\d{2}|20\d{2})\s*[-–]\s*(19\d{2}|20\d{2})/,
  );
  if (rangeMatch) {
    const from = Number(rangeMatch[1] ?? rangeMatch[3]);
    const to = Number(rangeMatch[2] ?? rangeMatch[4]);
    if (isValidYear(from) && isValidYear(to)) {
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      return { fecha_from: startOfYear(lo), fecha_to: endOfYear(hi) };
    }
  }

  // 2. "antes de AAAA" / "hasta AAAA"
  const beforeMatch = q.match(/\b(?:antes\s+de|hasta(?:\s+el)?(?:\s+a[ñn]o)?)\s+(?:el\s+a[ñn]o\s+)?(19\d{2}|20\d{2})\b/);
  if (beforeMatch) {
    const y = Number(beforeMatch[1]);
    if (isValidYear(y)) {
      // "antes de 2020" → hasta el 2019. "hasta 2020" → incluye 2020.
      const isExclusive = /antes\s+de/.test(beforeMatch[0]);
      return { fecha_to: isExclusive ? endOfYear(y - 1) : endOfYear(y) };
    }
  }

  // 3. "después de AAAA" / "desde AAAA" / "a partir de AAAA"
  const afterMatch = q.match(/\b(?:despu[eé]s\s+de|desde|a\s+partir\s+de)\s+(?:el\s+a[ñn]o\s+)?(19\d{2}|20\d{2})\b/);
  if (afterMatch) {
    const y = Number(afterMatch[1]);
    if (isValidYear(y)) {
      const isExclusive = /despu[eé]s\s+de/.test(afterMatch[0]);
      return { fecha_from: startOfYear(isExclusive ? y + 1 : y) };
    }
  }

  // 4. Mención simple de año: "en 2018", "del 2018", "de 2018",
  //    "en el 2018", "del año 2018", o solo "2018" si está aislado.
  const simpleMatch = q.match(/\b(?:en|del?)\s+(?:el\s+)?(?:a[ñn]o\s+)?(19\d{2}|20\d{2})\b/);
  if (simpleMatch) {
    const y = Number(simpleMatch[1]);
    if (isValidYear(y)) {
      return { fecha_from: startOfYear(y), fecha_to: endOfYear(y) };
    }
  }

  // 5. Año aislado en la query (último recurso, sin contexto)
  //    Solo aplicamos si NO hay otros números que pudieran ser
  //    expedientes (e.g. "expediente 23234" no debería interpretar
  //    23234 como año).
  const isolatedMatches = [...q.matchAll(new RegExp(YEAR_RE.source, 'g'))];
  if (isolatedMatches.length === 1) {
    const y = Number(isolatedMatches[0][0]);
    if (isValidYear(y)) {
      // Verificamos que el año no esté inmediatamente precedido por
      // tokens como "ley n°", "art.", "exp.", "expediente" — que
      // sugieren que el número se refiere a algo más.
      const idx = isolatedMatches[0].index ?? -1;
      const before = q.slice(Math.max(0, idx - 30), idx).toLowerCase();
      if (!/\b(ley|art\.?|art[íi]culo|exp\.?|expediente|n°|n\.°|numero|número)\s*$/i.test(before)) {
        return { fecha_from: startOfYear(y), fecha_to: endOfYear(y) };
      }
    }
  }

  return {};
}
