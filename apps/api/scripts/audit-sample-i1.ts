/**
 * audit-sample-i1.ts — Re-test de la query I1 que descubrió el bug.
 * Antes del fix: Lexa decía "no encontré" sin probar SIL.
 * Después del fix (REGLA 3-bis): Lexa debería citar expedientes Papagayo
 * (24.828, 15.049, 21.253, etc.).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY!;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const API_BASE = 'https://cl2-v2-api-u3rliii7wa-uc.a.run.app';
const ADMIN_EMAIL = 'madebyjred@gmail.com';

const QUERY = 'Para ICT: ¿hubo algún expediente sobre Polo Turístico Golfo de Papagayo discutido en plenarias de mayo 2026? Si sí, dime el número';

async function getAdminToken(): Promise<string> {
  const supa = createClient(SUPA_URL, SUPA_SERVICE, { auth: { persistSession: false } });
  const { data } = await supa.auth.admin.listUsers();
  const user = data.users.find((u) => u.email === ADMIN_EMAIL);
  if (!user) throw new Error(`No admin user ${ADMIN_EMAIL}`);
  const tempPw = 'cl2-audit-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  await supa.auth.admin.updateUserById(user.id, { password: tempPw });
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPA_ANON, Authorization: `Bearer ${SUPA_ANON}` },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: tempPw }),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error(`token grant fail: ${res.status}`);
  return body.access_token;
}

(async () => {
  const token = await getAdminToken();
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent_id: 'lexa', query: QUERY, conversation_id: null, deep_insight: false }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let citations_n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim();
      if (!p || p === '[DONE]') continue;
      try {
        const evt = JSON.parse(p);
        if (evt.type === 'token' && typeof evt.payload === 'string') text += evt.payload;
        else if (evt.type === 'citation' && Array.isArray(evt.payload)) citations_n = evt.payload.length;
      } catch {/* skip */}
    }
  }
  const ms = Date.now() - t0;
  console.log(`I1 RE-TEST · time=${ms}ms · citations=${citations_n} · length=${text.length}`);
  console.log('---');
  console.log(text);
  console.log('---');
  const hasNoEncontre = /no encontr[eé]/i.test(text);
  const hasPapagayoExp = /24\.?828|15\.?049|21\.?253|8\.?661|14\.?998/.test(text);
  console.log(`hasNoEncontre: ${hasNoEncontre}`);
  console.log(`hasPapagayoExp (24.828/15.049/21.253/etc): ${hasPapagayoExp}`);
  console.log(`Veredicto: ${!hasNoEncontre && hasPapagayoExp ? '✅ FIX CONFIRMED' : '❌ STILL BUG'}`);
})();
