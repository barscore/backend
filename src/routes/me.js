import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { sharedRateLimiter } from '../middleware/rateLimiter.js';
import { isPlus } from '../lib/plus.js';
import { issueFreeDrinkToken } from '../lib/freeDrink.js';
import { issueEntryPass } from '../lib/entryPass.js';
import { assertCleanText } from '../lib/textFilter.js';
import { assertModerated, identityText } from '../lib/moderation.js';
import { markUsernameModerated, reviewUsername } from '../lib/usernameReview.js';
import { myDrinkVotesQuerySchema } from '../schemas/drinkSchemas.js';
import {
  createOrganizerRequestSchema,
  proofUploadSchema,
} from '../schemas/organizerSchemas.js';
import { assertOwnedPaths, createProofUploadUrls } from '../lib/proofs.js';
import { eraseAccount } from '../lib/accountDeletion.js';
import { SSV_ENABLED } from '../lib/admobSsv.js';
import { mediaUploadSchema, setAvatarSchema } from '../schemas/userSchemas.js';
import {
  assertMediaUploaded,
  assertOwnedMedia,
  createMediaUpload,
  deleteMedia,
  deleteOtherMedia,
  publicMediaUrl,
} from '../lib/media.js';

// Account-scoped self routes. All require auth; a user only ever reads their own
// profile and ratings. Credential changes go through supabase-js on the frontend.
const me = new Hono();
me.use('*', requireAuth);

/** GET /me — the caller's account details (profile + email + rating count). */
me.get('/', async (c) => {
  const user = c.get('user');

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, instagram_username, whatsapp_number, created_at, plus_until, rewarded_count, is_explorer, free_drink_token')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load profile');
  if (!profile) throw new AppError(404, 'NOT_FOUND', 'Profile not found');

  const [username, { count }] = await Promise.all([
    reviewUsername(c.get('caller').user, profile.username),
    supabase
      .from('ratings')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id),
  ]);

  // Each rating earns 10 ice cubes (accumulating points), derived from the
  // rating count — never stored, so it can't drift.
  const ratingsCount = count ?? 0;
  return c.json({
    profile: {
      ...profile,
      username,
      email: user.email,
      ratings_count: ratingsCount,
      ice_cubes: ratingsCount * 10,
      plus: isPlus(profile),
    },
  });
});

/** PATCH /me — update profile details (Instagram, WhatsApp, etc). */
me.patch('/', async (c) => {
  const user = c.get('user');
  const { updateProfileSchema } = await import('../schemas/userSchemas.js');
  const body = updateProfileSchema.parse(await c.req.json());
  // Username e handle Instagram compaiono accanto a ogni contenuto pubblico.
  assertCleanText(body.username, body.instagram_username);
  const checked = await assertModerated(
    [identityText(body.username), identityText(body.instagram_username)],
    { policy: 'identity' },
  );

  const { data, error } = await supabase
    .from('profiles')
    .update(body)
    .eq('id', user.id)
    .select('id, username, avatar_url, instagram_username, whatsapp_number, created_at, plus_until')
    .single();
    
  if (error) {
    if (error.code === '23505' && error.message.includes('username')) {
      throw new AppError(409, 'CONFLICT', 'Questo username è già in uso');
    }
    throw new AppError(500, 'INTERNAL_ERROR', 'Could not update profile');
  }
  // Già controllato qui: la prossima GET /me non deve rifarlo.
  if (checked && body.username) await markUsernameModerated(user.id, data.username);
  return c.json({ profile: data });
});

/** POST /me/rewarded — one AdMob rewarded ad watched to the end. Returns the
 *  counter that unlocks the "mar7yyy" theme; the RPC caps it at 10
 *  (REWARDS_FOR_THEME), so repeated calls plateau.
 *
 *  Without ADMOB_SSV the call itself counts the view: nothing proves the ad was
 *  watched, and a forged client gets a theme. With ADMOB_SSV=1 only Google's
 *  signed callback counts (routes/admob.js); this waits a few seconds for it —
 *  it may land just before or just after the app's call — claims it, and
 *  answers with the count either way.
 */
// 20/min e non 5 come le segnalazioni: un rewarded dura mezzo minuto, ma
// dietro un NAT di rete mobile ci sono molti utenti sullo stesso IP.
const SSV_WAIT_MS = 8_000;
const SSV_POLL_MS = 500;
// A callback older than this belongs to an earlier view, already answered.
const SSV_CLAIM_WINDOW_MS = 2 * 60 * 1000;

me.post('/rewarded', sharedRateLimiter({ windowMs: 60_000, max: 20, key: 'rewarded' }), async (c) => {
  const user = c.get('user');

  if (!SSV_ENABLED) {
    const { data, error } = await supabase.rpc('add_rewarded_view', { p_user: user.id });
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not record the reward');
    return c.json({ rewarded_count: data ?? 0 });
  }

  const since = new Date(Date.now() - SSV_CLAIM_WINDOW_MS).toISOString();
  const deadline = Date.now() + SSV_WAIT_MS;
  for (;;) {
    const { data: claimed, error } = await supabase.rpc('claim_rewarded_ssv', {
      p_user: user.id,
      p_since: since,
    });
    if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not read the reward');
    if (claimed || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, SSV_POLL_MS));
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('rewarded_count')
    .eq('id', user.id)
    .maybeSingle();
  return c.json({ rewarded_count: profile?.rewarded_count ?? 0 });
});

/**
 * GET /me/entry-pass — il pass d'ingresso alle feste da mostrare come QR.
 * Firmato e a scadenza breve (lib/entryPass.js): l'app lo richiede di nuovo
 * mentre il QR è a schermo, così uno screenshot smette presto di valere.
 */
me.get('/entry-pass', sharedRateLimiter({ windowMs: 60_000, max: 20, key: 'entry-pass' }), (c) =>
  c.json(issueEntryPass(c.get('user').id)),
);

/** GET /me/ratings — the caller's own ratings, with the rated bar attached. */
me.get('/ratings', async (c) => {
  const user = c.get('user');

  const { data, error } = await supabase
    .from('ratings')
    .select(
      'id, bar_id, prezzo, qualita_drinks, socialita, varieta, orari, commento, risposta, risposta_at, created_at, updated_at, bars(id, name, address, city)',
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

/**
 * POST /me/uploads/image — upload URL firmato per una foto profilo o la
 * copertina di un evento. Il path lo sceglie il backend, nella cartella di chi
 * chiede; `public_url` è l'indirizzo che l'immagine avrà una volta confermata.
 */
me.post('/uploads/image', sharedRateLimiter({ windowMs: 60_000, max: 20, key: 'media-upload' }), async (c) => {
  const user = c.get('user');
  const { kind, ext } = mediaUploadSchema.parse(await c.req.json());
  return c.json({ upload: await createMediaUpload(user.id, kind, ext) });
});

/**
 * PUT /me/avatar — conferma la foto profilo appena caricata. Passa dalla
 * moderazione come lo username (policy `identity`: compare accanto a ogni
 * contenuto dell'utente), poi le foto precedenti vengono cancellate.
 */
me.put('/avatar', sharedRateLimiter({ windowMs: 60_000, max: 10, key: 'avatar' }), async (c) => {
  const user = c.get('user');
  const { path } = setAvatarSchema.parse(await c.req.json());
  assertOwnedMedia(user.id, 'avatar', path);
  await assertMediaUploaded(path);

  const url = publicMediaUrl(path);
  try {
    await assertModerated([], { imageUrl: url, policy: 'identity' });
  } catch (e) {
    // Rifiutata: il file non deve restare pubblico nemmeno senza riga che lo
    // usi. Solo lui: la foto di prima resta quella in uso.
    await deleteMedia([path]);
    throw e;
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({ avatar_url: url })
    .eq('id', user.id)
    .select('id, username, avatar_url')
    .single();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update profile');
  await deleteOtherMedia(user.id, 'avatar', path);
  return c.json({ profile: data });
});

/** DELETE /me/avatar — torna all'icona di default. */
me.delete('/avatar', async (c) => {
  const user = c.get('user');
  const { error } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', user.id);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update profile');
  await deleteOtherMedia(user.id, 'avatar', null);
  return c.json({ success: true });
});

me.post('/promo', async (c) => {
  const user = c.get('user');
  const { promo } = await c.req.json();
  if (promo !== 'explorer') return c.json({ success: true });

  // The profile row is created by the handle_new_user trigger after signUp.
  // On a fresh registration the trigger may not have finished yet, so we
  // retry a few times before giving up.
  let current = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await supabase
      .from('profiles')
      .select('is_explorer, free_drink_token')
      .eq('id', user.id)
      .maybeSingle();
    if (data) { current = data; break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!current) {
    throw new AppError(404, 'PROFILE_NOT_READY', 'Profile row not found yet — retry later');
  }

  const { count } = await supabase
    .from('ratings')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id);

  const ratingsCount = count ?? 0;
  let is_new = false;

  if (!current.is_explorer) {
    const { error: upErr } = await supabase
      .from('profiles')
      .update({ is_explorer: true })
      .eq('id', user.id);
    if (upErr) throw new AppError(500, 'INTERNAL_ERROR', 'Could not apply promo');
    is_new = true;
  }

  let hasToken = !!current.free_drink_token;
  if (ratingsCount >= 5 && !hasToken) {
    try {
      hasToken = await issueFreeDrinkToken(user.id);
    } catch {
      throw new AppError(500, 'INTERNAL_ERROR', 'Could not generate token');
    }
  }

  return c.json({
    success: true,
    promo: 'explorer',
    is_new,
    ratings_count: ratingsCount,
    has_token: hasToken,
  });
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

/** GET /me/bars — bars the caller owns (the redeem screen picks one). */
me.get('/bars', async (c) => {
  const user = c.get('user');
  const { data, error } = await supabase
    .from('bars')
    .select('id, name, city, is_active, accepts_free_drinks')
    .eq('owner_id', user.id)
    .order('name');
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load bars');
  return c.json({ bars: data ?? [] });
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
      'id, bar_id, title, description, lat, lng, starts_at, ends_at, cancelled_at, boost_until, has_presales, photo_url, free_drink, bars(name)',
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
 * Limite stretto: la rotta apre diciassette query e serializza l'intera storia
 * dell'account, non è una GET qualsiasi.
 */
me.get('/export', sharedRateLimiter({ windowMs: 3600_000, max: 5, key: 'export' }), async (c) => {
  const user = c.get('user');
  const mine = (table, columns) => supabase.from(table).select(columns).eq('user_id', user.id);
  const createdByMe = (table, columns) => supabase.from(table).select(columns).eq('created_by', user.id);

  const [
    profile, ratings, drinkVotes, bookmarks, follows, notifications, requests, claims,
    events, prMemberships, replies, reports, barSuggestions, drinkSuggestions, plusSub, boostOrders,
    freeDrink,
  ] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('id, username, avatar_url, instagram_username, whatsapp_number, role, organizer_type, is_explorer, created_at, plus_until, rewarded_count')
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
      // Quello che l'utente ha pubblicato o inviato oltre alle recensioni.
      createdByMe(
        'events',
        'id, bar_id, title, description, lat, lng, starts_at, ends_at, cancelled_at, has_presales, photo_url, free_drink, created_at',
      ).order('created_at', { ascending: false }),
      supabase.from('event_prs').select('event_id, approved_at, created_at').eq('pr_id', user.id),
      // Le risposte del gestore stanno sulle recensioni degli altri: si trovano
      // dal bar che possiede, e se ne esporta solo il testo suo.
      supabase
        .from('ratings')
        .select('bar_id, risposta, risposta_at, bars!inner(owner_id)')
        .eq('bars.owner_id', user.id)
        .not('risposta', 'is', null),
      createdByMe('user_reports', 'type, message, status, created_at'),
      createdByMe('bar_suggestions', 'name, city, note, contact, lat, lng, status, created_at'),
      createdByMe('drink_suggestions', 'name, note, status, created_at'),
      // Acquisti: solo ciò che sta nel nostro database. Ricevute e dati di
      // pagamento li custodiscono Stripe, Google Play e Apple.
      mine('plus_subscriptions', 'provider, plan, status, current_period_end, cancel_at_period_end, created_at').maybeSingle(),
      mine('boost_orders', 'event_id, bar_id, tier, amount_cents, status, created_at, paid_at'),
      mine('free_drink_redemptions', 'bar_id, redeemed_at').maybeSingle(),
    ]);

  // Le statistiche dei locali (bar_events) non ci sono: legate al solo
  // dispositivo, mai all'account, non sono dati di questo utente da esportare.

  // Un export incompleto spacciato per completo è peggio di un errore: se anche
  // una sola query fallisce, fallisce tutto.
  const parts = [
    profile, ratings, drinkVotes, bookmarks, follows, notifications, requests, claims,
    events, prMemberships, replies, reports, barSuggestions, drinkSuggestions, plusSub, boostOrders,
    freeDrink,
  ];
  if (parts.some((r) => r.error) || !profile.data) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Export non riuscito');
  }

  // `<user_id>/<uuid>.<ext>` → solo il nome del file.
  const withFileNames = (rows) =>
    rows.map((r) => ({ ...r, proof_files: (r.proof_files ?? []).map((f) => f.split('/').pop()) }));

  // Senza questo header il browser mostra il JSON invece di salvarlo.
  c.header('Content-Disposition', 'attachment; filename="rabar-dati.json"');
  return c.json({
    format_version: 2,
    exported_at: new Date().toISOString(),
    profile: {
      ...profile.data,
      email: user.email,
      terms_accepted_at: c.get('caller')?.user?.user_metadata?.terms_accepted_at ?? null,
    },
    ratings: ratings.data ?? [],
    drink_votes: drinkVotes.data ?? [],
    bookmarks: bookmarks.data ?? [],
    follows: follows.data ?? [],
    notifications: notifications.data ?? [],
    organizer_requests: withFileNames(requests.data ?? []),
    claims: withFileNames(claims.data ?? []),
    events: events.data ?? [],
    pr_events: prMemberships.data ?? [],
    owner_replies: (replies.data ?? []).map(({ bars, ...r }) => r),
    reports: reports.data ?? [],
    bar_suggestions: barSuggestions.data ?? [],
    drink_suggestions: drinkSuggestions.data ?? [],
    plus_subscription: plusSub.data ?? null,
    boost_orders: boostOrders.data ?? [],
    free_drink_redemption: freeDrink.data ?? null,
  });
});

/** DELETE /me — the caller erases their own account (GDPR art. 17). Deleting the
 *  auth user cascades to profiles + ratings + votes (ON DELETE CASCADE); Stripe
 *  and the proof files are handled by eraseAccount. */
me.delete('/', async (c) => {
  await eraseAccount(c.get('user').id);
  return c.json({ success: true });
});

export default me;
