/**
 * Regenerate the README screenshots from the running app.
 *
 *   npm run dev          # in one terminal
 *   node scripts/shots.mjs
 *
 * Drives the Chrome already installed on the machine (playwright-core downloads
 * no browser of its own). Shots are element-tight so the text stays legible.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const CHROME =
  process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const OUT = 'docs';

// A GloFAS cell on the Potomac main stem, plus a USGS gauge a short way upstream.
const VIEW = '#12/38.875/-77.075';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2, // retina, so small type survives GitHub's downscaling
});

const shot = async (locator, name, label) => {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await locator.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png  — ${label}`);
};

console.log(`\ncapturing from ${BASE}${VIEW}`);
await page.goto(`${BASE}/${VIEW}`, { waitUntil: 'networkidle' });
await page.waitForSelector('.maplibregl-canvas');
await page.waitForTimeout(3500); // let vector tiles finish painting

const section = (heading) =>
  page.locator('section').filter({ has: page.locator(`h2:has-text("${heading}")`) });

// The site finder, before anything is selected.
await page.click('text=Scan this map view for flow');
await page.waitForSelector('table button:has-text("Analyse")', { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot(section('Find a site'), 'finder', 'scan the view for flow');

// Place the intake mid-map, which lands on the main-stem cell for this view.
const map = await page.locator('.map-shell').boundingBox();
await page.mouse.click(map.x + map.width / 2, map.y + map.height / 2);

await page.waitForSelector('text=/homes.+worth of electricity/', { timeout: 45000 });
// Wait for every spinner to clear rather than guessing a delay — otherwise a shot
// catches "Searching for gauges…" instead of the station table.
await page
  .waitForFunction(() => document.querySelectorAll('.spinner').length === 0, null, { timeout: 60000 })
  .catch(() => console.log('  (a panel was still loading)'));
await page.waitForTimeout(1500);

await shot(page.locator('.map-shell'), 'map', 'map with the intake placed');
await shot(section('What this river could power'), 'headline', 'plain-language result');
await shot(section('Flow-duration curve'), 'fdc', 'flow-duration curve + exceedance table');
await shot(section('The computation'), 'computation', 'formula, step by step');
await shot(section('Nearest gauging station'), 'gauge', 'measured cross-check');
await shot(section("Catchment context"), "catchment", "seasonality and rainfall");
await shot(section("Earthquake history"), "seismic", "seismicity from the USGS catalog");

// Terrain needs a second point downstream.
// Re-measure: the shots above scrolled the page, so the earlier box is stale.
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(800);
const map2 = await page.locator('.map-shell').boundingBox();
await page.mouse.click(map2.x + map2.width / 2 + 90, map2.y + map2.height / 2 + 60);
await page.waitForSelector('text=/Sampled \\d+ points/', { timeout: 60000 }).catch(() => {});
await page
  .waitForFunction(() => document.querySelectorAll('.spinner').length === 0, null, { timeout: 60000 })
  .catch(() => {});
await page.waitForTimeout(1200);
await shot(section('Terrain along the reach'), 'terrain', 'elevation profile and gross head');

// Second pass: Nepal, where no open gauge exists but DHM stations do.
console.log('\ncapturing the Nepal panels');
// A hash-only goto does NOT reload the document, so React would keep the previous
// intake and the Nepal-only sections would never render. Force a real reload.
await page.goto(`${BASE}/#12/27.92/85.15`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('.maplibregl-canvas');
await page.waitForTimeout(6000);
// mouse.click takes VIEWPORT coordinates, so the page must be at the top or the
// map's bounding box sits off-screen and every click misses.
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(600);
// Retry the click once: a click that lands before MapLibre is interactive is silently lost.
const npMap = await page.locator('.map-shell').boundingBox();
const result = page.locator('text=/homes.+worth of electricity/');
await page.mouse.click(npMap.x + npMap.width / 2, npMap.y + npMap.height / 2);
try {
  await result.waitFor({ timeout: 40000 });
} catch {
  console.log('  (first click lost, retrying)');
  await page.mouse.click(npMap.x + npMap.width / 2, npMap.y + npMap.height / 2);
  await result.waitFor({ timeout: 60000 });
}
await page
  .waitForFunction(() => document.querySelectorAll('.spinner').length === 0, null, { timeout: 60000 })
  .catch(() => {});
await page.waitForTimeout(1500);
await shot(page.locator('.map-shell'), 'nepal-map', 'terrain, rivers, gauges and licensed projects');
await shot(section('Is this river already taken'), 'nepal-projects', 'licensed hydropower projects nearby');
await shot(section('Upstream catchment'), 'nepal-catchment', 'catchment area from HydroRIVERS + cross-check');
await shot(section('Indicative revenue'), 'nepal-revenue', 'wet/dry energy at NEA PPA rates');
await shot(section('Nearest gauging station'), 'nepal-dhm', 'Nepal DHM stations, honestly framed');

await browser.close();
console.log(`\ndone -> ${OUT}/\n`);
