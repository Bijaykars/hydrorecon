/**
 * Put an analogue table at the canonical path when the licensed one is absent.
 *
 *   node pipeline/restore-flow-analogues.mjs      (also run by npm postinstall)
 *
 * Same mechanism, and same reasons, as `restore-dhm-records.mjs`:
 * `src/data/flow-analogues.json` is imported statically by
 * src/HydrologyComparison.tsx and gitignored because its `truth` field is DHM's
 * measured flow, so a fresh clone has nothing there and a missing JSON import is
 * a build error. The truth-free twin is COPIED, once, only when nothing is in
 * place — never aliased, never overwriting a licence holder's own table.
 */
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const FULL = at('src/data/flow-analogues.json');
const PUBLIC = at('src/data/flow-analogues.public.json');

if (existsSync(FULL)) {
  console.log('analogues: src/data/flow-analogues.json present, left alone');
} else if (existsSync(PUBLIC)) {
  copyFileSync(PUBLIC, FULL);
  console.log(
    'analogues: no licensed table found — copied flow-analogues.public.json (donor flows withheld).\n' +
      '           The analogue flow estimate is unavailable until the full table is rebuilt with\n' +
      '           `npm run probe:flow-analogues -- --build` from the DHM records.'
  );
} else {
  console.log('analogues: neither flow-analogues.json nor flow-analogues.public.json is present');
}
