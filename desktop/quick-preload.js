// The bridge of the Quick Entry window: send the text, or close.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('quickEntry', Object.freeze({
  submit(text) { ipcRenderer.send('quick:submit', String(text || '')); },
  close() { ipcRenderer.send('quick:close'); },
  onReset(cb) { if (typeof cb === 'function') ipcRenderer.on('quick:reset', () => cb()); },
}));
