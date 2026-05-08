/**
 * GeneratedAssetNode — ReactFlow node for assets PRODUCED by the system
 * (carousel / pptx / docx / podcast).
 *
 * Distinct from `AssetNode` (sibling), which renders IMPORTED files
 * (image / audio / document upload). The two share the same shell —
 * border-radius, shadow, color theme, drag-grip, hover actions — so the
 * canvas feels uniform regardless of the node's origin.
 *
 * Variants are routed off `data.asset_metadata.kind`:
 *   • carousel       — fan/stack of slides (1 prominent, the rest behind)
 *   • pptx_asset     — 16:9 hero thumbnail + horizontal strip below
 *   • docx_asset     — A4 icon + title + meta
 *   • podcast_asset  — waveform + duration + headline
 *
 * Click body → opens AssetDetailPanel (consumer wires this via onSelect).
 * Header actions (hover or kebab):
 *   - Ver detalle      (opens panel)
 *   - Re-generar todo  (calls onRegenerateAll)
 *   - Descargar        (anchor → metadata.export_url)
 *   - Compartir URL    (clipboard)
 *   - Eliminar
 *
 * No <Handle> edges — the workspace canvas is a free-form board.
 */
import { useCallback, useMemo, useState } from 'react';
import { NodeResizer } from '@xyflow/react';
import {
  GripHorizontal, Trash2, Download, Share2, RefreshCw, MoreHorizontal,
  Eye, FileText, AudioLines, Presentation as PresentationIcon, Layers as LayersIcon,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  AssetMetadata, AssetSlide, GeneratedAssetData, GeneratedAssetKind, NodeColor,
} from '@/services/workspaceApi';

// ─── Theme tokens — match HojaNode for visual continuity ──────────────
const COLOR_ACCENTS: Record<NodeColor, string> = {
  default:  'border-black/8 dark:border-white/8',
  burgundy: 'border-cl2-burgundy/25',
  ink:      'border-[#0e1745]/20',
  sage:     'border-emerald-500/25',
  amber:    'border-amber-500/25',
};

// Tiny header glyphs per kind. We deliberately use ASCII-style marks
// (◉ ▣ 📄 ♪) as fallbacks in copy and lucide icons in JSX so the visual
// stays editorial without breaking on systems without emoji fonts.
const KIND_HEADER: Record<GeneratedAssetKind, { icon: LucideIcon; label: string; mark: string }> = {
  carousel:      { icon: LayersIcon,        label: 'Carrusel',      mark: '◉' },
  pptx_asset:    { icon: PresentationIcon,  label: 'Presentación',  mark: '▣' },
  docx_asset:    { icon: FileText,          label: 'Documento',     mark: '∎' },
  podcast_asset: { icon: AudioLines,        label: 'Podcast',       mark: '♪' },
};

interface NodeCallbacks {
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
  onRegenerateAll?: (id: string) => void;
}

export interface GeneratedAssetNodeData extends NodeCallbacks, GeneratedAssetData {
  workspaceId: string;
  title?: string;
  subtitle?: string;
  color?: NodeColor;
}

export function GeneratedAssetNode({
  id,
  data,
  selected,
}: {
  id: string;
  data: GeneratedAssetNodeData;
  selected?: boolean;
}) {
  const { asset_metadata: meta, asset_slides: slides } = data;
  const accent = COLOR_ACCENTS[(data.color ?? 'default') as NodeColor] ?? COLOR_ACCENTS.default;
  const header = KIND_HEADER[meta.kind];
  const HeaderIcon = header.icon;
  const [menuOpen, setMenuOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');

  const handleSelect = useCallback(() => data.onSelect(id), [data, id]);
  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    data.onDelete(id);
  }, [data, id]);
  const handleRegen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    data.onRegenerateAll?.(id);
  }, [data, id]);
  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(meta.export_url);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch { /* clipboard blocked — silent */ }
  }, [meta.export_url]);

  const headerLabel = useMemo(() => {
    if (meta.kind === 'carousel' || meta.kind === 'pptx_asset') {
      return `${header.label} · ${meta.slides_count} slides`;
    }
    if (meta.kind === 'docx_asset') {
      return `${header.label} · ${meta.slides_count} ${meta.slides_count === 1 ? 'página' : 'páginas'}`;
    }
    if (meta.kind === 'podcast_asset') {
      const sec = meta.duration_sec ?? 0;
      const mm = Math.floor(sec / 60);
      const ss = String(sec % 60).padStart(2, '0');
      return `${header.label} · ${mm}:${ss}`;
    }
    return header.label;
  }, [meta, header]);

  return (
    <div
      onClick={handleSelect}
      className={cn(
        'group relative flex flex-col rounded-2xl border bg-cl2-paper dark:bg-[#1c1c1c] shadow-sm transition-all duration-150 overflow-hidden',
        accent,
        selected && 'ring-2 ring-cl2-burgundy/60 shadow-lg shadow-cl2-burgundy/15',
      )}
      style={{ width: '100%', height: '100%' }}
    >
      <NodeResizer
        minWidth={320}
        minHeight={240}
        isVisible={!!selected}
        lineClassName="border-cl2-burgundy/40"
        handleClassName="bg-cl2-burgundy border-white/60 rounded-sm"
      />

      {/* ── Header — drag handle + title chrome + actions ───────── */}
      <div
        className="drag-handle flex items-center gap-2 px-3 pt-2.5 pb-2 border-b border-black/[0.06] dark:border-white/[0.06] cursor-grab active:cursor-grabbing bg-white/40 dark:bg-white/[0.02]"
        data-drag-handle
      >
        <GripHorizontal className="w-3.5 h-3.5 text-black/25 dark:text-white/25 shrink-0" />
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="font-display italic text-[12.5px] text-cl2-burgundy/85 dark:text-cl2-burgundy/95 leading-none"
            aria-hidden
          >
            {header.mark}
          </span>
          <HeaderIcon className="w-3 h-3 text-cl2-burgundy/70 shrink-0" />
          <span className="text-[10.5px] uppercase tracking-[0.16em] font-mono font-medium text-[#0e1745]/65 dark:text-white/55 truncate">
            {headerLabel}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); handleSelect(); }}
            title="Ver detalle"
            className="p-1 rounded-md text-black/30 dark:text-white/30 hover:bg-black/5 dark:hover:bg-white/5 hover:text-cl2-burgundy transition-colors"
          >
            <Eye className="w-3 h-3" />
          </button>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            title="Más acciones"
            className="p-1 rounded-md text-black/30 dark:text-white/30 hover:bg-black/5 dark:hover:bg-white/5 hover:text-[#0e1745] dark:hover:text-white transition-colors"
          >
            <MoreHorizontal className="w-3 h-3" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-2 top-9 z-30 w-48 rounded-xl bg-white dark:bg-[#1c1c1c] border border-black/8 dark:border-white/10 shadow-xl py-1 text-[12px]"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={(e) => { e.stopPropagation(); setMenuOpen(false); handleSelect(); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#0e1745] dark:text-white hover:bg-cl2-burgundy/[0.06]"
              >
                <Eye className="w-3.5 h-3.5" /> Ver detalle
              </button>
              <button
                onClick={handleRegen}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#0e1745] dark:text-white hover:bg-cl2-burgundy/[0.06]"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Re-generar todo
              </button>
              {meta.export_url && (
                <a
                  href={meta.export_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#0e1745] dark:text-white hover:bg-cl2-burgundy/[0.06]"
                >
                  <Download className="w-3.5 h-3.5" /> Descargar
                </a>
              )}
              <button
                onClick={handleCopy}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[#0e1745] dark:text-white hover:bg-cl2-burgundy/[0.06]"
              >
                <Share2 className="w-3.5 h-3.5" />
                {copyState === 'copied' ? 'URL copiada' : 'Compartir URL'}
              </button>
              <div className="my-1 border-t border-black/5 dark:border-white/8" />
              <button
                onClick={(e) => { setMenuOpen(false); handleDelete(e); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20"
              >
                <Trash2 className="w-3.5 h-3.5" /> Eliminar
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Body — variant-specific preview ─────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col" onMouseDown={(e) => e.stopPropagation()}>
        {meta.kind === 'carousel' && <CarouselPreview slides={slides} meta={meta} />}
        {meta.kind === 'pptx_asset' && <PptxPreview slides={slides} meta={meta} />}
        {meta.kind === 'docx_asset' && <DocxPreview slides={slides} meta={meta} />}
        {meta.kind === 'podcast_asset' && <PodcastPreview meta={meta} slides={slides} />}
      </div>
    </div>
  );
}

// ─── Variant: carousel — fan stack ────────────────────────────────────
function CarouselPreview({ slides, meta }: { slides: AssetSlide[]; meta: AssetMetadata }) {
  // Up to 4 ghost slides behind the front; rest collapse into the deepest stack.
  const fanSlides = slides.slice(0, Math.min(slides.length, 5));
  const front = fanSlides[0];
  const ghostCount = Math.max(0, fanSlides.length - 1);
  return (
    <div className="relative flex-1 min-h-0 flex items-center justify-center px-5 py-4">
      {/* Fan layers — 1° / 2° / 3° rotated and offset behind the front. */}
      {Array.from({ length: ghostCount }).map((_, i) => {
        const depth = ghostCount - i; // back-most = highest depth
        return (
          <div
            key={`ghost-${i}`}
            aria-hidden
            className="absolute aspect-square rounded-2xl bg-white dark:bg-[#222] border border-black/5 dark:border-white/8 shadow-sm transition-transform"
            style={{
              width: '60%',
              transform: `translateY(${depth * 4}px) rotate(${(depth % 2 === 0 ? 1 : -1) * (1.5 + depth * 0.7)}deg)`,
              opacity: 0.45 - depth * 0.06,
              zIndex: 1 + i,
            }}
          />
        );
      })}
      {/* Front slide — always visible. Mini editorial card. */}
      <div
        className="relative aspect-square w-[62%] max-h-full rounded-2xl bg-cl2-paper dark:bg-[#222] border border-cl2-burgundy/15 shadow-md flex flex-col p-3 z-10"
        style={{ transform: 'rotate(-1deg)' }}
      >
        {front?.eyebrow && (
          <p className="text-[8.5px] uppercase tracking-[0.18em] font-mono text-cl2-burgundy/75 leading-none">
            {front.eyebrow}
          </p>
        )}
        <p className="mt-1 font-display text-[12px] leading-tight text-[#0e1745] dark:text-white line-clamp-4 italic">
          {front?.headline ?? 'Slide 1'}
        </p>
        <div className="mt-auto flex items-center justify-between text-[7.5px] font-mono text-[#0e1745]/45 dark:text-white/40">
          <span>{front?.meta?.footerLeft ?? 'CL2'}</span>
          <span>{`01 / ${String(meta.slides_count).padStart(2, '0')}`}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Variant: pptx — 16:9 thumb + strip ───────────────────────────────
function PptxPreview({ slides, meta }: { slides: AssetSlide[]; meta: AssetMetadata }) {
  const hero = slides[0];
  const rest = slides.slice(1, 8);
  return (
    <div className="flex-1 min-h-0 flex flex-col px-3 py-3 gap-2">
      {/* Hero 16:9 — front slide */}
      <div className="relative w-full aspect-video rounded-xl bg-white dark:bg-[#222] border border-black/8 dark:border-white/10 shadow-sm overflow-hidden flex flex-col p-3">
        {hero?.eyebrow && (
          <p className="text-[8.5px] uppercase tracking-[0.16em] font-mono text-cl2-burgundy/75 leading-none">
            {hero.eyebrow}
          </p>
        )}
        <p className="mt-1 font-display italic text-[14px] leading-tight text-[#0e1745] dark:text-white line-clamp-3">
          {hero?.headline}
        </p>
        {hero?.body && (
          <p className="mt-1 text-[10px] text-[#0e1745]/65 dark:text-white/55 line-clamp-2">
            {hero.body}
          </p>
        )}
        <div className="mt-auto flex items-center justify-between text-[7.5px] font-mono text-[#0e1745]/45 dark:text-white/40 pt-2">
          <span>{meta.title ?? 'CL2 · Presentación'}</span>
          <span>{`01 / ${String(meta.slides_count).padStart(2, '0')}`}</span>
        </div>
      </div>
      {/* Horizontal scroll strip */}
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
        {rest.map((s) => (
          <div
            key={s.idx}
            className="shrink-0 w-16 aspect-video rounded-md bg-white dark:bg-[#222] border border-black/8 dark:border-white/10 flex items-center justify-center text-[8px] font-mono text-[#0e1745]/45 dark:text-white/40"
            title={s.headline}
          >
            {String(s.idx + 1).padStart(2, '0')}
          </div>
        ))}
        {meta.slides_count > rest.length + 1 && (
          <div className="shrink-0 w-16 aspect-video rounded-md bg-cl2-burgundy/10 border border-cl2-burgundy/20 flex items-center justify-center text-[9px] font-mono text-cl2-burgundy">
            +{meta.slides_count - rest.length - 1}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Variant: docx — A4 icon + meta ───────────────────────────────────
function DocxPreview({ slides, meta }: { slides: AssetSlide[]; meta: AssetMetadata }) {
  const hero = slides[0];
  return (
    <div className="flex-1 min-h-0 flex items-center gap-4 px-5 py-4">
      {/* Faux A4 sheet — vertical, slight 1° tilt */}
      <div className="relative shrink-0 w-[78px] aspect-[1/1.414] rounded-md bg-white dark:bg-[#222] border border-black/12 dark:border-white/10 shadow-md flex flex-col py-2 px-1.5"
        style={{ transform: 'rotate(-2deg)' }}
      >
        <div className="h-1.5 rounded-sm bg-cl2-burgundy/40" />
        <div className="mt-1 h-0.5 rounded-sm bg-black/15 dark:bg-white/15 w-2/3" />
        <div className="mt-2 space-y-0.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={cn('h-[2px] rounded-full bg-black/10 dark:bg-white/10', i % 4 === 3 && 'w-2/3')} />
          ))}
        </div>
      </div>
      {/* Title / subtitle / meta */}
      <div className="min-w-0 flex-1">
        {hero?.eyebrow && (
          <p className="text-[8.5px] uppercase tracking-[0.18em] font-mono text-cl2-burgundy/75">
            {hero.eyebrow}
          </p>
        )}
        <p className="mt-1 font-display italic text-[14.5px] leading-tight text-[#0e1745] dark:text-white line-clamp-3">
          {hero?.headline ?? meta.title ?? 'Documento ejecutivo'}
        </p>
        {hero?.body && (
          <p className="mt-1.5 text-[11px] text-[#0e1745]/65 dark:text-white/55 line-clamp-3">
            {hero.body}
          </p>
        )}
        <p className="mt-2 text-[9.5px] font-mono uppercase tracking-[0.12em] text-[#0e1745]/45 dark:text-white/40">
          {hero?.meta?.footerLeft ?? 'CL2 · DOCX'} · {meta.slides_count}{' '}
          {meta.slides_count === 1 ? 'página' : 'páginas'}
        </p>
      </div>
    </div>
  );
}

// ─── Variant: podcast — waveform + duration ───────────────────────────
function PodcastPreview({ meta, slides }: { meta: AssetMetadata; slides: AssetSlide[] }) {
  const hero = slides[0];
  const sec = meta.duration_sec ?? 0;
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  // 56 deterministic bars with sin-wave-ish heights — no Math.random in
  // render so the waveform doesn't reshuffle on re-renders.
  const bars = useMemo(
    () =>
      Array.from({ length: 56 }).map((_, i) => {
        const phase = (i / 56) * Math.PI * 4;
        return Math.round(35 + Math.sin(phase) * 22 + (i % 5) * 2);
      }),
    [],
  );
  return (
    <div className="flex-1 min-h-0 flex flex-col px-4 py-4">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-cl2-burgundy/10 border border-cl2-burgundy/25 flex items-center justify-center">
          <AudioLines className="w-4 h-4 text-cl2-burgundy" />
        </div>
        <div className="min-w-0 flex-1">
          {hero?.eyebrow && (
            <p className="text-[8.5px] uppercase tracking-[0.18em] font-mono text-cl2-burgundy/75 leading-none">
              {hero.eyebrow}
            </p>
          )}
          <p className="mt-0.5 font-display italic text-[13.5px] leading-tight text-[#0e1745] dark:text-white line-clamp-2">
            {hero?.headline ?? meta.title ?? 'Audio editorial'}
          </p>
        </div>
      </div>
      {/* Waveform — fakes the look without playback */}
      <div className="mt-3 flex items-end gap-[2px] h-16">
        {bars.map((h, i) => (
          <span
            key={i}
            className={cn(
              'w-[3px] rounded-sm',
              i < bars.length / 4 ? 'bg-cl2-burgundy/85' : 'bg-cl2-burgundy/30',
            )}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] font-mono text-[#0e1745]/55 dark:text-white/45">
        <span>00:00</span>
        <span>{`${mm}:${ss}`}</span>
      </div>
    </div>
  );
}
