/**
 * ShareAsButton — "Compartir como ▾" dropdown for the workspace canvas.
 *
 * Lives in the canvas top-right toolbar, next to "Presentación" and
 * "Nueva hoja" (NOT inside TopDock — that surface is hands-off per
 * product owner). The four kinds are first-class artefacts:
 *
 *   ◉ Carrusel social      (LinkedIn/IG/X cuadrado)
 *   ▣ Presentación PPT     (16:9 audiencia presencial)
 *   ∎ Documento            (A4 email)
 *   ♪ Podcast              (audio narrado del board)
 *
 * Click → small dropdown picker. Pick a kind → ShareAsOptionsModal opens
 * with sensible defaults. Submit → onGenerate(kind, options, sendToCanvas)
 * gets called by the parent so the canvas can wire it to exportAsset()
 * and animate the resulting node entrance.
 */
import { useState, useRef, useEffect } from 'react';
import {
  Share2, ChevronDown, Layers as LayersIcon, FileText,
  AudioLines, Presentation as PresentationIcon, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GeneratedAssetKind } from '@/services/workspaceApi';

export interface ShareAsKindMeta {
  kind: GeneratedAssetKind;
  icon: LucideIcon;
  mark: string;
  label: string;
  sublabel: string;
  /** Si true, el botón se renderiza grayed-out y el click no dispara nada.
   *  Usado para esconder formatos que aún no están listos para clientes
   *  (e.g. carrusel social y docx tienen bugs conocidos a 2026-05-11 — los
   *  re-habilitamos cuando arreglemos el flow). */
  comingSoon?: boolean;
}

// Para el demo de hoy (2026-05-11): solo Podcast (ElevenLabs) + PPT (Gamma)
// funcionan end-to-end. Carrusel y Documento quedan visibles pero
// deshabilitados con el badge "Próximamente" — se re-activan post-demo
// cuando arreglemos los crashes específicos de cada flow.
export const SHARE_AS_KINDS: ShareAsKindMeta[] = [
  { kind: 'pptx_asset',    icon: PresentationIcon,  mark: '▣', label: 'Presentación PPT',    sublabel: '16:9 para audiencia presencial' },
  { kind: 'podcast_asset', icon: AudioLines,        mark: '♪', label: 'Podcast',             sublabel: 'Audio narrado del board' },
  { kind: 'carousel',      icon: LayersIcon,        mark: '◉', label: 'Carrusel social',     sublabel: 'LinkedIn · IG · X · cuadrado', comingSoon: true },
  { kind: 'docx_asset',    icon: FileText,          mark: '∎', label: 'Documento',           sublabel: 'A4 para envío por email',        comingSoon: true },
];

/** Lookup helper — used by callers that receive a kind string and need
 *  the full metadata (e.g. AnimatedAiInput's share-suggestion handler). */
export function getShareAsKindMeta(kind: ShareAsKindMeta['kind']): ShareAsKindMeta {
  return SHARE_AS_KINDS.find((k) => k.kind === kind) ?? SHARE_AS_KINDS[0];
}

interface Props {
  onPick: (meta: ShareAsKindMeta) => void;
  /** When true, the button shows a "Generando…" pill and is disabled. */
  generating?: boolean;
}

export function ShareAsButton({ onPick, generating }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Outside-click close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={generating}
        className={cn(
          'flex items-center gap-1.5 px-3 py-2.5 rounded-xl bg-white dark:bg-[#1c1c1c] border shadow-sm text-[13px] font-medium transition-colors',
          generating
            ? 'border-cl2-burgundy/40 text-cl2-burgundy cursor-wait'
            : 'border-cl2-burgundy/20 dark:border-cl2-burgundy/30 text-cl2-burgundy hover:bg-cl2-burgundy/[0.04] dark:hover:bg-cl2-burgundy/[0.10]',
        )}
        title="Compartir el board como artefacto"
      >
        <Share2 className="w-4 h-4" />
        <span className="hidden md:inline">{generating ? 'Generando…' : 'Compartir como'}</span>
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[300px] rounded-2xl bg-white dark:bg-[#1c1c1c] border border-black/8 dark:border-white/10 shadow-2xl z-50 py-1.5 animate-in fade-in slide-in-from-top-1"
        >
          <p className="px-4 pt-2 pb-1 text-[10px] font-mono uppercase tracking-[0.18em] text-[#0e1745]/55 dark:text-white/45">
            Elegí formato
          </p>
          {SHARE_AS_KINDS.map((k) => (
            <button
              key={k.kind}
              onClick={() => {
                if (k.comingSoon) return;
                setOpen(false);
                onPick(k);
              }}
              disabled={k.comingSoon}
              className={cn(
                'w-full flex items-start gap-3 px-4 py-2.5 text-left transition-colors',
                k.comingSoon
                  ? 'opacity-45 cursor-not-allowed'
                  : 'hover:bg-cl2-burgundy/[0.05]'
              )}
              title={k.comingSoon ? 'Próximamente — versión 2.0' : undefined}
            >
              <div className="w-8 h-8 rounded-lg bg-cl2-burgundy/10 flex items-center justify-center shrink-0">
                <span className="font-display italic text-cl2-burgundy text-[14px] leading-none">{k.mark}</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-display italic text-[13.5px] text-[#0e1745] dark:text-white leading-tight">
                    {k.label}
                  </p>
                  {k.comingSoon && (
                    <span className="text-[9px] font-mono uppercase tracking-[0.16em] px-1.5 py-0.5 rounded bg-[#0e1745]/[0.06] dark:bg-white/[0.08] text-[#0e1745]/60 dark:text-white/60">
                      Próximamente
                    </span>
                  )}
                </div>
                <p className="text-[10.5px] font-mono uppercase tracking-[0.12em] text-[#0e1745]/45 dark:text-white/40 mt-0.5 truncate">
                  {k.sublabel}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
