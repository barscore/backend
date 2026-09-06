import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data: bar } = await supabase.from('bars').select('*').eq('id', '09ab474d-5cab-4d58-bcc9-51cd02feeb85').single();
  console.log(bar);
}
run();
