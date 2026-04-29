/**
 * PptxOptionsModal — pre-generation form for branding/context.
 *
 * Why this exists: user feedback after the first cut was "the generic
 * Gamma deck is fine, but I want to tell it WHO it's for, WHAT we're
 * arguing, and HOW to sound." Instead of dumping a long advanced-options
 * panel inside the result modal, we pop a lightweight form BEFORE the
 * generation starts, but ONLY when the user clicked the canvas/card
 * button — chat-triggered Atlas calls bypass this because the chat
 * itself is the place to express intent.
 *
 * Fields are deliberately sparse — every additional field raises the
 * abandon rate. We picked the four that move the needle most for a
 * legislative deck:
 *   • tono       — register
 *   • audiencia  — who reads it
 *   • proposito  — what argument the deck makes
 *   • marca      — brand voice / visual notes
 *
 * Plus an emojis toggle (off by default — legislative decks rarely want
 * smileys).
 *
 * "Saltar" generates with defaults. "Generar" submits with the form
 * values. The values get cached on the workspace row so the next click
 * pre-fills.
 */
import { useEffect, useState } from 'react';
import { X, Sparkles } from 'lucide-react';

export interface PptxOptions {
  tono?: string;
  audiencia?: string;
  proposito?: string;
  marca?: string;
  emojis?: boolean;
}

const TONOS = [
  { value: '', label: 'Por defecto (legislativo)' },
  { value: 'ejecutivo, seco', label: 'Ejecutivo, seco' },
  { value: 'didáctico, accesible', label: 'Didáctico' },
  { value: 'persuasivo, argumentativo', label: 'Persuasivo' },
  { value: 'técnico, denso', label: 'Técnico' },
  { value: 'narrativo, periodístico', label: 'Narrativo' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (options: PptxOptions) => void;
  /** Pre-fill values from the cached options on the workspace row. */
  initial?: PptxOptions;
  workspaceTitle?: string;
}

export function PptxOptionsModal({
  open, onClose, onSubmit, initial, workspaceTitle,
}: Props) {
  const [tono, setTono] = useState(initial?.tono ?? '');
  const [audiencia, setAudiencia] = useState(initial?.audiencia ?? '');
  const [proposito, setProposito] = useState(initial?.proposito ?? '');
  const [marca, setMarca] = useState(initial?.marca ?? '');
  const [emojis, setEmojis] = useState<boolean>(Boolean(initial?.emojis));

  // Reset form when initial changes (modal reopens with fresh cached values).
  useEffect(() => {
    if (!open) return;
    setTono(initial?.tono ?? '');
    setAudiencia(initial?.audiencia ?? '');
    setProposito(initial?.proposito ?? '');
    setMarca(initial?.marca ?? '');
    setEmojis(Boolean(initial?.emojis));
  }, [open, initial]);

  if (!open) return null;

  const handleSubmit = (useDefaults: boolean) => {
    if (useDefaults) {
      onSubmit({});
      return;
    }
    onSubmit({
      tono: tono || undefined,
      audiencia: audiencia.trim() || undefined,
      proposito: proposito.trim() || undefined,
      marca: marca.trim() || undefined,
      emojis,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[150] flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg mx-4 bg-white dark:bg-[#161616] rounded-2xl shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/5 dark:border-white/10">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-cl2-burgundy/10 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-4 h-4 text-cl2-burgundy" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">
                Antes de generar
              </div>
              {workspaceTitle && (
                <div className="text-[11px] text-[#0e1745]/50 dark:text-white/50 truncate">
                  {workspaceTitle}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-[#0e1745]/60 dark:text-white/60"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <div className="px-5 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-[12px] text-[#0e1745]/55 dark:text-white/50 leading-relaxed">
            Decile a Gamma cómo querés que suene la presentación. Todo es opcional — si saltás esto, va con el preset legislativo.
          </p>

          <div>
            <label className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">Tono</label>
            <select
              value={tono}
              onChange={(e) => setTono(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white focus:outline-none focus:border-cl2-burgundy/40"
            >
              {TONOS.map((t) => (
                <option key={t.value} value={t.value} className="bg-white dark:bg-[#161616]">{t.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">
              Audiencia
              <span className="text-[#0e1745]/40 dark:text-white/35 ml-1.5 font-normal">— para quién es</span>
            </label>
            <input
              value={audiencia}
              onChange={(e) => setAudiencia(e.target.value)}
              placeholder="Ej: Comisión de Hacendarios · prensa nacional · equipo interno"
              className="w-full px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-cl2-burgundy/40"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">
              Propósito
              <span className="text-[#0e1745]/40 dark:text-white/35 ml-1.5 font-normal">— qué argumenta</span>
            </label>
            <textarea
              value={proposito}
              onChange={(e) => setProposito(e.target.value)}
              placeholder="Ej: convencer a la comisión de avanzar a primer debate · presentar el estado actual y los próximos pasos · refutar las críticas del dictamen minoritario"
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-cl2-burgundy/40"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">
              Lineamientos de marca
              <span className="text-[#0e1745]/40 dark:text-white/35 ml-1.5 font-normal">— voz, paleta, do/don't</span>
            </label>
            <textarea
              value={marca}
              onChange={(e) => setMarca(e.target.value)}
              placeholder="Ej: usar lenguaje formal de fracción · paleta sobria sin azules vivos · referencias al Plan Nacional 2024 · evitar juicios de valor sobre el oficialismo"
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-cl2-burgundy/40"
            />
            <p className="mt-1 text-[10.5px] text-[#0e1745]/40 dark:text-white/35 leading-relaxed">
              Gamma no soporta inyección directa de logos vía API — para eso, descargá el .pptx y pegalo en la plantilla, o editá el deck en gamma.app después.
            </p>
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={emojis}
              onChange={(e) => setEmojis(e.target.checked)}
              className="w-3.5 h-3.5 accent-cl2-burgundy"
            />
            <span className="text-[12px] text-[#0e1745]/70 dark:text-white/65">
              Permitir emojis e iconos en las slides
            </span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-black/5 dark:border-white/10">
          <button
            onClick={() => handleSubmit(true)}
            className="text-[12px] text-[#0e1745]/55 dark:text-white/50 hover:text-[#0e1745] dark:hover:text-white transition-colors"
          >
            Saltar — usar defaults
          </button>
          <button
            onClick={() => handleSubmit(false)}
            className="px-4 py-2 rounded-lg bg-cl2-burgundy text-white text-[13px] font-medium hover:bg-cl2-burgundy/90 transition-colors flex items-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Generar
          </button>
        </div>
      </div>
    </div>
  );
}
