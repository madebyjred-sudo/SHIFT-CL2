/**
 * LexaQuickHojaModal — "Pedirle a Lexa que la haga" entry point.
 *
 * Triggered from the canvas right-click menu. The user types a short
 * brief ("hoja sobre las posiciones de cada fracción en el expediente
 * 22918"), Lexa generates a single hoja, and we hand the rendered text
 * back to the caller — which materializes a HojaNode at the click
 * position via the existing createNode pipeline.
 *
 * Why a dedicated component (not just /lexa inline):
 *   • The /lexa inline modal lives inside an editor and inserts at the
 *     caret. Here we have no editor — we want a NEW node.
 *   • Architect endpoint creates 3-6 hojas; user explicitly asked for
 *     a single hoja from the right-click menu. So we use transformText
 *     with action='custom' which returns one block of markdown.
 *
 * Stays out of HojaNode/HojaSlashExtension to avoid colliding with
 * the other agent's Hojas refactor — this is purely a page-level
 * helper composed from existing services.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { transformText } from '@/services/workspaceApi';

interface Props {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** Anchored at the right-click position so the modal feels in-context. */
  anchor?: { x: number; y: number } | null;
  /** Receives { title, md } — caller materializes the node. */
  onResult: (data: { title: string; md: string }) => void | Promise<void>;
}

export function LexaQuickHojaModal({ open, onClose, workspaceId, anchor, onResult }: Props) {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setPrompt('');
    setError(null);
    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !loading) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, loading]);

  const submit = async () => {
    const p = prompt.trim();
    if (!p || loading) return;
    setLoading(true);
    setError(null);
    try {
      // transformText with action='custom' + a sentinel selection ' '
      // is the cheap path: one Lexa call, returns a markdown block.
      // Same convention used by LexaInlineModal in editor /lexa.
      const r = await transformText(workspaceId, {
        selection: ' ',
        action: 'custom',
        instruction: `Escribí una hoja de notas (markdown, encabezados con ##, viñetas) sobre lo siguiente: ${p}. Empezá con un título corto de 5-8 palabras como primer línea (sin "#"), luego una línea en blanco, luego el cuerpo de la hoja.`,
      });
      // First non-empty line is the title; rest is the body. If Lexa
      // returns "# Foo" we strip the heading marker.
      const lines = r.text.split('\n');
      let title = '';
      let bodyStart = 0;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t) {
          title = t.replace(/^#+\s*/, '').slice(0, 80);
          bodyStart = i + 1;
          break;
        }
      }
      const md = lines.slice(bodyStart).join('\n').trim();
      await onResult({ title: title || 'Hoja de Lexa', md: md || r.text });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  // Anchor near the right-click position when given, but clamp so the
  // 480-wide card stays on-screen. Falls back to centered.
  const W = 480;
  const HEIGHT_GUESS = 220;
  let style: React.CSSProperties;
  if (anchor) {
    const margin = 16;
    const x = Math.min(Math.max(anchor.x, margin), window.innerWidth - W - margin);
    const y = Math.min(Math.max(anchor.y, margin), window.innerHeight - HEIGHT_GUESS - margin);
    style = { top: y, left: x, width: W };
  } else {
    style = { top: '40%', left: '50%', transform: 'translate(-50%, -50%)', width: W };
  }

  return (
    <AnimatePresence>
      <motion.div
        key="bd"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => !loading && onClose()}
        className="fixed inset-0 z-[280] bg-black/30"
      />
      <motion.div
        key="md"
        initial={{ opacity: 0, y: -8, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.97 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        style={style}
        className="fixed z-[281] rounded-xl border border-cl2-burgundy/[0.18] dark:border-white/[0.10] bg-white dark:bg-[#1c1c1c] shadow-[0_20px_50px_rgba(122,59,71,0.28),0_4px_14px_rgba(122,59,71,0.12)]"
      >
        <div className="flex items-center gap-2.5 px-3.5 pt-3 pb-2">
          <span className="inline-flex items-center justify-center w-6 h-6 rounded-md bg-cl2-burgundy/10 text-cl2-burgundy dark:text-[#d8a4ad]">
            <Sparkles size={13} />
          </span>
          <span className="text-[12.5px] font-semibold text-[#0e1745] dark:text-white">
            Pedile a Lexa una hoja
          </span>
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="ml-auto p-1 rounded text-[#0e1745]/45 dark:text-white/45 hover:bg-[#0e1745]/[0.05] dark:hover:bg-white/[0.05] disabled:opacity-40"
            aria-label="Cerrar"
          >
            <X size={14} />
          </button>
        </div>
        <div className="px-3.5 pb-3">
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={3}
            placeholder="Ej: hoja con las 3 posiciones principales sobre el expediente 22918, con argumentos clave de cada fracción."
            disabled={loading}
            className="w-full resize-none rounded-md bg-[#0e1745]/[0.03] dark:bg-white/[0.04] border border-[#0e1745]/[0.08] dark:border-white/[0.08] px-2.5 py-2 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/35 focus:outline-none focus:border-cl2-burgundy/40"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10.5px] text-[#0e1745]/45 dark:text-white/45">
              Enter para enviar · Shift+Enter para nueva línea
            </span>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!prompt.trim() || loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cl2-burgundy text-white text-[12px] font-semibold hover:bg-cl2-burgundy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {loading ? 'Lexa escribiendo…' : 'Generar hoja'}
            </button>
          </div>
          {error && (
            <div className="mt-2 rounded-md bg-rose-50 dark:bg-rose-900/20 border border-rose-300/40 dark:border-rose-500/30 px-2.5 py-1.5 text-[11.5px] text-rose-700 dark:text-rose-300">
              {error}
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
