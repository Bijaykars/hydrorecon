# Accuracy audit — dispatch, record coverage and Nepal PPA energy

Date: 2026-08-13

This pass concentrated on errors that can change a screening decision. No external source code was
copied. Published definitions, official rules and API behaviour were used to test and revise the
project's own TypeScript implementation.

## Authoritative findings

- The [World Bank hydropower developer guide](https://documents.worldbank.org/curated/en/917841468188335073/pdf/99392-WP-Box393199B-PUBLIC-Hydropower-Report.pdf)
  describes the flow-duration curve as a daily-flow construction, recommends at least 15 years for
  reliable statements, and uses the same power/energy chain implemented here.
- [Open-Meteo's Flood API documentation](https://open-meteo.com/en/docs/flood-api) says the endpoint
  returns GloFAS discharge for the largest river in a roughly 5 km cell, explicitly warns that the
  closest river can be selected incorrectly, and exposes data from 1984 where the local model has
  coverage.
- Open-Meteo's [pricing and licence page](https://open-meteo.com/en/pricing) identifies the public
  API as non-commercial and the data as CC BY 4.0. The README now separates the data licence from
  the service's usage terms.
- Nepal's official [Hydropower Development Policy](https://repository.lawcommission.gov.np/np/documents/prevailing-law/%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF/%E0%A4%9C%E0%A4%B2%E0%A4%B5%E0%A4%BF%E0%A4%A6%E0%A5%8D%E0%A4%AF%E0%A5%81%E0%A4%A4-%E0%A4%B5%E0%A4%BF%E0%A4%95%E0%A4%BE%E0%A4%B8-%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF-%E0%A5%A8%E0%A5%A6%E0%A5%AB/%E0%A5%AC-%E0%A4%95%E0%A4%BE%E0%A4%B0%E0%A5%8D%E0%A4%AF%E0%A4%A8%E0%A5%80%E0%A4%A4%E0%A4%BF%C3%B7%E0%A4%9C%E0%A4%B2%E0%A4%B5%E0%A4%BF/)
  requires at least 10% of the minimum monthly average flow, or the larger EIA requirement, to remain
  in the river. This supports the app's default basis while preserving the editable control.
- The [NEA Board PPA decision](https://nea.org.np/admin/assets/uploads/PPA_Rates.pdf) publishes two
  run-of-river season options: 30% minimum dry energy with 6 wet/6 dry months, or 15% minimum dry
  energy with 8 wet/4 dry months. Both are now evaluated. Bikram Sambat boundaries are mapped to the
  nearest Gregorian day and explicitly labelled as a screening approximation.
- [USACE ER 1110-2-1463](https://www.publications.usace.army.mil/Portals/76/Publications/EngineerRegulations/ER_1110-2-1463.pdf)
  distinguishes dependable capacity, firm energy and specified-availability methods. The app
  therefore calls its new statistic “P90 annual energy,” not “firm capacity.” An
  [IRENA firm-capacity study](https://www.irena.org/-/media/Files/IRENA/Agency/Publication/2023/Aug/IRENA_Firm_capacity_Central_America_2023.pdf)
  also derives run-of-river firmness from historical hydrologic series, supporting year-by-year
  dispatch while showing that market definitions remain jurisdiction-specific.

## Live API probe

The same request path used by the app was probed at 27.95 N, 85.95 E on 2026-08-13.

| Model request | Requested axis | Non-null local coverage | Decision |
|---|---:|---:|---|
| `consolidated_v4` | 1984–2025 | 1997-01-01 to 2025-05-31 | Keep consolidated history; reject incomplete years |
| `seamless_v4` | 1984–2025 | 1997-01-01 to 2025-12-31 | Not mixed into long-term statistics |
| default | 1984–2025 | 1997-01-01 to 2025-12-31 | Not used while consolidated succeeds |

For the ordinary 2006–2025 request, this leaves 19 complete years (2006–2024). For an “up to 40
years” audit at this cell, local coverage leaves 28 complete years (1997–2024), not 40. The UI now
reports the retained count rather than the requested count.

## Defects corrected

1. Partial latest/early GloFAS years were silently shortened by dropping nulls. This could weight an
   FDC toward whichever seasons remained. Records are now trimmed to substantially complete
   calendar years before any hydrologic statistic.
2. The displayed wet/dry energy used a simplified second calculation: flat efficiency, an assumed
   loss fraction, the raw model series, and no imported gauge record. It could disagree with annual
   energy. PPA and P50/P90 figures now use the exact selected turbine curve, residual flow,
   scheme-sized loss and active flow source.
3. The FDC panel displayed the raw GloFAS cell while the turbine used the river-network magnitude.
   At the live Marsyangdi check this showed a 3.42 m³/s mean beside a Q40 of 83.88 m³/s. The chart
   now displays the scaled series at the selected intake (133.19 m³/s mean in that run).
4. The UI described the 8+4 PPA option as two “half-years.” It now names the actual 8- and 4-month
   seasons and evaluates the alternative 6+6 option separately.

## Remaining boundary

P90 here is an empirical exceedance statistic over complete model years. It does not incorporate
model bias, future climate non-stationarity, forced outages, curtailment, station service, contract
interpretation or financing uncertainty. It is useful for comparing schemes and identifying dry-year
risk, but it is not a bankable energy assessment or contractual dependable-capacity certificate.

## Current-data audit

The earlier nearby-project layer depended at runtime on an Open Data Nepal CSV
mirror with no embedded update date. It has been replaced by a bundle derived
from all nine official DoED hydro registers:

- [survey licences above 1 MW](https://doed.gov.np/pages/hydromorethan1/) and
  [below 1 MW](https://doed.gov.np/pages/hydrolessthan1/);
- [construction licences above 1 MW](https://doed.gov.np/pages/clhydromorethan1/)
  and [below 1 MW](https://doed.gov.np/pages/clhydrolessthan1/);
- [operating plants above 1 MW](https://doed.gov.np/pages/powerplantsmorethan1/)
  and [below 1 MW](https://doed.gov.np/pages/powerplantslessthan1/);
- survey applications [above 1 MW](https://doed.gov.np/pages/appslhydromorethan1/)
  and [below 1 MW](https://doed.gov.np/pages/appslhydrolessthan1/); and
- [construction applications](https://doed.gov.np/pages/appclhydro/).

On 2026-08-13 those official pages reported an update date of July 31, 2026.
The complete extract contains 1,175 records, 1,169 with usable coordinates. Each
page's row count and every consecutive serial number were audited before the
bundle was written. The government tables publish coordinate ranges; preserving
the ranges and measuring to the range prevents a long project from disappearing
because its midpoint happens to sit more than 6 km away.

The official tables also publish promoter contact blocks. Addresses are never
copied, promoter fields are reduced to names, and automated scans reject email
addresses and phone numbers. This is both a privacy rule and a data-quality rule:
contact text is not a project attribute.

The OpenStreetMap grid extract was refreshed through an alternate Overpass
mirror on 2026-08-13 after the primary endpoint returned 504. Counts remained
stable at 486 transmission-line ways and 224 substations. The protected-area
service remained unavailable for the full relation query, so the verified
20-area snapshot from 2026-08-12 was retained and dated honestly. The DHM API
also timed out during this pass; its complete 1,115-station snapshot from
2026-08-12 was retained. Both builders now retry with long timeouts, and the
grid builder has mirror failover.
