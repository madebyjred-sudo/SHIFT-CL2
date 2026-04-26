/**
 * Punto Medio — manual review gate for the Cerebro flywheel.
 *
 * Re-uses the existing services/puntoMedioApi.ts logic from the legacy
 * AdminPuntoMedioPage but renders inside the new admin shell with the
 * design package's visual language. The two pages share the same
 * underlying tables; this is the surface forward.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Zap,
  CheckCircle2,
  XCircle,
  Eye,
  MessageSquare,
  Link2,
  Sparkles,
  GitMerge,
} from 'lucide-react';
import {
  ActionButton,
  AgentPill,
  Card,
  CardBody,
  Pill,
  SectionHeader,
  Tabs,
  EmptyState,
} from '../primitives';
import {
  fetchPending,
  reviewPendingItem,
  type PendingBundle,
  type PendingItem,
} from '@/services/puntoMedioApi';
import { forceConsolidate } from '@/services/adminApi';
import { useToast } from '../Toast';

type TabId = 'consolidation' | 'pattern' | 'applied';

interface RowItem extends PendingItem {
  item_type: 'consolidation' | 'pattern';
}

export function PuntoMedioSection(): React.ReactElement {
  const [tab, setTab] = useState<TabId>('consolidation');
  const [bundle, setBundle] = useState<PendingBundle | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [forcing, setForcing] = useState(false);
  const { notify, confirm } = useToast();

  const reload = async () => {
    setError(null);
    try {
      const b = await fetchPending();
      setBundle(b);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleForce = async () => {
    const ok = await confirm({
      title: 'Forzar consolidación ahora',
      description:
        'Cerebro re-consolida los insights pendientes y puede generar nuevos patrones. Toma 1-3 minutos. ¿Seguir?',
      confirmLabel: 'Forzar',
    });
    if (!ok) return;
    setForcing(true);
    try {
      await forceConsolidate();
      notify({ kind: 'success', text: 'Consolidación encolada. Recargá en unos minutos.' });
      void reload();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo forzar consolidación', detail: (err as Error).message });
    } finally {
      setForcing(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const items: RowItem[] = useMemo(() => {
    if (!bundle) return [];
    if (tab === 'consolidation')
      return bundle.pending_consolidations.map((x) => ({ ...x, item_type: 'consolidation' as const }));
    if (tab === 'pattern')
      return bundle.pending_patterns.map((x) => ({ ...x, item_type: 'pattern' as const }));
    return [];
  }, [bundle, tab]);

  const handleAction = async (item: RowItem, action: 'approve' | 'reject') => {
    setBusy((s) => new Set(s).add(item.id));
    try {
      await reviewPendingItem({ id: item.id, action, item_type: item.item_type });
      setBundle((b) => {
        if (!b) return b;
        const drop = (arr: PendingItem[]) => arr.filter((x) => x.id !== item.id);
        return {
          ...b,
          pending_consolidations:
            item.item_type === 'consolidation' ? drop(b.pending_consolidations) : b.pending_consolidations,
          pending_patterns:
            item.item_type === 'pattern' ? drop(b.pending_patterns) : b.pending_patterns,
          pending_consolidations_count:
            item.item_type === 'consolidation'
              ? Math.max(0, b.pending_consolidations_count - 1)
              : b.pending_consolidations_count,
          pending_patterns_count:
            item.item_type === 'pattern'
              ? Math.max(0, b.pending_patterns_count - 1)
              : b.pending_patterns_count,
        };
      });
    } catch (err) {
      setError(`No se pudo ${action === 'approve' ? 'aprobar' : 'rechazar'}: ${(err as Error).message}`);
    } finally {
      setBusy((s) => {
        const out = new Set(s);
        out.delete(item.id);
        return out;
      });
    }
  };

  const consCount = bundle?.pending_consolidations_count ?? 0;
  const patCount = bundle?.pending_patterns_count ?? 0;

  return (
    <>
      <SectionHeader
        eyebrow="Operación · Cerebro institucional"
        actions={
          <>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void reload()}>
              Recargar
            </ActionButton>
            <ActionButton variant="coral" icon={Zap} onClick={() => void handleForce()} disabled={forcing}>
              {forcing ? 'Forzando…' : 'Forzar consolidación'}
            </ActionButton>
          </>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <Tabs<TabId>
          options={[
            { id: 'consolidation', label: <>Consolidaciones <span className="ml-1 opacity-60">{consCount}</span></> },
            { id: 'pattern',       label: <>Patrones <span className="ml-1 opacity-60">{patCount}</span></> },
            { id: 'applied',       label: <>Aplicados <span className="ml-1 opacity-60">—</span></> },
          ]}
          active={tab}
          onChange={setTab}
        />
        {error && (
          <Pill kind="danger" className="ml-auto">
            {error}
          </Pill>
        )}
      </div>

      {!bundle ? (
        <SkeletonRows />
      ) : tab === 'applied' ? (
        <EmptyState
          icon={CheckCircle2}
          title="Aplicados — vista pendiente"
          description="Cuando aprobás un insight, queda aplicado y se inyecta en el system prompt. Esta vista mostrará los activos por agente y permitirá revertirlos."
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Cola al día"
          description={`No hay ${tab === 'consolidation' ? 'consolidaciones' : 'patrones'} pendientes. Cerebro consolida cada noche a las 03:00; revisá mañana o tirá "Forzar consolidación" si necesitás resultados ya.`}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((it) => (
            <ItemRow
              key={it.id}
              item={it}
              busy={busy.has(it.id)}
              onApprove={() => void handleAction(it, 'approve')}
              onReject={() => void handleAction(it, 'reject')}
            />
          ))}
        </div>
      )}
    </>
  );
}

function ItemRow({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: RowItem;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}): React.ReactElement {
  const isPattern = item.item_type === 'pattern';
  const text = item.consolidated_text || item.pattern_text || item.executive_brief || '(sin texto)';
  const Icon = isPattern ? GitMerge : Sparkles;
  const accent = isPattern ? '#F43F5E' : '#7A3B47';
  const bg = isPattern ? 'rgba(244,63,94,0.08)' : 'rgba(122,59,71,0.08)';

  // Derive an agent attribution from the row's category/scope when present
  // — we don't have a clean per-agent column today, so use heuristics
  // matching the design's labeling.
  const agentForCategory =
    item.category?.toLowerCase().includes('atlas')
      ? 'atlas'
      : item.category?.toLowerCase().includes('centinela')
        ? 'centinela'
        : 'lexa';

  return (
    <Card>
      <CardBody className="flex gap-4">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06]"
          style={{ background: bg }}
        >
          <Icon size={22} color={accent} strokeWidth={1.6} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Pill kind={isPattern ? 'centinela' : 'lexa'}>{isPattern ? 'Patrón' : 'Consolidación'}</Pill>
            <AgentPill id={agentForCategory as 'lexa' | 'atlas' | 'centinela'} />
            <span className="font-mono text-[11px] text-[#0e1745]/50 dark:text-white/50">
              score {item.confidence_score?.toFixed(2) ?? '—'}
            </span>
            {item.source_insight_count != null && (
              <span className="text-[11px] text-[#0e1745]/50 dark:text-white/50">· {item.source_insight_count} fuentes</span>
            )}
          </div>
          <div className="mb-1 font-display text-[17px] font-medium tracking-tight leading-snug text-[#0e1745] dark:text-white">
            {item.category ?? 'Insight pendiente'}
          </div>
          <div className="text-[13px] leading-relaxed text-[#0e1745]/70 dark:text-white/70 whitespace-pre-wrap">{text}</div>
          <div className="mt-2 flex items-center gap-2">
            {item.source_insight_count != null && (
              <Pill kind="neutral" icon={Link2}>
                {item.source_insight_count} fuentes
              </Pill>
            )}
            <ActionButton variant="quiet" icon={Eye}>
              Ver evidencia
            </ActionButton>
            <ActionButton variant="quiet" icon={MessageSquare}>
              Probar diff de respuesta
            </ActionButton>
          </div>
          {item.last_consolidated_at && (
            <div className="mt-2 text-[10.5px] text-[#0e1745]/45 dark:text-white/45">
              Última consolidación: {new Date(item.last_consolidated_at).toLocaleString('es-CR')}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5 self-center">
          <ActionButton variant="approve" icon={CheckCircle2} onClick={onApprove} disabled={busy}>
            Aprobar
          </ActionButton>
          <ActionButton variant="reject" icon={XCircle} onClick={onReject} disabled={busy}>
            Rechazar
          </ActionButton>
        </div>
      </CardBody>
    </Card>
  );
}

function SkeletonRows(): React.ReactElement {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="h-32 animate-pulse rounded-xl border border-[#0e1745]/[0.05] dark:border-white/[0.05] bg-white dark:bg-white/[0.02]"
        />
      ))}
    </div>
  );
}
