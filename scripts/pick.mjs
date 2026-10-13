// What is under a pixel?  node scripts/pick.mjs p "cam" ndcX ndcY
import puppeteer from 'puppeteer-core';
const [p, cam, x, y] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 660, deviceScaleFactor: 1 });
await page.goto(`${process.env.VESPER_URL ?? 'http://localhost:5173'}/?p=${p}&t=12.3&cam=${cam}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 120000 });
await new Promise((r) => setTimeout(r, 600));
const res = await page.evaluate(async (x, y) => {
  const { pick } = await import('/src/debug.ts');
  const exp = window.__exp;
  return pick(exp.scene, exp.camera, x, y);
}, +x, +y);
console.log(JSON.stringify(res, null, 1));
await browser.close();
