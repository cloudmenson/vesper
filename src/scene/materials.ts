import * as THREE from 'three';
import type { Assets, PBR } from './assets';
import { stoneTexture, emberTexture } from './textures';

export type Zone = 'ground' | 'upper' | 'ext' | 'fire' | 'screen';

/** Anything that emits: `set(level)` dims or brightens it with the house lights. */
export interface Glow {
  set: (level: number) => void;
  zone: Zone;
}

export type Mats = ReturnType<typeof createMaterials>;

export function createMaterials(assets: Assets) {
  const T = assets.tex;

  /**
   * A scanned PBR material.
   * `tile` is the size in metres one repeat of the texture covers.
   * `grain` makes the texture follow the long side of each piece, the way a joiner would cut it.
   */
  const pbr = (
    set: PBR,
    tile: number,
    o: { color?: number; roughness?: number; normal?: number; grain?: boolean; rot?: boolean; useMap?: boolean; ao?: number } = {},
  ) => {
    const m = new THREE.MeshStandardMaterial({
      map: o.useMap === false ? null : set.map,
      normalMap: set.normalMap,
      normalScale: new THREE.Vector2(o.normal ?? 1, o.normal ?? 1),
      roughnessMap: set.arm,
      aoMap: set.arm,
      aoMapIntensity: o.ao ?? 1,
      roughness: o.roughness ?? 1,
      metalness: 0,
      color: o.color ?? 0xffffff,
    });
    m.userData.tile = tile;
    m.userData.grain = !!o.grain;
    m.userData.rot = !!o.rot;
    return m;
  };
  /** marks a walking surface: loose objects sample the baked light on the floor around them */
  const floor = <M extends THREE.Material>(mat: M) => {
    mat.userData.floor = true;
    return mat;
  };
  const flat = (p: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial(p);
    m.userData.tile = 1;
    return m;
  };

  const glows: Glow[] = [];
  /**
   * Unlit emitter; values above 1 feed the bloom pass.
   * `bake` is how strongly it lights the room in the bake, which can be more than it shows on screen:
   * a thin strip drawn very bright shimmers as the camera moves, and its light is in the lightmap anyway.
   */
  const glow = (hex: number, intensity: number, zone: Zone, bake = intensity) => {
    const base = new THREE.Color(hex).multiplyScalar(intensity);
    const mat = new THREE.MeshBasicMaterial({ color: base.clone() });
    mat.userData.tile = 1;
    mat.userData.glow = { color: new THREE.Color(hex), strength: bake, group: zone === 'fire' ? 'fire' : 'lamps' }; // read by the light bake
    glows.push({ zone, set: (k) => mat.color.copy(base).multiplyScalar(k) });
    return mat;
  };
  /**
   * Makes part of a loaded model glow (lamp globes, bulbs).
   * `below` limits the glow to the lower fraction of the mesh — a pendant's globe, not its stem and cord.
   */
  const ignite = (root: THREE.Object3D, match: RegExp, hex: number, intensity: number, zone: Zone, below?: number) => {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      list.forEach((src, i) => {
        if (!match.test(src.name)) return;
        const mat = (src as THREE.MeshStandardMaterial).clone();
        mat.emissive = new THREE.Color(hex);
        mat.emissiveMap = null;
        mat.userData.own = true; // already unique to this lamp: later passes may patch it in place
        if (below !== undefined) {
          mesh.geometry.computeBoundingBox();
          const bb = mesh.geometry.boundingBox!;
          const cut = bb.min.y + (bb.max.y - bb.min.y) * below;
          const soft = (bb.max.y - bb.min.y) * 0.015;
          mat.onBeforeCompile = (sh) => {
            sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vLampY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLampY = position.y;');
            sh.fragmentShader = sh.fragmentShader
              .replace('#include <common>', '#include <common>\nvarying float vLampY;')
              .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 1.0 - smoothstep(${(cut - soft).toFixed(5)}, ${(cut + soft).toFixed(5)}, vLampY);`);
          };
          mat.customProgramCacheKey = () => `lamp-${cut.toFixed(4)}`;
        }
        glows.push({ zone, set: (k) => (mat.emissiveIntensity = intensity * k) });
        if (Array.isArray(mesh.material)) mesh.material[i] = mat;
        else mesh.material = mat;
      });
    });
  };

  // what a log looks like once the fire has it: charred, with the heat showing through its cracks
  const ember = pbr(T.burned_ground_01, 0.35, { color: 0x4a4440 });
  ember.emissive = new THREE.Color(0xff5a14);
  ember.emissiveMap = emberTexture(5);
  ember.userData.own = true; // one of a kind: later passes patch it in place rather than copy it
  glows.push({ zone: 'fire', set: (k) => (ember.emissiveIntensity = 2.6 * k) });

  const stone = stoneTexture(9);
  const stoneMat = flat({ map: stone.map, normalMap: stone.normal, normalScale: new THREE.Vector2(0.35, 0.35), roughness: 0.5, metalness: 0 });
  stoneMat.userData.tile = 1.8;

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xa9c3d6,
    roughness: 0.03,
    metalness: 0,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: THREE.DoubleSide,
    envMapIntensity: 0.55,
  });
  // Fresnel: almost invisible head-on, mirror-like at a glancing angle.
  glass.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float fres = pow(1.0 - saturate(abs(dot(normalize(vViewPosition), normal))), 3.0);
       diffuseColor.a = mix(diffuseColor.a, 0.82, fres);
       #include <opaque_fragment>`,
    );
  };

  return {
    glows,
    glow,
    ignite,
    concrete: pbr(T.concrete_wall_004, 2.6, { normal: 0.8 }),
    concreteDark: pbr(T.concrete_wall_004, 2.6, { color: 0x77777a }),
    oakFloor: floor(pbr(T.laminate_floor_02, 2.2, { roughness: 0.82, normal: 0.7 })),
    deck: floor(pbr(T.brown_planks_09, 2.0, { color: 0xb9aa98, normal: 1.2 })),
    oak: pbr(T.fine_grained_wood, 1.3, { color: 0xe2c9a4, grain: true, roughness: 0.9 }),
    oakDark: pbr(T.mocha_oak_veneer, 1.3, { color: 0xb08f72, grain: true, roughness: 0.9 }),
    cedar: pbr(T.mocha_oak_veneer, 1.3, { color: 0x8f7660, grain: true }),
    bark: pbr(T.bark_brown_02, 1.2, { color: 0x8a7868 }),
    cladding: flat({ color: 0x1a1816, roughness: 0.9 }),
    plaster: pbr(T.painted_plaster_wall, 2.4, { color: 0xeee7dc, normal: 0.6 }),
    steel: flat({ color: 0x121214, roughness: 0.42, metalness: 0.75 }),
    steelLight: flat({ color: 0x9a9c9f, roughness: 0.36, metalness: 0.9 }),
    mirror: flat({ color: 0xe4eaee, roughness: 0.04, metalness: 1 }),
    /** the underside of the floor slabs: smooth, with none of the wall's formwork joints */
    ceiling: pbr(T.painted_plaster_wall, 2.4, { color: 0xb8b3aa, normal: 0.5 }),
    brass: flat({ color: 0xb99458, roughness: 0.3, metalness: 1 }),
    stone: stoneMat,
    moss: pbr(T.coast_sand_rocks_02, 2.4, { color: 0xa8b08a }),
    panel: flat({ color: 0x0a1020, roughness: 0.12, metalness: 0.6 }),
    sofa: pbr(T.poly_wool_herringbone, 0.3, { color: 0xd6cdbf, useMap: false, normal: 1.1 }),
    linen: pbr(T.rough_linen, 0.45, { color: 0xd9d3c8, useMap: false }),
    duvet: pbr(T.rough_linen, 0.45, { color: 0x9b958a, useMap: false }),
    throw: pbr(T.waffle_pique_cotton, 0.28, { color: 0xe6d3b4 }),
    felt: pbr(T.poly_wool_herringbone, 0.3, { color: 0x2c2b29, useMap: false, normal: 0.6 }),
    rug: floor(pbr(T.poly_wool_herringbone, 0.45, { color: 0xd2c8b8, normal: 1.4 })),
    woodRaw: pbr(T.fine_grained_wood, 0.5, { color: 0xdcbf94, roughness: 1 }),
    ember,
    rust: pbr(T.knitted_fleece, 0.4, { color: 0xa5502c, useMap: false }),
    ochre: pbr(T.knitted_fleece, 0.4, { color: 0xc1903f, useMap: false }),
    forest: pbr(T.knitted_fleece, 0.4, { color: 0x3c4d3f, useMap: false }),
    glass,
  };
}
