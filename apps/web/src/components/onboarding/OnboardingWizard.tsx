/**
 * OnboardingWizard — multi-step modal for first-time users.
 *
 * Auto-shows when `profile.onboarded_at` is NULL on initial app load.
 * Steps:
 *   1. WELCOME       — meet the 3 agents, value props
 *   2. PROFILE       — cargo + enfoque (with magic-help per field)
 *   3. WATCHLIST     — Centinela proposes themes; user adds + searches
 *   4. NOTIFICATIONS — alert prefs + digest opt-in
 *   5. READY         — quick try cards (one per agent)
 *
 * Magic help is the differentiator: each text field has a ✨ button that
 * pops a small dropdown asking the relevant agent for help. The result
 * is offered as a suggestion the user can accept or dismiss.
 *
 * Skip is allowed at every step — gating onboarding is friction. The
 * profile gets saved progressively so even partial completion gives
 * Centinela something to work with.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, ArrowRight, ArrowLeft, Sparkles, BookOpen, Hammer, Eye,
  Loader2, Plus, Check, MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getProfile, updateProfile, completeOnboarding,
  magicHelp, suggestWatchlist,
  type UserProfile, type WatchlistSuggestion,
} from '@/services/onboardingApi';
import { addToWatchlist, updatePrefs, type AlertType } from '@/services/centinelaApi';

type Step = 'welcome' | 'profile' | 'watchlist' | 'notifications' | 'ready';
const STEP_ORDER: Step[] = ['welcome', 'profile', 'watchlist', 'notifications', 'ready'];

export function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProfile()
      .then((p) => {
        setProfile(p);
        // Resume at the last step the user reached, falling back to welcome
        if (p.onboarding_step && STEP_ORDER.includes(p.onboarding_step as Step)) {
          setStep(p.onboarding_step as Step);
        }
      })
      .catch(() => {
        // Defaults — onboarding still proceeds, just with empty draft
        setProfile({
          user_id: '', cargo: null, enfoque: null, temas: [], partido: null,
          onboarded_at: null, onboarding_step: 'welcome',
        });
      })
      .finally(() => setLoading(false));
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[200] flex items-center justify-center"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col bg-white dark:bg-[#161616] rounded-2xl shadow-2xl border border-black/5 dark:border-white/10 overflow-hidden">
        {/* Progress + close */}
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
          {step === 'welcome' && <WelcomeStep />}
          {step === 'profile' && profile && (
            <ProfileStep profile={profile} onChange={setProfile} />
          )}
          {step === 'watchlist' && profile && (
            <WatchlistStep profile={profile} />
          )}
          {step === 'notifications' && <NotificationsStep />}
          {step === 'ready' && <ReadyStep />}
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
            onClick={goNext}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-cl2-burgundy text-white text-[13px] font-medium hover:bg-cl2-burgundy/90 transition-colors"
          >
            {step === 'ready' ? 'Empezar a usar CL2' : 'Continuar'}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Step 1: Welcome ──────────────────────────────────────────────────────
function WelcomeStep() {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
          Bienvenida a CL2
        </p>
        <h2 className="font-display text-[28px] leading-tight font-semibold text-[#0e1745] dark:text-white">
          Tres agentes, una sola asamblea
        </h2>
        <p className="mt-2 text-[13px] text-[#0e1745]/60 dark:text-white/55 leading-relaxed">
          Cerebro Legislativo 2.0 es tu asistente para la Asamblea de Costa Rica. Cada agente tiene un trabajo específico — y todos hablan el mismo idioma: el del SIL, del Reglamento y de las sesiones plenarias.
        </p>
      </div>

      <div className="space-y-2.5">
        {[
          {
            icon: <MessageSquare className="w-4 h-4" />,
            name: 'Lexa',
            tagline: 'Pregunta · Cita',
            blurb: 'Te responde cualquier pregunta legislativa con citas inline a los expedientes, transcripciones o el Reglamento.',
          },
          {
            icon: <Hammer className="w-4 h-4" />,
            name: 'Atlas',
            tagline: 'Construye',
            blurb: 'En el workspace, arma briefs, matrices comparativas y presentaciones (.pptx) sobre los temas que le pidas.',
          },
          {
            icon: <Eye className="w-4 h-4" />,
            name: 'Centinela',
            tagline: 'Vigila',
            blurb: 'Sigue 24/7 los expedientes, diputados o temas de tu watchlist y te avisa cuando algo cambia (estado, plazos, menciones, agenda).',
          },
        ].map((a) => (
          <div
            key={a.name}
            className="flex items-start gap-3 p-3.5 rounded-xl bg-black/3 dark:bg-white/5 border border-black/5 dark:border-white/8"
          >
            <div className="w-9 h-9 rounded-lg bg-cl2-burgundy/10 text-cl2-burgundy flex items-center justify-center flex-shrink-0">
              {a.icon}
            </div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-display text-[15px] font-semibold text-[#0e1745] dark:text-white">{a.name}</span>
                <span className="text-[10.5px] uppercase tracking-wider text-cl2-burgundy/80">{a.tagline}</span>
              </div>
              <p className="mt-0.5 text-[12px] text-[#0e1745]/60 dark:text-white/55 leading-relaxed">{a.blurb}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11.5px] text-[#0e1745]/45 dark:text-white/40 italic leading-relaxed">
        En los próximos pasos vamos a personalizar Centinela para que sólo te avise sobre lo que importa. Toma 2-3 minutos.
      </p>
    </div>
  );
}

// ─── Step 2: Profile (with magic-help) ─────────────────────────────────────
function ProfileStep({
  profile, onChange,
}: { profile: UserProfile; onChange: (p: UserProfile) => void }) {
  const [cargo, setCargo] = useState(profile.cargo ?? '');
  const [enfoque, setEnfoque] = useState(profile.enfoque ?? '');
  const [helping, setHelping] = useState<'cargo-atlas' | 'enfoque-centinela' | null>(null);
  const [suggestions, setSuggestions] = useState<{ field: string; items: string[] } | null>(null);

  // Persist on blur (per-field) so partial answers don't get lost.
  const persist = useCallback(async (patch: Partial<UserProfile>) => {
    try {
      const updated = await updateProfile(patch);
      onChange(updated);
    } catch { /* non-fatal */ }
  }, [onChange]);

  const askAtlasForCargo = async () => {
    if (!cargo.trim()) return;
    setHelping('cargo-atlas');
    try {
      const r = await magicHelp({ agent: 'atlas', field: 'cargo', context: { draft: cargo } });
      if (r.suggestion) {
        setSuggestions({ field: 'cargo', items: [r.suggestion] });
      }
    } catch { /* swallow */ }
    finally { setHelping(null); }
  };

  const askCentinelaForEnfoque = async () => {
    setHelping('enfoque-centinela');
    try {
      const r = await magicHelp({ agent: 'centinela', field: 'enfoque', context: { cargo } });
      if (r.suggestions?.length) {
        setSuggestions({ field: 'enfoque', items: r.suggestions });
      }
    } catch { /* swallow */ }
    finally { setHelping(null); }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
          Sobre vos
        </p>
        <h2 className="font-display text-[26px] leading-tight font-semibold text-[#0e1745] dark:text-white">
          ¿Cuál es tu rol?
        </h2>
        <p className="mt-1.5 text-[13px] text-[#0e1745]/55 dark:text-white/50 leading-relaxed">
          Estos campos calibran a Centinela y al resto. Cuanto más concreto, mejor te sigue.
        </p>
      </div>

      {/* Cargo */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[12px] font-medium text-[#0e1745] dark:text-white/85">Cargo y comisiones</label>
          <button
            onClick={askAtlasForCargo}
            disabled={!cargo.trim() || helping !== null}
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded text-[10.5px] font-medium transition-colors',
              cargo.trim() && helping === null
                ? 'text-cl2-burgundy hover:bg-cl2-burgundy/10'
                : 'text-[#0e1745]/30 dark:text-white/25 cursor-not-allowed',
            )}
            title="Atlas pulirá tu descripción"
          >
            {helping === 'cargo-atlas'
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Sparkles className="w-3 h-3" />}
            Atlas mejora esto
          </button>
        </div>
        <textarea
          value={cargo}
          onChange={(e) => setCargo(e.target.value)}
          onBlur={() => persist({ cargo })}
          placeholder="Diputada por Cartago, asistente legislativa, miembro Comisión Hacendarios…"
          rows={2}
          className="w-full px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-cl2-burgundy/40"
        />
        {suggestions?.field === 'cargo' && (
          <SuggestionPill
            text={suggestions.items[0]}
            onAccept={() => { setCargo(suggestions.items[0]); persist({ cargo: suggestions.items[0] }); setSuggestions(null); }}
            onDismiss={() => setSuggestions(null)}
          />
        )}
      </div>

      {/* Enfoque */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-[12px] font-medium text-[#0e1745] dark:text-white/85">Enfoque y temas que seguís</label>
          <button
            onClick={askCentinelaForEnfoque}
            disabled={helping !== null}
            className={cn(
              'flex items-center gap-1.5 px-2 py-1 rounded text-[10.5px] font-medium transition-colors',
              helping === null
                ? 'text-cl2-burgundy hover:bg-cl2-burgundy/10'
                : 'text-[#0e1745]/30 dark:text-white/25 cursor-not-allowed',
            )}
            title="Centinela sugiere áreas según tu cargo"
          >
            {helping === 'enfoque-centinela'
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <Sparkles className="w-3 h-3" />}
            Centinela me sugiere
          </button>
        </div>
        <textarea
          value={enfoque}
          onChange={(e) => setEnfoque(e.target.value)}
          onBlur={() => persist({ enfoque })}
          placeholder="Reforma fiscal, transparencia presupuestaria, pequeña empresa, derechos digitales…"
          rows={3}
          className="w-full px-3 py-2 rounded-lg bg-black/3 dark:bg-white/5 border border-black/8 dark:border-white/10 text-[13px] text-[#0e1745] dark:text-white placeholder:text-[#0e1745]/35 dark:placeholder:text-white/30 resize-none focus:outline-none focus:border-cl2-burgundy/40"
        />
        {suggestions?.field === 'enfoque' && suggestions.items.length > 0 && (
          <div className="mt-2 space-y-1.5">
            <div className="text-[10.5px] uppercase tracking-wider text-cl2-burgundy/70">Centinela propone</div>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.items.map((s, i) => (
                <button
                  key={i}
                  onClick={() => {
                    const next = enfoque.trim() ? `${enfoque}, ${s}` : s;
                    setEnfoque(next); persist({ enfoque: next });
                  }}
                  className="px-2.5 py-1 rounded-full bg-cl2-burgundy/10 hover:bg-cl2-burgundy/20 text-cl2-burgundy text-[11px] font-medium flex items-center gap-1 transition-colors"
                >
                  <Plus className="w-2.5 h-2.5" />
                  {s}
                </button>
              ))}
              <button
                onClick={() => setSuggestions(null)}
                className="text-[11px] text-[#0e1745]/40 dark:text-white/40 hover:text-[#0e1745]/70 px-2 py-1"
              >
                Descartar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SuggestionPill({
  text, onAccept, onDismiss,
}: { text: string; onAccept: () => void; onDismiss: () => void }) {
  return (
    <div className="mt-2 p-2.5 rounded-lg bg-cl2-burgundy/8 border border-cl2-burgundy/15 flex items-start gap-2">
      <Sparkles className="w-3.5 h-3.5 text-cl2-burgundy flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-[#0e1745] dark:text-white leading-relaxed">{text}</p>
        <div className="mt-1.5 flex gap-2">
          <button onClick={onAccept} className="text-[10.5px] font-medium text-cl2-burgundy hover:text-cl2-burgundy/80 flex items-center gap-0.5">
            <Check className="w-3 h-3" /> Usar esto
          </button>
          <button onClick={onDismiss} className="text-[10.5px] text-[#0e1745]/45 dark:text-white/40 hover:text-[#0e1745]/70">Descartar</button>
        </div>
      </div>
    </div>
  );
}

// ─── Step 3: Watchlist ─────────────────────────────────────────────────────
function WatchlistStep({ profile }: { profile: UserProfile }) {
  const [suggestions, setSuggestions] = useState<WatchlistSuggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());

  const fetchSuggestions = useCallback(async () => {
    setLoading(true);
    try {
      const s = await suggestWatchlist({
        cargo: profile.cargo ?? undefined,
        enfoque: profile.enfoque ?? undefined,
        temas: profile.temas ?? [],
      });
      setSuggestions(s);
    } catch {
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => { void fetchSuggestions(); }, [fetchSuggestions]);

  const handleAdd = async (s: WatchlistSuggestion) => {
    try {
      await addToWatchlist({ entity_type: s.entity_type, entity_id: s.entity_id, label: s.label });
      setAdded((cur) => new Set([...cur, s.entity_id]));
    } catch { /* swallow */ }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
          Watchlist · Centinela
        </p>
        <h2 className="font-display text-[26px] leading-tight font-semibold text-[#0e1745] dark:text-white">
          Decidile a Centinela qué vigilar
        </h2>
        <p className="mt-1.5 text-[13px] text-[#0e1745]/55 dark:text-white/50 leading-relaxed">
          Basándose en tu perfil, Centinela propone temas que probablemente te importen. Agregá los que resuenen — después podés sumar expedientes y diputados específicos desde <code className="text-[11px] px-1 py-0.5 rounded bg-black/5 dark:bg-white/10">/centinela</code>.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[12px] text-[#0e1745]/45 dark:text-white/40 py-6 justify-center">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Centinela está leyendo tu perfil…
        </div>
      ) : suggestions && suggestions.length > 0 ? (
        <div className="space-y-2">
          {suggestions.map((s, i) => {
            const isAdded = added.has(s.entity_id);
            return (
              <div
                key={i}
                className={cn(
                  'p-3.5 rounded-xl border transition-all',
                  isAdded
                    ? 'bg-cl2-burgundy/5 border-cl2-burgundy/20'
                    : 'bg-white dark:bg-white/[0.04] border-black/8 dark:border-white/10',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium text-[#0e1745] dark:text-white">{s.label}</div>
                    <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 mt-0.5 leading-relaxed">{s.rationale}</div>
                  </div>
                  <button
                    onClick={() => !isAdded && handleAdd(s)}
                    disabled={isAdded}
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium flex-shrink-0 transition-colors',
                      isAdded
                        ? 'bg-cl2-burgundy/15 text-cl2-burgundy cursor-default'
                        : 'bg-cl2-burgundy text-white hover:bg-cl2-burgundy/90',
                    )}
                  >
                    {isAdded ? <><Check className="w-3 h-3" /> Agregado</> : <><Plus className="w-3 h-3" /> Vigilar</>}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-8 text-[12px] text-[#0e1745]/45 dark:text-white/40">
          No pude generar sugerencias. Podés agregar a tu watchlist manualmente desde <code className="text-[11px] px-1 py-0.5 rounded bg-black/5 dark:bg-white/10">/centinela</code>.
        </div>
      )}
    </div>
  );
}

// ─── Step 4: Notifications ─────────────────────────────────────────────────
function NotificationsStep() {
  const [enabledTypes, setEnabledTypes] = useState<Set<AlertType>>(
    new Set(['state_change', 'deadline', 'mention', 'agenda']),
  );
  const [digest, setDigest] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const toggle = (t: AlertType) => {
    setEnabledTypes((cur) => {
      const next = new Set(cur);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  const persist = useCallback(async () => {
    try {
      await updatePrefs({
        alert_types_on: Array.from(enabledTypes) as AlertType[],
        digest_enabled: digest,
        channels: { in_app: true },
      });
      setSavedAt(Date.now());
    } catch { /* swallow */ }
  }, [enabledTypes, digest]);

  useEffect(() => {
    const t = setTimeout(() => void persist(), 600);
    return () => clearTimeout(t);
  }, [enabledTypes, digest, persist]);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
          Notificaciones
        </p>
        <h2 className="font-display text-[26px] leading-tight font-semibold text-[#0e1745] dark:text-white">
          ¿Qué te avisamos?
        </h2>
        <p className="mt-1.5 text-[13px] text-[#0e1745]/55 dark:text-white/50">
          Podés cambiar esto cuando quieras desde <code className="text-[11px] px-1 py-0.5 rounded bg-black/5 dark:bg-white/10">/centinela</code>.
        </p>
      </div>

      <div className="space-y-2">
        {([
          { t: 'state_change' as AlertType, label: 'Cambio de estado', hint: 'Cuando un expediente avanza o se archiva' },
          { t: 'deadline'     as AlertType, label: 'Plazo próximo',    hint: 'A 3 días del vencimiento ordinario o cuatrienal' },
          { t: 'agenda'       as AlertType, label: 'En agenda',        hint: 'Cuando aparece en el orden del día' },
          { t: 'mention'      as AlertType, label: 'Mención en sesión',hint: 'Cuando lo nombran en plenario o comisión' },
        ]).map(({ t, label, hint }) => {
          const on = enabledTypes.has(t);
          return (
            <button
              key={t}
              onClick={() => toggle(t)}
              className={cn(
                'w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-colors',
                on
                  ? 'bg-cl2-burgundy/5 border-cl2-burgundy/25'
                  : 'bg-black/3 dark:bg-white/[0.04] border-black/8 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/8',
              )}
            >
              <div className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors',
                on ? 'bg-cl2-burgundy text-white' : 'bg-black/8 dark:bg-white/10',
              )}>
                {on && <Check className="w-3 h-3" />}
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-[#0e1745] dark:text-white">{label}</div>
                <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 mt-0.5">{hint}</div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="pt-2 border-t border-black/6 dark:border-white/8">
        <button
          onClick={() => setDigest((v) => !v)}
          className={cn(
            'w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-colors',
            digest
              ? 'bg-cl2-burgundy/5 border-cl2-burgundy/25'
              : 'bg-black/3 dark:bg-white/[0.04] border-black/8 dark:border-white/10 hover:bg-black/5 dark:hover:bg-white/8',
          )}
        >
          <Sparkles className={cn('w-4 h-4 flex-shrink-0 mt-0.5', digest ? 'text-cl2-burgundy' : 'text-[#0e1745]/40 dark:text-white/40')} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium text-[#0e1745] dark:text-white">Digest semanal Opus</span>
              <span className="text-[9px] uppercase tracking-wider text-cl2-burgundy/80 bg-cl2-burgundy/10 px-1 py-0.5 rounded">PRO</span>
            </div>
            <div className="text-[11px] text-[#0e1745]/55 dark:text-white/50 mt-0.5 leading-relaxed">
              Cada lunes a las 6am, brief sintetizado por Opus 4.7 con postura, coaliciones, momentum y oportunidades sobre tu watchlist.
            </div>
          </div>
        </button>
      </div>

      {savedAt && (
        <div className="text-[10.5px] text-[#0e1745]/40 dark:text-white/35 text-right">Guardado.</div>
      )}
    </div>
  );
}

// ─── Step 5: Ready ──────────────────────────────────────────────────────────
function ReadyStep() {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-widest text-cl2-burgundy/80 mb-1.5">
          Listo
        </p>
        <h2 className="font-display text-[26px] leading-tight font-semibold text-[#0e1745] dark:text-white">
          Probá pidiéndole algo a cada uno
        </h2>
        <p className="mt-1.5 text-[13px] text-[#0e1745]/55 dark:text-white/50">
          Ya podés empezar. Acá hay tres maneras de arrancar.
        </p>
      </div>

      <div className="space-y-2.5">
        {[
          {
            agent: 'Lexa',
            icon: <MessageSquare className="w-4 h-4" />,
            sample: '"¿Qué pasó con el expediente 24.429?"',
            where: 'Chat principal',
          },
          {
            agent: 'Atlas',
            icon: <Hammer className="w-4 h-4" />,
            sample: '"Armame un brief sobre reforma fiscal"',
            where: 'Workspace en /hojas',
          },
          {
            agent: 'Centinela',
            icon: <Eye className="w-4 h-4" />,
            sample: 'Tu watchlist te va a ir generando alertas automáticamente',
            where: '/centinela',
          },
        ].map((a) => (
          <div key={a.agent} className="flex items-start gap-3 p-3.5 rounded-xl bg-black/3 dark:bg-white/5 border border-black/5 dark:border-white/8">
            <div className="w-9 h-9 rounded-lg bg-cl2-burgundy/10 text-cl2-burgundy flex items-center justify-center flex-shrink-0">
              {a.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-[#0e1745] dark:text-white">{a.agent}</div>
              <p className="text-[12px] text-[#0e1745]/65 dark:text-white/60 mt-0.5">{a.sample}</p>
              <p className="text-[10.5px] text-[#0e1745]/40 dark:text-white/40 mt-0.5 uppercase tracking-wider">{a.where}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
