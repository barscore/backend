import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { followTargetSchema } from '../schemas/followSchemas.js';

// Follow an event or an organizer. Both verbs are idempotent so the UI can
// toggle optimistically without races.
const follows = new Hono();
follows.use('*', requireAuth);

/** PUT /follows — follow. Body: { event_id } XOR { organizer_id }. */
follows.put('/', async (c) => {
  const user = c.get('user');
  const target = followTargetSchema.parse(await c.req.json());

  if (target.organizer_id) {
    const { data: org } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', target.organizer_id)
      .maybeSingle();
    if (org?.role !== 'organizer') throw new AppError(404, 'NOT_FOUND', 'Organizzatore non trovato');
  } else {
    const { data: ev } = await supabase
      .from('events')
      .select('id, cancelled_at')
      .eq('id', target.event_id)
      .maybeSingle();
    if (!ev || ev.cancelled_at) throw new AppError(404, 'NOT_FOUND', 'Evento non trovato');
  }

  const { error } = await supabase.from('follows').upsert(
    { user_id: user.id, event_id: target.event_id ?? null, organizer_id: target.organizer_id ?? null },
    {
      onConflict: target.event_id ? 'user_id,event_id' : 'user_id,organizer_id',
      ignoreDuplicates: true,
    },
  );
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Follow non riuscito');
  return c.json({ success: true });
});

/** DELETE /follows — unfollow. Same body. */
follows.delete('/', async (c) => {
  const user = c.get('user');
  const target = followTargetSchema.parse(await c.req.json());

  let query = supabase.from('follows').delete().eq('user_id', user.id);
  query = target.event_id
    ? query.eq('event_id', target.event_id)
    : query.eq('organizer_id', target.organizer_id);
  const { error } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Unfollow non riuscito');
  return c.json({ success: true });
});

export default follows;
