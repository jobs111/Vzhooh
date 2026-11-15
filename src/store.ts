// Local persistence: IndexedDB for rooms/messages/files (fast mode only), localStorage for settings.
export interface FileMeta { name: string; size: number; mime: string; tid: number; dur?: number; voice?: boolean }
export interface Msg { id: string; mine: boolean; ts: number; text?: string; file?: FileMeta; st: 0 | 1 | 2; sys?: string; arg?: string; del?: number }
export interface RoomRec {
  id: string; secret: string; role: 'h' | 'g'; mode: 'f' | 's'; name: string;
  created: number; exp: number; invExp: number; reusable: boolean;
  bound?: { g: string; rk: string };   // host: the guest device this room is bound to
  g?: string; rk?: string;             // guest: own slot id + resume key
  timer: number; unread: number; last: number;
  dead?: boolean; paused?: boolean; tmp?: boolean; pair?: boolean; relays?: string[];
  lobby?: string; sub?: string;        // guest: joined through a multi-device invite (lobby secret + own sub-id)
  lid?: string;                        // host: the lobby this room was opened from
  share?: boolean;                     // file-share room (temporary, both sides)
  call?: 'a' | 'v';                    // call room: the call starts by itself once the peer is here
  called?: boolean;                    // call room: the automatic call has already been made
}
/** Multi-device invite: one link/QR, every device that opens it gets its own private room.
 *  kind 'chat' → a normal chat per device; kind 'files' → the devices download the shared files. */
export interface LobbyRec {
  id: string; secret: string; kind: 'chat' | 'files'; name: string; mode: 'f' | 's';
  created: number; exp: number; invExp: number; life: number; n: number;
  files: (FileMeta & { mem?: boolean })[]; note?: string; dl: number; closed?: boolean;
}

let dbp: Promise<IDBDatabase | null> | null = null;
function open(): Promise<IDBDatabase | null> {
  return dbp ||= new Promise(res => {
    try {
      const rq = indexedDB.open('vzhooh', 2);
      rq.onupgradeneeded = () => {
        const d = rq.result, has = (n: string) => d.objectStoreNames.contains(n);
        if (!has('rooms')) d.createObjectStore('rooms', { keyPath: 'id' });
        if (!has('msgs')) d.createObjectStore('msgs', { keyPath: 'k' }).createIndex('room', 'room');
        if (!has('blobs')) d.createObjectStore('blobs', { keyPath: 'k' }).createIndex('room', 'room');
        if (!has('kv')) d.createObjectStore('kv');
        if (!has('lobbies')) d.createObjectStore('lobbies', { keyPath: 'id' });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = rq.onblocked = () => res(null);
    } catch { res(null); }
  });
}
async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await open();
  if (!d) return undefined;
  return new Promise(res => {
    try {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => res(r ? r.result : undefined);
      t.onerror = t.onabort = () => res(undefined);
    } catch { res(undefined); }
  });
}
export const db = {
  get: <T = any>(s: string, k: IDBValidKey) => tx<T>(s, 'readonly', o => o.get(k)),
  put: (s: string, v: any, k?: IDBValidKey) => tx(s, 'readwrite', o => { o.put(v, k); }),
  del: (s: string, k: IDBValidKey) => tx(s, 'readwrite', o => { o.delete(k); }),
  all: <T = any>(s: string) => tx<T[]>(s, 'readonly', o => o.getAll()),
  byRoom: <T = any>(s: string, room: string) => tx<T[]>(s, 'readonly', o => o.index('room').getAll(room)),
  delRoom: (s: string, room: string) => tx(s, 'readwrite', o => {
    const rq = o.index('room').openKeyCursor(IDBKeyRange.only(room));
    rq.onsuccess = () => { const c = rq.result; if (c) { o.delete(c.primaryKey); c.continue(); } };
  }),
};
export const conf = {
  get<T>(k: string, d: T): T {
    try { const v = localStorage.getItem('vz.' + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k: string, v: unknown) { try { localStorage.setItem('vz.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k: string) { try { localStorage.removeItem('vz.' + k); } catch { /* ignore */ } },
};
