import { Hono } from 'hono';
import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findNearbyBars, geocode, searchBars, haversineKm } from '../lib/osm.js';
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
const NEARBY_TTL_MS = Number(process.env.NEARBY_CACHE_TTL_MS) || 30 * 60 * 1000; // fresh window
const NEARBY_MAX_AGE_MS = Number(process.env.NEARBY_CACHE_MAX_AGE_MS) || 7 * 24 * 60 * 60 * 1000; // serve-stale window
const NEARBY_CACHE_MAX = 2000;
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

function cacheSet(key, places) {
  if (nearbyCache.size >= NEARBY_CACHE_MAX && !nearbyCache.has(key)) {
    nearbyCache.delete(nearbyCache.keys().next().value); // evict oldest
  }
  nearbyCache.set(key, { at: Date.now(), places });
  persistToDisk();
}

// Dedupe: many clients hitting the same cold key trigger ONE upstream fetch.
function fetchAndCache(key, lat, lng, radius_km) {
  if (inflight.has(key)) return inflight.get(key);
  const p = findNearbyBars(lat, lng, radius_km)
    .then((places) => {
      cacheSet(key, places);
      return places;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

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
    // PostgREST hang ~9s then fail. The `bars` table is small (only persisted,
    // community-added venues), so fetch them all once and match in JS.
    const wanted = new Set(osmPlaces.map((p) => String(p.osm_node_id)));
    const { data } = await supabase
      .from('bars')
      .select('id, osm_node_id, boost_until, bar_ratings_summary(avg_overall, total_ratings)')
      .not('osm_node_id', 'is', null)
      .limit(10000);
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
 * the viewer. `haveOsm` / `haveId` are the ids already in the /nearby result —
 * a sponsored bar the viewer is *also* near stays where it is (already flagged
 * by enrichWithRatings), it isn't added twice.
 */
async function nearbySponsoredExtras(lat, lng, haveOsm, haveId) {
  // NB: niente `osm_type` nella select — quella colonna su `bars` non esiste e
  // non è mai esistita (nessuna migrazione la crea). Chiederla faceva fallire
  // l'INTERA query con 42703, e siccome l'errore non veniva letto la funzione
  // restituiva una lista vuota: il raggio di visibilità, che è a pagamento, non
  // ha mai iniettato un solo bar sulla mappa. `osm_type` lo mettiamo nella
  // forma di uscita più sotto, dove serve davvero.
  const { data, error } = await supabase
    .from('bars')
    .select(
      'id, osm_node_id, name, address, city, lat, lng, phone, website, opening_hours, cover_image_url, sponsor_radius_km, bar_ratings_summary(avg_overall, total_ratings)',
    )
    .eq('is_active', true)
    .gt('boost_until', new Date().toISOString())
    .not('sponsor_radius_km', 'is', null)
    // Clients type a place's osm_node_id as non-null — an admin bar with no OSM
    // node can't ride this list (it also has no map pin).
    .not('osm_node_id', 'is', null);

  // Rumoroso, non silenzioso: qui si consegna merce pagata, e una lista vuota è
  // indistinguibile da "nessuno ha comprato un boost". È il motivo per cui il
  // bug è passato inosservato — /nearby continuava a rispondere 200.
  if (error) {
    console.error('[places] sponsored extras non caricati:', error.message);
    return [];
  }

  return (data ?? [])
    .filter((b) => !haveId.has(b.id) && !haveOsm.has(String(b.osm_node_id)))
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
    .filter((b) => b.distance_km <= Math.min(b.sponsor_radius_km, 50));
}

/** Prepend the out-of-radius sponsored bars to an enriched /nearby result. */
async function withSponsoredExtras(enriched, lat, lng) {
  const haveOsm = new Set(enriched.map((p) => String(p.osm_node_id)));
  const haveId = new Set(enriched.map((p) => p.id).filter(Boolean));
  const extras = await nearbySponsoredExtras(lat, lng, haveOsm, haveId);
  return extras.length ? [...extras, ...enriched] : enriched;
}

const nearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_km: z.coerce.number().positive().max(100).optional().default(2),
});

const searchSchema = z.object({
  q: z.string().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(20).optional().default(5),
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
  const cached = nearbyCache.get(key);
  const age = cached ? Date.now() - cached.at : Infinity;

  try {
    let results;
    if (cached && age < NEARBY_MAX_AGE_MS) {
      // Serve cache instantly. If past the fresh window, refresh in background
      // (fire-and-forget) so the NEXT load is fresh — this user waits 0s.
      results = cached.places;
      if (age > NEARBY_TTL_MS) fetchAndCache(key, lat, lng, radius_km).catch(() => {});
    } else {
      // Cold or too stale to trust — the one unavoidable slow fetch.
      results = await fetchAndCache(key, lat, lng, radius_km);
    }
    const enriched = await enrichWithRatings(results, lat, lng);
    return c.json({ places: await withSponsoredExtras(enriched, lat, lng) });
  } catch (e) {
    // Upstream dead but we have *some* cache → serve it rather than 502.
    if (cached) {
      const enriched = await enrichWithRatings(cached.places, lat, lng);
      return c.json({ places: await withSponsoredExtras(enriched, lat, lng), stale: true });
    }
    throw new AppError(502, 'UPSTREAM_ERROR', 'OpenStreetMap query failed');
  }
});

/**
 * GET /places/bars — global free-text bar search (whole planet). Unlike
 * /nearby, ignores distance so a user anywhere can find a bar by name.
 * Enriched with community ratings; distance_km set only when lat/lng given.
 */
places.get('/bars', async (c) => {
  const { q, limit, lat, lng } = barSearchSchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  try {
    const bias = lat != null && lng != null ? [lat, lng] : null;
    const results = await searchBars(q, limit, bias);
    const enriched = await enrichWithRatings(results, lat ?? null, lng ?? null);
    return c.json({ places: enriched });
  } catch (e) {
    throw new AppError(502, 'UPSTREAM_ERROR', 'Bar search failed');
  }
});

/** GET /places/search — geocode a free-text place/address via Nominatim. */
places.get('/search', async (c) => {
  const { q, limit } = searchSchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  try {
    const results = await geocode(q, limit);
    return c.json({ results });
  } catch (e) {
    throw new AppError(502, 'UPSTREAM_ERROR', 'Geocoding failed');
  }
});

export default places;
