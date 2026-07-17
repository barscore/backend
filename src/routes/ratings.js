import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import {
  createRatingSchema,
  updateRatingSchema,
  listRatingsQuerySchema,
} from '../schemas/ratingSchemas.js';

// Mounted at /bars/:id/ratings — parent :id param is available here.
const ratings = new Hono();

async function assertBarExists(barId) {
  const { data } = await supabase.from('bars').select('id').eq('id', barId).maybeSingle();
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Bar not found');
}

// Admin security switch: block new/updated ratings when disabled from the panel.
// Exported: drink votes (routes/drinks.js) respect the same kill switch.
export async function assertRatingsEnabled() {
  const { data } = await supabase
    .from('app_settings')
    .select('ratings_enabled')
    .eq('id', 1)
    .maybeSingle();
  if (data && data.ratings_enabled === false) {
    throw new AppError(503, 'RATINGS_DISABLED', 'Le valutazioni sono temporaneamente disabilitate');
  }
}

/** GET /bars/:id/ratings — paginated list. */
ratings.get('/', async (c) => {
  const barId = uuidParam(c);
  const { page, limit } = listRatingsQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await supabase
    .from('ratings')
    .select('id, prezzo, qualita_drinks, socialita, varieta, orari, commento, created_at, profiles(username, avatar_url)', {
      count: 'exact',
    })
    .eq('bar_id', barId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load ratings');
  return c.json({ ratings: data ?? [], page, limit, total: count ?? 0 });
});

/** POST /bars/:id/ratings — create own rating (one per bar). */
ratings.post('/', requireAuth, async (c) => {
  const barId = uuidParam(c);
  const user = c.get('user');
  const body = createRatingSchema.parse(await c.req.json());
  await assertRatingsEnabled();
  await assertBarExists(barId);

  const { data, error } = await supabase
    .from('ratings')
    .insert({ ...body, bar_id: barId, user_id: user.id })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505')
      throw new AppError(409, 'CONFLICT', 'You already rated this bar — use update');
    throw new AppError(500, 'INTERNAL_ERROR', 'Could not save rating');
  }
  return c.json({ rating: data }, 201);
});

/** PUT /bars/:id/ratings/:rid — update own rating. */
ratings.put('/:rid', requireAuth, async (c) => {
  const barId = uuidParam(c);
  const rid = uuidParam(c, 'rid');
  const user = c.get('user');
  const body = updateRatingSchema.parse(await c.req.json());
  await assertRatingsEnabled();

  const { data: existing } = await supabase
    .from('ratings')
    .select('id, user_id')
    .eq('id', rid)
    .eq('bar_id', barId)
    .maybeSingle();
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Rating not found');
  if (existing.user_id !== user.id)
    throw new AppError(403, 'FORBIDDEN', 'Not your rating');

  const { data, error } = await supabase
    .from('ratings')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', rid)
    .select('*')
    .single();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update rating');
  return c.json({ rating: data });
});

/** DELETE /bars/:id/ratings/:rid — delete own rating, or any rating if admin. */
ratings.delete('/:rid', requireAuth, async (c) => {
  const barId = uuidParam(c);
  const rid = uuidParam(c, 'rid');
  const user = c.get('user');

  const { data: existing } = await supabase
    .from('ratings')
    .select('id, user_id')
    .eq('id', rid)
    .eq('bar_id', barId)
    .maybeSingle();
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Rating not found');

  // Owners delete their own; admins delete any (inappropriate) rating.
  if (existing.user_id !== user.id) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.role !== 'admin')
      throw new AppError(403, 'FORBIDDEN', 'Not your rating');
  }

  const { error } = await supabase.from('ratings').delete().eq('id', rid);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete rating');
  return c.json({ success: true });
});

export default ratings;
