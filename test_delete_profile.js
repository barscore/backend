import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  const { data: users } = await supabase.auth.admin.listUsers();
  // Find a test user
  const testUser = users.users.find(u => u.email.startsWith('test_delete_500_'));
  
  if (!testUser) {
    console.log('No test user to delete.');
    return;
  }
  
  console.log('Test user:', testUser.id);
  
  // Try to delete their profile directly
  console.log('Deleting profile...');
  const { data, error } = await supabase.from('profiles').delete().eq('id', testUser.id);
  console.log('Result:', error || 'Success');
}

run().catch(console.error);
