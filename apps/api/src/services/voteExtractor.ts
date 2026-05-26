/**
 * voteExtractor — heurística para asociar chunks de votación
 * (`legislative_chunks` source_type='transcript') con el expediente que se
 * estaba discutiendo en ese momento.
 *
 * Por qué existe (Wave 4 #4, ref. lawyer audit L9):
 *   Transcript chunks miden ~3000 chars (~50s de audio) y se cortan por
 *   longitud, no por tema. El plenario discute un expediente N°, luego pasa
 *   minutos al debate, y eventualmente el diputado anuncia "votos a favor 30,
 *   en contra 10, se aprueba". La frase de votación y la mención original
 *   del expediente caen en chunks distintos — semántica retrieval del primer
 *   chunk falla porque no contiene el N° de expediente, y Lexa termina
 *   respondiendo "no encontré votación específica".
 *
 *   Esta lib provee dos funciones puras:
 *
 *   1. `extractExpedienteMentions(text)` — extrae N°s de expediente
 *      mencionados en un chunk. Patrones esperados:
 *      "expediente 24.567", "expediente N° 24.567", "expediente número 24.567",
 *      "el proyecto 24.567", "Exp. 24.567". Conservador en false-positives:
 *      números aislados ("el 24.567") NO se cuentan, requieren contexto léxico.
 *
 *   2. `isVoteChunk(text)` — detecta si el chunk contiene un anuncio de
 *      votación. Patrones esperados: "votos a favor", "votos en contra",
 *      "se aprueba", "se rechaza", "queda aprobado", "votación nominal", etc.
 *      Detecta resultado anunciado, NO intención previa ("vamos a votar" → false).
 *
 *   3. `linkVotesToExpedientes(chunks)` — orquestador que recorre los chunks
 *      en orden cronológico, mantiene un puntero al "expediente actual" (el
 *      más recientemente mencionado), y cuando aparece un vote chunk emite
 *      el linkage. Salida lista para UPDATE de `metadata.votando_expediente`.
 *
 * Falsos positivos aceptados:
 *   "Ley 24.567" — no es un expediente, pero matchearía si decimos
 *   "expediente 24.567". OK porque no usamos "Ley NNNN" — usamos
 *   "expediente NNN" precedido por la palabra clave.
 *
 *   "el expediente 12.345 y el 12.346" — ambos se capturan; el state
 *   machine usa el último mencionado para el linkage.
 */

/**
 * Regex de expediente: solamente cuando hay anclaje léxico delante
 * ("expediente", "proyecto", "exp.", "iniciativa"). Esto bloquea matches
 * espurios sobre números aislados de cinco dígitos que aparecen en debate
 * (fechas, cifras presupuestales, leyes existentes con número).
 *
 * Acepta formatos:
 *   - "expediente 24567" / "expediente 24.567" / "expediente 24,567"
 *   - "expediente N° 24.567" / "expediente número 24.567" / "expediente nº 24.567"
 *   - "exp. 24.567" / "exp 24.567"
 *   - "proyecto 24.567" (cuando se usa "proyecto" como sinónimo coloquial)
 *   - "iniciativa 24.567"
 */
const EXPEDIENTE_RE = /\b(?:expedientes?|proyectos?|exp\.?|iniciativas?)\s*(?:n(?:°|º|úmero|umero)?\s*)?(\d{2}[.,]?\d{3})\b/giu;

/**
 * Regex de chunk de votación: detecta el anuncio del resultado o el evento
 * mismo de la votación. Lista construida revisando lenguaje habitual del
 * plenario CR (manifiestamente:"se aprueba", "X votos a favor").
 *
 * Cubre:
 *   - "X votos a favor / en contra / afirmativos / negativos"
 *   - "se aprueba" / "se rechaza" / "queda aprobado" / "queda rechazado"
 *   - "votación nominal" / "votación afirmativa"
 *   - "por X votos" (cierre típico: "se aprueba por 38 votos")
 *
 * NO cubre (intencional):
 *   - "vamos a votar" / "someter a votación" → es intención, no resultado.
 *     El expediente se asocia al resultado, no al anuncio previo.
 */
const VOTE_RE = /\b(?:\d+\s+votos?\s+(?:a\s+favor|en\s+contra|afirmativos?|negativos?)|se\s+aprueba|se\s+rechaza|queda\s+(?:aprobad|rechazad|desechad|deshechad)[oa]|votaci[oó]n\s+(?:nominal|afirmativa|negativa)|por\s+\d+\s+votos)/iu;

export interface ChunkInput {
  /** ID del chunk en `legislative_chunks` — solo se devuelve, no se usa. */
  id: string;
  /** Orden cronológico dentro de la sesión (`chunk_index` o derived). */
  chunk_index: number;
  /** Texto del chunk para análisis. */
  content: string;
}

export interface VoteLinkage {
  /** chunk_id del chunk de votación que se va a enriquecer. */
  chunk_id: string;
  /** Expediente más recientemente mencionado antes (o dentro de) este chunk. */
  votando_expediente: string;
}

/**
 * Extrae todos los N°s de expediente mencionados en un texto. Devuelve en
 * orden de aparición, deduplicados (mantiene primera ocurrencia). Normaliza
 * el separador: "24,567" y "24567" se devuelven como "24.567".
 *
 * @example
 * extractExpedienteMentions("expediente 24.567 y exp. 24,568")
 * // → ["24.567", "24.568"]
 *
 * @example
 * extractExpedienteMentions("la Ley 8987 reforma el código")
 * // → []  (no hay "expediente"/"proyecto"/"exp" antes)
 */
export function extractExpedienteMentions(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Reset lastIndex en cada llamada — regex con /g mantiene estado.
  EXPEDIENTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPEDIENTE_RE.exec(text)) !== null) {
    // Normalizar separador: "24567" / "24,567" / "24.567" → "24.567"
    const raw = m[1].replace(/[.,]/g, '');
    if (raw.length < 5) continue;
    const normalized = `${raw.slice(0, 2)}.${raw.slice(2)}`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

/**
 * Determina si un chunk contiene un anuncio de votación. Match laxo: si
 * cualquiera de las frases de VOTE_RE aparece, marcamos true. Negativos:
 * "vamos a votar", "el proceso de votación", "votación pendiente".
 *
 * @example
 * isVoteChunk("Concluida la votación: 38 votos a favor, 0 en contra.")
 * // → true
 *
 * @example
 * isVoteChunk("Pasamos al siguiente expediente para votación.")
 * // → false
 */
export function isVoteChunk(text: string): boolean {
  if (!text) return false;
  return VOTE_RE.test(text);
}

/**
 * Orquestador puro. Recorre chunks en orden, mantiene state del expediente
 * más reciente, y emite linkage cuando detecta un vote chunk.
 *
 * Reglas:
 *   - Si el chunk ES vote AND tiene expediente mencionado dentro → usa el
 *     mencionado dentro (más específico que el del chunk anterior).
 *   - Si el chunk ES vote pero NO menciona expediente → usa el último visto.
 *   - Si no hay último expediente visto, el chunk se omite (sin linkage).
 *   - El state se mantiene a lo largo de TODA la sesión; un vote en chunk
 *     #50 puede referir al expediente mencionado en chunk #3 si en el medio
 *     no hubo otra mención.
 *
 *   Trade-off: para sesiones con múltiples votaciones intercaladas con
 *   debates de otros proyectos, el state puede "contaminarse" con menciones
 *   tangenciales ("ya votamos el 24.111 hace rato"). Aceptable porque:
 *   (1) tales referencias son raras, (2) el next vote chunk normalmente
 *   refresca el state con su propio expediente.
 *
 * @returns array de linkages — chunks vote sin expediente conocido NO
 *   aparecen (no podemos enriquecerlos).
 */
export function linkVotesToExpedientes(chunks: ChunkInput[]): VoteLinkage[] {
  const sorted = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);
  const linkages: VoteLinkage[] = [];
  let lastExpediente: string | null = null;

  for (const c of sorted) {
    const mentions = extractExpedienteMentions(c.content);
    if (mentions.length > 0) {
      // El último mencionado es el más reciente — relevante porque ese es
      // el que probablemente se vote a continuación.
      lastExpediente = mentions[mentions.length - 1];
    }
    if (isVoteChunk(c.content) && lastExpediente) {
      linkages.push({
        chunk_id: c.id,
        votando_expediente: lastExpediente,
      });
    }
  }

  return linkages;
}
