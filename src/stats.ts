// Usage statistics, kept only on this device (no content, no names): counters per day.
import { db } from './store';

type Day = Record<string, number>;
const KEY = 'stats';
let data: Record<string, Day> = {};
let loaded: Promise<void> | null = null;
let dirty: any = null;
const today = () => new Date().toISOString().slice(0, 10);

export const stats = {
  load(): Promise<void> {
    return loaded ||= (async () => { data = (await db.get<Record<string, Day>>('kv', KEY)) || {}; })();
  },
  /** Add n to a counter for today. */
  add(k: string, n = 1) {
    void this.load().then(() => {
      const d = data[today()] ||= {};
      d[k] = (d[k] || 0) + n;
      clearTimeout(dirty);
      dirty = setTimeout(() => void db.put('kv', data, KEY), 1500);
    });
  },
  /** Keep the maximum seen value for today (e.g. peak online). */
  max(k: string, v: number) {
    void this.load().then(() => {
      const d = data[today()] ||= {};
      if ((d[k] || 0) < v) { d[k] = v; clearTimeout(dirty); dirty = setTimeout(() => void db.put('kv', data, KEY), 1500); }
    });
  },
  async sum(days: number): Promise<Day> {
    await this.load();
    const out: Day = {}, from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
    for (const [day, d] of Object.entries(data)) {
      if (days && day < from) continue;
      for (const [k, v] of Object.entries(d)) out[k] = k.startsWith('peak') ? Math.max(out[k] || 0, v) : (out[k] || 0) + v;
    }
    return out;
  },
  async all() { await this.load(); return data; },
  async clear() { data = {}; await db.del('kv', KEY); },
};
