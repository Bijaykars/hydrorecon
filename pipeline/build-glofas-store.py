"""
Turn the downloaded GloFAS year files into one flat store the harness can read.

    python pipeline/build-glofas-store.py

Input:  sources/glofas/glofas-nepal-<year>.nc   (pipeline/fetch-glofas-nepal.py)
Output: pipeline/.cache/glofas-nepal.bin

WHY A FLAT FILE. The harness needs one cell's whole daily record at a time, a
few hundred times a run. The netCDF files are laid out day-major — every day is
a 88x170 raster — so reading one cell's twenty-year series means touching every
one of twenty files and skipping through all of them. Transposing once, here,
turns that into a single seek and a single read.

THE TIMESTAMP IS OFF BY ONE, AND IT MATTERS. The variable is "average river
discharge in the last 24 hours" and GloFAS stamps it at the END of the period:
the 2010 file runs 2010-01-02 to 2011-01-01. So the value labelled 2 January is
the mean flow of 1 January. Loading it as-is shifts the entire record a day
later, which no summary statistic would reveal — the mean, the flow-duration
curve and the monthly means all come out identical. It would only ever surface
as a quiet mismatch against a gauge record, which is exactly the comparison this
data exists to support. The shift is undone here, once.

VALUES ARE LOG-QUANTISED to uint16 over 0.001-100000 m3/s. Seven decades in
65535 steps is about 0.02% per step, far finer than a hydrological model's own
accuracy, and it halves the file. 0 is the sentinel for "no value".
"""

import datetime
import glob
import os
import struct
import sys

import numpy as np
import netCDF4 as nc

OUT = 'pipeline/.cache/glofas-nepal.bin'
MAGIC = 0x474E5031  # 'GNP1'
LO, HI = 0.001, 100000.0

files = sorted(glob.glob('sources/glofas/glofas-nepal-*.nc'))
if not files:
    print('no year files in sources/glofas — run pipeline/fetch-glofas-nepal.py first')
    sys.exit(1)
print(f'{len(files)} year files')

# --- one pass to learn the grid and the calendar -----------------------------
first = nc.Dataset(files[0])
lat = first.variables['latitude'][:].astype('f8')
lon = first.variables['longitude'][:].astype('f8')
n_lat, n_lon = len(lat), len(lon)
lat_top, lon_left = float(lat[0]), float(lon[0])
step = round(float(lon[1] - lon[0]), 6)
first.close()

days = set()
for f in files:
    d = nc.Dataset(f)
    t = d.variables['valid_time']
    for v in nc.num2date(t[:], t.units):
        # Stamped at the end of the averaging period; the value is the previous day's.
        days.add(datetime.date(v.year, v.month, v.day) - datetime.timedelta(days=1))
    d.close()
start, endd = min(days), max(days)
n_days = (endd - start).days + 1
n_cells = n_lat * n_lon
print(f'grid {n_lat} x {n_lon} = {n_cells} cells, {start} .. {endd} = {n_days} days')
print(f'  store will be {n_cells * n_days * 2 / 1e6:.0f} MB')

# --- fill -------------------------------------------------------------------
vals = np.zeros((n_cells, n_days), dtype=np.uint16)
log_lo, log_hi = np.log(LO), np.log(HI)

for f in files:
    d = nc.Dataset(f)
    t = d.variables['valid_time']
    dates = [
        datetime.date(v.year, v.month, v.day) - datetime.timedelta(days=1)
        for v in nc.num2date(t[:], t.units)
    ]
    a = np.asarray(d.variables['avg_dis'][:], dtype='f4')  # (day, lat, lon)
    d.close()
    idx = np.array([(x - start).days for x in dates])
    flat = a.reshape(len(dates), n_cells)
    good = np.isfinite(flat) & (flat > 0)
    q = np.zeros_like(flat, dtype=np.uint16)
    clipped = np.clip(flat, LO, HI)
    q[good] = (1 + (np.log(clipped[good]) - log_lo) / (log_hi - log_lo) * 65534).astype(np.uint16)
    vals[:, idx] = q.T
    print(f'  {os.path.basename(f)}: {len(dates)} days')

filled = int((vals > 0).any(axis=1).sum())
print(f'{filled}/{n_cells} cells carry a record ({100 * filled / n_cells:.0f}%)')

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'wb') as fh:
    fh.write(
        struct.pack(
            '<IIIIiiiff',
            MAGIC,
            n_lat,
            n_lon,
            n_days,
            start.toordinal(),
            int(round(lat_top * 1e6)),
            int(round(lon_left * 1e6)),
            LO,
            HI,
        )
    )
    fh.write(struct.pack('<i', int(round(step * 1e6))))
    fh.write(vals.tobytes())
print(f'wrote {OUT}: {os.path.getsize(OUT) / 1e6:.0f} MB')

# --- prove the round trip ---------------------------------------------------
#
# A quantisation that silently clips, or a transpose that silently mis-indexes,
# both produce a file that loads and reads plausibly. Check one real cell
# against the source rather than trusting the arithmetic.
probe = nc.Dataset(files[len(files) // 2])
t = probe.variables['valid_time']
pdates = [
    datetime.date(v.year, v.month, v.day) - datetime.timedelta(days=1)
    for v in nc.num2date(t[:], t.units)
]
raw = np.asarray(probe.variables['avg_dis'][:], dtype='f4').reshape(len(pdates), n_cells)
probe.close()
cell = int(np.argmax(raw[0]))
di = (pdates[0] - start).days
q = int(vals[cell, di])
back = LO * np.exp((q - 1) / 65534 * (np.log(HI) - np.log(LO)))
err = abs(back - raw[0, cell]) / raw[0, cell]
print(
    f'round trip on cell {cell} ({pdates[0]}): source {raw[0, cell]:.3f}, '
    f'store {back:.3f}, error {err * 100:.4f}%'
)
assert err < 0.001, 'quantisation round trip is worse than 0.1%'
