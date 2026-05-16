/**
 * ListaDespachoBadge — Sprint 3 Track R.
 *
 * Badge ámbar que aparece junto al título del expediente cuando hay un item
 * activo (`status='a_despacho'`) en `lista_despacho_items`. Pedido del
 * cliente (Donovan 38:17): que el consultor vea "a despacho" sin tener que
 * ir al SIL a chequear.
 *
 * Visible en:
 *   - ExpedienteDashboardPage (hero card)
 *   - MatrizClientePage (columna "A despacho")
 *
 * Si `fecha_entrada` no se pasa, igual muestra el badge sin la fecha en el
 * tooltip — esto cubre el caso de matriz donde queremos mostrar el badge
 * pero no tenemos la fecha local sin un fetch extra.
 */
import { Briefcase } from 'lucide-react';

interface Props {
  /** ISO date (YYYY-MM-DD) del ingreso a despacho. Opcional. */
  fechaEntrada?: string;
  /** Variante compact = sólo ícono + label corta; default = label completa. */
  compact?: boolean;
}

function fmtFecha(iso: string): string {
  try {
    return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function ListaDespachoBadge({ fechaEntrada, compact = false }: Props) {
  const tooltip = fechaEntrada
    ? `A despacho desde ${fmtFecha(fechaEntrada)} — esperando decisión`
    : 'A despacho — esperando decisión';

  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className={
        compact
          ? 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
          : 'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30'
      }
    >
      <Briefcase className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} aria-hidden />
      A despacho
    </span>
  );
}
