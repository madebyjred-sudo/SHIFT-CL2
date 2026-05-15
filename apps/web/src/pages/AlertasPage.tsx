/**
 * AlertasPage — /alertas
 *
 * Lista de alertas del usuario (centinela_alerts_v2), agrupadas por prioridad.
 * No leídas primero dentro de cada grupo.
 *
 * Acciones por alerta:
 *   - "Marcar como leída"
 *   - "Snooze 1h / 24h"
 *   - Link al expediente (si aplica)
 *
 * Colores por prioridad:
 *   critical → rojo (bg-red-50 / dark:bg-red-950 + border-red-200)
 *   high     → naranja
 *   medium   → amarillo
 *   info     → gris
 *
 * Author: Jred / Claude Code — 2026-05-14
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell, BellOff, Check, Clock, ExternalLink,
  Loader2, RefreshCw,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { cn } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { supabase } from '@/lib/supabase';

// ─── Tipos ────────────────────────────────────────────────────────────────────

type Priority = 'critical' | 'high' | 'medium' | 'info';

interface AlertaV2 {
  id: string;
  event_id: string;
  watch_id: string | null;
  priority: Priority;
  title: string;
  body: string;
  delivered_at: string;
  read_at: string | null;
  snoozed_until: string | null;
  channel: string;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`/api/centinela${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function fetchAlertas(cursor?: string): Promise<{ items: AlertaV2[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: '50' });
  if (cursor) q.set('cursor', cursor);
  return apiFetch<{ ok: true; items: AlertaV2[]; nextCursor: string | null }>(
    `/alertas?${q.toString()}`,
  ).then((r) => ({ items: r.items, nextCursor: r.nextCursor }));
}

async function markRead(id: string): Promise<void> {
  await apiFetch(`/alertas/${encodeURIComponent(id)}/read`, { method: 'PATCH' });
}

async function snooze(id: string, hours: 1 | 24): Promise<void> {
  await apiFetch(`/alertas/${encodeURIComponent(id)}/snooze`, {
    method: 'PATCH',
    body: JSON.stringify({ hours }),
  });
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

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

function extractExpedienteId(title: string): string | null {
  const match = title.match(/exp\s+([\d.]+)/i);
  return match?.[1] ?? null;
}

// ─── Estilos por prioridad ────────────────────────────────────────────────────

const CARD_STYLES: Record<Priority, string> = {
  critical: 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40',
  high: 'border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-950/40',
  medium: 'border-yellow-200 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-950/40',
  info: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40',
};

const TITLE_STYLES: Record<Priority, string> = {
  critical: 'text-red-700 dark:text-red-300',
  high: 'text-orange-700 dark:text-orange-300',
  medium: 'text-yellow-700 dark:text-yellow-200',
  info: 'text-gray-700 dark:text-gray-300',
};

const PRIORITY_LABELS: Record<Priority, string> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Media',
  info: 'Informativa',
};

const PRIORITY_ORDER: Priority[] = ['critical', 'high', 'medium', 'info'];

// ─── Componente de alerta individual ─────────────────────────────────────────

function AlertaCard({
  alerta,
  onMarkRead,
  onSnooze,
}: {
  alerta: AlertaV2;
  onMarkRead: (id: string) => void;
  onSnooze: (id: string, hours: 1 | 24) => void;
}) {
  const isRead = !!alerta.read_at;
  const expedienteId = extractExpedienteId(alerta.title);

  return (
    <div
      className={cn(
        'border rounded-xl p-4 transition-opacity',
        CARD_STYLES[alerta.priority],
        isRead && 'opacity-60',
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className={cn('text-sm font-semibold leading-snug', TITLE_STYLES[alerta.priority])}>
            {alerta.title}
          </p>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
            {alerta.body}
          </p>
        </div>

        {/* Timestamp */}
        <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500 pt-0.5">
          {relativeTime(alerta.delivered_at)}
        </span>
      </div>

      {/* Acciones */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        {!isRead && (
          <button
            onClick={() => onMarkRead(alerta.id)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-white/80 dark:bg-white/10 hover:bg-white dark:hover:bg-white/20 border border-white/50 dark:border-white/10 text-gray-700 dark:text-gray-300 transition-colors"
          >
            <Check className="w-3 h-3" />
            Marcar leída
          </button>
        )}

        <button
          onClick={() => onSnooze(alerta.id, 1)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-white/80 dark:bg-white/10 hover:bg-white dark:hover:bg-white/20 border border-white/50 dark:border-white/10 text-gray-600 dark:text-gray-400 transition-colors"
        >
          <Clock className="w-3 h-3" />
          Snooze 1h
        </button>

        <button
          onClick={() => onSnooze(alerta.id, 24)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-white/80 dark:bg-white/10 hover:bg-white dark:hover:bg-white/20 border border-white/50 dark:border-white/10 text-gray-600 dark:text-gray-400 transition-colors"
        >
          <Clock className="w-3 h-3" />
          Snooze 24h
        </button>

        {expedienteId && (
          <button
            onClick={() => navigate(`/expediente/${expedienteId}`)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-white/80 dark:bg-white/10 hover:bg-white dark:hover:bg-white/20 border border-white/50 dark:border-white/10 text-gray-600 dark:text-gray-400 transition-colors ml-auto"
          >
            <ExternalLink className="w-3 h-3" />
            Ver expediente
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Sección por prioridad ────────────────────────────────────────────────────

function PrioritySection({
  priority,
  alertas,
  onMarkRead,
  onSnooze,
}: {
  priority: Priority;
  alertas: AlertaV2[];
  onMarkRead: (id: string) => void;
  onSnooze: (id: string, hours: 1 | 24) => void;
}) {
  if (alertas.length === 0) return null;

  return (
    <section>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-3">
        {PRIORITY_LABELS[priority]} ({alertas.length})
      </h2>
      <div className="flex flex-col gap-3">
        {alertas.map((a) => (
          <AlertaCard
            key={a.id}
            alerta={a}
            onMarkRead={onMarkRead}
            onSnooze={onSnooze}
          />
        ))}
      </div>
    </section>
  );
}

// ─── Página principal ─────────────────────────────────────────────────────────

export function AlertasPage() {
  const [alertas, setAlertas] = useState<AlertaV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadRef = useRef(false);

  // Carga inicial / refresh
  useEffect(() => {
    if (loadRef.current) return;
    loadRef.current = true;
    setLoading(true);
    setError(null);

    fetchAlertas()
      .then(({ items, nextCursor: nc }) => {
        setAlertas(items);
        setNextCursor(nc);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => {
        setLoading(false);
        loadRef.current = false;
      });
  }, [refreshKey]);

  const handleRefresh = () => setRefreshKey((k) => k + 1);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { items, nextCursor: nc } = await fetchAlertas(nextCursor);
      setAlertas((prev) => [...prev, ...items]);
      setNextCursor(nc);
    } catch (err) {
      // silencioso en "load more"
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore]);

  const handleMarkRead = useCallback(async (id: string) => {
    // Optimistic update
    setAlertas((prev) =>
      prev.map((a) => (a.id === id ? { ...a, read_at: new Date().toISOString() } : a)),
    );
    try {
      await markRead(id);
    } catch {
      // Revert si falla
      setAlertas((prev) => prev.map((a) => (a.id === id ? { ...a, read_at: null } : a)));
    }
  }, []);

  const handleSnooze = useCallback(async (id: string, hours: 1 | 24) => {
    const snoozedUntil = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    // Optimistic: ocultar de la vista
    setAlertas((prev) => prev.map((a) => (a.id === id ? { ...a, snoozed_until: snoozedUntil } : a)));
    try {
      await snooze(id, hours);
    } catch {
      // Revert
      setAlertas((prev) => prev.map((a) => (a.id === id ? { ...a, snoozed_until: null } : a)));
    }
  }, []);

  // Agrupar por prioridad, excluyendo snoozeadas
  const now = new Date();
  const visible = alertas.filter(
    (a) => !a.snoozed_until || new Date(a.snoozed_until) <= now,
  );

  const grouped = PRIORITY_ORDER.reduce<Record<Priority, AlertaV2[]>>(
    (acc, p) => {
      acc[p] = visible.filter((a) => a.priority === p);
      return acc;
    },
    { critical: [], high: [], medium: [], info: [] },
  );

  const unreadCount = visible.filter((a) => !a.read_at).length;

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f0f2fa] to-white dark:from-[#0a0d1f] dark:to-[#0f1224]">
      <TopDock />

      <main className="max-w-2xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-[#0e1745] dark:text-white flex items-center gap-2">
              <Bell className="w-6 h-6" />
              Alertas Centinela
            </h1>
            {!loading && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {unreadCount === 0
                  ? 'Sin alertas pendientes'
                  : `${unreadCount} alerta${unreadCount === 1 ? '' : 's'} sin leer`}
              </p>
            )}
          </div>

          <button
            onClick={handleRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Actualizar
          </button>
        </div>

        {/* Estado de carga */}
        {loading && (
          <div className="flex items-center justify-center py-16 gap-2 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Cargando alertas…</span>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-4 text-sm text-red-700 dark:text-red-300">
            Error al cargar alertas: {error}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && visible.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-gray-400 dark:text-gray-500">
            <BellOff className="w-12 h-12 opacity-40" />
            <div className="text-center">
              <p className="font-medium text-gray-600 dark:text-gray-400">Sin alertas pendientes</p>
              <p className="text-sm mt-1">
                Las alertas aparecen cuando hay novedades en los expedientes de tu watchlist.
              </p>
            </div>
            <button
              onClick={() => navigate('/centinela')}
              className="text-sm font-medium text-[#0e1745] dark:text-white underline underline-offset-4 hover:opacity-75 transition-opacity"
            >
              Ir a Centinela →
            </button>
          </div>
        )}

        {/* Alertas agrupadas por prioridad */}
        {!loading && visible.length > 0 && (
          <div className="flex flex-col gap-8">
            {PRIORITY_ORDER.map((p) => (
              <PrioritySection
                key={p}
                priority={p}
                alertas={grouped[p]}
                onMarkRead={handleMarkRead}
                onSnooze={handleSnooze}
              />
            ))}
          </div>
        )}

        {/* Load more */}
        {nextCursor && !loading && (
          <div className="mt-8 flex justify-center">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400 transition-colors disabled:opacity-50"
            >
              {loadingMore ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Cargando…</>
              ) : (
                'Cargar más'
              )}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
