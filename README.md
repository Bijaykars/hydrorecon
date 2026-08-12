# Ghatta — run-of-river screening

![MIT](https://img.shields.io/badge/license-MIT-blue) ![no backend](https://img.shields.io/badge/backend-none-success) ![no API keys](https://img.shields.io/badge/API%20keys-none-success) ![checks](https://img.shields.io/badge/checks-86%20passing-brightgreen)

**Click a river. Get the schemes worth studying.**

One click on any river in the world. Ghatta walks 22 km downstream along the real channel, reads
the terrain and a 20-year flow reanalysis, and searches roughly a thousand intake and powerhouse
positions — then hands back the handful that represent genuine trade-offs, each with a turbine
selected for its duty point and every number traceable to its source.

No backend, no account, no API key. Every request goes from your browser to a public API, so it
deploys free to any static host and works the same running locally.

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

The URL holds the whole session, so a link reproduces the exact study.

## Taking the work away

Two exports, because engineers want two different things: a **CSV** of the numbers
to put in front of a colleague, and a **GeoJSON** of the geometry to drop into
QGIS beside their own layers. Both carry a header naming every source,
assumption and limitation — including a warning listing any licensed project
already on the reach — so the file still explains itself a year later. The link
in the address bar reopens the exact study.

## Is the river already taken?

Before any engineering, a developer needs to know who already holds the water.
Schemes are cross-referenced against Nepal's Department of Electricity Development
licence registry, and any project within 6 km of the studied reach is listed and
mapped — operating plants and construction licences in red and amber, survey
licences in grey. On the Marsyangdi it correctly surfaces Madhya Marsyangdi, a
built 70 MW station, sitting across the reach the search just proposed.

The public snapshot lags the live register, which the panel says.

## What it refuses to hide

- **Two models, one river.** Where a mapped river network is available it reports its independent
  long-term mean beside GloFAS's. If they disagree by more than 2×, the app says so loudly — the
  ~5 km model grid can sit on a different channel entirely, and that is a 5× error in your answer,
  not a rounding difference.
- **Every figure states its source** underneath it — which DEM, what grid spacing, how many years
  of record, how far the model cell is from your click, whether the flow came from the network or
  a cache.
- **Modelled is not measured.** GloFAS is a model. It is labelled as one.
- **DEM error is real.** Global terrain carries roughly ±10–16 m of vertical error in steep
  ground, which is stated next to the head it produced.

## Assumptions you control

Design flow exceedance (Q15–Q85), overall efficiency, head loss, residual flow as a share of the
driest month, and the household figure used for the plain-language comparison. All live.

## Quickstart

```bash
npm install
npm run dev      # http://localhost:5173
npm run check    # 86 assert-based checks
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

## Data sources

| Source | Access | Licence | Powers |
|---|---|---|---|
| GloFAS v4 via Open-Meteo | runtime, keyless, CORS ✓ | CC-BY 4.0 | Daily discharge, 20 years, worldwide |
| Re:Earth Terrain (Mapterhorn / Copernicus GLO-30) | runtime, keyless, CORS ✓ | CC-BY 4.0 | Elevation profile and head |
| AWS Terrain Tiles | runtime, keyless, CORS ✓ | public domain / attribution | Hillshade, and DEM fallback |
| OpenFreeMap / OpenMapTiles / OSM | runtime, keyless | ODbL | Basemap |
| HydroRIVERS v1.0 extract | bundled, 525 KB gz | HydroSHEDS licence | Catchment area, click snapping, the cross-check |
| DoED licence registry via Open Data Nepal | runtime, keyless, CORS ✓ | CC BY-SA | Which projects already hold this river |

Every runtime endpoint had its `access-control-allow-origin` verified with a real request — see
[docs/research/](docs/research/).

## What this is not

Screening, not a feasibility study. It is enough to rank ideas and decide what to survey next; it
is not a basis for investment, licensing or design. The waterway is measured along the river, not
routed as a canal or tunnel — no alignment, cover or portal has been designed. Nothing is costed.
Geology, sediment and hazard exposure are not yet in the model.

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

[MIT](LICENSE). Bundled data keeps its upstream licence.
