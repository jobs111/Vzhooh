// Network diagnostics: what is reachable from this device. The report is meant to be copied to the developer.
import { app, VERSION } from './app';
import { t } from './i18n';
import { Mqtt } from './mqtt';
import { copyText, go, mount } from './ui';
import { canZ, h, now, sleep } from './util';

const mask = (ip: string) => ip.includes(':') ? ip.split(':').slice(0, 2).join(':') + ':…' : ip.split('.').slice(0, 2).join('.') + '.x.x';

async function siteTest(log: (s: string) => void) {
  const ac = new AbortController(), t0 = now();
  let got = 0;
  const to = setTimeout(() => ac.abort(), 10000);
  try {
    const r = await fetch('./probe.bin?' + t0, { cache: 'no-store', signal: ac.signal });
    const rd = r.body!.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; got += value.length; }
    log(`site: ${got} B in ${now() - t0} ms — OK`);
  } catch { log(`site: STALLED after ${got} B (${now() - t0} ms)`); }
  clearTimeout(to);
}
function brokerTest(url: string, log: (s: string) => void): Promise<void> {
  return new Promise(res => {
    const host = url.replace(/^wss?:\/\/([^@/]*@)?/, '').split('/')[0];
    const m = new Mqtt(url), t0 = now(), topic = 'vz/diag/' + Math.random().toString(36).slice(2);
    const N = 24;
    let upMs = -1, got = 0, first = -1, finished = false;
    const fin = () => {
      if (finished) return;
      finished = true;
      log(upMs < 0 ? `${host}: NO CONNECTION` : `${host}: up ${upMs} ms, echo ${first} ms, ${got}/${N} KB` + (got < N ? ' — FREEZE/LOSS' : ' — OK'));
      m.close(); res();
    };
    m.onup = async () => {
      upMs = now() - t0;
      m.subscribe([topic]);
      await sleep(400);
      const sent = now();
      m.onmsg = () => { if (first < 0) first = now() - sent; if (++got >= N) fin(); };
      const payload = crypto.getRandomValues(new Uint8Array(1000));
      for (let i = 0; i < N && !finished; i++) { m.publish(topic, payload); await sleep(120); }
    };
    m.ondown = () => fin();
    m.open();
    setTimeout(fin, 12000);
  });
}
/** Deeper look at a relay that works: is the limit counted in bytes or packets, and does sending count too? */
function budgetTest(url: string, log: (s: string) => void): Promise<void> {
  return new Promise(res => {
    const host = url.replace(/^wss?:\/\/([^@/]*@)?/, '').split('/')[0];
    const a = new Mqtt(url), b = new Mqtt(url), tp = 'vz/diag/' + Math.random().toString(36).slice(2);
    let small = 0, recvOnly = 0, done = false, phase = 0;
    const fin = (note = '') => { if (done) return; done = true; log(`${host}: small packets ${small}/60, receive-only ${recvOnly}/24 KB${note}`); a.close(); b.close(); res(); };
    a.onmsg = () => { if (phase === 1) small++; };
    b.onmsg = () => { if (phase === 2) recvOnly++; };
    let ups = 0;
    const go = async () => {
      if (++ups < 2) return;
      a.subscribe([tp + '/s']); b.subscribe([tp + '/r']);
      await sleep(400);
      phase = 1;
      const s150 = crypto.getRandomValues(new Uint8Array(150));
      for (let i = 0; i < 60 && !done; i++) { a.publish(tp + '/s', s150); await sleep(50); }
      await sleep(1500);
      phase = 2;
      const k1 = crypto.getRandomValues(new Uint8Array(1000));
      for (let i = 0; i < 24 && !done; i++) { a.publish(tp + '/r', k1); await sleep(100); }
      await sleep(2500);
      let alive = false;
      a.onpong = () => { alive = true; };
      a.ping();
      await sleep(2000);
      fin(`, sender after 33 KB up: ${alive ? 'alive' : 'FROZEN'}`);
    };
    a.onup = go; b.onup = go;
    a.ondown = b.ondown = () => fin(' (connection lost)');
    a.open(); b.open();
    setTimeout(() => fin(' (timeout)'), 20000);
  });
}
async function stun(servers: RTCIceServer[], ms = 5000): Promise<{ srflx: string[]; host: string[]; ms: number }> {
  const pc = new RTCPeerConnection({ iceServers: servers });
  const srflx = new Set<string>(), host = new Set<string>(), t0 = now();
  let first = 0;
  pc.createDataChannel('x');
  const done = new Promise<void>(res => {
    pc.onicecandidate = e => {
      const c = e.candidate;
      if (!c) { res(); return; }
      if (c.type === 'srflx' && c.address) { srflx.add(`${c.address}|${c.port}`); first ||= now() - t0; }
      else if (c.type === 'host') host.add(c.address?.endsWith('.local') ? 'mdns' : c.address?.includes(':') ? 'ipv6' : 'ipv4');
    };
  });
  await pc.setLocalDescription(await pc.createOffer());
  await Promise.race([done, sleep(ms)]);
  pc.close();
  return { srflx: [...srflx], host: [...host], ms: first };
}
async function stunTest(log: (s: string) => void) {
  if (typeof RTCPeerConnection === 'undefined') { log('WebRTC: NOT AVAILABLE'); return; }
  const ok: RTCIceServer[] = [];
  await Promise.all(app.ice().map(async s => {
    const name = String(Array.isArray(s.urls) ? s.urls[0] : s.urls);
    try {
      const r = await stun([s]);
      if (r.srflx.length) { ok.push(s); log(`${name}: OK ${r.ms} ms → ${r.srflx.map(x => mask(x.split('|')[0]) + ':' + x.split('|')[1]).join(', ')}`); }
      else log(`${name}: no answer (local: ${r.host.join('/') || '-'})`);
    } catch (e) { log(`${name}: error ${e}`); }
  }));
  if (ok.length >= 2) {
    const r = await stun(ok.slice(0, 2));
    const v4 = r.srflx.filter(x => !x.split('|')[0].includes(':'));
    const ports = new Set(v4.map(x => x.split('|')[1]));
    log(`NAT: ${v4.length === 0 ? 'unknown' : ports.size <= 1 ? 'cone-like — direct connections should work' : 'symmetric — direct connections are unlikely on this network'}` +
      (r.srflx.some(x => x.split('|')[0].includes(':')) ? ' · IPv6 available' : ''));
  } else log('NAT: not enough STUN answers to tell');
}

export function diagView() {
  const out = h('pre.report');
  const lines: string[] = [];
  const log = (s: string) => { lines.push(s); out.textContent = lines.join('\n'); };
  const btn = h('button.primary', t('run')) as HTMLButtonElement;
  btn.onclick = async () => {
    btn.disabled = true;
    lines.length = 0;
    const c = (navigator as any).connection;
    log(`Vzhooh ${VERSION} · ${new Date().toISOString()}`);
    log(`UA: ${navigator.userAgent}`);
    log(`net: online=${navigator.onLine}` + (c ? ` type=${c.effectiveType} down=${c.downlink} rtt=${c.rtt}` : ''));
    log(`features: webrtc=${typeof RTCPeerConnection !== 'undefined'} media=${!!navigator.mediaDevices?.getUserMedia} rec=${typeof MediaRecorder !== 'undefined'} z=${canZ} sw=${'serviceWorker' in navigator} standalone=${matchMedia('(display-mode: standalone)').matches}`);
    await siteTest(log);
    log('--- relays');
    await Promise.all(app.brokers().map(u => brokerTest(u, log)));
    log('--- relay budget');
    for (const c of app.wire.conns.filter(x => x.good)) await budgetTest(c.url, log);
    log('--- app state');
    for (const c of app.wire.conns) log(`${c.url.replace(/^wss?:\/\/([^@/]*@)?/, '').split('/')[0]}: ${c.good ? 'in use' : c.up ? 'connected, not delivering' : 'off'}${c.curtain ? `, freezes at ~${c.limit} B, replaced ${c.rotations}×` : ''}`);
    for (const l of app.wire.log.slice(-12)) log('  ' + l);
    log('--- STUN');
    await stunTest(log);
    log('--- done');
    btn.disabled = false;
  };
  mount(h('div.page',
    h('header.bar', h('button.ic', { onclick: () => go('') }, '←'), h('div.ttl', t('diag'))),
    h('main.body', h('p.hint', t('diagHint')), h('div.row', btn, h('button', { onclick: () => copyText(lines.join('\n')) }, t('copyReport'))), out)));
}
