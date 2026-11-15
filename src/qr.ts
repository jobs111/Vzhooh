import { encode } from 'uqr';
/** Draw a QR code on a canvas (crisp, with a white quiet zone so it scans in dark mode too). */
export function qrCanvas(text: string, px = 264): HTMLCanvasElement {
  const q = encode(text, { ecc: 'M', border: 3 });
  const n = q.size, scale = Math.max(2, Math.floor((px * (window.devicePixelRatio || 1)) / n));
  const c = document.createElement('canvas');
  c.width = c.height = n * scale;
  c.style.width = c.style.height = px + 'px';
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.data[y][x]) g.fillRect(x * scale, y * scale, scale, scale);
  c.className = 'qr';
  return c;
}
