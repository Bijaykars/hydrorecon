# Nepal regional hydrology screen

HydroRecon uses the legacy WECS/DHM 1990 regional regressions as an independent Nepal-specific
screening comparator at ungauged reaches. The method is valuable because it was fitted to Nepali
gauges. It is not a substitute for a project flow series, gauge-frequency analysis or selection of
a design flood.

The primary catalogue record is *Methodologies for estimating hydrologic characteristics of
ungauged locations in Nepal*, published in 1990 by the Government of Nepal Water and Energy
Commission Secretariat with the Department of Hydrology and Meteorology. The [ICIMOD library
record](https://lib.icimod.org/records/ksjap-6sz72) preserves its publication metadata.

## What is calculated

For each month, the regional mean-flow equation is:

```text
Qmonth = C × Atotal^a1 × (Abelow5000 + 1)^a2 × MMP^a3
```

where areas are in square kilometres, `MMP` is June–September catchment precipitation in
millimetres, and the published coefficient set changes by month. January through May have a zero
rainfall exponent and can be evaluated without `MMP`. A reach with the rainfall input can return
all twelve regional monthly means. These are climatological regression estimates, not a daily
hydrograph, flow-duration curve or project water-availability series.

The regional flood anchors use catchment area below 3,000 m:

```text
Q2   = 1.8767 × (Abelow3000 + 1)^0.8737
Q100 = 14.63  × (Abelow3000 + 1)^0.7342
QT   = exp(ln(Q2) + S(T) × ln(Q100/Q2) / 2.326)
```

HydroRecon evaluates the published return-period set Q2, Q10, Q20, Q50, Q100, Q200 and Q500. The UI
and exports call these **regional flood estimates**. They are not a selected construction,
diversion, design, spillway check flood or PMF/PMP case.

## Rainfall and terrain inputs

The bundled river-reach input contains:

- upstream fractions below 5,000 m and 3,000 m, derived from Re:Earth Terrarium elevation tiles;
- June–September catchment precipitation derived from the Climate Hazards Center's 0.05°
  [CHPclim v2](https://chc.ucsb.edu/data/chpclim) monthly climatology; and
- HydroBASINS level-12 catchments used to average the gridded rainfall before attaching it to
  HydroRIVERS reaches.

CHPclim substitutes a gridded modern climatology for the original WECS/DHM monsoon-isohyet input.
Mountain precipitation and gauge-undercatch bias remain possible. The product is publicly
downloadable, but its page does not state a standalone reuse licence. HydroRecon therefore preserves
attribution and explicitly says that the repository's MIT licence does not cover this derivative
input.

`npm run build:mmp` downloads or reuses the four source rasters, rebuilds
`public/nepal-hypso.dat`, and writes `src/data/nepal-hydest-provenance.json`. The sidecar records
every source URL and SHA-256, the HydroBASINS archive hash, raster method, coverage, output hash,
rights boundary and limitations. The current bundle covers 34,669 of 42,197 reaches (82.2%); a
missing value stays missing rather than being spatially guessed.

## How the evidence is used

- Agreement with the selected global-flow magnitude can corroborate a desktop water-yield screen;
  it is never labelled gauge validation.
- Disagreement greater than twofold is surfaced and makes gauge transfer and measurement urgent.
- A regional Q100 can focus the flood campaign and provide a comparison value. It cannot advance
  the sediment/headworks gate beyond `screened` or select a design action.
- Every catchment input, all monthly values, all seven flood return periods, equations, sources,
  bundle checksum, rights warning and limitations survive into CSV and GeoJSON.

The field plan follows the current [DoED headworks
guidance](https://doed.gov.np/content/31/design-guidelines-for-headworks-of-hydropower-projects/)
and the [WECS Flood Control and Management
Manual](https://wecs.gov.np/storage/listies/January2021/river-training-manual-final--wecs-2020-06-15-%28f%29-%281%29.pdf).
It asks the engineer to establish a quality-controlled instantaneous-peak record and frequency
analysis, compare applicable regional and empirical methods, reconstruct historical floods using
marks/interviews/slope-area work, make at least one direct flood-discharge measurement where
records are absent, assess GLOF/CLOF scenarios, and document the adopted diversion, design/check
flood and PMF/PMP decisions. For gauged rivers the WECS manual generally calls for at least 20
years of peaks, with more than 30 preferred.

The current overarching study page is DoED's [Guidelines for Study of Hydropower Projects,
2018](https://doed.gov.np/content/35/guidelines-for-study-of-hydropower-projects--2018/).

