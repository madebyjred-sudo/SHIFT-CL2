import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { Scale, FileText, Radar } from 'lucide-react';
import type { UploadedDoc } from '@/services/uploadPdf';

// ═══════════════════════════════════════════════════════════════
// AttachedWorkspace — workspace context attached to a chat turn.
// Mirrors AttachedDoc but carries the markdown export from
// /api/workspace/:id/attach-context, prepended to the query.
// ═══════════════════════════════════════════════════════════════
export interface AttachedWorkspace {
  id: string;
  title: string;
  hoja_count: number;
  total_chars: number;
  truncated: boolean;
  /** Full markdown export returned by attach-context. Prepended to query. */
  full_md: string;
}

// ═══════════════════════════════════════════════════════════════
// CL2 AGENT ROSTER — 3 Legislative Agents
// ═══════════════════════════════════════════════════════════════

export type Model =
  | 'claude-sonnet-4.6'
  | 'claude-opus-4.7'
  | 'auto';

export type Agent = 'lexa' | 'atlas' | 'centinela';

export const AGENT_CATEGORIES = {
  legislativo: ['lexa', 'atlas', 'centinela'] as Agent[],
};

export const AGENT_INFO: Record<
  Agent,
  { id: string; name: string; role: string; skills: string; color: string; icon: string }
> = {
  lexa: {
    id: 'lexa',
    name: 'Lexa',
    role: 'Análisis Plenario',
    skills: 'Actas del Plenario, transcripciones, votaciones, mociones, discusiones',
    // Hex literal (NOT var(--color-cl2-burgundy)) because consumers like
    // ThinkingIndicator and AgentBadge concat alpha suffixes at runtime
    // (`${color}20`). CSS vars don't survive that concatenation.
    color: '#7A3B47',
    icon: 'Scale',
  },
  atlas: {
    id: 'atlas',
    name: 'Atlas',
    role: 'Comisiones & Datos',
    skills: 'Comisiones legislativas, expedientes, datos estructurados, análisis de documentos',
    color: '#8B6E54',
    icon: 'FileText',
  },
  centinela: {
    id: 'centinela',
    name: 'Centinela',
    role: 'Alertas & Seguimiento',
    skills: 'Alertas de sesiones, seguimiento de proyectos de ley, monitoreo, eventos clave',
    color: '#F43F5E',
    icon: 'Radar',
  },
};

export const AGENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Scale,
  FileText,
  Radar,
};

export const AGENT_MODEL_MAP: Record<Agent, Model> = {
  lexa: 'claude-sonnet-4.6',
  atlas: 'claude-sonnet-4.6',
  centinela: 'claude-sonnet-4.6',
};

export type ChunkCitation = {
  id: string;
  session_id: string;
  source_ref: string;
  content: string;
  similarity: number;
  fecha: string | null;
  comision: string | null;
  tipo: string | null;
  video_url: string | null;
  transcript_url: string | null;
  // SIL extension — populated when the citation came from a SIL tool
  // (search_sil_expedientes / get_sil_expediente / search_sil_corpus).
  // The renderer picks a different icon + link target when these are set.
  source_type?:
    | 'transcript'
    | 'transcript_segment'
    | 'pdf'
    | 'web'
    | 'metadata'
    | 'sil_expediente'
    | 'sil_dictamen'
    | 'sil_mocion'
    | 'sil_votacion'
    | 'sil_acta'
    | 'sil_ley';
  expediente_numero?: string;
  estado?: string | null;
  proponente?: string | null;
  url_detalle?: string | null;
  timecode_s?: number;
  rank?: number;
};

export type Confidence = {
  score: number;
  level: 'high' | 'medium' | 'low';
  rationale: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  /** What the chat bubble shows. May be a friendly summary
   *  (e.g. "📎 file.pdf\n\nWhat does this say?") that hides
   *  attached document text from the rendered transcript. */
  content: string;
  /** What the LLM should see for THIS message in subsequent turns'
   *  history. When present, overrides `content` in the forwarded
   *  history payload — used to keep attached document text in the
   *  model's context across turns without polluting the visible
   *  bubble. Optional; falls back to `content` when not set. */
  llmContent?: string;
  agent?: Agent;
  model?: Model;
  agentActive?: string;
  deepInsight?: boolean;
  citations?: ChunkCitation[];
  confidence?: Confidence;
  /** Inline card payload — set when Atlas's generate_presentation tool
   *  finishes. Renders an "Abrir en Gamma + Descargar .pptx" card below
   *  the message body. */
  pptxResult?: {
    filename: string;
    url: string;
    gammaUrl: string;
    generationId: string;
    cached: boolean;
    generatedAt?: string;
  };
  /** True while a pptx tool call is in flight. UI shows an inline progress
   *  pill ("Generando con Gamma…"); replaced by pptxResult when done. */
  pptxLoading?: boolean;
  /** Atlas's create_workspace tool result. When set, renders a card
   *  "Abrir hoja de trabajo" + count de sources importados/fallidos. */
  workspaceCreated?: {
    id: string;
    title: string;
    url: string;
    seeds_imported: number;
    seeds_failed: number;
  };
  /** Atlas-side share suggestions — optional buttons rendered below the
   *  message body (Lovable-style). The chat stream surfaces these via a
   *  `suggestion` chunk; if the backend doesn't emit them the field stays
   *  undefined and nothing renders. Click → opens the ShareAs flow with
   *  the matching kind pre-selected. */
  suggestions?: Array<{
    /** ShareAs kind to trigger when the user clicks. */
    kind: 'carousel' | 'pptx_asset' | 'docx_asset' | 'podcast_asset';
    /** Visible button label, e.g. "Generar carrusel". */
    label: string;
    /** Optional reason — surfaces below the label as a 1-line subtitle. */
    reason?: string;
  }>;
};

/**
 * Discriminated union for chat scope. Two variants:
 *
 * • session   — scoped to a legacy plenaria (SesionViewPage). Sends
 *               `legacy_session_id` to the BFF so it injects session
 *               metadata as a system message and groups the chat in the
 *               sidebar under "Sesión #N".
 *
 * • workspace — scoped to a Hojas workspace (WorkspaceCanvasPage). Sends
 *               `workspace_id` (+ optional `selected_node_id`) to the
 *               /api/workspace/:id/turn endpoint for intent-routed turns.
 */
export type ChatScope =
  // Sesión legacy MariaDB (int id) — sigue funcionando para las sesiones de
  // pre-mayo 2026. El backend usa sessionContextLoader contra el sistema viejo.
  | { kind: 'session'; legacy_session_id: number; label: string }
  // Sesión nueva en Supabase (UUID). El backend (chat.ts) detecta el campo
  // session_uuid y carga el contexto desde la tabla `sessions` + transcript_segments
  // + metadata.resumen. SesionViewPage envía esto cuando el id detectado es UUID.
  | { kind: 'session_uuid'; session_uuid: string; label: string }
  // Expediente SIL (número con punto, ej. "23.511"). El backend carga el
  // contexto de enriquecimiento (trámite, proponentes, documentos, fechas)
  // e inyecta un system prompt scoped. El modelo usa search_sil_corpus
  // filtrado por este expediente para responder sobre contenido de documentos.
  | { kind: 'expediente'; expediente_numero: string; label: string }
  | {
      kind: 'workspace';
      workspace_id: string;
      workspace_title: string;
      selected_node_id: string | null;
      /**
       * Slide-scoped context surfaced when the user has the
       * AssetDetailPanel open with a slide selected. The backend
       * splices `system_prompt_fragment` into scope_system_prompt
       * (between the existing hoja context and the persona) so the
       * model treats the active slide as the focal subject of the
       * turn. `slide_idx` lets the server route slide-edit intents
       * to the slide endpoint without re-parsing the prompt.
       *
       * Optional. When absent, the chat behaves exactly like before.
       */
      selected_slide?: {
        node_id: string;
        slide_idx: number;
        kind: 'carousel' | 'pptx_asset' | 'docx_asset' | 'podcast_asset';
        system_prompt_fragment: string;
      };
    };

export type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
  model: Model;
  agent: Agent;
  scope?: ChatScope;
};

interface ChatContextType {
  sessions: ChatSession[];
  currentSessionId: string | null;
  currentMessages: Message[];
  selectedModel: Model;
  selectedAgent: Agent;
  isLoading: boolean;
  hasInteracted: boolean;
  deepInsight: boolean;
  tenantId: string;
  attachedDoc: UploadedDoc | null;
  attachedWorkspace: AttachedWorkspace | null;

  setCurrentSessionId: (id: string | null) => void;
  setSelectedModel: (model: Model) => void;
  setSelectedAgent: (agent: Agent) => void;
  setIsLoading: (loading: boolean) => void;
  setHasInteracted: (interacted: boolean) => void;
  setDeepInsight: (enabled: boolean) => void;
  setTenantId: (tenantId: string) => void;
  setAttachedDoc: (doc: UploadedDoc | null) => void;
  setAttachedWorkspace: (ws: AttachedWorkspace | null) => void;

  addMessage: (message: Message, explicitSessionId?: string) => void;
  updateMessage: (id: string, patch: Partial<Message>, explicitSessionId?: string) => void;
  createNewSession: () => void;
  deleteSession: (id: string) => void;
  /** Replace a local-timestamp session id with the canonical server UUID
   *  emitted by the API on first turn. Idempotent. */
  adoptServerSessionId: (localId: string, serverId: string) => void;
  /** Tag a session with a scope. Idempotent — overwrites if set. */
  setSessionScope: (sessionId: string, scope: ChatScope | null) => void;
  /** Find the MOST RECENT session scoped to this workspace, or create
   *  a new one and select it. Used on workspace mount to restore the
   *  user's last conversation. */
  selectOrCreateWorkspaceSession: (workspaceId: string, title?: string) => void;
  /** Always create a NEW chat in this workspace. The user gets a fresh
   *  conversation while their prior chats remain accessible from the
   *  sidebar (filtered to this workspace). */
  startNewWorkspaceSession: (workspaceId: string, title?: string) => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

interface ChatProviderProps {
  children: React.ReactNode;
  defaultTenantId?: string;
}

/**
 * Merge a fresh list of conversations from the server into the local
 * sidebar state. Rules:
 *   - Server is source of truth for: title, updatedAt, scope (legacy
 *     plenaria id), agent_id.
 *   - Local is source of truth for: messages[] (already-loaded threads
 *     keep their body so the user doesn't lose their place mid-scroll).
 *   - Sessions in local but NOT in server: kept (probably never sent —
 *     temp Date.now() id, or BFF was down when the user chatted).
 *   - Sessions in server but NOT in local: added as stubs with empty
 *     `messages[]`; lazy-loaded when the user clicks them.
 * The result is sorted by updatedAt desc so the sidebar order is stable.
 */
function mergeServerIntoLocal(
  local: ChatSession[],
  server: Array<{
    id: string;
    agent_id: string;
    title: string;
    scope_legacy_session_id: number | null;
    updated_at: string;
  }>,
  defaultModel: Model,
): ChatSession[] {
  const localById = new Map(local.map((s) => [s.id, s]));
  const merged: ChatSession[] = [];
  const seen = new Set<string>();

  for (const s of server) {
    seen.add(s.id);
    const existing = localById.get(s.id);
    const updatedAt = Date.parse(s.updated_at);
    const scope: ChatScope | undefined = s.scope_legacy_session_id != null
      ? { kind: 'session', legacy_session_id: s.scope_legacy_session_id, label: `Sesión #${s.scope_legacy_session_id}` }
      : existing?.scope;
    if (existing) {
      merged.push({
        ...existing,
        title: s.title || existing.title,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : existing.updatedAt,
        agent: (s.agent_id as Agent) || existing.agent,
        scope,
      });
    } else {
      // New stub — messages will lazy-load when user clicks
      merged.push({
        id: s.id,
        title: s.title || 'Nueva conversación',
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
        messages: [],
        model: defaultModel,
        agent: (s.agent_id as Agent) || 'lexa',
        scope,
      });
    }
  }
  // Local-only sessions (probably temp ids never persisted, or BFF was
  // down when the user chatted) — keep them so we don't lose work.
  for (const s of local) {
    if (!seen.has(s.id)) merged.push(s);
  }
  merged.sort((a, b) => b.updatedAt - a.updatedAt);
  return merged;
}

export function ChatProvider({ children, defaultTenantId = 'cl2' }: ChatProviderProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  const [selectedModel, setSelectedModel] = useState<Model>('claude-sonnet-4.6');
  const [selectedAgent, setSelectedAgent] = useState<Agent>('lexa');
  const [isLoading, setIsLoading] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [deepInsight, setDeepInsight] = useState(false);
  const [tenantId, setTenantId] = useState<string>(defaultTenantId);
  const [attachedDoc, setAttachedDoc] = useState<UploadedDoc | null>(null);
  const [attachedWorkspace, setAttachedWorkspace] = useState<AttachedWorkspace | null>(null);

  const handleSetSelectedAgent = (agent: Agent) => {
    setSelectedAgent(agent);
    setSelectedModel(AGENT_MODEL_MAP[agent]);
  };

  // ── Hydrate sessions: localStorage cache → then refresh from server ──
  //
  // Two-pass strategy so the sidebar paints instantly without a network
  // round-trip on every page load, while still being correct across
  // devices / cleared caches:
  //
  //   Pass 1: read `cl2_sessions` from localStorage (offline-first feel)
  //   Pass 2: GET /api/conversations and merge with what we already had
  //
  // The merge keeps any locally-loaded `messages[]` (so a thread the
  // user already opened doesn't lose its body), but refreshes title /
  // updatedAt / scope from server-of-truth. New sessions from server
  // come in as stubs (empty messages); they're lazy-loaded the first
  // time the user clicks them via the effect below.
  useEffect(() => {
    // Pass 1: localStorage cache
    const saved = localStorage.getItem('cl2_sessions');
    if (saved) {
      try {
        setSessions(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse chat sessions', e);
      }
    }

    // Pass 2: refresh from server. Lazy-imported so SSR / no-auth paths
    // (the public landing demo) don't pull this code.
    let cancelled = false;
    (async () => {
      try {
        const { listConversations } = await import('@/services/conversationsApi');
        const serverItems = await listConversations({ limit: 100 });
        if (cancelled) return;
        setSessions((local) => mergeServerIntoLocal(local, serverItems, selectedModel));
      } catch {
        // No auth, no network, or BFF down — silently keep localStorage
        // as the source. The sidebar still works for the user's existing
        // session; the multi-device merge happens on the next reload.
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('cl2_sessions', JSON.stringify(sessions));
  }, [sessions]);

  // ── Lazy-load messages when a server-side stub is opened ────────────
  //
  // When the user clicks a thread that came from the server-list pass,
  // its `messages[]` is empty. Fetch them on demand. We mark `_loaded`
  // on the session so we don't re-fetch on every re-render.
  useEffect(() => {
    if (!currentSessionId) return;
    const sess = sessions.find((s) => s.id === currentSessionId);
    if (!sess) return;
    // Skip if already loaded (has messages, or marked loaded)
    if (sess.messages.length > 0 || (sess as ChatSession & { _loaded?: boolean })._loaded) return;
    // Skip non-server ids (Date.now() strings — those are pure client
    // sessions never persisted yet)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(currentSessionId)) return;

    let cancelled = false;
    (async () => {
      try {
        const { getConversationMessages, serverMessageToClient } = await import(
          '@/services/conversationsApi'
        );
        const rows = await getConversationMessages(currentSessionId);
        if (cancelled) return;
        const mapped = rows.map(serverMessageToClient);
        setSessions((prev) =>
          prev.map((s) =>
            s.id === currentSessionId
              ? ({ ...s, messages: mapped, _loaded: true } as ChatSession & { _loaded: boolean })
              : s,
          ),
        );
      } catch {
        // Mark as loaded anyway so we don't loop on a 404'd thread
        setSessions((prev) =>
          prev.map((s) =>
            s.id === currentSessionId
              ? ({ ...s, _loaded: true } as ChatSession & { _loaded: boolean })
              : s,
          ),
        );
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionId]);

  const currentSession = sessions.find((s) => s.id === currentSessionId);
  const currentMessages = currentSession?.messages || [];

  useEffect(() => {
    if (currentSessionId && currentMessages.length > 0) setHasInteracted(true);
    else if (currentSessionId === null) setHasInteracted(false);
  }, [currentSessionId, currentMessages.length]);

  const createNewSession = () => {
    setCurrentSessionId(null);
    setHasInteracted(false);
    setSelectedModel('claude-sonnet-4.6');
    setSelectedAgent('lexa');
  };

  const addMessage = (message: Message, explicitSessionId?: string) => {
    const targetSessionId = explicitSessionId || currentSessionId;

    setSessions((prev) => {
      const updated = [...prev];
      const idx = updated.findIndex((s) => s.id === targetSessionId);

      if (idx === -1) {
        const newId = targetSessionId || Date.now().toString();
        const session: ChatSession = {
          id: newId,
          title:
            message.role === 'user'
              ? message.content.slice(0, 40) + (message.content.length > 40 ? '…' : '')
              : 'Nueva consulta',
          updatedAt: Date.now(),
          messages: [message],
          model: selectedModel,
          agent: selectedAgent,
        };
        updated.unshift(session);
        setTimeout(() => setCurrentSessionId(newId), 0);
      } else {
        const s = { ...updated[idx] };
        s.messages = [...s.messages, message];
        s.updatedAt = Date.now();
        s.model = selectedModel;
        s.agent = selectedAgent;
        if (s.messages.length === 1 && message.role === 'user') {
          s.title = message.content.slice(0, 40) + (message.content.length > 40 ? '…' : '');
        }
        updated[idx] = s;
        updated.sort((a, b) => b.updatedAt - a.updatedAt);
      }
      return updated;
    });
  };

  const updateMessage = (id: string, patch: Partial<Message>, explicitSessionId?: string) => {
    const targetSessionId = explicitSessionId || currentSessionId;
    setSessions((prev) => {
      // Fast path: targeted session exists and contains the message.
      const targetIdx = prev.findIndex((s) => s.id === targetSessionId);
      if (targetIdx >= 0 && prev[targetIdx].messages.some((m) => m.id === id)) {
        const next = prev.slice();
        next[targetIdx] = {
          ...prev[targetIdx],
          messages: prev[targetIdx].messages.map((m) =>
            m.id === id ? { ...m, ...patch } : m,
          ),
          updatedAt: Date.now(),
        };
        return next;
      }
      // Fallback: caller's sessionId is stale (typical after the BFF
      // sends a `conversation` chunk that triggered adoptServerSessionId,
      // which renamed the session in-place). Locate the message by id
      // across all sessions and patch wherever it lives.
      return prev.map((s) =>
        s.messages.some((m) => m.id === id)
          ? {
              ...s,
              messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
              updatedAt: Date.now(),
            }
          : s,
      );
    });
  };

  const adoptServerSessionId = (localId: string, serverId: string) => {
    if (localId === serverId) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === localId ? { ...s, id: serverId } : s)),
    );
    setCurrentSessionId((curr) => (curr === localId ? serverId : curr));
  };

  const setSessionScope = (sessionId: string, scope: ChatScope | null) => {
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s;
        if (scope === null) {
          const { scope: _drop, ...rest } = s;
          return rest;
        }
        return { ...s, scope };
      }),
    );
  };

  const deleteSession = (id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (currentSessionId === id) createNewSession();
  };

  const handleSetCurrentSessionId = (id: string | null) => {
    setCurrentSessionId(id);
    if (id) {
      const s = sessions.find((x) => x.id === id);
      if (s) {
        setSelectedModel(s.model);
        setSelectedAgent(s.agent);
      }
    }
  };

  /**
   * Select-or-create the workspace's MOST RECENT chat session. A workspace
   * can have many threads — this picks the latest by updatedAt or creates
   * the first one. Hidden from the main sidebar; visible only when the
   * user is inside that workspace's surface.
   */
  const selectOrCreateWorkspaceSession = useCallback(
    (workspaceId: string, title?: string) => {
      const matching = sessions
        .filter(
          (s) => s.scope?.kind === 'workspace' && s.scope.workspace_id === workspaceId,
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      if (matching.length > 0) {
        const latest = matching[0];
        setCurrentSessionId(latest.id);
        setSelectedModel(latest.model);
        setSelectedAgent(latest.agent);
        return;
      }
      // First chat in this workspace — use a deterministic id so the
      // very first session has a stable, recognizable label.
      const newId = `workspace:${workspaceId}`;
      const newSession: ChatSession = {
        id: newId,
        title: title ? `Hojas — ${title}` : 'Nuevo chat',
        updatedAt: Date.now(),
        messages: [],
        model: selectedModel,
        agent: 'lexa',
        scope: {
          kind: 'workspace',
          workspace_id: workspaceId,
          workspace_title: title ?? '',
          selected_node_id: null,
        },
      };
      setSessions((prev) => [newSession, ...prev]);
      setCurrentSessionId(newId);
      setSelectedAgent('lexa');
    },
    [sessions, selectedModel],
  );

  /**
   * Spawn a brand-new conversation for this workspace, leaving any prior
   * threads in place (visible in the workspace sidebar). Bound to the
   * "Nuevo chat" button inside Hojas.
   */
  const startNewWorkspaceSession = useCallback(
    (workspaceId: string, title?: string) => {
      const newId = `workspace:${workspaceId}:${Date.now()}`;
      const newSession: ChatSession = {
        id: newId,
        title: 'Nuevo chat',
        updatedAt: Date.now(),
        messages: [],
        model: selectedModel,
        agent: 'lexa',
        scope: {
          kind: 'workspace',
          workspace_id: workspaceId,
          workspace_title: title ?? '',
          selected_node_id: null,
        },
      };
      setSessions((prev) => [newSession, ...prev]);
      setCurrentSessionId(newId);
      setSelectedAgent('lexa');
    },
    [selectedModel],
  );

  return (
    <ChatContext.Provider
      value={{
        sessions,
        currentSessionId,
        currentMessages,
        selectedModel,
        selectedAgent,
        isLoading,
        hasInteracted,
        deepInsight,
        tenantId,
        attachedDoc,
        attachedWorkspace,
        setCurrentSessionId: handleSetCurrentSessionId,
        setSelectedModel,
        setSelectedAgent: handleSetSelectedAgent,
        setIsLoading,
        setHasInteracted,
        setDeepInsight,
        setTenantId,
        setAttachedDoc,
        setAttachedWorkspace,
        addMessage,
        updateMessage,
        createNewSession,
        deleteSession,
        adoptServerSessionId,
        setSessionScope,
        selectOrCreateWorkspaceSession,
        startNewWorkspaceSession,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (context === undefined) throw new Error('useChat must be used within a ChatProvider');
  return context;
}
