/**
 * OrdenDiaPanel — pedido 16c del cliente.
 *
 * Pedido 16c (Jred citando a Carlos/Donovan, 35:14):
 *   "Yo desearía que cuando me pase la lista del orden del día, ahí sí me
 *    me detalle dónde está, en cuál capítulo está, si está en primero,
 *    segundo o tercer debate."
 *
 * El parser `ordenDiaSectionParser.ts` corre invisible cuando `agendaScrape`
 * descarga el orden del día oficial. Por cada expediente vigilado se deja
 * el dato `{fecha_sesion, capitulo, debate, orden_pdf_url}` en el metadata.
 * Esta sección lo expone DENTRO del expediente — el consultor abre la ficha
 * y ve directamente "vas a primer debate el 14 de mayo".
 *
 * Para Sprint 2 esto se moverá de `metadata.proxima_orden_dia` a tabla
 * dedicada `sil_expediente_agenda` con foreign key a `agenda_legislativa`.
 */
import { Calendar, ChevronRight, ExternalLink, Layers } from 'lucide-react';

type CapituloLabel =
  | 'capitulo_primero'
  | 'capitulo_segundo'
  | 'capitulo_tercero'
  | 'sin_clasificar';

type DebateLabel =
  | 'primer_debate'
  | 'segundo_debate'
  | 'tercer_debate'
  | 'mocion_orden'
  | 'sin_clasificar';

interface OrdenDiaAparicion {
  fecha_sesion: string;
  hora?: string;
  numero_sesion?: number;
  tipo_sesion?: 'ordinaria' | 'extraordinaria';
  capitulo: CapituloLabel;
  capitulo_titulo: string;
  debate: DebateLabel;
  orden_pdf_url?: string;
  /** Snippet del orden del día donde aparece este expediente. */
  contexto_extracto?: string;
}

interface Props {
  /** Lista de apariciones detectadas para este expediente. Más reciente primero. */
  apariciones?: OrdenDiaAparicion[];
}

const CAP_LABEL: Record<string, string> = {
  capitulo_primero: 'Capítulo Primero',
  capitulo_segundo: 'Capítulo Segundo',
  capitulo_tercero: 'Capítulo Tercero',
  sin_clasificar: 'Sin clasificar',
};

const DEBATE_LABEL: Record<string, string> = {
  primer_debate: 'Primer debate',
  segundo_debate: 'Segundo debate',
  tercer_debate: 'Tercer debate',
  mocion_orden: 'Moción de orden',
  sin_clasificar: 'Pendiente clasificación',
};

const DEBATE_COLOR: Record<string, string> = {
  primer_debate: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
  segundo_debate:
    'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  tercer_debate: 'bg-cl2-accent/15 text-cl2-accent border-cl2-accent/30',
  mocion_orden: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
  sin_clasificar:
    'bg-[#0e1745]/5 text-[#0e1745]/55 dark:bg-white/5 dark:text-white/55 border-[#0e1745]/10 dark:border-white/10',
};

function fmtSessionDate(iso: string): string {
  try {
    return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('es-CR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function isFutureOrToday(iso: string): boolean {
  try {
    const d = new Date(`${iso.slice(0, 10)}T23:59:59`);
    return d.getTime() >= Date.now();
  } catch {
    return false;
  }
}

export function OrdenDiaPanel({ apariciones }: Props) {
  if (!apariciones || apariciones.length === 0) {
    return (
      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.025] p-8 text-center">
        <Calendar className="w-7 h-7 mx-auto mb-3 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          Este expediente no está agendado para próximas sesiones del Plenario.
        </p>
        <p className="text-[11.5px] text-[#0e1745]/45 dark:text-white/45 mt-2">
          El sistema revisa el orden del día cada 30 minutos. Si aparece, lo verás acá.
        </p>
      </div>
    );
  }

  // First entry = la próxima (más reciente/futura)
  const proxima = apariciones[0];
  const proximaEsFutura = isFutureOrToday(proxima.fecha_sesion);
  const resto = apariciones.slice(1);

  return (
    <div className="space-y-4">
      {/* Próxima aparición — destacada */}
      <div
        className={`rounded-2xl border-l-4 ${
          proximaEsFutura ? 'border-cl2-accent/70 bg-cl2-accent/[0.04]' : 'border-[#0e1745]/30 bg-white/60 dark:bg-white/[0.025]'
        } border-y border-r border-[#0e1745]/[0.06] dark:border-white/[0.06] p-5`}
      >
        <div className="flex items-center gap-2 mb-2">
          <Calendar className="w-4 h-4 text-cl2-accent" />
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-cl2-accent">
            {proximaEsFutura ? 'Próxima aparición' : 'Última aparición'}
          </div>
        </div>

        <div className="text-[18px] font-display font-medium text-[#0e1745] dark:text-white mb-1">
          {fmtSessionDate(proxima.fecha_sesion)}
        </div>

        <div className="flex items-center gap-2 flex-wrap text-[12.5px] text-[#0e1745]/70 dark:text-white/70 mb-3">
          {proxima.numero_sesion && (
            <span>Sesión {proxima.tipo_sesion ?? 'ordinaria'} #{proxima.numero_sesion}</span>
          )}
          {proxima.hora && (
            <>
              <span className="text-[#0e1745]/30 dark:text-white/30">·</span>
              <span className="font-mono">{proxima.hora}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap mb-3">
          <Layers className="w-3.5 h-3.5 text-cl2-accent/70" />
          <span className="text-[12px] font-medium text-[#0e1745]/85 dark:text-white/85">
            {CAP_LABEL[proxima.capitulo] ?? proxima.capitulo}
          </span>
          <ChevronRight className="w-3 h-3 text-[#0e1745]/30 dark:text-white/30" />
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-[10.5px] font-bold uppercase tracking-[0.06em] border ${DEBATE_COLOR[proxima.debate] ?? DEBATE_COLOR.sin_clasificar}`}
          >
            {DEBATE_LABEL[proxima.debate] ?? proxima.debate}
          </span>
        </div>

        {proxima.contexto_extracto && (
          <div className="mt-3 rounded-md bg-[#0e1745]/[0.03] dark:bg-white/[0.03] px-3 py-2 text-[11.5px] text-[#0e1745]/65 dark:text-white/65 italic leading-relaxed">
            "{proxima.contexto_extracto}"
          </div>
        )}

        {proxima.orden_pdf_url && (
          <a
            href={proxima.orden_pdf_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] font-medium text-cl2-accent hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            Orden del día oficial (PDF)
          </a>
        )}
      </div>

      {/* Historial */}
      {resto.length > 0 && (
        <div className="rounded-2xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/80 dark:bg-white/[0.025] overflow-hidden">
          <div className="px-5 py-3 bg-[#0e1745]/[0.03] dark:bg-white/[0.03] border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#0e1745]/55 dark:text-white/55">
              Apariciones anteriores
            </div>
          </div>
          <div className="divide-y divide-[#0e1745]/[0.04] dark:divide-white/[0.04]">
            {resto.map((ap, idx) => (
              <div key={idx} className="px-5 py-3 flex items-center gap-3 flex-wrap">
                <div className="font-mono text-[12px] text-[#0e1745]/75 dark:text-white/75 min-w-[110px]">
                  {fmtSessionDate(ap.fecha_sesion).split(',')[1]?.trim() ?? ap.fecha_sesion}
                </div>
                <span className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                  {CAP_LABEL[ap.capitulo] ?? ap.capitulo}
                </span>
                <ChevronRight className="w-3 h-3 text-[#0e1745]/30 dark:text-white/30" />
                <span
                  className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-[0.06em] border ${DEBATE_COLOR[ap.debate] ?? DEBATE_COLOR.sin_clasificar}`}
                >
                  {DEBATE_LABEL[ap.debate] ?? ap.debate}
                </span>
                {ap.orden_pdf_url && (
                  <a
                    href={ap.orden_pdf_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[10.5px] text-cl2-accent/80 hover:underline"
                  >
                    PDF
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footnote */}
      <div className="rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white/60 dark:bg-white/[0.025] px-4 py-3">
        <p className="text-[10.5px] text-[#0e1745]/55 dark:text-white/55 leading-relaxed font-mono">
          Sección y debate detectados por <code>ordenDiaSectionParser.ts</code> al ingestar el PDF oficial del Plenario.
          Markers usados: <code>CAPÍTULO PRIMERO|SEGUNDO|TERCERO</code> + <code>PRIMER|SEGUNDO|TERCER DEBATE</code>.
        </p>
      </div>
    </div>
  );
}
