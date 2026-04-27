/**
 * HojaSelectionMenu — global floating menu for text selections inside hojas.
 *
 * Mounts ONCE in WorkspaceCanvasPage and listens to document-level selection
 * events. When the user highlights text inside any HojaNode's ProseMirror
 * editor, a small action bar appears anchored to the selection rect with:
 *
 *   • Reescribir   — formal legislative tone via MiniMax
 *   • Resumir      — 2-3 sentence digest
 *   • Expandir     — adds context/antecedents via Sonnet
 *   • Traducir     — to neutral CR Spanish (or polish if already es)
 *   • Preguntar    — opens custom prompt input (⌘K shortcut)
 *
 * Why GLOBAL instead of inside HojaNode:
 *   - Zero coupling to the editor instance — we work off DOM selections
 *   - Avoids editing HojaNode.tsx (another agent is touching it for podcast
 *     wiring; we don't want a merge conflict on the same file)
 *   - Single mount point handles N hojas on the canvas
 *
 * Replacement strategy:
 *   We use document.execCommand('insertText') to swap the selection. It is
 *   technically deprecated, but it remains the only API that propagates
 *   correctly through ProseMirror's DOM mutation observer in v3, keeping
 *   the editor's history + auto-save in sync. Modern alternatives
 *   (Range.deleteContents + insertNode) bypass PM and break undo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Loader2, Sparkles, Wand2, FileText, Languages,
  MessageSquareText, X, Check, ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { transformText, type TransformAction } from '@/services/workspaceApi';

const MAX_SELECTION_CHARS = 4000;
const MIN_SELECTION_CHARS = 4;     // ignore single-word fat-finger drags

type Mode = 'idle' | 'menu' | 'prompt' | 'transforming' | 'preview';

interface SelectionSnapshot {
  text: string;
  rect: DOMRect;
  range: Range;            // kept so we can replace exactly what was highlighted
}

interface Props {
  workspaceId: string;
  /** Optional — called when the user clicks "Preguntar a Lexa" so the parent
   *  can route the selection into the LexaContextPanel as a question. */
  onAskLexa?: (selectionText: string) => void;
  /** Optional — called when the user clicks "Hoja nueva con esto". */
  onCreateHojaFromSelection?: (selectionText: string) => void;
}

export function HojaSelectionMenu({ workspaceId, onAskLexa, onCreateHojaFromSelection }: Props) {
  const [snap, setSnap] = useState<SelectionSnapshot | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [transformPreview, setTransformPreview] = useState<string>('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // ── Detect selection inside a ProseMirror editor ────────────────────
  const captureSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      // Selection cleared — but DON'T close while we're showing prompt or
      // preview, because clicking inside our own menu collapses the
      // document selection.
      if (mode === 'menu') { setSnap(null); setMode('idle'); }
      return;
    }
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (text.length < MIN_SELECTION_CHARS) return;
    if (text.length > MAX_SELECTION_CHARS) return;

    // Walk up from the anchor to confirm we're inside a ProseMirror editor.
    // HojaNode mounts TipTap which renders a `.ProseMirror` contenteditable.
    let node: Node | null = range.startContainer;
    let inEditor = false;
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('ProseMirror')) {
        inEditor = true;
        break;
      }
      node = node.parentNode;
    }
    if (!inEditor) {
      if (mode === 'menu') { setSnap(null); setMode('idle'); }
      return;
    }

    const rect = range.getBoundingClientRect();
    setSnap({ text, rect, range: range.cloneRange() });
    if (mode === 'idle') setMode('menu');
  }, [mode]);

  useEffect(() => {
    const onSelect = () => {
      // Debounce: selection events fire rapidly during drag
      requestAnimationFrame(captureSelection);
    };
    document.addEventListener('selectionchange', onSelect);
    return () => document.removeEventListener('selectionchange', onSelect);
  }, [captureSelection]);

  // ── ⌘K shortcut: jump straight to prompt mode ───────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMetaK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (!isMetaK) return;
      // Only intercept if we have a current selection inside a hoja editor
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      let node: Node | null = range.startContainer;
      while (node) {
        if (node instanceof HTMLElement && node.classList.contains('ProseMirror')) {
          e.preventDefault();
          captureSelection();
          setMode('prompt');
          requestAnimationFrame(() => promptInputRef.current?.focus());
          return;
        }
        node = node.parentNode;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [captureSelection]);

  // ── Close on Escape ─────────────────────────────────────────────────
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mode !== 'idle') {
        setMode('idle');
        setSnap(null);
        setTransformPreview('');
        setError(null);
      }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [mode]);

  // ── Click outside closes menu ───────────────────────────────────────
  useEffect(() => {
    if (mode === 'idle') return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      // Clicking outside menu → close (but don't kill an active transform)
      if (mode === 'transforming') return;
      setMode('idle');
      setSnap(null);
      setTransformPreview('');
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [mode]);

  // ── Run transform → fetch → preview ─────────────────────────────────
  const runTransform = useCallback(async (action: TransformAction, instruction?: string) => {
    if (!snap) return;
    setMode('transforming');
    setError(null);
    try {
      const result = await transformText(workspaceId, {
        selection: snap.text,
        action,
        instruction,
      });
      setTransformPreview(result.text);
      setMode('preview');
    } catch (err) {
      setError((err as Error).message);
      setMode('menu');
    }
  }, [snap, workspaceId]);

  // ── Apply preview → swap the selection in the editor ────────────────
  const applyPreview = useCallback(() => {
    if (!snap || !transformPreview) return;
    // Restore the selection range we captured (the user may have clicked
    // elsewhere after the menu opened, collapsing the document selection)
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(snap.range);
    }
    // execCommand routes through ProseMirror's mutation observer →
    // editor's internal state stays consistent and auto-save fires.
    document.execCommand('insertText', false, transformPreview);
    setMode('idle');
    setSnap(null);
    setTransformPreview('');
  }, [snap, transformPreview]);

  if (!snap || mode === 'idle') return null;

  // ── Compute menu position ───────────────────────────────────────────
  // Anchor to the top-center of the selection rect, but flip below if
  // the selection is near the top of the viewport.
  const MENU_W = mode === 'preview' ? 420 : mode === 'prompt' ? 380 : 340;
  const MENU_H_ESTIMATE = mode === 'preview' ? 220 : 56;
  const padding = 12;
  let top = snap.rect.top - MENU_H_ESTIMATE - padding;
  let placement: 'top' | 'bottom' = 'top';
  if (top < 8) {
    top = snap.rect.bottom + padding;
    placement = 'bottom';
  }
  const centerX = snap.rect.left + snap.rect.width / 2;
  let left = centerX - MENU_W / 2;
  if (left < 8) left = 8;
  if (left + MENU_W > window.innerWidth - 8) left = window.innerWidth - MENU_W - 8;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[200] animate-in fade-in slide-in-from-bottom-1 duration-150"
      style={{ top, left, width: MENU_W }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* MENU mode: action chips */}
      {mode === 'menu' && (
        <div className="rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/10 dark:border-white/10 shadow-xl p-1 flex items-center gap-0.5">
          <ActionChip
            icon={<MessageSquareText className="w-3 h-3" />}
            label="Preguntar"
            onClick={() => { onAskLexa?.(snap.text); setMode('idle'); setSnap(null); }}
          />
          <Divider />
          <ActionChip
            icon={<Wand2 className="w-3 h-3" />}
            label="Reescribir"
            onClick={() => runTransform('rewrite')}
          />
          <ActionChip
            icon={<FileText className="w-3 h-3" />}
            label="Resumir"
            onClick={() => runTransform('summarize')}
          />
          <ActionChip
            icon={<Sparkles className="w-3 h-3" />}
            label="Expandir"
            onClick={() => runTransform('expand')}
            premium
          />
          <ActionChip
            icon={<Languages className="w-3 h-3" />}
            label="Traducir"
            onClick={() => runTransform('translate')}
          />
          <Divider />
          <ActionChip
            icon={<ArrowRight className="w-3 h-3" />}
            label="Hoja nueva"
            onClick={() => { onCreateHojaFromSelection?.(snap.text); setMode('idle'); setSnap(null); }}
          />
        </div>
      )}

      {/* PROMPT mode: ⌘K custom instruction */}
      {mode === 'prompt' && (
        <div className="rounded-xl bg-white dark:bg-[#1c1c1c] border border-cl2-burgundy/30 shadow-xl p-2 flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-cl2-burgundy shrink-0 ml-1" />
          <input
            ref={promptInputRef}
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customPrompt.trim()) {
                runTransform('custom', customPrompt.trim());
              }
            }}
            placeholder="Decile a Lexa qué hacer con esto…"
            className="flex-1 bg-transparent text-[13px] text-[#0e1745] dark:text-white placeholder:text-black/30 dark:placeholder:text-white/30 focus:outline-none"
          />
          <button
            onClick={() => runTransform('custom', customPrompt.trim())}
            disabled={!customPrompt.trim()}
            className="px-2 py-1 rounded-md bg-cl2-burgundy text-white text-[11px] font-semibold disabled:opacity-40 hover:bg-cl2-burgundy/90 transition-colors"
          >
            ⏎
          </button>
        </div>
      )}

      {/* TRANSFORMING mode: spinner */}
      {mode === 'transforming' && (
        <div className="rounded-xl bg-white dark:bg-[#1c1c1c] border border-cl2-burgundy/30 shadow-xl px-3 py-2 flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 text-cl2-burgundy animate-spin" />
          <span className="text-[12px] text-cl2-burgundy font-medium">Lexa está trabajando…</span>
        </div>
      )}

      {/* PREVIEW mode: show result + accept/reject */}
      {mode === 'preview' && (
        <div className="rounded-xl bg-white dark:bg-[#1c1c1c] border border-emerald-300/40 dark:border-emerald-700/40 shadow-xl overflow-hidden">
          <div className="px-3 py-2 bg-emerald-50/70 dark:bg-emerald-950/30 border-b border-emerald-200/40 dark:border-emerald-800/30 text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider">
            Propuesta de Lexa
          </div>
          <div className="px-3 py-2.5 max-h-[140px] overflow-y-auto">
            <p className="text-[12.5px] text-[#0e1745] dark:text-white whitespace-pre-wrap leading-relaxed">
              {transformPreview}
            </p>
          </div>
          <div className="px-2 py-1.5 bg-black/[0.02] dark:bg-white/[0.02] border-t border-black/5 dark:border-white/5 flex items-center justify-end gap-1">
            <button
              onClick={() => { setMode('idle'); setSnap(null); setTransformPreview(''); }}
              className="px-2 py-1 rounded-md text-[11px] text-[#0e1745]/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Descartar
            </button>
            <button
              onClick={applyPreview}
              className="px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold transition-colors flex items-center gap-1"
            >
              <Check className="w-3 h-3" /> Reemplazar
            </button>
          </div>
        </div>
      )}

      {/* Error banner — overlays current mode */}
      {error && mode === 'menu' && (
        <div className="mt-1 px-2 py-1 rounded-md bg-red-50 dark:bg-red-900/20 text-red-600 text-[10.5px] text-center">
          {error}
        </div>
      )}

      {/* Caret pointing to the selection */}
      {mode !== 'preview' && mode !== 'transforming' && (
        <div
          aria-hidden
          className={cn(
            'absolute left-1/2 -translate-x-1/2 w-2 h-2 rotate-45 bg-white dark:bg-[#1c1c1c] border-black/10 dark:border-white/10',
            placement === 'top' ? '-bottom-1 border-r border-b' : '-top-1 border-l border-t',
          )}
        />
      )}
    </div>,
    document.body,
  );
}

// ─── Sub-components ──────────────────────────────────────────────────

function ActionChip({
  icon, label, onClick, premium,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  premium?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2 py-1.5 rounded-lg flex items-center gap-1.5 text-[11px] font-medium transition-colors whitespace-nowrap',
        premium
          ? 'text-cl2-burgundy hover:bg-cl2-burgundy/10'
          : 'text-[#0e1745]/70 dark:text-white/70 hover:bg-black/5 dark:hover:bg-white/5 hover:text-[#0e1745] dark:hover:text-white',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-5 bg-black/8 dark:bg-white/10 mx-0.5" />;
}
