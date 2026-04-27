/**
 * Audio player — adapted from 21st-dev's elevenlabs-style player
 * (https://21st.dev) but stripped to the parts CL2 needs:
 *
 *   AudioPlayerProvider  → owns the <audio> element + state
 *   useAudioPlayer       → imperative API (play/pause/seek)
 *   useAudioPlayerTime   → current time, isolated for cheap reads
 *   AudioPlayerButton    → play/pause toggle, shows spinner on buffer
 *   AudioPlayerProgress  → Radix slider with seek + drag-to-pause
 *   AudioPlayerTime      → mm:ss of currentTime
 *   AudioPlayerDuration  → mm:ss of duration (or --:-- while loading)
 *   AudioPlayerSpeed     → inline 0.5x / 1x / 1.5x / 2x toggle row
 *
 * Why custom (not bare <audio controls>):
 *   1. Native controls inject a browser-default focus halo (blue on
 *      Chromium) that clashes with cl2-burgundy. No reliable way to
 *      kill it cross-browser.
 *   2. Two play buttons looked sloppy — one custom + one native.
 *   3. We need consistent typography (font-display, tabular-nums).
 *
 * Built on @radix-ui/react-slider for keyboard a11y. No shadcn deps —
 * the original 21st-dev component used Button/DropdownMenu but we
 * inline simple buttons matching the existing modal idiom.
 */
'use client';

import {
  type ComponentProps,
  type HTMLProps,
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { Pause, Play } from 'lucide-react';
import { cn } from '@/lib/utils';

enum ReadyState {
  HAVE_NOTHING = 0,
  HAVE_METADATA = 1,
  HAVE_CURRENT_DATA = 2,
  HAVE_FUTURE_DATA = 3,
  HAVE_ENOUGH_DATA = 4,
}

enum NetworkState {
  NETWORK_EMPTY = 0,
  NETWORK_IDLE = 1,
  NETWORK_LOADING = 2,
  NETWORK_NO_SOURCE = 3,
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const mm = mins < 10 && hrs > 0 ? `0${mins}` : mins;
  const ss = secs < 10 ? `0${secs}` : secs;
  return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

interface AudioPlayerItem<TData = unknown> {
  id: string | number;
  src: string;
  data?: TData;
}

interface AudioPlayerApi<TData = unknown> {
  ref: RefObject<HTMLAudioElement | null>;
  activeItem: AudioPlayerItem<TData> | null;
  duration: number | undefined;
  error: MediaError | null;
  isPlaying: boolean;
  isBuffering: boolean;
  playbackRate: number;
  isItemActive: (id: string | number | null) => boolean;
  setActiveItem: (item: AudioPlayerItem<TData> | null) => Promise<void>;
  play: (item?: AudioPlayerItem<TData> | null) => Promise<void>;
  pause: () => void;
  seek: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
}

const AudioPlayerContext = createContext<AudioPlayerApi<unknown> | null>(null);

export function useAudioPlayer<TData = unknown>(): AudioPlayerApi<TData> {
  const api = useContext(AudioPlayerContext) as AudioPlayerApi<TData> | null;
  if (!api) throw new Error('useAudioPlayer must be inside <AudioPlayerProvider>');
  return api;
}

const AudioPlayerTimeContext = createContext<number | null>(null);

export function useAudioPlayerTime(): number {
  const t = useContext(AudioPlayerTimeContext);
  if (t === null) throw new Error('useAudioPlayerTime must be inside <AudioPlayerProvider>');
  return t;
}

type Callback = (delta: number) => void;
function useAnimationFrame(cb: Callback) {
  const reqRef = useRef<number | null>(null);
  const prevRef = useRef<number | null>(null);
  const cbRef = useRef<Callback>(cb);
  useEffect(() => { cbRef.current = cb; }, [cb]);
  useEffect(() => {
    const tick = (t: number) => {
      if (prevRef.current !== null) cbRef.current(t - prevRef.current);
      prevRef.current = t;
      reqRef.current = requestAnimationFrame(tick);
    };
    reqRef.current = requestAnimationFrame(tick);
    return () => {
      if (reqRef.current) cancelAnimationFrame(reqRef.current);
      prevRef.current = null;
    };
  }, []);
}

export function AudioPlayerProvider<TData = unknown>({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const itemRef = useRef<AudioPlayerItem<TData> | null>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);

  const [readyState, setReadyState] = useState(0);
  const [networkState, setNetworkState] = useState(0);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [error, setError] = useState<MediaError | null>(null);
  const [activeItem, _setActiveItem] = useState<AudioPlayerItem<TData> | null>(null);
  const [paused, setPaused] = useState(true);
  const [playbackRate, setPlaybackRateState] = useState(1);

  const setActiveItem = useCallback(async (item: AudioPlayerItem<TData> | null) => {
    if (!audioRef.current) return;
    if (item?.id === itemRef.current?.id) return;
    itemRef.current = item;
    const currentRate = audioRef.current.playbackRate;
    audioRef.current.pause();
    audioRef.current.currentTime = 0;
    if (item === null) audioRef.current.removeAttribute('src');
    else audioRef.current.src = item.src;
    audioRef.current.load();
    audioRef.current.playbackRate = currentRate;
  }, []);

  const play = useCallback(async (item?: AudioPlayerItem<TData> | null) => {
    if (!audioRef.current) return;
    if (playPromiseRef.current) {
      try { await playPromiseRef.current; } catch (e) { console.error(e); }
    }
    if (item === undefined) {
      const p = audioRef.current.play();
      playPromiseRef.current = p;
      return p;
    }
    if (item?.id === activeItem?.id) {
      const p = audioRef.current.play();
      playPromiseRef.current = p;
      return p;
    }
    itemRef.current = item;
    const currentRate = audioRef.current.playbackRate;
    if (!audioRef.current.paused) audioRef.current.pause();
    audioRef.current.currentTime = 0;
    if (item === null) audioRef.current.removeAttribute('src');
    else audioRef.current.src = item.src;
    audioRef.current.load();
    audioRef.current.playbackRate = currentRate;
    const p = audioRef.current.play();
    playPromiseRef.current = p;
    return p;
  }, [activeItem]);

  const pause = useCallback(async () => {
    if (!audioRef.current) return;
    if (playPromiseRef.current) {
      try { await playPromiseRef.current; } catch (e) { console.error(e); }
    }
    audioRef.current.pause();
    playPromiseRef.current = null;
  }, []);

  const seek = useCallback((t: number) => {
    if (audioRef.current) audioRef.current.currentTime = t;
  }, []);

  const setPlaybackRate = useCallback((r: number) => {
    if (!audioRef.current) return;
    audioRef.current.playbackRate = r;
    setPlaybackRateState(r);
  }, []);

  const isItemActive = useCallback((id: string | number | null) => activeItem?.id === id, [activeItem]);

  useAnimationFrame(() => {
    if (!audioRef.current) return;
    _setActiveItem(itemRef.current);
    setReadyState(audioRef.current.readyState);
    setNetworkState(audioRef.current.networkState);
    setTime(audioRef.current.currentTime);
    setDuration(audioRef.current.duration);
    setPaused(audioRef.current.paused);
    setError(audioRef.current.error);
    setPlaybackRateState(audioRef.current.playbackRate);
  });

  const isPlaying = !paused;
  const isBuffering =
    readyState < ReadyState.HAVE_FUTURE_DATA &&
    networkState === NetworkState.NETWORK_LOADING;

  const api = useMemo<AudioPlayerApi<TData>>(() => ({
    ref: audioRef, duration, error, isPlaying, isBuffering, activeItem, playbackRate,
    isItemActive, setActiveItem, play, pause, seek, setPlaybackRate,
  }), [duration, error, isPlaying, isBuffering, activeItem, playbackRate, isItemActive, setActiveItem, play, pause, seek, setPlaybackRate]);

  return (
    <AudioPlayerContext.Provider value={api as AudioPlayerApi<unknown>}>
      <AudioPlayerTimeContext.Provider value={time}>
        <audio ref={audioRef} className="hidden" crossOrigin="anonymous" />
        {children}
      </AudioPlayerTimeContext.Provider>
    </AudioPlayerContext.Provider>
  );
}

// ─── Progress (seek) ─────────────────────────────────────────────────

export const AudioPlayerProgress = ({
  className,
  ...rest
}: Omit<ComponentProps<typeof SliderPrimitive.Root>, 'min' | 'max' | 'value'>) => {
  const player = useAudioPlayer();
  const time = useAudioPlayerTime();
  const wasPlayingRef = useRef(false);

  const max = player.duration ?? 0;
  const disabled =
    player.duration === undefined ||
    !Number.isFinite(player.duration) ||
    Number.isNaN(player.duration);

  return (
    <SliderPrimitive.Root
      {...rest}
      value={[time]}
      onValueChange={(v) => { player.seek(v[0]); rest.onValueChange?.(v); }}
      min={0}
      max={max}
      step={rest.step ?? 0.25}
      disabled={disabled}
      onPointerDown={(e) => {
        wasPlayingRef.current = player.isPlaying;
        void player.pause();
        rest.onPointerDown?.(e);
      }}
      onPointerUp={(e) => {
        if (wasPlayingRef.current) void player.play();
        rest.onPointerUp?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault();
          if (player.isPlaying) void player.pause();
          else void player.play();
        }
        rest.onKeyDown?.(e);
      }}
      className={cn(
        'group/player relative flex h-4 touch-none select-none items-center data-[disabled]:opacity-50',
        className,
      )}
    >
      <SliderPrimitive.Track className="relative h-[3px] w-full grow overflow-hidden rounded-full bg-[#0e1745]/[0.10] dark:bg-white/[0.12]">
        <SliderPrimitive.Range className="absolute h-full bg-cl2-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        className="relative flex size-3 items-center justify-center rounded-full bg-cl2-accent shadow-[0_2px_6px_rgba(122,59,71,0.45)] outline-none focus-visible:ring-2 focus-visible:ring-cl2-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#231f1f] disabled:pointer-events-none disabled:opacity-50"
      />
    </SliderPrimitive.Root>
  );
};

// ─── Time displays ───────────────────────────────────────────────────

export const AudioPlayerTime = ({ className, ...rest }: HTMLProps<HTMLSpanElement>) => {
  const time = useAudioPlayerTime();
  return (
    <span {...rest} className={cn('text-[11px] text-[#0e1745]/60 dark:text-white/60 tabular-nums', className)}>
      {formatTime(time)}
    </span>
  );
};

export const AudioPlayerDuration = ({ className, ...rest }: HTMLProps<HTMLSpanElement>) => {
  const player = useAudioPlayer();
  const ok = player.duration != null && !Number.isNaN(player.duration);
  return (
    <span {...rest} className={cn('text-[11px] text-[#0e1745]/60 dark:text-white/60 tabular-nums', className)}>
      {ok ? formatTime(player.duration as number) : '--:--'}
    </span>
  );
};

// ─── Buttons ─────────────────────────────────────────────────────────

function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block size-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white', className)}
      role="status"
      aria-label="Cargando"
    />
  );
}

export interface AudioPlayerButtonProps<TData = unknown> extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  item?: AudioPlayerItem<TData>;
}

export function AudioPlayerButton<TData = unknown>({
  item,
  className,
  onClick,
  ...rest
}: AudioPlayerButtonProps<TData>) {
  const player = useAudioPlayer<TData>();
  const isActive = item ? player.isItemActive(item.id) : true;
  const playing = isActive && player.isPlaying;
  const loading = isActive && player.isBuffering && player.isPlaying;

  return (
    <button
      type="button"
      {...rest}
      onClick={(e) => {
        if (playing) void player.pause();
        else void player.play(item);
        onClick?.(e);
      }}
      aria-label={playing ? 'Pausar' : 'Reproducir'}
      className={cn(
        'relative inline-flex items-center justify-center rounded-full bg-cl2-accent text-white hover:bg-cl2-accent-hover transition-colors disabled:opacity-50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl2-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[#231f1f]',
        className,
      )}
    >
      {playing ? (
        <Pause className={cn('size-4', loading && 'opacity-0')} />
      ) : (
        <Play className={cn('size-4 translate-x-[1px]', loading && 'opacity-0')} />
      )}
      {loading && <span className="absolute inset-0 flex items-center justify-center"><Spinner /></span>}
    </button>
  );
}

// ─── Speed (inline button row) ───────────────────────────────────────

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

export function AudioPlayerSpeed({ className }: { className?: string }) {
  const player = useAudioPlayer();
  return (
    <div className={cn('inline-flex items-center gap-0.5 rounded-md bg-[#0e1745]/[0.04] dark:bg-white/[0.06] p-0.5', className)}>
      {SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => player.setPlaybackRate(s)}
          className={cn(
            'px-1.5 py-0.5 rounded text-[10.5px] font-mono tabular-nums transition-colors',
            Math.abs(player.playbackRate - s) < 0.01
              ? 'bg-white dark:bg-white/15 text-[#0e1745] dark:text-white shadow-sm'
              : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
          )}
        >
          {s}x
        </button>
      ))}
    </div>
  );
}
