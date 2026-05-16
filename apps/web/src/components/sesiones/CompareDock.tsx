/**
 * Compare dock — sticky bottom bar que aparece cuando hay >0 plenarias
 * seleccionadas. El "abrir comparación" queda como stub para post-demo
 * (el modal de diff es 20h+ y excede el sprint).
 */
import { motion, AnimatePresence } from 'motion/react';
import { Layers, X } from 'lucide-react';

interface Props {
  ids: Array<number | string>;
  onClear: () => void;
  onCompare: (ids: Array<number | string>) => void;
  /** Optional: when set, renders a "Enviar a workspace" CTA next to
   *  Comparar. Click pushes the selected ids up so the page can open
   *  its SendToWorkspaceModal. */
  onSendToWorkspace?: (ids: Array<number | string>) => void;
}

export function CompareDock({ ids, onClear, onCompare, onSendToWorkspace }: Props) {
  return (
    <AnimatePresence>
      {ids.length > 0 && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', damping: 22, stiffness: 200 }}
          className="fixed left-1/2 bottom-5 z-50 -translate-x-1/2 inline-flex items-center gap-3.5 rounded-xl px-4 py-2.5 text-white shadow-[0_12px_35px_rgba(61,24,32,0.30)]"
          style={{ background: '#3D1820' }}
        >
          <div className="flex">
            {ids.slice(0, 4).map((id, i) => (
              <span
                key={id}
                className="w-7 h-7 rounded-md border-2 border-[#3D1820] bg-white/10 font-mono text-[10px] inline-flex items-center justify-center text-white/70"
                style={{ marginLeft: i === 0 ? 0 : -8 }}
              >
                #{id}
              </span>
            ))}
            {ids.length > 4 && (
              <span
                className="w-7 h-7 rounded-md border-2 border-[#3D1820] bg-white/10 font-mono text-[10px] inline-flex items-center justify-center text-white/70"
                style={{ marginLeft: -8 }}
              >
                +{ids.length - 4}
              </span>
            )}
          </div>
          <span className="text-[12.5px] font-medium">
            {ids.length} {ids.length === 1 ? 'plenaria seleccionada' : 'plenarias seleccionadas'}
          </span>
          {onSendToWorkspace && (
            <button
              type="button"
              onClick={() => onSendToWorkspace(ids)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-[12.5px] font-semibold transition-colors"
              title="Enviar las sesiones seleccionadas a un workspace"
            >
              <Layers size={13} />
              A workspace
            </button>
          )}
          <button
            type="button"
            onClick={() => onCompare(ids)}
            disabled={ids.length < 2}
            className="px-3.5 py-1.5 rounded-lg bg-cl2-accent hover:bg-cl2-accent-hover text-white text-[12.5px] font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={ids.length < 2 ? 'Seleccioná al menos dos para comparar' : 'Comparar'}
          >
            Comparar
          </button>
          <button
            type="button"
            onClick={onClear}
            aria-label="Limpiar selección"
            className="p-1 rounded-md text-white/60 hover:text-white transition-colors"
          >
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
