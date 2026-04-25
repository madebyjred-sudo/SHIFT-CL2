/**
 * Admin Punto Medio — manual review gate for the institutional flywheel.
 *
 * Without this page, every consolidated insight Cerebro generates would
 * flow straight into Lexa/Atlas system prompts. Operator (Juanma)
 * reviews each pending consolidation/pattern and explicitly approves or
 * rejects before it can affect responses.
 *
 * Auth: any logged-in user can access today (small closed team during
 * the demo). Tighten when we open to outside tenants.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, RefreshCw, AlertTriangle, Lock } from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { fetchPending, reviewPendingItem, type PendingItem, type PendingBundle } from '@/services/puntoMedioApi';

type ItemType = 'consolidation' | 'pattern';

interface Row extends PendingItem {
  item_type: ItemType;
}

export function AdminPuntoMedioPage() {
  const [bundle, setBundle] = useState<PendingBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<number>>(new Set());
  const [tab, setTab] = useState<ItemType>('consolidation');

  const load = async () => {
    setError(null);
    try {
      const b = await fetchPending();
      setBundle(b);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleAction = async (item: Row, action: 'approve' | 'reject') => {
    setBusy((s) => new Set(s).add(item.id));
    try {
      await reviewPendingItem({ id: item.id, action, item_type: item.item_type });
      // Optimistically remove from the local list.
      setBundle((b) => {
        if (!b) return b;
        const dropFrom = (arr: PendingItem[]) => arr.filter((x) => x.id !== item.id);
        return {
          ...b,
          pending_consolidations: item.item_type === 'consolidation' ? dropFrom(b.pending_consolidations) : b.pending_consolidations,
          pending_patterns:       item.item_type === 'pattern'       ? dropFrom(b.pending_patterns)       : b.pending_patterns,
          pending_consolidations_count: item.item_type === 'consolidation' ? b.pending_consolidations_count - 1 : b.pending_consolidations_count,
          pending_patterns_count:       item.item_type === 'pattern'       ? b.pending_patterns_count - 1       : b.pending_patterns_count,
        };
      });
    } catch (err) {
      setError(`No se pudo ${action === 'approve' ? 'aprobar' : 'rechazar'}: ${(err as Error).message}`);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  };

  const items: Row[] =
    tab === 'consolidation'
      ? (bundle?.pending_consolidations ?? []).map((x) => ({ ...x, item_type: 'consolidation' as const }))
      : (bundle?.pending_patterns ?? []).map((x) => ({ ...x, item_type: 'pattern' as const }));

  const totalPending = (bundle?.pending_consolidations_count ?? 0) + (bundle?.pending_patterns_count ?? 0);

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      <TopDock />

      <main className="relative z-20 flex-1 min-h-0 max-w-[1200px] w-full mx-auto px-4 sm:px-6 md:px-8 py-6 overflow-y-auto">
        <header className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Lock size={14} className="text-cl2-accent" />
              <span className="text-[10px] uppercase tracking-widest text-[#0e1745]/50 dark:text-white/50">
                Admin · Punto Medio
              </span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-[#0e1745] dark:text-white">
              Cola de revisión
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-2xl">
              Cada insight que Cerebro consolida queda <em>pendiente</em> hasta que vos lo apruebes.
              Solo los aprobados se inyectan al system prompt de Lexa/Atlas en futuras conversaciones.
              Esto cierra el flywheel sin riesgo de propagar patrones que aún no validaste.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#0e1745]/[0.08] dark:border-white/10 text-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            title="Recargar"
          >
            <RefreshCw size={14} />
            <span className="hidden sm:inline">Recargar</span>
          </button>
        </header>

        {error && (
          <div className="rounded-xl border border-red-300/50 bg-red-50/60 dark:bg-red-500/10 dark:border-red-500/20 px-4 py-3 text-sm text-red-700 dark:text-red-300 mb-4 flex items-start gap-2">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Error en Cerebro / Punto Medio</p>
              <p className="text-xs mt-0.5 opacity-80">{error}</p>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex items-center gap-1 mb-4 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          <TabBtn
            active={tab === 'consolidation'}
            onClick={() => setTab('consolidation')}
            label="Consolidaciones"
            count={bundle?.pending_consolidations_count}
          />
          <TabBtn
            active={tab === 'pattern'}
            onClick={() => setTab('pattern')}
            label="Patrones"
            count={bundle?.pending_patterns_count}
          />
        </div>

        {!bundle ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-28 rounded-xl bg-white/40 dark:bg-white/[0.03] animate-pulse" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState totalPending={totalPending} />
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                busy={busy.has(item.id)}
                onApprove={() => void handleAction(item, 'approve')}
                onReject={() => void handleAction(item, 'reject')}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function TabBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={
        'inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ' +
        (active
          ? 'text-cl2-accent border-cl2-accent'
          : 'text-gray-500 dark:text-gray-400 border-transparent hover:text-[#0e1745] dark:hover:text-white')
      }
    >
      {label}
      {typeof count === 'number' && (
        <span className={
          'inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-semibold ' +
          (active ? 'bg-cl2-accent/15 text-cl2-accent' : 'bg-[#0e1745]/[0.06] dark:bg-white/[0.08] text-[#0e1745]/55 dark:text-white/55')
        }>
          {count}
        </span>
      )}
    </button>
  );
}

function EmptyState({ totalPending }: { totalPending: number }) {
  return (
    <div className="text-center py-16 text-gray-500 dark:text-gray-400">
      <CheckCircle2 size={32} className="mx-auto mb-3 text-emerald-500/60" />
      <p className="text-sm">No hay items pendientes en esta categoría.</p>
      <p className="text-xs mt-1 text-gray-400">
        {totalPending > 0
          ? `Hay ${totalPending} pendientes en otras categorías.`
          : 'Cuando Cerebro genere consolidaciones nuevas, aparecerán acá.'}
      </p>
    </div>
  );
}

function ItemCard({
  item, busy, onApprove, onReject,
}: { item: Row; busy: boolean; onApprove: () => void; onReject: () => void }) {
  const text = item.consolidated_text || item.pattern_text || item.executive_brief || '(sin texto)';
  const meta: Array<[string, string | number | undefined]> = [
    ['cat',     item.category],
    ['vertical', item.industry_vertical ?? undefined],
    ['conf',    item.confidence_score?.toFixed?.(2) ?? item.confidence_score],
    ['fuentes', item.source_insight_count],
    ['tenants', item.contributing_tenants],
    ['scope',   item.scope],
    ['tipo',    item.pattern_type],
    ['region',  item.region],
  ];

  return (
    <li className="rounded-xl border border-[#0e1745]/[0.08] dark:border-white/[0.08] bg-white dark:bg-white/[0.025] p-4 sm:p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-widest text-cl2-accent font-semibold">
            #{item.id}
          </span>
          {meta.filter(([, v]) => v != null && String(v).length > 0).map(([k, v]) => (
            <span
              key={k}
              className="px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-[#0e1745]/[0.04] dark:bg-white/[0.06] text-[#0e1745]/70 dark:text-white/70"
            >
              {k}: <strong className="font-semibold">{String(v)}</strong>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onApprove}
            disabled={busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-600 text-white text-xs font-medium disabled:opacity-50 transition-colors"
          >
            <CheckCircle2 size={14} />
            Aprobar
          </button>
          <button
            onClick={onReject}
            disabled={busy}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-300/50 dark:border-red-500/30 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/10 text-xs font-medium disabled:opacity-50 transition-colors"
          >
            <XCircle size={14} />
            Rechazar
          </button>
        </div>
      </div>
      <p className="text-[13.5px] leading-relaxed text-[#0e1745]/85 dark:text-white/85 whitespace-pre-wrap">
        {text}
      </p>
      {item.last_consolidated_at && (
        <p className="text-[10.5px] text-[#0e1745]/40 dark:text-white/40 mt-3">
          Última consolidación: {new Date(item.last_consolidated_at).toLocaleString('es-CR')}
        </p>
      )}
    </li>
  );
}
