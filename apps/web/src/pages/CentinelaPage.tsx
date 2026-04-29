/**
 * CentinelaPage — /centinela
 *
 * The watchdog surface. Three sections in one scrollable page:
 *   1. HERO with dynamic title + resumen (alerts unread, watchlist size,
 *      severity breakdown, digest enable status)
 *   2. ALERTS FEED — paginated, filterable by type/severity/unread
 *   3. WATCHLIST + PREFS sidebar
 *
 * Visual layout mirrors WorkspacesListPage: TopDock + hero strip + body grid.
 *
 * Empty-state UX: when the user has no watchlist yet, the hero copy and a
 * prominent CTA push them toward "Agregar tu primer expediente" — that's
 * what makes Centinela start producing output.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Eye, AlertTriangle, AlertCircle, Bell, BellOff, Plus, X, Filter,
  Trash2, Sparkles, Mail, Slack, MessageSquareMore, Loader2, Check,
  CheckCheck, Inbox, Clock,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { cn } from '@/lib/utils';
import {
  getSummary, getFeed, getWatchlist, getPrefs,
  markRead, markAllRead, addToWatchlist, removeFromWatchlist, updatePrefs,
  alertTypeLabel, severityLabel,
  type AlertType, type AlertSeverity, type CentinelaAlert,
  type WatchlistItem, type Prefs, type Summary,
} from '@/services/centinelaApi';
import { AutocompleteInput } from '@/components/centinela/AutocompleteInput';
import { suggestWatchlist, getProfile, type WatchlistSuggestion } from '@/services/onboardingApi';

// ─── Relative time helper ───────────────────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `hace ${days}d`;
  return new Date(iso).toLocaleDateString('es-CR', { day: 'numeric', month: 'short' });
}

// ─── Severity badge ─────────────────────────────────────────────────────────
function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  const styles: Record<AlertSeverity, string> = {
    info:     'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300',
    warning:  'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300',
    critical: 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300',
  };
  const Icon = severity === 'critical' ? AlertCircle : severity === 'warning' ? AlertTriangle : Bell;
  return (
    <span className={cn(
      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium',
      styles[severity],
    )}>
      <Icon className="w-2.5 h-2.5" />
      {severityLabel(severity)}
    </span>
  );
}

// ─── Alert row ──────────────────────────────────────────────────────────────
function AlertRow({
  alert, onMarkRead,
}: { alert: CentinelaAlert; onMarkRead: (id: string) => void }) {
  const isUnread = !alert.read_at;
  const payload = alert.payload as Record<string, string | undefined>;

  // Per-type body composer — every alert kind has its own "what changed"
  // copy because the payload shape varies. Falls back to a JSON dump in dev.
  let body: React.ReactNode;
  if (alert.alert_type === 'state_change') {
    body = (
      <>
        <span className="text-[#0e1745]/55 dark:text-white/55 line-through">{payload.estado_anterior ?? '?'}</span>
        {' → '}
        <span className="font-medium">{payload.estado_actual ?? '?'}</span>
      </>
    );
  } else if (alert.alert_type === 'deadline') {
    const dias = (alert.payload as { dias_restantes?: number }).dias_restantes;
    body = dias != null
      ? <>Vence en <span className="font-medium">{dias} día{dias === 1 ? '' : 's'}</span> · {payload.tipo_plazo}</>
      : <>{payload.tipo_plazo}</>;
  } else if (alert.alert_type === 'mention') {
    body = (
      <>
        Mencionado en <span className="font-medium">{payload.session_title ?? 'sesión'}</span>
        {payload.snippet && <span className="text-[#0e1745]/55 dark:text-white/55"> · "{payload.snippet}"</span>}
      </>
    );
  } else if (alert.alert_type === 'agenda') {
    body = (
      <>
        En agenda del <span className="font-medium">{payload.fecha}</span>
        {payload.comision && <> · {payload.comision}</>}
      </>
    );
  } else if (alert.alert_type === 'similar') {
    body = (
      <>
        Similar al expediente <span className="font-medium">{payload.match_with ?? alert.entity_id}</span>
        {payload.score && <span className="text-[#0e1745]/55 dark:text-white/55"> · score {payload.score}</span>}
      </>
    );
  } else if (alert.alert_type === 'digest_weekly') {
    body = <span className="font-medium">Digest semanal listo</span>;
  } else {
    body = <code className="text-[10px] text-[#0e1745]/45 dark:text-white/45">{JSON.stringify(payload).slice(0, 80)}</code>;
  }

  return (
    <div
      className={cn(
        'group relative px-4 py-3 rounded-xl border transition-colors',
        isUnread
          ? 'bg-cl2-burgundy/5 border-cl2-burgundy/15 hover:bg-cl2-burgundy/10'
          : 'bg-white dark:bg-white/[0.03] border-black/8 dark:border-white/8 hover:bg-black/2 dark:hover:bg-white/5',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {isUnread && <span className="w-1.5 h-1.5 rounded-full bg-cl2-burgundy" aria-label="No leída" />}
            <span className="text-[11px] font-medium uppercase tracking-wider text-cl2-burgundy">
              {alertTypeLabel(alert.alert_type)}
            </span>
            <SeverityBadge severity={alert.severity} />
            <span className="text-[10px] text-[#0e1745]/45 dark:text-white/45 ml-auto flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {relativeTime(alert.created_at)}
            </span>
          </div>
          <div className="mt-1.5 text-[14px] text-[#0e1745] dark:text-white/90 font-medium">
            {alert.entity_type === 'expediente' ? `Expediente ${alert.entity_id}` : alert.entity_id}
          </div>
          <div className="mt-0.5 text-[12px] text-[#0e1745]/65 dark:text-white/60 leading-relaxed">
            {body}
          </div>
        </div>
        {isUnread && (
          <button
            onClick={() => onMarkRead(alert.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-black/8 dark:hover:bg-white/10 text-[#0e1745]/50 dark:text-white/50"
            title="Marcar como leída"
          >
            <CheckCheck className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Watchlist sidebar ──────────────────────────────────────────────────────
//
// Three modes layered on top of each other (mutually exclusive):
//   1. Closed             — just the [+ Agregar] / [✨ Sugerir] CTAs.
//   2. Adding (manual)    — type tabs + AutocompleteInput. Number in head?
//                            it autocompletes from the SIL by titulo or numero.
//                            Apellido in head? it suggests proponentes ranked
//                            by occurrence. Free-text fallback for temas.
//   3. Suggesting (auto)  — Centinela reads the user's profile and proposes
//                            5 watchlist items. One-click [Vigilar].
//
// We share the same component the onboarding wizard uses for consistency —
// a regular user who skipped onboarding can still hit the magic-help here.
function WatchlistSidebar({
  items, onAdd, onRemove,
}: {
  items: WatchlistItem[];
  onAdd: (entity_type: 'expediente' | 'diputado' | 'tema', entity_id: string, label?: string) => Promise<void>;
  onRemove: (id: string) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'adding' | 'suggesting'>('idle');
  const [draftType, setDraftType] = useState<'expediente' | 'diputado' | 'tema'>('expediente');
  const [draftValue, setDraftValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Suggesting state
  const [suggestions, setSuggestions] = useState<WatchlistSuggestion[]>([]);
  const [sLoading, setSLoading] = useState(false);
  const [sError, setSError] = useState<string | null>(null);
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  const handlePick = async (picked: { entity_id: string; label: string }) => {
    setSubmitting(true);
    try {
      await onAdd(draftType, picked.entity_id, picked.label);
      setDraftValue('');
      setMode('idle');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[Watchlist] add failed:', (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const startSuggesting = async () => {
    setMode('suggesting');
    setSLoading(true);
    setSError(null);
    setAddedIds(new Set());
    try {
      // Read the user's profile so Centinela can ground its suggestions on
      // the cargo + enfoque the user filled at onboarding (or skipped).
      const profile = await getProfile().catch(() => null);
      const result = await suggestWatchlist({
        cargo: profile?.cargo ?? undefined,
        enfoque: profile?.enfoque ?? undefined,
        temas: profile?.temas ?? [],
      });
      setSuggestions(result);
    } catch (err) {
      setSError((err as Error).message);
    } finally {
      setSLoading(false);
    }
  };

  const acceptSuggestion = async (s: WatchlistSuggestion) => {
    try {
      await onAdd(s.entity_type, s.entity_id, s.label);
      setAddedIds((cur) => new Set([...cur, s.entity_id]));
    } catch { /* swallow */ }
  };

  return (
    <aside className="rounded-2xl border border-black/8 dark:border-white/10 bg-white dark:bg-white/[0.04] p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-display text-[16px] font-semibold text-[#0e1745] dark:text-white">Tu watchlist</h3>
        <span className="text-[11px] text-[#0e1745]/50 dark:text-white/45">{items.length}</span>
      </div>

      {mode === 'idle' && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => setMode('adding')}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-cl2-burgundy/10 hover:bg-cl2-burgundy/15 text-cl2-burgundy text-[12px] font-medium transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Agregar
          </button>
          <button
            onClick={() => void startSuggesting()}
            className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-black/4 dark:bg-white/[0.06] hover:bg-black/8 dark:hover:bg-white/[0.10] text-[#0e1745]/75 dark:text-white/75 text-[12px] font-medium transition-colors"
            title="Centinela lee tu perfil y propone qué vigilar"
          >
            <Sparkles className="w-3.5 h-3.5 text-cl2-burgundy" />
            Sugerir
          </button>
        </div>
      )}

      {mode === 'adding' && (
        <div className="mb-3 p-3 rounded-lg bg-black/3 dark:bg-white/5 space-y-2">
          <div className="flex gap-1">
            {(['expediente', 'diputado', 'tema'] as const).map((t) => (
              <button
                key={t}
                onClick={() => { setDraftType(t); setDraftValue(''); }}
                className={cn(
                  'flex-1 px-2 py-1 rounded text-[10px] font-medium uppercase tracking-wide transition-colors',
                  draftType === t
                    ? 'bg-cl2-burgundy text-white'
                    : 'text-[#0e1745]/55 dark:text-white/50 hover:bg-black/5 dark:hover:bg-white/8',
                )}
              >
                {t}
              </button>
            ))}
          </div>
          <AutocompleteInput
            type={draftType}
            value={draftValue}
            onChange={setDraftValue}
            onPick={handlePick}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={() => { setMode('idle'); setDraftValue(''); }}
              className="px-2 py-1 text-[11px] text-[#0e1745]/55 dark:text-white/50 hover:text-[#0e1745] dark:hover:text-white"
            >
              Cancelar
            </button>
            <p className="ml-auto text-[10px] text-[#0e1745]/40 dark:text-white/35 self-center">
              {submitting ? 'Agregando…' : 'Enter para agregar lo escrito'}
            </p>
          </div>
        </div>
      )}

      {mode === 'suggesting' && (
        <div className="mb-3 p-3 rounded-lg bg-black/3 dark:bg-white/5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-cl2-burgundy">
              <Sparkles className="w-3 h-3" />
              Centinela propone
            </div>
            <button
              onClick={() => setMode('idle')}
              className="text-[11px] text-[#0e1745]/55 dark:text-white/50 hover:text-[#0e1745] dark:hover:text-white"
            >
              Cerrar
            </button>
          </div>

          {sLoading ? (
            <div className="flex items-center justify-center gap-2 py-4 text-[11.5px] text-[#0e1745]/50 dark:text-white/45">
              <Loader2 className="w-3 h-3 animate-spin" />
              Leyendo tu perfil…
            </div>
          ) : sError ? (
            <div className="text-[11px] text-red-600 dark:text-red-400 leading-relaxed">
              {sError}. Probá de nuevo o agregá manualmente.
            </div>
          ) : suggestions.length === 0 ? (
            <div className="text-[11px] text-[#0e1745]/50 dark:text-white/45 leading-relaxed">
              No tengo perfil suficiente todavía para sugerir. Volvé al onboarding o agregá manualmente.
            </div>
          ) : (
            <div className="space-y-1.5">
              {suggestions.map((s, i) => {
                const isAdded = addedIds.has(s.entity_id);
                return (
                  <div
                    key={i}
                    className={cn(
                      'p-2 rounded-md border transition-colors',
                      isAdded
                        ? 'bg-cl2-burgundy/8 border-cl2-burgundy/20'
                        : 'bg-white dark:bg-white/[0.04] border-black/8 dark:border-white/10',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-medium text-[#0e1745] dark:text-white">{s.label}</div>
                        <div className="text-[10.5px] text-[#0e1745]/55 dark:text-white/50 mt-0.5 leading-snug">{s.rationale}</div>
                      </div>
                      <button
                        onClick={() => !isAdded && void acceptSuggestion(s)}
                        disabled={isAdded}
                        className={cn(
                          'flex-shrink-0 px-2 py-1 rounded text-[10px] font-medium transition-colors flex items-center gap-1',
                          isAdded
                            ? 'bg-cl2-burgundy/15 text-cl2-burgundy cursor-default'
                            : 'bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90',
                        )}
                      >
                        {isAdded ? <><Check className="w-2.5 h-2.5" /> ok</> : <><Plus className="w-2.5 h-2.5" /> vigilar</>}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <div className="text-center py-8">
          <Eye className="w-6 h-6 mx-auto mb-2 text-[#0e1745]/25 dark:text-white/25" />
          <p className="text-[12px] text-[#0e1745]/50 dark:text-white/45 leading-relaxed">
            Centinela no tiene nada que vigilar todavía. Agregá un expediente, diputado o tema para que arranquen las alertas.
          </p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li
              key={it.id}
              className="group flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg hover:bg-black/3 dark:hover:bg-white/5 transition-colors"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-[#0e1745]/45 dark:text-white/40">
                    {it.entity_type}
                  </span>
                </div>
                <div className="text-[12px] text-[#0e1745] dark:text-white/85 truncate font-medium">
                  {it.label ?? it.entity_id}
                </div>
              </div>
              <button
                onClick={() => onRemove(it.id)}
                className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-[#0e1745]/40 dark:text-white/40 hover:text-red-500"
                title="Quitar"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

// ─── Prefs panel ────────────────────────────────────────────────────────────
function PrefsPanel({
  prefs, onChange,
}: {
  prefs: Prefs;
  onChange: (patch: Partial<Prefs>) => Promise<void>;
}) {
  const channels = prefs.channels ?? {};
  const setChannel = (key: keyof typeof channels, value: boolean) =>
    onChange({ channels: { ...channels, [key]: value } });

  return (
    <aside className="rounded-2xl border border-black/8 dark:border-white/10 bg-white dark:bg-white/[0.04] p-5">
      <h3 className="font-display text-[16px] font-semibold text-[#0e1745] dark:text-white mb-3">Notificaciones</h3>

      <div className="space-y-2">
        {[
          { key: 'in_app', label: 'En la app', icon: <Inbox className="w-3.5 h-3.5" />, ready: true },
          { key: 'email', label: 'Email', icon: <Mail className="w-3.5 h-3.5" />, ready: false },
          { key: 'slack', label: 'Slack', icon: <Slack className="w-3.5 h-3.5" />, ready: false },
          { key: 'whatsapp', label: 'WhatsApp', icon: <MessageSquareMore className="w-3.5 h-3.5" />, ready: false },
        ].map(({ key, label, icon, ready }) => {
          const enabled = channels[key as keyof typeof channels] === true;
          return (
            <button
              key={key}
              onClick={() => ready && setChannel(key as keyof typeof channels, !enabled)}
              disabled={!ready}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] transition-colors',
                ready
                  ? enabled
                    ? 'bg-cl2-burgundy/10 text-cl2-burgundy'
                    : 'hover:bg-black/3 dark:hover:bg-white/5 text-[#0e1745]/65 dark:text-white/60'
                  : 'text-[#0e1745]/30 dark:text-white/25 cursor-not-allowed',
              )}
            >
              <span className={enabled ? 'text-cl2-burgundy' : ''}>{icon}</span>
              <span>{label}</span>
              {!ready && <span className="ml-auto text-[9px] uppercase tracking-wider">pronto</span>}
              {ready && (
                <span className={cn(
                  'ml-auto w-7 h-4 rounded-full transition-colors flex items-center px-0.5',
                  enabled ? 'bg-cl2-burgundy justify-end' : 'bg-black/10 dark:bg-white/15 justify-start',
                )}>
                  <span className="w-3 h-3 rounded-full bg-white" />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-4 pt-4 border-t border-black/6 dark:border-white/8">
        <button
          onClick={() => onChange({ digest_enabled: !prefs.digest_enabled })}
          className={cn(
            'w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors',
            prefs.digest_enabled
              ? 'bg-cl2-burgundy/10 text-cl2-burgundy'
              : 'hover:bg-black/3 dark:hover:bg-white/5 text-[#0e1745]/65 dark:text-white/60',
          )}
        >
          <Sparkles className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-[12px] font-medium">Digest semanal Opus</div>
            <div className="text-[10.5px] mt-0.5 leading-relaxed opacity-80">
              Cada lunes, brief sintetizado de la semana sobre tu watchlist.
            </div>
          </div>
        </button>
      </div>
    </aside>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────
export function CentinelaPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<CentinelaAlert[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [filter, setFilter] = useState<{ type?: AlertType; severity?: AlertSeverity; unread_only: boolean }>({
    unread_only: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [s, f, w, p] = await Promise.all([
        getSummary(),
        getFeed({ limit: 50, ...filter }),
        getWatchlist(),
        getPrefs(),
      ]);
      setSummary(s);
      setAlerts(f.items);
      setWatchlist(w);
      setPrefs(p);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const handleMarkRead = useCallback(async (id: string) => {
    setAlerts((cur) => cur.map((a) => (a.id === id ? { ...a, read_at: new Date().toISOString() } : a)));
    try {
      await markRead(id);
      const s = await getSummary();
      setSummary(s);
    } catch {
      // revert on failure
      void load();
    }
  }, [load]);

  const handleMarkAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setAlerts((cur) => cur.map((a) => ({ ...a, read_at: a.read_at ?? now })));
    try {
      await markAllRead();
      const s = await getSummary();
      setSummary(s);
    } catch {
      void load();
    }
  }, [load]);

  const handleAddWatchlist = useCallback(async (
    entity_type: 'expediente' | 'diputado' | 'tema',
    entity_id: string,
    label?: string,
  ) => {
    const item = await addToWatchlist({ entity_type, entity_id, label });
    setWatchlist((cur) => [item, ...cur.filter((x) => x.id !== item.id)]);
    const s = await getSummary();
    setSummary(s);
  }, []);

  const handleRemoveWatchlist = useCallback(async (id: string) => {
    const prev = watchlist;
    setWatchlist((cur) => cur.filter((x) => x.id !== id));
    try {
      await removeFromWatchlist(id);
      const s = await getSummary();
      setSummary(s);
    } catch {
      setWatchlist(prev);
    }
  }, [watchlist]);

  const handlePrefsChange = useCallback(async (patch: Partial<Prefs>) => {
    if (!prefs) return;
    const optimistic = { ...prefs, ...patch };
    setPrefs(optimistic);
    try {
      const fresh = await updatePrefs(patch);
      setPrefs(fresh);
    } catch {
      setPrefs(prefs);
    }
  }, [prefs]);

  // ── Dynamic hero copy ────────────────────────────────────────────────────
  const heroTitle = useMemo(() => {
    if (!summary) return 'Centinela';
    if (summary.watchlist === 0) return 'Decile a Centinela qué vigilar';
    if (summary.unread === 0) return 'Sin novedades en tu watchlist';
    if (summary.unread === 1) return '1 alerta nueva esperándote';
    return `${summary.unread} alertas nuevas esperándote`;
  }, [summary]);

  const heroSubtitle = useMemo(() => {
    if (!summary) return 'Cargando…';
    if (summary.watchlist === 0) {
      return 'Agregá un expediente, diputado o tema en el panel derecho. Centinela escanea cambios de estado, plazos próximos, menciones en sesión y matches similares — y te avisa solo cuando importa.';
    }
    const parts: string[] = [];
    if (summary.severity.critical > 0) parts.push(`${summary.severity.critical} crítica${summary.severity.critical === 1 ? '' : 's'}`);
    if (summary.severity.warning > 0) parts.push(`${summary.severity.warning} de atención`);
    if (summary.severity.info > 0) parts.push(`${summary.severity.info} informativa${summary.severity.info === 1 ? '' : 's'}`);
    const breakdown = parts.length > 0 ? parts.join(' · ') : 'todas atendidas';
    return `Vigilando ${summary.watchlist} entidad${summary.watchlist === 1 ? '' : 'es'} · ${breakdown}.`;
  }, [summary]);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-mesh text-[#0e1745] dark:text-white font-sans">
      <div className="relative z-10 max-w-[1320px] mx-auto w-full flex flex-col flex-1 px-4 sm:px-6">
        <TopDock />

        {/* ── Hero ────────────────────────────────────────────────── */}
        <div className="pt-10 pb-6">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-2">
            Centinela · vigilancia activa
          </p>
          <h1 className="font-display text-[34px] sm:text-[42px] font-semibold leading-tight text-[#0e1745] dark:text-white">
            {heroTitle}
          </h1>
          <p className="mt-2 text-[15px] text-[#0e1745]/55 dark:text-white/50 max-w-2xl leading-relaxed">
            {heroSubtitle}
          </p>

          {/* KPI strip — only when there's something to count */}
          {summary && summary.watchlist > 0 && (
            <div className="mt-5 flex flex-wrap gap-2.5">
              <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white dark:bg-white/[0.05] border border-black/8 dark:border-white/8">
                <Eye className="w-3.5 h-3.5 text-cl2-burgundy/70" />
                <span className="text-[16px] font-semibold font-display leading-none">{summary.watchlist}</span>
                <span className="text-[11px] text-[#0e1745]/50 dark:text-white/45">vigilando</span>
              </div>
              <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white dark:bg-white/[0.05] border border-black/8 dark:border-white/8">
                <Bell className="w-3.5 h-3.5 text-cl2-burgundy/70" />
                <span className="text-[16px] font-semibold font-display leading-none">{summary.unread}</span>
                <span className="text-[11px] text-[#0e1745]/50 dark:text-white/45">sin leer</span>
              </div>
              <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-white dark:bg-white/[0.05] border border-black/8 dark:border-white/8">
                <Inbox className="w-3.5 h-3.5 text-cl2-burgundy/70" />
                <span className="text-[16px] font-semibold font-display leading-none">{summary.total}</span>
                <span className="text-[11px] text-[#0e1745]/50 dark:text-white/45">en total</span>
              </div>
              {summary.prefs?.digest_enabled && (
                <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-cl2-burgundy/10 border border-cl2-burgundy/20 text-cl2-burgundy">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span className="text-[12px] font-medium">Digest Opus activo</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Body grid ───────────────────────────────────────────── */}
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-6 pb-10">
          {/* ── Feed (left, main) ─────────────────────────────────── */}
          <main>
            <div className="flex items-center gap-2 flex-wrap mb-4">
              <Filter className="w-3.5 h-3.5 text-[#0e1745]/40 dark:text-white/40" />
              <FilterChip
                active={filter.unread_only}
                onClick={() => setFilter((f) => ({ ...f, unread_only: !f.unread_only }))}
                label="Solo sin leer"
              />
              {(['state_change', 'deadline', 'mention', 'agenda', 'similar'] as AlertType[]).map((t) => (
                <FilterChip
                  key={t}
                  active={filter.type === t}
                  onClick={() => setFilter((f) => ({ ...f, type: f.type === t ? undefined : t }))}
                  label={alertTypeLabel(t)}
                />
              ))}
              {summary && summary.unread > 0 && (
                <button
                  onClick={handleMarkAllRead}
                  className="ml-auto text-[11px] text-cl2-burgundy hover:text-cl2-burgundy/80 flex items-center gap-1"
                >
                  <CheckCheck className="w-3 h-3" />
                  Marcar todo como leído
                </button>
              )}
            </div>

            {error && (
              <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-200/50 dark:border-red-900/30 text-[12px] text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            {loading && alerts.length === 0 ? (
              <div className="text-center py-12 text-[#0e1745]/40 dark:text-white/35 text-[13px]">
                Cargando feed…
              </div>
            ) : alerts.length === 0 ? (
              <div className="text-center py-16 px-4">
                <BellOff className="w-8 h-8 mx-auto mb-3 text-[#0e1745]/25 dark:text-white/25" />
                <p className="text-[14px] text-[#0e1745]/65 dark:text-white/60 font-medium mb-1">
                  {watchlist.length === 0 ? 'Aún no vigilás nada' : 'Sin alertas que mostrar'}
                </p>
                <p className="text-[12px] text-[#0e1745]/45 dark:text-white/40 max-w-md mx-auto leading-relaxed">
                  {watchlist.length === 0
                    ? 'Agregá un expediente o diputado al panel derecho. Centinela los va a vigilar 24/7 y te avisa cuando algo cambie.'
                    : 'Cuando un expediente de tu watchlist cambie de estado, aparezca en agenda o sea mencionado en sesión, vas a verlo acá.'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {alerts.map((a) => (
                  <AlertRow key={a.id} alert={a} onMarkRead={handleMarkRead} />
                ))}
              </div>
            )}
          </main>

          {/* ── Sidebar (right) ───────────────────────────────────── */}
          <aside className="space-y-4">
            <WatchlistSidebar
              items={watchlist}
              onAdd={handleAddWatchlist}
              onRemove={handleRemoveWatchlist}
            />
            {prefs && <PrefsPanel prefs={prefs} onChange={handlePrefsChange} />}
          </aside>
        </div>
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors',
        active
          ? 'bg-cl2-burgundy text-white'
          : 'bg-black/4 dark:bg-white/[0.06] text-[#0e1745]/60 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
      )}
    >
      {label}
    </button>
  );
}
