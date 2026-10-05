/**
 * Desktop shell. Loads the exact same build the website serves — there is one
 * app, not two, so the engine can never drift between them.
 *
 * CommonJS on purpose: Electron's main process does not load ESM from a
 * package marked "type": "module".
 */
const { app, BrowserWindow, protocol, net, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLocalStores, dataRoot } = require('./local-stores.cjs');
const windowState = require('./window-state.cjs');

/** Set by `npm run desktop:dev` so the window points at Vite instead of dist/. */
const DEV_URL = process.env.GHATTA_DEV_URL;
const DIST = path.join(__dirname, '..', 'dist');

/**
 * Where the local data stores are looked for, in order: the executable's own
 * folder for an installed build, then the repo root for `desktop:dev`.
 * HYDRORECON_DATA_DIR overrides both — see desktop/local-stores.cjs.
 *
 * Nothing here is bundled: GEDTM30 alone is ~0.97 GB. A `sources/` folder put
 * beside the EXE is picked up on the next launch, and its absence costs each
 * consumer its documented fallback and nothing else.
 */
const DATA_ROOT = dataRoot([path.dirname(process.execPath), path.join(__dirname, '..')]);

// The app fetches its bundled river network with fetch(), which Chromium
// refuses over file://. Serving the build from a real scheme instead keeps
// fetch, workers and caching all behaving exactly as they do on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

/**
 * The local stores, probed once at startup. Null until then, and null forever
 * if the probe itself fails — the handler below then behaves exactly as it did
 * before these routes existed.
 */
let stores = null;

/**
 * Answer the store routes out of DATA_ROOT, or null for "not one of mine".
 *
 * A miss falls through to the static handler, which serves index.html with a
 * 200 — which is precisely what the dev server does for an unserved store
 * route, and what every consumer in src/ is already written to survive.
 */
function localStoreResponse(url) {
  let hit = null;
  try {
    hit = stores && stores.resolve(url.pathname + url.search);
  } catch {
    return null; // a store route must never take the main process down
  }
  if (!hit) return null;
  const headers = { 'Content-Type': hit.contentType };
  if (hit.cacheControl) headers['Cache-Control'] = hit.cacheControl;
  if (!hit.file) return new Response(hit.body, { status: 200, headers });
  // Streamed, not read whole: a survey sheet is megabytes.
  return net
    .fetch(pathToFileURL(hit.file).toString())
    .then((r) => new Response(r.body, { status: r.status, headers }))
    .catch(() => null);
}

function serveFromDist() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const store = await localStoreResponse(url);
    if (store) return store;
    const rel = decodeURIComponent(url.pathname);
    // Anything that is not a real file is the SPA entry point.
    const target = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
    const onDisk = path.join(DIST, target);
    // Never serve outside dist/, whatever the URL claims.
    if (!onDisk.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(onDisk).toString()).catch(() =>
      net.fetch(pathToFileURL(path.join(DIST, 'index.html')).toString())
    );
  });
}

function createWindow() {
  const saved = windowState.load();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    ...saved,
    minWidth: 900,
    minHeight: 600,
    // Hidden until the first frame is painted, on the app's own ink — the two
    // together are what stop the white flash on launch.
    show: false,
    backgroundColor: '#0e0f11', // --color-bg in src/app.css
    title: 'Ghatta',
    autoHideMenuBar: true,
    webPreferences: {
      // The app is a static page talking to public APIs. It has no need for
      // Node, so it does not get it.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    if (saved && saved.maximized) win.maximize();
    win.show();
  });
  windowState.track(win);

  win.loadURL(DEV_URL || 'app://ghatta/index.html');

  // Outbound links open in the real browser, not a chrome-less window the
  // user cannot navigate.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(async () => {
  if (!DEV_URL) {
    // Under desktop:dev the window points at Vite, which serves these itself.
    stores = await createLocalStores({
      root: DATA_ROOT,
      topoDir: process.env.HYDRORECON_TOPO_DIR || process.env.GHATTA_TOPO_DIR,
    }).catch(() => null);
    for (const note of stores ? stores.notes : []) console.log(note);
    serveFromDist();
  }
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
