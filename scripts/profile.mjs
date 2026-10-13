// GPU-synchronised frame cost, and what each part of the scene adds to it.
//   node scripts/profile.mjs 0 0.3 0.6 1
// Each part is timed A/B/A — with it, without it, with it again — after a warm-up, so shader compilation and
// drift do not get counted as cost.
import puppeteer from 'puppeteer-core';
const ps = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1512, height: 982, deviceScaleFactor: 2 });
for (const p of ps) {
  await page.goto(`${process.env.VESPER_URL ?? 'http://localhost:5173'}/?p=${p}`, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 1500));
  const res = await page.evaluate((p) => {
    const exp = window.__exp;
    const gl = exp.renderer.getContext();
    const px = new Uint8Array(4);
    const cost = (n = 30) => {
      exp.frame(p, 1, 1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < n; i++) exp.frame(p, 1 + i / 60, 1 / 60);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return (performance.now() - t0) / n;
    };
    cost(40); // warm up
    const out = { base: +cost(60).toFixed(1) };
    const find = (pred) => { const l = []; exp.scene.traverse((o) => pred(o) && l.push(o)); return l; };
    // A/B/A: the cost of a thing is the frame with it (before and after) minus the frame without
    const ab = (name, offFn, onFn) => { const a = cost(40); offFn(); const b = cost(40); onFn(); const c = cost(40); out[name] = +((a + c) / 2 - b).toFixed(1); };
    const vis = (name, list) => ab(name, () => list.forEach((o) => (o.visible = false)), () => list.forEach((o) => (o.visible = true)));
    vis('sky', find((o) => o.renderOrder === -100));
    vis('stars', find((o) => o.renderOrder === -90));
    vis('mountains', find((o) => o.renderOrder === -80));
    vis('forest', find((o) => o.name === 'forest'));
    vis('terrain', find((o) => o.name === 'terrain'));
    vis('house', [exp.house.group]);
    vis('water', [exp.water.mesh]);
    ab('bloom', () => (exp.post.bloom.enabled = false), () => (exp.post.bloom.enabled = true));
    const lm = exp.lightmap; const u = lm.update;
    ab('mixer', () => (lm.update = () => {}), () => (lm.update = u));
    out.base2 = +cost(60).toFixed(1);
    out.px = `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`;
    return out;
  }, +p);
  console.log(`p=${p}  ` + Object.entries(res).map(([k, v]) => `${k} ${v}`).join('  '));
}
await browser.close();
