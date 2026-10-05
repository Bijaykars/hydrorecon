/**
 * Put a DHM index at the canonical path when the licensed one is absent.
 *
 *   node pipeline/restore-dhm-records.mjs      (also run by npm postinstall)
 *
 * `src/data/dhm-records.json` is imported statically by src/dhm.ts and
 * src/engine/fdcshape.ts and read by twenty-one harnesses in checks/. It is
 * also gitignored, because the discharge statistics in it are not
 * redistributable (LICENSES.md, blocker 1). A fresh clone therefore has no
 * file at that path, and a missing JSON import is a build error rather than a
 * fallback.
 *
 * So the identity-only twin is copied into place, ONCE, only when nothing is
 * there. That is what makes "the full file is loaded in preference" true
 * without a resolver: a licence holder's own index is never overwritten, and
 * dropping the full one in later takes effect on the next build with no flag
 * to remember.
 *
 * COPIED RATHER THAN ALIASED on purpose. A Vite alias would move the app and
 * leave `checks/*.mjs` reading whichever file is at the literal path — so the
 * accuracy harnesses would have silently scored the reduced index on the one
 * machine that holds the real one. Harness rule 1: a comparison that cannot
 * tell which inputs it ran on is worse than no comparison.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const FULL = at('src/data/dhm-records.json');
const PUBLIC = at('src/data/dhm-records.public.json');

if (existsSync(FULL)) {
  console.log('dhm: src/data/dhm-records.json present, left alone');
} else if (existsSync(PUBLIC)) {
  copyFileSync(PUBLIC, FULL);
  console.log(
    'dhm: no licensed index found — copied dhm-records.public.json (station identity only).\n' +
      '     Gauge transfer and the flow-duration shape check are unavailable until the full\n' +
      '     index is rebuilt with pipeline/build-dhm-records.mjs from the DHM yearbooks.'
  );
} else {
  // Neither file: nothing to do and nothing to say beyond this, because the
  // import will fail loudly at build time, which is the honest outcome.
  console.log('dhm: neither dhm-records.json nor dhm-records.public.json is present');
}
