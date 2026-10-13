import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import skyMeta from './sky.json';

// Everything here comes from Poly Haven (CC0) via scripts/fetch-assets.mjs.
const BASE = `${import.meta.env.BASE_URL}assets/`;

const TEXTURES = [
  'laminate_floor_02',
  'brown_planks_09',
  'concrete_wall_004',
  'painted_plaster_wall',
  'fine_grained_wood',
  'mocha_oak_veneer',
  'poly_wool_herringbone',
  'rough_linen',
  'waffle_pique_cotton',
  'knitted_fleece',
  'forest_ground_04',
  'coast_sand_rocks_02',
  'bark_brown_02',
  'burned_ground_01',
] as const;

const MODELS = [
  'mid_century_lounge_chair',
  'modern_arm_chair_01',
  'coffee_table_round_01',
  'dining_chair_02',
  'metal_stool_01',
  'potted_plant_01',
  'potted_plant_02',
  'potted_plant_04',
  'ceramic_vase_01',
  'ceramic_vase_02',
  'ceramic_vase_04',
  'modern_ceiling_lamp_01',
  'modern_wooden_cabinet',
  'desk_lamp_arm_01',
  'rock_moss_set_01',
  'fern_02',
  'wooden_bowl_01',
  'standing_picture_frame_01',
  'standing_picture_frame_02',
  'hanging_picture_frame_01',
  'wine_bottles_01',
  'wooden_cutting_board',
  'wicker_basket_01',
  'wall_clock',
  'Camera_01',
  'marble_bust_01',
  'chess_set',
  'binder_notebook',
  'bronze_whale_statue',
  'alarm_clock_01',
  'rubber_boots',
  'wooden_lantern_01',
  'tea_set_01',
  'steel_frame_shelves_01',
  // Khronos glTF Sample Assets and Sketchfab (CC BY 4.0): see the README for who made each
  'lamp_drum',
  'pc_tower',
  'pc_mouse',
  'pc_keyboard',
  'nightstand',
  'side_table_slice',
  'side_table_glass',
  'fire_bowl',
  'fire_logs',
  'rugs',
  'lounge_set',
  'floor_lamp',
  'telescope',
  'ficus',
  'turntable',
  'cat_basket',
  'deer',
  // Poly Haven's book set, re-packed by scripts/books.mjs
  'books',
  'croissant',
  'round_spectacles',
  'binoculars',
  'Ukulele_01',
  'lambis_shell',
  'hanging_picture_frame_02',
  'food_apple_01',
  'food_pears_asian_01',
  'dry_branches_medium_01',
  'wooden_axe',
  'grass_medium_01',
  'grass_medium_02',
  // simulated in Blender by scripts/cloth.py
  'bed_duvet',
  'bed_throw',
  'bed_pillows',
  'sofa',
  'drape',
  // grown in Blender by scripts/trees.py
  'spruce_0',
  'spruce_1',
  // raised in Blender by scripts/landscape.py
  'mountains',
] as const;

const BOARD = ['wave', 'medusae', 'carta', 'heavens', 'loon', 'rotonda', 'rain'] as const;
/** paintings in the public domain, for the picture frames round the house */
const FRAMES = ['wanderer', 'stetind', 'sierra', 'pines', 'interior', 'sunrise', 'winter'] as const;

export type TexId = (typeof TEXTURES)[number];
export type ModelId = (typeof MODELS)[number];

/** Albedo, normal, and a packed AO / roughness / metalness map. */
export interface PBR {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  arm: THREE.Texture;
}

export interface Assets {
  tex: Record<TexId, PBR>;
  models: Record<ModelId, THREE.Group>;
  /** the sky, built by scripts/sky.mjs: the air at each sun elevation, the Milky Way's glow, and the star catalogue */
  sky: {
    twilight: THREE.Data3DTexture;
    /** the same data on the CPU side, RGB floats, for matching fog and haze to the sky */
    air: Float32Array;
    milkyway: THREE.Texture;
    /** the figures of the constellations and the names of the bright stars (right ascension and declination, radians) */
    chart: { lines: number[][]; figures: [number, number, string][]; stars: [number, number, number, string][] };
    /** clouds cut out of a photograph of a real sky: how much cloud in each direction (top half), how it was lit (bottom) */
    clouds: THREE.Texture;
    /** per star: right ascension and declination (radians), magnitude, B−V colour index */
    stars: Float32Array;
  };
  env: THREE.DataTexture;
  /** the forest: photographed fir twigs for the trees nearby, and atlases of whole trees seen from all round for the rest */
  trees: { twigs: THREE.Texture; color: THREE.Texture; normal: THREE.Texture };
  /** 64 frames of a real flame, filmed and cut out of its background, as an 8 × 8 sheet */
  flame: THREE.Texture;
  /** the framed picture over the sideboard (the owner's own file) */
  painting: THREE.Texture;
  /** what is pinned over the desk: prints, maps and charts in the public domain */
  board: Record<(typeof BOARD)[number], THREE.Texture>;
  frames: Record<(typeof FRAMES)[number], THREE.Texture>;
  /** what plays on the monitor: a loop of NASA's "Perpetual Ocean" */
  screen: { video: HTMLVideoElement; texture: THREE.VideoTexture };
  /** wave slopes from Blender's ocean simulation: a broad swell and a fine chop, both tileable */
  waves: [THREE.Texture, THREE.Texture];
  /** A fresh copy of a model, set up to cast and receive shadows. */
  spawn: (id: ModelId, x?: number, y?: number, z?: number, ry?: number, scale?: number) => THREE.Group;
}

export async function loadAssets(onProgress: (f: number) => void): Promise<Assets> {
  const texLoader = new THREE.TextureLoader();
  const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const total = TEXTURES.length * 3 + MODELS.length + 13 + BOARD.length + FRAMES.length;
  const binary = (url: string) => fetch(`${BASE}${url}`).then((r) => r.arrayBuffer());
  let done = 0;
  const step = <T>(p: Promise<T>) =>
    p.then((v) => {
      onProgress(++done / total);
      return v;
    });

  const tiled = async (file: string, srgb: boolean) => {
    const t = await step(texLoader.loadAsync(`${BASE}tex/${file}.webp`));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    return t;
  };
  const milkyway = async () => {
    const t = await step(texLoader.loadAsync(`${BASE}sky/milkyway.webp`));
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false; // mip selection breaks at the ±180° seam, and the map is only ever magnified
    t.minFilter = THREE.LinearFilter;
    return t;
  };
  const twilight = async () => {
    const half = new Uint16Array(await step(binary('sky/twilight.bin')));
    const [w, h, n] = skyMeta.size;
    const t = new THREE.Data3DTexture(half, w, h, n);
    t.format = THREE.RGBAFormat;
    t.type = THREE.HalfFloatType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    const air = new Float32Array(w * h * n * 3);
    for (let i = 0; i < w * h * n; i++) for (let k = 0; k < 3; k++) air[i * 3 + k] = THREE.DataUtils.fromHalfFloat(half[i * 4 + k]);
    return { texture: t, air };
  };
  const catalogue = async () => {
    const raw = new DataView(await step(binary('sky/stars.bin')));
    const n = raw.byteLength / 6;
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      out[i * 4] = (raw.getUint16(i * 6, true) / 65535) * Math.PI * 2;
      out[i * 4 + 1] = (raw.getUint16(i * 6 + 2, true) / 65535 - 0.5) * Math.PI;
      out[i * 4 + 2] = (raw.getUint8(i * 6 + 4) / 255) * 12 - 2;
      out[i * 4 + 3] = (raw.getUint8(i * 6 + 5) / 255) * 2.4 - 0.4;
    }
    return out;
  };

  const flatTex = async (url: string, srgb: boolean) => {
    const t = await step(texLoader.loadAsync(`${BASE}${url}`));
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const chart = (await step(fetch(`${BASE}sky/chart.json`).then((r) => r.json()))) as Assets['sky']['chart'];
  const [texList, modelList, air, galaxy, stars, env, twigs, treeColor, treeNormal, flame, painting, waveA, waveB, clouds, ...prints] = await Promise.all([
    Promise.all(
      TEXTURES.map(async (id) => {
        const [map, normalMap, arm] = await Promise.all([tiled(`${id}_diff`, true), tiled(`${id}_nor`, false), tiled(`${id}_arm`, false)]);
        return [id, { map, normalMap, arm }] as const;
      }),
    ),
    Promise.all(
      MODELS.map(async (id) => {
        const g = await step(gltf.loadAsync(`${BASE}models/${id}.glb`));
        // some files bring their own lamps along: nothing here is lit live
        const lights: THREE.Object3D[] = [];
        g.scene.traverse((o) => (o as THREE.Light).isLight && lights.push(o));
        for (const l of lights) l.removeFromParent();
        g.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const mat = m as THREE.MeshStandardMaterial;
            if (mat.map) mat.map.anisotropy = 4;
            const phys = m as THREE.MeshPhysicalMaterial;
            if (phys.transmission > 0) {
              // real refraction makes three.js render the whole scene a second time; plain alpha is plenty here
              phys.transmission = 0;
              phys.transparent = true;
              phys.opacity = 0.32;
              phys.roughness = 0.05;
            }
            if (mat.alphaTest > 0) {
              // foliage cards
              mat.alphaTest = 0.45;
              mat.side = THREE.DoubleSide;
            } else if (mat.transparent) {
              // picture glass, clock faces: there, but barely
              if (/glass/i.test(mat.name)) mat.opacity = Math.min(mat.opacity, 0.08);
              mat.depthWrite = false;
              mesh.castShadow = false;
            }
          }
        });
        return [id, g.scene] as const;
      }),
    ),
    twilight(),
    milkyway(),
    catalogue(),
    step(new HDRLoader().loadAsync(`${BASE}sky/env.hdr`)),
    flatTex('tex/fir_twig.webp', true),
    flatTex('trees/color.webp', true),
    flatTex('trees/normal.webp', false),
    flatTex('tex/flame.webp', true),
    flatTex('tex/painting.webp', true),
    tiled('wave_a', false),
    tiled('wave_b', false),
    step(texLoader.loadAsync(`${BASE}sky/clouds.webp`)),
    ...BOARD.map((name) => flatTex(`tex/board_${name}.webp`, true)),
    ...FRAMES.map((name) => flatTex(`tex/frame_${name}.webp`, true)),
  ]);

  // the monitor's film: silent, looping, and only running while someone is in the loft to see it
  const video = document.createElement('video');
  video.src = `${BASE}video/screen.mp4`;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const film = new THREE.VideoTexture(video);
  film.colorSpace = THREE.SRGBColorSpace;
  env.mapping = THREE.EquirectangularReflectionMapping;
  clouds.colorSpace = THREE.NoColorSpace;
  clouds.wrapS = THREE.RepeatWrapping; // round the compass
  clouds.wrapT = THREE.ClampToEdgeWrapping;
  // always seen larger than it is stored, and a mip chain would draw a seam where the compass wraps
  clouds.generateMipmaps = false;
  clouds.minFilter = THREE.LinearFilter;

  // the spruce meshes carry glTF UVs, which count V from the top of the image
  const glTFOrder = (t: THREE.Texture) => {
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  const models = Object.fromEntries(modelList) as Record<ModelId, THREE.Group>;
  return {
    tex: Object.fromEntries(texList) as Record<TexId, PBR>,
    models,
    sky: { twilight: air.texture, air: air.air, milkyway: galaxy, stars, clouds, chart },
    env,
    trees: { twigs: glTFOrder(twigs), color: treeColor, normal: treeNormal },
    flame,
    painting,
    board: Object.fromEntries(BOARD.map((name, i) => [name, prints[i]])) as Assets['board'],
    frames: Object.fromEntries(FRAMES.map((name, i) => [name, prints[BOARD.length + i]])) as Assets['frames'],
    screen: { video, texture: film },
    waves: [waveA, waveB],
    spawn(id, x = 0, y = 0, z = 0, ry = 0, scale = 1) {
      const g = models[id].clone(true);
      g.position.set(x, y, z);
      g.rotation.y = ry;
      g.scale.setScalar(scale);
      return g;
    },
  };
}
