const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function run() {
  const { data, error, count } = await s
    .from('sil_expedientes')
    .select('id, numero, sil_documentos!inner(id, tipo)', { count: 'exact' })
    .limit(2);
  console.log('Error:', error);
  console.log('Count:', count);
  console.log('Data:', JSON.stringify(data, null, 2));
}
run();
