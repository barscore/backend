import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  pushSubscribeSchema,
  pushUnsubscribeSchema,
} from '../schemas/notificationSchemas.js';

// Web Push subscription registry. One row per browser/device; the endpoint is
// globally unique, so re-subscribing the same device just re-binds the user.
const push = new Hono();
push.use('*', requireAuth);

/** POST /push/subscribe — register this device's PushSubscription. */
push.post('/subscribe', async (c) => {
  const user = c.get('user');
  const { endpoint, keys } = pushSubscribeSchema.parse(await c.req.json());
  const { error } = await supabase
    .from('push_subscriptions')
    .upsert(
      { user_id: user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
      { onConflict: 'endpoint' },
    );
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Registrazione push non riuscita');
  return c.json({ success: true }, 201);
});

/** DELETE /push/subscribe — remove this device's subscription. */
push.delete('/subscribe', async (c) => {
  const user = c.get('user');
  const { endpoint } = pushUnsubscribeSchema.parse(await c.req.json());
  const { error } = await supabase
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
    .eq('user_id', user.id);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Rimozione push non riuscita');
  return c.json({ success: true });
});

export default push;
