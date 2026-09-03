import { Hono } from 'hono';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
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
import { appleOrderSchema, appleVerifySchema, boostCheckoutSchema } from '../schemas/boostSchemas.js';

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
boosts.post('/checkout', requireAuth, requireRole('organizer'), async (c) => {
  if (!stripe) throw new AppError(503, 'UNAVAILABLE', 'Pagamenti non configurati');
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
});

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
boosts.post('/apple/order', requireAuth, requireRole('organizer'), async (c) => {
  const user = c.get('user');
  const { tier, event_id, bar_id, sponsor_radius_km } = appleOrderSchema.parse(
    await c.req.json(),
  );
  const t = TIERS[tier];
  const radiusKm = bar_id ? sponsor_radius_km ?? null : null;

  await assertOwnsTarget(user, { event_id, bar_id, days: t.days });

  const { data: order, error } = await supabase
    .from('boost_orders')
    .insert({
      user_id: user.id,
      event_id: event_id ?? null,
      bar_id: bar_id ?? null,
      tier,
      sponsor_radius_km: radiusKm,
      // Apple charges the fixed StoreKit product price; the radius surcharge is
      // not billed on iOS yet (real IAP products land with the dev account).
      amount_cents: t.amount_cents,
      provider: 'apple',
    })
    .select('id')
    .single();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Creazione ordine non riuscita');

  return c.json({ order_id: order.id, product_id: APPLE_PRODUCTS[tier] });
});

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
  if (payload.productId && payload.productId !== APPLE_PRODUCTS[order.tier]) {
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
