// One still from an arbitrary camera:  node scripts/cam.mjs out.jpg p "x,y,z,tx,ty,tz,fov"
import puppeteer from 'puppeteer-core';
const [out, p, cam] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1100, height: 660, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
await page.goto(`${process.env.VESPER_URL ?? 'http://localhost:5173'}/?p=${p}&t=12.3&cam=${cam}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 120000 });
await page.addStyleTag({ content: '#app{display:none!important}' });
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: out, type: 'jpeg', quality: 84 });
await browser.close();
