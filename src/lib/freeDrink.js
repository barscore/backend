import { randomUUID } from 'node:crypto';
import { supabase } from './supabase.js';

// Il free drink è uno per account, per sempre (explorer o rabar+ che sia).
// L'unico posto che emette token: guarda il registro dei riscatti
// (fix_security_report.sql) e scrive solo se il token manca, così una seconda
// chiamata concorrente non sovrascrive un token già mostrato all'utente.
// La garanzia vera resta UNIQUE(user_id) su free_drink_redemptions.
export async function issueFreeDrinkToken(userId) {
  const { count, error } = await supabase
    .from('free_drink_redemptions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw error;
  if (count) return false;

  const { error: upErr } = await supabase
    .from('profiles')
    .update({ free_drink_token: randomUUID() })
    .eq('id', userId)
    .is('free_drink_token', null);
  if (upErr) throw upErr;
  return true;
}
