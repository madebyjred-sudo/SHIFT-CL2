/**
 * ConsultasEntidades — tabla de consultas a entidades externas.
 *
 * El cliente pidió (pedido 4): el SIL tiene una pestaña Consultas donde
 * los expedientes consultan formalmente a entidades (BCCR, Procuraduría,
 * ministerios, Contraloría, gremios) y esas entidades responden con PDFs.
 * Es "la inteligencia previa al voto" — munición de los consultores.
 *
 * Muestra: entidad / fecha consulta / fecha respuesta / chip de posición / link PDF.
 * Si tipo_respuesta es null → "Pendiente de respuesta".
 */
import { type Consulta } from '@/services/expedientesApi';
import { ExternalLink, FileText, Clock, Building2 } from 'lucide-react';
import { cn } from '@/lib/utils';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
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

interface TipoChipProps {
  tipo: Consulta['tipo_respuesta'];
}

function TipoChip({ tipo }: TipoChipProps) {
  if (!tipo) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#0e1745]/[0.06] dark:bg-white/[0.08] text-[#0e1745]/55 dark:text-white/55 border border-[#0e1745]/[0.08] dark:border-white/[0.10]">
        <Clock size={9} />
        Pendiente
      </span>
    );
  }

  const map: Record<
    NonNullable<Consulta['tipo_respuesta']>,
    { label: string; cls: string }
  > = {
    a_favor: {
      label: 'A favor',
      cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
    },
    en_contra: {
      label: 'En contra',
      cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25',
    },
    condicional: {
      label: 'Condicional',
      cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25',
    },
    sin_observaciones: {
      label: 'Sin obs.',
      cls: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20',
    },
  };

  const { label, cls } = map[tipo];
  return (
    <span
      className={cn(
        'inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border',
        cls,
      )}
    >
      {label}
    </span>
  );
}

interface Props {
  consultas: Consulta[];
}

export function ConsultasEntidades({ consultas }: Props) {
  if (consultas.length === 0) {
    return (
      <div className="py-8 text-center">
        <Building2 size={24} className="mx-auto mb-2 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          Sin consultas a entidades registradas aún.
        </p>
        <p className="text-xs text-[#0e1745]/40 dark:text-white/40 mt-1">
          El scraper de detalle del SIL llenará esta sección cuando corra.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] overflow-hidden">
      {/* Table header */}
      <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 px-4 py-2 bg-[#0e1745]/[0.03] dark:bg-white/[0.03] border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#0e1745]/40 dark:text-white/40">
          Entidad
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#0e1745]/40 dark:text-white/40 text-right">
          Consultada
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#0e1745]/40 dark:text-white/40 text-right">
          Respuesta
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#0e1745]/40 dark:text-white/40 text-center">
          Posición
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#0e1745]/40 dark:text-white/40 text-right">
          PDF
        </span>
      </div>

      <ul className="divide-y divide-[#0e1745]/[0.05] dark:divide-white/[0.05]">
        {consultas.map((c) => (
          <li key={c.id} className="px-4 py-3">
            {/* Mobile layout */}
            <div className="sm:hidden space-y-1">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[13px] font-medium text-[#0e1745] dark:text-white leading-snug">
                  {c.entidad_consultada}
                </span>
                <TipoChip tipo={c.tipo_respuesta} />
              </div>
              <div className="flex items-center gap-3 text-[11px] text-[#0e1745]/50 dark:text-white/50">
                <span>Cons. {fmtDate(c.fecha_consulta)}</span>
                {c.fecha_respuesta && <span>Resp. {fmtDate(c.fecha_respuesta)}</span>}
                {c.documento_url && (
                  <a
                    href={c.documento_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-cl2-accent hover:underline"
                  >
                    <FileText size={10} /> PDF
                  </a>
                )}
              </div>
              {c.resumen_por_tanto && (
                <p className="text-[11.5px] text-[#0e1745]/65 dark:text-white/65 italic border-l-2 border-cl2-accent/30 pl-2 mt-1">
                  {c.resumen_por_tanto}
                </p>
              )}
            </div>

            {/* Desktop layout */}
            <div className="hidden sm:grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-4 items-start">
              <div className="min-w-0">
                <span className="text-[13px] font-medium text-[#0e1745] dark:text-white leading-snug block truncate">
                  {c.entidad_consultada}
                </span>
                {c.resumen_por_tanto && (
                  <p className="text-[11px] text-[#0e1745]/55 dark:text-white/55 italic mt-0.5 line-clamp-2 border-l-2 border-cl2-accent/30 pl-2">
                    {c.resumen_por_tanto}
                  </p>
                )}
              </div>
              <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55 tabular-nums whitespace-nowrap text-right">
                {fmtDate(c.fecha_consulta)}
              </span>
              <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55 tabular-nums whitespace-nowrap text-right">
                {fmtDate(c.fecha_respuesta)}
              </span>
              <div className="flex justify-center">
                <TipoChip tipo={c.tipo_respuesta} />
              </div>
              <div className="flex justify-end">
                {c.documento_url ? (
                  <a
                    href={c.documento_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-cl2-accent hover:underline"
                    title="Ver PDF de la respuesta"
                  >
                    <ExternalLink size={11} />
                    Ver
                  </a>
                ) : (
                  <span className="text-[11px] text-[#0e1745]/30 dark:text-white/30">—</span>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
