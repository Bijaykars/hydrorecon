/**
 * Grid connection.  part of `npm run check`
 *
 * The distance itself is geometry and hard to get subtly wrong. What is easy to
 * get wrong, and would quietly flatter every site, is deciding that a line
 * counts when it could not actually take the power — so most of these checks are
 * about what does NOT qualify.
 */
import assert from 'node:assert/strict';
import gridRaw from '../src/data/nepal-grid.json' with { type: 'json' };
import { connectionVerdict, gridLink, requiredKv, GRID_LINE_COUNT, GRID_SUB_COUNT } from '../src/grid.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const raw = gridRaw as unknown as {
  _source: string;
  lines: { kv: number; p: number[] }[];
  subs: { n: string | null; kv: number; y: number; x: number }[];
};

console.log('\ngrid: the bundled OSM extract');

ok('the extract is inside Nepal and carries its licence', () => {
  assert.match(raw._source, /OpenStreetMap/, 'attribution must travel with the data');
  assert.match(raw._source, /ODbL/, 'the licence must be stated on the file');
  assert.equal(raw.lines.length, GRID_LINE_COUNT);
  assert.equal(raw.subs.length, GRID_SUB_COUNT);
  assert.ok(raw.lines.length > 100, `only ${raw.lines.length} lines`);
  for (const s of raw.subs) {
    assert.ok(s.y > 26 && s.y < 31 && s.x > 80 && s.x < 89, `substation at ${s.y},${s.x}`);
  }
  for (const l of raw.lines) {
    assert.ok(l.p.length >= 4 && l.p.length % 2 === 0, 'a line needs at least two whole points');
  }
});

ok('local distribution is excluded, so no site looks falsely well connected', () => {
  // OSM tags 400 V and 11 kV lines as power=line too. Keeping them would put a
  // "connection" beside almost every village in Nepal.
  for (const l of raw.lines) {
    assert.ok(l.kv === 0 || l.kv >= 30, `a ${l.kv} kV line survived the filter`);
  }
});

console.log('\ngrid: what counts as a connection');

ok('bigger plants need bigger wires', () => {
  let prev = 0;
  for (const mw of [1, 5, 20, 50, 150, 500]) {
    const kv = requiredKv(mw);
    assert.ok(kv >= prev, `${mw} MW asks for ${kv} kV, less than a smaller plant`);
    prev = kv;
  }
  assert.equal(requiredKv(5), 33, 'a 5 MW plant connects low');
  assert.ok(requiredKv(150) >= 220, 'a 150 MW plant cannot connect at distribution voltage');
});

ok('a nearby line that cannot take the power is not counted as adequate', () => {
  // Kathmandu, well inside the 132 kV ring, asked to evacuate 500 MW.
  const small = gridLink(27.7, 85.32, 3);
  const huge = gridLink(27.7, 85.32, 500);
  assert.ok(small.nearestKm < 30, `nearest line ${small.nearestKm} km from Kathmandu`);
  // The nearest line is the same physical line for both — only adequacy moves.
  assert.equal(small.nearestKm, huge.nearestKm);
  assert.ok(
    huge.adequateKm === null || huge.adequateKm >= small.adequateKm!,
    'a 500 MW plant cannot have a closer qualifying line than a 3 MW one'
  );
  if (huge.adequateKv !== null) assert.ok(huge.adequateKv >= huge.requiredKv);
});

ok('an untagged line is never treated as adequate', () => {
  // 77 of the ways carry no voltage tag. Assuming they are transmission would
  // invent a connection; they still show as "nearest", flagged as untagged.
  const link = gridLink(28.2, 84.38, 50);
  if (link.adequateKv !== null) {
    assert.ok(link.adequateKv > 0, 'adequacy must never be satisfied by an unknown voltage');
  }
});

ok('remoteness is called out rather than buried', () => {
  const far = connectionVerdict({
    nearestKm: 40, nearestKv: 33, adequateKm: 60, adequateKv: 132,
    requiredKv: 132, nearestSub: null,
  });
  assert.equal(far.hard, true, '60 km of new line is a hard constraint');
  assert.match(far.text, /60 km/);

  const none = connectionVerdict({
    nearestKm: 12, nearestKv: 33, adequateKm: null, adequateKv: null,
    requiredKv: 220, nearestSub: null,
  });
  assert.equal(none.hard, true);
  assert.match(none.text, /no mapped line/i);

  const close = connectionVerdict({
    nearestKm: 2, nearestKv: 132, adequateKm: 2, adequateKv: 132,
    requiredKv: 132, nearestSub: null,
  });
  assert.equal(close.hard, false);
});

console.log('\ngrid: distances behave like distances');

ok('a point on the grid is nearer to it than a point in the far west', () => {
  // Kathmandu valley sits inside the transmission ring; upper Dolpa does not.
  const kathmandu = gridLink(27.7, 85.32, 10);
  const dolpa = gridLink(29.4, 82.9, 10);
  assert.ok(
    kathmandu.nearestKm < dolpa.nearestKm,
    `Kathmandu ${kathmandu.nearestKm.toFixed(1)} km vs Dolpa ${dolpa.nearestKm.toFixed(1)} km`
  );
  assert.ok(kathmandu.nearestSub, 'Kathmandu must find a substation');
});

console.log(`\n${passed} grid checks passed\n`);
