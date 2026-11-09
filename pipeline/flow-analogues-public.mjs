/**
 * The half of the analogue table that may be published, split from the half that may not.
 *
 * WHY THIS EXISTS. `src/data/flow-analogues.json` is built by
 * `checks/analogue-flow.probe.mjs --build` from `dhm-records.json`, and each
 * donor row carries `truth`: that gauge's measured mean flow. Those means are
 * DHM statistics under no redistributable licence (LICENSES.md, blocker 1), so
 * the full table is gitignored — and `src/HydrologyComparison.tsx` imports it
 * statically, so a fresh clone could not build.
 *
 * THE SPLIT FOLLOWS `dhm-public-index.mjs`. Everything but `truth` stays:
 * station identity and period (`id`, `river`, `lat`, `lon`, `from`, `to`,
 * `years`) are published openly with the station list, and `area`, `rain`,
 * `elevation`, `low`, `high` are read off the bundled river network
 * (`nearestReach` -> HydroRIVERS/MERIT area, CHPclim rain, HydroBASINS
 * hypsometry), not off any gauge record. `scores` is dropped too: the app never
 * reads it, and it is an error statistic computed against `truth`.
 *
 * WHY `truth` IS null RATHER THAN OMITTED. `analogueFlow` keeps a donor only if
 * `s.truth > 0 && Number.isFinite(s.truth)`; `null > 0` is false, so every donor
 * is dropped, fewer than five survive and it returns null — "no analogue
 * estimate" by the engine's own rule, with no engine edit. `_statistics` is the
 * flag the panel reads to say WHY it is absent. The full table has no such key.
 */
import { writeFileSync } from 'node:fs';

/** The full table, on the licence holder's disk only. Gitignored. */
export const FULL_ANALOGUES = 'src/data/flow-analogues.json';
/** The truth-free twin, tracked and published. */
export const PUBLIC_ANALOGUES = 'src/data/flow-analogues.public.json';

/** Reduce a full analogue bundle to the publishable one. */
export function publicAnalogues(bundle) {
  return {
    source: bundle.source,
    method: bundle.method,
    built: bundle.built,
    _note:
      'DONOR FLOWS NOT BUNDLED. `truth` — each donor gauge\'s measured mean flow — comes from DHM ' +
      'yearbooks supplied privately under no redistributable licence, and is null here, so the ' +
      'analogue estimate is unavailable in this build. Catchment attributes and station identity are ' +
      'kept. A licence holder rebuilds the full table with ' +
      '`npm run probe:flow-analogues -- --build`.',
    _statistics: 'not-bundled',
    stations: bundle.stations.map(({ truth: _truth, ...rest }) => ({ ...rest, truth: null })),
  };
}

/** Write it beside the full table. */
export function writePublicAnalogues(bundle) {
  const out = publicAnalogues(bundle);
  writeFileSync(PUBLIC_ANALOGUES, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${PUBLIC_ANALOGUES}: ${out.stations.length} donors, truth withheld`);
  return out;
}
