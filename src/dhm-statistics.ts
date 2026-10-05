/**
 * Does this build hold DHM's discharge statistics, or only the station list?
 *
 * `src/data/dhm-records.json` ships in two forms. A licence holder's copy
 * carries the derived statistics — annual mean, monthly regime, flow-duration
 * quantiles — built from privately supplied yearbooks. The published copy
 * carries station identity only, because those statistics are not
 * redistributable (LICENSES.md, blocker 1), and marks itself `_statistics:
 * "not-bundled"`.
 *
 * WHY A SEPARATE MODULE. The two consumers of the statistics, `src/dhm.ts` and
 * `src/engine/fdcshape.ts`, are both covered by the engine signature. This
 * split is packaging, not engineering: it must not move a reported number and
 * must not move the signature, so neither module is edited and the flag lives
 * here instead, where the unsigned callers — App.tsx, report.ts, Reading.tsx —
 * can read it.
 *
 * WHAT GOES MISSING WITHOUT THEM, and why each is reported rather than faked:
 *
 *   Gauge transfer. `bestTransfer` refuses every donor on its own
 *   specific-discharge screen, because the published index sets `meanCms` to
 *   null. So no record is offered, no record is adopted, and no number is
 *   quietly scaled by a mean the app does not have.
 *
 *   The flow-duration shape check. `NATIONAL_SHAPE` is assembled from the
 *   gauges' own quantiles, so without them there is no band to test against.
 *   The callers skip `judgeShape` entirely rather than let it return a verdict
 *   built from zero stations, and the report says the check did not run. That
 *   matters: the correction fires on about 16% of sites and CHANGES THE DESIGN
 *   FLOW, so a build where it cannot run is not the same screening tool and the
 *   document has to admit it.
 */
import bundle from './data/dhm-records.json' with { type: 'json' };

/**
 * True when the bundled index carries measured discharge statistics.
 *
 * Read off the marker rather than sniffed from a station, so the licensed
 * index needs no edit — its bytes, and therefore every number derived from
 * them, are untouched by the split.
 */
export const DHM_STATISTICS_BUNDLED =
  (bundle as unknown as { _statistics?: string })._statistics !== 'not-bundled';

/** One sentence, used by both the panel and the report, so they cannot drift. */
export const DHM_STATISTICS_ABSENT_NOTE =
  "DHM's daily discharge yearbooks are sold through a procurement process and carry no " +
  'redistributable licence, so the derived gauge statistics are not bundled in this build. ' +
  'The station list is published openly and is unaffected. Obtain the records from the ' +
  'Department of Hydrology and Meteorology and rebuild the index with ' +
  'pipeline/build-dhm-records.mjs to restore the gauge-transfer and flow-duration screens.';
