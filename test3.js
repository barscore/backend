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

const urls = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

async function run() {
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'POST', body: query });
      console.log(url, res.status);
      if (res.ok) {
        const text = await res.text();
        console.log(url, "Elements:", JSON.parse(text).elements?.length);
      }
    } catch (e) {
      console.error(url, e.message);
    }
  }
}
run();
