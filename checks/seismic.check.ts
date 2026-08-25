/**
 * Seismic screen and PDGL join — checked against published ground truth.
 *
 *   node --experimental-strip-types --no-warnings checks/seismic.check.ts
 */
import assert from 'node:assert/strict';
import { pgaAt, seismicAt, QUAKE_COUNT, quakesGeoJson } from '../src/seismic.ts';
import { PDGL_COUNT, PDGL_MATCHED, glacialLakeInventory } from '../src/glacial-lakes.ts';

// --- PGA: GEM's own published map puts central Nepal around 0.3-0.6 g -------
const ktm = pgaAt(27.7, 85.32);
assert.ok(ktm !== null && ktm > 0.2 && ktm < 0.8, `Kathmandu PGA ${ktm} g out of range`);
// The Terai sits lower than the High Himalaya front.
const terai = pgaAt(26.6, 86.0);
assert.ok(terai !== null && terai < ktm, `Terai ${terai} g should be below Kathmandu ${ktm} g`);
// Off-grid is an honest null, not an extrapolation.
assert.equal(pgaAt(40, 100), null);

// --- catalog: Gorkha 2015 must dominate its own neighbourhood ---------------
assert.ok(QUAKE_COUNT > 1000, `catalog has only ${QUAKE_COUNT} events`);
const gorkha = seismicAt(28.23, 84.73); // published epicentre
assert.ok(gorkha.largest !== null && gorkha.largest.mag >= 7.7 && gorkha.largest.year === 2015,
  `largest near Gorkha epicentre is ${JSON.stringify(gorkha.largest)}`);
assert.ok(gorkha.largest.km < 30, `Gorkha epicentre ${gorkha.largest.km} km off`);
assert.ok(gorkha.within50 > 20, `only ${gorkha.within50} events near Gorkha — aftershocks missing?`);

// Far-west Nepal: the seismic gap has few instrumented events but high hazard.
const west = seismicAt(29.5, 80.9);
assert.ok((west.pgaG ?? 0) > 0.3, `far-west PGA ${west.pgaG} g — the gap should be high hazard`);

const gj = quakesGeoJson();
assert.equal(gj.features.length, QUAKE_COUNT);

// --- PDGL join: the famous four must land on their inventory lakes ----------
assert.equal(PDGL_COUNT, 47);
assert.ok(PDGL_MATCHED >= 35 && PDGL_MATCHED <= 47,
  `${PDGL_MATCHED} flagged lakes for 47 PDGLs — the join must be one-to-one`);
const inv = glacialLakeInventory();
for (const name of ['Tsho Rolpa', 'Imja Tsho', 'Thulagi', 'Lower Barun']) {
  const hit = inv.lakes.find((l) => l.pdgl?.name === name);
  assert.ok(hit, `${name} not matched to any inventory lake`);
  assert.equal(hit.pdgl?.rank, name === 'Chamlang' ? 2 : 1);
}
// Rank counts from the report: 31 / 12 / 4 — matched subsets can be smaller, never larger.
const ranks = [1, 2, 3].map((r) => inv.lakes.filter((l) => l.pdgl?.rank === r).length);
assert.ok(ranks[0] >= 25 && ranks[0] <= 31, `${ranks[0]} Rank I lakes matched of 31`);
assert.ok(ranks[1] <= 12 && ranks[2] <= 4, `rank II/III over-matched: ${ranks[1]}/${ranks[2]}`);

console.log('seismic.check ok');
console.log(`  Kathmandu ${ktm} g · Terai ${terai} g · far-west ${west.pgaG} g`);
console.log(`  ${QUAKE_COUNT} events · Gorkha largest M${gorkha.largest.mag} at ${gorkha.largest.km.toFixed(0)} km, ${gorkha.within50} within 50 km`);
console.log(`  PDGL matched ${PDGL_MATCHED}/47 · ranks I/II/III = ${ranks.join('/')}`);
