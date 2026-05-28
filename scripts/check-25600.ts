import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function run() {
  const { data } = await supa.from('legislative_chunks').select('content').eq('source_ref', 'Exp. 25.600 — texto_base').limit(1);
  console.log(data?.[0]?.content);
}
run();
