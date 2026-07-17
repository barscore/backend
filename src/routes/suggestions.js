import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole, optionalUser } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  createSuggestionSchema,
  listSuggestionsQuerySchema,
  updateSuggestionSchema,
} from '../schemas/suggestionSchemas.js';

// Bar suggestions ("segnala il tuo bar"). Public create (rate-limited, no auth
// required); reads + moderation are staff-only. Backend uses the service-role
// key, so these bypass RLS.
const suggestions = new Hono();

/**
 * POST /suggestions — submit a missing bar. Public, strictly rate-limited
 * (spam guard) since it needs no auth.
 */
suggestions.post('/', rateLimiter({ windowMs: 60_000, max: 5 }), async (c) => {
  const body = createSuggestionSchema.parse(await c.req.json());
  const userId = await optionalUser(c);

  const { data, error } = await supabase
    .from('bar_suggestions')
    .insert({
      name: body.name,
      city: body.city ?? null,
      note: body.note ?? null,
      contact: body.contact ?? null,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
      created_by: userId,
    })
    .select('id')
    .single();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Segnalazione non riuscita');
  return c.json({ suggestion: data }, 201);
});

// Everything below is staff-only.
suggestions.use('*', requireAuth, requireRole('admin', 'moderator'));

/** GET /suggestions — moderation list, newest first. */
suggestions.get('/', async (c) => {
  const { q, status, page, limit } = listSuggestionsQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('bar_suggestions')
    .select('id, name, city, note, contact, lat, lng, status, created_by, created_at', {
      count: 'exact',
    })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (status) query = query.eq('status', status);
  // Strip PostgREST .or() metacharacters — a "," or ")" in q would otherwise be
  // parsed as extra filter conditions (filter injection).
  if (q) {
    const safe = q.replace(/[,()]/g, ' ').trim();
    if (safe) query = query.or(`name.ilike.%${safe}%,city.ilike.%${safe}%`);
  }

  const { data, error, count } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load suggestions');
  return c.json({ suggestions: data ?? [], page, limit, total: count ?? 0 });
});

/** PATCH /suggestions/:id — set moderation status (new/done/rejected). */
suggestions.patch('/:id', async (c) => {
  const id = uuidParam(c);
  const { status } = updateSuggestionSchema.parse(await c.req.json());
  const { data, error } = await supabase
    .from('bar_suggestions')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, status')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update suggestion');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Segnalazione non trovata');
  return c.json({ suggestion: data });
});

/** DELETE /suggestions/:id — drop a handled/spam suggestion. */
suggestions.delete('/:id', async (c) => {
  const id = uuidParam(c);
  const { data, error } = await supabase
    .from('bar_suggestions')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete suggestion');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Segnalazione non trovata');
  return c.json({ success: true });
});

export default suggestions;
