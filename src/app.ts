// Application state: relay connections, rooms, owner key, settings.
import type { OwnerFile } from './crypto';
import { Invite, roomId } from './invite';
import { Room } from './room';
import { DEFAULT_ICE } from './rtc';
import { conf, db, RoomRec } from './store';
import { b64, Emitter, now, rnd, unb64 } from './util';
import { AntiFreeze, DEFAULT_BROKERS, Wire } from './wire';

declare const __VER__: string;
export const VERSION = __VER__;

class App extends Emitter {
  wire = new Wire();
  rooms = new Map<string, Room>();
  owner: OwnerFile | null = null;
  ownerKey: CryptoKey | null = null;
  active = '';
  noP2P = false;
  pairing?: Room;

  get isAdmin() { return !this.owner || !!this.ownerKey; }
  get visibleRooms() { return [...this.rooms.values()].filter(r => !r.rec.dead && !r.rec.tmp).sort((a, b) => (b.rec.last || b.rec.created) - (a.rec.last || a.rec.created)); }

  async init() {
    this.noP2P = conf.get('nop2p', false);
    this.wire.antiFreeze = conf.get<AntiFreeze>('af', 'auto');
    try {
      const r = await fetch('./owner.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); this.owner = j && j.v === 1 && j.pub ? j : null; conf.set('owner', this.owner); }
      else this.owner = conf.get<OwnerFile | null>('owner', null);
    } catch { this.owner = conf.get<OwnerFile | null>('owner', null); }
    if (this.owner) {
      const k = await db.get<{ key: CryptoKey; pub: string }>('kv', 'ownerKey');
      this.ownerKey = k && k.pub === this.owner.pub ? k.key : null;
    }
    for (const rec of (await db.all<RoomRec>('rooms')) || []) {
      const r = new Room(rec);
      if (rec.exp && now() > rec.exp) { this.purge(rec.id); continue; }
      this.rooms.set(rec.id, r);
      await r.load();
      if (!rec.paused) r.start();
    }
    this.wire.on('change', () => this.emit('net'));
    let upT: any;
    this.wire.on('up', () => { clearTimeout(upT); upT = setTimeout(() => { for (const r of this.rooms.values()) r.wireUp(); }, 250); });
    this.wire.start(this.brokers());
    setInterval(() => this.tick(), 1000);
    addEventListener('online', () => this.kick());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); });
    addEventListener('pagehide', () => { for (const r of this.rooms.values()) r.bye(r.rec.mode === 's'); });
  }
  brokers(): string[] { const c = conf.get<string[]>('brokers', []); return c.length ? c : DEFAULT_BROKERS; }
  customIce(): RTCIceServer[] | null { const c = conf.get<RTCIceServer[] | null>('ice', null); return Array.isArray(c) ? c : null; }
  ice(): RTCIceServer[] { return this.customIce() || DEFAULT_ICE; }

  private async make(secret: Uint8Array, part: Partial<RoomRec> & Pick<RoomRec, 'role' | 'mode'>): Promise<Room> {
    const id = await roomId(secret);
    const old = this.rooms.get(id);
    if (old) return old;
    const rec: RoomRec = { id, secret: b64(secret), name: '', created: now(), exp: 0, invExp: 0, reusable: false, timer: 0, unread: 0, last: 0, ...part };
    const r = new Room(rec);
    this.rooms.set(id, r);
    r.save();
    r.start();
    this.emit('rooms');
    return r;
  }
  /** Owner: create a room and its invite. */
  createRoom(o: { name: string; secure: boolean; life: number; invTtl: number; reusable: boolean }): Promise<Room> {
    return this.make(rnd(16), {
      role: 'h', mode: o.secure ? 's' : 'f', name: o.name, reusable: o.reusable,
      exp: o.secure ? 0 : now() + o.life, invExp: o.invTtl ? now() + o.invTtl : 0,
    });
  }
  invite(r: Room): Invite {
    const custom = conf.get<string[]>('brokers', []);
    return { secure: r.rec.mode === 's', reusable: r.rec.reusable, secret: unb64(r.rec.secret),
      exp: r.rec.invExp ? Math.floor(r.rec.invExp / 1000) : 0, relays: custom.length ? custom : undefined };
  }
  /** Guest: join by invite. */
  async join(inv: Invite): Promise<Room> {
    for (const u of inv.relays || []) this.wire.add(u);
    return this.make(inv.secret, { role: 'g', mode: inv.secure ? 's' : 'f', g: b64(rnd(8)), relays: inv.relays, invExp: inv.exp * 1000 });
  }
  /** Any device: show a pairing QR and wait for the owner to scan it. */
  async pairStart(): Promise<{ room: Room; inv: Invite }> {
    if (this.pairing) { this.pairing.stop(); this.rooms.delete(this.pairing.rec.id); }
    const inv: Invite = { secure: false, reusable: false, secret: rnd(16), exp: 0 };
    const room = this.pairing = await this.make(inv.secret, { role: 'g', mode: 'f', g: b64(rnd(8)), tmp: true, pair: true });
    return { room, inv };
  }
  pairStop() { const p = this.pairing; if (p && p.rec.tmp) { p.stop(); this.rooms.delete(p.rec.id); } this.pairing = undefined; }
  pairDone(r: Room) { if (this.pairing === r) this.pairing = undefined; this.emit('rooms'); this.emit('paired', r); }
  /** Owner: accept a device that shows a pairing QR. */
  pairClaim(inv: Invite, secure: boolean, name: string, life: number): Promise<Room> {
    return this.make(inv.secret, { role: 'h', mode: secure ? 's' : 'f', name, pair: true, exp: secure ? 0 : now() + life, invExp: now() + 15 * 60e3 });
  }
  private purge(id: string) { void db.del('rooms', id); void db.delRoom('msgs', id); void db.delRoom('blobs', id); }
  removeRoom(r: Room) {
    r.gone = true;
    this.rooms.delete(r.rec.id);
    this.purge(r.rec.id);
    if (this.active === r.rec.id) this.active = '';
    this.emit('rooms');
  }
  private tick() {
    const t = now();
    for (const r of [...this.rooms.values()]) {
      if (r.rec.exp && t > r.rec.exp) r.expire(); else r.tick(t);
    }
  }
  kick() { this.wire.kick(); for (const r of this.rooms.values()) r.kick(); }
  notify(r: Room, call = false) { this.emit('notify', r, call); this.emit('rooms'); }

  async setOwnerKey(key: CryptoKey | null, remember: boolean) {
    this.ownerKey = key;
    if (key && remember && this.owner) await db.put('kv', { key, pub: this.owner.pub }, 'ownerKey'); else await db.del('kv', 'ownerKey');
    this.emit('rooms');
  }
}
export const app = new App();
