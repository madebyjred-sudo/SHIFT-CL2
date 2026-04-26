/**
 * PodcastStrip — generic source-bound audio player strip.
 *
 * Why a sibling of BoardAudioStrip (instead of refactoring it): the
 * Hojas surface is being modified by another agent right now. Touching
 * BoardAudioStrip risks merge conflicts. PodcastStrip is a near-twin,
 * generalized over `sourceType` so SesionViewPage and
 * ExpedienteViewPage can mount it without poking Hojas-adjacent code.
 *
 * Behavior is identical to BoardAudioStrip:
 *   - Loads the most recent podcast for (sourceType, sourceId).
 *   - Polls every 3s while a job is in flight; promotes to ready
 *     player when status flips.
 *   - Play/pause + scrubber + skip ±15s + speed cycle + regenerate.
 *   - Stale badge when sourceUpdatedAt > podcast.finished_at.
 *
 * Eventually consolidate into one component once Hojas changes settle.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Headphones,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  listPodcastsBySource,
  resolvePodcastAudioUrl,
  type PodcastRow,
  type PodcastSourceType,
} from '@/services/podcastsApi';

interface Props {
  sourceType: PodcastSourceType;
  sourceId: string;
  /** ISO timestamp — drives the stale badge. Optional. */
  sourceUpdatedAt?: string;
  /** "Regenerate" → parent opens its PodcastModal. */
  onRequestRegenerate: () => void;
  /** Override the default short label shown when no podcast title. */
  emptyLabel?: string;
  /** Bumped externally to force a refetch (e.g. just kicked a new gen). */
  refreshKey?: number;
}

const SPEEDS = [1, 1.25, 1.5, 2] as const;
type Speed = (typeof SPEEDS)[number];

const POLL_MS = 3_000;

function isInFlight(s: PodcastRow['status']): boolean {
  return s === 'queued' || s === 'scripting' || s === 'tts' || s === 'encoding';
}

function statusCopy(s: PodcastRow['status']): string {
  switch (s) {
    case 'queued': return 'En cola';
    case 'scripting': return 'Escribiendo el guion';
    case 'tts': return 'Sintetizando voz';
    case 'encoding': return 'Codificando audio';
    case 'failed': return 'Falló la generación';
    case 'cancelled': return 'Cancelado';
    default: return '';
  }
}

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function PodcastStrip({
  sourceType,
  sourceId,
  sourceUpdatedAt,
  onRequestRegenerate,
  emptyLabel = 'Audio',
  refreshKey,
}: Props) {
  const [latest, setLatest] = useState<PodcastRow | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState<Speed>(1);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refresh = async () => {
      try {
        const items = await listPodcastsBySource(sourceType, sourceId);
        if (!alive) return;
        const top = items[0] ?? null;
        setLatest(top);
        if (top && top.status === 'ready') {
          if (!audioUrl) {
            const url = await resolvePodcastAudioUrl(top.id);
            if (alive) setAudioUrl(url);
          }
        } else {
          setAudioUrl(null);
        }
        if (top && isInFlight(top.status)) {
          if (!timer) timer = setInterval(refresh, POLL_MS);
        } else if (timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch {
        /* silent */
      }
    };
    void refresh();
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType, sourceId, refreshKey]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

  const stale =
    latest?.status === 'ready' &&
    sourceUpdatedAt &&
    latest.finished_at &&
    new Date(sourceUpdatedAt).getTime() > new Date(latest.finished_at).getTime();

  if (!latest) return null;

  const inFlight = isInFlight(latest.status);

  if (inFlight) {
    return (
      <div className="flex items-center gap-3 px-3.5 py-2 rounded-xl bg-cl2-burgundy/[0.06] dark:bg-cl2-accent/[0.10] border border-cl2-burgundy/15 dark:border-cl2-accent/20 backdrop-blur-md">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-cl2-burgundy/15 dark:bg-cl2-accent/20 text-cl2-burgundy dark:text-cl2-accent-soft">
          <Headphones size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-[#0e1745] dark:text-white truncate">
            {statusCopy(latest.status)}
          </div>
          <div className="mt-1 h-1 rounded-full bg-cl2-burgundy/10 dark:bg-cl2-accent/15 overflow-hidden">
            <motion.div
              className="h-full bg-cl2-burgundy dark:bg-cl2-accent"
              initial={{ width: 0 }}
              animate={{ width: `${latest.progress}%` }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>
        <span className="font-mono text-[10.5px] tabular-nums text-[#0e1745]/55 dark:text-white/55">
          {latest.progress}%
        </span>
      </div>
    );
  }

  if (latest.status === 'failed' || latest.status === 'cancelled') {
    return (
      <div className="flex items-center gap-3 px-3.5 py-2 rounded-xl bg-rose-500/[0.06] border border-rose-500/20">
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-300">
          <Headphones size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-rose-600 dark:text-rose-300">
            {statusCopy(latest.status)}
          </div>
        </div>
        <button
          type="button"
          onClick={onRequestRegenerate}
          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-rose-600 dark:text-rose-300 hover:underline"
        >
          <RefreshCw size={11} /> Reintentar
        </button>
      </div>
    );
  }

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  };
  const skip = (delta: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta));
  };
  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(speed);
    setSpeed(SPEEDS[(idx + 1) % SPEEDS.length]);
  };

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl bg-white/95 dark:bg-[#1c1c1c]/95 backdrop-blur-md border border-[#0e1745]/[0.08] dark:border-white/[0.08] shadow-sm">
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onLoadedMetadata={() => {
            const el = audioRef.current;
            if (el) setDuration(el.duration || 0);
          }}
          onTimeUpdate={() => {
            const el = audioRef.current;
            if (el) setCurrentTime(el.currentTime || 0);
          }}
          preload="metadata"
        />
      )}

      <button
        type="button"
        onClick={togglePlay}
        disabled={!audioUrl}
        aria-label={playing ? 'Pausar' : 'Reproducir'}
        className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-cl2-burgundy text-white dark:bg-cl2-accent hover:bg-cl2-burgundy/90 dark:hover:bg-cl2-accent-hover transition-colors disabled:opacity-40"
      >
        {playing ? <Pause size={13} /> : <Play size={13} className="ml-[1px]" />}
      </button>

      <button
        type="button"
        onClick={() => skip(-15)}
        disabled={!audioUrl}
        title="Atrás 15s"
        className="hidden sm:inline-flex p-1.5 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] disabled:opacity-40"
      >
        <RotateCcw size={13} />
      </button>
      <button
        type="button"
        onClick={() => skip(15)}
        disabled={!audioUrl}
        title="Adelante 15s"
        className="hidden sm:inline-flex p-1.5 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] disabled:opacity-40"
      >
        <RotateCw size={13} />
      </button>

      <div className="flex-1 min-w-[120px]">
        <div className="text-[11px] font-semibold text-[#0e1745] dark:text-white truncate">
          {latest.title ?? emptyLabel}
        </div>
        <div className="relative mt-1 h-1 rounded-full bg-[#0e1745]/[0.06] dark:bg-white/[0.08] overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 bg-cl2-burgundy dark:bg-cl2-accent transition-[width]"
            style={{ width: `${pct}%`, transitionDuration: '120ms' }}
          />
          <input
            type="range"
            min={0}
            max={duration || 0}
            value={currentTime}
            step={0.5}
            onChange={(e) => {
              const el = audioRef.current;
              if (el) el.currentTime = Number(e.target.value);
            }}
            disabled={!audioUrl}
            aria-label="Posición del audio"
            className="absolute inset-0 opacity-0 cursor-pointer disabled:cursor-not-allowed"
          />
        </div>
        <div className="flex items-center justify-between mt-0.5 font-mono text-[10px] tabular-nums text-[#0e1745]/55 dark:text-white/55">
          <span>{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={cycleSpeed}
        disabled={!audioUrl}
        title="Velocidad"
        className="inline-flex items-center px-2 h-7 rounded-md text-[11px] font-mono font-semibold text-[#0e1745]/65 dark:text-white/65 border border-[#0e1745]/[0.10] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] disabled:opacity-40"
      >
        {speed}x
      </button>

      <AnimatePresence>
        {stale && (
          <motion.span
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            title="La fuente cambió después de generar este audio"
            className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/[0.10] text-amber-700 dark:text-amber-300 border border-amber-500/30 text-[10px] font-semibold"
          >
            actualizado
          </motion.span>
        )}
      </AnimatePresence>

      <button
        type="button"
        onClick={onRequestRegenerate}
        title="Regenerar"
        className="p-1.5 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
      >
        <RefreshCw size={13} className={cn(stale && 'text-amber-600 dark:text-amber-400')} />
      </button>
    </div>
  );
}
