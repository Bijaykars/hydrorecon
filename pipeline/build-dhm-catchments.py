"""
DHM's own table of gauge locations and catchment areas.

    python pipeline/build-dhm-catchments.py [path/to/downloaded.pdf]

WHY THIS EXISTS. CLAUDE.md names the oldest weakness in the validation: the
gauge population is systematically easier than the use population, DHM gauges
sitting on a median catchment near 800 km2 and projects near 100. The 69-gauge
set that carries the headline flow figure sits at a median of 1,957 km2, because
it requires ten complete years and long records live on big rivers.

What was never established is whether that is a property of the DHM NETWORK or of
the project's own record-length filter. DHM publishes the answer: a station list
with a DRAINAGE AREA for each, independent of how many years of discharge
anybody holds. This builds it, so checks/gauge-catchment-bands.mjs can report the
catchment-size distribution of the network, of the 136 records the project holds,
and the flow error banded by size at more than one record-length tier.

SOURCE. Department of Hydrology and Meteorology, Government of Nepal,
"Hydrological Stations with updated Latitude, Longitude and Drainage Area",
updated 2081-02-03 (16 May 2024), linked from https://dhm.gov.np/downloads as
https://dhm.gov.np/uploads/dhm/downloads/Updated_Location_and_Catchment_Area_of_Hydrological_Stations.pdf
(4 pages, an Excel sheet printed to PDF, so the table has real cell rules and
PyMuPDF's table finder recovers it cleanly; `pdftotext -layout` does NOT - it
interleaves the lat/lon/elevation/area columns from different rows).

LICENCE: NONE STATED. DHM publishes no open licence and sells hydrological data.
This is reference metadata - station name, position, elevation, drainage area -
not a discharge record, and the station list is already public through
hydrology.gov.np (src/data/dhm-stations.json, LICENSES.md sec. 5, UNDETERMINED).
But the drainage-area column is not in that feed, and nothing here establishes it
is redistributable. So the output is GITIGNORED, like src/data/dhm-records.json,
and no public twin is written: nothing in the app reads it, only a harness. The
owner decides whether it ships.

WHAT IS KEPT. Everything the table prints, nothing it does not. Blank cells are
null, never zero: several rows have no coordinates and several have no area.

STATION IDS. DHM prints `259.10` and `251.00`; the records index holds `259.1`
and `251`. The id is normalised to the shorter form so the join is on the number
and not on trailing zeros. The printed form is kept beside it.

PyMuPDF (`import fitz`) is already used by pipeline/build-dmg-geology.py; this
adds no dependency.
"""

import json
import os
import re
import sys
import urllib.request

import fitz  # PyMuPDF

URL = "https://dhm.gov.np/uploads/dhm/downloads/Updated_Location_and_Catchment_Area_of_Hydrological_Stations.pdf"
OUT = "sources/dhm-catchments.json"

# Nepal's box, with margin. A coordinate outside it is a typo, not a station.
LAT = (26.0, 30.6)
LON = (79.8, 88.4)


def load_pdf(path):
    if path:
        return fitz.open(path)
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    if not data.startswith(b"%PDF"):
        sys.exit("DHM did not return a PDF (%d bytes). Stopping rather than guessing." % len(data))
    return fitz.open(stream=data, filetype="pdf")


def num(s):
    s = (s or "").strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        sys.exit("unparseable number %r - the table layout changed; stopping." % s)


def norm_id(printed):
    f = float(printed)
    s = repr(f)
    return s[:-2] if s.endswith(".0") else s


def main():
    doc = load_pdf(sys.argv[1] if len(sys.argv) > 1 else None)
    stations = []
    for page in doc:
        for table in page.find_tables().tables:
            for row in table.extract():
                row = [(c or "").replace("\n", " ").strip() for c in row]
                if not row[0].isdigit():
                    continue  # header row
                if len(row) != 8:
                    sys.exit("row has %d cells, expected 8: %r" % (len(row), row))
                sno, printed, river, loc, lat, lon, elev, area = row
                lat, lon = num(lat), num(lon)
                if lat is not None and not LAT[0] <= lat <= LAT[1]:
                    sys.exit("S.No %s latitude %s outside Nepal" % (sno, lat))
                if lon is not None and not LON[0] <= lon <= LON[1]:
                    sys.exit("S.No %s longitude %s outside Nepal" % (sno, lon))
                stations.append(
                    {
                        "sno": int(sno),
                        "id": norm_id(printed),
                        "printedId": printed,
                        "river": river,
                        "location": loc,
                        "lat": lat,
                        "lon": lon,
                        "elevationM": num(elev),
                        "drainageKm2": num(area),
                    }
                )

    snos = [s["sno"] for s in stations]
    if snos != list(range(1, len(snos) + 1)):
        sys.exit("S.No sequence is not 1..%d - a row was lost or doubled; stopping." % len(snos))
    ids = [s["id"] for s in stations]
    dup = sorted({i for i in ids if ids.count(i) > 1})

    out = {
        "_source": "DHM Nepal, Hydrological Stations with updated Latitude, Longitude and Drainage Area, updated 2081-02-03 (2024-05-16)",
        "_url": URL,
        "_licence": "none stated; GITIGNORED pending owner decision (LICENSES.md)",
        "_duplicateIds": dup,
        "stations": stations,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")

    areas = sorted(s["drainageKm2"] for s in stations if s["drainageKm2"])
    print("%d rows, %d with an area, %d with coordinates" % (
        len(stations), len(areas), sum(1 for s in stations if s["lat"] is not None)))
    print("area km2: min %.2f  median %.1f  max %.1f" % (areas[0], areas[len(areas) // 2], areas[-1]))
    print("duplicate normalised ids:", dup or "none")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
