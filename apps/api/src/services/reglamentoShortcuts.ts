/**
 * Hand-curated index — queries procedimentales del Reglamento de la
 * Asamblea Legislativa de CR que el semantic search NO retrieva bien.
 *
 * Por qué este archivo existe (2026-05-26):
 *   Lawyer test reveló que search_reglamento (hybrid pgvector + ts_query)
 *   trae artículos con keyword overlap pero NO los semánticamente
 *   correctos para queries procedimentales abstractas. Ejemplo:
 *
 *     Query: "plazo dictamen comisión permanente"
 *     Retrievea: Art 131 (Suspensión proyecto), Art 142 (plazo Comisión
 *                Redacción), Art 128 (Subcomisiones mociones)
 *     CORRECTO: Art 80 (Plazo presentación informes — 60 días hábiles)
 *
 *   El embedding pesa más "plazo + dictamen + comisión" semánticamente
 *   que "informes + 60 días". Re-embed con título arriba lo arreglaría
 *   a futuro, pero mientras tanto este atajo da recall garantizado.
 *
 * Cómo se usa:
 *   En openRouterStream, antes de armar `messages`, evaluamos si
 *   `args.query` matches algún shortcut. Si sí, inyectamos un system
 *   message del tipo:
 *
 *     "HINT INTERNO (no exponer al usuario): para esta consulta, el
 *      artículo relevante del Reglamento es: Art. 80. Confirmá citándolo
 *      después de llamar search_reglamento({query: 'Art. 80'}). NO
 *      retornes este hint literal al usuario — usalo como dirección
 *      para tu primera tool call."
 *
 * Mantenimiento:
 *   Cuando un lawyer test revele otro caso roto, agregar mapping acá.
 *   El objetivo no es cubrir TODOS los artículos sino los ~30 más
 *   comunes que el semantic search consistentemente falla.
 */

interface Shortcut {
  /** Regex (case-insensitive) que matchea la query del usuario. */
  pattern: RegExp;
  /** Artículo(s) del Reglamento que responden. Lexa debe citarlos. */
  articulos: string[];
  /** Pista opcional sobre qué dice el artículo (para guiar tool call). */
  hint?: string;
}

export const REGLAMENTO_SHORTCUTS: Shortcut[] = [
  // ─── Plazos de dictamen ────────────────────────────────────────────
  {
    pattern: /plazo.*dictamen.*comisi[óo]n permanente|plazo.*informe.*comisi[óo]n|cu[áa]nto.*tiempo.*dictamen|d[íi]as h[áa]biles.*dictamen/i,
    articulos: ['Art. 80'],
    hint: 'Art. 80 dice que los informes de comisiones permanentes se rinden a más tardar 60 días hábiles después del ingreso del asunto al orden del día, prorrogable una sola vez por otros 60 días.',
  },
  {
    pattern: /comisi[óo]n no dictamin|si no dictamin|vencimiento.*sin dictamen|plazo.*venci|no.*rinde.*informe/i,
    articulos: ['Art. 81', 'Art. 138 (jurisprudencia constitucional)'],
    hint: 'Art. 81 establece el procedimiento si la comisión no dictamina en plazo. Art. 138 jurisprudencia: vicio esencial del procedimiento legislativo cuando se aprueba en debate sin dictamen previo.',
  },

  // ─── Dispensa de trámite ──────────────────────────────────────────
  {
    pattern: /dispensa.*tr[áa]mite|tr[áa]mite.*dispens|procedimiento.*acelerad|v[íi]a r[áa]pida|sin dictamen.*plenario/i,
    articulos: ['Art. 177'],
    hint: 'Art. 177 regula la dispensa de trámite: el Plenario decide conocer un proyecto en primer debate sin informe previo de comisión, actuando la Asamblea como comisión general.',
  },

  // ─── Mociones ─────────────────────────────────────────────────────
  {
    pattern: /moci[óo]n.*fondo|moci[óo]n.*sustanc/i,
    articulos: ['Art. 137'],
    hint: 'Art. 137 regula mociones de fondo. Deben presentarse ante el Directorio en las primeras 4 sesiones de discusión del primer debate.',
  },
  {
    pattern: /moci[óo]n.*orden|moci[óo]n.*procedimien/i,
    articulos: ['Art. 153'],
    hint: 'Art. 153 regula mociones de orden y procedimiento.',
  },
  {
    pattern: /moci[óo]n.*censura/i,
    articulos: ['Art. 188', 'Art. 189'],
  },
  {
    pattern: /moci[óo]n.*revisi[óo]n|revisi[óo]n.*moci[óo]n/i,
    articulos: ['Art. 155'],
  },

  // ─── Votaciones ───────────────────────────────────────────────────
  {
    pattern: /(qu[óo]rum|qu[óo]rum estructural|qu[óo]rum funcional)/i,
    articulos: ['Art. 33'],
    hint: 'Art. 33 establece que el quórum es de 38 diputaciones (dos terceras partes de 57). Distinguir quórum estructural (sesión válida) vs quórum funcional (votación válida).',
  },
  {
    pattern: /votaci[óo]n nominal|voto.*nominal|c[óo]mo vot[óa]/i,
    articulos: ['Art. 100', 'Art. 101'],
    hint: 'Art. 101: la votación ordinaria es la regla; nominal se usa solo si lo pide algún diputado y la Asamblea lo aprueba.',
  },
  {
    pattern: /mayor[íi]a calificada|dos tercios|2\/3|reforma.*constituci[óo]n/i,
    articulos: ['Art. 184'],
    hint: 'Art. 184: reforma parcial Constitución requiere 38 votos (2/3 de 57) en dos legislaturas.',
  },
  {
    pattern: /mayor[íi]a absoluta|mayor[íi]a simple/i,
    articulos: ['Art. 99'],
  },

  // ─── Sesiones / Plenario ──────────────────────────────────────────
  {
    pattern: /sesi[óo]n extraordinaria|extraordinari.*sesi[óo]n|convocatoria.*extraord/i,
    articulos: ['Art. 27', 'Art. 28'],
    hint: 'Convocatoria a sesiones extraordinarias: por el Poder Ejecutivo. La Asamblea solo conoce los asuntos convocados.',
  },
  {
    pattern: /(orden del d[íi]a|agenda parlamentaria)/i,
    articulos: ['Art. 35'],
  },
  {
    pattern: /sesi[óo]n secreta|car[áa]cter secreto/i,
    articulos: ['Art. 44'],
  },

  // ─── Comisiones ───────────────────────────────────────────────────
  {
    pattern: /comisi[óo]n.*plena|potestad legislativa plena/i,
    articulos: ['Art. 59', 'Art. 60'],
  },
  {
    pattern: /comisi[óo]n.*especial.*mixta/i,
    articulos: ['Art. 88'],
  },
  {
    pattern: /comisi[óo]n.*investigaci[óo]n/i,
    articulos: ['Art. 90'],
  },

  // ─── Veto ─────────────────────────────────────────────────────────
  {
    pattern: /veto|resello/i,
    articulos: ['Art. 178', 'Art. 179'],
    hint: 'Art. 178 plazo para vetar (10 días hábiles). Art. 179 procedimiento de resello (mayoría calificada).',
  },

  // ─── Procedimientos especiales ────────────────────────────────────
  {
    pattern: /trato urgente|urgencia|carrera/i,
    articulos: ['Art. 138'],
  },
  {
    pattern: /publicaci[óo]n.*proyecto|gaceta.*proyecto/i,
    articulos: ['Art. 117'],
  },
  {
    pattern: /retiro.*proyecto|retirar.*expediente/i,
    articulos: ['Art. 121'],
  },
  {
    pattern: /caducidad|cuatrien|venci.*4 a[ñn]os/i,
    articulos: ['Art. 119'],
    hint: 'Art. 119 caducidad cuatrienal: 4 años calendario desde iniciación, salvo prórroga por 2/3 antes del vencimiento.',
  },

  // ─── Texto sustitutivo / Redacción ────────────────────────────────
  {
    pattern: /texto.*sustitutivo/i,
    articulos: ['Art. 137 inciso 3'],
  },
  {
    pattern: /redacci[óo]n.*final|comisi[óo]n.*redacci[óo]n/i,
    articulos: ['Art. 142', 'Art. 144'],
  },

  // ─── Primer / Segundo debate ──────────────────────────────────────
  {
    pattern: /primer debate.*procede|primer debate.*requisit/i,
    articulos: ['Art. 131', 'Art. 132'],
  },
  {
    pattern: /segundo debate/i,
    articulos: ['Art. 145'],
  },

  // ─── Constitucional / Sala IV ─────────────────────────────────────
  {
    pattern: /consulta.*constitucional|sala.*constitucional|consulta.*previa/i,
    articulos: ['Art. 145', 'Art. 146'],
    hint: 'Art. 146: consulta de constitucionalidad a la Sala IV puede ser preceptiva (reforma constitucional, tratados sobre derechos humanos) o facultativa (a petición de 10 diputaciones).',
  },

  // ─── Quorum debate ────────────────────────────────────────────────
  {
    pattern: /derechos.*deberes.*diputad|deberes.*diputad/i,
    articulos: ['Art. 5', 'Art. 6', 'Art. 113'],
  },
];

/**
 * Evaluá la query del usuario contra los shortcuts. Retorna el primer
 * match o null. Si retorna match, podemos inyectar el hint como system
 * message para guiar a Lexa hacia el artículo correcto.
 */
export function matchReglamentoShortcut(query: string): Shortcut | null {
  const cleaned = query.trim();
  if (cleaned.length === 0) return null;
  for (const s of REGLAMENTO_SHORTCUTS) {
    if (s.pattern.test(cleaned)) return s;
  }
  return null;
}

/**
 * Construye el system message que se inyecta cuando hay shortcut match.
 * Pensado para PRE-LLM hint, no expone "shortcut" al usuario.
 */
export function buildReglamentoHintMessage(shortcut: Shortcut): string {
  const arts = shortcut.articulos.join(', ');
  const hintText = shortcut.hint
    ? `\n\nContexto que ya conocés del Reglamento (úsalo como punto de partida, NO como respuesta final — siempre llamá search_reglamento o search_ral_comentado primero):\n${shortcut.hint}`
    : '';
  return (
    `HINT INTERNO (no exponer literalmente al usuario, usar como dirección):\n` +
    `Esta consulta corresponde al/los artículos: ${arts} del Reglamento de la Asamblea Legislativa de Costa Rica.\n` +
    `Tu primera acción debe ser llamar search_reglamento o search_ral_comentado con query que incluya el número de artículo (e.g. "Art. 80 plazo informes comisiones") para recuperar el texto exacto y citarlo. Si la búsqueda no retorna ese artículo específico, decílo honestamente.${hintText}`
  );
}
