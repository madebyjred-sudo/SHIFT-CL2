/**
 * WorkspacePickerModal — opened from the "Adjuntar" dropdown in AnimatedAiInput.
 *
 * Lists the user's active workspaces (via listWorkspaces(false)). Picking one
 * fires onPick(workspace) so the parent can call /api/workspace/:id/attach-context,
 * retrieve the full_md, and store it in attachedWorkspace context state.
 *
 * Style consistent with SilCitePickerModal.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layers, Loader2, X } from 'lucide-react';
import { listWorkspaces, type Workspace } from '@/services/workspaceApi';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (workspace: Workspace) => void;
}

export function WorkspacePickerModal({ open, onClose, onPick }: Props) {
  const [items, setItems] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Load workspaces when the modal opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setSelectedIdx(0);
    listWorkspaces(false)
      .then((ws) => setItems(ws))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [open]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, items.length - 1));
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      }
      if (e.key === 'Enter' && items[selectedIdx]) {
        e.preventDefault();
        onPick(items[selectedIdx]);
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, items, selectedIdx, onClose, onPick]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-start justify-center p-4 pt-[10vh] bg-black/40 backdrop-blur-sm animate-in fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-2xl bg-white dark:bg-[#1c1c1c] border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[60vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-black/8 dark:border-white/8">
          <Layers className="w-4 h-4 text-cl2-burgundy shrink-0" />
          <span className="flex-1 text-[14px] font-semibold text-[#0e1745] dark:text-white">
            Adjuntar workspace
          </span>
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-cl2-burgundy" />}
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-[#0e1745]/40 dark:text-white/40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-4 py-6 text-center text-[12.5px] text-red-500">{error}</div>
          )}
          {!error && !loading && items.length === 0 && (
            <div className="px-4 py-12 text-center text-[12.5px] text-[#0e1745]/40 dark:text-white/30">
              <Layers className="w-6 h-6 mx-auto mb-2 opacity-40" />
              No tenés workspaces activos
            </div>
          )}
          {items.map((ws, i) => (
            <button
              key={ws.id}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => { onPick(ws); onClose(); }}
              className={cn(
                'w-full text-left px-4 py-3 border-b border-black/5 dark:border-white/5 transition-colors',
                i === selectedIdx
                  ? 'bg-cl2-burgundy/8 dark:bg-cl2-burgundy/15'
                  : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]',
              )}
            >
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                  {ws.title}
                </span>
                <span className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40">
                  {ws.node_count} hoja{ws.node_count !== 1 ? 's' : ''}
                </span>
              </div>
              {ws.description && (
                <p className="text-[11.5px] text-[#0e1745]/55 dark:text-white/45 truncate">
                  {ws.description}
                </p>
              )}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-black/6 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.02] text-[10.5px] text-[#0e1745]/45 dark:text-white/35 flex items-center justify-between">
          <span>↑↓ navegar · ⏎ seleccionar · ESC cerrar</span>
          <span className="font-mono">{items.length} workspaces</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
