import { createClient } from '@supabase/supabase-js';

async function mintToken(email: string): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supa = createClient(url, key, { auth: { persistSession: false } });
  const { data, error: listErr } = await supa.auth.admin.listUsers();
  if (listErr) throw listErr;
  const user = data.users.find((u) => u.email === email);
  if (!user) throw new Error('no user');
  const tempPw = 'cl2-e2e-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  const { error: pwErr } = await supa.auth.admin.updateUserById(user.id, { password: tempPw });
  if (pwErr) throw pwErr;
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!}`,
    },
    body: JSON.stringify({ email, password: tempPw }),
  });
  const body = await res.json();
  return body.access_token;
}

async function main() {
  const token = await mintToken('madebyjred@gmail.com');
  const res = await fetch('https://cl2-v2-api-u3rliii7wa-uc.a.run.app/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      agent_id: 'lexa',
      query: '¿Quiénes son los proponentes?',
      scope: { expediente_numero: '23.234' },
    }),
  });
  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.startsWith('data:'));
  let out = '';
  for (const line of lines) {
    try {
      const obj = JSON.parse(line.replace('data: ', ''));
      if (obj.type === 'token') out += obj.payload;
      if (obj.type === 'done') break;
    } catch {}
  }
  console.log(out);
}
main().catch(console.error);
