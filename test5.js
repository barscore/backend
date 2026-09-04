const query = `[out:json][timeout:30];node["amenity"~"^(bar)$"](45.46,9.18,45.47,9.19);out center;`;
fetch("https://overpass.openstreetmap.fr/api/interpreter", { method: 'POST', body: query })
  .then(res => res.json())
  .then(data => console.log("FR Elements:", data.elements?.length))
  .catch(console.error);
