// Walks the real page the way a visitor does: loader → entrance → intro → scroll.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const [w, h, dsf] = (process.argv[3] ?? '1280,760,1').split(',').map(Number);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.setViewport({ width: w, height: h, deviceScaleFactor: dsf, isMobile: w < 600, hasTouch: w < 600 });
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 400)));
page.on('requestfailed', (r) => logs.push('[failed] ' + r.url()));
const t0 = Date.now();
await page.goto((process.env.VESPER_URL ?? 'http://localhost:5173') + '/', { waitUntil: 'load' });
await page.waitForSelector('#loader.is-ready', { timeout: 120000 });
console.log('ready in', Date.now() - t0, 'ms');
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${out}/1-gate.jpg`, type: 'jpeg', quality: 80 });
await page.click('[data-enter="sound"]');
await new Promise((r) => setTimeout(r, 5200));
await page.screenshot({ path: `${out}/2-hero.jpg`, type: 'jpeg', quality: 80 });
const state = await page.evaluate(() => ({ sound: document.querySelector('#sound').textContent, audio: window.__exp ? 'exp ok' : 'no exp' }));
console.log(JSON.stringify(state));
// 0.3 is still the film (on the terrace); past 0.345 the scroll stops and the walk begins (see scripts/tour.mjs)
for (const [i, f] of [[3, 0.3], [4, 0.36]]) {
  await page.evaluate((f) => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f), f);
  await new Promise((r) => setTimeout(r, 3500));
  await page.screenshot({ path: `${out}/${i}-scroll.jpg`, type: 'jpeg', quality: 80 });
  console.log('p =', await page.evaluate(() => window.__exp.p.toFixed(3)));
}
console.log(logs.join('\n') || 'no console errors');
await browser.close();
