/**
 * fechaDictamenBoldDetector — Pedido 16g del cliente CL2.
 *
 * Carlos: "Ahí tenés en ese 24982 en negrita, fecha para dictaminar."
 *
 * Detecta si la fecha de dictamen extraída del texto plano aparece
 * en negrita en el DOCX original. La negrita es una señal del SIL
 * de que el analista marcó esa fecha como "importante / definitiva"
 * (no solo una mención casual).
 *
 * Diseño:
 *   1. Fetch del DOCX desde GCS (gcs_path → bytes).
 *   2. mammoth.convertToHtml() → HTML donde los runs bold del DOCX
 *      se convierten en `<strong>` o `<b>`. Los `<w:b/>` del DOCX
 *      van todos a `<strong>` por convención de mammoth (PER se
 *      respeta el toggle <w:b w:val="false"/>).
 *   3. Parsear el HTML con cheerio. Para cada `<strong>` / `<b>`,
 *      tomar el texto sin tags. Si ese texto contiene el
 *      `valor_texto_original` que el regex extrajo, retornar TRUE.
 *
 * Limitaciones:
 *   - Mammoth no preserva runs adyacentes — si el SIL marcó "14 de
 *     mayo" en bold y " de 2026" en regular, mammoth los une todo
 *     en un solo run y nuestro detector falla. Mitigamos buscando
 *     substring del primer fragmento del texto matched (los primeros
 *     3-5 tokens) en cualquier `<strong>`.
 *   - PDF doesn't have bold metadata accesible — solo DOCX.
 *     Para fechas extraídas de PDFs, retornamos null.
 *
 * Performance:
 *   - Mammoth descarga ~1-3MB de bytes y demora 200-500ms de parsing
 *     para DOCX típicos del SIL. NO usar inline en cada request —
 *     destinado a job batch.
 *
 * GCS fetch:
 *   - Usa el SA del Cloud Run runtime (shift-cl2-vertex@) que tiene
 *     storage.objects.get en el bucket shift-cl2-sil.
 */

import { Storage } from '@google-cloud/storage';
import * as cheerio from 'cheerio';
import { logger } from './logger.js';

let _storage: Storage | null = null;
function gcs(): Storage {
  if (!_storage) {
    _storage = new Storage();
  }
  return _storage;
}

/**
 * Parse gs:// URL into bucket + object name.
 */
function parseGcsPath(url: string): { bucket: string; name: string } | null {
  const m = url.match(/^gs:\/\/([^\/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], name: m[2] };
}

/**
 * Fetch DOCX bytes desde GCS. Retorna null si falla o si no es DOCX.
 */
async function fetchDocxBytes(gcsPath: string): Promise<Buffer | null> {
  const parsed = parseGcsPath(gcsPath);
  if (!parsed) {
    logger.warn('bold_detect_gcs_path_invalid', { gcsPath });
    return null;
  }
  try {
    const [bytes] = await gcs().bucket(parsed.bucket).file(parsed.name).download();
    return bytes;
  } catch (err) {
    logger.warn('bold_detect_gcs_fetch_failed', {
      gcsPath,
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Verifica si los magic bytes corresponden a un DOCX (zip-based Office).
 */
function isDocxBytes(bytes: Buffer): boolean {
  return bytes.length > 4
    && bytes[0] === 0x50 && bytes[1] === 0x4b
    && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Tokeniza el texto original matched para buscar substrings parciales
 * en runs bold (mitiga el problema de runs partidos por mammoth).
 *
 * "Fecha para dictaminar: 14 de mayo de 2026" → busca:
 *   - "14 de mayo de 2026" (la fecha completa)
 *   - "14 de mayo" (sin año)
 *   - "14/05/2026"
 *   - "mayo de 2026" (sin día)
 *
 * Si CUALQUIER variante aparece en bold, marcamos bold=true.
 */
function buildBoldCandidates(valorTextoOriginal: string, valorFecha: string): string[] {
  const candidates = new Set<string>();
  // La fecha pura como aparece en el texto.
  candidates.add(valorTextoOriginal);
  // Aislar solo la parte de fecha (descartar el prefijo "Fecha para dictaminar:")
  // tomando del último colon en adelante.
  const lastColon = valorTextoOriginal.lastIndexOf(':');
  if (lastColon >= 0) {
    candidates.add(valorTextoOriginal.slice(lastColon + 1).trim());
  }
  // Patrones de fecha sueltos.
  // valorFecha en formato ISO YYYY-MM-DD → reconstruimos variantes.
  const m = valorFecha.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, year, month, day] = m;
    const monthNames = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                        'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const monthName = monthNames[Number(month) - 1];
    if (monthName) {
      candidates.add(`${parseInt(day, 10)} de ${monthName} de ${year}`);
      candidates.add(`${day} de ${monthName} de ${year}`);
      candidates.add(`${parseInt(day, 10)} de ${monthName} del ${year}`);
    }
    candidates.add(`${day}/${month}/${year}`);
    candidates.add(`${day}-${month}-${year}`);
    candidates.add(`${parseInt(day, 10)}/${parseInt(month, 10)}/${year}`);
  }
  return Array.from(candidates).filter((s) => s.length >= 4);
}

export interface BoldDetectResult {
  bold: boolean;
  /** Substring que matchea en un run bold (debug). */
  matched_substring?: string;
  /** Razón si retornamos false. */
  reason?: 'no_bold_runs' | 'no_substring_match' | 'fetch_failed' | 'not_docx' | 'no_gcs_path' | 'parse_failed';
}

/**
 * Detecta si la fecha matched aparece en bold en el DOCX original.
 *
 * @param gcsPath ej. "gs://shift-cl2-sil/docs/exp24982-dictamen.docx"
 * @param valorTextoOriginal el texto exacto que el regex matched (ej.
 *        "Fecha para dictaminar: 14 de mayo de 2026")
 * @param valorFecha la fecha en ISO (ej. "2026-05-14") — sirve para
 *        construir variantes de formato (numérico, con/sin "del").
 */
export async function detectBoldFecha(
  gcsPath: string | null,
  valorTextoOriginal: string,
  valorFecha: string,
): Promise<BoldDetectResult> {
  if (!gcsPath) {
    return { bold: false, reason: 'no_gcs_path' };
  }
  const bytes = await fetchDocxBytes(gcsPath);
  if (!bytes) {
    return { bold: false, reason: 'fetch_failed' };
  }
  if (!isDocxBytes(bytes)) {
    // Es PDF u otro — no detectamos bold ahí.
    return { bold: false, reason: 'not_docx' };
  }

  let html: string;
  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.convertToHtml({ buffer: bytes });
    html = result.value;
  } catch (err) {
    logger.warn('bold_detect_mammoth_failed', {
      gcsPath,
      error: (err as Error).message,
    });
    return { bold: false, reason: 'parse_failed' };
  }

  const $ = cheerio.load(html);
  const boldElements = $('strong, b');
  if (boldElements.length === 0) {
    return { bold: false, reason: 'no_bold_runs' };
  }

  const candidates = buildBoldCandidates(valorTextoOriginal, valorFecha);

  for (let i = 0; i < boldElements.length; i++) {
    const boldText = $(boldElements[i]).text().toLowerCase().replace(/\s+/g, ' ');
    for (const candidate of candidates) {
      const cand = candidate.toLowerCase().replace(/\s+/g, ' ');
      if (boldText.includes(cand)) {
        return { bold: true, matched_substring: candidate };
      }
    }
  }

  return { bold: false, reason: 'no_substring_match' };
}
