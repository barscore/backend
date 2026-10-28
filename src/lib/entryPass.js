import { createHmac, timingSafeEqual } from 'node:crypto';

// Il pass d'ingresso alle feste. Prima era il solo `user_id` nel QR, permanente:
// lo screenshot del QR di un amico (o un UUID qualsiasi) faceva entrare chiunque,
// anche chi è bannato. Ora il QR porta `<user_id>.<scadenza>.<firma>`: lo firma
// solo il backend, scade dopo PASS_TTL_S e l'app lo rinnova mentre è a schermo,
// quindi una foto del QR smette di valere entro un paio di minuti.
//
// Il segreto deriva dalla service-role key, come per gli IP del rate limiter
// (middleware/rateLimiter.js): obbligatoria, mai fuori dal server, stabile fra i
// cold start. Il passaggio con l'etichetta tiene questa firma separata dagli
// altri usi della stessa chiave.

export const PASS_TTL_S = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedKey = null;
const passKey = () =>
  (cachedKey ??= createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY).update('rabar:entry-pass:v1').digest());

const sign = (body) => createHmac('sha256', passKey()).update(body).digest('base64url');

/** Un pass nuovo per [userId], valido fino a `expires_at`. */
export function issueEntryPass(userId, now = Date.now()) {
  const exp = Math.floor(now / 1000) + PASS_TTL_S;
  const body = `${userId}.${exp}`;
  return { pass: `${body}.${sign(body)}`, expires_at: new Date(exp * 1000).toISOString(), ttl_s: PASS_TTL_S };
}

/**
 * L'utente del pass, o il motivo per cui non vale: `invalid` (formato o firma)
 * oppure `expired`. Il confronto della firma è a tempo costante.
 */
export function readEntryPass(pass, now = Date.now()) {
  const parts = typeof pass === 'string' ? pass.split('.') : [];
  if (parts.length !== 3) return { error: 'invalid' };
  const [userId, expRaw, sig] = parts;
  if (!UUID_RE.test(userId) || !/^\d{1,12}$/.test(expRaw)) return { error: 'invalid' };

  const expected = Buffer.from(sign(`${userId}.${expRaw}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { error: 'invalid' };
  if (Number(expRaw) * 1000 <= now) return { error: 'expired' };
  return { userId };
}

// --- self-check: `SUPABASE_SERVICE_ROLE_KEY=x node src/lib/entryPass.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const uid = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const t0 = Date.parse('2026-10-28T20:00:00Z');
  const { pass } = issueEntryPass(uid, t0);
  const eq = (a, b, why) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${why}: ${JSON.stringify(a)}`);
  };
  eq(readEntryPass(pass, t0), { userId: uid }, 'fresh pass');
  eq(readEntryPass(pass, t0 + (PASS_TTL_S - 1) * 1000), { userId: uid }, 'just before expiry');
  eq(readEntryPass(pass, t0 + PASS_TTL_S * 1000), { error: 'expired' }, 'expired');
  const [, exp, sig] = pass.split('.');
  eq(readEntryPass(`${other}.${exp}.${sig}`, t0), { error: 'invalid' }, 'signature moved to another user');
  eq(readEntryPass(`${uid}.${Number(exp) + 3600}.${sig}`, t0), { error: 'invalid' }, 'extended expiry');
  eq(readEntryPass(uid, t0), { error: 'invalid' }, 'bare user id (old QR)');
  eq(readEntryPass(`${pass}x`, t0), { error: 'invalid' }, 'tampered signature');
  eq(readEntryPass(null, t0), { error: 'invalid' }, 'missing');
  console.log('entryPass self-check ok');
}
