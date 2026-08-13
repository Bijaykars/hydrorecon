/**
 * Run the validation set and commit the result.
 *
 *   npm run build:validation
 *
 * WHY A BROWSER: the point of the exercise is that the numbers on the
 * validation page come from the SAME code the app runs — same river snapping,
 * same DEM sampling, same flow fetch, same engine. Re-implementing that chain
 * in Node would create a second pipeline that could quietly diverge from the
 * first, and a validation of the copy validates nothing. So a headless Chrome
 * loads the dev server and imports src/validate.ts, which imports the app's
 * own modules.
 *
 * The output is committed (src/data/validation.json) rather than computed live:
 * a validation that silently re-runs is a validation that can silently change.
 * Re-run this script to refresh it; the page shows the date it was produced.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const OUT = 'src/data/validation.json';
const PORT = 5199;

const spec = JSON.parse(readFileSync('pipeline/plants.json', 'utf8'));

console.log(`starting vite on :${PORT}…`);
const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[validate]')) console.log(' ', t.slice(10));
});
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });

console.log(`running ${spec.plants.length} plants through the app's own engine…`);
const results = await page.evaluate(
  async (plants) => {
    const m = await import('/src/validate.ts');
    return m.validateAll(plants, (name, done, total) =>
      console.log(`[validate] ${done + 1}/${total} ${name}`)
    );
  },
  spec.plants
);

await browser.close();
await server.close();

// Marry each result back to its plant record so the page is self-contained.
const plants = spec.plants.map((p) => ({
  ...p,
  result: results.find((r) => r.name === p.name) ?? { name: p.name, ok: false, error: 'no result' },
}));

const failures = plants.filter((p) => !p.result.ok);
for (const f of failures) console.log(`  FAILED ${f.name}: ${f.result.error}`);

const out = {
  _what:
    'Ghatta run at ten built Nepali plants with its shipped defaults — same engine and data ' +
    'sources as the app, coordinates from public records, no per-plant tuning.',
  _generated: new Date().toISOString().slice(0, 10),
  _appDefaults: { exceedance: 'Q40', efficiency: 0.96, residualFrac: 0.1 },
  plants,
};
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\nwrote ${OUT}: ${plants.length - failures.length}/${plants.length} plants ran`);

for (const p of plants) {
  if (!p.result.ok) continue;
  const r = p.result.predicted;
  const head = p.actual.head
    ? `head ${r.grossHeadM.toFixed(0)}/${p.actual.head} (${p.actual.headBasis})`
    : 'head n/p';
  console.log(
    `  ${p.name.padEnd(20)} ${head.padEnd(26)} Q ${r.designFlowCms.toFixed(1)}/${p.actual.designQ ?? '—'}  ` +
      `cap ${r.capacityMW.toFixed(1)}/${p.actual.capacityMW} MW  energy ${r.energyGwh.toFixed(0)}/${p.actual.energyGwh} GWh`
  );
}
