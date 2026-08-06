import { Hono } from 'hono';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { applyBoost } from '../lib/boostFulfillment.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Stripe → us. No auth middleware (Stripe is the caller); trust comes from the
// signature check on the RAW body. Idempotent: the pending→paid transition
// filters on status, so Stripe redeliveries no-op.
const hook = new Hono();

hook.post('/webhook', async (c) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return c.json({ received: true });

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      await c.req.text(),
      c.req.header('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return c.json({ error: 'Invalid signature', code: 'UNAUTHORIZED', statusCode: 400 }, 400);
  }

  if (event.type === 'checkout.session.completed') {
    const orderId = event.data.object.metadata?.order_id;
    if (orderId) {
      const { data: order } = await supabase
        .from('boost_orders')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', orderId)
        .eq('status', 'pending')
        .select('event_id, bar_id, tier')
        .maybeSingle();

      if (order) await applyBoost(order);
    }
  }
  return c.json({ received: true });
});

export default hook;
