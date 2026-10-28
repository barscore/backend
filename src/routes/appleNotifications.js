import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { verifyNotification } from '../lib/appleIap.js';
import { applyBoost, revokeBoost } from '../lib/boostFulfillment.js';
import { AppError } from '../middleware/errorHandler.js';

// App Store → us: App Store Server Notifications V2, the Apple counterpart of
// the Google Play RTDN. URL to set in App Store Connect → the app → App
// Information → App Store Server Notifications, Version 2, for both production
// and sandbox: POST /apple/notifications.
//
// No user and no shared secret: the body is a JWS signed by Apple, verified
// against the same root certificates and bundle id as the purchases
// (lib/appleIap.js). Boosts are consumables, so the only thing that changes an
// order after it is paid is a refund — and its reversal.
//
// Idempotent: every transition filters on the previous status, so Apple's
// retries (it redelivers anything that did not get a 2xx) no-op. A payload that
// does not verify is a 400: forged, or for another app.
const apple = new Hono();

const ORDER_FIELDS = 'id, event_id, bar_id, tier, sponsor_radius_km';

apple.post('/notifications', async (c) => {
  const body = await c.req.json().catch(() => null);
  const signedPayload = body?.signedPayload;
  if (typeof signedPayload !== 'string' || signedPayload.length > 100_000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Notifica non valida');
  }

  const verified = await verifyNotification(signedPayload);
  if (!verified) throw new AppError(400, 'VALIDATION_ERROR', 'Notifica Apple non verificabile');

  const { notification, transaction } = verified;
  const transactionId = transaction?.transactionId;
  if (!transactionId) return c.json({ ok: true, ignored: notification.notificationType });

  switch (notification.notificationType) {
    // Refund granted (REFUND) or Family Sharing access withdrawn (REVOKE): the
    // boost goes, once — only a paid order can become refunded.
    case 'REFUND':
    case 'REVOKE': {
      const { data: order } = await supabase
        .from('boost_orders')
        .update({ status: 'refunded' })
        .eq('apple_transaction_id', transactionId)
        .eq('status', 'paid')
        .select(ORDER_FIELDS)
        .maybeSingle();
      if (order) await revokeBoost(order);
      break;
    }
    // Apple took the refund back: the user has paid after all.
    case 'REFUND_REVERSED': {
      const { data: order } = await supabase
        .from('boost_orders')
        .update({ status: 'paid' })
        .eq('apple_transaction_id', transactionId)
        .eq('status', 'refunded')
        .select(ORDER_FIELDS)
        .maybeSingle();
      if (order) await applyBoost(order);
      break;
    }
    default:
      return c.json({ ok: true, ignored: notification.notificationType });
  }

  return c.json({ ok: true });
});

export default apple;
