// Riempie in blocco i tasselli di /places/nearby da estratti OpenStreetMap.
//
// Senza seed ogni zona mai vista costa una query a Overpass: 25-40 secondi sui
// mirror pubblici (2026-10-26), cioè il primo che apre l'app in una città
// nuova guarda uno scheletro per mezzo minuto. Con il seed le zone coperte
// rispondono dalla tabella da subito; Overpass le aggiorna poi una per una, in
// background, quando invecchiano (routes/places.js).
//
// Prima si estraggono i locali con extract-venues.py, poi:
//
//   node --env-file=.env scripts/seed-nearby-tiles.mjs \
//     --poly italy.poly --poly switzerland.poly italy.ndjson switzerland.ndjson
//
// I .poly sono i confini degli estratti (Geofabrik li pubblica accanto ai
// .pbf). Si scrivono solo i tasselli che stanno tutti dentro uno dei confini,
// anche quelli vuoti: «qui non c'è niente» evita a Overpass la campagna e il
// mare. Quelli a cavallo di un confine restano a Overpass, perché l'estratto
// ne vede solo una parte. Un tassello già nella tabella con dati più recenti
// dell'estratto non si tocca. `--dry-run` conta e non scrive.
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { mapElement } from '../src/lib/osm.js';
import { TILES_PER_DEG, TILE_VERSION, tileBounds, tileKey, tileOf } from '../src/lib/nearbyTiles.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const polyFiles = [];
const dataFiles = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') continue;
  if (args[i] === '--poly') polyFiles.push(args[++i]);
  else dataFiles.push(args[i]);
}
if (!polyFiles.length || !dataFiles.length) {
  console.error('uso: seed-nearby-tiles.mjs [--dry-run] --poly <confine.poly>… <locali.ndjson>…');
  process.exit(1);
}

// --- Confini (formato .poly di osmosis) -------------------------------------
// Un nome, poi anelli: un'intestazione (con «!» davanti se è un buco), una
// coppia «lon lat» per riga, END. Un END finale chiude il file.
function readPoly(file) {
  const lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const rings = [];
  let ring = null;
  for (const line of lines.slice(1)) {
    if (line === 'END') {
      if (ring) rings.push(ring);
      ring = null;
    } else if (!ring) {
      ring = { hole: line.startsWith('!'), pts: [] };
    } else {
      const [lon, lat] = line.split(/\s+/).map(Number);
      ring.pts.push([lon, lat]);
    }
  }
  return rings;
}

function inRing(pts, lon, lat) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const polys = polyFiles.map(readPoly);
const inAnyPoly = (lon, lat) =>
  polys.some(
    (rings) =>
      rings.some((r) => !r.hole && inRing(r.pts, lon, lat)) &&
      !rings.some((r) => r.hole && inRing(r.pts, lon, lat)),
  );

// Un tassello è coperto se i 9 punti di una griglia 3×3 sul suo bordo e al
// centro stanno dentro un confine: i confini di Geofabrik hanno qualche km di
// margine, il dettaglio di un'insenatura non conta.
function covered(tx, ty) {
  const b = tileBounds(tx, ty);
  for (const fy of [0, 0.5, 1]) {
    for (const fx of [0, 0.5, 1]) {
      if (!inAnyPoly(b.w + (b.e - b.w) * fx, b.s + (b.n - b.s) * fy)) return false;
    }
  }
  return true;
}

const coveredKeys = new Set();
for (const rings of polys) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const r of rings) {
    for (const [lon, lat] of r.pts) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  }
  const lo = tileOf(minLat, minLon);
  const hi = tileOf(maxLat, maxLon);
  for (let ty = lo.ty; ty <= hi.ty; ty++) {
    for (let tx = lo.tx; tx <= hi.tx; tx++) {
      if (covered(tx, ty)) coveredKeys.add(tileKey(tx, ty));
    }
  }
}

// --- Locali ------------------------------------------------------------------
const byTile = new Map();
const seen = new Set();
let at = Infinity;
for (const file of dataFiles) {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const el = JSON.parse(line);
    if (el.meta) {
      // I dati valgono dalla data dell'estratto più vecchio, non da oggi.
      const t = Date.parse(el.meta.timestamp);
      if (Number.isFinite(t)) at = Math.min(at, t);
      continue;
    }
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue; // due estratti confinanti si sovrappongono
    seen.add(id);
    const place = mapElement(el);
    if (!place) continue;
    const { tx, ty } = tileOf(place.lat, place.lng);
    const key = tileKey(tx, ty);
    if (!byTile.has(key)) byTile.set(key, []);
    byTile.get(key).push(place);
  }
}
if (!Number.isFinite(at)) {
  console.error('Nessuna data negli estratti (riga meta): rigenerali con extract-venues.py.');
  process.exit(1);
}

const tiles = new Map([...coveredKeys].map((key) => [key, byTile.get(key) ?? []]));
const placesIn = [...tiles.values()].reduce((n, l) => n + l.length, 0);
const placesAll = [...byTile.values()].reduce((n, l) => n + l.length, 0);
const biggest = Math.max(0, ...[...tiles.values()].map((l) => l.length));
console.log(
  `${coveredKeys.size} tasselli coperti (${TILES_PER_DEG}/grado, ${TILE_VERSION}), ` +
    `${[...tiles.values()].filter((l) => l.length).length} con locali; ` +
    `${placesIn} locali su ${placesAll} (gli altri sono in tasselli di confine); ` +
    `il più pieno ne ha ${biggest}. Dati al ${new Date(at).toISOString()}.`,
);
if (dryRun) process.exit(0);

// --- Scrittura ---------------------------------------------------------------
// Importati qui: il client Supabase vuole le variabili d'ambiente, che a un
// --dry-run non servono.
const { supabase } = await import('../src/lib/supabase.js');
const { writeTiles } = await import('../src/lib/nearbyStore.js');

// Tasselli già caricati da Overpass dopo la data dell'estratto: più recenti, restano.
const newer = new Set();
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('nearby_cache')
    .select('key')
    .like('key', `${TILE_VERSION}:%`)
    .gt('fetched_at', new Date(at).toISOString())
    .order('key')
    .range(from, from + 999);
  if (error) throw new Error(`lettura nearby_cache: ${error.message}`);
  data.forEach((r) => newer.add(r.key));
  if (data.length < 1000) break;
}
for (const key of newer) tiles.delete(key);

const entries = [...tiles];
const BATCH = 200;
const WORKERS = 6;
let next = 0;
let written = 0;
async function worker() {
  while (next < entries.length) {
    const batch = entries.slice(next, (next += BATCH));
    if (!(await writeTiles(new Map(batch), at))) throw new Error('scrittura nearby_cache fallita');
    written += batch.length;
    process.stdout.write(`\r${written}/${entries.length} tasselli scritti`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
console.log(`\nFatto: ${written} tasselli, ${newer.size} lasciati com'erano perché più recenti.`);
