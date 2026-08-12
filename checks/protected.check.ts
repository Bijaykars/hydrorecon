/**
 * Protected areas.  part of `npm run check`
 *
 * A containment test has two ways to be wrong and they are not equally bad. A
 * false positive wastes a conversation. A FALSE NEGATIVE tells an engineer their
 * site is unprotected when it sits inside a national park, and they find out
 * after spending money. So the checks below are anchored on real places whose
 * status is not in doubt.
 */
import assert from 'node:assert/strict';
import protectedRaw from '../src/data/nepal-protected.json' with { type: 'json' };
import { PROTECTED_COUNT, isHardStop, protectedAt, protectedNear } from '../src/protected.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const raw = protectedRaw as unknown as {
  _source: string;
  areas: { n: string; a: number; rings: number[][] }[];
};

console.log('\nprotected: the bundled extract');

ok('the extract carries its licence and covers the real parks', () => {
  assert.match(raw._source, /OpenStreetMap/);
  assert.match(raw._source, /ODbL/);
  assert.equal(raw.areas.length, PROTECTED_COUNT);
  // The parks a Nepali engineer would name first must all be present. Their
  // absence is the dangerous failure — silence reads as "not protected".
  for (const want of [
    'Chitwan',
    'Sagarmatha',
    'Langtang',
    'Annapurna',
    'Makalu Barun',
    'Bardiya',
    'Shey Phoksundo',
    'Kanchanjunga',
  ]) {
    assert.ok(
      raw.areas.some((a) => a.n.includes(want)),
      `${want} is missing — a gap here reads as "not protected"`
    );
  }
});

ok('assembled areas match the published sizes', () => {
  // Rings are stitched from dozens of relation members, and a stitching bug
  // shows up as an area that is wildly wrong. Published figures, +/-30%.
  const expect: Record<string, number> = {
    'Annapurna Conservation Area': 7629,
    'Sagarmatha National Park': 1148,
    'Shey Phoksundo National Park': 3555,
    'Langtang National Park': 1710,
    'Bardiya National Park': 968,
  };
  for (const [name, km2] of Object.entries(expect)) {
    const got = raw.areas.find((a) => a.n === name);
    assert.ok(got, `${name} absent`);
    const off = Math.abs(got!.a - km2) / km2;
    assert.ok(off < 0.3, `${name}: ${got!.a} km² against a published ${km2} km²`);
  }
});

ok('foreign parks along the border are excluded', () => {
  // Overpass returns anything intersecting Nepal, which pulls in Dudhwa and
  // Sohelwa in Uttar Pradesh and Barsey in Sikkim. Reporting a Nepali site as
  // inside an Indian tiger reserve would be a strange way to be wrong.
  for (const foreign of ['Dudhwa', 'Sohelwa', 'Barsey']) {
    assert.ok(
      !raw.areas.some((a) => a.n.includes(foreign)),
      `${foreign} is in India and must not be in a Nepal layer`
    );
  }
});

console.log('\nprotected: does containment actually work?');

ok('a point deep inside Chitwan is reported as inside it', () => {
  // Well within the park, away from any boundary.
  const hits = protectedAt(27.5, 84.33);
  assert.ok(hits.length > 0, 'Chitwan interior reported as unprotected');
  assert.ok(
    hits.some((h) => h.name.includes('Chitwan')),
    `got ${hits.map((h) => h.name).join(', ')}`
  );
  assert.ok(isHardStop(hits), 'a national park must register as a hard constraint');
});

ok('a point deep inside Sagarmatha is reported as inside it', () => {
  // Near Everest Base Camp, unambiguously inside the park.
  const hits = protectedAt(27.98, 86.86);
  assert.ok(
    hits.some((h) => h.name.includes('Sagarmatha')),
    `got ${hits.map((h) => h.name).join(', ') || 'nothing'}`
  );
  assert.ok(isHardStop(hits));
});

ok('a conservation area is flagged but not treated as a prohibition', () => {
  // Manang, inside the Annapurna Conservation Area — which does host licensed
  // hydropower. Calling it a hard stop would be wrong in the other direction.
  const hits = protectedAt(28.66, 84.02);
  assert.ok(
    hits.some((h) => h.name.includes('Annapurna')),
    `got ${hits.map((h) => h.name).join(', ') || 'nothing'}`
  );
  assert.ok(
    !isHardStop(hits),
    'a conservation area permits development with conditions and must not read as prohibited'
  );
});

ok('ordinary unprotected land is reported as unprotected', () => {
  // Kathmandu, and a Terai town — neither is inside a park.
  for (const [lat, lon, where] of [
    [27.7, 85.32, 'Kathmandu'],
    [26.81, 87.28, 'Biratnagar'],
  ] as [number, number, string][]) {
    const hits = protectedAt(lat, lon);
    assert.equal(hits.length, 0, `${where} reported inside ${hits.map((h) => h.name).join(', ')}`);
  }
});

ok('proximity is reported separately from containment', () => {
  // A point outside every park is not "near" one unless it really is.
  const near = protectedNear(26.81, 87.28, 3);
  assert.equal(near.length, 0, 'Biratnagar is not beside a park');
  // And nothing can be both inside and near the same area.
  const inside = protectedAt(27.5, 84.33);
  const beside = protectedNear(27.5, 84.33, 3);
  for (const h of inside) {
    assert.ok(!beside.some((b) => b.name === h.name), `${h.name} reported as both inside and near`);
  }
});

console.log(`\n${passed} protected checks passed\n`);
