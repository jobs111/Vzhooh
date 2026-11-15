// One-off: render PNG icons from public/icon.svg (run locally with Playwright available).
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../public/icon.svg'), 'utf8');
  const b = await chromium.launch();
  for (const n of [180, 192, 512]) {
    const p = await b.newPage({ viewport: { width: n, height: n } });
    await p.setContent(`<style>html,body{margin:0}svg{display:block;width:${n}px;height:${n}px}</style>${svg}`);
    await p.screenshot({ path: path.join(__dirname, `../public/icon-${n}.png`), omitBackground: true });
    await p.close();
  }
  await b.close();
})();
