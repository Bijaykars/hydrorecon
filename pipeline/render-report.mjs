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

const LAT = Number(process.argv[2] ?? 27.65);
const LON = Number(process.argv[3] ?? 85.9);
const OUT = process.argv[4] ?? 'report.pdf';
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
console.log('scheme found — capturing figures (map layers are toggled for each)');

const html = await page.evaluate(async () => {
  const mod = await import('/src/report.ts');
  const figures = await window.__captureFigures();
  return mod.deskStudyHtml(
    window.__exportCtx,
    {
      projectName: 'Proposed Hydropower Project',
      developer: '—',
      consultant: 'HydroRecon screening',
    },
    figures
  );
});
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
