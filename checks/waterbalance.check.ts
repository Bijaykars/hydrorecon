/**
 * Rain in, runoff out.
 *
 *   node --experimental-strip-types --no-warnings checks/waterbalance.check.ts
 *
 * `waterBalance` is three divisions and two unit conversions, which is exactly
 * the kind of code that is wrong by a factor of a thousand and looks fine. The
 * conversions are seconds-per-year and mm-to-metres, and both appear twice —
 * once forwards to get a runoff depth, once backwards to get the yield at the
 * ceiling — so the round trip below is the check that matters.
 *
 * The rest of this file guards the CALIBRATION, which is the part that can rot
 * silently. `RUNOFF_PLAUSIBLE_MAX` is not a physical constant: it is fitted in
 * `checks/waterbalance-vs-fleet.mjs` against 69 measured DHM records whose
 * maximum coefficient is 1.89, on a zero-false-positive target. If someone
 * lowers it to the physically obvious 1.0, the assertions here fail with the
 * measured distribution written next to them, rather than the app quietly
 * starting to call a third of Nepal's gauged rivers impossible.
 */
import assert from 'node:assert/strict';
import { waterBalance, RUNOFF_PLAUSIBLE_MAX } from '../src/report.ts';
import type { ExportContext } from '../src/export.ts';

let passed = 0;
const ok = (n: string, f: () => void) => {
  f();
  passed++;
  console.log(`  ok  ${n}`);
};

/** Only four fields are read, so only four are supplied. */
const ctx = (o: {
  km2: number | null;
  meanCms: number;
  rainMm?: number | null;
  flowScale?: number;
}): ExportContext =>
  ({
    path: [{ uplandKm2: o.km2 }],
    selected: { i: 0, flowScale: o.flowScale ?? 1 },
    flowMeanCms: o.meanCms,
    catchmentRainMm: o.rainMm ?? null,
  }) as unknown as ExportContext;

/** 31,556,952 s in a year, so 1 m3/s off 31.556952 km2 is exactly 1,000 mm. */
ok('a metre of runoff is a metre of runoff', () => {
  const w = waterBalance(ctx({ km2: 31.556952, meanCms: 1, rainMm: 2000 }))!;
  assert.ok(Math.abs(w.runoffMm - 1000) < 1e-6, `runoff ${w.runoffMm}`);
  assert.ok(Math.abs(w.coefficient - 0.5) < 1e-9, `coefficient ${w.coefficient}`);
});

ok('the yield round-trips: at the ceiling coefficient it equals the flow itself', () => {
  const rain = 1000 / RUNOFF_PLAUSIBLE_MAX;
  const w = waterBalance(ctx({ km2: 31.556952, meanCms: 1, rainMm: rain }))!;
  assert.ok(Math.abs(w.coefficient - RUNOFF_PLAUSIBLE_MAX) < 1e-9, `coefficient ${w.coefficient}`);
  assert.ok(Math.abs(w.ceilingCms - 1) < 1e-9, `ceiling yield ${w.ceilingCms}`);
});

ok('flowScale is applied — the mean is read at the intake, not at the click', () => {
  const a = waterBalance(ctx({ km2: 100, meanCms: 4, rainMm: 2000 }))!;
  const b = waterBalance(ctx({ km2: 100, meanCms: 8, rainMm: 2000, flowScale: 0.5 }))!;
  assert.ok(Math.abs(a.coefficient - b.coefficient) < 1e-12);
});

ok('no rainfall, no catchment or no flow returns null rather than a fabricated ratio', () => {
  assert.equal(waterBalance(ctx({ km2: 100, meanCms: 4 })), null);
  assert.equal(waterBalance(ctx({ km2: null, meanCms: 4, rainMm: 2000 })), null);
  assert.equal(waterBalance(ctx({ km2: 100, meanCms: 0, rainMm: 2000 })), null);
  assert.equal(waterBalance(ctx({ km2: 100, meanCms: 4, rainMm: 0 })), null);
});

/**
 * THE CALIBRATION. Measured coefficients at 69 DHM gauges with 10+ complete
 * years: median 0.87, p90 1.31, p95 1.52, max 1.89. Nepal as a whole runs about
 * 0.95. Any ceiling at or below 1.89 refuses a river that was measured.
 */
ok('the ceiling clears everything 69 measured Nepali records show', () => {
  assert.ok(
    RUNOFF_PLAUSIBLE_MAX > 1.89,
    `ceiling ${RUNOFF_PLAUSIBLE_MAX} would refuse a MEASURED gauge record; the 69-gauge maximum is 1.89 ` +
      '(median 0.87, p95 1.52) — see checks/waterbalance-vs-fleet.mjs'
  );
});

ok('and it is not so high that it can never fire', () => {
  assert.ok(RUNOFF_PLAUSIBLE_MAX <= 3, `ceiling ${RUNOFF_PLAUSIBLE_MAX} fires on nothing in the fleet`);
});

ok('the measured median, p95 and maximum all pass', () => {
  for (const c of [0.87, 1.52, 1.89]) {
    const w = waterBalance(ctx({ km2: 31.556952, meanCms: c, rainMm: 1000 }))!;
    assert.ok(w.coefficient <= RUNOFF_PLAUSIBLE_MAX, `a measured coefficient of ${c} must not fire`);
  }
});

/**
 * 27.65 N, 85.90 E, Lisangkhu Pakhar — the site that caused this function.
 * 1.70 m3/s off 5.47 km2 with 1,589 mm of catchment rain. The mapped network
 * said 0.20 m3/s at the same point, and that passes.
 */
ok('the Sindhupalchok site trips it, and the network candidate does not', () => {
  const w = waterBalance(ctx({ km2: 5.47, meanCms: 1.6988, rainMm: 1589 }))!;
  assert.ok(w.coefficient > RUNOFF_PLAUSIBLE_MAX, `coefficient ${w.coefficient}`);
  assert.ok(w.coefficient > 6 && w.coefficient < 6.4, `expected about 6.2, got ${w.coefficient}`);
  const net = waterBalance(ctx({ km2: 5.47, meanCms: 0.202, rainMm: 1589 }))!;
  assert.ok(net.coefficient < 1, `network coefficient ${net.coefficient}`);
});

ok('a typical gauged Nepali river does not trip it', () => {
  // 800 km2, 1,600 mm, 30 m3/s — squarely inside the measured population.
  const w = waterBalance(ctx({ km2: 800, meanCms: 30, rainMm: 1600 }))!;
  assert.ok(w.coefficient < RUNOFF_PLAUSIBLE_MAX, `coefficient ${w.coefficient}`);
});

console.log(`\nwaterbalance: ${passed} checks passed`);
