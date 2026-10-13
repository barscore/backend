import { supabase } from './supabase.js';

// Cache dei risultati di Overpass condivisa tra le istanze, su Postgres.
//
// La cache di routes/places.js vive nella memoria (e nel /tmp) di UNA istanza.
// Su Vercel le istanze nascono e muoiono di continuo, e ognuna nuova ripartiva
// da zero: il primo visitatore che le capitava aspettava Overpass — 10-20
// secondi, a volte un 502 — per una zona che un'altra istanza aveva già in
// mano. Con questa tabella un'istanza fredda chiede prima al database (decine
// di millisecondi) e a Overpass solo se non l'ha chiesto ancora nessuno.
//
// Tutto best-effort: finché `add_nearby_cache.sql` non è stata eseguita la
// tabella non esiste, le letture tornano null e si continua come prima.

const TABLE = 'nearby_cache';
// Un raggio enorme su una metropoli sono migliaia di luoghi e qualche MB di
// JSON: oltre questa soglia la riga non vale lo spazio che occupa.
const MAX_PLACES = 5000;

let warned = false;
function unavailable(what, error) {
  if (warned) return;
  warned = true;
  console.warn(`[places] cache condivisa non disponibile (${what}): ${error.message}`);
}

/** `{ at, places }` come le voci della cache in memoria, o null. */
export async function readShared(key) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('places, fetched_at')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    unavailable('lettura', error);
    return null;
  }
  if (!data || !Array.isArray(data.places)) return null;
  const at = new Date(data.fetched_at).getTime();
  return Number.isFinite(at) ? { at, places: data.places } : null;
}

/** Non lancia mai: una cache che non si scrive non deve far fallire la richiesta. */
export async function writeShared(key, places) {
  if (!Array.isArray(places) || places.length > MAX_PLACES) return;
  const { error } = await supabase
    .from(TABLE)
    .upsert({ key, places, fetched_at: new Date().toISOString() });
  if (error) unavailable('scrittura', error);
}

/** Toglie le voci più vecchie di `maxAgeMs`. Ritorna quante, o null se fallisce. */
export async function pruneShared(maxAgeMs) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const { error, count } = await supabase.from(TABLE).delete({ count: 'exact' }).lt('fetched_at', cutoff);
  if (error) {
    unavailable('pulizia', error);
    return null;
  }
  return count ?? 0;
}
