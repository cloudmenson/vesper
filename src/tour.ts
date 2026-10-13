import * as THREE from 'three';
import { clamp, easeInOut, lerp } from './core/math';
import { stops, type Act, type Place, type StopId } from './content';
import { works } from './works';
import { F0, F1 } from './scene/house';

type V3 = [number, number, number];

/** A place for the camera to be: where it stands, what it looks at, how wide. */
export interface Pose {
  pos: V3;
  look: V3;
  fov: number;
}

/** The two points of the scroll where film and walk meet: at the door, and under the skylight. */
export const DOOR = 0.345;
export const SKYLIGHT = 0.862;

const U = F1 + 0.02; // loft floor

/**
 * Where the camera rests at each stop. `at` is the moment of the film the place belongs to: the house's clock,
 * its lamps and its sound all run off that one number, so walking deeper into the house also walks into the night.
 * The room is the film's own frame at the door, so stepping between film and walk there changes nothing on screen.
 * The bed is seen from the window with the skylight over it in the same frame: that is where its way out hangs.
 */
export const POSES: Record<StopId, Pose & { at: number }> = {
  room: { pos: [2.5, 2.62, -0.9], look: [4.0, 1.95, -5.0], fov: 47, at: DOOR },
  terrace: { pos: [-4.45, F0 + 1.1, 1.05], look: [-4.62, F0 + 0.48, 3.4], fov: 54, at: 0.3 },
  fire: { pos: [5.25, F0 + 1.16, -4.35], look: [7.6, F0 + 0.52, -3.8], fov: 46, at: 0.47 },
  picture: { pos: [4.7, F0 + 1.82, -6.25], look: [5.1, F0 + 1.86, -8.76], fov: 44, at: 0.44 },
  kitchen: { pos: [-1.0, 2.7, -4.5], look: [-5.0, 2.2, -6.0], fov: 45, at: 0.57 },
  dining: { pos: [-2.2, F0 + 1.5, -0.9], look: [-4.3, F0 + 0.7, -2.6], fov: 50, at: 0.55 },
  loft: { pos: [0.2, U + 1.65, -6.3], look: [5.8, U + 0.75, -2.2], fov: 58, at: 0.78 },
  bed: { pos: [5.35, U + 1.7, 1.95], look: [4.5, U + 1.41, -1.3], fov: 64, at: 0.83 },
  desk: { pos: [5.9, 6.02, -6.35], look: [8.5, 5.86, -6.3], fov: 40, at: 0.79 },
  board: { pos: [6.25, U + 1.62, -6.3], look: [8.77, U + 1.5, -6.3], fov: 40, at: 0.79 },
  books: { pos: [4.95, U + 1.42, -6.05], look: [4.95, U + 1.12, -8.6], fov: 56, at: 0.785 },
  corner: { pos: [1.9, U + 1.45, -2.9], look: [-0.4, U + 0.55, -0.6], fov: 48, at: 0.8 },
  // at the eyepiece: what is seen through it is the experience's own business (see `scope` there)
  scope: { pos: [2.75, U + 1.5, 0.85], look: [2.15, U + 1.62, 2.1], fov: 42, at: 0.8 },
};

/** Where the walk hands the camera back to the film: exactly the frame the film has at that point of the scroll. */
export const EXITS: Record<'pier' | 'sky', Pose & { at: number }> = {
  pier: { pos: [2.6, 2.2, 9.5], look: [2.7, 2.8, -4], fov: 41, at: 0.26 },
  sky: { pos: [5.0, 6.3, 0.2], look: [5.0, 9.6, -1.4], fov: 46, at: SKYLIGHT },
};

/**
 * Where each way's tag hangs in the house: in the air half a metre or so over the thing it leads to — over the bed,
 * over the monitor, at the top of the picture — fixed there like a thing in the room. A few depend on where one
 * stands: "back" is the door from the terrace, the stair from the loft.
 */
const SPOTS: Record<Place | 'log' | 'record' | 'rain', V3> = {
  room: [3.4, F0 + 1.45, -3.2],
  terrace: [-4.6, F0 + 1.35, 3.1],
  fire: [7.25, F0 + 1.42, -3.8],
  picture: [5.1, F0 + 2.5, -8.55],
  kitchen: [-4.6, F0 + 1.75, -5.6],
  dining: [-4.3, F0 + 1.5, -2.6],
  loft: [-2.3, F0 + 1.75, -8.1],
  bed: [5.0, U + 1.55, -1.5],
  desk: [8.45, U + 1.85, -6.3],
  books: [4.95, U + 2.2, -8.4],
  corner: [-0.4, U + 1.6, -0.5],
  pier: [2.6, 1.9, 9.5],
  sky: [5.6, F1 + 2.8, -1.3],
  board: [8.6, U + 2.3, -6.3],
  scope: [2.2, U + 1.75, 1.6],
  // things to do, each over the thing it is done to
  log: [7.25, F0 + 1.42, -3.3],
  record: [5.75, U + 1.3, -2.7],
  rain: [4.0, F1 + 2.8, -1.2],
};
const SPOTS_FROM: Record<string, V3> = {
  'terrace>room': [2.6, F0 + 1.55, 0.2],
  'terrace>log': [-4.6, F0 + 1.45, 3.1],
  'board>desk': [7.3, U + 0.95, -6.3],
  'fire>log': [7.25, F0 + 1.1, -3.8],
  'room>loft': [1.2, F0 + 2.6, -8.14], // from the door it is the top of the flight that shows
  'loft>room': [2.2, U + 1.1, -8.1],
  'bed>loft': [0.6, U + 1.35, -6.6],
  'desk>loft': [0.6, U + 1.35, -6.6],
  'books>loft': [0.6, U + 1.35, -6.6],
  'corner>loft': [0.6, U + 1.35, -6.6],
};
/** where each sheet hangs on the board over the desk (as `pin` puts them, in src/scene/interior.ts) */
export const SHEETS: Record<string, V3> = {
  carta: [8.76, U + 1.87, -7.26],
  rotonda: [8.76, U + 1.41, -7.42],
  rain: [8.76, U + 1.85, -6.78],
  heavens: [8.76, U + 1.87, -6.28],
  wave: [8.76, U + 1.88, -5.74],
  medusae: [8.76, U + 1.84, -5.3],
  loon: [8.76, U + 1.3, -5.3],
};
const sheet = (to: string) => SHEETS[works.find((w) => `work:${w.id}` === to)?.print ?? 'heavens'];
export const spot = (from: StopId, to: Place | Act): V3 =>
  SPOTS_FROM[`${from}>${to}`] ??
  (to.startsWith('work:')
    ? sheet(to)
    : to === 'room' && FLOOR[from] === 'up'
      ? SPOTS_FROM['loft>room'] // "down" is the head of the stair, from anywhere up here
      : SPOTS[to as keyof typeof SPOTS]);
/**
 * What else can be gone to from a stop besides the ways written for it: every other place on the same floor, the
 * stair to the other one, and the terrace through the glass. Their plates are shown only while the place is in
 * sight — whatever the visitor can see, they can walk to, without going by way of somewhere else first.
 */
export function extras(from: StopId): { to: StopId; label: string }[] {
  const floor = FLOOR[from];
  if (floor === 'out') return [];
  const out = (Object.keys(FLOOR) as StopId[]).filter((id) => id !== from && FLOOR[id] === floor).map((to) => ({ to, label: stops[to].go }));
  if (floor === 'ground') out.push({ to: 'loft', label: 'Climb to the loft' }, { to: 'terrace', label: stops.terrace.go });
  else out.push({ to: 'room', label: 'Go back down' });
  return out;
}
/** standing close to one sheet of the board, to read it */
export const closeTo = (to: string): Pose => {
  const [, y, z] = sheet(to);
  return { pos: [7.72, y - 0.02, z + 0.42], look: [8.77, y, z + 0.16], fov: 36 };
};

const FLOOR: Record<StopId, 'out' | 'ground' | 'up'> = {
  terrace: 'out',
  room: 'ground',
  fire: 'ground',
  picture: 'ground',
  kitchen: 'ground',
  dining: 'ground',
  loft: 'up',
  bed: 'up',
  desk: 'up',
  board: 'up',
  scope: 'up',
  books: 'up',
  corner: 'up',
};

/** height of the stair under x, and an eye walking up it between the wall and the glass */
const tread = (x: number) => F0 + ((x + 3.0) / 0.27) * ((U - F0) / 19);
const eye = (x: number): V3 => [x, tread(x) + 1.55, -8.14];
/** Up the stair: round the end of the island to its foot, then straight up the flight, and off at the top. */
const UP: Pose[] = [
  { pos: [-3.5, F0 + 1.62, -6.6], look: [-1.6, F0 + 1.7, -8.4], fov: 48 },
  { pos: [-3.2, F0 + 1.62, -7.9], look: [0.6, tread(0.6) + 1.2, -8.14], fov: 50 },
  { pos: eye(-1.6), look: [1.6, tread(1.6) + 1.3, -8.14], fov: 50 },
  { pos: eye(0.2), look: [3.4, U + 1.3, -8.0], fov: 50 },
  { pos: eye(1.6), look: [5.2, U + 1.25, -7.2], fov: 52 },
  { pos: [2.9, U + 1.62, -7.3], look: [6.2, U + 1.1, -4.6], fov: 54 },
];
const DOWN: Pose[] = [
  { pos: [2.9, U + 1.62, -7.3], look: [0.6, tread(0.6) + 0.9, -8.14], fov: 54 },
  { pos: eye(1.6), look: [-1.6, tread(-1.6) + 0.9, -8.14], fov: 52 },
  { pos: eye(0.2), look: [-3.0, F0 + 1.0, -8.14], fov: 50 },
  { pos: eye(-1.6), look: [-4.6, F0 + 1.2, -7.6], fov: 50 },
  { pos: [-3.2, F0 + 1.62, -7.9], look: [-2.0, F0 + 1.4, -4.5], fov: 48 },
  { pos: [-3.5, F0 + 1.62, -6.6], look: [0.5, F0 + 1.2, -3.5], fov: 48 },
];
/**
 * Out through the open door and along the terrace to the fire bowl; and back. Going out, the head comes round by
 * the left — the way one is about to walk — a part of the turn at each step, never all of it at once.
 */
const OUT: Pose[] = [
  { pos: [2.6, 2.5, 0.9], look: [-1.6, 2.2, -1.6], fov: 47 },
  { pos: [-1.4, 2.4, 2.3], look: [-4.6, 1.75, 3.3], fov: 50 },
];
const IN: Pose[] = [
  { pos: [-1.4, 2.4, 2.3], look: [2.6, 2.3, 0.2], fov: 50 },
  { pos: [2.6, 2.5, 0.9], look: [3.6, 2.0, -4.0], fov: 47 },
];
/** From the fire bowl down toward the pier: backing away, with the house coming into view. */
const TO_PIER: Pose[] = [{ pos: [-0.9, 2.4, 4.3], look: [-2.4, 2.4, -1.0], fov: 46 }];
/**
 * The bed is come to round its foot, so that it is first seen from the window side, the way it was made to be seen:
 * by the west of it from the stair and the reading chair, with the bed kept in view all the way round; and from the
 * desk and the shelves down the east aisle, backing away from them, until it slides into the frame.
 */
const BED_WEST: Pose[] = [
  { pos: [2.5, U + 1.6, -1.6], look: [4.5, U + 0.7, 0.2], fov: 52 },
  { pos: [3.3, U + 1.6, 1.3], look: [5.0, U + 0.6, -0.6], fov: 51 },
];
const BED_EAST: Pose[] = [
  { pos: [7.8, U + 1.6, -2.9], look: [7.9, U + 1.3, -6.5], fov: 50 },
  { pos: [7.0, U + 1.6, 1.3], look: [5.3, U + 0.6, -1.2], fov: 51 },
];
/** Points to pass through between two stops on the same floor, so the camera goes round the furniture, not through it. */
const VIA: Record<string, Pose[]> = {
  // from behind the sofa, the way west is round its end, not over its arm
  'picture>kitchen': [{ pos: [1.4, 2.85, -6.25], look: [-3.0, 2.3, -5.6], fov: 46 }],
  'picture>dining': [{ pos: [1.4, 2.85, -6.25], look: [-3.4, 2.1, -3.4], fov: 47 }],
  // to the telescope from the far side of the bed: down the west aisle, clear of the headboard and what stands behind it
  'desk>scope': [{ pos: [2.3, U + 1.56, -2.6], look: [2.6, U + 1.5, 1.6], fov: 50 }],
  'books>scope': [{ pos: [2.3, U + 1.56, -2.6], look: [2.6, U + 1.5, 1.6], fov: 50 }],
  'loft>bed': BED_WEST,
  'corner>bed': [{ pos: [2.6, U + 1.55, -0.9], look: [5.0, U + 0.7, 0.0], fov: 50 }, BED_WEST[1]],
  'desk>bed': BED_EAST,
  'books>bed': BED_EAST,
  'room>fire': [{ pos: [3.7, 2.5, -2.3], look: [6.4, 1.8, -4.2], fov: 47 }],
  'room>picture': [{ pos: [3.3, 2.95, -3.3], look: [4.9, 2.7, -7.6], fov: 46 }],
  'fire>picture': [{ pos: [5.3, 2.9, -5.5], look: [5.2, 2.9, -8.4], fov: 45 }],
  'fire>kitchen': [{ pos: [2.0, 2.6, -3.2], look: [-3.0, 2.2, -5.2], fov: 46 }],
  'fire>dining': [{ pos: [2.0, 2.6, -2.6], look: [-3.4, 2.0, -2.4], fov: 48 }],
};
/** from the chaise, the way to the stair is round the front of the sofa */
const TO_STAIR: Partial<Record<StopId, Pose[]>> = { fire: [{ pos: [2.3, 2.6, -2.7], look: [-2.0, 2.3, -5.6], fov: 47 }] };

function between(from: StopId, to: StopId): Pose[] {
  if (from === to) return [];
  const a = FLOOR[from];
  const b = FLOOR[to];
  // (the board is looked at from the desk's own chair: the ways to it and from it are the desk's)
  const at = (id: StopId) => (id === 'board' ? 'desk' : id);
  if (at(from) === at(to)) return [];
  if (a === 'out') return to === 'room' ? IN : [...IN, POSES.room, ...between('room', to)];
  if (b === 'out') return from === 'room' ? OUT : [...between(from, 'room'), POSES.room, ...OUT];
  if (a === 'ground' && b === 'up') return [...(TO_STAIR[from] ?? []), ...UP];
  if (a === 'up' && b === 'ground') return [...(from === 'loft' ? [] : [...between(from, 'loft'), POSES.loft]), ...DOWN, ...[...(TO_STAIR[to] ?? [])].reverse()];
  const fwd = VIA[`${at(from)}>${at(to)}`];
  if (fwd) return fwd;
  const back = VIA[`${at(to)}>${at(from)}`];
  return back ? [...back].reverse() : [];
}

export interface TourEvents {
  /** the camera has set off: put the choices away */
  depart: () => void;
  /** it has arrived: show this stop's choices */
  arrive: (stop: StopId) => void;
  /** it has reached one of the ways back into the film, which takes over again from scroll position `at` */
  exit: (way: 'pier' | 'sky', at: number) => void;
}

/** A smooth curve through numbers given at equal steps (Catmull–Rom): for angles and lens widths along a route. */
function through(v: number[], f: number) {
  const n = v.length;
  const i = Math.min(n - 2, Math.max(0, Math.floor(f)));
  const w = f - i;
  const p0 = v[Math.max(i - 1, 0)];
  const p1 = v[i];
  const p2 = v[i + 1];
  const p3 = v[Math.min(i + 2, n - 1)];
  return 0.5 * (2 * p1 + (p2 - p0) * w + (2 * p0 - 5 * p1 + 4 * p2 - p3) * w * w + (3 * p1 - p0 - 3 * p2 + p3) * w * w * w);
}

/**
 * Walks the camera between stops. While it is `active` the film's own camera path is ignored and `view` is used
 * instead; `at` still drives everything else in the house.
 *
 * A route is a curve for the feet and, separately, a heading and a tilt for the head. (Steering the head by a point
 * to look at fails whenever the walker turns round: the point passes close by and the view whips over.)
 * Time along the route is shared out by how far each leg goes and how far it turns, so a turn is taken slowly.
 */
export class Tour {
  active = false;
  moving = false;
  stop: StopId = 'room';
  at = POSES.room.at;
  readonly view = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 45 };

  private t = 0;
  private duration = 1;
  private path = new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
  private yaws: number[] = [0, 0];
  private tilts: number[] = [0, 0];
  private fovs: number[] = [45, 45];
  /** running total of each leg's share of the time */
  private share: number[] = [0, 1];
  private at0 = 0;
  private at1 = 0;
  private dest: Place = 'room';
  /** up close to something at this stop (see `peek`) */
  near = false;
  private then: (() => void) | null = null;

  constructor(private on: TourEvents) {}

  /** where the walk is bound just now: the stop it stands at, or the one it is on its way to */
  get goal(): Place {
    return this.moving ? this.dest : this.stop;
  }

  /** Takes over from the film, wherever its camera is, and walks to `stop`. */
  begin(stop: StopId, from: { pos: THREE.Vector3; look: THREE.Vector3; fov: number }, at: number) {
    this.active = true;
    this.view.pos.copy(from.pos);
    this.view.look.copy(from.look);
    this.view.fov = from.fov;
    this.at = at;
    this.stop = stop;
    this.travel(stop, []);
  }

  /** Takes one of the ways on from the current stop. */
  go(way: Place) {
    if (!this.active || this.moving) return;
    if (way === 'sky') this.travel(way, this.stop === 'bed' ? [] : [...between(this.stop, 'bed'), POSES.bed]);
    else if (way === 'pier') this.travel(way, this.stop === 'terrace' ? TO_PIER : [...between(this.stop, 'terrace'), POSES.terrace, ...TO_PIER]);
    else this.travel(way, between(this.stop, way));
  }

  /**
   * Goes up to something for a closer look without leaving the stop — a sheet on the board — or, with nothing
   * given, steps back to where the stop itself stands. `done` is called on getting there.
   */
  peek(pose: Pose | null, done?: () => void) {
    if (!this.active || this.moving) return;
    const end = pose ?? POSES[this.stop];
    this.near = pose !== null;
    this.route(end, [], POSES[this.stop].at);
    this.then = done ?? (() => {});
    this.dest = this.stop;
    this.moving = true;
  }

  /** Puts the camera at a stop at once (for stills). */
  place(stop: StopId) {
    const p = POSES[stop];
    this.active = true;
    this.moving = false;
    this.stop = stop;
    this.at = p.at;
    this.view.pos.set(...p.pos);
    this.view.look.set(...p.look);
    this.view.fov = p.fov;
  }

  end() {
    this.active = false;
    this.moving = false;
  }

  private travel(to: Place, via: Pose[]) {
    const end = to === 'pier' || to === 'sky' ? EXITS[to] : POSES[to];
    this.near = false;
    this.then = null;
    this.route(end, via, end.at);
    this.dest = to;
    this.moving = true;
    this.on.depart();
  }

  /** Lays the way from where the camera is, through `via`, to `end`; the house's clock runs on to `at1` meanwhile. */
  private route(end: Pose, via: Pose[], at1: number) {
    const V = (v: V3) => new THREE.Vector3(...v);
    const pts = [this.view.pos.clone(), ...via.map((p) => V(p.pos)), V(end.pos)];
    const looks = [this.view.look.clone(), ...via.map((p) => V(p.look)), V(end.look)];
    const n = pts.length;
    this.fovs = [this.view.fov, ...via.map((p) => p.fov), end.fov];
    this.path = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    // heading and tilt at each station; headings unwound so that every turn goes the short way round
    this.yaws = [];
    this.tilts = [];
    for (let i = 0; i < n; i++) {
      const d = looks[i].sub(pts[i]).normalize();
      let yaw = Math.atan2(d.x, d.z);
      if (i > 0) yaw -= Math.round((yaw - this.yaws[i - 1]) / (Math.PI * 2)) * Math.PI * 2;
      this.yaws.push(yaw);
      this.tilts.push(Math.asin(clamp(d.y, -1, 1)));
    }
    // each leg's share of the time: its length (stairs counted long), plus three and a half metres' worth for every radian it turns
    this.share = [0];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < n - 1; i++) {
      let length = 0;
      this.path.getPoint(i / (n - 1), a);
      for (let k = 1; k <= 8; k++) {
        this.path.getPoint((i + k / 8) / (n - 1), b);
        // a metre climbed or descended takes as long as three and a half on the level: a stair is walked, not flown
        length += a.distanceTo(b) + Math.abs(b.y - a.y) * 3.5;
        a.copy(b);
      }
      this.share.push(this.share[i] + length + (Math.abs(this.yaws[i + 1] - this.yaws[i]) + Math.abs(this.tilts[i + 1] - this.tilts[i])) * 3.6 + 1e-4);
    }
    const effort = this.share[n - 1];
    // a brisk walk; nothing at all if already there
    // (a few centimetres of settling — coming in at the door, the film has already brought the camera all but there —
    // take a fraction of a second, not the couple of seconds a real walk is given at the least)
    this.duration = effort < 0.08 ? 0.05 : Math.min(0.3 + effort * 0.75, 0.9 + effort * 0.3, 18);
    this.t = 0;
    this.at0 = this.at;
    this.at1 = at1;
  }

  update(dt: number) {
    if (!this.active || !this.moving) return;
    this.t = Math.min(1, this.t + dt / this.duration);
    const k = easeInOut(this.t);
    // which leg, and how far along it
    const n = this.share.length;
    const s = k * this.share[n - 1];
    let i = 0;
    while (i < n - 2 && s > this.share[i + 1]) i++;
    const f = i + clamp((s - this.share[i]) / (this.share[i + 1] - this.share[i]));
    this.path.getPoint(f / (n - 1), this.view.pos);
    const yaw = through(this.yaws, f);
    const tilt = through(this.tilts, f);
    this.view.look.set(Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), Math.cos(yaw) * Math.cos(tilt)).multiplyScalar(4).add(this.view.pos);
    this.view.fov = through(this.fovs, f);
    this.at = lerp(this.at0, this.at1, k);
    if (this.t < 1) return;
    this.moving = false;
    if (this.then) {
      // that was a closer look, or the step back from one: no arriving anywhere
      const done = this.then;
      this.then = null;
      return done();
    }
    if (this.dest === 'pier' || this.dest === 'sky') {
      this.active = false;
      this.on.exit(this.dest, this.at1);
    } else {
      this.stop = this.dest;
      this.on.arrive(this.dest);
    }
  }
}

export { stops };
