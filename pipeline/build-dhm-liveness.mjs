/**
 * Which DHM gauges are still telemetering, and which have gone dark.
 *
 *   node pipeline/build-dhm-liveness.mjs
 *   node pipeline/build-dhm-liveness.mjs --self-check      (offline, no requests)
 *   node pipeline/build-dhm-liveness.mjs --from 1 --to 400 --delay 400
 *
 * WHY THIS EXISTS. `src/data/dhm-records.json` carries 136 gauge records and the
 * transfer screen decides, per site, whether one of them can be borrowed. It has
 * never known whether a gauge is STILL RUNNING. A record ending in 2008 and a
 * record ending in 2008 because the station was abandoned look identical from
 * inside this repo, and they are not the same evidence: the first might be
 * extendable by asking DHM, the second never will be.
 *
 * WHAT IT IS NOT, and this is the whole point. The portal serves WATER LEVEL in
 * metres — the page's own fields are `waterLevel`, `warning_level`,
 * `danger_level` — never discharge. Stage cannot enter this app's hydrology
 * without a per-station rating curve that DHM does not publish, so NOTHING here
 * is a flow, feeds a flow, or corrects one. It answers exactly one question:
 * is there a live instrument at this gauge today.
 *
 * AND THERE IS NO HISTORY TO HARVEST. Asked for 2025-09-06, 2020-07-15 and
 * 2015-07-15 on station 231, the endpoint returns zero rows every time; the
 * payload carries about seven days. So this is a liveness probe by necessity as
 * well as by choice — there is nothing else there to take.
 *
 * WHY NOT THE OFFICIAL API. `hydrology.gov.np/gss/api/station` is already the
 * source for `dhm-stations.json` and it is metadata only: its sibling
 * `/gss/api/observation` answers **403**, which is what the bundled note means by
 * "observation values require DHM authorisation". The public river-watch pages
 * are the only unauthenticated view of whether an instrument is reporting.
 *
 * POLITENESS. Two requests per station, serialised, with a delay between them
 * and an identifying User-Agent. There is no robots.txt on the host (it 404s),
 * so nothing forbids this — but a government portal gets asked slowly. Run it
 * occasionally, not on a timer: liveness changes over months, and a daily cron
 * would be a hundred requests a day to learn nothing new.
 *
 * OUTPUT
 *   src/data/dhm-liveness.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const OUT = new URL('src/data/dhm-liveness.json', ROOT);
const BASE = 'https://dhm.gov.np';
const UA = 'HydroRecon/0.2 (Nepal run-of-river screening; gauge liveness check)';

const flag = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const FROM = Number(flag('--from', 1));
const TO = Number(flag('--to', 400));
const DELAY_MS = Number(flag('--delay', 350));

/**
 * How stale is dark.
 *
 * Stated rather than assumed, because the verdict is the whole output. A
 * telemetered station reports every ten minutes, so a day of silence is already
 * a fault; a month is an abandoned instrument. The bands are wide on purpose —
 * this distinguishes "reporting" from "not", and is not a service-availability
 * metric.
 */
const LIVE_H = 48;
const STALE_H = 24 * 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Portal page: the station's name, its series id, and a CSRF token + cookie. */
export function parseStationPage(html) {
  const name = html.match(/<h6 class="heading-01 mb-2">([^<]+)<\/h6>/)?.[1]?.trim() ?? null;
  const seriesId = html.match(/name="seriesid"[^>]*value="(\d+)"/)?.[1] ?? null;
  const csrf = html.match(/name="csrf_test_name"[^>]*value="([a-f0-9]+)"/)?.[1] ?? null;
  return { name, seriesId, csrf };
}

/**
 * "Mon, Sep 7, 2026 ,05:40" — the portal's own format, and Nepal time.
 *
 * `new Date(string)` would read it as the machine's local zone, which on a
 * laptop outside Nepal shifts every lag by hours and silently reclassifies
 * stations. NPT is UTC+05:45, so the offset is applied explicitly.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function parseNepalStamp(text) {
  const m = text.match(/(\w{3}) (\d{1,2}), (\d{4})\s*,?\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  const utcMs = Date.UTC(Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5]));
  return new Date(utcMs - (5 * 60 + 45) * 60_000);
}

/** Newest (timestamp, value) out of the endpoint's HTML table. */
export function parseLatestReading(json) {
  const table = json?.data?.table;
  if (typeof table !== 'string') return null;
  const rows = table.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  for (const row of rows) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/g) ?? []).map((c) =>
      c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    );
    if (cells.length < 2) continue;
    const at = parseNepalStamp(cells[0]);
    const level = Number(cells[cells.length - 1]);
    // The daily view is Date/Max/Min/Average; the point view is Date/Point.
    // Either way the LAST column is a level and the first is the stamp.
    if (at && Number.isFinite(level)) return { at, levelM: level };
  }
  return null;
}

/**
 * Match a portal title to a bundled record.
 *
 * The portal writes "Daraudi Khola at Naya Sangu" and the record holds
 * `river: "Daraudi Khola"`, `location: "Naya Sangu"`, so the two are the same
 * string with one join. Normalising away case, punctuation and the "khola"/
 * "river" suffixes is what absorbs the transliteration drift between them.
 */
export const normalise = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(khola|river|nadi|gad|at|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function matchRecords(portal, records) {
  const byName = new Map();
  for (const r of records) {
    byName.set(normalise(`${r.river} ${r.location}`), r);
  }
  return portal.map((p) => {
    const key = normalise(p.name);
    let hit = byName.get(key) ?? null;
    if (!hit) {
      // Fall back to a containment test: the portal sometimes carries an extra
      // qualifier the record does not, and vice versa.
      for (const [k, r] of byName) {
        if (k && (k.includes(key) || key.includes(k))) {
          hit = r;
          break;
        }
      }
    }
    return { ...p, record: hit };
  });
}

export function verdict(lastAt, now = new Date()) {
  if (!lastAt) return { state: 'no reading', lagHours: null };
  const lagHours = (now.getTime() - lastAt.getTime()) / 3_600_000;
  const state = lagHours <= LIVE_H ? 'live' : lagHours <= STALE_H ? 'stale' : 'dark';
  return { state, lagHours: Number(lagHours.toFixed(1)) };
}

async function selfCheck() {
  const page = `
    <h6 class="heading-01 mb-2">Daraudi Khola at Naya Sangu</h6>
    <input type="hidden" name="csrf_test_name" value="80e865d9fb02e0f08db090ff46fb2901">
    <input type="text" name="seriesid" class="form-control" value="3508" style="display:none;">`;
  const parsed = parseStationPage(page);
  console.assert(parsed.name === 'Daraudi Khola at Naya Sangu', 'name', parsed);
  console.assert(parsed.seriesId === '3508', 'seriesId', parsed);
  console.assert(parsed.csrf?.length === 32, 'csrf', parsed);
  if (parsed.seriesId !== '3508' || !parsed.name) throw new Error('station page parse failed');

  // The two column shapes the endpoint actually returns.
  const point = {
    data: {
      table:
        '<tr><th>Date</th><th>Point</th></tr>' +
        '<tr><td>\r\n Mon, Sep 7, 2026 ,05:40 </td><td>2.08</td></tr>' +
        '<tr><td>Mon, Sep 7, 2026 ,05:30</td><td>2.02</td></tr>',
    },
  };
  const daily = {
    data: {
      table:
        '<tr><th>Date</th><th>Max</th><th>Min</th><th>Average</th></tr>' +
        '<tr><td>Mon, Sep 7, 2026 ,12:00 AM</td><td>2.11</td><td>2.02</td><td>2.06</td></tr>',
    },
  };
  const a = parseLatestReading(point);
  const b = parseLatestReading(daily);
  if (!a || a.levelM !== 2.08) throw new Error(`point row misread: ${JSON.stringify(a)}`);
  if (!b || b.levelM !== 2.06) throw new Error(`daily row misread: ${JSON.stringify(b)}`);
  // 05:40 NPT on 7 Sep 2026 is 23:55 UTC on 6 Sep — the offset must be applied.
  if (a.at.toISOString() !== '2026-09-06T23:55:00.000Z') {
    throw new Error(`Nepal offset not applied: ${a.at.toISOString()}`);
  }
  if (parseLatestReading({ data: { table: '<tr><th>Date</th></tr>' } }) !== null) {
    throw new Error('an empty table must read as no reading, not as a zero');
  }

  const matched = matchRecords(
    [{ name: 'Daraudi Khola at Naya Sangu' }, { name: 'Nowhere Khola at Nowhere' }],
    [
      { id: '439.7', river: 'Daraudi Khola', location: 'Naya Sangu' },
      { id: '115', river: 'Naugra gad', location: 'Harsing bagar' },
    ]
  );
  if (matched[0].record?.id !== '439.7') throw new Error('name match failed');
  if (matched[1].record !== null) throw new Error('a station with no record must not match one');

  const now = new Date('2026-09-07T00:00:00Z');
  if (verdict(new Date('2026-09-06T20:00:00Z'), now).state !== 'live') throw new Error('live band');
  if (verdict(new Date('2026-09-01T00:00:00Z'), now).state !== 'stale') throw new Error('stale band');
  if (verdict(new Date('2025-09-01T00:00:00Z'), now).state !== 'dark') throw new Error('dark band');
  if (verdict(null, now).state !== 'no reading') throw new Error('null band');

  console.log(
    'self-check OK: page parse, both table shapes, Nepal offset, empty table, ' +
      'name match and miss, four liveness bands'
  );
}

async function main() {
  const records = JSON.parse(readFileSync(new URL('src/data/dhm-records.json', ROOT))).stations;
  console.log(`${records.length} bundled gauge records to check against`);

  const found = [];
  let missed = 0;
  for (let id = FROM; id <= TO; id++) {
    let html;
    try {
      const res = await fetch(`${BASE}/hydrology/hms-Single/${id}`, { headers: { 'User-Agent': UA } });
      if (!res.ok) {
        missed++;
        continue;
      }
      html = await res.text();
    } catch (e) {
      missed++;
      continue;
    } finally {
      await sleep(DELAY_MS);
    }
    const parsed = parseStationPage(html);
    if (!parsed.name || !parsed.seriesId) {
      missed++;
      continue;
    }
    found.push({ pageId: id, ...parsed });
    process.stdout.write(`\r  scanned ${id}/${TO} — ${found.length} stations found   `);
  }
  console.log(`\n${found.length} station pages, ${missed} ids with none`);
  if (!found.length) {
    console.error('no stations found — the portal layout may have changed; nothing written');
    process.exit(1);
  }

  const now = new Date();
  const rows = [];
  for (const s of found) {
    let latest = null;
    let error = null;
    try {
      // The token is bound to the session cookie, so both come from one GET.
      const page = await fetch(`${BASE}/hydrology/hms-Single/${s.pageId}`, {
        headers: { 'User-Agent': UA },
      });
      const cookie = (page.headers.getSetCookie?.() ?? [])
        .map((c) => c.split(';')[0])
        .join('; ');
      const token = parseStationPage(await page.text()).csrf;
      await sleep(DELAY_MS);
      const res = await fetch(`${BASE}/site/getRiverWatchBySeriesId`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: new URLSearchParams({
          csrf_test_name: token ?? '',
          seriesid: s.seriesId,
          date: now.toISOString().slice(0, 10),
          period: '1',
        }),
      });
      latest = parseLatestReading(await res.json());
    } catch (e) {
      error = String(e?.message ?? e);
    }
    await sleep(DELAY_MS);
    rows.push({ ...s, latest, error });
    process.stdout.write(`\r  read ${rows.length}/${found.length}   `);
  }
  console.log('');

  const matched = matchRecords(rows, records);
  const out = matched.map((m) => {
    const v = verdict(m.latest?.at ?? null, now);
    return {
      portalPageId: m.pageId,
      portalSeriesId: m.seriesId,
      portalName: m.name,
      station: m.record ? { id: m.record.id, river: m.record.river, location: m.record.location } : null,
      recordEndsYear: m.record?.to ?? null,
      state: m.error ? 'unreadable' : v.state,
      lagHours: v.lagHours,
      lastReadingUtc: m.latest?.at?.toISOString() ?? null,
      // Carried so a reader can see the instrument is plausible, and labelled
      // so nobody mistakes it for a flow.
      lastWaterLevelM: m.latest?.levelM ?? null,
      error: m.error,
    };
  });

  const count = (s) => out.filter((o) => o.state === s).length;
  const withRecord = out.filter((o) => o.station);
  const liveIds = new Set(withRecord.filter((o) => o.state === 'live').map((o) => o.station.id));

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        _what: 'Which DHM gauges are still telemetering, from the public river-watch pages.',
        _source: `${BASE}/hydrology/hms-Single/{pageId} and ${BASE}/site/getRiverWatchBySeriesId`,
        _quantity:
          'WATER LEVEL in metres, never discharge. The portal has no discharge and publishes no ' +
          'rating curve, so nothing here can enter the hydrology. It answers only whether an ' +
          'instrument is reporting.',
        _history:
          'The endpoint holds about seven days. Every date older than that returns zero rows, so ' +
          'this cannot be backfilled and is not a record.',
        _bands: { liveWithinHours: LIVE_H, staleWithinHours: STALE_H },
        _checked: now.toISOString(),
        _scanned: { from: FROM, to: TO, stationPages: found.length },
        _matched:
          `${withRecord.length} of ${out.length} portal stations matched a bundled record, ` +
          `covering ${new Set(withRecord.map((o) => o.station.id)).size} distinct records of ` +
          `${records.length}.`,
        /**
         * Where two portal stations landed on one record.
         *
         * Reported rather than collapsed. DHM publishes some sites twice — a
         * gauge and its bridge section, "Karnali at Chisapani" and "Karnali at
         * Chisapani Bridge" — and both really are the same record. But the
         * containment fallback in `matchRecords` could also fuse two genuinely
         * different stations whose names nest, and a reader cannot tell the
         * cases apart unless the collisions are listed.
         */
        _duplicateRecordMatches: Object.entries(
          withRecord.reduce((acc, o) => {
            (acc[o.station.id] ??= []).push(o.portalName);
            return acc;
          }, {})
        )
          .filter(([, names]) => names.length > 1)
          .map(([id, names]) => ({ recordId: id, portalNames: names })),
        stations: out.sort((a, b) => (a.station?.id ?? 'zz').localeCompare(b.station?.id ?? 'zz')),
      },
      null,
      2
    )
  );

  console.log(`\nwrote ${OUT.pathname.split('/').pop()}`);
  console.log(
    `  live ${count('live')}   stale ${count('stale')}   dark ${count('dark')}   ` +
      `no reading ${count('no reading')}   unreadable ${count('unreadable')}`
  );
  console.log(`  ${withRecord.length} of ${out.length} portal stations matched a bundled record`);
  console.log(
    `  ${records.length - liveIds.size} of ${records.length} bundled records have NO live gauge behind them`
  );
  for (const o of out.filter((x) => x.station && x.state === 'live').slice(0, 10)) {
    console.log(
      `    ${o.station.id.padEnd(7)} ${o.portalName.slice(0, 40).padEnd(40)} ` +
        `record to ${o.recordEndsYear ?? '?'}, reporting ${o.lagHours}h ago`
    );
  }
}

if (process.argv.includes('--self-check')) await selfCheck();
else await main();
