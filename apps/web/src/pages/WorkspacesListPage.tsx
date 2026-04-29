/**
 * WorkspacesListPage — /hojas
 *
 * Grid of workspace cards. Archive, rename, delete, create new.
 * Mirrors the SilBrowsePage layout (TopDock + hero strip + card grid).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, BookOpen, Archive, Trash2, MoreHorizontal,
  LayoutGrid, Clock, CheckSquare, FileDown, FileText, Upload, Presentation,
} from 'lucide-react';
import { TopDock } from '@/components/top-dock';
import { navigate } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace, exportWorkspace, importAsset,
  type Workspace, type PptxExportResult,
} from '@/services/workspaceApi';
import { PptxResultModal } from '@/components/workspace/PptxResultModal';

// ─── Relative time helper ────────────────────────────────────────────
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours}h`;
  return `hace ${Math.floor(hours / 24)}d`;
}

// ─── Workspace card ──────────────────────────────────────────────────
function WorkspaceCard({
  ws, onOpen, onRename, onArchive, onDelete,
}: {
  ws: Workspace;
  onOpen: () => void;
  onRename: (title: string) => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(ws.title);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState<'md' | 'docx' | 'pptx' | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // PPTX modal state. The modal owns the loading / ready / error display so
  // the user always sees what's happening — no auto-downloads, no popup blocks.
  const [pptxModal, setPptxModal] = useState<{
    open: boolean;
    state: 'loading' | 'ready' | 'error';
    result?: PptxExportResult;
    errorMessage?: string;
    errorCode?: string;
  } | null>(null);

  const commitRename = () => {
    if (draft.trim() && draft !== ws.title) onRename(draft.trim());
    setRenaming(false);
  };

  // Internal: run a pptx export attempt and drive the modal state.
  // `force=true` bypasses the server-side 1h cache.
  const runPptxExport = async (force: boolean) => {
    setPptxModal({ open: true, state: 'loading' });
    setMenuOpen(false);
    try {
      const result = (await exportWorkspace(ws.id, 'pptx', ws.title, { force })) as PptxExportResult;
      setPptxModal({ open: true, state: 'ready', result });
    } catch (err) {
      const e = err as Error & { code?: string };
      setPptxModal({
        open: true,
        state: 'error',
        errorMessage: e.message,
        errorCode: e.code,
      });
    }
  };

  const handleExport = async (format: 'md' | 'docx' | 'pptx') => {
    if (exporting) return;
    if (format === 'pptx') {
      // Modal-driven flow — don't block the menu via `exporting` so other
      // hovers stay snappy. The modal blocks input on its own.
      void runPptxExport(false);
      return;
    }
    setExporting(format);
    try {
      await exportWorkspace(ws.id, format, ws.title);
    } catch {
      // MD/DOCX failures are effectively impossible (synchronous local
      // generation); swallow rather than surface noise.
    } finally {
      setExporting(null);
      setMenuOpen(false);
    }
  };

  const handleImportClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError(null);
    try {
      await importAsset(ws.id, file);
      // Open the workspace so the user sees the new node land on the canvas
      navigate(`/hojas/${ws.id}`);
    } catch (err) {
      setImportError((err as Error).message);
      setTimeout(() => setImportError(null), 4000);
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div
      onClick={() => !menuOpen && !renaming && onOpen()}
      className="group relative flex flex-col gap-3 p-5 rounded-2xl bg-white dark:bg-white/[0.04] border border-black/8 dark:border-white/8 hover:border-cl2-accent/30 hover:shadow-md dark:hover:shadow-black/30 transition-all cursor-pointer"
    >
      {/* Hidden file input — triggered from "Importar archivo" menu item.
          Accepted MIME mirrors the server-side allowlist. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
        className="hidden"
        onChange={handleFileChosen}
        onClick={(e) => e.stopPropagation()}
      />

      {/* Inline import error toast */}
      {importError && (
        <div className="absolute -top-1 left-2 right-2 z-10 px-3 py-1.5 rounded-md bg-red-500 text-white text-[11px] font-medium shadow-lg">
          {importError}
        </div>
      )}
      {/* Color accent line */}
      <div className="absolute top-0 left-5 right-5 h-[2px] rounded-b-full bg-gradient-to-r from-cl2-burgundy/40 via-cl2-accent/30 to-transparent" />

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="w-10 h-10 rounded-xl bg-cl2-burgundy/10 dark:bg-cl2-burgundy/20 flex items-center justify-center shrink-0">
          <BookOpen className="w-5 h-5 text-cl2-burgundy" />
        </div>

        {/* Menu */}
        <div className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-black/8 dark:hover:bg-white/10 transition-all text-[#0e1745]/50 dark:text-white/50"
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-8 z-50 w-40 rounded-xl bg-white dark:bg-[#1c1c1c] shadow-xl border border-black/8 dark:border-white/10 py-1"
              onClick={(e) => e.stopPropagation()}
            >
              <button onClick={() => { setRenaming(true); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors">Renombrar</button>
              <button onClick={() => { onArchive(); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2">
                <Archive className="w-3.5 h-3.5 text-[#0e1745]/50 dark:text-white/50" />
                {ws.archived ? 'Restaurar' : 'Archivar'}
              </button>

              {/* ── Import ─────────────────────────────────────────── */}
              <div className="border-t border-black/6 dark:border-white/8 my-1" />
              <button
                onClick={handleImportClick}
                disabled={importing}
                className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <Upload className="w-3.5 h-3.5 text-cl2-burgundy" />
                {importing ? 'Importando…' : 'Importar archivo'}
              </button>

              {/* ── Export submenu ─────────────────────────────────── */}
              <div className="border-t border-black/6 dark:border-white/8 my-1" />
              <button
                onClick={() => handleExport('pptx')}
                disabled={pptxModal?.state === 'loading'}
                className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <Presentation className="w-3.5 h-3.5 text-cl2-burgundy" />
                Generar presentación
              </button>
              <button
                onClick={() => handleExport('docx')}
                disabled={exporting !== null}
                className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <FileDown className="w-3.5 h-3.5 text-cl2-burgundy" />
                {exporting === 'docx' ? 'Exportando…' : 'Exportar a Word'}
              </button>
              <button
                onClick={() => handleExport('md')}
                disabled={exporting !== null}
                className="w-full text-left px-3 py-2 text-[13px] hover:bg-black/5 dark:hover:bg-white/8 transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                <FileText className="w-3.5 h-3.5 text-[#0e1745]/50 dark:text-white/50" />
                {exporting === 'md' ? 'Exportando…' : 'Exportar a Markdown'}
              </button>

              <div className="border-t border-black/6 dark:border-white/8 my-1" />
              {!confirmDelete ? (
                <button onClick={() => setConfirmDelete(true)} className="w-full text-left px-3 py-2 text-[13px] text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex items-center gap-2">
                  <Trash2 className="w-3.5 h-3.5" /> Eliminar
                </button>
              ) : (
                <button onClick={() => { onDelete(); setMenuOpen(false); }} className="w-full text-left px-3 py-2 text-[13px] text-red-600 font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">¿Confirmar?</button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Title */}
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
          onClick={(e) => e.stopPropagation()}
          className="font-display text-[17px] font-semibold bg-transparent border-b border-cl2-accent focus:outline-none text-[#0e1745] dark:text-white w-full"
        />
      ) : (
        <p className="font-display text-[17px] font-semibold text-[#0e1745] dark:text-white leading-snug line-clamp-2">
          {ws.title}
        </p>
      )}

      {/* Meta */}
      <div className="flex items-center justify-between mt-auto">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-cl2-accent/8 text-[11px] font-medium text-cl2-accent">
            <LayoutGrid className="w-3 h-3" />
            {ws.node_count} {ws.node_count === 1 ? 'hoja' : 'hojas'}
          </span>
          {ws.archived && (
            <span className="px-2 py-0.5 rounded-full bg-[#0e1745]/8 dark:bg-white/8 text-[11px] text-[#0e1745]/60 dark:text-white/60">
              archivado
            </span>
          )}
        </div>
        <span className="text-[11px] text-[#0e1745]/40 dark:text-white/35 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {relativeTime(ws.updated_at)}
        </span>
      </div>

      {/* PPTX result modal — global to this card; only one card at a time
          can be in pptx flight. */}
      {pptxModal && (
        <PptxResultModal
          open={pptxModal.open}
          onClose={() => setPptxModal(null)}
          state={pptxModal.state}
          result={pptxModal.result}
          errorMessage={pptxModal.errorMessage}
          errorCode={pptxModal.errorCode}
          workspaceTitle={ws.title}
          onRegenerate={() => runPptxExport(true)}
        />
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────
export function WorkspacesListPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listWorkspaces(showArchived);
      setWorkspaces(items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      const ws = await createWorkspace('Mi espacio');
      navigate(`/hojas/${ws.id}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  };

  const handleRename = async (id: string, title: string) => {
    await updateWorkspace(id, { title }).catch(() => null);
    setWorkspaces((prev) => prev.map((w) => w.id === id ? { ...w, title } : w));
  };

  const handleArchive = async (id: string, archived: boolean) => {
    await updateWorkspace(id, { archived }).catch(() => null);
    if (!showArchived) setWorkspaces((prev) => prev.filter((w) => w.id !== id));
    else setWorkspaces((prev) => prev.map((w) => w.id === id ? { ...w, archived } : w));
  };

  const handleDelete = async (id: string) => {
    await deleteWorkspace(id).catch(() => null);
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
  };

  const active = workspaces.filter((w) => !w.archived);
  const archived = workspaces.filter((w) => w.archived);

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-mesh text-[#0e1745] dark:text-white font-sans">
      {/* Dotted overlay */}
      <div className="pointer-events-none fixed inset-0 bg-pixel-dots opacity-50 z-0" />

      <div className="relative z-10 max-w-[1320px] mx-auto w-full flex flex-col flex-1 px-4 sm:px-6">
        <TopDock />

        {/* ── Hero ───────────────────────────────────────────────── */}
        <div className="pt-10 pb-8">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-accent/80 mb-2">
            Hojas de trabajo
          </p>
          <h1 className="font-display text-[36px] sm:text-[44px] font-semibold leading-tight text-[#0e1745] dark:text-white">
            Mis espacios legislativos
          </h1>
          <p className="mt-2 text-[15px] text-[#0e1745]/55 dark:text-white/50 max-w-xl">
            Canvases donde cada nodo es una página de análisis. Lexa escribe dentro de ellas.
          </p>

          {/* KPI strip */}
          <div className="mt-6 flex flex-wrap gap-3">
            {[
              { icon: <LayoutGrid className="w-4 h-4" />, label: 'Espacios', value: active.length },
              { icon: <CheckSquare className="w-4 h-4" />, label: 'Hojas totales', value: workspaces.reduce((s, w) => s + w.node_count, 0) },
              { icon: <Archive className="w-4 h-4" />, label: 'Archivados', value: archived.length },
            ].map(({ icon, label, value }) => (
              <div key={label} className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-white dark:bg-white/[0.05] border border-black/8 dark:border-white/8">
                <span className="text-cl2-accent/70">{icon}</span>
                <div>
                  <p className="text-[20px] font-semibold font-display leading-none">{value}</p>
                  <p className="text-[11px] text-[#0e1745]/50 dark:text-white/45 mt-0.5">{label}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Toolbar ────────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <button
            onClick={() => setShowArchived((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors',
              showArchived
                ? 'bg-[#0e1745]/10 dark:bg-white/10 text-[#0e1745] dark:text-white'
                : 'text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white',
            )}
          >
            <Archive className="w-3.5 h-3.5" />
            {showArchived ? 'Ocultar archivados' : 'Ver archivados'}
          </button>

          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-cl2-accent text-white text-[13px] font-semibold hover:bg-cl2-accent-hover transition-colors disabled:opacity-60 shadow-sm shadow-cl2-accent/25"
          >
            <Plus className="w-4 h-4" />
            {creating ? 'Creando…' : 'Nuevo espacio'}
          </button>
        </div>

        {/* ── Error ──────────────────────────────────────────────── */}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-600 text-[13px]">{error}</div>
        )}

        {/* ── Grid ───────────────────────────────────────────────── */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-44 rounded-2xl bg-white dark:bg-white/[0.04] border border-black/8 dark:border-white/8 animate-pulse" />
            ))}
          </div>
        ) : workspaces.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-cl2-burgundy/10 flex items-center justify-center">
              <BookOpen className="w-8 h-8 text-cl2-burgundy/60" />
            </div>
            <p className="text-[16px] font-semibold text-[#0e1745]/60 dark:text-white/50">Todavía no tenés espacios</p>
            <p className="text-[13px] text-[#0e1745]/40 dark:text-white/35">Creá uno para empezar a trabajar con Lexa en el canvas</p>
            <button onClick={handleCreate} disabled={creating} className="mt-2 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-cl2-accent text-white text-[13px] font-semibold hover:bg-cl2-accent-hover transition-colors">
              <Plus className="w-4 h-4" /> Crear primer espacio
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-12">
              {workspaces.map((ws) => (
                <WorkspaceCard
                  key={ws.id}
                  ws={ws}
                  onOpen={() => navigate(`/hojas/${ws.id}`)}
                  onRename={(title) => handleRename(ws.id, title)}
                  onArchive={() => handleArchive(ws.id, !ws.archived)}
                  onDelete={() => handleDelete(ws.id)}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
