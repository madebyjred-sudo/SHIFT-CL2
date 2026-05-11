/**
 * Onboarding router — /api/onboarding
 *
 * Powers the first-time wizard:
 *   GET  /profile       — current user_profile row (or defaults)
 *   PATCH /profile      — update fields incrementally as the wizard progresses
 *   POST /complete      — mark onboarded_at, used by the final step
 *   POST /magic-help    — calls one of the 3 agents to help compose a field
 *   POST /suggest-watchlist — Centinela proposes expedientes based on profile
 *
 * The "magic help" endpoint is the differentiator: instead of dumping a
 * blank textarea on the user, we let them ask the relevant agent for help.
 * E.g.: agent='centinela' on the "enfoque" field returns 3-5 themes the
 * user might want to track based on their cargo. Composed into a small
 * server-side prompt → OpenRouter → JSON-only response → returned to UI.
 */

import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserIdFromRequest } from '../services/auth.js';
import { logger } from '../services/logger.js';
import { cerebroInvoke } from '../services/cerebroLlmClient.js';
import { getUserFromRequest } from '../services/auth.js';
import { writeNeuronFile } from '../services/cerebroNeuron.js';

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for onboarding router');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) { res.status(401).json({ ok: false, error: 'auth_required' }); return null; }
  return userId;
}

export const onboardingRouter = Router();

// ── GET /api/onboarding/profile ────────────────────────────────────────────
onboardingRouter.get('/profile', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  try {
    const { data, error } = await supa()
      .from('user_profile')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error && !/user_profile/.test(error.message)) throw new Error(error.message);

    const profile = data ?? {
      user_id: userId,
      cargo: null,
      enfoque: null,
      temas: [],
      partido: null,
      onboarded_at: null,
      onboarding_step: 'welcome',
    };
    res.json({ ok: true, profile });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── PATCH /api/onboarding/profile ──────────────────────────────────────────
//
// Write-through a la neurona del user (decisión 2026-05-11): cada vez que
// el usuario completa un campo del wizard, el contenido se serializa a
// markdown y se escribe en /memories/perfil/*.md. Esto deja la neurona
// rica desde el día uno SIN que el user toque /mi-memoria.
//
// Por qué split en archivos en lugar de un /memories/perfil.md único:
//   - Permite que carpetas se vean en el UI (folder grouping)
//   - Cada campo es editable individualmente sin pisar el resto
//   - Cuando Track A aterrice y Lexa quiera escribir "agregá esto a tus
//     temas", apunta a un path específico y conserva los otros
onboardingRouter.patch('/profile', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  const userId = user.id;
  const userEmail = user.email;
  const body = (req.body ?? {}) as {
    cargo?: string | null; enfoque?: string | null;
    temas?: string[]; partido?: string | null;
    onboarding_step?: string;
  };

  const update: Record<string, unknown> = { user_id: userId };
  if (body.cargo !== undefined) update.cargo = body.cargo;
  if (body.enfoque !== undefined) update.enfoque = body.enfoque;
  if (body.temas !== undefined) update.temas = body.temas;
  if (body.partido !== undefined) update.partido = body.partido;
  if (body.onboarding_step !== undefined) update.onboarding_step = body.onboarding_step;

  try {
    const { data, error } = await supa()
      .from('user_profile')
      .upsert(update, { onConflict: 'user_id' })
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    // Write-through a la neurona. Fire-and-forget: si Cerebro está caído,
    // el PATCH retorna ok igual y el wizard sigue. La neurona se
    // sincronizará al siguiente campo que el user complete.
    if (userEmail && data) {
      void writeProfileToNeuron(userEmail, data as ProfileRow).catch((err) => {
        logger.warn('onboarding.profile: neuron write-through failed', {
          user_id: userId, error: (err as Error).message,
        });
      });
    }

    res.json({ ok: true, profile: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ── POST /api/onboarding/complete ──────────────────────────────────────────
onboardingRouter.post('/complete', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  const userId = user.id;
  const userEmail = user.email;
  try {
    const { data, error } = await supa()
      .from('user_profile')
      .upsert(
        { user_id: userId, onboarded_at: new Date().toISOString(), onboarding_step: 'done' },
        { onConflict: 'user_id' },
      )
      .select('*')
      .single();
    if (error) throw new Error(error.message);

    // Write final state to neurona — barrido completo, no incremental.
    if (userEmail && data) {
      void writeProfileToNeuron(userEmail, data as ProfileRow).catch((err) => {
        logger.warn('onboarding.complete: neuron write-through failed', {
          user_id: userId, error: (err as Error).message,
        });
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── Profile → neurona renderer ──────────────────────────────────────
//
// Cada campo del user_profile se vuelca a su propio archivo bajo
// /memories/perfil/*.md. Esto le da al user (vía UI de Mi memoria) una
// vista de "carpeta perfil" con campos editables individualmente, y le
// da a Lexa/Atlas/Centinela cuando aterrice Track A handles granulares
// para escribir "agregale un tema más" sin pisar cargo/enfoque/partido.
//
// Path layout:
//   /memories/perfil/identidad.md   — nombre + email + rol approval-time
//   /memories/perfil/cargo.md       — qué hace en la Asamblea
//   /memories/perfil/enfoque.md     — línea de trabajo
//   /memories/perfil/temas.md       — lista de áreas de interés
//   /memories/perfil/partido.md     — fracción / bloque (si aplica)
//
// La función borra el archivo si el campo está vacío — el user puede
// limpiar campos durante el wizard sin que queden archivos huérfanos.
interface ProfileRow {
  user_id: string;
  cargo: string | null;
  enfoque: string | null;
  temas: string[] | null;
  partido: string | null;
  onboarded_at: string | null;
  onboarding_step: string | null;
}

async function writeProfileToNeuron(email: string, profile: ProfileRow): Promise<void> {
  const writes: Array<Promise<unknown>> = [];

  // Identidad (siempre se escribe)
  writes.push(
    writeNeuronFile(
      email,
      '/memories/perfil/identidad.md',
      `# Identidad\n\n- **Email**: ${email}\n- **Estado del onboarding**: ${profile.onboarding_step ?? 'pendiente'}\n${profile.onboarded_at ? `- **Completado**: ${profile.onboarded_at.slice(0, 10)}\n` : ''}`,
    ),
  );

  if (profile.cargo && profile.cargo.trim()) {
    writes.push(
      writeNeuronFile(
        email,
        '/memories/perfil/cargo.md',
        `# Cargo\n\n${profile.cargo.trim()}\n`,
      ),
    );
  }
  if (profile.enfoque && profile.enfoque.trim()) {
    writes.push(
      writeNeuronFile(
        email,
        '/memories/perfil/enfoque.md',
        `# Enfoque\n\n${profile.enfoque.trim()}\n`,
      ),
    );
  }
  if (profile.temas && profile.temas.length > 0) {
    const list = profile.temas.map((t) => `- ${t}`).join('\n');
    writes.push(
      writeNeuronFile(
        email,
        '/memories/perfil/temas.md',
        `# Temas de interés\n\n${list}\n`,
      ),
    );
  }
  if (profile.partido && profile.partido.trim()) {
    writes.push(
      writeNeuronFile(
        email,
        '/memories/perfil/partido.md',
        `# Partido / fracción\n\n${profile.partido.trim()}\n`,
      ),
    );
  }

  await Promise.allSettled(writes);
}

// ── POST /api/onboarding/magic-help ────────────────────────────────────────
//
// Body: { agent: 'lexa'|'atlas'|'centinela', field: string, context: object }
// Returns: { suggestion: string }  OR  { suggestions: string[] }
//
// Implementation: a single Cerebro `/v1/llm/invoke` call con
// `enable_memory=true` para que la neurona del user se vaya enriqueciendo
// a medida que pasa el wizard (Track 0c, 2026-05-11). Output is
// JSON-fenced; we parse + sanitize.
const OR_MODEL = 'anthropic/claude-sonnet-4.5';

const MAGIC_HELP_PROMPTS: Record<string, (ctx: Record<string, unknown>) => string> = {
  // Centinela on "enfoque" — proposes 3-5 themes the user might track,
  // grounded on their cargo. Used during onboarding to seed Centinela.
  'centinela:enfoque': (ctx) =>
    `Sos Centinela, watchdog legislativo costarricense. Un usuario en CL2 acaba de decirme su cargo:

CARGO: ${ctx.cargo ?? '(no especificado)'}

Tu trabajo es proponerle 3-5 áreas temáticas que probablemente quiera vigilar (no expedientes específicos — TEMAS). Considerá: comisiones donde participaría, problemas que típicamente atacan, temas de coyuntura. Una línea por tema, sin viñetas, sin numeración.

DEVOLVÉ JSON: {"suggestions": ["tema 1", "tema 2", ...]}`,

  // Atlas on "cargo" — refine a sloppy cargo description into a structured one.
  'atlas:cargo': (ctx) =>
    `Sos Atlas, arquitecto documental del SIL costarricense. Un usuario me dio una descripción cruda de su rol:

CRUDO: "${ctx.draft ?? ''}"

Reescribilo en una sola frase concisa que combine: rol + comisiones + foco temático principal. Máximo 25 palabras. Sin emojis, registro ejecutivo seco.

DEVOLVÉ JSON: {"suggestion": "..."}`,

  // Lexa on "temas" — expand a single theme into related sub-themes the user might want
  'lexa:temas': (ctx) =>
    `Sos Lexa, analista legislativa. Un usuario me dijo que le interesa este tema:

TEMA: "${ctx.draft ?? ''}"

Proponele 4-6 sub-temas relacionados que probablemente también le importen. Una palabra o frase corta por sub-tema, sin viñetas, sin numeración.

DEVOLVÉ JSON: {"suggestions": ["sub-tema 1", "sub-tema 2", ...]}`,
};

onboardingRouter.post('/magic-help', async (req, res) => {
  // Necesitamos id + email — el email es el user_id canónico de Cerebro.
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  const userId = user.id;
  const userEmail = user.email;
  const { agent, field, context } = (req.body ?? {}) as {
    agent?: string; field?: string; context?: Record<string, unknown>;
  };
  const key = `${agent}:${field}`;
  const promptBuilder = MAGIC_HELP_PROMPTS[key];
  if (!promptBuilder) {
    res.status(400).json({ ok: false, error: 'unknown_help_topic', hint: Object.keys(MAGIC_HELP_PROMPTS) });
    return;
  }

  const systemPrompt = promptBuilder(context ?? {});
  try {
    // Cerebro: enable_memory=true → si el user ya tiene contexto en su
    // neurona (de turnos anteriores del onboarding o de chat) se inyecta
    // automático. Y si el LLM detecta info persistible en la respuesta,
    // la escribe back sin código del lado de CL2.
    const resp = await cerebroInvoke({
      model: OR_MODEL,
      messages: [{ role: 'system', content: systemPrompt }],
      max_tokens: 400,
      temperature: 0.7,
      app_id: 'cl2',
      trace_label: `onboarding:magic-help:${key}`,
      realm: 'cl2',
      user_id: userEmail,
      enable_memory: Boolean(userEmail),
    });
    const raw = resp.text || '{}';
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped) as { suggestion?: string; suggestions?: string[] };
    res.json({ ok: true, ...parsed });
  } catch (err) {
    logger.warn('onboarding_magic_help_failed', {
      userId, key, error: (err as Error).message,
    });
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

// ── POST /api/onboarding/suggest-watchlist ─────────────────────────────────
//
// Centinela proposes 5-8 expedientes for the user to follow, grounded on
// their profile. Uses a vector search if available; for MVP we keep it
// simple and just ask the LLM (no RAG) — output is suggestions-as-numbers
// plus rationale. The wizard renders [Agregar] / [Saltar] for each.
onboardingRouter.post('/suggest-watchlist', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  const userId = user.id;
  const userEmail = user.email;
  const profile = (req.body?.profile ?? {}) as { cargo?: string; enfoque?: string; temas?: string[] };

  const systemPrompt =
    `Sos Centinela. Un usuario quiere armar su watchlist inicial. Su perfil:\n\n` +
    `CARGO: ${profile.cargo ?? '(no especificado)'}\n` +
    `ENFOQUE: ${profile.enfoque ?? '(no especificado)'}\n` +
    `TEMAS: ${(profile.temas ?? []).join(', ') || '(no especificado)'}\n\n` +
    `Proponé 5 áreas o tipos de expediente concretos que debería vigilar. Para cada uno, ` +
    `dame un nombre corto (rotulo) y una razón breve (por qué le importa al usuario).\n\n` +
    `DEVOLVÉ JSON con esta forma exacta:\n` +
    `{"suggestions": [{"label": "...", "entity_type": "tema", "entity_id": "...", "rationale": "..."}, ...]}\n\n` +
    `entity_type es siempre "tema" en este endpoint (no proponemos números de expediente — el usuario los buscará después). entity_id puede ser igual al label.`;

  try {
    const resp = await cerebroInvoke({
      model: OR_MODEL,
      messages: [{ role: 'system', content: systemPrompt }],
      max_tokens: 800,
      temperature: 0.5,
      app_id: 'cl2',
      trace_label: 'onboarding:suggest-watchlist',
      realm: 'cl2',
      user_id: userEmail,
      enable_memory: Boolean(userEmail),
    });
    const raw = resp.text || '{}';
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(stripped) as {
      suggestions?: Array<{ label: string; entity_type: string; entity_id: string; rationale: string }>;
    };
    res.json({ ok: true, suggestions: parsed.suggestions ?? [] });
  } catch (err) {
    logger.warn('onboarding_suggest_watchlist_failed', {
      userId, error: (err as Error).message,
    });
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});
