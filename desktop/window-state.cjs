/**
 * Remembers where the window was. Bounds and the maximised flag go to
 * userData/window-state.json on close — only on close, never on every resize
 * tick — and come back on the next launch.
 *
 * No dependency: this is forty lines, and the one package that does it also
 * polls resize events.
 *
 * CommonJS, like the rest of desktop/ — see main.cjs.
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, screen } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'window-state.json');

/** The saved rect must overlap SOME display by this much on both axes. */
const MIN_VISIBLE = 100;

/**
 * The saved state, or null on first run, a corrupt file, or a rect that no
 * longer lands on a connected display — an unplugged monitor must not strand
 * the window offscreen.
 */
function load() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return null;
  }
  const n = (v) => Number.isFinite(v) && v > 0;
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !n(s.width) || !n(s.height)) {
    return null;
  }
  const visible = screen.getAllDisplays().some(({ workArea: d }) => {
    const dx = Math.min(s.x + s.width, d.x + d.width) - Math.max(s.x, d.x);
    const dy = Math.min(s.y + s.height, d.y + d.height) - Math.max(s.y, d.y);
    return dx >= MIN_VISIBLE && dy >= MIN_VISIBLE;
  });
  if (!visible) return null;
  return { x: s.x, y: s.y, width: s.width, height: s.height, maximized: s.maximized === true };
}

/**
 * Wire a window up to be remembered. getNormalBounds() is used so that a
 * window closed maximised comes back maximised AND un-maximises to where the
 * user left it, not to the full screen.
 */
function track(win) {
  win.on('close', () => {
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    try {
      fs.writeFileSync(FILE(), JSON.stringify(state));
    } catch {
      // A failed save costs the next launch its position and nothing else.
    }
  });
}

module.exports = { load, track };
