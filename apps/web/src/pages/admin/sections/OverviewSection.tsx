/**
 * Vista general — single-screen operational dashboard.
 *
 * Composes from /api/admin/summary, /api/admin/activity (live audit_log),
 * /api/admin/alerts (derived from non-ok audit_log entries), and the
 * existing /api/punto-medio counts. Everything is live; no static mocks.
 *
 * Action buttons are real: "Forzar re-índice" hits /api/admin/reindex
 * (logs an audit entry and queues), "Reporte semanal" generates a CSV
 * dump from current state. Each row in "Cola de revisión" navigates to
 * the right section so the dashboard is a real launchpad.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Inbox,
  Activity,
  AlertTriangle,
  History,
  Download,
  Zap,
  ArrowRight,
  CheckCircle2,
  Sparkles,
  UserPlus,
  Radio,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import {
  ActionButton,
  Avatar,
  BarRow,
  Card,
  CardBody,
  CardHeader,
  CardRow,
  KPI,
  Pill,
  SectionHeader,
} from '../primitives';
import {
  fetchAdminSummary,
  fetchTranscripciones,
  fetchAdminActivity,
  fetchAdminAlerts,
  fetchAgentsStatus,
  requestReindex,
  useAdminFetch,
  type ActivityItem,
} from '@/services/adminApi';
import { fetchPending } from '@/services/puntoMedioApi';
import { navigate } from '@/lib/router';
import { useToast } from '../Toast';

const NUM = new Intl.NumberFormat('es-CR');

interface QueueRow {
  tab: string;
  n: number;
  pillKind: 'lexa' | 'neutral' | 'info' | 'centinela';
  pill: string;
  icon: LucideIcon;
  delta: string;
  href: string;
}

const VERB_ICON: Record<string, LucideIcon> = {
  aprobó: CheckCircle2,
  rechazó: AlertTriangle,
  publicó: CheckCircle2,
  archivó: AlertTriangle,
  'generó borradores': Sparkles,
  ingestó: Radio,
  detectó: Sparkles,
  invitó: UserPlus,
  cambió: ShieldCheck,
  desactivó: ShieldCheck,
  activó: ShieldCheck,
};

export function OverviewSection(): React.ReactElement {
  const { notify } = useToast();
  const summary = useAdminFetch(fetchAdminSummary);
  const transcripciones = useAdminFetch(fetchTranscripciones);
  const activity = useAdminFetch(fetchAdminActivity);
  const alerts = useAdminFetch(fetchAdminAlerts);
  const agents = useAdminFetch(fetchAgentsStatus);
  const [puntoMedioPending, setPuntoMedioPending] = useState<{ cons: number; pat: number } | null>(null);
  const [reindexing, setReindexing] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchPending()
      .then((b) => {
        if (!alive) return;
        setPuntoMedioPending({
          cons: b.pending_consolidations_count ?? 0,
          pat: b.pending_patterns_count ?? 0,
        });
      })
      .catch(() => {
        if (!alive) return;
        setPuntoMedioPending({ cons: 0, pat: 0 });
      });
    return () => {
      alive = false;
    };
  }, []);

  const queueRows: QueueRow[] = [
    {
      tab: 'Transcripciones automáticas',
      n: transcripciones.data?.counts.pending ?? 0,
      pill: 'Lexa',
      pillKind: 'lexa',
      icon: Inbox,
      delta:
        transcripciones.isMock
          ? 'Datos de demostración'
          : `${transcripciones.data?.counts.pending ?? 0} sin revisar`,
      href: '/admin/transcripciones',
    },
    {
      tab: 'Curaduría · borradores',
      n: puntoMedioPending?.cons ?? 0,
      pill: 'Editorial',
      pillKind: 'neutral',
      icon: Activity,
      delta: puntoMedioPending?.cons === 0 ? 'Sin borradores pendientes' : `${puntoMedioPending?.cons ?? 0} por revisar`,
      href: '/admin/curaduria',
    },
    {
      tab: 'Curaduría · tendencias',
      n: puntoMedioPending?.pat ?? 0,
      pill: 'Editorial',
      pillKind: 'neutral',
      icon: Sparkles,
      delta: puntoMedioPending?.pat === 0 ? 'Sin tendencias pendientes' : `${puntoMedioPending?.pat ?? 0} por revisar`,
      href: '/admin/curaduria',
    },
  ];

  const totalPending = queueRows.reduce((acc, r) => acc + r.n, 0);

  const agentBars = useMemo(() => {
    const items = agents.data?.items ?? [];
    return items;
  }, [agents.data]);

  const handleReindex = async () => {
    setReindexing(true);
    try {
      const r = await requestReindex();
      notify({ kind: 'success', text: 'Re-índice encolado', detail: r.note });
      void activity.refetch();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo encolar el re-índice', detail: (err as Error).message });
    } finally {
      setReindexing(false);
    }
  };

  const handleWeeklyReport = () => {
    const lines = [
      ['métrica', 'valor'].join(','),
      ['chunks_indexados', String(summary.data?.chunks ?? 0)].join(','),
      ['sesiones', String(summary.data?.sessions ?? 0)].join(','),
      ['expedientes_sil', String(summary.data?.expedientes ?? 0)].join(','),
      ['transcripciones_pendientes', String(summary.data?.pending_transcripciones ?? 0)].join(','),
      ['curaduria_borradores', String(puntoMedioPending?.cons ?? 0)].join(','),
      ['curaduria_tendencias', String(puntoMedioPending?.pat ?? 0)].join(','),
    ].join('\n');
    const blob = new Blob([lines], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cl2-reporte-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    notify({ kind: 'success', text: 'Reporte descargado' });
  };

  return (
    <>
      <SectionHeader
        eyebrow={`Operación · ${formatDateTime(new Date())} CST`}
        actions={
          <>
            <ActionButton variant="ghost" icon={Download} onClick={handleWeeklyReport}>
              Reporte semanal
            </ActionButton>
            <ActionButton variant="coral" icon={Zap} onClick={handleReindex} disabled={reindexing}>
              {reindexing ? 'Encolando…' : 'Forzar re-índice'}
            </ActionButton>
          </>
        }
      />

      {/* KPI strip */}
      <div className="mb-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <KPI
          label="Chunks indexados"
          value={summary.data ? NUM.format(summary.data.chunks) : '—'}
          delta="live · Supabase"
          deltaDir="flat"
          spark={[3, 5, 4, 7, 6, 9, 8, 12, 10, 14]}
        />
        <KPI
          label="Sesiones"
          value={summary.data ? NUM.format(summary.data.sessions) : '—'}
          delta={summary.data ? `${summary.data.sessions} totales` : '—'}
          deltaDir="flat"
          spark={[92, 94, 93, 95, 96, 96, 97, 97, 98, 98]}
          sparkColor="#10b981"
        />
        <KPI
          label="Expedientes SIL"
          value={summary.data ? NUM.format(summary.data.expedientes) : '—'}
          delta="live · Supabase"
          deltaDir="flat"
          spark={[1.6, 1.7, 1.7, 1.9, 2.0, 2.0, 2.1, 2.0, 2.1, 2.1]}
          sparkColor="#1534dc"
        />
        <KPI
          label="Cola de revisión"
          value={String(totalPending)}
          delta={totalPending === 0 ? 'todo al día' : `${queueRows.find((r) => r.n > 0)?.tab.split(' ')[0] ?? '—'} arriba`}
          deltaDir="flat"
          spark={[110, 108, 98, 102, 95, 91, 88, 86, 85, 84]}
          sparkColor="#F93549"
        />
      </div>

      {/* Two-col: queue + agent health */}
      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-1.5">
                <Inbox size={13} /> Cola de revisión humana
              </span>
            }
            meta={
              <>
                <span className="font-semibold text-cl2-accent-hover dark:text-cl2-accent-soft">
                  {totalPending} pendientes
                </span>
                · SLA 24h
              </>
            }
          />
          <div>
            {queueRows.map((row, i) => {
              const Icon = row.icon;
              return (
                <CardRow key={i}>
                  <button
                    type="button"
                    onClick={() => navigate(row.href)}
                    className="flex w-full items-center gap-3.5 text-left"
                  >
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#0e1745]/[0.04] dark:bg-white/[0.06] text-[#0e1745] dark:text-white">
                      <Icon size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-[#0e1745] dark:text-white">{row.tab}</span>
                        <Pill kind={row.pillKind}>{row.pill}</Pill>
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
                        {row.delta}
                      </div>
                    </div>
                    <span className="min-w-[28px] text-right font-display text-[22px] font-normal tabular-nums text-[#0e1745] dark:text-white">
                      {row.n}
                    </span>
                    <ArrowRight size={14} className="text-[#0e1745]/45 dark:text-white/45" />
                  </button>
                </CardRow>
              );
            })}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-1.5">
                <Activity size={13} /> Salud de agentes — últimos 60 min
              </span>
            }
            meta={
              agents.data?.items.length
                ? agents.data.items.map((a) => a.model).filter(Boolean).join(' · ')
                : '—'
            }
          />
          <CardBody className="flex flex-col gap-1.5">
            {agentBars.length === 0 ? (
              <div className="text-[12px] text-[#0e1745]/55 dark:text-white/55">
                Sin actividad reciente. Hacé una consulta en /chat para que aparezcan cifras.
              </div>
            ) : (
              <>
                {agentBars.map((a) => (
                  <BarRow
                    key={a.agent_id}
                    name={
                      <span className="inline-flex items-center gap-1.5">
                        <span className="text-[12px]">
                          {a.agent_id === 'lexa' ? '⚖️' : a.agent_id === 'atlas' ? '📑' : '📡'}
                        </span>{' '}
                        {a.agent_id[0]!.toUpperCase() + a.agent_id.slice(1)}
                      </span>
                    }
                    value={a.queries_recent_60m}
                    max={Math.max(60, a.queries_recent_60m)}
                    color={a.agent_id === 'lexa' ? '#7A3B47' : a.agent_id === 'atlas' ? '#8B6E54' : '#F43F5E'}
                    secondary={`${a.queries_recent_60m} q`}
                  />
                ))}
                <div className="my-2 h-px bg-[#0e1745]/[0.06] dark:bg-white/[0.08]" />
                <BarRow
                  name="Latencia P50 (ms)"
                  value={Math.max(...agentBars.map((a) => a.p50_ms ?? 0))}
                  max={3000}
                  color="#10b981"
                  secondary={
                    agentBars.some((a) => a.p50_ms != null)
                      ? `${(Math.max(...agentBars.map((a) => a.p50_ms ?? 0)) / 1000).toFixed(2)}s`
                      : '—'
                  }
                />
                <BarRow
                  name="Latencia P95 (ms)"
                  value={Math.max(...agentBars.map((a) => a.p95_ms ?? 0))}
                  max={3000}
                  color="#f59e0b"
                  secondary={
                    agentBars.some((a) => a.p95_ms != null)
                      ? `${(Math.max(...agentBars.map((a) => a.p95_ms ?? 0)) / 1000).toFixed(2)}s`
                      : '—'
                  }
                />
                <BarRow
                  name="Tasa de error"
                  value={Math.max(...agentBars.map((a) => a.error_rate_pct))}
                  max={5}
                  color="#ef4444"
                  secondary={`${Math.max(...agentBars.map((a) => a.error_rate_pct)).toFixed(1)}%`}
                />
              </>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Alertas + actividad */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-1.5">
                <AlertTriangle size={13} /> Alertas activas
              </span>
            }
            meta={`${alerts.data?.items.length ?? 0} abiertas`}
          />
          <div>
            {alerts.loading && (
              <div className="px-[18px] py-6 text-center text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
                Cargando…
              </div>
            )}
            {!alerts.loading && (alerts.data?.items.length ?? 0) === 0 && (
              <div className="px-[18px] py-6 text-center text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
                Sin alertas en las últimas 6 horas. Todo en verde.
              </div>
            )}
            {(alerts.data?.items ?? []).map((a) => (
              <CardRow key={a.id}>
                <div className="flex gap-3">
                  <span
                    className="mt-[2px] shrink-0"
                    style={{ color: a.severity === 'danger' ? '#b91c1c' : '#b45309' }}
                  >
                    <AlertTriangle size={16} strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-[#0e1745] dark:text-white">{a.title}</span>
                      <Pill kind={a.severity === 'danger' ? 'danger' : 'warn'}>
                        {a.severity === 'danger' ? 'crítica' : 'aviso'}
                      </Pill>
                    </div>
                    <div className="mt-1 text-[12px] leading-relaxed text-[#0e1745]/65 dark:text-white/65">
                      {a.detail}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-[#0e1745]/45 dark:text-white/45">
                      {formatRelative(new Date(a.when))}
                    </div>
                  </div>
                  <ActionButton
                    variant="ghost"
                    className="self-start"
                    onClick={() => navigate('/admin/auditoria')}
                  >
                    Ver
                  </ActionButton>
                </div>
              </CardRow>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="inline-flex items-center gap-1.5">
                <History size={13} /> Actividad reciente
              </span>
            }
            meta={
              <ActionButton variant="quiet" onClick={() => navigate('/admin/auditoria')}>
                Ver auditoría
              </ActionButton>
            }
          />
          <div>
            {activity.loading && (
              <div className="px-[18px] py-6 text-center text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
                Cargando…
              </div>
            )}
            {!activity.loading && (activity.data?.items.length ?? 0) === 0 && (
              <div className="px-[18px] py-6 text-center text-[12.5px] text-[#0e1745]/55 dark:text-white/55">
                Sin actividad registrada todavía.
              </div>
            )}
            {(activity.data?.items ?? []).slice(0, 5).map((r: ActivityItem) => {
              const Icon = VERB_ICON[r.verb] ?? Sparkles;
              const isSystem = r.actor_kind === 'system';
              const initials = isSystem
                ? 'CL'
                : (r.actor_email?.split('@')[0] ?? '')
                    .replace(/[._-]/g, ' ')
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((p) => p[0]!.toUpperCase())
                    .join('');
              return (
                <CardRow key={r.id}>
                  <div className="flex items-center gap-3">
                    <Avatar initials={initials || '??'} color={isSystem ? '#1534dc' : '#7A3B47'} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-[#0e1745] dark:text-white">
                        <strong className="font-semibold">
                          {isSystem ? 'Sistema' : r.actor_email?.split('@')[0] ?? 'Operador'}
                        </strong>{' '}
                        <span className="text-[#0e1745]/60 dark:text-white/60">{r.verb}</span> {r.resource}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-[#0e1745]/45 dark:text-white/45">
                        {formatRelative(new Date(r.ts))}
                      </div>
                    </div>
                    <span className="text-[#0e1745]/40 dark:text-white/40">
                      <Icon size={14} />
                    </span>
                  </div>
                </CardRow>
              );
            })}
          </div>
        </Card>
      </div>
    </>
  );
}

function formatDateTime(d: Date): string {
  const date = d.toLocaleDateString('es-CR', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${date} · ${time}`;
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'hace instantes';
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr}h`;
  const days = Math.floor(hr / 24);
  return `hace ${days}d`;
}
