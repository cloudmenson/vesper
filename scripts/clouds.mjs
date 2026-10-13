// Cuts the clouds out of a photograph of a real sky.   node scripts/clouds.mjs <panorama.jpg> <out.webp>
//
// The photograph is one of Poly Haven's "pure sky" panoramas (CC0): fair-weather cumulus on a blue afternoon. Blue is
// what makes it usable: where the picture is blue there is sky, where it is white or grey there is cloud, so the
// clouds come away with their true shapes, their soft edges and the perspective they had overhead. Two pictures are
// kept, stacked in one greyscale file:
//   top     how much cloud there is (0 clear … 1 solid)
//   bottom  how brightly it was lit (its sunlit crowns against its shaded base)
// The page lights them itself, from whatever the sky is doing at that hour (see createClouds in landscape.ts).
import sharp from 'sharp';

const [src, out] = process.argv.slice(2);
const W = 3072;
const H = 768;
const meta = await sharp(src, { limitInputPixels: false }).metadata();
// the dome: the upper half of the panorama, zenith in the top row
const rgb = await sharp(src, { limitInputPixels: false })
  .extract({ left: 0, top: 0, width: meta.width, height: Math.floor(meta.height / 2) })
  .resize(W, H, { fit: 'fill', kernel: 'lanczos3' })
  .removeAlpha()
  .raw()
  .toBuffer();

const white = new Float32Array(W * H); // 0 saturated blue … 1 no colour at all
const lum = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) {
  const r = rgb[i * 3] / 255;
  const g = rgb[i * 3 + 1] / 255;
  const b = rgb[i * 3 + 2] / 255;
  white[i] = Math.min(r, g, b) / Math.max(r, g, b, 1e-3);
  lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The clear sky pales toward the horizon, so "blue enough to be sky" is judged row by row: each row's bluest
// stretch is its sky. (Smoothed down the rows, or a row with one stray pixel would set its own rule.)
const sky = new Float32Array(H);
const row = new Float32Array(W);
for (let y = 0; y < H; y++) {
  row.set(white.subarray(y * W, (y + 1) * W));
  row.sort();
  sky[y] = row[Math.floor(W * 0.12)];
}
const skyS = new Float32Array(H);
for (let y = 0; y < H; y++) {
  let s = 0;
  let n = 0;
  for (let k = -24; k <= 24; k++) {
    const j = Math.min(H - 1, Math.max(0, y + k));
    s += sky[j];
    n++;
  }
  skyS[y] = s / n;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const alpha = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  const lo = skyS[y] + (1 - skyS[y]) * 0.22;
  const hi = skyS[y] + (1 - skyS[y]) * 0.68;
  for (let x = 0; x < W; x++) alpha[y * W + x] = smooth(lo, hi, white[y * W + x]);
}

// the sun itself, and the haze glaring round it, are white too but are not cloud: find it, and near it ask for more
let sun = 0;
for (let i = 0; i < W * H; i++) if (lum[i] > lum[sun]) sun = i;
const sx = sun % W;
const sy = Math.floor(sun / W);
const dir = (x, y) => {
  const az = (x / W) * Math.PI * 2;
  const el = (1 - y / H) * (Math.PI / 2);
  return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
};
const sd = dir(sx, sy);
const toSun = (x, y) => {
  const d = dir(x, y);
  return d[0] * sd[0] + d[1] * sd[1] + d[2] * sd[2];
};
const rad = (deg) => (deg * Math.PI) / 180;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const glare = smooth(Math.cos(rad(38)), Math.cos(rad(10)), toSun(x, y));
    if (glare > 0) alpha[y * W + x] *= 1 - glare * (1 - smooth(0.8, 0.96, white[y * W + x]));
  }
}
const blur = (src, r) => {
  const tmp = new Float32Array(W * H);
  const dst = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[y * W + ((k + W) % W)];
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = sum / (2 * r + 1);
      sum += src[y * W + ((x + r + 1) % W)] - src[y * W + ((x - r + W) % W)]; // round the compass
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
    for (let y = 0; y < H; y++) {
      dst[y * W + x] = sum / (2 * r + 1);
      sum += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return dst;
};
// scraps of cloud a degree across are specks in a night sky, not clouds: only what has cloud round it stays
{
  const around = blur(alpha, 7);
  for (let i = 0; i < W * H; i++) alpha[i] *= smooth(0.2, 0.55, around[i]);
}

const hist = [];
for (let i = 0; i < W * H; i += 7) if (alpha[i] > 0.6) hist.push(lum[i]);
hist.sort((a, b) => a - b);
const dark = hist[Math.floor(hist.length * 0.03)];
const bright = hist[Math.floor(hist.length * 0.97)];
const shade = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const near = smooth(Math.cos(rad(14)), Math.cos(rad(3)), toSun(x, y));
    let s = Math.min(1, Math.max(0, (lum[i] - dark) / (bright - dark)));
    s = s * (1 - near) + Math.min(s, 0.72) * near; // no white-hot patch where the sun stood behind the cloud
    shade[i] = s;
  }
}

// A cloud's edge is half cloud, half sky, and in the photograph the sky half is dark blue: lit from that, every cloud
// would wear a dark outline. So the lighting is spread outward from each cloud into the clear sky round it (an
// average of the cloud nearby, weighted by how much cloud there is), and the edge takes its cloud's own brightness.
const lit = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) lit[i] = shade[i] * alpha[i];
const num = new Float32Array(W * H);
const den = new Float32Array(W * H);
for (const [r, weight] of [[3, 1], [9, 0.2], [27, 0.04], [81, 0.008]]) {
  const n = blur(lit, r);
  const d = blur(alpha, r);
  for (let i = 0; i < W * H; i++) {
    num[i] += n[i] * weight;
    den[i] += d[i] * weight;
  }
}
for (let i = 0; i < W * H; i++) {
  const own = smooth(0.7, 1, alpha[i]); // only solid cloud speaks for itself
  shade[i] = own * shade[i] + (1 - own) * (den[i] > 1e-5 ? num[i] / den[i] : 0.5);
}

const px = Buffer.alloc(W * H * 2);
for (let i = 0; i < W * H; i++) {
  px[i] = Math.round(alpha[i] * 255);
  px[W * H + i] = Math.round(shade[i] * 255);
}
await sharp(px, { raw: { width: W, height: H * 2, channels: 1 } }).webp({ quality: 84, effort: 5 }).toFile(out);
let cover = 0;
for (let i = 0; i < W * H; i++) cover += alpha[i];
console.log(`clouds: sun at azimuth ${Math.round((sx / W) * 360)}°, elevation ${Math.round((1 - sy / H) * 90)}°; ${Math.round((cover / (W * H)) * 100)} % of the picture is cloud`);
