# Nepal layout limits and accuracy review

Reviewed 11 September 2026. The changes improve placement and constrain the search; they do not establish a new accuracy claim for head or generation.

## Layout length

The interactive app now defaults to a **6 km maximum along-river distance** between intake and powerhouse, with 5 km and 10 km choices. The same constraint applies to discovery, corridor search and manual evaluation. The default intake window is zero: finding more energy downstream cannot silently move the intake. The optional wider corridor search may move the intake, but each candidate still obeys the selected length limit.

The old search allowed a 14 km waterway; manual evaluation had no corresponding limit. The 22 km study corridor is still available to inspect downstream terrain. It is not the proposed scheme length. The old fallback that selected the entire terrain path when discovery found nothing has been removed.

Published examples explain why a configurable limit is preferable to a universal claim that Nepal projects should be 6 km long:

| Project | Published headrace tunnel length | Primary source |
| --- | ---: | --- |
| Chameliya | 4.067 km | [NEA Generation Directorate, 2020](https://www.nea.org.np/admin/assets/uploads/annual_publications/Generation_2020.pdf) |
| Khimti I | 7.885 km | [Himal Power technical specification](https://hpl.com.np/projects/) |
| Upper Tamakoshi | 8.4 km | [Developer's salient features](https://utkhpl.org.np/salient-features/) |

These are examples, not a representative statistical distribution. Khimti's page gives differing rounded/descriptive figures; the table uses its technical specification. Its penstock and tailrace are additional lengths. Upper Tamakoshi also lists a 1.134 km penstock and 2.9 km tailrace. An along-river screening length cannot be treated as a constructed tunnel length: tunnels can cross bends or transfer between valleys. Six kilometres is a user-oriented search constraint, not a surveyed engineering optimum.

## Intake placement and the dashed lines

Nearest-reach selection already projected a click onto a segment, but the downstream walk discarded that projection and started at its nearest stored vertex. The interactive study now begins at the projected position and resamples downstream from there. Reach selection, catchment-source rules and the legacy downstream API default are preserved. Basemap fallback snapping also projects onto line segments rather than choosing vertices.

This removes vertex-only selection on the mapped network. It does not make every visible tributary a validated hydrological reach: coverage, model alignment and terrain-derived fallback limitations still apply. Marker dragging uses the study's sampled positions. Display matching remains separate from numerical coordinates and reports its displacement.

The cyan and green dashed lines ending in dots are straight-line **road-access gaps**, from the intake and powerhouse to mapped roads. They are neither river courses nor conveyance routes. A separate Road-access gaps toggle now defaults off, including when upgrading an old saved pondage preference. Pondage remains independently visible.

## Methods that could improve the estimates

**GR4J–CemaNeige with physically similar donor catchments is the most relevant research candidate.** Karki et al. tested GR4J with a snow module across 23 Nepal watersheds and compared regression and donor methods using leave-one-out validation. Physical similarity was the most robust regionalization approach in that study; averaging donor outputs helped. Its reported median validation NSE of 0.74 refers to on-site calibrated models, not guaranteed performance at arbitrary ungauged intakes. This is evidence to investigate, not a benchmark against HydroRecon. [Original paper, author-hosted full text](https://www.researchgate.net/publication/369301143_Comparative_performance_of_regionalization_methods_for_model_parameterization_in_ungauged_Himalayan_watersheds), [DOI](https://doi.org/10.1016/j.ejrh.2023.101359).

**Regionalization plus a process-based flow-duration model** is a newer candidate. Lan et al. (2025) combine hydrological similarity, delayed-flow components and vine copulas, reporting improvements particularly for low-to-middle flows in nine MOPEX basins and examining transfer to the Hanjiang. It addresses the shape of the flow-duration curve, which matters to dry-season output. Its study population is not Nepal, so it cannot establish an improvement here. [Publisher's article](https://www.sciencedirect.com/science/article/pii/S0022169424017608).

Neither method has been substituted into the app. A credible adoption experiment needs daily precipitation, temperature and evapotranspiration forcing, catchment descriptors, quality-controlled discharge and calibration. Hold out entire basins as well as periods; neighbouring gauges are not independent evidence. Compare dry-season flow and Q40/Q90, annual energy on identical fixed layouts, bias, failure counts and coverage. Include small project-sized catchments rather than allowing large gauged rivers to dominate the result.

## Local comparison rerun

Command: `node --experimental-strip-types --no-warnings checks/blend-weights.mjs`.

The existing benchmark uses 69 gauges with at least ten complete years and leave-one-out fitting for the fitted comparison rules. Only five records represent catchments below 100 km². Lower multiplicative error is better; 1.38× is not “38% accuracy” or a confidence interval.

| Mean-flow method | Typical multiplicative error | Project-weighted score |
| --- | ---: | ---: |
| Network alone | 1.53× | 1.860× |
| Modified HYDEST alone | 1.40× | 1.785× |
| MHSP alone | 1.42× | 1.677× |
| Current geometric network × Modified HYDEST blend, bias corrected | **1.38×** | **1.637×** |
| Three-source inverse-variance blend | 1.38× | 1.664× |
| Three-source inverse-variance blend, bias corrected | 1.38× | 1.667× |

The rerun supports retaining the current mean-flow blend over these tested alternatives. It does **not** test the two research methods above and does **not** validate head or annual energy accuracy. The benchmark's geographic and small-catchment coverage limits remain material.

## Head and generation

Moving a displayed marker onto imagery cannot fix its numerical elevation. Head depends on the actual intake water level and tailwater level, their vertical datum, and DEM performance in steep valleys. The app retains its existing terrain profile, hydraulic-loss sizing, environmental-flow deduction, turbine part-load treatment and flow-duration integration. These are screening estimates. The practical next accuracy gain requires surveyed endpoint elevations and a documented waterway alignment, with measured or locally calibrated flow. Compare published project head and energy only at the same intake/powerhouse layout; optimizing a different layout is not a validation of that plant.

## Verification

`checks/layout.check.ts` covers continuous starts at the user's coordinates, catchment/reach preservation, path bounds, fixed intakes, exact 5/6/10 km limits, irregular chainage, manual evaluation and corridor search. `checks/layout.live.mjs` covers the controls, migration of old layer preferences, independent road visibility, basemap switching and mobile overflow. The river-display live check compares numerical results before and after display toggles; the obsolete fixed-layout snapshot is no longer used to demand identical results after an intentional intake/layout change.
