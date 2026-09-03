import { Hono } from 'hono';
import Stripe from 'stripe';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { PLANS, isPlus } from '../lib/plus.js';
import { plusCheckoutSchema } from '../schemas/plusSchemas.js';

// rabar+ — abbonamento (badge "+", tutti i temi, niente pubblicità).
// Come per i boost: i prezzi sono solo server-side, la sottoscrizione viene
// concessa dal webhook firmato e mai dalla richiesta che apre il pagamento.
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const plus = new Hono();

/** GET /plus/plans — listino pubblico per la pagina rabar+. */
plus.get('/plans', (c) =>
  c.json({
    plans: Object.entries(PLANS).map(([plan, p]) => ({
      plan,
      interval: p.interval,
      amount_cents: p.amount_cents,
    })),
  }),
);

/** GET /plus/status — stato dell'abbonamento di chi chiama. */
plus.get('/status', requireAuth, async (c) => {
  const user = c.get('user');

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('plus_until')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load plus status');

  const { data: sub } = await supabase
    .from('plus_subscriptions')
    .select('plan, status, current_period_end, cancel_at_period_end')
    .eq('user_id', user.id)
    .maybeSingle();

  return c.json({
    plus: isPlus(profile),
    plus_until: profile?.plus_until ?? null,
    subscription: sub ?? null,
  });
});

/** POST /plus/checkout — apre la Stripe Checkout Session in modalità abbonamento. */
plus.post('/checkout', requireAuth, async (c) => {
  if (!stripe) throw new AppError(503, 'UNAVAILABLE', 'Pagamenti non configurati');
  const user = c.get('user');
  const { plan } = plusCheckoutSchema.parse(await c.req.json());
  const p = PLANS[plan];

  const { data: profile } = await supabase
    .from('profiles')
    .select('plus_until')
    .eq('id', user.id)
    .maybeSingle();

  const { data: existing } = await supabase
    .from('plus_subscriptions')
    .select('status, stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();

  // Già abbonato: il cambio piano e la disdetta si fanno dal portale Stripe,
  // aprire un secondo Checkout creerebbe due abbonamenti sullo stesso account.
  if (isPlus(profile) && ['active', 'trialing', 'past_due'].includes(existing?.status)) {
    throw new AppError(409, 'CONFLICT', 'Hai già rabar+ attivo');
  }

  const origin = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
  const metadata = { user_id: user.id, plan };

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [
      {
        quantity: 1,
        // Un Price ricorrente configurato in dashboard vince sul price_data
        // inline: stessa forma dei boost, ma qui l'id è opzionale.
        ...(p.price_id
          ? { price: p.price_id }
          : {
              price_data: {
                currency: 'eur',
                unit_amount: p.amount_cents,
                recurring: { interval: p.interval },
                product_data: { name: 'rabar+' },
              },
            }),
      },
    ],
    // Il cliente Stripe si riusa se c'è già stato un abbonamento, altrimenti
    // Stripe ne crea uno dall'email.
    ...(existing?.stripe_customer_id
      ? { customer: existing.stripe_customer_id }
      : { customer_email: user.email }),
    metadata,
    // La subscription porta gli stessi metadata: al rinnovo il webhook riceve
    // solo la subscription, non la sessione di checkout.
    subscription_data: { metadata },
    allow_promotion_codes: true,
    // La carta si chiede solo se c'e' davvero qualcosa da pagare oggi. Col
    // default (`always`) Stripe la pretende anche a totale zero — un codice
    // sconto al 100% restava bloccato dietro l'autorizzazione da 0 €, che
    // diverse banche rifiutano. Per un abbonamento normale l'importo dovuto
    // non e' mai zero, quindi la carta viene chiesta come prima.
    // Attenzione se un giorno esistono coupon 100% a DURATA LIMITATA: alla
    // fine dello sconto l'abbonamento si troverebbe senza metodo di pagamento
    // e il rinnovo fallirebbe. Oggi l'unico coupon al 100% e' `forever`.
    payment_method_collection: 'if_required',
    success_url: `${origin}/plus?success=1`,
    cancel_url: `${origin}/plus`,
  });

  return c.json({ url: session.url });
});

/** POST /plus/portal — portale Stripe per cambiare piano o disdire. */
plus.post('/portal', requireAuth, async (c) => {
  if (!stripe) throw new AppError(503, 'UNAVAILABLE', 'Pagamenti non configurati');
  const user = c.get('user');

  const { data: sub } = await supabase
    .from('plus_subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!sub?.stripe_customer_id) {
    throw new AppError(404, 'NOT_FOUND', 'Nessun abbonamento da gestire');
  }

  const origin = (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();
  const portal = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${origin}/plus`,
  });

  return c.json({ url: portal.url });
});

export default plus;
