"""
Cut Nepal out of GEDTM30 and store it locally.

    python pipeline/build-gedtm-nepal.py

WHAT THIS IS. GEDTM30 is a 30 m global bare-earth DTM built by machine-learning
fusion of roughly thirty billion ICESat-2 and GEDI returns over the Copernicus
and other DSMs. Two things make it worth having here:

  it is a DTM, not a DSM. Every terrain source this app currently uses reads the
  TOP OF THE CANOPY. In a forested Nepali valley that is metres of bias, and it
  is not the same bias at the intake as at the powerhouse, so it does not cancel
  out of a head difference;

  it is CC-BY-4.0. MERIT Hydro is the one non-commercial licence in this stack
  and CLAUDE.md already flags it as a liability. This adds capability without
  adding a second one. FathomDEM scores better and is CC-BY-NC-SA; the note in
  src/api.ts says why that trade went this way.

WHY A LOCAL EXTRACT rather than reading the cloud-optimised GeoTIFF live. The
global COG is 432 GB and its full-resolution tile-offset table alone runs to
tens of megabytes, so a browser would pay that before it read a single
elevation. Nepal is 0.06% of the file. Cutting it once is the whole saving.

WHY IT IS NOT COMMITTED. About a gigabyte of derived raster. The licence permits
redistribution — this is a disk-space and repository-hygiene decision, not a
legal one, which is the opposite of why the MERIT and DHM sources are excluded.

OUTPUT
  sources/gedtm/nepal-gedtm.bin   uint16 row-major, no header, no compression
  sources/gedtm/nepal-gedtm.json  the geometry needed to index it

Raw and uncompressed on purpose. The dev server reads a window out of it with
one positioned read per row (vite.config.ts), so random access has to be free;
compressing would save disk and cost the only thing that matters here.
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
from rasterio.windows import Window

# GEDTM30 v1.2, from metadata/cog_list.csv in the openlandmap repository.
URL = (
    '/vsicurl/https://s3.opengeohub.org/global/dtm/v1.2/'
    'gedtm_rf_m_30m_s_20060101_20151231_go_epsg.4326.3855_v1.2.tif'
)
CITATION = 'GEDTM30 v1.2 (OpenGeoHub / openlandmap), CC-BY-4.0, doi:10.5281/zenodo.15689805'

# Exactly src/api.ts NEPAL_BOX. The app refuses discharge outside it, so
# matching it means "if the app can ask, the store has an answer".
WEST, SOUTH, EAST, NORTH = 79.9, 26.2, 88.4, 30.6

OUT_DIR = 'sources/gedtm'
BIN = f'{OUT_DIR}/nepal-gedtm.bin'
META = f'{OUT_DIR}/nepal-gedtm.json'

# uint16 metres would quantise a pond to whole metres; uint16 quarter-metres
# from a -500 m datum spans -500 to +15,883 m, which covers Everest with room
# to spare. 0.25 m is far inside the product's own ~7 m standard deviation, so
# this throws away nothing real.
SCALE = 4
OFFSET = -500
NODATA_OUT = 65535

# Rows per read. The source is tiled 2048x2048, so this is one tile row at a
# time: about 250 MB decoded, and a whole number of source blocks.
STRIP_ROWS = 2048


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)

    with rasterio.open(URL) as ds:
        gt = ds.transform
        px = gt.a
        if abs(px - 1 / 3600) > 1e-12:
            print(f'unexpected pixel size {px}; expected 1 arc-second', file=sys.stderr)
            return 1

        # The extract is aligned to the source grid rather than to round
        # degrees: resampling a DTM to make the numbers tidy would be inventing
        # elevations, and every consumer here does its own bilinear sampling.
        col0 = int(round((WEST - gt.c) / px))
        col1 = int(round((EAST - gt.c) / px))
        row0 = int(round((gt.f - NORTH) / px))
        row1 = int(round((gt.f - SOUTH) / px))
        cols = col1 - col0
        rows = row1 - row0

        west = gt.c + col0 * px
        north = gt.f - row0 * px
        meta = {
            '_what': 'GEDTM30 elevations over Nepal, uint16 quarter-metres above a -500 m datum.',
            '_source': CITATION,
            '_url': URL.replace('/vsicurl/', ''),
            '_generated': time.strftime('%Y-%m-%d'),
            '_layout': (
                'Row-major uint16 little-endian, no header. Row r column c is at byte '
                '(r * cols + c) * 2. Value 65535 is no-data; otherwise '
                'elevation_m = value / 4 - 500.'
            ),
            'rows': rows,
            'cols': cols,
            'pixelDeg': px,
            'west': west,
            'north': north,
            'east': west + cols * px,
            'south': north - rows * px,
            'scale': SCALE,
            'offset': OFFSET,
            'nodata': NODATA_OUT,
            'nativeM': 30,
        }

        total_bytes = rows * cols * 2
        print(f'Nepal window {cols} x {rows} px  ->  {total_bytes / 1e9:.2f} GB')
        print(f'  {west:.5f}..{meta["east"]:.5f} E, {meta["south"]:.5f}..{north:.5f} N')

        # Resume. A quarter-gigabyte download over a flaky link should not have
        # to start again, and CLAUDE.md's third harness rule is that a failed
        # run must never destroy a good one.
        done_rows = 0
        progress = f'{BIN}.progress'
        if os.path.exists(BIN) and os.path.exists(progress):
            try:
                state = json.load(open(progress))
                if state.get('rows') == rows and state.get('cols') == cols:
                    done_rows = int(state.get('doneRows', 0))
                    print(f'  resuming at row {done_rows}')
            except Exception:
                done_rows = 0

        mode = 'r+b' if done_rows and os.path.exists(BIN) else 'wb'
        started = time.time()
        with open(BIN, mode) as out:
            if mode == 'wb':
                # Preallocate so a partial file still has the right geometry.
                out.truncate(total_bytes)
            out.seek(done_rows * cols * 2)

            for top in range(done_rows, rows, STRIP_ROWS):
                height = min(STRIP_ROWS, rows - top)
                t0 = time.time()
                block = ds.read(1, window=Window(col0, row0 + top, cols, height))

                bad = ~np.isfinite(block) | (block > 1e30)
                if ds.nodata is not None:
                    bad |= block == ds.nodata
                encoded = np.rint((block.astype(np.float64) - OFFSET) * SCALE)
                np.clip(encoded, 0, NODATA_OUT - 1, out=encoded)
                encoded = encoded.astype(np.uint16)
                encoded[bad] = NODATA_OUT

                out.write(encoded.tobytes())
                out.flush()
                json.dump(
                    {'rows': rows, 'cols': cols, 'doneRows': top + height}, open(progress, 'w')
                )

                pct = (top + height) / rows * 100
                filled = 100 * (1 - bad.mean())
                print(
                    f'  rows {top:>6}-{top + height:<6} {pct:5.1f}%  '
                    f'{filled:5.1f}% data  {time.time() - t0:5.1f}s'
                )

    json.dump(meta, open(META, 'w'), indent=2)
    if os.path.exists(f'{BIN}.progress'):
        os.remove(f'{BIN}.progress')
    print(f'\nwrote {BIN} ({total_bytes / 1e9:.2f} GB) in {(time.time() - started) / 60:.1f} min')
    print(f'wrote {META}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
