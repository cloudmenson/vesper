// Measures shimmer: what a still frame cannot show. Steps the film a frame at a time and looks, per pixel, at how far
// each frame departs from the average of its neighbours in time — smooth motion nearly cancels, flicker does not.
//   node scripts/flicker.mjs <outDir> 0.2: 0.86: ...           creeps on from each point half a pixel per frame: what shimmers is aliasing
//   node scripts/flicker.mjs <outDir> --freeze 0.2:0.3 ...     scrolls a→b at reading speed with the camera held: what changes is light popping
//   node scripts/flicker.mjs <outDir> 0.24                     holds still: what changes is animation (water, fire)
//   options: --w=1280 --h=800  --cam=x,y,z,tx,ty,tz,fov
// Writes <range>.jpg: the last frame with the flicker painted over it in red, and prints a score per range.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=')[1];
const [out, ...ranges] = args.filter((a) => !a.startsWith('--'));
const dp = +opt('dp', args.includes('--freeze') ? 0.0012 : 0.00015);
const cam = opt('cam', '');
const freeze = args.includes('--freeze'); // hold the camera where each range starts: what is left is light changing, not motion
mkdirSync(out, { recursive: true });
const url = process.env.VESPER_URL ?? 'http://localhost:5173';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: +opt('w', 1280), height: +opt('h', 800), deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(`${url}/?p=${ranges[0].split(':')[0]}&t=0${cam ? `&cam=${cam}` : ''}`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready === true', { timeout: 120000 });
await page.addStyleTag({ content: '#app{display:none!important}' });
// take the film out of the page's hands
await page.evaluate(() => {
  const e = window.__exp;
  window.__frame = e.frame.bind(e);
  e.frame = () => {};
  e.post.lens.uGrain.value = 0; // film grain is flicker by design
});
for (const range of ranges) {
  const [a, b] = range.split(':').map((v) => (v === '' ? NaN : Number(v)));
  const still = b === undefined;
  const frames = still || !freeze ? 60 : Math.min(90, Math.max(8, Math.round((b - a) / dp)));
  const res = await page.evaluate(
    (a, b, frames, still, freeze) => {
      const e = window.__exp;
      if (freeze) {
        const pos = e.pos.clone();
        const look = e.look.clone();
        const fov = e.path.sample(a, pos, look);
        e.debugCam = [pos.x, pos.y, pos.z, look.x, look.y, look.z, fov];
      }
      const gl = e.renderer.getContext();
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      const lum = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
      const heat = new Float32Array(w * h);
      let sum = 0;
      let hot = 0;
      let n = 0;
      // settle: let damped values (mouse, exposure) arrive before measuring
      for (let i = 0; i < 20; i++) {
        e.p = a;
        window.__frame(a, 10 + i / 60, 1 / 60);
      }
      for (let i = 0; i < frames; i++) {
        let p = still ? a : a + ((b - a) * i) / (frames - 1);
        if (!still && !freeze) {
          // creep: advance by whatever scroll moves the picture half a pixel, so only aliasing is left to see
          const p0 = i === 0 ? a : window.__creep;
          const A = e.pos.clone(), At = e.look.clone(), B = e.pos.clone(), Bt = e.look.clone();
          const fov = e.path.sample(p0, A, At);
          e.path.sample(p0 + 1e-4, B, Bt);
          const rot = At.sub(A).normalize().angleTo(Bt.sub(B).normalize());
          const perPx = ((fov * Math.PI) / 180) / h;
          const px = rot / perPx + A.distanceTo(B) / 3 / perPx; // pixels moved per 1e-4 of scroll, for things 3 m away
          p = p0 + (1e-4 * 0.5) / Math.max(px, 1e-3);
          window.__creep = p;
        }
        e.p = p;
        window.__frame(p, 10.4 + i / 60, 1 / 60);
        e.renderer.setRenderTarget(null);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const L = lum[i % 3];
        for (let k = 0; k < w * h; k++) L[k] = (px[k * 4] * 0.299 + px[k * 4 + 1] * 0.587 + px[k * 4 + 2] * 0.114) / 255;
        if (i >= 2) {
          const mid = lum[(i - 1) % 3];
          const prev = lum[(i - 2) % 3];
          for (let k = 0; k < w * h; k++) {
            const d = Math.abs(mid[k] - 0.5 * (prev[k] + L[k]));
            sum += d;
            if (d > 0.04) hot++;
            heat[k] += d;
          }
          n += w * h;
        }
      }
      // last frame, darkened, with the worst flicker each pixel saw painted in red
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = ((h - 1 - y) * w + x) * 4;
          const d = (y * w + x) * 4;
          const f = Math.min(1, (heat[(h - 1 - y) * w + x] / (frames - 2)) * 40);
          img.data[d] = px[s] * 0.45 * (1 - f) + 255 * f;
          img.data[d + 1] = px[s + 1] * 0.45 * (1 - f) + 40 * f;
          img.data[d + 2] = px[s + 2] * 0.45 * (1 - f);
          img.data[d + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return { jpg: c.toDataURL('image/jpeg', 0.85).split(',')[1], mean: (sum / n) * 1000, hot: (hot / n) * 1e4, frames };
    },
    a,
    b ?? a,
    frames,
    still,
    freeze,
  );
  writeFileSync(`${out}/${range.replace(':', '-')}.jpg`, Buffer.from(res.jpg, 'base64'));
  console.log(`${range.padEnd(14)} ${String(res.frames).padStart(3)} frames  mean ${res.mean.toFixed(2)}‰  hot ${res.hot.toFixed(1)}‱`);
}
await browser.close();
