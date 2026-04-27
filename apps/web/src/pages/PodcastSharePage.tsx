/**
 * /p/:token — public podcast share page.
 *
 * Anonymous landing for a shared podcast. The recipient does NOT need
 * an account. Token is the auth, signature on the GCS URL is the auth
 * for the audio bytes.
 *
 * Renders an editorial player layout (Newsreader headline + Figtree
 * body), the player itself, source attribution, and a "create your
 * own" CTA → /landing. Branded, not a raw mp3 dump.
 *
 * Failure modes (each shown as a helpful error rather than a blank
 * page):
 *   - 404 not_found     → token doesn't exist or revoked
 *   - 409 not_ready     → podcast is queued/scripting/tts (rare race)
 *   - 410 expired       → ttl ran out
 *   - other             → generic
 */
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowRight,
  Calendar,
  Download,
  ExternalLink,
  Headphones,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Sparkles,
} from 'lucide-react';
import { useTheme } from '@/lib/theme-context';
import { cn } from '@/lib/utils';

interface ShareInfo {
  url: string;        // signed GCS URL for the audio
  title: string | null;
  duration_s: number | null;
}

const SPEEDS = [1, 1.25, 1.5, 2] as const;
type Speed = (typeof SPEEDS)[number];

export function PodcastSharePage({ token }: { token: string }) {
  useTheme(); // ensure theme provider initialized
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<{ code: number; message: string } | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState<Speed>(1);

  useEffect(() => {
    let alive = true;
    const fetchShare = async () => {
      try {
        const res = await fetch(`/api/public/podcasts/share/${token}?json=1`);
        if (!alive) return;
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError({
            code: res.status,
            message: friendlyError(res.status, body.error),
          });
          setPhase('error');
          return;
        }
        const json = (await res.json()) as { ok: true } & ShareInfo;
        setInfo(json);
        setPhase('ready');
      } catch (err) {
        if (!alive) return;
        setError({ code: 0, message: (err as Error).message });
        setPhase('error');
      }
    };
    void fetchShare();
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed;
  }, [speed]);

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

  const pct = dur > 0 ? (t / dur) * 100 : 0;

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-mesh text-[#0e1745] dark:text-white font-sans relative overflow-x-hidden transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-50 z-0" />

      {/* Minimal nav — logo + "Crear el tuyo" CTA */}
      <header className="relative z-10 px-4 sm:px-6 md:px-8 pt-4">
        <div className="mx-auto max-w-[1080px] flex items-center justify-between">
          <a href="/landing" className="flex items-center gap-2.5 min-w-0">
            <div className="relative h-9 w-9 rounded-xl overflow-hidden shrink-0 cl2-mark">
              <span className="font-heading font-extrabold text-xs tracking-tight">CL2</span>
            </div>
            <div className="hidden sm:flex flex-col leading-tight">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45">
                Inteligencia Legislativa
              </span>
              <span className="text-[11.5px] font-medium text-[#0e1745]/75 dark:text-white/75">
                Asamblea de Costa Rica
              </span>
            </div>
          </a>
          <a
            href="/landing"
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[12.5px] font-semibold shadow-sm transition-colors"
          >
            <Sparkles size={12} />
            Conocer CL2
          </a>
        </div>
      </header>

      <main className="relative z-10 flex-1 flex items-center px-4 sm:px-6 md:px-8 py-12 md:py-16">
        <div className="mx-auto max-w-[760px] w-full">
          {phase === 'loading' && <LoadingState />}
          {phase === 'error' && error && <ErrorState code={error.code} message={error.message} />}
          {phase === 'ready' && info && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-7"
            >
              <div>
                <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-cl2-burgundy/30 bg-cl2-burgundy/[0.06] text-cl2-burgundy dark:text-cl2-accent-soft text-[10.5px] font-semibold uppercase tracking-[0.18em] mb-5">
                  <Headphones size={10} />
                  Podcast compartido
                </div>
                <h1 className="font-display font-light text-[36px] sm:text-[48px] md:text-[56px] leading-[1.04] tracking-[-0.02em] text-[#0e1745] dark:text-white">
                  {info.title ?? 'Audio de CL2'}
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
                  <span className="inline-flex items-center gap-1">
                    <Calendar size={12} />
                    Compartido contigo
                  </span>
                  {info.duration_s && (
                    <>
                      <span className="text-[#0e1745]/30 dark:text-white/30">·</span>
                      <span className="font-mono tabular-nums">{fmtDur(info.duration_s)}</span>
                    </>
                  )}
                  <span className="text-[#0e1745]/30 dark:text-white/30">·</span>
                  <span>narrado por Lexa</span>
                </div>
              </div>

              {/* Player card */}
              <div className="rounded-2xl border border-[#0e1745]/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/[0.025] backdrop-blur-sm shadow-[0_18px_60px_rgba(14,23,69,0.10)] dark:shadow-[0_18px_60px_rgba(0,0,0,0.40)] p-5 md:p-6">
                <audio
                  ref={audioRef}
                  src={info.url}
                  preload="metadata"
                  onLoadedMetadata={() => setDur(audioRef.current?.duration || 0)}
                  onTimeUpdate={() => setT(audioRef.current?.currentTime || 0)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                />

                <div className="flex items-center gap-3 md:gap-4">
                  <button
                    type="button"
                    onClick={togglePlay}
                    aria-label={playing ? 'Pausar' : 'Reproducir'}
                    className="shrink-0 inline-flex items-center justify-center w-12 h-12 md:w-14 md:h-14 rounded-full bg-cl2-burgundy text-white dark:bg-cl2-accent hover:bg-cl2-burgundy/90 dark:hover:bg-cl2-accent-hover transition-colors shadow-md"
                  >
                    {playing ? <Pause size={20} /> : <Play size={20} className="ml-[2px]" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => skip(-15)}
                    title="Atrás 15s"
                    className="hidden sm:inline-flex p-2 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white"
                  >
                    <RotateCcw size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => skip(15)}
                    title="Adelante 15s"
                    className="hidden sm:inline-flex p-2 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white"
                  >
                    <RotateCw size={16} />
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="relative h-1.5 rounded-full bg-[#0e1745]/[0.06] dark:bg-white/[0.08] overflow-hidden">
                      <div
                        className="absolute inset-y-0 left-0 bg-cl2-burgundy dark:bg-cl2-accent"
                        style={{ width: `${pct}%`, transition: 'width 120ms linear' }}
                      />
                      <input
                        type="range"
                        min={0}
                        max={dur || 0}
                        step={0.5}
                        value={t}
                        onChange={(e) => {
                          const el = audioRef.current;
                          if (el) el.currentTime = Number(e.target.value);
                        }}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        aria-label="Posición del audio"
                      />
                    </div>
                    <div className="flex items-center justify-between mt-1 font-mono text-[11px] tabular-nums text-[#0e1745]/55 dark:text-white/55">
                      <span>{fmtTime(t)}</span>
                      <span>{fmtTime(dur)}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={cycleSpeed}
                    title="Velocidad"
                    className="shrink-0 inline-flex items-center px-2.5 h-8 rounded-md text-[12px] font-mono font-semibold text-[#0e1745]/70 dark:text-white/70 border border-[#0e1745]/[0.10] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.05]"
                  >
                    {speed}x
                  </button>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3 text-[11.5px] text-[#0e1745]/60 dark:text-white/60">
                  <a
                    href={info.url}
                    download
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-cl2-burgundy dark:hover:text-cl2-accent-soft"
                  >
                    <Download size={11} /> Descargar mp3
                  </a>
                  <span className="text-[#0e1745]/25 dark:text-white/25">·</span>
                  <a
                    href={info.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-cl2-burgundy dark:hover:text-cl2-accent-soft"
                  >
                    <ExternalLink size={11} /> Abrir audio crudo
                  </a>
                </div>
              </div>

              {/* Source attribution */}
              <div className="text-[12.5px] text-[#0e1745]/65 dark:text-white/65 leading-relaxed">
                Audio generado por <span className="italic font-medium text-cl2-burgundy dark:text-cl2-accent-soft">Lexa</span>,
                asesora legislativa de CL2. Cada afirmación factual del guion está respaldada
                por el archivo legislativo de la Asamblea de Costa Rica. Sin cita, sin
                respuesta.
              </div>

              {/* CTA — convert listener into prospect */}
              <div className="rounded-2xl border border-cl2-accent/30 bg-cl2-accent/[0.05] dark:bg-cl2-accent/[0.10] p-5 md:p-6">
                <div className="flex items-start gap-4">
                  <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-cl2-accent text-white shrink-0">
                    <Sparkles size={16} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-display text-[20px] md:text-[22px] tracking-tight text-[#0e1745] dark:text-white leading-snug">
                      ¿Querés generar tus propios briefings de audio?
                    </div>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-[#0e1745]/70 dark:text-white/70">
                      CL2 convierte sesiones plenarias, expedientes del SIL y boards de
                      investigación en podcasts narrados — con cita verificable a cada paso.
                    </p>
                  </div>
                  <a
                    href="/landing"
                    className="hidden sm:inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[12.5px] font-semibold shrink-0"
                  >
                    Conocer CL2 <ArrowRight size={12} />
                  </a>
                </div>
                <a
                  href="/landing"
                  className="sm:hidden mt-4 inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[12.5px] font-semibold"
                >
                  Conocer CL2 <ArrowRight size={12} />
                </a>
              </div>
            </motion.div>
          )}
        </div>
      </main>

      <footer className="relative z-10 border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] px-4 sm:px-6 md:px-8 py-6 mt-2">
        <div className="mx-auto max-w-[1080px] flex items-center justify-between text-[11px] text-[#0e1745]/55 dark:text-white/55">
          <span>© {new Date().getFullYear()} Shift · Costa Rica</span>
          <a href="/landing" className="hover:text-[#0e1745] dark:hover:text-white">
            agentescl2.com
          </a>
        </div>
      </footer>
    </div>
  );
}

// ─── States ──────────────────────────────────────────────────────────

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-24">
      <Loader2 size={28} className="animate-spin text-cl2-burgundy dark:text-cl2-accent-soft" />
    </div>
  );
}

function ErrorState({ code, message }: { code: number; message: string }) {
  return (
    <div className="text-center py-16">
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-300 mb-4">
        <Headphones size={20} />
      </div>
      <h1 className="font-display font-light text-[28px] tracking-tight text-[#0e1745] dark:text-white">
        {code === 410 ? 'Este link expiró' : code === 404 ? 'Link no encontrado' : 'No se pudo cargar el audio'}
      </h1>
      <p className="mt-3 text-[14px] text-[#0e1745]/65 dark:text-white/65 max-w-[44ch] mx-auto">
        {message}
      </p>
      <a
        href="/landing"
        className={cn(
          'mt-7 inline-flex items-center gap-1.5 px-4 py-2 rounded-md',
          'bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[12.5px] font-semibold',
        )}
      >
        Conocer CL2 <ArrowRight size={12} />
      </a>
    </div>
  );
}

function friendlyError(code: number, errCode?: string): string {
  if (code === 410 || errCode === 'expired') {
    return 'El emisor configuró este link con una fecha de expiración. Pedile que genere uno nuevo.';
  }
  if (code === 404 || errCode === 'not_found') {
    return 'El link es inválido o el podcast fue revocado por su emisor.';
  }
  if (code === 409 || errCode === 'not_ready') {
    return 'El audio todavía se está generando. Probá de nuevo en un minuto.';
  }
  return 'Algo no salió bien del lado nuestro. Probá refrescar la página.';
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function fmtDur(s: number): string {
  if (!s) return '';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m ${String(r).padStart(2, '0')}s`;
}
