/**
 * Tiny toast + confirm system used throughout the admin console.
 *
 * Why not a library: the dependencies graph is already heavy. A toast
 * is 60 lines of context + a portal, and we only need 2 variants
 * (success / error) plus a synchronous confirm. No gesture support,
 * no stacking animations — that's fine for an admin tool.
 *
 * Usage:
 *   const { notify, confirm } = useToast();
 *   notify({ kind: 'success', text: 'Aprobado' });
 *   if (await confirm({ title: 'Borrar?', confirm: 'Borrar' })) { ... }
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle2, AlertTriangle, X } from 'lucide-react';

interface ToastNotification {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
  detail?: string;
}

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ToastApi {
  notify: (n: Omit<ToastNotification, 'id'>) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<ToastNotification[]>([]);
  const [pending, setPending] = useState<{
    opts: ConfirmOptions;
    resolve: (v: boolean) => void;
  } | null>(null);
  const idRef = useRef(0);

  const notify = useCallback((n: Omit<ToastNotification, 'id'>) => {
    const id = ++idRef.current;
    setNotes((cur) => [...cur, { ...n, id }]);
    // Auto-dismiss after 4s.
    setTimeout(() => {
      setNotes((cur) => cur.filter((x) => x.id !== id));
    }, 4000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotes((cur) => cur.filter((x) => x.id !== id));
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setPending({ opts, resolve });
      }),
    [],
  );

  const closeConfirm = useCallback(
    (value: boolean) => {
      if (!pending) return;
      pending.resolve(value);
      setPending(null);
    },
    [pending],
  );

  // Esc cancels the open confirm.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeConfirm(false);
      if (e.key === 'Enter') closeConfirm(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, closeConfirm]);

  const api = useMemo<ToastApi>(() => ({ notify, confirm }), [notify, confirm]);

  return (
    <ToastCtx.Provider value={api}>
      {children}

      {/* Toasts — bottom right */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex max-w-sm flex-col gap-2">
        {notes.map((n) => {
          const Icon = n.kind === 'error' ? AlertTriangle : CheckCircle2;
          const tone =
            n.kind === 'error'
              ? 'border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-200'
              : n.kind === 'info'
                ? 'border-blue-500/30 bg-blue-50 dark:bg-blue-500/10 text-blue-800 dark:text-blue-200'
                : 'border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-800 dark:text-emerald-200';
          return (
            <div
              key={n.id}
              className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] shadow-[0_8px_28px_rgba(14,23,69,0.10)] dark:shadow-[0_8px_28px_rgba(0,0,0,0.40)] backdrop-blur-md ${tone}`}
            >
              <Icon size={16} className="mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold leading-tight">{n.text}</div>
                {n.detail && (
                  <div className="mt-0.5 text-[12px] opacity-80">{n.detail}</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(n.id)}
                className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
                aria-label="Cerrar"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Confirm dialog — center */}
      {pending && (
        <div
          className="fixed inset-0 z-[201] flex items-center justify-center bg-[#0e1745]/40 dark:bg-black/60 backdrop-blur-sm"
          onClick={() => closeConfirm(false)}
        >
          <div
            className="mx-4 w-full max-w-sm rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] p-5 shadow-[0_24px_60px_rgba(14,23,69,0.18)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="font-display text-[19px] font-medium tracking-tight text-[#0e1745] dark:text-white">
              {pending.opts.title}
            </div>
            {pending.opts.description && (
              <div className="mt-2 text-[13px] leading-relaxed text-[#0e1745]/65 dark:text-white/65">
                {pending.opts.description}
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => closeConfirm(false)}
                className="rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-3.5 py-2 text-[12.5px] font-semibold text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10]"
              >
                {pending.opts.cancelLabel ?? 'Cancelar'}
              </button>
              <button
                type="button"
                onClick={() => closeConfirm(true)}
                className={
                  pending.opts.destructive
                    ? 'rounded-lg bg-rose-600 px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgba(239,68,68,0.30)] hover:bg-rose-700'
                    : 'rounded-lg bg-cl2-accent px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgba(249,53,73,0.22)] hover:bg-cl2-accent-hover'
                }
              >
                {pending.opts.confirmLabel ?? 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}
