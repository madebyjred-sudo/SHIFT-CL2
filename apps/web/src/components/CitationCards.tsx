/**
 * CitationCards — Collapsible list of RAG chunk citations under a Lexa response.
 *
 * Receives ChunkCitation[] (from `citation` SSE event in chatStream).
 * Default collapsed; click header to expand. Each card: comisión + fecha pill,
 * source_ref, content excerpt, similarity %, optional video_url link.
 */
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { BookOpen, Check, ChevronDown, FileText, ExternalLink, Landmark, Gavel } from 'lucide-react';
import type { ChunkCitation } from '@/lib/chat-context';
import { saveCitation } from '@/services/workspaceApi';

interface CitationCardsProps {
  citations: ChunkCitation[];
}

function formatFecha(iso: string | null): string {
  if (!iso) return 's/f';
  // ISO date "2026-03-04" parses as UTC midnight; in GMT-6 (CR) it shifts a day
  // back. Force local-time interpretation by appending T00:00:00.
  try {
    const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
    return d.toLocaleDateString('es-CR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function isSilCitation(c: ChunkCitation): boolean {
  return typeof c.source_type === 'string' && c.source_type.startsWith('sil_');
}

function silTypeLabel(source_type: string | undefined): string {
  switch (source_type) {
    case 'sil_expediente': return 'Expediente';
    case 'sil_dictamen': return 'Dictamen';
    case 'sil_mocion': return 'Moción';
    case 'sil_votacion': return 'Votación';
    case 'sil_acta': return 'Acta';
    case 'sil_ley': return 'Ley';
    default: return 'SIL';
  }
}

export function CitationCards({ citations }: CitationCardsProps) {
  const [expanded, setExpanded] = useState(false);

  if (!citations.length) return null;

  // Mixed payload — pick the prominent icon based on majority source type so
  // the collapsed header reads honestly (a SIL-heavy result shouldn't show
  // the plenaria document icon).
  const silCount = citations.filter(isSilCitation).length;
  const HeaderIcon = silCount > citations.length / 2 ? Landmark : FileText;
  const headerLabel = silCount === citations.length
    ? `${citations.length} ${citations.length === 1 ? 'expediente del SIL' : 'fuentes del SIL'}`
    : silCount > 0
      ? `${citations.length} fuentes (${silCount} SIL · ${citations.length - silCount} plenaria)`
      : `${citations.length} ${citations.length === 1 ? 'fuente' : 'fuentes'} legislativa${citations.length === 1 ? '' : 's'}`;

  return (
    <div className="w-full mt-3 rounded-2xl border border-black/5 dark:border-white/10 bg-white/40 dark:bg-white/[0.03] backdrop-blur-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 text-[12px] font-medium text-[#0e1745]/70 dark:text-white/70">
          <HeaderIcon className="w-3.5 h-3.5" />
          <span>{headerLabel}</span>
        </div>
        <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }}>
          <ChevronDown className="w-4 h-4 text-[#0e1745]/50 dark:text-white/50" />
        </motion.div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-1 flex flex-col gap-2">
              {citations.map((c, i) =>
                isSilCitation(c) ? (
                  <SilCitationCard key={c.id} citation={c} index={i} />
                ) : (
                  <PlenariaCitationCard key={c.id} citation={c} index={i} />
                ),
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Plenary-source card (transcripción / segmento de video) — original layout.
function PlenariaCitationCard({ citation: c, index: i }: { citation: ChunkCitation; index: number }) {
  return (
    <article className="rounded-xl border border-black/5 dark:border-white/10 bg-white/60 dark:bg-white/[0.04] p-3 text-[12.5px]">
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10.5px] font-semibold text-[#0e1745]/40 dark:text-white/40">
            [{i + 1}]
          </span>
          {c.comision && (
            <span
              className="px-2 py-0.5 rounded-full text-[10.5px] font-medium"
              style={{
                backgroundColor: 'var(--color-cl2-burgundy-soft)',
                color: 'var(--color-cl2-burgundy)',
                border: '1px solid color-mix(in srgb, var(--color-cl2-burgundy) 19%, transparent)',
              }}
            >
              {c.comision}
            </span>
          )}
          <span className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
            {formatFecha(c.fecha)}
          </span>
          <span className="text-[10.5px] text-[#0e1745]/35 dark:text-white/35">
            · {Math.round(c.similarity * 100)}% match
          </span>
        </div>
        {c.video_url && (
          <a
            href={c.video_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[10.5px] text-cl2-burgundy hover:underline shrink-0"
          >
            Video <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </header>
      <p className="text-[#0e1745]/80 dark:text-white/80 leading-relaxed">
        {c.content}
      </p>
      <footer className="mt-2 text-[10.5px] text-[#0e1745]/40 dark:text-white/40 font-mono truncate">
        {c.source_ref}
      </footer>
    </article>
  );
}

// SIL-source card (expediente / dictamen / moción) — different visual layout
// to make the source distinction obvious. Number prominent.
//
// Link target: when the citation carries an expediente_numero we deeplink
// to OUR canonical viewer (/expediente/:numero), which renders from our DB
// + serves PDFs from our GCS mirror — works even when the SIL is down.
// Falls back to the upstream `url_detalle` for citations without a number.
function SilCitationCard({ citation: c, index: i }: { citation: ChunkCitation; index: number }) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const typeLabel = silTypeLabel(c.source_type);
  const link = c.expediente_numero
    ? `/expediente/${encodeURIComponent(c.expediente_numero.replace(/[^\d]/g, ''))}`
    : c.url_detalle ?? null;
  const linkLabel = c.expediente_numero ? 'Ver expediente' : 'Ver en SIL';
  const linkExternal = !c.expediente_numero;

  const handleSave = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (saved || saving) return;
    setSaving(true);
    try {
      await saveCitation({
        chunk_id: c.id,
        source_label: c.source_ref ?? `Exp. ${c.expediente_numero ?? ''}`,
        excerpt: c.content?.slice(0, 300) ?? '',
      });
      setSaved(true);
    } catch { /* silent — citation not critical */ } finally {
      setSaving(false);
    }
  };

  return (
    <article className="rounded-xl border border-cl2-accent/15 bg-cl2-accent/5 dark:bg-cl2-accent/[0.07] p-3 text-[12.5px]">
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10.5px] font-semibold text-[#0e1745]/40 dark:text-white/40">
            [{i + 1}]
          </span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-cl2-accent/15 text-cl2-accent border border-cl2-accent/25">
            <Gavel className="w-2.5 h-2.5" />
            {typeLabel}
          </span>
          {c.expediente_numero && (
            <span className="text-[11px] font-mono tabular-nums text-[#0e1745]/75 dark:text-white/80">
              Exp. {c.expediente_numero}
            </span>
          )}
          {c.fecha && (
            <span className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
              {formatFecha(c.fecha)}
            </span>
          )}
          {c.estado && (
            <span className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45">
              · {c.estado}
            </span>
          )}
        </div>
        {link && (
          <a
            href={link}
            target={linkExternal ? '_blank' : undefined}
            rel={linkExternal ? 'noopener noreferrer' : undefined}
            className="inline-flex items-center gap-1 text-[10.5px] text-cl2-accent hover:underline shrink-0"
          >
            {linkLabel} <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </header>
      {c.content && (
        <p className="text-[#0e1745]/80 dark:text-white/80 leading-relaxed">
          {c.content}
        </p>
      )}
      <footer className="mt-2 flex items-center justify-between gap-2 text-[10.5px] text-[#0e1745]/40 dark:text-white/40">
        <span className="truncate">
          {c.proponente ? `Proponente: ${c.proponente}` : c.source_ref}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {c.comision && <span>{c.comision}</span>}
          <button
            onClick={handleSave}
            disabled={saved || saving}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-medium transition-colors bg-cl2-burgundy/10 text-cl2-burgundy dark:text-cl2-burgundy/90 hover:bg-cl2-burgundy/20 disabled:opacity-60"
            title="Guardar en hojas de trabajo"
          >
            {saved ? (
              <><Check className="w-3 h-3" /> Guardado</>
            ) : (
              <><BookOpen className="w-3 h-3" /> Guardar en hoja</>
            )}
          </button>
        </div>
      </footer>
    </article>
  );
}
