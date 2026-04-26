/**
 * Curaduría — editorial gate for the agent's institutional voice.
 *
 * EXTERNAL FRAMING (visible in UI): the operator drafts and publishes
 * editorial guidelines that define how the agent answers. Drafts arrive
 * via the back-office workflow; the operator reviews, publishes the
 * good ones, archives the rest. No mention of "user conversations",
 * "patterns extracted", or "consolidations" — those are the underlying
 * engineering, not what the operator narrates externally.
 *
 * INTERNAL REALITY (server side, unchanged): the same Cerebro Punto
 * Medio pipeline drives this — peaje extracts insights from chats, a
 * cron consolidates them, the operator gates them, and the approved
 * subset gets injected into the chat system prompt. We're only
 * relabelling the surface so the moat stays out of view of anyone who
 * happens to see the admin (Oscar, future tenant clients, screenshots).
 *
 * Component name + file path stay `PuntoMedioSection` so the existing
 * routing/import graph doesn't churn — only the strings users see
 * change. The route slug, however, IS `/admin/curaduria` (with a
 * legacy alias from /admin/punto-medio).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  Sparkles,
  CheckCircle2,
  Archive,
  Eye,
  MessageSquare,
  PenLine,
  ScrollText,
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

type TabId = 'drafts' | 'trends' | 'live';

interface RowItem extends PendingItem {
  item_type: 'consolidation' | 'pattern';
}

export function PuntoMedioSection(): React.ReactElement {
  const [tab, setTab] = useState<TabId>('drafts');
  const [bundle, setBundle] = useState<PendingBundle | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
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

  useEffect(() => {
    void reload();
  }, []);

  const items: RowItem[] = useMemo(() => {
    if (!bundle) return [];
    if (tab === 'drafts')
      return bundle.pending_consolidations.map((x) => ({ ...x, item_type: 'consolidation' as const }));
    if (tab === 'trends')
      return bundle.pending_patterns.map((x) => ({ ...x, item_type: 'pattern' as const }));
    return [];
  }, [bundle, tab]);

  const handleAction = async (item: RowItem, action: 'approve' | 'reject') => {
    if (action === 'reject') {
      const ok = await confirm({
        title: 'Archivar este lineamiento',
        description:
          'No se publicará y no afectará las respuestas del agente. Queda en el historial pero inactivo.',
        confirmLabel: 'Archivar',
      });
      if (!ok) return;
    }
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
      notify({
        kind: 'success',
        text: action === 'approve' ? 'Lineamiento publicado' : 'Lineamiento archivado',
      });
    } catch (err) {
      setError(`No se pudo ${action === 'approve' ? 'publicar' : 'archivar'}: ${(err as Error).message}`);
      notify({
        kind: 'error',
        text: action === 'approve' ? 'No se pudo publicar' : 'No se pudo archivar',
        detail: (err as Error).message,
      });
    } finally {
      setBusy((s) => {
        const out = new Set(s);
        out.delete(item.id);
        return out;
      });
    }
  };

  const handleGenerateDrafts = async () => {
    const ok = await confirm({
      title: 'Generar nuevos borradores',
      description:
        'Escribe borradores editoriales nuevos a partir del trabajo reciente del equipo. Toma 1-3 minutos.',
      confirmLabel: 'Generar',
    });
    if (!ok) return;
    setGenerating(true);
    try {
      await forceConsolidate();
      notify({ kind: 'success', text: 'Borradores en redacción. Recargá en unos minutos.' });
      void reload();
    } catch (err) {
      notify({ kind: 'error', text: 'No se pudo generar', detail: (err as Error).message });
    } finally {
      setGenerating(false);
    }
  };

  const draftsCount = bundle?.pending_consolidations_count ?? 0;
  const trendsCount = bundle?.pending_patterns_count ?? 0;

  return (
    <>
      <SectionHeader
        eyebrow="Operación · Lineamientos editoriales del agente"
        actions={
          <>
            <ActionButton variant="ghost" icon={RefreshCw} onClick={() => void reload()}>
              Recargar
            </ActionButton>
            <ActionButton
              variant="coral"
              icon={PenLine}
              onClick={() => void handleGenerateDrafts()}
              disabled={generating}
            >
              {generating ? 'Redactando…' : 'Generar borradores'}
            </ActionButton>
          </>
        }
      />

      <div className="mb-4 flex items-center gap-3">
        <Tabs<TabId>
          options={[
            { id: 'drafts', label: <>Borradores <span className="ml-1 opacity-60">{draftsCount}</span></> },
            { id: 'trends', label: <>Tendencias <span className="ml-1 opacity-60">{trendsCount}</span></> },
            { id: 'live',   label: <>Vigentes <span className="ml-1 opacity-60">—</span></> },
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

      {bundle?.degraded && (
        <Card className="mb-3 border-amber-500/40 bg-amber-500/[0.06] dark:bg-amber-500/[0.10]">
          <div className="flex items-start gap-3 px-[18px] py-3">
            <ScrollText size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
            <div className="flex-1 text-[12.5px] text-amber-800 dark:text-amber-200">
              <strong className="font-semibold">Cola temporalmente no disponible.</strong>{' '}
              Cerebro está procesando la consolidación nocturna. Tus aprobaciones
              previas están vivas (status persistido). Refrescá en un minuto.
            </div>
            <ActionButton variant="ghost" onClick={() => void reload()}>
              Reintentar
            </ActionButton>
          </div>
        </Card>
      )}

      {!bundle ? (
        <SkeletonRows />
      ) : tab === 'live' ? (
        <EmptyState
          icon={ScrollText}
          title="Vigentes — vista pendiente"
          description="Acá vas a ver los lineamientos publicados, agrupados por agente, con la opción de retirarlos. Llega en una iteración próxima."
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title={tab === 'drafts' ? 'Sin borradores pendientes' : 'Sin tendencias pendientes'}
          description={
            tab === 'drafts'
              ? 'Cuando haya nuevos borradores listos para revisión aparecerán acá.'
              : 'Las tendencias editoriales se redactan automáticamente cada noche y aparecen acá para que las publiques o archives.'
          }
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
  const isTrend = item.item_type === 'pattern';
  const text = item.consolidated_text || item.pattern_text || item.executive_brief || '(sin texto)';
  const Icon = isTrend ? Sparkles : PenLine;
  const accent = isTrend ? '#F43F5E' : '#7A3B47';
  const bg = isTrend ? 'rgba(244,63,94,0.08)' : 'rgba(122,59,71,0.08)';

  // Agent attribution remains useful operationally — which agent does
  // this guideline target. We keep it but neutralized: no mention of
  // "user conversations" anywhere.
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
            <Pill kind={isTrend ? 'centinela' : 'lexa'}>{isTrend ? 'Tendencia' : 'Borrador'}</Pill>
            <AgentPill id={agentForCategory as 'lexa' | 'atlas' | 'centinela'} />
            <span className="font-mono text-[11px] text-[#0e1745]/50 dark:text-white/50">
              relevancia {item.confidence_score?.toFixed(2) ?? '—'}
            </span>
          </div>
          <div className="mb-1 font-display text-[17px] font-medium tracking-tight leading-snug text-[#0e1745] dark:text-white">
            {item.category ?? 'Lineamiento sin título'}
          </div>
          <div className="text-[13px] leading-relaxed text-[#0e1745]/70 dark:text-white/70 whitespace-pre-wrap">
            {text}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <ActionButton variant="quiet" icon={Eye}>
              Vista previa
            </ActionButton>
            <ActionButton variant="quiet" icon={MessageSquare}>
              Comparar versiones
            </ActionButton>
          </div>
          {item.last_consolidated_at && (
            <div className="mt-2 text-[10.5px] text-[#0e1745]/45 dark:text-white/45">
              Última edición: {new Date(item.last_consolidated_at).toLocaleString('es-CR')}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5 self-center">
          <ActionButton variant="approve" icon={CheckCircle2} onClick={onApprove} disabled={busy}>
            Publicar
          </ActionButton>
          <ActionButton variant="reject" icon={Archive} onClick={onReject} disabled={busy}>
            Archivar
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
