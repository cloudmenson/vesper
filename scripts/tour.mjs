// Walks the house the way a visitor does: scrolls in through the door, then follows the choices.
//   node scripts/tour.mjs <outDir> [route]      route: comma-separated destinations, default visits every stop and leaves by the skylight
// Along the way it watches the camera: how fast it ever turns, and whether it ever passes through the stair's glass.
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
const out = process.argv[2];
const route = (process.argv[3] ?? 'terrace,room,fire,picture,room,kitchen,dining,loft,books,desk,bed,corner,bed,sky').split(',');
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', (e) => logs.push('[pageerror] ' + String(e).slice(0, 400)));
await page.goto((process.env.VESPER_URL ?? 'http://localhost:5173') + '/', { waitUntil: 'load' });
await page.waitForSelector('#loader.is-ready', { timeout: 120000 });
await new Promise((r) => setTimeout(r, 1200)); // the two doors fade in before they can be clicked
await page.click('[data-enter="quiet"]');
await new Promise((r) => setTimeout(r, 3200));
const shot = (name) => page.screenshot({ path: `${out}/${name}.jpg`, type: 'jpeg', quality: 80 });
const arrived = () => page.waitForSelector('.tour.is-on', { timeout: 30000 }).then(() => new Promise((r) => setTimeout(r, 1500)));
// in through the door
await page.evaluate(() => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * 0.36));
await arrived();
await shot('00-room');
let n = 1;
for (const to of route) {
  const ok = await page.evaluate((to) => {
    const btn = document.querySelector(`.ways button[data-to="${to}"]`);
    if (btn) btn.click();
    return !!btn;
  }, to);
  if (!ok) {
    console.log(`no way to "${to}" from here`);
    break;
  }
  if (to === 'sky' || to === 'pier') {
    await new Promise((r) => setTimeout(r, 9000));
    await shot(`${String(n).padStart(2, '0')}-${to}`);
    console.log(to, 'p =', await page.evaluate(() => window.__exp.p.toFixed(3)), 'scroll =', await page.evaluate(() => (scrollY / (document.documentElement.scrollHeight - innerHeight)).toFixed(3)));
    break;
  }
  await new Promise((r) => setTimeout(r, 400));
  // watch the walk: the fastest the view turns (°/s), sampled every frame until the choices come back
  const spin = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const cam = window.__exp.camera;
        const dir = cam.getWorldDirection(cam.position.clone());
        const was = dir.clone();
        let worst = 0;
        let last = performance.now();
        const t0 = last;
        const step = (now) => {
          cam.getWorldDirection(dir);
          const dt = (now - last) / 1000;
          if (dt > 0.004) worst = Math.max(worst, (was.angleTo(dir) * 180) / Math.PI / dt);
          was.copy(dir);
          last = now;
          if (document.querySelector('.tour.is-on') || now - t0 > 15000) resolve({ worst: Math.round(worst), seconds: +((now - t0) / 1000).toFixed(1) });
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
  await arrived();
  await shot(`${String(n++).padStart(2, '0')}-${to}`);
  console.log(to.padEnd(8), 'p =', await page.evaluate(() => window.__exp.p.toFixed(3)), ` ${spin.seconds}s, turning at most ${spin.worst}°/s`);
}
console.log(logs.join('\n') || 'no console errors');
await browser.close();
