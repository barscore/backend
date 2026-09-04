const lat = 47.37;
const lng = 8.54;
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

fetch("https://overpass.osm.ch/api/interpreter", { method: 'POST', body: query })
  .then(res => res.json())
  .then(data => console.log("Swiss Elements:", data.elements?.length))
  .catch(console.error);
