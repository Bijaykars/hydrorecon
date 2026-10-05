import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // An old saved preference with pondage enabled must not restore access lines.
  await page.addInitScript(() => { if (!localStorage.getItem('layout-qa')) {
    localStorage.setItem('hydrorecon.layers', JSON.stringify({ site: true }));
    localStorage.setItem('layout-qa', '1');
  } });
  await page.goto('http://127.0.0.1:5173/#at=28.30127,84.12791&map=12.20/28.3006/84.0633');
  await page.waitForFunction(() => window.__exportCtx?.selected && window.__map?.getSource('scheme'), null, { timeout: 90000 });
  const read = () => page.evaluate(() => ({ selected: window.__exportCtx.selected, path: window.__exportCtx.path,
    access: window.__map.getLayoutProperty('road-access-lines', 'visibility'),
    points: window.__map.getLayoutProperty('road-access-points', 'visibility'),
    pondage: window.__map.getLayoutProperty('pondage-fill', 'visibility') }));
  const initial = await read();
  assert.ok(initial.selected.waterwayKm <= 6 + 1e-9);
  assert.equal(initial.selected.i, 0);
  assert.equal(initial.access, 'none');
  assert.equal(initial.points, 'none');
  for (const limit of [10, 5, 6]) {
    await page.getByLabel('Maximum layout length', { exact: true }).selectOption(String(limit));
    await page.waitForTimeout(1000);
    const result = await read();
    assert.ok(result.selected && result.selected.waterwayKm <= limit + 1e-9);
    assert.equal(result.selected.i, 0);
  }
  const toggle = page.getByRole('button', { name: 'Road-access gaps', exact: true });
  const rejected = await page.evaluate(() => {
    const path = window.__exportCtx.path;
    return window.__placeScheme(path[0], path.find((p) => p.km > 7));
  });
  assert.equal(rejected.ok, false, 'Explicit coordinate placement also rejects an overlong layout');
  assert.match(rejected.why, /6 km limit/);
  await toggle.click();
  assert.equal((await read()).access, 'visible');
  assert.equal((await read()).pondage, initial.pondage);
  await toggle.click();
  assert.equal((await read()).access, 'none');
  await page.getByRole('button', { name: 'satellite', exact: true }).click();
  await page.waitForTimeout(1500);
  assert.equal((await read()).access, 'none');
  mkdirSync('.codex-dev.layout', { recursive: true });
  await page.screenshot({ path: '.codex-dev.layout/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ initialLengthKm: initial.selected.waterwayKm, checks: 'default cap, intake, 5/6/10 km controls, old preferences, independent access toggle, basemap, mobile, runtime passed' }));
} finally { await browser.close(); }
