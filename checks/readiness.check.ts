import assert from 'node:assert/strict';
import type { Licence } from '../src/context.ts';
import type { Scheme } from '../src/engine/discover.ts';
import type { HazardScreen } from '../src/hazards.ts';
import type { FaultScreen } from '../src/faults.ts';
import type { UpstreamConnectivityScreen } from '../src/connectivity.ts';
import type { CascadeDirection, CascadeProject, CascadeScreen } from '../src/cascade.ts';
import { geologyMapsFor, type GeologyScreen } from '../src/geology.ts';
import { assessReadiness, type ReadinessInput } from '../src/readiness.ts';
import { HYDEST_PROVENANCE, type HydestScreen } from '../src/engine/hydest.ts';

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

const scheme: Scheme = {
  i: 0,
  j: 10,
  intake: { lat: 28.1, lon: 84.4 },
  power: { lat: 28.0, lon: 84.5 },
  grossHeadM: 200,
  netHeadM: 190,
  waterwayKm: 5,
  flowScale: 1,
  designFlowCms: 10,
  residualCms: 0.5,
  capacityMW: 17.7,
  energyGwh: 90,
  plantFactor: 0.58,
  slopeMPerKm: 40,
  gwhPerKm: 18,
  turbine: 'Francis',
  turbinePeak: 0.93,
  reasons: ['most energy'],
};

const hydest = (over: Partial<HydestScreen> = {}): HydestScreen => ({
  input: { totalKm2: 900, below5000Km2: 800, below3000Km2: 600, monsoonMm: 1500 },
  driest: { month: 3, cms: 7.2 },
  months: [{ month: 3, cms: 7.2 }],
  modelledCms: 7.8,
  agreement: { ratio: 1.2, agree: true },
  floods: [{ t: 100, cms: 1250 }],
  provenance: HYDEST_PROVENANCE,
  ...over,
});

const base = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  region: 'nepal',
  borderKm: 100,
  scheme,
  flowYears: 20,
  measured: false,
  flowChoice: {
    authority: 'network', disagreement: 1.4, judgeCms: 5, judgeKind: 'dry-season',
    networkCms: 5.2, modelCms: 4.8, note: 'agree',
  },
  hydest: hydest(),
  residualFraction: 0.1,
  headAudit: null,
  auditYears: null,
  licences: [],
  gauges: [],
  grid: { nearestKm: 2, nearestKv: 66, adequateKm: 4, adequateKv: 66, requiredKv: 66, nearestSub: null },
  hazards: null,
  upstreamConnectivity: null,
  cascade: null,
  faults: null,
  geology: null,
  conservation: null,
  sediment: { source: { highFrac: 0.6, label: 'snow and glacier influenced', note: 'screening proxy' } },
  bench: { widestM: 30, side: 'left', liftM: 3, verdict: 'fits', resolutionM: 30 },
  ...over,
});

const cascadeProject = (direction: CascadeDirection): CascadeProject => ({
  name: direction === 'upstream' ? 'Upper Test HEP' : 'Lower Test HEP',
  river: 'Test Khola',
  district: 'Test',
  capacityMW: 25,
  promoter: 'Test',
  stage: 'Operating',
  licenceNo: direction === 'upstream' ? 'UP-1' : 'DOWN-1',
  issued: '2020-01-01',
  validUntil: null,
  commissioned: '2024-01-01',
  lat: 28,
  lon: 84,
  bounds: [27.99, 83.99, 28.01, 84.01],
  source: 'https://doed.gov.np/',
  direction,
  routeKm: 12,
  snapKm: 0.2,
  snapped: { lat: 28, lon: 84 },
  publishedRangeDiagonalKm: 3,
  route: [[84, 28], [84.01, 27.99]],
  routeGeometryIncluded: true,
});

const cascadeScreen = (direction: CascadeDirection): CascadeScreen => ({
  upstream: direction === 'upstream' ? [cascadeProject(direction)] : [],
  downstream: direction === 'downstream' ? [cascadeProject(direction)] : [],
  directReachRecords: 0,
  directAdvancedRecords: 0,
  registry: {
    geolocatedRecords: 1169,
    canonicalRecords: 1168,
    duplicateRowsCollapsed: 1,
    updated: '2026-08-01',
    retrieved: '2026-08-13',
    source: 'https://doed.gov.np/',
  },
  network: {
    source: 'HydroRIVERS',
    sourceUrl: 'https://www.hydrosheds.org/products/hydrorivers',
    version: '1.0',
    resolution: '15 arc-seconds',
    streamThreshold: '10 km2',
    crs: 'EPSG:4326',
  },
  thresholds: { midpointSnapKm: 2, routeKm: 200, directReachRadiusKm: 6, routeGeometryLimit: 30 },
  method: 'Guarded directed midpoint screen.',
  limitation: 'Candidate only; does not prove shared water, legal overlap or cascade operation.',
  guidance: { study: 'https://doed.gov.np/study', optimization: 'https://doed.gov.np/optimization' },
});

console.log('\nengineering readiness');

ok('a promising desktop result still requires fieldwork, never design approval', () => {
  const r = assessReadiness(base());
  assert.equal(r.decision, 'fieldwork');
  assert.equal(r.gates.length, 8);
  assert.equal(r.gates.find((g) => g.id === 'water')?.level, 'corroborated');
  assert.equal(r.gates.find((g) => g.id === 'economics')?.level, 'not-assessed');
  assert.ok(r.tasks.some((t) => t.discipline === 'Engineering geology & hazards' && t.priority === 'P1'));
});

ok('an imported gauge record advances water evidence to measured', () => {
  const r = assessReadiness(base({ measured: true }));
  assert.equal(r.gates.find((g) => g.id === 'water')?.level, 'measured');
  assert.ok(!r.tasks.some((t) => t.discipline === 'Hydrology'), 'do not ask for the record already supplied');
});

ok('a hard protected-area intersection holds the layout', () => {
  const r = assessReadiness(base({
    conservation: { inside: [{ name: 'National Park', nearEdge: false }], near: [], hard: true },
  }));
  assert.equal(r.decision, 'hold');
  assert.equal(r.gates.find((g) => g.id === 'legal-environment')?.level, 'stop');
  assert.match(r.stopReasons.join(' '), /protected/i);
});

ok('an operating DoED project conflict holds the layout', () => {
  const licence: Licence = {
    name: 'Existing project', river: 'Test', district: 'Test', capacityMW: 10,
    promoter: 'Test', stage: 'Operating', licenceNo: '1', issued: '2000-01-01',
    validUntil: null, commissioned: null, lat: 28.1, lon: 84.4,
    bounds: [28, 84.3, 28.2, 84.5], source: 'DoED', distanceKm: 0,
  };
  const r = assessReadiness(base({ licences: [licence] }));
  assert.equal(r.decision, 'hold');
  assert.match(r.gates.find((g) => g.id === 'legal-environment')?.summary ?? '', /operating\/construction/);
});

ok('an upstream operating-project candidate weakens flow, operations and legal evidence without creating a false stop', () => {
  const r = assessReadiness(base({ cascade: cascadeScreen('upstream') }));
  assert.equal(r.decision, 'fieldwork');
  assert.deepEqual(r.stopReasons, []);
  assert.equal(r.gates.find((g) => g.id === 'water')?.level, 'weak');
  assert.equal(r.gates.find((g) => g.id === 'equipment-operations')?.level, 'weak');
  assert.equal(r.gates.find((g) => g.id === 'legal-environment')?.level, 'weak');
  assert.ok(r.tasks.some((t) => t.discipline === 'Hydrology' && /operating releases/i.test(t.reason)));
  assert.ok(r.tasks.some((t) => t.discipline === 'Electro-mechanical & operations' && t.priority === 'P1'));
});

ok('a downstream operating-project candidate opens release and transient interfaces but does not corrupt upstream inflow evidence', () => {
  const r = assessReadiness(base({ cascade: cascadeScreen('downstream') }));
  assert.equal(r.gates.find((g) => g.id === 'water')?.level, 'corroborated');
  assert.equal(r.gates.find((g) => g.id === 'equipment-operations')?.level, 'weak');
  assert.equal(r.gates.find((g) => g.id === 'legal-environment')?.level, 'weak');
  assert.match(r.gates.find((g) => g.id === 'equipment-operations')?.summary ?? '', /upstream\/downstream operating/i);
});

ok('a desander that cannot fit stops the current intake layout', () => {
  const r = assessReadiness(base({
    bench: { widestM: 9, side: 'right', liftM: 2, verdict: 'no-room', resolutionM: 30 },
  }));
  assert.equal(r.decision, 'hold');
  assert.equal(r.gates.find((g) => g.id === 'sediment-headworks')?.level, 'stop');
  assert.ok(r.tasks.some((t) => t.title === 'Relocate the intake and desander' && t.priority === 'P1'));
});

ok('global mode never imports Nepal legal or grid conclusions', () => {
  const r = assessReadiness(base({ region: 'global', licences: [], grid: null }));
  assert.equal(r.gates.find((g) => g.id === 'grid')?.level, 'not-assessed');
  assert.equal(r.gates.find((g) => g.id === 'legal-environment')?.level, 'not-assessed');
  assert.match(r.gates.find((g) => g.id === 'grid')?.summary ?? '', /Nepal grid bundle is disabled/);
});

const hazardScreen = (total = 2): HazardScreen => ({
  radiusKm: 15,
  total,
  records: total
    ? [{
        id: 372, kind: 'landslide', title: 'Landslide', date: '2015-06-12',
        lat: 27.60988, lon: 87.82613, distanceKm: 2.4,
        url: 'https://bipadportal.gov.np/incidents/372/response',
      }]
    : [],
  categories: [
    { kind: 'landslide', title: 'Landslide', count: total, nationwideRecords: 5771, nearestKm: total ? 2.4 : null, latestDate: total ? '2015-06-12' : null },
    { kind: 'flood', title: 'Flood', count: 0, nationwideRecords: 2952, nearestKm: null, latestDate: null },
  ],
  source: 'https://bipadportal.gov.np/api/v1/incident/',
  fetchedFrom: 'https://dev.bipadportal.gov.np/api/v1/incident/',
  retrieved: '2026-08-13',
  period: { from: '2011-05-14', to: '2026-08-12' },
  crs: 'EPSG:4326',
  limitation: 'Reports are not probabilities.',
});

const upstreamScreen = (lakeCount = 1, incidentCount = 1): UpstreamConnectivityScreen => ({
  target: { lat: 28.1, lon: 84.4, snapKm: 0.03, snapped: { lat: 28.1, lon: 84.4 } },
  lakes: lakeCount ? [{
    id: 'GLO_84.0416_28.54786', country: 'Nepal', basin: 'Gandaki', connectivity: 'Glacier-fed',
    elevationM: 4721, expansionRateKm2Yr: 0.0012, expansionUncertaintyKm2Yr: 0.0004,
    expansionSignificant: true, timeSeriesOutlier: false, lat: 28.54786, lon: 84.0416,
    snapKm: 0.2, snapped: { lat: 28.548, lon: 84.04 }, routeKm: 47,
    route: [[84.04, 28.548], [84.4, 28.1]], routeGeometryIncluded: true,
  }] : [],
  incidents: incidentCount ? [{
    id: 91662, kind: 'landslide', title: 'Landslide', date: '2025-07-08',
    lat: 28.4, lon: 84.2, url: 'https://bipadportal.gov.np/incidents/91662/response',
    snapKm: 0.4, snapped: { lat: 28.4, lon: 84.201 }, routeKm: 21,
    route: [], routeGeometryIncluded: false,
  }] : [],
  lakeInventory: {
    total: 4152, connected: lakeCount, retrieved: '2026-08-13', published: '2025-12-08',
    observations: { from: 2017, to: 2024, sensor: 'Sentinel-2' },
    source: 'https://doi.org/10.5281/zenodo.17802334', license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', quality: 'F1=0.92',
    limitation: 'Not a dangerous-lake classification.',
  },
  incidentInventory: {
    screened: 9000, connected: incidentCount, retrieved: '2026-08-13',
    period: { from: '2011-05-14', to: '2026-08-12' },
    source: 'https://bipadportal.gov.np/api/v1/incident/', limitation: 'Report points.',
  },
  network: {
    source: 'HydroRIVERS', sourceUrl: 'https://www.hydrosheds.org/products/hydrorivers',
    technicalUrl: 'https://data.hydrosheds.org/file/technical-documentation/HydroRIVERS_TechDoc_v10.pdf',
    version: '1.0', resolution: 'about 500 m', streamThreshold: '10 km2 or 0.1 m3/s',
    crs: 'EPSG:4326; great-circle route lengths',
  },
  method: 'Centroids and reports are snapped and walked downstream.',
  limitation: 'Connectivity candidate only—not susceptibility, breach, GLOF or design flood. A centroid/report snap can cross a drainage divide, and HydroRIVERS omits smaller streams.',
});

const faultScreen = (intersectsReach = true): FaultScreen => {
  const hit = {
    id: 'GAF_536', sourceId: 'GAF_536', name: 'Main Frontal Thrust', type: 'Reverse',
    reference: 'Lave and Avouac', points: [[84, 28], [84.2, 28]] as [number, number][],
    distanceKm: intersectsReach ? 0 : 12.4, intersectsReach, chainageKm: 2.7,
    nearestReachPoint: { lat: 28, lon: 84.1 }, nearestFaultPoint: { lat: 28, lon: 84.1 },
  };
  return {
    radiusKm: 50, nearby: [hit], nearest: hit, crossings: intersectsReach ? 1 : 0,
    source: 'GEM Global Active Faults Database',
    sourceUrl: 'https://github.com/GEMScienceTools/gem-global-active-faults',
    commit: '56816508ad92fd6846dad1163b1c8c01376a2cd1', retrieved: '2026-08-13',
    license: 'CC BY-SA 4.0', licenseUrl: 'https://example.test/license',
    attribution: 'Styron and Pagani 2020', citation: 'doi:10.1177/8755293020944182',
    crs: 'EPSG:4326', regionalFaultSources: 55,
    limitation: 'Regional mapped trace; not site survey or seismic design.',
  };
};

ok('nearby BIPAD history focuses fieldwork but never becomes a stop or probability', () => {
  const r = assessReadiness(base({ hazards: hazardScreen() }));
  const gate = r.gates.find((g) => g.id === 'geology-hazards');
  assert.equal(gate?.level, 'weak');
  assert.match(gate?.summary ?? '', /historical evidence, not a hazard probability/i);
  assert.match(gate?.evidence.join(' ') ?? '', /Landslide 2/);
  assert.notEqual(r.decision, 'hold');
  assert.match(
    r.tasks.find((t) => t.discipline === 'Engineering geology & hazards')?.reason ?? '',
    /source area, runout, recurrence or design action/i
  );
});

ok('zero nearby BIPAD reports is not presented as a clear hazard screen', () => {
  const r = assessReadiness(base({ hazards: hazardScreen(0) }));
  const gate = r.gates.find((g) => g.id === 'geology-hazards');
  assert.equal(gate?.level, 'weak');
  assert.match(gate?.summary ?? '', /absence of reports does not clear the site/i);
});

ok('upstream lake connectivity triggers outlet and GLOF routing work without inventing danger', () => {
  const r = assessReadiness(base({ upstreamConnectivity: upstreamScreen() }));
  const gate = r.gates.find((g) => g.id === 'geology-hazards');
  const field = r.tasks.find((task) => task.discipline === 'Engineering geology & hazards');
  assert.equal(gate?.level, 'weak');
  assert.match(gate?.summary ?? '', /candidate directed HydroRIVERS path.*neither a dangerous-lake classification nor a GLOF model/i);
  assert.match(gate?.evidence.join(' ') ?? '', /significant positive.*expansion.*not breach likelihood/i);
  assert.match(gate?.evidence.join(' ') ?? '', /snap can cross a drainage divide/i);
  assert.match(field?.reason ?? '', /lake centroid.*outlet\/catchment verification/i);
  assert.match(field?.deliverable ?? '', /scenario GLOF\/debris hydrographs and routing/i);
  assert.notEqual(r.decision, 'hold');
});

ok('zero connected lake/report candidates never become GLOF or debris-flow clearance', () => {
  const r = assessReadiness(base({ upstreamConnectivity: upstreamScreen(0, 0) }));
  const gate = r.gates.find((g) => g.id === 'geology-hazards');
  assert.equal(gate?.level, 'weak');
  assert.match(gate?.evidence.join(' ') ?? '', /not GLOF clearance/i);
  assert.match(gate?.evidence.join(' ') ?? '', /omits smaller streams/i);
});

ok('regional fault intersection focuses structural mapping but never auto-stops a scheme', () => {
  const r = assessReadiness(base({ faults: faultScreen(true) }));
  const gate = r.gates.find((g) => g.id === 'geology-hazards');
  assert.equal(gate?.level, 'weak');
  assert.match(gate?.summary ?? '', /intersect.*mapped river reach.*not a surveyed crossing/i);
  assert.match(gate?.evidence.join(' ') ?? '', /Main Frontal Thrust.*chainage 2.7 km/i);
  assert.notEqual(r.decision, 'hold');
  assert.match(
    r.tasks.find((t) => t.discipline === 'Engineering geology & hazards')?.deliverable ?? '',
    /surveyed fault\/lineament crossings/i
  );
});

ok('regional trace distance is never presented as fault clearance', () => {
  const r = assessReadiness(base({ faults: faultScreen(false) }));
  const gate = r.gates.find((g) => g.id === 'geology-hazards');
  assert.match(gate?.summary ?? '', /distance and non-intersection do not clear/i);
  assert.match(gate?.evidence.join(' ') ?? '', /not surveyed locations/i);
});

ok('an official DMG map match names the product to obtain but leaves geology weak', () => {
  const geology: GeologyScreen = {
    dmg: geologyMapsFor([{ lat: 27.9, lon: 85.3 }]),
    regional: null,
    regionalError: null,
  };
  const r = assessReadiness(base({ geology }));
  const gate = r.gates.find((g) => g.id === 'geology-hazards');
  const field = r.tasks.find((task) => task.discipline === 'Engineering geology & hazards');
  assert.equal(gate?.level, 'weak');
  assert.match(gate?.summary ?? '', /official DMG 1:50,000 map publication/i);
  assert.match(gate?.evidence.join(' ') ?? '', /2785 02/);
  assert.match(field?.reason ?? '', /Obtain the named DMG.*2785 02/i);
  assert.notEqual(r.decision, 'hold');
});

ok('a DMG catalog no-match never becomes no geology', () => {
  const geology: GeologyScreen = {
    dmg: geologyMapsFor([{ lat: 29.9, lon: 82 }]),
    regional: null,
    regionalError: null,
  };
  const r = assessReadiness(base({ geology }));
  const gate = r.gates.find((g) => g.id === 'geology-hazards');
  assert.equal(gate?.level, 'weak');
  assert.match(gate?.evidence.join(' ') ?? '', /catalog no-match, not an absence of geology/i);
  assert.match(
    r.tasks.find((task) => task.discipline === 'Engineering geology & hazards')?.reason ?? '',
    /confirm available maps directly with DMG/i
  );
});

ok('a site near the generalized border cannot receive a clean legal gate', () => {
  const r = assessReadiness(base({ borderKm: 2 }));
  assert.equal(r.gates.find((g) => g.id === 'legal-environment')?.level, 'weak');
  assert.match(r.gates.find((g) => g.id === 'legal-environment')?.evidence.join(' ') ?? '', /verify jurisdiction/i);
});

ok('regional flood estimates create a complete flood-study brief but never a design claim', () => {
  const r = assessReadiness(base());
  const water = r.gates.find((gate) => gate.id === 'water');
  const headworks = r.gates.find((gate) => gate.id === 'sediment-headworks');
  const flood = r.tasks.find((item) => item.title === 'Establish the flood-frequency and extreme-event basis');
  assert.match(water?.evidence.join(' ') ?? '', /regional Q100 estimate is 1250 m³\/s.*not a selected design/i);
  assert.equal(headworks?.level, 'screened');
  assert.match(headworks?.evidence.join(' ') ?? '', /not a headworks design flood/i);
  assert.match(flood?.reason ?? '', /regional regression alone cannot select a project design flood/i);
  assert.match(flood?.deliverable ?? '', /instantaneous-peak gauge frequency analysis.*historical flood.*slope-area.*direct flood-discharge measurement.*GLOF\/CLOF.*PMF\/PMP/i);
});

ok('the Nepal environmental-flow floor survives evidence and produces an EIA-grade field brief', () => {
  const r = assessReadiness(base());
  const water = r.gates.find((gate) => gate.id === 'water');
  const legal = r.gates.find((gate) => gate.id === 'legal-environment');
  const task = r.tasks.find((item) => item.discipline === 'Permitting, environment & social');
  assert.match(water?.evidence.join(' ') ?? '', /0\.500 m³\/s \(10% of the lowest modelled monthly mean.*approved EIA requirement may be higher/i);
  assert.match(legal?.evidence.join(' ') ?? '', /higher of at least 10% of minimum monthly average discharge or the EIA-required minimum/i);
  assert.match(legal?.evidence.join(' ') ?? '', /not an approved EFlow/i);
  assert.match(task?.deliverable ?? '', /approved EIA EFlow.*seasonal ecological\/hydraulic basis.*downstream uses.*drought\/ramping rules.*release works.*monitoring\/compliance plan/i);
});

ok('daily P90/P95 output focuses dependable-capacity work without becoming a firm-capacity claim', () => {
  const r = assessReadiness(base({
    scheme: {
      ...scheme,
      powerDuration: { p90MW: 4.2, p95MW: 2.8, zeroOutputFraction: 0.03, days: 7305 },
      unitSensitivity: [
        { units: 1, unitDesignFlowCms: 10, turbine: 'Francis', capacityMW: 17.7, energyGwh: 90, plantFactor: 0.58, dailyP90MW: 4.2, dailyP95MW: 2.8, zeroOutputFraction: 0.03, days: 7305 },
        { units: 2, unitDesignFlowCms: 5, turbine: 'Francis', capacityMW: 17.7, energyGwh: 95, plantFactor: 0.61, dailyP90MW: 6.8, dailyP95MW: 5.1, zeroOutputFraction: 0.01, days: 7305 },
        { units: 3, unitDesignFlowCms: 10 / 3, turbine: 'Francis', capacityMW: 17.7, energyGwh: 97, plantFactor: 0.62, dailyP90MW: 7.2, dailyP95MW: 5.7, zeroOutputFraction: 0, days: 7305 },
        { units: 4, unitDesignFlowCms: 2.5, turbine: 'Francis', capacityMW: 17.7, energyGwh: 98, plantFactor: 0.63, dailyP90MW: 7.4, dailyP95MW: 5.9, zeroOutputFraction: 0, days: 7305 },
      ],
    },
  }));
  const water = r.gates.find((gate) => gate.id === 'water');
  const equipment = r.gates.find((gate) => gate.id === 'equipment-operations');
  const hydrology = r.tasks.find((item) => item.discipline === 'Hydrology');
  assert.match(water?.evidence.join(' ') ?? '', /P90 4\.20 MW and P95 2\.80 MW across 7305 usable record days/i);
  assert.match(water?.evidence.join(' ') ?? '', /not contractual firm capacity.*availability/i);
  assert.match(equipment?.evidence.join(' ') ?? '', /assumes one unit.*forced outages.*multi-unit commitment.*contractual availability/i);
  assert.match(equipment?.evidence.join(' ') ?? '', /1–4-unit sensitivity spans daily P90 4\.20–7\.40 MW.*annual energy 90\.0–98\.0 GWh.*no equipment cost or outage credit.*not a recommendation/i);
  assert.match(hydrology?.deliverable ?? '', /daily power-duration screen.*dependable\/firm capacity/i);
});

ok('a PPA base-rate comparator informs the cost brief but economics stays unassessed', () => {
  const withPpa: Scheme = {
    ...scheme,
    capacityMW: 120,
    reliability: {
      annual: [{ year: 2024, gwh: 100, days: 366, coverage: 1 }],
      p50Gwh: 100,
      p90Gwh: 85,
      worstGwh: 80,
      bestGwh: 110,
      ppaSixSix: { wetGwh: 70, dryGwh: 30, dryShare: 0.3, meets: true, grossReferenceValueMillionNpr: 588, blendedBaseRateNprPerKwh: 5.88 },
      ppaEightFour: { wetGwh: 80, dryGwh: 20, dryShare: 0.2, meets: true, grossReferenceValueMillionNpr: 552, blendedBaseRateNprPerKwh: 5.52 },
    },
  };
  const r = assessReadiness(base({ scheme: withPpa }));
  const economics = r.gates.find((gate) => gate.id === 'economics');
  const task = r.tasks.find((item) => item.discipline === 'Cost & delivery');
  assert.equal(economics?.level, 'not-assessed');
  assert.match(economics?.evidence.join(' ') ?? '', /NPR 552 million\/year.*gross reference only, not a PPA entitlement/i);
  assert.match(economics?.evidence.join(' ') ?? '', /exceeds the posted-rate 100 MW boundary/i);
  assert.match(task?.deliverable ?? '', /signed\/expected PPA option.*COD\/escalation year.*contracted energy.*LCOE\/NPV/i);
});

console.log(`\n${passed} readiness checks passed\n`);
