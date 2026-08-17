/**
 * Build the bundled Nepal DHM station inventory.
 *
 *   npm run build:dhm
 *
 * Why this is a build step and not a runtime fetch: hydrology.gov.np/gss/api/station
 * sends `access-control-allow-origin: *` but returns **45 MB uncompressed in ~9 s**,
 * and ignores every pagination parameter tried (limit, page, per_page, fields).
 *
 * Station VALUES are not available: /gss/api/observation returns
 * 403 {"message":"Permission denied or Api Keys required"} for every series id and
 * date range tried — and, checked in the browser against DHM's own portal with its
 * own headers, for them too. So this gives metadata only. What that metadata is
 * worth is deciding WHICH station to go and ask DHM for, and the feed says far
 * more about that than the first version of this script kept.
 *
 * WHAT IS DELIBERATELY DROPPED
 *
 * Each station carries a `meta_data` array of up to 48 entries, and a lot of it
 * is personal information about the people who run the station: observer names,
 * their mobile numbers and home addresses, bank name and account number, PAN
 * (tax) numbers, their qualifications and a performance rating. None of that
 * belongs in a public repository, and no hydropower calculation needs it. Fields
 * are therefore taken by an explicit ALLOW-LIST below, never by exclusion — so a
 * new personal field appearing upstream cannot silently start being published.
 */
import { writeFileSync } from 'node:fs';

const SRC = 'https://hydrology.gov.np/gss/api/station';
const OUT = 'src/data/dhm-stations.json';

/**
 * The only `meta_data` names ever read. Everything else is discarded unseen.
 * Keep this list minimal and non-personal.
 */
const ALLOWED_META = {
  'River Name': 'river',
  Basin: 'basin',
  District: 'district',
  'Warning Level': 'warn',
  'Danger Level': 'danger',
};

console.log(`fetching ${SRC} (~45 MB, expect ~10 s)…`);
const t0 = Date.now();
let res = null;
let last = '';
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    const candidate = await fetch(SRC, { signal: AbortSignal.timeout(120_000) });
    if (!candidate.ok) throw new Error(`HTTP ${candidate.status}`);
    res = candidate;
    break;
  } catch (e) {
    last = e.message;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
  }
}
if (!res) throw new Error(`DHM: ${last}`);
const raw = await res.json();
console.log(`  got ${raw.length} records in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

/** Pull one allow-listed metadata value, trimmed, or null. */
const meta = (s, name) => {
  const hit = (s.meta_data ?? []).find((m) => m.name === name);
  const v = String(hit?.value ?? '').trim();
  return v && v.toLowerCase() !== 'null' && v !== '-' && v !== 'N/A' ? v : null;
};

/** A level in metres, where DHM recorded a usable number. */
const level = (s, name) => {
  const v = meta(s, name);
  if (v === null) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  // Gauge boards are a few metres; anything else is a typo or a different unit.
  return Number.isFinite(n) && n > 0 && n < 30 ? Math.round(n * 100) / 100 : null;
};

const stations = raw
  .filter((s) => Number.isFinite(s.latitude) && Number.isFinite(s.longitude))
  // Keep the ones inside Nepal's bounding box; the feed carries a few strays.
  .filter((s) => s.latitude > 26 && s.latitude < 31 && s.longitude > 80 && s.longitude < 89)
  .filter((s) => !/^test[_ ]/i.test(s.name ?? '')) // the feed has test rigs in it
  .map((s) => {
    const name = (s.name ?? '').trim(); // the feed has leading spaces on some names
    const params = (s.data_source ?? []).flatMap((d) => d.parameters ?? []);
    const codes = new Set(params.map((p) => p.parameter_code));

    /**
     * Classify by WHAT THE INSTRUMENT MEASURES, not by the station's name.
     *
     * The first version of this script matched names against river/khola/nadi,
     * because the `tags` vocabulary was junk and `Station Type` turned out to be
     * free text with ninety-odd spellings — including typos ("Precipition",
     * "Climatalogy"), Nepali script, and values like "aa" and "406.4".
     *
     * The parameter list is not free text. A station reporting water level or
     * discharge is a river gauge, whatever anybody typed in the name field.
     */
    const measuresWater = [...codes].some((c) => /^(WL|Q_M|R_[SAWD])/.test(c));
    const namedRiver = /\b(river|khola|nadi|kholsi|gad|koshi|kosi)\b/i.test(name);
    /**
     * DHM's own "(Rainfall)" suffix overrides the parameter list.
     *
     * A handful of records carry both — sites where a rain gauge and a river
     * gauge share a name, and the hydrological series has been hung off the
     * wrong one. Where DHM has explicitly labelled the station, believe the
     * label; the co-located river gauge is nearly always a separate record
     * anyway ("Aadhi Khola at Borlangpul (Rainfall)" beside "Andhi Khola at
     * Borlang pool").
     */
    const labelledRainfall = /\(rainfall\)/i.test(name);

    /** Manual discharge, m³/s — the stations where a real flow record exists. */
    const qSeries = params.find((p) => p.parameter_code === 'Q_M');

    const out = {
      n: name,
      y: Math.round(s.latitude * 1e4) / 1e4,
      x: Math.round(s.longitude * 1e4) / 1e4,
      e: Number.isFinite(s.elevation) ? Math.round(s.elevation) : null,
      r: !labelledRainfall && (measuresWater || namedRiver) ? 1 : 0,
    };

    // The richer fields are only useful on river gauges, and bytes matter.
    if (out.r) {
      // `q` is the difference between a record you can use and one you would
      // still have to convert through a rating curve you do not have.
      if (qSeries) {
        out.q = 1;
        out.qs = qSeries.id; // series id, so a data request can cite it exactly
      }
      for (const [name_, key] of Object.entries(ALLOWED_META)) {
        if (key === 'warn' || key === 'danger') continue;
        const v = meta(s, name_);
        if (v) out[key === 'river' ? 'rv' : key === 'basin' ? 'b' : 'd'] = v;
      }
      const w = level(s, 'Warning Level');
      const g = level(s, 'Danger Level');
      if (w !== null) out.w = w;
      if (g !== null) out.g = g;
    }
    return out;
  })
  .sort((a, b) => a.n.localeCompare(b.n));

const bundle = {
  _source: SRC,
  _retrieved: new Date().toISOString().slice(0, 10),
  _note:
    'Station metadata only. Observation values require DHM authorisation/API keys. Personal observer and banking fields are excluded by allow-list.',
  stations,
};
const json = JSON.stringify(bundle);
writeFileSync(OUT, json);

const rivers = stations.filter((s) => s.r);
console.log(`wrote ${OUT}: ${stations.length} stations, ${(json.length / 1024).toFixed(1)} KB`);
console.log(`  river gauges:            ${rivers.length}`);
console.log(`  measuring discharge Q_M: ${rivers.filter((s) => s.q).length}`);
console.log(`  with a named river:      ${rivers.filter((s) => s.rv).length}`);
console.log(`  with a basin:            ${rivers.filter((s) => s.b).length}`);
console.log(`  with warning/danger level: ${rivers.filter((s) => s.w || s.g).length}`);
console.log(`  sample: ${JSON.stringify(rivers.find((s) => s.q) ?? rivers[0])}`);

// Fail loudly rather than publish somebody's phone number.
const leak = /\b(9[678]\d{8}|account|\bPAN\b|observer)/i.exec(json);
if (leak) throw new Error(`personal data leaked into the bundle: ${leak[0]}`);
console.log('  personal-data scan: clean');
