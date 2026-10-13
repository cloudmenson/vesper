import * as THREE from 'three';
import { clamp, damp, easeInOut, lerp, smoothstep } from '../core/math';
import { createMaterials, type Zone } from './materials';
import { loadAssets, type Assets } from './assets';
import { createSky, createStars, createClouds, createAurora, createChart, createMountains, createTerrain, createForest, createWater, forestLight, terrainHeight } from './landscape';
import { createHouse, roomOf, type House, type Room } from './house';
import { createAtmosphere, createEnvironment, createGlassEnvironment } from './atmosphere';
import { createParticles, createEmbers, createSmoke, createRain, createRipples, createRise, createBirds, createMeteor } from './particles';
import { F0, C0, F1, ROOF, SKYLIGHT } from './house';
import { CameraPath } from './camera';
import { createPost } from './post';
import { loadLightmap, looseMeshes, useBakedAmbient, useBakedVertices, withBakedLight, type Lightmap } from './lightmap';
import { loadCurtain, type Curtain } from './cloth';

export interface Quality {
  dpr: number;
  samples: number;
  lowDetail: boolean;
}

/** ?off=shadow,points,msaa,bloom,mirror,bake&dpr=1 — switches for profiling and comparing */
const OFF = new Set((new URLSearchParams(location.search).get('off') ?? '').split(','));
const DPR = new URLSearchParams(location.search).get('dpr');

export function pickQuality(): Quality {
  const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 820;
  // Shade a fixed budget of pixels, whatever the display: retina panels don't get to quadruple the cost.
  const budget = (px: number, cap: number) => Math.min(devicePixelRatio, cap, Math.sqrt(px / (innerWidth * innerHeight)));
  return mobile
    ? { dpr: budget(1.1e6, 1.25), samples: 2, lowDetail: true }
    : { dpr: DPR ? +DPR : budget(2.0e6, 1.5), samples: OFF.has('msaa') ? 0 : 4, lowDetail: false };
}

const tick = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const UP = new THREE.Vector3(0, 1, 0);
/** how much of the warm fill (light the bake's bounces leave out) the rooms get */
const FILL = 0.4;
/** how hard the baked lamps are driven: the bake is in candela, the picture wants a little more */
const LAMPS = 1.3;

export class Experience {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 6000);

  /** smoothed scroll progress the film is actually at */
  p = 0;
  /** 0 dusk · 1 night · 2 dawn */
  tod = 0;
  fade = 0;

  private path = new CameraPath();
  /** where the camera stands and what it looks at this frame, before the hand-held sway is added */
  readonly pos = new THREE.Vector3();
  readonly look = new THREE.Vector3();
  fov = 34;
  /** When set, the camera goes here instead of along the film's path (the visitor is walking the house: see src/tour.ts). */
  view: { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;
  private mouse = new THREE.Vector2();
  private mouseS = new THREE.Vector2();
  private dpr: number;
  private slow = 0;
  private reflect = true;
  private noMirror: THREE.Object3D[] = [];
  /** ?cam=x,y,z,tx,ty,tz — park the camera anywhere while tuning */
  debugCam: number[] | null = null;

  house!: House;
  post!: ReturnType<typeof createPost>;
  private atmo!: ReturnType<typeof createAtmosphere>;
  private sky!: ReturnType<typeof createSky>;
  private stars!: ReturnType<typeof createStars>;
  private clouds!: ReturnType<typeof createClouds>;
  /** how far the mouse turns the head: a little during the film, freely while standing in the house */
  private turn = 0.3;
  /** the head keeps still while the pointer closes on something fixed in the room that it is about to press */
  holdLook = false;
  water!: ReturnType<typeof createWater>;
  private fx!: ReturnType<typeof createParticles>;
  private embers!: ReturnType<typeof createEmbers>;
  private smoke!: ReturnType<typeof createSmoke>;
  private aurora!: ReturnType<typeof createAurora>;
  chart!: ReturnType<typeof createChart>;
  private rainFx!: ReturnType<typeof createRain>;
  private ripples!: ReturnType<typeof createRipples>;
  private fish!: ReturnType<typeof createRise>;
  private deer: THREE.Object3D | null = null;
  /** it is raining (the visitor's choice, under the skylight); `wet` is how far the weather has turned, 0–1 */
  rain = false;
  wet = 0;
  /** looking through the telescope: the house is put away and the camera is the tube */
  scope = false;
  /** a log has just gone on the fire: 1, burning down to 0 over a few seconds */
  stoked = 0;
  /** the record is on the player and turning */
  record = false;
  /** what the telescope's chart names, and where in the sky each is */
  names: { dir: THREE.Vector3; text: string; star: boolean }[] = [];
  /** called when a fish rises, with how far off it was */
  onRise: ((distance: number) => void) | null = null;
  private nextRise = 12;
  /** how hard the wind is blowing just now, 0–1: the trees lean by it and the sound of it rises with it */
  gust = 0.5;
  private birds!: ReturnType<typeof createBirds>;
  private meteor!: ReturnType<typeof createMeteor>;
  private mats!: ReturnType<typeof createMaterials>;
  private lightmap: Lightmap | null = null;
  private curtain: Curtain | null = null;
  /** the few things with no baked light of their own: the light measured on the floor around each, and the uniform their materials read */
  private probes: { lamps: THREE.Color; sky: THREE.Color; ambient: THREE.IUniform<THREE.Color> }[] = [];
  private skyLight = new THREE.Color();
  /** a breath of warm fill on lightmapped surfaces: the light a bake of six bounces still leaves out */
  private fill = { value: new THREE.Color() };
  /** every material that stands in a room, by room: each reflects a cube map shot from the middle of its own floor */
  private rooms: Record<Room, THREE.MeshStandardMaterial[]> = { ground: [], loft: [], out: [] };

  constructor(
    canvas: HTMLCanvasElement,
    private q: Quality,
    private adaptive = true,
  ) {
    this.dpr = q.dpr;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = !OFF.has('shadow');
    // VSM: the maps are static, so the blur is paid once and each lookup is a single fetch
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.camera.aspect = innerWidth / innerHeight;
    addEventListener('pointermove', (e) => this.holdLook || this.mouse.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1));
  }

  /** Builds the world in slices so the loader can keep breathing. */
  async build(report: (f: number, label: string) => void) {
    const { scene, renderer, q } = this;
    report(0.02, 'Unloading materials');
    await tick();
    const assets: Assets = await loadAssets((f) => report(0.02 + f * 0.5, 'Unloading materials'));
    this.mats = createMaterials(assets);

    report(0.55, 'Raising mountains');
    await tick();
    this.sky = createSky(assets.sky);
    this.stars = createStars(assets.sky.stars);
    const mountains = createMountains(assets.models.mountains);
    const terrain = createTerrain(assets.tex.forest_ground_04);
    terrain.name = 'terrain';
    this.clouds = createClouds(assets.sky.clouds);
    this.aurora = createAurora();
    this.chart = createChart(assets.sky.chart.lines);
    this.names = [
      ...assets.sky.chart.figures.map(([ra, dec, text]) => ({ dir: this.chart.dir(ra, dec), text, star: false })),
      ...assets.sky.chart.stars.filter((st) => st[2] <= 2.9).map(([ra, dec, , text]) => ({ dir: this.chart.dir(ra, dec), text, star: true })),
    ];
    scene.add(this.sky.mesh, this.stars.points, this.aurora.mesh, this.chart.mesh, this.clouds.mesh, mountains.group, terrain);

    report(0.62, 'Planting spruce');
    await tick();
    const forest = createForest(assets, q.lowDetail);
    forest.name = 'forest';
    scene.add(forest);

    report(0.7, 'Filling the lake');
    await tick();
    const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
    const k = q.lowDetail ? 0.4 : 0.5;
    this.water = createWater(Math.round(buf.x * k), Math.round(buf.y * k), assets.waves, this.sky.uniforms);
    // The mirror pass redraws the whole world; skip it whenever the lake is off screen.
    const mirror = this.water.mesh.onBeforeRender;
    const self = this;
    this.water.mesh.onBeforeRender = function (...args) {
      if (!self.reflect) return;
      // leave out what the reflection would never show
      const hidden = self.noMirror.filter((o) => o.visible);
      for (const o of hidden) o.visible = false;
      mirror.apply(this, args);
      for (const o of hidden) o.visible = true;
    };
    scene.add(this.water.mesh);

    report(0.78, 'Framing the house');
    await tick();
    this.house = createHouse(this.mats, assets);
    scene.add(this.house.group);
    // the sheer by the door: simulated in Blender, scrubbed by the scroll
    this.curtain = await loadCurtain();
    if (this.curtain) {
      this.curtain.mesh.position.set(3.97, F0 + 0.03, -0.3);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(1.36, 0.02, 0.04), this.mats.steel);
      rail.position.set(4.6, C0 - 0.085, -0.3);
      this.house.group.add(this.curtain.mesh, rail);
    }
    this.lightmap = OFF.has('bake') ? null : await loadLightmap(renderer);
    if (this.lightmap) this.useLightmap(this.lightmap);
    this.fx = createParticles();
    this.embers = createEmbers(-4.6, F0 + 0.35, 3.1);
    this.smoke = createSmoke(-4.6, F0 + 0.4, 3.1);
    this.birds = createBirds();
    this.meteor = createMeteor();
    this.rainFx = createRain();
    this.ripples = createRipples(SKYLIGHT.x1 - SKYLIGHT.x0, SKYLIGHT.z1 - SKYLIGHT.z0, (SKYLIGHT.x0 + SKYLIGHT.x1) / 2, ROOF + 0.12, (SKYLIGHT.z0 + SKYLIGHT.z1) / 2);
    this.fish = createRise();
    scene.add(this.fx.fireflies.points, this.embers.points, this.smoke.points, this.rainFx.lines, this.ripples.mesh, this.fish.mesh, this.birds.mesh, this.meteor.mesh);
    {
      // a stag comes down to the water on the west shore at first light (he is not there before)
      const stag = assets.models.deer.clone(true);
      stag.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(stag, true);
      const k = 1.95 / (box.max.y - box.min.y);
      const holder = new THREE.Group();
      stag.scale.multiplyScalar(k);
      stag.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k);
      holder.add(stag);
      holder.position.set(-19.5, Math.max(terrainHeight(-19.5, 6.6), 0.02), 6.6);
      holder.rotation.y = 0.5;
      holder.traverse((o) => (o.castShadow = true));
      holder.visible = false;
      scene.add(holder);
      this.deer = holder;
    }

    report(0.88, 'Switching on the lights');
    await tick();
    scene.environment = createEnvironment(renderer, assets.env);
    this.mats.glass.envMap = createGlassEnvironment(renderer);
    this.atmo = createAtmosphere({
      scene,
      renderer,
      sky: this.sky,
      stars: this.stars.uniforms,
      water: this.water.uniforms,
    });
    if (q.lowDetail) this.atmo.key.shadow.mapSize.set(1024, 1024);
    scene.traverse((o) => o.userData.noMirror && this.noMirror.push(o));
    this.post = createPost(renderer, scene, this.camera, { samples: q.samples });
    if (OFF.has('bloom')) this.post.bloom.enabled = false;
    this.resize();

    report(0.94, 'Waiting for the blue hour');
    await tick();
    this.captureRooms();
    renderer.compile(scene, this.camera); // every material, including what the first frame can't see
    this.frame(0, 0, 1 / 60); // warm-up: upload textures, render the static shadow maps
    await tick();
    report(1, 'Ready');
  }

  /** Hands the baked lighting to the house: the atlas to the building, per-vertex light to everything standing in it. */
  private useLightmap(lm: Lightmap) {
    const house = this.house;
    house.group.updateMatrixWorld(true);
    for (const mesh of house.lightmapped) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.lightMap = lm.texture;
      mat.lightMapIntensity = 1;
      useBakedAmbient(mat, this.fill);
      this.rooms[mesh.userData.zone as Room].push(mat);
    }

    const loose = looseMeshes(house);
    // a bake made for another version of the house would put the wrong light on the wrong vertex: better none
    const fits = lm.props !== null && lm.propCounts.length === loose.length && loose.every((m, i) => m.geometry.attributes.position.count === lm.propCounts[i]);
    if (!fits) console.warn('Baked vertex light does not match the house: run `npm run blender:light`.');
    const done = new Set<THREE.Object3D>(house.lightmapped);
    const box = new THREE.Box3();
    const centre = new THREE.Vector3();
    const copies = new Map<string, THREE.Material>();
    const dress = (mesh: THREE.Mesh, room: Room, key: string, patch: (m: THREE.Material) => void) => {
      const swap = (src: THREE.Material) => {
        if (!(src as THREE.MeshStandardMaterial).isMeshStandardMaterial || src === this.mats.glass) return src;
        // lamp globes were already given their own material (and something dims it every frame): patch those in place
        if (src.userData.own) {
          if (!src.userData.baked) {
            src.userData.baked = true;
            patch(src);
            this.rooms[room].push(src as THREE.MeshStandardMaterial);
          }
          return src;
        }
        let copy = copies.get(`${src.uuid}|${key}`);
        if (!copy) {
          copy = src.clone();
          copy.onBeforeCompile = src.onBeforeCompile;
          copy.customProgramCacheKey = src.customProgramCacheKey;
          patch(copy);
          this.rooms[room].push(copy as THREE.MeshStandardMaterial);
          copies.set(`${src.uuid}|${key}`, copy);
        }
        return copy;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      done.add(mesh);
    };

    if (fits) {
      // A picture's panel is four vertices, every one of them tucked under the rebate of its frame, where the bake
      // finds only shadow: left alone, the picture is black. It is lit as the face of the moulding round it is lit.
      {
        const data = lm.props!;
        const start = new Map<THREE.Mesh, number>();
        let at = 0;
        for (const mesh of loose) {
          start.set(mesh, at);
          at += mesh.geometry.attributes.position.count;
        }
        const facing = new THREE.Vector3();
        const n = new THREE.Vector3();
        for (const panel of loose) {
          if (!/_artwork$/.test((panel.material as THREE.Material).name)) continue;
          const frame = loose.filter((o) => o !== panel && o.parent === panel.parent).sort((p, q) => q.geometry.attributes.position.count - p.geometry.attributes.position.count)[0];
          if (!frame) continue;
          panel.updateWorldMatrix(true, false);
          frame.updateWorldMatrix(true, false);
          facing.fromBufferAttribute(panel.geometry.attributes.normal, 0).transformDirection(panel.matrixWorld);
          const from = start.get(frame)!;
          const normals = frame.geometry.attributes.normal;
          const sum = new Float64Array(8);
          let count = 0;
          for (let i = 0; i < normals.count; i++) {
            if (n.fromBufferAttribute(normals, i).transformDirection(frame.matrixWorld).dot(facing) < 0.6) continue;
            for (let k = 0; k < 8; k++) sum[k] += (data[(from + i) * 8 + k] / 255) ** 2; // (stored as square roots)
            count++;
          }
          if (!count) continue;
          const to = start.get(panel)!;
          for (let j = 0; j < panel.geometry.attributes.position.count; j++) for (let k = 0; k < 8; k++) data[(to + j) * 8 + k] = Math.round(Math.sqrt(sum[k] / count) * 255);
        }
      }
      // A curtain's folds are only a few vertices deep, and light baked into them one vertex at a time comes out as a
      // harlequin of lit and shaded diamonds — plainest at dawn, when the sky is the only light on them. Each vertex
      // is drawn toward the mean of its neighbours, a few times over: the cloth keeps its folds and loses the pattern.
      {
        const data = lm.props!;
        let at = 0;
        for (const cloth of loose) {
          const count = cloth.geometry.attributes.position.count;
          const from = at;
          at += count;
          if (cloth.name !== 'drape' || !cloth.geometry.index) continue;
          const pos = cloth.geometry.attributes.position;
          // vertices doubled along a seam count as one
          const where = new Map<string, number>();
          const same = new Int32Array(count);
          for (let i = 0; i < count; i++) {
            const key = `${Math.round(pos.getX(i) * 2e3)},${Math.round(pos.getY(i) * 2e3)},${Math.round(pos.getZ(i) * 2e3)}`;
            const first = where.get(key);
            if (first === undefined) where.set(key, (same[i] = i));
            else same[i] = first;
          }
          const near: Set<number>[] = Array.from({ length: count }, () => new Set<number>());
          const index = cloth.geometry.index;
          for (let t = 0; t < index.count; t += 3) {
            const tri = [same[index.getX(t)], same[index.getX(t + 1)], same[index.getX(t + 2)]];
            for (let k = 0; k < 3; k++) {
              near[tri[k]].add(tri[(k + 1) % 3]);
              near[tri[k]].add(tri[(k + 2) % 3]);
            }
          }
          let cur = new Float32Array(count * 8);
          let next = new Float32Array(count * 8);
          for (let i = 0; i < count * 8; i++) cur[i] = (data[from * 8 + i] / 255) ** 2;
          for (let pass = 0; pass < 12; pass++) {
            for (let i = 0; i < count; i++) {
              if (same[i] !== i || !near[i].size) continue;
              for (let k = 0; k < 8; k++) {
                let sum = 0;
                for (const j of near[i]) sum += cur[j * 8 + k];
                next[i * 8 + k] = 0.4 * cur[i * 8 + k] + (0.6 * sum) / near[i].size;
              }
            }
            [cur, next] = [next, cur];
          }
          for (let i = 0; i < count; i++) for (let k = 0; k < 8; k++) data[(from + i) * 8 + k] = Math.round(Math.sqrt(cur[same[i] * 8 + k]) * 255);
        }
      }
      let offset = 0;
      for (const mesh of loose) {
        const n = mesh.geometry.attributes.position.count;
        mesh.geometry = withBakedLight(mesh.geometry, lm.props!, offset, n);
        offset += n;
        const room = roomOf(box.setFromObject(mesh).getCenter(centre));
        dress(mesh, room, room, (m) => useBakedVertices(m, lm.vertexUniforms));
      }
    }

    // whatever is left (instanced pieces, the sliding door and skylight) takes the light of the floor it stands on
    const floors = house.lightmapped.filter((m) => (m.material as THREE.Material).userData.floor);
    let n = 0;
    for (const root of house.group.children) {
      let probe: (typeof this.probes)[number] | undefined;
      const key = `probe${n++}`;
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || done.has(mesh) || mesh.userData.emitter) return;
        if (!probe) {
          box.setFromObject(root).getCenter(centre);
          const room = roomOf(centre);
          centre.y = box.min.y;
          probe = { ...lm.probe(centre, floors), ambient: { value: new THREE.Color() } };
          this.probes.push(probe);
          root.userData.room = room;
        }
        dress(mesh, root.userData.room as Room, key, (m) => useBakedAmbient(m, probe!.ambient));
      });
    }
  }

  /**
   * Shoots a cube map from the middle of each floor, with the lamps on.
   * Polished stone, steel and brass then reflect the actual room — its pendants, its fire — rather than a sky they cannot see.
   * Each room's materials keep their own map for good: nothing changes as the camera climbs the stair.
   */
  private captureRooms() {
    if (!this.lightmap || OFF.has('probe')) return;
    const rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cube = new THREE.CubeCamera(0.1, 200, rt);
    const pm = new THREE.PMREMGenerator(this.renderer);
    const extras = [this.fx.fireflies.points, this.embers.points, this.smoke.points, this.rainFx.lines, this.ripples.mesh, this.fish.mesh, this.birds.mesh, this.meteor.mesh];
    const shots: [Room, number, number, number][] = [
      ['ground', 1.5, F0 + 1.5, -4.2],
      ['loft', 4.4, F1 + 1.45, -3.8],
    ];
    this.p = 0.6;
    this.frame(0.6, 0, 1 / 60); // night, every lamp on
    for (const o of extras) o.visible = false;
    this.reflect = false;
    for (const [room, x, y, z] of shots) {
      cube.position.set(x, y, z);
      cube.update(this.renderer, this.scene);
      const env = pm.fromCubemap(rt.texture).texture;
      for (const mat of this.rooms[room]) mat.envMap = env;
    }
    for (const o of extras) o.visible = true;
    pm.dispose();
    rt.dispose();
    this.p = 0;
  }

  /** on the narrow screens the subject needs more room */
  private lens(fov: number) {
    return fov * lerp(1, 1.55, clamp((1.25 - this.camera.aspect) / 0.7));
  }

  resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.camera.aspect = w / h;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(w, h, false);
    this.post.composer.setPixelRatio(this.dpr);
    this.post.composer.setSize(w, h);
    const px = this.renderer.getPixelRatio();
    this.stars.uniforms.uPx.value = px;
    this.fx.fireflies.uniforms.uPx.value = px * (h / 900);
    this.embers.uniforms.uPx.value = px * (h / 900) * 60;
    this.smoke.uniforms.uPx.value = px * (h / 900);
  }

  frame(target: number, time: number, dt: number) {
    this.p = Math.abs(target - this.p) < 1e-5 ? target : damp(this.p, target, 5, dt);
    const p = this.p;
    const { camera, house } = this;

    /* ------------------------------------------------------- time of day */
    this.tod = p < 0.62 ? smoothstep(0.3, 0.62, p) : 1 + smoothstep(0.868, 0.95, p);
    const dawn = smoothstep(1.15, 1.9, this.tod);
    this.atmo.apply(this.tod);

    /* ------------------------------------------------------------ camera */
    let fov = this.path.sample(p, this.pos, this.look);
    if (this.view) {
      this.pos.copy(this.view.pos);
      this.look.copy(this.view.look);
      fov = this.view.fov;
    }
    if (this.scope) {
      // The telescope: the eye goes to the end of the tube, outside the glass, and looks where the tube points —
      // up over the lake, where the Milky Way stands. The mouse sweeps it from there.
      this.pos.set(2.2, F1 + 1.6, 3.2);
      this.look.set(2.2 - 0.5, F1 + 1.6 + 5.6, 3.2 + 8.6); // on the Archer, with the galaxy's centre beside him
      fov = 38;
    }
    if (this.debugCam) {
      const d = this.debugCam;
      this.pos.set(d[0], d[1], d[2]);
      this.look.set(d[3], d[4], d[5]);
      fov = d[6] ?? fov;
    }
    // sofa, kitchen, stair and study all face away from the water
    this.fov = fov;
    this.reflect = !OFF.has('mirror') && (this.debugCam !== null || this.view !== null || p < 0.372 || p > 0.8);
    this.mouseS.x = damp(this.mouseS.x, this.mouse.x, 3.2, dt);
    this.mouseS.y = damp(this.mouseS.y, this.mouse.y, 3.2, dt);
    const dist = this.pos.distanceTo(this.look);
    const walking = this.view !== null;
    const sway = this.scope ? 0 : walking ? 0.16 : Math.min(dist * 0.02, 0.8);
    camera.position.copy(this.pos);
    camera.position.x += Math.sin(time * 0.21) * sway * 0.25;
    camera.position.y += Math.sin(time * 0.17 + 1.3) * sway * 0.15;
    camera.up.set(0, 1, 0);
    camera.lookAt(this.look);
    // parallax: slide sideways on the camera's own axes, keep looking at the subject
    camera.translateX(this.mouseS.x * sway);
    camera.translateY(-this.mouseS.y * sway * 0.6);
    camera.lookAt(this.look);
    // …and turns the head: a glance during the film, a proper look round once the visitor is standing in the house
    this.turn = damp(this.turn, walking ? 1 : 0.3, 2.5, dt);
    // (the telescope swings further than a head does)
    const reach = this.scope ? 1.9 : 1;
    camera.rotateOnWorldAxis(UP, -this.mouseS.x * 0.36 * this.turn * reach);
    camera.rotateX(-this.mouseS.y * 0.19 * this.turn * reach);
    camera.fov = this.lens(fov);
    // depth precision is spent between the near plane and twice that far: only keep it tight where things come close
    const cp = camera.position;
    const indoors = cp.x > -11 && cp.x < 11 && cp.z > -11 && cp.z < 8 && cp.y < 9.5;
    camera.near = indoors ? 0.1 : 0.6;
    camera.updateProjectionMatrix();

    /* ---------------------------------------------------- moving parts */
    house.door.position.x = -2.5 * easeInOut(smoothstep(0.222, 0.285, p));
    house.skylight.position.x = 2.75 * easeInOut(smoothstep(0.838, 0.88, p));
    // the draught reaches the curtain a beat after the glass starts to move, and dies with the dawn calm
    this.curtain?.update(smoothstep(0.236, 0.31, p), time);

    /* ------------------------------------------------------------ light */
    const off = 1 - dawn * 0.9;
    // a fire breathes: a slow swell, a quicker lick, a fast shiver
    const breath = 1 + 0.07 * Math.sin(time * 1.9) + 0.09 * Math.sin(time * 7.3) * Math.sin(time * 3.1 + 1.7) + 0.035 * Math.sin(time * 17.0 + 0.6);
    // By morning the fires have burnt out: the flames go as the sky begins to pale, and the bowl on the terrace is
    // left smoking.
    const burnt = smoothstep(0.9, 0.93, p);
    this.stoked = Math.max(0, this.stoked - dt / 7);
    const level: Record<Zone, number> = { ground: off, upper: off, ext: off, fire: (1 - dawn * 0.55) * (1 - burnt) * (1 + 0.5 * this.stoked), screen: 1 - dawn * 0.5 };
    // the sky's direct light only matters outside: indoors it would arrive through walls, since its shadows stop at the terrace
    const outdoors = 1 - smoothstep(0.325, 0.35, p) * (1 - smoothstep(0.878, 0.895, p));
    this.atmo.key.intensity *= outdoors;
    if (this.lightmap) {
      // one bake, three times of day: the lamp layer dims with the lamps, the fire layer breathes, the sky layer takes the sky's colour
      this.skyLight.copy(this.atmo.hemi.color).multiplyScalar(this.atmo.hemi.intensity);
      this.lightmap.update(off * LAMPS, level.fire * breath, this.skyLight);
      this.fill.value.setRGB(0.2, 0.165, 0.13).multiplyScalar(off * FILL);
      this.lightmap.vertexUniforms.uBakeFill.value.copy(this.fill.value);
      for (const pr of this.probes) {
        pr.ambient.value.copy(pr.lamps).multiplyScalar(Math.PI * off * LAMPS).add(this.fill.value);
        pr.ambient.value.r += pr.sky.r * this.skyLight.r;
        pr.ambient.value.g += pr.sky.g * this.skyLight.g;
        pr.ambient.value.b += pr.sky.b * this.skyLight.b;
      }
      // the rooms' reflections were shot with the lamps on: they fade with them
      const shine = lerp(0.3, 1, off);
      for (const mat of this.rooms.ground) mat.envMapIntensity = shine * ((mat.userData.shine as number) ?? 1);
      for (const mat of this.rooms.loft) mat.envMapIntensity = shine * ((mat.userData.shine as number) ?? 1);
    }
    // (the embers keep a last dull red under the ash)
    for (const g of this.mats.glows) g.set(g.zone === 'fire' ? Math.max(level.fire, 0.05 * burnt) : level[g.zone]);
    house.state.record = this.record;
    for (const move of house.tick) move(time, camera.position);
    for (const f of house.flames) {
      f.uniforms.uTime.value += dt;
      f.uniforms.uLevel.value = level.fire;
    }

    /* ------------------------------------------------------------ world */
    this.sky.mesh.position.copy(camera.position);
    this.stars.points.position.copy(camera.position);
    this.clouds.mesh.position.copy(camera.position);
    this.clouds.uniforms.uTime.value = time;
    this.stars.uniforms.uTime.value = time;
    this.water.uniforms.uTime.value = time;
    this.water.uniforms.uRipple.value = lerp(1, 0.5, dawn); // the wind drops at first light
    this.fx.fireflies.uniforms.uTime.value = time;
    this.fx.fireflies.uniforms.uLevel.value = 1 - dawn;
    this.embers.uniforms.uTime.value = time;
    this.embers.uniforms.uLevel.value = level.fire * (1 + 2.5 * this.stoked);
    this.smoke.uniforms.uTime.value = time;
    this.smoke.uniforms.uLevel.value = burnt;
    this.smoke.uniforms.uTint.value.copy(this.skyLight).multiplyScalar(0.5).addScalar(0.012);
    // the wind: the trees sway by this clock, and it drops at first light as the water's ripple does
    forestLight.uTime.value = time;
    forestLight.uWind.value = lerp(1, 0.45, dawn);
    this.gust = 0.5 + 0.5 * Math.sin(time * 0.23);
    // The weather. Rain closes the sky — the clouds join up, the stars and the lights behind them go — and falls
    // everywhere but under a roof; on the skylight it shows as rings.
    this.wet = damp(this.wet, this.rain ? 1 : 0, 0.9, dt);
    const night = clamp(1 - Math.abs(this.tod - 1) * 2.4);
    this.clouds.uniforms.uRain.value = this.wet;
    this.stars.uniforms.uIntensity.value *= 1 - this.wet * 0.97;
    this.sky.uniforms.uMilky.value *= 1 - this.wet;
    this.aurora.mesh.position.copy(camera.position);
    this.aurora.uniforms.uTime.value = time;
    this.aurora.uniforms.uLevel.value = night * (1 - this.wet) * (0.75 + 0.25 * Math.sin(time * 0.11));
    this.rainFx.uniforms.uTime.value = time;
    this.rainFx.uniforms.uLevel.value = this.wet;
    this.rainFx.uniforms.uTint.value.copy(this.skyLight).multiplyScalar(0.5).addScalar(0.035);
    this.ripples.uniforms.uTime.value = time;
    this.ripples.uniforms.uLevel.value = this.wet;
    this.water.uniforms.uRipple.value += this.wet * 0.9;
    // the telescope: the house is put out of the way, and the chart is laid over the stars
    house.group.visible = !this.scope;
    this.chart.mesh.visible = this.scope;
    this.chart.mesh.position.copy(camera.position);
    this.chart.uniforms.uLevel.value = 0.5 * (1 - this.wet); // (under cloud there is nothing to chart)
    // a fish rises now and then off the end of the pier, while there is night or dawn to hear it in
    this.fish.uniforms.uTime.value = time;
    if (time > this.nextRise) {
      if (this.nextRise > 0 && this.tod > 0.4 && this.wet < 0.3) {
        const x = 2.6 + (Math.random() * 2 - 1) * 9;
        const z = 13 + Math.random() * 12;
        this.fish.rise(x, z, time);
        this.onRise?.(Math.hypot(camera.position.x - x, camera.position.z - z));
      }
      this.nextRise = time + 16 + Math.random() * 26;
    }
    if (this.deer) this.deer.visible = dawn > 0.25;
    this.birds.update(time, dawn);
    this.meteor.update(time, clamp(1 - Math.abs(this.tod - 1) * 2.5), camera.position);

    const lens = this.post.lens;
    lens.uTime.value = time;
    lens.uFade.value = this.fade;
    this.post.bloom.strength = lerp(0.9, 0.55, dawn);
    this.post.composer.render(dt);

    if (this.adaptive) this.govern(dt);
  }

  /** If the machine can't hold the frame rate, trade resolution for it. */
  private govern(dt: number) {
    if (dt > 1 / 38) this.slow++;
    else this.slow = Math.max(0, this.slow - 2);
    if (this.slow > 70 && this.dpr > 0.8) {
      this.dpr = Math.max(0.8, this.dpr - 0.25);
      this.slow = 0;
      this.resize();
    }
  }
}
