# Phase 1 — Data source discovery for browser-only run-of-river prefeasibility

**Method.** 136 candidate endpoints probed with real `curl` GETs carrying `Origin: https://foo.dev`,
header dumps read from the response (never `HEAD` — several servers reject it and give false
negatives), payloads measured in bytes, then a second independent agent re-probed every source
claimed browser-usable. Four claims were refuted on re-check; they are listed below.

Date of probing: 2026-08-11.

---

## 1. Verdict up front

A browser-only static app can do **the entire chain** — live discharge, full-record flow-duration
curve, energy estimate, terrain profile, existing dams — with **no backend, no key, no proxy**, in
the United States. Outside the US it can do a genuinely useful but visibly weaker version, and the
report is explicit about where the weakness bites.

The single measurement that decided the architecture:

| Station | Record | Daily values | Raw | **On the wire (gzip)** | Time |
|---|---|---|---|---|---|
| 01646500 Potomac | 1930–2026 | 35,225 | 2.59 MB | **193 KB** | 2.5 s |
| 06192500 Yellowstone | 1897–2026 | 37,140 | 2.72 MB | **189 KB** | 2.5 s |
| 14191000 Willamette | 1909–2026 | 40,398 | 2.98 MB | **217 KB** | 2.8 s |
| 05331000 Mississippi @ St Paul | worst case found | 48,320 | 1.57 MB (rdb) | **225 KB** | 3.0 s |

Parse + sort to a full FDC costs **under 20 ms** in V8. There is no engineering reason to build a
backend, a tiling scheme, or a pre-aggregation cache. Fetch the whole record.

---

## 2. Top 8 by value ÷ implementation cost

| # | Source | Cost | What it unlocks |
|---|---|---|---|
| 1 | **USGS NWIS Daily Values** `waterservices.usgs.gov/nwis/dv/` | EASY | The flow-duration curve from the complete record. The core of the app. |
| 2 | **USGS NWIS Site service** `/nwis/site/` (`siteOutput=expanded`, `seriesCatalogOutput=true`) | TRIVIAL | Station discovery by bbox **plus** drainage area, altitude + datum, and period of record. Nearly all free metadata. |
| 3 | **USGS NWIS Instantaneous Values** `/nwis/iv/` | TRIVIAL | Live discharge + gage height. One statewide call returns 201 gauges with current flow for 13.6 KB. |
| 4 | **Terrarium DEM tiles** (Re:Earth primary, AWS `elevation-tiles-prod` fallback) | EASY | Elevation profile and gross head. Tiles beat every point API — once the ~3–20 tiles covering a reach are in memory, sampling 200 or 5,000 points costs the same. |
| 5 | **Open-Meteo Flood API** `flood-api.open-meteo.com` (GloFAS) | EASY | The global fallback: 29 years of daily discharge in **m³/s** at any point, 210 KB. Modelled, not measured — must be labelled as such. |
| 6 | **OpenFreeMap** `tiles.openfreemap.org` | TRIVIAL | Keyless vector basemap with rivers and river names already in the OpenMapTiles `waterway` source-layer. No separate river layer needed. |
| 7 | **Overpass API** `overpass-api.de` | EASY | Existing dams, weirs, hydro plants and their capacity in the viewport. |
| 8 | **Esri Living Atlas HydroSHEDS 2.0 Streamlines** | TRIVIAL | Upstream catchment area at a click, Americas only. **Validated: returned 30,003 km² at Little Falls vs USGS published 29,940 km² — 0.2%.** |

Runners-up worth having: **USGS NLDI** (`api.water.usgs.gov/nldi`) turns any lat/lon into an NHDPlus
COMID and returns the upstream basin polygon as GeoJSON; **Global Dam Watch CSV** (4.9 MB, 41,145
dams) for existing infrastructure; **UK EA Hydrology**, **Hubeau** (France), **Canada GeoMet**,
**PEGELONLINE** (Germany) as national tier-1 gauge sources.

---

## 3. Free features — already inside responses we fetch anyway

These are the best value in the report because they cost zero extra requests.

- **`drain_area_va` = 11560.0 square miles** on the USGS site service. Upstream catchment area, free.
  (US customary — × 2.58999 for km².)
- **`alt_va` = 37.04 with `alt_datum_cd` = NAVD88 and `alt_acy_va` = 0.1** — station elevation, datum
  and its accuracy. Directly relevant to head.
- **`count_nu` = 35224** from `seriesCatalogOutput` — exactly matched the number of values the DV
  service then returned, so the app can *predict the download size before committing to the fetch*
  and show an honest progress estimate.
- **`begin_date` / `end_date`** — period of record, for "record: 1930–2026, 96 years" and for
  disabling the FDC on stations with too little history.
- **HUC12 (`hucCd`), county, state, timezone, site name, lat/lon** — on every IV/DV call.
- **`thresholds` array** on the new OGC `time-series-metadata` collection: `Base discharge` 45,000,
  `Begin low flow measurements` 2,000, `Highest since 1889-01-01` 484,000. Real engineering
  reference lines that are otherwise very hard to obtain.
- **`x-amz-meta-x-imagery-sources`** on AWS terrarium tiles, and it is CORS-*exposed* so
  `response.headers.get()` can read it. Observed values: `ned/ned19_..._washingtondc_2008.tif` (US),
  `srtm/N27E085.tif` (Nepal), `eudem/eudem_dem_5deg_n45e005.tif` (Switzerland). **This lets the app
  tell the user which DEM backs their head number, and therefore how much to trust it.**
- **`elevation`** returned by *every* Open-Meteo endpoint for its grid cell, plus the snapped
  lat/lon, which reveals the model resolution you actually got.
- **50 free ensemble members** on the Open-Meteo seasonal API — a ready-made p10/p50/p90 fan with no
  extra requests.
- **`DIS_AVG_LS`** in Global Dam Watch: long-term mean discharge at **40,979 of 41,145 dams (99.6%)**.
  In **litres per second** — divide by 1000.
- **`DRAINAGE_AREA_GROSS`** free on Canada GeoMet, which USGS makes you fetch separately.

---

## 4. Dead ends — look perfect, block the browser

| Source | Why it fails |
|---|---|
| **OpenTopoData** `api.opentopodata.org` | No `ACAO` under **any** variation tried (with/without Origin, POST, full browser headers, error responses). CORS is explicitly a **paid** differentiator on their commercial GPXZ tier. The best free multi-dataset elevation API on the internet, unreachable from client JS. |
| **GRDC** (Global Runoff Data Centre) | No CORS on either host, and there is no API at all — the portal is a Dojo app. Hard dead end on two independent grounds. |
| **GSIM** data archives `store.pangaea.de` | No `ACAO`. The trap: `doi.pangaea.de` *does* reflect Origin and looks encouraging; the host holding the actual files does not. |
| **Copernicus CDS** GloFAS/EFAS retrieval | Key **and** an asynchronous job queue — submit, poll, download GRIB. Definitively unusable. The catalogue is open; the data is not. |
| **ORNL HydroSource EHA** | Would be the best US hydropower layer in the report — per-plant capacity, generation, capacity factor for the whole US fleet in 667 KB. S3 bucket has zero CORS config; `OPTIONS` returns 403. |
| **US National Inventory of Dams** official API | `ACAO` is an origin allowlist echoing only USACE domains. *Four other* `Access-Control-*` headers are present, which is exactly the trap. **Workaround found: the Esri ArcGIS FeatureServer mirror serves the same data with `ACAO: *`.** |
| **api.figshare.com** | Same trap — four `Access-Control-*` headers, no `ACAO`. |
| **Switzerland** `hydrodaten.admin.ch` | No CORS, and the only machine-readable output is an internal Plotly figure object. |
| **Canada** `wateroffice.ec.gc.ca` / Datamart | No CORS. **Superseded by `api.weather.gc.ca` GeoMet, which works.** |
| **Australia** BoM Water Data | 403 from Akamai on http and https, with and without a browser UA. Likely datacenter-IP filtering; treat as unavailable until retested from a real browser. |
| **India** WRIS | No HTTP response at all — root, `/wris/`, ArcGIS REST, POST: zero bytes, no status. Reported honestly as untested rather than as blocked. |
| **Nepal DHM** `hydrology.gov.np` | Station metadata is **fully open** (1,183 sites with elevation, basin, district, `ACAO: *`). `/gss/api/observation` returns **403 `Api Keys required`**. Inventory yes, values no. |
| **EIA / Ember / NVE Norway** | CORS is fine; a key is required. Embedding one in a static bundle makes it public and revocable by abuse. |
| **Protomaps `demo-bucket`** | Range requests work from curl; the browser preflight 403s with no `ACAO`. |
| **Wikimedia Maps** | Referrer allowlist — external hobby apps explicitly out of scope. |
| **MapTiler, Stadia/Stamen** | Key required. Stamen's old keyless endpoints are retired; anything on the web claiming otherwise is stale. |
| **NWM retrospective Zarr on S3** | CORS is fine, chunking defeats it: chunks are `[672 hours × 30,000 reaches]`, one measured at **12.6 MB**. Extracting one reach's 42-year record means downloading essentially the whole array. |
| **NWM raw NetCDF forecasts** | 14 MB per forecast hour containing all 2.7 M CONUS reaches. An 18-hour hydrograph for one reach = 252 MB discarded. Superseded by the NWPS REST API. |

### Refuted on independent re-check

The second-pass agent overturned four first-pass claims:

1. **Open-Elevation is down** — `504 Gateway Time-out` on 4/4 attempts. The `ACAO: *` is real but
   sits on nginx's error page. (It was independently disqualified anyway: measured ~230 m effective
   grid, **15.96 m RMSE** against 3DEP with a 44 m max error. Unusable for head.)
2. **Overpass mirrors `kumi.systems` and `private.coffee` are non-functional** — `/api/status`
   returns 200, but `/api/interpreter` timed out or 504'd on 5/5 attempts. They are also the *same
   physical host* (`193.219.97.30`), so they are not independent failover. Do not put them in a
   retry chain.
3. **The figshare HydroATLAS file ID is wrong** — file `20082110` is a 1.0 MB PDF technical
   document, not the geodata.
4. **A PMTiles range-request result was misattributed** — the headers came from `pmtiles.io`, not
   `protomaps.github.io`. GitHub Pages CORS + Range was re-verified separately and does work.

Also corrected during probing: **`waterway=penstock` does not exist in OSM** (the brief assumed it —
a query over all of Switzerland returns nothing); `labs.waterdata.usgs.gov` is dead and NLDI moved to
`api.water.usgs.gov`; `tiles.wmflabs.org` hillshading is DNS-gone; OpenRiverboatMap now 302s to the
standard OSM tile; `overpass.osm.jp` has an expired TLS certificate and `overpass.nchc.org.tw` no
longer resolves.

---

## 5. Where the idea has to be reshaped

**Catchment rainfall becomes site rainfall, except in the US.** Open-Meteo ERA5 gives *point*
precipitation, not catchment-averaged. True catchment rainfall needs a basin polygon to average
over — available from USGS NLDI (US) and Esri HydroSHEDS (Americas), nowhere else at runtime.
Outside those, label it "precipitation at the site", not "catchment rainfall".

**Global upstream catchment area needs an offline build step.** Solved for the Americas today via
the Esri FeatureServer, and for the US via the USGS site service. There is no global runtime
equivalent — I looked hard. The path is converting HydroRIVERS offline to PMTiles/FlatGeobuf keeping
`HYRIV_ID`, `UPLAND_SKM`, `DIS_AV_CMS`, `NEXT_DOWN` and hosting it on a static CDN. That is real work
and should be a later phase, not v1.

**GloFAS cannot see a small stream.** The Open-Meteo flood API is the only keyless global discharge
source, and it is a ~5 km grid. It resolves the Ganges; it does not resolve the 2 m³/s side-valley
creek that a micro-hydro scheme would actually sit on. The app must say so rather than print a
number. Its record also starts **1997-01-01** in practice even though the API accepts `start_date`
back to 1984 and returns nulls for 13 years — requesting from 1984 wastes ~28% of the payload on
nulls.

**Elevation profiles come from tiles, not point APIs.** With OpenTopoData CORS-blocked and
Open-Elevation both down and too coarse, and Open-Meteo's elevation API capped at **exactly 100
coordinates** (POST does not raise it — verified), the answer is to fetch terrarium tiles and decode
in the browser: `elev_m = (R*256 + G + B/256) - 32768`. This is better anyway, and it is O(tiles)
rather than O(points).

**"What already exists nearby" is best from two sources, not one.** OSM/Overpass is the most current
for small plants and carries `plant:output:electricity`, `operator` and `plant:method` — the last of
which distinguishes `water-pumped-storage` from run-of-river, which matters because pumped storage
should never be shown as a comparable neighbouring plant. Global Dam Watch is the better bulk layer.

---

## 6. Physics validation baseline

Independently derived, then checked against real published plants.

```
P = ρ·g·Q·H·η        ρ=1000 kg/m³, g=9.81 m/s² (ESHA convention)
(kg/m³)(m/s²)(m³/s)(m) = kg·m²/s³ = W          ✓ dimensionally correct

Q=10 m³/s, H=50 m, η=0.85:
  ρg      = 9,810 N/m³
  ρgQ     = 98,100 N/s
  ρgQH    = 4,905,000 W = 4.905 MW      (hydraulic power)
  ×η      = 4,169,250 W = 4.16925 MW    ← answer
  ×8760 h = 36.52263 GWh/yr             (100% CF ceiling, NOT a prefeasibility answer)
```

Choosing `ρ=999.7, g=9.80665` instead moves the answer by **0.064%** — so cross-convention asserts
need `rel_tol = 1e-3`, not bit equality.

**Real-plant back-check — Chilime, Nepal** (operator-published: 22.1 MW, gross head 351.5 m, net head
337.46 m, design flow 7.5 m³/s, 137.9 GWh/yr average):

```
ρgQH_net = 1000 × 9.81 × 7.5 × 337.46 = 24.83 MW at η=1
implied η = 22.1 / 24.83 = 0.890        ← Pelton + generator + transformer: correct
implied plant factor = 137.9 / (22.1 × 8.76) = 71.2%   ← plausible for ROR with peaking pondage
```

**Unit traps, with constants:**

| Trap | Factor |
|---|---|
| ft³/s → m³/s | **0.0283168466** (= 0.3048³ to 10 s.f.; verified `0.3048³ = 0.028316846592`) |
| USGS `unitCode` | exactly `"ft3/s"` — but the new OGC API returns `"ft^3/s"` (caret). Match both. |
| Hubeau (France) discharge | **litres/second**, and there is *no unit field anywhere in the response* |
| Global Dam Watch `DIS_AVG_LS` | litres/second — ÷1000 |
| NWPS `secondaryUnit` | **kcfs** — thousands of ft³/s. Three flow-unit spellings coexist in that one API |
| kW → MW → GWh | ÷1000, ÷1000; `GWh/yr = MW × 8.76 × CF` |
| Hours/year | 8760 (365 d). Leap year is +0.274% — freeze 8760, don't switch on the calendar |
| USGS no-data | **`-999999`** — filter before sorting or it destroys the P90 tail |
| USGS values | JSON **strings** (`"2480"`), not numbers |

**Capacity factor vs plant factor — the literature genuinely conflicts**, and the two verification
agents disagreed on terminology, which is itself the finding. What is not in dispute:

> An FDC integration contains **hydrology only**. No outages, no availability, no curtailment, no
> station service load. It therefore yields a **gross/hydrologic** factor, and the real capacity
> factor is that × availability (0.90–0.97 for hydro). The app must state which it reports.

Also not in dispute: an FDC built from **daily** means smooths sub-daily variability and tends to
**overstate** energy in flashy catchments.

---

## 7. Coverage strategy — recommendation

**Build US-first on USGS, with a clearly-labelled global tier — not global-first.**

Why:

1. **The US data is not merely better, it is a different category.** Full period of record, gauged
   and measured, in one 193 KB request, plus drainage area, datum, period of record and engineering
   thresholds for free. The global reanalysis alternative is modelled output on a 5 km grid.
2. **Global-first would force the headline number to be an estimate.** The whole point of the tool
   is a defensible energy figure. Leading with GloFAS means every user's first impression is a
   modelled value for a river the model may not resolve.
3. **The global tier is cheap to add on top** — Open-Meteo Flood is one endpoint, `ACAO: *`, m³/s,
   and it slots into the same FDC code path. So "US-first" costs nothing in reach; it only decides
   which source is the *default* and which carries the *estimate* label.
4. **The four strong national APIs (UK, France, Canada, Germany) are additive**, not a different
   architecture. Each is a small adapter returning the same shape.

The honest consequence, stated plainly: **for Nepal, India, and most of the Himalaya there is no
open measured discharge available to a browser.** Nepal DHM publishes the station inventory and
key-gates the values; India WRIS did not respond at all. In those regions the app can show station
locations, terrain, rainfall and a GloFAS estimate — and must say "no gauge data available here"
rather than dress a 5 km grid cell up as a measurement.

---

## 8. Open question for Phase 2

The coverage recommendation above assumes a general audience. If the intended primary region is
Nepal/Himalaya specifically, the ranking changes materially — the app would lead with terrain and
catchment-area estimation plus GloFAS, and the US-grade gauge features become the secondary path.
That is a different product, so it is worth settling before design.
