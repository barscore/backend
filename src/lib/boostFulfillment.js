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
export async function applyBoost({ event_id, bar_id, tier }) {
  const days = TIERS[tier]?.days;
  if (!days) return;

  const table = event_id ? 'events' : 'bars';
  const targetId = event_id ?? bar_id;

  const { data: row } = await supabase
    .from(table)
    .select('boost_until')
    .eq('id', targetId)
    .maybeSingle();

  const base =
    row?.boost_until && new Date(row.boost_until) > new Date()
      ? new Date(row.boost_until)
      : new Date();
  const until = new Date(base.getTime() + days * 86_400_000).toISOString();

  await supabase.from(table).update({ boost_until: until }).eq('id', targetId);
}
