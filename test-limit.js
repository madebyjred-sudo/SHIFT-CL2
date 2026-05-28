const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const ids = Array.from({length: 15000}, (_, i) => i);
  const { data, error } = await s.from('sil_expedientes').select('id').in('id', ids).limit(5);
  console.log('Error:', error);
}
run();
