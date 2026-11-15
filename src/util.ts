export const te = new TextEncoder();
export const td = new TextDecoder();
export type U8 = Uint8Array;
export const now = () => Date.now();
export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** WebCrypto wants BufferSource; TS 5.9 typed arrays are generic over the buffer type. */
export const bs = (u: U8) => u as unknown as BufferSource;

export function b64(u: U8): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64(s: string): U8 {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const b = atob(s), u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
export function concat(...a: (U8 | number[])[]): U8 {
  let n = 0;
  for (const x of a) n += x.length;
  const o = new Uint8Array(n);
  let p = 0;
  for (const x of a) { o.set(x, p); p += x.length; }
  return o;
}
export const rnd = (n: number): U8 => crypto.getRandomValues(new Uint8Array(n));
export function eq(a: U8, b: U8): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export class Emitter {
  private m = new Map<string, Set<(...a: any[]) => void>>();
  on(ev: string, fn: (...a: any[]) => void): () => void {
    let s = this.m.get(ev);
    if (!s) this.m.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(ev: string, ...a: any[]) {
    const s = this.m.get(ev);
    if (s) for (const fn of [...s]) { try { fn(...a); } catch (e) { console.error(e); } }
  }
}

export type Child = Node | string | number | null | undefined | false | Child[];
/** Tiny DOM builder: h('div.cls#id', {onclick}, ...children). Text is always inserted as text nodes (XSS-safe). */
export function h(sel: string, attrs?: Record<string, any> | Child, ...kids: Child[]): HTMLElement {
  const m = sel.match(/^([a-z0-9]+)?(.*)$/i)!;
  const el = document.createElement(m[1] || 'div');
  for (const p of m[2].match(/[.#][^.#]+/g) || []) {
    if (p[0] === '.') el.classList.add(p.slice(1)); else el.id = p.slice(1);
  }
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className += ' ' + v;
      else if (k === 'text') el.textContent = String(v);
      else if (k in el && k !== 'style' && k !== 'list') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  } else if (attrs != null) kids.unshift(attrs as Child);
  add(el, kids);
  return el;
}
function add(el: Node, c: Child) {
  if (c == null || c === false) return;
  if (Array.isArray(c)) { for (const x of c) add(el, x); return; }
  el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
}

export function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
export function fmtDur(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

export const canZ = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
async function pipe(u: U8, s: CompressionStream | DecompressionStream): Promise<U8> {
  const w = s.writable.getWriter();
  void w.write(bs(u)).catch(() => {});
  void w.close().catch(() => {});
  return new Uint8Array(await new Response(s.readable).arrayBuffer());
}
export const deflate = (u: U8) => pipe(u, new CompressionStream('deflate-raw'));
export const inflate = (u: U8) => pipe(u, new DecompressionStream('deflate-raw'));
