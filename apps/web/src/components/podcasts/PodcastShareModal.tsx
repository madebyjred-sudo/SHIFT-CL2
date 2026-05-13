/**
 * PodcastShareModal — mint + copy public share link for a ready podcast.
 *
 * UX:
 *   1. Pick TTL (7 / 30 / 90 days).
 *   2. Generate → token minted, URL displayed.
 *   3. Copy button → clipboard.
 *   4. Optional "abrir en pestaña nueva" to test before sending.
 *   5. Revoke link → invalidates any in-the-wild copies.
 *
 * The share URL is /api/public/podcasts/share/:token — recipient does
 * NOT need an account. URL is the auth.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Copy, ExternalLink, Headphones, Link2, Loader2, Share2, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  createPodcastShare,
  revokePodcastShare,
  type PodcastShare,
} from '@/services/podcastsApi';

interface Props {
  open: boolean;
  onClose: () => void;
  podcastId: string;
  podcastTitle?: string | null;
}

const TTL_OPTIONS: Array<{ days: number; label: string }> = [
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
  { days: 90, label: '90 días' },
];

type Phase = 'idle' | 'minting' | 'ready' | 'error' | 'revoking';

export function PodcastShareModal({ open, onClose, podcastId, podcastTitle }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [share, setShare] = useState<PodcastShare | null>(null);
  const [ttl, setTtl] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setPhase('idle');
    setShare(null);
    setError(null);
    setCopied(false);
  };

  const mint = async () => {
    setPhase('minting');
    setError(null);
    try {
      const s = await createPodcastShare(podcastId, ttl);
      setShare(s);
      setPhase('ready');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  const revoke = async () => {
    if (!confirm('¿Revocar el link? Cualquiera con la URL anterior no podrá escuchar más.')) return;
    setPhase('revoking');
    try {
      await revokePodcastShare(podcastId);
      setShare(null);
      setPhase('idle');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  const copy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // older browsers — show a manual copy hint
      setError('Copiá manualmente el link de abajo.');
    }
  };

  // Native Web Share API — surfaces the OS share sheet on iOS / Android
  // (and on macOS Safari since 17). Lets the user fire to WhatsApp,
  // mail, AirDrop, etc. without us needing to integrate each. Falls
  // back to copy-to-clipboard on browsers that don't expose it.
  const canNativeShare =
    typeof navigator !== 'undefined' &&
    typeof (navigator as unknown as { share?: unknown }).share === 'function';

  const nativeShare = async () => {
    if (!share || !canNativeShare) return;
    try {
      await (navigator as unknown as {
        share: (data: { title?: string; text?: string; url: string }) => Promise<void>;
      }).share({
        title: podcastTitle ?? 'Podcast de CL2',
        text: 'Te comparto este audio generado por Lexa en CL2.',
        url: share.url,
      });
    } catch (err) {
      // User-cancelled or unsupported — silent fallback to copy.
      const name = (err as Error).name;
      if (name !== 'AbortError') void copy();
    }
  };

  if (!open) return null;

  const expiryStr = share
    ? new Date(share.expires_at).toLocaleDateString('es-CR', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })
    : null;

  // Portal a document.body para escapar stacking context del motion.li
  // ancestro (que aplica transform y captura el position: fixed). Sin
  // portal el modal queda atrapado dentro de la card del podcast.
  // Bug reportado por Jred 2026-05-12.
  return createPortal(
    <AnimatePresence>
      <motion.div
        key="share-bd"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => {
          onClose();
          // Reset slightly delayed so the unmount doesn't visibly flash idle.
          setTimeout(reset, 200);
        }}
        className="fixed inset-0 z-[200] bg-black/55 backdrop-blur-sm"
      />
      <motion.div
        key="share-md"
        initial={{ opacity: 0, y: 18, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="fixed left-1/2 top-1/2 z-[201] w-[min(94vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#0e1745]/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] shadow-[0_30px_80px_rgba(14,23,69,0.20)]"
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-cl2-burgundy/10 text-cl2-burgundy dark:text-[#d8a4ad]">
            <Link2 size={15} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-display text-[18px] tracking-tight text-[#0e1745] dark:text-white">
              Compartir podcast
            </div>
            {podcastTitle && (
              <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 truncate">
                {podcastTitle}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              onClose();
              setTimeout(reset, 200);
            }}
            className="p-1.5 rounded-md hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] text-[#0e1745]/60 dark:text-white/60"
            aria-label="Cerrar"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-5">
          {phase !== 'ready' && !share && (
            <>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/55 dark:text-white/55 mb-2">
                ¿Por cuánto tiempo?
              </div>
              <div className="grid grid-cols-3 gap-2">
                {TTL_OPTIONS.map((o) => (
                  <button
                    key={o.days}
                    type="button"
                    onClick={() => setTtl(o.days)}
                    className={cn(
                      'rounded-lg border px-3 py-2 text-center transition-colors',
                      ttl === o.days
                        ? 'border-cl2-accent/40 bg-cl2-accent/[0.06]'
                        : 'border-[#0e1745]/[0.10] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.03] dark:hover:bg-white/[0.04]',
                    )}
                  >
                    <div className="font-display text-[18px] tabular-nums text-[#0e1745] dark:text-white">
                      {o.label}
                    </div>
                  </button>
                ))}
              </div>
              <p className="mt-4 text-[12px] text-[#0e1745]/60 dark:text-white/60 leading-relaxed">
                Cualquiera con el link puede escuchar el audio hasta la
                fecha de expiración. Podés revocarlo antes — el link
                anterior deja de funcionar al instante.
              </p>
              {error && (
                <div className="mt-3 rounded-md border border-rose-300/40 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300">
                  {error}
                </div>
              )}
            </>
          )}

          {phase === 'ready' && share && (
            <>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-900/15 p-4 mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Headphones size={14} className="text-emerald-700 dark:text-emerald-300" />
                  <span className="text-[11.5px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">
                    Link listo
                  </span>
                  <span className="ml-auto text-[10.5px] text-[#0e1745]/55 dark:text-white/55">
                    expira {expiryStr}
                  </span>
                </div>
                <div className="flex items-center gap-2 rounded-md bg-white dark:bg-white/[0.05] border border-[#0e1745]/[0.10] dark:border-white/[0.10] px-2.5 py-1.5">
                  <code className="flex-1 min-w-0 text-[11.5px] font-mono text-[#0e1745]/85 dark:text-white/85 truncate">
                    {share.url}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy()}
                    title="Copiar al portapapeles"
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] font-medium bg-cl2-accent text-white hover:bg-cl2-accent-hover transition-colors"
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? 'Copiado' : 'Copiar'}
                  </button>
                  {canNativeShare && (
                    <button
                      type="button"
                      onClick={() => void nativeShare()}
                      title="Compartir vía sistema"
                      className="shrink-0 p-1.5 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-cl2-burgundy dark:hover:text-cl2-accent-soft hover:bg-cl2-burgundy/[0.05] dark:hover:bg-cl2-accent/[0.10]"
                    >
                      <Share2 size={12} />
                    </button>
                  )}
                  <a
                    href={share.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Abrir en pestaña nueva"
                    className="shrink-0 p-1.5 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white"
                  >
                    <ExternalLink size={12} />
                  </a>
                </div>
              </div>
              <p className="text-[12px] text-[#0e1745]/60 dark:text-white/60 leading-relaxed">
                Cualquiera que abra este link va a escuchar el audio
                directamente. No necesitan cuenta. Podés rotarlo (mintear
                uno nuevo) o revocarlo abajo.
              </p>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          {phase !== 'ready' && (
            <>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setTimeout(reset, 200);
                }}
                className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void mint()}
                disabled={phase === 'minting'}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover disabled:opacity-50 text-white text-[12.5px] font-semibold"
              >
                {phase === 'minting' ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
                Generar link
              </button>
            </>
          )}
          {phase === 'ready' && (
            <>
              <button
                type="button"
                onClick={() => void revoke()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/15"
              >
                <Trash2 size={12} /> Revocar
              </button>
              <button
                type="button"
                onClick={() => void mint()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
              >
                Rotar token
              </button>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  setTimeout(reset, 200);
                }}
                className="px-3 py-1.5 rounded-md text-[12.5px] font-semibold text-white bg-[#0e1745] dark:bg-white/15 hover:bg-[#0e1745]/85 dark:hover:bg-white/20"
              >
                Listo
              </button>
            </>
          )}
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
