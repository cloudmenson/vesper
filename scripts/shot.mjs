// Renders stills of the film at given scroll positions.
//   node scripts/shot.mjs <outDir> 0 0.2 0.45 ...   [--w=1440 --h=900 --ui=0|1 --url=http://localhost:5173]
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const out = args[0];
const ps = args.slice(1).filter((a) => !a.startsWith('--'));
const w = +opt('w', 1440);
const h = +opt('h', 900);
const ui = opt('ui', '1') === '1';
const url = opt('url', (process.env.VESPER_URL ?? 'http://localhost:5173'));
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', `--window-size=${w},${h}`],
});
const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warn') console.log(`[${m.type()}]`, m.text().slice(0, 600));
});
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 800)));

for (const p of ps) {
  const t0 = Date.now();
  await page.goto(`${url}/?p=${p}&t=12.3`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 90000 });
  if (!ui) await page.addStyleTag({ content: '#app{display:none!important}' });
  await new Promise((r) => setTimeout(r, 900));
  const file = `${out}/p${String(p).replace('.', '_')}.jpg`;
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  console.log(`${file}  ${Date.now() - t0}ms`);
}
await browser.close();
