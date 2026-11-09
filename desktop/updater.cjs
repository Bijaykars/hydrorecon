/**
 * Self-update, from the GitHub release the owner publishes.
 *
 * THE SECURITY POSITION, which is the whole design. This app is NOT code-signed,
 * so electron-updater's Windows publisher-signature check is inert. Whoever can
 * publish to the GitHub repo can therefore run code on every installed copy.
 * That is accepted for a private tool, and it is bounded here by one rule:
 *
 *   there is always a deliberate user click between "a new version exists" and
 *   "an installer runs".
 *
 * So `autoInstallOnAppQuit` is FALSE. Its default is true, which would silently
 * run a downloaded installer the next time the user closes the window. The
 * download happens in the background; the install happens only through the
 * 'updater:install' IPC, which the renderer sends from a button.
 *
 * THE PINS, each of which is a library default we do not trust:
 *  - quitAndInstall(true, true): (isSilent, isForceRunAfter). The no-arg form
 *    runs the NSIS installer INTERACTIVELY, and with `oneClick: false` that is
 *    the full install wizard — users read "Restart" opening a wizard as a
 *    reinstall.
 *  - disableWebInstaller = true: electron-updater ships false, against its own
 *    docs, which say the web installer path is unsafe.
 *  - allowPrerelease = false, allowDowngrade = false: allowPrerelease flips to
 *    true on its own once the RUNNING version carries a prerelease component,
 *    and setting `channel` flips allowDowngrade as a side effect. Pinning both
 *    stops a later code path reintroducing a downgrade by accident.
 *    CONSEQUENCE: with allowPrerelease false the GitHub provider reads
 *    /releases/latest, so a release must be published as "Latest" with "Set as
 *    a pre-release" OFF, or installed copies stop seeing updates. Drafts are
 *    invisible too.
 *
 * Never a dialog, never blocking: a failed check is a log line. Status reaches
 * the renderer through setStatus() and nowhere else, so two surfaces cannot
 * disagree.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const FIRST_CHECK_MS = 10 * 1000; // let the window paint first
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** idle | checking | downloading | ready. Only 'ready' draws anything. */
let status = { state: 'idle' };
let autoUpdater = null;

function log(line) {
  const text = `[updater] ${line}`;
  console.log(text);
  try {
    fs.appendFileSync(
      path.join(app.getPath('userData'), 'updater.log'),
      `${new Date().toISOString()} ${text}\n`
    );
  } catch {
    // A log file that cannot be written must never matter.
  }
}

/** The one choke point: every state change goes through here. */
function setStatus(next) {
  status = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('updater:status', status);
  }
}

function checkNow() {
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'ready') return;
  setStatus({ state: 'checking' });
  // A failed check also fires the 'error' event below, which logs and resets
  // the status, so the rejection itself has nothing left to do.
  autoUpdater.checkForUpdates().catch(() => {});
}

function start() {
  // Hard no-op for `npm run desktop:dev`: there is no app-update.yml to read.
  if (!app.isPackaged) return;

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    log(`electron-updater failed to load: ${err.message}`);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // see the header: a decision, not a default
  autoUpdater.disableWebInstaller = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null; // we log the few lines that matter ourselves

  autoUpdater.on('update-available', (info) => {
    log(`update ${info.version} found, downloading`);
    setStatus({ state: 'downloading', version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    log(`up to date (running ${app.getVersion()}, latest ${info.version})`);
    setStatus({ state: 'idle' });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log(`update ${info.version} downloaded, waiting for the user`);
    setStatus({ state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    // First line only: HTTP errors append the whole response header block.
    const first = String(err && err.message ? err.message : err).split('\n')[0];
    log(`error: ${first}`);
    // A failed download must not leave "downloading" stuck, nor hide a later retry.
    if (status.state !== 'ready') setStatus({ state: 'idle' });
  });

  ipcMain.handle('updater:get-status', () => status);
  ipcMain.handle('updater:install', () => {
    if (status.state !== 'ready') return false; // the button only exists when ready
    log(`installing ${status.version} at the user's request`);
    autoUpdater.quitAndInstall(true, true); // isSilent, isForceRunAfter
    return true;
  });

  setTimeout(checkNow, FIRST_CHECK_MS);
  setInterval(checkNow, CHECK_EVERY_MS).unref();
}

module.exports = { start };
