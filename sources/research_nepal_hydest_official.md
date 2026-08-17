# Nepal HYDEST and design-flood evidence lookup

Retrieved: 2026-08-13

Purpose: verify how Ghatta may characterize and export WECS/DHM regional hydrology and flood
estimates. The first official-domain `parallel-cli` query timed out without producing an output
file; the documented fallback web search was then used. This file preserves the resulting sources
and the implementation-relevant findings.

## Findings

1. The primary method is a 1990 Government of Nepal publication, *Methodologies for estimating
   hydrologic characteristics of ungauged locations in Nepal*, published by the Ministry of Water
   Resources, Water and Energy Commission Secretariat with DHM. The ICIMOD catalogue has metadata
   but no downloadable file.
2. The current DoED *Design Guidelines for Headworks of Hydropower Projects* explicitly include
   WECS/DHM and MHSP as regional flood methods. They do not authorize a single regional equation as
   the project design flood. The guideline requires comparison with other applicable methods,
   historical flood investigation, direct flood measurement where data are absent, and GLOF/CLOF
   investigation. It describes ungauged reliability as poor or very poor and says PMF/PMP should be
   determined where practicable and desirable.
3. The 2020 WECS *Flood Control and Management Manual* lists WECS/DHM (basin area below 3,000 m) as
   one method for ungauged rivers. For gauged rivers it calls for instantaneous peaks and flood
   frequency analysis, generally at least 20 years with more than 30 years preferred.
4. The current DoED *Guidelines for Study of Hydropower Projects, 2018* remains the governing study
   guidance page surfaced by DoED. Ghatta should link the current page even where the embedded PDF
   asset URL changes.
5. CHPclim v2 is a public-access 0.05-degree monthly precipitation climatology from the UC Santa
   Barbara Climate Hazards Center, combining satellite fields, physiographic predictors and
   station normals. Its page does not state a standalone reuse licence. The related CHIRPS product
   explicitly states public-domain status, but that statement should not silently be extended to a
   standalone CHPclim derivative. Ghatta should attribute CHPclim, identify it as a substitute for
   the original WECS/DHM isohyet input, and say that standalone reuse terms were not identified.

## Implementation decision

- Label calculated peaks **WECS/DHM regional flood estimates**, not **design floods**.
- Export every return period, catchment input, equation provenance and limitation.
- Never let a regional estimate advance the flood/headworks evidence above screening by itself.
- Require gauge-frequency analysis, historical flood marks/slope-area work, method comparison,
  direct measurement where applicable, and GLOF/CLOF/PMF/PMP decisions in the field plan.
- Label monthly flows as a legacy national regional-regression cross-check, not a substitute for a
  project hydrology study.

## Sources

- Department of Electricity Development, [Guidelines for Study of Hydropower Projects,
  2018](https://doed.gov.np/content/35/guidelines-for-study-of-hydropower-projects--2018/).
- Department of Electricity Development, [Design Guidelines for Headworks of Hydropower
  Projects](https://doed.gov.np/content/31/design-guidelines-for-headworks-of-hydropower-projects/).
- Water and Energy Commission Secretariat, [Flood Control and Management
  Manual](https://wecs.gov.np/storage/listies/January2021/river-training-manual-final--wecs-2020-06-15-%28f%29-%281%29.pdf).
- ICIMOD Library, [Methodologies for estimating hydrologic characteristics of ungauged locations in
  Nepal](https://lib.icimod.org/records/ksjap-6sz72), 1990 catalogue record, call number 551.48 WAM.
- UC Santa Barbara Climate Hazards Center, [CHPclim v2 product
  page](https://chc.ucsb.edu/data/chpclim).
- UC Santa Barbara Climate Hazards Center, [CHIRPS product and public-domain
  statement](https://www.chc.ucsb.edu/data/chirps).
