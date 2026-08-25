# Calculation and Results Audit

**Audit date:** 2026-08-22  
**Repository snapshot:** branch master, HEAD 0831ba723b8489f1b1508aed63e3cb2b2fa0384d, including the current uncommitted working tree  
**Outcome:** **DONE WITH CONCERNS**  
**Audit mode:** Report only. No calculation, source, test, dataset, or configuration fix was made.

## Executive conclusion

The application is useful as a screening tool, but its current outputs should not be treated as feasibility-grade hydrology, energy, pondage, or civil-design results.

This audit found **94 distinct confirmed or high-confidence defects**:

| Severity | Count | Meaning used in this report |
|---|---:|---|
| Critical | 2 | Can change the identity or hydrology of the studied river and most headline results without making the mismatch clear |
| High | 22 | Can materially corrupt flow, energy, environmental release, exported evidence, pondage, or the claimed validity of results |
| Medium | 46 | Can materially bias a subset of sites, inputs, layouts, or evidence statements |
| Low | 24 | Latent, localized, or primarily provenance/robustness defects |

The most severe continuation reproduction was a cross-site state leak. A borrowed DHM record was loaded for the promoted Tamakoshi-area site and scaled by **0.711×**, producing **270 MW and 1,635 GWh/year** at **38.23 m³/s**. After clicking a different map location, the new result described a **5 km²** stream with mapped mean flow about **0.21 m³/s**, yet retained the old 38.23 m³/s measured design flow and became **851.5 MW and 5,188 GWh/year**. The old station, old transfer ratio, and 13,854 values remained active without a new-site warning or rescaling. This is a second way for an ordinary map click to produce a result for hydrology that does not belong to the selected river.

The original critical live reproduction was at:

    http://127.0.0.1:5173/#map=12.50/27.9240/86.2139&at=27.92400,86.21390

The first result reported **70.9 MW and 420 GWh/year**, using **7.36 m³/s** and **1,182 m net head**, while the provenance panel described a river of about **1,745 km² and 54.5 m³/s**. The cross-check simultaneously showed **0.31 versus 12.49 m³/s**, a **40.7× disagreement**. Pressing “Study the 1,753 km² river instead” moved the site and changed the result to **109.5 MW and 648 GWh/year**. This demonstrates that the initial calculation path and the river described to the user are not necessarily the same river.

The test suite and TypeScript compiler both pass, but several tests assert only internal consistency or loose bounds. They do not cover the defects documented here.

## Scope

The audit covered the repository-visible paths for:

- river selection, snapping, downstream paths, reach promotion, and ambiguity handling;
- regional flow models, HYDEST, Modified HYDEST, MHSP, DHM transfer, flow-choice logic, FDCs, environmental release, design flow, power, annual energy, PPA energy, and uncertainty;
- turbine efficiency, head loss, waterway selection, corridor classification, tunnel length, desander sizing, collector gains, and cascade/connectivity logic;
- DEM-derived head, hypsometry, rainfall, pondage, seismic, faults, geology, protected areas, glacial lakes, grid distance, and road access;
- user-imported discharge records, date parsing, gap handling, record quality, catchment scaling, and evidence/readiness labels;
- CSV/GeoJSON export and the validation page;
- bundled DHM, HydroRIVERS, precipitation, elevation, PGA, grid, glacial-lake, DoED, and validation data;
- the current website in a live browser, including river promotion, cross-site measured-state retention, asynchronous audit races, pondage outputs, and a global/out-of-Nepal study failure;
- existing automated checks, TypeScript compilation, targeted numerical counterexamples, dataset invariants, and randomized pondage/FDC/turbine/uncertainty probes.

This is a comprehensive software and data-pipeline audit, not a field survey, hydraulic model calibration, geotechnical assessment, or proof that no undiscovered defect exists. Accuracy against reality remains bounded by source DEM, river, gauge, rainfall, and project-coordinate quality.

## Highest-priority findings

| ID | Severity | Finding | Main consequence |
|---|---|---|---|
| C-01 | Critical | Main-stem promotion changes the label/provenance but not the study path used by the first calculation | The app can calculate one stream while describing another |
| C-33 | Critical | A borrowed/imported measured record survives later map selections without site revalidation | A tiny new stream can inherit an old river's flow and produce hundreds of false megawatts |
| H-10 | High | DHM fixed-width rows are parsed as whitespace-delimited rows and every year is allowed a February 29 | Bundled gauge dates and monthly values are corrupted |
| H-02 | High | Imported non-SI discharge units are accepted without conversion | cfs, L/s, or m³/day files can be wrong by 35.3×, 1,000×, or 86,400× |
| H-03 | High | Any imported series is automatically area-scaled using a nearby recommended gauge ratio | On-site or unrelated measurements can be multiplied without confirmation |
| H-04–H-07 | High | Date and CSV parsing silently guesses or changes records | Monthly allocation, environmental flow, PPA, FDC, and energy can all be wrong |
| H-11 | High | HYDEST/MMP upstream accumulation is clipped to a Nepal-centered raster window | Transboundary basins can lose material upstream area and high-elevation/rainfall fractions |
| H-12 | High | The validation page can be stale while claiming current-engine equivalence | Users can be shown validation evidence for different code |
| H-34 | High | HydroRIVERS proximity and snapping use distance to stored vertices, not distance to river segments | A click on a river can select a different reach or fail to snap at all |
| H-35 | High | An audit started on one site can finish after navigation and attach its result to another site | “Measured twice” head/flow evidence can belong to the previous site |
| H-36 | High | A numeric flow on a malformed-date row is silently discarded and replaced by interpolation | Invented flow can replace a real extreme while the import remains accepted |
| H-37 | High | Out-of-range sites with no turbine still receive power using an ideal runner | Physically unsupported capacity and energy remain headline results |
| H-38 | High | An infeasible uncertainty endpoint is converted into zero uncertainty | The displayed band can collapse exactly when low-flow feasibility is uncertain |
| H-49 | High | Every pondage stage independently moves the inferred dam axis | A higher dam can report less flooded area and less storage |
| H-50 | High | Global terrain studies are discarded when the Nepal-only flow request fails | The advertised terrain/head-only global fallback does not complete |
| H-51 | High | A dragged/custom selected scheme can be absent from CSV and GeoJSON | The exported evidence may describe a different layout from the screen |
| H-66 | High | Gauge proximity can label a neighbouring branch as the same river | A trusted donor recommendation can transfer flow across an unconnected branch |
| H-73 | High | A measured override remains controlled by the discarded model arbitration | The same measured record and geometry can produce roughly 10× different flow and energy |
| H-80 | High | The site audit can replace the hydrograph with an unrelated neighbouring grid cell using seasonal shape alone | Forty-five of 131 station anchors switched cell; most selected cells had raw means over 2× different and some over 300× different |
| H-85 | High | The 100× “main stem” heuristic has a measured false positive | Upper Syange Khola is promoted from its 15.7 km² project stream to the 2,483 km² Marsyangdi and reported near 301 MW |
| H-94 | High | Regional catchment inputs remain fixed at the click while the selected intake moves downstream | A confluence can give the engine downstream flow but leave flow arbitration, regional models, hypsometry, and sediment tied to a catchment hundreds of times smaller |
| M-56–M-57 | Medium | Sparse dates and negative flows can create invalid full-year or additional-water calculations | Energy can be annualized from one season, while a negative release increases design flow |
| M-63 | Medium | An unbounded third flow source can dominate two agreeing sources | A nominally low-disagreement blend can move more than 3× away from both agreeing estimates |
| M-70–M-72 | Medium | Pondage snapping, donor grading, and desander bank fitting ignore key topology | Unrelated depressions, dissimilar catchments, or two separate banks can be treated as one valid site |
| R-01–R-06 | Method risk | Pondage uses a useful screening fill, but not a fixed-axis, terrain-validated impoundment design | Results can be extremely stage-, grid-, axis-, source-, and edge-sensitive |

## Confirmed and high-confidence defects

### Site and river identity

#### C-01 — Main-stem promotion is not applied to the calculation path

**Severity:** Critical  
**Confidence:** Confirmed by code trace and live reproduction  
**Locations:** src/App.tsx:1445-1588; src/rivers.ts:1041-1055; src/validate.ts

The application constructs the downstream study path from the nearest hit before promoting the displayed reach to a larger main stem. The promoted reach is then used for some provenance and ambiguity values, but study.path and its first reach still drive flow and geometry. As a result, the UI can describe a large river while power is calculated from a nearby small tributary.

The ambiguity calculation also compares the already-promoted reach with the main stem. In the live case it reported roughly 1,745 versus 1,753 km², making the two choices appear nearly identical even though the calculation’s flow cross-check exposed a 40.7× mismatch.

**Expected:** River identity, study path, flow source, catchment metadata, map geometry, ambiguity text, and provenance should refer to the same selected reach.  
**Observed:** Promoting the live site changed 70.9 MW/420 GWh to 109.5 MW/648 GWh and moved the intake, proving that the original calculation had not used the river described in its provenance.

### Imported and measured discharge

#### H-02 — Non-SI discharge units are accepted as m³/s

**Severity:** High  
**Confidence:** Confirmed with a synthetic import  
**Location:** src/measured.ts:151-183

The header unit is recognized only as descriptive metadata. Values are not converted or rejected. A column headed “Discharge (cfs)” containing 35.3146667 and 70.6293334 is interpreted as 35.3146667 and 70.6293334 m³/s, rather than 1 and 2 m³/s. The same failure can make L/s values 1,000× too large or m³/day values 86,400× too large.

#### H-03 — Arbitrary imported records are automatically catchment-scaled

**Severity:** High  
**Confidence:** Confirmed by code trace  
**Location:** src/App.tsx:2567-2594

An imported file is scaled using the area ratio of a nearby automatically suggested gauge. There is no station-identity match, source-catchment confirmation, or explicit user approval. This is appropriate only for a known donor gauge; it is wrong for an on-site record and uncontrolled for an unrelated station. Because the same measured state represents both borrowed DHM records and arbitrary user files, the UI also describes user data as a borrowed gauge in src/Reading.tsx:1298-1403.

#### H-04 — Ambiguous dates are silently interpreted day-first

**Severity:** High  
**Confidence:** Confirmed with a synthetic import  
**Location:** src/measured.ts:95-108 and 207-220

Dates such as 01/02/2024, 02/03/2024, and 03/04/2024 are accepted as 1 February, 2 March, and 3 April. The file may equally mean 2 January, 3 February, and 4 March. This conflicts with the parser’s stated intent not to guess and can move flows into the wrong PPA and environmental-flow months.

#### H-05 — Impossible calendar dates are accepted

**Severity:** High  
**Confidence:** Confirmed with a synthetic import  
**Location:** src/measured.ts:112-115

The parser checks only that the day is between 1 and 31. It does not validate the number of days in a month or leap years, so 2023-02-31 is accepted. Later JavaScript date normalization can move that value into March, while other code still slices the original string as February. The same record can therefore belong to different months in different calculations.

#### H-06 — A no-date measured series receives zero derived environmental release

**Severity:** High  
**Confidence:** Confirmed by direct calculation  
**Locations:** src/measured.ts:312-315; src/App.tsx:1661-1689

The parser says a date-free flow column can still be used with a fallback. In the application, the monthly-minimum function receives no dates, returns a non-finite result, and the derived residual release falls to zero. This bypasses the intended Nepal low-flow floor for precisely the import mode the parser advertises.

#### H-07 — CSV thousands separators and quoted fields are not parsed as CSV

**Severity:** High  
**Confidence:** Confirmed with a synthetic import  
**Location:** src/measured.ts:59-83 and 151-183

Rows are split on commas rather than parsed with CSV quoting rules. The documented tolerance for thousands separators is therefore false: a row such as 2020-01-01,1,234 is read as a flow of 1 rather than 1,234. Quoted values and quoted headers containing commas can also shift columns silently.

#### M-08 — Monthly mean imports are weighted as equal-duration observations

**Severity:** Medium  
**Confidence:** Confirmed by independent recomputation  
**Locations:** src/measured.ts:307-311; src/engine/hydro.ts:299-322

Annual energy averages all observations equally and multiplies by 8,760 hours. For twelve monthly values, February therefore receives the same weight as a 31-day month. A synthetic series with February at 100 m³/s and all other months at 1 m³/s produced 79.490430 GWh instead of the calendar-day-weighted 73.857528 GWh, an overestimate of 7.63%. Monthly PPA allocation has the same duration problem.

#### M-09 — Duplicate dates can fabricate complete years and P50/P90 evidence

**Severity:** Medium  
**Confidence:** Confirmed with a synthetic record  
**Locations:** src/api.ts:168-195; src/engine/hydro.ts:456-487

Completeness is based on row counts rather than unique days. A series containing 365 copies of 2021-01-01 is accepted as a complete year with coverage 1 and produces an annual-energy value. Some import paths may deduplicate while filling gaps, but the public calculation routines do not enforce uniqueness and can manufacture interannual statistics from duplicate timestamps.

### Bundled hydrology and regional models

#### H-10 — The DHM fixed-width parser shifts month columns and creates invalid leap days

**Severity:** High  
**Confidence:** Confirmed by pipeline inspection and full-data audit  
**Locations:** pipeline/build-dhm-records.mjs:56 and 87-110; src/dhm.ts:162 and 183-195

The source rows are described as fixed-width, but the builder trims each row and splits on whitespace. Blank cells in short months disappear, so values after those blanks shift into the wrong month on days 29–31. The builder also defines February as 29 days for every year, and the runtime emits February 29 for every year.

Across the bundled records, the audit found **2,058 non-null February 29 values in 2,096 non-leap station-years (98.19%)**, spanning 136 files. Station 120 in 2001 shows the characteristic shift: February 29 has 19; May 28 has 29.5 and May 29 has 93.4; July 28 has 348 and July 29 has 119; December 29–31 are null. These are not merely invalid labels—the values have shifted between month columns. Transferred DHM FDCs, monthly means, environmental release, PPA energy, and validation can all be affected.

#### H-11 — HYDEST and MMP upstream accumulation can omit transboundary headwaters

**Severity:** High  
**Confidence:** High; confirmed by source-area comparison, with site-dependent impact  
**Locations:** pipeline/build-hypsometry.mjs:58-65, 188-220, 238-277, and 416-429; pipeline/build-mmp.mjs:67-69 and 311-423

The builders rasterize and accumulate only inside approximately 79.9–88.4°E and 26.2–30.6°N. Upstream cells outside that window cannot contribute to area, elevation fractions, or precipitation, even when the downstream Nepal reach belongs to a transboundary basin. The pipeline reads HydroBASINS UP_AREA but does not use it to verify its accumulated area.

Independent comparisons against HydroBASINS total upstream area were close for some large outlets, but not all:

| Example | Official upstream area | Window accumulation | Retained |
|---|---:|---:|---:|
| Tamakoshi live area | 1,785.1 km² | 1,787.7 km² | 100.1% |
| Karnali at Chisapani | 45,745.9 km² | 45,615.0 km² | 99.7% |
| Narayani example | 31,855.4 km² | 31,916.9 km² | 100.2% |
| Sapta Koshi example | 54,581.3 km² | 51,785.0 km² | 94.9% |
| Arun at Uwa | 26,381.9 km² | 23,524.9 km² | 89.2% |

HydroBASINS defines UP_AREA as total upstream area from headwaters; see the [official product page](https://www.hydrosheds.org/products/hydrobasins) and [technical documentation](https://data.hydrosheds.org/file/technical-documentation/HydroBASINS_TechDoc_v1c.pdf). The clipping bias is localized rather than universal, but can be material and may be larger for high-elevation or rainfall fractions than for total area.

#### H-12 — The validation page can claim current-code validation while using stale output

**Severity:** High for the audited working tree  
**Confidence:** Confirmed  
**Locations:** src/validation-main.tsx:7-10; pipeline/build-validation.mjs; src/data/validation.json

The page says the published results use the same code and cannot drift without a rerun, but the UI imports a committed JSON file with no engine signature or freshness guard. The JSON was generated on 2026-08-16 while calculation files in the audited working tree have changed since then. The page can still display “0 tuned/hidden” and current-code language although its results have not been regenerated from the current engine.

The fleet-validation builder has a signature, but it omits important calculation dependencies such as turbine.ts, waterway.ts, and hydro.ts. None of the 141 inspected fleet rows carried the builder’s current signature; two were unstamped. Fleet validation is not currently the page’s imported dataset, but this shows the same provenance weakness in the validation tooling.

#### M-13 — FDC shape correction can worsen an extreme curve

**Severity:** Medium  
**Confidence:** Confirmed by targeted and randomized counterexamples  
**Location:** src/engine/fdcshape.ts:207-239

The algorithm scales a tail and then renormalizes the full series to preserve its mean. In a 3,650-day spike-series counterexample, Q40/mean began at 0.1545 against a target median of 0.5930. The displayed correction factor was 3.839×, but after correction Q40/mean fell to 0.02985—only 19.3% of its already-low starting ratio—and remained implausible. In randomized step/spike probes, 25 of 40 flagged series remained outside the plausibility band after correction.

This is not universal: among ten shipped validation series, only Upper Tamakoshi was flagged and its ratio improved from 0.3750 to 0.6096. The defect is that the correction is presented as corrective without a post-condition guaranteeing improvement or plausibility.

#### M-14 — Rated capacity applies peak turbine efficiency at design flow

**Severity:** Medium  
**Confidence:** Confirmed by formula comparison  
**Locations:** src/engine/turbine.ts:336-355; src/engine/discover.ts:265-267; src/engine/units.ts:105-109

The turbine selector returns both the peak efficiency and the flow fraction where that peak occurs. Rated power nevertheless applies the peak efficiency at full design flow, rather than evaluating the efficiency curve at design flow. For the audited Francis curve at head 100 m and q=0.1, peak efficiency is 0.898904 while full-flow efficiency is 0.865617, so the displayed rated MW is 3.845% high relative to the curve used by the energy dispatch. Capacity and annual energy are consequently based on different turbine-efficiency assumptions.

#### M-21 — Uncertainty scales flow but holds a derived residual release fixed

**Severity:** Medium  
**Confidence:** Confirmed by formula trace  
**Locations:** src/engine/uncertainty.ts:126-145; src/App.tsx:1661-1689

Environmental release is derived from the baseline low-month flow and then reused while uncertainty scenarios scale the inflow. A policy release tied to the hydrology should change with the hydrology scenario. For example, a base low flow of 2 m³/s yields a 0.2 m³/s release; at a 0.5× flow scenario the policy-equivalent release would be 0.1, but the code keeps 0.2. This makes the low scenario’s usable flow 0.8 instead of 0.9 m³/s.

#### M-22 — Minimal imports are promoted to “measured” top evidence with model years

**Severity:** Medium  
**Confidence:** Confirmed by code trace  
**Locations:** src/readiness.ts:164-175; src/App.tsx:2518-2520

Any parsed import can receive the top “measured” evidence class even when it has only a few values, no dates, no station identity, no catchment, and no validation. The year count passed to readiness comes from study.flow, so an imported record can be described as “Imported record (20 years)” because the regional model has 20 years, not because the import does.

#### M-23 — DHM donor paths either stop at an ineligible first choice or let it replace the model

**Severity:** Medium  
**Confidence:** Confirmed by control-flow inspection and a full fleet probe  
**Locations:** src/dhm.ts:109-159 and 246-301; src/App.tsx:2035-2067; src/Reading.tsx:1310-1390

`measuredSeriesFor` asks `bestTransfer` for one candidate, then rejects it if it is not `close`, lacks ten complete years, or has inadequate/unavailable data; it does not try the next eligible station. Conversely, the app exposes that same unfiltered `bestTransfer` result as an adoptable recommendation, and adoption loads and scales it without the validator's `close` and ten-year gates. The two supposedly shared paths therefore enforce different evidence rules in opposite directions.

Across 123 fleet sites with an offered donor, 26 selected donors had fewer than ten complete years, seven were graded `indicative`, and 80 of 123 offers failed the validator's combined `close` plus ten-year gate. Examples included station 447.9 with only two complete years offered six times, a two-year indicative Upper Richet transfer with a 7.4× catchment mismatch at 44.8 km, and close donors with only four or five years. The twelve-nearest geographic prefilter can also exclude a better hydrologic match before this ranking begins.

#### M-24 — Public gauge suggestions prefilter the six geographically nearest gauges

**Severity:** Medium  
**Confidence:** Confirmed by control-flow inspection  
**Location:** src/gauges.ts:154-170

Only six gauges survive the geographic-distance prefilter before network and catchment similarity are resolved. A slightly farther gauge on the connected river with a much better drainage-area match can therefore never be suggested, contrary to the hydrologic ranking implied by the UI.

#### M-27 — National FDC bands and site curves use different mean definitions

**Severity:** Medium  
**Confidence:** Confirmed by data-wide comparison  
**Location:** src/engine/fdcshape.ts:116-121 and 170-180

National quantiles are divided by the equal-weight mean of twelve monthly means, while site quantiles are divided by a daily-weighted mean. For 81 stations with at least ten complete years, the denominator difference had a median of -0.45% and ranged from -4.76% to +1.60%. Across all 136 stations, sparse records produced extremes of -14.98% and +22.10%. This systematically shifts the national plausibility band relative to the site statistic it judges.

### Civil, waterway, and layout calculations

#### M-15 — Two desander bays do not provide the claimed one-bay redundancy

**Severity:** Medium  
**Confidence:** Confirmed by geometry and continuity calculation  
**Location:** src/engine/sediment.ts:143-167

For flow above 0.5 m³/s the result says two bays permit one chamber to be serviced while the other runs. The total water cross-section remains sized only for design flow at 0.3 m/s; the bay count adds wall thickness but not duplicate hydraulic capacity. At q=1 m³/s and head=100 m, both bays together operate at 0.3 m/s, so one remaining bay would operate at 0.6 m/s and violate the sizing criterion.

The excavation estimate also excludes inlet and outlet lengths. In that example it is 130.29 m³ versus 161.13 m³ for the full reported rectangular length, about 19% lower. The reported quantity is therefore chamber excavation, not total structure excavation.

#### M-16 — Bench fitting bridges missing DEM terrain

**Severity:** Medium  
**Confidence:** Confirmed with a synthetic profile  
**Location:** src/engine/sediment.ts:232 and 243-270

Missing elevation samples are removed before the algorithm searches for a flat bench. The remaining points are treated as contiguous, so a bench can span an unobserved valley, cliff, or void. A flat -150 m to +150 m profile with all points from -30 m to +30 m missing was reported as a 300 m fitting bench even though the central 90 m was unknown.

#### M-17 — Tunnel length can exceed the full corridor length

**Severity:** Medium  
**Confidence:** Confirmed with a synthetic corridor  
**Location:** src/engine/corridor.ts:64-67 and 112-119

The classifier adds a full sampling interval for every station classified as tunnel, including terminal and irregularly spaced samples. On a 0.4 km path sampled at 0, 0.12, 0.24, 0.36, and 0.4 km, the reduced steep sample set reported 0.75 km of tunnel—187.5% of the entire path. Tunnel, canal, and penstock lengths should partition actual segment lengths, not count points as intervals.

#### M-18 — Head loss is capped at 90%, preserving power for infeasible layouts

**Severity:** Medium  
**Confidence:** Confirmed at the boundary  
**Location:** src/engine/waterway.ts:240-246 and src/engine/discover.ts:250-273

When computed loss equals or exceeds gross head, the loss fraction is capped at 0.9 and net head remains 10% of gross. A boundary case with 15.5 m gross head, 11.8318 m³/s, and 14 km waterway has raw loss at approximately 100% of head but still returns roughly 0.102 MW. Automatic discovery rejects many such layouts through other filters, but manual or near-threshold paths can still show physically infeasible positive generation. The existing “losses swallow head not viable” test checks only that the capped fraction is between 0.4 and 1; it does not assert rejection.

The cap can also disconnect nameplate capacity from daily dispatch. One synthetic discovery-eligible boundary case with 16.25 m gross head, 13.05 km waterway, and 11.568 m³/s design flow had 14.774 m raw loss, returned 0.108 MW capacity and 2.015 GWh/year, and therefore reported a plant factor of about **2.13**. Daily power is not capped back to the capped-loss nameplate value.

#### M-19 — Collector headline output is linearly scaled without hydraulic redesign

**Severity:** Medium  
**Confidence:** Confirmed by code trace  
**Locations:** src/collector.ts:21-24; src/App.tsx:2210-2214; src/Reading.tsx:1467-1500, 1579-1595, and 2358-2382

Collector gains multiply the site MW and GWh by a flow fraction. The turbine dispatch, design flow, conveyance dimensions, residual flow, and Q² head loss are not recomputed. The collector module itself notes that head loss rises with the square of flow, so the exact combined MW/GWh displayed to the user is not physically consistent with the application’s own waterway model.

#### M-20 — Multiple collectors can count the same tributary repeatedly

**Severity:** Medium  
**Confidence:** Confirmed with duplicate collector inputs  
**Location:** src/collector.ts:138-255

Each collector is checked against the main river, but collectors are not checked pairwise for identical reaches, shared upstream area, or nested tributaries. Two identical valid collectors with a 0.2 flow ratio each are both counted, producing a 0.4 gain. This can double-count the same water.

### Access, export, provenance, and validation

#### M-25 — Road routing does not try a fallback router after NoSegment

**Severity:** Medium  
**Confidence:** Confirmed with a controlled router response  
**Location:** src/access.ts:71-79

The router loop stops after the first response even when its status is NoSegment. In a controlled test, the first router returned NoSegment and a second router would have returned a valid route; the second was never called, and both intake and powerhouse access were left null. OSRM defines NoSegment as failure to snap the supplied coordinate, so it is a router/coverage failure rather than proof that no motorable road exists. See the [official OSRM nearest-service documentation](https://github.com/Project-OSRM/osrm-backend/blob/master/docs/http.md#nearest-service).

#### M-26 — Pondage export labels retained water depth as dam height

**Severity:** Medium  
**Confidence:** Confirmed by UI/export comparison  
**Locations:** src/Reading.tsx:1824-1832; src/export.ts:123 and 587

The UI and provenance define the selected pondage control as retained water level, but the CSV header is selected_pondage_dam_height_m. A downstream consumer can reasonably treat that number as structural dam height, which it is not. This is a semantic calculation/export defect even when the numeric value is unchanged.

#### L-28 — Flow-choice provenance hardcodes WECS/DHM for a Modified HYDEST decision

**Severity:** Low  
**Confidence:** Confirmed  
**Location:** src/engine/flowchoice.ts:283-286 and 357-359

When Modified HYDEST is the method that wins the judging step, the explanatory note still names WECS/DHM. The selected numeric result is unchanged, but the stated method provenance is false.

#### L-29 — MHSP Q45 silently equals Q65 without rainfall

**Severity:** Low; latent because this output is not currently used in the main UI  
**Confidence:** Confirmed by direct call  
**Location:** src/engine/mhsp.ts:118-124 and 149-154

Without rainfall, the fallback produces identical Q45 and Q65 values. At 100 km² both are 1.598819575 m³/s. Distinct exceedance probabilities should not silently collapse to the same statistic unless the method explicitly defines that behavior.

#### L-30 — The bottom provenance panel always says “Modelled, not gauged”

**Severity:** Low  
**Confidence:** Confirmed in UI source  
**Location:** src/Reading.tsx:3394-3401

The statement is unconditional, even when an imported or DHM measured record is active. A separate measured-data panel does not remove the contradiction in the final provenance summary.

#### L-31 — OSM river indexing covers vertices rather than crossed grid cells

**Severity:** Low  
**Confidence:** High from geometry inspection; impact depends on segment density  
**Location:** src/osm-rivers.ts:47-59

The spatial index inserts cells containing polyline vertices, not every cell traversed by each segment. A long sparse segment can cross a query cell without either endpoint being indexed there, making the river invisible to a nearby lookup. The onRiver flag is also fixed from the seed classification and is not updated after a stream-to-river switch.

#### L-32 — Downstream path interpolation carries endpoint metadata across a raw segment

**Severity:** Low  
**Confidence:** High from control-flow inspection  
**Location:** src/rivers.ts downstreamPath

Inserted geometry points inherit downstream endpoint metadata rather than interpolated or segment-local values. Coarse raw segments can therefore make catchment/flow metadata jump early, and the final interpolation step can overshoot the requested maximum path distance. This is primarily a local geometry/provenance risk rather than a demonstrated large national bias.

### Continuation audit: state transitions, numerical boundaries, and exports

#### C-33 — A measured record survives selection of a different river

**Severity:** Critical  
**Confidence:** Confirmed by code trace and live cross-site reproduction  
**Locations:** src/App.tsx:390-391, 1420-1431, 1634-1689, 2050-2067, and 3125-3139

Selecting a borrowed DHM record or importing a file replaces the model flow with shared `measured` state. A later map selection clears collectors but does not clear, revalidate, or rescale that record; only the full reset does. The next river therefore inherits the previous river's observations, station metadata, and transfer factor.

In the live reproduction, DHM 610 was loaded for a Tamakoshi-area site and scaled by 0.711×, giving 38.23 m³/s design flow and 270 MW. Clicking a different stream then produced a 5 km² catchment with mapped mean flow about 0.21 m³/s, but the old 38.23 m³/s design flow and 13,854-value DHM record remained active. The new result was 851.5 MW and 5,188 GWh/year. The page continued to describe the old scaling as if it were between the gauge and “this site.”

#### H-34 — HydroRIVERS snapping measures vertices instead of river segments

**Severity:** High  
**Confidence:** Confirmed by source inspection, a dataset-wide segment probe, and live reproduction  
**Locations:** src/rivers.ts:110-115, 170-179, 347-383, and 1041-1129; src/App.tsx:1420-1430

The index stores only cells containing polyline vertices, and nearest-reach distance is the minimum distance to those vertices. It does not calculate point-to-segment distance or index every crossed cell. A point lying exactly on a long segment can therefore be considered more than the 0.8 km snap threshold from its own reach, or a vertex from another reach can win.

The bundled file contains 131,458 segments in runtime coverage; 50,985 are longer than 0.8 km and 14,025 exceed 1.6 km. At approximately 14,049 midpoints of segments longer than 1.6 km, the selected vertex was over 0.8 km away in 94.06% of cases, and the wrong reach won in 35.69%. At 29.5770833°N, 82.4395833°E, a point exactly on a 27.1 km² source reach was associated with a much larger reach; the live page then used a 9,041 km² catchment and reported 40.9 MW. Expanding the vertex-cell search through all rings did not change the tested choices, confirming that vertex-only distance—not merely early ring stopping—is the principal defect.

#### H-35 — An asynchronous site audit can attach stale results to a new site

**Severity:** High  
**Confidence:** Confirmed by code trace and live race reproduction  
**Locations:** src/App.tsx:2491-2496 and 3153-3187

The audit captures the current study and awaits head, shape, and extended-flow work. It has no abort signal, site/cell identity check, or request token before writing the result. Changing sites resets the panel temporarily, but an older request can later repopulate it and can merge its flow record into the current study.

At the live 27.9240°N, 86.2139°E site, an audit was started and the main-river choice was selected immediately. The old request later attached a **687.9 m** two-terrain difference to the promoted river. Auditing the promoted river directly produced **590.3 m**. Thus the apparently independent “measured twice” evidence visibly belonged to the previous site.

#### H-36 — A malformed date silently replaces its numeric flow with interpolation

**Severity:** High  
**Confidence:** Confirmed with a four-row import  
**Locations:** src/measured.ts:207-261 and 377-432; src/App.tsx:2589

The parser retains a numeric value even when its date is invalid, pairing it with an empty date. Gap filling then drops undated rows and fills the resulting calendar hole by interpolation. For `2024-01-01,1`, `not-a-date,100`, `2024-01-03,3`, and `2024-01-04,4`, parsing succeeds with values `[1,100,3,4]`; after normal application handling the accepted series becomes `[1,2,3,4]`. The real 100 is discarded and an invented 2 replaces it, while the note merely says one missing day was interpolated.

#### H-37 — No valid turbine still means idealized positive power

**Severity:** High  
**Confidence:** Confirmed by direct engine calculation and live observation  
**Locations:** src/engine/discover.ts:260-270 and return assembly; src/Reading.tsx:164-169, 1674-1681, and 1733-1737

When turbine selection returns null because head/flow lies outside every turbine polygon, discovery substitutes the general generator/transformer efficiency as the whole conversion efficiency. This is equivalent to a 100% efficient runner followed by the stated electrical efficiency. The turbine row disappears, but capacity and energy remain headline numbers; the displayed explanatory multiplication also does not exactly match the engine's fallback.

The explanation compounds the mismatch: the fallback stores the electrical efficiency in `turbinePeak`, then the UI multiplies `turbinePeak × efficiency` again. With the default 0.96 electrical efficiency, it explains an apparent 92.16% combined efficiency even though the engine calculated with 96%.

A direct 2,500 m gross-head, 9 m³/s design-flow case selected no turbine but returned 208.377 MW, 1,825.385 GWh/year, and plant factor 1. The live cross-site state-leak result likewise showed no turbine for approximately 2,365 m net head while reporting 851.5 MW.

#### H-38 — An infeasible uncertainty endpoint becomes zero uncertainty

**Severity:** High  
**Confidence:** Confirmed by direct calculation  
**Location:** src/engine/uncertainty.ts:126-156

Each source contribution is measured from low/high reevaluations, but `swing` returns zero unless both endpoints are valid. When the low-flow perturbation makes usable design flow non-positive, that endpoint is null and the river-flow contribution becomes exactly zero. The final low/best/high capacity and energy can all collapse to the best estimate, which reverses the meaning of the uncertainty calculation at a feasibility boundary.

In a 100 m-head, 0.4 m³/s design-flow case with 0.6 m³/s residual release, the best result was 0.150172 MW and the high-flow endpoint was 0.534987 MW; the low endpoint was infeasible. The returned band nevertheless had low = best = high and reported **0% river-flow swing**.

#### M-39 — The “up to 40 years” audit can reuse the same 20-year local record

**Severity:** Medium  
**Confidence:** Confirmed by store metadata, API trace, and live UI  
**Locations:** src/api.ts:337-380; src/Reading.tsx:1627 and 1658-1659; pipeline/glofas-store.mjs

The audit asks for 40 years, but the local response path ignores the requested range and returns the entire bundled store. That store spans 2006-01-01 through 2025-12-30—7,304 days, about 20 years. A site that already used those 20 years therefore receives the same record, while the completion text says the record was “extended to 20 years” and that deeper droughts and rarer floods now shape the curve. The audit adds no historical evidence in this path.

#### M-40 — The second terrain audit can be the same AWS DEM sampled twice

**Severity:** Medium  
**Confidence:** Confirmed by source trace  
**Locations:** src/App.tsx:1492 and audit invocation; src/audit.ts:65-85

The primary profile tries Re:Earth and falls back to AWS Terrain Tiles. The audit does not receive or inspect that source; it always fetches AWS Terrain Tiles. Whenever the primary request already fell back to AWS, the “second terrain” uses the same provider, coordinates, and sampling logic. A near-zero difference can then tighten error to the 10 m floor while the UI describes the head as independently measured twice.

#### M-41 — Turbine choice and capacity jump at a polygon boundary

**Severity:** Medium  
**Confidence:** Confirmed by a two-point numerical probe  
**Locations:** src/engine/turbine.ts:26-90, 157-204, and 314-355

Point-in-polygon boundary handling excludes one turbine region at an exact boundary and switches to another curve. At 500 m net head, increasing design flow from 59.999 to 60.000 m³/s changed the selected turbine from Pelton to Francis, peak efficiency from 0.829793 to 0.931834, and rated capacity from 234.436 to 263.269 MW. A 0.001 m³/s input change therefore caused a 28.83 MW, 12.30% discontinuity rather than a physically smooth transition or an explicit overlapping-choice comparison.

#### M-42 — Multi-unit sensitivity considers only equal flow sharing

**Severity:** Medium  
**Confidence:** Confirmed by an independently enumerated dispatch  
**Location:** src/engine/units.ts:80-109

For each assumed number of running units, the sensitivity calculation assigns every unit the same flow. It never tests unequal dispatch, despite claiming to compare feasible unit cases. With two 1 m³/s Crossflow units, 20 m head, and 1.2 m³/s available, equal sharing reported 1.445361 GWh/year. A feasible 1.0 + 0.2 m³/s split gives 1.504683 GWh/year, 3.94% more, because unit efficiency is nonlinear.

#### M-43 — The reported uncertainty band can exclude its own evaluated endpoints

**Severity:** Medium  
**Confidence:** Confirmed by direct and randomized property tests  
**Location:** src/engine/uncertainty.ts:147-156

For each perturbation the code takes half the absolute low/high difference, then centers that symmetric amount on the best result. Nonlinear low and high results are generally not symmetric around best, so the final band need not contain either scenario that generated it. In a simple constant-flow case, best capacity was 7.207127 MW, the evaluated endpoints were 2.755559 and 11.457661 MW, but the reported band was 2.856076–11.558178 MW: the low scenario was outside the advertised range. All 7,710 valid randomized cases tested had at least one capacity endpoint outside its recentered band beyond numerical tolerance; the worst sampled miss was about 20.27% of best capacity.

#### M-44 — Protected-area proximity is checked only at the intake

**Severity:** Medium  
**Confidence:** Confirmed by control-flow trace and real protected-area coordinates  
**Location:** src/App.tsx:2290-2303

Exact containment is checked at intake and powerhouse, but if neither lies inside an area, the 3 km proximity query is run only for the intake. A powerhouse near a hard-stop area is therefore omitted. For example, an intake at 27.5°N, 85.0°E has no nearby result, while a powerhouse at 26.55°N, 86.97°E is outside but within 3 km of Koshi Tappu Wildlife Reserve; the application-level logic returns no conservation warning. If either endpoint is inside one area, nearby checks for a different area are also skipped.

#### L-45 — The Pelton efficiency curve can exceed 100%

**Severity:** Low  
**Confidence:** Confirmed by direct and broad numerical probes  
**Location:** src/engine/turbine.ts:265-271 and 314-348

The efficiency polynomial is clamped only below at zero, not above at one or a physically calibrated maximum. `turbineCurve(0.0051, 2000)` selected Pelton with peak efficiency 1.000878. A broad grid scan found many very-low-flow/high-head points above one, with a maximum around 1.034. These cases are narrow and mostly marginal, but an efficiency over 100% is physically impossible.

#### L-46 — The trapezoidal FDC energy helper is not equivalent to annual dispatch

**Severity:** Low; latent because the helper is currently used only in a check  
**Confidence:** Confirmed by direct comparison  
**Location:** src/engine/hydro.ts:292-379; checks/hydro.check.ts

`energyFromFdcTrapezoid` is presented and tested as an alternative annual-energy integration, but it is not equivalent for sparse or strongly curved records. For `[100, 50, 1]` m³/s with 20 m head, 50 m³/s design flow, and 0.9 efficiency, direct annual dispatch returned 51.561360 GWh while the trapezoidal helper returned 48.338775 GWh, 6.25% lower.

#### L-47 — Pondage GeoJSON exterior rings use clockwise winding

**Severity:** Low  
**Confidence:** Confirmed by coordinate-order inspection  
**Location:** src/pondage.ts:604-645

Each exported pond cell is ordered northwest → northeast → southeast → southwest, which is clockwise in longitude/latitude space. RFC 7946 says polygon exterior rings should be counterclockwise, although parsers should tolerate the older alternative for backward compatibility. This is an interoperability/provenance defect rather than a numeric pondage error. See [RFC 7946 section 3.1.6](https://www.rfc-editor.org/rfc/rfc7946#section-3.1.6).

#### L-48 — Downhill fallback traces can contain rises and terminate early after pits

**Severity:** Low  
**Confidence:** Confirmed by control-flow inspection  
**Location:** src/api.ts:611-641

The fallback trace allows a candidate up to 6 m above the current elevation, stores the historical minimum in `curZ`, but appends the candidate's higher `bestZ` to the returned profile. The comment that elevation never rises is therefore false. Because subsequent candidates are still compared with the historic minimum, a legitimate route out of a small DEM pit can also be rejected early, shortening the profile.

### Continued adversarial audit: pondage invariants, exports, joins, caches, and time series

#### H-49 — The pondage stage–area–storage curve can run backwards

**Severity:** High  
**Confidence:** Confirmed with deterministic and randomized terrain fixtures  
**Locations:** src/pondage.ts:262-404 and 485-516

`pondageStageCurve` runs the full delineation again at every retained height. Each run rediscovers the bank crossings and constructs a different dam barrier. The flooded sets therefore are not required to be nested: a low stage can leak around a short inferred barrier, while a higher stage extends that barrier and disconnects terrain that was previously counted.

On a deterministic 17×17, 30 m fixture, raising retained height from 5 m to 10 m changed the inferred dam length from 40 m to 150 m. Flooded area fell from **63,900 m² to 17,100 m²**, and storage fell from **319,500 m³ to 160,200 m³**. Neither result was edge- or axis-limited. In 20,000 randomized rugged grids, area decreased between adjacent stages 3,198 times and storage decreased 3,095 times. A stage–area–storage curve for one fixed reservoir cannot physically shrink as water level rises.

#### H-50 — A rejected flow request prevents the advertised global terrain/head result

**Severity:** High  
**Confidence:** Confirmed by control-flow trace and live out-of-Nepal test  
**Locations:** src/api.ts:42-65 and 197-205; src/App.tsx:1434-1540

The API explicitly rejects discharge requests outside Nepal while stating that terrain/head analysis remains available globally. Both mapped-river and terrain-fallback study branches nevertheless await that rejected flow promise before committing the otherwise successful terrain/path result. The rejection exits the whole study and discards the available terrain result.

A live Switzerland selection remained in “Studying” for more than 32 seconds and produced no result after the flow rejection. This is a functional calculation-path failure, not merely missing regional hydrology: the promised globally available head/terrain result is not retained.

#### H-51 — A custom or fallback selected scheme can be omitted from CSV and GeoJSON

**Severity:** High  
**Confidence:** Confirmed with a controlled export reproduction  
**Locations:** src/App.tsx:1823-1844, 2649-2666, and 3053-3108; src/export.ts:535-699 and 749-828

The current result can be evaluated from an arbitrary intake/powerhouse pair after dragging or layout changes, but exports iterate only the retained `found.schemes` collection. The selected scheme is passed separately and is not inserted into that collection. If it is outside the top eight retained candidates, no row or scheme feature represents the result currently shown on screen. The export context also requires `found`; terrain/manual fallback studies set `found` to null, so a valid fallback result can have no CSV or GeoJSON export at all.

With selected pair `(2,9)` and retained pair `(0,10)`, CSV contained only the retained row and did not mark it selected; GeoJSON contained no selected-scheme geometry. Selected access or pondage objects can still be appended, leaving evidence associated with a layout that the export never defines.

#### M-52 — DoED canonicalization merges distinct projects sharing only name and capacity

**Severity:** Medium  
**Confidence:** Confirmed against the bundled project records  
**Location:** src/cascade.ts:79-110

The canonical key contains only normalized project name and capacity. Licence number, promoter, river, district, coordinates, and project bounds are ignored. The current 1,169 geolocated records collapse to 1,167.

One collapsed pair is two distinct **Laphagad Hydropower Project, 4.6 MW** survey applications: licence 10327 belongs to Nicholas Energy on Lapha Gad with one set of bounds, while licence 10403 belongs to Namaste Energy on Lapatgad with different bounds and a different expiry date. One valid project therefore disappears from cascade/project-context calculations. The other duplicate group may be a legitimate stage transition, showing why the identity rule needs explicit provenance rather than a name/capacity assumption.

#### M-53 — Abortable flow, road, and geology caches can poison an immediate replacement request

**Severity:** Medium  
**Confidence:** Confirmed with controlled abort timing  
**Locations:** src/api.ts:32 and 197-292; src/access.ts:44-114; src/geology.ts:162-205; src/App.tsx:1883-1908 and 2233-2265

Each cache stores an in-flight promise that closes over the first caller's `AbortSignal`. When a layout/effect cleanup aborts that caller and the replacement effect immediately asks for the same flow cell, road tile, or geology sample, it reuses the doomed promise before the rejection handler removes it. The new request fails with the old request even though its own signal remains active.

In controlled probes, aborting request A and synchronously starting request B at the same coordinates caused both to reject with `AbortError`; waiting for cache cleanup allowed a later request to succeed. This can make road distance or geology evidence disappear during ordinary layout transitions.

#### M-54 — Collector gains and geometry are absent from CSV and GeoJSON

**Severity:** Medium  
**Confidence:** Confirmed by UI-to-export data-flow trace  
**Locations:** src/App.tsx:2084-2214 and 3053-3108; src/Reading.tsx:578-579, 1470-1482, 1584-1594, and 2358-2363; src/export.ts

The combined on-screen result can boost design flow, MW, and GWh using added collector intakes and can display their routes. `ExportContext` contains neither the collector inputs nor the combined-result multipliers/routes, and both exporters serialize only the base scheme. Thus exported capacity, energy, flow, layout, and provenance can disagree materially with the headline result the user intended to save.

#### M-55 — Several asynchronous results are not bound to a request or site identity

**Severity:** Medium  
**Confidence:** High; confirmed by control-flow trace, separate from H-35  
**Locations:** src/App.tsx:1384-1431, 1434-1478, 2035-2067, 2567-2597, 3045-3050, and 3153-3187

Multiple site-mutating operations lack a generation token, captured site check, or complete cleanup guard. A slower nearest-reach click can overwrite a later click; an old study can still set ambiguity after awaited work; a collector requested for the previous site can append after collectors were cleared; donor-gauge adoption/import can finish after navigation; and a probe can attach neighbors from an earlier selection. H-35 documents the separately reproduced audit race; these remaining paths expose the same class of stale-site calculation error elsewhere.

#### M-56 — Long gaps or one-season records are normalized to full-year energy

**Severity:** Medium  
**Confidence:** Confirmed with a dated synthetic record  
**Locations:** src/engine/hydro.ts:299-329 and 408-487; src/measured.ts:364-456

Annual energy drops missing values, averages whatever observations survive, and multiplies that mean dispatch by 8,760 hours. It does not weight observations by represented time or require balanced seasonal coverage. `wetDryEnergy` likewise derives season shares from the surviving observation counts. The 90% annual-coverage check affects reliability metadata, but does not prevent the incomplete series from driving the headline or PPA estimate.

For a synthetic year with wet-season flow 10 and dry-season flow 0, the complete PPA result was **52.126416 GWh**. Removing every dry-season observation raised the result to **77.342040 GWh**, an inflation of **48.37%**, because the wet-only sample was treated as an entire year.

#### M-57 — Negative imported discharge can create additional available water

**Severity:** Medium  
**Confidence:** Confirmed by direct calculation  
**Locations:** src/measured.ts:214-323; src/App.tsx:1661-1689; src/engine/discover.ts:208-273

Imported negative flows are neither rejected nor clamped. The environmental-release rule takes a fraction of the minimum monthly mean, so a negative month creates a negative residual release. Subtracting that negative release then adds water to every candidate flow.

For January values of -100 and February values of 1, the derived release was -10. A river flow of 1 consequently produced design flow **11** instead of **1**; the controlled evaluation increased energy from **6.05749 GWh** to **73.5358 GWh**. Negative discharge may be a sensor flag or invalid value, but it cannot be allowed to manufacture water.

#### L-58 — DoED and public-gauge longitude prefilters are too narrow for a kilometre radius

**Severity:** Low  
**Confidence:** Confirmed with a boundary counterexample  
**Locations:** src/context.ts:109-137; src/gauges.ts:141-163

The bounding-box pads use a latitude-like degree conversion for both latitude and longitude. Longitude degrees are narrower at Nepal's latitude. At 28°N, a synthetic point 0.0609423° away in longitude is **5.983 km** away by haversine distance, but the 6 km DoED query rejects it before computing that distance. The public-gauge candidate prefilter applies the same faulty assumption with `maxKm / 111`. Real licences and gauges near the east/west boundary can therefore be omitted.

#### L-59 — A constant exact-decade FDC produces `NaN` SVG coordinates

**Severity:** Low  
**Confidence:** Confirmed by component rendering  
**Location:** src/charts.tsx:52-68

When every plotted discharge is exactly 0.1, 1, 10, or another power of ten, logarithmic rounding makes `yMin === yMax`. The vertical transform then divides by `log10(yMax / yMin) = 0`. Rendering a constant 1 m³/s FDC emitted React warnings and SVG path/text coordinates containing `NaN`, so a valid constant-flow import can break the chart.

#### L-60 — Literal mojibake appears in exported and on-screen engineering text

**Severity:** Low  
**Confidence:** Confirmed by source inspection  
**Locations:** src/export.ts:104, 180, and 381; src/Reading.tsx:3284, 3296, and 3309; src/App.tsx:547

Several user-visible strings contain literal `Â·`, `kmÂ²`, `â€”`, or `â€¢` sequences. These are not terminal display artifacts; they are stored in source and can appear in exports, source/provenance labels, and the validation UI. This weakens evidence readability and can make unit labels ambiguous.

#### L-61 — The Modified HYDEST FDC can increase toward lower flows

**Severity:** Low; currently latent outside checks/supporting tools  
**Confidence:** Confirmed by a full bundled-reach scan  
**Location:** src/engine/modified-hydest.ts:128-227

Each exceedance quantile is produced by an independent regression row with no monotonicity enforcement or warning. A physical FDC must satisfy Q0 ≥ Q5 ≥ … ≥ Q100. Of 23,789 bundled reaches with usable inputs, **11,787 (49.55%)** had at least one reversal; 1,789 had Q0 below Q5 and 11,162 had Q95 below Q100.

For one reach, Q95 was 0.003126 m³/s while Q100 rose to 0.007388 m³/s. The implementation may faithfully reproduce workbook coefficients, but an invalid FDC shape should not silently pass as a hydrologic result.

#### L-62 — Half-cell bank scans introduce a directional rounding bias

**Severity:** Low  
**Confidence:** Confirmed with a symmetric terrain fixture  
**Locations:** src/pondage.ts:212-217 and 262-289

Bank searches advance by half a cell and use JavaScript `Math.round` to select raster indices. `Math.round(0.5)` advances to 1, while `Math.round(-0.5)` becomes negative zero, so opposite directions do not sample symmetrically. On a symmetric 21×21, 30 m valley at 10 m stage, the inferred endpoints extended 30 m on one side but only 15 m on the other, yielding a 45 m dam. The half-cell bias can alter short-axis pondages by one or more cells.

#### M-63 — An outlying third flow model can overpower two agreeing sources

**Severity:** Medium  
**Confidence:** Confirmed by direct and full-input scans  
**Location:** src/engine/flowchoice.ts:188-253

When the network and primary model agree within the allowed factor, the Modified HYDEST estimate is still blended without an outlier or domain bound. The output can therefore move more than 3× away from both agreeing estimates while the reported network/model disagreement remains 1×.

Across 23,789 usable bundled reach inputs, the regional/network ratio was below 1/9 or above 9 at 114 reaches, enough for the square-root blend alone to shift by more than 3×. At one reach, network and model were both **52.218 m³/s**, Modified HYDEST was **3.100 m³/s**, and the chooser returned **12.723 m³/s** with reported disagreement **1.0**—a 75.6% reduction and more than 4× below both agreeing sources.

#### L-64 — The local GloFAS store accepts and describes incomplete years as complete

**Severity:** Low  
**Confidence:** Confirmed by full date-axis and cell inspection  
**Locations:** pipeline/build-glofas-store.py:57-90; pipeline/glofas-store.mjs:65-114; src/api.ts:161-194

The local store contains 7,304 dates from 2006-01-01 through 2025-12-30; the inclusive period through 2025-12-31 requires 7,305. At the inspected 27.875°N, 86.225°E cell, 2024-12-31 is null and 2025-12-31 is absent. The 99% row-count threshold nevertheless accepts both years and the source is described as a complete 2006–2025 daily record. The numerical impact is small, but completeness/provenance claims are incorrect.

#### L-65 — HYDEST's reported driest month excludes November and December

**Severity:** Low  
**Confidence:** Confirmed by formula trace and full bundled-input scan  
**Locations:** src/engine/hydest.ts:105-108, 143-156, and 177-188

The low-flow selector examines only January through May even though the MMP-based monthly calculation provides all twelve months. In 34,669 complete bundled inputs, 31 had their true modelled annual minimum outside that window. The largest sampled overstatement was **13.19%**: the function reported March at 0.992906 m³/s while December was 0.877188 m³/s. This is rare in the current dataset but systematically prevents a late-year minimum from being reported.

#### H-66 — Gauge proximity can label a neighbouring branch as the same river

**Severity:** High  
**Confidence:** Confirmed by a full bundled-gauge topology probe  
**Locations:** src/gauges.ts:135-262; src/rivers.ts:1070-1129 and directed-connectivity helpers

A gauge is called `upstream` when its downstream walk merely passes within 1.5 km of the study head, and `downstream` when the study path passes within 1.5 km of the gauge coordinate. Neither test requires the two points to occupy one directed HydroRIVERS route. `trustworthy` then checks only that this proximity relation exists and that the area ratio lies between 0.5 and 2.

Using every bundled discharge station as an anchor produced 403 `upstream` and 144 `downstream` labels. Against the bundled directed reach graph, 66 upstream and 35 downstream labels had no corresponding network connection; 22 and six respectively were still marked trustworthy. Twelve of 344 trusted recommendations also contradicted the catchment direction—for example, an alleged downstream gauge had a smaller drainage area than the study site, or an upstream gauge had a larger one. Concrete false connections included Bagmati at Sundarijal to Dhobi Khola at Chabahil and Tadi at Rautar to Likhu at Pattawari. A 1.5 km valley-distance tolerance can bridge tributaries and transfer the wrong river's record while the UI explicitly endorses it.

#### M-67 — Collector-boosted headline results do not propagate into grid, PPA, or readiness calculations

**Severity:** Medium  
**Confidence:** Confirmed by data-flow and threshold counterexamples  
**Locations:** src/App.tsx:2084-2214 and 2272-2281; src/Reading.tsx:105-175, 645, 984-1028, 1467-1503, 1670-1724, and 2563-2629

Collector intakes can increase the displayed design flow, capacity, and energy through `combinedMW` and related headline values. Grid-voltage advice, PPA treatment, readiness, household equivalents, and explanatory equations continue to use the unboosted base scheme. A 24 MW base project with a 10% collector gain is presented as 26.4 MW while its grid logic still evaluates 24 MW; a 95 MW base result boosted above 100 MW still receives the below-100 MW PPA treatment. The page can therefore present mutually incompatible commercial and engineering interpretations of the same headline project.

#### M-68 — The terrain-fallback search window is too narrow east–west

**Severity:** Medium  
**Confidence:** Confirmed geometrically  
**Location:** src/api.ts:544-601

`traceDownhill` builds both latitude and longitude bounds with `spanDeg = maxKm / 111`. That is approximately correct for latitude, but longitude degrees shrink by `cos(latitude)`. At 28°N, the nominal 22 km east/west half-width covers only about **19.4 km**, so a permitted downhill trace can leave the fetched tile window roughly 2.6 km early. The undercoverage grows at higher latitudes. The supposedly distance-bounded terrain fallback can therefore stop or fail solely because its raster window does not contain the distance it promises to search.

#### L-69 — The 0.4 km minimum waterway accepts a 0.36 km scheme

**Severity:** Low  
**Confidence:** Confirmed with a direct synthetic discovery case  
**Locations:** src/engine/discover.ts:143 and 368-385

The minimum point separation is calculated with `Math.round(minWaterwayKm / spacingKm)` instead of rounding upward. With 0.12 km spacing, the 0.4 km minimum becomes three steps, or 0.36 km. A controlled 12-point path with a 25 m drop and 10 m³/s flow retained the `(8,11)` scheme at **0.36 km**, **75 m** head, and **6.2034 MW**, and even labelled it as the shortest/steepest/steadiest candidate. The configured minimum is therefore not an actual minimum.

#### M-70 — Pondage channel-bed snapping can jump to an unrelated depression or branch

**Severity:** Medium  
**Confidence:** Confirmed with a synthetic terrain counterexample  
**Locations:** src/pondage.ts:220-259 and 291-303

The pondage seed search considers every cell in a 210 m upstream half-plane and minimizes elevation plus a small distance penalty; it does not require the cell to lie on, drain to, or be connected with the selected river. A cell 150 m away needs to be only about 6 m lower to beat the clicked channel cell.

On a controlled 15×15, 30 m grid with a 100 m river-bed cell and an unrelated 90 m lateral depression 150 m away, a 10 m pondage request selected the depression (`seedMovedM = 150`) and returned one flooded cell, **900 m²**, and **9,000 m³**. The result is numerically consistent with the wrong depression, not the selected channel. This confirms the method risk described in R-03.

#### M-71 — DHM transfer grades ignore actual catchment similarity

**Severity:** Medium  
**Confidence:** Confirmed by formula inspection and fleet-wide attribute comparisons  
**Locations:** src/dhm.ts:93-159; src/App.tsx:2035-2067; src/Reading.tsx:1310-1390

The donor grade uses only straight-line distance and drainage-area ratio. It does not check directed river connectivity, basin identity, rainfall, elevation regime, glacier influence, or seasonal similarity, yet the UI says close catchments “resemble” each other and allows the record to replace both models. Among 123 fleet sites with an offered donor, 46 were `close`, 70 `usable`, and seven `indicative`; across 137 validation/fleet sites, 21 of 51 `close` matches were not connected in the bundled directed network.

One `close` Sabha Khola recommendation selected Sabhaya 11.8 km away at a 0.68 area ratio despite bundled precipitation of approximately 2,118 versus 1,164 mm and an average-altitude difference over 3,100 m. Directed-network misses can include network-data errors, but the implementation never performs the check at all. Area and proximity alone do not establish transferable hydrologic response.

#### M-72 — Desander bench fitting can assemble one “bank” across both banks and the active river

**Severity:** Medium  
**Confidence:** Confirmed with a symmetric cross-section fixture  
**Location:** src/engine/sediment.ts:227-289

Bench fitting finds one continuous low-slope run across the entire cross-section, then labels it left or right using only its midpoint. It never splits the profile at the river centre, excludes the wetted channel, or requires all usable width to lie on one bank.

On a synthetic section sampled from -250 to +250 m, with a flat valley floor between -125 and +125 m and rising terrain outside it, a required 150 m bench was reported as a **200 m fitting right-bank bench** even though neither sampled bank alone supplied more than 100 m. The reported construction platform silently included the river and the opposite bank.

#### H-73 — A measured override remains controlled by the discarded model arbitration

**Severity:** High  
**Confidence:** Confirmed by data-flow trace and direct scheme counterexample  
**Locations:** src/App.tsx:1563-1589 and 1631-1695; src/Reading.tsx:727-788; src/export.ts:183-230

The app computes `flowChoice` from the network/global/regional models before considering an imported or borrowed measured series. Although the measured record then replaces the modelled series and the UI/export say it “replaces both global models,” the old model authority still rewrites the path: `model` authority zeroes every path mean, `hydest` makes it constant, and only the network/blend branch preserves downstream catchment growth. The discarded model decision thus controls how a supposedly authoritative measurement is transported along the waterway.

With the same measured series (mean 10 m³/s), geometry, and a path whose network mean grows from 10 to 100 m³/s, network authority produced a 10× intake scaling, **131.041 MW**, and **1,108.597 GWh/year**. Changing only the pre-measurement authority to model/HYDEST flattened the same measured study to about **12.778 MW** and **108.094 GWh/year**. The flow-source panel also continues to describe the model arbitration while measured data are active. This is a material hidden dependence on evidence the page claims it discarded.

#### M-74 — Gauge donors are graded and scaled against the clicked head catchment, not the selected intake catchment

**Severity:** Medium  
**Confidence:** Confirmed by data-flow trace and all-station downstream scans  
**Locations:** src/App.tsx:149-165, 1721-1730, 2035-2043, and 2084-2094

`StudyPoint` carries coordinates, elevation, distance, and mean flow but no drainage area. Gauge suggestions pass intake coordinates while retaining `study.reach.uplandKm2`, the area at the original clicked/head reach. Public-gauge suggestions and collector warnings likewise reuse that one head area over the full path. The donor can therefore be selected, graded, and linearly scaled with the wrong catchment for the actual intake.

Scanning 131 DHM station anchors without main-stem promotion, 87 paths had more than 1% catchment growth within 2.04 km, 33 grew at least 1.5×, and 26 at least 2×. Extreme application metadata included Seti growing from 2.64 to 1,465.72 km² within 1.56 km, Ankhu from 8.51 to 744.27 km², and Pathariya from 0.768 to 32.06 km². Some extremes reflect the path-metadata limitations already acknowledged elsewhere, but that is exactly the metadata the calculation uses downstream while donor transfer remains frozen to the head value. H-73 can then disable the engine's only subsequent growth correction.

#### M-75 — `downstreamPath` can exceed its declared maximum distance

**Severity:** Medium  
**Confidence:** Confirmed by code trace and an all-station path scan  
**Location:** src/rivers.ts:1070-1129

The path walk appends the full stored vertex segment that crosses `maxKm` and only checks the limit on the next loop. It then resamples that entire overshooting segment rather than clipping it at the requested distance. With `maxKm = 22`, 117 of 131 station-anchor paths exceeded 22 km; the maximum was **25.92 km** at Karnali station 240, an overshoot of **3.92 km or 17.8%**. Tadi returned 23.88 km and several Bagmati, Sun Koshi, and Tamor paths returned 23.76 km. Search, gauge-relation, and terrain requests that rely on the advertised corridor can therefore inspect materially farther than configured.

#### M-76 — Canal/tunnel classification switches banks independently at every station

**Severity:** Medium  
**Confidence:** Confirmed with an alternating-bank terrain fixture  
**Locations:** src/engine/corridor.ts:96-119; src/App.tsx:1605-1620; src/Reading.tsx:1780-1789

At every cross-section the corridor uses the smaller absolute cross-slope from the left and right probes, discarding which bank supplied it. A route may therefore alternate banks from one station to the next without any river-crossing distance, structure, or penalty, while being summarized as one continuous canal corridor.

A four-station fixture alternating elevations `[0,10,100]` and `[0,100,10]` returned **canal fraction 1**, **tunnel 0 km**, and 10% median/steepest chosen slope. In reality, each individual bank has the prohibitive 100-unit side at half the stations; following the locally gentler side requires crossing the river repeatedly. The current result is a lower envelope of two incompatible alignments, not a buildable bank route.

#### L-77 — Pondage “backwater reach” is a one-axis projection, not river or reservoir length

**Severity:** Low  
**Confidence:** Confirmed by formula trace  
**Locations:** src/pondage.ts:354-361; src/Reading.tsx:1873-1878; src/export.ts:1115

The reported upstream extent is the maximum negative projection of flooded cells onto the single local downstream direction at the dam. It is not distance along the river, reservoir centreline, or inundated flow path. In a winding valley—such as a 90° bend—the reservoir can extend far upstream while its projection stops growing or even collapses toward zero. The UI calls this “Backwater reach” and the export calls it `upstreamLengthM` without identifying the projection, so an engineering-looking length can substantially understate the actual impoundment reach.

#### L-78 — The household-use control violates its displayed 100 kWh/year minimum

**Severity:** Low  
**Confidence:** Confirmed by UI-handler inspection  
**Locations:** src/Reading.tsx:1670 and 3383-3388

The input advertises `min=100`, but its change handler accepts any parsed value down to 1. Entering 1 kWh per household-year inflates the household-equivalent headline by 100× relative to the stated minimum and about 912× relative to the Nepal default. Browser validation does not protect calculations performed immediately by a controlled React input. This does not alter MW or GWh, but it can create a grossly misleading public-impact comparison.

#### M-79 — Historical Bikram Sambat years below 2050 are silently treated as Gregorian

**Severity:** Medium  
**Confidence:** Confirmed by direct parser counterexample  
**Locations:** src/measured.ts:95-145 and 265-295

The import parser uses 2050 as the lower boundary for detecting Bikram Sambat years. Nepalese records using earlier BS years are therefore treated as Gregorian dates instead of being converted. The error changes the calendar year by roughly 57 years and changes the month/season mapping used for environmental release, tariff allocation, and record summaries.

An accepted three-row file containing `2040-01-01` through `2040-01-03` was returned as daily data in Gregorian year 2040 with no BS warning. A historical BS 2040 record should instead fall around 1983/84 AD. The ambiguity must be explicit or metadata-driven; a hard year boundary silently misdates valid archive data.

#### H-80 — The site audit can replace the hydrograph with an unrelated neighbouring grid cell based only on seasonal shape

**Severity:** High  
**Confidence:** Confirmed by code trace and a full usable-station sweep  
**Locations:** src/audit.ts:98-195; src/App.tsx:3153-3177

The audit scores the current GloFAS cell and its eight neighbours after normalizing every monthly regime to mean 1. It then automatically adopts a neighbour if its shape score improves by more than 0.12. Magnitude is deliberately removed, but no river, drainage-area, flow-direction, or catchment-topology constraint is added in its place. A seasonally similar cell on a different channel can therefore replace the studied river's time series.

Using the local GloFAS store and 131 usable DHM station anchors, the rule switched **45** sites. In **43 of 45**, the chosen cell's unnormalized mean differed from the incumbent by more than 2×, and in **32** it differed by more than 10×. Examples included Rapti Jalkundi changing from 159.16 to 0.28 m³/s (574×), Kali Gandaki from 485.91 to 1.33 m³/s (364×), and Bagmati from 148.67 to 0.49 m³/s (302×). Re-running flow arbitration changed the effective authority flow at three anchors, including Arun Khola from 6.77 to 25.98 m³/s. Seasonal resemblance alone is not site identity.

#### L-81 — The top uncertainty explanation doubles the displayed contribution of each driver

**Severity:** Low  
**Confidence:** Confirmed by formula and display trace  
**Locations:** src/engine/uncertainty.ts:147-181; src/Reading.tsx:172-175 and 1569-1604

Each driver's `swingPct` is calculated from the complete low-to-high endpoint difference divided by the best estimate. The detailed uncertainty rows correctly display half that range as `±swingPct / 2`, but the top-driver summary describes the full `swingPct` as a plus/minus effect. The same sensitivity is therefore stated at twice its calculated half-width in one prominent explanation.

#### M-82 — The collector gravity threshold is smaller than the stated DEM elevation error

**Severity:** Medium  
**Confidence:** Confirmed by direct collector fixtures  
**Locations:** src/collector.ts:27-49, 143-145, and 180-219

Collector feasibility accepts only 2 m of positive headroom, although the implementation itself describes terrain elevation as uncertain by approximately ±15 m. A direct fixture with a main intake at 100 m and a collector at 102.1 m over a 1 km channel returned `ok`; a second with only 5.1 m fall over 5 km also returned `ok`. Both apparent gravity margins lie well inside the elevation error and can reverse sign. The screen should not present them as confirmed gravity-feasible without an uncertainty margin or survey qualification.

#### M-83 — Collector gain uses discarded raw network flow when the main study uses another flow authority

**Severity:** Medium  
**Confidence:** Confirmed by data-flow trace  
**Locations:** src/App.tsx:1663-1681 and 2085-2215; src/collector.ts:245-255

The main engine rewrites path means according to `flowChoice`: it can zero the network model, substitute HYDEST, blend sources, or use a measured record. Collector calculations instead receive the original `study.path[scheme.i].meanCms` and raw tributary reach means, then compute their gain from that raw ratio. A network estimate the main calculation explicitly rejected can consequently determine collector MW and GWh. The combined headline is not hydrologically consistent with the base plant it augments.

#### M-84 — Pointwise MERIT upstream-area lookup bleeds across close confluences

**Severity:** Medium  
**Confidence:** Confirmed by full channel-point scan and a named confluence reproduction  
**Locations:** src/rivers.ts:458-510; pipeline/build_merit_upa.py

Per-vertex upstream area is sampled from the nearest MERIT accumulation cell without ensuring that the cell belongs to the vertex's river branch. Across 3,823 sampled channel points, MERIT area exceeded the reach area by more than 2× at 6.3% of points. For order-1 channels the rate was 8.9%, the 99th percentile ratio was 74×, and the maximum was 4,954×. These values feed HYDEST, Modified HYDEST, DHM transfer, flow provenance, and overwhelming-main-stem logic.

At Mistri Khola, a roughly 321 km² tributary and the roughly 3,969 km² Kali Gandaki read the same approximately 3,638 km² accumulation near their close confluence. This is not merely a source-resolution caveat: the runtime adopts the contaminated point value as the selected reach's catchment and propagates it into calculations.

#### H-85 — The 100× automatic “main stem” promotion has a measured false positive

**Severity:** High  
**Confidence:** Confirmed against bundled project metadata and a live calculation path  
**Locations:** src/rivers.ts:582-680 and 759-786; src/App.tsx:1443-1502

The overwhelming-river rule automatically replaces a selected stream when a nearby candidate has at least 100 times its drainage area. Upper Syange Khola is a real 2.4 MW project on an approximately 15.7 km² khola, yet the 2,483 km² Marsyangdi lies 1.33 km away and is 158× larger, so the heuristic promotes it and the application reports approximately **301 MW**. The original project's specific flow is ordinary rather than evidence that its named stream is spurious.

The threshold does not separate known cases: Upper Tamakoshi's intended correction is about 218×, this false Upper Syange correction is 158×, while Seti can need promotion at only about 8.3×. Area ratio alone cannot establish river identity. This finding concerns the selector choosing the wrong river; C-01 separately concerns failure to apply a chosen promotion consistently to the path.

#### M-86 — Empty date strings become a fictitious “year 0” reliability record

**Severity:** Medium  
**Confidence:** Confirmed by direct reliability counterexample  
**Locations:** src/engine/hydro.ts:456-487; src/engine/discover.ts:288-317; src/measured.ts:265-320; src/App.tsx:1645-1689

Reliability grouping converts the first four characters of each date with `Number(...)`. For an empty string this yields integer zero, so undated observations are grouped into calendar year 0 rather than excluded from interannual analysis. A 365-value undated constant-flow record produced a year-0 result with 365 days, 99.73% coverage, nonzero annual energy, and derived P50/P90 reliability. It has no calendar evidence for any year. H-06 covers the separate zero environmental-release problem for no-date data; this defect fabricates interannual reliability evidence.

#### L-87 — Road screening loses a successful endpoint when the other endpoint exhausts both routers

**Severity:** Low  
**Confidence:** Confirmed with deterministic mocked router responses  
**Location:** src/access.ts:61-132

Intake and powerhouse road searches run inside one `Promise.all`. If one coordinate fails on both routers, the whole screen rejects and discards a valid result already returned for the other coordinate. In a direct fixture, the intake received HTTP 500 from both services while the powerhouse received a valid road 157 m away; `screenRoadAccess` rejected instead of preserving the powerhouse evidence and marking only intake access unavailable. This makes the access result less informative exactly where partial evidence is needed.

#### M-88 — Readiness calls terrain sources corroborated despite a large relative head disagreement

**Severity:** Medium  
**Confidence:** Confirmed by direct readiness fixture  
**Location:** src/readiness.ts:253-275

Any second-terrain audit with an absolute head difference of at most 10 m is labelled corroborated, regardless of the scheme's total head. The discovery engine permits gross heads as low as 15 m. A fixture with one source reporting 15 m and the second 6 m returned `corroborated` and a summary that the sources “agree,” even though the difference is 60% of the headline head. Absolute and relative tolerances are both necessary near the low-head boundary.

#### L-89 — Local isohyet overlap resolution ranks latitude span instead of polygon area

**Severity:** Low  
**Confidence:** Confirmed against the bundled private isohyet polygons  
**Location:** src/local-gis.ts:116-135

When multiple rainfall bands contain a point, the function promises to choose the smallest containing band but ranks polygons only by their maximum-minus-minimum latitude. It ignores longitude extent and actual polygon area. At (27.04, 86.04) and (27.16, 84.98), the code chose the 2,000 mm band with approximate planar area 0.736 deg² over the smaller 1,800 mm band at 0.686 deg². A second mismatch occurred near (27.58, 88.02). Private survey-sheet rainfall context can therefore depend on an unrelated bounding-box dimension.

#### L-90 — Neighbour probing is not marked as scratch and can evict studied sites from the flow cache

**Severity:** Low  
**Confidence:** Confirmed by cache call-site trace  
**Locations:** src/api.ts:112-136 and 302-322

The discharge cache deliberately supports `scratch=true` so eight-cell probes are inserted at the back and do not evict the engineer's real sites from the 12-entry cache. `auditShape` uses that flag, but `probeNeighbours` calls the same fetcher without it. One probe can insert eight ordinary most-recent entries, evict earlier studies, and cause avoidable network calls or quota use when the user returns to them.

#### L-91 — The compact no-turbine equation multiplies generator efficiency twice

**Severity:** Low  
**Confidence:** Confirmed by engine/UI formula trace and direct fixture  
**Locations:** src/engine/discover.ts:265-267 and 331-337; src/Reading.tsx:1674-1728

When no turbine envelope applies, the engine still calculates with the input generator efficiency and stores that same value as `turbinePeak`. The compact equation then displays `turbinePeak × generator efficiency`, effectively squaring it. A fixture with 0.96 efficiency produced an engine factor of 0.96 but a displayed factor of 0.9216. The already-unsupported positive result is covered by H-37; this finding is the independent mismatch between the displayed equation and the number actually calculated.

#### M-92 — A measured record is rescaled again by downstream network growth at a nonzero intake index

**Severity:** Medium  
**Confidence:** Confirmed by direct two-intake engine fixture  
**Locations:** src/App.tsx:1640-1691; src/engine/discover.ts:201-250

The application describes measured data as replacing the models and passes the series mean using the network flow at path index zero. The engine nevertheless scales the measured FDC by `path[i].meanCms / seriesMeanCms`. Only an intake at index zero has a guaranteed ratio of one; any downstream selected intake inherits the raw or authority-rewritten network growth in addition to the measured record.

With a constant measured record of 10 m³/s and path means of 10 m³/s at index zero and 20 m³/s at index one, the first intake used flow scale 1 and design flow 10 m³/s, while the second used flow scale 2 and design flow 20 m³/s. Its capacity changed from 15.93 to 24.21 MW. Unless the measurement location and transfer method are explicitly established, the imported values should not silently be doubled by a model they replaced.

#### M-93 — Detailed seismic, conservation, and private local-GIS evidence is omitted from exports

**Severity:** Medium  
**Confidence:** Confirmed by screen-to-export field trace  
**Locations:** src/export.ts:31-93; src/App.tsx:2079-2081, 2284-2335, and 3050-3110

The screen calculates and displays 475-year PGA, nearby earthquake counts and largest event, protected-area names and regimes, municipality/survey-sheet context, local buffers, and isohyet evidence. `ExportContext` and the constructed export object contain none of the `seismic`, `conservation`, or `localGis` result objects. Readiness can preserve a generic conservation count or hard-stop summary, but CSV and GeoJSON omit the calculated values and identities needed to review why that conclusion was reached. A downloaded handoff can therefore lose material siting and design evidence visible on the page.

#### H-94 — Regional catchment inputs remain anchored to the click while the selected intake can move across a confluence

**Severity:** High  
**Confidence:** Confirmed by data-flow trace and 338-anchor downstream scan  
**Locations:** src/App.tsx:149-165, 1558-1584, 1750-1820, and 2420-2432; src/engine/discover.ts:119-250; src/rivers.ts:1041-1129

The discovery engine can choose an intake up to approximately 2 km downstream and uses the path point's flow there. The surrounding regional calculations remain tied to `study.reach`, the original clicked/head reach: this area drives flow arbitration, HYDEST, Modified HYDEST, MHSP, hypsometry, and sediment context. Although the path data contain per-point upstream area, `StudyPoint` drops it and the application cannot realign these inputs to the selected intake.

Across 338 bundled station/project anchors, upstream area increased by more than 20% within the first 2 km at 103 anchors, by more than 2× at 60, and by more than 10× at 24. Examples included Bagmati Bhorleni from 2.93 to 1,703.57 km² within 1.92 km, Melung from 10.16 to 3,250.03 km² within 1.68 km, and Srugad from 58.36 to 9,746.09 km² within 1.44 km. Some extreme changes also expose pointwise metadata limitations, but they are the exact values the engine uses. A selected downstream intake can thus receive the larger branch's network flow while all independent flow checks and sediment descriptors still describe the tiny upstream click catchment. M-74 covers the narrower donor-transfer instance; this affects the complete regional calculation context.

## Pondage accuracy assessment

The core fixed-stage flood is a reasonable first-pass screening concept: it uses a seed, a stage, connected cells, and an explicit barrier. This resembles [GRASS r.lake](https://grass.osgeo.org/grass84/manuals/r.lake.html), which fills connected cells below a specified water level using a 3×3 neighborhood. The simple barrier fixtures and 500 smooth randomized surfaces remained monotonic. They did not expose the moving-axis defect in H-49: adversarial rugged terrain did, and proved that the implemented multi-stage result is not a fixed-reservoir stage curve.

However, the present result should be labelled a **DEM screening envelope**, not an accurate reservoir survey. The following are method/data limitations rather than proven coding errors:

### R-01 — Full-cell integration creates 30 m stair steps

Any cell center below stage contributes its full 900 m² area. There is no sub-cell shoreline interpolation or partial-cell volume integration. At small pondages, a one-cell change is 0.09 ha and can dominate the answer.

### R-02 — The dam axis is inferred, not optimized or terrain-validated

The axis is drawn perpendicular to a single downstream direction. It is not searched across alternative abutments, limited by a confirmed structural crest length, or scored for impoundment performance. Whitebox’s impoundment workflow explicitly accepts a maximum dam length and evaluates impoundment area/volume/height; see the [Whitebox Next Generation hydrology documentation](https://github.com/jblindsay/whitebox_next_gen/blob/main/crates/wbw_python/docs/tools_hydrology.md) and [legacy implementation](https://github.com/jblindsay/whitebox-tools/blob/master/whitebox-tools-app/src/tools/hydro_analysis/impoundment_index.rs).

### R-03 — Upstream bed selection is not constrained to a connected channel

The algorithm chooses a low cell within a 210 m upstream half-plane using elevation plus a distance penalty. It can choose a ditch, pit, floodplain cell, or adjacent tributary rather than the intended river thalweg. This risk is now confirmed by the synthetic counterexample in M-70 and is counted there rather than separately here.

### R-04 — DEM-window edges can turn the secondary result into a lower bound

At the live site and 10 m retained level, the primary result was 1 cell, 0.09 ha, and 0.009 Mm³, while the secondary side reached the DEM edge and reported at least 6,052 ha and at least 31,507 Mm³. The UI correctly warns that the second result is edge-limited, but the enormous divergence shows that local seed/axis/topology choices dominate the answer. Neither side is suitable for a feasibility claim without a larger hydrologically conditioned DEM, channel/axis review, and sensitivity analysis.

### R-05 — An axis-limited result does not trigger the larger DEM retry

`screenPondageSource` expands its terrain request from 6 km to 10 km only when a result is `edgeLimited`. If a bank cannot be found inside the initial terrain and the result is `damAxisLimited`, delineation switches to a fallback half-plane, which may no longer touch the DEM edge. The method can therefore return an axis-limited approximation without fetching the larger window that might contain the missing abutment. The UI warns about axis limitation, but the geometry and storage may change substantially if the terrain extent is expanded.

### R-06 — The two-DEM comparison also changes the inferred reservoir geometry

Each DEM source independently rediscovers the upstream bed, water-level datum, bank crossings, axis endpoints, and barrier. The comparison therefore mixes terrain-source sensitivity with a different inferred dam and reservoir on each source. A defensible terrain comparison should hold the surveyed/user-reviewed dam axis, reference bed, crest datum, and calculation mask fixed, then change only the elevation surface.

### Accuracy path supported by existing open-source methods

A stronger screening implementation should first freeze one reviewed dam axis and bed/crest datum, calculate every stage against that same barrier, require nested inundation masks and nondecreasing area/volume, and integrate shoreline-crossing cells rather than assigning each 30 m cell wholly wet or dry. Axis-length and abutment constraints should be explicit inputs. [Whitebox's Impoundment Size Index](https://github.com/jblindsay/whitebox_next_gen/blob/main/crates/wbw_python/docs/tools_hydrology.md) is a useful reference because it accepts maximum dam length and produces impoundment area, volume, and height surfaces.

For more defensible geometry, use a hydrologically conditioned bare-earth DTM, a surveyed or user-reviewed river thalweg and dam cutline, contour-based stage–area–volume integration, and uncertainty runs for vertical DEM error and horizontal axis placement. [CNES dem4water](https://github.com/CNES/dem4water) demonstrates water-occurrence-assisted dam-foot/cutline detection, cutline scoring, contour cutting, and Z–S–V curve construction with manual correction. [GeoLibre](https://github.com/opengeos/geolibre-rust) provides fixed-level storage-capacity and fill/spill/merge concepts, while [GeoCARET](https://github.com/Reservoir-Research/geocaret) provides a broader reservoir/catchment assessment workflow.

Validation should be independent of the DEM fill: compare predicted shorelines with multi-date Sentinel/Landsat water occurrence; derive observed area–elevation or hypsometric relationships where possible; and calibrate against surveyed contours, bathymetry, or known reservoirs. [InfeRes](https://github.com/Critical-Infrastructure-Systems-Lab/InfeRes) combines satellite water area and higher-resolution DEMs for reservoir delineation and storage relationships. USGS examples explicitly publish surveyed [stage–area and stage–volume tables](https://www.usgs.gov/data/bathymetry-stage-area-and-stage-volume-tables-calaveras-reservoir-california-2019-ver-20-march), illustrating the evidence standard needed beyond screening.

Another useful comparison is [BDSWEA](https://github.com/konradhafen/beaver-dam-water-storage), which requires a DEM, flow-direction raster, stream network, dam location, and dam height. Those additional constraints illustrate what the present local fill does not yet establish. A recent published validation discussion is available in [Scientific Reports](https://www.nature.com/articles/s41598-025-30483-7).

## Known model and source-data limitations

These were already documented or are inherent screening limitations; they are not counted among the 94 defects:

- About 4% of known plants can underpredict when project coordinates land on a nearby tributary rather than the intended river.
- OSM geometry is intentionally a separate representation from HydroRIVERS and can disagree even when neither source is “wrong.”
- Existing flow validation reports typical error factors of about 1.48× nationally and 1.62× when project-weighted. That supports screening and prioritization, not bankable design flow.
- HydroBASINS rainfall/elevation fractions are assigned at reach sampling locations while some displayed catchment areas come from pointwise MERIT accumulation. The audit did not establish that those numerator/denominator catchments are identical at every snapped site.
- A road route from public OSM data cannot prove year-round motorability, width, load capacity, ownership, landslide condition, or construction access.
- Reservoir sedimentation, geotechnical permeability, dam freeboard, spillway/flood routing, resettlement, environmental constraints, and bathymetric survey are outside the pondage calculation.

## Checks that passed

The following checks did not reveal a defect within the implemented assumptions:

- Power follows P = ρgQHη, and the MW/GWh unit conversions are internally correct.
- Environmental release is subtracted before design-flow capping in normal dated-data operation.
- Dispatch recomputes Q² head loss, and energy integrates the turbine curve for each flow.
- FDC sorting, Weibull exceedance positions, and interpolation are internally consistent.
- PPA tariff conversion and wet/dry allocation are correct for genuinely daily, uniquely dated data.
- Interannual P50/P90 ordering is correct for unique complete daily years.
- Haversine distance, local distance conversion, region containment, grid voltage/distance, fault distance, hazard/protected-area geometry, and seismic bilinear interpolation passed targeted checks.
- HYDEST, Modified HYDEST, and the currently encoded MHSP formulas reproduce their references and repository tests; their physical/output constraints remain subject to H-11, L-61, and L-65.
- Pondage’s connected fill passed simple synthetic barrier tests and 500 smooth-surface monotonicity probes. Those checks do not pass on rugged/adversarial terrain because the axis changes between stages (H-49).
- The pondage terrain-ruggedness implementation matches the ArcHydro root-mean-square TRI convention described by [Esri](https://community.esri.com/t5/water-resources-blog/terrain-ruggedness-index-tri-and-vector-ruggedness/ba-p/884340) and used in a recent [published reservoir-screening validation](https://pmc.ncbi.nlm.nih.gov/articles/PMC12749584/); it was not counted as a defect.
- CSV output quoting and GeoJSON longitude/latitude order passed export checks for schemes present in the retained scheme list; H-51 and M-54 cover omitted selected/collector layouts, and the pondage field-name defect remains.
- The current HydroRIVERS binary has 42,197 reaches, a maximum of 43 vertices per reach, and an expected byte length matching its header/record structure.
- Searching every populated HydroRIVERS grid ring did not alter the tested midpoint choices; H-34 is specifically the vertex-distance/indexing method, not an unsupported claim about early ring termination.
- Basic DoED coordinate ranges, PGA dimensions/data length, grid coordinates, glacial-lake uniqueness/coordinates, and DHM discharge monotonicity invariants passed. DoED identity collapse is covered by M-52; the DHM date/month-column corruption in H-10 is separate from value monotonicity.

## Verification evidence

The following repository checks completed successfully:

    npm run check
    npx tsc --noEmit --pretty false

Independent probes included:

- live comparison before and after main-river promotion;
- live retention of a borrowed DHM record after selecting a different stream;
- live asynchronous-audit navigation race, followed by a fresh-site control audit;
- 131,458 HydroRIVERS segment-length checks and about 14,049 long-segment midpoint selections;
- SI/non-SI imports, quoted/thousands-separated CSV, ambiguous and impossible dates, no-date records, monthly records, and duplicate timestamps;
- malformed-date rows with valid numeric flows before and after gap filling;
- calendar-day versus equal-observation annual energy;
- turbine peak versus full-flow efficiency, turbine-region boundary continuity, no-turbine fallbacks, and curve upper bounds;
- raw waterway loss versus capped loss and plant-factor consistency;
- feasible equal and unequal multi-unit dispatches;
- uncertainty endpoint containment, infeasible endpoint handling, and 7,710 valid randomized flow perturbations;
- irregular corridor sampling;
- missing-terrain desander bench fitting;
- duplicate collector catchments;
- router fallback behavior;
- intake versus powerhouse protected-area proximity;
- extreme and randomized FDC shapes;
- direct-series versus trapezoidal FDC energy;
- full DHM calendar scans;
- HydroBASINS upstream-area comparisons;
- 500 smooth randomized pondage surfaces, 20,000 rugged surfaces, a deterministic backwards stage curve, directional bank rounding, and pondage GeoJSON winding;
- a live out-of-Nepal/global study and its rejected-flow control path;
- exports where the active custom layout was outside the retained top-eight schemes, plus collector-result data-flow tracing;
- synchronous replacement requests against aborted road and geology cache entries;
- wet-only versus complete-year PPA energy and negative-flow environmental-release propagation;
- all bundled DoED canonical keys, including licence/promoter/bounds review of collapsed groups;
- a longitude bounding-box boundary counterexample and an exact-decade constant FDC component render;
- a full 23,789-input Modified HYDEST FDC monotonicity scan and third-source flow-blend outlier scan;
- the complete local GloFAS date axis and a representative cell's missingness;
- all 34,669 complete HYDEST inputs for true driest-month placement.
- every bundled discharge station used as a study anchor, comparing 547 inferred gauge relations with the directed HydroRIVERS graph and checking 344 trusted area directions;
- all 123 fleet donor offers for grade and record-length eligibility, plus rainfall, elevation, and directed-connectivity comparisons;
- 131 station-anchor downstream paths for declared-distance overruns and intake-area growth;
- a 0.36 km discovery result against the configured 0.4 km minimum;
- a pondage seed displaced 150 m into an unrelated synthetic depression;
- a desander fixture whose reported bank bench crossed the river and used both banks;
- identical measured series under network, model, and HYDEST pre-measurement authorities;
- an alternating-left/right terrain fixture for continuous-corridor classification;
- a BS-2040 import, a 365-observation undated reliability record, and a measured two-intake downstream-scaling fixture;
- all current-plus-eight-neighbour shape audits at 131 usable station anchors, retaining both normalized scores and raw cell means;
- collector gravity fixtures inside the documented DEM error and raw-versus-selected-authority collector data-flow tracing;
- a mocked partial road-router failure that preserved one valid endpoint before the combined promise rejected;
- a low-head readiness fixture with a 60% terrain-source disagreement;
- every overlap in the bundled private isohyet polygons, comparing the implemented latitude span with polygon area;
- all 3,823 sampled channel points for pointwise MERIT/reach area ratios, including the Mistri Khola confluence;
- the Upper Syange project against the automatic main-stem heuristic and its specific-flow control;
- all 338 bundled station/project anchors for catchment growth within the engine's first 2 km intake-search corridor;
- screen-to-export tracing for seismic, conservation, and private local-GIS evidence.

No browser warning or runtime error accompanied the critical live river mismatch. That makes it more dangerous: the numbers look like an ordinary successful result.

## Existing-test blind spots observed

- The waterway test named for losses swallowing head does not require rejection; it accepts the 90% cap.
- The desander redundancy test checks only that two bays are returned, not that one bay can carry design flow at the stated velocity.
- Desander siting tests do not require a proposed bench to remain on one bank or exclude the active channel.
- No existing test binds promoted reach identity to study.path, displayed catchment, flow source, and provenance.
- No existing test requires imported/borrowed measured state to be cleared or revalidated when the selected site changes.
- River-selection tests do not compare distance to the full polyline or probe long-segment midpoints.
- River-path tests do not require the returned path to stop at the requested maximum distance or the minimum scheme length to round upward.
- Asynchronous audit tests do not navigate while requests are pending or bind returned evidence to a site identity.
- Import tests do not cover unit conversion, RFC-style CSV quoting, ambiguous dates, invalid month lengths, or no-date environmental release.
- Import tests do not cover a valid flow paired with an invalid date through the subsequent gap-fill stage.
- Record-completeness tests do not require unique calendar dates.
- Uncertainty tests do not require valid endpoints to be contained by the reported band or an infeasible endpoint to widen/flag the result.
- Turbine tests do not enforce efficiency ≤ 1, continuity at selection boundaries, or rejection when no turbine is applicable.
- Multi-unit tests do not compare equal sharing with feasible unequal dispatch.
- Protected-area tests do not cover a clear intake with a near-area powerhouse.
- GeoJSON tests do not assert RFC 7946 polygon winding.
- Validation generation has no complete dependency signature/freshness assertion.
- Pondage tests establish simple connected-fill behavior, not a fixed-axis stage curve, nested masks, nondecreasing area/storage, sub-cell integration, dam-axis correctness, or accuracy against surveyed storage.
- Pondage tests do not place a lower off-channel depression inside the seed-search half-plane or validate “backwater reach” against distance along a winding channel.
- Global-mode tests do not require a usable terrain/head result when regional flow is unavailable.
- Export tests do not place the active custom scheme outside the retained list or require collector-adjusted results and routes to be serialized.
- Collector tests do not require boosted capacity/energy to propagate consistently into grid, PPA, readiness, equations, or household comparisons.
- Project-context tests do not require distinct DoED licence identities to survive name/capacity canonicalization.
- Abort/cache tests do not start a replacement flow, road, or geology request before the aborted promise's rejection handler clears the cache.
- Async site tests do not systematically bind click selection, ambiguity, collector, gauge-adoption/import, and probe results to the request that created them.
- Energy tests do not reject or qualify one-season/long-gap records before annualization.
- Import tests do not reject negative discharge before monthly residual-flow derivation.
- Spatial-radius tests do not probe longitude-box boundaries at Nepal latitudes.
- Chart tests do not render a constant FDC whose value lies exactly on a logarithmic decade.
- Hydrologic-model tests reproduce coefficient tables but do not enforce monotonic FDC quantiles, bound a third-source blend against two agreeing sources, or compare all twelve HYDEST monthly minima.
- Gauge-transfer tests do not require directed river connectivity, directional catchment growth, current-intake area, climatic/altitudinal similarity, or parity between app adoption and validation eligibility.
- Measured-flow tests do not require downstream handling to be independent of the model authority that the measurement replaced.
- Measured-flow tests do not require a nonzero intake index to preserve the measured series without a second network-derived scale factor.
- Corridor tests do not require a continuous left- or right-bank alignment; they allow the locally gentler bank to alternate at every sample.
- Local GloFAS tests do not require complete unique calendar days for every year described as complete.
- Shape-audit tests do not require a candidate neighbour to share the river, catchment, flow direction, drainage area, or even a comparable raw mean before automatic adoption.
- Collector tests do not compare their raw reach-flow inputs with the flow authority used by the base scheme or require gravity headroom to exceed terrain error.
- Reliability tests do not reject empty-date observations from interannual P50/P90 grouping or historical BS years below the heuristic boundary.
- Readiness tests do not apply a relative terrain-source tolerance to low-head schemes.
- Road-access tests do not preserve a successful intake or powerhouse result when the other endpoint fails both routers.
- Cache tests do not assert that every multi-cell neighbour probe uses scratch priority.
- Local-GIS overlap tests do not verify the promised smallest containing polygon by area.
- Export tests do not require detailed seismic, protected-area, municipality, survey-sheet, buffer, or isohyet evidence shown on screen.
- Intake-selection tests do not carry the selected path point's drainage area into flow arbitration, regional models, hypsometry, sediment, and donor transfer.
- Main-stem-selection tests do not include named small tributary projects near a much larger river or test the known Upper Syange false promotion.

## Audit integrity and residual limits

The working tree was already heavily modified and contained many untracked files when the audit began. This report evaluates that exact working state. Those pre-existing changes were preserved. **CALCULATION-AUDIT.md is the only repository file intentionally added by this audit.**

No source fix was applied, as requested. Re-running a clean release audit after the current working tree is committed and regenerating all derived datasets would be necessary to distinguish release defects from in-progress changes. Field-calibrated gauge comparisons, surveyed reservoir contours, and an authoritative motor-road/access inventory are still required before feasibility use.
