import React, { useRef, useState, useEffect } from 'react';
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
  Loader2,
} from 'lucide-react';

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
import { streamChat } from '@/services/chatStream';
import { uploadPdf } from '@/services/uploadPdf';

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

interface AnimatedAiInputProps {
  onOpenHistory?: () => void;
  /**
   * Optional binding to a legacy plenaria. When set, every turn sent from
   * this input includes `scope.legacy_session_id` in the request body — the
   * BFF then injects session metadata as a system message (server-side) and
   * tags the persisted conversation with the scope id, so the sidebar can
   * group "Sesión #N — …" chats above general ones.
   *
   * Implementation: see docs/issues/001-session-scoped-chat-production.md.
   */
  scope?: ChatScope;
  /** Optional placeholder override (e.g. "Preguntá sobre esta sesión..."). */
  placeholder?: string;
  /**
   * Optional seek handler — when provided, timecodes mentioned in assistant
   * messages (e.g. "(15:10)" or "1:57:26") become clickable buttons that call
   * this with the parsed seconds. Used in SesionViewPage to drive the
   * YouTube iframe seek.
   */
  onSeek?: (seconds: number) => void;
  /**
   * Optional prefill — the parent can stuff a draft message into the
   * composer (e.g. "Send to Lexa" from the transcript or resumen
   * panels). The `nonce` lets the parent re-fire even if the text is
   * the same; we react to `nonce` changes, not to text. Same pattern
   * as `seekToken` in SesionViewPage.
   */
  prefill?: { text: string; nonce: number } | null;
}

export function AnimatedAiInput({ onOpenHistory, scope, placeholder, onSeek, prefill }: AnimatedAiInputProps) {
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
    adoptServerSessionId,
    setSessionScope,
  } = useChat();

  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoResizeTextarea(textareaRef, value);

  // Prefill plumbing — react to nonce changes, not to text. The parent
  // (SesionViewPage) bumps the nonce every time it wants to push a new
  // draft into the composer (e.g. "Send to Lexa" from the transcript).
  // We replace the existing draft on purpose: if the user already had
  // typed something, sending a new selection trumps it. They'd usually
  // be sending a fresh question with a fresh context anyway.
  const lastPrefillNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill) return;
    if (lastPrefillNonceRef.current === prefill.nonce) return;
    lastPrefillNonceRef.current = prefill.nonce;
    setValue(prefill.text);
    // Move caret to the end after React paints. requestAnimationFrame
    // ensures the textarea has rendered the new value before we touch
    // selectionStart/End.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      // Scroll the caret into view in case the prefill is long.
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

  const handlePickFile = () => {
    setUploadError(null);
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

  const agentInfo = AGENT_INFO[selectedAgent];
  const AgentIcon = AGENT_ICONS[agentInfo.icon];

  useEffect(() => {
    if (value.trim().length > 0 && !hasInteracted) setHasInteracted(true);
  }, [value, hasInteracted, setHasInteracted]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  useEffect(() => {
    const close = () => setIsAgentSelectorOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, []);

  const handleStop = () => {
    abortControllerRef.current?.abort();
    setIsLoading(false);
    abortControllerRef.current = null;
  };

  const handleSubmit = async () => {
    if (isLoading) {
      handleStop();
      return;
    }
    if (!value.trim()) return;

    const activeSessionId = currentSessionId || Date.now().toString();
    const userTrimmed = value.trim();
    const docPrefix = attachedDoc
      ? `[Documento adjunto: ${attachedDoc.filename}, ${attachedDoc.pages}p, ${attachedDoc.chars} chars${attachedDoc.truncated ? ' — truncado' : ''}]\n\n${attachedDoc.text}\n\n---\n\n`
      : '';
    // Session scope is sent server-side as `scope.legacy_session_id`, not as
    // a prefix on `query`. Keeps messages.content clean and stops resending
    // the same metadata block on every turn. See docs/issues/001.
    const queryForAgent = `${docPrefix}${userTrimmed}`;
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: attachedDoc
        ? `📎 ${attachedDoc.filename} (${attachedDoc.pages}p)\n\n${userTrimmed}`
        : userTrimmed,
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

    // Tag the session with its scope (idempotent). Lives in localStorage so
    // the sidebar can group "Sesión #N" chats without re-fetching scope.
    if (scope) setSessionScope(activeSessionId, scope);

    setValue('');
    setAttachedDoc(null);
    setIsLoading(true);
    abortControllerRef.current = new AbortController();

    let buffer = '';

    try {
      await streamChat({
        agentId: selectedAgent,
        query: queryForAgent,
        conversationId: activeSessionId,
        deepInsight,
        scope: scope ? { legacy_session_id: scope.legacy_session_id } : undefined,
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
              // Reconcile the local scope with what the server actually
              // persisted — covers the case where the server spawned a fresh
              // thread because the existing one had a different scope.
              if (
                scope &&
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
            // Backend emits { code, message } objects; tolerate string for safety.
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

  return (
    <div
      className={cn(
        'w-full flex flex-col relative z-10 h-full transition-all duration-500',
        !hasInteracted ? 'justify-center items-center' : 'justify-end',
      )}
    >
      {/* Panel Header */}
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

      {/* Hero intro — morphing text */}
      <AnimatePresence>
        {messages.length === 0 && !value && (
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
        )}
      </AnimatePresence>

      {/* Chat messages */}
      {hasInteracted && (
        <div className="flex-1 w-full relative mb-2 px-3 flex flex-col min-h-0">
          {messages.length > 0 && (
            <div className="flex-1 overflow-y-auto scrollbar-hide flex flex-col gap-5 pb-6 pt-2">
              <AnimatePresence initial={false}>
                {messages.map((msg, idx) => {
                  // Skip empty assistant placeholder while streaming —
                  // ThinkingIndicator below owns that state. Otherwise the
                  // agent name renders twice (badge + indicator).
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
                          <div className="mb-4">
                            <AgentBadge agentId={msg.agent || msg.agentActive} />
                          </div>
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
                          {msg.confidence && (
                            <ConfidenceBadge confidence={msg.confidence} />
                          )}
                        </div>
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

      {/* Input */}
      <div className="w-full mt-auto shrink-0 relative px-4 pb-6">
        <div className="relative w-full rounded-2xl border border-[#0e1745]/[0.10] dark:border-white/[0.065] shadow-[0_4px_20px_rgba(14,23,69,0.065)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.19)]">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={handleFileChange}
          />
          <AnimatePresence initial={false}>
            {(attachedDoc || isUploading || uploadError) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <div className="flex items-center gap-2 px-4 pt-3">
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
                  ) : uploadError ? (
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
                  ) : null}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="relative z-10 flex flex-col w-full">
            <div className="relative w-full overflow-hidden">
              <textarea
                ref={textareaRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onFocus={() => {
                  if (!hasInteracted) setHasInteracted(true);
                }}
                onKeyDown={handleKeyDown}
                placeholder={placeholder ?? `Pregunta a ${agentInfo.name} sobre actas, mociones, votaciones…`}
                className="w-full resize-none outline-none min-h-[48px] max-h-[200px] text-body leading-relaxed p-5 pb-3 relative z-10 scrollbar-hide bg-transparent text-[#0e1745] dark:text-white placeholder-black/30 dark:placeholder-white/30"
                rows={1}
                disabled={isLoading}
                spellCheck={false}
              />
            </div>
            <div className="flex items-center justify-between px-5 pb-4 pt-2 w-full gap-2">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                {/* Agent selector */}
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsAgentSelectorOpen(!isAgentSelectorOpen);
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-pill transition-all border text-white border-transparent"
                    style={{ backgroundColor: agentInfo.color }}
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
                            CL2 · 3 Agentes
                          </span>
                          <Users className="w-3 h-3 text-gray-400 dark:text-white/40" />
                        </div>
                        {ALL_AGENTS.map((agent) => {
                          const info = AGENT_INFO[agent];
                          const AIcomp = AGENT_ICONS[info.icon];
                          const isSel = selectedAgent === agent;
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
                                  {info.role}
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

                {/* Deep Insight toggle — ShinyButton (21st.dev) */}
                <ShinyButton
                  active={deepInsight}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeepInsight(!deepInsight);
                  }}
                  ariaLabel="Deep Insight"
                >
                  <Sparkles className="w-3 h-3" />
                  Deep Insight
                </ShinyButton>

                {/* Attach file — PDF upload */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePickFile();
                  }}
                  disabled={isUploading || isLoading}
                  className="flex items-center justify-center h-8 w-8 rounded-full border border-black/10 dark:border-white/15 text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  aria-label="Adjuntar PDF"
                  title="Adjuntar PDF (máx 25MB)"
                >
                  {isUploading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Paperclip className="w-3.5 h-3.5" />
                  )}
                </button>

                {/* Voice note — placeholder (21st.dev VoiceInput) */}
                <VoiceInput accent={agentInfo.color} />
              </div>
              <button
                onClick={handleSubmit}
                className={cn(
                  'p-2.5 rounded-pill transition-all duration-base shrink-0',
                  value.trim() || isLoading
                    ? 'bg-shift-primary text-white hover:scale-105 shadow-raised'
                    : 'bg-gray-200 dark:bg-white/10 text-gray-400 dark:text-white/30 cursor-not-allowed',
                )}
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
          </div>
        </div>
        <p className="text-[10px] text-[#0e1745]/30 dark:text-white/30 mt-2 text-center tracking-wide">
          La IA puede cometer errores, lea bien las respuestas — CL2 1.0.0 by Shiftlab
        </p>
      </div>
    </div>
  );
}
