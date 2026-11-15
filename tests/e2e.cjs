// End-to-end test: two isolated browsers (host + guest) talking through a local relay.
const { chromium } = require('playwright');
const path = require('path'), fs = require('fs');
const { serve } = require('./serve.cjs');
const { broker } = require('./broker.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const OUT = path.join(__dirname, 'out');
const WEB = 4173, MQ = 18830;
const URL0 = `http://127.0.0.1:${WEB}/`;
let failed = 0;
const ok = (name, cond, extra = '') => { console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : '')); if (!cond) failed++; };
const only = process.argv[2];

async function ctx(browser, conf = {}) {
  const c = await browser.newContext({ permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'], locale: 'ru-RU', viewport: { width: 420, height: 800 } });
  const all = { brokers: process.env.REAL ? ['wss://public:public@public.cloud.shiftr.io'] : [`ws://127.0.0.1:${MQ}`], ice: [], lang: 'ru', ...conf };
  await c.addInitScript(cfg => { for (const [k, v] of Object.entries(cfg)) if (localStorage.getItem('vz.' + k) == null) localStorage.setItem('vz.' + k, JSON.stringify(v)); }, all);
  const p = await c.newPage();
  p.on('pageerror', e => { console.log('   [pageerror]', e.message); failed++; });
  p.on('console', m => { if (m.type() === 'error' || process.env.VERBOSE) console.log('   [console.' + m.type() + ']', m.text().slice(0, 300)); });
  p.on('dialog', d => d.accept());
  return p;
}
const st = (p, id) => p.evaluate(i => { const r = i ? __vz.rooms.get(i) : [...__vz.rooms.values()][0]; return r ? { state: r.state, online: r.online, direct: r.direct, n: r.msgs.length, reject: r.reject, sas: r.sas, call: r.call.st, mode: r.rec.mode } : null; }, id);
const until = async (fn, ms = 15000, step = 150) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise(r => setTimeout(r, step)); } };

async function makeRoom(host, { secure = false } = {}) {
  await host.goto(URL0);
  await host.getByRole('button', { name: /Новый чат/ }).click();
  if (secure) await host.getByRole('button', { name: /Защищённый/ }).click();
  await host.getByRole('button', { name: 'Создать' }).click();
  await host.waitForSelector('#invite-url');
  return host.inputValue('#invite-url');
}
async function pair(browser, opts = {}) {
  const host = await ctx(browser, opts.hostConf), guest = await ctx(browser, opts.guestConf);
  const link = await makeRoom(host, opts);
  await guest.goto(link);
  const up = await until(async () => { const a = await st(host), b = await st(guest); return a && b && a.state === 'up' && b.state === 'up' && a.online && b.online; });
  return { host, guest, link, up };
}
const sendText = async (p, text) => { await p.fill('textarea', text); await p.keyboard.press('Enter'); };
const hasText = (p, text) => until(() => p.evaluate(x => [...document.querySelectorAll('.msg .txt')].some(e => e.textContent === x), text));

const tests = {
  async basic(browser) {
    const { host, guest, link, up } = await pair(browser);
    ok('session established', !!up);
    ok('invite link is short', link.length < 120, link.replace(/#.*/, '#…') + ' (' + link.length + ')');
    const direct = await until(async () => (await st(host)).direct && (await st(guest)).direct, 12000);
    ok('direct P2P link', !!direct);
    const a = await st(host), b = await st(guest);
    ok('safety codes match', a.sas && a.sas === b.sas, a.sas);
    await sendText(host, 'привет от хоста');
    ok('guest receives text', !!(await hasText(guest, 'привет от хоста')));
    await sendText(guest, 'ответ гостя https://example.com/x');
    ok('host receives text', !!(await hasText(host, 'ответ гостя https://example.com/x')));
    ok('delivery tick', !!(await until(() => host.evaluate(() => [...document.querySelectorAll('.msg.me .meta')].some(e => e.textContent.includes('✓'))))));
    ok('invite secret removed from URL', !(await guest.url()).includes('#j='));
    // file transfer P2P (5 MB) with integrity check
    const big = path.join(OUT, 'big.bin');
    const data = require('crypto').randomBytes(5 * 1024 * 1024); fs.writeFileSync(big, data);
    await host.setInputFiles('input[type=file]', big);
    const got = await until(() => guest.evaluate(async () => {
      const r = [...__vz.rooms.values()][0]; const i = [...r.xfer.inc.values()].find(x => x.name === 'big.bin');
      if (!i || i.state !== 'done') return null;
      const h = await crypto.subtle.digest('SHA-256', await i.blob.arrayBuffer());
      return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
    }), 30000);
    ok('5 MB file arrives intact', got === require('crypto').createHash('sha256').update(data).digest('hex'));
    // image shows inline
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    fs.writeFileSync(path.join(OUT, 'dot.png'), png);
    await guest.setInputFiles('input[type=file]', path.join(OUT, 'dot.png'));
    ok('image shown inline on host', !!(await until(() => host.evaluate(() => !!document.querySelector('.msg:not(.me) img.media')))));
    // voice message
    await host.click('button[title="Голосовое"]');
    await host.waitForTimeout(1500);
    await host.click('#rec-send');
    ok('voice message plays on guest', !!(await until(() => guest.evaluate(() => !!document.querySelector('.msg:not(.me) audio')))));
    await host.screenshot({ path: path.join(OUT, 'chat-host.png') });
    await guest.screenshot({ path: path.join(OUT, 'chat-guest.png') });
    // reload guest → resume (fast mode keeps history)
    await guest.reload();
    const again = await until(async () => { const b = await st(guest); return b && b.state === 'up' && b.online && b.direct; }, 20000);
    ok('guest resumes after reload', !!again);
    ok('history kept after reload', (await st(guest)).n >= 4);
    await sendText(guest, 'после перезагрузки');
    ok('messages flow after resume', !!(await hasText(host, 'после перезагрузки')));
    // second device cannot reuse the one-time invite
    const thief = await ctx(browser);
    await thief.goto(link);
    const rej = await until(async () => (await st(thief))?.reject, 10000);
    ok('one-time invite rejected for another device', rej === 'used', String(rej));
    // wipe
    await host.click('#menu-btn');
    await host.getByRole('button', { name: /Удалить всё у обоих/ }).click();
    ok('wipe removes room on both sides', !!(await until(async () => !(await st(host)) && !(await st(guest)), 8000)));
  },
  async multi(browser) {
    // one host, two rooms with two guests at once; host reload must resume both
    const host = await ctx(browser), g1 = await ctx(browser), g2 = await ctx(browser);
    const l1 = await makeRoom(host); const l2 = await makeRoom(host);
    await g1.goto(l1); await g2.goto(l2);
    const both = () => host.evaluate(() => [...__vz.rooms.values()].every(r => r.state === 'up' && r.online) && __vz.rooms.size === 2);
    ok('two rooms up at once', !!(await until(both)));
    await sendText(g1, 'от первого');
    ok('unread badge for background room', !!(await until(() => host.evaluate(() => [...__vz.rooms.values()].some(r => r.rec.unread === 1)))));
    await host.reload();
    const resumed = await until(both, 20000);
    ok('host reload resumes both rooms', !!resumed, resumed ? '' : JSON.stringify(await host.evaluate(() => [...__vz.rooms.values()].map(r => ({ st: r.state, on: r.online, d: r.direct, dead: r.rec.dead, tmp: r.rec.tmp, role: r.rec.role })))) + ' g1=' + JSON.stringify(await st(g1)) + ' g2=' + JSON.stringify(await st(g2)));
    await sendText(g2, 'после перезапуска хоста');
    ok('guest → host after host reload', !!(await hasText(host, 'после перезапуска хоста')));
    await host.goto(URL0);
    await host.screenshot({ path: path.join(OUT, 'home-host.png') });
    // XSS probe: hostile file name and type must stay inert
    await g2.evaluate(() => { const r = [...__vz.rooms.values()][0]; r.sendFile(new Blob(['<script>window.__pwn=1</script><svg onload="window.__pwn=1">'], { type: 'text/html' }), '<img src=x onerror=window.__pwn=1>.html'); r.sendText('<img src=x onerror=window.__pwn=1>'); });
    await host.click('.room >> nth=0');
    const types = await until(() => host.evaluate(() => { const t = [...__vz.rooms.values()].flatMap(r => [...r.xfer.inc.values()]).filter(i => i.state === 'done').map(i => i.blob.type); return t.length ? t : null; }), 12000);
    ok('hostile file is stored as an opaque download', !!types && types.every(x => x === 'application/octet-stream'), JSON.stringify(types));
    ok('hostile text shown as plain text', !!(await hasText(host, '<img src=x onerror=window.__pwn=1>')));
    await host.waitForTimeout(500);
    ok('no script executed', !(await host.evaluate(() => !!window.__pwn)) && await host.evaluate(() => !document.querySelector('.msgs img[src=x]')));
  },
  async relay(browser) {
    const { host, guest, up } = await pair(browser, { hostConf: { nop2p: true }, guestConf: { nop2p: true } });
    ok('session via relay only', !!up && !(await st(host)).direct);
    await sendText(host, 'через ретранслятор');
    ok('text via relay', !!(await hasText(guest, 'через ретранслятор')));
    const small = path.join(OUT, 'small.bin');
    const data = require('crypto').randomBytes(180 * 1024); fs.writeFileSync(small, data);
    await guest.setInputFiles('input[type=file]', small);
    const got = await until(() => host.evaluate(async () => {
      const r = [...__vz.rooms.values()][0]; const i = [...r.xfer.inc.values()][0];
      if (!i || i.state !== 'done') return null;
      const h = await crypto.subtle.digest('SHA-256', await i.blob.arrayBuffer());
      return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
    }), 40000);
    ok('180 KB file via relay intact', got === require('crypto').createHash('sha256').update(data).digest('hex'));
    await host.click('button[title="Звонок"]');
    ok('call refused without direct link (toast)', !!(await until(() => host.evaluate(() => !!document.querySelector('.toast')))));
    // disconnect → peer sees offline
    await guest.click('#menu-btn');
    await guest.getByRole('button', { name: /Разорвать соединение/ }).click();
    ok('peer shown offline after disconnect', !!(await until(async () => !(await st(host)).online, 8000)));
    await guest.getByRole('button', { name: 'Подключиться' }).click();
    ok('reconnect works', !!(await until(async () => { const a = await st(host); return a.state === 'up' && a.online; }, 15000)));
  },
  async call(browser) {
    const { host, guest, up } = await pair(browser);
    ok('session established', !!up);
    await until(async () => (await st(host)).direct && (await st(guest)).direct, 12000);
    await host.click('button[title="Видеозвонок"]');
    ok('guest rings', !!(await until(async () => (await st(guest)).call === 'in', 8000)));
    await guest.click('#call-accept-video');
    ok('call active on both', !!(await until(async () => (await st(host)).call === 'on' && (await st(guest)).call === 'on', 10000)));
    const flowing = p => until(() => p.evaluate(async () => {
      const r = [...__vz.rooms.values()][0]; const s = await r.rtc.pc.getStats(); let a = 0, v = 0;
      s.forEach(x => { if (x.type === 'inbound-rtp') { if (x.kind === 'audio') a = x.packetsReceived; if (x.kind === 'video') v = x.framesDecoded || x.packetsReceived; } });
      return a > 20 && v > 5 ? { a, v } : null;
    }), 15000, 500);
    ok('host receives audio+video', !!(await flowing(host)));
    ok('guest receives audio+video', !!(await flowing(guest)));
    ok('remote video element playing', !!(await until(() => host.evaluate(() => { const v = document.querySelector('video.remote'); return v && v.videoWidth > 0 && !v.paused; }), 8000)));
    await host.screenshot({ path: path.join(OUT, 'call-host.png') });
    await guest.click('#call-mic');
    await sendText; // noop
    await host.click('#call-end');
    ok('call ends on both', !!(await until(async () => (await st(host)).call === 'idle' && (await st(guest)).call === 'idle', 8000)));
    // second call in the opposite direction, audio only (reuses transceivers)
    await guest.click('button[title="Звонок"]');
    ok('host rings (2nd call)', !!(await until(async () => (await st(host)).call === 'in', 8000)));
    await host.click('#call-accept');
    const audio2 = p => until(() => p.evaluate(async () => {
      const r = [...__vz.rooms.values()][0]; const s = await r.rtc.pc.getStats(); let a0 = 0;
      s.forEach(x => { if (x.type === 'inbound-rtp' && x.kind === 'audio') a0 = x.packetsReceived; });
      window.__a0 = window.__a0 || a0; return a0 > window.__a0 + 40;
    }), 15000, 500);
    ok('2nd call: audio flows to host', !!(await audio2(host)));
    ok('2nd call: audio flows to guest', !!(await audio2(guest)));
    await guest.click('#call-end');
    ok('2nd call ends', !!(await until(async () => (await st(host)).call === 'idle', 8000)));
  },
  async secure(browser) {
    const { host, guest, up } = await pair(browser, { secure: true });
    ok('secure session established', !!up && (await st(guest)).mode === 's');
    await sendText(host, 'секрет');
    ok('guest receives', !!(await hasText(guest, 'секрет')));
    ok('nothing persisted on guest', (await guest.evaluate(() => new Promise(r => { const q = indexedDB.open('vzhooh'); q.onsuccess = () => { const d = q.result; if (!d.objectStoreNames.contains('rooms')) return r(0); const t = d.transaction(['rooms', 'msgs']); const a = t.objectStore('rooms').count(), b = t.objectStore('msgs').count(); t.oncomplete = () => r(a.result + b.result); }; q.onerror = () => r(-1); }))) === 0);
    // auto-delete timer
    await host.click('#menu-btn');
    await host.selectOption('.menu select', '30');
    await host.evaluate(() => { const r = [...__vz.rooms.values()][0]; r.rec.timer = 2; r.sendR({ t: 'tm', s: 2 }); });
    await host.waitForTimeout(600);
    await sendText(host, 'исчезну');
    ok('timed message arrives', !!(await hasText(guest, 'исчезну')));
    ok('timed message auto-deletes on both', !!(await until(async () => !(await guest.evaluate(() => [...document.querySelectorAll('.msg .txt')].some(e => e.textContent === 'исчезну'))) && !(await host.evaluate(() => [...document.querySelectorAll('.msg .txt')].some(e => e.textContent === 'исчезну'))), 8000)));
    // guest disconnects → both wiped
    await guest.click('#menu-btn');
    await guest.getByRole('button', { name: /Разорвать соединение/ }).click();
    ok('secure room destroyed on both sides', !!(await until(async () => !(await st(host)) && !(await st(guest)), 8000)));
  },
  async curtain(browser, env) {
    env.mq.state.curtain = 16000;
    const { host, guest, up } = await pair(browser, { hostConf: { nop2p: true }, guestConf: { nop2p: true } });
    ok('session under 16 KB curtain', !!up);
    let delivered = 0;
    for (let i = 0; i < 40; i++) { await sendText(host, 'msg ' + i + ' ' + require('crypto').randomBytes(300).toString('base64')); await host.waitForTimeout(120); }
    const all = await until(async () => { delivered = await guest.evaluate(() => document.querySelectorAll('.msg:not(.me) .txt').length); return delivered >= 40; }, 60000, 500);
    ok('40 messages (~20 KB) delivered through freezing connections', !!all, delivered + '/40, frozen conns: ' + env.mq.state.frozen + ', total conns: ' + env.mq.state.conns);
    const rot = await guest.evaluate(() => __vz.wire.conns.map(c => ({ curtain: c.curtain, at: c.rotateAt })));
    ok('freeze detected, rotation enabled', rot.some(r => r.curtain), JSON.stringify(rot));
    env.mq.state.curtain = 0;
  },
  async pairing(browser) {
    const srv = require('./serve.cjs');
    const PASS = 'correct horse battery staple';
    const host = await ctx(browser);
    await host.goto(URL0 + '#set');
    await host.fill('input[autocomplete=new-password] >> nth=0', PASS);
    await host.fill('input[autocomplete=new-password] >> nth=1', PASS);
    await host.getByRole('button', { name: 'Создать ключ владельца' }).click();
    await host.waitForSelector('textarea.mono');
    const file = await host.inputValue('textarea.mono');
    ok('owner file generated', JSON.parse(file).v === 1 && !file.includes(PASS));
    srv.overrides['/owner.json'] = file;
    try {
      await host.goto(URL0); await host.reload();
      ok('claimed site: no "new chat" before sign-in', await host.getByRole('button', { name: /Новый чат/ }).count() === 0);
      await host.getByRole('button', { name: 'Вход владельца' }).click();
      await host.fill('input[type=password]', 'wrong password!!');
      await host.getByRole('button', { name: 'Войти' }).click();
      ok('wrong passphrase rejected', !!(await until(() => host.evaluate(() => document.querySelector('.toast')?.textContent === 'Неверный пароль'))));
      await host.fill('input[type=password]', PASS);
      await host.getByRole('button', { name: 'Войти' }).click();
      ok('owner signed in', !!(await until(async () => await host.getByRole('button', { name: /Новый чат/ }).count() === 1)));
      await host.reload();
      ok('owner remembered after reload', !!(await until(async () => await host.getByRole('button', { name: /Новый чат/ }).count() === 1)));
      // a new device shows a pairing QR; the owner opens its link
      const dev = await ctx(browser);
      await dev.goto(URL0);
      const purl = await until(() => dev.evaluate(() => document.querySelector('.qrbox')?.dataset.url));
      ok('device shows pairing QR', !!purl && purl.includes('#p='));
      await host.goto(purl);
      await host.getByRole('button', { name: /Быстрый/ }).click();
      const up = await until(async () => { const a = await st(host), b = await dev.evaluate(() => { const r = [...__vz.rooms.values()].find(x => !x.rec.tmp); return r ? { state: r.state, direct: r.direct } : null; }); return a && b && a.state === 'up' && b.state === 'up'; });
      ok('paired: session up (owner signature verified)', !!up);
      ok('device jumped into the chat', !!(await until(() => dev.evaluate(() => location.hash.startsWith('#r=')))));
      await sendText(host, 'файл для компа');
      ok('device receives text', !!(await hasText(dev, 'файл для компа')));
      // normal invite on a claimed site
      const link = await makeRoom(host);
      const guest = await ctx(browser);
      await guest.goto(link);
      ok('invite works on claimed site', !!(await until(async () => (await st(guest))?.state === 'up')));
      // an impostor (does not have the owner key) creates a room: guests must refuse it
      const fake = await ctx(browser);
      await fake.route('**/owner.json', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
      const flink = await makeRoom(fake);
      const victim = await ctx(browser);
      await victim.goto(flink);
      const rej = await until(async () => (await st(victim))?.reject, 10000);
      ok('room of a non-owner is refused', rej === 'sig', String(rej));
    } finally { delete srv.overrides['/owner.json']; }
  },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const web = await serve(DIST, WEB);
  const mq = await broker(MQ);
  const browser = await chromium.launch({ proxy: process.env.REAL ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  for (const [name, fn] of Object.entries(tests)) {
    if (only && name !== only) continue;
    console.log('▶ ' + name);
    const t0 = Date.now();
    try { await fn(browser, { mq }); } catch (e) { console.log('  ✗ exception: ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' | ')); failed++; }
    for (const c of browser.contexts()) await c.close();
    console.log('  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  }
  await browser.close(); await mq.close(); web.close();
  console.log(failed ? `\nFAILED: ${failed}` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
