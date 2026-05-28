import { createClient } from '@supabase/supabase-js';
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function run() {
  const { data: exp } = await s.from('sil_expedientes').select('*').eq('id', 25600).single();
  console.log('Exp 25600:', exp);
  const { data: docs } = await s.from('sil_documentos').select('*').eq('expediente_id', 25600);
  console.log('Docs 25600:', docs?.length);
}
run();
