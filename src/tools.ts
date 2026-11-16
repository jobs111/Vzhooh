// Extra screens: QR from any link, call room, file share (owner side and guest side), lobby screen.
import { app } from './app';
import { RELAY_MAX, safeMime, startDownload } from './files';
import { t } from './i18n';
import { baseUrl, inviteUrl } from './invite';
import type { Lobby } from './lobby';
import { qrCanvas, qrFull, qrPng } from './qr';
import type { Room } from './room';
import type { Msg } from './store';
import { bar, copyText, dateShort, field, go, HOUR, mount, netBar, roomStatus, sel, toast } from './ui';
import { conf } from './store';
import { canZ, deflate, fmtSize, h, inflate, linkify, now } from './util';

/** QR + link block with copy / share / full-screen buttons. */
export function inviteBlock(url: string, id: string, caption = ''): HTMLElement {
  return h('div.invite',
    h('div.qrbox', qrCanvas(url)),
    h('input.mono', { readOnly: true, value: url, id, onclick: (e: Event) => (e.target as HTMLInputElement).select() }),
    h('div.row',
      h('button.primary', { onclick: () => copyText(url) }, t('copy')),
      navigator.share ? h('button', { onclick: () => void navigator.share({ url }).catch(() => {}) }, t('share')) : null,
      h('button', { onclick: () => qrFull(url, caption) }, '⛶ ' + t('fullscreen'))));
}
function saveBlob(blob: Blob, name: string) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name }) as HTMLAnchorElement;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ---------- QR codes from any text (works without the internet) ----------
// "Link" mode: the text travels inside the link (after '#', never sent to a server); scanning opens this app, which shows it.
// "Plain" mode: the QR code holds the text itself, any scanner shows it. Long texts become a numbered series of codes.
const PART = 700;        // characters per code: keeps every code easy to scan from a phone screen
const te8 = new TextEncoder(), td8 = new TextDecoder();
const b64u = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s: string) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
/** Text → list of QR contents. */
export async function textToCodes(text: string, mode: 'link' | 'plain'): Promise<string[]> {
  if (mode === 'plain') {
    const bytes = te8.encode(text);
    if (bytes.length <= 900) return [text];
    const out: string[] = [], chars = [...text];
    let cur = '', size = 0;
    for (const ch of chars) { const n = te8.encode(ch).length; if (size + n > 640) { out.push(cur); cur = ''; size = 0; } cur += ch; size += n; }
    if (cur) out.push(cur);
    return out.map((p, i) => `(${i + 1}/${out.length}) ${p}`);
  }
  const raw = te8.encode(text);
  let data = 'r' + b64u(raw);
  if (canZ) { const z = 'z' + b64u(await deflate(raw)); if (z.length < data.length) data = z; }
  const base = baseUrl() + '#t=';
  if (data.length <= PART + 150) return [base + data];
  const n = Math.ceil(data.length / PART), id = b64u(crypto.getRandomValues(new Uint8Array(3)));
  return Array.from({ length: n }, (_, i) => `${base}${id}.${i + 1}.${n}.${data.slice(i * PART, (i + 1) * PART)}`);
}
async function decodeText(data: string): Promise<string> {
  const u = unb64u(data.slice(1));
  return td8.decode(data[0] === 'z' ? await inflate(u) : u);
}

export function qrToolView() {
  const inp = h('textarea', { rows: 5, placeholder: t('qrPh'), spellcheck: false, id: 'qr-input' }) as HTMLTextAreaElement;
  inp.value = conf.get('qrlast', '');
  let mode: 'link' | 'plain' = conf.get('qrmode', 'link'), codes: string[] = [];
  const list = h('div.qrlist'), info = h('p.hint.c'), btns = h('div.row', { hidden: true });
  const bL = h('button.seg', { id: 'qr-link', onclick: () => { mode = 'link'; void draw(); } }, '🔗 ' + t('qrLink'));
  const bP = h('button.seg', { id: 'qr-plain', onclick: () => { mode = 'plain'; void draw(); } }, '📄 ' + t('qrPlain'));
  const modeHint = h('p.hint');
  let gen = 0;
  const draw = async () => {
    const my = ++gen, text = inp.value;
    conf.set('qrmode', mode);
    try { conf.set('qrlast', text.length < 50000 ? text : ''); } catch { /* ignore */ }
    bL.classList.toggle('sel', mode === 'link'); bP.classList.toggle('sel', mode === 'plain');
    modeHint.textContent = t(mode === 'link' ? 'qrLinkHint' : 'qrPlainHint');
    if (!text.trim()) { codes = []; list.replaceChildren(); info.textContent = ''; btns.hidden = true; return; }
    // a bare link always goes in as is, so that scanning opens it directly
    const cs = await textToCodes(text.trim(), /^\s*[a-z][\w+.-]*:\/\/\S+\s*$/i.test(text) ? 'plain' : mode);
    if (my !== gen) return;
    codes = cs;
    btns.hidden = false;
    info.textContent = t('qrInfo', [...text].length, codes.length);
    const px = Math.min(330, innerWidth - 48);
    list.replaceChildren(...codes.slice(0, 60).map((c, i) => h('div.qrcard', codes.length > 1 ? h('div.qrnum', `${i + 1} / ${codes.length}`) : null, qrCanvas(c, px, 'L'))));
    if (codes.length > 60) list.append(h('p.note', t('qrMany', codes.length)));
  };
  let tm: any;
  inp.oninput = () => { clearTimeout(tm); tm = setTimeout(() => void draw(), 200); };
  btns.append(
    h('button.primary', { id: 'qr-png', onclick: async () => {
      for (let i = 0; i < codes.length; i++) { const b = await qrPng(codes[i], 1400, 'L'); if (b) saveBlob(b, codes.length > 1 ? `qr-${i + 1}-of-${codes.length}.png` : 'qr.png'); await new Promise(r => setTimeout(r, 250)); }
    } }, '⬇ ' + t('qrPng')),
    h('button', { onclick: () => qrFull(codes, '', 'L') }, '⛶ ' + t('fullscreen')),
    h('button', { onclick: () => copyText(mode === 'link' && codes.length === 1 ? codes[0] : inp.value) }, t('copy')));
  mount(h('div.page', bar(t('qrTitle')), h('main.body', h('p.hint', t('qrHint')), inp, h('div.segs', bL, bP), modeHint, btns, info, list)));
  void draw();
  if (!matchMedia('(pointer: coarse)').matches) inp.focus();
}

/** Opened from a scanned text code: show the text (collecting the parts of a series first). */
export async function textView(payload: string) {
  const m = /^([\w-]{2,8})\.(\d+)\.(\d+)\.(.+)$/.exec(payload);
  let data = payload, missing: number[] = [], n = 1;
  if (m) {
    const key = 'tp.' + m[1];
    n = Math.min(+m[3], 2000);
    const st = conf.get<{ n: number; p: Record<string, string>; t: number }>(key, { n, p: {}, t: Date.now() });
    st.p[m[2]] = m[4]; st.n = n; st.t = Date.now();
    conf.set(key, st);
    for (let i = 1; i <= n; i++) if (!st.p[i]) missing.push(i);
    data = missing.length ? '' : Array.from({ length: n }, (_, i) => st.p[i + 1]).join('');
  }
  let text = '';
  if (data) { try { text = await decodeText(data); } catch { text = ''; missing = []; } }
  const body = h('main.body');
  if (missing.length) {
    body.append(h('p.note', { id: 'tv-wait' }, t('tvPart', n - missing.length, n) + ' ' + missing.slice(0, 40).join(', ')), h('p.hint', t('tvPartHint')));
  } else if (!text) body.append(h('p.err', t('tvBad')));
  else {
    const pre = h('div.tvtext', { id: 'tv-text' }, linkify(text));
    body.append(h('div.row',
      h('button.primary', { onclick: () => copyText(text) }, t('copy')),
      h('button', { id: 'tv-save', onclick: () => saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'text.txt') }, '⬇ .txt'),
      navigator.share ? h('button', { onclick: () => void navigator.share({ text }).catch(() => {}) }, t('share')) : null), pre);
  }
  mount(h('div.page', bar(t('tvTitle')), body));
}

// ---------- call room ----------
export function callRoomView() {
  if (!app.isAdmin) { go('own', true); return; }
  const enter = async (video: boolean, btn: HTMLButtonElement) => {
    btn.disabled = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video });
      s.getTracks().forEach(x => x.stop());
    } catch { btn.disabled = false; toast(t('mediaErr'), 8000); return; }
    const r = await app.createRoom({ name: t('actCall'), secure: false, life: 24 * HOUR, invTtl: 24 * HOUR, call: video ? 'v' : 'a' });
    go('r=' + r.rec.id, true);
  };
  const a = h('button.primary.wide', { id: 'call-audio' }, '📞 ' + t('callAudio')) as HTMLButtonElement;
  const v = h('button.wide', { id: 'call-video' }, '🎥 ' + t('callVideo')) as HTMLButtonElement;
  a.onclick = () => void enter(false, a);
  v.onclick = () => void enter(true, v);
  mount(h('div.page', bar(t('callTitle')), h('main.body', h('p.hint', t('callHint')), a, v)));
}

// ---------- create a file share ----------
export function shareCreateView() {
  if (!app.isAdmin) { go('own', true); return; }
  let picked: File[] = [];
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, id: 'share-files' }) as HTMLInputElement;
  const listEl = h('div.flist');
  const name = h('input', { type: 'text', maxLength: 60 }) as HTMLInputElement;
  const note = h('textarea', { rows: 2, maxLength: 2000 }) as HTMLTextAreaElement;
  const life = sel([[HOUR, t('h1')], [24 * HOUR, t('h24')], [48 * HOUR, t('h48')]], 48 * HOUR);
  const drawList = () => {
    listEl.replaceChildren(...picked.map((f, i) => h('div.fitem', h('span.grow', '📄 ' + f.name), h('span.fsize', fmtSize(f.size)),
      h('button.ic', { onclick: () => { picked.splice(i, 1); drawList(); }, 'aria-label': t('cancel') }, '✕'))));
    if (!name.value && picked[0]) name.placeholder = picked[0].name;
  };
  const add = (fs: Iterable<File>) => { picked.push(...fs); drawList(); };
  fileIn.onchange = () => { if (fileIn.files) add([...fileIn.files]); fileIn.value = ''; };
  const create = h('button.primary.wide', { id: 'share-create' }, t('shareDo')) as HTMLButtonElement;
  create.onclick = async () => {
    if (!picked.length) { toast(t('noFiles')); return; }
    create.disabled = true;
    const l = await app.createLobby({ kind: 'files', name: name.value.trim() || picked[0].name, secure: false, life: +life.value, invTtl: 0, files: picked, note: note.value.trim() });
    go('l=' + l.rec.id, true);
  };
  const body = h('main.body', h('p.hint', t('shareHint')), fileIn,
    h('button.wide', { onclick: () => fileIn.click() }, '📎 ' + t('pickFiles')), listEl,
    field(t('roomName'), name), field(t('note'), note), field(t('shareLife'), life), create);
  body.ondragover = e => e.preventDefault();
  body.ondrop = e => { e.preventDefault(); if (e.dataTransfer?.files.length) add([...e.dataTransfer.files]); };
  mount(h('div.page', bar(t('shareTitle')), body));
}

// ---------- lobby screen (owner): QR, devices, downloads ----------
export function lobbyView(l: Lobby) {
  const off: (() => void)[] = [];
  const r = l.rec, files = r.kind === 'files';
  const title = r.name || t(files ? 'lobbyFiles' : 'lobbyChat');
  const stats = h('div.stats'), kids = h('div.rooms'), fl = h('div.flist');
  const inv = h('div');
  let wasOpen: boolean | null = null;
  const draw = () => {
    const children = l.children(), online = children.filter(c => c.online).length;
    if (wasOpen !== l.open) {
      wasOpen = l.open;
      inv.replaceChildren(l.open ? inviteBlock(inviteUrl('j', app.lobbyInvite(l)), 'lobby-url', title) : h('p.err', t('lobbyClosed')));
    }
    stats.replaceChildren(h('div.row',
      files ? h('div', '⬇ ' + t('downloads', r.dl)) : null,
      h('div', '🟢 ' + t('nowOnline', online)),
      r.invExp ? h('div', '⏳ ' + t('until', dateShort(r.invExp))) : null));
    if (files) {
      fl.replaceChildren(...r.files.map(f => h('div.fitem', h('span.grow', '📄 ' + f.name), h('span.fsize', fmtSize(f.size)),
        !l.blobs.has(f.tid) ? h('span.warn', t('fileLost')) : f.mem ? h('span.warn', t('fileMem')) : null)));
    } else {
      kids.replaceChildren(...(children.length ? children.map(c => {
        const st = roomStatus(c);
        return h('button.room', { onclick: () => go('r=' + c.rec.id) }, h('span.dot.' + st.cls), h('div.grow', h('div.name', c.rec.name), h('div.sub', st.text)),
          c.rec.unread ? h('span.badge', String(c.rec.unread)) : null);
      }) : [h('div.empty', t('noDevices'))]));
    }
  };
  off.push(app.on('rooms', draw), app.on('lobbies', draw), app.on('net', draw));
  const iv = setInterval(draw, 2000);
  off.push(() => clearInterval(iv));
  mount(h('div.page', bar(title), h('main.body',
    netBar(off),
    h('p.hint', t(files ? 'lobbyHintFiles' : 'lobbyHintChat')),
    files ? h('p.note', t('keepOpen')) : null,
    inv, stats,
    files ? fl : h('h2', t('devices')), files ? null : kids,
    h('button.danger', { id: 'lobby-del', onclick: async () => { if (!confirm(t('lobbyDelAsk'))) return; await app.removeLobby(l); go('', true); } },
      '🗑 ' + t(files ? 'lobbyDel' : 'lobbyDelChat')))), off);
  draw();
}

// ---------- file share (guest side): download page ----------
export function shareGuestView(room: Room) {
  app.active = room.rec.id;
  const off: (() => void)[] = [];
  const dot = h('span.dot'), sub = h('div.sub'), name = h('span');
  const banner = h('div.note', { hidden: true });
  const notes = h('div.notes'), list = h('div.flist');
  const fileRow = (m: Msg): HTMLElement => {
    const f = m.file!, i = room.xfer.ensure(m);
    const row = h('div.fcard', h('div.fname', '📄 ' + f.name, h('span.fsize', ' · ' + fmtSize(f.size))));
    if (i.state === 'done') {
      const mime = safeMime(f.mime);
      if (i.url && mime.startsWith('image/')) row.append(h('img.media', { src: i.url, alt: '' }));
      else if (i.url && mime.startsWith('video/')) row.append(h('video.media', { src: i.url, controls: true, playsInline: true }));
      row.append(i.saved ? h('div.prog', '✓ ' + t('savedDisk')) : h('a.btn.primary', { href: i.url, download: f.name }, '⬇ ' + t('saveFile')));
    } else if (i.state === 'run') {
      const pct = f.size ? Math.round(i.got / f.size * 100) : 0;
      const sp = i.t0 && now() > i.t0 ? i.got / ((now() - i.t0) / 1000) : 0;
      row.append(h('div.pbar', h('i', { style: `width:${pct}%` })), h('div.prog', `${pct}% · ${fmtSize(sp)}/s`));
    } else if (i.state === 'gone' || i.state === 'err') row.append(h('div.prog.err', t(i.state === 'gone' ? 'fileGone' : 'fileErr')));
    else if (i.want) row.append(h('div.prog', f.size > RELAY_MAX && !room.direct ? t('waitDirect') : '…'));
    else row.append(h('button.btn.primary', { onclick: () => void startDownload(room, m) }, '⬇ ' + t('download') + ' · ' + fmtSize(f.size)),
      f.size > RELAY_MAX && !room.direct ? h('div.prog', t('needDirect')) : '');
    return row;
  };
  const draw = () => {
    const st = roomStatus(room);
    dot.className = 'dot ' + st.cls;
    sub.textContent = st.text;
    name.textContent = room.rec.name || t('shareFrom');
    banner.hidden = !(room.reject || room.state !== 'up');
    banner.textContent = room.reject ? t('rj_' + (['used', 'exp', 'rev', 'ver', 'sig', 'full'].includes(room.reject) ? room.reject : 'no')) : t('shareWait');
    notes.replaceChildren(...room.msgs.filter(m => !m.mine && m.text).map(m => h('p.txt', linkify(m.text!))));
    list.replaceChildren(...room.msgs.filter(m => !m.mine && m.file).map(fileRow));
  };
  off.push(room.on('msg', draw), room.on('file', draw), room.on('state', draw), app.on('net', draw), room.on('purge', draw));
  const iv = setInterval(draw, 3000);
  off.push(() => clearInterval(iv), () => { if (app.active === room.rec.id) app.active = ''; });
  mount(h('div.page',
    h('header.bar', h('button.ic', { onclick: () => go(''), 'aria-label': t('back') }, '←'), h('div.grow', h('div.ttl', dot, ' ', name), sub)),
    h('main.body', netBar(off), banner, notes, list)), off);
  draw();
}
