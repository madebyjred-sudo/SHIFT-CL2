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
  };
  if (!body.label?.trim()) {
    res.status(400).json({ ok: false, error: 'label required' });
    return;
  }
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
  };
  const update: Record<string, unknown> = {};
  if (body.label !== undefined) update.label = body.label.trim();
  if (body.description !== undefined) update.description = body.description.trim();
  if (body.sector !== undefined) update.sector = body.sector?.trim() || null;
  if (body.contact_email !== undefined) update.contact_email = body.contact_email?.trim() || null;
  if (body.contact_whatsapp !== undefined) update.contact_whatsapp = body.contact_whatsapp?.trim() || null;
  if (body.archived !== undefined) update.archived = body.archived;

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
