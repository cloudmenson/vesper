// Downloads the free assets this project uses and compresses them for the web.
//   node scripts/fetch-assets.mjs            (skips anything already in public/assets)
// Poly Haven (CC0): textures → 1k WebP, models → meshopt GLB with WebP textures, one 1k HDR for reflections.
// Freesound (CC0) and Musopen (public domain): ambience and music → MP3. Wikimedia Commons (CC0): the flame.
// (The framed picture over the sideboard, tex/painting.webp, is the owner's own file and is not fetched.)
// Needs ffmpeg on the PATH. What Blender makes (baked light, cloth, trees, mountains, waves) has its own scripts.
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = 'public/assets';
const API = 'https://api.polyhaven.com';
const UA = { 'User-Agent': 'vesper-portfolio (asset fetch script)' };

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
];

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
  // the small things that make a house look lived in
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
  // what grows where the clearing meets the forest
  'grass_medium_01',
  'grass_medium_02',
];

// sets of separate objects we place one by one: keep their meshes apart
const SETS = new Set(['rock_moss_set_01', 'fern_02', 'wine_bottles_01', 'dry_branches_medium_01', 'tea_set_01', 'grass_medium_01', 'grass_medium_02', 'food_pears_asian_01']);

// scans that carry far more triangles than a web scene needs: fraction of vertices to keep
const SIMPLIFY = { rock_moss_set_01: 0.22, potted_plant_01: 0.4, potted_plant_02: 0.35, dining_chair_02: 0.5, desk_lamp_arm_01: 0.5, wooden_bowl_01: 0.4, ceramic_vase_01: 0.5, ceramic_vase_02: 0.5, ceramic_vase_04: 0.5, metal_stool_01: 0.6, wine_bottles_01: 0.4, croissant: 0.3, binoculars: 0.4, Ukulele_01: 0.5, lambis_shell: 0.3, round_spectacles: 0.6, wicker_basket_01: 0.4, Camera_01: 0.4, marble_bust_01: 0.6, chess_set: 0.3, binder_notebook: 0.5, rubber_boots: 0.3, alarm_clock_01: 0.5, tea_set_01: 0.4, food_apple_01: 0.3, food_pears_asian_01: 0.3, grass_medium_01: 0.35, grass_medium_02: 0.35, dry_branches_medium_01: 0.5, wooden_axe: 0.5 };

// Table lamps: Khronos glTF Sample Assets (CC BY 4.0 — credited in the README and on the page).
//   IridescenceLamp © 2022 Wayfair, LLC · LightsPunctualLamp © 2021 DGG
const LAMPS = [['lamp_drum', 'IridescenceLamp']];

// Models published on Sketchfab under CC BY 4.0, fetched from the Objaverse mirror (allenai/objaverse on Hugging Face).
// Each is credited in the README and on the page: [file, shard, id, title, author, share of triangles to keep]
const SKETCHFAB = [
  ['pc_tower', '030', 'ddbcc3b1ae2147e6af21fb9695cfad8d', 'Nzxt PC', 'umkhero', 0.3],
  ['pc_mouse', '018', '836aa5c61155474fba05ec15a8a29410', 'Computer Mouse', 'PoneMyintMyat', 0.4],
  ['pc_keyboard', '008', 'c775d45baf854606931584404d7b9109', 'Logitech mechanical gaming keyboard', 'blackcube4', 0.7],
  ['nightstand', '014', '415990b9b8d7434099682efbc9993132', 'nightstand', 'fenik0', 1],
  ['fire_bowl', '024', '817b9a33d48a46098f25b761dd36ac9f', 'Brazier Bowl', 'JDegville', 1],
  ['fire_logs', '021', 'efd0ac8c5cca46bfaae91b3851b9c75f', 'Campfire Wood Survival Warm and Light', 'digrafstudio', 0.5],
  ['side_table_slice', '018', '712420fc062649b6a70e4b38b2229791', 'Tucson Side Table A', 'cc0archviz', 0.15],
  ['side_table_glass', '003', 'b26840b3f01346ddad353b8d262a9f21', 'Side Table', 'trijoko.maryadi', 0.6],
  ['rugs', '035', '8001f9f214f94388840f0ce40cd13937', 'Carpet', 'nocyde', 1, 'apart'], // four of them: each stays its own mesh
  ['lounge_set', '001', 'fb87700602564fa6b72ed09aaa5e2949', 'The Sofa, The Chair and the Table', 'isaackgamma', 1, 'apart'],
  ['floor_lamp', '009', '4adc793119754406aa3bcd790782cd4c', 'Wooden floor lamp', 'DuduPav', 0.25],
  ['telescope', '000', '7220b6283360440fbbf8ccff08e25a7f', 'Telescope', 'topfrank2013', 0.6],
  ['ficus', '018', 'e4999d6251ba42ac8ee2cea7d3e30596', 'Ficus', 'gilles.schaeck', 1],
  ['turntable', '038', '3577a2a1a0c24218bd5d768beccf218e', 'Yamaha TT-300 Record Player', 'AleixoAlonso', 0.6, 'apart'], // its platter turns and its arm swings: they stay their own meshes
  ['cat_basket', '006', 'f1966bbc48034d33956e1115e87465a9', 'Sleeping cat', 'Smart3DScan', 1],
  ['deer', '000', '01f33919650c421e91666908db8c421e', 'Deer', 'aeonfitzgerald', 1],
];

// What is pinned over the desk: prints, maps and charts in the public domain, from Wikimedia Commons. [file, title, width in px]
const BOARD = [
  ['wave', 'File:Tsunami by hokusai 19th century.jpg', 900],           // Hokusai, The Great Wave off Kanagawa, c. 1831
  ['medusae', 'File:Haeckel Discomedusae 8.jpg', 640],                 // Ernst Haeckel, Kunstformen der Natur, 1904
  ['carta', 'File:Carta Marina.jpeg', 1000],                           // Olaus Magnus, Carta marina, 1539
  ['heavens', 'File:Planisphæri cœleste.jpg', 1000],                   // Frederik de Wit, Planisphærium cœleste, 1670
  ['loon', 'File:306 Great Northern Diver or Loon.jpg', 900],          // J. J. Audubon, The Birds of America, pl. 306
  ['rotonda', "File:Villa Almerico (Villa Rotunda), from I quattro libri dell'architettura di Andrea Palladio (Book 2, page 19) MET DP109542.jpg", 640], // Palladio, 1570
  ['rain', 'File:Hiroshige, Sudden shower over Shin-Ōhashi bridge and Atake, 1857.jpg', 640], // Hiroshige, 1857
];

// What hangs in the frames: paintings in the public domain, from Wikimedia Commons, each cut to its frame.
// [file, title, width, height in px]
const FRAMES = [
  ['wanderer', 'File:Caspar David Friedrich - Wanderer above the sea of fog.jpg', 808, 1200],                            // 1818
  ['stetind', 'File:Peder Balke - Stetind in Fog - Google Art Project.jpg', 808, 1200],                                   // 1864
  ['sierra', 'File:Albert Bierstadt - Among the Sierra Nevada, California - Google Art Project.jpg', 1400, 820],          // 1868
  ['pines', 'File:Shishkin, Ivan - Morning in a Pine Forest.jpg', 1400, 820],                                             // 1889
  ['interior', 'File:Vilhelm Hammershøi, Interiør fra Strandgade 30, 1900.jpg', 420, 600],                                // 1900
  ['sunrise', 'File:Monet - Impression, Sunrise.jpg', 420, 600],                                                          // 1872
  ['winter', 'File:Harald Sohlberg - Winter Night in the Mountains - Google Art Project.jpg', 435, 600],                  // 1914
];

// What plays on the monitor: NASA/Goddard's "Perpetual Ocean" (public domain), a few seconds of it, looped.
const SCREEN = 'File:NASA - Perpetual Ocean CCmTY0PKGDs.webm';

// What polished things outdoors reflect: a blue-hour radiance map. (The sky itself is built by scripts/sky.mjs.)
const ENV = 'qwantani_dusk_2_puresky';

// [name, source, start (s), length (s), loudness (LUFS), bitrate, filters to run first]
const AUDIO = [
  ['fire', 'https://cdn.freesound.org/previews/679/679405_14806311-hq.mp3', 1, 55, -21, '128k'],
  // small waves lapping at a beach, the gentlest of nine recordings measured: its loudest splash stands 9 dB
  // over its murmur (the one used before stood 22 dB over, and sounded like surf). Evened out further here.
  ['lake', 'https://cdn.freesound.org/previews/637/637945_612689-hq.mp3', 0, 72, -27, '128k', 'highpass=f=160,acompressor=threshold=-36dB:ratio=3:attack=60:release=700'],
  // rain on a roof; two kinds of footfall, on a wooden floor and on a wooden stair; a fish rising; a needle set down
  ['rain', 'https://cdn.freesound.org/previews/669/669484_13504080-hq.mp3', 2, 56, -24, '112k'],
  ['steps', 'https://cdn.freesound.org/previews/565/565712_1971023-hq.mp3', 2, 40, -27, '96k'],
  ['stairs', 'https://cdn.freesound.org/previews/575/575896_3283195-hq.mp3', 1, 30, -27, '96k'],
  ['splash', 'https://cdn.freesound.org/previews/507/507092_8682843-hq.mp3', 0, 2.4, -24, '96k'],
  ['needle', 'https://cdn.freesound.org/previews/556/556722_9159316-hq.mp3', 0, 6.5, -25, '96k'],
  // the record on the player: Satie's first Gnossienne (La Pianista, public domain)
  ['music2', 'https://upload.wikimedia.org/wikipedia/commons/9/91/Satie_-_Gnossienne_1.ogg', 0, 400, -19, '160k'],
  ['night', 'https://cdn.freesound.org/previews/580/580353_989468-hq.mp3', 5, 70, -24, '128k'],
  ['dawn', 'https://cdn.freesound.org/previews/427/427769_1050391-hq.mp3', 10, 70, -23, '128k'],
  // wind through pines (the steadiest 70 s of it): what the spruce round the house are seen doing
  ['wind', 'https://cdn.freesound.org/previews/184/184277_1050391-hq.mp3', 16, 70, -26, '112k', 'highpass=f=110'],
  // Erik Satie, Gymnopédie No. 1 — Robin Alciatore, piano (Musopen, public domain)
  ['music', 'https://upload.wikimedia.org/wikipedia/commons/9/90/Erik_Satie_-_gymnopedies_-_la_1_ere._lent_et_douloureux.ogg', 0, 400, -19, '160k'],
];

const json = async (url) => (await fetch(url, { headers: UA })).json();
const bytes = async (url) => {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
};
const kb = (f) => `${Math.round(statSync(f).size / 1024)} KB`;
const save = (file, buf) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
};

async function texture(id) {
  const files = await json(`${API}/files/${id}`);
  const maps = { diff: 'Diffuse', nor: 'nor_gl', arm: 'arm' };
  for (const [short, key] of Object.entries(maps)) {
    const out = `${OUT}/tex/${id}_${short}.webp`;
    if (existsSync(out)) continue;
    const src = files[key]?.['1k']?.jpg?.url;
    if (!src) {
      console.log(`  (no ${key} for ${id})`);
      continue;
    }
    const buf = await sharp(await bytes(src)).webp({ quality: short === 'nor' ? 88 : 80 }).toBuffer();
    save(out, buf);
    console.log(`  tex/${id}_${short}.webp  ${kb(out)}`);
  }
}

/** Photographed fir twigs (colour + alpha) from Poly Haven's fir tree: the brush our spruce boughs are painted with. */
async function twigs() {
  const out = `${OUT}/tex/fir_twig.webp`;
  if (existsSync(out)) return;
  const files = await json(`${API}/files/fir_tree_01`);
  const alpha = await sharp(await bytes(files.twig_alpha['1k'].jpg.url)).greyscale().raw().toBuffer();
  const rgb = await sharp(await bytes(files.twig_diff['1k'].jpg.url)).removeAlpha().raw().toBuffer();
  // interleave by hand: colour from one map, coverage from the other
  const rgba = Buffer.alloc(1024 * 1024 * 4);
  for (let i = 0; i < 1024 * 1024; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = alpha[i];
  }
  save(out, await sharp(rgba, { raw: { width: 1024, height: 1024, channels: 4 } }).webp({ quality: 90, alphaQuality: 96 }).toBuffer());
  console.log(`  tex/fir_twig.webp  ${kb(out)}`);
}

/**
 * The fire: four seconds of a real flame (Wikimedia Commons, "Fire آتش 08", CC0) cut out of its dusk background
 * and laid out as an 8 × 8 sheet. The last frames dissolve into the ones before the loop starts, so it never jumps.
 */
async function flame() {
  const out = `${OUT}/tex/flame.webp`;
  if (existsSync(out)) return;
  const info = await json('https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url&titles=' + encodeURIComponent('File:Fire آتش 08.ogv'));
  const dir = join(tmpdir(), 'vesper-flame');
  rmSync(dir, { recursive: true, force: true });
  save(join(dir, 'src.ogv'), await bytes(Object.values(info.query.pages)[0].imageinfo[0].url));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '4', '-t', '4', '-i', join(dir, 'src.ogv'), '-vf', 'crop=760:740:1010:0,fps=18,scale=180:176:flags=lanczos', join(dir, '%03d.png')]);
  const [W, H, N, FADE] = [180, 176, 64, 8];
  const frames = [];
  for (let i = 0; i < N + FADE; i++) {
    const d = await sharp(join(dir, `${String(i + 1).padStart(3, '0')}.png`)).removeAlpha().raw().toBuffer();
    const f = new Float32Array(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      const [r, g, b] = [d[p * 3] / 255, d[p * 3 + 1] / 255, d[p * 3 + 2] / 255];
      // flame is red-dominant; the forest behind it is not
      let a = Math.min(1, Math.max(0, (r - Math.max(b, g * 0.55) * 1.05 - 0.1) / 0.3));
      a = a * a * (3 - 2 * a);
      const x = (p % W) / W;
      const y = Math.floor(p / W) / H;
      a *= Math.min(1, x / 0.08, (1 - x) / 0.08, y / 0.06); // no flame is ever cut off by the frame
      f.set([r * a, g * a, b * a], p * 3);
    }
    frames.push(f);
  }
  const sheet = Buffer.alloc(W * 8 * H * 8 * 3);
  for (let i = 0; i < N; i++) {
    const body = frames[i + FADE];
    const lead = i >= N - FADE ? frames[i - (N - FADE)] : null;
    const k = lead ? (i - (N - FADE) + 1) / (FADE + 1) : 0;
    for (let p = 0; p < W * H; p++) {
      const at = ((Math.floor(i / 8) * H + Math.floor(p / W)) * W * 8 + (i % 8) * W + (p % W)) * 3;
      for (let c = 0; c < 3; c++) sheet[at + c] = Math.round(Math.min(1, lead ? body[p * 3 + c] * (1 - k) + lead[p * 3 + c] * k : body[p * 3 + c]) * 255);
    }
  }
  save(out, await sharp(sheet, { raw: { width: W * 8, height: H * 8, channels: 3 } }).webp({ quality: 86 }).toBuffer());
  rmSync(dir, { recursive: true, force: true });
  console.log(`  tex/flame.webp  ${kb(out)}`);
}

async function model(id) {
  const out = `${OUT}/models/${id}.glb`;
  if (existsSync(out)) return;
  const files = await json(`${API}/files/${id}`);
  const g = files.gltf?.['1k']?.gltf;
  if (!g) return console.log(`  !! no glTF for ${id}`, Object.keys(files));
  const dir = join(tmpdir(), `vesper-${id}`);
  rmSync(dir, { recursive: true, force: true });
  save(join(dir, `${id}.gltf`), await bytes(g.url));
  for (const [rel, f] of Object.entries(g.include)) save(join(dir, rel), await bytes(f.url));
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(
    'npx',
    ['gltf-transform', 'optimize', join(dir, `${id}.gltf`), out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '1024', '--instance', 'false', ...(SETS.has(id) ? ['--join', 'false', '--flatten', 'false'] : []), ...(SIMPLIFY[id] ? ['--simplify-ratio', String(SIMPLIFY[id]), '--simplify-error', '0.01'] : [])],
    { stdio: 'ignore' },
  );
  rmSync(dir, { recursive: true, force: true });
  console.log(`  models/${id}.glb  ${kb(out)}`);
}

async function lamp([name, id]) {
  const out = `${OUT}/models/${name}.glb`;
  if (existsSync(out)) return;
  const src = join(tmpdir(), `vesper-${id}.glb`);
  save(src, await bytes(`https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${id}/glTF-Binary/${id}.glb`));
  execFileSync('npx', ['gltf-transform', 'optimize', src, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '1024', '--instance', 'false', '--simplify-ratio', '0.5', '--simplify-error', '0.002'], { stdio: 'ignore' });
  rmSync(src, { force: true });
  console.log(`  models/${name}.glb  ${kb(out)}`);
}

async function sketchfab([name, shard, uid, , , keep, apart]) {
  const out = `${OUT}/models/${name}.glb`;
  if (existsSync(out)) return;
  const src = join(tmpdir(), `vesper-${uid}.glb`);
  save(src, await bytes(`https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-${shard}/${uid}.glb`));
  // some are authored in the older specular/glossiness model, which three.js no longer reads
  execFileSync('npx', ['gltf-transform', 'metalrough', src, src], { stdio: 'ignore' });
  execFileSync(
    'npx',
    ['gltf-transform', 'optimize', src, out, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '1024', '--instance', 'false', ...(apart ? ['--join', 'false'] : []), ...(keep < 1 ? ['--simplify-ratio', String(keep), '--simplify-error', '0.002'] : ['--simplify', 'false'])],
    { stdio: 'ignore' },
  );
  rmSync(src, { force: true });
  console.log(`  models/${name}.glb  ${kb(out)}`);
}

const commons = async (title, extra) => {
  const api = `https://commons.wikimedia.org/w/api.php?action=query&format=json&titles=${encodeURIComponent(title)}&${extra}`;
  return Object.values((await json(api)).query.pages)[0];
};

async function board([name, title, width]) {
  const out = `${OUT}/tex/board_${name}.webp`;
  if (existsSync(out)) return;
  const info = (await commons(title, `prop=imageinfo&iiprop=url&iiurlwidth=${Math.min(width * 2, 1920)}`)).imageinfo[0];
  save(out, await sharp(await bytes(info.thumburl)).resize(width).webp({ quality: 84 }).toBuffer());
  console.log(`  tex/board_${name}.webp  ${kb(out)}`);
}

async function frame([name, title, width, height]) {
  const out = `${OUT}/tex/frame_${name}.webp`;
  if (existsSync(out)) return;
  const info = (await commons(title, `prop=imageinfo&iiprop=url&iiurlwidth=${Math.min(Math.max(width, height) * 2, 2400)}`)).imageinfo[0];
  save(out, await sharp(await bytes(info.thumburl)).resize(width, height, { fit: 'cover', position: 'attention' }).webp({ quality: 86 }).toBuffer());
  console.log(`  tex/frame_${name}.webp  ${kb(out)}`);
}

async function screen() {
  const out = `${OUT}/video/screen.mp4`;
  if (existsSync(out)) return;
  const info = (await commons(SCREEN, 'prop=videoinfo&viprop=derivatives')).videoinfo[0];
  const small = info.derivatives.find((d) => d.height === 480) ?? info.derivatives[0];
  const src = join(tmpdir(), 'vesper-screen.webm');
  save(src, await bytes(small.src));
  mkdirSync(dirname(out), { recursive: true });
  // the Agulhas current off southern Africa, 18 seconds of it; no sound track; every frame a key frame's neighbour so the loop restarts cleanly
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '36', '-t', '18', '-i', src, '-an', '-vf', 'scale=640:360,fps=24', '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-crf', '30', '-g', '48', '-movflags', '+faststart', out], { stdio: 'inherit' });
  rmSync(src, { force: true });
  console.log(`  video/screen.mp4  ${kb(out)}`);
}

async function env() {
  const out = `${OUT}/sky/env.hdr`;
  if (existsSync(out)) return;
  const files = await json(`${API}/files/${ENV}`);
  save(out, await bytes(files.hdri['1k'].hdr.url));
  console.log(`  sky/env.hdr  ${kb(out)}`);
}

async function audio([name, url, start, length, lufs, bitrate, pre]) {
  const out = `${OUT}/audio/${name}.mp3`;
  if (existsSync(out)) return;
  const src = join(tmpdir(), `vesper-${name}.src`);
  save(src, await bytes(url));
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(length), '-i', src, '-af', `${pre ? pre + ',' : ''}loudnorm=I=${lufs}:TP=-2:LRA=11,afade=t=in:d=0.04`, '-ar', '44100', '-ac', '2', '-b:a', bitrate, out],
    { stdio: 'inherit' },
  );
  rmSync(src, { force: true });
  console.log(`  audio/${name}.mp3  ${kb(out)}`);
}

console.log('textures');
for (const id of TEXTURES) await texture(id);
await twigs();
await flame();
console.log('models');
for (const id of MODELS) await model(id);
for (const l of LAMPS) await lamp(l);
for (const m of SKETCHFAB) await sketchfab(m);
await env();
console.log('prints and video');
for (const b of BOARD) await board(b);
for (const f of FRAMES) await frame(f);
await screen();
console.log('audio');
for (const a of AUDIO) await audio(a);
console.log('done');
