/**
 * ralChunker.ts — Parser del Reglamento de la Asamblea Legislativa COMENTADO.
 *
 * El RAL Comentado (PDF de la Asamblea, 5ta Edición) tiene esta estructura
 * jerárquica:
 *
 *   CAPÍTULO I — DE LOS DIPUTADOS
 *     Artículo 1.- Elección de diputados
 *     Artículo 2.- Suplentes
 *     ...
 *     Artículo 3.- Diputados miembros
 *       1.  (texto del inciso 1)
 *       2.  (texto del inciso 2)
 *         [Resoluciones de la Presidencia de la Asamblea Legislativa]
 *         Acta Sesión Plenaria Ordinaria 091 del 01-11-2012, pág. 44.
 *         El Presidente resolvió que ... (texto de la interpretación)
 *         [Sala Constitucional]
 *         Voto N° 2018-023456 ...
 *
 * El chunker:
 *   1. Detecta capítulos con CAPÍTULO|TÍTULO (para el campo `capitulo`).
 *   2. Parte el texto en bloques por artículo con regex ARTÍCULO N.-.
 *   3. Dentro de cada artículo, detecta incisos con patrón numérico.
 *   4. Dentro de cada inciso / artículo sin incisos, detecta los marcadores
 *      de interpretaciones oficiales y extrae cada interpretación + fuente.
 *
 * IMPORTANTE: el PDF del RAL Comentado es texto seleccionable (no OCR),
 * por lo que la extracción es robusta. pdfjs-dist ya lo maneja bien.
 *
 * Track F, Sprint 1 — 2026-05-14.
 */

// ─── Tipos públicos ────────────────────────────────────────────────────────────

export interface ChunkedRalArticulo {
  /** Número del artículo como string ('1', '137', 'TRANSITORIO I'). */
  numero: string;
  /** Número de inciso si la fila es un inciso específico, null si es el artículo. */
  inciso?: string;
  /** Capítulo al que pertenece. Ej: 'Capítulo II — De las sesiones'. */
  capitulo?: string;
  /** Título de sección dentro del capítulo (si existe). */
  tituloSeccion?: string;
  /** Texto normativo completo del artículo o inciso. */
  texto_normativo: string;
  /** Interpretaciones oficiales extraídas del comentario del RAL. */
  interpretaciones: ChunkedRalInterpretacion[];
  /** Número de página aproximado en el PDF de origen. */
  source_pagina: number;
}

export interface ChunkedRalInterpretacion {
  /** Texto completo de la interpretación / resolución / sentencia. */
  texto: string;
  /** Cita textual como aparece en el RAL Comentado.
   *  Ej: 'Acta Sesión Plenaria Ordinaria 091 del 01-11-2012, pág. 44' */
  fuente_cita?: string;
  /** Fecha extraída de la cita, cuando parseable. */
  fuente_fecha?: Date;
  /** Tipo de fuente. */
  fuente_tipo: 'resolucion_presidencia' | 'sentencia_sala_constitucional' | 'criterio_servicios_tecnicos' | 'otro';
}

// ─── Constantes ────────────────────────────────────────────────────────────────

/**
 * Regex principal para detectar el inicio de un artículo.
 * Ejemplos que matchea:
 *   "ARTÍCULO 1.-"   "ARTÍCULO 137 -"   "Artículo 3 .-"
 *   "ARTÍCULO 1o.-"  "TRANSITORIO I.-"  "ARTÍCULO 1° .-"
 *
 * Grupos capturados:
 *   [1] = número del artículo ('1', '137', 'TRANSITORIO I')
 *   [2] = resto de la línea (título del artículo)
 */
const RE_ARTICULO = /^(?:ART[IÍ]CULO|Artículo|Articulo)\s+([\w°º.]+(?:\s+[IVX]+)?)\s*[.·\-–—]*\s*[-–—]?\s*(.*)$/im;

/**
 * Regex para detectar el inicio de un inciso numerado dentro de un artículo.
 * El RAL Comentado usa: "1. texto", "2. texto", "a) texto", "a. texto"
 * SOLO al inicio de línea para evitar falsos positivos dentro del texto.
 *
 * Grupos:
 *   [1] = identificador del inciso ('1', '2', 'a', 'b')
 *   [2] = texto del inciso
 */
const RE_INCISO = /^(\d+|[a-z])[.)]\s+(.+)/m;

/**
 * Marcadores de secciones de interpretación en el RAL Comentado.
 * Aparecen como líneas propias antes del bloque de interpretación.
 */
const INTERPRETATION_MARKERS: Array<{
  pattern: RegExp;
  tipo: ChunkedRalInterpretacion['fuente_tipo'];
}> = [
  {
    pattern: /\[?Resoluciones?\s+de\s+la\s+Presidencia\b/i,
    tipo: 'resolucion_presidencia',
  },
  {
    pattern: /\[?Sala\s+Constitucional\b/i,
    tipo: 'sentencia_sala_constitucional',
  },
  {
    pattern: /\[?Servicios?\s+T[eé]cnicos?\b/i,
    tipo: 'criterio_servicios_tecnicos',
  },
  {
    // Procuraduría, Contraloría, otros
    pattern: /\[?(?:Procuradur[ií]a|Contralor[ií]a|otro)\b/i,
    tipo: 'otro',
  },
];

/**
 * Marcador de capítulo. Captura el texto del capítulo completo.
 * Grupo [1] = texto completo del capítulo.
 */
const RE_CAPITULO = /^(?:CAP[IÍ]TULO|T[IÍ]TULO)\s+(?:[IVX]+|\d+)[.\s]*[-–—]?\s*(.+)/im;

// ─── Utilidades internas ───────────────────────────────────────────────────────

/**
 * Intenta extraer la fecha de una cita como
 * "Acta Sesión Plenaria Ordinaria 091 del 01-11-2012, pág. 44"
 * o "Voto N° 2019-012345 de la Sala Constitucional del 22-03-2019"
 */
function extractFechaFromCita(cita: string): Date | undefined {
  // dd-mm-yyyy o dd/mm/yyyy
  const mDmy = cita.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (mDmy) {
    const [, d, m, y] = mDmy;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (!isNaN(date.getTime())) return date;
  }
  // yyyy-mm-dd
  const mYmd = cita.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (mYmd) {
    const [, y, m, d] = mYmd;
    const date = new Date(Number(y), Number(m) - 1, Number(d));
    if (!isNaN(date.getTime())) return date;
  }
  return undefined;
}

/**
 * Extrae la "fuente_cita" de un bloque de texto de interpretación.
 * La cita suele ser la primera línea del bloque o una línea que empieza
 * con "Acta", "Voto", "Resolución", "Sesión", "Expediente legislativo".
 */
function extractFuenteCita(texto: string): string | undefined {
  const lines = texto.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 3)) {
    if (/^(?:Acta|Voto|Resoluci[oó]n|Sesi[oó]n|Expediente|Circular)/i.test(line)) {
      return line;
    }
  }
  // Buscar inline con regex de cita acta
  const mActa = texto.match(/Acta\s+de\s+la\s+Sesi[oó]n\s+[^,\n]+,?\s*p[áa]g\.\s*\d+/i);
  if (mActa) return mActa[0].trim();
  // Buscar Voto N°
  const mVoto = texto.match(/Voto\s+N[°º]\s*\d+(?:-\d+)?(?:\s+de\s+[^.\n]+)?/i);
  if (mVoto) return mVoto[0].trim();
  return undefined;
}

// ─── Función principal ─────────────────────────────────────────────────────────

/**
 * Parsea el texto completo del RAL Comentado y retorna un array de
 * ChunkedRalArticulo — uno por artículo (o inciso, si se detectan incisos).
 *
 * @param fullText  Texto extraído del PDF por pdfjs-dist / pdfToText().
 *                  Debe ser texto seleccionable, NO OCR.
 *
 * @returns Array de artículos con sus interpretaciones adheridas.
 *          Orden: el mismo orden en que aparecen en el PDF (ascendente).
 *
 * @example
 *   const text = await pdfToText(pdfBuffer);
 *   const chunks = chunkRalComentado(text);
 *   // chunks[0] = { numero: '1', texto_normativo: '...', interpretaciones: [] }
 */
export function chunkRalComentado(fullText: string): ChunkedRalArticulo[] {
  const results: ChunkedRalArticulo[] = [];
  let currentCapitulo: string | undefined;

  // Partir el texto en líneas para iterar con índice de página aproximado.
  // Asumimos ~40 líneas por página en el RAL Comentado (A4, cuerpo 11pt).
  const lines = fullText.split('\n');
  const LINES_PER_PAGE = 40;

  // Bloque de texto del artículo actual que se está acumulando.
  let currentArticuloNumero: string | undefined;
  let currentArticuloTitulo = '';
  let currentArticuloLines: string[] = [];
  let currentArticuloStartLine = 0;

  function flushArticulo() {
    if (!currentArticuloNumero) return;

    const articuloText = currentArticuloLines.join('\n').trim();
    const pageApprox = Math.floor(currentArticuloStartLine / LINES_PER_PAGE) + 1;

    // Detectar si el artículo tiene incisos numerados.
    const incisoBlocks = splitIncisos(articuloText);

    if (incisoBlocks.length > 1) {
      // Artículo con incisos: emitir un chunk por inciso.
      for (const block of incisoBlocks) {
        const interpretaciones = extractInterpretaciones(block.texto);
        const textoNormativo = removeInterpretacionesSections(block.texto);
        results.push({
          numero: currentArticuloNumero!,
          inciso: block.inciso,
          capitulo: currentCapitulo,
          tituloSeccion: currentArticuloTitulo || undefined,
          texto_normativo: textoNormativo.trim() || articuloText.slice(0, 500),
          interpretaciones,
          source_pagina: pageApprox,
        });
      }
    } else {
      // Artículo sin incisos o inciso no detectado: un solo chunk.
      const interpretaciones = extractInterpretaciones(articuloText);
      const textoNormativo = removeInterpretacionesSections(articuloText);
      results.push({
        numero: currentArticuloNumero!,
        capitulo: currentCapitulo,
        tituloSeccion: currentArticuloTitulo || undefined,
        texto_normativo: textoNormativo.trim() || articuloText.slice(0, 2000),
        interpretaciones,
        source_pagina: pageApprox,
      });
    }

    currentArticuloNumero = undefined;
    currentArticuloTitulo = '';
    currentArticuloLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detectar capítulo.
    const capMatch = trimmed.match(RE_CAPITULO);
    if (capMatch) {
      currentCapitulo = capMatch[0].trim();
      continue;
    }

    // Detectar inicio de artículo.
    const artMatch = trimmed.match(RE_ARTICULO);
    if (artMatch) {
      // Guardar el artículo anterior antes de empezar el nuevo.
      flushArticulo();
      // Bug F-1 (smoke 2026-05-15): el regex de RE_ARTICULO permite captura
      // de '.' en `[\w°º.]+` (necesario para "1o" / "1°"), pero esto deja
      // numero = "137." con punto trailing. Limpiar antes de persistir.
      // Limpieza: quitar trailing '.', '-', '–', '—', '·'.
      currentArticuloNumero = artMatch[1].trim().replace(/[.\-–—·]+$/, '');
      currentArticuloTitulo = artMatch[2].trim();
      currentArticuloLines = [trimmed];
      currentArticuloStartLine = i;
      continue;
    }

    // Acumular líneas del artículo actual.
    if (currentArticuloNumero) {
      currentArticuloLines.push(line);
    }
  }

  // Último artículo pendiente.
  flushArticulo();

  return results;
}

// ─── Helpers internos ──────────────────────────────────────────────────────────

interface IncisoBlock {
  inciso: string;
  texto: string;
}

/**
 * Parte el texto de un artículo en bloques por inciso.
 * Solo aplica si el texto tiene incisos numerados con patrón "N. texto"
 * al inicio de línea.
 *
 * Si el artículo no tiene incisos, devuelve un array con un solo elemento
 * con inciso = undefined y todo el texto.
 */
function splitIncisos(articuloText: string): IncisoBlock[] {
  // Buscar todas las posiciones de inicio de inciso.
  const lines = articuloText.split('\n');
  const incisoStarts: Array<{ idx: number; inciso: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\d+|[a-z])[.)]\s+.{5,}/);
    if (m) {
      incisoStarts.push({ idx: i, inciso: m[1] });
    }
  }

  // Sin incisos detectados → retornar el texto completo como un solo bloque.
  if (incisoStarts.length < 2) {
    return [{ inciso: 'completo', texto: articuloText }];
  }

  const blocks: IncisoBlock[] = [];
  for (let k = 0; k < incisoStarts.length; k++) {
    const start = incisoStarts[k].idx;
    const end = k + 1 < incisoStarts.length ? incisoStarts[k + 1].idx : lines.length;
    const textoInciso = lines.slice(start, end).join('\n').trim();
    blocks.push({ inciso: incisoStarts[k].inciso, texto: textoInciso });
  }

  // Si hay texto antes del primer inciso (el artículo en sí antes de los incisos),
  // lo adjuntamos al primer inciso para no perderlo.
  if (incisoStarts[0].idx > 0) {
    const preambulo = lines.slice(0, incisoStarts[0].idx).join('\n').trim();
    if (preambulo) {
      blocks[0].texto = preambulo + '\n' + blocks[0].texto;
    }
  }

  return blocks;
}

/**
 * Extrae las interpretaciones oficiales de un bloque de texto
 * (artículo o inciso del RAL Comentado).
 *
 * Busca los marcadores de sección de interpretación y extrae el texto
 * que sigue hasta el siguiente marcador o fin del bloque.
 *
 * @param texto  Texto de un artículo o inciso, incluyendo las secciones
 *               de interpretación que siguen al texto normativo.
 *
 * @returns Array de interpretaciones extraídas. Vacío si no hay ninguna.
 */
export function extractInterpretaciones(texto: string): ChunkedRalInterpretacion[] {
  const result: ChunkedRalInterpretacion[] = [];
  const lines = texto.split('\n');

  let currentTipo: ChunkedRalInterpretacion['fuente_tipo'] | null = null;
  let currentBlock: string[] = [];

  function flushBlock() {
    if (!currentTipo || currentBlock.length === 0) return;
    const rawTexto = currentBlock.join('\n').trim();
    if (rawTexto.length < 20) return; // demasiado corto para ser interpretación real

    const fuente_cita = extractFuenteCita(rawTexto);
    const fuente_fecha = fuente_cita ? extractFechaFromCita(fuente_cita) : undefined;

    result.push({
      texto: rawTexto,
      fuente_cita,
      fuente_fecha,
      fuente_tipo: currentTipo,
    });

    currentBlock = [];
    currentTipo = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Detectar marcador de tipo de interpretación.
    let foundMarker = false;
    for (const marker of INTERPRETATION_MARKERS) {
      if (marker.pattern.test(trimmed)) {
        flushBlock();
        currentTipo = marker.tipo;
        // No incluir la línea del marcador en el bloque de texto.
        foundMarker = true;
        break;
      }
    }

    if (foundMarker) continue;

    // Si estamos dentro de un bloque de interpretación, acumular.
    if (currentTipo !== null) {
      currentBlock.push(line);
    }
  }

  flushBlock();
  return result;
}

/**
 * Remueve las secciones de interpretación del texto de un artículo/inciso
 * para quedarnos solo con el texto normativo.
 *
 * Corta el texto justo antes del primer marcador de interpretación.
 */
function removeInterpretacionesSections(texto: string): string {
  const lines = texto.split('\n');
  const cutIdx = lines.findIndex((line) =>
    INTERPRETATION_MARKERS.some((m) => m.pattern.test(line.trim()))
  );
  if (cutIdx === -1) return texto;
  return lines.slice(0, cutIdx).join('\n');
}

/**
 * Detecta si un bloque de texto es una resolución/sentencia jurídica
 * con estructura "POR TANTO" (Sala Constitucional, Procuraduría, etc.)
 * y devuelve solo encabezado + sección dispositiva.
 *
 * Usado por el ingest de los PDFs de resoluciones (no del RAL Comentado
 * en sí, sino de los PDFs de resoluciones de la Presidencia y sentencias).
 *
 * Ahorro típico: 85-90% de tokens vs. enviar el documento completo.
 *
 * @param fullDocText  Texto completo del documento jurídico.
 * @returns  Texto truncado: encabezado (primeros 1000 chars) + POR TANTO.
 */
export function extractPorTanto(fullDocText: string): string {
  const encabezado = fullDocText.slice(0, 1000);

  // Marcadores del dispositivo resolutivo, en orden de especificidad.
  const DISPOSITIVO_MARKERS = [
    /\bPOR\s+(?:LO\s+)?TANTO\b/i,
    /\bFALLO\b/i,
    /\bCONCLUSIONES?\b/i,
    /\bSE\s+RESUELVE\b/i,
    /\bSE\s+DECIDE\b/i,
    /\bRECOMIENDA\b/i,
  ];

  for (const marker of DISPOSITIVO_MARKERS) {
    const match = fullDocText.match(marker);
    if (match && match.index !== undefined) {
      const dispositivo = fullDocText.slice(match.index);
      if (dispositivo.length > 50) {
        // Retornar encabezado + dispositivo.
        // Si el encabezado ya está incluido en el dispositivo, no duplicar.
        if (match.index < 1000) {
          return fullDocText.slice(0, match.index + dispositivo.length);
        }
        return encabezado + '\n\n[...]\n\n' + dispositivo;
      }
    }
  }

  // No se encontró marcador → retornar texto completo (no es doc jurídico clásico).
  return fullDocText;
}
