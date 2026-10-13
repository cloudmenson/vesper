import * as THREE from 'three';
import { lerp, clamp, smoothstep } from '../core/math';
import { air, forestLight, sunLayer, DUSK_AZIMUTH, DAWN_AZIMUTH, type createSky } from './landscape';

/** One moment of the day. The film blends dusk → night → dawn. */
interface Pal {
  fogDensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemi: number;
  key: THREE.Color;
  keyI: number;
  water: THREE.Color;
  exposure: number;
  env: number;
}

const C = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const D = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

const DUSK: Pal = {
  fogDensity: 0.0048,
  hemiSky: C(0x6f86c8),
  hemiGround: C(0x1d1d28),
  hemi: 0.85,
  key: C(0x8aa7ea),
  keyI: 0.55,
  water: C(0x070b17),
  exposure: 1.0,
  env: 0.5,
};

const NIGHT: Pal = {
  fogDensity: 0.0044,
  hemiSky: C(0x2c3f78),
  hemiGround: C(0x06070c),
  hemi: 0.5,
  key: C(0x9db8ff),
  keyI: 0.5,
  water: C(0x020409),
  exposure: 1.12,
  env: 0.22,
};

const DAWN: Pal = {
  fogDensity: 0.0019,
  hemiSky: C(0xa9c0ee),
  hemiGround: C(0x5a4a44),
  hemi: 1.35,
  key: C(0xffb078),
  keyI: 3.4,
  water: C(0x15243d),
  exposure: 1.08,
  env: 1.0,
};

/**
 * Where the light that casts shadows comes from. Two fixed directions, never a sweep between them:
 * the shadow map is drawn once for each, so nothing crawls while the sky changes.
 */
const SKYLIGHT_DIR = D(0.36, 0.7, 0.62); // the bright part of the evening and night sky, over the lake
const SUNRISE_DIR = D(0.58, 0.16, 0.82); // over the lake's eastern shore, a little higher than the disc so shadows are not endless
/** tod at which the light changes hands; both are at zero there */
const HANDOVER = 1.55;

/** How hard the sky is pushed, by sun elevation (degrees): the eye opens up as the light goes. */
const GAIN: [number, number][] = [
  [-16, 5],
  [-8, 5],
  [-6, 4.6],
  [-4.5, 3.6],
  [-3, 2.4],
  [-1.5, 1.1],
  [0, 0.42],
  [1.5, 0.27],
  [3, 0.22],
  [5, 0.2],
];
function gainAt(el: number) {
  if (el <= GAIN[0][0]) return GAIN[0][1];
  for (let i = 0; i < GAIN.length - 1; i++) {
    const [e0, g0] = GAIN[i];
    const [e1, g1] = GAIN[i + 1];
    if (el <= e1) return Math.exp(lerp(Math.log(g0), Math.log(g1), (el - e0) / (e1 - e0)));
  }
  return GAIN[GAIN.length - 1][1];
}

export interface AtmosphereTargets {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  sky: ReturnType<typeof createSky>;
  stars: Record<string, THREE.IUniform>;
  water: Record<string, THREE.IUniform>;
}

export function createAtmosphere(t: AtmosphereTargets) {
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  const key = new THREE.DirectionalLight(0xffffff, 1);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0002;
  key.shadow.radius = 5;
  key.shadow.blurSamples = 10;
  key.shadow.autoUpdate = false; // drawn once per direction (see SKYLIGHT_DIR)
  key.shadow.needsUpdate = true;
  const sc = key.shadow.camera;
  sc.left = -30;
  sc.right = 30;
  sc.top = 30;
  sc.bottom = -30;
  sc.near = 1;
  sc.far = 260;
  key.target.position.set(0, 2, -3);
  const fog = new THREE.FogExp2(0x000000, 0.005);
  t.scene.fog = fog;
  t.scene.add(hemi, key, key.target);

  const cur = { ...DUSK } as Pal;
  for (const k of Object.keys(DUSK) as (keyof Pal)[]) {
    const v = DUSK[k];
    if (v instanceof THREE.Color) (cur[k] as THREE.Color) = v.clone();
  }
  const sunDir = new THREE.Vector3();
  const horizon = new THREE.Color();
  let sunrise: boolean | null = null;

  /** tod: 0 dusk · 1 night · 2 dawn */
  function apply(tod: number) {
    const a = tod < 1 ? DUSK : NIGHT;
    const b = tod < 1 ? NIGHT : DAWN;
    const f = clamp(tod < 1 ? tod : tod - 1);
    for (const k of Object.keys(a) as (keyof Pal)[]) {
      const va = a[k];
      const vb = b[k];
      if (va instanceof THREE.Color) (cur[k] as THREE.Color).lerpColors(va, vb as THREE.Color, f);
      else (cur[k] as number) = lerp(va as number, vb as number, f);
    }

    // the sun: 5° under the horizon as the film opens (the blue hour), 16° under by night, then up over the lake
    const elevation = tod < 1 ? lerp(-5.0, -16, f) : lerp(-16, 2.4, f);
    const azimuth = tod < 1 ? DUSK_AZIMUTH : DAWN_AZIMUTH;
    const el = (elevation * Math.PI) / 180;
    sunDir.copy(azimuth).multiplyScalar(Math.cos(el)).setY(Math.sin(el));
    air.uSunAzimuth.value.copy(azimuth);
    air.uSunLayer.value = sunLayer(elevation);
    air.uSkyGain.value = gainAt(elevation);
    air.uNightAir.value = 1 - smoothstep(-12, -5, elevation);
    const su = t.sky.uniforms;
    su.uMilky.value = 1.5 * (1 - smoothstep(-13, -6.5, elevation));
    su.uSunDir.value.copy(sunDir);
    su.uSunDisc.value = 34 * smoothstep(-0.7, 0.5, elevation);
    su.uSunColor.value.setRGB(1, lerp(0.5, 0.86, smoothstep(0, 5, elevation)), lerp(0.2, 0.62, smoothstep(0, 5, elevation)));
    t.stars.uIntensity.value = 1 - smoothstep(-10, -4.2, elevation);

    // far things fade into the sky that is actually behind them: its colour low on the horizon, side-on to the sun
    t.sky.sample(horizon, 0.72, 0.05).multiplyScalar(0.5);
    horizon.r += 0.0105 * air.uNightAir.value;
    horizon.g += 0.0135 * air.uNightAir.value;
    horizon.b += 0.023 * air.uNightAir.value;
    fog.color.copy(horizon);
    fog.density = cur.fogDensity;
    t.water.uFogColor.value.copy(horizon);
    t.water.uFogDensity.value = cur.fogDensity;
    t.water.uDeep.value.copy(cur.water);

    hemi.color.copy(cur.hemiSky);
    hemi.groundColor.copy(cur.hemiGround);
    hemi.intensity = cur.hemi;

    // the evening sky's light fades out, and only once it is gone does the sun's come in from the other side
    const morning = tod > HANDOVER;
    key.color.copy(cur.key);
    key.intensity = morning ? DAWN.keyI * smoothstep(1.8, 2.0, tod) : lerp(DUSK.keyI, NIGHT.keyI, clamp(tod)) * (1 - smoothstep(1.2, HANDOVER, tod));
    if (morning !== sunrise) {
      sunrise = morning;
      key.position.copy(key.target.position).addScaledVector(morning ? SUNRISE_DIR : SKYLIGHT_DIR, 130);
      key.shadow.needsUpdate = true;
    }

    // the forest shades itself from the same light, without paying for shadows
    forestLight.uSky.value.copy(cur.hemiSky).multiplyScalar(cur.hemi);
    forestLight.uGround.value.copy(cur.hemiGround).multiplyScalar(cur.hemi);
    forestLight.uKey.value.copy(key.color).multiplyScalar(key.intensity);
    forestLight.uKeyDir.value.copy(morning ? SUNRISE_DIR : SKYLIGHT_DIR);
    forestLight.uFogColor.value.copy(horizon);
    forestLight.uFogDensity.value = cur.fogDensity;

    t.renderer.toneMappingExposure = cur.exposure;
    t.scene.environmentIntensity = cur.env;
  }

  return { apply, key, hemi };
}

/** Image-based lighting from the blue-hour panorama, so materials reflect a real sky. */
export function createEnvironment(renderer: THREE.WebGLRenderer, hdr: THREE.DataTexture) {
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromEquirectangular(hdr).texture;
  pm.dispose();
  hdr.dispose();
  return tex;
}

/**
 * What window glass reflects: a plain dusk gradient with no sun in it.
 * A real panorama puts its bright spots into every pane, and they read as lamps that are not there.
 */
export function createGlassEnvironment(renderer: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  scene.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(40, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          varying vec3 vP;
          void main(){
            float h = normalize(vP).y;
            vec3 col = mix(vec3(0.17, 0.2, 0.3), vec3(0.05, 0.07, 0.14), smoothstep(-0.1, 0.8, h));
            gl_FragColor = vec4(mix(col, vec3(0.03, 0.035, 0.05), smoothstep(0.0, -0.4, h)), 1.0);
          }`,
      }),
    ),
  );
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(scene, 0.04).texture;
  pm.dispose();
  return tex;
}
