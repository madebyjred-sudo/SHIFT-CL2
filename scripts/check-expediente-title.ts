import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function check() {
  const { data, error } = await supa
    .from('sil_documentos')
    .select('id, expediente_id, titulo, text_extracted')
    .eq('expediente_id', '25598')
    .limit(1);

  if (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }

  if (data && data.length > 0) {
     console.log('Title:', data[0].titulo);
     console.log('Text snippet:', data[0].text_extracted ? data[0].text_extracted.slice(0, 500) : 'none');
  }
}

check();
