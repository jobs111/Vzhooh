// Optional compression of photos and videos before sending (the default is always "original").
// Photos: resize + JPEG. Videos: re-encoded in the browser (WebCodecs) to a chosen target size.
import { app } from './app';
import { RELAY_MAX } from './files';
import { t } from './i18n';
import { toast } from './ui';
import { fmtSize, h } from './util';

type Level = 0 | 1 | 2 | 3;                      // 0 = original
const IMG: Record<number, [number, number]> = { 1: [2560, 0.88], 2: [1600, 0.8], 3: [1024, 0.65] };   // max side, JPEG quality
const VID: Record<number, [number, number]> = { 1: [0.6, 1080], 2: [0.35, 720], 3: [0.15, 480] };       // share of the original size, max short side

export async function compressImage(f: Blob, max: number, q: number): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise(res => c.toBlob(res, 'image/jpeg', q));
  } catch { return null; }
}
/** Re-encode a video to roughly `target` bytes. Throws 'unsupported' when this browser cannot do it. */
export async function compressVideo(f: Blob, target: number, maxSide: number, onProgress: (p: number) => void, signal: { cancel?: () => void }): Promise<Blob> {
  const mb = await import('mediabunny');
  const input = new mb.Input({ source: new mb.BlobSource(f), formats: mb.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('unsupported');
  const dur = Math.max(0.5, await input.computeDuration());
  const mp4 = await mb.canEncodeVideo('avc').catch(() => false) && await mb.canEncodeAudio('aac').catch(() => false);
  const format = mp4 ? new mb.Mp4OutputFormat() : new mb.WebMOutputFormat();
  const vcodec = mp4 ? 'avc' as const : await mb.getFirstEncodableVideoCodec(format.getSupportedVideoCodecs());
  if (!vcodec) throw new Error('unsupported');
  const total = target * 8 / dur;
  const abr = total > 900000 ? 128000 : total > 350000 ? 96000 : 48000;
  const vbr = Math.max(80000, Math.round((total - abr) * 0.94));
  const w = vt.displayWidth, hh = vt.displayHeight, k = Math.min(1, maxSide / Math.min(w, hh));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const out = new mb.Output({ format, target: new mb.BufferTarget() });
  const conv = await mb.Conversion.init({
    input, output: out,
    video: { width: even(w * k), height: even(hh * k), fit: 'contain', bitrate: vbr, codec: vcodec },
    audio: { bitrate: abr, codec: mp4 ? 'aac' : 'opus' },
  });
  if (!conv.isValid || conv.discardedTracks.some(d => d.track === vt)) throw new Error('unsupported');
  conv.onProgress = p => onProgress(p);
  signal.cancel = () => void conv.cancel();
  await conv.execute();
  const buf = (out.target as InstanceType<typeof mb.BufferTarget>).buffer;
  if (!buf) throw new Error('unsupported');
  return new Blob([buf], { type: mp4 ? 'video/mp4' : 'video/webm' });
}
const rename = (name: string, ext: string) => name.replace(/\.[^.]+$/, '') + '.' + ext;

/** Ask how to send photos/videos. Resolves with the files to send (possibly compressed), or null if cancelled.
 *  Files that are neither photos nor videos pass through untouched and do not open the dialog. */
export async function prepareFiles(files: File[], direct: boolean): Promise<File[] | null> {
  const media = files.filter(f => /^(image|video)\//.test(f.type) && f.type !== 'image/gif' && f.size > 150 * 1024);
  if (!media.length) return files;
  const vids = media.filter(f => f.type.startsWith('video/'));
  const one = vids.length === 1 && media.length === 1 ? vids[0] : null;
  const tooBig = !direct && media.some(f => f.size > RELAY_MAX);
  // no direct link: files travel through the relay, so a sensible compression level is preselected (the original stays one tap away)
  const thin = !direct && app.wire.slow;
  const auto: Level = thin ? 3 : !direct && media.some(f => f.size > 1024 * 1024) ? 2 : 0;
  let level: Level = 0, target = one ? one.size : 0;
  return new Promise(resolve => {
    const total = media.reduce((a, f) => a + f.size, 0);
    const est = h('div.cest'), rec = h('div.crec'), prog = h('div.pbar', { hidden: true }, h('i'));
    const slider = h('input', { type: 'range', min: '3', max: '100', value: '100', id: 'c-slider' }) as HTMLInputElement;
    const sl = h('div.cslider', { hidden: true }, slider);
    const btns: HTMLElement[] = [];
    const sig: { cancel?: () => void } = {};
    let busy = false;
    const upd = () => {
      btns.forEach((b, i) => b.classList.toggle('sel', i === level));
      sl.hidden = !(one && level > 0);
      if (one) est.textContent = level ? `${fmtSize(one.size)} → ≈ ${fmtSize(target)}` : fmtSize(one.size);
      else est.textContent = level ? `${fmtSize(total)} → ≈ ${fmtSize(total * [1, 0.45, 0.2, 0.08][level])}` : fmtSize(total);
    };
    const pick = (l: Level) => {
      level = l;
      if (one && l) { target = Math.round(one.size * VID[l][0]); slider.value = String(Math.round(VID[l][0] * 100)); }
      upd();
    };
    slider.oninput = () => { if (one) { target = Math.round(one.size * +slider.value / 100); if (!level) level = 2; upd(); } };
    ['cOrig', 'cLow', 'cMid', 'cHigh'].forEach((k, i) => btns.push(h('button.seg', { onclick: () => pick(i as Level), id: 'c-' + i }, t(k))));
    if (thin) rec.textContent = t('cRecThin');
    else if (tooBig || auto) rec.textContent = t('cRecRelay');
    else if (one && one.size > 300 * 1024 * 1024) rec.textContent = t('cRecBig');
    const close = (v: File[] | null) => { box.remove(); resolve(v); };
    const go = h('button.primary.wide', { id: 'c-send' }, t('send')) as HTMLButtonElement;
    go.onclick = async () => {
      if (busy) return;
      if (!level) { close(files); return; }
      busy = true; go.disabled = true; prog.hidden = false;
      const outFiles: File[] = [];
      const bar = prog.firstElementChild as HTMLElement;
      let n = 0;
      for (const f of files) {
        const idx = media.indexOf(f);
        if (idx < 0) { outFiles.push(f); continue; }
        const set = (p: number) => { bar.style.width = Math.round((n + p) / media.length * 100) + '%'; go.textContent = t('cWork') + ' ' + Math.round((n + p) / media.length * 100) + '%'; };
        set(0);
        try {
          if (f.type.startsWith('image/')) {
            const b = await compressImage(f, IMG[level][0], IMG[level][1]);
            outFiles.push(b && b.size < f.size ? new File([b], rename(f.name, 'jpg'), { type: 'image/jpeg' }) : f);
          } else {
            const tg = f === one ? target : Math.round(f.size * VID[level][0]);
            const b = await compressVideo(f, tg, VID[level][1], set, sig);
            outFiles.push(b.size < f.size ? new File([b], rename(f.name, b.type === 'video/mp4' ? 'mp4' : 'webm'), { type: b.type }) : f);
          }
        } catch (e: any) {
          if (!box.isConnected) return;               // cancelled
          toast(t('cFail'), 6000);
          outFiles.push(f);
        }
        n++;
      }
      close(outFiles);
    };
    const box = h('div.sheet', { id: 'c-sheet' }, h('div.sheetin',
      h('h2', t('cTitle')), h('p.hint', media.length === 1 ? media[0].name : t('cCount', media.length)),
      h('div.segs', ...btns), sl, est, rec, prog, go,
      h('button.wide', { onclick: () => { sig.cancel?.(); close(null); } }, t('cancel'))));
    document.body.append(box);
    pick(auto);
  });
}
