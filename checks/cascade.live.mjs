import { chromium } from 'playwright-core';

// window.__exportCtx is a DEV-only hook, so this drives the Vite dev server
// rather than a built bundle. Override with QA_URL (e.g. a non-default port).
const base = process.env.QA_URL ?? 'http://127.0.0.1:5173/';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
// The first-run tour opens over the map and swallows clicks; mark it seen.
await page.addInitScript(() => localStorage.setItem('hydrorecon.tour.done', '1'));
const consoleErrors = [];
const failedRequests = [];
// Only the app's own origin counts: a basemap or terrain host being unreachable is not an app fault.
const own = (url) => url.startsWith(new URL(base).origin);
page.on('console', (message) => {
  if (message.type() === 'error' && own(message.location().url || base)) consoleErrors.push(message.text());
});
page.on('requestfailed', (request) => {
  if (own(request.url())) failedRequests.push(`${request.url()} — ${request.failure()?.errorText}`);
});

// High-order Kali Gandaki reach: deliberately dense upstream-project stress case.
await page.goto(`${base}#at=27.9700,83.5500&map=9/27.9700/83.5500`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(
  () => /project interaction\s*·\s*\d+ upstream\s*·\s*\d+ downstream/i.test(document.body.textContent ?? ''),
  null,
  { timeout: 90_000 }
);
const denseText = await page.locator('body').innerText();
const counts = denseText.match(/project interaction\s*·\s*([\d,]+) upstream\s*·\s*([\d,]+) downstream/i);
if (!counts) throw new Error('directed project candidate counts missing');
const upstream = Number(counts[1].replaceAll(',', ''));
const downstream = Number(counts[2].replaceAll(',', ''));
if (upstream < 30 || downstream < 1) {
  throw new Error(`dense Kali Gandaki screen unexpectedly sparse: ${counts[0]}`);
}
if (!/Network candidates only—not a confirmed cascade, shared-water finding, legal overlap or operating interface/i.test(denseText)) {
  throw new Error('cascade non-claim missing');
}
if (!/operating\/construction-stage candidate\(s\) must be checked first/i.test(denseText)) {
  throw new Error('advanced-project priority missing');
}

await page.getByText('method, official guidance and required confirmation', { exact: true }).click();
const methodText = await page.locator('body').innerText();
if (!/[0-9,]+ canonical geolocated projects/i.test(methodText) || !/live DoED register ↗/i.test(methodText)) {
  throw new Error('canonical registry audit or official source link missing');
}
if (!/DoED system optimization guideline ↗/i.test(methodText) || !/midpoint can snap to the wrong branch/i.test(methodText)) {
  throw new Error('official cascade guidance or midpoint limitation missing');
}

await page.waitForFunction(() => {
  const source = window.__map?.getSource('cascade-projects');
  return source?.serialize?.().data?.features?.length > 30;
}, null, { timeout: 10_000 });
const mapState = await page.evaluate(() => {
  const points = window.__map.getSource('cascade-projects').serialize().data.features;
  const routes = window.__map.getSource('cascade-routes').serialize().data.features;
  return {
    points: points.length,
    routes: routes.length,
    upstream: points.filter((feature) => feature.properties.direction === 'upstream').length,
    downstream: points.filter((feature) => feature.properties.direction === 'downstream').length,
    advanced: points.filter((feature) => feature.properties.advanced === 'yes').length,
  };
});
if (mapState.points !== upstream + downstream || mapState.routes > 30 || mapState.routes < 1) {
  throw new Error(`cascade map completeness/cap failure: ${JSON.stringify(mapState)}`);
}
if (mapState.upstream !== upstream || mapState.downstream !== downstream || mapState.advanced < 1) {
  throw new Error(`cascade map classifications differ from panel: ${JSON.stringify(mapState)}`);
}

// A project popup must explain the midpoint relation and must not move the study.
const projectCoordinate = await page.evaluate(() =>
  window.__map.getSource('cascade-projects').serialize().data.features[0]?.geometry.coordinates ?? null
);
if (!projectCoordinate) throw new Error('no cascade project point available for popup test');
await page.evaluate((coordinate) => window.__map.jumpTo({ center: coordinate, zoom: 11 }), projectCoordinate);
await page.waitForTimeout(200);
const beforeAt = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('at'));
const pixel = await page.evaluate((coordinate) => {
  const point = window.__map.project(coordinate);
  return { x: point.x, y: point.y };
}, projectCoordinate);
await page.mouse.click(pixel.x, pixel.y);
await page.getByText(/Midpoint topology is not a confirmed cascade/i).waitFor({ timeout: 5_000 });
const afterAt = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('at'));
if (afterAt !== beforeAt) throw new Error('cascade evidence click moved the study point');

// The computed screen the panel is drawn from must carry the same candidates and the
// same non-claim. (This used to be read back out of the GeoJSON export, which is gone;
// the export was only ever a vehicle for these values.)
const cascade = await page.evaluate(() => {
  const c = window.__exportCtx?.cascade;
  return c ? { up: c.upstream.length, down: c.downstream.length, limitation: c.limitation,
    routesIncluded: [...c.upstream, ...c.downstream].filter((p) => p.routeGeometryIncluded).length } : null;
});
if (!cascade) throw new Error('cascade screen missing from the export context');
if (cascade.up !== upstream || cascade.down !== downstream) {
  throw new Error('cascade screen differs from the visible panel');
}
if (!/Network relation does not prove shared water/i.test(cascade.limitation)) {
  throw new Error('cascade non-claim missing from the screen');
}

// Narrow field viewport: candidate lists and long project names must not overflow.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const mobile = await page.evaluate(() => ({
  client: document.documentElement.clientWidth,
  scroll: document.documentElement.scrollWidth,
  panelVisible: /project interaction/i.test(document.body.textContent ?? ''),
}));
if (!mobile.panelVisible || mobile.scroll > mobile.client + 1) {
  throw new Error(`mobile overflow: ${JSON.stringify(mobile)}`);
}

// Global mode must not inherit Nepal's register or topology screen.
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${base}?qa=global-cascade#at=46.55,8.49&map=10/46.55/8.49`, { waitUntil: 'domcontentloaded' });
// Wait on the region, not on a built scheme: a global scheme needs live terrain and flood
// services, and this check is about what Nepal's register must NOT put in the study.
await page.waitForFunction(() => window.__exportCtx?.region === 'global', null, { timeout: 90_000 });
await page.waitForTimeout(3_000);
if (await page.evaluate(() => window.__exportCtx.cascade) !== null) {
  throw new Error('Nepal DoED cascade screen leaked into the global study context');
}
const globalText = await page.locator('body').innerText();
if (/project interaction|live DoED register|system optimization guideline/i.test(globalText)) {
  throw new Error('Nepal DoED cascade evidence leaked into global mode');
}

const relevantFailures = failedRequests.filter((line) => !/favicon|ERR_ABORTED/i.test(line));
if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`);
if (relevantFailures.length) throw new Error(`failed requests:\n${relevantFailures.join('\n')}`);

console.log(JSON.stringify({
  denseKaliGandaki: { upstream, downstream, ...mapState, popupWithoutSiteMove: true },
  screen: { projectPoints: cascade.up + cascade.down, nonClaim: true },
  mobile,
  globalMode: 'Nepal DoED cascade panel absent',
  consoleErrors: consoleErrors.length,
  failedRequests: relevantFailures.length,
}, null, 2));

await browser.close();
