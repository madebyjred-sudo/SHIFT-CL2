/**
 * Sessions index — premium list of plenarias from the legacy CL2 archive.
 *
 * Defaults to the last 90 days (BFF default). Each card → /sesiones/:id.
 * Mobile-friendly: cards stack on narrow viewports.
 */
import { useEffect, useState } from 'react';
import { Calendar, Clock, FileText, Plus, Radio, Search } from 'lucide-react';
import { fetchSessions, type SessionListItem } from '@/services/sessionsApi';
import { navigate } from '@/lib/router';
import { TopDock } from '@/components/top-dock';
import { cn } from '@/lib/utils';

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('es-CR', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch { return iso.slice(0, 10); }
}

function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function SesionesListPage() {
  const [items, setItems] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchSessions()
      .then((rows) => { if (!cancelled) setItems(rows); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, []);

  const filtered = items?.filter((s) =>
    !q.trim() || s.titulo.toLowerCase().includes(q.toLowerCase()),
  ) ?? null;

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative overflow-hidden transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      <TopDock />

      <main className="relative z-20 flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 md:px-10 pt-6 pb-16">
        <div className="max-w-5xl mx-auto">
          {/* Header */}
          <header className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#F93549]/15 to-[#E11D48]/10 flex items-center justify-center">
              <Radio size={20} strokeWidth={1.75} className="text-[#F93549]" />
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-[#0e1745] dark:text-white">
                Plenarias
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Sesiones legislativas con transcripción y análisis automático.
              </p>
            </div>
            <button
              onClick={() => navigate('/sesiones/subir')}
              aria-label="Subir nueva sesión"
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#F93549] text-white text-sm font-medium hover:bg-[#E11D48] shadow-[0_4px_15px_rgba(249,53,73,0.25)] transition-all focus:outline-none focus:ring-2 focus:ring-[#F93549]/40 focus:ring-offset-2 focus:ring-offset-gray-50 dark:focus:ring-offset-transparent"
            >
              <Plus size={14} strokeWidth={2.5} />
              <span className="hidden sm:inline">Subir sesión</span>
            </button>
          </header>

          {/* Search */}
          <div className="relative mb-6">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar por título de sesión..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-white dark:bg-white/5 border border-[#0e1745]/[0.08] dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#F93549]/30 transition"
            />
          </div>

          {/* States */}
          {error && (
            <div className="rounded-xl border border-red-300/50 bg-red-50/60 dark:bg-red-500/10 dark:border-red-500/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
              No se pudo cargar el listado. {error}
            </div>
          )}

          {!items && !error && (
            <div className="grid gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-[88px] rounded-xl bg-white/40 dark:bg-white/[0.03] animate-pulse" />
              ))}
            </div>
          )}

          {filtered && filtered.length === 0 && (
            <div className="text-center py-16 text-gray-500 dark:text-gray-400">
              <FileText size={32} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm">No se encontraron sesiones para los filtros actuales.</p>
            </div>
          )}

          {/* Cards */}
          {filtered && filtered.length > 0 && (
            <ul className="grid gap-3">
              {filtered.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/sesiones/${s.id}`)}
                    className={cn(
                      'group w-full text-left rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06]',
                      'bg-white dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06]',
                      'shadow-[0_2px_10px_rgba(14,23,69,0.04)] dark:shadow-none',
                      'p-4 sm:p-5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(14,23,69,0.08)]',
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm sm:text-base font-medium text-[#0e1745] dark:text-white line-clamp-2 group-hover:text-[#F93549] transition-colors">
                          {s.titulo}
                        </h3>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-500 dark:text-gray-400">
                          <span className="inline-flex items-center gap-1.5">
                            <Calendar size={12} strokeWidth={2} />
                            {fmtDate(s.fecha)}
                          </span>
                          <span className="inline-flex items-center gap-1.5">
                            <Clock size={12} strokeWidth={2} />
                            {fmtDuration(s.duration_s)}
                          </span>
                          {s.has_resumen && (
                            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                              <FileText size={12} strokeWidth={2} />
                              Resumen
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium',
                            s.estado === 1
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                              : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
                          )}
                        >
                          <span className={cn('w-1.5 h-1.5 rounded-full', s.estado === 1 ? 'bg-emerald-500' : 'bg-amber-500')} />
                          {s.estado === 1 ? 'Finalizada' : 'En proceso'}
                        </span>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
