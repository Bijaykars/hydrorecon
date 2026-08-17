# Data refresh and integrity policy

Ghatta is a screening tool, so a stale contextual layer is less dangerous than
an incomplete layer that silently says “nothing here.” Builders therefore fail
closed: the existing verified bundle remains in place until a complete new
extract has been assembled and checked.

## Current bundled snapshots

| Bundle | Upstream | Source update / retrieval | Coverage |
|---|---|---|---|
| `doed-projects.json` | Nepal Department of Electricity Development | register updated 2026-07-31; retrieved 2026-08-13 | 1,175 records across 9 tables; 1,169 geolocated |
| `dhm-stations.json` | Nepal Department of Hydrology and Meteorology | retrieved 2026-08-12 | 1,115 stations; 338 river stations; 194 discharge series |
| `nepal-grid.json` | OpenStreetMap via Overpass | retrieved 2026-08-13 | 486 transmission-line ways; 224 substations |
| `nepal-protected.json` | OpenStreetMap via Overpass | retrieved 2026-08-12 | 20 major protected areas |
| `nepal-hazards.json` | Government of Nepal BIPAD incident API | retrieved 2026-08-13; incidents 2011-05-14 to 2026-08-12 | 9,102 approved + verified records: 5,771 landslide, 2,952 flood, 336 earthquake, 43 avalanche, 0 GLOF, 0 inundation |
| `nepal-faults.json` | GEM Global Active Faults Database at pinned commit `56816508ad92fd6846dad1163b1c8c01376a2cd1` | retrieved 2026-08-13 | 59 regional HimaTibetMap structures intersect the window; 4 fold axes excluded; 55 active-fault traces retained; CC BY-SA 4.0 derivative |
| `nepal-geology-maps.json` | Government of Nepal DMG 1:50,000 geological-map catalog | source updated 2026-08-03; retrieved 2026-08-13 | 41 official publication rows; 54 derived sheet/partial-sheet coverage parts; catalog metadata only, no map imagery |
| `nepal-glacial-lakes.json` | Glacial Lake Observatory Sentinel-2 unique-lake centroids, Zenodo record 17802334 | published 2025-12-08; observations 2017–2024; retrieved 2026-08-13 | 4,152 centroids: Nepal 2,350, China 1,744, India 58; Koshi/Gandaki/Karnali transboundary basins; CC BY 4.0 |
| `nepal-hypso.dat` + `nepal-hydest-provenance.json` | Re:Earth terrain, CHPclim v2 monthly climatology and HydroBASINS level 12 | rebuilt 2026-08-13; each upstream archive/raster hash embedded | 42,197 reaches at 4 bytes/reach; below-5,000 m and below-3,000 m fractions plus MMP on 34,669 reaches (82.2%); output SHA-256 embedded |

Retrieval dates are embedded in the JSON, shown beside relevant findings in the
app, and written into exports. Static products such as HydroRIVERS v1.0 retain
their upstream release version rather than a misleading “fresh” date.

## Commands

```sh
npm run build:doed
npm run build:dhm
npm run build:mmp
npm run build:grid
npm run build:protected
npm run build:hazards
npm run build:faults
npm run build:geology
npm run build:glacial-lakes
npm run check
npm run build
npm run check:live:geology
npm run check:live:connectivity
npm run check:live:cascade
npm run check:live:hydest
```

Run each builder from the repository root. Public government and Overpass
services are occasionally slow; retry logic and alternate Overpass mirrors are
part of the builders. Do not weaken the coverage thresholds just to make a
transient upstream failure pass.

## What the checks protect

- The DoED builder reads survey licences, construction licences, operating
  plants, survey applications and construction applications above and below
  1 MW. It requires consecutive table serial numbers and minimum record counts.
- DoED's published south/north/east/west coordinate range is retained. The UI
  screens the selected intake–powerhouse reach against the range. The midpoint
  is used only for a marker and guarded directed-network probe; it must never be
  relabelled as a project component or alignment.
- The cascade audit canonicalizes name + capacity across lifecycle tables (1,167
  canonical geolocated records in the current snapshot), excludes direct reach
  results, enforces a 2 km midpoint snap and 200 km route cap, and preserves its
  explicit non-claim. A duplicate-count change requires manual review because
  it can reflect a real lifecycle update or an upstream naming change.
- Promoter addresses, email addresses and phone numbers are discarded. Tests
  scan the compact bundle for contact details.
- DHM metadata uses an explicit allow-list. Observer identity, phone, address,
  bank, account, PAN and performance fields never enter the repository.
- Grid lines below 30 kV are excluded; unknown-voltage lines remain visible but
  cannot satisfy an adequate-connection test.
- Protected geometry is checked against named, unambiguous parks and published
  areas, and foreign parks crossing Nepal's bounding box are rejected.
- The BIPAD builder validates hazard IDs against their official names, ignores
  the API's impossible signed-int64 `count`, paginates until a short/empty page,
  checks descending dates and unique IDs, and retains approved + verified
  records only. Its allow-list keeps only ID, hazard, date and point; descriptions,
  addresses, creator IDs and loss records never enter the bundle.
- BIPAD production is tried first. Its official development mirror is an
  explicit fallback, and `_fetchedFrom` records which host supplied the snapshot.
  A failed fetch or schema/coverage check cannot replace the previous file.
- The fault builder downloads an immutable GEM commit, hashes the full upstream
  file, clips line segments rather than selecting vertices, requires the pinned
  59 regional structures / 55 fault sources and Main Frontal Thrust, rejects
  fold axes, validates coordinate order and bounds, and writes atomically. A
  different upstream revision must be reviewed and deliberately re-pinned.
- `nepal-faults.json` is a CC BY-SA 4.0 derivative. Its attribution, citation,
  commit and licence metadata must not be removed or relabelled as MIT.
- The geology builder requires the exact official 41-row catalog and availability
  wording, derives modern and legacy sheet bounds, validates HTTPS hosts and known
  2022 coverage, hashes the page and writes atomically. Geographic regressions
  protect known Nepal sheet locations and reject out-of-window footprints.
- `nepal-geology-maps.json` contains factual catalog metadata and derived sheet
  footprints. DMG's all-rights-reserved preview imagery is never downloaded into
  the bundle and must not be relabelled as MIT/open data.
- The glacial-lake builder validates Zenodo's open-access and CC BY 4.0 metadata,
  exact centroid filename, file size and MD5 checksum; requires EPSG:4326 and
  4,000–5,000 rows; validates all country/basin/connectivity values and bounds;
  and writes only an 11-field engineering allow-list. It retains expansion and
  outlier flags but must never manufacture a dangerous-lake classification.
- `nepal-glacial-lakes.json` is a CC BY 4.0 derivative data file. Its Rawlins et
  al. citation, DOI, source checksum, validation statement and licence boundary
  must remain in the bundle and exports.
- The MMP builder hashes all four CHPclim rasters and the HydroBASINS archive,
  preserves the existing hypsometry bytes, requires output length to match the
  42,197-reach river bundle, and writes a sidecar whose SHA-256 must match
  `public/nepal-hypso.dat`. Missing MMP remains `0xffff`; it is never filled by
  nearest-neighbour guessing.
- CHPclim v2 is publicly downloadable, but no standalone reuse licence statement
  was identified on its product page. Climate Hazards Center attribution, the
  rights warning and the statement that repository MIT does not cover this
  derivative input must remain in the sidecar, UI/export provenance and docs.
- WECS/DHM peaks must be called regional flood estimates. Checks reject wording
  that promotes them to project design floods and preserve the DoED/WECS field
  requirements for gauge-frequency, historical/slope-area, method-comparison,
  direct-measurement, GLOF/CLOF and PMF/PMP work.

## Review before committing a refresh

Compare counts and file sizes with the table above, inspect the diff for large
unexpected losses, run all checks and the production build, then open a known
site such as Marsyangdi. A count increase can be legitimate; a sudden decrease
should be treated as an upstream or parser failure until proven otherwise.
