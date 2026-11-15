'use strict';
const { app, BrowserWindow, Menu, ipcMain, desktopCapturer, session, dialog, shell, screen, safeStorage, clipboard } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startServer, APP_VERSION } = require('./server');
const hotkeys = require('./hotkeys');
const discovery = require('./discovery');
const upnp = require('./upnp');

// Local-only app: expose real LAN IPs in ICE candidates instead of mDNS names.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

let win = null, overlay = null;
let hostServer = null, hostInfoForBeacon = { room: '', port: 0, users: 0 };
let pendingShare = null;
let overlayCfg = { enabled: false, corner: 'top-left', scale: 1, opacity: 0.9 };
let lastOverlayData = {};

const soundsDir = () => path.join(app.getPath('userData'), 'sounds');
const soundsIndexFile = () => path.join(soundsDir(), 'index.json');
function readSounds() { try { return JSON.parse(fs.readFileSync(soundsIndexFile(), 'utf8')); } catch { return []; } }
function writeSounds(list) { fs.mkdirSync(soundsDir(), { recursive: true }); fs.writeFileSync(soundsIndexFile(), JSON.stringify(list, null, 1)); }
const safeName = (s) => String(s || 'sound').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      let kind = 'LAN';
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) kind = 'Tailscale';
      else if (/zerotier/i.test(name)) kind = 'ZeroTier';
      else if (/radmin|hamachi/i.test(name)) kind = 'VPN';
      else if (a.address.startsWith('169.254.')) continue;
      out.push({ address: a.address, kind, iface: name });
    }
  }
  return out;
}
const privateLan = () => (lanAddresses().find((a) => a.kind === 'LAN' && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)) || {}).address;

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 800, minWidth: 820, minHeight: 540,
    backgroundColor: '#1e1f22', title: 'GameChat',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.GAMECHAT_DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  win.on('closed', () => { win = null; if (overlay) overlay.destroy(); });
}

/* ---------- overlay ---------- */
function placeOverlay() {
  if (!overlay) return;
  const d = screen.getPrimaryDisplay().workArea;
  const w = 340, h = 460, m = 12;
  const right = overlayCfg.corner.endsWith('right'), bottom = overlayCfg.corner.startsWith('bottom');
  overlay.setBounds({ x: right ? d.x + d.width - w - m : d.x + m, y: bottom ? d.y + d.height - h - m : d.y + m, width: w, height: h });
}
function applyOverlay() {
  if (!overlayCfg.enabled) { if (overlay) { overlay.destroy(); overlay = null; } return; }
  if (!overlay) {
    overlay = new BrowserWindow({
      width: 340, height: 460, transparent: true, frame: false, resizable: false, skipTaskbar: true,
      focusable: false, hasShadow: false, show: false, alwaysOnTop: true,
      webPreferences: { preload: path.join(__dirname, 'overlay', 'overlay-preload.js'), contextIsolation: true, sandbox: true },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setIgnoreMouseEvents(true);
    overlay.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
    overlay.webContents.on('did-finish-load', () => { overlay && overlay.webContents.send('overlay:data', lastOverlayData); });
    overlay.on('closed', () => { overlay = null; });
    overlay.showInactive();
  }
  overlay.setOpacity(overlayCfg.opacity);
  placeOverlay();
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  discovery.listen();

  const allowed = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      if (!pendingShare) return callback({});
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const src = sources.find((s) => s.id === pendingShare.id);
      const result = src ? { video: src } : {};
      if (src && pendingShare.audio) result.audio = 'loopback';
      pendingShare = null;
      callback(result);
    } catch { callback({}); }
  }, { useSystemPicker: false });

  /* app / network */
  ipcMain.handle('app:info', () => ({ version: APP_VERSION, userData: app.getPath('userData'), hotkeys: hotkeys.available(), platform: process.platform }));
  ipcMain.handle('net:addresses', () => lanAddresses());
  ipcMain.handle('discover:rooms', () => discovery.list());
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('seal', (_e, text) => (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(String(text)).toString('base64') : null));
  ipcMain.handle('unseal', (_e, b64) => {
    try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(String(b64), 'base64')) : null; } catch { return null; }
  });

  /* hosting */
  ipcMain.handle('host:start', async (_e, { port, password, channels, roomName, profileId }) => {
    if (hostServer) hostServer.close();
    const hostKey = crypto.randomBytes(16).toString('hex');
    const historyFile = path.join(app.getPath('userData'), `history-${safeName(profileId || 'default')}.json`);
    hostServer = await startServer({ port: Number(port) || 7777, password: String(password), channels, historyFile, hostKey, roomName });
    hostInfoForBeacon = { room: roomName || 'GameChat room', port: hostServer.port, users: 0 };
    discovery.beacon(() => ({ room: hostInfoForBeacon.room, port: hostInfoForBeacon.port, users: hostInfoForBeacon.users, v: APP_VERSION }));
    return { port: hostServer.port, addresses: lanAddresses(), hostKey };
  });
  ipcMain.handle('host:users', (_e, n) => { hostInfoForBeacon.users = Number(n) || 0; });
  ipcMain.handle('host:stop', async () => {
    if (hostServer) hostServer.close();
    hostServer = null;
    discovery.stopBeacon();
    await upnp.unmap();
  });
  ipcMain.handle('net:upnp', async (_e, { port, enable }) => {
    if (!enable) { await upnp.unmap(); return { ok: true }; }
    return upnp.map(Number(port), privateLan() || lanAddresses()[0]?.address);
  });

  /* screen share */
  ipcMain.handle('screen:sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
  });
  ipcMain.handle('screen:select', (_e, sel) => { pendingShare = { id: String(sel.id), audio: !!sel.audio }; });

  /* hotkeys */
  hotkeys.start((action, down) => {
    if (!win) return;
    if (action === 'quickStart' && down) { win.show(); win.restore(); win.focus(); }
    win.webContents.send('hotkey', { action, down });
  });
  ipcMain.handle('hotkeys:set', (_e, b) => hotkeys.setBindings(b));
  ipcMain.handle('hotkeys:capture', () => hotkeys.capture());
  ipcMain.handle('hotkeys:label', (_e, b) => hotkeys.label(b));
  ipcMain.handle('hotkeys:defaults', () => (hotkeys.available() ? hotkeys.defaults() : {}));
  ipcMain.handle('window:toggle', () => {
    if (!win) return;
    if (win.isVisible() && win.isFocused()) win.minimize(); else { win.show(); win.restore(); win.focus(); }
  });

  /* overlay */
  ipcMain.handle('overlay:config', (_e, cfg) => { overlayCfg = { ...overlayCfg, ...cfg }; applyOverlay(); });
  ipcMain.on('overlay:data', (_e, data) => { lastOverlayData = { ...data, corner: overlayCfg.corner, scale: overlayCfg.scale }; if (overlay) overlay.webContents.send('overlay:data', lastOverlayData); });

  /* soundboard + clips */
  ipcMain.handle('sounds:list', () => readSounds());
  ipcMain.handle('sounds:import', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add sounds', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm'] }] });
    if (r.canceled) return readSounds();
    const list = readSounds();
    fs.mkdirSync(soundsDir(), { recursive: true });
    for (const f of r.filePaths) {
      const id = crypto.randomBytes(6).toString('hex');
      const ext = path.extname(f).toLowerCase();
      fs.copyFileSync(f, path.join(soundsDir(), id + ext));
      list.push({ id, name: safeName(path.basename(f, ext)), file: id + ext, kind: 'import', ts: Date.now() });
    }
    writeSounds(list);
    return list;
  });
  ipcMain.handle('sounds:read', (_e, id) => {
    const s = readSounds().find((x) => x.id === id);
    return s ? fs.readFileSync(path.join(soundsDir(), s.file)) : null;
  });
  ipcMain.handle('sounds:saveClip', (_e, { name, wav }) => {
    const list = readSounds();
    const id = crypto.randomBytes(6).toString('hex');
    fs.mkdirSync(soundsDir(), { recursive: true });
    fs.writeFileSync(path.join(soundsDir(), id + '.wav'), Buffer.from(wav));
    const entry = { id, name: safeName(name), file: id + '.wav', kind: 'clip', ts: Date.now() };
    list.push(entry); writeSounds(list);
    return entry;
  });
  ipcMain.handle('sounds:rename', (_e, { id, name }) => {
    const list = readSounds(); const s = list.find((x) => x.id === id); if (s) s.name = safeName(name); writeSounds(list); return list;
  });
  ipcMain.handle('sounds:delete', (_e, id) => {
    let list = readSounds(); const s = list.find((x) => x.id === id);
    if (s) { try { fs.unlinkSync(path.join(soundsDir(), s.file)); } catch {} }
    list = list.filter((x) => x.id !== id); writeSounds(list); return list;
  });
  ipcMain.handle('sounds:export', async (_e, id) => {
    const s = readSounds().find((x) => x.id === id); if (!s) return false;
    const r = await dialog.showSaveDialog(win, { defaultPath: s.name + path.extname(s.file) });
    if (r.canceled) return false;
    fs.copyFileSync(path.join(soundsDir(), s.file), r.filePath); return true;
  });
  ipcMain.handle('sounds:openFolder', () => { fs.mkdirSync(soundsDir(), { recursive: true }); shell.openPath(soundsDir()); });

  createWindow();
});

app.on('window-all-closed', async () => {
  if (hostServer) hostServer.close();
  hotkeys.stop();
  try { await upnp.unmap(); } catch {}
  app.quit();
});
