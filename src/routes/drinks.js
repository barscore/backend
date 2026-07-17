import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole, optionalUser } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { assertRatingsEnabled } from './ratings.js';
import {
  listDrinksQuerySchema,
  listTopQuerySchema,
  createDrinkVoteSchema,
  createDrinkSuggestionSchema,
  listDrinkSuggestionsQuerySchema,
  updateDrinkSuggestionSchema,
} from '../schemas/drinkSchemas.js';

// Drinks catalog + per-bar votes + moderated proposals. The catalog is
// public read; votes need auth; proposals mirror the bar-suggestions flow
// (public create, staff moderation, drink materialized on approval).
const drinks = new Hono();

// Escape LIKE wildcards in user input so "%" / "_" match literally.
const escapeLike = (s) => s.replace(/[%_]/g, '\\$&');

// ---------------------------------------------------------------------------
// Moderation sub-router. Mounted before any /:id route so the static
// "suggestions" segment is never captured by the :id param.
// ---------------------------------------------------------------------------
const suggestions = new Hono();

/**
 * POST /drinks/suggestions — propose a missing drink. Public, strictly
 * rate-limited (spam guard). The drink appears in the catalog only after
 * staff approval.
 */
suggestions.post('/', rateLimiter({ windowMs: 60_000, max: 5 }), async (c) => {
  const body = createDrinkSuggestionSchema.parse(await c.req.json());
  const userId = await optionalUser(c);

  // Friendly early 409 when the drink is already in the catalog (the unique
  // index on lower(trim(name)) is the real guard, enforced at approval time).
  const { data: existing } = await supabase
    .from('drinks')
    .select('id')
    .ilike('name', escapeLike(body.name))
    .maybeSingle();
  if (existing) throw new AppError(409, 'CONFLICT', 'Drink già in catalogo');

  const { data, error } = await supabase
    .from('drink_suggestions')
    .insert({ name: body.name, note: body.note ?? null, created_by: userId })
    .select('id')
    .single();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Proposta non riuscita');
  return c.json({ suggestion: data }, 201);
});

// Everything below is staff-only.
suggestions.use('*', requireAuth, requireRole('admin', 'moderator'));

/** GET /drinks/suggestions — moderation list, newest first. */
suggestions.get('/', async (c) => {
  const { q, status, page, limit } = listDrinkSuggestionsQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('drink_suggestions')
    .select('id, name, note, status, created_by, created_at', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status) query = query.eq('status', status);
  if (q) query = query.ilike('name', `%${escapeLike(q)}%`);

  const { data, error, count } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load suggestions');
  return c.json({ suggestions: data ?? [], page, limit, total: count ?? 0 });
});

/**
 * PATCH /drinks/suggestions/:id — set moderation status. Approval
 * (status=done) materializes the drink into the catalog first; a duplicate
 * name (23505 on the normalized unique index) counts as already-approved
 * and the status change still goes through.
 */
suggestions.patch('/:id', async (c) => {
  const id = uuidParam(c);
  const { status } = updateDrinkSuggestionSchema.parse(await c.req.json());

  const { data: sugg, error: loadErr } = await supabase
    .from('drink_suggestions')
    .select('id, name, note, created_by')
    .eq('id', id)
    .maybeSingle();
  if (loadErr) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load suggestion');
  if (!sugg) throw new AppError(404, 'NOT_FOUND', 'Proposta non trovata');

  let drink = null;
  if (status === 'done') {
    const { data: created, error: insErr } = await supabase
      .from('drinks')
      .insert({ name: sugg.name, description: sugg.note ?? null, created_by: sugg.created_by })
      .select('id, name')
      .single();
    if (insErr && insErr.code !== '23505')
      throw new AppError(500, 'INTERNAL_ERROR', 'Could not create drink');
    drink = created ?? null;
  }

  const { data, error } = await supabase
    .from('drink_suggestions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, status')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update suggestion');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Proposta non trovata');
  return c.json({ suggestion: data, drink });
});

/** DELETE /drinks/suggestions/:id — drop a handled/spam proposal. */
suggestions.delete('/:id', async (c) => {
  const id = uuidParam(c);
  const { data, error } = await supabase
    .from('drink_suggestions')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete suggestion');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Proposta non trovata');
  return c.json({ success: true });
});

drinks.route('/suggestions', suggestions);

// ---------------------------------------------------------------------------
// Catalog + votes
// ---------------------------------------------------------------------------

/**
 * GET /drinks — catalog list with the drinks-only search (q). Each drink
 * embeds its single best bar (highest avg) as a preview for the list rows.
 */
drinks.get('/', async (c) => {
  const { q, page, limit } = listDrinksQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('drinks')
    .select(
      'id, name, description, drink_bar_summary(avg_rating, total_ratings, bars(id, name, city))',
      { count: 'exact' },
    )
    .order('name')
    .order('avg_rating', { referencedTable: 'drink_bar_summary', ascending: false })
    .limit(1, { referencedTable: 'drink_bar_summary' })
    .range(from, to);

  if (q) query = query.ilike('name', `%${escapeLike(q)}%`);

  const { data, error, count } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load drinks');

  // Flatten the one-element embed into a `best` preview field.
  const flattened = (data ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    best: d.drink_bar_summary?.[0] ?? null,
  }));
  return c.json({ drinks: flattened, page, limit, total: count ?? 0 });
});

/** GET /drinks/:id — single drink. */
drinks.get('/:id', async (c) => {
  const id = uuidParam(c);
  const { data, error } = await supabase
    .from('drinks')
    .select('id, name, description, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load drink');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Drink non trovato');
  return c.json({ drink: data });
});

// With user coords the drink ranking only shows bars within this radius.
const RANKING_RADIUS_KM = 30;

/**
 * GET /drinks/:id/bars — ranking: the bars that make this drink best.
 * With lat/lng the list is restricted to bars within RANKING_RADIUS_KM
 * via the get_drink_top_bars PostGIS RPC (adds distance_km per bar);
 * without coords it's a plain ORDER BY on the trigger-maintained summary.
 * !inner / the RPC keep deactivated bars out.
 */
drinks.get('/:id/bars', async (c) => {
  const id = uuidParam(c);
  const { page, limit, lat, lng } = listTopQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  if (lat !== undefined && lng !== undefined) {
    const { data, error } = await supabase.rpc('get_drink_top_bars', {
      target_drink_id: id,
      user_lat: lat,
      user_lng: lng,
      radius_km: RANKING_RADIUS_KM,
      page_limit: limit,
      page_offset: from,
    });
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load ranking');

    const bars = (data ?? []).map(({ total_count, ...bar }) => bar);
    return c.json({
      bars,
      page,
      limit,
      total: Number(data?.[0]?.total_count ?? 0),
      radius_km: RANKING_RADIUS_KM,
    });
  }

  const { data, error, count } = await supabase
    .from('drink_bar_summary')
    .select(
      'avg_rating, total_ratings, bars!inner(id, name, address, city, lat, lng, cover_image_url)',
      { count: 'exact' },
    )
    .eq('drink_id', id)
    .eq('bars.is_active', true)
    .gt('total_ratings', 0)
    .order('avg_rating', { ascending: false })
    .order('total_ratings', { ascending: false })
    .range(from, to);

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load ranking');

  const flattened = (data ?? []).map((row) => ({
    ...row.bars,
    avg_rating: row.avg_rating,
    total_ratings: row.total_ratings,
  }));
  return c.json({ bars: flattened, page, limit, total: count ?? 0 });
});

/**
 * POST /drinks/:id/votes — cast/update own 1-5 vote for this drink at a bar.
 * Upserted on the (drink, bar, user) unique key: one call serves both create
 * and edit (no rating-id lifecycle like bar ratings).
 */
drinks.post('/:id/votes', requireAuth, async (c) => {
  const drinkId = uuidParam(c);
  const user = c.get('user');
  const { bar_id, rating } = createDrinkVoteSchema.parse(await c.req.json());
  await assertRatingsEnabled();

  const { data: drink } = await supabase
    .from('drinks').select('id').eq('id', drinkId).maybeSingle();
  if (!drink) throw new AppError(404, 'NOT_FOUND', 'Drink non trovato');
  const { data: bar } = await supabase
    .from('bars').select('id').eq('id', bar_id).maybeSingle();
  if (!bar) throw new AppError(404, 'NOT_FOUND', 'Bar not found');

  const { data, error } = await supabase
    .from('drink_ratings')
    .upsert(
      {
        drink_id: drinkId,
        bar_id,
        user_id: user.id,
        rating,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'drink_id,bar_id,user_id' },
    )
    .select('id, drink_id, bar_id, rating')
    .single();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not save vote');
  return c.json({ vote: data }, 201);
});

/** DELETE /drinks/:id/votes/:barId — remove own vote for this (drink, bar). */
drinks.delete('/:id/votes/:barId', requireAuth, async (c) => {
  const drinkId = uuidParam(c);
  const barId = uuidParam(c, 'barId');
  const user = c.get('user');

  const { data, error } = await supabase
    .from('drink_ratings')
    .delete()
    .match({ drink_id: drinkId, bar_id: barId, user_id: user.id })
    .select('id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete vote');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Voto non trovato');
  return c.json({ success: true });
});

export default drinks;
