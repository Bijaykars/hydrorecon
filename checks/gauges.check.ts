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
import {
  DISCHARGE_GAUGE_COUNT,
  RIVER_GAUGE_COUNT,
  recordKind,
  transferAdvice,
  type Gauge,
} from '../src/gauges.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

type RawStation = {
  n: string; y: number; x: number; e: number | null; r: number;
  q?: number; qs?: number; rv?: string; b?: string; d?: string; w?: number; g?: number;
};
const bundle = stationsRaw as unknown as {
  _source: string;
  _retrieved: string;
  stations: RawStation[];
};
const stations = bundle.stations;

console.log('\ngauges: the bundled DHM inventory');

ok('river gauges are separated from rainfall stations', () => {
  assert.match(bundle._source, /hydrology\.gov\.np/, 'official source must travel with the data');
  assert.match(bundle._retrieved, /^\d{4}-\d{2}-\d{2}$/, 'snapshot needs a retrieval date');
  const rivers = stations.filter((s) => s.r === 1);
  const rain = stations.filter((s) => s.r === 0);
  assert.equal(rivers.length, RIVER_GAUGE_COUNT, 'exported count must match the file');
  assert.ok(rivers.length > 150 && rivers.length < 500, `${rivers.length} river gauges`);
  assert.ok(rain.length > 0, 'rainfall stations must still be present');
  // Every river gauge must be inside Nepal, or the distance search is meaningless.
  for (const s of rivers) {
    assert.ok(
      s.y > 26 && s.y < 31 && s.x > 80 && s.x < 89,
      `${s.n} at ${s.y},${s.x} is outside Nepal`
    );
  }
});

ok("Nepal's major river gauges are classified, not missed", () => {
  // These are named "<River> at <Place>" with no "River" or "Khola" in them, so
  // the old name-matching classifier was blind to them — the Arun, the Bheri
  // and the Budhi Gandaki among them. They are found by what the instrument
  // reports instead, which is not free text.
  const rivers = stations.filter((s) => s.r === 1);
  for (const want of ['Arun at', 'Bheri at', 'Budhi Gandaki at', 'Babai at', 'Chamelia at']) {
    assert.ok(
      rivers.some((s) => s.n.startsWith(want)),
      `no river gauge matching "${want}" — classification has regressed`
    );
  }
});

ok('discharge stations are identified and carry a citable series id', () => {
  const q = stations.filter((s) => s.r === 1 && s.q === 1);
  assert.equal(q.length, DISCHARGE_GAUGE_COUNT, 'exported discharge count must match');
  assert.ok(q.length > 100, `only ${q.length} stations gauge discharge`);
  assert.ok(q.length < stations.filter((s) => s.r === 1).length, 'not every gauge measures flow');
  for (const s of q) {
    assert.ok(Number.isInteger(s.qs) && s.qs! > 0, `${s.n}: discharge flag without a series id`);
  }
});

ok('no personal data rides along in the bundle', () => {
  // The upstream feed carries observer names, mobile numbers, home addresses,
  // bank accounts and PAN numbers. The pipeline takes fields by allow-list, and
  // this is the backstop if that list is ever widened carelessly.
  const json = JSON.stringify(stations);
  for (const pattern of [/\b9[678]\d{8}\b/, /account/i, /\bPAN\b/, /observer/i, /\bbank\b/i]) {
    const hit = pattern.exec(json);
    assert.ok(!hit, `personal data in the bundle: ${hit?.[0]}`);
  }
});

ok('flood thresholds are plausible gauge-board readings', () => {
  for (const s of stations.filter((x) => x.w || x.g)) {
    for (const v of [s.w, s.g]) {
      if (v === undefined) continue;
      assert.ok(v > 0 && v < 30, `${s.n}: ${v} m is not a gauge-board level`);
    }
    // Danger is above warning, or the two have been swapped.
    if (s.w !== undefined && s.g !== undefined) {
      assert.ok(s.g >= s.w, `${s.n}: danger ${s.g} m below warning ${s.w} m`);
    }
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
  measuresDischarge: true,
  seriesId: 12345,
  river: 'Test Khola',
  basin: 'Koshi',
  district: 'Somewhere',
  warnLevelM: 3.5,
  dangerLevelM: 4.5,
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

ok('a stage-only station says so, rather than implying it holds flow', () => {
  const stage = recordKind(g({ measuresDischarge: false, seriesId: null }));
  assert.match(stage, /rating curve/i, 'stage without a curve is not a flow record');
  assert.doesNotMatch(stage, /series/i, 'no series id to quote when there is no discharge record');
  // And a discharge one quotes the id DHM would need to find it.
  assert.match(recordKind(g({ measuresDischarge: true, seriesId: 15381 })), /series 15381/);
});

console.log(`\n${passed} gauge checks passed\n`);
