"""
Download GloFAS river discharge for NEPAL ONLY, from the source.

    python pipeline/fetch-glofas-nepal.py --test          one day, to prove the setup
    python pipeline/fetch-glofas-nepal.py 2005 2024       a year range

WHY THIS EXISTS. The app reads daily discharge through Open-Meteo, which is a
free convenience layer over GloFAS. Sweeping two hundred plants exhausts its
quota in an afternoon and earns a twelve-hour pause, which makes measurement
impossible: every A/B has to be run twice on the same sites, and the second run
is always the one that gets refused.

Open-Meteo is not the data. ECMWF publishes GloFAS itself through the Copernicus
Climate Data Store, free, with an account. Subset to Nepal's bounding box and
the whole country is a few hundred megabytes — after which there is no rate
limit, no network at run time, and an A/B costs nothing to repeat. It is also
the polite outcome for a donation-funded service we were leaning on hard.

NEPAL ONLY, deliberately. The same box the river network already covers
(rivers.ts COVER). A global download would be three orders of magnitude larger
and every byte of it useless here.

GloFAS IS NOT ON THE MAIN CDS. It lives in the CEMS Early Warning Data Store,
a sibling service on its own hostname with its own terms. The same ECMWF login
works for both; the endpoint does not. Requesting it from cds.climate...
returns a bare 404 "process not found", which reads like a wrong dataset name
rather than a wrong server, so it is named here explicitly.

WHAT YOU MUST DO ONCE, BY HAND — the API cannot agree to terms for you:
  1. https://ewds.climate.copernicus.eu/licences/terms-of-use-cems
  2. the dataset licence at the bottom of the download form on
     https://ewds.climate.copernicus.eu/datasets/cems-glofas-historical
Until then every request returns 403 with the missing policy named.

Credentials live in ~/.cdsapirc, outside this repository. Nothing here reads or
writes a key, and sources/glofas/ is gitignored: the download is large, it is
ECMWF's to distribute, and it is reproducible from this script.
"""

import sys
import os

# The box the bundled river network covers. Order is CDS's: N, W, S, E.
AREA = [30.6, 79.9, 26.2, 88.4]
OUT_DIR = 'sources/glofas'
EWDS_URL = 'https://ewds.climate.copernicus.eu/api'
DATASET = 'cems-glofas-historical'

MONTHS = [f'{m:02d}' for m in range(1, 13)]
DAYS = [f'{d:02d}' for d in range(1, 32)]


# THE API CHANGED ON 29 JUL 2026, with the GloFAS V5 release restructuring CEMS
# in MARS. Requests written against the old shape fail rather than warn:
#   hyear/hmonth/hday          -> year/month/day
#   river_discharge_in_...     -> average_river_discharge_in_the_last_24_hours
#   timespan                   -> new, mandatory, separates instantaneous from
#                                 time-mean variables
# V4 remains the OPERATIONAL version; V5 is pre-operational and offered for
# evaluation only, so this stays on V4 until there is a reason to move.
def request_for(year, months, days):
    return {
        'system_version': ['version_4_0'],
        'hydrological_model': ['lisflood'],
        'product_type': ['consolidated'],
        'timespan': ['time_mean'],
        'variable': ['average_river_discharge_in_the_last_24_hours'],
        'year': [str(year)],
        'month': months,
        'day': days,
        'data_format': 'netcdf',
        'download_format': 'unarchived',
        'area': AREA,
    }


def main():
    import cdsapi

    os.makedirs(OUT_DIR, exist_ok=True)
    # The key stays in ~/.cdsapirc, outside the repository; only the endpoint is
    # overridden, because that file points at the main CDS and GloFAS is not there.
    key = None
    rc = os.path.join(os.path.expanduser('~'), '.cdsapirc')
    if os.path.exists(rc):
        for line in open(rc, encoding='utf-8'):
            if line.strip().startswith('key:'):
                key = line.split(':', 1)[1].strip()
    if not key:
        print('no key found in ~/.cdsapirc — see the header of this file')
        sys.exit(1)
    client = cdsapi.Client(url=EWDS_URL, key=key)

    if '--test' in sys.argv:
        # One day. Proves credentials, licence acceptance and the area subset
        # before committing to a download measured in hours.
        target = f'{OUT_DIR}/glofas-test-2020-01-01.nc'
        print(f'requesting a single day to {target} …')
        client.retrieve(DATASET, request_for(2020, ['01'], ['01']), target)
        size = os.path.getsize(target)
        print(f'ok — {size / 1024:.0f} KB for one day over Nepal')
        print(f'   a 20-year daily record is roughly {size * 365 * 20 / 1e9:.1f} GB before compression')
        return

    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) != 2:
        print(__doc__)
        sys.exit(1)
    first, last = int(args[0]), int(args[1])

    # A YEAR PER REQUEST. The CDS queues each request separately, and one
    # twenty-year request that fails at hour six has to start again from
    # nothing. Per-year files also let an interrupted download resume.
    for year in range(first, last + 1):
        target = f'{OUT_DIR}/glofas-nepal-{year}.nc'
        if os.path.exists(target) and os.path.getsize(target) > 0:
            print(f'{year}: already have it, skipping')
            continue
        print(f'{year}: requesting …')
        client.retrieve(DATASET, request_for(year, MONTHS, DAYS), target)
        print(f'{year}: {os.path.getsize(target) / 1e6:.0f} MB')


if __name__ == '__main__':
    main()
