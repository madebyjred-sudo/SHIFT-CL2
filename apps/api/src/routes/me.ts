/**
 * /api/me — endpoint que devuelve el access del user actual.
 *
 * El frontend lo llama inmediatamente después de auth para decidir:
 *   • status='active' → entra a la app
 *   • status='pending' → pantalla "esperando aprobación"
 *   • status='rejected'/'suspended' → pantalla "acceso denegado"
 *
 * Acceso: requiere JWT válido (cualquier user autenticado). NO requiere
 * status=active — el endpoint mismo es el gate, no podemos negarlo.
 */
import { Router } from 'express';
import { getUserFromRequest, loadUserAccess } from '../services/auth.js';

export const meRouter = Router();

meRouter.get('/', async (req, res) => {
  const u = await getUserFromRequest(req);
  if (!u) {
    res.status(401).json({ ok: false, error: 'auth_required' });
    return;
  }

  let access = null;
  try {
    access = await loadUserAccess(u.id);
  } catch (err) {
    // Si la consulta falla por algo distinto de tabla-no-existe, degradamos
    // — el user puede pasar pero con status 'unknown' para que el frontend
    // muestre un estado neutro mientras DBA investiga.
    req.log?.error('me_load_failed', { error: (err as Error).message, userId: u.id });
  }

  // Si access es null (tabla no aplicada o race del trigger), respondemos
  // con un default "pending" — el frontend lo muestra como "esperando
  // aprobación" y le pide al admin que active al user manualmente.
  res.json({
    ok: true,
    user: {
      id: u.id,
      email: u.email,
      status: access?.status ?? 'pending',
      role: access?.role ?? null,
      full_name: access?.full_name ?? null,
      avatar_url: access?.avatar_url ?? null,
      approved_at: access?.approved_at ?? null,
    },
  });
});
