import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

const base = process.env.MAP_QA_URL ?? 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await mkdir('.codex-dev.map-qa', { recursive: true });
try {
  await page.goto(base);
  await page.waitForFunction(() => window.__map?.getSource('inventory-gauges'), null, { timeout: 60000 });
  await page.waitForFunction(() => window.__map?.getSource('licences')?.serialize().data.features.length > 1000);
  const startup = await page.evaluate(() => ({ center: window.__map.getCenter(), zoom: window.__map.getZoom(), at: new URLSearchParams(location.hash.slice(1)).get('at'), projects: window.__map.getSource('licences').serialize().data.features.length, gauges: window.__map.getSource('inventory-gauges').serialize().data.features.length, hazards: window.__map.getSource('hazards').serialize().data.features.length }));
  assert.equal(startup.at, null);
  assert.ok(startup.center.lat > 26 && startup.center.lat < 31 && startup.center.lng > 80 && startup.center.lng < 89, JSON.stringify(startup));
  assert.ok(startup.zoom > 5);
  assert.ok(startup.gauges > 300 && startup.hazards > 9000);
  await page.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['inventory-gauges', 'licences'] }).length > 50);
  const hoverPoint = await page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['inventory-gauges'] }).map((f) => window.__map.project(f.geometry.coordinates)).find((p) => p.x > 340 && p.x < 1100 && p.y > 180 && p.y < 800));
  assert.ok(hoverPoint);
  await page.mouse.move(hoverPoint.x, hoverPoint.y);
  await page.locator('.map-inspector strong').waitFor();
  const information = await page.locator('.map-inspector strong').innerText();
  await page.mouse.move(1060, 200);
  assert.equal(await page.locator('.map-inspector strong').innerText(), information, 'Information stays visible after leaving a feature');
  await page.screenshot({ path: '.codex-dev.map-qa/desktop.png' });

  const gaugeToggle = page.getByRole('button', { name: 'DHM river gauges', exact: true });
  await gaugeToggle.click();
  assert.equal(await page.evaluate(() => window.__map.getLayoutProperty('inventory-gauges', 'visibility')), 'none');
  await page.reload();
  await page.waitForFunction(() => window.__map?.getSource('inventory-gauges'));
  assert.equal(await page.evaluate(() => window.__map.getLayoutProperty('inventory-gauges', 'visibility')), 'none');
  await gaugeToggle.click();

  const search = page.getByLabel('Find a place or coordinate');
  await search.fill('Trishuli');
  assert.ok(await page.locator('.search-results button').count() > 0);
  await search.fill('91, 83');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  assert.ok(await page.getByRole('alert').count());
  await search.fill('28.2096, 83.9856');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.waitForTimeout(1100);
  assert.ok(await page.getByRole('button', { name: 'Study river here', exact: true }).isVisible());
  assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('at')), null);
  assert.equal(await page.evaluate(() => window.__map.getSource('focus').serialize().data.features[0].geometry.coordinates.join(',')), '83.9856,28.2096');

  await page.locator('.explorer-section summary').filter({ hasText: 'Area of interest' }).click();
  await page.getByLabel('South, west, north, east').fill('28, 84, 27, 85');
  await page.getByRole('button', { name: 'Apply bounds', exact: true }).click();
  assert.ok(await page.getByRole('alert').count());
  await page.getByLabel('South, west, north, east').fill('27.8, 83.5, 28.5, 84.5');
  await page.getByRole('button', { name: 'Apply bounds', exact: true }).click();
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.__map.getSource('explorer-area').serialize().data.features.length), 1);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export GeoJSON', exact: true }).click();
  const exported = await downloadPromise;
  assert.equal(exported.suggestedFilename(), 'hydrorecon-area.geojson');
  await page.getByRole('button', { name: 'Clear area', exact: true }).click();
  await page.getByRole('button', { name: 'Draw bounding box', exact: true }).click();
  await page.mouse.click(550, 350);
  await page.mouse.move(850, 600);
  await page.mouse.click(850, 600);
  assert.equal(await page.evaluate(() => new URLSearchParams(location.hash.slice(1)).get('at')), null, 'Drawing must not start a study');
  assert.equal(await page.evaluate(() => window.__map.getSource('explorer-area').serialize().data.features.length), 1);
  await page.getByRole('button', { name: 'Draw bounding box', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.drawing-instruction').count(), 0);

  for (const id of ['satellite', 'topo', 'street', 'dark']) {
    await page.getByRole('button', { name: id, exact: true }).click();
    if (id !== 'dark') assert.equal(await page.evaluate((id) => window.__map.getLayoutProperty(`basemap-${id}`, 'visibility'), id), 'visible');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: '.codex-dev.map-qa/mobile.png' });
  assert.ok(await page.getByRole('button', { name: 'Search & layers' }).isVisible());
  await page.getByRole('button', { name: 'Search & layers' }).click();
  assert.ok(await search.isVisible());
  await page.screenshot({ path: '.codex-dev.map-qa/mobile-tools.png' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${base}#map=9/46.55/8.49`);
  await page.waitForFunction(() => window.__map?.getSource('inventory-gauges'));
  const shared = await page.evaluate(() => window.__map.getCenter());
  assert.ok(Math.abs(shared.lat - 46.55) < 0.01 && Math.abs(shared.lng - 8.49) < 0.01, 'Explicit shared views must reopen');
  await search.fill('28.259, 83.975');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.getByRole('button', { name: 'Study river here', exact: true }).click();
  await page.locator('.reading-panel').waitFor({ timeout: 30000 });
  await page.getByText('Best scheme found', { exact: true }).waitFor({ timeout: 90000 });
  assert.equal(await page.evaluate(() => window.__map.getSource('licences').serialize().data.features.length), startup.projects);
  await page.getByRole('button', { name: 'clear', exact: true }).click();
  await page.getByRole('heading', { name: 'Start with the landscape.' }).waitFor();
  assert.equal(await page.evaluate(() => window.__map.getSource('licences').serialize().data.features.length), startup.projects, 'Clearing a study must preserve the national inventory');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ startup, shared, pageErrors: errors, checks: 'startup, persistent information/toggles, search, bounds, draw/cancel, GeoJSON export, basemaps, mobile, shared view, river analysis and clearing study passed' }, null, 2));
} finally { await browser.close(); }
