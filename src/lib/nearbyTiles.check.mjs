// Controllo dei tasselli di /places/nearby. L'errore che conta è uno solo: un
// bar dentro il raggio che cade in un tassello non letto, e sparisce dalla
// lista senza che niente fallisca. Senza dipendenze né rete:
//
//   node src/lib/nearbyTiles.check.mjs
import assert from 'node:assert/strict';
import { MAX_TILES, splitByTile, tileKey, tileOf, tilesAround, tilesBox, tilesInBox } from './nearbyTiles.js';

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
function haversineKm(lat1, lng1, lat2, lng2) {
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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

// Ogni punto del bordo del cerchio (e appena dentro) sta in un tassello letto.
const centres = [
  [45.4654, 9.1859], // Milano
  [46.0679, 11.1211], // Trento
  [37.5079, 15.083], // Catania
  [60.17, 24.94], // Helsinki: tasselli più stretti in km
  [-33.87, 151.21], // Sydney: latitudine negativa
  [40.7, -74.0], // New York: longitudine negativa
  [45.0, 9.0], // centro esattamente su uno spigolo
];
for (const [lat, lng] of centres) {
  for (const km of [0.5, 1, 2, 3, 7, 25, 100]) {
    const keys = new Set(tilesAround(lat, lng, km).map((t) => t.key));
    for (let bearing = 0; bearing < 360; bearing += 7.5) {
      for (const f of [0.999, 0.5]) {
        const [pl, pg] = destination(lat, lng, km * f, bearing);
        assert.ok(haversineKm(lat, lng, pl, pg) <= km);
        const { tx, ty } = tileOf(pl, pg);
        assert.ok(keys.has(tileKey(tx, ty)), `${lat},${lng} r${km}: punto a ${bearing}° fuori dai tasselli`);
      }
    }
  }
}

// Il primo tassello è quello del centro: è il primo a essere ricaricato.
{
  const [t] = tilesAround(45.4654, 9.1859, 25);
  const own = tileOf(45.4654, 9.1859);
  assert.deepEqual([t.tx, t.ty], [own.tx, own.ty]);
}

// Un raggio da app (≤ 25 km) resta poche centinaia di tasselli; 100 km alle
// nostre latitudini sta sotto il limite.
assert.ok(tilesAround(45.4654, 9.1859, 25).length < 200);
assert.ok(tilesAround(47.0, 11.0, 100).length <= MAX_TILES);
assert.ok(tilesAround(84.0, 0, 100).length > MAX_TILES);

// Il riquadro dei tasselli torna negli stessi tasselli, senza file in più o in
// meno per gli arrotondamenti (45.1 * 20 = 901.9999…).
for (const [lat, lng] of centres) {
  const tiles = tilesAround(lat, lng, 3);
  const back = tilesInBox(tilesBox(tiles)).map((t) => t.key).sort();
  assert.deepEqual(back, tiles.map((t) => t.key).sort());
}

// Ogni luogo finisce nel suo tassello, e i tasselli vuoti del riquadro ci sono.
{
  const tiles = tilesAround(46.0679, 11.1211, 2);
  const box = tilesBox(tiles);
  const places = [
    { lat: 46.0679, lng: 11.1211 },
    { lat: box.s + 1e-6, lng: box.w + 1e-6 },
    { lat: box.n - 1e-6, lng: box.e - 1e-6 },
  ];
  const byTile = splitByTile(places, box);
  assert.equal(byTile.size, tiles.length);
  assert.equal([...byTile.values()].flat().length, places.length);
  for (const [key, list] of byTile) {
    for (const p of list) {
      const { tx, ty } = tileOf(p.lat, p.lng);
      assert.equal(tileKey(tx, ty), key);
    }
  }
}

console.log('nearbyTiles: ok');
