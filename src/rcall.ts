// Voice calls through the relay, for when a direct (WebRTC) link cannot be made: mobile CGNAT, VPN, strict networks.
// Audio is encoded in the browser (Opus via WebCodecs; IMA ADPCM 8 kHz as a universal fallback),
// sent as small end-to-end encrypted frames over the same relay as chat messages, and played with a jitter buffer.
import { ac } from './sound';
import { concat, U8 } from './util';

const FRAME_MS = 20;
// Normal relay: 3 frames (60 ms) per packet at ~24 kbit/s — good voice quality.
// Thin relay (connections freeze after a few KB): 10 frames (200 ms) per packet at 8 kbit/s — every byte counts.
const PACK_FAST = 3, PACK_THIN = 10, ADPCM_PACK = 5;
const BR_FAST = 24000, BR_THIN = 8000;
const OPUS_RATE = 48000, ADPCM_RATE = 8000;

let opusOk: Promise<boolean> | null = null;
/** Codecs this browser can both encode and decode: 'o' = Opus, 'a' = ADPCM (always). */
export async function localCodecs(): Promise<string[]> {
  try { if (localStorage.getItem('vz.codec') === '"a"') return ['a']; } catch { /* ignore */ }
  opusOk ||= (async () => {
    try {
      const W = window as any;
      if (!W.AudioEncoder || !W.AudioDecoder) return false;
      const e = await W.AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: 16000 });
      const d = await W.AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1 });
      return !!(e?.supported && d?.supported);
    } catch { return false; }
  })();
  return (await opusOk) ? ['o', 'a'] : ['a'];
}

// ---------- IMA ADPCM (4 bit per sample) ----------
const STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878,
  2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818,
  18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IDX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
const clamp = (v: number, a: number, b: number) => v < a ? a : v > b ? b : v;
/** Encode PCM (−1…1). Each packet carries the coder state, so packets decode independently (loss-tolerant). */
function adpcmEnc(pcm: Float32Array, st: { p: number; i: number }): U8 {
  const out = new Uint8Array(3 + (pcm.length >> 1));
  out[0] = st.p & 255; out[1] = (st.p >> 8) & 255; out[2] = st.i;
  for (let n = 0; n < pcm.length; n++) {
    const s = clamp(Math.round(pcm[n] * 32767), -32768, 32767);
    let step = STEP[st.i], diff = s - st.p, code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let delta = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; delta += step; }
    step >>= 1; if (diff >= step) { code |= 2; diff -= step; delta += step; }
    step >>= 1; if (diff >= step) { code |= 1; delta += step; }
    st.p = clamp(code & 8 ? st.p - delta : st.p + delta, -32768, 32767);
    st.i = clamp(st.i + IDX[code], 0, 88);
    if (n & 1) out[3 + (n >> 1)] |= code << 4; else out[3 + (n >> 1)] = code;
  }
  return out;
}
function adpcmDec(u: U8): Float32Array {
  let p = (u[0] | (u[1] << 8)) << 16 >> 16, i = clamp(u[2], 0, 88);
  const n = (u.length - 3) * 2, out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const code = k & 1 ? u[3 + (k >> 1)] >> 4 : u[3 + (k >> 1)] & 15;
    const step = STEP[i];
    let delta = step >> 3;
    if (code & 4) delta += step; if (code & 2) delta += step >> 1; if (code & 1) delta += step >> 2;
    p = clamp(code & 8 ? p - delta : p + delta, -32768, 32767);
    i = clamp(i + IDX[code], 0, 88);
    out[k] = p / 32768;
  }
  return out;
}

/** Streaming linear resampler with a light low-pass when downsampling. */
class Resampler {
  private pos = 0; private last = 0; private lp = 0;
  constructor(private inRate: number, private outRate: number) {}
  run(x: Float32Array): Float32Array {
    const r = this.inRate / this.outRate;
    const a = r > 1.5 ? Math.min(0.85, 1 / r * 1.6) : 1;   // one-pole low-pass factor
    const out: number[] = [];
    let pos = this.pos, prev = this.last;
    const f = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) { this.lp += a * (x[i] - this.lp); f[i] = this.lp; }
    while (pos < f.length) {
      const i = Math.floor(pos), t = pos - i;
      const s0 = i === 0 ? prev : f[i - 1], s1 = f[i];
      out.push(s0 + (s1 - s0) * t);
      pos += r;
    }
    this.pos = pos - f.length;
    this.last = f[f.length - 1] ?? prev;
    return Float32Array.from(out);
  }
}

export interface RelayStats { tx: number; rx: number; late: number; level: number; peak: number; rxPeak: number; codecOut: string; codecIn: string }

export class RelayAudio {
  stats: RelayStats = { tx: 0, rx: 0, late: 0, level: 0, peak: 0, rxPeak: 0, codecOut: '', codecIn: '' };
  muted = false;
  private ctx: AudioContext;
  private src?: MediaStreamAudioSourceNode;
  private proc?: ScriptProcessorNode;
  private sink?: GainNode;
  private out!: AudioNode;
  private el?: HTMLAudioElement;
  private enc?: any;
  private dec?: any;
  private rs?: Resampler;
  private pend = new Float32Array(0);
  private opusFrames: U8[] = [];
  private st = { p: 0, i: 0 };
  private seq = 0;
  private lastSeq = -1;
  private nextT = 0;
  private useOpus: boolean;
  private decTs = 0;
  private mutedN = 0;
  private jit = 0.2;
  private stopped = false;

  private thin = false;
  constructor(private send: (pkt: U8) => void, peerCodecs: string[], mine: string[], private isThin: () => boolean) {
    const ctx = ac();
    if (!ctx) throw new Error('noaudio');
    this.ctx = ctx;
    this.useOpus = mine.includes('o') && peerCodecs.includes('o');
    this.thin = isThin();
    this.stats.codecOut = this.useOpus ? 'opus' : 'adpcm';
  }

  async start(mic: MediaStream) {
    const ctx = this.ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    // playback: through an <audio> element when possible (lets the browser's echo canceller see it)
    const g = ctx.createGain();
    this.out = g;
    try {
      const dest = ctx.createMediaStreamDestination();
      g.connect(dest);
      const el = this.el = new Audio();
      el.srcObject = dest.stream;
      el.autoplay = true;
      await el.play();
    } catch {
      try { g.disconnect(); } catch { /* ignore */ }
      this.el = undefined;
      g.connect(ctx.destination);
    }
    // capture
    const rate = this.useOpus ? OPUS_RATE : ADPCM_RATE;
    this.rs = new Resampler(ctx.sampleRate, rate);
    if (this.useOpus) {
      const W = window as any;
      this.enc = new W.AudioEncoder({
        output: (chunk: any) => {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          this.opusFrames.push(b);
          if (this.opusFrames.length >= (this.thin ? PACK_THIN : PACK_FAST)) this.flushOpus();
        },
        error: () => { /* the next start of a call creates a new encoder */ },
      });
      this.cfg();
    }
    this.src = ctx.createMediaStreamSource(mic);
    this.proc = ctx.createScriptProcessor(2048, 1, 1);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.proc.onaudioprocess = e => this.capture(e.inputBuffer.getChannelData(0));
    this.src.connect(this.proc);
    this.proc.connect(this.sink).connect(ctx.destination);
  }

  private cfg() {
    try { this.enc.configure({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate: this.thin ? BR_THIN : BR_FAST, opus: { frameDuration: FRAME_MS * 1000, application: 'voip', signal: 'voice', usedtx: false } }); } catch { /* ignore */ }
  }
  /** Called once a second: follow the state of the relay (thin ↔ normal). */
  adapt() {
    const t = this.isThin();
    if (t === this.thin) return;
    this.thin = t;
    this.stats.codecOut = (this.useOpus ? 'opus' : 'adpcm') + (t ? '/thin' : '');
    if (this.useOpus && this.enc) this.cfg();
  }
  private capture(x: Float32Array) {
    if (this.stopped) return;
    let peak = 0;
    for (let i = 0; i < x.length; i += 8) peak = Math.max(peak, Math.abs(x[i]));
    this.stats.level = peak;
    if (peak > this.stats.peak) this.stats.peak = peak;
    if (this.muted) {       // muted: a tiny "still here" packet now and then, so the other side does not suspect a frozen line
      if (++this.mutedN % 10 === 0) this.send(new Uint8Array([0, 0, 0, 0]));
      return;
    }
    const y = this.rs!.run(x);
    const buf = new Float32Array(this.pend.length + y.length);
    buf.set(this.pend); buf.set(y, this.pend.length);
    const rate = this.useOpus ? OPUS_RATE : ADPCM_RATE;
    const per = (rate * FRAME_MS / 1000) * (this.useOpus ? 1 : ADPCM_PACK);
    let off = 0;
    for (; off + per <= buf.length; off += per) {
      const frame = buf.slice(off, off + per);
      if (this.useOpus) {
        const W = window as any;
        try {
          const ad = new W.AudioData({ format: 'f32', sampleRate: OPUS_RATE, numberOfFrames: per, numberOfChannels: 1, timestamp: this.seq * FRAME_MS * 1000, data: frame });
          this.enc.encode(ad);
          ad.close();
        } catch { /* encoder closed */ }
        this.seq++;
      } else this.sendPkt(2, adpcmEnc(frame, this.st));
    }
    this.pend = buf.slice(off);
  }
  private flushOpus() {
    const fs = this.opusFrames.splice(0);
    const parts: (U8 | number[])[] = [[fs.length]];
    for (const f of fs) parts.push([f.length >> 8, f.length & 255], f);
    this.sendPkt(1, concat(...parts));
  }
  private sendPkt(codec: number, body: U8) {
    const s = this.stats.tx++ & 0xffff;
    this.send(concat([codec, s >> 8, s & 255], body));
  }

  /** Incoming packet: [codec][seq u16][body]. */
  onPacket(u: U8) {
    if (this.stopped || u.length < 4) return;
    const codec = u[0], seq = (u[1] << 8) | u[2], body = u.subarray(3);
    if (codec === 0) return;
    if (this.lastSeq >= 0) {
      const d = (seq - this.lastSeq + 65536) % 65536;
      if (d === 0 || d > 32768) { this.stats.late++; return; }   // duplicate or too late
    }
    this.lastSeq = seq;
    this.stats.rx++;
    if (codec === 2) { this.stats.codecIn = 'adpcm'; this.play(adpcmDec(body), ADPCM_RATE); return; }
    if (codec !== 1) return;
    this.stats.codecIn = 'opus';
    if (!this.dec) {
      const W = window as any;
      if (!W.AudioDecoder) return;
      this.dec = new W.AudioDecoder({
        output: (ad: any) => {
          const n = ad.numberOfFrames, f = new Float32Array(n);
          try { ad.copyTo(f, { planeIndex: 0, format: 'f32-planar' }); } catch { try { ad.copyTo(f, { planeIndex: 0 }); } catch { /* ignore */ } }
          const rate = ad.sampleRate;
          ad.close();
          this.play(f, rate);
        },
        error: () => { this.dec = undefined; },
      });
      this.dec.configure({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1 });
    }
    let p = 1;
    const cnt = body[0];
    this.jit = cnt >= 8 || this.isThin() ? 0.5 : 0.2;   // thin relay: connections are swapped all the time, buffer more
    for (let k = 0; k < cnt && p + 2 <= body.length; k++) {
      const len = (body[p] << 8) | body[p + 1]; p += 2;
      const data = body.subarray(p, p + len); p += len;
      try {
        const W = window as any;
        this.dec?.decode(new W.EncodedAudioChunk({ type: 'key', timestamp: (this.decTs++) * FRAME_MS * 1000, data }));
      } catch { /* ignore */ }
    }
  }
  private play(pcm: Float32Array, rate: number) {
    if (!pcm.length || this.stopped) return;
    for (let i = 0; i < pcm.length; i += 4) { const v = Math.abs(pcm[i]); if (v > this.stats.rxPeak) this.stats.rxPeak = v; }
    const ctx = this.ctx, t0 = ctx.currentTime;
    if (this.nextT < t0 + 0.02 || this.nextT > t0 + this.jit + 1.2) this.nextT = t0 + this.jit;   // (re)start the jitter buffer
    const b = ctx.createBuffer(1, pcm.length, rate);
    b.getChannelData(0).set(pcm);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.out);
    s.start(this.nextT);
    this.nextT += pcm.length / rate;
  }

  /** Choose where the voice plays (speaker / earpiece / headset), where the browser allows it. */
  async setSink(id: string): Promise<boolean> {
    try {
      const el: any = this.el, cx: any = this.ctx;
      if (el?.setSinkId) { await el.setSinkId(id); return true; }
      if (cx.setSinkId) { await cx.setSinkId(id); return true; }
    } catch { /* ignore */ }
    return false;
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { this.proc && (this.proc.onaudioprocess = null); } catch { /* ignore */ }
    for (const n of [this.src, this.proc, this.sink, this.out]) { try { n?.disconnect(); } catch { /* ignore */ } }
    try { this.enc?.close(); } catch { /* ignore */ }
    try { this.dec?.close(); } catch { /* ignore */ }
    if (this.el) { this.el.pause(); this.el.srcObject = null; }
  }
}
