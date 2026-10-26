import { Hono } from 'hono';
import { z } from 'zod';
import { waitUntil } from '@vercel/functions';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findNearbyBars, geocode, searchBars, searchPlaces, haversineKm } from '../lib/osm.js';
import { dbPatterns, relevance } from '../lib/searchText.js';
import { bboxAround, bboxOf, withinBbox } from '../lib/bbox.js';
import { readShared, writeShared } from '../lib/nearbyStore.js';
import { supabase } from '../lib/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

// Free OSM-backed discovery: find bars + geocode addresses. No API key.
const places = new Hono();

// --- Nearby cache (stale-while-revalidate, disk-persistent) -----------------
// Overpass is slow (~9-20s) and the only healthy public mirror. So we never let
// a user wait on it twice: results are cached per rounded coord+radius. Two
// windows:
//   * FRESH  (< TTL)      → serve from cache, no upstream hit.
//   * STALE  (TTL..MAX)   → serve cache instantly AND refresh in background.
//   * cold/expired        → the one unavoidable slow fetch.
// The cache is persisted to disk so it survives `--watch` reloads and restarts
// (the reason it felt "slow as before" — in-memory Map was wiped on every save).
// Memory and disk belong to ONE instance. Behind them sits a table shared by
// all of them (lib/nearbyStore.js): a brand-new instance asks it before asking
// Overpass, so the slow fetch is paid once per area, not once per cold start.
const NEARBY_TTL_MS = Number(process.env.NEARBY_CACHE_TTL_MS) || 30 * 60 * 1000; // fresh window
const NEARBY_MAX_AGE_MS = Number(process.env.NEARBY_CACHE_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000; // serve-stale window
const NEARBY_CACHE_MAX = 2000;
// How long a cold request waits on Overpass before falling back to the bars in
// our own table. Below the clients' own timeouts (60 s on the apps).
const COLD_FALLBACK_MS = Number(process.env.NEARBY_COLD_FALLBACK_MS) || 25 * 1000;
// With nothing in our table to fall back on, how much longer to wait before
// answering "empty for now, retry" (`stale: true`).
const COLD_EMPTY_WAIT_MS = Number(process.env.NEARBY_COLD_EMPTY_WAIT_MS) || 20 * 1000;
// On Vercel the bundle filesystem is read-only — only /tmp is writable (and it
// survives between requests on the same warm instance, which is what this cache
// wants). Locally it stays next to the repo so `--watch` reloads keep it.
const CACHE_FILE = resolve(
  process.env.NEARBY_CACHE_FILE ||
    (process.env.VERCEL ? '/tmp/rabar-nearby.json' : './.cache/nearby.json'),
);

const nearbyCache = new Map(); // key -> { at, places }
const inflight = new Map(); // key -> Promise (dedupe concurrent upstream fetches)

// ~1.1km grid at the equator — coarse enough to share cache across nearby
// clicks, fine enough not to miss bars for the given radius. The `v` prefix is a
// schema version: bump it whenever the Overpass query changes (e.g. adding
// nightclubs) so old cached results without the new POIs are ignored.
const CACHE_VERSION = 'v5'; // v5: cafes added to the Overpass query
const cacheKey = (lat, lng, r) => `${CACHE_VERSION}:${lat.toFixed(2)},${lng.toFixed(2)},${r}`;

function loadCacheFromDisk() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) nearbyCache.set(k, v);
  } catch {
    /* no cache file yet — fine */
  }
}
loadCacheFromDisk();

let persistTimer = null;
function persistToDisk() {
  // Debounced: batch rapid writes into one flush.
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(nearbyCache)));
    } catch {
      /* disk cache is best-effort */
    }
  }, 2000);
}

// `at` is when the places were fetched from Overpass — now, unless the entry
// comes from the shared table and another instance fetched it earlier.
function cacheSet(key, places, at = Date.now()) {
  if (nearbyCache.size >= NEARBY_CACHE_MAX && !nearbyCache.has(key)) {
    nearbyCache.delete(nearbyCache.keys().next().value); // evict oldest
  }
  nearbyCache.set(key, { at, places });
  persistToDisk();
}

// A fetch that must outlive the response. On Vercel the instance is frozen the
// moment the response is out, and a fire-and-forget Overpass call froze with it:
// the cache was never filled, so every retry of a cold area fell back to the
// handful of bars in our own table again — a new city, or a wider radius,
// never showed more than those. `waitUntil` keeps the instance up until it
// settles; outside Vercel it is a no-op and the promise just runs.
function keepAlive(promise) {
  waitUntil(promise.catch(() => {}));
}

// Dedupe: many clients hitting the same cold key trigger ONE upstream fetch.
function fetchAndCache(key, lat, lng, radius_km) {
  if (inflight.has(key)) return inflight.get(key);
  const p = findNearbyBars(lat, lng, radius_km)
    .then(async (places) => {
      cacheSet(key, places);
      // Awaited, not fired and forgotten: a serverless instance can be frozen
      // the moment the response is out, and this write is what spares the next
      // instance the wait. It costs milliseconds on a request that took seconds.
      await writeShared(key, places);
      return places;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// A persisted bar keeps the coordinates it had when it was saved; the OSM node
// may have been nudged since. The box around the places is widened by this
// much so a bar that moved a few hundred metres still gets its ratings.
const BAR_DRIFT_KM = 1;

// A boost is never shown further than this from the viewer, whatever radius
// the owner paid for.
const SPONSOR_MAX_KM = 50;

/**
 * Overlay community ratings onto raw OSM places, matched by osm_node_id.
 * Each place gains: `id` (our DB uuid when the bar is already persisted, else
 * null), `avg_overall`, `total_ratings`, and `distance_km`.
 */
async function enrichWithRatings(osmPlaces, lat, lng) {
  let byOsm = new Map();
  if (osmPlaces.length) {
    // Don't filter by the OSM ids: an Overpass result can hold 1000+ places, and
    // a `.in('osm_node_id', [1300 huge ints])` builds a ~13KB GET URL that makes
    // PostgREST hang ~9s then fail. Filter by AREA instead — only the bars
    // inside the box that holds these places can match — and match the ids in
    // JS. Without it every map pan downloaded the whole table plus its join.
    const wanted = new Set(osmPlaces.map((p) => String(p.osm_node_id)));
    const { data } = await withinBbox(
      supabase
        .from('bars')
        .select('id, osm_node_id, accepts_free_drinks, free_drinks_hours, boost_until, bar_ratings_summary(avg_overall, total_ratings)')
        .not('osm_node_id', 'is', null),
      bboxOf(osmPlaces, BAR_DRIFT_KM),
    ).limit(10000);
    byOsm = new Map(
      (data ?? [])
        .filter((b) => wanted.has(String(b.osm_node_id)))
        .map((b) => [String(b.osm_node_id), b]),
    );
  }
  const now = Date.now();
  return osmPlaces.map((p) => {
    const match = byOsm.get(String(p.osm_node_id));
    return {
      ...p,
      id: match?.id ?? null,
      accepts_free_drinks: match?.accepts_free_drinks ?? false,
      free_drinks_hours: match?.free_drinks_hours ?? null,
      avg_overall: match?.bar_ratings_summary?.avg_overall ?? 0,
      total_ratings: match?.bar_ratings_summary?.total_ratings ?? 0,
      sponsored: !!match?.boost_until && new Date(match.boost_until).getTime() > now,
      distance_km:
        lat != null && lng != null
          ? Math.round(haversineKm(lat, lng, p.lat, p.lng) * 100) / 100
          : null,
    };
  });
}

/**
 * Sponsored bars that the owner paid to show beyond the viewer's own radius.
 * Returned shaped like an OSM place (so clients render them in the same list),
 * flagged `sponsored: true`, and only within `min(sponsor_radius_km, 50)` km of
 * the viewer. The ones already in the /nearby result are dropped by the caller.
 */
async function nearbySponsored(lat, lng) {
  // NB: niente `osm_type` nella select — quella colonna su `bars` non esiste e
  // non è mai esistita (nessuna migrazione la crea). Chiederla faceva fallire
  // l'INTERA query con 42703, e siccome l'errore non veniva letto la funzione
  // restituiva una lista vuota: il raggio di visibilità, che è a pagamento, non
  // ha mai iniettato un solo bar sulla mappa. `osm_type` lo mettiamo nella
  // forma di uscita più sotto, dove serve davvero.
  const { data, error } = await withinBbox(
    supabase
      .from('bars')
      .select(
        'id, osm_node_id, name, address, city, lat, lng, phone, website, opening_hours, cover_image_url, sponsor_radius_km, accepts_free_drinks, free_drinks_hours, bar_ratings_summary(avg_overall, total_ratings)',
      )
      .eq('is_active', true)
      .gt('boost_until', new Date().toISOString())
      .not('sponsor_radius_km', 'is', null)
      // Clients type a place's osm_node_id as non-null — an admin bar with no OSM
      // node can't ride this list (it also has no map pin).
      .not('osm_node_id', 'is', null),
    // Nothing further than the cap can pass the distance filter below: no
    // point reading the boosted bars of another country.
    bboxAround(lat, lng, SPONSOR_MAX_KM),
  );

  // Rumoroso, non silenzioso: qui si consegna merce pagata, e una lista vuota è
  // indistinguibile da "nessuno ha comprato un boost". È il motivo per cui il
  // bug è passato inosservato — /nearby continuava a rispondere 200.
  if (error) {
    console.error('[places] sponsored extras non caricati:', error.message);
    return [];
  }

  return (data ?? [])
    .map((b) => ({
      ...b,
      // I luoghi da Overpass portano osm_type; questi vengono dal database, che
      // non lo memorizza. 'node' è il default che assume anche il client
      // (utils/score.js#barKey) e lo stesso di resolveBarSchema.
      osm_type: 'node',
      distance_km: Math.round(haversineKm(lat, lng, b.lat, b.lng) * 100) / 100,
      avg_overall: b.bar_ratings_summary?.avg_overall ?? 0,
      total_ratings: b.bar_ratings_summary?.total_ratings ?? 0,
      sponsored: true,
      bar_ratings_summary: undefined,
    }))
    .filter((b) => b.distance_km <= Math.min(b.sponsor_radius_km, SPONSOR_MAX_KM));
}

/**
 * Last resort when Overpass is down and nothing is cached for the area: the
 * bars already in our own table, shaped like OSM places. It is only the venues
 * somebody has opened, rated or claimed — not the whole map — but those are the
 * ones with something to show, and a short list beats a 502: on 2026-10-14 every
 * public mirror 504'd for a morning and every client showed "no bars".
 */
async function nearbyFromDb(lat, lng, radiusKm) {
  const { data, error } = await withinBbox(
    supabase
      .from('bars')
      .select('osm_node_id, name, address, city, lat, lng, phone, website, opening_hours, cover_image_url')
      .eq('is_active', true)
      // Same contract as the sponsored extras: a place without an OSM node has
      // no key on the clients.
      .not('osm_node_id', 'is', null),
    bboxAround(lat, lng, radiusKm),
  ).limit(2000);
  if (error) {
    console.error('[places] ripiego dal database fallito:', error.message);
    return [];
  }
  return (data ?? [])
    .filter((b) => haversineKm(lat, lng, b.lat, b.lng) <= radiusKm)
    .map((b) => ({
      ...b,
      osm_type: 'node',
      // `opening_hours` is JSONB on `bars`; the clients read the raw OSM string.
      opening_hours: typeof b.opening_hours === 'string' ? b.opening_hours : null,
    }));
}

/**
 * The /nearby payload: OSM places with their ratings, plus the out-of-radius
 * sponsored bars in front. The two reads don't depend on each other, so they
 * run together. A sponsored bar the viewer is *also* near stays where it is
 * (already flagged by enrichWithRatings) — it isn't added twice.
 */
async function nearbyPayload(osmPlaces, lat, lng) {
  const [enriched, sponsored] = await Promise.all([
    enrichWithRatings(osmPlaces, lat, lng),
    nearbySponsored(lat, lng),
  ]);
  const haveOsm = new Set(enriched.map((p) => String(p.osm_node_id)));
  const haveId = new Set(enriched.map((p) => p.id).filter(Boolean));
  const extras = sponsored.filter((b) => !haveId.has(b.id) && !haveOsm.has(String(b.osm_node_id)));
  const payload = extras.length ? [...extras, ...enriched] : enriched;
  await countImpressions(payload);
  return payload;
}

// Quante volte un bar è uscito sulla mappa o nella lista: il numero «comparse»
// delle statistiche del proprietario (add_bar_stats.sql). Solo i bar che
// esistono nel nostro DB, gli altri non hanno un proprietario a cui mostrarlo.
// Al massimo IMPRESSIONS_WAIT_MS di attesa: è un contatore, la mappa non deve
// aspettarlo se il DB rallenta.
const IMPRESSIONS_WAIT_MS = 400;
let lastImpressionsLogAt = 0;

function countImpressions(places) {
  const ids = [...new Set(places.map((p) => p.id).filter(Boolean))].slice(0, 500);
  if (!ids.length) return Promise.resolve();
  const write = supabase.rpc('bump_bar_impressions', { p_bar_ids: ids }).then(({ error }) => {
    if (error && Date.now() - lastImpressionsLogAt > 60_000) {
      lastImpressionsLogAt = Date.now();
      console.error('[places] comparse non contate:', error.message);
    }
  }, () => {});
  let timer;
  return Promise.race([
    write,
    new Promise((r) => { timer = setTimeout(r, IMPRESSIONS_WAIT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

const nearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_km: z.coerce.number().positive().max(100).optional().default(2),
});

const searchSchema = z.object({
  q: z.string().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
  // Optional origin: ranks nearer places first, results stay worldwide.
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

const barSearchSchema = z.object({
  q: z.string().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(20).optional().default(12),
  // Optional origin — used only to compute distance_km for the results.
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

/** GET /places/nearby — bars/pubs around a point, straight from OpenStreetMap. */
places.get('/nearby', async (c) => {
  const { lat, lng, radius_km } = nearbySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const key = cacheKey(lat, lng, radius_km);
  let cached = nearbyCache.get(key);
  let age = cached ? Date.now() - cached.at : Infinity;

  // Nothing usable in this instance: before paying for Overpass, see whether
  // another instance already did.
  if (age >= NEARBY_MAX_AGE_MS) {
    const shared = await readShared(key);
    if (shared && Date.now() - shared.at < NEARBY_MAX_AGE_MS) {
      cacheSet(key, shared.places, shared.at);
      cached = nearbyCache.get(key);
      age = Date.now() - cached.at;
    }
  }

  // Read at most once per request: the cold path may already have asked.
  let fromDb = null;
  try {
    let results;
    if (cached && age < NEARBY_MAX_AGE_MS) {
      // Serve cache instantly. If past the fresh window, refresh in background
      // (fire-and-forget) so the NEXT load is fresh — this user waits 0s.
      results = cached.places;
      if (age > NEARBY_TTL_MS) keepAlive(fetchAndCache(key, lat, lng, radius_km));
    } else {
      // Cold or too stale to trust — the one unavoidable slow fetch. With
      // both attempts it can run past 80 s, longer than any client waits; past
      // COLD_FALLBACK_MS the area's bars from our own table go out instead,
      // while Overpass keeps going and fills the cache for the next request.
      const upstream = fetchAndCache(key, lat, lng, radius_km);
      let timer;
      results = await Promise.race([
        upstream,
        new Promise((r) => { timer = setTimeout(() => r(null), COLD_FALLBACK_MS); }),
      ]).finally(() => clearTimeout(timer));
      if (results === null) {
        fromDb = await nearbyFromDb(lat, lng, radius_km);
        if (fromDb.length) {
          // The partial list goes out now; Overpass has to finish anyway, or
          // the client's retry finds the area just as cold as before.
          keepAlive(upstream);
          return c.json({ places: await nearbyPayload(fromDb, lat, lng), stale: true });
        }
        // Nothing of ours here either. A little longer on Overpass, but not past
        // what the apps wait (60 s): an empty `stale` answer tells the client to
        // ask again shortly, a timeout only tells it something broke.
        results = await Promise.race([
          upstream,
          new Promise((r) => { timer = setTimeout(() => r(null), COLD_EMPTY_WAIT_MS); }),
        ]).finally(() => clearTimeout(timer));
        if (results === null) {
          keepAlive(upstream);
          return c.json({ places: [], stale: true });
        }
      }
    }
    return c.json({ places: await nearbyPayload(results, lat, lng) });
  } catch (e) {
    // Upstream dead but we have *some* cache → serve it rather than 502.
    if (cached) {
      return c.json({ places: await nearbyPayload(cached.places, lat, lng), stale: true });
    }
    // No cache either: what our own table knows about the area. Not cached —
    // the next request should try Overpass again, not inherit a partial list.
    console.error('[places] Overpass non raggiungibile, ripiego dal database:', e.message);
    fromDb ??= await nearbyFromDb(lat, lng, radius_km);
    if (fromDb.length) {
      return c.json({ places: await nearbyPayload(fromDb, lat, lng), stale: true });
    }
    throw new AppError(502, 'UPSTREAM_ERROR', 'OpenStreetMap query failed');
  }
});

/**
 * Bars in our own table whose name contains one of the query words. Photon
 * alone missed venues the community knows by a name OSM spells differently,
 * and ranked a rated bar below an unrated namesake on the other side of town.
 */
async function searchDbBars(q) {
  const patterns = dbPatterns(q);
  if (!patterns.length) return [];
  const { data, error } = await supabase
    .from('bars')
    .select('osm_node_id, name, address, city, lat, lng, phone, website, cover_image_url')
    .eq('is_active', true)
    // Clients key a search hit by its OSM node, like everything on the map.
    .not('osm_node_id', 'is', null)
    .or(patterns.map((p) => `name.ilike.%${p}%`).join(','))
    .limit(60);
  if (error) {
    console.error('[places] ricerca nel database fallita:', error.message);
    return [];
  }
  return (data ?? []).map((b) => ({ ...b, osm_type: 'node', amenity: null }));
}

/**
 * GET /places/bars — global free-text bar search (whole planet), as natural as
 * we can make it: Photon and our own table together, ranked by how well the
 * name matches what was typed (accents, word order, prefixes and typos don't
 * matter — see lib/searchText.js), then by ratings and distance.
 * distance_km set only when lat/lng given.
 */
places.get('/bars', async (c) => {
  const { q, limit, lat, lng } = barSearchSchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const bias = lat != null && lng != null ? [lat, lng] : null;
  const [fromOsm, fromDb] = await Promise.all([
    searchBars(q, 25, bias).catch((e) => {
      console.error('[places] Photon non raggiungibile:', e.message);
      return null;
    }),
    searchDbBars(q),
  ]);
  if (fromOsm === null && !fromDb.length) {
    throw new AppError(502, 'UPSTREAM_ERROR', 'Bar search failed');
  }

  // One entry per OSM node; Photon's copy wins (it has the amenity), ours
  // fills what it lacks.
  const byNode = new Map();
  (fromOsm ?? []).forEach((p, rank) => byNode.set(String(p.osm_node_id), { ...p, rank }));
  for (const b of fromDb) {
    const key = String(b.osm_node_id);
    const prev = byNode.get(key);
    byNode.set(key, prev ? { ...b, ...Object.fromEntries(Object.entries(prev).filter(([, v]) => v != null)) } : b);
  }

  const enriched = await enrichWithRatings([...byNode.values()], lat ?? null, lng ?? null);
  const total = fromOsm?.length || 1;
  const scored = enriched
    .map((p) => {
      let score = relevance(q, p.name, [p.address, p.city].filter(Boolean).join(' '));
      // Photon matched it on something we can't see (an alternative name): a
      // floor for its top hits, never above a real name match.
      if (score === 0 && p.rank != null && p.rank < 5) score = 0.05;
      if (score === 0) return null;
      if (p.rank != null) score += 0.1 * (1 - p.rank / total);
      if (p.total_ratings > 0) score += 0.15;
      if (p.sponsored) score += 0.05;
      if (p.distance_km != null) score += 0.3 * Math.exp(-p.distance_km / 15);
      return { ...p, rank: undefined, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...p }) => p);
  return c.json({ places: scored });
});

/**
 * GET /places/search — places and addresses as you type: cities to look for
 * bars in, streets and house numbers to put an event at. Photon first (partial
 * words, typos, no rate limit); Nominatim if Photon is down.
 */
places.get('/search', async (c) => {
  const { q, limit, lat, lng } = searchSchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const bias = lat != null && lng != null ? [lat, lng] : null;
  try {
    return c.json({ results: await searchPlaces(q, limit, bias) });
  } catch (e) {
    console.error('[places] Photon non raggiungibile, provo Nominatim:', e.message);
  }
  try {
    const results = await geocode(q, limit);
    return c.json({ results: results.map((r) => ({ ...r, name: r.display_name, subtitle: null, kind: 'place' })) });
  } catch (e) {
    throw new AppError(502, 'UPSTREAM_ERROR', 'Geocoding failed');
  }
});

export default places;
