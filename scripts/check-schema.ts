import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  const { data, error } = await supa.from('sil_expedientes').select('id, numero').limit(5);
  console.log(data);
}
run().catch(console.error);
