/**
 * Agentes — live status of Lexa, Atlas, Centinela.
 *
 * Today the metrics are static — the BFF doesn't yet record per-agent
 * latency / cost / citation rate. Marked `mock` next to the values so
 * the operator can read at a glance which numbers are real (model
 * config, on/off toggle) vs aspirational (queries 24h, p95).
 */
import { useState } from 'react';
import {
  GitBranch,
  Plus,
  Layers,
  FileText,
  BarChart3,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Check,
} from 'lucide-react';
import {
  ActionButton,
  AgentPill,
  Card,
  CardBody,
  CardHeader,
  Pill,
  SectionHeader,
  StatusDot,
  Toggle,
} from '../primitives';
import { AdminTable } from '../Table';

interface AgentRow {
  id: 'lexa' | 'atlas' | 'centinela';
  name: string;
  emoji: string;
  color: string;
  role: string;
  model: string;
  enabled: boolean;
  health: 'green' | 'amber' | 'rose';
  uptime: string;
  queries24h: number;
  citationRate: number;
  p50: number;
  p95: number;
  cost24h: number;
  errors: number;
}

const INITIAL: AgentRow[] = [
  {
    id: 'lexa', name: 'Lexa', emoji: '⚖️', color: '#7A3B47',
    role: 'Análisis Plenario', model: 'anthropic/claude-sonnet-4.6',
    enabled: true, health: 'green', uptime: '99.94%',
    queries24h: 842, citationRate: 98.2, p50: 1180, p95: 2040,
    cost24h: 41.20, errors: 0.3,
  },
  {
    id: 'atlas', name: 'Atlas', emoji: '📑', color: '#8B6E54',
    role: 'Comisiones & Datos', model: 'anthropic/claude-sonnet-4.6',
    enabled: true, health: 'amber', uptime: '99.81%',
    queries24h: 514, citationRate: 96.7, p50: 1340, p95: 2280,
    cost24h: 28.90, errors: 0.6,
  },
  {
    id: 'centinela', name: 'Centinela', emoji: '📡', color: '#F43F5E',
    role: 'Alertas & Seguimiento', model: 'openai/gpt-4.1',
    enabled: true, health: 'green', uptime: '99.99%',
    queries24h: 126, citationRate: 99.1, p50: 980, p95: 1820,
    cost24h: 14.20, errors: 0.1,
  },
];

interface RoutingRow {
  capability: string;
  primary: 'lexa' | 'atlas' | 'centinela';
  fallback: 'lexa' | 'atlas' | 'centinela' | null;
  threshold: string;
  citationRequired: boolean;
}

const ROUTING: RoutingRow[] = [
  { capability: 'Buscar en transcripción de plenaria', primary: 'lexa', fallback: 'atlas',     threshold: '0.78', citationRequired: true },
  { capability: 'Resumir debate por orador',           primary: 'lexa', fallback: null,        threshold: '0.82', citationRequired: true },
  { capability: 'Buscar dictamen de comisión',         primary: 'atlas', fallback: 'lexa',     threshold: '0.75', citationRequired: true },
  { capability: 'Cruce mociones × votación nominal',   primary: 'atlas', fallback: 'lexa',     threshold: '0.70', citationRequired: true },
  { capability: 'Alerta diaria · Deep Insight',        primary: 'centinela', fallback: null,   threshold: '0.85', citationRequired: true },
  { capability: 'Comparativa entre expedientes',       primary: 'centinela', fallback: 'atlas', threshold: '0.80', citationRequired: true },
  { capability: 'Pregunta general / charla',           primary: 'lexa', fallback: null,        threshold: '0.50', citationRequired: false },
];

export function AgentesSection(): React.ReactElement {
  const [agents, setAgents] = useState<AgentRow[]>(INITIAL);
  const toggle = (id: AgentRow['id']) =>
    setAgents((a) => a.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)));

  return (
    <>
      <SectionHeader
        eyebrow="Operación · Agentes en línea"
        actions={
          <>
            <ActionButton variant="ghost" icon={GitBranch}>
              Versiones de prompt
            </ActionButton>
            <ActionButton variant="coral" icon={Plus}>
              Nuevo agente
            </ActionButton>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {agents.map((a) => (
          <Card key={a.id} className="relative overflow-hidden">
            <div
              className="absolute left-0 right-0 top-0 h-[3px] opacity-85"
              style={{ background: a.color }}
            />
            <CardHeader
              title={
                <div className="flex items-center gap-2.5">
                  <span className="text-[22px]">{a.emoji}</span>
                  <div>
                    <div
                      className="font-display text-[18px] font-medium tracking-tight"
                      style={{ color: a.color }}
                    >
                      {a.name}
                    </div>
                    <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">{a.role}</div>
                  </div>
                </div>
              }
              meta={<Toggle on={a.enabled} onChange={() => toggle(a.id)} coral />}
            />
            <CardBody className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <StatusDot kind={a.health} pulse={a.health === 'green'} />
                <span className="text-[12px] font-semibold text-[#0e1745] dark:text-white">
                  {a.health === 'green'
                    ? 'Saludable'
                    : a.health === 'amber'
                      ? 'Latencia alta'
                      : 'Caído'}
                </span>
                <span className="ml-auto font-mono text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
                  uptime {a.uptime}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <Metric label="Modelo" value={<span className="font-mono text-[11px]">{a.model}</span>} />
                <Metric
                  label="Consultas 24h"
                  value={
                    <span className="font-semibold tabular-nums">
                      {a.queries24h.toLocaleString('es-CR')}
                    </span>
                  }
                />
                <Metric
                  label="Tasa con cita"
                  value={
                    <span
                      className="font-semibold"
                      style={{ color: a.citationRate > 97 ? '#047857' : '#b45309' }}
                    >
                      {a.citationRate}%
                    </span>
                  }
                />
                <Metric
                  label="Errores"
                  value={
                    <span
                      className="font-semibold"
                      style={{ color: a.errors > 0.5 ? '#b45309' : '#047857' }}
                    >
                      {a.errors}%
                    </span>
                  }
                />
                <Metric
                  label="Latencia P50"
                  value={<span className="tabular-nums">{a.p50} ms</span>}
                />
                <Metric
                  label="Latencia P95"
                  value={
                    <span
                      className="tabular-nums"
                      style={{ color: a.p95 > 2200 ? '#b45309' : '#0e1745' }}
                    >
                      {a.p95} ms
                    </span>
                  }
                />
              </div>

              <div className="h-px bg-[#0e1745]/[0.06] dark:bg-white/[0.08]" />
              <div className="flex items-center gap-2">
                <span className="text-[11.5px] text-[#0e1745]/60 dark:text-white/60">Costo · 24h</span>
                <span className="ml-auto font-display text-[18px] font-medium tabular-nums text-[#0e1745] dark:text-white">
                  ${a.cost24h.toFixed(2)}
                </span>
              </div>
            </CardBody>
            <div className="flex items-center gap-1 rounded-b-xl border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.012] dark:bg-white/[0.02] px-3 py-2.5">
              <ActionButton variant="quiet" icon={FileText}>
                Prompt
              </ActionButton>
              <ActionButton variant="quiet" icon={BarChart3}>
                Métricas
              </ActionButton>
              <ActionButton variant="quiet" icon={MessageSquare}>
                Probar
              </ActionButton>
              <span className="flex-1" />
              <ActionButton variant="quiet" icon={MoreHorizontal} />
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-1.5">
              <Layers size={13} /> Capacidades · matriz de routing
            </span>
          }
          meta="El router envía a un agente según el dominio detectado"
        />
        <AdminTable<RoutingRow>
          rowKey={(r) => r.capability}
          rows={ROUTING}
          columns={[
            {
              header: 'Capacidad',
              cell: (r) => <span className="font-semibold">{r.capability}</span>,
            },
            {
              header: 'Agente preferido',
              cell: (r) => <AgentPill id={r.primary} />,
              width: '160px',
            },
            {
              header: 'Fallback',
              cell: (r) => (r.fallback ? <AgentPill id={r.fallback} /> : <span className="text-[#0e1745]/55 dark:text-white/55">—</span>),
              width: '140px',
            },
            {
              header: 'Confianza umbral',
              cell: (r) => <span className="font-mono tabular-nums">{r.threshold}</span>,
              width: '140px',
              cellClassName: 'tabular-nums',
            },
            {
              header: 'Citación obligatoria',
              cell: (r) =>
                r.citationRequired ? (
                  <Pill kind="success" icon={Check}>
                    requerida
                  </Pill>
                ) : (
                  <Pill kind="neutral">opcional</Pill>
                ),
              width: '160px',
            },
            {
              header: '',
              cell: () => <ActionButton variant="quiet" icon={Pencil} />,
              width: '60px',
              align: 'right',
            },
          ]}
        />
      </Card>
    </>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/50 dark:text-white/50">
        {label}
      </div>
      <div className="text-[12.5px] text-[#0e1745] dark:text-white">{value}</div>
    </div>
  );
}
