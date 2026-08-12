/**
 * Sediment.  part of `npm run check`
 *
 * Settling velocity is the load-bearing number: every basin dimension divides by
 * it, so an error there scales the whole structure and the fit test with it. It
 * is checked against published quartz values rather than against itself.
 *
 * The bench test is checked on terrain whose answer is known by construction — a
 * V-shaped gorge has no bench, a terrace does — because the failure that matters
 * is a gorge reading as flat, which would let the app promise room that is not
 * there.
 */
import assert from 'node:assert/strict';
import {
  benchFit,
  desander,
  sedimentSource,
  settlingVelocity,
  targetParticleMm,
  type CrossSample,
} from '../src/engine/sediment.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};
const near = (got: number, want: number, tol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got.toFixed(4)}, wanted ${want} +/-${tol}`);

console.log('\nsediment: settling velocity');

ok('matches published quartz settling velocities', () => {
  // Handbook values for quartz in cold water, mm/s. These are the anchor: if
  // this drifts, every basin in the app is the wrong size.
  near(settlingVelocity(0.1) * 1000, 6.0, 0.6, '0.1 mm');
  near(settlingVelocity(0.2) * 1000, 21.3, 1.5, '0.2 mm');
  near(settlingVelocity(0.3) * 1000, 38.6, 3, '0.3 mm');
  near(settlingVelocity(0.5) * 1000, 67.5, 5, '0.5 mm');
});

ok('sits below Stokes above 0.1 mm, which is the whole point of using Zanke', () => {
  // Stokes over-predicts once inertia matters, and it matters across exactly the
  // range that damages turbines. A formula that agreed with Stokes at 0.5 mm
  // would be undersizing every basin.
  const stokes = (mm: number) => (9.81 * 1.65 * (mm / 1000) ** 2) / (18 * 1.31e-6);
  // Zanke is a fit across the whole range, not an asymptote, so it runs about
  // 13% under Stokes even at 0.05 mm where Stokes is genuinely right. That is a
  // real limitation and it is outside the 0.2-0.5 mm band the app ever uses.
  near(settlingVelocity(0.05), stokes(0.05), stokes(0.05) * 0.15, 'near Stokes at 0.05 mm');
  assert.ok(settlingVelocity(0.3) < stokes(0.3) * 0.7, 'should be well under Stokes at 0.3 mm');
  assert.ok(settlingVelocity(0.5) < stokes(0.5) * 0.5, 'should be far under Stokes at 0.5 mm');
});

ok('rises monotonically with grain size', () => {
  let prev = 0;
  for (const d of [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.8, 1.0]) {
    const w = settlingVelocity(d);
    assert.ok(w > prev, `${d} mm settles no faster than the grain below it`);
    prev = w;
  }
});

ok('a higher head demands a cleaner river', () => {
  assert.equal(targetParticleMm(400), 0.2);
  assert.equal(targetParticleMm(150), 0.2);
  assert.equal(targetParticleMm(80), 0.3);
  assert.equal(targetParticleMm(20), 0.5);
});

console.log('\nsediment: basin sizing');

ok('a Chilime-scale duty lands near the basin Chilime actually has', () => {
  // 22 MW, about 7.2 m3/s on 345 m. Its desanding basin is roughly 90 m long.
  // The model runs deliberately conservative (turbulence factor 2.0), so it is
  // expected to come out somewhat over, not under — a screening tool should ask
  // for more flat ground than the final design needs, never less.
  const d = desander({ designFlowCms: 7.2, netHeadM: 345 })!;
  assert.ok(d, 'no basin sized');
  assert.equal(d.particleMm, 0.2);
  assert.ok(
    d.totalLengthM > 70 && d.totalLengthM < 160,
    `${d.totalLengthM.toFixed(0)} m against a built ~90 m`
  );
  assert.ok(d.totalWidthM > 6 && d.totalWidthM < 12, `width ${d.totalWidthM.toFixed(1)} m`);
  assert.ok(d.depthM >= 1.5 && d.depthM <= 8, `depth ${d.depthM.toFixed(1)} m`);
  assert.equal(d.bays, 2, 'a plant this size flushes one chamber while the other runs');
});

ok('plan area follows the overflow-rate criterion, not the chosen velocity', () => {
  // Surface loading says settling area is Q/w and nothing else. Through-velocity
  // only trades length against width. If that invariant breaks, the internal
  // velocity constant has quietly become a free parameter that changes answers.
  const d = desander({ designFlowCms: 5, netHeadM: 200 })!;
  const w = settlingVelocity(d.particleMm);
  const idealArea = 5 / w;
  const planArea = d.settlingLengthM * (d.totalWidthM - 1.5);
  near(planArea / idealArea, 2.0, 0.15, 'plan area over ideal should be the turbulence factor');
});

ok('a small micro-hydro duty gets a small basin and a single chamber', () => {
  const d = desander({ designFlowCms: 0.35, netHeadM: 60 })!;
  assert.equal(d.bays, 1, 'a 0.35 m3/s plant can shut down to flush');
  assert.ok(d.totalLengthM < 30, `${d.totalLengthM.toFixed(0)} m is too much for 0.35 m3/s`);
  assert.ok(d.benchNeededM < 15, `${d.benchNeededM.toFixed(0)} m of bench for a micro scheme`);
});

ok('the basin grows with flow and with head', () => {
  const small = desander({ designFlowCms: 2, netHeadM: 300 })!;
  const bigQ = desander({ designFlowCms: 20, netHeadM: 300 })!;
  const lowH = desander({ designFlowCms: 2, netHeadM: 30 })!;
  assert.ok(bigQ.excavationM3 > small.excavationM3 * 3, 'ten times the flow, barely more basin');
  assert.ok(
    lowH.settlingLengthM < small.settlingLengthM,
    'a low-head plant tolerates coarser sand and needs less basin'
  );
});

ok('refuses nonsense rather than returning a shape', () => {
  assert.equal(desander({ designFlowCms: 0, netHeadM: 100 }), null);
  assert.equal(desander({ designFlowCms: 5, netHeadM: 0 }), null);
  assert.equal(desander({ designFlowCms: -1, netHeadM: 100 }), null);
});

console.log('\nsediment: is there room for it?');

/** A symmetric V-shaped gorge: 60% side slopes, no bench anywhere. */
const gorge: CrossSample[] = Array.from({ length: 41 }, (_, i) => {
  const offsetM = (i - 20) * 10;
  return { offsetM, elevationM: 1000 + Math.abs(offsetM) * 0.6 };
});

/** A gorge with a 120 m terrace cut into the right bank, 5 m above the river. */
const terrace: CrossSample[] = gorge.map((p) =>
  p.offsetM >= 40 && p.offsetM <= 160 ? { ...p, elevationM: 1005 } : p
);

ok('a gorge reports no room, at any basin size', () => {
  // The finding here is about slope, not width: nothing in 500 m of valley is
  // flatter than the limit. That holds whether the basin wanted 15 m or 150,
  // and it must not be softened into "cannot tell" just because the basin is
  // narrower than the DEM posting — that is how the first version of this test
  // ended up declining to answer for almost every real scheme.
  for (const need of [15, 22, 150]) {
    const f = benchFit(gorge, need, 30)!;
    assert.ok(f, 'no answer for the gorge');
    assert.equal(f.verdict, 'no-room', `${need} m basin in a V-shaped gorge`);
  }
});

ok('the floor of a symmetric V does not read as flat', () => {
  // The specific trap: a central-difference slope is zero at the bottom of a V,
  // because the ground rises equally on both sides. That would put a bench in
  // the middle of the river.
  const f = benchFit(gorge, 15, 30)!;
  assert.equal(f.widestM, 0, `${f.widestM} m of flat ground found at a gorge floor`);
});

ok('a real terrace is found, sized and placed on the correct bank', () => {
  const f = benchFit(terrace, 15, 30)!;
  assert.equal(f.verdict, 'fits', 'a 120 m terrace should hold a 15 m basin');
  assert.ok(f.widestM >= 100, `only ${f.widestM} m of the 120 m terrace found`);
  assert.equal(f.side, 'right', 'the terrace is at positive offsets');
  assert.ok(f.liftM > 0 && f.liftM < 20, `bench sits ${f.liftM.toFixed(1)} m above the river`);
});

ok('a terrace too high to gravity-feed is not offered', () => {
  // Same flat ground, lifted 60 m up the valley side. It is real, and it is
  // useless — the basin has to sit just below intake water level.
  const high = gorge.map((p) =>
    p.offsetM >= 40 && p.offsetM <= 160 ? { ...p, elevationM: 1060 } : p
  );
  assert.equal(benchFit(high, 15, 30)!.verdict, 'no-room');
});

ok('a call inside the terrain error is reported as too close to call', () => {
  // 120 m of measured bench against a basin wanting 130 m. The difference is
  // smaller than one DEM posting, so neither answer is honest.
  assert.equal(benchFit(terrace, 130, 30)!.verdict, 'marginal');
  // Move the requirement clear of the posting in either direction and the
  // answer becomes decisive again.
  assert.equal(benchFit(terrace, 60, 30)!.verdict, 'fits');
  assert.equal(benchFit(terrace, 200, 30)!.verdict, 'no-room');
});

ok('too few samples returns nothing rather than a guess', () => {
  assert.equal(benchFit(gorge.slice(0, 3), 15, 30), null);
  assert.equal(benchFit(gorge, 0, 30), null);
  // NaN elevations, which is what an uncovered DEM tile produces.
  const blank = gorge.map((p) => ({ ...p, elevationM: NaN }));
  assert.equal(benchFit(blank, 15, 30), null);
});

console.log('\nsediment: what the catchment delivers');

ok('a high catchment reads as glacial and a low one does not', () => {
  const high = sedimentSource(0.25)!; // 75% above 3000 m — a trans-Himalayan reach
  assert.match(high.label, /glacier/i);
  near(high.highFrac, 0.75, 1e-9, 'high fraction');

  const mid = sedimentSource(0.8)!; // 20% above 3000 m
  assert.match(mid.label, /mixed/i);

  const low = sedimentSource(0.98)!; // a middle-hills catchment
  assert.match(low.label, /middle hills/i);
  // It must still say a desander is needed. Nepali hill rivers are not clean,
  // and "low risk" reading as "no basin" would be an expensive misunderstanding.
  assert.match(low.note, /desander is still needed/i);
});

ok('no hypsometry means no claim', () => {
  assert.equal(sedimentSource(NaN), null);
});

console.log(`\n${passed} sediment checks passed\n`);
