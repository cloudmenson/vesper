import * as THREE from 'three';
import { LM_SIZE } from './builder';
import type { House } from './house';
import meta from './bake.json';

const BASE = `${import.meta.env.BASE_URL}assets/bake/`;

/**
 * Baked lighting, made by scripts/bake.mjs in Blender. Nothing in the house is lit live.
 *
 * Three layers share one atlas:
 *   lamps — light from every lamp and LED strip, bounces included
 *   fire  — the same for the hearth and the fire bowl, kept apart so the flames can flicker
 *   sky   — how much of an even sky each texel sees, bounces included
 * They are mixed on the GPU into a single lightmap whenever the lamps dim, the fire moves or the sky changes colour,
 * so dusk, night and dawn all come from the same bake.
 *
 * Loose objects (furniture, plants, everything that is not part of the building) carry the same three layers
 * per vertex, baked in the same pass: they sit in the room's light and shadow like the walls do.
 */
export interface Lightmap {
  texture: THREE.Texture;
  /** lamps and fire 0..1, sky = colour × intensity of the sky light */
  update: (lamps: number, fire: number, sky: THREE.Color) => void;
  /** Light arriving on the floor around a point, for the few things that have no baked light of their own. */
  probe: (at: THREE.Vector3, floors: THREE.Mesh[]) => { lamps: THREE.Color; sky: THREE.Color };
  /** per-vertex light for the loose meshes, 8 bytes each: lamps rgb, sky, fire rgb, unused */
  props: Uint8Array | null;
  propCounts: number[];
  /** what the vertex shader of a loose object needs to turn those bytes into light */
  vertexUniforms: {
    uBakeScale: THREE.IUniform<THREE.Vector3>;
    uBakeSky: THREE.IUniform<THREE.Color>;
    uBakeFill: THREE.IUniform<THREE.Color>;
  };
}

type LayerName = 'lamps' | 'fire' | 'sky';

interface Layer {
  texture: THREE.Texture;
  data: Uint8ClampedArray;
  max: number;
}

async function layer(name: LayerName): Promise<Layer> {
  const texture = await new THREE.TextureLoader().loadAsync(`${BASE}${name}.webp`);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false; // charts sit shoulder to shoulder: mips would bleed one into the next
  texture.minFilter = THREE.LinearFilter;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = LM_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(texture.image as CanvasImageSource, 0, 0, LM_SIZE, LM_SIZE);
  return { texture, data: ctx.getImageData(0, 0, LM_SIZE, LM_SIZE).data, max: meta[name].max };
}

/**
 * The loose meshes of the house, in the order the bake numbers them.
 * The exporter and the page both walk the house with this, so vertex n of mesh k means the same thing to both.
 */
export function looseMeshes(house: House) {
  const lit = new Set<THREE.Object3D>(house.lightmapped);
  const out: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D) => {
    if (o.userData.noBake) return; // the sliding door and skylight: they move, their shadows must not be frozen in
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !lit.has(mesh) && !(mesh as unknown as THREE.InstancedMesh).isInstancedMesh && !mesh.userData.emitter) {
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      // glass, flames, screens neither block nor take light here
      if (mat.isMeshStandardMaterial && !mat.transparent) out.push(mesh);
    }
    for (const c of o.children) walk(c);
  };
  walk(house.group);
  return out;
}

export async function loadLightmap(renderer: THREE.WebGLRenderer): Promise<Lightmap | null> {
  let lamps: Layer;
  let fire: Layer;
  let sky: Layer;
  let props: Uint8Array | null = null;
  try {
    [lamps, fire, sky] = await Promise.all([layer('lamps'), layer('fire'), layer('sky')]);
  } catch {
    return null; // not baked yet: the house is lit by the sky alone
  }
  try {
    const res = await fetch(`${BASE}props.bin`);
    if (res.ok) props = new Uint8Array(await res.arrayBuffer());
  } catch {
    props = null;
  }

  const target = new THREE.WebGLRenderTarget(LM_SIZE, LM_SIZE, { type: THREE.HalfFloatType, depthBuffer: false });
  target.texture.channel = 1; // the atlas UVs
  target.texture.generateMipmaps = false;
  const mixer = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tLamps: { value: lamps.texture },
      tFire: { value: fire.texture },
      tSky: { value: sky.texture },
      uLamps: { value: 1 },
      uFire: { value: 1 },
      uSky: { value: new THREE.Color() },
      uMax: { value: new THREE.Vector3(lamps.max, fire.max, sky.max) },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tLamps, tFire, tSky;
      uniform float uLamps, uFire;
      uniform vec3 uSky, uMax;
      varying vec2 vUv;
      void main(){
        // layers are stored as sqrt(value / max); values are Cycles' diffuse pass, i.e. irradiance / pi
        vec3 l = texture2D(tLamps, vUv).rgb; l = l * l * uMax.x;
        vec3 f = texture2D(tFire, vUv).rgb; f = f * f * uMax.y;
        vec3 s = texture2D(tSky, vUv).rgb; s = s * s * uMax.z;
        gl_FragColor = vec4(3.14159265 * (l * uLamps + f * uFire) + s * uSky, 1.0);
      }
    `,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mixer);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const camera = new THREE.Camera();
  let was = '';
  const vertexUniforms = {
    uBakeScale: { value: new THREE.Vector3() },
    uBakeSky: { value: new THREE.Color() },
    uBakeFill: { value: new THREE.Color() },
  };

  const decode = (L: Layer, u: number, v: number, out: THREE.Color) => {
    const x = Math.min(LM_SIZE - 1, Math.max(0, Math.floor(u * LM_SIZE)));
    const y = Math.min(LM_SIZE - 1, Math.max(0, Math.floor((1 - v) * LM_SIZE)));
    const i = (y * LM_SIZE + x) * 4;
    const f = (n: number) => (n / 255) ** 2 * L.max;
    return out.setRGB(f(L.data[i]), f(L.data[i + 1]), f(L.data[i + 2]));
  };
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);

  return {
    texture: target.texture,
    props,
    propCounts: meta.props.counts,
    vertexUniforms,
    update(level, flame, skyColor) {
      vertexUniforms.uBakeScale.value.set(Math.PI * lamps.max * level, Math.PI * fire.max * flame, sky.max);
      vertexUniforms.uBakeSky.value.copy(skyColor);
      const key = `${level.toFixed(3)}|${flame.toFixed(3)}|${skyColor.r.toFixed(3)}|${skyColor.g.toFixed(3)}|${skyColor.b.toFixed(3)}`;
      if (key === was) return;
      was = key;
      mixer.uniforms.uLamps.value = level;
      mixer.uniforms.uFire.value = flame;
      mixer.uniforms.uSky.value.copy(skyColor);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prev);
    },
    probe(at, floors) {
      // look at the floor in a ring around the object and keep the brighter half: the rest is in its own shadow
      const hits: { l: THREE.Color; s: THREE.Color; w: number }[] = [];
      for (const r of [0.55, 1.0]) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2 + r;
          ray.set(new THREE.Vector3(at.x + Math.cos(a) * r, at.y + 0.6, at.z + Math.sin(a) * r), down);
          ray.far = 2.2;
          const hit = ray.intersectObjects(floors, false)[0];
          if (!hit?.uv1) continue;
          const l = decode(lamps, hit.uv1.x, hit.uv1.y, new THREE.Color());
          const s = decode(sky, hit.uv1.x, hit.uv1.y, new THREE.Color());
          hits.push({ l, s, w: l.r + l.g + l.b + s.r + s.g + s.b });
        }
      }
      const out = { lamps: new THREE.Color(0, 0, 0), sky: new THREE.Color(0, 0, 0) };
      if (!hits.length) return out;
      hits.sort((p, q) => q.w - p.w);
      const best = hits.slice(0, Math.max(1, Math.ceil(hits.length / 2)));
      for (const h of best) {
        out.lamps.add(h.l);
        out.sky.add(h.s);
      }
      out.lamps.multiplyScalar(1 / best.length);
      out.sky.multiplyScalar(1 / best.length);
      return out;
    },
  };
}

/** A copy of a geometry that shares every buffer with the original and adds this mesh's own baked light. */
export function withBakedLight(src: THREE.BufferGeometry, data: Uint8Array, offset: number, count: number) {
  const geo = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) geo.setAttribute(name, attr);
  geo.index = src.index;
  for (const g of src.groups) geo.addGroup(g.start, g.count, g.materialIndex);
  geo.boundingBox = src.boundingBox;
  geo.boundingSphere = src.boundingSphere;
  const buffer = new THREE.InterleavedBuffer(data.subarray(offset * 8, (offset + count) * 8), 8);
  geo.setAttribute('bake0', new THREE.InterleavedBufferAttribute(buffer, 4, 0, true));
  geo.setAttribute('bake1', new THREE.InterleavedBufferAttribute(buffer, 4, 4, true));
  return geo;
}

function patch(mat: THREE.Material, tag: string, edit: (shader: THREE.WebGLProgramParametersWithUniforms) => void) {
  const before = mat.onBeforeCompile;
  const key = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    before.call(mat, shader, renderer);
    edit(shader);
  };
  mat.customProgramCacheKey = () => `${key}|${tag}`;
  mat.needsUpdate = true;
}

/** The environment map then only contributes reflections: its diffuse share is what the bake replaced. */
const noDiffuseIBL = (shader: THREE.WebGLProgramParametersWithUniforms, irradiance: string) => {
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <lights_fragment_begin>',
      THREE.ShaderChunk.lights_fragment_begin.replace('irradiance += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );', `irradiance += ${irradiance};`),
    )
    .replace('#include <lights_fragment_maps>', THREE.ShaderChunk.lights_fragment_maps.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', ''));
};

/**
 * Swaps the scene's even sky light for one baked value in a material.
 * Lightmapped surfaces pass a faint fill (their lightmap already holds the sky and the lamps).
 */
export function useBakedAmbient(mat: THREE.Material, ambient: THREE.IUniform<THREE.Color>) {
  patch(mat, 'baked-ambient', (shader) => {
    shader.uniforms.uBakedAmbient = ambient;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uBakedAmbient;');
    noDiffuseIBL(shader, 'uBakedAmbient');
  });
}

/** Lights a loose object from the three layers baked into its vertices (see `withBakedLight`). */
export function useBakedVertices(mat: THREE.Material, u: Lightmap['vertexUniforms']) {
  patch(mat, 'baked-vertices', (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute vec4 bake0;
        attribute vec4 bake1;
        uniform vec3 uBakeScale, uBakeSky, uBakeFill;
        varying vec3 vBaked;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        // stored as sqrt(value / max), like the lightmap
        vBaked = bake0.rgb * bake0.rgb * uBakeScale.x + bake1.rgb * bake1.rgb * uBakeScale.y + bake0.a * bake0.a * uBakeScale.z * uBakeSky + uBakeFill;`,
      );
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vBaked;');
    noDiffuseIBL(shader, 'vBaked');
  });
}
