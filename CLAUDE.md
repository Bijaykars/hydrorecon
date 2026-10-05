# HydroRecon

Run-of-river hydropower screening for Nepal. Click a river, get a scheme —
capacity, energy, head, design flow — with the uncertainty attached and every
source named.

Private tool. Not open source, not distributed.

---

## The one thing to understand

**Nothing ships unless it was measured, and plenty is reverted after it was.**
Roughly ten changes have been measured and thrown away for every one kept. The
reverted ones are documented *in place*, next to the code they would have
changed, because a good idea that measured badly will be had again.

If you are tempted to improve something here, assume it has already been tried.
Read the comment block above it first.

---

## Accuracy, as measured

**Every row below is one engine, `acdb34241895`, re-measured 2026-08-25.** The
table used to be stamped to two — the fleet at `949cb685322e`, the gauge and head
rows at `28b4b3f033a8` — and closing that was the outstanding job. It is closed:
the whole fleet, both gauge harnesses, the dry-share harness and the three-way
DEM probe were re-run under one signature.

**Nothing moved.** Not "nothing much" — nothing. The fleet paired 193 plants
against the old file on capacity, energy, design flow, head, waterway and licence
ratio, and the largest relative move was **zero**. Both gauge tables reproduce
digit for digit; so does the dry-share confusion matrix; so does the
three-cornered hat.

**So a signature change is not a behaviour change, and only a paired re-run can
tell them apart.** `engine-signature.mjs` hashes sixteen files with comments
stripped, and something in them moved between the fleet run and the commit that
followed it — an intermediate state that is not in git, so what moved cannot now
be recovered. That is the signature doing its job: it is deliberately
over-sensitive, because CLAUDE.md's own rule is that covering too much costs one
re-run while covering too little silently invalidates every comparison. The cost
here was one re-run and the answer was worth having.

One thing the re-run exposed about the table itself: **the head row was never
the engine's to stamp.** `checks/dem-vs-survey.probe.mjs` compares three terrain
products through `src/api.ts`, and not one of the sixteen signed modules can move
its answer. It is dated, not signed.

Against **69 DHM gauges** with 10+ complete years and **193 commissioned Nepali
plants** — the whole eligible register, not a sample — all under
`acdb34241895`:

| Quantity | Result |
|---|---|
| Flow, typical error | **1.37×** (blend), weighted to where projects sit: **1.64×** |
| Flow, bias | **1.00×** — unbiased, after the correction below |
| Flow, within a factor of two | **90%** of gauges |
| Head | no systematic bias, **σ 6.6 m**, 3.4% relative. Three-way, re-run 2026-08-25: Mapterhorn is the best of three, see below. Terrain, so unsigned |
| Plants reaching their licence at a buildable waterway | **147/180 = 82%** |
| Impossible coordinates (excluded, not scored) | **8/180 = 4.4%** |
| Plants under-predicted by more than 2× | **9/172 = 5.2%** |
| Plants the engine could not run at all | **13/193 = 6.7%** |

### The fleet stopped being a sample

It used to be 104 plants drawn by seeds 1–7, because the discharge service was
rate limited and the sample "took days of rate-limited fetching to collect". The
local GloFAS store ended that and nobody noticed: `build-fleet-validation.mjs`
starts its own Vite server, so it now reads flow from disk. The whole register
ran in about thirteen minutes and reported `flow: 12 from the local GloFAS
store, 0 fetched, 0 refused`.

So the fleet is no longer a stratified sample of the population. It IS the
population: every commissioned, located, non-storage DoED plant of at least
1 MW, 193 of them, all 193 rows carrying one signature with no mixture.

**The headline barely moved: 83% → 82% on a sample that grew from 104 to 180
scored.** That is the result. Not an improvement — a much better supported
version of the same claim, which is what a screening tool needs more.

**Do not read the distribution against the old one.** p10 is 0.56×, median
2.31×, p90 6.97×, and the last paired fleet A/B quoted p10 0.79× on 101 plants.
That is rule 2 below in its purest form: the denominator moved from 101 to 172,
the extra plants brought their own tail, and nothing here says the engine got
worse. Only a paired comparison on identical plants could say that, and this run
was not one.

Every flow source, on the repaired records, 69 gauges:

| source | median | bias | typ.err | within 2× | project-weighted |
|---|---|---|---|---|---|
| mapped network | 0.90× | 0.76× | 1.53× | 88% | 1.88× |
| MHSP 1997 | 0.93× | 1.05× | 1.42× | 91% | 1.71× |
| WECS/DHM 1990 | 1.01× | 1.07× | 1.49× | 88% | 1.72× |
| Modified HYDEST | 0.96× | 1.00× | 1.40× | 87% | 1.82× |
| **network × ModHYDEST (shipped)** | **1.03×** | **1.00×** | **1.37×** | **90%** | **1.64×** |

**Do not read this as a clean improvement on the old 1.48×.** That figure was
measured on 94 gauges, this one on 69 — different populations. What IS
established: the DHM repair did not cause the move. Annual means shifted by at
most **0.039%** and the set of stations holding 10+ complete years is identical
(81) either side. The corruption was seasonal; these statistics are annual.

### The blend carries a measured bias correction

The geometric mean of network and Modified HYDEST reads **0.8727×** against the
gauges — a systematic 13% under-read, which for a screening tool is the
dangerous direction. `BLEND_BIAS_CORRECTION = 1.1458` removes it.

Leave-one-out on gauges, then the fleet paired plant-by-plant on the 101 scored
under both engines:

| | gauges (LOO) | fleet (paired) |
|---|---|---|
| before | bias 0.87×, typ.err 1.39×, weighted 1.667× | p10 0.69×, 8 under-predictions |
| after | bias 1.00×, typ.err 1.38×, weighted 1.637× | p10 **0.79×**, 8 under-predictions |

40 plants moved up, **0 moved down**, 61 unchanged. The median implied waterway
fell from 4.1 km to 3.8 km — less tunnel needed to reach a licensed capacity,
which is the engine's flow moving *towards* what developers found.

**The harness summary said this made things worse** — under-predictions 2/95 →
4/98 — and that was the denominator moving, not the engine: three extra plants
scored and brought their own tail. Paired on identical plants the count does not
change. That is rule 2 below, walked into for the second time.

### The parser bug that outlived its measurements

The DHM yearbook prints one row per day and one column per month, with blanks
under months that have no such day. The builder split those rows on whitespace,
which collapses the blanks, and then assigned token *k* to month *k*. Every
reading after the first blank was filed one month early.

It did not announce itself. Annual means shifted by at most **0.04%**, because
the values were permuted *within* the year — which is exactly why it survived
every check the project ran. Monthly means moved by up to **67%**.

Measured on the bundled records before the fix:

| Signature | Value |
|---|---|
| Non-leap station-years carrying a 29 February | **2,058 of 2,096 (98.19%)** |
| 31 August, 31 October, 30 and 31 December | **100% null, every station-year** |
| `Jul 31 / Jul 30` median ratio | **0.106** — a December low flow in a monsoon slot |

`pipeline/repair-dhm-shift.mjs` un-shifts it deterministically: 53,759 values
moved back to their real month, 11,304 (30 Mar, 31 Mar, 31 Jul, 31 Oct) were
dropped at parse time and are left null rather than guessed. Re-running
`build-dhm-records.mjs` against the private yearbook folder recovers those too.

**What this means for the numbers above:** the flow error is scored on annual
means, so it is probably close to right. Anything seasonal — dry-season energy,
the PPA 6+6 and 8+4 splits, environmental release, the national FDC shape band
— was scored against corrupted ground truth and had to be re-measured. The PPA
split now has been; see below. Environmental release and the FDC shape band have
not.

---

## The dry season, measured for the first time

`node --experimental-strip-types --no-warnings checks/dryshare-vs-gauges.mjs`

Every other gauge harness here scores MAGNITUDE. None scored the seasonal split,
and the seasonal split is where the money is: NEA pays NPR 8.40/kWh dry against
4.80 wet, and a scheme only reaches the 6+6 option by delivering 30% of its
energy in the dry season (15% on 8+4). The app prints that verdict in a report
beside a rupee figure, and nothing had ever checked it.

At 74 DHM gauges, dispatching the app's own flow series and the gauge's measured
record through ONE identical plant on the days both cover, with the model handed
the gauge's own annual mean so the answer is about shape and not magnitude:

| arm | bias | typical error | false qualify | false reject |
|---|---|---|---|---|
| model's own shape | **−5.8 pt** | 6.5 pt | 2 | 32 |
| **as shipped** (corrected where flagged) | **−3.7 pt** | **5.1 pt** | 5 | 24 |
| corrected everywhere | −2.4 pt | 4.5 pt | **12** | 21 |

NEA 6+6, Pelton-like machine, 74 gauges with 3+ years inside the model's window.
A Francis-like machine that trips below 40% of design roughly doubles the error
— −5.6 pt and 8.8 pt as shipped — because dry-season days sit exactly in the
band where the unit decides whether to run at all.

**The bias is one-signed and physical.** The app under-reads the dry season, on
both PPA splits, on both machines, at every tier. That is the flood model's
low-flow tail sitting below what Nepali rivers hold — the same defect
`engine/fdcshape.ts` was written to guard, now quantified in the units that
decide a tariff.

**So a "below" verdict is the one more likely to be wrong.** 24 of these 74
gauged rivers clear the 30% bar while the app says they do not. `src/report.ts`
now prints that error beside the test and refuses to call a scheme decided when
it sits within 5 points of its threshold.

### And it settles two fdcshape questions

CLAUDE.md carried "does the fdcshape correction help or hurt end-to-end" as an
open question from the day it was written. Measured on the dry share, **it
helps**: bias −5.8 → −3.7 pt, typical error 6.5 → 5.1 pt, and eight of the 32
false rejections removed for three added false qualifications. Keep it.

**Widening it to fire everywhere is refused.** It buys another 1.3 pt of bias
and 0.6 pt of error, and pays for them with false qualifications going 5 → 12 —
a screening tool telling one site in six it clears a tariff bar it misses. On
revenue, optimism is the dangerous direction.

**And the reference stays national.** `fdcshape.ts` carried a second debt —
switch the correction onto Modified HYDEST's per-catchment flow-duration
regression, "owed: an A/B once the service returns". The service came back the
day the GloFAS store landed and nobody noticed. Run now, the per-catchment curve
loses on bias in all four plan/machine combinations and never wins on error. See
the reverted list.

One harness bug of mine on the way, worth keeping because of how it failed:
`nearestReach` returns the CHOICE, `{nearest, mainStem}`, not a reach. Reading
its fields directly gave undefined, every guard fell through, and the new arm
became a byte-identical copy of the uncorrected one — which reads exactly like
"the two references agree perfectly". Only the "0 carry no catchment" count
printed beside it gave it away. That count exists because of the no-silent-caps
rule; this is the first time it earned its place.

Two things this measurement cannot do. Only 8 gauges hold 5+ complete years
inside the model's window, so the stricter tier is too small to read — its
smaller biases are not reassurance. And each arm sizes its own plant, so the
"qualify" column moves between rows; read the arms on bias and error, which are
paired site by site, never on the counts. That is harness rule 2, designed
around rather than walked into.

One control was run before any of this was believed: `wetDryEnergy` weights each
season by its share of the days present, so a record with monsoon gaps would
inflate the dry share of both series and move every verdict with no model being
wrong. Wet days are 50.6% of the paired record against 50.5% of the calendar,
p10 50.3% and p90 52.6%. There are no monsoon gaps, so the confusion matrix is
about the app.

**Flow is the binding constraint.** It carries roughly a factor of 1.6 on an
ungauged Nepali catchment, while head carries 3.4%. Any effort spent on terrain
is spent on the wrong half of `P = ρgQHη`.

This is **screening / pre-feasibility**. It replaces the first two weeks, not
the feasibility study. A 1.6× flow error is a 1.6× energy error and is not
bankable.

---

## Rain in, runoff out — and the ceiling the gauges had to set

`waterBalance()` in `src/report.ts`, measured by
`checks/waterbalance-vs-fleet.mjs`.

A catchment cannot deliver much more water than falls on it. Mean flow,
catchment area and rainfall were all being printed, in three different sections,
and nobody had ever divided one by the other two.

Doing it caught a live site on the first run. At **27.65 N, 85.90 E** the report
shipped a modelled mean of **1.70 m³/s** on a mapped **5.5 km²** catchment with
**1,589 mm** of rain — a runoff coefficient of **6.2**. The other three estimates
of the same river sat far below it:

| source | mean | runoff coefficient |
|---|---|---|
| mapped network | 0.20 m³/s | 0.73 |
| WECS/DHM 1990 | 0.33 m³/s | 1.20 |
| Modified HYDEST | 0.67 m³/s | 2.43 |
| **flood model — shipped** | **1.70 m³/s** | **6.17** |

`flowchoice.ts` arbitrated and chose the worst one, because it only ever compares
the candidates against *each other*. The two disagreed 8.4×, so the referee
measured each against Modified HYDEST in log space: the model sat 2.53× off the
judge, the network 3.32×. The model was closer, so the model won — and the
`BOTH_LOST` guard that would have handed magnitude to the regression is set at
e¹ ≈ 2.72× and the winner cleared it by 0.07.

### The ceiling is 2.0, and 1.0 was wrong — including in the first version of this

The obvious bound is a runoff coefficient of 1. **It is wrong for Nepal, and it
shipped that way for one turn before being measured.**

`checks/waterbalance-vs-fleet.mjs` scores the coefficient of the **measured**
mean at 69 DHM gauges with ten or more complete years. A fire there is the screen
calling a river impossible when a gauge recorded the water going past:

| ceiling | fires on MEASURED gauges | fires on the fleet as shipped |
|---|---|---|
| **1.00** | **22/69 = 31.9%** | 100/168 = 59.5% |
| 1.25 | 9/69 = 13.0% | 46/168 = 27.4% |
| 1.50 | 5/69 = 7.2% | 22/168 = 13.1% |
| 1.75 | 2/69 = 2.9% | 15/168 = 8.9% |
| **2.00** | **0/69 = 0.0%** | **5/168 = 3.0%** |
| 2.50 | 0/69 = 0.0% | 1/168 = 0.6% |

Measured distribution at those gauges: **median 0.87, p90 1.31, p95 1.52, max
1.89.**

**Nepal really does run near 1.** Roughly 225 km³/yr off 147,181 km² is about
1,530 mm of runoff against about 1,600 mm of rain, a national coefficient near
**0.95**: steep ground, thin soils, monsoon intensity. So 1.0 sits in the middle
of the distribution rather than above it.

#### Snow and ice was the obvious explanation, and it is not the whole one

This was first asserted here without measurement, then tested against the only
proxy the app had — the share of catchment above 5,000 m — and rejected at
rho 0.26. **That rejection was too strong, because the proxy was bad.**

**The app now has the ice itself.** `pipeline/build-nepal-glaciers.py` cuts RGI
7.0 region 15 to the three transboundary basins — **6,816 glaciers, 8,016 km²**,
CC-BY-4.0, via UNESCO's IHP-WINS mirror because NSIDC wants an Earthdata login.
`src/glaciers.ts` routes each centroid to a site down the same directed network
the lake screen uses, so a glacier counts only where the channel connects. That
matters: the bundle's extent is a bounding box, and Rongbuk sits inside it while
draining north into Tibet.

`checks/glaciers-vs-waterbalance.mjs`, 69 gauges, glacierised fraction measured
rather than inferred:

| glacierised share | n | median | max | over 1.0 |
|---|---|---|---|---|
| no connected ice | 32 | 0.81 | 1.61 | 8 |
| under 2% | 11 | 0.85 | 1.52 | 1 |
| 2–10% | 19 | 0.95 | 1.89 | 7 |
| **over 10%** | 7 | **1.07** | 1.19 | **6 of 7** |

**Real ice beats the proxy and the banding is now monotone**, which it never was
against the contour: rho **0.36** with measured glacierised fraction against
**0.26** with the share above 5,000 m. And the proxy correlates with the real
thing at only **rho 0.66** — so "above 5,000 m" really was measuring a mountain.
Six of the seven catchments over 10% glacierised exceed a coefficient of 1.0.
**Melt is real, measurable, and shows up exactly where it should.**

**It still does not explain the tail.** The two largest exceedances are Melamchi
at 1.89 with 6.9% ice and Solu at 1.82 with 3.5%, and **8 of the 22 exceedances
have no connected ice at all** — Sabhaya 1.61, Andhi 1.50, Hinwa 1.31, Surnagad
1.31 and 1.08, Mardi 1.25, Chepe 1.04, Mai 1.01. A two-tier ceiling would still
need 1.61 for the barely-glacierised and 1.89 for the glacierised, which is not
a separation worth a rule. One constant stands, and the residual spread is in
the inputs: a ~5 km climatology cannot resolve orographic gradients, its rain
gauges sit in valleys, and MERIT's area carries its own error.


### Making the engine refuse an impossible flow is REFUSED

The screen does not discriminate. At the same 69 gauges, with a 1.0 ceiling:

| coefficient of | fires |
|---|---|
| measured mean — ground truth | 22/69 = 31.9% |
| mapped network | 11/69 = 15.9% |
| Modified HYDEST | 16/69 = 23.2% |
| **blend as shipped** | **22/69 = 31.9%** |

**The shipped blend trips it at exactly the rate the measured record does.** A
screen that fires on truth as often as on the estimate carries no information
about which is wrong.

The fleet says the same. On 180 scored plants the screen fires on 59.5% of
shipped flows at a 1.0 ceiling, and the plants it picks out are not the ones the
engine gets wrong — licence ratio median 2.59 where it fires against 2.06 where
it passes, and the passing group has the **worse** tail at both ends (p10 0.42
against 0.85, p90 10.21 against 6.97). And 36 of the 100 fires are on rows using
a **transferred DHM record**, where flow choice is bypassed by design and there
is nothing to arbitrate — harness rule 4 in its usual place.

At the ceiling that is actually defensible, 2.0, it fires on **5 of 168** plants.
Five rows cannot support a change to arbitration, and arbitration is not where
the defect is anyway: the network candidate at the failing site was right and
available, and the referee had no absolute anchor to prefer it with.

**So `flowchoice.ts` is untouched and no measured number moves.** What ships is
disclosure only — the coefficient printed beside every mean flow, in three tiers,
with the wording escalating past 2.0. Do not fix this by moving `BOTH_LOST`;
that is the trap this file names four times over.

**What would settle it** is an absolute anchor in the arbitration rather than a
relative one — scoring each candidate against the water balance and preferring
the one that clears it. That is a real change to a signed module, so it needs the
fleet and the 69 gauges re-run behind it, and it is not written.

---

## What dropping MERIT would cost, priced for the first time

`checks/merit-vs-reach-area.mjs`

**The premise was wrong, and the measurement survives it.** This file asserted
in four places that MERIT Hydro is CC-BY-NC, "the only non-commercial licence in
the stack", and that going commercial "would require contacting the developer or
dropping it". MERIT Hydro is **dual-licensed: CC BY-NC 4.0 or ODbL 1.0,
licensee's choice** — the vendor's own data policy at
https://global-hydrodynamics.github.io/MERIT_Hydro/ says so in those words.
Electing ODbL permits commercial use provided derived data is published under
the same licence, which this public repository already does for five
OpenStreetMap-derived files. The election costs one sentence and adds no class
of obligation the repo does not already carry. LICENSES.md, blocker 5, holds the
accurate wording.

**A licence claim in a document is not a licence term on disk.** Same shape as
the gitignore note that says a claim in a document is not a rule on disk, and it
lasted longer, because nobody re-reads a licence they have already summarised
once.

So what follows is an **optional** finding, not a price list: it was run to cost
a migration nothing forces. It is kept because the result is still true and
still interesting — dropping MERIT is very nearly free on the gauges, which is a
statement about how much the 92 m accumulation is actually buying.

It is cheap to price, because the alternative is already in hand: `rivers.ts`
carries both `uplandKm2` (MERIT's 92 m accumulation, per vertex) and
`reachUplandKm2` (HydroRIVERS' own attribute), and the app already falls back to
the second wherever MERIT is absent. Catchment area drives the REGRESSIONS —
Modified HYDEST and its below-3000/below-5000 terms — which are half the shipped
blend. The flood model reads a GloFAS cell and the network's discharge is a
HydroRIVERS attribute, so neither moves.

At 73 DHM gauges with 10+ complete years, blend against the measured mean:

| | median | bias | typ.err | within 2× |
|---|---|---|---|---|
| with MERIT (as shipped) | 1.03× | 0.89× | **1.21×** | 85% |
| HydroRIVERS area only | 1.02× | 0.82× | **1.21×** | **88%** |

**Typical error identical to two decimals. Within-2× three points better without
it. Bias three points worse.** Paired on the same 73 gauges, dropping MERIT is
closer on 41 and further on 32 — a coin flip.

### And that is exactly the evidence this project has been fooled by before

The gauge population is not the use population, and here the gap is measurable
rather than assumed:

| | n | areas differ >1% | p90 divergence | median catchment |
|---|---|---|---|---|
| the 69-gauge population | 73 | 51% | 1.08 | **1,957 km²** |
| commissioned plant intakes | 180 | **81%** | **1.15** | **163 km²** |

The two areas disagree at four intakes in five where projects actually sit,
against one gauge in two — and the gauges sit on catchments **twelve times
larger**. That is the recurring trap in its usual clothes, and it means the
gauge A/B above cannot close this decision however comfortable it looks.

**So: the licence costs nothing, and the swap is cheap, optional and still
unsettled.** ODbL covers MERIT where it sits, so nothing about the licence has
to move; what is left is a data-quality question alone, and the gauge A/B cannot
close it. What would settle it is a fleet re-run against a MERIT-free build,
which is an engine change that moves the signature and re-stales the whole
accuracy table. That is a deliberate piece of work, nobody is obliged to do it,
and it is not done.

Two things this does establish. The flow would not obviously get worse, which is
the part that decides whether the app still works at all. And MERIT's own
documented bleed is visible in the same numbers — 5% of gauges read more than
twice the reach's own area, with the Seti reading 7,358 km² against a reach of 7.

---

## Collector intakes, finally in the report

A panel-against-report audit found three things the app knew and the document
did not say. Two were closed at the time — the wrong-river warning and the
flow-duration shape check. This was the third, left open for two sessions while
being the only one of the three that changes the **design flow**.

A collector intake diverts a neighbouring stream into the same headrace, and the
app models the gain. A reader of the PDF got the raised capacity with no way to
know a second stream had been assumed — a scheme they never agreed to, and a
consent they were not told about. It now prints beside the flow, with each
stream, its position and its share, and the note that every capacity and energy
figure in the document includes them.

It only fires when the user ctrl-clicks an extra intake, so no render harness
reaches it. It was verified by injecting a two-collector context into the real
`deskStudyHtml` and checking both that the section appears with both streams and
that it stays silent when `collectors` is null.

---

## Three things that were broken and did not announce it

**The GLOF screen could not fire.** `report.ts` filtered upstream lakes on
`areaHa ?? areaKm2 * 100 ?? 0`, through an `as unknown as` cast, and
`ConnectedGlacialLake` has neither field — `build-glacial-lakes.mjs` keeps
centroids and deliberately drops the polygons. So the area was 0 on every lake,
the risky set was empty on every site, and the report printed *"none is both
large and close"* whatever was upstream. **A hazard screen failing open**, and
the cast is what hid it from the compiler. It now screens on what the inventory
carries — ICIMOD's 2020 list of 47 potentially dangerous glacial lakes, and
glacier-fed lakes with a significant published expansion trend — which is better
evidence than an area threshold anyway. The appendix table was printing
`unnamed — –` for every row for the same reason.

**It survived because the safe branch is the one that renders.** Almost every
site has no dangerous lake upstream, so a screen that always answers "safe"
looks exactly like a site that is. `checks/glof.check.ts` now exercises the
dangerous branch on every run — ten cases including the regression itself, the
route cut, a non-glacier-fed lake, a shrinking lake, and a trend the source
flags as an outlier.

**The app burned a core doing nothing, forever.** `setPick({ i, j })` built a
fresh object on every run of the auto-select effect, and React bails out of a
state update only on `Object.is`, so an identical-but-new object still counted as
a change. The effect depends on `found`, which is derived from `pick`:

    pick -> intakeReach -> flowChoice -> input -> found -> effect -> pick

Every turn re-ran `discover()` over 139 candidate layouts, `evaluate()`, and
`sweepDesignFlow()`'s seventeen further evaluations. Measured in the browser on
a loaded site: **2.4-second blocking tasks back to back, 4,885 ms blocked in a
3-second idle window, and `requestAnimationFrame` fired ZERO times in 4.7
seconds.** React was printing "Maximum update depth exceeded" the whole time.
Returning the previous reference when `i` and `j` are unchanged fixes it:
**0 long tasks, 0 ms blocked, 165 fps**, idle and while zooming.

**And it was not only slow — it made the output nondeterministic.** The ring
never converged, so the scheme oscillated, and `render-report.mjs` captured
whichever state it happened to catch. Two renders of one coordinate disagreed
about whether 43 upstream lakes existed or none did. The renderer now waits for
the context to stop changing — screens present AND the scheme's own i, j,
capacity and waterway — and says so when it is still moving.

A fourth, self-inflicted and caught the same day: the glacier bundle went into
`src/data/` as a static import, which Vite inlines into the JS bundle and parses
before first paint. **2.4 MB, more than every other statically imported layer
combined.** It lives in `public/` and is fetched on demand, like the OSM rivers.

---

## Pondage, as measured

`node pipeline/build-pondage-validation.mjs` — Kulekhani (Indrasarobar), Nepal's
only storage reservoir, against its published figures.

| Quantity | HydroRecon | Published | |
|---|---|---|---|
| Dam span, bank to bank | 421 m | 397 m crest | **1.06×** |
| Surface area | 1.26 km² | 2.2 km² | **0.57×** |
| Storage | — | 85.3 Mm³ | not comparable, see below |

**This is a screen, not a survey, and the level table says why.** One metre of
extra water level takes the answer from 1.26 km² to **24.77 km²** — the fill
escapes a saddle and floods the neighbouring valleys. A result that moves 20×
for a metre is an order of magnitude, not an estimate, and `screenPondage` now
reports its own ±3 m sensitivity so the reader sees that before trusting it.

The dam span is the encouraging half: inferring 421 m bank-to-bank where the
real structure is 397 m is the geometry working.

**Storage cannot be scored here.** Kulekhani was impounded in 1982 and every DEM
the app uses is decades younger, so the raster holds the LAKE SURFACE, not the
drowned valley. That is what makes the area test possible at all — the water
plateau is a real shoreline at a known level — and what makes the storage test
impossible. A predicted volume here is a lower bound by construction.

### And now against a population, not one reservoir

`npm run build:pondage-refs` then `npm run build:pondage-gsw`

The section above rested on **one** site, and said so. It does not any more.
JRC's Global Surface Water maps every waterbody on Earth from 38 years of
Landsat, and the surface area of a lake is exactly what `delineatePondage` is
asked to reproduce — so the published figure is replaced by a MEASURED one, at
**206 Nepali waterbodies**. Two instruments, two physics, one shoreline: the app
fills a Copernicus radar/photogrammetric DEM, GSW thresholds Landsat optical
reflectance, so agreement is evidence rather than bookkeeping.

**The reference is a BAND, and assuming it was a number would have poisoned the
whole comparison.** Kulekhani reads **0.73 km²** of always-wet water against a
published 2.2: a reservoir is *drawn down*, so its outer 60% is not wet nine
years in ten. Rara reads 10.22 against about 10.4, because a natural lake is not
operated. Every row therefore carries a core (≥90% occurrence) and a typical
(≥50%) extent, and the screen is scored against the interval — the DEM caught
each lake at one unknown level inside it.

#### The seed was wrong for one round of runs, and Kulekhani caught it

The reference point started as the MEAN of each component's wet cells, which for
a 7 km reservoir winding between ridges lands **on the hillside between its
arms**. The harness read 1553 m there against a water surface at 1533, found
three connected cells instead of a plateau, and reported the country's only large
reservoir as unscoreable — **on both terrain products**, which is exactly what
made it look like a terrain limit rather than arithmetic. **82 of 206 seeds were
more than 100 m off; Kulekhani's was 665 m off.**

The seed is now the point furthest from the shore, which is inside the waterbody
by construction and maximally far from a noisy bank. The first attempt at that
was also wrong and never ran: an unpadded distance transform has no background to
measure to, so `argmax` landed in a CORNER — 1,094 m out, claiming 2.3 km of
clearance inside a 1.6 km box. `--self-check` caught it, which is the first time
that check paid for itself; it now carries a C-shaped fixture whose centroid is
dry and asserts the seed is in water against the raster rather than against a
coordinate.

**Every number below is post-fix.** The pre-fix run is not recorded here, because
a set that could miss its own lake 40% of the time was measuring the seed.

178 of 206 scored, under Mapterhorn as shipped:

| subset | n | in band | median | p10 | p90 | moves >3× |
|---|---|---|---|---|---|---|
| **all scored** | **178** | **36%** | **0.82×** | 0.49× | 14.44× | **31%** |
| tight band only | 108 | 29% | 0.79× | 0.52× | 1.54× | — |
| not glacial | 28 | 36% | 1.53× | 0.18× | 63.48× | 25% |
| tight, not glacial | 4 | 50% | 1.03× | 0.83× | 1.53× | — |

The huge p90s are **window-edge rows** and nothing else: 19 of the 178, mostly
Terai floodplains, where a level pool on flat ground runs to the edge of any
window you give it. On the rows that stayed inside their window the p90 is 1.12×.
The screen there is meaningless rather than wrong, and it says `edgeLimited`.

**The finding worth the whole exercise: the saddle escape is a third of the
population.** "A result that moves 20× for a metre is an order of magnitude, not
an estimate" was written about Kulekhani at n=1, and the obvious reading was that
it was a quirk of one drowned valley. It is not. **56 of 178 waterbodies move
more than 3× across the three metres above their own water plateau**, and the
rate barely differs between the glacial subset (31%) and outside it (25%). Close
to one pondage screen in three is an order of magnitude. `screenPondage` already
reports its ±3 m sensitivity for exactly this reason — that disclosure is now
load-bearing rather than precautionary.

**28 produced no result at all, and every one failed the same way**: no flat
surface at the seed, even at ±3 m, at 3,800–5,400 m. Mapterhorn does not resolve
a small high glacial lake as a plateau. A terrain limit, reported rather than
filled in.

**Do not read an accuracy figure off the 0.79× median.** Three reasons, all
structural. The band's upper edge is the ≥50% extent and the DEM is one
snapshot, so scoring against it is conservative by construction. 157 of the 183
are glacial lakes, which test the fill geometry and are absurd places for a
forebay. And **the subset closest to an actual pondage site — a tight band,
not glacial — is THREE ROWS.** That is the trap this file names on every other
page, arriving on schedule: the measurable population is not the use population,
because at 28 m Landsat only resolves large open water and run-of-river pondage
is built on rivers narrower than a pixel.

What this does establish, which nothing did before: the screen reproduces a real
complex shoreline when the DEM holds one — **Rara 10.33 km² against a measured
10.22–10.38, 1.00×**, Begnas 0.99× — and it is unstable on a third of the places
you might point it. Both halves are new.

### GEDTM30 for pondage, paired at last — and REFUSED

`node checks/pondage-dem-ab.mjs`

CLAUDE.md carried the GEDTM30-for-pondage swap as decided on Kulekhani: area
0.57× → 0.77×, and a stability that went from **20× per three metres to 1.10×**.
That was one site, and this file said n=1 could not close it. Now it is paired
over the population, on identical seeds, same day, same code.

Both arms fail on their own subset, so every figure is on the **166 rows scored
by both** — comparing 178 rows against 170 different ones would be harness rule
2 for the third time in this project:

| | in band | median | p10 | p90 | moves >3× | edge-limited | scored |
|---|---|---|---|---|---|---|---|
| **Mapterhorn (shipped)** | 21% | 0.83× | **0.51×** | **14.4×** | 30% | **18** | **178** |
| GEDTM30 bare earth | **27%** | 0.84× | 0.43× | 29.3× | **25%** | 22 | 170 |

On the 135 rows where neither arm ran off its window: in band 25% against **31%**,
**median 0.78× either way**, p10 0.49× against 0.40×, p90 1.12× against 1.31×,
saddle escape 32% against **27%**.

**Refused, and it is a genuine split rather than a rout.** GEDTM30 wins the
in-band rate by six points and the saddle escape by five. Mapterhorn wins both
tails, scores **eight more sites** (28 failures against 36), runs off the window
four times less, and — the measure that answers the question actually being asked
— **is closer to the measured band on 82 sites against 68, with 16 tied.** A
primary is changed when a candidate is better, not when it is differently wrong.

Two things the pairing kills outright. The Kulekhani stability result **does not
generalise**: 20× → 1.10× at one site becomes 32% → 27% across 135, and site by
site GEDTM30 fixes 32 saddle escapes while creating 24. And at Kulekhani itself,
seeded from the satellite rather than from its published dam coordinate,
Mapterhorn reads **1.380 km²** against GEDTM30's 1.527 on a measured band of
0.730–1.314 — the shipped source is the closer of the two on the very site that
launched the argument.

**And the low read is the method, not the terrain.** Both arms sit at a median
0.78× of the ≥50% shoreline on clean rows. Whatever makes the screen read small,
swapping the DEM does not touch it.

### What this test caught on its first run

The seed search picked **Kulekhani's spillway** instead of the reservoir: 90 m
from the dam, at 1526 m with the lake at 1533 m and the chute falling to 1488 m
three cells away. The screen returned 0.003 km² against a published 2.2. The
seed now pays for the drop available around it — a pond floor is flat, an
outflow drains — which is the fix for the long-standing "seed jumps to an
unrelated depression" defect, found by a real site rather than reasoned about.

### A bare-earth DEM fixes the saddle escape

`npm run build:gedtm` cuts Nepal out of **GEDTM30** — a 30 m global bare-earth
DTM, CC-BY-4.0 — and `npm run build:pondage "GEDTM30 bare earth"` scores it
against Kulekhani. Paired, same code, same axis logic, same day:

| | Mapterhorn (shipped) | GEDTM30 | published |
|---|---|---|---|
| Surface area | 1.26 km² (0.57×) | **1.69 km² (0.77×)** | 2.2 km² |
| Detected bed | 1533.0 m — *the lake surface* | 1522.4 m | — |
| Retained height found | **0.0 m** | 10.6 m | — |
| Level table, +3 m | 1.26 → 24.77 → 25.05 km² | 1.69 → 1.74 → 1.86 km² | — |
| Stability above the plateau | **20×** | **1.10×** | — |
| Dam span | 421 m | 476 m | 397 m crest |

**The saddle escape is gone.** "A result that moves 20× for a metre is an order
of magnitude, not an estimate" was the worst finding this validation produced;
on GEDTM30 the same site moves 1.10× over three metres. The bed detection also
starts working — the shipped source put the valley floor exactly on the water
surface and screened a 0 m dam.

Dam span moved the wrong way, 1.06× → 1.20×. One site, two of three
measures better, and n = 1.

**GEDTM30 is now the SECOND source, not the primary.** `screenTerrainSources()`
in `src/api.ts` returns Mapterhorn plus GEDTM30 where the store exists, and
falls back to AWS where it does not — a production build has no `/gedtm` route,
and losing the cross-check silently is worse than a weaker one.

The primary is unchanged, so no headline number moves: area, storage and head
read the same. What changes is the spread quoted beside them. On the first real
site after the swap it went from **0% area / 0% storage** against AWS to **0% /
15%** against GEDTM30 — the spread went UP, and that is the improvement. A
second opinion that always answers "we agree exactly" is not a check.

**GEDTM30 is still not the primary, and that is now measured rather than
deferred.** The head probe below already said Mapterhorn is the better surface;
the paired run over 166 waterbodies says it is also the better one for pondage,
narrowly and on the measures that matter for a screen — see "GEDTM30 for pondage,
paired at last" above. The Kulekhani result in this table stands as reported and
does not generalise.

### Bare earth does not help head. It was measured, and it lost.

`npm run probe:dem` now samples a third product and solves for each one's own
error. 220 HydroRIVERS reaches, 120 scored under all three:

| pair | HEAD median | HEAD sigma | HEAD RMSE |
|---|---|---|---|
| Mapterhorn − AWS | +0.3 m | 7.8 m | 86.4 m |
| Mapterhorn − GEDTM30 | −0.0 m | **5.6 m** | **6.9 m** |
| AWS − GEDTM30 | −0.1 m | 8.9 m | 86.6 m |

Three products make each one's error solvable — the three-cornered-hat
estimator, `s2A = (d2AB + d2AC − d2BC)/2`. It returns Mapterhorn **2.4 m**,
GEDTM30 **5.0 m**, AWS **7.4 m**.

Mapterhorn and GEDTM30 share a Copernicus parent, so the absolute metres are
not trustworthy — but the ORDER between those two is, because subtracting their
two solutions cancels the shared covariance exactly and leaves only how far each
sits from AWS: 7.8 m against 8.9 m. **Mapterhorn wins on head, and that
conclusion survives the correlation caveat.**

**Why the bare-earth argument failed.** The prediction was that a DTM would beat
two DSMs by stripping canopy. The point-level medians say there is no canopy
here to strip:

| pair | POINT median |
|---|---|
| Mapterhorn − GEDTM30 | **+0.6 m** |
| AWS − GEDTM30 | +3.2 m |

A Nepali forest canopy is 10–25 m. Six-tenths of a metre is not a canopy — and
of course it is not, because every point this probe samples is a HydroRIVERS
vertex, which is a channel. There are no trees on a gravel bar. The 5–95% range
does reach +14 m, so the correction is real where vegetation exists; it just is
not where this app measures head. The medians also rule out the alternative
reading of a wider sigma: a systematic correction would be one-signed, and these
are centred on zero, so it is scatter.

**What GEDTM30 does win is the tail.** Every pair involving AWS carries an RMSE
near 86 m against a sigma under 9; the one pair that excludes AWS has RMSE 6.9 m
against sigma 5.6 m. The catastrophic disagreements are AWS's voids, and the
Nepal cut has 100% data coverage with none. So the standing note that "3 of 141
reaches disagree by more than 50 m — voids and gorge artifacts" is really a
statement about the second source, not about terrain.

**Net: GEDTM30 helps pondage and not head.** Not a contradiction. Pondage turns
on basin shape near a water surface, where GEDTM30's hydrologically-conditioned
surface removes the saddle that made Kulekhani move 20× per metre; head turns on
two point samples kilometres apart, where the same smoothing is just blur.

### Why not FathomDEM, which scores better

FathomDEM v1-0 beats GEDTM30 by roughly 25% against GNSS benchmarks, and it was
still the wrong choice here:

- **CC-BY-NC-SA.** The stack already carries one genuinely non-commercial
  licence — GEM's seismic hazard raster, CC BY-NC-SA 4.0 — which LICENSES.md
  names as a release blocker. A second deepens exactly that trap rather than
  paying it down. GEDTM30 is CC-BY-4.0 with no restriction at all. *This bullet
  used to cite MERIT as the stack's NC licence; MERIT is dual-licensed and ODbL
  is elected, so the example changed and the conclusion did not.*
- **The one published mountain result runs against its lineage.** FathomDEM
  succeeds FABDEM from the same group, and the GEDTM30 paper reports FABDEM
  overestimating terrain height with visible pit holes on steep slopes. Nepal is
  nothing but steep slopes. That is not evidence against FathomDEM, but the
  global GNSS margin was not measured where this app works.
- **The margin is small against what it buys.** ~25% on a term that CLAUDE.md
  already says is not the binding constraint — flow carries ~1.6×, head 3.4%.

`pipeline/build-gedtm-nepal.py` is one URL and one bounding box from reading
FathomDEM instead, if the licence ever stops mattering.

### The half that was missing: is it enough?

Everything above answers *how much water will this valley hold*. What decides a
scheme is whether that is enough, and the two are different questions.
`pondageDemand` in `src/pondage.ts` closes it with a single-average-day balance:

    usable inflow          Qa = max(0, driest monthly mean - residual release)
    deficit while peaking  Qd - Qa
    storage for h hours    (Qd - Qa) * h * 3600

The reported "this pond covers N hours" is capped at `24 * Qa / Qd` — the hours
a dry-season day can actually refill — because without that cap a generous
valley reads as permission to peak longer than the river delivers. The first
real site it ran on held 33 h of storage on a river that supports 10.1 h.

Four hours is a reference point, not a rule; `hoursSupported` is reported so the
answer can be re-read against whatever peak a PPA defines. It is arithmetic, not
a model: no ramping, spill, turbine minimum, drawdown rule or flushing
allowance.

### Where the storage is, not just how much

`sweepPondagePosition` in `src/pondage.ts`, built from a reviewer's suggestion.

The pondage screen answered the question at ONE point — the intake, which the
search chose for head and flow and which knows nothing about storage. A
Himalayan valley narrows and widens every few hundred metres, so the pond a site
can hold varies more with WHERE the dam goes than with how tall it is. The sweep
repeats the same screen at nine positions either side.

**Ranked on storage per metre of dam, not on storage.** Raw volume grows
downstream with the valley and the catchment, so a sweep ranked on it points at
the far end of the reach every time, which is not advice. Volume over the
inferred bank-to-bank span is what makes a site cheap, and it needs no cost
model — which matters, because this app has none and inventing one on top of a
1.6x flow would be false precision.

On the first real site the sited intake holds 2,751 m3 per metre of dam and a
position 1.5 km downstream holds **7,800** — 2.8x. The report says so and
immediately says the other half: the intake sets the head, so that move buys
storage and gives up gross head. A trade to re-run, not an instruction.

Cost is nine DEM windows. They overlap almost entirely and `terrainCache` holds
them, so moving the height slider afterwards repeats only the fills — but the
cache had to go from 8 to 24, because at 8 a nine-position sweep evicted the
window it was about to need again and re-downloaded the lot on every change.

---

## Geology the app can ask, not just show

`npm run build:geology-units`, guarded by `checks/geology-units.check.ts`.

The app held three geological things and none could name the rock under an
intake. `nepal-geology-maps.json` is an AVAILABILITY index — which DMG sheets
cover the alignment, never what is printed on them. The province sheets are
raster tiles: they can be looked at and not asked. Macrostrat can be asked, over
the network, and returns the global compilation the report itself dismisses as
*"one polygon spanning the entire alignment, and it is not an engineering
input"*.

The fourth thing is Nepal's own 1:1,000,000 DMG map as 856 polygons, offline,
carrying the names Nepali engineers use — Kushma, Ulleri, Ranimatta, Siwalik.
263,264 vertices simplify to 25,662 at a 200 m tolerance for **0.45 MB and
−0.042% of area**; 200 m is well inside the half-kilometre a contact drawn at
this scale carries anyway.

**Contacts are the point, not the names.** A headrace inside one formation is a
different excavation from one crossing three, and until now the report could not
tell them apart. On the first real site it ran: **2 formation contacts in
13.3 km**, intake on a unit the sheet labels only `Cr`, powerhouse on Ranimatta.

### Three ways this could lie, all closed

**Thirty percent has no polygon — and that is the digitisation, not the map.**
`No Data` covers **44,979 km² = 29.6%** of the extent, concentrated in the high
north: one block above 28.4 N from 80.6–85.2 E, another over Everest–Kanchenjunga.
Exactly where high-head schemes sit.

**The first version of this module told readers that ground was unmapped, and
that was false in the dangerous direction** — "no information exists" where the
right advice is "buy the sheet". Two things refute it. The printed Amatya &
Jnawali (1994) map is the standard national map and covers the whole country,
Tethys and Higher Himalaya included. And `checks/geology-vs-dmg-sheets.mjs`
measures it locally against the DMG province sheets this repo already bundles:
**39 of their 363 tiles sit on ground the vector calls No Data** — Gandaki 17/54,
Koshi 10/46, Sudurpaschim 9/51, and **Madhesh 0/19**, the Terai plain, fully
carried. The gradient follows elevation, which is what a stalled digitisation
looks like.

So no function returns null inside Nepal — absence and unmapped look identical
to a caller — but the words attached to `noData` are now the opposite of what
they were: a gap in the data, with the published sheet as the remedy.

**Walking off the mapping is not a contact.** Counted separately as
`coverageEdges`. Folding the two together would inflate the headline precisely
in the terrain where a reader is most likely to be planning a tunnel — the check
asserts it and says so.

**The source subdivides some formations.** `Middle Siwalik`, `Middle Siwalik1`
and `Middle Siwalik2` are three codes for members of one formation, and the
check's own Churia fixture walks straight across two of them. That boundary is
real but internal, so the quoted number is `formationContacts` and the
subdivision is reported beside it. **Found by the fixture, not reasoned about** —
the first run said 4 contacts where 3 was the honest answer.

**A unit name is a regional correlation, not local mapping.** Measured from the
bundle: **17 of the 44 named units span more than 4° of longitude**, and Kushma,
Ulleri, Syangja and Sangram run almost the whole country. Ranimatta — which the
app prints east of Kathmandu — is defined in the literature on the
Surkhet–Dailekh tract of *western* Nepal. That is a national compilation doing
its job, but Lesser Himalayan stratigraphy in Nepal is genuinely not agreed
between regions, and a Nepali geologist would spot it at once. The report says
so: the contact COUNT is unaffected, the names are weaker than they look.

**And twelve of the 57 units are bare codes.** `Gh`, `Bu`, `Gn`, `Ba`, `Cr` —
the shapefile and its metadata publish no legend expanding them. They are
carried through unchanged and flagged `named: false`, so the report prints the
code and says the source does not expand it rather than passing two letters off
as a formation. This fired on the very first site, at the intake.

**What it cannot do.** Half a millimetre of ink at 1:1,000,000 is 500 m of
ground, so `CONTACT_ERROR_KM = 0.5` and every chainage is quoted with it. This
names the belt and counts the boundaries; it does not place a portal, a surge
shaft or a support change. The 1:350,000 province sheets are better and the
1:50,000 sheets better again — both for reading, which is why this exists.

---

## Data sources

| Layer | Source | Notes |
|---|---|---|
| Daily discharge | **GloFAS v4** from ECMWF (CEMS EWDS) | Nepal only, 2006–2025, local 219 MB store. Open-Meteo is the fallback. |
| River network | HydroRIVERS | ~500 m derivation; chords real bends |
| Catchment area | **MERIT Hydro** (dual: CC BY-NC 4.0 **or ODbL 1.0**; ODbL elected) | per-vertex, 92 m. Derived areas ship under ODbL, alongside the five OSM-derived files; the GeoTIFFs do not travel. |
| Channel geometry | OpenStreetMap | length correction + drawn geometry |
| Terrain | Copernicus GLO-30 (Mapterhorn) | primary; best of three on head |
| Bare-earth terrain | **GEDTM30** (CC-BY-4.0) | local ~0.97 GB Nepal cut; the cross-check source, AWS where absent |
| Land cover | **ESA WorldCover 2021** (CC-BY-4.0) | local ~598 MB Nepal cut at 30 m; what the alignment crosses |
| Surface water | **JRC Global Surface Water v1.4** (free, unrestricted) | Pekel et al. 2016, 1984–2021, ~28 m. Two 130 MB tiles cover Nepal; the pondage reference set only, never read by the app. Sees large open water and **not** the gorge rivers projects sit on — 4% of commissioned plants have any GSW water within 150 m |
| Glaciers | **RGI 7.0** region 15 (CC-BY-4.0) | 6,816 outlines, 8,016 km² of ice, cut to the three transboundary basins; 2.5 MB in `public/`, fetched on demand. Areas are RGI's own — the rings are simplified to 60 m for drawing and read 1.3% low. |
| Geological units | **ICIMOD RDS "Geology of Nepal"** (CC-BY-4.0) | Amatya & Jnawali 1994 at 1:1,000,000, 856 polygons, 57 units; bundled 0.45 MB. The only NEPALI geology the app can query, and the only geology it can query offline. |
| Hypsometry, altitude, rainfall | HydroBASINS + CHPclim | built per catchment |
| Gauges | DHM Nepal | 136 records, daily |
| Projects | DoED licence register | ~1,048 located |

---

## The hazard figure, and what it caught

The hazard evidence used to be a screenshot of the DARK basemap with a hundred
three-pixel triangles on it — dark on dark, markers below what a page can
resolve. It proved records exist and answered nothing else.

**What replaced it is a monochrome relief map of the actual valley.** The
basemap is taken away entirely: a white ground with the DEM's own hillshade over
it, every tile layer and label from the style hidden for the shot and restored
after. The relief carries the ridges and side valleys — the context a slope
question needs — and it prints. Colour is then spent only where it means
something: the alignment in strong orange with a white casing, the hazard badges
at their own coordinates. The caption states the frame width, because a printed
map with no scale is a picture.

Every one of those layers was styled for a dark basemap, so the capture inverts
them for the shot — a pale orange alignment, a soft glow and white labels with a
near-black halo all fail on white, and the map would have shown the hazards
clearly and the project poorly, which is backwards.

**An abstract version came first and was thrown away.** It straightened the
river into an axis — chainage along, offset across — which is more analytically
honest and read as a scatter plot. Two rounds of design work did not fix that;
the map of the real place did. Worth remembering before the next clever chart:
the reader wanted to see the valley.

**But the abstract one found a false claim before it went, and the fix stayed.** The report printed *"this is an
actively failing corridor — 103 landslides"*, formed from the count inside the
whole 15 km search radius. Plotted against the alignment, the same records read:

| 0–1 km | 1–2 km | 2–5 km | 5–10 km | 10+ km |
|---|---|---|---|---|
| 3 | 10 | 6 | **62** | 22 |

and a SINGLE coordinate 9.85 km away carries **39 of the 103**, with a second at
10.48 km carrying 16. More than half the evidence for "actively failing" was two
distant geocoding centroids — BIPAD files an incident against a settlement, not
against the scar. **Thirteen landslides lie within 2 km of the works.** Still a
slope-stability site; not the same claim.

The verdict is now formed on the near band with the wider count reported beside
it, and where one coordinate dominates the report says so. Two other things the figure exposed
and that are fixed: the section claimed "every record is listed in the
appendices" while the table silently cut to 40 of 128, and the gauge table was
three columns at the back with a river column reading "–" four times in six —
now a full section reporting whether each record can actually be transferred.

---

### The geological sheet needed the opposite treatment

Framed on the scheme, the DMG figure was a blow-up of one polygon: a flat green
field with the sheet's own labels three times the size of the report's type,
jagged because a 200 dpi tile was being magnified perhaps eightfold past what
its printed line width supports. It looked bad because it WAS bad — the
resolution on the page was not in the source. At 1:350,000 the information is
STRUCTURE, and structure needs tens of kilometres.

The capture now pulls back 1.15 zoom levels, to about 45 km, where the belt and
its thrusts are visible and the tiles sit near their own native resolution — so
the figure is sharp for the same reason it is useful, and the caption states the
frame width. **Not further:** at 1.6 the frame reached the southern neat-line of
the Gandaki sheet and the bottom of the figure went bare, because the province
sheets are separate publications that do not abut on the ground. White space
there reads as a rendering fault rather than as the edge of a map.

Both light figures share `lightGroundInk()` in the capture, because every scheme
layer is styled for the dark basemap and on white relief or a printed sheet the
alignment goes faint and the labels turn to grey smudges — the figure ends up
showing its background clearly and the project poorly, which is backwards.

---

## The report was apologising, and it had a lot to be proud of

Counted on one real site, the sixteen body pages carried **29 finding badges**,
and **not one of them read as a result**. Thirteen said REQUIRED FIELD
VERIFICATION and fourteen said LIMITATION, because `finding('note', …)` — the
tone this file reaches for whenever it has an ordinary fact to state — rendered
as "Limitation". So "no mapped active fault intersects the corridor", "the scheme
lies outside every protected area" and "both structures are on the road network"
were all stamped as shortcomings. **The report was reporting its good news as
failure.**

Page 2 was the worst of it. In order: *does not establish a design*; four key
figures reading **low confidence**; *hold spend*; *no site discharge measurement
is available*; hold points; then a badge repeating the recommendation printed
three lines above it. Seven negative statements and one duplicate before the
document said what it had found. Page 3 then opened a table headed **"Evidence
not obtained at desktop stage"** — eight rows of *Not undertaken*.

None of that was dishonest. All of it was uninformative, which is worse for a
tool whose whole argument is that it measures itself.

**What changed, and what did not.** Not one caveat was deleted. The scope
boundary is still stated in the lede, still stated in section 02, and every
field task still appears. What changed is:

- **`note` renders as "Screening result"**, and a fourth tone, `limit` →
  "Scope limitation", carries the five findings whose content really is the
  boundary of the method. Badges now read 3 key findings / 9 screening results /
  6 scope limitations / 11 field-verification items.
- **Adjectives became measurements.** Eight "low confidence" labels are gone.
  The flow tile says *~1.6× typical error*, the head tile *±3.4% measured*, and
  the uncertainty section quotes the gauge and DEM harnesses by their numbers —
  1.4× typical, unbiased, 90% within a factor of two; σ 6.6 m on head; dry share
  under-read by 3.7 pt ±5.1. **The measurement is this tool's one advantage over
  a consultant's desktop study, and the report was hiding it behind the word
  "low".**
- **"Evidence not obtained" became "What each discipline rests on"** — the same
  eight rows, naming the evidence first and the gap at the end of the same line.
  It also tells the reader more: "Site reconnaissance — Not undertaken" concealed
  that a 30 m terrain model and a 10 m land-cover raster were read over the whole
  alignment.
- **Two duplicated findings removed.** The gauge verdict was printed in section
  05 and again in section 06, one page apart, in the same words. The geology
  section fired four consecutive warnings, of which "Engineering geology remains
  unresolved" came from the global layer the section itself dismisses and
  restated what section 02 already said.
- **The contact count became the key finding it is.** Counting formation
  contacts along a headrace is the thing nothing else in this stack can do, and
  it was stamped REQUIRED FIELD VERIFICATION with a sentence about its own
  tolerance. The tolerance now sits in the appendix beside the chainages it
  qualifies.

**And one number was simply wrong.** The assumptions table printed *"Overall
plant efficiency 96.0 %"*. It is not that: `assumptions.efficiency` is the
generator and transformer train, which `discover.ts` multiplies by the selected
runner's efficiency at design flow. `src/export.ts` had labelled it correctly
all along. The report now prints all three — 96.0% generator and transformer,
89.4% Pelton at the reference flow, **85.8% overall** — because no plant reaches
96% and a reader who knows that would have stopped trusting the document on page
three, over arithmetic that was right the whole time.

---

## Design flow, which the app used to assume

`src/engine/designflow.ts`, guarded by `checks/designflow.check.ts`.

Every scheme was sized at Q40 and reported as if the choice had been made. It
had not; it had been assumed. **Design flow is not a property of the river — it
is the one real decision available at screening**, and the app was silent on it.

The sweep re-runs `evaluate` at seventeen exceedances on the SAME layout: same
intake, same powerhouse, same waterway, only the machine changes. Nothing is
reimplemented — each size re-sizes its own headrace and penstock, re-selects its
own turbine, and dispatches the whole daily record through that machine's
part-load curve. The check asserts the swept point at the design exceedance
equals `evaluate` exactly, because a chart that disagreed with the table beside
it would leave a reader no way to tell which was the scheme.

**Three things it can say without inventing a cost.**

- **What the last megawatt earns.** Extra energy over extra capacity, in
  equivalent full-load hours per year for that increment alone. On the first
  real site it ran, that falls from 7,720 h at the smallest size to 686 h at the
  largest. The app supplies the hours; the analyst supplies the NPR/kW.
- **The largest machine that still clears the dry-season bar.** Shrinking the
  machine raises the dry share, so there is a largest qualifying size. The
  report used to say "pondage or a lower design flow are the two levers" and
  could not say how much lower.
- **Where energy peaks.** Energy is NOT monotonic in design flow: past some size
  a machine spends more days below its own minimum gate and shuts down, so a
  larger and more expensive plant generates less. Physical, and free.

On the first real site: sized at Q40 the scheme reaches 193.8 MW and 16.0% dry
energy, missing NEA's 30% bar. **At Q50 it is 114.6 MW and 33.2% — clearing it,
for 182.9 GWh/yr.** That is the 6+6 tariff option bought with capacity, and it
is a trade the report previously could not express at all.

**No capital cost, discount rate or NPV.** This is deliberately not an economic
optimisation — the app has none of those inputs, and inventing them on top of a
flow carrying 1.6x would be the worst kind of false precision. The dry-share
column also carries the measured 4-6 point low bias from the section above, so
the qualifying sizes it quotes are conservative, and it says so.

---

## Land the waterway crosses

`npm run build:landcover` cuts ESA WorldCover 2021 out for Nepal — 10 m,
CC-BY-4.0, from a public bucket, reduced to 30 m by the mode of each 3x3 block.
598 MB, about a minute to build. `src/landcover.ts` reads one window over the
scheme and samples the alignment; `checks/landcover.check.ts` guards the
accounting against a synthetic raster whose answer is known.

**Why it was the gap worth filling.** The app could describe the hydrology,
terrain, geology, hazards, grid and licence neighbours and could not say what
the waterway runs THROUGH. In Nepal forest clearance and compensatory
plantation, land acquisition and resettlement are among the slowest consents a
run-of-river scheme waits on, and they are decided by ground whose coordinates
the app already held. On the first real site it ran: 7.5 km of a 13.3 km
alignment on tree cover, 90 m through built-up ground.

The store was verified against a true 3x3 mode of the native 10 m data over a
600x600 block: **96.5% of cells identical**, and class shares within 0.2
percentage points. The disagreements are at class boundaries, where a dominant
class is a coin toss, and they do not move a kilometre figure.

**Three limits, all load-bearing.**

- **Cover is not tenure.** "Tree cover" does not separate national forest from
  community forest from a private woodlot, and those carry different
  authorities, different consents and different compensation.
- **A line is not a footprint.** What is measured is the centreline. A real
  waterway takes a right of way, spoil disposal, an access track and a portal
  yard, none of which is sited at screening, so every length is a floor.
- **Water cells are the channel, not the works.** The corridor is traced along
  the river — the same path `corridor.ts` reads cross-slope from — so a wide
  river reads as permanent water under the alignment.

**FRTC/ICIMOD's national land cover is the second opinion this wants**, 30 m and
annual to 2022, also CC-BY-4.0, and for a permitting conversation it is the one
that carries weight. It sits behind a request form rather than a bucket, which
is the only reason it is not here — the same argument that put GEDTM30 beside
Mapterhorn applies.

---

## Engine

`src/engine/`

- **`flowchoice.ts`** — who sets the magnitude. Network and flood model are
  compared; where they agree the magnitude is their **geometric mean with
  Modified HYDEST**; where they disagree past 3× the regression referees.
- **`modified-hydest.ts`** — the regression Nepali government offices actually
  run, transcribed from the Q45 workbook and verified to **1e-9** against
  Excel's own cached cells. Best regional method measured (1.48× vs MHSP 1.55×,
  WECS/DHM 1990 1.61×).
- **`hydest.ts`** (WECS/DHM 1990), **`mhsp.ts`** (MHSP 1997) — the other two
  published Nepali regressions, kept for cross-checking.
- **`fdcshape.ts`** — guards an implausible flow-duration shape. Fires on 16% of
  project sites and 34% of gauges — gauges sit on bigger rivers, which is the
  recurring trap below. Measured neutral-to-slightly-positive end-to-end, and
  now measured POSITIVE on the dry share: bias −5.8 → −3.7 pt, typical error
  6.5 → 5.1 pt. Keep it, and do not widen it.
- **`discover.ts`** — the scheme search. `SEARCH_KM` lives here and is imported
  by both app and harness, because they once differed (22 vs 40) and every
  measured figure came from a scheme no user could have been shown.
- **`designflow.ts`** — how big should the machine be. Re-runs `evaluate` at
  seventeen exceedances on one fixed layout, so the swept point at the design
  exceedance reproduces the panel bit for bit. No cost model: it reports the
  physical trade-off, the marginal full-load hours of the last MW, and the
  largest machine still clearing NEA's published dry-season bar.
- **`corridor.ts`** — canal-vs-tunnel from cross-slope. Deliberately a
  classification, never an excavation volume.
- **`uncertainty.ts`** — the band on every headline number.

---

## Harnesses

`npm run check` — 361 unit assertions across 37 files, all fast and offline.
`node --experimental-strip-types checks/merit-vs-reach-area.mjs` — prices
dropping MERIT against the gauges and the fleet; offline, under a minute.
`node --experimental-strip-types checks/glaciers-vs-waterbalance.mjs` — routes RGI
ice to all 69 gauges; about a minute, offline.
`npm run build:fleet 1000 1` — run the whole eligible register through the
app's own engine in a real browser, about thirteen minutes. The `20 <seed>`
form still works and still accumulates, but seeded sampling existed only to
survive a rate limit the local GloFAS store removed; prefer the full run, which
cannot drift into a mixture of engines.
`npm run build:validation` — the curated ten plants.
`npm run probe:dem` — terrain error, measured rather than assumed.
`npm run build:pondage-refs` — cuts 206 Nepali waterbodies out of JRC Global
Surface Water as a pondage reference set; offline after the two tiles land,
about a minute. `npm run check:pondage-refs` drives the same code with a
synthetic raster whose answer is known by construction.
`node checks/pondage-dem-ab.mjs` — reads two pondage runs against each other,
paired on the rows both scored, with the unpaired rows counted rather than
averaged in; instant, offline.
`npm run build:pondage-gsw` — scores the pondage screen against all 206 in a
real browser, about 25 minutes. It runs in chunks of ten and reloads between
them: a single `page.evaluate` over two hundred terrain windows killed the
renderer twice, and the second time it took a hundred already-scored sites with
it. A lost chunk is now recorded as a harness failure rather than quietly
shortening the scored set.

`checks/*.mjs` are analysis harnesses (not in `npm run check`) that answer one
question each and print the answer.

### Harness rules learned the hard way

1. **Stamp every accumulated row with an engine signature.** Rows written weeks
   apart under different code were being averaged together. The signature covers
   all ten modules that can change a number — it once missed `dhm.ts` and every
   A/B through it compared a mixture with itself.
2. **A one-sided failure test still lies if the denominator can move.** One
   change "improved" under-predictions 2/19 → 1/17 purely because the failing
   plant dropped out of the scored set.
3. **Never overwrite a good result with a failed run.** A rate limit once turned
   a 10/10 validation into 0/10 on disk.
4. **Report how many rows a change can even touch.** Two-thirds of the fleet
   runs on a transferred gauge record where flow choice is bypassed by design —
   "no effect" and "not applicable" look identical in a summary.

---

## Things already tried that measured worse

Do not re-try these without reading the comment blocks:

- **Mis-snap fixes, four of them**: wider main-stem search, lower promotion
  threshold, model-flow arbitration, snapping the click to OSM. Each added a
  rule firing *everywhere* to fix something wrong in ~4% of cases.
- **Widening the gauge-transfer bar** to `usable`: leave-one-out said better, the
  fleet said one plant went to 0.18× of licence. Gauges sit on well-determined
  catchments; plant intakes do not.
- **Handing magnitude to the regional regression**: the national gauge average
  said yes; split by catchment size it inverts below 100 km².
- **MERIT sampling changes** (narrower window, spike-clipping): halve the bleed
  rate, lose on the gauges.
- **GEOGLOWS v2** as a flow source: 2.35× typical error even after area-matched
  snapping, against our 1.48×.
- **Inverse-variance weighting of the blend.** An equal geometric mean is
  optimal only when both sources carry equal error variance, and they do not
  (network 1.53×, Modified HYDEST 1.40×). Weighting each by 1/σ² is the textbook
  fix and it buys nothing: leave-one-out 1.38× against 1.39×, project-weighted
  1.664× against 1.667×. Adding MHSP as a third weighted source is the same
  story. The sources' errors are correlated enough that reweighting cannot buy
  what independence would. `checks/blend-weights.mjs` re-runs the whole
  comparison.
- **Per-band bias constants.** The blend's bias is not uniform by catchment size
  — 1.156× under 100 km², 0.709× from 100–500, 0.899× above — and fitting one
  constant per band is *worse* out of sample (project-weighted 1.679× against
  1.637× for a single global constant). Fourteen gauges cannot support a
  per-band parameter.
- **Switching `fdcshape.ts` from one national curve to Modified HYDEST's
  per-catchment flow-duration regression.** The code carried this as an owed
  A/B, blocked on a rate limit the local GloFAS store had already removed.
  Scored on the dry share at 74 gauges, the national curve is better or level on
  bias in all four plan/machine combinations and never worse on typical error
  (Pelton 6+6: −3.7 pt / 5.1 against −4.0 pt / 5.1; Francis 8+4: −3.9 / 6.8
  against −5.0 / 7.1). It does yield slightly fewer false qualifications, but
  that is the extra pessimism showing up as caution, not better discrimination.
  **This does not overturn the gauge table in `fdcshape.ts`** — that measures
  the regression as a PREDICTOR of absolute flow, and this measures it as a
  SHAPE TEMPLATE for a series whose mean is already right. Different jobs.
- **Widening `fdcshape.ts` to correct every site, not only flagged ones.** On
  the dry share it looks like a win — bias −3.7 → −2.4 pt, typical error
  5.1 → 4.5 pt — and it is refused anyway, because false qualifications go
  5 → 12 out of 74. Removing conservative errors by manufacturing optimistic
  ones is not an improvement on a screening tool that quotes a tariff.
  `checks/dryshare-vs-gauges.mjs` re-runs the whole comparison.
- **Swapping pondage's primary terrain to GEDTM30.** Kulekhani argued for it
  loudly — surface area 0.57× → 0.77×, and a level table that stopped moving 20×
  per three metres and moved 1.10× instead. Paired over 166 satellite-measured
  shorelines it does not hold up: GEDTM30 takes the in-band rate 21% → 27% and
  the saddle escape 30% → 25%, and gives back both tails (p10 0.51× → 0.43×, p90
  14.4× → 29.3×), eight scored sites (28 failures → 36), four more window-edge
  runaways, and the head-to-head — **Mapterhorn is closer to the measured band on
  82 sites, GEDTM30 on 68, 16 tied.** Site by site GEDTM30 fixes 32 saddle
  escapes and creates 24, which is a coin flip wearing a 5-point aggregate. At
  Kulekhani itself, seeded from the satellite instead of its published dam
  coordinate, Mapterhorn reads 1.380 km² against GEDTM30's 1.527 on a band of
  0.730–1.314. Both arms read a median 0.78× of the ≥50% shoreline, so the
  screen's low bias is the method and not the surface. `checks/pondage-dem-ab.mjs`
  re-runs the whole comparison, paired, with the unpaired rows counted separately.
- **Seeding the GSW reference set on each waterbody's centroid.** Never shipped a
  number, and worth the entry because of how it failed: the mean position of a
  non-convex lake is not in the lake, Kulekhani's sat 665 m away on the ridge
  between two arms, and the harness reported the country's only large reservoir
  as unscoreable on BOTH terrain products — which reads exactly like a terrain
  limit. 82 of 206 seeds were more than 100 m out. The replacement, the point
  furthest from the shore, was itself wrong on the first attempt (an unpadded
  distance transform has no background, so `argmax` lands in a corner) and was
  caught by `--self-check` before it ran.
- **Four of the six ICIMOD RDS layers downloaded on 2026-08-25.** All CC-BY-4.0
  and all rejected after looking inside, not before. *Fault lines*: 16 lines for
  the whole of Nepal, some with five vertices, and the only attribute is
  `thrust-fault` — it cannot even name the MCT, and the app already carries GEM's
  Global Active Faults, which is far denser. *Settlements*: 165 points in the
  Nepal box, many of them Wade-Giles transliterations from the Tibetan side; it
  was wanted to TEST the BIPAD-centroid finding and is nowhere near village
  level. *Road network*: 810 lines, 767 of them "Secondary Route", DCW-era —
  OSM is already in the stack and denser, and access tracks to a hydro site are
  exactly what DCW omits. *Geologic Province*: turned out to carry the USGS
  world petroleum assessment schema (`CUM_OIL`, `REM_GAS`), nothing for
  hydropower. Two more were unreachable rather than rejected: the GLOF record
  has no file attached, and the DWIDM flood-hazard layers need permission from
  DWIDM.

- **Letting the water balance refuse a flow inside `flowchoice.ts`.** A
  catchment cannot deliver more water than falls on it, the app holds all three
  numbers, and the arbitration had chosen a candidate implying a runoff
  coefficient of 6.2 at a real site. It is still refused, twice over.
  **It does not discriminate**: at 69 gauges with a coefficient ceiling of 1.0
  it fires on the MEASURED mean 22/69 times and on the shipped blend 22/69 times
  — identical, so it carries no information about which of the two is wrong. And
  **the ceiling that is defensible is too quiet to fit a rule to**: the measured
  records run to 1.89 and the country averages 0.95, so anything at or below 1.89
  refuses a river a gauge recorded, and at 2.0 the screen fires on 5 of 168
  plants. On the fleet it also fails to pick out the plants the engine gets
  wrong — licence ratio median 2.59 where it fires against 2.06 where it passes,
  with the passing group holding the worse tail at both ends — and 36 of its 100
  fires land on rows running a transferred DHM record, where flow choice is
  bypassed by design. What ships is the report disclosure only.
  `checks/waterbalance-vs-fleet.mjs` re-runs the whole comparison.

- **A runoff-coefficient ceiling of 1.0**, which is the physically obvious one
  and shipped for exactly one turn before it was measured. It fires on **31.9% of
  measured Nepali gauge records** and 59.5% of the fleet. Nepal genuinely runs
  near 1 — about 1,530 mm of runoff against about 1,600 mm of rain nationally —
  so 1.0 sits in the middle of the distribution rather than above it. The
  ceiling is fitted to the gauges at 2.0 and `checks/waterbalance.check.ts`
  fails if anyone lowers it back under the measured maximum.

- **Widening the transfer bar, re-tested on the repaired records.** The DHM
  parser bug corrupted seasonal structure, so the leave-one-out that first
  argued for `usable` was scored on bad data. Re-run after the repair it says
  the same thing — `usable` 1.40× against `close` 1.44× with 10+ year donors —
  and the fleet's refutation still stands. The repair did not reopen this.

### The trap that recurs

**The gauge population is systematically easier than the use population.** DHM
gauges sit on rivers with a median catchment of ~800 km²; DoED projects sit near
~100 km². Gauges are order 4–5, projects order 1–3. MERIT's bleed rate is ~1% at
gauges and ~9% at projects. Three separate changes looked good on gauges and
failed on plants for this reason.

---

## Known defects, unfixed and deliberate

- **MERIT bleeds across confluences.** A 92 m flow-accumulation raster sampled
  near a big river picks up its line: 8.9% of order-1 points read >2× the
  reach's own area. A bleed and a genuine rescue are indistinguishable at a
  point, and any rule suppressing one discards the other.
- **5.2% of plants under-predict** (9/172 on the full register; it read ~4% on
  the 104-plant sample), all from a published coordinate landing on a tributary
  beside the real river. This is a data-quality ceiling, not a modelling one.
- **`OVERWHELMING_RATIO = 100` has a known false positive** (Upper Syange).
- Drawn river geometry uses OSM where traced (25.9% of vertices, mean 135 m
  movement); the engine does not, deliberately.

---

## Constraints

- **Nepal only.** Discharge requests outside the box are refused before a
  request is made — the free service is donation-funded and this app was
  spending its quota on questions it had no business asking.
- Private data stays gitignored: `sources/local/`, `sources/dhm/`,
  `sources/gem-pga`, `sources/icimod-pdgl`, `sources/merit-hydro`,
  `sources/glofas`. `sources/gedtm/`, `sources/geology/` and
  `sources/worldcover/` are gitignored for SIZE, not licence — every one of them
  rebuilds from a public source with one command.
- **MERIT Hydro is dual-licensed: CC BY-NC 4.0 or ODbL 1.0, licensee's choice.**
  ODbL is elected, so commercial use is permitted provided the derived data is
  published under ODbL — which this repository does, citing Yamazaki et al.
  2019. Derived per-vertex data ships; originals do not, because the authors ask
  that the tiles not be redistributed whole and in their original format without
  written permission. Four sections of this file used to say going commercial
  "would require contacting the developer or dropping it". It does not.
- Credentials live in `~/.cdsapirc`, never in the repo.
