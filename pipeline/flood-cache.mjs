/**
 * A disk cache for the discharge API, for harness runs only.
 *
 * The app caches fetched series in localStorage and keeps twelve of them. That
 * is the right number for someone studying a few sites — each series is forty
 * years of daily values and the quota is a few megabytes — and the wrong number
 * for sweeping a hundred plants, where everything evicts before the run ends.
 *
 * Rather than loosen the app's limit and risk quota failures for real users,
 * the harness intercepts the request itself and answers from disk. A coordinate
 * then costs one upstream request EVER, across every run and every A/B
 * configuration, which is what makes repeated measurement affordable at all.
 *
 * This is a CACHE, not a mock: the first request for a coordinate goes to the
 * real service and the bytes are stored verbatim. Nothing is synthesised, so a
 * cached run and a live run produce identical numbers.
 *
 * It also makes the A/B honest. Comparing two configurations means running the
 * same plants twice; without this the second run competes with the first for
 * the same rate limit and tends to be the one that fails, which silently biases
 * the comparison toward whichever configuration ran first.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { glofasCoverage, glofasSeries, hasGlofasStore } from './glofas-store.mjs';

const DIR = 'pipeline/.cache/flood';

/** Attach to a Playwright page or context. Returns a stats object. */
export async function attachFloodCache(target) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const stats = { hits: 0, misses: 0, errors: 0, local: 0 };

  /**
   * The local GloFAS store answers first, when it has been built.
   *
   * This is not a mock and not a second-best. Open-Meteo serves GloFAS; the
   * store IS GloFAS, subset to Nepal and downloaded from ECMWF. Answering from
   * it gives the same numbers with no rate limit, which is the difference
   * between an A/B that can be repeated and one that cannot.
   */
  const local = hasGlofasStore();
  if (local) {
    const c = glofasCoverage();
    console.log(`local GloFAS store: ${c.from} to ${c.to} (${c.days} days) — no network needed`);
  }

  await target.route('**://flood-api.open-meteo.com/**', async (route) => {
    const url = route.request().url();

    if (local) {
      const u = new URL(url);
      const lat = Number(u.searchParams.get('latitude'));
      const lon = Number(u.searchParams.get('longitude'));
      const series = Number.isFinite(lat) && Number.isFinite(lon) ? glofasSeries(lat, lon) : null;
      if (series) {
        stats.local++;
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(series),
        });
        return;
      }
    }

    const file = `${DIR}/${createHash('sha1').update(url).digest('hex')}.json`;

    if (existsSync(file)) {
      stats.hits++;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: readFileSync(file, 'utf8'),
      });
      return;
    }

    let response;
    try {
      response = await route.fetch();
    } catch {
      stats.errors++;
      route.abort();
      return;
    }
    const body = await response.text();

    // Only a genuine 200 is worth keeping. Storing a rate-limit refusal would
    // pin that plant to "failed" for every future run, which is exactly the
    // kind of quiet, self-inflicted wound this whole exercise keeps finding.
    if (response.status() === 200 && body.includes('river_discharge')) {
      writeFileSync(file, body);
      stats.misses++;
    } else {
      stats.errors++;
    }
    route.fulfill({ status: response.status(), contentType: 'application/json', body });
  });

  return stats;
}
