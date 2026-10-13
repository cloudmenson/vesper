import * as THREE from 'three';
import { Noise, rng } from '../core/math';

function canvasOf(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(c: HTMLCanvasElement, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Per-pixel painter. `fn` writes sRGB 0..1 into `out` and returns a height 0..1. */
function paint(size: number, fn: (u: number, v: number, out: Float32Array) => number) {
  const canvas = canvasOf(size);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const height = new Float32Array(size * size);
  const out = new Float32Array(3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      height[i] = fn(x / size, y / size, out);
      d[i * 4] = out[0] * 255;
      d[i * 4 + 1] = out[1] * 255;
      d[i * 4 + 2] = out[2] * 255;
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, ctx, height };
}

function normalFromHeight(height: Float32Array, size: number, strength: number) {
  const canvas = canvasOf(size);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const yu = ((y - 1 + size) % size) * size;
    const yd = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const hl = height[y * size + ((x - 1 + size) % size)];
      const hr = height[y * size + ((x + 1) % size)];
      const hu = height[yu + x];
      const hd = height[yd + x];
      let nx = (hl - hr) * strength;
      let ny = (hd - hu) * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv;
      ny *= inv;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return toTexture(canvas, false);
}

export interface TexSet {
  map: THREE.Texture;
  normal: THREE.Texture;
}

/** Honed basalt: near-black, fine-grained, with the faint clouding of a real slab and no veins to repeat. */
export function stoneTexture(seed: number): TexSet {
  const size = 512;
  const n = new Noise(seed);
  const r = rng(seed);
  const { canvas, height } = paint(size, (u, v, out) => {
    const cloud = n.fbm(u * 3, v * 3, 4, 3);
    const grain = n.fbm(u * 60, v * 60, 2, 60);
    const fleck = r() > 0.992 ? 0.05 : 0;
    const c = 0.072 + cloud * 0.03 + (grain - 0.5) * 0.016 + fleck;
    out[0] = c;
    out[1] = c * 1.01;
    out[2] = c * 1.04;
    return cloud * 0.25 + grain * 0.75;
  });
  return { map: toTexture(canvas), normal: normalFromHeight(height, size, 0.5) };
}

/** Where a burning log glows: thin bright cracks between dark plates of char, and a few patches burnt right through. */
export function emberTexture(seed: number) {
  const n = new Noise(seed);
  const { canvas } = paint(256, (u, v, out) => {
    const crack = Math.pow(1 - Math.abs(n.fbm(u * 7, v * 7, 3, 7) * 2 - 1), 9);
    const patch = Math.pow(Math.max(0, n.fbm(u * 3 + 4.2, v * 3 + 1.1, 3, 3) - 0.48) * 2.6, 2);
    const e = Math.min(1, crack * 0.9 + patch);
    out[0] = out[1] = out[2] = e;
    return e;
  });
  return toTexture(canvas);
}

/** The monitor in the study: a CAD view of the house you are standing in. */
