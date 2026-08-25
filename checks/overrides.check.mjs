/**
 * What does the manual override table actually change?
 *
 *   node --experimental-strip-types --no-warnings checks/overrides.check.mjs
 *
 * The point of reporting this separately is that a hand-edited input is a thumb
 * on the scale, and a thumb nobody measures becomes a thumb nobody remembers.
 * Every entry has to earn its place by showing what it moved and by how much.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, i) => {
  const p = String(u).replace(/^undefined/, '').replace(/^\//, '');
  if (/^[\w.-]+\.(json|dat|bin)$/.test(p)) {
    try { return new Response(readFileSync(`public/${p}`), { status: 200 }); }
    catch { return new Response(null, { status: 404 }); }
  }
  return realFetch(String(u), i);
};

const { nearestReach, reachToRead } = await import('../src/rivers.ts');
const { areaOverrideAt, setOverridesEnabled, allAreaOverrides } = await import('../src/overrides.ts');

// The lookup itself: inside the radius it hits, outside it misses.
const first = allAreaOverrides()[0];
assert.ok(areaOverrideAt(first.lat, first.lon), 'override must match at its own point');
assert.equal(
  areaOverrideAt(first.lat + (first.radiusKm * 2) / 111.32, first.lon),
  null,
  'override must not match beyond its radius'
);
setOverridesEnabled(false);
assert.equal(areaOverrideAt(first.lat, first.lon), null, 'disabled table must match nothing');
setOverridesEnabled(true);

console.log(`\n${allAreaOverrides().length} sourced override(s)\n`);
console.log(`${'entry'.padEnd(30)}${'inferred'.padStart(10)}${'pinned'.padStart(9)}${'change'.padStart(9)}`);
for (const r of allAreaOverrides()) {
  setOverridesEnabled(false);
  const off = await nearestReach(r.lat, r.lon).catch(() => null);
  setOverridesEnabled(true);
  const on = await nearestReach(r.lat, r.lon).catch(() => null);
  if (!off || !on) {
    console.log(`  ${r.name.padEnd(28)}  no reach within snapping range`);
    continue;
  }
  // Compare what the app READS, which is the promoted reach where the snapping
  // rule fired, not the raw nearest centreline.
  const a = reachToRead(off).reach.uplandKm2;
  const read = reachToRead(on).reach;
  const b = read.uplandKm2;
  assert.equal(read.areaSource, 'override', 'a covered point must report its provenance');
  console.log(
    `${r.name.slice(0, 29).padEnd(30)}${a.toFixed(0).padStart(10)}${b.toFixed(0).padStart(9)}${(b / a).toFixed(2).padStart(8)}x`
  );
}
console.log('\noverrides.check ok');
