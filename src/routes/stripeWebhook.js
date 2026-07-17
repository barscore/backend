import { Hono } from 'hono';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { TIERS } from './boosts.js';

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

      if (order) {
        // Stack purchases: extend from the current boost end when still active.
        const days = TIERS[order.tier].days;
        const table = order.event_id ? 'events' : 'bars';
        const targetId = order.event_id ?? order.bar_id;
        const { data: row } = await supabase
          .from(table)
          .select('boost_until')
          .eq('id', targetId)
          .maybeSingle();
        const base =
          row?.boost_until && new Date(row.boost_until) > new Date()
            ? new Date(row.boost_until)
            : new Date();
        const until = new Date(base.getTime() + days * 86_400_000).toISOString();
        await supabase.from(table).update({ boost_until: until }).eq('id', targetId);
      }
    }
  }
  return c.json({ received: true });
});

export default hook;
