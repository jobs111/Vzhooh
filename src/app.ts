// Application state: relay connections, rooms, lobbies (multi-device invites), owner key, settings.
import type { AdminCert, OwnerFile } from './crypto';
import { Invite, roomId } from './invite';
import { childSecret, Lobby, lobbyKeys } from './lobby';
import { Room } from './room';
import { DEFAULT_ICE } from './rtc';
import { stats } from './stats';
import { conf, db, FileMeta, LobbyRec, RoomRec } from './store';
import { b64, Emitter, now, rnd, U8, unb64 } from './util';
import { AntiFreeze, DEFAULT_BROKERS, Wire } from './wire';

declare const __VER__: string;
export const VERSION = __VER__;

class App extends Emitter {
  wire = new Wire();
  rooms = new Map<string, Room>();
  lobbies = new Map<string, Lobby>();
  owner: OwnerFile | null = null;
  ownerKey: CryptoKey | null = null;
  cert: AdminCert | null = null;   // set when this device is an admin by delegation (QR sign-in)
  active = '';
  noP2P = false;
  pairing?: Room;

  get isAdmin() { return !this.owner || !!this.ownerKey; }
  get myName() { return conf.get('nick', '') || 'Админ'; }
  get visibleRooms() {
    return [...this.rooms.values()].filter(r => !r.rec.dead && !r.rec.tmp && !r.rec.hid && !r.rec.fav)
      .sort((a, b) => (b.rec.last || b.rec.created) - (a.rec.last || a.rec.created));
  }
  get lobbyList() { return [...this.lobbies.values()].filter(l => l.rec.kind !== 'group').sort((a, b) => b.rec.created - a.rec.created); }

  async init() {
    this.noP2P = conf.get('nop2p', false);
    this.wire.antiFreeze = conf.get<AntiFreeze>('af', 'auto');
    try {
      const r = await fetch('./owner.json', { cache: 'no-cache' });
      if (r.ok) { const j = await r.json(); this.owner = j && j.v === 1 && j.pub ? j : null; conf.set('owner', this.owner); }
      else this.owner = conf.get<OwnerFile | null>('owner', null);
    } catch { this.owner = conf.get<OwnerFile | null>('owner', null); }
    if (this.owner) {
      const k = await db.get<{ key: CryptoKey; pub: string; cert?: AdminCert }>('kv', 'ownerKey');
      const ok = k && k.pub === this.owner.pub && (!k.cert || k.cert.exp > now());
      this.ownerKey = ok ? k.key : null;
      this.cert = ok && k.cert ? k.cert : null;
    }
    for (const rec of (await db.all<RoomRec>('rooms')) || []) {
      if (rec.exp && now() > rec.exp) { this.purge(rec.id); continue; }
      const r = new Room(rec);
      this.rooms.set(rec.id, r);
      await r.load();
      if (!rec.paused) r.start();
    }
    for (const rec of (await db.all<LobbyRec>('lobbies')) || []) {
      const l = new Lobby(rec);
      if (rec.kind === 'files' && rec.exp && now() > rec.exp) { await l.remove(); continue; }
      this.lobbies.set(rec.id, l);
      await l.load();
      if (l.open) await l.start();
    }
    this.wire.on('change', () => this.emit('net'));
    let upT: any;
    this.wire.on('up', () => { clearTimeout(upT); upT = setTimeout(() => { for (const r of this.rooms.values()) r.wireUp(); }, 250); });
    this.wire.start(this.brokers());
    setInterval(() => this.tick(), 1000);
    addEventListener('online', () => this.kick());
    addEventListener('offline', () => this.emit('net'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); });
    addEventListener('pagehide', () => { for (const r of this.rooms.values()) r.bye(r.rec.mode === 's' || !!r.rec.share); });
  }
  brokers(): string[] { const c = conf.get<string[]>('brokers', []); return c.length ? c : DEFAULT_BROKERS; }
  customIce(): RTCIceServer[] | null { const c = conf.get<RTCIceServer[] | null>('ice', null); return Array.isArray(c) ? c : null; }
  ice(): RTCIceServer[] { return this.customIce() || DEFAULT_ICE; }
  private customRelays() { const c = conf.get<string[]>('brokers', []); return c.length ? c : undefined; }

  /** Create (or return the existing) room for a secret. */
  async make(secret: U8, part: Partial<RoomRec> & Pick<RoomRec, 'role' | 'mode'>): Promise<Room> {
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
  /** A room without a peer of its own (group hub, Favourites). */
  local(part: Partial<RoomRec> & { id: string }): Room {
    const old = this.rooms.get(part.id);
    if (old) return old;
    const rec: RoomRec = { secret: b64(rnd(16)), role: 'h', mode: 'f', name: '', created: now(), exp: 0, invExp: 0, reusable: false, timer: 0, unread: 0, last: 0, ...part };
    const r = new Room(rec);
    this.rooms.set(rec.id, r);
    r.save(); r.start();
    this.emit('rooms');
    return r;
  }
  get fav(): Room { return this.local({ id: 'fav', fav: true }); }
  /** Owner: create a 1:1 room and its invite. */
  createRoom(o: { name: string; secure: boolean; life: number; invTtl: number; call?: 'a' | 'v' }): Promise<Room> {
    return this.make(rnd(16), {
      role: 'h', mode: o.secure ? 's' : 'f', name: o.name, call: o.call,
      exp: o.secure ? 0 : now() + o.life, invExp: o.invTtl ? now() + o.invTtl : 0,
    });
  }
  invite(r: Room): Invite {
    return { secure: r.rec.mode === 's', reusable: r.rec.reusable, secret: unb64(r.rec.secret), exp: r.rec.invExp ? Math.floor(r.rec.invExp / 1000) : 0, relays: this.customRelays() };
  }
  /** Guest: join by a 1:1 invite. */
  async join(inv: Invite): Promise<Room> {
    for (const u of inv.relays || []) this.wire.add(u);
    return this.make(inv.secret, { role: 'g', mode: inv.secure ? 's' : 'f', g: b64(rnd(8)), relays: inv.relays, invExp: inv.exp * 1000 });
  }

  // ---------- lobbies (multi-device invites) ----------
  async createLobby(o: { kind: 'chat' | 'files' | 'group'; name: string; secure: boolean; life: number; invTtl: number; files?: File[]; note?: string }): Promise<Lobby> {
    const secret = rnd(16), { id } = await lobbyKeys(secret), t = now();
    const files = o.kind === 'files';
    const rec: LobbyRec = {
      id, secret: b64(secret), kind: o.kind, name: o.name, mode: o.secure && !files ? 's' : 'f', created: t,
      exp: files || o.kind === 'group' ? t + o.life : 0, invExp: files || o.kind === 'group' ? t + o.life : (o.invTtl ? t + o.invTtl : 0),
      life: files ? 0 : o.life, n: 0, files: [], note: o.note || undefined, dl: 0,
    };
    const l = new Lobby(rec);
    for (const f of o.files || []) {
      const meta: FileMeta = { name: (f.name || 'file').slice(0, 200), size: f.size, mime: f.type || 'application/octet-stream', tid: new DataView(rnd(4).buffer).getUint32(0) };
      await l.addFile(meta, f);
    }
    this.lobbies.set(id, l);
    if (o.kind === 'group') this.local({ id: 'hub-' + id, hub: id, name: o.name, mode: rec.mode, exp: rec.exp });
    l.save();
    await l.start();
    this.emit('lobbies');
    return l;
  }
  lobbyInvite(l: Lobby): Invite {
    const r = l.rec, until = r.invExp || r.exp;
    return { secure: r.mode === 's', reusable: true, lobby: true, files: r.kind === 'files', secret: unb64(r.secret), exp: until ? Math.floor(until / 1000) : 0, relays: this.customRelays() };
  }
  async removeLobby(l: Lobby) { this.lobbies.delete(l.rec.id); await l.remove(); this.emit('lobbies'); this.emit('rooms'); }
  /** Guest: join by a multi-device invite. A chat invite remembers this device's id, so reopening it returns to the same chat. */
  async joinLobby(inv: Invite): Promise<Room> {
    for (const u of inv.relays || []) this.wire.add(u);
    const { id } = await lobbyKeys(inv.secret), key = 'lsub.' + id;
    const saved = inv.files ? '' : conf.get<string>(key, '');
    const sub = saved ? unb64(saved) : rnd(16);
    if (!inv.files) conf.set(key, b64(sub));
    return this.make(await childSecret(inv.secret, sub), {
      role: 'g', mode: inv.secure ? 's' : 'f', g: b64(rnd(8)), relays: inv.relays, invExp: inv.exp * 1000,
      lobby: b64(inv.secret), sub: b64(sub), tmp: inv.files || undefined, share: inv.files || undefined,
    });
  }

  // ---------- pairing a device by QR ----------
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

  // ---------- introduce two friends to each other ----------
  get intros(): { id: string; a: string; b: string; an: string; bn: string; ts: number; exp: number }[] {
    return conf.get<any[]>('intros', []).filter(x => x.exp > now());
  }
  async introduce(a: Room, b: Room): Promise<void> {
    const secret = rnd(16), id = await roomId(secret), exp = now() + 48 * 3600e3;
    const an = a.rec.name || 'A', bn = b.rec.name || 'B';
    a.sendR({ t: 'in', s: b64(secret), r: 'h', nm: bn, ix: exp });
    b.sendR({ t: 'in', s: b64(secret), r: 'g', nm: an, ix: exp });
    conf.set('intros', [...this.intros, { id, a: a.rec.id, b: b.rec.id, an, bn, ts: now(), exp }]);
    this.emit('rooms');
  }
  endIntro(id: string) {
    const x = this.intros.find(i => i.id === id);
    if (!x) return;
    for (const rid of [x.a, x.b]) this.rooms.get(rid)?.sendR({ t: 'iz', id });
    conf.set('intros', this.intros.filter(i => i.id !== id));
    this.emit('rooms');
  }
  /** Friend side: the owner opened a chat between me and another friend. */
  async introIn(o: any, by: Room) {
    if (typeof o.s !== 'string' || !(+o.ix > now())) return;
    const role = o.r === 'h' ? 'h' : 'g';
    const r = await this.make(unb64(o.s), { role, mode: 'f', name: String(o.nm || '').slice(0, 40), exp: +o.ix, g: role === 'g' ? b64(rnd(8)) : undefined, intro: { exp: +o.ix, by: by.rec.id } });
    by.sysMsg('intro', r.rec.name);
  }
  introEnd(id: string, by: Room) {
    const r = this.rooms.get(id);
    if (r && r.rec.intro && r.rec.intro.by === by.rec.id) { r.stop(); this.removeRoom(r); void db.delRoom('msgs', id); }
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
    stats.max('peakOnline', [...this.rooms.values()].filter(r => !r.local && r.online).length);
    for (const r of [...this.rooms.values()]) {
      if (r.rec.exp && t > r.rec.exp) r.expire(); else r.tick(t);
    }
    for (const l of [...this.lobbies.values()]) {
      if (l.rec.kind !== 'chat' && l.rec.exp && t > l.rec.exp) void this.removeLobby(l);
    }
  }
  kick() { this.wire.kick(); for (const r of this.rooms.values()) r.kick(); }
  notify(r: Room, call = false) { this.emit('notify', r, call); this.emit('rooms'); }

  async setOwnerKey(key: CryptoKey | null, remember: boolean, cert: AdminCert | null = null) {
    this.ownerKey = key;
    this.cert = key ? cert : null;
    if (key && remember && this.owner) await db.put('kv', { key, pub: this.owner.pub, cert: cert || undefined }, 'ownerKey'); else await db.del('kv', 'ownerKey');
    if (key) for (const l of this.lobbies.values()) if (l.open) await l.start();
    this.emit('rooms');
  }
}
export const app = new App();
