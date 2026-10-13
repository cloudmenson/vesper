import * as THREE from 'three';
import { Curve1 } from '../core/math';

type V3 = [number, number, number];

interface Key {
  p: number;
  pos: V3;
  look: V3;
  fov: number;
}

/**
 * The whole film, as keyframes over scroll progress.
 * In over the water → through the door → the sofa → the kitchen →
 * up the stair → the loft → out through the skylight into morning.
 */
export const KEYS: Key[] = [
  // dusk: in over the water
  { p: 0.0, pos: [13, 5.6, 84], look: [1.5, 13.4, 0], fov: 34 },
  { p: 0.06, pos: [11, 4.6, 66], look: [1.5, 7.4, 0], fov: 33 },
  { p: 0.13, pos: [6, 2.5, 42], look: [2.2, 3.9, 0], fov: 34 },
  { p: 0.2, pos: [2.9, 1.8, 23], look: [2.6, 2.9, 0], fov: 37 },
  { p: 0.26, pos: [2.6, 2.2, 9.5], look: [2.7, 2.8, -4], fov: 41 },
  { p: 0.3, pos: [2.6, 2.55, 2.4], look: [3.2, 2.35, -5], fov: 45 },
  // the long room
  { p: 0.345, pos: [2.5, 2.62, -0.9], look: [4.0, 1.95, -5.0], fov: 47 },
  { p: 0.4, pos: [1.7, 2.2, -2.3], look: [4.2, 1.75, -5.0], fov: 44 },
  { p: 0.47, pos: [2.35, 2.05, -2.6], look: [5.2, 1.8, -4.7], fov: 41 },
  { p: 0.525, pos: [0.5, 2.5, -3.4], look: [-4.4, 2.3, -5.2], fov: 45 },
  { p: 0.585, pos: [-1.0, 2.7, -4.5], look: [-5.0, 2.2, -6.0], fov: 45 },
  // the stair: from its foot, up between the wall and the glass
  { p: 0.635, pos: [-3.3, 2.82, -7.75], look: [0.4, 3.9, -8.2], fov: 47 },
  { p: 0.68, pos: [-1.6, 3.7, -8.14], look: [2.4, 5.2, -8.1], fov: 50 },
  { p: 0.72, pos: [0.4, 5.05, -8.14], look: [4.4, 6.0, -7.8], fov: 50 },
  // the loft
  { p: 0.755, pos: [2.3, 6.04, -7.9], look: [8.4, 5.85, -6.5], fov: 46 },
  { p: 0.79, pos: [5.5, 6.02, -6.45], look: [8.5, 5.86, -6.3], fov: 38 },
  // the bed, from the window; then the head goes back, to the skylight over it
  { p: 0.83, pos: [5.35, 6.37, 1.95], look: [4.5, 6.08, -1.3], fov: 64 },
  { p: 0.862, pos: [5.0, 6.3, 0.2], look: [5.0, 9.6, -1.4], fov: 46 },
  // out through the skylight, turning from the hill behind the house round to the lake as the roof falls away;
  // the sun comes up over the water; round the east shore and back to where we began
  { p: 0.892, pos: [5.0, 9.4, -0.9], look: [9.6, 15.7, 0.8], fov: 45 },
  { p: 0.922, pos: [4.0, 12.5, -3.5], look: [9, 6.5, 40], fov: 42 },
  { p: 0.95, pos: [31, 11, 27], look: [3, 4.5, 7], fov: 40 },
  { p: 0.976, pos: [25, 8.2, 52], look: [2, 6.5, 0], fov: 37 },
  { p: 1.0, pos: [13, 6.2, 76], look: [1.5, 9.5, 0], fov: 34 },
];

export class CameraPath {
  private c: Curve1[];

  constructor(keys = KEYS) {
    const ps = keys.map((k) => k.p);
    const ch = (f: (k: Key) => number) => new Curve1(ps, keys.map(f));
    this.c = [
      ch((k) => k.pos[0]),
      ch((k) => k.pos[1]),
      ch((k) => k.pos[2]),
      ch((k) => k.look[0]),
      ch((k) => k.look[1]),
      ch((k) => k.look[2]),
      ch((k) => k.fov),
    ];
  }

  sample(p: number, pos: THREE.Vector3, look: THREE.Vector3) {
    const c = this.c;
    pos.set(c[0].at(p), c[1].at(p), c[2].at(p));
    look.set(c[3].at(p), c[4].at(p), c[5].at(p));
    return c[6].at(p);
  }
}
