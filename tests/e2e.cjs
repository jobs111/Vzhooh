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

async function ctx(browser, conf = {}, viewport = { width: 420, height: 800 }) {
  const c = await browser.newContext({ permissions: ['microphone', 'camera', 'clipboard-read', 'clipboard-write'], locale: 'ru-RU', viewport, acceptDownloads: true });
  const all = { brokers: process.env.REAL ? ['wss://public:public@public.cloud.shiftr.io'] : [`ws://127.0.0.1:${MQ}`], ice: [], lang: 'ru', debug: true, ...conf };
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
  const host = await ctx(browser, opts.hostConf, opts.vp), guest = await ctx(browser, opts.guestConf, opts.vp);
  const link = await makeRoom(host, opts);
  await guest.goto(link);
  const up = await until(async () => { const a = await st(host), b = await st(guest); return a && b && a.state === 'up' && b.state === 'up' && a.online && b.online; });
  return { host, guest, link, up };
}
const sendText = async (p, text) => { await p.fill('textarea', text); await p.keyboard.press('Enter'); };
const hasText = (p, text) => until(() => p.evaluate(x => [...document.querySelectorAll('.msg .txt')].some(e => e.textContent === x), text));

const jsQR = require('jsqr');
const sha = b => require('crypto').createHash('sha256').update(b).digest('hex');
const rndFile = (name, size) => { const d = require('crypto').randomBytes(size); fs.writeFileSync(path.join(OUT, name), d); return { file: path.join(OUT, name), hash: sha(d) }; };
/** Read the QR code drawn on a canvas the way a phone camera would. */
async function scanQr(page, selector) {
  const img = await page.evaluate(sel => { const c = document.querySelector(sel); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); return { w: c.width, h: c.height, data: Array.from(d.data) }; }, selector);
  const r = jsQR(Uint8ClampedArray.from(img.data), img.w, img.h);
  return r && r.data;
}
const hashOf = (p, name) => until(() => p.evaluate(async n => {
  const all = [...__vz.rooms.values()].flatMap(r => [...r.xfer.inc.values()]);
  const i = all.find(x => x.name === n);
  if (!i || i.state !== 'done') return null;
  const h = await crypto.subtle.digest('SHA-256', await i.blob.arrayBuffer());
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, '0')).join('');
}, name), 40000, 300);
const stOf = (p, filter) => p.evaluate(f => [...__vz.rooms.values()].filter(r => !f || (f === 'lobby' ? r.rec.lid : true)).map(r => ({ id: r.rec.id, state: r.state, online: r.online, direct: r.direct, n: r.msgs.length, reject: r.reject, lid: r.rec.lid, share: r.rec.share })), filter);

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
    await host.click('.room:not(.fav) >> nth=0');
    const types = await until(() => host.evaluate(() => { const t = [...__vz.rooms.values()].flatMap(r => [...r.xfer.inc.values()]).filter(i => i.state === 'done').map(i => i.blob.type); return t.length ? t : null; }), 12000);
    ok('hostile file is stored as an opaque download', !!types && types.every(x => x === 'application/octet-stream'), JSON.stringify(types));
    ok('hostile text shown as plain text', !!(await hasText(host, '<img src=x onerror=window.__pwn=1>')));
    await host.waitForTimeout(500);
    ok('no script executed', !(await host.evaluate(() => !!window.__pwn)) && await host.evaluate(() => !document.querySelector('.msgs img[src=x]')));
  },
  async scroll(browser) {
    const vp = { width: 360, height: 640 };
    const { host, guest, up } = await pair(browser, { vp });
    ok('session (phone screen 360×640)', !!up);
    await host.evaluate(() => { const r = [...__vz.rooms.values()][0]; for (let i = 0; i < 70; i++) r.sendText('сообщение номер ' + i + ' ' + 'текст '.repeat(i % 7)); });
    ok('70 messages arrive', !!(await until(async () => (await st(guest)).n >= 70, 20000)));
    await guest.waitForTimeout(400);
    const g = await guest.evaluate(() => { const l = document.getElementById('msgs'), c = document.querySelector('.composer').getBoundingClientRect(); return { sh: l.scrollHeight, ch: l.clientHeight, top: l.scrollTop, comp: c.bottom, doc: document.scrollingElement.scrollHeight, ih: innerHeight }; });
    ok('message list is a real scroll area', g.sh > g.ch + 500 && g.ch > 250, JSON.stringify(g));
    ok('opens at the newest message', g.top + g.ch >= g.sh - 4);
    ok('composer stays on screen', g.comp <= vp.height + 1);
    ok('page itself does not scroll (no double scroll)', g.doc <= g.ih + 1);
    await guest.mouse.move(180, 300);
    await guest.mouse.wheel(0, -2500);
    await guest.waitForTimeout(400);
    const top2 = await guest.evaluate(() => document.getElementById('msgs').scrollTop);
    ok('wheel/swipe scrolls the list up', top2 < g.top - 1500, g.top + ' → ' + top2);
    await host.evaluate(() => [...__vz.rooms.values()][0].sendText('новое внизу'));
    await guest.waitForTimeout(800);
    ok('reading history is not interrupted by a new message', Math.abs((await guest.evaluate(() => document.getElementById('msgs').scrollTop)) - top2) < 5);
    // home with many chats
    await host.evaluate(async () => { for (let i = 0; i < 25; i++) await __vz.createRoom({ name: 'Чат ' + i, secure: false, life: 3600e3, invTtl: 3600e3 }); });
    const saved = await until(() => host.evaluate(() => new Promise(r => { const q = indexedDB.open('vzhooh'); q.onsuccess = () => { const c = q.result.transaction('rooms').objectStore('rooms').count(); c.onsuccess = () => r(c.result >= 26); }; })), 8000);
    ok('26 chats saved on the device', !!saved);
    await host.goto(URL0);
    await host.waitForTimeout(500);
    await until(() => host.evaluate(() => document.querySelectorAll('.rooms .room').length >= 26), 8000);
    const hm = await host.evaluate(() => { const b = document.querySelector('.body'); return { sh: b.scrollHeight, ch: b.clientHeight, rooms: document.querySelectorAll('.rooms .room').length, all: __vz.visibleRooms.length }; });
    ok('home screen list scrolls', hm.sh > hm.ch + 300, JSON.stringify(hm));
    await host.mouse.move(180, 400);
    await host.mouse.wheel(0, 20000);
    await host.waitForTimeout(400);
    ok('bottom of home reachable', await host.evaluate(() => { const f = document.querySelector('.foot').getBoundingClientRect(); return f.bottom <= innerHeight + 1 && f.top >= 0; }));
    // settings: the last button must be reachable
    await host.goto(URL0 + '#set');
    await host.mouse.move(180, 400);
    await host.mouse.wheel(0, 20000);
    await host.waitForTimeout(400);
    ok('bottom of settings reachable', await host.evaluate(() => { const f = document.querySelector('.foot').getBoundingClientRect(); return f.bottom <= innerHeight + 1; }));
    // a fresh chat with the invite panel open on a small screen
    await host.goto(URL0 + '#new');
    await host.getByRole('button', { name: 'Создать' }).click();
    await host.waitForSelector('#invite-url');
    const pv = await host.evaluate(() => ({ comp: document.querySelector('.composer').getBoundingClientRect().bottom, panel: document.querySelector('.panel').getBoundingClientRect().height }));
    ok('invite panel fits and composer visible', pv.comp <= vp.height + 1 && pv.panel > 150, JSON.stringify(pv));
    await guest.screenshot({ path: path.join(OUT, 'phone-chat.png') });
    await host.screenshot({ path: path.join(OUT, 'phone-invite.png') });
  },
  async qr(browser) {
    const p = await ctx(browser);
    await p.goto(URL0);
    await p.click('#act-qr');
    await p.fill('#qr-input', 'https://vk.com/vzhooh_test?x=1&y=привет');
    await p.waitForSelector('canvas.qr');
    await p.waitForTimeout(300);
    ok('QR from a link scans back to the same text', (await scanQr(p, 'canvas.qr')) === 'https://vk.com/vzhooh_test?x=1&y=привет');
    const dl = p.waitForEvent('download');
    await p.getByRole('button', { name: /Скачать PNG/ }).click();
    const d = await dl;
    const png = await fs.promises.readFile(await d.path());
    ok('PNG download works', d.suggestedFilename() === 'qr.png' && png.slice(1, 4).toString() === 'PNG' && png.length > 2000, png.length + ' B');
    await p.getByRole('button', { name: /На весь экран/ }).click();
    ok('full-screen QR opens', await p.locator('.qrfull canvas').count() === 1);
    await p.click('.qrfull');
    ok('full-screen QR closes on tap', await p.locator('.qrfull').count() === 0);
    await p.reload();
    ok('last text remembered', (await p.inputValue('#qr-input')).startsWith('https://vk.com/'));
    // invite QR codes must scan to the invite link
    const link = await makeRoom(p);
    ok('invite QR scans to the invite link', (await scanQr(p, '.panel canvas.qr')) === link);
  },
  async lobby(browser) {
    const host = await ctx(browser);
    await host.goto(URL0);
    await host.click('#act-chat');
    await host.click('#who-many');
    await host.getByRole('button', { name: 'Создать' }).click();
    await host.waitForSelector('#lobby-url');
    const link = await host.inputValue('#lobby-url');
    ok('one QR for many devices created', link.includes('#j='));
    ok('lobby QR scans to its link', (await scanQr(host, '.invite canvas.qr')) === link);
    const gs = [];
    for (let i = 0; i < 3; i++) { const g = await ctx(browser); await g.goto(link); gs.push(g); }
    const allUp = await until(async () => { for (const g of gs) { const s = await st(g); if (!s || s.state !== 'up' || !s.online) return false; } return true; }, 25000);
    ok('3 devices connected with one QR', !!allUp);
    ok('owner has 3 separate chats', (await stOf(host, 'lobby')).length === 3);
    for (let i = 0; i < 3; i++) await sendText(gs[i], 'я устройство ' + i);
    const sep = await until(async () => {
      const rows = await host.evaluate(() => [...__vz.rooms.values()].filter(r => r.rec.lid).map(r => r.msgs.filter(m => !m.mine).map(m => m.text)));
      return rows.length === 3 && rows.every(x => x.length === 1) && new Set(rows.map(x => x[0])).size === 3;
    }, 15000);
    ok('each device talks only in its own chat', !!sep);
    await host.waitForSelector('.rooms .room');
    ok('lobby screen lists the devices', await host.locator('.rooms .room').count() === 3);
    await gs[0].reload();
    await until(async () => (await st(gs[0]))?.state === 'up', 15000);
    await gs[0].goto(link);
    await gs[0].waitForTimeout(2500);
    ok('reopening the link returns to the same chat (no duplicate)', (await stOf(gs[0])).length === 1 && (await stOf(host, 'lobby')).length === 3);
    // reply from the owner reaches only that device
    await host.evaluate(() => { const r = [...__vz.rooms.values()].find(r => r.rec.lid && r.msgs.some(m => m.text === 'я устройство 1')); r.sendText('ответ второму'); });
    ok('owner reply reaches the right device', !!(await hasText(gs[1], 'ответ второму')));
    await gs[2].waitForTimeout(800);
    ok('…and not the others', !(await gs[2].evaluate(() => [...document.querySelectorAll('.msg .txt')].some(e => e.textContent === 'ответ второму'))));
    // expired lobby refuses new devices
    await host.evaluate(() => { const l = [...__vz.lobbies.values()][0]; l.rec.invExp = Date.now() - 1000; });
    const late = await ctx(browser);
    await late.goto(link.replace(/#j=.*/, '') + '#j=' + link.split('#j=')[1]);
    const rej = await until(async () => (await st(late))?.reject, 15000);
    ok('expired shared invite refuses new devices', rej === 'exp', String(rej));
  },
  async share(browser) {
    const host = await ctx(browser);
    await host.goto(URL0);
    await host.click('#act-share');
    const big = rndFile('presentation.pdf', 3 * 1024 * 1024), small = rndFile('notes.txt', 2500);
    await host.setInputFiles('#share-files', [big.file, small.file]);
    await host.fill('textarea', 'Материалы встречи https://example.com/agenda');
    await host.click('#share-create');
    await host.waitForSelector('#lobby-url');
    const link = await host.inputValue('#lobby-url');
    const a = await ctx(browser), b = await ctx(browser, { nop2p: true });
    await Promise.all([a.goto(link), b.goto(link)]);
    ok('guest A downloads the 3 MB file intact', (await hashOf(a, 'presentation.pdf')) === big.hash);
    ok('guest A downloads the small file intact', (await hashOf(a, 'notes.txt')) === small.hash);
    ok('guest A sees the caption with a link', !!(await until(() => a.evaluate(() => !!document.querySelector('.notes a[href="https://example.com/agenda"]')))));
    ok('relay-only guest B gets the small file', (await hashOf(b, 'notes.txt')) === small.hash);
    ok('B is told the big file needs a direct link', !!(await until(() => b.evaluate(() => document.body.textContent.includes('прямого соединения')))));
    ok('download counter on the owner side', !!(await until(() => host.evaluate(() => [...__vz.lobbies.values()][0].rec.dl >= 3), 10000)));
    await a.screenshot({ path: path.join(OUT, 'share-guest.png') });
    await host.screenshot({ path: path.join(OUT, 'share-host.png') });
    ok('A has a working save button', await a.locator('a.btn[download="presentation.pdf"]').count() === 1);
    ok('guest sees the share name', !!(await until(() => a.evaluate(() => document.querySelector('.bar .ttl').textContent.includes('presentation.pdf')))));
    await a.reload();
    ok('reloaded download page reconnects to the share', (await hashOf(a, 'presentation.pdf')) === big.hash);
    // owner restarts the app: the share survives and keeps serving
    await host.reload();
    await host.waitForTimeout(1500);
    const c = await ctx(browser);
    await c.goto(link);
    ok('after owner restart a new guest still gets the file', (await hashOf(c, 'presentation.pdf')) === big.hash);
    ok('no duplicated files after the owner restart', (await a.evaluate(() => document.querySelectorAll('.fcard').length)) === 2);
    await host.goto(URL0 + '#l=' + (await host.evaluate(() => [...__vz.lobbies.keys()][0])));
    await host.click('#lobby-del');
    ok('share deleted with its rooms', !!(await until(() => host.evaluate(() => __vz.lobbies.size === 0 && ![...__vz.rooms.values()].some(r => r.rec.share)), 8000)));
  },
  async callroom(browser) {
    const host = await ctx(browser), guest = await ctx(browser);
    await host.goto(URL0);
    await host.click('#act-call');
    await host.click('#call-video');
    await host.waitForSelector('#invite-url');
    ok('call room shows its invite', (await host.textContent('.panel')).includes('Комната для звонка'));
    await host.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 360; const g = c.getContext('2d');
        setInterval(() => { g.fillStyle = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); g.fillRect(0, 0, 640, 360); }, 80);
        return c.captureStream(15);
      };
    });
    await guest.goto(await host.inputValue('#invite-url'));
    ok('guest gets rung automatically', !!(await until(async () => (await st(guest))?.call === 'in', 20000)));
    await guest.click('#call-accept-video');
    ok('call is on', !!(await until(async () => (await st(host)).call === 'on' && (await st(guest)).call === 'on', 10000)));
    const frames = p => p.evaluate(async () => { const r = [...__vz.rooms.values()][0]; let v = 0, a = 0; (await r.rtc.pc.getStats()).forEach(x => { if (x.type === 'inbound-rtp') { if (x.kind === 'video') v = x.framesDecoded || 0; if (x.kind === 'audio') a = x.packetsReceived || 0; } }); return { v, a }; });
    ok('audio + video both ways', !!(await until(async () => { const x = await frames(host), y = await frames(guest); return x.v > 5 && y.v > 5 && x.a > 20 && y.a > 20; }, 15000, 500)));
    await host.click('#call-screen');
    ok('screen sharing starts', !!(await until(() => host.evaluate(() => [...__vz.rooms.values()][0].call.scr), 8000)));
    const v0 = (await frames(guest)).v;
    ok('guest receives the shared screen', !!(await until(async () => (await frames(guest)).v > v0 + 15, 10000, 500)));
    await host.click('#call-screen');
    ok('screen sharing stops (back to camera)', !!(await until(() => host.evaluate(() => { const r = [...__vz.rooms.values()][0]; return !r.call.scr && r.rtc.local.getVideoTracks().length === 1; }), 8000)));
    await host.click('#call-end');
    ok('call ends; no automatic re-dial', !!(await until(async () => (await st(guest)).call === 'idle', 8000)) && (await host.evaluate(() => [...__vz.rooms.values()][0].rec.called)));
  },
  async extras(browser) {
    const { host, guest, up } = await pair(browser);
    ok('session', !!up);
    await sendText(host, 'удали меня');
    await sendText(host, 'останусь');
    ok('messages arrive', !!(await hasText(guest, 'останусь')));
    await host.locator('.msg.me .txt', { hasText: 'удали меня' }).click();
    await host.getByRole('button', { name: /Удалить у всех/ }).click();
    const gone = await until(async () => !(await guest.evaluate(() => [...document.querySelectorAll('.msg .txt')].some(e => e.textContent === 'удали меня'))) && !(await host.evaluate(() => [...document.querySelectorAll('.msg .txt')].some(e => e.textContent === 'удали меня'))), 8000);
    ok('"delete for everyone" removes it on both sides', !!gone);
    ok('other messages stay', !!(await hasText(guest, 'останусь')));
    await guest.locator('.msg .txt', { hasText: 'останусь' }).click();
    await guest.getByRole('button', { name: /Копировать/ }).click();
    ok('copy text works', (await guest.evaluate(() => navigator.clipboard.readText())) === 'останусь');
  },
  async reconnect(browser, env) {
    const { host, guest, up } = await pair(browser, { hostConf: { nop2p: true }, guestConf: { nop2p: true } });
    ok('session via relay', !!up);
    await env.mq.close();
    ok('outage shown: "reconnecting"', !!(await until(() => host.evaluate(() => { const n = document.querySelector('.netbar'); return n && !n.hidden && n.textContent.includes('переподключаюсь'); }), 12000)));
    ok('chat status says reconnecting', !!(await until(async () => (await host.textContent('.bar .sub')).includes('переподключ'), 4000)));
    await sendText(host, 'написано без связи');
    env.mq = await broker(MQ);
    const btn = host.getByRole('button', { name: 'Переподключить сейчас' });
    if (await btn.isVisible()) await btn.click({ timeout: 3000 }).catch(() => {});   // it may already have reconnected by itself
    await guest.evaluate(() => __vz.kick());
    ok('connection restored automatically', !!(await until(async () => { const a = await st(host), b = await st(guest); return a.online && b.online && a.state === 'up'; }, 30000)));
    ok('message written offline is delivered', !!(await hasText(guest, 'написано без связи')));
    ok('banner disappears', !!(await until(() => host.evaluate(() => document.querySelector('.netbar').hidden), 6000)));
  },
  async group(browser) {
    const host = await ctx(browser);
    await host.goto(URL0);
    await host.click('#act-chat'); await host.click('#who-group');
    await host.fill('input[type=text]', 'Штаб');
    await host.getByRole('button', { name: 'Создать' }).click();
    await host.waitForSelector('#invite-url');
    const link = await host.inputValue('#invite-url');
    const gs = [];
    for (let i = 0; i < 3; i++) { const g = await ctx(browser); await g.goto(link); gs.push(g); }
    const upAll = list => until(async () => { for (const g of list) { const x = await st(g); if (!x || x.state !== 'up' || !x.online) return false; } return true; }, 25000);
    ok('3 members joined the group by one QR', !!(await upAll(gs)));
    ok('owner sees one group chat, member links hidden', await host.evaluate(() => __vz.visibleRooms.length === 1 && __vz.visibleRooms[0].members.all === 3));
    ok('member sees the group name', !!(await until(() => gs[0].evaluate(() => document.querySelector('.bar .ttl').textContent.includes('Штаб')))));
    await sendText(host, 'всем привет');
    for (const g of gs) ok('member receives owner message', !!(await hasText(g, 'всем привет')));
    ok('sender label shown', await gs[0].evaluate(() => [...document.querySelectorAll('.msg .from')].some(e => e.textContent === 'Админ')));
    await gs[0].evaluate(() => { localStorage.setItem('vz.nick', '"Оля"'); [...__vz.rooms.values()][0].sendNick(); });
    await gs[0].waitForTimeout(700);
    await sendText(gs[0], 'я первый');
    ok('owner sees member message', !!(await hasText(host, 'я первый')));
    ok('other members see it with the name', !!(await hasText(gs[1], 'я первый')) && !!(await hasText(gs[2], 'я первый')) && await gs[1].evaluate(() => [...document.querySelectorAll('.msg .from')].some(e => e.textContent === 'Оля')));
    await gs[0].waitForTimeout(800);
    ok('sender does not get an echo', await gs[0].evaluate(() => [...document.querySelectorAll('.msg .txt')].filter(e => e.textContent === 'я первый').length === 1));
    const f1 = rndFile('from-member.bin', 300 * 1024);
    await gs[1].setInputFiles('input[type=file]', f1.file);
    ok('member file reaches another member intact', (await hashOf(gs[2], 'from-member.bin')) === f1.hash);
    ok('…and the owner', (await hashOf(host, 'from-member.bin')) === f1.hash);
    const f2 = rndFile('from-owner.bin', 3 * 1024 * 1024);
    await host.setInputFiles('input[type=file]', f2.file);
    ok('3 MB file from the owner reaches members (direct link on demand)', (await hashOf(gs[0], 'from-owner.bin')) === f2.hash && (await hashOf(gs[2], 'from-owner.bin')) === f2.hash);
    const late = await ctx(browser); await late.goto(link);
    ok('late joiner gets the history', !!(await hasText(late, 'всем привет')) && !!(await hasText(late, 'я первый')));
    await gs[2].reload();
    ok('member returns after reload with history', !!(await upAll([gs[2]])) && !!(await hasText(gs[2], 'я первый')));
    await host.reload();
    ok('group survives owner restart', !!(await until(() => host.evaluate(() => { const h = __vz.visibleRooms[0]; return h && h.rec.hub && h.members.on === 4; }), 25000)));
    await sendText(late, 'после перезапуска');
    ok('messages flow after owner restart', !!(await hasText(host, 'после перезапуска')) && !!(await hasText(gs[1], 'после перезапуска')));
    await host.screenshot({ path: path.join(OUT, 'group-host.png') });
    await host.click('#menu-btn');
    await host.getByRole('button', { name: /Удалить группу у всех/ }).click();
    ok('deleting the group removes it for members', !!(await until(async () => !(await st(gs[1])) && !(await st(late)) && await host.evaluate(() => __vz.rooms.size === 0 || [...__vz.rooms.values()].every(r => r.rec.fav)), 10000)));
  },
  async fav(browser) {
    const p = await ctx(browser);
    await p.goto(URL0);
    await p.click('#fav-row');
    await sendText(p, 'заметка на память');
    const f = rndFile('doc.pdf', 200000);
    await p.setInputFiles('input[type=file]', f.file);
    ok('note and file saved', !!(await hasText(p, 'заметка на память')));
    await p.reload();
    ok('favourites survive reload', !!(await hasText(p, 'заметка на память')) && !!(await until(() => p.evaluate(() => !!document.querySelector('.msg .fname')))));
    await p.locator('.msg .txt', { hasText: 'заметка на память' }).click();
    await p.getByRole('button', { name: /Хранить 24 часа/ }).click();
    ok('per-item keep time set', await p.evaluate(() => { const m = __vz.rooms.get('fav').msgs.find(x => x.text); return m.del > Date.now() + 23 * 3600e3; }));
    await p.evaluate(() => { __vz.rooms.get('fav').msgs.find(x => x.text).del = Date.now() - 1; });
    ok('expired item disappears, the rest stays', !!(await until(() => p.evaluate(() => { const r = __vz.rooms.get('fav'); return r.msgs.length === 1 && !!r.msgs[0].file; }), 5000)));
  },
  async intro(browser) {
    const host = await ctx(browser), a = await ctx(browser), b = await ctx(browser);
    const l1 = await makeRoom(host); await a.goto(l1);
    const l2 = await makeRoom(host); await b.goto(l2);
    ok('two friends connected to the owner', !!(await until(() => host.evaluate(() => [...__vz.rooms.values()].filter(r => r.state === 'up' && r.online).length === 2))));
    await host.goto(URL0); await host.click('#home-menu'); await host.getByRole('button', { name: /Соединения/ }).click();
    const kp = await until(async () => { const x = (await host.textContent('.kpis')).replace(/\s/g, ''); return x.startsWith('2соединений2всети') ? x : null; }, 15000);
    ok('connections panel counts', !!kp, String(kp));
    await host.click('#intro-do');
    const both = await until(async () => (await a.evaluate(() => __vz.rooms.size)) === 2 && (await b.evaluate(() => __vz.rooms.size)) === 2, 10000);
    ok('both friends got a new chat', !!both);
    const peerUp = p => until(() => p.evaluate(() => { const r = [...__vz.rooms.values()].find(x => x.rec.intro); return r && r.state === 'up' && r.online; }), 20000);
    ok('friends are connected to each other', !!(await peerUp(a)) && !!(await peerUp(b)));
    await a.evaluate(() => [...__vz.rooms.values()].find(x => x.rec.intro).sendText('привет напрямую'));
    ok('friend-to-friend message arrives', !!(await until(() => b.evaluate(() => [...__vz.rooms.values()].find(x => x.rec.intro).msgs.some(m => m.text === 'привет напрямую')))));
    ok('owner cannot see their conversation', await host.evaluate(() => ![...__vz.rooms.values()].some(r => r.msgs.some(m => m.text === 'привет напрямую'))));
    ok('friends did not become admins of each other (no extra rooms on owner)', await host.evaluate(() => __vz.rooms.size === 2 || [...__vz.rooms.values()].filter(r => !r.local).length === 2));
    await host.getByRole('button', { name: 'Разорвать' }).last().click();
    ok('owner can end the introduction', !!(await until(async () => (await a.evaluate(() => __vz.rooms.size)) === 1 && (await b.evaluate(() => __vz.rooms.size)) === 1, 10000)));
    await host.goto(URL0 + '#stat');
    ok('statistics screen shows counters', !!(await until(() => host.evaluate(() => document.querySelectorAll('.srow').length > 8 && /[1-9]/.test(document.querySelector('.srow:nth-child(2)').textContent)))));
  },
  async compress(browser) {
    const { host, guest, up } = await pair(browser);
    ok('session', !!up);
    await until(async () => (await st(host)).direct, 12000);
    // a big noisy photo
    const orig = await host.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 2400; c.height = 1800; const g = c.getContext('2d');
      const d = g.createImageData(2400, 1800); for (let i = 0; i < d.data.length; i += 4) { const v = (i / 4 % 2400) / 10 + Math.random() * 60; d.data[i] = v; d.data[i + 1] = 255 - v; d.data[i + 2] = Math.random() * 255; d.data[i + 3] = 255; }
      g.putImageData(d, 0, 0);
      const b = await new Promise(r => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer(); dt.items.add(new File([b], 'photo.png', { type: 'image/png' }));
      const inp = document.querySelector('.composer input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
      return b.size;
    });
    await host.waitForSelector('#c-sheet');
    ok('send sheet: original is preselected', await host.evaluate(() => document.querySelector('#c-0').classList.contains('sel')));
    await host.click('#c-2'); await host.click('#c-send');
    const img = await until(() => guest.evaluate(() => { const i = [...[...__vz.rooms.values()][0].xfer.inc.values()].find(x => x.name === 'photo.jpg' && x.state === 'done'); const el = document.querySelector('.msg:not(.me) img.media'); return i && el && el.naturalWidth ? { size: i.size, w: el.naturalWidth, type: i.blob.type } : null; }), 20000);
    ok('photo compressed (medium): smaller, 1600 px, shows on the other side', !!img && img.size < orig / 3 && img.w === 1600 && img.type === 'image/jpeg', img ? `${orig} → ${img.size} B` : '');
    // a short generated video
    const vorig = await host.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d');
      let n = 0; const iv = setInterval(() => { for (let k = 0; k < 400; k++) { g.fillStyle = `hsl(${Math.random() * 360},80%,50%)`; g.fillRect(Math.random() * 1280, Math.random() * 720, 60, 60); } g.fillStyle = '#fff'; g.fillText(String(n++), 20, 20); }, 33);
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 6000000 });
      const parts = []; rec.ondataavailable = e => parts.push(e.data);
      const done = new Promise(r => rec.onstop = r); rec.start(); await new Promise(r => setTimeout(r, 3500)); rec.stop(); await done; clearInterval(iv);
      const b = new Blob(parts, { type: 'video/webm' });
      const dt = new DataTransfer(); dt.items.add(new File([b], 'clip.webm', { type: 'video/webm' }));
      const inp = document.querySelector('.composer input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
      return b.size;
    });
    await host.waitForSelector('#c-sheet');
    await host.click('#c-3');
    ok('size slider shown for a single video', await host.evaluate(() => !document.querySelector('.cslider').hidden));
    await host.click('#c-send');
    const vid = await until(() => guest.evaluate(() => { const i = [...[...__vz.rooms.values()][0].xfer.inc.values()].find(x => /^clip\./.test(x.name) && x.state === 'done'); const el = document.querySelector('.msg:not(.me) video.media'); return i && el && el.videoWidth ? { size: i.size, w: el.videoWidth, h: el.videoHeight, name: i.name, dur: el.duration } : null; }), 60000, 500);
    ok('video compressed (strong): smaller, downscaled, plays on the other side', !!vid && vid.size < vorig * 0.5 && vid.h === 480, vid ? `${vorig} → ${vid.size} B, ${vid.w}×${vid.h}, ${vid.name}, ${vid.dur}s` : 'orig ' + vorig);
    // cancel sends nothing; non-media files skip the sheet
    const before = (await st(guest)).n;
    await host.evaluate(async () => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(400000)], 'x.jpg', { type: 'image/jpeg' })); const inp = document.querySelector('.composer input[type=file]'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); });
    await host.waitForSelector('#c-sheet');
    await host.getByRole('button', { name: 'Отмена' }).click();
    await host.waitForTimeout(600);
    ok('cancel sends nothing', (await st(guest)).n === before && await host.locator('#c-sheet').count() === 0);
  },
  async receipts(browser) {
    const { host, guest, up } = await pair(browser);
    ok('session', !!up);
    await guest.goto(URL0);   // guest is not looking at the chat
    await sendText(host, 'прочитай меня');
    const tickOf = () => host.evaluate(() => { const m = [...document.querySelectorAll('.msg.me')].pop(); return m && m.querySelector('.meta').textContent; });
    ok('delivered: one tick while unread', !!(await until(async () => { const x = await tickOf(); return x && x.includes('✓') && !x.includes('✓✓'); })));
    await guest.waitForTimeout(1200);
    ok('still one tick while the chat is closed', !(await tickOf()).includes('✓✓'));
    await guest.click('.room:not(.fav) >> nth=0');
    ok('read: two ticks once the chat is opened', !!(await until(async () => (await tickOf()).includes('✓✓'), 8000)));
    await sendText(host, 'а это сразу');
    ok('read at once while the chat is on screen', !!(await until(async () => { const x = await tickOf(); return x.includes('✓✓') && (await host.evaluate(() => [...document.querySelectorAll('.msg.me')].pop().textContent.includes('а это сразу'))); }, 8000)));
  },
  async relaycall(browser) {
    const { host, guest, up } = await pair(browser, { hostConf: { nop2p: true }, guestConf: { nop2p: true } });
    ok('session via relay only', !!up && !(await st(host)).direct);
    await host.click('button[title="Звонок"]');
    ok('guest rings (relay call)', !!(await until(async () => (await st(guest)).call === 'in', 8000)));
    ok('incoming screen says voice via relay', (await guest.textContent('.call')).includes('через ретранслятор'));
    await guest.click('#call-accept');
    ok('relay call active on both', !!(await until(async () => (await st(host)).call === 'on' && (await st(guest)).call === 'on', 10000)));
    const rs = p => p.evaluate(() => { const s = [...__vz.rooms.values()][0].relayStats; return s ? { ...s } : null; });
    const flowing = await until(async () => { const a = await rs(host), b = await rs(guest); return a && b && a.rx > 40 && b.rx > 40 ? { a, b } : null; }, 15000, 500);
    ok('voice packets flow both ways', !!flowing, flowing ? `host rx ${flowing.a.rx} (${flowing.a.codecIn}), guest rx ${flowing.b.rx} (${flowing.b.codecIn})` : '');
    ok('microphone is captured', !!(await until(async () => (await rs(host)).peak > 0.01 && (await rs(guest)).peak > 0.01, 6000)));
    ok('received voice is audible (not silence)', !!(await until(async () => (await rs(host)).rxPeak > 0.01 && (await rs(guest)).rxPeak > 0.01, 6000)), (await rs(host)).rxPeak.toFixed(3));
    await host.click('#call-mic');
    const tx0 = (await rs(host)).tx; await host.waitForTimeout(1200);
    ok('mute stops sending', (await rs(host)).tx - tx0 < 3);
    await host.click('#call-mic');
    await host.click('#call-end');
    ok('relay call ends on both', !!(await until(async () => (await st(guest)).call === 'idle' && (await st(host)).call === 'idle', 8000)));
    // video button without a direct link → voice call through the relay
    await guest.click('button[title="Видеозвонок"]');
    ok('video request falls back to a relay voice call', !!(await until(async () => (await st(host)).call === 'in', 8000)) && (await host.textContent('.call')).includes('через ретранслятор'));
    await host.click('#call-accept');
    ok('fallback call connects', !!(await until(async () => { const a = await rs(host); return a && a.rx > 20; }, 12000)));
    await guest.click('#call-end');
  },
  async adpcm(browser) {
    const { host, guest, up } = await pair(browser, { hostConf: { nop2p: true, codec: 'a' }, guestConf: { nop2p: true } });
    ok('session', !!up);
    await guest.click('button[title="Звонок"]');
    await until(async () => (await st(host)).call === 'in', 8000);
    await host.click('#call-accept');
    const rs = p => p.evaluate(() => { const s = [...__vz.rooms.values()][0].relayStats; return s ? { ...s } : null; });
    const r = await until(async () => { const a = await rs(host), b = await rs(guest); return a && b && a.rx > 30 && b.rx > 30 && a.rxPeak > 0.01 && b.rxPeak > 0.01 ? { a, b } : null; }, 15000, 500);
    ok('fallback codec (no Opus on one side) carries audible voice both ways', !!r, r ? `host in ${r.a.codecIn}/out ${r.a.codecOut}, guest in ${r.b.codecIn}/out ${r.b.codecOut}` : '');
    await host.click('#call-end');
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
      // second admin device by QR (no passphrase typed on it)
      const dev2 = await ctx(browser);
      await dev2.goto(URL0 + '#own');
      const aurl = await until(() => dev2.evaluate(() => document.querySelector('.qrbox')?.dataset.url));
      ok('new device shows admin QR', !!aurl && aurl.includes('#a='));
      await host.goto(aurl);
      await host.click('#grant-yes');
      ok('device became admin by QR', !!(await until(async () => await dev2.locator('#act-chat').count() === 1, 12000)));
      const link2 = await makeRoom(dev2);
      const g2 = await ctx(browser);
      await g2.goto(link2);
      ok('guest accepts a room hosted by the delegated admin', !!(await until(async () => (await st(g2))?.state === 'up', 15000)));
      await dev2.goto(URL0); await dev2.reload();
      ok('delegated admin remembered after reload', !!(await until(async () => await dev2.locator('#act-chat').count() === 1)));
      // introductions on a claimed site: a friend hosts the room, the other friend must accept it
      await host.goto(URL0 + '#adm');
      console.log('   host rooms:', JSON.stringify(await until(async () => { const x = await host.evaluate(() => [...__vz.rooms.values()].map(r => [r.rec.name, r.state, r.online, !!r.rec.pair])); return x.filter(y => y[1] === 'up').length >= 2 ? x : null; }, 15000)), await host.evaluate(() => [location.hash, __vz.isAdmin]));
      await host.waitForSelector('#intro-do');
      await host.click('#intro-do');
      const introUp = p => until(() => p.evaluate(() => { const r = [...__vz.rooms.values()].find(x => x.rec.intro); return r && r.state === 'up'; }), 20000);
      ok('introduced friends connect on a claimed site', !!(await introUp(dev)) && !!(await introUp(guest)));
      ok('friend still cannot create chats', await guest.evaluate(() => !__vz.isAdmin));
      // an impostor (does not have the owner key) creates a room: guests must refuse it
      const fake = await ctx(browser);
      await fake.route('**/owner.json', r => r.fulfill({ contentType: 'application/json', body: '{}' }));
      const flink = await makeRoom(fake);
      const victim = await ctx(browser);
      await victim.goto(flink);
      const rej = await until(async () => (await st(victim))?.reject, 10000);
      ok('room of a non-owner is refused', rej === 'sig', String(rej));
    } finally { srv.overrides['/owner.json'] = '{}'; }
  },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  require('./serve.cjs').overrides['/owner.json'] = '{}';   // tests run as an unclaimed site unless a test claims it
  const web = await serve(DIST, WEB);
  const env = { mq: await broker(MQ) };
  const browser = await chromium.launch({ proxy: process.env.REAL ? { server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost' } : undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  for (const [name, fn] of Object.entries(tests)) {
    if (only && name !== only) continue;
    console.log('▶ ' + name);
    const t0 = Date.now();
    try { await fn(browser, env); } catch (e) { console.log('  ✗ exception: ' + (e.stack || e).toString().split('\n').slice(0, 4).join(' | ')); failed++; }
    for (const c of browser.contexts()) await c.close();
    console.log('  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  }
  await browser.close(); await env.mq.close(); web.close();
  console.log(failed ? `\nFAILED: ${failed}` : '\nALL PASSED');
  process.exit(failed ? 1 : 0);
})();
