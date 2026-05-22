/**
 * DocumentosExpediente — lista de documentos descargables agrupados por tipo.
 *
 * Cubre los documentos de la biblioteca nueva (sil_expediente_documentos),
 * no los del legacy sil_documentos. Tipos: texto_sustitutivo, dictámenes,
 * informes, mociones 137/138/177.
 *
 * Cada ítem muestra: tipo badge + título + fecha + link al PDF.
 */
import { type ExpedienteDocumentoFull } from '@/services/expedientesApi';
import { FileText, Download, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

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

interface TipoConfig {
  label: string;
  cls: string;
  group: string;
}

const TIPO_MAP: Record<string, TipoConfig> = {
  texto_sustitutivo: {
    label: 'Texto sustitutivo',
    cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/25',
    group: 'Textos',
  },
  dictamen_mayoria: {
    label: 'Dictamen mayoría',
    cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25',
    group: 'Dictámenes',
  },
  dictamen_minoria: {
    label: 'Dictamen minoría',
    cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25',
    group: 'Dictámenes',
  },
  informe_servicios_tecnicos: {
    label: 'Inf. Servicios Técnicos',
    cls: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20',
    group: 'Informes',
  },
  informe_subcomision: {
    label: 'Inf. Subcomisión',
    cls: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20',
    group: 'Informes',
  },
  mocion_137_primer_dia: {
    label: 'Moción 137 — 1er día',
    cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25',
    group: 'Mociones art. 137',
  },
  mocion_137_segundo_dia: {
    label: 'Moción 137 — 2do día',
    cls: 'bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/25',
    group: 'Mociones art. 137',
  },
  mocion_138: {
    label: 'Moción 138 (reiteración)',
    cls: 'bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/25',
    group: 'Mociones',
  },
  mocion_177: {
    label: 'Moción 177 (dispensada)',
    cls: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25',
    group: 'Mociones',
  },
  otro: {
    label: 'Otro',
    cls: 'bg-gray-500/10 text-gray-600 dark:text-gray-300 border-gray-500/20',
    group: 'Otros',
  },
};

function getTipo(tipo: string): TipoConfig {
  return TIPO_MAP[tipo] ?? { label: tipo, cls: 'bg-gray-500/10 text-gray-600 border-gray-500/20', group: 'Otros' };
}

function embedStatusLabel(status: string): { text: string; cls: string } | null {
  if (status === 'done') return null; // no mostrar si ya está indexado
  if (status === 'in_progress') return { text: 'Indexando…', cls: 'text-amber-600 dark:text-amber-400' };
  if (status === 'failed') return { text: 'Error al indexar', cls: 'text-rose-600 dark:text-rose-400' };
  return { text: 'Pendiente de indexar', cls: 'text-[#0e1745]/40 dark:text-white/40' };
}

interface Props {
  documentos: ExpedienteDocumentoFull[];
}

export function DocumentosExpediente({ documentos }: Props) {
  if (documentos.length === 0) {
    return (
      <div className="py-8 text-center">
        <FileText size={24} className="mx-auto mb-2 text-[#0e1745]/30 dark:text-white/30" />
        <p className="text-sm text-[#0e1745]/55 dark:text-white/55">
          Sin documentos registrados aún.
        </p>
        <p className="text-xs text-[#0e1745]/40 dark:text-white/40 mt-1">
          El scraper de detalle del SIL llenará esta sección cuando corra.
        </p>
      </div>
    );
  }

  // Group by tipo.group. Orden importa: "Textos" primero porque ahí vive
  // el texto sustitutivo, que es la versión VIGENTE del proyecto (pedido
  // 16k del cliente — Lexa también prioriza sustitutivo sobre original).
  const GROUP_ORDER = ['Textos', 'Dictámenes', 'Mociones art. 137', 'Mociones', 'Informes', 'Otros'];
  const groups = new Map<string, ExpedienteDocumentoFull[]>();
  for (const doc of documentos) {
    const g = getTipo(doc.tipo).group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(doc);
  }
  // Reordenar siguiendo GROUP_ORDER
  const orderedGroups: [string, ExpedienteDocumentoFull[]][] = [];
  for (const g of GROUP_ORDER) {
    if (groups.has(g)) orderedGroups.push([g, groups.get(g)!]);
  }
  for (const [g, docs] of groups.entries()) {
    if (!GROUP_ORDER.includes(g)) orderedGroups.push([g, docs]);
  }

  // Banner si hay texto sustitutivo — el cliente quiere saber EN LA UI
  // que ese es el texto VIGENTE del proyecto, no el original. Lexa ya lo
  // sabe (renderExpedienteFullForLlm lo prioriza), pero el consultor que
  // mira la ficha también debe verlo.
  const sustitutivos = documentos.filter((d) => d.tipo === 'texto_sustitutivo');
  const sustitutivoVigente = sustitutivos.length > 0
    ? [...sustitutivos].sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? ''))[0]
    : null;

  return (
    <div className="space-y-4">
      {sustitutivoVigente && (
        <div className="rounded-xl border-l-4 border-blue-500/70 border-y border-r border-blue-500/20 bg-blue-500/[0.04] px-4 py-3">
          <div className="flex items-start gap-2.5">
            <div className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold">
              ★
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-blue-700 dark:text-blue-300 mb-0.5">
                Texto vigente del proyecto
              </div>
              <p className="text-[12.5px] text-[#0e1745]/80 dark:text-white/80 leading-snug">
                Existe texto sustitutivo aprobado por la comisión el{' '}
                <span className="font-medium">{fmtDate(sustitutivoVigente.fecha)}</span>.
                Es la versión vigente del proyecto — el texto original quedó superseded.
                Lexa y Atlas responden basándose en este sustitutivo, no en el original.
              </p>
            </div>
          </div>
        </div>
      )}
      {orderedGroups.map(([group, docs]) => (
        <div key={group}>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#0e1745]/40 dark:text-white/40 mb-2 px-1">
            {group} ({docs.length})
          </h3>
          <ul className="divide-y divide-[#0e1745]/[0.05] dark:divide-white/[0.05] rounded-xl border border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-white dark:bg-white/[0.02] overflow-hidden">
            {docs.map((doc) => {
              const tipoConf = getTipo(doc.tipo);
              const statusInfo = embedStatusLabel(doc.embed_status);
              // Pedido 16k — marcar el row del sustitutivo vigente. Es el
              // mismo doc que el banner superior referencia, pero el badge
              // en línea evita que el consultor tenga que mirar las fechas
              // de varios sustitutivos para deducir cuál manda.
              const isVigente = sustitutivoVigente && doc.id === sustitutivoVigente.id;
              return (
                <li key={doc.id} className="px-4 py-3 flex items-start gap-3">
                  <FileText
                    size={16}
                    className="shrink-0 mt-0.5 text-[#0e1745]/35 dark:text-white/35"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center flex-wrap gap-2 mb-0.5">
                      <span
                        className={cn(
                          'inline-block px-2 py-0.5 rounded-full text-[10px] font-medium border',
                          tipoConf.cls,
                        )}
                      >
                        {tipoConf.label}
                      </span>
                      {isVigente && (
                        <span
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                          title="Versión vigente del proyecto — Lexa y Atlas responden con este texto, no con el original"
                        >
                          ★ Vigente
                        </span>
                      )}
                      {doc.fecha && (
                        <span className="text-[11px] text-[#0e1745]/45 dark:text-white/45">
                          {fmtDate(doc.fecha)}
                        </span>
                      )}
                      {statusInfo && (
                        <span className={cn('text-[10px]', statusInfo.cls)}>
                          · {statusInfo.text}
                        </span>
                      )}
                    </div>
                    {doc.titulo && (
                      <p className="text-[12.5px] text-[#0e1745]/80 dark:text-white/80 leading-snug">
                        {doc.titulo}
                      </p>
                    )}
                  </div>
                  {/* Open link */}
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 mt-0.5 inline-flex items-center gap-1 text-[11px] text-cl2-accent hover:underline"
                    title="Abrir PDF"
                  >
                    <ExternalLink size={12} />
                    <span className="hidden sm:inline">Abrir</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
