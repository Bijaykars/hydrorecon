# LICENSES.md — what this repository would distribute, and under what terms

Audit date **2026-10-05**. Scope: every data file that is **tracked in git** and would
therefore be published on a public push, plus the untracked-but-present files that a
`git add -A` before release would sweep in.

Method: `git ls-files` for the inventory, `git check-ignore -v` for the exclusions, the
`pipeline/build-*` script header and the file's own `_source` / `_license` key for the
lineage, and the upstream publisher's own licence page for the terms. Every licence row
carries the URL it was confirmed at. Where an authoritative licence could not be found,
the row says **UNDETERMINED** rather than guessing.

---

## 0. What is already excluded (verified, not trusted)

Every path CLAUDE.md claims is gitignored **is** gitignored. Confirmed with
`git check-ignore -v`; all twelve exist on disk and all twelve hit a rule:

| path | rule | why it matters |
|---|---|---|
| `sources/merit-hydro/` | `.gitignore:41` | MERIT GeoTIFFs — the originals never ship |
| `sources/dhm/` | `.gitignore:36` | private DHM daily series |
| `sources/local/` | `.gitignore:32` | private GIS, HERMES units non-redistributable |
| `sources/gem-pga/` | `.gitignore:66` | GEM PGA raster (CC BY-NC-SA) |
| `sources/icimod-pdgl/` | `.gitignore:67` | ICIMOD PDGL source |
| `sources/glofas/` | `.gitignore:45` | ECMWF's to distribute |
| `sources/gedtm/` | `.gitignore:50` | size, not licence |
| `sources/geology/` | `.gitignore:60` | DMG rendered tiles |
| `sources/worldcover/` | `.gitignore:55` | size, not licence |
| `sources/rgi/`, `sources/gsw/`, `sources/icimod-rds/` | `:92, :95, :72` | size, not licence |

**No raster original of a restricted source is tracked.** Everything below is a *derived*
file. That is the whole reason this audit has a positive answer available at all.

---

## 1. Inventory and licence table

Columns are abbreviated: **R?** redistribute, **C?** commercial, **SA?** share-alike,
**Att?** attribution required.

### 1a. `public/` — all tracked

| data file | upstream source | built by | licence | R? | C? | SA? | Att? |
|---|---|---|---|---|---|---|---|
| `nepal-rivers.dat` (1.4 MB) | HydroRIVERS v1.0 (HydroSHEDS, (c) WWF Inc. 2006-2013) | `build-hydrorivers.mjs` | HydroSHEDS License Agreement — see **CONFLICT, sec. 3** | Yes, as a "Licensee Derivative Product" | **Yes** per product page | No | **Yes**, verbatim ([vendor-mirrored](https://dataportal.ponderful.eu/dataset/wwf-hydrosheds)) |
| `nepal-upa.dat` (404 KB) | MERIT Hydro v1.0.1 (Yamazaki et al. 2019) | `build_merit_upa.py` | **Dual: CC BY-NC 4.0 OR ODbL 1.0** ([vendor](https://global-hydrodynamics.github.io/MERIT_Hydro/)) | Yes under ODbL | **Only under ODbL** | **Yes under ODbL** | Yes, cite Yamazaki 2019 |
| `nepal-osm-rivers.json` (13.6 MB) | OpenStreetMap, Geofabrik Nepal extract | `build-osm-rivers.mjs` | **ODbL 1.0** ([vendor](https://opendatacommons.org/licenses/odbl/)) | Yes | Yes | **Yes** | **Yes** |
| `nepal-osm-snapped.dat` (1.6 MB) | OpenStreetMap | `snap-vertices-to-osm.mjs` | **ODbL 1.0** | Yes | Yes | **Yes** | Yes |
| `nepal-elev.dat` (82 KB) | Re:Earth Terrain -> **Mapterhorn** -> Copernicus GLO-30 | `build-hypsometry.mjs` | Mapterhorn **CC BY 4.0**; GLO-30 "COPERNICUS full, free and open" ([vendor](https://download.mapterhorn.com/attribution.json), [vendor](https://terrain.reearth.land/)) | Yes | Yes | No | **Yes**, see sec. 4 |
| `nepal-hypso.dat` (164 KB) | **HydroBASINS lev12** (HydroSHEDS) + Mapterhorn/GLO-30 | `build-hypsometry.mjs`, `build-mmp.mjs` | HydroSHEDS Agreement + CC BY 4.0 / COPERNICUS | Yes | Yes | No | **Yes**, both |
| `nepal-annual-precip.dat` (82 KB) | **CHPclim v2** (Climate Hazards Center, UCSB) | `build-mmp.mjs` | **UNDETERMINED** — sec. 5 | ? | ? | ? | Attribute CHC |

### 1b. `src/data/` — all tracked

| data file | upstream source | built by | licence | R? | C? | SA? | Att? |
|---|---|---|---|---|---|---|---|
| `nepal-pga.json` (71 KB) | **GEM Global Seismic Hazard Map v2023.1.0** | `build-pga.mjs` | **CC BY-NC-SA 4.0** ([vendor, Zenodo 8409647](https://zenodo.org/records/8409647)) | Yes | **NO** | **YES** | Yes, DOI 10.5281/zenodo.8409647 |
| `nepal-faults.json` (20 KB) | **GEM Global Active Faults** @ `56816508` | `build-nepal-faults.mjs` | **CC BY-SA 4.0** ([vendor](https://github.com/GEMScienceTools/gem-global-active-faults/blob/master/LICENSE.txt)) | Yes | Yes | **YES** | Yes |
| `nepal-glacial-lakes.json` (418 KB) | Glacial Lake Observatory, Zenodo 17802334 (Rawlins et al. 2025) | `build-glacial-lakes.mjs` | **CC BY 4.0** ([vendor](https://zenodo.org/records/17802334)) | Yes | Yes | No | Yes |
| `nepal-pdgl.json` (3 KB) | ICIMOD (2020) PDGL inventory, Table 5.6, transcribed | hand | **CC BY 4.0** (RDS, DOI 10.26066/RDS.1971950) | Yes | Yes | No | Yes |
| `nepal-geology-units.json` (465 KB) | **ICIMOD RDS "Geology of Nepal"** (Amatya & Jnawali 1994, DMG) | `build-nepal-geology-units.py` | **CC BY 4.0** ([vendor](https://rds.icimod.org/metadata/e0e362b7-0da2-46b3-9323-f301d3b281b5)) | Yes | Yes | No | Yes |
| `nepal-geology-maps.json` (14 KB) | DMG 1:50,000 map **catalogue metadata** only — titles, sheet codes, footprints, no imagery | `build-topo-index.mjs` / hand | DMG page: **"All Rights Reserved"**. **UNDETERMINED** — sec. 5 | Arguable (facts) | Arguable | No | Yes, DMG |
| `nepal-protected.json` (42 KB) | OpenStreetMap via Overpass | `build-protected.mjs` | **ODbL 1.0** | Yes | Yes | **YES** | Yes |
| `nepal-grid.json` (64 KB) | OpenStreetMap via Overpass | `build-grid.mjs` | **ODbL 1.0** | Yes | Yes | **YES** | Yes |
| `nepal-quakes.json` (41 KB) | **USGS ComCat / FDSN event API** | `build-quakes.mjs` | **Public domain**, US Government work ([vendor](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)) | Yes | Yes | No | Courtesy only |
| `nepal-hazards.json` (344 KB) | **BIPAD portal** (NDRRMA, Govt. of Nepal) incident API | `build-bipad-incidents.mjs` | **UNDETERMINED** — no licence published on the portal. Sec. 5 | ? | ? | ? | Attribute BIPAD/NDRRMA |
| `dhm-records.json` (48 KB) | **DHM Nepal daily discharge**, supplied privately; derived statistics | `build-dhm-index.mjs` | **UNDETERMINED / likely not redistributable** — **BLOCKER 1** | **Assume NO** | No | — | Yes, DHM |
| `dhm-stations.json` (83 KB) | `hydrology.gov.np/gss/api/station` station metadata | `build-dhm-stations.mjs` | **UNDETERMINED** — sec. 5 | ? | ? | ? | Attribute DHM |
| `doed-projects.json` (473 KB) | **DoED licence registers**, nine public tables | `build-doed-projects.mjs` | **UNDETERMINED** — sec. 5 | ? | ? | ? | Attribute DoED |
| `nepal-hydest-provenance.json` (4 KB) | WECS/DHM 1990 method metadata and citation | `build-mmp.mjs` | **UNDETERMINED** (GoN publication); low risk, factual | Arguable | Arguable | No | Cite WECS/DHM 1990 |
| `fleet-validation.json` (2.8 MB) | **Derived engine output**, 193 DoED plants | `build-fleet-validation.mjs` | **Inherits the whole stack** (MERIT, HydroRIVERS, GloFAS, DHM) — **BLOCKER 6** | Cond. | Cond. | Cond. | Yes, all |
| `validation.json` (19 KB) | Derived engine output, 10 plants | `build-validation.mjs` | Inherits the stack | Cond. | Cond. | Cond. | Yes |
| `pondage-validation.json`, `pondage-validation.gedtm30-bare-earth.json` | Derived output vs Kulekhani published figures | `build-pondage-validation.mjs` | Inherits Mapterhorn/GEDTM30; references are published facts | Yes | Yes | No | Yes |
| `site-overrides.json` (1 KB) | Catchment areas transcribed from named documents | hand | Factual, each with a citeable source | Yes | Yes | No | Per entry |

### 1c. Other tracked data

| file | source | licence |
|---|---|---|
| `pipeline/plants.json` (8 KB) | Published specs of 10 Nepali plants | Factual; cite per entry |
| `pipeline/pondage-references.json` (2 KB) | Published stage/area/storage for surveyed reservoirs | Factual; cite per entry |
| `docs/research/phase1-raw-probes.json` | Own probe output | Repo's own |
| `src/assets/fonts/LICENSE.txt` | Bundled font | **Read before release** — not a data file, not audited here |

### 1d. Untracked but present — a `git add -A` would publish these

Not in `git ls-files` today. They are real files on disk inside the repo, and a bulk add
before release would include them. Decide each deliberately.

| file | source | licence |
|---|---|---|
| `public/nepal-glaciers.json` (2.5 MB) | **RGI 7.0** region 15 | **CC BY 4.0** ([vendor](https://rgidata.org/)) — cite RGI 7.0 Consortium (2023), DOI 10.5067/f6jmovy5navz |
| `public/nepal-channel.dat` | OpenStreetMap | **ODbL 1.0** |
| `src/data/dhm-liveness.json` | DHM telemetry endpoints | **UNDETERMINED**, same family as `dhm-stations.json` |
| `src/data/flow-analogues.json` | Derived from DHM records | Inherits **BLOCKER 1** |
| `src/data/pondage-validation.gsw*.json`, `pipeline/pondage-references-gsw.json` | Derived vs **JRC Global Surface Water v1.4** | GSW is free and unrestricted (Pekel et al. 2016); these hold scores, not GSW data |
| `a.json` ... `chunk.bin` (19 US-sources scratch files) | Exploration exhaust | **Now gitignored** (`.gitignore:101-119`). Confirmed excluded. |

---

## 2. BLOCKERS

Every item here prevents a clean public release **as the repository stands today**.

### BLOCKER 1 — `src/data/dhm-records.json`: DHM data with no licence, from a private supply

- `.gitignore:36` says of the source: *"supplied privately, not redistributable. The derived
  index in `src/data/dhm-records.json` travels; the records do not."* The derived index **is
  tracked** and would publish.
- DHM publishes **no open licence**. Hydrological data is a **priced procurement product**
  requiring a request form and, for students, an institutional recommendation letter
  ([vendor](https://dhm.gov.np/pages/data); process PDF:
  [Hydrological_Data_Procurement_Process.pdf](https://www.dhm.gov.np/uploads/dhm/downloads/Hydrological_Data_Procurement_Process.pdf)).
- Nepal's Copyright Act 2059 (2002) vests copyright in the Government of Nepal for works it
  prepares, while excluding "general data" from protection — which cuts both ways and settles
  nothing ([independent](https://ssrana.in/global-ip/international-copyright/copyright-in-nepal/)).
- **What the file contains:** per-station derived statistics for 136 gauges — mean, twelve
  monthly means, seven flow-duration quantiles, min, max, position, river, years of record.
  Not the daily series. This is a *substantial* summary, not a token extract, and it is the
  evidentiary backbone of CLAUDE.md's accuracy table.

**To clear it, pick one:**
1. **Get written permission** from DHM's Hydrological Data and Network Section to publish the
   derived statistics, and quote that permission here. Cleanest outcome.
2. **Untrack it** (`git rm --cached`, add a `.gitignore` rule) and ship `build-dhm-index.mjs`
   so a licensed holder of the yearbooks can rebuild it. Costs the published accuracy table
   its reproducibility, which is this project's core claim.
3. **Reduce to station identity only** — position, river, years of record — dropping every
   flow statistic. Keeps the gauge-transfer screen's existence honest and ships no discharge
   values.

The git **history** matters too. If the file was ever committed, removing it now leaves it in
the published history. Check `git log --all -- src/data/dhm-records.json` before deciding.

### BLOCKER 2 — `src/data/nepal-pga.json`: CC BY-NC-SA 4.0, incompatible with an MIT/open release

- GEM Global Seismic Hazard Map v2023.1.0 is **CC BY-NC-SA 4.0**
  ([vendor](https://zenodo.org/records/8409647)), as the build header already states.
- **Non-commercial.** A public GitHub release is fine, but the file can never be labelled
  commercially usable, and anyone building a commercial product on this repo inherits the
  restriction. That is the exact liability CLAUDE.md names for MERIT, doubled.
- **Share-alike.** Derivatives must be CC BY-NC-SA 4.0. That cannot sit under MIT.

**To clear it, pick one:**
1. **Ship it, labelled CC BY-NC-SA 4.0**, in a per-file data manifest, with a plain statement
   that this one file makes the *bundle* non-commercial. Honest and cheap.
2. **Remove it and re-derive seismic hazard from a freely licensed source.** Nepal's own
   NBC 105:2020 publishes a national seismic hazard map; USGS hazard products are public
   domain. Either removes an NC licence from the stack rather than deepening it.
3. **Make it optional** — gitignore it and keep the `build:pga` path. The builder already
   reads a local raster from `sources/gem-pga/`, which is already ignored, so this is one
   command for anyone who accepts the NC terms.

### BLOCKER 3 — `src/data/nepal-faults.json`: CC BY-SA 4.0 share-alike

CC BY-SA 4.0 ([vendor](https://github.com/GEMScienceTools/gem-global-active-faults/blob/master/LICENSE.txt)).
Commercial use and redistribution are both fine, but **the file cannot be MIT**. The build
header already says this correctly. **Fix: label it, do not relicense it.** Zero cost.

### BLOCKER 4 — five ODbL 1.0 files: share-alike on the data

`public/nepal-osm-rivers.json`, `public/nepal-osm-snapped.dat`, `public/nepal-channel.dat`
(untracked), `src/data/nepal-protected.json`, `src/data/nepal-grid.json`.

Each is a **Derived Database** under ODbL 1.0 and must be offered under ODbL 1.0 with
"(c) OpenStreetMap contributors". Three of the build headers already say exactly this.
**Fix: label them.** No removal needed.

### BLOCKER 5 — `public/nepal-upa.dat`: MERIT Hydro, and the dual licence is the way out

CLAUDE.md treats MERIT as flatly CC-BY-NC and calls it "the one non-commercial licence in the
stack". **That is half the licence.** MERIT Hydro is **dual-licensed: CC BY-NC 4.0 or
ODbL 1.0**, licensee's choice ([vendor](https://global-hydrodynamics.github.io/MERIT_Hydro/)):

> "ODbL 1.0 License: Commercial Use is OK, but the derived data based on MERIT Hydro should
> be made publicly available under the same ODbL license."

A public GitHub release **is** making the derived data publicly available.

**Fix: elect ODbL 1.0 in writing**, label `nepal-upa.dat` ODbL 1.0, cite Yamazaki et al.
2019. This is free — the repo already carries five ODbL files, so one more adds no new
obligation class. **It retires the "MERIT is the non-commercial liability" finding in
CLAUDE.md**, and makes the "what dropping MERIT would cost" decision optional rather than
licence-forced. Worth recording there.

### BLOCKER 6 — `fleet-validation.json` and `validation.json`: derived through the whole stack

2.8 MB of engine output computed from MERIT catchment areas, HydroRIVERS geometry, GloFAS
discharge and, for roughly two-thirds of rows, transferred DHM records. It inherits every
obligation above.

Under ODbL a *produced work* (a figure, a results table) is distinguishable from a *derived
database*, and MERIT's own policy makes that distinction explicitly. A per-plant table of
capacity, energy and head is closer to a produced work — but it is stored as a database, and
2.8 MB of it is not a figure.

**Fix:** label it as derived from the full source list and offer it under ODbL 1.0, the most
restrictive non-NC obligation it inherits. **Also check it for DHM-derived flow values** — if
it embeds transferred gauge series rather than engine outputs, it falls under BLOCKER 1 too.
Inspect before release.

### BLOCKER 7 — `LICENSE` names the wrong project

The file reads `Copyright (c) 2026 RiverPower contributors`. The project is **HydroRecon**.
Trivial to fix, embarrassing to miss on a public release.

### BLOCKER 8 — `package.json` is internally contradictory

`"private": true` alongside `"license": "MIT"`. `private` blocks accidental npm publish and
says nothing about the repo licence; `MIT` claims a licence the bundled data contradicts six
ways over. See the verdict in sec. 6.

---

## 3. CONFLICT — HydroSHEDS says two different things

`public/nepal-rivers.dat` (HydroRIVERS) and `public/nepal-hypso.dat` (HydroBASINS) both
depend on this, and the sources do not agree. All three are shown; none is averaged.

| source | what it says |
|---|---|
| **hydrosheds.org Terms of Use** ([vendor](https://www.hydrosheds.org/terms-of-use)) | "Permission is granted to access and use the Site and to display, copy, print and download the Site Materials for **personal, non-commercial use only**", excluding "any commercial use or any resale or redistribution of the Site or the Site Materials." |
| **HydroRIVERS product page** ([vendor](https://www.hydrosheds.org/products/hydrorivers)) | The database is "freely available for scientific, educational and **commercial** use", governed by the HydroSHEDS License Agreement in the Technical Documentation. |
| **HydroSHEDS License Agreement**, as quoted by third-party data portals ([independent](https://dataportal.ponderful.eu/dataset/wwf-hydrosheds)) | "HydroSHEDS data are free for non-commercial and **commercial** use", and requires this statement on any Licensee Derivative Product: *"This product [insert name] incorporates data from the HydroSHEDS database which is (c) World Wildlife Fund, Inc. (2006-2013) and has been used herein under license."* |

The website ToU governs the *website*; the product licence governs the *data*. The narrowest
reading that the product page and the Agreement both support is: **redistribution of a
derivative is permitted, commercially, with the verbatim copyright statement.** That is what
the Agreement's own "Licensee Derivative Product provided to an End User" wording
contemplates.

**Action:** read the HydroSHEDS v1.0 Technical Documentation PDF directly and confirm the
redistribution clause verbatim before release. Do not rely on the third-party mirror above
for a licence this load-bearing. Newer HydroSHEDS v2 products are CC BY 4.0, which would
settle it outright if the pipeline can be moved to v2.
