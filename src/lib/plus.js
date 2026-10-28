import { supabase } from './supabase.js';
import { issueFreeDrinkToken } from './freeDrink.js';
import {
  PLUS_PRODUCT_ID,
  acknowledgeSubscription,
  getSubscription,
  isLegacyAccountTag,
  playAccountMatches,
  readSubscription,
  statusFor,
} from './googlePlay.js';

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

  // Una sola riga per utente: chi è passato a Google Play dopo un vecchio
  // abbonamento Stripe non deve vedersi chiudere quello buono dall'ultimo
  // evento (`deleted`, `updated`) dell'abbonamento morto.
  if (!ACTIVE_STATUSES.has(sub.status)) {
    const { data: row } = await supabase
      .from('plus_subscriptions')
      .select('provider')
      .eq('user_id', uid)
      .maybeSingle();
    if (row?.provider === 'google') return { user_id: uid, status: sub.status, ignored: true };
  }

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
    await supabase.from('profiles').update({ plus_until: end }).eq('id', uid);
    // Best-effort: il drink non deve far fallire il webhook che dà il diritto.
    await issueFreeDrinkToken(uid).catch((e) =>
      console.error('[plus] free drink token non emesso:', e.message),
    );
  }

  return { user_id: uid, status: sub.status, plus_until: end };
}

/**
 * Se un abbonamento Google Play letto adesso può scrivere sulla riga dell'utente.
 *
 * Un acquisto vivo vince sempre. Uno scaduto, revocato o sospeso può chiudere
 * solo l'abbonamento che la riga sta seguendo: non uno Stripe ancora attivo, né
 * quello Google che lo ha sostituito (cambio piano ⇒ token nuovo, e le notifiche
 * del vecchio continuano ad arrivare).
 */
export function googleMayWrite(row, token, { entitled }) {
  if (entitled || !row) return true;
  if (row.provider === 'google') return row.google_purchase_token === token;
  return !ACTIVE_STATUSES.has(row.status);
}

export class PlusOwnershipError extends Error {}

/**
 * Allinea rabar+ a un abbonamento Google Play, letto dalla Developer API.
 *
 * Chiamata dall'app subito dopo l'acquisto e a ogni avvio (con `userId`, il
 * chiamante), dalle notifiche in tempo reale di Google e dal cron (senza).
 * L'utente è quello che l'app ha messo sull'acquisto, come hash
 * (`obfuscatedAccountId`): un token comprato da un altro account, o già legato
 * a un altro utente, non concede niente a chi lo presenta.
 *
 * Idempotente come syncSubscription: rilegge sempre lo stato vero da Google.
 */
export async function syncGoogleSubscription(token, { userId } = {}) {
  const sub = await getSubscription(token);
  const s = sub ? readSubscription(sub) : null;
  if (!s) return null;

  const { data: bound } = await supabase
    .from('plus_subscriptions')
    .select('user_id')
    .eq('google_purchase_token', token)
    .maybeSingle();

  // Cambio piano: il token nuovo nasce legato al vecchio, che è già nostro.
  let linked = null;
  if (!bound && s.linkedToken) {
    ({ data: linked } = await supabase
      .from('plus_subscriptions')
      .select('user_id')
      .eq('google_purchase_token', s.linkedToken)
      .maybeSingle());
  }

  // Sull'acquisto c'è l'hash dell'utente (playAccountTag), o il suo id se è
  // stato fatto prima dell'hash. Da un hash non si risale a chi è: l'utente
  // arriva da chi ha già legato il token o dall'app che lo presenta, e l'hash
  // deve tornare. Una notifica di Google per un token che nessuno ha ancora
  // presentato aspetta l'app, che lo verifica subito dopo l'acquisto e a ogni avvio.
  const tag = s.accountTag;
  const uid = (isLegacyAccountTag(tag) ? tag : null) ?? bound?.user_id ?? linked?.user_id ?? userId ?? null;
  if (!uid) return null;
  if (
    (tag && !playAccountMatches(tag, uid)) ||
    (userId && uid !== userId) ||
    (bound && bound.user_id !== uid)
  ) {
    throw new PlusOwnershipError('Acquisto legato a un altro account');
  }

  const { data: row } = await supabase
    .from('plus_subscriptions')
    .select('provider, status, google_purchase_token')
    .eq('user_id', uid)
    .maybeSingle();
  if (!googleMayWrite(row, token, s)) return { user_id: uid, status: statusFor(s.state), ignored: true };

  const { error } = await supabase.from('plus_subscriptions').upsert(
    {
      user_id: uid,
      provider: 'google',
      plan: s.plan,
      status: statusFor(s.state),
      google_purchase_token: token,
      current_period_end: s.until,
      cancel_at_period_end: !s.autoRenew,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw error;

  // Scaduto o revocato: il diritto finisce adesso al più tardi, mai dopo.
  const now = new Date().toISOString();
  const until = s.entitled ? s.until : s.until && s.until < now ? s.until : now;
  await supabase.from('profiles').update({ plus_until: until }).eq('id', uid);

  if (s.entitled) {
    await issueFreeDrinkToken(uid).catch((e) =>
      console.error('[plus] free drink token non emesso:', e.message),
    );
    // Entro tre giorni, o Google rimborsa da solo. Dopo aver dato il diritto:
    // un riconoscimento senza diritto sarebbe un incasso senza merce. Se
    // fallisce, il prossimo avvio dell'app (o la prossima notifica) ci riprova.
    if (!s.acknowledged) {
      await acknowledgeSubscription(PLUS_PRODUCT_ID, token).catch((e) =>
        console.error('[plus] acknowledge Google non riuscito:', e.message),
      );
    }
  }

  return { user_id: uid, status: statusFor(s.state), plus_until: until };
}

