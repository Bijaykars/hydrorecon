"""
Nepal's published geological maps, cut into tiles the app can lay under a site.

    python pipeline/build-dmg-geology.py

WHY THIS EXISTS. The engineering-geology section of the desk study had nothing
to say. Macrostrat is the only live source and it carries ONE polygon over the
whole country — "Precambrian-Phanerozoic sedimentary rocks", 443-1000 Ma — which
is not an engineering input: it cannot separate phyllite from quartzite from
gneiss, place a contact, or hint at tunnelling behaviour. Its finer scales
return nothing over Nepal, so there was nothing to tune.

WHAT THIS USES INSTEAD. The Department of Mines and Geology publishes a
geological map for each of the seven provinces, free, as a vector PDF. They are
1:350,000 — roughly thirty times finer than the global layer — and they carry
mapped units, thrusts, fold axes and bedding attitudes.

WHY NO CONTROL POINTS ARE NEEDED, AND WHY THE OBVIOUS MODEL IS WRONG. Each
sheet prints its own graticule with labelled ticks on all four edges, so it
carries its own control. The first attempt fitted a straight affine transform
from degrees to page points and every one of the seven sheets was rejected. That
rejection was correct, and it identified the reason: on Gandaki the 84 E meridian
has identical x at the top and bottom edges, while 83 E and 85 E drift 20 pt
between them, symmetrically. Meridians CONVERGE. These are conic-projected
sheets — which is what a national map at this scale would use — and an affine
model cannot represent that.

So the graticule is reconstructed as lines rather than as an axis. A meridian is
the line through its top and bottom labels; a parallel the line through its left
and right ones. A label sits OUTSIDE the neat-line, offset along its own
graticule line, which shifts it up or sideways but not off the line — so the
intersections of those lines are true control points. A projective transform is
then fitted to them in both directions.

A sheet whose graticule cannot be read, or whose fit is poor, is REJECTED rather
than placed by guesswork — the same rule topo-overlay.ts follows for the survey
scans, and for the same reason: a map slid a kilometre sideways is worse than no
map.

WHAT IT IS AND IS NOT. This is an image overlay. The unit codes on the polygons
need the sheet's own legend to decode, so it shows the geology rather than
answering questions about it; extracting attributed polygons is a different and
much harder job.

OUTPUT
  sources/geology/<province>-<lat>-<lon>.png   0.25-degree tiles
  sources/geology/index.json                   bbox and file for each tile

Not committed: derived from third-party government PDFs, and about a hundred
megabytes. The PDFs are free downloads from the department's own resources page;
DMG sells printed sheets separately, so do not redistribute these.
"""

import io
import json
import math
import os
import re
import sys
import urllib.request

try:
    import fitz  # PyMuPDF
except ImportError:
    print('PyMuPDF is required:  pip install pymupdf', file=sys.stderr)
    raise SystemExit(1)

OUT_DIR = 'sources/geology'
PDF_DIR = f'{OUT_DIR}/pdf'

# From https://dmgnepal.gov.np/en/resources/province-and-regional-geological-maps-6665
SHEETS = {
    'koshi': 'https://dmgnepal.gov.np/uploads/documents/province-1pdf-3496-093-1719252604.pdf',
    'madhesh': 'https://dmgnepal.gov.np/uploads/documents/province-2pdf-9249-930-1719252584.pdf',
    'bagmati': 'https://dmgnepal.gov.np/uploads/documents/province-3pdf-9447-172-1719252551.pdf',
    'gandaki': 'https://dmgnepal.gov.np/uploads/documents/province-4pdf-6955-933-1719252530.pdf',
    'lumbini': 'https://dmgnepal.gov.np/uploads/documents/province-5pdf-7454-040-1719252506.pdf',
    'karnali': 'https://dmgnepal.gov.np/uploads/documents/province-6pdf-7966-103-1719252483.pdf',
    'sudurpaschim': 'https://dmgnepal.gov.np/uploads/documents/province-7pdf-8257-655-1719252462.pdf',
}

# Tiles are cut on the PAGE, not on the graticule.
#
# The sheet is conic, so a lat/lon rectangle is a curved quadrilateral on paper
# and cropping one would need resampling. A page rectangle needs none: its four
# corners are simply four lon/lat points, and a MapLibre image source places an
# image by its corners — which is how topo-overlay.ts already hangs the rotated
# survey scans. 200 pt is close to a quarter degree on these sheets.
TILE_PT = 200
TILE_DPI = 200

# Nepal. Anything outside these is a misread label, not a graticule tick.
LAT_RANGE = (25.5, 31.0)
LON_RANGE = (79.5, 89.0)

# Beyond this the transform is not trustworthy and the sheet is dropped.
# Measured on the control points themselves, so it detects a projection the
# model cannot represent — which is exactly what caught the conic sheets.
MAX_RESIDUAL_PT = 6.0

# "85°0'", "84°30'" — the degree sign survives extraction unreliably, so accept
# any run of non-digits between the two numbers.
TICK = re.compile(r"^(\d{2,3})\D+(\d{1,2})\s*['′]?$")


def fetch(name: str, url: str) -> str:
    os.makedirs(PDF_DIR, exist_ok=True)
    path = f'{PDF_DIR}/{name}.pdf'
    if os.path.exists(path) and os.path.getsize(path) > 100_000:
        return path
    print(f'  downloading {name}…')
    req = urllib.request.Request(url, headers={'User-Agent': 'HydroRecon/1.0 (desk study screening)'})
    with urllib.request.urlopen(req, timeout=180) as r, open(path, 'wb') as f:
        f.write(r.read())
    return path


def line_through(a, b):
    """Line through two points as (A, B, C) with A x + B y = C."""
    (x0, y0), (x1, y1) = a, b
    return (y1 - y0, x0 - x1, (y1 - y0) * x0 + (x0 - x1) * y0)


def intersect(l0, l1):
    a0, b0, c0 = l0
    a1, b1, c1 = l1
    det = a0 * b1 - a1 * b0
    if abs(det) < 1e-9:
        return None
    return ((c0 * b1 - c1 * b0) / det, (a0 * c1 - a1 * c0) / det)


def homography(src, dst):
    """
    Projective transform fitted by direct linear transformation.

    Eight parameters, so four point pairs are the minimum and more are solved
    in least squares. A projective map takes straight lines to straight lines,
    which is what a conic sheet's meridians and parallels are over one province.
    """
    import numpy as np

    rows = []
    rhs = []
    for (u, v), (x, y) in zip(src, dst):
        rows.append([u, v, 1, 0, 0, 0, -u * x, -v * x])
        rhs.append(x)
        rows.append([0, 0, 0, u, v, 1, -u * y, -v * y])
        rhs.append(y)
    h, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
    return list(h)


def apply_h(h, u, v):
    d = h[6] * u + h[7] * v + 1.0
    if abs(d) < 1e-12:
        return None
    return ((h[0] * u + h[1] * v + h[2]) / d, (h[3] * u + h[4] * v + h[5]) / d)


def georeference(page):
    """
    Read the sheet's own graticule and fit a projective transform to it.

    Ticks are classified by VALUE, not by where they sit on the page: a Nepali
    latitude is 26-31 and a longitude 80-89, so the two can never be confused,
    and a label in the collar that happens to look like a tick is discarded
    because it falls outside both ranges. Each value must appear on BOTH of its
    edges, because it takes two labels to define a graticule line.
    """
    mid_y = page.rect.height / 2
    mid_x = page.rect.width / 2
    lon_pts, lat_pts = {}, {}
    for x0, y0, x1, y1, text, *_ in page.get_text('words'):
        hit = TICK.match(text.strip())
        if not hit:
            continue
        deg = int(hit.group(1)) + int(hit.group(2)) / 60.0
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if LAT_RANGE[0] <= deg <= LAT_RANGE[1]:
            lat_pts.setdefault(deg, {})['left' if cx < mid_x else 'right'] = (cx, cy)
        elif LON_RANGE[0] <= deg <= LON_RANGE[1]:
            lon_pts.setdefault(deg, {})['top' if cy < mid_y else 'bottom'] = (cx, cy)

    meridians = {
        deg: line_through(e['top'], e['bottom'])
        for deg, e in lon_pts.items()
        if 'top' in e and 'bottom' in e
    }
    parallels = {
        deg: line_through(e['left'], e['right'])
        for deg, e in lat_pts.items()
        if 'left' in e and 'right' in e
    }
    if len(meridians) < 2 or len(parallels) < 2:
        return None, f'{len(meridians)} meridians and {len(parallels)} parallels fully labelled'

    src, dst = [], []
    for lon, ml in meridians.items():
        for lat, pl in parallels.items():
            hit = intersect(ml, pl)
            if hit is None:
                continue
            src.append((lon, lat))
            dst.append(hit)
    if len(src) < 4:
        return None, f'only {len(src)} graticule intersections'

    fwd = homography(src, dst)
    inv = homography(dst, src)
    worst = 0.0
    for (lon, lat), (x, y) in zip(src, dst):
        got = apply_h(fwd, lon, lat)
        if got is None:
            return None, 'degenerate projective fit'
        worst = max(worst, math.hypot(got[0] - x, got[1] - y))
    if worst > MAX_RESIDUAL_PT:
        return None, f'graticule fit residual {worst:.1f} pt exceeds {MAX_RESIDUAL_PT}'

    xs = [d[0] for d in dst]
    ys = [d[1] for d in dst]
    return {
        'fwd': fwd,
        'inv': inv,
        'residual': worst,
        'neat': (min(xs), min(ys), max(xs), max(ys)),
        'lon': (min(meridians), max(meridians)),
        'lat': (min(parallels), max(parallels)),
        'intersections': len(src),
    }, None


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    tiles = []
    rejected = []
    accuracy = {}

    for name, url in SHEETS.items():
        print(f'{name}:')
        try:
            path = fetch(name, url)
        except Exception as exc:
            rejected.append((name, f'download failed: {exc}'))
            print(f'  SKIPPED — {exc}')
            continue

        doc = fitz.open(path)
        page = doc[0]
        geo, why = georeference(page)
        if not geo:
            rejected.append((name, why))
            print(f'  REJECTED — {why}')
            continue
        # Residual in metres is what a reader can judge; a point is meaningless
        # without the sheet scale. Ground metres per page point come straight
        # from the fitted graticule.
        span_deg = geo['lon'][1] - geo['lon'][0]
        span_pt = abs(geo['neat'][2] - geo['neat'][0])
        mid_lat = (geo['lat'][0] + geo['lat'][1]) / 2
        m_per_pt = (span_deg * 111320 * math.cos(math.radians(mid_lat))) / max(1.0, span_pt)
        accuracy[name] = {
            'residualPt': round(geo['residual'], 2),
            'residualM': round(geo['residual'] * m_per_pt),
            'intersections': geo['intersections'],
            'lon': [geo['lon'][0], geo['lon'][1]],
            'lat': [geo['lat'][0], geo['lat'][1]],
        }
        print(
            f"  graticule fits to {geo['residual']:.2f} pt (~{geo['residual'] * m_per_pt:.0f} m); "
            f"covers {geo['lon'][0]:.2f}-{geo['lon'][1]:.2f}E, {geo['lat'][0]:.2f}-{geo['lat'][1]:.2f}N"
        )

        # The neat-line, from the outermost graticule intersections. Outside it
        # is collar, legend and title — none of which belongs on the map.
        nx0, ny0, nx1, ny1 = geo['neat']
        made = 0
        row = 0
        y = ny0
        while y < ny1 - 1:
            col = 0
            x = nx0
            while x < nx1 - 1:
                x1 = min(x + TILE_PT, nx1)
                y1 = min(y + TILE_PT, ny1)
                if x1 - x < 12 or y1 - y < 12:
                    x = x1
                    col += 1
                    continue
                corners = [
                    apply_h(geo['inv'], x, y),      # top-left
                    apply_h(geo['inv'], x1, y),     # top-right
                    apply_h(geo['inv'], x1, y1),    # bottom-right
                    apply_h(geo['inv'], x, y1),     # bottom-left
                ]
                if any(c is None for c in corners):
                    x = x1
                    col += 1
                    continue
                pix = page.get_pixmap(clip=fitz.Rect(x, y, x1, y1), dpi=TILE_DPI)
                fname = f'{name}-{row:02d}-{col:02d}.png'
                pix.save(f'{OUT_DIR}/{fname}')
                lons = [c[0] for c in corners]
                lats = [c[1] for c in corners]
                tiles.append({
                    'f': fname,
                    'p': name,
                    # Corners as [lon, lat]: TL, TR, BR, BL — what an image
                    # source wants. The quad is slightly sheared by the conic.
                    'c': [[round(c[0], 6), round(c[1], 6)] for c in corners],
                    # [south, west, north, east], for cheap visibility tests.
                    'b': [round(min(lats), 5), round(min(lons), 5), round(max(lats), 5), round(max(lons), 5)],
                })
                made += 1
                x = x1
                col += 1
            y = min(y + TILE_PT, ny1)
            row += 1
        print(f'  wrote {made} tiles from {geo["intersections"]} graticule intersections')
        doc.close()

    if not tiles:
        print('\nNo tiles produced — nothing written.', file=sys.stderr)
        for name, why in rejected:
            print(f'  {name}: {why}', file=sys.stderr)
        return 1

    index = {
        '_what': "Nepal DMG province geological maps, cut into 0.25-degree tiles.",
        '_source': 'Department of Mines and Geology, Government of Nepal — province geological maps',
        '_sourceUrl': 'https://dmgnepal.gov.np/en/resources/province-and-regional-geological-maps-6665',
        '_scale': '1:350,000',
        '_method': (
            "Each sheet was georeferenced from its own printed graticule by least squares; "
            "sheets whose fit exceeded %.0f pt were rejected rather than placed by guesswork."
            % MAX_RESIDUAL_PT
        ),
        '_limitation': (
            'An image overlay, not an attributed layer. Unit codes require the sheet legend to '
            'decode, and the map cannot establish rock mass, weathering, discontinuities, '
            'permeability or tunnel conditions.'
        ),
        '_rights': 'Free download from the publishing department; printed sheets are sold separately. Do not redistribute.',
        '_tilePt': TILE_PT,
        '_accuracy': accuracy,
        '_rejected': {name: why for name, why in rejected},
        'tiles': tiles,
    }
    with open(f'{OUT_DIR}/index.json', 'w', encoding='utf-8') as f:
        json.dump(index, f, indent=1)

    total = sum(os.path.getsize(f'{OUT_DIR}/{t["f"]}') for t in tiles)
    print(f'\nwrote {len(tiles)} tiles ({total / 1e6:.0f} MB) and {OUT_DIR}/index.json')
    for name, why in rejected:
        print(f'  rejected {name}: {why}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
