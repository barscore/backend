import 'dotenv/config';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { bodyLimit } from 'hono/body-limit';
import { errorHandler, AppError } from './middleware/errorHandler.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { getWriteSwitches } from './lib/appSettings.js';
import { lookupCaller } from './middleware/auth.js';
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
import plusRoutes from './routes/plus.js';
import stripeWebhookRoutes from './routes/stripeWebhook.js';
import googlePlayRoutes from './routes/googlePlay.js';
import appleNotificationRoutes from './routes/appleNotifications.js';
import admobRoutes from './routes/admob.js';
import cronRoutes from './routes/cron.js';
import authRoutes from './routes/auth.js';
import statsRoutes from './routes/stats.js';

const app = new Hono();

// FRONTEND_URL may be a comma-separated allowlist (localhost + LAN IP + prod
// domain). Use "*" to allow any origin. Needed so iOS Safari / the PWA — served
// from a different origin than the dev box — aren't blocked by CORS.
const parseOrigins = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const allowedOrigins = parseOrigins(process.env.FRONTEND_URL || 'http://localhost:5173');

// ADMIN_URL: le origini del pannello staff (repo `admin/`, separato dal sito).
// Sono le sole da cui un browser può chiamare /admin/*: il sito non ci arriva
// più nemmeno col token di un admin (un XSS lì non tocca l'amministrazione).
// Il ruolo resta controllato da requireRole a ogni chiamata.
const adminOrigins = parseOrigins(process.env.ADMIN_URL || 'http://localhost:5174');
const isAdminPath = (path) => path === '/admin' || path.startsWith('/admin/');

app.use('*', logger());
// Un'API JSON non serve mai HTML né script: la CSP più stretta possibile, così
// una risposta aperta per sbaglio nel browser non può eseguire niente.
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  }),
);

app.use(
  '*',
  cors({
    origin: (origin, c) => {
      if (isAdminPath(c.req.path)) return adminOrigins.includes(origin) ? origin : null;
      if (allowedOrigins.includes('*')) return origin || '*';
      if (!origin) return allowedOrigins[0]; // non-browser / same-origin
      // Il pannello usa anche rotte fuori da /admin (code di moderazione, login).
      return allowedOrigins.includes(origin) || adminOrigins.includes(origin) ? origin : null;
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }),
);

// Il corpo più grosso che un client manda è di qualche KB (un evento, un lotto
// di statistiche, una transazione firmata): oltre la soglia si rifiuta prima di
// leggerlo. Senza limite arrivava fino ai 4,5 MB di Vercel, e zod 3 valida ogni
// elemento di un array anche oltre il suo `.max()`: CPU e memoria regalate a
// chiunque. I webhook dei negozi portano oggetti più grandi e hanno un tetto a
// parte. Dopo CORS, così il 413 ha gli header e il browser lo legge.
const tooLarge = (c) =>
  c.json({ error: 'Richiesta troppo grande', code: 'PAYLOAD_TOO_LARGE', statusCode: 413 }, 413);
const defaultBodyLimit = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
const webhookBodyLimits = {
  '/stripe/webhook': bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge }),
  '/apple/notifications': bodyLimit({ maxSize: 256 * 1024, onError: tooLarge }),
};
app.use('*', (c, next) => (webhookBodyLimits[c.req.path] ?? defaultBodyLimit)(c, next));

// CORS non ferma una richiesta "semplice" né un client fuori dal browser: qui
// /admin/* rifiuta ogni Origin che non sia il pannello. Senza Origin (app
// native, script) passa e decide requireRole come prima.
app.use('*', (c, next) => {
  const origin = c.req.header('origin');
  if (origin && isAdminPath(c.req.path) && !adminOrigins.includes(origin)) {
    throw new AppError(403, 'ADMIN_ORIGIN', 'Pannello staff raggiungibile solo dalla sua origine');
  }
  return next();
});

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
  // Google Play's notifications the same (shared token in the URL).
  if (c.req.path === '/google-play/rtdn') return next();
  // And Apple's (signed JWS): a refund during maintenance must still land.
  if (c.req.path === '/apple/notifications') return next();
  // Same for the scheduler: it authenticates with CRON_SECRET, has no Bearer
  // token, and beta_mode would otherwise silently stop every reminder.
  if (c.req.path.startsWith('/cron/')) return next();
  // Il login non scrive niente: è un POST solo perché porta la password. Senza
  // questa eccezione in beta nessuno (admin compresi) entra con lo username.
  if (c.req.path === '/auth/login') return next();

  // Cached for a few seconds (lib/appSettings.js): this runs on every write.
  const settings = await getWriteSwitches();

  if (settings?.maintenance_mode) {
    throw new AppError(503, 'MAINTENANCE', 'Sito in manutenzione — scritture disabilitate');
  }

  // Le statistiche (scansioni, aperture, ping di attività) non sono contenuti:
  // in beta le mandano anche i visitatori fuori dal test, ed è proprio lì che
  // servono per contarli.
  if (c.req.path.startsWith('/stats/')) return next();

  if (settings?.beta_mode) {
    // Resolve the caller's role from the Bearer token (best-effort: anonymous
    // or invalid token simply means no role → blocked). lookupCaller leaves
    // what it found on the context, so requireAuth doesn't ask Supabase the
    // same two questions again a moment later.
    const caller = await lookupCaller(c);
    if (!BETA_ROLES.includes(caller?.prof?.role ?? null)) {
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
app.route('/plus', plusRoutes);
app.route('/stripe', stripeWebhookRoutes);
app.route('/google-play', googlePlayRoutes);
app.route('/apple', appleNotificationRoutes);
app.route('/admob', admobRoutes);
app.route('/cron', cronRoutes);
app.route('/auth', authRoutes);
app.route('/stats', statsRoutes);

app.notFound((c) =>
  c.json({ error: 'Not found', code: 'NOT_FOUND', statusCode: 404 }, 404),
);
app.onError(errorHandler);

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`rabar API listening on http://localhost:${info.port}`);
});

// I promemoria eventi non hanno più un timer interno: li chiama pg_cron su
// Supabase via POST /cron/reminders. Senza il segreto l'endpoint risponde 401
// a tutti, quindi i promemoria non partirebbero e nessuno se ne accorgerebbe.
if (!process.env.CRON_SECRET) {
  console.warn('[rabar] CRON_SECRET non impostato: /cron/reminders rifiuta tutto, promemoria eventi fermi');
}

export default app;
