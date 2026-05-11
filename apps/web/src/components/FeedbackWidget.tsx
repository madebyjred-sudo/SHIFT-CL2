/**
 * FeedbackWidget — botón flotante + modal para reportar bugs / preguntas / ideas.
 *
 * Visible para todos los users autenticados (montado en App.tsx). Live
 * en bottom-right, low-visibility hasta hover. El modal soporta:
 *   - Cuatro tipos: bug / pregunta / idea / otro
 *   - Severidad declarable (baja / media / alta / crítica)
 *   - Screenshot opcional: pegar desde clipboard (Cmd/Ctrl+V) O file picker
 *   - Markdown en description
 *
 * Contexto (URL, viewport, user_agent, theme) se captura automático en
 * el cliente API; no aparece en la UI para no abrumar al user.
 */
import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import {
  Bug, Loader2, MessageSquareWarning, Lightbulb, HelpCircle,
  Image as ImageIcon, X, Send, Check, AlertCircle, Trash2,
} from 'lucide-react';
import { submitFeedback, type FeedbackKind, type FeedbackSeverity } from '@/services/feedbackApi';
import { supabase } from '@/lib/supabase';

const KIND_OPTIONS: Array<{
  value: FeedbackKind; label: string; icon: typeof Bug; helper: string;
}> = [
  { value: 'bug', label: 'Bug', icon: Bug, helper: 'Algo no funciona como esperaba' },
  { value: 'pregunta', label: 'Pregunta', icon: HelpCircle, helper: 'No entiendo cómo se usa algo' },
  { value: 'idea', label: 'Idea', icon: Lightbulb, helper: 'Sugerencia o mejora' },
  { value: 'otro', label: 'Otro', icon: MessageSquareWarning, helper: 'No encaja en lo anterior' },
];

const SEVERITY_OPTIONS: Array<{ value: FeedbackSeverity; label: string; tone: string }> = [
  { value: 'baja',    label: 'Baja',     tone: 'text-emerald-600 dark:text-emerald-400' },
  { value: 'media',   label: 'Media',    tone: 'text-amber-600 dark:text-amber-400' },
  { value: 'alta',    label: 'Alta',     tone: 'text-orange-600 dark:text-orange-400' },
  { value: 'critica', label: 'Crítica',  tone: 'text-cl2-burgundy dark:text-cl2-burgundy' },
];

export function FeedbackWidget() {
  // Gate: solo se muestra si hay sesión activa. Re-chequea on focus.
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setAuthed(Boolean(data.session));
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthed(Boolean(session));
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  const [open, setOpen] = useState(false);
  if (!authed) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-1.5 px-3 py-2 rounded-full bg-cl2-burgundy text-white text-[12px] font-medium shadow-lg shadow-cl2-burgundy/30 hover:bg-cl2-burgundy/90 transition-all hover:scale-[1.02]"
        title="Reportar bug, preguntar o sugerir"
        aria-label="Reportar bug, preguntar o sugerir"
      >
        <MessageSquareWarning className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Reportar</span>
      </button>
      {open && <FeedbackModal onClose={() => setOpen(false)} />}
    </>
  );
}

function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [severity, setSeverity] = useState<FeedbackSeverity>('media');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentId, setSentId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Preview URL: revoke on unmount o cuando cambia el file.
  useEffect(() => {
    if (!screenshot) { setScreenshotPreview(null); return; }
    const url = URL.createObjectURL(screenshot);
    setScreenshotPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [screenshot]);

  // Capturar screenshot pegado desde clipboard. Listener global mientras
  // el modal está abierto. Cmd/Ctrl+V con imagen en clipboard → set file.
  useEffect(() => {
    const onPaste = (e: globalThis.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            setScreenshot(f);
            e.preventDefault();
            return;
          }
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f && f.type.startsWith('image/')) {
      setScreenshot(f);
    }
  };

  const submit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { id } = await submitFeedback({
        kind,
        title: title.trim(),
        description: description.trim() || undefined,
        severity,
        screenshot,
      });
      setSentId(id);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  // Estado "enviado" — pantalla de confirmación + opción de cerrar
  if (sentId) {
    return (
      <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
        <div className="relative w-full max-w-md bg-white dark:bg-[#161616] rounded-2xl shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden">
          <div className="p-8 text-center space-y-3">
            <div className="w-12 h-12 mx-auto rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
              <Check className="w-6 h-6" />
            </div>
            <h3 className="font-display text-[20px] text-[#0e1745] dark:text-white">
              Reporte enviado
            </h3>
            <p className="text-[13px] text-[#0e1745]/60 dark:text-white/55 leading-relaxed">
              Lo vamos a revisar. Si querés, podés enviar otro reporte o cerrar.
            </p>
            <div className="flex justify-center gap-2 pt-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-[12px] rounded-md text-[#0e1745]/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/5"
              >
                Cerrar
              </button>
              <button
                onClick={() => {
                  setSentId(null);
                  setTitle(''); setDescription(''); setScreenshot(null); setSeverity('media');
                  setSubmitting(false);
                }}
                className="px-4 py-2 text-[12px] rounded-md bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90"
              >
                Enviar otro
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg max-h-[90vh] bg-white dark:bg-[#161616] rounded-2xl shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-black/5 dark:border-white/10">
          <h3 className="font-display text-[17px] text-[#0e1745] dark:text-white flex items-center gap-2">
            <MessageSquareWarning className="w-4 h-4 text-cl2-burgundy" />
            Reportar
          </h3>
          <button onClick={onClose} className="text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Kind */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-cl2-burgundy/80 font-medium mb-2">
              ¿De qué se trata?
            </label>
            <div className="grid grid-cols-2 gap-2">
              {KIND_OPTIONS.map((o) => {
                const Icon = o.icon;
                const active = kind === o.value;
                return (
                  <button
                    key={o.value}
                    onClick={() => setKind(o.value)}
                    className={`p-2.5 rounded-lg border text-left transition-colors ${
                      active
                        ? 'border-cl2-burgundy bg-cl2-burgundy/8'
                        : 'border-black/8 dark:border-white/10 hover:bg-black/3 dark:hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon className={`w-3.5 h-3.5 ${active ? 'text-cl2-burgundy' : 'text-[#0e1745]/55 dark:text-white/55'}`} />
                      <span className={`text-[12.5px] font-medium ${active ? 'text-cl2-burgundy' : 'text-[#0e1745] dark:text-white'}`}>
                        {o.label}
                      </span>
                    </div>
                    <p className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40 mt-0.5 leading-tight">
                      {o.helper}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Title */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-cl2-burgundy/80 font-medium mb-1.5">
              Resumen
            </label>
            <input
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === 'bug' ? '¿Qué pasó? (una línea)' : '¿Qué querés contarnos? (una línea)'}
              maxLength={280}
              className="w-full px-3 py-2 bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 rounded-lg text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-cl2-burgundy/50"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-cl2-burgundy/80 font-medium mb-1.5">
              Detalle <span className="text-[#0e1745]/40 dark:text-white/40 font-normal normal-case">(opcional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder={
                kind === 'bug'
                  ? 'Qué hiciste, qué esperabas y qué pasó. Cuanto más concreto, más rápido lo arreglamos.'
                  : 'Más contexto si querés…'
              }
              className="w-full px-3 py-2 bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 rounded-lg text-[12.5px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-cl2-burgundy/50"
            />
          </div>

          {/* Severity (solo cuando es bug — para otros no aplica) */}
          {kind === 'bug' && (
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-cl2-burgundy/80 font-medium mb-1.5">
                Severidad
              </label>
              <div className="flex gap-2">
                {SEVERITY_OPTIONS.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => setSeverity(s.value)}
                    className={`flex-1 px-2 py-1.5 rounded-md border text-[11.5px] font-medium transition-colors ${
                      severity === s.value
                        ? `border-cl2-burgundy bg-cl2-burgundy/8 ${s.tone}`
                        : `border-black/8 dark:border-white/10 ${s.tone} opacity-50 hover:opacity-100`
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Screenshot */}
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-cl2-burgundy/80 font-medium mb-1.5">
              Screenshot <span className="text-[#0e1745]/40 dark:text-white/40 font-normal normal-case">(opcional)</span>
            </label>
            {screenshotPreview ? (
              <div className="relative rounded-lg overflow-hidden border border-black/8 dark:border-white/10">
                <img src={screenshotPreview} alt="screenshot preview" className="w-full max-h-[200px] object-contain bg-black/5 dark:bg-white/5" />
                <button
                  onClick={() => setScreenshot(null)}
                  title="Quitar screenshot"
                  className="absolute top-1.5 right-1.5 p-1.5 rounded-full bg-black/60 text-white hover:bg-black/80"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
                <div className="absolute bottom-1.5 left-1.5 px-2 py-0.5 rounded bg-black/60 text-white text-[10px]">
                  {(screenshot!.size / 1024).toFixed(0)} KB · {screenshot!.type}
                </div>
              </div>
            ) : (
              <div className="border border-dashed border-black/15 dark:border-white/15 rounded-lg p-3 text-center bg-black/2 dark:bg-white/[0.02]">
                <ImageIcon className="w-5 h-5 mx-auto text-[#0e1745]/35 dark:text-white/30 mb-1.5" />
                <p className="text-[11.5px] text-[#0e1745]/55 dark:text-white/50">
                  Pegá una captura con <kbd className="px-1 py-0.5 rounded bg-black/5 dark:bg-white/10 text-[10px]">⌘+V</kbd>{' '}
                  o{' '}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="text-cl2-burgundy underline hover:no-underline"
                  >
                    elegí un archivo
                  </button>
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 p-2.5 rounded-lg bg-cl2-burgundy/8 border border-cl2-burgundy/20 text-[11.5px] text-cl2-burgundy/90">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-black/5 dark:border-white/10 bg-black/2 dark:bg-white/[0.01]">
          <p className="text-[10.5px] text-[#0e1745]/40 dark:text-white/35 leading-tight">
            Se envía con tu usuario y la URL donde estás ahora.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 text-[12px] rounded-md text-[#0e1745]/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
            >
              Cancelar
            </button>
            <button
              onClick={submit}
              disabled={!title.trim() || submitting}
              className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] rounded-md bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90 disabled:opacity-40 transition-colors"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Enviar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Convenience: re-export to consumers that want to suppress the lint
// warning for "ClipboardEvent imported but not used" if they don't
// instantiate the listener generic. (No-op type re-export.)
export type { ClipboardEvent };
