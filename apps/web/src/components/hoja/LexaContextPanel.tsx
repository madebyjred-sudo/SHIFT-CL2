/**
 * LexaContextPanel — embedded Lexa chat that knows about the selected hoja.
 *
 * Two modes:
 *   • PREGUNTA   — free-form Q&A about the selected hoja. Streams via /api/chat.
 *                  "Enviar al canvas" creates a single new HojaNode.
 *   • ARQUITECTA — Lexa designs a 3-6 hoja workspace from a high-level prompt
 *                  ("Armame el análisis del expediente 23.583"). Calls
 *                  /api/workspace/:id/architect; returned nodes appear on the
 *                  canvas in one batch with a stagger animation.
 *
 * The arquitecta mode is the core differentiator that makes Hojas a MAIN
 * feature instead of a side panel: ONE prompt → entire research brief.
 */
import { useState, useCallback, useRef } from 'react';
import { BookOpen, Sparkles, ArrowRight, Layers, MessageSquareText, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { createNode, architectWorkspace, type WorkspaceNode } from '@/services/workspaceApi';

type Mode = 'pregunta' | 'arquitecta';

interface Props {
  workspaceId: string;
  selectedNode: {
    id: string;
    title: string;
    subtitle?: string;
    content?: { md?: string };
  } | null;
  /** Called when a new hoja is created from Lexa's answer (single node). */
  onNodeCreated: (nodeId: string) => void;
  /** Called when Arquitecta generates a batch of new hojas. */
  onNodesGenerated?: (nodes: WorkspaceNode[]) => void;
  /** Canvas viewport center to position new nodes. */
  nextNodePosition: () => { x: number; y: number };
}

export function LexaContextPanel({
  workspaceId,
  selectedNode,
  onNodeCreated,
  onNodesGenerated,
  nextNodePosition,
}: Props) {
  const [mode, setMode] = useState<Mode>('pregunta');
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState('');
  const [arquitectaSummary, setArquitectaSummary] = useState('');
  const [arquitectaPhase, setArquitectaPhase] = useState<'analizando' | 'generando' | 'creando' | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const contextPrefix = selectedNode
    ? `[Contexto — Hoja seleccionada: "${selectedNode.title}"]\n${selectedNode.content?.md ?? ''}\n\n---\n`
    : '';

  // ── Pregunta mode: stream /api/chat ────────────────────────────────
  const handleAsk = useCallback(async () => {
    if (!query.trim() || isLoading) return;
    setIsLoading(true);
    setError(null);
    setAnswer('');
    setArquitectaSummary('');

    try {
      const { supabase } = await import('@/lib/supabase');
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          message: contextPrefix + query,
          agent: 'lexa',
          tenant_id: 'cl2',
        }),
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;
          try {
            const parsed = JSON.parse(raw);
            const text = parsed?.choices?.[0]?.delta?.content ?? parsed?.delta?.text ?? '';
            if (text) { acc += text; setAnswer(acc); }
          } catch { /* skip malformed SSE */ }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [query, isLoading, contextPrefix]);

  // ── Arquitecta mode: POST /architect, materialize all hojas at once ─
  const handleArchitect = useCallback(async () => {
    if (!query.trim() || isLoading) return;
    setIsLoading(true);
    setError(null);
    setAnswer('');
    setArquitectaSummary('');

    // Phase indicator — purely cosmetic, the backend is one round-trip.
    // We sequence the labels on a timer so the user sees motion while
    // OpenRouter is composing (typical: 6-12s for 4-6 hojas with Sonnet).
    setArquitectaPhase('analizando');
    const t1 = setTimeout(() => setArquitectaPhase('generando'), 1500);
    const t2 = setTimeout(() => setArquitectaPhase('creando'), 4500);

    try {
      const result = await architectWorkspace(workspaceId, query);
      setArquitectaSummary(result.summary || `${result.nodes.length} hojas generadas`);
      onNodesGenerated?.(result.nodes);
      setQuery('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      clearTimeout(t1); clearTimeout(t2);
      setArquitectaPhase(null);
      setIsLoading(false);
    }
  }, [query, isLoading, workspaceId, onNodesGenerated]);

  const handleSubmit = mode === 'pregunta' ? handleAsk : handleArchitect;

  // ── Pregunta: send single answer to canvas as a new hoja ────────────
  const handleSendToCanvas = useCallback(async () => {
    if (!answer) return;
    const pos = nextNodePosition();
    try {
      const node = await createNode(workspaceId, {
        type: 'hoja',
        title: query.slice(0, 80) || 'Respuesta de Lexa',
        subtitle: selectedNode ? `En contexto de: ${selectedNode.title}` : '',
        content: { md: answer },
        x: pos.x,
        y: pos.y,
      });
      onNodeCreated(node.id);
      setQuery('');
      setAnswer('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, [answer, query, workspaceId, selectedNode, nextNodePosition, onNodeCreated]);

  const placeholder = mode === 'arquitecta'
    ? 'Pedile a Lexa que arme un workspace…\nej: "Análisis completo del expediente 23.583"'
    : selectedNode ? `Preguntá sobre "${selectedNode.title}"…` : 'Hacé una pregunta…';

  const arquitectaPhaseLabel: Record<NonNullable<typeof arquitectaPhase>, string> = {
    analizando: 'Analizando contexto…',
    generando: 'Diseñando hojas…',
    creando: 'Componiendo contenido…',
  };

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-[#181818] border-r border-black/8 dark:border-white/6">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="px-4 pt-4 pb-3 border-b border-black/6 dark:border-white/6">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-cl2-burgundy/15 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-cl2-burgundy" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-[#0e1745] dark:text-white">Lexa</p>
            <p className="text-[10px] text-[#0e1745]/45 dark:text-white/45 truncate">
              {mode === 'arquitecta' ? 'Arquitecta de espacios' : 'Asistente legislativa'}
            </p>
          </div>
        </div>

        {/* ── Mode toggle ─────────────────────────────────────── */}
        <div className="mt-3 grid grid-cols-2 gap-1 p-1 rounded-xl bg-black/5 dark:bg-white/[0.04]">
          <button
            onClick={() => setMode('pregunta')}
            className={cn(
              'flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-medium transition-all',
              mode === 'pregunta'
                ? 'bg-white dark:bg-white/[0.08] shadow-sm text-[#0e1745] dark:text-white'
                : 'text-[#0e1745]/55 dark:text-white/50 hover:text-[#0e1745] dark:hover:text-white/80',
            )}
          >
            <MessageSquareText className="w-3 h-3" />
            Pregunta
          </button>
          <button
            onClick={() => setMode('arquitecta')}
            className={cn(
              'flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-medium transition-all',
              mode === 'arquitecta'
                ? 'bg-cl2-burgundy text-white shadow-sm'
                : 'text-cl2-burgundy/70 dark:text-cl2-burgundy/80 hover:text-cl2-burgundy',
            )}
          >
            <Layers className="w-3 h-3" />
            Arquitecta
          </button>
        </div>

        {/* Selected hoja pill (only in pregunta mode) */}
        {mode === 'pregunta' && (
          selectedNode ? (
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-cl2-accent/8 border border-cl2-accent/15">
              <BookOpen className="w-3 h-3 text-cl2-accent shrink-0" />
              <p className="text-[11px] font-medium text-cl2-accent truncate">{selectedNode.title}</p>
            </div>
          ) : (
            <div className="mt-3 px-3 py-2 rounded-xl bg-black/4 dark:bg-white/4 border border-dashed border-black/12 dark:border-white/12">
              <p className="text-[11px] text-[#0e1745]/45 dark:text-white/40 text-center">
                Seleccioná una hoja para darle contexto a Lexa
              </p>
            </div>
          )
        )}

        {/* Arquitecta hint */}
        {mode === 'arquitecta' && (
          <div className="mt-3 px-3 py-2 rounded-xl bg-gradient-to-br from-cl2-burgundy/8 to-cl2-accent/8 border border-cl2-burgundy/15">
            <p className="text-[11px] text-cl2-burgundy/90 dark:text-cl2-burgundy/80 leading-snug">
              Lexa va a generar 3-6 hojas posicionadas en el canvas, con resumen ejecutivo + análisis temático.
            </p>
          </div>
        )}
      </div>

      {/* ── Body ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* Pregunta answer */}
        {mode === 'pregunta' && answer && (
          <div className="rounded-xl bg-white dark:bg-white/5 border border-black/8 dark:border-white/8 p-3">
            <p className="text-[12px] text-[#0e1745]/70 dark:text-white/70 whitespace-pre-wrap leading-relaxed">{answer}</p>
            <button
              onClick={handleSendToCanvas}
              className="mt-3 w-full flex items-center justify-center gap-1.5 py-2 rounded-lg bg-cl2-accent text-white text-[12px] font-semibold hover:bg-cl2-accent-hover transition-colors"
            >
              Enviar al canvas <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Arquitecta success */}
        {mode === 'arquitecta' && arquitectaSummary && !isLoading && (
          <div className="rounded-xl bg-gradient-to-br from-emerald-50 to-emerald-50/50 dark:from-emerald-950/30 dark:to-emerald-950/10 border border-emerald-200/40 dark:border-emerald-800/30 p-3">
            <div className="flex items-start gap-2">
              <div className="w-7 h-7 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
                <Layers className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 mb-0.5">
                  Hojas creadas
                </p>
                <p className="text-[12px] text-[#0e1745]/70 dark:text-white/70 leading-relaxed">
                  {arquitectaSummary}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Loading: pregunta */}
        {mode === 'pregunta' && isLoading && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-cl2-burgundy/8">
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
            <span className="text-[11px] text-cl2-burgundy font-medium">Lexa está analizando…</span>
          </div>
        )}

        {/* Loading: arquitecta — phase indicator */}
        {mode === 'arquitecta' && isLoading && arquitectaPhase && (
          <div className="rounded-xl bg-gradient-to-br from-cl2-burgundy/10 to-cl2-accent/10 border border-cl2-burgundy/15 p-3">
            <div className="flex items-center gap-2.5">
              <Loader2 className="w-4 h-4 text-cl2-burgundy animate-spin shrink-0" />
              <p className="text-[12px] text-cl2-burgundy font-semibold">
                {arquitectaPhaseLabel[arquitectaPhase]}
              </p>
            </div>
            <div className="mt-2.5 space-y-1">
              {(['analizando', 'generando', 'creando'] as const).map((p, i) => {
                const phaseOrder = ['analizando', 'generando', 'creando'];
                const currentIdx = phaseOrder.indexOf(arquitectaPhase);
                const done = i < currentIdx;
                const active = i === currentIdx;
                return (
                  <div key={p} className="flex items-center gap-2">
                    <span className={cn(
                      'w-1.5 h-1.5 rounded-full transition-colors',
                      done ? 'bg-emerald-500' : active ? 'bg-cl2-burgundy animate-pulse' : 'bg-black/15 dark:bg-white/15',
                    )} />
                    <span className={cn(
                      'text-[10.5px] transition-colors',
                      done ? 'text-emerald-600 dark:text-emerald-400 line-through' : active ? 'text-cl2-burgundy font-medium' : 'text-[#0e1745]/40 dark:text-white/35',
                    )}>
                      {arquitectaPhaseLabel[p]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {error && (
          <p className="text-[11px] text-red-500 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20">
            {error}
          </p>
        )}

        {!isLoading && !answer && !arquitectaSummary && !error && (
          <div className="text-center py-8">
            <p className="text-[12px] text-[#0e1745]/35 dark:text-white/35 leading-relaxed">
              {mode === 'arquitecta'
                ? 'Probá: "Análisis del expediente 23.583", "Brief de seguridad ciudadana", "Comparativa de los proyectos sobre IA"'
                : selectedNode
                  ? `Preguntale algo sobre "${selectedNode.title}"…`
                  : 'Hacé una pregunta legislativa'}
            </p>
          </div>
        )}
      </div>

      {/* ── Input ───────────────────────────────────────────────── */}
      <div className="px-3 pb-4 pt-2 border-t border-black/6 dark:border-white/6">
        <div className={cn(
          'rounded-xl border transition-colors overflow-hidden',
          'bg-white dark:bg-white/5',
          mode === 'arquitecta'
            ? 'border-cl2-burgundy/20 focus-within:border-cl2-burgundy/50 focus-within:ring-2 focus-within:ring-cl2-burgundy/10'
            : 'border-black/10 dark:border-white/10 focus-within:border-cl2-accent/50 focus-within:ring-2 focus-within:ring-cl2-accent/10',
        )}>
          <textarea
            ref={textareaRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
            placeholder={placeholder}
            rows={mode === 'arquitecta' ? 4 : 3}
            disabled={isLoading}
            className="w-full px-3 py-2.5 bg-transparent text-[13px] text-[#0e1745] dark:text-white placeholder:text-black/30 dark:placeholder:text-white/30 focus:outline-none resize-none disabled:opacity-60"
          />
          <div className="px-3 pb-2.5 flex justify-end">
            <button
              onClick={handleSubmit}
              disabled={!query.trim() || isLoading}
              className={cn(
                'px-3 py-1.5 rounded-lg text-white text-[12px] font-semibold disabled:opacity-40 transition-colors flex items-center gap-1.5',
                mode === 'arquitecta'
                  ? 'bg-cl2-burgundy hover:bg-cl2-burgundy/90'
                  : 'bg-cl2-accent hover:bg-cl2-accent-hover',
              )}
            >
              {mode === 'arquitecta' ? (
                <><Layers className="w-3 h-3" /> Construir</>
              ) : (
                <><Sparkles className="w-3 h-3" /> Preguntar</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
