import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function run() {
  const { data, error } = await supa.rpc('query_indexes', {}); // Not sure if this exists
  // I will just use raw sql if possible, but JS client can't easily run raw SQL.
  // We can just look at the migration files!
}
run().catch(console.error);
