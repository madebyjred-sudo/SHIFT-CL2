import type { CerebroStreamChunk, AgentId } from '@shift-cl2/shared-types';
import { getAgent, buildAgentSystemPrompt } from './agentLoader.js';
import { searchTranscripts, type ChunkHit } from './searchTranscripts.js';
import { searchSessionTranscript } from './searchSessionTranscript.js';
import {
  searchExpedientes,
  getExpedienteById,
  searchSilCorpus,
  searchReglamento,
  renderExpedientesForLlm,
  renderExpedienteFullForLlm,
  renderReglamentoForLlm,
} from './silClient.js';
import { queryLightrag, type LightragMode } from './lightragClient.js';
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
  // Approved-only RAG bundle from Cerebro Punto Medio. When present, gets
  // injected as a system message between the agent persona and the scope
  // block. Empty/null means the operator hasn't approved any patterns yet
  // (the manual review gate at /admin/punto-medio is closed) — we run
  // without flywheel enrichment, never blind injection.
  dynamic_rag_prompt?: string;
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
  // When set, enables `generate_presentation` for Atlas. The tool composes
  // every hoja in this workspace into a Gamma deck and emits a `pptx_ready`
  // chunk to the client. Without this scope, Atlas can't generate decks
  // (it doesn't know which workspace).
  scope_workspace_id?: string | null;
  // Authenticated user — required for tools that touch user-scoped data
  // (currently: generate_presentation, which UPDATEs workspaces.last_pptx).
  // Caller (chat router) should set this from the verified Supabase JWT.
  user_id?: string | null;
  // Prior turns of this conversation, in OAI {role,content} shape. Without
  // this, every turn is a "first turn" to the LLM (it can't see what it
  // said last time, so references like "el #1" or "expandí esa idea" miss).
  // Caller is responsible for trimming to a reasonable window — we cap at
  // MAX_HISTORY_MESSAGES inside this function as a safety net.
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  onChunk: (chunk: CerebroStreamChunk) => void;
}

/** Hard cap on prior turns we forward. Keeps cost bounded even if the
 *  client sends an unbounded transcript. ~20 turns ≈ 10-20K tokens. */
const MAX_HISTORY_MESSAGES = 20;

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

function hasSilTools(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some(
    (t) =>
      t.name === 'search_sil_expedientes' ||
      t.name === 'get_sil_expediente' ||
      t.name === 'search_sil_corpus',
  );
}

function hasReglamentoTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'search_reglamento');
}

function hasGraphTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'query_legislative_graph');
}

function hasGeneratePresentationTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'generate_presentation');
}

function hasGenerateDocxTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'generate_docx');
}

// generate_presentation — Atlas tool that turns the active workspace into
// a Gamma deck. Same pipeline as POST /api/workspace/:id/export with
// format='pptx'. The tool dispatcher emits a `pptx_ready` chunk to the
// client so the chat UI can render an inline card with the gammaUrl +
// exportUrl. Cache reuse is handled server-side: re-clicks within ~1h
// don't burn credits.
const GENERATE_PRESENTATION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'generate_presentation',
    description:
      'Genera una presentación (.pptx) del workspace activo usando Gamma. Disparalo SOLO cuando el usuario pide explícitamente una presentación / deck / PPT / slides ("hacé una presentación de esto", "convertí esto en deck", "necesito un PPT"). NO lo dispares de motu proprio mientras armás hojas — cada generación cuesta ~3-7 créditos y toma 30-60s. La tool reusa cache si fue generado en la última hora; pasá force=true para forzar regeneración.',
    parameters: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'Si true, ignora la cache y regenera el deck. Default false.',
        },
      },
      required: [],
    },
  },
};

// generate_docx — Atlas tool that turns the active workspace into a branded
// Word .docx. Dispatches to the POST /api/workspace/:id/export-docx pipeline
// which calls renderDocxAsset internally. Emits a `docx_ready` chunk so the
// chat UI can render a download card.
const GENERATE_DOCX_TOOL = {
  type: 'function' as const,
  function: {
    name: 'generate_docx',
    description:
      'Genera un documento Word editable (.docx) con branding CL2 del workspace activo. Disparalo SOLO cuando el usuario pide un Word, un memo editable, un brief descargable, un informe para cliente o menciona ".docx". El resultado es un archivo A4 con estilos CL2 descargable; también se inserta como nodo en el canvas. NO lo dispares mientras armás hojas — generalo al final cuando el usuario dice que el análisis está listo.',
    parameters: {
      type: 'object',
      properties: {
        tono: {
          type: 'string',
          description: 'Tono del documento. Ej: "ejecutivo", "técnico-legal", "divulgativo". Default: "ejecutivo".',
        },
        audiencia: {
          type: 'string',
          description: 'Audiencia objetivo. Ej: "directivos corporativos", "bancada legislativa", "prensa". Influye en el metadata footer.',
        },
        sendToCanvas: {
          type: 'boolean',
          description: 'Si true (default), inserta un nodo docx_asset en el canvas con el link de descarga.',
          default: true,
        },
      },
      required: [],
    },
  },
};

// query_legislative_graph — wraps Cerebro's LightRAG.
// LightRAG's three modes:
//   local  — walks the graph from seed entities mentioned in the query
//            (best for "qué dijo Muñoz Céspedes sobre traslado de riesgos").
//   global — uses LLM-generated keyword themes that intersect the query
//            (best for "qué patrones políticos emergen en proyectos de salud").
//   hybrid — both. Default. Highest cost, broadest signal.
//   naive  — plain dense retrieval inside LightRAG's own store. Cheaper.
// The model picks the mode; we pass through.
const QUERY_LEGISLATIVE_GRAPH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'query_legislative_graph',
    description:
      'Consulta el grafo de conocimiento legislativo (entidades + relaciones extraídas del SIL, Reglamento y plenarias) para preguntas que requieren conectar actores, expedientes, posturas y patrones a través del corpus. Usalo para: "¿qué diputados se oponen al proyecto X?", "¿qué patrones aparecen en propuestas de Y partido?", "¿cómo se relaciona la comisión Z con el expediente W?", "¿quiénes han propuesto reformas similares a X?". Devuelve una respuesta sintetizada por el LLM apoyada en el grafo. NO la uses para preguntas factuales puntuales (un solo expediente, un artículo concreto): para eso están search_sil_expedientes y search_reglamento. Si el grafo no está disponible (Cerebro responde 503), recurrí a search_sil_corpus.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Pregunta en lenguaje natural. Mientras más relacional ("quién propuso", "qué se conecta con", "patrones entre"), mejor.',
        },
        mode: {
          type: 'string',
          enum: ['local', 'global', 'hybrid', 'naive'],
          description:
            'local = subgrafo desde entidades semilla (mejor para preguntas sobre actores/objetos específicos). global = patrones temáticos (mejor para preguntas de alto nivel). hybrid = ambos (default, recomendado salvo que la pregunta sea clarísimamente uno u otro). naive = retrieval plano sin grafo (último recurso).',
          default: 'hybrid',
        },
        deep_insight: {
          type: 'boolean',
          description: 'Si true, usa el modelo Opus 4.7 para la síntesis final (más caro, más profundo). Default false (Sonnet 4.6).',
          default: false,
        },
      },
      required: ['query'],
    },
  },
};

const SEARCH_REGLAMENTO_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_reglamento',
    description:
      'Busca en el Reglamento de la Asamblea Legislativa de Costa Rica (96 artículos vigentes). Usalo SIEMPRE para preguntas procedimentales: plazos, requisitos, mecanismos de votación, mociones, dispensa de trámite, comisiones, dictámenes, sesiones plenarias, derechos y deberes de diputados. Devuelve artículos completos con su número y título — citá [Art. N] inline. NO inventes artículos: si la búsqueda no devuelve un artículo aplicable, decí "el Reglamento no regula explícitamente esto".',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Pregunta o concepto procedimental en español. Ej: "plazo dictamen comisión", "votación nominal", "moción de fondo en plenario".',
        },
        k: {
          type: 'integer',
          description: 'Número de artículos a recuperar (default 5, max 10).',
          default: 5,
        },
      },
      required: ['query'],
    },
  },
};

// ─── SIL tool definitions ─────────────────────────────────────────────
// These three cover the breadth of legislative-file queries:
//   - search_sil_expedientes: keyword over titles (cheap, instant — use FIRST
//     for "qué expedientes hay sobre X" type questions).
//   - get_sil_expediente:     detail lookup once a number is identified
//     (returns metadata + attached docs URLs).
//   - search_sil_corpus:      semantic RAG over indexed PDFs (use for
//     deep_insight queries that need actual statute text or arguments).
// Citations emitted with source_type='sil_*' so the UI renders the SIL
// badge instead of the plenaria-transcript badge.

const SEARCH_SIL_EXPEDIENTES_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_sil_expedientes',
    description:
      'Busca expedientes legislativos en el SIL (Sistema de Información Legislativa de Costa Rica) por palabra clave en el título y proponente. Usalo para: "¿qué proyectos de ley hay sobre X?", "expedientes de Y comisión", "iniciativas presentadas en 2024 sobre Z". Devuelve hasta K expedientes con número, título, proponente, comisión, estado y URL canónica del SIL. Citá [N] inline después de cada afirmación. NO inventes números de expediente — solo usá los que la tool devolvió.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Términos de búsqueda en español. Ej: "minería", "reforma fiscal", "Otto Guevara".',
        },
        k: {
          type: 'integer',
          description: 'Número de expedientes a recuperar (default 10, max 25).',
          default: 10,
        },
        comision: {
          type: 'string',
          description: 'Filtrar por comisión específica (omitir si no aplica).',
        },
        fecha_from: { type: 'string', description: 'Fecha desde (YYYY-MM-DD), opcional.' },
        fecha_to: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD), opcional.' },
      },
      required: ['query'],
    },
  },
};

const GET_SIL_EXPEDIENTE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'get_sil_expediente',
    description:
      'Recupera el detalle completo de un expediente legislativo por su número. Usalo cuando ya identificaste el expediente (e.g. después de search_sil_expedientes) y necesitás la lista de dictámenes, mociones y otros documentos adjuntos para responder con precisión. Devuelve metadata + lista de PDFs/HTMLs disponibles con URLs.',
    parameters: {
      type: 'object',
      properties: {
        numero: {
          type: 'integer',
          description: 'Número de expediente (entero, sin separador de miles). Ej: 22293, no "22.293".',
        },
      },
      required: ['numero'],
    },
  },
};

const SEARCH_SIL_CORPUS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_sil_corpus',
    description:
      'Búsqueda semántica sobre el corpus indexado del SIL (textos de proyectos, dictámenes, mociones). Usá esta tool cuando la pregunta requiere análisis de CONTENIDO, no solo títulos: "¿cómo se ha discutido X en el congreso?", "argumentos a favor/en contra de Y", "qué dice el dictamen de mayoría sobre Z". Más cara que search_sil_expedientes — preferila SOLO si el deep_insight está activado o si la pregunta es claramente analítica.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Pregunta o tema en lenguaje natural. La tool embebe la consulta y trae los chunks más cercanos.',
        },
        k: {
          type: 'integer',
          description: 'Número de extractos a recuperar (default 6, max 15).',
          default: 6,
        },
      },
      required: ['query'],
    },
  },
};

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

  // System message ordering: persona FIRST (kept at index 0 so prompt
  // caching against the LLM provider doesn't churn), then approved-only
  // RAG patterns (Punto Medio), then session scope (if any), then prior
  // turns (so the model has continuity), then the new user turn.
  // History is trimmed + sanitized: we only forward role∈{user,assistant}
  // entries with non-empty content, and cap to MAX_HISTORY_MESSAGES.
  const trimmedHistory: OAMessage[] = (args.history ?? [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));

  // Build the system prompt with Deep Insight semantics applied per agent.
  // When DI is on, each agent's YAML may define a `deep_insight.prompt_addendum`
  // that we append to the persona — Lexa gets "Pensamiento profundo", Atlas
  // gets "Construcción ejecutiva", Centinela gets "Análisis de patrones".
  // See docs/AGENTS.md §Deep Insight for the design rationale.
  const systemPrompt = buildAgentSystemPrompt(agent, args.deep_insight);

  const messages: OAMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(args.dynamic_rag_prompt
      ? [{ role: 'system' as const, content: args.dynamic_rag_prompt }]
      : []),
    ...(args.scope_system_prompt
      ? [{ role: 'system' as const, content: args.scope_system_prompt }]
      : []),
    ...trimmedHistory,
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
  // SIL tools: only registered when the agent YAML opts in. Letting every
  // agent see all three would balloon the system prompt and confuse the
  // model about when to use search_transcripts (plenarias) vs search_sil_*
  // (expedientes). Lexa keeps both, Atlas leans on SIL, Centinela none.
  if (hasSilTools(agent.tools)) {
    tools.push(SEARCH_SIL_EXPEDIENTES_TOOL, GET_SIL_EXPEDIENTE_TOOL, SEARCH_SIL_CORPUS_TOOL);
  }
  // Reglamento de la Asamblea — procedural knowledge layer. Lexa
  // declares it (Atlas could too, but the PROCEDURAL questions are
  // squarely Lexa's territory).
  if (hasReglamentoTool(agent.tools)) {
    tools.push(SEARCH_REGLAMENTO_TOOL);
  }
  // Graph-augmented retrieval (LightRAG). DEEP-INSIGHT-GATED.
  // The graph traversal + Opus 4.7 synthesis is our "premium reasoning" tier
  // — token-heavy, expensive, and only justified when the user explicitly
  // opts in via the Profundizar toggle. In normal mode we hide the tool
  // entirely so the model can't reach for it: vector search via
  // search_sil_corpus + search_reglamento covers ~90% of real questions
  // for ~12x lower cost. Locked 2026-04-26 after a runaway seed run made
  // the cost asymmetry concrete.
  if (hasGraphTool(agent.tools) && args.deep_insight) {
    tools.push(QUERY_LEGISLATIVE_GRAPH_TOOL);
  }
  // generate_presentation — only available when the chat is scoped to a
  // workspace AND the agent yaml declares the tool (Atlas does, Lexa/
  // Centinela don't). Without scope_workspace_id we don't know which
  // canvas to convert, so we hide the tool entirely rather than letting
  // the model attempt and fail.
  if (hasGeneratePresentationTool(agent.tools) && args.scope_workspace_id) {
    tools.push(GENERATE_PRESENTATION_TOOL);
  }
  // generate_docx — same workspace-scoping contract as generate_presentation.
  // Only Atlas declares this tool; only available when a workspace is in scope.
  if (hasGenerateDocxTool(agent.tools) && args.scope_workspace_id) {
    tools.push(GENERATE_DOCX_TOOL);
  }

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

    if (tc.function.name === 'search_sil_expedientes') {
      let parsedArgs: { query: string; k?: number; comision?: string; fecha_from?: string; fecha_to?: string };
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'invalid json' }) });
        continue;
      }

      let rows: Awaited<ReturnType<typeof searchExpedientes>> = [];
      try {
        rows = await searchExpedientes(parsedArgs);
      } catch (err) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: (err as Error).message }) });
        continue;
      }

      // Citation event — same shape as plenaria citations so the UI renders
      // them in the same cards. source_type='sil_expediente' lets the badge
      // switch and the user can click straight to the SIL detail page.
      args.onChunk({
        type: 'citation',
        payload: rows.map((r, i) => ({
          id: `sil:exp:${r.id}`,
          session_id: '',
          source_ref: `Exp. ${r.numero}`,
          content: r.titulo ?? '',
          similarity: 1 - i / Math.max(rows.length, 1), // pseudo-rank for UI ordering
          fecha: r.fecha_presentacion,
          comision: r.comision,
          tipo: r.tipo,
          source_type: 'sil_expediente',
          expediente_numero: r.numero,
          estado: r.estado,
          proponente: r.proponente,
          url_detalle: r.url_detalle,
          video_url: null,
          transcript_url: null,
        })),
      });

      const renderedExpedientes = renderExpedientesForLlm(rows);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content:
          `Resultados SIL (${rows.length}):\n\n${renderedExpedientes}\n\n---\n` +
          `INSTRUCCIONES:\n` +
          `1. Citá [N] inline después de cada afirmación que se base en un expediente.\n` +
          `2. Mencioná el número de expediente con formato "Exp. 22.293" (con punto, no coma).\n` +
          `3. Si la lista está vacía, decí "no encontré expedientes en el SIL sobre X" — no inventes.\n` +
          `4. Si necesitás detalle de un expediente específico para profundizar, llamá a get_sil_expediente con su número.\n` +
          `5. Hablale al usuario de "expediente", "proyecto de ley", "iniciativa" — nunca "row" ni "registro".`,
      });
      continue;
    }

    if (tc.function.name === 'get_sil_expediente') {
      let parsedArgs: { numero: number };
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'invalid json' }) });
        continue;
      }
      const num = Number(parsedArgs.numero);
      if (!Number.isInteger(num) || num <= 0) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'numero must be positive integer' }) });
        continue;
      }

      let exp: Awaited<ReturnType<typeof getExpedienteById>> = null;
      try {
        exp = await getExpedienteById(num);
      } catch (err) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: (err as Error).message }) });
        continue;
      }
      if (!exp) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Expediente ${num} no encontrado en la base local. Decile al usuario que ese expediente no está en SIL aún (puede ser muy reciente o estar archivado), y ofrecé buscar por palabra clave.`,
        });
        continue;
      }

      // Single-expediente citation event — useful for "tell me about Exp X"
      // queries so the UI surfaces the link prominently.
      args.onChunk({
        type: 'citation',
        payload: [
          {
            id: `sil:exp:${exp.id}`,
            session_id: '',
            source_ref: `Exp. ${exp.numero}`,
            content: exp.titulo ?? '',
            similarity: 1.0,
            fecha: exp.fecha_presentacion,
            comision: exp.comision,
            tipo: exp.tipo,
            source_type: 'sil_expediente',
            expediente_numero: exp.numero,
            estado: exp.estado,
            proponente: exp.proponente,
            url_detalle: exp.url_detalle,
            video_url: null,
            transcript_url: null,
          },
        ],
      });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content:
          `${renderExpedienteFullForLlm(exp)}\n\n---\n` +
          `INSTRUCCIONES:\n` +
          `1. Si la respuesta del usuario implica analizar el TEXTO del expediente, llamá a search_sil_corpus con palabras clave del expediente — el corpus tiene los PDFs ya parseados.\n` +
          `2. Citá [1] cuando hables de este expediente. Mencioná número como "Exp. ${exp.numero}".\n` +
          `3. Si el usuario pide el texto literal y no aparece en los documentos listados, decile que el documento aún no está indexado.`,
      });
      continue;
    }

    if (tc.function.name === 'search_reglamento') {
      let parsedArgs: { query: string; k?: number };
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'invalid json' }) });
        continue;
      }

      let hits: Awaited<ReturnType<typeof searchReglamento>> = [];
      try {
        hits = await searchReglamento(parsedArgs);
      } catch (err) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: (err as Error).message }) });
        continue;
      }

      // Citation event — articles cite as `Art. N` with their official
      // URL on asamblea.go.cr/sd/Reglamento_Asamblea/.
      args.onChunk({
        type: 'citation',
        payload: hits.map((h, i) => ({
          id: h.chunk_id,
          session_id: '',
          source_ref: h.articulo_full_title,
          content: h.content,
          similarity: h.similarity,
          fecha: null,
          comision: null,
          tipo: 'reglamento',
          source_type: 'metadata', // UI-side: render as plenaria-style card; Reglamento does not have its own card variant yet
          expediente_numero: h.articulo_numero != null ? `Art. ${h.articulo_numero}` : null,
          url_detalle: h.url,
          video_url: null,
          transcript_url: null,
          rank: i + 1,
        })),
      });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content:
          `Artículos del Reglamento (${hits.length}):\n\n${renderReglamentoForLlm(hits)}\n\n---\n` +
          `INSTRUCCIONES:\n` +
          `1. Citá [Art. N] inline después de cada afirmación procedimental. Ejemplo: "El plazo es de 8 días hábiles [Art. 113]."\n` +
          `2. Si la pregunta no se responde literalmente con los artículos devueltos, decí "el Reglamento no regula explícitamente esto" y NO inventes la respuesta.\n` +
          `3. Cuando combinés varios artículos, citá [Art. N][Art. M].\n` +
          `4. Hablale al usuario de "el Reglamento", "el artículo", "la norma" — nunca de "chunk".`,
      });
      continue;
    }

    if (tc.function.name === 'search_sil_corpus') {
      let parsedArgs: { query: string; k?: number };
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'invalid json' }) });
        continue;
      }

      let hits: Awaited<ReturnType<typeof searchSilCorpus>> = [];
      try {
        hits = await searchSilCorpus(parsedArgs);
      } catch (err) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: (err as Error).message }) });
        continue;
      }

      args.onChunk({
        type: 'citation',
        payload: hits.map((h, i) => ({
          id: h.chunk_id,
          session_id: '',
          source_ref: h.source_ref,
          content: h.content,
          similarity: h.similarity,
          fecha: h.fecha,
          comision: h.comision,
          tipo: h.tipo,
          source_type: h.source_type,
          expediente_numero: h.expediente_numero,
          url_detalle: h.url_detalle,
          video_url: null,
          transcript_url: null,
          rank: i + 1,
        })),
      });

      const renderedHits =
        hits.length === 0
          ? `SIN RESULTADOS — no encontré pasajes en el corpus SIL sobre "${parsedArgs.query}". Decile al usuario que no hay material indexado al respecto y ofrecé buscar por título con search_sil_expedientes.`
          : hits
              .map(
                (h, i) =>
                  `[${i + 1}] (${h.source_ref}, ${h.fecha ?? 's/f'}, ${h.comision ?? '—'})\n${h.content}`,
              )
              .join('\n\n---\n\n');
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content:
          `Extractos del corpus SIL (${hits.length}):\n\n${renderedHits}\n\n---\n` +
          `INSTRUCCIONES:\n` +
          `1. Citá [N] inline después de cada afirmación.\n` +
          `2. Si combinás varios extractos para argumentar, citá [N][M].\n` +
          `3. Hablale al usuario de "el dictamen", "el proyecto", "la moción" — nunca "el chunk".\n` +
          `4. Si un argumento depende de un dato que no aparece literalmente en los extractos, decí "no aparece explícito en los documentos que tengo".`,
      });
      continue;
    }

    if (tc.function.name === 'query_legislative_graph') {
      let parsedArgs: { query: string; mode?: LightragMode; deep_insight?: boolean };
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'invalid json' }) });
        continue;
      }

      const result = await queryLightrag({
        query: parsedArgs.query,
        mode: parsedArgs.mode ?? 'hybrid',
        deep_insight: parsedArgs.deep_insight ?? args.deep_insight,
      });

      // Surface the graph result to the UI as a citation event so the
      // user sees "consulté el grafo" provenance even though we don't
      // have per-entity cards yet. id stable per query so React keys
      // don't churn across re-renders.
      if (result.ok) {
        args.onChunk({
          type: 'citation',
          payload: [
            {
              id: `graph:${result.mode}:${parsedArgs.query.slice(0, 64)}`,
              session_id: '',
              source_ref: `Grafo (${result.mode})`,
              content: result.answer.slice(0, 400),
              similarity: 1.0,
              fecha: null,
              comision: null,
              tipo: 'graph_query',
              source_type: 'metadata',
              expediente_numero: null,
              url_detalle: null,
              video_url: null,
              transcript_url: null,
              rank: 1,
            },
          ],
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            `Resultado del grafo (${result.mode}):\n\n${result.answer}\n\n---\n` +
            `INSTRUCCIONES:\n` +
            `1. El texto anterior es la síntesis del grafo. Refrasealá con tu voz, no la copies textual.\n` +
            `2. Cuando uses datos del grafo, citá [Grafo].\n` +
            `3. Si el usuario pide detalle de un expediente o artículo específico mencionado por el grafo, llamá a search_sil_expedientes / get_sil_expediente / search_reglamento para confirmar — el grafo puede tener errores de extracción.\n` +
            `4. Hablale al usuario de "el corpus", "los registros", "lo documentado" — nunca "el grafo" ni "LightRAG" ni "los embeddings".`,
        });
      } else if (!result.installed) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            `GRAFO NO DISPONIBLE — el motor de grafo no está activo en este entorno. ` +
            `Caé a search_sil_corpus o search_sil_expedientes para responder esta pregunta. ` +
            `Si la consulta es estrictamente relacional ("quién está conectado con quién", "patrones entre actores"), reconocé al usuario que esa capacidad aún no está habilitada y ofrecé buscar los expedientes individualmente.`,
        });
      } else {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: `Error al consultar el grafo: ${result.detail}. Caé a search_sil_corpus para esta pregunta.`,
        });
      }
      continue;
    }

    if (tc.function.name === 'generate_presentation') {
      // Atlas tool: convert the active workspace into a Gamma deck.
      // The chat MUST be scoped to a workspace (scope_workspace_id set);
      // we already gate registration on this, but defensive check anyway.
      if (!args.scope_workspace_id) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: 'no_workspace_scope',
            hint: 'La presentación requiere abrir un workspace primero.',
          }),
        });
        continue;
      }

      let parsedArgs: { force?: boolean } = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        // Empty or malformed args is fine for this tool — defaults to force=false.
      }

      // Emit a status chunk so the chat UI can render "generando…" inline
      // while we wait. Without this, the user would see Atlas's prose
      // response only after the 30-60s Gamma round-trip completes.
      args.onChunk({
        type: 'pptx_status',
        payload: { status: 'starting', workspace_id: args.scope_workspace_id },
      });

      if (!args.user_id) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: 'auth_required',
            hint: 'No tengo identidad del usuario para generar el deck.',
          }),
        });
        continue;
      }

      try {
        const { runWorkspacePptxExport } = await import('./workspacePptxExport.js');
        const result = await runWorkspacePptxExport({
          workspaceId: args.scope_workspace_id,
          userId: args.user_id,
          force: parsedArgs.force ?? false,
        });

        // Push the structured event the chat UI renders as a card.
        args.onChunk({
          type: 'pptx_ready',
          payload: {
            filename: result.filename,
            url: result.exportUrl,
            gammaUrl: result.gammaUrl,
            generationId: result.generationId,
            cached: result.cached,
            generatedAt: result.generatedAt,
          },
        });

        // Tell the model what happened so its prose response can reference
        // the deck without re-asking the user.
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            `Presentación generada con Gamma (${result.cached ? 'cache' : 'fresca'}).\n` +
            `Editable: ${result.gammaUrl}\n` +
            `Descarga: ${result.exportUrl}\n` +
            `Filename: ${result.filename}\n\n` +
            `INSTRUCCIONES:\n` +
            `1. Confirmale al usuario que está lista (1-2 frases).\n` +
            `2. NO pegues las URLs en tu respuesta — el frontend ya las muestra como botones.\n` +
            `3. Sugerí qué podría editar en Gamma si querés (cover, orden de cards, etc.).`,
        });
      } catch (err) {
        const message = (err as Error).message ?? 'unknown';
        const code = (err as Error & { code?: string }).code ?? 'unknown';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: code, detail: message }),
        });
        args.onChunk({
          type: 'pptx_status',
          payload: { status: 'error', code, detail: message },
        });
      }
      continue;
    }

    if (tc.function.name === 'generate_docx') {
      if (!args.scope_workspace_id) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: 'no_workspace_scope',
            hint: 'El documento requiere abrir un workspace primero.',
          }),
        });
        continue;
      }

      if (!args.user_id) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: 'auth_required',
            hint: 'No tengo identidad del usuario para generar el documento.',
          }),
        });
        continue;
      }

      let parsedArgs: { tono?: string; audiencia?: string; sendToCanvas?: boolean } = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        // Defaults are fine
      }

      // Status chunk so the UI can show "generando Word…"
      args.onChunk({
        type: 'docx_status' as never,
        payload: { status: 'starting', workspace_id: args.scope_workspace_id },
      } as never);

      try {
        const { renderDocxAsset } = await import('./docxAssetExport.js');
        const { createClient } = await import('@supabase/supabase-js');

        // Load workspace + nodes (same pattern as the HTTP route)
        const _supa = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } },
        );

        const { data: ws } = await _supa
          .from('workspaces')
          .select('id, title, description')
          .eq('id', args.scope_workspace_id)
          .eq('user_id', args.user_id)
          .single();

        const { data: nodes } = await _supa
          .from('workspace_nodes')
          .select('id, title, subtitle, content, x, y')
          .eq('workspace_id', args.scope_workspace_id);

        const ordered = ((nodes ?? []) as Array<{
          id: string; title: string; subtitle: string | null;
          content: Record<string, unknown> | null; x: number; y: number;
        }>).slice().sort((a, b) => {
          const yA = Math.floor(a.y / 200);
          const yB = Math.floor(b.y / 200);
          if (yA !== yB) return yA - yB;
          return a.x - b.x;
        });

        const slides = [
          {
            idx: 0,
            kind: 'cover' as const,
            headline: ws?.title ?? 'Documento CL2',
            body: ws?.description ?? undefined,
          },
          ...ordered.map((n, i) => {
            const md = (n.content?.md as string) ?? '';
            const isQuote = md.trim().startsWith('> ');
            return {
              idx: i + 1,
              kind: (isQuote ? 'quote' : (i === 0 ? 'section' : 'content')) as
                'quote' | 'section' | 'content',
              eyebrow: n.subtitle ?? undefined,
              headline: n.title as string,
              body: (isQuote ? md.trim().replace(/^> /gm, '') : md.trim()) || undefined,
            };
          }),
        ];

        const result = await renderDocxAsset({
          content: { title: ws?.title ?? 'Documento CL2', slides },
          options: {
            tono: parsedArgs.tono,
            audiencia: parsedArgs.audiencia,
          },
          userId: args.user_id,
          workspaceId: args.scope_workspace_id,
        });

        // Insert canvas node
        const sendToCanvas = parsedArgs.sendToCanvas !== false;
        let nodeId: string | null = null;
        if (sendToCanvas) {
          const { data: node } = await _supa
            .from('workspace_nodes')
            .insert({
              workspace_id: args.scope_workspace_id,
              user_id: args.user_id,
              type: 'docx_asset',
              title: `${ws?.title ?? 'Documento'} · Word`,
              subtitle: result.filename,
              x: 40,
              y: 40,
              width: 360,
              height: 200,
              content: {
                kind: 'docx_asset',
                asset_metadata: {
                  export_url: result.export_url,
                  filename: result.filename,
                  size_bytes: result.size_bytes,
                  generated_at: result.generated_at,
                  gcs_path: result.gcs_path,
                },
                asset_slides: slides,
              },
            })
            .select('id')
            .single();
          nodeId = node?.id ?? null;
        }

        args.onChunk({
          type: 'docx_ready' as never,
          payload: {
            filename: result.filename,
            url: result.export_url,
            size_bytes: result.size_bytes,
            node_id: nodeId,
            generated_at: result.generated_at,
          },
        } as never);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            `Documento Word generado.\n` +
            `Filename: ${result.filename}\n` +
            `Descarga: ${result.export_url}\n` +
            `Tamaño: ${Math.round(result.size_bytes / 1024)} KB\n\n` +
            `INSTRUCCIONES:\n` +
            `1. Confirmale al usuario que el documento está listo (1-2 frases).\n` +
            `2. NO pegues la URL en tu respuesta — el frontend ya muestra el botón de descarga.\n` +
            `3. Mencioná que es editable en Word y está en A4 para impresión.`,
        });
      } catch (err) {
        const message = (err as Error).message ?? 'unknown';
        const code = (err as Error & { code?: string }).code ?? 'docx_failed';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: code, detail: message }),
        });
        args.onChunk({
          type: 'docx_status' as never,
          payload: { status: 'error', code, detail: message },
        } as never);
      }
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
