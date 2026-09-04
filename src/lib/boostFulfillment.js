import { supabase } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';

/**
 * Boost lengths and prices. Prices are server-side only — the client never
 * sends an amount. On iOS the price shown comes from StoreKit instead, but the
 * days still come from here.
 */
export const TIERS = {
  '3d': { days: 3, amount_cents: Number(process.env.BOOST_PRICE_3D_CENTS) || 300 },
  '7d': { days: 7, amount_cents: Number(process.env.BOOST_PRICE_7D_CENTS) || 600 },
  '30d': { days: 30, amount_cents: Number(process.env.BOOST_PRICE_30D_CENTS) || 2000 },
};

/**
 * Extra visibility radius for a bar boost (km). Chosen on a 1..50 slider at
 * checkout; a sponsored bar then shows up — and ranks first — for anyone within
 * that distance, even outside their own search radius. 50 is the hard ceiling,
 * enforced again in the SQL RPCs.
 */
export const SPONSOR_RADIUS_MIN_KM = 1;
export const SPONSOR_RADIUS_MAX_KM = 50;

/** Radius surcharge rate: cents per km per day. Tunable, defaults to 1.5. */
export const RADIUS_CENTS_PER_KM_PER_DAY =
  Number(process.env.BOOST_RADIUS_CENTS_PER_KM_PER_DAY) || 1.5;

/**
 * Price added on top of the duration tier for the chosen radius.
 * `radius_km` null/0 (e.g. an event boost, or a legacy bar boost) ⇒ no surcharge.
 */
export function radiusSurchargeCents(days, radiusKm) {
  if (!radiusKm || !days) return 0;
  const capped = Math.min(Math.max(radiusKm, SPONSOR_RADIUS_MIN_KM), SPONSOR_RADIUS_MAX_KM);
  return Math.round(RADIUS_CENTS_PER_KM_PER_DAY * capped * days);
}

/**
 * Ownership gate for a boost target: your own event, or a bar you have claimed.
 * Runs before anyone is charged, on both the Stripe and the Apple path — which
 * is why it lives here rather than inside either one.
 *
 * Returns the label used on the Stripe line item.
 */
export async function assertOwnsTarget(user, { event_id, bar_id, days }) {
  if (event_id) {
    const { data: ev } = await supabase
      .from('events')
      .select('id, title, created_by, cancelled_at, starts_at, ends_at')
      .eq('id', event_id)
      .maybeSingle();
    if (!ev || ev.created_by !== user.id) {
      throw new AppError(404, 'NOT_FOUND', 'Evento non trovato');
    }
    if (ev.cancelled_at) throw new AppError(400, 'VALIDATION_ERROR', 'Evento annullato');
    if (new Date(ev.ends_at ?? ev.starts_at) < new Date()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Evento già concluso');
    }
    return `Boost evento "${ev.title}" — ${days} giorni`;
  }

  const { data: bar } = await supabase
    .from('bars')
    .select('id, name, owner_id')
    .eq('id', bar_id)
    .maybeSingle();
  if (!bar || bar.owner_id !== user.id) {
    throw new AppError(404, 'NOT_FOUND', 'Bar non trovato');
  }
  return `Boost bar "${bar.name}" — ${days} giorni`;
}

/**
 * Extends `boost_until` on the order's target. Purchases stack: buying again
 * while a boost is still running extends from its end, not from now.
 *
 * Shared by the Stripe webhook and the Apple verification endpoint so the two
 * payment providers can never drift on what a boost actually does.
 */
export async function applyBoost({ event_id, bar_id, tier, sponsor_radius_km }) {
  const days = TIERS[tier]?.days;
  if (!days) return;

  const table = event_id ? 'events' : 'bars';
  const targetId = event_id ?? bar_id;

  const { data: row } = await supabase
    .from(table)
    .select(bar_id ? 'boost_until, sponsor_radius_km' : 'boost_until')
    .eq('id', targetId)
    .maybeSingle();

  const stillActive = row?.boost_until && new Date(row.boost_until) > new Date();
  const base = stillActive ? new Date(row.boost_until) : new Date();
  const until = new Date(base.getTime() + days * 86_400_000).toISOString();

  const update = { boost_until: until };
  // Bar boosts carry a visibility radius; stacking keeps the larger one while a
  // boost is still running so a cheap top-up can't shrink an existing reach.
  if (bar_id && sponsor_radius_km) {
    update.sponsor_radius_km = stillActive
      ? Math.max(row?.sponsor_radius_km || 0, sponsor_radius_km)
      : sponsor_radius_km;
  }

  await supabase.from(table).update(update).eq('id', targetId);
}

/**
 * New `boost_until` after taking `days` back off it. Subtracts instead of
 * clearing because purchases stack (see applyBoost): whoever bought three
 * boosts and got one refunded must keep the two he paid for.
 *
 * Anything landing in the past becomes null: queries all filter on
 * `boost_until > NOW()`, so a stale date and null behave the same — null just
 * reads better. Falsy `days` (unknown tier) means "nothing to take back".
 *
 * Pure on purpose: it is the only part of revokeBoost worth testing, and the
 * self-check at the bottom of this file runs without a database.
 */
export function revokedUntil(currentUntil, days, now = new Date()) {
  if (!days || !currentUntil) return currentUntil ?? null;
  const until = new Date(new Date(currentUntil).getTime() - days * 86_400_000);
  return until > now ? until.toISOString() : null;
}

/**
 * Mirror image of applyBoost: takes the tier's days back off the target when a
 * boost is refunded or charged back. Same table, same days, opposite sign.
 *
 * Called by the Stripe webhook on charge.refunded / charge.dispute.created;
 * the caller is the one that keeps it idempotent (the order flips paid→refunded
 * only once), so a redelivery can't strip the days twice.
 */
export async function revokeBoost({ event_id, bar_id, tier }) {
  const days = TIERS[tier]?.days;
  if (!days) return;

  const table = event_id ? 'events' : 'bars';
  const targetId = event_id ?? bar_id;

  const { data: row } = await supabase
    .from(table)
    .select('boost_until')
    .eq('id', targetId)
    .maybeSingle();

  const until = revokedUntil(row?.boost_until, days);
  const update = { boost_until: until };
  // The radius only goes away when the boost does: if stacked days survive the
  // refund the bar is still sponsored, and it still needs its reach.
  if (bar_id && until === null) update.sponsor_radius_km = null;

  await supabase.from(table).update(update).eq('id', targetId);
}

// --- self-check: `SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x node src/lib/boostFulfillment.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  const eq = (a, b, m) => {
    if (a !== b) throw new Error(`${m}: expected ${b}, got ${a}`);
  };
  eq(radiusSurchargeCents(7, null), 0, 'no radius ⇒ no surcharge');
  eq(radiusSurchargeCents(0, 25), 0, 'no days ⇒ no surcharge');
  eq(radiusSurchargeCents(7, 25), Math.round(1.5 * 25 * 7), '7d / 25km');
  eq(radiusSurchargeCents(30, 50), Math.round(1.5 * 50 * 30), '30d / 50km');
  eq(radiusSurchargeCents(7, 999), radiusSurchargeCents(7, 50), 'radius capped at 50');
  eq(radiusSurchargeCents(7, 0.2), radiusSurchargeCents(7, 1), 'radius floored at 1');

  const now = new Date('2026-01-10T00:00:00.000Z');
  const at = (days) => new Date(now.getTime() + days * 86_400_000).toISOString();
  eq(revokedUntil(at(3), 3, now), null, 'lone 3d boost revoked ⇒ null');
  eq(revokedUntil(at(10), 3, now), at(7), 'stacked 3d+7d, 3d revoked ⇒ the 7d survives');
  eq(revokedUntil(at(7), TIERS['1d']?.days, now), at(7), 'unknown tier ⇒ untouched');
  eq(revokedUntil(at(-1), 3, now), null, 'already expired ⇒ null');
  eq(revokedUntil(null, 3, now), null, 'no boost at all ⇒ null');

  console.log('boostFulfillment self-check ok');
}
