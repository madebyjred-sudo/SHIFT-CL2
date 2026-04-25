import React, { createContext, useContext, useState, useEffect } from 'react';
import { Scale, FileText, Radar } from 'lucide-react';
import type { UploadedDoc } from '@/services/uploadPdf';

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
  fecha: string;
  comision: string;
  tipo: string;
  video_url: string | null;
  transcript_url: string | null;
};

export type Confidence = {
  score: number;
  level: 'high' | 'medium' | 'low';
  rationale: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  agent?: Agent;
  model?: Model;
  agentActive?: string;
  deepInsight?: boolean;
  citations?: ChunkCitation[];
  confidence?: Confidence;
};

/**
 * Optional binding from a chat session to a legacy plenaria.
 *
 * Set when the conversation was started from `/sesiones/:id`. The sidebar
 * uses this to group "scoped" chats above "general" chats. The label is
 * cached locally so the sidebar can render the group header without
 * re-fetching session metadata on every mount.
 *
 * Server is the source of truth (`conversations.scope_legacy_session_id`);
 * this local copy is for UX only — first message hydrates it from the
 * `conversation` SSE chunk, subsequent loads read it from localStorage.
 */
export type ChatScope = {
  legacy_session_id: number;
  /** Display label for the sidebar group header, e.g. "Sesión #71". */
  label: string;
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

  setCurrentSessionId: (id: string | null) => void;
  setSelectedModel: (model: Model) => void;
  setSelectedAgent: (agent: Agent) => void;
  setIsLoading: (loading: boolean) => void;
  setHasInteracted: (interacted: boolean) => void;
  setDeepInsight: (enabled: boolean) => void;
  setTenantId: (tenantId: string) => void;
  setAttachedDoc: (doc: UploadedDoc | null) => void;

  addMessage: (message: Message, explicitSessionId?: string) => void;
  updateMessage: (id: string, patch: Partial<Message>, explicitSessionId?: string) => void;
  createNewSession: () => void;
  deleteSession: (id: string) => void;
  /** Replace a local-timestamp session id with the canonical server UUID
   *  emitted by the API on first turn. Idempotent. */
  adoptServerSessionId: (localId: string, serverId: string) => void;
  /** Tag a session with a plenaria scope. Idempotent — overwrites if set. */
  setSessionScope: (sessionId: string, scope: ChatScope | null) => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

interface ChatProviderProps {
  children: React.ReactNode;
  defaultTenantId?: string;
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

  const handleSetSelectedAgent = (agent: Agent) => {
    setSelectedAgent(agent);
    setSelectedModel(AGENT_MODEL_MAP[agent]);
  };

  useEffect(() => {
    const saved = localStorage.getItem('cl2_sessions');
    if (saved) {
      try {
        setSessions(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to parse chat sessions', e);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('cl2_sessions', JSON.stringify(sessions));
  }, [sessions]);

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
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== targetSessionId) return s;
        return {
          ...s,
          messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
          updatedAt: Date.now(),
        };
      }),
    );
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
        setCurrentSessionId: handleSetCurrentSessionId,
        setSelectedModel,
        setSelectedAgent: handleSetSelectedAgent,
        setIsLoading,
        setHasInteracted,
        setDeepInsight,
        setTenantId,
        setAttachedDoc,
        addMessage,
        updateMessage,
        createNewSession,
        deleteSession,
        adoptServerSessionId,
        setSessionScope,
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
