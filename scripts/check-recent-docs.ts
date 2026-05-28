import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function check() {
  const { data, error } = await supa
    .from('sil_documentos')
    .select('id, expediente_id, titulo, source_url, status, created_at, text_extracted')
    .gt('created_at', '2026-05-27T16:20:00+00:00')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching docs:', error.message);
    process.exit(1);
  }

  if (data && data.length > 0) {
     console.log(`Found ${data.length} docs:`);
     data.forEach(d => console.log(d.id, d.expediente_id, d.created_at, d.status, d.titulo, "Chars:", d.text_extracted ? d.text_extracted.length : 0));
  } else {
     console.log("No new docs found since 16:20 UTC.");
  }
}

check();
