'use strict';
// GameChat renderer: full-mesh WebRTC inside the current channel ("perfect negotiation").

const $ = (s) => document.querySelector(s);
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const DEFAULTS = {
  mode: 'always', thr: -45, gain: 100, echo: true, noise: true, agc: true,
  clipOn: true, clipSecs: 20, clipMine: true,
  ovEnabled: false, ovCorner: 'top-left', ovScale: 100, ovOpacity: 90,
  inet: false, sbVol: 80,
};
const store = {
  load() { try { return JSON.parse(localStorage.getItem('gc') || '{}'); } catch { return {}; } },
  save(patch) { localStorage.setItem('gc', JSON.stringify({ ...this.load(), ...patch })); },
};
const S = () => ({ ...DEFAULTS, ...store.load() });

// The private party room. Everything needed to host or join it is built in.
const FUEGO = { name: 'El Fuego', chans: 'Fogata, Squad 1, Squad 2', port: 7777 };
// The password is not bundled: the first time, type it into the password box; it is then remembered on this PC.
const fuegoPass = (sel) => S().fuegoPass || ($(sel).value || '');
let roomTitle = '';
function setTheme(fuego) { document.body.classList.toggle('fuego', !!fuego); }
setTheme(true);

let ws = null, myId = null, myName = 'Player';
let hosting = false, hostKey = null, hostPassword = '', hostInfo = null, publicIp = null;
let isAdmin = false;
let channels = [], myChannel = null;
let localStream = null, camTrack = null, screenStream = null;
let muted = false, deafened = false, leaving = false, inRoom = false;
let appInfo = { version: '?', hotkeys: false };
let sounds = [], sbEdit = false;
let notes = [];                       // recent notices for the overlay
const roster = new Map();             // id -> { name, state, channel }
const peers = new Map();
const tiles = new Map();
const speakingBy = {};                // peerId -> bool
let focusKey = null;
let connectedUrl = null;

/* ---------- helpers ---------- */
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}
function beep(freq) {
  try {
    const ctx = AudioEngine.init();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = freq; g.gain.value = 0.04;
    o.connect(g).connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.12);
  } catch {}
}
function sysMsg(text, cls) {
  const d = document.createElement('div');
  d.className = 'msg sys' + (cls ? ' ' + cls : ''); d.textContent = text;
  $('#msgs').appendChild(d); $('#msgs').scrollTop = 1e9;
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const nameOf = (id) => (roster.get(id) || {}).name || 'Player';
const chanName = (id) => (channels.find((c) => c.id === id) || {}).name || '?';
function askText(title, initial) {
  return new Promise((resolve) => {
    $('#askTitle').textContent = title; $('#askInput').value = initial || '';
    $('#modalAsk').hidden = false; $('#askInput').focus();
    const done = (v) => { $('#modalAsk').hidden = true; $('#askOk').onclick = $('#askCancel').onclick = $('#askInput').onkeydown = null; resolve(v); };
    $('#askOk').onclick = () => done($('#askInput').value.trim());
    $('#askCancel').onclick = () => done(null);
    $('#askInput').onkeydown = (e) => { if (e.key === 'Enter') done($('#askInput').value.trim()); if (e.key === 'Escape') done(null); };
  });
}

/* ---------- saved rooms / invites ---------- */
async function sealPw(pw) { return pw ? await window.api.seal(pw) : null; }
function rooms() { return store.load().rooms || []; }
function putRoom(entry) {
  const list = rooms().filter((r) => !(r.kind === entry.kind && r.label === entry.label));
  list.unshift(entry);
  store.save({ rooms: list.slice(0, 30) });
}
function dropRoom(kind, label) { store.save({ rooms: rooms().filter((r) => !(r.kind === kind && r.label === label)) }); }
function fillSaved(kind) {
  const sel = $(kind === 'host' ? '#hostSaved' : '#joinSaved');
  sel.innerHTML = `<option value="">${kind === 'host' ? 'New room' : 'Pick a saved room'}</option>`;
  for (const r of rooms().filter((x) => x.kind === kind)) {
    const o = document.createElement('option'); o.value = r.label; o.textContent = r.label; sel.appendChild(o);
  }
}
function encodeInvite(o) {
  const b = btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  return 'GC1-' + b.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeInvite(s) {
  s = s.trim();
  if (!s.startsWith('GC1-')) throw new Error('That does not look like a GameChat invite code.');
  let b = s.slice(4).replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  const o = JSON.parse(decodeURIComponent(escape(atob(b))));
  if (!Array.isArray(o.a) || !o.a.length) throw new Error('Invite code is incomplete.');
  return o;
}
let inviteAddrs = null;

/* ---------- lobby ---------- */
function setTab(host) {
  $('#tabHost').classList.toggle('active', host);
  $('#tabJoin').classList.toggle('active', !host);
  $('#paneHost').hidden = !host; $('#paneJoin').hidden = host;
  $('#lobbyErr').textContent = '';
}
$('#tabHost').onclick = () => setTab(true);
$('#tabJoin').onclick = () => setTab(false);

function parseAddr(raw, defPort) {
  let a = raw.trim().replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
  if (!a) throw new Error('Enter the host address.');
  if (!/:\d+$/.test(a)) a += ':' + defPort;
  return 'ws://' + a;
}
const syncInet = (v) => { store.save({ inet: v }); for (const id of ['#hostInet', '#joinInet', '#netInet']) $(id).checked = v; };
for (const id of ['#hostInet', '#joinInet', '#netInet']) $(id).onchange = (e) => syncInet(e.target.checked);

$('#hostSaved').onchange = async () => {
  const r = rooms().find((x) => x.kind === 'host' && x.label === $('#hostSaved').value);
  if (!r) return;
  $('#hostRoom').value = r.label; $('#hostPort').value = r.port; $('#hostChans').value = r.chans;
  $('#hostPass').value = (r.pw && (await window.api.unseal(r.pw))) || '';
};
$('#joinSaved').onchange = async () => {
  const r = rooms().find((x) => x.kind === 'join' && x.label === $('#joinSaved').value);
  if (!r) return;
  $('#joinAddr').value = r.addr; $('#inviteCode').value = ''; inviteAddrs = null;
  $('#joinPass').value = (r.pw && (await window.api.unseal(r.pw))) || '';
};
$('#inviteCode').oninput = () => {
  const v = $('#inviteCode').value.trim();
  if (!v) { inviteAddrs = null; return; }
  try {
    const o = decodeInvite(v);
    inviteAddrs = o.a; $('#joinAddr').value = o.a.join(', '); $('#joinPass').value = o.k || '';
    if (o.i) syncInet(true);
    $('#lobbyErr').textContent = ''; toast(`Invite for "${o.n || 'room'}" loaded - press Join.`);
  } catch (e) { $('#lobbyErr').textContent = e.message; }
};

$('#btnHost').onclick = async () => {
  const pass = $('#hostPass').value;
  if (!pass) return ($('#lobbyErr').textContent = 'Pick a room password first.');
  const port = Number($('#hostPort').value) || 7777;
  const chans = $('#hostChans').value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
  const name = ($('#name').value.trim() || 'Player').slice(0, 24);
  const roomName = ($('#hostRoom').value.trim() || `${name}'s room`).slice(0, 40);
  $('#lobbyErr').textContent = '';
  try {
    const info = await window.api.hostStart({ port, password: pass, channels: chans.length ? chans : ['Lobby'], roomName, profileId: roomName });
    hosting = true; hostKey = info.hostKey; hostPassword = pass; hostInfo = info; publicIp = null;
    if ($('#hostRemember').checked) putRoom({ kind: 'host', label: roomName, port, chans: chans.join(', '), pw: await sealPw(pass) });
    if (S().inet) {
      toast('Asking your router to open the port (UPnP)...');
      const r = await window.api.upnp({ port: info.port, enable: true });
      if (r.ok && r.publicIp) {
        publicIp = r.publicIp;
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(r.publicIp)) {
          toast('Your internet provider shares one address between customers (CGNAT), so outside friends cannot reach you directly. Use Tailscale instead.');
          publicIp = null;
        }
      } else toast(r.error || 'UPnP did not work. Forward the port on your router by hand, or use Tailscale.');
    }
    await enterRoom([`ws://127.0.0.1:${info.port}`], pass, { roomName });
    if (roomName === FUEGO.name) store.save({ fuegoRole: 'host', fuegoPass: pass });
  } catch (e) {
    hosting = false; window.api.hostStop();
    $('#lobbyErr').textContent = /EADDRINUSE/.test(String(e)) ? 'That port is already in use.' : (e.message || String(e));
  }
};
$('#btnJoin').onclick = async () => {
  $('#lobbyErr').textContent = '';
  try {
    const raw = $('#joinAddr').value;
    const addrs = (inviteAddrs && $('#inviteCode').value.trim()) ? inviteAddrs : raw.split(/[,\s]+/).filter(Boolean);
    if (!addrs.length && !window.IS_WEB) throw new Error('Enter the host address or paste an invite code.');
    const urls = window.IS_WEB ? [`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`] : addrs.map((a) => parseAddr(a, 7777));
    if (window.IS_WEB && !addrs.length) addrs.push(location.host);
    hosting = false;
    await enterRoom(urls, $('#joinPass').value, { remember: $('#joinRemember').checked, addrText: addrs.join(', ') });
    if (roomTitle === FUEGO.name) store.save({ fuegoRole: 'guest', fuegoAddr: addrs.join(', '), fuegoPass: $('#joinPass').value });
  } catch (e) { $('#lobbyErr').textContent = e.message || String(e); }
};
for (const id of ['#hostPass', '#hostPort']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $('#btnHost').click());
for (const id of ['#joinAddr', '#joinPass']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && $('#btnJoin').click());

async function pollFound() {
  if ($('#lobby').hidden || $('#paneJoin').hidden) return;
  const list = await window.api.rooms();
  $('#foundBox').hidden = !list.length;
  const box = $('#found'); box.innerHTML = '';
  for (const r of list) {
    const d = document.createElement('div'); d.className = 'foundrow';
    d.innerHTML = '<span></span><span class="dim"></span>';
    d.children[0].textContent = r.room || 'GameChat room';
    d.children[1].textContent = `${r.address}:${r.port} - ${r.users} online`;
    d.onclick = () => {
      $('#joinAddr').value = `${r.address}:${r.port}`; $('#inviteCode').value = ''; inviteAddrs = null;
      if (r.room === FUEGO.name && fuegoPass('#joinPass')) { $('#joinPass').value = fuegoPass('#joinPass'); $('#btnJoin').click(); } else $('#joinPass').focus();
    };
    box.appendChild(d);
  }
}
setInterval(pollFound, 2000);

/* ---------- El Fuego: one-click host / join / quick start ---------- */
async function fuegoHost() {
  setTab(true);
  $('#hostRoom').value = FUEGO.name;
  const hp = fuegoPass('#hostPass');
  if (!hp) { $('#lobbyErr').textContent = 'Type the El Fuego password in the password box, then press Start room.'; $('#hostPass').focus(); return; }
  $('#hostPass').value = hp;
  $('#hostChans').value = FUEGO.chans; $('#hostPort').value = FUEGO.port;
  $('#hostRemember').checked = true;
  await $('#btnHost').onclick();
}
async function fuegoFindOnLan() {
  try { return (await window.api.rooms()).find((r) => r.room === FUEGO.name) || null; } catch { return null; }
}
async function fuegoJoin(addrText) {
  setTab(false);
  $('#inviteCode').value = ''; inviteAddrs = null;
  const jp = fuegoPass('#joinPass');
  if (!jp) { $('#lobbyErr').textContent = 'Type the El Fuego password in the password box, then press Join.'; $('#joinPass').focus(); return; }
  $('#joinPass').value = jp;
  $('#joinAddr').value = addrText;
  $('#joinRemember').checked = true;
  await $('#btnJoin').onclick();
}
// Join: saved address -> room found on the LAN -> otherwise ask for the host's address/invite code.
async function fuegoJoinFlow(silent) {
  if (!fuegoPass('#joinPass')) { setTab(false); $('#lobbyErr').textContent = 'Type the El Fuego password in the password box first (asked once, then remembered), then press Join El Fuego.'; $('#joinPass').focus(); return false; }
  const tries = [];
  const saved = S().fuegoAddr;
  if (saved) tries.push(saved);
  const lan = await fuegoFindOnLan();
  if (lan) tries.unshift(`${lan.address}:${lan.port}`);
  if (window.IS_WEB) tries.unshift(location.host);
  for (const a of tries) {
    await fuegoJoin(a);
    if (inRoom) return true;
  }
  setTab(false); $('#joinPass').value = fuegoPass('#joinPass');
  $('#lobbyErr').textContent = '';
  if (!silent || !tries.length) {
    $('#lobbyErr').textContent = 'No El Fuego room found nearby. Paste the host\'s invite code or address, then press Join.';
    $('#inviteCode').focus();
  }
  return false;
}
$('#btnFuegoHost').onclick = fuegoHost;
$('#btnFuegoJoin').onclick = () => fuegoJoinFlow(false);
// Ctrl+Shift+H: host if you are the host, join if you are a guest, otherwise join a room on the LAN or host one.
let fuegoBusy = false;
async function quickStartFuego() {
  if (fuegoBusy) return;
  if (inRoom) { toast(`You are already in a room. Leave it first to quick start ${FUEGO.name}.`); return; }
  fuegoBusy = true;
  try {
    const role = S().fuegoRole;
    toast(`🔥 Quick start: ${FUEGO.name}...`);
    if (role === 'host') return await fuegoHost();
    if (role === 'guest') { if (await fuegoJoinFlow(true)) return; return; }
    const lan = await fuegoFindOnLan();
    if (lan) await fuegoJoin(`${lan.address}:${lan.port}`); else await fuegoHost();
  } finally { fuegoBusy = false; }
}

/* ---------- joining ---------- */
function applyAudioSettings() {
  const s = S();
  AudioEngine.setMode(s.mode); AudioEngine.setThreshold(s.thr); AudioEngine.setMicGain(s.gain / 100);
  AudioEngine.setSink(s.spk); AudioEngine.setSoundVolume(s.sbVol / 100);
  AudioEngine.configureClips({ secs: s.clipSecs, on: s.clipOn, mine: s.clipMine });
}

async function enterRoom(urls, password, opts = {}) {
  leaving = false;
  myName = ($('#name').value.trim() || 'Player').slice(0, 24);
  store.save({ name: myName });
  muted = false; deafened = false;
  AudioEngine.init();
  applyAudioSettings();
  AudioEngine.setMuted(false); AudioEngine.setDeafened(false);
  const gotMic = await AudioEngine.openMic(S());
  if (!gotMic) toast('No microphone available - you can listen and use the soundboard, but not talk.');
  localStream = new MediaStream([AudioEngine.outTrack()]);

  let err = null;
  for (const url of urls) {
    try { await connectWs(url, password, urls.length > 1 ? 4000 : 8000); err = null; break; }
    catch (e) { err = e; if (e.fatal) break; }
  }
  if (err) { teardown(); throw err; }

  if (!hosting && opts.remember) {
    putRoom({ kind: 'join', label: opts.addrText || connectedUrl, addr: opts.addrText || connectedUrl.replace('ws://', ''), pw: await sealPw(password) });
  }
  inRoom = true;
  setTheme(roomTitle === FUEGO.name);
  $('#lobby').hidden = true; $('#room').hidden = false;
  addLocalTile();
  updateControls();
  renderHeader(opts.roomName || roomTitle);
  renderSide();
  loadSounds();
  applyOverlay();
  if (hosting) window.api.hostUsers(1);
  sysMsg(hosting ? 'You are hosting this room.' : 'Connected.');
  beep(660);
}

function connectWs(url, password, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = new WebSocket(url);
    ws = sock;
    const fail = (msg, fatal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { sock.close(); } catch {}
      const e = new Error(msg); e.fatal = !!fatal; reject(e);
    };
    const unreachable = 'Could not reach the host. Check the address, port and firewall.';
    const timer = setTimeout(() => fail(unreachable), timeoutMs);
    sock.onerror = () => fail(unreachable);
    sock.onclose = () => {
      if (!settled) return fail('Connection closed by host.');
      if (!leaving) { toast('Disconnected from the room.'); leaveRoom(); }
    };
    sock.onmessage = async (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') {
        roomTitle = m.room || '';
        send({ type: 'join', name: myName, version: appInfo.version, hostKey: hosting ? hostKey : undefined, proof: await sha256hex(m.nonce + password) });
      } else if (m.type === 'error') {
        fail(m.message, true);
      } else if (m.type === 'welcome') {
        clearTimeout(timer); settled = true; connectedUrl = url;
        myId = m.id; isAdmin = !!m.admin; channels = m.channels; myChannel = m.channel;
        if (m.version && m.version !== appInfo.version) toast(`Host runs GameChat v${m.version}, you run v${appInfo.version}. Ask for the newest zip if something misbehaves.`);
        roster.clear();
        for (const p of m.peers) roster.set(p.id, { name: p.name, state: p.state || {}, channel: p.channel });
        resolve();
        for (const p of m.peers) if (p.channel === myChannel) getPeer(p.id);
      } else {
        handleMsg(m);
      }
    };
  });
}

function renderChat(m) {
  const d = document.createElement('div');
  if (m.sys) { d.className = 'msg clipnote'; d.textContent = m.text; }
  else {
    d.className = 'msg';
    const b = document.createElement('b'); b.textContent = m.name;
    const small = document.createElement('small'); small.textContent = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    d.append(b, small, document.createElement('br'), document.createTextNode(m.text));
  }
  $('#msgs').appendChild(d); $('#msgs').scrollTop = 1e9;
}

function handleMsg(m) {
  switch (m.type) {
    case 'peer-joined':
      roster.set(m.id, { name: m.name, state: {}, channel: m.channel });
      sysMsg(`${m.name} joined the room`); beep(740);
      renderSide(); if (hosting) window.api.hostUsers(roster.size + 1);
      break;
    case 'peer-left': {
      const n = nameOf(m.id);
      removePeer(m.id); roster.delete(m.id);
      sysMsg(`${n} left`); beep(440);
      renderSide(); if (hosting) window.api.hostUsers(roster.size + 1);
      break;
    }
    case 'signal': {
      const r = roster.get(m.from);
      if (r && r.channel === myChannel) onSignal(m.from, m.data);
      break;
    }
    case 'moved': {
      if (m.id === myId) {
        myChannel = m.channel;
        for (const id of [...peers.keys()]) removePeer(id);
        for (const [id, r] of roster) if (r.channel === myChannel) getPeer(id);
        setFocus(null);
        sysMsg(`You are now in "${chanName(myChannel)}"`);
      } else {
        const r = roster.get(m.id); if (!r) break;
        const was = r.channel; r.channel = m.channel;
        if (was === myChannel && m.channel !== myChannel) { removePeer(m.id); sysMsg(`${r.name} left the channel`); }
        else if (m.channel === myChannel) sysMsg(`${r.name} joined the channel`);
      }
      renderSide();
      break;
    }
    case 'channels':
      channels = m.channels;
      if (!channels.some((c) => c.id === myChannel)) myChannel = channels[0].id;
      renderSide();
      break;
    case 'history':
      $('#msgs').innerHTML = '';
      sysMsg(`# ${chanName(m.channel)}`);
      for (const msg of m.msgs) renderChat(msg);
      break;
    case 'chat':
      if (m.channel === myChannel) renderChat(m);
      if (m.sys) { notes.push({ text: m.text, until: Date.now() + 6000 }); }
      break;
    case 'state': {
      const r = roster.get(m.from); if (!r) break;
      r.state = m.state;
      for (const t of tiles.values()) if (t.peerId === m.from) renderTile(t);
      if (m.state.screenId) { const t = tiles.get(`${m.from}:${m.state.screenId}`); if (t && !focusKey) setFocus(t.key); }
      renderSide();
      break;
    }
  }
}

/* ---------- header / channel sidebar ---------- */
function inviteAddresses() {
  const out = [];
  const order = { Tailscale: 0, ZeroTier: 0, VPN: 0, LAN: 1 };
  const list = [...(hostInfo.addresses || [])].sort((a, b) => (order[a.kind] ?? 2) - (order[b.kind] ?? 2));
  for (const a of list) out.push(`${a.address}:${hostInfo.port}`);
  if (publicIp) out.push(`${publicIp}:${hostInfo.port}`);
  return out;
}
function renderHeader(roomName) {
  const isFuego = (roomName || roomTitle) === FUEGO.name;
  $('#roomInfo').textContent = hosting ? `Hosting "${roomName}"` : (isFuego ? `In "${FUEGO.name}"` : 'In room');
  if (isFuego) $('#roomInfo').textContent = '🔥 ' + $('#roomInfo').textContent + ' 🔥';
  $('#btnInvite').hidden = !hosting;
  const el = $('#roomAddrs'); el.innerHTML = '';
  if (hosting && hostInfo) {
    el.append('Friends join with: ');
    const kinds = hostInfo.addresses.map((a) => [`${a.address}:${hostInfo.port}`, a.kind]);
    if (publicIp) kinds.push([`${publicIp}:${hostInfo.port}`, 'Internet']);
    if (!kinds.length) el.append('(no network found)');
    if (hostInfo.webPort && hostInfo.addresses.length) {
      el.append(document.createElement('br'), 'Phone: open ');
      const c = document.createElement('code'); c.textContent = `https://${hostInfo.addresses[0].address}:${hostInfo.webPort}`; el.append(c, ' (accept the certificate warning)');
    }
    kinds.forEach(([addr, kind], i) => {
      if (i) el.append('  or  ');
      const c = document.createElement('code'); c.textContent = addr;
      el.append(c, ` (${kind})`);
    });
  }
}
$('#btnInvite').onclick = async () => {
  const code = encodeInvite({ n: $('#roomInfo').textContent.replace(/^(🔥 )?Hosting "|"( 🔥)?$/g, ''), a: inviteAddresses(), k: hostPassword, i: !!publicIp });
  await window.api.copy(code);
  toast('Invite code copied. Anyone with it can join (it contains the password), so send it privately.');
};

function memberRow(id, name, state, speaking) {
  const d = document.createElement('div');
  d.className = 'member' + (speaking ? ' speaking' : ''); d.dataset.pid = id;
  const pip = document.createElement('span'); pip.className = 'pip';
  const nm = document.createElement('span');
  nm.textContent = name + (state.deafened ? ' (deaf)' : state.muted ? ' (muted)' : '');
  d.append(pip, nm);
  return d;
}
function renderSide() {
  if (!inRoom && !ws) return;
  const list = $('#chanList'); list.innerHTML = '';
  $('#btnAddChan').hidden = !isAdmin;
  for (const c of channels) {
    const row = document.createElement('div');
    row.className = 'chan' + (c.id === myChannel ? ' cur' : '');
    const nm = document.createElement('span'); nm.textContent = '# ' + c.name;
    row.appendChild(nm);
    if (isAdmin) {
      const tools = document.createElement('span'); tools.className = 'tools';
      const ren = document.createElement('span'); ren.textContent = 'rename';
      ren.onclick = async (e) => { e.stopPropagation(); const n = await askText('Rename channel', c.name); if (n) send({ type: 'chan-rename', id: c.id, name: n }); };
      const del = document.createElement('span'); del.textContent = 'x';
      del.onclick = (e) => { e.stopPropagation(); if (channels.length > 1 && confirm(`Delete channel "${c.name}"? People inside move to the first channel.`)) send({ type: 'chan-delete', id: c.id }); };
      tools.append(ren, del); row.appendChild(tools);
    }
    row.onclick = () => { if (c.id !== myChannel) send({ type: 'move', channel: c.id }); };
    list.appendChild(row);
    if (c.id === myChannel) list.appendChild(memberRow('me', myName + ' (you)', { muted, deafened }, speakingBy.me));
    for (const [id, r] of roster) if (r.channel === c.id) list.appendChild(memberRow(id, r.name, r.state || {}, speakingBy[id]));
  }
}
$('#btnAddChan').onclick = async () => { const n = await askText('New channel name'); if (n) send({ type: 'chan-add', name: n }); };
function cycleChannel(dir) {
  if (channels.length < 2) return;
  const i = channels.findIndex((c) => c.id === myChannel);
  send({ type: 'move', channel: channels[(i + dir + channels.length) % channels.length].id });
}

/* ---------- peer connections ---------- */
function getPeer(id) {
  let p = peers.get(id);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: S().inet ? STUN : [] });
  p = { id, pc, polite: Number(myId) > Number(id), making: false, ignore: false, senders: new Map() };
  peers.set(id, p);

  pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'signal', to: id, data: { candidate: e.candidate } }); };
  pc.onnegotiationneeded = async () => {
    try {
      p.making = true;
      await pc.setLocalDescription();
      send({ type: 'signal', to: id, data: { description: pc.localDescription } });
    } catch (e) { console.error('negotiation', e); } finally { p.making = false; }
  };
  pc.ontrack = (e) => onRemoteTrack(p, e);
  pc.onconnectionstatechange = () => {
    for (const t of tiles.values()) if (t.peerId === id) renderTile(t);
    if (pc.connectionState === 'failed') pc.restartIce();
  };

  for (const t of localStream.getTracks()) p.senders.set(t.id, pc.addTrack(t, localStream));
  if (screenStream) for (const t of screenStream.getTracks()) addScreenSender(p, t);
  return p;
}

async function onSignal(from, data) {
  const p = getPeer(from);
  const pc = p.pc;
  try {
    if (data.description) {
      const collision = data.description.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision;
      if (p.ignore) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        send({ type: 'signal', to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignore) throw e; }
    }
  } catch (e) { console.error('signal', e); }
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  peers.delete(id);
  for (const [k, t] of [...tiles]) if (t.peerId === id) removeTile(k);
}

function onRemoteTrack(p, e) {
  const stream = e.streams[0] || new MediaStream([e.track]);
  const key = `${p.id}:${stream.id}`;
  let t = tiles.get(key);
  if (!t) {
    t = makeTile(key, p.id, stream, false);
    stream.onremovetrack = () => {
      for (const [tid, h] of [...t.handles]) if (!stream.getTrackById(tid)) { h.disconnect(); t.handles.delete(tid); }
      const live = stream.getTracks().length > 0;
      const isScreen = (roster.get(p.id) || {}).state?.screenId === stream.id;
      if (!live && (isScreen || stream.getAudioTracks().length === 0)) removeTile(key); else renderTile(t);
    };
  }
  if (e.track.kind === 'audio' && !t.handles.has(e.track.id)) {
    const h = AudioEngine.addRemote(e.track);
    h.setVolume(t.vol);
    t.handles.set(e.track.id, h);
  }
  e.track.onunmute = () => renderTile(t);
  renderTile(t);
}

/* ---------- tiles ---------- */
function makeTile(key, peerId, stream, local) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = '<video autoplay playsinline muted></video><div class="avatar"><span></span></div><div class="label"></div><div class="conn"></div><input class="vol" type="range" min="0" max="300" value="100" title="Volume (up to 300%)">';
  const video = el.querySelector('video');
  video.srcObject = stream;
  video.muted = true; // audio is played through the Web Audio room bus (per-person boost, deafen, clips)
  const t = { key, peerId, stream, local, el, video, handles: new Map(), vol: 1, speaking: false };
  const vol = el.querySelector('.vol');
  if (local) vol.hidden = true;
  vol.oninput = () => { t.vol = vol.value / 100; for (const h of t.handles.values()) h.setVolume(t.vol); vol.title = `Volume ${vol.value}%`; };
  el.onclick = (ev) => { if (ev.target !== vol) setFocus(focusKey === key ? null : key); };
  el.ondblclick = () => video.requestFullscreen && video.requestFullscreen().catch(() => {});
  tiles.set(key, t);
  $('#grid').appendChild(el);
  return t;
}
function removeTile(key) {
  const t = tiles.get(key); if (!t) return;
  t.dead = true;
  for (const h of t.handles.values()) h.disconnect();
  t.el.remove(); tiles.delete(key);
  if (focusKey === key) setFocus(null);
}
function setFocus(key) {
  focusKey = key;
  for (const t of tiles.values()) t.el.classList.toggle('focus', t.key === key);
  $('#grid').classList.toggle('has-focus', !!key);
}
function renderTile(t) {
  if (t.dead) return;
  const st = t.local ? { muted, deafened, screenId: screenStream && screenStream.id } : ((roster.get(t.peerId) || {}).state || {});
  const isScreen = st.screenId === t.stream.id;
  const name = t.local ? `${myName} (you)` : nameOf(t.peerId);
  const hasVideo = t.stream.getVideoTracks().length > 0;
  t.el.classList.toggle('novideo', !hasVideo);
  t.el.classList.toggle('screen', isScreen);
  t.el.querySelector('.avatar span').textContent = (name[0] || '?').toUpperCase();
  let label = name + (isScreen ? ' - screen' : '');
  if (!isScreen && st.muted) label += '  [muted]';
  if (!isScreen && st.deafened) label += '  [deafened]';
  t.el.querySelector('.label').textContent = label;
  const conn = t.el.querySelector('.conn');
  const p = peers.get(t.peerId);
  conn.textContent = p && p.pc.connectionState !== 'connected' ? p.pc.connectionState : '';
  conn.hidden = !conn.textContent;
}
function addLocalTile() {
  const t = makeTile('me:voice', 'me', localStream, true);
  renderTile(t);
}

/* ---------- speaking + overlay feed ---------- */
setInterval(() => {
  if (!inRoom) return;
  for (const k of Object.keys(speakingBy)) delete speakingBy[k];
  for (const t of tiles.values()) {
    let on = false;
    if (t.local) on = t.key === 'me:voice' && !muted && AudioEngine.txLevel() > 0.012;
    else for (const h of t.handles.values()) if (h.level() > 0.012) on = true;
    t.speaking = on;
    t.el.classList.toggle('speaking', on);
    if (on) speakingBy[t.peerId] = true;
  }
  for (const el of document.querySelectorAll('.member')) el.classList.toggle('speaking', !!speakingBy[el.dataset.pid]);
  notes = notes.filter((n) => n.until > Date.now());
  if (S().ovEnabled) {
    const users = [{ name: myName, speaking: !!speakingBy.me, muted, deafened }];
    for (const [id, r] of roster) if (r.channel === myChannel) users.push({ name: r.name, speaking: !!speakingBy[id], muted: !!r.state?.muted, deafened: !!r.state?.deafened });
    window.api.overlayData({ users, notes: notes.map((n) => n.text) });
  }
  const clipBtn = $('#btnClip');
  clipBtn.classList.toggle('rec', S().clipOn && AudioEngine.clipSeconds() > 1);
}, 100);

/* ---------- controls ---------- */
function broadcastState() {
  send({ type: 'state', state: { muted, deafened, screenId: screenStream ? screenStream.id : null } });
  const me = tiles.get('me:voice'); if (me) renderTile(me);
  renderSide();
}
function updateControls() {
  const set = (id, text, cls) => { const b = $(id); b.textContent = text; b.classList.remove('on', 'off'); if (cls) b.classList.add(cls); };
  set('#btnMute', muted ? 'Unmute' : 'Mute', muted ? 'off' : '');
  set('#btnDeafen', deafened ? 'Undeafen' : 'Deafen', deafened ? 'off' : '');
  set('#btnCam', camTrack ? 'Camera off' : 'Camera', camTrack ? 'on' : '');
  set('#btnShare', screenStream ? 'Stop sharing' : 'Share screen', screenStream ? 'on' : '');
  $('#btnOverlay').classList.toggle('on', S().ovEnabled);
  $('#btnSound').classList.toggle('on', !$('#sbPanel').hidden);
}
function toggleMute() { muted = !muted; AudioEngine.setMuted(muted); updateControls(); broadcastState(); }
function toggleDeafen() { deafened = !deafened; AudioEngine.setDeafened(deafened); updateControls(); broadcastState(); }
$('#btnMute').onclick = toggleMute;
$('#btnDeafen').onclick = toggleDeafen;
$('#btnCam').onclick = async () => {
  if (camTrack) {
    for (const p of peers.values()) { const s = p.senders.get(camTrack.id); if (s) { p.pc.removeTrack(s); p.senders.delete(camTrack.id); } }
    localStream.removeTrack(camTrack); camTrack.stop(); camTrack = null;
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      camTrack = s.getVideoTracks()[0];
      localStream.addTrack(camTrack);
      for (const p of peers.values()) p.senders.set(camTrack.id, p.pc.addTrack(camTrack, localStream));
    } catch { toast('Could not open a camera.'); }
  }
  const me = tiles.get('me:voice'); if (me) renderTile(me);
  updateControls();
};
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#chatInput').value.trim();
  if (v) send({ type: 'chat', text: v });
  $('#chatInput').value = '';
};

/* ---------- screen share ---------- */
function addScreenSender(p, track) {
  const sender = p.pc.addTrack(track, screenStream);
  p.senders.set(track.id, sender);
  if (track.kind === 'video') tuneSender(sender, 8_000_000, 0);
}
function tuneSender(sender, bitrate, tries) {
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) {
    if (tries < 20) setTimeout(() => tuneSender(sender, bitrate, tries + 1), 400);
    return;
  }
  params.encodings[0].maxBitrate = bitrate;
  params.encodings[0].maxFramerate = 60;
  params.degradationPreference = 'maintain-framerate';
  sender.setParameters(params).catch(() => {});
}
function pickSource() {
  return new Promise(async (resolve) => {
    const list = await window.api.screenSources();
    const box = $('#sources'); box.innerHTML = '';
    const done = (v) => { $('#modalShare').hidden = true; resolve(v); };
    for (const s of list) {
      const d = document.createElement('div'); d.className = 'src';
      const img = document.createElement('img'); img.src = s.thumb;
      const n = document.createElement('div'); n.textContent = s.name;
      d.append(img, n);
      d.onclick = () => done({ id: s.id, audio: $('#chkShareAudio').checked });
      box.appendChild(d);
    }
    $('#btnShareCancel').onclick = () => done(null);
    $('#modalShare').hidden = false;
  });
}
async function startShare() {
  const choice = await pickSource();
  if (!choice) return;
  try {
    await window.api.screenSelect(choice);
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: choice.audio,
    });
    screenStream = stream;
    const v = stream.getVideoTracks()[0];
    if (v) { v.contentHint = 'motion'; v.onended = stopShare; }
    const t = makeTile('me:screen', 'me', stream, true);
    renderTile(t);
    for (const p of peers.values()) for (const tr of stream.getTracks()) addScreenSender(p, tr);
    broadcastState();
    setFocus('me:screen');
  } catch (e) {
    screenStream = null;
    toast('Screen share failed: ' + (e.message || e));
  }
  updateControls();
}
function stopShare() {
  if (!screenStream) return;
  const s = screenStream; screenStream = null;
  for (const p of peers.values()) for (const tr of s.getTracks()) {
    const sender = p.senders.get(tr.id); if (sender) { try { p.pc.removeTrack(sender); } catch {} p.senders.delete(tr.id); }
  }
  s.getTracks().forEach((t) => t.stop());
  removeTile('me:screen');
  broadcastState(); updateControls();
}
$('#btnShare').onclick = () => (screenStream ? stopShare() : startShare());

/* ---------- soundboard + clips ---------- */
async function loadSounds() {
  sounds = [...AudioEngine.BUILTINS, ...(await window.api.sounds.list())];
  renderSb();
}
async function playSound(id, local) {
  try { await AudioEngine.play(id, { local }); } catch { toast('Could not play that sound.'); }
}
function hkLabel(action) { const b = (store.load().bindings || {})[action]; return b ? b.label : ''; }
function renderSb() {
  const list = $('#sbList'); list.innerHTML = '';
  for (const s of sounds) {
    const d = document.createElement('div'); d.className = 'sbitem';
    const play = document.createElement('button'); play.className = 'play' + (s.kind === 'clip' ? ' clip' : ''); play.textContent = s.name;
    play.onclick = (e) => playSound(s.id, e.shiftKey);
    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = [s.kind === 'clip' ? 'clip' : '', hkLabel('sound:' + s.id)].filter(Boolean).join('  -  ');
    d.append(play, meta);
    if (sbEdit) {
      const ed = document.createElement('div'); ed.className = 'edit';
      const mk = (txt, fn) => { const b = document.createElement('button'); b.className = 'mini'; b.textContent = txt; b.onclick = fn; ed.appendChild(b); };
      mk('Preview', () => playSound(s.id, true));
      mk('Hotkey', async (e) => { e.target.textContent = 'Press keys...'; await captureFor('sound:' + s.id); renderSb(); });
      if (s.kind !== 'builtin') {
        mk('Rename', async () => { const n = await askText('Rename sound', s.name); if (n) { await window.api.sounds.rename({ id: s.id, name: n }); loadSounds(); } });
        mk('Save as...', () => window.api.sounds.export(s.id));
        mk('Delete', async () => { if (confirm(`Delete "${s.name}"?`)) { AudioEngine.forget(s.id); await window.api.sounds.remove(s.id); loadSounds(); } });
      }
      d.appendChild(ed);
    }
    list.appendChild(d);
  }
}
$('#btnSound').onclick = () => { $('#sbPanel').hidden = !$('#sbPanel').hidden; updateControls(); };
$('#sbAdd').onclick = async () => { await window.api.sounds.add(); loadSounds(); };
$('#sbEdit').onclick = () => { sbEdit = !sbEdit; $('#sbEdit').textContent = sbEdit ? 'Done' : 'Edit'; renderSb(); };
$('#sbStop').onclick = () => AudioEngine.stopAll();
$('#sbFolder').onclick = () => window.api.sounds.openFolder();
$('#sbVol').value = S().sbVol;
$('#sbVol').oninput = (e) => { store.save({ sbVol: Number(e.target.value) }); AudioEngine.setSoundVolume(e.target.value / 100); };

async function doClip() {
  const secs = S().clipSecs;
  const wav = AudioEngine.clipWav(secs);
  if (!wav) return toast(S().clipOn ? 'Nothing to clip yet - nobody has said anything recently.' : 'Clip buffer is off (Settings > Clips).');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const entry = await window.api.sounds.saveClip({ name: `Clip ${time}`, wav });
  send({ type: 'notice', kind: 'clip', secs: Math.min(secs, Math.round(AudioEngine.clipSeconds())) });
  await loadSounds();
  toast(`Saved "${entry.name}" to your soundboard. Open Soundboard to play it to the room.`);
}
$('#btnClip').onclick = doClip;

/* ---------- overlay ---------- */
function applyOverlay() {
  const s = S();
  window.api.overlayConfig({ enabled: s.ovEnabled, corner: s.ovCorner, scale: s.ovScale / 100, opacity: s.ovOpacity / 100 });
  updateControls();
}
$('#btnOverlay').onclick = () => { store.save({ ovEnabled: !S().ovEnabled }); $('#ovEnabled').checked = S().ovEnabled; applyOverlay(); };

/* ---------- hotkeys ---------- */
const HK_ACTIONS = [
  ['quickStart', 'Quick start El Fuego (host or join)'],
  ['mute', 'Mute / unmute microphone'], ['deafen', 'Deafen / undeafen'], ['ptt', 'Push-to-talk (hold)'],
  ['camera', 'Camera on / off'], ['share', 'Screen share on / off'], ['clip', 'Clip the last seconds'],
  ['overlay', 'Show / hide overlay'], ['stopSounds', 'Stop all sounds'], ['window', 'Show / hide GameChat window'],
  ['chanNext', 'Next channel'], ['chanPrev', 'Previous channel'],
];
function saveBindings(b) { store.save({ bindings: b }); window.api.setBindings(b); }
async function captureFor(action) {
  const r = await window.api.captureKey();
  if (!r) return false;
  const b = { ...(store.load().bindings || {}) };
  for (const [a, x] of Object.entries(b)) if (x && x.label === r.label && a !== action) { delete b[a]; toast(`"${r.label}" moved here from another action.`); }
  b[action] = { ...r.binding, label: r.label };
  saveBindings(b);
  return true;
}
function renderHotkeys() {
  const list = $('#hkList'); list.innerHTML = '';
  $('#hkNote').textContent = appInfo.hotkeys
    ? 'Hotkeys work even while a game is focused. Click a button, then press the key combination (or a mouse side button). Esc cancels. Only the keys you bind here are looked at; nothing is logged.'
    : 'Global hotkeys are not available on this system.';
  const row = (action, name) => {
    const n = document.createElement('div'); n.className = 'hkname'; n.textContent = name;
    const b = document.createElement('button'); b.textContent = hkLabel(action) || 'Not set';
    b.onclick = async () => { b.textContent = 'Press keys...'; b.classList.add('capturing'); await captureFor(action); renderHotkeys(); };
    const c = document.createElement('button'); c.textContent = 'Clear'; c.style.minWidth = '0';
    c.onclick = () => { const x = { ...(store.load().bindings || {}) }; delete x[action]; saveBindings(x); renderHotkeys(); };
    list.append(n, b, c);
  };
  const h = (t) => { const d = document.createElement('div'); d.className = 'hkh'; d.textContent = t; list.appendChild(d); };
  h('Controls');
  for (const [a, n] of HK_ACTIONS) row(a, n);
  h('Soundboard');
  for (const s of sounds) row('sound:' + s.id, 'Play: ' + s.name);
}

window.api.onHotkey(({ action, down }) => {
  if (action === 'ptt') return AudioEngine.setPtt(down);
  if (!down) return;
  if (action === 'window') return window.api.toggleWindow();
  if (action === 'quickStart') return quickStartFuego();
  if (!inRoom) return;
  switch (action) {
    case 'mute': toggleMute(); break;
    case 'deafen': toggleDeafen(); break;
    case 'camera': $('#btnCam').click(); break;
    case 'share': $('#btnShare').click(); break;
    case 'clip': doClip(); break;
    case 'overlay': $('#btnOverlay').click(); break;
    case 'stopSounds': AudioEngine.stopAll(); break;
    case 'chanNext': cycleChannel(1); break;
    case 'chanPrev': cycleChannel(-1); break;
    default: if (action.startsWith('sound:')) playSound(action.slice(6), false);
  }
});

/* ---------- settings ---------- */
let meterTimer = null;
async function openSettings(tab) {
  AudioEngine.init();
  if (!AudioEngine.hasMic()) await AudioEngine.openMic(S());
  const devs = await navigator.mediaDevices.enumerateDevices();
  const s = S();
  const fill = (sel, kind, cur) => {
    sel.innerHTML = '<option value="">System default</option>';
    for (const d of devs.filter((x) => x.kind === kind && x.deviceId !== 'default' && x.deviceId !== 'communications')) {
      const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || kind;
      if (d.deviceId === cur) o.selected = true; sel.appendChild(o);
    }
  };
  fill($('#selMic'), 'audioinput', s.mic); fill($('#selSpk'), 'audiooutput', s.spk);
  $('#selMode').value = s.mode; $('#rngThr').value = s.thr; $('#rngGain').value = s.gain;
  $('#chkEcho').checked = s.echo; $('#chkNoise').checked = s.noise; $('#chkAgc').checked = s.agc;
  $('#ovEnabled').checked = s.ovEnabled; $('#ovCorner').value = s.ovCorner; $('#ovScale').value = s.ovScale; $('#ovOpacity').value = s.ovOpacity;
  $('#clipOn').checked = s.clipOn; $('#clipSecs').value = s.clipSecs; $('#clipMine').checked = s.clipMine;
  $('#netInet').checked = s.inet;
  labels();
  if (!sounds.length) sounds = [...AudioEngine.BUILTINS, ...(await window.api.sounds.list())];
  renderHotkeys();
  showSetTab(tab || 'voice');
  $('#modalSettings').hidden = false;
  clearInterval(meterTimer);
  meterTimer = setInterval(() => {
    const db = AudioEngine.micDb();
    $('#meterFill').style.width = Math.max(0, Math.min(100, ((db + 70) / 70) * 100)) + '%';
  }, 50);
}
function labels() {
  $('#thrVal').textContent = $('#rngThr').value + ' dB';
  $('#meterThr').style.left = ((Number($('#rngThr').value) + 70) / 70) * 100 + '%';
  $('#gainVal').textContent = $('#rngGain').value + '%';
  $('#clipSecsVal').textContent = $('#clipSecs').value + ' s';
}
function showSetTab(t) {
  for (const b of document.querySelectorAll('#setTabs button')) b.classList.toggle('active', b.dataset.tab === t);
  for (const p of document.querySelectorAll('#modalSettings section')) p.hidden = p.dataset.pane !== t;
}
for (const b of document.querySelectorAll('#setTabs button')) b.onclick = () => showSetTab(b.dataset.tab);

const bindSetting = (id, key, conv, after) => {
  $(id).addEventListener('input', () => {
    const el = $(id);
    const v = conv(el.type === 'checkbox' ? el.checked : el.value);
    store.save({ [key]: v }); labels(); if (after) after(v);
  });
};
bindSetting('#selMode', 'mode', String, (v) => AudioEngine.setMode(v));
bindSetting('#rngThr', 'thr', Number, (v) => AudioEngine.setThreshold(v));
bindSetting('#rngGain', 'gain', Number, (v) => AudioEngine.setMicGain(v / 100));
bindSetting('#selMic', 'mic', String, () => AudioEngine.openMic(S()));
bindSetting('#selSpk', 'spk', String, (v) => AudioEngine.setSink(v));
for (const [id, k] of [['#chkEcho', 'echo'], ['#chkNoise', 'noise'], ['#chkAgc', 'agc']]) bindSetting(id, k, Boolean, () => AudioEngine.openMic(S()));
bindSetting('#ovEnabled', 'ovEnabled', Boolean, applyOverlay);
bindSetting('#ovCorner', 'ovCorner', String, applyOverlay);
bindSetting('#ovScale', 'ovScale', Number, applyOverlay);
bindSetting('#ovOpacity', 'ovOpacity', Number, applyOverlay);
const applyClips = () => { const s = S(); AudioEngine.configureClips({ secs: s.clipSecs, on: s.clipOn, mine: s.clipMine }); };
bindSetting('#clipOn', 'clipOn', Boolean, applyClips);
bindSetting('#clipSecs', 'clipSecs', Number, applyClips);
bindSetting('#clipMine', 'clipMine', Boolean, applyClips);

$('#btnSettings').onclick = () => openSettings();
$('#btnSettingsLobby').onclick = () => openSettings();
$('#btnSettingsDone').onclick = () => {
  $('#modalSettings').hidden = true;
  clearInterval(meterTimer);
  if (!inRoom) AudioEngine.closeMic();
};

/* ---------- leaving ---------- */
function teardown() {
  leaving = true; inRoom = false;
  for (const id of [...peers.keys()]) removePeer(id);
  for (const k of [...tiles.keys()]) removeTile(k);
  if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  if (camTrack) camTrack.stop();
  screenStream = null; camTrack = null; localStream = null; focusKey = null;
  AudioEngine.stopAll(); AudioEngine.closeMic();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  roster.clear(); channels = []; myChannel = null; isAdmin = false;
  $('#msgs').innerHTML = ''; $('#chanList').innerHTML = '';
  window.api.overlayData({ users: [], notes: [] });
  if (hosting) { window.api.hostStop(); hosting = false; hostKey = null; hostPassword = ''; }
}
function leaveRoom() {
  teardown();
  roomTitle = ''; setTheme(true);
  $('#room').hidden = true; $('#lobby').hidden = false;
  $('#sbPanel').hidden = true;
  $('#lobbyErr').textContent = '';
}
$('#btnLeave').onclick = leaveRoom;
window.addEventListener('beforeunload', () => { if (hosting) window.api.hostStop(); });

/* ---------- boot ---------- */
(async function boot() {
  appInfo = await window.api.info();
  $('#verTag').textContent = 'v' + appInfo.version;
  const st = store.load();
  $('#name').value = st.name || '';
  $('#joinAddr').value = '';
  $('#hostPort').value = st.port || 7777;
  syncInet(S().inet);
  if (!st.bindings) store.save({ bindings: await window.api.hotkeyDefaults() });
  else if (!('quickStart' in st.bindings)) {          // upgrade from 2.0: add the El Fuego quick start key
    const d = await window.api.hotkeyDefaults();
    if (d.quickStart) store.save({ bindings: { ...st.bindings, quickStart: d.quickStart } });
  }
  window.api.setBindings(store.load().bindings || {});
  const qk = (store.load().bindings || {}).quickStart;
  $('#fuegoKey').textContent = qk && qk.label ? qk.label.replace(/ \+ /g, ' + ') : 'not set (Settings > Hotkeys)';
  if (!appInfo.hotkeys) {
    // The global key hook did not load (antivirus or permissions): the key only works while this window is focused.
    $('#fuegoKey').parentElement.append(document.createElement('br'), 'Global hotkeys are blocked on this PC (antivirus?), so the key only works while this window is focused.');
    window.addEventListener('keydown', (e) => {
      if (!qk || e.repeat || qk.mb) return;
      if (e.code === 'KeyH' && !!qk.ctrl === e.ctrlKey && !!qk.shift === e.shiftKey && !!qk.alt === e.altKey && !e.target.matches('input,textarea,select')) quickStartFuego();
    });
  }
  fillSaved('host'); fillSaved('join');
  // add a "forget" button next to each saved-room dropdown
  for (const kind of ['host', 'join']) {
    const sel = $(kind === 'host' ? '#hostSaved' : '#joinSaved');
    const b = document.createElement('button'); b.className = 'mini'; b.type = 'button'; b.textContent = 'Forget this saved room';
    b.onclick = () => { if (sel.value) { dropRoom(kind, sel.value); fillSaved(kind); } };
    sel.parentElement.appendChild(b);
  }
  if (window.IS_WEB) {
    setTab(false);
    for (const id of ['#tabHost', '#btnFuegoHost', '#btnShare', '#btnClip', '#btnOverlay']) $(id).hidden = true;
    $('#tabHost').parentElement.hidden = true;
    for (const id of ['#inviteCode', '#joinSaved', '#joinAddr', '#joinInet']) $(id).parentElement.hidden = true;
    $('#fuegoKey').parentElement.hidden = true;
    $('#joinAddr').value = location.host;
    $('#verTag').textContent = 'phone';
  }
  applyOverlay();
  pollFound();
})();
