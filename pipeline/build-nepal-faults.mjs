/**
 * Build the Nepal-plus-buffer regional active-fault screen.
 *
 *   npm run build:faults
 *
 * The source is pinned to an immutable revision of the GEM Global Active
 * Faults database. The 79.5-89 E / 25.5-31 N window covers Nepal and enough
 * adjoining terrain to avoid an artificial jurisdiction-edge blind spot.
 * HimaTibetMap folds are excluded: this screen is for mapped active-fault
 * traces of seismogenic concern, not every structure in the source catalogue.
 *
 * The result is a CC BY-SA 4.0 derivative data file. HydroRecon's MIT licence
 * continues to apply to code, not to this bundled dataset.
 */
import { createHash } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

const OUT = 'src/data/nepal-faults.json';
const TMP = `${OUT}.tmp`;
const COMMIT = '56816508ad92fd6846dad1163b1c8c01376a2cd1';
const SOURCE = `https://raw.githubusercontent.com/GEMScienceTools/gem-global-active-faults/${COMMIT}/geojson/gem_active_faults.geojson`;
const REPOSITORY = 'https://github.com/GEMScienceTools/gem-global-active-faults';
const LICENSE = `${REPOSITORY}/blob/${COMMIT}/LICENSE.txt`;
const WINDOW = { west: 79.5, south: 25.5, east: 89, north: 31 };
const EXCLUDED = new Set(['Syncline', 'Anticline']);
const UA = 'HydroRecon/0.2 (open-source hydropower screening; github.com/Bijaykars)';

const r5 = (value) => Math.round(value * 1e5) / 1e5;
const inside = ([x, y]) =>
  x >= WINDOW.west && x <= WINDOW.east && y >= WINDOW.south && y <= WINDOW.north;

/** Liang-Barsky clipping of one lon/lat segment to the declared window. */
function clipSegment(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [
    a[0] - WINDOW.west,
    WINDOW.east - a[0],
    a[1] - WINDOW.south,
    WINDOW.north - a[1],
  ];
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) lo = Math.max(lo, t);
    else hi = Math.min(hi, t);
    if (lo > hi) return null;
  }
  return [
    [a[0] + lo * dx, a[1] + lo * dy],
    [a[0] + hi * dx, a[1] + hi * dy],
  ];
}

function same(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
}

/** Clip a LineString and retain every connected in-window part. */
function clipLine(line) {
  const parts = [];
  let current = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const clipped = clipSegment(line[i], line[i + 1]);
    if (!clipped) {
      if (current.length > 1) parts.push(current);
      current = [];
      continue;
    }
    const [a, b] = clipped;
    if (current.length && same(current.at(-1), a)) current.push(b);
    else {
      if (current.length > 1) parts.push(current);
      current = [a, b];
    }
    if (!inside(b) || (!inside(line[i + 1]) && i + 2 < line.length)) {
      if (current.length > 1) parts.push(current);
      current = [];
    }
  }
  if (current.length > 1) parts.push(current);
  return parts
    .map((part) => part.filter((point, index) => index === 0 || !same(point, part[index - 1])))
    .filter((part) => part.length > 1);
}

function geometryLines(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

console.log(`fetching pinned GEM Global Active Faults ${COMMIT.slice(0, 12)}...`);
const response = await fetch(SOURCE, {
  headers: { accept: 'application/geo+json, application/json', 'user-agent': UA },
  signal: AbortSignal.timeout(45_000),
});
if (!response.ok) throw new Error(`GEM download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length < 10_000_000) throw new Error(`GEM source unexpectedly small: ${bytes.length} bytes`);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const source = JSON.parse(bytes.toString('utf8'));
if (source?.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
  throw new Error('GEM source is not a GeoJSON FeatureCollection');
}
if (source.features.length < 16_000) {
  throw new Error(`GEM source feature count unexpectedly low: ${source.features.length}`);
}

const candidates = [];
for (const feature of source.features) {
  const parts = geometryLines(feature.geometry).flatMap(clipLine);
  if (parts.length) candidates.push({ feature, parts });
}
if (candidates.length !== 59) {
  throw new Error(`expected 59 regional source structures at pinned commit, got ${candidates.length}`);
}

const faultSources = candidates.filter(({ feature }) => !EXCLUDED.has(feature.properties?.slip_type));
if (faultSources.length !== 55) {
  throw new Error(`expected 55 regional active-fault sources after fold exclusion, got ${faultSources.length}`);
}

const traces = [];
for (const { feature, parts } of faultSources) {
  const properties = feature.properties ?? {};
  const sourceId = String(properties.catalog_id ?? feature.id ?? '').trim();
  if (!sourceId) throw new Error('regional feature is missing catalog_id');
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const points = parts[partIndex].map(([lon, lat]) => [r5(lon), r5(lat)]);
    if (points.some(([lon, lat]) => !inside([lon, lat]))) {
      throw new Error(`${sourceId}: clipped coordinate outside output window`);
    }
    traces.push({
      id: parts.length === 1 ? sourceId : `${sourceId}:${partIndex + 1}`,
      sourceId,
      name: String(properties.fs_name ?? '').trim() || null,
      type: String(properties.slip_type ?? '').trim() || 'Unknown',
      reference: String(properties.reference ?? '').trim() || null,
      points,
    });
  }
}

const ids = new Set(traces.map((trace) => trace.id));
if (ids.size !== traces.length) throw new Error('duplicate output trace IDs');
if (!traces.some((trace) => /Main Frontal Thrust/i.test(trace.name ?? ''))) {
  throw new Error('Main Frontal Thrust missing from regional output');
}

const retrieved = new Date().toISOString().slice(0, 10);
const bundle = {
  _source: 'GEM Global Active Faults Database',
  _sourceUrl: REPOSITORY,
  _download: SOURCE,
  _commit: COMMIT,
  _sha256: sha256,
  _retrieved: retrieved,
  _license: 'CC BY-SA 4.0',
  _licenseUrl: LICENSE,
  _attribution: 'Styron, R. and Pagani, M. (2020), GEM Global Active Faults Database; Indo-Asian traces from HimaTibetMap.',
  _citation: 'Styron, R. and Pagani, M. (2020), The GEM Global Active Faults Database, Earthquake Spectra, doi:10.1177/8755293020944182.',
  _crs: 'EPSG:4326',
  _coordinateOrder: '[longitude, latitude]',
  _window: WINDOW,
  _sourceFeatureCount: source.features.length,
  _regionalStructureCount: candidates.length,
  _regionalFaultSourceCount: faultSources.length,
  _excluded: '4 HimaTibetMap fold-axis structures (Syncline/Anticline)',
  _note: 'Regional mapped active-fault context only. Locations are unsuitable for site-scale set-out or seismic design; absence or distance is not clearance. The displayed river reach is not a surveyed canal, tunnel or penstock alignment.',
  traces,
};

try {
  writeFileSync(TMP, `${JSON.stringify(bundle)}\n`);
  renameSync(TMP, OUT);
} catch (error) {
  rmSync(TMP, { force: true });
  throw error;
}

console.log(`wrote ${OUT}`);
console.log(`  source features: ${source.features.length.toLocaleString()}`);
console.log(`  regional structures: ${candidates.length}; fault sources: ${faultSources.length}`);
console.log(`  clipped trace parts: ${traces.length}; sha256 ${sha256}`);
console.log(`  derivative licence: CC BY-SA 4.0; retrieved ${retrieved}`);
