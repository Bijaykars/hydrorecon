import { chromium } from 'playwright-core';
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

const waitForConnectivity = async () => {
  await page.getByText('upstream channel screen', { exact: true }).waitFor({ timeout: 90_000 });
  await page.waitForFunction(
    () => /have a candidate directed HydroRIVERS path/.test(document.body.textContent ?? ''),
    null,
    { timeout: 30_000 }
  );
};

// Lower Sapta Koshi: a deliberate dense-candidate stress case including
// transboundary lake centroids. This is useful for performance and the route cap.
await page.goto(`${base}#at=26.8600,87.1600&map=9/26.8600/87.1600`, { waitUntil: 'domcontentloaded' });
await waitForConnectivity();
const denseText = await page.locator('body').innerText();
const denseMatch = denseText.match(/(\d[\d,]*) mapped lake centroids · (\d[\d,]*) historical reports/);
if (!denseMatch || Number(denseMatch[1].replaceAll(',', '')) < 500) {
  throw new Error(`dense Koshi lake candidates missing: ${denseMatch?.[0] ?? 'no count'}`);
}
if (!/published significant positive expansion signal—not breach likelihood/i.test(denseText)) {
  throw new Error('lake expansion non-claim missing');
}
if (!/channel-connectivity candidates only/i.test(denseText)) throw new Error('connectivity non-claim missing');
await page.getByText('method, sources and required follow-up', { exact: true }).click();
const methodText = await page.locator('body').innerText();
if (!/GLO dataset ↗/i.test(methodText) || !/ICIMOD dangerous-lake assessment ↗/i.test(methodText)) {
  throw new Error('lake source or authoritative follow-up link missing');
}

await page.waitForFunction(() => {
  const map = window.__map;
  return map?.getSource('upstream-sources')?.serialize?.().data?.features?.length > 500;
}, null, { timeout: 10_000 });
const denseMap = await page.evaluate(() => {
  const map = window.__map;
  const points = map?.getSource('upstream-sources')?.serialize?.().data?.features ?? [];
  const routes = map?.getSource('upstream-routes')?.serialize?.().data?.features ?? [];
  return {
    sourcePoints: points.length,
    routeLines: routes.length,
    lakePoints: points.filter((feature) => feature.properties?.sourceType === 'lake').length,
    incidentPoints: points.filter((feature) => feature.properties?.sourceType === 'incident').length,
  };
});
if (denseMap.routeLines !== 40 || denseMap.sourcePoints < 1000) {
  throw new Error(`dense map state violates geometry cap/completeness: ${JSON.stringify(denseMap)}`);
}

// Pan to a mapped source if necessary, click it, and ensure evidence interaction
// opens its non-claim popup without moving the selected study coordinates.
const sourceCoordinate = await page.evaluate(() => {
  const features = window.__map.getSource('upstream-sources').serialize().data.features;
  return features.find((feature) => feature.properties.sourceType === 'lake')?.geometry.coordinates ?? null;
});
if (!sourceCoordinate) throw new Error('no lake source coordinate available for popup test');
await page.evaluate((coordinate) => window.__map.jumpTo({ center: coordinate, zoom: 11 }), sourceCoordinate);
await page.waitForTimeout(200);
const beforeAt = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('at'));
const sourcePixel = await page.evaluate((coordinate) => {
  const point = window.__map.project(coordinate);
  return { x: point.x, y: point.y };
}, sourceCoordinate);
await page.mouse.click(sourcePixel.x, sourcePixel.y);
await page.getByText('Channel-connectivity candidate only—not runout or GLOF exposure.').waitFor({ timeout: 5_000 });
const afterAt = await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('at'));
if (afterAt !== beforeAt) throw new Error('upstream evidence click moved the study point');

// Narrow field viewport: dense findings must not force horizontal scrolling.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const mobile = await page.evaluate(() => ({
  client: document.documentElement.clientWidth,
  scroll: document.documentElement.scrollWidth,
  panelVisible: document.body.textContent?.includes('upstream channel screen') ?? false,
}));
if (!mobile.panelVisible || mobile.scroll > mobile.client + 1) {
  throw new Error(`mobile overflow: ${JSON.stringify(mobile)}`);
}

// Kaski: sparse/zero-lake result must say why it is not GLOF clearance.
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${base}?qa=sparse#at=28.2590,83.9750&map=10/28.2590/83.9750`, { waitUntil: 'domcontentloaded' });
await waitForConnectivity();
const sparseText = await page.locator('body').innerText();
if (!/No GLO centroid met the snap and directed-route tests/i.test(sparseText)) {
  throw new Error('zero-lake statement missing');
}
if (!/Small omitted streams, centroid-to-outlet error and network breaks mean this is not GLOF clearance/i.test(sparseText)) {
  throw new Error('zero-lake non-clearance missing');
}

// Global mode must never inherit the Nepal lake/incident screen.
await page.goto(`${base}?qa=global#at=46.55,8.49&map=10/46.55/8.49`, { waitUntil: 'domcontentloaded' });
await page.getByText('engineering geology sources', { exact: true }).waitFor({ timeout: 90_000 });
const globalText = await page.locator('body').innerText();
if (/upstream channel screen|GLO dataset|ICIMOD dangerous-lake/i.test(globalText)) {
  throw new Error('Nepal upstream-connectivity evidence leaked into global mode');
}

const relevantFailures = failedRequests.filter((line) => !/favicon|ERR_ABORTED/i.test(line));
if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`);
if (relevantFailures.length) throw new Error(`failed requests:\n${relevantFailures.join('\n')}`);

console.log(JSON.stringify({
  denseKoshi: { counts: denseMatch[0], ...denseMap, popupWithoutSiteMove: true },
  sparseKaski: 'zero lakes explicitly not GLOF clearance',
  mobile,
  globalMode: 'Nepal upstream panel absent',
  consoleErrors: consoleErrors.length,
  failedRequests: relevantFailures.length,
}, null, 2));

await browser.close();
preview?.kill();
