import * as THREE from 'three';
import { rng } from '../core/math';
import { terrainHeight } from './landscape';

/**
 * Fireflies: green-gold motes wandering over the shallows, along the pier and through the grass at the edge of the
 * trees. Each keeps to its own patch of air, loops about in it, and brightens and fades on its own slow breath —
 * a bright core in a soft halo, which the bloom pass then lets glow.
 */
export function createParticles() {
  const N = 420;
  const r = rng(4201);
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let guard = 0; guard < 60; guard++) {
      if (i % 5 < 2) {
        // where the visitor walks: along the shore either side of the pier, and out over the first of the water
        x = (r() * 2 - 1) * 15;
        z = 2.5 + r() * r() * 13;
        y = Math.max(terrainHeight(x, z), 0) + 0.3 + r() * r() * 2.2;
      } else if (i % 5 < 3) {
        // further out over the lake, thinning with distance
        x = (r() * 2 - 1) * 30 * Math.sqrt(r());
        z = 6 + r() * 30;
        y = 0.3 + r() * r() * 2.6;
      } else {
        // over the grass round the clearing
        const a = r() * Math.PI * 2;
        const d = 11 + r() * 15;
        x = Math.cos(a) * d * 1.15;
        z = -5 + Math.sin(a) * d * 0.9;
        y = Math.max(terrainHeight(x, z), 0) + 0.35 + r() * r() * 2.4;
      }
      if (!(Math.abs(x) < 9.8 && z > -9.9 && z < 5.7 && y < 8)) break; // not inside the house or through its terrace
    }
    pos.set([x, y, z], i * 3);
    seed.set([r(), r(), r()], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uLevel: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec3 aSeed;
      uniform float uTime, uPx;
      varying float vGlow;
      void main(){
        float s = aSeed.x * 6.2831;
        float t = uTime * (0.55 + aSeed.y * 0.5);
        // a looping, never quite repeating flight, a metre or two across
        vec3 p = position + vec3(
          sin(t * 0.37 + s * 3.0) * 1.3 + sin(t * 1.13 + s * 7.0) * 0.45,
          sin(t * 0.53 + s * 5.0) * 0.5 + sin(t * 1.7 + s * 2.0) * 0.16,
          cos(t * 0.31 + s * 4.0) * 1.3 + cos(t * 0.97 + s * 9.0) * 0.45);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        // each glows on its own breath: up over a second, down over two, dark a while
        float breath = fract(uTime * (0.11 + aSeed.z * 0.09) + aSeed.x);
        float glow = smoothstep(0.0, 0.16, breath) * (1.0 - smoothstep(0.22, 0.62, breath));
        float d = -mv.z;
        vGlow = (0.12 + 0.88 * glow) * smoothstep(0.3, 1.2, d) * (0.6 + 0.4 * aSeed.y);
        // the sprite is the halo, a hand's breadth of lit air round each insect; the insect itself is its core
        float size = uPx * 210.0 * (0.7 + 0.5 * aSeed.z) / d;
        // too far off to fill four pixels: dim rather than shrink, so it never twinkles between pixels
        vGlow *= min(1.0, size * size / 16.0);
        gl_PointSize = clamp(size, 4.0, 96.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLevel;
      varying float vGlow;
      void main(){
        vec2 q = (gl_PointCoord - 0.5) * 2.0;
        float r2 = dot(q, q);
        float halo = exp(-r2 * 4.5) - 0.011;
        float core = exp(-r2 * 190.0);
        vec3 col = vec3(0.22, 1.0, 0.1) * halo * 0.42 + vec3(0.62, 1.0, 0.3) * exp(-r2 * 30.0) * 0.9 + vec3(0.9, 1.0, 0.6) * core * 4.5;
        gl_FragColor = vec4(max(col, 0.0) * vGlow * uLevel, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 6;
  return { fireflies: { points, uniforms: mat.uniforms } };
}

/* ------------------------------------------------------------------ extras */

/**
 * Sparks off the fire bowl on the terrace: pin-points that leave the flames fast, jink as they climb, and are out
 * again within a metre or so. Most never get that far. (Anything bigger or longer-lived reads as lanterns adrift.)
 */
export function createEmbers(x: number, y: number, z: number) {
  const N = 22;
  const seed = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) seed[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uLevel: { value: 1 }, uOrigin: { value: new THREE.Vector3(x, y, z) } },
    vertexShader: /* glsl */ `
      attribute vec3 aSeed;
      uniform float uTime, uPx;
      uniform vec3 uOrigin;
      varying float vA, vAge;
      void main(){
        float run = uTime * (0.45 + aSeed.x * 0.5) + aSeed.y * 7.0;
        float age = fract(run);
        float life = floor(run);                        // each spark is a new one every time round
        float s = aSeed.z * 6.2831 + life * 2.4;
        float reach = 0.25 + 0.75 * fract(sin(life * 12.9898 + aSeed.z * 78.233) * 43758.5453); // how far this one gets
        float up = (1.0 - (1.0 - age) * (1.0 - age)) * (0.35 + aSeed.x * 0.75) * reach;         // fast off the fire, slowing
        float out_ = 0.05 + 0.16 * age;
        vec3 p = uOrigin + vec3(
          sin(s) * out_ + sin(uTime * 5.0 + s * 3.0) * 0.035 * age,
          up,
          cos(s) * out_ + cos(uTime * 4.3 + s * 5.0) * 0.035 * age);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vAge = age;
        vA = (1.0 - age) * (1.0 - age) * smoothstep(0.0, 0.05, age);
        // a spark is a few millimetres of glowing bark: one too far off to fill a pixel and a half dims instead
        float size = uPx * 0.2 / -mv.z;
        vA *= min(1.0, size * size * 0.45);
        gl_PointSize = clamp(size, 1.5, 4.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLevel;
      varying float vA, vAge;
      void main(){
        float a = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5));
        vec3 hot = mix(vec3(6.0, 2.6, 0.7), vec3(2.2, 0.35, 0.05), vAge); // yellow-white leaving the fire, red as it dies
        gl_FragColor = vec4(hot * a * vA * uLevel, 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 6;
  return { points, uniforms: mat.uniforms };
}

/**
 * Smoke off the fire bowl once the fire is out: a thin grey column that leaves the ash quickly, slows as it cools,
 * leans away down the wind and thins to nothing a couple of metres up. `uTint` is the colour of the sky's light
 * on it: smoke has none of its own.
 */
export function createSmoke(x: number, y: number, z: number) {
  const N = 26;
  const seed = new Float32Array(N * 3);
  for (let i = 0; i < N * 3; i++) seed[i] = Math.random();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uLevel: { value: 0 }, uTint: { value: new THREE.Color(0.2, 0.2, 0.22) }, uOrigin: { value: new THREE.Vector3(x, y, z) } },
    vertexShader: /* glsl */ `
      attribute vec3 aSeed;
      uniform float uTime, uPx;
      uniform vec3 uOrigin;
      varying float vA, vSeed;
      void main(){
        float run = uTime * (0.055 + aSeed.x * 0.03) + aSeed.y;
        float age = fract(run);
        float s = aSeed.z * 6.2831 + floor(run) * 1.7;
        float up = (1.0 - (1.0 - age) * (1.0 - age) * 0.5) * age * (1.5 + aSeed.x) * 1.5;
        vec3 p = uOrigin + vec3(
          sin(s) * 0.05 + age * age * 1.0 + sin(uTime * 0.6 + s) * 0.11 * age,
          up,
          cos(s) * 0.05 + age * age * 0.45 + cos(uTime * 0.47 + s * 1.3) * 0.11 * age);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uPx * 1100.0 * (0.14 + age * 0.85) / -mv.z, 2.0, 280.0);
        vA = smoothstep(0.0, 0.1, age) * (1.0 - age) * (1.0 - age) * 0.42;
        vSeed = aSeed.z;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTint;
      uniform float uLevel;
      varying float vA, vSeed;
      void main(){
        vec2 q = (gl_PointCoord - 0.5) * 2.0;
        // a puff: soft-edged, and lumpier on one side than the other
        float lump = 0.78 + 0.22 * sin(atan(q.y, q.x) * 3.0 + vSeed * 20.0);
        float a = exp(-dot(q, q) * 3.4 / (lump * lump)) - 0.034;
        if (a <= 0.0 || uLevel <= 0.0) discard;
        gl_FragColor = vec4(uTint, a * vA * uLevel);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 6;
  points.userData.noMirror = true;
  return { points, uniforms: mat.uniforms };
}

/**
 * Rain: streaks falling through a box of air that goes wherever the camera goes, each drop wrapping round to the
 * top as it leaves the bottom. Nothing falls inside the house (`uHouse` is its footprint and its roof).
 */
export function createRain() {
  const N = 1500;
  const pos = new Float32Array(N * 6);
  const seed = new Float32Array(N * 8);
  for (let i = 0; i < N; i++) {
    const s = [Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < 2; k++) seed.set([...s, k], (i * 2 + k) * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aDrop', new THREE.BufferAttribute(seed, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uTint: { value: new THREE.Color(0.2, 0.22, 0.26) } },
    vertexShader: /* glsl */ `
      attribute vec4 aDrop; // where in the box, and which end of the streak
      uniform float uTime;
      varying float vIn;
      void main(){
        vec3 box = vec3(26.0, 15.0, 26.0);
        vec3 p = aDrop.xyz * box;
        p.y -= uTime * (8.0 + aDrop.x * 3.0);
        p.x += uTime * 0.9; // a little wind in it
        // wrap round the camera
        p = mod(p - cameraPosition, box) - box * 0.5 + cameraPosition;
        p += vec3(0.04, 0.42, 0.0) * aDrop.w;
        // under a roof it does not rain
        vIn = step(abs(p.x), 8.4) * step(-9.3, p.z) * step(p.z, 2.6) * step(p.y, 7.9);
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLevel;
      uniform vec3 uTint;
      varying float vIn;
      void main(){
        if (vIn > 0.5 || uLevel <= 0.001) discard;
        gl_FragColor = vec4(uTint * uLevel, 1.0);
      }
    `,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 6;
  lines.userData.noMirror = true;
  return { lines, uniforms: mat.uniforms };
}

/**
 * Rain on a pane of glass lying flat — the skylight over the bed — seen from underneath: every drop that lands
 * opens a ring that widens and is gone. `w` × `d` metres, centred on (x, y, z).
 */
export function createRipples(w: number, d: number, x: number, y: number, z: number) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uSize: { value: new THREE.Vector2(w, d) }, uTint: { value: new THREE.Color(0.3, 0.34, 0.4) } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLevel;
      uniform vec2 uSize;
      uniform vec3 uTint;
      varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        if (uLevel <= 0.001) discard;
        vec2 p = vUv * uSize;
        float sum = 0.0;
        for (int i = 0; i < 28; i++) {
          float fi = float(i);
          float run = uTime * (0.7 + 0.5 * hash(vec2(fi, 1.0))) + hash(vec2(fi, 2.0));
          float age = fract(run);
          float n = floor(run);
          vec2 c = vec2(hash(vec2(fi, n)), hash(vec2(n, fi + 9.0))) * uSize;
          float r = age * 0.13;
          float ring = smoothstep(0.012, 0.0, abs(length(p - c) - r)) * (1.0 - age) * (1.0 - age);
          sum += ring + smoothstep(0.02, 0.0, length(p - c)) * smoothstep(0.12, 0.0, age) * 1.5; // and the drop itself, as it lands
        }
        gl_FragColor = vec4(uTint * sum * uLevel, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), mat);
  mesh.position.set(x, y, z);
  mesh.renderOrder = 6;
  mesh.userData.noMirror = true;
  return { mesh, uniforms: mat.uniforms };
}

/**
 * A fish rising: rings spreading on the lake from one point, and gone in a few seconds. `rise(x, z, time)` starts
 * one; until then nothing is drawn.
 */
export function createRise() {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uTime: { value: 0 }, uStart: { value: -100 }, uTint: { value: new THREE.Color(0.2, 0.24, 0.3) } },
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main(){
        vP = position.xz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uStart;
      uniform vec3 uTint;
      varying vec2 vP;
      void main(){
        float t = uTime - uStart;
        if (t < 0.0 || t > 6.0) discard;
        float d = length(vP);
        float sum = 0.0;
        for (int k = 0; k < 3; k++) {
          float tk = t - float(k) * 0.45;
          if (tk < 0.0) continue;
          sum += smoothstep(0.06, 0.0, abs(d - tk * 0.42)) * exp(-tk * 0.7) * (1.0 - float(k) * 0.25);
        }
        gl_FragColor = vec4(uTint * sum * smoothstep(6.0, 4.0, t), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 6).rotateX(-Math.PI / 2), mat);
  mesh.renderOrder = 4;
  mesh.frustumCulled = false;
  mesh.userData.noMirror = true;
  const rise = (x: number, z: number, time: number) => {
    mesh.position.set(x, 0.035, z);
    mat.uniforms.uStart.value = time;
  };
  return { mesh, uniforms: mat.uniforms, rise };
}

/** A skein of geese crossing the lake at dawn: each a body and two jointed wings, beating out of step with its neighbours. */
export function createBirds() {
  const N = 13;
  const pos: number[] = [];
  const data: number[] = []; // x: how far out along the wing (0 body … 1 tip), y: this bird's phase, z: bird index
  const r = rng(31);
  for (let i = 0; i < N; i++) {
    const row = Math.ceil(i / 2);
    const side = i % 2 ? 1 : -1;
    const ox = row * 2.1 * side + (r() - 0.5) * 0.8;
    const oy = (r() - 0.5) * 1.2;
    const oz = -row * 1.9 + (r() - 0.5) * 0.8;
    const ph = r() * 6.28;
    const v = (x: number, z: number, out: number) => {
      pos.push(ox + x, oy, oz + z);
      data.push(out, ph, i);
    };
    // body and neck: a long thin diamond
    v(0, 0.42, 0);
    v(-0.05, 0, 0);
    v(0.05, 0, 0);
    v(0, -0.3, 0);
    v(0.05, 0, 0);
    v(-0.05, 0, 0);
    // each wing: an arm and a hand, swept back and tapering to a point
    for (const sgn of [-1, 1]) {
      const [a0, a1, b0, b1, tip] = [
        [0.04 * sgn, 0.1],
        [0.04 * sgn, -0.12],
        [0.42 * sgn, 0.04],
        [0.42 * sgn, -0.14],
        [0.86 * sgn, -0.2],
      ];
      const quad: [number[], number][] = [
        [a0, 0],
        [a1, 0],
        [b0, 0.5],
        [b0, 0.5],
        [a1, 0],
        [b1, 0.5],
        [b0, 0.5],
        [b1, 0.5],
        [tip, 1],
      ];
      for (const [p, out] of quad) v(p[0], p[1], out);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aData', new THREE.Float32BufferAttribute(data, 3));
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    fog: false,
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uColor: { value: new THREE.Color(0x15131a) } },
    vertexShader: /* glsl */ `
      attribute vec3 aData;
      uniform float uTime;
      void main(){
        vec3 p = position;
        // the hand follows the arm a beat late: that lag is what makes a wingbeat read as one
        float beat = uTime * 4.6 + aData.y;
        p.y += aData.x * sin(beat - aData.x * 0.9) * 0.34 + aData.x * 0.06;
        p.y += sin(uTime * 0.7 + aData.z) * 0.3;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `uniform vec3 uColor; uniform float uLevel; void main(){ gl_FragColor = vec4(uColor, uLevel); }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.rotation.y = -1.9;
  /** flies a long diagonal over the water and comes round again */
  const update = (time: number, level: number) => {
    mat.uniforms.uTime.value = time;
    mat.uniforms.uLevel.value = level;
    mesh.visible = level > 0.01;
    const t = (time * 0.035) % 1;
    mesh.position.set(-150 + t * 300, 21 + Math.sin(t * 6.28) * 3, 110 - t * 95);
  };
  return { mesh, update };
}

/** Now and then, something burns up over the lake. */
export function createMeteor() {
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uLevel: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uLevel;
      varying vec2 vUv;
      void main(){
        float core = smoothstep(0.5, 0.0, abs(vUv.y - 0.5));
        float tail = pow(vUv.x, 2.5);
        gl_FragColor = vec4(vec3(0.85, 0.92, 1.0) * core * core * tail * uLevel * 2.5, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -85;
  const dir = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  let last = -1;
  /** `stars` 0..1: only shows on a dark sky. Follows the camera like the rest of the dome. */
  const update = (time: number, stars: number, cam: THREE.Vector3) => {
    const period = 7.5;
    const k = Math.floor(time / period);
    const t = (time % period) / 0.9; // the streak itself lasts under a second
    if (k !== last) {
      last = k;
      const r = (n: number) => {
        const x = Math.sin(k * 127.1 + n * 311.7) * 43758.5453;
        return x - Math.floor(x);
      };
      // somewhere high over the water, falling toward the horizon
      a.set(r(1) * 1.6 - 0.8, 0.95 + r(2) * 0.5, 0.9 + r(3) * 0.6).normalize();
      b.copy(a).add(new THREE.Vector3(r(4) * 0.5 - 0.25, -0.22 - r(5) * 0.1, r(6) * 0.2 - 0.1)).normalize();
    }
    const on = t < 1 && stars > 0.5;
    mesh.visible = on;
    if (!on) return;
    dir.lerpVectors(a, b, t);
    mesh.position.copy(cam).addScaledVector(dir, 1900);
    mesh.scale.set(260, 5, 1);
    mesh.lookAt(cam);
    // lay the streak along its path
    mesh.rotateZ(Math.atan2(b.y - a.y, b.x - a.x));
    mat.uniforms.uLevel.value = Math.sin(t * Math.PI) * stars;
  };
  return { mesh, update };
}
