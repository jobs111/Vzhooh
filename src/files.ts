// File transfer. The receiver drives it: asks for a byte range, the sender streams chunks.
// Direct link (WebRTC data channel): any size, with backpressure. Relay: small files only, windowed.
import type { Room } from './room';
import type { Msg } from './store';
import { t } from './i18n';
import { concat, fmtSize, now, sleep, U8 } from './util';

export const RELAY_MAX = 1024 * 1024;       // biggest file allowed through public relays (they are shared, free servers)
export const AUTO_MAX = 24 * 1024 * 1024;   // auto-download limit on a direct link
/** Types we are willing to render inline. Everything else (HTML, SVG, ...) is treated as an opaque download. */
export const safeMime = (m: string) => /^(image\/(png|jpeg|gif|webp)|(audio|video)\/[\w.+-]+)$/.test(m) ? m : 'application/octet-stream';
const WIRE_CHUNK = 3000;

export interface Inc {
  tid: number; size: number; mime: string; name: string; got: number;
  state: 'idle' | 'wait' | 'run' | 'done' | 'gone' | 'err';
  want: boolean; viaDc: boolean; win: number; winEnd: number; last: number; t0: number;
  parts: BlobPart[]; partBytes: number; blobs: Blob[];
  sink?: { write(d: BufferSource): Promise<void>; close(): Promise<void> }; sinkQ: Promise<void>;
  blob?: Blob; url?: string; saved?: boolean;
}
export interface Out { blob: Blob; gen: number; sent: number; url?: string }

export class Xfer {
  out = new Map<number, Out>();
  inc = new Map<number, Inc>();
  private lastEmit = new Map<number, number>();
  constructor(private room: Room) {}

  offer(tid: number, blob: Blob) { this.out.set(tid, { blob, gen: 0, sent: 0 }); }

  ensure(m: Msg): Inc {
    const f = m.file!;
    let i = this.inc.get(f.tid);
    if (!i) {
      i = { tid: f.tid, size: f.size, mime: f.mime, name: f.name, got: 0, state: 'idle', want: false, viaDc: false,
        win: 6000, winEnd: 0, last: 0, t0: 0, parts: [], partBytes: 0, blobs: [], sinkQ: Promise.resolve() };
      this.inc.set(f.tid, i);
    }
    return i;
  }
  /** Files up to AUTO_MAX download by themselves (waiting for a direct link if they are too big for the relay);
   *  bigger ones wait for a tap. */
  auto(m: Msg) {
    const i = this.ensure(m);
    if (i.size <= AUTO_MAX) this.fetch(i.tid);
  }
  fetch(tid: number, sink?: Inc['sink']) {
    const i = this.inc.get(tid);
    if (!i || i.state === 'done' || i.state === 'run') return;
    if (i.size === 0) { i.want = true; void this.finish(i); return; }
    i.want = true;
    if (sink) i.sink = sink;
    if (!i.t0) i.t0 = now();
    this.request(i);
  }
  private request(i: Inc) {
    const r = this.room;
    const dc = r.direct;
    if (r.state !== 'up' || (!dc && i.size > RELAY_MAX)) { i.state = 'wait'; this.changed(i.tid); return; }
    i.viaDc = dc; i.state = 'run'; i.last = now();
    i.winEnd = dc ? i.size : Math.min(i.size, i.got + i.win);
    r.send({ t: 'fg', f: i.tid, o: i.got, l: dc ? 0 : i.winEnd - i.got });
    this.changed(i.tid);
  }
  onChunk(u: U8, viaDc: boolean) {
    if (u.length < 10) return;
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const tid = dv.getUint32(0), off = dv.getUint16(4) * 4294967296 + dv.getUint32(6);
    const i = this.inc.get(tid);
    if (!i || i.state !== 'run' || off !== i.got) return;
    const data = u.subarray(10, 10 + Math.min(u.length - 10, i.size - i.got));
    if (i.sink) {
      const copy = data.slice(), s = i.sink;
      i.sinkQ = i.sinkQ.then(() => s.write(copy as unknown as BufferSource)).catch(() => { i.state = 'err'; this.changed(tid); });
    } else {
      i.parts.push(data as unknown as BlobPart); i.partBytes += data.length;
      if (i.partBytes >= 8 << 20) { i.blobs.push(new Blob(i.parts)); i.parts = []; i.partBytes = 0; }
    }
    i.got += data.length; i.last = now();
    if (i.got >= i.size) void this.finish(i);
    else if (!viaDc && i.got >= i.winEnd) { i.win = Math.min(i.win * 2, 48000); this.request(i); }
    else this.changed(tid, true);
  }
  private async finish(i: Inc) {
    i.state = 'done';
    if (i.sink) {
      await i.sinkQ;
      try { await i.sink.close(); } catch { /* ignore */ }
      i.saved = true; i.sink = undefined;
    } else {
      i.blob = new Blob([...i.blobs, ...i.parts], { type: safeMime(i.mime) });
      i.parts = []; i.blobs = [];
      i.url = URL.createObjectURL(i.blob);
      this.room.persistBlob(i.tid, i.blob);
    }
    this.changed(i.tid);
  }
  /** Restore a finished download from local storage (fast mode history). */
  restore(m: Msg, blob: Blob) {
    const i = this.ensure(m);
    if (i.state === 'done') return;
    i.state = 'done'; i.got = i.size; i.blob = blob.slice(0, blob.size, safeMime(i.mime)); i.url = URL.createObjectURL(i.blob);
  }
  onNak(tid: number) { const i = this.inc.get(tid); if (i && i.state !== 'done') { i.state = 'gone'; this.changed(tid); } }

  tick(t: number) {
    for (const i of this.inc.values()) {
      if (i.state === 'run' && t - i.last > (i.viaDc ? 10000 : 4500)) {
        if (!i.viaDc) i.win = Math.max(WIRE_CHUNK, i.win >> 1);
        this.request(i);
      }
    }
  }
  linkChanged() {
    for (const i of this.inc.values()) {
      if (i.want && (i.state === 'wait' || (i.state === 'run' && i.viaDc !== this.room.direct))) this.request(i);
    }
  }

  /** Sender side: stream [from, from+len) (len 0 = to the end). A newer request cancels the older one. */
  async serve(tid: number, from: number, len: number) {
    const r = this.room;
    let e = this.out.get(tid);
    if (!e) {
      const b = await r.loadBlob(tid);
      if (b) { e = { blob: b, gen: 0, sent: 0 }; this.out.set(tid, e); }
    }
    if (!e || !(from >= 0) || from > e.blob.size) { r.send({ t: 'fn', f: tid }); return; }
    const gen = ++e.gen, size = e.blob.size;
    const viaDc = r.direct, rtc = r.rtc;
    const cs = viaDc && rtc ? rtc.chunk : WIRE_CHUNK;
    const end = len > 0 ? Math.min(from + len, size) : size;
    const head = (off: number) => {
      const h = new Uint8Array(10), dv = new DataView(h.buffer);
      dv.setUint32(0, tid); dv.setUint16(4, Math.floor(off / 4294967296)); dv.setUint32(6, off >>> 0);
      return h;
    };
    let off = from;
    while (off < end && e.gen === gen) {
      const sliceEnd = Math.min(off + (viaDc ? 1 << 20 : cs * 4), end);
      const buf = new Uint8Array(await e.blob.slice(off, sliceEnd).arrayBuffer());
      for (let p = 0; p < buf.length; p += cs) {
        if (e.gen !== gen) return;
        const frame = concat(head(off + p), buf.subarray(p, p + cs));
        if (viaDc) { if (!rtc || !(await rtc.dcSendBin(frame))) return; }
        else {
          await r.sendWire(1, concat([1], frame), true);
          while (r.wireBuffered > 64000) await sleep(40);
          await sleep(8);
        }
      }
      off = sliceEnd;
      e.sent = Math.max(e.sent, off);
      this.changed(tid, true);
    }
    if (off >= size) { e.sent = size; this.changed(tid); }
  }

  outUrl(tid: number): string | undefined {
    const e = this.out.get(tid);
    if (!e) return undefined;
    return e.url ||= URL.createObjectURL(e.blob);
  }
  drop(tid: number) {
    const i = this.inc.get(tid), o = this.out.get(tid);
    if (i?.url) URL.revokeObjectURL(i.url);
    if (o) { o.gen++; if (o.url) URL.revokeObjectURL(o.url); }
    this.inc.delete(tid); this.out.delete(tid);
  }
  clear() { for (const t of [...this.inc.keys(), ...this.out.keys()]) this.drop(t); }

  private changed(tid: number, throttle = false) {
    if (throttle) {
      const t = now();
      if (t - (this.lastEmit.get(tid) || 0) < 150) return;
      this.lastEmit.set(tid, t);
    }
    this.room.emit('file', tid);
  }
}

/** User asked to download a file: very big files go straight to disk where the browser allows it. */
export async function startDownload(room: Room, m: Msg) {
  const f = m.file!;
  const picker = (window as any).showSaveFilePicker;
  if (f.size > 200 * 1024 * 1024 && picker) {
    try {
      const handle = await picker({ suggestedName: f.name });
      room.xfer.fetch(f.tid, await handle.createWritable());
      return;
    } catch (e: any) { if (e?.name === 'AbortError') return; }
  }
  if (f.size > 1024 * 1024 * 1024 && !confirm(t('bigAsk', fmtSize(f.size)))) return;
  room.xfer.fetch(f.tid);
}
