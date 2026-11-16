// Minimal MQTT 3.1.1 client over WebSocket (QoS 0 only). ~2 bytes of overhead per packet: good for 2G.
import { concat, now, td, te, U8 } from './util';

const str = (s: string) => { const b = te.encode(s); return concat([b.length >> 8, b.length & 255], b); };
function pkt(head: number, body: U8): U8 {
  const len: number[] = [];
  let n = body.length;
  do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 128; len.push(d); } while (n > 0);
  return concat([head, ...len], body);
}

export class Mqtt {
  private ws?: WebSocket;
  private buf: U8 = new Uint8Array(0);
  private pid = 1;
  private dead = false;
  up = false;
  rx = 0; tx = 0;
  lastRx = 0;
  openedAt = 0;
  onup?: () => void;
  ondown?: (why: string) => void;
  onmsg?: (topic: string, payload: U8) => void;
  onpong?: () => void;
  onsuback?: () => void;
  ontraffic?: () => void;

  constructor(public url: string, private keepAlive = 90) {}

  open() {
    let url = this.url, user = '', pass = '';
    const m = /^(wss?:\/\/)([^:@/]+):([^@/]*)@(.*)$/.exec(url);
    if (m) { user = decodeURIComponent(m[2]); pass = decodeURIComponent(m[3]); url = m[1] + m[4]; }
    this.openedAt = now();
    let ws: WebSocket;
    try { ws = this.ws = new WebSocket(url, 'mqtt'); } catch { setTimeout(() => this.fail('url'), 0); return; }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const id = 'vz' + Math.random().toString(36).slice(2, 12);
      const flags = 0x02 | (user ? 0x80 : 0) | (pass ? 0x40 : 0);
      this.raw(pkt(0x10, concat(str('MQTT'), [4, flags, this.keepAlive >> 8, this.keepAlive & 255], str(id),
        user ? str(user) : [], pass ? str(pass) : [])));
    };
    ws.onmessage = e => { if (e.data instanceof ArrayBuffer) this.feed(new Uint8Array(e.data)); };
    ws.onclose = () => this.fail('closed');
    ws.onerror = () => this.fail('error');
  }

  private raw(p: U8): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(p as unknown as ArrayBuffer); } catch { return false; }
    this.tx += p.length + 6;
    this.ontraffic?.();
    return true;
  }
  get buffered() { return this.ws?.bufferedAmount || 0; }

  private fail(why: string) {
    if (this.dead) return;
    this.dead = true;
    this.up = false;
    const ws = this.ws;
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; try { ws.close(); } catch { /* ignore */ } }
    this.ondown?.(why);
  }

  private feed(chunk: U8) {
    this.rx += chunk.length + 4;
    this.lastRx = now();
    let buf = this.buf.length ? concat(this.buf, chunk) : chunk;
    let off = 0;
    for (;;) {
      if (buf.length - off < 2) break;
      let rl = 0, mul = 1, i = off + 1, ok = false;
      for (; i < buf.length && i < off + 5; i++) {
        rl += (buf[i] & 127) * mul; mul *= 128;
        if (!(buf[i] & 128)) { ok = true; i++; break; }
      }
      if (!ok) { if (i >= off + 5) { this.fail('proto'); return; } break; }
      if (buf.length - i < rl) break;
      this.handle(buf[off], buf.subarray(i, i + rl));
      off = i + rl;
      if (this.dead) return;
    }
    this.buf = off < buf.length ? buf.slice(off) : new Uint8Array(0);
    this.ontraffic?.();
  }

  private handle(head: number, body: U8) {
    switch (head >> 4) {
      case 2: // CONNACK
        if (body[1] === 0) { this.up = true; this.onup?.(); } else this.fail('refused');
        break;
      case 3: { // PUBLISH
        const qos = (head >> 1) & 3, tl = (body[0] << 8) | body[1];
        const topic = td.decode(body.subarray(2, 2 + tl));
        this.onmsg?.(topic, body.slice(2 + tl + (qos ? 2 : 0)));
        break;
      }
      case 9: this.onsuback?.(); break; // SUBACK
      case 13: this.onpong?.(); break; // PINGRESP
    }
  }

  private nextPid() { this.pid = (this.pid % 65535) + 1; return [this.pid >> 8, this.pid & 255]; }
  subscribe(topics: string[]) {
    if (topics.length) this.raw(pkt(0x82, concat(this.nextPid(), ...topics.map(t => concat(str(t), [0])))));
  }
  unsubscribe(topics: string[]) {
    if (topics.length) this.raw(pkt(0xa2, concat(this.nextPid(), ...topics.map(str))));
  }
  publish(topic: string, payload: U8): boolean { return this.up && this.raw(pkt(0x30, concat(str(topic), payload))); }
  ping(): boolean { return this.raw(new Uint8Array([0xc0, 0])); }
  close() {
    if (this.dead) return;
    this.raw(new Uint8Array([0xe0, 0]));
    this.ondown = undefined;
    this.fail('bye');
  }
}
