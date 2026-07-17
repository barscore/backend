import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { myDrinkVotesQuerySchema } from '../schemas/drinkSchemas.js';
import { createOrganizerRequestSchema } from '../schemas/organizerSchemas.js';

// Account-scoped self routes. All require auth; a user only ever reads their own
// profile and ratings. Credential changes go through supabase-js on the frontend.
const me = new Hono();
me.use('*', requireAuth);

/** GET /me — the caller's account details (profile + email + rating count). */
me.get('/', async (c) => {
  const user = c.get('user');

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, created_at')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load profile');
  if (!profile) throw new AppError(404, 'NOT_FOUND', 'Profile not found');

  const { count } = await supabase
    .from('ratings')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);

  // Each rating earns 10 ice cubes (accumulating points), derived from the
  // rating count — never stored, so it can't drift.
  const ratingsCount = count ?? 0;
  return c.json({
    profile: {
      ...profile,
      email: user.email,
      ratings_count: ratingsCount,
      ice_cubes: ratingsCount * 10,
    },
  });
});

/** GET /me/ratings — the caller's own ratings, with the rated bar attached. */
me.get('/ratings', async (c) => {
  const user = c.get('user');

  const { data, error } = await supabase
    .from('ratings')
    .select(
      'id, bar_id, prezzo, qualita_drinks, socialita, varieta, orari, commento, created_at, updated_at, bars(id, name, address, city)',
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load ratings');
  return c.json({ ratings: data ?? [] });
});

/** GET /me/drink-votes — the caller's drink votes (optionally filtered by drink/bar). */
me.get('/drink-votes', async (c) => {
  const user = c.get('user');
  const { drink_id, bar_id } = myDrinkVotesQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );

  let query = supabase
    .from('drink_ratings')
    .select('drink_id, bar_id, rating')
    .eq('user_id', user.id);
  if (drink_id) query = query.eq('drink_id', drink_id);
  if (bar_id) query = query.eq('bar_id', bar_id);

  const { data, error } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load votes');
  return c.json({ votes: data ?? [] });
});

/** GET /me/organizer-request — latest upgrade request (or null). */
me.get('/organizer-request', async (c) => {
  const user = c.get('user');
  const { data, error } = await supabase
    .from('organizer_requests')
    .select('id, requested_type, status, admin_note, created_at, reviewed_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load request');
  return c.json({ request: data ?? null });
});

/** POST /me/organizer-request — the 3-question upgrade form. */
me.post('/organizer-request', rateLimiter({ windowMs: 60_000, max: 5 }), async (c) => {
  const user = c.get('user');
  if (user.role === 'organizer') {
    throw new AppError(409, 'CONFLICT', 'Sei già un organizzatore');
  }
  const body = createOrganizerRequestSchema.parse(await c.req.json());

  const { data, error } = await supabase
    .from('organizer_requests')
    .insert({
      user_id: user.id,
      requested_type: body.requested_type,
      proof: body.proof,
      channels: body.channels,
      channels_other: body.channels_other ?? null,
      collaborations: body.collaborations,
    })
    .select('id, requested_type, status, created_at')
    .single();
  // 23505 = the partial unique index: one pending request per user.
  if (error?.code === '23505') {
    throw new AppError(409, 'CONFLICT', 'Hai già una richiesta in attesa');
  }
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Invio richiesta non riuscito');
  return c.json({ request: data }, 201);
});

/** GET /me/claims — the caller's bar ownership claims. */
me.get('/claims', async (c) => {
  const user = c.get('user');
  const { data, error } = await supabase
    .from('bar_claims')
    .select('id, bar_id, status, admin_note, created_at, bars(name)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load claims');
  return c.json({
    claims: (data ?? []).map((cl) => ({
      ...cl,
      bar_name: cl.bars?.name ?? null,
      bars: undefined,
    })),
  });
});

/** GET /me/follows — followed targets, for the UI toggle state. */
me.get('/follows', async (c) => {
  const user = c.get('user');
  const { data, error } = await supabase
    .from('follows')
    .select('event_id, organizer_id')
    .eq('user_id', user.id);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load follows');
  return c.json({ follows: data ?? [] });
});

/** GET /me/events — the organizer's own events (cancelled/past included). */
me.get('/events', async (c) => {
  const user = c.get('user');
  const { data, error } = await supabase
    .from('events')
    .select(
      'id, bar_id, title, description, lat, lng, starts_at, ends_at, cancelled_at, boost_until, bars(name)',
    )
    .eq('created_by', user.id)
    .order('starts_at', { ascending: false })
    .limit(100);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load events');
  const now = Date.now();
  return c.json({
    events: (data ?? []).map((e) => ({
      ...e,
      bar_name: e.bars?.name ?? null,
      sponsored: !!e.boost_until && new Date(e.boost_until).getTime() > now,
      bars: undefined,
    })),
  });
});

/** DELETE /me — the caller erases their own account (GDPR art. 17). Deleting the
 *  auth user cascades to profiles + ratings + votes (ON DELETE CASCADE). */
me.delete('/', async (c) => {
  const user = c.get('user');
  const { error } = await supabase.auth.admin.deleteUser(user.id);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Eliminazione account fallita');
  return c.json({ success: true });
});

export default me;
