"""
Build a 30 m flow-direction and upstream-area grid for Nepal from GEDTM30.

    python pipeline/build-fine-network.py --self-check
    python pipeline/build-fine-network.py --burn 0
    python pipeline/build-fine-network.py --burn 10

WHAT THIS IS. Stage 1 of replacing the app's river network. HydroRIVERS (~500 m
derivation) leaves 29.8% of satellite-visible streams with no modelled river
within 800 m, and MERIT Hydro's 92 m accumulation bleeds across confluences on
about 9% of small-stream points. This derives both a network and a catchment
area per cell from the 1 arc-second bare-earth DEM already on disk. Nothing in
the app reads the result; checks/fine-network-vs-dhm.py measures it.

METHOD. Priority-flood from every raster-edge cell and every cell bordering
no-data (the outlets), on the integer quarter-metre elevations, with a
monotonically increasing insertion counter as the tie-break so flats drain
toward their outlet. Each cell's D8 direction is the neighbour it was first
reached from. The pop order is recorded (uint32, memmapped): it is a valid
topological order, because pops come out in non-decreasing filled elevation and
every pointer goes to a cell popped earlier. Then every cell the flood did NOT
raise and which has a strictly lower neighbour gets true steepest descent (drop
over 1 or sqrt(2) cell distance, east-west scaled by cos(latitude)). Upstream
area is accumulated in reverse pop order into float32, in km2 from latitude.

TRUNCATION. The raster stops at 26.2-30.6 N, 79.9-88.4 E. A river entering from
outside (Mahakali on the west edge, the upper Karnali in the far north-west) has
a catchment that extends past the grid, so the area computed here is a lower
bound. Every cell one inside the raster edge is marked, and the mark is
propagated downstream. flag.bin = 1 means "this area is a floor, never score it
as an estimate". It over-flags on purpose: a cell one inside the edge that
drains outward flags only itself and its outlet.

TWO ARMS, --burn <metres>.
  --burn 0   terrain only. The honest test of whether the DEM alone finds the
             visible streams.
  --burn 10  every DEM cell crossed by an OSM line (public/nepal-osm-rivers.json,
             stepped at half-cell spacing) is lowered by that many metres before
             the flood. Its streams are forced onto those same lines, so it is
             CIRCULAR as a position test; it exists to see what the lines cost or
             buy in catchment area.

OUTPUT  pipeline/.cache/fine/burn<N>/   (gitignored)
  d8.bin    uint8, 0-7 = E SE S SW W NW N NE, 8 = outlet (edge / no-data border),
            255 = no-data cell
  upa.bin   float32 km2 upstream area, the cell itself included
  flag.bin  uint8, 1 = truncated by the raster edge (area is a lower bound)
  order.bin uint32 pop order (kept: it is the accumulation order)
  raise.bin uint16 quarter-metres the flood raised each cell, clipped (only with --save-raise)
  meta.json geometry, arm, timings, counts, flood statistics, peak memory
Rows and columns match sources/gedtm/nepal-gedtm.bin exactly.

WHAT IT CANNOT SAY.
  - A pixel is 30 m. A gorge narrower than that is one cell, and a DEM cannot
    place a channel inside its own error: the position is the DEM's, not the
    water's. That is what the position test in the check measures.
  - Flats (the Terai, lake surfaces, the Indian plain at the south edge) are
    drained by insertion order, which gives parallel straight flow, not a real
    channel. Areas there are plausible, positions are not.
  - float32 accumulation: relative error is ~1e-7 per addition, so a very long
    trunk stream can drift by a few 0.01%. The total-area check at the outlets
    bounds the whole grid, not each cell.
  - Quarter-metre integers mean cells within 0.25 m of each other are a flat.
  - Cells are spherical-earth areas (R = 6371.0088 km), not ellipsoidal.
"""

import argparse
import ctypes
import gc
import json
import os
import sys
import time
from ctypes import wintypes

import numba as nb
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEDTM = os.path.join(ROOT, 'sources', 'gedtm')
OSM = os.path.join(ROOT, 'public', 'nepal-osm-rivers.json')
OUT = os.path.join(ROOT, 'pipeline', '.cache', 'fine')

EARTH_KM = 6371.0088
NODATA = 65535
UNVISITED = 255
NODATA_D8 = 254
OUTLET = 8
RAISED = 16

# E SE S SW W NW N NE. The opposite of d is (d + 4) & 7.
DR = np.array([0, 1, 1, 1, 0, -1, -1, -1], dtype=np.int64)
DC = np.array([1, 1, 0, -1, -1, -1, 0, 1], dtype=np.int64)


# ----------------------------------------------------------------- the heap

@nb.njit(cache=True, inline='always')
def _push(hk, hv, n, key, val):
    i = n
    while i > 0:
        p = (i - 1) >> 1
        if hk[p] <= key:
            break
        hk[i] = hk[p]
        hv[i] = hv[p]
        i = p
    hk[i] = key
    hv[i] = val


@nb.njit(cache=True, inline='always')
def _pop_sift(hk, hv, n):
    """Remove the root. n is the size AFTER removal; the old last element is at n."""
    key = hk[n]
    val = hv[n]
    i = 0
    while True:
        l = 2 * i + 1
        if l >= n:
            break
        m = l
        if l + 1 < n and hk[l + 1] < hk[l]:
            m = l + 1
        if hk[m] >= key:
            break
        hk[i] = hk[m]
        hv[i] = hv[m]
        i = m
    hk[i] = key
    hv[i] = val


@nb.njit(cache=True)
def _grow(hk, hv):
    nk = np.empty(hk.shape[0] * 2, dtype=np.uint64)
    nv = np.empty(hv.shape[0] * 2, dtype=np.uint32)
    nk[: hk.shape[0]] = hk
    nv[: hv.shape[0]] = hv
    return nk, nv


# ---------------------------------------------------------------- the flood

@nb.njit(cache=True)
def flood(dem, rows, cols, d8, order, rz, save, DR, DC):
    """
    Priority-flood. dem (flat uint16) is overwritten with the FILLED elevation.
    d8 must be filled with UNVISITED on entry. With save, rz (uint16, one per cell)
    receives each cell's raise in quarter-metres, clipped at 65535. Returns
    (popped, outlets, nodata_cells, raised_n, raised_sum_q, raised_max_q, heap_peak).
    """
    cap = 1 << 24
    hk = np.empty(cap, dtype=np.uint64)
    hv = np.empty(cap, dtype=np.uint32)
    n = 0
    counter = np.uint64(0)
    outlets = 0
    nodata_cells = 0
    for r in range(rows):
        for c in range(cols):
            i = r * cols + c
            if dem[i] == 65535:
                d8[i] = 254
                nodata_cells += 1
                continue
            seed = r == 0 or c == 0 or r == rows - 1 or c == cols - 1
            if not seed:
                for d in range(8):
                    if dem[(r + DR[d]) * cols + (c + DC[d])] == 65535:
                        seed = True
                        break
            if seed:
                if n + 2 >= cap:
                    hk, hv = _grow(hk, hv)
                    cap = hk.shape[0]
                d8[i] = 8
                _push(hk, hv, n, (np.uint64(dem[i]) << np.uint64(32)) | counter, np.uint32(i))
                n += 1
                counter += np.uint64(1)
                outlets += 1
    k = 0
    raised_n = 0
    raised_sum = 0
    raised_max = 0
    peak = n
    mask = np.uint64(0xFFFFFFFF)
    while n > 0:
        top = hk[0]
        i = np.int64(hv[0])
        n -= 1
        _pop_sift(hk, hv, n)
        e = np.int64(top >> np.uint64(32))
        order[k] = np.uint32(i)
        k += 1
        r = i // cols
        c = i - r * cols
        if n + 9 >= cap:
            hk, hv = _grow(hk, hv)
            cap = hk.shape[0]
        for d in range(8):
            rr = r + DR[d]
            cc = c + DC[d]
            if rr < 0 or rr >= rows or cc < 0 or cc >= cols:
                continue
            j = rr * cols + cc
            if d8[j] != 255:
                continue
            ej = np.int64(dem[j])
            back = (d + 4) & 7
            if ej < e:
                diff = e - ej
                raised_n += 1
                raised_sum += diff
                if diff > raised_max:
                    raised_max = diff
                if save:
                    rz[j] = np.uint16(min(diff, 65535))
                dem[j] = np.uint16(e)
                d8[j] = back | 16
                ej = e
            else:
                d8[j] = back
            _push(hk, hv, n, (np.uint64(ej) << np.uint64(32)) | counter, np.uint32(j))
            n += 1
            counter += np.uint64(1)
        if n > peak:
            peak = n
    return k, outlets, nodata_cells, raised_n, raised_sum, raised_max, peak


@nb.njit(cache=True)
def steepest(dem, d8, rows, cols, dy, dxrow, DR, DC):
    """
    Replace the flood direction with true steepest descent on every cell the
    flood did not raise and that has a strictly lower (filled) neighbour. Strips
    the RAISED bit and converts the internal no-data code to 255.
    Returns (changed, eligible).
    """
    changed = 0
    eligible = 0
    for r in range(rows):
        dx = dxrow[r]
        diag = np.sqrt(dx * dx + dy * dy)
        for c in range(cols):
            i = r * cols + c
            v = d8[i]
            if v == 254 or v == 255:
                d8[i] = 255
                continue
            if v & 16:
                d8[i] = v & 15
                continue
            if v == 8:
                continue
            e = dem[i]
            best = -1
            bs = 0.0
            for d in range(8):
                rr = r + DR[d]
                cc = c + DC[d]
                if rr < 0 or rr >= rows or cc < 0 or cc >= cols:
                    continue
                ej = dem[rr * cols + cc]
                if ej < e:
                    if d == 0 or d == 4:
                        dist = dx
                    elif d == 2 or d == 6:
                        dist = dy
                    else:
                        dist = diag
                    s = (np.float64(e) - np.float64(ej)) / dist
                    if s > bs:
                        bs = s
                        best = d
            if best >= 0:
                eligible += 1
                if best != v:
                    d8[i] = best
                    changed += 1
    return changed, eligible


@nb.njit(cache=True)
def accumulate(order, popped, d8, upa, flag, rows, cols, arearow, DR, DC):
    """Initialise cell areas and the truncation ring, then sum downstream in reverse pop order."""
    for r in range(rows):
        ring = r == 1 or r == rows - 2
        for c in range(cols):
            i = r * cols + c
            if d8[i] == 255:
                upa[i] = 0.0
                flag[i] = 0
            else:
                upa[i] = arearow[r]
                flag[i] = 1 if (ring or c == 1 or c == cols - 2) else 0
    off = np.empty(8, dtype=np.int64)
    for d in range(8):
        off[d] = DR[d] * cols + DC[d]
    for k in range(popped - 1, -1, -1):
        i = np.int64(order[k])
        v = d8[i]
        if v < 8:
            j = i + off[v]
            upa[j] += upa[i]
            if flag[i]:
                flag[j] = 1


@nb.njit(cache=True)
def totals(d8, upa, flag, rows, cols, arearow):
    """float64: total land area, area arriving at outlets, flagged cell count."""
    land = 0.0
    out = 0.0
    nflag = 0
    for r in range(rows):
        for c in range(cols):
            i = r * cols + c
            if d8[i] == 255:
                continue
            land += arearow[r]
            if d8[i] == 8:
                out += np.float64(upa[i])
            if flag[i]:
                nflag += 1
    return land, out, nflag


# ------------------------------------------------------------------ helpers

def geometry(rows, north, pix):
    """Per-row cell height (km, scalar), width (km) and area (km2); row-centre latitude."""
    lat = north - (np.arange(rows) + 0.5) * pix
    dy = pix * np.pi / 180.0 * EARTH_KM
    dx = dy * np.cos(np.radians(lat))
    return dy, dx, dx * dy


def peak_memory_mb():
    """Peak working set and peak pagefile, MB. Windows only; (nan, nan) elsewhere."""
    try:
        class PMC(ctypes.Structure):
            _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                        ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]
        pmc = PMC()
        pmc.cb = ctypes.sizeof(pmc)
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
        psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
        return pmc.PeakWorkingSetSize / 2**20, pmc.PeakPagefileUsage / 2**20
    except Exception:
        return float('nan'), float('nan')


def osm_cells(rows, cols, west, north, pix):
    """Flat indices of every cell crossed by an OSM line, stepped at half-cell spacing so none is skipped."""
    with open(OSM, 'r', encoding='utf8') as f:
        lines = json.load(f)['lines']
    lens = np.array([len(l['p']) // 2 for l in lines], dtype=np.int64)
    flat = np.concatenate([np.asarray(l['p'], dtype=np.float64) for l in lines])
    lat = flat[0::2]
    lon = flat[1::2]
    first = np.zeros(lat.shape[0], dtype=bool)
    first[np.concatenate([[0], np.cumsum(lens)[:-1]])] = True
    y = (north - lat) / pix  # fractional row; cell = floor
    x = (lon - west) / pix
    seg = np.nonzero(~first[1:])[0]  # segment k joins vertex k and k + 1
    found = []
    for s in range(0, seg.shape[0], 200000):
        a = seg[s:s + 200000]
        y0, y1, x0, x1 = y[a], y[a + 1], x[a], x[a + 1]
        steps = np.maximum(1, np.ceil(np.hypot(y1 - y0, x1 - x0) / 0.5)).astype(np.int64)
        rep = np.repeat(np.arange(a.shape[0]), steps + 1)
        start = np.cumsum(steps + 1) - (steps + 1)
        t = (np.arange(rep.shape[0]) - start[rep]) / steps[rep]
        yy = np.floor(y0[rep] + t * (y1[rep] - y0[rep])).astype(np.int64)
        xx = np.floor(x0[rep] + t * (x1[rep] - x0[rep])).astype(np.int64)
        ok = (yy >= 0) & (yy < rows) & (xx >= 0) & (xx < cols)
        found.append(np.unique(yy[ok] * cols + xx[ok]))
    return np.unique(np.concatenate(found))


def burn_cells(dem, rows, cols, west, north, pix, metres):
    """
    Lower every cell crossed by an OSM line by `metres` (quarter-metre units in
    dem, flat uint16, edited in place). Returns the number of cells lowered.
    """
    cells = osm_cells(rows, cols, west, north, pix)
    cells = cells[dem[cells] != NODATA]
    q = int(round(metres * 4))
    dem[cells] = np.maximum(dem[cells].astype(np.int32) - q, 0).astype(np.uint16)
    return int(cells.shape[0])


# --------------------------------------------------------------- the pipeline

def run(dem, rows, cols, north, pix, d8, order, upa, flag, t, rz=None):
    """Flood, steepest descent, accumulate. d8/order/upa/flag are preallocated arrays. Returns stats."""
    dy, dx, area = geometry(rows, north, pix)
    d8[:] = UNVISITED
    t0 = time.time()
    popped, outlets, nodata_cells, rn, rs, rm, peak = flood(dem, rows, cols, d8, order, rz if rz is not None else np.zeros(1, dtype=np.uint16), rz is not None, DR, DC)
    t['flood_s'] = time.time() - t0
    land_cells = rows * cols - nodata_cells
    if popped != land_cells:
        raise RuntimeError(f'flood reached {popped} of {land_cells} land cells')
    t0 = time.time()
    changed, eligible = steepest(dem, d8, rows, cols, dy, dx, DR, DC)
    t['steepest_s'] = time.time() - t0
    return dict(popped=int(popped), outlets=int(outlets), nodata_cells=int(nodata_cells),
                raised_cells=int(rn), raised_mean_m=(rs / rn / 4.0 if rn else 0.0), raised_max_m=rm / 4.0,
                heap_peak=int(peak), steepest_eligible=int(eligible), steepest_changed=int(changed)), (dy, dx, area)


def accumulate_all(order, popped, d8, upa, flag, rows, cols, area, t):
    t0 = time.time()
    accumulate(order, popped, d8, upa, flag, rows, cols, area, DR, DC)
    t['accumulate_s'] = time.time() - t0
    land, out, nflag = totals(d8, upa, flag, rows, cols, area)
    return dict(land_area_km2=land, outlet_area_km2=out, area_rel_error=abs(out - land) / land, flagged_cells=int(nflag))


# ---------------------------------------------------------------- self-check

def self_check():
    """
    400 x 400 tilted plane (south-east is downhill, steeper south than east, SE
    steepest by construction) with one closed 7 x 7 pit and one perfectly flat
    30 x 30 terrace. Every property below is known by construction.
    """
    R = C = 400
    north, pix = 28.0, 1.0 / 3600.0
    rr, cc = np.mgrid[0:R, 0:C]
    dem = (30000 + 6 * (R - 1 - rr) + 4 * (C - 1 - cc)).astype(np.uint16)
    plane = dem.copy()
    dem[147:154, 147:154] -= 300                       # the pit
    terrace = int(plane[250, 60])
    dem[250:280, 60:90] = terrace                      # the terrace, at its highest corner
    N = R * C
    ok = True

    def check(cond, msg):
        nonlocal ok
        print(('ok    ' if cond else 'FAIL  ') + msg)
        ok = ok and bool(cond)

    d8 = np.empty(N, dtype=np.uint8)
    order = np.empty(N, dtype=np.uint32)
    upa = np.empty(N, dtype=np.float32)
    flag = np.empty(N, dtype=np.uint8)
    t = {}
    flat = dem.reshape(-1).copy()
    st, (dy, dx, area) = run(flat, R, C, north, pix, d8, order, upa, flag, t)
    st.update(accumulate_all(order, st['popped'], d8, upa, flag, R, C, area, t))

    check(st['popped'] == N, f'every cell is popped ({st["popped"]} of {N})')
    check(st['outlets'] == 4 * C - 4, f'outlets are exactly the raster edge ({st["outlets"]})')
    pos = np.empty(N, dtype=np.int64)
    pos[order] = np.arange(N)
    down = np.arange(N, dtype=np.int64)
    m = d8 < 8
    down[m] = np.arange(N)[m] + (DR[d8[m]] * C + DC[d8[m]])
    check(np.all(d8[m] < 8) and np.all(pos[down[m]] < pos[np.arange(N)[m]]),
          'every pointer goes to a cell popped earlier: no cycles, every cell reaches an edge')
    check(np.all(d8[~m] == 8), 'cells without a downstream cell are outlets only')
    land = float(np.sum(np.repeat(area, C)))
    out = float(np.sum(upa[d8 == 8].astype(np.float64)))
    check(abs(out - land) / land < 1e-4, f'area at the outlets equals the grid area (rel err {abs(out - land) / land:.2e})')
    pit_rows = np.arange(147, 154)
    pit = (pit_rows[:, None] * C + np.arange(147, 154)[None, :]).ravel()
    check(st['raised_cells'] == 49, f'the pit is the only thing the flood raised ({st["raised_cells"]} cells)')
    check(np.all(pos[down[pit]] < pos[pit]), 'the pit drains')
    check(upa[pit].min() >= area[147] * 0.99, 'the pit cells carry at least their own area')
    terr = (np.arange(250, 280)[:, None] * C + np.arange(60, 90)[None, :]).ravel()
    check(st['raised_cells'] == 49 and flat[terr].min() == terrace, 'the flat terrace was not raised')
    keep = np.ones((R, C), dtype=bool)
    keep[0, :] = keep[-1, :] = keep[:, 0] = keep[:, -1] = False
    keep[142:159, 142:159] = False
    keep[245:285, 55:95] = False
    se = (d8.reshape(R, C) == 1)
    check(np.all(se[keep]), f'D8 on the plane is steepest descent (SE) on all {int(keep.sum())} plane cells')
    check(st['area_rel_error'] < 1e-4 and st['flagged_cells'] > 0, 'truncation ring is marked and propagated')
    # the ring is one inside the edge; edge cells themselves carry no flag unless downstream of it
    fl = flag.reshape(R, C)
    check(fl[1, 1:-1].all() and fl[-2, 1:-1].all() and fl[1:-1, 1].all() and fl[1:-1, -2].all(),
          'every cell one inside the edge is flagged')
    print('self-check: ' + ('PASS' if ok else 'FAIL'))
    return ok


# ---------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--burn', type=float, help='metres to lower DEM cells crossed by OSM lines (0 = terrain only)')
    ap.add_argument('--self-check', action='store_true')
    ap.add_argument('--save-raise', action='store_true', help='also write raise.bin: the flood raise per cell, uint16 quarter-metres, clipped')
    a = ap.parse_args()
    if a.self_check:
        sys.exit(0 if self_check() else 1)
    if a.burn is None:
        ap.error('give --burn <metres> or --self-check')

    meta_in = json.load(open(os.path.join(GEDTM, 'nepal-gedtm.json')))
    rows, cols = meta_in['rows'], meta_in['cols']
    west, north, pix = meta_in['west'], meta_in['north'], meta_in['pixelDeg']
    N = rows * cols
    arm = f'burn{a.burn:g}'
    out = os.path.join(OUT, arm)
    os.makedirs(out, exist_ok=True)
    t = {}
    T0 = time.time()

    t0 = time.time()
    dem = np.fromfile(os.path.join(GEDTM, 'nepal-gedtm.bin'), dtype='<u2')
    if dem.shape[0] != N:
        sys.exit(f'nepal-gedtm.bin holds {dem.shape[0]} cells, expected {N}')
    t['read_s'] = time.time() - t0
    burned = 0
    if a.burn > 0:
        t0 = time.time()
        burned = burn_cells(dem, rows, cols, west, north, pix, a.burn)
        t['burn_s'] = time.time() - t0
        print(f'burned {burned:,} cells by {a.burn:g} m ({time.time() - t0:.0f} s)', flush=True)

    mm = lambda name, dt: np.memmap(os.path.join(out, name), dtype=dt, mode='w+', shape=(N,))
    d8m, orderm = mm('d8.bin', np.uint8), mm('order.bin', np.uint32)
    d8, order = np.asarray(d8m), np.asarray(orderm)
    print(f'{arm}: flooding {rows} x {cols} = {N:,} cells', flush=True)
    rzm = mm('raise.bin', np.uint16) if a.save_raise else None
    st, (dy, dx, area) = run(dem, rows, cols, north, pix, d8, order, None, None, t, None if rzm is None else np.asarray(rzm))
    print(f'  flood {t["flood_s"]:.0f} s, steepest descent {t["steepest_s"]:.0f} s, '
          f'peak working set {peak_memory_mb()[0]:.0f} MB', flush=True)
    del dem
    if rzm is not None:
        rzm.flush()
        del rzm  # unmap before accumulation: keeps the working set under 5 GB
    gc.collect()
    upam, flagm = mm('upa.bin', np.float32), mm('flag.bin', np.uint8)
    st.update(accumulate_all(order, st['popped'], d8, np.asarray(upam), np.asarray(flagm), rows, cols, area, t))
    for m in (d8m, orderm, upam, flagm):
        m.flush()
    t['total_s'] = time.time() - T0
    ws, pf = peak_memory_mb()
    meta = dict(arm=arm, burnMetres=a.burn, made=time.strftime('%Y-%m-%dT%H:%M:%S'),
                rows=rows, cols=cols, west=west, north=north, pixelDeg=pix, cells=N, burnedCells=burned,
                encoding=dict(d8='0-7 = E SE S SW W NW N NE, 8 = outlet, 255 = no-data', upa='float32 km2', flag='1 = truncated'),
                flaggedFraction=st['flagged_cells'] / N, timings_s=t, peakWorkingSetMB=ws, peakPagefileMB=pf, stats=st)
    json.dump(meta, open(os.path.join(out, 'meta.json'), 'w'), indent=2)
    print(json.dumps(meta, indent=2))


if __name__ == '__main__':
    main()
