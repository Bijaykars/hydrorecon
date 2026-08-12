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

/** Set by `npm run desktop:dev` so the window points at Vite instead of dist/. */
const DEV_URL = process.env.GHATTA_DEV_URL;
const DIST = path.join(__dirname, '..', 'dist');

// The app fetches its bundled river network with fetch(), which Chromium
// refuses over file://. Serving the build from a real scheme instead keeps
// fetch, workers and caching all behaving exactly as they do on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function serveFromDist() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
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
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0f14', // matches the app, so no white flash on launch
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

  win.loadURL(DEV_URL || 'app://ghatta/index.html');

  // Outbound links open in the real browser, not a chrome-less window the
  // user cannot navigate.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

app.whenReady().then(() => {
  if (!DEV_URL) serveFromDist();
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
