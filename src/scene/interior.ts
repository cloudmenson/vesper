import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { xf, timber, logPile, type Builder } from './builder';
import { F0, C0, F1, C1, SKYLIGHT, HEARTH, type Ctx } from './house';
import { Noise, rng } from '../core/math';
import type { Assets, ModelId } from './assets';
import type { Zone } from './materials';
import { site } from '../content';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const HALF = Math.PI / 2;
/** how far the record player's arm swings in from its rest to the outer groove, radians */
const ARM = -0.33;
/** the colour of light from burning wood, about 1900 K */
const FIRELIGHT = 0xffa35c;

/** A flat piece that keeps its own 0–1 texture mapping (a canvas, a sheet of paper) but is lightmapped like the rest. */
function flat(b: Builder, mat: THREE.Material, geo: THREE.BufferGeometry, at: THREE.Matrix4) {
  const g = geo.toNonIndexed();
  g.userData.uvDone = true;
  b.add(mat, g, at);
}

/** A copy of a fabric with its weave laid `u` × `v` times across the model's own mapping. */
function scaled(base: THREE.MeshStandardMaterial, u: number, v = u) {
  const mat = base.clone();
  mat.userData = { ...base.userData };
  for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap'] as const) {
    const t = base[key];
    if (!t) continue;
    const copy = t.clone();
    copy.repeat.set(u, v);
    mat[key] = copy;
  }
  return mat;
}

/** A texture's brightness alone, for a back-light drawn in a colour the room would rather not have. */
function brightness(src: THREE.Texture) {
  const img = src.image as CanvasImageSource & { width: number; height: number };
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < px.data.length; i += 4) px.data[i] = px.data[i + 1] = px.data[i + 2] = Math.max(px.data[i], px.data[i + 1], px.data[i + 2]);
  ctx.putImageData(px, 0, 0);
  const out = new THREE.CanvasTexture(canvas);
  out.flipY = src.flipY;
  out.wrapS = src.wrapS;
  out.wrapT = src.wrapT;
  out.colorSpace = src.colorSpace;
  out.channel = src.channel;
  return out;
}

const wear = (o: THREE.Object3D, mat: THREE.Material) => o.traverse((m) => ((m as THREE.Mesh).isMesh ? ((m as THREE.Mesh).material = mat) : 0));

export function furnish(c: Ctx) {
  const { b, e, g, m, group, assets } = c;
  const led = m.glow(0xffcb94, 1.3, 'ground', 2.6);
  const ledLow = m.glow(0xffcb94, 1.3, 'ground', 1.1); // a strip right over the things it lights
  const stick = m.glow(0xffd6a8, 1.7, 'ground', 3.6);
  const soft = m.glow(0xffd9b0, 0.9, 'ground');
  soft.userData.bakeOnly = true; // lights the slats from above in the bake; drawn, it only shimmered between them
  const spotOn = m.glow(0xffd2a0, 1.6, 'ground', 0);
  const ledUp = m.glow(0xffcb94, 1.3, 'upper', 4.2);
  const spotUp = m.glow(0xffd2a0, 1.6, 'upper', 0);

  /* --- shared helpers --------------------------------------------------- */
  const put = (...a: Parameters<typeof assets.spawn>) => {
    const o = assets.spawn(...a);
    o.userData.noMirror = true; // too small to matter in the lake's reflection
    group.add(o);
    return o;
  };
  /**
   * Lowers or lifts an object until it stands on a surface at height `y`, wherever its own origin happens to be.
   * (Measured from its vertices, here and below: a scan whose mesh lies turned inside its file has a box of
   * corners much bigger than itself, and stood on that it floats.)
   */
  const stand = (o: THREE.Object3D, y: number) => {
    o.updateMatrixWorld(true);
    o.position.y += y - new THREE.Box3().setFromObject(o, true).min.y;
    return o;
  };
  /**
   * One object out of a model that holds several — the scans come laid out side by side like a catalogue page —
   * re-centred on its own footprint. Several names keep their places relative to each other (a pot and its lid).
   */
  const piece = (id: ModelId, ...names: string[]) => {
    const o = new THREE.Group();
    for (const name of names) o.add(assets.models[id].getObjectByName(name)!.clone(true));
    o.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(o, true);
    for (const inner of o.children) {
      inner.position.x -= (box.min.x + box.max.x) / 2;
      inner.position.y -= box.min.y;
      inner.position.z -= (box.min.z + box.max.z) / 2;
    }
    o.userData.noMirror = true;
    group.add(o);
    return o;
  };
  /**
   * Some of a model that holds a whole group of furniture standing as its maker arranged it: the meshes `keep`
   * picks, by name and by where they stand in the file, as one object centred on its own footprint.
   */
  const part = (id: ModelId, keep: (name: string, centre: THREE.Vector3) => boolean) => {
    const o = new THREE.Group();
    const centre = new THREE.Vector3();
    assets.models[id].updateMatrixWorld(true);
    assets.models[id].traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = unpacked(mesh);
      geo.computeBoundingBox();
      if (keep(mesh.name, geo.boundingBox!.getCenter(centre))) o.add(new THREE.Mesh(geo, mesh.material));
    });
    const box = new THREE.Box3().setFromObject(o, true);
    for (const inner of o.children) (inner as THREE.Mesh).geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    o.userData.noMirror = true;
    group.add(o);
    return o;
  };
  /**
   * Lets a scanned cushion down onto the upholstery it leans on. The cloth job stands each one by a single ray
   * cast under its middle, and a seat is not level: one stood on the crown of the seat cushion hangs in the air
   * over the seam beside it. Here the gap under the cushion's own lowest edge is measured, and closed.
   */
  const seatOn = (root: THREE.Object3D, cushion: RegExp, onto: RegExp, also: THREE.Object3D[] = []) => {
    root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const points = (mesh: THREE.Mesh) => {
      const p = mesh.geometry.attributes.position;
      const out = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld).toArray(out, i * 3);
      return out;
    };
    const under: Float32Array[] = [];
    const cushions: THREE.Mesh[] = [];
    root.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (cushion.test(mesh.name)) cushions.push(mesh);
      else if (onto.test(mesh.name)) under.push(points(mesh));
    });
    for (const o of also) {
      o.updateMatrixWorld(true);
      o.traverse((n) => (n as THREE.Mesh).isMesh && under.push(points(n as THREE.Mesh)));
    }
    for (const mesh of cushions) {
      const own = points(mesh);
      let lowest = Infinity;
      for (let i = 1; i < own.length; i += 3) lowest = Math.min(lowest, own[i]);
      const gaps: number[] = [];
      const step = Math.max(1, Math.floor(own.length / 3 / 4000)) * 3;
      for (let i = 0; i < own.length && gaps.length < 80; i += step) {
        if (own[i + 1] > lowest + 0.02) continue;
        // what is under this point: the highest of the upholstery within 5 cm of it across
        let top = -Infinity;
        for (const pts of under) {
          for (let k = 0; k < pts.length; k += 3) {
            const dx = pts[k] - own[i];
            const dz = pts[k + 2] - own[i + 2];
            if (dx * dx + dz * dz < 0.0025 && pts[k + 1] < own[i + 1] + 0.03 && pts[k + 1] > top) top = pts[k + 1];
          }
        }
        if (top > -Infinity) gaps.push(own[i + 1] - top);
      }
      if (!gaps.length) continue;
      gaps.sort((p, q) => p - q);
      mesh.position.y -= Math.max(0, gaps[gaps.length >> 1]) + 0.004; // and a few millimetres into it, as a weight on a cushion goes
    }
  };
  /**
   * Tips a scanned cushion back, about the edge it stands on, until it comes to rest against what is behind it
   * (toward -z). Stood upright by the cloth job with a hand's breadth of air behind it, a cushion looks held up
   * by nothing; a cushion on a bed leans.
   */
  const leanBack = (root: THREE.Object3D, cushion: RegExp, onto: RegExp) => {
    root.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const points = (mesh: THREE.Mesh) => {
      const p = mesh.geometry.attributes.position;
      const out = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) v.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld).toArray(out, i * 3);
      return out;
    };
    const behind: Float32Array[] = [];
    const cushions: THREE.Mesh[] = [];
    root.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (cushion.test(mesh.name)) cushions.push(mesh);
      else if (onto.test(mesh.name)) behind.push(points(mesh));
    });
    for (const mesh of cushions) {
      const own = points(mesh);
      let py = Infinity;
      let x0 = Infinity;
      let x1 = -Infinity;
      for (let i = 0; i < own.length; i += 3) {
        py = Math.min(py, own[i + 1]);
        x0 = Math.min(x0, own[i]);
        x1 = Math.max(x1, own[i]);
      }
      // the edge it stands on, and a sample of the rest of it
      let pz = 0;
      let n = 0;
      const upper: number[] = [];
      const step = Math.max(1, Math.floor(own.length / 3 / 260)) * 3;
      for (let i = 0; i < own.length; i += 3) {
        if (own[i + 1] < py + 0.03) {
          pz += own[i + 2];
          n++;
        } else if (i % step === 0 && own[i + 1] > py + 0.1) upper.push(own[i], own[i + 1] - py, own[i + 2]);
      }
      pz /= n;
      // what it could come to rest on: only what is behind it and no wider than it
      const rest: number[] = [];
      for (const pts of behind) for (let k = 0; k < pts.length; k += 3) if (pts[k] > x0 - 0.03 && pts[k] < x1 + 0.03 && pts[k + 1] > py + 0.06) rest.push(pts[k], pts[k + 1] - py, pts[k + 2] - pz);
      let lean = 0;
      search: for (let deg = 1; deg <= 48; deg++) {
        const c = Math.cos((deg * Math.PI) / 180);
        const sn = Math.sin((deg * Math.PI) / 180);
        for (let i = 0; i < upper.length; i += 3) {
          const dz = upper[i + 2] - pz;
          const y = upper[i + 1] * c + dz * sn;
          const z = dz * c - upper[i + 1] * sn;
          for (let k = 0; k < rest.length; k += 3) {
            const ex = rest[k] - upper[i];
            const ey = rest[k + 1] - y;
            const ez = rest[k + 2] - z;
            if (ex * ex + ey * ey + ez * ez < 0.00035) break search; // within 19 mm: touching
          }
        }
        lean = deg;
      }
      if (!lean || lean >= 48) continue; // nothing behind it to lean on
      const tip = new THREE.Matrix4().makeTranslation(0, py, pz).multiply(new THREE.Matrix4().makeRotationX((-lean * Math.PI) / 180)).multiply(new THREE.Matrix4().makeTranslation(0, -py, -pz));
      const parent = mesh.parent!.matrixWorld;
      mesh.updateMatrix();
      mesh.applyMatrix4(parent.clone().invert().multiply(tip).multiply(parent));
      mesh.updateMatrixWorld(true);
    }
  };
  /** `piece`, placed. */
  const at = (o: THREE.Object3D, x: number, y: number, z: number, ry = 0, scale = 1) => {
    o.position.set(x, y, z);
    o.rotation.y = ry;
    o.scale.setScalar(scale);
    return o;
  };
  /** Takes a scan's colours down: some arrive close to white and read as lamps under a light. */
  const tone = (o: THREE.Object3D, k: number) =>
    o.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const dim = (mat: THREE.Material) => {
        const copy = (mat as THREE.MeshStandardMaterial).clone();
        copy.color.multiplyScalar(k);
        return copy;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(dim) : dim(mesh.material);
    });
  /** A mixer tap: a foot, a swan neck whose spout reaches `reach` toward (dx, dz), and a lever. */
  const tap = (x: number, y: number, z: number, dx: number, dz: number, height = 0.3, reach = 0.19) => {
    const P = (out: number, up: number) => new THREE.Vector3(x + dx * out, y + up, z + dz * out);
    const neck = new THREE.CatmullRomCurve3([P(0, 0.02), P(0, height * 0.7), P(reach * 0.12, height * 0.94), P(reach * 0.5, height), P(reach * 0.88, height * 0.93), P(reach, height * 0.8)]);
    const parts = [
      new THREE.TubeGeometry(neck, 40, 0.0105, 10),
      new THREE.CylinderGeometry(0.023, 0.026, 0.05, 20).translate(x, y + 0.025, z),
      new THREE.CylinderGeometry(0.006, 0.006, 0.075, 8).rotateZ(HALF).rotateY(Math.atan2(dx, dz)).translate(x - dz * 0.045, y + 0.04, z + dx * 0.045),
    ];
    const mesh = new THREE.Mesh(mergeGeometries(parts.map((q) => q.toNonIndexed()), false)!, m.brass);
    mesh.userData.noMirror = true;
    group.add(mesh);
  };
  /** A cup standing on its saucer. */
  const cupAndSaucer = (x: number, y: number, z: number, ry: number, k: number, which: 1 | 2 = 1) => {
    at(piece('tea_set_01', which === 1 ? 'tea_set_01_saucer_circular_03' : 'tea_set_01_saucer_circular_04'), x, y, z, ry, k);
    at(piece('tea_set_01', which === 1 ? 'tea_set_01_cup_small_01' : 'tea_set_01_cup_small_02'), x, y + 0.011 * k, z, ry, k);
  };
  /**
   * A model that arrives in someone else's units and off its own origin, brought to a real size: `h` metres tall
   * (or `w` wide, or `l` long), its footprint centred on the origin, standing on y = 0.
   */
  const fit = (id: ModelId, size: { h?: number; w?: number; l?: number }) => {
    const inner = assets.models[id].clone(true);
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(inner, true);
    const dim = box.getSize(new THREE.Vector3());
    const k = size.h ? size.h / dim.y : size.w ? size.w / dim.x : size.l! / dim.z;
    const mid = new THREE.Group();
    mid.scale.setScalar(k);
    mid.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k);
    mid.add(inner);
    const o = new THREE.Group();
    o.add(mid);
    o.userData.noMirror = true;
    group.add(o);
    return o;
  };
  /** Gives each mesh of a model its cloth: the first rule whose pattern matches the mesh's name, or `otherwise`. */
  const dress = (o: THREE.Object3D, rules: [RegExp, (own: THREE.MeshStandardMaterial) => THREE.Material][], otherwise: THREE.Material) =>
    o.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const rule = rules.find(([re]) => re.test(mesh.name));
      mesh.material = rule ? rule[1](mesh.material as THREE.MeshStandardMaterial) : otherwise;
    });
  /**
   * One of the four knotted carpets (scanned as a set, lying in a row in their file), laid on a floor with its long
   * side `length` and turned `ry`. It goes in with the house proper rather than as a loose object, so that whatever
   * stands on it leaves its shadow in the baked light.
   */
  const carpets = new Map<THREE.Material, THREE.Material>();
  const carpet = (n: 1 | 2 | 3 | 4, length: number, x: number, y: number, z: number, ry = 0) => {
    // (they were scanned as thrown down, one with a corner turned back: here each is laid out flat)
    let src: THREE.Mesh | undefined;
    assets.models.rugs.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name.includes(`Carpet_0${n}`)) src = o as THREE.Mesh;
    });
    const geo = unpacked(src!).toNonIndexed();
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const k = length / (bb.max.x - bb.min.x);
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
    geo.scale(1, 0.06, 1);
    geo.computeVertexNormals();
    geo.userData.uvDone = true;
    const own = src!.material as THREE.MeshStandardMaterial;
    let mat = carpets.get(own);
    if (!mat) {
      const wool = own.clone();
      wool.aoMap = null; // the room's own baked light does this job
      wool.metalnessMap = null;
      wool.metalness = 0;
      wool.side = THREE.FrontSide;
      wool.userData = {};
      carpets.set(own, (mat = wool));
    }
    b.add(mat, geo, xf(x, y, z, 0, ry, 0, k));
  };
  /** a scanned cushion as it was photographed */
  const asIs = (own: THREE.MeshStandardMaterial) => own;
  /** a scanned cushion's own weave (its normal map) in a plain colour instead of its print */
  const plain = (hex: number) => (own: THREE.MeshStandardMaterial) => {
    const mat = own.clone();
    mat.map = null;
    mat.color.setHex(hex);
    return mat;
  };
  /** A pleated linen curtain (simulated hanging, scripts/cloth.py) with its rail. */
  const drapeMat = scaled(m.linen, (1.12 * 1.8) / 0.45, 3 / 0.45);
  drapeMat.side = THREE.DoubleSide;
  drapeMat.color.setHex(0xd8d2c6); // the same linen as the sheer by the door, a little heavier
  const drape = (x: number, y0: number, y1: number, z: number) => {
    const o = put('drape', x, y0, z);
    o.scale.set(1, (y1 - y0) / 3, 1);
    wear(o, drapeMat);
    // A drape hangs just inside the glass, where the one live light — the sun, for the world outside — still reaches
    // with its shadow map; and on pleats that map shows as a staircase of blocks. The sun may light a drape, but
    // nothing drawn into that map is cast on it.
    o.traverse((n) => (n.receiveShadow = false));
    b.mm(m.steel, x - 0.62, x + 0.62, y1, y1 + 0.02, z - 0.04, z + 0.04);
  };
  /** Small recessed downlight in a ceiling. */
  const downlight = (mat: THREE.Material, x: number, y: number, z: number, cd = 22) => {
    b.cyl(m.steel, 0.055, 0.012, x, y - 0.006, z, 16);
    e.cyl(mat, 0.036, 0.004, x, y - 0.014, z, 14);
    c.down(x, y - 0.03, z, cd);
  };
  const framed = (x: number, y: number, z: number, ry: number, scale = 1) => put('hanging_picture_frame_01', x, y, z, ry, scale);
  /**
   * Puts a painting in a frame. The scanned frames all come with the same sheet of paper in them; the picture goes
   * on that sheet's panel, fitted to the part of the mapping the panel uses.
   */
  const hang = (frame: THREE.Object3D, name: keyof Assets['frames']) => {
    frame.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh || !/_artwork$/.test((mesh.material as THREE.Material).name)) return;
      const own = mesh.material as THREE.MeshStandardMaterial;
      const uv = mesh.geometry.attributes.uv;
      // where the panel sits in the frame's own artwork image (the file stores the mapping scaled: undo that first)
      const r = own.map?.repeat ?? new THREE.Vector2(1, 1);
      const o = own.map?.offset ?? new THREE.Vector2(0, 0);
      let u0 = Infinity;
      let u1 = -Infinity;
      let v0 = Infinity;
      let v1 = -Infinity;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i) * r.x + o.x;
        const v = uv.getY(i) * r.y + o.y;
        u0 = Math.min(u0, u);
        u1 = Math.max(u1, u);
        v0 = Math.min(v0, v);
        v1 = Math.max(v1, v);
      }
      const map = assets.frames[name].clone();
      map.flipY = false; // the frame's mapping counts down from the top, as glTF does
      map.repeat.set(r.x / (u1 - u0), r.y / (v1 - v0));
      map.offset.set((o.x - u0) / (u1 - u0), (o.y - v0) / (v1 - v0));
      map.needsUpdate = true;
      const mat = own.clone();
      mat.map = map;
      mat.color.setScalar(0.92);
      mesh.material = mat;
    });
    return frame;
  };
  /**
   * A table lamp (Wayfair's "Iridescence Lamp"): a dark drum shade over a ball of glass. Only the shade's lining
   * glows, and its light leaves by the top and the bottom: a pool on the table, a wash on the ceiling.
   */
  const tableLamp = (x: number, y: number, z: number, cd: number, zone: Zone, ry = 0, scale = 1) => {
    const o = put('lamp_drum', x, y, z, ry, scale);
    m.ignite(o, /LampIridescence$/, 0xffc98f, 1.2, zone);
    // Its foot is a ball of clear iridescent glass in the model: here, glazed stoneware. (Seen through, the ball
    // showed whatever stood behind it broken into stripes, which read as a fault, not as glass.)
    o.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh || !/TransmissionIridescence$/.test((mesh.material as THREE.Material).name)) return;
      const glaze = (mesh.material as THREE.MeshPhysicalMaterial).clone();
      glaze.transmission = 0;
      glaze.iridescence = 0;
      glaze.thickness = 0;
      glaze.map = null;
      glaze.color.setHex(0x6f685d);
      glaze.roughness = 0.42;
      glaze.metalness = 0;
      // solid, though still drawn with the see-through things: that keeps it out of the light bake, as it was
      glaze.opacity = 1;
      glaze.depthWrite = true;
      glaze.userData.shine = 0.35;
      mesh.material = glaze;
    });
    c.lamp(x, y + 0.36 * scale, z, cd, 0xffd6a8, 0.05);
  };
  const volumes = shelfBooks(assets);
  /**
   * Dry branches standing in a vase: `height` of them showing above the point (x, y, z), which should be inside the neck.
   * The model has them lying down, so each is stood on its thick end and that end is put exactly on the vase's axis —
   * placed by its middle, a crooked branch ends up beside the vase instead of in it.
   */
  const branches = (x: number, y: number, z: number, height: number, turn: number) => {
    const p = new THREE.Vector3();
    for (const [name, k, lean, yaw] of [
      ['dry_branches_medium_01_b', 1, 0.07, 0],
      ['dry_branches_medium_01_c', 0.84, 0.13, 2.1],
      ['dry_branches_medium_01_a', 0.7, 0.16, 4.0],
    ] as const) {
      const o = piece('dry_branches_medium_01', name);
      const inner = o.children[0];
      /** where the branch's two ends are once it is upright, and how far each spreads from its own middle */
      const ends = () => {
        o.updateMatrixWorld(true);
        const pts: THREE.Vector3[] = [];
        inner.traverse((n) => {
          const mesh = n as THREE.Mesh;
          if (!mesh.isMesh) return;
          const pos = mesh.geometry.attributes.position;
          for (let i = 0; i < pos.count; i += 2) pts.push(p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).clone());
        });
        let lo = Infinity;
        let hi = -Infinity;
        for (const q of pts) {
          lo = Math.min(lo, q.y);
          hi = Math.max(hi, q.y);
        }
        const end = (from: number, to: number) => {
          const part = pts.filter((q) => q.y >= lo + (hi - lo) * from && q.y <= lo + (hi - lo) * to);
          const c = new THREE.Vector3();
          for (const q of part) c.add(q);
          c.multiplyScalar(1 / Math.max(part.length, 1));
          let spread = 0;
          for (const q of part) spread += Math.hypot(q.x - c.x, q.z - c.z);
          return { c, spread: spread / Math.max(part.length, 1) };
        };
        return { foot: end(0, 0.08), tip: end(0.8, 1), lo, hi };
      };
      inner.rotation.x = -HALF;
      let e = ends();
      if (e.foot.spread > e.tip.spread) {
        // the twigs were at the bottom: the other way up
        inner.rotation.x = HALF;
        e = ends();
      }
      inner.position.x -= e.foot.c.x;
      inner.position.y -= e.lo;
      inner.position.z -= e.foot.c.z;
      const tall = (height * k) / (e.hi - e.lo);
      o.rotation.order = 'YXZ';
      o.rotation.set(lean, turn + yaw, 0);
      o.scale.set(tall * 0.55, tall, tall * 0.55);
      o.position.set(x, y, z);
    }
  };

  /* ============================================================ LIVING */
  c.wash([4.0, C0 - 0.3, -3.7], [3.9, F0, -4.2], 42, 0.86, 0.35); // over the sofa

  // The sofa. Its frame is joinery; its seats, backs and arms are boxes of fabric filled and settled in Blender,
  // one against another; the three loose cushions are scans of real ones, leant where they touch the back.
  {
    const X0 = 4.05;
    const Z0 = -5.0;
    // the model's X runs the other way once it is turned to face the room: local (x, y, z) → (X0 − x, F0 + z, Z0 + y)
    b.mm(m.oakDark, X0 - 2.1, X0 + 2.1, F0 + 0.06, F0 + 0.2, Z0 - 0.62, Z0 + 0.5);
    b.mm(m.oakDark, X0 + 0.6, X0 + 1.76, F0 + 0.06, F0 + 0.2, Z0 + 0.5, Z0 + 1.5);
    b.mm(m.cladding, X0 - 2.0, X0 + 2.0, F0, F0 + 0.06, Z0 - 0.54, Z0 + 0.42);
    b.mm(m.cladding, X0 + 0.68, X0 + 1.68, F0, F0 + 0.06, Z0 + 0.42, Z0 + 1.42);
    b.rbox(m.sofa, 4.2, 0.56, 0.16, X0, F0 + 0.47, Z0 - 0.58, 0.05);
    const sofa = put('sofa', X0, F0, Z0, Math.PI);
    dress(
      sofa,
      [
        [/cushion_a/, asIs],
        [/cushion_b/, plain(0xb98a3c)],
        [/cushion_c/, plain(0x3f5143)],
      ],
      scaled(m.sofa, 1 / 0.3),
    );
    seatOn(sofa, /cushion/, /seat|arm/);
  }
  b.rbox(m.rug, 5.6, 0.018, 4.2, 4.2, F0 + 0.009, -3.85, 0.008);

  const TABLE = 0.49 * 0.92;
  put('coffee_table_round_01', 3.3, F0 + 0.018, -3.0, 0.4, 0.92);
  put('chess_set', 3.18, F0 + 0.018 + TABLE, -2.98, 0.5, 0.82);

  put('mid_century_lounge_chair', 0.9, F0, -4.5, 1.15);
  put('bronze_whale_statue', -0.5, F0, -1.35, 0.9, 0.55);

  // by the lounge chair: a slice of trunk on steel legs, a lamp, a book put down open-side-under
  // (it stands on the boards beside the rug, not half on its edge)
  at(fit('side_table_slice', { h: 0.5 }), 1.08, F0, -5.3, 0.4);
  tableLamp(1.05, F0 + 0.5, -5.34, 2.6, 'ground', 0.5, 0.92);

  // light stick in the corner
  b.cyl(m.steel, 0.13, 0.02, 6.85, F0 + 0.01, -6.6, 24);
  e.cyl(stick, 0.015, 1.55, 6.85, F0 + 0.8, -6.6, 10);
  c.lamp(6.75, F0 + 0.9, -6.5, 1.6, 0xffd6a8, 0.2);

  // firewood, split and stacked in a steel frame beside the hearth
  {
    const r = rng(8);
    const x0 = 7.36;
    const z0 = -7.55;
    b.mm(m.steel, x0 - 0.02, x0 + 0.42, F0, F0 + 0.02, z0, z0 + 0.72);
    for (const z of [z0, z0 + 0.7]) b.mm(m.steel, x0 - 0.02, x0 + 0.42, F0, F0 + 0.95, z, z + 0.02);
    b.mm(m.steel, x0 - 0.02, x0 + 0.42, F0 + 0.93, F0 + 0.95, z0, z0 + 0.72);
    const logs: Parameters<typeof logPile>[0] = [];
    for (let row = 0; row < 7; row++) {
      for (let k = 0; k < 5; k++) {
        const z = z0 + 0.1 + k * 0.128 + (row % 2) * 0.062 + (r() - 0.5) * 0.02;
        if (z > z0 + 0.64) continue;
        const radius = 0.062 + r() * 0.016;
        const sector = r() < 0.25 ? 1 : 0.3 + r() * 0.3;
        logs.push({ length: 0.36 + r() * 0.06, radius: sector === 1 ? radius * 0.75 : radius * 1.25, sector, seed: row * 7 + k + 1, at: xf(x0 + 0.2 + (r() - 0.5) * 0.03, F0 + 0.075 + row * 0.118, z, r() * 6.3, 0, 0) });
      }
    }
    const pile = logPile(logs);
    group.add(new THREE.Mesh(pile.bark, m.bark), new THREE.Mesh(pile.wood, m.woodRaw));
    // the axe that split them: head on the floor, handle leant against the side of the rack
    const axe = put('wooden_axe', x0 + 0.17, F0, z0 + 0.95, 0, 1.25);
    axe.rotation.set(-0.24, -HALF, Math.PI);
    stand(axe, F0);
  }
  hearth(HEARTH.x, HEARTH.y, HEARTH.z);

  // sideboard, the things on it, and the picture above
  const CAB = 1.25;
  const cabTop = F0 + 0.68 * CAB;
  put('modern_wooden_cabinet', 5.1, F0, -8.45, 0, CAB);
  // (its top runs from x = 3.58 to 6.62: nothing stands nearer an end than a hand's breadth)
  put('ceramic_vase_01', 3.98, cabTop, -8.45, 0, 1);
  branches(3.98, cabTop + 0.31, -8.45, 0.7, 0.4);
  put('ceramic_vase_04', 4.38, cabTop, -8.4, 1.2, 0.8);
  hang(put('standing_picture_frame_01', 5.48, cabTop, -8.36, -HALF + 0.25, 1.15), 'interior');
  put('marble_bust_01', 5.82, cabTop, -8.43, -0.3, 0.8);
  put('wicker_basket_01', 6.26, cabTop, -8.44, 0.1, 1.2);
  {
    // the framed picture: sized to the image, hung on the centre of the wall, lit by its own lamp
    const img = assets.painting.image as { width: number; height: number };
    const H = 1.52;
    const W = (H * img.width) / img.height;
    const x = 5.1;
    const y = F0 + 1.92;
    const mat = new THREE.MeshStandardMaterial({ map: assets.painting, roughness: 0.75 });
    flat(b, mat, new THREE.PlaneGeometry(W, H), xf(x, y, -8.762));
    const F = 0.035; // frame
    b.mm(m.cladding, x - W / 2 - F, x + W / 2 + F, y + H / 2, y + H / 2 + F, -8.8, -8.745);
    b.mm(m.cladding, x - W / 2 - F, x + W / 2 + F, y - H / 2 - F, y - H / 2, -8.8, -8.745);
    b.mm(m.cladding, x - W / 2 - F, x - W / 2, y - H / 2, y + H / 2, -8.8, -8.745);
    b.mm(m.cladding, x + W / 2, x + W / 2 + F, y - H / 2, y + H / 2, -8.8, -8.745);
    b.mm(m.steel, x - 0.36, x + 0.36, y + H / 2 + 0.11, y + H / 2 + 0.135, -8.8, -8.62);
    e.mm(led, x - 0.34, x + 0.34, y + H / 2 + 0.102, y + H / 2 + 0.11, -8.67, -8.635);
    c.wash([x, y + H / 2 + 0.1, -8.62], [x, y - 0.1, -8.77], 9, 0.75, 0.12);
  }

  // timber slat ceiling over the seating, softly lit from above
  {
    const xs: number[] = [];
    for (let x = 1.3; x <= 7.2; x += 0.115) xs.push(x);
    for (const x of xs) b.add(m.oak, timber(0.04, 0.07, 4.9), xf(x, C0 - 0.115, -4.0));
    e.mm(soft, 1.3, 7.2, C0 - 0.03, C0 - 0.02, -6.45, -1.55);
  }

  put('potted_plant_01', 6.9, F0, -0.95, 0.8, 1.55);
  drape(7.16, F0 + 0.02, C0 - 0.09, -0.24);
  drape(-7.16, F0 + 0.02, C0 - 0.09, -0.24);

  /* =========================================================== KITCHEN */
  // Tall units along the west wall: seven doors, with an open niche where two of them would be.
  {
    const X0 = -7.8;
    const X1 = -7.14; // the door fronts
    const [zA, zB] = [-8.8, -4.2];
    const [nz0, nz1] = [-6.4, -5.2]; // the niche: exactly two doors wide, so every joint still lands on a door edge
    const [ny0, ny1] = [F0 + 0.98, F0 + 1.56];
    b.mm(m.cladding, X0, X1 - 0.04, F0, F0 + 0.08, zA, zB);
    b.mm(m.oakDark, X0, X1, F0 + 0.08, ny0, zA, zB);
    b.mm(m.oakDark, X0, X1, ny1, F0 + 2.55, zA, zB);
    b.mm(m.oakDark, X0, X1, ny0, ny1, zA, nz0);
    b.mm(m.oakDark, X0, X1, ny0, ny1, nz1, zB);
    b.mm(m.cladding, X0, X0 + 0.16, ny0, ny1, nz0, nz1); // its back
    b.mm(m.stone, X0 + 0.16, X1 + 0.006, ny0, ny0 + 0.02, nz0, nz1); // a stone sill to stand things on
    e.mm(ledLow, X1 - 0.16, X1 - 0.12, ny1 - 0.012, ny1 - 0.004, nz0 + 0.04, nz1 - 0.04);
    for (let z = -8.2; z < -4.3; z += 0.6) {
      const inNiche = z > nz0 + 0.01 && z < nz1 - 0.01;
      const onEdge = Math.abs(z - nz0) < 0.01 || Math.abs(z - nz1) < 0.01;
      const joint = (y0: number, y1: number) => b.mm(m.cladding, X1 - 0.003, X1 + 0.004, y0, y1, z - 0.004, z + 0.004);
      joint(F0 + 0.08, ny0);
      joint(ny1, F0 + 2.55);
      if (!inNiche && !onEdge) joint(ny0, ny1);
    }
    // in the niche, standing on its sill
    const sill = ny0 + 0.02;
    put('ceramic_vase_02', -7.4, sill, -6.02, 0, 0.62);
    for (let i = 0; i < 3; i++) at(piece('tea_set_01', 'tea_set_01_plate_large_circular_03'), -7.38, sill + i * 0.011, -5.56, i * 0.7, 1);
    // a wash of light up the wall from the top of the units: without it the ceiling over the kitchen is a black lid
    const up = m.glow(0xffd9b0, 1, 'ground', 2.2);
    up.userData.bakeOnly = true;
    e.mm(up, X0 + 0.06, X1 - 0.2, F0 + 2.56, F0 + 2.565, zA + 0.1, zB - 0.1);
  }

  // The counter along the back wall, with a sink let into its stone top.
  {
    const [x0, x1] = [-7.14, -3.5];
    const top = F0 + 0.92;
    const [sx0, sx1, sz0, sz1] = [-6.5, -5.82, -8.66, -8.28]; // the bowl
    const floor = F0 + 0.72;
    b.mm(m.cladding, x0, x1, F0, F0 + 0.1, -8.8, -8.26);
    b.mm(m.oakDark, x0, x1, F0 + 0.1, floor, -8.8, -8.18);
    // carcass and stone, laid round the opening
    for (const [mat, y0, y1, zf, xr] of [
      [m.oakDark, floor, top - 0.04, -8.18, x1],
      [m.stone, top - 0.04, top, -8.14, x1 + 0.04],
    ] as const) {
      b.mm(mat, x0, sx0, y0, y1, -8.8, zf);
      b.mm(mat, sx1, xr, y0, y1, -8.8, zf);
      b.mm(mat, sx0, sx1, y0, y1, -8.8, sz0);
      b.mm(mat, sx0, sx1, y0, y1, sz1, zf);
    }
    // the bowl: brushed steel
    const T = 0.004;
    b.mm(m.steelLight, sx0, sx1, floor, floor + T, sz0, sz1);
    b.mm(m.steelLight, sx0, sx0 + T, floor, top - 0.002, sz0, sz1);
    b.mm(m.steelLight, sx1 - T, sx1, floor, top - 0.002, sz0, sz1);
    b.mm(m.steelLight, sx0, sx1, floor, top - 0.002, sz0, sz0 + T);
    b.mm(m.steelLight, sx0, sx1, floor, top - 0.002, sz1 - T, sz1);
    b.cyl(m.steel, 0.028, 0.004, (sx0 + sx1) / 2, floor + T + 0.002, (sz0 + sz1) / 2, 20);
    tap((sx0 + sx1) / 2, top, -8.72, 0, 1, 0.32, 0.2);
    // backsplash and the shelf over it
    b.mm(m.stone, x0, x1 + 0.04, top, F0 + 1.56, -8.8, -8.775);
    b.mm(m.oak, x0, x1 + 0.04, F0 + 1.56, F0 + 1.6, -8.8, -8.5);
    e.mm(ledLow, x0 + 0.04, x1, F0 + 1.54, F0 + 1.56, -8.76, -8.72);
    // three bottles standing together at the far end, as bottles do
    for (const [name, bx, bz, ry] of [
      ['wine_bottles_01_alsace', -4.02, -8.56, 0.4],
      ['wine_bottles_01_burgundy', -4.14, -8.5, 2.1],
      ['wine_bottles_01_bordeaux', -3.93, -8.47, 4.0],
    ] as const) {
      tone(at(piece('wine_bottles_01', name), bx, top, bz, ry), 0.4);
    }
    // crockery on the shelf: a stack of plates, a row of cups, one vase
    const shelf = F0 + 1.6;
    for (let i = 0; i < 4; i++) at(piece('tea_set_01', 'tea_set_01_plate_large_circular_03'), -6.75, shelf + i * 0.011, -8.64, i * 0.9, 1);
    for (let i = 0; i < 3; i++) at(piece('tea_set_01', i % 2 ? 'tea_set_01_cup_small_02' : 'tea_set_01_cup_small_01'), -6.42 + i * 0.13, shelf, -8.64, 0.5 + i * 1.3, 1);
    put('ceramic_vase_02', -3.95, shelf, -8.64, 2.0, 0.6);
  }

  // island: stone waterfall over oak
  b.mm(m.stone, -6.7, -3.7, F0 + 0.86, F0 + 0.92, -6.75, -5.65);
  b.mm(m.stone, -6.7, -6.64, F0, F0 + 0.86, -6.75, -5.65);
  b.mm(m.stone, -3.76, -3.7, F0, F0 + 0.86, -6.75, -5.65);
  b.mm(m.oakDark, -6.64, -3.76, F0 + 0.08, F0 + 0.86, -6.72, -5.98);
  b.mm(m.cladding, -6.64, -3.76, F0, F0 + 0.08, -6.68, -6.02);
  c.wash([-5.2, C0 - 0.3, -6.2], [-5.2, F0, -6.15], 62, 0.9, 0.35); // over the island
  put('potted_plant_04', -6.3, F0 + 0.92, -6.35, 0.5, 1.15);
  // a bowl of fruit: everything in it rests on the bowl or on what is under it
  {
    const x = -5.72;
    const z = -6.2;
    const y = F0 + 0.92;
    put('wooden_bowl_01', x, y, z, 2.1, 1.25);
    put('food_apple_01', x - 0.07, y + 0.028, z + 0.03, 0.4, 0.82);
    put('food_apple_01', x + 0.05, y + 0.03, z - 0.06, 2.6, 0.78).rotation.z = 0.3;
    put('food_pears_asian_01', x + 0.04, y + 0.04, z + 0.07, 1.2, 0.9);
  }
  // breakfast on the board
  put('wooden_cutting_board', -4.95, F0 + 0.92, -6.12, 0.35, 1);
  put('croissant', -5.0, F0 + 0.955, -6.1, 0.9, 1);
  put('croissant', -4.84, F0 + 0.955, -6.15, 2.4, 0.92);
  for (const [x, ry] of [
    [-6.05, 0.3],
    [-5.2, 1.4],
    [-4.35, 2.2],
  ]) {
    put('metal_stool_01', x, F0, -5.3, ry, 0.8);
  }
  // three globe pendants over the island: only the globe is lit, not the stem and cord
  for (const x of [-6.05, -5.2, -4.35]) {
    const S = 0.62;
    const y = F0 + 1.55 - 0.22 * S;
    const lamp = put('modern_ceiling_lamp_01', x, y, -6.2, 0, S);
    m.ignite(lamp, /_glass$/i, 0xffc88c, 1.3, 'ground', 0.47);
    m.ignite(lamp, /globe$/i, 0xffc88c, 3.2, 'ground');
    c.lamp(x, y + 0.22 * S + 0.13, -6.2, 5.0, 0xffd6a8, 0.13);
    b.rod(m.steel, 0.004, V(x, y + 1.15 * S, -6.2), V(x, C0, -6.2), 4);
  }
  // downlights, kept a metre clear of the tall units and the shelf: closer, each throws a hard scallop on them
  for (const x of [-5.9, -4.85, -3.8]) for (const z of [-7.35, -4.6]) downlight(spotOn, x, C0, z);

  // dining
  const r = rng(3);
  b.mm(m.oak, -5.65, -3.0, F0 + 0.71, F0 + 0.76, -3.02, -1.98);
  for (const x of [-5.25, -3.4]) b.mm(m.steel, x - 0.03, x + 0.03, F0, F0 + 0.71, -2.86, -2.14);
  for (const x of [-5.15, -4.32, -3.5]) {
    put('dining_chair_02', x, F0, -1.72, Math.PI + (r() - 0.5) * 0.2);
    put('dining_chair_02', x, F0, -3.28, (r() - 0.5) * 0.2);
  }
  put('ceramic_vase_02', -4.9, F0 + 0.76, -2.5, 0.7, 0.9);
  branches(-4.9, F0 + 0.76 + 0.2, -2.5, 0.5, 1.7);
  // tea for two, set out rather than stored: the pot, the sugar, a cup on its saucer at each place
  {
    const y = F0 + 0.76;
    const k = 0.92;
    at(piece('tea_set_01', 'tea_set_01_teapot_01', 'tea_set_01_teapot_01_lid'), -3.82, y, -2.48, 2.2, k);
    at(piece('tea_set_01', 'tea_set_01_sugar_cup_01', 'tea_set_01_sugar_cup_01_lid'), -3.98, y, -2.38, 0.6, k);
    cupAndSaucer(-3.62, y, -2.2, 0.8, k, 1);
    cupAndSaucer(-3.68, y, -2.78, 3.6, k, 2);
  }
  b.mm(m.steel, -5.3, -3.35, F0 + 1.66, F0 + 1.71, -2.53, -2.47);
  e.mm(led, -5.28, -3.37, F0 + 1.645, F0 + 1.66, -2.52, -2.48);
  for (const x of [-4.95, -4.32, -3.7]) c.lamp(x, F0 + 1.6, -2.5, 2.4, 0xffd9b0, 0.12);
  b.rod(m.steel, 0.003, V(-5.1, F0 + 1.71, -2.5), V(-5.1, C0, -2.5), 4);
  b.rod(m.steel, 0.003, V(-3.55, F0 + 1.71, -2.5), V(-3.55, C0, -2.5), 4);
  // the west wall: two photographs and a clock
  hang(put('hanging_picture_frame_02', -7.795, F0 + 1.62, -1.2, HALF, 1.1), 'sierra');
  hang(put('hanging_picture_frame_02', -7.795, F0 + 1.62, -3.2, HALF, 1.1), 'pines');
  put('wall_clock', -7.795, F0 + 2.3, -2.2, HALF, 1.25);

  /* ============================================================ STAIR */
  const risers = 19;
  const rise = (F1 + 0.02 - F0) / risers;
  const run = 0.27;
  const sx0 = -3.0;
  for (let i = 1; i < risers; i++) {
    const top = F0 + i * rise;
    const xc = sx0 + (i - 0.5) * run;
    b.box(m.oak, 0.3, 0.055, 1.28, xc, top - 0.0275, -8.14);
    e.mm(led, xc - 0.13, xc + 0.13, top - 0.08, top - 0.058, -8.796, -8.77);
  }
  b.mm(m.steel, sx0, sx0 + (risers - 1) * run, F0, F0 + 0.02, -8.8, -8.76); // shadow line at the wall
  c.lamp(0.3, F0 + 2.6, -8.05, 4, 0xffd9b0, 0.3);
  {
    const x0 = sx0 + 0.3;
    const x1 = sx0 + (risers - 1) * run;
    const y0 = F0 + rise * 1.5;
    const y1 = F1 + 0.02;
    const z = -7.5;
    const p = new Float32Array([x0, y0, z, x1, y1, z, x1, y1 + 0.95, z, x0, y0, z, x1, y1 + 0.95, z, x0, y0 + 0.95, z]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    geo.computeVertexNormals();
    g.add(m.glass, geo);
    b.rod(m.steel, 0.012, V(x0, y0 + 0.95, z), V(x1, y1 + 0.95, z), 6);
  }

  /* ============================================================= LOFT */
  const U = F1 + 0.02;
  b.mm(m.oakFloor, -2.3, 8.8, F1, U, -7.4, 2.3);
  b.mm(m.oakFloor, 1.9, 8.8, F1, U, -8.8, -7.4);
  b.mm(m.oakFloor, -2.3, -1.4, F1, U, -8.8, -7.4);
  c.paneZ(-1.4, 1.9, U, U + 0.98, -7.38);
  c.paneX(-1.42, U, U + 0.98, -8.8, -7.38);
  b.rod(m.steel, 0.012, V(-1.42, U + 0.98, -7.38), V(1.9, U + 0.98, -7.38), 6);

  // oak lining on the long wall, and five light blades above the stair
  b.mm(m.oak, 1.9, 8.8, U, C1 - 0.02, -8.8, -8.776);
  for (let i = 0; i < 5; i++) {
    const x = -1.0 + i * 0.62;
    const h = 1.0 + ((i * 7) % 5) * 0.28;
    b.mm(m.steel, x - 0.022, x + 0.022, C1 - 0.42 - h, C1 - 0.42, -8.8, -8.77);
    e.mm(ledUp, x - 0.014, x + 0.014, C1 - 0.44 - h + 0.04, C1 - 0.46, -8.772, -8.762);
  }

  // slatted ceiling, parted around the skylight
  {
    const S = SKYLIGHT;
    const parts: { x: number; z0: number; z1: number }[] = [];
    for (let x = -2.2; x <= 8.72; x += 0.115) {
      if (x > S.x0 - 0.12 && x < S.x1 + 0.12) {
        parts.push({ x, z0: -8.7, z1: S.z0 - 0.14 }, { x, z0: S.z1 + 0.14, z1: 2.2 });
      } else parts.push({ x, z0: -8.7, z1: 2.2 });
    }
    for (const p of parts) b.add(m.oak, timber(0.04, 0.06, p.z1 - p.z0), xf(p.x, C1 - 0.075, (p.z0 + p.z1) / 2));
  }
  for (const [x, z] of [
    [0.5, -5.2],
    [0.5, -2.0],
    [2.6, -5.2],
    [7.6, -3.6],
    [7.6, -0.6],
    [2.6, 1.2],
  ]) {
    downlight(spotUp, x, C1 - 0.105, z, 38);
  }
  for (const [x, z] of [
    [5.0, -4.6],
    [7.2, -6.3],
    [-0.6, -3.6],
    [5.0, 1.3],
  ]) {
    downlight(spotUp, x, C1 - 0.105, z, 38);
  }

  // Two more spots in the ceiling at the foot of the skylight, turned toward the head of the bed: the pillows are
  // lit from in front and above, like everything else in the room. (Over the bed itself there is no ceiling to
  // hang a lamp from; and lit from the headboard behind them, the pillows stood in a glare with their faces dark.)
  for (const x of [4.3, 5.7]) {
    e.cyl(spotUp, 0.032, 0.004, x, C1 - 0.119, 0.95, 14);
    c.wash([x, C1 - 0.14, 0.95], [5.0 + (x - 5.0) * 0.75, U + 0.85, -1.6], 46, 0.6, 0.07);
  }

  // The bed under the skylight. Headboard wall, platform and mattress are joinery; the linen is cloth, laid and left
  // to settle in Blender: a duvet square on the bed, a runner across its foot, two pillows against the headboard,
  // and three scanned cushions leant on them.
  const TOP = U + 0.56; // top of the mattress
  b.mm(m.oak, 3.05, 6.95, U, U + 1.12, -2.36, -2.14);
  e.mm(ledUp, 3.2, 6.8, U + 1.12, U + 1.135, -2.34, -2.31);
  b.mm(m.steel, 3.95, 6.05, U, U + 0.1, -1.9, 0.25);
  b.mm(m.oakDark, 3.72, 6.28, U + 0.1, U + 0.3, -2.14, 0.5);
  b.rbox(m.linen, 2.12, 0.26, 2.18, 5.0, U + 0.43, -0.95, 0.09);
  const duvet = put('bed_duvet', 5.0, TOP, -0.95);
  wear(duvet, scaled(m.duvet, 2.5 / 0.45, 2.06 / 0.45));
  wear(put('bed_throw', 5.0, TOP, -0.95), scaled(m.throw, 2.86 / 0.28, 0.66 / 0.28));
  const pillows = put('bed_pillows', 5.0, TOP, -0.95);
  dress(
    pillows,
    [
      [/pillow_square/, plain(0x8d877c)],
      [/pillow_accent/, asIs],
    ],
    scaled(m.linen, 1 / 0.45),
  );
  seatOn(pillows, /pillow_(square|accent)/, /^$/, [duvet]);
  leanBack(pillows, /pillow_square/, /pillow_white/);
  leanBack(pillows, /pillow_accent/, /pillow_(white|square)/);
  for (const s of [-1, 1]) {
    const x = 5.0 + s * 1.62;
    at(fit('nightstand', { h: 0.5 }), x, U, -1.87);
    tableLamp(x, U + 0.5, -1.96, 2.4, 'upper', s * 0.7, 0.9);
  }
  put('alarm_clock_01', 3.34, U + 0.5, -1.72, 0.5, 0.75);
  hang(put('standing_picture_frame_02', 6.66, U + 0.5, -1.72, -HALF - 0.4, 0.8), 'winter');
  b.rbox(m.rug, 4.6, 0.018, 3.4, 5.0, U + 0.009, -0.2, 0.008);
  // bench at the foot of the bed, a blanket folded on it
  b.mm(m.oak, 4.2, 5.8, U + 0.36, U + 0.41, 0.72, 1.12);
  for (const x of [4.3, 5.7]) b.mm(m.steel, x - 0.02, x + 0.02, U, U + 0.36, 0.76, 1.08);
  b.rbox(m.duvet, 0.56, 0.05, 0.32, 4.62, U + 0.435, 0.92, 0.024);
  b.rbox(m.duvet, 0.55, 0.05, 0.31, 4.625, U + 0.483, 0.922, 0.024, 0, 0.03);

  // study: a desk against the east wall, a board of prints above it, a computer on it
  b.mm(m.oak, 8.0, 8.8, U + 0.71, U + 0.75, -7.6, -5.0);
  for (const z of [-7.5, -5.1]) b.mm(m.steel, 8.06, 8.74, U, U + 0.71, z - 0.02, z + 0.02);
  b.mm(m.forest, 8.775, 8.8, U + 0.9, U + 2.15, -7.7, -4.9);
  /** Pins a print to the board: `h` metres tall, as wide as its picture makes it. `tone` darkens paper that hangs right under a lamp. */
  const pin = (name: keyof Assets['board'], z: number, y: number, h: number, tilt: number, tone = 1) => {
    const map = assets.board[name];
    const img = map.image as { width: number; height: number };
    const w = (h * img.width) / img.height;
    // sits clear of the felt and nudges its depth forward, so it never fights the board for the same pixels
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    mat.color.setScalar(tone);
    flat(b, mat, new THREE.PlaneGeometry(w, h).rotateY(-HALF), xf(8.762, U + y, z, tilt));
    b.sphere(m.brass, 0.009, 8.757, U + y + h / 2 - 0.02, z, 1, 1, 1, 8);
  };
  pin('carta', -7.26, 1.87, 0.36, 0.02); // Olaus Magnus's map of the north, 1539
  pin('rotonda', -7.42, 1.41, 0.34, -0.02); // Palladio's Villa Rotonda
  pin('rain', -6.78, 1.85, 0.37, -0.03); // Hiroshige
  pin('heavens', -6.28, 1.87, 0.31, 0.015); // de Wit's chart of the sky
  pin('wave', -5.74, 1.88, 0.28, -0.02); // Hokusai
  pin('medusae', -5.3, 1.84, 0.38, 0.03, 0.75); // Haeckel
  pin('loon', -5.3, 1.3, 0.24, 0.02, 0.34); // Audubon
  // the monitor, and the film on it: NASA's "Perpetual Ocean", running only while someone is up here to see it.
  // (Sitting down at the desk, the visitor gets the owner's own choice of film instead, played over this screen by
  // YouTube's player: see `tube` in ui.ts.)
  b.mm(m.steel, 8.56, 8.6, U + 0.75, U + 1.0, -6.34, -6.26);
  b.mm(m.steel, 8.42, 8.7, U + 0.75, U + 0.765, -6.48, -6.12);
  b.mm(m.steel, 8.5, 8.535, U + 0.9, U + 1.56, -6.86, -5.74);
  {
    const { video, texture } = assets.screen;
    // (with a film of the owner's own to show, the screen itself stays dark: the player is laid over it)
    const own = !site.screenVideo;
    const screenMat = own ? new THREE.MeshBasicMaterial({ map: texture }) : new THREE.MeshBasicMaterial({ color: 0x030405 });
    if (own) m.glows.push({ zone: 'screen', set: (k) => screenMat.color.setScalar(0.95 * k) });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.619).rotateY(-HALF), screenMat);
    screen.position.set(8.497, U + 1.23, -6.3);
    // (seen from the chair, +z is to the right)
    c.screen.push(V(8.495, U + 1.5395, -6.85), V(8.495, U + 1.5395, -5.75), V(8.495, U + 0.9205, -5.75), V(8.495, U + 0.9205, -6.85));
    screen.userData.noMirror = true;
    group.add(screen);
    let playing = false;
    if (own) c.tick.push((_time, eye) => {
      const here = eye.y > F1 - 0.6 && eye.y < C1 + 0.5 && eye.x > -2.6 && eye.z > -9.1 && eye.z < 2.5;
      if (here === playing) return;
      playing = here;
      if (here) void video.play().catch(() => (playing = false));
      else video.pause();
    });
  }
  // the computer: a tower at the back of the desk, side-on so its glass shows; a keyboard and a mouse on a felt mat
  {
    const tower = at(fit('pc_tower', { h: 0.45 }), 8.63, U + 0.75, -7.24, -HALF);
    // Its lights. The strips of a lit case are hidden in its frame; what shows is their glow on everything inside:
    // strongest along the top and the bottom of the opening, one colour at the front running into another at the
    // back, the pair turning slowly round the wheel. So that is what is drawn — a wash of light just behind the
    // glass — and the parts take a little of the colour themselves.
    tower.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(tower, true);
    const lit: { mat: THREE.MeshStandardMaterial; k: number }[] = [];
    const part = new THREE.Box3();
    const size = new THREE.Vector3();
    tower.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      part.setFromObject(mesh).getSize(size);
      if (Math.max(size.x, size.y, size.z) > 0.3) return; // the case's own panels
      const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
      const c0 = mat.color;
      mat.emissiveMap = null;
      lit.push({ mat, k: 0.2126 * c0.r + 0.7152 * c0.g + 0.0722 * c0.b > 0.35 ? 0.42 : 0.2 });
      mesh.material = mat;
    });
    const z0 = box.min.z + 0.035;
    const z1 = box.max.z - 0.055;
    const y0 = box.min.y + 0.1;
    const y1 = box.max.y - 0.022;
    const glow = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: { uA: { value: new THREE.Color() }, uB: { value: new THREE.Color() }, uLevel: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main(){
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uA, uB;
        uniform float uLevel;
        varying vec2 vUv;
        void main(){
          // bright where the strips are, top and bottom; a soft spill into the middle; nothing at the very ends
          float edge = pow(abs(vUv.y - 0.5) * 2.0, 4.0);
          float ends = smoothstep(0.0, 0.08, vUv.x) * smoothstep(1.0, 0.92, vUv.x);
          vec3 col = mix(uA, uB, smoothstep(0.1, 0.9, vUv.x));
          gl_FragColor = vec4(col * (0.012 + 0.2 * edge) * ends * uLevel, 1.0);
        }
      `,
    });
    const wash = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0, y1 - y0).rotateY(-HALF), glow);
    wash.position.set(box.min.x + 0.02, (y0 + y1) / 2, (z0 + z1) / 2);
    wash.renderOrder = 4;
    wash.userData.noMirror = true;
    group.add(wash);
    const mid = new THREE.Color();
    c.tick.push((time) => {
      const h = 0.52 + time * 0.03;
      glow.uniforms.uA.value.setHSL(h % 1, 0.95, 0.5);
      glow.uniforms.uB.value.setHSL((h + 0.14) % 1, 0.95, 0.5);
      mid.setHSL((h + 0.07) % 1, 0.9, 0.5);
      for (const l of lit) {
        l.mat.emissive.copy(mid);
        l.mat.emissiveIntensity = l.k;
      }
    });
  }
  b.rbox(m.felt, 0.36, 0.004, 0.9, 8.23, U + 0.752, -6.2, 0.002);
  {
    // (its feet and its cable to the monitor, its space bar to the chair)
    const keys = stand(put('pc_keyboard', 8.23, U + 0.754, -6.33, -HALF, 0.001), U + 0.754);
    // its legends are back-lit, in the scan in red: here the same warm white as the rest of the house, and no brighter
    // than a dim room wants
    keys.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh) return;
      const own = mesh.material as THREE.MeshStandardMaterial;
      if (!own.emissiveMap && !/Emission/.test(own.name)) return;
      const lit = own.clone();
      if (own.emissiveMap) lit.emissiveMap = brightness(own.emissiveMap);
      lit.emissive.setHex(0xffe2c4);
      lit.emissiveIntensity = 0.7;
      mesh.material = lit;
    });
  }
  at(fit('pc_mouse', { l: 0.118 }), 8.25, U + 0.754, -5.93, -HALF);
  {
    // The scan is a leather binder with a writing pad lying beside it, in one mesh. One notebook is enough on a desk:
    // the pad's triangles are left out. (Its vertices stay, so the baked light still counts what it counted.)
    const book = put('binder_notebook', 8.2, U + 0.75, -5.42, HALF, 1);
    book.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry.index) return;
      const pos = mesh.geometry.attributes.position;
      // the two lie apart along x: the widest empty stretch between them is where to cut
      const xs = Array.from({ length: pos.count }, (_, i) => pos.getX(i)).sort((p, q) => p - q);
      let cut = 0;
      let gap = 0;
      for (let i = Math.floor(xs.length * 0.15); i < xs.length * 0.85; i++) {
        if (xs[i + 1] - xs[i] > gap) {
          gap = xs[i + 1] - xs[i];
          cut = (xs[i + 1] + xs[i]) / 2;
        }
      }
      const index = mesh.geometry.index;
      const kept: number[] = [];
      for (let t = 0; t < index.count; t += 3) {
        const a = index.getX(t);
        if (pos.getX(a) > cut) kept.push(a, index.getX(t + 1), index.getX(t + 2));
      }
      const geo = mesh.geometry.clone();
      geo.setIndex(kept);
      mesh.geometry = geo;
    });
  }
  stand(put('round_spectacles', 8.17, U + 0.75, -6.86, 2.2, 1), U + 0.75);
  cupAndSaucer(8.38, U + 0.75, -6.82, 1.0, 0.9, 2);
  put('potted_plant_04', 8.62, U + 0.75, -5.55, 1.0, 0.85);
  // The lamp clamps to the desk. In the model the clamp's top jaw is at height 0 and its spine 3 cm out along +Z,
  // with the lower jaw hanging beneath: so the model's origin goes on the desktop, just inside the end of the desk.
  const deskLamp = put('desk_lamp_arm_01', 8.5, U + 0.75, -5.0 - 0.03 * 0.8, 0, 0.8);
  m.ignite(deskLamp, /_light$/i, 0xffc88c, 1.5, 'upper');
  c.lamp(8.5, U + 1.24, -5.3, 1.6, 0xffd6a8, 0.05);
  c.lamp(8.3, U + 1.2, -6.3, 0.9, 0x9fc0ff, 0.3); // the screen
  put('modern_arm_chair_01', 7.3, U, -6.3, HALF, 0.95);

  // The library: four steel-and-oak shelving units along the north wall, shelved from Poly Haven's book set —
  // rows of spines, here and there a stack lying flat, a few things that are not books.
  {
    const UNIT = 1.0974;
    const BACK = -8.776;
    const X0 = 2.74;
    const BOARDS = [0.133, 0.6385, 1.145, 1.651]; // tops of the shelf boards, above the floor
    for (let i = 0; i < 4; i++) put('steel_frame_shelves_01', X0 + UNIT * (i + 0.5), U, BACK + 0.251, 0, 0.1);
    const r = rng(17);
    const order = volumes.list.map((_, i) => i).sort(() => r() - 0.5);
    let next = 0;
    const take = () => volumes.list[order[next++ % order.length]];
    const parts: THREE.BufferGeometry[] = [];
    const gaps: [number, number][] = [];
    for (let i = 0; i < 4; i++) {
      for (let s = 0; s < BOARDS.length; s++) {
        const y = U + BOARDS[s];
        const spine = BACK + 0.4; // where the spines line up
        const left = X0 + UNIT * i + 0.055;
        const right = X0 + UNIT * (i + 1) - 0.055;
        const kind = (i * 5 + s * 3) % 7;
        let x = left;
        let end = right;
        if (kind === 2) {
          gaps.push([left + 0.15, y]);
          x += 0.32;
        }
        if (kind === 5) {
          gaps.push([right - 0.15, y]);
          end -= 0.32;
        }
        if (kind === 0 || kind === 4) {
          // a stack lying flat where the row stops
          end -= 0.33;
          let top = y;
          for (let k = 0; k < 3 + (i % 2); k++) {
            const v = take();
            parts.push(v.geo.clone().applyMatrix4(xf(end + 0.03 + v.h + (r() - 0.5) * 0.02, top + v.t / 2, spine - v.d - 0.01, 0, 0, HALF)));
            top += v.t;
          }
        }
        for (;;) {
          const v = take();
          if (x + v.t > end) break;
          parts.push(v.geo.clone().applyMatrix4(xf(x + v.t / 2, y, spine - v.d + (r() - 0.5) * 0.012)));
          x += v.t + 0.0015;
        }
      }
    }
    const shelved = new THREE.Mesh(mergeGeometries(parts, false)!, volumes.material);
    shelved.castShadow = shelved.receiveShadow = true;
    shelved.userData.noMirror = true;
    group.add(shelved);
    // in the spaces left between the books
    const things: [ModelId, number, number][] = [
      ['Camera_01', 1.5, 0.5],
      ['ceramic_vase_01', 0.62, 0],
      ['lambis_shell', 1.6, 2.0],
      ['ceramic_vase_04', 0.6, 1.1],
      ['binoculars', 1, 0.4],
    ];
    gaps.forEach(([gx, gy], k) => k < things.length && put(things[k][0], gx, gy, BACK + 0.3, things[k][2], things[k][1]));
    // three downlights wash the spines
    for (const x of [3.3, 4.95, 6.6]) downlight(spotUp, x, C1 - 0.105, -7.55, 30);
  }

  // A console on the east wall between the desk and the bed, and over it a round mirror with light behind it.
  {
    const [z0, z1] = [-4.05, -2.85];
    const zc = (z0 + z1) / 2;
    const top = U + 0.8;
    b.mm(m.oak, 8.36, 8.8, U + 0.44, top - 0.03, z0, z1);
    b.mm(m.stone, 8.33, 8.8, top - 0.03, top, z0 - 0.03, z1 + 0.03);
    // the mirror stands a hand off the wall; the light behind it washes out round its rim
    const mirror = new THREE.Mesh(new THREE.CircleGeometry(0.4, 72).rotateY(-HALF).translate(8.752, U + 1.6, zc), m.mirror);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.402, 0.009, 10, 72).rotateY(-HALF).translate(8.752, U + 1.6, zc), m.brass);
    mirror.userData.noMirror = rim.userData.noMirror = true;
    group.add(mirror, rim);
    b.cyl(m.steel, 0.3, 0.04, 8.775, U + 1.6, zc, 40, 0.3, 0, HALF);
    const halo = m.glow(0xffdcb6, 1.5, 'upper', 5);
    e.add(halo, new THREE.TorusGeometry(0.37, 0.012, 8, 56).rotateY(-HALF), xf(8.778, U + 1.6, zc));
    // on it: a vase of branches, and a shell from the shore
    put('ceramic_vase_04', 8.58, top, z1 - 0.26, 0.4, 0.9);
    put('lambis_shell', 8.56, top, z0 + 0.3, 0.7, 1.5);
  }

  // The lounge, on the west side of the loft under the two framed prints: a sofa, an armchair and a round glass table
  // (made as a set; taken apart here and stood where this room wants them), a carpet under them, a tripod lamp and
  // a ficus at the sofa's two ends.
  {
    const K = 0.75; // the set is drawn for a bigger room
    at(part('lounge_set', (name, c) => !/coffeetable/.test(name) && c.x < -1.3), -1.72, U, -5.05, 0.431, K);
    at(part('lounge_set', (name, c) => !/coffeetable/.test(name) && c.x >= -1.3), -0.68, U, -3.62, 1.2, K);
    at(part('lounge_set', (name) => /coffeetable/.test(name)), -0.3, U, -5.05, 0, K);
    carpet(1, 3.3, -0.55, U + 0.001, -5.05, HALF);
    const lamp = at(fit('floor_lamp', { h: 1.62 }), -1.85, U, -6.85, 0.6);
    lamp.traverse((n) => {
      const mesh = n as THREE.Mesh;
      if (!mesh.isMesh || !/Lamp_Fabric/.test((mesh.material as THREE.Material).name)) return;
      const shade = (mesh.material as THREE.MeshStandardMaterial).clone();
      shade.transparent = false; // linen with a bulb behind it, not glass
      shade.opacity = 1;
      shade.depthWrite = true; // (the file has it as see-through cloth, which is drawn without writing depth)
      (shade as THREE.MeshPhysicalMaterial).transmission = 0;
      mesh.material = shade;
    });
    m.ignite(lamp, /Lamp_Fabric/, 0xffc98f, 0.9, 'upper');
    c.lamp(-1.85, U + 1.42, -6.85, 7, 0xffd6a8, 0.08);
    at(fit('ficus', { h: 1.55 }), -1.9, U, -3.2, 0.8);
  }
  // behind the headboard, so that the bed has a back worth walking past: a long sideboard with a record player on
  // it, a lamp, a vase of branches and a photograph
  {
    const S = 1.2;
    const top = U + 0.68 * S;
    const z = -2.36 - 0.012 - 0.27 * S;
    put('modern_wooden_cabinet', 5.0, U, z, Math.PI, S);
    {
      // The record player. Its platter and its arm are their own pieces: with a record on, the platter turns at
      // thirty-three and a third and the arm comes in over it; lifted, the arm goes back to its rest and the platter
      // runs down.
      const deck = at(fit('turntable', { w: 0.44 }), 5.75, top, z - 0.02, Math.PI);
      deck.updateMatrixWorld(true);
      const piece = (re: RegExp) => {
        let found: THREE.Mesh | undefined;
        deck.traverse((n) => {
          if ((n as THREE.Mesh).isMesh && re.test(n.name)) found = n as THREE.Mesh;
        });
        return found;
      };
      /** turns a piece about an upright axis through `centre` (both as they stand in the room) */
      const turning = (mesh: THREE.Mesh, centre: THREE.Vector3) => {
        const parent = mesh.parent!.matrixWorld.clone();
        const back = parent.clone().invert();
        const base = mesh.matrix.clone();
        const turn = new THREE.Matrix4();
        mesh.matrixAutoUpdate = false;
        return (angle: number) => {
          turn.makeTranslation(centre.x, centre.y, centre.z).multiply(new THREE.Matrix4().makeRotationY(angle)).multiply(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z));
          mesh.matrix.copy(back).multiply(turn).multiply(parent).multiply(base);
          mesh.matrixWorldNeedsUpdate = true;
        };
      };
      const middle = (mesh: THREE.Mesh) => new THREE.Box3().setFromObject(mesh, true).getCenter(new THREE.Vector3());
      const platter = piece(/Platter/);
      const pivot = piece(/Tone_Arm_Pivot/);
      const arm = piece(/Tone_Arm_(?!Pivot)/);
      const weight = piece(/Weight/);
      if (platter && pivot && arm) {
        const spin = turning(platter, middle(platter));
        const swing = [arm, ...(weight ? [weight] : [])].map((mesh) => turning(mesh, middle(pivot)));
        let angle = 0;
        let speed = 0;
        let reach = 0;
        let then = 0;
        c.tick.push((time) => {
          const dt = Math.min(time - then, 0.1);
          then = time;
          const on = c.state.record;
          speed += ((on ? 3.49 : 0) - speed) * Math.min(1, dt * 1.6);
          angle = (angle + speed * dt) % (Math.PI * 2);
          reach += ((on ? 1 : 0) - reach) * Math.min(1, dt * 1.8);
          if (speed < 0.002 && reach < 0.002) return;
          spin(-angle);
          // in over the record, and a hair of wander as the groove carries it
          for (const s of swing) s(ARM * reach * (1 + 0.02 * Math.sin(time * 3.5)));
        });
      }
    }
    tableLamp(3.95, top, z, 2.6, 'upper', 1.1, 0.9);
    put('ceramic_vase_02', 4.6, top, z + 0.03, 0.4, 1);
    hang(put('standing_picture_frame_01', 6.25, top, z + 0.06, Math.PI - 0.3, 1.05), 'sunrise');
  }
  // a telescope at the south glass, for the sky this house was built under
  at(fit('telescope', { h: 1.45 }), 2.2, U, 1.6, 2.5);
  // and one more carpet, under the reading chair (two in a room is company; four was a carpet shop)
  carpet(2, 2.5, -0.1, U + 0.001, -0.45, 0.35);
  // reading corner by the screened glass
  put('mid_century_lounge_chair', -0.4, U, -0.5, 2.3);
  // (the table stands on the chair's window side: from where one comes up to it, beside the chair, not in front of it)
  at(fit('side_table_glass', { h: 0.52 }), 0.6, U, 0.66);
  tableLamp(0.6, U + 0.521, 0.66, 2.8, 'upper', 0.3, 0.9);
  {
    // a ukulele leant in the corner by the chair
    const uke = put('Ukulele_01', -2.12, U, -1.25, HALF, 1.25);
    uke.rotation.order = 'YXZ';
    uke.rotation.x = -0.2; // its head tips back against the wall
    stand(uke, U);
  }
  put('potted_plant_02', -1.5, U, 1.4, 0.6, 1.7);
  put('potted_plant_01', 8.2, U, 1.4, 2.4, 1.2);
  // two pictures over the sofa, each with a spot of its own in the ceiling (the wall they hang on is the one wall
  // of the loft no lamp faces: unlit, they were two dark rectangles)
  for (const [z, name] of [
    [-4.6, 'wanderer'],
    [-5.5, 'stetind'],
  ] as const) {
    hang(framed(-2.29, U + 1.55, z, HALF, 1.1), name);
    e.cyl(spotUp, 0.032, 0.004, -1.38, C1 - 0.119, z, 14);
    c.wash([-1.38, C1 - 0.14, z], [-2.29, U + 1.55, z], 20, 0.55, 0.06);
  }
  drape(7.2, U + 0.02, C1 - 0.12, 2.12);

  /* ============================================================ THE CAT */
  // A cat asleep in its basket. It is never seen to move; but when the visitor has been on the other floor for a
  // while, the basket turns out to be somewhere else. (It is not in the light bake — it could not move if it were —
  // and takes the light of the floor it lies on.)
  {
    const cat = fit('cat_basket', { w: 0.6 });
    cat.userData.noBake = true;
    const places: [number, number, number, number][] = [
      [6.25, F0 + 0.018, -2.55, 0.6], // on the rug by the hearth
      [0.95, F0, -3.35, 2.2], // beside the lounge chair
      [6.95, U + 0.018, 0.8, -0.8], // at the foot of the bed
    ];
    let here = 0;
    let seen = 0;
    const lie = (i: number) => at(cat, ...places[(here = i)]);
    lie(0);
    const body = cat.children[0];
    const rest = body.scale.y;
    c.tick.push((time, eye) => {
      body.scale.y = rest * (1 + 0.012 * Math.sin(time * 1.5)); // it breathes
      const up = eye.y > F1 + 0.6;
      if (up === places[here][1] > F1) return void (seen = time); // on the visitor's floor: it stays put
      if (time - seen < 22) return;
      seen = time;
      const elsewhere = places.map((_, i) => i).filter((i) => i !== here && places[i][1] > F1 !== up);
      if (elsewhere.length) lie(elsewhere[Math.floor(Math.random() * elsewhere.length)]);
    });
  }

  /* ========================================================== TERRACE */
  // a cast-iron fire bowl between the two chairs, the logs laid in it
  {
    const bowl = at(fit('fire_bowl', { w: 0.98 }), -4.6, F0 - 0.02, 3.1, 0.6);
    bowl.updateMatrixWorld(true);
    const rim = new THREE.Box3().setFromObject(bowl, true).max.y;
    fire(-4.6, rim - 0.17, 3.1, 0.75, 1.15);
  }

  /**
   * A wood fire: a scanned campfire's worth of logs, a bed of embers glowing through underneath them, and flames
   * standing in among them. The flames are film (see FLAME in house.ts): each card turns to face the camera and is
   * rooted behind a log, so what shows is fire coming out of wood rather than pictures of fire.
   */
  function fire(x: number, y: number, z: number, yaw: number, size: number) {
    const laid = xf(x, y, z, 0, yaw, 0).multiply(xf(0, 0, 0, 0, 0, 0, size));
    // embers: a low ragged heap of coals, hot all through
    const heap = new THREE.SphereGeometry(0.5, 28, 7, 0, Math.PI * 2, 0, Math.PI / 2);
    {
      const n = new Noise(Math.round(x * 31 + z * 17));
      const p = heap.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const a = Math.atan2(p.getZ(i), p.getX(i));
        const out = Math.hypot(p.getX(i), p.getZ(i)) / 0.5; // 0 at the crown, 1 at the rim
        // the vertices of the seam (a = ±π) share a place: keep the noise the same either side of it
        const k = 0.62 + 0.55 * n.fbm(Math.cos(a) * 1.6 + 5, Math.sin(a) * 1.6 + 5, 3);
        const lump = 0.6 + 0.8 * n.fbm(p.getX(i) * 9 + 2, p.getZ(i) * 9 + 7, 2);
        p.setXYZ(i, p.getX(i) * 0.5 * k, p.getY(i) * 0.1 * lump * (1 - out * out * 0.8), p.getZ(i) * 0.4 * k);
        heap.attributes.uv.setXY(i, p.getX(i) * 5.5 + 0.5, p.getZ(i) * 5.5 + 0.5);
      }
      heap.computeVertexNormals();
    }
    const bed = new THREE.Mesh(heap.applyMatrix4(laid), m.ember);
    bed.userData.noMirror = true;
    group.add(bed);
    at(fit('fire_logs', { w: 0.62 * size }), x, y - 0.02 * size, z, yaw);
    // flames: the big one in the heart of the pile, smaller ones licking up between the logs
    const w = new THREE.Vector3();
    for (const [dx, dy, dz, fw, fh] of [
      [0.0, 0.05, 0.0, 0.5, 0.52],
      [-0.13, 0.07, 0.05, 0.3, 0.33],
      [0.14, 0.07, -0.04, 0.32, 0.36],
      [0.02, 0.12, -0.07, 0.26, 0.3],
      [-0.04, 0.04, 0.09, 0.22, 0.22],
    ]) {
      w.set(dx * size, dy * size, dz * size).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      c.flame(fw * size, fh * size, x + w.x, y + w.y, z + w.z);
    }
    c.lamp(x, y + 0.3 * size, z, 9 * size * size, FIRELIGHT, 0.16 * size, true);
  }

  /**
   * The hearth: the fire itself, on two steel dogs. (The logs waiting their turn are in the rack beside it.)
   * The firebox is 63 cm deep behind its glass, and the fire is laid whole in the middle of it.
   */
  function hearth(x: number, y: number, z: number) {
    // fire dogs: two steel bars that keep the logs off the stone
    for (const dz of [-0.17, 0.17]) b.mm(m.steel, x - 0.2, x + 0.2, y, y + 0.022, z + dz - 0.012, z + dz + 0.012);
    fire(x, y + 0.02, z, Math.PI / 2, 0.94);
    // fill in the niche, so the stone behind the fire is lit by more than one point
    for (const dz of [-0.6, 0.6]) c.lamp(x, y + 0.26, z + dz, 0.9, FIRELIGHT, 0.14, true);
  }
}

/**
 * A scanned mesh as plain float geometry in the model's own space, in metres or whatever it was measured in.
 * (The files store positions as scaled integers with the scale on the node: see `unpack` in landscape.ts.)
 */
function unpacked(mesh: THREE.Mesh) {
  const src = mesh.geometry;
  const geo = new THREE.BufferGeometry();
  for (const [name, size] of [
    ['position', 3],
    ['normal', 3],
    ['uv', 2],
  ] as const) {
    const a = src.attributes[name];
    if (!a) continue; // a part with no texture has no use for a mapping
    const out = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      out[i * size] = a.getX(i);
      out[i * size + 1] = a.getY(i);
      if (size === 3) out[i * size + 2] = a.getZ(i);
    }
    geo.setAttribute(name, new THREE.BufferAttribute(out, size));
  }
  if (src.index) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(src.index.array), 1));
  mesh.updateWorldMatrix(true, false);
  geo.applyMatrix4(mesh.matrixWorld);
  return geo;
}

/**
 * Poly Haven's book set, taken apart: each volume as plain float geometry in metres — standing on y = 0, centred
 * across, its back on z = 0 and its spine toward +z — with its thickness, height and depth, and the one material
 * (one atlas of covers) they all share.
 */
function shelfBooks(assets: Assets) {
  const root = assets.models.books;
  root.updateMatrixWorld(true);
  const list: { geo: THREE.BufferGeometry; t: number; h: number; d: number }[] = [];
  let material: THREE.Material = new THREE.MeshStandardMaterial();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    material = mesh.material as THREE.Material;
    const geo = unpacked(mesh);
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -bb.min.z);
    const size = bb.getSize(new THREE.Vector3());
    // the set includes a few magazines and outsize albums: they would not stand in a row
    if (size.x > 0.008 && size.y < 0.3 && size.z < 0.26) list.push({ geo, t: size.x, h: size.y, d: size.z });
  });
  return { list, material };
}
