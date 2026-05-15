/**
 * ProponentesList — lista de firmantes del expediente con orden de firma.
 *
 * El cliente pidió (pedido 2): "el primer lugar de la firma = quien puso
 * el proyecto (proponente principal). El resto son co-firmantes."
 *
 * El primer proponente (firma_orden=1) tiene estilo destacado con badge
 * "PROPONENTE PRINCIPAL". El resto se listan en orden.
 */
import { type Proponente } from '@/services/expedientesApi';
import { Users } from 'lucide-react';

function initials(nombre: string): string {
  // SIL format: "APELLIDO APELLIDO, NOMBRE" → "NA"
  const parts = nombre.split(',');
  const apellido = parts[0]?.trim() ?? '';
  const nombre_ = parts[1]?.trim() ?? '';
  const a = apellido.charAt(0);
  const n = nombre_.charAt(0);
  return `${a}${n}`.toUpperCase() || apellido.slice(0, 2).toUpperCase();
}

function formatNombre(nombre: string): string {
  // Convert "IZQUIERDO SANDÍ OSCAR" to "Oscar Izquierdo Sandí"
  // Handle both formats: "APELLIDO1 APELLIDO2, NOMBRE" and "APELLIDO1 APELLIDO2 NOMBRE"
  const withComma = nombre.includes(',');
  if (withComma) {
    const [apellidos, nombrePart] = nombre.split(',');
    const cap = (s: string) =>
      s
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    return `${cap(nombrePart ?? '')} ${cap(apellidos ?? '')}`.trim();
  }
  return nombre
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Props {
  proponentes: Proponente[];
}

export function ProponentesList({ proponentes }: Props) {
  if (proponentes.length === 0) {
    return (
      <div className="py-8 text-center">
        <Users size={24} className="mx-auto mb-2 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          Sin proponentes registrados aún.
        </p>
        <p className="text-xs text-[#0e1745]/40 dark:text-white/40 mt-1">
          El scraper de detalle del SIL llenará esta lista cuando corra.
        </p>
      </div>
    );
  }

  const principal = proponentes[0];
  const cofirmantes = proponentes.slice(1);

  return (
    <div className="space-y-3">
      {/* Proponente principal — estilo destacado */}
      {principal && (
        <div className="rounded-xl border border-cl2-burgundy/20 dark:border-cl2-accent/20 bg-cl2-burgundy/[0.04] dark:bg-cl2-accent/[0.06] px-4 py-3 flex items-center gap-3">
          <div className="shrink-0 w-9 h-9 rounded-full bg-cl2-burgundy/15 dark:bg-cl2-accent/20 flex items-center justify-center">
            <span className="text-[11px] font-bold text-cl2-burgundy dark:text-cl2-accent-soft">
              {initials(principal.diputado_nombre)}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[13px] font-semibold text-[#0e1745] dark:text-white truncate">
                {formatNombre(principal.diputado_nombre)}
              </span>
              <span className="inline-block px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-[0.14em] bg-cl2-burgundy/15 dark:bg-cl2-accent/20 text-cl2-burgundy dark:text-cl2-accent-soft border border-cl2-burgundy/20 dark:border-cl2-accent/25">
                Proponente principal
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[#0e1745]/50 dark:text-white/50">
              {principal.administracion && <span>{principal.administracion}</span>}
              {principal.fraccion && (
                <>
                  <span>·</span>
                  <span>{principal.fraccion}</span>
                </>
              )}
            </div>
          </div>
          <span className="shrink-0 text-[10px] font-mono text-[#0e1745]/35 dark:text-white/35">
            #1
          </span>
        </div>
      )}

      {/* Co-firmantes */}
      {cofirmantes.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/40 dark:text-white/40 mb-2 px-1">
            Co-firmantes ({cofirmantes.length})
          </p>
          <ul className="divide-y divide-[#0e1745]/[0.05] dark:divide-white/[0.05] rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.02] overflow-hidden">
            {cofirmantes.map((p) => (
              <li
                key={`${p.expediente_id}-${p.firma_orden}`}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <span className="shrink-0 text-[10px] font-mono tabular-nums text-[#0e1745]/35 dark:text-white/35 w-5 text-right">
                  #{p.firma_orden}
                </span>
                <div className="shrink-0 w-7 h-7 rounded-full bg-[#0e1745]/[0.06] dark:bg-white/[0.08] flex items-center justify-center">
                  <span className="text-[9px] font-semibold text-[#0e1745]/60 dark:text-white/60">
                    {initials(p.diputado_nombre)}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-[12.5px] text-[#0e1745]/85 dark:text-white/85">
                    {formatNombre(p.diputado_nombre)}
                  </span>
                  {(p.administracion || p.fraccion) && (
                    <span className="ml-2 text-[10.5px] text-[#0e1745]/45 dark:text-white/45">
                      {[p.administracion, p.fraccion].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
