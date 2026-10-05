"""
Nepal's glaciers, as outlines the app can ask about rather than infer.

    npm run build:glaciers

WHY THIS EXISTS. The app held 4,152 glacial LAKE centroids and no ice. That is
enough to ask "does a lake drain through this site" and not enough to ask
anything about the ice that feeds it, or how much of a catchment is glacierised
- which is the term that decides whether a dry-season flow is rain-fed or
melt-fed, and the term a runoff coefficient above 1 was blamed on without
evidence.

The stand-in until now was hypsometry: the share of catchment above 5,000 m,
built for WECS/DHM. That is a mountain, not a glacier. Above 5,000 m in Nepal is
mostly bare rock and seasonal snow; RGI's own outlines put 8,049 km2 of ice in
these basins against a far larger area above that contour.

USE THE AREA FIELD, NOT THE RINGS. The outlines are simplified for drawing; the
areas are RGI's own. Recomputing area from these rings would read 1.3% low.

SOURCE. Randolph Glacier Inventory 7.0, region 15 South Asia East, CC-BY-4.0,
via the UNESCO IHP-WINS mirror because NSIDC's own path wants an Earthdata
login. 18,587 glaciers in the region file; the transboundary box below keeps the
7,815 that sit in or above Nepal's three basins.

WHY THE BOX IS BIGGER THAN NEPAL. Koshi, Gandaki and Karnali all head in Tibet,
so ice that feeds a Nepali river is often not in Nepal. This uses exactly the
box `pipeline/build-glacial-lakes.mjs` uses for the same reason.

WHAT IS KEPT. Outline, area, name where RGI has one, and the elevation range -
zmin/zmed/zmax, which is what says whether a glacier is retreating into its own
accumulation zone. Surge type is kept: 8 of these are surge-type glaciers.

TERMINUS TYPE IS NOT KEPT, having been kept once and measured. RGI 7.0 records
term_type 9, "not assigned", for every glacier in this window - so the
lake-terminating glaciers, which are the GLOF question, cannot be told from the
land-terminating ones out of this file. Do not re-add the column expecting it to
answer that; it is 6,816 copies of "unknown".

THE BOX IS A BOX, NOT A BASIN. Rongbuk is in here, and Rongbuk drains north into
Tibet. RGI carries no basin attribute, so nothing in this bundle knows which way
a glacier's meltwater goes. Only a flow-path test on the river network can say
that, which is what `connectivity.ts` already does for lakes.
"""

import io
import json
import math
import os

import shapefile

SRC = "sources/rgi/RGI2000-v7.0-G-15_south_asia_east"
# public/, not src/data/. A statically imported JSON is inlined into the JS
# bundle and parsed before the first frame; 2.4 MB of glacier outlines there
# more than doubled the app's eager data payload and it was noticeable. Fetched
# from public/ it costs nothing until something asks about ice.
OUT = "public/nepal-glaciers.json"

# Same transboundary window as the glacial-lake bundle: the basins that drain
# through Nepal, not the political border.
LO_LAT, HI_LAT = 27.4, 30.7
LO_LON, HI_LON = 79.9, 88.9

# 60 m, against RGI outlines digitised from 30 m imagery. Finer than that is
# recording the pixel grid. 100 m was tried and shrank the total ice by 2.5%,
# because a glacier is a small feature and the tongues are the part that goes;
# 60 m holds the drift to 1.3% for 0.5 MB more.
TOL_M = 60.0
DP = 4

# Below this a glacier is a snow patch for our purposes: it carries no
# meaningful melt and 999 of them would be a seventh of the file.
MIN_KM2 = 0.05


def deg_tol(lat_deg):
    dlat = TOL_M / 111_320.0
    dlon = dlat / max(0.2, math.cos(math.radians(lat_deg)))
    return dlat, dlon


def simplify(points, dlat, dlon):
    """Douglas-Peucker on (lon, lat), longitude scaled so the tolerance is a
    real distance. Iterative, because Python's recursion limit is 1,000 and
    some of these outlines are longer than that."""
    n = len(points)
    if n < 4:
        return points
    sx = dlat / dlon
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        ax, ay = points[lo][0] * sx, points[lo][1]
        bx, by = points[hi][0] * sx, points[hi][1]
        ddx, ddy = bx - ax, by - ay
        norm = math.hypot(ddx, ddy)
        best_d, best_i = -1.0, -1
        for i in range(lo + 1, hi):
            px, py = points[i][0] * sx, points[i][1]
            d = (
                math.hypot(px - ax, py - ay)
                if norm == 0.0
                else abs(ddx * (ay - py) - (ax - px) * ddy) / norm
            )
            if d > best_d:
                best_d, best_i = d, i
        if best_d > dlat:
            keep[best_i] = True
            stack.append((lo, best_i))
            stack.append((best_i, hi))
    return [points[i] for i in range(n) if keep[i]]


def ring_area_km2(ring):
    if len(ring) < 3:
        return 0.0
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        a += x1 * y2 - x2 * y1
    lat = sum(p[1] for p in ring) / len(ring)
    return abs(a) / 2.0 * 111.32 * 111.32 * math.cos(math.radians(lat))


def main():
    if not os.path.exists(SRC + ".shp"):
        raise SystemExit(
            f"missing {SRC}.shp — download RGI 7.0 region 15 (CC-BY-4.0) from IHP-WINS:\n"
            "  https://ihp-wins.unesco.org/en/dataset/randolph-glacier-inventory-rgi-7-0-glacier-product\n"
            "  and unzip it into sources/rgi/"
        )

    r = shapefile.Reader(
        shp=open(SRC + ".shp", "rb"),
        dbf=open(SRC + ".dbf", "rb"),
        shx=open(SRC + ".shx", "rb"),
    )
    names = [f[0] for f in r.fields[1:]]
    ix = {k: i for i, k in enumerate(names)}

    glaciers = []
    raw_v = 0
    kept_v = 0
    dropped_small = 0
    outside = 0
    area_in = 0.0
    area_out = 0.0

    for sr in r.iterShapeRecords():
        rec = sr.record
        lat, lon = rec[ix["cenlat"]], rec[ix["cenlon"]]
        if not (LO_LAT <= lat <= HI_LAT and LO_LON <= lon <= HI_LON):
            outside += 1
            continue
        km2 = float(rec[ix["area_km2"]])
        if km2 < MIN_KM2:
            dropped_small += 1
            continue

        shape = sr.shape
        parts = list(shape.parts) + [len(shape.points)]
        dlat, dlon = deg_tol(lat)
        rings = []
        for k in range(len(parts) - 1):
            ring = [tuple(p) for p in shape.points[parts[k] : parts[k + 1]]]
            raw_v += len(ring)
            if len(ring) < 4:
                continue
            s = simplify(ring, dlat, dlon)
            # A simplified ring that has collapsed is not a hole, it is noise.
            if len(s) < 4:
                continue
            kept_v += len(s)
            area_in += ring_area_km2(ring)
            area_out += ring_area_km2(s)
            rings.append([[round(p[0], DP), round(p[1], DP)] for p in s])
        if not rings:
            continue

        name = (rec[ix["glac_name"]] or "").strip()
        glaciers.append(
            [
                rec[ix["rgi_id"]].replace("RGI2000-v7.0-G-15-", ""),
                name,
                round(km2, 4),
                round(lat, DP),
                round(lon, DP),
                int(round(float(rec[ix["zmin_m"]]))),
                int(round(float(rec[ix["zmed_m"]]))),
                int(round(float(rec[ix["zmax_m"]]))),
                int(rec[ix["surge_type"]]),
                rings,
            ]
        )

    glaciers.sort(key=lambda g: -g[2])
    total_km2 = sum(g[2] for g in glaciers)

    bundle = {
        "_source": "Randolph Glacier Inventory 7.0, region 15 South Asia East (RGI2000-v7.0-G)",
        "_citation": "RGI Consortium (2023). Randolph Glacier Inventory 7.0. NSIDC. doi:10.5067/f6jmovy5navz",
        "_mirror": "https://ihp-wins.unesco.org/en/dataset/randolph-glacier-inventory-rgi-7-0-glacier-product",
        "_license": "CC-BY-4.0",
        "_extent": {"latMin": LO_LAT, "latMax": HI_LAT, "lonMin": LO_LON, "lonMax": HI_LON},
        "_extentNote": (
            "The transboundary window Koshi, Gandaki and Karnali drain, not Nepal's border — "
            "ice that feeds a Nepali river is often in Tibet."
        ),
        "_simplification": {
            "toleranceM": TOL_M,
            "minAreaKm2": MIN_KM2,
            "verticesIn": raw_v,
            "verticesOut": kept_v,
            "areaDriftPct": round((area_out / area_in - 1) * 100, 4) if area_in else 0.0,
        },
        "_counts": {
            "glaciers": len(glaciers),
            "totalIceKm2": round(total_km2, 1),
            "droppedUnderMinArea": dropped_small,
            "outsideExtent": outside,
        },
        "_record": (
            "id, name, areaKm2, cenLat, cenLon, zminM, zmedM, zmaxM, surgeType, rings"
        ),
        "_limitation": (
            "Outlines are dated 2000-2010 by submission and glaciers here have retreated since. "
            "Areas are RGI's own, not recomputed from the simplified rings. RGI records terminus "
            "type as 'not assigned' for every glacier in this window, so lake-terminating glaciers "
            "cannot be identified from this file. The extent is a bounding box, so it also holds "
            "ice that drains north into Tibet."
        ),
        "glaciers": glaciers,
    }

    with io.open(OUT, "w", encoding="utf-8", newline="\n") as f:
        json.dump(bundle, f, separators=(",", ":"))

    size = os.path.getsize(OUT) / 1e6
    print(f"wrote {OUT}  {size:.2f} MB")
    print(f"  {len(glaciers)} glaciers, {total_km2:,.0f} km2 of ice")
    print(f"  dropped {dropped_small} under {MIN_KM2} km2, {outside} outside the basins")
    print(
        f"  vertices {raw_v:,} -> {kept_v:,} "
        f"({kept_v / raw_v * 100:.1f}%), area drift {bundle['_simplification']['areaDriftPct']:+.3f}%"
    )
    named = sum(1 for g in glaciers if g[1])
    surging = sum(1 for g in glaciers if g[8])
    print(f"  {named} carry a name, {surging} are surge-type")


if __name__ == "__main__":
    main()
