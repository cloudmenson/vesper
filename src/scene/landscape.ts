import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { Noise, rng, lerp, smoothstep } from '../core/math';
import type { Assets } from './assets';
import skyMeta from './sky.json';

const GLSL_NOISE = /* glsl */ `
  float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f*f*(3.0-2.0*f);
    return mix(mix(hash21(i), hash21(i+vec2(1,0)), u.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), u.x), u.y);
  }
  float fbm(vec2 p){
    float a = 0.5, s = 0.0;
    for(int i=0;i<5;i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= 0.5; }
    return s;
  }
`;

/** Shared by the forest and the mountains; the atmosphere writes the sky's light into it each frame. */
export const forestLight = {
  uSky: { value: new THREE.Color() },
  uGround: { value: new THREE.Color() },
  uKey: { value: new THREE.Color() },
  uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
  uFogColor: { value: new THREE.Color() },
  uFogDensity: { value: 0.005 },
  /** the clock the trees sway by, and how hard it is blowing (1 by night, dropping at first light) */
  uTime: { value: 0 },
  uWind: { value: 1 },
};

/**
 * The wind in the trees. A spruce bends from the foot, most at the top: `h` is how far up the tree a point is
 * (0 … 1), `tall` the tree's height in metres, `base` where it stands. Gusts cross the forest as slow waves, so
 * neighbours lean together and the far side of the clearing follows a moment later; each tree rocks to its own beat
 * on top of that.
 */
const SWAY = /* glsl */ `
  uniform float uTime, uWind;
  vec3 sway(vec3 base, float h, float tall){
    float own = base.x * 0.071 + base.z * 0.113;
    float gust = 0.5 + 0.5 * sin(uTime * 0.23 - base.x * 0.021 - base.z * 0.017);
    float rock = sin(uTime * 0.83 + own * 6.0) * 0.6 + sin(uTime * 1.61 + own * 11.0) * 0.25;
    return vec3(0.8, 0.0, 0.6) * (h * h * tall * 0.011 * uWind * (0.3 + 0.7 * gust) * (1.0 + rock));
  }
`;

/* ------------------------------------------------------------------ sky */

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;

/** compass bearings of sunset and sunrise, as unit vectors on the ground */
export const DUSK_AZIMUTH = new THREE.Vector3(-0.16, 0, -1).normalize();
export const DAWN_AZIMUTH = new THREE.Vector3(0.58, 0, 0.82).normalize();

/**
 * The air, shared by everything that has to melt into it: the dome itself, the haze in front of the mountains,
 * the fog on the far shore. `tTwilight` is a stack of skies rendered for a ladder of sun elevations
 * (scripts/sky.py); `uSunLayer` says how far up the ladder the sun is right now.
 */
export const air = {
  tTwilight: { value: null as THREE.Data3DTexture | null },
  uSunAzimuth: { value: DUSK_AZIMUTH.clone() },
  uSunLayer: { value: 0 },
  uSkyGain: { value: 1 },
  uNightAir: { value: 0 },
};
const [SKY_W, SKY_H, SKY_N] = skyMeta.size;
export const GLSL_AIR = /* glsl */ `
  uniform highp sampler3D tTwilight;
  uniform vec3 uSunAzimuth;
  uniform float uSunLayer, uSkyGain, uNightAir;
  // the colour of the sky in direction d (anything below the horizon takes the horizon's)
  vec3 airColor(vec3 d){
    float el = asin(clamp(d.y, 0.0, 1.0));
    vec2 h = normalize(d.xz + vec2(1e-6, 0.0));
    float az = acos(clamp(dot(h, uSunAzimuth.xz), -1.0, 1.0)) * 0.31830989;
    vec3 size = vec3(${SKY_W}.0, ${SKY_H}.0, ${SKY_N}.0);
    // uSunLayer already counts layers; the other two run 0..1 across their axis
    vec3 uvw = (vec3(az, sqrt(el * 0.63661977), uSunLayer / (size.z - 1.0)) * (size - 1.0) + 0.5) / size;
    vec3 col = texture(tTwilight, uvw).rgb * uSkyGain;
    // a night sky is never quite black: airglow, and the light of all the stars too faint to see
    col += mix(vec3(0.0105, 0.0135, 0.023), vec3(0.0032, 0.0046, 0.0105), smoothstep(0.0, 0.55, d.y)) * uNightAir;
    return col;
  }
`;

/**
 * Turns the celestial sphere so the Milky Way stands on the lake: its bright centre 38° up over the water,
 * the band climbing from there through the zenith, where the skylight looks.
 */
const CELESTIAL = (() => {
  const eq = (ra: number, dec: number) => new THREE.Vector3(Math.cos(dec * RAD) * Math.cos(ra * RAD), Math.cos(dec * RAD) * Math.sin(ra * RAD), Math.sin(dec * RAD));
  const centre = eq(266.405, -28.936);
  const pole = eq(192.859, 27.128);
  const from = new THREE.Matrix4().makeBasis(centre, new THREE.Vector3().crossVectors(pole, centre), pole);
  const A = new THREE.Vector3(0.12, Math.sin(38 * RAD), Math.cos(38 * RAD)).normalize();
  const C = new THREE.Vector3(1, 0, 0).addScaledVector(A, -A.x).normalize(); // the galactic pole on the horizon: the band stands upright
  const to = new THREE.Matrix4().makeBasis(A, new THREE.Vector3().crossVectors(C, A), C);
  return new THREE.Matrix3().setFromMatrix4(to.multiply(from.transpose()));
})();

/**
 * The sky is assembled, not photographed: the air from a physical atmosphere model, the Milky Way from NASA's
 * map of the galaxy's light, and — drawn separately, see `createStars` — every star of the Bright Star Catalogue.
 */
export function createSky(sky: Assets['sky']) {
  air.tTwilight.value = sky.twilight;
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      ...air,
      tMilky: { value: sky.milkyway },
      uCelestial: { value: CELESTIAL.clone().transpose() }, // world → equatorial
      uMilky: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.8, 0.55) },
      uSunDisc: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tMilky;
      uniform mat3 uCelestial;
      uniform vec3 uSunDir, uSunColor;
      uniform float uSunDisc, uMilky;
      varying vec3 vDir;
      ${GLSL_AIR}
      float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      void main(){
        vec3 d = normalize(vDir);
        vec3 col = airColor(d);
        // the galaxy, dimmed by the thicker air toward the horizon
        vec3 e = uCelestial * d;
        vec2 uv = vec2(0.5 - atan(e.y, e.x) * 0.15915494, 0.5 + asin(clamp(e.z, -1.0, 1.0)) * 0.31830989);
        vec3 galaxy = texture2D(tMilky, uv).rgb;
        col += galaxy * galaxy * uMilky * smoothstep(0.0, 0.3, d.y) * (0.6 + 0.4 * smoothstep(0.1, 0.6, d.y));
        // the sun: a disc with a soft limb, and the glare the eye adds round it
        float s = max(dot(d, uSunDir), 0.0);
        col += uSunColor * uSunDisc * (smoothstep(0.99994, 0.99998, s) + pow(s, 1800.0) * 0.06 + pow(s, 120.0) * 0.006);
        col += (hash(gl_FragCoord.xy) - 0.5) * 0.004 * (0.3 + col); // dither: wide soft gradients band in 8 bits
        gl_FragColor = vec4(max(col, 0.0), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2600, 64, 32), mat);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;

  /** The sky's colour in a direction, read from the same data the shader uses: for fog and ambient light. */
  const layer = (out: THREE.Color, k: number, az: number, el: number) => {
    const x = Math.min(SKY_W - 1, Math.max(0, az * (SKY_W - 1)));
    const y = Math.min(SKY_H - 1, Math.max(0, Math.sqrt(Math.max(el, 0) / (Math.PI / 2)) * (SKY_H - 1)));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, SKY_W - 1);
    const y1 = Math.min(y0 + 1, SKY_H - 1);
    const fx = x - x0;
    const fy = y - y0;
    const at = (i: number, j: number, c: number) => sky.air[((k * SKY_H + j) * SKY_W + i) * 3 + c];
    const ch = (c: number) => lerp(lerp(at(x0, y0, c), at(x1, y0, c), fx), lerp(at(x0, y1, c), at(x1, y1, c), fx), fy);
    return out.setRGB(ch(0), ch(1), ch(2));
  };
  const a = new THREE.Color();
  const b = new THREE.Color();
  /** `azimuth` 0 toward the sun … 1 away from it; `elevation` in radians */
  const sample = (out: THREE.Color, azimuth: number, elevation: number) => {
    const w = air.uSunLayer.value;
    const k = Math.min(SKY_N - 2, Math.floor(w));
    layer(a, k, azimuth, elevation);
    layer(b, k + 1, azimuth, elevation);
    return out.lerpColors(a, b, w - k).multiplyScalar(air.uSkyGain.value);
  };
  return { mesh, uniforms: mat.uniforms, sample };
}

/**
 * Clouds: fair-weather cumulus cut out of a photograph of a real sky (scripts/clouds.mjs), so they have the shapes,
 * the soft edges and the perspective of clouds overhead rather than of noise. The picture gives two things for every
 * direction: how much cloud there is, and how brightly its sun lit it. Here they are lit again by this sky at this
 * hour, softly: pale and half transparent, never the black shapes a cloud lit from nowhere would be.
 * They dim the stars behind them and drift round the lake too slowly to be seen moving.
 */
export function createClouds(map: THREE.Texture) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: { ...air, tClouds: { value: map }, uTime: { value: 0 }, uTurn: { value: 0.62 }, uRain: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tClouds;
      uniform float uTime, uTurn, uRain;
      varying vec3 vDir;
      ${GLSL_AIR}
      void main(){
        vec3 d = normalize(vDir);
        if (d.y < 0.004) discard;
        float e = clamp(asin(d.y) / 1.5707963, 0.004, 0.996);              // 0 at the horizon, 1 overhead
        float u = atan(d.z, d.x) / 6.2831853 + uTurn + uTime * 0.00025;
        // the picture is two, one above the other: how much cloud (top), how it was lit (bottom). Read a little
        // out of focus (five taps): a cloud at night has no hard edge.
        vec2 uv = vec2(u, 0.5 + 0.5 * e);
        float a = texture2D(tClouds, uv).r * 0.36;
        a += (texture2D(tClouds, uv + vec2(0.0011, 0.0)).r + texture2D(tClouds, uv - vec2(0.0011, 0.0)).r) * 0.16;
        a += (texture2D(tClouds, uv + vec2(0.0, 0.002)).r + texture2D(tClouds, uv - vec2(0.0, 0.002)).r) * 0.16;
        float lit = texture2D(tClouds, vec2(u, 0.5 * e)).r;
        a *= smoothstep(0.004, 0.07, d.y);                                 // they sink into the haze at the horizon
        a *= 1.0 - smoothstep(0.3, 0.68, d.y) * (1.0 - uRain);             // and keep to the lower sky: overhead is for the stars
        // when it rains the gaps close: one grey ceiling, the same clouds showing in it as heavier patches
        a = mix(a, 0.82 + 0.18 * a, uRain * smoothstep(0.004, 0.09, d.y));
        // Lit by the sky they hang in, so they belong to it: their shaded sides a shade under the sky behind them,
        // their crowns a little over it, and warmer on the side where the horizon glows. Thin enough to see through.
        vec3 here = airColor(d);
        vec3 glow = airColor(normalize(vec3(d.x, 0.05, d.z)));
        vec3 base = here * 0.8 + glow * 0.08;
        vec3 crown = here * 1.3 + glow * 0.5 + vec3(0.012, 0.015, 0.024) * uNightAir;
        vec3 col = mix(base, crown, lit * lit * (3.0 - 2.0 * lit));
        col = mix(col, (base + crown) * 0.42, uRain * 0.8);
        gl_FragColor = vec4(col, a * mix(0.66, 0.97, uRain));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2500, 48, 24), mat);
  mesh.renderOrder = -86; // over the stars, under the mountains
  mesh.frustumCulled = false;
  return { mesh, uniforms: mat.uniforms };
}

/**
 * The northern lights. The house stands at 61° north, and on a clear night in the small hours they come: curtains
 * hung across the sky over the lake, sharp along the hem and fading upward in rays, green below and violet above,
 * drifting. Drawn on a dome of their own between the stars and the clouds, light added to light.
 */
export function createAurora() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uLevel;
      varying vec3 vDir;
      float hash(float n){ return fract(sin(n) * 43758.5453); }
      float noise(float x){ float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }
      void main(){
        vec3 d = normalize(vDir);
        if (d.y < 0.03 || uLevel <= 0.001) discard;
        float az = atan(d.x, d.z); // 0 is south, over the water
        float el = asin(d.y);
        vec3 col = vec3(0.0);
        for (int k = 0; k < 3; k++) {
          float fk = float(k);
          float drift = uTime * (0.011 + 0.005 * fk);
          // the hem of this curtain: an arc across the sky that wanders
          float hem = 0.17 + 0.12 * fk + 0.07 * sin(az * 1.7 + drift * 3.0 + fk * 2.1) + 0.035 * sin(az * 4.3 - drift * 5.0 + fk);
          float h = el - hem;
          float body = smoothstep(-0.012, 0.022, h) * exp(-max(h, 0.0) / (0.15 + 0.05 * fk));
          // its rays: fine upright streaks that run along it
          float rays = 0.5 + 0.5 * noise(az * 44.0 + fk * 17.0 + uTime * 0.3) * (0.55 + 0.45 * noise(az * 130.0 - uTime * 0.55));
          float along = smoothstep(0.18, 0.62, noise(az * 1.25 + fk * 5.0 + drift * 2.2)); // it comes and goes along its length
          float span = smoothstep(1.9, 1.0, abs(az - 0.22 * fk + 0.15));                  // and keeps to the sky over the lake
          vec3 hue = mix(vec3(0.14, 1.0, 0.4), vec3(0.5, 0.22, 0.86), smoothstep(0.02, 0.3, h));
          col += hue * body * rays * along * span * (0.52 - 0.1 * fk);
        }
        gl_FragColor = vec4(col * uLevel * 0.85, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2400, 64, 32), mat);
  mesh.renderOrder = -87; // over the stars, under the clouds
  mesh.frustumCulled = false;
  return { mesh, uniforms: mat.uniforms };
}

/**
 * The chart the telescope lays over the sky: the figures of the constellations as thin lines, on the same sphere as
 * the stars and turned as they are. (Their names, and the bright stars', are set in type by ui.ts: `dir` gives
 * the direction in the sky of a point with a given right ascension and declination.)
 */
export function createChart(lines: number[][]) {
  const dir = (ra: number, dec: number, out = new THREE.Vector3()) => out.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)).applyMatrix3(CELESTIAL);
  const pos: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const line of lines) {
    for (let i = 0; i + 3 < line.length; i += 2) {
      dir(line[i], line[i + 1], a).multiplyScalar(2250);
      dir(line[i + 2], line[i + 3], b).multiplyScalar(2250);
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uLevel: { value: 0 } },
    vertexShader: /* glsl */ `
      void main(){
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLevel;
      void main(){
        gl_FragColor = vec4(vec3(0.5, 0.62, 0.85) * uLevel, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.LineSegments(geo, mat);
  mesh.renderOrder = -87;
  mesh.frustumCulled = false;
  mesh.visible = false;
  return { mesh, uniforms: mat.uniforms, dir };
}

/** Where the sun stands on the ladder of baked skies, as a layer index with a fraction. */
export function sunLayer(elevation: number) {
  const E = skyMeta.elevations;
  if (elevation <= E[0]) return 0;
  for (let i = 0; i < E.length - 1; i++) if (elevation <= E[i + 1]) return i + (elevation - E[i]) / (E[i + 1] - E[i]);
  return E.length - 1;
}

/**
 * The stars: each one a real star at its catalogued place, brightness and colour (and behind them a dust of
 * fainter ones that thickens toward the galaxy's plane). Each is drawn as a soft dot a few pixels wide however
 * faint it is, with its brightness carried by intensity rather than size: as the camera turns it slides
 * between pixels instead of hopping from one to the next, which is what made the old sky flicker.
 */
export function createStars(catalogue: Float32Array) {
  const N = catalogue.length / 4;
  const pos = new Float32Array(N * 3);
  const data = new Float32Array(N * 3);
  const v = new THREE.Vector3();
  const r = rng(404);
  for (let i = 0; i < N; i++) {
    const ra = catalogue[i * 4];
    const dec = catalogue[i * 4 + 1];
    v.set(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)).applyMatrix3(CELESTIAL).multiplyScalar(2300);
    pos.set([v.x, v.y, v.z], i * 3);
    data.set([catalogue[i * 4 + 2], catalogue[i * 4 + 3], r()], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aStar', new THREE.BufferAttribute(data, 3));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
    uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 }, uPx: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec3 aStar; // magnitude, B-V colour index, a random number
      uniform float uTime, uPx, uIntensity;
      varying vec3 vCol;
      void main(){
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        float h = normalize(position).y;
        // five magnitudes are a factor of a hundred; squeezed a little, or only the brightest dozen would show
        float flux = pow(10.0, -0.4 * (aStar.x - 2.0) * 0.72);
        // more air toward the horizon: dimmer, redder, less steady
        float airmass = 1.0 / max(h + 0.06, 0.04);
        float dim = exp(-0.11 * (airmass - 1.0)) * smoothstep(-0.02, 0.05, h);
        float steady = smoothstep(0.0, 0.6, h);
        float twinkle = 1.0 + (0.22 - 0.17 * steady) * sin(uTime * (1.6 + aStar.z * 2.6) + aStar.z * 100.0);
        float bv = aStar.y + 0.5 * (1.0 - steady) * (1.0 - steady);
        vec3 tint = bv < 0.4 ? mix(vec3(0.64, 0.76, 1.0), vec3(1.0, 0.98, 0.95), clamp((bv + 0.3) / 0.7, 0.0, 1.0))
                             : mix(vec3(1.0, 0.98, 0.95), vec3(1.0, 0.72, 0.46), clamp((bv - 0.4) / 1.2, 0.0, 1.0));
        float size = 4.4 + 1.5 * clamp(log2(1.0 + flux), 0.0, 3.2);
        vCol = tint * flux * dim * twinkle * uIntensity * 1.15;
        gl_PointSize = size * uPx;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vCol;
      void main(){
        vec2 q = (gl_PointCoord - 0.5) * 2.0;
        gl_FragColor = vec4(vCol * exp(-dot(q, q) * 4.2), 1.0);
      }
    `,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -90;
  return { points, uniforms: mat.uniforms };
}

/* ------------------------------------------------------------ mountains */

/**
 * The range around the lake is real terrain, raised in Blender (scripts/landscape.py): ridged relief on a ring
 * of ground from 330 m to 2 km out. Being geometry, it shades with the sun — silhouettes at dusk, alpenglow at dawn —
 * and shifts against the forest as the camera moves.
 */
export function createMountains(model: THREE.Group) {
  const uniforms = { ...air, ...forestLight };
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vN;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSky, uGround, uKey, uKeyDir;
      varying vec3 vWorld;
      varying vec3 vN;
      ${GLSL_NOISE}
      ${GLSL_AIR}
      void main(){
        vec3 n = normalize(vN);
        // the mesh carries the big shapes; gullies and outcrops finer than its triangles are added to the normal here
        vec2 q = vWorld.xz * 0.021;
        float r0 = fbm(q);
        vec2 grad = vec2(fbm(q + vec2(0.35, 0.0)) - r0, fbm(q + vec2(0.0, 0.35)) - r0);
        n = normalize(n - vec3(grad.x, 0.0, grad.y) * 2.6 * (1.0 - n.y * 0.5));
        float rough = fbm(vWorld.xz * 0.012);
        float steep = 1.0 - n.y;
        float alt = vWorld.y + (rough - 0.5) * 70.0;
        // forest up to the tree line, thinning as it climbs; bare rock on the steeps; snow wherever it is high and flat enough to lie
        float trees = (1.0 - smoothstep(70.0, 150.0, alt + r0 * 40.0)) * (1.0 - smoothstep(0.28, 0.5, steep));
        float snow = smoothstep(175.0, 250.0, alt + r0 * 50.0) * (1.0 - smoothstep(0.36, 0.62, steep + r0 * 0.2));
        vec3 rock = mix(vec3(0.17, 0.16, 0.16), vec3(0.3, 0.27, 0.24), r0) * (0.8 + 0.4 * fbm(vec2(vWorld.y * 0.09, rough * 9.0)));
        vec3 albedo = mix(rock, vec3(0.028, 0.048, 0.034) * (0.7 + 0.6 * r0), trees);
        albedo = mix(albedo, vec3(0.8, 0.82, 0.86), snow);
        vec3 light = mix(uGround, uSky, n.y * 0.5 + 0.5) + uKey * max(dot(n, uKeyDir), 0.0) * 1.15;
        vec3 col = albedo * light * 0.3183;
        // air: a kilometre of it turns everything toward the colour of the sky behind it
        vec3 ray = vWorld - cameraPosition;
        float dist = length(ray);
        vec3 haze = airColor(normalize(vec3(ray.x, max(ray.y, 0.0) * 0.35 + dist * 0.02, ray.z))) * 0.6;
        col = mix(col, haze, 1.0 - exp(-dist * 0.00062));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = mat;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = -80;
  });
  return { group: model, uniforms };
}

/* -------------------------------------------------------------- terrain */

const tn = new Noise(77);

export const shoreZ = (x: number) => 1.2 + 0.02 * x * x;

/** Signed distance-ish to the shoreline: positive on land. */
export function landness(x: number, z: number) {
  const wob = (tn.fbm(x * 0.05 + 3.1, z * 0.05 + 7.7, 3) - 0.5) * 7 * smoothstep(10, 34, Math.abs(x));
  return shoreZ(x) + wob - z;
}

/** 1 along the open meadow that runs from the house toward the sunset, 0 in the forest. */
export function valley(x: number, z: number) {
  if (z > -8) return 0;
  const lateral = Math.abs(x - 0.16 * z) / 1.0127;
  return (1 - smoothstep(16, 58, lateral)) * smoothstep(-8, -30, z);
}

export function terrainHeight(x: number, z: number) {
  const s = landness(x, z);
  let h: number;
  if (s < 0) {
    h = Math.max(-6, s * 0.2) - 0.02;
  } else {
    const beach = Math.min(s, 5) * 0.17;
    const t = Math.max(0, s - 9) / 100;
    const hill = ((30 * t * t) / (t * t + 0.6)) * (1 - 0.86 * valley(x, z));
    const rough = (tn.fbm(x * 0.022 + 11, z * 0.022 + 5, 4) - 0.42) * 6 * smoothstep(8, 50, s);
    const detail = (tn.fbm(x * 0.16, z * 0.16, 3) - 0.5) * 0.8 * smoothstep(2, 12, s);
    h = Math.max(beach * 0.7, beach + hill + rough + detail);
  }
  const dx = Math.max(0, Math.abs(x) - 10.5);
  const dz = Math.max(0, Math.abs(z + 5) - 7.5);
  const k = (1 - smoothstep(0, 9, Math.hypot(dx, dz))) * smoothstep(-3, 1, s);
  return lerp(h, 0.95, k);
}

export function createTerrain(ground: Assets['tex']['forest_ground_04']) {
  const N = 120;
  const side = N * 2 + 1;
  const pos = new Float32Array(side * side * 3);
  const col = new Float32Array(side * side * 3);
  const uv = new Float32Array(side * side * 2);
  const idx: number[] = [];
  const warp = (t: number, range: number) => Math.sign(t) * Math.pow(Math.abs(t), 2.1) * range;
  const cn = new Noise(19);
  for (let j = 0; j < side; j++) {
    const tz = (j - N) / N;
    const z = -3 + warp(tz, tz < 0 ? 460 : 190);
    for (let i = 0; i < side; i++) {
      const x = warp((i - N) / N, 380);
      const n = j * side + i;
      const k = n * 3;
      const h = terrainHeight(x, z);
      pos[k] = x;
      pos[k + 1] = h;
      pos[k + 2] = z;
      uv[n * 2] = x / 4.5;
      uv[n * 2 + 1] = z / 4.5;
      const e = 0.6;
      const slope = Math.hypot(terrainHeight(x + e, z) - h, terrainHeight(x, z + e) - h) / e;
      const nz = cn.fbm(x * 0.11, z * 0.11, 3);
      // tint over the scan: mossy on the flats, bare on the steeps, pale and wet at the waterline
      let r = lerp(0.3, 0.46, nz);
      let g = lerp(0.38, 0.54, nz);
      let b = lerp(0.24, 0.32, nz);
      const rock = smoothstep(0.55, 1.0, slope + (nz - 0.5) * 0.3);
      r = lerp(r, 0.8, rock);
      g = lerp(g, 0.78, rock);
      b = lerp(b, 0.76, rock);
      const shore = 1 - smoothstep(0.15, 0.9, h);
      r = lerp(r, 0.5, shore);
      g = lerp(g, 0.47, shore);
      b = lerp(b, 0.43, shore);
      col[k] = r;
      col[k + 1] = g;
      col[k + 2] = b;
      if (i < side - 1 && j < side - 1) {
        const a = j * side + i;
        idx.push(a, a + side, a + 1, a + 1, a + side, a + side + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ map: ground.map, normalMap: ground.normalMap, vertexColors: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/* ---------------------------------------------------------------- trees */

/**
 * Geometry of a loaded mesh, ready to instance: positions widened from the 16-bit normalised form the files
 * ship in (which cannot hold world-space values) to floats, with the node's transform baked in.
 */
function unpack(mesh: THREE.Mesh) {
  const geo = mesh.geometry.clone();
  const src = geo.attributes.position;
  const wide = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) wide.set([src.getX(i), src.getY(i), src.getZ(i)], i * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(wide, 3));
  geo.applyMatrix4(mesh.matrixWorld);
  return geo;
}

/** Below 1 inside the clearing round the house, above 1 in the forest: an oval with a ragged edge. */
const edge = new Noise(91);
export function clearing(x: number, z: number) {
  return Math.hypot(x / 18.5, (z + 5.5) / 15.5) + (edge.fbm(x * 0.07 + 3.3, z * 0.07 + 9.1, 3) - 0.5) * 0.55;
}

export function createForest(assets: Assets, lowDetail: boolean) {
  const group = new THREE.Group();
  const r = rng(2024);
  const cn = new Noise(55);
  type T = { x: number; y: number; z: number; s: number; w: number; ry: number; near: boolean; far?: boolean };
  const trees: T[] = [];
  const hero: [number, number, number][] = [
    [-14.6, -3.5, 17],
    [-15.5, -8, 21],
    [-13.2, -13, 19],
    [-18, -1.5, 15],
    [-14, 2.6, 11],
    [-21, -6, 23],
    [15.6, -5.6, 19],
    [16.2, -12.5, 22],
    [13.9, -0.9, 13],
    [19.5, -2.5, 16],
    [14.5, 3.4, 12],
    [20, -8, 24],
    [-20, 4.5, 14],
    [20.5, 3.6, 15],
  ];
  for (const [x, z, s] of hero) {
    trees.push({ x, z, y: terrainHeight(x, z) - 0.3, s, w: 0.9 + r() * 0.3, ry: r() * 6, near: true });
  }
  const target = lowDetail ? 1500 : 3600;
  let tries = 0;
  while (trees.length < target && tries++ < 60000) {
    const x = (r() * 2 - 1) * 215;
    const z = -230 + r() * 345;
    const s = landness(x, z);
    if (s < 4.5) continue;
    // the clearing the house sits in: cut by hand long ago, so no straight edge is left on it
    if (clearing(x, z) < 1) continue;
    if (valley(x, z) > 0.55 + r() * 0.3) continue;
    const dens = smoothstep(4, 22, s) * (0.3 + 0.7 * smoothstep(0.3, 0.62, cn.fbm(x * 0.03, z * 0.03, 3)));
    if (r() > dens) continue;
    const y = terrainHeight(x, z);
    if (y < 0.5) continue;
    trees.push({
      x,
      z,
      y: y - 0.4,
      s: (11 + r() * 13) * (0.7 + 0.3 * smoothstep(5, 30, s)),
      w: 0.8 + r() * 0.45,
      ry: r() * 6,
      near: Math.hypot(x, z) < 70,
      far: Math.hypot(x, z - 20) > 100,
    });
  }

  /* -- the forest ------------------------------------------------------------
     The spruce are grown in Blender (scripts/trees.py). The few the camera passes close to are the real meshes:
     a trunk and some seven thousand twig cards. Every other tree is an impostor: one quad showing a photograph
     of that same mesh, picked by where the camera is — 8 directions × 3 heights — with normals to light it by. */
  const SHOT = 18; // metres: the height the trees were grown and photographed at
  const LIGHT = /* glsl */ `
    uniform vec3 uSky, uGround, uKey, uKeyDir, uFogColor;
    uniform float uFogDensity;
    vec3 forestLight(vec3 albedo, vec3 n, vec3 world){
      vec3 toCam = cameraPosition - world;
      float dist = length(toCam);
      float wrap = clamp(dot(n, uKeyDir) * 0.5 + 0.5, 0.0, 1.0);
      // needles glow a little when the sun is behind them
      float through = pow(clamp(dot(-toCam / dist, uKeyDir), 0.0, 1.0), 3.0);
      vec3 light = mix(uGround, uSky, n.y * 0.5 + 0.5) + uKey * (wrap * wrap + through * 0.4);
      vec3 col = albedo * light * 0.3183;
      return mix(col, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * dist * dist));
    }
  `;

  const close = trees.filter((t) => Math.hypot(t.x, t.z + 3) < 34);
  const far = trees.filter((t) => !close.includes(t));
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const m = new THREE.Matrix4();

  // the real thing, near the house
  const needleMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    uniforms: { uMap: { value: assets.trees.twigs }, ...forestLight },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vWorld;
      varying float vShade;
      ${SWAY}
      void main(){
        vUv = uv;
        mat4 mm = modelMatrix * instanceMatrix;
        vec4 wp = mm * vec4(position, 1.0);
        // the whole tree leans with the wind; and every twig shivers a little on its own, more the further out it is
        wp.xyz += sway(mm[3].xyz, clamp(position.y / ${SHOT.toFixed(1)}, 0.0, 1.1), ${SHOT.toFixed(1)} * length(mm[1].xyz));
        wp.xz += vec2(sin(uTime * 2.1 + position.y * 1.3 + mm[3].x), cos(uTime * 1.7 + position.x * 2.0 + mm[3].z)) * (0.012 * uWind * length(position.xz));
        vWorld = wp.xyz;
        // lean every normal out from the trunk and up: the crown shades as one soft volume, not as loose cards
        vN = normalize(mat3(mm) * vec3(position.x, 1.6, position.z));
        vShade = 0.5 + 0.5 * smoothstep(0.2, 2.6, length(position.xz));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vWorld;
      varying float vShade;
      ${LIGHT}
      void main(){
        vec4 t = texture2D(uMap, vUv);
        // thin needles lose coverage as the texture shrinks with distance: give some of it back
        float keep = t.a * (1.0 + 0.035 * distance(cameraPosition, vWorld));
        float a = clamp((keep - 0.4) / max(fwidth(keep), 0.0001) + 0.5, 0.0, 1.0);
        if (a < 0.02) discard;
        gl_FragColor = vec4(forestLight(t.rgb * vShade, normalize(vN), vWorld), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const needleDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: assets.trees.twigs, alphaTest: 0.4, side: THREE.DoubleSide });
  const barkMap = assets.tex.bark_brown_02.map.clone();
  barkMap.repeat.set(2, 10);
  const barkMat = new THREE.MeshLambertMaterial({ map: barkMap, color: 0x8a7868 });
  // the trunk bends with its crown
  barkMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = forestLight.uTime;
    shader.uniforms.uWind = forestLight.uWind;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${SWAY}`).replace(
      '#include <project_vertex>',
      /* glsl */ `
        mat4 mmS = modelMatrix * instanceMatrix;
        vec4 wpS = mmS * vec4(transformed, 1.0);
        wpS.xyz += sway(mmS[3].xyz, clamp(position.y / ${SHOT.toFixed(1)}, 0.0, 1.1), ${SHOT.toFixed(1)} * length(mmS[1].xyz));
        vec4 mvPosition = viewMatrix * wpS;
        gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  // Each tree is some seven thousand cards, so the ones behind the camera must not be drawn: they are batched by the
  // side of the house they stand on, and each batch is culled as a whole.
  const side = (t: T) => (Math.abs(t.x) > Math.abs(t.z + 3) ? (t.x > 0 ? 0 : 1) : t.z + 3 > 0 ? 2 : 3);
  for (const variant of [0, 1]) {
    const src = assets.models[variant ? 'spruce_1' : 'spruce_0'];
    src.updateMatrixWorld(true);
    const parts: { geo: THREE.BufferGeometry; needles: boolean }[] = [];
    src.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) parts.push({ geo: unpack(mesh), needles: /needles/i.test(mesh.name) });
    });
    for (const sector of [0, 1, 2, 3]) {
      const list = close.filter((t, i) => i % 2 === variant && side(t) === sector);
      if (!list.length) continue;
      for (const part of parts) {
        const inst = new THREE.InstancedMesh(part.geo, part.needles ? needleMat : barkMat, list.length);
        list.forEach((t, i) => {
          q.setFromAxisAngle(up, t.ry);
          const k = t.s / SHOT;
          m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(k * t.w, k, k * t.w));
          inst.setMatrixAt(i, m);
        });
        inst.castShadow = true;
        inst.receiveShadow = false;
        if (part.needles) inst.customDepthMaterial = needleDepth;
        inst.computeBoundingSphere();
        group.add(inst);
      }
    }
  }

  // impostors for everything else
  const impostorMat = new THREE.ShaderMaterial({
    alphaToCoverage: true,
    uniforms: { uColor: { value: assets.trees.color }, uNormal: { value: assets.trees.normal }, ...forestLight },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec4 iTree; // height, rotation, variant, tint
      varying vec2 vUvA;
      varying vec2 vUvB;
      varying float vBlend;
      varying vec3 vWorld;
      varying vec2 vTurn;
      varying float vTint;
      const float FRAME = 1.06; // a frame is this many tree-heights tall, and half as wide
      ${SWAY}
      void main(){
        float s = iTree.x;
        vec3 centre = iPos + vec3(0.0, 0.5 * s, 0.0);
        vec3 vd = normalize(cameraPosition - centre);
        float el = asin(clamp(vd.y, -1.0, 1.0));
        float row = el < 0.3 ? 0.0 : (el < 0.8 ? 1.0 : 2.0);
        float shot = row < 0.5 ? 0.0698 : (row < 1.5 ? 0.5236 : 1.0821); // the elevation that row was photographed from
        vec2 h = normalize(vd.xz + vec2(1e-5, 0.0));
        vec3 right = vec3(h.y, 0.0, -h.x);
        vec3 toward = vec3(h.x, 0.0, h.y) * cos(shot) + vec3(0.0, sin(shot), 0.0);
        vec3 upv = cross(toward, right);
        vWorld = centre + (right * position.x * 0.5 + upv * position.y) * FRAME * s;
        vWorld += sway(iPos, position.y + 0.5, s); // the photograph leans as the tree would

        // the two photographs either side of the direction we are looking from
        float f = (atan(vd.x, vd.z) - iTree.y) / 6.2831853 * 8.0;
        float a0 = floor(f);
        vBlend = f - a0;
        vec2 cell = vec2(1.0 / 8.0, 1.0 / 6.0);
        vec2 st = position.xy + 0.5;
        float line = iTree.z * 3.0 + row;
        vUvA = vec2((mod(a0, 8.0) + st.x) * cell.x, 1.0 - (line + 1.0 - st.y) * cell.y);
        vUvB = vec2((mod(a0 + 1.0, 8.0) + st.x) * cell.x, 1.0 - (line + 1.0 - st.y) * cell.y);
        vTurn = vec2(cos(iTree.y), sin(iTree.y));
        vTint = iTree.w;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uColor, uNormal;
      varying vec2 vUvA;
      varying vec2 vUvB;
      varying float vBlend;
      varying vec3 vWorld;
      varying vec2 vTurn;
      varying float vTint;
      ${LIGHT}
      void main(){
        vec4 t = mix(texture2D(uColor, vUvA), texture2D(uColor, vUvB), vBlend);
        float a = clamp((t.a - 0.42) / max(fwidth(t.a), 0.0001) + 0.5, 0.0, 1.0);
        if (a < 0.02) discard;
        // stored in Blender's axes (Z up); turn into ours, then by the tree's own rotation
        vec3 nb = mix(texture2D(uNormal, vUvA).rgb, texture2D(uNormal, vUvB).rgb, vBlend) * 2.0 - 1.0;
        vec3 n = vec3(nb.x, nb.z, -nb.y);
        n = normalize(vec3(n.x * vTurn.x + n.z * vTurn.y, n.y, -n.x * vTurn.y + n.z * vTurn.x));
        gl_FragColor = vec4(forestLight(t.rgb * vTint, n, vWorld), a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const quad = new THREE.PlaneGeometry(1, 1);
  const CELL = 90;
  const cells = new Map<string, T[]>();
  for (const t of far) {
    const key = `${Math.floor(t.x / CELL)}|${Math.floor(t.z / CELL)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(t);
  }
  for (const list of cells.values()) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    const pos = new Float32Array(list.length * 3);
    const data = new Float32Array(list.length * 4);
    const box = new THREE.Box3();
    list.forEach((t, i) => {
      pos.set([t.x, t.y, t.z], i * 3);
      data.set([t.s, t.ry, i % 2, 0.85 + r() * 0.35], i * 4);
      box.expandByPoint(new THREE.Vector3(t.x, t.y, t.z)).expandByPoint(new THREE.Vector3(t.x, t.y + t.s, t.z));
    });
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('iTree', new THREE.InstancedBufferAttribute(data, 4));
    geo.instanceCount = list.length;
    geo.boundingSphere = box.expandByScalar(12).getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geo, impostorMat);
    group.add(mesh);
  }

  /* -- scanned boulders along the waterline -------------------------------- */
  const scatter = (src: THREE.Object3D, count: number, place: (i: number) => THREE.Matrix4 | null, shadows: boolean) => {
    const meshes: THREE.Mesh[] = [];
    src.updateMatrixWorld(true);
    src.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
    const per = meshes.map(() => [] as THREE.Matrix4[]);
    for (let i = 0; i < count; i++) {
      const mm = place(i);
      if (mm) per[Math.floor(r() * meshes.length)].push(mm);
    }
    meshes.forEach((mesh, k) => {
      if (!per[k].length) return;
      // recentre each piece of the set on its own footprint
      const geo = unpack(mesh);
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
      const inst = new THREE.InstancedMesh(geo, mesh.material, per[k].length);
      per[k].forEach((mm, i) => inst.setMatrixAt(i, mm));
      inst.castShadow = shadows;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      inst.userData.noMirror = !shadows;
      group.add(inst);
    });
  };

  scatter(
    assets.models.rock_moss_set_01,
    lowDetail ? 30 : 64,
    () => {
      for (let guard = 0; guard < 40; guard++) {
        const x = (r() * 2 - 1) * 58;
        const z = shoreZ(x) + (r() - 0.5) * 5;
        if (Math.abs(landness(x, z)) > 2.4) continue;
        if (Math.abs(x) < 11 && z < 9) continue; // keep the terrace and pier clear
        const sc = 0.22 + Math.pow(r(), 2.2) * 0.75;
        q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.5, r() * 6, (r() - 0.5) * 0.5));
        return new THREE.Matrix4().compose(new THREE.Vector3(x, Math.max(terrainHeight(x, z), -0.15) - sc * 0.35, z), q, new THREE.Vector3(sc, sc, sc));
      }
      return null;
    },
    true,
  );

  /* -- grass: tufts all over the clearing, thickest along the tree line and the shore ----- */
  for (const id of ['grass_medium_01', 'grass_medium_02'] as const) {
    const model = assets.models[id];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // the blades are cut out of cards: test the cut-out rather than blend it, so they sort and shadow like solid things
      const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
      mat.transparent = false;
      mat.alphaTest = 0.4;
      mat.depthWrite = true;
      mat.side = THREE.DoubleSide;
      mesh.material = mat;
    });
    scatter(
      model,
      lowDetail ? 260 : 900,
      () => {
        for (let guard = 0; guard < 40; guard++) {
          const a = r() * TAU;
          const d = 7 + Math.pow(r(), 0.7) * 30;
          const x = Math.cos(a) * d * 1.15;
          const z = -5 + Math.sin(a) * d * 0.9;
          if (landness(x, z) < 0.6) continue;
          if (Math.abs(x) < 9.7 && z > -9.9 && z < 5.6) continue; // the house and its terrace
          // sparse out in the open, thick where the mower never goes
          const wild = smoothstep(0.55, 1.05, clearing(x, z)) + (1 - smoothstep(1, 6, landness(x, z)));
          if (r() > 0.25 + 0.75 * Math.min(1, wild)) continue;
          const sc = 1.3 + r() * 1.5;
          q.setFromAxisAngle(up, r() * 6);
          return new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(x, z) - 0.02, z), q, new THREE.Vector3(sc, sc * (0.8 + r() * 0.6), sc));
        }
        return null;
      },
      false,
    );
  }

  /* -- ferns in the shade at the edge of the clearing ---------------------- */
  scatter(
    assets.models.fern_02,
    lowDetail ? 60 : 170,
    () => {
      for (let guard = 0; guard < 40; guard++) {
        const a = r() * TAU;
        const d = 12 + r() * 16;
        const x = Math.cos(a) * d * 1.15;
        const z = -5 + Math.sin(a) * d * 0.9;
        if (landness(x, z) < 2.5) continue;
        if (Math.abs(x) < 10.2 && z > -11.5 && z < 6) continue;
        const sc = 0.9 + r() * 1.1;
        q.setFromAxisAngle(up, r() * 6);
        return new THREE.Matrix4().compose(new THREE.Vector3(x, terrainHeight(x, z) - 0.03, z), q, new THREE.Vector3(sc, sc, sc));
      }
      return null;
    },
    false,
  );
  return group;
}

/* ---------------------------------------------------------------- water */

/** The lake bed around the shore, as a map of water depth: what the water shader reads to thin out in the shallows. */
const SHORE = { x0: -380, x1: 380, z0: -463, z1: 187, size: 1024, deepest: 2.55 };
function shoreMap() {
  const { x0, x1, z0, z1, size, deepest } = SHORE;
  const data = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    const z = z0 + ((j + 0.5) / size) * (z1 - z0);
    for (let i = 0; i < size; i++) {
      const x = x0 + ((i + 0.5) / size) * (x1 - x0);
      // well out on the water there is nothing to measure: skip the noise
      const quick = shoreZ(x) - z;
      const depth = quick < -24 ? deepest : -terrainHeight(x, z);
      data[j * size + i] = Math.round((Math.min(Math.max(depth, 0), deepest) / deepest) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The lake. A planar mirror gives it the real scene to reflect; the surface that bends that reflection comes from
 * Blender's ocean simulation (two tiles of wave slopes, scripts/landscape.py), laid over itself at four scales and
 * headings so no tile ever lines up with its neighbour, and ruffled in drifting patches the way wind crosses a lake.
 * In the shallows the water thins out and the bed shows through.
 */
export function createWater(texW: number, texH: number, waves: [THREE.Texture, THREE.Texture], sun: Record<string, THREE.IUniform>) {
  const shader = {
    name: 'LakeShader',
    uniforms: {
      color: { value: null },
      tDiffuse: { value: null },
      textureMatrix: { value: null },
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(0x05080f) },
      uFogColor: { value: new THREE.Color() },
      uFogDensity: { value: 0.005 },
      uRipple: { value: 1 },
      tWaveA: { value: waves[0] },
      tWaveB: { value: waves[1] },
      tShore: { value: null },
      uShore: { value: new THREE.Vector4(SHORE.x0, SHORE.z0, 1 / (SHORE.x1 - SHORE.x0), 1 / (SHORE.z1 - SHORE.z0)) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSunDisc: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform mat4 textureMatrix;
      varying vec4 vUv4;
      varying vec3 vWorld;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vUv4 = textureMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse, tWaveA, tWaveB, tShore;
      uniform vec3 uDeep, uFogColor, uSunDir, uSunColor;
      uniform vec4 uShore;
      uniform float uTime, uFogDensity, uRipple, uSunDisc;
      varying vec4 vUv4;
      varying vec3 vWorld;
      ${GLSL_NOISE}
      ${GLSL_AIR}
      vec2 turn(vec2 p, float a){ float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
      // one train of waves: a tile of slopes (metres per metre), laid at its own size and heading, drifting
      vec2 train(sampler2D t, vec2 p, float size, float heading, vec2 drift){
        return turn(texture2D(t, turn(p, heading) / size + drift * uTime).xy - 0.5, -heading);
      }
      void main(){
        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec2 p = vWorld.xz;

        float depth = texture2D(tShore, (p - uShore.xy) * uShore.zw).r * 2.55;
        if (p.x < uShore.x || p.y < uShore.y || (p.x - uShore.x) * uShore.z > 1.0 || (p.y - uShore.y) * uShore.w > 1.0) depth = 2.55;

        // wind does not blow evenly: it ruffles the lake in patches that wander, and leaves slicks of calm between them
        float gust = smoothstep(0.34, 0.72, fbm(p * 0.011 + uTime * vec2(0.006, 0.004)));
        float fine = 1.0 / (1.0 + dist * 0.03); // the smallest ripples are only there to be seen close to
        vec2 g = train(tWaveA, p, 57.0, 0.35, vec2(0.008, 0.0045)) * 1.0
               + train(tWaveA, p, 23.0, -1.2, vec2(-0.012, 0.016)) * 0.45
               + train(tWaveB, p, 7.3, 2.3, vec2(0.04, -0.026)) * (0.06 + 0.3 * gust)
               + train(tWaveB, p, 2.7, -0.5, vec2(-0.055, 0.045)) * (0.02 + 0.2 * gust) * fine;
        // a sheltered lake: the shapes of open water at a fraction of the height, and stiller yet where it shoals
        g *= uRipple * 0.34 * (0.35 + 0.65 * smoothstep(0.0, 0.9, depth));
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
        // how much sky the surface returns depends on the angle it is seen at; the ripples only nudge that
        float facing = max(dot(normalize(mix(vec3(0.0, 1.0, 0.0), N, 0.35)), V), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - facing, 5.0);

        // the mirror, bent by the slope of the surface; rougher water blurs what it reflects
        float calm = 1.0 / (1.0 + dist * 0.012);
        vec4 uv = vUv4;
        uv.xy += vec2(g.x * 0.5, g.y * 1.9) * 0.07 * calm * uv.w;
        float blur = 0.7 + 14.0 * length(g) + 1.5 * gust;
        vec3 refl = texture2D(tDiffuse, uv.xy / uv.w, blur).rgb;
        refl = min(refl, vec3(5.0)); // a lamp's reflection may glow, but one hot pixel must not flash

        // the low sun strikes sparks off every facet turned its way
        vec3 Ns = normalize(vec3(-g.x * 2.2, 1.0, -g.y * 2.2));
        float glint = pow(max(dot(reflect(-V, Ns), uSunDir), 0.0), 260.0);
        refl += uSunColor * uSunDisc * glint * 0.05;

        // the body of the water: clear in the shallows, where the bed shows through, dark where it is deep
        float body = 1.0 - exp(-depth * 3.4);
        vec3 col = refl * fres + uDeep * (1.0 - fres) * body;
        float alpha = fres + (1.0 - fres) * body;
        // far water takes the colour of the sky above the shore it runs up to, as the mountains do
        float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
        vec3 haze = mix(uFogColor, airColor(normalize(vec3(-V.x, 0.03, -V.z))) * 0.62, smoothstep(150.0, 600.0, dist));
        col = mix(col, haze * alpha, f);
        gl_FragColor = vec4(col, alpha); // premultiplied
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  };
  const geo = new THREE.PlaneGeometry(7000, 7000);
  const water = new Reflector(geo, { textureWidth: texW, textureHeight: texH, multisample: 4, clipBias: 0.003, shader });
  water.rotation.x = -Math.PI / 2;
  // mips of the mirror: what the shader blurs with
  const mirror = water.getRenderTarget().texture;
  mirror.generateMipmaps = true;
  mirror.minFilter = THREE.LinearMipmapLinearFilter;
  const mat = water.material as THREE.ShaderMaterial;
  mat.transparent = true;
  mat.premultipliedAlpha = true;
  mat.uniforms.tShore.value = shoreMap();
  for (const k of ['uSunDir', 'uSunColor', 'uSunDisc']) mat.uniforms[k] = sun[k];
  Object.assign(mat.uniforms, air);
  water.renderOrder = 1;
  return { mesh: water, uniforms: mat.uniforms };
}
