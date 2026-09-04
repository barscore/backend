import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { sharedRateLimiter } from '../middleware/rateLimiter.js';
import { isPlus } from '../lib/plus.js';
import { myDrinkVotesQuerySchema } from '../schemas/drinkSchemas.js';
import {
  createOrganizerRequestSchema,
  proofUploadSchema,
} from '../schemas/organizerSchemas.js';
import {
  assertOwnedPaths,
  createProofUploadUrls,
  deleteAllProofsForUser,
} from '../lib/proofs.js';

// Account-scoped self routes. All require auth; a user only ever reads their own
// profile and ratings. Credential changes go through supabase-js on the frontend.
const me = new Hono();
me.use('*', requireAuth);

/** GET /me — the caller's account details (profile + email + rating count). */
me.get('/', async (c) => {
  const user = c.get('user');

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, created_at, plus_until, rewarded_count')
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
      plus: isPlus(profile),
    },
  });
});

/** POST /me/rewarded — one AdMob rewarded ad watched to the end. Increments the
 *  counter that unlocks the "mar7yyy" theme and returns the new value; the
 *  RPC caps it at 10 (REWARDS_FOR_THEME), so repeated calls plateau.
 *
 *  ponytail: nothing here proves the ad was really watched — that would need
 *  AdMob server-side verification. The reward is a colour palette and the cap
 *  is server-side, so the worst a forged client gets is a theme.
 */
// 20/min e non 5 come le segnalazioni: un rewarded dura mezzo minuto, ma
// dietro un NAT di rete mobile ci sono molti utenti sullo stesso IP.
me.post('/rewarded', sharedRateLimiter({ windowMs: 60_000, max: 20, key: 'rewarded' }), async (c) => {
  const user = c.get('user');

  const { data, error } = await supabase.rpc('add_rewarded_view', { p_user: user.id });
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not record the reward');

  return c.json({ rewarded_count: data ?? 0 });
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

/**
 * POST /me/uploads/proof — signed upload URLs for verification attachments.
 *
 * The client never gets storage credentials: it asks for 1–3 slots, uploads the
 * bytes straight to the returned URLs, then sends the paths back with the form.
 * The path is chosen here (under the caller's own folder), so a client cannot
 * write anywhere else in the bucket.
 */
me.post('/uploads/proof', sharedRateLimiter({ windowMs: 60_000, max: 20, key: 'proof-upload' }), async (c) => {
  const user = c.get('user');
  const { files } = proofUploadSchema.parse(await c.req.json());
  const uploads = await createProofUploadUrls(
    user.id,
    files.map((f) => f.ext),
  );
  return c.json({ uploads });
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

/**
 * POST /me/organizer-request — upgrade to a PR / organizzatore account.
 *
 * "proprietario" is not requestable here any more: that role comes from
 * claiming a bar on its own page (`POST /bars/:id/claim`).
 */
me.post('/organizer-request', sharedRateLimiter({ windowMs: 60_000, max: 5, key: 'organizer-request' }), async (c) => {
  const user = c.get('user');
  if (user.role === 'organizer') {
    throw new AppError(409, 'CONFLICT', 'Sei già un organizzatore');
  }
  const body = createOrganizerRequestSchema.parse(await c.req.json());
  assertOwnedPaths(user.id, body.proof_files);

  const { data, error } = await supabase
    .from('organizer_requests')
    .insert({
      user_id: user.id,
      requested_type: body.requested_type,
      proof_files: body.proof_files,
      note: body.note ?? null,
      collaborations: body.collaborations ?? null,
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

/**
 * GET /me/export — portabilità dei dati (art. 20 GDPR): tutto quello che
 * l'utente ha prodotto in un unico JSON, scaricabile senza passare da noi.
 *
 * Degli allegati di verifica restano solo i nomi dei file: i documenti sono già
 * suoi (li ha caricati lui) e il path interno non è un suo dato, è il modo in
 * cui organizziamo il bucket. Il nome basta a sapere cosa era allegato a cosa.
 *
 * Limite stretto: la rotta apre otto query e serializza l'intera storia
 * dell'account, non è una GET qualsiasi.
 */
me.get('/export', sharedRateLimiter({ windowMs: 3600_000, max: 5, key: 'export' }), async (c) => {
  const user = c.get('user');
  const mine = (table, columns) => supabase.from(table).select(columns).eq('user_id', user.id);

  const [profile, ratings, drinkVotes, bookmarks, follows, notifications, requests, claims] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('id, username, avatar_url, created_at, plus_until, rewarded_count')
        .eq('id', user.id)
        .maybeSingle(),
      mine(
        'ratings',
        'id, bar_id, prezzo, qualita_drinks, socialita, varieta, orari, commento, created_at, updated_at, bars(id, name, address, city)',
      ).order('created_at', { ascending: false }),
      mine('drink_ratings', 'drink_id, bar_id, rating, created_at, updated_at'),
      mine('bookmarks', 'bar_id, created_at'),
      mine('follows', 'event_id, organizer_id, created_at'),
      mine('notifications', 'type, title, body, link, read, created_at').order('created_at', {
        ascending: false,
      }),
      mine(
        'organizer_requests',
        'id, requested_type, note, collaborations, status, admin_note, created_at, reviewed_at, proof_files',
      ),
      mine(
        'bar_claims',
        'id, bar_id, note, status, admin_note, created_at, reviewed_at, proof_files',
      ),
    ]);

  // Un export incompleto spacciato per completo è peggio di un errore: se anche
  // una sola query fallisce, fallisce tutto.
  const parts = [profile, ratings, drinkVotes, bookmarks, follows, notifications, requests, claims];
  if (parts.some((r) => r.error) || !profile.data) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Export non riuscito');
  }

  // `<user_id>/<uuid>.<ext>` → solo il nome del file.
  const withFileNames = (rows) =>
    rows.map((r) => ({ ...r, proof_files: (r.proof_files ?? []).map((f) => f.split('/').pop()) }));

  // Senza questo header il browser mostra il JSON invece di salvarlo.
  c.header('Content-Disposition', 'attachment; filename="rabar-dati.json"');
  return c.json({
    format_version: 1,
    exported_at: new Date().toISOString(),
    profile: { ...profile.data, email: user.email },
    ratings: ratings.data ?? [],
    drink_votes: drinkVotes.data ?? [],
    bookmarks: bookmarks.data ?? [],
    follows: follows.data ?? [],
    notifications: notifications.data ?? [],
    organizer_requests: withFileNames(requests.data ?? []),
    claims: withFileNames(claims.data ?? []),
  });
});

/** DELETE /me — the caller erases their own account (GDPR art. 17). Deleting the
 *  auth user cascades to profiles + ratings + votes (ON DELETE CASCADE). */
me.delete('/', async (c) => {
  const user = c.get('user');

  // Il cascade delle FK non arriva allo storage: senza questa riga i documenti
  // d'identità e le visure allegati alle verifiche resterebbero nel bucket dopo
  // una cancellazione chiesta dall'utente, cioè esattamente ciò che l'art. 17
  // GDPR vieta. Best-effort: se lo storage fa i capricci l'account si cancella
  // comunque (il fallimento viene loggato).
  await deleteAllProofsForUser(user.id);

  const { error } = await supabase.auth.admin.deleteUser(user.id);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Eliminazione account fallita');
  return c.json({ success: true });
});

export default me;
