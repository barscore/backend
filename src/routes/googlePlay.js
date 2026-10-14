import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { PACKAGE_NAME } from '../lib/googlePlay.js';
import { revokeBoost } from '../lib/boostFulfillment.js';
import { syncGoogleSubscription } from '../lib/plus.js';
import { sameSecret } from '../lib/secret.js';
import { AppError } from '../middleware/errorHandler.js';

// Google Play → us: Real-time developer notifications, delivered by a Pub/Sub
// push subscription to POST /google-play/rtdn?token=<GOOGLE_PLAY_RTDN_TOKEN>.
//
// No user here: trust comes from the shared token in the URL, and nothing in
// the message is believed as is — every notification only says "go and look",
// and the state is read back from the Developer API. Idempotent for the same
// reason: Pub/Sub redelivers until it gets a 2xx, and re-reading is harmless.
//
// A 5xx (Google unreachable, DB down) makes Pub/Sub retry later; a message we
// cannot use (malformed, another package, a test) is acknowledged with a 200 so
// it stops coming back.
const gp = new Hono();

const ONE_TIME = 2; // voidedPurchaseNotification.productType

gp.post('/rtdn', async (c) => {
  if (!sameSecret(c.req.query('token'), process.env.GOOGLE_PLAY_RTDN_TOKEN)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Non autorizzato');
  }

  const body = await c.req.json().catch(() => null);
  let n = null;
  try {
    n = JSON.parse(Buffer.from(body?.message?.data ?? '', 'base64').toString('utf8'));
  } catch {
    return c.json({ ok: true, ignored: 'malformed' });
  }
  if (!n || (n.packageName && n.packageName !== PACKAGE_NAME)) {
    return c.json({ ok: true, ignored: 'package' });
  }

  // Purchase, renewal, cancellation, grace period, hold, expiry, revocation:
  // whatever happened, the subscription's current state says what to do.
  const subToken = n.subscriptionNotification?.purchaseToken;
  if (subToken) await syncGoogleSubscription(subToken);

  // Refunds and chargebacks.
  const voided = n.voidedPurchaseNotification;
  if (voided?.purchaseToken) {
    if (voided.productType === ONE_TIME) {
      // Only paid → refunded, once: a redelivery can't take the days twice.
      const { data: order } = await supabase
        .from('boost_orders')
        .update({ status: 'refunded' })
        .eq('google_purchase_token', voided.purchaseToken)
        .eq('status', 'paid')
        .select('event_id, bar_id, tier')
        .maybeSingle();
      if (order) await revokeBoost(order);
    } else {
      // A refunded subscription is revoked by Google: re-reading it ends rabar+.
      await syncGoogleSubscription(voided.purchaseToken);
    }
  }

  return c.json({ ok: true });
});

export default gp;
