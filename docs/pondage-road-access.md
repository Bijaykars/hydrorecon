# Possible pondage and motor-road proximity

Date implemented: 2026-08-22

HydroRecon now screens two practical questions for the selected intake–powerhouse layout:

1. If the retained water level were a selected height above the DEM-detected channel bed, what
   connected upstream area and terrain volume could be inundated?
2. How far are the intake and powerhouse from the nearest segment accepted by a live
   OpenStreetMap car-routing graph?

Both answers are intended for site ranking and field planning. Neither is a design quantity.

## Pondage method

The implementation follows the common core of the mature open-source methods reviewed below.

1. Read locally metric 30 m terrain grids around the selected intake from both live terrain
   chains. Start with a 6 km radius, which contains the 5 km ruggedness audit; retry at 10 km if
   connected water reaches the current edge.
2. Infer the downstream direction from the already traced river path. Search up to 210 m around
   the intake for a plausible channel-floor cell, with a distance penalty and no candidates on
   the downstream side of the proposed axis.
3. Interpret the slider as a **retained water-level rise**, not structural dam height:

   `full-supply elevation = inferred DEM bed elevation + selected retained height`

   Structural freeboard is therefore zero in the screen and must be added by a designer.
4. Trace a line perpendicular to the river direction until terrain first crosses the proposed
   water level on each bank. That finite bank-to-bank segment is inserted as the dam barrier.
   Blocking only crossings of this segment matters: an infinite downstream half-plane would
   wrongly delete water where a winding upstream valley bends back across the axis.
5. Grow through all eight neighbouring cells whose terrain is below the water level and connected
   to the upstream seed. A low but disconnected depression is excluded. If either abutment cannot
   be closed inside the DEM window, a conservative half-plane barrier is used and the result is
   flagged.
6. Integrate the retained cells in metric units:

   `area = Σ cell_area`

   `storage = Σ (water_level − cell_elevation) × cell_area`

   HydroRecon also reports mean/max modelled depth, cell-edge shoreline, projected upstream reach,
   inferred dam-axis span, the terrain source/resolution, and whether the result touches the DEM
   window edge.
7. Repeat the calculation at 0%, 25%, 50%, 75% and 100% of the selected retained level to produce
   a stage–area–storage table. The 100% footprint from the preferred terrain chain is drawn.
8. Repeat the full-level calculation on the second terrain chain and report the pair's area and
   storage spread. This is a source-sensitivity diagnostic, not a statistical confidence interval:
   agreement between global DEMs cannot prove that either matches the ground. If either pool still
   reaches the 10 km window edge, its figures remain minimums and the UI refuses to call them a
   two-DEM span.
9. Calculate ArcHydro/Riley Terrain Ruggedness Index (TRI) in a 5 km circular buffer: each cell's
   TRI is the root mean square elevation difference to its eight neighbours, and the reported
   statistic is the population standard deviation of those TRI values. It warns where 30 m DEM
   volume estimation is especially vulnerable; it is not converted into a site error percentage.

The exact raster mask and inferred axis are drawn on the map and exported to GeoJSON. The selected
height, area, volume, truncation flag and both access gaps also travel in CSV.

## Repository survey and design decision

GitHub is not a finite catalogue that can literally be exhausted. The search covered the principal
maintained implementations and the distinct algorithm families surfaced by broad repository and
code searches; repositories that only store existing dam attributes were not treated as terrain
methods.

| Repository/tool | What it establishes | Decision for HydroRecon |
|---|---|---|
| [GRASS `r.lake`](https://grass.osgeo.org/grass-stable/manuals/r.lake.html) and its [source](https://github.com/OSGeo/grass/blob/main/raster/r.lake/main.c) | A lake at a fixed level is the 3×3/8-neighbour set below that level and connected to a seed; output values are depth. | Adopted as the delineation rule. A dam barrier must be supplied because the natural river outlet is otherwise open. |
| [WhiteboxTools `ImpoundmentSizeIndex`](https://github.com/jblindsay/whitebox-tools/blob/master/whitebox-tools-app/src/tools/hydro_analysis/impoundment_index.rs), [`InsertDams`](https://github.com/jblindsay/whitebox-tools/blob/master/whitebox-tools-app/src/tools/hydro_analysis/insert_dams.rs), and [next-generation docs](https://github.com/jblindsay/whitebox_next_gen/blob/main/crates/wbw_python/docs/tools_hydrology.md) | Inserts candidate dams, evaluates flooded mean/max depth, volume, area and height, and searches across a DEM using a user-specified maximum dam length. | Adopted the explicit dam/abutment idea. The full site-wide index is not used because the app already has a selected intake and the user supplies height rather than maximum crest length. |
| [GeoLibre `storage_capacity`](https://github.com/opengeos/geolibre-rust) | Sweeps stage and applies `Σ cell_area` and `Σ(level−z)×cell_area`; its `fill_spill_merge` solves a different finite-water-volume problem. | Adopted the stage–area–volume sweep. A fixed full-supply level does not need finite-volume spill/merge routing. |
| [Beaver Dam Water Storage / BDSWEA](https://github.com/konradhafen/beaver-dam-water-storage) | Uses an eight-direction flow raster to trace cells draining to a proposed dam (a backwards HAND calculation), then subtracts height above the dam cell from dam height. | Confirms that snapping the dam to a channel and constraining the upstream domain matter. Its D8 catchment restriction was not substituted for level-pool connectivity: a proposed pool can inundate a side depression across a saddle even if the pre-dam D8 direction does not terminate at the dam. |
| [GeoCARET](https://github.com/Reservoir-Research/geocaret) | Delineates planned reservoirs from dam location plus full-supply elevation on a hydrologically conditioned one-arc-second DEM; it distinguishes structural height, freeboard/buffer and FSL. | Adopted the explicit FSL wording. The control is retained water level, so a structural dam height must first be reduced for freeboard and non-retaining crest allowance. GeoCARET's Google Earth Engine/private-asset pipeline is not browser-portable. |
| [CNES `dem4water`](https://github.com/CNES/dem4water) | Builds elevation–surface–volume relationships for existing reservoirs from a post-construction DEM, a water-occurrence map, cutlines and optional manual correction. | Valuable for calibration after a reservoir exists, but it requires evidence that a greenfield site does not have. Not used for proposed pondage. |
| [InfeRes](https://github.com/Critical-Infrastructure-Systems-Lab/InfeRes) | Combines Landsat/Sentinel water occurrence, a 30 m DEM and reference reconstructed bathymetry to infer area, level and storage time series for existing reservoirs. | Strong for monitoring an existing reservoir, but its water history and reference bathymetry do not exist at a greenfield site. |
| [PyFlwDir](https://github.com/Deltares/pyflwdir) | Provides flow directions, basins, upstream tracing, HAND and geomorphic floodplains. | Useful for catchment and event-flood work, but not a substitute for inserting a proposed barrier and filling to a specified level. |
| [DrainageBasinGeomorphology](https://github.com/JoaoVitorPimenta/DrainageBasinGeomorphology) | QGIS tools derive elevation–area–volume curves and inundation within supplied drainage-basin geometry. | Confirms the same raster integration, but HydroRecon must derive the connected impoundment boundary rather than require a basin polygon. |
| Hydraulic flood/dam-break repositories such as [FloodLens](https://github.com/SumedhG10/FloodLens) and [RMC-RFA](https://github.com/USACE-RMC/RMC-RFA) | Route time-varying inflow, breach or stage-frequency scenarios with substantially more inputs. | Correct next tools for flood consequences or operations, but inappropriate for a fast equilibrium level-pool site screen. |

The resulting implementation is independent TypeScript. No external source code was copied.

## Terrain accuracy boundary

The preferred live provider is [Re:Earth Terrain / Mapterhorn](https://github.com/reearth/reearth-terrain),
a fused global DEM product; the comparison chain is the [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
bare-earth composite. Both are now calculated when available. The official
[Copernicus description](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)
states that GLO-30 is a 30 m digital surface model: vegetation and infrastructure can be part of
the surface, despite hydrological editing and water flattening.

A 2025 field study compared one-arc-second SRTM stage–storage curves with centimetre-level RTK
surveys at ten small dams. Curves often had excellent shape agreement (`R² > 0.98`), while absolute
volume error remained large and site-dependent (`MAE 6,906–788,841 m³`). The study identified the
standard deviation of 5 km TRI as the dominant error predictor and reported errors above 150% at
its rugged sites. See [Ahmed et al. (2025)](https://www.nature.com/articles/s41598-025-30483-7).
That result is why HydroRecon exposes a curve, two-source disagreement and TRI rather than fabricating a
single universal “±x%” accuracy. Its Iraqi SRTM calibration is not transferred numerically to Nepal.

Consequences that stay visible in the UI and exports:

- one nominal 30 m cell is 900 m², so a narrow Himalayan channel, road embankment, saddle or
  abutment can be sub-grid; the UI calls out preferred footprints with fewer than 25 complete
  cells as resolution-limited rather than hiding the cell count;
- dam height is referenced to an inferred DEM cell, not a surveyed thalweg or a geotechnically
  acceptable foundation;
- global accuracy statistics do not bound local errors in steep terrain, radar shadow, forest or
  water; a low retained height can be the same order as local vertical error, and two DEMs may
  share source data or biases;
- there is no pre-impoundment bathymetry, sediment volume, freeboard, drawdown, tailwater,
  backwater hydraulics, spillway, stability, seismic, land/asset inventory or environmental and
  social clearance;
- an edge-touching footprint is exported as a minimum, not silently presented as complete.

The correct next-stage check is a surveyed or high-resolution bare-earth DTM tied to control,
surveyed thalweg and candidate abutments, a stage–area–storage curve over plausible operating
levels, and hydraulic/geotechnical/environmental review.

## Motor-road method

For the intake and powerhouse separately, HydroRecon calls the [OSRM nearest
service](https://github.com/Project-OSRM/osrm-backend/blob/master/docs/http.md#nearest-service)
with a driving profile and a 20 km search radius. OSRM snaps the point to its car-routing graph and
returns the snapped coordinate, straight gap, road name when available, and OSM node identifiers.
The app tries the OpenStreetMap.de car router first and the public OSRM demo as a fallback, caches
successful requests, draws the two gaps, and links each result to OpenStreetMap.

This is more defensible than accepting every `highway=*` feature. The [OSM highway
documentation](https://wiki.openstreetmap.org/wiki/Key:highway) explains that the key includes
roads, streets and paths and primarily describes function/importance, not physical quality.
However, a car-routing graph still cannot prove road width, pavement, bridge rating, landslide or
monsoon condition, construction status, ownership or legal access.

The displayed distance is therefore a **straight-line lower bound to an existing mapped routable
road**, not the length or cost of a buildable access-road alignment. A later access-corridor module
could combine the snap point with slope, river crossings, protected/settlement constraints and a
terrain cost surface, but that would be a new engineering model rather than an OSM distance.

## Checks

`checks/pondage.check.ts` uses synthetic terrain to prove that:

- area and volume equal the expected cell sums;
- the inserted dam blocks the low downstream outlet;
- a disconnected low pocket remains dry;
- a winding connected upstream arm is retained outside the finite dam segment;
- a footprint reaching the terrain-window edge is flagged; and
- the raster mask is compacted into valid map geometry;
- the stage–area–storage curve is monotonic and terminates at the selected result; and
- ArcHydro/Riley TRI variability is zero on flat terrain and positive on relief.

The normal typecheck, full assertion suite and production build cover the UI and export wiring.
