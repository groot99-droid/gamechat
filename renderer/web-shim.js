'use strict';
// Phone / browser client: when there is no Electron preload, provide a harmless window.api
// so the same UI runs from the host's https page (join-only).
if (!window.api) {
  window.IS_WEB = true;
  document.documentElement.classList.add('web');
  const none = async () => null;
  window.api = {
    info: async () => ({ version: 'web', hotkeys: false }),
    addresses: async () => [], rooms: async () => [],
    copy: async (t) => { try { await navigator.clipboard.writeText(t); } catch {} },
    paste: async () => '', seal: async (x) => x, unseal: async (x) => x,
    hostStart: none, hostUsers() {}, hostStop() {}, upnp: async () => ({ ok: false }),
    screenSources: async () => [], screenSelect: none, setBindings() {}, captureKey: none,
    keyLabel: async () => '', hotkeyDefaults: async () => ({}), toggleWindow() {}, onHotkey() {},
    overlayConfig() {}, overlayData() {},
    sounds: { list: async () => [], add: none, read: none, saveClip: none, rename: none, remove: none, export: none, openFolder: none },
  };
}
