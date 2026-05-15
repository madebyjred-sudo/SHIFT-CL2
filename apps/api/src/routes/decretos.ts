/**
 * Decretos Ejecutivos — endpoints para el dashboard "Estado del Plenario".
 *
 * Contexto (Carlos Villalobos, reunión 2026-05-14):
 *   Durante sesiones extraordinarias (may-jul + nov-ene), la Presidenta de la
 *   República controla la agenda del Plenario vía decretos que amplían o retiran
 *   expedientes de la convocatoria. Este módulo expone esa información en tiempo real.
 *
 * ROUTERS EXPORTADOS:
 *   decretoUserRouter    → montado en /api/decretos
 *     GET /estado-plenario   — resumen del Plenario actual (convocados vivos)
 *     GET /list              — lista paginada de decretos procesados
 *     GET /:id               — detalle de un decreto con expedientes afectados
 *
 *   decretoAdminRouter   → montado en /api/admin/decretos
 *     POST /ingest-now       — trigger manual del ingestor (dev/admin)
 *
 * AUTH: todos los endpoints de usuario requieren JWT de Supabase.
 *   El admin endpoint requiere además rol admin o cualquier usuario autenticado
 *   (misma convención que centinela admin — demo mode).
 *
 * Source: Track D, Sprint 1. Jred 2026-05-14.
 */

import { Router, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getUserIdFromRequest } from '../services/auth.js';
import { ingestNewDecretos, DECRETOS_LIST_ID } from '../services/decretoIngestor.js';
import { logger } from '../services/logger.js';

// ─── Supabase client (lazy, service role) ────────────────────────────────────

let _supa: SupabaseClient | null = null;
function supa(): SupabaseClient {
  if (_supa) return _supa;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('supabase env missing for decretos router');
  _supa = createClient(url, key, { auth: { persistSession: false } });
  return _supa;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

async function requireUser(req: Request, res: Response): Promise<string | null> {
  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return null;
  }
  return userId;
}

// ─── User router ──────────────────────────────────────────────────────────────

export const decretoUserRouter = Router();

/**
 * GET /api/decretos/estado-plenario
 *
 * Resumen del estado actual de la convocatoria del Plenario.
 * Responde con:
 *   - total_convocados: expedientes con sigue_vigente=true y accion='convocado'
 *   - total_retirados:  expedientes con sigue_vigente=true y accion='retirado'
 *                       (retirado recientemente — último estado es 'retirado')
 *   - ultimo_decreto:   fecha + numero_decreto del decreto más reciente procesado
 *   - top_recientes:    últimos 10 expedientes convocados (más recientes primero)
 *   - en_sesiones_extraordinarias: boolean heurístico basado en el mes actual
 */
decretoUserRouter.get('/estado-plenario', async (req: Request, res: Response) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  try {
    // ── Expedientes convocados vivos ──────────────────────────────────────
    const { data: convocados, error: convError } = await supa()
      .from('estado_plenario_actual')
      .select('expediente_id, fecha_decreto, decreto_id')
      .eq('accion', 'convocado')
      .eq('sigue_vigente', true)
      .order('fecha_decreto', { ascending: false });

    if (convError) throw convError;

    // ── Expedientes retirados recientemente (último estado = retirado) ──
    const { data: retirados, error: retError } = await supa()
      .from('estado_plenario_actual')
      .select('expediente_id, fecha_decreto')
      .eq('accion', 'retirado')
      .eq('sigue_vigente', true)  // sigue_vigente aquí = es el estado más reciente
      .order('fecha_decreto', { ascending: false });

    if (retError) throw retError;

    // ── Último decreto procesado ──────────────────────────────────────────
    const { data: ultimoDecretoRows, error: ultError } = await supa()
      .from('decretos_ejecutivos')
      .select('id, numero_decreto, fecha, tipo, procesado_at')
      .eq('parser_status', 'done')
      .order('fecha', { ascending: false })
      .limit(1);

    if (ultError) throw ultError;
    const ultimo_decreto = ultimoDecretoRows?.[0] ?? null;

    // ── Top 10 expedientes convocados más recientes ───────────────────────
    const top_recientes = (convocados ?? []).slice(0, 10).map((r) => ({
      expediente_id: r.expediente_id as string,
      fecha_decreto: r.fecha_decreto as string,
    }));

    // ── Heurística de sesiones extraordinarias ────────────────────────────
    // Períodos: mayo-julio (5-7) y noviembre-enero (11-12, 1)
    const mesActual = new Date().getMonth() + 1; // 1-12
    const en_sesiones_extraordinarias = [1, 5, 6, 7, 11, 12].includes(mesActual);

    res.json({
      ok: true,
      data: {
        total_convocados: (convocados ?? []).length,
        total_retirados:  (retirados ?? []).length,
        ultimo_decreto,
        top_recientes,
        en_sesiones_extraordinarias,
        // Timestamp de cuándo se calculó este resumen (para el badge "actualizado hace X")
        calculado_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('[decretos] /estado-plenario error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/**
 * GET /api/decretos/list?page=1&per_page=20&tipo=ampliacion
 *
 * Lista paginada de decretos procesados, más reciente primero.
 * Filtros opcionales: tipo (ampliacion|retiro|mixto)
 */
decretoUserRouter.get('/list', async (req: Request, res: Response) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const page = Math.max(1, parseInt(req.query.page as string ?? '1', 10));
  const per_page = Math.min(50, Math.max(1, parseInt(req.query.per_page as string ?? '20', 10)));
  const tipo = req.query.tipo as string | undefined;
  const offset = (page - 1) * per_page;

  try {
    let query = supa()
      .from('decretos_ejecutivos')
      .select('id, numero_decreto, fecha, tipo, parser_status, procesado_at, documento_url, periodo_legislativo', { count: 'exact' })
      .in('parser_status', ['done', 'manual_review'])
      .order('fecha', { ascending: false })
      .range(offset, offset + per_page - 1);

    if (tipo && ['ampliacion', 'retiro', 'mixto'].includes(tipo)) {
      query = query.eq('tipo', tipo);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      ok: true,
      data: data ?? [],
      pagination: {
        total: count ?? 0,
        page,
        per_page,
        total_pages: Math.ceil((count ?? 0) / per_page),
      },
    });
  } catch (err) {
    logger.error('[decretos] /list error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/**
 * GET /api/decretos/:id
 *
 * Detalle de un decreto: metadata + expedientes afectados (ampliados + retirados).
 */
decretoUserRouter.get('/:id', async (req: Request, res: Response) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  const id = req.params['id'] as string | undefined;

  // Validar UUID básico
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(400).json({ ok: false, error: 'bad_id' });
    return;
  }

  try {
    // Decreto principal
    const { data: decreto, error: decError } = await supa()
      .from('decretos_ejecutivos')
      .select('*')
      .eq('id', id)
      .single();

    if (decError || !decreto) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }

    // Expedientes afectados por este decreto
    const { data: convocatorias, error: convError } = await supa()
      .from('sil_expediente_convocatoria')
      .select('expediente_id, accion, fecha_decreto, sigue_vigente')
      .eq('decreto_id', id)
      .order('accion', { ascending: true }) // convocado antes de retirado
      .order('expediente_id', { ascending: true });

    if (convError) throw convError;

    const expedientes_ampliados = (convocatorias ?? [])
      .filter((c: { accion: string }) => c.accion === 'convocado')
      .map((c: { expediente_id: string; sigue_vigente: boolean }) => ({
        expediente_id: c.expediente_id,
        sigue_vigente: c.sigue_vigente,
      }));

    const expedientes_retirados = (convocatorias ?? [])
      .filter((c: { accion: string }) => c.accion === 'retirado')
      .map((c: { expediente_id: string; sigue_vigente: boolean }) => ({
        expediente_id: c.expediente_id,
        sigue_vigente: c.sigue_vigente,
      }));

    res.json({
      ok: true,
      data: {
        ...decreto,
        expedientes_ampliados,
        expedientes_retirados,
      },
    });
  } catch (err) {
    logger.error('[decretos] /:id error', { id, error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ─── Admin router ─────────────────────────────────────────────────────────────

export const decretoAdminRouter = Router();

/**
 * POST /api/admin/decretos/ingest-now
 *
 * Trigger manual del ingestor de decretos. Útil para:
 *   - Desarrollo: correr sin esperar el cron de 30 min.
 *   - Demo: asegurarse de que el estado está actualizado antes de mostrar.
 *   - Debugging: ver resultado en vivo en el body de respuesta.
 *
 * Auth: cualquier usuario autenticado (demo convention — igual que centinela admin).
 */
decretoAdminRouter.post('/ingest-now', async (req: Request, res: Response) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  logger.info('[decretos] manual ingest triggered', { by: userId });

  try {
    const result = await ingestNewDecretos(supa());
    res.json({ ok: true, result });
  } catch (err) {
    logger.error('[decretos] /ingest-now error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

/**
 * GET /api/admin/decretos/health
 *
 * Estado del pipeline de decretos:
 *   - Cuántos decretos hay en cada parser_status
 *   - Último run del crawler (de sharepoint_cursors)
 *   - Total de expedientes en sil_expediente_convocatoria
 */
decretoAdminRouter.get('/health', async (req: Request, res: Response) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  try {
    const [statusCounts, cursorRow, convCount] = await Promise.all([
      supa()
        .from('decretos_ejecutivos')
        .select('parser_status', { count: 'exact', head: false })
        .then(({ data }) => {
          const counts: Record<string, number> = {};
          for (const row of (data ?? [])) {
            const st = (row as { parser_status: string }).parser_status;
            counts[st] = (counts[st] ?? 0) + 1;
          }
          return counts;
        }),
      supa()
        .from('sharepoint_cursors')
        .select('last_run_at, last_run_status, last_error, items_processed_lifetime')
        .eq('list_id', DECRETOS_LIST_ID)
        .maybeSingle()
        .then(({ data }) => data),
      supa()
        .from('sil_expediente_convocatoria')
        .select('id', { count: 'exact', head: true })
        .then(({ count }) => count ?? 0),
    ]);

    res.json({
      ok: true,
      data: {
        decretos_por_status: statusCounts,
        crawler_cursor: cursorRow,
        total_expediente_convocatoria_rows: convCount,
      },
    });
  } catch (err) {
    logger.error('[decretos] /health error', { error: (err as Error).message });
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
