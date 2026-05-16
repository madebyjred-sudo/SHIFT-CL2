/**
 * ExpedienteDashboardPage — biblioteca de expediente unificada (Track B, Sprint 1).
 *
 * Una sola página que reemplaza los 12 tabs del SIL. El cliente pidió
 * (reunión 2026-05-14, pedido 3):
 *   "Deberíamos hacer al menos en un mismo tab la mayoría de esta
 *    información, poder mostrarla de una forma mucho más dinámica que el SIL."
 *
 * Route: /expediente/:numero (con punto, ej. /expediente/23.511)
 *
 * Layout:
 *   ┌──────────────────────────────────────────────────┐
 *   │ Header: nº + título + estado chip + "es ley" badge│
 *   │ Subtítulo: fecha presentación · proponente principal│
 *   ├──────────────────────────────────────────────────┤
 *   │ Secciones (navegación horizontal tabs):          │
 *   │   Tramitación (timeline vertical)                │
 *   │   Proponentes (orden de firma)                   │
 *   │   Consultas (entidades + PDFs)                   │
 *   │   Información de Ley (si aplica)                 │
 *   │   Documentos (sustitutivos, dictámenes)          │
 *   └──────────────────────────────────────────────────┘
 *
 * Datos: endpoint GET /api/expedientes/:numero/full — todos los datos
 * en un solo round-trip. Empty states elegantes si aún no hay datos
 * (scraper de detalle del SIL corre en Sprint 2).
 */
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  ArrowLeft,
  ExternalLink,
  Gavel,
  Scale,
  Clock,
  Users,
  Building2,
  FileText,
  ScrollText,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { navigate } from '@/lib/router';
import {
  fetchExpedienteFull,
  type ExpedienteFullData,
} from '@/services/expedientesApi';
import { TramitacionTimeline } from '@/components/expediente/TramitacionTimeline';
import { ProponentesList } from '@/components/expediente/ProponentesList';
import { ConsultasEntidades } from '@/components/expediente/ConsultasEntidades';
import { LeyInfo } from '@/components/expediente/LeyInfo';
import { DocumentosExpediente } from '@/components/expediente/DocumentosExpediente';
import { FechasExtraidasPanel } from '@/components/expediente/FechasExtraidasPanel';
import { SalaConstitucionalPanel } from '@/components/expediente/SalaConstitucionalPanel';
import { ActasComisionPanel } from '@/components/expediente/ActasComisionPanel';
import { NovedadesPanel } from '@/components/expediente/NovedadesPanel';
import { OrdenDiaPanel } from '@/components/expediente/OrdenDiaPanel';
import { ListaDespachoPanel } from '@/components/expediente/ListaDespachoPanel';
import { ListaDespachoBadge } from '@/components/expediente/ListaDespachoBadge';
import { Calendar, MessageCircle, Zap, Briefcase } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  numero: string; // canonical SIL format "23.511"
}

type SectionId =
  | 'tramitacion'
  | 'proponentes'
  | 'consultas'
  | 'fechas'      // pedidos 07, 16g, 16h
  | 'sala'        // pedido 12a
  | 'actas'       // pedido 08
  | 'novedades'   // pedidos 16e, 16j
  | 'orden_dia'   // pedido 16c
  | 'despacho'    // Sprint 3 Track R — Donovan 38:17
  | 'ley'
  | 'documentos';

interface SectionConfig {
  id: SectionId;
  label: string;
  icon: React.ReactNode;
  count?: number;
  hidden?: boolean;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
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

function estadoChipCls(estado: string | null | undefined): string {
  if (!estado) return 'bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/20';
  const u = estado.toLowerCase();
  if (u.includes('ley') || u.includes('publicad') || u.includes('vigente'))
    return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25';
  if (u.includes('archivado') || u.includes('archivo'))
    return 'bg-[#0e1745]/[0.08] text-[#0e1745]/60 dark:text-white/60 border-[#0e1745]/[0.12]';
  if (u.includes('estudio') || u.includes('trámite') || u.includes('tramite'))
    return 'bg-cl2-accent/10 text-cl2-accent dark:text-cl2-accent-soft border-cl2-accent/25';
  return 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25';
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-24 rounded-2xl bg-[#0e1745]/[0.04] dark:bg-white/[0.04]" />
      <div className="h-10 rounded-xl bg-[#0e1745]/[0.04] dark:bg-white/[0.04]" />
      <div className="h-64 rounded-2xl bg-[#0e1745]/[0.04] dark:bg-white/[0.04]" />
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function ExpedienteDashboardPage({ numero }: Props) {
  const [data, setData] = useState<ExpedienteFullData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<SectionId>('tramitacion');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchExpedienteFull(numero)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [numero]);

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-mesh text-white">
        <div className="text-center max-w-md px-6">
          <p className="text-lg mb-2">No se pudo cargar el expediente</p>
          <p className="text-sm text-white/60 mb-1">Exp. {numero}</p>
          <p className="text-xs text-white/50 mb-4">{error}</p>
          <button onClick={() => navigate('/sil')} className="text-sm underline">
            Volver al catálogo
          </button>
        </div>
      </div>
    );
  }

  const general = data?.general;
  const esLey = !!data?.ley;

  // Sprint 2 Track H — los datos del Sprint v3 ahora vienen como keys top-level
  // del endpoint /full. El BFF hace el merge tabla dedicada + fallback metadata,
  // así que el frontend NO necesita conocer el origen. Mantengo el fallback a
  // metadata por defensa (si en algún momento el BFF degrada).
  const meta = (general?.metadata ?? {}) as any;
  const fechasShape = data?.fechas_extraidas ?? meta?.fechas_extraidas ?? null;
  const fechasVigente = fechasShape?.vigente;
  const fechasHistorial = fechasShape?.historial ?? meta?.fechas_extraidas?.historial;
  const fechasOtras = fechasShape?.otras_fechas ?? meta?.fechas_extraidas?.otras_fechas;
  const consultasSala = data?.consultas_sala_constitucional ?? meta?.consultas_sala_constitucional ?? [];
  const audiencias = data?.audiencias ?? meta?.audiencias ?? [];
  const actasComision = data?.actas_comision ?? meta?.actas_comision ?? [];
  const novedadesAlgoritmo = data?.novedades_detectadas ?? meta?.novedades_detectadas ?? [];
  const ordenDiaApariciones = data?.orden_dia_apariciones ?? meta?.orden_dia_apariciones ?? [];
  // Sprint 3 Track R
  const despachoHistorial = data?.despacho_historial ?? [];
  const despachoActivo = despachoHistorial.find(
    (d) => d.status === 'a_despacho' && !d.fecha_salida,
  );

  const tieneFechas = !!fechasVigente || !!fechasOtras;
  const tieneSala = consultasSala.length > 0;
  const tieneActas = actasComision.length > 0;
  const tieneNovedades = audiencias.length > 0 || novedadesAlgoritmo.length > 0;
  const tieneOrdenDia = ordenDiaApariciones.length > 0;
  const tieneDespacho = despachoHistorial.length > 0;

  const allSections: SectionConfig[] = [
    {
      id: 'tramitacion' as SectionId,
      label: 'Tramitación',
      icon: <Clock size={13} />,
      count: data?.tramite.length,
    },
    {
      id: 'proponentes' as SectionId,
      label: 'Proponentes',
      icon: <Users size={13} />,
      count: data?.proponentes.length,
    },
    {
      id: 'fechas' as SectionId,
      label: 'Fechas estimadas',
      icon: <Calendar size={13} />,
      hidden: !!data && !tieneFechas,
    },
    {
      id: 'novedades' as SectionId,
      label: 'Novedades',
      icon: <Zap size={13} />,
      count: audiencias.length + novedadesAlgoritmo.length,
      hidden: !!data && !tieneNovedades,
    },
    {
      id: 'orden_dia' as SectionId,
      label: 'Próx. sesión',
      icon: <Calendar size={13} />,
      count: ordenDiaApariciones.length,
      hidden: !!data && !tieneOrdenDia,
    },
    {
      id: 'despacho' as SectionId,
      label: 'A despacho',
      icon: <Briefcase size={13} />,
      count: despachoHistorial.length,
      hidden: !!data && !tieneDespacho,
    },
    {
      id: 'consultas' as SectionId,
      label: 'Consultas',
      icon: <Building2 size={13} />,
      count: data?.consultas.length,
    },
    {
      id: 'sala' as SectionId,
      label: 'Sala IV',
      icon: <Scale size={13} />,
      count: consultasSala.length,
      hidden: !!data && !tieneSala,
    },
    {
      id: 'actas' as SectionId,
      label: 'Actas',
      icon: <MessageCircle size={13} />,
      count: actasComision.length,
      hidden: !!data && !tieneActas,
    },
    {
      id: 'ley' as SectionId,
      label: 'Ley',
      icon: <Scale size={13} />,
      hidden: !esLey && !!data, // hide if loaded and not a ley
    },
    {
      id: 'documentos' as SectionId,
      label: 'Documentos',
      icon: <FileText size={13} />,
      count: data?.documentos.length,
    },
  ];
  const sections = allSections.filter((s) => !s.hidden);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-mesh text-gray-900 dark:text-white font-sans relative transition-colors duration-500">
      <div className="pointer-events-none absolute inset-0 bg-pixel-dots opacity-60 z-0" />

      <TopDock />

      <div className="relative z-10 w-full max-w-[1200px] mx-auto flex flex-col flex-1 px-4 sm:px-5 md:px-6">

        {/* Sub-header: back nav + expediente identity */}
        <div className="py-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => (window.history.length > 1 ? window.history.back() : navigate('/sil'))}
            className="shrink-0 p-2 -ml-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Volver"
          >
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-cl2-accent/15 text-cl2-accent border border-cl2-accent/25">
            <Gavel className="w-2.5 h-2.5" />
            Expediente
          </span>
          <span className="text-sm font-mono tabular-nums text-[#0e1745]/70 dark:text-white/75">
            Exp. {numero}
          </span>
        </div>

        {/* Hero card — header del expediente */}
        <motion.div
          initial={{ y: 12, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/90 dark:bg-white/[0.025] backdrop-blur-sm shadow-[0_4px_24px_rgba(14,23,69,0.06)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.20)] px-5 py-4 mb-4"
        >
          {!data ? (
            <div className="space-y-2.5 animate-pulse">
              <div className="h-5 rounded bg-[#0e1745]/[0.06] dark:bg-white/[0.06] w-3/4" />
              <div className="h-3.5 rounded bg-[#0e1745]/[0.04] dark:bg-white/[0.04] w-1/2" />
            </div>
          ) : (
            <>
              {/* Estado + ley badge */}
              <div className="flex items-center flex-wrap gap-2 mb-2">
                {general?.estado && (
                  <span
                    className={cn(
                      'inline-block px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold border',
                      estadoChipCls(general.estado),
                    )}
                  >
                    {general.estado}
                  </span>
                )}
                {esLey && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                    <Scale size={10} />
                    Es Ley
                    {data.ley?.numero_ley && ` N.° ${data.ley.numero_ley}`}
                  </span>
                )}
                {despachoActivo && (
                  <ListaDespachoBadge fechaEntrada={despachoActivo.fecha_entrada} />
                )}
                {general?.tipo && (
                  <span className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45">
                    {general.tipo}
                  </span>
                )}
              </div>

              {/* Título */}
              <h1 className="font-display font-light text-[20px] sm:text-[22px] leading-[1.15] tracking-tight text-[#0e1745] dark:text-white mb-2">
                {general?.titulo ?? '(Sin título)'}
              </h1>

              {/* Subtítulo: fecha + proponente + SIL link */}
              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-[#0e1745]/55 dark:text-white/55">
                {general?.fecha_presentacion && (
                  <span>
                    <span className="font-medium">Presentado</span>{' '}
                    {fmtDate(general.fecha_presentacion)}
                  </span>
                )}
                {data.proponentes[0] && (
                  <>
                    <span className="text-[#0e1745]/25 dark:text-white/25">·</span>
                    <span>
                      <span className="font-medium">Prop.</span>{' '}
                      {data.proponentes[0].diputado_nombre}
                    </span>
                  </>
                )}
                {general?.comision && (
                  <>
                    <span className="text-[#0e1745]/25 dark:text-white/25">·</span>
                    <span>{general.comision}</span>
                  </>
                )}
                <span className="flex-1" />
                {general?.url_detalle && (
                  <a
                    href={general.url_detalle}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-[#0e1745]/45 dark:text-white/45 hover:text-cl2-accent transition-colors"
                  >
                    SIL oficial <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </>
          )}
        </motion.div>

        {/* Section tabs */}
        <div className="flex items-center gap-1 overflow-x-auto pb-1 scrollbar-none mb-4">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              className={cn(
                'inline-flex items-center gap-1.5 shrink-0 px-3.5 py-2 rounded-full text-[12px] font-medium transition-all whitespace-nowrap',
                activeSection === s.id
                  ? 'bg-cl2-burgundy dark:bg-cl2-accent text-white dark:text-[#0e1745] shadow-sm'
                  : 'bg-white dark:bg-white/[0.06] text-[#0e1745]/70 dark:text-white/70 border border-[#0e1745]/[0.08] dark:border-white/[0.10] hover:bg-[#0e1745]/[0.04] dark:hover:bg-white/[0.10]',
              )}
            >
              {s.icon}
              {s.label}
              {s.count != null && s.count > 0 && (
                <span
                  className={cn(
                    'inline-block min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold text-center leading-4',
                    activeSection === s.id
                      ? 'bg-white/30 text-white dark:bg-black/25 dark:text-[#0e1745]'
                      : 'bg-[#0e1745]/[0.08] dark:bg-white/[0.12] text-[#0e1745]/65 dark:text-white/65',
                  )}
                >
                  {s.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Section content */}
        <div className="flex-1 mb-8">
          {!data ? (
            <DashboardSkeleton />
          ) : (
            <motion.div
              key={activeSection}
              initial={{ y: 8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-white/[0.02] backdrop-blur-sm shadow-[0_4px_20px_rgba(14,23,69,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.16)] p-5"
            >
              {/* Section header */}
              <div className="flex items-center gap-2 mb-5 pb-3 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
                <ScrollText size={14} className="text-[#0e1745]/40 dark:text-white/40" />
                <h2 className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                  {sections.find((s) => s.id === activeSection)?.label}
                </h2>
              </div>

              {/* Active section body */}
              {activeSection === 'tramitacion' && (
                <TramitacionTimeline tramite={data.tramite} />
              )}
              {activeSection === 'proponentes' && (
                <ProponentesList proponentes={data.proponentes} />
              )}
              {activeSection === 'consultas' && (
                <ConsultasEntidades consultas={data.consultas} />
              )}
              {activeSection === 'ley' && data.ley && (
                <LeyInfo ley={data.ley} />
              )}
              {activeSection === 'ley' && !data.ley && (
                <div className="py-8 text-center">
                  <Scale size={24} className="mx-auto mb-2 text-[#0e1745]/30 dark:text-white/30" />
                  <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
                    Este expediente no ha llegado a ser ley publicada.
                  </p>
                </div>
              )}
              {activeSection === 'documentos' && (
                <DocumentosExpediente documentos={data.documentos} />
              )}
              {activeSection === 'fechas' && (
                <FechasExtraidasPanel
                  vigente={fechasVigente}
                  historial={fechasHistorial}
                  otrasFechas={fechasOtras}
                />
              )}
              {activeSection === 'sala' && (
                <SalaConstitucionalPanel resoluciones={consultasSala} />
              )}
              {activeSection === 'actas' && (
                <ActasComisionPanel actas={actasComision} />
              )}
              {activeSection === 'novedades' && (
                <NovedadesPanel
                  audiencias={audiencias}
                  novedades={novedadesAlgoritmo}
                />
              )}
              {activeSection === 'orden_dia' && (
                <OrdenDiaPanel apariciones={ordenDiaApariciones} />
              )}
              {activeSection === 'despacho' && (
                <ListaDespachoPanel historial={despachoHistorial} />
              )}
            </motion.div>
          )}
        </div>
      </div>
    </div>
  );
}
