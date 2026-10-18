import { Hono } from 'hono';
import { supabase } from '../lib/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { sharedRateLimiter } from '../middleware/rateLimiter.js';
import { AppError } from '../middleware/errorHandler.js';
import { uuidParam } from '../schemas/common.js';
import { statsEventsSchema, barStatsQuerySchema } from '../schemas/statsSchemas.js';

// Statistiche dei bar: i client mandano le interazioni (scansioni del QR/NFC
// del locale, aperture della scheda, pulsanti), il proprietario legge i
// totali. Tabelle e funzioni in webapp/database/add_bar_stats.sql.
//
// La raccolta è best-effort: un evento che non si scrive non deve mai rompere
// la pagina di chi lo manda, quindi /events risponde 202 anche quando il DB
// rifiuta, e i client non ritentano.
//
// Il dispositivo (UUID casuale del client) non si lega mai a un account: è ciò
// che tiene queste statistiche tra gli strumenti assimilabili ai cookie tecnici
// (linee guida del Garante, 10 giugno 2021), senza consenso. Quindi /events non
// legge il token, e /ping non riceve il dispositivo.
const stats = new Hono();

let lastWriteErrorLogAt = 0;
function logWriteError(what, error) {
  const now = Date.now();
  if (now - lastWriteErrorLogAt < 60_000) return;
  lastWriteErrorLogAt = now;
  console.error(`[stats] ${what} non scritto:`, error?.message || error);
}

/**
 * POST /stats/events — un lotto di interazioni da un dispositivo.
 * Pubblica: le scansioni arrivano soprattutto da chi non ha ancora un account.
 * I client mandano il token come in ogni richiesta, ma qui non si apre: conta
 * solo se c'è («da loggato»), per separare le scansioni anonime nel percorso
 * scansione → registrazione → recensione.
 */
stats.post(
  '/events',
  sharedRateLimiter({ windowMs: 60_000, max: 30, key: 'stats-events' }),
  async (c) => {
    const { visitor_id, events } = statsEventsSchema.parse(await c.req.json());

    const { data, error } = await supabase.rpc('record_bar_events', {
      p_visitor: visitor_id,
      p_signed_in: Boolean(c.req.header('authorization')),
      p_events: events,
    });
    if (error) logWriteError('evento', error);
    return c.json({ recorded: error ? 0 : (data ?? 0) }, 202);
  },
);

/**
 * POST /stats/ping — «sono ancora qui», da chi è loggato, al massimo qualche
 * volta al giorno. Alimenta gli utenti attivi del pannello admin. Il corpo si
 * ignora: i client di prima mandavano il dispositivo, che qui non serve.
 */
stats.post('/ping', requireAuth, async (c) => {
  const { error } = await supabase.rpc('touch_user', { p_user: c.get('user').id });
  if (error) logWriteError('ping', error);
  return c.json({ ok: !error }, 202);
});

/**
 * Le statistiche complete si sbloccano col boost: ce n'è uno attivo, o il bar
 * ne ha pagato almeno uno (chi ha comprato tre giorni a settembre deve poter
 * vedere cos'hanno reso anche a ottobre). Un ordine rimborsato non conta.
 */
async function hasBoost(bar) {
  if (bar.boost_until && new Date(bar.boost_until) > new Date()) return true;
  const { count, error } = await supabase
    .from('boost_orders')
    .select('id', { count: 'exact', head: true })
    .eq('bar_id', bar.id)
    .eq('status', 'paid');
  if (error) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load boosts');
  return (count ?? 0) > 0;
}

/**
 * GET /stats/bars/:id?days=7|30|90 — la scheda statistiche di un bar.
 * Solo il proprietario (bars.owner_id) e l'admin. Base per tutti: aperture
 * dal QR/NFC e recensioni che ne sono nate. Il resto solo col boost (o per
 * l'admin): `advanced` è null finché non c'è.
 */
stats.get('/bars/:id', requireAuth, async (c) => {
  const id = uuidParam(c);
  const { days } = barStatsQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  const user = c.get('user');

  const { data: bar, error: barErr } = await supabase
    .from('bars')
    .select('id, owner_id, boost_until')
    .eq('id', id)
    .maybeSingle();
  if (barErr) throw new AppError(500, 'INTERNAL_ERROR', 'Could not load bar');
  if (!bar) throw new AppError(404, 'NOT_FOUND', 'Bar not found');

  const isAdmin = user.role === 'admin';
  if (bar.owner_id !== user.id && !isAdmin) {
    throw new AppError(403, 'FORBIDDEN', 'Solo il proprietario vede le statistiche del bar');
  }

  const [boosted, { data: s, error }] = await Promise.all([
    hasBoost(bar),
    supabase.rpc('bar_stats', { p_bar: id, p_days: days }),
  ]);
  if (error || !s) {
    console.error('[stats] bar_stats non disponibile:', error?.message);
    throw new AppError(503, 'STATS_UNAVAILABLE', 'Statistiche non disponibili');
  }

  const unlocked = boosted || isAdmin;
  return c.json({
    stats: {
      days,
      boosted,
      unlocked,
      scans: s.scans,
      scan_reviews: s.scan_reviews,
      advanced: unlocked
        ? {
            reviews: s.reviews,
            funnel: s.funnel,
            returning: s.returning,
            views: s.views,
            impressions: s.impressions,
            actions: s.actions,
            daily: s.daily ?? [],
          }
        : null,
    },
  });
});

export default stats;
