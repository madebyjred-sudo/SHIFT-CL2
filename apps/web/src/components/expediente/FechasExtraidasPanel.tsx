/**
 * FechasExtraidasPanel — pedidos 07, 16g, 16h del cliente.
 *
 * Pedido 07 (Jred citando Donovan + Carlos, 29:17):
 *   "FECHA ESTIMADA DE DICTAMEN SIEMPRE ESTÁ DENTRO DE LOS DOCUMENTOS Y
 *    NORMALMENTE ES TENTATIVA NO OFICIAL PERO ES UN PROCESO QUE ELLOS
 *    HACEN MANUAL. PARTE DEL TRABAJO DE REPORTE DE ORDEN DEL DÍA ES ESTO."
 *
 * Pedido 16g (Carlos, 29:17):
 *   "Ahí tenés en ese 24982 en negrita, fecha para dictaminar."
 *   → mostramos badge "extraído en negrita" como señal de alta confidence.
 *
 * Pedido 16h (Carlos, 30:15):
 *   "Esa fecha para dictaminar es un aproximado. Puede variar...
 *    cada cierto tiempo están recalculando."
 *   → historial visible de los recálculos con la razón inferida.
 */
import { Calendar, FileText, History } from 'lucide-react';

interface FechaExtraida {
  campo: string;
  valor_fecha: string;
  valor_texto_original?: string;
  fuente_documento_url?: string;
  fuente_pagina?: number;
  extraction_method: string;
  extraction_confidence: number;
  visual_marker?: string;
  extracted_at: string;
}

interface FechaHistorial {
  valor_fecha: string;
  extracted_at: string;
  superseded_reason?: string;
}

interface Props {
  vigente?: FechaExtraida;
  historial?: FechaHistorial[];
  otrasFechas?: Record<string, { valor: string; texto: string }>;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('es-CR', {
    day: '2-digit', month: 'long', year: 'numeric',
  });
}

export function FechasExtraidasPanel({ vigente, historial, otrasFechas }: Props) {
  const hasOtrasFechas = otrasFechas && Object.keys(otrasFechas).filter(
    (k) => otrasFechas[k]?.valor,
  ).length > 0;

  if (!vigente && !hasOtrasFechas) {
    return (
      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.025] p-8 text-center">
        <Calendar className="w-7 h-7 mx-auto mb-3 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          Aún no se han extraído fechas tentativas para este expediente desde
          documentos del SIL.
        </p>
      </div>
    );
  }

  // ── Caso sin fecha de dictamen extraída: empty state explícito ────────────
  // Reportado 2026-05-20: el cliente veía "13 de mayo de 2030" prominente y
  // pensaba que era la fecha estimada de dictamen. NO lo es — es el deadline
  // legal cuatrenial. Cuando NO hay fecha_dictamen_estimada extraída, el
  // panel ahora dice CLARO "aún no se extrajo una fecha estimada" y muestra
  // la cuatrenal como info contextual pequeña al pie, no como dato principal.
  if (!vigente && hasOtrasFechas) {
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-5">
          <div className="flex items-start gap-3">
            <Calendar className="w-5 h-5 shrink-0 text-amber-600/70 dark:text-amber-300/70 mt-0.5" />
            <div className="flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300 mb-1">
                Sin fecha estimada de dictamen
              </div>
              <p className="text-[13px] text-[#0e1745]/70 dark:text-white/70 leading-snug">
                Aún no se ha detectado una fecha estimada de dictamen en los documentos
                del SIL para este expediente. El extractor revisa los dictámenes,
                informes técnicos y órdenes del día buscando menciones tipo
                <span className="font-medium"> "Fecha para dictaminar: ..."</span>.
              </p>
            </div>
          </div>
        </div>

        {/* Plazos legales — solo info, NO es la "fecha estimada" */}
        <div className="rounded-xl border border-[#0e1745]/[0.05] dark:border-white/[0.05] bg-white/40 dark:bg-white/[0.015] p-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#0e1745]/40 dark:text-white/40 mb-2">
            Plazos legales (informativo)
          </div>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(otrasFechas!).map(([campo, fecha]) => {
              if (!fecha?.valor) return null;
              const label =
                campo === 'fecha_cuatrienal'
                  ? 'Vence cuatrienio (4 años)'
                  : campo === 'vence_subcomision'
                    ? 'Vencimiento ordinario'
                    : campo.replace(/_/g, ' ');
              return (
                <div key={campo} className="space-y-0.5">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/55 dark:text-white/55">
                    {label}
                  </div>
                  <div className="text-[13px] font-medium text-[#0e1745]/80 dark:text-white/80">
                    {formatDate(fecha.valor)}
                  </div>
                  {fecha.texto && (
                    <div className="text-[10.5px] italic text-[#0e1745]/45 dark:text-white/45">
                      {fecha.texto}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Fecha estimada vigente — pedido 07 + 16g ── */}
      {vigente && (
        <div className="rounded-2xl border border-cl2-accent/20 bg-cl2-accent/[0.06] p-5">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-cl2-accent mb-1">
                {vigente.campo === 'vence_subcomision'
                  ? 'Vencimiento ordinario (60 días)'
                  : 'Fecha estimada de dictamen'}
              </div>
              <div className="text-2xl font-display font-light text-[#0e1745] dark:text-white">
                {formatDate(vigente.valor_fecha)}
              </div>
              {vigente.valor_texto_original && (
                <div className="text-[12.5px] italic text-[#0e1745]/60 dark:text-white/60 mt-1.5">
                  "{vigente.valor_texto_original}"
                </div>
              )}
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1.5">
              {vigente.visual_marker === 'bold' && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                  <strong>B</strong>
                  Énfasis en negrita
                </span>
              )}
            </div>
          </div>
          {vigente.fuente_documento_url && (
            <div className="flex items-center gap-1.5 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
              <FileText className="w-3 h-3" />
              <a
                href={vigente.fuente_documento_url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-cl2-accent underline-offset-2 hover:underline"
              >
                Fuente — Orden del día (pág. {vigente.fuente_pagina ?? '?'})
              </a>
            </div>
          )}
        </div>
      )}

      {/* ── Otras fechas relacionadas ── */}
      {otrasFechas && Object.keys(otrasFechas).length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {Object.entries(otrasFechas).map(([campo, fecha]) => {
            // Guard contra rows malformadas (valor null/empty) — el frontend
            // se rompía silenciosamente y mostraba "Invalid Date".
            if (!fecha?.valor) return null;
            const label =
              campo === 'fecha_cuatrienal'
                ? 'Vence cuatrienio (4 años)'
                : campo === 'vence_subcomision'
                  ? 'Vencimiento ordinario'
                  : campo.replace(/_/g, ' ');
            return (
              <div
                key={campo}
                className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/70 dark:bg-white/[0.025] p-4"
              >
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/55 dark:text-white/55 mb-1">
                  {label}
                </div>
                <div className="text-base font-medium text-[#0e1745] dark:text-white">
                  {formatDate(fecha.valor)}
                </div>
                {fecha.texto && (
                  <div className="text-[11px] italic text-[#0e1745]/50 dark:text-white/50 mt-1">
                    "{fecha.texto}"
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Historial de recálculos — pedido 16h ── */}
      {historial && historial.length > 0 && (
        <div className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/70 dark:bg-white/[0.025] p-5">
          <div className="flex items-center gap-2 mb-3">
            <History className="w-4 h-4 text-cl2-accent" />
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/65 dark:text-white/65">
              Historial de recálculos
            </div>
          </div>
          <div className="space-y-2.5">
            {historial.map((h, idx) => (
              <div key={idx} className="flex items-start gap-3 text-[12.5px]">
                <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-cl2-accent/60 mt-1.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-medium text-[#0e1745] dark:text-white">
                      {formatDate(h.valor_fecha)}
                    </span>
                    <span className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45 font-mono">
                      detectado {new Date(h.extracted_at).toLocaleDateString('es-CR')}
                    </span>
                  </div>
                  {h.superseded_reason && (
                    <div className="text-[11px] italic text-[#0e1745]/60 dark:text-white/60 mt-0.5">
                      razón: {h.superseded_reason}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
