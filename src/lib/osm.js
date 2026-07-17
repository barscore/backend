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
const OVERPASS_URLS = (process.env.OVERPASS_URL
  ? process.env.OVERPASS_URL.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      // mail.ru sometimes hangs for minutes — safe here because the race
      // aborts losers; one extra healthy mirror matters from cloud IPs, which
      // the public mirrors rate-limit far more aggressively than home IPs.
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ]);
const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const UA = process.env.OSM_USER_AGENT || 'rabar/1.0 (https://github.com/rabar; contact: admin@rabar.app)';
const OVERPASS_TIMEOUT_MS = Number(process.env.OVERPASS_TIMEOUT_MS) || 20000;

// Fire the query at every mirror simultaneously; resolve with the first 200.
// Each attempt aborts on timeout; losers are aborted once a winner is found so
// no hung connection (mail.ru-style 109s) leaks. Overpass accepts the raw
// query as the POST body.
async function overpassFetch(query, timeoutMs = OVERPASS_TIMEOUT_MS) {
  const controllers = OVERPASS_URLS.map(() => new AbortController());
  const timers = [];
  try {
    const attempts = OVERPASS_URLS.map((url, i) => {
      const ctrl = controllers[i];
      timers.push(setTimeout(() => ctrl.abort(), timeoutMs));
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': UA },
        body: query,
        signal: ctrl.signal,
      }).then(async (res) => {
        if (!res.ok) throw new Error(`Overpass ${res.status} (${url})`);
        return res.json();
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

function mapElement(el) {
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
    website: tags.website || tags['contact:website'] || null,
    // Raw OSM opening_hours string. The client hides bars that close before
    // 23:00 local time (time-dependent, so NOT baked into the nearby cache).
    opening_hours: tags.opening_hours || null,
    // OSM occasionally carries an `image` tag (often a Wikimedia/Commons URL).
    cover_image_url: tags.image || null,
  };
}

/**
 * Find bars/pubs/biergartens/nightclubs/cafes within `radiusKm` of (lat, lng)
 * via Overpass. Cafes are included because the Italian "bar" is usually tagged
 * `amenity=cafe` in OSM (`amenity=bar` means cocktail bar there); the client's
 * open-until-23 filter keeps daytime-only coffee shops off the map. Nightclubs
 * (discoteche) come back tagged `amenity=nightclub` so the client can
 * distinguish them from bars. Returns normalized POIs (not persisted).
 */
// Great-circle distance in km (Haversine). Used to trim the bbox square below
// back to the requested circular radius; also reused by routes/places.js for
// result sorting/subtitles.
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

export async function findNearbyBars(lat, lng, radiusKm = 2) {
  // Scale the Overpass server-side timeout AND our client abort with the radius.
  // A 100km query scans vastly more data than a 2km one; with a fixed 15s/20s
  // budget every large radius 504s or aborts ("fa fatica"). Grows ~1s per km,
  // capped at 120s so a pathological area can't hang a request forever.
  const serverTimeout = Math.min(120, Math.max(25, Math.round(radiusKm) + 20));
  // Bounding-box query instead of `(around:...)`: an `around` filter makes
  // Overpass compute a great-circle distance for EVERY candidate node, which
  // 504s/429s on large radii. A bbox is a cheap spatial-index range scan; we
  // trim the square back to the requested circle in JS (haversine) below.
  const dLat = radiusKm / 111; // ~111 km per degree latitude
  const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1);
  const bbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`; // S,W,N,E
  // Above ~30km, drop `way` matches: resolving each way's centroid (`out center`)
  // is what makes big-radius queries 504 on public mirrors. Bars mapped as
  // building polygons are rare vs. nodes, so a wide-area search stays reliable at
  // the cost of a few polygon-only venues.
  const wayClause =
    radiusKm > 30
      ? ''
      : `way["amenity"~"^(bar|pub|biergarten|nightclub|cafe)$"](${bbox});`;
  const query = `
    [out:json][timeout:${serverTimeout}];
    (
      node["amenity"~"^(bar|pub|biergarten|nightclub|cafe)$"](${bbox});
      ${wayClause}
    );
    out center tags;`;

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
  return (data.elements || [])
    .map(mapElement)
    .filter(Boolean)
    .filter((p) => haversineKm(lat, lng, p.lat, p.lng) <= radiusKm);
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
