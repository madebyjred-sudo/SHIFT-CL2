import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function check() {
  const { data, error } = await supa.rpc('match_chunks', {
      query_embedding: Array(3072).fill(0),
      match_count: 1
    });
}
check();
