# Nepal hydropower environmental-flow floor lookup

Retrieved: 2026-08-13

Purpose: verify the minimum environmental-release basis and prevent Nepal-mode calculations from
running below a published policy floor.

## Findings

1. Section 6.1.1 of Nepal's Hydropower Development Policy, 2058 (2001) requires the river release
   to be the higher of at least 10% of the river/stream's minimum monthly average discharge or the
   minimum required by the environmental impact assessment.
2. The Nepal Law Commission currently publishes the policy in its prevailing-law repository, and
   DoED publishes an English PDF. The numeric rule is a floor, not a complete ecological-flow
   method or an entitlement to divert everything above it.
3. Recent official project documents apply the floor in practice: DoED's Loti Karnali EOI states
   0.571 m³/s as 10% of lowest monthly flow; the Upper Arun EIA states 10% of the lowest monthly
   average flow and gives environmental release priority over power generation.
4. A desktop monthly model cannot determine habitat, water quality, fish passage, downstream use,
   ramping, sediment continuity, seasonal release pattern, cascade effects, drought operations or
   the EIA-approved value. Those remain field and approval work.

## Implementation decision

- Nepal mode clamps the editable residual fraction to a minimum of 10%; moving from global mode
  cannot leave a sub-floor value active.
- The calculation remains 10% (or the user's larger fraction) of the lowest monthly mean, not 10%
  of annual mean.
- The UI and exports call this a **policy-floor screening release**, never an approved EFlow.
- The field plan requires the approved EIA value, seasonal/ecological/hydraulic basis, downstream
  uses, release works, drought/ramping rules and monitoring/compliance plan.
- Global mode retains a 0–50% exploratory control and makes no Nepal-policy claim.

## Sources

- Nepal Law Commission, [Hydropower Development Policy 2058, working policy section
  6](https://repository.lawcommission.gov.np/np/documents/prevailing-law/%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF/%E0%A4%9C%E0%A4%B2%E0%A4%B5%E0%A4%BF%E0%A4%A6%E0%A5%8D%E0%A4%AF%E0%A5%81%E0%A4%A4-%E0%A4%B5%E0%A4%BF%E0%A4%95%E0%A4%BE%E0%A4%B8-%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF-%E0%A5%A8%E0%A5%A6%E0%A5%AB/%E0%A5%AC-%E0%A4%95%E0%A4%BE%E0%A4%B0%E0%A5%8D%E0%A4%AF%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF%C3%B7%E0%A4%9C%E0%A4%B2%E0%A4%B5%E0%A4%BF/).
- Department of Electricity Development, [Hydropower Development Policy 2058 (2001), English
  PDF](https://doed.gov.np/storage/listies/January2020/hydropower-development-policy-2058-2001.pdf).
- Department of Electricity Development, [Loti Karnali PRoR project
  EOI](https://doed.gov.np/source/EOI%206-Loti%20Karnali%20%281%29.pdf).
- Ministry of Forests and Environment, [Upper Arun HEP EIA, revised January
  2024](https://mofe.gov.np/uploads/uploads/notices/uahep-vol-ieia-report-revised-jan-2024-finalpdf-2064-0531704872883.pdf).

