'use strict';
// "Internet mode" helper: asks your router (UPnP) to forward the room port so
// friends can reach you directly without a VPN. Best-effort; many routers
// disable UPnP and ISPs using CGNAT cannot be reached at all.
let gateway = null, mapped = null;

async function map(port, localIp) {
  await unmap();
  try {
    const { upnpNat } = await import('@achingbrain/nat-port-mapper');
    const client = upnpNat({ description: 'GameChat' });
    for await (const g of client.findGateways({ signal: AbortSignal.timeout(8000) })) {
      await g.map(port, localIp, { protocol: 'tcp' });
      let publicIp = null;
      try { publicIp = await g.externalIp(); } catch {}
      gateway = g; mapped = port;
      return { ok: true, publicIp };
    }
    return { ok: false, error: 'No UPnP router found. UPnP may be turned off on your router.' };
  } catch (e) {
    return { ok: false, error: 'Port mapping failed: ' + (e && e.message ? e.message : e) };
  }
}
async function unmap() {
  if (!gateway) return;
  try { await gateway.unmap(mapped); } catch {}
  try { await gateway.stop(); } catch {}
  gateway = null; mapped = null;
}
module.exports = { map, unmap };
