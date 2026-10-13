// Controllo dei riquadri usati da /places/nearby. L'errore che conta è uno
// solo: un riquadro troppo stretto, che lascia fuori un bar e gli fa perdere
// voti o sponsorizzazione senza che niente fallisca. Senza dipendenze né rete:
//
//   node src/lib/bbox.check.mjs
import assert from 'node:assert/strict';
import { bboxAround, bboxOf, withinBbox } from './bbox.js';

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function haversineKm(lat1, lng1, lat2, lng2) {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const inside = (b, lat, lng) =>
  lat >= b.minLat && lat <= b.maxLat && (b.minLng === null || (lng >= b.minLng && lng <= b.maxLng));

// Punto a distanza `km` da (lat, lng) lungo la direzione `bearing` (gradi).
function destination(lat, lng, km, bearing) {
  const d = km / R;
  const br = rad(bearing);
  const la1 = rad(lat);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 =
    rad(lng) + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
}

// Il riquadro contiene TUTTO il cerchio: nessun punto entro il raggio resta fuori.
for (const [lat, lng] of [[45.89, 11.04], [0, 0], [64.1, -21.9], [-33.9, 151.2], [52.52, 13.4]]) {
  for (const km of [0.5, 2, 25, 50, 100]) {
    const b = bboxAround(lat, lng, km);
    for (let bearing = 0; bearing < 360; bearing += 5) {
      const [pLat, pLng] = destination(lat, lng, km * 0.999, bearing);
      assert.ok(inside(b, pLat, pLng), `fuori dal riquadro: ${lat},${lng} r=${km} dir=${bearing}`);
    }
    // …e non è largo a caso: l'angolo più lontano sta entro il doppio del raggio.
    if (b.minLng !== null) {
      assert.ok(haversineKm(lat, lng, b.maxLat, b.maxLng) < km * 2, `riquadro troppo largo a ${lat},${lng} r=${km}`);
    }
  }
}

// Rovereto, 50 km: Trento dentro, Milano fuori.
const rovereto = bboxAround(45.8903, 11.0409, 50);
assert.ok(inside(rovereto, 46.0679, 11.1211));
assert.ok(!inside(rovereto, 45.4654, 9.1859));

// Antimeridiano e poli: si rinuncia alla longitudine invece di tagliare a metà.
assert.equal(bboxAround(-17.7, 179.9, 50).minLng, null);
assert.equal(bboxAround(89.95, 10, 50).minLng, null);
assert.ok(inside(bboxAround(-17.7, 179.9, 50), -17.7, -179.9));

// Riquadro di una lista di luoghi, con margine.
const places = [{ lat: 45.88, lng: 11.03 }, { lat: 45.9, lng: 11.06 }, { lat: null, lng: 3 }, {}];
const pb = bboxOf(places, 1);
assert.ok(inside(pb, 45.88, 11.03) && inside(pb, 45.9, 11.06));
assert.ok(inside(pb, 45.873, 11.03), 'il margine di 1 km copre un bar spostato di ~800 m');
assert.ok(!inside(pb, 45.86, 11.03), 'ma non uno a 2 km');
assert.equal(bboxOf([], 1), null);
assert.equal(bboxOf([{ lat: null, lng: null }], 1), null);

// withinBbox: i filtri giusti sulla query, e nessuno se il riquadro manca.
const calls = [];
const q = new Proxy({}, { get: (_, op) => (col, v) => (calls.push([op, col, v]), q) });
withinBbox(q, { minLat: 1, maxLat: 2, minLng: 3, maxLng: 4 });
assert.deepEqual(calls, [['gte', 'lat', 1], ['lte', 'lat', 2], ['gte', 'lng', 3], ['lte', 'lng', 4]]);
calls.length = 0;
withinBbox(q, { minLat: 1, maxLat: 2, minLng: null, maxLng: null });
assert.deepEqual(calls, [['gte', 'lat', 1], ['lte', 'lat', 2]]);
calls.length = 0;
assert.equal(withinBbox(q, null), q);
assert.equal(calls.length, 0);

console.log('bbox ok');
