import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, username')
    .gt('plus_until', new Date().toISOString())
    .is('free_drink_token', null);

  console.log('Found users:', users);
  for (const u of (users || [])) {
    await supabase.from('profiles').update({ free_drink_token: crypto.randomUUID() }).eq('id', u.id);
    console.log('Updated:', u.username);
  }
}
run();
