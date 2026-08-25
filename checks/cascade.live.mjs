import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const base = 'http://127.0.0.1:4173/';
const reachable = async () => fetch(base).then((response) => response.ok).catch(() => false);
let preview = null;
if (!(await reachable())) {
  preview = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4173'],
    { cwd: process.cwd(), stdio: 'ignore', windowsHide: true }
  );
  for (let attempt = 0; attempt < 50 && !(await reachable()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!(await reachable())) throw new Error('production preview did not start on port 4173');
}
process.on('exit', () => preview?.kill());

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const failedRequests = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('requestfailed', (request) => failedRequests.push(`${request.url()} — ${request.failure()?.errorText}`));

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
if (!/1,167 canonical geolocated projects/i.test(methodText) || !/live DoED register ↗/i.test(methodText)) {
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

// Downloaded GIS evidence must preserve the same provenance and non-claim.
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('button', { name: /GeoJSON/ }).click(),
]);
const downloadPath = await download.path();
if (!downloadPath) throw new Error('GeoJSON download has no readable path');
const geo = JSON.parse(await readFile(downloadPath, 'utf8'));
if (geo.hydrorecon_cascade?.upstreamCandidates !== upstream || geo.hydrorecon_cascade?.downstreamCandidates !== downstream) {
  throw new Error('GeoJSON cascade metadata differs from the visible screen');
}
const projectFeatures = geo.features.filter((feature) =>
  feature.properties?.part === 'DoED project coordinate-range midpoint interaction candidate'
);
if (projectFeatures.length !== upstream + downstream) throw new Error('GeoJSON omitted cascade project points');
if (!projectFeatures.every((feature) => /not a confirmed cascade/i.test(feature.properties.interpretation))) {
  throw new Error('GeoJSON cascade non-claim missing');
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
await page.getByText('engineering geology sources', { exact: true }).waitFor({ timeout: 90_000 });
const globalText = await page.locator('body').innerText();
if (/project interaction|live DoED register|system optimization guideline/i.test(globalText)) {
  throw new Error('Nepal DoED cascade evidence leaked into global mode');
}

const relevantFailures = failedRequests.filter((line) => !/favicon|ERR_ABORTED/i.test(line));
if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`);
if (relevantFailures.length) throw new Error(`failed requests:\n${relevantFailures.join('\n')}`);

console.log(JSON.stringify({
  denseKaliGandaki: { upstream, downstream, ...mapState, popupWithoutSiteMove: true },
  geojson: { projectPoints: projectFeatures.length, provenance: true },
  mobile,
  globalMode: 'Nepal DoED cascade panel absent',
  consoleErrors: consoleErrors.length,
  failedRequests: relevantFailures.length,
}, null, 2));

await browser.close();
preview?.kill();
