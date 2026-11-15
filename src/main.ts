import './style.css';
import { app } from './app';
import { lang, setLang, t } from './i18n';
import { initUi, route, toast } from './ui';
import { h } from './util';

const root = document.getElementById('app')!;
let started = false;

async function start() {
  if (started) return;
  started = true;
  await app.init();
  initUi();
  await route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    // Updates: check often, and switch to the new version by itself (never in the middle of a call or a transfer).
    const had = !!navigator.serviceWorker.controller;
    let pending = false;
    const apply = () => {
      if (!pending) return;
      const busy = [...app.rooms.values()].some(r => r.call.st !== 'idle' || r.xfer.busy);
      if (busy) return;
      location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) { pending = true; toast(t('update'), 3000); setTimeout(apply, 1200); } });
    setInterval(apply, 5000);
    const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => null);
    const check = () => { void reg?.update().catch(() => {}); };
    check();
    setInterval(check, 15 * 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }
}
function otherTab() {
  app.wire.stop();
  root.replaceChildren(h('div.lock', h('p', t('otherTab')), h('button.primary', { onclick: () => void hold(true).then(() => location.reload()) }, t('useHere'))));
}
/** Only one tab may run the app (two tabs would both answer the same handshakes). */
function hold(steal: boolean): Promise<boolean> {
  return new Promise(res => {
    navigator.locks.request('vz-main', steal ? { steal: true } : { ifAvailable: true }, lock => {
      if (!lock) { res(false); return; }
      res(true);
      return new Promise(() => {});
    }).catch(() => otherTab());
  });
}
setLang(lang);
(async () => {
  if (navigator.locks && !(await hold(false))) { otherTab(); return; }
  await start();
})().catch(e => { console.error(e); root.textContent = 'Error: ' + e; });
// debugging/test handle: only when explicitly enabled on this device
if (import.meta.env.DEV || localStorage.getItem('vz.debug') === 'true') (window as any).__vz = app;
