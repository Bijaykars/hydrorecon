import assert from 'node:assert/strict';
import { fieldPlanToCsv, schemesToCsv, schemesToGeoJson, type ExportContext } from '../src/export.ts';
import type { Scheme } from '../src/engine/discover.ts';
import type { CascadeScreen } from '../src/cascade.ts';
import { HYDEST_PROVENANCE, type HydestScreen } from '../src/engine/hydest.ts';

let passed = 0;
const ok = (n: string, f: () => void) => { f(); passed++; console.log(`  ok  ${n}`); };

const scheme = (over: Partial<Scheme> = {}): Scheme => ({
  i: 0, j: 10, intake: { lat: 28.1, lon: 84.4 }, power: { lat: 28.0, lon: 84.5 },
  grossHeadM: 200, netHeadM: 190, waterwayKm: 5, flowScale: 1, designFlowCms: 10, residualCms: 0.5,
  capacityMW: 17.7, energyGwh: 90, plantFactor: 0.58, slopeMPerKm: 40, gwhPerKm: 18,
  turbine: 'Francis', turbinePeak: 0.93, reasons: ['most energy'], ...over,
});

const ctx = (over: Partial<ExportContext> = {}): ExportContext => ({
  at: { lat: 28.1, lon: 84.4 }, region: 'nepal', boundaryDistanceKm: 100,
  readiness: {
    region: 'nepal', decision: 'screening', label: 'Test screening',
    gates: [], tasks: [], stopReasons: [],
  },
  hazards: null,
  upstreamConnectivity: null,
  cascade: null,
  faults: null,
  geology: null,
  hydest: null,
  flowChoice: null,
  schemes: [scheme()], selected: null,
  path: Array.from({ length: 11 }, (_, k) => ({ km: k * 0.5, lat: 28.1 - k * 0.01, lon: 84.4 + k * 0.01, elevationM: 1000 - k * 20, meanCms: 12 })),
  demSource: 'Test DEM', demResolutionM: 30, flowYears: 20, flowMeanCms: 12,
  networkMeanCms: null, band: null, tracedFromTerrain: false, evaluated: 500, licences: [], gauges: [], grid: null, sediment: null, measured: null,
  assumptions: { exceedance: 0.4, efficiency: 0.96, headLossFrac: 0.05, residualFrac: 0.1 },
  ...over,
});

const hydest = (): HydestScreen => ({
  input: { totalKm2: 900, below5000Km2: 800, below3000Km2: 600, monsoonMm: 1500 },
  driest: { month: 3, cms: 7.2 },
  months: Array.from({ length: 12 }, (_, month) => ({ month, cms: 8 + month * 3 })),
  modelledCms: 7.8,
  agreement: { ratio: 1.083, agree: true },
  floods: [2, 10, 20, 50, 100, 200, 500].map((t, i) => ({ t, cms: 300 * (i + 1) })),
  provenance: HYDEST_PROVENANCE,
});

const cascade = (): CascadeScreen => ({
  upstream: [{
    name: 'Upper Test HEP', river: 'Test Khola', district: 'Test', capacityMW: 25,
    promoter: 'Test', stage: 'Operating', licenceNo: 'UP-1', issued: '2020-01-01',
    validUntil: null, commissioned: '2024-01-01', lat: 28.2, lon: 84.3,
    bounds: [28.18, 84.28, 28.22, 84.32], source: 'https://doed.gov.np/',
    direction: 'upstream', routeKm: 12.345, snapKm: 0.234,
    snapped: { lat: 28.2, lon: 84.3 }, publishedRangeDiagonalKm: 5.7,
    route: [[84.3, 28.2], [84.4, 28.1]], routeGeometryIncluded: true,
  }],
  downstream: [], directReachRecords: 0, directAdvancedRecords: 0,
  registry: {
    geolocatedRecords: 1169, canonicalRecords: 1167, duplicateRowsCollapsed: 2,
    updated: '2026-08-01', retrieved: '2026-08-13', source: 'https://doed.gov.np/',
  },
  network: {
    source: 'HydroRIVERS', sourceUrl: 'https://www.hydrosheds.org/products/hydrorivers',
    version: '1.0', resolution: '15 arc-seconds', streamThreshold: '10 km2', crs: 'EPSG:4326',
  },
  thresholds: { midpointSnapKm: 2, routeKm: 200, directReachRadiusKm: 6, routeGeometryLimit: 30 },
  method: 'Guarded directed midpoint screen.',
  limitation: 'Candidate only; does not prove shared water, legal overlap or cascade operation.',
  guidance: {
    study: 'https://doed.gov.np/content/35/guidelines-for-study-of-hydropower-projects--2018/',
    optimization: 'https://doed.gov.np/content/32/guideline-for-power-system-optimization-of-hydropower/',
  },
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
    licences: [{
      name: 'Madhya Marsyangdi', river: 'Marsyangdi', district: 'Lamjung', capacityMW: 70,
      promoter: 'NEA', stage: 'Operating', licenceNo: 'X', issued: '2057-03-12',
      validUntil: '2106-01-31', commissioned: '2065-07-16', lat: 28.05, lon: 84.45,
      bounds: [28.0389, 84.405, 28.1972, 84.4475],
      source: 'https://doed.gov.np/pages/powerplantsmorethan1/', distanceKm: 1.2,
    }],
  }));
  assert.ok(csv.includes('WARNING'), 'existing licences must be flagged');
  assert.ok(csv.includes('Madhya Marsyangdi'), 'and named');
});

ok('cascade candidates export topology, official guidance and non-claims without masquerading as conflicts', () => {
  const screen = cascade();
  const csv = schemesToCsv(ctx({ cascade: screen }));
  assert.match(csv, /DIRECTED PROJECT-INTERACTION SCREEN/);
  assert.match(csv, /Upper Test HEP.*candidate upstream.*12\.3 km directed route/);
  assert.match(csv, /does not prove shared water, legal overlap or cascade operation/);
  assert.ok(csv.includes(screen.guidance.study));

  const geo = JSON.parse(schemesToGeoJson(ctx({ cascade: screen })));
  assert.equal(geo.ghatta_cascade.upstreamCandidates, 1);
  assert.equal(geo.ghatta_cascade.registry.canonicalRecords, 1167);
  const candidates = geo.features.filter((feature: any) =>
    feature.geometry.type === 'Point' && /project.*candidate/i.test(feature.properties.part)
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].properties.candidate_direction, 'upstream');
  assert.match(candidates[0].properties.interpretation, /not a confirmed cascade/i);
  assert.ok(geo.features.some((feature: any) => /generalized directed HydroRIVERS route/.test(feature.properties.part)));
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

ok('P90 and both NEA PPA tests survive CSV and GeoJSON export', () => {
  const selected = scheme({
    powerDuration: { p90MW: 4.2, p95MW: 2.8, zeroOutputFraction: 0.03, days: 7305 },
    unitSensitivity: [1, 2, 3, 4].map((units) => ({
      units,
      unitDesignFlowCms: 10 / units,
      turbine: 'Francis' as const,
      capacityMW: 17.7,
      energyGwh: 90 + units,
      plantFactor: 0.58,
      dailyP90MW: 4.2 + units,
      dailyP95MW: 2.8 + units,
      zeroOutputFraction: 0.03 / units,
      days: 7305,
    })),
    reliability: {
      annual: [{ year: 2020, gwh: 82, days: 366, coverage: 1 }],
      p50Gwh: 82,
      p90Gwh: 74,
      worstGwh: 70,
      bestGwh: 96,
      ppaSixSix: { wetGwh: 58, dryGwh: 24, dryShare: 24 / 82, meets: false, grossReferenceValueMillionNpr: 480, blendedBaseRateNprPerKwh: 480 / 82 },
      ppaEightFour: { wetGwh: 67, dryGwh: 15, dryShare: 15 / 82, meets: true, grossReferenceValueMillionNpr: 447.6, blendedBaseRateNprPerKwh: 447.6 / 82 },
    },
  });
  const c = ctx({ schemes: [selected], selected });
  const csv = schemesToCsv(c);
  assert.ok(csv.includes('P90_annual_energy_GWh'));
  assert.ok(csv.includes('daily_P90_hydrological_power_MW'));
  assert.ok(csv.includes('4_unit_daily_P95_MW'));
  assert.ok(csv.includes('NEA_6plus6_meets_30pct'));
  assert.ok(csv.includes('NEA_8plus4_gross_base_rate_reference_million_NPR_per_year'));
  assert.ok(csv.includes('P90: 74.0 GWh/yr'));
  assert.match(csv, /gross published-base-rate reference, 8\+4: NPR 447\.6 million\/year/i);
  assert.match(csv, /not a PPA entitlement, contracted revenue, cash flow, NPV, LCOE or bankability/i);
  assert.match(csv, /PPA_Rates\.pdf/);
  assert.match(csv, /daily power-duration outputs: P90\/P95 across usable record days/i);
  assert.match(csv, /not contractual firm capacity, guaranteed energy or availability/i);
  assert.match(csv, /Equal-rated identical-unit sensitivity/i);
  assert.match(csv, /not a selected unit arrangement.*cost optimum.*firm-capacity result/i);
  const geo = JSON.parse(schemesToGeoJson(c));
  const line = geo.features.find((f: any) => f.properties.part === 'diverted reach');
  assert.equal(line.properties.P90_annual_energy_GWh, 74);
  assert.equal(line.properties.NEA_8plus4_meets_15pct, true);
  assert.equal(line.properties.NEA_8plus4_gross_base_rate_reference_million_NPR_per_year, 447.6);
  assert.equal(line.properties.NEA_8plus4_blended_base_rate_NPR_per_kWh, 5.4585);
  assert.equal(line.properties.daily_P90_hydrological_power_MW, 4.2);
  assert.equal(line.properties.daily_P95_hydrological_power_MW, 2.8);
  assert.equal(line.properties.zero_output_days_fraction, 0.03);
  assert.equal(line.properties.power_duration_basis_days, 7305);
  assert.equal(line.properties.unit_count_sensitivity.length, 4);
  assert.equal(line.properties.unit_count_sensitivity[3].units, 4);
  assert.equal(line.properties.unit_count_sensitivity[3].dailyP95MW, 6.8);
  assert.equal(geo.ghatta_nea_ror_ppa.postedRateCapacityUpToMW, 100);
  assert.match(geo.ghatta_nea_ror_ppa.interpretation, /not a PPA entitlement/i);
  assert.match(geo.ghatta_power_duration.reference, /ESHA 2004.*section 3\.7/i);
  assert.match(geo.ghatta_power_duration.interpretation, /not contractual firm capacity/i);
  assert.deepEqual(geo.ghatta_unit_count_sensitivity.unitCounts, [1, 2, 3, 4]);
  assert.match(geo.ghatta_unit_count_sensitivity.interpretation, /not a selected unit arrangement/i);
});

ok('Nepal environmental-flow policy, selected release and EIA caveat survive every export', () => {
  const selected = scheme();
  const c = ctx({ schemes: [selected], selected });
  const csv = schemesToCsv(c);
  assert.match(csv, /Nepal environmental-release policy floor: at least 10%.*higher EIA-required minimum/i);
  assert.match(csv, /hydropower-development-policy-2058-2001\.pdf/i);
  assert.match(csv, /policy-floor screen, not an approved ecological-flow determination/i);

  const field = fieldPlanToCsv(c);
  assert.match(field, /Environmental-release screen: 10% of lowest monthly mean; EIA-required minimum governs when higher/i);
  assert.match(field, /Policy source: https:\/\/doed\.gov\.np\//i);

  const geo = JSON.parse(schemesToGeoJson(c));
  assert.equal(geo.ghatta_nepal_environmental_flow.minimumFractionOfLowestMonthlyMean, 0.1);
  assert.equal(geo.ghatta_nepal_environmental_flow.selectedFractionOfLowestMonthlyMean, 0.1);
  assert.equal(geo.ghatta_nepal_environmental_flow.selectedReleaseCms, 0.5);
  assert.match(geo.ghatta_nepal_environmental_flow.interpretation, /higher of at least 10%.*EIA-required minimum/i);
  const line = geo.features.find((feature: any) => feature.properties.part === 'diverted reach');
  assert.equal(line.properties.residual_flow_m3s, 0.5);
});

ok('global exports disable Nepal-only context and PPA results', () => {
  const selected = scheme({
    reliability: {
      annual: [{ year: 2020, gwh: 82, days: 366, coverage: 1 }],
      p50Gwh: 82, p90Gwh: 74, worstGwh: 70, bestGwh: 96,
      ppaSixSix: { wetGwh: 58, dryGwh: 24, dryShare: 24 / 82, meets: false, grossReferenceValueMillionNpr: 480, blendedBaseRateNprPerKwh: 480 / 82 },
      ppaEightFour: { wetGwh: 67, dryGwh: 15, dryShare: 15 / 82, meets: true, grossReferenceValueMillionNpr: 447.6, blendedBaseRateNprPerKwh: 447.6 / 82 },
    },
  });
  const global = ctx({
    region: 'global', selected, schemes: [selected],
    readiness: { region: 'global', decision: 'fieldwork', label: 'Global test', gates: [], tasks: [], stopReasons: [] },
  });
  const csv = schemesToCsv(global);
  assert.ok(csv.includes('Nepal-only DoED, DHM, grid, protected-area and PPA rules are disabled'));
  assert.ok(!csv.includes('NEA ROR PPA 6+6 option'));
  const geo = JSON.parse(schemesToGeoJson(global));
  const line = geo.features.find((f: any) => f.properties.part === 'diverted reach');
  assert.equal(line.properties.NEA_8plus4_meets_15pct, null);
  assert.equal(line.properties.NEA_8plus4_gross_base_rate_reference_million_NPR_per_year, null);
  assert.equal(geo.ghatta_nea_ror_ppa, null);
  assert.equal(geo.ghatta_nepal_environmental_flow, null);
});

ok('the field-plan export carries gates, priorities and deliverables', () => {
  const c = ctx({
    readiness: {
      region: 'nepal', decision: 'fieldwork', label: 'Investigate', stopReasons: [],
      gates: [{ id: 'water', title: 'Water & energy yield', level: 'screened', summary: 'Modelled.', evidence: ['20 years.'], next: 'Gauge it.' }],
      tasks: [{ priority: 'P1', discipline: 'Hydrology', title: 'Obtain gauge record', reason: 'Modelled only.', deliverable: 'FDC and floods.' }],
    },
  });
  const csv = fieldPlanToCsv(c);
  assert.ok(csv.includes('field_task,P1,Hydrology,Obtain gauge record'));
  assert.ok(csv.includes('gate,screened'));
  assert.ok(csv.includes('FDC and floods.'));
});

ok('a near-border export cannot silently assert its country mode', () => {
  const csv = schemesToCsv(ctx({ boundaryDistanceKm: 2.4 }));
  assert.ok(csv.includes('border warning: 2.4 km'));
  assert.ok(csv.includes('verify jurisdiction'));
});

ok('BIPAD history and its non-probabilistic meaning survive CSV and GeoJSON', () => {
  const hazards = {
    radiusKm: 15,
    total: 1,
    records: [{
      id: 372, kind: 'landslide' as const, title: 'Landslide', date: '2015-06-12',
      lat: 27.60988, lon: 87.82613, distanceKm: 2.431,
      url: 'https://bipadportal.gov.np/incidents/372/response',
    }],
    categories: [{
      kind: 'landslide' as const, title: 'Landslide', count: 1,
      nationwideRecords: 5771, nearestKm: 2.431, latestDate: '2015-06-12',
    }],
    source: 'https://bipadportal.gov.np/api/v1/incident/',
    fetchedFrom: 'https://dev.bipadportal.gov.np/api/v1/incident/',
    retrieved: '2026-08-13',
    period: { from: '2011-05-14', to: '2026-08-12' },
    crs: 'EPSG:4326',
    limitation: 'Historical reports only; not hazard probability.',
  };
  const c = ctx({ hazards });
  const csv = schemesToCsv(c);
  assert.match(csv, /RECORDED NATURAL HAZARDS/);
  assert.match(csv, /not hazard probability/);
  assert.match(csv, /BIPAD incidents: approved \+ verified records/);

  const geo = JSON.parse(schemesToGeoJson(c));
  assert.equal(geo.ghatta_hazards.total, 1);
  assert.match(geo.ghatta_hazards.limitation, /not hazard probability/);
  const incident = geo.features.find((feature: any) => feature.properties.part === 'BIPAD incident report');
  assert.equal(incident.properties.incident_id, 372);
  assert.equal(incident.properties.verified, true);
  assert.deepEqual(incident.geometry.coordinates, [87.82613, 27.60988]);
});

ok('upstream candidates preserve source flags, route metrics, attribution and non-claims', () => {
  const upstreamConnectivity = {
    target: { lat: 28.1, lon: 84.4, snapKm: 0.04, snapped: { lat: 28.1001, lon: 84.4001 } },
    lakes: [{
      id: 'GLO_84.0416_28.54786', country: 'Nepal' as const, basin: 'Gandaki' as const,
      connectivity: 'Glacier-fed' as const, elevationM: 4721.4,
      expansionRateKm2Yr: 0.0012, expansionUncertaintyKm2Yr: 0.0004,
      expansionSignificant: true, timeSeriesOutlier: false,
      lat: 28.54786, lon: 84.0416, snapKm: 0.21,
      snapped: { lat: 28.548, lon: 84.04 }, routeKm: 47.3,
      route: [[84.04, 28.548], [84.4, 28.1]] as [number, number][], routeGeometryIncluded: true,
    }],
    incidents: [{
      id: 91662, kind: 'landslide' as const, title: 'Landslide', date: '2025-07-08',
      lat: 28.4, lon: 84.2, url: 'https://bipadportal.gov.np/incidents/91662/response',
      snapKm: 0.43, snapped: { lat: 28.4, lon: 84.201 }, routeKm: 21.2,
      route: [] as [number, number][], routeGeometryIncluded: false,
    }],
    lakeInventory: {
      total: 4152, connected: 1, retrieved: '2026-08-13', published: '2025-12-08',
      observations: { from: 2017, to: 2024, sensor: 'Sentinel-2' },
      source: 'https://doi.org/10.5281/zenodo.17802334', license: 'CC BY 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', quality: 'F1=0.92.',
      limitation: 'Mapped lake is not necessarily dangerous.',
    },
    incidentInventory: {
      screened: 9000, connected: 1, retrieved: '2026-08-13',
      period: { from: '2011-05-14', to: '2026-08-12' },
      source: 'https://bipadportal.gov.np/api/v1/incident/',
      limitation: 'Report may be administrative.',
    },
    network: {
      source: 'HydroRIVERS', sourceUrl: 'https://www.hydrosheds.org/products/hydrorivers',
      technicalUrl: 'https://data.hydrosheds.org/file/technical-documentation/HydroRIVERS_TechDoc_v10.pdf',
      version: '1.0', resolution: '15 arc-seconds (about 500 m)',
      streamThreshold: 'at least 10 km2 or 0.1 m3/s', crs: 'EPSG:4326; great-circle route lengths',
    },
    method: 'Points are snapped and walked downstream.',
    limitation: 'Connectivity candidate only—not a breach, GLOF or design-flood model.',
  };
  const c = ctx({ upstreamConnectivity });
  const csv = schemesToCsv(c);
  assert.match(csv, /UPSTREAM CHANNEL-CONNECTIVITY CANDIDATES/);
  assert.match(csv, /GLO_84\.0416_28\.54786/);
  assert.match(csv, /significant positive expansion signals.*1/);
  assert.match(csv, /not a breach, GLOF or design-flood model/);
  assert.match(csv, /CC BY 4\.0/);

  const geo = JSON.parse(schemesToGeoJson(c));
  assert.equal(geo.ghatta_upstream_connectivity.lakeCandidates, 1);
  assert.equal(geo.ghatta_upstream_connectivity.lakeRoutesIncluded, 1);
  assert.equal(geo.ghatta_upstream_connectivity.incidentRoutesIncluded, 0);
  const lake = geo.features.find((feature: any) =>
    feature.properties.part === 'GLO glacial-lake centroid connectivity candidate'
  );
  assert.equal(lake.properties.expansion_significant, true);
  assert.equal(lake.properties.directed_route_to_intake_km, 47.3);
  assert.match(lake.properties.interpretation, /not dangerous-lake classification/i);
  const route = geo.features.find((feature: any) =>
    feature.properties.part === 'generalized directed HydroRIVERS route from lake candidate'
  );
  assert.deepEqual(route.geometry.coordinates.at(-1), [84.4, 28.1]);
  const report = geo.features.find((feature: any) =>
    feature.properties.part === 'upstream-connected BIPAD report candidate'
  );
  assert.equal(report.properties.route_geometry_included, false);
});

ok('fault provenance, share-alike licence and mapped-reach caveat survive every export', () => {
  const hit = {
    id: 'GAF_536', sourceId: 'GAF_536', name: 'Main Frontal Thrust', type: 'Reverse',
    reference: 'Lave and Avouac', points: [[84.0, 28.0], [84.2, 28.0]] as [number, number][],
    distanceKm: 0, intersectsReach: true, chainageKm: 2.7,
    nearestReachPoint: { lat: 28, lon: 84.1 }, nearestFaultPoint: { lat: 28, lon: 84.1 },
  };
  const faults = {
    radiusKm: 50, nearby: [hit], nearest: hit, crossings: 1,
    source: 'GEM Global Active Faults Database',
    sourceUrl: 'https://github.com/GEMScienceTools/gem-global-active-faults',
    commit: '56816508ad92fd6846dad1163b1c8c01376a2cd1', retrieved: '2026-08-13',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://github.com/GEMScienceTools/gem-global-active-faults/blob/master/LICENSE.txt',
    attribution: 'Styron and Pagani (2020)', citation: 'doi:10.1177/8755293020944182',
    crs: 'EPSG:4326', regionalFaultSources: 55,
    limitation: 'Regional trace, not surveyed waterway crossing or seismic design action.',
  };
  const c = ctx({ faults });
  const csv = schemesToCsv(c);
  assert.match(csv, /REGIONAL ACTIVE-FAULT CONTEXT/);
  assert.match(csv, /Main Frontal Thrust.*Reverse/);
  assert.match(csv, /CC BY-SA 4.0/);
  assert.match(csv, /not surveyed waterway crossing or seismic design action/);

  const geo = JSON.parse(schemesToGeoJson(c));
  assert.equal(geo.ghatta_faults.crossings, 1);
  assert.equal(geo.ghatta_faults.commit, faults.commit);
  assert.equal(geo.ghatta_faults.license, 'CC BY-SA 4.0');
  const fault = geo.features.find(
    (feature: any) => feature.properties.part === 'GEM regional active-fault trace'
  );
  assert.equal(fault.properties.source_id, 'GAF_536');
  assert.equal(fault.properties.intersects_selected_mapped_river_reach, true);
  assert.equal(fault.properties.nearest_reach_chainage_km, 2.7);
  assert.deepEqual(fault.geometry.coordinates[0], [84, 28]);
});

ok('geology exports preserve DMG rights, Macrostrat licence and non-claims', () => {
  const geology = {
    dmg: {
      maps: [{
        id: 5,
        title: 'Geological map of Parts of Gorkha and Lamjung Districts (2884-15)',
        published: '2022-01-01',
        previewUrl: 'https://dmgnepal.gov.np/uploads/documents/test.jpg',
        sheets: [{ code: '2884 15', bounds: [84.5, 28, 84.75, 28.25] as [number, number, number, number] }],
      }],
      catalogMaps: 41,
      source: 'Government of Nepal, Department of Mines and Geology (DMG)',
      sourceUrl: 'https://dmgnepal.gov.np/en/resources/geological-maps-150000-4749',
      updated: '2026-08-03', retrieved: '2026-08-13', scale: '1:50,000', crs: 'EPSG:4326',
      rights: 'All Rights Reserved; map images are not bundled.',
      availability: 'Usable maps are hard-copy purchase products.',
      geometryMethod: 'Derived sheet footprint.',
      limitation: 'Publication availability is not site geology.',
    },
    regional: {
      samples: [{
        role: 'intake' as const, lat: 28.1, lon: 84.4,
        units: [{
          mapId: 3189137, sourceId: 154,
          name: 'Precambrian-Phanerozoic sedimentary rocks', lithology: 'sedimentary rocks',
          topInterval: 'Early Paleozoic', bottomInterval: 'Neoproterozoic',
          topAgeMa: 443.8, bottomAgeMa: 1000, color: '#B5B5B5',
        }],
      }],
      references: { 154: 'Chorlton 2007, small-scale world geology map.' },
      source: 'Macrostrat geologic map API', sourceUrl: 'https://macrostrat.org/map/usage',
      license: 'CC-BY 4.0' as const,
      limitation: 'Small-scale regional context; not a surveyed contact or foundation condition.',
    },
    regionalError: null,
  };
  const c = ctx({ geology });
  const csv = schemesToCsv(c);
  assert.match(csv, /ENGINEERING GEOLOGY SOURCES/);
  assert.match(csv, /2884 15/);
  assert.match(csv, /All Rights Reserved/);
  assert.match(csv, /CC-BY 4.0/);
  assert.match(csv, /not a surveyed contact or foundation condition/i);

  const geo = JSON.parse(schemesToGeoJson(c));
  assert.equal(geo.ghatta_geology.dmg.matches, 1);
  assert.equal(geo.ghatta_geology.regional.license, 'CC-BY 4.0');
  const sheet = geo.features.find((feature: any) =>
    feature.properties.part === 'DMG published 1:50,000 geology sheet footprint'
  );
  assert.deepEqual(sheet.geometry.coordinates[0][0], [84.5, 28]);
  assert.match(sheet.properties.interpretation, /not site geology/i);
  const sample = geo.features.find((feature: any) =>
    feature.properties.part === 'Macrostrat regional geology sample'
  );
  assert.equal(sample.properties.original_reference, 'Chorlton 2007, small-scale world geology map.');
  assert.equal(sample.properties.data_licence, 'CC-BY 4.0');
  assert.match(sample.properties.interpretation, /not a surveyed contact/i);
});

ok('regional hydrology exports every input, return period, equation and non-claim', () => {
  const h = hydest();
  const c = ctx({ hydest: h });
  const csv = schemesToCsv(c);
  assert.match(csv, /WECS\/DHM REGIONAL HYDROLOGY SCREEN/);
  assert.match(csv, /total catchment 900\.000 km2.*below 5000 m 800\.000.*below 3000 m 600\.000.*1500 mm/);
  for (const t of [2, 10, 20, 50, 100, 200, 500]) assert.match(csv, new RegExp(`Q${t}=`));
  assert.match(csv, /Q100 = 14\.63/);
  assert.match(csv, /not a selected design flood/i);
  assert.match(csv, /MIT licence does not cover this derivative input/i);
  assert.match(csv, /rainfall source month 06:.*SHA-256 [a-f0-9]{64}/i);
  assert.match(csv, /catchment source: HydroBASINS Asia level 12 v1c.*SHA-256 [a-f0-9]{64}/i);
  assert.match(csv, /hypsometry source: Re:Earth Terrarium elevation tiles/i);
  assert.match(csv, /SHA-256 [a-f0-9]{64}/);

  const field = fieldPlanToCsv(c);
  assert.match(field, /regional comparator: Q100 1500 m3\/s; not a selected design flood/i);
  assert.match(field, /doed\.gov\.np\/content\/31\/design-guidelines-for-headworks/i);

  const geo = JSON.parse(schemesToGeoJson(c));
  assert.equal(geo.ghatta_hydest.input.below3000Km2, 600);
  assert.deepEqual(geo.ghatta_hydest.floods.map((flood: any) => flood.t), [2, 10, 20, 50, 100, 200, 500]);
  assert.match(geo.ghatta_hydest.provenance.interpretation, /not selected design floods/i);
  assert.match(geo.ghatta_hydest.provenance.bundle.output.sha256, /^[a-f0-9]{64}$/);
});

ok('flow provenance names the authority actually used instead of always claiming network flow', () => {
  const flowChoice = {
    authority: 'hydest' as const,
    disagreement: 27.5,
    judgeCms: 10,
    judgeKind: 'annual' as const,
    networkCms: 1.6,
    modelCms: 44,
    targetMeanCms: 10,
    note: 'regional screening fallback',
  };
  const c = ctx({ hydest: hydest(), flowChoice, flowMeanCms: 44, networkMeanCms: 1.6 });
  const csv = schemesToCsv(c);
  assert.match(csv, /provisionally rescaled to the WECS\/DHM regional annual mean \(10\.00 m3\/s\)/i);
  assert.match(csv, /screening fallback, not an observation/i);
  assert.doesNotMatch(csv, /magnitude below is taken from the mapped network/i);
  const geo = JSON.parse(schemesToGeoJson(c));
  assert.equal(geo.ghatta_flow_choice.authority, 'hydest');
  assert.equal(geo.ghatta_flow_choice.targetMeanCms, 10);
});

console.log(`\n${passed} export checks passed\n`);
