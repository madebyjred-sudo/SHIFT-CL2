import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  // Get any active user
  const { data: users } = await supa.from('user_access').select('user_id, email').eq('status', 'active').limit(1);
  if (!users || users.length === 0) {
    console.error("No active users found");
    return;
  }
  const user = users[0];
  
  // We can't easily mint a JWT without the JWT secret (which is not in .env.local, only NEXT_PUBLIC_SUPABASE_URL is, and SUPABASE_SERVICE_ROLE_KEY).
  // Let's just output the user_id so we can try to forge a token if we have the secret, or we can use the service role key for API testing.
  console.log(user);
}
run();
