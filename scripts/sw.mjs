// Post-build: generate the service worker with a precache list, so the app opens instantly and offline.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const skip = new Set(['sw.js', 'owner.json', 'probe.bin', '.nojekyll']);
const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p); else { const r = relative(dist, p).replace(/\\/g, '/'); if (!skip.has(r) && !(r.endsWith('.js') && statSync(p).size > 300000)) files.push(r); }   // big lazy chunks are cached on first use
  }
})(dist);
const hash = createHash('sha256');
for (const f of files.sort()) hash.update(f).update(readFileSync(join(dist, f)));
const V = 'vz-' + hash.digest('hex').slice(0, 12);
const list = ['./', ...files.map(f => './' + f)];
writeFileSync(join(dist, 'sw.js'), `// generated
const V = ${JSON.stringify(V)};
const FILES = ${JSON.stringify(list)};
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (/\\/(owner\\.json|probe\\.bin|sw\\.js)$/.test(u.pathname)) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(rsp => {
    if (rsp.ok && u.pathname.includes('/assets/')) { const c = rsp.clone(); caches.open(V).then(k => k.put(e.request, c)); }
    return rsp;
  })));
});
`);
console.log('sw.js', V, list.length, 'files');
