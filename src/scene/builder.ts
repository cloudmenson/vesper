import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Noise } from '../core/math';

export function xf(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Box-projected UVs in world metres, chosen per triangle so textures never stretch. */
function worldUV(g: THREE.BufferGeometry, tile: number, rot: boolean) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const nx = Math.abs(n.x);
    const ny = Math.abs(n.y);
    const nz = Math.abs(n.z);
    for (let k = 0; k < 3; k++) {
      const p = k === 0 ? a : k === 1 ? b : c;
      let u: number;
      let v: number;
      if (ny >= nx && ny >= nz) {
        u = p.x;
        v = p.z;
      } else if (nx >= nz) {
        u = p.z;
        v = p.y;
      } else {
        u = p.x;
        v = p.y;
      }
      uv[(i + k) * 2] = (rot ? v : u) / tile;
      uv[(i + k) * 2 + 1] = (rot ? u : v) / tile;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * UVs for a box-shaped piece of timber: the texture runs along the longer side of every face,
 * and each piece starts somewhere different on the board so no two look alike.
 */
let pieces = 0;
function grainUV(g: THREE.BufferGeometry, dims: [number, number, number], tile: number) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const seed = ++pieces;
  const ou = (seed * 0.6180339) % 1;
  const ov = (seed * 0.3819660) % 1;
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    const an = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
    const axis = an[1] >= an[0] && an[1] >= an[2] ? 1 : an[0] >= an[2] ? 0 : 2;
    const [p, q] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    const [u, v] = dims[p] >= dims[q] ? [p, q] : [q, p];
    for (let k = 0; k < 3; k++) {
      const vtx = k === 0 ? a : k === 1 ? b : c;
      uv[(i + k) * 2] = vtx.getComponent(u) / tile + ou;
      uv[(i + k) * 2 + 1] = vtx.getComponent(v) / tile + ov;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.userData.uvDone = true;
}

/** A box whose texture follows its grain — for instanced slats and fins. */
export function timber(w: number, h: number, d: number, tile = 1.3) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  grainUV(g, [w, h, d], tile);
  return g;
}

/* ------------------------------------------------------------- lightmap atlas */

/** Side of the square atlas that baked lighting is stored in. */
export const LM_SIZE = 2048;

interface Chart {
  w: number; // metres
  h: number;
  mult: number;
  x: number; // texels, filled in by the packer
  y: number;
  pw: number;
  ph: number;
}

/**
 * Lightmap charts for one piece. Every piece the builder makes is convex (boxes, cylinders, spheres),
 * so projecting each face along the axis it mostly looks down gives at most six charts that never overlap.
 * Writes a temporary `lm` attribute: metres within the chart, and which chart.
 */
function chartPiece(g: THREE.BufferGeometry, mult: number) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const lm = new Float32Array(pos.count * 3);
  g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3());
  const charts: Chart[] = [];
  if (Math.max(size.x, size.y, size.z) < 0.07) {
    // a pin, a pen, a candle wick: one sample of light is all it needs
    charts.push({ w: 0, h: 0, mult, x: 0, y: 0, pw: 0, ph: 0 });
  } else {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const lo = Array.from({ length: 6 }, () => [Infinity, Infinity]);
    const hi = Array.from({ length: 6 }, () => [-Infinity, -Infinity]);
    const slot = new Int8Array(6).fill(-1);
    const which = new Uint8Array(pos.count);
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const an = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
      const axis = an[1] >= an[0] && an[1] >= an[2] ? 1 : an[0] >= an[2] ? 0 : 2;
      const id = axis * 2 + (n.getComponent(axis) >= 0 ? 1 : 0);
      const [U, V] = axis === 0 ? [2, 1] : axis === 1 ? [0, 2] : [0, 1];
      for (let k = 0; k < 3; k++) {
        const v = k === 0 ? a : k === 1 ? b : c;
        const u = v.getComponent(U);
        const w = v.getComponent(V);
        lm[(i + k) * 3] = u;
        lm[(i + k) * 3 + 1] = w;
        which[i + k] = id;
        lo[id][0] = Math.min(lo[id][0], u);
        lo[id][1] = Math.min(lo[id][1], w);
        hi[id][0] = Math.max(hi[id][0], u);
        hi[id][1] = Math.max(hi[id][1], w);
      }
    }
    for (let id = 0; id < 6; id++) {
      if (lo[id][0] === Infinity) continue;
      slot[id] = charts.length;
      charts.push({ w: hi[id][0] - lo[id][0], h: hi[id][1] - lo[id][1], mult, x: 0, y: 0, pw: 0, ph: 0 });
    }
    for (let i = 0; i < pos.count; i++) {
      const id = which[i];
      lm[i * 3] -= lo[id][0];
      lm[i * 3 + 1] -= lo[id][1];
      lm[i * 3 + 2] = slot[id];
    }
  }
  g.setAttribute('lm', new THREE.BufferAttribute(lm, 3));
  g.userData.charts = charts;
}

/** Shelf-packs the charts at the highest texel density that still fits, and returns that density (texels per metre). */
function packCharts(charts: Chart[]) {
  const PAD = 3;
  const order = [...charts];
  const fits = (density: number) => {
    for (const c of charts) {
      c.pw = Math.max(2, Math.ceil(c.w * density * c.mult) + 1);
      c.ph = Math.max(2, Math.ceil(c.h * density * c.mult) + 1);
    }
    order.sort((p, q) => q.ph - p.ph);
    let x = PAD;
    let y = PAD;
    let row = 0;
    for (const c of order) {
      if (c.pw + PAD * 2 > LM_SIZE) return false;
      if (x + c.pw + PAD > LM_SIZE) {
        x = PAD;
        y += row + PAD;
        row = 0;
      }
      if (y + c.ph + PAD > LM_SIZE) return false;
      c.x = x;
      c.y = y;
      x += c.pw + PAD;
      row = Math.max(row, c.ph);
    }
    return true;
  };
  let lo = 2;
  let hi = 240;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  fits(lo);
  return lo;
}

/**
 * Collects static geometry per material and merges it into one mesh each,
 * so a house of ~1000 parts renders in a handful of draw calls.
 */
export class Builder {
  private buckets = new Map<string, { mat: THREE.Material; zone: string; list: THREE.BufferGeometry[] }>();
  private stack: THREE.Matrix4[] = [new THREE.Matrix4()];
  /** texels per metre of the packed lightmap, once built */
  density = 0;

  /**
   * `lightmap`: also give every piece a second UV set in a shared atlas, for baked lighting.
   * `lmScale` lets the caller spend fewer texels on pieces nobody sees up close.
   * `zoneOf` names the room a piece stands in: pieces are merged per material and room, so each room's
   * meshes can carry that room's reflections.
   */
  constructor(
    private lightmap = false,
    private lmScale: (centre: THREE.Vector3, size: THREE.Vector3) => number = () => 1,
    private zoneOf: (centre: THREE.Vector3) => string = () => '',
  ) {}

  private get top() {
    return this.stack[this.stack.length - 1];
  }

  push(m: THREE.Matrix4) {
    this.stack.push(this.top.clone().multiply(m));
  }

  pop() {
    this.stack.pop();
  }

  /** `dims` (the piece's own width, height, depth) lets wood materials lay their grain along it. */
  add(mat: THREE.Material, geo: THREE.BufferGeometry, local?: THREE.Matrix4, dims?: [number, number, number]) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (dims && mat.userData.grain) grainUV(g, dims, (mat.userData.tile as number) ?? 1);
    g.applyMatrix4(local ? this.top.clone().multiply(local) : this.top);
    for (const k of Object.keys(g.attributes)) {
      if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    }
    if (!g.userData.uvDone) worldUV(g, (mat.userData.tile as number) ?? 1, !!mat.userData.rot);
    g.computeBoundingBox();
    const centre = g.boundingBox!.getCenter(new THREE.Vector3());
    if (this.lightmap) chartPiece(g, this.lmScale(centre, g.boundingBox!.getSize(new THREE.Vector3())));
    const zone = this.zoneOf(centre);
    const key = `${mat.uuid}|${zone}`;
    let bucket = this.buckets.get(key);
    if (!bucket) this.buckets.set(key, (bucket = { mat, zone, list: [] }));
    bucket.list.push(g);
  }

  /** Box by min/max extents — the natural way to describe architecture. */
  mm(mat: THREE.Material, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
    const d: [number, number, number] = [Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)];
    this.add(mat, new THREE.BoxGeometry(...d), xf((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), d);
  }

  box(mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
    this.add(mat, new THREE.BoxGeometry(w, h, d), xf(x, y, z, rx, ry, rz), [w, h, d]);
  }

  rbox(
    mat: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    radius = 0.05,
    rx = 0,
    ry = 0,
    rz = 0,
  ) {
    this.add(mat, new RoundedBoxGeometry(w, h, d, 4, Math.min(radius, w / 2, h / 2, d / 2)), xf(x, y, z, rx, ry, rz), [w, h, d]);
  }

  /** Vertical cylinder centred at (x, y, z). */
  cyl(mat: THREE.Material, r: number, h: number, x: number, y: number, z: number, seg = 16, rTop = r, rx = 0, rz = 0) {
    this.add(mat, new THREE.CylinderGeometry(rTop, r, h, seg), xf(x, y, z, rx, 0, rz));
  }

  /** Cylinder between two points. */
  rod(mat: THREE.Material, r: number, a: THREE.Vector3Like, b: THREE.Vector3Like, seg = 8) {
    const va = new THREE.Vector3(a.x, a.y, a.z);
    const vb = new THREE.Vector3(b.x, b.y, b.z);
    const dir = vb.clone().sub(va);
    const len = dir.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    const m = new THREE.Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    this.add(mat, new THREE.CylinderGeometry(r, r, len, seg), m);
  }

  sphere(mat: THREE.Material, r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, seg = 16) {
    this.add(mat, new THREE.SphereGeometry(r, seg, Math.max(8, seg * 0.75) | 0), xf(x, y, z, 0, 0, 0, sx, sy, sz));
  }

  build(parent: THREE.Object3D, o: { cast?: boolean; receive?: boolean; order?: number } = {}) {
    const meshes: THREE.Mesh[] = [];
    if (this.lightmap) {
      // one atlas for everything this builder made
      const all = [...this.buckets.values()].flatMap((b) => b.list);
      this.density = packCharts(all.flatMap((g) => g.userData.charts as Chart[]));
      for (const g of all) {
        const charts = g.userData.charts as Chart[];
        const lm = g.attributes.lm as THREE.BufferAttribute;
        const uv1 = new Float32Array(lm.count * 2);
        for (let i = 0; i < lm.count; i++) {
          const c = charts[lm.getZ(i)];
          // keep samples half a texel inside the chart, so bilinear filtering never reaches a neighbour
          uv1[i * 2] = (c.x + 0.5 + (c.w > 0 ? lm.getX(i) / c.w : 0.5) * (c.pw - 1)) / LM_SIZE;
          uv1[i * 2 + 1] = (c.y + 0.5 + (c.h > 0 ? lm.getY(i) / c.h : 0.5) * (c.ph - 1)) / LM_SIZE;
        }
        g.deleteAttribute('lm');
        g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
      }
    }
    let index = 0;
    for (const { mat: src, zone, list } of this.buckets.values()) {
      const merged = mergeGeometries(list, false);
      if (!merged) continue;
      list.forEach((g) => g.dispose());
      // lightmapped meshes get their own copy of the material: the same oak is used elsewhere without a second UV set
      const mat = this.lightmap ? src.clone() : src;
      if (this.lightmap) mat.userData = { ...src.userData };
      const mesh = new THREE.Mesh(merged, mat);
      if (this.lightmap) {
        mesh.name = `lm_${index++}`;
        mesh.userData.lightmapped = true;
      }
      mesh.userData.zone = zone;
      mesh.castShadow = o.cast ?? true;
      mesh.receiveShadow = o.receive ?? true;
      if (o.order !== undefined) mesh.renderOrder = o.order;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.buckets.clear();
    return meshes;
  }
}

/**
 * A piece of firewood lying along X: a wedge split from a trunk (or a whole round, `sector` = 1), a little
 * crooked, no two alike. Returned as its two skins — bark on the outside, pale wood on the split faces and sawn
 * ends — so a pile of them can be merged into two meshes.
 */
export function logGeometry(length: number, radius: number, sector: number, seed: number) {
  const n = new Noise(seed);
  const NA = Math.max(4, Math.round(10 * sector));
  const NL = 6;
  const theta = sector * Math.PI * 2;
  const whole = sector > 0.99;
  const rad = (i: number, j: number) => radius * (1 + (n.fbm((i / NA) * 3 * sector + seed, (j / NL) * 2.2, 2) - 0.5) * 0.22) * (1 - 0.05 * Math.abs(j / NL - 0.5));
  const bend = (j: number, k: number) => (n.fbm((j / NL) * 1.4 + k * 9.7, seed * 1.3, 2) - 0.5) * radius * 0.3;
  const P = (i: number, j: number, r = 1): [number, number, number] => {
    const a = -theta / 2 + (theta * (whole ? i % NA : i)) / NA;
    const R = rad(whole ? i % NA : i, j) * r;
    return [(j / NL - 0.5) * length, Math.cos(a) * R + bend(j, 0), Math.sin(a) * R + bend(j, 1)];
  };
  const make = (pos: number[], uv: number[], idx: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  // bark
  const bp: number[] = [];
  const bu: number[] = [];
  const bi: number[] = [];
  for (let j = 0; j <= NL; j++) {
    for (let i = 0; i <= NA; i++) {
      bp.push(...P(i, j));
      bu.push(((j / NL) * length) / 0.4 + seed * 0.37, ((i / NA) * theta * radius) / 0.4);
    }
  }
  const at = (i: number, j: number) => j * (NA + 1) + i;
  for (let j = 0; j < NL; j++) for (let i = 0; i < NA; i++) bi.push(at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));

  // wood: the two split faces, then the ends
  const wp: number[] = [];
  const wu: number[] = [];
  const wi: number[] = [];
  const axis = (j: number): [number, number, number] => [(j / NL - 0.5) * length, bend(j, 0) + (whole ? 0 : (n.value(j * 3.1, seed) - 0.5) * radius * 0.12), bend(j, 1)];
  if (!whole) {
    for (const side of [0, 1]) {
      const base = wp.length / 3;
      for (let j = 0; j <= NL; j++) {
        wp.push(...axis(j), ...P(side ? NA : 0, j));
        wu.push(((j / NL) * length) / 0.3 + seed * 0.61, side, ((j / NL) * length) / 0.3 + seed * 0.61, side + radius / 0.3);
      }
      for (let j = 0; j < NL; j++) {
        const c0 = base + j * 2;
        const e0 = c0 + 1;
        const c1 = c0 + 2;
        const e1 = c0 + 3;
        if (side) wi.push(c0, c1, e0, e0, c1, e1);
        else wi.push(c0, e0, c1, e0, e1, c1);
      }
    }
  }
  for (const end of [0, NL]) {
    const base = wp.length / 3;
    const c = axis(end);
    wp.push(...c);
    wu.push(0.5 + seed * 0.13, 0.5);
    for (let i = 0; i <= NA; i++) {
      const p = P(i, end);
      wp.push(...p);
      wu.push(0.5 + seed * 0.13 + (p[2] - c[2]) / 0.2, 0.5 + (p[1] - c[1]) / 0.2);
    }
    for (let i = 0; i < NA; i++) {
      if (end) wi.push(base, base + 1 + i, base + 2 + i);
      else wi.push(base, base + 2 + i, base + 1 + i);
    }
  }
  return { bark: make(bp, bu, bi), wood: make(wp, wu, wi) };
}

/** Merges a pile of logs into two meshes' worth of geometry. */
export function logPile(logs: { length: number; radius: number; sector: number; seed: number; at: THREE.Matrix4 }[]) {
  const barks: THREE.BufferGeometry[] = [];
  const woods: THREE.BufferGeometry[] = [];
  for (const l of logs) {
    const g = logGeometry(l.length, l.radius, l.sector, l.seed);
    barks.push(g.bark.applyMatrix4(l.at));
    woods.push(g.wood.applyMatrix4(l.at));
  }
  return { bark: mergeGeometries(barks, false)!, wood: mergeGeometries(woods, false)! };
}
