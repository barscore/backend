import { supabase } from './supabase.js';
import { notify } from './notify.js';

const REMIND_BEFORE_MS = 3 * 60 * 60 * 1000; // ~3h before start
const TICK_MS = 5 * 60_000;

// Events starting within the window, not cancelled, not yet reminded.
// reminder_sent_at is set even with zero followers so the scan shrinks.
async function tick() {
  const now = new Date();
  const horizon = new Date(now.getTime() + REMIND_BEFORE_MS);
  const { data: due, error } = await supabase
    .from('events')
    .select('id, title, starts_at')
    .is('cancelled_at', null)
    .is('reminder_sent_at', null)
    .gte('starts_at', now.toISOString())
    .lte('starts_at', horizon.toISOString())
    .limit(50);
  if (error || !due?.length) return;

  for (const ev of due) {
    const { data: fans } = await supabase
      .from('follows')
      .select('user_id')
      .eq('event_id', ev.id);
    if (fans?.length) {
      await notify(fans.map((f) => f.user_id), {
        type: 'event_reminder',
        title: `Tra poco: ${ev.title}`,
        body: `Inizia ${new Date(ev.starts_at).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}.`,
        link: '/?tab=eventi',
      });
    }
    await supabase
      .from('events')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', ev.id);
  }
}

// ponytail: in-process timer — reminders pause while the API is down and fire
// on restart; move to pg_cron + Edge Function if that ever matters.
export function startReminderWorker() {
  tick().catch(() => {});
  setInterval(() => tick().catch(() => {}), TICK_MS);
}
