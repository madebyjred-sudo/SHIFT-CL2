/**
 * /api/ral — Reglamento de la Asamblea Legislativa COMENTADO.
 *
 * Endpoints:
 *   GET /api/ral/articulo/:numero        → artículo + interpretaciones
 *   GET /api/ral/articulo/:numero/:inciso → inciso específico + interpretaciones
 *   GET /api/ral/search?q=...&k=5        → búsqueda por texto
 *   GET /api/ral/doctrina                → estado del catálogo de PDFs de doctrina
 *
 * Auth: JWT gate (Supabase, mismo que el resto de /api).
 *       La tabla ral_articulos tiene RLS "all read authenticated".
 *
 * Track F, Sprint 1 — 2026-05-14.
 */
import { Router, type Request, type Response } from 'express';
import { getUserIdFromRequest } from '../services/auth.js';
import { searchRalComentado } from '../services/silClient.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const ralRouter = Router();

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── GET /api/ral/articulo/:numero ────────────────────────────────────────────
// Lookup directo por número de artículo.
// También sirve como /api/ral/articulo/:numero/:inciso si hay un segundo param.

ralRouter.get('/articulo/:numero/:inciso?', async (req: Request, res: Response) => {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const numero = String(req.params.numero ?? '');
  const inciso = req.params.inciso ? String(req.params.inciso) : undefined;
  const k = Math.min(Number(req.query.k ?? 10), 20);

  try {
    const hits = await searchRalComentado({
      articulo_numero: numero,
      inciso,
      k,
    });

    if (hits.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'not_found',
        message: `Artículo ${numero}${inciso ? `, inciso ${inciso}` : ''} no encontrado en el RAL Comentado indexado. ` +
          `Verificá que la migración 0035_ral_comentado.sql esté aplicada y el ingest corrió.`,
      });
    }

    return res.json({ ok: true, articulos: hits, total: hits.length });
  } catch (err) {
    req.log?.error('ral_articulo_error', { error: (err as Error).message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ─── GET /api/ral/search?q=...&k=5 ───────────────────────────────────────────
// Búsqueda por texto en el RAL Comentado.

ralRouter.get('/search', async (req: Request, res: Response) => {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const query = String(req.query.q ?? '').trim();
  if (!query) return res.status(400).json({ ok: false, error: 'q param required' });

  const k = Math.min(Number(req.query.k ?? 5), 15);

  try {
    const hits = await searchRalComentado({ query, k });
    return res.json({ ok: true, articulos: hits, total: hits.length, query });
  } catch (err) {
    req.log?.error('ral_search_error', { error: (err as Error).message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ─── GET /api/ral/doctrina ────────────────────────────────────────────────────
// Estado del catálogo de PDFs de doctrina (para dashboard admin / health check).

ralRouter.get('/doctrina', async (req: Request, res: Response) => {
  const userId = await getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

  try {
    const { data, error } = await supa()
      .from('doctrina_pdfs')
      .select('id, nombre_archivo, url_publica, estado, last_downloaded_at, last_indexed_at, paginas, notas')
      .order('created_at', { ascending: true });

    if (error) {
      if (error.code === '42P01') {
        return res.status(503).json({
          ok: false,
          error: 'migration_not_applied',
          message: 'Apply migration 0035_ral_comentado.sql first.',
        });
      }
      throw error;
    }

    const summary = {
      total: data?.length ?? 0,
      indexed: data?.filter((p: { estado: string }) => p.estado === 'indexed').length ?? 0,
      pending: data?.filter((p: { estado: string }) => p.estado === 'pending').length ?? 0,
      failed: data?.filter((p: { estado: string }) => p.estado === 'failed').length ?? 0,
    };

    return res.json({ ok: true, summary, pdfs: data ?? [] });
  } catch (err) {
    req.log?.error('ral_doctrina_error', { error: (err as Error).message });
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
