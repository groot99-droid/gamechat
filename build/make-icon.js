'use strict';
// Generates build/icon.png and build/icon.ico (no dependencies).
const zlib = require('zlib'); const fs = require('fs'); const path = require('path');
function crc32(buf) { let c, crc = ~0; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// signed distance to a rounded rectangle centred at (cx,cy) with half sizes (hw,hh) and radius r
const sdRR = (x, y, cx, cy, hw, hh, r) => { const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };
function render(size) {
  const buf = Buffer.alloc(size * size * 4), SS = 3;
  const bars = [[0.30, 0.20], [0.40, 0.32], [0.50, 0.44], [0.60, 0.32], [0.70, 0.20]]; // x centre, half-height
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) / size, y = (py + (sy + 0.5) / SS) / size;
      if (sdRR(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) continue;
      const t = (x + y) / 2;
      let cr = 88 + (59 - 88) * t, cg = 101 + (68 - 101) * t, cb = 242 + (190 - 242) * t;
      for (const [bx, bh] of bars) if (sdRR(x, y, bx, 0.5, 0.045, bh, 0.045) < 0) { cr = 255; cg = 255; cb = 255; }
      r += cr; g += cg; b += cb; a += 255;
    }
    const n = SS * SS, i = (py * size + px) * 4;
    if (a) { buf[i] = r / (a / 255); buf[i + 1] = g / (a / 255); buf[i + 2] = b / (a / 255); buf[i + 3] = a / n; }
  }
  return buf;
}
const sizes = [256, 64, 48, 32, 16];
const pngs = sizes.map((s) => png(s, render(s)));
fs.writeFileSync(path.join(__dirname, 'icon.png'), pngs[0]);
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length; const dir = [];
sizes.forEach((s, i) => { const e = Buffer.alloc(16); e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length; dir.push(e); });
fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([head, ...dir, ...pngs]));
console.log('icons written');
