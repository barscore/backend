import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { audit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';
import {
  listUsersQuerySchema,
  suspendSchema,
  banSchema,
  roleSchema,
  settingsSchema,
  listRatingsQuerySchema,
} from '../schemas/adminSchemas.js';

// Admin panel API. Every route is admin-only. Handles user moderation, rating
// moderation, security settings and emergency operations. The backend uses the
// service-role key, so these bypass RLS.
const admin = new Hono();
admin.use('*', requireAuth, requireRole('admin'));

// Indirizzo dei reclami, lo stesso pubblicato nei ToS: ogni motivazione DSA
// deve dire dove si contesta la decisione.
const CONTATTO_RECLAMI = 'abuse@rabar.it';

// Common moderation-column patch (who/when).
function stamp(actorId) {
  return { moderated_by: actorId, moderated_at: new Date().toISOString() };
}

// =========================================================================
// Dashboard
// =========================================================================

/** GET /admin/stats — headline counts for the dashboard. */
admin.get('/stats', async (c) => {
  const nowIso = new Date().toISOString();
  const head = { count: 'exact', head: true };

  const [users, ratings, bars, banned, suspended] = await Promise.all([
    supabase.from('profiles').select('id', head),
    supabase.from('ratings').select('id', head),
    supabase.from('bars').select('id', head),
    supabase.from('profiles').select('id', head).eq('banned', true),
    supabase.from('profiles').select('id', head).gt('suspended_until', nowIso),
  ]);

  return c.json({
    stats: {
      users: users.count ?? 0,
      ratings: ratings.count ?? 0,
      bars: bars.count ?? 0,
      banned: banned.count ?? 0,
      suspended: suspended.count ?? 0,
    },
  });
});

// =========================================================================
// Users
// =========================================================================

/** GET /admin/users — paginated user list with moderation state + rating count. */
admin.get('/users', async (c) => {
  const { q, role, banned, suspended, page, limit } = listUsersQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('profiles')
    .select(
      'id, username, email, avatar_url, role, organizer_type, banned, suspended_until, moderation_note, created_at',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (role) query = query.eq('role', role);
  if (banned !== undefined) query = query.eq('banned', banned);
  // "Suspended" is a live comparison, not a column: a lapsed suspension is not
  // one, and a ban clears suspended_until.
  if (suspended !== undefined) {
    const nowIso = new Date().toISOString();
    query = suspended
      ? query.gt('suspended_until', nowIso)
      : query.or(`suspended_until.is.null,suspended_until.lte.${nowIso}`);
  }
  // Strip PostgREST .or() metacharacters — a "," or ")" in q would otherwise be
  // parsed as extra filter conditions (filter injection).
  if (q) {
    const safe = q.replace(/[,()]/g, ' ').trim();
    if (safe) query = query.or(`username.ilike.%${safe}%,email.ilike.%${safe}%`);
  }

  const { data, error, count } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load users');

  // Rating count per user, one extra query for the current page.
  const ids = (data ?? []).map((u) => u.id);
  const counts = {};
  if (ids.length) {
    const { data: rows } = await supabase
      .from('ratings')
      .select('user_id')
      .in('user_id', ids);
    for (const r of rows ?? []) counts[r.user_id] = (counts[r.user_id] ?? 0) + 1;
  }

  const users = (data ?? []).map((u) => ({
    ...u,
    ratings_count: counts[u.id] ?? 0,
    suspended:
      !!u.suspended_until && new Date(u.suspended_until) > new Date(),
  }));

  return c.json({ users, page, limit, total: count ?? 0 });
});

// Reject self-targeting mutations so an admin can't lock themselves out.
function assertNotSelf(c, targetId) {
  if (c.get('user').id === targetId) {
    throw new AppError(400, 'BAD_REQUEST', 'Non puoi eseguire questa azione su te stesso');
  }
}

// Restituisce la riga: chi chiama ha spesso bisogno dello stato *prima*
// dell'azione (il ruolo che si sta cambiando) per l'audit.
async function assertUserExists(id) {
  const { data } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('id', id)
    .maybeSingle();
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Utente non trovato');
  return data;
}

/** POST /admin/users/:id/ban — permanent ban (locked out until unbanned). */
admin.post('/users/:id/ban', async (c) => {
  const id = uuidParam(c);
  assertNotSelf(c, id);
  await assertUserExists(id);
  const { reason } = banSchema.parse(await c.req.json().catch(() => ({})));

  const { data, error } = await supabase
    .from('profiles')
    .update({
      banned: true,
      suspended_until: null,
      moderation_note: reason ?? null,
      ...stamp(c.get('user').id),
    })
    .eq('id', id)
    .select('id, banned')
    .single();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Ban fallito');

  // DSA art. 17: la restrizione va motivata a chi la subisce, indicando dove
  // contestarla. Un bannato non supera più requireAuth e quindi non vedrà mai la
  // campanella — la riga resta per il ricorso, a consegnarla è il Web Push.
  await notify([id], {
    type: 'account_restricted',
    title: 'Account bloccato',
    body: `${reason ? `Il tuo account è stato bloccato: ${reason}.` : "Il tuo account è stato bloccato per violazione delle condizioni d'uso."} Puoi contestare la decisione scrivendo a ${CONTATTO_RECLAMI}.`,
    link: '/tos',
  });
  await audit(c.get('user').id, 'user.ban', {
    targetType: 'user',
    targetId: id,
    payload: { reason: reason ?? null },
  });
  return c.json({ user: data });
});

/** POST /admin/users/:id/suspend — temporary suspension for N hours. */
admin.post('/users/:id/suspend', async (c) => {
  const id = uuidParam(c);
  assertNotSelf(c, id);
  await assertUserExists(id);
  const { hours, reason } = suspendSchema.parse(await c.req.json());
  const until = new Date(Date.now() + hours * 3600_000).toISOString();

  const { data, error } = await supabase
    .from('profiles')
    .update({
      banned: false,
      suspended_until: until,
      moderation_note: reason ?? null,
      ...stamp(c.get('user').id),
    })
    .eq('id', id)
    .select('id, suspended_until')
    .single();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Sospensione fallita');

  // Stessa motivazione DSA del ban, più la scadenza: una sospensione senza data
  // di fine non è una sospensione, è un ban che non lo dice.
  const fino = new Date(until).toLocaleString('it-IT');
  await notify([id], {
    type: 'account_restricted',
    title: 'Account sospeso',
    body: `${reason ? `Il tuo account è sospeso fino al ${fino}: ${reason}.` : `Il tuo account è sospeso fino al ${fino}.`} Puoi contestare la decisione scrivendo a ${CONTATTO_RECLAMI}.`,
    link: '/tos',
  });
  await audit(c.get('user').id, 'user.suspend', {
    targetType: 'user',
    targetId: id,
    payload: { hours, until, reason: reason ?? null },
  });
  return c.json({ user: data });
});

/** POST /admin/users/:id/unban — lift ban and suspension. */
admin.post('/users/:id/unban', async (c) => {
  const id = uuidParam(c);
  await assertUserExists(id);

  const { data, error } = await supabase
    .from('profiles')
    .update({
      banned: false,
      suspended_until: null,
      moderation_note: null,
      ...stamp(c.get('user').id),
    })
    .eq('id', id)
    .select('id')
    .single();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Sblocco fallito');

  // Nessuna notifica: lo sblocco non è una restrizione da motivare, e l'utente
  // se ne accorge rientrando. Nell'audit ci va lo stesso, chiude la coppia.
  await audit(c.get('user').id, 'user.unban', { targetType: 'user', targetId: id });
  return c.json({ user: data });
});

/** PUT /admin/users/:id/role — change app role. */
admin.put('/users/:id/role', async (c) => {
  const id = uuidParam(c);
  assertNotSelf(c, id);
  const before = await assertUserExists(id);
  const { role, organizer_type } = roleSchema.parse(await c.req.json());

  const { data, error } = await supabase
    .from('profiles')
    .update({
      role,
      // Direct promotion to organizer carries its type; any other role clears it.
      organizer_type: role === 'organizer' ? organizer_type : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, role, organizer_type')
    .single();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Cambio ruolo fallito');

  await audit(c.get('user').id, 'user.role', {
    targetType: 'user',
    targetId: id,
    payload: { from: before.role, to: role, organizer_type: data.organizer_type },
  });
  return c.json({ user: data });
});

/** DELETE /admin/users/:id — hard-delete the account (auth + cascade). Emergency. */
admin.delete('/users/:id', async (c) => {
  const id = uuidParam(c);
  assertNotSelf(c, id);
  const before = await assertUserExists(id);

  // Deleting the auth user cascades to profiles + ratings (ON DELETE CASCADE).
  const { error } = await supabase.auth.admin.deleteUser(id);
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Eliminazione account fallita');

  // Il ruolo cancellato è l'unica traccia che resta di chi era: la riga profilo
  // non c'è più e il target_id da solo non dice nulla a chi rilegge il log.
  await audit(c.get('user').id, 'user.delete', {
    targetType: 'user',
    targetId: id,
    payload: { role: before.role },
  });
  return c.json({ success: true });
});

// =========================================================================
// Ratings moderation
// =========================================================================

/** GET /admin/ratings — recent ratings with author + bar, newest first. */
admin.get('/ratings', async (c) => {
  const { q, page, limit } = listRatingsQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('ratings')
    .select(
      'id, bar_id, user_id, prezzo, qualita_drinks, socialita, varieta, orari, commento, created_at, profiles(username), bars(name)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(from, to);

  if (q) query = query.ilike('commento', `%${q}%`);

  const { data, error, count } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load ratings');

  const ratings = (data ?? []).map((r) => ({
    ...r,
    username: r.profiles?.username ?? null,
    bar_name: r.bars?.name ?? null,
    profiles: undefined,
    bars: undefined,
  }));
  return c.json({ ratings, page, limit, total: count ?? 0 });
});

/** DELETE /admin/ratings/:id — remove any rating. */
admin.delete('/ratings/:id', async (c) => {
  const id = uuidParam(c);
  // Autore e bar arrivano dal RETURNING: dopo la DELETE non c'è più modo di
  // sapere a chi va motivata la rimozione.
  const { data, error } = await supabase
    .from('ratings')
    .delete()
    .eq('id', id)
    .select('id, user_id, bar_id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete rating');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Valutazione non trovata');

  // DSA art. 17: la rimozione di un contenuto va motivata al suo autore.
  await notify([data.user_id], {
    type: 'content_removed',
    title: 'Valutazione rimossa',
    body: `La tua valutazione è stata rimossa perché non rispetta le condizioni d'uso. Puoi contestare la decisione scrivendo a ${CONTATTO_RECLAMI}.`,
    link: `/bar/${data.bar_id}`,
  });
  await audit(c.get('user').id, 'rating.delete', {
    targetType: 'rating',
    targetId: id,
    payload: { user_id: data.user_id, bar_id: data.bar_id },
  });
  return c.json({ success: true });
});

// =========================================================================
// Security settings + emergency operations
// =========================================================================

/** GET /admin/settings — global switches (singleton row). */
admin.get('/settings', async (c) => {
  const { data, error } = await supabase
    .from('app_settings')
    .select('registration_open, ratings_enabled, maintenance_mode, maintenance_reason, maintenance_eta, beta_mode, updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load settings');
  return c.json({ settings: data });
});

/** PUT /admin/settings — flip one or more switches. */
admin.put('/settings', async (c) => {
  const patch = settingsSchema.parse(await c.req.json());
  const { data, error } = await supabase
    .from('app_settings')
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: c.get('user').id })
    .eq('id', 1)
    .select('registration_open, ratings_enabled, maintenance_mode, maintenance_reason, maintenance_eta, beta_mode, updated_at')
    .single();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update settings');

  await audit(c.get('user').id, 'settings.update', {
    targetType: 'app_settings',
    payload: patch,
  });
  return c.json({ settings: data });
});

/**
 * POST /admin/emergency/purge-user-ratings/:id — delete every rating by a user.
 * Emergency cleanup for a spam account. Rating-summary triggers recompute the
 * affected bars automatically.
 */
admin.post('/emergency/purge-user-ratings/:id', async (c) => {
  const id = uuidParam(c);
  await assertUserExists(id);
  const { data, error } = await supabase
    .from('ratings')
    .delete()
    .eq('user_id', id)
    .select('id');
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Purge fallito');

  const deleted = data?.length ?? 0;
  await audit(c.get('user').id, 'emergency.purge_ratings', {
    targetType: 'user',
    targetId: id,
    payload: { deleted },
  });
  return c.json({ success: true, deleted });
});

export default admin;
