/**
 * Expediente detail — our canonical view for a SIL expediente.
 *
 * This is what the "Ver expediente" button on every SIL citation card
 * deeplinks to. It renders entirely from OUR DB + OUR GCS mirror, so
 * it works even when consultassil3.asamblea.go.cr is down.
 *
 * Layout (≥md):
 *   ┌─────────────────────────────────────────────┐
 *   │ ← back · Exp. NN · estado · proponente      │
 *   ├──────────────────────┬──────────────────────┤
 *   │ Title + meta cards   │ Documentos          │
 *   │ Link to SIL upstream │ pdf list w/ preview │
 *   │                      │ click → signed URL  │
 *   └──────────────────────┴──────────────────────┘
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { ArrowLeft, ExternalLink, FileText, Gavel, Calendar, Users, Building2, Scale } from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { navigate } from '@/lib/router';
import { fetchExpediente, resolveDocUrl, type Expediente, type ExpedienteDoc } from '@/services/expedientesApi';

interface Props {
  numero: number;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('es-CR', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch { return iso; }
}

function tipoLabel(tipo: string): { label: string; cls: string } {
  switch (tipo) {
    case 'texto_base':       return { label: 'Texto base',         cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-300' };
    case 'dictamen_mayoria': return { label: 'Dictamen mayoría',   cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' };
    case 'dictamen_minoria': return { label: 'Dictamen minoría',   cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' };
    case 'mocion':           return { label: 'Moción',             cls: 'bg-purple-500/10 text-purple-700 dark:text-purple-300' };
    case 'votacion':         return { label: 'Votación',           cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300' };
    case 'acta':             return { label: 'Acta',               cls: 'bg-slate-500/10 text-slate-700 dark:text-slate-300' };
    case 'enmienda':         return { label: 'Enmienda',           cls: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300' };
    default:                 return { label: tipo,                 cls: 'bg-gray-500/10 text-gray-700 dark:text-gray-300' };
  }
}

export function ExpedienteViewPage({ numero }: Props) {
  const [exp, setExp] = useState<Expediente | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchExpediente(numero)
      .then((e) => { if (!cancelled) setExp(e); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [numero]);

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-mesh text-white">
        <div className="text-center max-w-md px-6">
          <p className="text-lg mb-2">No se pudo cargar el expediente</p>
          <p className="text-sm text-white/60 mb-1">Exp. {numero}</p>
          <p className="text-xs text-white/50 mb-4">{error}</p>
          <button onClick={() => navigate('/sesiones')} className="text-sm underline">
            Volver al inicio
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative overflow-hidden transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      <TopDock />

      {/* Sticky sub-header */}
      <div className="relative z-20 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/70 dark:bg-black/20 backdrop-blur-sm">
        <div className="px-4 sm:px-6 md:px-8 py-3 flex items-center gap-3 max-w-[1400px] mx-auto">
          <button
            onClick={() => window.history.length > 1 ? window.history.back() : navigate('/sesiones')}
            className="shrink-0 p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Volver"
          >
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-cl2-accent/15 text-cl2-accent border border-cl2-accent/25">
                <Gavel className="w-2.5 h-2.5" />
                Expediente
              </span>
              <span className="text-sm font-mono tabular-nums text-[#0e1745]/75 dark:text-white/80">
                {exp?.numero ? `Exp. ${exp.numero}` : `Exp. #${numero}`}
              </span>
              {exp?.estado && (
                <span className="text-[11px] text-[#0e1745]/55 dark:text-white/55">· {exp.estado}</span>
              )}
            </div>
            <h1 className="text-sm sm:text-base font-medium text-[#0e1745] dark:text-white truncate mt-0.5">
              {exp?.titulo ?? 'Cargando…'}
            </h1>
          </div>
          {exp?.url_detalle && (
            <a
              href={exp.url_detalle}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-[#0e1745]/60 dark:text-white/60 hover:text-cl2-accent transition-colors shrink-0"
              title="Abrir búsqueda en SIL oficial"
            >
              SIL oficial <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      <main className="relative z-20 flex-1 min-h-0 max-w-[1400px] w-full mx-auto px-4 sm:px-6 md:px-8 py-4 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-[40fr_60fr] gap-4 lg:gap-6">
          {/* LEFT — meta cards */}
          <section className="space-y-3">
            <MetaCard
              icon={<Building2 size={14} />}
              label="Comisión"
              value={exp?.comision ?? '—'}
            />
            <MetaCard
              icon={<Users size={14} />}
              label="Proponente"
              value={exp?.proponente ?? '—'}
            />
            <div className="grid grid-cols-2 gap-3">
              <MetaCard
                icon={<Calendar size={14} />}
                label="Presentación"
                value={fmtDate(exp?.fecha_presentacion ?? null)}
                small
              />
              <MetaCard
                icon={<Scale size={14} />}
                label="Tipo"
                value={exp?.tipo ?? '—'}
                small
              />
            </div>
            {exp?.legislatura && (
              <MetaCard
                icon={<Calendar size={14} />}
                label="Legislatura"
                value={exp.legislatura}
              />
            )}
          </section>

          {/* RIGHT — documents */}
          <section className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-none overflow-hidden">
            <header className="px-4 py-3 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06] flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[#0e1745] dark:text-white">
                Documentos adjuntos
              </h2>
              <span className="text-[11px] text-[#0e1745]/45 dark:text-white/45">
                {exp ? `${exp.documentos.length} ${exp.documentos.length === 1 ? 'documento' : 'documentos'}` : '…'}
              </span>
            </header>
            {!exp ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-14 rounded-lg bg-white/40 dark:bg-white/[0.03] animate-pulse" />
                ))}
              </div>
            ) : exp.documentos.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">
                <FileText size={28} className="mx-auto mb-2 opacity-40" />
                <p>No hay documentos indexados aún para este expediente.</p>
                <p className="text-xs mt-1 text-gray-400/70">
                  El procesamiento corre en cola — vuelvan en unos minutos.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-[#0e1745]/[0.06] dark:divide-white/[0.06]">
                {exp.documentos.map((d) => <DocRow key={d.id} doc={d} />)}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function MetaCard({ icon, label, value, small }: { icon: React.ReactNode; label: string; value: string; small?: boolean }) {
  return (
    <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.025] p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] text-[#0e1745]/55 dark:text-white/55 mb-1">
        {icon}
        <span>{label}</span>
      </div>
      <div className={small ? 'text-sm font-medium' : 'text-base font-medium'}>
        {value}
      </div>
    </div>
  );
}

function DocRow({ doc }: { doc: ExpedienteDoc }) {
  const t = tipoLabel(doc.tipo);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Click handler that resolves the auth-gated view_url to a signed URL
  // (or source_url fallback) and opens it in a new tab.
  //
  // Two subtleties:
  //   1. We pre-open a placeholder tab BEFORE the await so popup blockers
  //      treat it as user-initiated — async window.open after a fetch
  //      gets blocked.
  //   2. We CANNOT pass 'noopener' to that placeholder open: with noopener,
  //      window.open returns null and we lose the handle, so we can't
  //      redirect it. Acceptable because we control the resolved URL
  //      (our own GCS signed URL or the asamblea.go.cr source) — opener
  //      reachback isn't a real risk here. We do scrub `window.opener`
  //      from the placeholder side just in case.
  const handleOpen = async (e: MouseEvent) => {
    e.preventDefault();
    if (opening) return;
    setOpening(true);
    setError(null);
    const placeholder = window.open('about:blank', '_blank');
    if (placeholder) {
      try { placeholder.opener = null; } catch { /* cross-origin lock-down ok */ }
    }
    try {
      const url = await resolveDocUrl(doc.view_url);
      if (placeholder && !placeholder.closed) {
        placeholder.location.href = url;
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } catch (err) {
      if (placeholder && !placeholder.closed) placeholder.close();
      setError((err as Error).message);
    } finally {
      setOpening(false);
    }
  };

  return (
    <li>
      <a
        href={doc.view_url}
        onClick={handleOpen}
        target="_blank"
        rel="noopener noreferrer"
        aria-busy={opening}
        className="block px-4 py-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-start gap-3">
          <div className="shrink-0 mt-0.5">
            <FileText size={16} className="text-[#0e1745]/35 dark:text-white/35" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${t.cls}`}>
                {t.label}
              </span>
              {doc.fecha && (
                <span className="text-[11px] text-[#0e1745]/50 dark:text-white/50">
                  {fmtDate(doc.fecha)}
                </span>
              )}
              {doc.text_chars != null && doc.text_chars > 0 && (
                <span className="text-[10px] text-[#0e1745]/40 dark:text-white/40">
                  · {Math.round(doc.text_chars / 1000)}k chars
                </span>
              )}
              {opening && (
                <span className="text-[10px] text-[#0e1745]/45 dark:text-white/45">
                  · abriendo…
                </span>
              )}
            </div>
            {doc.titulo && (
              <p className="text-[13px] text-[#0e1745]/85 dark:text-white/85 mt-1 line-clamp-2">
                {doc.titulo}
              </p>
            )}
            {error && (
              <p className="text-[11px] text-rose-600 dark:text-rose-400 mt-1">
                No se pudo abrir el documento: {error}
              </p>
            )}
          </div>
          <ExternalLink size={14} className="shrink-0 mt-1 text-[#0e1745]/35 dark:text-white/35" />
        </div>
      </a>
    </li>
  );
}
