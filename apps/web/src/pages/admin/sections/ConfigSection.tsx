/**
 * Configuración — modelos, feature flags, rate limits, build info.
 *
 * Flags persist server-side via /api/admin/flags (Supabase
 * `feature_flags`). Optimistic UI: toggle flips instantly, reverts on
 * API error. Models live in /api/admin/agents (PATCH model) — clicking
 * Editar deep-links to the Agentes section where the modal lives.
 *
 * "Restaurar defaults" reverts each flag to its first-paint value (the
 * snapshot loaded on mount), not the seeded defaults — that way the
 * operator can test toggles freely and one click reverses everything
 * since they last loaded the page.
 */
import { useEffect, useState } from 'react';
import { RotateCcw, Pencil, RefreshCw } from 'lucide-react';
import {
  ActionButton,
  BarRow,
  Card,
  CardBody,
  CardHeader,
  CardRow,
  Pill,
  SectionHeader,
  Toggle,
} from '../primitives';
import {
  fetchAdminBuild,
  fetchFlags,
  patchFlag,
  useAdminFetch,
  type FeatureFlags,
} from '@/services/adminApi';
import { navigate } from '@/lib/router';
import { useToast } from '../Toast';

interface FlagDef {
  key: string;
  title: string;
  description: string;
}

const FLAG_DEFS: FlagDef[] = [
  { key: 'deep_insight',     title: 'Deep Insight (Centinela)',           description: 'Botón shiny-cta en el composer para análisis profundo. Costo más alto.' },
  { key: 'voice_query',      title: 'Consulta por voz',                    description: 'Whisper en navegador. Beta; off por default.' },
  { key: 'exp_extract',      title: 'Extracción auto de expedientes',      description: 'Atlas detecta Exp. NN.NNN en mensajes y los precarga.' },
  { key: 'citations_force',  title: 'Citación obligatoria',                description: 'Bloquea respuestas sin al menos una cita. No tocar.' },
  { key: 'hybrid_retrieval', title: 'Hybrid retrieval (BM25 + dense + RRF)', description: 'On por default. Combina lexical y semántico vía match_chunks_hybrid.' },
  { key: 'graph_rag',        title: 'GraphRAG / LightRAG',                  description: 'Activa la tool query_legislative_graph. Requiere Cerebro con lightrag-hku instalado.' },
];

const MODEL_ROWS = [
  { agent: 'lexa',      label: 'Modelo Lexa',      def: 'anthropic/claude-sonnet-4.6', sec: 'Análisis Plenario · 4k tok' },
  { agent: 'atlas',     label: 'Modelo Atlas',     def: 'anthropic/claude-sonnet-4.6', sec: 'Comisiones & Datos · 4k tok' },
  { agent: 'centinela', label: 'Modelo Centinela', def: 'openai/gpt-4.1',              sec: 'Alertas · 6k tok' },
] as const;

const STATIC_INFRA = [
  { label: 'Embeddings', value: 'gemini-embedding-001',  sec: '3.072 dim · multilingual', edit: false },
  { label: 'Reranker',   value: 'voyageai/rerank-2',     sec: 'top-30 → top-k · identity fallback', edit: false },
  { label: 'Whisper',    value: 'whisper-large · v3',    sec: 'es-CR · diarización on', edit: false },
];

export function ConfigSection(): React.ReactElement {
  const { notify, confirm } = useToast();
  const flagsState = useAdminFetch(fetchFlags);
  const build = useAdminFetch(fetchAdminBuild);

  // Local optimistic mirror of flag values. We seed it from the server
  // response and write through it so the UI flips instantly while the
  // upsert lands. On error, we revert.
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [snapshot, setSnapshot] = useState<FeatureFlags | null>(null);
  const [optimistic, setOptimistic] = useState<FeatureFlags>({});

  useEffect(() => {
    if (flagsState.data?.flags && snapshot === null) {
      setSnapshot(flagsState.data.flags);
      setOptimistic(flagsState.data.flags);
    }
  }, [flagsState.data, snapshot]);

  const flagBool = (key: string): boolean => {
    const v = optimistic[key];
    return v === true || v === 'true';
  };

  const onToggle = async (key: string, next: boolean) => {
    setPending((s) => new Set(s).add(key));
    setOptimistic((o) => ({ ...o, [key]: next }));
    try {
      await patchFlag(key, next);
      notify({ kind: 'success', text: `Flag ${key} = ${next ? 'on' : 'off'}` });
    } catch (err) {
      // Revert on failure.
      setOptimistic((o) => ({ ...o, [key]: !next }));
      notify({ kind: 'error', text: 'No se pudo guardar el flag', detail: (err as Error).message });
    } finally {
      setPending((s) => {
        const out = new Set(s);
        out.delete(key);
        return out;
      });
    }
  };

  const restoreDefaults = async () => {
    if (!snapshot) return;
    const ok = await confirm({
      title: 'Restaurar valores anteriores',
      description:
        'Esto vuelve a los valores que estaban activos cuando entraste a esta vista. No restaura los defaults de la tabla.',
      confirmLabel: 'Restaurar',
    });
    if (!ok) return;

    // Walk every flag whose current optimistic value differs from the
    // original snapshot, push the snapshot value back through the API.
    const dirty = Object.keys(snapshot).filter(
      (k) => JSON.stringify(snapshot[k]) !== JSON.stringify(optimistic[k]),
    );
    if (dirty.length === 0) {
      notify({ kind: 'info', text: 'Nada que restaurar — sin cambios' });
      return;
    }
    try {
      for (const k of dirty) {
        // eslint-disable-next-line no-await-in-loop
        await patchFlag(k, snapshot[k]);
      }
      setOptimistic(snapshot);
      notify({ kind: 'success', text: `${dirty.length} flag(s) restaurado(s)` });
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo restaurar', detail: (err as Error).message });
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="Sistema · Configuración"
        actions={
          <>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void flagsState.refetch()}>
              Recargar
            </ActionButton>
            <ActionButton variant="ghost" icon={RotateCcw} onClick={() => void restoreDefaults()}>
              Restaurar
            </ActionButton>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Modelos */}
        <Card>
          <CardHeader title="Modelos & runtime" meta="por agente" />
          <CardBody className="flex flex-col gap-3.5">
            {MODEL_ROWS.map((m) => (
              <div key={m.agent} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-[#0e1745]/60 dark:text-white/60">{m.label}</div>
                  <div className="font-mono text-[12.5px] font-semibold text-[#0e1745] dark:text-white truncate">
                    {m.def}
                  </div>
                  <div className="text-[11px] text-[#0e1745]/50 dark:text-white/50">{m.sec}</div>
                </div>
                <ActionButton variant="ghost" icon={Pencil} onClick={() => navigate('/admin/agentes')}>
                  Editar
                </ActionButton>
              </div>
            ))}
            <div className="my-1 h-px bg-[#0e1745]/[0.06] dark:bg-white/[0.08]" />
            {STATIC_INFRA.map((m) => (
              <div key={m.label} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] text-[#0e1745]/60 dark:text-white/60">{m.label}</div>
                  <div className="font-mono text-[12.5px] font-semibold text-[#0e1745] dark:text-white truncate">
                    {m.value}
                  </div>
                  <div className="text-[11px] text-[#0e1745]/50 dark:text-white/50">{m.sec}</div>
                </div>
                <Pill kind="neutral">runtime</Pill>
              </div>
            ))}
          </CardBody>
        </Card>

        {/* Feature flags */}
        <Card>
          <CardHeader
            title="Feature flags"
            meta={flagsState.loading ? 'cargando…' : flagsState.error ? <Pill kind="danger">error</Pill> : `live · ${Object.keys(optimistic).length}`}
          />
          <div>
            {FLAG_DEFS.map((f) => {
              const isPending = pending.has(f.key);
              const isOn = flagBool(f.key);
              return (
                <CardRow key={f.key}>
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white flex items-center gap-2">
                        {f.title}
                        {isPending && <Pill kind="neutral">guardando…</Pill>}
                      </div>
                      <div className="mt-0.5 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
                        {f.description}
                      </div>
                    </div>
                    <Toggle
                      on={isOn}
                      onChange={(next) => void onToggle(f.key, next)}
                      coral
                      label={f.title}
                    />
                  </div>
                </CardRow>
              );
            })}
            {flagsState.error && (
              <div className="px-[18px] py-3 text-[11.5px] text-rose-700 dark:text-rose-300">
                No se pudo cargar: {flagsState.error}
              </div>
            )}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Rate limits */}
        <Card>
          <CardHeader title="Rate limits" meta="por usuario · por minuto" />
          <CardBody className="flex flex-col gap-1.5">
            <BarRow name="Mensajes / min"     value={12} max={30}  color="#10b981" secondary="12 / 30" />
            <BarRow name="Deep Insight / día" value={4}  max={10}  color="#F93549" secondary="4 / 10" />
            <BarRow name="Subidas PDF / día"  value={3}  max={20}  color="#1534dc" secondary="3 / 20" />
            <BarRow name="Tokens / sesión"    value={32} max={120} color="#7A3B47" secondary="32k / 120k" />
          </CardBody>
        </Card>

        {/* Build & entorno */}
        <Card>
          <CardHeader title="Build & entorno" meta={build.isMock ? 'mock' : 'producción'} />
          <CardBody className="font-mono text-[11.5px] leading-relaxed text-[#0e1745] dark:text-white">
            <div>
              <span className="text-[#0e1745]/45 dark:text-white/45">$</span> cl2 release info
            </div>
            <div className="mt-1.5 pl-3 text-[#0e1745]/70 dark:text-white/70">
              <Row k="version" v={build.data?.version ?? '—'} />
              <Row k="build" v={build.data?.build ?? '—'} />
              <Row
                k="deployed"
                v={
                  build.data?.deployed_at
                    ? new Date(build.data.deployed_at).toLocaleString('es-CR')
                    : '—'
                }
              />
              <Row k="node" v={build.data?.node ?? '—'} />
              <Row k="region" v={build.data?.region ?? '—'} />
              <Row k="host" v={build.data?.host ?? '—'} />
              <Row k="locale" v={build.data?.locale ?? '—'} />
            </div>
            <div className="mt-3 inline-flex">
              {build.isMock ? (
                <Pill kind="warn">build info aún no inyectado al deploy</Pill>
              ) : (
                <Pill kind="success">live</Pill>
              )}
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Row(props: { k: string; v: string }): React.ReactElement {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-24 shrink-0 text-[#0e1745]/55 dark:text-white/55">{props.k}</span>
      <span className="text-[#0e1745] dark:text-white">{props.v}</span>
    </div>
  );
}
