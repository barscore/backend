import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { REWARDED_AD_UNITS, verifySsv } from '../lib/admobSsv.js';
import { AppError } from '../middleware/errorHandler.js';

// Google → us: the AdMob rewarded SSV callback. URL to set on each rewarded
// unit in AdMob → App → Ad units → the unit → Server-side verification:
// https://rabarbackend.vercel.app/admob/ssv
//
// No user: trust is the ECDSA signature (lib/admobSsv.js), and the user is the
// `user_id` the app put in the request (ServerSideVerificationOptions). A
// callback that verifies but is not for us — AdMob's own "Verify URL" test, a
// foreign unit, a stale timestamp — is answered 200, or AdMob would refuse to
// save the URL and keep retrying. Only a bad signature is an error.
const admob = new Hono();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Google calls within seconds; a day covers its retries. Older is a replay,
// and the transaction table only remembers ids for two days.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

admob.get('/ssv', async (c) => {
  const raw = new URL(c.req.url).search.slice(1);
  const params = await verifySsv(raw).catch((err) => {
    console.error('[admob] verifier keys:', err.message);
    throw new AppError(503, 'UNAVAILABLE', 'Chiavi AdMob non raggiungibili');
  });
  if (!params) throw new AppError(400, 'VALIDATION_ERROR', 'Callback AdMob non verificabile');

  const userId = params.get('user_id') ?? '';
  const transactionId = params.get('transaction_id') ?? '';
  const timestamp = Number(params.get('timestamp'));

  if (!REWARDED_AD_UNITS.includes(params.get('ad_unit'))) return c.json({ ok: true, ignored: 'ad_unit' });
  if (!UUID_RE.test(userId) || !transactionId || transactionId.length > 200) {
    return c.json({ ok: true, ignored: 'user' });
  }
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > MAX_AGE_MS) {
    return c.json({ ok: true, ignored: 'stale' });
  }

  // One SQL call: remembers the transaction and counts the view, or neither —
  // a retry after a half-done write could otherwise count twice or not at all.
  const { data: status, error } = await supabase.rpc('record_rewarded_ssv', {
    p_transaction: transactionId,
    p_user: userId.toLowerCase(),
  });
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Reward non registrato');

  return c.json({ ok: true, status });
});

export default admob;
