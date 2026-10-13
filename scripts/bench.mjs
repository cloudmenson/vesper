// Measures frame time at given scroll positions on a MacBook-sized retina viewport.
//   node scripts/bench.mjs 0 0.3 0.45 0.8 1
import puppeteer from 'puppeteer-core';
const ps = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const extra = (process.argv.find((a) => a.startsWith('--q=')) ?? '--q=').slice(4);
const url = (process.env.VESPER_URL ?? 'http://localhost:5173');
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1512, height: 982, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
for (const p of ps) {
  await page.goto(`${url}/?p=${p}&${extra}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 90000 });
  await new Promise((r) => setTimeout(r, 1200));
  const ms = await page.evaluate(
    () =>
      new Promise((res) => {
        const t = [];
        let last = performance.now();
        const f = (now) => {
          t.push(now - last);
          last = now;
          if (t.length < 90) requestAnimationFrame(f);
          else {
            t.sort((a, b) => a - b);
            res({ med: t[45], p90: t[80], size: [document.getElementById('gl').width, document.getElementById('gl').height] });
          }
        };
        requestAnimationFrame(f);
      }),
  );
  console.log(`[${extra}] p=${p}  median ${ms.med.toFixed(1)} ms (${(1000 / ms.med).toFixed(0)} fps)  p90 ${ms.p90.toFixed(1)} ms  buffer ${ms.size.join('x')}`);
}
await browser.close();
