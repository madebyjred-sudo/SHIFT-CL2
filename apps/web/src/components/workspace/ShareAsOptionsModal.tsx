/**
 * ShareAsOptionsModal — pre-generation options for the "Compartir como"
 * flow. Compact, single-step (NO multi-step wizard per product owner).
 *
 * Per-kind fields:
 *   carousel       → tono · audiencia · hook · CTA · numSlides · emojis
 *   pptx_asset     → tono · audiencia · propósito · marca · numSlides · emojis
 *   docx_asset     → tono · audiencia · propósito · marca
 *   podcast_asset  → voz · tono · audiencia
 *
 * Plus a `sendToCanvas` toggle (default ON). The artefact is always
 * generated; the toggle just controls whether a node materializes on
 * the workspace canvas after generation.
 */
import { useEffect, useState } from 'react';
import { X, Sparkles, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  GeneratedAssetKind, ShareAssetOptions,
} from '@/services/workspaceApi';
import type { ShareAsKindMeta } from './ShareAsButton';

const TONOS = [
  { value: '', label: 'Por defecto (editorial)' },
  { value: 'ejecutivo, seco', label: 'Ejecutivo, seco' },
  { value: 'didáctico, accesible', label: 'Didáctico' },
  { value: 'persuasivo, argumentativo', label: 'Persuasivo' },
  { value: 'técnico, denso', label: 'Técnico' },
  { value: 'narrativo, periodístico', label: 'Narrativo' },
];

const HOOKS = [
  { value: '', label: 'Lexa decide' },
  { value: 'pregunta provocadora', label: 'Pregunta provocadora' },
  { value: 'dato contraintuitivo', label: 'Dato contraintuitivo' },
  { value: 'historia de cliente', label: 'Historia de cliente' },
  { value: 'alerta directa', label: 'Alerta directa' },
];

const VOICES = [
  { value: '', label: 'Voz Lexa (default)' },
  { value: 'narrador masculino', label: 'Narrador masculino' },
  { value: 'narrador femenino', label: 'Narrador femenino' },
  { value: 'editorial dual', label: 'Editorial dual (2 voces)' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  meta: ShareAsKindMeta | null;
  workspaceTitle?: string;
  onSubmit: (kind: GeneratedAssetKind, options: ShareAssetOptions, sendToCanvas: boolean) => void;
}

export function ShareAsOptionsModal({ open, onClose, meta, workspaceTitle, onSubmit }: Props) {
  const [tono, setTono] = useState('');
  const [audiencia, setAudiencia] = useState('');
  const [hook, setHook] = useState('');
  const [cta, setCta] = useState('');
  const [proposito, setProposito] = useState('');
  const [marca, setMarca] = useState('');
  const [voice, setVoice] = useState('');
  const [emojis, setEmojis] = useState(false);
  const [numSlides, setNumSlides] = useState<number>(8);
  const [sendToCanvas, setSendToCanvas] = useState(true);

  // Reset when the modal opens with a different kind
  useEffect(() => {
    if (!open) return;
    setTono('');
    setAudiencia('');
    setHook('');
    setCta('');
    setProposito('');
    setMarca('');
    setVoice('');
    setEmojis(false);
    setNumSlides(meta?.kind === 'carousel' ? 8 : meta?.kind === 'pptx_asset' ? 10 : 8);
    setSendToCanvas(true);
  }, [open, meta?.kind]);

  if (!open || !meta) return null;

  const showCarouselFields = meta.kind === 'carousel';
  const showPptxFields = meta.kind === 'pptx_asset';
  const showDocFields = meta.kind === 'docx_asset';
  const showPodcastFields = meta.kind === 'podcast_asset';
  const showTono = true;
  const showAudiencia = true;
  const showProposito = showPptxFields || showDocFields;
  const showMarca = showPptxFields || showDocFields;
  const showHook = showCarouselFields;
  const showCta = showCarouselFields;
  const showNumSlides = showCarouselFields || showPptxFields;
  const showVoice = showPodcastFields;
  const showEmojis = showCarouselFields || showPptxFields;

  const handleSubmit = () => {
    const options: ShareAssetOptions = {};
    if (showTono && tono) options.tono = tono;
    if (showAudiencia && audiencia.trim()) options.audiencia = audiencia.trim();
    if (showHook && hook) options.hook = hook;
    if (showCta && cta.trim()) options.cta = cta.trim();
    if (showProposito && proposito.trim()) options.proposito = proposito.trim();
    if (showMarca && marca.trim()) options.marca = marca.trim();
    if (showVoice && voice) options.voice = voice;
    if (showEmojis) options.emojis = emojis;
    if (showNumSlides) options.numSlides = numSlides;
    onSubmit(meta.kind, options, sendToCanvas);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[150] flex items-center justify-center"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-lg mx-4 bg-cl2-paper dark:bg-[#161616] rounded-2xl shadow-2xl border border-black/8 dark:border-white/10 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/[0.06] dark:border-white/[0.08]">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-cl2-burgundy/10 flex items-center justify-center shrink-0">
              <span className="font-display italic text-cl2-burgundy text-[15px] leading-none">{meta.mark}</span>
            </div>
            <div className="min-w-0">
              <p className="font-display italic text-[16px] text-[#0e1745] dark:text-white">
                Generar <span className="text-cl2-burgundy">{meta.label.toLowerCase()}</span>
              </p>
              {workspaceTitle && (
                <p className="text-[10.5px] font-mono uppercase tracking-[0.16em] text-[#0e1745]/50 dark:text-white/40 truncate">
                  desde · {workspaceTitle}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-[#0e1745]/55 dark:text-white/55"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form — compact, all visible without scroll on most laptops */}
        <div className="px-5 py-4 space-y-3.5 max-h-[68vh] overflow-y-auto">
          <p className="text-[12px] text-[#0e1745]/60 dark:text-white/50 leading-relaxed">
            {meta.sublabel}. Todos los campos son opcionales — los defaults son razonables para CL2.
          </p>

          {showTono && (
            <Field label="Tono">
              <select
                value={tono}
                onChange={(e) => setTono(e.target.value)}
                className={selectCls}
              >
                {TONOS.map((t) => <option key={t.value} value={t.value} className="bg-white dark:bg-[#161616]">{t.label}</option>)}
              </select>
            </Field>
          )}

          {showAudiencia && (
            <Field label="Audiencia" hint="para quién es">
              <input
                value={audiencia}
                onChange={(e) => setAudiencia(e.target.value)}
                placeholder={
                  meta.kind === 'carousel'   ? 'Ej: clientes corporativos · prensa nacional · sector financiero' :
                  meta.kind === 'pptx_asset' ? 'Ej: comisión de Hacendarios · directorio · prensa' :
                  meta.kind === 'docx_asset' ? 'Ej: cliente corporativo · diputado · equipo interno' :
                  'Ej: equipo CL2 · clientes top · audiencia general'
                }
                className={inputCls}
              />
            </Field>
          )}

          {showHook && (
            <Field label="Hook de apertura" hint="cómo arranca el slide 1">
              <select value={hook} onChange={(e) => setHook(e.target.value)} className={selectCls}>
                {HOOKS.map((h) => <option key={h.value} value={h.value} className="bg-white dark:bg-[#161616]">{h.label}</option>)}
              </select>
            </Field>
          )}

          {showProposito && (
            <Field label="Propósito" hint="qué argumenta">
              <textarea
                value={proposito}
                onChange={(e) => setProposito(e.target.value)}
                rows={2}
                placeholder="Ej: convencer a la comisión · presentar estado y próximos pasos · refutar dictamen minoritario"
                className={textareaCls}
              />
            </Field>
          )}

          {showMarca && (
            <Field label="Lineamientos de marca" hint="voz, paleta, do/don't">
              <textarea
                value={marca}
                onChange={(e) => setMarca(e.target.value)}
                rows={2}
                placeholder="Ej: lenguaje formal de fracción · paleta sobria · referencias al Plan Nacional 2024"
                className={textareaCls}
              />
            </Field>
          )}

          {showVoice && (
            <Field label="Voz">
              <select value={voice} onChange={(e) => setVoice(e.target.value)} className={selectCls}>
                {VOICES.map((v) => <option key={v.value} value={v.value} className="bg-white dark:bg-[#161616]">{v.label}</option>)}
              </select>
            </Field>
          )}

          {showCta && (
            <Field label="CTA final" hint="qué pedís al lector">
              <input
                value={cta}
                onChange={(e) => setCta(e.target.value)}
                placeholder='Ej: "Conversemos sobre cómo afecta a tu sector" · "Más en cl2.cr"'
                className={inputCls}
              />
            </Field>
          )}

          {showNumSlides && (
            <Field label="Cantidad de slides" hint="entre 4 y 12">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={4}
                  max={12}
                  value={numSlides}
                  onChange={(e) => setNumSlides(Number(e.target.value))}
                  className="flex-1 accent-cl2-burgundy"
                />
                <span className="font-mono text-[12px] text-cl2-burgundy w-7 text-right">{numSlides}</span>
              </div>
            </Field>
          )}

          {showEmojis && (
            <label className="flex items-center gap-2.5 cursor-pointer select-none pt-1">
              <input
                type="checkbox"
                checked={emojis}
                onChange={(e) => setEmojis(e.target.checked)}
                className="w-3.5 h-3.5 accent-cl2-burgundy"
              />
              <span className="text-[12px] text-[#0e1745]/70 dark:text-white/65">
                Permitir emojis e iconos
              </span>
            </label>
          )}

          <label className="flex items-center gap-2.5 cursor-pointer select-none pt-1 border-t border-black/[0.06] dark:border-white/[0.08] mt-2">
            <input
              type="checkbox"
              checked={sendToCanvas}
              onChange={(e) => setSendToCanvas(e.target.checked)}
              className="w-3.5 h-3.5 accent-cl2-burgundy"
            />
            <span className="text-[12px] text-[#0e1745]/70 dark:text-white/65">
              También colocar nodo en el canvas
            </span>
          </label>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02]">
          <button
            onClick={onClose}
            className="text-[12px] text-[#0e1745]/55 dark:text-white/50 hover:text-[#0e1745] dark:hover:text-white px-2 py-2 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 rounded-lg bg-cl2-burgundy text-white text-[12.5px] font-semibold hover:bg-cl2-burgundy/90 transition-colors flex items-center gap-1.5 shadow-sm shadow-cl2-burgundy/15"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Generar
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Field wrapper ────────────────────────────────────────────────────
function Field({
  label, hint, children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-[#0e1745] dark:text-white/85 mb-1">
        {label}
        {hint && <span className="text-[#0e1745]/40 dark:text-white/35 ml-1.5 font-normal">— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

const inputCls = cn(
  'w-full px-3 py-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.05] border border-black/8 dark:border-white/10',
  'text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30',
  'focus:outline-none focus:border-cl2-burgundy/45',
);
const selectCls = inputCls;
const textareaCls = cn(inputCls, 'resize-none');
