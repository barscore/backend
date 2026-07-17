import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { errorHandler, AppError } from './middleware/errorHandler.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { supabase } from './lib/supabase.js';
import barRoutes from './routes/bars.js';
import placeRoutes from './routes/places.js';
import bookmarkRoutes from './routes/bookmarks.js';
import eventRoutes from './routes/events.js';
import meRoutes from './routes/me.js';
import leaderboardRoutes from './routes/leaderboard.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import suggestionRoutes from './routes/suggestions.js';
import reportRoutes from './routes/reports.js';
import drinkRoutes from './routes/drinks.js';
import healthRoutes from './routes/health.js';
import notificationRoutes from './routes/notifications.js';
import organizerRoutes from './routes/organizers.js';
import followRoutes from './routes/follows.js';
import pushRoutes from './routes/push.js';
import boostRoutes from './routes/boosts.js';
import stripeWebhookRoutes from './routes/stripeWebhook.js';
import { startReminderWorker } from './lib/reminderWorker.js';

const app = new Hono();

// FRONTEND_URL may be a comma-separated allowlist (localhost + LAN IP + prod
// domain). Use "*" to allow any origin. Needed so iOS Safari / the PWA — served
// from a different origin than the dev box — aren't blocked by CORS.
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use('*', logger());
app.use('*', secureHeaders());

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (allowedOrigins.includes('*')) return origin || '*';
      if (!origin) return allowedOrigins[0]; // non-browser / same-origin
      return allowedOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

// Global fixed-window rate limit per IP (generous — protects the free Overpass/
// Nominatim proxies and the DB from bursts/abuse). Per-route stricter limits
// (e.g. POST /suggestions) stack on top. Tune via RATE_LIMIT_* env vars. Runs
// after CORS so a 429 still carries CORS headers; OPTIONS preflight and the
// /health probe are exempt. One shared instance — creating it per request would
// reset the counters every call.
const globalLimiter = rateLimiter({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max: Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 120,
});
app.use('*', (c, next) =>
  c.req.method === 'OPTIONS' || c.req.path === '/health'
    ? next()
    : globalLimiter(c, next),
);

// Emergency kill switches (admin panel → Emergenza), checked on every write
// (POST/PUT/DELETE). /admin is always exempt so staff can flip them back off;
// GET/OPTIONS always pass, the app stays browsable.
//   maintenance_mode — blocks writes for everyone.
//   beta_mode        — blocks writes unless the caller's app role is
//                      admin / moderator / betatester (the frontend shows the
//                      matching lock screen to everyone else).
const BETA_ROLES = ['admin', 'moderator', 'betatester'];

app.use('*', async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (c.req.path.startsWith('/admin')) return next();
  // Stripe retries must land even in maintenance (signature-verified anyway).
  if (c.req.path === '/stripe/webhook') return next();

  const { data: settings } = await supabase
    .from('app_settings')
    .select('maintenance_mode, beta_mode')
    .eq('id', 1)
    .maybeSingle();

  if (settings?.maintenance_mode) {
    throw new AppError(503, 'MAINTENANCE', 'Sito in manutenzione — scritture disabilitate');
  }

  if (settings?.beta_mode) {
    // Resolve the caller's role from the Bearer token (best-effort: anonymous
    // or invalid token simply means no role → blocked).
    const [scheme, token] = (c.req.header('Authorization') || '').split(' ');
    let role = null;
    if (scheme === 'Bearer' && token) {
      const { data: auth } = await supabase.auth.getUser(token);
      if (auth?.user) {
        const { data: prof } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', auth.user.id)
          .maybeSingle();
        role = prof?.role ?? null;
      }
    }
    if (!BETA_ROLES.includes(role)) {
      throw new AppError(503, 'BETA', 'Beta test in corso — accesso riservato ai beta tester');
    }
  }
  return next();
});

app.route('/health', healthRoutes);
app.route('/bars', barRoutes);
app.route('/places', placeRoutes);
app.route('/bookmarks', bookmarkRoutes);
app.route('/events', eventRoutes);
app.route('/me', meRoutes);
app.route('/leaderboard', leaderboardRoutes);
app.route('/users', userRoutes);
app.route('/admin', adminRoutes);
app.route('/suggestions', suggestionRoutes);
app.route('/reports', reportRoutes);
app.route('/drinks', drinkRoutes);
app.route('/notifications', notificationRoutes);
app.route('/admin/organizers', organizerRoutes);
app.route('/follows', followRoutes);
app.route('/push', pushRoutes);
app.route('/boosts', boostRoutes);
app.route('/stripe', stripeWebhookRoutes);

app.notFound((c) =>
  c.json({ error: 'Not found', code: 'NOT_FOUND', statusCode: 404 }, 404),
);
app.onError(errorHandler);

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`rabar API listening on http://localhost:${info.port}`);
});

startReminderWorker();

export default app;
