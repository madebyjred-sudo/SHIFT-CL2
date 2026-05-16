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
  if (!vigente && !otrasFechas) {
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

  return (
    <div className="space-y-4">
      {/* ── Fecha estimada vigente — pedido 07 + 16g ── */}
      {vigente && (
        <div className="rounded-2xl border border-cl2-accent/20 bg-cl2-accent/[0.06] p-5">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-cl2-accent mb-1">
                Fecha estimada de dictamen
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
                  Extraído en NEGRITA
                </span>
              )}
              <span className="text-[10.5px] text-[#0e1745]/50 dark:text-white/50">
                confidence {(vigente.extraction_confidence * 100).toFixed(0)}%
              </span>
              <span className="text-[10.5px] text-[#0e1745]/50 dark:text-white/50 font-mono">
                método: {vigente.extraction_method}
              </span>
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
          {Object.entries(otrasFechas).map(([campo, { valor, texto }]) => (
            <div
              key={campo}
              className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/70 dark:bg-white/[0.025] p-4"
            >
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/55 dark:text-white/55 mb-1">
                {campo.replace(/_/g, ' ')}
              </div>
              <div className="text-base font-medium text-[#0e1745] dark:text-white">
                {formatDate(valor)}
              </div>
              <div className="text-[11px] italic text-[#0e1745]/50 dark:text-white/50 mt-1">
                "{texto}"
              </div>
            </div>
          ))}
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
