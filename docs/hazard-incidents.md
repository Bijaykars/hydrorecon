# Nepal BIPAD recorded-incident screen

HydroRecon uses the Government of Nepal [BIPAD incident API](https://bipadportal.gov.np/api/)
to answer one narrow, useful question:

> Which approved, verified natural-hazard reports are mapped close enough to this proposed layout
> that the field team should inspect them?

It does not calculate susceptibility, frequency, return period, magnitude, runout, design seismic
action or project risk.

## Current snapshot

The bundled file was retrieved on 2026-08-13 and covers 2011-05-14 through 2026-08-12:

| Category | Approved + verified records |
|---|---:|
| Landslide | 5,771 |
| Flood | 2,952 |
| Earthquake | 336 |
| Avalanche | 43 |
| Glacial lake outburst | 0 |
| Inundation | 0 |
| **Total** | **9,102** |

Zero in the last two rows describes this API snapshot; it is not evidence that Nepal has no GLOF
or inundation hazard.

## Spatial method

The selected river reach from intake to powerhouse is buffered conceptually by 15 km. Each BIPAD
point is measured to the nearest reach segment in a local metric frame, not Web Mercator. Fifteen
kilometres is deliberately broad because many public incident locations are administrative or
geocoded points rather than surveyed landslide scars or flood limits.

The result is an investigation inventory:

- every matching point remains a report with its BIPAD incident ID and date;
- repeated locations/dates are not silently merged into invented “events”;
- the closest records are listed and every matching point appears on the map and in GeoJSON;
- the readiness gate remains `weak`, even when no report is found;
- incident history alone never triggers a stop decision.

For floods and GLOFs, Euclidean proximity is particularly incomplete. A distant upstream source can
matter while a nearby point in another catchment does not. HydroRecon therefore also runs a conservative
directed HydroRIVERS candidate screen for relevant report points and open glacial-lake centroids.
That added topology does not prove that the report is the source, that material entered the channel,
or that an outburst/flood wave reaches the project. See [the upstream connectivity method](upstream-connectivity.md).

## Reproducibility, privacy and failure behavior

Run `npm run build:hazards`. The builder:

1. tries the production BIPAD host, then its official development mirror;
2. validates all six hazard IDs against official names;
3. requests records in descending incident-date order and paginates without trusting the API's
   invalid `count` value;
4. keeps only records whose `approved` and `verified` flags are true;
5. validates dates, unique IDs, Point geometry and a broad Nepal coordinate extent;
6. writes atomically only after minimum coverage and schema checks pass.

The output allow-list contains only incident ID, category, date, latitude and longitude. Upstream
descriptions, street addresses, loss details and creator/user fields are excluded. The bundle records
the canonical source, actual fetch host, retrieval date, period and EPSG:4326 coordinate lineage.

BIPAD exposes the data through a public government API, but an explicit dataset licence was not found.
Attribute BIPAD/NDRRMA and verify current reuse terms. The repository's MIT licence does not cover the
bundled incident data.

## Interpretation limits

- Reporting effort and approval practices vary by year, place and hazard.
- A report point may be a ward/municipality location rather than the physical source or impact extent.
- Multiple reports at one point/date may be distinct impacts, duplicates or administrative entries.
- The inventory is not a complete earthquake catalogue or landslide inventory.
- Counts are neither independent events nor denominators for probability.
- No-report is not no-hazard.

The screen should lead directly to engineering-geology mapping, local incident verification,
landslide/debris source and runout mapping, seismic basis work, and catchment-connected flood/GLOF
assessment.
