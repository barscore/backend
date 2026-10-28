import { createHash, createSign } from 'node:crypto';

// Google Play Billing (Android client).
//
// The Play Store forbids Stripe for anything used inside the Android app, so
// rabar+ is a Play subscription there and a boost a consumable in-app product.
// The app hands us the purchase token; everything that decides what the user
// gets is read back from the Google Play Developer API with a service account,
// never taken from the client.
//
// Env:
//   GOOGLE_PLAY_SERVICE_ACCOUNT — the service account key, as the JSON Google
//     downloads or that JSON in base64. The account needs, in Play Console →
//     Users and permissions, "View financial data" and "Manage orders and
//     subscriptions" on the app.
//   GOOGLE_PLAY_PACKAGE_NAME    — defaults to com.rabar.app.
//   GOOGLE_PLAY_RTDN_TOKEN      — shared secret in the Pub/Sub push URL.

export const PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.rabar.app';

/**
 * Product ids, mirrored in the Android app (`data/billing/Products.kt`).
 * rabar+ is one subscription with one base plan per Stripe plan; the boosts
 * are the same three consumables the iOS app sells.
 */
export const PLUS_PRODUCT_ID = 'com.rabar.app.plus';
export const PLUS_BASE_PLANS = ['week', 'month', 'year'];
export const BOOST_PRODUCTS = {
  '3d': 'com.rabar.app.boost.3d',
  '7d': 'com.rabar.app.boost.7d',
  '30d': 'com.rabar.app.boost.30d',
};

/**
 * What the app stamps on a purchase as `obfuscatedAccountId`: the SHA-256 (hex,
 * 64 chars, Play's limit) of the rabar user id, as Google recommends — a
 * one-way value, not the id itself. The Android app computes the same thing
 * (`BillingManager.accountTag`). Purchases made before the change carry the
 * bare id: both are accepted, so no existing subscription is lost.
 */
export const playAccountTag = (userId) => createHash('sha256').update(userId).digest('hex');

export const playAccountMatches = (tag, userId) =>
  !!tag && !!userId && (tag === userId || tag === playAccountTag(userId));

/** A bare rabar user id on the purchase: only ever from the app before the hash. */
export const isLegacyAccountTag = (tag) =>
  typeof tag === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tag);

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function loadServiceAccount() {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const key = JSON.parse(text);
    return key.client_email && key.private_key ? key : null;
  } catch {
    return null;
  }
}

const serviceAccount = loadServiceAccount();

// Without a key every Android purchase is refused: say so at startup instead
// of letting buyers find out one rejected receipt at a time.
if (!serviceAccount) {
  console.warn(
    '[rabar] GOOGLE_PLAY_SERVICE_ACCOUNT assente o non valido: gli acquisti Google Play vengono rifiutati',
  );
}

export const googlePlayConfigured = () => !!serviceAccount;

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

let cached = null; // { token, exp }

/** OAuth access token for the service account (JWT bearer grant), cached. */
async function accessToken() {
  if (!serviceAccount) throw new GooglePlayError(503, 'Google Play non configurato');
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp - 60 > now) return cached.token;

  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key, 'base64url');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  if (!res.ok) throw new GooglePlayError(502, `OAuth Google ${res.status}`);
  const body = await res.json();
  cached = { token: body.access_token, exp: now + (body.expires_in || 3600) };
  return cached.token;
}

export class GooglePlayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}/${PACKAGE_NAME}/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 || res.status === 410) return null; // unknown or expired token
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new GooglePlayError(502, `Google Play API ${res.status}: ${detail.slice(0, 200)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

const enc = encodeURIComponent;

/** purchases.subscriptionsv2.get — null when Google does not know the token. */
export const getSubscription = (token) => call(`purchases/subscriptionsv2/tokens/${enc(token)}`);

/** Must happen within 3 days, or Google refunds the purchase by itself. */
export const acknowledgeSubscription = (productId, token) =>
  call(`purchases/subscriptions/${enc(productId)}/tokens/${enc(token)}:acknowledge`, {
    method: 'POST',
    body: {},
  });

/** purchases.products.get — a one-time product (boost). */
export const getProduct = (productId, token) =>
  call(`purchases/products/${enc(productId)}/tokens/${enc(token)}`);

/** Consuming also acknowledges, and lets the same boost be bought again. */
export const consumeProduct = (productId, token) =>
  call(`purchases/products/${enc(productId)}/tokens/${enc(token)}:consume`, { method: 'POST' });

/**
 * States that entitle to rabar+. A cancelled subscription keeps running until
 * the end of the period it paid for — like a Stripe one with
 * cancel_at_period_end — and the grace period keeps the user in while Google
 * retries the card.
 */
const ENTITLED_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_CANCELED',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);

/**
 * What a SubscriptionPurchaseV2 means for us. Pure, so it is the part that the
 * self-check below covers.
 *
 * `until` is the expiry of the rabar+ line item whatever the state: Google
 * moves it to the revocation time on a refund and keeps it in the past once the
 * subscription lapses, so it can be written to `plus_until` as it is.
 */
export function readSubscription(sub, now = new Date()) {
  const item = (sub?.lineItems ?? []).find((li) => li.productId === PLUS_PRODUCT_ID);
  if (!item) return null;
  const until = item.expiryTime ? new Date(item.expiryTime) : null;
  const plan = PLUS_BASE_PLANS.includes(item.offerDetails?.basePlanId)
    ? item.offerDetails.basePlanId
    : null;
  const entitled = ENTITLED_STATES.has(sub.subscriptionState) && !!until && until > now;
  return {
    plan,
    state: sub.subscriptionState,
    entitled,
    until: until ? until.toISOString() : null,
    autoRenew: item.autoRenewingPlan?.autoRenewEnabled === true,
    accountTag: sub.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    acknowledged: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    linkedToken: sub.linkedPurchaseToken ?? null,
    orderId: sub.latestOrderId ?? null,
  };
}

/** Our `status` column, in Stripe's words, so the web reads both alike. */
export function statusFor(state) {
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
    case 'SUBSCRIPTION_STATE_CANCELED':
      return 'active';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'past_due';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
    case 'SUBSCRIPTION_STATE_PAUSED':
      return 'paused';
    case 'SUBSCRIPTION_STATE_PENDING':
      return 'incomplete';
    default:
      return 'canceled';
  }
}

/** ProductPurchase.purchaseState: 0 purchased, 1 cancelled, 2 pending. */
export const productPaid = (p) => p?.purchaseState === 0;

// --- self-check: `node src/lib/googlePlay.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
  };
  const now = new Date('2026-10-14T12:00:00.000Z');
  const sub = (state, expiry, basePlanId = 'month') => ({
    subscriptionState: state,
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    externalAccountIdentifiers: { obfuscatedExternalAccountId: 'u1' },
    lineItems: [
      {
        productId: PLUS_PRODUCT_ID,
        expiryTime: expiry,
        autoRenewingPlan: { autoRenewEnabled: true },
        offerDetails: { basePlanId },
      },
    ],
  });

  const active = readSubscription(sub('SUBSCRIPTION_STATE_ACTIVE', '2026-11-14T12:00:00Z'), now);
  eq(active.entitled, true, 'active ⇒ entitled');
  eq(active.plan, 'month', 'base plan ⇒ plan');
  eq(active.until, '2026-11-14T12:00:00.000Z', 'expiry ⇒ until');
  eq(active.accountTag, 'u1', 'obfuscated account id ⇒ account tag');
  eq(active.acknowledged, false, 'pending ack');

  const uid = '11111111-1111-4111-8111-111111111111';
  eq(playAccountTag(uid).length, 64, 'tag fits obfuscatedAccountId');
  eq(playAccountMatches(playAccountTag(uid), uid), true, 'hashed tag ⇒ owner');
  eq(playAccountMatches(uid, uid), true, 'legacy bare id ⇒ owner');
  eq(playAccountMatches(playAccountTag(uid), '22222222-2222-4222-8222-222222222222'), false, 'other user');
  eq(playAccountMatches(null, uid), false, 'no tag');
  eq(isLegacyAccountTag(uid), true, 'bare id is legacy');
  eq(isLegacyAccountTag(playAccountTag(uid)), false, 'hash is not legacy');

  eq(readSubscription(sub('SUBSCRIPTION_STATE_CANCELED', '2026-10-20T00:00:00Z'), now).entitled, true, 'cancelled keeps the paid period');
  eq(readSubscription(sub('SUBSCRIPTION_STATE_IN_GRACE_PERIOD', '2026-10-15T00:00:00Z'), now).entitled, true, 'grace period');
  eq(readSubscription(sub('SUBSCRIPTION_STATE_ON_HOLD', '2026-10-01T00:00:00Z'), now).entitled, false, 'on hold');
  eq(readSubscription(sub('SUBSCRIPTION_STATE_EXPIRED', '2026-10-13T00:00:00Z'), now).entitled, false, 'expired');
  eq(readSubscription(sub('SUBSCRIPTION_STATE_ACTIVE', '2026-10-13T00:00:00Z'), now).entitled, false, 'active but past expiry');
  eq(readSubscription(sub('SUBSCRIPTION_STATE_ACTIVE', '2026-11-14T12:00:00Z', 'promo'), now).plan, null, 'unknown base plan ⇒ null');
  eq(readSubscription({ lineItems: [{ productId: 'other' }] }, now), null, 'foreign product ⇒ null');

  eq(statusFor('SUBSCRIPTION_STATE_CANCELED'), 'active', 'cancelled still active');
  eq(statusFor('SUBSCRIPTION_STATE_IN_GRACE_PERIOD'), 'past_due', 'grace ⇒ past_due');
  eq(statusFor('SUBSCRIPTION_STATE_EXPIRED'), 'canceled', 'expired ⇒ canceled');
  eq(productPaid({ purchaseState: 0 }), true, 'purchased');
  eq(productPaid({ purchaseState: 2 }), false, 'pending');

  console.log('googlePlay self-check ok');
}
