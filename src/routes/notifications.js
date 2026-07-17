import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  listNotificationsQuerySchema,
  markReadSchema,
} from '../schemas/notificationSchemas.js';

// In-app notification inbox. Rows are created by lib/notify.js fan-outs.
const notifications = new Hono();
notifications.use('*', requireAuth);

/** GET /notifications — caller's inbox, newest first, + unread count. */
notifications.get('/', async (c) => {
  const user = c.get('user');
  const { page, limit } = listNotificationsQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;

  const [list, unreadCount] = await Promise.all([
    supabase
      .from('notifications')
      .select('id, type, title, body, link, read, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1),
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('read', false),
  ]);
  if (list.error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load notifications');
  return c.json({
    notifications: list.data ?? [],
    unread: unreadCount.count ?? 0,
    page,
    limit,
  });
});

/** POST /notifications/read — mark all ({all:true}) or a batch ({ids}) read. */
notifications.post('/read', async (c) => {
  const user = c.get('user');
  const body = markReadSchema.parse(await c.req.json());

  let query = supabase.from('notifications').update({ read: true }).eq('user_id', user.id);
  if ('ids' in body) query = query.in('id', body.ids);
  const { error } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update notifications');
  return c.json({ success: true });
});

export default notifications;
