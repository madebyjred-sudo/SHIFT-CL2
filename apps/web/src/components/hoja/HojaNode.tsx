/**
 * HojaNode — custom ReactFlow node for the Workspace canvas.
 *
 * Each node is a "page" (hoja) with:
 *   - Draggable header bar (ReactFlow handles the drag natively via NodeDragHandle)
 *   - Editable title (Newsreader) and subtitle (Figtree)
 *   - TipTap rich-text body
 *   - Color theme switcher
 *   - Auto-save (debounced 800ms)
 *   - Export to MD / DOCX
 *   - Selection glow using cl2-accent ring
 *
 * No ReactFlow <Handle> edges — Phase 0 is a free-form board, not a DAG.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
// Format extensions used by the floating docx-style toolbar
// (HojaFormatMenu) and editor quality-of-life:
//   Underline / Highlight  — marks for subrayar + reteñir
//   Link                    — auto-link URLs + clickable anchors
//   TaskList / TaskItem     — interactive checkbox to-do lists
//   TextAlign               — left/center/right/justify on headings + paragraphs
//   Typography              — smart quotes, dashes, arrows ("..." → "…", "->" → →)
//   CharacterCount          — exposed via storage; future word-count UI
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import TextAlign from '@tiptap/extension-text-align';
import Typography from '@tiptap/extension-typography';
import CharacterCount from '@tiptap/extension-character-count';
import {
  GripHorizontal, Trash2, Download, Copy, Palette, Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { updateNode, exportNode, type NodeColor, type WorkspaceNode } from '@/services/workspaceApi';
import { VoiceCaptureModal } from './VoiceCaptureModal';
import { createSlashExtension, type SlashItem } from './HojaSlashExtension';
import { SilCitePickerModal } from './SilCitePickerModal';
import { LexaInlineModal, TEMPLATES, type TemplateKind } from './LexaInlineModal';
import type { Editor as TiptapEditor, Range as TiptapRange } from '@tiptap/react';

// ─── Color themes ─────────────────────────────────────────────────────
// `scrollbarVar` define el color del thumb del scrollbar interno del
// nodo. Sin esto el scrollbar nativo en macOS aparece blanco/gris
// fuerte y descansa visualmente desde el color de la hoja — feo,
// especialmente en hojas oscuras como ink/burgundy.
const COLOR_THEMES: Record<NodeColor, { wrapper: string; header: string; dot: string; scrollbar: string }> = {
  default:  { wrapper: 'bg-white dark:bg-[#1c1c1c] border-black/8 dark:border-white/8',     header: 'bg-gray-50 dark:bg-white/[0.04]', dot: 'bg-gray-400',     scrollbar: 'rgba(14,23,69,0.18)' },
  burgundy: { wrapper: 'bg-[#7A3B47]/6 dark:bg-[#7A3B47]/15 border-[#7A3B47]/20',            header: 'bg-[#7A3B47]/8 dark:bg-[#7A3B47]/20', dot: 'bg-cl2-burgundy', scrollbar: 'rgba(122,59,71,0.30)' },
  ink:      { wrapper: 'bg-[#0e1745]/5 dark:bg-[#0e1745]/20 border-[#0e1745]/15',            header: 'bg-[#0e1745]/6 dark:bg-[#0e1745]/25', dot: 'bg-[#0e1745]',    scrollbar: 'rgba(14,23,69,0.28)'  },
  sage:     { wrapper: 'bg-emerald-50/80 dark:bg-emerald-950/20 border-emerald-200/40',       header: 'bg-emerald-50 dark:bg-emerald-950/30', dot: 'bg-emerald-500',  scrollbar: 'rgba(16,128,96,0.28)' },
  amber:    { wrapper: 'bg-amber-50/80 dark:bg-amber-950/20 border-amber-200/40',             header: 'bg-amber-50 dark:bg-amber-950/30',    dot: 'bg-amber-500',    scrollbar: 'rgba(180,120,30,0.28)' },
};
const COLOR_LABELS: NodeColor[] = ['default', 'burgundy', 'ink', 'sage', 'amber'];

// ─── Props from ReactFlow ─────────────────────────────────────────────
interface HojaNodeData extends Partial<WorkspaceNode> {
  workspaceId: string;
  onDelete?: (nodeId: string) => void;
  onSelect?: (nodeId: string) => void;
}

export function HojaNode({ id, data, selected }: { id: string; data: HojaNodeData; selected?: boolean }) {
  const { workspaceId, onDelete, onSelect } = data;
  const { setNodes } = useReactFlow();

  // ── Local state ──────────────────────────────────────────────────
  const [title, setTitle] = useState(data.title ?? 'Sin título');
  const [subtitle, setSubtitle] = useState(data.subtitle ?? '');
  const [color, setColor] = useState<NodeColor>((data.color as NodeColor) ?? 'default');
  const [showPalette, setShowPalette] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Wall-clock of the last successful save. Drives the relative
  // "guardado hace 4 s" label below the header chrome — much more
  // legible than the previous tiny opacity-0 transition that the
  // user couldn't see actually firing.
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  // Tick state lifts a 1-Hz refresh on the relative-time label so
  // "hace 4 s" → "hace 5 s" without re-saving.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (lastSavedAt === null) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [lastSavedAt]);
  const [voiceAppendOpen, setVoiceAppendOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  // Slash command state — drives the SIL picker, the Lexa inline prompt
  // and the template picker. The pending range tracks where in the
  // editor the slash trigger fired so we can restore the cursor and
  // insert content at the right spot when a modal commits.
  const [silPickerOpen, setSilPickerOpen] = useState(false);
  const [lexaInlineOpen, setLexaInlineOpen] = useState(false);
  const [lexaAnchor, setLexaAnchor] = useState<{ top: number; left: number } | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const pendingEditorRef = useRef<TiptapEditor | null>(null);
  const pendingRangeRef = useRef<TiptapRange | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialMd = (data.content as { md?: string } | undefined)?.md ?? '';

  // ── Slash command runner ─────────────────────────────────────────
  // Wired into the TipTap extension via the factory below. Fired when
  // the user picks an item from the slash popup. We stash the editor +
  // range so modal commits can resume insertion at the right location.
  const runSlashCommand = useCallback((item: SlashItem, args: { editor: TiptapEditor; range: TiptapRange }) => {
    pendingEditorRef.current = args.editor;
    pendingRangeRef.current = args.range;

    if (item.key === 'cite') {
      setSilPickerOpen(true);
      return;
    }
    if (item.key === 'lexa') {
      // Capture the current caret rect for floating-popup anchoring
      const sel = window.getSelection();
      const r = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      setLexaAnchor(r ? { top: r.bottom + 6, left: r.left } : { top: 200, left: 200 });
      setLexaInlineOpen(true);
      return;
    }
    if (item.key === 'template') {
      setTemplatePickerOpen(true);
      return;
    }
    if (item.key === 'voz') {
      // Open the existing VoiceCaptureModal (append mode) so the user
      // can dictate and have the transcript inserted at the end of the
      // editor's content.
      setVoiceAppendOpen(true);
      return;
    }
    if (item.key === 'resumen' || item.key === 'expandir') {
      // Pull the entire current document as context, ask /transform to
      // either summarize it (resumen) or expand the last paragraph
      // (expandir). We re-use the pending range as the insert point.
      const ed = args.editor;
      const allText = ed.getText().trim();
      const lastPara = allText.split(/\n\s*\n/).pop() ?? allText;
      const action = item.key === 'resumen' ? 'summarize' : 'expand';
      const sourceText = item.key === 'resumen' ? allText : lastPara;
      if (!sourceText.trim()) {
        ed.chain().focus().insertContent('_(escribí algo primero para que Lexa pueda trabajar)_').run();
        return;
      }
      // Mark a placeholder while we wait, then replace
      ed.chain().focus().insertContent({ type: 'paragraph', content: [{ type: 'text', text: '⏳ Lexa está pensando…' }] }).run();
      const placeholderRange = ed.state.selection;
      import('@/services/workspaceApi').then(async ({ transformText }) => {
        try {
          const r = await transformText(workspaceId, { selection: sourceText, action });
          ed.chain().focus()
            .deleteRange({ from: placeholderRange.from - '⏳ Lexa está pensando…'.length - 1, to: placeholderRange.to })
            .insertContent({
              type: 'paragraph',
              content: [{ type: 'text', text: r.text }],
            })
            .run();
          // Save shape: API only accepts `content` at top level (the
          // PATCH allow-list rejects bare `md`). Plain getText also
          // strips marks/headings/lists — getHTML round-trips through
          // TipTap's parseHTML rules on next load.
          scheduleSave({ content: { md: ed.getHTML() } });
        } catch {
          // Leave the placeholder; user can manually edit
        }
      });
    }
  }, [workspaceId]);

  // The factory closes over `runSlashCommand` so we recreate the
  // extension if the callback identity changes. useMemo to avoid a new
  // extension instance per render (would re-init the suggestion plugin).
  const slashExtension = useMemo(() => createSlashExtension({ onRun: runSlashCommand }), [runSlashCommand]);

  // ── TipTap editor ────────────────────────────────────────────────
  const editor = useEditor({
    extensions: [
      StarterKit,
      slashExtension,
      Underline,
      // multicolor=true so each highlight click can set a different
      // color (yellow / green / pink / blue) via setHighlight({color}).
      Highlight.configure({ multicolor: true }),
      // Link: open in new tab + auto-link pasted URLs. We allow target
      // _blank so legislative source URLs open out-of-app cleanly.
      Link.configure({
        openOnClick: false, // editor click should NOT navigate (steals from typing)
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer nofollow' },
      }),
      // TextAlign applies textAlign attr to heading/paragraph nodes.
      // Toolbar wires keyboard equivalents via execCommand justify*.
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      // Task list: interactive checkboxes inside hojas. Useful for
      // action items / follow-ups in legislative briefings.
      TaskList,
      TaskItem.configure({ nested: true }),
      // Typography: smart-quote and arrow auto-replacements. Subtle
      // editorial polish ("..." → …, "->" → →, "(c)" → ©).
      Typography,
      // CharacterCount: exposes editor.storage.characterCount.{characters,words}.
      // No UI yet — keeping it loaded so a future "300-700 word" hint
      // can read the count without re-instantiating the editor.
      CharacterCount,
    ],
    content: initialMd
      ? `<p>${initialMd.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`
      : '',
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[120px] px-4 py-3 text-[13.5px] leading-relaxed',
      },
    },
    onUpdate: ({ editor }) => {
      // CRITICAL: this was the body-loss bug. Old shape was
      // `{ md: editor.getText() }` — top-level `md` is NOT in the
      // PATCH allow-list (server only accepts `content`), so every
      // edit was silently dropped server-side. Title/subtitle saved
      // because they ARE in the allow-list. Switch to:
      //   { content: { md: editor.getHTML() } }
      // - `content` lands in the JSONB column (allow-list keeps it).
      // - getHTML() preserves headings/marks/lists/highlights/links/
      //   tasks/text-align so a refresh round-trips the formatting,
      //   not just plain text.
      scheduleSave({ content: { md: editor.getHTML() } });
    },
  });

  // ── Auto-save helper ─────────────────────────────────────────────
  // Debounced 800ms — fast enough that the user sees "guardado" within
  // a second of pausing, slow enough to coalesce a rapid burst of
  // keystrokes into one PATCH. On success we also record `lastSavedAt`
  // so the header chrome can render "guardado hace N s" continuously
  // (not just a 2-second flash).
  const scheduleSave = useCallback((patch: Parameters<typeof updateNode>[2]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = setTimeout(async () => {
      try {
        await updateNode(workspaceId, id, patch);
        setSaveState('saved');
        setLastSavedAt(Date.now());
      } catch {
        setSaveState('error');
      }
    }, 800);
  }, [workspaceId, id]);

  // ── Sync title/subtitle edits to store + API ─────────────────────
  const handleTitleChange = (val: string) => {
    setTitle(val);
    setNodes((ns) => ns.map((n) => n.id === id ? { ...n, data: { ...n.data, title: val } } : n));
    scheduleSave({ title: val });
  };
  const handleSubtitleChange = (val: string) => {
    setSubtitle(val);
    scheduleSave({ subtitle: val });
  };
  const handleColorChange = async (c: NodeColor) => {
    setColor(c);
    setShowPalette(false);
    setNodes((ns) => ns.map((n) => n.id === id ? { ...n, data: { ...n.data, color: c } } : n));
    await updateNode(workspaceId, id, { color: c }).catch(() => null);
  };

  // ── Cleanup timer on unmount ──────────────────────────────────────
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const theme = COLOR_THEMES[color];

  return (
    <div
      onClick={() => onSelect?.(id)}
      className={cn(
        'rounded-2xl border shadow-sm transition-all duration-150 flex flex-col overflow-hidden',
        theme.wrapper,
        selected && 'ring-2 ring-cl2-accent shadow-lg shadow-cl2-accent/15',
      )}
      style={{ width: '100%', height: '100%' }}
    >
      {/* Resize handle provided by ReactFlow */}
      <NodeResizer minWidth={320} minHeight={220} isVisible={!!selected} lineClassName="border-cl2-accent/40" handleClassName="bg-cl2-accent border-white/60 rounded-sm" />

      {/* ── Header bar ──────────────────────────────────────────── */}
      <div className={cn('flex items-start gap-2 px-3 pt-3 pb-2 border-b border-inherit', theme.header)}>
        {/* Drag grip — ReactFlow uses cursor style automatically */}
        <div className="mt-0.5 cursor-grab active:cursor-grabbing text-black/25 dark:text-white/25 shrink-0">
          <GripHorizontal className="w-4 h-4" />
        </div>

        <div className="flex-1 min-w-0">
          {/* Title — Newsreader display font */}
          <input
            value={title}
            onChange={(e) => handleTitleChange(e.target.value)}
            placeholder="Sin título"
            className="w-full bg-transparent font-display text-[18px] font-semibold text-[#0e1745] dark:text-white placeholder:text-black/25 dark:placeholder:text-white/25 focus:outline-none leading-snug"
            onMouseDown={(e) => e.stopPropagation()} // prevent canvas drag
          />
          {/* Subtitle — Figtree */}
          <input
            value={subtitle}
            onChange={(e) => handleSubtitleChange(e.target.value)}
            placeholder="Subtítulo opcional…"
            className="w-full bg-transparent text-[12px] text-[#0e1745]/55 dark:text-white/45 placeholder:text-black/20 dark:placeholder:text-white/20 focus:outline-none mt-0.5 font-medium"
            onMouseDown={(e) => e.stopPropagation()}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Save indicator — visible whenever we have any save state.
              States:
                saving → "Guardando…" (burgundy, no icon)
                saved (with timestamp) → "✓ hace N s/m"
                error → "⚠ no guardó" (rose)
              The timestamp re-renders every second via the interval at
              the top of the component, so the user sees the freshness
              decay without re-saving. */}
          <SaveIndicator
            state={saveState}
            lastSavedAt={lastSavedAt}
          />

          {/* Color palette */}
          <div className="relative">
            <button
              onClick={(e) => { e.stopPropagation(); setShowPalette((v) => !v); }}
              className="p-1.5 rounded-lg hover:bg-black/8 dark:hover:bg-white/10 transition-colors text-[#0e1745]/50 dark:text-white/50"
              title="Color"
            >
              <Palette className="w-3.5 h-3.5" />
            </button>
            {showPalette && (
              <div className="absolute right-0 top-8 z-50 flex gap-1.5 p-2 rounded-xl bg-white dark:bg-[#1c1c1c] shadow-xl border border-black/8 dark:border-white/10">
                {COLOR_LABELS.map((c) => (
                  <button
                    key={c}
                    onClick={(e) => { e.stopPropagation(); handleColorChange(c); }}
                    title={c}
                    className={cn('w-5 h-5 rounded-full transition-transform hover:scale-110', COLOR_THEMES[c].dot, color === c && 'ring-2 ring-offset-1 ring-[#0e1745]/30 dark:ring-white/40')}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Copy body to clipboard. Voice dictation moved to slash command
              `/voz` inside the editor — keeps the header light and lets the
              user trigger voice exactly where they're already typing. */}
          <button
            onClick={async (e) => {
              e.stopPropagation();
              const text = editor?.getText() ?? '';
              try {
                await navigator.clipboard.writeText(text);
                setCopyState('copied');
                setTimeout(() => setCopyState('idle'), 1500);
              } catch { /* clipboard blocked — silent */ }
            }}
            className="p-1.5 rounded-lg hover:bg-black/8 dark:hover:bg-white/10 transition-colors text-[#0e1745]/50 dark:text-white/50"
            title={copyState === 'copied' ? '¡Copiado!' : 'Copiar contenido'}
          >
            {copyState === 'copied'
              ? <Check className="w-3.5 h-3.5 text-emerald-500" />
              : <Copy className="w-3.5 h-3.5" />}
          </button>

          {/* Export MD */}
          <button
            onClick={(e) => { e.stopPropagation(); exportNode(workspaceId, id, 'md', title).catch(() => null); }}
            className="p-1.5 rounded-lg hover:bg-black/8 dark:hover:bg-white/10 transition-colors text-[#0e1745]/50 dark:text-white/50"
            title="Exportar .md"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {/* Delete */}
          <button
            onClick={(e) => { e.stopPropagation(); onDelete?.(id); }}
            className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 transition-colors text-[#0e1745]/40 dark:text-white/40"
            title="Eliminar hoja"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── TipTap body ─────────────────────────────────────────── */}
      <div
        className="flex-1 overflow-y-auto hoja-scrollbar"
        style={
          {
            // Color del thumb del scrollbar matchea el theme del nodo.
            // CSS vars consumidas por las reglas .hoja-scrollbar en index.css.
            ['--hoja-scroll-thumb' as string]: theme.scrollbar,
          } as React.CSSProperties
        }
        onMouseDown={(e) => e.stopPropagation()} // let TipTap handle clicks
      >
        <EditorContent editor={editor} />
      </div>

      {/* ── Voice append modal ─────────────────────────────────── */}
      <VoiceCaptureModal
        open={voiceAppendOpen}
        onClose={() => setVoiceAppendOpen(false)}
        mode="append"
        onCommit={async ({ md }) => {
          if (!editor || !md.trim()) return;
          // Append paragraph at the end. TipTap's `insertContentAt` with
          // size pushes after current content; we keep the user's
          // existing markdown intact and just add a fresh block.
          editor.chain().focus('end').insertContent({
            type: 'paragraph',
            content: [{ type: 'text', text: md.trim() }],
          }).run();
          // Save right away so the user doesn't lose it on accidental
          // close (debounced auto-save would catch it anyway, but this
          // makes the "saved" indicator pop confirming the action).
          scheduleSave({ content: { md: editor.getHTML() } });
        }}
      />

      {/* ── /cite — SIL picker modal ────────────────────────────── */}
      <SilCitePickerModal
        open={silPickerOpen}
        onClose={() => setSilPickerOpen(false)}
        onPick={(it) => {
          const ed = pendingEditorRef.current ?? editor;
          if (!ed) return;
          // Insert a markdown-style link. StarterKit doesn't include the
          // Link mark by default but TipTap renders bracketed links as
          // plain text; the DOCX exporter parses [text](url) into proper
          // hyperlinks. Good enough for the demo. We could add the Link
          // extension later for in-editor click-to-open behavior.
          const numero = it.numero;
          const slug = numero.replace(/[^\d]/g, '');
          const text = `[Exp. N° ${numero}](/expediente/${slug})`;
          ed.chain().focus().insertContent({
            type: 'text',
            text: text + ' ',
          }).run();
          scheduleSave({ content: { md: ed.getHTML() } });
        }}
      />

      {/* ── /lexa — inline prompt modal ─────────────────────────── */}
      <LexaInlineModal
        workspaceId={workspaceId}
        open={lexaInlineOpen}
        anchor={lexaAnchor}
        onClose={() => setLexaInlineOpen(false)}
        onAccept={(text) => {
          const ed = pendingEditorRef.current ?? editor;
          if (!ed) return;
          ed.chain().focus().insertContent({
            type: 'paragraph',
            content: [{ type: 'text', text }],
          }).run();
          scheduleSave({ content: { md: ed.getHTML() } });
        }}
      />

      {/* ── /template — pre-canned skeleton picker ─────────────── */}
      {templatePickerOpen && (
        <div
          className="fixed inset-0 z-[260] flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
          onClick={() => setTemplatePickerOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white dark:bg-[#1c1c1c] border border-black/10 dark:border-white/10 shadow-2xl py-1"
            onClick={(e) => e.stopPropagation()}
          >
            {(Object.entries(TEMPLATES) as Array<[TemplateKind, typeof TEMPLATES[TemplateKind]]>).map(([key, tpl]) => (
              <button
                key={key}
                onClick={() => {
                  const ed = pendingEditorRef.current ?? editor;
                  if (!ed) return;
                  // Insert template as multiple paragraphs (split on blank lines)
                  const blocks = tpl.md.split(/\n\s*\n/).filter(Boolean);
                  const content = blocks.map((b) => ({
                    type: 'paragraph',
                    content: [{ type: 'text', text: b }],
                  }));
                  ed.chain().focus().insertContent(content).run();
                  scheduleSave({ content: { md: ed.getHTML() } });
                  setTemplatePickerOpen(false);
                }}
                className="w-full text-left px-4 py-3 hover:bg-cl2-burgundy/5 transition-colors border-b border-black/5 dark:border-white/5 last:border-0"
              >
                <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                  {tpl.label}
                </div>
                <div className="text-[11px] text-[#0e1745]/55 dark:text-white/45 mt-0.5">
                  {tpl.subtitle}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Save indicator ──────────────────────────────────────────────────
// Renders the auto-save status next to the hoja header. We keep this
// separate so the parent's render isn't a giant ternary and so the
// timestamp formatter is colocated with the consumer.
function SaveIndicator({
  state,
  lastSavedAt,
}: {
  state: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt: number | null;
}) {
  if (state === 'saving') {
    return (
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-cl2-burgundy/80 dark:text-[#d8a4ad]/85 px-1.5 py-0.5 rounded-md bg-cl2-burgundy/[0.06] dark:bg-cl2-accent/[0.10]">
        <span className="inline-block w-2 h-2 rounded-full bg-cl2-burgundy/60 animate-pulse" />
        Guardando…
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-rose-700 dark:text-rose-400 px-1.5 py-0.5 rounded-md bg-rose-50 dark:bg-rose-900/20"
        title="No se pudo guardar — reintenta editando o revisa tu conexión"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-rose-500" />
        No guardó
      </span>
    );
  }
  if (state === 'saved' && lastSavedAt !== null) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] font-medium text-emerald-700/85 dark:text-emerald-400/85"
        title={`Última escritura: ${new Date(lastSavedAt).toLocaleString('es-CR')}`}
      >
        <Check className="w-3 h-3" />
        Guardado · {formatRelativeAgo(lastSavedAt)}
      </span>
    );
  }
  // idle without a prior save — render nothing
  return null;
}

/**
 * "hace 5 s" / "hace 2 m" / "hace 1 h" — short relative format. We
 * cap the granularity at hours; anything older just shows the time.
 */
function formatRelativeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5)   return 'recién';
  if (sec < 60)  return `hace ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24)  return `hace ${hr} h`;
  return new Date(ts).toLocaleDateString('es-CR');
}
