import { Router } from 'express';
import type { CerebroRequest, CerebroStreamChunk } from '@shift-cl2/shared-types';
import { openRouterStream } from '../services/openRouterClient.js';
import { getAgent } from '../services/agentLoader.js';
import { getUserIdFromRequest } from '../services/auth.js';
import { requireQuota, logAiCall } from '../services/aiQuota.js';
import { ResilienceError } from '../services/resilience.js';
import { estimateConfidence } from '../services/confidence.js';
import {
  loadSessionContext,
  buildSessionSystemPrompt,
} from '../services/sessionContextLoader.js';
import {
  ensureConversation,
  insertUserMessage,
  insertAssistantMessage,
  type CitationRow,
} from '../services/conversationStore.js';
import { firePeajeIngest } from '../services/peajeClient.js';
import { getApprovedRag } from '../services/puntoMedioClient.js';
import { getOverride as getAgentOverride } from '../services/agentOverrides.js';
import { recordAgentCall } from '../services/agentStats.js';

/**
 * Convert an upstream/internal error into a user-friendly Spanish message
 * the frontend can show as-is. Detail goes to server logs only — never
 * leak provider keys, internal hostnames, or stack traces to the client.
 */
function userFacingError(err: unknown): { code: string; message: string } {
  if (err instanceof ResilienceError) {
    if (err.code === 'timeout') {
      return { code: 'timeout', message: 'La respuesta tardó demasiado. Intentá de nuevo en un momento.' };
    }
    if (err.code === 'aborted') {
      return { code: 'aborted', message: 'No se pudo completar la consulta. Probá reformulándola.' };
    }
  }
  const raw = (err as Error)?.message ?? '';
  if (/openrouter\s+5\d\d/i.test(raw)) {
    return { code: 'upstream', message: 'El proveedor del modelo está teniendo problemas. Reintentá en unos segundos.' };
  }
  if (/openrouter\s+429/i.test(raw)) {
    return { code: 'rate_limit', message: 'Estamos al límite de uso por el momento. Esperá un momento y volvé a intentar.' };
  }
  return { code: 'internal', message: 'Ocurrió un error procesando tu consulta. Intentá de nuevo.' };
}

export const chatRouter = Router();

chatRouter.post('/stream', async (req, res) => {
  const body = req.body as Partial<CerebroRequest>;

  if (!body.agent_id || !body.query) {
    res.status(400).json({ ok: false, error: 'agent_id and query required' });
    return;
  }

  // Agent enable gate — operator can flip an agent off from /admin/agentes
  // and that takes effect on the very next request. Soft 503 with a
  // typed reason so the UI can show "Atlas está pausado por el operador"
  // instead of a generic error.
  try {
    const override = await getAgentOverride(body.agent_id);
    if (override && override.enabled === false) {
      res.status(503).json({ ok: false, error: 'agent_disabled', agent_id: body.agent_id });
      return;
    }
  } catch {
    // override read failures are non-fatal — default to enabled.
  }

  // Auth + quota MUST happen before SSE headers flush — once we
  // commit Content-Type: text/event-stream the response is locked
  // into 200 and we can't return a real 401/429.
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required', message: 'Iniciá sesión para chatear con Lexa.' });
    return;
  }
  const quotaCheck = await requireQuota(userId, 'chat.stream', res);
  if (quotaCheck === 'denied') {
    // requireQuota already wrote the 429 JSON response.
    return;
  }
  // Log the call up-front so abuse via cancelled connections still
  // counts toward the daily cap.
  void logAiCall(userId, 'chat.stream', { agent: body.agent_id, deep_insight: body.deep_insight ?? false });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (chunk: CerebroStreamChunk | { type: string; payload?: unknown }) => {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };
  const agent = getAgent(body.agent_id);
  const deepInsight = body.deep_insight ?? false;
  const modelUsed =
    body.model_override ??
    (deepInsight ? agent?.deep_insight_model : agent?.default_model);

  // --- Scope resolution -------------------------------------------------
  // If the request carries a scope.legacy_session_id, load the session
  // metadata and build a system prompt from it. Failures are non-fatal —
  // the conversation falls back to "general" mode rather than 500ing the
  // user out. See docs/issues/001 for the design rationale.
  const scopeLegacySessionId =
    typeof body.scope?.legacy_session_id === 'number' && Number.isFinite(body.scope.legacy_session_id)
      ? body.scope.legacy_session_id
      : null;

  let scopeSystemPrompt: string | undefined;
  if (scopeLegacySessionId !== null) {
    try {
      const ctx = await loadSessionContext(scopeLegacySessionId);
      if (ctx) {
        scopeSystemPrompt = buildSessionSystemPrompt(ctx);
      } else {
        req.log.warn('scope_session_not_found', { id: scopeLegacySessionId });
      }
    } catch (err) {
      req.log.error('scope_load_failed', {
        error: (err as Error).message,
        id: scopeLegacySessionId,
      });
    }
  }

  let conversationId: string | null = null;
  if (userId) {
    try {
      const ensured = await ensureConversation({
        userId,
        conversationId: body.conversation_id ?? null,
        agentId: body.agent_id,
        firstUserMessage: body.query,
        scopeLegacySessionId,
      });
      conversationId = ensured.id;
      // Tell the client which conversation this is — important on first turn
      // so the frontend can pin it in the URL / sidebar before the stream ends.
      send({
        type: 'conversation',
        payload: {
          id: ensured.id,
          isNew: ensured.isNew,
          // Echo the *persisted* scope, not the request scope — they can differ
          // when the caller reuses an existing UUID with a stale or mismatched
          // scope (in which case ensureConversation spawned a fresh thread).
          scope_legacy_session_id: ensured.scopeLegacySessionId,
        },
      });
      await insertUserMessage(ensured.id, body.query);
    } catch (err) {
      req.log.error('persistence_pre_stream_failed', {
        error: (err as Error).message,
        agent: body.agent_id,
      });
      // Non-fatal: continue streaming even if persistence broke. Better demo
      // experience than aborting because the DB hiccupped.
      conversationId = null;
    }
  }

  // --- Pull approved-only Punto Medio RAG ------------------------------
  // Manual-gated flywheel enrichment: cerebro's get_dynamic_rag() filters
  // by approval_status='approved'. Until an operator OK's a consolidation
  // at /admin/punto-medio, this returns mostly the seed RAG (or empty).
  // Best-effort — if cerebro is down the LLM still answers, just without
  // institutional context.
  const tenant = process.env.CEREBRO_TENANT ?? 'cl2';
  const dynamicRag = await getApprovedRag(tenant);
  const dynamicRagPrompt =
    dynamicRag?.combined_rag && dynamicRag.combined_rag.trim().length > 50
      ? `[Inteligencia institucional Shift — patrones aprobados]:\n\n${dynamicRag.combined_rag.trim()}\n\n— Usá esto como contexto general; citá expedientes/transcripciones específicas con [N] cuando aplique.`
      : undefined;

  // --- Stream + accumulate ----------------------------------------------
  let assistantText = '';
  let citations: CitationRow[] = [];
  const streamStart = Date.now();
  let streamOk = true;

  try {
    await openRouterStream({
      agent_id: body.agent_id,
      query: body.query,
      conversation_id: body.conversation_id,
      deep_insight: deepInsight,
      model_override: body.model_override,
      dynamic_rag_prompt: dynamicRagPrompt,
      scope_system_prompt: scopeSystemPrompt,
      scope_legacy_session_id: scopeLegacySessionId,
      // Forward conversation history sent by the client (keeps the model
      // aware of prior turns). The frontend trims to its own window; the
      // server caps at MAX_HISTORY_MESSAGES as a safety net.
      history: Array.isArray((body as { history?: unknown }).history)
        ? ((body as { history?: Array<{ role: 'user' | 'assistant'; content: string }> }).history ?? [])
        : [],
      onChunk: (chunk) => {
        if (chunk.type === 'token' && typeof chunk.payload === 'string') {
          assistantText += chunk.payload;
        } else if (chunk.type === 'citation' && Array.isArray(chunk.payload)) {
          citations = chunk.payload as CitationRow[];
        }
        send(chunk);
      },
    });

    // --- Empty-completion guardrail ------------------------------------
    // The upstream pipeline can produce zero token events (Pass 1
    // returning no tool_call AND no content; Pass 2 streaming nothing
    // because a tool returned no usable result and the model gave up).
    // Without this guard the user sees an assistant card with the agent
    // header but no body — silent failure with no log. Synthesize a
    // graceful fallback and emit a structured warning so ops can trace
    // WHY (LightRAG unreachable, tool empty hits, model refused, etc.).
    if (assistantText.length === 0) {
      const fallback =
        'No encontré una respuesta concreta para esta consulta en el corpus disponible. ' +
        'Probá reformularla con detalles específicos — por ejemplo, una fecha (DD/MM/AAAA), ' +
        'un número de expediente o el nombre exacto de una comisión.';
      send({ type: 'token', payload: fallback });
      assistantText = fallback;
      req.log.warn('empty_completion_fallback', {
        agent: body.agent_id,
        query: body.query.slice(0, 200),
        deep_insight: deepInsight,
        scope_legacy_session_id: scopeLegacySessionId,
        ms: Date.now() - streamStart,
      });
    }

    // --- Confidence post-process (per agent contract) ------------------
    // Emit only when the agent's response_contract opts in (e.g. Centinela).
    // Lexa/Atlas don't surface this to the user — fewer chrome elements,
    // less cognitive load. We still persist it for any agent that emitted.
    let confidenceScore: number | null = null;
    if (assistantText.length > 0 && agent?.response_contract?.must_show_confidence) {
      const conf = estimateConfidence(assistantText, citations);
      confidenceScore = conf.score;
      send({ type: 'confidence', payload: conf });
    }

    send({ type: 'done' });

    // Persist post-stream so the row has the final text + confidence in one shot.
    if (conversationId && assistantText.length > 0) {
      try {
        await insertAssistantMessage({
          conversationId,
          content: assistantText,
          agentId: body.agent_id,
          model: modelUsed,
          deepInsight,
          citations,
          confidence: confidenceScore,
        });
      } catch (err) {
        req.log.error('assistant_persistence_failed', { error: (err as Error).message });
      }

      // Fire-and-forget hand-off to the Cerebro Peaje (institutional
      // flywheel). Voided intentionally — must not block the response or
      // surface failures to the user. The client logs its own outcome.
      void firePeajeIngest({
        sessionId: conversationId,
        agentId: body.agent_id,
        messages: [{ role: 'user', content: body.query }],
        response: assistantText,
      });
    }
  } catch (err) {
    streamOk = false;
    req.log.error('stream_failed', {
      error: (err as Error)?.message,
      stack: (err as Error)?.stack,
      agent: body.agent_id,
    });
    send({ type: 'error', payload: { ...userFacingError(err), request_id: req.requestId } });

    // Best-effort persist of partial response so the user can retry without
    // losing what came through.
    if (conversationId && assistantText.length > 0) {
      try {
        await insertAssistantMessage({
          conversationId,
          content: assistantText,
          agentId: body.agent_id,
          model: modelUsed,
          deepInsight,
          citations,
          confidence: null,
        });
      } catch (persistErr) {
        req.log.error('partial_persistence_failed', { error: (persistErr as Error).message });
      }
    }
  } finally {
    // Record the call for the live agent stats card. Always runs,
    // including the error path, so latency tail / error rate stay
    // honest. Tagged via the agent id from the request — the override
    // gate above already vetoed disabled agents, so anything that
    // reaches here is a real attempt.
    recordAgentCall(body.agent_id ?? 'unknown', Date.now() - streamStart, streamOk);
    res.end();
  }
});
