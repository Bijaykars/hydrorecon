"""
Every standing waterbody in Nepal a satellite can see, as a pondage reference set.

    python pipeline/build-pondage-references-gsw.py

WHY THIS EXISTS. The pondage screen is the one headline output in this app scored
against a population of ONE. `pipeline/pondage-references.json` holds Kulekhani
and nothing else, and the validation that ran against it says so in its own
words: a result that moves 20x for a metre of water level is an order of
magnitude, not an estimate. That finding is real, and it rests on a single site.
CLAUDE.md states the limit plainly - "one reservoir is not a population" - and
this is the file that ends it.

WHY GLOBAL SURFACE WATER. Nepal has one large reservoir and no published
stage-area tables for its lakes, so a reference set built from documents stops
at n=1. It does not have to: JRC's Global Surface Water maps every waterbody on
Earth from 38 years of Landsat, and the surface area of a lake is exactly the
quantity `delineatePondage` is being asked to reproduce. The published figure is
replaced by a MEASURED one, which is the trade this whole project keeps making.

WHY THIS IS NOT CIRCULAR. The app fills a Copernicus radar/photogrammetric DEM.
GSW thresholds Landsat optical reflectance. Two instruments, two physics, one
shoreline - so agreement is evidence and disagreement is a defect in one of them.
The DEM holding a lake as a flat plateau is the same gift Kulekhani gave, now
handed over several dozen times.

WHAT IT SCORES AND WHAT IT CANNOT. Identical to Kulekhani, because it is the same
test: it scores the connected fill, the barrier and the area integration against
a real, complex, winding shoreline at a level the raster itself supplies. It
CANNOT score storage. No DEM carries bathymetry under standing water, so a
predicted volume at these sites is a lower bound by construction. Anyone reading
a storage ratio off this set has misread it.

FOUR WAYS THIS SET COULD LIE, and what is done about each:

  A RIVER IS NOT A POND. A wide braided reach is permanent water and would sail
  through an area filter, then score nothing meaningful - there is no plateau and
  no shoreline to close. Components are rejected on shape, not size: a lake fills
  its bounding box, a river ribbons through one.

  A GLACIAL LAKE IS NOT A PONDAGE SITE. Tsho Rolpa at 4,580 m is a fine test of
  the fill geometry and an absurd place to put a forebay. Matches against the
  app's own ICIMOD inventory are TAGGED, not dropped - the geometry is still
  worth scoring, and the reader is told which rows are hypothetical.

  A LAKE THE DEM PREDATES IS A DIFFERENT TEST. GSW spans 1984-2021 and the DEM
  is one epoch inside that. A waterbody that appeared or vanished mid-record is
  scored against an area that was never simultaneous with the raster. Only cells
  wet in >=90% of observations are taken, which is the closest thing to "was
  there the whole time" the source can express.

  30 m CANNOT SEE A 20 m POND. Measured on this app's own register: only 4% of
  commissioned plants have any GSW water within 150 m, because a gorge river
  narrower than a Landsat pixel never crosses the threshold. So this set is
  biased toward LARGE, OPEN waterbodies, which is the easy end of the problem
  and the opposite end from where run-of-river pondage actually gets built. It
  is a real population and it is not the use population. That is the trap
  CLAUDE.md names, stated here before anyone reads a headline off this file.

SOURCE. JRC Global Surface Water v1.4 (Pekel et al., Nature 2016), 1984-2021,
~28 m, "provided free of charge, without restriction of use". Cite as
EC JRC/Google. Two 10-degree tiles cover Nepal; they land in sources/gsw/,
gitignored for size, and rebuild with one command.

OUTPUT
  pipeline/pondage-references-gsw.json   same schema as pondage-references.json
"""
import datetime
import json
import math
import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / "sources" / "gsw"
OUT = ROOT / "pipeline" / "pondage-references-gsw.json"

BUCKET = "https://storage.googleapis.com/global-surface-water/downloads2021/occurrence/"
TILES = {
    "occurrence_80E_30Nv1_4_2021.tif": (80.04, 26.35, 88.17, 30.00),
    "occurrence_80E_40Nv1_4_2021.tif": (80.04, 30.00, 88.17, 30.40),
}

# Cells wet in at least this share of valid Landsat observations. Components are
# FOUND on the always-wet core, because that is the part guaranteed to be one
# waterbody and not a lake fused to its own inflow.
PERMANENT_PCT = 90
# ...but the core is NOT the shoreline, and assuming it was would have poisoned
# every comparison this set exists to make. Kulekhani reads 0.73 km2 at 90%
# against a published 2.2: a reservoir is DRAWN DOWN, so its outer 60% of area
# is wet well under nine years in ten. Nepal's natural lakes do not do this -
# Rara reads 10.2 km2, within a few percent of its published extent - so the gap
# is operation, not error.
#
# The DEM holds the water surface on ONE capture date, at whatever level the
# reservoir happened to sit. The honest reference is therefore a BAND, and the
# app's own answer should be scored against the band rather than a point.
TYPICAL_PCT = 50
# Below this the shoreline is fewer than ~60 cells around and the area is mostly
# quantisation. Kulekhani is 2.2 km2; the smallest useful forebay is far under 1.
MIN_AREA_KM2 = 0.05
# Shape gate. A lake fills its bounding box; a river reach ribbons through one.
MAX_ELONGATION = 5.0
MIN_FILL = 0.15
# Connected components are found at 4x reduced resolution - 33 Mpx instead of
# 527 - and every area, centroid and shape number is then measured at full
# resolution inside the component's own box. Labelling 527 Mpx as int32 costs
# 2 GB to answer a question that does not need the precision.
BLOCK = 4


def fetch_tiles():
    STORE.mkdir(parents=True, exist_ok=True)
    for name in TILES:
        path = STORE / name
        if path.exists() and path.stat().st_size > 1_000_000:
            continue
        print("fetching " + name + " ...")
        urllib.request.urlretrieve(BUCKET + name, path)
        print("  %.0f MB" % (path.stat().st_size / 1e6))


def nepal_polygon():
    """
    The app's own boundary, read from the app's own file.

    `src/region.ts` already holds Natural Earth's Nepal outline and every
    request the app makes is gated on it. Parsing it here rather than shipping a
    second copy means the two can never drift, which is the whole reason
    SEARCH_KM lives in one module and is imported by both app and harness.
    """
    ts = (ROOT / "src" / "region.ts").read_text(encoding="utf8")
    body = re.search(r"const NEPAL\b[^=]*=\s*\[(.*?)\n\];", ts, re.S)
    if not body:
        sys.exit("could not find the NEPAL boundary literal in src/region.ts")
    pts = re.findall(r"\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]", body.group(1))
    poly = np.array([[float(x), float(y)] for x, y in pts])
    if len(poly) < 20:
        sys.exit("parsed only %d boundary vertices from src/region.ts" % len(poly))
    return poly


def in_nepal(lon, lat, poly):
    """Ray casting, vectorised over candidate centroids. Mirrors inNepal()."""
    x, y = poly[:, 0], poly[:, 1]
    inside = np.zeros(np.shape(lon), dtype=bool)
    with np.errstate(divide="ignore", invalid="ignore"):
        for i in range(len(poly)):
            j = i - 1
            straddles = (y[i] > lat) != (y[j] > lat)
            cut = np.where(
                y[j] != y[i], (x[j] - x[i]) * (lat - y[i]) / (y[j] - y[i]) + x[i], np.inf
            )
            inside ^= straddles & (lon < cut)
    return inside


def mosaic():
    """
    Nepal reaches 30.4 N, so it straddles two 10-degree tiles.

    Stitching the 0.4-degree northern strip on before labelling is five lines and
    it removes the seam entirely. Labelling the tiles separately would split any
    waterbody sitting on 30 N into two components, each below the area gate, and
    the drop would be silent.
    """
    parts = {}
    transform = None
    for name, bounds in TILES.items():
        with rasterio.open(STORE / name) as src:
            win = from_bounds(*bounds, src.transform)
            parts[name] = src.read(1, window=win)
            if "40N" in name:
                transform = src.window_transform(win)
    top = parts["occurrence_80E_40Nv1_4_2021.tif"]
    bottom = parts["occurrence_80E_30Nv1_4_2021.tif"]
    if top.shape[1] != bottom.shape[1]:
        sys.exit("tile widths differ: %s vs %s" % (top.shape, bottom.shape))
    return np.vstack([top, bottom]), transform


def find_waterbodies(occ, transform, poly, verbose=True):
    """
    Standing waterbodies in an occurrence raster, with their shoreline band.

    Split out of main() so `--self-check` can drive it with a synthetic raster
    whose answer is known by construction - the same trick
    checks/landcover.check.ts uses on the land-cover accounting, and the reason
    that harness caught a real mistake instead of agreeing with itself.
    """
    lon0, lat0 = transform.c, transform.f
    dlon, dlat = transform.a, transform.e  # dlat is negative
    if verbose:
        print("mosaic %d x %d = %.0f Mpx @ ~%.1f m"
              % (occ.shape[1], occ.shape[0], occ.size / 1e6, dlon * 111320))

    wet = (occ >= PERMANENT_PCT) & (occ <= 100)
    if verbose:
        print("permanent water (>= %d%% occurrence): %s cells = %.3f%% of the box"
              % (PERMANENT_PCT, format(int(wet.sum()), ","), 100 * wet.mean()))

    def area_km2_of(mask, row_offset):
        """Cell area shrinks with latitude; one row-wise cosine is the whole fix."""
        rows = np.nonzero(mask)[0]
        if rows.size == 0:
            return 0.0
        lat = lat0 + (row_offset + rows + 0.5) * dlat
        return float((cell_h_m * cell_h_m * np.cos(np.radians(lat))).sum() / 1e6)

    def extent_at(r0, r1, c0, c1, core, pct, pad=40):
        """
        The same waterbody at a looser occurrence threshold.

        Relaxing the threshold in place would fuse a lake to whatever river runs
        into it, so the looser mask is re-labelled inside a padded box and only
        the components the core actually touches are kept. The pad bounds how far
        a drawdown ring can be chased; a body whose looser extent reaches the pad
        is reported as pad-limited rather than silently truncated.
        """
        pr0, pr1 = max(0, r0 - pad), min(h, r1 + pad)
        pc0, pc1 = max(0, c0 - pad), min(w, c1 + pad)
        window = occ[pr0:pr1, pc0:pc1]
        loose = (window >= pct) & (window <= 100)
        lab, _ = ndimage.label(loose, structure=np.ones((3, 3), dtype=int))
        seeded = np.zeros_like(loose)
        seeded[r0 - pr0:r1 - pr0, c0 - pc0:c1 - pc0] = core
        ids = np.unique(lab[seeded])
        ids = ids[ids > 0]
        sel = np.isin(lab, ids)
        limited = bool(sel[0, :].any() or sel[-1, :].any() or sel[:, 0].any() or sel[:, -1].any())
        return area_km2_of(sel, pr0), limited

    h, w = wet.shape
    rh, rw = h // BLOCK, w // BLOCK
    reduced = wet[: rh * BLOCK, : rw * BLOCK].reshape(rh, BLOCK, rw, BLOCK).any(axis=(1, 3))
    labels, count = ndimage.label(reduced, structure=np.ones((3, 3), dtype=int))
    if verbose:
        print("%s connected components at %dx reduced resolution" % (format(count, ","), BLOCK))

    # Cell area varies with latitude; a degree of longitude shrinks toward the
    # pole. One row-wise cosine term is the whole correction at this scale.
    cell_h_m = abs(dlat) * 111_320.0

    dropped = {"too small": 0, "ribbon": 0, "outside Nepal": 0, "window edge": 0}
    found = []
    for idx, box in enumerate(ndimage.find_objects(labels), start=1):
        if box is None:
            continue
        r0, r1 = box[0].start * BLOCK, box[0].stop * BLOCK
        c0, c1 = box[1].start * BLOCK, box[1].stop * BLOCK
        member = np.repeat(np.repeat(labels[box] == idx, BLOCK, 0), BLOCK, 1)
        sub = wet[r0:r1, c0:c1] & member[: r1 - r0, : c1 - c0]
        rows, cols = np.nonzero(sub)
        if rows.size == 0:
            continue

        lat = lat0 + (r0 + rows + 0.5) * dlat
        lon = lon0 + (c0 + cols + 0.5) * dlon
        core_km2 = area_km2_of(sub, r0)
        if core_km2 < MIN_AREA_KM2:
            dropped["too small"] += 1
            continue

        bh = int(rows.max() - rows.min()) + 1
        bw = int(cols.max() - cols.min()) + 1
        elongation = max(bh, bw) / float(max(1, min(bh, bw)))
        fill = rows.size / float(bh * bw)
        if elongation > MAX_ELONGATION or fill < MIN_FILL:
            dropped["ribbon"] += 1
            continue

        """
        THE CENTROID OF A LAKE IS NOT NECESSARILY IN THE LAKE.

        This shipped as the mean of the wet cells for one round of runs, and
        Kulekhani caught it: a 7 km reservoir winding between ridges has its mean
        position on the HILLSIDE BETWEEN ITS ARMS. The harness read 1553 m there
        against a water surface at 1533, found three connected cells instead of a
        plateau, and reported the country's only large reservoir as unscoreable -
        on both terrain products, which is what made it look like terrain rather
        than arithmetic.

        The point furthest from the shore is inside the waterbody by
        construction, and it is also the best seed available: it maximises the
        distance to the nearest bank, so a noisy shoreline cannot reach it.
        """
        # Pad first. distance_transform_edt measures distance to the nearest
        # ZERO, and a component whose bounding box it fills completely contains
        # none - so the transform runs away and argmax lands in a CORNER. The
        # synthetic square in --self-check put the seed 1,094 m from centre with
        # a claimed 2.3 km of clearance inside a 1.6 km box, which is how this
        # was caught rather than shipped.
        interior = ndimage.distance_transform_edt(np.pad(sub, 1))[1:-1, 1:-1]
        ir, ic = np.unravel_index(int(np.argmax(interior)), interior.shape)
        ilat = lat0 + (r0 + ir + 0.5) * dlat
        ilon = lon0 + (c0 + ic + 0.5) * dlon
        # Kept for the record: the gap between the two is exactly the defect
        # above, and a reader should be able to see which rows had one.
        clat, clon = float(lat.mean()), float(lon.mean())
        seed_offset_m = math.hypot(
            (ilat - clat) * 111_320.0,
            (ilon - clon) * 111_320.0 * math.cos(math.radians(clat)),
        )
        clat, clon = float(ilat), float(ilon)
        if not bool(in_nepal(np.array([clon]), np.array([clat]), poly)[0]):
            dropped["outside Nepal"] += 1
            continue
        if r0 == 0 or c0 == 0 or r1 >= h or c1 >= w:
            dropped["window edge"] += 1
            continue

        typical_km2, pad_limited = extent_at(r0, r1, c0, c1, sub, TYPICAL_PCT)
        found.append({
            "lat": round(clat, 6),
            "lon": round(clon, 6),
            "coreKm2": round(core_km2, 4),
            "typicalKm2": round(typical_km2, 4),
            "seedOffsetM": round(seed_offset_m, 1),
            "seedClearanceM": round(float(interior[ir, ic]) * cell_h_m, 1),
            "padLimited": pad_limited,
            "drawdownRatio": round(core_km2 / typical_km2, 3) if typical_km2 > 0 else None,
            "pixels": int(rows.size),
            "elongation": round(elongation, 2),
            "fill": round(fill, 3),
            "extentKm": [round(bw * dlon * 111.32 * math.cos(math.radians(clat)), 2),
                         round(bh * abs(dlat) * 111.32, 2)],
        })

    found.sort(key=lambda f: -f["typicalKm2"])
    if verbose:
        print("\nkept %d waterbodies; dropped %s"
              % (len(found), ", ".join("%s %s" % (format(n, ","), why) for why, n in dropped.items())))
    return found, dropped


def self_check():
    """
    python pipeline/build-pondage-references-gsw.py --self-check

    A synthetic occurrence raster whose answer is known by construction. Four
    shapes, each standing for one way this could go wrong on the real one:

      a plain square lake         - area and seed arithmetic
      a lake inside a wider ring  - the shoreline BAND, and that relaxing the
                                    threshold does not leak into the neighbours
      a C-shaped lake             - the seed must be IN the water, which the
                                    mean position is not; this is Kulekhani
      a long thin ribbon          - a river must not be filed as a pond
      a two-cell speck            - below the area floor

    Placed at 28 N inside Nepal so the latitude term is exercised rather than
    assumed away.
    """
    res = 0.00025
    rows, cols = 800, 800
    north, west = 28.30, 84.30
    transform = rasterio.Affine(res, 0, west, 0, -res, north)
    occ = np.zeros((rows, cols), dtype=np.uint8)

    # 60 x 60 cells of always-wet water.
    occ[100:160, 100:160] = 100
    # A 40 x 40 core inside an 80 x 80 seasonal ring: the band is core 40^2,
    # typical 80^2, and nothing outside the ring may join at 50%.
    occ[300:380, 300:380] = 70
    occ[320:360, 320:360] = 100
    # A C: two arms and a spine, with the mouth open. Its mean position sits in
    # the dry gap between the arms, which is Kulekhani's failure exactly.
    occ[500:560, 100:120] = 100   # spine
    occ[500:520, 100:180] = 100   # upper arm
    occ[540:560, 100:180] = 100   # lower arm
    # A ribbon 4 cells wide and 300 long - permanent water, and not a pond.
    occ[600:604, 200:500] = 100
    # Two cells. Real water, far under any useful pond.
    occ[700:701, 600:602] = 100

    poly = np.array([[80.0, 26.0], [89.0, 26.0], [89.0, 31.0], [80.0, 31.0]])
    found, dropped = find_waterbodies(occ, transform, poly, verbose=False)

    cell_m = res * 111_320.0
    lat = north - 130 * res
    square_km2 = 60 * 60 * cell_m * cell_m * math.cos(math.radians(lat)) / 1e6

    assert len(found) == 3, "expected the square, the ringed lake and the C, got %d" % len(found)
    assert dropped["ribbon"] == 1, "the ribbon was not rejected: %r" % dropped
    assert dropped["too small"] == 1, "the two-cell speck was not dropped: %r" % dropped

    def at(row):
        return next(f for f in found if abs(f["lat"] - (north - row * res)) < 60 * res)

    ring, square, cee = at(340), at(130), at(530)

    assert abs(square["coreKm2"] - square_km2) / square_km2 < 0.01, \
        "square area %.4f against %.4f expected" % (square["coreKm2"], square_km2)
    assert abs(square["drawdownRatio"] - 1.0) < 0.02, \
        "a lake with no seasonal margin must have a band of 1.0, got %s" % square["drawdownRatio"]
    # The ring is 4x the core by construction, so the ratio is 1/4.
    assert abs(ring["typicalKm2"] / ring["coreKm2"] - 4.0) < 0.05, \
        "band should widen 4x, got %.2f" % (ring["typicalKm2"] / ring["coreKm2"])
    assert abs(ring["drawdownRatio"] - 0.25) < 0.01, \
        "drawdown ratio should be 0.25, got %s" % ring["drawdownRatio"]
    assert not ring["padLimited"], "the ring is well inside the pad and must not be flagged"

    # The seed lands in the MIDDLE of the square, not in a corner. An unpadded
    # distance transform put it 1,094 m out with 2.3 km of claimed clearance
    # inside a 1.6 km box; this is the assertion that caught it.
    assert abs(square["lat"] - (north - 130 * res)) < 2 * res, \
        "square seed latitude off by %.1f cells" % abs(square["lat"] - (north - 130 * res)) / res
    assert abs(square["lon"] - (west + 130 * res)) < 2 * res, "square seed longitude off"
    assert abs(square["seedOffsetM"]) < 60, \
        "a convex lake's seed should sit on its centroid, moved %.0f m" % square["seedOffsetM"]
    assert 780 < square["seedClearanceM"] < 900, \
        "a 60-cell square has ~835 m of clearance, got %.0f" % square["seedClearanceM"]

    # THE REGRESSION. The C's mean position is in the dry gap between its arms;
    # its seed must be in water. Checked against the raster itself, not against
    # a coordinate, because that is the property that actually matters.
    def wet_at(lat_, lon_):
        row = int(round((north - lat_) / res - 0.5))
        col = int(round((lon_ - west) / res - 0.5))
        return bool(occ[row, col] >= PERMANENT_PCT)

    c_rows, c_cols = np.nonzero(occ[500:560, 100:180] >= PERMANENT_PCT)
    mean_lat = north - (500 + c_rows.mean() + 0.5) * res
    mean_lon = west + (100 + c_cols.mean() + 0.5) * res
    assert not wet_at(mean_lat, mean_lon), \
        "the C fixture is wrong: its mean position is already in water"
    assert wet_at(cee["lat"], cee["lon"]), \
        "the C's seed is on dry land - this is the Kulekhani bug"
    assert cee["seedOffsetM"] > 100, \
        "the C's seed should have moved well off its centroid, moved %.0f m" % cee["seedOffsetM"]

    # Outside the boundary polygon nothing survives, however real the water is.
    far = np.array([[70.0, 10.0], [71.0, 10.0], [71.0, 11.0], [70.0, 11.0]])
    none, dropped_far = find_waterbodies(occ, transform, far, verbose=False)
    assert len(none) == 0 and dropped_far["outside Nepal"] == 3, \
        "boundary filter did not fire: %d kept, %r" % (len(none), dropped_far)

    print("self-check OK: 3 waterbodies kept, ribbon and speck rejected, band 4x on the "
          "ringed lake, the C's seed is in water where its centroid is not, boundary "
          "filter fires")

def main():
    fetch_tiles()
    poly = nepal_polygon()
    occ, transform = mosaic()
    found, dropped = find_waterbodies(occ, transform, poly)

    # Tag, do not drop. A glacial lake is a good geometry test and a bad forebay,
    # and the reader is entitled to know which rows are which.
    glacial = json.loads((ROOT / "src/data/nepal-glacial-lakes.json").read_text())["lakes"]
    published = json.loads((ROOT / "pipeline/pondage-references.json").read_text())["reservoirs"]

    def near(a_lat, a_lon, b_lat, b_lon, km):
        dy = (a_lat - b_lat) * 111.32
        dx = (a_lon - b_lon) * 111.32 * math.cos(math.radians(a_lat))
        return math.hypot(dx, dy) <= km

    out = []
    for f in found:
        hit = next((g for g in glacial if near(f["lat"], f["lon"], g[9], g[10], 1.0)), None)
        known = next((p for p in published
                      if near(f["lat"], f["lon"], p["dam"]["lat"], p["dam"]["lon"], 5.0)), None)
        name = known["name"] if known else "GSW %.4fN %.4fE" % (f["lat"], f["lon"])
        out.append({
            "name": name,
            "country": "Nepal",
            "dam": {"lat": f["lat"], "lon": f["lon"]},
            "damCoordinateNote":
                "The point of the GSW permanent-water component furthest from its own "
                "shore - inside the waterbody by construction, which its centroid is "
                "not: Kulekhani's mean position lands on the ridge between two arms. "
                "Not a structure. The harness centres its terrain window here and "
                "derives the outlet from the DEM; there is no surveyed dam at most of "
                "these sites.",
            "seed": {
                # How far the interior point had to move off the mean position, and
                # how much water surrounds it. A large offset means a non-convex
                # waterbody whose centroid was outside it.
                "offsetFromCentroidM": f["seedOffsetM"],
                "clearanceToShoreM": f["seedClearanceM"],
            },
            # Left null on purpose: the harness reads the plateau elevation out of
            # the raster at the window centre, which for a standing waterbody IS
            # the water surface. A published level would be a worse number here.
            "fullSupplyLevelM": None,
            # The headline reference is the TYPICAL shoreline - wet in at least
            # half of 38 years of observations - because that is the level a DEM
            # capture is most likely to have caught. The always-wet core is the
            # lower edge of the band, not a competing answer.
            "surfaceAreaKm2": f["typicalKm2"],
            "surfaceAreaBandKm2": [f["coreKm2"], f["typicalKm2"]],
            "grossStorageMm3": None,
            "damCrestLengthM": None,
            "measuredNot": "published",
            "gsw": {
                "coreKm2": f["coreKm2"],
                "typicalKm2": f["typicalKm2"],
                "corePct": PERMANENT_PCT,
                "typicalPct": TYPICAL_PCT,
                # Core over typical. Near 1 the shoreline barely moves in 38
                # years, so the band is tight and the site scores sharply. Well
                # under 1 means an operated drawdown or a seasonal margin, and
                # the app can only be asked to land inside the band.
                "drawdownRatio": f["drawdownRatio"],
                "padLimited": f["padLimited"],
                # The rows worth reading a headline off. A band inside 1.25x is
                # a shoreline that barely moved in 38 years, so a prediction can
                # actually be right or wrong about it; a body whose extent
                # quadruples between thresholds is a seasonal floodplain and
                # scoring against it measures the monsoon, not the screen.
                "sharp": bool(f["drawdownRatio"] is not None
                              and f["drawdownRatio"] >= 0.8 and not f["padLimited"]),
                "pixels": f["pixels"],
                "elongation": f["elongation"],
                "fill": f["fill"],
                "extentKm": f["extentKm"],
            },
            "glacialLake": None if hit is None else {
                "id": hit[0], "type": hit[3], "elevationM": hit[4], "basin": hit[2],
            },
            "alsoPublished": None if known is None else {
                "surfaceAreaKm2": known["surfaceAreaKm2"], "source": known["source"],
            },
            "source": "JRC Global Surface Water v1.4 (Pekel et al. 2016), EC JRC/Google",
            "test": "area-at-measured-shoreline",
            "testNote":
                "GSW's own permanent-water extent is the reference area. The DEM carries "
                "this waterbody as a flat plateau, so filling from a seed in that plateau "
                "to the plateau's elevation should reproduce it. Scores the connected "
                "fill, the barrier and the area integration. Does NOT score storage: no "
                "bathymetry is present under standing water, so a predicted volume is a "
                "lower bound by construction.",
        })

    tagged = sum(1 for o in out if o["glacialLake"])
    OUT.write_text(json.dumps({
        "_what": "Nepali waterbodies measured from space, for scoring the pondage screen "
                 "against a population instead of against Kulekhani alone.",
        "_why": "See the header of pipeline/build-pondage-references-gsw.py.",
        "_caution":
            "A modern DEM over standing water samples the SURFACE, not the drowned "
            "valley. These sites test the fill, the barrier and the shoreline "
            "integration against real, complex shorelines at a known level; they "
            "cannot test the stage-storage relation below that level. Every area here "
            "is MEASURED by satellite, not published by a designer, and carries GSW's "
            "own ~28 m footprint. This set is also biased toward large open water - at "
            "30 m only 4% of Nepal's commissioned plants have any GSW water within "
            "150 m - so it is a real population and NOT the use population.",
        "_source": "JRC Global Surface Water v1.4, 1984-2021, ~28 m. Free of charge, "
                   "without restriction of use. Cite: Pekel et al., Nature 2016; EC JRC/Google.",
        "_thresholds": {
            "permanentOccurrencePct": PERMANENT_PCT,
            "minAreaKm2": MIN_AREA_KM2,
            "maxElongation": MAX_ELONGATION,
            "minFill": MIN_FILL,
        },
        "_dropped": dropped,
        "_glacialLakesTagged": tagged,
        "_generated": datetime.date.today().isoformat(),
        "reservoirs": out,
    }, indent=2))

    print("wrote %s: %d waterbodies (%d matched to the ICIMOD glacial-lake inventory)\n"
          % (OUT.relative_to(ROOT), len(out), tagged))
    print("  %-30s %9s %9s %7s" % ("", "core", "typical", "ratio"))
    for o in out[:25]:
        tag = "  [glacial %.0f m]" % o["glacialLake"]["elevationM"] if o["glacialLake"] else ""
        pub = "  published %s km2" % o["alsoPublished"]["surfaceAreaKm2"] if o["alsoPublished"] else ""
        g = o["gsw"]
        print("  %-30s %8.3f %8.3f %7s%s%s"
              % (o["name"][:30], g["coreKm2"], g["typicalKm2"], g["drawdownRatio"], tag, pub))
    if len(out) > 25:
        print("  ... and %d more" % (len(out) - 25))

    ratios = [o["gsw"]["drawdownRatio"] for o in out if o["gsw"]["drawdownRatio"]]
    ratios.sort()
    if ratios:
        print("\ndrawdown ratio (core/typical) across %d bodies: p10 %.2f  median %.2f  p90 %.2f"
              % (len(ratios), ratios[len(ratios) // 10], ratios[len(ratios) // 2],
                 ratios[min(len(ratios) - 1, 9 * len(ratios) // 10)]))
        tight = sum(1 for r in ratios if r >= 0.8)
        print("%d of %d have a band tighter than 1.25x - those are the rows that can "
              "score sharply." % (tight, len(ratios)))
    padded = sum(1 for o in out if o["gsw"]["padLimited"])
    if padded:
        print("%d bodies reached the drawdown pad; their typical extent is a lower bound."
              % padded)


if __name__ == "__main__":
    if "--self-check" in sys.argv:
        self_check()
    else:
        main()
