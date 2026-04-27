/**
 * ContextMenu — lightweight right-click menu floated via portal.
 *
 * Why hand-rolled (no Radix, no shadcn):
 *   • The app already uses motion/react for all overlays — adding
 *     @radix-ui/react-context-menu would double-import animation
 *     primitives for one feature.
 *   • Radix's ContextMenu requires wrapping triggers, which is awkward
 *     when the trigger is a ReactFlow pane that already owns event
 *     handling. Imperative open() is a better fit here.
 *   • Submenu, checkbox items, etc. — not needed yet.
 *
 * Usage:
 *   const menu = useContextMenu();
 *   <div onContextMenu={(e) => { e.preventDefault(); menu.open(e.clientX, e.clientY, items); }} />
 *   {menu.element}
 *
 * Items can be plain entries, separators, or section headers. Disabled
 * items are still visible (greyed out) so the user knows the action
 * exists in this surface but isn't applicable right now.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';

export type ContextMenuItem =
  | {
      kind?: 'item';
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      onSelect: () => void | Promise<void>;
      disabled?: boolean;
      destructive?: boolean;
    }
  | { kind: 'separator' }
  | { kind: 'header'; label: string };

interface OpenState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const MENU_W = 224; // px — used for viewport clamping

export function useContextMenu() {
  const [state, setState] = useState<OpenState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const open = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    // Clamp to viewport so the menu doesn't render off-screen on the
    // bottom-right corner.
    const margin = 8;
    const cx = Math.min(x, window.innerWidth - MENU_W - margin);
    // Approximate height — we don't measure on every open since items
    // are short. 36px per item + 8px padding is a safe upper bound.
    const approxH = items.reduce((acc, it) => {
      if ('kind' in it && it.kind === 'separator') return acc + 9;
      if ('kind' in it && it.kind === 'header') return acc + 22;
      return acc + 32;
    }, 12);
    const cy = Math.min(y, window.innerHeight - approxH - margin);
    setState({ x: cx, y: cy, items });
  }, []);

  const close = useCallback(() => setState(null), []);

  // Close on Escape, on outside click, on scroll/resize, and on any
  // descendant click (handled per-item below). The capturing-phase
  // mousedown listener is intentional: a regular onClick on the menu
  // would fire AFTER the document mousedown that should close it.
  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) close();
    };
    const onCtx = (e: MouseEvent) => {
      // A second right-click anywhere should re-target the menu, not
      // double-render it. The surface that wants to re-open will call
      // open() again with new coords; we just close here.
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onScroll = () => close();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('contextmenu', onCtx, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('contextmenu', onCtx, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [state, close]);

  // AnimatePresence + createPortal: the portal must wrap the
  // <AnimatePresence>, NOT the other way around. AnimatePresence
  // tracks its children in the React tree for exit animations; if you
  // wrap createPortal around an AnimatePresence child, it can't see
  // the child through the portal boundary and the menu silently
  // never mounts. This was the bug — listener fired, state set,
  // render ran, but the portaled child wasn't materialized.
  const element = createPortal(
    <AnimatePresence>
      {state && (
          <motion.div
            ref={ref}
            key="ctx-menu"
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -2, scale: 0.97 }}
            transition={{ duration: 0.12, ease: [0.22, 1, 0.36, 1] }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
            style={{ top: state.y, left: state.x, width: MENU_W }}
            className="fixed z-[300] rounded-lg border border-[#0e1745]/[0.08] dark:border-white/[0.10] bg-white dark:bg-[#1c1c1c] py-1 shadow-[0_10px_30px_rgba(14,23,69,0.16),0_2px_8px_rgba(14,23,69,0.08)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.4)]"
            role="menu"
          >
            {state.items.map((item, i) => {
              if ('kind' in item && item.kind === 'separator') {
                return <div key={i} className="my-1 h-px bg-[#0e1745]/[0.06] dark:bg-white/[0.06]" />;
              }
              if ('kind' in item && item.kind === 'header') {
                return (
                  <div
                    key={i}
                    className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/45 dark:text-white/45"
                  >
                    {item.label}
                  </div>
                );
              }
              const it = item as Extract<ContextMenuItem, { onSelect: () => void | Promise<void> }>;
              return (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    if (it.disabled) return;
                    void it.onSelect();
                    close();
                  }}
                  className={cn(
                    'group flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] transition-colors',
                    it.disabled
                      ? 'text-[#0e1745]/30 dark:text-white/30 cursor-not-allowed'
                      : it.destructive
                      ? 'text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20'
                      : 'text-[#0e1745]/85 dark:text-white/85 hover:bg-cl2-burgundy/[0.06] dark:hover:bg-cl2-accent/[0.10] hover:text-[#0e1745] dark:hover:text-white',
                  )}
                >
                  {it.icon && (
                    <span className={cn(
                      'shrink-0',
                      it.disabled
                        ? 'text-current'
                        : it.destructive
                        ? 'text-rose-500 dark:text-rose-400'
                        : 'text-cl2-burgundy dark:text-[#d8a4ad]',
                    )}>
                      {it.icon}
                    </span>
                  )}
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.shortcut && (
                    <span className="shrink-0 text-[10.5px] tabular-nums text-[#0e1745]/40 dark:text-white/40 group-hover:text-[#0e1745]/60 dark:group-hover:text-white/60">
                      {it.shortcut}
                    </span>
                  )}
                </button>
              );
            })}
          </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );

  // `element` MUST be returned fresh each render (JSX closes over
  // current `state`). open/close are stable via useCallback.
  // Consumers should depend on `open`/`close` directly in their dep
  // arrays — NOT on the whole returned object.
  return { open, close, element, isOpen: state !== null };
}
