/**
 * Render the desk study to a real PDF, the way a user would get it.
 *
 *   node pipeline/render-report.mjs [lat] [lon] [out.pdf]
 *
 * WHY A BROWSER IS UNAVOIDABLE. The report's figures are MapLibre captures, and
 * MapLibre only produces them from a canvas that has actually composited. A
 * headless page that never paints hands back a black rectangle for every map,
 * which looks like a rendering bug in the report rather than in the harness.
 * So this drives real Chrome over a real Vite server, exactly as the app runs.
 *
 * IT USES THE APP'S OWN CONTEXT, NOT A FIXTURE. `window.__exportCtx` and
 * `window.__captureFigures` are already exposed for harnesses, so the PDF is
 * built from the same object the Export button would use. A fixture would drift
 * from the app and quietly stop testing it.
 *
 * WHY NOT CLICK THE EXPORT BUTTON. `printDeskStudy` writes into a hidden iframe
 * and calls `print()`, which is modal. Calling `deskStudyHtml` directly gets the
 * same HTML — it is the function the button ends up in — without a dialog.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

/**
 * A LAYOUT SOMEBODY ELSE CHOSE.
 *
 *   node pipeline/render-report.mjs --intake 29.2583,81.9333 \
 *                                   --powerhouse 29.2167,81.9167 \
 *                                   --name "Himal Hydropower Project" --out himal.pdf
 *
 * Without these the app sites the scheme itself: `discover()` searches the reach
 * and takes the best layout it finds. That is the right default and it is not
 * what a developer with a bounding box wants — they have already decided where
 * the weir and the powerhouse go, and the report has to describe THAT scheme or
 * it is describing a different project.
 *
 * The two ends can only sit on vertices of the studied river, so both points
 * snap and the snap distance is printed. A caller who is not told how far their
 * coordinate moved will read the report as describing the point they asked for.
 */
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const coord = (s) => {
  if (!s) return null;
  const [lat, lon] = s.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`could not read "${s}" as lat,lon`);
  }
  return { lat, lon };
};
const INTAKE = coord(flag('--intake'));
const POWERHOUSE = coord(flag('--powerhouse'));
if (Boolean(INTAKE) !== Boolean(POWERHOUSE)) {
  throw new Error('--intake and --powerhouse go together: one alone cannot pin a layout');
}
const NAME = flag('--name') ?? 'Proposed Hydropower Project';
const DEVELOPER = flag('--developer') ?? '—';

const positional = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) i++;
  else positional.push(process.argv[i]);
}

// The click chooses which river is studied, so it goes on the intake when one
// is given — the studied reach must be the one the weir sits on.
const LAT = INTAKE ? INTAKE.lat : Number(positional[0] ?? 27.65);
const LON = INTAKE ? INTAKE.lon : Number(positional[1] ?? 85.9);
const OUT = flag('--out') ?? (INTAKE ? 'report.pdf' : (positional[2] ?? 'report.pdf'));
// How long to let the context move before capturing anyway. Terrain streams in
// and the search improves while it does, so a remote site with cold tiles takes
// longer than a cached one; the default is generous and the flag exists for
// when it is not enough.
const SETTLE_MS = Number(flag('--settle-ms') ?? 120_000);
const PORT = 5199;

const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await server.listen();
console.log(`vite on ${PORT}`);

const ctx = await chromium.launchPersistentContext('pipeline/.cache/report-profile', {
  channel: 'chrome',
  headless: true,
  viewport: { width: 1600, height: 1000 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => console.log('  page error:', e.message));

const url = `http://localhost:${PORT}/#map=12.00/${LAT.toFixed(4)}/${LON.toFixed(4)}&at=${LAT.toFixed(5)},${LON.toFixed(5)}`;
await page.goto(url, { waitUntil: 'load' });
console.log(`opened ${LAT}, ${LON} — waiting for a scheme`);

// The scheme arrives after flow, terrain and the search; the context is only
// worth reading once it carries one.
await page.waitForFunction(
  () => {
    const c = window.__exportCtx;
    return Boolean(c && c.selected && c.schemes && c.schemes.length);
  },
  { timeout: 240_000 }
);
console.log('scheme found — waiting for the asynchronous screens to settle');

/**
 * A SCHEME IS NOT A FINISHED REPORT, AND CAPTURING ON ONE MADE THE PDF A LOTTERY.
 *
 * The connectivity, pondage, road-access, land-cover and glacier screens all
 * resolve after the scheme does — they walk the river network or fetch terrain.
 * Capturing the moment `selected` appeared meant whichever of them had finished
 * got into the document and the rest printed as absent. Two renders of the same
 * coordinate minutes apart disagreed about whether 43 upstream lakes existed or
 * none did, and neither run said anything was missing: a null screen and a
 * genuinely empty screen read identically downstream.
 *
 * So wait for the context to stop CHANGING rather than for any particular field.
 * Three consecutive quiet samples over about two seconds, with a ceiling so a
 * screen that never settles delays the render instead of hanging it.
 */
const waitSettled = () => page.evaluate(async (ceilingMs) => {
  const fields = [
    'upstreamConnectivity', 'glaciers', 'cascade', 'pondage', 'pondageSweep', 'roadAccess',
    'landcover', 'geologyUnits', 'grid', 'sediment', 'designSweep', 'uncertainty',
  ];
  /**
   * THE SCHEME'S OWN NUMBERS ARE IN THE FINGERPRINT, NOT JUST WHICH SCREENS EXIST.
   *
   * Watching only presence was not enough: the search keeps improving while
   * terrain streams in, so `selected` appears early and then MOVES. Capturing on
   * first appearance produced a 6.0 MW scheme on a 5.5 km2 catchment with no
   * upstream lakes, where the same coordinate settles at 20.3 MW with four lakes
   * 42 km up the flow path. Those are not two views of one project; they are two
   * different projects, and the report was printing whichever one the race
   * happened to hand it.
   */
  const shot = () => {
    const c = window.__exportCtx ?? {};
    const s = c.selected;
    return [
      fields.map((f) => (c[f] == null ? '0' : '1')).join(''),
      s ? `${s.i}/${s.j}/${s.capacityMW.toFixed(3)}/${s.waterwayKm.toFixed(3)}` : '-',
      c.schemes ? c.schemes.length : 0,
      c.upstreamConnectivity ? c.upstreamConnectivity.lakes.length : -1,
    ].join('|');
  };
  let prev = shot();
  let quiet = 0;
  let moves = 0;
  const started = Date.now();
  while (quiet < 4 && Date.now() - started < ceilingMs) {
    await new Promise((r) => setTimeout(r, 700));
    const now = shot();
    if (now === prev) quiet += 1;
    else {
      quiet = 0;
      moves += 1;
    }
    prev = now;
  }
  const c = window.__exportCtx ?? {};
  return {
    waitedMs: Date.now() - started,
    moves,
    stable: quiet >= 4,
    scheme: c.selected
      ? { mw: Number(c.selected.capacityMW.toFixed(2)), i: c.selected.i, j: c.selected.j }
      : null,
    present: fields.filter((f) => c[f] != null),
    absent: fields.filter((f) => c[f] == null),
  };
}, SETTLE_MS);

const describe = (r) => {
  console.log(
    `  settled after ${(r.waitedMs / 1000).toFixed(1)}s, ${r.moves} change(s) seen` +
      `${r.stable ? '' : ' — STILL MOVING, capture is not reproducible'}`
  );
  if (r.scheme) console.log(`  scheme: ${r.scheme.mw} MW, vertices ${r.scheme.i}-${r.scheme.j}`);
  if (r.absent.length) console.log(`  absent (genuinely, not a race): ${r.absent.join(', ')}`);
};

let settled = await waitSettled();
describe(settled);

if (INTAKE && POWERHOUSE) {
  /**
   * Pin the layout, then WAIT AGAIN.
   *
   * Moving both ends re-runs `evaluate`, the seventeen-point design sweep, the
   * pondage screen and the land-cover walk. Capturing straight after the pin
   * would print the searched scheme's figures under the pinned scheme's
   * coordinates, which is the exact race the settle loop above exists to stop.
   */
  const placed = await page.evaluate(
    ([a, b]) => window.__placeScheme(a, b),
    [INTAKE, POWERHOUSE]
  );
  if (!placed || !placed.ok) {
    throw new Error(`could not pin the layout: ${placed ? placed.why : 'no hook'}`);
  }
  console.log(
    `pinned: intake ${placed.intake.lat.toFixed(5)}, ${placed.intake.lon.toFixed(5)} ` +
      `(snapped ${(placed.intake.snapKm * 1000).toFixed(0)} m) → powerhouse ` +
      `${placed.powerhouse.lat.toFixed(5)}, ${placed.powerhouse.lon.toFixed(5)} ` +
      `(snapped ${(placed.powerhouse.snapKm * 1000).toFixed(0)} m)` +
      `  [vertices ${placed.intake.index}-${placed.powerhouse.index} of ${placed.pathLength}]`
  );
  console.log('re-settling after the move');
  settled = await waitSettled();
  describe(settled);
}
console.log('capturing figures (map layers are toggled for each)');

const html = await page.evaluate(async ({ name, developer }) => {
  const mod = await import('/src/report.ts');
  const figures = await window.__captureFigures();
  return mod.deskStudyHtml(
    window.__exportCtx,
    {
      projectName: name,
      developer,
      consultant: 'HydroRecon screening',
    },
    figures
  );
}, { name: NAME, developer: DEVELOPER });
mkdirSync('pipeline/.cache', { recursive: true });
writeFileSync('pipeline/.cache/report.html', html);
console.log(`report html: ${(html.length / 1024 / 1024).toFixed(2)} MB`);

// Print from a page of its own so the app's stylesheet cannot leak in.
const printer = await ctx.newPage();
await printer.setContent(html, { waitUntil: 'load' });
// Figures are data: URLs, so they decode locally — but they must finish before
// print, or the maps come out blank for the same reason as above.
await printer.evaluate(() =>
  Promise.all(
    [...document.images].filter((i) => !i.complete).map((i) => i.decode().catch(() => {}))
  )
);
await printer.pdf({ path: OUT, format: 'A4', printBackground: true, preferCSSPageSize: true });

await ctx.close();
await server.close();
console.log(`wrote ${OUT}`);
