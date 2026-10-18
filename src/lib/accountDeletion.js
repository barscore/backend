import Stripe from 'stripe';
import { supabase } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';
import { deleteAllProofsForUser } from './proofs.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Cancella un account. Unico percorso per l'utente (DELETE /me) e per lo staff
 * (DELETE /admin/users/:id, che è anche la strada delle richieste arrivate a
 * privacy@): le due strade non possono divergere su cosa resta dietro.
 *
 * Il cascade delle FK copre il database, non il resto:
 *  - un abbonamento Stripe continuerebbe a rinnovarsi e ad addebitare chi non ha
 *    più nulla a cui il diritto possa andare. Se la disdetta non riesce l'account
 *    resta dov'è e si può riprovare: meglio un errore che un addebito senza
 *    servizio. Google Play e App Store non si annullano da qui: le app avvisano.
 *  - i documenti allegati alle verifiche (visure, documenti d'identità) stanno
 *    nello storage, che l'art. 17 GDPR copre come il resto.
 */
export async function eraseAccount(userId) {
  await cancelStripeSubscription(userId);
  await deleteAllProofsForUser(userId);

  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Eliminazione account fallita');
}

/** Annulla subito l'abbonamento rabar+ Stripe dell'utente, se ce n'è uno vivo. */
async function cancelStripeSubscription(userId) {
  const { data: sub, error } = await supabase
    .from('plus_subscriptions')
    .select('provider, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Eliminazione account fallita');
  if (sub?.provider !== 'stripe' || !sub.stripe_subscription_id) return;

  const failed = () =>
    new AppError(
      500,
      'INTERNAL_ERROR',
      "Non è stato possibile annullare l'abbonamento rabar+: riprova tra poco",
    );
  if (!stripe) throw failed();
  try {
    // Lo stato locale può essere indietro rispetto a Stripe: si chiede a lui.
    const live = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    if (['canceled', 'incomplete_expired'].includes(live.status)) return;
    await stripe.subscriptions.cancel(sub.stripe_subscription_id);
  } catch (e) {
    if (e?.code === 'resource_missing') return;
    console.error('[account] disdetta Stripe non riuscita:', e?.message);
    throw failed();
  }
}
