/**
 * ListaDespachoPanel — Sprint 3 Track R.
 *
 * Timeline del historial del expediente en la lista de despacho.
 * Cada row de `lista_despacho_items` es una entrada/salida.
 *
 * Pedido cliente (Donovan 38:17 sesión 14-may):
 *   "Que si vos le pidieras un proyecto puesto a despacho, aunque esté
 *    desactualizado en la Asamblea, que tenga la capacidad de hacerlo."
 *
 * Se muestra como tab `'despacho'` dentro de ExpedienteDashboardPage solo
 * si hay rows — si el expediente nunca entró a la lista de despacho, el
 * tab queda oculto (ver `hidden:` en sectionConfig).
 */
import { Briefcase, ExternalLink, FileText, Clock } from 'lucide-react';

export interface DespachoItem {
  id: string;
  fecha_entrada: string;
  fecha_salida: string | null;
  status:
    | 'a_despacho'
    | 'devuelto_a_comision'
    | 'remitido_plenario'
    | 'archivado'
    | 'caduca_cuatrienal';
  fuente_pdf_url: string | null;
  comentario_diputado: string | null;
  detectado_at?: string;
}

interface Props {
  historial: DespachoItem[];
}

const STATUS_LABEL: Record<DespachoItem['status'], string> = {
  a_despacho: 'A despacho — esperando decisión',
  devuelto_a_comision: 'Devuelto a comisión',
  remitido_plenario: 'Remitido a plenario',
  archivado: 'Archivado por la presidencia',
  caduca_cuatrienal: 'Caducó (4 años)',
};

const STATUS_COLOR: Record<DespachoItem['status'], string> = {
  a_despacho: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  devuelto_a_comision: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  remitido_plenario: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  archivado: 'bg-[#0e1745]/[0.08] text-[#0e1745]/60 dark:text-white/60 border-[#0e1745]/[0.12]',
  caduca_cuatrienal: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
};

function fmtFecha(iso: string): string {
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

function durationDays(fechaEntrada: string, fechaSalida: string | null): string {
  const end = fechaSalida ? new Date(`${fechaSalida.slice(0, 10)}T12:00:00`) : new Date();
  const start = new Date(`${fechaEntrada.slice(0, 10)}T12:00:00`);
  const days = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  if (days < 1) return 'hoy';
  if (days === 1) return '1 día';
  return `${days} días`;
}

export function ListaDespachoPanel({ historial }: Props) {
  if (!historial || historial.length === 0) {
    return (
      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.025] p-8 text-center">
        <Briefcase className="w-7 h-7 mx-auto mb-3 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          Este expediente nunca ha entrado a la lista de despacho.
        </p>
      </div>
    );
  }

  // Más reciente primero (asumimos el endpoint ya lo entrega en ese orden,
  // pero ordenamos por seguridad).
  const sorted = [...historial].sort(
    (a, b) => (b.fecha_entrada > a.fecha_entrada ? 1 : -1),
  );

  const activo = sorted.find((h) => h.status === 'a_despacho' && !h.fecha_salida);

  return (
    <div className="space-y-4">
      {activo && (
        <div className="rounded-2xl border-l-4 border-amber-500/70 bg-amber-500/[0.04] border-y border-r border-[#0e1745]/[0.06] dark:border-white/[0.06] p-5">
          <div className="flex items-center gap-2 mb-2">
            <Briefcase className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">
              Actualmente a despacho
            </div>
          </div>
          <div className="text-[18px] font-display font-medium text-[#0e1745] dark:text-white mb-1">
            Desde {fmtFecha(activo.fecha_entrada)}
          </div>
          <div className="text-[12.5px] text-[#0e1745]/70 dark:text-white/70 flex items-center gap-1.5">
            <Clock className="w-3 h-3" aria-hidden />
            {durationDays(activo.fecha_entrada, null)} esperando decisión.
          </div>
          {activo.comentario_diputado && (
            <div className="mt-3 rounded-md bg-[#0e1745]/[0.03] dark:bg-white/[0.03] px-3 py-2 text-[11.5px] text-[#0e1745]/65 dark:text-white/65 italic leading-relaxed">
              "{activo.comentario_diputado}"
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-white/[0.025] overflow-hidden">
        <div className="px-5 py-3 bg-[#0e1745]/[0.03] dark:bg-white/[0.03] border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/55 dark:text-white/55">
            Historial completo ({sorted.length})
          </div>
        </div>
        <div className="divide-y divide-[#0e1745]/[0.04] dark:divide-white/[0.04]">
          {sorted.map((item) => (
            <div key={item.id} className="px-5 py-4">
              <div className="flex items-center flex-wrap gap-2 mb-1.5">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-bold uppercase tracking-[0.06em] border ${STATUS_COLOR[item.status]}`}
                >
                  {STATUS_LABEL[item.status]}
                </span>
                {item.fuente_pdf_url && (
                  <a
                    href={item.fuente_pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-cl2-accent/80 hover:underline"
                  >
                    <FileText className="w-3 h-3" />
                    PDF decisión
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}
              </div>
              <div className="text-[12.5px] text-[#0e1745]/80 dark:text-white/80">
                <span className="font-medium">Entró:</span> {fmtFecha(item.fecha_entrada)}
                {item.fecha_salida && (
                  <>
                    <span className="text-[#0e1745]/30 dark:text-white/30 mx-2">·</span>
                    <span className="font-medium">Salió:</span> {fmtFecha(item.fecha_salida)}
                    <span className="text-[#0e1745]/30 dark:text-white/30 mx-2">·</span>
                    <span className="text-[#0e1745]/55 dark:text-white/55">
                      ({durationDays(item.fecha_entrada, item.fecha_salida)} en despacho)
                    </span>
                  </>
                )}
              </div>
              {item.comentario_diputado && (
                <div className="mt-2 text-[11.5px] text-[#0e1745]/60 dark:text-white/60 italic leading-relaxed">
                  "{item.comentario_diputado}"
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.025] px-4 py-3">
        <p className="text-[10.5px] text-[#0e1745]/55 dark:text-white/55 leading-relaxed">
          Fuente oficial: lista de despacho de la Asamblea Legislativa.
        </p>
      </div>
    </div>
  );
}
