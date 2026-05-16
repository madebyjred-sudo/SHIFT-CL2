/**
 * MatrizClientePage — pedido 16a del cliente.
 *
 * Pedido 16a (Donovan, 18:14):
 *   "Nos ayuda mucho a la hora de actualizar matrices, comunicarle al
 *    cliente qué etapa está, en qué procesos está."
 *
 * Esta es la matriz auto-generada por la herramienta: el consultor CL2
 * abre esta página, ve TODOS los expedientes que vigila para todos sus
 * clientes, con estado actual, próximas fechas, alertas activas, etc.
 *
 * Reemplaza el Excel manual que el consultor mantenía a mano.
 *
 * Route: /matriz-cliente
 */
import { useEffect, useState } from 'react';
import { Download, RefreshCw, FileSpreadsheet } from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { fetchExpedienteFull } from '@/services/expedientesApi';
import { supabase } from '@/lib/supabase';

interface MatrizRow {
  expediente_id: string;
  titulo: string;
  estado: string;
  comision: string;
  proponente_principal: string;
  fecha_dictamen_estimada?: string;
  alertas_criticas: number;
  alertas_altas: number;
  audiencia_proxima?: string;
  decreto_vigente?: string;
}

export function MatrizClientePage() {
  const [rows, setRows] = useState<MatrizRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generadoAt, setGeneradoAt] = useState(new Date().toISOString());

  async function load() {
    setLoading(true);
    // Pull from centinela_watchlist + cross-join with sil_expedientes
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data: watchlist } = await supabase
      .from('centinela_watchlist')
      .select('entity_type, entity_id, metadata')
      .eq('user_id', user.id)
      .eq('entity_type', 'expediente');

    const numeros = (watchlist ?? []).map((w) => w.entity_id);
    if (numeros.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }

    const matriz: MatrizRow[] = [];
    for (const numero of numeros) {
      try {
        const full = await fetchExpedienteFull(numero);
        const meta = (full.general.metadata ?? {}) as any;
        const proponentePrincipal = full.proponentes.find((p) => p.firma_orden === 1);
        const fechaVigente = meta?.fechas_extraidas?.vigente?.valor_fecha;
        const audienciaProxima = meta?.audiencias?.[0]?.fecha;
        const decretoConvocado = meta?.decretos_convocando?.[0]?.numero;

        // Count alertas via dedicated query
        const { data: alerts } = await supabase
          .from('centinela_alerts_v2')
          .select('priority')
          .eq('user_id', user.id);

        const alertsForExp = (alerts ?? []).filter((a: any) => a.priority);
        const criticas = alertsForExp.filter((a: any) => a.priority === 'critical').length;
        const altas = alertsForExp.filter((a: any) => a.priority === 'high').length;

        matriz.push({
          expediente_id: numero,
          titulo: full.general.titulo ?? '(sin título)',
          estado: full.general.estado ?? '?',
          comision: full.general.comision ?? '?',
          proponente_principal: proponentePrincipal?.diputado_nombre ?? '?',
          fecha_dictamen_estimada: fechaVigente,
          alertas_criticas: criticas,
          alertas_altas: altas,
          audiencia_proxima: audienciaProxima,
          decreto_vigente: decretoConvocado,
        });
      } catch (e) {
        // skip
      }
    }
    setRows(matriz);
    setGeneradoAt(new Date().toISOString());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  function exportCsv() {
    const headers = [
      'Expediente', 'Título', 'Estado', 'Comisión', 'Proponente principal',
      'Dictamen estimado', 'Alertas críticas', 'Alertas altas',
      'Audiencia próxima', 'Decreto vigente',
    ];
    const csv = [
      headers.join('\t'),
      ...rows.map((r) => [
        r.expediente_id, `"${r.titulo.replace(/"/g, '""')}"`, r.estado, r.comision,
        r.proponente_principal, r.fecha_dictamen_estimada ?? '',
        r.alertas_criticas, r.alertas_altas,
        r.audiencia_proxima ?? '', r.decreto_vigente ?? '',
      ].join('\t')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `matriz-cl2-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />
      <TopDock />

      <div className="relative z-10 w-full max-w-[1200px] mx-auto flex flex-col flex-1 px-4 sm:px-5 md:px-6">
        {/* Hero */}
        <div className="py-8">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-cl2-accent mb-1.5">
                Matriz por cliente
              </div>
              <h1 className="font-display font-light text-[40px] leading-[1.05] tracking-[-0.02em] text-[#0e1745] dark:text-white">
                Auto-actualizada · citable
              </h1>
              <p className="mt-3 text-[14px] text-[#0e1745]/65 dark:text-white/65 max-w-[640px] leading-relaxed">
                Estado vivo de los expedientes que vigilás. Reemplaza el Excel manual.
                Cada fila se actualiza con el crawler único cada 30 minutos.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => load()}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12.5px] font-medium bg-white dark:bg-white/[0.06] border border-[#0e1745]/[0.08] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10] transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Actualizar
              </button>
              <button
                onClick={exportCsv}
                disabled={rows.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[12.5px] font-medium bg-cl2-accent text-white hover:bg-cl2-accent-hover transition-colors disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" />
                Exportar CSV
              </button>
            </div>
          </div>
          <div className="text-[11px] font-mono text-[#0e1745]/45 dark:text-white/45 mt-2">
            Generado: {new Date(generadoAt).toLocaleString('es-CR')}
          </div>
        </div>

        {/* Tabla */}
        {loading ? (
          <div className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-white/[0.025] p-8 text-center">
            <p className="text-sm text-[#0e1745]/55 dark:text-white/55">Cargando matriz...</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-white/[0.025] p-12 text-center">
            <FileSpreadsheet className="w-9 h-9 mx-auto mb-3 text-[#0e1745]/30 dark:text-white/30" />
            <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
              Aún no vigilás ningún expediente. Agregalo desde Centinela.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-white/[0.025] overflow-x-auto mb-8">
            <table className="w-full text-[12.5px]">
              <thead className="bg-[#0e1745]/[0.04] dark:bg-white/[0.04]">
                <tr className="text-left">
                  <th className="px-4 py-3 font-semibold text-[10.5px] uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Exp</th>
                  <th className="px-4 py-3 font-semibold text-[10.5px] uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Título</th>
                  <th className="px-4 py-3 font-semibold text-[10.5px] uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Estado</th>
                  <th className="px-4 py-3 font-semibold text-[10.5px] uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Comisión</th>
                  <th className="px-4 py-3 font-semibold text-[10.5px] uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Proponente</th>
                  <th className="px-4 py-3 font-semibold text-[10.5px] uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Dictamen estim.</th>
                  <th className="px-4 py-3 font-semibold text-[10.5px] uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Alertas</th>
                  <th className="px-4 py-3 font-semibold text-[10.5px] uppercase tracking-[0.1em] text-[#0e1745]/60 dark:text-white/60">Audiencia próx.</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#0e1745]/[0.04] dark:divide-white/[0.04]">
                {rows.map((r) => (
                  <tr key={r.expediente_id} className="hover:bg-[#0e1745]/[0.02] dark:hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-mono font-medium text-cl2-accent">{r.expediente_id}</td>
                    <td className="px-4 py-3 max-w-[280px]"><div className="truncate">{r.titulo}</div></td>
                    <td className="px-4 py-3"><span className="inline-block px-2 py-0.5 rounded text-[10px] font-semibold bg-[#0e1745]/8 dark:bg-white/8">{r.estado}</span></td>
                    <td className="px-4 py-3 text-[11.5px]">{r.comision}</td>
                    <td className="px-4 py-3 text-[11.5px]">{r.proponente_principal}</td>
                    <td className="px-4 py-3 font-mono text-[11.5px]">{r.fecha_dictamen_estimada ?? '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {r.alertas_criticas > 0 && (
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold bg-red-500 text-white">{r.alertas_criticas}</span>
                        )}
                        {r.alertas_altas > 0 && (
                          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold bg-amber-500 text-white">{r.alertas_altas}</span>
                        )}
                        {r.alertas_criticas === 0 && r.alertas_altas === 0 && <span className="text-[#0e1745]/30 dark:text-white/30">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11.5px]">{r.audiencia_proxima ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
