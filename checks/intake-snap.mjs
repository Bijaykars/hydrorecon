/**
 * Is the intake even on the right river?
 *
 *   node --experimental-strip-types --no-warnings checks/intake-snap.mjs
 *
 * Two of the ten built plants come out at roughly 1/200th of their real
 * capacity, and both turn out to have nothing wrong with their hydrology: the
 * intake snapped to a tributary running beside the river rather than to the
 * river. Upper Tamakoshi's headworks land on an 8 km2 channel where the plant
 * itself abstracts 66 m3/s, which is 8 m3/s per square kilometre — about thirty
 * times anything Nepal produces.
 *
 * nearestReach already computes a `mainStem` alternative for exactly this case.
 * This measures whether taking it would help or hurt, per plant, rather than
 * arguing about it.
 */
import { readFileSync } from 'node:fs';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u);
  if (p.startsWith('/')) return new Response(readFileSync(`public${p}`), { status: 200 });
  return realFetch(p, i);
};

const { nearestReach } = await import('../src/rivers.ts');
const validation = JSON.parse(readFileSync('src/data/validation.json', 'utf8'));

/** Nepal's rivers run 0.005-0.25 m3/s per km2. Outside that, something is wrong. */
const SPECIFIC_MAX = 0.25;

console.log('\nINTAKE SNAPPING at the ten built plants\n');
const hdr =
  `${'plant'.padEnd(20)}${'Q act'.padStart(7)}${'A near'.padStart(8)}${'q/A'.padStart(8)}` +
  `${'A main'.padStart(8)}${'q/A'.padStart(8)}${'dist'.padStart(7)}  verdict`;
console.log(hdr);
console.log('-'.repeat(hdr.length + 22));

let broken = 0;
let fixable = 0;
for (const plant of validation.plants) {
  const [lat, lon] = plant.intake;
  const q = plant.actual?.designQ;
  const hit = await nearestReach(lat, lon).catch(() => null);
  if (!hit) continue;
  const near = hit.nearest;
  const main = hit.mainStem ?? null;

  const sNear = q && near.uplandKm2 > 0 ? q / near.uplandKm2 : null;
  const sMain = q && main && main.uplandKm2 > 0 ? q / main.uplandKm2 : null;
  const bad = sNear != null && sNear > SPECIFIC_MAX;
  if (bad) broken++;
  const helps = bad && sMain != null && sMain <= SPECIFIC_MAX;
  if (helps) fixable++;

  const verdict = !q
    ? 'no published design flow'
    : bad
      ? helps
        ? 'MIS-SNAPPED — main stem fixes it'
        : main
          ? 'MIS-SNAPPED — main stem also too small'
          : 'MIS-SNAPPED — no main-stem alternative offered'
      : 'ok';

  console.log(
    `${plant.name.padEnd(20)}${(q ?? 0).toFixed(1).padStart(7)}` +
      `${near.uplandKm2.toFixed(0).padStart(8)}${(sNear ?? 0).toFixed(3).padStart(8)}` +
      `${(main ? main.uplandKm2.toFixed(0) : '—').padStart(8)}` +
      `${(sMain != null ? sMain.toFixed(3) : '—').padStart(8)}` +
      `${near.distanceKm.toFixed(2).padStart(7)}  ${verdict}`
  );
}
console.log(
  `\n${broken} of the ten intakes snap to a channel that cannot carry the plant's own design flow.`
);
console.log(`${fixable} of those would be fixed by taking the main stem instead.`);
console.log(
  '\nThe app deliberately uses the NEAREST reach, so a click means the channel' +
    '\nclicked on. Right for a user placing an intake by hand; wrong for a' +
    '\npublished coordinate landing a few metres off a big river centreline.'
);
