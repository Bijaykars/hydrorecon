# Nepal ROR PPA reference-value lookup

Retrieved: 2026-08-13

Purpose: determine whether Ghatta can turn its already calculated NEA wet/dry dispatched energy
into a useful monetary screening value without implying that a project has a PPA, an entitlement,
contract energy or bankable revenue.

## Findings

1. The current Nepal Electricity Authority PPA tariff page continues to publish the Board decision
   effective 2074/01/14 (27 April 2017).
2. For run-of-river projects up to 100 MW, the posted base rates are NPR 4.80/kWh wet and NPR
   8.40/kWh dry. The decision offers a 6+6-month option requiring at least 30% dry-season energy
   and an 8-wet+4-dry-month option requiring at least 15% dry-season energy.
3. The decision says the posted rate receives 3% simple escalation for eight years for capacity up
   to 100 MW. For projects above 100 MW the base rate may be lowered where return on equity exceeds
   17%. Ghatta cannot infer either a project's negotiated base rate or its escalation year.
4. The Electricity Regulatory Commission's April 2025 storage-hydro pricing discussion paper
   independently describes NPR 4.80/kWh wet and NPR 8.40/kWh dry as the prevailing Nepal
   hydropower tariffs. This corroborates continued use but does not replace the NEA Board decision.
5. Multiplying dispatched seasonal GWh by the two base rates gives **million NPR/year** directly:
   `GWh × NPR/kWh = million NPR`. This is a gross energy-value comparator. It excludes contracted
   energy, losses/metering point, outages, spill obligations, deemed generation, take-or-pay,
   curtailment, penalties, escalation, tax, royalty, O&M, debt and financing.

## Implementation decision

- Add a pure, tested base-rate calculation to both existing PPA season options.
- Label it **gross reference energy value at published NEA base rates**, not revenue, cash flow,
  NPV, LCOE or bankability.
- Show the result only in Nepal mode, with the dry-energy eligibility result beside it.
- State that values over 100 MW require negotiated/base-rate review and do not receive an automatic
  posted-rate claim.
- Apply no escalation automatically; the app does not know COD, PPA vintage or negotiated terms.
- Export the rates, value, source/effective date and every limitation.
- Keep the economics readiness gate `not-assessed`.

## Sources

- Nepal Electricity Authority, [PPA Tariff Rates](https://www.nea.org.np/en/pages/ppa-tarrif-rates).
- Nepal Electricity Authority, [Board Decisions on the Power Purchase Rates and Associated Rules
  for PPA of ROR/PROR/Storage Projects Effective from 2074/01/14](https://www.nea.org.np/admin/assets/uploads/PPA_Rates.pdf).
- Electricity Regulatory Commission, [Discussion Paper on Storage Hydro PPA
  Pricing](https://erc.gov.np/storage/contents/April2025/tme2fFz9L5QMZSqxROI6.pdf), April 2025.

