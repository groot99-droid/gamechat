'use strict';
// El Fuego background: rising embers over a flickering flame glow. Pure canvas, no assets.
(function () {
  const cv = document.getElementById('embers');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, running = true;
  const embers = [];
  const N = 90;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function spawn(initial) {
    return {
      x: Math.random() * W,
      y: initial ? Math.random() * H : H + 10,
      r: 0.8 + Math.random() * 2.6,
      vy: 0.35 + Math.random() * 1.1,
      sway: Math.random() * Math.PI * 2,
      swaySpeed: 0.01 + Math.random() * 0.03,
      swayAmp: 0.2 + Math.random() * 0.8,
      life: 0.4 + Math.random() * 0.6,
      hue: 15 + Math.random() * 35,
    };
  }
  function frame(t) {
    if (!running) return;
    ctx.clearRect(0, 0, W, H);
    // flickering glow along the bottom edge
    const flick = 0.75 + 0.25 * Math.sin(t / 170) * Math.sin(t / 91 + 1.3);
    const g = ctx.createLinearGradient(0, H, 0, H - H * 0.45);
    g.addColorStop(0, `rgba(255,90,20,${0.34 * flick})`);
    g.addColorStop(0.45, `rgba(255,40,0,${0.12 * flick})`);
    g.addColorStop(1, 'rgba(255,40,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, H - H * 0.45, W, H * 0.45);
    // flame tongues
    for (let i = 0; i < 9; i++) {
      const cx = (i + 0.5) * (W / 9) + Math.sin(t / 700 + i * 2.1) * 30;
      const h = (H * 0.16) * (0.55 + 0.45 * Math.sin(t / 230 + i * 1.7) * Math.sin(t / 130 + i));
      const rg = ctx.createRadialGradient(cx, H, 0, cx, H, Math.max(h, 10));
      rg.addColorStop(0, 'rgba(255,200,60,0.30)');
      rg.addColorStop(0.5, 'rgba(255,80,10,0.16)');
      rg.addColorStop(1, 'rgba(255,40,0,0)');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.ellipse(cx, H, W / 14, Math.max(h, 10), 0, 0, Math.PI * 2); ctx.fill();
    }
    // embers
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < embers.length; i++) {
      const e = embers[i];
      e.y -= e.vy; e.sway += e.swaySpeed; e.x += Math.sin(e.sway) * e.swayAmp; e.life -= 0.0016;
      if (e.y < -10 || e.life <= 0) { embers[i] = spawn(false); continue; }
      const a = Math.min(1, e.life * 1.6) * (0.55 + 0.45 * Math.sin(t / 90 + i));
      ctx.fillStyle = `hsla(${e.hue},100%,${58 + e.life * 20}%,${a})`;
      ctx.shadowColor = `hsla(${e.hue},100%,55%,0.9)`; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'source-over';
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    running = !document.hidden;
    if (running) requestAnimationFrame(frame);
  });
  resize();
  for (let i = 0; i < N; i++) embers.push(spawn(true));
  requestAnimationFrame(frame);
})();
