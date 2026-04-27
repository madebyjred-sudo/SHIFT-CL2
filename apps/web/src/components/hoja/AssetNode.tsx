/**
 * AssetNode — ReactFlow node for imported image/audio/document files.
 *
 * Three render shapes (auto-routed by `data.type`):
 *   • image    → object-cover preview, click to enlarge
 *   • audio    → native <audio> player + filename + size
 *   • document → icon card with "Abrir" link (PDFs/DOCXs open in new tab)
 *
 * All three share:
 *   - NodeResizer when selected
 *   - Header with filename + delete button
 *   - Color accent bar (mirror of HojaNode tokens)
 *   - Click → onSelect(id) so the LexaContextPanel can attach context
 *
 * Why a SEPARATE component (instead of extending HojaNode):
 *   - HojaNode is being modified by another agent (podcast wiring) — we
 *     keep all merge surface zero by writing this as a sibling.
 *   - Asset nodes don't need TipTap, so 90% of HojaNode is irrelevant.
 */
import { useCallback, useState } from 'react';
import { NodeResizer } from '@xyflow/react';
import {
  GripVertical, Trash2, FileText, FileType, Music,
  ExternalLink, Maximize2, X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AssetContent, NodeColor, WorkspaceNode } from '@/services/workspaceApi';

const COLOR_ACCENTS: Record<NodeColor, string> = {
  default:  'border-cl2-accent/15',
  burgundy: 'border-cl2-burgundy/30',
  ink:      'border-[#0e1745]/30',
  sage:     'border-emerald-500/30',
  amber:    'border-amber-500/30',
};

interface AssetNodeData extends WorkspaceNode {
  workspaceId: string;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}

export function AssetNode({
  id, data, selected,
}: { id: string; data: AssetNodeData; selected?: boolean }) {
  const content = data.content as AssetContent;
  const url = content?.url;
  const filename = content?.filename ?? data.title ?? 'archivo';
  const sizeKB = content?.size ? `${(content.size / 1024).toFixed(0)} KB` : '';
  const accent = COLOR_ACCENTS[data.color] ?? COLOR_ACCENTS.default;
  const [showLightbox, setShowLightbox] = useState(false);

  const handleClick = useCallback(() => data.onSelect(id), [data, id]);
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    data.onDelete(id);
  }, [data, id]);

  return (
    <>
      <div
        onClick={handleClick}
        className={cn(
          'relative flex flex-col rounded-2xl border bg-white dark:bg-[#1a1a1a] shadow-sm transition-all duration-150 overflow-hidden',
          accent,
          selected && 'ring-2 ring-cl2-accent shadow-lg shadow-cl2-accent/15',
        )}
        style={{ width: '100%', height: '100%' }}
      >
        <NodeResizer minWidth={200} minHeight={120} isVisible={selected} />

        {/* ── Header (drag handle + delete) ─────────────────────── */}
        <div
          className="drag-handle flex items-center justify-between px-3 pt-2 pb-1.5 cursor-grab active:cursor-grabbing border-b border-black/5 dark:border-white/5"
          data-drag-handle
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <GripVertical className="w-3.5 h-3.5 text-black/20 dark:text-white/20 shrink-0" />
            {data.type === 'image' && <FileType className="w-3 h-3 text-cl2-burgundy/70 shrink-0" />}
            {data.type === 'audio' && <Music className="w-3 h-3 text-cl2-burgundy/70 shrink-0" />}
            {data.type === 'document' && <FileText className="w-3 h-3 text-cl2-burgundy/70 shrink-0" />}
            <span className="text-[11px] font-medium text-[#0e1745]/70 dark:text-white/70 truncate">
              {filename}
            </span>
          </div>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={handleDelete}
            className="p-1 rounded-md hover:bg-black/8 dark:hover:bg-white/10 text-black/30 dark:text-white/30 hover:text-red-500 transition-colors shrink-0"
            title="Eliminar"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>

        {/* ── Body — type-aware ─────────────────────────────────── */}
        <div className="nodrag flex-1 min-h-0 overflow-hidden flex flex-col" onMouseDown={(e) => e.stopPropagation()}>
          {data.type === 'image' && url && (
            <div className="relative flex-1 min-h-0 group">
              <img
                src={url}
                alt={filename}
                className="w-full h-full object-cover"
                draggable={false}
              />
              <button
                onClick={(e) => { e.stopPropagation(); setShowLightbox(true); }}
                className="absolute top-2 right-2 p-1.5 rounded-md bg-black/40 hover:bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                title="Ampliar"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {data.type === 'audio' && url && (
            <div className="flex-1 flex flex-col gap-2 px-3 py-3 justify-center">
              <audio
                controls
                src={url}
                className="w-full h-9"
                style={{ accentColor: '#7A3B47' }}
              />
              {sizeKB && (
                <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40 text-center font-mono">
                  {sizeKB}
                </p>
              )}
            </div>
          )}

          {data.type === 'document' && url && (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 py-3 text-center">
              <div className="w-12 h-14 rounded-md bg-cl2-burgundy/10 flex items-center justify-center border border-cl2-burgundy/20">
                <FileText className="w-6 h-6 text-cl2-burgundy" />
              </div>
              <p className="text-[12px] font-medium text-[#0e1745] dark:text-white truncate w-full">
                {filename}
              </p>
              {sizeKB && (
                <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40 font-mono">
                  {sizeKB}
                </p>
              )}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="mt-1 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cl2-burgundy/10 hover:bg-cl2-burgundy/20 text-cl2-burgundy text-[11px] font-semibold transition-colors"
              >
                Abrir <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}

          {!url && (
            <div className="flex-1 flex items-center justify-center text-[11px] text-[#0e1745]/40 dark:text-white/30">
              Asset sin URL
            </div>
          )}
        </div>
      </div>

      {/* ── Lightbox for images ────────────────────────────────── */}
      {showLightbox && url && (
        <div
          className="fixed inset-0 z-[300] bg-black/85 flex items-center justify-center p-8 animate-in fade-in"
          onClick={() => setShowLightbox(false)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <img src={url} alt={filename} className="max-w-full max-h-full object-contain" />
          <button
            onClick={(e) => { e.stopPropagation(); setShowLightbox(false); }}
            className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}
    </>
  );
}
