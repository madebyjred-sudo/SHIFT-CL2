/**
 * OCR fallback para PDFs escaneados del SIL.
 *
 * Diseño:
 *   - Cloud Vision Document Text Detection (no Document AI — más caro y
 *     overkill para PDFs simples de la Asamblea).
 *   - El método `batchAnnotateFiles` procesa hasta 5 pp por llamada INLINE
 *     (sin pasar por GCS). Para PDFs largos usamos `asyncBatchAnnotateFiles`
 *     que sube el PDF a GCS y procesa async — necesario para los PDFs de
 *     25.591 (22 MB, 80+ pp).
 *
 *   - Para mantener simple este v1, usamos solo el flujo INLINE con cap
 *     de 5 páginas por llamada. Para PDFs > 5 pp, iteramos por chunks de
 *     5 pp seleccionando rangos (pages: [1,2,3,4,5] → siguiente [6,...]).
 *     Document Text Detection acepta solo arrays cortos por llamada.
 *
 *   - Costo: $1.50 por 1000 páginas (primera 1M páginas/mes free de tier 1).
 *     Un expediente típico 30-50 pp = ~$0.05-0.08.
 *
 * Failure mode: si Vision falla o el PDF tiene una característica que rompe
 * el OCR (e.g. firma electrónica con XML embebido), retornamos string vacío
 * y dejamos que el bulk loop decida (probablemente: insertar sil_documentos
 * con text_chars=0 y status='parsed' — el archivo queda guardado en GCS).
 */
import { ImageAnnotatorClient } from '@google-cloud/vision';

const MAX_PAGES_PER_REQUEST = 5; // Vision limit para batchAnnotateFiles inline

let _client: ImageAnnotatorClient | null = null;
function client(): ImageAnnotatorClient {
  if (!_client) _client = new ImageAnnotatorClient();
  return _client;
}

/**
 * Extrae texto de un PDF escaneado usando Cloud Vision Document Text
 * Detection. Procesa hasta `maxPages` páginas (por defecto las primeras 100).
 * Devuelve string vacío si el PDF está vacío o si Vision falla.
 *
 * IMPORTANTE: Esta función SOLO se debe llamar después de confirmar que
 * pdfExtractor.pdfToText() devolvió string vacío (el PDF no tiene text
 * layer). OCR cuesta dinero — usarlo solo cuando no hay alternativa.
 */
export async function pdfToTextOCR(
  bytes: Buffer,
  opts: { maxPages?: number; sourceLabel?: string } = {},
): Promise<string> {
  const maxPages = opts.maxPages ?? 100;
  const label = opts.sourceLabel ?? 'ocr';

  // Necesitamos saber cuántas páginas tiene el PDF — pdfjs lo hace rápido.
  // Si pdfjs falla, asumimos hasta `maxPages`.
  let numPages = maxPages;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise;
    numPages = Math.min(doc.numPages, maxPages);
    try { await doc.cleanup(); doc.destroy(); } catch { /* swallow */ }
  } catch {
    // Si no podemos contar páginas, intentamos hasta 5 (primera batch).
    numPages = Math.min(maxPages, 5);
  }

  const allText: string[] = [];
  // Procesar en bloques de MAX_PAGES_PER_REQUEST. Vision indexa páginas
  // desde 1.
  for (let start = 1; start <= numPages; start += MAX_PAGES_PER_REQUEST) {
    const end = Math.min(start + MAX_PAGES_PER_REQUEST - 1, numPages);
    const pages: number[] = [];
    for (let p = start; p <= end; p++) pages.push(p);

    try {
      const [result] = await client().batchAnnotateFiles({
        requests: [{
          inputConfig: {
            content: bytes,
            mimeType: 'application/pdf',
          },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          pages,
          imageContext: { languageHints: ['es', 'es-CR'] },
        }],
      });

      const responses = result.responses?.[0]?.responses ?? [];
      for (const r of responses) {
        const text = r.fullTextAnnotation?.text ?? '';
        if (text) allText.push(text);
      }
    } catch (err) {
      // Vision puede tirar errores variados (PDF mal formado, cuota, etc).
      // Log + continue al siguiente bloque — al menos rescatamos parte.
      console.warn(`[ocr ${label}] vision batch ${start}-${end} failed: ${(err as Error).message}`);
    }
  }

  return cleanOcrText(allText.join('\n\n'));
}

/**
 * Limpieza ligera del output de Vision:
 *   - Newlines duplicados → uno o dos máximos
 *   - Espacios duplicados → uno
 *   - Caracteres de control raros → quitar
 *   - Trim global
 *
 * Vision suele dar texto bastante limpio (mejor que pdfjs por mucho), pero
 * agrupa cada página con un salto extra que duplica vertical white space.
 */
function cleanOcrText(raw: string): string {
  return raw
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
