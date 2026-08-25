# Nepal ROR PPA reference energy value

HydroRecon values the selected scheme's already-dispatched wet and dry energy at the published Nepal
Electricity Authority run-of-river base rates. This closes a useful arithmetic loop for early
screening while deliberately stopping short of a revenue, cash-flow or bankability model.

The official [NEA PPA tariff page](https://www.nea.org.np/en/pages/ppa-tarrif-rates) publishes the
[Board decision effective 2074/01/14](https://www.nea.org.np/admin/assets/uploads/PPA_Rates.pdf)
(27 April 2017). For ROR projects up to 100 MW, the posted base rates are:

| Season | Published base rate |
|---|---:|
| Wet | NPR 4.80/kWh |
| Dry | NPR 8.40/kWh |

The decision offers two seasonal tests already calculated by HydroRecon:

- 6 wet + 6 dry months, requiring at least 30% dry-season energy; and
- 8 wet + 4 dry months, requiring at least 15% dry-season energy.

The Electricity Regulatory Commission's [April 2025 storage-hydro pricing discussion
paper](https://erc.gov.np/storage/contents/April2025/tme2fFz9L5QMZSqxROI6.pdf) independently calls
4.80/8.40 the prevailing Nepal hydropower wet/dry tariffs. The NEA decision remains the primary
source used in the app.

## Calculation

For each season option:

```text
gross reference value (million NPR/year)
  = wet dispatched energy (GWh) × 4.80 (NPR/kWh)
  + dry dispatched energy (GWh) × 8.40 (NPR/kWh)

blended base rate (NPR/kWh)
  = gross reference value (million NPR) / total energy (GWh)
```

The units cancel exactly because one GWh multiplied by one NPR/kWh is one million NPR. Wet/dry
energy uses the same residual flow, scheme-specific hydraulic losses, turbine part-load curve and
active measured or modelled flow record as headline energy.

## What it does not claim

The result is labelled **gross reference energy value at published NEA base rates**. It is not:

- evidence that a project has or qualifies for a PPA;
- contracted or billable energy;
- revenue, EBITDA, cash flow, NPV, IRR, LCOE or a bankability conclusion; or
- a forecast of escalation or future tariff policy.

HydroRecon applies no escalation. The Board decision describes 3% simple escalation for eight years
for eligible capacity, but the app does not know the project's PPA vintage, COD, escalation year
or negotiated terms. For a screened scheme above 100 MW, the app warns that the decision allows a
lower base rate where return on equity exceeds 17%; project-specific review is mandatory.

The comparator also excludes contracted-energy limits, delivery/metering losses, outages,
curtailment, deemed generation, take-or-pay allocation, penalties, royalties, tax, O&M, debt,
financing and currency effects. Those remain required inputs to the `not-assessed` economics gate
and its pre-feasibility work package.

CSV and GeoJSON preserve both season options, seasonal energy shares, eligibility result, gross
reference value, blended base rate, source, effective/review dates, capacity boundary, escalation
non-assumption and all non-claims. Global mode exports nulls rather than applying Nepal tariffs.

