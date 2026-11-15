// A room = one 1:1 chat. Handles the encrypted handshake, the link (direct or relay),
// reliable delivery, presence, chat messages and call state.
import { app } from './app';
import { aesKey, ecdh, ecdhGen, hkdf, hmac, KeyPair, ownerSign, ownerVerify, sasEmoji, seal, unseal } from './crypto';
import { Xfer } from './files';
import { Rtc } from './rtc';
import { db, FileMeta, Msg, RoomRec } from './store';
import { b64, canZ, concat, deflate, Emitter, eq, inflate, now, rnd, td, te, U8, unb64 } from './util';

export const PROTO = 1;
const PERSIST_MAX = 16 * 1024 * 1024;
type Op = Record<string, any>;
const J = (o: Op) => concat([0], te.encode(JSON.stringify(o)));

export interface CallState { st: 'idle' | 'out' | 'in' | 'on'; video: boolean; at: number; t0: number; rau: boolean; rvi: boolean; mic: boolean; cam: boolean }
const idleCall = (): CallState => ({ st: 'idle', video: false, at: 0, t0: 0, rau: true, rvi: false, mic: true, cam: false });

export class Room extends Emitter {
  msgs: Msg[] = [];
  state: 'off' | 'wait' | 'up' = 'off';
  reject = '';
  sas = '';
  online = false;
  lastRx = 0;
  rtc?: Rtc;
  xfer = new Xfer(this);
  call = idleCall();
  gone = false;

  private secret: U8;
  private kWire!: CryptoKey;
  private kSess?: CryptoKey;
  private ready: Promise<void>;
  private q: Promise<void> = Promise.resolve();
  private seenF = new Set<string>();
  private seenOp = new Set<string>();
  private out = new Map<string, { op: Op; tries: number; timer: any; at: number; key?: string; done?: (ok: boolean) => void }>();
  private seq = 0;
  private ackQ: string[] = [];
  private ackT: any;
  private peerZ = false;
  private lastPing = 0;
  private lastGood = 0;
  private reAt = 0;
  // guest handshake
  private hs?: { kp: KeyPair; n: U8; tries: number; done?: boolean };
  private hsAt = 0;
  private hsTimer: any;
  private okTimer: any;
  private confirmed = false;
  private gotCfg = false;
  private cfgIce?: RTCIceServer[];
  // host handshake
  private pend?: { k: CryptoKey; kraw: U8; g: string; gn: string; resume: boolean; wl: U8; z: boolean };
  private curGn = '';
  // rtc
  private rtcGen = 0;
  private rtcTries = 0;
  private rtcAt = 0;
  private rtcT: any;
  private riAt = 0;
  private nudgeT: any;

  constructor(public rec: RoomRec) {
    super();
    const secret = this.secret = unb64(rec.secret);
    this.ready = (async () => { this.kWire = await aesKey(await hkdf(secret, null, 'vz1/wire', 32)); })();
  }
  get host() { return this.rec.role === 'h'; }
  get direct() { return !!this.rtc?.dcReady; }
  get wireBuffered() { return app.wire.buffered; }
  private get inTopic() { return `vz/${this.rec.id}/${this.host ? 'h' : 'g'}`; }
  private get outTopic() { return `vz/${this.rec.id}/${this.host ? 'g' : 'h'}`; }
  private enqueue(fn: () => Promise<void> | void) {
    this.q = this.q.then(fn).catch(e => console.warn('room', e));
  }

  // ---------- lifecycle ----------
  async load() {
    if (this.rec.mode !== 'f') return;
    const rows = await db.byRoom<{ m: Msg }>('msgs', this.rec.id);
    if (rows) this.msgs = rows.map(r => r.m).sort((a, b) => a.ts - b.ts);
  }
  save() {
    if (this.rec.mode === 'f' && !this.rec.tmp && !this.gone) void db.put('rooms', this.rec);
  }
  start() {
    if (this.state !== 'off' || this.gone) return;
    this.state = 'wait'; this.reject = '';
    if (this.rec.paused) { this.rec.paused = false; this.save(); }
    this.enqueue(async () => {
      await this.ready;
      if (this.state === 'off') return;
      app.wire.sub(this.inTopic, p => this.onFrame(p));
      if (this.host) this.nudge(0); else await this.hsStart();
    });
    this.emit('state');
  }
  /** Stop all activity for this room (keeps local data). */
  stop() {
    this.teardown();
    clearTimeout(this.hsTimer); clearTimeout(this.okTimer); clearTimeout(this.nudgeT);
    this.kSess = undefined; this.pend = undefined; this.hs = undefined;
    app.wire.unsub(this.inTopic);
    this.state = 'off';
    this.setOnline(false);
  }
  private teardown() {
    clearTimeout(this.rtcT);
    if (this.call.st !== 'idle') this.callCleanup('lost');
    this.rtc?.close(); this.rtc = undefined;
    for (const e of this.out.values()) { clearTimeout(e.timer); e.done?.(false); }
    this.out.clear();
    clearTimeout(this.ackT); this.ackQ = [];
  }
  private fail(code: string) {
    this.reject = code;
    this.stop();
    this.emit('state');
  }
  /** Tell the peer we are leaving. x=1 means "session is over for good". */
  bye(final = false) {
    if (!this.kSess) return;
    const s = JSON.stringify(final ? { t: 'by', x: 1 } : { t: 'by' });
    this.rtc?.dcSend(s);
    void this.sendWireJson(s);
  }
  /** "Disconnect" button. Secure rooms are destroyed, fast rooms are paused. */
  disconnect() {
    this.bye(true);
    if (this.rec.mode === 's') { this.closeLocal('self'); return; }
    this.stop();
    this.rec.paused = true;
    this.save();
    this.emit('state');
  }
  private closeLocal(why: string) {
    void this.wipeLocal();
    this.stop();
    app.removeRoom(this);
    this.emit('closed', why);
  }
  expire() { void this.wipeLocal(); this.stop(); app.removeRoom(this); this.emit('closed', 'expired'); }

  // ---------- wire framing ----------
  async sendWire(stage: 0 | 1, pt: U8, bulk = false): Promise<number> {
    const key = stage ? this.kSess : this.kWire;
    if (!key) return 0;
    const f = concat([stage], await seal(key, pt, new Uint8Array([stage, this.host ? 0 : 1])));
    return app.wire.pub(this.outTopic, f, bulk);
  }
  private async sendWireJson(s: string) {
    const raw = te.encode(s);
    await this.sendWire(1, this.peerZ && raw.length > 360 ? concat([2], await deflate(raw)) : concat([0], raw));
  }
  private onFrame(p: U8) {
    if (p.length < 30) return;
    const k = b64(p.subarray(0, 13));
    if (this.seenF.has(k)) return;
    this.seenF.add(k);
    if (this.seenF.size > 6000) this.seenF = new Set([...this.seenF].slice(-3000));
    this.enqueue(() => this.handleFrame(p));
  }
  private async parse(pt: U8): Promise<Op | null> {
    try {
      const o = JSON.parse(td.decode(pt[0] === 2 ? await inflate(pt.subarray(1)) : pt.subarray(1)));
      return o && typeof o === 'object' ? o : null;
    } catch { return null; }
  }
  private async handleFrame(p: U8) {
    if (this.state === 'off') return;
    const stage = p[0], body = p.subarray(1), aad = new Uint8Array([stage, this.host ? 1 : 0]);
    if (stage === 0) {
      const pt = await unseal(this.kWire, body, aad);
      const o = pt && pt[0] === 0 ? await this.parse(pt) : null;
      if (o) await this.onHs(o);
      return;
    }
    if (stage !== 1) return;
    let pt = this.kSess ? await unseal(this.kSess, body, aad) : null;
    if (!pt && this.pend) {
      pt = await unseal(this.pend.k, body, aad);
      if (pt) await this.promote();
    }
    if (!pt) { this.badKey(); return; }
    if (!this.host && !this.confirmed) { this.confirmed = true; this.sessionUp(); }
    this.touch();
    if (pt[0] === 1) { this.xfer.onChunk(pt.subarray(1), false); return; }
    const o = await this.parse(pt);
    if (o) await this.onOp(o, false);
  }
  /** A frame we cannot decrypt: the peer probably restarted. Ask for / start a new handshake (rate-limited). */
  private badKey() {
    const t = now();
    if (t - this.lastGood < 5000 || t - this.reAt < 4000) return;
    this.reAt = t;
    if (this.host) void this.sendWire(0, J({ t: 're' }));
    else if (t - this.hsAt > 4000) void this.hsStart();
  }

  // ---------- handshake ----------
  private async hsStart() {
    clearTimeout(this.hsTimer); clearTimeout(this.okTimer);
    this.teardown();
    this.kSess = undefined; this.confirmed = false; this.gotCfg = false;
    if (this.state === 'up') { this.state = 'wait'; this.emit('state'); }
    this.hs = { kp: await ecdhGen(), n: rnd(8), tries: 0 };
    this.hsAt = now();
    await this.sendHi();
  }
  private async sendHi() {
    const hs = this.hs;
    if (!hs || hs.done || this.state === 'off') return;
    const o: Op = { t: 'hi', v: PROTO, e: b64(hs.kp.pub), n: b64(hs.n), g: this.rec.g, z: canZ ? 1 : 0 };
    if (this.rec.rk) o.r = b64((await hmac(unb64(this.rec.rk), concat(hs.kp.pub, hs.n))).subarray(0, 16));
    await this.sendWire(0, J(o));
    const d = hs.tries < 8 ? 2500 : hs.tries < 30 ? 8000 : 30000;
    hs.tries++;
    this.hsTimer = setTimeout(() => this.enqueue(() => { if (this.hs === hs) return this.sendHi(); }), d);
  }
  private sendOk(n: number) {
    clearTimeout(this.okTimer);
    if (this.gotCfg || !this.kSess) return;
    this.send({ t: 'ok' });
    this.okTimer = setTimeout(() => {
      if (this.gotCfg) return;
      if (n < 8 || this.confirmed) this.sendOk(n + 1); else this.enqueue(() => this.hsStart());
    }, this.confirmed ? 6000 : 2500);
  }
  private async onHs(o: Op) {
    if (this.host) { if (o.t === 'hi') await this.onHi(o); return; }
    const hs = this.hs;
    if (o.t === 're') {
      if (hs && !hs.done) { clearTimeout(this.hsTimer); await this.sendHi(); }
      else if (now() - this.hsAt > 3500) await this.hsStart();
      return;
    }
    if (!hs || o.n !== b64(hs.n) || hs.done) return;
    if (o.t === 'no') { this.fail(String(o.c || 'no')); return; }
    if (o.t !== 'wl') return;
    const hpub = unb64(String(o.e)), hn = unb64(String(o.m));
    const tr = concat(te.encode('vz1/'), hs.n, hn, hs.kp.pub, hpub);
    if (app.owner && !(o.s && await ownerVerify(unb64(app.owner.pub), unb64(String(o.s)), tr))) { this.fail('sig'); return; }
    const kraw = await hkdf(await ecdh(hs.kp.priv, hpub), this.secret, tr, 32);
    hs.done = true;
    clearTimeout(this.hsTimer);
    this.kSess = await aesKey(kraw);
    this.sas = sasEmoji(await hkdf(kraw, null, 'vz1/sas', 3));
    this.peerZ = !!o.z && canZ;
    if (!o.b) { this.rec.rk = b64(await hkdf(kraw, null, 'vz1/resume', 32)); this.save(); }
    this.sendOk(0);
  }
  private async onHi(o: Op) {
    const no = (c: string) => this.sendWire(0, J({ t: 'no', c, n: o.n }));
    if (o.v !== PROTO) { await no('ver'); return; }
    if (typeof o.n !== 'string' || typeof o.e !== 'string' || typeof o.g !== 'string') return;
    if (this.pend && this.pend.gn === o.n) { await this.sendWire(0, this.pend.wl); return; }
    if (o.n === this.curGn) return;
    const gpub = unb64(o.e), gn = unb64(o.n), b = this.rec.bound;
    let resume = false;
    if (b) {
      if (o.g === b.g && typeof o.r === 'string' && eq((await hmac(unb64(b.rk), concat(gpub, gn))).subarray(0, 16), unb64(o.r))) resume = true;
      else if (!this.rec.reusable) { await no('used'); return; }
    }
    if (!resume && this.rec.dead) { await no('rev'); return; }
    if (!resume && this.rec.invExp && now() > this.rec.invExp) { await no('exp'); return; }
    if (app.owner && !app.ownerKey) return; // this device cannot prove it belongs to the owner
    const kp = await ecdhGen(), hn = rnd(8);
    const tr = concat(te.encode('vz1/'), gn, hn, gpub, kp.pub);
    const kraw = await hkdf(await ecdh(kp.priv, gpub), this.secret, tr, 32);
    const wl: Op = { t: 'wl', e: b64(kp.pub), n: o.n, m: b64(hn), b: resume ? 1 : 0, z: canZ ? 1 : 0 };
    if (app.ownerKey) wl.s = b64(await ownerSign(app.ownerKey, tr));
    this.pend = { k: await aesKey(kraw), kraw, g: o.g, gn: o.n, resume, wl: J(wl), z: !!o.z && canZ };
    await this.sendWire(0, this.pend.wl);
  }
  /** Host: the guest proved it has the new key — switch to the new session. */
  private async promote() {
    const p = this.pend!;
    this.pend = undefined;
    this.teardown();
    this.kSess = p.k; this.curGn = p.gn; this.peerZ = p.z;
    this.sas = sasEmoji(await hkdf(p.kraw, null, 'vz1/sas', 3));
    if (!p.resume) this.rec.bound = { g: p.g, rk: b64(await hkdf(p.kraw, null, 'vz1/resume', 32)) };
    this.save();
    this.sessionUp();
  }
  private sendCfg() {
    const r = this.rec;
    this.send({ t: 'cfg', md: r.mode, ex: r.exp, tm: r.timer, nm: r.name, ic: app.customIce() || undefined });
  }
  private sessionUp() {
    this.state = 'up';
    this.seq = 0; this.seenOp.clear();
    this.rtcGen = 0; this.rtcTries = 0;
    this.lastGood = this.lastRx = now();
    this.setOnline(true);
    for (const m of this.msgs) if (m.mine && m.st === 0 && !m.sys) this.sendR(this.msgOp(m));
    if (this.rec.dead) this.sendR({ t: 'wipe' }, undefined, ok => { if (ok) app.removeRoom(this); });
    this.emit('state');
  }

  // ---------- link: send / reliable ops / presence ----------
  send(op: Op) {
    if (!this.kSess) return;
    const s = JSON.stringify(op);
    if (this.rtc?.dcSend(s)) return;
    void this.sendWireJson(s);
  }
  sendR(op: Op, key?: string, done?: (ok: boolean) => void) {
    if (op.i == null) op.i = '~' + (this.seq++).toString(36);
    if (key) for (const [id, e] of this.out) if (e.key === key) { clearTimeout(e.timer); this.out.delete(id); }
    this.out.set(op.i, { op, tries: 0, timer: 0, at: 0, key, done });
    this.xmit(op.i);
  }
  private xmit(id: string) {
    const e = this.out.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    if (this.state !== 'up') return;
    this.send(e.op);
    e.tries++; e.at = now();
    if (e.tries > 1 && !this.direct) app.wire.probe();
    const rto = this.direct ? 5000 : !this.online ? 30000 : Math.min(2500 * 1.7 ** (e.tries - 1), 20000);
    e.timer = setTimeout(() => this.xmit(id), rto);
  }
  private flush() { for (const id of [...this.out.keys()]) this.xmit(id); }
  private acked(i: string) {
    const e = this.out.get(i);
    if (e) { clearTimeout(e.timer); this.out.delete(i); e.done?.(true); }
    // fast retransmit: an ack proves the path works, so resend whatever has been waiting for a while
    const t = now();
    for (const [id, x] of this.out) if (x.tries > 0 && t - x.at > 1200) this.xmit(id);
    const m = this.msgs.find(x => x.id === i && x.mine);
    if (m && m.st === 0) { m.st = 1; this.persistMsg(m); this.emit('msg', m); }
  }
  private queueAck(i: string, viaDc: boolean) {
    this.ackQ.push(i);
    clearTimeout(this.ackT);
    if (viaDc || this.ackQ.length > 20) this.flushAcks(); else this.ackT = setTimeout(() => this.flushAcks(), 180);
  }
  private flushAcks() {
    clearTimeout(this.ackT);
    if (this.ackQ.length) this.send({ t: 'a', i: this.ackQ.splice(0) });
  }
  private touch() {
    const t = now(), gap = t - this.lastRx;
    this.lastRx = this.lastGood = t;
    if (this.state !== 'up') return;
    if (!this.online) { this.setOnline(true); this.flush(); }
    else if (gap > 2500) this.resend();   // the peer was silent for a while (reconnected?): do not wait for timers
  }
  private resend() { const t = now(); for (const [id, x] of this.out) if (t - x.at > 1000) this.xmit(id); }
  /** A relay connection (re)appeared: announce ourselves and retry pending deliveries. */
  wireUp() {
    if (this.state === 'up') { this.lastPing = 0; this.resend(); }
    else if (this.state === 'wait' && !this.host && this.hs && !this.hs.done) { clearTimeout(this.hsTimer); this.enqueue(() => this.sendHi()); }
    else if (this.state === 'wait' && this.host) this.nudge(0);
  }
  /** Host without a session: tell a (possibly still connected) guest that we are back. Repeated a few times,
   *  because a guest ignores the request right after its own handshake. */
  private nudge(n: number) {
    clearTimeout(this.nudgeT);
    if (this.state !== 'wait' || !this.host) return;
    void this.sendWire(0, J({ t: 're' }));
    if (n < 3 && this.rec.bound) this.nudgeT = setTimeout(() => this.nudge(n + 1), [4000, 9000, 20000][n]);
  }
  private setOnline(v: boolean) {
    if (this.online === v) return;
    this.online = v;
    this.emit('state');
  }
  onDc(data: unknown) {
    this.touch();
    const rtc = this.rtc;
    if (rtc && !rtc.dcReady && rtc.dc.readyState === 'open') { rtc.dcReady = true; this.linkChanged(); }
    if (typeof data === 'string') {
      let o: Op;
      try { o = JSON.parse(data); } catch { return; }
      if (o && typeof o === 'object') this.enqueue(() => this.onOp(o, true));
    } else if (data instanceof ArrayBuffer) this.xfer.onChunk(new Uint8Array(data), true);
  }
  linkChanged() {
    if (!this.direct) this.lastPing = 0;   // direct link lost: check at once that the peer still hears us via the relay
    this.emit('state');
    this.xfer.linkChanged();
    if (this.direct) this.flush();
  }
  tick(t: number) {
    if (this.state === 'up') {
      const dc = this.direct;
      if (t - this.lastPing > (dc ? 5000 : 20000)) { this.lastPing = t; this.send({ t: 'p' }); }
      if (dc && t - this.lastRx > 16000) this.rtc!.stale();
      this.setOnline(t - this.lastRx < (this.direct ? 16000 : 50000));
      if ((this.call.st === 'out' || this.call.st === 'in') && t - this.call.at > 45000) {
        if (this.call.st === 'out') this.sendR({ t: 'c', a: 'end' });
        this.callCleanup('noanswer');
      }
    }
    const dead = this.msgs.filter(m => m.del && m.del <= t);
    if (dead.length) {
      this.msgs = this.msgs.filter(m => !dead.includes(m));
      for (const m of dead) { void db.del('msgs', this.rec.id + '|' + m.id); if (m.file) this.dropFile(m.file.tid); }
      this.emit('purge');
    }
    this.xfer.tick(t);
  }
  /** Network came back / tab became visible: re-check everything. */
  kick() {
    if (this.state === 'up' && !this.direct) this.retryDirect();
    if (this.state === 'up') { this.lastPing = 0; }
    if (this.state === 'wait' && !this.host && this.hs && !this.hs.done) { this.hs.tries = 0; clearTimeout(this.hsTimer); this.enqueue(() => this.sendHi()); }
  }

  // ---------- incoming ops ----------
  private async onOp(o: Op, viaDc: boolean) {
    if (o.i != null && o.t !== 'a') {
      const id = String(o.i);
      this.queueAck(id, viaDc);
      if (o.t !== 'm') { if (this.seenOp.has(id)) return; this.seenOp.add(id); }
    }
    switch (o.t) {
      case 'a': if (Array.isArray(o.i)) for (const i of o.i) this.acked(String(i)); break;
      case 'ok': if (this.host) this.sendCfg(); break;
      case 'cfg': if (!this.host) this.onCfg(o); break;
      case 'go': if (this.host && !this.rtc) { this.rtcGen = 1; this.startRtc(); } break;
      case 'by':
        this.lastRx = 0; this.setOnline(false);
        if (o.x && this.rec.mode === 's') this.closeLocal('peer');
        else if (o.x) this.rtc?.stale();
        break;
      case 'm': this.onMsg(o); break;
      case 'wipe':
        this.flushAcks();
        await this.wipeLocal();
        this.stop();
        app.removeRoom(this);
        this.emit('closed', 'wiped');
        break;
      case 'tm': this.rec.timer = Math.max(0, o.s | 0); this.save(); this.sysMsg('timer', String(this.rec.timer)); this.emit('state'); break;
      case 'sd': await this.rtcFor(o.g)?.onSd(o.d, o.q); break;
      case 'ic': await this.rtcFor(o.g)?.onIce(o.c); break;
      case 'ri': if (this.host) { if (o.f) this.rtcTries = 0; this.rtcFailed(); } break;
      case 'fg': void this.xfer.serve(o.f >>> 0, +o.o || 0, +o.l || 0); break;
      case 'fn': this.xfer.onNak(o.f >>> 0); break;
      case 'c': this.onCall(o); break;
    }
  }
  private onCfg(o: Op) {
    clearTimeout(this.okTimer);
    const first = !this.gotCfg;
    this.gotCfg = true;
    const r = this.rec;
    r.mode = o.md === 's' ? 's' : 'f';
    r.exp = +o.ex || 0;
    r.timer = Math.max(0, o.tm | 0);
    if (typeof o.nm === 'string' && o.nm) r.name = o.nm.slice(0, 60);
    this.cfgIce = Array.isArray(o.ic) ? o.ic : undefined;
    if (r.tmp) { r.tmp = false; app.pairDone(this); }
    this.save();
    if (first) this.sendR({ t: 'go' });
    this.emit('state');
  }

  // ---------- rtc management ----------
  private ice(): RTCIceServer[] { return (this.host ? app.customIce() : this.cfgIce) || app.ice(); }
  private startRtc() {
    if (app.noP2P || typeof RTCPeerConnection === 'undefined' || this.state !== 'up') return;
    if (this.call.st !== 'idle') this.callCleanup('lost');
    this.rtc?.close();
    this.rtcAt = now();
    try { this.rtc = new Rtc(this, !this.host, this.ice(), this.rtcGen); } catch (e) { console.warn('rtc', e); this.rtc = undefined; }
    this.emit('state');
  }
  private rtcFor(g: number): Rtc | undefined {
    if (app.noP2P || !(g > 0)) return undefined;
    if (this.host) return g === this.rtcGen ? this.rtc : undefined;
    if (!this.rtc || g > this.rtcGen) { this.rtcGen = g; this.startRtc(); }
    return g === this.rtcGen ? this.rtc : undefined;
  }
  rtcOk() { this.rtcTries = 0; clearTimeout(this.rtcT); }
  /** Direct link failed. Host: try ICE restart first, then rebuild (a few times). Guest: ask the host. */
  rtcFailed() {
    if (this.state !== 'up' || app.noP2P) return;
    const t = now();
    if (!this.host) {
      if (t - this.riAt > 5000) { this.riAt = t; this.send({ t: 'ri' }); }
      return;
    }
    if (this.rtcTries >= 5 || t - this.rtcAt < 2500) return;
    const rtc = this.rtc, n = this.rtcTries++;
    clearTimeout(this.rtcT);
    if (n === 0 && rtc?.everUp && !rtc.closed && rtc.dc.readyState === 'open') {
      try { rtc.pc.restartIce(); } catch { /* ignore */ }
      this.rtcT = setTimeout(() => { if (!this.direct) this.rtcFailed(); }, 12000);
      return;
    }
    this.rtcT = setTimeout(() => this.rtcRebuild(), [0, 1500, 15000, 45000, 90000][n] || 90000);
  }
  private rtcRebuild() {
    if (this.state !== 'up' || !this.host) return;
    if (this.rtc?.dcReady && this.rtc.pc.connectionState === 'connected') return;
    this.rtcGen++;
    this.startRtc();
  }
  /** Manual or automatic (network change) attempt to get a direct link again. */
  retryDirect() {
    if (this.state !== 'up' || this.direct || app.noP2P) return;
    this.rtcTries = 1;
    if (this.host) { if (now() - this.rtcAt > 4000) this.rtcRebuild(); }
    else if (now() - this.riAt > 4000) { this.riAt = now(); this.send({ t: 'ri', f: 1 }); }
  }

  // ---------- chat ----------
  private msgOp(m: Msg): Op {
    const f = m.file;
    return { t: 'm', i: m.id, x: m.text, f: f && { n: f.name, s: f.size, y: f.mime, t: f.tid, d: f.dur, v: f.voice ? 1 : undefined } };
  }
  private addMsg(m: Msg) {
    if (this.rec.timer > 0 && !m.sys) m.del = now() + this.rec.timer * 1000;
    this.msgs.push(m);
    this.rec.last = m.ts;
    this.persistMsg(m);
    this.save();
    this.emit('msg', m);
  }
  private persistMsg(m: Msg) {
    if (this.rec.mode === 'f' && !this.rec.tmp && !this.gone) void db.put('msgs', { k: this.rec.id + '|' + m.id, room: this.rec.id, m });
  }
  sysMsg(sys: string, arg?: string) { this.addMsg({ id: b64(rnd(6)), mine: false, ts: now(), st: 1, sys, arg }); }
  sendText(text: string) {
    text = text.trim();
    if (!text) return;
    const m: Msg = { id: b64(rnd(6)), mine: true, ts: now(), text: text.slice(0, 20000), st: 0 };
    this.addMsg(m);
    if (this.state === 'up') this.sendR(this.msgOp(m));
  }
  sendFile(blob: Blob, name: string, extra?: { voice?: boolean; dur?: number }) {
    const tid = new DataView(rnd(4).buffer).getUint32(0);
    this.xfer.offer(tid, blob);
    const file: FileMeta = { name: name.slice(0, 200), size: blob.size, mime: blob.type || 'application/octet-stream', tid, ...extra };
    const m: Msg = { id: b64(rnd(6)), mine: true, ts: now(), st: 0, file };
    this.persistBlob(tid, blob);
    this.addMsg(m);
    if (this.state === 'up') this.sendR(this.msgOp(m));
  }
  private onMsg(o: Op) {
    const id = String(o.i);
    if (this.msgs.some(m => m.id === id)) return;
    const m: Msg = { id, mine: false, ts: now(), st: 1 };
    if (typeof o.x === 'string') m.text = o.x.slice(0, 20000);
    const f = o.f;
    if (f && typeof f === 'object') {
      m.file = { name: String(f.n || 'file').slice(0, 200), size: Math.max(0, +f.s || 0), mime: String(f.y || '').replace(/[^\w.+\/-]/g, '').slice(0, 100),
        tid: f.t >>> 0, dur: +f.d || undefined, voice: !!f.v };
    }
    if (!m.text && !m.file) return;
    if (app.active !== this.rec.id || document.hidden) this.rec.unread++;
    this.addMsg(m);
    if (m.file) this.xfer.auto(m);
    app.notify(this);
  }
  persistBlob(tid: number, blob: Blob) {
    if (this.rec.mode === 'f' && !this.rec.tmp && !this.gone && blob.size <= PERSIST_MAX) {
      void db.put('blobs', { k: this.rec.id + '|' + tid, room: this.rec.id, blob });
    }
  }
  async loadBlob(tid: number): Promise<Blob | undefined> {
    if (this.rec.mode !== 'f') return undefined;
    return (await db.get<{ blob: Blob }>('blobs', this.rec.id + '|' + tid))?.blob;
  }
  private dropFile(tid: number) { this.xfer.drop(tid); void db.del('blobs', this.rec.id + '|' + tid); }
  setTimer(sec: number) {
    this.rec.timer = sec;
    this.save();
    if (this.state === 'up') this.sendR({ t: 'tm', s: sec });
    this.sysMsg('timer', String(sec));
    this.emit('state');
  }
  markRead() { if (this.rec.unread) { this.rec.unread = 0; this.save(); app.emit('rooms'); } }

  // ---------- wipe ----------
  private async wipeLocal() {
    this.msgs = [];
    this.xfer.clear();
    this.rec.unread = 0;
    await db.delRoom('msgs', this.rec.id);
    await db.delRoom('blobs', this.rec.id);
    this.emit('purge');
  }
  /** "Delete everything": wipe both sides. If the peer is unreachable, remember to deliver the wipe later. */
  async wipeAll() {
    const hadPeer = this.host ? !!this.rec.bound : !!this.rec.rk;
    let delivered = false;
    if (this.state === 'up' && this.online) {
      delivered = await new Promise<boolean>(res => {
        const t = setTimeout(() => res(false), 3500);
        this.sendR({ t: 'wipe' }, undefined, ok => { clearTimeout(t); res(ok); });
      });
    }
    await this.wipeLocal();
    if (hadPeer && !delivered && this.rec.mode === 'f') {
      this.rec.dead = true;
      this.save();
      if (this.state === 'off') this.start();
      app.emit('rooms');
    } else { this.stop(); app.removeRoom(this); }
    this.emit('closed', 'self');
  }

  // ---------- calls ----------
  private setCall(p: Partial<CallState>) { Object.assign(this.call, p); this.emit('call'); }
  private sendMediaState() { this.sendR({ t: 'c', a: 'st', au: this.call.mic ? 1 : 0, vi: this.call.cam ? 1 : 0 }, 'cst'); }
  async callStart(video: boolean) {
    if (this.call.st !== 'idle') return;
    if (!this.direct || !this.rtc) throw new Error('nop2p');
    await this.rtc.getMedia(video);
    if (this.call.st !== 'idle' || !this.rtc?.local) { this.rtc?.stopMedia(); return; }
    this.call = { ...idleCall(), st: 'out', video, at: now(), cam: video };
    this.sendR({ t: 'c', a: 'ring', v: video ? 1 : 0 });
    this.emit('call');
  }
  async callAccept(video: boolean) {
    const rtc = this.rtc;
    if (this.call.st !== 'in' || !rtc) return;
    try { await rtc.getMedia(video); } catch (e) { this.callDecline(); throw e; }
    if (this.call.st !== 'in') { rtc.stopMedia(); return; }
    await rtc.attach(false);
    rtc.leftovers();
    this.setCall({ st: 'on', t0: now(), cam: video });
    this.sendR({ t: 'c', a: 'acc' });
    this.sendMediaState();
  }
  callDecline() { if (this.call.st === 'in') { this.sendR({ t: 'c', a: 'dec' }); this.callCleanup('declined'); } }
  callEnd() { if (this.call.st !== 'idle') { this.sendR({ t: 'c', a: 'end' }); this.callCleanup('ended'); } }
  private callCleanup(why: string) {
    const c = this.call;
    if (c.st === 'idle') return;
    this.rtc?.stopMedia();
    this.call = idleCall();
    this.sysMsg('call_' + why, c.t0 ? String(Math.round((now() - c.t0) / 1000)) : '');
    this.emit('call', why);
  }
  private onCall(o: Op) {
    const c = this.call;
    switch (o.a) {
      case 'ring':
        if (c.st === 'idle') { this.call = { ...idleCall(), st: 'in', video: !!o.v, at: now() }; this.emit('call'); app.notify(this, true); }
        else if (c.st === 'out' && !this.host) { // both pressed "call": the host's call wins, the guest answers it
          void (async () => {
            await this.rtc?.attach(false); this.rtc?.leftovers();
            this.setCall({ st: 'on', t0: now() });
            this.sendR({ t: 'c', a: 'acc' }); this.sendMediaState();
          })();
        } else if (c.st !== 'out') this.sendR({ t: 'c', a: 'busy' });
        break;
      case 'acc':
        if (c.st === 'out') { this.setCall({ st: 'on', t0: now() }); void this.rtc?.attach(true); this.sendMediaState(); }
        break;
      case 'dec': if (c.st === 'out') this.callCleanup('declined'); break;
      case 'busy': if (c.st === 'out') this.callCleanup('busy'); break;
      case 'end': this.callCleanup(c.st === 'in' ? 'missed' : 'ended'); break;
      case 'st': this.setCall({ rau: !!o.au, rvi: !!o.vi }); break;
    }
  }
  toggleMic() { if (this.rtc && this.call.st === 'on') { this.setCall({ mic: this.rtc.toggleMic() }); this.sendMediaState(); } }
  async toggleCam() {
    if (!this.rtc || this.call.st !== 'on') return;
    const on = await this.rtc.setCam(!this.call.cam);
    this.setCall({ cam: on });
    this.sendMediaState();
  }
  async switchCam() { if (this.rtc && this.call.cam) { await this.rtc.switchCam(); this.emit('call'); } }
}
