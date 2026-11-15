'use strict';
// Tiny signaling server. It only relays WebRTC handshakes + chat; audio/video
// flow directly between friends (peer-to-peer).
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');

const MAX_PEERS = 8;
const HISTORY_CAP = 300;
const APP_VERSION = require('./package.json').version;

function startServer({ port, password, channels, historyFile, hostKey, roomName }) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port, maxPayload: 256 * 1024 });
    const peers = new Map(); // id -> { ws, name, state, channel, admin }
    let nextId = 1;
    let nextChan = 1;

    let chans = (channels && channels.length ? channels : ['Lobby']).map((n) => ({ id: 'c' + nextChan++, name: String(n).slice(0, 24) }));
    let history = {}; // channel NAME -> [{name,text,ts,sys}]  (keyed by name so it survives restarts)
    if (historyFile) { try { history = JSON.parse(fs.readFileSync(historyFile, 'utf8')); } catch {} }
    let saveTimer = null;
    const saveHistory = () => {
      if (!historyFile || saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        fs.writeFile(historyFile, JSON.stringify(history), () => {});
      }, 1500);
    };
    const chanName = (cid) => (chans.find((c) => c.id === cid) || {}).name;

    const sendTo = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    const broadcast = (obj, exceptId) => {
      for (const [id, p] of peers) if (id !== exceptId) sendTo(p.ws, obj);
    };
    const broadcastChannel = (cid, obj) => {
      for (const p of peers.values()) if (p.channel === cid) sendTo(p.ws, obj);
    };
    const cleanState = (s) => ({
      muted: !!(s && s.muted),
      deafened: !!(s && s.deafened),
      screenId: s && typeof s.screenId === 'string' ? s.screenId.slice(0, 80) : null,
    });
    const pushChat = (cid, entry) => {
      const key = chanName(cid); if (!key) return;
      (history[key] = history[key] || []).push(entry);
      if (history[key].length > HISTORY_CAP) history[key].splice(0, history[key].length - HISTORY_CAP);
      saveHistory();
      broadcastChannel(cid, { type: 'chat', channel: cid, ...entry });
    };
    const sendHistory = (p, cid) => sendTo(p.ws, { type: 'history', channel: cid, msgs: history[chanName(cid)] || [] });

    wss.on('error', reject);
    wss.on('listening', () => {
      resolve({
        port: wss.address().port,
        close() {
          for (const p of peers.values()) p.ws.terminate();
          wss.close();
          if (historyFile) { try { fs.writeFileSync(historyFile, JSON.stringify(history)); } catch {} }
        },
      });
    });

    wss.on('connection', (ws) => {
      const nonce = crypto.randomBytes(16).toString('hex');
      let id = null;
      sendTo(ws, { type: 'hello', nonce, version: APP_VERSION, room: roomName || '' });
      const authTimer = setTimeout(() => { if (!id) ws.close(); }, 10000);

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (!id) {
          if (msg.type !== 'join') return;
          const expected = Buffer.from(crypto.createHash('sha256').update(nonce + password).digest('hex'));
          const given = Buffer.from(String(msg.proof || ''));
          const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
          if (!ok) {
            sendTo(ws, { type: 'error', message: 'Wrong room password.' });
            return setTimeout(() => ws.close(), 300);
          }
          if (peers.size >= MAX_PEERS) {
            sendTo(ws, { type: 'error', message: `Room is full (${MAX_PEERS} max).` });
            return setTimeout(() => ws.close(), 300);
          }
          clearTimeout(authTimer);
          id = String(nextId++);
          const name = String(msg.name || 'Player').slice(0, 24);
          const admin = !!hostKey && msg.hostKey === hostKey;
          const channel = chans[0].id;
          const existing = [...peers].map(([pid, p]) => ({ id: pid, name: p.name, state: p.state, channel: p.channel }));
          const me = { ws, name, state: cleanState(null), channel, admin };
          peers.set(id, me);
          sendTo(ws, { type: 'welcome', id, admin, channels: chans, channel, peers: existing, version: APP_VERSION });
          sendHistory(me, channel);
          broadcast({ type: 'peer-joined', id, name, channel }, id);
          return;
        }

        const me = peers.get(id);
        switch (msg.type) {
          case 'signal': {
            const target = peers.get(String(msg.to));
            if (target && target.channel === me.channel) sendTo(target.ws, { type: 'signal', from: id, data: msg.data });
            break;
          }
          case 'chat': {
            const text = String(msg.text || '').slice(0, 500);
            if (text) pushChat(me.channel, { name: me.name, text, ts: Date.now() });
            break;
          }
          case 'notice': { // e.g. someone used the clip button: everyone in the channel is told
            if (msg.kind === 'clip') pushChat(me.channel, { name: me.name, text: `${me.name} clipped the last ${Math.min(120, Number(msg.secs) || 15)}s of voice chat`, ts: Date.now(), sys: true });
            break;
          }
          case 'state': {
            me.state = cleanState(msg.state);
            broadcast({ type: 'state', from: id, state: me.state }, id);
            break;
          }
          case 'move': {
            if (!chans.some((c) => c.id === msg.channel) || msg.channel === me.channel) break;
            me.channel = msg.channel;
            broadcast({ type: 'moved', id, channel: me.channel });
            sendTo(ws, { type: 'moved', id, channel: me.channel });
            sendHistory(me, me.channel);
            break;
          }
          case 'chan-add': case 'chan-rename': case 'chan-delete': {
            if (!me.admin) break;
            const name = String(msg.name || '').trim().slice(0, 24);
            if (msg.type === 'chan-add' && name && chans.length < 10) {
              chans.push({ id: 'c' + nextChan++, name });
            } else if (msg.type === 'chan-rename' && name) {
              const c = chans.find((x) => x.id === msg.id);
              if (c) { history[name] = history[c.name] || []; delete history[c.name]; c.name = name; saveHistory(); }
            } else if (msg.type === 'chan-delete' && chans.length > 1) {
              const idx = chans.findIndex((x) => x.id === msg.id);
              if (idx < 0) break;
              const [gone] = chans.splice(idx, 1);
              delete history[gone.name]; saveHistory();
              for (const [pid, p] of peers) if (p.channel === gone.id) {
                p.channel = chans[0].id;
                broadcast({ type: 'moved', id: pid, channel: p.channel });
                sendTo(p.ws, { type: 'moved', id: pid, channel: p.channel });
                sendHistory(p, p.channel);
              }
            } else break;
            broadcast({ type: 'channels', channels: chans });
            sendTo(ws, { type: 'channels', channels: chans });
            break;
          }
        }
      });

      ws.on('close', () => {
        clearTimeout(authTimer);
        if (id && peers.delete(id)) broadcast({ type: 'peer-left', id });
      });
      ws.on('error', () => {});
    });
  });
}

module.exports = { startServer, APP_VERSION };
