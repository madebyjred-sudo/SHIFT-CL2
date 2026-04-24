import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const supabaseAdmin = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })
  : null;

export interface AuthedRequest extends Request {
  user?: { id: string; email?: string };
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  if (!supabaseAdmin) {
    res.status(500).json({ ok: false, error: 'supabase not configured' });
    return;
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) {
    res.status(401).json({ ok: false, error: 'missing token' });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ ok: false, error: 'invalid token' });
    return;
  }

  req.user = { id: data.user.id, email: data.user.email };
  next();
}
