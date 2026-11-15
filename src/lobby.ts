// Lobby = a multi-device invite. One link/QR; every device that opens it asks (through the relay)
// for its own private room. The room secret is derived from the lobby secret and a random id the
// device picked, so only the owner (who knows the lobby secret) can open that room.
//   kind 'chat'  → each device gets a normal 1:1 chat with the owner ("connect 100 computers with one QR")
//   kind 'files' → each device gets a temporary room through which it downloads the shared files
import { app } from './app';
import { aesKey, hkdf, seal, unseal } from './crypto';
import { t } from './i18n';
import { roomId } from './invite';
import type { Room } from './room';
import { db, FileMeta, LobbyRec } from './store';
import { b64, concat, Emitter, now, td, te, U8, unb64 } from './util';

export const LOBBY_MAX_LIVE = 40;               // files: at most this many devices at the same time
export const LOBBY_MAX_CHATS = 500;             // chat: at most this many devices per shared invite
export const LOBBY_PERSIST_MAX = 1536 * 1024 * 1024; // bigger shared files live only while the page is open
const AAD = new Uint8Array([9]);

export const lobbyTopic = (id: string) => `vz/${id}/s`;
export const childSecret = (lobbySecret: U8, sub: U8) => hkdf(lobbySecret, sub, 'vz1/child', 16);
const keys = new Map<string, Promise<{ id: string; k: CryptoKey }>>();
export function lobbyKeys(secret: U8) {
  const s = b64(secret);
  let p = keys.get(s);
  if (!p) keys.set(s, p = (async () => ({ id: await roomId(secret), k: await aesKey(await hkdf(secret, null, 'vz1/wire', 32)) }))());
  return p;
}
/** Guest → lobby: "please open a private room for me". Repeated by the guest until the room answers. */
export async function sendJoin(lobbySecret: U8, sub: U8) {
  const { id, k } = await lobbyKeys(lobbySecret);
  app.wire.pub(lobbyTopic(id), await seal(k, te.encode(JSON.stringify({ t: 'sj', s: b64(sub) })), AAD));
}

export class Lobby extends Emitter {
  blobs = new Map<number, Blob>();
  private k?: CryptoKey;
  private seen = new Set<string>();
  private counted = new Set<string>();
  private busy = new Set<string>();

  constructor(public rec: LobbyRec) { super(); }
  get secret() { return unb64(this.rec.secret); }
  get open() { const r = this.rec, n = now(); return !r.closed && !(r.invExp && n > r.invExp) && !(r.exp && n > r.exp); }
  children(): Room[] { return [...app.rooms.values()].filter(r => r.rec.lid === this.rec.id); }
  save() { void db.put('lobbies', this.rec); }

  async load() {
    for (const f of this.rec.files) {
      if (this.blobs.has(f.tid)) continue;
      const row = await db.get<{ blob: Blob }>('blobs', 'L|' + this.rec.id + '|' + f.tid);
      if (row?.blob) this.blobs.set(f.tid, row.blob);
    }
  }
  async start() {
    this.k = (await lobbyKeys(this.secret)).k;
    app.wire.sub(lobbyTopic(this.rec.id), p => void this.onFrame(p));
  }
  stop() { app.wire.unsub(lobbyTopic(this.rec.id)); }

  async addFile(meta: FileMeta, blob: Blob) {
    const big = blob.size > LOBBY_PERSIST_MAX;
    this.rec.files.push(big ? { ...meta, mem: true } : meta);
    this.blobs.set(meta.tid, blob);
    if (!big) await db.put('blobs', { k: 'L|' + this.rec.id + '|' + meta.tid, room: this.rec.id, blob });
  }

  private async onFrame(p: U8) {
    if (!this.k || p.length < 28) return;
    const key = b64(p.subarray(0, 12));
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 3000) this.seen.clear();
    const pt = await unseal(this.k, p, AAD);
    if (!pt) return;
    let o: any;
    try { o = JSON.parse(td.decode(pt)); } catch { return; }
    if (o?.t !== 'sj' || typeof o.s !== 'string') return;
    const sub = unb64(o.s);
    if (sub.length === 16) await this.onJoin(sub);
  }

  private async onJoin(sub: U8) {
    const subKey = b64(sub);
    if (this.busy.has(subKey)) return;
    this.busy.add(subKey);
    try {
      const cs = await childSecret(this.secret, sub);
      const cid = await roomId(cs);
      const have = app.rooms.get(cid);
      if (have) { have.wireUp(); return; }
      if (app.owner && !app.ownerKey) return;   // this device cannot prove it belongs to the owner
      const r = this.rec;
      let code = '';
      if (r.closed) code = 'rev';
      else if ((r.invExp && now() > r.invExp) || (r.exp && now() > r.exp)) code = 'exp';
      else if (this.children().length >= (r.kind === 'files' ? LOBBY_MAX_LIVE : LOBBY_MAX_CHATS)) code = 'full';
      if (code) { await this.nack(cs, cid, code); return; }
      if (r.kind === 'chat') {
        r.n++;
        this.save();
        await app.make(cs, { role: 'h', mode: r.mode, name: (r.name || t('device')) + ' ' + r.n, exp: r.mode === 'f' && r.life ? now() + r.life : 0, lid: r.id });
      } else {
        await app.make(cs, { role: 'h', mode: 'f', tmp: true, share: true, name: r.name, exp: r.exp, lid: r.id });
      }
      app.emit('lobbies');
    } finally { this.busy.delete(subKey); }
  }
  /** Tell a device that this invite no longer works (sent to the device's own room topic). */
  private async nack(cs: U8, cid: string, code: string) {
    const k = await aesKey(await hkdf(cs, null, 'vz1/wire', 32));
    const pt = concat([0], te.encode(JSON.stringify({ t: 'no', c: code, L: 1 })));
    app.wire.pub(`vz/${cid}/g`, concat([0], await seal(k, pt, new Uint8Array([0, 0]))));
  }

  /** A device's file-share room is connected: send it the files (once per room). */
  serve(room: Room) {
    if ((room as any).served) return;
    (room as any).served = true;
    if (this.rec.note) room.sendText(this.rec.note);
    for (const f of this.rec.files) {
      const b = this.blobs.get(f.tid);
      if (b) room.offerFile({ name: f.name, size: f.size, mime: f.mime, tid: f.tid }, b);
    }
    room.on('file', (tid: number) => {
      const o = room.xfer.out.get(tid), key = room.rec.id + '|' + tid;
      if (o && o.sent >= o.blob.size && !this.counted.has(key)) {
        this.counted.add(key);
        this.rec.dl++;
        this.save();
        app.emit('lobbies');
      }
    });
  }

  /** Delete the lobby. File-share rooms go with it; chats opened through it stay. */
  async remove() {
    this.stop();
    this.rec.closed = true;
    for (const r of this.children()) {
      if (r.rec.share) { r.bye(true); r.stop(); app.removeRoom(r); } else { r.rec.lid = undefined; r.save(); }
    }
    this.blobs.clear();
    await db.del('lobbies', this.rec.id);
    await db.delRoom('blobs', this.rec.id);
  }
}
