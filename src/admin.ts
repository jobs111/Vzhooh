// Owner tools: connections panel, statistics, giving admin rights to another device by QR.
import { app } from './app';
import { certData, deviceKeyGen, ownerSign, ownerVerify, sha256 } from './crypto';
import { t } from './i18n';
import { baseUrl } from './invite';
import { qrCanvas } from './qr';
import type { Room } from './room';
import { stats } from './stats';
import { bar, copyText, go, mount, netBar, roomStatus, roomTitle, sel, toast } from './ui';
import { b64, fmtDur, fmtSize, h, now, td, te, unb64 } from './util';

const CERT_LIFE = 90 * 24 * 3600e3;
const admTopic = async (pub: Uint8Array) => 'vz/adm/' + b64((await sha256(pub)).subarray(0, 12));

// ---------- connections ----------
export function adminView() {
  if (!app.isAdmin) { go('own', true); return; }
  const off: (() => void)[] = [];
  const body = h('div.stack');
  const row = (r: Room, extra: (Node | null)[] = []) => {
    const st = roomStatus(r);
    return h('div.arow', h('span.dot.' + st.cls), h('div.grow', h('div.name', roomTitle(r)), h('div.sub', st.text)), ...extra.filter(Boolean) as Node[]);
  };
  const btn = (label: string, fn: () => void, cls = '') => h('button.sm' + cls, { onclick: fn }, label);
  const draw = () => {
    const rooms = [...app.rooms.values()].filter(r => !r.local && !r.rec.dead && !r.rec.tmp);
    const online = rooms.filter(r => r.online).length;
    const chats = rooms.filter(r => !r.rec.grp && !r.rec.share);
    const hubs = [...app.rooms.values()].filter(r => r.rec.hub);
    const intros = app.intros;
    const pick = () => sel(chats.filter(r => r.state === 'up').map(r => [r.rec.id, roomTitle(r)] as [string, string]), '');
    const sa = pick(), sb = pick();
    if (sb.options.length > 1) sb.selectedIndex = 1;
    body.replaceChildren(
      h('div.kpis', h('div.kpi', h('b', String(rooms.length)), t('admTotal')), h('div.kpi', h('b', String(online)), t('admOnline')),
        h('div.kpi', h('b', String(rooms.filter(r => r.direct).length)), t('admDirect'))),
      h('p.hint', t('admHint')),
      h('h2', t('chats')),
      ...(chats.length ? chats.map(r => row(r, [
        r.state !== 'off' ? btn(t('admCut'), () => { if (r.rec.mode !== 's' || confirm(t('discAskS'))) r.disconnect(); }) : btn(t('connect'), () => r.start()),
        btn('🗑', () => { if (confirm(t('wipeAsk'))) void r.wipeAll(); }, '.danger')])) : [h('div.empty', '—')]),
      ...hubs.flatMap(hub => {
        const links = rooms.filter(r => r.rec.grp === hub.rec.hub && r.rec.bound);
        return [h('h2', '👥 ' + roomTitle(hub) + ' · ' + t('grpOn', hub.members.on, hub.members.all)),
          ...links.map(r => row(r, [btn(t('admKick'), () => { if (confirm(t('admKickAsk'))) void r.wipeAll(); }, '.danger')]))];
      }),
      ...(app.lobbyList.length ? [h('h2', t('lobbies'))] : []),
      ...app.lobbyList.map(l => h('button.arow', { onclick: () => go('l=' + l.rec.id) }, h('span.lic', l.rec.kind === 'files' ? '📁' : '🖥'),
        h('div.grow', h('div.name', l.rec.name || '—'), h('div.sub', t('nowOnline', l.children().filter(c => c.online).length))))),
      h('h2', t('introTitle')),
      h('p.hint', t('introHint')),
      chats.filter(r => r.state === 'up').length >= 2
        ? h('div.row', sa, h('span', '↔'), sb, h('button.primary', { id: 'intro-do', onclick: async () => {
          const a = app.rooms.get(sa.value), b = app.rooms.get(sb.value);
          if (!a || !b || a === b) { toast(t('introPick')); return; }
          await app.introduce(a, b);
          toast(t('introDone'));
        } }, t('introDo')))
        : h('div.empty', t('introNeed')),
      ...intros.map(i => h('div.arow', h('span.lic', '🤝'), h('div.grow', h('div.name', i.an + ' ↔ ' + i.bn), h('div.sub', t('until', new Date(i.exp).toLocaleString()))),
        btn(t('admCut'), () => app.endIntro(i.id), '.danger'))));
  };
  off.push(app.on('rooms', draw), app.on('net', draw));
  const iv = setInterval(() => { if (!body.contains(document.activeElement) || document.activeElement?.tagName !== 'SELECT') draw(); }, 3000);
  off.push(() => clearInterval(iv));
  mount(h('div.page', bar(t('admTitle')), h('main.body', netBar(off), body)), off);
  draw();
}

// ---------- statistics ----------
const LABELS: [string, string, (v: number) => string][] = [
  ['session', 'stSessions', String], ['peakOnline', 'stPeak', String],
  ['msgOut', 'stMsgOut', String], ['msgIn', 'stMsgIn', String], ['delivered', 'stDelivered', String],
  ['fileOut', 'stFileOut', String], ['fileOutBytes', 'stFileBytes', fmtSize], ['fileIn', 'stFileIn', String],
  ['callDirect', 'stCallDirect', fmtDur], ['callRelay', 'stCallRelay', fmtDur],
];
export function statsView() {
  if (!app.isAdmin) { go('own', true); return; }
  const table = h('div.stack');
  const draw = async () => {
    const [d1, d7, all] = await Promise.all([stats.sum(1), stats.sum(7), stats.sum(0)]);
    table.replaceChildren(h('div.srow.head', h('span.grow', ''), h('span', t('stToday')), h('span', t('st7')), h('span', t('stAll'))),
      ...LABELS.map(([k, label, f]) => h('div.srow', h('span.grow', t(label)), h('span', f(d1[k] || 0)), h('span', f(d7[k] || 0)), h('span', f(all[k] || 0)))));
  };
  void draw();
  mount(h('div.page', bar(t('stTitle')), h('main.body', h('p.hint', t('stHint')), table,
    h('div.row',
      h('button', { onclick: async () => copyText(JSON.stringify(await stats.all())) }, t('stExport')),
      h('button.danger', { onclick: async () => { if (confirm(t('stClearAsk'))) { await stats.clear(); void draw(); } } }, t('stClear'))))));
}

// ---------- admin rights for another device, by QR ----------
/** New device: show a QR, wait for an admin device to approve. Returns a cleanup function. */
export function adminQrBlock(onDone: () => void): { el: HTMLElement; stop: () => void } {
  const el = h('div.card', h('h2', t('aqTitle')), h('p.hint', t('aqHint')));
  let topic = '';
  void (async () => {
    const dev = await deviceKeyGen();
    topic = await admTopic(dev.pub);
    const url = baseUrl() + '#a=' + b64(dev.pub);
    const box = h('div.qrbox', qrCanvas(url));
    box.dataset.url = url;
    el.append(box, h('p.hint.c', t('aqWait')));
    app.wire.sub(topic, async p => {
      try {
        const o = JSON.parse(td.decode(p));
        const exp = +o.exp;
        if (!app.owner || !(exp > now()) || !(await ownerVerify(unb64(app.owner.pub), unb64(String(o.sig)), certData(dev.pub, exp)))) return;
        await app.setOwnerKey(dev.key, true, { pub: b64(dev.pub), sig: String(o.sig), exp });
        onDone();
      } catch { /* ignore */ }
    });
  })();
  return { el, stop: () => { if (topic) app.wire.unsub(topic); } };
}
/** Admin device: opened the other device's QR link. */
export function adminGrantView(payload: string) {
  let pub: Uint8Array;
  try { pub = unb64(payload); if (pub.length !== 65) throw 0; } catch { toast(t('badInvite')); go('', true); return; }
  if (!app.owner) { toast(t('aqNoOwner'), 6000); go('', true); return; }
  if (!app.ownerKey || app.cert) { sessionStorage.setItem('vz.grant', payload); toast(t('aqNeedPass'), 6000); go('own', true); return; }
  const yes = h('button.primary.wide', { id: 'grant-yes' }, t('aqGrant')) as HTMLButtonElement;
  yes.onclick = async () => {
    yes.disabled = true;
    const exp = now() + CERT_LIFE;
    const msg = te.encode(JSON.stringify({ sig: b64(await ownerSign(app.ownerKey!, certData(pub, exp))), exp }));
    const topic = await admTopic(pub);
    app.wire.pub(topic, msg);
    for (let i = 1; i < 5; i++) setTimeout(() => app.wire.pub(topic, msg), i * 700);   // repeats, in case the first one is lost
    toast(t('aqDone'));
    go('', true);
  };
  mount(h('div.page', bar(t('aqTitle')), h('main.body', h('p.note', t('aqAsk')), yes, h('button.wide', { onclick: () => go('', true) }, t('cancel')))));
}
