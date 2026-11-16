import { encode } from 'uqr';
import { h } from './util';

type Ecc = 'L' | 'M';
function draw(text: string, scale: number, ecc: Ecc = 'M', border = 3): HTMLCanvasElement {
  const q = encode(text, { ecc, border });
  const n = q.size;
  const c = document.createElement('canvas');
  c.width = c.height = n * scale;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.data[y][x]) g.fillRect(x * scale, y * scale, scale, scale);
  return c;
}
const modules = (text: string, ecc: Ecc = 'M') => encode(text, { ecc, border: 3 }).size;

/** A QR code on a canvas (crisp, with a white quiet zone so it scans in dark mode too). */
export function qrCanvas(text: string, px = 264, ecc: Ecc = 'M'): HTMLCanvasElement {
  const scale = Math.max(2, Math.floor((px * (window.devicePixelRatio || 1)) / modules(text, ecc)));
  const c = draw(text, scale, ecc);
  c.style.width = c.style.height = px + 'px';
  c.className = 'qr';
  c.dataset.text = text;
  return c;
}
/** High-resolution PNG of a QR code (for saving / printing). */
export function qrPng(text: string, px = 1200, ecc: Ecc = 'M'): Promise<Blob | null> {
  const c = draw(text, Math.max(4, Math.floor(px / modules(text, ecc))), ecc);
  return new Promise(res => c.toBlob(res, 'image/png'));
}
/** Show a QR code over the whole screen (to scan from a projector or across a room). Tap to close. */
export function qrFull(text: string | string[], caption = '', ecc: Ecc = 'M') {
  const list = Array.isArray(text) ? text : [text];
  const side = Math.floor(Math.min(innerWidth, innerHeight) * 0.88);
  let i = 0;
  const cap = h('div.qrcap');
  const show = () => { box.replaceChildren(qrCanvas(list[i], side, ecc), cap); cap.textContent = (list.length > 1 ? `${i + 1} / ${list.length}` : '') + (caption ? ' ' + caption : ''); };
  // several codes: a tap shows the next one, after the last one the view closes
  const box = h('div.qrfull', { role: 'dialog', onclick: () => { if (++i < list.length) { show(); return; } box.remove(); try { lock?.release(); } catch { /* ignore */ } } });
  show();
  let lock: any = null;
  (navigator as any).wakeLock?.request('screen').then((l: any) => { lock = l; }).catch(() => {});
  document.body.append(box);
}
