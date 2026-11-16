"""
Score the 30 m derived network (pipeline/build-fine-network.py) against DHM's
published catchment areas, against the traced OSM streams, and for size.

    python checks/fine-network-vs-dhm.py
    python checks/fine-network-vs-dhm.py --diagnose

Needs pipeline/.cache/fine/burn0/ (and burn10/ if built) and
pipeline/.cache/click-vs-visible-river.json. Runs checks/dhm-engine-areas.mjs
itself if pipeline/.cache/fine/engine-areas.json is missing. Offline; a few
minutes.

V1 CATCHMENT AREA. At each of DHM's 190 stations take the cell of maximum
upstream area within 3 cells (also 1 and 5) of the published coordinate and
score fine-area / published-area. The two baselines are the app's own: MERIT
per-vertex area and HydroRIVERS reach area, through the real nearestReach.
Stations whose chosen cell is truncation-flagged in EITHER arm (its catchment may
extend past the raster, so the area is a floor) get their own row and are
excluded from every other table, so all arms and baselines are scored on the
IDENTICAL stations.

V2 STREAM POSITION. One sample per 1,000 m along each OSM line, exactly as
checks/click-vs-visible-river.mjs does it, and the distance from each to the
nearest fine-network stream cell at three thresholds of upstream area.

V3 SIZE. Stream cells and total stream length per threshold.

WHAT IT CANNOT SAY.
  - Published areas are DHM's, and DHM's own table has typos (stations 349 and 350
    share a longitude). Outliers are listed, not tuned to.
  - The max-area-within-k-cells rule is a snap TO the stream: it hunts for the
    biggest cell nearby, so it flatters the fine grid by exactly the amount the
    station sits off the DEM's channel. The 1-, 3- and 5-cell lines show how much.
    The baselines get the app's own snap, which is a different (and coarser) rule.
  - 190 stations sit on rivers with a median catchment of ~540 km2; plant intakes
    sit near 160 km2. The gauge population is easier than the use population.
  - V2: OSM lines are not every visible channel, a sample sits exactly on the OSM
    centre line (best case), and distances are to the CENTRE of a 30 m cell, so a
    perfectly placed channel still reads up to ~15 m. The burned arm is CIRCULAR
    here (its streams were forced onto these same lines); the unburned arm is the
    honest position test.
  - V3 length counts each stream cell's step to its downstream neighbour; it is
    not a sinuosity-corrected channel length.
"""

import json
import math
import os
import subprocess
import sys

import numba as nb
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FINE = os.path.join(ROOT, 'pipeline', '.cache', 'fine')
THRESH = [0.25, 1.0, 5.0]
EARTH_M = 6371008.8
BANDS = [('under 100', 0, 100), ('100-500', 100, 500), ('500-2000', 500, 2000), ('over 2000', 2000, 1e12)]
COVER = dict(west=79.9, south=26.2, east=88.4, north=30.6)
CURRENT_REACHES, CURRENT_VERTICES = 42197, 207022


# ---------------------------------------------------------------- statistics

def stat(r):
    r = np.asarray(r, dtype=np.float64)
    if r.size == 0:
        return None
    l = np.log(r)
    return dict(n=r.size, median=float(np.median(r)), bias=math.exp(l.mean()), typ=math.exp(np.abs(l).mean()),
                w10=100 * float(np.mean(np.abs(r - 1) <= 0.10)), w25=100 * float(np.mean(np.abs(r - 1) <= 0.25)))


def row(label, s):
    if s is None:
        return f'  {label:<12} {0:>4}'
    return (f'  {label:<12} {s["n"]:>4} {s["median"]:>8.3f} {s["bias"]:>7.3f} {s["typ"]:>8.3f} '
            f'{s["w10"]:>6.0f}% {s["w25"]:>6.0f}%')


def table(title, ratio, pub, mask):
    print(f'{title}')
    print(f'  {"band (km2)":<12} {"n":>4} {"median":>8} {"bias":>7} {"typ.err":>8} {"<=10%":>7} {"<=25%":>7}')
    print(row('ALL', stat(ratio[mask])))
    for name, lo, hi in BANDS:
        print(row(name, stat(ratio[mask & (pub >= lo) & (pub < hi)])))


def pct_text(sorted_d, q):
    v = np.percentile(sorted_d, q, method='higher') if sorted_d.size else np.inf
    return '   >800' if not np.isfinite(v) else f'{v:>7.0f}'


# ----------------------------------------------------------------------- V1

def load_arm(name):
    d = os.path.join(FINE, name)
    meta = json.load(open(os.path.join(d, 'meta.json')))
    n = meta['rows'] * meta['cols']
    shp = (meta['rows'], meta['cols'])
    return dict(name=name, meta=meta,
                upa=np.memmap(os.path.join(d, 'upa.bin'), dtype=np.float32, mode='r', shape=(n,)),
                d8=np.memmap(os.path.join(d, 'd8.bin'), dtype=np.uint8, mode='r', shape=(n,)),
                flag=np.memmap(os.path.join(d, 'flag.bin'), dtype=np.uint8, mode='r', shape=(n,)), shape=shp)


def pick(arm, lat, lon, k):
    """Cell of maximum upstream area within k cells of (lat, lon): (area, flagged) or None if off the grid."""
    m = arm['meta']
    rows, cols = arm['shape']
    r = int(math.floor((m['north'] - lat) / m['pixelDeg']))
    c = int(math.floor((lon - m['west']) / m['pixelDeg']))
    if r - k < 0 or c - k < 0 or r + k >= rows or c + k >= cols:
        return None
    u = arm['upa'].reshape(rows, cols)[r - k:r + k + 1, c - k:c + k + 1]
    i = np.unravel_index(int(np.argmax(u)), u.shape)
    f = arm['flag'].reshape(rows, cols)[r - k + i[0], c - k + i[1]]
    return float(u[i]), bool(f)


def v1(arms, stations, engine):
    print('=' * 78)
    print('V1  CATCHMENT AREA at the DHM published station coordinates')
    print('=' * 78)
    ns = len(stations)
    pub = np.array([s['drainageKm2'] for s in stations], dtype=np.float64)
    fine = {a['name']: {k: [pick(a, s['lat'], s['lon'], k) for s in stations] for k in (1, 3, 5)} for a in arms}
    off = np.array([any(fine[a['name']][3][i] is None for a in arms) for i in range(ns)])
    flagged = np.array([(not off[i]) and any(fine[a['name']][3][i][1] for a in arms) for i in range(ns)])
    est = {a['name']: np.array([np.nan if fine[a['name']][3][i] is None else fine[a['name']][3][i][0] for i in range(ns)]) for a in arms}
    merit = np.array([np.nan if e['meritKm2'] is None else e['meritKm2'] for e in engine], dtype=np.float64)
    reach = np.array([np.nan if e['reachKm2'] is None else e['reachKm2'] for e in engine], dtype=np.float64)
    ok = ~off & ~flagged & np.isfinite(merit) & np.isfinite(reach) & (pub > 0)
    print(f'{ns} stations. Off the raster: {int(off.sum())}. Truncation-flagged (either arm, 3-cell pick): {int(flagged.sum())} '
          f'(own row, excluded below). Scored on the identical set: n = {int(ok.sum())}.')
    print(f'Baselines: MERIT per-vertex nearest.uplandKm2 ({sum(1 for e in engine if e["areaSource"] == "reach")} stations fell back to the '
          f'reach area), HydroRIVERS nearest.reachUplandKm2; stations beyond the app\'s SNAP_KM: '
          f'{sum(1 for e in engine if e["snapM"] is not None and e["snapM"] > 800)}. Overrides off.\n')

    if flagged.any():
        print('Truncation-flagged stations (area is a floor, not scored): id, river, published, then fine-area per arm')
        for i in np.nonzero(flagged)[0]:
            s = stations[i]
            print(f'  {s["id"]:>5} {s["river"][:28]:<28} {pub[i]:>9.1f} ' + '  '.join(f'{a["name"]}={est[a["name"]][i]:.1f}' for a in arms))
        print()

    for a in arms:
        print(f'--- {a["name"]}: 3-cell pick ---')
        table(f'{a["name"]}', est[a['name']] / pub, pub, ok)
        print('  sensitivity of the pick window, ALL unflagged:')
        for k in (1, 3, 5):
            r = np.array([np.nan if fine[a['name']][k][i] is None else fine[a['name']][k][i][0] for i in range(ns)]) / pub
            s = stat(r[ok])
            print(f'    {k}-cell window: n {s["n"]}  median {s["median"]:.3f}  bias {s["bias"]:.3f}  typ.err {s["typ"]:.3f}  within 10% {s["w10"]:.0f}%  within 25% {s["w25"]:.0f}%')
        print()
    print('--- baselines on the SAME stations ---')
    table('MERIT per-vertex (nearest.uplandKm2)', merit / pub, pub, ok)
    print()
    table('HydroRIVERS reach (nearest.reachUplandKm2)', reach / pub, pub, ok)
    print()

    print('--- head-to-head, same stations (closer = smaller |ln(area/published)|; tied = the two areas within 1% of each other) ---')
    for a in arms:
        for bname, b in (('MERIT', merit), ('HydroRIVERS reach', reach)):
            f = est[a['name']][ok]
            bb = b[ok]
            p = pub[ok]
            tie = np.abs(np.log(f / bb)) < 0.01
            fc = (np.abs(np.log(f / p)) < np.abs(np.log(bb / p))) & ~tie
            bc = (np.abs(np.log(f / p)) > np.abs(np.log(bb / p))) & ~tie
            print(f'  {a["name"]} vs {bname}: fine closer {int(fc.sum())}   baseline closer {int(bc.sum())}   tied {int(tie.sum())}   (n {int(ok.sum())})')
    print()

    print('--- stations where ANY source is off by more than 2x (ratio > 2 or < 0.5); all 190 considered, F = truncation-flagged ---')
    hdr = f'  {"id":>5} {"river":<26} {"published":>10} ' + ' '.join(f'{a["name"]:>10}' for a in arms) + f' {"MERIT":>10} {"reach":>10}  note'
    print(hdr)
    nout = 0
    for i, s in enumerate(stations):
        vals = [est[a['name']][i] for a in arms] + [merit[i], reach[i]]
        rs = [v / pub[i] for v in vals if np.isfinite(v)]
        if off[i] or not any(r > 2 or r < 0.5 for r in rs):
            continue
        nout += 1
        note = ('F ' if flagged[i] else '') + ('MERIT=reach-fallback ' if engine[i]['areaSource'] == 'reach' else '')
        print(f'  {s["id"]:>5} {s["river"][:26]:<26} {pub[i]:>10.1f} ' + ' '.join(f'{est[a["name"]][i]:>10.1f}' for a in arms)
              + f' {merit[i]:>10.1f} {reach[i]:>10.1f}  {note}{s["location"][:30]}')
    print(f'  ({nout} stations; DHM table typos known: 349 and 350 share a longitude. Not tuned to.)\n')


# ----------------------------------------------------------------------- V2

def metres_per_deg(lat):
    phi = np.radians(lat)
    return (111132.92 - 559.82 * np.cos(2 * phi) + 1.175 * np.cos(4 * phi),
            111412.84 * np.cos(phi) - 93.5 * np.cos(3 * phi))


def clicks_along(p):
    """One point per 1,000 m along a flat [lat, lon, ...] line, 500 m in; short lines give their midpoint. As the .mjs does."""
    a = np.asarray(p, dtype=np.float64)
    lat, lon = a[0::2], a[1::2]
    if lat.size < 2:
        return []
    mlat, mlon = metres_per_deg((lat[:-1] + lat[1:]) / 2)
    seg = np.hypot((lon[1:] - lon[:-1]) * mlon, (lat[1:] - lat[:-1]) * mlat)
    total = seg.sum()
    if not total > 0:
        return []
    tg = [total / 2] if total < 500 else list(np.arange(500, total + 1e-9, 1000))
    cum = np.cumsum(seg)
    out = []
    for d in tg:
        k = min(int(np.searchsorted(cum, d, side='left')), seg.size - 1)
        before = cum[k] - seg[k]
        t = min(1.0, max(0.0, (d - before) / seg[k])) if seg[k] > 0 else 0.0
        out.append((lat[k] + t * (lat[k + 1] - lat[k]), lon[k] + t * (lon[k + 1] - lon[k])))
    return out


@nb.njit(cache=True)
def nearest_stream(upa, cols, rows, west, north, pix, lat, lon, thr, out):
    dy_m = pix * np.pi / 180.0 * 6371008.8
    nt = thr.shape[0]
    for s in range(lat.shape[0]):
        y = (north - lat[s]) / pix
        x = (lon[s] - west) / pix
        r0 = int(np.floor(y))
        c0 = int(np.floor(x))
        dx_m = dy_m * np.cos(lat[s] * np.pi / 180.0)
        ry = int(np.ceil(800.0 / dy_m)) + 1
        rx = int(np.ceil(800.0 / dx_m)) + 1
        best = np.full(nt, 1e18)
        for r in range(r0 - ry, r0 + ry + 1):
            if r < 0 or r >= rows:
                continue
            dyy = ((r + 0.5) - y) * dy_m
            for c in range(c0 - rx, c0 + rx + 1):
                if c < 0 or c >= cols:
                    continue
                v = upa[r * cols + c]
                if v < thr[0]:
                    continue
                dxx = ((c + 0.5) - x) * dx_m
                d2 = dxx * dxx + dyy * dyy
                for t in range(nt):
                    if v >= thr[t] and d2 < best[t]:
                        best[t] = d2
        for t in range(nt):
            out[s, t] = np.sqrt(best[t]) if best[t] < 1e17 else np.inf


def osm_samples():
    lines = json.load(open(os.path.join(ROOT, 'public', 'nepal-osm-rivers.json'), encoding='utf8'))['lines']
    out = {'river': [], 'stream': []}
    for l in lines:
        for la, lo in clicks_along(l['p']):
            if COVER['south'] <= la <= COVER['north'] and COVER['west'] <= lo <= COVER['east']:
                out['river' if l['r'] == 1 else 'stream'].append((la, lo))
    return {k: np.array(v, dtype=np.float64) for k, v in out.items()}


def v2(arms):
    print('=' * 78)
    print('V2  STREAM POSITION: distance from a sample on a traced OSM line to the nearest stream cell')
    print('=' * 78)
    print('NOTE  the burn10 arm is CIRCULAR here: its streams were forced onto these same OSM lines. The burn0 arm is the honest position test.')
    print('NOTE  distances are to the centre of a 30 m cell (up to ~15 m read for a perfectly placed channel). Searched out to 800 m; beyond that = none.')
    sm = osm_samples()
    print(f'samples: river {len(sm["river"])} (cache says 27,814), stream {len(sm["stream"])} (cache says 83,850)\n')
    cache = json.load(open(os.path.join(FINE, '..', 'click-vs-visible-river.json')))['groups']
    thr = np.array(THRESH, dtype=np.float32)
    res = {}
    for a in arms:
        m = a['meta']
        for cls, pts in sm.items():
            o = np.argsort(-pts[:, 0])  # by row, for cache locality
            out = np.empty((len(pts), len(THRESH)))
            nearest_stream(np.asarray(a['upa']), m['cols'], m['rows'], m['west'], m['north'], m['pixelDeg'],
                           np.ascontiguousarray(pts[o, 0]), np.ascontiguousarray(pts[o, 1]), thr, out)
            d = np.empty_like(out)
            d[o] = out
            res[(a['name'], cls)] = d
    cols_hdr = f'{"":<26} {"median":>7} {"p75":>7} {"p90":>7} | {"med<=800":>8} {"p75":>5} {"p90":>5} | {"none>60":>8} {"120":>6} {"250":>6} {"800":>6}'
    for cls in ('river', 'stream'):
        print(f'--- {cls} class: distance in metres (left: all samples, ">800" = more than half have none; middle: only samples with a cell within 800 m) ---')
        print(cols_hdr)
        for a in arms:
            for ti, t in enumerate(THRESH):
                d = res[(a['name'], cls)][:, ti]
                srt = np.sort(d)
                w = srt[np.isfinite(srt) & (srt <= 800)]
                sh = [100 * float(np.mean(~(d <= x))) for x in (60, 120, 250, 800)]
                lab = f'{a["name"]}  >= {t:g} km2'
                med = lambda q: f'{np.percentile(w, q):>5.0f}' if w.size else '  n/a'
                print(f'{lab:<26} {pct_text(srt, 50)} {pct_text(srt, 75)} {pct_text(srt, 90)} | {med(50):>8} {med(75)} {med(90)} | '
                      f'{sh[0]:>7.1f}% {sh[1]:>5.1f}% {sh[2]:>5.1f}% {sh[3]:>5.1f}%')
        c = cache[cls]
        n = c['n']
        sn = c['snapped']
        none100 = c['notSnappedPct'] + (100 - c['notSnappedPct']) * c['disp']['over']['100'] / 100
        print(f'{"CURRENT network (cache)":<26} {"":>7} {"":>7} {"":>7} | {c["disp"]["median"]:>8.0f} {c["disp"]["p75"]:>5.0f} {c["disp"]["p90"]:>5.0f} | '
              f'{"n/a":>8} {"n/a":>6} {c["noneIn250Pct"]:>5.1f}% {c["notSnappedPct"]:>5.1f}%   (n {n}, snapped {sn}; none>100 m derived: {none100:.1f}%)')
        print()
    return res


# ----------------------------------------------------------------------- V3

@nb.njit(cache=True)
def stream_size(upa, d8, rows, cols, thr, west, north, pix):
    nt = thr.shape[0]
    cnt = np.zeros(nt, dtype=np.int64)
    length = np.zeros(nt, dtype=np.float64)
    dy = pix * np.pi / 180.0 * 6371.0088
    for r in range(rows):
        lat = north - (r + 0.5) * pix
        dx = dy * np.cos(lat * np.pi / 180.0)
        dg = np.sqrt(dx * dx + dy * dy)
        for c in range(cols):
            i = r * cols + c
            v = upa[i]
            if v < thr[0]:
                continue
            d = d8[i]
            step = 0.0
            if d < 8:
                step = dx if (d == 0 or d == 4) else (dy if (d == 2 or d == 6) else dg)
            for t in range(nt):
                if v >= thr[t]:
                    cnt[t] += 1
                    length[t] += step
    return cnt, length


def v3(arms):
    print('=' * 78)
    print('V3  SIZE')
    print('=' * 78)
    print(f'current network, for scale: {CURRENT_REACHES:,} reaches, {CURRENT_VERTICES:,} vertices')
    print(f'{"":<26} {"stream cells":>14} {"length km":>12} {"cells/vertex":>13}')
    for a in arms:
        m = a['meta']
        cnt, ln = stream_size(np.asarray(a['upa']), np.asarray(a['d8']), m['rows'], m['cols'], np.array(THRESH, dtype=np.float32),
                              m['west'], m['north'], m['pixelDeg'])
        for t, c, l in zip(THRESH, cnt, ln):
            print(f'{a["name"] + "  >= " + format(t, "g") + " km2":<26} {int(c):>14,} {l:>12,.0f} {c / CURRENT_VERTICES:>13.1f}')
    print()


# ------------------------------------------------------------------ --diagnose
#
# Measurement of the tail the V1 table shows: where the flood filled big basins, who
# inherited their area, why twelve big stations miss, and how good the grid's own
# area is once snapping is separated out. Needs raise.bin (build with
# python pipeline/build-fine-network.py --burn <N> --save-raise). Run with --diagnose.
#
# WHAT IT CANNOT SAY. A region raised by more than 50 m is a closed basin OR a bad
# cell; the raw elevations around the 3x3 of the maximum are printed so the reader can
# tell, but a real lake with its surface in the DEM and a sill above it looks the
# same as a pit. "Routed via filled regions" counts area whose water was sent through
# one, which is false area only if the basin really is closed.

import importlib.util


def _builder():
    spec = importlib.util.spec_from_file_location('fine_build', os.path.join(ROOT, 'pipeline', 'build-fine-network.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cell_of(m, lat, lon):
    return int(math.floor((m['north'] - lat) / m['pixelDeg'])), int(math.floor((lon - m['west']) / m['pixelDeg']))


def latlon_of(m, r, c):
    return m['north'] - (r + 0.5) * m['pixelDeg'], m['west'] + (c + 0.5) * m['pixelDeg']


def cell_m(m, lat):
    dy = m['pixelDeg'] * math.pi / 180 * EARTH_M
    return dy, dy * math.cos(math.radians(lat))


def disk(arm, lat, lon, radius_m):
    """Cells within radius_m of a point: (rows, cols, distance m, upstream area km2)."""
    m = arm['meta']
    R, C = arm['shape']
    r0, c0 = cell_of(m, lat, lon)
    dy, dx = cell_m(m, lat)
    ry, rx = int(math.ceil(radius_m / dy)) + 1, int(math.ceil(radius_m / dx)) + 1
    rr, cc = np.meshgrid(np.arange(r0 - ry, r0 + ry + 1), np.arange(c0 - rx, c0 + rx + 1), indexing='ij')
    y, x = (m['north'] - lat) / m['pixelDeg'], (lon - m['west']) / m['pixelDeg']
    dist = np.hypot((rr + 0.5 - y) * dy, (cc + 0.5 - x) * dx)
    sel = (dist <= radius_m) & (rr >= 0) & (rr < R) & (cc >= 0) & (cc < C)
    rr, cc, dist = rr[sel], cc[sel], dist[sel]
    return rr, cc, dist, arm['upa'].reshape(R, C)[rr, cc].astype(np.float64)


def argmax_cell(arm, lat, lon, k):
    """Cell of maximum upstream area within k cells (square window): (area, r, c, flagged)."""
    m = arm['meta']
    R, C = arm['shape']
    r, c = cell_of(m, lat, lon)
    u = arm['upa'].reshape(R, C)[r - k:r + k + 1, c - k:c + k + 1]
    i = np.unravel_index(int(np.argmax(u)), u.shape)
    rr, cc = r - k + i[0], c - k + i[1]
    return float(u[i]), rr, cc, bool(arm['flag'].reshape(R, C)[rr, cc])


def rule_pick(arm, lat, lon, pub, rule):
    """Area chosen by a snap rule. (b) and (c) USE the published area; (a) and (d) do not."""
    if rule[0] == 'a':
        return argmax_cell(arm, lat, lon, rule[1])[0]
    if rule[0] in ('b', 'c'):
        rr, cc, dist, a = disk(arm, lat, lon, 300 if rule[0] == 'b' else 150)
        a = np.where(a > 0, a, 1e-9)
        return float(a[int(np.argmin(np.abs(np.log(a / pub))))])
    rr, cc, dist, a = disk(arm, lat, lon, 300)
    keep = a >= 0.25 * a.max()
    return float(a[keep][int(np.argmin(dist[keep]))])


# ---- OSM line distance (exact point-to-segment, local metres)

_SEG = {}


def osm_segments():
    if not _SEG:
        lines = json.load(open(os.path.join(ROOT, 'public', 'nepal-osm-rivers.json'), encoding='utf8'))['lines']
        a, b, r = [], [], []
        for l in lines:
            p = np.asarray(l['p'], dtype=np.float64).reshape(-1, 2)
            if len(p) < 2:
                continue
            a.append(p[:-1])
            b.append(p[1:])
            r.append(np.full(len(p) - 1, l['r'], dtype=np.int8))
        _SEG.update(a=np.concatenate(a), b=np.concatenate(b), r=np.concatenate(r))
    return _SEG


def osm_dist(lat, lon, win=0.05):
    """(distance to nearest OSM line of any class, to nearest river-class line), metres; inf if none within ~5 km."""
    s = osm_segments()
    near = ((np.minimum(s['a'][:, 0], s['b'][:, 0]) <= lat + win) & (np.maximum(s['a'][:, 0], s['b'][:, 0]) >= lat - win)
            & (np.minimum(s['a'][:, 1], s['b'][:, 1]) <= lon + win) & (np.maximum(s['a'][:, 1], s['b'][:, 1]) >= lon - win))
    if not near.any():
        return math.inf, math.inf
    a, b, r = s['a'][near], s['b'][near], s['r'][near]
    mlat, mlon = 111194.9, 111194.9 * math.cos(math.radians(lat))
    ay, ax = (a[:, 0] - lat) * mlat, (a[:, 1] - lon) * mlon
    by, bx = (b[:, 0] - lat) * mlat, (b[:, 1] - lon) * mlon
    dy, dx = by - ay, bx - ax
    L2 = np.maximum(dy * dy + dx * dx, 1e-9)
    t = np.clip(-(ay * dy + ax * dx) / L2, 0, 1)
    d = np.hypot(ay + t * dy, ax + t * dx)
    rv = d[r == 1]
    return float(d.min()), (float(rv.min()) if rv.size else math.inf)


def fm(x):
    return '   none' if not np.isfinite(x) else f'{x:>7.0f}'


# ---- numba kernels

@nb.njit(cache=True)
def components(K, cols):
    """Union-find over sorted flat indices K, 8-connected. Returns a root label per element."""
    n = K.shape[0]
    parent = np.arange(n)
    for a in range(n):
        i = K[a]
        c = i % cols
        for d in range(4):  # E, SE, S, SW cover every pair once
            if d == 0:
                if c + 1 >= cols:
                    continue
                j = i + 1
            elif d == 1:
                if c + 1 >= cols:
                    continue
                j = i + cols + 1
            elif d == 2:
                j = i + cols
            else:
                if c == 0:
                    continue
                j = i + cols - 1
            b = np.searchsorted(K, j)
            if b < n and K[b] == j:
                x = a
                while parent[x] != x:
                    parent[x] = parent[parent[x]]
                    x = parent[x]
                y = b
                while parent[y] != y:
                    parent[y] = parent[parent[y]]
                    y = parent[y]
                if x != y:
                    parent[max(x, y)] = min(x, y)
    for a in range(n):
        x = a
        while parent[x] != x:
            x = parent[x]
        parent[a] = x
    return parent


@nb.njit(cache=True)
def trace(d8, start, off, maxn):
    out = np.empty(maxn, dtype=np.int64)
    n = 0
    i = start
    while n < maxn:
        out[n] = i
        n += 1
        v = d8[i]
        if v >= 8:
            break
        i = i + off[v]
    return out[:n]


@nb.njit(cache=True)
def fwd_mark(order_chunk, d8, bits, off):
    """bits bit0 = filled-region cell; sets bit1 where the cell drains THROUGH a filled region. Forward pop order."""
    for k in range(order_chunk.shape[0]):
        i = np.int64(order_chunk[k])
        v = d8[i]
        if v < 8 and (bits[i + off[v]] & 3):
            bits[i] |= 2


@nb.njit(cache=True)
def init_acc(acc, bits, mask, arearow, cols, rows):
    for r in range(rows):
        for c in range(cols):
            i = r * cols + c
            acc[i] = arearow[r] if (bits[i] & mask) else 0.0


@nb.njit(cache=True)
def rev_acc(order_chunk, d8, acc, off):
    for k in range(order_chunk.shape[0] - 1, -1, -1):
        i = np.int64(order_chunk[k])
        v = d8[i]
        if v < 8:
            acc[i + off[v]] += acc[i]


def raise_mm(arm):
    p = os.path.join(FINE, arm['name'], 'raise.bin')
    if not os.path.exists(p):
        sys.exit(f'{p} is missing: rebuild with python pipeline/build-fine-network.py --burn <N> --save-raise')
    return np.memmap(p, dtype=np.uint16, mode='r', shape=(arm['meta']['cells'],))


def area_row(arm):
    m = arm['meta']
    lat = m['north'] - (np.arange(arm['shape'][0]) + 0.5) * m['pixelDeg']
    dy = m['pixelDeg'] * math.pi / 180 * 6371.0088
    return dy * dy * np.cos(np.radians(lat))


# ---- Q1

def q1(arm, off):
    m = arm['meta']
    R, C = arm['shape']
    rz = raise_mm(arm)
    chunk = 500 * C
    ks, mx, mxi = [], 0, 0
    for s in range(0, R * C, chunk):
        b = np.asarray(rz[s:s + chunk])
        ks.append(np.flatnonzero(b > 200) + s)
        j = int(b.argmax())
        if b[j] > mx:
            mx, mxi = int(b[j]), s + j
    K = np.concatenate(ks)
    print(f'--- {arm["name"]}: raise.bin max {mx / 4:.2f} m; cells raised by more than 50 m: {K.size:,} ---')
    arearow = area_row(arm)
    lab = components(K, C)
    _, inv = np.unique(lab, return_inverse=True)
    nreg = int(inv.max()) + 1
    rK, cK = K // C, K % C
    area = np.bincount(inv, weights=arearow[rK], minlength=nreg)
    rzK = np.asarray(rz[K]).astype(np.float64) / 4
    maxr = np.zeros(nreg)
    np.maximum.at(maxr, inv, rzK)
    cnt = np.bincount(inv, minlength=nreg)
    cr = np.bincount(inv, weights=rK, minlength=nreg) / cnt
    cc = np.bincount(inv, weights=cK, minlength=nreg) / cnt
    d8K = np.asarray(arm['d8'][K])
    downK = np.where(d8K < 8, K + off[np.minimum(d8K, 7)], -1)
    pos = np.minimum(np.searchsorted(K, downK), K.size - 1)
    inK = (downK >= 0) & (K[pos] == downK)
    ex = np.nonzero(~inK)[0]
    upK = np.asarray(arm['upa'][K[ex]]).astype(np.float64)
    o = np.lexsort((-upK, inv[ex]))
    ex, upK = ex[o], upK[o]
    first = np.concatenate([[True], inv[ex][1:] != inv[ex][:-1]])
    exit_of = np.full(nreg, -1, dtype=np.int64)
    exit_up = np.zeros(nreg)
    exit_of[inv[ex][first]] = K[ex[first]]
    exit_up[inv[ex][first]] = upK[first]
    print(f'connected regions (8-connected, raise > 50 m): {nreg:,}; total area {area.sum():,.1f} km2; '
          f'largest {area.max():,.1f} km2; regions over 1 km2: {int((area > 1).sum()):,}; over 100 km2: {int((area > 100).sum())}')
    for lo, hi in ((50, 100), (100, 300), (300, 1000), (1000, 1e9)):
        sel = (maxr > lo) & (maxr <= hi)
        print(f'  regions by max raise {lo:>4}-{hi if hi < 1e9 else "up":>4} m: {int(sel.sum()):>5} regions, {area[sel].sum():>8.1f} km2, largest {area[sel].max() if sel.any() else 0:>7.1f} km2')
    print(f'{"#":>2} {"centroid lat":>12} {"lon":>9} {"area km2":>10} {"max raise m":>11} {"spill lat":>10} {"lon":>9} {"upa at spill":>13}')
    for n, g in enumerate(np.argsort(-area)[:25], 1):
        sl, so = latlon_of(m, exit_of[g] // C, exit_of[g] % C)
        cl, co = latlon_of(m, cr[g], cc[g])
        print(f'{n:>2} {cl:>12.4f} {co:>9.4f} {area[g]:>10.1f} {maxr[g]:>11.1f} {sl:>10.4f} {so:>9.4f} {exit_up[g]:>13.1f}')
    r, c = mxi // C, mxi % C
    lat, lon = latlon_of(m, r, c)
    g = inv[int(np.searchsorted(K, mxi))]
    sl, so = latlon_of(m, exit_of[g] // C, exit_of[g] % C)
    print(f'\nMAX raise {mx / 4:.2f} m at row {r}, col {c} = {lat:.5f} N, {lon:.5f} E; it belongs to a region of {area[g]:,.1f} km2 '
          f'({int(cnt[g]):,} cells, max raise {maxr[g]:.1f} m), spill {sl:.4f} N {so:.4f} E, upa at spill {exit_up[g]:,.1f} km2')
    dem = np.memmap(os.path.join(ROOT, 'sources', 'gedtm', 'nepal-gedtm.bin'), dtype='<u2', mode='r', shape=(R, C))
    win = np.asarray(dem[r - 1:r + 2, c - 1:c + 2]).astype(np.float64) / 4 - 500
    wr = np.asarray(rz.reshape(R, C)[r - 1:r + 2, c - 1:c + 2]).astype(np.float64) / 4
    print('raw GEDTM30 elevation m, 3x3 around it (centre = the max-raise cell)      |  raise m in each')
    for i in range(3):
        print('   ' + '  '.join(f'{win[i, j]:8.2f}' for j in range(3)) + '      |  ' + '  '.join(f'{wr[i, j]:8.2f}' for j in range(3)))
    wide = np.asarray(dem[r - 6:r + 7, c - 6:c + 7]).astype(np.float64) / 4 - 500
    print(f'raw elevation 13x13 around it: min {wide.min():.1f}, median {np.median(wide):.1f}, max {wide.max():.1f} m; '
          f'cells in that block lower than the centre by more than 100 m: {int((wide < win[1, 1] - 100).sum())}')
    return dict(K=K, inv=inv, area=area, maxr=maxr, exit_of=exit_of, exit_up=exit_up, cr=cr, cc=cc, nreg=nreg, off=off, rz=rz)


def paiku(arm, st, stations):
    m = arm['meta']
    R, C = arm['shape']
    plat, plon = 28.93, 85.58
    print(f'\nPAIKU CO ({arm["name"]}), searching around {plat} N {plon} E')
    r, c = cell_of(m, plat, plon)
    dem = np.memmap(os.path.join(ROOT, 'sources', 'gedtm', 'nepal-gedtm.bin'), dtype='<u2', mode='r', shape=(R, C))
    print(f'  DEM at the point: {dem[r, c] / 4 - 500:.2f} m; flood raise there: {st["rz"][r * C + c] / 4:.2f} m; upa there {arm["upa"][r * C + c]:.1f} km2')
    cl, co = np.array([latlon_of(m, a, b) for a, b in zip(st['cr'], st['cc'])]).T
    d = np.hypot((cl - plat) * 111.2, (co - plon) * 111.2 * math.cos(math.radians(plat)))
    near = np.nonzero(d < 25)[0]
    if near.size == 0:
        print('  no region with raise > 50 m has its centroid within 25 km')
        return
    for g in near[np.argsort(-st['area'][near])][:4]:
        e = st['exit_of'][g]
        sl, so = latlon_of(m, e // C, e % C)
        print(f'  region centroid {cl[g]:.4f} N {co[g]:.4f} E, {d[g]:.1f} km away: area {st["area"][g]:,.1f} km2, max raise {st["maxr"][g]:.1f} m, '
              f'spills at {sl:.4f} N {so:.4f} E, upa at spill {st["exit_up"][g]:,.1f} km2')
    g = near[int(np.argmax(st['area'][near]))]
    e = int(st['exit_of'][g])
    path = trace(np.asarray(arm['d8']), e, st['off'], 20_000_000)
    el, eo = latlon_of(m, path[-1] // C, path[-1] % C)
    print(f'  downstream from the spill of the largest of these: {path.size:,} cells (~{path.size * 0.031:,.0f} km), ends at {el:.4f} N {eo:.4f} E, upa {arm["upa"][path[-1]]:,.0f} km2 at the end')
    hits = []
    for s in stations:
        _, rr, cc, _ = argmax_cell(arm, s['lat'], s['lon'], 3)
        w = np.nonzero(path == rr * C + cc)[0]
        if w.size:
            hits.append((int(w[0]), s))
    for w, s in sorted(hits, key=lambda t: t[0])[:6]:
        print(f'    on the path at cell {w:,}: DHM station {s["id"]} {s["river"]} ({s["location"]}), published {s["drainageKm2"]:,.1f} km2')
    print(f'  ({len(hits)} DHM stations sit on this path in total)')


# ---- Q2

def q2(arm, stations, st, unflagged):
    m = arm['meta']
    R, C = arm['shape']
    off = st['off']
    N = R * C
    print(f'\n--- {arm["name"]}: unflagged stations whose fine area is more than 10% over the published area ---')
    bits = np.zeros(N, dtype=np.uint8)
    bits[st['K']] = 1
    d8 = np.asarray(arm['d8'])
    chunk = 1 << 26
    path = os.path.join(FINE, arm['name'], 'order.bin')
    with open(path, 'rb') as f:
        for s in range(0, N, chunk):
            fwd_mark(np.fromfile(f, dtype='<u4', count=min(chunk, N - s)), d8, bits, off)
    arearow = area_row(arm)
    acc = np.empty(N, dtype=np.float32)
    cells = [argmax_cell(arm, s['lat'], s['lon'], 3) for s in stations]
    res = {}
    for label, mask in (('own', 1), ('routed', 3)):
        init_acc(acc, bits, mask, arearow, C, R)
        with open(path, 'rb') as f:
            for s in reversed(range(0, N, chunk)):
                f.seek(s * 4)
                rev_acc(np.fromfile(f, dtype='<u4', count=min(chunk, N - s)), d8, acc, off)
        res[label] = [float(acc[c[1] * C + c[2]]) for c in cells]
    del acc, bits
    print(f'{"id":>6} {"river":<24} {"published":>10} {"fine":>10} {"ratio":>6} {"excess":>10} | {"filled-region cells upstream":>29} {"area routed via filled regions":>31}')
    n = tot = 0
    for i, s in enumerate(stations):
        a = cells[i][0]
        if not unflagged[i] or a / s['drainageKm2'] <= 1.10:
            continue
        n += 1
        tot += res['own'][i] > 0
        print(f'{s["id"]:>6} {s["river"][:24]:<24} {s["drainageKm2"]:>10.1f} {a:>10.1f} {a / s["drainageKm2"]:>6.2f} {a - s["drainageKm2"]:>10.1f} | '
              f'{res["own"][i]:>29.2f} {res["routed"][i]:>31.1f}')
    print(f'({n} stations; {int(tot)} have at least one filled-region cell in their upstream area)')


# ---- Q3

BIG = [('115', 'Naugra Gad'), ('125', 'Jamadi Gad'), ('251.5', 'Bauli Gad'), ('255', 'Budhi Ganga'), ('417', 'Badigadkhola'),
       ('642', 'Tsho Rolpa'), ('660', 'Likhu Khola'), ('450', 'Narayani'), ('430.5', 'Seti Gandaki'), ('665', 'Sunkosi'),
       ('695', 'Saptakoshi'), ('449.95', 'Trisuli'), ('350', 'Rapti 350'), ('683.5', 'Mewa Khola'), ('699', 'Lohandra')]


def q3(arms, stations):
    print('\n' + '=' * 78)
    print('Q3  THE BIG MISSES')
    print('=' * 78)
    print('osm = distance from the station coordinate to the nearest OSM line, any class / river class (m).\n'
          's>cell = station to the nearest cell holding >= 80% of the published area (3 km search; none = no such cell).\n'
          'cell>osm = from THAT cell to the nearest OSM line (any class), m. raise = flood raise at that cell, m. ratio = that cell\'s area / published.\n'
          'wid = cells within 150 m of the station whose flood raise > 0, out of the cells in that disk.')
    S = {s['id']: s for s in stations}
    rzs = {a['name']: raise_mm(a) for a in arms}
    print(f'{"id":>7} {"station":<13} {"pub km2":>8} {"osm any":>7} {"osm riv":>7}  {"arm":<7} {"s>cell":>7} {"cell>osm":>8} {"raise":>6} {"ratio":>6} {"wid":>8}')
    for sid, label in BIG:
        s = S[sid]
        da, dr = osm_dist(s['lat'], s['lon'])
        for k, a in enumerate(arms):
            m = a['meta']
            R, C = a['shape']
            rr, cc, dist, up = disk(a, s['lat'], s['lon'], 3000)
            ok = up >= 0.8 * s['drainageKm2']
            head = f'{sid:>7} {label:<13} {s["drainageKm2"]:>8.0f} {fm(da)} {fm(dr)}  ' if k == 0 else ' ' * 46
            r2, c2, d2, _ = disk(a, s['lat'], s['lon'], 150)
            wid = f'{int((np.asarray(rzs[a["name"]][r2 * C + c2]) > 0).sum())}/{r2.size}'
            if not ok.any():
                print(f'{head}{a["name"]:<7} {"none":>7} {"":>8} {"":>6} {"":>6} {wid:>8}')
                continue
            j = np.nonzero(ok)[0][int(np.argmin(dist[ok]))]
            cl, co = latlon_of(m, rr[j], cc[j])
            rzv = float(rzs[a['name']][rr[j] * C + cc[j]]) / 4
            print(f'{head}{a["name"]:<7} {dist[j]:>7.0f} {osm_dist(cl, co)[0]:>8.0f} {rzv:>6.1f} {up[j] / s["drainageKm2"]:>6.2f} {wid:>8}')
    print('\nTRISULI 449.95 in burn10 (fine area 0.0 against published 19,729 km2)')
    a = [x for x in arms if x['name'] == 'burn10']
    if not a:
        return
    a = a[0]
    m = a['meta']
    R, C = a['shape']
    s = S['449.95']
    r0, c0 = cell_of(m, s['lat'], s['lon'])
    osm = _builder().osm_cells(R, C, m['west'], m['north'], m['pixelDeg'])

    def on_osm(r, c):
        k = np.searchsorted(osm, r * C + c)
        return k < osm.size and osm[k] == r * C + c

    inwin = [(r, c) for r in range(r0 - 3, r0 + 4) for c in range(c0 - 3, c0 + 4) if on_osm(r, c)]
    dem = np.memmap(os.path.join(ROOT, 'sources', 'gedtm', 'nepal-gedtm.bin'), dtype='<u2', mode='r', shape=(R, C))
    print(f'  station cell row {r0} col {c0}; OSM line cells within 3 cells (7x7 block): {len(inwin)}')
    for r, c in inwin:
        raw = dem[r, c] / 4 - 500
        print(f'    row {r} col {c}: raw DEM {raw:.2f} m, burned DEM {max(raw - 10, -500):.2f} m (an OSM cell, so lowered 10 m); '
              f'flood raise {rzs["burn10"][r * C + c] / 4:.2f} m; upa {a["upa"][r * C + c]:.3f} km2; d8 {int(a["d8"][r * C + c])}')
    up = a['upa'].reshape(R, C)
    print('  upstream area km2, 13x13 around the station cell (top = north); * = OSM line cell; [ ] = station cell:')
    for r in range(r0 - 6, r0 + 7):
        row = ''
        for c in range(c0 - 6, c0 + 7):
            t = f'{up[r, c]:.1f}' + ('*' if on_osm(r, c) else '')
            row += (f'[{t}]' if (r, c) == (r0, c0) else f' {t} ').rjust(9)
        print('   ' + row)
    dyy, dxx = cell_m(m, s['lat'])
    for x in arms:
        rr, cc, dist, u = disk(x, s['lat'], s['lon'], 3000)
        j = int(np.argmax(u))
        cl, co = latlon_of(m, rr[j], cc[j])
        print(f'  {x["name"]}: largest upa within 3 km = {u[j]:,.1f} km2 at {dist[j]:.0f} m ({(rr[j] - r0) * dyy:+.0f} m south, {(cc[j] - c0) * dxx:+.0f} m east of the station), '
              f'{osm_dist(cl, co)[0]:.0f} m from the nearest OSM line')
    rr, cc, dist, u = disk(a, s['lat'], s['lon'], 3000)
    j = int(np.argmax(u))
    if inwin:
        dd = min(math.hypot((r - rr[j]) * dyy, (c - cc[j]) * dxx) for r, c in inwin)
        print(f'  burn10: the OSM line cell nearest to that big-flow cell is {dd:.0f} m from it')


# ---- Q4

def q4(arms, stations, ok, pub, merit, reach):
    print('\n' + '=' * 78)
    print('Q4  THE GRID\'S OWN AREA ACCURACY, separated from snapping (same stations as V1)')
    print('=' * 78)
    print('(a) max upstream area within k cells (uses no published area).\n'
          '(b) area-matched: the cell within 300 m minimising |ln(area/published)|.  (c) the same within 150 m.\n'
          '    (b) and (c) USE THE ANSWER to choose the cell: an UPPER BOUND on what any snap rule could achieve, NOT an achievable score.\n'
          '(d) nearest cell whose area is >= 25% of the largest upstream area found within 300 m (uses no published area).\n')
    rules = [('a', 1), ('a', 3), ('a', 5), ('a', 8), ('a', 12), ('b',), ('c',), ('d',)]
    names = {('a', 1): '(a) max within 1 cell', ('a', 3): '(a) max within 3 cells', ('a', 5): '(a) max within 5 cells',
             ('a', 8): '(a) max within 8 cells', ('a', 12): '(a) max within 12 cells', ('b',): '(b) area-matched 300 m  [UPPER BOUND, uses the answer]',
             ('c',): '(c) area-matched 150 m  [UPPER BOUND, uses the answer]', ('d',): '(d) nearest >= 25% of max within 300 m'}
    dres = {}
    for a in arms:
        print(f'##### {a["name"]}')
        for rule in rules:
            est = np.array([rule_pick(a, s['lat'], s['lon'], s['drainageKm2'], rule) if ok[i] else np.nan for i, s in enumerate(stations)])
            table(names[rule], est / pub, pub, ok)
            if rule == ('d',):
                dres[a['name']] = est
        print()
    print('--- rule (d) head-to-head, same stations (closer = smaller |ln r|; tied = the two areas within 1% of each other) ---')
    for a in arms:
        f = dres[a['name']][ok]
        for bname, b in (('MERIT', merit), ('HydroRIVERS reach', reach)):
            bb, p = b[ok], pub[ok]
            tie = np.abs(np.log(f / bb)) < 0.01
            fc = (np.abs(np.log(f / p)) < np.abs(np.log(bb / p))) & ~tie
            bc = (np.abs(np.log(f / p)) > np.abs(np.log(bb / p))) & ~tie
            print(f'  {a["name"]} (d) vs {bname}: fine closer {int(fc.sum())}   baseline closer {int(bc.sum())}   tied {int(tie.sum())}   (n {int(ok.sum())})')
    print('--- baselines on the same stations, for reference ---')
    table('MERIT per-vertex', merit / pub, pub, ok)
    table('HydroRIVERS reach', reach / pub, pub, ok)


def diagnose(arms, stations, engine):
    ns = len(stations)
    pub = np.array([s['drainageKm2'] for s in stations], dtype=np.float64)
    pk = {a['name']: [argmax_cell(a, s['lat'], s['lon'], 3) for s in stations] for a in arms}
    flagged = np.array([any(pk[a['name']][i][3] for a in arms) for i in range(ns)])
    merit = np.array([np.nan if e['meritKm2'] is None else e['meritKm2'] for e in engine], dtype=np.float64)
    reach = np.array([np.nan if e['reachKm2'] is None else e['reachKm2'] for e in engine], dtype=np.float64)
    ok = ~flagged & np.isfinite(merit) & np.isfinite(reach) & (pub > 0)
    print(f'scored set: {int(ok.sum())} stations ({int(flagged.sum())} truncation-flagged excluded)\n')
    off = _builder().DR * arms[0]['shape'][1] + _builder().DC
    print('=' * 78)
    print('Q1  WHAT WAS FILLED (connected regions the flood raised by more than 50 m)')
    print('=' * 78)
    sts = {}
    for a in arms:
        sts[a['name']] = q1(a, off)
        print()
    paiku(arms[0], sts[arms[0]['name']], stations)
    print('\n' + '=' * 78)
    print('Q2  WHO INHERITED FALSE AREA')
    print('=' * 78)
    print('filled-region cells upstream = area (km2) of region cells (raise > 50 m) inside the station\'s upstream area; area routed via filled regions = area (km2) of cells whose\n'
          'water drains THROUGH a filled region on its way to the station (includes the region cells and everything draining into them).')
    for a in arms:
        q2(a, stations, sts[a['name']], ~flagged)
    q3(arms, stations)
    q4(arms, stations, ok, pub, merit, reach)


def main():
    arms = [load_arm(n) for n in ('burn0', 'burn10') if os.path.exists(os.path.join(FINE, n, 'meta.json'))]
    if not arms:
        sys.exit('no arm built: run python pipeline/build-fine-network.py --burn 0 first')
    ea = os.path.join(FINE, 'engine-areas.json')
    if not os.path.exists(ea):
        subprocess.run(['node', '--experimental-strip-types', '--no-warnings', 'checks/dhm-engine-areas.mjs'], cwd=ROOT, check=True)
    stations = json.load(open(os.path.join(ROOT, 'sources', 'dhm-catchments.json')))['stations']
    engine = {e['id']: e for e in json.load(open(ea))['rows']}
    engine = [engine[s['id']] for s in stations]
    for a in arms:
        m = a['meta']
        print(f'{a["name"]}: engine {m["made"]}, {m["cells"]:,} cells, burned {m["burnedCells"]:,}, flagged fraction {m["flaggedFraction"]:.4f}')
    print()
    if '--diagnose' in sys.argv:
        diagnose(arms, stations, engine)
        return
    v1(arms, stations, engine)
    v2(arms)
    v3(arms)


if __name__ == '__main__':
    main()
