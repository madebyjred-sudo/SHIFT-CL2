/**
 * geminiVideoTranscript — transcripción de videos de YouTube vía Gemini 2.5 Flash.
 *
 * Por qué reemplaza a yt-dlp:
 *   yt-dlp falla desde Cloud Run con "Sign in to confirm you're not a bot"
 *   porque YouTube tiene fingerprinted las IPs de Google Cloud (y AWS/Azure)
 *   como bots de scraping. Cualquier intento de bajar captions desde nuestro
 *   container es rechazado, incluso con cookies + player_client móvil.
 *
 *   Gemini 2.5 Flash, en cambio, acepta YouTube URIs directamente vía
 *   `fileData.fileUri` y los procesa desde infra interna de Google.
 *   YouTube no bloquea a sus propios servicios — la llamada funciona sin
 *   proxy ni cookies. Bonus: el output incluye timestamps en segundos,
 *   exactamente lo que necesitamos para `transcript_segments`.
 *
 * Costo (medido en Mayo 2026):
 *   - Video 18min: ~310K tokens total, ~$0.03 USD
 *   - Plenaria 4h (extrapolado): ~$0.40 USD por sesión
 *   - El 90% del costo son tokens de video/audio input (no output)
 *
 * Limitaciones:
 *   - max_output_tokens cap: ~32K tokens de transcripción en una sola
 *     llamada. Una plenaria de 4h cabe ajustado (~30K tokens de output);
 *     usar chunking por ventana de tiempo si vemos truncation en la práctica.
 *   - Idioma: detectado automáticamente. Pedimos español explícito para CR.
 *   - Calidad: comparable a auto-captions YouTube, mejor en nombres propios
 *     (Gemini conoce nombres latinos). Para Costa Rica, identifica
 *     "Asamblea Legislativa", "Rodrigo Chaves", etc. correctamente.
 */
import { GoogleAuth } from 'google-auth-library';
import { logger } from './logger.js';

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'sincere-burner-475520-g7';
const LOCATION = process.env.GCP_LOCATION ?? 'us-central1';

// Modelo por defecto para chunks cortos. Flash es ~3-4x más barato que Pro
// y suficiente para 10min de audio Q&A legislativo. Para plenarias largas
// (>60min) escalamos a Pro automáticamente — ver pickModel().
const DEFAULT_MODEL = process.env.GEMINI_TRANSCRIPT_MODEL ?? 'gemini-2.5-flash';
const LONG_VIDEO_MODEL = process.env.GEMINI_TRANSCRIPT_MODEL_LONG ?? 'gemini-2.5-pro';

// Umbral en segundos: arriba de esto usamos Pro. 3600s = 1 hora. Las
// plenarias de la Asamblea duran 2-4h; las comisiones largas 1-3h.
// Los videos más cortos (entrevistas, news clips) se quedan en Flash.
const LONG_VIDEO_THRESHOLD_S = Number(process.env.GEMINI_LONG_THRESHOLD_S ?? 3600);

const TIMEOUT_MS = 240_000; // 4min — Pro con razonamiento extendido tarda más

export interface GeminiSegment {
  start_seconds: number;
  end_seconds: number;
  text: string;
}

export class GeminiTranscriptError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'auth_failed'
      | 'http_error'
      | 'timeout'
      | 'parse_failed'
      | 'no_segments'
      | 'truncated',
    public readonly videoId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GeminiTranscriptError';
  }
}

const SYSTEM_INSTRUCTION = `Sos un transcriptor de sesiones legislativas de la
Asamblea Legislativa de Costa Rica. Tu trabajo es generar la transcripción
del audio del video con timestamps precisos.

REGLAS:
1. Transcribí TODO el audio audible. No omitas, no resumas, no parafrases.
2. Segmentá en bloques de 5-10 segundos para que se pueda navegar y citar.
3. Mantené el orden cronológico estricto: cada segmento empieza después del anterior.
4. NO inventes palabras donde no las hay. Si hay silencio o ruido inaudible,
   omití el segmento.
5. Nombres propios: usá la grafía correcta cuando la conozcas (e.g.
   "Rodrigo Chaves Robles", "Asamblea Legislativa", "Yara Jiménez").
   Si dudás de un nombre, transcribilo fonéticamente.
6. Idioma: español de Costa Rica.

OUTPUT — JSON estricto, sin texto adicional:
{
  "segments": [
    {"start_s": 0.0, "end_s": 5.4, "text": "..."},
    ...
  ]
}`;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string; code?: number };
}

/**
 * Transcribí un video de YouTube vía Gemini 2.5 Flash.
 *
 * @param videoId  el ID del video (no la URL completa)
 * @param opts.signal  AbortSignal para cancelar
 * @returns array de segmentos ordenados por tiempo
 */
/**
 * Elegí el modelo Gemini en función del rango procesado. El criterio es la
 * duración TOTAL del video, no del chunk — para una plenaria de 4h queremos
 * Pro en TODOS los chunks (consistencia de reasoning) aunque cada chunk
 * tenga 10min de audio. La decisión la hace el caller (chunked) y la pasa.
 */
export function pickModel(totalDurationS?: number): string {
  if (typeof totalDurationS === 'number' && totalDurationS >= LONG_VIDEO_THRESHOLD_S) {
    return LONG_VIDEO_MODEL;
  }
  return DEFAULT_MODEL;
}

export async function fetchTranscriptViaGemini(
  videoId: string,
  opts?: {
    signal?: AbortSignal;
    /** Si presente: procesa solo el rango [startOffsetS, endOffsetS]. Los
     *  timestamps devueltos siguen siendo absolutos (relativos al video). */
    startOffsetS?: number;
    endOffsetS?: number;
    /** Override del modelo. Si no se setea, usa DEFAULT_MODEL (flash).
     *  El caller chunked elige Pro para videos largos. */
    model?: string;
    /** Si presente, ai_call_log atribuye el costo al user (Supabase auth.uid).
     *  Si null/undefined la llamada se loggea con user_id=null (cron/system). */
    userId?: string | null;
    /** Identificador de callsite para ai_call_log.route (default 'transcript.gemini'). */
    route?: string;
  },
): Promise<GeminiSegment[]> {
  const startTs = Date.now();
  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Auth — usa la SA del Cloud Run (shift-cl2-vertex). En local toma
  // application-default credentials o GOOGLE_APPLICATION_CREDENTIALS.
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  let accessToken: string;
  try {
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp.token) throw new Error('no token returned');
    accessToken = tokenResp.token;
  } catch (err) {
    throw new GeminiTranscriptError(
      `Auth failed: ${(err as Error).message}`,
      'auth_failed',
      videoId,
      err,
    );
  }

  const model = opts?.model ?? DEFAULT_MODEL;
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;

  // Si nos pasan un rango, le decimos a Gemini que SOLO procese esa ventana
  // usando videoMetadata.startOffset/endOffset. Eso permite chunkear plenarias
  // largas (4h) en ventanas manejables sin exceder max_output_tokens.
  const videoMetadata =
    typeof opts?.startOffsetS === 'number' && typeof opts?.endOffsetS === 'number'
      ? {
          videoMetadata: {
            startOffset: `${Math.floor(opts.startOffsetS)}s`,
            endOffset: `${Math.floor(opts.endOffsetS)}s`,
          },
        }
      : {};

  const userInstruction =
    typeof opts?.startOffsetS === 'number' && typeof opts?.endOffsetS === 'number'
      ? `${SYSTEM_INSTRUCTION}\n\nTranscribí ÚNICAMENTE el rango ${opts.startOffsetS}s a ${opts.endOffsetS}s del video. Los timestamps que devolvés deben ser ABSOLUTOS (relativos al inicio del video, no al chunk).`
      : `${SYSTEM_INSTRUCTION}\n\nTranscribí el video completo siguiendo las reglas arriba.`;

  // Composición del request: el video va como fileData, el prompt+system
  // como texto. Pedimos JSON estructurado.
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            fileData: {
              mimeType: 'video/*',
              fileUri: youtubeUrl,
            },
            ...videoMetadata,
          },
          { text: userInstruction },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      maxOutputTokens: 32000,
      temperature: 0.05,
    },
  };

  // Llamada con timeout
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  // Si el caller pasa su propio signal, lo encadenamos.
  if (opts?.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort());
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error).name === 'AbortError') {
      throw new GeminiTranscriptError(
        `Gemini call timed out after ${TIMEOUT_MS}ms`,
        'timeout',
        videoId,
        err,
      );
    }
    throw new GeminiTranscriptError(
      `Gemini fetch failed: ${(err as Error).message}`,
      'http_error',
      videoId,
      err,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new GeminiTranscriptError(
      `Gemini HTTP ${resp.status}: ${detail.slice(0, 300)}`,
      'http_error',
      videoId,
    );
  }

  const json = (await resp.json()) as GeminiResponse;
  const finishReason = json.candidates?.[0]?.finishReason ?? 'UNKNOWN';
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';

  // Observabilidad — útil para tunear el modelo / detectar costos anómalos.
  logger.info('gemini_video_transcript_done', {
    videoId,
    model,
    finishReason,
    totalTokens: json.usageMetadata?.totalTokenCount,
    promptTokens: json.usageMetadata?.promptTokenCount,
    candidatesTokens: json.usageMetadata?.candidatesTokenCount,
    bodyChars: text.length,
  });

  // Token accounting certero — atribuir el costo al user que disparó la
  // transcripción (cuando hay user) o al system (cuando es cron de
  // transcriptProcess.ts). Vertex Gemini no pasa por Cerebro, así que sin
  // este log el costo queda invisible en ai_call_log.
  void (async () => {
    try {
      const { logLLMCall } = await import('./tokenAccounting.js');
      await logLLMCall({
        userId: opts?.userId ?? null,
        route: opts?.route ?? 'transcript.gemini',
        provider: 'vertex',
        model,
        tokensIn: json.usageMetadata?.promptTokenCount ?? 0,
        tokensOut: json.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs: Date.now() - startTs,
        meta: {
          video_id: videoId,
          finish_reason: finishReason,
          start_offset_s: opts?.startOffsetS,
          end_offset_s: opts?.endOffsetS,
          total_tokens_provider: json.usageMetadata?.totalTokenCount,
        },
      });
    } catch {
      // fail-open
    }
  })();

  if (!text) {
    throw new GeminiTranscriptError(
      `Gemini returned empty content (finish=${finishReason})`,
      'parse_failed',
      videoId,
    );
  }

  // Parse JSON robusto — Sonnet/Gemini a veces envuelven en ```json``` aún con
  // responseMimeType application/json.
  let parsed: { segments?: Array<{ start_s?: number; end_s?: number; text?: string }> } | null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    try {
      parsed = JSON.parse(stripped);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : null;
    }
  }
  if (!parsed || !Array.isArray(parsed.segments)) {
    throw new GeminiTranscriptError(
      `Gemini returned unparseable JSON (preview: ${text.slice(0, 200)})`,
      'parse_failed',
      videoId,
    );
  }

  // Normalización + filtros
  const segments: GeminiSegment[] = parsed.segments
    .map((s, i) => ({
      start_seconds: Number(s.start_s ?? 0),
      end_seconds: Number(s.end_s ?? 0),
      text: typeof s.text === 'string' ? s.text.trim() : '',
      idx: i,
    }))
    .filter(
      (s): s is GeminiSegment & { idx: number } =>
        Number.isFinite(s.start_seconds) &&
        Number.isFinite(s.end_seconds) &&
        s.end_seconds > s.start_seconds &&
        s.text.length > 0,
    )
    .map(({ idx, ...rest }) => {
      void idx;
      return rest;
    });

  if (segments.length === 0) {
    throw new GeminiTranscriptError(
      'Gemini returned 0 valid segments after filtering',
      'no_segments',
      videoId,
    );
  }

  // Si Gemini cortó por max_tokens, avisamos — el caller decide si chunkea.
  if (finishReason === 'MAX_TOKENS') {
    logger.warn('gemini_video_transcript_truncated', {
      videoId,
      lastEndS: segments[segments.length - 1]!.end_seconds,
      segmentCount: segments.length,
    });
    // No tiramos error — el caller puede usar los segments parciales como
    // base + lanzar otra llamada con `start_offset` para el resto.
  }

  return segments;
}

/**
 * Transcribí un video largo dividiéndolo en ventanas. Ideal para plenarias
 * (3-4h) donde max_output_tokens (32K) no alcanza para una sola llamada.
 *
 * Estrategia:
 *   - Ventana de 600s (10min) por defecto. Una ventana cabe holgadamente en
 *     un JSON de ~6-8K tokens output.
 *   - Llamadas secuenciales — el rate limit de Vertex AI permite paralelo
 *     pero queremos errores graciosos: si un chunk falla, podemos retomar.
 *   - Overlap de 0s entre ventanas; cada segment de Gemini ya viene con
 *     timestamps absolutos gracias a videoMetadata.startOffset.
 *   - Idempotente respecto a duplicados: si dos ventanas devuelven segments
 *     que se solapan, dedupeamos por (start_seconds, text) al final.
 *
 * @param videoId    ID de YouTube (sin la URL completa)
 * @param durationS  duración total del video en segundos (de YouTube Data API)
 * @param opts.windowS  tamaño de ventana en segundos (default 600)
 * @param opts.onProgress  callback opcional `(done, total) => void` para logs
 */
export async function fetchTranscriptViaGeminiChunked(
  videoId: string,
  durationS: number,
  opts?: {
    signal?: AbortSignal;
    windowS?: number;
    onProgress?: (done: number, total: number) => void;
    /** Retries por chunk fallido (default 2 → 3 intentos totales) */
    maxRetries?: number;
    /** Si un chunk devuelve menos de N segments lo consideramos magro y
     *  lo reintentamos con ventana subdividida. Default 5. */
    sparseSegmentThreshold?: number;
  },
): Promise<GeminiSegment[]> {
  // 2026-05-25: bajado de 600s → 300s. Análisis showed que con 600s muchas
  // ventanas devolvían pocos segments porque Gemini quedaba con MAX_TOKENS
  // por output, y el código original no recuperaba esos minutos perdidos.
  // 300s da ~2× chunks pero cada uno cabe holgado en max_output_tokens y
  // hace el output mas denso.
  const windowS = opts?.windowS ?? 300;
  const maxRetries = opts?.maxRetries ?? 2;
  const sparseThreshold = opts?.sparseSegmentThreshold ?? 5;
  if (!Number.isFinite(durationS) || durationS <= 0) {
    // Sin duración no podemos chunkear — caemos a una sola llamada con flash.
    return fetchTranscriptViaGemini(videoId, { signal: opts?.signal });
  }

  // Selección de modelo basada en duración TOTAL del video. Plenarias largas
  // van a Pro para mejor reasoning + más context window; clips cortos a Flash
  // (3-4x más barato). El criterio aplica a TODOS los chunks del mismo video
  // para no mezclar estilos de transcripción entre chunks.
  const model = pickModel(durationS);

  const ranges: Array<[number, number]> = [];
  for (let start = 0; start < durationS; start += windowS) {
    ranges.push([start, Math.min(start + windowS, Math.ceil(durationS))]);
  }

  // Costo estimado: Flash ~$0.10/hora-video, Pro ~$0.40/hora-video (input).
  // Es un upper bound — el output cuesta más pero pesa menos en este caso.
  const costPerMin = model === LONG_VIDEO_MODEL ? 0.0067 : 0.0017;
  logger.info('gemini_video_transcript_chunked_start', {
    videoId,
    durationS,
    windowS,
    chunks: ranges.length,
    model,
    estimatedCostUsd: ((durationS / 60) * costPerMin).toFixed(3),
  });

  /**
   * Procesa un chunk con retry. Si recibe pocos segments para el rango,
   * subdivide la ventana en 2 y procesa cada mitad — esto cubre el caso
   * típico donde MAX_TOKENS corta el output y la segunda mitad del rango
   * queda sin transcribir.
   */
  async function processChunkWithRetry(
    startOffsetS: number,
    endOffsetS: number,
    attempt = 0,
    depth = 0,
  ): Promise<GeminiSegment[]> {
    try {
      const segs = await fetchTranscriptViaGemini(videoId, {
        signal: opts?.signal,
        startOffsetS,
        endOffsetS,
        model,
      });

      const rangeS = endOffsetS - startOffsetS;
      const lastSegEnd = segs.length > 0 ? segs[segs.length - 1]!.end_seconds : startOffsetS;
      // Coverage: cuánto del rango cubrieron los segments. Si <70% del
      // rango está cubierto, tratamos como magro → split.
      const coverage = (lastSegEnd - startOffsetS) / rangeS;
      const sparse = segs.length < sparseThreshold || coverage < 0.7;

      logger.info('gemini_video_transcript_chunk_done', {
        videoId,
        rangeS: `${startOffsetS}-${endOffsetS}`,
        segmentsInChunk: segs.length,
        coverage: coverage.toFixed(2),
        sparse,
        attempt,
        depth,
      });

      // Si está magro y aún podemos profundizar (subdividir ventana), lo
      // hacemos. Cap a profundidad 2 (180s → 90s → 45s) para evitar
      // recursión infinita.
      if (sparse && depth < 2 && rangeS > 60) {
        const mid = Math.floor((startOffsetS + endOffsetS) / 2);
        logger.warn('gemini_video_transcript_chunk_sparse_split', {
          videoId,
          rangeS: `${startOffsetS}-${endOffsetS}`,
          coverage: coverage.toFixed(2),
          segments: segs.length,
          splitAt: mid,
        });
        const [half1, half2] = await Promise.all([
          processChunkWithRetry(startOffsetS, mid, 0, depth + 1).catch(() => [] as GeminiSegment[]),
          processChunkWithRetry(mid, endOffsetS, 0, depth + 1).catch(() => [] as GeminiSegment[]),
        ]);
        // Mergeamos las dos mitades con lo que sí trajo el intento original
        // (puede haber segments útiles al principio).
        return [...segs, ...half1, ...half2];
      }

      return segs;
    } catch (err) {
      if (attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        logger.warn('gemini_video_transcript_chunk_retry', {
          videoId,
          rangeS: `${startOffsetS}-${endOffsetS}`,
          attempt: attempt + 1,
          maxRetries,
          backoffMs,
          error: (err as Error).message,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
        return processChunkWithRetry(startOffsetS, endOffsetS, attempt + 1, depth);
      }
      logger.error('gemini_video_transcript_chunk_failed', {
        videoId,
        rangeS: `${startOffsetS}-${endOffsetS}`,
        attemptsExhausted: maxRetries + 1,
        error: (err as Error).message,
      });
      return [];
    }
  }

  const allSegments: GeminiSegment[] = [];
  let chunkIdx = 0;
  for (const [startOffsetS, endOffsetS] of ranges) {
    chunkIdx++;
    const segs = await processChunkWithRetry(startOffsetS, endOffsetS);
    allSegments.push(...segs);
    opts?.onProgress?.(chunkIdx, ranges.length);
  }

  // Dedupe por (start_seconds redondeado a 1s, primeras 30 chars de text).
  // Las ventanas no se solapan pero Gemini a veces incluye el ultimo
  // segundo de la ventana anterior — esto lo limpia.
  const seen = new Set<string>();
  const dedup = allSegments.filter((s) => {
    const k = `${Math.round(s.start_seconds)}:${s.text.slice(0, 30)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Sort ascendente por start_seconds (chunks vienen en orden pero por las
  // dudas si algo se mete fuera de tiempo).
  dedup.sort((a, b) => a.start_seconds - b.start_seconds);

  logger.info('gemini_video_transcript_chunked_complete', {
    videoId,
    chunks: ranges.length,
    totalSegments: dedup.length,
    duplicatesRemoved: allSegments.length - dedup.length,
  });

  return dedup;
}
