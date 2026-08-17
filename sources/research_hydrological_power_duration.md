# Hydrological power-duration research audit — 2026-08-13

## Question

What defensible low-flow power statistic can Ghatta calculate from its existing daily flow dispatch
without mislabelling a model percentile as contractual firm capacity?

## Primary method source

- ESHA, *Guide on How to Develop a Small Hydropower Plant* (2004), section 3.7:
  https://energypedia.info/images/c/ca/Part_1_guide_on_how_to_develop_a_small_hydropower_plant-_final1.pdf
- The guide treats 90–95% power availability as the screening range for firm-energy discussion and
  notes that run-of-river projects have low firm-energy capability.
- Nearby sections require the residual release and minimum technical turbine flow to be included in
  energy/capacity calculations; section 3.6.1 also notes that conveyance losses reduce approximately
  with the square of admitted flow.

The copy is the original ESHA guide produced by the European small-hydropower thematic network,
not a secondary formula blog. No guide text or figures are bundled in the repository.

## Operational corroboration

- IHA Jhimruk sediment-management case study:
  https://www.hydropower.org/sediment-management-case-studies/nepal-jhimruk
- The Nepal plant operates three units and shuts them down sequentially under increasing sediment
  concentration. This is real operational evidence that unit commitment can affect delivered output;
  it does not supply a universal unit-number rule.

## Implementation decision

For each retained scheme, dispatch every usable daily flow with the existing environmental release,
turbine cap, minimum-flow shutdown, Q² hydraulic loss and part-load curve. Rank daily power by
Weibull exceedance and report P90/P95 MW plus zero-output share and basis days.

Also calculate a transparent one-to-four equal-rated-unit sensitivity. For each installed count and
day, test all feasible numbers of running units, divide admitted flow equally between operating
units, apply the corresponding per-unit turbine curve, and keep the greatest instantaneous power.
Retain total-flow waterway loss. The one-unit row must reproduce headline energy and P90/P95 exactly.
Assign no cost, outage credit or recommendation to extra units.

Do not call the values firm capacity. Explicitly exclude forced/planned outages, station service,
curtailment, grid/cascade instructions, multi-unit commitment, storage/peaking and contract tests.
Keep P90 annual energy visibly separate because it ranks complete-year energy rather than daily
power. Preserve the source, method and non-claim in the UI, readiness evidence, CSV and GeoJSON.
