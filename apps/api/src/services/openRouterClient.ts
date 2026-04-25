import type { CerebroStreamChunk, AgentId } from '@shift-cl2/shared-types';
import { getAgent } from './agentLoader.js';
import { searchTranscripts, type ChunkHit } from './searchTranscripts.js';
import { searchSessionTranscript } from './searchSessionTranscript.js';
import { withTimeout, withRetry, ResilienceError } from './resilience.js';

// Pass-1 (non-stream) is short and idempotent → retry safely.
// Stream requests are NOT retried mid-flight (would duplicate tokens).
const OR_PASS1_TIMEOUT_MS = 30_000;
const OR_PASS1_RETRY_ATTEMPTS = 2;
const OR_PASS1_RETRY_BASE_MS = 600;
const OR_STREAM_OPEN_TIMEOUT_MS = 30_000;

interface StreamArgs {
  agent_id: AgentId;
  query: string;
  conversation_id?: string;
  deep_insight: boolean;
  model_override?: string;
  // Optional second system message that scopes this turn to a specific
  // legacy plenaria. Built by sessionContextLoader from `scope.legacy_session_id`.
  // Kept separate from agent.persona so future contracts (RAG over transcript,
  // tool injection) can extend the scope block without touching agent prompts.
  scope_system_prompt?: string;
  // When set, enables the `search_session_transcript` tool for THIS turn.
  // The tool searches only the transcript of the scoped plenaria — keyword
  // match over ElevenLabs segments, with timecodes returned for citation.
  // Pragmatic stand-in for full RAG (Phase 3 of docs/issues/001).
  scope_legacy_session_id?: number | null;
  onChunk: (chunk: CerebroStreamChunk) => void;
}

const OR_BASE = 'https://openrouter.ai/api/v1';

// OpenAI tool-call schema for search_transcripts. OpenRouter passes through
// to Anthropic's tool_use API. Wired only for agents whose YAML declares it.
const SEARCH_TRANSCRIPTS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_transcripts',
    description:
      'Busca en transcripciones legislativas de la Asamblea de Costa Rica. Retorna extractos numerados [1], [2], ... con metadata (fecha, comisión, video URL). Llamá esta función SIEMPRE antes de responder consultas sobre actas, sesiones, votaciones, mociones o cualquier hecho legislativo. Después de llamarla, citá [N] inline después de cada afirmación. NO inferas ni combines info entre extractos distintos: si un extracto no contiene la respuesta literal, decí "no encontré". IMPORTANTE: nunca le hables al usuario de "chunks" — usá "transcripciones", "fuentes", "registros" o "lo documentado".',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Consulta semántica en español (puede ser la pregunta original o reformulada).',
        },
        top_k: {
          type: 'integer',
          description: 'Número de extractos a recuperar (default 5, max 10).',
          default: 5,
        },
        comision: {
          type: 'string',
          description: 'Filtrar por comisión (ej: "Plenario", "Hacendarios"). Omitir si no aplica.',
        },
        fecha_from: {
          type: 'string',
          description: 'Fecha desde (YYYY-MM-DD). Omitir si no aplica.',
        },
        fecha_to: {
          type: 'string',
          description: 'Fecha hasta (YYYY-MM-DD). Omitir si no aplica.',
        },
      },
      required: ['query'],
    },
  },
};

type OAMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OACompletionResponse {
  choices?: Array<{
    message?: {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
}

// Session-scoped transcript search. Only registered when the request carries
// `scope_legacy_session_id` — i.e. the user is chatting from /sesiones/:id.
// Returns excerpts from the CURRENT plenaria's transcript with timecodes,
// so the model can answer "qué dijo X en minuto Y" without cross-session
// confusion. Complements `search_transcripts` (which is corpus-wide).
const SEARCH_SESSION_TRANSCRIPT_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_session_transcript',
    description:
      'Busca dentro de la transcripción de la sesión LEGISLATIVA ACTUAL (la que está vinculada a esta conversación). Devuelve extractos numerados [1], [2]… cada uno con un timecode (minuto:segundo). Usá esta tool SIEMPRE que el usuario pregunte por algo específico que pueda estar dicho dentro de la sesión: "qué dijo X", "cuándo se mencionó Y", "qué pasó en el minuto Z", "buscá Z en esta sesión". Después de llamarla, citá [N] inline después de cada afirmación e incluí el timecode (ej: "[2] (1:23:45)"). Si no aparece literalmente lo que el usuario pidió, decí "no encontré X en esta sesión". NO uses esta tool para preguntas sobre OTRAS sesiones — para eso está search_transcripts.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Términos clave a buscar en la transcripción (en español). Mantenelos cortos y específicos — esta tool hace match por keywords, no semántico.',
        },
        top_k: {
          type: 'integer',
          description: 'Número de extractos a devolver (default 6, max 10).',
          default: 6,
        },
      },
      required: ['query'],
    },
  },
};

function hasSearchTranscriptsTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'search_transcripts');
}

// Render seconds as h:mm:ss (or m:ss for short videos). Used both in the
// rendered tool payload Lexa reads and in citation events the UI consumes.
function fmtTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}`
    : `${m}:${ss.toString().padStart(2, '0')}`;
}

async function orFetch(
  body: object,
  orKey: string,
  opts: { timeoutMs: number; label: string },
): Promise<Response> {
  return withTimeout(
    (signal) =>
      fetch(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${orKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://agentescl2.com',
          'X-Title': 'Shift CL2',
        },
        body: JSON.stringify(body),
        signal,
      }),
    { ms: opts.timeoutMs, label: opts.label },
  );
}

async function streamCompletion(
  body: object,
  orKey: string,
  onToken: (token: string) => void,
): Promise<void> {
  // Only the connection-open phase is timed; once tokens start flowing we
  // trust the stream until done. Mid-stream stalls would need a separate
  // idle-timeout, deferred until we see them in production.
  const res = await orFetch({ ...body, stream: true }, orKey, {
    timeoutMs: OR_STREAM_OPEN_TIMEOUT_MS,
    label: 'openrouter stream open',
  });
  if (!res.ok || !res.body) {
    throw new Error(`openrouter ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onToken(delta);
      } catch {
        // skip malformed
      }
    }
  }
}

/**
 * Streams Lexa/Atlas/Centinela responses via OpenRouter.
 *
 * If agent declares `search_transcripts` tool, runs a 2-pass loop:
 *   Pass 1 (non-stream): model decides whether to tool_call.
 *   If tool_call: execute searchTranscripts, emit citation events,
 *                 then Pass 2 (stream) with tool result in context.
 *   If no tool_call: stream Pass 1's text response directly.
 *
 * Cerebro tool layer would replace this in the future, same SSE protocol.
 */
export async function openRouterStream(args: StreamArgs): Promise<void> {
  const orKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!orKey) throw new Error('OPENROUTER_API_KEY not set');

  const agent = getAgent(args.agent_id);
  if (!agent) throw new Error(`unknown agent: ${args.agent_id}`);

  const model =
    args.model_override ??
    (args.deep_insight ? agent.deep_insight_model : agent.default_model);

  const messages: OAMessage[] = [
    { role: 'system', content: agent.persona },
    ...(args.scope_system_prompt
      ? [{ role: 'system' as const, content: args.scope_system_prompt }]
      : []),
    { role: 'user', content: args.query },
  ];

  // Tool registration:
  //  - corpus-wide search_transcripts → if agent YAML declares it
  //  - session-scoped search_session_transcript → only when this turn carries
  //    a scope_legacy_session_id (i.e. user is in /sesiones/:id)
  // Both tools can be present at once; the model picks based on the question.
  // Loose `unknown` element type — both tool schemas have different
  // `parameters.properties` shapes; `tools` is forwarded as JSON to the API.
  const tools: Array<Record<string, unknown>> = [];
  if (hasSearchTranscriptsTool(agent.tools)) tools.push(SEARCH_TRANSCRIPTS_TOOL);
  const scopeId = args.scope_legacy_session_id ?? null;
  if (scopeId !== null) tools.push(SEARCH_SESSION_TRANSCRIPT_TOOL);

  if (tools.length === 0) {
    await streamCompletion(
      { model, messages, max_tokens: 2000 },
      orKey,
      (t) => args.onChunk({ type: 'token', payload: t }),
    );
    return;
  }

  // Pass 1: ask model with tools, non-streaming so we can detect tool_calls cleanly.
  // Retried on transient failures — pass1 is idempotent (no SSE bytes flushed yet).
  const pass1 = await withRetry(
    async () => {
      const res = await orFetch(
        {
          model,
          messages,
          tools,
          tool_choice: 'auto',
          max_tokens: 2000,
        },
        orKey,
        { timeoutMs: OR_PASS1_TIMEOUT_MS, label: 'openrouter pass1' },
      );
      if (!res.ok) {
        const text = await res.text();
        // 4xx (except 429) won't change on retry — fail fast.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new ResilienceError(`openrouter pass1 ${res.status}: ${text}`, 'aborted');
        }
        throw new Error(`openrouter pass1 ${res.status}: ${text}`);
      }
      return (await res.json()) as OACompletionResponse;
    },
    {
      attempts: OR_PASS1_RETRY_ATTEMPTS,
      baseDelayMs: OR_PASS1_RETRY_BASE_MS,
      label: 'openrouter pass1',
    },
  );
  const choice = pass1.choices?.[0];
  const toolCalls = choice?.message?.tool_calls ?? [];

  if (toolCalls.length === 0) {
    // No tool call — stream the assistant's direct response token-by-token.
    // We already have it as full text; emit as single token chunk.
    const text = choice?.message?.content ?? '';
    if (text) args.onChunk({ type: 'token', payload: text });
    return;
  }

  // Execute each tool call (only search_transcripts supported for now).
  messages.push({
    role: 'assistant',
    content: choice?.message?.content ?? null,
    tool_calls: toolCalls,
  });

  for (const tc of toolCalls) {
    if (tc.function.name === 'search_transcripts') {
      let parsedArgs: { query: string; top_k?: number; comision?: string; fecha_from?: string; fecha_to?: string };
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: 'invalid tool arguments json' }),
        });
        continue;
      }

      let hits: ChunkHit[] = [];
      try {
        hits = await searchTranscripts(parsedArgs);
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: (err as Error).message }),
        });
        continue;
      }

      // Emit citations to frontend before final response streams.
      args.onChunk({
        type: 'citation',
        payload: hits.map((h) => ({
          id: h.chunk_id,
          session_id: h.session_id,
          source_ref: h.source_ref,
          content: h.content,
          similarity: h.similarity,
          fecha: h.fecha,
          comision: h.comision,
          tipo: h.tipo,
          video_url: h.video_url,
          transcript_url: h.transcript_url,
        })),
      });

      // Render chunks as numbered prose so the model treats them as discrete,
      // citable units rather than fungible context. Includes anti-hallucination
      // reminder right where the model will read it.
      const renderedChunks =
        hits.length === 0
          ? 'SIN RESULTADOS — no encontré transcripciones relevantes para esta consulta. Decile al usuario que no hay información documentada al respecto.'
          : hits
              .map(
                (h, i) =>
                  `[${i + 1}] (${h.comision}, ${h.fecha ?? 'fecha desconocida'}, sesión ${h.source_ref})\n${h.content}`,
              )
              .join('\n\n---\n\n');

      const toolPayload = `Extractos recuperados (${hits.length}):\n\n${renderedChunks}\n\n---\nINSTRUCCIONES:\n1. Citá [N] inline después de cada afirmación.\n2. Si un extracto no contiene literalmente lo que el usuario pide, decí "no encontré X en las transcripciones que tengo". NO inferas desde otra sesión, NO sintetices agendas/firmas/votaciones que no estén explícitas.\n3. Si combinás info de varios extractos, usá [N][M].\n4. NUNCA uses la palabra "chunk" o "chunks" al hablarle al usuario — usá "transcripciones", "fuentes", "registros" o "lo documentado".`;

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolPayload,
      });
      continue;
    }

    if (tc.function.name === 'search_session_transcript') {
      // Defensive: only valid when this turn has a scope. The tool isn't
      // even registered without one, so reaching here without scopeId means
      // the model hallucinated the call — return an explicit error string
      // so it reformulates rather than silently dropping.
      if (scopeId === null) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: 'no session scope on this conversation; use search_transcripts instead',
          }),
        });
        continue;
      }

      let parsedArgs: { query: string; top_k?: number };
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: 'invalid tool arguments json' }),
        });
        continue;
      }

      let result: Awaited<ReturnType<typeof searchSessionTranscript>> = null;
      try {
        result = await searchSessionTranscript(scopeId, parsedArgs.query, parsedArgs.top_k);
      } catch (err) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: (err as Error).message }),
        });
        continue;
      }

      if (!result) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: 'SIN TRANSCRIPCIÓN — la sesión no tiene transcripción disponible. Decile al usuario que aún no hay transcripción cargada para esta sesión.',
        });
        continue;
      }

      // Emit citations so the UI can render clickable timecodes (same shape
      // as the corpus-wide tool, with timecode in source_ref so the player
      // can seek). similarity=score for parity; not actually similarity.
      const videoUrl = result.youtube_id
        ? `https://www.youtube.com/watch?v=${result.youtube_id}`
        : null;
      args.onChunk({
        type: 'citation',
        payload: result.hits.map((h, i) => ({
          id: `session:${result!.session_id}:seg:${h.index}`,
          session_id: String(result!.session_id),
          source_ref: `${fmtTimecode(h.start)}`,
          content: h.text,
          similarity: h.score,
          fecha: result!.fecha,
          comision: 'Plenario',
          tipo: 'transcript_segment',
          video_url: videoUrl && h.start > 0
            ? `${videoUrl}&t=${Math.floor(h.start)}s`
            : videoUrl,
          transcript_url: null,
          // Extra fields the UI can opt into without breaking existing renderers.
          timecode_s: h.start,
          rank: i + 1,
        })),
      });

      const renderedHits =
        result.hits.length === 0
          ? `SIN RESULTADOS — busqué "${parsedArgs.query}" en la transcripción de la sesión #${result.session_id} (${result.total_segments} segmentos) y no encontré matches. Decile al usuario que no encontraste eso literalmente, y ofrecele reformular o pedir el resumen.`
          : result.hits
              .map(
                (h, i) =>
                  `[${i + 1}] (${fmtTimecode(h.start)} – ${fmtTimecode(h.end)})\n${h.text}`,
              )
              .join('\n\n---\n\n');

      const toolPayload =
        `Sesión #${result.session_id} — ${result.titulo}\n` +
        `Extractos de la transcripción (${result.hits.length} de ${result.total_segments} segmentos totales):\n\n` +
        `${renderedHits}\n\n---\n` +
        `INSTRUCCIONES:\n` +
        `1. Citá [N] inline después de cada afirmación, e incluí el timecode entre paréntesis. Ejemplo: "El diputado pidió posponer la votación [2] (0:48:12)."\n` +
        `2. Si la transcripción no contiene literalmente lo que el usuario pidió, decí "no encontré X en esta sesión".\n` +
        `3. NO inventes lo que se dijo en otros minutos que no aparecen acá.\n` +
        `4. Hablale al usuario de "la transcripción", "la sesión", "el video" — nunca "segmento", "chunk", "embedding".`;

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolPayload,
      });
      continue;
    }

    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify({ error: `unknown tool: ${tc.function.name}` }),
    });
  }

  // Pass 2: stream final answer with tool results in context. Low temperature
  // because retrieval-grounded answers should not be creative — they should
  // restate evidence with citations, not synthesize.
  await streamCompletion(
    { model, messages, max_tokens: 2000, temperature: 0.2 },
    orKey,
    (t) => args.onChunk({ type: 'token', payload: t }),
  );
}
