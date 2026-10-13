import { supabase } from './supabase.js';

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
 * `{ maintenance_mode, beta_mode }`, oppure `null` se la lettura fallisce.
 * Un fallimento non viene tenuto in memoria e lascia passare la richiesta,
 * come prima: un database che non risponde fermerà comunque l'handler.
 */
export async function getWriteSwitches(now = Date.now()) {
  if (cached && now - cached.at < TTL_MS) return cached.value;
  // Più scritture insieme a cache scaduta: una lettura sola.
  inflight ??= supabase
    .from('app_settings')
    .select('maintenance_mode, beta_mode')
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
