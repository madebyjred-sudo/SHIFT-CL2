/**
 * PptxResultModal — surfaces a generated Gamma deck without auto-downloading.
 *
 * UX rationale (2026-04-29 redesign):
 *   The previous flow auto-clicked an <a> after a 30-60s async block, which
 *   browsers treat as a popup (the user's click context is gone) and silently
 *   block. Result: the user thought "nothing happened."
 *
 *   This modal replaces auto-download with an explicit, hand-on-the-button
 *   moment. Two CTAs the user clicks themselves:
 *     1. "Abrir presentación"  → opens the editable Gamma deck in a new tab
 *     2. "Descargar .pptx"     → triggers the download (preserving click context)
 *
 *   Cost transparency lives in the footer: when the deck was generated, and
 *   a "Generar nueva versión" link to re-run if the workspace changed since.
 *
 * STATES:
 *   - 'loading'   spinner with phased progress copy (~30-60s typical)
 *   - 'ready'     two CTAs + cached/freshness info + "regenerate" link
 *   - 'error'     specific error copy with a retry CTA
 *
 * The modal is a pure controlled component: parent owns state and result.
 */
import { useEffect, useState } from 'react';
import { X, ExternalLink, Download, RefreshCw, Sparkles, AlertCircle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PptxExportResult } from '@/services/workspaceApi';

interface Props {
  open: boolean;
  onClose: () => void;
  state: 'loading' | 'ready' | 'error';
  /** When state='ready', the deck metadata. */
  result?: PptxExportResult;
  /** When state='error', the message to surface. */
  errorMessage?: string;
  /** When state='error', the Gamma error code (drives CTA copy). */
  errorCode?: string;
  /** Trigger a fresh generation (force=true). */
  onRegenerate?: () => void;
  /** Workspace label (shown in header). */
  workspaceTitle?: string;
}

export function PptxResultModal({
  open, onClose, state, result, errorMessage, errorCode, onRegenerate, workspaceTitle,
}: Props) {
  // Cycling progress copy — gives the user a sense of motion during the 30-60s
  // generation window. Phases roughly match Gamma's actual pipeline.
  const [phaseIdx, setPhaseIdx] = useState(0);
  const phases = [
    'Estructurando el contenido…',
    'Diseñando las cards…',
    'Generando imágenes…',
    'Renderizando el deck…',
    'Casi listo, exportando .pptx…',
  ];
  useEffect(() => {
    if (state !== 'loading') return;
    const interval = setInterval(() => {
      setPhaseIdx((i) => Math.min(i + 1, phases.length - 1));
    }, 12_000); // Advance every 12s; total ~60s coverage
    return () => clearInterval(interval);
  }, [state, phases.length]);

  // Reset phase on each new generation cycle
  useEffect(() => {
    if (state === 'loading') setPhaseIdx(0);
  }, [state]);

  if (!open) return null;

  // Format "generated X ago" — used in cached / fresh footer
  const generatedAgo = (() => {
    if (!result?.generatedAt) return null;
    const ms = Date.now() - new Date(result.generatedAt).getTime();
    const min = Math.round(ms / 60000);
    if (min < 1) return 'hace un momento';
    if (min === 1) return 'hace 1 minuto';
    if (min < 60) return `hace ${min} minutos`;
    const hr = Math.round(min / 60);
    if (hr === 1) return 'hace 1 hora';
    return `hace ${hr} horas`;
  })();

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex items-center justify-center"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal card */}
      <div
        className="relative w-full max-w-lg mx-4 bg-white dark:bg-[#161616] rounded-2xl shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-white/10">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-cl2-burgundy/10 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-4 h-4 text-cl2-burgundy" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white truncate">
                {state === 'loading' ? 'Generando presentación' :
                 state === 'ready'   ? 'Presentación lista' :
                                        'No se pudo generar'}
              </div>
              {workspaceTitle && (
                <div className="text-[11px] text-[#0e1745]/50 dark:text-white/50 truncate">
                  {workspaceTitle}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-[#0e1745]/60 dark:text-white/60"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────── */}
        <div className="px-5 py-6">
          {state === 'loading' && (
            <div className="flex flex-col items-center text-center gap-4 py-4">
              {/* Animated dots — minimal, no aggressive spinner */}
              <div className="flex gap-1.5">
                <div className="w-2 h-2 rounded-full bg-cl2-burgundy animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 rounded-full bg-cl2-burgundy animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 rounded-full bg-cl2-burgundy animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <div className="space-y-1.5">
                <div className="text-[14px] text-[#0e1745] dark:text-white/90 font-medium">
                  {phases[phaseIdx]}
                </div>
                <div className="text-[11px] text-[#0e1745]/50 dark:text-white/50">
                  Esto toma 30-60 segundos · Gamma diseña y exporta el .pptx
                </div>
              </div>
            </div>
          )}

          {state === 'ready' && result && (
            <div className="space-y-4">
              {/* Preview affordance — a real iframe to gamma.app would be
                  ideal, but Gamma doesn't always allow iframe embedding for
                  unauthenticated viewers. So we show a styled "open" card
                  that the user clicks to view. Click context preserved. */}
              <a
                href={result.gammaUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="block group rounded-xl border border-black/8 dark:border-white/10 hover:border-cl2-burgundy/40 dark:hover:border-cl2-burgundy/40 bg-gradient-to-br from-cl2-burgundy/5 to-transparent dark:from-cl2-burgundy/10 dark:to-transparent p-5 transition-all"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[#0e1745] dark:text-white">
                      Abrir presentación en Gamma
                    </div>
                    <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-0.5">
                      Editá, compartí o exportá desde el deck en gamma.app
                    </div>
                  </div>
                  <ExternalLink className="w-4 h-4 text-cl2-burgundy flex-shrink-0 group-hover:translate-x-0.5 transition-transform" />
                </div>
              </a>

              {/* Secondary: download .pptx */}
              <a
                href={result.url}
                download={result.filename}
                className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-black/3 dark:bg-white/5 hover:bg-black/6 dark:hover:bg-white/8 transition-colors border border-black/5 dark:border-white/8"
              >
                <div className="flex items-center gap-2.5">
                  <Download className="w-4 h-4 text-[#0e1745]/60 dark:text-white/60" />
                  <span className="text-[12px] text-[#0e1745]/80 dark:text-white/80 font-medium">
                    Descargar {result.filename}
                  </span>
                </div>
                <span className="text-[10px] text-[#0e1745]/40 dark:text-white/40">.pptx</span>
              </a>

              {/* Footer: freshness + regenerate link */}
              <div className="pt-2 flex items-center justify-between text-[11px]">
                <div className="flex items-center gap-1.5 text-[#0e1745]/50 dark:text-white/50">
                  <Clock className="w-3 h-3" />
                  {result.cached ? `Generado ${generatedAgo} (en caché)` : `Generado ${generatedAgo}`}
                </div>
                {onRegenerate && (
                  <button
                    onClick={onRegenerate}
                    className="flex items-center gap-1 text-cl2-burgundy hover:text-cl2-burgundy/80 transition-colors"
                  >
                    <RefreshCw className="w-3 h-3" />
                    Generar de nuevo
                  </button>
                )}
              </div>
            </div>
          )}

          {state === 'error' && (
            <div className="space-y-4">
              <div className="flex items-start gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-200/50 dark:border-red-900/30">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div className="space-y-1 min-w-0">
                  <div className="text-[13px] font-medium text-red-700 dark:text-red-300">
                    {errorCodeToTitle(errorCode)}
                  </div>
                  <div className="text-[11px] text-red-700/80 dark:text-red-300/80 leading-relaxed">
                    {errorCodeToHint(errorCode, errorMessage)}
                  </div>
                </div>
              </div>
              {onRegenerate && (
                <button
                  onClick={onRegenerate}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-cl2-burgundy text-white text-[13px] font-medium hover:bg-cl2-burgundy/90 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Reintentar
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Error copy mapper ─────────────────────────────────────────────────────────

function errorCodeToTitle(code?: string): string {
  switch (code) {
    case 'insufficient_credits': return 'Sin créditos en Gamma';
    case 'forbidden':            return 'Plan de Gamma no autoriza esto';
    case 'rate_limited':         return 'Demasiadas generaciones a la vez';
    case 'timeout':              return 'Gamma tardó demasiado';
    case 'auth':                 return 'Llave de Gamma inválida';
    case 'failed':               return 'Gamma reportó un error';
    case 'no_export_url':        return 'El deck se generó pero no exportó';
    default:                     return 'No se pudo generar la presentación';
  }
}

function errorCodeToHint(code?: string, raw?: string): string {
  switch (code) {
    case 'insufficient_credits':
      return 'Recargá créditos en gamma.app/account/credits y volvé a intentar.';
    case 'forbidden':
      return 'Esta función requiere plan Pro/Teams en Gamma. Verificá la suscripción.';
    case 'rate_limited':
      return 'Esperá un minuto y reintentá. Gamma limita la cantidad de generaciones simultáneas.';
    case 'timeout':
      return 'La generación pasó los 5 minutos. Probá con menos hojas o reintentá en unos minutos.';
    case 'auth':
      return 'La GAMMA_API_KEY del backend no es válida. Avisá al equipo técnico.';
    case 'failed':
      return raw ? `Gamma dijo: ${raw}` : 'El servicio de Gamma rechazó este deck. Intentá con otro contenido o reintentá.';
    case 'no_export_url':
      return 'El deck quedó creado en gamma.app pero la URL de descarga no llegó. Reintentá.';
    default:
      return raw ?? 'Algo falló en la conexión con Gamma. Reintentá en unos segundos.';
  }
}

export function classNames(...args: Parameters<typeof cn>): string {
  return cn(...args);
}
