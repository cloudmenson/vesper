// Bakes the house's lighting in Blender (Cycles) and writes the lightmaps the site ships with.
//   node scripts/bake.mjs [samples]        needs the dev server running, Blender and ffmpeg-free sharp
// 1. export: the page hands over the house as a GLB plus a list of lamps          → .bake/house.glb, scene.json
// 2. bake:   Blender renders direct and bounced light into the atlas, per layer   → .bake/*.bin (float RGB)
// 3. encode: layers are range-compressed and saved as WebP                        → public/assets/bake/*.webp
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';

const samples = process.argv[2] ?? '256';
const only = process.argv[3]; // 'export' | 'bake' | 'encode' to run a single step
const WORK = '.bake';
const OUT = 'public/assets/bake';
const BLENDER = existsSync('/Applications/Blender.app/Contents/MacOS/Blender') ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender';
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

if (!only || only === 'export') {
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 400)));
  await page.goto((process.env.VESPER_URL ?? 'http://localhost:5173') + '/?p=0&bake=0', { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true', { timeout: 120000 });
  const res = await page.evaluate(async () => {
    const { exportForBake } = await import('/src/bake/export.ts');
    const out = await exportForBake(window.__exp);
    window.__files = out.files;
    return { scene: out.scene, files: Object.fromEntries(Object.entries(out.files).map(([name, buf]) => [name, buf.byteLength])) };
  });
  // the files are tens of megabytes: fetch them a few at a time rather than in one message
  const STEP = 3 << 20;
  for (const [name, size] of Object.entries(res.files)) {
    const parts = [];
    for (let at = 0; at < size; at += STEP) {
      const b64 = await page.evaluate(
        (name, at, STEP) => {
          const bytes = new Uint8Array(window.__files[name], at, Math.min(STEP, window.__files[name].byteLength - at));
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(s);
        },
        name,
        at,
        STEP,
      );
      parts.push(Buffer.from(b64, 'base64'));
    }
    writeFileSync(`${WORK}/${name}`, Buffer.concat(parts));
  }
  await browser.close();
  writeFileSync(`${WORK}/scene.json`, JSON.stringify(res.scene));
  console.log(`export  ${(statSync(`${WORK}/house.glb`).size / 1e6).toFixed(1)} MB`, JSON.stringify(res.scene.meshes), `${res.scene.lights.length} lamps, ${res.scene.density.toFixed(1)} texels/m`);
}

if (!only || only === 'bake') {
  execFileSync(BLENDER, ['-b', '--python-exit-code', '1', '--python', 'scripts/bake.py', '--', WORK, samples], { stdio: 'inherit' });
}

if (!only || only === 'encode') {
  const { size, counts } = JSON.parse(readFileSync(`${WORK}/scene.json`, 'utf8'));
  const load = (name) => new Float32Array(readFileSync(`${WORK}/${name}.bin`).buffer.slice(0));
  // Stored as sqrt(value / max) in 8 bits: fine steps in the shadows, where banding would show.
  const MAX = { sky: 2, lamps: 16, fire: 16 };
  const enc = (v, max) => Math.round(Math.sqrt(Math.min(Math.max(v, 0), max) / max) * 255);
  const meta = {};
  for (const name of ['sky', 'lamps', 'fire']) {
    const data = load(name);
    const max = MAX[name];
    const px = Buffer.alloc(size * size * 3);
    let peak = 0;
    // No flip: glTF counts V from the top, so Blender's bottom row is already our V = 1, the top row of the file.
    for (let i = 0; i < size * size * 3; i++) {
      if (data[i] > peak) peak = data[i];
      px[i] = enc(data[i], max);
    }
    await sharp(px, { raw: { width: size, height: size, channels: 3 } }).webp({ quality: 94, effort: 5 }).toFile(`${OUT}/${name}.webp`);
    await sharp(px, { raw: { width: size, height: size, channels: 3 } }).resize(1024).jpeg({ quality: 85 }).toFile(`${WORK}/${name}-preview.jpg`);
    meta[name] = { max, peak: +peak.toFixed(2) };
    console.log(`encode  ${name}.webp  ${Math.round(statSync(`${OUT}/${name}.webp`).size / 1024)} KB  peak ${peak.toFixed(2)}`);
  }
  // loose objects: 8 bytes a vertex — lamps rgb, sky, fire rgb, unused
  const props = load('props');
  const n = props.length / 7;
  const bytes = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) bytes[i * 8 + k] = enc(props[i * 7 + k], MAX.lamps);
    bytes[i * 8 + 3] = enc(props[i * 7 + 3], MAX.sky);
    for (let k = 0; k < 3; k++) bytes[i * 8 + 4 + k] = enc(props[i * 7 + 4 + k], MAX.fire);
  }
  writeFileSync(`${OUT}/props.bin`, bytes);
  meta.props = { counts };
  console.log(`encode  props.bin  ${Math.round(bytes.length / 1024)} KB  ${n} vertices`);
  writeFileSync('src/scene/bake.json', JSON.stringify(meta) + '\n');
}
