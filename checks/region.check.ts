import assert from 'node:assert/strict';
import {
  distanceToNepalBoundaryKm,
  inNepal,
  NEPAL_BOUNDARY_SOURCE,
  regionFor,
} from '../src/region.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

console.log('\ncountry scope');

ok('known Nepal hydropower regions are inside the country polygon', () => {
  for (const [name, lat, lon] of [
    ['Kathmandu', 27.7172, 85.324],
    ['Marsyangdi', 28.2, 84.3],
    ['Tamakoshi', 27.7, 86.0],
    ['Karnali', 29.2, 81.2],
  ] as const) {
    assert.equal(inNepal(lat, lon), true, `${name} classified outside Nepal`);
  }
});

ok('nearby foreign sites do not receive Nepal rules', () => {
  for (const [name, lat, lon] of [
    ['Delhi', 28.61, 77.21],
    ['Lhasa', 29.65, 91.1],
    ['Thimphu', 27.47, 89.64],
    ['Sikkim', 27.32, 88.61],
  ] as const) {
    assert.equal(regionFor(lat, lon), 'global', `${name} classified as Nepal`);
  }
});

ok('invalid positions fail closed to global mode', () => {
  assert.equal(inNepal(NaN, 84), false);
  assert.equal(inNepal(28, Infinity), false);
});

ok('border proximity distinguishes an outline point from inland Nepal', () => {
  assert.ok(distanceToNepalBoundaryKm(27.8706, 88.10977) < 0.01);
  assert.ok(distanceToNepalBoundaryKm(27.7172, 85.324) > 10);
});

ok('the boundary carries a reproducible public-domain source', () => {
  assert.match(NEPAL_BOUNDARY_SOURCE, /Natural Earth/);
  assert.match(NEPAL_BOUNDARY_SOURCE, /public domain/);
  assert.match(NEPAL_BOUNDARY_SOURCE, /2026-08-13/);
});

console.log(`\n${passed} country-scope checks passed\n`);
