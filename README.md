# Ghatta — run-of-river screening

![MIT](https://img.shields.io/badge/license-MIT-blue) ![no backend](https://img.shields.io/badge/backend-none-success) ![no API keys](https://img.shields.io/badge/API%20keys-none-success) ![checks](https://img.shields.io/badge/checks-287%20passing-brightgreen)

**Click a river. Get the schemes worth studying.**

One click on any river in the world. Ghatta walks 22 km downstream along the real channel, reads
the terrain and every complete calendar year in its requested flow window, and searches roughly a thousand intake and powerhouse
positions — then hands back the handful that represent genuine trade-offs, each with a turbine
selected for its duty point and every number traceable to its source.

No backend, no account, no API key. Every request goes from your browser to a public API, so the
app runs on a static host. The public Open-Meteo endpoint is for non-commercial use; commercial
deployments need an Open-Meteo subscription or a self-hosted compatible service.

![Ghatta](docs/screenshot.png)

## How it works

1. **One click** places the study point. Where a mapped river network exists the course is
   followed along its centreline; everywhere else it is traced downhill through the terrain
   tiles, so the same search works worldwide.
2. **The search runs.** Every intake × powerhouse pair along that course is evaluated — head from
   the DEM, flow from GloFAS v4 rescaled onto the network's magnitude, a turbine chosen for the
   duty point and its part-load curve applied to every day of the record.
3. **Only the non-dominated survive.** An alternative is kept when nothing else beats it outright
   on energy, waterway length and head together. Each says what it is best at.
4. **`ρ · g · Q · H · η` is printed as a visible chain**, not hidden, and the river's long profile
   shows the diverted reach drawn on the real bed.
5. **Drag either marker** to slide it along the river. Everything recomputes with no refetch.

The selected alternative also reports **P50 and P90 annual energy** from year-by-year dispatch.
Inside Nepal it adds both published NEA run-of-river PPA dry-energy tests: 30% under the 6+6-month
option and 15% under the 8+4-month option. These are produced by the same turbine curve, residual
flow and scheme-specific hydraulic loss as the headline energy—there is no simplified second
calculation. Nepal-only rules never appear on a foreign site.

For each option, Ghatta also shows the gross energy value at NEA's published 4.80 wet / 8.40 dry
NPR/kWh base rates. It applies no escalation and never calls this contracted revenue, NPV, LCOE or
bankability. Schemes above the posted-rate 100 MW boundary carry an explicit negotiated-rate
warning. See [the PPA reference-value method](docs/nepal-ppa-reference-value.md).

Nepal layouts also enforce the Hydropower Development Policy floor of at least 10% of the lowest
monthly average discharge. The app cannot be set below that floor in Nepal, but the approved EIA
minimum governs whenever it is higher. This is a policy-floor screen—not ecological clearance or
an approved release regime. See [the Nepal environmental-flow method](docs/nepal-environmental-flow.md).

Every selected layout now also reports **daily P90 and P95 hydrological output**: the modelled power
equalled or exceeded on 90% and 95% of usable record days after residual release, hydraulic losses,
minimum turbine flow and part-load efficiency. This is deliberately separate from P90 annual energy.
The headline assumes one screening unit and excludes outages, station service, curtailment and
contractual tests, so it is never labelled firm capacity. A separate one-to-four equal-rated-unit
sensitivity shows how low-flow shutdown and energy could change, with no free cost or equipment
recommendation. See [the power-duration method](docs/power-duration.md).

The URL holds the whole session, so a link reproduces the exact study.

## Nepal first, globally honest

A bundled Natural Earth country polygon selects the operating mode. Within 10 km of its generalized
outline the app warns that authoritative jurisdiction must be checked. **Nepal mode** enables the
official DoED register, DHM station inventory, WECS/DHM regional hydrology screen, BIPAD incident history, GEM
regional active-fault context, 4,152 open Glacial Lake Observatory centroids with directed upstream
channel screening, official DMG 1:50,000 publication availability, Nepal grid
and protected-area extracts, and NEA energy-season tests. It does not rely on a rectangular Himalayan bounding box,
so nearby sites in India, Bhutan and Tibet do not inherit Nepali evidence by accident.

**Global mode** stays useful but deliberately narrower: easily available open terrain, GloFAS
flow, HydroRIVERS where bundled coverage exists, and the open basemap. It makes no claim about a
foreign licence, protected area, grid connection, tariff or country-specific hydrology until a
properly sourced national layer is added. Macrostrat adds clearly labelled small-scale geology at
three sample points worldwide; it never becomes site geology or a mapped project-scale contact.

## Engineering readiness, not a fake score

Every selected layout now opens eight discipline gates: water and energy; head and layout;
sediment and headworks; geology and hazards; equipment/transients/operations; grid; legal,
environmental and social; and cost/schedule/bankability. Evidence is labelled **not assessed,
weak, screened, corroborated, measured, or stop**. There is no percentage that can average a
national-park conflict or impossible desander site away.

The same evidence generates a site-specific field campaign. Work packages are P1/P2/P3, explain
why they are needed, and specify the deliverable—from a DHM record transfer and surveyed control
levels through sediment sampling, engineering geology, grid studies, EFlows, cumulative impacts,
transients, costs and risks. See [the readiness method](docs/engineering-readiness.md).

## What does Nepal's regional hydrology say?

At Nepal reaches with catchment inputs, Ghatta evaluates the legacy WECS/DHM 1990 monthly-flow
regression and the full Q2–Q500 regional flood series. It uses the monthly regime as an independent
Nepal-specific magnitude cross-check, shows disagreement instead of averaging it away, and carries
every area/rainfall input, equation, return period, source and limitation into CSV and GeoJSON.

The flood values are deliberately labelled **regional flood estimates**, never design floods.
Current DoED guidance requires comparison with other applicable methods, gauge-frequency and
historical-flood evidence, direct measurement where data are absent, and GLOF/CLOF investigation;
the project must still document diversion, design/check-flood and PMF/PMP decisions. The
CHPclim-derived rainfall input has a checksum/provenance sidecar and an explicit licence boundary.
See [the Nepal regional-hydrology method](docs/nepal-regional-hydrology.md).

## What has happened near this layout?

Nepal mode screens the selected intake-powerhouse reach against 9,102 approved, verified records
from the Government of Nepal BIPAD portal: landslide, flood, earthquake, GLOF, avalanche and
inundation. Matching reports within a 15 km investigation corridor are shown on the map, linked to
their official records and carried into the geology/hazards gate and GeoJSON export.

These are reports, not a probability model. Points can be municipality/ward locations, repeated
reports are not deduplicated into invented events, reporting coverage changes over time, and point
proximity cannot establish slope runout or upstream flood/GLOF connectivity. Zero reports is shown
as “no mapped reports found,” never “no hazard.” See [the hazard method](docs/hazard-incidents.md).

## What is connected upstream of the intake?

Nepal mode also walks 4,152 CC BY 4.0 Sentinel-2 glacial-lake centroids and relevant approved,
verified BIPAD reports through the directed HydroRIVERS network. It reports sources whose mapped
channel reaches the selected intake, the along-channel distance, vertex-snap distance, and the
lake dataset's published 2017–2024 expansion and outlier flags. The map shows a capped set of
overlapping routes while GeoJSON retains every candidate point and metric.

This is deliberately called a channel-connectivity candidate. It does not classify a lake as
dangerous, prove that a reported landslide entered the river, or calculate breach probability,
runout, attenuation, cascade effects or a design flood. A centroid snap can cross a local divide,
and HydroRIVERS omits small streams. Zero candidates is never hazard clearance. See [the upstream
connectivity method](docs/upstream-connectivity.md).

## Which mapped active faults are near the reach?

Nepal mode also measures the reach against 55 Nepal-plus-buffer active-fault traces from the
[GEM Global Active Faults Database](https://github.com/GEMScienceTools/gem-global-active-faults),
pinned to an immutable source commit. It reports the nearest regional trace and shows every trace
within a 50 km investigation window. Exact polyline intersections carry reach chainage into the
map, readiness gate, field plan and GeoJSON.

This is regional context, not fault set-out or seismic design. “Intersects” means the generalized
fault trace intersects the mapped river centreline—not a surveyed canal, tunnel, penstock or
foundation. Distance and non-intersection are never clearance. See [the active-fault
method](docs/fault-screen.md).

## Which geological maps should the team obtain?

Nepal mode matches the selected reach against the current official DMG catalog of 41 published
1:50,000 map products. It shows only the publications and derived sheet footprints that touch the
reach, carries the named maps into the field plan and exports, and links the official previews.
Usable maps are hard-copy DMG products: Ghatta does not bundle or trace the all-rights-reserved
imagery. A no-match means no product was identified in that online catalog, not no geology.

At intake, mid-reach and powerhouse, the app also samples open CC BY 4.0 Macrostrat regional
geology while retaining each original reference. This is visibly small-scale context and the
geology gate remains `weak`; it cannot locate contacts or determine rock mass, permeability,
foundation, tunnel or slope conditions. See [the geology source method](docs/geology-sources.md).

## Taking the work away

Three exports: a **CSV** of the numbers to put in front of a colleague, a **GeoJSON** of the
geometry to drop into QGIS, and an assignable **field-plan CSV** of gates, priorities and
deliverables. All carry their mode, evidence and limitations; the main exports carry a header naming every source,
assumption and limitation — including a warning listing any licensed project
already on the reach — so the file still explains itself a year later. The link
in the address bar reopens the exact study.

## Is the river already taken?

Before any engineering, a developer needs to know who already holds or has applied
for the water. Schemes are cross-referenced offline against **all nine official
Department of Electricity Development hydro tables**: survey and construction
licences, applications and operating plants, above and below 1 MW. The current
bundle contains 1,175 records from the register updated July 31, 2026; 1,169 have
usable coordinates. Operating and construction records sort first, but survey
records and applications remain visible.

DoED publishes coordinate ranges, not project alignments. Ghatta retains those
ranges and measures proximity to the range instead of an invented point; the
midpoint is used only for the map marker and the guarded directed-network screen below. A clear result is shown explicitly, with
the source update and bundle dates, and every panel links back to the live register.

## Which projects may interact upstream or downstream?

After removing the direct reach records, Nepal mode walks canonical DoED project coordinate-range
midpoints through the directed HydroRIVERS network. A midpoint must snap within 2 km, and an
upstream-to-intake or powerhouse-to-downstream route must be no longer than 200 km. The result
separates upstream and downstream candidates on the map and in CSV/GeoJSON, with stage, route,
snap distance, source dates and a warning when the published range itself is wide.

This is deliberately not a cascade declaration. DoED does not publish component locations in the
register, and a range midpoint can snap to the wrong tributary. Network topology cannot establish
shared water, legal overlap, releases, tailwater, flushing, operating rules or cumulative effects.
Upstream operating/construction candidates weaken the naturalized flow case; candidates on either
side open operations, transient and cumulative-impact work, but never create a false legal stop.
Zero candidates is not clearance. See [the directed project-interaction method](docs/cascade-projects.md).

## What it refuses to hide

- **Two models, one river.** Where a mapped river network is available it reports its independent
  long-term mean beside GloFAS's. If they disagree by more than 2×, the app says so loudly — the
  ~5 km model grid can sit on a different channel entirely, and that is a 5× error in your answer,
  not a rounding difference.
- **Only complete flow years count.** GloFAS can return null-filled early years or a partial latest
  year. Those fragments are removed before the FDC, energy, P50 or P90 is calculated.
- **Every figure states its source** underneath it — which DEM, what grid spacing, how many complete years
  of record, how far the model cell is from your click, whether the flow came from the network or
  a cache.
- **Modelled is not measured.** GloFAS is a model. It is labelled as one.
- **DEM error is real.** Global terrain carries roughly ±10–16 m of vertical error in steep
  ground, which is stated next to the head it produced.

## Assumptions you control

Design flow exceedance (Q15–Q85), generator/transformer efficiency, residual flow as a share of the
driest month, and the household figure used for the plain-language comparison. All live. Nepal's
residual-flow control has a 10% policy floor; elsewhere it remains jurisdiction-neutral. Turbine
efficiency and hydraulic loss are calculated per duty point rather than exposed as flat sliders.

## Quickstart

```bash
npm install
npm run dev      # http://localhost:5173
npm run check    # 287 assert-based checks
npm run build    # typecheck + production build
```

Desktop build — the same app, packaged:

```bash
npm run desktop        # run it as a desktop app
npm run desktop:dist   # installers into release/ (.exe, .dmg, AppImage, .deb)
```

There is one codebase. The desktop shell loads the identical build the website
serves, over a custom `app://` scheme rather than `file://` so `fetch` and
workers behave exactly as they do on the web. Verified: the same click produces
the same result in both.

## Is the arithmetic right?

That is the question this project takes most seriously, so it is checked three ways.

**Against the reference implementation.** The turbine module is a hand port of
[HydroGenerate](https://github.com/IdahoLabResearch/HydroGenerate) (Idaho National
Laboratory, BSD-3-Clause). `checks/hydrogenerate.check.ts` pins it to numbers
produced by actually running that library — regenerate them with
`tools/compare-hydrogenerate.py`. The port reproduces the library **exactly** at
every sampled flow, except at three points where it departs on purpose, and each
departure is itself asserted so it cannot happen by accident.

**Against reality.** `checks/plants.check.ts` runs the engine at five built
Nepali power stations — Chilime, Upper Tamakoshi, Nyadi, Kabeli A, Rasuwagadhi —
and requires it to reproduce their published capacity, pick a machine whose ESHA
head band contains the real head, and predict each plant's own efficiency within
8 points. Measured spread: −6.2 to +6.1 points.

This is not ceremony. It found a real defect: HydroGenerate refuses Upper
Tamakoshi outright — Nepal's largest station, 456 MW — because its Pelton region
stops at 60 m³/s and the plant runs 66. The port falls back to the ESHA 2004
head bands and returns Pelton, as built.

**Against itself.** `checks/hydro.check.ts` covers the energy maths, unit traps
(m³/s vs ft³/s, MW vs GWh, gross vs net head), flow-duration construction and
the Pareto invariant that no listed alternative is beaten outright by another.
`checks/api.check.ts` prevents partial calendar years from leaking back into the FDC.

## Data sources

| Source | Access | Licence | Powers |
|---|---|---|---|
| GloFAS v4 via Open-Meteo | runtime, keyless public endpoint for non-commercial use; commercial plan/self-host required | data CC BY 4.0 | Daily discharge, complete local calendar years only, worldwide |
| Re:Earth Terrain (Mapterhorn / Copernicus GLO-30) | runtime, keyless, CORS ✓ | CC-BY 4.0 | Elevation profile and head |
| AWS Terrain Tiles | runtime, keyless, CORS ✓ | public domain / attribution | Hillshade, and DEM fallback |
| OpenFreeMap / OpenMapTiles / OSM | runtime, keyless | ODbL | Basemap |
| HydroRIVERS v1.0 extract | bundled, 525 KB gz | HydroSHEDS licence | Catchment area, click snapping, the cross-check |
| Official Nepal DoED hydro registers | bundled; 9 tables, updated 2026-07-31, retrieved 2026-08-13 | public government register; verify reuse terms | Direct selected-reach conflicts plus guarded upstream/downstream network candidates |
| Nepal DHM station inventory | bundled metadata, retrieved 2026-08-12; observations require authorisation/API key | official public metadata | 338 river stations; identifies 194 with a discharge series and the exact series ID to request |
| WECS/DHM 1990 regional regressions + CHPclim v2-derived monsoon input | bundled per-reach inputs; 34,669 of 42,197 reaches with MMP; source hashes and build metadata in a sidecar | Government method metadata; CHPclim publicly downloadable but no standalone reuse licence identified—attribute CHC and verify terms; not covered by repository MIT licence | Nepal monthly-flow cross-check and Q2–Q500 regional flood comparators, never project design floods |
| NEA Board ROR PPA base rates | bundled constants; decision effective 2074/01/14 BS, reviewed 2026-08-13 | official public decision; verify project terms | Gross wet/dry base-rate energy comparator and eligibility tests, never contracted revenue or bankability |
| Nepal Hydropower Development Policy 2058 §6.1.1 | bundled rule constant; official DoED/Law Commission text reviewed 2026-08-13 | prevailing government policy; verify current project/EIA requirements | Nepal-only floor of at least 10% of minimum monthly average discharge, with the higher approved-EIA minimum governing |
| ESHA 2004 small-hydropower guide §§3.6–3.7 | method reference, reviewed 2026-08-13 | published technical guide; repository bundles no copyrighted content | P90/P95 daily hydrological power-duration and one-to-four-unit sensitivity, never a contractual firm-capacity or equipment-selection claim |
| OpenStreetMap transmission extract | bundled, retrieved 2026-08-13 | ODbL 1.0 | 486 transmission-line ways and 224 substations |
| OpenStreetMap protected-area extract | bundled, retrieved 2026-08-12 | ODbL 1.0 | Protected-area containment and near-boundary warnings |
| Natural Earth Admin 0 Countries, 1:50m | bundled outline, retrieved 2026-08-13 | public domain | Nepal/global mode selection with a 10 km border caution |
| Government of Nepal BIPAD incident API | bundled, 9,102 approved + verified records, 2011-05-14 to 2026-08-12; retrieved 2026-08-13 | public government API; no explicit dataset licence found, attribute BIPAD/NDRRMA and verify reuse terms | Recorded landslide, flood, earthquake, GLOF, avalanche and inundation reports within 15 km of the selected reach |
| GEM Global Active Faults Database, HimaTibetMap regional traces | bundled derivative, 55 Nepal-plus-buffer fault traces; pinned commit; retrieved 2026-08-13 | CC BY-SA 4.0 | Nearest-trace distance and mapped river-reach intersections in a local metric frame |
| Nepal DMG 1:50,000 geological-map catalog | bundled factual metadata and 54 derived coverage parts for 41 publications; source updated 2026-08-03, retrieved 2026-08-13 | DMG page: All Rights Reserved; map imagery is not bundled | Names official hard-copy map products whose sheet footprints touch the reach |
| Macrostrat geologic map API | runtime, keyless; three point samples per selected layout | CC BY 4.0; retain original source references | Small-scale regional unit/lithology context worldwide, never site geology |

Every runtime endpoint had its `access-control-allow-origin` verified with a real request — see
[docs/research/](docs/research/). The latest dispatch, PPA and live API coverage decisions are in
[the 2026-08-13 accuracy audit](docs/research/2026-08-13-accuracy-audit.md).

## Refreshing bundled data

The source data is reproducible, not hand-maintained:

```sh
npm run build:doed       # all nine official DoED hydro tables
npm run build:dhm        # official DHM station metadata; strips personal fields
npm run build:mmp        # WECS/DHM terrain/rainfall inputs + checksummed provenance sidecar
npm run build:grid       # OSM transmission lines and substations
npm run build:protected  # OSM protected areas
npm run build:hazards    # approved + verified BIPAD incident points; privacy allow-list
npm run build:faults     # pinned GEM regional active-fault derivative; CC BY-SA 4.0
npm run build:geology    # DMG catalog metadata + derived sheet footprints; no map imagery
npm run build:glacial-lakes # open Sentinel-2 lake centroids and published change flags
npm run check            # integrity, privacy, geometry and engineering checks
npm run check:live:geology # production-browser map, CORS, popup and mobile geology QA
npm run check:live:connectivity # upstream lake/report map and non-clearance QA
npm run check:live:cascade # directed DoED map, export and global-isolation QA
npm run check:live:hydest # regional-hydrology terminology, export and mobile QA
```

The builders retry public endpoints and fail before replacing a bundle when a
table is incomplete or a minimum coverage threshold is missed. See
[docs/data-refresh.md](docs/data-refresh.md) for the update policy and audit checks.

## What this is not

Screening, not a feasibility study. It is enough to rank ideas and decide what to survey next; it
is not a basis for investment, licensing or design. The waterway is measured along the river, not
routed as a canal or tunnel — no alignment, cover or portal has been designed. Nothing is costed.
Sediment is a screening proxy with a first-cut desander, not a sediment study. Historical BIPAD
incident proximity focuses fieldwork; engineering geology, susceptibility, seismic action,
runout and upstream flood/GLOF routing are not modelled. Regional GEM trace proximity or
intersection is not a surveyed fault crossing, PGA, return period or seismic design action.
DMG sheet coverage is publication availability, not a geological model; Macrostrat units are
small-scale context, not surveyed contacts, rock mass or foundation/tunnel conditions.
Directed DoED midpoint topology is not a confirmed cascade, shared-water or legal finding and does
not supply releases, tailwater, flushing rules, operating interfaces or cumulative-impact analysis.
WECS/DHM monthly flows are a legacy regional cross-check, not a project hydrology series; its
return-period peaks are regional comparators, not selected diversion, design/check or PMF/PMP floods.

## Built on other people's work

| Project | Licence | How it is used |
|---|---|---|
| [HydroGenerate](https://github.com/IdahoLabResearch/HydroGenerate) — Idaho National Laboratory | BSD-3-Clause | Turbine selection regions and part-load efficiency curves (CANMET/RETScreen 2004 correlations) **ported to TypeScript** in `src/engine/turbine.ts`. Two formulas are deliberately corrected to their published forms; both deviations are documented in the source with the reason. |
| [GRASS GIS `r.green.hydro`](https://github.com/OSGeo/grass-addons) | GPL-2.0+ | Scheme search *method* only — a grid search over intake position × plant length. GPL code is not copied into this MIT project; the published algorithm is reimplemented, with residual flow and a real flow-duration curve added. |
| [OpenHPL](https://github.com/OpenSimHub/OpenHPL) | MPL-2.0 | Equation reference for hydraulic losses (consulted; the 1D module is not yet built). |

BSD-3-Clause notice for HydroGenerate: Copyright (c) Battelle Energy Alliance, LLC / Idaho
National Laboratory. Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the conditions of the BSD-3-Clause licence are met.

Not usable in a browser-only app, despite being excellent: HydroMT, pysheds (Python),
OpenDroneMap (Python/C++), OpenFOAM (C++). These need a backend or a WASM runtime — see
[plan.md](plan.md).

## Licence

[MIT](LICENSE) for Ghatta code. Bundled data keeps its upstream licence; in particular,
`src/data/nepal-faults.json` is a GEM-derived **CC BY-SA 4.0** dataset, with attribution and source
revision embedded in the file and documented in [the fault method](docs/fault-screen.md).
`src/data/nepal-geology-maps.json` contains DMG catalog facts and derived footprints only. The DMG
map previews remain all-rights-reserved and outside the MIT licence. Macrostrat runtime results stay
under CC BY 4.0 with their original references.
The CHPclim-derived monsoon input is publicly downloadable but no standalone reuse licence was
identified on its product page; it remains outside the repository MIT licence, with Climate
Hazards Center attribution, source hashes and that rights warning embedded in the provenance sidecar.
