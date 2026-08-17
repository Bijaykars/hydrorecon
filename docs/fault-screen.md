# Regional active-fault screen

Ghatta's Nepal mode compares the selected intake-powerhouse river reach with a
pinned Nepal-plus-buffer extract of the [GEM Global Active Faults
Database](https://github.com/GEMScienceTools/gem-global-active-faults). It answers
one narrow investigation question:

> Which published regional active-fault traces are near this mapped river reach,
> and does either mapped polyline intersect the other?

It does not calculate seismic hazard or clear a project site.

## Source and lineage

The bundled snapshot is built from GEM commit
`56816508ad92fd6846dad1163b1c8c01376a2cd1`. GEM describes the database as a
global compilation of active-fault traces of seismogenic concern. The 59 source
structures intersecting Ghatta's 79.5-89 E, 25.5-31 N window come from the
HimaTibetMap constituent catalogue. Four fold axes (`Syncline` and `Anticline`)
are excluded, leaving 55 active-fault source traces.

The scientific citation is Styron and Pagani (2020), [The GEM Global Active
Faults Database](https://journals.sagepub.com/doi/10.1177/8755293020944182),
*Earthquake Spectra*. The regional source lineage is described by Styron et al.
(2010), [HimaTibetMap-1.0: New 'web-2.0' online database of active structures
from the Indo-Asian collision](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2010EO200001).

The derivative `src/data/nepal-faults.json` is **CC BY-SA 4.0**, following the
[GEM source licence](https://github.com/GEMScienceTools/gem-global-active-faults/blob/master/LICENSE.txt).
That data licence is separate from Ghatta code's MIT licence. Attribution,
licence URL, source commit, retrieval date and SHA-256 of the full upstream file
are embedded in the bundle and carried into exports.

## Reproducible build

```sh
npm run build:faults
```

`pipeline/build-nepal-faults.mjs` downloads the immutable commit, verifies a
minimum global feature count, clips every segment to the declared window with
Liang-Barsky line clipping, rejects fold axes, checks the exact pinned counts,
requires the Main Frontal Thrust to remain present, validates every coordinate,
and atomically replaces the bundle only after all checks pass.

Slip-rate values are intentionally not interpreted or displayed. The current
consolidated source does not state their units beside the compact field, so
Ghatta does not guess.

## Geometry and distance

GeoJSON storage is EPSG:4326 in explicit `[longitude, latitude]` order. Analysis
does not use Web Mercator. For each selected reach, Ghatta creates a local
equirectangular metric frame centred on the reach and checks every river segment
against every nearby fault segment. It detects ordinary and collinear
intersections, otherwise returns the shortest segment-to-segment distance. The
nearest reach point and chainage are retained.

The default 50 km radius is an investigation-context window, not a setback. The
nearest trace is still reported when it lies outside 50 km, while only traces
inside the window are drawn and exported.

## Interpretation rules

- “Intersects” means the generalized GEM line intersects the selected mapped
  river centreline. It does **not** mean a surveyed fault crosses a final canal,
  tunnel, penstock or foundation.
- Proximity is not PGA, spectral acceleration, magnitude, recurrence, return
  period, fault displacement or a seismic design action.
- Non-intersection and distance are not geological clearance. Catalogue and map
  scale, location uncertainty, blind structures and unmapped local faults remain.
- A mapped intersection focuses structural mapping and investigation; it does
  not automatically stop a scheme. A stop requires project evidence and
  engineering/legal judgment beyond this regional screen.
- The river-following line currently displayed by Ghatta is not a routed
  waterway. Site survey, engineering-geology mapping, remote-sensing
  interpretation, trenches/borings where justified, rock-mass and permeability
  investigation, and a code-compliant probabilistic/deterministic seismic basis
  remain required.

The app, readiness gate, field-plan CSV, main CSV and GeoJSON repeat these
limitations so the result cannot become stronger merely by leaving the UI.
