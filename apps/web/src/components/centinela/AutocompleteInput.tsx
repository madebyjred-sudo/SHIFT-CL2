/**
 * AutocompleteInput — typeahead picker for the Centinela watchlist.
 *
 * Behavior:
 *   - 250ms debounce after every keystroke
 *   - Min 2 chars before querying (matches the backend bail-early rule)
 *   - Arrow keys + Enter to navigate / select
 *   - Escape to close
 *   - Free-text fallback: if the user types something the suggester can't
 *     match (e.g. an expediente number that's not in our SIL mirror) and
 *     hits Enter, we accept the raw value as `entity_id`. This matters
 *     because Centinela's mention scanner uses pg_trgm fuzzy match — the
 *     entity doesn't have to exist in our tables for the watch to work.
 *   - For type='tema' there's no suggester at all (free text only).
 *
 * Visual: dropdown stays inside the parent container. No portal — keeps
 * the focus trap simple and avoids z-index headaches in the sidebar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { autocomplete, type AutocompleteItem } from '@/services/centinelaApi';
import { cn } from '@/lib/utils';

interface Props {
  type: 'expediente' | 'diputado' | 'tema';
  value: string;
  onChange: (value: string) => void;
  /** Fires when the user picks a suggestion. Caller decides what to do
   *  with it (typically: call addToWatchlist + close the parent form). */
  onPick: (picked: { entity_id: string; label: string }) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function AutocompleteInput({
  type, value, onChange, onPick, placeholder, autoFocus,
}: Props) {
  const [items, setItems] = useState<AutocompleteItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const queryServer = useCallback(async (q: string) => {
    if (type === 'tema') return; // no suggester for free-text temas
    if (q.trim().length < 2) {
      setItems([]); setOpen(false); return;
    }
    setLoading(true);
    try {
      const result = await autocomplete(type, q);
      setItems(result);
      setOpen(result.length > 0);
      setActiveIdx(result.length > 0 ? 0 : -1);
    } catch {
      setItems([]); setOpen(false);
    } finally {
      setLoading(false);
    }
  }, [type]);

  // Debounce search 250ms after the last keystroke.
  useEffect(() => {
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => void queryServer(value), 250);
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    };
  }, [value, queryServer]);

  const accept = (it: AutocompleteItem) => {
    onPick({ entity_id: it.entity_id, label: it.label });
    setOpen(false);
    setItems([]);
  };

  // Free-text fallback: Enter without an active suggestion accepts the
  // raw string as both entity_id and label. Watchers can be created on
  // entities not in our tables (mention scanner uses fuzzy match).
  const acceptFreeText = () => {
    const v = value.trim();
    if (!v) return;
    onPick({ entity_id: v, label: v });
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#0e1745]/35 dark:text-white/30" />
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => items.length > 0 && setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (items.length === 0) return;
              setActiveIdx((i) => Math.min(i + 1, items.length - 1));
              setOpen(true);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIdx((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (open && activeIdx >= 0 && items[activeIdx]) accept(items[activeIdx]);
              else acceptFreeText();
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={placeholder ?? hintFor(type)}
          className="w-full pl-8 pr-8 py-1.5 rounded bg-white dark:bg-black/30 border border-black/10 dark:border-white/10 text-[12px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-cl2-burgundy/40"
        />
        {loading && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-[#0e1745]/40 dark:text-white/40 animate-spin" />
        )}
      </div>

      {open && items.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 max-h-72 overflow-y-auto rounded-lg bg-white dark:bg-[#161616] border border-black/10 dark:border-white/12 shadow-xl shadow-black/10 dark:shadow-black/40">
          {items.map((it, idx) => (
            <button
              key={`${it.entity_id}-${idx}`}
              onMouseDown={(e) => { e.preventDefault(); accept(it); }}
              onMouseEnter={() => setActiveIdx(idx)}
              className={cn(
                'w-full text-left px-3 py-2 transition-colors flex items-start gap-2',
                idx === activeIdx
                  ? 'bg-cl2-burgundy/10'
                  : 'hover:bg-black/3 dark:hover:bg-white/5',
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-[#0e1745] dark:text-white truncate">
                  {type === 'expediente' ? (
                    <>
                      <span className="font-mono text-cl2-burgundy">{it.entity_id}</span>
                      <span className="text-[#0e1745]/50 dark:text-white/50"> · </span>
                      <span>{truncate(it.label, 70)}</span>
                    </>
                  ) : (
                    it.label
                  )}
                </div>
                {it.hint && (
                  <div className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40 mt-0.5 truncate">
                    {it.hint}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function hintFor(t: 'expediente' | 'diputado' | 'tema'): string {
  if (t === 'expediente') return 'Empezá a escribir: "24.4" o "fiscal"';
  if (t === 'diputado') return 'Apellido: "Pérez", "Rodríguez"…';
  return 'fintech, transparencia, salud…';
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
