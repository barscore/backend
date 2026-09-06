import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const email = 'test_delete_500_' + Date.now() + '@example.com';
  console.log('Creating user:', email);
  const { data: userAuth, error: authErr } = await supabase.auth.admin.createUser({
    email,
    password: 'password123',
    email_confirm: true
  });

  if (authErr) {
    console.error('Failed to create auth user:', authErr);
    return;
  }
  const userId = userAuth.user.id;
  console.log('Created user ID:', userId);

  // We wait a second to ensure triggers created the profile
  await new Promise(r => setTimeout(r, 1000));

  // Try to delete the user
  console.log('Deleting user ID:', userId);
  const { error: delErr } = await supabase.auth.admin.deleteUser(userId);

  if (delErr) {
    console.error('FAILED TO DELETE:', delErr);
  } else {
    console.log('SUCCESSFULLY DELETED!');
  }
}

run().catch(console.error);
