import { supabase } from './supabase.js';
import { notify } from './notify.js';

const REMIND_BEFORE_MS = 3 * 60 * 60 * 1000; // ~3h before start

/**
 * Un giro di promemoria: gli eventi che iniziano entro la finestra, non
 * annullati e non ancora avvisati. `reminder_sent_at` viene scritto anche
 * senza follower, così la scansione si accorcia da sola.
 *
 * Lo chiama `POST /cron/reminders` da uno scheduler esterno, non un timer
 * interno: su Fluid compute il processo dorme quando non arrivano richieste.
 *
 * Ritorna quanti eventi ha lavorato — è quello che finisce nel log del cron.
 */
export async function tick() {
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
  if (error || !due?.length) return 0;

  let done = 0;
  for (const ev of due) {
    // Si marca PRIMA di avvisare, e solo se la riga era ancora libera: due
    // giri sovrapposti (uno lento più il successivo) altrimenti manderebbero
    // il promemoria due volte a tutti. `notify` è best-effort e non solleva
    // mai, quindi anticiparlo non fa perdere niente che non fosse già perso.
    const { data: claimed } = await supabase
      .from('events')
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq('id', ev.id)
      .is('reminder_sent_at', null)
      .select('id')
      .maybeSingle();
    if (!claimed) continue;

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
    done++;
  }
  return done;
}
