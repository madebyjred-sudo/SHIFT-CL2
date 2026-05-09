/**
 * ShareAsProgressToast — fixed-position toast that narrates the asset-
 * generation phases. Cosmetic: the backend is one round-trip, but the
 * user sees motion + readable phase labels so the wait feels intentional.
 *
 * Mounts when the parent kicks `exportAsset()`; unmounts when the asset
 * lands (or errors). Phase auto-advances on a timer; if the actual API
 * call finishes before "subiendo" runs, the parent unmounts the toast
 * which is fine — the user only ever sees forward motion.
 */
import { useEffect, useState } from 'react';
import { Loader2, X, Check, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GeneratedAssetKind } from '@/services/workspaceApi';

type Phase = 'structuring' | 'rendering' | 'uploading' | 'done' | 'error';

const PHASE_LABELS: Record<GeneratedAssetKind, Record<Exclude<Phase, 'done' | 'error'>, string>> = {
  carousel: {
    structuring: 'Estructurando slides…',
    rendering:   'Renderizando carrusel…',
    uploading:   'Subiendo a CL2…',
  },
  pptx_asset: {
    structuring: 'Componiendo guion…',
    rendering:   'Generando deck Gamma…',
    uploading:   'Listo para descargar…',
  },
  docx_asset: {
    structuring: 'Estructurando documento…',
    rendering:   'Maquetando A4…',
    uploading:   'Empaquetando .docx…',
  },
  podcast_asset: {
    structuring: 'Escribiendo guion…',
    rendering:   'Sintetizando voz…',
    uploading:   'Mezclando audio…',
  },
};

interface Props {
  open: boolean;
  kind: GeneratedAssetKind | null;
  /** When true, the toast collapses into a "listo" state then unmounts. */
  done?: boolean;
  /** Error message — flips toast into a rose/alert state. */
  error?: string | null;
  onDismiss?: () => void;
}

export function ShareAsProgressToast({ open, kind, done, error, onDismiss }: Props) {
  const [phase, setPhase] = useState<Phase>('structuring');

  // Reset to "structuring" each time the toast opens fresh.
  useEffect(() => {
    if (!open) return;
    setPhase('structuring');
    const t1 = setTimeout(() => setPhase('rendering'), 1200);
    const t2 = setTimeout(() => setPhase('uploading'), 3000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [open, kind]);

  // External signals can override the phase.
  useEffect(() => {
    if (done) setPhase('done');
    if (error) setPhase('error');
  }, [done, error]);

  // Auto-dismiss the "done" pill after 1.5s
  useEffect(() => {
    if (phase !== 'done') return;
    const t = setTimeout(() => onDismiss?.(), 1500);
    return () => clearTimeout(t);
  }, [phase, onDismiss]);

  if (!open || !kind) return null;

  const label = phase === 'done'
    ? 'Listo en el canvas'
    : phase === 'error'
      ? error ?? 'No se pudo generar'
      : PHASE_LABELS[kind][phase];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed z-[200] bottom-6 right-6 max-w-sm',
        'rounded-2xl border shadow-2xl px-4 py-3 flex items-center gap-3 backdrop-blur',
        phase === 'error'
          ? 'bg-rose-50/95 dark:bg-rose-950/85 border-rose-300 text-rose-900 dark:text-rose-100'
          : phase === 'done'
            ? 'bg-emerald-50/95 dark:bg-emerald-950/85 border-emerald-300 text-emerald-900 dark:text-emerald-100'
            : 'bg-white/95 dark:bg-[#1c1c1c]/95 border-cl2-burgundy/25 text-[#0e1745] dark:text-white',
      )}
    >
      <div className="shrink-0">
        {phase === 'error' ? (
          <AlertTriangle className="w-4 h-4" />
        ) : phase === 'done' ? (
          <Check className="w-4 h-4" />
        ) : (
          <Loader2 className="w-4 h-4 animate-spin text-cl2-burgundy" />
        )}
      </div>
      <div className="min-w-0">
        <p className="font-display italic text-[13px] leading-tight">
          {phase === 'error' ? 'Falló la generación' : phase === 'done' ? 'Atlas terminó' : 'Atlas está armando tu artefacto'}
        </p>
        <p className="text-[11px] font-mono uppercase tracking-[0.14em] opacity-75 mt-0.5 truncate">
          {label}
        </p>
        {/* Progress strip — stages reflected as 3 dots */}
        {phase !== 'error' && phase !== 'done' && (
          <div className="mt-1.5 flex items-center gap-1">
            {(['structuring', 'rendering', 'uploading'] as const).map((p, i) => {
              const order = ['structuring', 'rendering', 'uploading'];
              const cur = order.indexOf(phase);
              const isDone = i < cur;
              const isActive = i === cur;
              return (
                <span
                  key={p}
                  className={cn(
                    'h-[2px] flex-1 rounded-full transition-colors',
                    isDone   ? 'bg-cl2-burgundy/85' :
                    isActive ? 'bg-cl2-burgundy/70 animate-pulse' :
                               'bg-black/15 dark:bg-white/15',
                  )}
                />
              );
            })}
          </div>
        )}
      </div>
      {(phase === 'error' || phase === 'done') && (
        <button
          onClick={onDismiss}
          className="shrink-0 p-1 rounded-md hover:bg-black/10 dark:hover:bg-white/15 transition-colors"
          aria-label="Cerrar"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
