/**
 * Feedback section — bandeja de bugs / preguntas / ideas para el admin.
 *
 * Layout: list a la izquierda, detalle expandido a la derecha cuando
 * un item está seleccionado. Click en row → fetch detalle (con signed
 * URL del screenshot si lo tiene). Acciones: cambiar status,
 * cambiar severidad, agregar admin_notes.
 *
 * Default view: items "abierto" + "en_revision". Filters arriba permiten
 * ver resueltos / descartados / todos.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Bug, Lightbulb, HelpCircle, MessageSquareWarning, Loader2,
  X, ExternalLink, Image as ImageIcon, Save, AlertCircle, Check,
} from 'lucide-react';
import { SectionHeader, KPI, Pill, type PillKind } from '../primitives';
import {
  adminListFeedback,
  adminGetFeedback,
  adminUpdateFeedback,
  type FeedbackAdminItem,
  type FeedbackAdminDetail,
  type FeedbackStatus,
  type FeedbackKind,
  type FeedbackSeverity,
} from '@/services/feedbackApi';

const KIND_META: Record<FeedbackKind, { label: string; icon: typeof Bug; pill: PillKind }> = {
  bug:      { label: 'Bug',      icon: Bug,                   pill: 'warn' },
  pregunta: { label: 'Pregunta', icon: HelpCircle,            pill: 'info' },
  idea:     { label: 'Idea',     icon: Lightbulb,             pill: 'success' },
  otro:     { label: 'Otro',     icon: MessageSquareWarning,  pill: 'neutral' },
};

const STATUS_META: Record<FeedbackStatus, { label: string; pill: PillKind }> = {
  abierto:     { label: 'Abierto',     pill: 'warn' },
  en_revision: { label: 'En revisión', pill: 'info' },
  resuelto:    { label: 'Resuelto',    pill: 'success' },
  descartado:  { label: 'Descartado',  pill: 'neutral' },
};

const SEVERITY_META: Record<FeedbackSeverity, { label: string; pill: PillKind }> = {
  baja:    { label: 'Baja',     pill: 'success' },
  media:   { label: 'Media',    pill: 'info' },
  alta:    { label: 'Alta',     pill: 'warn' },
  critica: { label: 'Crítica',  pill: 'danger' },
};

function relativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'recién';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h`;
    const days = Math.floor(h / 24);
    if (days < 30) return `${days} d`;
    return d.toISOString().slice(0, 10);
  } catch { return iso; }
}

export function FeedbackSection() {
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | 'all' | 'inbox'>('inbox');
  const [kindFilter, setKindFilter] = useState<FeedbackKind | 'all'>('all');
  const [items, setItems] = useState<FeedbackAdminItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackAdminDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const items = await adminListFeedback({
        status: statusFilter === 'inbox' ? undefined : statusFilter,
        kind: kindFilter === 'all' ? undefined : kindFilter,
        limit: 100,
      });
      setItems(items);
    } catch (err) {
      setError((err as Error).message);
      setItems([]);
    }
  }, [statusFilter, kindFilter]);

  useEffect(() => { void refresh(); }, [refresh]);

  // KPI counters — abiertos + críticos + última 24h
  const kpis = useMemo(() => {
    if (!items) return { open: 0, critical: 0, last24h: 0 };
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    return {
      open: items.filter((i) => i.status === 'abierto' || i.status === 'en_revision').length,
      critical: items.filter((i) => i.severity === 'critica' && i.status !== 'resuelto' && i.status !== 'descartado').length,
      last24h: items.filter((i) => new Date(i.created_at).getTime() > yesterday).length,
    };
  }, [items]);

  const openDetail = useCallback(async (id: string) => {
    setSelected(id);
    setDetailLoading(true);
    try {
      const d = await adminGetFeedback(id);
      setDetail(d);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  return (
    <div className="px-5 py-5 md:px-7 md:py-6 space-y-5">
      <SectionHeader eyebrow="Feedback · Bugs" />
      <p className="text-[12.5px] text-[#0e1745]/55 dark:text-white/50 -mt-2">
        Bandeja de reportes enviados desde el botón flotante del SPA.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KPI label="Abiertos / en revisión" value={kpis.open.toString()} />
        <KPI label="Críticos sin resolver" value={kpis.critical.toString()} delta={kpis.critical > 0 ? 'requieren atención' : 'sin críticos'} deltaDir={kpis.critical > 0 ? 'down' : 'flat'} />
        <KPI label="Recibidos últimas 24h" value={kpis.last24h.toString()} />
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-[#0e1745]/50 dark:text-white/50 mr-1">Status</span>
        {(['inbox', 'abierto', 'en_revision', 'resuelto', 'descartado', 'all'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors ${
              statusFilter === s
                ? 'bg-cl2-burgundy text-white'
                : 'bg-black/3 dark:bg-white/5 text-[#0e1745]/70 dark:text-white/65 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            {s === 'inbox' ? 'Bandeja' : s === 'all' ? 'Todos' : STATUS_META[s].label}
          </button>
        ))}
        <span className="text-[11px] uppercase tracking-wider text-[#0e1745]/50 dark:text-white/50 ml-3 mr-1">Tipo</span>
        {(['all', 'bug', 'pregunta', 'idea', 'otro'] as const).map((k) => (
          <button
            key={k}
            onClick={() => setKindFilter(k)}
            className={`px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors ${
              kindFilter === k
                ? 'bg-cl2-burgundy text-white'
                : 'bg-black/3 dark:bg-white/5 text-[#0e1745]/70 dark:text-white/65 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            {k === 'all' ? 'Todos' : KIND_META[k].label}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-cl2-burgundy/8 border border-cl2-burgundy/20 text-[12px] text-cl2-burgundy/90">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {/* Layout: lista + detalle */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-5 min-h-[400px]">
        {/* Lista */}
        <div className="space-y-1.5">
          {items === null ? (
            <div className="flex items-center gap-2 text-[12px] text-[#0e1745]/50 dark:text-white/45 py-6 justify-center">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Cargando bandeja…
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-10 text-[12px] text-[#0e1745]/45 dark:text-white/40 italic">
              Sin reportes para mostrar con estos filtros.
            </div>
          ) : (
            items.map((it) => {
              const Icon = KIND_META[it.kind].icon;
              const isSel = selected === it.id;
              return (
                <button
                  key={it.id}
                  onClick={() => openDetail(it.id)}
                  className={`w-full text-left p-3 rounded-lg border transition-colors ${
                    isSel
                      ? 'border-cl2-burgundy bg-cl2-burgundy/5'
                      : 'border-black/8 dark:border-white/10 hover:bg-black/3 dark:hover:bg-white/5'
                  }`}
                >
                  <div className="flex items-start gap-2.5">
                    <div className={`w-7 h-7 rounded-md bg-cl2-burgundy/10 text-cl2-burgundy flex items-center justify-center flex-shrink-0`}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5 flex-wrap">
                        <span className="text-[13px] font-medium text-[#0e1745] dark:text-white truncate">{it.title}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 text-[10.5px] text-[#0e1745]/55 dark:text-white/50">
                        <span>{it.user_email ?? it.user_id.slice(0, 8)}</span>
                        <span>·</span>
                        <span>{relativeTime(it.created_at)}</span>
                        {it.context_url && (
                          <>
                            <span>·</span>
                            <span className="font-mono truncate max-w-[180px]">{it.context_url}</span>
                          </>
                        )}
                        {it.has_screenshot && (
                          <>
                            <span>·</span>
                            <ImageIcon className="w-3 h-3" />
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <Pill kind={STATUS_META[it.status].pill}>{STATUS_META[it.status].label}</Pill>
                      {it.kind === 'bug' && (
                        <Pill kind={SEVERITY_META[it.severity].pill}>{SEVERITY_META[it.severity].label}</Pill>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Detalle */}
        <aside className="border border-black/8 dark:border-white/10 rounded-xl bg-white dark:bg-white/[0.02] overflow-hidden">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-[12px] text-[#0e1745]/40 dark:text-white/35 italic p-6 text-center">
              Seleccioná un reporte para ver el detalle, el screenshot y cambiar status.
            </div>
          ) : detailLoading || !detail ? (
            <div className="h-full flex items-center justify-center text-[12px] text-[#0e1745]/45 dark:text-white/40">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
          ) : (
            <DetailPane
              detail={detail}
              onUpdated={async (next) => {
                setDetail(next);
                await refresh();
              }}
              onClose={() => { setSelected(null); setDetail(null); }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

function DetailPane({
  detail, onUpdated, onClose,
}: {
  detail: FeedbackAdminDetail;
  onUpdated: (next: FeedbackAdminDetail) => void;
  onClose: () => void;
}) {
  const [adminNotes, setAdminNotes] = useState(detail.admin_notes ?? '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingStatus, setSavingStatus] = useState<FeedbackStatus | null>(null);

  useEffect(() => { setAdminNotes(detail.admin_notes ?? ''); }, [detail.id, detail.admin_notes]);

  const changeStatus = async (status: FeedbackStatus) => {
    setSavingStatus(status);
    try {
      const next = await adminUpdateFeedback(detail.id, { status });
      onUpdated(next);
    } finally {
      setSavingStatus(null);
    }
  };

  const saveNotes = async () => {
    if (adminNotes === (detail.admin_notes ?? '')) return;
    setSavingNotes(true);
    try {
      const next = await adminUpdateFeedback(detail.id, { admin_notes: adminNotes });
      onUpdated(next);
    } finally {
      setSavingNotes(false);
    }
  };

  const KindIcon = KIND_META[detail.kind].icon;
  const dirtyNotes = adminNotes !== (detail.admin_notes ?? '');

  return (
    <div className="flex flex-col h-full max-h-[700px]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/10 bg-black/3 dark:bg-white/[0.02]">
        <div className="flex items-center gap-2 min-w-0">
          <KindIcon className="w-3.5 h-3.5 text-cl2-burgundy flex-shrink-0" />
          <span className="text-[12px] font-medium text-[#0e1745] dark:text-white">
            {KIND_META[detail.kind].label}
          </span>
          <Pill kind={STATUS_META[detail.status].pill}>{STATUS_META[detail.status].label}</Pill>
        </div>
        <button onClick={onClose} className="text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <h3 className="font-display text-[16px] leading-snug text-[#0e1745] dark:text-white">
          {detail.title}
        </h3>

        <div className="text-[10.5px] text-[#0e1745]/55 dark:text-white/50 space-y-0.5">
          <div>{detail.user_email ?? detail.user_id}</div>
          <div>{new Date(detail.created_at).toLocaleString('es-CR')}</div>
          {detail.context_url && (
            <div className="flex items-center gap-1">
              <span>en</span>
              <code className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 font-mono text-[10px]">{detail.context_url}</code>
              <a
                href={detail.context_url}
                target="_blank"
                rel="noreferrer"
                className="text-cl2-burgundy hover:underline"
                title="Abrir en pestaña nueva"
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          )}
        </div>

        {detail.description && (
          <div className="text-[12.5px] text-[#0e1745]/80 dark:text-white/75 leading-relaxed whitespace-pre-wrap">
            {detail.description}
          </div>
        )}

        {detail.screenshot_url && (
          <div>
            <p className="text-[10.5px] uppercase tracking-wider text-cl2-burgundy/80 mb-1.5">Screenshot</p>
            <a href={detail.screenshot_url} target="_blank" rel="noreferrer" className="block">
              <img
                src={detail.screenshot_url}
                alt="screenshot del reporte"
                className="w-full rounded-lg border border-black/10 dark:border-white/10 hover:opacity-90 transition-opacity"
              />
            </a>
          </div>
        )}

        {detail.context_meta && Object.keys(detail.context_meta).length > 0 && (
          <details className="text-[11px]">
            <summary className="cursor-pointer text-[#0e1745]/55 dark:text-white/50 hover:text-[#0e1745] dark:hover:text-white">
              Contexto técnico
            </summary>
            <pre className="mt-1.5 p-2 rounded bg-black/3 dark:bg-white/5 font-mono text-[10.5px] overflow-x-auto">
{JSON.stringify(detail.context_meta, null, 2)}
            </pre>
          </details>
        )}

        {/* Admin notes */}
        <div>
          <label className="block text-[10.5px] uppercase tracking-wider text-cl2-burgundy/80 mb-1.5">
            Notas privadas del operador
          </label>
          <textarea
            value={adminNotes}
            onChange={(e) => setAdminNotes(e.target.value)}
            rows={3}
            placeholder="Comentarios internos, hipótesis de causa, link al PR…"
            className="w-full px-2.5 py-1.5 rounded-md bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[12px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-cl2-burgundy/40 resize-none"
          />
          {dirtyNotes && (
            <button
              onClick={saveNotes}
              disabled={savingNotes}
              className="mt-1.5 flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90 disabled:opacity-40"
            >
              {savingNotes ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
              Guardar notas
            </button>
          )}
        </div>
      </div>

      {/* Action footer */}
      <div className="border-t border-black/5 dark:border-white/10 p-3 bg-black/3 dark:bg-white/[0.02]">
        <p className="text-[10.5px] uppercase tracking-wider text-cl2-burgundy/80 mb-2">Cambiar status</p>
        <div className="grid grid-cols-4 gap-1.5">
          {(['abierto', 'en_revision', 'resuelto', 'descartado'] as FeedbackStatus[]).map((s) => {
            const active = detail.status === s;
            const saving = savingStatus === s;
            return (
              <button
                key={s}
                onClick={() => !active && changeStatus(s)}
                disabled={active || saving}
                className={`px-2 py-1.5 rounded text-[10.5px] font-medium transition-colors ${
                  active
                    ? 'bg-cl2-burgundy text-white'
                    : 'bg-black/5 dark:bg-white/5 text-[#0e1745]/70 dark:text-white/65 hover:bg-black/8 dark:hover:bg-white/10'
                }`}
              >
                {saving ? <Loader2 className="w-3 h-3 mx-auto animate-spin" /> : active ? <Check className="w-3 h-3 mx-auto" /> : STATUS_META[s].label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
