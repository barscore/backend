import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { tick } from '../lib/reminderWorker.js';
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
 */
function secretOk(given) {
  const expected = process.env.CRON_SECRET;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /cron/reminders — un giro di promemoria eventi (~3h prima dell'inizio). */
cron.post('/reminders', async (c) => {
  if (!secretOk(c.req.header('x-cron-secret'))) {
    throw new AppError(401, 'UNAUTHORIZED', 'Non autorizzato');
  }
  return c.json({ ok: true, reminded: await tick() });
});

export default cron;
