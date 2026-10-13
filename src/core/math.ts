export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t), 4);
export const easeInOut = (t: number) => {
  t = clamp(t);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
export const damp = (a: number, b: number, lambda: number, dt: number) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise with optional per-axis period, so textures tile. */
export class Noise {
  private p = new Uint8Array(512);
  private g = new Float32Array(256);

  constructor(seed = 1) {
    const r = rng(seed);
    const perm = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
    for (let i = 0; i < 256; i++) this.g[i] = r();
  }

  private lat(ix: number, iy: number, px: number, py: number) {
    if (px > 0) ix = ((ix % px) + px) % px;
    if (py > 0) iy = ((iy % py) + py) % py;
    return this.g[this.p[(this.p[ix & 255] + iy) & 255]];
  }

  value(x: number, y: number, px = 0, py = px) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const a = this.lat(ix, iy, px, py);
    const b = this.lat(ix + 1, iy, px, py);
    const c = this.lat(ix, iy + 1, px, py);
    const d = this.lat(ix + 1, iy + 1, px, py);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  fbm(x: number, y: number, oct = 4, px = 0, py = px) {
    let amp = 0.5;
    let sum = 0;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < oct; i++) {
      sum += amp * this.value(x * f, y * f, px * f, py * f);
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }
}

/** Monotone cubic (Fritsch–Carlson) through scalar keys — smooth, never overshoots. */
export class Curve1 {
  private m: number[];

  constructor(
    private xs: number[],
    private ys: number[],
  ) {
    const n = xs.length;
    const d: number[] = [];
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    const m = new Array<number>(n).fill(0);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const t = 3 / Math.sqrt(s);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
    this.m = m;
  }

  at(x: number) {
    const { xs, ys, m } = this;
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  }
}
