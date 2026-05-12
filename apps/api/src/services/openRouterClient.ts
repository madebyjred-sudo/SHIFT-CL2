import type { CerebroStreamChunk, AgentId } from '@shift-cl2/shared-types';
import { getAgent, buildAgentSystemPrompt } from './agentLoader.js';
import { searchTranscripts, type ChunkHit } from './searchTranscripts.js';
import { searchSessionTranscript, searchSessionTranscriptByUuid } from './searchSessionTranscript.js';
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
// Timeouts subidos 2026-05-12 tras refactor de pasar transcript completo en
// system prompt. Sonnet con 30-60k input tokens + output narrativo de 1-2k
// tokens tarda 20-50s. El timeout previo de 30s fallaba en sesiones largas.
const OR_PASS1_TIMEOUT_MS = 90_000;
const OR_PASS1_RETRY_ATTEMPTS = 2;
const OR_PASS1_RETRY_BASE_MS = 600;
const OR_STREAM_OPEN_TIMEOUT_MS = 60_000;

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
  // match over segments, with timecodes returned for citation. Pragmatic
  // stand-in for full RAG (Phase 3 of docs/issues/001).
  //
  // Hay dos formas de scope-de-sesión (mutuamente exclusivas):
  //   - scope_legacy_session_id: int legacy (MariaDB) — sesiones pre-2026-05
  //   - scope_session_uuid:      UUID (Supabase)      — sesiones nuevas
  // El handler de la tool elige el path según cuál esté presente.
  scope_legacy_session_id?: number | null;
  scope_session_uuid?: string | null;
  // When set, enables `generate_presentation` for Atlas. The tool composes
  // every hoja in this workspace into a Gamma deck and emits a `pptx_ready`
  // chunk to the client. Without this scope, Atlas can't generate decks
  // (it doesn't know which workspace).
  scope_workspace_id?: string | null;
  // Authenticated user — required for tools that touch user-scoped data
  // (currently: generate_presentation, which UPDATEs workspaces.last_pptx).
  // Caller (chat router) should set this from the verified Supabase JWT.
  user_id?: string | null;
  // Canonical email for Cerebro neuron lookups. When present, we fetch the
  // user's /memories before the LLM call and inject as a system block —
  // gives Lexa/Atlas/Centinela memory across conversations without going
  // through Cerebro's /v1/llm/invoke (the bypass-closure path; deferred).
  // null/undefined → skip injection silently.
  user_email?: string | null;
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

// Track B (2026-05-11): el chat principal sale por Cerebro
// (`/v1/chat/completions`), no por OpenRouter directo. Cerebro hace
// passthrough de las 12 tools (external dispatching SSE) + maneja el
// memory tool internamente cuando enable_memory=true.
//
// El nombre `OR_BASE` y `openRouterStream` se mantienen — refactorear
// nombres ahora multiplica el diff sin valor. Operativamente, "OpenRouter
// directo" murió este día.
const OR_BASE = (process.env.CEREBRO_BASE_URL ?? 'https://shift-cerebro-production.up.railway.app') + '/v1';

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

function hasGenerateAssetTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'generate_asset');
}

function hasEditAssetSlideTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'edit_asset_slide');
}

function hasGenerateDocxTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'generate_docx');
}

function hasCreateWorkspaceTool(agentTools: Array<Record<string, unknown>>): boolean {
  return agentTools.some((t) => t.name === 'create_workspace');
}

// create_workspace — Atlas tool que crea un workspace nuevo desde el chat
// general. A diferencia de generate_presentation/generate_docx, este NO
// está gated por scope_workspace_id porque su propósito es generar uno
// nuevo, no operar sobre uno existente. Cuando se dispara: crea el row
// en `workspaces`, opcionalmente populate con sources (sesiones,
// expedientes) que el usuario mencionó, emite un chunk `workspace_created`
// para que el frontend rutee al canvas.
const CREATE_WORKSPACE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'create_workspace',
    description:
      'Crea un nuevo workspace ("hoja de trabajo") y opcionalmente lo populá con sesiones o expedientes que el usuario mencione. Disparalo cuando el usuario pida explícitamente: "armame un workspace de X", "creá una hoja con la sesión Y y el expediente Z", "necesito un nuevo espacio para analizar W". NO lo dispares sin un pedido explícito. El frontend automáticamente abrirá el workspace nuevo después de crearlo.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description:
            'Título corto del workspace. Si el usuario no lo dijo, sugerí uno descriptivo (3-7 palabras) basado en el tema.',
        },
        description: {
          type: 'string',
          description: 'Descripción opcional, 1-2 oraciones, contexto del análisis.',
        },
        seed_sources: {
          type: 'array',
          description:
            'Sesiones o expedientes a importar como hojas iniciales del canvas. Cada item: {type, id}. Si el usuario no mencionó ninguno, dejá array vacío.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['sesion', 'expediente'], description: 'Tipo de recurso a importar.' },
              id: { type: 'string', description: 'UUID de sesión o número de expediente.' },
            },
            required: ['type', 'id'],
          },
        },
      },
      required: ['title'],
    },
  },
};

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

// generate_asset — Atlas tool that turns the active workspace into a
// branded asset (carousel / pptx / document) using the new
// atlasContentGenerator + htmlAssetRenderer pipeline. Replaces the Gamma
// flow for these formats. Emits an `asset_ready` chunk that the chat UI
// renders as an inline preview card.
const GENERATE_ASSET_TOOL = {
  type: 'function' as const,
  function: {
    name: 'generate_asset',
    description:
      'Convierte el workspace activo en un asset publicable con la identidad visual de CL2 (carrusel cuadrado para LinkedIn / IG, presentación 16:9, o documento ejecutivo A4 multipágina). Disparalo SOLO cuando el usuario pide explícitamente uno de estos formatos ("hacé un carrusel", "convertí esto en presentación", "armame un documento"). El asset queda como nodo del canvas y editable slide por slide via edit_asset_slide.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['carousel', 'pptx', 'document'],
          description: 'Tipo de asset. carousel = 1080x1080 cuadrado para social. pptx = 1920x1080 deck corporativo. document = A4 portrait multipágina.',
        },
        tono: { type: 'string', description: 'Ej: "editorial", "alerta urgente", "explicativo".' },
        audiencia: { type: 'string', description: 'Ej: "clientes corporativos", "prensa", "bancada legislativa".' },
        hook: { type: 'string', description: 'Estilo de hook para slide 1 (carousel/pptx). Opcional.' },
        numSlides: { type: 'integer', description: 'Override de cantidad de slides. Carousel default 8 (4..12), pptx default 14 (8..20), document default 6 (4..16).' },
        cta: { type: 'string', description: 'Texto del CTA final.' },
        marca: { type: 'string', description: 'Lineamientos de voz de marca adicionales.' },
        emojis: { type: 'boolean', description: 'true para permitir emojis. Default false (CL2 no los usa).', default: false },
      },
      required: ['kind'],
    },
  },
};

// edit_asset_slide — chat-driven per-slide editor. The model identifies
// which slide and what change; the dispatcher calls the existing
// /assets/:nodeId/slides/:slideIdx/edit endpoint and re-renders the PDF.
const EDIT_ASSET_SLIDE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'edit_asset_slide',
    description:
      'Edita un slide específico de un asset previamente generado en el workspace. Usalo cuando el usuario pide un cambio puntual ("hacé el slide 3 más fuerte", "cambiá el titular del cover", "agregá un punto al slide 5"). Re-renderea el PDF entero (~5s) y guarda before/after en el historial.',
    parameters: {
      type: 'object',
      properties: {
        asset_node_id: {
          type: 'string',
          description: 'UUID del nodo del asset (devuelto por generate_asset). Si el usuario solo dice "el carrusel", asumí el asset más reciente del canvas.',
        },
        slide_index: {
          type: 'integer',
          description: 'Índice 1-based de la slide a editar.',
        },
        instruction: {
          type: 'string',
          description: 'Instrucción en lenguaje natural sobre qué cambiar ("hacé el headline más punchy", "agregá un cuarto bullet sobre X", "cambiá el tono a más urgente").',
        },
      },
      required: ['asset_node_id', 'slide_index', 'instruction'],
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
 * Streams Lexa/Atlas/Centinela responses via Cerebro `/v1/chat/completions`.
 *
 * Track B landed 2026-05-11. Antes: fetch directo a OpenRouter. Ahora:
 * Cerebro `feat/oai-compat` extendido. Beneficios:
 *   - cerebro_llm_calls insert con cost + cache + latency per turn
 *   - prompt-caching (cache_control) → ~80% cost reduction en system blocks
 *     repetidos turno a turno
 *   - memory tool auto-dispatch server-side cuando enable_memory=true +
 *     realm + user_id. Las 13 tools posibles (12 mías + memory) se
 *     clasifican en el adapter: memory → swallowed + ejecutado contra
 *     /v1/neuron storage; otras → streameadas al caller para dispatch.
 *     Lexa "recuerda" sin que CL2 toque UI ni dispatcher de memoria.
 *   - cierre del bypass arquitectural (Cerebro vuelve a ser gateway real)
 *
 * Si agent declara tools, runs 2-pass loop:
 *   Pass 1 (non-stream): model decide tool_calls (mis tools)
 *   Pass 2 (stream): final answer con tool results
 * Sin tools: 1-pass stream directo.
 */
export async function openRouterStream(args: StreamArgs): Promise<void> {
  // Track B: Bearer key es la de Cerebro (entregada con feat/oai-compat).
  // Fallback a OPENROUTER_API_KEY mientras drainamos el rollout — si en
  // alguna revisión el env de Cerebro no está seteado, podemos seguir
  // funcionando contra OpenRouter directo (sin memory ni cost logging,
  // pero el chat responde). Eliminamos el fallback en un commit
  // siguiente cuando el smoke esté verde 24h.
  const orKey = process.env.CEREBRO_API_KEY ?? process.env.OPENROUTER_API_KEY ?? '';
  if (!orKey) throw new Error('CEREBRO_API_KEY not set');

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

  // Cerebro-specific body extras (Track B 2026-05-11). Estos campos los
  // entiende `feat/oai-compat` y son los que disparan:
  //   - cerebro_llm_calls insert con cost + cache + latency
  //   - memory tool inyectado al loop server-side cuando user_email existe
  //   - cache_control hint pasa intacto a Anthropic
  // Si el user es anónimo (public demo) NO mandamos user_id ni enable_memory
  // — Cerebro acepta requests sin memoria, y el adapter NO requiere realm
  // cuando memoria está off.
  const userEmail = args.user_email ?? null;
  const cerebroExtras = {
    tenant: 'cl2',
    app_id: 'cl2',
    trace_label: `cl2:chat:${args.agent_id}${args.deep_insight ? ':di' : ''}`,
    ...(userEmail
      ? { realm: 'cl2', user_id: userEmail, enable_memory: true }
      : {}),
  };

  // Build the system prompt with Deep Insight semantics applied per agent.
  // When DI is on, each agent's YAML may define a `deep_insight.prompt_addendum`
  // that we append to the persona — Lexa gets "Pensamiento profundo", Atlas
  // gets "Construcción ejecutiva", Centinela gets "Análisis de patrones".
  // See docs/AGENTS.md §Deep Insight for the design rationale.
  const systemPrompt = buildAgentSystemPrompt(agent, args.deep_insight);

  // NOTA — memoria del usuario (neurons):
  // El chat principal NO inyecta la neurona como system block. Ese fue un
  // anti-pattern intentado el 2026-05-11 que se revirtió el mismo día.
  // La integración correcta vive del lado de Cerebro: cuando aterrice
  // `feat/oai-compat` extendido (Track A — sesión Cerebro), CL2 va a
  // migrar `openRouterStream` a `/v1/chat/completions` de Cerebro con
  // `enable_memory: true`, y el memory tool va a operar dentro del
  // loop, leyendo y ESCRIBIENDO automáticamente sin que la app meta
  // mano en el system prompt. Ver project_cl2_bypass.md.
  //
  // `args.user_email` se queda en StreamArgs porque Track B (la
  // migración) lo va a necesitar como `user_id` en el payload de
  // Cerebro. No se usa acá todavía.

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
  const scopeUuid = args.scope_session_uuid ?? null;
  // search_session_transcript se registra SOLO cuando NO tenemos el
  // transcript completo en el system prompt. Si scope_system_prompt
  // contiene "=== TRANSCRIPCIÓN COMPLETA ===" (sessions UUID con
  // transcript inline tras el refactor 2026-05-12), no hace falta la
  // tool — el modelo lee el transcript directo. Registrarla en ese
  // caso solo agrega input tokens innecesarios y tienta al modelo a
  // hacer una llamada que termina en pass2 vacío.
  // El path legacy (scope_legacy_session_id) NO incluye transcript en
  // el prompt todavía, entonces sigue necesitando la tool.
  const transcriptInPrompt =
    typeof args.scope_system_prompt === 'string' &&
    args.scope_system_prompt.includes('=== TRANSCRIPCIÓN COMPLETA ===');
  if ((scopeId !== null || scopeUuid !== null) && !transcriptInPrompt) {
    tools.push(SEARCH_SESSION_TRANSCRIPT_TOOL);
  }
  // DEBUG: traza de tools registradas — quitar tras confirmar el flow.
  console.log('[chat] tools registered:', {
    agent_id: agent.id,
    has_search_session_transcript: scopeId !== null || scopeUuid !== null,
    scopeId,
    scopeUuid: scopeUuid?.slice(0, 8),
    has_scope_system_prompt: typeof args.scope_system_prompt === 'string' && args.scope_system_prompt.length > 0,
  });
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
  // generate_asset / edit_asset_slide — branded HTML→PDF pipeline.
  // Same workspace-scope gate as the legacy tools above.
  if (hasGenerateAssetTool(agent.tools) && args.scope_workspace_id) {
    tools.push(GENERATE_ASSET_TOOL);
  }
  if (hasEditAssetSlideTool(agent.tools) && args.scope_workspace_id) {
    tools.push(EDIT_ASSET_SLIDE_TOOL);
  }
  // create_workspace — Atlas tool para CREAR un workspace nuevo. NO está
  // scope-gated porque su propósito es generar uno desde cero, partiendo
  // del chat general. Cualquier agent que lo declare en su YAML lo recibe.
  if (hasCreateWorkspaceTool(agent.tools)) {
    tools.push(CREATE_WORKSPACE_TOOL);
  }

  if (tools.length === 0) {
    await streamCompletion(
      { model, messages, max_tokens: 2048, ...cerebroExtras },
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
          max_tokens: 2048,
          ...cerebroExtras,
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

  // DEBUG: traza del pass1 — quitar tras diagnosticar el flow UUID.
  console.log('[chat] pass1 result:', {
    model,
    finish_reason: choice?.finish_reason,
    tool_calls_count: toolCalls.length,
    tool_names: toolCalls.map((t) => t.function?.name).join(','),
    content_length: (choice?.message?.content ?? '').length,
    content_preview: (choice?.message?.content ?? '').slice(0, 200),
    tools_registered: tools.map((t: Record<string, unknown>) => (t.function as { name?: string } | undefined)?.name ?? 'unknown').join(','),
  });

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

      // Emit citations to frontend before final response streams. For
      // transcript chunks we pass the per-chunk start_seconds along so the
      // UI can render a clickable HH:MM:SS pill that deep-links into the
      // YouTube video at the exact moment.
      args.onChunk({
        type: 'citation',
        payload: hits.map((h) => {
          const startS = typeof h.metadata?.start === 'number' ? h.metadata.start : null;
          const deepLink =
            h.video_url && startS != null && startS > 0
              ? `${h.video_url}${h.video_url.includes('?') ? '&' : '?'}t=${Math.floor(startS)}s`
              : h.video_url;
          return {
            id: h.chunk_id,
            session_id: h.session_id,
            source_ref: h.source_ref,
            content: h.content,
            similarity: h.similarity,
            fecha: h.fecha,
            comision: h.comision,
            tipo: h.tipo,
            video_url: deepLink,
            transcript_url: h.transcript_url,
            timecode_s: startS,
            timecode_label: startS != null ? fmtTimecode(startS) : null,
          };
        }),
      });

      // Render chunks as numbered prose so the model treats them as discrete,
      // citable units rather than fungible context. Includes the per-chunk
      // timecode (HH:MM:SS) when metadata.start is present — this is the
      // data layer that lets the model emit precise citations of the form
      // "[3] (Sesión 84 · 1:23:45)" instead of generic "según la sesión 84".
      const renderedChunks =
        hits.length === 0
          ? 'SIN RESULTADOS — no encontré transcripciones relevantes para esta consulta. Decile al usuario que no hay información documentada al respecto.'
          : hits
              .map((h, i) => {
                const startS = typeof h.metadata?.start === 'number' ? h.metadata.start : null;
                const endS = typeof h.metadata?.end === 'number' ? h.metadata.end : null;
                const tcRange =
                  startS != null
                    ? endS != null && endS > startS
                      ? ` · ${fmtTimecode(startS)}–${fmtTimecode(endS)}`
                      : ` · ${fmtTimecode(startS)}`
                    : '';
                return `[${i + 1}] (${h.comision}, ${h.fecha ?? 'fecha desconocida'}, sesión ${h.source_ref}${tcRange})\n${h.content}`;
              })
              .join('\n\n---\n\n');

      const toolPayload =
        `Extractos recuperados (${hits.length}):\n\n${renderedChunks}\n\n---\n` +
        `INSTRUCCIONES:\n` +
        `1. Citá [N] inline después de cada afirmación. CUANDO EL EXTRACTO TIENE TIMECODE (HH:MM:SS o M:SS al lado del número de sesión en el encabezado), agregalo entre paréntesis después de [N]. Ejemplo: "El diputado pidió posponer la votación [2] (Sesión 84 · 1:23:45)." Esto le permite al usuario hacer click y saltar al momento exacto del video — el timecode NO es decorativo, es la cita.\n` +
        `2. Si un extracto no contiene literalmente lo que el usuario pide, decí "no encontré X en las transcripciones que tengo". NO inferas desde otra sesión, NO sintetices agendas/firmas/votaciones que no estén explícitas.\n` +
        `3. Si combinás info de varios extractos, usá [N][M] con sus timecodes respectivos.\n` +
        `4. Si un extracto NO trae timecode (chunk antiguo sin metadata), citá solo "(Sesión N, fecha)" — nunca inventes el timecode.\n` +
        `5. NUNCA uses la palabra "chunk" o "chunks" al hablarle al usuario — usá "transcripciones", "fuentes", "registros", "lo documentado" o "el momento en el que…".`;

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolPayload,
      });
      continue;
    }

    if (tc.function.name === 'search_session_transcript') {
      // Defensive: only valid when this turn has a scope (legacy id O UUID).
      // The tool isn't even registered sin scope, así que llegar acá significa
      // que el modelo alucinó la call.
      if (scopeId === null && scopeUuid === null) {
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
        // Sesiones nuevas (UUID) van por Supabase; legacy por MariaDB.
        // Solo uno de los dos puede estar seteado en una request real.
        result = scopeUuid !== null
          ? await searchSessionTranscriptByUuid(scopeUuid, parsedArgs.query, parsedArgs.top_k)
          : await searchSessionTranscript(scopeId!, parsedArgs.query, parsedArgs.top_k);
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
          `INSTRUCCIONES DE INTERPRETACIÓN (importante):\n` +
          `1. La sección "ESTATUS FORMAL" al inicio es la fuente de verdad sobre si el expediente es ley, fue archivado, tiene dispensa, etc. Cuando el usuario pregunte "¿es ley?", "¿está aprobado?", "¿qué pasó con esto?" — respondé MIRANDO esa sección, NO el campo "Estado físico actual" (que es solo la comisión donde está físicamente el expediente).\n` +
          `2. Si dice "✅ ES LEY" → el expediente YA es ley publicada, decílo claramente con el N° de Ley y N° de Gaceta si están.\n` +
          `3. Si dice "📦 ARCHIVADO" → el expediente NO avanzó, fue archivado, ya no aplica.\n` +
          `4. Si dice "🟡 EN TRÁMITE" → todavía no es ley ni fue archivado, está en proceso. Mencioná en qué comisión está y si hay plazo de vencimiento.\n` +
          `5. Si dice "⚡ DISPENSA" → tuvo fast-track (sin pasar por comisión), políticamente relevante.\n` +
          `6. Si la respuesta del usuario implica analizar el TEXTO del expediente, llamá a search_sil_corpus con palabras clave — el corpus tiene los PDFs ya parseados.\n` +
          `7. Citá [1] cuando hables de este expediente. Mencioná número como "Exp. ${exp.numero}".\n` +
          `8. Si el usuario pide el texto literal y no aparece en los documentos listados, decile que el documento aún no está indexado.`,
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

      // Map source_type → short, user-facing doc kind so the LLM can cite
      // it cleanly. e.g. 'sil_dictamen' → 'Dictamen', 'sil_mocion' →
      // 'Moción'. The dispatcher prints the kind in the chunk header; the
      // model is instructed to surface it inside the citation parens.
      const silTipoLabel = (sourceType: string | null): string => {
        if (!sourceType) return 'doc';
        const map: Record<string, string> = {
          sil_dictamen: 'Dictamen',
          sil_dictamen_mayoria: 'Dictamen mayoría',
          sil_dictamen_minoria: 'Dictamen minoría',
          sil_dictamen_unanime: 'Dictamen unánime',
          sil_mocion: 'Moción',
          sil_expediente: 'Expediente',
          sil_acuerdo: 'Acuerdo',
          sil_audiencia: 'Audiencia',
          sil_consulta: 'Consulta',
          sil_informe: 'Informe',
        };
        return map[sourceType] ?? sourceType.replace(/^sil_/, '').replace(/_/g, ' ');
      };

      const renderedHits =
        hits.length === 0
          ? `SIN RESULTADOS — no encontré pasajes en el corpus SIL sobre "${parsedArgs.query}". Decile al usuario que no hay material indexado al respecto y ofrecé buscar por título con search_sil_expedientes.`
          : hits
              .map((h, i) => {
                const exp = h.expediente_numero ? `Exp. ${h.expediente_numero}` : h.source_ref;
                const kind = silTipoLabel(h.source_type);
                const fecha = h.fecha ?? 's/f';
                return `[${i + 1}] (${exp} · ${kind} · ${fecha}${h.comision ? ` · ${h.comision}` : ''})\n${h.content}`;
              })
              .join('\n\n---\n\n');
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content:
          `Extractos del corpus SIL (${hits.length}):\n\n${renderedHits}\n\n---\n` +
          `INSTRUCCIONES:\n` +
          `1. Citá [N] inline después de cada afirmación, e INCLUÍ entre paréntesis el expediente + tipo de documento + fecha. Ejemplo: "El proponente argumenta riesgo sistémico [2] (Exp. 24.429 · Dictamen mayoría · 14-mar-2026)." NO basta con "[2]" suelto — el usuario está en CL2 para poder volver a la fuente exacta.\n` +
          `2. Si combinás varios extractos para argumentar, citá [N][M] con sus identificadores respectivos.\n` +
          `3. Hablale al usuario de "el dictamen", "el proyecto", "la moción", "el expediente" — nunca "el chunk", "el chunk del corpus", "el embedding".\n` +
          `4. Si un argumento depende de un dato que no aparece literalmente en los extractos, decí "no aparece explícito en los documentos que tengo". NO rellenes con conocimiento general sobre derecho costarricense.\n` +
          `5. Si el usuario te pidió el ESTATUS FORMAL de un expediente (¿es ley?, ¿está archivado?, ¿vencido?), ESTA tool no responde eso — tenés que llamar get_sil_expediente con el número y leer la sección "ESTATUS FORMAL" que devuelve. Los extractos de corpus traen contenido sustantivo, no metadatos de status.`,
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

    if (tc.function.name === 'create_workspace') {
      // Atlas tool — crea workspace + opcionalmente importa sources iniciales.
      // Requiere user_id (es ownership). El dispatcher emite chunk
      // `workspace_created` con la URL para que el frontend navegue.
      if (!args.user_id) {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: 'auth_required',
            hint: 'No tengo identidad del usuario para crear el workspace.',
          }),
        });
        continue;
      }

      let parsedArgs: {
        title?: string;
        description?: string;
        seed_sources?: Array<{ type: 'sesion' | 'expediente'; id: string }>;
      } = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        // Args malformados — caemos a defaults; el modelo va a recibir
        // el error en el tool response y puede re-intentar.
      }

      const title = (parsedArgs.title ?? 'Nueva hoja de trabajo').slice(0, 200);

      try {
        const { createWorkspaceForUser } = await import('../routes/workspaceHelpers.js');
        const result = await createWorkspaceForUser({
          userId: args.user_id,
          title,
          description: parsedArgs.description ?? null,
          seedSources: parsedArgs.seed_sources ?? [],
        });

        // Emit structured event so the chat UI can render a "go to workspace"
        // card AND optionally auto-navigate.
        args.onChunk({
          type: 'workspace_created',
          payload: {
            id: result.workspace_id,
            title,
            url: `/hojas/${result.workspace_id}`,
            seeds_imported: result.seeds_imported,
            seeds_failed: result.seeds_failed,
          },
        });

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            `Workspace creado: "${title}".\n` +
            `URL: /hojas/${result.workspace_id}\n` +
            `Sources importados: ${result.seeds_imported}/${result.seeds_imported + result.seeds_failed}\n\n` +
            `INSTRUCCIONES:\n` +
            `1. Confirmale al usuario que ya está creado (1-2 frases).\n` +
            `2. NO pegues la URL en tu respuesta — el frontend muestra un botón.\n` +
            `3. Sugerí 1-2 cosas que puede hacer en el workspace (analizar, agregar más fuentes, exportar a Word).`,
        });
      } catch (err) {
        const message = (err as Error).message ?? 'unknown';
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: 'create_failed', detail: message }),
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

    if (tc.function.name === 'generate_asset') {
      // Atlas tool: branded HTML→PDF asset (carousel/pptx/document).
      // Mirrors the contract of generate_presentation but routes through
      // atlasContentGenerator + htmlAssetRenderer instead of Gamma.
      if (!args.scope_workspace_id) {
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ error: 'no_workspace_scope', hint: 'El asset requiere abrir un workspace primero.' }),
        });
        continue;
      }
      if (!args.user_id) {
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ error: 'auth_required', hint: 'No tengo identidad del usuario.' }),
        });
        continue;
      }
      let parsedArgs: {
        kind?: 'carousel' | 'pptx' | 'document';
        tono?: string; audiencia?: string; hook?: string;
        numSlides?: number; cta?: string; marca?: string; emojis?: boolean;
      } = {};
      try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch {/* defaults */}
      const kind = parsedArgs.kind;
      if (!kind || !['carousel','pptx','document'].includes(kind)) {
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ error: 'invalid_kind', hint: 'kind must be carousel|pptx|document' }),
        });
        continue;
      }

      args.onChunk({
        type: 'pptx_status',
        payload: { status: 'starting', workspace_id: args.scope_workspace_id, kind },
      });

      try {
        const { generateAssetContent } = await import('./atlasContentGenerator.js');
        const { renderAssetToPdf } = await import('./htmlAssetRenderer.js');
        const { createClient } = await import('@supabase/supabase-js');
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
        const wsTitle = (ws?.title as string | undefined) ?? 'Workspace';

        const content = await generateAssetContent({
          workspaceId: args.scope_workspace_id,
          userId: args.user_id,
          kind,
          options: {
            tono: parsedArgs.tono,
            audiencia: parsedArgs.audiencia,
            hook: parsedArgs.hook,
            numSlides: parsedArgs.numSlides,
            cta: parsedArgs.cta,
            marca: parsedArgs.marca,
            emojis: parsedArgs.emojis,
          },
        });

        // Pre-allocate node so the GCS object path is stable.
        const nodeType = kind === 'carousel' ? 'carousel' : kind === 'pptx' ? 'pptx_asset' : 'docx_asset';
        const titleSuffix = kind === 'carousel' ? 'Carrusel' : kind === 'pptx' ? 'Presentación' : 'Documento';
        const { data: existing } = await _supa
          .from('workspace_nodes')
          .select('x, width')
          .eq('workspace_id', args.scope_workspace_id);
        const maxX = (existing ?? []).reduce(
          (m, n) => Math.max(m, ((n.x as number) ?? 0) + ((n.width as number) ?? 360)),
          0,
        );
        const { data: node } = await _supa
          .from('workspace_nodes')
          .insert({
            workspace_id: args.scope_workspace_id,
            type: nodeType,
            title: `${wsTitle} · ${titleSuffix}`,
            subtitle: 'Generando…',
            x: maxX > 0 ? maxX + 40 : 40,
            y: 40,
            width: 360,
            height: 200,
            content: { kind: nodeType },
            asset_metadata: { kind: nodeType, generating: true, source: 'atlas' },
            asset_slides: content.slides,
            asset_slide_history: [],
          })
          .select('id')
          .single();
        const nodeId = node?.id as string | undefined;
        if (!nodeId) throw new Error('asset_node_insert_failed');

        const render = await renderAssetToPdf({
          content,
          kind,
          userId: args.user_id,
          workspaceId: args.scope_workspace_id,
          nodeId,
          workspaceTitle: wsTitle,
        });

        const newMeta = {
          kind: nodeType,
          export_url: render.exportUrl,
          gcs_path: render.gcsPath,
          filename: render.filename,
          slides_count: render.slidesCount,
          generated_at: render.generatedAt,
          options: {
            tono: parsedArgs.tono ?? null,
            audiencia: parsedArgs.audiencia ?? null,
            hook: parsedArgs.hook ?? null,
            numSlides: parsedArgs.numSlides ?? null,
            cta: parsedArgs.cta ?? null,
            marca: parsedArgs.marca ?? null,
            emojis: parsedArgs.emojis ?? false,
          },
          source: 'atlas' as const,
        };
        await _supa
          .from('workspace_nodes')
          .update({ subtitle: render.filename, asset_metadata: newMeta })
          .eq('id', nodeId);
        await _supa
          .from('workspaces')
          .update({ updated_at: render.generatedAt })
          .eq('id', args.scope_workspace_id);

        // Reuse pptx_ready chunk shape so the frontend's existing renderer
        // shows the asset card without needing a new event type yet.
        args.onChunk({
          type: 'pptx_ready',
          payload: {
            filename: render.filename,
            url: render.exportUrl,
            gammaUrl: render.exportUrl, // legacy field; assets don't have a gamma editable URL
            generationId: nodeId,
            cached: false,
            generatedAt: render.generatedAt,
          },
        });

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            `Asset generado (kind=${kind}, slides=${render.slidesCount}).\n` +
            `Node id: ${nodeId}\n` +
            `Descarga: ${render.exportUrl}\n\n` +
            `INSTRUCCIONES:\n` +
            `1. Confirmá al usuario que el ${kind} está listo (1-2 frases).\n` +
            `2. NO pegues la URL — el frontend ya la muestra como botón.\n` +
            `3. Si querés, sugerí un slide específico para ajustar (por kind/idx).`,
        });
      } catch (err) {
        const message = (err as Error).message ?? 'unknown';
        const code = (err as Error & { code?: string }).code ?? 'asset_failed';
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ error: code, detail: message }),
        });
        args.onChunk({
          type: 'pptx_status',
          payload: { status: 'error', code, detail: message },
        });
      }
      continue;
    }

    if (tc.function.name === 'edit_asset_slide') {
      if (!args.scope_workspace_id || !args.user_id) {
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ error: 'no_workspace_scope' }),
        });
        continue;
      }
      let parsedArgs: { asset_node_id?: string; slide_index?: number; instruction?: string } = {};
      try { parsedArgs = JSON.parse(tc.function.arguments || '{}'); } catch {/* default */}
      const { asset_node_id, slide_index, instruction } = parsedArgs;
      if (!asset_node_id || typeof slide_index !== 'number' || !instruction) {
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ error: 'invalid_args', hint: 'need asset_node_id, slide_index, instruction' }),
        });
        continue;
      }

      try {
        const { editSingleSlide } = await import('./atlasContentGenerator.js');
        const { renderAssetToPdf } = await import('./htmlAssetRenderer.js');
        const { createClient } = await import('@supabase/supabase-js');
        const _supa = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
          { auth: { persistSession: false } },
        );

        const { data: nodeRow } = await _supa
          .from('workspace_nodes')
          .select('id, type, title, asset_metadata, asset_slides, asset_slide_history')
          .eq('id', asset_node_id)
          .eq('workspace_id', args.scope_workspace_id)
          .single();
        if (!nodeRow) throw new Error('asset_node_not_found');

        const slides = (nodeRow.asset_slides as Array<Record<string, unknown>>) ?? [];
        const idxInArray = slides.findIndex((s) => Number(s.idx) === slide_index);
        if (idxInArray < 0) throw new Error('slide_not_found');
        const before = slides[idxInArray];

        const assetKind: 'carousel' | 'pptx' | 'document' =
          nodeRow.type === 'carousel' ? 'carousel' :
          nodeRow.type === 'pptx_asset' ? 'pptx' : 'document';

        const edited = await editSingleSlide({
          slide: before as unknown as import('./atlasContentGenerator.js').AssetSlide,
          instruction,
          assetKind,
          workspaceTitle: String(nodeRow.title ?? 'Workspace'),
        });
        const updatedSlides = slides.map((s, i) => (i === idxInArray ? (edited as unknown as Record<string, unknown>) : s));
        const history = (nodeRow.asset_slide_history as Array<Record<string, unknown>>) ?? [];
        history.push({
          slide_idx: slide_index, before, after: edited, instruction,
          edited_at: new Date().toISOString(), edited_by_user_id: args.user_id,
        });

        const { data: ws } = await _supa
          .from('workspaces').select('title, description')
          .eq('id', args.scope_workspace_id).single();
        const render = await renderAssetToPdf({
          content: {
            title: String(ws?.title ?? 'Workspace'),
            subtitle: typeof ws?.description === 'string' ? ws.description : undefined,
            slides: updatedSlides as unknown as import('./atlasContentGenerator.js').AssetSlide[],
          },
          kind: assetKind,
          userId: args.user_id,
          workspaceId: args.scope_workspace_id,
          nodeId: asset_node_id,
          workspaceTitle: String(nodeRow.title ?? 'Workspace'),
        });

        const meta = (nodeRow.asset_metadata as Record<string, unknown>) ?? {};
        const newMeta = {
          ...meta,
          export_url: render.exportUrl,
          gcs_path: render.gcsPath,
          filename: render.filename,
          slides_count: render.slidesCount,
          generated_at: render.generatedAt,
        };
        await _supa
          .from('workspace_nodes')
          .update({ asset_metadata: newMeta, asset_slides: updatedSlides, asset_slide_history: history })
          .eq('id', asset_node_id);

        args.onChunk({
          type: 'pptx_ready',
          payload: {
            filename: render.filename,
            url: render.exportUrl,
            gammaUrl: render.exportUrl,
            generationId: asset_node_id,
            cached: false,
            generatedAt: render.generatedAt,
          },
        });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content:
            `Slide ${slide_index} editado y PDF re-renderizado.\n` +
            `INSTRUCCIONES: confirmale al usuario el cambio en 1 frase. NO pegues URL.`,
        });
      } catch (err) {
        const message = (err as Error).message ?? 'unknown';
        messages.push({
          role: 'tool', tool_call_id: tc.id,
          content: JSON.stringify({ error: 'edit_asset_slide_failed', detail: message }),
        });
      }
      continue;
    }

    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify({ error: `unknown tool: ${tc.function.name}` }),
    });
  }

  // Pass 2 (REFACTORIZADO 2026-05-12): non-streaming + tool_choice='none' +
  // fallback determinístico desde tool results.
  //
  // Historia del bug:
  //   v1: pass2 streaming default 'auto' → modelo a veces emitía tool_calls
  //       que streamCompletion ignoraba → assistantText vacío → fallback.
  //   v2: pass2 streaming + tool_choice='none' → mejoró pero todavía falla
  //       intermitente. Sospecha: streaming SSE de Cerebro no emite tokens
  //       cuando el modelo "piensa" en hacer otra tool antes de decidir
  //       responder. Las sesiones con resumen ejecutivo (pass1 → content
  //       directo, sin tool) funcionaban; las sin resumen (pass1 → tool →
  //       pass2) fallaban.
  //   v3 (actual): pass2 NON-STREAMING. Capturamos message.content COMPLETO
  //       igual que en pass1, lo emitimos como UN solo token chunk. No
  //       depende del SSE de Cerebro que parece tener issue con
  //       tool_choice='none'. Si el content sigue vacío, último recurso:
  //       sintetizar respuesta determinística desde los tool results que
  //       ya capturamos en `messages`.
  // Pass2 messages: añadimos un nudge user message al final para forzar
  // al modelo a responder. Sin esto, Anthropic a veces decide
  // finish_reason='stop' con content vacío después de procesar tool results
  // (especialmente con sonnet-4.6 + tool_choice='none' + tools array).
  // Diagnóstico 2026-05-12: pass2 devolvía exactamente "" con stop natural.
  const messagesForPass2 = [
    ...messages,
    {
      role: 'user' as const,
      content:
        'Ahora respondé al usuario usando los extractos que devolvió la tool. ' +
        'Citá [N] inline después de cada afirmación. Si los extractos no son suficientes, ' +
        'decilo explícitamente pero igual respondé con lo que tenés.',
    },
  ];

  let pass2Text = '';
  try {
    const pass2Res = await orFetch(
      {
        model,
        messages: messagesForPass2,
        // NO incluimos `tools` ni `tool_choice` — el modelo ya ejecutó la tool
        // en pass1. Tener tools registradas + tool_choice='none' confunde a
        // sonnet-4.6 (devuelve stop con content vacío).
        max_tokens: 2048,
        temperature: 0.2,
        ...cerebroExtras,
      },
      orKey,
      { timeoutMs: OR_PASS1_TIMEOUT_MS, label: 'openrouter pass2' },
    );
    if (pass2Res.ok) {
      const pass2Body = (await pass2Res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      };
      pass2Text = pass2Body.choices?.[0]?.message?.content ?? '';
      console.log('[chat] pass2 result:', {
        finish_reason: pass2Body.choices?.[0]?.finish_reason,
        content_length: pass2Text.length,
        content_preview: pass2Text.slice(0, 200),
      });
    } else {
      const errBody = await pass2Res.text();
      console.warn('[chat] pass2 non-ok:', pass2Res.status, errBody.slice(0, 300));
    }
  } catch (err) {
    console.warn('[chat] pass2 threw:', (err as Error).message);
  }

  if (pass2Text.length > 0) {
    args.onChunk({ type: 'token', payload: pass2Text });
    return;
  }

  // Fallback determinístico: sintetizar respuesta desde los tool results
  // que ya capturamos en messages. No es perfecto pero EVITA texto vacío.
  // Tomamos los últimos mensajes role='tool' y los formateamos como
  // resumen. Esto pasa si Cerebro/Anthropic tiene un issue de generación
  // en pass2 — es preferible mostrar la data cruda que un fallback genérico.
  const toolResults = messages
    .filter((m) => (m as { role?: string }).role === 'tool')
    .map((m) => (m as { content?: string }).content ?? '')
    .filter((c) => c.length > 0 && !c.startsWith('{"error"'));

  if (toolResults.length > 0) {
    // Solo el último tool result (el más reciente) — usualmente el de
    // search_session_transcript. Limpiamos el preámbulo de "INSTRUCCIONES"
    // que es para el LLM, no para el usuario.
    const lastResult = toolResults[toolResults.length - 1]!;
    const cleaned = lastResult
      .split(/---\s*\n\s*INSTRUCCIONES:/i)[0]
      ?.trim() ?? lastResult;
    const synthetic = `Encontré los siguientes extractos relevantes en la transcripción de esta sesión:\n\n${cleaned}`;
    args.onChunk({ type: 'token', payload: synthetic });
    console.warn('[chat] pass2 fallback determinístico aplicado', {
      tool_results_count: toolResults.length,
      synthetic_length: synthetic.length,
    });
    return;
  }
  // Si llegamos aquí, NO hay tool results tampoco — dejamos vacío y el
  // caller en chat.ts dispara su propio fallback genérico.
}
