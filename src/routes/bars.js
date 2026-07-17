import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  nearbyQuerySchema,
  createBarSchema,
  updateBarSchema,
  resolveBarSchema,
  sanitizeHttpUrl,
} from '../schemas/barSchemas.js';
import { listTopQuerySchema } from '../schemas/drinkSchemas.js';
import { createClaimSchema } from '../schemas/organizerSchemas.js';
import { fetchElement } from '../lib/osm.js';
import ratings from './ratings.js';

const bars = new Hono();

const BAR_DETAIL_SELECT = '*, bar_ratings_summary(*), bar_images(id, url, source)';

// Nested ratings routes: /bars/:id/ratings...
bars.route('/:id/ratings', ratings);

/** GET /bars/:id/drinks — the best drinks at this bar (trigger-maintained summary). */
bars.get('/:id/drinks', async (c) => {
  const barId = uuidParam(c);
  const { page, limit } = listTopQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const { data, error, count } = await supabase
    .from('drink_bar_summary')
    .select('avg_rating, total_ratings, drinks(id, name, description)', { count: 'exact' })
    .eq('bar_id', barId)
    .gt('total_ratings', 0)
    .order('avg_rating', { ascending: false })
    .order('total_ratings', { ascending: false })
    .range(from, to);

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load bar drinks');

  const flattened = (data ?? []).map((row) => ({
    ...row.drinks,
    avg_rating: row.avg_rating,
    total_ratings: row.total_ratings,
  }));
  return c.json({ drinks: flattened, page, limit, total: count ?? 0 });
});

/**
 * POST /bars/resolve — find-or-create a bar from an OpenStreetMap place.
 * Bars shown on the map come straight from Overpass and may not be persisted
 * yet; the first time anyone opens/rates one, we materialize it here (keyed by
 * osm_node_id) so ratings have a stable bar to attach to. Public: viewing an
 * unrated OSM bar must work without auth, so instead of requireAuth it gets a
 * strict per-IP limit — browsing stays smooth, anonymous mass-creation of rows
 * doesn't (the global limiter alone would allow 120/min).
 */
bars.post('/resolve', rateLimiter({ windowMs: 60_000, max: 30 }), async (c) => {
  const body = resolveBarSchema.parse(await c.req.json());

  // Already persisted? Return it with full detail.
  const { data: existing, error: findErr } = await supabase
    .from('bars')
    .select(BAR_DETAIL_SELECT)
    .eq('osm_node_id', body.osm_node_id)
    .maybeSingle();
  if (findErr) throw new AppError(500, 'INTERNAL_ERROR', 'Could not resolve bar');
  if (existing) return c.json({ bar: existing });

  // Backfill any missing fields from Overpass when the client only sent an id.
  let info = body;
  if (!body.name || body.lat == null || body.lng == null) {
    const el = await fetchElement(body.osm_type, body.osm_node_id);
    if (!el) throw new AppError(404, 'NOT_FOUND', 'OSM place not found');
    info = { ...el, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v != null)) };
  }
  if (info.lat == null || info.lng == null)
    throw new AppError(422, 'VALIDATION_ERROR', 'Missing coordinates for bar');

  const insert = {
    name: (info.name || 'Senza nome').slice(0, 100),
    address: info.address || 'Indirizzo non disponibile',
    city: info.city || 'N/D',
    lat: info.lat,
    lng: info.lng,
    osm_node_id: body.osm_node_id,
    phone: info.phone || null,
    // Sanitized at the insert so both sources (client body and Overpass
    // backfill) are covered: only well-formed http(s) URLs are stored, anything
    // else (javascript:, data:, malformed OSM tags) is dropped.
    website: sanitizeHttpUrl(info.website),
    cover_image_url: sanitizeHttpUrl(info.cover_image_url),
  };

  const { data, error } = await supabase
    .from('bars')
    .insert(insert)
    .select(BAR_DETAIL_SELECT)
    .single();

  if (error) {
    // Lost a create race — fetch the row the other request just inserted.
    if (error.code === '23505') {
      const { data: again } = await supabase
        .from('bars')
        .select(BAR_DETAIL_SELECT)
        .eq('osm_node_id', body.osm_node_id)
        .maybeSingle();
      if (again) return c.json({ bar: again });
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Could not resolve bar');
  }
  return c.json({ bar: data }, 201);
});

/** GET /bars — list bars, optionally filtered by proximity. */
bars.get('/', async (c) => {
  const { lat, lng, radius_km } = nearbyQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );

  // Geo filter via PostGIS helper when coords given, else plain list.
  if (lat !== undefined && lng !== undefined) {
    const { data, error } = await supabase.rpc('get_nearby_bars', {
      user_lat: lat,
      user_lng: lng,
      radius_km,
    });
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Nearby query failed');
    return c.json({ bars: data ?? [] });
  }

  const { data, error } = await supabase
    .from('bars')
    .select(
      'id, name, address, city, lat, lng, cover_image_url, boost_until, bar_ratings_summary(avg_overall, total_ratings)',
    )
    .eq('is_active', true)
    .limit(500);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load bars');

  const now = Date.now();
  const flattened = (data ?? []).map((b) => ({
    ...b,
    avg_overall: b.bar_ratings_summary?.avg_overall ?? 0,
    total_ratings: b.bar_ratings_summary?.total_ratings ?? 0,
    sponsored: !!b.boost_until && new Date(b.boost_until).getTime() > now,
    boost_until: undefined,
    bar_ratings_summary: undefined,
  }));
  // Stable sort: sponsored first, previous order kept within each group.
  flattened.sort((a, b) => b.sponsored - a.sponsored);
  return c.json({ bars: flattened });
});

/** GET /bars/:id — full detail incl. summary + images. */
bars.get('/:id', async (c) => {
  const id = uuidParam(c);
  const { data, error } = await supabase
    .from('bars')
    .select(
      '*, bar_ratings_summary(*), bar_images(id, url, source)',
    )
    .eq('id', id)
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load bar');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Bar not found');
  return c.json({
    bar: {
      ...data,
      sponsored: !!data.boost_until && new Date(data.boost_until) > new Date(),
    },
  });
});

/** POST /bars/:id/claim — an organizer claims ownership of a bar. */
bars.post(
  '/:id/claim',
  requireAuth,
  requireRole('organizer'),
  rateLimiter({ windowMs: 60_000, max: 5 }),
  async (c) => {
    const barId = uuidParam(c);
    const { proof } = createClaimSchema.parse(await c.req.json());
    const user = c.get('user');

    const { data: bar, error: barErr } = await supabase
      .from('bars')
      .select('id, owner_id')
      .eq('id', barId)
      .maybeSingle();
    if (barErr) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load bar');
    if (!bar) throw new AppError(404, 'NOT_FOUND', 'Bar non trovato');
    if (bar.owner_id) throw new AppError(409, 'CONFLICT', 'Questo bar ha già un proprietario');

    const { data, error } = await supabase
      .from('bar_claims')
      .insert({ user_id: user.id, bar_id: barId, proof })
      .select('id, status, created_at')
      .single();
    if (error?.code === '23505') {
      throw new AppError(409, 'CONFLICT', 'Hai già una richiesta in attesa per questo bar');
    }
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Invio richiesta non riuscito');
    return c.json({ claim: data }, 201);
  },
);

/** POST /bars — create (admin/moderator only). */
bars.post('/', requireAuth, requireRole('admin', 'moderator'), async (c) => {
  const body = createBarSchema.parse(await c.req.json());
  const user = c.get('user');

  const { data, error } = await supabase
    .from('bars')
    .insert({ ...body, created_by: user.id })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505')
      throw new AppError(409, 'CONFLICT', 'Bar with this place id already exists');
    throw new AppError(500, 'INTERNAL_ERROR', 'Could not create bar');
  }
  return c.json({ bar: data }, 201);
});

/** PUT /bars/:id — update (admin/moderator only). */
bars.put('/:id', requireAuth, requireRole('admin', 'moderator'), async (c) => {
  const id = uuidParam(c);
  const body = updateBarSchema.parse(await c.req.json());

  const { data, error } = await supabase
    .from('bars')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update bar');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Bar not found');
  return c.json({ bar: data });
});

/** DELETE /bars/:id — delete (admin only). */
bars.delete('/:id', requireAuth, requireRole('admin'), async (c) => {
  const id = uuidParam(c);
  const { data, error } = await supabase
    .from('bars')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete bar');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Bar not found');
  return c.json({ success: true });
});

export default bars;
