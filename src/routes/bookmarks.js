import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';

// Account-scoped saved bars ("Salvati"). All routes require auth; a user only
// ever sees/edits their own rows.
const bookmarks = new Hono();
bookmarks.use('*', requireAuth);

/** GET /bookmarks — the caller's saved bars (full bar objects + id list). */
bookmarks.get('/', async (c) => {
  const user = c.get('user');
  const { data, error } = await supabase
    .from('bookmarks')
    .select(
      'bar_id, created_at, bars(id, name, address, city, lat, lng, cover_image_url, bar_ratings_summary(avg_overall, total_ratings))',
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load bookmarks');

  const bars = (data ?? [])
    .filter((r) => r.bars)
    .map((r) => ({
      ...r.bars,
      avg_overall: r.bars.bar_ratings_summary?.avg_overall ?? 0,
      total_ratings: r.bars.bar_ratings_summary?.total_ratings ?? 0,
      bar_ratings_summary: undefined,
    }));

  return c.json({ bar_ids: bars.map((b) => b.id), bars });
});

/** POST /bookmarks/:barId — save a bar (idempotent). */
bookmarks.post('/:barId', async (c) => {
  const user = c.get('user');
  const barId = uuidParam(c, 'barId');

  const { error } = await supabase
    .from('bookmarks')
    .upsert({ user_id: user.id, bar_id: barId }, { onConflict: 'user_id,bar_id' });

  if (error) {
    if (error.code === '23503') throw new AppError(404, 'NOT_FOUND', 'Bar not found');
    throw new AppError(500, 'INTERNAL_ERROR', 'Could not save bookmark');
  }
  return c.json({ success: true }, 201);
});

/** DELETE /bookmarks/:barId — unsave a bar. */
bookmarks.delete('/:barId', async (c) => {
  const user = c.get('user');
  const barId = uuidParam(c, 'barId');

  const { error } = await supabase
    .from('bookmarks')
    .delete()
    .eq('user_id', user.id)
    .eq('bar_id', barId);

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not remove bookmark');
  return c.json({ success: true });
});

export default bookmarks;
