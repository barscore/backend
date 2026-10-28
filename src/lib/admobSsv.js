import { verify } from 'node:crypto';

// AdMob rewarded ads, server-side verification (SSV).
//
// When a user earns the reward, Google calls GET /admob/ssv with the reward's
// details and an ECDSA signature over them. That callback — not the app saying
// "I watched one" — is what counts a view once ADMOB_SSV=1. The public keys
// rotate, so they are fetched from Google and cached.
// https://developers.google.com/admob/android/ssv

const KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const KEYS_TTL_MS = 24 * 60 * 60 * 1000;
// An unknown key_id refreshes the cache early (Google rotated), but at most
// this often: a forged key_id must not turn every callback into a fetch.
const FORCED_REFRESH_MS = 60 * 1000;

/** True once the AdMob units have their SSV callback set: from then on only
 *  Google's callback counts a view, and POST /me/rewarded stops incrementing. */
export const SSV_ENABLED = process.env.ADMOB_SSV === '1';

/**
 * The numeric ad unit ids allowed to credit a view — the part after the "/" of
 * "ca-app-pub-…/1120294879". Without this check any AdMob publisher could
 * point their own unit's callback here and have Google sign rewards for any
 * user id. Default: the iOS and Android "Rewarded tema mar7yyy" units.
 */
export const REWARDED_AD_UNITS = (process.env.ADMOB_REWARDED_AD_UNITS || '1120294879,3874450722')
  .split(',')
  .map((s) => s.trim().split('/').pop())
  .filter(Boolean);

let cache = { at: 0, keys: new Map() };
let lastForced = 0;

async function loadKeys({ force = false } = {}) {
  const fresh = cache.keys.size > 0 && Date.now() - cache.at < KEYS_TTL_MS;
  if (fresh && !force) return cache.keys;
  if (force && cache.keys.size > 0 && Date.now() - lastForced < FORCED_REFRESH_MS) return cache.keys;
  if (force) lastForced = Date.now();

  const res = await fetch(KEYS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`AdMob verifier keys: HTTP ${res.status}`);
  const body = await res.json();
  cache = {
    at: Date.now(),
    keys: new Map((body.keys ?? []).map((k) => [String(k.keyId), k.pem])),
  };
  return cache.keys;
}

/**
 * Checks the signature of a raw SSV query string against `keys` (keyId → PEM).
 * Google always puts `signature` and `key_id` last, and signs everything before
 * "&signature=" exactly as sent — so this works on the raw string, never on a
 * re-serialised one. Returns the parsed parameters, or null.
 */
export function verifySsvWithKeys(rawQuery, keys) {
  const at = rawQuery.indexOf('&signature=');
  if (at <= 0) return null;
  const params = new URLSearchParams(rawQuery);
  const signature = params.get('signature');
  const pem = keys.get(params.get('key_id') ?? '');
  if (!signature || !pem) return null;
  try {
    const ok = verify(
      'sha256',
      Buffer.from(rawQuery.slice(0, at)),
      { key: pem, dsaEncoding: 'der' },
      Buffer.from(signature, 'base64url'),
    );
    return ok ? params : null;
  } catch {
    return null;
  }
}

/** Same, with Google's current keys. Throws only if the keys can't be fetched. */
export async function verifySsv(rawQuery) {
  let keys = await loadKeys();
  const keyId = new URLSearchParams(rawQuery).get('key_id') ?? '';
  if (!keys.has(keyId)) keys = await loadKeys({ force: true });
  return verifySsvWithKeys(rawQuery, keys);
}

// --- self-check: `node src/lib/admobSsv.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keys = new Map([['42', publicKey.export({ type: 'spki', format: 'pem' })]]);
  const content =
    'ad_network=5450213213286189855&ad_unit=1120294879&reward_amount=1&reward_item=Reward' +
    '&timestamp=1761650000000&transaction_id=abc123&user_id=0b5e8e1a-1111-4222-8333-944445555666';
  const sig = sign('sha256', Buffer.from(content), { key: privateKey, dsaEncoding: 'der' }).toString('base64url');
  const eq = (a, b, m) => {
    if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`);
  };

  eq(verifySsvWithKeys(`${content}&signature=${sig}&key_id=42`, keys)?.get('transaction_id'), 'abc123', 'valid');
  eq(verifySsvWithKeys(`${content.replace('abc123', 'abc124')}&signature=${sig}&key_id=42`, keys), null, 'tampered');
  eq(verifySsvWithKeys(`${content}&signature=${sig}&key_id=7`, keys), null, 'unknown key');
  eq(verifySsvWithKeys(`${content}&key_id=42`, keys), null, 'no signature');
  eq(verifySsvWithKeys(`${content}&signature=AAAA&key_id=42`, keys), null, 'garbage signature');
  eq(REWARDED_AD_UNITS.includes('1120294879'), true, 'default units');

  console.log('admobSsv self-check ok');
}
