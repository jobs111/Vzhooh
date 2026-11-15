// Tiny sounds via WebAudio (no audio files to download).
let ctx: AudioContext | null = null;
export function ac(): AudioContext | null {
  try {
    ctx ||= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
}
function tone(freq: number, at: number, dur: number, vol = 0.08) {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, c.currentTime + at);
  g.gain.linearRampToValueAtTime(vol, c.currentTime + at + 0.02);
  g.gain.linearRampToValueAtTime(0, c.currentTime + at + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + at);
  o.stop(c.currentTime + at + dur + 0.05);
}
export const beep = () => { tone(880, 0, 0.12); tone(1175, 0.12, 0.16); };
let ringT: any;
export function ring(kind: 'in' | 'out' | null) {
  clearInterval(ringT); ringT = undefined;
  if (!kind) return;
  const play = () => {
    if (kind === 'in') { tone(660, 0, 0.25, 0.12); tone(880, 0.3, 0.25, 0.12); tone(660, 0.6, 0.25, 0.12); try { navigator.vibrate?.([200, 100, 200]); } catch { /* ignore */ } }
    else tone(440, 0, 0.9, 0.05);
  };
  play();
  ringT = setInterval(play, kind === 'in' ? 2200 : 3000);
}
/** Must be called from a user gesture once so that later sounds are allowed. */
export const unlockAudio = () => { ac(); };
