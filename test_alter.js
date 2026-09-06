import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { error } = await supabase.rpc('execute_sql', { sql: `
    ALTER FUNCTION public.update_bar_ratings_summary() SECURITY DEFINER;
  ` });
  console.log('Altered function:', error || 'Success');
}

run().catch(console.error);
