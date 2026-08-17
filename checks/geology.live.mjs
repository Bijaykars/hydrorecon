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

const waitForStudy = async () => {
  await page.getByText('engineering geology sources', { exact: true }).waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => document.body.textContent?.includes('small-scale regional samples'), null, { timeout: 30_000 });
};

// Upper Seti/Kaski: inside legacy 62 P/15 publication footprint.
await page.goto(`${base}#at=28.2590,83.9750&map=11/28.2590/83.9750`, { waitUntil: 'domcontentloaded' });
await waitForStudy();
const hitText = await page.locator('body').innerText();
if (!/official map publication(?:s)? cover this reach/i.test(hitText)) throw new Error('DMG map-hit statement missing');
if (!/62 P\/(?:15|16)/i.test(hitText)) {
  console.error(hitText.split('\n').filter((line) => /geolog|DMG|62 P\//i.test(line)).join('\n'));
  throw new Error('expected Kaski-area DMG sheet 62 P/15 or 62 P/16 missing');
}
if (!/usable-quality maps are hard-copy purchase products/i.test(hitText)) throw new Error('DMG purchase limitation missing');
if (!/Macrostrat · CC-BY 4.0/i.test(hitText)) throw new Error('Macrostrat licence missing');
if (!/cannot establish site lithology/i.test(hitText)) throw new Error('small-scale geology non-claim missing');

await page.waitForFunction(() => window.__map?.getSource('geology-sheets')?.serialize?.().data?.features?.length > 0, null, { timeout: 5_000 });

const mapState = await page.evaluate(() => {
  const map = window.__map;
  const source = map?.getSource('geology-sheets');
  return {
    fill: Boolean(map?.getLayer('geology-sheet-fill')),
    line: Boolean(map?.getLayer('geology-sheet-lines')),
    features: source?.serialize?.().data?.features?.length ?? 0,
  };
});
if (!mapState.fill || !mapState.line || mapState.features < 1) throw new Error(`geology map layer incomplete: ${JSON.stringify(mapState)}`);

// Click a visible publication boundary and verify evidence interaction does not move the site.
const beforeHash = await page.evaluate(() => location.hash);
const boundary = await page.evaluate(() => {
  const map = window.__map;
  const feature = map.getSource('geology-sheets').serialize().data.features[0];
  const points = feature.geometry.coordinates[0].map((coordinate) => map.project(coordinate));
  return points.find((point) => point.x > 8 && point.x < innerWidth - 8 && point.y > 8 && point.y < innerHeight - 8) ?? null;
});
if (boundary) {
  await page.mouse.click(boundary.x, boundary.y);
  await page.getByText('Footprint marks publication availability, not mapped site geology.').waitFor({ timeout: 5_000 });
  const afterHash = await page.evaluate(() => location.hash);
  if (afterHash !== beforeHash) throw new Error('geology evidence click moved the study point');
}

// Responsive panel: no horizontal document overflow at a narrow engineering field viewport.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const mobile = await page.evaluate(() => ({
  client: document.documentElement.clientWidth,
  scroll: document.documentElement.scrollWidth,
  geologyVisible: document.body.textContent?.includes('engineering geology sources') ?? false,
}));
if (!mobile.geologyVisible || mobile.scroll > mobile.client + 1) throw new Error(`mobile overflow: ${JSON.stringify(mobile)}`);

// Karnali/Dolpa no-catalog area: absence must remain an explicit catalog no-match.
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`${base}?qa=miss#at=29.0660,82.9800&map=10/29.0660/82.9800`, { waitUntil: 'domcontentloaded' });
await waitForStudy();
const missText = await page.locator('body').innerText();
if (!/No 1:50,000 publication matched this reach in the online catalog/i.test(missText)) {
  console.error(missText.split('\n').filter((line) => /publication|DMG|geolog|sheet/i.test(line)).join('\n'));
  throw new Error('DMG no-match statement missing');
}
if (!/catalog no-match, not an absence of geology/i.test(missText)) throw new Error('DMG no-match non-claim missing');

const relevantFailures = failedRequests.filter((line) => !/favicon|ERR_ABORTED/i.test(line));

// Global mode keeps only open regional context and must not leak DMG/BIPAD/GEM Nepal panels.
await page.goto(`${base}?qa=global#at=46.55,8.49&map=10/46.55/8.49`, { waitUntil: 'domcontentloaded' });
await page.getByText('engineering geology sources', { exact: true }).waitFor({ timeout: 90_000 });
await page.waitForFunction(() => document.body.textContent?.includes('small-scale regional samples'), null, { timeout: 30_000 });
const globalText = await page.locator('body').innerText();
if (!/open regional context/i.test(globalText) || !/Macrostrat · CC-BY 4.0/i.test(globalText)) {
  throw new Error('global regional geology context missing');
}
if (/DMG 1:50,000|recorded natural hazards|active fault context/i.test(globalText)) {
  throw new Error('Nepal-only geology/hazard context leaked into global mode');
}

if (consoleErrors.length) throw new Error(`console errors:\n${consoleErrors.join('\n')}`);
if (relevantFailures.length) throw new Error(`failed requests:\n${relevantFailures.join('\n')}`);

console.log(JSON.stringify({
  mapHit: { expectedSheet: '62 P/15 or 62 P/16 after river snap', ...mapState, popupTested: Boolean(boundary) },
  macrostrat: 'three point samples visible with CC-BY 4.0 and non-claim',
  mobile,
  noCatalogMatch: true,
  globalMode: 'Macrostrat only; Nepal panels absent',
  consoleErrors: consoleErrors.length,
  failedRequests: relevantFailures.length,
}, null, 2));

await browser.close();
preview?.kill();
