import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data, error } = await supabase.from('profiles').select('id, username, avatar_url, instagram_username, whatsapp_number, created_at, plus_until, rewarded_count, is_explorer, free_drink_token').limit(1);
  if (error) {
    console.error('GET /me query failed:', error);
  } else {
    console.log('GET /me query SUCCESS:', data);
  }
}

run().catch(console.error);
