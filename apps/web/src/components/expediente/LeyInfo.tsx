/**
 * LeyInfo — bloque de información de la ley publicada.
 *
 * El cliente pidió (pedido 5): cuando el expediente fue aprobado, mostrar
 * toda la metadata del tab "Información de Ley": Gaceta, Alcance, fechas
 * clave, estado vigente/derogada, y la sección de Afectaciones (grafo de
 * qué leyes anteriores deroga/reforma/adiciona esta ley).
 *
 * Si hay fecha_devuelto_ejecutivo → hubo veto presidencial → mostrar sección
 * especial con el texto del veto y si fue reselado.
 */
import { type LeyInfo as LeyInfoData } from '@/services/expedientesApi';
import { Scale, BookOpen, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

interface DateRowProps {
  label: string;
  value: string | null | undefined;
  highlight?: boolean;
}

function DateRow({ label, value, highlight }: DateRowProps) {
  return (
    <div className={cn('flex items-center justify-between py-1.5 border-b border-[#0e1745]/[0.05] dark:border-white/[0.05] last:border-0', highlight && 'text-cl2-accent')}>
      <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55">{label}</span>
      <span className={cn('text-[12.5px] font-medium tabular-nums', highlight ? 'text-cl2-accent' : 'text-[#0e1745] dark:text-white')}>
        {fmtDate(value)}
      </span>
    </div>
  );
}

const TIPO_AFECTACION_LABEL: Record<string, string> = {
  deroga: 'Deroga',
  reforma: 'Reforma',
  adiciona: 'Adiciona',
  suspende: 'Suspende',
};

const TIPO_AFECTACION_COLOR: Record<string, string> = {
  deroga: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25',
  reforma: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25',
  adiciona: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
  suspende: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/25',
};

interface Props {
  ley: LeyInfoData;
}

export function LeyInfo({ ley }: Props) {
  const fueVetada = !!ley.fecha_devuelto_ejecutivo;
  const afectaciones = ley.sil_leyes_afectaciones ?? [];

  return (
    <div className="space-y-4">
      {/* Header with estado chip */}
      <div className="flex items-center gap-3 flex-wrap">
        {ley.numero_ley && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-cl2-burgundy/15 dark:bg-cl2-accent/20 text-cl2-burgundy dark:text-cl2-accent-soft border border-cl2-burgundy/20 dark:border-cl2-accent/25">
            <Scale size={11} />
            Ley N.° {ley.numero_ley}
          </span>
        )}
        <span
          className={cn(
            'inline-block px-2.5 py-1 rounded-full text-[11px] font-semibold border',
            ley.estado === 'Vigente'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25'
              : ley.estado === 'Derogada'
                ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25'
                : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25',
          )}
        >
          {ley.estado ?? 'Vigente'}
        </span>
        {fueVetada && (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-orange-500/10 text-orange-700 dark:text-orange-300 border border-orange-500/25">
            <AlertTriangle size={10} />
            Vetada por el Ejecutivo
          </span>
        )}
        {ley.reselo && (
          <span className="inline-block px-2.5 py-1 rounded-full text-[11px] font-semibold bg-purple-500/10 text-purple-700 dark:text-purple-300 border border-purple-500/25">
            Reselada
          </span>
        )}
      </div>

      {/* Datos de publicación */}
      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.02] px-4 py-2">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          <div>
            {ley.numero_gaceta && (
              <div className="flex items-center justify-between py-1.5 border-b border-[#0e1745]/[0.05] dark:border-white/[0.05]">
                <span className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55">Gaceta</span>
                <span className="text-[12.5px] font-medium text-[#0e1745] dark:text-white">
                  N.° {ley.numero_gaceta}{ley.alcance ? ` · Alcance ${ley.alcance}` : ''}
                </span>
              </div>
            )}
            <DateRow label="Aprobado 2/3 debate" value={ley.fecha_aprobacion_2_3} />
            <DateRow label="Emitido Asamblea" value={ley.fecha_emitido_asamblea} />
            <DateRow label="Sancionado Ejecutivo" value={ley.fecha_sancionado} />
          </div>
          <div>
            <DateRow label="Publicación" value={ley.fecha_publicacion} />
            <DateRow label="Rige desde" value={ley.fecha_rige} highlight />
            {fueVetada && (
              <DateRow label="Devuelto Ejecutivo" value={ley.fecha_devuelto_ejecutivo} />
            )}
          </div>
        </div>
      </div>

      {/* Veto */}
      {fueVetada && ley.veto_texto && (
        <div className="rounded-xl border border-orange-500/20 bg-orange-500/[0.04] dark:bg-orange-500/[0.06] px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={13} className="text-orange-600 dark:text-orange-400 shrink-0" />
            <span className="text-[11.5px] font-semibold text-orange-700 dark:text-orange-300">
              Texto del veto presidencial
            </span>
          </div>
          <p className="text-[12.5px] text-[#0e1745]/80 dark:text-white/80 leading-relaxed whitespace-pre-wrap">
            {ley.veto_texto}
          </p>
        </div>
      )}

      {/* Afectaciones */}
      {afectaciones.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <BookOpen size={13} className="text-[#0e1745]/55 dark:text-white/55" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[#0e1745]/50 dark:text-white/50">
              Afectaciones ({afectaciones.length})
            </span>
          </div>
          <ul className="space-y-2">
            {afectaciones.map((af) => (
              <li
                key={af.id}
                className="flex items-start gap-3 rounded-lg border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.02] px-3 py-2.5"
              >
                <span
                  className={cn(
                    'shrink-0 inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold border mt-0.5',
                    TIPO_AFECTACION_COLOR[af.tipo] ?? 'bg-gray-500/10 text-gray-600 border-gray-500/20',
                  )}
                >
                  {TIPO_AFECTACION_LABEL[af.tipo] ?? af.tipo}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="text-[12.5px] text-[#0e1745]/80 dark:text-white/80">
                    {af.ley_numero_afectada
                      ? `Ley N.° ${af.ley_numero_afectada}`
                      : 'Ley no indexada'}
                  </span>
                  {af.articulos && (
                    <span className="text-[11px] text-[#0e1745]/50 dark:text-white/50 ml-2">
                      ({af.articulos})
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
