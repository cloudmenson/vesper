import * as THREE from 'three';
import { Builder, timber, xf } from './builder';
import type { Assets } from './assets';
import type { Mats } from './materials';
import { furnish } from './interior';

// Levels (metres). Water is y = 0.
export const F0 = 1.2; // ground floor
export const C0 = 4.3; // ground ceiling
export const F1 = 4.65; // loft floor
export const C1 = 7.45; // loft ceiling
export const ROOF = 7.75;

export const DOOR_X: [number, number] = [1.3, 3.9];
/** floor of the fireplace niche, where the fire is laid */
export const HEARTH = { x: 7.615, y: F0 + 0.32, z: -3.8 };
export const SKYLIGHT = { x0: 3.7, x1: 6.3, z0: -2.0, z1: 0.6 };

/** Which room a point is in. Each room's surfaces reflect that room, so nothing has to change as the camera moves between them. */
export type Room = 'ground' | 'loft' | 'out';
export function roomOf(c: THREE.Vector3Like): Room {
  if (c.x > -7.9 && c.x < 7.9 && c.z > -8.9 && c.z < -0.02 && c.y > F0 - 0.05 && c.y < C0 + 0.01) return 'ground';
  if (c.x > -2.4 && c.x < 8.9 && c.z > -8.9 && c.z < 2.32 && c.y >= C0 + 0.01 && c.y < C1 + 0.01) return 'loft';
  return 'out';
}

/**
 * Every lamp in the house exists only in the bake: it lights the rooms in Blender and costs nothing at runtime.
 * `fire` lamps go into a layer of their own, so the hearth can flicker without the rest of the house following.
 */
export interface BakeLight {
  kind: 'point' | 'spot';
  group: 'lamps' | 'fire';
  pos: [number, number, number];
  /** spots only; they point straight down unless told otherwise */
  target?: [number, number, number];
  color: number;
  /** candela */
  intensity: number;
  /** size of the source in metres: bigger means softer shadows */
  radius: number;
  angle?: number;
}

export interface Ctx {
  m: Mats;
  assets: Assets;
  group: THREE.Group;
  b: Builder; // opaque, shadowed
  e: Builder; // emitters
  g: Builder; // glass
  flames: THREE.ShaderMaterial[];
  paneZ: (x0: number, x1: number, y0: number, y1: number, z: number) => void;
  paneX: (x: number, y0: number, y1: number, z0: number, z1: number) => void;
  /** a card of filmed flame, w × h, standing at (x, y, z) and turning to face the camera */
  flame: (w: number, h: number, x: number, y: number, z: number) => void;
  /** a lamp for the bake */
  lamp: (x: number, y: number, z: number, intensity: number, color?: number, radius?: number, fire?: boolean) => void;
  down: (x: number, y: number, z: number, intensity: number, angle?: number) => void;
  /** things that move: called every frame with the time and where the camera is */
  tick: ((time: number, eye: THREE.Vector3) => void)[];
  /** what the visitor has set going in the house, for the things that answer to it */
  state: { record: boolean };
  /** the four corners of the monitor's screen as its viewer sees them: top left, top right, bottom right, bottom left */
  screen: THREE.Vector3[];
  /** a broad soft wash from the ceiling, aimed */
  wash: (pos: [number, number, number], target: [number, number, number], intensity: number, angle: number, radius?: number) => void;
}

/**
 * Fire is film, not noise: a 64-frame loop of a real flame (shot against dusk, keyed onto black) played on a card.
 * Each card starts at its own point in the loop, and consecutive frames are cross-faded so 18 fps reads as smooth.
 * The film's colour is thrown away and put back from its brightness, along the ramp a wood fire really runs:
 * deep orange at the ragged edges, through yellow, to nearly white where it is hottest.
 */
const FLAME_VERT = /* glsl */ `
  uniform vec2 uSize;
  varying vec2 vUv;
  void main(){
    vUv = uv;
    // seen from all round: the card turns about its vertical axis to face the camera
    vec3 base = modelMatrix[3].xyz;
    vec3 toCam = cameraPosition - base;
    vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
    vec3 wp = base + right * position.x * uSize.x + vec3(0.0, position.y * uSize.y, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;
const FLAME_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uTime, uLevel, uPhase, uFlip;
  varying vec2 vUv;
  vec3 frame(float i, vec2 uv){
    vec2 cell = vec2(mod(i, 8.0), floor(i / 8.0));
    return texture2D(uMap, vec2((cell.x + uv.x) / 8.0, 1.0 - (cell.y + 1.0 - uv.y) / 8.0)).rgb;
  }
  void main(){
    vec2 uv = vec2(mix(vUv.x, 1.0 - vUv.x, uFlip), vUv.y);
    // keep clear of the cell borders, where a neighbouring frame would bleed in
    uv = clamp(uv, vec2(0.012), vec2(0.988));
    float f = uTime * 18.0 + uPhase;
    float f0 = mod(floor(f), 64.0);
    vec3 film = mix(frame(f0, uv), frame(mod(f0 + 1.0, 64.0), uv), fract(f));
    float heat = smoothstep(0.06, 1.0, film.r * 0.55 + film.g * 0.95);
    vec3 col = mix(vec3(0.85, 0.13, 0.015), vec3(1.0, 0.42, 0.06), smoothstep(0.0, 0.38, heat));
    col = mix(col, vec3(1.0, 0.8, 0.42), smoothstep(0.3, 0.85, heat));
    // no flame ends in a straight line: the foot of the card dissolves into the logs it stands behind
    float body = smoothstep(0.02, 0.26, film.r) * smoothstep(0.0, 0.2, vUv.y);
    // (dimmer as the fire dies down, and gone with it: by morning it has burnt out)
    gl_FragColor = vec4(col * body * (0.35 + 2.3 * heat) * (0.55 + 0.45 * uLevel) * smoothstep(0.0, 0.3, uLevel), 1.0);
  }
`;

export function createHouse(m: Mats, assets: Assets) {
  const group = new THREE.Group();
  // Everything the main builder makes is lightmapped. Texels are spent inside, where the camera gets close.
  const b = new Builder(
    true,
    (c, size) => {
      const inside = c.x > -8.1 && c.x < 9.05 && c.z > -9.05 && c.z < 2.45 && c.y > F0 - 0.06 && c.y < ROOF - 0.02;
      const slender = Math.min(size.x, size.y, size.z) < 0.09; // slats, fins, rails: light varies along them, hardly across
      return (inside ? 1 : 0.42) * (slender ? 0.6 : 1);
    },
    roomOf,
  );
  const e = new Builder();
  const g = new Builder();
  const bakeLights: BakeLight[] = [];
  const lamp: Ctx['lamp'] = (x, y, z, intensity, color = 0xffdcb6, radius = 0.06, fire = false) =>
    void bakeLights.push({ kind: 'point', group: fire ? 'fire' : 'lamps', pos: [x, y, z], color, intensity, radius });
  const down: Ctx['down'] = (x, y, z, intensity, angle = 1.0) => void bakeLights.push({ kind: 'spot', group: 'lamps', pos: [x, y, z], color: 0xffe4c6, intensity, radius: 0.03, angle });
  const wash: Ctx['wash'] = (pos, target, intensity, angle, radius = 0.3) => void bakeLights.push({ kind: 'spot', group: 'lamps', pos, target, color: 0xffe0bc, intensity, radius, angle });
  const flames: THREE.ShaderMaterial[] = [];
  const tick: Ctx['tick'] = [];
  const screen: THREE.Vector3[] = [];
  const state = { record: false };

  const paneZ: Ctx['paneZ'] = (x0, x1, y0, y1, z) => {
    const p = new THREE.PlaneGeometry(x1 - x0, y1 - y0);
    p.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
    g.add(m.glass, p);
  };
  const paneX: Ctx['paneX'] = (x, y0, y1, z0, z1) => {
    const p = new THREE.PlaneGeometry(z1 - z0, y1 - y0);
    p.rotateY(Math.PI / 2);
    p.translate(x, (y0 + y1) / 2, (z0 + z1) / 2);
    g.add(m.glass, p);
  };
  const flame: Ctx['flame'] = (w, h, x, y, z) => {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: {
        uMap: { value: assets.flame },
        uTime: { value: 0 },
        uLevel: { value: 1 },
        uPhase: { value: (flames.length * 23.7) % 64 },
        uFlip: { value: flames.length % 2 },
        uSize: { value: new THREE.Vector2(w, h) },
      },
      vertexShader: FLAME_VERT,
      fragmentShader: FLAME_FRAG,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), mat);
    mesh.position.set(x, y, z);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    group.add(mesh);
    flames.push(mat);
  };

  const ledExt = m.glow(0xffc88e, 1.25, 'ext', 1.9);
  const lantern = m.glow(0xffb060, 2.4, 'ext', 3.4);

  const Y0 = F0 - 0.04;

  /* --------------------------------------------------------- ground shell */
  b.mm(m.concreteDark, -8.3, 8.3, -2.5, Y0, -9.3, 0);
  b.mm(m.oakFloor, -7.8, 7.8, Y0, F0, -8.8, 0);
  b.mm(m.concrete, -8, 8, Y0, C0, -9, -8.8);
  b.mm(m.concrete, -8, -7.8, Y0, C0, -8.8, 0);

  // fireplace: a stone wall with a long low niche. The firebox goes on back into the outer wall behind the stone,
  // 63 cm from its glass to its back: room to lay a fire in, which half a metre of stone alone was not.
  const fz0 = -5.6;
  const fz1 = -2.0;
  const fy0 = F0 + 0.32;
  const fy1 = F0 + 1.02;
  const fx1 = 7.93;
  b.mm(m.stone, 7.3, 7.8, F0, fy0, -6.4, -1.2);
  b.mm(m.stone, 7.3, 7.8, fy1, C0, -6.4, -1.2);
  b.mm(m.stone, 7.3, 7.8, fy0, fy1, -6.4, fz0);
  b.mm(m.stone, 7.3, 7.8, fy0, fy1, fz1, -1.2);
  // the east wall, whole but for the firebox let into it
  b.mm(m.concrete, 7.8, 8, Y0, fy0, -8.8, 0);
  b.mm(m.concrete, 7.8, 8, fy1, C0, -8.8, 0);
  b.mm(m.concrete, 7.8, 8, fy0, fy1, -8.8, fz0);
  b.mm(m.concrete, 7.8, 8, fy0, fy1, fz1, 0);
  b.mm(m.concrete, fx1, 8, fy0, fy1, fz0, fz1);
  {
    // its lining: one dark skin over stone and concrete alike
    const t = 0.006;
    b.mm(m.cladding, 7.3, fx1, fy0, fy0 + t, fz0, fz1);
    b.mm(m.cladding, 7.3, fx1, fy1 - t, fy1, fz0, fz1);
    b.mm(m.cladding, 7.3, fx1, fy0 + t, fy1 - t, fz0, fz0 + t);
    b.mm(m.cladding, 7.3, fx1, fy0 + t, fy1 - t, fz1 - t, fz1);
    b.mm(m.cladding, fx1 - t, fx1, fy0 + t, fy1 - t, fz0 + t, fz1 - t);
  }
  // (the fire itself is laid in the niche by the interior: see `hearth`)
  // The niche is closed with a sheet of ceramic glass in a steel frame, as a fire indoors has to be. The glass is
  // smoked: it takes a little off the fire and gives back the room in front of it, which is how one sees it is there.
  {
    const x = 7.29;
    const T = 0.034;
    b.mm(m.steel, 7.276, 7.3, fy1 - T, fy1, fz0, fz1);
    b.mm(m.steel, 7.276, 7.3, fy0, fy0 + T, fz0, fz1);
    b.mm(m.steel, 7.276, 7.3, fy0 + T, fy1 - T, fz0, fz0 + T);
    b.mm(m.steel, 7.276, 7.3, fy0 + T, fy1 - T, fz1 - T, fz1);
    const pane = new THREE.PlaneGeometry(fz1 - fz0 - T * 2, fy1 - fy0 - T * 2);
    pane.rotateY(-Math.PI / 2);
    pane.translate(x, (fy0 + fy1) / 2, (fz0 + fz1) / 2);
    const fireGlass = m.glass.clone();
    fireGlass.onBeforeCompile = m.glass.onBeforeCompile;
    fireGlass.envMap = null; // it reflects the room it faces, not the sky the windows see
    fireGlass.color.setHex(0x2a2420);
    fireGlass.opacity = 0.16;
    fireGlass.side = THREE.FrontSide;
    fireGlass.userData.shine = 1.5;
    const sheet = new THREE.Mesh(pane, fireGlass);
    sheet.renderOrder = 7; // over the flames behind it
    sheet.userData.noMirror = true;
    group.add(sheet);
  }

  // slab between floors, built around the stair void
  b.mm(m.ceiling, -8.6, -2.5, C0, F1, -9.6, 1.6);
  b.mm(m.ceiling, -2.5, 9.0, C0, F1, -7.4, 2.4);
  b.mm(m.ceiling, -2.5, -1.4, C0, F1, -9.6, -7.4);
  b.mm(m.ceiling, 1.9, 9.0, C0, F1, -9.6, -7.4);
  b.mm(m.ceiling, -1.4, 1.9, C0, F1, -9.6, -8.8);
  e.mm(ledExt, -8.4, -2.7, C0 - 0.012, C0, 1.28, 1.34);
  e.mm(ledExt, -2.2, 8.7, C0 - 0.012, C0, 2.08, 2.14);
  lamp(1.6, C0 - 0.45, 1.4, 3.6, 0xffd9b0, 0.5); // the soffit over the door

  // ground glazing: seven bays, one of which is the door
  const bays = [-7.8, -6.5, -3.9, -1.3, 1.3, 3.9, 6.5, 7.8];
  b.mm(m.steel, -7.8, 7.8, C0 - 0.07, C0, -0.1, 0.04);
  b.mm(m.steel, -7.8, 7.8, F0 - 0.01, F0 + 0.025, -0.1, 0.04);
  for (const x of bays) b.mm(m.steel, x - 0.025, x + 0.025, F0, C0 - 0.07, -0.03, 0.03);
  for (let i = 0; i < bays.length - 1; i++) {
    if (bays[i] === DOOR_X[0]) continue;
    paneZ(bays[i] + 0.025, bays[i + 1] - 0.025, F0 + 0.025, C0 - 0.07, 0);
  }

  // the sliding door (its own group so scroll can drive it)
  const door = new THREE.Group();
  door.userData.noBake = true; // it moves: its shadow must not be frozen into the floor
  {
    const db = new Builder();
    const dg = new Builder();
    const [x0, x1] = DOOR_X;
    const z = -0.065;
    db.mm(m.steel, x0, x0 + 0.045, F0 + 0.025, C0 - 0.07, z - 0.02, z + 0.02);
    db.mm(m.steel, x1 - 0.045, x1, F0 + 0.025, C0 - 0.07, z - 0.02, z + 0.02);
    db.mm(m.steel, x0, x1, C0 - 0.115, C0 - 0.07, z - 0.02, z + 0.02);
    db.mm(m.steel, x0, x1, F0 + 0.025, F0 + 0.07, z - 0.02, z + 0.02);
    db.mm(m.brass, x0 + 0.075, x0 + 0.095, F0 + 0.95, F0 + 1.35, z + 0.02, z + 0.05);
    const p = new THREE.PlaneGeometry(x1 - x0 - 0.09, C0 - F0 - 0.185);
    p.translate((x0 + x1) / 2, (F0 + C0) / 2 - 0.022, z);
    dg.add(m.glass, p);
    db.build(door, { cast: false });
    dg.build(door, { cast: false, receive: false, order: 3 });
  }
  group.add(door);

  /* ---------------------------------------------------------- loft shell */
  b.mm(m.plaster, -2.44, 8.94, F1, C1, -8.94, -8.8);
  b.mm(m.cladding, -2.5, 9.0, F1, C1, -9.0, -8.94);
  b.mm(m.plaster, -2.44, -2.3, F1, C1, -8.8, 2.3);
  b.mm(m.cladding, -2.5, -2.44, F1, C1, -8.94, 2.4);
  b.mm(m.plaster, 8.8, 8.94, F1, C1, -8.8, 2.3);
  b.mm(m.cladding, 8.94, 9.0, F1, C1, -8.94, 2.4);

  {
    // A skirting board round the loft: black, shallow, where plaster meets oak. (It is not in the light bake — it
    // takes the light of the floor it stands on — so it can be fitted without baking the house again; and it covers
    // the first few centimetres of wall, where the baked light is mottled because the floor finish cuts across it.)
    const skirting = new THREE.Group();
    skirting.userData.noBake = true;
    const sb = new Builder();
    const y0 = F1 + 0.02;
    const y1 = F1 + 0.155;
    sb.mm(m.cladding, 8.786, 8.8, y0, y1, -8.8, 2.26); // east
    sb.mm(m.cladding, 2.6, 8.786, y0, y1, -8.8, -8.786); // north, as far as the stair
    sb.mm(m.cladding, -2.3, -2.286, y0, y1, -8.8, 2.26); // west
    sb.build(skirting, { cast: false });
    group.add(skirting);
  }
  b.mm(m.steel, -2.3, 8.8, C1 - 0.06, C1, 2.26, 2.34);
  b.mm(m.steel, -2.3, 8.8, F1, F1 + 0.05, 2.26, 2.34);
  const ubays = [-2.3, -0.25, 1.8, 4.7, 7.6, 8.8];
  for (const x of ubays) b.mm(m.steel, x - 0.025, x + 0.025, F1 + 0.05, C1 - 0.06, 2.27, 2.33);
  for (let i = 0; i < ubays.length - 1; i++) paneZ(ubays[i] + 0.025, ubays[i + 1] - 0.025, F1 + 0.05, C1 - 0.06, 2.3);

  // roof, with the skylight cut out above the bed
  const S = SKYLIGHT;
  const roof: [number, number, number, number][] = [
    [-2.5, S.x0, -9.0, 2.4],
    [S.x1, 9.0, -9.0, 2.4],
    [S.x0, S.x1, -9.0, S.z0],
    [S.x0, S.x1, S.z1, 2.4],
  ];
  for (const [x0, x1, z0, z1] of roof) {
    b.mm(m.concreteDark, x0, x1, C1, ROOF, z0, z1);
    b.mm(m.plaster, Math.max(x0, -2.3), Math.min(x1, 8.8), C1 - 0.02, C1, Math.max(z0, -8.8), Math.min(z1, 2.3));
  }
  b.mm(m.steel, S.x0 - 0.08, S.x1 + 0.08, ROOF, ROOF + 0.1, S.z0 - 0.08, S.z0);
  b.mm(m.steel, S.x0 - 0.08, S.x1 + 0.08, ROOF, ROOF + 0.1, S.z1, S.z1 + 0.08);
  b.mm(m.steel, S.x0 - 0.08, S.x0, ROOF, ROOF + 0.1, S.z0, S.z1);
  b.mm(m.steel, S.x1, S.x1 + 0.08, ROOF, ROOF + 0.1, S.z0, S.z1);
  // rails the glass runs out on
  b.mm(m.steel, S.x1, 9.0, ROOF, ROOF + 0.05, S.z0 - 0.06, S.z0 - 0.02);
  b.mm(m.steel, S.x1, 9.0, ROOF, ROOF + 0.05, S.z1 + 0.02, S.z1 + 0.06);

  const skylight = new THREE.Group();
  skylight.userData.noBake = true;
  {
    const sb = new Builder();
    const sg = new Builder();
    const y = ROOF + 0.13;
    sb.mm(m.steel, S.x0 - 0.1, S.x1 + 0.1, y - 0.025, y + 0.025, S.z0 - 0.1, S.z0 - 0.04);
    sb.mm(m.steel, S.x0 - 0.1, S.x1 + 0.1, y - 0.025, y + 0.025, S.z1 + 0.04, S.z1 + 0.1);
    sb.mm(m.steel, S.x0 - 0.1, S.x0 - 0.04, y - 0.025, y + 0.025, S.z0 - 0.04, S.z1 + 0.04);
    sb.mm(m.steel, S.x1 + 0.04, S.x1 + 0.1, y - 0.025, y + 0.025, S.z0 - 0.04, S.z1 + 0.04);
    const p = new THREE.PlaneGeometry(S.x1 - S.x0 + 0.08, S.z1 - S.z0 + 0.08);
    p.rotateX(-Math.PI / 2);
    p.translate((S.x0 + S.x1) / 2, y, (S.z0 + S.z1) / 2);
    sg.add(m.glass, p);
    sb.build(skylight, { cast: false });
    sg.build(skylight, { cast: false, receive: false, order: 3 });
  }
  group.add(skylight);

  // solar array
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 2; j++) {
      b.box(m.panel, 1.55, 0.04, 1.0, -1.3 + i * 1.65, ROOF + 0.16, -7.6 + j * 1.2, 0.12);
      b.box(m.steel, 1.5, 0.12, 0.05, -1.3 + i * 1.65, ROOF + 0.06, -7.95 + j * 1.2);
    }
  }

  // planted roof over the kitchen wing
  b.mm(m.moss, -8.3, -2.6, F1, F1 + 0.05, -9.3, 1.3);
  b.mm(m.concrete, -8.6, -8.3, F1, F1 + 0.24, -9.6, 1.6);
  b.mm(m.concrete, -8.3, -2.5, F1, F1 + 0.24, -9.6, -9.3);
  b.mm(m.concrete, -8.3, -2.5, F1, F1 + 0.24, 1.3, 1.6);

  // cedar fins wrapping the loft: the house's lantern
  {
    const fins: { x: number; z: number; y0: number; turn: boolean }[] = [];
    const step = 0.21;
    for (let x = -2.45; x <= 1.82; x += step) fins.push({ x, z: 2.5, y0: C0, turn: false });
    for (let x = 7.62; x <= 9.0; x += step) fins.push({ x, z: 2.5, y0: C0, turn: false });
    for (let x = -2.45; x <= 9.0; x += step) fins.push({ x, z: -9.1, y0: C0, turn: false });
    for (let z = -9.0; z <= 2.42; z += step) fins.push({ x: 9.1, z, y0: C0, turn: true });
    for (let z = -9.0; z <= 2.42; z += step) fins.push({ x: -2.6, z, y0: F1, turn: true });
    for (const f of fins) {
      const h = ROOF + 0.06 - f.y0;
      b.add(m.cedar, timber(0.05, h, 0.17), xf(f.x, f.y0 + h / 2, f.z, 0, f.turn ? Math.PI / 2 : 0, 0));
    }
  }

  /* ------------------------------------------------------ terrace & pier */
  b.mm(m.deck, -9.0, 9.4, F0 - 0.2, F0 - 0.02, 0, 5.2);
  for (let i = 0; i < 3; i++) {
    const top = F0 - 0.02 - 0.2 * (i + 1);
    b.mm(m.deck, 1.5, 3.7, top - 0.18, top, 5.2 + 0.4 * i, 5.6 + 0.4 * i);
  }
  e.mm(ledExt, -8.8, 1.4, F0 - 0.215, F0 - 0.2, 5.12, 5.16);
  e.mm(ledExt, 3.8, 9.2, F0 - 0.215, F0 - 0.2, 5.12, 5.16);
  for (let x = -8.4; x <= 9; x += 3.4) {
    b.cyl(m.concreteDark, 0.1, 3.6, x, F0 - 2.0, 2.6, 10);
    b.cyl(m.concreteDark, 0.1, 3.6, x, F0 - 2.0, 4.9, 10);
  }
  b.mm(m.deck, 1.7, 3.5, 0.43, 0.55, 6.4, 25);
  b.mm(m.deck, 0.7, 4.5, 0.43, 0.55, 25, 28.2);
  for (let z = 7.5; z <= 28; z += 3) {
    const wide = z > 25;
    for (const x of wide ? [0.78, 4.42] : [1.76, 3.44]) b.cyl(m.cladding, 0.065, 3.4, x, -1.2, z, 8);
  }
  let side = 0;
  for (let z = 8.4; z <= 27.5; z += 3.2) {
    const wide = z > 25;
    const x = side++ % 2 ? (wide ? 4.4 : 3.42) : wide ? 0.8 : 1.78;
    b.mm(m.steel, x - 0.035, x + 0.035, 0.55, 1.0, z - 0.035, z + 0.035);
    b.mm(m.steel, x - 0.06, x + 0.06, 0.96, 1.0, z - 0.06, z + 0.06);
    e.mm(lantern, x - 0.036, x + 0.036, 0.84, 0.95, z - 0.036, z + 0.036);
    lamp(x, 1.06, z, 1.1, 0xffb060, 0.05);
  }

  // two low chairs on the terrace (the fire bowl between them is set by the interior: see `fire`)
  group.add(
    assets.spawn('modern_arm_chair_01', -6.05, F0 - 0.02, 3.55, 1.25),
    assets.spawn('modern_arm_chair_01', -3.25, F0 - 0.02, 3.75, -1.1),
    assets.spawn('rubber_boots', 4.75, F0 - 0.02, 0.45, 0.3),
    assets.spawn('wooden_lantern_01', 8.75, F0 - 0.02, 4.7, 0.6, 1.1),
    assets.spawn('wooden_lantern_01', 4.05, 0.55, 27.7, 2.2, 1.1),
    assets.spawn('wooden_lantern_01', -8.4, F0 - 0.02, 0.6, 1.1, 1.1),
  );
  for (const [x, y, z] of [
    [8.75, F0 + 0.26, 4.7],
    [4.05, 0.83, 27.7],
    [-8.4, F0 + 0.26, 0.6],
  ]) {
    e.sphere(lantern, 0.035, x, y, z, 1, 1.5, 1, 10);
    lamp(x, y + 0.02, z, 1.6, 0xffb060, 0.04);
  }

  /* ------------------------------------------------------------ interior */
  const ctx: Ctx = { m, assets, group, b, e, g, flames, tick, state, screen, paneZ, paneX, flame, lamp, down, wash };
  furnish(ctx);

  const lightmapped = b.build(group);
  const emitters = e.build(group, { cast: false, receive: false });
  emitters.forEach((mesh) => {
    mesh.userData.emitter = true;
    if ((mesh.material as THREE.Material).userData.bakeOnly) mesh.visible = false;
  });
  g.build(group, { cast: false, receive: false, order: 3 });

  return { group, door, skylight, flames, tick, state, screen, lightmapped, bakeLights, density: b.density };
}

export type House = ReturnType<typeof createHouse>;
