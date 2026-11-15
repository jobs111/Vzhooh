// WebRTC: one peer connection per session. Data channel for chat/files, media tracks for calls.
// Media and data are end-to-end encrypted by DTLS; its fingerprints travel inside the encrypted session.
import type { Room } from './room';
import { conf } from './store';
import { U8 } from './util';

export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: 'stun:stun.rtc.yandex.net:3478' },
  { urls: 'stun:stun.nextcloud.com:3478' },
  { urls: 'stun:stun.telnyx.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];
const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
export const lowData = () => conf.get('low', false) || ['slow-2g', '2g', '3g'].includes((navigator as any).connection?.effectiveType);
const videoC = (facing: string): MediaTrackConstraints => lowData()
  ? { facingMode: { ideal: facing }, width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } }
  : { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };

export class Rtc {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  dcReady = false;
  everUp = false;
  chunk = 16000;
  local?: MediaStream;
  facing = 'user';
  private making = false;
  private ignore = false;
  private gotRemote = false;
  private pendC: RTCIceCandidateInit[] = [];
  private cq: RTCIceCandidateInit[] = [];
  private ct: any;
  private failT: any;
  private leftT: any;
  private q = 0;
  private lastQ = -1;
  closed = false;

  constructor(private room: Room, private polite: boolean, ice: RTCIceServer[], public gen: number) {
    const pc = this.pc = new RTCPeerConnection({ iceServers: ice });
    pc.onicecandidate = e => {
      if (!e.candidate || !e.candidate.candidate) return;
      this.cq.push(e.candidate.toJSON());
      clearTimeout(this.ct);
      this.ct = setTimeout(() => { if (!this.closed) room.sendR({ t: 'ic', g: this.gen, c: this.cq.splice(0) }); }, 120);
    };
    pc.onnegotiationneeded = () => void this.negotiate();
    pc.onconnectionstatechange = () => this.onConn();
    pc.ontrack = () => room.emit('media');
    const dc = this.dc = pc.createDataChannel('vz', { negotiated: true, id: 0 });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1 << 20;
    dc.onopen = () => {
      if (this.closed) return;
      this.dcReady = true; this.everUp = true;
      const mm = (pc as any).sctp?.maxMessageSize;
      this.chunk = Math.max(8000, Math.min(65536, mm || 16384) - 16);
      room.rtcOk();
      room.linkChanged();
    };
    dc.onclose = () => { if (this.closed) return; this.dcReady = false; room.linkChanged(); room.rtcFailed(); };
    dc.onmessage = e => { if (!this.closed) room.onDc(e.data); };
  }

  private async negotiate() {
    if (this.closed || (this.polite && !this.gotRemote)) return;
    try {
      this.making = true;
      await this.pc.setLocalDescription();
      this.sendSd();
    } catch (e) { console.warn('negotiate', e); } finally { this.making = false; }
  }
  private sendSd() {
    const d = this.pc.localDescription;
    if (d && !this.closed) this.room.sendR({ t: 'sd', g: this.gen, q: this.q++, d: { type: d.type, sdp: d.sdp } }, 'sd');
  }
  async onSd(d: RTCSessionDescriptionInit, q: number) {
    if (this.closed || !d || !(q > this.lastQ)) return;
    this.lastQ = q;
    const pc = this.pc;
    try {
      const collision = d.type === 'offer' && (this.making || pc.signalingState !== 'stable');
      this.ignore = !this.polite && collision;
      if (this.ignore) return;
      await pc.setRemoteDescription(d);
      this.gotRemote = true;
      for (const c of this.pendC.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (d.type === 'offer') {
        await this.attach(false);
        await pc.setLocalDescription();
        this.sendSd();
        this.leftovers();
      }
    } catch (e) { console.warn('sd', e); }
  }
  async onIce(cs: RTCIceCandidateInit[]) {
    if (this.closed || !Array.isArray(cs)) return;
    for (const c of cs) {
      if (!this.pc.remoteDescription) this.pendC.push(c);
      else await this.pc.addIceCandidate(c).catch(e => { if (!this.ignore) console.warn('ice', e); });
    }
  }
  private onConn() {
    if (this.closed) return;
    const s = this.pc.connectionState;
    clearTimeout(this.failT);
    if (s === 'connected') this.room.rtcOk();
    else if (s === 'failed') this.room.rtcFailed();
    else if (s === 'disconnected') this.failT = setTimeout(() => { if (!this.closed && this.pc.connectionState !== 'connected') this.room.rtcFailed(); }, 6000);
    this.room.linkChanged();
  }
  /** The channel went silent: stop using it until the peer is heard again. */
  stale() { if (this.dcReady) { this.dcReady = false; this.room.linkChanged(); this.room.rtcFailed(); } }

  dcSend(s: string): boolean {
    if (!this.dcReady || this.dc.readyState !== 'open') return false;
    try { this.dc.send(s); return true; } catch { return false; }
  }
  async dcSendBin(u: U8): Promise<boolean> {
    const dc = this.dc;
    if (dc.readyState !== 'open') return false;
    if (dc.bufferedAmount > 8 << 20) {
      await new Promise<void>(res => {
        const done = () => { dc.removeEventListener('bufferedamountlow', done); clearInterval(t); res(); };
        const t = setInterval(() => { if (dc.readyState !== 'open' || dc.bufferedAmount <= 1 << 20) done(); }, 400);
        dc.addEventListener('bufferedamountlow', done);
      });
      if (dc.readyState !== 'open') return false;
    }
    try { dc.send(u as unknown as ArrayBuffer); return true; } catch { return false; }
  }

  // ---- media (calls) ----
  async getMedia(video: boolean) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('nomedia');
    this.local = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: video ? videoC(this.facing) : false });
  }
  /** Put local tracks into free transceivers; with addNew, create transceivers for the rest (triggers negotiation). */
  async attach(addNew: boolean) {
    const s = this.local;
    if (!s || this.closed) return;
    const pc = this.pc;
    for (const tr of s.getTracks()) {
      if (pc.getSenders().some(x => x.track === tr)) continue;
      const free = pc.getTransceivers().find(t => !t.sender.track && t.receiver.track?.kind === tr.kind && t.currentDirection !== 'stopped');
      if (free) {
        free.direction = 'sendrecv';
        await free.sender.replaceTrack(tr);
        try { (free.sender as any).setStreams?.(s); } catch { /* ignore */ }
      } else if (addNew) pc.addTransceiver(tr, { direction: 'sendrecv', streams: [s] });
    }
    this.tune();
  }
  leftovers() { clearTimeout(this.leftT); this.leftT = setTimeout(() => void this.attach(true), 1500); }
  private tune() {
    const low = lowData();
    for (const s of this.pc.getSenders()) {
      if (!s.track) continue;
      try {
        const p = s.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        p.encodings[0].maxBitrate = s.track.kind === 'audio' ? (low ? 16000 : 40000) : (low ? 220000 : 900000);
        void s.setParameters(p).catch(() => {});
      } catch { /* ignore */ }
    }
  }
  stopMedia() {
    clearTimeout(this.leftT);
    const s = this.local;
    this.local = undefined;
    if (!s) return;
    const tracks = s.getTracks();
    if (!this.closed) for (const x of this.pc.getSenders()) if (x.track && tracks.includes(x.track)) void x.replaceTrack(null).catch(() => {});
    tracks.forEach(t => t.stop());
  }
  remote(): MediaStream {
    return new MediaStream(this.pc.getReceivers().map(r => r.track).filter(t => t && t.readyState === 'live'));
  }
  toggleMic(): boolean {
    const t = this.local?.getAudioTracks()[0];
    if (t) t.enabled = !t.enabled;
    return !!t?.enabled;
  }
  async setCam(on: boolean): Promise<boolean> {
    const s = this.local;
    if (!s) return false;
    const old = s.getVideoTracks()[0];
    if (!on) {
      if (old) {
        const x = this.pc.getSenders().find(q => q.track === old);
        await x?.replaceTrack(null).catch(() => {});
        old.stop(); s.removeTrack(old);
      }
      return false;
    }
    if (old) return true;
    const v = (await navigator.mediaDevices.getUserMedia({ video: videoC(this.facing) })).getVideoTracks()[0];
    s.addTrack(v);
    await this.attach(true);
    return true;
  }
  async switchCam() {
    const s = this.local, old = s?.getVideoTracks()[0];
    if (!s || !old) return;
    this.facing = this.facing === 'user' ? 'environment' : 'user';
    const x = this.pc.getSenders().find(q => q.track === old);
    old.stop(); s.removeTrack(old);
    const v = (await navigator.mediaDevices.getUserMedia({ video: videoC(this.facing) })).getVideoTracks()[0];
    s.addTrack(v);
    if (x) await x.replaceTrack(v); else await this.attach(true);
  }

  /** Replace (or add / remove) the outgoing video track. */
  private async putVideo(tr: MediaStreamTrack | null) {
    const s = this.local;
    if (!s || this.closed) { tr?.stop(); return; }
    const old = s.getVideoTracks()[0];
    const x = old ? this.pc.getSenders().find(q => q.track === old) : undefined;
    if (old) { old.stop(); s.removeTrack(old); }
    if (tr) s.addTrack(tr);
    if (x) await x.replaceTrack(tr);
    else if (tr) await this.attach(true);
    this.tune();
  }
  /** Screen sharing (desktop browsers). onEnd fires when the user stops it from the browser's own bar. */
  async startScreen(onEnd: () => void) {
    const md: any = navigator.mediaDevices;
    if (!md?.getDisplayMedia) throw new Error('noscreen');
    const ds: MediaStream = await md.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    const tr = ds.getVideoTracks()[0];
    try { (tr as any).contentHint = 'detail'; } catch { /* ignore */ }
    tr.addEventListener('ended', onEnd, { once: true });
    await this.putVideo(tr);
  }
  async stopScreen(backToCam: boolean) {
    let cam: MediaStreamTrack | null = null;
    if (backToCam) { try { cam = (await navigator.mediaDevices.getUserMedia({ video: videoC(this.facing) })).getVideoTracks()[0]; } catch { cam = null; } }
    await this.putVideo(cam);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.ct); clearTimeout(this.failT);
    this.stopMedia();
    this.dcReady = false;
    try { this.dc.close(); } catch { /* ignore */ }
    try { this.pc.close(); } catch { /* ignore */ }
  }
}
