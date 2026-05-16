/**
 * NovedadesPanel — pedido 16j del cliente.
 *
 * Pedido 16j (Carlos, 47:22–49:42):
 *   "Si en el otro lado [lista de mociones] ella ve que dice segundo día,
 *    eso es nuevo. Porque no está aquí, no está aquí en el resumen.
 *    Podría ser como un criterio para que él pueda decir de todos esos
 *    miles de proyectos que va a encontrar ahí, cuáles son los que se
 *    tiene que fijar."
 *
 * El panel muestra novedades detectadas por el cruce de fuentes:
 *   - Lista de mociones (SharePoint)
 *   - Pestaña Tramitación (eventos confirmados)
 * Cuando un movimiento aparece en una pero no en la otra → es nuevo.
 *
 * También muestra audiencias detectadas (pedido 16e).
 */
import { Zap, Mic } from 'lucide-react';

interface Novedad {
  fecha_deteccion: string;
  tipo: string;
  descripcion: string;
  algoritmo: string;
  confidence: number;
}

interface Audiencia {
  fecha: string;
  hora?: string;
  comision: string;
  asistente_nombre: string;
  asistente_cargo: string;
  asistente_organizacion: string;
  posicion_estimada?: string;
}

interface Props {
  novedades?: Novedad[];
  audiencias?: Audiencia[];
}

export function NovedadesPanel({ novedades, audiencias }: Props) {
  const hasNothing = (!novedades || novedades.length === 0) && (!audiencias || audiencias.length === 0);

  if (hasNothing) {
    return (
      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.025] p-8 text-center">
        <Zap className="w-7 h-7 mx-auto mb-3 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          No hay novedades pendientes para este expediente.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Audiencias inminentes — pedido 16e ── */}
      {audiencias && audiencias.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <Mic className="w-4 h-4 text-red-500" />
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-red-700 dark:text-red-300">
              Audiencias programadas — prioridad crítica
            </div>
          </div>
          {audiencias.map((a, idx) => (
            <div
              key={idx}
              className="rounded-2xl border-l-4 border-red-500/70 border-y border-r border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-red-500/[0.04] p-5 mb-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[15px] font-semibold text-[#0e1745] dark:text-white mb-1">
                    {a.asistente_nombre}
                  </div>
                  <div className="text-[12.5px] text-[#0e1745]/70 dark:text-white/70">
                    {a.asistente_cargo}
                    {a.asistente_organizacion && (
                      <span className="text-[#0e1745]/55 dark:text-white/55"> · {a.asistente_organizacion}</span>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[14.5px] font-mono font-semibold text-[#0e1745] dark:text-white">
                    {new Date(a.fecha).toLocaleDateString('es-CR', { day: '2-digit', month: 'short' })}
                  </div>
                  {a.hora && (
                    <div className="text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
                      {a.hora}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 mt-3">
                Comisión <span className="font-medium">{a.comision}</span>
                {a.posicion_estimada && (
                  <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300">
                    posición estimada: {a.posicion_estimada}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Novedades detectadas — pedido 16j ── */}
      {novedades && novedades.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <Zap className="w-4 h-4 text-amber-500" />
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-300">
              Novedades detectadas por algoritmo
            </div>
          </div>
          {novedades.map((n, idx) => (
            <div
              key={idx}
              className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-5 mb-3"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="font-mono text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                  {n.tipo}
                </div>
                <span className="shrink-0 text-[10px] font-mono text-[#0e1745]/55 dark:text-white/55">
                  confidence {(n.confidence * 100).toFixed(0)}%
                </span>
              </div>
              <p className="text-[13px] leading-relaxed text-[#0e1745]/80 dark:text-white/80 mb-3">
                {n.descripcion}
              </p>
              <details className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                <summary className="cursor-pointer hover:text-[#0e1745]/75 dark:hover:text-white/75">
                  Ver algoritmo aplicado
                </summary>
                <div className="mt-2 pl-3 border-l border-amber-500/20 font-mono text-[10.5px]">
                  {n.algoritmo}
                </div>
              </details>
              <div className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45 mt-3 font-mono">
                detectado: {new Date(n.fecha_deteccion).toLocaleString('es-CR')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
