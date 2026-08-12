# Nepal-First Open Hydropower Engineering Workbench — Build Plan

> Source vision: `Nepal_First_Open_Hydropower_Engineering_Workbench.docx` (21 sections, digested below).
> This plan turns that vision into a staged, honest build. It reuses the validated pieces of the
> previous RiverPower app (physics kernel, Nepal datasets, Phase 1 CORS research) and deletes the rest.
> All supporting research is complete and live-verified (2026-08-12); full evidence in
> `docs/research/2026-08-12-{stack,data-hunt,algorithms}.md`.

---

## 1. What we are building (vision digest)

A **digital hydropower engineer's workspace** for early project development in Nepal. Not another
potential calculator, not another GIS viewer. The loop it must close:

1. Open Nepal, zoom to a valley, click a river reach / watershed / corridor.
2. See the full hydropower context: terrain, catchment, existing projects & licenses, gauges,
   transmission, roads, glaciers & glacial lakes, landslides, faults, protected areas.
3. Ask for alternatives → the engine generates **complete schemes** (intake → desander → headrace →
   forebay/surge → penstock → powerhouse → tailrace, plus access road and grid corridor), not dots
   on a slope map.
4. Compare them as a **Pareto set** (energy, cost, tunnel length, hazard exposure, grid distance,
   robustness) — never one mysterious score.
5. Inspect the serious ones in a **longitudinal profile** (ground, invert, HGL, tunnel cover,
   crossings, warnings) and a **3D scene** (fly the valley, underground mode for tunnels).
6. Stress-test against dry flows, cost escalation, hazard scenarios. See **why** a scheme wins.
7. Click any number → full provenance chain (what produced it, which source, what confidence).
8. Leave with a decision and a **prioritized list of what to investigate next** — the missing
   information most likely to change the decision.
9. Later: bring field observations, surveyed cross sections, drone DTMs and measured flows back
   into the *same* project and watch every dependent number update.

**The defining capability is #3–4: automatic discovery of complete, comparable project schemes.**

The vision explicitly demands: evidence-based hydrology (multiple methods, disagreement visible),
progressive analysis (screening → 1D → 2D → CFD only when justified), sediment and headworks as
first-class citizens, uncertainty visible everywhere, auditability of every number, and honesty
about data quality (reconnaissance vs surveyed, measured vs modelled vs assumed).

---

## 2. Hard constraints and architecture decisions

### 2.1 Static-first, still no backend

The original constraint stands and is what makes this deployable free and forever:
**browser-only static app. No backend, no API keys, no env vars.** Two data patterns:

- **Build-time pipeline** (`pipeline/` scripts, run on a dev machine): bulk-download open datasets,
  process into compact static assets (`public/data/…`), commit or attach them. This is how
  `nepal-rivers.dat` (524 KB gz, 42k reaches) and the DHM station catalog already work — the model
  scales to every Nepal layer.
- **Runtime fetch** from public CORS-enabled APIs (GloFAS discharge, NASA POWER, USGS quakes,
  terrain tiles). Every runtime source was CORS-verified with real probes in Phase 1
  (`docs/research/PHASE1-REPORT.md`).

What this excludes — and how the vision still gets served:

| Vision item | Can't run in browser | Our answer |
|---|---|---|
| OpenDroneMap processing | Yes — heavy photogrammetry | User runs ODM/WebODM locally; we **import** its outputs (GeoTIFF DTM/orthophoto) client-side via geotiff.js |
| OpenFOAM CFD | Yes | We **export** a geometry/boundary-condition package and **import** result summaries; plus an explicit "CFD not justified" advisor |
| DHM paid discharge records | Licensing, not tech | Import path for user-purchased CSVs; provenance marks them `measured` |
| 2D shallow-water river hydraulics | Feasible but hard | WebGL local-inertial solver, staged late (M7), scoped to small local grids |

### 2.2 Two map engines, one lazy

- **MapLibre GL 5** stays the primary 2D planning map — fast, light (~285 KB gz), already tuned
  (terrain tile budget work from the perf pass carries over).
- **CesiumJS 1.144** powers the 3D scene — the only serious open path to Google-Earth-style
  flythrough with **underground/translucent-terrain mode** (`Globe.translucency`, verified in
  current docs). It is heavy (~1.7 MB gz), so it is **code-split and loaded only when the user
  enters 3D**. Terrain without API keys — verified live 2026-08-12: primary is **Re:Earth Terrain**
  (`terrain.reearth.land`), a global keyless quantized-mesh endpoint with `ACAO: *` (Mapterhorn /
  Copernicus GLO-30, CC-BY-4.0, zoom ≤14); fallback is `@macrostrat/cesium-martini` meshing the
  AWS Terrarium tiles at runtime; long-term self-host option via cesium-terrain-builder docker.
  Full evidence: `docs/research/2026-08-12-stack.md`.
- Both views bind to one project store; camera sync when switching.

### 2.3 Provenance is core plumbing, not a feature

Every computed value in the system is a `Traced<T>`:

```ts
type Traced<T> = {
  value: T; unit: Unit;
  method: string;                    // 'dem-sample' | 'glofas' | 'hydest' | 'user-override' | …
  quality: 'measured' | 'modelled' | 'estimated' | 'assumed' | 'overridden';
  inputs: TraceRef[];                // edges of the evidence graph
  note?: string; at: IsoDate;
};
```

Clicking any number opens the evidence tree (the doc's "clicking Net head = 417.3 m" example).
Manual overrides are never destructive — the prior value and the override both persist, with the
reason. **This must exist from M0; retrofitting provenance is impossible.**

### 2.4 Project file, local-first

A project is one versioned JSON document (schema `workbench-project@1`): area of interest, selected
reaches, hydrology sources + choices, generated schemes, overrides/decision log, field observations,
imports registry. Autosaved to localStorage/OPFS; saved/loaded to disk via the File System Access
API (with download fallback). No accounts, no cloud — a project file emails like a spreadsheet.

### 2.5 Compute in workers

Scheme search, hydrology statistics, hydraulics and scenario sweeps run in **Web Workers**
(comlink RPC) so the map never jangles. The physics kernel stays pure TypeScript
(`src/engine/…`), testable by the same assert-runner as today's `hydro.check.ts` (36 checks pass;
that file grows with every new formula).

### 2.6 Naming

"RiverPower" described a screening toy. Proposal: **Ghatta** (घट्ट — the traditional Nepali water
mill) — short, Nepali, hydropower-rooted; subtitle "open hydropower engineering workbench".
Alternatives: *Prabaha* (प्रवाह, flow), or plain *Hydro Workbench*. Trivial to change; the plan
uses "the workbench" throughout.

---

## 3. What we keep, what we delete

Checkpoint first: commit current working tree to `master` ("checkpoint: RiverPower final state")
so nothing is ever lost — git history is the archive.

### Keep (data, pipeline, validated physics, evidence)

| Path | Why |
|---|---|
| `public/nepal-rivers.dat` | HydroRIVERS Nepal extract, 42,197 reaches, validated vs 5 published catchments (±7%) |
| `scripts/build-hydrorivers.mjs` → `pipeline/` | Regenerates the above |
| `src/dhm-stations.json` → `public/data/` | 1,115 DHM hydro/met stations |
| `scripts/build-dhm-stations.mjs` → `pipeline/` | Regenerates the above |
| `src/hydro.ts` → `src/engine/hydro.ts` | The validated physics kernel (P = ρgQHη, FDC, turbine constraints, residual bases, wet/dry split; Chilime back-check) |
| `src/hydro.check.ts` → `checks/` | 36 passing assert checks — the seed of the validation suite |
| `PHASE1-REPORT.md`, `phase1-raw-probes.json` → `docs/research/` | 136-endpoint CORS evidence base |
| `LICENSE` (MIT), `.gitignore`, `.claude/launch.json` | Fine as-is |

### Delete

| Path | Note |
|---|---|
| `src/App.tsx`, `src/api.ts`, `src/styles.css`, `src/charts.ts`, `src/main.tsx`, `index.html` body | Old app. Salvage list below is cherry-picked from git history when needed |
| `docs/*.png` | Screenshots of the dead UI |
| `scripts/shots.mjs`, `scripts/perf.mjs` | Coupled to the dead UI; rewritten later against the new one |
| `dist/`, `tsconfig.tsbuildinfo`, `.codex-dev.*.log` | Build artifacts / logs |
| `.openai/`, `.gstack/` | Codex tool exhaust (hosting config + self-graded QA reports) |
| `README.md` | Rewritten for the workbench |
| `public/riverpower-social.webp` | Old branding |

### Salvage from git history when the milestone needs it (do NOT rewrite from scratch)

- GloFAS fetch with cell-quantized localStorage cache, in-flight coalescing, `Retry-After` cooldown
- Terrarium tile decoder + elevation profile sampler with tile budget
- Nepal point-in-polygon outline; DHM nearest-station lookup; Open Data Nepal DoED projects fetch
  (becomes a build-time snapshot instead of runtime)
- Nearest-reach + main-stem detection logic (the 4,500× tributary bug fix)

---

## 4. Data plan

Legend: **HAVE** = in repo/validated · **RUNTIME** = CORS-verified public API (real probes,
2026-08-12, `docs/research/2026-08-12-data-hunt.md`) · **BUILD** = build-time pipeline output.
All research questions are resolved; remaining verifications are marked inline.

### 4.1 Terrain & imagery

| Dataset | Access | Status | Powers |
|---|---|---|---|
| AWS Terrarium DEM tiles (`elevation-tiles-prod`) | RUNTIME, CORS ✓, keyless | HAVE | Elevation profiles, head, cross sections, tunnel cover |
| Re:Earth Terrain (quantized-mesh + Terrarium + Terrain-RGB) | RUNTIME, CORS ✓, keyless | VERIFIED | Cesium 3D terrain (primary), MapLibre hillshade |
| OpenFreeMap vector basemap | RUNTIME, CORS ✓, keyless | HAVE | 2D basemap incl. waterway layer |
| Esri World Imagery | RUNTIME, keyless w/ attribution | HAVE | Satellite layer 2D + 3D draping |
| Client-side contours (maplibre-contour 0.1.0) | derived at runtime | VERIFIED | Contour layer, no server |
| SRTM/Copernicus vertical error model (±10–16 m steep terrain, literature) | constant | — | Head confidence bands |

### 4.2 Water

| Dataset | Access | Status | Powers |
|---|---|---|---|
| HydroRIVERS Nepal extract (42k reaches + upstream area) | BUILD (done) | HAVE | River network, reach selection, catchment area at click |
| HydroBASINS Asia level-12, Nepal window (≈3–4k polygons incl. transboundary headwaters → few MB; license free incl. commercial w/ attribution) | BUILD | SIZED | Watershed polygons; upstream set via **`NEXT_DOWN` transitive closure** (not Pfafstetter arithmetic — unreliable per TechDoc; `SORT` field gives recursion-free sweeps) |
| Open-Meteo GloFAS daily discharge (1984→) | RUNTIME, CORS ✓ | HAVE | Modelled flow series anywhere (labelled modelled) |
| DHM station catalog (1,115) | BUILD (done) | HAVE | Gauge context, catchment-transfer anchors, "what record exists" |
| **GHSA v2504** (Zenodo 15258773, CC BY 4.0, 784 MB): observed South-Asia streamflow 1950–2023 incl. Nepal stations | BUILD | VERIFIED | Measured calibration anchors (Karnali@Chisapani, Sapta Kosi, …) for GloFAS bias + FDC validation |
| **Bipad `/api/v1/river/` + `/rain/`** — DHM real-time levels/rain mirror | RUNTIME, CORS ✓ | VERIFIED | Live river levels at stations (context, not FDC input) |
| **WECS/HYDEST 1990 + Modified 2004 + MHSP 1997 coefficients** | constants | **RECOVERED** — full tables in research doc; one MHSP 500-yr row needs cross-check vs DoED Guidelines 2006 | The canonical Nepali ungauged-flow methods, pure client-side |
| NASA POWER precipitation (MERRA-2) | RUNTIME, CORS ✓ | HAVE | Catchment wetness context (known mountain caveat) |
| CHELSA v2.1 precip normals (CC0), Nepal crop | BUILD | VERIFIED | MMP/MWI inputs for HYDEST/MHSP + water balance. (WorldClim rejected: NC terms) |

### 4.3 Nepal hydropower context

| Dataset | Access | Status | Powers |
|---|---|---|---|
| DoED registry: Open Data Nepal mirror (572 rows w/ lat-lon, CORS ✓) **but snapshot is 2025-07 (~13 mo stale)** | BUILD snapshot | VERIFIED | Existing/proposed projects + licenses |
| **rmsdoed.gov.np PlantIndex/EnergyDetailIndex** (DoED royalty system, public HTML tables, current) | BUILD scrape | FOUND | Patches the stale mirror: current operating fleet, capacity, COD, per-FY energy |
| GEM Global Hydropower Tracker Mar-2026 (CC BY 4.0, ~272 Nepal entries ≥30 MW w/ coords + status) | BUILD | VERIFIED | Pipeline landscape + cross-check |
| Curated benchmark DB (Chilime + the four below + more from rmsdoed/NEA reports) | BUILD | NUMBERS IN HAND | Project memory + physics validation |
| NEA wet/dry PPA tariffs (4.8/8.4 NPR + escalation) | constants | HAVE (re-verify current rates at M3) | Revenue model |

### 4.4 Hazards & environment

| Dataset | Access | Status | Powers |
|---|---|---|---|
| ICIMOD glacial lakes 2020 (3,624) + 47 PDGL list — **CC BY 4.0 confirmed**, free-login download | BUILD | VERIFIED | GLOF sources, upstream hazard connectivity. No-login alt: Hi-MAG (Zenodo, CC BY) |
| GEM Global Active Faults (CC BY-SA, 12.3 MB→Nepal clip) + HimaTibetMap (ODC-By, 630 KB) | BUILD (GitHub raw also CORS ✓) | VERIFIED | Fault crossings on alignments & profile |
| Macrostrat geology point + tiles | RUNTIME, CORS ✓ | VERIFIED (coarse ~1:5M over Nepal — labelled) | Lithology at click |
| **Bipad portal `/api/v1/incident/`** (live gov hazard DB: landslide/flood/quake/GLOF/avalanche) | RUNTIME, CORS ✓ | VERIFIED (June-2026 data present; paginate via `next`, ignore bogus `count`) | Live incident overlay |
| Landslide inventories: HDX GLC snapshot (3.6 MB, ≤2019) + NSIDC HMA catalogs (Earthdata login) | BUILD | VERIFIED (NASA live GLC service is dead) | Historical landslide layer |
| USGS FDSN earthquakes | RUNTIME, CORS ✓ | HAVE | Seismicity context |
| Seismic hazard: GEM GSHM v2023.1 is **CC BY-NC-SA → cannot bundle**; synthesize qualitative layer from quakes + faults instead, link out to GEM | derived | DECIDED | Seismic context per site |
| Protected areas from **OSM** (WDPA terms prohibit redistribution — rejected) | BUILD (Geofabrik) | DECIDED | Environmental constraint layer |
| ESA WorldCover 10 m (CC BY, 104 MB/tile, ~9 tiles, S3 has **no CORS**) | BUILD only | VERIFIED | Forest/land-cover conflicts, erosion proxies |
| Sediment proxies (slope, glacier fraction, monsoon erosivity + literature basin yields) | derived | — | Sediment risk score (clearly `estimated`) |

### 4.5 Infrastructure

| Dataset | Access | Status | Powers |
|---|---|---|---|
| Geofabrik `nepal-latest.osm.pbf` — 393 MB, **updated daily** (verified), ODbL | BUILD (osmium tags-filter → few MB GeoJSON) | VERIFIED | Grid lines/substations, roads, settlements, bridges — replaces flaky runtime Overpass |
| OSM waterway details (weirs, existing intakes) | BUILD (same extract) | VERIFIED | Headworks context |

**Format strategy for BUILD outputs:** small layers → gzipped GeoJSON or our delta-int16 `.dat`
packing; large/spatial-query layers → **FlatGeobuf** (HTTP-range spatial subsets off static
hosting) or **PMTiles** (tile pyramids, also the offline field-mode container) — both verified
against Vercel's CDN (206 range responses), see §10.1.
Every asset gets a row in `public/data/manifest.json`: source URL, license, retrieved date,
processing script, checksum — this manifest *is* the bottom layer of the provenance system.

---

## 5. The engine — algorithms and models

### 5.1 River sampling & head

- Merge selected HydroRIVERS reaches downstream; sample chainage every 100 m.
- Elevation per sample from terrain tiles (bilinear); enforce downstream monotonicity with
  isotonic regression (PAVA) — raw DEM river profiles are bumpy and bumpiness is fake head.
- Head confidence: DEM vertical RMSE propagated to a head range, shown as ± on every scheme.

### 5.2 Scheme discovery (the defining feature)

Search space per corridor, in a worker:

1. **Candidates:** intake points × powerhouse points downstream (0.5–15 km), pruned by minimum
   gross head (≥ 10 m) and minimum power (≥ 100 kW).
2. **Waterway families** per pair: (a) canal-dominant: contour-following canal at ~1:1000 on a
   chosen bank + penstock plunge; (b) tunnel-dominant: direct tunnel to a forebay/surge point
   above the powerhouse + penstock; (c) full pressure tunnel where cover allows. Tunnel cover
   sampled from DEM every 100 m; reject/flag where cover < 30 m or > 1,000 m.
3. **Design discharge alternatives:** Q30/Q40/Q50/Q65 from the FDC, minus environmental flow
   (default: 10 % of minimum monthly mean — Nepali practice, editable, provenance-labelled).
4. **Net head:** gross − Manning losses (canal) − Darcy–Weisbach (tunnel/penstock,
   Swamee–Jain friction factor) − minor losses (fitted coefficients).
5. **Turbine:** type via point-in-polygon on the **HydroGenerate (Q,H) envelopes** (BSD-3,
   exact vertices in the research doc) cross-checked against ESHA head ranges & specific-speed
   correlations; 1–3 units; **RETScreen efficiency curves per type** (full formulas recovered;
   two HydroGenerate transcription bugs identified — we port the published forms); min/max
   operating flow, daily dispatch over the flow series → monthly/annual/dry/wet energy, spill,
   plant factor.
6. **Quantities:** excavation & lining from section × length; penstock steel from hoop stress
   (static + transient surcharge); access road = terrain-weighted distance to nearest OSM road;
   transmission = distance to nearest line/substation.
7. **Cost & economics:** editable Nepal unit-rate table × quantities, anchored to the verified
   2025–26 band **NPR 170–240 Mn/MW (≈ USD 1.25–1.8 M/MW)** with component % splits (no public
   itemized breakdown exists — splits ship as editable `assumed` values); CAPEX by component,
   O&M %, revenue via the **verified current PPA** (wet 4.80 / dry 8.40 NPR·kWh⁻¹, 3 % simple
   escalation × 8 from COD+12 mo, seasons Jun–Nov/Dec–May for new PPAs, ~10 % wet take-and-pay
   reserve, 30-yr term, ≥ ~30 % dry-energy requirement in new PPAs, 10+5 yr tax holiday);
   NPV/IRR/payback/LCOE. All outputs `quality: 'estimated'`, class-5 (±40 %) and labelled so.
8. **Constraint flags:** dewatered reach length, protected-area intersection, fault/landslide
   crossings, GLOF connectivity upstream of intake, cascade overlap with existing licenses.
9. **Selection:** non-dominated (Pareto) filter over energy, CAPEX, specific cost, tunnel length,
   hazard score, grid distance; cluster survivors into the doc's "alternative families"; keep ~20
   with a one-paragraph generated explanation of *why each survives* (which objectives it wins).

Prior art (mined, source-read — details in `docs/research/2026-08-12-algorithms.md`): GRASS
`r.green.hydro.optimal` proves the shape works (brute-force grid over intake×length maximizing
head-drop × intake-flow, recursive river tiling) but scores without losses or residual flow —
ours improves it inside the same search. Its `structure` module independently arrives at our
canal family: **channel = contour-following segment, penstock = shortest plunge from the contour
point nearest the powerhouse** — we adopt that construction. GPL code is not translated;
algorithms are reimplemented from the published method. Penstock sizing: ESHA
`D = 2.69·(n²Q²L/H)^0.1875` default, velocity-limit + Bondschu cross-checks, PV-optimal D-sweep
as refined mode.

### 5.3 Hydrology evidence stack (never one number)

For any site, compute and display side-by-side, each with method + confidence:

1. GloFAS modelled daily series (bias noted; 3×3 channel-cell probe kept from RiverPower;
   bias-checkable against GHSA observed records where a station matches)
2. Catchment-area transfer from DHM stations on the same/similar river (`Q_site = Q_st·(A_site/A_st)^n`)
3. **WECS/HYDEST 1990** monthly regression — full coefficient table recovered
   (`Q_mon = C·A^A1·(A₍<5000m₎+1)^A2·MMP^A3`, MMP from CHELSA), plus HYDEST/Modified-HYDEST
   flood formulas (Q₂/Q₁₀₀ power laws in A₍<3000m₎)
4. **MHSP 1997** monthly + regional flood regressions — coefficients recovered (one 500-yr row
   flagged for cross-check against DoED Guidelines 2006)
5. User-imported series (CSV) → `measured`, takes precedence visually
- Outputs: FDC **band** (not line) across methods, monthly means with ranges, dependable flow
  (Q90/Q95), disagreement metric surfaced when dry-season estimates diverge materially — and that
  disagreement propagates into energy ranges and scheme ranking.
- Flood context: Gumbel/GEV fit on annual maxima where a usable series exists, labelled.

### 5.4 1D hydraulics (serious alternatives)

Segment graph intake→tailrace, formulas now locked (research doc §§3,6,8): Manning open-channel;
Darcy–Weisbach pressurized with **Swamee–Jain** friction factor (OpenHPL's exact scheme incl.
laminar/bridge regimes); local losses; HGL polyline on the profile; static + operating pressure
per node; surge first cut = Thoma criterion + OpenHPL's open/orifice tank ODEs (rigid-column
mass oscillation, RK4 in a worker); water hammer first cut = **Joukowsky with elastic wave speed
`a = √((K/ρ)/(1+(K/E)(D/e)c₁))`, Michaud for slow closure**, full **MOC** (dx = L/N, dt = dx/a,
C± sweep, TSNet-style module layout — MIT reference) as the advanced tier in M5+; turbine
operating window enforcement; part-load efficiency via the RETScreen curves.

### 5.5 Uncertainty, scenarios, investigation priorities

- Confidence per domain (terrain/hydrology/sediment/geology/grid/cost) rolled up per scheme.
- Scenario engine: dry-year (P10), −25 % dry-season flow, +40 % tunnel cost, +2 m tailwater,
  climate-stress preset. Re-rank under each; **ranking stability** displayed.
- One-at-a-time sensitivity → tornado chart per scheme.
- **Investigation priorities:** for each uncertain input, sweep its range, measure Pareto-membership
  flips among leaders → ranked list mapped to concrete actions ("obtain DHM station X record",
  "survey powerhouse terrace", "geological mapping at km 2.1–2.6 fault crossing"). This implements
  doc §16 honestly with OAT sensitivity, upgradeable later.

### 5.6 Explicitly staged later

2D shallow-water (M7): **verdict in — feasible with margin.** No JS local-inertial solver exists
anywhere; we write the ~150-line kernel fresh from the published Bates/de Almeida equations
(recovered in the research doc), borrow ping-pong/render plumbing from WebFlood (MIT), and
validate against Wflow.jl (MIT) on a synthetic dam-break. 512² grids run real-time even on CPU
workers; GPU is comfort. Also staged later: MOC transients UI tier · cascade optimizer across a
corridor · sediment settling design beyond screening scores. The CFD advisor ships early though:
a rule-based "3D CFD is / is not justified here" note per headworks, per doc §6.

---

## 6. UI/UX plan

### 6.1 Workbench layout (not a scrolling page anymore)

- **Left:** map/scene area with 2D ⇄ 3D toggle, layer switcher, time/scenario scrubber.
- **Right rail:** context panel (site → evidence → schemes → compare), resizable.
- **Bottom drawer:** longitudinal profile / cross sections / charts, resizable, collapsible.
- **⌘K command palette:** jump to river/basin/project/station by name ("Kabeli", "station 620").
- Phone: stacked with bottom-sheet panels; field mode is a trimmed route of the same app.

### 6.2 Design language

Dark, instrument-like, engineering-first (the user rejected the light "brochure" look). Dense
tables with units, provenance chips (`measured` green / `modelled` blue / `estimated` amber /
`assumed` grey / `overridden` purple) everywhere, prefeasibility disclaimer *next to numbers*, not
in a footer. Motion: subtle, `prefers-reduced-motion` respected (original brief), no decorative
animation on data.

### 6.3 Libraries — verified 2026-08-12 (versions live-checked; details in §10.1)

| Role | Choice | Version | Note |
|---|---|---|---|
| 2D map | MapLibre GL (kept) | 5.x | v6 is ESM/WebGL2-only; migrate later, not now |
| 3D | CesiumJS raw (no resium), lazy chunk | 1.144.0 | Integrate via official cesium-vite-example pattern (`vite-plugin-static-copy` + `CESIUM_BASE_URL`); vite-plugin-cesium is stale — skip |
| 3D terrain | Re:Earth Terrain quantized-mesh (keyless, CORS ✓) | — | Fallback: `@macrostrat/cesium-martini` 1.6.0 + AWS Terrarium |
| Charts | ECharts, modular `echarts/core` imports | 6.1.0 | Parallel coords, brush, dataZoom, tornado all built in |
| Long profile | **Bespoke** SVG/canvas component | — | The signature view; custom-code budget goes here |
| Contours | maplibre-contour | 0.1.0 | Client-side from Terrarium tiles; pre-1.0 API risk accepted |
| UI kit | shadcn/ui + Tailwind v4 | 4.3.3 | React 19 officially supported |
| Panels/palette/toasts | react-resizable-panels · cmdk · sonner | 4.12.2 · 1.1.1 · 2.0.8 | |
| Drawing | terra-draw + maplibre adapter | 1.32.3 | Sketch AOIs/corridors/manual alignments |
| Motion | `motion`, `MotionConfig reducedMotion="user"` | 13.1.0 | |
| State | zustand + zundo (undo/redo) + persist | 5.0.14 + 2.3.0 | |
| Workers | comlink | latest | |
| Geo/data | turf (modular) · flatgeobuf · pmtiles · geotiff · martini/delatin | — · 4.4.0 · 4.5.0 · 3.0.5 · 0.2.0 | Vercel range requests verified (206) — FGB/COG/PMTiles work from `public/` |

---

## 7. Milestones

Each milestone ends with: `tsc` clean · `npm run check` green (suite grows every milestone) ·
production build · **real-browser verification with screenshots** · README section updated.
Rough effort: 1–3 working sessions each.

- **M0 — Reset & skeleton.** Checkpoint commit; execute §3 delete/keep; new scaffold (Vite + React 19
  + TS strict + Tailwind + shadcn); workbench layout shell; zustand store; `Traced<T>` provenance
  core + evidence-tree panel primitive; worker plumbing; data manifest; CI scripts.
  **Status 2026-08-12: DONE ahead of schedule** — reset executed, workbench UI built and
  browser-verified (map + rail + tabs + bespoke long profile + Ctrl-K + lazy Cesium 3D on keyless
  Re:Earth terrain + provenance popovers + mobile), typecheck/36 checks/prod build green.
  Deferred from M0 to their milestones: comlink worker plumbing (first needed M2), data manifest
  (first data pipeline, M1).
- **M1 — Nepal atlas & site context.** Build-time pipeline v1 (OSM extract → grid/roads; ICIMOD
  lakes; faults; DoED+GEM projects; protected areas; landslides; HydroBASINS). Layer system with
  the doc's 2D layer list; click reach → context panel: catchment, hydrology evidence stack v1
  (GloFAS + catchment transfer + HYDEST), nearby stations/projects/hazards, grid & road distance.
  *Acceptance: click Kabeli river → defensible context card, every number provenance-chipped.*
- **M2 — Scheme discovery.** §5.2 engine in worker; alternatives drawn on map; Pareto panel +
  compare table + family grouping; constraint flags. *Acceptance: a corridor on the Nyadi or
  Kabeli generates families whose best member is within sanity range of the real project's
  head/flow/capacity, and the "why it survives" text is right.*
- **M3 — Profile, hydraulics, energy, money.** Bespoke long profile (ground/invert/HGL/cover/
  crossings/warnings); cross-section view (terrain-derived, marked reconnaissance); 1D losses;
  turbine curves + dispatch → monthly/dry/wet energy; quantities → CAPEX → NPV/LCOE; drag intake/
  powerhouse on profile → live recompute. *Acceptance: Chilime + Upper Tamakoshi back-checks in
  the check suite pass through the full new pipeline (not just the kernel).*
- **M4 — 3D scene.** Cesium lazy module; keyless terrain; schemes as 3D primitives (tunnel tubes,
  penstock, powerhouse, TL line); underground mode; valley flythrough; hazard overlays in 3D.
- **M5 — Uncertainty & audit.** Scenario engine + ranking stability + tornado; investigation
  priorities; provenance polish (every displayed number clickable); report export (printable
  audit pack) + CSV/GeoJSON; decision log UI.
- **M6 — Field & imports.** PWA offline region (PMTiles download); GPS observations, geotagged
  photos/notes, accept/reject per component; import: hydrology CSV, survey points CSV, GeoTIFF
  DTM (geotiff.js) with **old-vs-new terrain diff** driving recompute; project memory library
  (curated benchmark DB browsable).
- **M7 — Frontier (stretch).** WebGL 2D shallow-water for headworks/flood patches; MOC transients;
  cascade/corridor optimizer; ODM/OpenFOAM interchange formats.

---

## 8. Validation & proof culture (unchanged from the original brief)

- Assert-based check suite runs in CI-less `npm run check`; every new formula lands with checks.
- Benchmarks (numbers verified, sources in research doc): Chilime 22.1 MW (validated already),
  **Upper Tamakoshi 456 MW / 822 m / 66 m³/s / 2,281 GWh · Kabeli A 37.6 MW / ~117 m /
  37.73 m³/s / ~205 GWh · Nyadi 30 MW / 333.9 m / 11.02 m³/s / 168.55 GWh · Rasuwagadhi
  111 MW / 167.9 m / 80 m³/s / 613.875 GWh** — all close P = ρgQHη at η ≈ 0.83–0.90.
- Unit traps stay the top hazard: m³/s vs ft³/s, kW/MW, GWh/MWh, gross-vs-net head, capacity vs
  plant factor — the existing 36 checks already cover several; keep growing.
- Never claim a UI works without loading it in the real browser, clicking it, screenshotting it.
- Performance budgets: initial JS < 350 KB gz (Cesium excluded, lazy), first paint < 3 s mid-phone,
  initial data < 3 MB, layer loads lazy + cached.

## 9. Risks & honest limits

- **License friction — verdicts now in:** ICIMOD glacial lakes turned out **CC BY 4.0** (good).
  The real rejects: **WDPA** (no redistribution → OSM protected areas instead), **WorldClim**
  (NC → CHELSA CC0 instead), **GEM seismic hazard raster** (CC BY-NC-SA → qualitative
  quakes+faults layer instead). GEM faults are CC BY-**SA** — share-alike applies to that derived
  data file, tracked in the manifest, fine alongside MIT code.
- **DHM measured flows are paid** — the single biggest data gap in Nepal hydrology; our answer is
  the evidence-stack + import path, stated plainly in the UI.
- **DEM is the head:** ±10–16 m vertical error in steep terrain is material for low-head schemes;
  we show it, and drone/survey import exists to fix it.
- **Scheme routing realism:** v1 routes are geometric heuristics with cover checks, not geotechnical
  routing; labelled reconnaissance, refined by the engineer via drag-editing.
- **Cost breakdown gap:** Nepal per-component unit rates (tunnel per-metre, E&M curves) are not
  publicly itemized anywhere we could verify — the model uses the verified per-MW band plus
  editable percentage splits, every one labelled `assumed`. This is honest and the doc's own
  standard ("replaceable by the user").
- **GPL hygiene:** r.green.hydro (GPL-2+), pysheds and uihilab's delineation (GPL-3) are
  algorithm references only — we reimplement from published methods; direct ports come only from
  BSD/MIT sources (HydroGenerate, TSNet, WebFlood plumbing).
- **Scope discipline:** the vision is a multi-year product; M0–M5 is the defensible core. Anything
  in §5.6 stays out until the core is proven.

---

## 10. Research findings

### 10.1 Frontend/3D stack — DONE, full report in `docs/research/2026-08-12-stack.md`

Decisions locked:
- **3D terrain needs no key:** Re:Earth Terrain serves global quantized-mesh with `ACAO: *`
  (live-verified incl. a Nepal tile); runtime fallback `@macrostrat/cesium-martini` over AWS
  Terrarium; self-host escape hatch via cesium-terrain-builder docker. Abstract the terrain
  source — Re:Earth is young and SLA-free.
- **Cesium 1.144 raw** (no resium), official Vite integration pattern, lazy-loaded ~1.7 MB gz
  chunk. `Globe.translucency` + collision-off camera = the underground mode.
- **ECharts 6.1** for all standard charts (modular imports); bespoke long profile.
- **shadcn/ui + Tailwind 4.3.3 on React 19** — officially supported combination.
- **Vercel static hosting verified** to serve range requests (206) — FlatGeobuf/PMTiles/COG from
  `public/` work; offline field mode = user downloads `.pmtiles` + `FileSource`/OPFS (service-worker
  caching of ranged responses is unreliable — avoided).
- Bonus find adopted: **terra-draw** for corridor/AOI sketching.
- Dead ends confirmed: Cesium ion (token even free), MapTiler (key), vite-plugin-cesium (stale),
  PMTiles→Cesium adapter (nonexistent), ctod (needs server).

### 10.2 Dataset hunt — DONE, full report in `docs/research/2026-08-12-data-hunt.md`

Headlines (all live-verified today):
- **HYDEST + MHSP recovered.** Full coefficient tables for Nepal's canonical ungauged-flow
  methods (WECS/DHM 1990 monthly + floods, Modified HYDEST 2004, MHSP 1997 monthly + regional
  floods) extracted from open literature — implementable as pure client-side math. One MHSP
  flood row needs a cross-check against DoED Guidelines 2006.
- **Bipad portal** (`bipadportal.gov.np/api/v1/…`) sends CORS `*` and is actively updated:
  landslide/flood/quake/GLOF incidents **plus real-time DHM river levels and rainfall**. The
  single best runtime find.
- **Observed streamflow exists openly**: GHSA v2504 (Zenodo, CC BY 4.0) carries Nepali station
  records 1950–2023 — measured anchors to calibrate GloFAS and validate FDCs.
- **DoED registry**: our Open Data Nepal mirror is alive (CORS ✓) but 13 months stale;
  `rmsdoed.gov.np` public tables provide the current operating fleet to patch it.
- **GEM Hydropower Tracker Mar-2026**: ~272 Nepal entries with coordinates/status, CC BY 4.0.
- **Licenses settled**: ICIMOD lakes CC BY 4.0 ✓; rejected WDPA / WorldClim / GEM-seismic on
  terms, with chosen substitutes (OSM / CHELSA CC0 / derived quakes+faults layer).
- Dead ends documented: NASA live landslide service is gone, no CAMELS-Nepal exists, GRDC can't
  be redistributed, doed.gov.np lost its license tables (broken HTTPS too).
### 10.3 Algorithm prior art — DONE, full report in `docs/research/2026-08-12-algorithms.md`

Headlines (repos cloned and source-read, not summarized from READMEs):
- **Scheme search validated by prior art:** GRASS `r.green.hydro.optimal` uses exactly our shape
  (grid search over intake × plant-length maximizing drop × flow, recursive river tiling) —
  and its `structure` module derives canal = contour-follow + penstock = shortest plunge, which
  we adopt. It scores without losses/residual flow; our engine fixes that inside the search.
- **Turbine module is a solved problem:** HydroGenerate (BSD-3) ships exact (Q,H) selection
  polygons + full RETScreen efficiency-curve formulas — direct port, with two transcription bugs
  found and corrected against the published forms. ESHA specific-speed correlations + head
  ranges + best-efficiency table recovered as cross-checks.
- **1D module formulas locked:** Swamee–Jain friction (OpenHPL's scheme), rigid-column + surge
  tank ODEs, Joukowsky + elastic wave speed + Michaud first cut, full MOC recipe (dt = dx/a,
  C± sweep, TSNet MIT as template).
- **HydroBASINS correction:** upstream aggregation must use `NEXT_DOWN` transitive closure, not
  Pfafstetter arithmetic (unreliable per the official TechDoc); `SORT` enables recursion-free
  sweeps; Nepal window ≈ 3–4k level-12 polygons → a few MB.
- **2D flood solver: greenfield.** No JS local-inertial implementation exists; equations
  recovered and cross-verified; 512² feasible even on CPU. Write the kernel fresh (M7).
- **Money verified current:** PPA wet 4.80 / dry 8.40 + 3 %×8 escalation and its fine print;
  CAPEX band NPR 170–240 Mn/MW from 2025–26 rating reports; IRENA global sanity check.
  Component-level unit rates: publicly unavailable — modelled as editable splits.
- **Cesium underground recipe confirmed** incl. the trap that ground-clamped geometry cannot go
  subsurface (use absolute-height tube primitives) and the translucency + depth-test combination.
