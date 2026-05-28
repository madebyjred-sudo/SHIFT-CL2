import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function run() {
  const { data, error } = await s.from('sil_expedientes').select('numero, id').order('id', { ascending: false }).limit(5);
  console.log(data);
}
run();
