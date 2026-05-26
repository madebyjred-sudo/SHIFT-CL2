/**
 * Hand-curated shortcuts para queries sobre transcripciones plenarias
 * donde el semantic search (search_transcripts con embeddings) NO surface
 * el chunk relevante.
 *
 * Por qué este archivo existe (2026-05-26 Wave 2):
 *   Lawyer test L9 ("Qué expedientes fueron aprobados en segundo debate
 *   en la plenaria del 21 de mayo de 2026, y con qué votación") falló:
 *
 *   - Data EXISTE en DB: 35 segments del 21 may con votos ("56 votos
 *     a favor, cero en contra", "39 votos a favor", "53 votos a favor"...).
 *   - search_transcripts con k=12 NO los retrieva porque "votación" como
 *     concepto abstracto pesa cerca de discusión general legislativa,
 *     no de "N votos a favor".
 *
 * Solución: cuando la query es sobre votaciones específicas, inyectamos
 * un HINT INTERNO que le dice a Lexa cómo formular la búsqueda con
 * keywords explícitos ("votos a favor", "cero en contra") en vez de
 * la abstracción.
 */

interface TranscriptShortcut {
  /** Regex que matchea la query del usuario. */
  pattern: RegExp;
  /** Hint sobre cómo formular search_transcripts. */
  hint: string;
}

export const TRANSCRIPT_SHORTCUTS: TranscriptShortcut[] = [
  // ─── Votaciones específicas ─────────────────────────────────────
  {
    // 2026-05-26 Wave 3.1: hint REFORZADO para L9 fix. La versión Wave 2
    // era "sugestiva" — el modelo decidía si llamar search_transcripts
    // o no. En lawyer test L9, después de get_session_by_date el modelo
    // pensaba "ya tengo la sesión, fin" y NO llamaba search_transcripts.
    // Esta versión es directiva — exige la llamada explícita ANTES de
    // responder "no encontré votación".
    pattern: /votaci[óo]n|cu[áa]ntos votos|votos a favor|votos en contra|c[óo]mo vot[óa]|nominal|votaron a favor/i,
    hint:
      'CRÍTICO — QUERY DE VOTACIÓN ESPECÍFICA detectado.\n' +
      '\n' +
      'La pregunta del usuario pide CIFRAS de votación (cuántos votos a favor,\n' +
      'cuántos en contra, votación nominal). Las votaciones aparecen LITERAL en\n' +
      'las transcripciones como "56 votos a favor, cero en contra", "39 votos a\n' +
      'favor", "aprobado por X votos". El semantic search con queries abstractas\n' +
      'tipo "votación expedientes" NO surface esos chunks.\n' +
      '\n' +
      'PROTOCOLO OBLIGATORIO:\n' +
      '1. Si la query menciona una fecha de sesión: SIEMPRE llamá AMBAS tools en\n' +
      '   sequence — primero get_session_by_date(fecha) para contexto, luego\n' +
      '   search_transcripts({query: "votos a favor cero en contra", fecha_from:\n' +
      '   "YYYY-MM-DD", fecha_to: "YYYY-MM-DD"}) para los números literales.\n' +
      '2. Si search_transcripts retorna chunks con "N votos a favor", CITALOS\n' +
      '   tal cual con timecode.\n' +
      '3. Si search_transcripts retorna vacío DESPUÉS de la llamada explícita,\n' +
      '   entonces SÍ es válido decir "no encontré la votación específica".\n' +
      '4. NUNCA termines la respuesta diciendo "no encontré votación" sin haber\n' +
      '   llamado search_transcripts con el query keyword exacto arriba.\n' +
      '\n' +
      'Este protocolo aplica también cuando get_session_by_date ya devolvió un\n' +
      'resumen — el resumen ejecutivo NO contiene cifras de votación, solo\n' +
      'aprobaciones. Para los números hay que ir a las transcripciones literales.',
  },

  // ─── Mociones de censura ─────────────────────────────────────────
  {
    pattern: /moci[óo]n.*censura|cuestion.*confianza|interpel/i,
    hint:
      'BÚSQUEDA DE MOCIÓN DE CENSURA: search_transcripts con query incluyendo "moción de censura", "interpelación" o "presentar censura". Filtrar por fecha si se mencionó.',
  },

  // ─── Recursos / consultas Sala IV ───────────────────────────────
  {
    pattern: /consulta.*constitucional|sala.*constitucional.*sesi[óo]n|recurso.*sala/i,
    hint:
      'BÚSQUEDA DE CONSULTA SALA IV: search_transcripts con keywords "Sala Constitucional", "consulta facultativa" o "consulta preceptiva". A menudo aparece como "diez diputaciones firmamos consulta".',
  },

  // ─── Intervenciones de diputado específico ──────────────────────
  {
    pattern: /qu[ée] dijo.*diputad[oa]|intervenci[óo]n.*diputad/i,
    hint:
      'BÚSQUEDA DE INTERVENCIONES: si se busca lo que dijo X diputado, search_transcripts con su nombre exacto + apellido en query. Combinar con get_session_by_date si se mencionó fecha.',
  },

  // ─── Aprobaciones en debate ──────────────────────────────────────
  {
    // 2026-05-26: ampliado para capturar verbos conjugados ("se aprobó",
    // "aprobaron", "aprobamos"), revelado por test.
    pattern: /aprob[a-z]*.*(primer|segundo).*debate|debate.*aprob/i,
    hint:
      'BÚSQUEDA DE APROBACIÓN EN DEBATE: combinar 2 sources — (a) get_session_by_date(fecha) trae el resumen ejecutivo con aprobaciones; (b) search_transcripts con query "aprobado segundo debate" + fecha_from/to. Lexa debe usar AMBAS para respuesta completa.',
  },

  // ─── Mociones aprobadas / rechazadas ─────────────────────────────
  {
    pattern: /moci[óo]n.*aprob|moci[óo]n.*rechaz/i,
    hint:
      'BÚSQUEDA DE MOCIONES: search_transcripts con query "moción aprobada" o "moción rechazada". Suele ir junto a votación.',
  },
];

/**
 * Evalúa la query contra patrones de transcripts. Retorna primer match.
 */
export function matchTranscriptShortcut(query: string): TranscriptShortcut | null {
  const cleaned = query.trim();
  if (cleaned.length === 0) return null;
  for (const s of TRANSCRIPT_SHORTCUTS) {
    if (s.pattern.test(cleaned)) return s;
  }
  return null;
}

/**
 * Construye system message HINT para search_transcripts.
 */
export function buildTranscriptHintMessage(shortcut: TranscriptShortcut): string {
  return (
    `HINT INTERNO (no exponer literalmente al usuario, usar como dirección):\n` +
    shortcut.hint
  );
}
