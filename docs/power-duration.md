# Daily hydrological power-duration screen

Ghatta reports the power equalled or exceeded on 90% and 95% of usable daily record values for
every retained layout. These figures answer a different question from P90 annual energy:

- **daily P90/P95 output** ranks dispatched power across individual record days; and
- **P90 annual energy** ranks total dispatched energy across complete calendar years.

The [ESHA 2004 *Guide on How to Develop a Small Hydropower Plant*, section
3.7](https://energypedia.info/images/c/ca/Part_1_guide_on_how_to_develop_a_small_hydropower_plant-_final1.pdf)
uses 90–95% availability of power as the screening range when discussing firm energy. Ghatta uses
those exceedances as an empirical hydrological screen but deliberately does not call the result firm
capacity.

## Calculation

Every usable daily river discharge is dispatched through the same physical chain used for annual
energy:

```text
available flow = max(0, river flow - environmental release)
turbine flow = min(available flow, design flow)
turbine flow = 0 below the selected runner's minimum operating fraction
net head(Q) = gross head × [1 - design-loss fraction × (Q / design Q)²]
power(Q) = ρ × g × turbine flow × net head(Q) × part-load efficiency(Q)
```

The daily powers are sorted by exceedance using the same Weibull plotting positions as Ghatta's
flow-duration curve. P90 is the power equalled or exceeded on 90% of usable days; P95 uses 95%.
The result also records the number of evaluated days and the fraction with zero output. A dry-day
turbine shutdown remains zero rather than being interpolated into fictitious generation.

## Why it is not firm capacity

The headline result is a hydrological capability of the one-unit screening arrangement. A separate
sensitivity evaluates one, two, three and four equal-rated identical units. For each daily flow and
each installed-unit count, it tries every feasible number of operating units, shares the admitted
flow equally, applies the per-unit turbine curve and retains the highest instantaneous power. The
waterway head loss still uses total plant flow. It does not include:

- forced or planned outages and contractual availability;
- station service, transformer outages or delivery losses;
- curtailment, grid constraints or cascade instructions;
- multi-unit commitment, unequal unit sizes or spinning reserve;
- reservoir, pondage or peaking operation;
- dynamic headwater/tailwater levels; or
- future-climate non-stationarity and operational environmental-release rules.

Several smaller units can materially change low-flow operation because an individual unit may stay
above its minimum technical flow after another unit is shut down. Conversely, equipment cost,
outages and station service reduce project value or deliverable power. The sensitivity assigns no
cost or availability benefit to extra machines and is not an equipment recommendation. Unit number,
rating and runner family therefore remain in the electro-mechanical work package.

The project engineer must define dependable/firm capacity against the applicable PPA and grid-code
test, measured or transferred hydrology, approved EFlow, unit arrangement, loss allocation and
availability requirement.

## Exports and guardrails

CSV and GeoJSON carry daily P90 MW, daily P95 MW, zero-output fraction, basis-day count, all four
unit-count scenarios, the ESHA reference and the non-claim. The readiness evidence sends the result to hydrology and equipment
work packages without advancing either discipline to measured/design status. This method is
jurisdiction-neutral and remains available in global mode; Nepal tariffs or policy are not involved.
