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
import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeResizer, useReactFlow } from '@xyflow/react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  GripHorizontal, Trash2, Download, Mic, Palette, Check,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { updateNode, exportNode, type NodeColor, type WorkspaceNode } from '@/services/workspaceApi';
import { VoiceCaptureModal } from './VoiceCaptureModal';

// ─── Color themes ─────────────────────────────────────────────────────
const COLOR_THEMES: Record<NodeColor, { wrapper: string; header: string; dot: string }> = {
  default:  { wrapper: 'bg-white dark:bg-[#1c1c1c] border-black/8 dark:border-white/8',     header: 'bg-gray-50 dark:bg-white/[0.04]', dot: 'bg-gray-400' },
  burgundy: { wrapper: 'bg-[#7A3B47]/6 dark:bg-[#7A3B47]/15 border-[#7A3B47]/20',            header: 'bg-[#7A3B47]/8 dark:bg-[#7A3B47]/20', dot: 'bg-cl2-burgundy' },
  ink:      { wrapper: 'bg-[#0e1745]/5 dark:bg-[#0e1745]/20 border-[#0e1745]/15',            header: 'bg-[#0e1745]/6 dark:bg-[#0e1745]/25', dot: 'bg-[#0e1745]' },
  sage:     { wrapper: 'bg-emerald-50/80 dark:bg-emerald-950/20 border-emerald-200/40',       header: 'bg-emerald-50 dark:bg-emerald-950/30', dot: 'bg-emerald-500' },
  amber:    { wrapper: 'bg-amber-50/80 dark:bg-amber-950/20 border-amber-200/40',             header: 'bg-amber-50 dark:bg-amber-950/30',    dot: 'bg-amber-500' },
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
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [voiceAppendOpen, setVoiceAppendOpen] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialMd = (data.content as { md?: string } | undefined)?.md ?? '';

  // ── TipTap editor ────────────────────────────────────────────────
  const editor = useEditor({
    extensions: [StarterKit],
    content: initialMd
      ? `<p>${initialMd.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`
      : '',
    editorProps: {
      attributes: {
        class: 'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[120px] px-4 py-3 text-[13.5px] leading-relaxed',
      },
    },
    onUpdate: ({ editor }) => {
      scheduleSave({ md: editor.getText() });
    },
  });

  // ── Auto-save helper ─────────────────────────────────────────────
  const scheduleSave = useCallback((patch: Parameters<typeof updateNode>[2]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState('saving');
    saveTimer.current = setTimeout(async () => {
      try {
        await updateNode(workspaceId, id, patch);
        setSaveState('saved');
        setTimeout(() => setSaveState('idle'), 2000);
      } catch {
        setSaveState('idle');
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
          {/* Save indicator */}
          <span className={cn(
            'text-[10px] font-medium transition-opacity duration-300',
            saveState === 'idle' ? 'opacity-0' : 'opacity-100',
            saveState === 'saved' ? 'text-emerald-500' : 'text-[#0e1745]/40 dark:text-white/40',
          )}>
            {saveState === 'saving' ? 'guardando…' : saveState === 'saved' ? <Check className="w-3 h-3 inline" /> : ''}
          </span>

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

          {/* Voice append — push-to-record then append transcript to body */}
          <button
            onClick={(e) => { e.stopPropagation(); setVoiceAppendOpen(true); }}
            className="p-1.5 rounded-lg hover:bg-cl2-burgundy/10 dark:hover:bg-cl2-accent/15 transition-colors text-[#0e1745]/50 dark:text-white/50 hover:text-cl2-burgundy dark:hover:text-cl2-accent-soft"
            title="Agregar al body por voz"
          >
            <Mic className="w-3.5 h-3.5" />
          </button>

          {/* Export MD */}
          <button
            onClick={(e) => { e.stopPropagation(); exportNode(workspaceId, id, 'md').catch(() => null); }}
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
        className="flex-1 overflow-y-auto"
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
          scheduleSave({ content: { md: editor.getText() } });
        }}
      />
    </div>
  );
}
