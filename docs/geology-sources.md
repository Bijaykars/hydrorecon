# Engineering-geology source screen

Ghatta now answers two narrow desk-study questions before an engineer goes to the field:

1. Which official Nepal Department of Mines and Geology (DMG) 1:50,000 map publications have
   catalog footprints touching the selected river reach?
2. What small-scale open regional geological unit does Macrostrat return at the intake, reach
   midpoint and powerhouse?

Neither answer is an engineering-geology model. The gate stays `weak`; no map match, unit name or
fault distance can clear a foundation, tunnel, canal, penstock, powerhouse or hazard catchment.

## Official DMG publication index

The builder reads the current Government of Nepal [1:50,000 geological-map catalog](https://dmgnepal.gov.np/en/resources/geological-maps-150000-4749).
The snapshot contains the 41 rows currently exposed by that catalog page, their titles, dates and
official preview links. DMG describes the images as low-resolution publication information, says
usable-quality maps are available as hard-copy purchase products, and says digital versions cannot
currently be purchased. The same page is marked "All Rights Reserved."

For that reason, Ghatta bundles only factual catalog metadata and derived sheet footprints. It does
not copy, tile, trace geological contacts from, or redistribute the preview images. A matching
result is a named product for the engineer to obtain under DMG's current terms.

The wider DMG [Geological Mapping Section](https://dmgnepal.gov.np/en/divisions/geological-mapping-section-6959)
also lists regional and national products and notes that substantial Higher Himalayan areas remain
geologically unmapped or unexplored by DMG. Therefore:

- a catalog match means a listed publication footprint touches the mapped river centreline;
- a no-match means only that this online 1:50,000 catalog returned no footprint;
- neither statement describes the rock at the site or the complete universe of previous studies.

## Footprint derivation and coordinate handling

DMG titles publish either the Nepal Survey Department grid (`2785 02`, `2884 15`, including A-D
quarter sheets and lower halves) or legacy Survey of India codes (`62 P/15`, `72 E/2`). Ghatta
derives the rectangular footprint from those identifiers. The modern layout is checked against the
official Survey Department [topographic sheet index](https://www.dos.gov.np/download/download/nepalese-journal-on-geoinformatics-vol-3/downloads);
legacy codes are checked against the official Survey of India indexing system and DMG's own map
district/title and modern-code cross-references.

Regression tests pin known locations for Kathmandu/Nuwakot, Gorkha/Lamjung, Kaski/Parbat,
Palpa/Gulmi and Tanahun/Kaski. This matters: a transposed million-sheet base can place a valid old
publication hundreds of kilometres from its district while still producing syntactically valid
coordinates.

The snapshot stores footprints as EPSG:4326 bounds in explicit `[west, south, east, north]` order.
Reach/rectangle matching is topological and includes a reach on a sheet edge; it performs no metric
distance calculation in geographic coordinates. Existing distance analyses elsewhere in Ghatta use
local metric frames, not Web Mercator.

Refresh with:

```sh
npm run build:geology
```

The builder validates the official availability wording, exact 41-row sequence, HTTPS host, unique
links, sheet codes, current page update date and a known 2022 publication before atomically replacing
the snapshot. `checks/geology.check.ts` then validates coordinates and intersection behaviour.

## Macrostrat regional samples

Ghatta calls Macrostrat's keyless geologic-map API at only three named points: intake, midpoint and
powerhouse. It preserves the returned map/source IDs, unit name, lithology, age fields, licence and
original source reference. Macrostrat provides its data under CC BY 4.0 and requires attribution to
Macrostrat plus the original source returned by the API.

The app deliberately does not draw the generalized source polygons. In Nepal the currently returned
source can be a small-scale world geology compilation. A polygon fill could look like a project-scale
contact even when its source cannot resolve one. Point samples remain useful for planning the desk
study while making the scale mismatch visible.

The result cannot establish:

- site lithology, weathering grade or overburden depth;
- a geological contact, shear/fault location or displacement;
- discontinuity orientation, rock-mass class, permeability or groundwater;
- foundation bearing, abutment stability, tunnel support, portal or spoil conditions;
- landslide susceptibility, source/runout connectivity, seismic action or design parameters.

## Landslide susceptibility link

Nepal's Water Resources Research and Development Center publishes an official
[rainfall-induced landslide susceptibility app](https://wrerc.gov.np/content/39/rainfall-induced-landslide-susceptibility-map-of-nepal/).
Ghatta links it as a separate evidence source but does not import its raster/classes because an
explicit reusable data licence and supported export were not identified. Engineers should inspect
it together with inventory, terrain connectivity, rainfall, river erosion, roads, geology, faults and
field evidence; susceptibility is not runout, frequency, magnitude or design action.

## Export meaning

GeoJSON contains:

- polygon features named `DMG published 1:50,000 geology sheet footprint`, with title, sheet code,
  date, official preview, rights and the catalog-footprint limitation;
- point features named `Macrostrat regional geology sample`, with role, unit, original reference,
  CC BY 4.0 licence and the small-scale non-claim.

These features are evidence-register geometry, not design geology. The CSV, field plan and readiness
gate repeat the acquisition and field-mapping work so the distinction survives outside the app.
