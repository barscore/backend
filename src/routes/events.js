import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { notify } from '../lib/notify.js';
import {
  nearbyEventsQuerySchema,
  createEventSchema,
  updateEventSchema,
} from '../schemas/eventSchemas.js';

const events = new Hono();

/**
 * GET /events — upcoming events in a zone, soonest first.
 * With lat/lng: PostGIS `get_nearby_events` (distance + radius filter).
 * Without coords: all upcoming events (up to 500), still ordered by start.
 */
events.get('/', async (c) => {
  const { lat, lng, radius_km } = nearbyEventsQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );

  if (lat !== undefined && lng !== undefined) {
    const { data, error } = await supabase.rpc('get_nearby_events', {
      user_lat: lat,
      user_lng: lng,
      radius_km,
    });
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Nearby events query failed');
    return c.json({ events: data ?? [] });
  }

  const { data, error } = await supabase
    .from('events')
    .select(
      'id, bar_id, title, description, lat, lng, starts_at, ends_at, boost_until, created_by, bars(name), profiles!events_created_by_fkey(username, role)',
    )
    .is('cancelled_at', null)
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(500);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load events');

  const now = Date.now();
  const flattened = (data ?? []).map((e) => ({
    id: e.id,
    bar_id: e.bar_id,
    title: e.title,
    description: e.description,
    lat: e.lat,
    lng: e.lng,
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    bar_name: e.bars?.name ?? null,
    organizer_id: e.profiles?.role === 'organizer' ? e.created_by : null,
    organizer_username: e.profiles?.role === 'organizer' ? e.profiles.username : null,
    sponsored: !!e.boost_until && new Date(e.boost_until).getTime() > now,
  }));
  // Stable sort: sponsored first, starts_at order preserved within each group.
  flattened.sort((a, b) => b.sponsored - a.sponsored);
  return c.json({ events: flattened });
});

/**
 * POST /events — create (organizer/admin/moderator). When `bar_id` is given,
 * lat/lng are backfilled from that bar.
 */
events.post('/', requireAuth, requireRole('organizer', 'admin', 'moderator'), async (c) => {
  const body = createEventSchema.parse(await c.req.json());
  const user = c.get('user');

  let { lat, lng } = body;
  if (body.bar_id) {
    const { data: bar, error: barErr } = await supabase
      .from('bars')
      .select('lat, lng')
      .eq('id', body.bar_id)
      .maybeSingle();
    if (barErr) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load bar');
    if (!bar) throw new AppError(404, 'NOT_FOUND', 'Bar not found');
    if (lat == null || lng == null) {
      lat = bar.lat;
      lng = bar.lng;
    }
  }

  const { data, error } = await supabase
    .from('events')
    .insert({
      bar_id: body.bar_id ?? null,
      title: body.title,
      description: body.description ?? null,
      lat,
      lng,
      starts_at: body.starts_at,
      ends_at: body.ends_at ?? null,
      created_by: user.id,
    })
    .select('*')
    .single();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not create event');

  // Followers of the organizer get a "new event" ping (staff events skip it).
  if (user.role === 'organizer') {
    const { data: fans } = await supabase
      .from('follows')
      .select('user_id')
      .eq('organizer_id', user.id);
    await notify(
      (fans ?? []).map((f) => f.user_id).filter((id) => id !== user.id),
      {
        type: 'new_event',
        title: `Nuovo evento: ${data.title}`,
        body: 'Un organizzatore che segui ha pubblicato un nuovo evento.',
        link: '/?tab=eventi',
      },
    );
  }
  return c.json({ event: data }, 201);
});

/** PUT /events/:id — organizers only on their own events; staff on any. */
events.put('/:id', requireAuth, requireRole('organizer', 'admin', 'moderator'), async (c) => {
  const id = uuidParam(c);
  const body = updateEventSchema.parse(await c.req.json());
  const user = c.get('user');

  const { data: existing } = await supabase
    .from('events')
    .select('id, created_by, cancelled_at')
    .eq('id', id)
    .maybeSingle();
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Event not found');
  if (user.role === 'organizer' && existing.created_by !== user.id) {
    throw new AppError(403, 'FORBIDDEN', 'Puoi modificare solo i tuoi eventi');
  }
  if (existing.cancelled_at) throw new AppError(409, 'CONFLICT', 'Evento annullato');

  const { data, error } = await supabase
    .from('events')
    .update({ ...body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update event');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Event not found');

  const { data: fans } = await supabase.from('follows').select('user_id').eq('event_id', id);
  await notify(
    (fans ?? []).map((f) => f.user_id).filter((uid) => uid !== user.id),
    {
      type: 'event_updated',
      title: `Evento aggiornato: ${data.title}`,
      body: 'Un evento che segui è stato modificato — ricontrolla data e luogo.',
      link: '/?tab=eventi',
    },
  );
  return c.json({ event: data });
});

/**
 * DELETE /events/:id — for organizers this is a CANCELLATION (row stays,
 * followers get notified, lists hide it via cancelled_at). Staff hard-delete.
 */
events.delete('/:id', requireAuth, requireRole('organizer', 'admin', 'moderator'), async (c) => {
  const id = uuidParam(c);
  const user = c.get('user');

  if (user.role === 'organizer') {
    const { data, error } = await supabase
      .from('events')
      .update({ cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('created_by', user.id)
      .is('cancelled_at', null)
      .select('id, title')
      .maybeSingle();
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not cancel event');
    if (!data) throw new AppError(404, 'NOT_FOUND', 'Event not found');

    const { data: fans } = await supabase.from('follows').select('user_id').eq('event_id', id);
    await notify(
      (fans ?? []).map((f) => f.user_id).filter((uid) => uid !== user.id),
      {
        type: 'event_cancelled',
        title: `Evento annullato: ${data.title}`,
        body: 'Un evento che segui è stato annullato.',
        link: '/?tab=eventi',
      },
    );
    return c.json({ success: true, cancelled: true });
  }

  const { data, error } = await supabase
    .from('events')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete event');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Event not found');
  return c.json({ success: true });
});

export default events;
