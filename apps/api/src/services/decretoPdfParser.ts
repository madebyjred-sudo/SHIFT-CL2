/**
 * Parser de PDF de decreto ejecutivo de la Presidencia de Costa Rica.
 *
 * CONTEXTO (reunión cliente 2026-05-14, min 38:35-41:18, Carlos Villalobos):
 *   Los decretos tienen dos secciones principales:
 *     - "AMPLÍASE LA CONVOCATORIA" → lista de expedientes que entran a agenda
 *     - "RETÍRASE DE CONVOCATORIA" → lista de expedientes que salen de agenda
 *   Cada expediente aparece como "Expediente N.º 23.511 - Ley XYZ"
 *   (variantes: N.°, Nº, sin punto en miles, guión o coma antes del título).
 *
 * ESTRUCTURA TÍPICA DEL DECRETO (extraída de samples del GLCP):
 *   Encabezado: número de decreto, fecha, presidente/a firmante
 *   CONSIDERANDO...
 *   DECRETA:
 *   Artículo 1.— AMPLÍASE LA CONVOCATORIA A SESIONES EXTRAORDINARIAS...
 *   (lista de expedientes)
 *   Artículo 2.— RETÍRASE DE LA CONVOCATORIA A SESIONES EXTRAORDINARIAS...
 *   (lista de expedientes)
 *   Rige a partir de...
 *
 * ESTRATEGIA:
 *   1. Extraer texto plano del PDF con pdfjs-dist (ya en el proyecto).
 *   2. Regex para encabezado (número de decreto + fecha).
 *   3. Detectar secciones por regex de sección (AMPLÍASE / RETÍRASE).
 *   4. Dentro de cada sección, extraer números de expediente con regex.
 *   5. Calcular confianza: alta si ambas secciones o una sola clara,
 *      baja si texto muy corto o no matchea ninguna sección.
 *   6. LLM fallback (Gemini Flash) está PREPARADO pero NO implementado
 *      aún — ver Sprint 2 TODO. Por ahora: needs_manual_review=true
 *      cuando confidence < 0.7.
 *
 * DEPENDENCIAS:
 *   - pdfjs-dist (ya en apps/api/package.json v^4.10.38)
 *   - pdfExtractor.pdfToText (reutilizamos el extractor existente)
 *   - No deps nuevas necesarias.
 *
 * Source: Track D, Sprint 1. Jred 2026-05-14.
 */

import { pdfToText } from './pdfExtractor.js';
import { logger } from './logger.js';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

export interface DecretoParsed {
  /** Número oficial del decreto. null si no extraíble. */
  numero_decreto: string | null;

  /** Fecha de emisión del decreto. */
  fecha: Date;

  /** Tipo de acción del decreto. */
  tipo: 'ampliacion' | 'retiro' | 'mixto';

  /**
   * Números de expediente ampliados (añadidos a la convocatoria).
   * Formato normalizado: '23511' (sin puntos, sin espacios).
   */
  expedientes_ampliados: string[];

  /**
   * Números de expediente retirados de la convocatoria.
   * Formato normalizado: '23511'.
   */
  expedientes_retirados: string[];

  /**
   * Confianza del parser (0.0 – 1.0).
   * ≥ 0.7 → resultado confiable.
   * < 0.7 → needs_manual_review=true.
   */
  parser_confidence: number;

  /**
   * true cuando el resultado necesita revisión humana (baja confianza,
   * estructura no reconocida, o texto vacío).
   */
  needs_manual_review: boolean;

  /** Texto crudo extraído del PDF (para debugging y re-parseo). */
  raw_text?: string;
}

// ─── Regexes ──────────────────────────────────────────────────────────────────

/**
 * Número de decreto. Formatos observados en CR:
 *   "N.° 14518-MP"    "Nro. 14518"    "DECRETO N.° 14518"
 *   "DECRETO EJECUTIVO N° 14518-MP"   "14518-MP-MICITT"
 */
const RE_NUMERO_DECRETO = /(?:DECRETO\s+EJECUTIVO\s+)?N[°\.º]?\s*\.?\s*(\d{4,6}[-\w]*)/i;

/**
 * Fecha del decreto. Formatos observados:
 *   "San José, a los diecisiete días del mes de mayo del dos mil veintiséis"
 *   "San José, 17 de mayo de 2026"
 *   (también en el encabezado como "Dado en ... a ... de ... de 2026")
 * Capturamos el año primero — suficiente para armar la fecha.
 * Para la fecha completa intentamos mes textual + número de día.
 */
const RE_FECHA_COMPLETA = /(\d{1,2})\s+(?:de\s+)?([a-záéíóúü]+)\s+(?:de(?:l)?|del)\s+(?:año\s+)?(\d{4})/i;

/** "...diecisiete días del mes de mayo del dos mil veintiséis..." — fecha en letras */
const RE_FECHA_EN_LETRAS = /días?\s+del\s+mes\s+de\s+([a-záéíóúü]+)\s+del?\s+(dos\s+mil\s+[a-záéíóúü\s]+)/i;

/** Sección de ampliación. Variantes: AMPLÍASE, AMPLIASE, ampliación */
const RE_SECCION_AMPLIACION = /AMPL[IÍ]A(?:SE|N)?\s+LA\s+CONVOCATORIA/i;

/** Sección de retiro. Variantes: RETÍRASE, RETIRASE, RETIRA */
const RE_SECCION_RETIRO = /RET[IÍ]R[AE](?:SE|N)?\s+(?:DE\s+)?LA\s+CONVOCATORIA|RET[IÍ]R[AE](?:SE|N)?\s+DE\s+CONVOCATORIA/i;

/**
 * Número de expediente. Formatos observados en decretos CR:
 *   "Expediente N.º 23.511"    "Exp. N° 24,696"    "expediente 23511"
 *   "Expediente Nro. 23.511"   "N.° 23.511"        "expediente número 23.511"
 *   También aparecen en listas: "23.511 – Proyecto de Ley..."
 * Capturamos el número bruto; normalizamos quitando puntos/comas.
 */
const RE_EXPEDIENTE = /(?:(?:Expediente|Exp\.?)\s+(?:N[.°º]?\.?\s*|Nro\.?\s*|número\s*)?|N[.°º]\.?\s*)(\d{1,2}[.,]?\d{3})/gi;

/** Fallback: línea que empiece con número de 5 dígitos (posiblemente con punto en miles) */
const RE_EXPEDIENTE_LINEA = /^\s*(\d{1,2}[.,]?\d{3})\s*[-–—]/gm;

// ─── Meses en español → número ────────────────────────────────────────────────

const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4,
  mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Convierte nombre de mes en español a su número (1-12). 0 si no reconocido. */
function mesNombre(nombre: string): number {
  return MESES[nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')] ?? 0;
}

// ─── Números en palabras → número (solo los que aparecen en decretos) ─────────

/**
 * Convierte una frase de número en letras a número.
 * Cobertura: 2000-2050 (rango útil para fechas de decretos CR).
 */
function letrasANumero(texto: string): number | null {
  const t = texto.toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '');

  const mapUnidades: Record<string, number> = {
    'uno': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5,
    'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10,
    'once': 11, 'doce': 12, 'trece': 13, 'catorce': 14,
    'quince': 15, 'dieciseis': 16, 'diecisiete': 17, 'dieciocho': 18,
    'diecinueve': 19, 'veinte': 20, 'veintiuno': 21, 'veintidos': 22,
    'veintitres': 23, 'veinticuatro': 24, 'veinticinco': 25,
    'veintiseis': 26, 'veintisiete': 27, 'veintiocho': 28,
    'veintinueve': 29, 'treinta': 30,
    'treinta y uno': 31,
  };

  // "dos mil veintiséis" → 2026
  if (t.startsWith('dos mil')) {
    const resto = t.replace('dos mil', '').trim();
    if (!resto) return 2000;
    const unidad = mapUnidades[resto];
    if (unidad !== undefined) return 2000 + unidad;
    // "dos mil veintiseis" → unidad map debería cubrirlo
    for (const [clave, val] of Object.entries(mapUnidades)) {
      if (resto.startsWith(clave)) return 2000 + val;
    }
    return null;
  }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normaliza número de expediente al formato canónico del SIL: "XX.NNN".
 * El SIL usa "22.293" (punto separador de miles) como formato oficial.
 * Input puede ser "23511", "23.511", "23,511".
 * Output: "23.511"
 */
function normalizarExpediente(raw: string): string {
  const soloDigitos = raw.replace(/[.,\s]/g, '');
  if (soloDigitos.length <= 3) return soloDigitos;
  const prefijo = soloDigitos.slice(0, -3);
  const sufijo = soloDigitos.slice(-3);
  return `${prefijo}.${sufijo}`;
}

/** Extrae todos los números de expediente de un bloque de texto. */
function extraerExpedientes(bloque: string): string[] {
  const numeros = new Set<string>();

  // Intento principal: "Expediente N.º 23.511"
  for (const m of bloque.matchAll(RE_EXPEDIENTE)) {
    if (m[1]) numeros.add(normalizarExpediente(m[1]));
  }

  // Fallback: líneas que empiezan con número (listas sueltas en el decreto)
  if (numeros.size === 0) {
    for (const m of bloque.matchAll(RE_EXPEDIENTE_LINEA)) {
      if (m[1]) numeros.add(normalizarExpediente(m[1]));
    }
  }

  return [...numeros];
}

/**
 * Divide el texto en secciones basadas en los headers de decreto.
 * Retorna { ampliacion: string, retiro: string, resto: string }.
 */
function dividirEnSecciones(texto: string): {
  ampliacion: string;
  retiro: string;
  tieneAmpliacion: boolean;
  tieneRetiro: boolean;
} {
  const posAmpliacion = texto.search(RE_SECCION_AMPLIACION);
  const posRetiro = texto.search(RE_SECCION_RETIRO);

  const tieneAmpliacion = posAmpliacion !== -1;
  const tieneRetiro = posRetiro !== -1;

  let ampliacion = '';
  let retiro = '';

  if (tieneAmpliacion && tieneRetiro) {
    if (posAmpliacion < posRetiro) {
      // Orden normal: ampliación primero, retiro después
      ampliacion = texto.slice(posAmpliacion, posRetiro);
      retiro = texto.slice(posRetiro);
    } else {
      // Orden invertido: retiro primero, ampliación después
      retiro = texto.slice(posRetiro, posAmpliacion);
      ampliacion = texto.slice(posAmpliacion);
    }
  } else if (tieneAmpliacion) {
    ampliacion = texto.slice(posAmpliacion);
  } else if (tieneRetiro) {
    retiro = texto.slice(posRetiro);
  }

  return { ampliacion, retiro, tieneAmpliacion, tieneRetiro };
}

/**
 * Extrae la fecha del texto del decreto.
 * Intenta múltiples estrategias en orden de confianza.
 * Retorna { fecha: Date | null, confidence_penalty: number }.
 */
function extraerFecha(texto: string): { fecha: Date | null; penalidad: number } {
  // Estrategia 1: fecha en formato "17 de mayo de 2026" o "17 de mayo del 2026"
  const m1 = texto.match(RE_FECHA_COMPLETA);
  if (m1 && m1[1] && m1[2] && m1[3]) {
    const dia = parseInt(m1[1], 10);
    const mes = mesNombre(m1[2]);
    const anio = parseInt(m1[3], 10);
    if (mes > 0 && dia >= 1 && dia <= 31 && anio >= 2000 && anio <= 2100) {
      return { fecha: new Date(anio, mes - 1, dia), penalidad: 0 };
    }
  }

  // Estrategia 2: fecha en letras "días del mes de mayo del dos mil veintiséis"
  const m2 = texto.match(RE_FECHA_EN_LETRAS);
  if (m2 && m2[1] && m2[2]) {
    const mes = mesNombre(m2[1]);
    const anio = letrasANumero(m2[2]);
    if (mes > 0 && anio !== null && anio >= 2000) {
      // Sin día concreto → usamos día 1 del mes como aproximación
      return { fecha: new Date(anio, mes - 1, 1), penalidad: 0.05 };
    }
  }

  // Fallback: solo año en el texto
  const mAnio = texto.match(/\b(20\d{2})\b/);
  if (mAnio && mAnio[1]) {
    const anio = parseInt(mAnio[1], 10);
    // Fecha aproximada — penalizamos confianza
    return { fecha: new Date(anio, 0, 1), penalidad: 0.2 };
  }

  return { fecha: null, penalidad: 0.5 };
}

// ─── Función principal ────────────────────────────────────────────────────────

// Fallback patterns from FileLeafRef (Sprint v3 smoke 2026-05-15 bug D-1).
// Los decretos del SharePoint tienen filenames consistentes:
//   "DECRETO AMPLIACIÓN 44750-MP 12-11-2024.pdf"
//   "DECRETO DE RETIRO & AMPLIACIÓN 45461-MP  21-01-2026.pdf"
// Cuando el regex sobre el texto del PDF falla (PDF escaneado, formato raro),
// el filename suele traer ambos datos. Es una heurística determinística +
// menos costosa que invocar LLM fallback.
const RE_NUMERO_FROM_FILENAME = /(\d{4,6}-[A-Z]{1,5})/;
const RE_FECHA_FROM_FILENAME = /(\d{1,2})-(\d{1,2})-(\d{4})/;

function extractFromFilename(fileLeafRef: string): {
  numero?: string;
  fecha?: Date;
} {
  const numeroMatch = fileLeafRef.match(RE_NUMERO_FROM_FILENAME);
  const fechaMatch = fileLeafRef.match(RE_FECHA_FROM_FILENAME);
  const numero = numeroMatch?.[1];
  let fecha: Date | undefined;
  if (fechaMatch) {
    const [_, dd, mm, yyyy] = fechaMatch;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (!Number.isNaN(d.getTime())) fecha = d;
  }
  return { numero, fecha };
}

/**
 * Parsea el PDF de un decreto ejecutivo y extrae su estructura semántica.
 *
 * @param pdfBuffer - Buffer del PDF descargado del SharePoint GLCP.
 * @param opts.fileLeafRef - Nombre del archivo (sin path). Si está disponible,
 *   se usa como FALLBACK para extraer número y fecha cuando el regex sobre el
 *   texto del PDF falla. Crítico para PDFs escaneados o con encabezados raros.
 * @returns DecretoParsed con los campos extraídos y metadatos de confianza.
 */
export async function parseDecretoPdf(
  pdfBuffer: Buffer,
  opts: { fileLeafRef?: string } = {},
): Promise<DecretoParsed> {
  // ── Paso 1: PDF → texto plano ──────────────────────────────────────────────
  let rawText = '';
  try {
    rawText = await pdfToText(pdfBuffer);
  } catch (err) {
    logger.warn('[decretoPdfParser] pdfToText failed — returning low-confidence result', { error: (err as Error).message });
  }

  // Fallback desde filename (bug D-1 del smoke 2026-05-15). Lo calculamos
  // al inicio porque sirve aunque el PDF sea escaneado.
  const fromFilename = opts.fileLeafRef ? extractFromFilename(opts.fileLeafRef) : {};

  if (!rawText || rawText.trim().length < 50) {
    // PDF scaneado o dañado — pero podemos rescatar número y fecha del filename
    // si está disponible. Eso reduce la penalidad y deja el row utilizable.
    return {
      numero_decreto: fromFilename.numero ?? null,
      fecha: fromFilename.fecha ?? new Date(),
      tipo: 'ampliacion',
      expedientes_ampliados: [],
      expedientes_retirados: [],
      parser_confidence: fromFilename.numero || fromFilename.fecha ? 0.3 : 0.0,
      needs_manual_review: true,
      raw_text: rawText,
    };
  }

  let penalidad = 0.0;

  // ── Paso 2: Número de decreto ──────────────────────────────────────────────
  let numero_decreto: string | null = null;
  const mNumero = rawText.match(RE_NUMERO_DECRETO);
  if (mNumero && mNumero[1]) {
    numero_decreto = mNumero[1].trim();
  } else if (fromFilename.numero) {
    // Fallback al filename — confianza media, no es del texto autoritativo.
    numero_decreto = fromFilename.numero;
    penalidad += 0.02; // Casi sin penalización porque el filename es controlado por la Asamblea.
  } else {
    penalidad += 0.05;
  }

  // ── Paso 3: Fecha ──────────────────────────────────────────────────────────
  const { fecha: fechaExtraida, penalidad: penFecha } = extraerFecha(rawText);
  // Si extracción del texto falló pero tenemos fecha en filename, usarla.
  const fecha = fechaExtraida ?? fromFilename.fecha ?? new Date();
  if (!fechaExtraida && fromFilename.fecha) {
    penalidad += 0.02; // Pequeña penalización — filename fallback
  } else {
    penalidad += penFecha;
  }

  // ── Paso 4: Secciones y expedientes ───────────────────────────────────────
  const { ampliacion, retiro, tieneAmpliacion, tieneRetiro } = dividirEnSecciones(rawText);

  const expedientes_ampliados = tieneAmpliacion ? extraerExpedientes(ampliacion) : [];
  const expedientes_retirados = tieneRetiro ? extraerExpedientes(retiro) : [];

  // ── Paso 5: Tipo de decreto ────────────────────────────────────────────────
  let tipo: 'ampliacion' | 'retiro' | 'mixto';
  if (tieneAmpliacion && tieneRetiro) {
    tipo = 'mixto';
  } else if (tieneRetiro) {
    tipo = 'retiro';
  } else {
    tipo = 'ampliacion'; // Default — la mayoría son ampliaciones
  }

  // ── Paso 6: Penalizaciones por estructura ──────────────────────────────────

  // Si no encontramos ninguna sección reconocida, estructura desconocida
  if (!tieneAmpliacion && !tieneRetiro) {
    penalidad += 0.4;
    logger.warn('[decretoPdfParser] no section headers found — needs manual review', {
      textLength: rawText.length,
      preview: rawText.slice(0, 200),
    });
  }

  // Si sí hay sección pero no expedientes, probablemente formato raro
  if (tieneAmpliacion && expedientes_ampliados.length === 0) penalidad += 0.15;
  if (tieneRetiro && expedientes_retirados.length === 0) penalidad += 0.15;

  // Si hay muy pocos expedientes en total para un decreto de ampliación,
  // puede ser un decreto de retiro de un solo proyecto — no es error, no penalizamos.

  // ── Paso 7: Calcular confianza ─────────────────────────────────────────────
  const parser_confidence = Math.max(0.0, Math.min(1.0, 1.0 - penalidad));
  const needs_manual_review = parser_confidence < 0.7;

  if (needs_manual_review) {
    logger.warn('[decretoPdfParser] low confidence — flagging for manual review', {
      parser_confidence,
      penalidad,
      tieneAmpliacion,
      tieneRetiro,
      expedientes_ampliados: expedientes_ampliados.length,
      expedientes_retirados: expedientes_retirados.length,
    });
  } else {
    logger.info('[decretoPdfParser] parsed decree successfully', {
      numero_decreto,
      tipo,
      expedientes_ampliados: expedientes_ampliados.length,
      expedientes_retirados: expedientes_retirados.length,
      parser_confidence,
    });
  }

  return {
    numero_decreto,
    fecha,
    tipo,
    expedientes_ampliados,
    expedientes_retirados,
    parser_confidence,
    needs_manual_review,
    raw_text: rawText,
  };
}

// ─── TODO Sprint 2: LLM fallback ─────────────────────────────────────────────
// Cuando needs_manual_review=true, invocar Gemini Flash Lite con el raw_text
// y un prompt estructurado para extraer: tipo, fecha, lista de expedientes.
// El resultado del LLM se usa solo si su confianza (self-reported en el JSON)
// es > 0.8. Resultado se guarda en decretos_ejecutivos con parser_status='done'
// y un flag llm_assisted=true.
//
// Implementación pendiente para Sprint 2 — no bloquea Sprint 1 porque el
// dataset de 201 decretos tiene formato muy consistente en los samples.
