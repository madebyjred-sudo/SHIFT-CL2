/**
 * Agentes — live status of Lexa, Atlas, Centinela.
 *
 * Counts come from the BFF's in-memory ring buffer (`agentStats.ts`).
 * They reset on process restart by design — the card label says
 * "últimos 60 min" / "24h" so a fresh window is honest.
 *
 * Toggling enabled hits PATCH /api/admin/agents/:id; the chat router
 * gates the next request immediately. Model overrides land in
 * `agent_overrides.model` and override the YAML default at request
 * time.
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
  X,
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
import {
  fetchAgentsStatus,
  patchAgent,
  useAdminFetch,
  type AgentStatus,
} from '@/services/adminApi';
import { useToast } from '../Toast';

const AGENT_META: Record<string, { name: string; emoji: string; color: string; role: string }> = {
  lexa:      { name: 'Lexa',      emoji: '⚖️', color: '#7A3B47', role: 'Análisis Plenario' },
  atlas:     { name: 'Atlas',     emoji: '📑', color: '#8B6E54', role: 'Comisiones & Datos' },
  centinela: { name: 'Centinela', emoji: '📡', color: '#F43F5E', role: 'Alertas & Seguimiento' },
};

const DEFAULT_MODELS: Record<string, string> = {
  lexa: 'anthropic/claude-sonnet-4.6',
  atlas: 'anthropic/claude-sonnet-4.6',
  centinela: 'openai/gpt-4.1',
};

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
  const status = useAdminFetch(fetchAgentsStatus);
  const { notify, confirm } = useToast();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [editingAgent, setEditingAgent] = useState<AgentStatus | null>(null);

  const items = status.data?.items ?? [];

  const setBusyFor = (id: string, on: boolean) => {
    setBusy((s) => {
      const out = new Set(s);
      if (on) out.add(id); else out.delete(id);
      return out;
    });
  };

  const onToggle = async (a: AgentStatus, next: boolean) => {
    if (!next) {
      const ok = await confirm({
        title: `Pausar a ${AGENT_META[a.agent_id]!.name}?`,
        description:
          'Mientras esté pausado, sus consultas devuelven 503 con un mensaje al usuario. El cambio aplica a la siguiente request.',
        confirmLabel: 'Pausar',
        destructive: true,
      });
      if (!ok) return;
    }
    setBusyFor(a.agent_id, true);
    try {
      await patchAgent(a.agent_id, { enabled: next });
      notify({
        kind: 'success',
        text: next ? `${AGENT_META[a.agent_id]!.name} activado` : `${AGENT_META[a.agent_id]!.name} pausado`,
      });
      void status.refetch();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo guardar', detail: (err as Error).message });
    } finally {
      setBusyFor(a.agent_id, false);
    }
  };

  const onSaveModel = async (id: string, model: string | null) => {
    setBusyFor(id, true);
    try {
      await patchAgent(id, { model });
      notify({ kind: 'success', text: model ? `Modelo de ${id} cambió` : `Modelo de ${id} restaurado al default` });
      setEditingAgent(null);
      void status.refetch();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo guardar el modelo', detail: (err as Error).message });
    } finally {
      setBusyFor(id, false);
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="Operación · Agentes en línea"
        actions={
          <>
            <ActionButton
              variant="ghost"
              icon={GitBranch}
              onClick={() => notify({ kind: 'info', text: 'Versionado de prompts vendrá en una iteración próxima.' })}
            >
              Versiones de prompt
            </ActionButton>
            <ActionButton
              variant="coral"
              icon={Plus}
              onClick={() =>
                notify({
                  kind: 'info',
                  text: 'Crear agente requiere correr el flujo de skills/registry.',
                  detail: 'Por ahora se hace editando packages/cerebro-config/agents/*.yaml y subiendo el package.',
                })
              }
            >
              Nuevo agente
            </ActionButton>
          </>
        }
      />

      {/* Agent cards */}
      <div className="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {items.map((a) => {
          const meta = AGENT_META[a.agent_id]!;
          const effectiveModel = a.model ?? DEFAULT_MODELS[a.agent_id] ?? '—';
          const health = a.error_rate_pct > 1 ? 'amber' : a.queries_recent_60m === 0 ? 'idle' : 'green';
          return (
            <Card key={a.agent_id} className="relative overflow-hidden">
              <div
                className="absolute left-0 right-0 top-0 h-[3px] opacity-85"
                style={{ background: meta.color }}
              />
              <CardHeader
                title={
                  <div className="flex items-center gap-2.5">
                    <span className="text-[22px]">{meta.emoji}</span>
                    <div>
                      <div
                        className="font-display text-[18px] font-medium tracking-tight"
                        style={{ color: meta.color }}
                      >
                        {meta.name}
                      </div>
                      <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">{meta.role}</div>
                    </div>
                  </div>
                }
                meta={
                  <Toggle
                    on={a.enabled}
                    onChange={(next) => void onToggle(a, next)}
                    coral
                    label={`Pausar ${meta.name}`}
                  />
                }
              />
              <CardBody className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <StatusDot kind={health} pulse={health === 'green'} />
                  <span className="text-[12px] font-semibold text-[#0e1745] dark:text-white">
                    {!a.enabled ? 'Pausado' : health === 'green' ? 'Saludable' : health === 'amber' ? 'Latencia/error alto' : 'Sin tráfico'}
                  </span>
                  <span className="ml-auto font-mono text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
                    {a.queries_recent_60m} q/60m
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                  <Metric
                    label="Modelo"
                    value={
                      <span className="font-mono text-[11px] truncate block">
                        {effectiveModel}
                        {a.model && (
                          <span className="ml-1 text-cl2-accent" title="Override activo">●</span>
                        )}
                      </span>
                    }
                  />
                  <Metric label="Consultas 24h" value={<span className="font-semibold tabular-nums">{a.queries_24h}</span>} />
                  <Metric
                    label="Latencia P50"
                    value={<span className="tabular-nums">{a.p50_ms != null ? `${a.p50_ms} ms` : '—'}</span>}
                  />
                  <Metric
                    label="Latencia P95"
                    value={
                      <span
                        className="tabular-nums"
                        style={{ color: (a.p95_ms ?? 0) > 2200 ? '#b45309' : undefined }}
                      >
                        {a.p95_ms != null ? `${a.p95_ms} ms` : '—'}
                      </span>
                    }
                  />
                  <Metric
                    label="Tasa de error"
                    value={
                      <span
                        className="font-semibold"
                        style={{ color: a.error_rate_pct > 0.5 ? '#b45309' : '#047857' }}
                      >
                        {a.error_rate_pct.toFixed(2)}%
                      </span>
                    }
                  />
                  <Metric
                    label="Estado"
                    value={
                      a.enabled ? (
                        <Pill kind="success">activo</Pill>
                      ) : (
                        <Pill kind="warn">pausado</Pill>
                      )
                    }
                  />
                </div>
              </CardBody>
              <div className="flex items-center gap-1 rounded-b-xl border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.012] dark:bg-white/[0.02] px-3 py-2.5">
                <ActionButton
                  variant="quiet"
                  icon={FileText}
                  onClick={() =>
                    notify({
                      kind: 'info',
                      text: 'Prompt vive en packages/cerebro-config/agents/' + a.agent_id + '.yaml',
                    })
                  }
                >
                  Prompt
                </ActionButton>
                <ActionButton
                  variant="quiet"
                  icon={BarChart3}
                  onClick={() => void status.refetch()}
                >
                  Refrescar
                </ActionButton>
                <ActionButton
                  variant="quiet"
                  icon={MessageSquare}
                  onClick={() => {
                    window.open(`/?agent=${a.agent_id}`, '_blank');
                  }}
                >
                  Probar
                </ActionButton>
                <span className="flex-1" />
                <ActionButton
                  variant="quiet"
                  icon={Pencil}
                  disabled={busy.has(a.agent_id)}
                  onClick={() => setEditingAgent(a)}
                >
                  Editar
                </ActionButton>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Cross-agent routing matrix */}
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
            { header: 'Capacidad', cell: (r) => <span className="font-semibold">{r.capability}</span> },
            { header: 'Agente preferido', cell: (r) => <AgentPill id={r.primary} />, width: '160px' },
            {
              header: 'Fallback',
              cell: (r) =>
                r.fallback ? <AgentPill id={r.fallback} /> : <span className="text-[#0e1745]/55 dark:text-white/55">—</span>,
              width: '140px',
            },
            { header: 'Confianza umbral', cell: (r) => <span className="font-mono tabular-nums">{r.threshold}</span>, width: '140px' },
            {
              header: 'Citación obligatoria',
              cell: (r) =>
                r.citationRequired ? (
                  <Pill kind="success" icon={Check}>requerida</Pill>
                ) : (
                  <Pill kind="neutral">opcional</Pill>
                ),
              width: '160px',
            },
          ]}
        />
      </Card>

      {editingAgent && (
        <ModelEditDialog
          agent={editingAgent}
          defaultModel={DEFAULT_MODELS[editingAgent.agent_id] ?? ''}
          busy={busy.has(editingAgent.agent_id)}
          onCancel={() => setEditingAgent(null)}
          onSave={(model) => void onSaveModel(editingAgent.agent_id, model)}
        />
      )}
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

function ModelEditDialog(props: {
  agent: AgentStatus;
  defaultModel: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (model: string | null) => void;
}): React.ReactElement {
  const [value, setValue] = useState<string>(props.agent.model ?? props.defaultModel);
  const isOverride = props.agent.model != null;

  return (
    <div
      className="fixed inset-0 z-[201] flex items-center justify-center bg-[#0e1745]/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={props.onCancel}
    >
      <div
        className="mx-4 w-full max-w-md rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.08] bg-white dark:bg-[#231f1f] p-5 shadow-[0_24px_60px_rgba(14,23,69,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/45 dark:text-white/45">
              Editar modelo
            </div>
            <div className="font-display text-[20px] font-medium tracking-tight text-[#0e1745] dark:text-white">
              {props.agent.agent_id[0]!.toUpperCase() + props.agent.agent_id.slice(1)}
            </div>
          </div>
          <button
            type="button"
            onClick={props.onCancel}
            className="rounded p-1 text-[#0e1745]/55 dark:text-white/55 hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.06]"
          >
            <X size={14} />
          </button>
        </div>

        <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/55">
          OpenRouter model id
        </label>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          className="mt-1.5 w-full rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-3 py-2 font-mono text-[12.5px] text-[#0e1745] dark:text-white outline-none focus:border-cl2-accent/40 focus:ring-2 focus:ring-cl2-accent/15"
          placeholder={props.defaultModel}
        />
        <div className="mt-1.5 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
          Default: <span className="font-mono">{props.defaultModel}</span>
          {isOverride && (
            <span className="ml-2 inline-flex items-center gap-1 text-cl2-accent">
              <span>●</span> override activo
            </span>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => props.onSave(null)}
            disabled={props.busy || !isOverride}
            className="text-[12px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white disabled:opacity-40"
          >
            Restaurar default
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={props.onCancel}
              className="rounded-lg border border-[#0e1745]/[0.10] dark:border-white/10 bg-white dark:bg-white/[0.05] px-3.5 py-2 text-[12.5px] font-semibold text-[#0e1745] dark:text-white hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10]"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => props.onSave(value.trim() || null)}
              disabled={props.busy || value.trim() === (props.agent.model ?? props.defaultModel)}
              className="rounded-lg bg-cl2-accent px-3.5 py-2 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgba(249,53,73,0.22)] hover:bg-cl2-accent-hover disabled:opacity-50"
            >
              {props.busy ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
