/**
 * The renderer's only window onto the main process, and it is narrow on
 * purpose: the app is sandboxed with no Node, so this exposes the updater's
 * status and the one install action, and nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hydrorecon', {
  updater: {
    getStatus: () => ipcRenderer.invoke('updater:get-status'),
    onStatus: (cb) => {
      const listener = (_event, status) => cb(status);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    },
    install: () => ipcRenderer.invoke('updater:install'),
  },
});
