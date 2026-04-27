/**
 * HojaSlashExtension — TipTap slash-command system for hoja editors.
 *
 * Type `/` at the start of a line and a popup appears with commands:
 *
 *   /cite          — open SIL picker → insert citation chip linking to /expediente/:numero
 *   /lexa <prompt> — inline prompt → Lexa writes the answer at the cursor
 *   /resumen       — Lexa generates an executive summary skeleton
 *   /expandir      — Lexa fleshes out the current paragraph
 *   /template      — pre-canned structure (analísis de proyecto / comparativo / cronología)
 *
 * Architecture:
 *   - The TipTap Node extension uses @tiptap/suggestion for the trigger
 *     plumbing (`/` char, range tracking, command exec).
 *   - The popup itself is a React component rendered via portal — we use
 *     TipTap's `clientRect` to anchor it to the caret.
 *
 * Why a separate file from HojaNode:
 *   - HojaNode was just touched by the parallel agent. We minimize merge
 *     surface by keeping all slash logic here and making HojaNode add
 *     just one entry to its `extensions: []` array.
 */
import { Extension } from '@tiptap/react';
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion';
import type { Editor, Range } from '@tiptap/react';
import { ReactRenderer } from '@tiptap/react';
import { useEffect, useImperativeHandle, useState, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Sparkles, BookOpen, FileText, Wand2, Layers, Search, Mic,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Command catalog ──────────────────────────────────────────────────
//
// `run` is wired up at consumer-time (HojaNode) because some commands need
// access to React state that lives outside the editor (modals, transform
// endpoint, etc). The extension only knows the menu shape — the actual
// execution is plumbed via the `onRun` callback the consumer passes in.

export type SlashCommandKey = 'cite' | 'lexa' | 'resumen' | 'expandir' | 'template' | 'voz';

export interface SlashItem {
  key: SlashCommandKey;
  title: string;
  subtitle: string;
  Icon: React.ComponentType<{ className?: string }>;
  premium?: boolean;
}

const CATALOG: SlashItem[] = [
  {
    key: 'cite',
    title: 'Citar expediente',
    subtitle: 'Buscá un proyecto del SIL e insertalo como referencia',
    Icon: BookOpen,
  },
  {
    key: 'lexa',
    title: 'Pedile a Lexa',
    subtitle: 'Inline prompt — Lexa escribe acá mismo',
    Icon: Sparkles,
  },
  {
    key: 'resumen',
    title: 'Generar resumen ejecutivo',
    subtitle: 'Lexa arma una estructura ejecutiva del tema actual',
    Icon: FileText,
    premium: true,
  },
  {
    key: 'expandir',
    title: 'Expandir párrafo',
    subtitle: 'Lexa profundiza con contexto y antecedentes',
    Icon: Wand2,
    premium: true,
  },
  {
    key: 'template',
    title: 'Insertar plantilla',
    subtitle: 'Análisis de proyecto · Comparativo · Cronología',
    Icon: Layers,
  },
  {
    key: 'voz',
    title: 'Dictar por voz',
    subtitle: 'Grabá audio y se inserta como texto al final',
    Icon: Mic,
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return CATALOG;
  return CATALOG.filter(
    (it) => it.key.includes(q) || it.title.toLowerCase().includes(q),
  );
}

// ─── Popup component ──────────────────────────────────────────────────

interface PopupHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface PopupProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
  clientRect: (() => DOMRect | null) | null;
}

const SlashPopup = forwardRef<PopupHandle, PopupProps>(({ items, command, clientRect }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => setSelectedIndex(0), [items]);

  // Track caret position for the popup anchor. ReactRenderer calls
  // updateProps on every keystroke, but the clientRect closure stays
  // fresh, so we re-measure on each render.
  useEffect(() => {
    const r = clientRect?.();
    if (r) {
      setPos({ top: r.bottom + 6, left: r.left });
    }
  }, [clientRect, items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowDown') {
        setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelectedIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1));
        return true;
      }
      if (event.key === 'Enter') {
        if (items[selectedIndex]) command(items[selectedIndex]);
        return true;
      }
      return false;
    },
  }));

  if (!pos || items.length === 0) {
    if (!pos) return null;
    return createPortal(
      <div
        className="fixed z-[250] rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/10 dark:border-white/10 shadow-xl px-3 py-2 text-[12px] text-[#0e1745]/45 dark:text-white/40"
        style={{ top: pos.top, left: pos.left }}
      >
        <Search className="w-3 h-3 inline mr-1.5" />
        Sin coincidencias
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className="fixed z-[250] rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/10 dark:border-white/10 shadow-xl py-1 min-w-[280px] max-w-[340px] overflow-hidden"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()} // keep editor focus
    >
      {items.map((item, i) => {
        const Icon = item.Icon;
        return (
          <button
            key={item.key}
            onClick={() => command(item)}
            onMouseEnter={() => setSelectedIndex(i)}
            className={cn(
              'w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors',
              i === selectedIndex
                ? 'bg-cl2-burgundy/10 dark:bg-cl2-burgundy/20'
                : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
            )}
          >
            <div className={cn(
              'shrink-0 w-7 h-7 rounded-lg flex items-center justify-center mt-0.5',
              item.premium ? 'bg-cl2-burgundy/15 text-cl2-burgundy' : 'bg-black/5 dark:bg-white/8 text-[#0e1745]/70 dark:text-white/70',
            )}>
              <Icon className="w-3.5 h-3.5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                  {item.title}
                </span>
                {item.premium && (
                  <span className="text-[9px] font-bold uppercase tracking-wider text-cl2-burgundy">
                    AI
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[#0e1745]/50 dark:text-white/40 leading-snug truncate">
                {item.subtitle}
              </p>
            </div>
          </button>
        );
      })}
    </div>,
    document.body,
  );
});
SlashPopup.displayName = 'SlashPopup';

// ─── Extension factory ────────────────────────────────────────────────
//
// Why a factory: the consumer needs to inject `onRun` so that picking a
// command triggers React state changes outside the editor (open modal,
// run transform, etc). The factory closes over that callback and returns
// the configured extension.

export interface SlashExtensionOptions {
  onRun: (item: SlashItem, args: { editor: Editor; range: Range }) => void;
}

export function createSlashExtension({ onRun }: SlashExtensionOptions) {
  return Extension.create({
    name: 'hojaSlash',

    addOptions() {
      return {
        suggestion: {
          char: '/',
          startOfLine: false,
          allowSpaces: false,
          command: ({ editor, range, props }: { editor: Editor; range: Range; props: { item: SlashItem } }) => {
            // Delete the "/query" trigger first so the inserted content
            // doesn't include it. The actual content insertion happens
            // inside `onRun` below (some commands open modals first).
            editor.chain().focus().deleteRange(range).run();
            onRun(props.item, { editor, range });
          },
        } as Partial<SuggestionOptions>,
      };
    },

    addProseMirrorPlugins() {
      return [
        Suggestion({
          editor: this.editor,
          ...this.options.suggestion,
          items: ({ query }: { query: string }) => filterItems(query),
          render: () => {
            let renderer: ReactRenderer<PopupHandle> | null = null;

            return {
              onStart: (props) => {
                renderer = new ReactRenderer(SlashPopup, {
                  props: {
                    items: props.items,
                    command: (item: SlashItem) => props.command({ item }),
                    clientRect: props.clientRect ?? null,
                  },
                  editor: props.editor,
                });
              },
              onUpdate: (props) => {
                renderer?.updateProps({
                  items: props.items,
                  command: (item: SlashItem) => props.command({ item }),
                  clientRect: props.clientRect ?? null,
                });
              },
              onKeyDown: (props) => {
                if (props.event.key === 'Escape') {
                  renderer?.destroy();
                  return true;
                }
                return renderer?.ref?.onKeyDown(props) ?? false;
              },
              onExit: () => {
                renderer?.destroy();
                renderer = null;
              },
            };
          },
        }),
      ];
    },
  });
}
