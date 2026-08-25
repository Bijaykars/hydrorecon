/**
 * A fingerprint of every module that can change a reported number.
 *
 * WHY IT IS SHARED. Both validation builders stamp their rows with this, and
 * for a while only one of them had it — so the curated ten-plant page could
 * claim "these results use the same code as the app" while sitting four days
 * behind flowchoice.ts, modified-hydest.ts, discover.ts and rivers.ts. A
 * signature that lives in one builder is a signature the other cannot honour.
 *
 * WHY THE LIST KEEPS GROWING. It started at discover/validate/rivers/hydest.
 * It missed src/dhm.ts, which decides whether a site uses a measured record at
 * all — active on two thirds of the fleet — so editing the transfer rule left
 * the signature unchanged and rows that happened not to be re-sampled kept
 * their old answers under new code. Then it missed turbine.ts, waterway.ts,
 * hydro.ts and units.ts, so correcting rated power to sit on the turbine curve
 * at design flow moved every capacity by about 3% invisibly.
 *
 * The rule that follows: if editing a file can move a number the harness
 * reports, it belongs here. Covering too much costs one re-run. Covering too
 * little silently invalidates every comparison ever made with it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const ENGINE_FILES = [
  'src/engine/discover.ts',
  'src/engine/hydest.ts',
  'src/engine/modified-hydest.ts',
  'src/engine/mhsp.ts',
  'src/engine/flowchoice.ts',
  'src/engine/fdcshape.ts',
  'src/engine/turbine.ts',
  'src/engine/waterway.ts',
  'src/engine/hydro.ts',
  'src/engine/units.ts',
  'src/engine/uncertainty.ts',
  'src/validate.ts',
  'src/rivers.ts',
  'src/dhm.ts',
  'src/overrides.ts',
  'src/measured.ts',
];

/** Comments and whitespace are not behaviour, so they must not move the hash. */
const strip = (t) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, '');

export function engineSignature() {
  const src = ENGINE_FILES.map((f) => strip(readFileSync(f, 'utf8'))).join('|');
  return createHash('sha1').update(src).digest('hex').slice(0, 12);
}
