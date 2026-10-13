import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { Experience } from '../scene/experience';
import { LM_SIZE } from '../scene/builder';
import { looseMeshes } from '../scene/lightmap';

/**
 * Build-time only (see scripts/bake.mjs): hands the house to Blender.
 *   house.glb   lm_*    the building itself, with its atlas UVs: light is baked into the atlas
 *               glow_*  emitters: LED strips, bulbs
 *   props       loose objects, as plain arrays (world-space positions, normals, triangles): light is baked into
 *               their vertices, and they shade whatever they stand on. Not glTF on purpose: an importer is free to
 *               drop or merge vertices, and the bake has to come back with exactly one value for each of ours.
 * Everything goes out in the average colour of its material, so bounced light picks up the right tint.
 */

const tints = new Map<string, THREE.Color>();
function average(mat: THREE.Material) {
  const m = mat as THREE.MeshStandardMaterial;
  const out = (m.color ?? new THREE.Color(1, 1, 1)).clone();
  const img = m.map?.image as CanvasImageSource | undefined;
  if (!m.map || !img) return out;
  let tint = tints.get(m.map.uuid);
  if (!tint) {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    const sum = new THREE.Color(0, 0, 0);
    const px = new THREE.Color();
    for (let i = 0; i < d.length; i += 4) sum.add(px.setRGB(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, THREE.SRGBColorSpace));
    tint = sum.multiplyScalar(1 / 64);
    tints.set(m.map.uuid, tint);
  }
  return out.multiply(tint);
}

const plain = (name: string, color: THREE.Color) => new THREE.MeshStandardMaterial({ name, color, roughness: 1, metalness: 0 });

export async function exportForBake(exp: Experience) {
  const house = exp.house;
  house.group.updateMatrixWorld(true);
  const root = new THREE.Scene();
  const glows: Record<string, { color: number[]; strength: number; group: string }> = {};

  for (const mesh of house.lightmapped) {
    const copy = new THREE.Mesh(mesh.geometry, plain(mesh.name, average(mesh.material as THREE.Material)));
    copy.name = mesh.name;
    root.add(copy);
  }

  // loose objects: the bake writes light into their vertices in this order
  const loose = looseMeshes(house);
  const counts: number[] = [];
  const triangles: number[] = [];
  const colors: number[][] = [];
  const total = loose.reduce((n, m) => n + m.geometry.attributes.position.count, 0);
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const index: number[] = [];
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let base = 0;
  for (const mesh of loose) {
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    nm.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      positions.set([v.x, v.y, v.z], (base + i) * 3);
      if (nor) v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      else v.set(0, 1, 0);
      normals.set([v.x, v.y, v.z], (base + i) * 3);
    }
    const n = geo.index ? geo.index.count : pos.count;
    for (let k = 0; k + 2 < n; k += 3) {
      const a = geo.index ? geo.index.getX(k) : k;
      const b = geo.index ? geo.index.getX(k + 1) : k + 1;
      const c = geo.index ? geo.index.getX(k + 2) : k + 2;
      if (a === b || b === c || a === c) continue; // a triangle with no area lights nothing and upsets the mesh
      index.push(base + a, base + b, base + c);
    }
    counts.push(pos.count);
    triangles.push(index.length / 3);
    colors.push(average(mat).toArray());
    base += pos.count;
  }

  house.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.userData.emitter) return;
    const g = (mesh.material as THREE.Material).userData.glow as { color: THREE.Color; strength: number; group: string };
    if (g.strength <= 0) return; // decorative only: its light comes from a bake lamp instead
    const name = `glow_${Object.keys(glows).length}`;
    glows[name] = { color: g.color.toArray(), strength: g.strength, group: g.group };
    const copy = new THREE.Mesh(mesh.geometry, plain(name, g.color));
    copy.name = name;
    copy.applyMatrix4(mesh.matrixWorld);
    root.add(copy);
  });

  const lights = house.bakeLights.map((l) => ({
    group: l.group,
    kind: l.kind,
    pos: l.pos,
    target: l.target ?? [l.pos[0], l.pos[1] - 1, l.pos[2]],
    color: new THREE.Color(l.color).toArray(),
    intensity: l.intensity,
    radius: l.radius,
    angle: l.angle,
  }));

  const glb = (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
  return {
    files: {
      'house.glb': glb,
      'props_pos.bin': positions.buffer,
      'props_nor.bin': normals.buffer,
      'props_idx.bin': new Uint32Array(index).buffer,
    } as Record<string, ArrayBuffer>,
    scene: {
      size: LM_SIZE,
      density: house.density,
      lights,
      glows,
      counts,
      /** running total of triangles after each loose object */
      triangles,
      colors,
      meshes: { lightmapped: house.lightmapped.length, loose: loose.length, vertices: counts.reduce((a, b) => a + b, 0), glows: Object.keys(glows).length },
    },
  };
}
