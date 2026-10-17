import { supabase } from './supabase.js';
import { AppError } from '../middleware/errorHandler.js';

// Gli interruttori di emergenza (manutenzione, beta) vengono letti a OGNI
// scrittura dal gate in index.js. Sono una riga sola che cambia qualche volta
// all'anno: qui resta in memoria per TTL_MS, così un voto o un segnalibro non
// pagano un round-trip al database solo per sentirsi dire «tutto acceso».
//
// Il prezzo è un ritardo: su Vercel le istanze sono più d'una, e un'istanza
// diversa da quella che ha ricevuto il PUT /admin/settings vede il cambio al
// massimo dopo TTL_MS. Per un interruttore tirato a mano è accettabile; quella
// che riceve il PUT lo vede subito (invalidateWriteSwitches).
const TTL_MS = 30_000;

let cached = null; // { at, value }
let inflight = null;

/**
 * La riga di `app_settings` (`maintenance_mode`, `beta_mode`,
 * `monetization_enabled`, …), oppure `null` se la lettura fallisce.
 * Un fallimento non viene tenuto in memoria e lascia passare la richiesta,
 * come prima: un database che non risponde fermerà comunque l'handler.
 */
export async function getWriteSwitches(now = Date.now()) {
  if (cached && now - cached.at < TTL_MS) return cached.value;
  // Più scritture insieme a cache scaduta: una lettura sola.
  // `*` e non l'elenco delle colonne: una colonna nuova non ancora creata dalla
  // sua migration farebbe fallire tutta la select, e con lei la manutenzione e
  // la beta, che a lettura fallita lasciano passare.
  inflight ??= supabase
    .from('app_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle()
    .then(({ data, error }) => {
      if (error || !data) return null;
      cached = { at: Date.now(), value: data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Da chiamare dopo aver scritto `app_settings`. */
export function invalidateWriteSwitches() {
  cached = null;
}

/**
 * Interruttore della monetizzazione (pannello admin → Emergenza). Va chiamato
 * da ogni rotta che apre un pagamento, prima di toccare Stripe o di aprire un
 * ordine per Apple / Google: lì nessuno ha ancora pagato, quindi rifiutare non
 * lascia nessuno addebitato senza quello che ha comprato. Le verifiche degli
 * acquisti già fatti e i webhook restano aperti per lo stesso motivo.
 *
 * Al contrario del gate di manutenzione è fail-closed: se la riga non si legge,
 * o la colonna non esiste ancora, la monetizzazione è spenta.
 */
export async function assertMonetizationEnabled() {
  const settings = await getWriteSwitches();
  if (settings?.monetization_enabled !== true) {
    throw new AppError(503, 'MONETIZATION_OFF', 'Acquisti momentaneamente non disponibili');
  }
}
