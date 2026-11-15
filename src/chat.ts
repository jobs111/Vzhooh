// Chat screen: messages, files, voice messages, call overlay, room menu.
import { app } from './app';
import { RELAY_MAX, safeMime, startDownload } from './files';
import { t } from './i18n';
import { inviteUrl } from './invite';
import type { Room } from './room';
import { ring } from './sound';
import type { Msg } from './store';
import { inviteBlock, shareGuestView } from './tools';
import { copyText, go, mount, netBar, roomStatus, roomTitle, toast } from './ui';
import { fmtClock, fmtDur, fmtSize, h, linkify, now } from './util';

function timerLabel(s: number) {
  return s === 0 ? t('off') : s === 30 ? t('s30') : s === 300 ? t('m5') : s === 600 ? t('m10') : s === 3600 ? t('h1') : s + ' s';
}
async function shrinkImage(f: Blob, max: number, q: number): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', q));
  } catch { return null; }
}
const canScreen = () => !!(navigator.mediaDevices as any)?.getDisplayMedia;

export function chatView(room: Room) {
  if (room.rec.share && !room.host) { shareGuestView(room); return; }
  app.active = room.rec.id;
  room.markRead();
  const off: (() => void)[] = [];
  const els = new Map<string, HTMLElement>();
  const list = h('div.msgs', { id: 'msgs' });
  const dot = h('span.dot'), sub = h('div.sub');
  const banner = h('div.banner');
  const menu = h('div.menu', { hidden: true });
  const panel = h('div.panel', { hidden: true });
  let showInvite = false;
  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  const toBottom = () => { list.scrollTop = list.scrollHeight; };

  // ----- messages -----
  const sysText = (m: Msg) => {
    if (m.sys === 'timer') return t('sys_timer', timerLabel(+(m.arg || 0)));
    if (m.sys === 'call_ended') return t('sys_call_ended', fmtDur(+(m.arg || 0)));
    return t('sys_' + m.sys);
  };
  const lightbox = (url: string) => {
    const box = h('div.lightbox', { onclick: () => box.remove() }, h('img', { src: url, alt: '' }));
    document.body.append(box);
  };
  const media = (mime0: string, url: string, voice?: boolean): HTMLElement | null => {
    const mime = safeMime(mime0);
    if (voice || mime.startsWith('audio/')) return h('audio', { src: url, controls: true, preload: 'metadata' });
    if (mime.startsWith('image/')) return h('img.media', { src: url, alt: '', onclick: () => lightbox(url) });
    if (mime.startsWith('video/')) return h('video.media', { src: url, controls: true, playsInline: true, preload: 'metadata' });
    return null;
  };
  const fileEl = (m: Msg): HTMLElement => {
    const f = m.file!, box = h('div.file');
    const head = f.voice ? null : h('div.fname', '📎 ', f.name, h('span.fsize', ' · ' + fmtSize(f.size)));
    if (m.mine) {
      const o = room.xfer.out.get(f.tid), url = room.xfer.outUrl(f.tid);
      const md = url ? media(f.mime, url, f.voice) : null;
      box.append(...[md, head].filter(Boolean) as Node[]);
      box.append(h('div.prog', { 'data-p': String(f.tid) }, o && o.sent > 0 && o.sent < f.size ? `${t('sending')} ${Math.round(o.sent / f.size * 100)}%` : ''));
      box.dataset.sig = 'out';
      return box;
    }
    const i = room.xfer.ensure(m);
    box.dataset.sig = i.state + (i.url ? 1 : 0) + (i.want ? 1 : 0);
    if (i.state === 'done') {
      const md = i.url ? media(f.mime, i.url, f.voice) : null;
      box.append(...[md, head].filter(Boolean) as Node[]);
      if (i.saved) box.append(h('div.prog', '✓ ' + t('savedDisk')));
      else if (i.url && !f.voice) box.append(h('a.btn', { href: i.url, download: f.name }, '⬇ ' + t('saveFile')));
      return box;
    }
    if (head) box.append(head); else box.append(h('div.fname', '🎤 ' + (f.dur ? fmtDur(f.dur / 1000) : '') + ' · ' + fmtSize(f.size)));
    if (i.state === 'gone') box.append(h('div.prog.err', t('fileGone')));
    else if (i.state === 'err') box.append(h('div.prog.err', t('fileErr')));
    else if (i.state === 'run') {
      const pct = f.size ? Math.round(i.got / f.size * 100) : 0;
      const sp = i.t0 && now() > i.t0 ? i.got / ((now() - i.t0) / 1000) : 0;
      box.append(h('div.pbar', h('i', { style: `width:${pct}%` })), h('div.prog', { 'data-p': String(f.tid) }, `${pct}% · ${fmtSize(sp)}/s`));
    } else {
      const need = f.size > RELAY_MAX && !room.direct;
      if (i.want) box.append(h('div.prog', need ? t('waitDirect') : '…'));
      else box.append(h('button.btn', { onclick: () => void startDownload(room, m) }, '⬇ ' + t('download') + ' · ' + fmtSize(f.size)), need ? h('div.prog', t('needDirect')) : '');
    }
    return box;
  };
  const render = (m: Msg): HTMLElement => {
    if (m.sys) return h('div.sys', sysText(m));
    const el = h('div.msg' + (m.mine ? '.me' : ''),
      m.text ? h('div.txt', linkify(m.text)) : null,
      m.file ? fileEl(m) : null,
      h('div.meta', m.del ? '⏱ ' : '', fmtClock(m.ts), m.mine ? (m.st === 2 ? h('span.tick.read', { title: t('read') }, ' ✓✓') : m.st ? h('span.tick', { title: t('delivered') }, ' ✓') : ' 🕓') : ''));
    el.dataset.id = m.id;
    return el;
  };
  const put = (m: Msg, scroll = false) => {
    const stick = scroll || nearBottom();
    const el = render(m), old = els.get(m.id);
    if (old) old.replaceWith(el); else list.append(el);
    els.set(m.id, el);
    if (stick) toBottom();
    if (m.file && !m.mine && room.rec.mode === 'f' && room.xfer.ensure(m).state === 'idle') {
      void room.loadBlob(m.file.tid).then(b => { if (b && els.get(m.id) === el) { room.xfer.restore(m, b); put(m); } });
    }
  };
  const redraw = () => { els.clear(); list.replaceChildren(); for (const m of room.msgs) put(m); toBottom(); };
  const onFile = (tid: number) => {
    const m = room.msgs.find(x => x.file?.tid === tid);
    const el = m && els.get(m.id);
    if (!m || !el) return;
    const box = el.querySelector<HTMLElement>('.file');
    let sig: string;
    if (m.mine) sig = 'out'; else { const i = room.xfer.ensure(m); sig = i.state + (i.url ? 1 : 0) + (i.want ? 1 : 0); }
    if (!box || box.dataset.sig !== sig) { put(m); return; }
    const p = box.querySelector<HTMLElement>('[data-p]');
    if (m.mine) {
      const o = room.xfer.out.get(tid);
      if (p && o) p.textContent = o.sent > 0 && o.sent < m.file!.size ? `${t('sending')} ${Math.round(o.sent / m.file!.size * 100)}%` : '';
    } else {
      const i = room.xfer.ensure(m), pct = i.size ? Math.round(i.got / i.size * 100) : 0;
      const sp = i.t0 && now() > i.t0 ? i.got / ((now() - i.t0) / 1000) : 0;
      if (p) p.textContent = `${pct}% · ${fmtSize(sp)}/s`;
      const barI = box.querySelector<HTMLElement>('.pbar i');
      if (barI) barI.style.width = pct + '%';
    }
  };

  // ----- tap on a message: copy / delete -----
  const closeAct = () => document.querySelectorAll('.mact').forEach(e => e.remove());
  list.addEventListener('click', e => {
    menu.hidden = true;
    const tgt = e.target as HTMLElement;
    if (tgt.closest('a, button, audio, video, img, input, select, textarea')) return;
    const el = tgt.closest<HTMLElement>('.msg');
    closeAct();
    if (!el || getSelection()?.toString()) return;
    const m = room.msgs.find(x => x.id === el.dataset.id);
    if (!m) return;
    const act = (label: string, fn: () => void, cls = '') => h('button' + cls, { onclick: (ev: Event) => { ev.stopPropagation(); closeAct(); fn(); } }, label);
    const pop = h('div.mact', { role: 'menu' },
      m.text ? act('📋 ' + t('mCopy'), () => void copyText(m.text!)) : null,
      m.mine ? act('🗑 ' + t('mDelAll'), () => room.deleteMsg(m.id, true), '.danger') : null,
      act('✕ ' + t('mDelMe'), () => room.deleteMsg(m.id, false)));
    document.body.append(pop);
    const r = el.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, m.mine ? r.right - pw : r.left)) + 'px';
    pop.style.top = Math.max(8, Math.min(innerHeight - ph - 8, r.bottom + 4)) + 'px';
  });
  list.addEventListener('scroll', closeAct, { passive: true });
  off.push(closeAct);

  // ----- header / state -----
  const callA = h('button.ic', { title: t('audioCall'), onclick: () => void startCall(false) }, '📞') as HTMLButtonElement;
  const callV = h('button.ic', { title: t('videoCall'), onclick: () => void startCall(true) }, '🎥') as HTMLButtonElement;
  const drawInvite = () => {
    const r = room.rec;
    const can = room.host && !r.pair && !r.lid && (!r.bound || r.reusable) && (!r.invExp || now() < r.invExp);
    const want = can && (showInvite || (!r.bound && room.state !== 'up'));
    if (!want) { panel.hidden = true; panel.replaceChildren(); return; }
    if (!panel.hidden && panel.childElementCount) return;
    const url = inviteUrl('j', app.invite(room));
    panel.hidden = false;
    panel.replaceChildren(...[
      h('h2', r.call ? t('callTitle') : t('inviteTitle')),
      r.call ? h('p.note', t('callWait')) : null,
      h('p.hint', t(r.reusable ? 'inviteHintN' : 'inviteHint1') + (r.invExp ? ' ' + t('inviteUntil', new Date(r.invExp).toLocaleString()) : '')),
      inviteBlock(url, 'invite-url', roomTitle(room)),
      r.bound ? h('button', { onclick: () => { showInvite = false; drawInvite(); } }, t('close')) : null].filter(Boolean) as Node[]);
  };
  const drawState = () => {
    const st = roomStatus(room);
    dot.className = 'dot ' + st.cls;
    sub.textContent = st.text + (room.rec.mode === 's' ? ' · 🔒' : '') + (room.rec.exp ? ' · ' + t('until', new Date(room.rec.exp).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '');
    callA.disabled = callV.disabled = room.state !== 'up' || !room.online;
    banner.replaceChildren();
    if (room.reject) banner.append(h('p.err', t('rj_' + (['used', 'exp', 'rev', 'ver', 'sig', 'full'].includes(room.reject) ? room.reject : 'no'))));
    else if (room.state === 'off') banner.append(h('button.primary', { onclick: () => room.start() }, t('connect')));
    else if (room.host && app.owner && !app.ownerKey) banner.append(h('p.err', t('needOwner')), h('button', { onclick: () => go('own') }, t('ownerLogin')));
    else if (room.host && !room.rec.bound && room.rec.invExp && now() > room.rec.invExp) {
      banner.append(h('p.err', t('inviteExpired')), h('button', { onclick: () => { room.rec.invExp = now() + 3600e3; room.save(); drawState(); } }, t('extend')));
    } else if (!room.host && room.rec.call && room.state === 'up' && room.call.st === 'idle' && !room.rec.called) banner.append(h('p.hint', t('callGuestWait')));
    banner.hidden = !banner.childElementCount;
    drawInvite();
    autoCall();
  };

  // ----- call room: the owner's side calls by itself as soon as the peer is here -----
  // (waits a few seconds for a direct link; without one the call goes by voice through the relay)
  let upAt = 0;
  function autoCall() {
    const r = room.rec;
    if (!r.call || room.state !== 'up' || !room.online) { upAt = 0; return; }
    if (!room.host || r.called || room.call.st !== 'idle') return;
    upAt ||= now();
    if (room.canDirectCall || now() - upAt > 6000 || app.noP2P) { r.called = true; room.save(); void startCall(r.call === 'v'); }
  }

  // ----- menu -----
  const item = (label: string, fn: () => void, cls = '') => h('button' + cls, { onclick: () => { menu.hidden = true; fn(); } }, label);
  const drawMenu = () => {
    const r = room.rec;
    menu.replaceChildren(...([
      room.host && !r.pair && !r.lid && (!r.bound || r.reusable) ? item('🔗 ' + t('showInvite'), () => { showInvite = true; panel.replaceChildren(); drawInvite(); }) : null,
      room.sas ? item('🛡 ' + t('sasTitle'), () => alert(t('sasTitle') + ':\n\n' + room.sas + '\n\n' + t('sasHint'))) : null,
      r.mode === 's' ? h('label.mi', '⏱ ' + t('timer') + ' ', (() => {
        const s = h('select', [0, 30, 300, 600, 3600].map(v => h('option', { value: String(v), selected: v === r.timer }, timerLabel(v)))) as HTMLSelectElement;
        s.onchange = () => { room.setTimer(+s.value); menu.hidden = true; };
        return s;
      })()) : null,
      room.state === 'up' && !room.direct ? item('⚡ ' + t('retry'), () => room.retryDirect()) : null,
      room.state !== 'off' ? item('⏏ ' + t('disconnect'), () => { if (r.mode !== 's' || confirm(t('discAskS'))) room.disconnect(); }) : null,
      item('🗑 ' + t('wipe'), () => { if (confirm(t('wipeAsk'))) void room.wipeAll(); }, '.danger')].filter(Boolean) as Node[]));
  };

  // ----- composer -----
  const input = h('textarea', { rows: 1, placeholder: t('message'), 'aria-label': t('message') }) as HTMLTextAreaElement;
  const sendBtn = h('button.ic.send', { title: t('send') }, '➤') as HTMLButtonElement;
  const micBtn = h('button.ic', { title: t('voice') }, '🎤') as HTMLButtonElement;
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true }) as HTMLInputElement;
  const recBar = h('div.rec', { hidden: true });
  const coarse = matchMedia('(pointer: coarse)').matches;
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; sendBtn.hidden = !input.value.trim(); micBtn.hidden = !sendBtn.hidden; };
  const sendText = () => { const v = input.value; if (!v.trim()) return; room.sendText(v); input.value = ''; grow(); input.focus(); };
  input.oninput = grow;
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); sendText(); } };
  sendBtn.onclick = sendText;
  const sendFiles = async (files: Iterable<File>) => {
    let warned = false;
    for (const f of files) {
      let blob: Blob = f, name = f.name || 'file';
      if (!room.direct && f.type.startsWith('image/') && f.size > 350 * 1024) {
        const small = await shrinkImage(f, 1280, 0.72);
        const smaller = small && small.size > RELAY_MAX ? await shrinkImage(f, 960, 0.6) : small;
        if (smaller && smaller.size < f.size) { blob = smaller; name = name.replace(/\.[^.]+$/, '') + '.jpg'; }
      }
      if (!room.direct && blob.size > RELAY_MAX && !warned) { warned = true; toast(t('relayOnlySmall'), 6000); }
      room.sendFile(blob, name);
    }
  };
  fileIn.onchange = () => { if (fileIn.files) void sendFiles([...fileIn.files]); fileIn.value = ''; };
  input.onpaste = e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); void sendFiles(fs); } };
  list.ondragover = e => e.preventDefault();
  list.ondrop = e => { e.preventDefault(); if (e.dataTransfer?.files.length) void sendFiles([...e.dataTransfer.files]); };

  // ----- voice recorder -----
  let rec: MediaRecorder | null = null, recStream: MediaStream | null = null, recT0 = 0, recTick: any, recSend = false;
  const stopRec = (send: boolean) => { recSend = send; try { rec?.stop(); } catch { /* ignore */ } };
  micBtn.onclick = async () => {
    if (rec) return;
    try {
      recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch { toast(t('recErr')); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(x => MediaRecorder.isTypeSupported(x)) || '';
    const chunks: Blob[] = [];
    rec = new MediaRecorder(recStream, { mimeType: mime || undefined, audioBitsPerSecond: room.direct ? 64000 : 24000 });
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const dur = now() - recT0, type = (rec?.mimeType || mime || 'audio/webm').split(';')[0];
      recStream?.getTracks().forEach(x => x.stop());
      clearInterval(recTick);
      rec = null; recStream = null;
      recBar.hidden = true;
      if (recSend && chunks.length && dur > 400) {
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        room.sendFile(new Blob(chunks, { type }), `voice-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`, { voice: true, dur });
      }
    };
    recT0 = now();
    const time = h('span.rtime', '0:00');
    recBar.replaceChildren(h('span.rdot'), time, h('span.grow'),
      h('button.ic', { onclick: () => stopRec(false), title: t('cancel') }, '✕'),
      h('button.ic.send', { onclick: () => stopRec(true), title: t('send'), id: 'rec-send' }, '➤'));
    recBar.hidden = false;
    recTick = setInterval(() => { time.textContent = fmtDur((now() - recT0) / 1000); if (now() - recT0 > 10 * 60e3) stopRec(true); }, 300);
    rec.start(1000);
  };
  off.push(() => stopRec(false));

  // ----- calls -----
  const callBox = h('div.call', { hidden: true });
  const remoteV = h('video.remote', { autoplay: true, playsInline: true }) as HTMLVideoElement;
  const localV = h('video.local', { autoplay: true, playsInline: true, muted: true }) as HTMLVideoElement;
  const callInfo = h('div.cinfo'), callBtns = h('div.cbtns');
  callBox.append(remoteV, localV, callInfo, callBtns);
  let callTick: any, wake: any;
  async function startCall(video: boolean) {
    if (!room.canDirectCall) { room.retryDirect(); if (video) toast(t('videoRelay'), 6000); }
    try { await room.callStart(video); }
    catch { toast(t('mediaErr'), 8000); }
  }
  const accept = async (video: boolean) => { try { await room.callAccept(video); } catch { toast(t('mediaErr'), 8000); } };
  const screen = async () => {
    try { await room.toggleScreen(); }
    catch (e: any) { if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') toast(t('noScreen'), 6000); }
  };
  const cb = (label: string, fn: () => void, cls = '', id = '', title = '') => h('button.cb' + cls, { onclick: fn, id: id || undefined, title: title || undefined }, label);
  const drawCall = () => {
    const c = room.call, rtc = room.rtc;
    clearInterval(callTick);
    ring(c.st === 'in' ? 'in' : c.st === 'out' ? 'out' : null);
    if (c.st === 'idle') {
      callBox.hidden = true; remoteV.srcObject = null; localV.srcObject = null;
      try { wake?.release(); } catch { /* ignore */ } wake = null;
      drawState();
      return;
    }
    callBox.hidden = false;
    const title = roomTitle(room);
    if (c.st === 'in') {
      callInfo.replaceChildren(...[h('div.cname', title), h('div', t(c.video ? 'incomingV' : 'incoming')), c.relay ? h('div.cvia', t('callRelay')) : null].filter(Boolean) as Node[]);
      callBtns.replaceChildren(...[cb('📞 ' + t('accept'), () => void accept(false), '.ok', 'call-accept'),
        c.video ? cb('🎥 ' + t('acceptV'), () => void accept(true), '.ok', 'call-accept-video') : null,
        cb('✕ ' + t('decline'), () => room.callDecline(), '.bad')].filter(Boolean) as Node[]);
      return;
    }
    if (rtc?.local && localV.srcObject !== rtc.local) localV.srcObject = rtc.local;
    localV.hidden = !(c.cam || c.scr);
    localV.classList.toggle('scr', c.scr);
    const via = c.relay ? h('div.cvia', t('callRelay')) : null;
    if (c.st === 'out') {
      callInfo.replaceChildren(...[h('div.cname', title), h('div', t('calling')), via].filter(Boolean) as Node[]);
      callBtns.replaceChildren(cb('✕ ' + t('hangup'), () => room.callEnd(), '.bad', 'call-end'));
      return;
    }
    if (rtc) { const s = rtc.remote(); const cur = remoteV.srcObject as MediaStream | null; if (!cur || cur.getTracks().length !== s.getTracks().length) { remoteV.srcObject = s; void remoteV.play().catch(() => {}); } }
    remoteV.classList.toggle('novideo', !c.rvi);
    const time = h('div.ctime');
    const upd = () => { time.textContent = fmtDur((now() - c.t0) / 1000) + (rtc && rtc.pc.connectionState !== 'connected' ? ' · ' + t('reconnecting') : '') + (c.rau ? '' : ' · 🔇'); };
    upd(); callTick = setInterval(upd, 1000);
    callInfo.replaceChildren(...[h('div.cname', title), time, via].filter(Boolean) as Node[]);
    callBtns.replaceChildren(...[
      cb(c.mic ? '🎙' : '🔇', () => room.toggleMic(), c.mic ? '' : '.offb', 'call-mic', t('voice')),
      c.scr || c.relay ? null : cb(c.cam ? '📷' : '🚫📷', () => void room.toggleCam().catch(() => toast(t('mediaErr'))), c.cam ? '' : '.offb', 'call-cam', t('videoCall')),
      c.cam && !c.scr ? cb('🔄', () => void room.switchCam().catch(() => {})) : null,
      canScreen() && !c.relay ? cb('🖥', () => void screen(), c.scr ? '.onb' : '', 'call-screen', t('screen')) : null,
      cb('✕ ' + t('hangup'), () => room.callEnd(), '.bad', 'call-end')].filter(Boolean) as Node[]);
    if (!wake && (navigator as any).wakeLock) (navigator as any).wakeLock.request('screen').then((w: any) => { wake = w; }).catch(() => {});
  };
  off.push(() => { ring(null); clearInterval(callTick); try { wake?.release(); } catch { /* ignore */ } });

  // ----- wiring -----
  off.push(
    room.on('msg', (m: Msg) => { put(m, m.mine); if (!m.mine && !document.hidden) room.markRead(); }),
    room.on('purge', redraw),
    room.on('file', onFile),
    room.on('state', drawState),
    room.on('call', drawCall),
    room.on('media', drawCall),
    room.on('closed', (why: string) => { if (why !== 'self') toast(t('cl_' + why), 6000); go('', true); }),
    app.on('net', drawState));
  const vis = () => { if (!document.hidden) room.markRead(); };
  document.addEventListener('visibilitychange', vis);
  const tick = setInterval(drawState, 2000);
  off.push(() => { document.removeEventListener('visibilitychange', vis); clearInterval(tick); if (app.active === room.rec.id) app.active = ''; });

  mount(h('div.page.chat',
    h('header.bar',
      h('button.ic', { onclick: () => go(''), 'aria-label': t('back') }, '←'),
      h('div.grow', h('div.ttl', dot, ' ', roomTitle(room)), sub),
      callA, callV,
      h('button.ic', { id: 'menu-btn', onclick: () => { drawMenu(); menu.hidden = !menu.hidden; } }, '⋮')),
    menu, netBar(off), banner, panel, list, recBar,
    h('footer.composer', fileIn, h('button.ic', { title: t('attach'), onclick: () => fileIn.click() }, '📎'), input, micBtn, sendBtn),
    callBox), off);
  redraw(); drawState(); drawCall(); grow();
  if (!coarse) input.focus();
}
