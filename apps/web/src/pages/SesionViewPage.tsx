/**
 * Session detail — premium plenaria viewer (Granola/Otter style).
 *
 * Layout (>=lg):
 *   ┌─────────────────────────────────────────┐
 *   │ Sticky header: ← back · titulo · meta   │
 *   ├──────────────────────┬──────────────────┤
 *   │ Video sticky 16:9    │ [Transcr · Lexa] │
 *   │ Resumen (3 cards)    │ list / chat      │
 *   │ scrollable           │ scrollable       │
 *   └──────────────────────┴──────────────────┘
 *
 * Mobile: stacked, video pinned top, tabs below.
 *
 * Click a transcript segment → seekTo(t) on the live YT player. The previous
 * iframe-reload approach is kept as a fallback if the IFrame API fails to
 * load (e.g. CDN blocked). In normal operation playback never stops.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Calendar, Clock, FileSliders, MessageSquare, Search, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  fetchSessionDetail,
  fetchSessionTranscript,
  type SessionDetail,
  type TranscriptPayload,
  type TranscriptSegment,
} from '@/services/sessionsApi';
import { navigate } from '@/lib/router';
import { TopDock } from '@/components/top-dock';
import { AnimatedAiInput } from '@/components/animated-ai-input';
import { cn } from '@/lib/utils';

interface Props {
  sesionId: string;
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-CR', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch { return iso.slice(0, 10); }
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtClock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}

export function SesionViewPage({ sesionId }: Props) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [transcript, setTranscript] = useState<TranscriptPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'transcript' | 'chat'>('transcript');
  const [seekToken, setSeekToken] = useState<{ t: number; n: number } | null>(null);
  const [search, setSearch] = useState('');
  // currentTime is the live playhead in seconds. Updated ~4 Hz while the
  // video is playing; idle when paused. Used by the transcript pane to
  // highlight the active segment and auto-scroll to it.
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchSessionDetail(sesionId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [sesionId]);

  useEffect(() => {
    let cancelled = false;
    fetchSessionTranscript(sesionId)
      .then((t) => { if (!cancelled) setTranscript(t); })
      .catch(() => { /* transcript optional — UI degrades to resumen-only */ });
    return () => { cancelled = true; };
  }, [sesionId]);

  const handleSeek = (t: number) => setSeekToken({ t: Math.max(0, Math.floor(t)), n: Date.now() });

  const filteredSegments = useMemo(() => {
    if (!transcript) return [];
    const q = search.trim().toLowerCase();
    if (!q) return transcript.segments;
    return transcript.segments.filter((s) => s.text.toLowerCase().includes(q));
  }, [transcript, search]);

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-mesh text-white">
        <div className="text-center">
          <p className="text-lg mb-2">No se pudo cargar la sesión</p>
          <p className="text-sm text-white/60 mb-4">{error}</p>
          <button onClick={() => navigate('/sesiones')} className="text-sm underline">
            Volver al listado
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative overflow-hidden transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      <TopDock />

      {/* Sub-header */}
      <div className="relative z-20 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/70 dark:bg-black/20 backdrop-blur-sm">
        <div className="px-4 sm:px-6 md:px-8 py-3 flex items-center gap-3 max-w-[1600px] mx-auto">
          <button
            onClick={() => navigate('/sesiones')}
            className="shrink-0 p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Volver"
          >
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-base font-medium text-[#0e1745] dark:text-white truncate">
              {detail?.titulo ?? 'Cargando…'}
            </h1>
            {detail && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                <span className="inline-flex items-center gap-1"><Calendar size={11} />{fmtDate(detail.fecha)}</span>
                <span className="inline-flex items-center gap-1"><Clock size={11} />{fmtDuration(detail.duration_s)}</span>
                <span className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px]',
                  detail.estado === 1
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
                )}>
                  {detail.estado === 1 ? 'Finalizada' : 'En proceso'}
                </span>
              </div>
            )}
          </div>
          <button
            disabled
            title="Generación de PPTX deshabilitada (API key pendiente)"
            className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-400 dark:bg-white/5 dark:text-white/30 cursor-not-allowed"
          >
            <FileSliders size={13} />
            Generar PPTX
          </button>
        </div>
      </div>

      {/* Body */}
      <main className="relative z-20 flex-1 min-h-0 max-w-[1600px] w-full mx-auto px-4 sm:px-6 md:px-8 py-4">
        <div className="h-full grid grid-cols-1 lg:grid-cols-[55fr_45fr] gap-4 lg:gap-6 min-h-0">
          {/* LEFT — Video + Resumen */}
          <section className="min-h-0 overflow-y-auto pr-1">
            <VideoPlayer
              youtubeId={detail?.youtube_id ?? null}
              seekToken={seekToken}
              onTimeUpdate={setCurrentTime}
            />
            <div className="mt-5">
              <ResumenPanel resumen={detail?.resumen} />
            </div>
          </section>

          {/* RIGHT — Tabs */}
          <section className="min-h-0 flex flex-col rounded-xl bg-white dark:bg-white/[0.025] border border-[#0e1745]/[0.06] dark:border-white/[0.06] shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-none overflow-hidden">
            <div className="flex items-center gap-1 px-2 pt-2 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
              <TabButton active={tab === 'transcript'} onClick={() => setTab('transcript')} icon={<Search size={13} />} label="Transcripción" />
              <TabButton active={tab === 'chat'} onClick={() => setTab('chat')} icon={<Sparkles size={13} />} label="Preguntar a Lexa" />
            </div>

            <div className="flex-1 min-h-0 overflow-hidden">
              {tab === 'transcript' ? (
                <TranscriptPanel
                  transcript={transcript}
                  segments={filteredSegments}
                  search={search}
                  setSearch={setSearch}
                  onSeek={handleSeek}
                  currentTime={currentTime}
                />
              ) : (
                <div className="h-full min-h-0">
                  <AnimatedAiInput
                    scope={
                      detail
                        ? { legacy_session_id: detail.id, label: `Sesión #${detail.id}` }
                        : undefined
                    }
                    placeholder={
                      detail
                        ? `Preguntá sobre la sesión #${detail.id}…`
                        : 'Preguntá sobre esta sesión…'
                    }
                    onSeek={handleSeek}
                  />
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md transition-colors',
        active
          ? 'text-cl2-accent bg-cl2-accent/8'
          : 'text-gray-500 dark:text-gray-400 hover:text-[#0e1745] dark:hover:text-white',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// --- Video --------------------------------------------------------------

// Minimal shape of the YT.Player object we depend on. The IFrame API has
// dozens of methods; we only call seekTo / playVideo / cueVideoById /
// destroy, so a hand-rolled type avoids pulling @types/youtube.
interface YTPlayer {
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  playVideo: () => void;
  cueVideoById: (videoId: string) => void;
  destroy: () => void;
  /** Returns playback position in seconds. */
  getCurrentTime: () => number;
  /** YT.PlayerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued. */
  getPlayerState: () => number;
  addEventListener: (event: string, listener: (...args: unknown[]) => void) => void;
}

let ytApiPromise: Promise<void> | null = null;

/**
 * Load https://www.youtube.com/iframe_api once per page. Subsequent callers
 * await the same promise. Resolves when `window.YT.Player` is callable.
 */
function loadYouTubeIframeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  const w = window as any;
  if (w.YT && w.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise<void>((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      try { prev?.(); } catch { /* ignore prior handler errors */ }
      resolve();
    };
    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => reject(new Error('youtube iframe api failed to load'));
      document.head.appendChild(tag);
    }
  });
  return ytApiPromise;
}

function VideoPlayer({
  youtubeId,
  seekToken,
  onTimeUpdate,
}: {
  youtubeId: string | null;
  seekToken: { t: number; n: number } | null;
  /** Fired ~4× per second while the video is PLAYING with the current
   *  position in seconds (float). Pauses tick when the player isn't
   *  PLAYING so the parent doesn't churn re-renders for nothing. */
  onTimeUpdate?: (seconds: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const [apiReady, setApiReady] = useState(false);
  const [apiFailed, setApiFailed] = useState(false);
  // Cached as a ref so the effect that owns the polling interval reads
  // the freshest callback without restarting (otherwise every parent
  // re-render that passes a new arrow function tears down the loop).
  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);

  // Load the API lazily on first mount. If it fails we fall back to the
  // older iframe-reload behavior so the demo never ends up with a black box.
  useEffect(() => {
    let cancelled = false;
    loadYouTubeIframeApi()
      .then(() => { if (!cancelled) setApiReady(true); })
      .catch(() => { if (!cancelled) setApiFailed(true); });
    return () => { cancelled = true; };
  }, []);

  // Create the YT.Player once API + youtubeId are both available. Mounting
  // happens on a fresh node so YT can replace it with its iframe.
  useEffect(() => {
    if (!apiReady || !youtubeId || !containerRef.current) return;
    if (playerRef.current) {
      // Same component, different youtubeId — swap the source instead of
      // tearing down the player (cheaper, keeps controls state).
      try { playerRef.current.cueVideoById(youtubeId); } catch { /* noop */ }
      return;
    }
    const w = window as any;
    let pollHandle: number | null = null;
    const startPolling = () => {
      if (pollHandle != null) return;
      pollHandle = window.setInterval(() => {
        const p = playerRef.current;
        if (!p) return;
        try {
          const t = p.getCurrentTime();
          if (typeof t === 'number' && Number.isFinite(t)) {
            onTimeUpdateRef.current?.(t);
          }
        } catch { /* noop — player not ready */ }
      }, 250);
    };
    const stopPolling = () => {
      if (pollHandle != null) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    };
    const player: YTPlayer = new w.YT.Player(containerRef.current, {
      videoId: youtubeId,
      // host: yt-nocookie keeps tracking minimal; `origin` improves API
      // postMessage handshake reliability across embeds.
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        origin: window.location.origin,
      },
      events: {
        onStateChange: (e: { data: number }) => {
          // YT.PlayerState: 1 = playing. Ticks while playing, idle
          // otherwise — keeps re-render cost near zero on pause.
          if (e.data === 1) startPolling();
          else stopPolling();
        },
      },
    });
    playerRef.current = player;
    return () => {
      stopPolling();
      try { player.destroy(); } catch { /* noop */ }
      playerRef.current = null;
    };
  }, [apiReady, youtubeId]);

  // Seek without reloading. If the API didn't load we fall through to the
  // legacy iframe path (rendered below) where a key change reloads with ?start.
  useEffect(() => {
    if (!apiReady || !seekToken || seekToken.t <= 0) return;
    const player = playerRef.current;
    if (!player) return;
    try {
      player.seekTo(seekToken.t, true);
      player.playVideo();
    } catch { /* noop — player not ready, next seek will land */ }
  }, [seekToken, apiReady]);

  // Fallback iframe URL used when the IFrame API failed to load.
  const fallbackSrc = useMemo(() => {
    if (!youtubeId) return null;
    const params = new URLSearchParams({ rel: '0', modestbranding: '1' });
    if (seekToken && seekToken.t > 0) {
      params.set('start', String(seekToken.t));
      params.set('autoplay', '1');
    }
    return `https://www.youtube-nocookie.com/embed/${youtubeId}?${params.toString()}`;
  }, [youtubeId, seekToken]);

  return (
    <div className="aspect-video w-full rounded-xl overflow-hidden bg-black/80 shadow-[0_8px_30px_rgba(14,23,69,0.12)] dark:shadow-none">
      {!youtubeId ? (
        <div className="w-full h-full flex items-center justify-center text-white/40 text-sm">
          Cargando video…
        </div>
      ) : apiFailed && fallbackSrc ? (
        <iframe
          key={seekToken?.n ?? 0}
          src={fallbackSrc}
          title="Video de plenaria"
          className="w-full h-full"
          allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <div ref={containerRef} className="w-full h-full" />
      )}
    </div>
  );
}

// --- Resumen ------------------------------------------------------------

function ResumenPanel({ resumen }: { resumen?: SessionDetail['resumen'] }) {
  if (!resumen) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-white/40 dark:bg-white/[0.03] animate-pulse" />
        ))}
      </div>
    );
  }

  const cards: Array<{ key: string; title: string; emoji: string; body: string | null }> = [
    { key: 'ejecutivo',    title: 'Resumen ejecutivo', emoji: '🧾', body: resumen.ejecutivo },
    { key: 'puntos_clave', title: 'Puntos clave',      emoji: '📌', body: resumen.puntos_clave },
    { key: 'acuerdos',     title: 'Acuerdos y mociones', emoji: '⚖️', body: resumen.acuerdos },
  ];

  return (
    <div className="space-y-3">
      {cards.map((c) => (
        <article
          key={c.key}
          className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] shadow-[0_2px_10px_rgba(14,23,69,0.03)] dark:shadow-none p-4 sm:p-5"
        >
          <header className="flex items-center gap-2 mb-2">
            <span className="text-base" aria-hidden>{c.emoji}</span>
            <h3 className="text-sm font-semibold text-[#0e1745] dark:text-white">{c.title}</h3>
          </header>
          {c.body ? (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-li:my-0.5 text-[13.5px] leading-relaxed text-gray-700 dark:text-gray-300">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-xs text-gray-400 italic">Sin contenido para esta sección.</p>
          )}
        </article>
      ))}
    </div>
  );
}

// --- Transcript ---------------------------------------------------------

function TranscriptPanel({
  transcript, segments, search, setSearch, onSeek, currentTime,
}: {
  transcript: TranscriptPayload | null;
  segments: TranscriptSegment[];
  search: string;
  setSearch: (v: string) => void;
  onSeek: (t: number) => void;
  /** Live playhead (seconds, float). 0 when paused/cued. */
  currentTime: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  // When the user scrolls manually we suppress auto-scroll for a few
  // seconds — otherwise the panel fights them. Refresh the timestamp
  // on every wheel/touchmove; auto-scroll only runs when this is older
  // than USER_SCROLL_PAUSE_MS.
  const userScrolledAtRef = useRef(0);
  const USER_SCROLL_PAUSE_MS = 4000;

  // Active segment by binary-searching the playhead against segment.start.
  // `segments` may be filtered by the search box, but we want highlighting
  // to track the FULL transcript so the user always sees what's playing
  // — even if they're searching something else. So we search against the
  // unfiltered list when present.
  const fullList = transcript?.segments ?? segments;
  const activeIndex = useMemo(() => {
    if (!fullList.length) return -1;
    if (currentTime <= 0) return -1;
    let lo = 0;
    let hi = fullList.length - 1;
    let result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fullList[mid]!.start <= currentTime) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  }, [fullList, currentTime]);

  const activeSegmentIndex = activeIndex >= 0 ? fullList[activeIndex]?.index : null;

  // Auto-scroll the active row into view, with a user-override window so
  // the panel never yanks the operator while they're reading.
  useEffect(() => {
    if (activeSegmentIndex == null) return;
    const sinceUser = Date.now() - userScrolledAtRef.current;
    if (sinceUser < USER_SCROLL_PAUSE_MS) return;
    const el = activeRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeSegmentIndex]);

  // Track manual scroll so we know to back off auto-scroll. Wheel/touch
  // covers the actual user gestures; the smooth scrolling we trigger
  // ourselves doesn't fire wheel events.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onUser = () => { userScrolledAtRef.current = Date.now(); };
    el.addEventListener('wheel', onUser, { passive: true });
    el.addEventListener('touchmove', onUser, { passive: true });
    return () => {
      el.removeEventListener('wheel', onUser);
      el.removeEventListener('touchmove', onUser);
    };
  }, []);

  if (!transcript) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-sm text-gray-400 gap-2 p-6">
        <MessageSquare size={28} className="opacity-30" />
        <p>Transcripción no disponible aún.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-3 pt-2 pb-2 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Buscar en ${transcript.word_count.toLocaleString('es-CR')} palabras…`}
            aria-label="Buscar en transcripción"
            className="w-full pl-8 pr-3 py-1.5 rounded-md bg-gray-50 dark:bg-white/5 border border-transparent text-xs transition focus:outline-none focus:ring-2 focus:ring-cl2-accent/30 focus:border-cl2-accent/40"
          />
        </div>
      </div>
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-1 py-2">
        {segments.length === 0 ? (
          <p className="text-center text-xs text-gray-400 py-8">Sin coincidencias.</p>
        ) : (
          <ul className="divide-y divide-[#0e1745]/[0.04] dark:divide-white/[0.04]">
            {segments.map((seg) => {
              const isActive = seg.index === activeSegmentIndex;
              return (
                <li key={seg.index} ref={isActive ? activeRef : null}>
                  <button
                    type="button"
                    onClick={() => onSeek(seg.start)}
                    className={cn(
                      'group w-full text-left px-3 py-2.5 transition-all',
                      isActive
                        ? 'bg-cl2-burgundy/[0.08] dark:bg-cl2-accent/[0.10] ring-1 ring-inset ring-cl2-burgundy/30 dark:ring-cl2-accent/30 shadow-[inset_2px_0_0_var(--color-cl2-accent)]'
                        : 'hover:bg-cl2-accent/5',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          'shrink-0 mt-0.5 text-[10px] font-mono tabular-nums transition-colors',
                          isActive
                            ? 'text-cl2-accent font-semibold'
                            : 'text-gray-400 group-hover:text-cl2-accent',
                        )}
                      >
                        {fmtClock(seg.start)}
                      </span>
                      <p
                        className={cn(
                          'text-[13px] leading-snug transition-colors',
                          isActive
                            ? 'text-[#0e1745] dark:text-white font-medium'
                            : 'text-gray-700 dark:text-gray-300',
                        )}
                      >
                        {seg.text}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
