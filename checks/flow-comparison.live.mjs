import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:5173/#at=28.35843,84.12292&map=12.64/28.3363/84.1158');
  await page.waitForFunction(() => window.__exportCtx?.selected, null, { timeout: 90000 });
  const panel = page.getByLabel('Hydrology method comparison', { exact: true });
  await panel.waitFor();
  await page.waitForTimeout(1200);
  const baseline = await page.evaluate(() => window.__exportCtx.selected);
  const table = page.getByRole('table', { name: 'Flow method results' });
  assert.equal(await table.locator('tbody tr').count(), 5);
  assert.match(await table.innerText(), /DHM catchment analogues/);
  assert.match(await table.innerText(), /Experimental/);
  await panel.getByText('DHM analogue evidence', { exact: true }).click();
  assert.equal(await panel.locator('li').count(), 5);
  assert.match(await panel.innerText(), /50 km excluded/);
  const downloadEvent = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export method comparison' }).click();
  const download = await downloadEvent;
  const csv = readFileSync(await download.path(), 'utf8');
  assert.ok(csv.includes('DHM catchment analogues') && csv.includes('comparison only'));
  assert.ok(csv.includes(String(baseline.grossHeadM)));
  assert.deepEqual(await page.evaluate(() => window.__exportCtx.selected), baseline, 'Inspecting/exporting comparison preserves active results');
  await panel.getByText('DHM analogue evidence', { exact: true }).click();
  await panel.scrollIntoViewIfNeeded();
  mkdirSync('.codex-dev.accuracy', { recursive: true });
  await page.screenshot({ path: '.codex-dev.accuracy/comparison-desktop.png' });
  // A head audit belongs to the exact pair, not merely to the studied river.
  await panel.getByText('Head & catchment evidence', { exact: true }).click();
  await panel.getByRole('button', { name: 'Run detailed site audit' }).click();
  await page.evaluate(() => {
    const { path, selected } = window.__exportCtx;
    window.__placeScheme(path[selected.i], path[Math.max(selected.i + 1, selected.j - 2)]);
  });
  await page.waitForTimeout(500);
  assert.ok(await panel.getByRole('button', { name: 'Run detailed site audit' }).isEnabled(), 'Moving the layout invalidates the pending audit and clears its busy state');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await table.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.codex-dev.accuracy/comparison-mobile.png' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: 'five methods, donor evidence, CSV export, unchanged active results, stale audit invalidation, mobile overflow and runtime passed', baselineCapacityMW: baseline.capacityMW }));
} finally { await browser.close(); }
