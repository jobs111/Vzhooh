// Tiny static server for dist/ (used by tests).
const http = require('http'), fs = require('fs'), path = require('path');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.bin': 'application/octet-stream' };
exports.overrides = {};
exports.serve = (dir, port) => new Promise(res => {
  const srv = http.createServer((req, rsp) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (exports.overrides[p] != null) { rsp.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); rsp.end(exports.overrides[p]); return; }
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(dir, p);
    if (!f.startsWith(dir) || !fs.existsSync(f)) { rsp.writeHead(404); rsp.end('nf'); return; }
    rsp.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(rsp);
  }).listen(port, '127.0.0.1', () => res(srv));
});
