import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const email = 'test_delete_500_' + Date.now() + '@example.com';
  console.log('Creating user:', email);
  const { data: userAuth } = await supabase.auth.admin.createUser({ email, password: 'password123', email_confirm: true });
  const userId = userAuth.user.id;
  await new Promise(r => setTimeout(r, 1000));
  
  const { data: bar } = await supabase.from('bars').select('id').limit(1).single();
  await supabase.from('ratings').insert({
    bar_id: bar.id,
    user_id: userId,
    prezzo: 3, qualita_drinks: 3, socialita: 3, varieta: 3, orari: 3
  });
  console.log('Inserted dummy rating');

  console.log('Deleting profile directly with service_role...');
  const { error: delProfileErr } = await supabase.from('profiles').delete().eq('id', userId);
  console.log('Profile delete result:', delProfileErr || 'Success');
}
run().catch(console.error);
