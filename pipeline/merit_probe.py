"""
Does MERIT Hydro's upstream-drainage-area raster fix what HydroRIVERS gets wrong?

    python pipeline/merit_probe.py

HydroRIVERS gives one precomputed catchment area PER REACH, derived at ~500 m.
MERIT Hydro gives one PER PIXEL at 92.77 m, already accumulated. Before building
a pipeline around it, this checks the claim against two things we can score:

  the ten built plants, whose catchments are roughly known from their design
  flow (Nepal runs 0.005-0.25 m3/s per km2), and

  the DHM gauges, where a measured mean flow implies a catchment size directly.

SNAPPING: upstream area is only large ON the channel; one pixel off a big river
it collapses. So a point is sampled as the MAXIMUM within a small window, which
is the same "snap to high accumulation cell" every delineation tool does. The
window is reported so it can be argued with.
"""
import json
import math
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

TILES = {
    (25, 80): 'sources/merit-hydro/n25e080_upa.tif',
    (25, 85): 'sources/merit-hydro/n25e085_upa.tif',
}
STEP = 1.0 / 1200.0          # 3 arcsec
SNAP_PX = 3                  # +/- 3 px ~ 280 m; a published coordinate is rarely better

_cache = {}


def _tile(lat, lon):
    key = (int(math.floor(lat / 5) * 5), int(math.floor(lon / 5) * 5))
    if key not in TILES:
        return None, None
    if key not in _cache:
        _cache[key] = np.array(Image.open(TILES[key]))
    # Tiepoint: raster (0,0) is the top-left CORNER, at lon key[1]-half-pixel,
    # lat key[0]+5-half-pixel. Read straight off the file rather than assumed.
    return _cache[key], key


def upa(lat, lon, snap_px=SNAP_PX):
    """Upstream drainage area, km2, as the max within +/- snap_px."""
    a, key = _tile(lat, lon)
    if a is None:
        return None
    origin_lon = key[1] - STEP / 2
    origin_lat = key[0] + 5 - STEP / 2
    col = int(round((lon - origin_lon) / STEP))
    row = int(round((origin_lat - lat) / STEP))
    if not (0 <= row < a.shape[0] and 0 <= col < a.shape[1]):
        return None
    r0, r1 = max(0, row - snap_px), min(a.shape[0], row + snap_px + 1)
    c0, c1 = max(0, col - snap_px), min(a.shape[1], col + snap_px + 1)
    w = a[r0:r1, c0:c1]
    return float(np.nanmax(w)) if w.size else None


if __name__ == '__main__':
    SPEC_MIN, SPEC_MAX = 0.005, 0.25

    print('\n=== BUILT PLANTS: catchment implied by design flow vs MERIT ===\n')
    val = json.load(open('src/data/validation.json', encoding='utf-8'))
    print(f"{'plant':<20}{'Q act':>7}{'HydroRIV':>10}{'q/A':>8}{'MERIT':>9}{'q/A':>8}  verdict")
    print('-' * 78)
    for p in val['plants']:
        q = (p.get('actual') or {}).get('designQ')
        lat, lon = p['intake']
        m = upa(lat, lon)
        hr = (p.get('result') or {}).get('predicted', {}).get('catchmentKm2')
        # fall back: the harness does not always record it; use the note table
        line = f"{p['name']:<20}{(q or 0):>7.1f}"
        if m is None:
            print(line + '   (outside the two tiles)')
            continue
        sm = q / m if q and m > 0 else None
        ok = sm is not None and SPEC_MIN <= sm <= SPEC_MAX
        print(
            line
            + f"{'-' if hr is None else f'{hr:.0f}':>10}"
            + f"{'-':>8}"
            + f"{m:>9.0f}"
            + (f"{sm:>8.3f}" if sm else f"{'-':>8}")
            + ('  plausible' if ok else '  IMPLAUSIBLE' if sm else '')
        )

    print('\n=== DHM GAUGES: catchment implied by measured mean flow ===\n')
    rec = json.load(open('src/data/dhm-records.json', encoding='utf-8'))
    rows = []
    for s in rec['stations']:
        if s.get('lat') is None or (s.get('completeYears') or 0) < 10:
            continue
        if not (s.get('meanCms', 0) > 0):
            continue
        m = upa(s['lat'], s['lon'])
        if m is None or m <= 0:
            continue
        rows.append((s['river'], s['meanCms'], m, s['meanCms'] / m))
    good = [r for r in rows if SPEC_MIN <= r[3] <= SPEC_MAX]
    print(f"{len(rows)} gauges inside the two tiles")
    print(f"{len(good)} give a plausible specific discharge on MERIT area "
          f"({100*len(good)/max(1,len(rows)):.0f}%)")
    bad = [r for r in rows if r not in good]
    if bad:
        print('\n  implausible on MERIT:')
        for r in sorted(bad, key=lambda x: -abs(math.log(x[3] / 0.03)))[:10]:
            print(f"    {r[0]:<22} {r[1]:>8.1f} m3/s   MERIT {r[2]:>8.0f} km2   {r[3]:.4f}")
    sp = np.array([r[3] for r in good])
    if sp.size:
        print(f"\n  specific discharge on the plausible set: "
              f"median {np.median(sp):.3f}, 10-90% {np.percentile(sp,10):.3f}-{np.percentile(sp,90):.3f}")
