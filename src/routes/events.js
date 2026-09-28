import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole, optionalUser } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { z } from 'zod';
import { AppError } from '../middleware/errorHandler.js';
import { sharedRateLimiter } from '../middleware/rateLimiter.js';
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
      'id, bar_id, title, description, lat, lng, starts_at, ends_at, boost_until, created_by, has_presales, photo_url, free_drink, bars(name), profiles!events_created_by_fkey(username, role)',
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
    has_presales: e.has_presales,
    photo_url: e.photo_url,
    free_drink: e.free_drink,
    bar_name: e.bars?.name ?? null,
    organizer_id: e.profiles?.role === 'organizer' ? e.created_by : null,
    organizer_username: e.profiles?.role === 'organizer' ? e.profiles.username : null,
    sponsored: !!e.boost_until && new Date(e.boost_until).getTime() > now,
  }));
  // Stable sort: sponsored first, starts_at order preserved within each group.
  flattened.sort((a, b) => b.sponsored - a.sponsored);
  return c.json({ events: flattened });
});

/** GET /events/:id — fetch a single event by ID. */
events.get('/:id', async (c) => {
  const id = uuidParam(c);
  const { data, error } = await supabase
    .from('events')
    .select(
      'id, bar_id, title, description, lat, lng, starts_at, ends_at, boost_until, created_by, has_presales, photo_url, free_drink, bars(name), profiles!events_created_by_fkey(username, role)',
    )
    .eq('id', id)
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load event');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Event not found');

  const now = Date.now();
  const event = {
    ...data,
    bar_name: data.bars?.name ?? null,
    organizer_id: data.profiles?.role === 'organizer' ? data.created_by : null,
    organizer_username: data.profiles?.role === 'organizer' ? data.profiles.username : null,
    sponsored: !!data.boost_until && new Date(data.boost_until).getTime() > now,
  };
  return c.json({ event });
});

/**
 * GET /events/:id/prs — PR approvati dal creatore dell'evento. Il creatore
 * vede anche le candidature in attesa, il PR vede la propria.
 */
events.get('/:id/prs', async (c) => {
  const id = uuidParam(c);
  const uid = await optionalUser(c);

  const [{ data: ev }, { data, error }] = await Promise.all([
    supabase.from('events').select('created_by').eq('id', id).maybeSingle(),
    supabase
      .from('event_prs')
      .select('pr_id, approved_at, profiles!event_prs_pr_id_fkey(username, avatar_url, instagram_username, whatsapp_number)')
      .eq('event_id', id),
  ]);

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load PRs for event');

  const isCreator = !!uid && ev?.created_by === uid;
  const prs = (data ?? [])
    .filter((row) => row.approved_at || isCreator || row.pr_id === uid)
    .map((row) => ({
      id: row.pr_id,
      pending: !row.approved_at,
      username: row.profiles?.username,
      avatar_url: row.profiles?.avatar_url,
      instagram_username: row.profiles?.instagram_username,
      whatsapp_number: row.profiles?.whatsapp_number,
    }));
  return c.json({ prs });
});

/**
 * POST /events — create (organizer/admin/moderator). When `bar_id` is given,
 * lat/lng are backfilled from that bar.
 */
// Un evento non è solo una riga: la creazione fa fan-out di una notifica (e di
// un Web Push) a ogni follower dell'organizzatore. Senza limite, un account
// approvato può usarlo come megafono.
events.post(
  '/',
  requireAuth,
  requireRole('organizer', 'admin', 'moderator'),
  sharedRateLimiter({ windowMs: 60_000, max: 10, key: 'event-create' }),
  async (c) => {
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
        has_presales: body.has_presales,
        photo_url: body.photo_url,
        free_drink: body.free_drink,
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
  },
);

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
 * POST /events/:id/join — un PR si candida su un evento. Non compare in
 * pubblico finché il creatore non approva: senza, qualunque organizer poteva
 * agganciarsi agli eventi altrui e dirottare le prevendite sui suoi contatti.
 */
events.post('/:id/join', requireAuth, requireRole('organizer'), async (c) => {
  const id = uuidParam(c);
  const user = c.get('user');

  const [{ data: me }, { data: ev }] = await Promise.all([
    supabase.from('profiles').select('organizer_type, username').eq('id', user.id).maybeSingle(),
    supabase.from('events').select('id, title, created_by, cancelled_at').eq('id', id).maybeSingle(),
  ]);
  if (me?.organizer_type !== 'pr') {
    throw new AppError(403, 'FORBIDDEN', 'Solo gli account PR possono unirsi agli eventi');
  }
  if (!ev) throw new AppError(404, 'NOT_FOUND', 'Event not found');
  if (ev.cancelled_at) throw new AppError(409, 'CONFLICT', 'Evento annullato');

  const ownEvent = ev.created_by === user.id;
  const { error } = await supabase
    .from('event_prs')
    .insert({ event_id: id, pr_id: user.id, approved_at: ownEvent ? new Date().toISOString() : null });

  if (error?.code === '23505') {
    const { data: row } = await supabase
      .from('event_prs')
      .select('approved_at')
      .eq('event_id', id)
      .eq('pr_id', user.id)
      .maybeSingle();
    return c.json({ success: true, pending: !row?.approved_at });
  }
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not join event');

  if (!ownEvent) {
    await notify([ev.created_by], {
      type: 'pr_request',
      title: `Nuovo PR per ${ev.title}`,
      body: `${me.username} chiede di comparire come PR del tuo evento.`,
      link: `/event/${id}`,
    });
  }
  return c.json({ success: true, pending: !ownEvent });
});

/** Il creatore dell'evento (o lo staff) può decidere sui PR. */
async function loadManagedEvent(c) {
  const id = uuidParam(c);
  const prId = uuidParam(c, 'prId');
  const user = c.get('user');
  const { data: ev } = await supabase
    .from('events')
    .select('id, title, created_by')
    .eq('id', id)
    .maybeSingle();
  if (!ev) throw new AppError(404, 'NOT_FOUND', 'Event not found');
  const isStaff = user.role === 'admin' || user.role === 'moderator';
  if (ev.created_by !== user.id && !isStaff) {
    throw new AppError(403, 'FORBIDDEN', 'Solo il creatore dell\'evento gestisce i suoi PR');
  }
  return { ev, prId, user, isStaff: isStaff && ev.created_by !== user.id };
}

/** POST /events/:id/prs/:prId/approve — il creatore approva un PR. */
events.post('/:id/prs/:prId/approve', requireAuth, async (c) => {
  const { ev, prId, user, isStaff } = await loadManagedEvent(c);
  const { data, error } = await supabase
    .from('event_prs')
    .update({ approved_at: new Date().toISOString() })
    .eq('event_id', ev.id)
    .eq('pr_id', prId)
    .is('approved_at', null)
    .select('pr_id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not approve PR');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Nessuna candidatura in attesa');

  await notify([prId], {
    type: 'pr_approved',
    title: 'Sei PR dell\'evento',
    body: `Il creatore di «${ev.title}» ti ha approvato come PR.`,
    link: `/event/${ev.id}`,
  });
  if (isStaff) {
    await audit(user.id, 'event.pr_approve', { targetType: 'event', targetId: ev.id, payload: { pr_id: prId } });
  }
  return c.json({ success: true });
});

/** DELETE /events/:id/prs/:prId — il creatore rifiuta o rimuove un PR. */
events.delete('/:id/prs/:prId', requireAuth, async (c) => {
  const { ev, prId, user, isStaff } = await loadManagedEvent(c);
  const { error } = await supabase
    .from('event_prs')
    .delete()
    .eq('event_id', ev.id)
    .eq('pr_id', prId);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not remove PR');
  if (isStaff) {
    await audit(user.id, 'event.pr_remove', { targetType: 'event', targetId: ev.id, payload: { pr_id: prId } });
  }
  return c.json({ success: true });
});

/** DELETE /events/:id/join — PR leaves an event. */
events.delete('/:id/join', requireAuth, requireRole('organizer'), async (c) => {
  const id = uuidParam(c);
  const user = c.get('user');

  const { error } = await supabase
    .from('event_prs')
    .delete()
    .eq('event_id', id)
    .eq('pr_id', user.id);

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not leave event');
  return c.json({ success: true });
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
    .select('id, title')
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete event');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Event not found');
  await audit(user.id, 'event.delete', { targetType: 'event', targetId: id, payload: { title: data.title } });
  return c.json({ success: true });
});


/** POST /events/verify-entry — organizers checking user QR code for party entry */
events.post('/verify-entry', requireAuth, requireRole('organizer', 'admin', 'moderator'), async (c) => {
  const { user_id } = z.object({ user_id: z.string().uuid() }).parse(await c.req.json());

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, username, banned, suspended_until')
    .eq('id', user_id)
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Errore database');
  if (!profile) throw new AppError(404, 'NOT_FOUND', 'Utente non trovato');

  if (profile.banned) {
    throw new AppError(403, 'FORBIDDEN', 'Utente bannato: ingresso negato');
  }
  if (profile.suspended_until && new Date(profile.suspended_until) > new Date()) {
    throw new AppError(403, 'FORBIDDEN', 'Utente in timeout: ingresso negato');
  }

  return c.json({ success: true, user: { id: profile.id, username: profile.username } });
});
export default events;
