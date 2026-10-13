// Grows the spruce in Blender and packs its photographs into impostor atlases.
//   node scripts/trees.mjs [pack]      ("pack" skips Blender and only rebuilds the atlases)
//
// public/assets/trees/color.webp    2 variants × 3 elevations × 8 directions, colour + alpha
// public/assets/trees/normal.webp   the same layout at half size, world-space normals
// public/assets/models/spruce_N.glb the real meshes, for trees the camera passes close to
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';

const WORK = '.bake';
const OUT = 'public/assets/trees';
const BLENDER = existsSync('/Applications/Blender.app/Contents/MacOS/Blender') ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender';
const [FW, FH, COLS, ROWS, VARIANTS] = [256, 512, 8, 3, 2];
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

if (process.argv[2] !== 'pack') {
  // Blender reads PNG alpha more reliably than WebP's
  await sharp('public/assets/tex/fir_twig.webp').png().toFile(`${WORK}/fir_twig.png`);
  await sharp('public/assets/tex/bark_brown_02_diff.webp').png().toFile(`${WORK}/bark.png`);
  execFileSync(BLENDER, ['-b', '--python-exit-code', '1', '--python', 'scripts/trees.py', '--', WORK, 'public/assets'], { stdio: ['ignore', 'ignore', 'inherit'] });
  // the meshes are left as Blender wrote them: quantising would rescale the UVs that pick each twig out of its atlas
  for (let v = 0; v < VARIANTS; v++) console.log(`public/assets/models/spruce_${v}.glb  ${Math.round(statSync(`public/assets/models/spruce_${v}.glb`).size / 1024)} KB`);
}

const W = FW * COLS;
const H = FH * ROWS * VARIANTS;
const color = Buffer.alloc(W * H * 4);
const normal = Buffer.alloc(W * H * 3);
for (let v = 0; v < VARIANTS; v++) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const read = async (kind) => sharp(`${WORK}/trees/${v}_${r}_${c}_${kind}.png`).ensureAlpha().raw().toBuffer();
      const [cb, nb] = await Promise.all([read('c'), read('n')]);
      for (let y = 0; y < FH; y++) {
        for (let x = 0; x < FW; x++) {
          const s = (y * FW + x) * 4;
          const d = ((v * ROWS + r) * FH + y) * W + c * FW + x;
          color.set(cb.subarray(s, s + 4), d * 4);
          normal.set(nb.subarray(s, s + 3), d * 3);
        }
      }
    }
  }
}

// Bleed colour (and normals) outward into the transparent pixels, so filtering never pulls in black.
for (let pass = 0; pass < 10; pass++) {
  const src = Buffer.from(color);
  const nsrc = Buffer.from(normal);
  const filled = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) filled[i] = pass === 0 ? (src[i * 4 + 3] > 8 ? 1 : 0) : color.readUInt8(i * 4 + 3) > 8 || color[i * 4] + color[i * 4 + 1] + color[i * 4 + 2] > 0 ? 1 : 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (filled[i]) continue;
      let n = 0;
      const acc = [0, 0, 0, 0, 0, 0];
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (!filled[j]) continue;
        n++;
        for (let k = 0; k < 3; k++) {
          acc[k] += src[j * 4 + k];
          acc[3 + k] += nsrc[j * 3 + k];
        }
      }
      if (!n) continue;
      for (let k = 0; k < 3; k++) {
        color[i * 4 + k] = acc[k] / n;
        normal[i * 3 + k] = acc[3 + k] / n;
      }
    }
  }
}

await sharp(color, { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 88, alphaQuality: 92, effort: 5 }).toFile(`${OUT}/color.webp`);
await sharp(normal, { raw: { width: W, height: H, channels: 3 } }).resize(W / 2, H / 2).webp({ quality: 88, effort: 5 }).toFile(`${OUT}/normal.webp`);
for (const f of ['color', 'normal']) console.log(`${OUT}/${f}.webp  ${Math.round(statSync(`${OUT}/${f}.webp`).size / 1024)} KB`);
