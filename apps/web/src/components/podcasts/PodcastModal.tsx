/**
 * Podcast generation modal — opens from "Generar podcast" buttons on
 * SesionViewPage / ExpedienteViewPage / chat message menu / Hojas board.
 *
 * UX:
 *   1. Pick voice + length + style
 *   2. (Optional) write a ≤140-char directive — "Mejorar con Lexa" rewrites it
 *   3. Generate → polls /api/podcasts/:id every 2s
 *   4. Ready → unified audio player (one play button, seek, time, speed)
 *   5. Failed → error + retry
 *
 * Visual:
 *   - Modal shadow uses cl2-burgundy tint (was indigo) so the halo
 *     reads as brand-red, not legacy navy.
 *   - Audio player replaces native <audio controls> — no browser
 *     focus halo, single play button, custom progress + speed.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Download, Headphones, Loader2, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  AudioPlayerProvider,
  AudioPlayerButton,
  AudioPlayerProgress,
  AudioPlayerTime,
  AudioPlayerDuration,
  AudioPlayerSpeed,
  useAudioPlayer,
} from '@/components/ui/audio-player';
import {
  createPodcast,
  enhancePodcastPrompt,
  getPodcast,
  getPodcastQuota,
  listVoices,
  resolvePodcastAudioUrl,
  type PodcastQuota,
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

const PROMPT_MAX = 140;

export function PodcastModal({ open, onClose, source_type, source_id, source_title }: Props) {
  const [voices, setVoices] = useState<PodcastVoice[]>([]);
  const [voiceId, setVoiceId] = useState<string>('');
  const [duration, setDuration] = useState<Duration>(180);
  const [style, setStyle] = useState<PodcastStyle>('informativo');
  const [userPrompt, setUserPrompt] = useState('');
  const [enhancing, setEnhancing] = useState(false);

  const [phase, setPhase] = useState<'config' | 'running' | 'ready' | 'error'>('config');
  const [job, setJob] = useState<PodcastRow | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<PodcastQuota | null>(null);

  // Load voices + quota on first open. Cached for the modal lifetime.
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
    getPodcastQuota()
      .then((q) => alive && setQuota(q))
      .catch(() => null);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset on close.
  useEffect(() => {
    if (open) return;
    setPhase('config');
    setJob(null);
    setAudioUrl(null);
    setError(null);
    setUserPrompt('');
    setEnhancing(false);
  }, [open]);

  // Polling lives in its own effect so it can be torn down on
  // unmount/close without leaking the interval. Set up only when we
  // have a job id and we're in 'running' state.
  useEffect(() => {
    if (phase !== 'running' || !job?.id) return;
    let alive = true;
    const id = job.id;
    const tick = async () => {
      if (!alive) return;
      try {
        const row = await getPodcast(id);
        if (!alive) return;
        setJob(row);
        if (row.status === 'ready') {
          try {
            const url = await resolvePodcastAudioUrl(id);
            if (!alive) return;
            setAudioUrl(url);
            setPhase('ready');
          } catch (err) {
            if (!alive) return;
            setError((err as Error).message);
            setPhase('error');
          }
        } else if (row.status === 'failed' || row.status === 'cancelled') {
          if (!alive) return;
          setError(row.error ?? 'Falló la generación.');
          setPhase('error');
        }
      } catch (err) {
        if (!alive) return;
        setError((err as Error).message);
      }
    };
    void tick();
    const handle = setInterval(() => void tick(), 2_000);
    return () => { alive = false; clearInterval(handle); };
  }, [phase, job?.id]);

  const startGen = async () => {
    if (!voiceId) return;
    setError(null);
    try {
      const { id } = await createPodcast({
        source_type,
        source_id,
        voice_id: voiceId,
        duration_target_s: duration,
        style,
        user_prompt: userPrompt.trim() || undefined,
      });
      // Seed job with the id so the polling effect can pick it up.
      setJob({ id } as PodcastRow);
      setPhase('running');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  const enhance = async () => {
    if (!userPrompt.trim() || enhancing) return;
    setEnhancing(true);
    setError(null);
    try {
      const better = await enhancePodcastPrompt(userPrompt.trim());
      setUserPrompt(better);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEnhancing(false);
    }
  };

  if (!open) return null;

  // Portal a document.body para escapar stacking context. Defensivo —
  // si el modal se monta dentro de un motion ancestro (cards animadas
  // del workspace, ScrollAreas con transform, etc.), el position:fixed
  // del backdrop queda atrapado en ese contexto. Misma fix que aplicada
  // a PodcastShareModal y TranscriptDownloadButton.
  return createPortal(
    <AnimatePresence>
      <motion.div
        key="backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-[200] bg-black/55 backdrop-blur-sm"
      />
      <motion.div
        key="dialog"
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.97 }}
        transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        // Burgundy shadow — was rgba(14,23,69,...) (indigo). The blue
        // halo behind the audio area was the indigo tint reading
        // through the player border + the native <audio> focus ring.
        // Both gone now.
        className="fixed left-1/2 top-1/2 z-[201] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-cl2-burgundy/[0.10] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] shadow-[0_30px_80px_rgba(122,59,71,0.28),0_8px_24px_rgba(122,59,71,0.14)]"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-cl2-burgundy/[0.08] dark:border-white/[0.06]">
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

              {/* Optional directive — same idiom as Hojas /lexa inline.
                  140-char cap matches script.user_prompt budget. */}
              <Group label="Directriz para Lexa (opcional)">
                <PromptBox
                  value={userPrompt}
                  onChange={setUserPrompt}
                  onEnhance={() => void enhance()}
                  enhancing={enhancing}
                />
                <p className="mt-1.5 text-[10.5px] text-[#0e1745]/50 dark:text-white/50">
                  Ej: "enfatizá el impacto fiscal y citá a las fracciones a favor". Lexa lo respeta sin contradecir el material fuente.
                </p>
              </Group>

              {error && (
                <div className="rounded-md border border-rose-300/40 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 px-3 py-2 text-[12.5px] text-rose-700 dark:text-rose-300">
                  {error}
                </div>
              )}
            </div>
          )}

          {phase === 'running' && <RunningPanel job={job} />}

          {phase === 'ready' && audioUrl && job && (
            <ReadyPanel job={job} audioUrl={audioUrl} />
          )}

          {phase === 'error' && (
            <div className="py-4 space-y-3">
              <div className="text-[13px] text-[#0e1745] dark:text-white">
                No se pudo generar el podcast.
              </div>
              <div className="text-[12px] text-rose-700 dark:text-rose-300 font-mono break-words">
                {error ?? 'error desconocido'}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-cl2-burgundy/[0.08] dark:border-white/[0.06]">
          {phase === 'config' ? (
            <>
              {quota && (
                <span
                  className={cn(
                    'text-[11.5px]',
                    quota.remaining === 0
                      ? 'text-rose-600 dark:text-rose-400 font-semibold'
                      : quota.used / quota.limit >= 0.8
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-[#0e1745]/55 dark:text-white/55',
                  )}
                  title="Cuota diaria por usuario — se reinicia cada 24h"
                >
                  {quota.remaining === 0
                    ? `Sin cuota — volvé en 24h`
                    : `${quota.used} de ${quota.limit} usados hoy`}
                </span>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!voiceId || quota?.remaining === 0}
                  onClick={() => void startGen()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-cl2-accent hover:bg-cl2-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-[12.5px] font-semibold"
                >
                  <Headphones size={13} />
                  Generar
                </button>
              </div>
            </>
          ) : null}
          {phase === 'running' && (
            <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
              Esto suele tomar entre 30 y 90 segundos.
            </span>
          )}
          {(phase === 'ready' || phase === 'error') && (
            <button
              type="button"
              onClick={onClose}
              className="ml-auto px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
            >
              Cerrar
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
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

/**
 * Prompt input with a "Mejorar con Lexa" affordance. Same idiom as the
 * Hojas /lexa inline modal — sparkles icon, burgundy accent, replaces
 * the textarea content on success. Keystroke contract: Cmd/Ctrl+Enter
 * triggers enhance (matches the /lexa shortcut in the editor).
 */
function PromptBox({
  value,
  onChange,
  onEnhance,
  enhancing,
}: {
  value: string;
  onChange: (v: string) => void;
  onEnhance: () => void;
  enhancing: boolean;
}) {
  const remaining = PROMPT_MAX - value.length;
  const overWarn = remaining < 20;

  return (
    <div
      className={cn(
        'rounded-lg border bg-[#0e1745]/[0.02] dark:bg-white/[0.03] focus-within:border-cl2-burgundy/40 transition-colors',
        overWarn ? 'border-amber-300/50 dark:border-amber-500/30' : 'border-[#0e1745]/[0.10] dark:border-white/[0.10]',
      )}
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value.slice(0, PROMPT_MAX))}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && value.trim()) {
            e.preventDefault();
            onEnhance();
          }
        }}
        rows={2}
        placeholder="Decile a Lexa qué destacar… (opcional)"
        className="w-full bg-transparent resize-none px-3 py-2 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/35 focus:outline-none"
      />
      <div className="flex items-center justify-between gap-2 px-2 pb-1.5 pt-0">
        <button
          type="button"
          onClick={onEnhance}
          disabled={!value.trim() || enhancing}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold text-cl2-burgundy dark:text-[#d8a4ad] hover:bg-cl2-burgundy/[0.08] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="Mejorar el prompt con Lexa (⌘/Ctrl+Enter)"
        >
          {enhancing ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          {enhancing ? 'Pensando…' : 'Mejorar con Lexa'}
        </button>
        <span
          className={cn(
            'text-[10.5px] tabular-nums',
            overWarn
              ? 'text-amber-700 dark:text-amber-400 font-semibold'
              : 'text-[#0e1745]/40 dark:text-white/40',
          )}
        >
          {value.length}/{PROMPT_MAX}
        </span>
      </div>
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

/**
 * Ready panel — wraps the audio player provider and renders the
 * unified player. Single source of truth for play state lives in
 * AudioPlayerProvider; the seek bar, time, duration and speed all
 * subscribe via context. No native <audio controls>, no dual play
 * button, no browser focus halo.
 */
function ReadyPanel({ job, audioUrl }: { job: PodcastRow; audioUrl: string }) {
  return (
    <AudioPlayerProvider>
      <ReadyPanelInner job={job} audioUrl={audioUrl} />
    </AudioPlayerProvider>
  );
}

function ReadyPanelInner({ job, audioUrl }: { job: PodcastRow; audioUrl: string }) {
  const player = useAudioPlayer();

  // Auto-load the track on mount so the user can press play once and
  // hear it without a second click. We don't auto-play (browsers
  // would block it anyway) — just prime the audio element.
  useEffect(() => {
    void player.setActiveItem({ id: job.id, src: audioUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.id, audioUrl]);

  return (
    <div className="space-y-4">
      <div>
        <div className="font-display text-[20px] leading-tight tracking-tight text-[#0e1745] dark:text-white">
          {job.title ?? 'Tu podcast está listo'}
        </div>
        <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-1">
          {job.duration_actual_s ? `${Math.round(job.duration_actual_s)}s · ` : ''}
          Lexa · narrado a voz única
        </div>
      </div>

      {/* Player surface — burgundy-tinted background + the unified
          control row. `bg-cl2-burgundy/[0.04]` replaces the indigo
          tint that used to read as the blue halo. */}
      <div className="rounded-xl border border-cl2-burgundy/[0.12] dark:border-white/[0.08] bg-cl2-burgundy/[0.04] dark:bg-white/[0.03] px-3 py-3">
        <div className="flex items-center gap-3">
          <AudioPlayerButton
            item={{ id: job.id, src: audioUrl }}
            className="size-10 shrink-0"
          />
          <div className="flex-1 min-w-0 flex items-center gap-2.5">
            <AudioPlayerTime />
            <AudioPlayerProgress className="flex-1" />
            <AudioPlayerDuration />
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end">
          <AudioPlayerSpeed />
        </div>
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
