"""
Nepal's own geological polygons, named and queryable.

    npm run build:geology-units

WHAT THIS ANSWERS. The app already held three geological things and none of them
could name the rock under an intake. `nepal-geology-maps.json` is an
AVAILABILITY index: which published DMG sheets cover the alignment, not what is
on them. The DMG province sheets in `sources/geology/` are raster tiles — they
can be drawn under the scheme and cannot be asked a question. Macrostrat can be
asked, over the network, and returns a harmonized GLOBAL compilation that the
report itself complains about: "one polygon spanning the entire alignment".

This is the fourth thing, and the one that was missing: Nepal's own map, as
polygons, offline, with the formation names Nepali engineers and DMG's own
sheets use — Kushma, Ulleri, Ranimatta, Siwalik.

WHAT IT IS FOR, precisely. Two questions the app could not answer:

  1. What unit is the intake on, and the powerhouse?
  2. How many CONTACTS does the waterway cross?

The second is the one worth having. A headrace that stays inside one formation
is a different tunnel from one that crosses three contacts, and crossing a
contact is where the ground changes, where water comes in, and where a tunnel
gets expensive. That is a genuine screening statement and nothing in this app
could make it.

SOURCE. ICIMOD Regional Database System, "Geology of Nepal", CC-BY 4.0, derived
from the Department of Mines and Geology 1:1,000,000 map of 1994. Same authority
as the province sheets already bundled, four times coarser.

THE SCALE IS THE POINT, AND THE LIMIT. At 1:1,000,000 a half-millimetre line is
500 m on the ground, so a contact position carries something like half a
kilometre of error and this cannot site a portal. It is a regional belt map. The
province sheets at 1:350,000 are better and the 1:50,000 sheets better again;
both are for reading, not querying, which is why this exists.

THIRTY PERCENT OF NEPAL HAS NO POLYGON — AND THAT IS THE DIGITISATION, NOT THE
MAP. `No Data` covers 4.16 deg2 = ~45,000 km2 = 29.6% of the extent, and it is
not scattered: it is the high north, one block running 80.6-85.2 E above 28.4 N
and another over the Everest-Kanchenjunga high country.

An earlier version of this file said Nepal's geological map is blank there. It
is not, and the claim was wrong twice over. The printed Amatya & Jnawali (1994)
sheet covers the whole country including the Tibetan-Tethys and Higher Himalayan
zones — it is the standard national map. And DMG's own province sheets at
1:350,000, already bundled in `sources/geology/`, demonstrably map this ground:
of their 363 tiles, **39 sit on ground this vector calls No Data**. Measured by
`checks/geology-vs-dmg-sheets.mjs`.

So a blank here means "this digital dataset does not carry it", and the right
advice is to obtain the published sheet — not "nothing is known about this
ground", which is what the old wording told a reader. The query must still
return a NO-DATA verdict rather than nothing, because absence and unmapped look
identical to a caller, but the words attached to it changed completely.
"""
import io
import json
import math
import os
import sys

try:
    import shapefile  # pyshp
except ImportError:
    sys.exit("pyshp is required:  pip install pyshp")

SRC = "sources/icimod-geology/data/Geology"
OUT = "src/data/nepal-geology-units.json"

# Simplification tolerance, metres. The source draws contacts at 1:1,000,000
# where its own line width is ~500 m on the ground, so removing detail below
# 200 m discards nothing the source ever claimed. Measured below: it takes
# 263k vertices to about a fifth of that and the class areas barely move.
TOL_M = 200.0

# Coordinate rounding. 4 dp is ~11 m, an order of magnitude inside the
# tolerance above, and matches what nepal-protected.json already stores.
DP = 4

# Names the source gives as bare abbreviations with no legend anywhere in the
# shapefile or its metadata. They are carried through rather than guessed at,
# and flagged so the report can say "the national map labels this Gh and does
# not expand it" instead of printing a two-letter word as if it were a unit.
UNEXPANDED = 3  # Gh, Bu, Gn, Ba, Cr... two-letter labels with nothing behind them

NO_DATA = "No Data"


def deg_tol(lat_deg):
    """Tolerance in degrees of latitude, and in longitude at this latitude."""
    dlat = TOL_M / 111_320.0
    dlon = dlat / max(0.2, math.cos(math.radians(lat_deg)))
    return dlat, dlon


def simplify(points, dlat, dlon):
    """
    Douglas-Peucker on (lon, lat), with longitude scaled so the tolerance is a
    real distance rather than a distance that shrinks as you go north.

    Iterative, not recursive: one Himalayan polygon carries 6,548 vertices and
    Python's recursion limit is 1,000.
    """
    n = len(points)
    if n < 4:
        return points
    sx = dlat / dlon  # scale lon into lat-equivalent units
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
            if norm == 0.0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(ddx * (ay - py) - (ax - px) * ddy) / norm
            if d > best_d:
                best_d, best_i = d, i
        if best_d > dlat:
            keep[best_i] = True
            stack.append((lo, best_i))
            stack.append((best_i, hi))
    return [points[i] for i in range(n) if keep[i]]


def ring_area_deg2(ring):
    """Shoelace on (lon, lat); sign discarded, this is only used for reporting."""
    a = 0.0
    for i in range(len(ring)):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % len(ring)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2.0


def ring_area_km2(ring):
    """
    Same shoelace, converted at the ring's own latitude.

    A degree of longitude is 4% shorter at Nepal's northern border than at its
    southern one, and the No Data block sits entirely in the north — the one
    figure this file reports most loudly. Weighting each ring by where it
    actually is costs nothing and stops that number being 4% wrong in the
    direction that matters.
    """
    lat = sum(p[1] for p in ring) / len(ring)
    return ring_area_deg2(ring) * 111.32 * 111.32 * math.cos(math.radians(lat))


def main():
    if not os.path.exists(SRC + ".shp"):
        sys.exit(
            f"missing {SRC}.shp\n"
            "Download 'Geology of Nepal' (CC-BY 4.0) from ICIMOD RDS:\n"
            "  https://rds.icimod.org/metadata/e0e362b7-0da2-46b3-9323-f301d3b281b5\n"
            "and unzip it into sources/icimod-geology/."
        )

    reader = shapefile.Reader(SRC)
    fields = [f[0] for f in reader.fields[1:]]
    if "GEOL_CODE" not in fields or "CLASS" not in fields:
        sys.exit(f"unexpected attributes {fields}; expected GEOL_CODE and CLASS")
    i_code, i_class = fields.index("GEOL_CODE"), fields.index("CLASS")

    polys = []
    verts_in = verts_out = 0
    area_in = area_out = 0.0
    dropped_rings = 0

    for rec, shape in zip(reader.records(), reader.shapes()):
        code = str(rec[i_code]).strip()
        name = str(rec[i_class]).strip()
        pts = shape.points
        if not pts:
            continue
        verts_in += len(pts)

        # Split the flat point list on ESRI part boundaries. A "part" is a ring:
        # outer boundary or hole, and the even-odd ray cast in the query treats
        # both correctly without needing to know which is which.
        starts = list(shape.parts) + [len(pts)]
        rings = []
        for a, b in zip(starts, starts[1:]):
            ring = pts[a:b]
            if len(ring) >= 4:
                rings.append(ring)
        if not rings:
            continue

        lat_mid = (shape.bbox[1] + shape.bbox[3]) / 2.0
        dlat, dlon = deg_tol(lat_mid)

        out_rings = []
        for ring in rings:
            area_in += ring_area_deg2(ring)
            s = simplify(ring, dlat, dlon)
            if len(s) < 4:
                # A ring that collapses under 200 m of tolerance was smaller
                # than the source's own line width. Dropping it removes a
                # sliver, not a unit; counted and reported rather than silent.
                dropped_rings += 1
                continue
            area_out += ring_area_deg2(s)
            verts_out += len(s)
            flat = []
            for lon, lat in s:
                flat.append(round(lat, DP))
                flat.append(round(lon, DP))
            out_rings.append(flat)
        if not out_rings:
            continue

        lats = [v for r in out_rings for v in r[0::2]]
        lons = [v for r in out_rings for v in r[1::2]]
        polys.append(
            {
                "c": code,
                "n": name,
                # bbox first: 856 polygons is far too many to ray-cast on every
                # query, and a box test rejects all but a handful.
                "b": [
                    round(min(lats), DP),
                    round(min(lons), DP),
                    round(max(lats), DP),
                    round(max(lons), DP),
                ],
                "r": out_rings,
            }
        )

    # Units, for the legend and for the no-data accounting.
    units = {}
    for p in polys:
        u = units.setdefault(p["c"], {"c": p["c"], "n": p["n"], "polys": 0, "area": 0.0})
        u["polys"] += 1
        u["area"] += sum(ring_area_km2(list(zip(r[1::2], r[0::2]))) for r in p["r"])

    total = sum(u["area"] for u in units.values())
    blank = sum(u["area"] for u in units.values() if u["n"] == NO_DATA or not u["n"])
    named = sum(1 for u in units.values() if len(u["n"]) > UNEXPANDED)

    bundle = {
        "_source": "ICIMOD Regional Database System, Geology of Nepal",
        "_sourceUrl": "https://rds.icimod.org/metadata/e0e362b7-0da2-46b3-9323-f301d3b281b5",
        "_origin": "Department of Mines and Geology, Government of Nepal, geological map of 1994",
        "_scale": "1:1,000,000",
        "_license": "CC-BY 4.0",
        "_retrieved": "2026-08-25",
        "_crs": "WGS 84 (EPSG:4326), as published — no reprojection applied",
        "_simplifiedM": TOL_M,
        "_noDataShare": round(blank / total, 4) if total else None,
        "_noDataKm2": round(blank),
        "_note": (
            "Regional belt map. A contact drawn at 1:1,000,000 carries roughly 500 m of "
            "positional error, so this can name the unit under a site and cannot place a "
            "portal. 'No Data' marks ground this DIGITISATION does not carry, not ground "
            "Nepal has not mapped: the printed 1994 sheet covers the whole country, and "
            "DMG's 1:350,000 province sheets map 39 tiles' worth of it. Report it as a gap "
            "in the data with the published sheet as the remedy, never as an absent answer."
        ),
        "units": sorted(
            (
                {"c": u["c"], "n": u["n"], "polygons": u["polys"], "areaKm2": round(u["area"])}
                for u in units.values()
            ),
            key=lambda u: -u["areaKm2"],
        ),
        "polygons": polys,
    }

    text = json.dumps(bundle, separators=(",", ":"))
    tmp = OUT + ".tmp"
    io.open(tmp, "w", encoding="utf-8").write(text)
    os.replace(tmp, OUT)

    print(f"wrote {OUT}: {len(text) / 1024 / 1024:.2f} MB")
    print(f"  {len(polys)} polygons, {len(units)} units ({named} carry a real name, {len(units) - named} are bare codes)")
    print(f"  vertices {verts_in:,} -> {verts_out:,}  ({100 * verts_out / verts_in:.1f}% kept at {TOL_M:.0f} m)")
    print(f"  area drift under simplification: {100 * (area_out - area_in) / area_in:+.3f}%")
    print(f"  rings dropped as slivers: {dropped_rings}")
    print(f"  NO POLYGON: {blank:,.0f} km2 = {100 * blank / total:.1f}% of the extent")
    print("             (a gap in this digitisation; the printed DMG sheet covers it)")
    print()
    for u in bundle["units"][:12]:
        flag = "" if len(u["n"]) > UNEXPANDED else "   <- unexplained code, no legend in source"
        print(f"  {u['areaKm2']:>8,} km2  {u['c']:>4s}  {u['n'] or '(blank)'}{flag}")


if __name__ == "__main__":
    main()
