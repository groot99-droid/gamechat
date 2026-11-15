'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  info: inv('app:info'),
  addresses: inv('net:addresses'),
  rooms: inv('discover:rooms'),
  copy: inv('clipboard:write'),
  paste: inv('clipboard:read'),
  seal: inv('seal'),
  unseal: inv('unseal'),
  hostStart: inv('host:start'),
  hostUsers: inv('host:users'),
  hostStop: inv('host:stop'),
  upnp: inv('net:upnp'),
  screenSources: inv('screen:sources'),
  screenSelect: inv('screen:select'),
  setBindings: inv('hotkeys:set'),
  captureKey: inv('hotkeys:capture'),
  keyLabel: inv('hotkeys:label'),
  hotkeyDefaults: inv('hotkeys:defaults'),
  toggleWindow: inv('window:toggle'),
  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, d) => cb(d)),
  overlayConfig: inv('overlay:config'),
  overlayData: (d) => ipcRenderer.send('overlay:data', d),
  sounds: {
    list: inv('sounds:list'), add: inv('sounds:import'), read: inv('sounds:read'), saveClip: inv('sounds:saveClip'),
    rename: inv('sounds:rename'), remove: inv('sounds:delete'), export: inv('sounds:export'), openFolder: inv('sounds:openFolder'),
  },
});
