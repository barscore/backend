import { Hono } from 'hono';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { boostCheckoutSchema } from '../schemas/boostSchemas.js';

// Paid visibility boosts. Prices are server-side only (env), the client sends
// just tier + target. Inline price_data ⇒ no products to manage in the Stripe
// dashboard. Fulfillment happens in the signed webhook, never here.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

export const TIERS = {
  '3d': { days: 3, amount_cents: Number(process.env.BOOST_PRICE_3D_CENTS) || 300 },
  '7d': { days: 7, amount_cents: Number(process.env.BOOST_PRICE_7D_CENTS) || 600 },
  '30d': { days: 30, amount_cents: Number(process.env.BOOST_PRICE_30D_CENTS) || 2000 },
};

const boosts = new Hono();

/** GET /boosts/tiers — public price list for the boost modal. */
boosts.get('/tiers', (c) =>
  c.json({ tiers: Object.entries(TIERS).map(([tier, t]) => ({ tier, ...t })) }),
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
  const { tier, event_id, bar_id } = boostCheckoutSchema.parse(await c.req.json());
  const t = TIERS[tier];

  // Ownership gate: own events / own (claimed) bar only.
  let label;
  if (event_id) {
    const { data: ev } = await supabase
      .from('events')
      .select('id, title, created_by, cancelled_at, starts_at, ends_at')
      .eq('id', event_id)
      .maybeSingle();
    if (!ev || ev.created_by !== user.id) throw new AppError(404, 'NOT_FOUND', 'Evento non trovato');
    if (ev.cancelled_at) throw new AppError(400, 'VALIDATION_ERROR', 'Evento annullato');
    if (new Date(ev.ends_at ?? ev.starts_at) < new Date()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Evento già concluso');
    }
    label = `Boost evento "${ev.title}" — ${t.days} giorni`;
  } else {
    const { data: bar } = await supabase
      .from('bars')
      .select('id, name, owner_id')
      .eq('id', bar_id)
      .maybeSingle();
    if (!bar || bar.owner_id !== user.id) throw new AppError(404, 'NOT_FOUND', 'Bar non trovato');
    label = `Boost bar "${bar.name}" — ${t.days} giorni`;
  }

  const { data: order, error } = await supabase
    .from('boost_orders')
    .insert({
      user_id: user.id,
      event_id: event_id ?? null,
      bar_id: bar_id ?? null,
      tier,
      amount_cents: t.amount_cents,
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
          unit_amount: t.amount_cents,
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

export default boosts;
