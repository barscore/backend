// Controllo della cache degli interruttori e del riuso del chiamante tra il
// gate beta e requireAuth. Senza rete: Supabase è sostituito da contatori.
//
//   SUPABASE_URL=http://x SUPABASE_SERVICE_ROLE_KEY=x node src/lib/appSettings.check.mjs
import assert from 'node:assert/strict';
import { supabase } from './supabase.js';
import { assertMonetizationEnabled, getWriteSwitches, invalidateWriteSwitches } from './appSettings.js';
import { lookupCaller, requireAuth } from '../middleware/auth.js';

const calls = { settings: 0, profiles: 0, getUser: 0 };
let settingsRow = { maintenance_mode: false, beta_mode: false };
let settingsError = null;
let profileRow = { role: 'betatester', banned: false, suspended_until: null };
const chain = (result) => {
  const q = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve(result()) };
  return q;
};
supabase.from = (table) => {
  calls[table === 'app_settings' ? 'settings' : 'profiles'] += 1;
  return table === 'app_settings'
    ? chain(() => (settingsError ? { data: null, error: settingsError } : { data: settingsRow, error: null }))
    : chain(() => ({ data: profileRow, error: null }));
};
supabase.auth.getUser = async (token) => {
  calls.getUser += 1;
  return token === 'buono'
    ? { data: { user: { id: 'u1', email: 'a@b.it' } }, error: null }
    : { data: { user: null }, error: new Error('token non valido') };
};

// --- interruttori: una lettura per finestra, anche con richieste simultanee
const T0 = Date.now();
const [a, b] = await Promise.all([getWriteSwitches(T0), getWriteSwitches(T0)]);
assert.deepEqual(a, settingsRow);
assert.equal(a, b);
assert.equal(calls.settings, 1, 'due scritture insieme, una lettura sola');
await getWriteSwitches(T0 + 29_000);
assert.equal(calls.settings, 1, 'dentro la finestra non si rilegge');
await getWriteSwitches(Date.now() + 31_000);
assert.equal(calls.settings, 2, 'scaduta la finestra si rilegge');

// --- chi cambia un interruttore lo vede subito
settingsRow = { maintenance_mode: true, beta_mode: false };
invalidateWriteSwitches();
assert.equal((await getWriteSwitches()).maintenance_mode, true);
assert.equal(calls.settings, 3);

// --- un errore non resta in memoria e non blocca (come prima: fail-open)
invalidateWriteSwitches();
settingsError = new Error('db giù');
assert.equal(await getWriteSwitches(), null);
settingsError = null;
assert.equal((await getWriteSwitches()).maintenance_mode, true, 'alla lettura dopo si riprova');

// --- gate beta + requireAuth sulla stessa richiesta: Supabase una volta sola
const ctx = (authorization) => {
  const store = new Map();
  return { req: { header: (h) => (h === 'Authorization' ? authorization : undefined) }, get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
};
calls.getUser = 0;
calls.profiles = 0;
const c1 = ctx('Bearer buono');
assert.equal((await lookupCaller(c1)).prof.role, 'betatester'); // il gate
let nexted = false;
await requireAuth(c1, async () => { nexted = true; });         // l'handler
assert.ok(nexted);
assert.deepEqual(c1.get('user'), { id: 'u1', email: 'a@b.it', role: 'betatester' });
assert.deepEqual([calls.getUser, calls.profiles], [1, 1], 'nessuna domanda ripetuta');

// --- senza gate requireAuth fa da solo, come prima
const c2 = ctx('Bearer buono');
await requireAuth(c2, async () => {});
assert.deepEqual([calls.getUser, calls.profiles], [2, 2]);

// --- rifiuti invariati
await assert.rejects(requireAuth(ctx(undefined), async () => {}), { code: 'UNAUTHORIZED' });
await assert.rejects(requireAuth(ctx('Basic xyz'), async () => {}), { code: 'UNAUTHORIZED' });
await assert.rejects(requireAuth(ctx('Bearer scaduto'), async () => {}), { code: 'UNAUTHORIZED' });
assert.equal(await lookupCaller(ctx('Bearer scaduto')), null);
profileRow = { role: 'user', banned: true, suspended_until: null };
await assert.rejects(requireAuth(ctx('Bearer buono'), async () => {}), { code: 'BANNED' });
profileRow = { role: 'user', banned: false, suspended_until: new Date(Date.now() + 60_000).toISOString() };
await assert.rejects(requireAuth(ctx('Bearer buono'), async () => {}), { code: 'SUSPENDED' });

// --- monetizzazione: passa solo con la colonna a TRUE (fail-closed)
const monetization = async (row, error = null) => {
  invalidateWriteSwitches();
  settingsRow = row;
  settingsError = error;
  try {
    await assertMonetizationEnabled();
    return 'aperta';
  } catch (e) {
    assert.equal(e.code, 'MONETIZATION_OFF');
    assert.equal(e.statusCode, 503);
    return 'chiusa';
  } finally {
    settingsError = null;
  }
};
assert.equal(await monetization({ maintenance_mode: false, beta_mode: false, monetization_enabled: true }), 'aperta');
assert.equal(await monetization({ maintenance_mode: false, beta_mode: false, monetization_enabled: false }), 'chiusa');
assert.equal(await monetization({ maintenance_mode: false, beta_mode: false }), 'chiusa', 'colonna non ancora creata');
assert.equal(await monetization(null, new Error('db giù')), 'chiusa', 'riga illeggibile');

console.log('appSettings ok');
