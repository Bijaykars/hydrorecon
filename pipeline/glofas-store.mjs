/**
 * Read daily discharge for one grid cell straight off local disk.
 *
 * Built by pipeline/build-glofas-store.py from the ECMWF download. This is the
 * same GloFAS reanalysis Open-Meteo serves — not a substitute for it, the
 * source of it — so a run answered from here and a run answered from the
 * network produce the same numbers.
 *
 * WHY IT EXISTS. Sweeping two hundred plants through the free API exhausted the
 * quota in an afternoon and earned a twelve-hour pause, which made measurement
 * impossible: an A/B has to run the same sites twice, and the second run was
 * always the one refused. Locally there is no limit, so a comparison costs
 * nothing to repeat and every outstanding question becomes answerable.
 *
 * The file is read with positional seeks rather than loaded whole. One cell is
 * about fifteen kilobytes; the store is a couple of hundred megabytes, and
 * holding all of it resident to answer a few hundred point queries would be
 * paying two hundred megabytes for nothing.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';

/**
 * Repo-relative by default, because every harness here runs from the repo
 * root. HYDRORECON_GLOFAS_STORE points it elsewhere, which is how the packaged
 * desktop shell reads a store sitting beside the executable instead.
 */
const storePath = () => process.env.HYDRORECON_GLOFAS_STORE || 'pipeline/.cache/glofas-nepal.bin';
const MAGIC = 0x474e5031;
const HEADER = 40; // 9 x 4 bytes, then the step

let store = null;

/** Open the store once, or return null if it has not been built. */
function open() {
  if (store !== null) return store;
  const PATH = storePath();
  if (!existsSync(PATH)) return (store = false);
  const fd = openSync(PATH, 'r');
  const head = Buffer.alloc(HEADER);
  readSync(fd, head, 0, HEADER, 0);
  if (head.readUInt32LE(0) !== MAGIC) {
    closeSync(fd);
    throw new Error(`${PATH}: bad magic — rebuild with pipeline/build-glofas-store.py`);
  }
  store = {
    fd,
    nLat: head.readUInt32LE(4),
    nLon: head.readUInt32LE(8),
    nDays: head.readUInt32LE(12),
    startOrdinal: head.readInt32LE(16),
    latTop: head.readInt32LE(20) / 1e6,
    lonLeft: head.readInt32LE(24) / 1e6,
    lo: head.readFloatLE(28),
    hi: head.readFloatLE(32),
    step: head.readInt32LE(36) / 1e6,
  };
  return store;
}

/**
 * Ordinal day 1 is 0001-01-01 in Python's proleptic Gregorian calendar, which
 * is what the builder wrote. 719163 is the ordinal of 1970-01-01, so this
 * converts to the epoch the Date object understands.
 */
const PY_EPOCH = 719163;
const iso = (ordinal) => new Date((ordinal - PY_EPOCH) * 864e5).toISOString().slice(0, 10);

/** Is the store present and usable? */
export const hasGlofasStore = () => open() !== false;

/** What the store covers, for a harness that wants to say so. */
export function glofasCoverage() {
  const s = open();
  if (!s) return null;
  return { from: iso(s.startOrdinal), to: iso(s.startOrdinal + s.nDays - 1), days: s.nDays };
}

/**
 * Daily discharge at a point, in Open-Meteo's own response shape.
 *
 * Returns null outside the grid or where the cell carries no record, so a
 * caller can fall through to the network rather than inventing a dry river.
 */
export function glofasSeries(lat, lon) {
  const s = open();
  if (!s) return null;

  const row = Math.round((s.latTop - lat) / s.step);
  const col = Math.round((lon - s.lonLeft) / s.step);
  if (row < 0 || row >= s.nLat || col < 0 || col >= s.nLon) return null;

  const cell = row * s.nLon + col;
  const buf = Buffer.alloc(s.nDays * 2);
  readSync(s.fd, buf, 0, buf.length, HEADER + cell * s.nDays * 2);

  const logLo = Math.log(s.lo);
  const span = Math.log(s.hi) - logLo;
  const time = [];
  const river_discharge = [];
  let seen = 0;
  for (let d = 0; d < s.nDays; d++) {
    const q = buf.readUInt16LE(d * 2);
    time.push(iso(s.startOrdinal + d));
    if (q === 0) {
      river_discharge.push(null);
      continue;
    }
    seen++;
    river_discharge.push(Math.exp(logLo + ((q - 1) / 65534) * span));
  }
  if (seen === 0) return null;

  return {
    // The cell centre, not the requested point — the same thing Open-Meteo
    // reports back, and what the app uses to key its own cache.
    latitude: s.latTop - row * s.step,
    longitude: s.lonLeft + col * s.step,
    elevation: 0,
    daily: { time, river_discharge },
  };
}
