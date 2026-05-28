import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function check() {
  const { data, error } = await supa
    .from('sil_documentos')
    .select('id, expediente_id, titulo, status, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error('Error fetching docs:', error.message);
    process.exit(1);
  }

  if (data && data.length > 0) {
     console.log(`Recent docs:`);
     data.forEach(d => console.log(d.id, d.expediente_id, d.created_at, d.status, d.titulo));
  }
}

check();
