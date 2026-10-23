// The bridge of the main window: a few named calls, nothing else. The page never gets
// ipcRenderer itself, and it can only listen to the channels below.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set(['quick-entry', 'open-files', 'deep-link', 'menu']);
const api = {
  platform: process.platform,
  on(channel, cb) {
    if (!CHANNELS.has(channel) || typeof cb !== 'function') return;
    ipcRenderer.on('desktop:' + channel, (_e, payload) => cb(payload));
  },
  notify(title, body) { ipcRenderer.send('desktop:notify', { title: String(title || ''), body: String(body || '') }); },
  prefs(p) { return ipcRenderer.invoke('desktop:prefs', p && typeof p === 'object' ? { background: p.background, openAtLogin: p.openAtLogin } : null); },
  info() { return ipcRenderer.invoke('desktop:info'); },
};
// The test hooks exist only when the app was started in the test mode.
if (process.argv.includes('--lumen-test')) api.test = (op, arg) => ipcRenderer.invoke('desktop:test', String(op), arg);
contextBridge.exposeInMainWorld('lumenDesktop', Object.freeze(api));
