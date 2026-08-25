"""
Is the geological overlay actually where it says it is?

    python checks/geology-georeference.py

WHY THE BUILDER'S OWN NUMBER IS NOT AN ANSWER. build-dmg-geology.py reports a
graticule residual — 19 m on Madhesh, 620 m on Sudurpaschim — and that figure is
a SELF-CHECK. It says the projective model reproduces the sheet's own graticule
intersections. It cannot say whether those intersections were read correctly in
the first place: if the assumption that a tick label sits offset ALONG its
graticule line were wrong, every control point would shift together, the fit
would stay just as tight, and the whole sheet would hang in the wrong place.

WHAT THIS USES INSTEAD. The sheets print spot heights — hundreds of surveyed
elevations scattered across the map. The app carries a 30 m elevation model of
Nepal. Those two were produced by unrelated organisations from unrelated
surveys, so agreement between them is evidence and disagreement is a fault.

AND IT SOLVES FOR THE ERROR RATHER THAN ASSERTING IT. Comparing at the placed
position gives one number; searching a grid of candidate shifts and finding
which one makes the elevations agree BEST gives the placement error itself. A
sheet hung correctly has its optimum at zero offset. A sheet a kilometre out
announces it as a kilometre-shifted optimum, however tight its internal fit.

A spot height is usually a summit, and a 30 m DEM rounds summits off, so the DEM
is expected to read a little low. That is a bias, not a displacement, and the
shift search is unaffected by it.
"""

import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'pipeline'))

try:
    import fitz  # noqa: F401
    import numpy as np
except ImportError:
    print('needs pymupdf and numpy', file=sys.stderr)
    raise SystemExit(1)

import importlib.util

spec = importlib.util.spec_from_file_location(
    'dmg', os.path.join(os.path.dirname(__file__), '..', 'pipeline', 'build-dmg-geology.py')
)
dmg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dmg)

DEM_BIN = 'sources/gedtm/nepal-gedtm.bin'
DEM_META = 'sources/gedtm/nepal-gedtm.json'

# A printed number in this range on a Nepali sheet is an elevation.
ELEV = re.compile(r'^(\d{3,4})$')
MIN_M, MAX_M = 200, 8500

# How far to search for a better placement, and how finely.
SEARCH_KM = 3.0
STEP_KM = 0.25


def load_dem():
    if not (os.path.exists(DEM_BIN) and os.path.exists(DEM_META)):
        return None
    meta = json.load(open(DEM_META, encoding='utf-8'))
    arr = np.memmap(DEM_BIN, dtype='<u2', mode='r', shape=(meta['rows'], meta['cols']))
    return meta, arr


def sample(meta, arr, lat, lon):
    """Nearest-cell elevation, or NaN outside the store or at no-data."""
    c = int(round((lon - meta['west']) / meta['pixelDeg'] - 0.5))
    r = int(round((meta['north'] - lat) / meta['pixelDeg'] - 0.5))
    if not (0 <= r < meta['rows'] and 0 <= c < meta['cols']):
        return math.nan
    v = int(arr[r, c])
    if v == meta['nodata']:
        return math.nan
    return v / meta['scale'] + meta['offset']


def main() -> int:
    dem = load_dem()
    if not dem:
        print(f'No elevation store at {DEM_BIN} — run `npm run build:gedtm` first.', file=sys.stderr)
        return 1
    meta, arr = dem

    index_path = f'{dmg.OUT_DIR}/index.json'
    if not os.path.exists(index_path):
        print('No geology tiles — run `npm run build:geology` first.', file=sys.stderr)
        return 1
    placed = set(json.load(open(index_path, encoding='utf-8'))['_accuracy'])

    print('spot heights on each sheet against the 30 m elevation model\n')
    print(f"{'sheet':<14}{'n':>5}{'median |dz|':>13}{'best shift':>13}{'dz at best':>12}")
    print('-' * 57)

    worst_shift = 0.0
    measured = {}
    for name in dmg.SHEETS:
        if name not in placed:
            continue
        doc = fitz.open(f'{dmg.PDF_DIR}/{name}.pdf')
        page = doc[0]
        geo, why = dmg.georeference(page)
        if not geo:
            print(f'{name:<14}  rejected: {why}')
            continue
        nx0, ny0, nx1, ny1 = geo['neat']

        pts = []
        for x0, y0, x1, y1, text, *_ in page.get_text('words'):
            hit = ELEV.match(text.strip())
            if not hit:
                continue
            z = int(hit.group(1))
            if not (MIN_M <= z <= MAX_M):
                continue
            # SAMPLE THE LEFT EDGE, NOT THE CENTRE.
            #
            # At 8.2 pt per km these sheets print a four-digit height nearly
            # 2 km wide on the ground, and the dot it labels sits at its left
            # edge. Sampling the word centre therefore lands about a kilometre
            # east of the point, and the shift search dutifully reported that
            # as a westward placement error on every sheet — dx negative, five
            # times out of five, while dy scattered. It was measuring the
            # ruler, not the map.
            cx, cy = x0, (y0 + y1) / 2
            # Inside the neat-line only: the collar carries legend numbers.
            if not (nx0 <= cx <= nx1 and ny0 <= cy <= ny1):
                continue
            ll = dmg.apply_h(geo['inv'], cx, cy)
            if ll:
                pts.append((ll[0], ll[1], z))
        if len(pts) < 25:
            print(f'{name:<14}{len(pts):>5}   too few spot heights to judge')
            doc.close()
            continue

        mid_lat = sum(p[1] for p in pts) / len(pts)
        deg_per_km_lat = 1 / 111.32
        deg_per_km_lon = 1 / (111.32 * math.cos(math.radians(mid_lat)))

        def median_dz(dx_km, dy_km):
            diffs = []
            for lon, lat, z in pts:
                dz = sample(meta, arr, lat + dy_km * deg_per_km_lat, lon + dx_km * deg_per_km_lon)
                if not math.isnan(dz):
                    diffs.append(abs(dz - z))
            return (float(np.median(diffs)) if diffs else math.inf), len(diffs)

        base, n_used = median_dz(0.0, 0.0)
        best = (base, 0.0, 0.0)
        steps = int(SEARCH_KM / STEP_KM)
        for i in range(-steps, steps + 1):
            for j in range(-steps, steps + 1):
                dx, dy = i * STEP_KM, j * STEP_KM
                if dx == 0 and dy == 0:
                    continue
                m, _ = median_dz(dx, dy)
                if m < best[0]:
                    best = (m, dx, dy)
        shift = math.hypot(best[1], best[2])
        worst_shift = max(worst_shift, shift)
        measured[name] = {
            'placementKm': round(shift, 2),
            'spotHeights': n_used,
            'medianDzM': round(base),
            'searchStepKm': STEP_KM,
        }
        bearing = (math.degrees(math.atan2(best[1], best[2])) + 360) % 360
        print(
            f'{name:<14}{n_used:>5}{base:>11.0f} m'
            f'{shift:>10.2f} km{best[0]:>10.0f} m'
            f'   dx={best[1]:+.2f} dy={best[2]:+.2f} bearing={bearing:5.0f}'
        )
        doc.close()

    print()
    print(
        'A sheet placed correctly has its best shift at or near zero: moving it does not\n'
        'make the printed heights agree with the terrain any better. The residual dz is\n'
        'dominated by a 30 m model rounding off the summits these heights sit on, so it\n'
        'is the SHIFT that measures placement, not the dz.'
    )
    print(f'\nlargest shift found: {worst_shift:.2f} km (search was +/-{SEARCH_KM:.0f} km)')

    # Written beside the tiles rather than into index.json: a check must never
    # be able to damage what the builder produced.
    if measured:
        out = f'{dmg.OUT_DIR}/placement.json'
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(
                {
                    '_what': 'Measured placement error per sheet, from printed spot heights against a 30 m elevation model.',
                    '_method': (
                        'The shift that minimises the median elevation disagreement. A correctly '
                        'placed sheet optimises at zero. Floors: the model rounds summits off, the '
                        f'label anchor is approximate, and the search steps {STEP_KM} km — so a '
                        'figure at the step size means "at or below", not "exactly".'
                    ),
                    'sheets': measured,
                },
                f,
                indent=1,
            )
        print(f'wrote {out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
