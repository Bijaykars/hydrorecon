# Upstream glacial-lake and incident connectivity

Ghatta now asks a catchment question that a 15 km proximity buffer cannot answer:

> Can a mapped glacial-lake centroid or a BIPAD report point be snapped close to a mapped channel whose directed HydroRIVERS topology reaches the selected intake?

This is a triage screen for the engineering team. It is not a landslide-susceptibility map, lake-danger ranking, GLOF/debris-flow model, flood envelope or design action.

## Open glacial-lake inventory

The bundled `nepal-glacial-lakes.json` is built from the Sentinel-2 centroid layer in Rawlins et al.'s [Glacial Lake Observatory dataset](https://doi.org/10.5281/zenodo.17802334). It contains 4,152 unique lake centroids in Nepal and the transboundary parts of China and India within the Koshi, Gandaki and Karnali basins:

| Basin | Centroids |
|---|---:|
| Koshi | 2,308 |
| Gandaki | 613 |
| Karnali | 1,231 |

The observations span 2017–2024 and use Sentinel-2. The upstream dataset reports validation F1 of 0.92 for 2020 and about 0.91 for 2017 and 2024. Centroids are EPSG:4326; lake polygon areas were calculated upstream in an equal-area CRS. The dataset is CC BY 4.0.

Ghatta retains the source identifier, country, basin, glacier-fed classification, mean lake elevation, published expansion rate and uncertainty, expansion-significance flag, time-series-outlier flag, and centroid. It does not create a danger score. Significant positive lake expansion is an investigation trigger, not breach likelihood.

Rebuild with:

```sh
npm run build:glacial-lakes
```

The builder checks Zenodo's open-access and CC BY 4.0 metadata, pins the exact source file, verifies its MD5 checksum, reads the GeoPackage as EPSG:4326, applies an 11-field allow-list, validates counts/classifications/bounds, and replaces the compact JSON atomically.

## Directed network method

HydroRIVERS v1.0 is a 15 arc-second (about 500 m) global river network. Its topology supports upstream/downstream connectivity, but it includes only streams with at least 10 km² upstream area or 0.1 m³/s long-term mean discharge. The technical documentation explicitly warns that smaller streams become spatially unreliable at that scale.

Ghatta uses the direction already encoded in the bundled Nepal HydroRIVERS geometry:

1. Snap the intake to a stored river-network vertex. The intake must meet the same 0.8 km network-snap guard used by the study.
2. Snap lake centroids within 1.0 km and BIPAD point reports within 1.5 km to a stored vertex. Distance uses a local metric frame; EPSG:3857 is not used for analysis.
3. Walk downstream through exact shared reach vertices, selecting the larger-upstream-area successor at a confluence.
4. Keep a lake if the walk reaches the intake within 300 km; keep a historical report within 150 km.
5. Calculate route length with great-circle segment distances. Preserve every candidate point and metric. Retain at most 40 prioritized route geometries because lower-basin candidates often overlap almost completely.

The app, readiness gate, main CSV provenance and GeoJSON repeat the thresholds, sources, CRS and limitations. The GeoJSON contains candidate points and the retained generalized routes.

## Why the result is still weak evidence

- A centroid is not the lake outlet. Snapping it to the nearest coarse network vertex can cross a local divide.
- A BIPAD point may identify a ward/municipality or impact location, not the physical scar, temporary dam or flood source.
- A channel path does not prove landslide material entered the river.
- HydroRIVERS omits smaller channels and may contain scale-related topology errors.
- The route contains no terrain barrier, lake/dam geometry, breach volume, entrainment, attenuation, cascade-plant operation or floodplain hydraulics.
- No connected candidate means none passed this inventory/network/threshold combination. It never means no GLOF, landslide-dam, debris or flood hazard.

The required next work is to inspect recent imagery; confirm the lake outlet, scar/source and channel entry against a suitable DEM and field evidence; use ICIMOD's [potentially dangerous glacial lakes](https://rds.icimod.org/metadata/799aab42-e816-4e7d-87bb-8b2147eb6a1a) and [GLOF event database](https://rds.icimod.org/metadata/8881454b-6f7c-461b-95c2-eaf7618230d9); establish breach/debris scenarios; route hydrographs through the river and cascade; and set the headworks design basis under Nepal's DoED guidance.

For sites within its published extent, the UI also links ICIMOD's open [2026 Koshi landslide inventory](https://rds.icimod.org/metadata/af73da0a-885b-459d-95ba-2ea0662a7e7c). Geometry is not bundled because its repository download currently requires an authenticated session.

## Source and licence boundary

- Ghatta code remains MIT.
- The GLO-derived compact data bundle remains CC BY 4.0 and retains its citation/licence in the file and exports.
- The BIPAD public-API bundle has no explicit dataset licence identified; attribute BIPAD/NDRRMA and verify reuse terms.
- HydroRIVERS is used under the HydroSHEDS licence; cite Lehner and Grill (2013) and follow its attribution requirements.
