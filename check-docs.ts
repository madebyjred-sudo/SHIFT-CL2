import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function run() {
  const { data, error } = await s.from('sil_documentos_urls').select('*').gte('expediente_id', 25554);
  console.log('Docs URLs count:', data?.length);
  const { data: d2 } = await s.from('sil_documentos').select('*').gte('expediente_id', 25554);
  console.log('Docs stored count:', d2?.length);
}
run();
