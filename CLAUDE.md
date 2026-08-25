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

**The two halves of this table are stamped to different engines.** The fleet was
re-run whole on 2026-08-24 under `949cb685322e`; the gauge and head rows are
still the `28b4b3f033a8` measurement and have NOT been re-scored under it. Signed
code changed between the two, so the flow rows are a claim about slightly older
code than the plant rows. Re-running the gauge harness is the outstanding job.

Against **69 DHM gauges** with 10+ complete years (engine `28b4b3f033a8`) and
**193 commissioned Nepali plants** — the whole eligible register, not a sample
(engine `949cb685322e`):

| Quantity | Result |
|---|---|
| Flow, typical error | **1.37×** (blend), weighted to where projects sit: **1.64×** |
| Flow, bias | **1.00×** — unbiased, after the correction below |
| Flow, within a factor of two | **90%** of gauges |
| Head | no systematic bias, **σ 6.6 m**, 3.4% relative. Re-run three-way 2026-08-24: Mapterhorn is the best of three, see below |
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

GEDTM30 is still not the primary: one reservoir is not a population, and the
head measurement below says Mapterhorn is the better surface.

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

- **CC-BY-NC-SA.** MERIT Hydro is already the one non-commercial licence in this
  stack and this file already calls that a liability. A second one — plus a
  ShareAlike clause the first does not carry — deepens exactly the trap rather
  than paying it down. GEDTM30 is CC-BY-4.0 with no restriction at all.
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
| Catchment area | **MERIT Hydro** (CC-BY-**NC**) | per-vertex, 92 m. *The only non-commercial licence in the stack.* |
| Channel geometry | OpenStreetMap | length correction + drawn geometry |
| Terrain | Copernicus GLO-30 (Mapterhorn) | primary; best of three on head |
| Bare-earth terrain | **GEDTM30** (CC-BY-4.0) | local ~0.97 GB Nepal cut; the cross-check source, AWS where absent |
| Land cover | **ESA WorldCover 2021** (CC-BY-4.0) | local ~598 MB Nepal cut at 30 m; what the alignment crosses |
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

`npm run check` — unit checks, ~29 of them, all fast and offline.
`npm run build:fleet 1000 1` — run the whole eligible register through the
app's own engine in a real browser, about thirteen minutes. The `20 <seed>`
form still works and still accumulates, but seeded sampling existed only to
survive a rate limit the local GloFAS store removed; prefer the full run, which
cannot drift into a mixture of engines.
`npm run build:validation` — the curated ten plants.
`npm run probe:dem` — terrain error, measured rather than assumed.

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
- **MERIT Hydro is CC-BY-NC.** Derived per-vertex data ships; originals do not.
  Going commercial would require contacting the developer or dropping it.
- Credentials live in `~/.cdsapirc`, never in the repo.
