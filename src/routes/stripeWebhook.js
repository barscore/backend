import { Hono } from 'hono';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { applyBoost } from '../lib/boostFulfillment.js';
import { syncSubscription } from '../lib/plus.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Stripe → us. No auth middleware (Stripe is the caller); trust comes from the
// signature check on the RAW body. Idempotent: the pending→paid transition
// filters on status, so Stripe redeliveries no-op.
const hook = new Hono();

/**
 * The subscription id on an invoice: top level until API 2025-03-31, then
 * under `parent.subscription_details`. Both are read so bumping the API
 * version can't silently stop renewals from being applied.
 */
function invoiceSubscriptionId(invoice) {
  const sub = invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription ?? null;
  return typeof sub === 'string' ? sub : (sub?.id ?? null);
}

/**
 * Fulfilment di una Checkout Session pagata.
 *
 * Idempotente: la subscription passa da syncSubscription (che riscrive sempre
 * lo stesso stato) e il boost da un UPDATE filtrato su `status = 'pending'`,
 * quindi una redelivery di Stripe non concede niente due volte.
 */
async function fulfillSession(session) {
  // rabar+ — abbonamento: la sessione porta l'id utente nei metadata, il
  // diritto lo scrive syncSubscription leggendo la subscription vera. Nessun
  // controllo sul pagamento qui: syncSubscription concede solo per gli stati
  // che danno diritto, quindi una subscription ancora `incomplete` non regala
  // nulla — sara' il customer.subscription.updated dell'attivazione a farlo.
  if (session.mode === 'subscription' && session.subscription) {
    const sub = await stripe.subscriptions.retrieve(
      typeof session.subscription === 'string' ? session.subscription : session.subscription.id,
    );
    await syncSubscription(sub, { userId: session.metadata?.user_id });
  }

  // Boost — pagamento una tantum, e qui il controllo serve: e' merce concessa
  // subito, contro un incasso che con un metodo asincrono puo' ancora fallire.
  const orderId = session.metadata?.order_id;
  if (!orderId || session.payment_status !== 'paid') return;

  const { data: order } = await supabase
    .from('boost_orders')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('status', 'pending')
    .select('event_id, bar_id, tier, sponsor_radius_km')
    .maybeSingle();

  if (order) await applyBoost(order);
}

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

  // Una sessione di Checkout si "completa" prima di essere pagata quando il
  // metodo e' asincrono (SEPA, Bancontact): l'incasso arriva giorni dopo, con
  // async_payment_succeeded. Entrambi gli eventi passano di qui, ed e'
  // `payment_status` a decidere, non il tipo di evento.
  if (
    event.type === 'checkout.session.completed' ||
    event.type === 'checkout.session.async_payment_succeeded'
  ) {
    await fulfillSession(event.data.object);
  }

  // Rinnovo, cambio piano, disdetta, pagamento fallito: tutti finiscono nello
  // stesso sync, che è l'unico a toccare profiles.plus_until.
  if (event.type.startsWith('customer.subscription.')) {
    await syncSubscription(event.data.object);
  }

  if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const subId = invoiceSubscriptionId(event.data.object);
    if (subId) await syncSubscription(await stripe.subscriptions.retrieve(subId));
  }

  return c.json({ received: true });
});

export default hook;
