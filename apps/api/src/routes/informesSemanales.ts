/**
 * informesSemanales.ts — Sprint 3 Track P.
 *
 * Endpoints user-facing para que cada consultor lea sus informes semanales
 * editoriales generados por el job `generateInformeSemanal`.
 *
 * RLS: la tabla `cl2_informes_semanales` tiene policy "read own informes"
 * que filtra por user_id = auth.uid(). Usamos el cliente service-role
 * acá + filter explícito por user_id del JWT, que es el mismo resultado
 * pero con mejor visibilidad en logs.
 *
 *   GET /api/informes-semanales
 *     → lista preview (semana + counts + fecha) del user logged in
 *
 *   GET /api/informes-semanales/:semana_iso
 *     → cuerpo_md completo + acciones_propuestas del informe
 *
 * Auth: getUserIdFromRequest (JWT Supabase).
 *
 * Author: Jred / Claude Code — 2026-05-16
 */

import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserIdFromRequest } from '../services/auth.js';

export const informesSemanalesRouter = Router();

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error('Supabase env vars missing (informesSemanales)');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

/**
 * GET /api/informes-semanales
 *
 * Devuelve preview de cada informe del user: semana + counts + fecha
 * (sin el cuerpo_md completo). Lista por generated_at desc.
 */
informesSemanalesRouter.get('/', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  try {
    const { data, error } = await supa()
      .from('cl2_informes_semanales')
      .select(
        'id, semana_iso, novedades_count, alertas_criticas, expedientes_nuevos, generated_at, enviado_email',
      )
      .eq('user_id', userId)
      .order('generated_at', { ascending: false })
      .limit(52); // un año

    if (error) {
      req.log?.error('informes_list_failed', { error: error.message, user_id: userId });
      res.status(500).json({ ok: false, error: error.message });
      return;
    }

    res.json({ ok: true, items: data ?? [] });
  } catch (err) {
    req.log?.error('informes_list_threw', { error: (err as Error).message, user_id: userId });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/**
 * GET /api/informes-semanales/:semana_iso
 *
 * Devuelve el informe completo (cuerpo_md + acciones_propuestas) para
 * la semana ISO dada.
 *
 * 404 si el user no tiene informe esa semana.
 */
informesSemanalesRouter.get('/:semana_iso', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const semanaIso = req.params.semana_iso;
  if (!/^\d{4}-W\d{2}$/.test(semanaIso)) {
    res.status(400).json({ ok: false, error: 'bad_semana_iso', hint: 'formato YYYY-Www' });
    return;
  }

  try {
    const { data, error } = await supa()
      .from('cl2_informes_semanales')
      .select(
        'id, semana_iso, cuerpo_md, novedades_count, alertas_criticas, expedientes_nuevos, acciones_propuestas, generated_at, enviado_email',
      )
      .eq('user_id', userId)
      .eq('semana_iso', semanaIso)
      .maybeSingle();

    if (error) {
      req.log?.error('informe_detail_failed', {
        error: error.message,
        user_id: userId,
        semana_iso: semanaIso,
      });
      res.status(500).json({ ok: false, error: error.message });
      return;
    }

    if (!data) {
      res.status(404).json({ ok: false, error: 'informe_not_found', semana_iso: semanaIso });
      return;
    }

    res.json({ ok: true, informe: data });
  } catch (err) {
    req.log?.error('informe_detail_threw', {
      error: (err as Error).message,
      user_id: userId,
    });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
