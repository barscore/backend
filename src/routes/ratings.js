import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { isPlus } from '../lib/plus.js';
import { notify } from '../lib/notify.js';
import {
  createRatingSchema,
  updateRatingSchema,
  listRatingsQuerySchema,
  replyRatingSchema,
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
    .select('id, prezzo, qualita_drinks, socialita, varieta, orari, commento, risposta, risposta_at, created_at, profiles(username, avatar_url, plus_until, is_explorer)', {
      count: 'exact',
    })
    .eq('bar_id', barId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load ratings');
  // Derive the rabar+ badge here and drop the expiry: the review list is public.
  const ratingsOut = (data ?? []).map((r) => ({
    ...r,
    profiles: r.profiles
      ? { username: r.profiles.username, avatar_url: r.profiles.avatar_url, plus: isPlus(r.profiles), is_explorer: r.profiles.is_explorer }
      : null,
  }));
  return c.json({ ratings: ratingsOut, page, limit, total: count ?? 0 });
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
  // Il ruolo è già su context: requireAuth tocca comunque `profiles` per il
  // controllo del ban e lo lascia lì apposta (middleware/auth.js:40), quindi
  // rileggerlo qui era un secondo giro al database per lo stesso dato.
  if (existing.user_id !== user.id && user.role !== 'admin') {
    throw new AppError(403, 'FORBIDDEN', 'Not your rating');
  }

  const { error } = await supabase.from('ratings').delete().eq('id', rid);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete rating');

  // Se è l'utente stesso che elimina la recensione (o un admin per conto suo)
  // verifichiamo se scende sotto le 5 recensioni e in tal caso revochiamo il token.
  const { data: profile } = await supabase
    .from('profiles')
    .select('is_explorer, plus_until, free_drink_token')
    .eq('id', existing.user_id)
    .maybeSingle();

  if (profile?.is_explorer && profile?.free_drink_token) {
    const isPlus = profile.plus_until && new Date(profile.plus_until) > new Date();
    if (!isPlus) {
      const { count } = await supabase
        .from('ratings')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', existing.user_id);
        
      if ((count ?? 0) < 5) {
        await supabase
          .from('profiles')
          .update({ free_drink_token: null })
          .eq('id', existing.user_id);
      }
    }
  }

  return c.json({ success: true });
});

/**
 * Risposta del proprietario a una recensione.
 *
 * Una recensione ha al massimo una risposta e a scriverla è sempre lo stesso
 * soggetto (`bars.owner_id`), quindi vive come colonna sulla riga: niente
 * tabella a parte. Admin e moderatori possono solo rimuoverla (moderazione).
 */
async function loadReplyTarget(barId, rid) {
  const { data: bar } = await supabase
    .from('bars')
    .select('id, name, owner_id')
    .eq('id', barId)
    .maybeSingle();
  if (!bar) throw new AppError(404, 'NOT_FOUND', 'Bar non trovato');

  const { data: rating } = await supabase
    .from('ratings')
    .select('id, user_id')
    .eq('id', rid)
    .eq('bar_id', barId)
    .maybeSingle();
  if (!rating) throw new AppError(404, 'NOT_FOUND', 'Rating not found');

  return { bar, rating };
}

/** PUT /bars/:id/ratings/:rid/reply — scrive o sostituisce la risposta. */
ratings.put('/:rid/reply', requireAuth, async (c) => {
  const barId = uuidParam(c);
  const rid = uuidParam(c, 'rid');
  const user = c.get('user');
  const { risposta } = replyRatingSchema.parse(await c.req.json());
  await assertRatingsEnabled();

  const { bar, rating } = await loadReplyTarget(barId, rid);
  if (bar.owner_id !== user.id) {
    throw new AppError(403, 'FORBIDDEN', 'Solo il proprietario del bar può rispondere');
  }

  const { data, error } = await supabase
    .from('ratings')
    .update({ risposta, risposta_at: new Date().toISOString() })
    .eq('id', rid)
    .select('id, risposta, risposta_at')
    .single();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not save reply');

  // Best-effort: una notifica mancata non deve far fallire la risposta.
  if (rating.user_id !== user.id) {
    await notify([rating.user_id], {
      type: 'rating_reply',
      title: `${bar.name} ha risposto alla tua recensione`,
      body: risposta.slice(0, 500),
      link: `/bar/${barId}`,
    });
  }

  return c.json({ rating: data });
});

/** DELETE /bars/:id/ratings/:rid/reply — proprietario o staff. */
ratings.delete('/:rid/reply', requireAuth, async (c) => {
  const barId = uuidParam(c);
  const rid = uuidParam(c, 'rid');
  const user = c.get('user');

  const { bar } = await loadReplyTarget(barId, rid);
  const isStaff = user.role === 'admin' || user.role === 'moderator';
  if (bar.owner_id !== user.id && !isStaff) {
    throw new AppError(403, 'FORBIDDEN', 'Solo il proprietario del bar può rispondere');
  }

  const { error } = await supabase
    .from('ratings')
    .update({ risposta: null, risposta_at: null })
    .eq('id', rid);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete reply');
  return c.json({ success: true });
});

export default ratings;
