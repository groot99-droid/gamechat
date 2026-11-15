'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('overlayApi', {
  onData: (cb) => ipcRenderer.on('overlay:data', (_e, d) => cb(d)),
});
