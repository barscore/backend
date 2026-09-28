import 'dotenv/config';
import { supabase } from './src/lib/supabase.js';
import { issueFreeDrinkToken } from './src/lib/freeDrink.js';

// Emette il free drink agli utenti rabar+ che non l'hanno ancora. Passa da
// issueFreeDrinkToken, quindi chi l'ha già riscattato non ne riceve un altro.
async function run() {
  const { data: users, error } = await supabase
    .from('profiles')
    .select('id, username')
    .gt('plus_until', new Date().toISOString())
    .is('free_drink_token', null);
  if (error) throw error;

  for (const u of users ?? []) {
    if (await issueFreeDrinkToken(u.id)) console.log('Updated:', u.username);
  }
}
run();
