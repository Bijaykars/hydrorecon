import assert from 'node:assert/strict';
import { schemesToCsv, schemesToGeoJson, type ExportContext } from '../src/export.ts';
import type { Scheme } from '../src/engine/discover.ts';

let passed = 0;
const ok = (n: string, f: () => void) => { f(); passed++; console.log(`  ok  ${n}`); };

const scheme = (over: Partial<Scheme> = {}): Scheme => ({
  i: 0, j: 10, intake: { lat: 28.1, lon: 84.4 }, power: { lat: 28.0, lon: 84.5 },
  grossHeadM: 200, netHeadM: 190, waterwayKm: 5, designFlowCms: 10, residualCms: 0.5,
  capacityMW: 17.7, energyGwh: 90, plantFactor: 0.58, slopeMPerKm: 40, gwhPerKm: 18,
  turbine: 'Francis', turbinePeak: 0.93, reasons: ['most energy'], ...over,
});

const ctx = (over: Partial<ExportContext> = {}): ExportContext => ({
  at: { lat: 28.1, lon: 84.4 }, schemes: [scheme()], selected: null,
  path: Array.from({ length: 11 }, (_, k) => ({ km: k * 0.5, lat: 28.1 - k * 0.01, lon: 84.4 + k * 0.01, elevationM: 1000 - k * 20, meanCms: 12 })),
  demSource: 'Test DEM', demResolutionM: 30, flowYears: 20, flowMeanCms: 12,
  networkMeanCms: null, band: null, tracedFromTerrain: false, evaluated: 500, licences: [], gauges: [], grid: null,
  assumptions: { exceedance: 0.4, efficiency: 0.96, headLossFrac: 0.05, residualFrac: 0.1 },
  ...over,
});

console.log('\nexport');

ok('a comma in a field cannot shift the columns', () => {
  // The classic silent corruption: an unquoted name would move every value right.
  const csv = schemesToCsv(ctx({ schemes: [scheme({ reasons: ['most energy, shortest waterway'] })] }));
  const rows = csv.split('\n').filter((l) => !l.startsWith('#') && l.trim());
  const header = rows[0].split(',');
  // Count only top-level commas on the data row.
  let depth = 0, cells = 1;
  for (const ch of rows[1]) {
    if (ch === '"') depth ^= 1;
    else if (ch === ',' && !depth) cells++;
  }
  assert.equal(cells, header.length, `${cells} cells vs ${header.length} columns`);
  assert.ok(rows[1].includes('"most energy, shortest waterway"'), 'field must be quoted');
});

ok('a quote inside a field is doubled, not left to break the row', () => {
  const csv = schemesToCsv(ctx({ schemes: [scheme({ reasons: ['the "best" option'] })] }));
  assert.ok(csv.includes('"the ""best"" option"'), 'quotes must be escaped by doubling');
});

ok('every row carries provenance and the screening warning', () => {
  const csv = schemesToCsv(ctx());
  assert.ok(/^#/.test(csv), 'must open with a comment header');
  assert.ok(csv.includes('NOT A FEASIBILITY STUDY'), 'must state what it is not');
  assert.ok(csv.includes('GloFAS'), 'must name the flow source');
  assert.ok(csv.includes('HydroGenerate'), 'must credit the turbine correlations');
});

ok('a licence conflict is shouted, not buried', () => {
  const csv = schemesToCsv(ctx({
    licences: [{ name: 'Madhya Marsyangdi', river: 'Marsyangdi', district: 'Lamjung', capacityMW: 70, promoter: 'NEA', stage: 'Operation', licenceNo: 'X', lat: 28.05, lon: 84.45, distanceKm: 1.2 }],
  }));
  assert.ok(csv.includes('WARNING'), 'existing licences must be flagged');
  assert.ok(csv.includes('Madhya Marsyangdi'), 'and named');
});

ok('GeoJSON is valid and geometry-complete', () => {
  const j = JSON.parse(schemesToGeoJson(ctx()));
  assert.equal(j.type, 'FeatureCollection');
  assert.ok(Array.isArray(j.ghatta) && j.ghatta.length > 10, 'provenance must ride along');
  const parts = j.features.map((f: any) => f.properties.part).sort();
  assert.deepEqual(parts, ['diverted reach', 'intake', 'powerhouse']);
  for (const f of j.features) {
    assert.ok(f.geometry?.coordinates, 'every feature needs geometry');
  }
  const line = j.features.find((f: any) => f.properties.part === 'diverted reach');
  assert.equal(line.geometry.coordinates.length, 11, 'reach must span i..j inclusive');
  // lon, lat, elevation — in that order, which is what GIS expects.
  assert.equal(line.geometry.coordinates[0][0], 84.4);
  assert.equal(line.geometry.coordinates[0][1], 28.1);
});

console.log(`\n${passed} export checks passed\n`);
