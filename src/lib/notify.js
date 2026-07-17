import webpush from 'web-push';
import { supabase } from './supabase.js';

// Web Push is optional: without VAPID keys the app still works, notifications
// stay in-app only.
const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (vapidReady) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@rabar.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

// Deliver a payload to every push subscription of the given users. Dead
// endpoints (404/410 from the push service) are pruned as we go.
async function sendPush(userIds, payload) {
  if (!vapidReady) return;
  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('user_id', userIds);
  if (!subs?.length) return;

  const body = JSON.stringify(payload);
  await Promise.allSettled(
    subs.map((s) =>
      webpush
        .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body)
        .catch(async (err) => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await supabase.from('push_subscriptions').delete().eq('id', s.id);
          }
        }),
    ),
  );
}

// Fan-out a notification to a set of users: one `notifications` row each,
// plus Web Push delivery. Best-effort by design: a failed notification must
// never fail the write that triggered it.
export async function notify(userIds, { type, title, body = null, link = null }) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return;

  const rows = ids.map((user_id) => ({ user_id, type, title, body, link }));
  const { error } = await supabase.from('notifications').insert(rows);
  if (error) console.error('[notify] insert failed:', error.message);

  // Fire-and-forget: push latency must not slow the calling request.
  sendPush(ids, { title, body, link }).catch((e) =>
    console.error('[notify] push failed:', e.message),
  );
}
