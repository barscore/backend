# /// script
# requires-python = ">=3.10"
# dependencies = ["osmium>=4.0"]
# ///
"""I locali di un estratto OpenStreetMap (.osm.pbf), come li darebbe Overpass.

Prima metà del seed di /places/nearby (l'altra è seed-nearby-tiles.mjs): legge
un estratto di Geofabrik e scrive un elemento per riga, nella forma di
`out tags center` — nodi con lat/lon, way con il centro del loro riquadro —
così il seed li passa allo stesso mapElement() del backend. La prima riga è
`{"meta": {"timestamp": …}}`, la data dei dati dell'estratto.

    uv run backend/scripts/extract-venues.py italy-latest.osm.pbf > italy.ndjson

Due passate, perché le coordinate dei nodi di una way stanno altrove nel file:
la prima tiene i locali e i nodi delle loro way (pochi MB), la seconda
calcola i centri su quel file piccolo, senza indicizzare l'Italia intera.
"""

import json
import os
import sys
import tempfile

import osmium

# Gli stessi di NEARBY_AMENITIES in src/lib/osm.js: il seed deve scegliere
# esattamente i locali che sceglie la query a Overpass.
AMENITIES = ("bar", "pub", "biergarten", "nightclub", "cafe")


def main(src: str) -> None:
    header = osmium.io.Reader(src, osmium.osm.osm_entity_bits.NOTHING).header()
    timestamp = header.get("osmosis_replication_timestamp") or None

    with tempfile.TemporaryDirectory() as tmp:
        venues = os.path.join(tmp, "venues.osm.pbf")
        tag_filter = osmium.filter.TagFilter(*(("amenity", a) for a in AMENITIES))
        with osmium.BackReferenceWriter(venues, ref_src=src, overwrite=True) as writer:
            for obj in osmium.FileProcessor(src, osmium.osm.NODE | osmium.osm.WAY).with_filter(tag_filter):
                writer.add(obj)

        out = sys.stdout
        out.write(json.dumps({"meta": {"timestamp": timestamp, "source": os.path.basename(src)}}) + "\n")
        count = 0
        for obj in osmium.FileProcessor(venues, osmium.osm.NODE | osmium.osm.WAY).with_locations():
            if obj.tags.get("amenity") not in AMENITIES:
                continue  # un nodo che serve solo a disegnare una way
            el = {"type": "node" if obj.is_node() else "way", "id": obj.id, "tags": dict(obj.tags)}
            if obj.is_node():
                if not obj.location.valid():
                    continue
                el["lat"], el["lon"] = obj.location.lat, obj.location.lon
            else:
                locs = [n.location for n in obj.nodes if n.location.valid()]
                if not locs:
                    continue
                # Il centro di Overpass (`out center`) è quello del riquadro, non il baricentro.
                lats = [l.lat for l in locs]
                lons = [l.lon for l in locs]
                el["center"] = {"lat": (min(lats) + max(lats)) / 2, "lon": (min(lons) + max(lons)) / 2}
            out.write(json.dumps(el, ensure_ascii=False) + "\n")
            count += 1
        print(f"{os.path.basename(src)}: {count} locali, dati al {timestamp}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("uso: extract-venues.py <estratto.osm.pbf>")
    main(sys.argv[1])
