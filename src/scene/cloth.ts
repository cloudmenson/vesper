import * as THREE from 'three';

const BASE = `${import.meta.env.BASE_URL}assets/cloth/`;

interface Meta {
  cols: number;
  rows: number;
  frames: number;
  width: number;
  height: number;
  scale: number;
}

/**
 * A sheer curtain whose every frame was simulated in Blender (scripts/cloth.py).
 * The frames live in a texture array, one layer each, one texel per vertex; the vertex shader
 * reads its position from there and blends between neighbouring frames, so the cloth can be
 * scrubbed forwards and backwards like the rest of the film.
 */
export async function loadCurtain() {
  let meta: Meta;
  let raw: Int16Array;
  try {
    [meta, raw] = await Promise.all([
      fetch(`${BASE}curtain.json`).then((r) => r.json() as Promise<Meta>),
      fetch(`${BASE}curtain.bin`).then(async (r) => new Int16Array(await r.arrayBuffer())),
    ]);
  } catch {
    return null;
  }
  const { cols, rows, frames } = meta;
  const count = cols * rows;

  // Blender's local frame is X along the rail, Y into the room, Z up; ours is X, up, and −Z into the room.
  const data = new Uint16Array(count * frames * 4);
  for (let i = 0; i < count * frames; i++) {
    data[i * 4] = THREE.DataUtils.toHalfFloat(raw[i * 3] * meta.scale);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(raw[i * 3 + 2] * meta.scale);
    data[i * 4 + 2] = THREE.DataUtils.toHalfFloat(-raw[i * 3 + 1] * meta.scale);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataArrayTexture(data, cols, rows, frames);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const index: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const n = j * cols + i;
      pos.set([(i / (cols - 1)) * meta.width, meta.height * (1 - j / (rows - 1)), 0], n * 3);
      uv.set([i / (cols - 1), j / (rows - 1)], n * 2);
      if (i < cols - 1 && j < rows - 1) index.push(n, n + cols, n + 1, n + 1, n + cols, n + cols + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3).fill(0), 3));
  geo.setIndex(index);

  const frame = { value: 0 };
  const mat = new THREE.MeshStandardMaterial({ color: 0xdcd6ca, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tCloth = { value: tex };
    sh.uniforms.uFrame = frame;
    sh.uniforms.uGrid = { value: new THREE.Vector3(cols, rows, frames) };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform highp sampler2DArray tCloth;
        uniform float uFrame;
        uniform vec3 uGrid;
        // position of the vertex at grid coordinate st, blended between the two nearest frames
        vec3 clothAt(vec2 st){
          vec2 t = (clamp(st, vec2(0.0), uGrid.xy - 1.0) + 0.5) / uGrid.xy;
          float f0 = floor(uFrame);
          float f1 = min(f0 + 1.0, uGrid.z - 1.0);
          return mix(texture(tCloth, vec3(t, f0)).xyz, texture(tCloth, vec3(t, f1)).xyz, fract(uFrame));
        }`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `vec2 clothSt = uv * (uGrid.xy - 1.0);
        vec3 clothPos = clothAt(clothSt);
        vec3 clothDx = clothAt(clothSt + vec2(1.0, 0.0)) - clothAt(clothSt - vec2(1.0, 0.0));
        vec3 clothDy = clothAt(clothSt + vec2(0.0, 1.0)) - clothAt(clothSt - vec2(0.0, 1.0));
        vec3 objectNormal = normalize(cross(clothDx, clothDy));`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = clothPos;');
  };
  mat.customProgramCacheKey = () => 'curtain';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  mesh.userData.noMirror = true;

  return {
    mesh,
    frames,
    /** `gust` 0 (door shut, cloth at rest) → 1 (door open, cloth out in the room); `time` keeps it breathing */
    update(gust: number, time: number) {
      const settle = frames - 1;
      const breathing = (Math.sin(time * 0.55) * 3.2 + Math.sin(time * 0.21 + 1.7) * 2.1) * gust;
      frame.value = Math.min(settle, Math.max(0, gust * settle * 0.8 + breathing));
    },
  };
}

export type Curtain = NonNullable<Awaited<ReturnType<typeof loadCurtain>>>;
