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
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, Calendar, Check as CheckIcon, Clock, Eye, EyeOff, FileSliders, MessageSquare, Search, Sparkles, X } from 'lucide-react';
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
  // True only while the YT player is actually PLAYING. Drives the
  // transcript focus-mode blur (we lift the blur on pause so the user
  // can read freely without toggling).
  const [isPlaying, setIsPlaying] = useState(false);
  // Prefill state for AnimatedAiInput. Bumping `nonce` triggers the
  // composer to swap its current draft for `text` and focus the
  // textarea with the caret at the end. Used by "Enviar a Lexa" from
  // both the transcript multi-select and the resumen cards.
  const [chatPrefill, setChatPrefill] = useState<{ text: string; nonce: number } | null>(null);

  const sendToLexa = (contextText: string) => {
    const lead = detail ? `sesión #${detail.id}` : 'esta sesión';
    const draft = `Sobre ${lead}:\n\n${contextText.trim()}\n\nMi pregunta: `;
    setChatPrefill({ text: draft, nonce: Date.now() });
    setTab('chat');
  };

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
              onPlayStateChange={setIsPlaying}
            />
            <div className="mt-5">
              <ResumenPanel
                resumen={detail?.resumen}
                detail={detail}
                transcript={transcript}
                onSendToLexa={sendToLexa}
              />
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
                  isPlaying={isPlaying}
                  onSendToLexa={sendToLexa}
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
                    prefill={chatPrefill}
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
  onPlayStateChange,
}: {
  youtubeId: string | null;
  seekToken: { t: number; n: number } | null;
  /** Fired ~4× per second while the video is PLAYING with the current
   *  position in seconds (float). Pauses tick when the player isn't
   *  PLAYING so the parent doesn't churn re-renders for nothing. */
  onTimeUpdate?: (seconds: number) => void;
  /** Fired whenever YT.PlayerState transitions. Lets the transcript
   *  pane gate its focus-mode blur to actual playback instead of
   *  blurring while the user paused to study a segment. */
  onPlayStateChange?: (isPlaying: boolean) => void;
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
  const onPlayStateChangeRef = useRef(onPlayStateChange);
  useEffect(() => { onPlayStateChangeRef.current = onPlayStateChange; }, [onPlayStateChange]);

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
          const playing = e.data === 1;
          if (playing) startPolling();
          else stopPolling();
          onPlayStateChangeRef.current?.(playing);
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

type ResumenVariant = 'ejecutivo' | 'puntos_clave' | 'acuerdos';

function ResumenPanel({
  resumen,
  detail,
  transcript,
  onSendToLexa,
}: {
  resumen?: SessionDetail['resumen'];
  /** Whole session detail — feeds the ejecutivo's stats strip with
   *  duration, etc. Optional so the panel still works during initial
   *  load before the detail fetch lands. */
  detail?: SessionDetail | null;
  /** Transcript payload — contributes word/segment counts to the stats
   *  strip. Optional; missing transcript just hides those tiles. */
  transcript?: TranscriptPayload | null;
  /** When provided, each resumen card shows a small "Enviar a Lexa"
   *  affordance that pushes that card's body into the chat composer
   *  as draft context (see SesionViewPage.sendToLexa). */
  onSendToLexa?: (text: string) => void;
}) {
  if (!resumen) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl bg-white/40 dark:bg-white/[0.03] animate-pulse" />
        ))}
      </div>
    );
  }

  const cards: Array<{ key: ResumenVariant; title: string; emoji: string; body: string | null }> = [
    { key: 'ejecutivo',    title: 'Resumen ejecutivo',   emoji: '🧾', body: resumen.ejecutivo },
    { key: 'puntos_clave', title: 'Puntos clave',         emoji: '📌', body: resumen.puntos_clave },
    { key: 'acuerdos',     title: 'Acuerdos y mociones', emoji: '⚖️', body: resumen.acuerdos },
  ];

  return (
    <div className="space-y-3">
      {cards.map((c) => (
        <article
          key={c.key}
          className="group/card relative rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] shadow-[0_2px_10px_rgba(14,23,69,0.03)] dark:shadow-none p-4 sm:p-5"
        >
          <header className="flex items-center gap-2 mb-3">
            <span className="text-base" aria-hidden>{c.emoji}</span>
            <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/55 dark:text-white/55 flex-1">
              {c.title}
            </h3>
            {onSendToLexa && c.body && (
              <button
                type="button"
                onClick={() => onSendToLexa(`${c.title}:\n${c.body}`)}
                title="Enviar a Lexa como contexto"
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-medium',
                  'border border-[#0e1745]/[0.08] dark:border-white/[0.10]',
                  'text-[#0e1745]/65 dark:text-white/65',
                  'hover:bg-cl2-accent/[0.08] hover:text-cl2-accent hover:border-cl2-accent/30',
                  'opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 transition-all',
                )}
                aria-label={`Enviar ${c.title} a Lexa`}
              >
                <Sparkles size={11} strokeWidth={2} />
                <span>Enviar a Lexa</span>
              </button>
            )}
          </header>
          {c.key === 'ejecutivo' ? (
            // Ejecutivo always renders — its stats + expedientes pills
            // come from session metadata + transcript, not from the
            // resumen body. Even when the legacy worker hasn't filled
            // the executive paragraph yet, the strip carries weight.
            <ExecutivoBody body={c.body} detail={detail} transcript={transcript} />
          ) : c.body ? (
            <ResumenBody variant={c.key} body={c.body} onSendToLexa={onSendToLexa} />
          ) : (
            <p className="text-xs text-gray-400 italic">Sin contenido para esta sección.</p>
          )}
        </article>
      ))}
    </div>
  );
}

/**
 * Per-variant rendering of the resumen body. Each section gets its own
 * voice instead of a generic markdown blob:
 *
 *  - ejecutivo:    editorial paragraph treatment with a soft drop cap
 *                  on the first letter, generous leading, Newsreader
 *                  feel without going full serif. Reads as a press
 *                  briefing.
 *  - puntos_clave: numbered cards. Each bullet becomes a row with a
 *                  coral count chip + hover-only "send" affordance,
 *                  so the operator can ship a single point to Lexa.
 *  - acuerdos:     verdict-styled rows. We try to detect status verbs
 *                  ("aprobó/aprobada", "rechazó/rechazada", "eligió",
 *                  "pospuso") and stamp a colored pill at the start of
 *                  each row. Falls back to a neutral pill when no
 *                  verb is recognized — never inventing.
 */
function ResumenBody({
  variant,
  body,
  onSendToLexa,
}: {
  variant: ResumenVariant;
  body: string;
  onSendToLexa?: (text: string) => void;
}) {
  if (variant === 'ejecutivo') {
    return <ExecutivoBody body={body} />;
  }
  // Both puntos_clave and acuerdos are bulleted lists in legacy markdown.
  // We extract the bullets ourselves so we can render each as a styled
  // row with custom marker + per-item action button. Falls back to plain
  // markdown when the body isn't a list (defensive — legacy formatting
  // can drift).
  const items = extractListItems(body);
  if (items.length === 0) {
    return (
      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-li:my-0.5 text-[13.5px] leading-relaxed text-gray-700 dark:text-gray-300">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
      </div>
    );
  }
  if (variant === 'puntos_clave') {
    return <PuntosList items={items} onSendToLexa={onSendToLexa} />;
  }
  return <AcuerdosList items={items} onSendToLexa={onSendToLexa} />;
}

/**
 * Executive summary body — three structural pieces, each fed from a
 * different source so the card has rhythm even when one source is
 * empty:
 *
 *   1. Stats strip (4 tiles)         ← session detail + transcript
 *   2. Expedientes citados (pills)   ← regex over the body
 *   3. Body paragraph                ← legacy resumen.ejecutivo
 *
 * Tile data, expediente pills, and body all arrive from independent
 * sources, so the card never collapses to a single huge paragraph.
 * If body is null, the strip + (empty pill row dropped) still hold
 * the card together.
 */
function ExecutivoBody({
  body,
  detail,
  transcript,
}: {
  body: string | null;
  detail?: SessionDetail | null;
  transcript?: TranscriptPayload | null;
}) {
  const expedientes = useMemo(() => extractExpedientes(body ?? ''), [body]);

  // Stat tiles — only render the ones we actually have data for, so
  // missing pieces don't show "—" placeholders. The grid auto-fits.
  const tiles: Array<{ label: string; value: string; sub?: string }> = [];
  if (detail?.duration_s) {
    tiles.push({ label: 'Duración', value: fmtDuration(detail.duration_s) });
  }
  if (transcript?.word_count) {
    tiles.push({
      label: 'Palabras',
      value: transcript.word_count.toLocaleString('es-CR'),
      sub: transcript.duration_s
        ? `${Math.round(transcript.word_count / Math.max(transcript.duration_s / 60, 1))} wpm`
        : undefined,
    });
  }
  if (transcript?.segment_count) {
    tiles.push({ label: 'Segmentos', value: transcript.segment_count.toLocaleString('es-CR') });
  }
  if (expedientes.length > 0) {
    tiles.push({ label: 'Expedientes', value: String(expedientes.length), sub: 'citados' });
  }

  return (
    <div className="space-y-4">
      {tiles.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {tiles.map((t) => (
            <div
              key={t.label}
              className="rounded-lg border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.02] dark:bg-white/[0.02] px-3 py-2.5"
            >
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/50">
                {t.label}
              </div>
              <div className="mt-0.5 font-display text-[20px] font-normal leading-[1.05] tabular-nums text-[#0e1745] dark:text-white">
                {t.value}
              </div>
              {t.sub && (
                <div className="text-[10px] text-[#0e1745]/55 dark:text-white/55 mt-0.5">{t.sub}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {expedientes.length > 0 && (
        <div>
          <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/45 dark:text-white/45 mb-2">
            Expedientes citados
          </div>
          <div className="flex flex-wrap gap-1.5">
            {expedientes.map((numero) => (
              <a
                key={numero}
                href={`/expediente/${numero.replace(/\./g, '')}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/expediente/${numero.replace(/\./g, '')}`);
                }}
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-1 rounded-full',
                  'bg-cl2-burgundy/[0.08] dark:bg-cl2-accent/[0.10]',
                  'border border-cl2-burgundy/20 dark:border-cl2-accent/30',
                  'font-mono text-[11px] font-semibold text-cl2-burgundy dark:text-cl2-accent-soft',
                  'hover:bg-cl2-burgundy/[0.14] dark:hover:bg-cl2-accent/[0.18] transition-colors',
                )}
              >
                Exp. {numero}
              </a>
            ))}
          </div>
        </div>
      )}

      {body ? (
        <div className="border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] pt-3.5">
          <div
            className={cn(
              'text-[13.5px] leading-[1.65] text-[#0e1745]/85 dark:text-white/80',
              'prose prose-sm dark:prose-invert max-w-none',
              'prose-p:my-3 prose-p:leading-[1.65] prose-p:first-of-type:mt-0',
              // Subtle drop cap on the first paragraph — Newsreader,
              // burgundy, float-left so the body wraps around it.
              '[&>div>p:first-of-type]:first-letter:font-display',
              '[&>div>p:first-of-type]:first-letter:text-[2.2em]',
              '[&>div>p:first-of-type]:first-letter:font-normal',
              '[&>div>p:first-of-type]:first-letter:leading-[0.9]',
              '[&>div>p:first-of-type]:first-letter:mr-[0.08em]',
              '[&>div>p:first-of-type]:first-letter:float-left',
              '[&>div>p:first-of-type]:first-letter:text-cl2-burgundy',
              'dark:[&>div>p:first-of-type]:first-letter:text-cl2-accent-soft',
            )}
          >
            <div>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
            </div>
          </div>
        </div>
      ) : (
        <p className="border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] pt-3.5 text-[12px] text-[#0e1745]/45 dark:text-white/45 italic">
          Resumen ejecutivo aún no procesado para esta sesión.
        </p>
      )}
    </div>
  );
}

/** Pull expediente numbers from a body string. Tolerates "expediente
 *  24649", "Exp. 23.456", "exp 24.018". Dedupes preserving first-seen
 *  order. Numbers are returned in their human format with the dot
 *  separator when present. */
function extractExpedientes(body: string): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  // Match: word "expediente" or "Exp." or "exp" followed by 1+ digits,
  // optionally with a dot every 3 digits. We capture only the digits
  // (dotted or not) and normalize to the legacy display format.
  const rx = /\b(?:expedientes?|exp\.?)\s*(\d{1,2}(?:[.,]?\d{3})?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(body)) !== null) {
    const raw = m[1]!.replace(/[,]/g, '.');
    // Normalize "24649" → "24.649" for display consistency.
    let display = raw;
    if (!raw.includes('.') && raw.length === 5) {
      display = `${raw.slice(0, 2)}.${raw.slice(2)}`;
    }
    if (!seen.has(display)) {
      seen.add(display);
      out.push(display);
    }
  }
  return out;
}

function PuntosList({
  items,
  onSendToLexa,
}: {
  items: string[];
  onSendToLexa?: (text: string) => void;
}) {
  return (
    <ol className="space-y-2">
      {items.map((text, i) => (
        <li
          key={i}
          className="group/pt relative flex gap-3 rounded-lg border border-transparent px-2 py-2 transition-colors hover:border-[#0e1745]/[0.06] dark:hover:border-white/[0.06] hover:bg-[#0e1745]/[0.015] dark:hover:bg-white/[0.025]"
        >
          <span
            className="shrink-0 mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-cl2-accent/10 dark:bg-cl2-accent/20 text-cl2-accent dark:text-cl2-accent-soft text-[10px] font-semibold tabular-nums"
            aria-hidden
          >
            {i + 1}
          </span>
          <p className="flex-1 text-[13.5px] leading-relaxed text-[#0e1745]/85 dark:text-white/85">
            {text}
          </p>
          {onSendToLexa && (
            <button
              type="button"
              onClick={() => onSendToLexa(`Punto clave:\n${text}`)}
              title="Enviar este punto a Lexa"
              aria-label="Enviar este punto a Lexa"
              className={cn(
                'shrink-0 self-center inline-flex items-center justify-center h-6 w-6 rounded-md',
                'text-[#0e1745]/55 dark:text-white/55',
                'hover:bg-cl2-accent/[0.10] hover:text-cl2-accent',
                'opacity-0 group-hover/pt:opacity-100 focus-visible:opacity-100 transition-opacity',
              )}
            >
              <Sparkles size={11} strokeWidth={2} />
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

interface VerdictMatch {
  label: string;
  tone: 'success' | 'danger' | 'info' | 'warn' | 'neutral';
}

const VERDICT_RULES: Array<{ rx: RegExp; verdict: VerdictMatch }> = [
  { rx: /\b(aprob(ó|ado|ada|aron)|admisibilidad|admiti)\b/i,         verdict: { label: 'Aprobado',  tone: 'success' } },
  { rx: /\brechaz(ó|ado|ada|aron)\b/i,                                  verdict: { label: 'Rechazado', tone: 'danger'  } },
  { rx: /\b(pospuso|pospuesta|pospuesto|posponer)\b/i,                  verdict: { label: 'Pospuesto', tone: 'warn'    } },
  { rx: /\b(eligi(ó|eron)|nombr(ó|ado|ada))\b/i,                        verdict: { label: 'Designación', tone: 'info'  } },
  { rx: /\b(ampli(ó|ación) de plazo|prórroga)\b/i,                      verdict: { label: 'Prórroga',  tone: 'info'    } },
  { rx: /\b(dispens(ó|ada|ado)|trámite urgente)\b/i,                    verdict: { label: 'Dispensa',  tone: 'info'    } },
];

function classifyAcuerdo(text: string): VerdictMatch {
  for (const rule of VERDICT_RULES) {
    if (rule.rx.test(text)) return rule.verdict;
  }
  return { label: 'Acuerdo', tone: 'neutral' };
}

const VERDICT_TONE: Record<VerdictMatch['tone'], string> = {
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  danger:  'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30',
  info:    'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30',
  warn:    'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30',
  neutral: 'bg-[#0e1745]/[0.06] dark:bg-white/[0.06] text-[#0e1745]/70 dark:text-white/70 border-[#0e1745]/[0.10] dark:border-white/[0.12]',
};

const VERDICT_RAIL: Record<VerdictMatch['tone'], string> = {
  success: 'bg-emerald-500',
  danger:  'bg-rose-500',
  info:    'bg-blue-500',
  warn:    'bg-amber-500',
  neutral: 'bg-[#0e1745]/15 dark:bg-white/20',
};

function AcuerdosList({
  items,
  onSendToLexa,
}: {
  items: string[];
  onSendToLexa?: (text: string) => void;
}) {
  return (
    <ul className="space-y-2">
      {items.map((text, i) => {
        const v = classifyAcuerdo(text);
        return (
          <li
            key={i}
            className="group/ac relative flex gap-3 rounded-lg border border-[#0e1745]/[0.05] dark:border-white/[0.05] bg-[#0e1745]/[0.015] dark:bg-white/[0.015] pl-3 pr-2 py-2.5 overflow-hidden"
          >
            {/* Status side rail — 2px stripe on the left edge that
                anchors the row visually and signals the verdict at a
                glance. */}
            <span aria-hidden className={cn('absolute left-0 top-0 bottom-0 w-[3px]', VERDICT_RAIL[v.tone])} />
            <div className="flex-1 min-w-0">
              <span
                className={cn(
                  'inline-flex items-center mb-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-[0.08em]',
                  VERDICT_TONE[v.tone],
                )}
              >
                {v.label}
              </span>
              <p className="text-[13px] leading-relaxed text-[#0e1745]/85 dark:text-white/85">
                {text}
              </p>
            </div>
            {onSendToLexa && (
              <button
                type="button"
                onClick={() => onSendToLexa(`Acuerdo (${v.label}):\n${text}`)}
                title="Enviar este acuerdo a Lexa"
                aria-label="Enviar este acuerdo a Lexa"
                className={cn(
                  'shrink-0 self-start inline-flex items-center justify-center h-6 w-6 rounded-md',
                  'text-[#0e1745]/55 dark:text-white/55',
                  'hover:bg-cl2-accent/[0.10] hover:text-cl2-accent',
                  'opacity-0 group-hover/ac:opacity-100 focus-visible:opacity-100 transition-opacity',
                )}
              >
                <Sparkles size={11} strokeWidth={2} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Pull bullet items out of a markdown list. Tolerates both `-` and `*`
 *  bullet markers + any depth of leading whitespace. Strips the marker
 *  and trims. Returns [] if the input doesn't look like a list. */
function extractListItems(md: string): string[] {
  const lines = md.split('\n');
  const items: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    items.push(buffer.join(' ').trim());
    buffer = [];
  };
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) {
      flush();
      buffer.push(m[1]!);
    } else if (buffer.length > 0 && line.trim() !== '') {
      // Continuation of the previous bullet (wrapped line).
      buffer.push(line.trim());
    } else if (line.trim() === '') {
      flush();
    }
  }
  flush();
  return items;
}

// --- Transcript ---------------------------------------------------------

function TranscriptPanel({
  transcript, segments, search, setSearch, onSeek, currentTime, isPlaying, onSendToLexa,
}: {
  transcript: TranscriptPayload | null;
  segments: TranscriptSegment[];
  search: string;
  setSearch: (v: string) => void;
  onSeek: (t: number) => void;
  /** Live playhead (seconds, float). 0 when paused/cued. */
  currentTime: number;
  /** True while YT player state === PLAYING. Drives the focus-mode
   *  blur (paused → blur lifts so the user can read freely). */
  isPlaying: boolean;
  /** When provided, multi-select shows a floating action bar with an
   *  "Enviar a Lexa" CTA that pushes the formatted selection into the
   *  chat composer as draft context. */
  onSendToLexa?: (text: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLLIElement>(null);
  // When the user scrolls manually we suppress auto-scroll for a few
  // seconds — otherwise the panel fights them. Refresh the timestamp
  // on every wheel/touchmove; auto-scroll only runs when this is older
  // than USER_SCROLL_PAUSE_MS.
  const userScrolledAtRef = useRef(0);
  const USER_SCROLL_PAUSE_MS = 4000;
  // Apple-Music-style focus mode. User toggles via the eye button; we
  // store in localStorage so the preference survives refresh. The blur
  // only takes effect while the video is actually PLAYING — pause
  // lifts everything so the user can scan freely without un-toggling.
  // Default ON — focus mode is the headline UX of the transcript pane.
  // First-time visitors should see it active so the magic happens
  // without a tutorial. Explicit user preference (set to '0' or '1')
  // wins over the default.
  const [focusMode, setFocusMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem('cl2.transcript.focusMode');
    if (stored === '0') return false;
    if (stored === '1') return true;
    return true; // first-paint default
  });
  useEffect(() => {
    localStorage.setItem('cl2.transcript.focusMode', focusMode ? '1' : '0');
  }, [focusMode]);
  const focusActive = focusMode && isPlaying;

  // Multi-select state: which segments has the user picked to ship to
  // Lexa as context? Set keyed by segment.index. `lastClickedRef`
  // anchors shift+click range selection (Finder-style).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const lastClickedIndexRef = useRef<number | null>(null);

  // Track if the user has ever discovered the multi-select shortcut so
  // we can hide the hint after first use. Persisted to localStorage so
  // power users don't see the tip on every load.
  const [didMultiSelect, setDidMultiSelect] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('cl2.transcript.didMultiSelect') === '1';
  });
  const markDiscovered = () => {
    if (didMultiSelect) return;
    setDidMultiSelect(true);
    localStorage.setItem('cl2.transcript.didMultiSelect', '1');
  };

  const toggleOne = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
    markDiscovered();
  };

  const selectRange = (anchorIdx: number, headIdx: number) => {
    // Find positions in the FULL ordered list so the range is stable
    // even when the user filters with the search box (then shift+clicks).
    const all = transcript?.segments ?? segments;
    const anchorPos = all.findIndex((s) => s.index === anchorIdx);
    const headPos = all.findIndex((s) => s.index === headIdx);
    if (anchorPos < 0 || headPos < 0) return;
    const lo = Math.min(anchorPos, headPos);
    const hi = Math.max(anchorPos, headPos);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = lo; i <= hi; i++) {
        const idx = all[i]?.index;
        if (typeof idx === 'number') next.add(idx);
      }
      return next;
    });
    markDiscovered();
  };

  const handleSegmentClick = (
    e: React.MouseEvent<HTMLButtonElement>,
    seg: TranscriptSegment,
  ) => {
    // Cmd/Ctrl+Click → toggle this one in the selection (no seek).
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      toggleOne(seg.index);
      lastClickedIndexRef.current = seg.index;
      return;
    }
    // Shift+Click → range from the last anchor to here. Falls back to
    // toggling just this one if no anchor exists yet.
    if (e.shiftKey) {
      e.preventDefault();
      const anchor = lastClickedIndexRef.current;
      if (anchor != null && anchor !== seg.index) {
        selectRange(anchor, seg.index);
      } else {
        toggleOne(seg.index);
      }
      lastClickedIndexRef.current = seg.index;
      return;
    }
    // Plain click → seek (existing behavior). Drop any open selection
    // so the user gets a clean state when they navigate away from
    // multi-pick mode.
    if (selected.size > 0) setSelected(new Set());
    lastClickedIndexRef.current = seg.index;
    onSeek(seg.start);
  };

  const sendSelectionToLexa = () => {
    if (!onSendToLexa || selected.size === 0) return;
    const all = transcript?.segments ?? segments;
    const ordered = all
      .filter((s) => selected.has(s.index))
      .sort((a, b) => a.start - b.start);
    const body = ordered
      .map((s) => `[${fmtClock(s.start)}] ${s.text}`)
      .join('\n');
    onSendToLexa(body);
    setSelected(new Set());
  };

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
    <div className="relative h-full flex flex-col min-h-0">
      <div className="px-3 pt-2 pb-2 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Buscar en ${transcript.word_count.toLocaleString('es-CR')} palabras…`}
              aria-label="Buscar en transcripción"
              className="w-full pl-8 pr-3 py-1.5 rounded-md bg-gray-50 dark:bg-white/5 border border-transparent text-xs transition focus:outline-none focus:ring-2 focus:ring-cl2-accent/30 focus:border-cl2-accent/40"
            />
          </div>
          {/*
            Focus-mode toggle. Apple-Music style: when ON and the video
            is playing, every segment except the active one fades + blurs.
            When the video pauses, the blur lifts automatically so the
            user can scan/read freely. Hover popover explains the
            behavior — kept inline (no library) so this stays cheap.
          */}
          <div className="relative group">
            <button
              type="button"
              role="switch"
              aria-checked={focusMode}
              aria-label={focusMode ? 'Desactivar modo enfoque' : 'Activar modo enfoque'}
              onClick={() => setFocusMode((v) => !v)}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-md border transition-all',
                focusMode
                  ? 'bg-cl2-accent/[0.10] border-cl2-accent/30 text-cl2-accent dark:text-cl2-accent-soft shadow-[0_0_0_3px_rgba(249,53,73,0.08)]'
                  : 'bg-gray-50 dark:bg-white/5 border-transparent text-gray-400 hover:text-[#0e1745] dark:hover:text-white hover:border-[#0e1745]/[0.10] dark:hover:border-white/[0.10]',
              )}
            >
              {focusMode ? <Eye size={14} strokeWidth={2} /> : <EyeOff size={14} strokeWidth={1.75} />}
            </button>
            <div
              role="tooltip"
              className={cn(
                'pointer-events-none absolute right-0 top-[calc(100%+6px)] z-30 w-60',
                'rounded-lg border border-[#0e1745]/[0.08] dark:border-white/10',
                'bg-white dark:bg-[#231f1f] px-3 py-2.5 shadow-[0_8px_24px_rgba(14,23,69,0.12)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.45)]',
                'opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0 transition-all duration-150',
              )}
            >
              <div className="text-[11.5px] font-semibold text-[#0e1745] dark:text-white mb-0.5">
                Modo enfoque
              </div>
              <div className="text-[11px] leading-relaxed text-[#0e1745]/65 dark:text-white/65">
                Mientras el video se reproduce, todo se difumina excepto el segmento que se está hablando. Pausá el video para volver a ver todo.
              </div>
            </div>
          </div>
        </div>
        {/*
          Discoverability hint for the multi-select gesture. Renders only
          while the user has never used shift/cmd+click in this browser.
          Disappears the first time they do, persisted in localStorage so
          power users don't get nagged on every visit. Sub-key style:
          tiny, italic, low contrast — present but not loud.
        */}
        {!didMultiSelect && transcript && segments.length > 1 && (
          <div className="mt-1.5 text-[10.5px] italic text-[#0e1745]/45 dark:text-white/40 flex items-center gap-1.5">
            <span className="inline-flex items-center font-mono not-italic px-1 py-px rounded text-[9.5px] bg-[#0e1745]/[0.05] dark:bg-white/[0.06] border border-[#0e1745]/[0.06] dark:border-white/[0.08]">
              shift
            </span>
            <span>+ clic en un segmento para seleccionar varios y mandarlos a Lexa</span>
          </div>
        )}
      </div>
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-1 py-2">
        {segments.length === 0 ? (
          <p className="text-center text-xs text-gray-400 py-8">Sin coincidencias.</p>
        ) : (
          <ul
            className={cn(
              // Drop the divider lines when focus is active — blurred
              // hairlines turn into a smudgy gradient that fights the
              // Apple-Music feel. Without focus we keep them for scan-
              // friendliness.
              focusActive ? '' : 'divide-y divide-[#0e1745]/[0.04] dark:divide-white/[0.04]',
            )}
          >
            {segments.map((seg) => {
              const isActive = seg.index === activeSegmentIndex;
              const isSelected = selected.has(seg.index);
              // Fade non-active rows when focus mode is engaged AND the
              // video is playing. Selected rows opt out of the dim so
              // the user can see what they picked. Each row also gets
              // a soft scale shift — the active grows imperceptibly,
              // the rest shrink — so the eye locks on the current
              // line without conscious effort.
              const dim = focusActive && !isActive && !isSelected;
              return (
                <li
                  key={seg.index}
                  ref={isActive ? activeRef : null}
                  className="transition-all duration-[380ms]"
                  style={{
                    filter: dim ? 'blur(2px)' : 'blur(0)',
                    opacity: dim ? 0.32 : 1,
                    transform: focusActive
                      ? isActive ? 'scale(1.015)' : 'scale(0.985)'
                      : 'scale(1)',
                    transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                >
                  <div
                    className={cn(
                      'group/seg relative w-full transition-all duration-300',
                      isSelected
                        // Selected wins visually over active so the user
                        // sees the picks they accumulated for context.
                        ? 'bg-cl2-accent/[0.12] dark:bg-cl2-accent/[0.18] ring-1 ring-inset ring-cl2-accent/40'
                        : isActive
                          ? 'bg-cl2-burgundy/[0.08] dark:bg-cl2-accent/[0.10] ring-1 ring-inset ring-cl2-burgundy/30 dark:ring-cl2-accent/30 shadow-[inset_2px_0_0_var(--color-cl2-accent)]'
                          : 'hover:bg-cl2-accent/5',
                    )}
                  >
                    <button
                      type="button"
                      onClick={(e) => handleSegmentClick(e, seg)}
                      className="block w-full text-left px-3 py-2.5"
                      title={
                        isSelected
                          ? 'Clic normal: ir al segundo · cmd+clic: quitar · shift+clic: rango'
                          : 'Clic: ir al segundo · cmd+clic: agregar · shift+clic: rango'
                      }
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={cn(
                            'shrink-0 mt-0.5 text-[10px] font-mono tabular-nums transition-colors',
                            isSelected
                              ? 'text-cl2-accent font-semibold'
                              : isActive
                                ? 'text-cl2-accent font-semibold'
                                : 'text-gray-400 group-hover/seg:text-cl2-accent',
                          )}
                        >
                          {fmtClock(seg.start)}
                        </span>
                        <p
                          className={cn(
                            'flex-1 text-[13px] leading-snug transition-colors pr-7',
                            isActive
                              ? 'text-[#0e1745] dark:text-white font-medium'
                              : 'text-gray-700 dark:text-gray-300',
                          )}
                        >
                          {seg.text}
                        </p>
                        {isSelected && (
                          <span
                            aria-hidden
                            className="shrink-0 mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-cl2-accent text-white"
                          >
                            <CheckIcon size={9} strokeWidth={3} />
                          </span>
                        )}
                      </div>
                    </button>
                    {/*
                      Per-segment "Enviar a Lexa" — only on hover, only
                      when nothing else is selected (otherwise the
                      floating action bar takes over). Sits absolute
                      on the right rail so it doesn't push layout.
                      onMouseDown stopPropagation prevents the click
                      from bubbling into the row's seek handler.
                    */}
                    {onSendToLexa && !isSelected && selected.size === 0 && (
                      <button
                        type="button"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSendToLexa(`[${fmtClock(seg.start)}] ${seg.text}`);
                        }}
                        title="Enviar este segmento a Lexa"
                        className={cn(
                          'absolute right-2 top-1/2 -translate-y-1/2',
                          'inline-flex items-center gap-1 px-1.5 py-1 rounded-md',
                          'text-[10px] font-medium',
                          'border border-[#0e1745]/[0.10] dark:border-white/[0.10]',
                          'bg-white/85 dark:bg-[#231f1f]/90 backdrop-blur-sm',
                          'text-[#0e1745]/70 dark:text-white/70',
                          'hover:text-cl2-accent hover:border-cl2-accent/40 hover:bg-cl2-accent/[0.06]',
                          'opacity-0 group-hover/seg:opacity-100 focus-visible:opacity-100 transition-all duration-150',
                          // Don't disturb focus-mode blur — the hover
                          // affordance is opt-in by mouse, no need to
                          // force visibility through the dim.
                        )}
                        aria-label="Enviar este segmento a Lexa"
                      >
                        <Sparkles size={10} strokeWidth={2.2} />
                        <span className="hidden sm:inline">A Lexa</span>
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/*
        Floating action bar — only renders when the user has picked
        ≥1 segment via shift/cmd+click. Slides up from the bottom of
        the transcript pane (not the viewport, so it stays scoped to
        the section). Uses motion/react instead of tailwindcss-animate
        because that plugin isn't in the build — motion is already a
        dep elsewhere in the app.
      */}
      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            key="selection-bar"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className={cn(
              'absolute left-3 right-3 bottom-3 z-20',
              'rounded-xl border border-cl2-accent/30 dark:border-cl2-accent/40',
              'bg-white/90 dark:bg-[#231f1f]/95 backdrop-blur-md',
              'shadow-[0_12px_30px_rgba(249,53,73,0.18)] dark:shadow-[0_12px_30px_rgba(0,0,0,0.45)]',
              'flex items-center gap-2 px-3 py-2',
            )}
          >
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-cl2-accent text-white text-[11px] font-semibold tabular-nums">
              {selected.size}
            </span>
            <span className="text-[12px] text-[#0e1745] dark:text-white">
              {selected.size === 1 ? 'segmento seleccionado' : 'segmentos seleccionados'}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.06] hover:text-[#0e1745] dark:hover:text-white transition-colors"
            >
              <X size={11} />
              Limpiar
            </button>
            <button
              type="button"
              onClick={sendSelectionToLexa}
              disabled={!onSendToLexa}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] font-semibold',
                'bg-cl2-accent text-white shadow-[0_4px_15px_rgba(249,53,73,0.25)]',
                'hover:bg-cl2-accent-hover',
                'disabled:opacity-50 disabled:cursor-not-allowed transition-all',
              )}
            >
              <Sparkles size={12} strokeWidth={2.5} />
              Enviar a Lexa
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
