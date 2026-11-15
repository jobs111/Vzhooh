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
];
export type AntiFreeze = 'auto' | 'on' | 'off';
type Handler = (payload: U8) => void;

const PING_EVERY = 25000, PONG_WAIT = 9000, PROBE_FROM = 11000, PROBE_STEP = 4000, CLEAR_AT = 48000;

class Conn {
  m?: Mqtt;
  next?: Mqtt;
  up = false;
  rtt = 0;
  fails = 0;
  curtain = false;
  rotateAt = 7000;
  private cleared = false;
  private probeAt = PROBE_FROM;
  private pingAt = 0;
  private pongDue = 0;
  private retry: any;
  private stopped = true;
  private backoff = 1000;

  constructor(private w: Wire, public url: string) {
    try {
      const c = JSON.parse(localStorage.getItem('vz.curtain') || '{}')[url];
      if (c && now() - c.t < 2 * 3600e3) { this.curtain = true; this.rotateAt = c.at; }
    } catch { /* ignore */ }
  }
  start() { this.stopped = false; this.connect(); }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.m?.close(); this.next?.close();
    this.m = this.next = undefined;
    this.up = false;
  }
  private fresh(): Mqtt {
    const m = new Mqtt(this.url);
    m.onmsg = (t, p) => this.w.dispatch(t, p);
    return m;
  }
  private connect() {
    if (this.stopped || this.m) return;
    const m = this.m = this.fresh();
    m.onup = () => {
      this.up = true; this.backoff = 1000; this.fails = 0;
      this.rtt = now() - m.openedAt;
      this.reset();
      m.subscribe(this.w.topics());
      this.w.changed();
      this.w.emit('up');
    };
    m.ondown = () => {
      if (this.m !== m) return;
      this.m = undefined;
      const was = this.up;
      this.up = false; this.fails++;
      if (was) this.w.changed();
      if (this.stopped) return;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), this.backoff * (0.7 + Math.random() * 0.6));
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    m.onpong = () => { if (this.pongDue) { this.rtt = now() - this.pingAt; this.pongDue = 0; } };
    m.ontraffic = () => this.account(m);
    m.open();
  }
  private reset() { this.pongDue = 0; this.pingAt = now(); this.probeAt = PROBE_FROM; this.cleared = false; }

  private ping(wait: number) {
    if (!this.m?.up || this.pongDue) return;
    this.pingAt = now(); this.pongDue = this.pingAt + wait;
    this.m.ping();
  }
  /** Byte accounting: probe the connection at checkpoints, rotate early if a freeze limit is known. */
  private account(m: Mqtt) {
    if (m !== this.m || !m.up) return;
    const mode = this.w.antiFreeze;
    if (mode === 'off') return;
    const total = m.rx + m.tx;
    if ((this.curtain || mode === 'on') && total >= this.rotateAt) { this.rotate(); return; }
    if (!this.cleared && !this.curtain && total >= this.probeAt) {
      this.probeAt = total + PROBE_STEP;
      if (total > CLEAR_AT) this.cleared = true; else this.ping(4500);
    }
  }
  /** Make-before-break: open a fresh connection, subscribe, then drop the old one. */
  private rotate() {
    if (this.next || this.stopped) return;
    const n = this.next = this.fresh();
    n.onup = () => {
      n.subscribe(this.w.topics());
      const old = this.m;
      this.m = n; this.next = undefined;
      this.reset();
      n.ondown = () => { if (this.m === n) { this.m = undefined; this.up = false; this.w.changed(); this.connect(); } };
      n.onpong = () => { if (this.pongDue) { this.rtt = now() - this.pingAt; this.pongDue = 0; } };
      n.ontraffic = () => this.account(n);
      setTimeout(() => old?.close(), 400);
    };
    n.ondown = () => { if (this.next === n) this.next = undefined; };
    n.open();
  }
  private stalled() {
    const m = this.m;
    if (!m) return;
    const total = m.rx + m.tx;
    if (this.w.antiFreeze !== 'off' && total > 5000 && total < 64000) {
      this.curtain = true;
      this.rotateAt = Math.max(4500, Math.min(20000, Math.round(total * 0.55)));
      try {
        const all = JSON.parse(localStorage.getItem('vz.curtain') || '{}');
        all[this.url] = { at: this.rotateAt, t: now() };
        localStorage.setItem('vz.curtain', JSON.stringify(all));
      } catch { /* ignore */ }
    }
    this.m = undefined; this.up = false;
    m.close();
    this.w.changed();
    this.backoff = 1000;
    this.connect();
  }
  tick() {
    if (this.stopped) return;
    const t = now();
    if (this.m?.up) {
      // While a connection is "young" (a freeze limit may still be ahead), check it often: a ping costs ~2 bytes.
      const total = this.m.rx + this.m.tx;
      const suspect = this.w.antiFreeze !== 'off' && !this.cleared && total > 6000;
      if (this.pongDue && t > this.pongDue) this.stalled();
      else if (!this.pongDue && t - this.pingAt > (suspect ? 5000 : PING_EVERY)) this.ping(suspect ? 4500 : PONG_WAIT);
    } else if (this.m && !this.m.up && t - this.m.openedAt > 12000) {
      const m = this.m; this.m = undefined; m.close(); this.fails++;
      this.connect();
    }
  }
  kick() {
    if (this.stopped) return;
    if (this.m?.up) this.ping(4500);
    else if (!this.m) { clearTimeout(this.retry); this.backoff = 1000; this.connect(); }
  }
  pub(topic: string, payload: U8): boolean { return !!this.m?.publish(topic, payload); }
  sub(t: string) { if (this.m?.up) this.m.subscribe([t]); }
  unsub(t: string) { if (this.m?.up) this.m.unsubscribe([t]); }
}

export class Wire extends Emitter {
  conns: Conn[] = [];
  antiFreeze: AntiFreeze = 'auto';
  private subs = new Map<string, Handler>();
  private timer: any;

  start(urls: string[]) {
    for (const u of urls) this.add(u);
    if (!this.timer) this.timer = setInterval(() => this.conns.forEach(c => c.tick()), 1500);
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
  pub(topic: string, payload: U8, bulk = false): number {
    if (bulk) {
      const best = this.conns.filter(c => c.up).sort((a, b) => a.rtt - b.rtt)[0];
      return best && best.pub(topic, payload) ? 1 : 0;
    }
    let n = 0;
    for (const c of this.conns) if (c.pub(topic, payload)) n++;
    return n;
  }
  get upCount() { return this.conns.filter(c => c.up).length; }
  get buffered() { return Math.max(0, ...this.conns.map(c => c.m?.buffered || 0)); }
  changed() { this.emit('change'); }
  kick() { this.conns.forEach(c => c.kick()); }
  private probedAt = 0;
  /** Deliveries are timing out: check quickly whether the connections are still alive. */
  probe() {
    const t = now();
    if (t - this.probedAt < 3000) return;
    this.probedAt = t;
    this.conns.forEach(c => c.kick());
  }
}
