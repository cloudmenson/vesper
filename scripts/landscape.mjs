// Runs Blender for the lake's waves and the mountain range, then prepares what it made for the site.
//   node scripts/landscape.mjs
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';

const WORK = '.bake';
const BLENDER = existsSync('/Applications/Blender.app/Contents/MacOS/Blender') ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender';
mkdirSync(WORK, { recursive: true });
execFileSync(BLENDER, ['-b', '--python-exit-code', '1', '--python', 'scripts/landscape.py', '--', WORK, 'public/assets'], { stdio: ['ignore', 'ignore', 'inherit'] });

// wave heights → tileable normal maps
for (const [name, metres] of [['a', 24], ['b', 6]]) {
  const h = new Float32Array(readFileSync(`${WORK}/wave_${name}.bin`).buffer.slice(0));
  const n = Math.round(Math.sqrt(h.length));
  const px = Buffer.alloc(n * n * 3);
  const step = metres / n;
  const at = (x, y) => h[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // slope in metres per metre; stored with a fixed gain so both tiles decode the same way
      const dx = (at(x + 1, y) - at(x - 1, y)) / (2 * step);
      const dy = (at(x, y + 1) - at(x, y - 1)) / (2 * step);
      const i = (y * n + x) * 3;
      px[i] = Math.max(0, Math.min(255, Math.round((dx * 2.0 * 0.5 + 0.5) * 255)));
      px[i + 1] = Math.max(0, Math.min(255, Math.round((dy * 2.0 * 0.5 + 0.5) * 255)));
      px[i + 2] = 255;
    }
  }
  const out = `public/assets/tex/wave_${name}.webp`;
  await sharp(px, { raw: { width: n, height: n, channels: 3 } }).webp({ quality: 92 }).toFile(out);
  console.log(`${out}  ${n}²  ${Math.round(statSync(out).size / 1024)} KB`);
}

const glb = 'public/assets/models/mountains.glb';
execFileSync('npx', ['gltf-transform', 'optimize', glb, `${glb}.tmp.glb`, '--compress', 'meshopt', '--instance', 'false', '--simplify', 'false'], { stdio: 'ignore' });
renameSync(`${glb}.tmp.glb`, glb);
console.log(`${glb}  ${Math.round(statSync(glb).size / 1024)} KB`);
