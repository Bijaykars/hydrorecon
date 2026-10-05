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
| `dhm-records.public.json` (23 KB) | `hydrology.gov.np` station identity, carried through the private index | `dhm-public-index.mjs` | **UNDETERMINED** — sec. 5, same family as `dhm-stations.json`. **No discharge statistic in it** — blocker 1 **CLEARED** | ? | ? | ? | Attribute DHM |
| ~~`dhm-records.json` (48 KB)~~ | **DHM Nepal daily discharge**, supplied privately; derived statistics | `build-dhm-records.mjs` | **Not redistributable.** No longer tracked — `.gitignore:43` | **NO** | No | — | Yes, DHM |
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
| `src/data/flow-analogues.json` | Derived from DHM records | Inherits the old **BLOCKER 1**: it holds measured per-station flow (`truth`) and must stay untracked. Outside the scope of the blocker-1 split, which touched the index only |
| `src/data/pondage-validation.gsw*.json`, `pipeline/pondage-references-gsw.json` | Derived vs **JRC Global Surface Water v1.4** | GSW is free and unrestricted (Pekel et al. 2016); these hold scores, not GSW data |
| `a.json` ... `chunk.bin` (19 US-sources scratch files) | Exploration exhaust | **Now gitignored** (`.gitignore:101-119`). Confirmed excluded. |

---

## 2. BLOCKERS

Every item here prevents a clean public release **as the repository stands today**.

### BLOCKER 1 — `src/data/dhm-records.json`: **CLEARED 2026-10-05** by splitting the file

**Resolution: option 3, reduce to station identity only.** Nothing derived from DHM's
discharge is tracked any more, and the owner's local copy still runs at full accuracy.

#### Why option 3 and not the other two

Option 1, written permission, is still the cleanest outcome and is still worth asking for — but
it is an open-ended wait on a department that sells this data, and the release should not block
on it. Option 2, untrack and ship the builder, throws away the station list as well, and the
station list is *already public*: `dhm-stations.json` comes from `hydrology.gov.np/gss/api/station`,
so dropping identity would have removed something the repo is free to carry. Option 3 draws the
line exactly where the licence does.

#### What ships now

`src/data/dhm-records.public.json`, 23 KB, 136 stations, **tracked**. Per station: `id`, `river`,
`location`, `lat`, `lon`, `from`, `to`, `years`, `completeYears`, `days`, and `meanCms: null`.

```json
{"id":"115","river":"Naugra gad","location":"Harsing bagar","lat":29.70194,"lon":80.60722,
 "from":2000,"to":2008,"years":9,"completeYears":7,"days":3074,"meanCms":null}
```

**No discharge statistic survives.** `monthly`, `q.q5`–`q.q95`, `min`, `max` and the annual
`meanCms` value are all gone; verified by asserting that no station in the file carries any of
those keys or a numeric `meanCms`. What remains is identity plus record EXTENT — which years a
station holds and how many daily readings — which is metadata about the record, not the record.

#### What stays local

`src/data/dhm-records.json`, the full index, is now `.gitignore:43` and was removed with
`git rm --cached`, so it remains on disk. `pipeline/restore-dhm-records.mjs` (run by npm
`postinstall`) copies the public twin to that path **only when nothing is there**, which is what
makes "the licensed file is preferred" true without a resolver: an owner's index is never
overwritten, and dropping the full one in later takes effect on the next build.

It is copied rather than aliased on purpose. A Vite alias would have moved the app and left the
twenty-one harnesses in `checks/` reading whatever sat at the literal path — so the accuracy
harnesses would have silently scored the reduced index on the one machine that holds the real
one. That is harness rule 1 in CLAUDE.md, and it is the trap this change could most easily have
fallen into.

#### `meanCms: null` is load-bearing, not cosmetic

`src/dhm.ts` refuses any donor gauge whose measured flow per km² of mapped catchment falls
outside 0.005–0.25 m³/s. `null / area` is 0, which is below that floor, so **all 136 candidates
are refused and `bestTransfer` returns null**: the gauge-transfer path is unavailable rather than
scaling a river by a mean the app does not hold. Omitting the key instead would give
`undefined / area = NaN`, both comparisons would read false, and the screen would have passed a
donor it knows nothing about — a hazard screen failing open, which this repo has been bitten by
before.

#### Honest degradation, and what it costs

| | licensed index | published index |
|---|---|---|
| Stations on the map and in listings | 131 positioned | **131 positioned** |
| Gauge transfer | offered and adoptable | **unavailable, and the panel and the report say why** |
| Flow-duration shape check | national band from 81 gauges | **not run, and the report says so** |
| `npm run check` | exit 0 | exit 0 (`fdcshape.check` skips out loud) |
| `npx tsc -b --force --noEmit`, `npm run build` | exit 0 | exit 0 |

The second row is the point: a published build reports that it cannot transfer a record instead
of transferring one badly. The third row is the honest cost — `engine/fdcshape.ts` fires on about
16% of sites and LOWERS design flow, so a published build's flow figures are the raw model's and
are **less conservative** than a licensed build's. `src/report.ts` states that in the
flow-duration appendix rather than letting the section disappear.

#### No computed number moved, and the signature proves it

This is packaging. `src/dhm.ts` and `src/engine/fdcshape.ts` are both covered by
`pipeline/engine-signature.mjs`, so editing either would have re-staled every stamped row in
CLAUDE.md's accuracy table. **Neither was touched**: the engine signature reads `9ee12d76c779`
before and after, `NATIONAL_SHAPE` reproduces all 21 of its numbers bit for bit, and
`npm run check` passes at the same count. The availability flag lives in a new unsigned module,
`src/dhm-statistics.ts`, read only by `App.tsx`, `Reading.tsx` and `report.ts`.

#### Rebuilding the full index

Already shipped and tracked, now also wired to npm:

- `npm run build:dhm-records -- "<yearbook folder>"` — parses the private yearbooks, writes the
  dailies to `sources/dhm/`, the full index, and the public twin in one pass.
- `npm run build:dhm-index` — the index half alone, from `sources/dhm/` already on disk. Its
  station identity now falls back to the public twin, so it works on a clean checkout.
- `pipeline/repair-dhm-shift.mjs` is unchanged and still applies.

#### One thing NOT closed: the git history

`git log --all -- src/data/dhm-records.json` returns **one commit, `644d723`**. The file with its
statistics is in the published history, so untracking it today is not sufficient on its own.
Before the first public push, either rewrite that path out of history (`git filter-repo
--path src/data/dhm-records.json --invert-paths`) or push a fresh history. **This is the
remaining action on blocker 1**, and it is a release step, not a code change.

Also outstanding and unchanged by this: `src/data/flow-analogues.json` (untracked, sec. 1d) holds
measured per-station flow and must stay untracked, and `fleet-validation.json` carries transferred
gauge values — see blocker 6.

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

---

## 4. Attribution text the licences actually require

Every string below is required, not courtesy. They belong in a `NOTICE` file and in the app's
own about panel.

| source | required text |
|---|---|
| OpenStreetMap (5 files) | `(c) OpenStreetMap contributors` — data available under ODbL 1.0 |
| HydroSHEDS / HydroRIVERS / HydroBASINS | `This product (HydroRecon) incorporates data from the HydroSHEDS database which is (c) World Wildlife Fund, Inc. (2006-2013) and has been used herein under license.` |
| MERIT Hydro | Cite Yamazaki, D., Ikeshima, D., Sosa, J., Bates, P. D., Allen, G. H., & Pavelsky, T. M. (2019). *MERIT Hydro.* Water Resources Research, 55, 5053-5073. https://doi.org/10.1029/2019WR024873 — **plus** the ODbL election statement |
| Copernicus GLO-30 (via Mapterhorn) | `produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved` **and** the required liability sentence: `The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.` ([vendor](https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM/resources/license/License-COPDEM-30.pdf)) |
| Re:Earth Terrain | `Re:Earth Terrain - Mapterhorn (CC BY 4.0)` ([vendor](https://terrain.reearth.land/)) |
| GloFAS / CEMS (runtime and local store) | `Contains modified Copernicus Emergency Management Service information [year]` for adapted data ([vendor](https://ewds.climate.copernicus.eu/licences/cems-floods)) |
| GEM Global Active Faults | Attribute GEM, state CC BY-SA 4.0, link the licence |
| GEM Global Seismic Hazard Map | DOI 10.5281/zenodo.8409647, CC BY-NC-SA 4.0 |
| RGI 7.0 (if shipped) | `RGI 7.0 Consortium (2023). Randolph Glacier Inventory, Version 7.0. NSIDC. DOI 10.5067/f6jmovy5navz` |
| ICIMOD "Geology of Nepal" | ICIMOD RDS; original Amatya & Jnawali (1994), Department of Mines and Geology, Nepal; CC BY 4.0 |
| ICIMOD PDGL inventory | ICIMOD (2020), DOI 10.26066/RDS.1971950, CC BY 4.0 |
| Glacial Lake Observatory | Rawlins, L., Watson, C. S., Bhambri, R., Khadka, N., & Chand, M. B. (2025). Zenodo. DOI 10.5281/zenodo.17802334 |
| CHC / CHPclim | Attribute Climate Hazards Center, UC Santa Barbara — and see sec. 5 |
| USGS ComCat | No requirement; credit USGS as courtesy |
| DHM, DoED, BIPAD/NDRRMA | Attribute the department by name. No licence prescribes a form — sec. 5 |

---

## 5. UNDETERMINED

For each: what was checked, and what it did not settle.

| item | what was checked | verdict |
|---|---|---|
| **DHM Nepal** (`dhm-records.json`, `dhm-stations.json`, `dhm-liveness.json`) | [dhm.gov.np/pages/data](https://dhm.gov.np/pages/data), the [hydrology.gov.np](https://hydrology.gov.np/) station API, the published [Hydrological Data Procurement Process](https://www.dhm.gov.np/uploads/dhm/downloads/Hydrological_Data_Procurement_Process.pdf), and a web search for any DHM data policy | **No open-data licence exists.** Data is sold through a request process. The station-metadata API is publicly open but carries no terms. Nepal's Copyright Act 2059 vests GoN copyright in government works while excluding "general data" — which cuts both ways. **Ask DHM.** |
| **DoED licence register** (`doed-projects.json`) | [doed.gov.np/pages](https://doed.gov.np/pages) (direct fetch failed, ECONNRESET), the build script header, web search | **No published data licence found.** It is an official public register and publication is the point of it, but no reuse terms are stated. Factual register entries are the kind of "general data" Nepal's Act excludes from protection. **Low risk, formally undetermined.** |
| **BIPAD / NDRRMA** (`nepal-hazards.json`) | [bipadportal.gov.np](https://bipadportal.gov.np/) — client-rendered, serves no terms page; the API returns no licence field; the file's own `_terms` key already records "no explicit dataset licence was found" | **No licence published.** The repo's own prior conclusion is confirmed, not overturned. **Ask NDRRMA.** |
| **CHPclim v2** (`nepal-annual-precip.dat`) | [chc.ucsb.edu/data/chpclim](https://www.chc.ucsb.edu/data/chpclim), the [data server path](http://data.chc.ucsb.edu/products/CHPclim/v2/) the builder reads, web search for CHC terms of use | **No standalone reuse licence identified.** The repo reached this conclusion independently (`build-mmp.mjs:514`) and this search did not improve on it. Publicly downloadable is not a licence. **Email chc-help@geog.ucsb.edu.** |
| **Nepal DMG map catalogue** (`nepal-geology-maps.json`) | The DMG page footer, recorded in the file as "All Rights Reserved" | The file holds **no map imagery** — titles, sheet codes, publication dates and derived bounding boxes: facts *about* publications, not the publications. Defensible, but DMG asserts all rights over its site. **Low risk, formally undetermined.** |
| **WECS/DHM 1990** (`nepal-hydest-provenance.json`) | The ICIMOD library catalogue record cited in the file | Government publication, no licence stated. The file carries citation metadata and guidance, not a bulk reproduction of the report's coefficient tables. **Low risk.** |
| **HydroSHEDS redistribution clause** | Three sources that disagree — sec. 3 | **Direction is clear, exact clause unverified.** Read the v1.0 Technical Documentation PDF. |
| **`src/assets/fonts/LICENSE.txt`** | Not opened — out of scope for a data audit | **Read it before release.** Font licences commonly forbid redistribution or webfont conversion. |

---

## 6. VERDICT and recommendation

### Is MIT defensible?

**For the code: yes. For the repository as a whole: no.** Six independent reasons, each
sufficient on its own:

1. Five files are ODbL 1.0 (share-alike, OSM-derived).
2. `nepal-upa.dat` is MERIT — ODbL 1.0 once elected, otherwise non-commercial.
3. `nepal-faults.json` is CC BY-SA 4.0 (share-alike).
4. `nepal-pga.json` is CC BY-NC-SA 4.0 (**non-commercial** and share-alike).
5. ~~`dhm-records.json` has no licence at all and derives from a privately supplied source the
   repo's own `.gitignore` calls non-redistributable.~~ **Closed** — untracked; only station
   identity ships. See blocker 1. Four reasons remain, and all four are share-alike or
   non-commercial labels rather than legal exposure.
6. HydroSHEDS, Copernicus GLO-30 and several CC BY sources require **specific verbatim
   attribution** that MIT's bare copyright notice does not provide.

MIT is also silent on database rights, which is exactly what most of these files are. A
single MIT statement over this tree would be a false claim about data the owner does not own.

### What the repository's licensing should say

The established pattern is **code under one licence, data under another, stated explicitly per
file**. Precedents: the Colouring Cities Research Programme licenses code GPL and data ODbL
([independent](https://github.com/colouring-cities/manual/wiki/CI.-OPEN-LICENCES-%E2%80%90-CODE%2C-DATA-%26-METHODS));
the NeuroSynth data package declares MIT for scripts and ODbL for data in a Debian-format
`copyright` file ([independent](https://masi.vuse.vanderbilt.edu/neurodebian/extracts/neurosynth-data/copyright)).
Open Data Commons itself recommends "prominent statements in relevant locations" plus a local
copy of the licence text ([vendor](https://opendatacommons.org/licenses/odbl/)).

Concretely, four files:

1. **`LICENSE`** — MIT, scope narrowed in a header comment to *source code only* (`src/**`
   excluding `src/data/`, plus `pipeline/` and `checks/`), and **fix the copyright holder** to
   HydroRecon from "RiverPower".
2. **`LICENSE-DATA`** — the full ODbL 1.0 text, as the default licence for the bundled derived
   databases.
3. **`DATA-LICENSES.md`** — or keep this file — carrying the per-file table from sec. 1,
   because ODbL is the *default*, not the universal answer: three files are CC BY-SA or
   CC BY-NC-SA, one is public domain, several are CC BY 4.0.
4. **`NOTICE`** — the verbatim attribution strings from sec. 4, which is the obligation most
   easily and most often dropped.

In `package.json`, replace `"license": "MIT"` with `"license": "SEE LICENSE IN LICENSE"` — the
npm-sanctioned spelling for exactly this situation. Keep `"private": true` unless the package
is actually being published to npm; it is orthogonal to the repo licence.

### Minimum work to a clean public release

| step | cost | effect |
|---|---|---|
| Elect **ODbL 1.0** for MERIT in writing; label `nepal-upa.dat` | one paragraph | Retires the repo's biggest believed liability |
| Label the 5 ODbL files and the 1 CC BY-SA file | labels only | Closes blockers 3 and 4 |
| Write `NOTICE` with the sec. 4 strings | one file | Closes the attribution obligations |
| Fix the `LICENSE` holder; set `package.json` to `SEE LICENSE IN LICENSE` | two edits | Closes blockers 7 and 8 |
| **Decide `nepal-pga.json`**: ship as CC BY-NC-SA, or replace with NBC 105:2020 / USGS | a decision, or a rebuild | Closes blocker 2 — the only one constraining *commercial* use |
| ~~**Decide `dhm-records.json`**~~ | **DONE 2026-10-05** — reduced to station identity | Blocker 1 **cleared**; one release step left, rewrite `644d723` out of history |
| Inspect `fleet-validation.json` for embedded DHM series | one grep | Determines whether blocker 1 reaches it |
| ~~`git log --all` for any historical commit of DHM files~~ | **DONE** — one commit, `644d723` | Removal is NOT effective alone: rewrite history or push a fresh one |
| Read `src/assets/fonts/LICENSE.txt` | one read | Unaudited, and font licences bite |
| Email CHC, DHM, DoED and NDRRMA for terms | four emails | Converts four UNDETERMINED rows into facts |

**Bottom line: a public release is possible, and only two of eight blockers need a real
decision rather than a label.** `nepal-pga.json` decides whether the bundle can be called
commercially usable. `dhm-records.json` decides whether anything with real legal exposure
ships at all. Everything else is paperwork the build scripts have already done the thinking
for — the per-file `_source` and `_license` keys in this repo were right about nearly
everything, and the one place CLAUDE.md was *wrong* was pessimistic: MERIT's dual licence
means the stack has no forced non-commercial dependency except the one seismic file.
