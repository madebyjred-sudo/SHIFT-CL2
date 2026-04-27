/**
 * SendToWorkspaceModal — reusable "send to a Hojas workspace" picker.
 *
 * Used by:
 *   - SesionViewPage     → enviar la sesión completa
 *   - SesionesListPage   → enviar varias sesiones seleccionadas
 *   - ExpedienteViewPage → enviar el expediente completo
 *
 * UX:
 *   1. Modal lists user's existing workspaces + a "+ nuevo workspace" row
 *      at the top.
 *   2. Picking a workspace runs importSourcesIntoWorkspace(); on success
 *      we navigate the user there so they immediately see the new hojas.
 *   3. Picking "nuevo" shows an inline title input → createWorkspace()
 *      then re-uses the import flow.
 *
 * Differs from WorkspacePickerModal: that one's for the chat panel's
 * "attach context" feature (read-only). This one writes new nodes.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Layers, Loader2, Plus, X, ArrowRight, AlertCircle, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  createWorkspace,
  importSourcesIntoWorkspace,
  listWorkspaces,
  type ImportSource,
  type Workspace,
} from '@/services/workspaceApi';
import { navigate } from '@/lib/router';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Sources the user wants to send. 1-25 items per call (server cap). */
  sources: ImportSource[];
  /** Optional friendly label shown in the modal header.
   *  e.g. "1 sesión", "3 sesiones", "Expediente 22.918". */
  summary?: string;
}

type Phase = 'pick' | 'naming' | 'sending' | 'done' | 'error';

export function SendToWorkspaceModal({ open, onClose, sources, summary }: Props) {
  const [items, setItems] = useState<Workspace[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [phase, setPhase] = useState<Phase>('pick');
  const [newTitle, setNewTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resultCount, setResultCount] = useState(0);
  const [resultErrors, setResultErrors] = useState<number>(0);
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string | null>(null);

  // Reset on open + load workspaces
  useEffect(() => {
    if (!open) return;
    setPhase('pick');
    setError(null);
    setNewTitle('');
    setResultCount(0);
    setResultErrors(0);
    setTargetWorkspaceId(null);
    setLoadingList(true);
    listWorkspaces(false)
      .then((ws) => setItems(ws))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoadingList(false));
  }, [open]);

  // ESC closes (when not mid-send)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'sending') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, phase]);

  const sendTo = async (workspaceId: string) => {
    if (sources.length === 0) {
      setError('No hay fuentes para enviar.');
      setPhase('error');
      return;
    }
    setPhase('sending');
    setError(null);
    setTargetWorkspaceId(workspaceId);
    try {
      const result = await importSourcesIntoWorkspace(workspaceId, sources);
      setResultCount(result.nodes.length);
      setResultErrors(result.errors.length);
      setPhase('done');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  const createAndSend = async () => {
    const t = newTitle.trim();
    if (!t) return;
    setPhase('sending');
    setError(null);
    try {
      const ws = await createWorkspace(t, '');
      setTargetWorkspaceId(ws.id);
      const result = await importSourcesIntoWorkspace(ws.id, sources);
      setResultCount(result.nodes.length);
      setResultErrors(result.errors.length);
      setPhase('done');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  };

  const goToWorkspace = () => {
    if (targetWorkspaceId) navigate(`/hojas/${targetWorkspaceId}`);
    onClose();
  };

  if (!open) return null;

  const sourceLabel = summary
    ?? (sources.length === 1
      ? '1 fuente'
      : `${sources.length} fuentes`);

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="bd"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => phase !== 'sending' && onClose()}
        className="fixed inset-0 z-[300] bg-black/45 backdrop-blur-sm"
      />
      <motion.div
        key="md"
        initial={{ opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.97 }}
        transition={{ duration: 0.20, ease: [0.22, 1, 0.36, 1] }}
        className="fixed left-1/2 top-1/2 z-[301] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white dark:bg-[#1c1c1c] border border-cl2-burgundy/[0.10] dark:border-white/[0.08] shadow-[0_30px_80px_rgba(122,59,71,0.28),0_8px_24px_rgba(122,59,71,0.14)] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[#0e1745]/[0.06] dark:border-white/[0.06]">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-cl2-burgundy/10 text-cl2-burgundy dark:text-[#d8a4ad]">
            <Layers size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="font-display text-[18px] tracking-tight text-[#0e1745] dark:text-white">
              Enviar a un workspace
            </div>
            <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55 truncate">
              {sourceLabel} → una hoja por fuente
            </div>
          </div>
          {phase !== 'sending' && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] text-[#0e1745]/60 dark:text-white/60"
              aria-label="Cerrar"
            >
              <X size={16} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-2 py-2 max-h-[60vh] overflow-y-auto">
          {phase === 'pick' && (
            <>
              {/* New workspace row — always at top */}
              <button
                type="button"
                onClick={() => setPhase('naming')}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-cl2-burgundy/[0.06] dark:hover:bg-cl2-accent/[0.10] transition-colors text-left"
              >
                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-cl2-burgundy/[0.10] text-cl2-burgundy dark:text-[#d8a4ad]">
                  <Plus size={14} />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                    Nuevo workspace
                  </div>
                  <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                    Crea uno desde cero con esto adentro
                  </div>
                </div>
                <ArrowRight size={14} className="text-[#0e1745]/40 dark:text-white/40" />
              </button>

              {items.length > 0 && (
                <div className="my-1.5 mx-3 h-px bg-[#0e1745]/[0.06] dark:bg-white/[0.06]" />
              )}

              {loadingList && (
                <div className="px-4 py-6 text-center text-[12.5px] text-[#0e1745]/45 dark:text-white/40">
                  <Loader2 size={14} className="inline-block mr-2 animate-spin" />
                  Cargando workspaces…
                </div>
              )}

              {!loadingList && items.length === 0 && (
                <div className="px-4 py-6 text-center text-[12.5px] text-[#0e1745]/45 dark:text-white/40">
                  No tenés workspaces — creá uno arriba.
                </div>
              )}

              {!loadingList && items.map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => void sendTo(ws.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-cl2-burgundy/[0.06] dark:hover:bg-cl2-accent/[0.10] transition-colors text-left"
                >
                  <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[#0e1745]/[0.05] dark:bg-white/[0.06] text-[#0e1745]/60 dark:text-white/60">
                    <Layers size={14} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white truncate">
                      {ws.title}
                    </div>
                    <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                      {ws.node_count} hoja{ws.node_count !== 1 ? 's' : ''}
                      {ws.description ? ` · ${ws.description.slice(0, 60)}` : ''}
                    </div>
                  </div>
                  <ArrowRight size={14} className="text-[#0e1745]/40 dark:text-white/40" />
                </button>
              ))}
            </>
          )}

          {phase === 'naming' && (
            <div className="px-3 py-3 space-y-3">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-[#0e1745]/55 dark:text-white/55">
                Nombre del workspace
              </div>
              <input
                autoFocus
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newTitle.trim()) {
                    e.preventDefault();
                    void createAndSend();
                  }
                }}
                placeholder="Ej: Plenario 11 marzo · análisis"
                className="w-full px-3 py-2 rounded-md border border-[#0e1745]/[0.10] dark:border-white/[0.10] bg-transparent text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/35 focus:outline-none focus:border-cl2-burgundy/40"
              />
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setPhase('pick')}
                  className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
                >
                  Volver
                </button>
                <button
                  type="button"
                  disabled={!newTitle.trim()}
                  onClick={() => void createAndSend()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-cl2-burgundy hover:bg-cl2-burgundy/90 disabled:opacity-40 text-white text-[12.5px] font-semibold"
                >
                  <Plus size={13} />
                  Crear y enviar
                </button>
              </div>
            </div>
          )}

          {phase === 'sending' && (
            <div className="px-4 py-10 text-center space-y-2">
              <Loader2 size={20} className="inline-block animate-spin text-cl2-burgundy" />
              <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                Importando…
              </div>
              <div className="text-[11px] text-[#0e1745]/55 dark:text-white/55">
                {sourceLabel} → workspace
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="px-4 py-6 text-center space-y-3">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <Check size={18} />
              </span>
              <div className="text-[14px] font-semibold text-[#0e1745] dark:text-white">
                {resultCount} hoja{resultCount !== 1 ? 's' : ''} creada{resultCount !== 1 ? 's' : ''}
              </div>
              {resultErrors > 0 && (
                <div className="inline-flex items-center gap-1 text-[11.5px] text-amber-700 dark:text-amber-400">
                  <AlertCircle size={11} /> {resultErrors} fuente{resultErrors !== 1 ? 's' : ''} no se pudo importar
                </div>
              )}
              <div className="pt-1 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
                >
                  Cerrar
                </button>
                <button
                  type="button"
                  onClick={goToWorkspace}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-cl2-burgundy hover:bg-cl2-burgundy/90 text-white text-[12.5px] font-semibold"
                >
                  Abrir workspace <ArrowRight size={13} />
                </button>
              </div>
            </div>
          )}

          {phase === 'error' && (
            <div className="px-4 py-6 text-center space-y-3">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-400">
                <AlertCircle size={18} />
              </span>
              <div className="text-[13px] text-[#0e1745] dark:text-white">
                No se pudo importar.
              </div>
              <div className="text-[11.5px] font-mono text-rose-700 dark:text-rose-300 break-words">
                {error ?? 'error desconocido'}
              </div>
              <div className="pt-1 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setPhase('pick')}
                  className="px-3 py-1.5 rounded-md text-[12.5px] font-medium text-[#0e1745]/65 dark:text-white/65 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05]"
                >
                  Reintentar
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-[12.5px] font-semibold bg-[#0e1745] dark:bg-white/15 text-white"
                >
                  Cerrar
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer hint — only on pick phase */}
        {phase === 'pick' && (
          <div className="px-4 py-2 border-t border-[#0e1745]/[0.06] dark:border-white/[0.06] bg-[#0e1745]/[0.02] dark:bg-white/[0.02] text-[10.5px] text-[#0e1745]/45 dark:text-white/40 flex items-center justify-between">
            <span>{sources.length} fuente{sources.length !== 1 ? 's' : ''} a importar</span>
            <span>cada una será una hoja editable</span>
          </div>
        )}
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
