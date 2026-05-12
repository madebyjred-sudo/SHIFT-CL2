/**
 * SrtNode — nodo workspace dedicado a la transcripción de una sesión plenaria.
 *
 * Pedido por Jred 2026-05-12:
 *   - Lista fija con scroll interno (el nodo no crece).
 *   - Toda la transcripción accesible scrolleando.
 *   - Selección de un segmento (click).
 *   - Multi-selección con Alt+click (toggle de cada segment).
 *   - Copiar selección al clipboard.
 *   - Mandar selección como contexto a Lexa para preguntar sobre ello.
 *
 * Diseño:
 *   - El nodo guarda en DB solo metadata (session_id, title, fecha, yt_id).
 *   - Al montarse, fetcha /api/sessions/:id/transcript y arma la lista.
 *   - Estado de selección local (Set de segment indices).
 *   - Click sin modificadores: selección única (reemplaza).
 *   - Alt+click (o Cmd/Ctrl): toggle el segment en la selección.
 *   - Shift+click: rango contiguo desde el último seleccionado.
 */
import { useEffect, useRef, useState } from 'react';
import { Handle, Position } from '@xyflow/react';
import { Loader2, Copy, MessageSquare, X, Search } from 'lucide-react';
import { supabase } from '@/lib/supabase';

interface SrtNodeData {
  id: string;
  workspaceId: string;
  content?: {
    session_id?: string;
    session_title?: string;
    session_fecha?: string | null;
    youtube_id?: string | null;
    session_duration_s?: number | null;
    segment_count?: number;
  };
  title?: string;
  subtitle?: string;
  color?: string;
  onDelete?: (id: string) => void;
  /** Callback que abre Lexa con la selección como contexto. Se pasa desde
   *  WorkspaceCanvasPage. Si no se pasa, el botón muestra el texto pre-formado
   *  en un alert (fallback). */
  onAskLexa?: (opts: { context: string; sessionId: string; sessionTitle: string }) => void;
}

interface Segment {
  index: number;
  start: number;
  end: number;
  text: string;
  word_count: number;
}

function fmtTs(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function SrtNode({ id, data, selected }: { id: string; data: SrtNodeData; selected?: boolean }) {
  const sessionId = data.content?.session_id;
  const sessionTitle = data.content?.session_title ?? 'Sesión';
  const youtubeId = data.content?.youtube_id ?? null;

  const [segments, setSegments] = useState<Segment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [lastAnchor, setLastAnchor] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Fetch transcript on mount ─────────────────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    let cancel = false;
    async function load() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        const res = await fetch(`/api/sessions/${sessionId}/transcript`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const body = await res.json();
        if (cancel) return;
        const segs = (body?.transcript?.segments ?? []) as Segment[];
        setSegments(segs);
        setLoading(false);
      } catch (err) {
        if (cancel) return;
        setError((err as Error).message);
        setLoading(false);
      }
    }
    void load();
    return () => { cancel = true; };
  }, [sessionId]);

  // ── Selección ─────────────────────────────────────────────────────
  function handleSegmentClick(e: React.MouseEvent, segIdx: number) {
    e.stopPropagation();
    const isMulti = e.altKey || e.metaKey || e.ctrlKey;
    const isRange = e.shiftKey && lastAnchor !== null;
    if (isRange) {
      const a = Math.min(lastAnchor, segIdx);
      const b = Math.max(lastAnchor, segIdx);
      const next = new Set(picked);
      for (let i = a; i <= b; i++) next.add(i);
      setPicked(next);
    } else if (isMulti) {
      const next = new Set(picked);
      if (next.has(segIdx)) next.delete(segIdx);
      else next.add(segIdx);
      setPicked(next);
      setLastAnchor(segIdx);
    } else {
      // Click solo: si ya estaba el único seleccionado, deseleccionar;
      // si no, reemplazar selección por este único.
      if (picked.size === 1 && picked.has(segIdx)) {
        setPicked(new Set());
        setLastAnchor(null);
      } else {
        setPicked(new Set([segIdx]));
        setLastAnchor(segIdx);
      }
    }
  }

  function clearSelection() {
    setPicked(new Set());
    setLastAnchor(null);
  }

  // ── Filtrado por búsqueda ─────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const filtered = q
    ? segments.filter((s) => s.text.toLowerCase().includes(q))
    : segments;

  // ── Construir texto de la selección ───────────────────────────────
  function buildSelectionText(): string {
    if (picked.size === 0) return '';
    const sorted = segments.filter((s) => picked.has(s.index));
    return sorted
      .map((s) => `[${fmtTs(s.start)}] ${s.text}`)
      .join('\n');
  }

  async function handleCopy() {
    const text = buildSelectionText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: fallar silenciosamente
    }
  }

  function handleAskLexa() {
    const text = buildSelectionText();
    if (!text || !sessionId) return;
    if (data.onAskLexa) {
      data.onAskLexa({
        context: text,
        sessionId,
        sessionTitle,
      });
    } else {
      // Fallback: copiar al clipboard y guiar al usuario
      void navigator.clipboard.writeText(text).catch(() => {});
      alert('Selección copiada. Pegala en el chat de Lexa para preguntarle sobre eso.');
    }
  }

  // ── Border + color ────────────────────────────────────────────────
  const ringClass = selected
    ? 'ring-2 ring-cl2-accent shadow-lg shadow-cl2-accent/20'
    : 'ring-1 ring-emerald-200/40 dark:ring-emerald-500/20';

  return (
    <div
      className={`flex h-full w-full flex-col rounded-xl border border-emerald-200/40 dark:border-emerald-500/20 bg-emerald-50/50 dark:bg-emerald-950/30 ${ringClass} overflow-hidden`}
      style={{ minHeight: 0 }}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0 !pointer-events-none" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0 !pointer-events-none" />

      {/* Header drag handle + title + delete */}
      <div className="flex shrink-0 items-start gap-2 border-b border-emerald-200/40 dark:border-emerald-500/20 bg-emerald-100/60 dark:bg-emerald-900/30 px-3 py-2 cursor-move">
        <div className="min-w-0 flex-1">
          <div className="font-display text-[14px] font-semibold text-emerald-900 dark:text-emerald-200 truncate">
            {data.title ?? sessionTitle}
          </div>
          {data.subtitle && (
            <div className="text-[11px] text-emerald-700/70 dark:text-emerald-300/60 truncate">
              {data.subtitle}
            </div>
          )}
        </div>
        {data.onDelete && (
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); data.onDelete?.(id); }}
            className="shrink-0 rounded p-1 text-emerald-700/50 hover:bg-emerald-200/40 hover:text-emerald-900 dark:text-emerald-300/40 dark:hover:bg-emerald-800/40 dark:hover:text-emerald-100"
            aria-label="Eliminar nodo"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {/* Toolbar de búsqueda + selección */}
      <div className="flex shrink-0 items-center gap-2 border-b border-emerald-200/40 dark:border-emerald-500/20 px-3 py-1.5 bg-white/60 dark:bg-emerald-950/20">
        <div className="relative flex-1 min-w-0">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-emerald-700/40 dark:text-emerald-300/40" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            placeholder="Buscar…"
            className="w-full rounded-md border border-emerald-200/50 dark:border-emerald-500/30 bg-white/80 dark:bg-emerald-950/40 pl-6 pr-2 py-1 text-[11px] text-emerald-900 dark:text-emerald-100 placeholder-emerald-600/40 dark:placeholder-emerald-300/30 focus:outline-none focus:border-cl2-accent/60"
          />
        </div>
        <span className="shrink-0 font-mono text-[10px] text-emerald-700/60 dark:text-emerald-300/60 tabular-nums">
          {picked.size > 0
            ? `${picked.size}/${filtered.length}`
            : `${filtered.length}${q ? `/${segments.length}` : ''}`}
        </span>
      </div>

      {/* Action bar — solo si hay selección */}
      {picked.size > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-emerald-200/40 dark:border-emerald-500/20 px-3 py-1.5 bg-emerald-100/50 dark:bg-emerald-900/40">
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); void handleCopy(); }}
            className="inline-flex items-center gap-1 rounded-md bg-white dark:bg-emerald-950/60 border border-emerald-300/40 dark:border-emerald-500/30 px-2 py-0.5 text-[11px] font-medium text-emerald-900 dark:text-emerald-100 hover:bg-emerald-50 dark:hover:bg-emerald-900/50"
          >
            <Copy size={10} /> {copied ? '¡Copiado!' : 'Copiar'}
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); handleAskLexa(); }}
            className="inline-flex items-center gap-1 rounded-md bg-cl2-burgundy/90 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-cl2-burgundy"
          >
            <MessageSquare size={10} /> Preguntar a Lexa
          </button>
          <span className="flex-1" />
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); clearSelection(); }}
            className="rounded p-0.5 text-emerald-700/50 hover:bg-emerald-200/40 hover:text-emerald-900 dark:text-emerald-300/40 dark:hover:bg-emerald-800/40 dark:hover:text-emerald-100"
            aria-label="Limpiar selección"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* Lista de segments con scroll interno */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-emerald-700/60 dark:text-emerald-300/60">
            <Loader2 size={12} className="animate-spin" /> Cargando transcripción…
          </div>
        )}
        {error && (
          <div className="px-3 py-6 text-center text-[12px] text-rose-700 dark:text-rose-300">
            No se pudo cargar la transcripción: {error}
          </div>
        )}
        {!loading && !error && filtered.length === 0 && q && (
          <div className="px-3 py-6 text-center text-[12px] text-emerald-700/60 dark:text-emerald-300/60">
            Sin coincidencias para "{search}".
          </div>
        )}
        {!loading && !error && filtered.map((seg) => {
          const isPicked = picked.has(seg.index);
          const ytDeepLink = youtubeId && seg.start > 0
            ? `https://www.youtube.com/watch?v=${youtubeId}&t=${Math.floor(seg.start)}s`
            : null;
          return (
            <div
              key={seg.index}
              onClick={(e) => handleSegmentClick(e, seg.index)}
              className={`flex gap-2 px-3 py-1.5 text-[12px] cursor-pointer border-b border-emerald-100/40 dark:border-emerald-800/30 transition-colors ${
                isPicked
                  ? 'bg-cl2-accent/20 dark:bg-cl2-accent/25'
                  : 'hover:bg-emerald-100/40 dark:hover:bg-emerald-900/30'
              }`}
            >
              <div className="shrink-0 pt-px">
                {ytDeepLink ? (
                  <a
                    href={ytDeepLink}
                    target="_blank"
                    rel="noopener"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="font-mono text-[10px] text-emerald-700/60 hover:text-emerald-900 hover:underline dark:text-emerald-300/60 dark:hover:text-emerald-100 tabular-nums"
                    title="Abrir en YouTube en este momento"
                  >
                    {fmtTs(seg.start)}
                  </a>
                ) : (
                  <span className="font-mono text-[10px] text-emerald-700/60 dark:text-emerald-300/60 tabular-nums">
                    {fmtTs(seg.start)}
                  </span>
                )}
              </div>
              <div className="min-w-0 flex-1 text-emerald-900 dark:text-emerald-100 leading-snug">
                {seg.text}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer con hint de selección */}
      <div className="shrink-0 border-t border-emerald-200/40 dark:border-emerald-500/20 px-3 py-1 bg-white/40 dark:bg-emerald-950/30 text-[10px] text-emerald-700/55 dark:text-emerald-300/55">
        Click: seleccionar · <kbd className="px-1 rounded bg-emerald-200/40 dark:bg-emerald-800/40">Alt</kbd>+click: agregar · <kbd className="px-1 rounded bg-emerald-200/40 dark:bg-emerald-800/40">Shift</kbd>+click: rango
      </div>
    </div>
  );
}
