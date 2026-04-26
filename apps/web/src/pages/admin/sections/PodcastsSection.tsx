/**
 * Podcasts — admin telemetry view.
 *
 * Operator answers four questions here:
 *   1. ¿Cuántos podcasts está generando la gente? (24h, 7d, total)
 *   2. ¿Hay algo atascado? (in-flight count + recent table)
 *   3. ¿Cuánto está costando? (chars billed → USD estimado, último 7d)
 *   4. ¿Por dónde nos están entrando? (breakdown por source_type)
 */
import { useEffect, useState } from 'react';
import { Headphones, Library, Radio, RefreshCw, Scale, Search } from 'lucide-react';
import { Card, CardBody, CardHeader, KPI, Pill, SectionHeader, type PillKind } from '../primitives';
import { AdminTable } from '../Table';
import { supabase } from '@/lib/supabase';

interface PodcastsStats {
  totals: {
    all_time: number;
    last_24h: number;
    last_7d: number;
    failed_7d: number;
    in_flight: number;
  };
  by_status: Record<string, number>;
  by_source_type: Record<string, number>;
  cost: {
    chars_7d: number;
    duration_seconds_7d: number;
  };
  recent: Array<{
    id: string;
    source_type: string;
    source_id: string;
    title: string | null;
    status: string;
    progress: number;
    error: string | null;
    cost_chars: number | null;
    duration_actual_s: number | null;
    created_at: string;
    finished_at: string | null;
  }>;
}

// Eleven multilingual_v2 ≈ $0.30 / 1k chars on the standard tier.
const USD_PER_1K_CHARS = 0.3;

const STATUS_PILL: Record<string, { label: string; kind: PillKind }> = {
  ready: { label: 'ready', kind: 'success' },
  queued: { label: 'queued', kind: 'neutral' },
  scripting: { label: 'scripting', kind: 'warn' },
  tts: { label: 'tts', kind: 'warn' },
  encoding: { label: 'encoding', kind: 'warn' },
  failed: { label: 'failed', kind: 'danger' },
  cancelled: { label: 'cancelled', kind: 'neutral' },
};

const SOURCE_LABEL: Record<string, { icon: React.ReactNode; label: string }> = {
  sesion: { icon: <Radio size={11} />, label: 'sesión' },
  expediente: { icon: <Scale size={11} />, label: 'expediente' },
  hoja_workspace: { icon: <Library size={11} />, label: 'board' },
  hoja_node: { icon: <Library size={11} />, label: 'nodo' },
  chat: { icon: <Search size={11} />, label: 'chat' },
};

export function PodcastsSection(): React.ReactElement {
  const [stats, setStats] = useState<PodcastsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      const res = await fetch('/api/admin/podcasts/stats', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ok: true; data: PodcastsStats };
      setStats(body.data);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const failPctSrc = stats?.totals.last_7d ?? 0;
  const failPct = failPctSrc > 0 ? Math.round(((stats?.totals.failed_7d ?? 0) / failPctSrc) * 100) : 0;
  const usdEst = stats ? (stats.cost.chars_7d * USD_PER_1K_CHARS) / 1_000 : 0;

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Telemetría · Podcasts"
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refrescar
          </button>
        }
      />
      <p className="mt-[-1rem] text-[13px] text-[#0e1745]/65 dark:text-white/65 max-w-[68ch]">
        Visibilidad operacional sobre el pipeline de TTS — volúmenes, costos y jobs en vuelo.
      </p>

      {err && (
        <div className="rounded-xl border border-rose-300/40 bg-rose-50 dark:bg-rose-500/10 dark:border-rose-500/30 px-4 py-3 text-sm text-rose-700 dark:text-rose-300">
          No se pudo cargar: {err}
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KPI
          label="Total histórico"
          value={String(stats?.totals.all_time ?? '—')}
        />
        <KPI
          label="Últimas 24h"
          value={String(stats?.totals.last_24h ?? '—')}
        />
        <KPI
          label="Últimos 7d"
          value={String(stats?.totals.last_7d ?? '—')}
        />
        <KPI
          label="En vuelo"
          value={String(stats?.totals.in_flight ?? '—')}
          delta={stats && stats.totals.in_flight > 0 ? 'jobs activos' : undefined}
          deltaDir={stats && stats.totals.in_flight > 0 ? 'up' : 'flat'}
        />
        <KPI
          label="Fallas 7d"
          value={`${stats?.totals.failed_7d ?? '—'}`}
          unit={stats && failPct > 0 ? `· ${failPct}%` : undefined}
          deltaDir={failPct > 10 ? 'up' : 'flat'}
        />
      </div>

      {/* Cost + breakdowns row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader title="Costo TTS — 7d" />
          <CardBody>
            <div className="font-display text-[34px] tabular-nums text-[#0e1745] dark:text-white leading-tight">
              ${usdEst.toFixed(2)}
              <span className="ml-1 font-sans text-[12.5px] text-[#0e1745]/55 dark:text-white/55">USD est.</span>
            </div>
            <div className="mt-1 text-[12px] text-[#0e1745]/65 dark:text-white/65">
              {(stats?.cost.chars_7d ?? 0).toLocaleString('es-CR')} chars facturados ·{' '}
              {fmtDuration(stats?.cost.duration_seconds_7d ?? 0)} de audio generado
            </div>
            <div className="mt-3 text-[10.5px] text-[#0e1745]/50 dark:text-white/50">
              Tarifa de referencia eleven_multilingual_v2: ${USD_PER_1K_CHARS}/1k chars.
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Por estado" />
          <CardBody>
            {stats && Object.keys(stats.by_status).length > 0 ? (
              <ul className="space-y-2">
                {Object.entries(stats.by_status)
                  .sort((a, b) => b[1] - a[1])
                  .map(([status, count]) => (
                    <li key={status} className="flex items-center justify-between gap-3">
                      <Pill kind={STATUS_PILL[status]?.kind ?? 'neutral'}>
                        {STATUS_PILL[status]?.label ?? status}
                      </Pill>
                      <span className="font-mono text-[12.5px] tabular-nums text-[#0e1745]/85 dark:text-white/85">
                        {count}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : (
              <div className="text-[12.5px] text-[#0e1745]/55 dark:text-white/55">Sin datos.</div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Por origen" />
          <CardBody>
            {stats && Object.keys(stats.by_source_type).length > 0 ? (
              <ul className="space-y-2">
                {Object.entries(stats.by_source_type)
                  .sort((a, b) => b[1] - a[1])
                  .map(([src, count]) => (
                    <li key={src} className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-[#0e1745]/80 dark:text-white/80">
                        {SOURCE_LABEL[src]?.icon ?? <Headphones size={11} />}
                        {SOURCE_LABEL[src]?.label ?? src}
                      </span>
                      <span className="font-mono text-[12.5px] tabular-nums text-[#0e1745]/85 dark:text-white/85">
                        {count}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : (
              <div className="text-[12.5px] text-[#0e1745]/55 dark:text-white/55">Sin datos.</div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Recent table */}
      <Card>
        <CardHeader title="Recientes (últimos 20)" />
        <AdminTable<PodcastsStats['recent'][number]>
          rows={stats?.recent ?? []}
          rowKey={(r) => r.id}
          empty={
            <div className="px-4 py-6 text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
              {loading ? 'Cargando…' : 'Aún no se ha generado ningún podcast.'}
            </div>
          }
          columns={[
            {
              header: 'Generado',
              width: '15%',
              cell: (r) => (
                <span className="font-mono text-[11.5px] tabular-nums">{fmtDate(r.created_at)}</span>
              ),
            },
            {
              header: 'Origen',
              width: '14%',
              cell: (r) => (
                <span className="inline-flex items-center gap-1 text-[12px] text-[#0e1745]/80 dark:text-white/80">
                  {SOURCE_LABEL[r.source_type]?.icon ?? <Headphones size={11} />}
                  {SOURCE_LABEL[r.source_type]?.label ?? r.source_type}
                </span>
              ),
            },
            {
              header: 'Título',
              width: '34%',
              cell: (r) => (
                <span className="text-[12.5px] text-[#0e1745] dark:text-white truncate block max-w-[460px]">
                  {r.title ?? <span className="italic text-[#0e1745]/40 dark:text-white/40">sin título</span>}
                </span>
              ),
            },
            {
              header: 'Estado',
              width: '13%',
              cell: (r) => (
                <Pill kind={STATUS_PILL[r.status]?.kind ?? 'neutral'}>
                  {STATUS_PILL[r.status]?.label ?? r.status}
                  {r.status !== 'ready' && r.status !== 'failed' && r.progress > 0 && ` ${r.progress}%`}
                </Pill>
              ),
            },
            {
              header: 'Duración',
              width: '9%',
              align: 'right',
              cell: (r) => (
                <span className="font-mono text-[11.5px] tabular-nums text-[#0e1745]/65 dark:text-white/65">
                  {r.duration_actual_s != null ? fmtDuration(r.duration_actual_s) : '—'}
                </span>
              ),
            },
            {
              header: 'Chars',
              width: '7%',
              align: 'right',
              cell: (r) => (
                <span className="font-mono text-[11.5px] tabular-nums text-[#0e1745]/65 dark:text-white/65">
                  {r.cost_chars != null ? r.cost_chars.toLocaleString('es-CR') : '—'}
                </span>
              ),
            },
            {
              header: 'Detalle',
              width: '8%',
              cell: (r) =>
                r.error ? (
                  <span
                    title={r.error}
                    className="text-[11.5px] text-rose-600 dark:text-rose-400 truncate block max-w-[120px]"
                  >
                    {r.error}
                  </span>
                ) : (
                  <span className="text-[#0e1745]/30 dark:text-white/30">—</span>
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('es-CR', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function fmtDuration(s: number): string {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
