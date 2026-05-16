/**
 * ActasComisionPanel — pedido 08 del cliente.
 *
 * Pedido 08 (Jred, 32:22):
 *   "Hay una sección de 'consulta al sil' y dentro de este hay uno que se
 *    llama consulta de actas-comisiones, ahí nos podemos ayudar para
 *    alimentar de transcripciones con QUIEN DIJO QUE."
 *
 * Cada acta muestra los speakers identificados con regex sobre el texto
 * del acta oficial. El timestamp es aproximado (basado en posición en
 * el documento). Cada intervención es citable + linkeable al PDF original.
 */
import { MessageCircle, ExternalLink, FileText } from 'lucide-react';

interface SpeakerIntervention {
  role: string;
  nombre: string;
  timestamp_aprox: string;
  texto: string;
}

interface Acta {
  acta_numero: number;
  comision: string;
  fecha_sesion: string;
  url: string;
  speakers: SpeakerIntervention[];
}

interface Props {
  actas?: Acta[];
}

function roleColor(role: string) {
  const r = role.toLowerCase();
  if (r.includes('president')) return 'bg-cl2-accent/15 text-cl2-accent border-cl2-accent/30';
  if (r.includes('vicepresident')) return 'bg-cl2-accent/10 text-cl2-accent-hover border-cl2-accent/20';
  return 'bg-[#0e1745]/8 text-[#0e1745]/70 dark:bg-white/8 dark:text-white/70 border-[#0e1745]/15 dark:border-white/15';
}

export function ActasComisionPanel({ actas }: Props) {
  if (!actas || actas.length === 0) {
    return (
      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.025] p-8 text-center">
        <MessageCircle className="w-7 h-7 mx-auto mb-3 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          No hay actas indexadas con este expediente todavía.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {actas.map((acta, idx) => (
        <div
          key={idx}
          className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-white/[0.025]"
        >
          {/* Header acta */}
          <div className="px-5 py-3.5 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06] flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/55 dark:text-white/55 mb-0.5">
                Acta de sesión
              </div>
              <div className="font-medium text-[14.5px] text-[#0e1745] dark:text-white">
                Comisión {acta.comision} · Sesión #{acta.acta_numero}
              </div>
              <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-0.5">
                {new Date(acta.fecha_sesion).toLocaleDateString('es-CR', {
                  weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
                })}
              </div>
            </div>
            <a
              href={acta.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11.5px] font-medium bg-[#0e1745]/5 hover:bg-[#0e1745]/10 dark:bg-white/5 dark:hover:bg-white/10 text-[#0e1745]/75 dark:text-white/75 transition-colors"
            >
              <FileText className="w-3 h-3" />
              Acta oficial PDF
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </div>

          {/* Speakers — "QUIEN DIJO QUE" */}
          <div className="divide-y divide-[#0e1745]/[0.04] dark:divide-white/[0.04]">
            {acta.speakers.map((sp, i) => (
              <div key={i} className="px-5 py-3.5">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={`inline-flex px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-[0.06em] border ${roleColor(sp.role)}`}>
                    {sp.role}
                  </span>
                  <span className="text-[13px] font-medium text-[#0e1745] dark:text-white">
                    {sp.nombre}
                  </span>
                  <span className="text-[10px] font-mono text-[#0e1745]/40 dark:text-white/40 ml-auto">
                    {sp.timestamp_aprox}
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-[#0e1745]/80 dark:text-white/80">
                  {sp.texto}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
