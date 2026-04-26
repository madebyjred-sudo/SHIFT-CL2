/**
 * Podcast generation modal — opens from "Generar podcast" buttons on
 * SesionViewPage / ExpedienteViewPage / chat message menu.
 *
 * UX:
 *   1. Pick voice (whitelisted) + length + style → Generate
 *   2. Polls /api/podcasts/:id every 2s while in flight
 *   3. On ready: shows audio player + download link
 *   4. On failed: shows error + retry
 *
 * Keep it self-contained so adding it to a new surface is one import +
 * one open() call.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Download, Headphones, Loader2, Pause, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  createPodcast,
  getPodcast,
  listVoices,
  resolvePodcastAudioUrl,
  type PodcastRow,
  type PodcastSourceType,
  type PodcastStyle,
  type PodcastVoice,
} from '@/services/podcastsApi';

interface Props {
  open: boolean;
  onClose: () => void;
  source_type: PodcastSourceType;
  source_id: string;
  /** Optional title shown in the modal header to give context. */
  source_title?: string;
}

type Duration = 90 | 180 | 300;

const DURATIONS: Array<{ value: Duration; label: string; sub: string }> = [
  { value: 90, label: '90 s', sub: 'flash' },
  { value: 180, label: '3 min', sub: 'briefing' },
  { value: 300, label: '5 min', sub: 'profundo' },
];

const STYLES: Array<{ value: PodcastStyle; label: string; sub: string }> = [
  { value: 'informativo', label: 'Informativo', sub: 'tono briefing público' },
  { value: 'conversacional', label: 'Conversacional', sub: 'entrevista relajada' },
];

export function PodcastModal({ open, onClose, source_type, source_id, source_title }: Props) {
  const [voices, setVoices] = useState<PodcastVoice[]>([]);
  const [voiceId, setVoiceId] = useState<string>('');
  const [duration, setDuration] = useState<Duration>(180);
  const [style, setStyle] = useState<PodcastStyle>('informativo');

  const [phase, setPhase] = useState<'config' | 'running' | 'ready' | 'error'>('config');
  const [job, setJob] = useState<PodcastRow | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load voices on first open. Cached for the modal lifetime.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    listVoices()
      .then((vs) => {
        if (!alive) return;
        setVoices(vs);
        if (!voiceId && vs.length > 0) setVoiceId(vs[0].id);
      })
      .catch((err) => setError((err as Error).message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset on close.
  useEffect(() => {
    if (open) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
    setPhase('config');
    setJob(null);
    setAudioUrl(null);
    setError(null);
  }, [open]);

  const startGen = async () => {
    if (!voiceId) return;
    setError(null);
    setPhase('running');
    try {
      const { id } = await createPodcast({
        source_type,
        source_id,
        voice_id: voiceId,
        duration_target_s: duration,
        style,
      });
      // Begin polling.
      const tick = async () => {
        try {
          const row = await getPodcast(id);
          setJob(row);
          if (row.status === 'ready') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            try {
              const url = await resolvePodcastAudioUrl(id);
              setAudioUrl(url);
              setPhase('ready');
            } catch (err) {
              setError((err as Error).message);
              setPhase('error');
            }
          } else if (row.status === 'failed' || row.status === 'cancelled') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setError(row.error ?? 'Falló la generación.');
            setPhase('error');
          }
        } catch (err) {
          setError((err as Error).message);
        }
      };
      void tick();
      pollRef.current = setInterval(() => void tick(), 2_000);
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm"
      />
      <motion.div
        key="dialog"
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        className="fixed left-1/2 top-1/2 z-[201] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#0e1745]/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] shadow-[0_30px_80px_rgba(14,23,69,0.20),0_8px_24px_rgba(14,23,69,0.10)]"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-cl2-burgundy/10 text-cl2-burgundy dark:text-[#d8a4ad]">
            <Headphones size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-display text-[18px] tracking-tight text-[#0e1745] dark:text-white">
              Generar podcast
            </div>
            {source_title && (
              <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 truncate">
                {source_title}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] text-[#0e1745]/60 dark:text-white/60"
            aria-label="Cerrar"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5">
          {phase === 'config' && (
            <div className="space-y-5">
              <Group label="Voz">
                <div className="grid gap-2">
                  {voices.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setVoiceId(v.id)}
                      className={cn(
                        'text-left rounded-lg border px-3.5 py-2.5 transition-colors',
                        voiceId === v.id
                          ? 'border-cl2-accent/40 bg-cl2-accent/[0.06]'
                          : 'border-[#0e1745]/[0.10] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.03] dark:hover:bg-white/[0.04]',
                      )}
                    >
                      <div className="text-[13.5px] font-semibold text-[#0e1745] dark:text-white">
                        {v.label}
                      </div>
                      <div className="text-[11.5px] text-[#0e1745]/60 dark:text-white/60 mt-0.5">
                        {v.description}
                      </div>
                    </button>
                  ))}
                </div>
              </Group>
              <Group label="Duración">
                <div className="grid grid-cols-3 gap-2">
                  {DURATIONS.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => setDuration(d.value)}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-center transition-colors',
                        duration === d.value
                          ? 'border-cl2-accent/40 bg-cl2-accent/[0.06]'
                          : 'border-[#0e1745]/[0.10] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.03] dark:hover:bg-white/[0.04]',
                      )}
                    >
                      <div className="font-display text-[18px] tabular-nums text-[#0e1745] dark:text-white">
                        {d.label}
                      </div>
                      <div className="text-[10.5px] text-[#0e1745]/55 dark:text-white/55 uppercase tracking-wider mt-0.5">
                        {d.sub}
                      </div>
                    </button>
                  ))}
                </div>
              </Group>
              <Group label="Estilo">
                <div className="grid grid-cols-2 gap-2">
                  {STYLES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      onClick={() => setStyle(s.value)}
                      className={cn(
                        'rounded-lg border px-3 py-2 text-left transition-colors',
                        style === s.value
                          ? 'border-cl2-accent/40 bg-cl2-accent/[0.06]'
                          : 'border-[#0e1745]/[0.10] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.03] dark:hover:bg-white/[0.04]',
                      )}
                    >
                      <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                        {s.label}
                      </div>
                      <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                        {s.sub}
                      </div>
                    </button>
                  ))}
                </div>
              </Group>
              {error && (
                <div className="rounded-md border border-rose-300/40 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300">
                  {error}
                </div>
              )}
            </div>
          )}

          {phase === 'running' && (
            <RunningPanel job={job} />
          )}

          {phase === 'ready' && audioUrl && job && (
            <ReadyPanel job={job} audioUrl={audioUrl} />
          )}

          {phase === 'error' && (
            <div className="py-4 space-y-3">
              <div className="text-[13px] text-[#0e1745] dark:text-white">
                No se pudo generar el podcast.
              </div>
              <div className="text-[12px] text-rose-700 dark:text-rose-300 font-mono">
                {error ?? 'error desconocido'}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          {phase === 'config' && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={!voiceId}
                onClick={() => void startGen()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-[12.5px] font-semibold"
              >
                <Headphones size={13} />
                Generar
              </button>
            </>
          )}
          {phase === 'running' && (
            <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
              Esto suele tomar entre 30 y 90 segundos.
            </span>
          )}
          {(phase === 'ready' || phase === 'error') && (
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
            >
              Cerrar
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/55 dark:text-white/55 mb-2">
        {label}
      </div>
      {children}
    </div>
  );
}

function statusLabel(s: PodcastRow['status'] | undefined): string {
  switch (s) {
    case 'queued': return 'En cola';
    case 'scripting': return 'Escribiendo el guion';
    case 'tts': return 'Sintetizando voz';
    case 'encoding': return 'Codificando audio';
    case 'ready': return 'Listo';
    case 'failed': return 'Error';
    case 'cancelled': return 'Cancelado';
    default: return 'Iniciando…';
  }
}

function RunningPanel({ job }: { job: PodcastRow | null }) {
  const pct = job?.progress ?? 5;
  return (
    <div className="py-6 space-y-4">
      <div className="flex items-center gap-3">
        <Loader2 size={18} className="animate-spin text-cl2-accent" />
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
            {statusLabel(job?.status)}
          </div>
          <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-0.5">
            {pct}% completo
          </div>
        </div>
      </div>
      <div className="h-1.5 rounded-full bg-[#0e1745]/[0.06] dark:bg-white/[0.08] overflow-hidden">
        <motion.div
          className="h-full bg-cl2-accent"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        />
      </div>
    </div>
  );
}

function ReadyPanel({ job, audioUrl }: { job: PodcastRow; audioUrl: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setPlaying(true);
    } else {
      el.pause();
      setPlaying(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="font-display text-[20px] leading-tight tracking-tight text-[#0e1745] dark:text-white">
          {job.title ?? 'Tu podcast está listo'}
        </div>
        <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-1">
          {job.duration_actual_s ? `${Math.round(job.duration_actual_s)}s` : ''}
          {job.duration_actual_s && ' · '}
          Lexa · narrado a voz única
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-[#0e1745]/[0.08] dark:border-white/[0.08] bg-[#0e1745]/[0.02] dark:bg-white/[0.03] px-3 py-2.5">
        <button
          type="button"
          onClick={toggle}
          className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-cl2-accent text-white hover:bg-cl2-accent-hover transition-colors"
          aria-label={playing ? 'Pausar' : 'Reproducir'}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <audio
          ref={audioRef}
          src={audioUrl}
          onEnded={() => setPlaying(false)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
          controls
          className="flex-1 h-9"
        />
      </div>

      <a
        href={audioUrl}
        download={`cl2-podcast-${job.id.slice(0, 8)}.mp3`}
        className="inline-flex items-center gap-1.5 text-[12px] font-medium text-cl2-accent dark:text-cl2-accent-soft hover:underline"
      >
        <Download size={12} /> Descargar MP3
      </a>
    </div>
  );
}
