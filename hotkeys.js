'use strict';
// Global hotkeys with real key-down/key-up (needed for push-to-talk).
// Only the keys you bind are looked at; nothing is logged or stored.
let hook = null, Keys = {};
try {
  const m = require('uiohook-napi');
  hook = m.uIOhook; Keys = m.UiohookKey;
} catch (e) {
  console.error('Global hotkeys unavailable:', e.message);
}
const names = {};
for (const [n, c] of Object.entries(Keys)) names[c] = n;
const MOD_CODES = new Set([Keys.Ctrl, Keys.CtrlRight, Keys.Shift, Keys.ShiftRight, Keys.Alt, Keys.AltRight, Keys.Meta, Keys.MetaRight]);

let bindings = {};          // action -> { kc?, mb?, ctrl, alt, shift, meta }
let onAction = () => {};
let capturing = null;       // resolver while the user is choosing a key
const down = new Map();     // action -> trigger code held
const seen = new Map();     // action -> last time its trigger was seen (ms); detects a missed key-up

function label(b) {
  if (!b) return '';
  const parts = [];
  if (b.ctrl && !MOD_CODES.has(b.kc)) parts.push('Ctrl');
  if (b.alt && !MOD_CODES.has(b.kc)) parts.push('Alt');
  if (b.shift && !MOD_CODES.has(b.kc)) parts.push('Shift');
  if (b.meta && !MOD_CODES.has(b.kc)) parts.push('Win');
  parts.push(b.mb ? `Mouse ${b.mb}` : (names[b.kc] || `Key ${b.kc}`));
  return parts.join(' + ');
}
function matches(b, trig, e) {
  if (b.mb) return trig === 'm' + b.mb;
  if (trig !== 'k' + b.kc) return false;
  if (MOD_CODES.has(b.kc)) return true;
  return !!b.ctrl === !!e.ctrlKey && !!b.alt === !!e.altKey && !!b.shift === !!e.shiftKey && !!b.meta === !!e.metaKey;
}
function press(trig, e) {
  if (capturing) {
    if (trig === 'k' + Keys.Escape) { const r = capturing; capturing = null; return r(null); }
    const r = capturing; capturing = null;
    const b = trig[0] === 'm'
      ? { mb: Number(trig.slice(1)) }
      : { kc: Number(trig.slice(1)), ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey, meta: !!e.metaKey };
    return r({ binding: b, label: label(b) });
  }
  const now = Date.now();
  for (const [action, b] of Object.entries(bindings)) {
    if (!b || !matches(b, trig, e)) continue;
    if (down.has(action)) {
      // auto-repeat while held: ignore. A gap of 700 ms+ means we missed the key-up, so treat it as a new press.
      const stale = now - (seen.get(action) || 0) > 700;
      seen.set(action, now);
      if (!stale) continue;
      onAction(action, false);
    }
    seen.set(action, now);
    down.set(action, trig); onAction(action, true);
  }
}
function release(trig) {
  for (const [action, t] of [...down]) if (t === trig) { down.delete(action); onAction(action, false); }
}

function start(cb) {
  onAction = cb;
  if (!hook) return false;
  hook.on('keydown', (e) => press('k' + e.keycode, e));
  hook.on('keyup', (e) => release('k' + e.keycode));
  // buttons 1/2 are left/right click: never bindable
  hook.on('mousedown', (e) => { if (e.button >= 3) press('m' + e.button, e); });
  hook.on('mouseup', (e) => { if (e.button >= 3) release('m' + e.button); });
  hook.start();
  return true;
}
function stop() { if (hook) { try { hook.stop(); } catch {} } }
function setBindings(b) { bindings = b || {}; down.clear(); seen.clear(); }
function capture() {
  return new Promise((resolve) => {
    if (!hook) return resolve(null);
    capturing = resolve;
    setTimeout(() => { if (capturing === resolve) { capturing = null; resolve(null); } }, 15000);
  });
}
// Ctrl+Alt+<key> defaults; push-to-talk is left for you to choose.
function defaults() {
  const mk = (kc) => { const b = { kc, ctrl: true, alt: true, shift: false, meta: false }; b.label = label(b); return b; };
  const fuego = { kc: Keys.H, ctrl: true, alt: false, shift: true, meta: false }; fuego.label = label(fuego);
  return {
    quickStart: fuego,
    mute: mk(Keys.M), deafen: mk(Keys.D), camera: mk(Keys.V), share: mk(Keys.S), clip: mk(Keys.C),
    overlay: mk(Keys.O), stopSounds: mk(Keys.X), window: mk(Keys.G), chanNext: mk(Keys.ArrowDown || Keys.Down), chanPrev: mk(Keys.ArrowUp || Keys.Up),
  };
}
module.exports = { start, stop, setBindings, capture, label, defaults, available: () => !!hook };
