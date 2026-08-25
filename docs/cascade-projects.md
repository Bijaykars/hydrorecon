# Directed DoED project-interaction screening

Hydropower engineers need two different answers from the Department of Electricity Development
(DoED) register:

1. Does an official project coordinate range lie on or close to the selected intake–powerhouse
   reach?
2. Which other registered projects may sit upstream or downstream on the directed river network
   and therefore deserve hydraulic, operating, emergency-response or cumulative-impact review?

HydroRecon keeps these questions separate. A nearby coordinate range can be a direct legal/layout
constraint. A network relationship inferred from a published midpoint is only a discovery lead.

## Direct reach screen

The direct screen measures the selected scheme reach—not the unused remainder of the 22 km search
window—against every DoED-published south/west/north/east coordinate range. A record is retained
when its range is within 6 km of the selected mapped reach.

Operating and construction-licence records in this direct screen hold the current layout. Survey
records and applications weaken the legal gate and require a current file/geometry check. DoED
publishes coordinate ranges rather than intake, dam, powerhouse, tailrace or licensed alignment
geometry, so even a direct result remains a conservative screen rather than a final legal finding.

## Upstream and downstream candidate method

The directed screen starts from the 1,169 geolocated records in the bundled nine-table DoED
snapshot. It:

1. deduplicates lifecycle rows by normalized project name and capacity, retaining the most advanced
   stage and then the newest issue date (1,167 canonical records; two duplicate lifecycle rows in
   the current snapshot);
2. removes records already reported by the direct selected-reach screen;
3. uses the midpoint of each remaining published coordinate range only as a guarded network probe;
4. requires that midpoint to snap within 2 km of a stored HydroRIVERS vertex;
5. classifies it as `upstream` only when a downstream walk of at most 200 km reaches the selected
   intake;
6. classifies it as `downstream` only when a downstream walk of at most 200 km from the selected
   powerhouse reaches the project probe; and
7. omits a contradictory downstream relation if coarse snapping appears to classify the same
   project in both directions.

Coordinates are stored in WGS 84 (`EPSG:4326`). Snap and route lengths use great-circle segment
distances; Web Mercator is not used for engineering distance. HydroRIVERS v1.0 is approximately
15 arc-seconds (about 500 m) and omits streams below its stated mapping threshold. The UI and
GeoJSON keep every candidate point and metric, but retain at most 30 overlapping route geometries
so a dense basin remains usable.

## Engineering consequence

An upstream operating/construction candidate makes an unregulated desktop discharge series weak:
generation, abstraction, spill and flushing can alter the flow arriving at the scheme. It adds a P1
requirement for naturalized and coordinated/independent-operation flow cases.

An upstream or downstream operating/construction candidate weakens the equipment/operations gate
and opens release, spill, flushing, outage, emergency-warning and transient-boundary interfaces.
Any candidate weakens the legal/environmental gate until current components and cumulative/cascade
scope are checked. Candidate relations never create an automatic stop.

CSV and GeoJSON exports retain direction, route distance, midpoint snap, published-range diagonal,
stage, source dates, thresholds and the non-claim. GeoJSON contains both midpoint points and the
retained generalized HydroRIVERS routes under `hydrorecon_cascade` provenance.

## What it does not establish

A midpoint can snap to the wrong branch, particularly when DoED's published range is wide. A
directed centreline relationship does not establish:

- the actual intake, dam, powerhouse, tailrace or waterway location;
- a common water source, intervening tributary contribution or consumptive abstraction;
- current licence status, legal overlap or water allocation;
- coordinated cascade operation or contractual dispatch;
- release, spill, flushing, outage or warning rules;
- backwater, tailwater, surge or water-hammer boundary conditions;
- sediment continuity, cumulative environmental effects or available grid capacity.

Zero candidates means only that no published midpoint passed the declared snap and route
thresholds. It is never cascade clearance.

## Required confirmation

Before feasibility decisions, obtain current DoED licence files and maps; survey component
chainages; confirm ownership and commissioning status with the promoters; obtain abstraction,
generation, spill, flushing and outage time series; establish synchronized and independent
hydrographs; agree warning and emergency protocols; and scope cumulative hydrology, sediment,
aquatic ecology and social effects with the relevant authorities and projects.

The method is guided by DoED's current
[Guidelines for Study of Hydropower Projects, 2018](https://doed.gov.np/content/35/guidelines-for-study-of-hydropower-projects--2018/)
and [Guideline for Power System Optimization of Hydropower](https://doed.gov.np/content/32/guideline-for-power-system-optimization-of-hydropower/).
The engineering need is also visible in Nepal Electricity Authority's
[Generation Directorate 2021/22 report](https://www.nea.org.np/admin/assets/uploads/annual_publications/Generation_2021-22.pdf),
which describes Kulekhani III as a cascade using regulated Kulekhani II tailrace flow plus natural
tributary flow. That documented example supports the need for interface analysis; it is not used to
calibrate or validate HydroRecon's midpoint classifier.

`checks/cascade.check.ts` protects lifecycle deduplication, official bundle counts, separation of
direct/upstream/downstream records, direction labels, snap/route thresholds, geometry caps and
non-claims. Readiness and export checks protect the downstream engineering behaviour.
