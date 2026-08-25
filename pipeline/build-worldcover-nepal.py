"""
Cut Nepal out of ESA WorldCover and store it locally.

    python pipeline/build-worldcover-nepal.py

WHAT THIS ANSWERS. HydroRecon could describe a scheme's hydrology, terrain, geology,
hazards, grid and licence neighbours, and could not say what the alignment
actually crosses. In Nepal that is not a cosmetic gap: a headrace through
national forest triggers forest clearance and compensatory plantation under the
Forest Act, cropland triggers acquisition and compensation, and a built-up
crossing raises resettlement. Those are among the slowest consents a run-of-
river project waits on, and a screening tool that cannot flag them sends the
developer to discover it on the ground.

WHY ESA WORLDCOVER. 10 m, global, CC-BY-4.0, and served as cloud-optimised
GeoTIFFs from a public bucket, so the whole build is one script with no account
and no form. The 2021 map (v200) is the newest of the two published epochs.

WHAT IT IS NOT. It is not tenure. Land cover says "tree cover"; it does not say
whether that is national forest, community forest or a private woodlot, and in
Nepal those carry different consents and different compensation. It also is not
Nepal's own map: FRTC and ICIMOD publish a national land cover through the
NLCMS, 30 m and annual to 2022, also CC-BY-4.0, but behind a request form rather
than a bucket. For a permitting conversation the national product is the one
that carries weight, so it belongs here eventually as the second opinion — the
same argument that put GEDTM30 beside Mapterhorn.

WHY 30 m AND NOT THE NATIVE 10 m. At 10 m the Nepal box is 5.0 billion cells;
at 30 m it is 598 million, which is smaller than the bare-earth DEM already
sitting in sources/. Every consumer of this store samples points along a line
whose own position is uncertain by more than a cell, and the app's terrain is 30
m, so matching it costs nothing real. Each output cell takes the MODE of its
3x3 source cells — the dominant cover, which is the honest reduction for a
categorical raster; averaging one would invent classes that do not exist.

OUTPUT
  sources/worldcover/nepal-worldcover.bin   uint8 row-major, no header
  sources/worldcover/nepal-worldcover.json  the geometry needed to index it

Raw and uncompressed for the same reason as the DEM store: the dev server reads
a window with one positioned read per row, so random access has to be free.
"""

import json
import os
import sys
import time

os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
os.environ.setdefault('CPL_VSIL_CURL_ALLOWED_EXTENSIONS', '.tif')
os.environ.setdefault('GDAL_CACHEMAX', '512')
os.environ.setdefault('GDAL_HTTP_MAX_RETRY', '5')
os.environ.setdefault('GDAL_HTTP_RETRY_DELAY', '3')

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window

BUCKET = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map'
CITATION = (
    'ESA WorldCover 10 m 2021 v200, CC-BY-4.0, doi:10.5281/zenodo.7254221 '
    '(Zanaga et al., ESA WorldCover project / VITO)'
)

# Exactly src/api.ts NEPAL_BOX, the same choice the DEM store makes: if the app
# can ask about a point, the store has an answer for it.
WEST, SOUTH, EAST, NORTH = 79.9, 26.2, 88.4, 30.6

OUT_DIR = 'sources/worldcover'
BIN = f'{OUT_DIR}/nepal-worldcover.bin'
META = f'{OUT_DIR}/nepal-worldcover.json'
PROGRESS = f'{BIN}.progress'

SRC_PX = 1 / 12000  # 10 m in degrees, the WorldCover grid
FACTOR = 3
PX = SRC_PX * FACTOR  # 0.00025 deg, about 30 m
TILE_DEG = 3

# Output rows per read. 2000 rows of the widest tile is a 6000-row source strip,
# which decodes in a few seconds and keeps the resume granularity useful.
STRIP_ROWS = 2000

# ESA WorldCover class codes. 0 is no-data; 95 (mangroves) cannot occur in Nepal
# and is carried only so the table matches the published legend.
CLASSES = {
    10: 'Tree cover',
    20: 'Shrubland',
    30: 'Grassland',
    40: 'Cropland',
    50: 'Built-up',
    60: 'Bare / sparse vegetation',
    70: 'Snow and ice',
    80: 'Permanent water bodies',
    90: 'Herbaceous wetland',
    95: 'Mangroves',
    100: 'Moss and lichen',
}


def tile_name(lat: int, lon: int) -> str:
    return f'{"N" if lat >= 0 else "S"}{abs(lat):02d}{"E" if lon >= 0 else "W"}{abs(lon):03d}'


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)

    # The output grid is defined on whole degrees, which the WorldCover grid is
    # also aligned to, so one output cell is exactly nine source cells and no
    # resampling of POSITION happens anywhere — only of class.
    col0 = int(round(WEST / PX))
    col1 = int(round(EAST / PX))
    row0 = int(round((90 - NORTH) / PX))
    row1 = int(round((90 - SOUTH) / PX))
    cols = col1 - col0
    rows = row1 - row0
    west = col0 * PX
    north = 90 - row0 * PX

    print(f'Nepal window {cols} x {rows} px  ->  {rows * cols / 1e6:.0f} MB at 30 m')
    print(f'  {west:.5f}..{west + cols * PX:.5f} E, {north - rows * PX:.5f}..{north:.5f} N')

    tiles = [
        (lat, lon)
        for lat in range(int(np.floor(SOUTH / TILE_DEG)) * TILE_DEG, int(np.ceil(NORTH / TILE_DEG)) * TILE_DEG, TILE_DEG)
        for lon in range(int(np.floor(WEST / TILE_DEG)) * TILE_DEG, int(np.ceil(EAST / TILE_DEG)) * TILE_DEG, TILE_DEG)
    ]

    # Resume. Same reasoning as the DEM store: a long download over a flaky link
    # must not start again, and CLAUDE.md's third harness rule is that a failed
    # run may never destroy a good one.
    done = set()
    if os.path.exists(BIN) and os.path.exists(PROGRESS):
        try:
            state = json.load(open(PROGRESS))
            if state.get('rows') == rows and state.get('cols') == cols:
                done = {tuple(t) for t in state.get('done', [])}
                print(f'  resuming, {len(done)} of {len(tiles)} tiles already written')
        except (OSError, ValueError):
            done = set()

    if not os.path.exists(BIN) or not done:
        # Preallocate. Class 0 is WorldCover's own no-data, so an unwritten byte
        # already means "not covered" without a separate sentinel.
        with open(BIN, 'wb') as f:
            f.truncate(rows * cols)

    out = open(BIN, 'r+b')
    started = time.time()
    try:
        for lat, lon in tiles:
            if (lat, lon) in done:
                continue
            name = tile_name(lat, lon)
            url = f'/vsicurl/{BUCKET}/ESA_WorldCover_10m_2021_v200_{name}_Map.tif'

            # Where this tile lands on the output grid, clipped to Nepal.
            tc0 = max(col0, int(round(lon / PX)))
            tc1 = min(col1, int(round((lon + TILE_DEG) / PX)))
            tr0 = max(row0, int(round((90 - (lat + TILE_DEG)) / PX)))
            tr1 = min(row1, int(round((90 - lat) / PX)))
            if tc1 <= tc0 or tr1 <= tr0:
                done.add((lat, lon))
                continue

            try:
                ds = rasterio.open(url)
            except rasterio.errors.RasterioIOError:
                # Tiles that are entirely ocean are simply not published. Nepal
                # has none, but a missing tile must not be fatal to the rest.
                print(f'  {name}: not published, left as no-data')
                done.add((lat, lon))
                continue

            with ds:
                if abs(ds.transform.a - SRC_PX) > 1e-12:
                    print(f'{name}: unexpected pixel size {ds.transform.a}', file=sys.stderr)
                    return 1
                written = 0
                for r in range(tr0, tr1, STRIP_ROWS):
                    r_end = min(r + STRIP_ROWS, tr1)
                    out_h = r_end - r
                    out_w = tc1 - tc0
                    # Source window, in the tile's own pixels.
                    src = Window(
                        col_off=(tc0 - int(round(lon / PX))) * FACTOR,
                        row_off=(r - int(round((90 - (lat + TILE_DEG)) / PX))) * FACTOR,
                        width=out_w * FACTOR,
                        height=out_h * FACTOR,
                    )
                    block = ds.read(
                        1, window=src, out_shape=(out_h, out_w), resampling=Resampling.mode
                    ).astype(np.uint8)
                    # One seek per output row: the strip is a sub-range of
                    # the full width, so its rows are not contiguous on disk.
                    for k in range(out_h):
                        out.seek((r - row0 + k) * cols + (tc0 - col0))
                        out.write(block[k].tobytes())
                    written += out_h
                    pct = 100 * written / (tr1 - tr0)
                    print(f'  {name}: {pct:5.1f}%  ({time.time() - started:.0f}s)', end='\r')
            print(f'  {name}: done, {tr1 - tr0} x {tc1 - tc0} cells written{" " * 12}')
            done.add((lat, lon))
            with open(PROGRESS, 'w') as f:
                json.dump({'rows': rows, 'cols': cols, 'done': sorted(done)}, f)
    finally:
        out.close()

    with open(META, 'w', encoding='utf-8') as f:
        json.dump(
            {
                '_what': 'ESA WorldCover 2021 land cover over Nepal, uint8 class codes.',
                '_source': CITATION,
                '_url': BUCKET,
                '_generated': time.strftime('%Y-%m-%d'),
                '_layout': (
                    'Row-major uint8, no header. Row r column c is at byte r * cols + c. '
                    'Value 0 is no-data; every other value is an ESA WorldCover class code.'
                ),
                '_reduction': (
                    f'Mode of each {FACTOR}x{FACTOR} block of native 10 m cells. The output '
                    'grid is aligned to whole degrees, as the source is, so no cell was moved.'
                ),
                '_limitation': (
                    'Cover, not tenure. "Tree cover" does not distinguish national forest from '
                    'community forest from a private woodlot, and those carry different consents '
                    'and different compensation in Nepal.'
                ),
                'rows': rows,
                'cols': cols,
                'pixelDeg': PX,
                'west': west,
                'north': north,
                'east': west + cols * PX,
                'south': north - rows * PX,
                'nodata': 0,
                'nativeM': 10,
                'cellM': 30,
                'classes': CLASSES,
            },
            f,
            indent=1,
        )

    if os.path.exists(PROGRESS):
        os.remove(PROGRESS)
    print(f'wrote {BIN} and {META} in {time.time() - started:.0f}s')
    return 0


if __name__ == '__main__':
    sys.exit(main())
