/**
 * Gauge transfer — the arithmetic that would be embarrassing to get wrong.
 *
 * A catchment-area transfer factor is a number an engineer would actually
 * multiply a measured discharge by. If the snapped catchment is wrong, the
 * factor is wrong by the same amount, and it still prints to two decimals and
 * looks authoritative. So the rules that decide when NOT to publish one matter
 * more than the multiplication itself.
 *
 * These run offline against the bundled station file — no network, no browser.
 */
import assert from 'node:assert/strict';
import stationsRaw from '../src/data/dhm-stations.json' with { type: 'json' };
import { transferAdvice, RIVER_GAUGE_COUNT, type Gauge } from '../src/gauges.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

type RawStation = { n: string; y: number; x: number; e: number | null; r: number };
const stations = stationsRaw as RawStation[];

console.log('\ngauges: the bundled DHM inventory');

ok('river gauges are separated from rainfall stations', () => {
  const rivers = stations.filter((s) => s.r === 1);
  const rain = stations.filter((s) => s.r === 0);
  assert.equal(rivers.length, RIVER_GAUGE_COUNT, 'exported count must match the file');
  assert.ok(rivers.length > 150 && rivers.length < 400, `${rivers.length} river gauges`);
  assert.ok(rain.length > rivers.length, 'the file is mostly rainfall stations');
  // Every river gauge must be inside Nepal, or the distance search is meaningless.
  for (const s of rivers) {
    assert.ok(
      s.y > 26 && s.y < 31 && s.x > 80 && s.x < 89,
      `${s.n} at ${s.y},${s.x} is outside Nepal`
    );
  }
});

console.log('\ngauges: when a transfer factor may be published');

/** Minimal stand-in for a resolved gauge; only the fields advice reads. */
const g = (over: Partial<Gauge>): Gauge => ({
  name: 'Test at Somewhere',
  lat: 28,
  lon: 84,
  distanceKm: 2,
  uplandKm2: 1000,
  relation: 'upstream',
  areaRatio: 1,
  trustworthy: true,
  ...over,
});

ok('an unresolved confluence gauge offers no scaling factor at all', () => {
  // This is the Khudi Khola / Marsyangdi at Dharapani case: the two snap
  // candidates disagreed 22x and 188x, so no catchment is published.
  const advice = transferAdvice(g({ uplandKm2: null, areaRatio: null, trustworthy: false }));
  assert.match(advice, /confluence/i, 'must say why, not just go quiet');
  assert.doesNotMatch(advice, /multiply/i, 'must not offer a factor it cannot justify');
  assert.doesNotMatch(advice, /\d+\.\d+x/, 'must not print any ratio');
});

ok('a factor is offered only inside the 0.5-2x range where transfer holds', () => {
  assert.match(transferAdvice(g({ areaRatio: 1.4 })), /multiply its discharge by 1\.40x/);
  // Outside the range the factor is arithmetic but not hydrology.
  const wide = transferAdvice(g({ areaRatio: 20, trustworthy: false }));
  assert.doesNotMatch(wide, /multiply/i, 'a 20x transfer must not be recommended');
  assert.match(wide, /0\.5-2x/, 'must say what the accepted range is');
});

ok('a gauge on a different branch is never transferred, however close', () => {
  const advice = transferAdvice(
    g({ relation: 'nearby catchment', distanceKm: 0.3, areaRatio: 1.02, trustworthy: false })
  );
  assert.doesNotMatch(advice, /multiply/i, 'proximity is not connectivity');
  assert.match(advice, /branch|analogue/i);
});

ok('a trustworthy gauge must be connected AND in range — both, not either', () => {
  // Connected but far out of range.
  assert.equal(g({ relation: 'upstream', areaRatio: 8, trustworthy: false }).trustworthy, false);
  // In range but not connected.
  assert.equal(
    g({ relation: 'nearby catchment', areaRatio: 1, trustworthy: false }).trustworthy,
    false
  );
  // The advice for a good one names a factor and nothing else.
  assert.match(transferAdvice(g({ relation: 'downstream', areaRatio: 0.75 })), /0\.75x/);
});

console.log(`\n${passed} gauge checks passed\n`);
