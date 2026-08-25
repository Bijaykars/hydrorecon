# Prompt for an independent review

Paste this, then the files it asks for.

---

You are reviewing a hydropower pre-feasibility screening tool for Nepal. I want
you to find **errors in the physics, hydrology and arithmetic** — not style, not
architecture, not test coverage.

## What the tool does

Given a coordinate on a Nepali river it finds a run-of-river scheme and reports
capacity, annual energy, gross and net head, design flow and a flow-duration
curve, with an uncertainty band on each headline number.

## What I want you to check, in priority order

**1. Unit errors and dimensional mistakes.** Every conversion. Particularly:
m³/s vs m³/day, km² vs m², metres vs feet, MW vs kW vs GWh, percent vs fraction,
degrees vs radians. State the line and the correct value.

**2. The power and energy equations.** Check `P = ρ g Q H η` is applied with the
right head (net, not gross), the right efficiency chain (turbine × generator ×
transformer), and that energy integrates dispatch correctly over days with the
right day counts per month. Check the design flow is capped at the turbine's
rated flow and that residual/environmental release is subtracted **before**
capping, not after.

**3. The regional hydrology regressions.** Three published Nepali methods are
implemented:
- **Modified HYDEST** — `exp(S + T·ln(elev) + U·ln(rain) + V·ln(A<3000))` for
  most months, `(S + W·√(A<5000))²` for March–May.
- **WECS/DHM 1990 HYDEST**
- **MHSP 1997** — `Q_month = C · A^a1 · MMP^a2`

Check the coefficient tables against the published sources if you know them.
Check which months use which functional form. Check the flow-duration
interpolation (one method interpolates Q45 linearly between Q40 and Q60 — verify
that is reproduced, not "improved").

**4. Flow-duration curve and exceedance conventions.** Q40 means "exceeded 40%
of the time", so Q40 > Q60 and **Q40 must be below the mean** on a monsoon
river. Verify the percentile convention is not inverted anywhere. Verify a
flow-duration curve built from monthly means is never confused with one built
from daily values — they differ systematically and the difference matters most
at Q95.

**5. Statistical treatment.** Errors are scored in **log space** (a factor of
two high and a factor of two low should count the same). Check that medians,
biases and "typical error" are computed consistently and that nothing averages
ratios arithmetically where it should be geometric.

**6. Geometry and terrain.** Haversine distances, the perpendicular used for
cross-slope, slope as rise/run vs percent vs degrees, and whether elevation
differences (head) are being confused with absolute elevations. The two have
very different error characteristics and the code claims they do.

**7. Anywhere a number could be quietly wrong and still look plausible.** This
is the real ask. Flag any calculation whose failure mode is a believable wrong
answer rather than an exception.

## How to report

For each finding: **file and line**, what is wrong, what the correct expression
is, and how you would demonstrate the error (a worked example with numbers).
Rank by consequence to the final capacity figure.

If you believe something is correct but unusual, say so briefly rather than
flagging it — the codebase deliberately reproduces some published methods
including their quirks, and those quirks are documented in comments.

## Files to review

Core engine (start here):
- `src/engine/discover.ts` — scheme search, power and energy
- `src/engine/modified-hydest.ts` — the office regression
- `src/engine/hydest.ts` — WECS/DHM 1990
- `src/engine/mhsp.ts` — MHSP 1997
- `src/engine/fdcshape.ts` — flow-duration shape
- `src/engine/flowchoice.ts` — which flow source wins
- `src/engine/hydro.ts` — flow-duration curve, exceedance, residual flow
- `src/engine/turbine.ts` — turbine selection and efficiency
- `src/engine/waterway.ts` — head loss sizing
- `src/engine/uncertainty.ts` — the error bands
- `src/engine/corridor.ts` — cross-slope classification
- `src/engine/units.ts` — conversions

Supporting:
- `src/rivers.ts` — catchment area, snapping
- `src/dhm.ts` — gauge transfer by catchment ratio
- `src/api.ts` — discharge fetch, complete-calendar-year filtering
- `src/validate.ts` — the validation harness

Read `CLAUDE.md` first for context on what has already been measured and
rejected — several apparent oddities are deliberate and documented.
