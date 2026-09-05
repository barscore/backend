import { supabase } from './supabase.js';
import crypto from 'node:crypto';

/**
 * rabar+ — piani di abbonamento.
 *
 * I prezzi vivono solo qui (env, lato server): il client manda il piano, mai
 * un importo. Stessa regola dei boost. Se in Stripe esistono già dei Price
 * ricorrenti, basta metterne l'id in STRIPE_PLUS_PRICE_* e il Checkout li usa
 * al posto del price_data inline — l'abbonamento finisce così sotto un Product
 * solo nella dashboard invece che in una riga ad-hoc per acquisto.
 */
export const PLANS = {
  week: {
    interval: 'week',
    amount_cents: Number(process.env.PLUS_PRICE_WEEK_CENTS) || 199,
    price_id: process.env.STRIPE_PLUS_PRICE_WEEK || null,
  },
  month: {
    interval: 'month',
    amount_cents: Number(process.env.PLUS_PRICE_MONTH_CENTS) || 399,
    price_id: process.env.STRIPE_PLUS_PRICE_MONTH || null,
  },
  year: {
    interval: 'year',
    amount_cents: Number(process.env.PLUS_PRICE_YEAR_CENTS) || 2999,
    price_id: process.env.STRIPE_PLUS_PRICE_YEAR || null,
  },
};

/** Un profilo è Plus finché la fine del periodo pagato è nel futuro. */
export function isPlus(profile) {
  return !!profile?.plus_until && new Date(profile.plus_until) > new Date();
}

/**
 * Fine del periodo corrente di una subscription Stripe.
 *
 * Dalla API 2025-03-31 `current_period_end` non sta più sull'oggetto
 * subscription ma sulla singola voce: si leggono entrambi così l'aggiornamento
 * della versione API non spegne gli abbonamenti di tutti.
 */
export function periodEnd(sub) {
  const ts = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

/** Stati Stripe che danno diritto al Plus. `past_due` resta attivo fino a
 *  quando Stripe non chiude il recupero del pagamento (poi arriva `canceled`). */
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Allinea la copia locale dell'abbonamento e il diritto sul profilo.
 *
 * Unico punto che scrive `profiles.plus_until`: sottoscrizione, rinnovo e
 * disdetta passano tutti di qui, così i tre eventi non possono divergere.
 * Idempotente — Stripe rimanda lo stesso evento più volte.
 *
 * Disdetta: `plus_until` NON viene arretrato. Chi annulla ha già pagato fino a
 * fine periodo e resta Plus fino a lì; poi scade da solo (nessun cron).
 */
export async function syncSubscription(sub, { userId } = {}) {
  const uid = userId ?? sub?.metadata?.user_id ?? null;
  if (!uid) return null;

  const end = periodEnd(sub);
  const plan = sub?.metadata?.plan ?? null;

  await supabase
    .from('plus_subscriptions')
    .upsert(
      {
        user_id: uid,
        provider: 'stripe',
        plan,
        status: sub.status,
        stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
        stripe_subscription_id: sub.id,
        current_period_end: end,
        cancel_at_period_end: !!sub.cancel_at_period_end,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (ACTIVE_STATUSES.has(sub.status) && end) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('free_drink_token')
      .eq('id', uid)
      .maybeSingle();

    const updatePayload = { plus_until: end };
    if (!profile?.free_drink_token) {
      updatePayload.free_drink_token = crypto.randomUUID();
    }
    
    await supabase.from('profiles').update(updatePayload).eq('id', uid);
  }

  return { user_id: uid, status: sub.status, plus_until: end };
}
