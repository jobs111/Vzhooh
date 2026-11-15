import { encode } from 'uqr';
import { h } from './util';

function draw(text: string, scale: number, border = 3): HTMLCanvasElement {
  const q = encode(text, { ecc: 'M', border });
  const n = q.size;
  const c = document.createElement('canvas');
  c.width = c.height = n * scale;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.data[y][x]) g.fillRect(x * scale, y * scale, scale, scale);
  return c;
}
const modules = (text: string) => encode(text, { ecc: 'M', border: 3 }).size;

/** A QR code on a canvas (crisp, with a white quiet zone so it scans in dark mode too). */
export function qrCanvas(text: string, px = 264): HTMLCanvasElement {
  const scale = Math.max(2, Math.floor((px * (window.devicePixelRatio || 1)) / modules(text)));
  const c = draw(text, scale);
  c.style.width = c.style.height = px + 'px';
  c.className = 'qr';
  c.dataset.text = text;
  return c;
}
/** High-resolution PNG of a QR code (for saving / printing). */
export function qrPng(text: string, px = 1200): Promise<Blob | null> {
  const c = draw(text, Math.max(4, Math.floor(px / modules(text))));
  return new Promise(res => c.toBlob(res, 'image/png'));
}
/** Show a QR code over the whole screen (to scan from a projector or across a room). Tap to close. */
export function qrFull(text: string, caption = '') {
  const side = Math.floor(Math.min(innerWidth, innerHeight) * 0.9);
  const c = qrCanvas(text, side);
  const box = h('div.qrfull', { role: 'dialog', onclick: () => { box.remove(); try { lock?.release(); } catch { /* ignore */ } } }, c, caption ? h('div.qrcap', caption) : null);
  let lock: any = null;
  (navigator as any).wakeLock?.request('screen').then((l: any) => { lock = l; }).catch(() => {});
  document.body.append(box);
}
