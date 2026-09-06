import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  // Find a user that exists
  const { data: users, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) {
    console.error('List error:', listErr);
    return;
  }
  
  if (users.users.length === 0) {
    console.log('No users found.');
    return;
  }
  
  // Create a dummy user and add some stuff to it to simulate real deletion
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
  
  // Wait for profile trigger
  await new Promise(r => setTimeout(r, 1000));
  
  // Let's insert a rating to see if it cascades
  const { data: bar } = await supabase.from('bars').select('id').limit(1).single();
  if (bar) {
    await supabase.from('ratings').insert({
      bar_id: bar.id,
      user_id: userId,
      prezzo: 3,
      qualita_drinks: 3,
      socialita: 3,
      varieta: 3,
      orari: 3
    });
    console.log('Inserted dummy rating');
  }

  // Now delete the user
  console.log('Deleting user ID:', userId);
  const { error: delErr } = await supabase.auth.admin.deleteUser(userId);

  if (delErr) {
    console.error('FAILED TO DELETE:', delErr);
  } else {
    console.log('SUCCESSFULLY DELETED!');
  }
}

run().catch(console.error);
