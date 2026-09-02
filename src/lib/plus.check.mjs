// Controllo minimo del percorso a pagamento di rabar+ — quello che, se si
// rompe in silenzio, fa pagare la gente senza darle il piano (o glielo lascia
// per sempre). Si esegue senza dipendenze e senza rete:
//
//   SUPABASE_URL=x SUPABASE_SERVICE_ROLE_KEY=x node src/lib/plus.check.mjs
import assert from 'node:assert/strict';
import { PLANS, isPlus, periodEnd } from './plus.js';

// Listino: i default sono i prezzi annunciati agli utenti.
assert.equal(PLANS.week.amount_cents, 199);
assert.equal(PLANS.month.amount_cents, 399);
assert.equal(PLANS.year.amount_cents, 2999);
assert.deepEqual(
  Object.values(PLANS).map((p) => p.interval),
  ['week', 'month', 'year'],
);

// Diritto: vale finché la fine del periodo pagato è nel futuro.
assert.equal(isPlus({ plus_until: new Date(Date.now() + 60_000).toISOString() }), true);
assert.equal(isPlus({ plus_until: new Date(Date.now() - 60_000).toISOString() }), false);
assert.equal(isPlus({ plus_until: null }), false);
assert.equal(isPlus(null), false);

// Fine periodo: prima dell'API 2025-03-31 sta sulla subscription, dopo sulla
// singola voce. Se questo smette di leggere entrambi, i rinnovi non passano.
const iso = '2026-01-01T00:00:00.000Z';
const ts = Math.floor(Date.parse(iso) / 1000);
assert.equal(periodEnd({ current_period_end: ts }), iso);
assert.equal(periodEnd({ items: { data: [{ current_period_end: ts }] } }), iso);
assert.equal(periodEnd({}), null);

console.log('plus: ok');
