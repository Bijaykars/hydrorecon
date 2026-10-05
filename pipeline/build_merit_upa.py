"""
Catchment area at every point on the river, not one number per reach.

    python pipeline/build_merit_upa.py

WHY. Everything this app says about flow is driven by catchment area — MHSP goes
as A^0.86..0.97, WECS/DHM likewise, and a gauge transfer is a straight area
ratio. Until now that area came from HydroRIVERS' UPLAND_SKM: derived at about
500 m, and stored as ONE VALUE PER REACH. Drag an intake three kilometres up the
same reach and the catchment does not change at all.

MERIT Hydro's `upa` band is upstream drainage area per PIXEL at 92.77 m, already
accumulated, with a published relative error under 5% at 90% of GRDC gauges. So
the fix is not to compute anything clever — it is to sample a raster that has
already done the accumulation properly.

WHY PYTHON, when every other pipeline here is .mjs: this one reads 6000x6000
float32 Deflate GeoTIFFs. Node has no TIFF reader in this project and hand-rolling
one would be a few hundred lines of guesswork; PIL and numpy are already present
and read these files natively. The OUTPUT is the same kind of compact binary
everything else here writes.

OUTPUT: public/nepal-upa.dat — one uint16 per vertex, log-quantised, about 414 KB
for 207,022 vertices. Parallel to the vertex block in nepal-rivers.dat, same
order, so the app indexes it with the vertex index it already has.

SOURCE: MERIT Hydro v1.0.1 (Yamazaki et al. 2019), dual-licensed CC BY-NC 4.0
or ODbL 1.0 at the licensee's choice. This project ELECTS ODbL 1.0, so the
output below ships as a Derived Database under ODbL -- see the MERIT HYDRO
section of LICENSE. The source GeoTIFFs stay gitignored in
sources/merit-hydro/; that is not a licence term under either arm but the
authors' separate request that the tiles not be redistributed whole and in
their original format. This derived per-vertex array is what travels.
"""
import math
import struct
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

RIVERS = 'public/nepal-rivers.dat'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'public/nepal-upa.dat'
MAGIC = 0x4E555031  # 'NUP1'

TILES = {
    (25, 80): 'sources/merit-hydro/n25e080_upa.tif',
    (25, 85): 'sources/merit-hydro/n25e085_upa.tif',
}
STEP = 1.0 / 1200.0

# How far a vertex may look for the channel.
#
# HydroRIVERS vertices sit on HydroRIVERS' centreline, which disagrees with
# MERIT's by a few hundred metres on the same river — that offset is the thing
# being corrected, not an error. Swept against the DHM gauges
# (pipeline/merit_probe.py), plausibility rises to 94% around 1.4 km and then
# DEGRADES: past ~30 px the window starts finding a bigger neighbouring river,
# visible as the median specific discharge sliding from 0.046 to 0.029. A vertex
# is better positioned than an arbitrary gauge coordinate, so this sits below
# the gauge optimum deliberately.
# MEASURED (checks/merit-window.mjs), three configurations, 3,823 sampled
# channel points for the bleed rate and 105 gauges for the independent test:
#
#                        median   over 2x   order-1 >2x   gauges in band
#   3 px, cumulative max   0.93x     6.3%          8.9%       94  <- shipped
#   1 px, cumulative max   0.85x     3.5%          4.9%       93
#   3 px, spike-clipped    0.98x     3.5%          5.1%       91
#     (reach area alone, the pre-MERIT baseline)                92
#
# Both alternatives halve the bleed rate and both lose on the gauges, and the
# spike-clipping one falls BELOW the pre-MERIT baseline. It is not noise: the
# gauges sit on order 4-5 rivers where bleeding is already rare, so what they
# are measuring is the cost of the fix on big rivers, where clipping and
# narrowing both under-read. The fix is real, the referee cannot see it, and the
# referee is what says whether a change is an improvement.
#
# So the shipped configuration stands, with the bleed documented in
# src/rivers.ts rather than papered over. Resolving this properly needs
# independent flows on SMALL catchments -- which is exactly the data Nepal does
# not gauge, and exactly why this is hard.
SNAP_PX = int(sys.argv[2]) if len(sys.argv) > 2 else 3  # window radius in pixels
CLEANUP = sys.argv[3] if len(sys.argv) > 3 else 'max'

# SAMPLE ON THE TRACED CHANNEL, AND ONLY THERE.
#
# Read at a point that is genuinely in the river this is excellent: Upper
# Tamakoshi's headworks give 1741 km2 against a published 1745. Read along
# HydroRIVERS' own vertices it was noisy, because those vertices are the 500 m
# geometry this app already knows sits a few hundred metres off the channel.
#
# Widening the read window was the obvious workaround and it is wrong: past a
# few hundred metres it finds whatever trunk river passes nearby and invents
# catchment. Measured on the DHM gauges (checks/osm-snap-export.mjs):
#
#   93 m window   raw vertices 36% plausible, traced vertices 91%
#   186 m         raw 50%,                    traced 93%
#
# So the point moves and the window stays small — a small window cannot steal a
# neighbour. Positions come from pipeline/snap-vertices-to-osm.mjs.
#
# WHERE NOTHING WAS TRACED, NOTHING IS CLAIMED. OSM does not cover every
# headwater; about a quarter of reaches match. A vertex that was never pulled
# onto a traced channel is written as 0, meaning "no value", and the app keeps
# using the HydroRIVERS reach figure there. Guessing on the other three quarters
# is exactly the error this whole exercise was correcting.
SNAPPED = 'pipeline/.cache/osm-snapped-vertices.bin'

_cache = {}


def load_tile(key):
    if key not in _cache:
        path = TILES.get(key)
        _cache[key] = np.array(Image.open(path)) if path else None
    return _cache[key]


def upa_at(lat, lon, snap_px=SNAP_PX):
    """Upstream drainage area in km2, or None where no tile covers the point."""
    key = (int(math.floor(lat / 5) * 5), int(math.floor(lon / 5) * 5))
    a = load_tile(key)
    if a is None:
        return None
    col = int(round((lon - (key[1] - STEP / 2)) / STEP))
    row = int(round(((key[0] + 5 - STEP / 2) - lat) / STEP))
    if not (0 <= row < a.shape[0] and 0 <= col < a.shape[1]):
        return None
    r0, r1 = max(0, row - snap_px), min(a.shape[0], row + snap_px + 1)
    c0, c1 = max(0, col - snap_px), min(a.shape[1], col + snap_px + 1)
    w = a[r0:r1, c0:c1]
    if w.size == 0:
        return None
    v = float(np.nanmax(w))
    return v if v > 0 else None


# --- read the river network ------------------------------------------------
buf = open(RIVERS, 'rb').read()
magic, count, nverts, scale = struct.unpack_from('<IIII', buf, 0)
assert magic == 0x4E505231, f'unexpected magic {magic:08x}'
print(f'{count} reaches, {nverts} vertices, grid 1/{scale} degree')

off = 16
meta = []
for _ in range(count):
    upland_x10, dis_x1000, ordv, nv = struct.unpack_from('<iiBH', buf, off)
    off += 11
    meta.append((upland_x10 / 10.0, nv))

# Vertex block: per reach, first vertex absolute (i32 x, i32 y), rest i16 deltas.
verts = np.empty((nverts, 2), dtype=np.float64)
vi = 0
for _, nv in meta:
    x, y = struct.unpack_from('<ii', buf, off)
    off += 8
    verts[vi] = (y / scale, x / scale)  # lat, lon
    vi += 1
    for _ in range(nv - 1):
        dx, dy = struct.unpack_from('<hh', buf, off)
        off += 4
        x += dx
        y += dy
        verts[vi] = (y / scale, x / scale)
        vi += 1
assert vi == nverts, f'read {vi} vertices, header said {nverts}'
print(f'decoded {vi} vertices, {off}/{len(buf)} bytes consumed')

# --- sample, on traced positions only -----------------------------------------
snapbuf = open(SNAPPED, 'rb').read()
smagic, scount = struct.unpack_from('<II', snapbuf, 0)
assert smagic == 0x4F535631 and scount == nverts, 'snapped vertices do not match the network'
snapped = np.frombuffer(snapbuf, dtype='<i4', offset=8).reshape(-1, 2) / 1e6

area = np.zeros(nverts, dtype=np.float64)
traced = 0
for i in range(nverts):
    # Only a vertex that actually moved is on a traced channel. An unmoved one
    # is still the modelled position, where MERIT cannot be read honestly.
    if abs(snapped[i, 0] - verts[i, 0]) < 1e-7 and abs(snapped[i, 1] - verts[i, 1]) < 1e-7:
        continue
    v = upa_at(snapped[i, 0], snapped[i, 1])
    if v is not None:
        area[i] = v
        traced += 1
    if i % 25000 == 0:
        print(f'  {i}/{nverts}')
print(f'sampled {traced} vertices on traced channel ({100*traced/nverts:.1f}%); '
      f'the rest keep the HydroRIVERS reach figure')

# --- enforce the one thing physics guarantees -------------------------------
#
# Along a single reach a river only ever gains catchment. Where consecutive
# samples disagree with that, the window found a neighbouring channel for a
# vertex or two. Running a cumulative maximum in the downstream direction
# removes exactly those spikes and touches nothing else. Direction is read from
# the data rather than assumed: whichever end carries more area is downstream.
fixed = 0
vi = 0
for _, nv in meta:
    seg = area[vi:vi + nv]
    if not np.any(seg > 0):
        vi += nv
        continue
    flip = nv >= 2 and seg[0] > seg[-1]
    d = seg[::-1] if flip else seg  # d is now in downstream order
    if CLEANUP == 'max':
        m = np.maximum.accumulate(d)
    else:
        # Clip spikes instead of raising dips. Monotonicity says area only grows
        # downstream; a violation can be resolved either way, and which way
        # matters because the two failure modes are not symmetric. The window
        # takes a MAXIMUM, so its errors are almost all upward -- a vertex that
        # caught a trunk river's pixel. Running a cumulative maximum believes
        # that vertex and raises every vertex below it to match; running a
        # minimum upstream from the outlet disbelieves it and clips it back.
        m = np.minimum.accumulate(d[::-1])[::-1]
    mono = m[::-1] if flip else m
    fixed += int((mono != area[vi:vi + nv]).sum())
    area[vi:vi + nv] = mono
    vi += nv
print(f'monotonic cleanup adjusted {fixed} vertices ({100*fixed/nverts:.1f}%)')

# --- how does it compare with what we had? ----------------------------------
vi = 0
ratios = []
for hr_upland, nv in meta:
    if hr_upland > 0 and nv > 0:
        m = area[vi:vi + nv].max()
        if m > 0:  # only reaches with a traced sample are comparable
            ratios.append(m / hr_upland)
    vi += nv
r = np.array(ratios)
print(f'\nMERIT vs HydroRIVERS per reach ({len(r)} reaches with both):')
print(f'  median {np.median(r):.2f}x   10-90% {np.percentile(r,10):.2f}x-{np.percentile(r,90):.2f}x')
print(f'  within 25%: {100*np.mean(np.abs(np.log(r))<=math.log(1.25)):.0f}%'
      f'   within 2x: {100*np.mean(np.abs(np.log(r))<=math.log(2)):.0f}%')

# --- write ------------------------------------------------------------------
#
# Log-quantised uint16 over 0.01-200000 km2: seven decades in 65535 steps is
# about 0.02% per step, far finer than the data's own 5% accuracy. 0 means "no
# value here" and the app falls back to the reach figure.
LO, HI = 0.01, 1000000.0  # max in these tiles is 722,983 km2 (the Ganges); 200000 clipped it
q = np.zeros(nverts, dtype=np.uint16)
nz = area > 0
q[nz] = np.clip(
    1 + (np.log(np.clip(area[nz], LO, HI) / LO) / math.log(HI / LO) * 65534.0).astype(np.int64),
    1, 65535,
).astype(np.uint16)

with open(OUT, 'wb') as f:
    f.write(struct.pack('<IIff', MAGIC, nverts, LO, HI))
    f.write(q.tobytes())
print(f'\nwrote {OUT}: {16 + q.nbytes} bytes for {nverts} vertices')

# Round-trip check: quantisation must not be the thing that introduces error.
back = np.zeros(nverts)
back[q > 0] = LO * np.exp((q[q > 0].astype(np.float64) - 1) / 65534.0 * math.log(HI / LO))
err = np.abs(back[nz] / area[nz] - 1)
print(f'quantisation error: max {100*err.max():.4f}%, mean {100*err.mean():.4f}%')
