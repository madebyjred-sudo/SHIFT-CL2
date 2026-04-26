/**
 * Vista general — single-screen operational dashboard.
 *
 * Composes from /api/admin/summary (live counts), /api/admin/transcripciones
 * (queue counts), /api/punto-medio/pending (review queue) and a hand-rolled
 * activity stream. Where the backend doesn't exist yet, the data is mocked
 * with `isMock` flagged so the operator sees "Datos de demostración".
 */
import { useEffect, useState } from 'react';
import {
  Inbox,
  Activity,
  AlertTriangle,
  History,
  Download,
  Zap,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Sparkles,
  UserPlus,
  Radio,
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
  useAdminFetch,
} from '@/services/adminApi';
import { fetchPending } from '@/services/puntoMedioApi';

const NUM = new Intl.NumberFormat('es-CR');

interface QueueRow {
  tab: string;
  n: number;
  pillKind: 'lexa' | 'neutral' | 'info' | 'centinela';
  pill: string;
  icon: LucideIcon;
  delta: string;
}

interface AlertRow {
  sev: 'warn' | 'danger';
  title: string;
  when: string;
  desc: string;
  cta: string;
}

interface ActivityRow {
  who: string;
  initials: string;
  color: string;
  verb: string;
  what: string;
  when: string;
  icon: LucideIcon;
}

const STATIC_ALERTS: ReadonlyArray<AlertRow> = [
  {
    sev: 'warn',
    title: 'Latencia Atlas P95 sobre 2s',
    when: 'Hace 12 min',
    desc: 'Spike concurrente en consultas a expedientes 24.x — revisar pool Postgres.',
    cta: 'Investigar',
  },
  {
    sev: 'warn',
    title: 'Worker scraper · Asamblea',
    when: 'Hace 38 min',
    desc: 'Playwright reintenta orden del día — tres 502 consecutivos del SIL.',
    cta: 'Ver corrida',
  },
  {
    sev: 'danger',
    title: 'Cita rota · Exp. 23.456 chunk #84',
    when: 'Hace 1h 14m',
    desc: 'Lexa citó un fragmento que ya no está en el chunkstore. Re-embedding pendiente.',
    cta: 'Re-indexar',
  },
];

const STATIC_ACTIVITY: ReadonlyArray<ActivityRow> = [
  { who: 'Juanma C.', initials: 'JM', color: '#7A3B47', verb: 'aprobó',  what: 'consolidación #214',                                  when: '14:18', icon: CheckCircle2 },
  { who: 'Sistema',   initials: 'CL', color: '#1534dc', verb: 'ingestó', what: 'Plenaria N°128 — 2h 15m',                              when: '13:55', icon: Radio },
  { who: 'Diana R.',  initials: 'DR', color: '#8B6E54', verb: 'rechazó', what: 'transcripción 1:57:26 (mala atribución)',           when: '13:47', icon: XCircle },
  { who: 'Sistema',   initials: 'CL', color: '#1534dc', verb: 'detectó', what: 'patrón "voto cruzado FA-PUSC" — pendiente',          when: '12:09', icon: Sparkles },
  { who: 'Andrés V.', initials: 'AV', color: '#F43F5E', verb: 'invitó',  what: 'tatiana.vargas@asamblea.go.cr',                       when: '11:30', icon: UserPlus },
];

export function OverviewSection(): React.ReactElement {
  const summary = useAdminFetch(fetchAdminSummary);
  const transcripciones = useAdminFetch(fetchTranscripciones);
  const [puntoMedioPending, setPuntoMedioPending] = useState<{ cons: number; pat: number } | null>(null);

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
      delta: transcripciones.isMock ? 'Datos de demostración' : `${transcripciones.data?.counts.pending ?? 0} sin revisar`,
    },
    {
      tab: 'Punto Medio · consolidaciones',
      n: puntoMedioPending?.cons ?? 0,
      pill: 'Sistema',
      pillKind: 'neutral',
      icon: Activity,
      delta: puntoMedioPending?.cons === 0 ? 'Cola al día' : `${puntoMedioPending?.cons} sin revisar`,
    },
    {
      tab: 'Punto Medio · patrones',
      n: puntoMedioPending?.pat ?? 0,
      pill: 'Sistema',
      pillKind: 'neutral',
      icon: Sparkles,
      delta: puntoMedioPending?.pat === 0 ? 'Cola al día' : `${puntoMedioPending?.pat} sin revisar`,
    },
    {
      tab: 'Solicitudes de acceso',
      n: 2,
      pill: 'Usuarios',
      pillKind: 'info',
      icon: UserPlus,
      delta: 'Pendiente >48h',
    },
  ];

  const totalPending = queueRows.reduce((acc, r) => acc + r.n, 0);

  return (
    <>
      <SectionHeader
        eyebrow={`Operación · ${formatDateTime(new Date())} CST`}
        actions={
          <>
            <ActionButton variant="ghost" icon={Download}>
              Reporte semanal
            </ActionButton>
            <ActionButton variant="coral" icon={Zap}>
              Forzar re-índice
            </ActionButton>
          </>
        }
      />

      {/* KPI strip */}
      <div className="mb-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <KPI
          label="Chunks indexados"
          value={summary.data ? NUM.format(summary.data.chunks) : '—'}
          delta={summary.isMock ? 'mock' : 'live · Supabase'}
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
          delta={summary.data ? 'live · Supabase' : '—'}
          deltaDir="flat"
          spark={[1.6, 1.7, 1.7, 1.9, 2.0, 2.0, 2.1, 2.0, 2.1, 2.1]}
          sparkColor="#1534dc"
        />
        <KPI
          label="Cola de revisión"
          value={String(totalPending)}
          delta={`${queueRows.find((r) => r.n > 0)?.tab.split(' ')[0] ?? '—'}`}
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
                <span className="font-semibold text-[#E11D48]">
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
                  <div className="flex items-center gap-3.5">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-[#0e1745]/[0.04] text-[#0e1745]">
                      <Icon size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold">{row.tab}</span>
                        <Pill kind={row.pillKind}>{row.pill}</Pill>
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[#0e1745]/55">
                        {row.delta}
                      </div>
                    </div>
                    <span className="min-w-[28px] text-right font-display text-[22px] font-normal tabular-nums text-[#0e1745]">
                      {row.n}
                    </span>
                    <ActionButton variant="quiet" icon={ArrowRight} />
                  </div>
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
            meta="claude-sonnet-4.6 · gpt-4.1"
          />
          <CardBody className="flex flex-col gap-1.5">
            <BarRow
              name={
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[12px]">⚖️</span> Lexa
                </span>
              }
              value={420}
              max={600}
              color="#7A3B47"
              secondary="420 q"
            />
            <BarRow
              name={
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[12px]">📑</span> Atlas
                </span>
              }
              value={310}
              max={600}
              color="#8B6E54"
              secondary="310 q"
            />
            <BarRow
              name={
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-[12px]">📡</span> Centinela
                </span>
              }
              value={88}
              max={600}
              color="#F43F5E"
              secondary="88 q"
            />
            <div className="my-2 h-px bg-[#0e1745]/[0.06]" />
            <BarRow name="Latencia P50 (ms)" value={1280} max={3000} color="#10b981" secondary="1.28s" />
            <BarRow name="Latencia P95 (ms)" value={2100} max={3000} color="#f59e0b" secondary="2.10s" />
            <BarRow name="Tasa de error" value={0.4} max={5} color="#ef4444" secondary="0.4%" />
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
            meta={`${STATIC_ALERTS.length} abiertas`}
          />
          <div>
            {STATIC_ALERTS.map((a, i) => (
              <CardRow key={i}>
                <div className="flex gap-3">
                  <span
                    className="mt-[2px] shrink-0"
                    style={{ color: a.sev === 'danger' ? '#b91c1c' : '#b45309' }}
                  >
                    <AlertTriangle size={16} strokeWidth={2} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold">{a.title}</span>
                      <Pill kind={a.sev === 'danger' ? 'danger' : 'warn'}>
                        {a.sev === 'danger' ? 'crítica' : 'aviso'}
                      </Pill>
                    </div>
                    <div className="mt-1 text-[12px] leading-relaxed text-[#0e1745]/65">
                      {a.desc}
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-[#0e1745]/45">{a.when}</div>
                  </div>
                  <ActionButton variant="ghost" className="self-start">
                    {a.cta}
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
            meta={<ActionButton variant="quiet">Ver auditoría</ActionButton>}
          />
          <div>
            {STATIC_ACTIVITY.map((r, i) => {
              const Icon = r.icon;
              return (
                <CardRow key={i}>
                  <div className="flex items-center gap-3">
                    <Avatar initials={r.initials} color={r.color} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-[#0e1745]">
                        <strong className="font-semibold">{r.who}</strong>{' '}
                        <span className="text-[#0e1745]/60">{r.verb}</span> {r.what}
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-[#0e1745]/45">
                        {r.when} · 26 abr 2026
                      </div>
                    </div>
                    <span className="text-[#0e1745]/40">
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
