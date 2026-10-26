import { supabase } from './supabase.js';

// Cache dei risultati di Overpass condivisa tra le istanze, su Postgres, a
// tasselli (lib/nearbyTiles.js).
//
// La cache di routes/places.js vive nella memoria (e nel /tmp) di UNA istanza.
// Su Vercel le istanze nascono e muoiono di continuo, e ognuna nuova ripartiva
// da zero: il primo visitatore che le capitava aspettava Overpass — 10-20
// secondi, a volte un 502 — per una zona che un'altra istanza aveva già in
// mano. Con questa tabella un'istanza fredda chiede prima al database (decine
// di millisecondi) e a Overpass solo se non l'ha chiesto ancora nessuno.
//
// Tutto best-effort: finché `add_nearby_cache.sql` non è stata eseguita la
// tabella non esiste, le letture tornano vuote e si continua come prima.

const TABLE = 'nearby_cache';
// Un tassello di 0,05° nel centro di Milano ne ha qualche centinaio: oltre
// questa soglia la riga è un errore, non un quartiere.
const MAX_PLACES = 5000;

let warned = false;
function unavailable(what, error) {
  if (warned) return;
  warned = true;
  console.warn(`[places] cache condivisa non disponibile (${what}): ${error.message}`);
}

// Le chiavi di un `.in()` finiscono nell'URL di PostgREST: oltre qualche KB la
// richiesta si pianta (vedi enrichWithRatings). Cento chiavi sono ~1,5 KB.
const READ_CHUNK = 100;
// I tasselli di una città sono centinaia di KB ciascuno: a blocchi, perché un
// corpo da decine di MB non lo accetta nessuno.
const WRITE_CHUNK = 25;

/**
 * Le voci salvate per le chiavi date, come `Map(key → { at, places })`. Quelle
 * che non ci sono mancano dalla mappa; se la tabella non risponde la mappa è
 * vuota e si va avanti come senza cache.
 */
export async function readTiles(keys) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < keys.length; i += READ_CHUNK) chunks.push(keys.slice(i, i + READ_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) => supabase.from(TABLE).select('key, places, fetched_at').in('key', chunk)),
  );
  for (const { data, error } of results) {
    if (error) {
      unavailable('lettura', error);
      continue;
    }
    for (const row of data ?? []) {
      const at = new Date(row.fetched_at).getTime();
      if (Array.isArray(row.places) && Number.isFinite(at)) out.set(row.key, { at, places: row.places });
    }
  }
  return out;
}

/**
 * Salva i tasselli (`Map(key → places)`) con la data in cui i dati sono stati
 * presi. Non lancia mai: una cache che non si scrive non deve far fallire la
 * richiesta. Ritorna se è andata (lo script di seed lo controlla).
 */
export async function writeTiles(tiles, at = Date.now()) {
  const fetched_at = new Date(at).toISOString();
  const rows = [...tiles]
    .filter(([, places]) => Array.isArray(places) && places.length <= MAX_PLACES)
    .map(([key, places]) => ({ key, places, fetched_at }));
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const { error } = await supabase.from(TABLE).upsert(rows.slice(i, i + WRITE_CHUNK));
    if (error) {
      unavailable('scrittura', error);
      return false;
    }
  }
  return true;
}

// Una query a Overpass in corso, segnata nella stessa tabella. Le istanze di
// Vercel non si vedono fra loro: senza questo segno il client che richiede la
// stessa zona fredda dopo pochi secondi finiva su un'altra istanza, che
// lanciava una seconda query identica — e i mirror pubblici, che danno due
// posti per IP, rifiutavano proprio quella che serviva.
const LOCK_PREFIX = 'lock:';

/**
 * Prende il turno per scaricare la zona `id`: true se tocca a noi, false se
 * un'altra istanza la sta già scaricando da meno di `ttlMs`. Senza tabella
 * tocca sempre a noi, come prima.
 */
export async function claimFetch(id, ttlMs) {
  const key = LOCK_PREFIX + id;
  // Un segno scaduto è di una query morta (o fallita): si toglie e si riprova.
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const { error: delError } = await supabase.from(TABLE).delete().eq('key', key).lt('fetched_at', cutoff);
  if (delError) {
    unavailable('turno', delError);
    return true;
  }
  const { data, error } = await supabase
    .from(TABLE)
    .upsert({ key, places: [], fetched_at: new Date().toISOString() }, { onConflict: 'key', ignoreDuplicates: true })
    .select('key');
  if (error) {
    unavailable('turno', error);
    return true;
  }
  return data.length > 0;
}

/** Il turno finito bene: i tasselli sono salvati, il segno non serve più. */
export async function releaseFetch(id) {
  await supabase.from(TABLE).delete().eq('key', LOCK_PREFIX + id);
}

/**
 * Pulizia periodica. I tasselli della versione corrente restano: sono la
 * mappa dei locali, che si aggiorna da sola quando invecchia (routes/places.js)
 * e che lo script di seed riempie in blocco. Va via tutto il resto oltre
 * `maxAgeMs`: le voci con chiavi di versioni precedenti e i segni di turno
 * rimasti da query fallite. Ritorna quante, o null se fallisce.
 */
export async function pruneShared(maxAgeMs, keepPrefix) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const { error, count } = await supabase
    .from(TABLE)
    .delete({ count: 'exact' })
    .lt('fetched_at', cutoff)
    .not('key', 'like', `${keepPrefix}%`);
  if (error) {
    unavailable('pulizia', error);
    return null;
  }
  return count ?? 0;
}
