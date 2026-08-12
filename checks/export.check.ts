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
  networkMeanCms: null, band: null, tracedFromTerrain: false, evaluated: 500, licences: [], gauges: [], grid: null, sediment: null, measured: null,
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


ok('an export built on a gauge record never claims its flow came from a model', () => {
  const csv = schemesToCsv(
    ctx({
      measured: {
        name: 'DHM_16836.csv',
        values: 1824,
        from: '2015-01-01',
        to: '2019-12-31',
        ratio: 0.996,
        notes: ['1 no-data markers dropped, not read as zero.'],
      },
    })
  );
  assert.ok(csv.includes('flow: MEASURED'), 'a measured record must be stated as measured');
  assert.ok(!csv.includes('GloFAS'), 'must not also credit the model it replaced');
  assert.ok(csv.includes('DHM_16836.csv'), 'the source file must be named');
  assert.ok(csv.includes('scaled 0.996x'), 'any transfer applied must be on the record');
  assert.ok(csv.includes('no-data markers dropped'), "the parser's own caveats must travel too");
  // And the default path still credits the model correctly.
  assert.ok(schemesToCsv(ctx({})).includes('GloFAS'), 'modelled runs still name their source');
});

ok('the sediment finding travels with the file, warning included', () => {
  // A "no room for the basin" finding is one of the few things in this file that
  // could change a go/no-go, so it must survive the export rather than living
  // only on screen. It has to be legible without the app open.
  const csv = schemesToCsv(
    ctx({
      sediment: {
        source: { highFrac: 0.83, label: 'glacier-fed — the hardest case', note: 'quartz-rich.' },
        bench: { widestM: 12, side: 'left', liftM: 3, verdict: 'no-room', resolutionM: 30 },
      },
    })
  );
  assert.ok(csv.includes('SEDIMENT:'), 'no sediment section in the provenance header');
  assert.ok(csv.includes('glacier-fed'), 'the catchment finding must be named');
  assert.ok(csv.includes('NO ROOM'), 'a no-room finding must be stated, not softened');
  assert.match(csv, /not measured/, 'the file must not imply the load was measured');

  // Per-scheme basin sizes are columns, and every row must carry one.
  const rows = csv.split('\n').filter((l) => !l.startsWith('#') && l.trim());
  const header = rows[0].split(',');
  const at = (name: string) => rows[1].split(',')[header.indexOf(name)];
  assert.ok(header.includes('desander_length_m'), 'basin size must be a column');
  assert.equal(at('desander_target_mm'), '0.20', '190 m net head calls for 0.2 mm removal');
  assert.ok(Number(at('desander_length_m')) > 20, `basin length came out ${at('desander_length_m')}`);
  assert.ok(Number(at('desander_bench_needed_m')) > 0, 'bench requirement must be exported');
});

console.log(`\n${passed} export checks passed\n`);
