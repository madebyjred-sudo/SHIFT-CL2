/**
 * audit-sample-asesor.ts — query directa a /api/chat/stream para capturar
 * respuestas reales de Lexa a 3 preguntas representativas del audit asesor.
 *
 * Mintea token admin → POST /api/chat/stream → consume SSE → loguea text.
 * Mucho más liviano que correr Playwright 11min.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPA_ANON = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY!;
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const API_BASE = 'https://cl2-v2-api-u3rliii7wa-uc.a.run.app';
const ADMIN_EMAIL = 'madebyjred@gmail.com';

const SAMPLE_QUERIES = [
  {
    id: 'F1',
    cliente: 'FEDEFARMA',
    q: 'Para FEDEFARMA: ¿qué estado tiene actualmente el expediente 23.496 sobre importación paralela de medicamentos? ¿Tiene dictamen?',
  },
  {
    id: 'I1',
    cliente: 'ICT',
    q: 'Para ICT: ¿hubo algún expediente sobre Polo Turístico Golfo de Papagayo discutido en plenarias de mayo 2026? Si sí, dime el número',
  },
  {
    id: 'G2',
    cliente: 'GENERAL',
    q: 'Bajo el Reglamento, cuando un expediente entra a consulta facultativa ante la Sala IV, ¿puede continuar el debate en plenario mientras la Sala resuelve? Cita el artículo',
  },
];

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

async function chatOnce(token: string, query: string): Promise<{ text: string; ms: number; citations_n: number }> {
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      agent_id: 'lexa',
      query,
      conversation_id: null,
      deep_insight: false,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`chat stream HTTP ${res.status}`);

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
      const payloadRaw = line.slice(5).trim();
      if (!payloadRaw || payloadRaw === '[DONE]') continue;
      try {
        const evt = JSON.parse(payloadRaw);
        if (evt.type === 'token' && typeof evt.payload === 'string') {
          text += evt.payload;
        } else if (evt.type === 'citation' && Array.isArray(evt.payload)) {
          citations_n = evt.payload.length;
        }
      } catch {
        // ignorar líneas raras
      }
    }
  }
  return { text, ms: Date.now() - t0, citations_n };
}

(async () => {
  console.log(`Sampling 3 queries against ${API_BASE}`);
  const token = await getAdminToken();
  console.log(`Token minted (admin=${ADMIN_EMAIL})\n`);

  for (const q of SAMPLE_QUERIES) {
    console.log(`=== ${q.id} [${q.cliente}] ===`);
    console.log(`Q: ${q.q}`);
    try {
      const r = await chatOnce(token, q.q);
      console.log(`Time: ${r.ms}ms · Citations: ${r.citations_n} · Length: ${r.text.length} chars`);
      console.log(`A: ${r.text.replace(/\s+/g, ' ').slice(0, 1500)}`);
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message}`);
    }
    console.log('');
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
