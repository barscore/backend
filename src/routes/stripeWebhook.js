import { Hono } from 'hono';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { applyBoost, revokeBoost } from '../lib/boostFulfillment.js';
import { syncSubscription } from '../lib/plus.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

// Stripe → us. No auth middleware (Stripe is the caller); trust comes from the
// signature check on the RAW body. Idempotent: every state transition filters
// on the previous status, so Stripe redeliveries no-op.
//
// Eventi gestiti: checkout.session.completed, checkout.session.async_payment_succeeded,
// customer.subscription.* , invoice.paid, invoice.payment_failed,
// charge.refunded, charge.dispute.created.
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

/**
 * Revoca di un boost gia' concesso: rimborso o contestazione.
 *
 * Il charge porta solo il payment_intent, mentre boost_orders indicizza la
 * Checkout Session: si risale alla sessione da Stripe invece di aggiungere una
 * colonna: il caso e' raro e non vale una migrazione su una tabella di ordini.
 *
 * Nessuna sessione (o nessun ordine) ⇒ si esce in silenzio: puo' essere il
 * rimborso di un abbonamento rabar+, che non concede giorni da togliere.
 *
 * L'UPDATE filtra su `status = 'paid'` come il fulfilment filtra su 'pending',
 * quindi una redelivery — o una contestazione dopo un rimborso — non toglie i
 * giorni due volte.
 */
async function revokeByPaymentIntent(paymentIntent, status) {
  const intentId = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id;
  if (!intentId) return;

  const { data: sessions } = await stripe.checkout.sessions.list({
    payment_intent: intentId,
    limit: 1,
  });
  const sessionId = sessions?.[0]?.id;
  if (!sessionId) return;

  const { data: order } = await supabase
    .from('boost_orders')
    .update({ status })
    .eq('stripe_session_id', sessionId)
    .eq('status', 'paid')
    .select('event_id, bar_id, tier')
    .maybeSingle();

  if (order) await revokeBoost(order);
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

  // Merce gia' consegnata e non pagata: senza questi due un boost rimborsato
  // resterebbe in evidenza fino alla scadenza naturale.
  if (event.type === 'charge.refunded') {
    await revokeByPaymentIntent(event.data.object.payment_intent, 'refunded');
  }

  // Il dispute porta il charge, non il payment_intent: serve un giro in piu'.
  if (event.type === 'charge.dispute.created') {
    const chargeRef = event.data.object.charge;
    const chargeId = typeof chargeRef === 'string' ? chargeRef : chargeRef?.id;
    if (chargeId) {
      const charge = await stripe.charges.retrieve(chargeId);
      await revokeByPaymentIntent(charge.payment_intent, 'disputed');
    }
  }

  return c.json({ received: true });
});

export default hook;
