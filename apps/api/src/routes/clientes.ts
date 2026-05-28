/**
 * /api/clientes — CRUD de los clientes que cada consultor de CL2
 * asesora.
 *
 * Cada cliente vive en dos planos sincronizados:
 *   1. Tabla `cl2_clients` (Supabase, RLS user_id) — source of truth
 *      para joins, watchlist scoping, futuras alertas directas.
 *   2. Archivo `/memories/clientes/<slug>.md` en la neurona del consultor
 *      (Cerebro). Es el contexto que los agentes leen al inicio de cada
 *      conversación. Se sincroniza desde el BFF en cada write.
 *
 * Las dos representaciones pueden divergir si Cerebro está down o si el
 * user edita el archivo de neurona directamente desde /mi-memoria. En
 * esos casos:
 *   - La tabla relacional siempre se actualiza primero.
 *   - El write a neurona es best-effort (fire-and-forget) — si falla, se
 *     loggea pero el response al usuario es OK.
 *   - Al GET /api/clientes, leemos la tabla (no la neurona) — más rápido
 *     y consistente para listados.
 */
import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserFromRequest } from '../services/auth.js';
import {
  writeNeuronFile,
  deleteNeuronFile,
} from '../services/cerebroNeuron.js';
import { logger } from '../services/logger.js';

export const clientesRouter = Router();

// ─── Supabase singleton ───────────────────────────────────────────────
let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── Slug helper ──────────────────────────────────────────────────────
// Mantiene el slug ASCII-only para que el path en neurona y la URL
// queden sanos. No es de seguridad — es de UX y de consistencia con la
// metáfora de folders en /mi-memoria.
function slugifyLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cliente';
}

interface ClienteRow {
  id: string;
  user_id: string;
  slug: string;
  label: string;
  description: string | null;
  sector: string | null;
  contact_email: string | null;
  contact_whatsapp: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  // 2026-05-26 Ronald F2 — campos de personalización del contexto.
  // context_prompt: prosa rica (3-5 párrafos) inyectada al system de
  //   Lexa/Atlas cuando el user asociado chatea.
  // context_keywords: keywords explícitos para el matcher de Centinela.
  // uploaded_docs: placeholder para Phase 2E (pipeline embed → chunks).
  context_prompt: string | null;
  context_keywords: string[] | null;
  uploaded_docs: Array<Record<string, unknown>>;
}

// ─── Render para neurona ──────────────────────────────────────────────
// El archivo markdown que los agentes van a leer. Estructura pensada
// para que Lexa/Atlas/Centinela puedan citar bloques específicos
// ("según el brief de cliente Acme, su interés principal es...").
function renderClienteForNeuron(c: ClienteRow): string {
  const lines: string[] = [];
  lines.push(`# ${c.label}`);
  lines.push('');
  if (c.sector) lines.push(`**Sector**: ${c.sector}`);
  if (c.contact_email) lines.push(`**Email de contacto**: ${c.contact_email}`);
  if (c.contact_whatsapp) lines.push(`**WhatsApp**: ${c.contact_whatsapp}`);
  if (c.sector || c.contact_email || c.contact_whatsapp) lines.push('');
  if (c.description && c.description.trim()) {
    lines.push('## Brief');
    lines.push('');
    lines.push(c.description.trim());
    lines.push('');
  }
  lines.push(`_Cliente registrado: ${c.created_at.slice(0, 10)}_`);
  return lines.join('\n');
}

// ─── Helpers de sync neurona ──────────────────────────────────────────
async function syncClienteToNeuron(email: string | null, c: ClienteRow): Promise<void> {
  if (!email) return;
  const path = `/memories/clientes/${c.slug}.md`;
  try {
    await writeNeuronFile(email, path, renderClienteForNeuron(c));
  } catch (err) {
    logger.warn('clientes.sync: neuron write failed', {
      user_id: c.user_id,
      slug: c.slug,
      error: (err as Error).message,
    });
  }
}

async function removeClienteFromNeuron(email: string | null, slug: string): Promise<void> {
  if (!email) return;
  try {
    await deleteNeuronFile(email, `/memories/clientes/${slug}.md`);
  } catch (err) {
    logger.warn('clientes.sync: neuron delete failed', {
      slug, error: (err as Error).message,
    });
  }
}

// ─── Resolución de slug único ─────────────────────────────────────────
// Si dos clientes del mismo user comparten label, agregamos sufijo
// numérico al slug del segundo (acme, acme-2, acme-3). El BFF lo
// resuelve antes del INSERT.
async function uniqueSlugForUser(userId: string, base: string): Promise<string> {
  const slug = slugifyLabel(base);
  const { data, error } = await supa()
    .from('cl2_clients')
    .select('slug')
    .eq('user_id', userId)
    .like('slug', `${slug}%`);
  if (error) throw new Error(error.message);
  const taken = new Set((data ?? []).map((r) => (r as { slug: string }).slug));
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 100; i++) {
    const candidate = `${slug}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${slug}-${Date.now()}`;
}

// ═════════════════════════════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════════════════════════════

// GET /api/clientes — list user's clients (active + archived flag)
clientesRouter.get('/', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  const includeArchived = req.query.archived === '1';
  try {
    let q = supa()
      .from('cl2_clients')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (!includeArchived) q = q.eq('archived', false);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ ok: true, items: data ?? [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// GET /api/clientes/:id — single client
clientesRouter.get('/:id', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  try {
    const { data, error } = await supa()
      .from('cl2_clients')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
    res.json({ ok: true, cliente: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/clientes — create
clientesRouter.post('/', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  const body = (req.body ?? {}) as {
    label?: string; description?: string; sector?: string;
    contact_email?: string; contact_whatsapp?: string;
    // F2 — context_prompt + keywords. Permitidos en create para que el
    // admin pueda alimentar el contexto en un solo paso.
    context_prompt?: string;
    context_keywords?: string[] | string;
  };
  if (!body.label?.trim()) {
    res.status(400).json({ ok: false, error: 'label required' });
    return;
  }
  // context_keywords puede llegar como array o como string CSV — normalizamos.
  const keywords = Array.isArray(body.context_keywords)
    ? body.context_keywords
    : typeof body.context_keywords === 'string'
      ? body.context_keywords.split(',').map((s) => s.trim()).filter(Boolean)
      : null;
  try {
    const slug = await uniqueSlugForUser(user.id, body.label);
    const { data, error } = await supa()
      .from('cl2_clients')
      .insert({
        user_id: user.id,
        slug,
        label: body.label.trim(),
        description: (body.description ?? '').trim(),
        sector: body.sector?.trim() || null,
        contact_email: body.contact_email?.trim() || null,
        contact_whatsapp: body.contact_whatsapp?.trim() || null,
        context_prompt: body.context_prompt?.trim() || null,
        context_keywords: keywords,
      })
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    const row = data as ClienteRow;
    // Sync best-effort a la neurona.
    void syncClienteToNeuron(user.email ?? null, row);
    res.json({ ok: true, cliente: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// PATCH /api/clientes/:id — update partial
clientesRouter.patch('/:id', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  const body = (req.body ?? {}) as {
    label?: string; description?: string; sector?: string | null;
    contact_email?: string | null; contact_whatsapp?: string | null;
    archived?: boolean;
    // F2 — partial update de los campos de personalización.
    context_prompt?: string | null;
    context_keywords?: string[] | string | null;
  };
  const update: Record<string, unknown> = {};
  if (body.label !== undefined) update.label = body.label.trim();
  if (body.description !== undefined) update.description = body.description.trim();
  if (body.sector !== undefined) update.sector = body.sector?.trim() || null;
  if (body.contact_email !== undefined) update.contact_email = body.contact_email?.trim() || null;
  if (body.contact_whatsapp !== undefined) update.contact_whatsapp = body.contact_whatsapp?.trim() || null;
  if (body.archived !== undefined) update.archived = body.archived;
  if (body.context_prompt !== undefined) {
    update.context_prompt = body.context_prompt === null ? null : body.context_prompt.trim() || null;
  }
  if (body.context_keywords !== undefined) {
    if (body.context_keywords === null) {
      update.context_keywords = null;
    } else if (Array.isArray(body.context_keywords)) {
      update.context_keywords = body.context_keywords;
    } else if (typeof body.context_keywords === 'string') {
      update.context_keywords = body.context_keywords.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ ok: false, error: 'no fields to update' });
    return;
  }

  try {
    const { data, error } = await supa()
      .from('cl2_clients')
      .update(update)
      .eq('id', req.params.id)
      .eq('user_id', user.id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
    const row = data as ClienteRow;
    // Re-sync neurona. Si el cliente fue archivado, igual mantenemos el
    // archivo en la neurona — los agentes pueden ver clientes históricos.
    // Si en el futuro queremos esconder archivados de la neurona, acá
    // sería el lugar para `deleteNeuronFile`.
    void syncClienteToNeuron(user.email ?? null, row);
    res.json({ ok: true, cliente: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// DELETE /api/clientes/:id — hard delete (cascades watchlist entries)
clientesRouter.delete('/:id', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  try {
    // Recuperamos el slug ANTES de borrar para limpiar el archivo de neurona.
    const { data: row, error: readErr } = await supa()
      .from('cl2_clients')
      .select('slug')
      .eq('id', req.params.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) { res.status(404).json({ ok: false, error: 'not_found' }); return; }

    const { error: delErr } = await supa()
      .from('cl2_clients')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', user.id);
    if (delErr) throw new Error(delErr.message);

    void removeClienteFromNeuron(user.email ?? null, (row as { slug: string }).slug);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── F3 — WhatsApp alerts: list por cliente ────────────────────────
//
// GET /api/clientes/:id/whatsapp-alerts?status=pending|sent|...
//   Lista alertas asociadas a un cliente. Cualquier user puede ver las
//   suyas (RLS lo controla); admin/operador ve las de todos.
clientesRouter.get('/:id/whatsapp-alerts', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  try {
    const { listAlerts } = await import('../services/whatsappAlerts.js');
    const status = (req.query.status as string | undefined) as 'pending' | 'sent' | 'failed' | 'skipped' | undefined;
    const alerts = await listAlerts({
      cliente_id: req.params.id,
      status,
      limit: 50,
    });
    res.json({ ok: true, items: alerts });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/clientes/:id/whatsapp-alerts/process
//   Trigger manual del worker. Solo admin/operador.
clientesRouter.post('/:id/whatsapp-alerts/process', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }
  // Check role.
  const { data: ua } = await supa()
    .from('user_access').select('role').eq('user_id', user.id).maybeSingle();
  const role = (ua as { role?: string } | null)?.role;
  if (role !== 'admin' && role !== 'operador') {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }
  try {
    const { processPendingAlerts } = await import('../services/whatsappAlerts.js');
    const result = await processPendingAlerts(50);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// ─── F2 — Asociar user (role='cliente') con cliente ──────────────────
//
// POST /api/clientes/:id/assign-user { user_email: string }
//   Setea user_access.cliente_id = :id para el user identificado por email.
//   Solo admins de CL2 (operador/admin) pueden hacer esto — el cliente final
//   NO debe poder cambiar su propia asociación.
//
// Esto es lo que activa el chat injection (Phase 2C): cuando el user loguea,
// chat.ts lee access.cliente_id, hace lookup en cl2_clients, y prepend
// context_prompt al system de Lexa/Atlas.
clientesRouter.post('/:id/assign-user', async (req, res) => {
  const requester = await getUserFromRequest(req);
  if (!requester) { res.status(401).json({ ok: false, error: 'auth_required' }); return; }

  // Verificar que el requester es operador/admin (no cliente, no lector/editor).
  const { data: requesterAccess } = await supa()
    .from('user_access')
    .select('role')
    .eq('user_id', requester.id)
    .maybeSingle();
  const requesterRole = (requesterAccess as { role?: string } | null)?.role;
  if (requesterRole !== 'admin' && requesterRole !== 'operador') {
    res.status(403).json({ ok: false, error: 'forbidden', message: 'Solo admin/operador puede asociar usuarios a clientes.' });
    return;
  }

  const body = (req.body ?? {}) as { user_email?: string };
  if (!body.user_email?.trim()) {
    res.status(400).json({ ok: false, error: 'user_email required' });
    return;
  }
  const targetEmail = body.user_email.trim().toLowerCase();

  // Verificar que el cliente existe y pertenece al requester (o es de un user del workspace CL2).
  const { data: clienteRow, error: cliErr } = await supa()
    .from('cl2_clients')
    .select('id, user_id, label')
    .eq('id', req.params.id)
    .maybeSingle();
  if (cliErr) { res.status(500).json({ ok: false, error: cliErr.message }); return; }
  if (!clienteRow) { res.status(404).json({ ok: false, error: 'cliente_not_found' }); return; }

  // Buscar al target user por email.
  const { data: targetAccess, error: targetErr } = await supa()
    .from('user_access')
    .select('user_id, email, role, cliente_id')
    .eq('email', targetEmail)
    .maybeSingle();
  if (targetErr) { res.status(500).json({ ok: false, error: targetErr.message }); return; }
  if (!targetAccess) { res.status(404).json({ ok: false, error: 'user_not_found', message: `No existe un user_access con email "${targetEmail}". Pediles que se registren primero.` }); return; }

  // Actualizar user_access.cliente_id.
  const { error: updErr } = await supa()
    .from('user_access')
    .update({ cliente_id: req.params.id })
    .eq('user_id', (targetAccess as { user_id: string }).user_id);
  if (updErr) { res.status(500).json({ ok: false, error: updErr.message }); return; }

  logger.info('cliente_user_assigned', {
    cliente_id: req.params.id,
    cliente_label: (clienteRow as { label: string }).label,
    assigned_user_email: targetEmail,
    assigned_by: requester.email,
  });

  res.json({
    ok: true,
    assignment: {
      user_email: targetEmail,
      cliente_id: req.params.id,
      cliente_label: (clienteRow as { label: string }).label,
    },
  });
});
