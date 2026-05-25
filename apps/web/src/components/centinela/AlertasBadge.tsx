/**
 * AlertasBadge — badge en TopDock con contador de alertas no leídas.
 *
 * Color según la alerta de mayor prioridad pendiente (pedido 16d):
 *   critical → rojo con animate-pulse
 *   high     → naranja
 *   medium   → amarillo
 *   info     → gris
 *   sin alertas → no renderiza nada
 *
 * Click → navega a /alertas.
 * Se refresca automáticamente cada 60 segundos en background.
 *
 * Author: Jred / Claude Code — 2026-05-14
 */

import { useEffect, useState, useCallback } from 'react';
import { Bell } from 'lucide-react';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';
import { isCentinelaLocked } from '@/lib/centinelaCountdown';

// ─── Tipos ───────────────────────────────────────────────────────────────────

type Priority = 'critical' | 'high' | 'medium' | 'info';

interface BadgeData {
  total: number;
  counts: Record<Priority, number>;
  highestPriority: Priority | null;
}

// ─── API call ─────────────────────────────────────────────────────────────────

async function fetchBadge(): Promise<BadgeData | null> {
  try {
    const { data: session } = await supabase.auth.getSession();
    const token = session?.session?.access_token;
    if (!token) return null;

    const res = await fetch('/api/centinela/alertas/badge', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean } & BadgeData;
    if (!json.ok) return null;
    return {
      total: json.total,
      counts: json.counts,
      highestPriority: json.highestPriority,
    };
  } catch {
    return null;
  }
}

// ─── Estilos por prioridad ────────────────────────────────────────────────────

const BADGE_STYLES: Record<Priority, string> = {
  critical: 'bg-red-500 text-white animate-pulse',
  high: 'bg-orange-500 text-white',
  medium: 'bg-yellow-500 text-[#1a1a1a]',
  info: 'bg-gray-400 text-white',
};

const ICON_STYLES: Record<Priority, string> = {
  critical: 'text-red-500',
  high: 'text-orange-500',
  medium: 'text-yellow-500',
  info: 'text-gray-400',
};

// ─── Componente ───────────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 60_000; // 60 segundos

export function AlertasBadge() {
  const [badge, setBadge] = useState<BadgeData | null>(null);
  const [loading, setLoading] = useState(true);
  const locked = isCentinelaLocked();

  const refresh = useCallback(async () => {
    const data = await fetchBadge();
    setBadge(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Centinela en refactor — no polleamos la API mientras dura el lock.
    if (locked) return;

    // Carga inicial
    void refresh();

    // Polling cada 60s
    const interval = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [refresh, locked]);

  // Centinela bloqueado temporalmente — escondemos el badge entero. El
  // contador volverá cuando vuelva Centinela. Ver lib/centinelaCountdown.ts.
  if (locked) return null;

  // No renderizar mientras carga la primera vez
  if (loading) return null;

  // No renderizar si no hay alertas
  if (!badge || badge.total === 0 || !badge.highestPriority) return null;

  const priority = badge.highestPriority;
  const count = badge.total;

  return (
    <button
      onClick={() => navigate('/alertas')}
      className="relative flex items-center justify-center h-9 w-9 rounded-full bg-white/70 dark:bg-white/5 hover:bg-white dark:hover:bg-white/10 border border-white/70 dark:border-white/10 shadow-sm transition-all"
      aria-label={`${count} alerta${count === 1 ? '' : 's'} no leída${count === 1 ? '' : 's'}`}
      title={`${count} alerta${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'}`}
    >
      {/* Icono de campana */}
      <Bell className={cn('w-4 h-4', ICON_STYLES[priority])} />

      {/* Badge con conteo */}
      <span
        className={cn(
          'absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 rounded-full text-[10px] font-bold leading-4 text-center',
          BADGE_STYLES[priority],
        )}
      >
        {count > 99 ? '99+' : count}
      </span>
    </button>
  );
}
