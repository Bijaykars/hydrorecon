/**
 * Waterway sizing and head loss.  part of `npm run check`
 *
 * Two independent anchors, because agreeing with itself proves nothing:
 * ESHA 2004's own worked penstock-diameter example, and the five built power
 * stations, whose losses have to land where real schemes land.
 */
import assert from 'node:assert/strict';
import { darcyF, eshaPenstockDiameter, sizeWaterway } from '../src/engine/waterway.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};
const near = (a: number, b: number, tol: number, what = '') =>
  assert.ok(Math.abs(a - b) <= tol, `${what} ${a} != ${b} (tol ${tol})`);

console.log('\nwaterway: against the published references');

ok("ESHA 2004's worked penstock example is reproduced", () => {
  // Handbook: Q = 3 m3/s, H = 85 m, L = 173 m, n = 0.012 -> D = 0.88 m.
  near(eshaPenstockDiameter(3, 85, 173, 0.012), 0.88, 0.005, 'ESHA D');
});

ok('the friction factor matches its closed forms and joins smoothly between', () => {
  near(darcyF(500, 1), 64 / 500, 1e-12, 'laminar');
  near(darcyF(2000, 1), 64 / 2000, 1e-12, 'laminar to 2100');
  // Fully rough turbulent: Swamee-Jain against hand-evaluated values.
  near(darcyF(1e6, 1, 4.5e-5), 0.01259, 5e-4, 'Swamee-Jain at Re 1e6');
  // No step across the transition — a kink here would be integrated over by
  // the daily dispatch loop, so it has to be continuous, and monotone with it.
  let prev = darcyF(2050, 1);
  for (let re = 2050; re <= 2400; re += 10) {
    const f = darcyF(re, 1);
    assert.ok(Number.isFinite(f) && f > 0, `bad f at Re ${re}`);
    assert.ok(Math.abs(f - prev) < 0.004, `jump at Re ${re}: ${prev} -> ${f}`);
    prev = f;
  }
});

console.log('\nwaterway: sizing rules that keep the design buildable');

ok('penstock velocity is never allowed past the 5 m/s ceiling', () => {
  // The case that exposed it: ESHA alone gave 3.19 m and 13.8 m/s here.
  const w = sizeWaterway({ designFlowCms: 110, grossHeadM: 215, alongRiverM: 5000 })!;
  const pen = w.segments.find((s) => s.kind === 'penstock')!;
  assert.ok(pen.velocityMs <= 5 + 1e-9, `penstock at ${pen.velocityMs} m/s`);
  assert.match(pen.method, /held to 5 m\/s/, 'must say the economic diameter was overridden');
  // Widening is the only permitted response — never narrowing.
  assert.ok(pen.diameterM > eshaPenstockDiameter(110, 215, 215 / Math.sin(Math.PI / 4)));
});

ok('local losses are charged, so a short high-head scheme is not free', () => {
  // Friction alone put an 800 m scheme at 0.67% total, which no real plant is.
  const w = sizeWaterway({ designFlowCms: 66, grossHeadM: 800, alongRiverM: 8000 })!;
  const pen = w.segments.find((s) => s.kind === 'penstock')!;
  assert.match(pen.method, /rack\/bends\/valve/, 'the breakdown must name them');
  // K = 1.3 on the velocity head at the 5 m/s cap is about 1.66 m, and it
  // cannot vanish however generously the pipe is sized.
  assert.ok(pen.lossM > 1.5, `penstock loss ${pen.lossM} m ignores fittings`);
});

console.log('\nwaterway: the bias it exists to remove');

ok('a longer waterway costs more head — strictly, at every step', () => {
  let prev = -Infinity;
  for (const km of [0.5, 1, 2, 5, 8, 10, 13.8]) {
    const w = sizeWaterway({ designFlowCms: 110, grossHeadM: 215, alongRiverM: km * 1000 })!;
    assert.ok(
      w.totalLossM > prev,
      `${km} km lost ${w.totalLossM} m, no more than the shorter option's ${prev} m`
    );
    prev = w.totalLossM;
  }
});

ok('a scheme whose losses swallow its head is not quietly made viable', () => {
  // 50 m of gross head dragged 14 km is not a scheme, and must not survive as one.
  const w = sizeWaterway({ designFlowCms: 5, grossHeadM: 50, alongRiverM: 14000 })!;
  assert.ok(w.lossFrac > 0.4, `only ${(w.lossFrac * 100).toFixed(0)}% lost over 14 km for 50 m`);
  // But net head can never go negative, whatever the geometry.
  assert.ok(w.lossFrac < 1, 'loss fraction must stay below unity');
});

console.log('\nwaterway: do real power stations come out plausible?');

/** Gross head, design flow and rough conveyance length, from the operators. */
const PLANTS = [
  { name: 'Chilime', h: 355, q: 7.5, km: 3.0 },
  { name: 'Upper Tamakoshi', h: 822, q: 66, km: 8.0 },
  { name: 'Nyadi', h: 334, q: 11.0, km: 4.0 },
  { name: 'Kabeli A', h: 117, q: 37.7, km: 5.0 },
  { name: 'Rasuwagadhi', h: 168, q: 80, km: 3.5 },
];

for (const p of PLANTS) {
  ok(`${p.name} — losses land where a built scheme's do`, () => {
    const w = sizeWaterway({ designFlowCms: p.q, grossHeadM: p.h, alongRiverM: p.km * 1000 })!;
    assert.ok(w, `${p.name}: could not be sized`);
    // Built run-of-river schemes run roughly 0.5-8% of gross. Outside that the
    // sizing has gone wrong in one direction or the other.
    assert.ok(
      w.lossFrac > 0.005 && w.lossFrac < 0.08,
      `${p.name}: ${(w.lossFrac * 100).toFixed(2)}% of gross is not a real design`
    );
    const pen = w.segments.find((s) => s.kind === 'penstock')!;
    assert.ok(pen.diameterM > 0.3 && pen.diameterM < 12, `${p.name}: D = ${pen.diameterM} m`);
  });
}

console.log(`\n${passed} waterway checks passed\n`);
