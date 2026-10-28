import { Hono } from 'hono';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { sharedRateLimiter } from '../middleware/rateLimiter.js';
import { assertMonetizationEnabled } from '../lib/appSettings.js';
import { uuidParam } from '../schemas/common.js';
import {
  TIERS,
  applyBoost,
  assertOwnsTarget,
  radiusSurchargeCents,
  RADIUS_CENTS_PER_KM_PER_DAY,
  SPONSOR_RADIUS_MIN_KM,
  SPONSOR_RADIUS_MAX_KM,
} from '../lib/boostFulfillment.js';
import { verifySignedTransaction } from '../lib/appleIap.js';
import {
  BOOST_PRODUCTS,
  GooglePlayError,
  consumeProduct,
  getProduct,
  googlePlayConfigured,
  playAccountMatches,
  productPaid,
} from '../lib/googlePlay.js';
import {
  appleOrderSchema,
  appleVerifySchema,
  boostCheckoutSchema,
  googleOrderSchema,
  googleVerifySchema,
} from '../schemas/boostSchemas.js';

// Paid visibility boosts. Prices are server-side only (env), the client sends
// just tier + target. Inline price_data ⇒ no products to manage in the Stripe
// dashboard. Fulfillment happens in the signed webhook / the Apple verification
// endpoint, never in the request that starts the payment.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export { TIERS };

const boosts = new Hono();

/** GET /boosts/tiers — public price list + radius rate for the boost modal. */
boosts.get('/tiers', (c) =>
  c.json({
    tiers: Object.entries(TIERS).map(([tier, t]) => ({ tier, ...t })),
    // Lets the bar modal show a live total as the radius slider moves.
    radius: {
      min_km: SPONSOR_RADIUS_MIN_KM,
      max_km: SPONSOR_RADIUS_MAX_KM,
      cents_per_km_per_day: RADIUS_CENTS_PER_KM_PER_DAY,
    },
  }),
);

/** GET /boosts/session/:sid — order status for the checkout result page. */
boosts.get('/session/:sid', requireAuth, async (c) => {
  const sid = c.req.param('sid');
  const { data, error } = await supabase
    .from('boost_orders')
    .select('id, status, tier, event_id, bar_id, paid_at')
    .eq('stripe_session_id', sid)
    .eq('user_id', c.get('user').id)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load order');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Ordine non trovato');
  return c.json({ order: data });
});

/** POST /boosts/checkout — create the Stripe Checkout Session for a boost. */
// Ogni chiamata apre una riga boost_orders E una Checkout Session su Stripe:
// senza limite un organizer approvato puo' riempire entrambe.
boosts.post(
  '/checkout',
  requireAuth,
  requireRole('organizer'),
  sharedRateLimiter({ windowMs: 60_000, max: 10, key: 'boost-checkout' }),
  async (c) => {
    if (!stripe) throw new AppError(503, 'UNAVAILABLE', 'Pagamenti non configurati');
    await assertMonetizationEnabled();
    const user = c.get('user');
    const { tier, event_id, bar_id, sponsor_radius_km } = boostCheckoutSchema.parse(
      await c.req.json(),
    );
    const t = TIERS[tier];
    const radiusKm = bar_id ? sponsor_radius_km ?? null : null;
    const amount_cents = t.amount_cents + radiusSurchargeCents(t.days, radiusKm);

    // Ownership gate: own events / own (claimed) bar only.
    const label = await assertOwnsTarget(user, { event_id, bar_id, days: t.days });

    const { data: order, error } = await supabase
      .from('boost_orders')
      .insert({
        user_id: user.id,
        event_id: event_id ?? null,
        bar_id: bar_id ?? null,
        tier,
        sponsor_radius_km: radiusKm,
        amount_cents,
      })
      .select('id')
      .single();
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Creazione ordine non riuscita');

    const origin = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: amount_cents,
            product_data: { name: label },
          },
        },
      ],
      metadata: { order_id: order.id },
      success_url: `${origin}/boost/esito?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?tab=eventi`,
    });

    await supabase.from('boost_orders').update({ stripe_session_id: session.id }).eq('id', order.id);
    return c.json({ url: session.url });
  },
);

// ---------------------------------------------------------------------------
// Apple in-app purchases (iOS client)
//
// App Store rule 3.1.1 rules out sending people to Stripe for something used
// inside the app, so iOS buys the same boost as a consumable IAP. The order is
// opened here first — that is where the ownership gate runs, before the user is
// charged — and the id travels back as the transaction's appAccountToken.
// ---------------------------------------------------------------------------

/** Product ids, mirroring `Config.boostProductIDs` in the iOS app. */
const APPLE_PRODUCTS = {
  '3d': 'com.rabar.app.boost.3d',
  '7d': 'com.rabar.app.boost.7d',
  '30d': 'com.rabar.app.boost.30d',
};

/** POST /boosts/apple/order — open a pending order for an IAP. */
// Come /checkout: qui la riga si apre prima che StoreKit abbia incassato,
// quindi gli ordini pendenti si accumulano piu' facilmente.
boosts.post(
  '/apple/order',
  requireAuth,
  requireRole('organizer'),
  sharedRateLimiter({ windowMs: 60_000, max: 10, key: 'boost-order' }),
  async (c) => {
    await assertMonetizationEnabled();
    const user = c.get('user');
    // `sponsor_radius_km` is accepted (older builds send it) but not used: the
    // radius is priced per km and a fixed-price StoreKit product could only give
    // it away, as on Google Play. It comes back with per-radius IAP products.
    const { tier, event_id, bar_id } = appleOrderSchema.parse(await c.req.json());
    const t = TIERS[tier];

    await assertOwnsTarget(user, { event_id, bar_id, days: t.days });

    const { data: order, error } = await supabase
      .from('boost_orders')
      .insert({
        user_id: user.id,
        event_id: event_id ?? null,
        bar_id: bar_id ?? null,
        tier,
        sponsor_radius_km: null,
        // Apple charges the fixed StoreKit product price, nothing else.
        amount_cents: t.amount_cents,
        provider: 'apple',
      })
      .select('id')
      .single();
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Creazione ordine non riuscita');

    return c.json({ order_id: order.id, product_id: APPLE_PRODUCTS[tier] });
  },
);

/**
 * POST /boosts/apple/verify — verify a signed StoreKit transaction and fulfil.
 *
 * Idempotent in two layers: the pending→paid update filters on status, and
 * `apple_transaction_id` is uniquely indexed. Replaying a transaction (Apple
 * retries, `Transaction.updates` on a second device) therefore lands on an
 * already-paid row and returns it unchanged rather than granting a second boost.
 */
boosts.post('/apple/verify', requireAuth, async (c) => {
  const user = c.get('user');
  const { signed_transaction } = appleVerifySchema.parse(await c.req.json());

  const payload = await verifySignedTransaction(signed_transaction);
  if (!payload) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Transazione Apple non verificabile');
  }

  const transactionId = payload.transactionId;
  const orderId = payload.appAccountToken;
  if (!transactionId || !orderId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Transazione senza ordine associato');
  }

  // Already recorded: hand back the same order instead of paying it twice.
  const { data: seen } = await supabase
    .from('boost_orders')
    .select('id, status, tier, event_id, bar_id, paid_at')
    .eq('apple_transaction_id', transactionId)
    .maybeSingle();
  if (seen) return c.json({ order: seen });

  const { data: order } = await supabase
    .from('boost_orders')
    .select('id, user_id, tier, event_id, bar_id, status')
    .eq('id', orderId)
    .maybeSingle();
  if (!order || order.user_id !== user.id) {
    throw new AppError(404, 'NOT_FOUND', 'Ordine non trovato');
  }

  // The product actually bought has to match the tier the order was opened
  // for, or a 3-day purchase could be redeemed against a 30-day order.
  if (payload.productId !== APPLE_PRODUCTS[order.tier]) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Prodotto non corrispondente all’ordine');
  }

  const { data: paid } = await supabase
    .from('boost_orders')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      apple_transaction_id: transactionId,
    })
    .eq('id', order.id)
    .eq('status', 'pending')
    .select('id, status, tier, event_id, bar_id, sponsor_radius_km, paid_at')
    .maybeSingle();

  // Lost the race against a concurrent verification of the same order.
  if (!paid) {
    const { data: current } = await supabase
      .from('boost_orders')
      .select('id, status, tier, event_id, bar_id, paid_at')
      .eq('id', order.id)
      .maybeSingle();
    return c.json({ order: current });
  }

  await applyBoost(paid);
  return c.json({ order: paid });
});

// ---------------------------------------------------------------------------
// Google Play (Android client)
//
// Same shape as the Apple path: the order is opened here first, where the
// ownership gate runs before anyone is charged, and its id travels on the
// purchase as the obfuscated profile id. The three Play products have a fixed
// price, so an Android boost carries no extra radius: the radius is priced per
// km and a fixed-price product could only give it away.
// ---------------------------------------------------------------------------

const ORDER_FIELDS = 'id, status, tier, event_id, bar_id, paid_at';

/** POST /boosts/google/order — open a pending order for a Play purchase. */
boosts.post(
  '/google/order',
  requireAuth,
  requireRole('organizer'),
  sharedRateLimiter({ windowMs: 60_000, max: 10, key: 'boost-order' }),
  async (c) => {
    if (!googlePlayConfigured()) throw new AppError(503, 'UNAVAILABLE', 'Pagamenti non configurati');
    await assertMonetizationEnabled();
    const user = c.get('user');
    const { tier, event_id, bar_id } = googleOrderSchema.parse(await c.req.json());
    const t = TIERS[tier];

    await assertOwnsTarget(user, { event_id, bar_id, days: t.days });

    const { data: order, error } = await supabase
      .from('boost_orders')
      .insert({
        user_id: user.id,
        event_id: event_id ?? null,
        bar_id: bar_id ?? null,
        tier,
        // What the server price list says; Google bills the price set on the
        // product in Play Console, which is the one the app shows.
        amount_cents: t.amount_cents,
        provider: 'google',
      })
      .select('id')
      .single();
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Creazione ordine non riuscita');

    return c.json({ order_id: order.id, product_id: BOOST_PRODUCTS[tier] });
  },
);

/**
 * POST /boosts/google/verify — read the purchase back from Google and fulfil.
 *
 * Idempotent like the Apple path: the pending→paid update filters on status and
 * `google_purchase_token` is uniquely indexed, so the app retrying (or finding
 * the same unconsumed purchase at the next launch) gets the paid order back
 * instead of a second boost. Consuming happens here, after the grant, so a
 * purchase Google charged is never left without its boost.
 */
boosts.post(
  '/google/verify',
  requireAuth,
  sharedRateLimiter({ windowMs: 60_000, max: 20, key: 'boost-google' }),
  async (c) => {
    if (!googlePlayConfigured()) throw new AppError(503, 'UNAVAILABLE', 'Pagamenti non configurati');
    const user = c.get('user');
    const { order_id, product_id, purchase_token } = googleVerifySchema.parse(await c.req.json());

    const consume = () =>
      consumeProduct(product_id, purchase_token).catch((e) =>
        console.error('[boosts] consume Google non riuscito:', e.message),
      );

    const { data: seen } = await supabase
      .from('boost_orders')
      .select(`${ORDER_FIELDS}, user_id`)
      .eq('google_purchase_token', purchase_token)
      .maybeSingle();
    if (seen) {
      if (seen.user_id !== user.id) throw new AppError(404, 'NOT_FOUND', 'Ordine non trovato');
      await consume();
      const { user_id: _owner, ...order } = seen;
      return c.json({ order });
    }

    const { data: order } = await supabase
      .from('boost_orders')
      .select('id, user_id, tier, status')
      .eq('id', order_id)
      .maybeSingle();
    if (!order || order.user_id !== user.id) {
      throw new AppError(404, 'NOT_FOUND', 'Ordine non trovato');
    }
    // A 3-day product must not settle a 30-day order.
    if (product_id !== BOOST_PRODUCTS[order.tier]) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Prodotto non corrispondente all’ordine');
    }

    let purchase;
    try {
      purchase = await getProduct(product_id, purchase_token);
    } catch (e) {
      if (e instanceof GooglePlayError) throw new AppError(e.status, 'UNAVAILABLE', 'Google Play non raggiungibile');
      throw e;
    }
    if (!purchase) throw new AppError(400, 'VALIDATION_ERROR', 'Acquisto Google Play non valido');

    // The app stamps both ids on the purchase: a token bought for another order
    // or by another account settles nothing here.
    if (
      (purchase.obfuscatedExternalProfileId && purchase.obfuscatedExternalProfileId !== order.id) ||
      (purchase.obfuscatedExternalAccountId && !playAccountMatches(purchase.obfuscatedExternalAccountId, user.id))
    ) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Acquisto non corrispondente all’ordine');
    }
    // Pending (e.g. cash at a shop): nothing yet. Play tells the app when it
    // completes, and the app comes back here.
    if (purchase.purchaseState === 2) return c.json({ order: { id: order.id, status: 'pending' } }, 202);
    if (!productPaid(purchase)) throw new AppError(400, 'VALIDATION_ERROR', 'Acquisto annullato');

    const { data: paid } = await supabase
      .from('boost_orders')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        google_purchase_token: purchase_token,
        google_order_id: purchase.orderId ?? null,
      })
      .eq('id', order.id)
      .eq('status', 'pending')
      .select(`${ORDER_FIELDS}, sponsor_radius_km`)
      .maybeSingle();

    if (!paid) {
      // Lost the race against a concurrent verification of the same order.
      const { data: current } = await supabase
        .from('boost_orders')
        .select(ORDER_FIELDS)
        .eq('id', order.id)
        .maybeSingle();
      return c.json({ order: current });
    }

    await applyBoost(paid);
    await consume();
    const { sponsor_radius_km: _radius, ...out } = paid;
    return c.json({ order: out });
  },
);

/** GET /boosts/order/:id — order status for the purchase result screen. */
boosts.get('/order/:id', requireAuth, async (c) => {
  const { data, error } = await supabase
    .from('boost_orders')
    .select('id, status, tier, event_id, bar_id, paid_at')
    .eq('id', uuidParam(c))
    .eq('user_id', c.get('user').id)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load order');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Ordine non trovato');
  return c.json({ order: data });
});

export default boosts;
