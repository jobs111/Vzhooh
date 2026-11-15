// App shell: router, home screen, forms, settings.
import { app, VERSION } from './app';
import { chatView } from './chat';
import { ownerCreate, ownerUnlock } from './crypto';
import { diagView } from './diag';
import { lang, setLang, t } from './i18n';
import { decodeInvite, Invite, inviteUrl } from './invite';
import { qrCanvas } from './qr';
import type { Room } from './room';
import { beep, unlockAudio } from './sound';
import { conf } from './store';
import { callRoomView, lobbyView, qrToolView, shareCreateView } from './tools';
import { fmtClock, fmtSize, h, now } from './util';
import { DEFAULT_BROKERS } from './wire';

const root = document.getElementById('app')!;
let cleanup: (() => void)[] = [];
export function mount(el: HTMLElement, off: (() => void)[] = []) {
  for (const f of cleanup) { try { f(); } catch (e) { console.warn(e); } }
  cleanup = off;
  document.querySelectorAll('.qrfull, .lightbox, .mact').forEach(e => e.remove());
  root.replaceChildren(el);
}
let toastEl: HTMLElement | null = null;
export function toast(text: string, ms = 4000) {
  toastEl?.remove();
  const el = toastEl = h('div.toast', { role: 'status' }, text);
  document.body.append(el);
  setTimeout(() => { el.remove(); if (toastEl === el) toastEl = null; }, ms);
}
export function go(hash: string, replace = false) {
  if (replace) { history.replaceState(null, '', hash ? '#' + hash : location.pathname + location.search); void route(); }
  else if (location.hash.slice(1) === hash) void route(); else location.hash = hash;
}
export async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); toast(t('copied')); } catch { window.prompt(t('copy'), s); }
}
export const HOUR = 3600e3;
export const sel = (opts: [string | number, string][], val: string | number) =>
  h('select', opts.map(([v, label]) => h('option', { value: String(v), selected: String(v) === String(val) }, label))) as HTMLSelectElement;
export const field = (label: string, ...c: (Node | string)[]) => h('label.field', h('span', label), ...c);
export const bar = (title: string, back = '') => h('header.bar', h('button.ic', { onclick: () => go(back), 'aria-label': t('back') }, '←'), h('div.ttl', title));
export const dateShort = (ts: number) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Banner shown while the relay connections are down; reconnection itself is automatic. */
export function netBar(off: (() => void)[]): HTMLElement {
  const el = h('div.netbar', { hidden: true, role: 'status' });
  let shown = false;
  const upd = () => {
    const down = app.wire.down;
    el.hidden = !down;
    if (down && !shown) {
      el.replaceChildren(h('span.dot.wait'), h('span.grow', t(navigator.onLine ? 'netDown' : 'netOffline')),
        h('button', { onclick: () => { app.kick(); toast(t('reconnectNow') + '…', 1500); } }, t('reconnectNow')));
    }
    shown = down;
  };
  const iv = setInterval(upd, 1000);
  off.push(app.on('net', upd), () => clearInterval(iv));
  upd();
  return el;
}

export function roomTitle(r: Room) { return r.rec.name || (r.rec.pair ? t('device') : t('chatN')); }
export function roomStatus(r: Room): { text: string; cls: string } {
  if (r.reject) return { text: t('stOffline'), cls: 'off' };
  if (r.state === 'off') return { text: t('stPaused'), cls: 'off' };
  if (app.wire.down) return { text: t('stReconnect'), cls: 'wait' };
  if (r.state === 'wait') {
    if (!app.wire.upCount) return { text: t('stConnecting'), cls: 'wait' };
    const fresh = r.host ? !r.rec.bound : !r.rec.rk;
    return { text: fresh ? t('stWaiting') : t('stOffline'), cls: fresh ? 'wait' : 'off' };
  }
  if (!r.online) return { text: t('stOffline'), cls: 'off' };
  return r.direct ? { text: t('stDirect'), cls: 'on' } : { text: t('stRelay'), cls: 'relay' };
}

// ---------- router ----------
export async function route() {
  const m = /^([a-z]+)(?:=(.*))?$/.exec(location.hash.slice(1)) || [];
  const k = m[1] || '', v = m[2] || '';
  if (k !== 'r') app.active = '';
  if (k === 'j' && v) { history.replaceState(null, '', location.pathname + location.search); await joinBy(v); return; }
  if (k === 'p' && v) { history.replaceState(null, '', location.pathname + location.search); pairClaimView(v); return; }
  if (k === 'r') {
    const r = app.rooms.get(v);
    if (r && !r.rec.dead) { chatView(r); return; }
    const sh = sessionStorage.getItem('vz.sh.' + v);   // a file-download page was reloaded: join the share again
    if (sh) { sessionStorage.removeItem('vz.sh.' + v); await joinBy(sh); return; }
    go('', true); return;
  }
  if (k === 'l') { const l = app.lobbies.get(v); if (l) { lobbyView(l); return; } go('', true); return; }
  if (k === 'new') { newChatView(); return; }
  if (k === 'share') { shareCreateView(); return; }
  if (k === 'call') { callRoomView(); return; }
  if (k === 'qr') { qrToolView(); return; }
  if (k === 'set') { settingsView(); return; }
  if (k === 'diag') { diagView(); return; }
  if (k === 'own') { ownerView(); return; }
  const pending = sessionStorage.getItem('vz.inv');
  if (pending) { await joinBy(pending); return; }
  homeView();
}
async function joinBy(payload: string) {
  const inv = decodeInvite(payload);
  if (!inv) { sessionStorage.removeItem('vz.inv'); toast(t('badInvite')); homeView(); return; }
  if (inv.exp && now() > inv.exp * 1000) { sessionStorage.removeItem('vz.inv'); toast(t('inviteExpired')); homeView(); return; }
  sessionStorage.setItem('vz.inv', payload);
  const r = inv.lobby ? await app.joinLobby(inv) : await app.join(inv);
  if (inv.files) sessionStorage.setItem('vz.sh.' + r.rec.id, payload);
  const done = () => { if (r.state === 'up' || r.reject) { sessionStorage.removeItem('vz.inv'); off(); } };
  const off = r.on('state', done);
  done();
  go('r=' + r.rec.id, true);
}

// ---------- home ----------
function homeView() {
  const off: (() => void)[] = [];
  const list = h('div.rooms');
  const lobbies = h('div.rooms');
  const lobbyHead = h('h2', t('lobbies'));
  const net = h('span.dot');
  const pair = h('div');
  const draw = () => {
    net.className = 'dot ' + (app.wire.upCount ? 'on' : 'wait');
    const rooms = app.visibleRooms;
    list.replaceChildren(...(rooms.length ? rooms.map(r => {
      const st = roomStatus(r), last = [...r.msgs].reverse().find(x => !x.sys);
      return h('button.room', { onclick: () => go('r=' + r.rec.id) },
        h('span.dot.' + st.cls),
        h('div.grow', h('div.name', (r.rec.mode === 's' ? '🔒 ' : '') + (r.rec.call ? '📞 ' : '') + roomTitle(r)),
          h('div.sub', last ? (last.text || (last.file?.voice ? '🎤' : '📎 ' + (last.file?.name || ''))).slice(0, 60) : st.text)),
        r.rec.unread ? h('span.badge', String(r.rec.unread)) : null,
        last ? h('span.time', fmtClock(last.ts)) : null);
    }) : [h('div.empty', t('noChats'))]));
    const ls = app.isAdmin ? app.lobbyList : [];
    lobbyHead.hidden = !ls.length;
    lobbies.replaceChildren(...ls.map(l => {
      const r = l.rec, kids = l.children();
      const info = r.kind === 'files'
        ? `${r.files.length} · ${fmtSize(r.files.reduce((a, f) => a + f.size, 0))} · ${t('downloads', r.dl)}`
        : `${t('devices')}: ${kids.length}`;
      return h('button.room', { onclick: () => go('l=' + r.id) },
        h('span.lic', r.kind === 'files' ? '📁' : '👥'),
        h('div.grow', h('div.name', r.name || t(r.kind === 'files' ? 'lobbyFiles' : 'lobbyChat')),
          h('div.sub', info + (l.open ? (r.invExp ? ' · ' + t('until', dateShort(r.invExp)) : '') : ' · ' + t('lobbyClosed')))),
        kids.some(k => k.online) ? h('span.dot.on') : null);
    }));
  };
  off.push(app.on('rooms', draw), app.on('net', draw), app.on('lobbies', draw));
  const tick = setInterval(draw, 2000);
  off.push(() => clearInterval(tick));
  // a device that is not the owner shows a pairing QR
  if (!app.isAdmin) {
    const qr = h('div.qrbox');
    const start = async () => {
      const { inv } = await app.pairStart();
      const url = inviteUrl('p', inv);
      qr.dataset.url = url;
      qr.replaceChildren(qrCanvas(url));
    };
    void start();
    const refresh = setInterval(() => void start(), 10 * 60e3);
    off.push(() => { clearInterval(refresh); app.pairStop(); }, app.on('paired', (r: Room) => go('r=' + r.rec.id)));
    pair.append(h('section.card', h('h2', t('pairTitle')), h('p.hint', t('pairHint')), qr, h('p.hint.c', t('pairWait'))));
  }
  const act = (icon: string, label: string, hash: string, id: string) => h('button.act', { onclick: () => go(hash), id }, h('span.aic', icon), h('span', label));
  mount(h('div.page',
    h('header.bar', h('div.ttl.big', t('app'), ' ', net), h('button.ic', { onclick: () => go('diag'), title: t('diag') }, '🩺'),
      h('button.ic', { onclick: () => go('set'), title: t('settings') }, '⚙')),
    h('main.body',
      netBar(off),
      !app.owner ? h('p.note', t('unclaimed')) : null,
      app.isAdmin ? h('div.acts',
        act('💬', t('newChat'), 'new', 'act-chat'), act('📞', t('actCall'), 'call', 'act-call'),
        act('📁', t('actShare'), 'share', 'act-share'), act('▦', t('actQr'), 'qr', 'act-qr')) : null,
      lobbyHead, lobbies,
      h('h2', t('chats')), list, pair,
      app.owner && !app.ownerKey ? h('button.link', { onclick: () => go('own') }, t('ownerLogin')) : null,
      h('p.foot', t('tagline') + ' · v' + VERSION))), off);
  draw();
}

// ---------- new chat ----------
function newChatView() {
  if (!app.isAdmin) { go('own', true); return; }
  let secure = false, many = false;
  const name = h('input', { type: 'text', maxLength: 40, placeholder: t('chatN') }) as HTMLInputElement;
  const life = sel([[HOUR, t('h1')], [24 * HOUR, t('h24')], [48 * HOUR, t('h48')]], 48 * HOUR);
  const inv = sel([[10 * 60e3, t('m10')], [HOUR, t('h1')], [24 * HOUR, t('h24')], [7 * 24 * HOUR, t('d7')], [0, t('forever')]], HOUR);
  const modeHint = h('p.hint'), whoHint = h('p.hint');
  const lifeF = field(t('life'), life);
  const bF = h('button.seg', { onclick: () => { secure = false; upd(); } }, '⚡ ' + t('fast'));
  const bS = h('button.seg', { onclick: () => { secure = true; upd(); } }, '🔒 ' + t('secure'));
  const b1 = h('button.seg', { onclick: () => { many = false; upd(); } }, '👤 ' + t('whoOne'));
  const bN = h('button.seg', { onclick: () => { many = true; upd(); }, id: 'who-many' }, '👥 ' + t('whoMany'));
  const upd = () => {
    bF.classList.toggle('sel', !secure); bS.classList.toggle('sel', secure);
    b1.classList.toggle('sel', !many); bN.classList.toggle('sel', many);
    modeHint.textContent = t(secure ? 'secureHint' : 'fastHint');
    whoHint.textContent = t(many ? 'whoManyHint' : 'whoOneHint');
    lifeF.hidden = secure;
  };
  upd();
  const create = h('button.primary.wide', t('create')) as HTMLButtonElement;
  create.onclick = async () => {
    create.disabled = true;
    const o = { name: name.value.trim(), secure, life: +life.value, invTtl: +inv.value };
    if (many) { const l = await app.createLobby({ kind: 'chat', ...o }); go('l=' + l.rec.id, true); }
    else { const r = await app.createRoom(o); go('r=' + r.rec.id, true); }
  };
  mount(h('div.page', bar(t('newChat')), h('main.body',
    h('div.segs', bF, bS), modeHint,
    h('span.lbl', t('who')), h('div.segs', b1, bN), whoHint,
    field(t('roomName'), name), lifeF, field(t('invTtl'), inv), create)));
}

// ---------- pairing: owner accepts a device ----------
function pairClaimView(payload: string) {
  const inv: Invite | null = decodeInvite(payload);
  if (!inv) { toast(t('badInvite')); homeView(); return; }
  if (!app.isAdmin) { sessionStorage.setItem('vz.pair', payload); ownerView(); return; }
  const claim = async (secure: boolean) => {
    const r = await app.pairClaim(inv, secure, '', 48 * HOUR);
    go('r=' + r.rec.id, true);
  };
  mount(h('div.page', bar(t('pairClaim')), h('main.body',
    h('p.hint', t('pairClaimHint')),
    h('button.primary.wide', { onclick: () => claim(false) }, '⚡ ' + t('fast')), h('p.hint', t('fastHint')),
    h('button.wide', { onclick: () => claim(true) }, '🔒 ' + t('secure')), h('p.hint', t('secureHint')))));
}

// ---------- owner sign-in ----------
function ownerView() {
  if (!app.owner) { go('set', true); return; }
  const pass = h('input', { type: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
  const rem = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const btn = h('button.primary.wide', t('unlock')) as HTMLButtonElement;
  const submit = async () => {
    btn.disabled = true;
    const key = await ownerUnlock(app.owner!, pass.value).catch(() => null);
    btn.disabled = false;
    if (!key) { toast(t('badPass')); return; }
    await app.setOwnerKey(key, rem.checked);
    const p = sessionStorage.getItem('vz.pair');
    sessionStorage.removeItem('vz.pair');
    if (p) pairClaimView(p); else go('', true);
  };
  btn.onclick = submit;
  pass.onkeydown = e => { if (e.key === 'Enter') void submit(); };
  mount(h('div.page', bar(t('ownerLogin')), h('main.body',
    h('p.hint', t('needOwner')), field(t('pass'), pass), h('label.check', rem, h('span', t('remember'))), btn)));
  pass.focus();
}

// ---------- settings ----------
function settingsView() {
  const lng = sel([['ru', 'Русский'], ['en', 'English']], lang);
  lng.onchange = () => { setLang(lng.value as 'ru' | 'en'); settingsView(); };
  const low = h('input', { type: 'checkbox', checked: conf.get('low', false), onchange: () => conf.set('low', low.checked) }) as HTMLInputElement;
  const rr = h('input', { type: 'checkbox', checked: conf.get('rr', true), onchange: () => conf.set('rr', rr.checked) }) as HTMLInputElement;
  const nop = h('input', { type: 'checkbox', checked: app.noP2P, onchange: () => { app.noP2P = nop.checked; conf.set('nop2p', nop.checked); } }) as HTMLInputElement;
  const af = sel([['auto', t('auto')], ['on', t('on')], ['off', t('off')]], app.wire.antiFreeze);
  af.onchange = () => { app.wire.antiFreeze = af.value as any; conf.set('af', af.value); };
  const brokers = h('textarea', { rows: 4, placeholder: DEFAULT_BROKERS.join('\n'), spellcheck: false }) as HTMLTextAreaElement;
  brokers.value = conf.get<string[]>('brokers', []).join('\n');
  const ice = h('textarea', { rows: 4, placeholder: '[{"urls":"turn:example.org:3478","username":"u","credential":"p"}]', spellcheck: false }) as HTMLTextAreaElement;
  const curIce = app.customIce();
  ice.value = curIce ? JSON.stringify(curIce) : '';
  const saveNet = () => {
    const list = brokers.value.split('\n').map(x => x.trim()).filter(x => /^wss?:\/\/\S+$/.test(x));
    let iceV: unknown = null;
    if (ice.value.trim()) { try { iceV = JSON.parse(ice.value); if (!Array.isArray(iceV)) throw 0; } catch { toast(t('badJson')); return; } }
    conf.set('brokers', list); conf.set('ice', iceV);
    toast(t('saved'));
    setTimeout(() => location.reload(), 600);
  };
  // owner block
  const own = h('section.card');
  if (!app.owner) {
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
    const p2 = h('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
    const outBox = h('div');
    const b = h('button', { onclick: async () => {
      if (p1.value.length < 12) { toast(t('passShort')); return; }
      if (p1.value !== p2.value) { toast(t('passDiff')); return; }
      b.disabled = true;
      const f = JSON.stringify(await ownerCreate(p1.value));
      b.disabled = false;
      const ta = h('textarea.mono', { rows: 6, readOnly: true }) as HTMLTextAreaElement;
      ta.value = f;
      outBox.replaceChildren(h('p.hint', t('claimOut')), ta, h('button', { onclick: () => copyText(f) }, t('copy')));
    } }, t('claimDo')) as HTMLButtonElement;
    own.append(h('h2', t('claimTitle')), h('p.hint', t('claimHint')), field(t('pass'), p1), field(t('pass2'), p2), b, outBox);
  } else if (app.ownerKey) {
    own.append(h('h2', '👑 ' + t('ownerIn')), h('button', { onclick: async () => { await app.setOwnerKey(null, false); go('', true); } }, t('ownerOut')));
  } else own.append(h('button', { onclick: () => go('own') }, t('ownerLogin')));

  mount(h('div.page', bar(t('settings')), h('main.body',
    field(t('lang'), lng),
    h('label.check', low, h('span', t('lowData'))),
    h('label.check', rr, h('span', t('readRcpt'))),
    own,
    h('details', h('summary', '🛠 ' + t('diag') + ' / network'),
      field(t('antiFreeze'), af),
      h('label.check', nop, h('span', t('noP2P'))),
      field(t('brokers'), brokers), field(t('iceCfg'), ice),
      h('button', { onclick: saveNet }, t('save'))),
    h('button.danger', { onclick: async () => {
      if (!confirm(t('resetAsk'))) return;
      for (const r of [...app.rooms.values()]) { r.bye(true); app.removeRoom(r); }
      for (const l of [...app.lobbies.values()]) await app.removeLobby(l);
      try { localStorage.clear(); sessionStorage.clear(); indexedDB.deleteDatabase('vzhooh'); } catch { /* ignore */ }
      setTimeout(() => { location.hash = ''; location.reload(); }, 400);
    } }, t('resetAll')),
    h('p.foot', t('version') + ' ' + VERSION))));
}

export function initUi() {
  document.title = t('app');
  addEventListener('hashchange', () => void route());
  addEventListener('pointerdown', unlockAudio, { once: true });
  const title = () => {
    const n = app.visibleRooms.reduce((a, r) => a + r.rec.unread, 0);
    document.title = (n ? `(${n}) ` : '') + t('app');
  };
  app.on('rooms', title);
  app.on('notify', (r: Room, call: boolean) => {
    if (call) go('r=' + r.rec.id);
    else if (app.active !== r.rec.id || document.hidden) beep();
  });
}
