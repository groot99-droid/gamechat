'use strict';
// Audio engine. Everything you SEND goes through one graph so the voice gate,
// push-to-talk, soundboard and mute all share a single outgoing track (changing
// microphones never renegotiates the call). Everything you HEAR goes through a
// "room bus" so per-person boost, deafen and the clip recorder work.
const AudioEngine = (() => {
  let ctx = null;
  let micStream = null, micSrc = null;
  let micGain, voiceGate, micAnalyser, txAnalyser, dest, sbGain, sbMonitor, bus, deafenGain, recorder, silent;
  let mode = 'always', muted = false, pttHeld = false, pttTimer = null;
  let gateOpen = true, holdUntil = 0, thresholdDb = -45, transmitting = true;
  let micDb = -100;
  // clip ring buffer
  let ring = null, ringPos = 0, ringFilled = 0, ringSecs = 20, recOn = true, includeMine = true, mineConnected = false;
  const buffers = new Map();
  const playing = new Set();
  const tmp = { mic: null, tx: null };

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
    ctx = new AudioContext({ latencyHint: 'interactive' });
    micGain = ctx.createGain();
    voiceGate = ctx.createGain();
    micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 1024;
    txAnalyser = ctx.createAnalyser(); txAnalyser.fftSize = 1024;
    dest = ctx.createMediaStreamDestination();
    sbGain = ctx.createGain();
    sbMonitor = ctx.createGain();
    bus = ctx.createGain();
    deafenGain = ctx.createGain();
    silent = ctx.createGain(); silent.gain.value = 0;

    micGain.connect(micAnalyser);
    micGain.connect(voiceGate);
    voiceGate.connect(dest);
    voiceGate.connect(txAnalyser);
    sbGain.connect(dest);
    sbMonitor.connect(ctx.destination);
    bus.connect(deafenGain); deafenGain.connect(ctx.destination);

    recorder = ctx.createScriptProcessor(4096, 1, 1);
    recorder.channelCount = 1; recorder.channelCountMode = 'explicit';
    recorder.onaudioprocess = (e) => {
      if (!recOn || !ring) return;
      const inp = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < inp.length; i++) { ring[ringPos] = inp[i]; ringPos = (ringPos + 1) % ring.length; }
      ringFilled = Math.min(ring.length, ringFilled + inp.length);
    };
    bus.connect(recorder);
    recorder.connect(silent); silent.connect(ctx.destination);
    allocRing();
    applyMineTap();
    updateTx();

    tmp.mic = new Float32Array(micAnalyser.fftSize);
    tmp.tx = new Float32Array(txAnalyser.fftSize);
    setInterval(tick, 25);
    return ctx;
  }

  const rms = (an, buf) => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); };
  function tick() {
    micDb = 20 * Math.log10(Math.max(rms(micAnalyser, tmp.mic), 1e-5));
    if (mode === 'voice') {
      const now = performance.now();
      if (micDb > thresholdDb) { gateOpen = true; holdUntil = now + 400; }
      else if (now > holdUntil) gateOpen = false;
      updateTx();
    }
  }
  function updateTx() {
    if (!ctx) return;
    const open = !muted && (mode === 'always' || (mode === 'voice' && gateOpen) || (mode === 'ptt' && pttHeld));
    transmitting = open;
    voiceGate.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, 0.015);
  }

  async function openMic(opts) {
    init();
    closeMic();
    const audio = { echoCancellation: opts.echo !== false, noiseSuppression: opts.noise !== false, autoGainControl: opts.agc !== false };
    const tryOpen = async (a) => { try { return await navigator.mediaDevices.getUserMedia({ audio: a }); } catch { return null; } };
    let s = opts.mic ? await tryOpen({ ...audio, deviceId: { exact: opts.mic } }) : null;
    if (!s) s = await tryOpen(audio);
    if (!s) return false;
    micStream = s;
    micSrc = ctx.createMediaStreamSource(s);
    micSrc.connect(micGain);
    return true;
  }
  function closeMic() {
    if (micSrc) { try { micSrc.disconnect(); } catch {} micSrc = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    micDb = -100;
  }

  /* ---- hearing ---- */
  function addRemote(track) {
    init();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const g = ctx.createGain();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    const buf = new Float32Array(an.fftSize);
    src.connect(g); g.connect(bus); src.connect(an);
    return {
      setVolume(v) { g.gain.value = v; },
      level() { return rms(an, buf); },
      disconnect() { try { src.disconnect(); g.disconnect(); } catch {} },
    };
  }

  /* ---- clip recorder ---- */
  function allocRing() {
    ring = new Float32Array(Math.round(ctx.sampleRate * ringSecs));
    ringPos = 0; ringFilled = 0;
  }
  function applyMineTap() {
    if (!ctx) return;
    const want = recOn && includeMine;
    if (want && !mineConnected) { voiceGate.connect(recorder); mineConnected = true; }
    if (!want && mineConnected) { try { voiceGate.disconnect(recorder); } catch {} mineConnected = false; }
  }
  function configureClips({ secs, on, mine }) {
    init();
    if (secs && secs !== ringSecs) { ringSecs = secs; allocRing(); }
    recOn = on !== false; includeMine = mine !== false;
    applyMineTap();
  }
  function clipSeconds() { return ctx ? ringFilled / ctx.sampleRate : 0; }
  function clipWav(secs) {
    if (!ctx || !ring || ringFilled < ctx.sampleRate * 0.5) return null;
    const n = Math.min(ringFilled, Math.round(secs * ctx.sampleRate));
    const out = new Float32Array(n);
    let start = (ringPos - n + ring.length) % ring.length;
    let peak = 0;
    for (let i = 0; i < n; i++) { const v = ring[(start + i) % ring.length]; out[i] = v; peak = Math.max(peak, Math.abs(v)); }
    if (peak < 0.002) return null; // silence
    const gain = Math.min(4, 0.95 / peak);
    const pcm = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) pcm.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); pcm.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    pcm.setUint32(16, 16, true); pcm.setUint16(20, 1, true); pcm.setUint16(22, 1, true);
    pcm.setUint32(24, ctx.sampleRate, true); pcm.setUint32(28, ctx.sampleRate * 2, true);
    pcm.setUint16(32, 2, true); pcm.setUint16(34, 16, true); w(36, 'data'); pcm.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) pcm.setInt16(44 + i * 2, Math.max(-1, Math.min(1, out[i] * gain)) * 32767, true);
    return pcm.buffer;
  }

  /* ---- soundboard ---- */
  const BUILTINS = [
    { id: 'b:ding', name: 'Ding', kind: 'builtin' },
    { id: 'b:horn', name: 'Air horn', kind: 'builtin' },
    { id: 'b:buzzer', name: 'Buzzer', kind: 'builtin' },
    { id: 'b:drum', name: 'Drum hit', kind: 'builtin' },
    { id: 'b:sad', name: 'Sad trombone', kind: 'builtin' },
  ];
  function synth(id) {
    const sr = ctx.sampleRate;
    const make = (secs, fn) => {
      const b = ctx.createBuffer(1, Math.round(sr * secs), sr), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = fn(i / sr, i / d.length);
      return b;
    };
    const saw = (f, t) => 2 * ((f * t) % 1) - 1;
    switch (id) {
      case 'b:ding': return make(1.0, (t, p) => Math.sin(2 * Math.PI * 880 * t) * Math.exp(-5 * t) * 0.6 + Math.sin(2 * Math.PI * 1760 * t) * Math.exp(-8 * t) * 0.2);
      case 'b:horn': return make(1.4, (t, p) => (saw(466, t) + saw(554, t) + saw(699, t)) * 0.18 * Math.min(1, t * 80) * (p > 0.8 ? (1 - p) * 5 : 1));
      case 'b:buzzer': return make(0.7, (t, p) => (Math.sign(Math.sin(2 * Math.PI * 140 * t)) * 0.35) * (p > 0.9 ? (1 - p) * 10 : 1));
      case 'b:drum': return make(0.6, (t) => (Math.sin(2 * Math.PI * (50 + 130 * Math.exp(-30 * t)) * t) * Math.exp(-7 * t) + (Math.random() * 2 - 1) * Math.exp(-40 * t) * 0.4) * 0.9);
      case 'b:sad': {
        const notes = [[392, 0.0, 0.4], [370, 0.4, 0.4], [349, 0.8, 0.4], [330, 1.2, 1.0]];
        return make(2.3, (t) => { let v = 0; for (const [f, s, d] of notes) if (t >= s && t < s + d + 0.05) { const lt = t - s; const fl = f - (f === 330 ? 12 * lt : 0); v += (saw(fl, lt) * 0.5 + Math.sin(2 * Math.PI * fl * lt) * 0.5) * 0.3 * Math.min(1, lt * 40) * Math.exp(-1.2 * lt); } return v; });
      }
    }
    return null;
  }
  async function loadBuffer(id) {
    if (buffers.has(id)) return buffers.get(id);
    let buf;
    if (id.startsWith('b:')) buf = synth(id);
    else {
      const data = await window.api.sounds.read(id);
      if (!data) throw new Error('missing sound');
      const u8 = new Uint8Array(data);
      buf = await ctx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    }
    buffers.set(id, buf);
    return buf;
  }
  function forget(id) { buffers.delete(id); }
  async function play(id, { local = false } = {}) {
    init();
    const buf = await loadBuffer(id);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    if (!local) s.connect(sbGain);
    s.connect(sbMonitor);
    s.start();
    playing.add(s);
    s.onended = () => playing.delete(s);
    return buf.duration;
  }
  function stopAll() { for (const s of playing) { try { s.stop(); } catch {} } playing.clear(); }
  function setSoundVolume(v) { init(); sbGain.gain.value = v; sbMonitor.gain.value = v; }

  return {
    init, openMic, closeMic,
    outTrack: () => { init(); return dest.stream.getAudioTracks()[0]; },
    setMode(m) { mode = m; updateTx(); },
    setMuted(m) { muted = m; updateTx(); },
    setPtt(down, releaseDelay = 250) {
      clearTimeout(pttTimer);
      if (down) { pttHeld = true; updateTx(); } else pttTimer = setTimeout(() => { pttHeld = false; updateTx(); }, releaseDelay);
    },
    setThreshold(db) { thresholdDb = db; },
    setMicGain(v) { init(); micGain.gain.value = v; },
    setDeafened(d) { init(); deafenGain.gain.value = d ? 0 : 1; },
    setSink(id) { if (ctx && ctx.setSinkId) ctx.setSinkId(id || '').catch(() => {}); },
    addRemote, configureClips, clipSeconds, clipWav,
    BUILTINS, play, stopAll, forget, setSoundVolume,
    micDb: () => micDb,
    txLevel: () => (ctx && transmitting ? rms(txAnalyser, tmp.tx) : 0),
    isTransmitting: () => transmitting,
    hasMic: () => !!micStream,
  };
})();
