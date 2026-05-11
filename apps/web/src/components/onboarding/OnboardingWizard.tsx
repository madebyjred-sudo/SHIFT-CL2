/**
 * OnboardingWizard — first-time setup para consultores CL2.
 *
 * Reescrito 2026-05-11 después del smoke con shiftagentics. Modelo
 * mental nuevo: el usuario es un CONSULTOR (no diputado), tiene
 * múltiples CLIENTES, cada cliente con sus propios intereses.
 *
 * Steps:
 *   1. VOS — rol + cómo querés que los agentes te hablen
 *   2. CLIENTES — agregar 1-N clientes (label + sector + brief).
 *                 Botón opcional "🪄 Brief profundo con tu IA" abre
 *                 modal con prompt copiable + textarea para pegar.
 *   3. VIGILANCIA — Centinela sugiere watchlists por cliente;
 *                   user checkbox lo que vigilar; click empezar.
 *
 * Resultado:
 *   - user_profile: cargo + (preferencias futuras)
 *   - cl2_clients: una row por cliente (sync auto a /memories/clientes/)
 *   - centinela_watchlist: entries con client_id si el user las eligió
 *   - onboarded_at: marca el momento de cierre
 *
 * Skip permitido en cada step — gating onboarding es fricción. La
 * memoria se va llenando con lo que el usuario alcance a llenar.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, ArrowRight, ArrowLeft, Sparkles, Loader2, Plus, Check,
  Users, BookHeart, Eye, Trash2, Copy, ClipboardPaste, ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getProfile, updateProfile, completeOnboarding,
  magicHelp,
  type UserProfile,
} from '@/services/onboardingApi';
import {
  listClientes, createCliente, updateCliente, deleteCliente,
  type Cliente,
} from '@/services/clientesApi';
import { addToWatchlist } from '@/services/centinelaApi';

type Step = 'vos' | 'clientes' | 'vigilancia';
const STEP_ORDER: Step[] = ['vos', 'clientes', 'vigilancia'];

export function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('vos');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getProfile().catch(() => null),
      listClientes().catch(() => []),
    ]).then(([p, cs]) => {
      setProfile(p ?? {
        user_id: '', cargo: null, enfoque: null, temas: [], partido: null,
        onboarded_at: null, onboarding_step: 'vos',
      });
      setClientes(cs);
      // Resume at last saved step
      const savedStep = p?.onboarding_step;
      if (savedStep && (STEP_ORDER as string[]).includes(savedStep)) {
        setStep(savedStep as Step);
      }
    }).finally(() => setLoading(false));
  }, []);

  const goNext = useCallback(async () => {
    const idx = STEP_ORDER.indexOf(step);
    const next = STEP_ORDER[idx + 1];
    if (!next) {
      try { await completeOnboarding(); } catch { /* swallow */ }
      onClose();
      return;
    }
    setStep(next);
    try { await updateProfile({ onboarding_step: next }); } catch { /* non-fatal */ }
  }, [step, onClose]);

  const goBack = useCallback(() => {
    const idx = STEP_ORDER.indexOf(step);
    const prev = STEP_ORDER[idx - 1];
    if (prev) setStep(prev);
  }, [step]);

  const skip = useCallback(async () => {
    try { await completeOnboarding(); } catch { /* swallow */ }
    onClose();
  }, [onClose]);

  if (loading) return null;

  const stepIdx = STEP_ORDER.indexOf(step);
  const totalSteps = STEP_ORDER.length;

  // Step 3 sólo tiene sentido si hay clientes — sino, "Empezar" cierra
  // directo en step 2. Esto es un edge case del flow "skip clientes"
  const finalStep = clientes.length > 0 ? 'vigilancia' : 'clientes';
  const isLastStep = step === finalStep;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[200] flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-2xl mx-4 max-h-[92vh] flex flex-col bg-white dark:bg-[#161616] rounded-2xl shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden">
        {/* Progress */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-black/5 dark:border-white/10">
          <div className="flex-1 flex gap-1">
            {STEP_ORDER.map((s, i) => (
              <div
                key={s}
                className={cn(
                  'flex-1 h-1 rounded-full transition-colors',
                  i <= stepIdx ? 'bg-cl2-burgundy' : 'bg-black/8 dark:bg-white/10',
                )}
              />
            ))}
          </div>
          <span className="text-[11px] text-[#0e1745]/45 dark:text-white/45 tabular-nums">
            {stepIdx + 1} / {totalSteps}
          </span>
          <button
            onClick={skip}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-[#0e1745]/55 dark:text-white/55"
            aria-label="Saltar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {step === 'vos' && profile && (
            <VosStep profile={profile} onChange={setProfile} />
          )}
          {step === 'clientes' && (
            <ClientesStep
              clientes={clientes}
              onListChange={setClientes}
            />
          )}
          {step === 'vigilancia' && (
            <VigilanciaStep
              clientes={clientes}
              profile={profile}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-black/5 dark:border-white/10">
          <button
            onClick={goBack}
            disabled={stepIdx === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white disabled:opacity-30 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Atrás
          </button>
          <button
            onClick={skip}
            className="text-[11px] text-[#0e1745]/40 dark:text-white/40 hover:text-[#0e1745]/70 dark:hover:text-white/70 transition-colors"
          >
            Saltar todo
          </button>
          <button
            onClick={isLastStep ? skip : goNext}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cl2-burgundy text-white text-[13px] font-medium hover:bg-cl2-burgundy/90 transition-colors"
          >
            {isLastStep ? 'Empezar a usar CL2' : 'Continuar'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// STEP 1 — VOS
// ════════════════════════════════════════════════════════════════════════
function VosStep({
  profile, onChange,
}: { profile: UserProfile; onChange: (p: UserProfile) => void }) {
  const [cargo, setCargo] = useState(profile.cargo ?? '');
  const [enfoque, setEnfoque] = useState(profile.enfoque ?? '');

  const persist = useCallback(async (patch: Partial<UserProfile>) => {
    try {
      const updated = await updateProfile(patch);
      onChange(updated);
    } catch { /* non-fatal */ }
  }, [onChange]);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
          Paso 1 · Vos
        </p>
        <h2 className="font-display text-[26px] leading-tight font-semibold text-[#0e1745] dark:text-white">
          ¿Quién sos en CL2?
        </h2>
        <p className="mt-1.5 text-[13px] text-[#0e1745]/55 dark:text-white/50 leading-relaxed">
          Tu rol en la firma y tu tipo de práctica. Esto calibra a Lexa, Atlas y Centinela — pero NO es lo más importante. Tus <em>clientes</em> son lo que más vamos a usar para personalizar.
        </p>
      </div>

      <div>
        <label className="block text-[12px] font-medium text-[#0e1745] dark:text-white/85 mb-1.5">
          Rol y firma
        </label>
        <input
          type="text"
          value={cargo}
          onChange={(e) => setCargo(e.target.value)}
          onBlur={() => persist({ cargo })}
          placeholder="Consultora senior en CL2 Consultoría · Asesora regulatoria · Socia fundadora…"
          className="w-full px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-cl2-burgundy/40"
        />
        <p className="mt-1 text-[10.5px] text-[#0e1745]/40 dark:text-white/35">
          Una línea. Los agentes la leen al inicio de cada conversación.
        </p>
      </div>

      <div>
        <label className="block text-[12px] font-medium text-[#0e1745] dark:text-white/85 mb-1.5">
          Tipo de práctica <span className="text-[#0e1745]/40 dark:text-white/40 font-normal">(opcional)</span>
        </label>
        <input
          type="text"
          value={enfoque}
          onChange={(e) => setEnfoque(e.target.value)}
          onBlur={() => persist({ enfoque })}
          placeholder="Regulatorio · Fiscal · Financiero · Sectores regulados · Litigio constitucional…"
          className="w-full px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 focus:outline-none focus:border-cl2-burgundy/40"
        />
      </div>

      <div className="p-3 rounded-lg bg-cl2-burgundy/5 border border-cl2-burgundy/15 flex items-start gap-2">
        <Users className="w-3.5 h-3.5 text-cl2-burgundy mt-0.5 flex-shrink-0" />
        <p className="text-[11.5px] text-[#0e1745]/70 dark:text-white/65 leading-relaxed">
          En el próximo paso vas a agregar tus <strong>clientes</strong>. Cada cliente tiene su propia carpeta de memoria, su brief, y va a poder tener su propia watchlist de Centinela. Podés agregar dos clientes con intereses opuestos — los agentes los manejan separados.
        </p>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// STEP 2 — CLIENTES (multi-add con paste-from-LLM opcional)
// ════════════════════════════════════════════════════════════════════════
function ClientesStep({
  clientes, onListChange,
}: {
  clientes: Cliente[];
  onListChange: (cs: Cliente[]) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<{
    label: string; sector: string; description: string;
  }>({ label: '', sector: '', description: '' });
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

  const startCreating = () => {
    setDraft({ label: '', sector: '', description: '' });
    setCreating(true);
  };
  const cancelCreating = () => {
    setCreating(false);
    setDraft({ label: '', sector: '', description: '' });
  };

  const submitDraft = async () => {
    if (!draft.label.trim()) return;
    setBusy(true);
    try {
      const created = await createCliente({
        label: draft.label.trim(),
        sector: draft.sector.trim() || undefined,
        description: draft.description.trim() || undefined,
      });
      onListChange([created, ...clientes]);
      cancelCreating();
    } catch { /* swallow */ }
    finally { setBusy(false); }
  };

  const removeOne = async (id: string) => {
    if (!window.confirm('¿Borrar este cliente? También se borra su carpeta de memoria.')) return;
    try {
      await deleteCliente(id);
      onListChange(clientes.filter((c) => c.id !== id));
    } catch { /* swallow */ }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
          Paso 2 · Tus clientes
        </p>
        <h2 className="font-display text-[26px] leading-tight font-semibold text-[#0e1745] dark:text-white">
          ¿A quién asesorás?
        </h2>
        <p className="mt-1.5 text-[13px] text-[#0e1745]/55 dark:text-white/50 leading-relaxed">
          Agregá los clientes que vas a usar en CL2. Por cada uno podés escribir un brief corto a mano O pedirle a tu IA habitual (ChatGPT, Claude, Gemini…) que lo redacte por vos — esa opción está adentro.
        </p>
      </div>

      {/* Lista de clientes existentes */}
      {clientes.length > 0 && (
        <div className="space-y-2">
          {clientes.map((c) => (
            <ClienteCard key={c.id} cliente={c} onRemove={() => removeOne(c.id)} />
          ))}
        </div>
      )}

      {/* Form de nuevo cliente o botón "Agregar" */}
      {creating ? (
        <div className="p-4 rounded-xl bg-black/3 dark:bg-white/5 border border-cl2-burgundy/20 space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-[#0e1745]/70 dark:text-white/65 mb-1">
              Nombre del cliente
            </label>
            <input
              type="text"
              autoFocus
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="Acme S.A. · Cámara de Hoteleros · Garnier & Asociados…"
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white focus:outline-none focus:border-cl2-burgundy/50"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-[#0e1745]/70 dark:text-white/65 mb-1">
              Sector <span className="text-[#0e1745]/40 dark:text-white/40 font-normal">(opcional)</span>
            </label>
            <input
              type="text"
              value={draft.sector}
              onChange={(e) => setDraft({ ...draft, sector: e.target.value })}
              placeholder="Fintech · Infraestructura · Turismo · Salud · Energía · …"
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white focus:outline-none focus:border-cl2-burgundy/50"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-medium text-[#0e1745]/70 dark:text-white/65">
                Brief <span className="text-[#0e1745]/40 dark:text-white/40 font-normal">(opcional, recomendado)</span>
              </label>
              <button
                onClick={() => setPasteOpen(true)}
                disabled={!draft.label.trim()}
                className="flex items-center gap-1 text-[10.5px] font-medium text-cl2-burgundy hover:bg-cl2-burgundy/10 px-2 py-1 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Generá un brief profundo pegando un prompt en tu IA"
              >
                <Sparkles className="w-3 h-3" />
                Brief con tu IA
              </button>
            </div>
            <textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={5}
              placeholder="Qué hacen, qué les importa, qué expedientes típicamente les interesan, intereses políticos, contactos clave..."
              className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/5 border border-black/10 dark:border-white/10 text-[12.5px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-cl2-burgundy/50"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={cancelCreating}
              className="px-3 py-1.5 text-[12px] rounded-md text-[#0e1745]/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/5"
            >
              Cancelar
            </button>
            <button
              onClick={submitDraft}
              disabled={!draft.label.trim() || busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90 disabled:opacity-40 transition-colors"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
              Guardar cliente
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={startCreating}
          className="w-full p-4 rounded-xl border-2 border-dashed border-black/10 dark:border-white/10 hover:border-cl2-burgundy/40 hover:bg-cl2-burgundy/5 transition-colors flex items-center justify-center gap-2 text-[13px] font-medium text-[#0e1745]/60 dark:text-white/60"
        >
          <Plus className="w-4 h-4" />
          {clientes.length === 0 ? 'Agregar tu primer cliente' : 'Agregar otro cliente'}
        </button>
      )}

      {clientes.length === 0 && !creating && (
        <p className="text-[11px] text-[#0e1745]/45 dark:text-white/40 italic text-center">
          Podés saltar este paso y agregar clientes después desde Mi memoria.
        </p>
      )}

      <PasteFromLlmModal
        open={pasteOpen}
        clienteLabel={draft.label}
        clienteSector={draft.sector}
        onCancel={() => setPasteOpen(false)}
        onConfirm={(text) => {
          setDraft({ ...draft, description: text });
          setPasteOpen(false);
        }}
      />
    </div>
  );
}

function ClienteCard({
  cliente, onRemove,
}: { cliente: Cliente; onRemove: () => void }) {
  return (
    <div className="p-3 rounded-xl bg-white dark:bg-white/[0.04] border border-black/8 dark:border-white/10 flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg bg-cl2-burgundy/10 text-cl2-burgundy flex items-center justify-center flex-shrink-0 mt-0.5">
        <Users className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-[#0e1745] dark:text-white">{cliente.label}</span>
          {cliente.sector && (
            <span className="text-[10.5px] text-cl2-burgundy/80 bg-cl2-burgundy/10 px-1.5 py-0.5 rounded">
              {cliente.sector}
            </span>
          )}
        </div>
        {cliente.description && (
          <p className="mt-1 text-[11.5px] text-[#0e1745]/55 dark:text-white/50 leading-relaxed line-clamp-2">
            {cliente.description}
          </p>
        )}
      </div>
      <button
        onClick={onRemove}
        title="Borrar cliente"
        className="p-1.5 rounded text-[#0e1745]/40 dark:text-white/40 hover:text-cl2-burgundy hover:bg-cl2-burgundy/8 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Paste-from-LLM modal ───────────────────────────────────────────
function buildPromptForCliente(label: string, sector: string): string {
  const sectorLine = sector.trim() ? ` Sector: ${sector.trim()}.` : '';
  return `Voy a empezar a usar una herramienta legislativa llamada CL2 con agentes IA que asesoran sobre la Asamblea Legislativa de Costa Rica. Necesito que generes un brief sobre uno de mis clientes para que esos agentes lo conozcan desde el día uno.

Cliente: ${label || '(nombre del cliente)'}.${sectorLine}

Generá un brief en markdown que cubra, en este orden:

1. **Identidad** — qué es esta organización, a qué se dedica, escala (regional / nacional / multinacional), antigüedad si la sabés.
2. **Stakeholders clave** — quiénes son los decisores típicos en una organización así (cargos), no necesariamente los nombres.
3. **Intereses legislativos típicos** — qué áreas legislativas tienden a importarle a una organización de este tipo en Costa Rica. Plazos, regulación sectorial, fiscales, laborales, etc.
4. **Postura habitual** — cómo suelen posicionarse organizaciones de este tipo frente a reforma regulatoria: pro-mercado, pro-protección, sectorial, agnóstica.
5. **Riesgos políticos** — qué amenazas legislativas o regulatorias podrían afectarles.
6. **Tono recomendado** — cómo le hablaría un asesor a este tipo de cliente.

Máximo 600 palabras. Sin viñetas dentro de párrafos, español de Costa Rica, registro profesional. NO inventes datos específicos (números, nombres propios) que no sepas con certeza — preferí decir "típicamente" o "en organizaciones de este tipo".`;
}

function PasteFromLlmModal({
  open, clienteLabel, clienteSector, onCancel, onConfirm,
}: {
  open: boolean;
  clienteLabel: string;
  clienteSector: string;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}) {
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const promptText = useMemo(
    () => buildPromptForCliente(clienteLabel, clienteSector),
    [clienteLabel, clienteSector],
  );

  useEffect(() => {
    if (!open) { setPasted(''); setCopied(false); }
  }, [open]);

  if (!open) return null;

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard denied */ }
  };

  return (
    <div className="fixed inset-0 z-[250] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col bg-white dark:bg-[#161616] rounded-2xl shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-black/5 dark:border-white/10">
          <h3 className="font-display text-[17px] text-[#0e1745] dark:text-white">
            Brief con tu IA — {clienteLabel || 'cliente'}
          </h3>
          <button onClick={onCancel} className="text-[#0e1745]/55 dark:text-white/55 hover:text-[#0e1745] dark:hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Columna 1 — Prompt */}
          <div>
            <p className="text-[11px] uppercase tracking-wider text-cl2-burgundy/80 font-medium mb-2">
              1. Copiá este prompt
            </p>
            <pre className="text-[11.5px] leading-relaxed text-[#0e1745]/80 dark:text-white/75 bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 rounded-lg p-3 whitespace-pre-wrap font-mono max-h-[300px] overflow-y-auto">
{promptText}
            </pre>
            <button
              onClick={copyPrompt}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-md bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copiado' : 'Copiar prompt'}
            </button>
            <p className="mt-3 text-[11px] text-[#0e1745]/50 dark:text-white/45 leading-relaxed">
              2. Pegalo en <strong>tu</strong> ChatGPT, Claude, Gemini, Notion AI, o donde sea que ya tengas contexto sobre este cliente.
            </p>
          </div>

          {/* Columna 2 — Paste */}
          <div className="flex flex-col">
            <p className="text-[11px] uppercase tracking-wider text-cl2-burgundy/80 font-medium mb-2 flex items-center gap-1.5">
              <ClipboardPaste className="w-3 h-3" />
              3. Pegá la respuesta acá
            </p>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="La respuesta de tu IA en markdown…"
              rows={14}
              className="flex-1 px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[12px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-cl2-burgundy/40 font-mono leading-relaxed"
            />
            <div className="mt-1 text-[10.5px] text-[#0e1745]/40 dark:text-white/35">
              {new TextEncoder().encode(pasted).length} bytes · máx ~50 KB
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-black/5 dark:border-white/10">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-[12px] rounded-md text-[#0e1745]/55 dark:text-white/55 hover:bg-black/5 dark:hover:bg-white/5"
          >
            Cancelar
          </button>
          <button
            onClick={() => onConfirm(pasted)}
            disabled={!pasted.trim()}
            className="flex items-center gap-1.5 px-4 py-1.5 text-[12px] rounded-md bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90 disabled:opacity-40 transition-colors"
          >
            <Check className="w-3.5 h-3.5" />
            Usar este brief
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// STEP 3 — VIGILANCIA (sugerencias de Centinela por cliente)
// ════════════════════════════════════════════════════════════════════════
interface SuggestionsByClient {
  [clientId: string]: {
    loading: boolean;
    suggestions: Array<{
      label: string; entity_type: string; entity_id: string; rationale: string;
    }>;
    added: Set<string>;
    error: string | null;
  };
}

function VigilanciaStep({
  clientes, profile,
}: { clientes: Cliente[]; profile: UserProfile | null }) {
  const [byClient, setByClient] = useState<SuggestionsByClient>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auto-expand the first cliente
  useEffect(() => {
    if (clientes.length > 0) {
      setExpanded(new Set([clientes[0].id]));
    }
  }, [clientes]);

  // Fetch sugerencias para cada cliente expandido si no las tenemos
  useEffect(() => {
    clientes.forEach((c) => {
      if (!expanded.has(c.id)) return;
      if (byClient[c.id]) return;
      setByClient((prev) => ({
        ...prev,
        [c.id]: { loading: true, suggestions: [], added: new Set(), error: null },
      }));
      void magicHelp({
        agent: 'centinela',
        field: 'cliente-watchlist',
        context: { label: c.label, sector: c.sector, description: c.description },
      })
        .then((r) => {
          const items = (r.suggestions ?? []).map((s) =>
            typeof s === 'string'
              ? { label: s, entity_type: 'tema', entity_id: s, rationale: '' }
              : s as { label: string; entity_type: string; entity_id: string; rationale: string },
          );
          setByClient((prev) => ({
            ...prev,
            [c.id]: { loading: false, suggestions: items, added: new Set(), error: null },
          }));
        })
        .catch((err) => {
          setByClient((prev) => ({
            ...prev,
            [c.id]: { loading: false, suggestions: [], added: new Set(), error: (err as Error).message },
          }));
        });
    });
  }, [expanded, clientes, byClient]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addToList = async (clientId: string, s: { label: string; entity_type: string; entity_id: string }) => {
    try {
      await addToWatchlist({
        entity_type: s.entity_type as 'tema',
        entity_id: s.entity_id,
        label: s.label,
        client_id: clientId,
      });
      setByClient((prev) => ({
        ...prev,
        [clientId]: {
          ...prev[clientId]!,
          added: new Set([...prev[clientId]!.added, s.entity_id]),
        },
      }));
    } catch { /* swallow */ }
  };

  if (clientes.length === 0) {
    return (
      <div className="space-y-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
            Paso 3 · Vigilancia
          </p>
          <h2 className="font-display text-[26px] leading-tight font-semibold text-[#0e1745] dark:text-white">
            Sin clientes, sin vigilancia
          </h2>
          <p className="mt-1.5 text-[13px] text-[#0e1745]/55 dark:text-white/50 leading-relaxed">
            Saltaste el paso de clientes. Podés volver atrás y agregar al menos uno, o cerrar acá y agregar clientes después desde Mi memoria.
          </p>
        </div>
        <div className="p-3 rounded-lg bg-black/3 dark:bg-white/5 text-[12px] text-[#0e1745]/55 dark:text-white/50 italic">
          La watchlist de Centinela funciona por cliente. Cuando agregues uno, te vamos a sugerir qué vigilar para ese cliente.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
          Paso 3 · Vigilancia · Centinela
        </p>
        <h2 className="font-display text-[26px] leading-tight font-semibold text-[#0e1745] dark:text-white">
          ¿Qué tiene que seguir Centinela?
        </h2>
        <p className="mt-1.5 text-[13px] text-[#0e1745]/55 dark:text-white/50 leading-relaxed">
          Centinela propone qué vigilar para cada uno de tus clientes según su sector y brief. Marcá lo que te sirva. Vas a poder ajustar después desde la página de Centinela.
        </p>
      </div>

      <div className="space-y-2">
        {clientes.map((c) => {
          const state = byClient[c.id];
          const isExpanded = expanded.has(c.id);
          return (
            <div key={c.id} className="rounded-xl border border-black/8 dark:border-white/10 overflow-hidden">
              <button
                onClick={() => toggleExpanded(c.id)}
                className="w-full px-4 py-3 flex items-center gap-3 hover:bg-black/3 dark:hover:bg-white/[0.03] transition-colors"
              >
                <Users className="w-3.5 h-3.5 text-cl2-burgundy" />
                <span className="text-[13px] font-medium text-[#0e1745] dark:text-white">{c.label}</span>
                {c.sector && (
                  <span className="text-[10px] text-cl2-burgundy/80 bg-cl2-burgundy/10 px-1.5 py-0.5 rounded">
                    {c.sector}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1 text-[11px] text-[#0e1745]/45 dark:text-white/45">
                  {state && state.added.size > 0 && (
                    <span className="text-cl2-burgundy/80">{state.added.size} elegidos</span>
                  )}
                  <ChevronDown className={cn(
                    'w-3.5 h-3.5 transition-transform',
                    isExpanded && 'rotate-180',
                  )} />
                </span>
              </button>
              {isExpanded && (
                <div className="px-4 pb-4 border-t border-black/5 dark:border-white/5">
                  {!state || state.loading ? (
                    <div className="flex items-center gap-2 py-4 text-[11.5px] text-[#0e1745]/45 dark:text-white/40">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Centinela está leyendo el brief de {c.label}…
                    </div>
                  ) : state.error ? (
                    <div className="py-4 text-[11.5px] text-cl2-burgundy/80">
                      No pude generar sugerencias automáticas. Podés agregar a la watchlist manualmente desde la página de Centinela.
                    </div>
                  ) : state.suggestions.length === 0 ? (
                    <div className="py-4 text-[11.5px] text-[#0e1745]/45 dark:text-white/40 italic">
                      Sin sugerencias para este cliente. Probá darle un brief más detallado.
                    </div>
                  ) : (
                    <div className="space-y-1.5 mt-3">
                      {state.suggestions.map((s) => {
                        const isAdded = state.added.has(s.entity_id);
                        return (
                          <div
                            key={s.entity_id}
                            className={cn(
                              'flex items-start gap-2.5 p-2.5 rounded-lg transition-colors',
                              isAdded
                                ? 'bg-cl2-burgundy/5 border border-cl2-burgundy/15'
                                : 'bg-white dark:bg-white/[0.03] border border-black/5 dark:border-white/8',
                            )}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-[12.5px] font-medium text-[#0e1745] dark:text-white">{s.label}</div>
                              {s.rationale && (
                                <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 mt-0.5 leading-relaxed">{s.rationale}</div>
                              )}
                            </div>
                            <button
                              onClick={() => !isAdded && addToList(c.id, s)}
                              disabled={isAdded}
                              className={cn(
                                'flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium flex-shrink-0 transition-colors',
                                isAdded
                                  ? 'bg-cl2-burgundy/15 text-cl2-burgundy cursor-default'
                                  : 'bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90',
                              )}
                            >
                              {isAdded ? <><Check className="w-3 h-3" /> Vigilando</> : <><Eye className="w-3 h-3" /> Vigilar</>}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-3 rounded-lg bg-cl2-burgundy/5 border border-cl2-burgundy/15 flex items-start gap-2">
        <BookHeart className="w-3.5 h-3.5 text-cl2-burgundy mt-0.5 flex-shrink-0" />
        <p className="text-[11.5px] text-[#0e1745]/70 dark:text-white/65 leading-relaxed">
          Cuando hagas click en "Empezar a usar CL2", todo lo que vigilás ya queda activo. Las alertas de Centinela aparecen en la página <code className="text-[10.5px] px-1 py-0.5 rounded bg-black/5 dark:bg-white/10">/centinela</code>.
        </p>
      </div>

      {/* Tip: profile context (oculto en collapse para no distraer) */}
      <details className="text-[11px] text-[#0e1745]/45 dark:text-white/40">
        <summary className="cursor-pointer hover:text-[#0e1745]/70 dark:hover:text-white/65">
          Mostrar mi perfil cargado
        </summary>
        <div className="mt-1.5 p-2 rounded bg-black/3 dark:bg-white/5 font-mono">
          {profile?.cargo || '(sin rol)'} · {profile?.enfoque || '(sin práctica)'}
        </div>
      </details>
    </div>
  );
}
