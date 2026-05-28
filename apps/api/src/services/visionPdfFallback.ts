/**
 * visionPdfFallback — OCR/structured extraction de PDFs escaneados vía Vertex
 * Gemini multimodal. Fallback para casos donde `pdf-parse` devuelve <50 chars
 * (PDFs imagen, escaneados, sin texto vectorial).
 *
 * USO ACTUAL:
 *   - decretoPdfParser.parseDecretoPdf cuando rawText vacío
 *   - processOrdenesDia.processOrdenesDia cuando regex de expedientes
 *     devuelve [] (probable PDF escaneado)
 *
 * COSTOS (validados 2026-05-23):
 *   - Flash: ~$0.30 / 1M input tokens. PDF 2-3 páginas ≈ 5K-10K tokens
 *     input → $0.0015-0.003 por PDF.
 *   - Pro: 4x más caro pero mejor reasoning. Reservado para decretos
 *     (estructura compleja: numero + fecha + secciones AMPLIA/RETIRA +
 *     lista expedientes).
 *
 * SAFETY:
 *   - Timeout 90s — Vision con PDF grande puede tardar.
 *   - JSON robusto parse (Gemini a veces envuelve en ```json``` aún con
 *     responseMimeType=application/json).
 *   - Logs en ai_call_log via tokenAccounting.logLLMCall — el costo
 *     aparece en /admin/tokens atribuido al cron que disparó.
 */
import { GoogleAuth } from 'google-auth-library';
import { logger } from './logger.js';

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? 'sincere-burner-475520-g7';
const LOCATION = process.env.GCP_LOCATION ?? 'us-central1';
const TIMEOUT_MS = 90_000;

export interface VisionParseOpts {
  /** Identificador de callsite para ai_call_log.route. */
  route: string;
  /** "Pro" para estructura compleja (decretos); "Flash" para simple (ordenes). */
  modelTier?: 'pro' | 'flash';
  /** Atribución de usuario. Cron sin user → null. */
  userId?: string | null;
  /** Etiqueta de debugging — termina en meta del log. */
  label?: string;
  /** Schema JSON esperado en el output. Mejora la consistencia del parser
   *  cuando Gemini no respeta el prompt. */
  responseSchema?: object;
  /** Override total del prompt si default no aplica. */
  prompt?: string;
}

/**
 * Llama Vertex Gemini con el PDF como inline_data y un prompt que pide
 * JSON estructurado. Devuelve el objeto parseado o null si todo falló.
 */
export async function visionParsePdf<T>(
  pdfBuffer: Buffer,
  opts: VisionParseOpts,
): Promise<T | null> {
  const startTs = Date.now();
  const model = opts.modelTier === 'pro' ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
  const pdfBase64 = pdfBuffer.toString('base64');

  // Auth — Cloud Run usa la SA shift-cl2-vertex; local toma ADC o
  // GOOGLE_APPLICATION_CREDENTIALS.
  let accessToken: string;
  try {
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    if (!tokenResp.token) throw new Error('no token');
    accessToken = tokenResp.token;
  } catch (err) {
    logger.warn('vision_pdf_auth_failed', {
      route: opts.route,
      error: (err as Error).message,
    });
    return null;
  }

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;

  const prompt = opts.prompt ?? 'Extrae el contenido del PDF como JSON estructurado.';
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: pdfBase64,
            },
          },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(opts.responseSchema ? { responseSchema: opts.responseSchema } : {}),
      maxOutputTokens: 8192,
      temperature: 0.0,
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      logger.warn('vision_pdf_http_failed', {
        route: opts.route,
        status: resp.status,
        body: txt.slice(0, 300),
      });
      return null;
    }
    const json = (await resp.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };

    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    const latencyMs = Date.now() - startTs;

    // Token accounting — cost aparece en /admin/tokens.
    void (async () => {
      try {
        const { logLLMCall } = await import('./tokenAccounting.js');
        await logLLMCall({
          userId: opts.userId ?? null,
          route: opts.route,
          provider: 'vertex',
          model,
          tokensIn: json.usageMetadata?.promptTokenCount ?? 0,
          tokensOut: json.usageMetadata?.candidatesTokenCount ?? 0,
          latencyMs,
          meta: {
            label: opts.label,
            pdf_size_bytes: pdfBuffer.length,
            finish_reason: json.candidates?.[0]?.finishReason,
            via: 'visionPdfFallback',
          },
        });
      } catch {
        // fail-open
      }
    })();

    if (!text) {
      logger.warn('vision_pdf_empty_text', {
        route: opts.route,
        finish: json.candidates?.[0]?.finishReason,
      });
      return null;
    }

    // Parse JSON robusto — Gemini envuelve a veces en ```json```.
    try {
      return JSON.parse(text) as T;
    } catch {
      const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      try {
        return JSON.parse(stripped) as T;
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            return JSON.parse(m[0]) as T;
          } catch {
            // fall through
          }
        }
      }
    }
    logger.warn('vision_pdf_unparseable_json', {
      route: opts.route,
      text_preview: text.slice(0, 200),
    });
    return null;
  } catch (err) {
    logger.warn('vision_pdf_exception', {
      route: opts.route,
      error: (err as Error).message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
