/**
 * InformesSemanalesPage — /informes-semanales
 *
 * Sprint 3 Track P. Lista de informes editoriales semanales del user
 * logged in. Click → abre el cuerpo markdown completo + acciones propuestas.
 *
 * Empty state: si el job aún no corrió, mostramos un mensaje editorial
 * sobrio explicando que se genera los lunes 6am.
 *
 * Author: Jred / Claude Code — 2026-05-16
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText,
  Loader2,
  RefreshCw,
  ArrowLeft,
  Bell,
  Plus,
  TrendingUp,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TopDock } from '@/components/top-dock';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface InformePreview {
  id: string;
  semana_iso: string;
  novedades_count: number;
  alertas_criticas: number;
  expedientes_nuevos: number;
  generated_at: string;
  enviado_email: boolean;
}

interface AccionPropuesta {
  tipo: string;
  expediente?: string;
  urgencia: 'alta' | 'media' | 'baja';
  sugerencia: string;
}

interface InformeFull extends InformePreview {
  cuerpo_md: string;
  acciones_propuestas: AccionPropuesta[] | null;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

async function apiFetch<T>(path: string): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`/api/informes-semanales${path}`, { headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function fetchInformes(): Promise<InformePreview[]> {
  const r = await apiFetch<{ ok: true; items: InformePreview[] }>('');
  return r.items;
}

async function fetchInforme(semanaIso: string): Promise<InformeFull> {
  const r = await apiFetch<{ ok: true; informe: InformeFull }>(
    `/${encodeURIComponent(semanaIso)}`,
  );
  return r.informe;
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

function semanaLabel(semanaIso: string): string {
  // "2026-W20" → "Semana 20 — 2026"
  const m = semanaIso.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return semanaIso;
  return `Semana ${Number(m[2])} · ${m[1]}`;
}

function relativeDate(iso: string): string {
  const d = new Date(iso);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return 'hoy';
  if (diffDays === 1) return 'ayer';
  if (diffDays < 7) return `hace ${diffDays} días`;
  return d.toLocaleDateString('es-CR', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── Card de preview ─────────────────────────────────────────────────────────

function InformeCard({
  informe,
  onClick,
}: {
  informe: InformePreview;
  onClick: () => void;
}) {
  const total = informe.novedades_count + informe.alertas_criticas + informe.expedientes_nuevos;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left border rounded-xl p-5 transition-all',
        'border-[#0e1745]/10 dark:border-white/10',
        'bg-white/70 dark:bg-white/[0.03]',
        'hover:bg-white dark:hover:bg-white/[0.06]',
        'hover:border-cl2-burgundy/30 dark:hover:border-cl2-burgundy/40',
        'shadow-sm hover:shadow-md',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-cl2-burgundy/80 dark:text-cl2-burgundy/70">
            {informe.semana_iso}
          </p>
          <h3 className="mt-1 font-display text-lg font-semibold text-[#0e1745] dark:text-white leading-tight">
            {semanaLabel(informe.semana_iso)}
          </h3>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Generado {relativeDate(informe.generated_at)}
          </p>
        </div>
        <FileText className="w-5 h-5 shrink-0 text-cl2-burgundy/60 dark:text-cl2-burgundy/50 mt-1" />
      </div>

      {total > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {informe.alertas_criticas > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 font-medium">
              <Bell className="w-3 h-3" />
              {informe.alertas_criticas} crítica{informe.alertas_criticas === 1 ? '' : 's'}
            </span>
          )}
          {informe.novedades_count > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300 font-medium">
              <TrendingUp className="w-3 h-3" />
              {informe.novedades_count} novedad{informe.novedades_count === 1 ? '' : 'es'}
            </span>
          )}
          {informe.expedientes_nuevos > 0 && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300 font-medium">
              <Plus className="w-3 h-3" />
              {informe.expedientes_nuevos} nuevo{informe.expedientes_nuevos === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

// ─── Vista detalle ───────────────────────────────────────────────────────────

const URGENCIA_STYLES: Record<'alta' | 'media' | 'baja', string> = {
  alta: 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300',
  media:
    'border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300',
  baja:
    'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 text-gray-700 dark:text-gray-400',
};

function InformeDetalle({ informe, onBack }: { informe: InformeFull; onBack: () => void }) {
  const acciones = informe.acciones_propuestas ?? [];
  return (
    <div>
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-[#0e1745] dark:hover:text-white transition-colors mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        Volver a la lista
      </button>

      <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:font-display prose-headings:text-[#0e1745] dark:prose-headings:text-white prose-strong:text-[#0e1745] dark:prose-strong:text-white">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{informe.cuerpo_md}</ReactMarkdown>
      </div>

      {acciones.length > 0 && (
        <section className="mt-8 pt-6 border-t border-[#0e1745]/10 dark:border-white/10">
          <h2 className="font-display text-base font-semibold text-[#0e1745] dark:text-white mb-3">
            Acciones propuestas
          </h2>
          <ul className="flex flex-col gap-2">
            {acciones.map((a, i) => (
              <li
                key={i}
                className={cn(
                  'border rounded-lg p-3 text-sm',
                  URGENCIA_STYLES[a.urgencia] ?? URGENCIA_STYLES.media,
                )}
              >
                <div className="flex items-start gap-3">
                  <span className="text-xs font-semibold uppercase tracking-wider shrink-0 pt-0.5">
                    {a.urgencia}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">
                      {a.tipo}
                      {a.expediente ? ` · exp ${a.expediente}` : ''}
                    </p>
                    <p className="mt-1 text-sm opacity-90">{a.sugerencia}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ─── Página ──────────────────────────────────────────────────────────────────

export function InformesSemanalesPage() {
  const [items, setItems] = useState<InformePreview[]>([]);
  const [selected, setSelected] = useState<InformeFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetalle, setLoadingDetalle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const loadRef = useRef(false);

  useEffect(() => {
    if (loadRef.current) return;
    loadRef.current = true;
    setLoading(true);
    setError(null);
    fetchInformes()
      .then((rows) => setItems(rows))
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setLoading(false);
        loadRef.current = false;
      });
  }, [refreshKey]);

  const handleOpen = useCallback(async (semanaIso: string) => {
    setLoadingDetalle(true);
    setError(null);
    try {
      const informe = await fetchInforme(semanaIso);
      setSelected(informe);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingDetalle(false);
    }
  }, []);

  const handleBack = useCallback(() => setSelected(null), []);
  const handleRefresh = () => setRefreshKey((k) => k + 1);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f0f2fa] to-white dark:from-[#0a0d1f] dark:to-[#0f1224]">
      <TopDock />

      <main className="max-w-3xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="font-display text-2xl font-bold text-[#0e1745] dark:text-white flex items-center gap-2">
              <FileText className="w-6 h-6 text-cl2-burgundy" />
              Informes semanales
            </h1>
            {!loading && (
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {items.length === 0
                  ? 'Sin informes generados todavía'
                  : `${items.length} informe${items.length === 1 ? '' : 's'} disponible${items.length === 1 ? '' : 's'}`}
              </p>
            )}
          </div>

          {!selected && (
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-white/5 hover:bg-gray-50 dark:hover:bg-white/10 text-gray-600 dark:text-gray-400 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              Actualizar
            </button>
          )}
        </div>

        {error && !loadingDetalle && (
          <div className="mb-4 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-4 text-sm text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {loadingDetalle && (
          <div className="flex items-center justify-center py-16 gap-2 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-sm">Abriendo informe…</span>
          </div>
        )}

        {/* Vista de detalle */}
        {selected && !loadingDetalle && (
          <InformeDetalle informe={selected} onBack={handleBack} />
        )}

        {/* Lista */}
        {!selected && !loadingDetalle && (
          <>
            {loading && (
              <div className="flex items-center justify-center py-16 gap-2 text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span className="text-sm">Cargando informes…</span>
              </div>
            )}

            {!loading && items.length === 0 && !error && (
              <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
                <FileText className="w-12 h-12 text-gray-300 dark:text-gray-700" />
                <div>
                  <p className="font-display text-base font-medium text-gray-600 dark:text-gray-400">
                    Sin informes generados todavía
                  </p>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-500 max-w-md">
                    El informe semanal se genera los lunes a las 6:00 a.m. con las novedades,
                    alertas y nuevos expedientes de tu watchlist.
                  </p>
                </div>
              </div>
            )}

            {!loading && items.length > 0 && (
              <div className="flex flex-col gap-3">
                {items.map((it) => (
                  <InformeCard key={it.id} informe={it} onClick={() => handleOpen(it.semana_iso)} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
