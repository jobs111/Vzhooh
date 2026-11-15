// Extra screens: QR from any link, call room, file share (owner side and guest side), lobby screen.
import { app } from './app';
import { RELAY_MAX, safeMime, startDownload } from './files';
import { t } from './i18n';
import { inviteUrl } from './invite';
import type { Lobby } from './lobby';
import { qrCanvas, qrFull, qrPng } from './qr';
import type { Room } from './room';
import type { Msg } from './store';
import { bar, copyText, dateShort, field, go, HOUR, mount, netBar, roomStatus, sel, toast } from './ui';
import { conf } from './store';
import { fmtSize, h, linkify, now } from './util';

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

// ---------- QR code from any link ----------
export function qrToolView() {
  const inp = h('textarea', { rows: 3, placeholder: 'https://vk.com/…', spellcheck: false, id: 'qr-input' }) as HTMLTextAreaElement;
  inp.value = conf.get('qrlast', '');
  const box = h('div.qrbox');
  const btns = h('div.row');
  let cur = '';
  const draw = () => {
    cur = inp.value.trim();
    conf.set('qrlast', cur);
    btns.hidden = !cur;
    if (!cur) { box.replaceChildren(h('p.hint', t('qrHint'))); return; }
    try { box.replaceChildren(qrCanvas(cur, Math.min(320, innerWidth - 48))); }
    catch { box.replaceChildren(h('p.err', t('qrTooLong'))); btns.hidden = true; }
  };
  let tm: any;
  inp.oninput = () => { clearTimeout(tm); tm = setTimeout(draw, 120); };
  btns.append(
    h('button.primary', { onclick: async () => { const b = await qrPng(cur); if (b) saveBlob(b, 'qr.png'); } }, '⬇ ' + t('qrPng')),
    h('button', { onclick: () => qrFull(cur) }, '⛶ ' + t('fullscreen')),
    h('button', { onclick: () => copyText(cur) }, t('copy')));
  mount(h('div.page', bar(t('qrTitle')), h('main.body', h('p.hint', t('qrHint')), inp, box, btns)));
  draw();
  if (!matchMedia('(pointer: coarse)').matches) inp.focus();
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
