/**
 * Subir Sesión — Fase A of the /subir-sesiones port.
 *
 * Form posts to /api/uploads/youtube which proxies the legacy backend
 * (videos-register + sendToAutomatic). On success, polls /status every 12s
 * until the legacy worker finishes (typically 5–15 min) or the user
 * navigates away. The "ver sesión" link only enables when status === 'ready'.
 *
 * Out of scope (Fase B): direct GCS upload, ElevenLabs job runner, our own
 * resumen generator. See conversation for the full plan.
 */
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Calendar, CheckCircle2, Loader2, Radio, Upload, Youtube } from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { navigate } from '@/lib/router';
import { submitYoutubeUpload, fetchUploadStatus } from '@/services/uploadsApi';
import { cn } from '@/lib/utils';

const COMISIONES = [
  'Plenario',
  'Hacendarios',
  'Asuntos Sociales',
  'Económicos',
  'Jurídicos',
  'Gobierno y Administración',
  'Especial',
];

const TIPOS: Array<{ value: 'plenario' | 'comision' | 'extraordinaria'; label: string }> = [
  { value: 'plenario',       label: 'Plenario' },
  { value: 'comision',       label: 'Comisión' },
  { value: 'extraordinaria', label: 'Extraordinaria' },
];

const POLL_INTERVAL_MS = 12_000;
// Hard cap on wait time. Legacy worker normally finishes in 5–15 min; if it
// takes longer something is wrong upstream and the user should refresh later.
const POLL_TIMEOUT_MS = 30 * 60_000;
// After this many consecutive status-endpoint failures we tell the user the
// backend is flaky (instead of silently retrying forever).
const POLL_FAILURE_WARN_AT = 5;

type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | {
      kind: 'polling';
      legacyId: number;
      startedAt: number;
      lastDetail?: string;
      consecutiveFailures: number;
    }
  | { kind: 'ready'; legacyId: number; titulo: string }
  | { kind: 'partial'; legacyId: number; titulo: string; detail: string }
  | { kind: 'error'; message: string };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function SubirSesionPage() {
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [titulo, setTitulo] = useState('');
  const [fecha, setFecha] = useState(todayIso());
  const [comision, setComision] = useState('Plenario');
  const [tipo, setTipo] = useState<'plenario' | 'comision' | 'extraordinaria'>('plenario');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  // Poll loop. Re-runs whenever phase enters 'polling'. Cleanup on unmount or
  // phase change so we don't leak intervals after success/error.
  const pollTimer = useRef<number | null>(null);
  useEffect(() => {
    if (phase.kind !== 'polling') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetchUploadStatus(phase.legacyId);
        if (cancelled) return;
        if (r.status === 'ready') {
          setPhase({
            kind: 'ready',
            legacyId: phase.legacyId,
            titulo: r.session.titulo,
          });
          return;
        }
        if (r.status === 'partial') {
          // Legacy estado=1 but no transcript URL — treat as a soft failure
          // so the user can decide what to do (retry, contact ops).
          setPhase({
            kind: 'partial',
            legacyId: phase.legacyId,
            titulo: r.session.titulo,
            detail: r.detail,
          });
          return;
        }
        // still pending — schedule next tick unless we've hit the cap
        if (Date.now() - phase.startedAt > POLL_TIMEOUT_MS) {
          setPhase({
            kind: 'error',
            message:
              'El worker tardó más de lo esperado. La sesión puede aparecer en /sesiones más tarde.',
          });
          return;
        }
        setPhase((p) =>
          p.kind === 'polling'
            ? { ...p, lastDetail: r.detail, consecutiveFailures: 0 }
            : p,
        );
        pollTimer.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        // Transient failures shouldn't kill the poll — count them so the UI
        // can show a "we're having trouble reaching the worker" warning
        // after a few in a row, instead of looking healthy while broken.
        setPhase((p) =>
          p.kind === 'polling'
            ? { ...p, consecutiveFailures: p.consecutiveFailures + 1 }
            : p,
        );
        pollTimer.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    pollTimer.current = window.setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (pollTimer.current != null) window.clearTimeout(pollTimer.current);
    };
  }, [phase]);

  const isBusy = phase.kind === 'submitting' || phase.kind === 'polling';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isBusy) return;
    setPhase({ kind: 'submitting' });
    try {
      const r = await submitYoutubeUpload({
        youtube_url: youtubeUrl.trim(),
        titulo: titulo.trim(),
        fecha,
        comision,
        tipo,
      });
      setPhase({
        kind: 'polling',
        legacyId: r.legacy_id,
        startedAt: Date.now(),
        consecutiveFailures: 0,
      });
    } catch (err) {
      setPhase({ kind: 'error', message: (err as Error).message });
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative overflow-hidden transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      <TopDock />

      <main className="relative z-20 flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 md:px-10 pt-6 pb-16">
        <div className="max-w-2xl mx-auto">
          <button
            onClick={() => navigate('/sesiones')}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-[#F93549] mb-4 transition-colors"
          >
            <ArrowLeft size={14} /> Volver a plenarias
          </button>

          <header className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#F93549]/15 to-[#E11D48]/10 flex items-center justify-center">
              <Upload size={18} strokeWidth={1.75} className="text-[#F93549]" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-[#0e1745] dark:text-white">
                Subir sesión
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Ingresá la URL de YouTube. El sistema baja el audio, transcribe y genera resumen automático.
              </p>
            </div>
          </header>

          {phase.kind === 'ready' ? (
            <ReadyCard
              titulo={phase.titulo}
              onView={() => navigate(`/sesiones/${phase.legacyId}`)}
            />
          ) : phase.kind === 'partial' ? (
            <PartialCard
              titulo={phase.titulo}
              legacyId={phase.legacyId}
              detail={phase.detail}
              onView={() => navigate(`/sesiones/${phase.legacyId}`)}
              onRetry={() => setPhase({ kind: 'idle' })}
            />
          ) : (
            <form
              onSubmit={handleSubmit}
              className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] p-5 sm:p-6 space-y-5 shadow-[0_4px_20px_rgba(14,23,69,0.04)]"
            >
              <Field label="URL de YouTube" icon={<Youtube size={14} />}>
                <input
                  type="url"
                  required
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  disabled={isBusy}
                  className={inputCls}
                />
              </Field>

              <Field label="Título de la sesión">
                <input
                  type="text"
                  required
                  minLength={3}
                  value={titulo}
                  onChange={(e) => setTitulo(e.target.value)}
                  placeholder="p.ej. Sesión Plenaria N.º 042"
                  disabled={isBusy}
                  className={inputCls}
                />
              </Field>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Fecha" icon={<Calendar size={14} />}>
                  <input
                    type="date"
                    required
                    value={fecha}
                    onChange={(e) => setFecha(e.target.value)}
                    disabled={isBusy}
                    className={inputCls}
                  />
                </Field>
                <Field label="Tipo" icon={<Radio size={14} />}>
                  <select
                    value={tipo}
                    onChange={(e) => setTipo(e.target.value as typeof tipo)}
                    disabled={isBusy}
                    className={inputCls}
                  >
                    {TIPOS.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Comisión / Órgano">
                <select
                  value={comision}
                  onChange={(e) => setComision(e.target.value)}
                  disabled={isBusy}
                  className={inputCls}
                >
                  {COMISIONES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </Field>

              {phase.kind === 'error' && (
                <div className="rounded-xl border border-red-300/50 bg-red-50/60 dark:bg-red-500/10 dark:border-red-500/20 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                  {phase.message}
                </div>
              )}

              {phase.kind === 'polling' && (
                <PollingBanner
                  legacyId={phase.legacyId}
                  elapsedMs={Date.now() - phase.startedAt}
                  failures={phase.consecutiveFailures}
                />
              )}

              <button
                type="submit"
                disabled={isBusy}
                className={cn(
                  'w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all',
                  isBusy
                    ? 'bg-gray-200 dark:bg-white/10 text-gray-500 dark:text-white/50 cursor-not-allowed'
                    : 'bg-[#F93549] text-white hover:bg-[#E11D48] shadow-[0_4px_15px_rgba(249,53,73,0.3)]',
                )}
              >
                {phase.kind === 'submitting' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Enviando…</>
                ) : phase.kind === 'polling' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Procesando en segundo plano…</>
                ) : (
                  <><Upload className="w-4 h-4" /> Iniciar procesamiento</>
                )}
              </button>

              <p className="text-[11px] text-gray-400 leading-relaxed">
                El procesamiento toma típicamente 5–15 minutos según la duración del video.
                Podés cerrar esta pestaña — la sesión aparecerá en /sesiones cuando esté lista.
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}

const inputCls =
  'w-full px-3 py-2 rounded-lg bg-gray-50 dark:bg-white/5 border border-[#0e1745]/[0.08] dark:border-white/10 text-sm focus:outline-none focus:ring-2 focus:ring-[#F93549]/30 transition disabled:opacity-50';

function Field({
  label, icon, children,
}: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-[12px] font-medium text-gray-700 dark:text-gray-300 mb-1.5">
        {icon}{label}
      </span>
      {children}
    </label>
  );
}

function PollingBanner({
  legacyId,
  elapsedMs,
  failures,
}: {
  legacyId: number;
  elapsedMs: number;
  failures: number;
}) {
  const mins = Math.floor(elapsedMs / 60_000);
  const flaky = failures >= POLL_FAILURE_WARN_AT;
  return (
    <div className="rounded-xl border border-blue-300/50 bg-blue-50/60 dark:bg-blue-500/10 dark:border-blue-500/20 px-4 py-3 text-sm text-blue-800 dark:text-blue-200 space-y-1">
      <div className="flex items-center gap-2 font-medium">
        <Loader2 className="w-4 h-4 animate-spin" />
        Sesión #{legacyId} en cola del worker legacy
      </div>
      <p className="text-xs opacity-80">
        Esperando transcripción + resumen. Tiempo en cola: {mins} min.
      </p>
      {flaky && (
        <p
          role="status"
          className="text-xs flex items-center gap-1.5 text-amber-700 dark:text-amber-300 pt-1"
        >
          <AlertTriangle size={12} />
          {failures} fallos consecutivos al consultar estado. La sesión puede seguir procesándose; refrescá más tarde si no aparece.
        </p>
      )}
    </div>
  );
}

function PartialCard({
  titulo,
  legacyId,
  detail,
  onView,
  onRetry,
}: {
  titulo: string;
  legacyId: number;
  detail: string;
  onView: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-amber-300/60 bg-amber-50/70 dark:bg-amber-500/10 dark:border-amber-500/30 p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-300" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-amber-800 dark:text-amber-200">
            Sesión #{legacyId} marcada como procesada, pero sin transcripción
          </h2>
          <p className="text-sm text-amber-800/80 dark:text-amber-200/80">
            {titulo}
          </p>
          <p className="text-xs text-amber-700/80 dark:text-amber-300/70 pt-1">
            El worker terminó pero no devolvió URL de transcripción
            {detail ? ` (${detail})` : ''}. La metadata existe; el chat scopeado no funcionará hasta que se reprocese.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={onView}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-amber-600 text-white text-sm font-medium hover:bg-amber-700 transition-colors"
        >
          Ver de todos modos
        </button>
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl border border-amber-600/40 text-amber-800 dark:text-amber-200 text-sm font-medium hover:bg-amber-100/60 dark:hover:bg-amber-500/10 transition-colors"
        >
          Subir otra
        </button>
      </div>
    </div>
  );
}

function ReadyCard({ titulo, onView }: { titulo: string; onView: () => void }) {
  return (
    <div className="rounded-2xl border border-emerald-300/50 bg-emerald-50/60 dark:bg-emerald-500/10 dark:border-emerald-500/20 p-6 text-center space-y-4">
      <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/10 flex items-center justify-center">
        <CheckCircle2 className="w-6 h-6 text-emerald-600 dark:text-emerald-400" />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-emerald-800 dark:text-emerald-200">
          Sesión procesada
        </h2>
        <p className="text-sm text-emerald-700/80 dark:text-emerald-300/80 mt-1">
          {titulo}
        </p>
      </div>
      <button
        onClick={onView}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
      >
        Ver sesión
      </button>
    </div>
  );
}
