# Taking HydroRecon to the United States — the data hunt

**Status: a source hunt, not a measurement.** Nothing below has been run through
the engine. Zero US numbers exist. What *has* been measured is **access cost** —
every "verified" row was probed with a live request on 2026-08-28 and the result
is quoted. Everything marked "unverified" is a search result and should be
treated as a claim, not a fact.

Read this next to CLAUDE.md's rule: nothing ships unless it was measured. This
file exists so the measuring can start from the right place.

---

## The one thing that changes

**Nepal's binding constraint does not exist in the United States.**

CLAUDE.md's central finding is that flow carries ~1.6× on an ungauged Nepali
catchment while head carries 3.4%, so "any effort spent on terrain is spent on
the wrong half of P = ρgQHη". That conclusion is a statement about **Nepal's
gauge network**, not about hydrology. It does not travel.

| | Nepal | United States | ratio |
|---|---|---|---|
| Gauge records the app holds | 136 DHM | **4,587 in California alone** (verified) | ~34× in one state |
| Longest record probed | ~40 y | **34,638 days = 95 y** at one gage (verified) | |
| Modelled daily flow | GloFAS ~5 km grid, 2006–2025 | **NWM on 2,776,734 actual river reaches, hourly, 1979–2023** (verified) | |
| Terrain under the intake | Copernicus 30 m, σ 6.6 m on head | **3DEP 1 m lidar** where flown (verified: 1 m, acquired 2018, at the test point) | 30× |
| Validation target | DoED *licensed* capacity, 193 plants | **EIA-923 metered monthly generation**, every plant ≥1 MW | measured vs. permitted |

The last row is the important one. **Nepal's fleet validation scores the engine
against what a developer was licensed to build. The US can score it against
what the plant actually generated, month by month, for decades.** That is not an
incremental improvement to the harness; it is a different kind of evidence.

So the US port is not "the same app with different files". The error budget
inverts, the arbitration logic (`flowchoice.ts`) loses most of its job, and the
three Nepali regressions have no counterpart worth carrying.

---

## Layer by layer

### Flow — the layer that changes most

| Source | What it gives | Access | Licence | Verified? |
|---|---|---|---|---|
| **USGS NWIS Daily Values** | Daily mean discharge (`00060`), ~11k active + ~28k historical sites | `waterservices.usgs.gov/nwis/dv/?format=json` — no key, no meaningful rate limit | Public domain | **Yes** — 34,638 days at one gage in one 2.5 MB call; CA 4,587 / CO 2,934 / WA 1,873 sites |
| **NOAA National Water Model v3.0 retrospective** | **Hourly** streamflow + velocity, **2,776,734 reaches × 385,704 hours (44 y)**, keyed by NHDPlus COMID; carries `gage_id`, `order`, `elevation`, lat/lon per reach | `s3://noaa-nwm-retrospective-3-0-pds` (us-east-1, **not** requester-pays), Zarr + NetCDF | **Open data, no restrictions** | **Yes** — read `.zmetadata`, pulled a chunk |
| **NHDPlus V2 EROM / VAA** | Per-flowline mean annual flow (`QAMA`), velocity, cumulative drainage area (`TotDASqKM`), slope, min/max elevation | Bulk download; also via `nhdplusTools` | Public domain | Unverified |
| **USGS StreamStats** | Per-state regression equations for mean flow, floods, 7Q10 — the direct analogue of Modified HYDEST | Service endpoint **404 from here** on all three hosts tried | Public domain | **No — service did not respond** |
| **USGS suspended sediment** (`80154`) | Sediment concentration; 1,593 stations with daily record, mean 5.3 y | NWIS | Public domain | Unverified |

**The sediment row deserves a note.** CLAUDE.md records that DHM measures
suspended sediment and does not release the series, so the Nepal app infers
sediment character from the share of catchment above 3,000 m and can produce
*no* sediment yield at all. USGS publishes it. The sediment section could stop
being basin geometry and start being a measurement.

#### The NWM chunking problem, measured

This is the one architectural decision that has to be made before anything else,
so it was measured rather than assumed.

`chrtout.zarr/streamflow` is `[385704, 2776734] int32`, chunked `[672, 30000]`.

| Measured | Value |
|---|---|
| One chunk, compressed on the wire | **3.8 MB** (from 80.6 MB raw — zstd at 21×) |
| Time to fetch one chunk | **2.8 s** |
| Chunk grid | 574 time-chunks × 93 reach-chunks = **53,382 chunks** |
| **One reach, full 44-year hourly record** | **574 chunk reads ≈ 2.2 GB ≈ 27 minutes** |
| Same 574 reads, amortised over the 30,000 reaches in the block | **73 KB and ~0.05 s per reach** |
| All CONUS, all reaches, 44 y hourly | ~**203 GB** |

**So NWM is unusable per-site on demand and cheap in bulk.** That is exactly the
shape of the GloFAS decision the project already made and already got right —
CLAUDE.md records that the local GloFAS store ended the rate limit and turned the
fleet from a 104-plant sample into the whole 193-plant population.

But 203 GB is not a 219 MB store, so the analogue needs one more step:

**Do not store the series. Store the curve.** The app almost never wants a raw
daily series — it wants the flow-duration curve, the monthly means, and daily
P90/P95. Annual energy computed by dispatching *down a duration curve* is exactly
equivalent to dispatching a series, and the seasonal split survives if the curve
is kept per month:

| Store design | Size, all 2.78 M CONUS reaches |
|---|---|
| Raw daily means, 44 y, f32 | 179 GB |
| **12 monthly FDCs × 17 exceedances + 12 monthly means, f32** | **~2.4 GB** |
| Annual FDC + monthly means only | ~322 MB |

The 2.4 GB option is a one-time 203 GB download and then a bundle the same order
as the existing Nepal cuts. **This is a proposal, not a result** — whether a
monthly FDC reproduces the app's dispatched energy to within its own uncertainty
has to be tested against the raw series before it is believed, and the design
flow sweep (17 exceedances on one layout) is the part most likely to disagree.

### River network, catchment and connectivity — MERIT's licence problem dies

| Source | Replaces | Access | Licence | Verified? |
|---|---|---|---|---|
| **NHDPlus HR / V2** | HydroRIVERS | Bulk, plus `nhdplusTools` | Public domain | Unverified |
| **NHDPlus `TotDASqKM`** | **MERIT Hydro** | In the VAA table | **Public domain** | Unverified |
| **USGS NLDI** (Network-Linked Data Index) | `connectivity.ts`, `cascade.ts`, `gauges.ts` | `api.water.usgs.gov/nldi/linked-data/…` — no key | Public domain | **Yes** |

**NLDI is the single biggest code deletion available.** One call from a gage ID
returned, at 200 km:

```
UT/flowlines : 4,099
UT/nwissite  :   127   upstream gages
UT/ref_dams  :    37   upstream dams
DM/flowlines :   202   downstream mainstem
basin        :   catchment polygon, on demand
```

It indexes 21 source layers to the river network, including `ref_dams`,
`wade_rights` (**water rights**), `npdes` (discharge permits), `GRAND`
reservoirs, and `HILARRI` (ORNL hydropower infrastructure). The app's whole
directed-walk machinery — the thing `connectUpstreamSources` does for glaciers
and lakes — is a hosted API here.

**A probe that looked like a bug and is worse than one.** Navigating from a bare
COMID first returned 1 flowline while the same navigation from
`nwissite/USGS-11407000` returned 4,099. Chased down: **no bug.** My test
coordinate sat 25 km off the mainstem and landed on COMID 8037407, a real
headwater tributary, and NLDI faithfully reported its one upstream flowline.
Queried at the gage's own coordinates the position lookup returns COMID 7968461
— exactly what the gage record says — and 4,099 flowlines.

**So the US inherits the mis-snap problem unchanged.** A click a few hundred
metres off the channel silently returns a headwater instead of the river, and the
answer is not an error, it is a plausible small catchment. That is precisely the
defect CLAUDE.md documents with **four separate rejected fixes** (wider main-stem
search, lower promotion threshold, model-flow arbitration, snapping to OSM), each
rejected for adding a rule that fires everywhere to fix something wrong in ~4% of
cases. **Read those comment blocks before touching this.** The one thing that is
genuinely different is that NHDPlus reach geometry is far better than
HydroRIVERS' ~500 m derivation, so the snap has more to work with — which is a
reason to re-measure, not a reason to assume it is solved.

**And the CC-BY-NC problem it was written to end turned out not to exist.**
This paragraph claimed MERIT's non-commercial licence as an unpriced liability,
following CLAUDE.md, which said so in four places. MERIT Hydro is dual-licensed
CC BY-NC 4.0 **or** ODbL 1.0 at the licensee's choice; ODbL is elected in
`LICENSE`, so commercial use was never blocked. What stands is the weaker point:
NHDPlus carries drainage area and is public domain, so in the US no licence
election is needed at all, and `checks/merit-vs-reach-area.mjs` — which priced
dropping MERIT as *nearly free but not provably free* — has no US counterpart.

### Terrain — a 30× resolution jump

| Source | What | Access | Licence | Verified? |
|---|---|---|---|---|
| **USGS 3DEP 1/3 arc-second (10 m)** | Seamless CONUS, RMSE ~0.82 m | `s3://prd-tnm` `StagedProducts/Elevation/13/TIFF/current/nXXwYYY/` | **Public domain** | **Yes** — listed the bucket, tiles present |
| **USGS 3DEP 1 m** | Lidar-derived, partial but wide coverage | Same bucket, `/1/` | Public domain | **Yes** — EPQS reported `resolution: 1`, acquired 2018 |
| **3DEP EPQS point query** | Elevation + resolution + acquisition date at a point | `epqs.nationalmap.gov/v1/json` — no key | Public domain | **Yes** |

Copernicus GLO-30 stays available as the cross-check source, so the
`screenTerrainSources()` two-source pattern survives unchanged — swap Mapterhorn
for 3DEP as primary and keep a second opinion.

Two consequences worth flagging honestly. **Head stops being a rounding error**
— σ 6.6 m on 30 m Copernicus is a different quantity from 1 m lidar, and the
pondage screen, which CLAUDE.md shows moving **20× per metre** on Mapterhorn at
Kulekhani, is exactly the measurement that a bare-earth 1 m DTM should fix
outright. **And the head row of the accuracy table is unsigned** (CLAUDE.md:
"dated, not signed"), so re-measuring terrain does not invalidate the fleet.

### Existing hydropower — this is where the US is unrecognisably richer

| Source | What | Licence | Verified? |
|---|---|---|---|
| **EIA-923** | **Monthly metered net generation, every plant ≥1 MW** | Public domain | Unverified (API needs a free key) |
| **EIA-860** | Nameplate capacity, prime mover, in-service date, per generator | Public domain | Unverified |
| **ORNL EHA** (Existing Hydropower Assets) | Every operating US hydro plant | DOE data use policy | Unverified |
| **ORNL HILARRI v4** | Crosswalk: NID dams ↔ EHA plants ↔ NHDPlus reaches ↔ NHD waterbodies | DOE data use policy | Unverified (but **indexed in NLDI**, verified) |
| **NID** (USACE) | **92,075 dams**, 70+ fields: height, storage, purpose, year, inspection | Public | Partial — service exists, my query was malformed |
| **FERC / PNNL Hydropower eLibrary** | Every FERC hydro docket, P-numbers, licences, exemptions, preliminary permits | Public | Unverified |
| **ORNL licensing timeline & cost dataset** | How long licensing actually took, and what it cost | DOE data use policy | Unverified |

**EIA-923 replaces the weakest link in the whole validation story.** CLAUDE.md is
careful that the fleet's licence-ratio metric is a proxy: 82% of plants "reaching
their licence at a buildable waterway" measures agreement with a *permit*, and
the file's own known-defects list attributes the 5.2% under-prediction tail to
published coordinates landing on tributaries. With metered monthly generation the
harness can score predicted vs. actual **energy**, and — because it is monthly —
score the **seasonal split directly** rather than through the 74-gauge dry-share
proxy harness.

**The NPD and NSD datasets are both a gift and a competitor.** ORNL has already
published a national screening of non-powered dams (~4 GW across 2,616 NPDs) and
of new stream-reach development. That is a published answer to the question this
app asks. Two honest readings, and both matter:

- It is a **validation set with independent methodology** — the single most
  valuable thing a screening tool can be checked against, and Nepal has no
  equivalent.
- It is **prior art**. The 2013 NPD dataset's own caveat is nearly verbatim this
  project's: estimates from non-directly-measured flow and head, not for
  engineering design. Being right where ORNL is right proves the engine works;
  being *different* needs a reason.

### Regulatory and environmental — new, and some of it is hard-stop

Nepal's app screens protected areas and prints licence neighbours. The US has
screens that are **legally dispositive**, not advisory:

| Source | Why it matters | Licence | Verified? |
|---|---|---|---|
| **National Wild & Scenic Rivers** (lines + segments) | **Section 7(a) forbids FERC from licensing any dam, conduit, powerhouse or transmission line on a designated river** — and limits projects upstream, downstream, and on tributaries | Public domain | Unverified |
| **PAD-US 4.1** | 436,000+ protected units, all agencies, incl. Wilderness | Public domain | Unverified |
| **USFWS Critical Habitat** | ESA consultation trigger | Public domain | Unverified |
| **FERC jurisdiction / QCHF path** | Conduit exemptions and the qualifying-conduit path are much cheaper routes | n/a — rules, not data | Unverified |
| **NABD / fish passage barriers** | Passage requirements drive cost | via USACE | Unverified |
| **Tribal lands (BIA)** | Separate consultation regime | Public domain | Unverified |

**Wild & Scenic is the first hard binary screen this app would ever have.** Every
existing screen is advisory — "this is a slope-stability site", "the scheme lies
outside every protected area". A designated reach is not a caution; it is a
refusal, and it should render as one. It is also the screen most likely to fail
open in the Nepal codebase's style, which is precisely the `glof.check.ts`
lesson: the safe branch is the one that renders, so the dangerous branch needs a
fixture on every run.

### Hazards, geology, land, climate

| Layer | Nepal | United States | Licence | Verified? |
|---|---|---|---|---|
| Landslides | BIPAD (settlement centroids — the 103-vs-13 problem) | **USGS Landslide Inventories v2.0** | **CC0** | Unverified |
| Flood | — | **FEMA NFHL** | Public | Unverified |
| Seismic | GEM PGA | **USGS NSHM** | Public domain | Unverified |
| Faults | GEM Global Active Faults | **USGS Quaternary Faults** + SGMC structures | Public domain | Unverified |
| Geology | DMG 1:1,000,000, 856 polygons, 12 unnamed codes | **USGS SGMC** — 48 state maps, 1:50,000–1:1,000,000, seamless, with a **GeMS update in 2026** | Public domain | Unverified |
| Land cover | ESA WorldCover 10 m | **Annual NLCD, 30 m, every year 1985–2024** | Public domain | Unverified |
| Rainfall | CHPclim ~5 km | **PRISM 800 m normals**, 4 km monthly | Free (attribution) | Unverified |
| Glaciers | RGI 7.0 region 15 | RGI regions 1–2 (AK, W. Canada/US) | CC-BY-4.0 | Unverified |
| Grid | OSM | **HIFLD transmission lines (open)**; **substations are restricted** | Mixed | Partial |

Three of these fix a named Nepal defect outright:

- **SGMC vs. DMG.** CLAUDE.md records that 29.6% of Nepal has *no polygon*, that
  12 of 57 units are bare codes the source will not expand, and that unit names
  are regional correlations a Nepali geologist would question. SGMC is seamless
  across 48 states at up to 1:50,000 — twenty times the scale — with a real
  legend.
- **PRISM vs. CHPclim.** The water-balance section blames residual spread on the
  fact that "a ~5 km climatology cannot resolve orographic gradients, its rain
  gauges sit in valleys". PRISM normals are 800 m and were built specifically to
  model orographic precipitation in mountainous terrain.
- **USGS landslides vs. BIPAD.** The hazard figure caught the report claiming
  "103 landslides — an actively failing corridor" when 39 of them sat on a single
  geocoding centroid 9.85 km away, because BIPAD files incidents against
  settlements. USGS inventories are mapped scars.

**HIFLD substations are restricted** and EIA explicitly does not publish
substation locations. So `grid.ts`'s interconnection distance would fall back to
OSM, which is the reverse of the usual US-beats-Nepal pattern and should be
stated in the report rather than quietly degraded.

---

## What gets harder, not easier

Honest counterweight — three things Nepal makes easy that the US does not.

1. **Water rights.** In the nineteen prior-appropriation states, physically
   available water is not legally available water. NLDI indexes `wade_rights`,
   which is a start, but this is state-by-state and there is no national
   authority. A screening tool that prints a design flow without acknowledging
   this is more wrong in the West than a 1.6× flow error ever was in Nepal.
2. **Everything is state-fragmented.** StreamStats regressions, instream flow
   rules, dam safety, and 401 water quality certification are all per-state. The
   Nepal app has one regulator and one regime.
3. **The FERC process dominates the schedule, and the app cannot model it.**
   ORNL's own licensing timeline dataset exists precisely because licensing, not
   construction, is the long pole. The right move is to *report the pathway*
   (conduit exemption / QCHF / 10 MW exemption / full licence) and refuse to
   estimate a duration — the same discipline `designflow.ts` already shows by
   supplying full-load hours and declining to supply an NPV.

---

## What dies, and what that means for the accuracy table

- **`modified-hydest.ts`, `hydest.ts`, `mhsp.ts`** — three Nepali regressions
  with no US counterpart. StreamStats is the analogue but is per-state and did
  not respond.
- **`flowchoice.ts`'s arbitration** loses most of its job. It exists because
  Nepal has two weak flow candidates that disagree by up to 8.4×. The US has a
  44-year hourly reanalysis on the actual reach plus, usually, a gage within
  reach. The `BOTH_LOST` guard, the geometric-mean blend and
  `BLEND_BIAS_CORRECTION = 1.1458` are all fitted to 69 DHM gauges and **none of
  them transfer**.
- **`dhm.ts` and the yearbook repair** — US equivalent is a JSON API.
- **The entire accuracy table is void for the US.** Every row is measured on
  Nepali gauges and Nepali plants. Not "probably still roughly right" — void.
  Signature `acdb34241895` says nothing about a US run.

**And the trap comes with us.** CLAUDE.md names it four times: the gauge
population is systematically easier than the use population — Nepali gauges sit
on ~800 km² catchments and projects near ~100 km². The US has *more* gauges but
they are still biased toward large, accessible, navigable rivers, and small
run-of-river sites still sit on headwaters. **Do not assume 4,587 gauges in
California means the ungauged-site problem is solved.** That has to be measured
the same way — split by catchment size, and scored on plants, not gauges.

---

## What I would build first

Not a plan you asked for, but the hunt implies an order:

1. **A US fleet harness before a US engine.** EIA-860 + EIA-923 + EHA gives
   plants with metered generation. Build the scoring harness first, so the engine
   is measured from its first commit instead of retrofitted — the thing this
   project got right in Nepal and would be foolish to give up.
2. **Flow v1 without NWM**: NHDPlus EROM `QAMA` + nearest-gage transfer. It is
   cheap, it is probably adequate, and it establishes the baseline that NWM must
   beat. CLAUDE.md's own history says the elaborate option loses about half the
   time.
3. **Then price NWM against that baseline** — the 203 GB download only earns its
   place if the monthly-FDC store beats gage transfer on real plants.
4. **Wild & Scenic as a hard screen, with a fixture on every run.**

---

## Sources

Verified by live request 2026-08-28: [USGS NLDI](https://api.water.usgs.gov/docs/nldi), [USGS Daily Values service](https://waterservices.usgs.gov/docs/dv-service/daily-values-service-details/), [NWM CONUS retrospective on AWS](https://registry.opendata.aws/nwm-archive/), [3DEP EPQS](https://epqs.nationalmap.gov/), [3DEP staged products on `s3://prd-tnm`](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services).

Search-only, unverified: [NHDPlus](https://www.sciencebase.gov/catalog/item/56c38ad8e4b0946c6520aa52), [StreamStats](https://www.usgs.gov/streamstats/streamstats-fundamentals), [ORNL HydroSource](https://hydrosource.ornl.gov/), [NPD potential >1 MW](https://hydrosource.ornl.gov/data/datasets/us-hydropower-potential-existing-non-powered-dams-greater-1mw/), [HILARRI v4](https://hydrosource.ornl.gov/data/datasets/hilarri-v4/), [Hydropower eLibrary](https://hydropowerelibrary.pnnl.gov/), [EIA-923](https://www.eia.gov/electricity/data/eia923/), [EIA-860](https://www.eia.gov/electricity/data/eia860/), [EIA Open Data API](https://www.eia.gov/opendata/), [NID](https://geospatial.sec.usace.army.mil/dls/rest/services/NID/National_Inventory_of_Dams_Public_Service/FeatureServer), [Wild & Scenic Section 7](https://www.rivers.gov/sites/rivers/files/2023-07/section-7.pdf), [PAD-US](https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-download), [USGS SGMC](https://www.usgs.gov/data/state-geologic-map-compilation-sgmc-geodatabase-conterminous-united-states), [USGS landslide inventories v2.0](https://www.usgs.gov/data/landslide-inventories-across-united-states-ver-20-june-2022), [FEMA NFHL](https://www.fema.gov/flood-maps/national-flood-hazard-layer), [Annual NLCD](https://www.mrlc.gov/data/project/annual-nlcd), [PRISM](https://prism.oregonstate.edu/normals/), [NABD](https://www.sciencebase.gov/catalog/item/56a7f9dce4b0b28f1184dabd), [HIFLD transmission lines](https://catalog.data.gov/dataset/electric-power-transmission-lines).
