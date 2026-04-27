/**
 * LexaInlineModal — `/lexa` slash command's inline prompt input.
 *
 * Floats over the editor near the caret. User types an instruction
 * ("hace una tabla comparativa", "explicame esta moción"), Enter sends to
 * /api/workspace/:id/transform with action='custom', a 1-2s loader spins,
 * and the result is inserted at the caret on confirm.
 *
 * Reuses the /transform endpoint we built in Eje 2 — no new backend.
 *
 * Two states:
 *   prompt    — input + Enter to run
 *   preview   — result shown, "Insertar" / "Reescribir" / "Descartar"
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Loader2, Check, X, RefreshCw } from 'lucide-react';
import { transformText } from '@/services/workspaceApi';

interface Props {
  workspaceId: string;
  open: boolean;
  initialPrompt?: string;
  /** Anchor point where the popup should float (caret rect at trigger time). */
  anchor: { top: number; left: number } | null;
  /** Called with the chosen text when the user confirms. */
  onAccept: (text: string) => void;
  onClose: () => void;
}

type Mode = 'prompt' | 'transforming' | 'preview';

export function LexaInlineModal({ workspaceId, open, initialPrompt = '', anchor, onAccept, onClose }: Props) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [mode, setMode] = useState<Mode>('prompt');
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPrompt(initialPrompt);
      setMode('prompt');
      setResult('');
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, initialPrompt]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const run = async (instruction: string) => {
    if (!instruction.trim()) return;
    setMode('transforming');
    setError(null);
    try {
      // We use 'custom' action; the transform endpoint accepts an empty
      // selection and treats `instruction` as the full directive.
      const r = await transformText(workspaceId, {
        selection: ' ',  // backend requires non-empty; space is treated as no context
        action: 'custom',
        instruction,
      });
      setResult(r.text);
      setMode('preview');
    } catch (err) {
      setError((err as Error).message);
      setMode('prompt');
    }
  };

  if (!open || !anchor) return null;

  // Position with viewport clamping
  const WIDTH = 460;
  let left = anchor.left;
  let top = anchor.top;
  if (left + WIDTH > window.innerWidth - 16) left = window.innerWidth - WIDTH - 16;
  if (left < 16) left = 16;
  if (top + 200 > window.innerHeight - 16) top = window.innerHeight - 220;

  return createPortal(
    <div
      className="fixed z-[260]"
      style={{ top, left, width: WIDTH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* PROMPT */}
      {mode === 'prompt' && (
        <div className="rounded-xl bg-white dark:bg-[#1c1c1c] border border-cl2-burgundy/30 shadow-2xl p-2 flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-cl2-burgundy shrink-0 ml-1" />
          <input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && prompt.trim()) run(prompt.trim());
            }}
            placeholder="Pedile a Lexa que escriba… (ej: tabla comparativa de los 3 proyectos sobre IA)"
            className="flex-1 bg-transparent text-[13px] text-[#0e1745] dark:text-white placeholder:text-black/30 dark:placeholder:text-white/30 focus:outline-none"
          />
          <button
            onClick={() => run(prompt.trim())}
            disabled={!prompt.trim()}
            className="px-2.5 py-1 rounded-md bg-cl2-burgundy text-white text-[11px] font-semibold disabled:opacity-40 hover:bg-cl2-burgundy/90 transition-colors flex items-center gap-1"
          >
            <Sparkles className="w-3 h-3" /> Lexa
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/5 text-[#0e1745]/40 dark:text-white/40"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* TRANSFORMING */}
      {mode === 'transforming' && (
        <div className="rounded-xl bg-white dark:bg-[#1c1c1c] border border-cl2-burgundy/30 shadow-2xl px-3 py-3 flex items-center gap-2.5">
          <Loader2 className="w-4 h-4 text-cl2-burgundy animate-spin" />
          <p className="text-[12.5px] text-cl2-burgundy font-semibold">Lexa está pensando…</p>
        </div>
      )}

      {/* PREVIEW */}
      {mode === 'preview' && (
        <div className="rounded-xl bg-white dark:bg-[#1c1c1c] border border-emerald-300/40 dark:border-emerald-700/40 shadow-2xl overflow-hidden">
          <div className="px-3 py-2 bg-emerald-50/70 dark:bg-emerald-950/30 border-b border-emerald-200/40 dark:border-emerald-800/30 text-[10.5px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles className="w-3 h-3" />
            Propuesta de Lexa
          </div>
          <div className="px-3 py-2.5 max-h-[200px] overflow-y-auto">
            <p className="text-[12.5px] text-[#0e1745] dark:text-white whitespace-pre-wrap leading-relaxed">
              {result}
            </p>
          </div>
          <div className="px-2 py-1.5 bg-black/[0.02] dark:bg-white/[0.02] border-t border-black/5 dark:border-white/5 flex items-center justify-end gap-1">
            <button
              onClick={() => { setMode('prompt'); setResult(''); }}
              className="px-2 py-1 rounded-md text-[11px] text-[#0e1745]/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" /> Reescribir
            </button>
            <button
              onClick={() => { onClose(); setResult(''); }}
              className="px-2 py-1 rounded-md text-[11px] text-[#0e1745]/60 dark:text-white/60 hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Descartar
            </button>
            <button
              onClick={() => { onAccept(result); onClose(); }}
              className="px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold transition-colors flex items-center gap-1"
            >
              <Check className="w-3 h-3" /> Insertar
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-1 px-2 py-1 rounded-md bg-red-50 dark:bg-red-900/20 text-red-600 text-[10.5px] text-center">
          {error}
        </div>
      )}
    </div>,
    document.body,
  );
}

// ─── Templates for `/template` ────────────────────────────────────────
//
// These are pre-canned skeletons inserted as plain markdown. The user
// fills in the bracketed placeholders. We export from this file because
// the slash command pipeline lives in HojaSlashExtension which only
// imports here — keeps the wire short.

export type TemplateKind = 'analisis' | 'comparativo' | 'cronologia';

export const TEMPLATES: Record<TemplateKind, { label: string; subtitle: string; md: string }> = {
  analisis: {
    label: 'Análisis de proyecto',
    subtitle: 'Resumen ejecutivo + actores + impacto + recomendación',
    md: `## Resumen ejecutivo
[Descripción del proyecto en 2-3 oraciones]

## Actores principales
- **Proponente:** [Nombre]
- **Comisión:** [Comisión técnica]
- **Bancadas a favor:** [Lista]
- **Bancadas en contra:** [Lista]

## Análisis de impacto
[Análisis técnico]

## Riesgos y oportunidades
- [Riesgo 1]
- [Oportunidad 1]

## Recomendación
[Posición sugerida]`,
  },
  comparativo: {
    label: 'Comparativo entre proyectos',
    subtitle: 'Tabla comparativa de ejes clave',
    md: `## Comparativo

### Proyectos analizados
1. [Exp. N° X.XXX] — [Título]
2. [Exp. N° X.XXX] — [Título]

### Eje 1: Alcance
- Proyecto 1: [...]
- Proyecto 2: [...]

### Eje 2: Mecanismo
- Proyecto 1: [...]
- Proyecto 2: [...]

### Eje 3: Impacto fiscal
- Proyecto 1: [...]
- Proyecto 2: [...]

## Conclusión
[Síntesis comparativa]`,
  },
  cronologia: {
    label: 'Cronología legislativa',
    subtitle: 'Hitos en orden temporal',
    md: `## Cronología

**[DD/MM/AAAA]** — Presentación del expediente
**[DD/MM/AAAA]** — Asignación a comisión
**[DD/MM/AAAA]** — Primer debate en plenaria
**[DD/MM/AAAA]** — Dictamen de mayoría
**[DD/MM/AAAA]** — Aprobación / archivo

## Notas
- [Observación clave]`,
  },
};
