/**
 * Measure what a zoom/pan sweep actually costs over the network.
 *
 *   npm run dev
 *   node scripts/perf.mjs
 *
 * Written because "the map feels slow" needed a number. It found that DEM tiles
 * were 84% of all bytes on zoom (4.4 MB per sweep), which is what drove capping
 * the raster-dem source maxzoom and stopping hillshade at site scale.
 */
import { chromium } from 'playwright-core';

const PORT = process.env.PORT ?? 5173;
const b = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
});
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });

const stats = new Map();
p.on('response', async (r) => {
  const host = new URL(r.url()).host;
  const len = Number(r.headers()['content-length'] || 0);
  const s = stats.get(host) ?? { n: 0, bytes: 0 };
  s.n++;
  s.bytes += len;
  stats.set(host, s);
});

await p.goto(`http://localhost:${PORT}/#11/27.92/85.15`, { waitUntil: 'networkidle' });
await p.waitForSelector('.maplibregl-canvas');
await p.waitForTimeout(8000);

// Reset counters after initial load — we want the cost of interaction.
stats.clear();

// Instrument MapLibre's idle event from the page side.
await p.evaluate(() => {
  window.__zoomLog = [];
  const c = document.querySelector('.maplibregl-canvas');
  window.__t0 = performance.now();
  // Count painted frames to spot jank.
  window.__frames = 0;
  const tick = () => {
    window.__frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return !!c;
});

const box = await p.locator('.map-shell').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

const t0 = Date.now();
// Zoom in five levels, then back out, the way a user scans a valley.
for (const dir of [-1, -1, -1, -1, -1, 1, 1, 1, 1, 1]) {
  await p.mouse.move(cx, cy);
  await p.mouse.wheel(0, dir * 400);
  await p.waitForTimeout(700);
}
// Then a pan.
await p.mouse.move(cx, cy);
await p.mouse.down();
await p.mouse.move(cx - 300, cy - 150, { steps: 12 });
await p.mouse.up();
await p.waitForTimeout(3000);
const elapsed = Date.now() - t0;

const frames = await p.evaluate(() => window.__frames);
console.log(`\ninteraction: 10 zoom steps + 1 pan in ${(elapsed / 1000).toFixed(1)} s`);
console.log(`frames rendered: ${frames}  (~${(frames / (elapsed / 1000)).toFixed(0)} fps avg)`);
console.log('\nnetwork during interaction:');
let totN = 0;
let totB = 0;
for (const [host, s] of [...stats].sort((a, b) => b[1].bytes - a[1].bytes)) {
  totN += s.n;
  totB += s.bytes;
  console.log(`  ${host.padEnd(34)} ${String(s.n).padStart(4)} reqs  ${(s.bytes / 1024).toFixed(0).padStart(7)} KB`);
}
console.log(`  ${'TOTAL'.padEnd(34)} ${String(totN).padStart(4)} reqs  ${(totB / 1024).toFixed(0).padStart(7)} KB`);
await b.close();
