# A new flow comparison for Nepal

The app now offers a DHM catchment-analogue mean-flow estimate alongside Modified HYDEST, MHSP, the mapped network and the active estimate. It is an **experimental independent comparison**, not the default flow authority. It recalculates capacity and annual energy at the same selected layout, and exports the comparison as CSV.

## Method and data

For each target, select five donor catchments using these prespecified distance scales: log catchment area divided by log(4), log rainfall divided by log(2), elevation difference divided by 1,500 m, and below-3,000 m / above-5,000 m catchment fractions divided by 0.3. Weights are proportional to 1/(1 + distance²). Transfer each donor's observed mean discharge by the target-to-donor area and rainfall ratios, then take the weighted geometric mean. Neither observed target flow nor geographic proximity is an input to the similarity score.

The 69 eligible DHM summaries have at least ten complete years, valid mapped catchments and rainfall, and observed specific discharge between 0.005 and 0.25 m³/s/km². The selection follows the existing blend benchmark. Donor observations are historical and cover differing periods; this is not a current climate or operating-flow forecast. Only five test catchments are below 100 km², fourteen are 100–500 km² and fifty are larger.

Runtime and benchmark share `src/engine/flow-analogue.ts`. The derived donor bundle is rebuilt with:

```sh
node --experimental-strip-types --no-warnings checks/analogue-flow.probe.mjs --build
```

Without `--build`, the command evaluates the experiment and writes a local diagnostic result only. Raw private discharge files are neither bundled nor sent to a service by this experiment.

## Results

Typical error is exp(mean absolute log(predicted/observed)); lower is better. It is neither percent accuracy nor a confidence interval. Project weighting uses the existing 45% / 35% / 20% size-band weights. Bias corrections are fitted inside each training fold. All methods predict the same 69 stations in every split; failures cannot silently reduce the denominator.

| Holdout | Method | Typical error | Project-weighted error | Stations outside factor 2 |
| --- | --- | ---: | ---: | ---: |
| One station | Modified HYDEST | 1.399× | 1.785× | 9 |
| One station | Current blend, in-fold bias | 1.376× | 1.637× | 7 |
| One station | Catchment analogue | **1.310×** | **1.597×** | 6 |
| Stations within 50 km | Current blend, in-fold bias | 1.379× | **1.648×** | 8 |
| Stations within 50 km | Catchment analogue | **1.364×** | 1.729× | 8 |
| Target's 2° longitude band | Current blend, in-fold bias | 1.381× | **1.636×** | 8 |
| Target's 2° longitude band | Catchment analogue | **1.377×** | 1.774× | 8 |

A second candidate transferred local corrections to the current blend instead of specific runoff. It was worse: 1.795×, 1.955× and 1.848× project-weighted error in the three splits, and is not offered in the app.

**Decision:** the direct analogue improves on Modified HYDEST in these tests, but does not consistently improve on the current blend. Its spatial-transfer result is especially relevant to unobserved project sites. Keep it as a visible comparison with donor identities and weak-match flags. No automatic substitution, averaging, or narrowing of uncertainty is justified by this experiment. Geographic buffers and longitude bands are spatial stress tests, not proof of hydrologically independent basin holdouts. The existing blend benchmark is a comparison of its mean-flow formula, not the entire app's conditional flow-source selection. These mean-flow results do not validate layout, capacity or annual energy accuracy.

## What the displayed capacity comparison means

Every alternative normalizes the actual active flow record to its own target mean. The intake, powerhouse, terrain profile, exceedance choice, efficiency assumption and environmental-release fraction remain the same. The existing engine then sizes the waterway, computes hydraulic losses and turbine part-load behavior, and integrates energy. Net head can consequently differ across rows even though gross head is held constant. This compares **mean-flow assumptions using a shared flow pattern**, not independent simulations of daily hydrology.

Supplied/borrowed gauge records have a network transport reference in `SchemeInput.seriesMeanCms`; this is not necessarily their true mean. The comparison explicitly normalizes the actual series so it does not accidentally replace measurements with network magnitude. Failed hydraulic designs show as unavailable, never as a fabricated zero. Inspecting or exporting a comparison leaves the active scheme unchanged.

The panel also exposes gross head, hydraulic losses, net head, catchment inputs and a shortcut to the existing detailed site audit. Pending audit results now belong to the exact intake/powerhouse pair and active measured record; moving either endpoint invalidates them, preventing an earlier layout's head from being attached to the new one.

## Why this method, and what remains ahead

Nepal-specific work by Karki et al. used GR4J–CemaNeige and compared regionalization methods across 23 watersheds; physical similarity was the most robust approach in that study. This motivated testing catchment similarity here, but our simpler mean-runoff transfer is **not** their calibrated rainfall–runoff model. It does not inherit their published NSE. [Original paper](https://doi.org/10.1016/j.ejrh.2023.101359).

More ambitious alternatives exist. Differentiable physics-informed models combine a hydrological model with trainable parameter estimation. A regional holdout study found advantages over LSTM for extrapolation to ungauged regions, under that study's data and setup. It supplies no measured Nepal advantage over this app. [HESS study](https://hess.copernicus.org/articles/27/2357/2023/).

For the next default-model change, the useful experiment is a calibrated daily rainfall–runoff/snow model with Nepal meteorological forcing, complete-basin and time holdouts, project-sized catchment coverage, Q40/Q90 and dry-season validation, and fixed-layout generation checks. A prettier centreline, another satellite basemap or a newer model name cannot substitute for those measurements. Surveyed water-level elevations and confirmed intake catchment boundaries remain the strongest way to reduce head and location errors at a specific project.

## Verification

`npm run check:flow-comparison` checks known runoff transfers, insufficient/invalid inputs, weak-match reporting, actual measured-record normalization, proportional residual releases, fixed geometry, hydraulic recalculation and CSV quoting. `npm run check:live:flow-comparison` checks the user's current river, all five rows, donor evidence, downloadable output, unchanged active results, invalidation of a pending audit after moving the layout, mobile layout and browser errors. The normal calculation suite and production build also pass.
