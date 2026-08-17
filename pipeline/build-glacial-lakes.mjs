/**
 * Build the Nepal/transboundary Glacial Lake Observatory centroid bundle.
 *
 *   npm run build:glacial-lakes
 *
 * The upstream dataset is a CC BY 4.0 Sentinel-2 inventory of unique glacial
 * lakes in Nepal and the parts of China and India that drain through Nepal's
 * Koshi, Gandaki and Karnali basins. Ghatta keeps only identifiers, basin and
 * classification fields, elevation, published expansion diagnostics and the
 * EPSG:4326 centroid. Lake polygons and model weights are intentionally not
 * bundled: the centroid layer is sufficient for a conservative river-network
 * connectivity screen and is much smaller.
 *
 * A mapped lake is not a potentially dangerous lake. This pipeline does not
 * infer dam type, stability, breach probability, outburst volume or runout.
 */
import { createHash } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const RECORD_ID = 17802334;
const API = `https://zenodo.org/api/records/${RECORD_ID}`;
const DOI = 'https://doi.org/10.5281/zenodo.17802334';
const FILE = 'S2_20172024_TB_GLOID_UniqueLakes_centroids_v1_0.gpkg';
const TABLE = 's2_20172024_tb_gloid_uniquelakes_centroids_v1_0';
const OUT = 'src/data/nepal-glacial-lakes.json';
const TMP_OUT = `${OUT}.tmp`;
const TMP_GPKG = `${OUT}.gpkg.tmp`;
const UA = 'Ghatta/0.2 (open-source hydropower screening; github.com/Bijaykars)';

const response = await fetch(API, {
  headers: { accept: 'application/json', 'user-agent': UA },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Zenodo metadata failed: HTTP ${response.status}`);
const record = await response.json();
if (record?.metadata?.license?.id !== 'cc-by-4.0') {
  throw new Error(`Expected CC BY 4.0, received ${JSON.stringify(record?.metadata?.license)}`);
}
if (record?.metadata?.access_right !== 'open') {
  throw new Error(`Expected open access, received ${record?.metadata?.access_right}`);
}
const file = record.files?.find((candidate) => candidate.key === FILE);
if (!file?.links?.self || !/^md5:[0-9a-f]{32}$/i.test(file.checksum ?? '')) {
  throw new Error(`Missing or invalid ${FILE} metadata`);
}

console.log(`fetching ${FILE} from Zenodo record ${RECORD_ID}...`);
const dataResponse = await fetch(file.links.self, {
  headers: { 'user-agent': UA },
  signal: AbortSignal.timeout(60_000),
});
if (!dataResponse.ok) throw new Error(`Zenodo file failed: HTTP ${dataResponse.status}`);
const bytes = Buffer.from(await dataResponse.arrayBuffer());
if (bytes.length !== file.size) {
  throw new Error(`File size changed: metadata ${file.size}, download ${bytes.length}`);
}
const checksum = `md5:${createHash('md5').update(bytes).digest('hex')}`;
if (checksum.toLowerCase() !== file.checksum.toLowerCase()) {
  throw new Error(`Checksum mismatch: expected ${file.checksum}, received ${checksum}`);
}

const bool = (value) =>
  value === 'TRUE' ? true : value === 'FALSE' ? false : value === 'NA' || value == null ? null : (() => {
    throw new Error(`Unexpected boolean flag ${JSON.stringify(value)}`);
  })();
const finite = (value, field, nullable = false) => {
  if (nullable && value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${field}: ${JSON.stringify(value)}`);
  return number;
};
const r = (value, digits) => value == null ? null : Number(value.toFixed(digits));

let db;
try {
  writeFileSync(TMP_GPKG, bytes);
  db = new DatabaseSync(TMP_GPKG, { readOnly: true });
  const contents = db.prepare(
    'SELECT table_name, data_type, srs_id FROM gpkg_contents WHERE table_name = ?'
  ).get(TABLE);
  if (contents?.data_type !== 'features' || contents?.srs_id !== 4326) {
    throw new Error(`Unexpected GeoPackage contents: ${JSON.stringify(contents)}`);
  }

  const rows = db.prepare(`
    SELECT GLO_ID, COUNTRY, BASIN, CONNECTIVITY,
           ELEVATION_MEAN, EXPANSION_RATE, EXPANSTION_UNCERTAINTY,
           EXPANSION_RATE_SIG, TS_OUTLIER, CENTROID_LAT, CENTROID_LON,
           DATA_SOURCE
      FROM "${TABLE}"
     ORDER BY GLO_ID
  `).all();
  if (rows.length < 4_000 || rows.length > 5_000) {
    throw new Error(`Unexpected lake count ${rows.length}`);
  }

  const countries = new Set(['Nepal', 'China', 'India']);
  const basins = new Set(['Koshi', 'Gandaki', 'Karnali']);
  const connectivity = new Set(['Glacier-fed', 'Non Glacier-fed']);
  const ids = new Set();
  const lakes = rows.map((row) => {
    if (typeof row.GLO_ID !== 'string' || !/^GLO_-?\d/.test(row.GLO_ID) || ids.has(row.GLO_ID)) {
      throw new Error(`Invalid or duplicate GLO_ID ${JSON.stringify(row.GLO_ID)}`);
    }
    ids.add(row.GLO_ID);
    if (!countries.has(row.COUNTRY) || !basins.has(row.BASIN) || !connectivity.has(row.CONNECTIVITY)) {
      throw new Error(`Unexpected classification for ${row.GLO_ID}`);
    }
    if (row.DATA_SOURCE !== 'Sentinel-2') throw new Error(`Unexpected sensor ${row.DATA_SOURCE}`);
    const lat = finite(row.CENTROID_LAT, 'latitude');
    const lon = finite(row.CENTROID_LON, 'longitude');
    if (lat < 27.4 || lat > 30.7 || lon < 79.9 || lon > 88.9) {
      throw new Error(`Centroid outside declared transboundary catchments: ${row.GLO_ID}`);
    }
    return [
      row.GLO_ID,
      row.COUNTRY,
      row.BASIN,
      row.CONNECTIVITY,
      r(finite(row.ELEVATION_MEAN, 'elevation'), 1),
      r(finite(row.EXPANSION_RATE, 'expansion rate', true), 4),
      r(finite(row.EXPANSTION_UNCERTAINTY, 'expansion uncertainty', true), 4),
      bool(row.EXPANSION_RATE_SIG),
      bool(row.TS_OUTLIER),
      r(lat, 5),
      r(lon, 5),
    ];
  });

  const countryCounts = Object.fromEntries(
    [...countries].map((country) => [country, lakes.filter((lake) => lake[1] === country).length])
  );
  const basinCounts = Object.fromEntries(
    [...basins].map((basin) => [basin, lakes.filter((lake) => lake[2] === basin).length])
  );
  const retrieved = new Date().toISOString().slice(0, 10);
  const bundle = {
    _source: DOI,
    _record: API,
    _file: FILE,
    _checksum: checksum,
    _published: record.metadata.publication_date,
    _retrieved: retrieved,
    _observations: { from: 2017, to: 2024, sensor: 'Sentinel-2' },
    _crs: 'EPSG:4326 (WGS 84 longitude/latitude centroids)',
    _license: 'CC BY 4.0',
    _licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    _citation:
      'Rawlins, L., Watson, C. S., Bhambri, R., Khadka, N., & Chand, M. B. (2025). Glacial Lake Observatory dataset. Zenodo. doi:10.5281/zenodo.17802334.',
    _quality:
      'Sentinel-2 validation F1=0.92 for 2020 and about 0.91 for 2017/2024; centroid coordinates EPSG:4326; native imagery 10 m. See upstream README for the full validation and limitations.',
    _note:
      'Unique lake centroids and published expansion diagnostics only. A mapped or expanding lake is not necessarily dangerous; this bundle does not classify dam stability, breach likelihood, outburst volume, flood routing or project exposure.',
    _counts: { total: lakes.length, countries: countryCounts, basins: basinCounts },
    lakes,
  };
  const output = JSON.stringify(bundle);
  writeFileSync(TMP_OUT, output);
  renameSync(TMP_OUT, OUT);
  console.log(`wrote ${OUT}: ${lakes.length} lakes, ${(output.length / 1024).toFixed(1)} KB`);
  console.log(`  countries ${JSON.stringify(countryCounts)}; basins ${JSON.stringify(basinCounts)}`);
  console.log(`  checksum ${checksum}; retrieved ${retrieved}`);
} finally {
  db?.close();
  rmSync(TMP_GPKG, { force: true });
  rmSync(TMP_OUT, { force: true });
}
