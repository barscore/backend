import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { uuidParam } from '../schemas/common.js';
import { reviewSchema } from '../schemas/organizerSchemas.js';
import { notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { deleteProofPaths, signedProofUrls } from '../lib/proofs.js';

/**
 * Swap the stored storage paths for short-lived signed URLs, in one batch for
 * the whole page. The bucket is private: a raw path is useless to the browser,
 * and these links expire.
 */
async function withProofUrls(rows) {
  const paths = [...new Set(rows.flatMap((r) => r.proof_files ?? []))];
  const signed = await signedProofUrls(paths);
  const byPath = new Map(signed.map((s) => [s.path, s.url]));
  return rows.map((r) => ({
    ...r,
    proofs: (r.proof_files ?? [])
      .map((p) => ({ path: p, url: byPath.get(p) ?? null, pdf: p.toLowerCase().endsWith('.pdf') }))
      .filter((p) => p.url),
    proof_files: undefined,
  }));
}

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
      'id, user_id, requested_type, proof_files, note, collaborations, status, admin_note, created_at, profiles!organizer_requests_user_id_fkey(username)',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (['pending', 'approved', 'rejected'].includes(status)) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load requests');
  const rows = (data ?? []).map((r) => ({
    ...r,
    username: r.profiles?.username ?? null,
    profiles: undefined,
  }));
  return c.json({ requests: await withProofUrls(rows) });
});

/** POST /admin/organizers/requests/:id/approve — grant the organizer role. */
organizers.post('/requests/:id/approve', async (c) => {
  const id = uuidParam(c);
  const { admin_note } = reviewSchema.parse(await c.req.json().catch(() => ({})));
  const { data: req, error } = await supabase
    .from('organizer_requests')
    .update({
      status: 'approved',
      admin_note: admin_note ?? null,
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
    body: admin_note
      ? `Il tuo account è ora un account organizzatore: puoi pubblicare eventi.\n\n${admin_note}`
      : 'Il tuo account è ora un account organizzatore: puoi pubblicare eventi.',
    link: '/?tab=eventi',
  });
  await audit(c.get('user').id, 'organizer_request.approve', {
    targetType: 'organizer_request',
    targetId: id,
    payload: { user_id: req.user_id, requested_type: req.requested_type, admin_note: admin_note ?? null },
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
    .select('user_id, proof_files')
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
  await audit(c.get('user').id, 'organizer_request.reject', {
    targetType: 'organizer_request',
    targetId: id,
    payload: { user_id: req.user_id, admin_note: admin_note ?? null },
  });
  // Gli allegati di una richiesta respinta si cancellano: sono visure e
  // documenti d'identità, e una richiesta chiusa in negativo non ha più motivo
  // di tenerli (limitazione della conservazione, art. 5(1)(e) GDPR). Sugli
  // approve restano invece: sono la prova della verifica, e servono se la
  // decisione viene contestata.
  await deleteProofPaths(req.proof_files);
  return c.json({ success: true });
});

/** GET /admin/organizers/claims?status=pending|approved|rejected|all */
organizers.get('/claims', async (c) => {
  const status = new URL(c.req.url).searchParams.get('status') ?? 'pending';
  let query = supabase
    .from('bar_claims')
    .select(
      'id, user_id, bar_id, proof_files, note, status, admin_note, created_at, bars(name, city), profiles!bar_claims_user_id_fkey(username)',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (['pending', 'approved', 'rejected'].includes(status)) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load claims');
  const rows = (data ?? []).map((cl) => ({
    ...cl,
    username: cl.profiles?.username ?? null,
    bar_name: cl.bars?.name ?? null,
    bar_city: cl.bars?.city ?? null,
    profiles: undefined,
    bars: undefined,
  }));
  return c.json({ claims: await withProofUrls(rows) });
});

/** POST /admin/organizers/claims/:id/approve — set the bar's owner. */
organizers.post('/claims/:id/approve', async (c) => {
  const id = uuidParam(c);
  const { admin_note } = reviewSchema.parse(await c.req.json().catch(() => ({})));
  const { data: claim, error } = await supabase
    .from('bar_claims')
    .update({
      status: 'approved',
      admin_note: admin_note ?? null,
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

  // Claiming a bar IS the way to become a "proprietario" — the settings form
  // only offers pr/organizzatore. Never touch staff roles, and never downgrade
  // an existing organizer's own type.
  const { error: roleErr } = await supabase
    .from('profiles')
    .update({ role: 'organizer', organizer_type: 'proprietario' })
    .eq('id', claim.user_id)
    .in('role', ['user', 'betatester']);
  if (roleErr) throw new AppError(500, 'INTERNAL_ERROR', 'Aggiornamento ruolo non riuscito');

  const claimApprovedBody = `Sei ora il proprietario verificato di "${bar.name}". Puoi mettere in evidenza il bar con un boost.`;
  await notify([claim.user_id], {
    type: 'claim_approved',
    title: 'Bar verificato',
    body: admin_note ? `${claimApprovedBody}\n\n${admin_note}` : claimApprovedBody,
    link: `/bar/${claim.bar_id}`,
  });
  await audit(c.get('user').id, 'claim.approve', {
    targetType: 'bar_claim',
    targetId: id,
    payload: { user_id: claim.user_id, bar_id: claim.bar_id, admin_note: admin_note ?? null },
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
    .select('user_id, bar_id, proof_files')
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
  await audit(c.get('user').id, 'claim.reject', {
    targetType: 'bar_claim',
    targetId: id,
    payload: { user_id: claim.user_id, bar_id: claim.bar_id, admin_note: admin_note ?? null },
  });
  // Come per le richieste organizzatore: rifiutata, i documenti non servono più.
  await deleteProofPaths(claim.proof_files);
  return c.json({ success: true });
});

/** POST /admin/organizers/claims/:id/revoke - revoke bar ownership */
organizers.post('/claims/:id/revoke', async (c) => {
  const id = uuidParam(c);
  const { data: claim, error } = await supabase
    .from('bar_claims')
    .update({
      status: 'rejected',
      admin_note: 'Proprietà revocata',
      reviewed_by: c.get('user').id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'approved')
    .select('user_id, bar_id')
    .maybeSingle();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Revoca non riuscita');
  if (!claim) throw new AppError(404, 'NOT_FOUND', 'Richiesta non trovata o non approvata');

  await supabase
    .from('bars')
    .update({ owner_id: null })
    .eq('id', claim.bar_id)
    .eq('owner_id', claim.user_id);

  return c.json({ success: true });
});

export default organizers;
