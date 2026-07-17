import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { uuidParam } from '../schemas/common.js';
import { reviewSchema } from '../schemas/organizerSchemas.js';
import { notify } from '../lib/notify.js';

// Staff moderation: organizer upgrade requests + bar ownership claims.
// Mounted at /admin/organizers.
const organizers = new Hono();
organizers.use('*', requireAuth, requireRole('admin', 'moderator'));

/** GET /admin/organizers/requests?status=pending|approved|rejected|all */
organizers.get('/requests', async (c) => {
  const status = new URL(c.req.url).searchParams.get('status') ?? 'pending';
  let query = supabase
    .from('organizer_requests')
    .select(
      'id, user_id, requested_type, proof, channels, channels_other, collaborations, status, admin_note, created_at, profiles!organizer_requests_user_id_fkey(username)',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (['pending', 'approved', 'rejected'].includes(status)) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load requests');
  return c.json({
    requests: (data ?? []).map((r) => ({
      ...r,
      username: r.profiles?.username ?? null,
      profiles: undefined,
    })),
  });
});

/** POST /admin/organizers/requests/:id/approve — grant the organizer role. */
organizers.post('/requests/:id/approve', async (c) => {
  const id = uuidParam(c);
  const { data: req, error } = await supabase
    .from('organizer_requests')
    .update({
      status: 'approved',
      reviewed_by: c.get('user').id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('user_id, requested_type')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Approvazione non riuscita');
  if (!req) throw new AppError(404, 'NOT_FOUND', 'Richiesta non trovata o già gestita');

  // Promote, but never touch staff roles.
  const { error: roleErr } = await supabase
    .from('profiles')
    .update({ role: 'organizer', organizer_type: req.requested_type })
    .eq('id', req.user_id)
    .in('role', ['user', 'betatester']);
  if (roleErr) throw new AppError(500, 'INTERNAL_ERROR', 'Aggiornamento ruolo non riuscito');

  await notify([req.user_id], {
    type: 'request_approved',
    title: 'Richiesta approvata',
    body: 'Il tuo account è ora un account organizzatore: puoi pubblicare eventi.',
    link: '/?tab=eventi',
  });
  return c.json({ success: true });
});

/** POST /admin/organizers/requests/:id/reject */
organizers.post('/requests/:id/reject', async (c) => {
  const id = uuidParam(c);
  const { admin_note } = reviewSchema.parse(await c.req.json().catch(() => ({})));
  const { data: req, error } = await supabase
    .from('organizer_requests')
    .update({
      status: 'rejected',
      admin_note: admin_note ?? null,
      reviewed_by: c.get('user').id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('user_id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Rifiuto non riuscito');
  if (!req) throw new AppError(404, 'NOT_FOUND', 'Richiesta non trovata o già gestita');

  await notify([req.user_id], {
    type: 'request_rejected',
    title: 'Richiesta non approvata',
    body: admin_note
      ? `La tua richiesta organizzatore è stata rifiutata: ${admin_note}`
      : 'La tua richiesta organizzatore è stata rifiutata. Puoi riprovare con prove più solide.',
    link: '/impostazioni',
  });
  return c.json({ success: true });
});

/** GET /admin/organizers/claims?status=pending|approved|rejected|all */
organizers.get('/claims', async (c) => {
  const status = new URL(c.req.url).searchParams.get('status') ?? 'pending';
  let query = supabase
    .from('bar_claims')
    .select(
      'id, user_id, bar_id, proof, status, admin_note, created_at, bars(name, city), profiles!bar_claims_user_id_fkey(username)',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (['pending', 'approved', 'rejected'].includes(status)) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load claims');
  return c.json({
    claims: (data ?? []).map((cl) => ({
      ...cl,
      username: cl.profiles?.username ?? null,
      bar_name: cl.bars?.name ?? null,
      bar_city: cl.bars?.city ?? null,
      profiles: undefined,
      bars: undefined,
    })),
  });
});

/** POST /admin/organizers/claims/:id/approve — set the bar's owner. */
organizers.post('/claims/:id/approve', async (c) => {
  const id = uuidParam(c);
  const { data: claim, error } = await supabase
    .from('bar_claims')
    .update({
      status: 'approved',
      reviewed_by: c.get('user').id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('user_id, bar_id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Approvazione non riuscita');
  if (!claim) throw new AppError(404, 'NOT_FOUND', 'Richiesta non trovata o già gestita');

  // Guard: only claim an unowned bar (another claim may have won meanwhile).
  const { data: bar, error: ownErr } = await supabase
    .from('bars')
    .update({ owner_id: claim.user_id })
    .eq('id', claim.bar_id)
    .is('owner_id', null)
    .select('id, name')
    .maybeSingle();
  if (ownErr) throw new AppError(500, 'INTERNAL_ERROR', 'Assegnazione non riuscita');
  if (!bar) throw new AppError(409, 'CONFLICT', 'Il bar ha già un proprietario');

  await notify([claim.user_id], {
    type: 'claim_approved',
    title: 'Bar verificato',
    body: `Sei ora il proprietario verificato di "${bar.name}". Puoi mettere in evidenza il bar con un boost.`,
    link: `/bar/${claim.bar_id}`,
  });
  return c.json({ success: true });
});

/** POST /admin/organizers/claims/:id/reject */
organizers.post('/claims/:id/reject', async (c) => {
  const id = uuidParam(c);
  const { admin_note } = reviewSchema.parse(await c.req.json().catch(() => ({})));
  const { data: claim, error } = await supabase
    .from('bar_claims')
    .update({
      status: 'rejected',
      admin_note: admin_note ?? null,
      reviewed_by: c.get('user').id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')
    .select('user_id, bar_id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Rifiuto non riuscito');
  if (!claim) throw new AppError(404, 'NOT_FOUND', 'Richiesta non trovata o già gestita');

  await notify([claim.user_id], {
    type: 'claim_rejected',
    title: 'Rivendicazione non approvata',
    body: admin_note
      ? `La tua rivendicazione è stata rifiutata: ${admin_note}`
      : 'La tua rivendicazione del bar è stata rifiutata.',
    link: `/bar/${claim.bar_id}`,
  });
  return c.json({ success: true });
});

export default organizers;
