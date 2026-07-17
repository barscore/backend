import { uuidParam } from '../schemas/common.js';
import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import {
  createReportSchema,
  listReportsQuerySchema,
  updateReportSchema,
} from '../schemas/reportSchemas.js';

// Generic user reports ("segnala" in the account menu). Create requires auth —
// the button only shows to signed-in users; reads + moderation are staff-only.
// Backend uses the service-role key, so these bypass RLS.
const reports = new Hono();

/**
 * POST /reports — submit a report. Auth required, strictly rate-limited
 * (spam guard, same budget as POST /suggestions).
 */
reports.post('/', rateLimiter({ windowMs: 60_000, max: 5 }), requireAuth, async (c) => {
  const body = createReportSchema.parse(await c.req.json());

  const { data, error } = await supabase
    .from('user_reports')
    .insert({
      type: body.type,
      message: body.message,
      created_by: c.get('user').id,
    })
    .select('id')
    .single();

  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Segnalazione non riuscita');
  return c.json({ report: data }, 201);
});

// Everything below is staff-only.
reports.use('*', requireAuth, requireRole('admin', 'moderator'));

/** GET /reports — moderation list, newest first. */
reports.get('/', async (c) => {
  const { q, type, status, page, limit } = listReportsQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabase
    .from('user_reports')
    .select('id, type, message, status, created_by, created_at, profiles:created_by(username)', {
      count: 'exact',
    })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (type) query = query.eq('type', type);
  if (status) query = query.eq('status', status);
  if (q) query = query.ilike('message', `%${q.replace(/[,()]/g, ' ').trim()}%`);

  const { data, error, count } = await query;
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load reports');
  return c.json({ reports: data ?? [], page, limit, total: count ?? 0 });
});

/** PATCH /reports/:id — set moderation status (new/done/rejected). */
reports.patch('/:id', async (c) => {
  const id = uuidParam(c);
  const { status } = updateReportSchema.parse(await c.req.json());
  const { data, error } = await supabase
    .from('user_reports')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, status')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not update report');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Segnalazione non trovata');
  return c.json({ report: data });
});

/** DELETE /reports/:id — drop a handled/spam report. */
reports.delete('/:id', async (c) => {
  const id = uuidParam(c);
  const { data, error } = await supabase
    .from('user_reports')
    .delete()
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not delete report');
  if (!data) throw new AppError(404, 'NOT_FOUND', 'Segnalazione non trovata');
  return c.json({ success: true });
});

export default reports;
