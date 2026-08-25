"""
Is GEOGLOWS v2 a better flow source for Nepal than what we ship?

    python checks/geoglows-vs-gauges.py

Everything HydroRecon uses for flow is either a 0.05 degree grid (GloFAS, via
Open-Meteo) or a regression fitted to catchment attributes. Both are weakest on
small catchments, which is where every Nepali scheme actually sits: measured
against DHM's gauges and re-weighted to where DoED projects are, the best source
we have runs about 1.6x typical error.

GEOGLOWS v2 is a different shape of thing — a routed model on 6.8 million river
REACHES built from the 12 m TanDEM-X, rather than a grid. If reach-based routing
is what small catchments needed, it should show up here and nowhere else.

The comparison is the same one used for every other source in this project
(checks/smallcatchment-flow.mjs): predict the long-term mean at a DHM gauge and
score it in log space, so a factor of two too high and a factor of two too low
count the same.
"""

import io
import json
import math
import sys

import requests

import geoglows

REST = 'https://geoglows.ecmwf.int/api/v2'
MIN_YEARS = 5

records = json.load(io.open('src/data/dhm-records.json', encoding='utf-8'))
gauges = [
    s
    for s in records['stations']
    if s.get('lat') is not None and (s.get('completeYears') or 0) >= MIN_YEARS and (s.get('meanCms') or 0) > 0
]
print(f'{len(gauges)} DHM gauges with {MIN_YEARS}+ complete years and a mean flow')

# --- coordinate -> reach -----------------------------------------------------
#
# The geoglows package's own latlon_to_river is broken against the current
# metadata table: it looks for a `lat` column the table no longer carries and
# dies with an Arrow schema error. The REST service does the same job.
# SNAP BY CATCHMENT AREA, NOT BY DISTANCE.
#
# Asking for the nearest of 6.8 million reaches is how the first run of this
# check reported the Karnali — Nepal's largest river, 1,380 m3/s measured — at
# 1.2 m3/s. The nearest reach to a gauge coordinate is very often a roadside
# tributary, and the finer the network the likelier that is. A 12 m hydro fabric
# is more precise than the coordinates being matched against it.
#
# So each gauge is probed at nine points about a kilometre apart, and the
# candidate whose upstream contributing area best matches the catchment our own
# network reports there is chosen. Area is the right key: it is what a flow
# estimate is a function of, and it is measured independently on both sides.
areas = json.load(io.open('pipeline/.cache/gauge-areas.json', encoding='utf-8'))
meta = geoglows.data.metadata_table()
area_by_id = dict(zip(meta['LINKNO'].astype(int), meta['USContArea'].astype(float)))
print(f'{len(area_by_id)} reaches with an upstream area')

D = 0.009  # about 1 km
ids = {}
for i, s in enumerate(gauges):
    want = areas.get(str(s['id']))
    if not want:
        continue
    cands = set()
    for dy in (-D, 0, D):
        for dx in (-D, 0, D):
            try:
                r = requests.get(
                    f'{REST}/getriverid',
                    params={'lat': s['lat'] + dy, 'lon': s['lon'] + dx},
                    timeout=60,
                )
                if r.status_code == 200:
                    cands.add(int(r.json()['river_id']))
            except Exception:
                pass
    scored = [
        (abs(math.log((area_by_id[c] / 1e6) / want)), c)
        for c in cands
        if c in area_by_id and area_by_id[c] > 0
    ]
    if scored:
        scored.sort()
        ids[str(s['id'])] = scored[0][1]
    if i % 20 == 0:
        print(f'  matched {len(ids)}/{i + 1}')
print(f'matched {len(ids)}/{len(gauges)} gauges to a GEOGLOWS reach by area')
if not ids:
    sys.exit('no reaches resolved')

# --- one batched pull for every reach ---------------------------------------
rivers = sorted(set(ids.values()))
print(f'pulling the retrospective for {len(rivers)} reaches…')
daily = geoglows.data.retro_daily(rivers)
means = {}
for col in daily.columns:
    v = daily[col].dropna()
    if len(v) > 3650:  # at least ten years, so the mean means something
        means[int(col)] = float(v.mean())
print(f'{len(means)} reaches returned a usable record')

rows = []
for s in gauges:
    rid = ids.get(str(s['id']))
    if rid is None or rid not in means:
        continue
    rows.append({'river': s.get('river') or '?', 'truth': s['meanCms'], 'pred': means[rid]})

# --- score, the same way every other source in this project is scored --------


def stat(ratios):
    lr = sorted(math.log(x) for x in ratios if x > 0)
    if not lr:
        return None
    n = len(lr)
    return {
        'n': n,
        'median': math.exp(lr[n // 2]),
        'bias': math.exp(sum(lr) / n),
        'typ': math.exp(sum(abs(x) for x in lr) / n),
        'w2': 100 * sum(1 for x in lr if abs(x) <= math.log(2)) / n,
    }


bands = [
    ('under 10 m3/s', lambda r: r['truth'] < 10),
    ('10-100 m3/s', lambda r: 10 <= r['truth'] < 100),
    ('100+ m3/s', lambda r: r['truth'] >= 100),
    ('ALL', lambda r: True),
]

print(f'\nGEOGLOWS v2 long-term mean against the gauge, {len(rows)} stations\n')
print(f"  {'band':16}{'n':>5}{'median':>9}{'bias':>8}{'typ.err':>9}{'within 2x':>11}")
for label, pick in bands:
    sub = [r for r in rows if pick(r)]
    st = stat([r['pred'] / r['truth'] for r in sub])
    if not st:
        continue
    print(
        f"  {label:16}{st['n']:5d}{st['median']:8.2f}x{st['bias']:7.2f}x"
        f"{st['typ']:8.2f}x{st['w2']:10.0f}%"
    )

print('\nfor comparison, measured the same way on this project\'s own gauges:')
print('  mapped network (GloFAS via HydroRIVERS)   1.58x typ.err')
print('  Modified HYDEST regression                1.48x')
print('  network x ModHYDEST blend (shipped)       1.48x')

worst = sorted(rows, key=lambda r: -abs(math.log(r['pred'] / r['truth'])))[:6]
print('\nworst disagreements')
for r in worst:
    print(f"  {r['river'][:26]:28}measured {r['truth']:8.1f}   GEOGLOWS {r['pred']:8.1f}   {r['pred'] / r['truth']:5.2f}x")
