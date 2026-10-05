/**
 * The half of the DHM index that may be published, split from the half that may not.
 *
 * WHY THIS EXISTS. `src/data/dhm-records.json` carries derived statistics for
 * 136 gauges — annual mean, twelve monthly means, seven flow-duration
 * quantiles, min, max. The daily yearbooks behind them were supplied privately
 * and DHM sells hydrological data through a procurement process with no open
 * licence, so those statistics are not redistributable (LICENSES.md, blocker
 * 1). Station IDENTITY is a different matter: it is published openly at
 * `hydrology.gov.np/gss/api/station`, which is where `dhm-stations.json`
 * already comes from.
 *
 * So the file splits along that line. The full index stays on the licence
 * holder's disk and is gitignored; this writes the identity-only twin that
 * ships, and `restore-dhm-records.mjs` puts it at the canonical path when the
 * full one is absent.
 *
 * WHY `meanCms` IS null RATHER THAN OMITTED, and this is load-bearing.
 * `src/dhm.ts` refuses any donor gauge whose measured flow per km² of mapped
 * catchment falls outside 0.005–0.25 m³/s — a mis-snapped gauge whose area
 * ratio would be nonsense. `null / area` is 0 in JavaScript, which is below
 * that floor, so every candidate is refused and `bestTransfer` returns null:
 * the gauge-transfer path is UNAVAILABLE rather than running on absent
 * statistics. Omitting the key instead would give `undefined / area = NaN`,
 * both comparisons would be false, and the screen would pass a donor it knows
 * nothing about. The engine modules are deliberately untouched by this split —
 * they are covered by the engine signature, and a packaging change must not
 * move it — so the refusal has to come from the data.
 *
 * Nothing else reads the dropped fields on this path: `dhmStationsGeoJson` is
 * unexported-in-practice, the report's gauge section is built from
 * `dhm-stations.json`, and `src/dhm-statistics.ts` tells the app and the report
 * to say the statistics are not bundled rather than to print a hole.
 */
import { writeFileSync } from 'node:fs';

/** The full index, on the licence holder's disk only. Gitignored. */
export const FULL_INDEX = 'src/data/dhm-records.json';
/** The identity-only twin, tracked and published. */
export const PUBLIC_INDEX = 'src/data/dhm-records.public.json';

/** Station identity: every field that is not a discharge measurement. */
const identityOf = (s) => ({
  id: s.id,
  river: s.river ?? '',
  location: s.location ?? '',
  lat: s.lat ?? null,
  lon: s.lon ?? null,
  from: s.from,
  to: s.to,
  years: s.years,
  completeYears: s.completeYears,
  days: s.days,
  // Present and null, not absent. See the note above — this is what makes the
  // transfer screen refuse a donor instead of trusting one.
  meanCms: null,
});

/**
 * Reduce a full index bundle to the publishable one.
 *
 * `_statistics` is the flag the app reads: a build carrying the real statistics
 * has no such key, so the full index needs no edit and its bytes — and the
 * numbers derived from them — are untouched by this split.
 */
export function publicIndex(bundle) {
  return {
    _source: bundle._source,
    _note:
      'STATION IDENTITY ONLY. The derived discharge statistics — annual mean, monthly means, ' +
      'flow-duration quantiles, min and max — are built from daily yearbooks supplied privately ' +
      'by DHM under no redistributable licence, and are not in this file. meanCms is null for ' +
      'every station so that src/dhm.ts refuses to transfer a record it does not hold. A licence ' +
      'holder rebuilds the full index with pipeline/build-dhm-records.mjs (from the yearbooks) or ' +
      'pipeline/build-dhm-index.mjs (from sources/dhm/).',
    _statistics: 'not-bundled',
    _built: bundle._built,
    _units: bundle._units,
    stations: bundle.stations.map(identityOf),
  };
}

/** Write it beside the full index, and say what was dropped. */
export function writePublicIndex(bundle) {
  const out = publicIndex(bundle);
  writeFileSync(PUBLIC_INDEX, JSON.stringify(out));
  console.log(
    `wrote ${PUBLIC_INDEX}: ${out.stations.length} stations, identity only, ` +
      `${(JSON.stringify(out).length / 1024).toFixed(0)} KB`
  );
  return out;
}
