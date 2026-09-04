import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { tick } from '../lib/reminderWorker.js';
import { supabase } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

// Lavori pianificati, chiamati da uno scheduler ESTERNO (pg_cron + pg_net su
// Supabase). Non c'è auth Supabase: il chiamante è una macchina, non un utente,
// e si autentica con un segreto condiviso nell'header `x-cron-secret`.
//
// Perché fuori dal processo: su Fluid compute l'istanza dorme quando non
// arrivano richieste, quindi un `setInterval` interno — che è com'era prima —
// gira solo per caso, quando c'è traffico, e alla riaccensione sputa fuori
// tutti i promemoria arretrati in una volta.
const cron = new Hono();

/**
 * Confronto a tempo costante. `!==` esce al primo byte diverso e il tempo di
 * risposta racconta quanti byte erano giusti: con un endpoint che si può
 * chiamare quanto si vuole, è un segreto che si indovina un carattere alla
 * volta.
 *
 * Si confrontano gli SHA-256, non i byte: `timingSafeEqual` pretende due buffer
 * della stessa lunghezza, e la guardia `a.length === b.length` che serve a non
 * farlo lanciare è essa stessa un canale — esce prima, e chi prova capisce che
 * la lunghezza indovinata era sbagliata. I digest sono sempre 32 byte, quindi
 * non lancia mai e la lunghezza del segreto non trapela.
 */
function secretOk(given) {
  const expected = process.env.CRON_SECRET;
  if (!expected || !given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** POST /cron/reminders — un giro di promemoria eventi (~3h prima dell'inizio). */
cron.post('/reminders', async (c) => {
  if (!secretOk(c.req.header('x-cron-secret'))) {
    throw new AppError(401, 'UNAUTHORIZED', 'Non autorizzato');
  }
  const reminded = await tick();

  // Pulizia dei bucket scaduti del rate limiting, agganciata qui invece che a un
  // suo scheduler: gira già ogni pochi minuti ed è l'unico lavoro periodico che
  // abbiamo. Senza questa chiamata `rate_limits` non si sarebbe mai svuotata —
  // la funzione esisteva ma non la invocava nessuno, e la tabella avrebbe tenuto
  // una riga per ogni chiamante mai visto, per sempre. Best-effort: la pulizia
  // che fallisce non deve far risultare fallito il giro dei promemoria.
  const { data: pruned, error } = await supabase.rpc('prune_rate_limits');
  if (error) console.error('[cron] prune_rate_limits fallita:', error.message);

  return c.json({ ok: true, reminded, pruned: error ? null : (pruned ?? 0) });
});

export default cron;
