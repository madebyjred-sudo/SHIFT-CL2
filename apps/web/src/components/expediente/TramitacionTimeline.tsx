/**
 * TramitacionTimeline — línea de tiempo VERTICAL de los eventos procesales
 * de un expediente. Cada hito muestra: órgano legislativo + descripción +
 * fecha de inicio + fecha de término si la tiene.
 *
 * El cliente pidió (pedido 1): "poder ver un timeline que muestre el estado
 * actual, especialmente si ya es ley o no."
 * Layout: dot vertical conectado por una línea, con colores por órgano.
 */
import { type TramiteEvento } from '@/services/expedientesApi';
import { cn } from '@/lib/utils';
import { Calendar } from 'lucide-react';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function organoColor(organo: string): string {
  const u = organo.toUpperCase();
  if (u.includes('PLENARIO')) return 'bg-cl2-burgundy border-cl2-burgundy/40';
  if (u.includes('ARCHIVO')) return 'bg-[#0e1745]/40 border-[#0e1745]/20';
  if (u.includes('COMISIÓN') || u.includes('AREA') || u.includes('ÁREA'))
    return 'bg-cl2-accent border-cl2-accent/40';
  return 'bg-gray-400 border-gray-400/40';
}

function organoLabel(organo: string): string {
  // Shorten common long names for readability.
  return organo
    .replace(/COMISIÓN PERMANENTE ORDINARIA DE /i, 'Comisión ')
    .replace(/COMISIÓN PERMANENTE ESPECIAL DE /i, 'Comisión E. ')
    .replace(/PLENARIO/i, 'Plenario')
    .replace(/ARCHIVO/i, 'Archivo');
}

interface Props {
  tramite: TramiteEvento[];
}

export function TramitacionTimeline({ tramite }: Props) {
  if (tramite.length === 0) {
    return (
      <div className="py-8 text-center">
        <Calendar size={24} className="mx-auto mb-2 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          Sin eventos de tramitación registrados aún.
        </p>
        <p className="text-xs text-[#0e1745]/40 dark:text-white/40 mt-1">
          El scraper de detalle del SIL llenará este timeline cuando corra.
        </p>
      </div>
    );
  }

  return (
    <ol className="relative ml-2 space-y-0">
      {tramite.map((ev, idx) => {
        const isLast = idx === tramite.length - 1;
        const dotCls = organoColor(ev.organo_legislativo);

        return (
          <li key={ev.id} className="relative flex gap-4 pb-5">
            {/* Vertical connector line */}
            {!isLast && (
              <div className="absolute left-[7px] top-4 bottom-0 w-px bg-[#0e1745]/10 dark:bg-white/10" />
            )}

            {/* Dot */}
            <div
              className={cn(
                'relative shrink-0 mt-1.5 w-3.5 h-3.5 rounded-full border-2',
                dotCls,
              )}
            />

            {/* Content */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center flex-wrap gap-2 mb-0.5">
                <span className="inline-block px-1.5 py-0 rounded text-[9.5px] font-semibold uppercase tracking-[0.12em] bg-[#0e1745]/[0.06] dark:bg-white/[0.08] text-[#0e1745]/65 dark:text-white/65">
                  {organoLabel(ev.organo_legislativo)}
                </span>
                <span className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45 tabular-nums">
                  {fmtDate(ev.fecha_inicio)}
                  {ev.fecha_termino && ev.fecha_termino !== ev.fecha_inicio && (
                    <> — {fmtDate(ev.fecha_termino)}</>
                  )}
                </span>
              </div>
              <p className="text-[12.5px] text-[#0e1745]/80 dark:text-white/80 leading-snug">
                {ev.descripcion}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
