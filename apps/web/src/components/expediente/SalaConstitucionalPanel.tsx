/**
 * SalaConstitucionalPanel — pedido 12a del cliente.
 *
 * Pedido 12a (Jred, refiriéndose al pedido directo):
 *   "Deberíamos revisar la Sala Constitucional y dentro de los docs
 *    verificar hasta el POR TANTO."
 *
 * Pedido 12b — heurística POR TANTO (Donovan 50:39):
 *   "Del POR TANTO, es tal cual como el resumen. Ahí viene ya los
 *    provicios de constitucionalidad o no tiene. Se puede ir aquí al
 *    POR TANTO y ver qué es lo que dicen los magistrados."
 *
 * El panel muestra las consultas a Sala Constitucional asociadas al
 * expediente, con la decisión inferida + extracto del POR TANTO ya
 * chunkeado por el legalDocChunker (Track G).
 */
import { Scale, ExternalLink } from 'lucide-react';

interface SalaResolucion {
  fecha_consulta?: string;
  fecha_resolucion?: string;
  decision?: string;            // 'con_lugar' | 'sin_lugar' | 'parcial' | 'inconstitucional' | ...
  por_tanto?: string;
  magistrados?: string;
  documento_url?: string;
}

interface Props {
  resoluciones?: SalaResolucion[];
}

function decisionLabel(d?: string) {
  switch (d) {
    case 'sin_lugar':
      return { text: 'Sin lugar', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' };
    case 'con_lugar':
      return { text: 'Con lugar', cls: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30' };
    case 'parcial':
      return { text: 'Parcialmente con lugar', cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' };
    case 'inconstitucional':
      return { text: 'INCONSTITUCIONAL', cls: 'bg-red-500/20 text-red-800 dark:text-red-200 border-red-500/40 font-bold' };
    case 'constitucional':
      return { text: 'Constitucional', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' };
    default:
      return { text: d ?? 'pendiente', cls: 'bg-gray-500/15 text-gray-700 dark:text-gray-300 border-gray-500/30' };
  }
}

export function SalaConstitucionalPanel({ resoluciones }: Props) {
  if (!resoluciones || resoluciones.length === 0) {
    return (
      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.025] p-8 text-center">
        <Scale className="w-7 h-7 mx-auto mb-3 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          Este expediente no tiene consultas registradas a la Sala Constitucional.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {resoluciones.map((r, idx) => {
        const dec = decisionLabel(r.decision);
        return (
          <div
            key={idx}
            className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-white/[0.025] p-5"
          >
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/55 dark:text-white/55 mb-0.5">
                  Sala Constitucional
                </div>
                <div className="text-[14.5px] font-medium text-[#0e1745] dark:text-white">
                  {r.fecha_resolucion
                    ? new Date(r.fecha_resolucion).toLocaleDateString('es-CR', { day: '2-digit', month: 'long', year: 'numeric' })
                    : 'En consulta'}
                </div>
                {r.fecha_consulta && (
                  <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-0.5">
                    Consultada {new Date(r.fecha_consulta).toLocaleDateString('es-CR')}
                  </div>
                )}
              </div>
              <span className={`shrink-0 inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold border ${dec.cls}`}>
                {dec.text}
              </span>
            </div>

            {r.por_tanto && (
              <div className="rounded-xl border-l-2 border-cl2-accent/60 bg-cl2-accent/[0.04] px-4 py-3 mt-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cl2-accent mb-1.5">
                  POR TANTO (extracto)
                </div>
                <p className="text-[13px] leading-relaxed italic text-[#0e1745]/80 dark:text-white/80">
                  {r.por_tanto}
                </p>
              </div>
            )}

            {r.magistrados && (
              <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-3">
                Magistrados: <span className="font-medium">{r.magistrados}</span>
              </div>
            )}

            {r.documento_url && (
              <a
                href={r.documento_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[11.5px] text-cl2-accent hover:text-cl2-accent-hover mt-3 font-medium"
              >
                <ExternalLink className="w-3 h-3" />
                Ver voto completo
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
