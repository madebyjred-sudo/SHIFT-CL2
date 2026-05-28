import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function check() {
  const { data, error } = await supa
    .from('legislative_chunks')
    .select('id, content, metadata')
    .eq('metadata->>sil_expediente_id', '25598')
    .limit(3);

  if (error) {
    console.error('Error fetching docs:', error.message);
    process.exit(1);
  }

  if (data && data.length > 0) {
     console.log(`Chunks for 25598:`);
     data.forEach(d => console.log(d.id, d.content.slice(0, 100), d.metadata));
  } else {
     console.log('No chunks found for 25598');
  }
}

check();
