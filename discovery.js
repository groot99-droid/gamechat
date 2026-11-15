'use strict';
// LAN discovery: hosts shout "room here!" on UDP 7778; apps on the same
// network listen and show a clickable list. Carries no password and no secrets.
const dgram = require('dgram');
const os = require('os');

const PORT = 7778;
const rooms = new Map();
let listener = null, sender = null, timer = null;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

function listen() {
  if (listener) return;
  listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  listener.on('error', () => { try { listener.close(); } catch {} listener = null; });
  listener.on('message', (msg, rinfo) => {
    try {
      const d = JSON.parse(msg.toString());
      if (d.gc !== 1 || !d.port) return;
      rooms.set(`${rinfo.address}:${d.port}`, {
        address: rinfo.address, port: d.port, room: String(d.room || '').slice(0, 40),
        users: Number(d.users) || 0, version: String(d.v || ''), seen: Date.now(),
      });
    } catch {}
  });
  listener.bind(PORT);
}
function list() {
  const now = Date.now();
  for (const [k, r] of rooms) if (now - r.seen > 8000) rooms.delete(k);
  return [...rooms.values()];
}
function beacon(getInfo) {
  stopBeacon();
  sender = dgram.createSocket('udp4');
  sender.on('error', () => {});
  sender.bind(0, () => {
    try { sender.setBroadcast(true); } catch {}
    const tick = () => {
      const buf = Buffer.from(JSON.stringify({ gc: 1, ...getInfo() }));
      for (const addr of broadcastAddresses()) sender.send(buf, PORT, addr, () => {});
    };
    tick();
    timer = setInterval(tick, 2000);
  });
}
function stopBeacon() {
  if (timer) clearInterval(timer);
  timer = null;
  if (sender) { try { sender.close(); } catch {} sender = null; }
}
module.exports = { listen, list, beacon, stopBeacon };
