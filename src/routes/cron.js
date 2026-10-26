import { Hono } from 'hono';
import { tick } from '../lib/reminderWorker.js';
import { supabase } from '../lib/supabase.js';
import { pruneShared } from '../lib/nearbyStore.js';
import { TILE_VERSION } from '../lib/nearbyTiles.js';
import { sameSecret } from '../lib/secret.js';
import { googlePlayConfigured } from '../lib/googlePlay.js';
import { syncGoogleSubscription } from '../lib/plus.js';
import { AppError } from '../middleware/errorHandler.js';

const NEARBY_SHARED_MAX_AGE_MS = Number(process.env.NEARBY_CACHE_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000;

// Lavori pianificati, chiamati da uno scheduler ESTERNO (pg_cron + pg_net su
// Supabase). Non c'è auth Supabase: il chiamante è una macchina, non un utente,
// e si autentica con un segreto condiviso nell'header `x-cron-secret`.
//
// Perché fuori dal processo: su Fluid compute l'istanza dorme quando non
// arrivano richieste, quindi un `setInterval` interno — che è com'era prima —
// gira solo per caso, quando c'è traffico, e alla riaccensione sputa fuori
// tutti i promemoria arretrati in una volta.
const cron = new Hono();

/** CRON_SECRET, confrontato a tempo costante (lib/secret.js). */
const secretOk = (given) => sameSecret(given, process.env.CRON_SECRET);

/**
 * Abbonamenti Google Play arrivati a fine periodo senza notizie.
 *
 * I rinnovi arrivano dalle notifiche in tempo reale (routes/googlePlay.js), ma
 * se il topic Pub/Sub non è configurato — o una notifica si perde — chi ha
 * rinnovato resterebbe senza rabar+ fino al prossimo avvio dell'app. Qui si
 * rilegge da Google lo stato di chi risulta attivo con il periodo già scaduto:
 * rinnovato ⇒ nuova scadenza, scaduto ⇒ `canceled` e fuori da questa lista.
 * Pochi per giro: il cron passa ogni pochi minuti. Best-effort.
 */
async function refreshLapsedGoogle() {
  if (!googlePlayConfigured()) return 0;
  const { data: rows, error } = await supabase
    .from('plus_subscriptions')
    .select('google_purchase_token')
    .eq('provider', 'google')
    .in('status', ['active', 'past_due'])
    .lt('current_period_end', new Date().toISOString())
    .not('google_purchase_token', 'is', null)
    .limit(10);
  if (error) {
    console.error('[cron] abbonamenti Google non letti:', error.message);
    return 0;
  }
  let done = 0;
  for (const row of rows ?? []) {
    try {
      const synced = await syncGoogleSubscription(row.google_purchase_token);
      // Token che Google non conosce più (scaduto da tempo): non c'è niente da
      // rinnovare, e senza chiuderlo qui tornerebbe in lista a ogni giro.
      if (!synced) {
        await supabase
          .from('plus_subscriptions')
          .update({ status: 'canceled', updated_at: new Date().toISOString() })
          .eq('google_purchase_token', row.google_purchase_token);
      }
      done++;
    } catch (e) {
      console.error('[cron] refresh Google non riuscito:', e.message);
    }
  }
  return done;
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

  // Stesso discorso per la cache condivisa dei luoghi: i tasselli restano (si
  // aggiornano da soli, vedi routes/places.js), le chiavi di versioni vecchie e
  // i segni di query rimasti appesi oltre la settimana sono solo spazio occupato.
  const nearbyPruned = await pruneShared(NEARBY_SHARED_MAX_AGE_MS, `${TILE_VERSION}:`);

  const googleRefreshed = await refreshLapsedGoogle();

  // Statistiche dei bar: eventi e legami dispositivo-account oltre i 13 mesi
  // dichiarati nell'informativa (add_bar_stats.sql).
  const { data: statsPruned, error: statsErr } = await supabase.rpc('prune_bar_stats');
  if (statsErr) console.error('[cron] prune_bar_stats fallita:', statsErr.message);

  return c.json({
    ok: true,
    reminded,
    pruned: error ? null : (pruned ?? 0),
    nearby_pruned: nearbyPruned,
    google_refreshed: googleRefreshed,
    stats_pruned: statsErr ? null : (statsPruned ?? 0),
  });
});

export default cron;
