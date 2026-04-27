/**
 * SilCitePickerModal — opened from the `/cite` slash command inside a hoja.
 *
 * The user types `/cite` (or `/cite dengue` to pre-seed the query), the
 * modal opens with a search bar and a result list. Picking an expediente
 * fires `onPick(item)` so the hoja editor inserts a citation chip:
 *
 *     [Exp. N° 23.583](/expediente/23583)
 *
 * The chip renders as a TipTap link (StarterKit's Link mark), so it's
 * clickable inside the editor AND inside the exported DOCX (where
 * `[text](url)` becomes a real Word hyperlink — see workspace.ts export).
 *
 * Why a modal vs an inline popup:
 *   - SIL search returns ~20-50 chars of metadata per result. A 280px
 *     suggestion popup truncates everything; a modal gives breathing room.
 *   - The user can browse and refine without losing the slash anchor.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Loader2, BookOpen } from 'lucide-react';
import { fetchSilExpedientes, type SilExpedienteListItem } from '@/services/silBrowseApi';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  initialQuery?: string;
  onClose: () => void;
  onPick: (item: SilExpedienteListItem) => void;
}

export function SilCitePickerModal({ open, initialQuery = '', onClose, onPick }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<SilExpedienteListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setSelectedIdx(0);
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, initialQuery]);

  // Debounced search
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchSilExpedientes({
          q: query.trim() || undefined,
          limit: 25,
          include_metadata: true,
        });
        setItems(res.items);
        setSelectedIdx(0);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open]);

  // Keyboard nav
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
        className="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#1c1c1c] border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-black/8 dark:border-white/8">
          <Search className="w-4 h-4 text-[#0e1745]/50 dark:text-white/50 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar expediente del SIL — número, título, proponente…"
            className="flex-1 bg-transparent text-[14px] text-[#0e1745] dark:text-white placeholder:text-black/30 dark:placeholder:text-white/30 focus:outline-none"
          />
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-cl2-burgundy" />}
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-[#0e1745]/40 dark:text-white/40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="px-4 py-6 text-center text-[12.5px] text-red-500">{error}</div>
          )}
          {!error && !loading && items.length === 0 && (
            <div className="px-4 py-12 text-center text-[12.5px] text-[#0e1745]/40 dark:text-white/30">
              <BookOpen className="w-6 h-6 mx-auto mb-2 opacity-40" />
              {query.trim() ? 'No hay coincidencias' : 'Empezá a escribir para buscar'}
            </div>
          )}
          {items.map((it, i) => (
            <button
              key={it.id}
              onMouseEnter={() => setSelectedIdx(i)}
              onClick={() => { onPick(it); onClose(); }}
              className={cn(
                'w-full text-left px-4 py-3 border-b border-black/5 dark:border-white/5 transition-colors',
                i === selectedIdx
                  ? 'bg-cl2-burgundy/8 dark:bg-cl2-burgundy/15'
                  : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]',
              )}
            >
              <div className="flex items-baseline gap-2 mb-0.5">
                <span className="text-[12px] font-mono tabular-nums font-semibold text-cl2-burgundy">
                  Exp. {it.numero}
                </span>
                {it.tipo && (
                  <span className="text-[10.5px] uppercase tracking-wider text-[#0e1745]/45 dark:text-white/40">
                    {it.tipo}
                  </span>
                )}
                {it.estado && (
                  <span className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40">
                    · {it.estado}
                  </span>
                )}
              </div>
              <p className="text-[13px] text-[#0e1745] dark:text-white leading-snug line-clamp-2">
                {it.titulo ?? '(Sin título)'}
              </p>
              {(it.proponente || it.comision) && (
                <p className="text-[11px] text-[#0e1745]/55 dark:text-white/45 mt-0.5 truncate">
                  {it.proponente && <span>{it.proponente}</span>}
                  {it.proponente && it.comision && ' · '}
                  {it.comision && <span>{it.comision}</span>}
                </p>
              )}
            </button>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-black/6 dark:border-white/8 bg-black/[0.02] dark:bg-white/[0.02] text-[10.5px] text-[#0e1745]/45 dark:text-white/35 flex items-center justify-between">
          <span>↑↓ navegar · ⏎ insertar · ESC cerrar</span>
          <span className="font-mono">{items.length} resultados</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
