import { sanitizeHttpUrl } from './url.js';

// Free OpenStreetMap data sources — no API key required.
//   - Overpass API: query bars/pubs around a point
//   - Nominatim:     geocode a free-text place/address
// Both are free public endpoints; respect their usage policy by sending a
// descriptive User-Agent and not hammering them.

// Overpass public mirrors, RACED in parallel (not sequential). Each mirror has
// wildly variable latency (.de ~9s, others 406/504/hang), so we fire all at
// once and take the first HTTP 200 — bounding latency to the fastest healthy
// mirror instead of summing timeouts. Override with a comma-separated
// OVERPASS_URL.
// VK's instance (maps.mail.ru) is the one that stayed up on 2026-10-14, when
// the other three all 504'd or hung for a whole morning: with only those three
// every area not already cached came back 502.
const OVERPASS_URLS = (process.env.OVERPASS_URL
  ? process.env.OVERPASS_URL.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ]);
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const UA = process.env.OSM_USER_AGENT || 'rabar/1.0 (https://github.com/rabar; contact: martino.parisi@rabar.it)';
const OVERPASS_TIMEOUT_MS = Number(process.env.OVERPASS_TIMEOUT_MS) || 20000;

// Fire the query at every mirror simultaneously; resolve with the first 200.
// Each attempt aborts on timeout; losers are aborted once a winner is found so
// no hung connection (a sick mirror can sit there for 100s+) leaks. Overpass
// accepts the raw query as the POST body.
async function overpassFetch(query, timeoutMs = OVERPASS_TIMEOUT_MS) {
  const controllers = OVERPASS_URLS.map(() => new AbortController());
  const timers = [];
  try {
    const attempts = OVERPASS_URLS.map((url, i) => {
      const ctrl = controllers[i];
      timers.push(setTimeout(() => ctrl.abort(), timeoutMs));
      const once = () =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'User-Agent': UA },
          body: query,
          signal: ctrl.signal,
        }).then(async (res) => {
          if (!res.ok) {
            res.body?.cancel().catch(() => {});
            throw new Error(`Overpass ${res.status} (${url})`);
          }
          return res.json();
        });
      // A mirror that refuses at once (504 "too busy", 429) is often free again
      // a couple of seconds later, while the others may hang for the whole
      // timeout: one retry of the quick refusals, within the same budget.
      const started = Date.now();
      return once().catch(async (e) => {
        if (ctrl.signal.aborted || Date.now() - started > 10_000) throw e;
        await new Promise((r) => setTimeout(r, 2000));
        return once();
      });
    });
    // Promise.any → first fulfilled wins; rejects only if ALL fail.
    return await Promise.any(attempts);
  } catch (e) {
    // AggregateError when every mirror failed.
    const msg = e.errors?.map((x) => x.message).join('; ') || e.message;
    throw new Error(`Overpass unreachable: ${msg}`);
  } finally {
    controllers.forEach((c) => c.abort()); // cancel stragglers
    timers.forEach(clearTimeout);
  }
}

// Build a single-line street address from OSM address tags.
function formatAddress(tags = {}) {
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  return [street, tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(', ');
}

// Exported for scripts/seed-nearby-tiles.mjs: a seeded tile and one loaded
// here must hold places of exactly the same shape.
export function mapElement(el) {
  const tags = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (lat == null || lng == null) return null;
  // Drop venues with no name from the map — nameless OSM POIs are noise.
  const name = tags.name?.trim();
  if (!name) return null;
  return {
    osm_node_id: el.id,
    osm_type: el.type, // node | way | relation
    name,
    amenity: tags.amenity,
    address: formatAddress(tags),
    city: tags['addr:city'] || null,
    lat,
    lng,
    phone: tags.phone || tags['contact:phone'] || null,
    // Anyone can edit an OSM tag, so every URL leaving here is filtered to
    // http(s) once, at the source — a `javascript:` website tag must never
    // reach a caller that puts it in an href.
    website: sanitizeHttpUrl(tags.website || tags['contact:website']),
    // Raw OSM opening_hours string. The client hides bars that close before
    // 23:00 local time (time-dependent, so NOT baked into the nearby cache).
    opening_hours: tags.opening_hours || null,
    // OSM occasionally carries an `image` tag (often a Wikimedia/Commons URL).
    cover_image_url: sanitizeHttpUrl(tags.image),
  };
}

// Great-circle distance in km (Haversine). Used to trim a bbox square back to
// the requested circular radius; also reused by routes/places.js for result
// sorting/subtitles.
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// The `amenity` values that make a venue. Cafes are included because the
// Italian "bar" is usually tagged `amenity=cafe` in OSM (`amenity=bar` means
// cocktail bar there); the client's open-until-23 filter keeps daytime-only
// coffee shops off the map. Nightclubs (discoteche) come back tagged
// `amenity=nightclub` so the client can distinguish them from bars. Shared
// with scripts/seed-nearby-tiles.mjs, which must pick exactly the same venues.
export const NEARBY_AMENITIES = ['bar', 'pub', 'biergarten', 'nightclub', 'cafe'];

/**
 * Every venue inside a box (`s`, `w`, `n`, `e` in degrees) via Overpass, as
 * normalized POIs (not persisted). The box is what routes/places.js asks for:
 * the tiles it has no data for.
 */
export async function findBarsInBox({ s, w, n, e }) {
  const midLat = ((s + n) / 2) * (Math.PI / 180);
  const halfSpanKm = (Math.max(n - s, (e - w) * Math.cos(midLat)) * 111) / 2;
  // Scale the Overpass server-side timeout AND our client abort with the area.
  // A 100km query scans vastly more data than a 2km one; with a fixed 15s/20s
  // budget every large area 504s or aborts ("fa fatica"). Grows ~1s per km,
  // capped at 120s so a pathological area can't hang a request forever.
  const serverTimeout = Math.min(120, Math.max(25, Math.round(halfSpanKm) + 20));
  // Bounding-box query instead of `(around:...)`: an `around` filter makes
  // Overpass compute a great-circle distance for EVERY candidate node, which
  // 504s/429s on large areas. A bbox is a cheap spatial-index range scan.
  const bbox = `${s},${w},${n},${e}`;
  const filter = `["amenity"~"^(${NEARBY_AMENITIES.join('|')})$"](${bbox})`;
  // Above ~30km, drop `way` matches: resolving each way's centroid (`out center`)
  // is what makes big queries 504 on public mirrors. Bars mapped as building
  // polygons are rare vs. nodes, so a wide-area search stays reliable at the
  // cost of a few polygon-only venues.
  const wayClause = halfSpanKm > 30 ? '' : `way${filter};`;
  const query = `
    [out:json][timeout:${serverTimeout}];
    (
      node${filter};
      ${wayClause}
    );
    out tags center qt;`;

  // Give the client abort a margin over the server-side timeout so the mirror
  // gets to return its own (partial) result instead of us cutting it off.
  // One automatic retry: public mirrors 504/abort in bursts (especially for
  // cloud IPs); a second pass a moment later usually finds a healthy one.
  let data;
  try {
    data = await overpassFetch(query, (serverTimeout + 15) * 1000);
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    data = await overpassFetch(query, (serverTimeout + 15) * 1000);
  }
  // A query that ran out of time or memory on the mirror still comes back 200,
  // with whatever it had found so far and the reason in `remark`. Saved as a
  // tile, that partial list would replace a complete one: it is a failure.
  if (/runtime error|timed out|out of memory/i.test(data.remark || '')) {
    throw new Error(`Overpass incomplete: ${data.remark}`);
  }
  return (data.elements || []).map(mapElement).filter(Boolean);
}

/**
 * Fetch a single OSM element (node/way/relation) by id via Overpass.
 * Used to backfill a bar's details when the client only knows its OSM id.
 * Returns a normalized POI, or null if not found.
 */
export async function fetchElement(osmType, osmId) {
  const type = ['node', 'way', 'relation'].includes(osmType) ? osmType : 'node';
  const query = `[out:json][timeout:25];${type}(${osmId});out center tags;`;

  const data = await overpassFetch(query);
  const el = (data.elements || [])[0];
  return el ? mapElement(el) : null;
}

/**
 * Geocode a free-text query (place name or address) via Nominatim.
 * Returns up to `limit` candidates with coordinates.
 */
export async function geocode(query, limit = 5) {
  const url = `${NOMINATIM_URL}/search?format=jsonv2&limit=${limit}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);
  const data = await res.json();
  return (data || []).map((r) => ({
    display_name: r.display_name,
    lat: Number(r.lat),
    lng: Number(r.lon),
    type: r.type,
  }));
}

// Drink/food venues we treat as "bar-like". Broad on purpose: OSM tags many
// real bars as cafe/restaurant, so a strict bar-only filter loses them.
const VENUE_AMENITIES = new Set([
  'bar', 'pub', 'biergarten', 'nightclub', 'cafe', 'restaurant', 'fast_food', 'ice_cream', 'food_court',
]);

/** Un luogo che la mappa e la ricerca mostrano come locale (POST /bars/resolve). */
export const isVenueAmenity = (amenity) => VENUE_AMENITIES.has(amenity);

// Photon (komoot) — free, no key, built for as-you-type OSM POI search. Unlike
// the Nominatim geocoder it handles partial names/typos and isn't 1-req/s
// rate-limited, so it's the right backend for a live search box.
const PHOTON_URL = process.env.PHOTON_URL || 'https://photon.komoot.io';
const PHOTON_LETTER = { N: 'node', W: 'way', R: 'relation' };

/**
 * Global free-text bar search via Photon (whole planet). Lets a user in Munich
 * find a bar in Trento by (partial) name. `bias` [lat,lng] only ranks nearer
 * hits first — results stay worldwide. Output matches the nearby-bar shape.
 */
export async function searchBars(query, limit = 20, bias = null) {
  // `osm_tag=amenity` (key only) restricts to amenities server-side so venues
  // aren't crowded out of the top results by a same-named town/street. We then
  // narrow to bar-like values in JS.
  let url = `${PHOTON_URL}/api/?limit=${limit}&osm_tag=amenity&q=${encodeURIComponent(query)}`;
  if (bias && bias[0] != null && bias[1] != null) url += `&lat=${bias[0]}&lon=${bias[1]}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Photon error ${res.status}`);
  const data = await res.json();
  // Filter to bar-like venues in JS — Photon's repeated osm_tag param is
  // unreliable (drops results), so we over-fetch and narrow here.
  return (data.features || [])
    .filter((f) => {
      const p = f.properties || {};
      const c = f.geometry?.coordinates;
      return p.osm_id && Array.isArray(c) && p.name && p.osm_key === 'amenity' && VENUE_AMENITIES.has(p.osm_value);
    })
    .map((f) => {
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      return {
        osm_node_id: p.osm_id,
        osm_type: PHOTON_LETTER[p.osm_type] || 'node',
        name: p.name,
        amenity: p.osm_value || null,
        address: [p.street, p.housenumber].filter(Boolean).join(' ') || null,
        city: p.city || p.town || p.village || p.county || null,
        lat: Number(lat),
        lng: Number(lng),
        phone: null,
        website: null,
        cover_image_url: null,
      };
    });
}

// Photon `type` values that name an area you could look for bars in.
const AREA_TYPES = new Set(['city', 'district', 'locality', 'county', 'state', 'country']);
const ADDRESS_TYPES = new Set(['street', 'house']);
// POIs come from searchBars; here they would only crowd out the places.
const POI_KEYS = new Set(['amenity', 'shop', 'tourism', 'leisure', 'office', 'craft']);

/**
 * Places and addresses as you type, via Photon: cities, districts, streets,
 * house numbers. Unlike Nominatim it tolerates partial words and typos and has
 * no 1-request-per-second limit, which a live search box needs.
 *
 * `kind` tells the clients what to do with a hit: an `area` recentres the
 * search there, an `address` places an event. `type` keeps the OSM value
 * (city, town, village…) the older clients filter on.
 */
export async function searchPlaces(query, limit = 6, bias = null) {
  let url = `${PHOTON_URL}/api/?limit=${Math.min(limit * 2, 20)}&q=${encodeURIComponent(query)}`;
  if (bias && bias[0] != null && bias[1] != null) url += `&lat=${bias[0]}&lon=${bias[1]}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Photon error ${res.status}`);
  const data = await res.json();
  const seen = new Set();
  const out = [];
  for (const f of data.features || []) {
    const p = f.properties || {};
    const c = f.geometry?.coordinates;
    if (!Array.isArray(c) || POI_KEYS.has(p.osm_key)) continue;
    const kind = AREA_TYPES.has(p.type) ? 'area' : ADDRESS_TYPES.has(p.type) ? 'address' : 'place';
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const name = p.type === 'house' ? street || p.name : p.name || street;
    if (!name) continue;
    const locality = p.city || p.town || p.village || p.district;
    const subtitle = [...new Set([locality, p.county, p.state, p.country])]
      .filter((v) => v && v !== name)
      .slice(0, 2)
      .join(', ');
    const display = subtitle ? `${name}, ${subtitle}` : name;
    if (seen.has(display)) continue;
    seen.add(display);
    out.push({
      display_name: display,
      name,
      subtitle: subtitle || null,
      lat: Number(c[1]),
      lng: Number(c[0]),
      type: p.osm_value || p.type || null,
      kind,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Reverse geocode a lat/lng via Nominatim.
 */
export async function reverseGeocode(lat, lng) {
  const url = `${NOMINATIM_URL}/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);
  const data = await res.json();
  if (!data || data.error) return null;
  const a = data.address || {};
  return {
    address: [a.road, a.house_number].filter(Boolean).join(' ') || null,
    city: a.city || a.town || a.village || a.county || null,
  };
}
