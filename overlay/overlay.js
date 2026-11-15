'use strict';
const wrap = document.getElementById('wrap');
window.overlayApi.onData((d) => {
  wrap.className = d.corner && d.corner.endsWith('right') ? 'right' : '';
  wrap.style.zoom = d.scale || 1;
  wrap.innerHTML = '';
  for (const u of d.users || []) {
    const row = document.createElement('div');
    row.className = 'row' + (u.speaking ? ' speaking' : '') + (u.muted || u.deafened ? ' muted' : '');
    const dot = document.createElement('div'); dot.className = 'dot'; dot.textContent = (u.name[0] || '?').toUpperCase();
    const nm = document.createElement('span'); nm.textContent = u.name;
    row.append(dot, nm);
    if (u.deafened || u.muted) {
      const t = document.createElement('span'); t.className = 'tag'; t.textContent = u.deafened ? 'deaf' : 'muted'; row.append(t);
    }
    wrap.appendChild(row);
  }
  for (const n of d.notes || []) {
    const el = document.createElement('div'); el.className = 'note'; el.textContent = n; wrap.appendChild(el);
  }
});
