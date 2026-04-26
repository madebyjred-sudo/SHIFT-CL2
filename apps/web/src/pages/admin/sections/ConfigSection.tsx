/**
 * Configuración — modelos, feature flags, rate limits, build info.
 *
 * Modelos + flags persist to localStorage today (single-operator demo).
 * When tenant config lands, swap useState for the tenant_config table.
 */
import { useEffect, useState } from 'react';
import { RotateCcw, Check, Pencil } from 'lucide-react';
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
import { fetchAdminBuild, useAdminFetch } from '@/services/adminApi';

interface Flags {
  deepInsight: boolean;
  voiceQuery: boolean;
  expExtract: boolean;
  citationsForce: boolean;
  graphRag: boolean;
  hybridRetrieval: boolean;
}

const DEFAULT_FLAGS: Flags = {
  deepInsight: true,
  voiceQuery: false,
  expExtract: true,
  citationsForce: true,
  graphRag: false,
  hybridRetrieval: true,
};

const STORAGE_KEY = 'cl2.admin.flags';

export function ConfigSection(): React.ReactElement {
  const [flags, setFlags] = useState<Flags>(() => {
    if (typeof window === 'undefined') return DEFAULT_FLAGS;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULT_FLAGS, ...(JSON.parse(raw) as Partial<Flags>) } : DEFAULT_FLAGS;
    } catch {
      return DEFAULT_FLAGS;
    }
  });
  const [dirty, setDirty] = useState(false);
  const build = useAdminFetch(fetchAdminBuild);

  useEffect(() => {
    if (!dirty) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flags));
  }, [flags, dirty]);

  const flip = (k: keyof Flags) => {
    setFlags((f) => ({ ...f, [k]: !f[k] }));
    setDirty(true);
  };

  return (
    <>
      <SectionHeader
        eyebrow="Sistema · Configuración"
        actions={
          <>
            <ActionButton
              variant="ghost"
              icon={RotateCcw}
              onClick={() => {
                setFlags(DEFAULT_FLAGS);
                setDirty(true);
              }}
            >
              Restaurar defaults
            </ActionButton>
            <ActionButton variant="coral" icon={Check} disabled={!dirty}>
              Guardar cambios
            </ActionButton>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Modelos */}
        <Card>
          <CardHeader title="Modelos & límites" meta="por agente" />
          <CardBody className="flex flex-col gap-3.5">
            {[
              { label: 'Modelo Lexa',      value: 'anthropic/claude-sonnet-4.6', sec: 'temperature 0.2 · 4k tok' },
              { label: 'Modelo Atlas',     value: 'anthropic/claude-sonnet-4.6', sec: 'temperature 0.1 · 4k tok' },
              { label: 'Modelo Centinela', value: 'openai/gpt-4.1',              sec: 'temperature 0.3 · 6k tok' },
              { label: 'Embeddings',       value: 'gemini-embedding-001',         sec: '3.072 dim · multilingual' },
              { label: 'Reranker',         value: 'voyageai/rerank-2',            sec: 'top-30 → top-k · identity fallback' },
              { label: 'Whisper',          value: 'whisper-large · v3',           sec: 'es-CR · diarización on' },
            ].map((m) => (
              <div key={m.label} className="flex items-center gap-3">
                <div className="flex-1">
                  <div className="text-[12px] text-[#0e1745]/60 dark:text-white/60">{m.label}</div>
                  <div className="font-mono text-[12.5px] font-semibold text-[#0e1745] dark:text-white">{m.value}</div>
                  <div className="text-[11px] text-[#0e1745]/50 dark:text-white/50">{m.sec}</div>
                </div>
                <ActionButton variant="ghost" icon={Pencil}>
                  Editar
                </ActionButton>
              </div>
            ))}
          </CardBody>
        </Card>

        {/* Feature flags */}
        <Card>
          <CardHeader title="Feature flags" meta="cambia visible a usuario" />
          <div>
            {[
              { k: 'deepInsight',     ttl: 'Deep Insight (Centinela)',           desc: 'Botón shiny-cta en composer para análisis profundo. Costo más alto.' },
              { k: 'voiceQuery',      ttl: 'Consulta por voz',                    desc: 'Whisper en navegador. Beta; off por default.' },
              { k: 'expExtract',      ttl: 'Extracción auto de expedientes',      desc: 'Atlas detecta Exp. NN.NNN en mensajes y los precarga.' },
              { k: 'citationsForce',  ttl: 'Citación obligatoria',                desc: 'Bloquea respuestas sin al menos una cita. No tocar.' },
              { k: 'hybridRetrieval', ttl: 'Hybrid retrieval (BM25 + dense + RRF)', desc: 'On por default. Combina lexical y semántico vía RPC `match_chunks_hybrid`.' },
              { k: 'graphRag',        ttl: 'GraphRAG / LightRAG',                  desc: 'Activa la tool query_legislative_graph. Requiere Cerebro con lightrag-hku instalado.' },
            ].map((f) => (
              <CardRow key={f.k}>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="text-[13px] font-semibold">{f.ttl}</div>
                    <div className="mt-0.5 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">{f.desc}</div>
                  </div>
                  <Toggle on={flags[f.k as keyof Flags]} onChange={() => flip(f.k as keyof Flags)} coral />
                </div>
              </CardRow>
            ))}
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
