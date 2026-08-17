import assert from 'node:assert/strict';
import raw from '../src/data/nepal-geology-maps.json' with { type: 'json' };
import {
  DMG_MAP_COUNT,
  fetchRegionalGeology,
  geologyMapsFor,
  reachIntersectsSheet,
} from '../src/geology.ts';

let passed = 0;
const ok = async (name: string, test: () => void | Promise<void>) => {
  await test();
  passed += 1;
  console.log(`  ok ${name}`);
};

console.log('\nengineering geology sources');

await ok('official DMG catalog is exact, current and stores links rather than imagery', () => {
  assert.equal(DMG_MAP_COUNT, 41);
  assert.equal(raw.maps.length, 41);
  assert.equal(raw._sourceUpdated, '2026-08-03');
  assert.equal(raw._scale, '1:50,000');
  assert.match(raw._rights, /All Rights Reserved/i);
  assert.match(raw._availability, /hard-copy purchase/i);
  assert.ok(raw.maps.every((map) => map.previewUrl.startsWith('https://dmgnepal.gov.np/')));
  assert.ok(!JSON.stringify(raw).includes('data:image'));
});

await ok('modern and legacy sheet footprints match known Nepal places', () => {
  const bounds = (id: number) => raw.maps.find((map) => map.id === id)?.sheets[0].bounds;
  assert.deepEqual(bounds(4), [85.25, 27.75, 85.5, 28]); // Kathmandu/Nuwakot
  assert.deepEqual(bounds(5), [84.5, 28, 84.75, 28.25]); // Gorkha/Lamjung
  assert.deepEqual(bounds(21), [85, 27.5, 85.25, 27.75]); // Kathmandu/Lalitpur
  assert.deepEqual(bounds(31), [83.75, 28.25, 84, 28.5]); // Kaski/Parbat
  assert.deepEqual(bounds(35), [83.25, 27.75, 83.5, 28]); // Palpa/Gulmi
  assert.deepEqual(bounds(41), [84, 28, 84.25, 28.25]); // Tanahun/Kaski
});

await ok('every derived footprint remains in the Nepal regional window', () => {
  for (const map of raw.maps) {
    for (const sheet of map.sheets) {
      const [west, south, east, north] = sheet.bounds;
      assert.ok(west >= 79 && east <= 89, `${sheet.code} longitude`);
      assert.ok(south >= 26 && north <= 31, `${sheet.code} latitude`);
      assert.ok(west < east && south < north, `${sheet.code} ordered bounds`);
    }
  }
});

await ok('reach matching includes points, crossings and a segment on a sheet edge', () => {
  const bounds: [number, number, number, number] = [85.25, 27.75, 85.5, 28];
  assert.equal(reachIntersectsSheet([{ lat: 27.9, lon: 85.4 }], bounds), true);
  assert.equal(
    reachIntersectsSheet([{ lat: 27.9, lon: 85.1 }, { lat: 27.9, lon: 85.6 }], bounds),
    true
  );
  assert.equal(
    reachIntersectsSheet([{ lat: 28, lon: 85.3 }, { lat: 28, lon: 85.45 }], bounds),
    true
  );
  assert.equal(reachIntersectsSheet([{ lat: 28.2, lon: 85.4 }], bounds), false);
});

await ok('DMG result names only publications touched by the reach', () => {
  const hit = geologyMapsFor([{ lat: 27.9, lon: 85.3 }]);
  assert.ok(hit.maps.some((map) => map.id === 4));
  assert.ok(hit.maps.every((map) => map.sheets.length > 0));
  assert.match(hit.availability, /digital versions cannot/i);
  const miss = geologyMapsFor([{ lat: 29.9, lon: 82 }]);
  assert.equal(miss.maps.length, 0);
  assert.match(miss.limitation, /catalog no-match, not an absence of geology/i);
});

await ok('Macrostrat parsing preserves three sampled roles, licence and original references', async () => {
  const calls: string[] = [];
  const mock = async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: {
          license: 'CC-BY 4.0',
          data: [{
            map_id: 3189137,
            source_id: 154,
            name: 'Precambrian-Phanerozoic sedimentary rocks',
            lith: 'sedimentary rocks',
            t_int_name: 'Early Paleozoic',
            b_int_name: 'Neoproterozoic',
            t_age: 443.8,
            b_age: 1000,
            color: '#B5B5B5',
          }],
          refs: { 154: 'Chorlton 2007, small-scale world geology map.' },
        },
      }),
    };
  };
  const result = await fetchRegionalGeology(
    [{ lat: 28.3, lon: 84.3 }, { lat: 28.2, lon: 84.4 }, { lat: 28.1, lon: 84.5 }],
    undefined,
    mock
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(result.samples.map((sample) => sample.role), ['intake', 'mid-reach', 'powerhouse']);
  assert.equal(result.samples[1].units[0].sourceId, 154);
  assert.equal(result.references['154'], 'Chorlton 2007, small-scale world geology map.');
  assert.equal(result.license, 'CC-BY 4.0');
  assert.match(result.limitation, /cannot establish site lithology/i);
});

await ok('regional geology refuses an unverified response licence', async () => {
  const mock = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: { license: 'unknown', data: [], refs: {} } }),
  });
  await assert.rejects(
    fetchRegionalGeology([{ lat: 28, lon: 84 }], undefined, mock),
    /licence is missing or changed/i
  );
});

console.log(`\n${passed} geology checks passed\n`);
