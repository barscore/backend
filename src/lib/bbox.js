// Riquadri geografici per restringere le letture di `bars` alla zona che serve.
// Prima /places/nearby scaricava l'intera tabella a ogni spostamento della
// mappa e scartava il resto in JS: va bene a 150 righe, non a 15.000.
//
// Sono riquadri in gradi, non cerchi: servono a far scartare le righe a
// Postgres. La distanza vera resta quella di haversineKm, calcolata dopo.

// Arrotondato PER DIFETTO di proposito (un grado di latitudine vale tra 110,57
// e 111,69 km, e haversineKm ne usa 111,19): meno chilometri per grado vuol
// dire più gradi per chilometro, quindi un riquadro appena più largo. Con il
// valore «giusto» un bar esattamente sul bordo nord restava fuori.
const KM_PER_DEG_LAT = 110.5;

/** Gradi di longitudine che coprono `km` alla latitudine data. */
function lngDegrees(km, lat) {
  // Ai poli un grado di longitudine vale zero: lì il riquadro copre tutto.
  const cos = Math.cos((lat * Math.PI) / 180);
  return cos < 1e-6 ? 360 : km / (KM_PER_DEG_LAT * cos);
}

function box(minLat, maxLat, minLng, maxLng) {
  const wraps = minLng < -180 || maxLng > 180 || maxLng - minLng >= 360;
  return {
    minLat: Math.max(-90, minLat),
    maxLat: Math.min(90, maxLat),
    // A cavallo dell'antimeridiano un intervallo minLng..maxLng non descrive
    // più la zona: si rinuncia al filtro sulla longitudine (resta la latitudine).
    minLng: wraps ? null : minLng,
    maxLng: wraps ? null : maxLng,
  };
}

/** Riquadro che contiene il cerchio di raggio `km` attorno a un punto. */
export function bboxAround(lat, lng, km) {
  const dLat = km / KM_PER_DEG_LAT;
  // Il lato più vicino al polo è il più largo in gradi: si misura lì.
  const edgeLat = Math.min(89.9, Math.abs(lat) + dLat);
  const dLng = lngDegrees(km, edgeLat);
  return box(lat - dLat, lat + dLat, lng - dLng, lng + dLng);
}

/**
 * Riquadro che contiene tutti i punti dati, allargato di `padKm`.
 * `null` se non ci sono punti con coordinate.
 */
export function bboxOf(points, padKm = 0) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  if (minLat === Infinity) return null;
  const dLat = padKm / KM_PER_DEG_LAT;
  const edgeLat = Math.min(89.9, Math.max(Math.abs(minLat), Math.abs(maxLat)) + dLat);
  const dLng = lngDegrees(padKm, edgeLat);
  return box(minLat - dLat, maxLat + dLat, minLng - dLng, maxLng + dLng);
}

/** Applica il riquadro a una query PostgREST sulle colonne `lat` / `lng`. */
export function withinBbox(query, b) {
  if (!b) return query;
  let q = query.gte('lat', b.minLat).lte('lat', b.maxLat);
  if (b.minLng !== null) q = q.gte('lng', b.minLng).lte('lng', b.maxLng);
  return q;
}
