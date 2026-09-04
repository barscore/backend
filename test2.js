import { haversineKm } from './src/lib/osm.js';
const lat = 45.4654;
const lng = 9.1859;
const radiusKm = 2;
const dLat = radiusKm / 111;
const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180) || 1);
const bbox = `${lat - dLat},${lng - dLng},${lat + dLat},${lng + dLng}`;
const wayClause = `way["amenity"~"^(bar|pub|biergarten|nightclub|cafe)$"](${bbox});`;
const query = `
  [out:json][timeout:30];
  (
    node["amenity"~"^(bar|pub|biergarten|nightclub|cafe)$"](${bbox});
    ${wayClause}
  );
  out center tags;`;

console.log(query);

fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  body: query
}).then(res => res.json()).then(data => {
  console.log("Elements:", data.elements?.length);
}).catch(console.error);
