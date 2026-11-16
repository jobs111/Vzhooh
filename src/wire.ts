// "Wire": several public MQTT brokers used in parallel as a dumb, untrusted relay for encrypted frames.
// Includes detection of connections that silently freeze after ~16 KB (seen on some networks):
// such connections are replaced by fresh ones before they reach the limit.
import { Mqtt } from './mqtt';
import { Emitter, now, U8 } from './util';

export const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://public:public@public.cloud.shiftr.io',
  'wss://mqtt.eclipseprojects.io/mqtt',
  'wss://broker-cn.emqx.io:8084/mqtt',
];
export type AntiFreeze = 'auto' | 'on' | 'off';
type Handler = (payload: U8) => void;

const PING_EVERY = 25000, PONG_WAIT = 9000;
const ECHO_WAIT = 5000;                      // a fresh connection must deliver a test message within this time
const PARK = [20000, 60000, 180000, 600000]; // a relay that connects but delivers nothing is left alone for a while

// On some networks (mobile internet in Russia) every connection to a foreign server silently freezes after a few
// kilobytes. A relay is therefore trusted only after it has really delivered a message ("good"), the size of the
// budget is learned from observed freezes, and connections are replaced *before* they reach it: a warm spare
// connection is kept ready, subscribed just in time, and swapped in without a gap.
class Conn {
  m?: Mqtt;                 // active connection (subscribed)
  spare?: Mqtt;             // warm standby: connected, not subscribed
  up = false;               // active connection is established
  good = false;             // ...and has proved that it delivers messages
  rtt = 0;
  fails = 0;
  curtain = false;          // this relay freezes connections on this network
  limit = 0;                // received bytes at which a connection froze (smallest seen)
  rotations = 0;
  private spareUp = false;
  private swapping = false;
  private pingAt = 0;
  private pongDue = 0;
  private echoDue = 0;
  private probe = '';
  private retry: any;
  private stopped = true;
  private backoff = 1000;
  private parked = 0;
  private busyAt = 0;

  constructor(private w: Wire, public url: string) {
    try {
      const c = JSON.parse(localStorage.getItem('vz.curtain2') || '{}')[url];
      if (c && now() - c.t < 3 * 3600e3) { this.calAt = c.t; if (c.l > 0) { this.curtain = true; this.limit = c.l; } }
    } catch { /* ignore */ }
  }
  private calAt = 0;
  private calBusy = false;
  private remember() {
    this.calAt = now();
    try {
      const all = JSON.parse(localStorage.getItem('vz.curtain2') || '{}');
      all[this.url] = { l: this.curtain ? this.limit : 0, t: this.calAt };
      localStorage.setItem('vz.curtain2', JSON.stringify(all));
    } catch { /* ignore */ }
  }
  /** Measure, on a separate throw-away connection, whether this relay freezes connections here and after how much.
   *  Knowing it in advance means the first call or file does not have to run into the freeze to find out. */
  calibrate(force = false) {
    if (this.calBusy || this.stopped || this.w.antiFreeze === 'off' || (!force && now() - this.calAt < 20 * 60e3)) return;
    this.calBusy = true;
    const N = 26, t = new Mqtt(this.url), topic = 'vz/p/' + Math.random().toString(36).slice(2, 10);
    let got = 0, upAt = 0;
    const end = () => {
      if (!this.calBusy) return;
      this.calBusy = false;
      const rx = t.rx;
      t.close();
      if (!upAt || got === 0) return;                       // could not measure: keep what we know
      if (got >= N) { if (this.curtain) { this.curtain = false; this.limit = 0; this.w.changed(); } }
      else { this.curtain = true; this.limit = this.limit ? Math.min(this.limit, rx) : rx; this.w.changed(); }
      this.w.log.push(`${new Date().toISOString().slice(14, 23)} calibrated ${this.url.split('@').pop()} got=${got}/${N} rx=${rx} curtain=${this.curtain}`);
      this.remember();
    };
    t.onmsg = () => { if (++got >= N) end(); };
    t.onup = () => {
      upAt = now();
      t.subscribe([topic]);
      const data = crypto.getRandomValues(new Uint8Array(900));
      let i = 0;
      setTimeout(() => { const iv = setInterval(() => { t.publish(topic, data); if (++i >= N) clearInterval(iv); }, 60); }, 250);
      setTimeout(end, 250 + N * 60 + 3000);
    };
    t.ondown = () => end();
    setTimeout(() => { if (!upAt) end(); }, 9000);
    t.open();
  }
  get rotateAt() { return Math.max(1800, Math.round((this.limit || 7000) * 0.55)); }
  start() { this.stopped = false; this.connect(); }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.m?.close(); this.spare?.close();
    this.m = this.spare = undefined;
    this.up = this.good = this.spareUp = false;
  }
  private fresh(): Mqtt {
    const m = new Mqtt(this.url);
    m.onmsg = (t, p) => { if (t === this.probe) { this.onEcho(m); return; } this.w.dispatch(t, p); };
    m.onpong = () => { if (m === this.m && this.pongDue) { this.rtt = now() - this.pingAt; this.pongDue = 0; } };
    m.ontraffic = () => this.account(m);
    return m;
  }
  /** Make m the active connection: subscribe, then prove delivery with one tiny echo. */
  private activate(m: Mqtt) {
    this.m = m; this.up = true; this.pongDue = 0; this.pingAt = now();
    this.probe = 'vz/p/' + Math.random().toString(36).slice(2, 10);
    m.subscribe([...this.w.topics(), this.probe]);
    m.publish(this.probe, new Uint8Array([1]));
    this.echoDue = now() + ECHO_WAIT;
    m.ondown = () => {
      if (this.m !== m) return;
      this.m = undefined; this.up = this.good = false; this.fails++;
      this.w.changed();
      this.reconnect();
    };
  }
  private onEcho(m: Mqtt) {
    if (m !== this.m) return;
    this.echoDue = 0;
    this.rtt = Math.max(1, now() - this.pingAt);
    this.parked = 0; this.fails = 0; this.backoff = 1000;
    if (!this.good) { this.good = true; this.w.changed(); this.w.emit('up'); this.calibrate(); }
  }
  private reconnect() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.backoff * (0.7 + Math.random() * 0.6));
    this.backoff = Math.min(this.backoff * 2, 30000);
  }
  private connect() {
    if (this.stopped || this.m) return;
    if (this.spare && this.spareUp) { const s = this.spare; this.spare = undefined; this.spareUp = false; this.activate(s); this.w.changed(); return; }
    const m = this.m = this.fresh();
    m.onup = () => { if (this.m === m) { this.activate(m); this.w.changed(); } };
    m.ondown = () => { if (this.m === m) { this.m = undefined; this.up = this.good = false; this.fails++; this.reconnect(); } };
    m.open();
  }
  private ping(wait: number) {
    if (!this.m?.up || this.pongDue) return;
    this.pingAt = now(); this.pongDue = this.pingAt + wait;
    this.m.ping();
  }
  /** Keep a spare connection ready while data is flowing on a relay that freezes connections. */
  private ensureSpare() {
    if (this.spare || this.stopped || !this.curtain || this.w.antiFreeze === 'off') return;
    const s = this.spare = this.fresh();
    this.spareUp = false;
    s.onup = () => { if (this.spare === s) { this.spareUp = true; if (this.swapping) this.swap(); } };
    s.ondown = () => { if (this.spare === s) { this.spare = undefined; this.spareUp = false; } };
    s.open();
  }
  private account(m: Mqtt) {
    if (m !== this.m || !m.up || this.w.antiFreeze === 'off') return;
    this.busyAt = now();
    if (!this.curtain && this.w.antiFreeze !== 'on') return;
    if (m.rx >= this.rotateAt * 0.3) this.ensureSpare();
    if (m.rx >= this.rotateAt && !this.swapping) { this.swapping = true; this.ensureSpare(); if (this.spareUp) this.swap(); }
  }
  /** Subscribe the spare, and once the relay confirms it, make it the active connection. */
  private swap() {
    const s = this.spare, old = this.m;
    if (!s || !this.spareUp) return;
    this.probe = 'vz/p/' + Math.random().toString(36).slice(2, 10);
    let done = false;
    const go = () => {
      if (done || this.spare !== s) return;
      done = true;
      this.spare = undefined; this.spareUp = false; this.swapping = false;
      this.m = s; this.pongDue = 0; this.pingAt = now(); this.echoDue = 0; this.rotations++;
      if (this.w.log.length < 400) this.w.log.push(`${new Date().toISOString().slice(14, 23)} swap oldrx=${old?.rx}`);
      s.ondown = () => { if (this.m === s) { this.m = undefined; this.up = this.good = false; this.w.changed(); this.reconnect(); } };
      setTimeout(() => old?.close(), 500);
      if (now() - this.busyAt < 8000) this.ensureSpare();
    };
    s.onsuback = go;
    s.subscribe([...this.w.topics(), this.probe]);
    setTimeout(go, 900);    // some relays may not confirm: do not wait forever
  }
  /** The active connection stopped delivering. */
  private stalled(why: 'echo' | 'pong') {
    const m = this.m;
    if (!m) return;
    this.w.log.push(`${new Date().toISOString().slice(14, 23)} stall(${why}) rx=${m.rx} tx=${m.tx} good=${this.good} spare=${this.spareUp} lim=${this.limit}`);
    if (why === 'echo' && !this.good) {
      // connects but delivers nothing at all: leave this relay alone for a while
      this.m = undefined; this.up = false; m.close();
      const wait = PARK[Math.min(this.parked++, PARK.length - 1)];
      this.w.changed();
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), wait);
      return;
    }
    if (this.w.antiFreeze !== 'off' && m.rx > 600 && m.rx < 200000) {
      this.curtain = true;
      this.limit = this.limit ? Math.min(this.limit, m.rx) : m.rx;
      this.remember();
    }
    this.m = undefined; this.up = this.good = false; this.swapping = false;
    m.close();
    this.w.changed();
    this.backoff = 1000;
    this.connect();
  }
  tick() {
    if (this.stopped) return;
    const t = now(), m = this.m;
    if (m?.up) {
      if (this.echoDue && t > this.echoDue) { this.stalled('echo'); return; }
      const young = this.w.antiFreeze !== 'off' && !this.curtain && m.rx > 3000 && m.rx < 60000;
      if (this.pongDue && t > this.pongDue) this.stalled('pong');
      else if (!this.pongDue && t - this.pingAt > (young ? 5000 : PING_EVERY)) this.ping(young ? 4500 : PONG_WAIT);
      if (this.spare && t - this.busyAt > 20000) { const s = this.spare; this.spare = undefined; this.spareUp = false; s.close(); }
    } else if (m && !m.up && t - m.openedAt > 12000) {
      this.m = undefined; m.close(); this.fails++;
      this.reconnect();
    }
  }
  /** A live stream went quiet: do not wait for proof of a freeze, switch to the spare connection right away. */
  hedge() {
    if (this.stopped || !this.curtain || this.swapping || !this.m?.up) return;
    this.swapping = true;
    this.ensureSpare();
    if (this.spareUp) this.swap();
  }
  kick(wait = 4500) {
    if (this.stopped) return;
    if (this.m?.up) this.ping(wait);
    else if (!this.m) { clearTimeout(this.retry); this.backoff = 1000; this.connect(); }
  }
  pub(topic: string, payload: U8): boolean { return !!this.m?.publish(topic, payload); }
  sub(t: string) { if (this.m?.up) this.m.subscribe([t]); }
  unsub(t: string) { if (this.m?.up) this.m.unsubscribe([t]); }
}

export class Wire extends Emitter {
  conns: Conn[] = [];
  antiFreeze: AntiFreeze = 'auto';
  log: string[] = [];   // recent connection events (for diagnostics)
  downSince = now();
  private wasDown = false;
  private subs = new Map<string, Handler>();
  private timer: any;

  start(urls: string[]) {
    for (const u of urls) this.add(u);
    if (!this.timer) this.timer = setInterval(() => {
      this.conns.forEach(c => c.tick());
      const d = this.down;
      if (d !== this.wasDown) { this.wasDown = d; this.emit('change'); }   // grace period over: let the UI show it at once
    }, 1000);
  }
  add(url: string) {
    if (this.conns.some(c => c.url === url)) return;
    const c = new Conn(this, url);
    this.conns.push(c);
    c.start();
  }
  stop() {
    clearInterval(this.timer); this.timer = undefined;
    this.conns.forEach(c => c.stop());
    this.conns = [];
    this.changed();
  }
  topics() { return [...this.subs.keys()]; }
  sub(topic: string, fn: Handler) { this.subs.set(topic, fn); this.conns.forEach(c => c.sub(topic)); }
  unsub(topic: string) { if (this.subs.delete(topic)) this.conns.forEach(c => c.unsub(topic)); }
  dispatch(topic: string, payload: U8) { this.subs.get(topic)?.(payload); }
  /** Publish to every connected broker (or only to the fastest one for bulk data). Returns how many accepted it. */
  private rr = 0;
  /** Relays that have proved they deliver messages, fastest first. */
  private goodConns() { return this.conns.filter(c => c.up && c.good).sort((a, b) => a.rtt - b.rtt); }
  pub(topic: string, payload: U8, bulk: boolean | number = false): number {
    if (bulk) {
      // bulk = true: one proven relay, taken in turn; bulk = N: the N fastest proven relays at once
      const ups = this.goodConns();
      if (!ups.length) return 0;
      if (bulk === true) return ups[this.rr++ % ups.length].pub(topic, payload) ? 1 : 0;
      let k = 0;
      for (const c of ups.slice(0, bulk)) if (c.pub(topic, payload)) k++;
      return k;
    }
    let n = 0;
    for (const c of this.conns) if (c.pub(topic, payload)) n++;
    return n;
  }
  get upCount() { return this.conns.filter(c => c.up && c.good).length; }
  get buffered() { return Math.max(0, ...this.conns.map(c => c.m?.buffered || 0)); }
  /** No relay connection for more than a few seconds (short gaps while connecting are not shown). */
  get down() { return this.upCount === 0 && !!this.downSince && now() - this.downSince > 3500; }
  changed() {
    if (this.upCount) this.downSince = 0; else if (!this.downSince) this.downSince = now();
    this.emit('change');
  }
  kick() { this.conns.forEach(c => { c.kick(); if (c.good) c.calibrate(); }); }
  /** A live stream (call) went silent: find a frozen connection fast. */
  probeFast() { const t = now(); if (t - this.probedAt < 1500) return; this.probedAt = t; this.conns.forEach(c => c.kick(1800)); }
  /** Every usable relay freezes connections on this network: streams must be as thin as possible. */
  private hedgedAt = 0;
  hedge() { const t = now(); if (t - this.hedgedAt < 1200) return; this.hedgedAt = t; this.conns.forEach(c => c.hedge()); }
  get slow() { const g = this.conns.filter(c => c.up && c.good); return g.length > 0 && g.every(c => c.curtain); }
  /** Bytes a connection may receive before it is replaced (smallest among usable relays), 0 = no limit known. */
  get budget() { const g = this.conns.filter(c => c.up && c.good && c.curtain); return g.length ? Math.min(...g.map(c => c.rotateAt)) : 0; }
  private probedAt = 0;
  /** Deliveries are timing out: check quickly whether the connections are still alive. */
  probe() {
    const t = now();
    if (t - this.probedAt < 3000) return;
    this.probedAt = t;
    this.conns.forEach(c => c.kick());
  }
}
