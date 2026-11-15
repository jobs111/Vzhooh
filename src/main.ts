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
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) toast(t('update') + ' — ' + t('reload'), 8000); });
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
(window as any).__vz = app;
