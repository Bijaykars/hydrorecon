# Engineering readiness and field-investigation method

HydroRecon is a site-screening workbench. Its new readiness layer answers a different question from
“how many megawatts?”:

> What evidence do we actually have, what can stop this layout, and what must the engineering team
> do next?

It does **not** produce an overall percentage. Hydropower risks are not interchangeable: strong
hydrology does not compensate for an occupied water right, an impossible headworks site, unknown
geology or a protected-area prohibition. Each discipline keeps its own evidence gate.

## Evidence levels

| Level | Meaning |
|---|---|
| `not-assessed` | The app has no defensible project evidence for this discipline. Silence must not read as “clear.” |
| `weak` | Evidence exists but is conflicting, incomplete or too indirect for the current decision. |
| `screened` | Open data supports comparison of alternatives; field confirmation is still required. |
| `corroborated` | Two meaningfully independent sources agree within the stated screen. This is stronger screening, not a measurement. |
| `measured` | A user-supplied measurement drives that gate. Measurement error, transfer and representativeness still apply. |
| `stop` | The current layout has a potential fatal conflict. Stop means “hold or relocate this layout and resolve the issue,” not a final legal judgment. |

The overall banner has only three outcomes:

- **Hold** when at least one gate is `stop`.
- **Fieldwork** while essential disciplines remain unassessed.
- **Screening** only when no stop or unassessed gate remains. This still never means design-ready,
  permitted or bankable.

## The eight gates

1. **Water and energy yield** — record length, whether discharge is measured or modelled, agreement
   between sources, HYDEST corroboration in Nepal, and the need for floods, droughts, environmental
   flows and climate sensitivity. Daily P90/P95 hydrological output is retained separately from P90
   annual energy, but cannot become firm capacity without unit commitment, outages, station service,
   curtailment and contract definitions.
2. **Head and layout** — DEM head, independent terrain audit, control levels, cross-sections and the
   explicit fact that the displayed waterway is not a routed canal, tunnel or penstock.
3. **Sediment and headworks** — catchment source proxy, screening desander size, terrain bench fit,
   sediment sampling, debris/flood behaviour, intake exclusion and flushing.
4. **Geology and natural hazards** — official DMG 1:50,000 publication availability, three
   small-scale Macrostrat unit samples, BIPAD historical incident proximity and GEM regional
   active-fault distance/intersection make this a `weak` screen in Nepal, never a probability,
   site lithology/contact, surveyed crossing, seismic design action or clearance. Field mapping,
   rock mass, permeability, seismic basis,
   landslide/debris source and runout, upstream GLOF routing and cascade interaction can still overturn
   the concept.
5. **Equipment, transients and operations** — the screened turbine family and daily part-load
   dispatch are retained, while unit selection, cavitation, surge/water hammer, speed rise, generator,
   transformer, controls, auxiliaries, access, spares and maintainability remain open. The headline
   daily power-duration screen assumes one unit; an equal-rated one-to-four-unit sensitivity exposes
   low-flow effects without equipment cost, outage credit or a recommendation. Final unit ratings
   and contractual availability remain explicit field/design work. Directed
   upstream/downstream DoED candidates add release, spill, flushing, outage, emergency-warning and
   transient-boundary interfaces without claiming a confirmed cascade.
6. **Grid evacuation** — in Nepal only, the nearest mapped line and a capacity-based screening
   voltage. The distance is explicitly straight-line and OpenStreetMap does not establish available
   capacity. Outside Nepal the gate is `not-assessed`.
7. **Legal, environmental and social** — in Nepal only, conservative DoED coordinate-range conflicts
   and protected-area intersection/near-edge screens. Land, forest, communities, aquatic ecology,
   cultural heritage and basin-wide cumulative impacts always require project work. The desktop
   release cannot fall below the Hydropower Development Policy floor of 10% of minimum monthly
   average discharge, while the higher approved-EIA minimum governs; neither value is ecological
   clearance. The work package requires a seasonal ecological/hydraulic basis, downstream-use and
   drought/ramping rules, physical release works, and a monitoring/compliance plan.
8. **Cost, schedule and bankability** — intentionally unassessed until survey quantities,
   construction methods, geology, access, grid, safeguards and a dated local price basis exist.
   In Nepal, the published NEA wet/dry base-rate energy comparator can focus PPA due diligence,
   but it never advances this gate: signed terms, eligibility, COD/escalation year, contracted
   energy, curtailment/loss/penalty allocation and a complete cost/finance model are still required.

## Nepal-first scoping

`src/region.ts` uses the Natural Earth 1:50m Nepal polygon. It enables Nepal-specific evidence only
for points inside that outline:

- all nine official Department of Electricity Development hydro registers;
- DHM station metadata and transfer candidates;
- HYDEST regional hydrology checks;
- Nepal transmission and protected-area extracts;
- approved and verified Government of Nepal BIPAD incident history;
- pinned GEM/HimaTibetMap regional active-fault context under CC BY-SA 4.0;
- official DMG published-map catalog metadata and derived sheet footprints, without map imagery;
- NEA run-of-river seasonal energy tests.

Outside Nepal, those layers are disabled rather than shown as empty. Global mode uses only the
easily available open physical inputs that already have reproducible access: terrain, GloFAS flow,
river data where covered, the basemap and small-scale CC BY 4.0 Macrostrat point samples. A future
country pack should add explicit boundary,
source, date, licence and integrity tests before it can make national claims.

## Field-plan generation

The selected scheme produces a prioritized register with discipline, work package, reason and
required deliverable. Triggers change the plan:

- no imported record makes hydrology P1 and names the strongest trustworthy DHM discharge station
  when one exists;
- a large two-DEM head disagreement strengthens the survey reason;
- a failed desander bench makes intake relocation P1 and stops the current layout;
- an inadequate or remote Nepal line makes grid work P1;
- an operating/construction DoED conflict or hard protected-area intersection stops the layout and
  makes resolution P1;
- an upstream operating/construction DoED network candidate weakens an unregulated flow case and
  requires naturalized plus coordinated/independent-operation hydrographs; any advanced upstream or
  downstream candidate makes operating, transient, emergency and cumulative-impact interfaces P1,
  but a midpoint candidate never creates a legal stop;
- nearby BIPAD reports are named in the geology/hazard reason, while zero reports still require the
  same P1 walkover because report absence is not hazard absence;
- a GEM regional trace intersecting the mapped river reach names the trace and chainage and requires
  surveyed structural mapping before routing underground/foundation works, but never creates an
  automatic stop or pretends that the river line is a project waterway;
- a matching official DMG footprint names the exact 1:50,000 publication to obtain before field
  mapping, while a catalog no-match explicitly requires direct DMG confirmation and never says
  "no geology";
- a non-standard turbine duty makes specialist electro-mechanical review P1.

The UI shows the plan and the third download button exports it as CSV. The main CSV provenance and
GeoJSON `hydrorecon_readiness` member carry the same gates so the engineering state survives outside the
app.

The direct DoED reach screen and the directed upstream/downstream screen are intentionally separate;
see [the project-interaction method](cascade-projects.md).

## Basis and references

The discipline coverage follows the Government of Nepal Department of Electricity Development
[Guidelines for Study of Hydropower Projects, 2018](https://doed.gov.np/content/35/guidelines-for-study-of-hydropower-projects--2018/)
and the World Bank/IFC [Hydroelectric Power: A Guide for Developers and Investors](https://ppp.worldbank.org/library/hydroelectric-power-guide-developers-and-investors).
The latter's pre-feasibility contents explicitly cover topography, hydrology and sediment, geology,
seismic hazards, environmental and social assessment, layout alternatives, energy, civil and
electro-mechanical design, grid, costs, permitting, schedule, finance and risk.

The sediment, debris, ice and outburst-flood work package also follows DoED's
[Design Guidelines for Headworks of Hydropower Projects](https://doed.gov.np/content/31/design-guidelines-for-headworks-of-hydropower-projects/),
which treats flood passage, GLOF/CLOF and landslide-dam events, monsoon debris, bed load,
suspended-sediment exclusion and flushing as explicit headworks duties.

Grid investigation must proceed under the Electricity Regulatory Commission's published
[Nepal Electricity Grid Code, 2080](https://www.erc.gov.np/grid-code), not the app's screening
voltage rule. Environmental-flow scope is informed by IFC's
[Good Practice Handbook on Environmental Flows for Hydropower Projects](https://www.ifc.org/en/insights-reports/2018/publications-handbook-eflows),
and basin-level effects by IFC's
[Cumulative Impact Assessment resources](https://www.ifc.org/en/insights-reports/2019/cumulative-impact-assessment-resource-page),
including the Trishuli basin work in Nepal.

These references define what must be investigated. They do not turn open-data evidence into a
feasibility study or replace current Nepal law, regulator decisions, utility studies or professional
engineering judgment.
