/**
 * AssetDetailPanel — the slide-by-slide editor and share surface for
 * generated assets (carousel / pptx / docx / podcast).
 *
 * Opens as a right-side overlay covering ~60% of the viewport when the
 * canvas selection is a GeneratedAssetNode. The remaining 40% keeps the
 * canvas + chat visible so the user never feels boxed in.
 *
 * Three tabs:
 *   • Editar slides — live preview of the active slide + Atlas chat
 *                     scoped to THIS slide (slide-edit endpoint, not
 *                     general chat). Renders a slide picker strip on top.
 *   • Historial    — per-slide diff log (instruction + before/after).
 *   • Compartir    — public link placeholder + download / copy / regenerate.
 *
 * The panel is intentionally NOT a full-screen modal: the canvas stays
 * visible behind it so the user can still see other nodes, drag them,
 * etc. This is "detail panel", not "page".
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  X, Send, FileText, AudioLines, Layers as LayersIcon,
  Presentation as PresentationIcon, History as HistoryIcon,
  Share2, Download, Copy as CopyIcon, RotateCcw, Loader2,
  Image as ImageIcon, Check, AlertTriangle, Lightbulb, Info, Pencil,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  editAssetSlide, regenerateAsset, getAssetHistory,
  type AssetSlide, type AssetSlideHistoryEntry, type AssetMetadata,
  type GeneratedAssetData, type GeneratedAssetKind, type ShareAssetOptions,
} from '@/services/workspaceApi';

type Tab = 'edit' | 'history' | 'share';

const KIND_META: Record<GeneratedAssetKind, { icon: LucideIcon; label: string; mark: string }> = {
  carousel:      { icon: LayersIcon,        label: 'Carrusel',     mark: '◉' },
  pptx_asset:    { icon: PresentationIcon,  label: 'Presentación', mark: '▣' },
  docx_asset:    { icon: FileText,          label: 'Documento',    mark: '∎' },
  podcast_asset: { icon: AudioLines,        label: 'Podcast',      mark: '♪' },
};

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  nodeId: string;
  /** The asset payload — passed in from the canvas so the panel doesn't
   *  refetch on open. The panel mutates a copy via setState; the parent
   *  receives the updated copy via `onAssetChanged` whenever an edit
   *  lands so it can persist back into the ReactFlow node.data. */
  asset: GeneratedAssetData;
  onAssetChanged: (next: GeneratedAssetData) => void;
  onDelete?: () => void;
}

export function AssetDetailPanel({
  open, onClose, workspaceId, nodeId, asset, onAssetChanged, onDelete,
}: Props) {
  const [tab, setTab] = useState<Tab>('edit');
  const [selectedIdx, setSelectedIdx] = useState<number>(0);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const meta = asset.asset_metadata;
  const km = KIND_META[meta.kind];
  const slides = asset.asset_slides;
  const selectedSlide = slides.find((s) => s.idx === selectedIdx) ?? slides[0];

  // Reset selectedIdx when the asset itself changes (new node).
  useEffect(() => {
    setSelectedIdx(0);
    setTab('edit');
    setError(null);
    setInstruction('');
  }, [nodeId]);

  // Lazy-load history when the History tab opens — for the mock we
  // already have it in-memory, but the API path may need to refetch
  // (e.g. when another tab edited the asset). Cheap and idempotent.
  useEffect(() => {
    if (!open || tab !== 'history') return;
    let alive = true;
    setHistoryLoading(true);
    getAssetHistory(workspaceId, nodeId)
      .then((r) => {
        if (!alive) return;
        // Merge — keep our in-memory entries if the server returns less.
        const merged = mergeHistory(asset.asset_slide_history, r.history);
        if (merged !== asset.asset_slide_history) {
          onAssetChanged({ ...asset, asset_slide_history: merged });
        }
      })
      .catch(() => null)
      .finally(() => { if (alive) setHistoryLoading(false); });
    return () => { alive = false; };
    // We intentionally only re-run on tab/nodeId; asset is mutated by
    // local edits and would re-trigger on every keystroke otherwise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, nodeId, workspaceId]);

  const slideHistory = useMemo(
    () => asset.asset_slide_history.filter((h) => h.slide_idx === selectedIdx),
    [asset.asset_slide_history, selectedIdx],
  );

  // ── Slide-edit submit ──────────────────────────────────────────
  const handleSubmitEdit = useCallback(async () => {
    const text = instruction.trim();
    if (!text || editing) return;
    setEditing(true);
    setError(null);
    try {
      const r = await editAssetSlide(workspaceId, nodeId, selectedIdx, text);
      // Replace slide in place + append history entry.
      const nextSlides = slides.map((s) => s.idx === selectedIdx ? { ...r.slide } : s);
      const nextHistory = [...asset.asset_slide_history, r.history_entry];
      onAssetChanged({
        ...asset,
        asset_slides: nextSlides,
        asset_slide_history: nextHistory,
      });
      setInstruction('');
      // Refocus so the user can chain edits without re-clicking the input.
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setEditing(false);
    }
  }, [instruction, editing, workspaceId, nodeId, selectedIdx, slides, asset, onAssetChanged]);

  // ── Regenerate-all submit ──────────────────────────────────────
  const handleRegenerateAll = useCallback(async () => {
    setRegenerating(true);
    setError(null);
    try {
      const r = await regenerateAsset(workspaceId, nodeId, (meta.options ?? {}) as ShareAssetOptions);
      onAssetChanged(r.asset);
      setConfirmRegen(false);
      setSelectedIdx(0);
      setTab('edit');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRegenerating(false);
    }
  }, [workspaceId, nodeId, meta.options, onAssetChanged]);

  // ── Share helpers ──────────────────────────────────────────────
  const handleCopyUrl = useCallback(async () => {
    if (!meta.export_url) return;
    try {
      await navigator.clipboard.writeText(meta.export_url);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch { /* clipboard blocked */ }
  }, [meta.export_url]);

  if (!open) return null;

  return (
    <div className="absolute top-0 right-0 bottom-0 z-40 flex items-stretch pointer-events-none">
      {/* Backdrop is intentionally NOT used here — the canvas behind the
          panel stays interactive (so the user can drag the underlying
          asset node, click another node, etc). The 60vw width feels like
          a focused workspace, not a takeover. */}
      <aside
        role="dialog"
        aria-modal="false"
        aria-label="Detalle de asset generado"
        className="pointer-events-auto h-full bg-cl2-paper dark:bg-[#1a1a1a] border-l border-black/8 dark:border-white/8 shadow-[-12px_0_32px_-12px_rgba(14,23,69,0.18)] flex flex-col"
        style={{ width: 'min(60vw, 880px)' }}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <header className="px-5 pt-4 pb-3 border-b border-black/[0.06] dark:border-white/[0.06] flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-cl2-burgundy/10 border border-cl2-burgundy/20 flex items-center justify-center shrink-0">
            <km.icon className="w-4 h-4 text-cl2-burgundy" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <span className="font-display italic text-cl2-burgundy text-[14px] leading-none">{km.mark}</span>
              <h2 className="font-display text-[18px] leading-tight text-[#0e1745] dark:text-white truncate">
                <span className="italic text-cl2-burgundy/90">{km.label}</span>
                <span className="text-[#0e1745]/55 dark:text-white/45 mx-1.5">·</span>
                {meta.title ?? 'Asset generado'}
              </h2>
            </div>
            <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.14em] text-[#0e1745]/55 dark:text-white/45">
              {`generado ${formatRelativeAgo(meta.generated_at)}`}
              <span className="mx-1.5">·</span>
              {meta.kind === 'docx_asset' || meta.kind === 'podcast_asset'
                ? meta.kind === 'podcast_asset'
                  ? `${formatDuration(meta.duration_sec ?? 0)}`
                  : `${meta.slides_count} ${meta.slides_count === 1 ? 'página' : 'páginas'}`
                : `${meta.slides_count} slides`}
              <span className="mx-1.5">·</span>
              <span className="text-cl2-burgundy/85">{meta.source === 'atlas' ? 'Atlas' : 'manual'}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar panel"
            className="p-1.5 rounded-lg text-[#0e1745]/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/10 hover:text-[#0e1745] dark:hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* ── Tabs ────────────────────────────────────────────────── */}
        <nav className="px-5 pt-3 pb-0 border-b border-black/[0.06] dark:border-white/[0.06] flex items-center gap-1">
          <TabButton active={tab === 'edit'}    onClick={() => setTab('edit')}    icon={Pencil}     label="Editar slides" />
          <TabButton active={tab === 'history'} onClick={() => setTab('history')} icon={HistoryIcon} label={`Historial${asset.asset_slide_history.length ? ` (${asset.asset_slide_history.length})` : ''}`} />
          <TabButton active={tab === 'share'}   onClick={() => setTab('share')}   icon={Share2}     label="Compartir" />
        </nav>

        {/* ── Body ────────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {tab === 'edit' && (
            <EditTab
              slides={slides}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
              selectedSlide={selectedSlide}
              meta={meta}
              instruction={instruction}
              setInstruction={setInstruction}
              editing={editing}
              onSubmit={handleSubmitEdit}
              inputRef={inputRef}
              error={error}
            />
          )}
          {tab === 'history' && (
            <HistoryTab
              loading={historyLoading}
              entries={asset.asset_slide_history}
              filteredEntries={slideHistory}
              selectedIdx={selectedIdx}
              onSelectIdx={(i) => { setSelectedIdx(i); setTab('edit'); }}
              slideCount={slides.length}
            />
          )}
          {tab === 'share' && (
            <ShareTab
              meta={meta}
              copyState={copyState}
              onCopyUrl={handleCopyUrl}
              currentSlide={selectedSlide}
              onRegenerate={() => setConfirmRegen(true)}
              onDelete={onDelete}
            />
          )}
        </div>

        {/* ── Confirm regenerate ─────────────────────────────────── */}
        {confirmRegen && (
          <ConfirmRegenerateModal
            slidesCount={meta.slides_count}
            kind={meta.kind}
            running={regenerating}
            onCancel={() => !regenerating && setConfirmRegen(false)}
            onConfirm={handleRegenerateAll}
          />
        )}
      </aside>
    </div>
  );
}

// ─── Tab button ───────────────────────────────────────────────────────
function TabButton({
  active, onClick, icon: Icon, label,
}: {
  active: boolean; onClick: () => void; icon: LucideIcon; label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 -mb-px rounded-t-lg text-[12px] font-medium border border-transparent transition-colors',
        active
          ? 'bg-white dark:bg-[#222] border-black/8 dark:border-white/10 border-b-cl2-paper dark:border-b-[#1a1a1a] text-cl2-burgundy'
          : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

// ─── Tab: Edit ────────────────────────────────────────────────────────
function EditTab({
  slides, selectedIdx, onSelect, selectedSlide, meta,
  instruction, setInstruction, editing, onSubmit, inputRef, error,
}: {
  slides: AssetSlide[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
  selectedSlide: AssetSlide | undefined;
  meta: AssetMetadata;
  instruction: string;
  setInstruction: (v: string) => void;
  editing: boolean;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  error: string | null;
}) {
  return (
    <div className="px-5 py-4 space-y-4">
      {/* Slide picker — only meaningful when slides_count > 1 */}
      {slides.length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar -mx-1 px-1 pb-1">
          {slides.map((s) => {
            const isSel = s.idx === selectedIdx;
            return (
              <button
                key={s.idx}
                onClick={() => onSelect(s.idx)}
                title={s.headline}
                className={cn(
                  'shrink-0 w-12 h-12 rounded-lg border text-[11px] font-mono flex items-center justify-center transition-all',
                  isSel
                    ? 'bg-cl2-burgundy text-white border-cl2-burgundy ring-2 ring-cl2-burgundy/30 ring-offset-2 ring-offset-cl2-paper dark:ring-offset-[#1a1a1a]'
                    : 'bg-white dark:bg-[#222] border-black/10 dark:border-white/10 text-[#0e1745]/65 dark:text-white/55 hover:border-cl2-burgundy/30 hover:text-cl2-burgundy',
                )}
              >
                {String(s.idx + 1).padStart(2, '0')}
              </button>
            );
          })}
        </div>
      )}

      {/* Large slide preview */}
      {selectedSlide && (
        <SlideLargePreview slide={selectedSlide} meta={meta} />
      )}

      {/* Slide-edit chat */}
      <div className="rounded-2xl bg-white dark:bg-[#222] border border-black/8 dark:border-white/10 overflow-hidden">
        <div className="px-3 pt-2.5 pb-1 flex items-center gap-2 border-b border-black/5 dark:border-white/8">
          <span className="font-display italic text-cl2-burgundy text-[12px]">— Editar este slide con Atlas —</span>
        </div>
        <div className="p-3">
          <textarea
            ref={inputRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            disabled={editing}
            placeholder="¿Qué cambiar en este slide? — ej: 'más conciso', 'cambiar audiencia a banca privada', 'usar dato del MEIC en lugar de OCDE'"
            rows={2}
            className="w-full resize-none px-3 py-2 rounded-lg bg-black/[0.02] dark:bg-white/[0.04] border border-black/8 dark:border-white/8 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-cl2-burgundy/45 disabled:opacity-60"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/35 font-mono">
              Atlas edita SOLO el slide seleccionado · el resto del asset queda igual
            </p>
            <button
              onClick={onSubmit}
              disabled={editing || !instruction.trim()}
              className="px-3 py-1.5 rounded-lg bg-cl2-burgundy text-white text-[12px] font-semibold hover:bg-cl2-burgundy/90 transition-colors flex items-center gap-1.5 disabled:opacity-40"
            >
              {editing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              {editing ? 'Editando…' : 'Enviar'}
            </button>
          </div>
          {error && (
            <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400 px-2 py-1.5 rounded-md bg-rose-50 dark:bg-rose-900/20">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Slide large preview ─────────────────────────────────────────────
// Reads slide.kind to render a variant. Kept here (not in
// GeneratedAssetNode) because the proportions and density are different
// — the canvas node shows a postage-stamp; this is the editorial canvas.
function SlideLargePreview({ slide, meta }: { slide: AssetSlide; meta: AssetMetadata }) {
  const isSquare = meta.kind === 'carousel';
  return (
    <div
      className={cn(
        'relative mx-auto rounded-2xl bg-white dark:bg-[#222] border border-cl2-burgundy/15 dark:border-cl2-burgundy/25 shadow-md overflow-hidden flex flex-col px-7 py-6',
        isSquare ? 'aspect-square max-w-[460px]' : 'aspect-video max-w-[640px]',
      )}
    >
      {/* Eyebrow */}
      {slide.eyebrow && (
        <p className="text-[10px] uppercase tracking-[0.18em] font-mono text-cl2-burgundy/85">
          {slide.eyebrow}
        </p>
      )}
      {/* Headline — italic burgundy emphasis on the "lead" word, but we
          render the full headline italic for the demo branded look. */}
      <h3 className="mt-1.5 font-display text-[22px] leading-tight text-[#0e1745] dark:text-white italic">
        {slide.headline}
      </h3>
      {/* Variant body */}
      <div className="mt-3 flex-1 min-h-0 flex flex-col text-[13px] leading-relaxed text-[#0e1745]/85 dark:text-white/80">
        {slide.kind === 'stats' && slide.items && (
          <ul className="grid grid-cols-1 gap-3">
            {slide.items.map((it, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 pb-2 border-b border-black/5 dark:border-white/8 last:border-0">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-cl2-burgundy/70">{it.label}</p>
                  {it.sub && <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40">{it.sub}</p>}
                </div>
                <p className="font-display italic text-cl2-burgundy text-[18px] leading-none">{it.value}</p>
              </li>
            ))}
          </ul>
        )}
        {slide.kind === 'list' && slide.items && (
          <ul className="space-y-1.5">
            {slide.items.map((it, i) => (
              <li key={i} className="flex items-start gap-2.5">
                <span className="font-mono text-[10.5px] text-cl2-burgundy/85 mt-0.5">{it.label}</span>
                <span>{it.value}</span>
              </li>
            ))}
          </ul>
        )}
        {slide.kind === 'comparison' && slide.columns && (
          <div className="grid grid-cols-2 gap-3">
            {slide.columns.map((c, i) => (
              <div key={i} className="rounded-xl bg-black/[0.025] dark:bg-white/[0.04] border border-black/6 dark:border-white/8 p-3">
                <p className="font-mono text-[10px] uppercase tracking-wider text-cl2-burgundy/75">{c.head}</p>
                <p className="font-display italic text-[14px] text-[#0e1745] dark:text-white mt-0.5">{c.title}</p>
                <ul className="mt-2 space-y-1 text-[11.5px] text-[#0e1745]/75 dark:text-white/65">
                  {c.bullets.map((b, j) => <li key={j}>· {b}</li>)}
                </ul>
              </div>
            ))}
          </div>
        )}
        {slide.kind === 'quote' && (
          <p className="font-display italic text-[16px] text-[#0e1745]/80 dark:text-white/75 border-l-2 border-cl2-burgundy/60 pl-3 leading-relaxed">
            {slide.body ?? ''}
          </p>
        )}
        {slide.kind === 'alert' && slide.alert && (
          <div className="rounded-xl bg-cl2-burgundy/[0.06] border border-cl2-burgundy/25 p-3.5 flex items-start gap-2.5">
            <AlertGlyph kind={slide.alert.kind} />
            <div className="min-w-0">
              <p className="font-display italic text-cl2-burgundy text-[13px]">{slide.alert.title}</p>
              <p className="mt-1 text-[12.5px] text-[#0e1745]/80 dark:text-white/75">{slide.alert.text}</p>
            </div>
          </div>
        )}
        {(slide.kind === 'cover' || slide.kind === 'section' || slide.kind === 'content' || slide.kind === 'cta') && slide.body && (
          <p>{slide.body}</p>
        )}
      </div>
      {/* Footer meta */}
      {slide.meta && (
        <div className="mt-3 flex items-center justify-between text-[10px] font-mono uppercase tracking-[0.16em] text-[#0e1745]/45 dark:text-white/40 pt-2 border-t border-black/5 dark:border-white/8">
          <span>{slide.meta.footerLeft ?? ''}</span>
          <span>{slide.meta.footerRight ?? ''}</span>
        </div>
      )}
    </div>
  );
}

function AlertGlyph({ kind }: { kind: 'recommendation' | 'warning' | 'note' }) {
  if (kind === 'warning') return <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />;
  if (kind === 'note')    return <Info className="w-4 h-4 text-[#0e1745]/55 shrink-0 mt-0.5" />;
  return <Lightbulb className="w-4 h-4 text-cl2-burgundy shrink-0 mt-0.5" />;
}

// ─── Tab: History ────────────────────────────────────────────────────
function HistoryTab({
  loading, entries, filteredEntries, selectedIdx, onSelectIdx, slideCount,
}: {
  loading: boolean;
  entries: AssetSlideHistoryEntry[];
  filteredEntries: AssetSlideHistoryEntry[];
  selectedIdx: number;
  onSelectIdx: (i: number) => void;
  slideCount: number;
}) {
  // Group entries by slide_idx for the at-a-glance summary on the left.
  const grouped = useMemo(() => {
    const m = new Map<number, AssetSlideHistoryEntry[]>();
    for (const e of entries) {
      const list = m.get(e.slide_idx) ?? [];
      list.push(e);
      m.set(e.slide_idx, list);
    }
    return m;
  }, [entries]);

  return (
    <div className="px-5 py-4 grid grid-cols-[180px_1fr] gap-5">
      {/* Left rail — slide index with edit-count badges */}
      <div className="space-y-1">
        <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-[#0e1745]/55 dark:text-white/45 mb-1.5">Slides</p>
        {Array.from({ length: slideCount }).map((_, idx) => {
          const count = grouped.get(idx)?.length ?? 0;
          const isSel = idx === selectedIdx;
          return (
            <button
              key={idx}
              onClick={() => onSelectIdx(idx)}
              className={cn(
                'w-full flex items-center justify-between px-2.5 py-1.5 rounded-md text-[12px] transition-colors',
                isSel
                  ? 'bg-cl2-burgundy/10 text-cl2-burgundy font-semibold'
                  : 'text-[#0e1745]/65 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/8',
              )}
            >
              <span className="font-mono">{String(idx + 1).padStart(2, '0')}</span>
              {count > 0 && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-cl2-burgundy/15 text-cl2-burgundy">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Right pane — diff entries for the selected slide */}
      <div>
        <p className="text-[10px] font-mono uppercase tracking-[0.16em] text-[#0e1745]/55 dark:text-white/45 mb-2">
          {`Slide ${String(selectedIdx + 1).padStart(2, '0')} · ${filteredEntries.length} ${filteredEntries.length === 1 ? 'edición' : 'ediciones'}`}
        </p>
        {loading && (
          <div className="flex items-center gap-2 text-[12px] text-[#0e1745]/55 dark:text-white/45">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Cargando historial…
          </div>
        )}
        {!loading && filteredEntries.length === 0 && (
          <div className="rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-dashed border-black/10 dark:border-white/10 px-4 py-6 text-center">
            <p className="text-[12.5px] text-[#0e1745]/55 dark:text-white/45 leading-relaxed">
              Este slide todavía no tiene ediciones.<br />
              <span className="italic text-cl2-burgundy/85">Pedile a Atlas un cambio</span> desde la pestaña anterior.
            </p>
          </div>
        )}
        {!loading && filteredEntries.length > 0 && (
          <ol className="space-y-3">
            {filteredEntries.slice().reverse().map((e, i) => (
              <li
                key={`${e.slide_idx}-${e.edited_at}-${i}`}
                className="rounded-xl bg-white dark:bg-[#222] border border-black/8 dark:border-white/10 overflow-hidden"
              >
                <div className="px-3 py-2 flex items-baseline justify-between gap-3 border-b border-black/5 dark:border-white/8">
                  <p className="font-display italic text-[13px] text-cl2-burgundy">"{e.instruction}"</p>
                  <p className="text-[10px] font-mono text-[#0e1745]/45 dark:text-white/35 shrink-0">
                    {formatRelativeAgo(e.edited_at)}
                  </p>
                </div>
                <DiffBlock label="Antes" tone="before" snippet={summarizeBefore(e.before)} />
                <DiffBlock label="Después" tone="after" snippet={summarizeAfter(e.after)} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function DiffBlock({
  label, tone, snippet,
}: {
  label: string; tone: 'before' | 'after'; snippet: string;
}) {
  return (
    <div
      className={cn(
        'px-3 py-2 text-[12px] leading-relaxed border-l-2',
        tone === 'before'
          ? 'bg-rose-50/60 dark:bg-rose-900/15 border-rose-300 text-[#0e1745]/80 dark:text-white/75'
          : 'bg-emerald-50/60 dark:bg-emerald-900/15 border-emerald-400 text-[#0e1745]/85 dark:text-white/85',
      )}
    >
      <p className="text-[9.5px] font-mono uppercase tracking-[0.16em] mb-0.5 opacity-70">{label}</p>
      <p>{snippet}</p>
    </div>
  );
}

function summarizeBefore(b: AssetSlideHistoryEntry['before']): string {
  const parts: string[] = [];
  parts.push(b.headline);
  if (b.body) parts.push(b.body);
  return parts.join(' · ').slice(0, 320);
}
function summarizeAfter(a: AssetSlideHistoryEntry['after']): string {
  return summarizeBefore(a);
}

// ─── Tab: Share ──────────────────────────────────────────────────────
function ShareTab({
  meta, copyState, onCopyUrl, currentSlide, onRegenerate, onDelete,
}: {
  meta: AssetMetadata;
  copyState: 'idle' | 'copied';
  onCopyUrl: () => void;
  currentSlide?: AssetSlide;
  onRegenerate: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="px-5 py-5 space-y-5 max-w-[640px]">
      {/* Public link card — placeholder */}
      <section>
        <h4 className="font-display text-[15px] italic text-cl2-burgundy mb-1">Link público</h4>
        <p className="text-[11.5px] text-[#0e1745]/55 dark:text-white/45 mb-2 leading-relaxed">
          El sistema de permisos por link viene en el próximo sprint. Por ahora podés copiar el URL del archivo generado.
        </p>
        <div className="rounded-xl bg-white dark:bg-[#222] border border-black/8 dark:border-white/10 px-3 py-2.5 flex items-center gap-2">
          <input
            readOnly
            value={meta.export_url || '— pendiente —'}
            className="flex-1 bg-transparent text-[12px] font-mono text-[#0e1745]/75 dark:text-white/65 focus:outline-none truncate"
            onClick={(e) => (e.currentTarget as HTMLInputElement).select()}
          />
          <button
            onClick={onCopyUrl}
            disabled={!meta.export_url}
            className="px-2.5 py-1.5 rounded-md bg-cl2-burgundy/10 hover:bg-cl2-burgundy/20 text-cl2-burgundy text-[11px] font-semibold flex items-center gap-1.5 disabled:opacity-40"
          >
            {copyState === 'copied' ? <Check className="w-3 h-3" /> : <CopyIcon className="w-3 h-3" />}
            {copyState === 'copied' ? 'Copiado' : 'Copiar URL'}
          </button>
        </div>
      </section>

      {/* Direct download */}
      <section>
        <h4 className="font-display text-[15px] italic text-cl2-burgundy mb-1">Descargar</h4>
        <p className="text-[11.5px] text-[#0e1745]/55 dark:text-white/45 mb-2 leading-relaxed">
          {meta.kind === 'docx_asset'   && 'Documento Word listo para enviar por email.'}
          {meta.kind === 'pptx_asset'   && 'Presentación PowerPoint editable, abierta también en gamma.app.'}
          {meta.kind === 'carousel'     && 'PDF del carrusel para subir a LinkedIn como documento.'}
          {meta.kind === 'podcast_asset' && 'MP3 narrado por Lexa, descargable directo.'}
        </p>
        <div className="flex items-center gap-2">
          <a
            href={meta.export_url || '#'}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!meta.export_url}
            className={cn(
              'px-3 py-2 rounded-lg text-[12px] font-semibold flex items-center gap-1.5 transition-colors',
              meta.export_url
                ? 'bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90'
                : 'bg-black/10 text-[#0e1745]/40 pointer-events-none',
            )}
          >
            <Download className="w-3.5 h-3.5" />
            Descargar {meta.kind === 'docx_asset' ? '.docx' : meta.kind === 'pptx_asset' ? '.pptx' : meta.kind === 'podcast_asset' ? '.mp3' : '.pdf'}
          </a>
          {(meta.kind === 'carousel' || meta.kind === 'pptx_asset') && currentSlide && (
            <button
              className="px-3 py-2 rounded-lg bg-white dark:bg-[#222] border border-black/8 dark:border-white/10 text-[12px] font-medium text-[#0e1745]/75 dark:text-white/75 flex items-center gap-1.5 hover:border-cl2-burgundy/30 hover:text-cl2-burgundy transition-colors"
              onClick={async () => {
                // Demo affordance — real impl needs slide → image render.
                // We copy the headline so the action is not silent.
                try {
                  await navigator.clipboard.writeText(currentSlide.headline);
                } catch { /* clipboard blocked */ }
              }}
            >
              <ImageIcon className="w-3.5 h-3.5" />
              Copiar slide actual
            </button>
          )}
        </div>
      </section>

      {/* Regenerate + delete */}
      <section>
        <h4 className="font-display text-[15px] italic text-cl2-burgundy mb-1">Generar otra versión</h4>
        <p className="text-[11.5px] text-[#0e1745]/55 dark:text-white/45 mb-2 leading-relaxed">
          Re-genera el asset completo desde cero. Las ediciones por slide se conservan en el historial.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={onRegenerate}
            className="px-3 py-2 rounded-lg bg-white dark:bg-[#222] border border-cl2-burgundy/30 text-cl2-burgundy text-[12px] font-semibold flex items-center gap-1.5 hover:bg-cl2-burgundy/[0.06]"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Regenerar todo
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              className="ml-auto px-3 py-2 rounded-lg text-rose-600 dark:text-rose-400 text-[12px] font-semibold hover:bg-rose-50 dark:hover:bg-rose-900/20"
            >
              Eliminar asset
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Confirm regenerate modal ────────────────────────────────────────
function ConfirmRegenerateModal({
  slidesCount, kind, running, onCancel, onConfirm,
}: {
  slidesCount: number;
  kind: GeneratedAssetKind;
  running: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const noun = kind === 'docx_asset'
    ? `${slidesCount} ${slidesCount === 1 ? 'página' : 'páginas'}`
    : kind === 'podcast_asset'
      ? 'el audio'
      : `los ${slidesCount} slides`;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 bg-white dark:bg-[#1c1c1c] rounded-2xl shadow-2xl border border-black/8 dark:border-white/10 p-5">
        <h3 className="font-display italic text-[18px] text-cl2-burgundy mb-1">¿Regenerar todo?</h3>
        <p className="text-[12.5px] text-[#0e1745]/70 dark:text-white/60 leading-relaxed">
          Esto regenera <span className="italic">{noun}</span> desde cero. <span className="font-medium">El historial por slide se conserva</span>, pero las versiones actuales serán reemplazadas.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={running}
            className="px-3 py-2 rounded-lg text-[12px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:text-[#0e1745] dark:hover:text-white"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={running}
            className="px-3 py-2 rounded-lg bg-cl2-burgundy text-white text-[12px] font-semibold flex items-center gap-1.5 hover:bg-cl2-burgundy/90 disabled:opacity-60"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
            {running ? 'Regenerando…' : 'Sí, regenerar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function mergeHistory(local: AssetSlideHistoryEntry[], remote: AssetSlideHistoryEntry[]): AssetSlideHistoryEntry[] {
  // Remote wins; if remote is shorter (stale fetch), keep local.
  if (remote.length >= local.length) return remote;
  return local;
}

function formatRelativeAgo(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 5) return 'recién';
  if (sec < 60) return `hace ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr} h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `hace ${d} d`;
  return new Date(ts).toLocaleDateString('es-CR');
}

function formatDuration(sec: number): string {
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * Builds the chat scope_system_prompt fragment for slide-aware Atlas
 * conversations. Exported so the workspace canvas can append it to the
 * existing scope when an asset detail panel is open with a slide selected.
 *
 * The shape mirrors the existing `[Contexto — Hoja seleccionada: ...]`
 * block produced by LexaContextPanel; adding a sibling `[Slide actual
 * seleccionado: ...]` block keeps the LLM's prompt structure consistent.
 */
export function buildSlideScopePrompt(
  asset: GeneratedAssetData,
  slideIdx: number,
): string {
  const slide = asset.asset_slides.find((s) => s.idx === slideIdx);
  if (!slide) return '';
  const meta = asset.asset_metadata;
  const lines: string[] = [];
  lines.push(
    `[Slide actual seleccionado: slide ${slideIdx + 1} de ${meta.slides_count} en el asset ${meta.kind} "${meta.title ?? 'sin título'}"]`,
  );
  if (slide.eyebrow) lines.push(`Eyebrow: ${slide.eyebrow}`);
  lines.push(`Headline: ${slide.headline}`);
  if (slide.body) lines.push(`Body: ${slide.body}`);
  if (slide.items && slide.items.length) {
    lines.push('Items:');
    for (const it of slide.items) lines.push(`  - ${it.label}: ${it.value}${it.sub ? ` (${it.sub})` : ''}`);
  }
  if (slide.columns && slide.columns.length) {
    lines.push('Columns:');
    for (const c of slide.columns) {
      lines.push(`  - ${c.head}: ${c.title}`);
      for (const b of c.bullets) lines.push(`      · ${b}`);
    }
  }
  if (slide.alert) lines.push(`Alert (${slide.alert.kind}): ${slide.alert.title} — ${slide.alert.text}`);
  return lines.join('\n');
}
