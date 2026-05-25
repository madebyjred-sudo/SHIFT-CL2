/**
 * CentinelaHeroStrip — "first thing you see" on /
 *
 * Three states layered on top of summary + feed responses:
 *
 *   (A) HAS UNREAD ALERTS
 *       Render up to 3 most recent unread alerts as compact cards.
 *       Each card: type pill + entity + body snippet + "ver" link.
 *       "Ver todas (N)" CTA on the right that navigates to /centinela.
 *
 *   (B) HAS WATCHLIST, NO UNREAD
 *       "Todo tranquilo" calm state with a count + reassurance copy.
 *       Subtle, doesn't fight for attention with the chat headline.
 *
 *   (C) NO WATCHLIST AT ALL
 *       Active CTA with starter buttons: "Vigilá tu primer expediente",
 *       "Vigilá un diputado", "Pedí sugerencias a Centinela". The CTA
 *       buttons take the user straight to /centinela where they can
 *       complete the action. We surface 3-4 zero-friction actions
 *       instead of telling them "go set up Centinela first".
 *
 * The strip is intentionally short (~80px). It sits ABOVE the chat
 * headline rotating text — both fit comfortably in the upper third of
 * the viewport on a laptop, with the chat input still anchored at the
 * bottom. We never block the chat — Centinela is invitation, not
 * gatekeep.
 *
 * Self-loading: the component fetches its own data on mount. No props
 * required from the parent. If the user is unauthenticated, both
 * fetches 401 and we render nothing (silent) — Centinela isn't part
 * of the public/landing surface.
 */

import { useEffect, useState } from 'react';
import { Eye, AlertCircle, AlertTriangle, Bell, ArrowRight, Sparkles, Plus } from 'lucide-react';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  getSummary, getFeed, alertTypeLabel,
  type CentinelaAlert, type Summary,
} from '@/services/centinelaApi';
import { isCentinelaLocked } from '@/lib/centinelaCountdown';
import { CentinelaLockStrip } from './CentinelaLockOverlay';

export function CentinelaHeroStrip() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [alerts, setAlerts] = useState<CentinelaAlert[]>([]);
  const [loaded, setLoaded] = useState(false);
  const locked = isCentinelaLocked();

  useEffect(() => {
    // Centinela en refactor — no pegamos a la API mientras dura el lock.
    // Ver lib/centinelaCountdown.ts.
    if (locked) return;
    let alive = true;
    Promise.all([
      getSummary().catch(() => null),
      getFeed({ limit: 3, unread_only: true }).catch(() => ({ items: [], nextCursor: null })),
    ])
      .then(([s, f]) => {
        if (!alive) return;
        setSummary(s);
        setAlerts(f.items);
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => { alive = false; };
  }, [locked]);

  // Centinela bloqueado temporalmente — reemplazo total del strip por el
  // chip de countdown. Hooks ya se llamaron arriba para respetar Rules.
  if (locked) return <CentinelaLockStrip />;

  // Don't render anything until we know the state — flashing the empty
  // state and then swapping to alerts is jarring. ~200ms of blank space
  // is invisible.
  if (!loaded || !summary) return null;

  // ── Variant A: unread alerts ─────────────────────────────────────────
  if (summary.unread > 0 && alerts.length > 0) {
    return (
      <div className="absolute top-[14%] left-1/2 -translate-x-1/2 w-full max-w-3xl px-4 z-10">
        <div className="flex items-center justify-between mb-2.5 px-1">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/75">
            <Eye className="w-3 h-3" />
            Centinela · {summary.unread} alerta{summary.unread === 1 ? '' : 's'} sin leer
          </div>
          <button
            onClick={() => navigate('/centinela')}
            className="text-[11px] text-cl2-burgundy hover:text-cl2-burgundy/80 transition-colors flex items-center gap-1"
          >
            Ver todas
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {alerts.map((a) => <AlertCard key={a.id} alert={a} />)}
        </div>
      </div>
    );
  }

  // ── Variant B: watchlist exists, no unread ───────────────────────────
  if (summary.watchlist > 0) {
    return (
      <div className="absolute top-[14%] left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 z-10">
        <button
          onClick={() => navigate('/centinela')}
          className="w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-emerald-50/60 dark:bg-emerald-900/15 border border-emerald-200/40 dark:border-emerald-900/25 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors text-left group"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/15 dark:bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
              <Eye className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
            </div>
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-emerald-900 dark:text-emerald-100">
                Centinela · todo tranquilo
              </div>
              <div className="text-[10.5px] text-emerald-700/70 dark:text-emerald-300/70 truncate">
                Vigilando {summary.watchlist} entidad{summary.watchlist === 1 ? '' : 'es'} · sin novedades nuevas
              </div>
            </div>
          </div>
          <ArrowRight className="w-3.5 h-3.5 text-emerald-700/60 dark:text-emerald-400/60 flex-shrink-0 group-hover:translate-x-0.5 transition-transform" />
        </button>
      </div>
    );
  }

  // ── Variant C: no watchlist — actionable empty state ─────────────────
  return (
    <div className="absolute top-[14%] left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 z-10">
      <div className="rounded-xl bg-white/70 dark:bg-white/[0.04] backdrop-blur border border-black/8 dark:border-white/10 px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-7 h-7 rounded-lg bg-cl2-burgundy/10 flex items-center justify-center flex-shrink-0">
            <Eye className="w-3.5 h-3.5 text-cl2-burgundy" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-[#0e1745] dark:text-white">
              Centinela está dormido
            </div>
            <div className="text-[10.5px] text-[#0e1745]/55 dark:text-white/50">
              Decile qué vigilar y te avisa cuando algo cambia
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => navigate('/centinela')}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-cl2-burgundy text-white text-[10.5px] font-medium hover:bg-cl2-burgundy/90 transition-colors"
          >
            <Plus className="w-2.5 h-2.5" />
            Mi primer expediente
          </button>
          <button
            onClick={() => navigate('/centinela')}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-black/4 dark:bg-white/[0.06] text-[#0e1745]/70 dark:text-white/65 text-[10.5px] font-medium hover:bg-black/8 dark:hover:bg-white/[0.10] transition-colors"
          >
            <Plus className="w-2.5 h-2.5" />
            Un diputado
          </button>
          <button
            onClick={() => navigate('/centinela')}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-black/4 dark:bg-white/[0.06] text-[#0e1745]/70 dark:text-white/65 text-[10.5px] font-medium hover:bg-black/8 dark:hover:bg-white/[0.10] transition-colors"
          >
            <Plus className="w-2.5 h-2.5" />
            Un tema
          </button>
          <button
            onClick={() => navigate('/centinela')}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-cl2-burgundy/10 text-cl2-burgundy text-[10.5px] font-medium hover:bg-cl2-burgundy/15 transition-colors"
            title="Centinela lee tu perfil y te propone"
          >
            <Sparkles className="w-2.5 h-2.5" />
            Que me sugiera
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Compact alert card ────────────────────────────────────────────────

function AlertCard({ alert }: { alert: CentinelaAlert }) {
  const severityColor: Record<string, string> = {
    info:     'border-blue-200/40 dark:border-blue-900/25',
    warning:  'border-amber-200/50 dark:border-amber-900/30',
    critical: 'border-red-200/50 dark:border-red-900/35',
  };
  const severityIcon = {
    info: <Bell className="w-2.5 h-2.5" />,
    warning: <AlertTriangle className="w-2.5 h-2.5" />,
    critical: <AlertCircle className="w-2.5 h-2.5" />,
  }[alert.severity] ?? <Bell className="w-2.5 h-2.5" />;

  const payload = alert.payload as Record<string, string | undefined>;
  const body = composeAlertBody(alert.alert_type, payload, alert.entity_id);

  return (
    <button
      onClick={() => navigate('/centinela')}
      className={cn(
        'group w-full text-left rounded-lg bg-white dark:bg-white/[0.04] backdrop-blur border px-3 py-2 hover:bg-cl2-burgundy/5 dark:hover:bg-cl2-burgundy/10 transition-colors',
        severityColor[alert.severity] ?? 'border-black/8 dark:border-white/10',
      )}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-cl2-burgundy/80">{severityIcon}</span>
        <span className="text-[10px] font-medium uppercase tracking-wider text-cl2-burgundy/80">
          {alertTypeLabel(alert.alert_type)}
        </span>
        {!alert.read_at && (
          <span className="ml-auto w-1.5 h-1.5 rounded-full bg-cl2-burgundy" aria-label="No leída" />
        )}
      </div>
      <div className="text-[12px] font-medium text-[#0e1745] dark:text-white truncate">
        {alert.entity_type === 'expediente' ? `Expediente ${alert.entity_id}` : alert.entity_id}
      </div>
      <div className="text-[10.5px] text-[#0e1745]/60 dark:text-white/55 leading-snug truncate">
        {body}
      </div>
    </button>
  );
}

function composeAlertBody(
  type: string,
  p: Record<string, string | undefined>,
  entityId: string,
): string {
  if (type === 'state_change') return `${p.estado_anterior ?? '?'} → ${p.estado_actual ?? '?'}`;
  if (type === 'deadline') {
    const dias = (p as unknown as { dias_restantes?: number }).dias_restantes;
    return dias != null ? `Vence en ${dias} día${dias === 1 ? '' : 's'} · ${p.tipo_plazo ?? ''}` : (p.tipo_plazo ?? 'Plazo próximo');
  }
  if (type === 'mention') return p.snippet ? `"${p.snippet}"` : `Mencionado en sesión`;
  if (type === 'agenda') return `En agenda del ${p.fecha ?? '?'}${p.comision ? ` · ${p.comision}` : ''}`;
  if (type === 'similar') return `Similar a ${p.match_with ?? entityId}`;
  if (type === 'digest_weekly') return 'Digest semanal listo';
  return '';
}
