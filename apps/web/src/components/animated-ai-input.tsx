import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Info,
  Square,
  ArrowUp,
  Sparkles,
  ChevronDown,
  Users,
  Paperclip,
  X,
  FileText,
  Headphones,
  Loader2,
  Layers,
  BookOpen,
  Bot,
  MessageSquare,
  Hammer,
  Pencil,
  Copy as CopyIcon,
  CheckCircle2,
} from 'lucide-react';
import { PodcastModal } from '@/components/podcasts/PodcastModal';
import { SendToWorkspaceModal } from '@/components/SendToWorkspaceModal';
import { CentinelaHeroStrip } from '@/components/centinela/CentinelaHeroStrip';
import type { ImportSource } from '@/services/workspaceApi';

import { cn } from '@/lib/utils';
import { TextLoop } from '@/components/ui/text-loop';
import { VoiceInput } from '@/components/ui/voice-input';
import { ShinyButton } from '@/components/ui/shiny-button';
import {
  useChat,
  Agent,
  AGENT_INFO,
  AGENT_CATEGORIES,
  AGENT_ICONS,
  Message,
  ChunkCitation,
  type ChatScope,
} from '@/lib/chat-context';
import { MessageRenderer } from './message-renderer';
import { AgentBadge } from './AgentBadge';
import { ThinkingIndicator } from './ThinkingIndicator';
import { SuggestChips } from './SuggestChips';
import { CitationCards } from './CitationCards';
import { ConfidenceBadge } from './ConfidenceBadge';
import { streamChat, streamWorkspaceTurn, type WorkspaceActionPayload } from '@/services/chatStream';
import { uploadPdf } from '@/services/uploadPdf';
import type { WorkspaceNode } from '@/services/workspaceApi';
import { WorkspacePickerModal } from '@/components/WorkspacePickerModal';
import { supabase } from '@/lib/supabase';

function useAutoResizeTextarea(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [value, ref]);
}

const ALL_AGENTS: Agent[] = AGENT_CATEGORIES.legislativo;

const getAgentBestUses = (agent: Agent) => {
  switch (agent) {
    case 'lexa':
      return [
        'una consulta de actas',
        'un análisis de votación',
        'una revisión de transcripción',
        'un resumen de debate',
      ];
    case 'atlas':
      return [
        'un expediente de comisión',
        'un cruce de datos legislativos',
        'una revisión de documentos',
        'un análisis estructurado',
      ];
    case 'centinela':
      return [
        'una alerta de sesión',
        'un seguimiento de moción',
        'un monitoreo de proyecto',
        'un reporte de eventos',
      ];
    default:
      return [
        'una consulta legislativa',
        'un análisis institucional',
        'una revisión de fuentes',
      ];
  }
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnimatedAiInputProps {
  onOpenHistory?: () => void;
  /**
   * Optional binding to a plenaria (kind='session') or workspace
   * (kind='workspace'). When workspace scope is set, turns are sent to
   * /api/workspace/:id/turn instead of /api/chat/stream.
   */
  scope?: ChatScope;
  /** Optional placeholder override. */
  placeholder?: string;
  /**
   * Optional seek handler — timecodes in assistant messages become clickable
   * and call this with parsed seconds. Used in SesionViewPage.
   */
  onSeek?: (seconds: number) => void;
  /**
   * Optional prefill — parent can push a draft into the composer. The `nonce`
   * lets the parent re-fire even when text is identical.
   */
  prefill?: { text: string; nonce: number } | null;

  // ── Workspace-scope props (all optional; main chat doesn't pass them) ──

  /** Hoja titles for the workspace — used to help the server route intent. */
  hojaTitles?: Array<{ id: string; title: string; subtitle?: string | null }>;
  /**
   * Called when the user clicks the X on the selected-node chip, so the
   * parent (WorkspaceCanvasPage) can deselect the node.
   */
  onClearSelection?: () => void;
  /**
   * Called when the server resolves the intent to 'build' or 'edit_*'.
   * The parent materializes new nodes on the canvas or patches existing ones.
   */
  onWorkspaceAction?: (action: {
    intent: 'build' | 'edit_selected' | 'edit_by_match';
    nodes?: WorkspaceNode[];
    node_id?: string;
    new_content?: string;
    target_match_confidence?: number;
  }) => void;
  /**
   * Called when the user clicks a share-as suggestion button rendered
   * below an assistant message. Parent should open ShareAsOptionsModal
   * with the chosen kind pre-selected (defaults are fine).
   * Optional — when undefined, suggestion buttons still render but are
   * inert (visual hint without action). Workspace scope only.
   */
  onShareSuggestionPick?: (kind: 'carousel' | 'pptx_asset' | 'docx_asset' | 'podcast_asset') => void;
}

// ─── Manual intent options ───────────────────────────────────────────────────
// Labels live in MODE_INTENT_OPTIONS (bottom of file) for the
// segmented toolbar. The radio-group + Auto/Manual pill that used to
// reference MANUAL_INTENT_LABELS were consolidated into one control.

type ManualIntent = 'chat' | 'build' | 'edit_selected';

// ─── Component ────────────────────────────────────────────────────────────────

export function AnimatedAiInput({
  onOpenHistory,
  scope,
  placeholder,
  onSeek,
  prefill,
  hojaTitles,
  onClearSelection,
  onWorkspaceAction,
  onShareSuggestionPick,
}: AnimatedAiInputProps) {
  const {
    currentMessages: messages,
    currentSessionId,
    selectedAgent,
    setSelectedAgent,
    isLoading,
    setIsLoading,
    hasInteracted,
    setHasInteracted,
    deepInsight,
    setDeepInsight,
    tenantId,
    addMessage,
    updateMessage,
    attachedDoc,
    setAttachedDoc,
    attachedWorkspace,
    setAttachedWorkspace,
    adoptServerSessionId,
    setSessionScope,
  } = useChat();

  const [value, setValue] = useState('');
  const [podcastOpen, setPodcastOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoResizeTextarea(textareaRef, value);

  const hasAssistantContent = messages.some(
    (m) => m.role === 'assistant' && m.content.trim().length > 0,
  );

  // ── Prefill plumbing ───────────────────────────────────────────────────────
  const lastPrefillNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill) return;
    if (lastPrefillNonceRef.current === prefill.nonce) return;
    lastPrefillNonceRef.current = prefill.nonce;
    setValue(prefill.text);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      el.scrollTop = el.scrollHeight;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce]);

  const [isAgentSelectorOpen, setIsAgentSelectorOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Adjuntar dropdown ──────────────────────────────────────────────────────
  const [isAttachOpen, setIsAttachOpen] = useState(false);
  const [isWorkspacePickerOpen, setIsWorkspacePickerOpen] = useState(false);
  // "Send AI response to workspace" flow. The button under each
  // assistant bubble sets `sendToWsSource` (the message + its prompt
  // + agent context), which mounts the modal. Modal handles the
  // workspace pick / create + import. After close we clear the source
  // so the next save starts fresh.
  const [sendToWsSource, setSendToWsSource] = useState<ImportSource | null>(null);
  const [isAttachingWorkspace, setIsAttachingWorkspace] = useState(false);

  // ── Workspace mode state ───────────────────────────────────────────────────
  const isWorkspaceScope = scope?.kind === 'workspace';
  const workspaceId = isWorkspaceScope ? scope.workspace_id : undefined;

  const [workspaceMode, setWorkspaceMode] = useState<'auto' | 'manual'>(() => {
    if (!isWorkspaceScope) return 'auto';
    try {
      const stored = localStorage.getItem(`hoja-mode-${scope.workspace_id}`);
      return stored === 'manual' ? 'manual' : 'auto';
    } catch {
      return 'auto';
    }
  });

  const [manualIntent, setManualIntent] = useState<ManualIntent>('chat');

  // Persist mode choice
  useEffect(() => {
    if (!isWorkspaceScope) return;
    try {
      localStorage.setItem(`hoja-mode-${scope.workspace_id}`, workspaceMode);
    } catch { /* ignore */ }
  }, [workspaceMode, isWorkspaceScope, scope]);

  const handlePickFile = () => {
    setUploadError(null);
    setIsAttachOpen(false);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setIsUploading(true);
    setUploadError(null);
    try {
      const doc = await uploadPdf(file);
      setAttachedDoc(doc);
    } catch (err: any) {
      setUploadError(err?.message ?? 'No se pudo subir el archivo');
    } finally {
      setIsUploading(false);
    }
  };

  const handlePickWorkspace = () => {
    setIsAttachOpen(false);
    setIsWorkspacePickerOpen(true);
  };

  const handleWorkspacePicked = async (ws: import('@/services/workspaceApi').Workspace) => {
    setIsAttachingWorkspace(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      const res = await fetch(`/api/workspace/${ws.id}/attach-context`, {
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as {
        ok: boolean;
        full_md: string;
        hoja_count: number;
        total_chars: number;
        truncated: boolean;
      };
      setAttachedWorkspace({
        id: ws.id,
        title: ws.title,
        hoja_count: body.hoja_count,
        total_chars: body.total_chars,
        truncated: body.truncated,
        full_md: body.full_md,
      });
    } catch (err: any) {
      setUploadError(err?.message ?? 'No se pudo adjuntar el workspace');
    } finally {
      setIsAttachingWorkspace(false);
    }
  };

  const agentInfo = AGENT_INFO[selectedAgent];
  const AgentIcon = AGENT_ICONS[agentInfo.icon];

  useEffect(() => {
    if (value.trim().length > 0 && !hasInteracted) setHasInteracted(true);
  }, [value, hasInteracted, setHasInteracted]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    const close = () => {
      setIsAgentSelectorOpen(false);
      setIsAttachOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const handleStop = () => {
    abortControllerRef.current?.abort();
    setIsLoading(false);
    abortControllerRef.current = null;
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (isLoading) {
      handleStop();
      return;
    }
    if (!value.trim()) return;

    const activeSessionId = currentSessionId || Date.now().toString();
    const userTrimmed = value.trim();

    // Build query prefix for attachments
    const docPrefix = attachedDoc
      ? `[Documento adjunto: ${attachedDoc.filename}, ${attachedDoc.pages}p, ${attachedDoc.chars} chars${attachedDoc.truncated ? ' — truncado' : ''}]\n\n${attachedDoc.text}\n\n---\n\n`
      : '';
    const wsPrefix = attachedWorkspace
      ? `[Workspace adjunto: "${attachedWorkspace.title}", ${attachedWorkspace.hoja_count} hojas, ${attachedWorkspace.total_chars} chars${attachedWorkspace.truncated ? ' — truncado' : ''}]\n\n${attachedWorkspace.full_md}\n\n---\n\n`
      : '';

    const queryForAgent = `${docPrefix}${wsPrefix}${userTrimmed}`;

    // User bubble display label
    let userBubbleContent = userTrimmed;
    if (attachedDoc) {
      userBubbleContent = `📎 ${attachedDoc.filename} (${attachedDoc.pages}p)\n\n${userTrimmed}`;
    } else if (attachedWorkspace) {
      userBubbleContent = `📋 Workspace adjunto: "${attachedWorkspace.title}"\n\n${userTrimmed}`;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: userBubbleContent,
      // When the user attached a document or a workspace, the bubble
      // shows a friendly label ("📎 file.pdf") but the LLM needs the
      // full text in subsequent turns to remember what was attached.
      // Stash it in llmContent so the history-forwarding path picks
      // it up (see history builder below).
      ...(userBubbleContent !== queryForAgent ? { llmContent: queryForAgent } : {}),
    };
    const assistantId = (Date.now() + 1).toString();
    const assistantMessage: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      agent: selectedAgent,
      deepInsight,
    };

    addMessage(userMessage, activeSessionId);
    addMessage(assistantMessage, activeSessionId);

    if (scope?.kind === 'session') setSessionScope(activeSessionId, scope);

    setValue('');
    setAttachedDoc(null);
    setAttachedWorkspace(null);
    setIsLoading(true);
    abortControllerRef.current = new AbortController();

    // Build conversation history from the local message store. `messages`
    // here is the snapshot BEFORE we added the new user/assistant pair
    // above (closure is stable for this handler invocation), so it is
    // exactly the "prior turns" the model needs to maintain continuity.
    // Filter out empty/streaming placeholders. We use `llmContent` when
    // present (the LLM-facing version of an attached doc / workspace)
    // and fall back to the visible `content` otherwise. Trim to the
    // last 20 turns to bound cost.
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = messages
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof (m.llmContent ?? m.content) === 'string' &&
          (m.llmContent ?? m.content).trim().length > 0,
      )
      .slice(-20)
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.llmContent ?? m.content,
      }));

    let buffer = '';

    try {
      // ── Workspace scope path ─────────────────────────────────────────────
      if (scope?.kind === 'workspace') {
        // 2026-04-28: agent picker reemplaza el mode/intent toggle. Lexa
        // implica chat-only; Atlas implica build/edit_selected (según
        // selección). El backend deriva el intent del agentId + estado
        // de selección, sin classifier. Ver docs/AGENTS.md §Atlas.
        // Si el usuario eligió "centinela" en main chat y luego entró
        // al workspace, lo coercemos a Lexa para evitar comportamiento
        // raro — Centinela no vive en workspace.
        const workspaceAgent: 'lexa' | 'atlas' =
          selectedAgent === 'atlas' ? 'atlas' : 'lexa';

        await streamWorkspaceTurn({
          workspaceId: scope.workspace_id,
          query: queryForAgent,
          agentId: workspaceAgent,
          selectedNodeId: scope.selected_node_id,
          hojaTitles: hojaTitles ?? [],
          deepInsight,
          history,
          signal: abortControllerRef.current.signal,
          onChunk: (chunk) => {
            if (chunk.type === 'token' && typeof chunk.payload === 'string') {
              buffer += chunk.payload;
              updateMessage(assistantId, { content: buffer }, activeSessionId);
            } else if (chunk.type === 'workspace_action') {
              const p = chunk.payload as WorkspaceActionPayload & {
                url?: string; gammaUrl?: string; filename?: string;
                generationId?: string; cached?: boolean; generatedAt?: string;
              };
              if (p.intent === 'pptx' && p.url && p.gammaUrl && p.filename) {
                // Pptx response — render the same inline card as the
                // openRouter dispatcher path. Body copy is short — the
                // card itself does the heavy lifting. Skip the canvas
                // mutation callback since pptx doesn't touch nodes.
                updateMessage(
                  assistantId,
                  {
                    content: p.cached
                      ? 'Tu presentación está lista (la había generado hace poco).'
                      : 'Listo, te dejé la presentación.',
                    pptxResult: {
                      filename: p.filename,
                      url: p.url,
                      gammaUrl: p.gammaUrl,
                      generationId: p.generationId ?? '',
                      cached: Boolean(p.cached),
                      generatedAt: p.generatedAt,
                    },
                    pptxLoading: false,
                  },
                  activeSessionId,
                );
              } else {
                const intentLabel = p.intent === 'build'
                  ? 'Construir hojas'
                  : p.intent === 'edit_selected'
                    ? 'Editar hoja seleccionada'
                    : 'Editar hoja';
                const actionBody = p.intent === 'build'
                  ? `_Hojas generadas — ver canvas._`
                  : `_Hoja actualizada — ver canvas._`;
                updateMessage(
                  assistantId,
                  {
                    content: `**Detecté: ${intentLabel}**\n\n${actionBody}`,
                  },
                  activeSessionId,
                );
                // Fire parent callback for canvas mutation. The else branch
                // we're in already excludes 'pptx', so TS just needs the
                // narrowing nudge to know `p.intent` is one of the canvas
                // intents.
                if (onWorkspaceAction && p.intent !== 'pptx') {
                  onWorkspaceAction({
                    intent: p.intent,
                    nodes: p.nodes,
                    node_id: p.node_id,
                    new_content: p.new_content,
                    target_match_confidence: p.target_match_confidence,
                  });
                }
              }
            } else if (chunk.type === 'citation' && Array.isArray(chunk.payload)) {
              updateMessage(
                assistantId,
                { citations: chunk.payload as ChunkCitation[] },
                activeSessionId,
              );
            } else if (chunk.type === 'pptx_status') {
              // Atlas's generate_presentation tool kicked off (or errored).
              // Show a "generando…" pill on the message; the actual card
              // arrives on `pptx_ready`.
              const p = chunk.payload as { status?: string };
              if (p?.status === 'starting') {
                updateMessage(assistantId, { pptxLoading: true }, activeSessionId);
              } else if (p?.status === 'error') {
                updateMessage(assistantId, { pptxLoading: false }, activeSessionId);
              }
            } else if (chunk.type === 'pptx_ready') {
              // Deck is ready — attach the URLs to the message so the
              // renderer shows the "Abrir / Descargar" card inline.
              const p = chunk.payload as {
                filename: string; url: string; gammaUrl: string;
                generationId: string; cached: boolean; generatedAt?: string;
              };
              updateMessage(
                assistantId,
                { pptxResult: p, pptxLoading: false },
                activeSessionId,
              );
            } else if (chunk.type === 'suggestion') {
              // Atlas attached share-as suggestion buttons to this reply.
              // Cap at 3, defensively coerce kinds, ignore empties. The
              // renderer below shows them as Lovable-style chips.
              const p = chunk.payload as {
                suggestions?: Array<{ kind?: string; label?: string; reason?: string }>;
              };
              const valid = (p?.suggestions ?? [])
                .map((s) => {
                  const k = (s.kind ?? '').toLowerCase();
                  if (
                    k !== 'carousel' && k !== 'pptx_asset' &&
                    k !== 'docx_asset' && k !== 'podcast_asset'
                  ) return null;
                  if (!s.label) return null;
                  return { kind: k as 'carousel' | 'pptx_asset' | 'docx_asset' | 'podcast_asset', label: s.label, reason: s.reason };
                })
                .filter((v): v is NonNullable<typeof v> => v !== null)
                .slice(0, 3);
              if (valid.length > 0) {
                updateMessage(assistantId, { suggestions: valid }, activeSessionId);
              }
            } else if (chunk.type === 'error') {
              const payload = chunk.payload as
                | { code?: string; message?: string }
                | string
                | undefined;
              const message =
                typeof payload === 'string'
                  ? payload
                  : payload?.message ?? 'Ocurrió un error procesando tu consulta.';
              updateMessage(
                assistantId,
                { content: buffer + (buffer ? '\n\n' : '') + `_${message}_` },
                activeSessionId,
              );
            }
          },
          onIntent: ({ intent, target_node_id }) => {
            // Surface intent info on the assistant message for rendering a pill
            updateMessage(
              assistantId,
              {
                // Use agentActive to carry intent info (re-purposed field)
                agentActive: `intent:${intent}${target_node_id ? `:${target_node_id}` : ''}`,
              },
              activeSessionId,
            );
          },
        });
      } else {
        // ── General / session scope path ──────────────────────────────────
        await streamChat({
          agentId: selectedAgent,
          query: queryForAgent,
          conversationId: activeSessionId,
          deepInsight,
          scope: scope?.kind === 'session'
            ? { kind: 'session', legacy_session_id: scope.legacy_session_id, label: scope.label }
            : undefined,
          history,
          signal: abortControllerRef.current.signal,
          onChunk: (chunk) => {
            if (chunk.type === 'token' && typeof chunk.payload === 'string') {
              buffer += chunk.payload;
              updateMessage(assistantId, { content: buffer }, activeSessionId);
            } else if (chunk.type === 'citation' && Array.isArray(chunk.payload)) {
              updateMessage(
                assistantId,
                { citations: chunk.payload as ChunkCitation[] },
                activeSessionId,
              );
            } else if (chunk.type === 'conversation') {
              const payload = chunk.payload as
                | { id?: string; scope_legacy_session_id?: number | null }
                | undefined;
              if (payload?.id) {
                adoptServerSessionId(activeSessionId, payload.id);
                if (
                  scope?.kind === 'session' &&
                  typeof payload.scope_legacy_session_id === 'number' &&
                  payload.scope_legacy_session_id === scope.legacy_session_id
                ) {
                  setSessionScope(payload.id, scope);
                }
              }
            } else if (chunk.type === 'confidence') {
              const payload = chunk.payload as
                | { score?: number; level?: 'high' | 'medium' | 'low'; rationale?: string }
                | undefined;
              if (payload && typeof payload.score === 'number' && payload.level) {
                updateMessage(
                  assistantId,
                  {
                    confidence: {
                      score: payload.score,
                      level: payload.level,
                      rationale: payload.rationale ?? '',
                    },
                  },
                  activeSessionId,
                );
              }
            } else if (chunk.type === 'error') {
              const payload = chunk.payload as
                | { code?: string; message?: string }
                | string
                | undefined;
              const message =
                typeof payload === 'string'
                  ? payload
                  : payload?.message ?? 'Ocurrió un error procesando tu consulta.';
              updateMessage(
                assistantId,
                { content: buffer + (buffer ? '\n\n' : '') + `_${message}_` },
                activeSessionId,
              );
            }
          },
        });
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        updateMessage(
          assistantId,
          {
            content:
              buffer +
              `\n\n_[error: ${error.message || 'No se pudo completar la respuesta'}]_`,
          },
          activeSessionId,
        );
      }
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // ── Workspace scope derived values ─────────────────────────────────────────
  const selectedNodeId = isWorkspaceScope ? scope.selected_node_id : null;
  const selectedNodeTitle = selectedNodeId
    ? hojaTitles?.find((h) => h.id === selectedNodeId)?.title ?? 'Hoja seleccionada'
    : null;

  // ── Resolved placeholder ───────────────────────────────────────────────────
  const resolvedPlaceholder = placeholder
    ? placeholder
    : isWorkspaceScope
      ? `Preguntá sobre "${scope.workspace_title}"…`
      : `Pregunta a ${agentInfo.name} sobre actas, mociones, votaciones…`;

  return (
    <div
      className={cn(
        'w-full flex flex-col relative z-10 h-full transition-all duration-500',
        !hasInteracted ? 'justify-center items-center' : 'justify-end',
      )}
    >
      {/* ── Panel Header ──────────────────────────────────────────────────── */}
      {!isWorkspaceScope && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/10 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: agentInfo.color, boxShadow: `0 0 10px ${agentInfo.color}` }}
            />
            <div className="min-w-0">
              <p className="font-display text-[15px] leading-tight font-medium text-[#0e1745] dark:text-white truncate">
                {agentInfo.name} <span className="text-[#0e1745]/40 dark:text-white/40 italic font-normal">activo</span>
              </p>
              <p className="text-[10px] text-[#0e1745]/45 dark:text-white/45 truncate">
                {agentInfo.role} · Cada respuesta incluye cita verificable
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {hasAssistantContent && currentSessionId && (
              <button
                type="button"
                onClick={() => setPodcastOpen(true)}
                title="Convertir esta conversación en podcast"
                aria-label="Generar podcast de esta conversación"
                className="p-2 rounded-lg text-cl2-burgundy dark:text-cl2-accent-soft hover:bg-cl2-burgundy/[0.06] dark:hover:bg-cl2-accent/[0.10] transition-colors"
              >
                <Headphones className="w-4 h-4" />
              </button>
            )}
            {onOpenHistory && (
              <button
                onClick={onOpenHistory}
                className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors lg:hidden"
                aria-label="Historial"
              >
                <Info className="w-4 h-4 text-[#0e1745]/50 dark:text-white/50" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Workspace header: workspace chip + selected-hoja chip ─────────── */}
      {isWorkspaceScope && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-black/5 dark:border-white/10 shrink-0 flex-wrap">
          {/* Workspace pill */}
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium bg-cl2-burgundy/10 text-cl2-burgundy dark:text-cl2-accent-soft border border-cl2-burgundy/20">
            <Layers className="w-3 h-3 shrink-0" />
            {scope.workspace_title}
          </span>

          {/* Selected hoja pill */}
          {selectedNodeTitle && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium bg-cl2-accent/10 text-cl2-accent border border-cl2-accent/20">
              <BookOpen className="w-3 h-3 shrink-0" />
              <span className="max-w-[140px] truncate">{selectedNodeTitle}</span>
              {onClearSelection && (
                <button
                  type="button"
                  onClick={onClearSelection}
                  aria-label="Deseleccionar hoja"
                  className="ml-0.5 hover:bg-cl2-accent/20 rounded-full p-0.5 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </span>
          )}
        </div>
      )}

      <PodcastModal
        open={podcastOpen}
        onClose={() => setPodcastOpen(false)}
        source_type="chat"
        source_id={currentSessionId ?? ''}
        source_title="Conversación con Lexa"
      />

      {/* ── Hero intro ────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {messages.length === 0 && !value && !isWorkspaceScope && (
          <>
            {/* Centinela strip — sits above the rotating headline. The
                component handles its own three states (alerts, calm,
                empty) and self-loads on mount. Stays out of the way
                if the user is unauthenticated (silent failure). */}
            <CentinelaHeroStrip />

            <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full flex flex-col items-center gap-4 px-4">
              <motion.h1
                initial={{ opacity: 0, y: 15, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: -15, filter: 'blur(6px)' }}
                className="font-display text-xl md:text-2xl lg:text-[26px] font-light text-[#0e1745]/75 dark:text-white/75 text-center tracking-tight inline-flex items-baseline justify-center gap-2 whitespace-nowrap"
              >
                <span className="font-light">¿Qué necesitás</span>
                <TextLoop
                  className="font-medium"
                  style={{ color: agentInfo.color }}
                >
                  {getAgentBestUses(selectedAgent).map((text) => (
                    <span key={text}>{text}</span>
                  ))}
                </TextLoop>
                <span className="font-light text-[#0e1745]/75 dark:text-white/75 -ml-1.5">?</span>
              </motion.h1>
            </div>
          </>
        )}
      </AnimatePresence>

      {/* ── Chat messages ─────────────────────────────────────────────────── */}
      {hasInteracted && (
        <div className="flex-1 w-full relative mb-2 px-3 flex flex-col min-h-0">
          {messages.length > 0 && (
            <div className="flex-1 overflow-y-auto scrollbar-hide flex flex-col gap-5 pb-6 pt-2">
              <AnimatePresence initial={false}>
                {messages.map((msg, idx) => {
                  const isEmptyStreamingPlaceholder =
                    msg.role === 'assistant' &&
                    !msg.content &&
                    idx === messages.length - 1 &&
                    isLoading;
                  if (isEmptyStreamingPlaceholder) return null;
                  return (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 20, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      className={cn(
                        'w-full flex',
                        msg.role === 'user' ? 'justify-end' : 'justify-start',
                      )}
                    >
                      {msg.role === 'user' ? (
                        <div className="max-w-[80%] bg-blue-600/20 border border-blue-500/30 text-[#0e1745] dark:text-white rounded-2xl rounded-tr-sm p-chat-bubble text-[14px] leading-relaxed">
                          <MessageRenderer content={msg.content} isUser={true} />
                        </div>
                      ) : (
                        <div className="w-full flex flex-col items-start gap-4">
                          <div className="w-full bg-white/60 dark:bg-white/5 backdrop-blur-md border border-white/50 dark:border-white/10 rounded-2xl p-chat-bubble text-[#0e1745] dark:text-white/90 leading-relaxed shadow-sm">
                            {/* Intent pill for workspace turns */}
                            {msg.agentActive && msg.agentActive.startsWith('intent:') && !isWorkspaceScope && null}
                            {msg.agentActive && msg.agentActive.startsWith('intent:') && isWorkspaceScope && (() => {
                              const parts = msg.agentActive.split(':');
                              const intentName = parts[1];
                              if (intentName === 'chat') return null;
                              const label = intentName === 'build'
                                ? 'Construir hojas'
                                : intentName === 'edit_selected'
                                  ? 'Editar hoja seleccionada'
                                  : 'Editar hoja';
                              return (
                                <div className="mb-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-cl2-burgundy/10 text-cl2-burgundy border border-cl2-burgundy/20">
                                  <Sparkles className="w-3 h-3" />
                                  Detecté: {label}
                                </div>
                              );
                            })()}
                            {!isWorkspaceScope && (
                              <div className="mb-4">
                                <AgentBadge
                                  agentId={
                                    msg.agent ??
                                    (msg.agentActive?.startsWith('intent:') ? undefined : msg.agentActive)
                                  }
                                />
                              </div>
                            )}
                            <div className="text-[14px] opacity-90">
                              <MessageRenderer
                                content={
                                  msg.content || (isLoading ? '▍' : '')
                                }
                                onSeek={onSeek}
                              />
                            </div>
                            {msg.citations && msg.citations.length > 0 && (
                              <CitationCards citations={msg.citations} />
                            )}
                            {/* ── Atlas share suggestions (Lovable-style) ─
                                Rendered when the agent attached a `suggestion`
                                chunk to this turn. The buttons just prompt
                                the user — clicking opens the ShareAs options
                                modal so the user explicitly confirms before
                                we generate (no blind generation). */}
                            {msg.suggestions && msg.suggestions.length > 0 && isWorkspaceScope && (
                              <div className="mt-3 flex flex-col gap-2 max-w-md">
                                <p className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-[#0e1745]/55 dark:text-white/45">
                                  Atlas sugiere
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {msg.suggestions.map((s, i) => {
                                    const mark =
                                      s.kind === 'carousel'      ? '◉' :
                                      s.kind === 'pptx_asset'    ? '▣' :
                                      s.kind === 'docx_asset'    ? '∎' :
                                                                  '♪';
                                    return (
                                      <button
                                        key={`${s.kind}-${i}`}
                                        onClick={() => onShareSuggestionPick?.(s.kind)}
                                        title={s.reason}
                                        disabled={!onShareSuggestionPick}
                                        className="group inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cl2-burgundy/[0.07] hover:bg-cl2-burgundy/15 border border-cl2-burgundy/20 text-cl2-burgundy text-[12px] font-medium transition-colors disabled:opacity-50 disabled:cursor-default"
                                      >
                                        <span className="font-display italic text-[13px] leading-none">{mark}</span>
                                        <span className="font-display italic">{s.label}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {msg.pptxLoading && !msg.pptxResult && (
                              <div className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-cl2-burgundy/10 text-cl2-burgundy text-[11px] font-medium">
                                <span className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy animate-pulse" />
                                Generando presentación con Gamma…
                              </div>
                            )}
                            {msg.pptxResult && (
                              <div className="mt-3 space-y-2 max-w-md">
                                <a
                                  href={msg.pptxResult.gammaUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block group rounded-xl border border-black/8 dark:border-white/10 hover:border-cl2-burgundy/40 dark:hover:border-cl2-burgundy/40 bg-gradient-to-br from-cl2-burgundy/5 to-transparent dark:from-cl2-burgundy/10 dark:to-transparent p-3.5 transition-all"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="text-[12px] font-medium text-[#0e1745] dark:text-white">
                                        Abrir presentación en Gamma
                                      </div>
                                      <div className="text-[10.5px] text-[#0e1745]/55 dark:text-white/55 mt-0.5 truncate">
                                        {msg.pptxResult.filename} · {msg.pptxResult.cached ? 'desde caché' : 'recién generada'}
                                      </div>
                                    </div>
                                    <span className="text-cl2-burgundy text-[14px] group-hover:translate-x-0.5 transition-transform">↗</span>
                                  </div>
                                </a>
                                <a
                                  href={msg.pptxResult.url}
                                  download={msg.pptxResult.filename}
                                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 hover:bg-black/6 dark:hover:bg-white/8 text-[11px] text-[#0e1745]/70 dark:text-white/70 font-medium transition-colors w-fit"
                                >
                                  ⬇ Descargar .pptx
                                </a>
                              </div>
                            )}
                            {msg.confidence && (
                              <ConfidenceBadge confidence={msg.confidence} />
                            )}
                          </div>
                          {/* Action row — only on completed assistant
                              messages with content. Currently:
                                · Save to workspace (always)
                                · Copy raw markdown (utility)
                              The intent here is "operate on this
                              specific reply", separate from the chat-
                              level controls. Streaming bubbles skip
                              this row to avoid jitter while content
                              renders. */}
                          {msg.content.trim().length > 0 && !(isLoading && msg === messages[messages.length - 1]) && (
                            <MessageActions
                              message={msg}
                              precedingPrompt={(() => {
                                // Most recent user message before this one.
                                const myIdx = messages.findIndex((m) => m.id === msg.id);
                                for (let i = myIdx - 1; i >= 0; i--) {
                                  if (messages[i].role === 'user') return messages[i].content;
                                }
                                return undefined;
                              })()}
                              onSendToWorkspace={(src) => setSendToWsSource(src)}
                            />
                          )}
                          {!isWorkspaceScope && (
                            <SuggestChips
                              visible={
                                msg === messages[messages.length - 1] &&
                                msg.role === 'assistant' &&
                                !isLoading &&
                                !value.trim()
                              }
                              onSelect={(question) => {
                                setValue(question);
                                textareaRef.current?.focus();
                              }}
                            />
                          )}
                        </div>
                      )}
                    </motion.div>
                  );
                })}
                {isLoading && messages[messages.length - 1]?.content === '' && (
                  <ThinkingIndicator agentId={selectedAgent} />
                )}
              </AnimatePresence>
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      )}

      {/* ── Input ─────────────────────────────────────────────────────────── */}
      <div className="w-full mt-auto shrink-0 relative px-4 pb-6">
        <div className="relative w-full rounded-2xl border border-[#0e1745]/[0.10] dark:border-white/[0.065] shadow-[0_4px_20px_rgba(14,23,69,0.065)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.19)]">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* ── Attachment pills ──────────────────────────────────────────── */}
          <AnimatePresence initial={false}>
            {(attachedDoc || attachedWorkspace || isUploading || isAttachingWorkspace || uploadError) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2 px-4 pt-3 flex-wrap">
                  {/* PDF attachment pill */}
                  {isUploading ? (
                    <span className="inline-flex items-center gap-2 text-[12px] text-[#0e1745]/60 dark:text-white/60 px-3 py-1.5 rounded-full border border-black/10 dark:border-white/15 bg-white/40 dark:bg-white/[0.04]">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Procesando PDF…
                    </span>
                  ) : attachedDoc ? (
                    <span
                      className="inline-flex items-center gap-2 text-[12px] px-3 py-1.5 rounded-full border max-w-full"
                      style={{
                        backgroundColor: '#8B6E5414',
                        borderColor: '#8B6E5430',
                        color: '#8B6E54',
                      }}
                    >
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate max-w-[280px]" title={attachedDoc.filename}>
                        {attachedDoc.filename}
                      </span>
                      <span className="text-[10.5px] opacity-70 shrink-0">
                        {attachedDoc.pages}p · {(attachedDoc.chars / 1000).toFixed(1)}K
                        {attachedDoc.truncated ? ' · trunc' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAttachedDoc(null)}
                        aria-label="Quitar documento"
                        className="ml-1 hover:bg-black/10 dark:hover:bg-white/10 rounded-full p-0.5 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ) : null}

                  {/* Workspace attachment pill */}
                  {isAttachingWorkspace ? (
                    <span className="inline-flex items-center gap-2 text-[12px] text-[#0e1745]/60 dark:text-white/60 px-3 py-1.5 rounded-full border border-black/10 dark:border-white/15 bg-white/40 dark:bg-white/[0.04]">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Cargando workspace…
                    </span>
                  ) : attachedWorkspace ? (
                    <span className="inline-flex items-center gap-2 text-[12px] px-3 py-1.5 rounded-full border border-cl2-burgundy/25 bg-cl2-burgundy/8 text-cl2-burgundy dark:text-cl2-accent-soft max-w-full">
                      <Layers className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate max-w-[200px]" title={attachedWorkspace.title}>
                        {attachedWorkspace.title}
                      </span>
                      <span className="text-[10.5px] opacity-70 shrink-0">
                        {attachedWorkspace.hoja_count} hoja{attachedWorkspace.hoja_count !== 1 ? 's' : ''}
                        {attachedWorkspace.truncated ? ' · trunc' : ''}
                      </span>
                      <button
                        type="button"
                        onClick={() => setAttachedWorkspace(null)}
                        aria-label="Quitar workspace"
                        className="ml-1 hover:bg-cl2-burgundy/15 rounded-full p-0.5 transition-colors"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ) : null}

                  {/* Upload error */}
                  {uploadError && (
                    <span className="inline-flex items-center gap-2 text-[12px] text-red-500 px-3 py-1.5 rounded-full border border-red-500/30 bg-red-500/5">
                      <X className="w-3.5 h-3.5" />
                      {uploadError}
                      <button
                        type="button"
                        onClick={() => setUploadError(null)}
                        className="ml-1 hover:bg-red-500/10 rounded-full p-0.5"
                        aria-label="Cerrar"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="relative z-10 flex flex-col w-full" data-tour="lexa-input">
            <div className="relative w-full overflow-hidden">
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onFocus={() => {
                  if (!hasInteracted) setHasInteracted(true);
                }}
                onKeyDown={handleKeyDown}
                placeholder={resolvedPlaceholder}
                className="w-full resize-none outline-none min-h-[48px] max-h-[200px] text-body leading-relaxed p-5 pb-3 relative z-10 scrollbar-hide bg-transparent text-[#0e1745] dark:text-white placeholder-black/30 dark:placeholder-white/30"
                rows={1}
                disabled={isLoading}
                spellCheck={false}
              />
            </div>

            <div className="flex items-center justify-between px-5 pb-4 pt-2 w-full gap-2">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                {/* Agent selector — Lexa + Atlas + Centinela en main chat;
                    Lexa + Atlas en workspace (Centinela no vive en /hojas).
                    Centinela tiene su propia surface en /centinela.
                    Decisión 2026-04-28 — ver docs/AGENTS.md §Atlas. */}
                {(() => {
                  const visibleAgents = isWorkspaceScope
                    ? (ALL_AGENTS.filter((a) => a === 'lexa' || a === 'atlas'))
                    : ALL_AGENTS;
                  return (
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsAgentSelectorOpen(!isAgentSelectorOpen);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-pill transition-all border text-white border-transparent"
                      style={{ backgroundColor: agentInfo.color }}
                      title={
                        isWorkspaceScope
                          ? selectedAgent === 'lexa'
                            ? 'Lexa responde sobre el contenido del workspace. No modifica hojas.'
                            : 'Atlas construye o reescribe hojas según lo que le pidas.'
                          : `${agentInfo.name}: ${agentInfo.role}`
                      }
                    >
                      {React.createElement(AgentIcon, { className: 'w-3.5 h-3.5' })}
                      <span className="max-w-[120px] truncate">{agentInfo.name}</span>
                      <ChevronDown className="w-3 h-3 opacity-70" />
                    </button>
                    <AnimatePresence>
                      {isAgentSelectorOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 8 }}
                          className="absolute left-0 bottom-full mb-2 w-72 max-h-[400px] overflow-y-auto bg-white dark:bg-[#2d2828] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl z-50 p-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-white/10 mb-2">
                            <span className="text-[10px] font-semibold text-gray-400 dark:text-white/40 uppercase tracking-wider">
                              {isWorkspaceScope ? 'CL2 · Agentes del Workspace' : 'CL2 · 3 Agentes'}
                            </span>
                            <Users className="w-3 h-3 text-gray-400 dark:text-white/40" />
                          </div>
                          {visibleAgents.map((agent) => {
                            const info = AGENT_INFO[agent];
                            const AIcomp = AGENT_ICONS[info.icon];
                            const isSel = selectedAgent === agent;
                            // Roles in workspace context — sobreescribe el `info.role`
                            // genérico con la descripción del job único en el workspace.
                            const workspaceRole =
                              isWorkspaceScope
                                ? agent === 'lexa'
                                  ? 'Pregunta. Responde sobre las hojas.'
                                  : 'Construye. Crea o reescribe hojas.'
                                : info.role;
                            return (
                              <button
                                key={agent}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedAgent(agent);
                                  setIsAgentSelectorOpen(false);
                                }}
                                className={cn(
                                  'w-full flex items-center gap-2 px-3 py-2 text-[12px] rounded-lg transition-all',
                                  isSel
                                    ? 'bg-gray-100 dark:bg-white/10 font-medium'
                                    : 'hover:bg-gray-50 dark:hover:bg-white/5',
                                )}
                              >
                                <div
                                  className="w-6 h-6 rounded-md flex items-center justify-center"
                                  style={{
                                    backgroundColor: `${info.color}20`,
                                    color: info.color,
                                  }}
                                >
                                  <AIcomp className="w-3 h-3" />
                                </div>
                                <div className="flex-1 text-left">
                                  <div
                                    className={cn(
                                      'font-medium text-[12px]',
                                      isSel
                                        ? 'text-gray-900 dark:text-white'
                                        : 'text-gray-700 dark:text-white/70',
                                    )}
                                  >
                                    {info.name}
                                  </div>
                                  <div className="text-[10px] text-gray-400 dark:text-white/40 truncate">
                                    {workspaceRole}
                                  </div>
                                </div>
                                {isSel && (
                                  <div
                                    className="w-1.5 h-1.5 rounded-full"
                                    style={{ backgroundColor: info.color }}
                                  />
                                )}
                              </button>
                            );
                          })}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  );
                })()}

                {/* Deep Insight */}
                <ShinyButton
                  active={deepInsight}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeepInsight(!deepInsight);
                  }}
                  ariaLabel="Deep Insight"
                  title="Búsqueda avanzada, análisis multifrente. Consume más."
                >
                  <Sparkles className="w-3 h-3" />
                  Deep Insight
                </ShinyButton>

                {/* Mode + intent — single segmented toolbar.
                    Old layout had two separate UI pieces: an
                    Auto/Manual pill on this row + a radio group below
                    when Manual. Consolidated into 4 mutually-exclusive
                    segments. Auto = automatic routing; the other three
                    pin manual mode with a specific intent. Saves a
                    full row of vertical space and removes a layout
                    shift when the user toggles. */}
                {/* 2026-04-28 — el ModeIntentToolbar (auto/manual + chat/build/edit/match)
                    se reemplazó por el agent picker (Lexa/Atlas) arriba. La intent
                    se deriva del agente seleccionado + estado de selección, sin
                    classifier. Ver docs/AGENTS.md §Atlas. */}

                {/* Adjuntar dropdown — replaces simple Paperclip */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsAttachOpen(!isAttachOpen);
                    }}
                    disabled={isUploading || isAttachingWorkspace || isLoading}
                    className="flex items-center justify-center h-8 w-8 rounded-full border border-black/10 dark:border-white/15 text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    aria-label="Adjuntar"
                    title="Adjuntar PDF o Workspace"
                  >
                    {(isUploading || isAttachingWorkspace) ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Paperclip className="w-3.5 h-3.5" />
                    )}
                  </button>

                  <AnimatePresence>
                    {isAttachOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 4 }}
                        className="absolute left-0 bottom-full mb-2 w-44 bg-white dark:bg-[#2d2828] border border-gray-200 dark:border-white/10 rounded-xl shadow-xl z-50 p-1 overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 text-[#0e1745] dark:text-white transition-colors"
                          onClick={handlePickFile}
                        >
                          <FileText className="w-3.5 h-3.5 text-[#8B6E54]" />
                          PDF
                        </button>
                        <button
                          className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 text-[#0e1745] dark:text-white transition-colors"
                          onClick={handlePickWorkspace}
                        >
                          <Layers className="w-3.5 h-3.5 text-cl2-burgundy" />
                          Workspace
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Voice input */}
                <VoiceInput
                  accent={agentInfo.color}
                  disabled={isLoading}
                  onTranscript={(text) => {
                    setValue((prev) => {
                      const trimmed = prev.trim();
                      if (!trimmed) return text;
                      const sep = /[.!?…]\s*$/.test(trimmed) ? ' ' : ' ';
                      return `${trimmed}${sep}${text}`;
                    });
                    requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                />
              </div>

              <button
                onClick={handleSubmit}
                className={cn(
                  'p-2.5 rounded-pill transition-all duration-base shrink-0',
                  value.trim() || isLoading
                    ? 'text-white hover:scale-105 shadow-raised'
                    : 'bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-white/30 cursor-not-allowed',
                )}
                style={value.trim() || isLoading
                  ? { backgroundColor: isWorkspaceScope ? '#7A3B47' : agentInfo.color }
                  : undefined}
                disabled={!value.trim() && !isLoading}
                aria-label={isLoading ? 'Detener' : 'Enviar'}
              >
                {isLoading ? (
                  <Square className="w-4 h-4 fill-current" />
                ) : (
                  <ArrowUp className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* (Manual intent radio removed — consolidated into the
                ModeIntentToolbar above the textarea.) */}
          </div>
        </div>
        <p className="text-[10px] text-[#0e1745]/30 dark:text-white/30 mt-2 text-center tracking-wide">
          La IA puede cometer errores, lea bien las respuestas — CL2 1.0.0 by Shiftlab
        </p>
      </div>

      {/* ── Workspace picker modal ─────────────────────────────────────────── */}
      <WorkspacePickerModal
        open={isWorkspacePickerOpen}
        onClose={() => setIsWorkspacePickerOpen(false)}
        onPick={handleWorkspacePicked}
      />

      {/* "Save AI reply to workspace" — opens whenever a per-message
          action button sets sendToWsSource. Single shared modal so
          opening one closes any prior one (the source is the only
          state that varies). */}
      <SendToWorkspaceModal
        open={sendToWsSource !== null}
        onClose={() => setSendToWsSource(null)}
        sources={sendToWsSource ? [sendToWsSource] : []}
        summary="Respuesta de Lexa"
      />
    </div>
  );
}

// ─── Per-message action row ─────────────────────────────────────────
//
// Renders below each completed assistant message bubble. Currently:
//   · "Guardar en workspace" — opens SendToWorkspaceModal with a
//     `chat`-typed source whose payload includes the response HTML +
//     the most recent user prompt for context.
//   · "Copiar" — copies the raw markdown/text to clipboard.
//
// The reason this is its own component (vs inlining in the bubble
// JSX): keeping the markdown→html conversion + clipboard state local
// stops re-renders of one bubble's actions from cascading into the
// other bubbles in the list.
function MessageActions({
  message,
  precedingPrompt,
  onSendToWorkspace,
}: {
  message: { id: string; content: string; agent?: Agent; agentActive?: string };
  precedingPrompt?: string;
  onSendToWorkspace: (src: ImportSource) => void;
}) {
  const [copied, setCopied] = useState(false);

  // Convert the message's markdown-ish content to a minimal HTML
  // payload for the workspace import endpoint. We don't run a full
  // markdown parser here — just paragraph splits + inline formatting
  // hints. The server's sanitizer accepts the result either way and
  // TipTap's parseHTML handles whatever structure survives.
  const buildHtmlPayload = useCallback((): string => {
    const md = message.content.trim();
    // If the model returned HTML already (rare but possible via tool
    // outputs), pass it through. Otherwise paragraphize.
    if (/^<[a-z][^>]*>/i.test(md)) return md;
    const escape = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s: string) =>
      escape(s)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^\s*][^*]*[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    return md
      .split(/\n{2,}/)
      .map((para) => para.trim())
      .filter(Boolean)
      .map((para) => {
        // Heading shortcuts: ## / ###
        const h2 = para.match(/^#{2}\s+(.+)$/);
        if (h2) return `<h2>${inline(h2[1])}</h2>`;
        const h3 = para.match(/^#{3}\s+(.+)$/);
        if (h3) return `<h3>${inline(h3[1])}</h3>`;
        // Bullet block (each line starts with "- ")
        if (/^(?:- .+\n?)+$/.test(para)) {
          const items = para.split('\n').map((l) => l.replace(/^- /, '')).filter(Boolean);
          return `<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`;
        }
        return `<p>${inline(para).replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
  }, [message.content]);

  const handleSend = () => {
    const agentName =
      typeof message.agent === 'object' && message.agent
        ? (message.agent as unknown as { name?: string }).name ?? 'Lexa'
        : 'Lexa';
    onSendToWorkspace({
      type: 'chat',
      payload: {
        html: buildHtmlPayload(),
        prompt: precedingPrompt,
        agent: agentName,
        timestamp: new Date().toISOString(),
      },
    });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // older browsers — silent
    }
  };

  return (
    <div className="flex items-center gap-1 px-1 -mt-2">
      <button
        type="button"
        onClick={handleSend}
        title="Guardar esta respuesta en un workspace"
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-[#0e1745]/55 dark:text-white/55 hover:text-cl2-burgundy dark:hover:text-[#d8a4ad] hover:bg-cl2-burgundy/[0.06] dark:hover:bg-cl2-accent/[0.10] transition-colors"
      >
        <Layers size={11} />
        Guardar en workspace
      </button>
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? 'Copiado' : 'Copiar texto'}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] transition-colors"
      >
        {copied ? <CheckCircle2 size={11} className="text-emerald-600 dark:text-emerald-400" /> : <CopyIcon size={11} />}
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

// ─── Mode + intent toolbar ──────────────────────────────────────────
//
// Segmented control that replaces the old "Auto/Manual pill + Manual
// intent radio group". 4 mutually-exclusive segments:
//
//   Auto       → mode='auto'
//   Pregunta   → mode='manual', intent='chat'
//   Construir  → mode='manual', intent='build'
//   Editar     → mode='manual', intent='edit_selected'
//
// Only the current segment shows its label (collapsed pill); the
// others render as compact icons. This keeps horizontal footprint
// small in narrow chat panels while still letting the user see what's
// active at a glance. The collapsed pill expands on hover for
// discoverability.

type ModeOrIntent = 'auto' | ManualIntent;

interface ModeIntentToolbarProps {
  mode: 'auto' | 'manual';
  intent: ManualIntent;
  onChange: (next: ModeOrIntent) => void;
}

// Mini-icon set from lucide-react. Picked for semantic clarity:
//   Bot          → "auto" (automated assistant)
//   MessageSquare → free chat / question
//   Hammer       → "build" hojas via Arquitecta
//   Pencil       → edit the selected hoja
const MODE_INTENT_OPTIONS: Array<{
  value: ModeOrIntent;
  label: string;
  Icon: React.ElementType;
  title: string;
}> = [
  { value: 'auto',          label: 'Auto',      Icon: Bot,           title: 'Auto — Lexa decide cómo responder' },
  { value: 'chat',          label: 'Pregunta',  Icon: MessageSquare, title: 'Manual: pregunta libre' },
  { value: 'build',         label: 'Construir', Icon: Hammer,        title: 'Manual: construir hojas (Arquitecta)' },
  { value: 'edit_selected', label: 'Editar',    Icon: Pencil,        title: 'Manual: editar la hoja seleccionada' },
];

function ModeIntentToolbar({ mode, intent, onChange }: ModeIntentToolbarProps) {
  const active: ModeOrIntent = mode === 'auto' ? 'auto' : intent;
  return (
    <div
      role="radiogroup"
      aria-label="Modo de respuesta"
      className="inline-flex items-center gap-0.5 rounded-pill p-0.5 bg-[#0e1745]/[0.04] dark:bg-white/[0.06] border border-[#0e1745]/[0.06] dark:border-white/[0.08]"
    >
      {MODE_INTENT_OPTIONS.map((opt) => {
        const isActive = active === opt.value;
        const Icon = opt.Icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={(e) => {
              e.stopPropagation();
              if (!isActive) onChange(opt.value);
            }}
            title={opt.title}
            className={cn(
              'inline-flex items-center gap-1 rounded-full text-[11.5px] font-medium leading-none transition-all',
              // Active = full pill with label + icon. Inactive =
              // compact icon-only. Tooltip surfaces the label.
              isActive
                ? opt.value === 'auto'
                  ? 'px-2.5 py-1 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 shadow-sm'
                  : 'px-2.5 py-1 bg-cl2-burgundy/[0.10] dark:bg-cl2-accent/[0.18] text-cl2-burgundy dark:text-[#d8a4ad] shadow-sm'
                : 'px-1.5 py-1 text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.06]',
            )}
          >
            <Icon className="w-3 h-3" strokeWidth={2.2} aria-hidden />
            {isActive && <span>{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
