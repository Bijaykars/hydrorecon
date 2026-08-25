/**
 * The national geology polygons, and the accounting over them.
 *
 * Unlike the landcover check this runs against the REAL bundled sheet, because
 * the sheet is 0.45 MB rather than 598 MB and because the thing most likely to
 * break here is the data, not the arithmetic: a rebuild with a different
 * tolerance, a shapefile whose rings stop closing, a `No Data` label that
 * changes spelling and silently stops being recognised as blank.
 *
 * The fixture is a real traverse across the Churia hills at 27.0 N, where the
 * sheet draws Recent, then Lower, Middle and Upper Siwalik in sequence between
 * 85.9 and 86.1 E. If the polygons or the walk break, that sequence stops
 * reproducing.
 *
 * THE LOAD-BEARING ASSERTION is that a coverage edge is never counted as a
 * contact. Thirty percent of the extent carries no polygon and it is the high
 * country, so a line running into it would otherwise report a "geological
 * contact" that is nothing but the edge of the DATA — in exactly the terrain
 * where a reader is most likely to be planning a tunnel.
 *
 * The blank is a gap in the digitisation, not in Nepal's geology: DMG printed
 * province sheets over 39 tiles' worth of it. See
 * `checks/geology-vs-dmg-sheets.mjs`, which is where that was measured after
 * the first version of this module told readers the ground was unmapped.
 */
import assert from 'node:assert/strict';
import {
  CONTACT_ERROR_KM,
  GEOLOGY_NO_DATA_SHARE,
  GEOLOGY_UNITS_COUNT,
  GEOLOGY_UNITS_LICENSE,
  GEOLOGY_UNITS_SCALE,
  geologyAlongPath,
  geologySpans,
  geologyUnitAt,
} from '../src/geology-units.ts';

let n = 0;
const ok = (label: string) => {
  n++;
  console.log(`  ok  ${label}`);
};

// ---- the bundle itself ------------------------------------------------------

assert.equal(GEOLOGY_UNITS_SCALE, '1:1,000,000');
assert.equal(GEOLOGY_UNITS_LICENSE, 'CC-BY 4.0');
assert.ok(GEOLOGY_UNITS_COUNT >= 50, `expected ~57 units, got ${GEOLOGY_UNITS_COUNT}`);
ok(`bundle: ${GEOLOGY_UNITS_COUNT} units at ${GEOLOGY_UNITS_SCALE}, ${GEOLOGY_UNITS_LICENSE}`);

// The blank share is a headline the report quotes. If a rebuild moves it far,
// something changed about the source and the prose needs re-reading.
assert.ok(
  GEOLOGY_NO_DATA_SHARE > 0.25 && GEOLOGY_NO_DATA_SHARE < 0.35,
  `no-polygon share ${GEOLOGY_NO_DATA_SHARE} left the 25-35% band the report describes`
);
ok(`no-polygon share ${(GEOLOGY_NO_DATA_SHARE * 100).toFixed(1)}% still matches the prose`);

// ---- three distinguishable answers, never null ------------------------------

const mapped = geologyUnitAt(27.7, 83.9);
assert.equal(mapped.name, 'Lower Siwalik');
assert.equal(mapped.named, true);
assert.equal(mapped.noData, false);
assert.equal(mapped.offSheet, false);
ok('a mapped point names its formation');

const blank = geologyUnitAt(29.1, 81.8);
assert.equal(blank.noData, true);
assert.equal(blank.offSheet, false);
assert.equal(blank.named, false, 'No Data must never read as a named unit');
ok('high country the dataset does not carry returns noData, not null');

const away = geologyUnitAt(28.0, 75.0);
assert.equal(away.offSheet, true);
assert.equal(away.noData, false, 'off-sheet is not the same claim as unmapped');
ok('a point outside Nepal returns offSheet, distinct from noData');

// ---- slivers opened by simplification --------------------------------------

/**
 * These twelve points are inside mapped polygons in the RAW shapefile and fell
 * into no polygon at all once each ring was simplified independently — the
 * pipeline's simplification is not topology-preserving, so a gap opens where
 * two polygons used to share an edge. A 0.02 deg sweep found 68 such points
 * completely ringed by mapped ground, every one of them reporting "outside the
 * national sheet". A site near Chitwan being told it is outside Nepal is a much
 * worse failure than a contact being 200 m out, which is why the module snaps
 * to the nearest polygon within 500 m.
 */
const SLIVERS: [number, number][] = [
  [26.86, 87.26], [26.9, 86.62], [26.98, 86.72], [27.06, 86.36],
  [27.22, 85.48], [27.22, 86.32], [27.26, 87.54], [27.28, 86.02],
  [27.36, 84.92], [27.36, 85.92], [27.42, 84.8], [27.42, 85.62],
];
for (const [lat, lon] of SLIVERS) {
  const h = geologyUnitAt(lat, lon);
  assert.equal(h.offSheet, false, `${lat},${lon} is inside Nepal but reported as outside the sheet`);
}
assert.ok(
  SLIVERS.some(([lat, lon]) => geologyUnitAt(lat, lon).snapped),
  'these points are slivers; at least one must be attributed by the snap rather than containment'
);
ok(`${SLIVERS.length} known simplification slivers all resolve inside Nepal`);

// The snap must not quietly annex the neighbours.
for (const [lat, lon] of [[28, 75], [28, 92], [24, 85], [33, 85]] as [number, number][]) {
  assert.equal(
    geologyUnitAt(lat, lon).offSheet,
    true,
    `${lat},${lon} is far outside Nepal and must stay offSheet`
  );
}
ok('the 500 m snap does not reach points genuinely outside Nepal');

// ---- the Churia traverse ----------------------------------------------------

const churia = [
  { lat: 27.0, lon: 85.88 },
  { lat: 27.0, lon: 86.12 },
];
const t = geologyAlongPath(churia)!;
assert.ok(t, 'the Churia traverse must return a result');

const names = t.runs.map((r) => r.unit.name);
for (const want of ['Lower Siwalik', 'Middle Siwalik', 'Upper Siwalik']) {
  assert.ok(names.includes(want), `expected ${want} along the Churia line, got ${names.join(' -> ')}`);
}
ok(`Churia line reproduces the Siwalik sequence: ${[...new Set(names)].join(' -> ')}`);

assert.ok(t.contacts.length >= 3, `expected 3+ contacts, got ${t.contacts.length}`);
assert.equal(t.coverageEdges, 0, 'the Churia line is fully mapped and must report no coverage edges');
ok(`${t.contacts.length} mapped boundaries counted, 0 coverage edges`);

// The source gives Middle Siwalik, Middle Siwalik1 and Middle Siwalik2 three
// separate codes, and this line walks across two of them. That boundary is
// real but it is a member subdivision, not a change of formation, and quoting
// it as a formation contact overstates the headline.
const internal = t.contacts.filter((c) => c.withinFormation);
assert.ok(
  internal.length >= 1,
  'the Churia line crosses a Middle Siwalik subdivision; it must be recognised as internal'
);
assert.equal(
  t.formationContacts,
  t.contacts.length - internal.length,
  'formationContacts must be every mapped boundary minus the internal subdivisions'
);
assert.ok(t.formationContacts < t.contacts.length, 'the two counts must actually differ here');
ok(
  `${t.formationContacts} formation contacts, ${internal.length} internal subdivision(s): ` +
    internal.map((c) => `${c.from.name}|${c.to.name}`).join(', ')
);

// Every contact must be between two genuinely mapped units. This is the rule
// the whole module exists to keep.
for (const c of t.contacts) {
  assert.ok(!c.from.noData && !c.from.offSheet, 'a contact cannot start on unmapped ground');
  assert.ok(!c.to.noData && !c.to.offSheet, 'a contact cannot end on unmapped ground');
  assert.notEqual(c.from.code, c.to.code, 'a contact between one unit and itself is not a contact');
}
ok('every reported contact is mapped-unit to mapped-unit');

// ---- accounting -------------------------------------------------------------

const summed = t.runs.reduce((a, r) => a + r.lengthKm, 0);
assert.ok(Math.abs(summed - t.lengthKm) < 1e-9, `runs sum to ${summed}, line is ${t.lengthKm}`);
ok('run lengths sum to the line length — no kilometre lost or double-counted');

for (let i = 1; i < t.runs.length; i++) {
  assert.ok(
    Math.abs(t.runs[i].fromKm - t.runs[i - 1].toKm) < 1e-9,
    `gap between run ${i - 1} and ${i}`
  );
}
assert.ok(t.runs.every((r) => r.lengthKm > 0), 'a zero-length run is a bug, not a unit');
ok('runs are contiguous and monotonic in chainage');

assert.ok(t.mappedKm <= t.lengthKm + 1e-9);
assert.ok(Math.abs(t.mappedKm - t.lengthKm) < 1e-9, 'the Churia line is entirely inside the mapping');
ok('mappedKm equals the full length on a fully mapped line');

const spans = geologySpans(t);
const shareSum = spans.reduce((a, s) => a + s.share, 0);
assert.ok(Math.abs(shareSum - 1) < 1e-9, `shares sum to ${shareSum}`);
assert.ok(spans.every((s, i) => i === 0 || spans[i - 1].km >= s.km), 'spans must be longest first');
ok('spans cover the line exactly and sort longest first');

assert.equal(t.intake.name, geologyUnitAt(churia[0].lat, churia[0].lon).name);
assert.equal(t.powerhouse.name, geologyUnitAt(churia[1].lat, churia[1].lon).name);
ok('intake and powerhouse units match a direct query at the endpoints');

// ---- running off the edge of the mapping ------------------------------------

const offEdge = geologyAlongPath([
  { lat: 27.5, lon: 86.7 },
  { lat: 27.5, lon: 86.9 },
])!;
assert.ok(offEdge.coverageEdges >= 1, 'a line running into the blank must report a coverage edge');
assert.ok(
  offEdge.mappedKm < offEdge.lengthKm,
  'a line running into the blank cannot be fully mapped'
);
for (const c of offEdge.contacts) {
  assert.ok(
    !c.from.noData && !c.to.noData,
    'walking off the mapping was counted as a geological contact — the exact failure this module guards'
  );
}
ok(
  `edge of mapping: ${offEdge.coverageEdges} coverage edge(s), ` +
    `${offEdge.contacts.length} contact(s), ${offEdge.mappedKm.toFixed(1)}/${offEdge.lengthKm.toFixed(1)} km mapped`
);

// ---- degenerate input -------------------------------------------------------

assert.equal(geologyAlongPath([]), null);
assert.equal(geologyAlongPath([{ lat: 27, lon: 85 }]), null);
const zero = geologyAlongPath([
  { lat: 27, lon: 85 },
  { lat: 27, lon: 85 },
]);
assert.equal(zero, null, 'a path of zero length has no traverse');
ok('empty, single-point and zero-length paths return null rather than a fake run');

assert.equal(CONTACT_ERROR_KM, 0.5);
ok('contact positional error is stated, not implied');

console.log(`\ngeology-units: ${n} checks passed`);
