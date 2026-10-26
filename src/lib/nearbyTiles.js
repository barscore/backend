// Tasselli fissi per la cache di /places/nearby.
//
// Prima la cache era per «centro arrotondato a 0,01° + raggio»: spostare la
// mappa di un chilometro, o il raggio da 3 a 4, era una zona nuova e quindi
// una nuova query a Overpass, che sui mirror pubblici costa 25-40 secondi
// anche per due chilometri (misurati il 2026-10-26). Ora la terra è divisa in
// tasselli di 0,05° × 0,05° (circa 5,5 × 4 km alle nostre latitudini) e ogni
// richiesta legge quelli che coprono il suo cerchio: due raggi diversi, o due
// centri vicini, condividono gli stessi tasselli e Overpass si paga una volta
// per tassello, non per richiesta. I tasselli sono anche quello che
// `scripts/seed-nearby-tiles.mjs` riempie in blocco da un estratto OSM.
//
// Niente rete né database qui: solo geometria, condivisa da route, seed e test.

// 20 tasselli per grado = 0,05°. Cambiarlo cambia tutte le chiavi: va
// insieme a un nuovo TILE_VERSION.
export const TILES_PER_DEG = 20;
// Versione della forma di un tassello: da cambiare quando cambia la query di
// Overpass o la forma dei luoghi (mapElement), così i tasselli vecchi non
// vengono più letti. La pulizia (pruneShared) toglie le altre versioni.
export const TILE_VERSION = 't1';
// Oltre questo un cerchio è un'altra cosa che una lista di bar (e una lettura
// da migliaia di righe): la route lo rifiuta.
export const MAX_TILES = 2500;

const KM_PER_DEG_LAT = 110.5; // per difetto, come lib/bbox.js: riquadro mai stretto

export const tileKey = (tx, ty) => `${TILE_VERSION}:${ty}:${tx}`;

/** Il tassello che contiene il punto. */
export function tileOf(lat, lng) {
  return { tx: Math.floor(lng * TILES_PER_DEG), ty: Math.floor(lat * TILES_PER_DEG) };
}

/** Lati del tassello in gradi: sud, ovest, nord, est. */
export function tileBounds(tx, ty) {
  return {
    s: ty / TILES_PER_DEG,
    w: tx / TILES_PER_DEG,
    n: (ty + 1) / TILES_PER_DEG,
    e: (tx + 1) / TILES_PER_DEG,
  };
}

/**
 * I tasselli che coprono il cerchio di raggio `km` attorno al punto, dal più
 * vicino al centro al più lontano. Al di là dell'antimeridiano non si va: il
 * cerchio si ferma a ±180°.
 */
export function tilesAround(lat, lng, km) {
  const dLat = km / KM_PER_DEG_LAT;
  // Il lato più vicino al polo è il più largo in gradi: si misura lì.
  const edgeLat = Math.min(89.9, Math.abs(lat) + dLat);
  const dLng = Math.min(180, km / (KM_PER_DEG_LAT * Math.cos((edgeLat * Math.PI) / 180)));
  const lo = tileOf(Math.max(-90, lat - dLat), Math.max(-180, lng - dLng));
  const hi = tileOf(Math.min(90 - 1e-9, lat + dLat), Math.min(180 - 1e-9, lng + dLng));
  const tiles = [];
  for (let ty = lo.ty; ty <= hi.ty; ty++) {
    for (let tx = lo.tx; tx <= hi.tx; tx++) {
      const b = tileBounds(tx, ty);
      const dy = ((b.s + b.n) / 2 - lat) * KM_PER_DEG_LAT;
      const dx = ((b.w + b.e) / 2 - lng) * KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
      tiles.push({ tx, ty, key: tileKey(tx, ty), d: dx * dx + dy * dy });
    }
  }
  return tiles.sort((a, b) => a.d - b.d).map(({ tx, ty, key }) => ({ tx, ty, key }));
}

/** Il riquadro che contiene tutti i tasselli dati. */
export function tilesBox(tiles) {
  let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
  for (const { tx, ty } of tiles) {
    const b = tileBounds(tx, ty);
    if (b.s < s) s = b.s;
    if (b.w < w) w = b.w;
    if (b.n > n) n = b.n;
    if (b.e > e) e = b.e;
  }
  return { s, w, n, e };
}

/** Ogni tassello dentro il riquadro (allineato ai tasselli, come quello di tilesBox). */
export function tilesInBox({ s, w, n, e }) {
  const out = [];
  // Il riquadro di tilesBox ha i lati sui bordi dei tasselli: arrotondare evita
  // che 45.1 * 20 = 901.9999… aggiunga una fila in più.
  const y0 = Math.round(s * TILES_PER_DEG);
  const y1 = Math.round(n * TILES_PER_DEG);
  const x0 = Math.round(w * TILES_PER_DEG);
  const x1 = Math.round(e * TILES_PER_DEG);
  for (let ty = y0; ty < y1; ty++) {
    for (let tx = x0; tx < x1; tx++) out.push({ tx, ty, key: tileKey(tx, ty) });
  }
  return out;
}

/**
 * I luoghi divisi per tassello. Ogni tassello del riquadro ha la sua voce,
 * anche vuota: «qui non c'è niente» è un'informazione da tenere, o la campagna
 * tornerebbe a chiedere a Overpass a ogni passaggio.
 */
export function splitByTile(places, box) {
  const byKey = new Map(tilesInBox(box).map((t) => [t.key, []]));
  for (const p of places) {
    const { tx, ty } = tileOf(p.lat, p.lng);
    byKey.get(tileKey(tx, ty))?.push(p);
  }
  return byKey;
}
