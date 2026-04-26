/**
 * /audios — podcast history for the signed-in user.
 *
 * What:
 *   - Lists every podcast the user has generated, newest first.
 *   - Inline player for ready audios (single-track at a time — pausing
 *     a different row stops the previous one to avoid simultaneous
 *     playback chaos).
 *   - Filter by source type (todos / sesión / expediente / board).
 *   - Search by title (client-side).
 *   - Delete (soft — DB row gone; audio lives 90d via lifecycle rule).
 *   - Direct download link per row.
 *
 * Why a dedicated surface:
 *   - The "I generated 5 podcasts last week, where are they?" answer.
 *   - Single source of truth across sesion/expediente/board origins.
 *   - Discoverability through TopDock + Profile menu.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Calendar,
  Download,
  Filter,
  Headphones,
  Library,
  Link2,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Scale,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { PodcastShareModal } from '@/components/podcasts/PodcastShareModal';
import { TopDock } from '@/components/top-dock';
import { Sidebar } from '@/components/sidebar';
import {
  deletePodcast,
  listMyPodcasts,
  resolvePodcastAudioUrl,
  type PodcastRow,
  type PodcastSourceType,
} from '@/services/podcastsApi';
import { cn } from '@/lib/utils';
import { navigate } from '@/lib/router';

type Filter =
  | 'all'
  | 'sesion'
  | 'expediente'
  | 'hoja_workspace'
  | 'hoja_node'
  | 'chat';

const FILTERS: Array<{ value: Filter; label: string; icon: React.ReactNode }> = [
  { value: 'all', label: 'Todos', icon: <Filter size={12} /> },
  { value: 'sesion', label: 'Sesiones', icon: <Radio size={12} /> },
  { value: 'expediente', label: 'Expedientes', icon: <Scale size={12} /> },
  { value: 'hoja_workspace', label: 'Boards', icon: <Library size={12} /> },
  { value: 'chat', label: 'Conversaciones', icon: <Search size={12} /> },
];

export function AudiosPage() {
  const [items, setItems] = useState<PodcastRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const rows = await listMyPodcasts();
      setItems(rows);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    const trimmed = q.trim().toLowerCase();
    return items.filter((r) => {
      if (filter !== 'all' && r.source_type !== filter) return false;
      if (trimmed && !(r.title ?? '').toLowerCase().includes(trimmed)) return false;
      return true;
    });
  }, [items, filter, q]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: items.length,
      sesion: 0,
      expediente: 0,
      hoja_workspace: 0,
      hoja_node: 0,
      chat: 0,
    };
    for (const r of items) {
      const k = r.source_type as Filter;
      if (k in c && k !== 'all') c[k] += 1;
    }
    return c;
  }, [items]);

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este podcast? El audio se borra del servidor en 90 días por la política de retención.')) {
      return;
    }
    try {
      await deletePodcast(id);
      setItems((rows) => rows.filter((r) => r.id !== id));
    } catch (e) {
      alert(`No se pudo eliminar: ${(e as Error).message}`);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      <div className="relative z-10 w-full max-w-[1320px] mx-auto flex flex-col flex-1">
        <TopDock
          onOpenHistory={() => setIsMobileDrawerOpen(true)}
          onToggleHistory={() => setIsHistoryOpen((v) => !v)}
          isHistoryOpen={isHistoryOpen}
        />

        <header className="px-4 sm:px-5 md:px-6 pt-6 md:pt-7 pb-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45 mb-1.5">
            Biblioteca de audio
          </div>
          <h1 className="font-display font-light text-[28px] sm:text-[34px] leading-[1.05] tracking-tight text-[#0e1745] dark:text-white">
            Tus podcasts —{' '}
            <em className="not-italic font-normal text-cl2-burgundy dark:text-cl2-accent-soft italic">
              todo lo que ya escuchaste, en un solo lugar
            </em>
            .
          </h1>
        </header>

        {/* Toolbar — search + filter chips + refresh */}
        <div className="px-4 sm:px-5 md:px-6 pt-1">
          <div className="w-full rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-[#231f1f]/85 backdrop-blur-md shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.18)] flex flex-wrap items-center gap-2.5 px-3 md:px-4 py-2.5 md:py-3">
            <div className="relative flex-1 min-w-[220px] max-w-[480px]">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#0e1745]/40 dark:text-white/40"
              />
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por título…"
                className={cn(
                  'w-full pl-9 pr-3 py-2 rounded-md text-[13px]',
                  'bg-white dark:bg-white/[0.05] border border-[#0e1745]/[0.10] dark:border-white/[0.10]',
                  'placeholder:text-[#0e1745]/40 dark:placeholder:text-white/40',
                  'transition focus:outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15',
                )}
              />
            </div>

            {/* Filter chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-medium border transition-colors',
                    filter === f.value
                      ? 'bg-cl2-accent/[0.10] text-cl2-accent dark:text-cl2-accent-soft border-cl2-accent/30'
                      : 'bg-white dark:bg-white/[0.04] text-[#0e1745]/65 dark:text-white/65 border-[#0e1745]/[0.10] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.07]',
                  )}
                >
                  {f.icon}
                  {f.label}
                  {f.value !== 'all' && counts[f.value] > 0 && (
                    <span className="font-mono text-[10px] tabular-nums">
                      {counts[f.value]}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <span className="flex-1" />

            <button
              type="button"
              onClick={() => void load()}
              title="Refrescar"
              className="p-2 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
            >
              <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {/* Body */}
        <main className="relative z-10 flex-1 px-4 sm:px-5 md:px-6 pt-4 pb-10">
          {err && (
            <div className="rounded-xl border border-rose-300/40 bg-rose-50/60 dark:bg-rose-500/10 dark:border-rose-500/30 px-4 py-3 text-sm text-rose-700 dark:text-rose-300 mb-4">
              No se pudo cargar: {err}
            </div>
          )}

          {loading && items.length === 0 ? (
            <div className="grid gap-3 max-w-[920px]">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[88px] rounded-[10px] animate-pulse bg-[#0e1745]/[0.04] dark:bg-white/[0.04]"
                />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState hasQuery={!!q.trim() || filter !== 'all'} />
          ) : (
            <ul className="grid gap-2.5 max-w-[920px]">
              <AnimatePresence initial={false}>
                {filtered.map((row) => (
                  <PodcastRowItem
                    key={row.id}
                    row={row}
                    onDelete={() => void handleDelete(row.id)}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </main>
      </div>

      <Sidebar
        open={isMobileDrawerOpen}
        onClose={() => setIsMobileDrawerOpen(false)}
        variant="drawer"
        side="left"
        className="lg:hidden"
      />
    </div>
  );
}

// ─── Single row ──────────────────────────────────────────────────────

// Module-level "currently playing" tracker. Whenever a row asks to
// play, all others get a chance to pause first. This is the cleanest
// way to enforce single-track playback without a context provider.
const currentlyPlaying = { id: null as string | null, pauseFn: null as (() => void) | null };

function PodcastRowItem({ row, onDelete }: { row: PodcastRow; onDelete: () => void }) {
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const ensureUrl = async () => {
    if (audioUrl) return audioUrl;
    setResolving(true);
    try {
      const url = await resolvePodcastAudioUrl(row.id);
      setAudioUrl(url);
      return url;
    } finally {
      setResolving(false);
    }
  };

  const onPlay = async () => {
    const url = await ensureUrl();
    if (!url) return;
    if (currentlyPlaying.id && currentlyPlaying.id !== row.id && currentlyPlaying.pauseFn) {
      currentlyPlaying.pauseFn();
    }
    currentlyPlaying.id = row.id;
    currentlyPlaying.pauseFn = () => audioRef.current?.pause();
    audioRef.current?.play().catch(() => null);
  };

  const onPause = () => {
    audioRef.current?.pause();
  };

  const meta = describeSource(row);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        'rounded-[10px] border bg-white dark:bg-white/[0.025] backdrop-blur-sm overflow-hidden transition-shadow',
        row.status === 'ready'
          ? 'border-[#0e1745]/[0.07] dark:border-white/[0.06] hover:shadow-[0_4px_20px_rgba(14,23,69,0.06)]'
          : 'border-dashed border-[#0e1745]/[0.10] dark:border-white/[0.10]',
      )}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        {/* Icon + status */}
        <button
          type="button"
          onClick={() => (playing ? onPause() : void onPlay())}
          disabled={row.status !== 'ready'}
          aria-label={playing ? 'Pausar' : 'Reproducir'}
          className={cn(
            'shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full transition-colors',
            row.status === 'ready'
              ? 'bg-cl2-burgundy text-white dark:bg-cl2-accent hover:bg-cl2-burgundy/90 dark:hover:bg-cl2-accent-hover'
              : 'bg-[#0e1745]/10 dark:bg-white/10 text-[#0e1745]/40 dark:text-white/40 cursor-not-allowed',
          )}
        >
          {resolving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : playing ? (
            <Pause size={14} />
          ) : row.status === 'ready' ? (
            <Play size={14} className="ml-[1px]" />
          ) : (
            <Headphones size={14} />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => meta.href && navigate(meta.href)}
              disabled={!meta.href}
              className={cn(
                'text-left text-[13.5px] font-semibold text-[#0e1745] dark:text-white truncate max-w-full',
                meta.href && 'hover:text-cl2-burgundy dark:hover:text-cl2-accent-soft transition-colors',
              )}
            >
              {row.title ?? 'Podcast sin título'}
            </button>
            <StatusChip status={row.status} progress={row.progress} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[#0e1745]/55 dark:text-white/55">
            <span className="inline-flex items-center gap-1">
              {meta.icon} {meta.label}
            </span>
            <span className="text-[#0e1745]/30 dark:text-white/30">·</span>
            <span className="inline-flex items-center gap-1">
              <Calendar size={10} /> {fmtDate(row.created_at)}
            </span>
            {row.duration_actual_s != null && (
              <>
                <span className="text-[#0e1745]/30 dark:text-white/30">·</span>
                <span className="font-mono tabular-nums">
                  {fmtDuration(row.duration_actual_s)}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Audio element + actions */}
        {audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            preload="metadata"
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              if (currentlyPlaying.id === row.id) {
                currentlyPlaying.id = null;
                currentlyPlaying.pauseFn = null;
              }
            }}
            onEnded={() => setPlaying(false)}
          />
        )}

        {row.status === 'ready' && (
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            title="Compartir link público"
            className="shrink-0 p-2 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-cl2-burgundy dark:hover:text-cl2-accent-soft hover:bg-cl2-burgundy/[0.05] dark:hover:bg-cl2-accent/[0.10]"
          >
            <Link2 size={13} />
          </button>
        )}

        {row.status === 'ready' && (
          <a
            href={audioUrl ?? '#'}
            onClick={async (e) => {
              if (!audioUrl) {
                e.preventDefault();
                const url = await ensureUrl();
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
              }
            }}
            download={`cl2-podcast-${row.id.slice(0, 8)}.mp3`}
            target="_blank"
            rel="noopener noreferrer"
            title="Descargar mp3"
            className="shrink-0 p-2 rounded-md text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
          >
            <Download size={13} />
          </a>
        )}

        <button
          type="button"
          onClick={onDelete}
          title="Eliminar"
          className="shrink-0 p-2 rounded-md text-[#0e1745]/40 dark:text-white/40 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/15"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Mini scrubber when playing */}
      {playing && audioUrl && audioRef.current && (
        <ScrubberRow audio={audioRef.current} />
      )}

      <PodcastShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        podcastId={row.id}
        podcastTitle={row.title}
      />
    </motion.li>
  );
}

function ScrubberRow({ audio }: { audio: HTMLAudioElement }) {
  const [t, setT] = useState(audio.currentTime);
  const [d, setD] = useState(audio.duration || 0);
  useEffect(() => {
    const onTime = () => setT(audio.currentTime);
    const onMeta = () => setD(audio.duration || 0);
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
    };
  }, [audio]);
  const pct = d > 0 ? (t / d) * 100 : 0;
  return (
    <div className="px-3.5 pb-2.5">
      <div className="relative h-1 rounded-full bg-[#0e1745]/[0.06] dark:bg-white/[0.08] overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-cl2-burgundy dark:bg-cl2-accent"
          style={{ width: `${pct}%` }}
        />
        <input
          type="range"
          min={0}
          max={d || 0}
          step={0.5}
          value={t}
          onChange={(e) => { audio.currentTime = Number(e.target.value); }}
          className="absolute inset-0 opacity-0 cursor-pointer"
          aria-label="Posición del audio"
        />
      </div>
      <div className="flex items-center justify-between mt-0.5 font-mono text-[10px] tabular-nums text-[#0e1745]/55 dark:text-white/55">
        <span>{fmtTime(t)}</span>
        <span>{fmtTime(d)}</span>
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function StatusChip({ status, progress }: { status: PodcastRow['status']; progress: number }) {
  if (status === 'ready') return null;
  const isInFlight = ['queued', 'scripting', 'tts', 'encoding'].includes(status);
  if (isInFlight) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider bg-cl2-burgundy/10 text-cl2-burgundy dark:bg-cl2-accent/15 dark:text-cl2-accent-soft border border-cl2-burgundy/20 dark:border-cl2-accent/25">
        <Loader2 size={9} className="animate-spin" />
        {status} · {progress}%
      </span>
    );
  }
  if (status === 'failed' || status === 'cancelled') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-mono uppercase tracking-wider bg-rose-500/10 text-rose-600 dark:text-rose-300 border border-rose-500/30">
        <X size={9} />
        {status}
      </span>
    );
  }
  return null;
}

function describeSource(row: PodcastRow): {
  label: string;
  href: string | null;
  icon: React.ReactNode;
} {
  switch (row.source_type as PodcastSourceType) {
    case 'sesion':
      return {
        label: `Sesión ${row.source_id}`,
        href: `/sesiones/${row.source_id}`,
        icon: <Radio size={10} />,
      };
    case 'expediente':
      return {
        label: `Expediente ${row.source_id}`,
        href: `/expediente/${row.source_id}`,
        icon: <Scale size={10} />,
      };
    case 'hoja_workspace':
      return {
        label: 'Board · investigación',
        href: `/hojas/${row.source_id}`,
        icon: <Library size={10} />,
      };
    case 'hoja_node':
      return {
        label: 'Nota individual',
        href: null,
        icon: <Library size={10} />,
      };
    case 'chat':
      return {
        label: 'Conversación con Lexa',
        href: null,
        icon: <Search size={10} />,
      };
    default:
      return {
        label: row.source_type,
        href: null,
        icon: <Headphones size={10} />,
      };
  }
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-CR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function EmptyState({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className="text-center py-16 max-w-[480px] mx-auto">
      <Headphones size={32} className="mx-auto text-[#0e1745]/25 dark:text-white/25 mb-3" />
      <p className="text-sm text-[#0e1745]/65 dark:text-white/65">
        {hasQuery
          ? 'Ningún podcast cumple los filtros actuales.'
          : 'Todavía no generaste audios. Abrí cualquier sesión, expediente o board y tocá «Generar podcast».'}
      </p>
    </div>
  );
}
