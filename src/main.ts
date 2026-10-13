import * as THREE from 'three';
import '@fontsource/cormorant-garamond/300.css';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/500.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/500-italic.css';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import 'lenis/dist/lenis.css';
import './style.css';

import Lenis from 'lenis';
import { Experience, pickQuality } from './scene/experience';
import { createUI } from './ui';
import { Ambience } from './audio';
import { clamp } from './core/math';
import { Tour, POSES, DOOR, SKYLIGHT, closeTo, spot, stops } from './tour';
import { isAct, site, type Act, type StopId, type Way } from './content';
import { works } from './works';
import { F1 } from './scene/house';

declare global {
  interface Window {
    __ready?: boolean;
  }
}

// ?p=0.42 pins the film to one frame (used for stills and for tuning shots); ?stop=fire pins one stop of the walk
const params = new URLSearchParams(location.search);
const still = params.get('stop') as StopId | null;
const pinned = still && POSES[still] ? POSES[still].at : params.has('p') ? clamp(parseFloat(params.get('p')!)) : null;

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

async function boot() {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const app = document.getElementById('app')!;
  document.body.classList.add('is-loading');

  const lenis = new Lenis({ lerp: reduced ? 1 : 0.085, wheelMultiplier: 0.85, touchMultiplier: 1.4 });
  lenis.stop();
  const limit = () => Math.max(1, document.documentElement.scrollHeight - innerHeight);
  const jump = (p: number) => lenis.scrollTo(p * limit(), { duration: reduced ? 0 : 2.6, easing: (t) => 1 - Math.pow(1 - t, 3) });

  const experience = new Experience(canvas, pickQuality(), pinned === null);

  /* ----------------------------------------------------------- the walk */
  const UPSTAIRS: StopId[] = ['loft', 'bed', 'desk', 'board', 'books', 'corner', 'scope'];
  // The film runs on the scroll as far as the door, and again from the skylight; between the two the visitor walks.
  let wanted: StopId | null = null; // a stop asked for from outside the house: go on to it once we are in
  let filmWas = 0; // where the scroll last had the film, to tell which end of the house we come in by
  const tour = new Tour({
    depart: () => ui.tour.hide(),
    arrive: (id) => {
      if (wanted && wanted !== id) {
        const next = wanted;
        wanted = null;
        return tour.go(next);
      }
      wanted = null;
      show(id);
    },
    // the camera is now exactly where the film has it at `at`: put the scroll there and the film carries on
    exit: (way, at) => {
      if (way === 'sky') clear(); // the skylight opens on a clear night
      experience.view = null;
      lenis.start();
      lenis.scrollTo(at * limit() + (way === 'sky' ? 3 : 0), { immediate: true, force: true });
      filmWas = way === 'sky' ? 1 : 0;
      if (way === 'sky') lenis.scrollTo(limit(), { duration: 30, easing: (t) => t });
    },
  });
  // Some of the plates are things to do, not places to go; and two of them stay done until they are undone.
  const done = { rain: false, record: false };
  const says = (w: Way) => (w.to === 'rain' && done.rain ? 'Let it clear' : w.to === 'record' && done.record ? 'Lift the needle' : w.label);
  const show = (id: StopId) => {
    const stop = stops[id];
    ui.tour.show(
      { ...stop, ways: stop.ways.map((w) => ({ ...w, label: says(w) })) },
      stop.ways.map((w) => spot(id, w.to)),
      (to) => (isAct(to) ? act(to) : tour.go(to)),
    );
  };
  const clear = () => {
    done.rain = false;
    experience.rain = false;
  };
  const act = (to: Act) => {
    const way = stops[tour.stop].ways.find((w) => w.to === to)!;
    if (to === 'log') experience.stoked = 1;
    else if (to === 'rain') {
      experience.rain = done.rain = !done.rain;
      ui.tour.relabel(to, says(way));
    } else if (to === 'record') {
      experience.record = done.record = !done.record;
      if (done.record) audio.play('needle', 0.5);
      ui.tour.relabel(to, says(way));
    } else {
      // one of the sheets on the board: up to it, and its note opens; closing the note steps back
      const i = works.findIndex((w) => `work:${w.id}` === to);
      ui.tour.hide();
      tour.peek(closeTo(to), () =>
        ui.work.open(works[i], i + 1, works.length, () => {
          ui.work.close();
          tour.peek(null, () => show(tour.stop));
        }),
      );
    }
  };
  const enter = (stop: StopId) => {
    lenis.stop();
    tour.begin(stop, experience, experience.p);
  };
  /** Hands the camera straight back to the film, at whichever end of the house `toward` lies. */
  const leave = (toward: number) => {
    const out = toward < DOOR;
    tour.end();
    ui.tour.hide();
    ui.work.close();
    if (!out) clear();
    experience.view = null;
    lenis.start();
    lenis.scrollTo((out ? Math.min(DOOR, experience.p) : SKYLIGHT) * limit() + (out ? -3 : 3), { immediate: true, force: true });
    filmWas = out ? 0 : 1;
  };
  // Indoors the wheel has two meanings left. Back, at the door, is the way out: the room is the film's own frame
  // there, so the film simply resumes under the same gesture. On, under the skylight, opens it.
  let pull = 0;
  const nudge = (dy: number) => {
    if (!tour.active || tour.moving) return void (pull = 0);
    pull = Math.sign(dy) === Math.sign(pull) ? pull + dy : dy;
    if (pull < -50 && tour.stop === 'room') leave(0);
    else if (pull < -50 && tour.stop === 'terrace') tour.go('pier');
    else if (pull > 50 && tour.stop === 'bed') tour.go('sky');
    else return;
    pull = 0;
  };
  addEventListener('wheel', (e) => nudge(e.deltaY), { passive: true });
  let touchY = 0;
  addEventListener('touchstart', (e) => (touchY = e.touches[0].clientY), { passive: true });
  addEventListener(
    'touchmove',
    (e) => {
      nudge((touchY - e.touches[0].clientY) * 1.5);
      touchY = e.touches[0].clientY;
    },
    { passive: true },
  );
  const ui = createUI(app, (p) => {
    if (p > DOOR && p < SKYLIGHT) {
      // somewhere indoors: that is a stop of the walk, not a point of the scroll
      const stop: StopId = p < 0.51 ? 'room' : p < 0.63 ? 'kitchen' : p < 0.75 ? 'loft' : 'bed';
      if (tour.active) {
        if (tour.moving) wanted = stop;
        else if (tour.stop !== stop) tour.go(stop);
      } else {
        wanted = stop;
        jump(DOOR + 0.003);
      }
      return;
    }
    if (tour.active) leave(p);
    jump(p);
  });
  if (params.has('cam')) experience.debugCam = params.get('cam')!.split(',').map(Number);
  if (params.has('rain')) experience.rain = true; // for stills of the weather
  if (params.has('record')) experience.record = true; // …and of the record player at work
  await experience.build((f, label) => ui.progress(f, label));
  (window as unknown as { __exp: Experience }).__exp = experience; // handy in the console, and used by scripts/profile.mjs

  const audio = new Ambience();
  const sound = (on: boolean) => {
    ui.setSound(on);
    void audio.enable(on);
  };
  ui.sound.addEventListener('click', () => sound(!audio.on));
  // the click that opens the film is also what lets the browser start its sound
  if (pinned === null) sound(await ui.entrance());

  addEventListener('resize', () => experience.resize());
  ui.scope.chart(experience.names);
  // a fish rising is heard as well as seen, if one is near enough and out of doors
  experience.onRise = (far) => audio.play('splash', clamp(1 - far / 50) * (tour.active && tour.view.pos.z < 0 ? 0.12 : 0.5));
  const was = new THREE.Vector3();

  // intro: the picture fades up from black, then the title rises
  let t0 = -1;
  let frames = 0;
  let last = performance.now();
  const fixedTime = params.has('t') ? parseFloat(params.get('t')!) : null;

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  scrollTo(0, 0);
  ui.reveal();
  document.body.classList.remove('is-loading');
  lenis.start();

  if (still && POSES[still]) {
    tour.place(still);
    experience.view = tour.view;
    show(still);
  }
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (t0 < 0) t0 = now;
    const since = (now - t0) / 1000;
    lenis.raf(now);

    const intro = pinned !== null ? 1 : clamp((since - 0.5) / 2.2);
    experience.fade = pinned !== null ? 1 : clamp(since / 2.4);
    let target = pinned ?? clamp(scrollY / limit());
    if (pinned === null && !tour.active) {
      if (target > DOOR && target < SKYLIGHT) {
        // The scroll has gone indoors. The film runs as far as the threshold it came by and no further; only
        // once it is really there — not while it is still catching up with the scroll — does the visitor take over.
        const gate = filmWas <= DOOR ? DOOR : SKYLIGHT;
        target = gate;
        if (Math.abs(experience.p - gate) < 0.0015) enter(gate === DOOR ? 'room' : 'bed');
      } else filmWas = target;
    }
    if (tour.active && pinned === null) {
      tour.update(dt);
      if (tour.active) {
        experience.view = tour.view;
        target = tour.at;
      } else {
        // it has just handed the camera back: the scroll now stands where the film should pick up
        target = filmWas = clamp(scrollY / limit());
      }
    }
    if (pinned !== null) experience.p = pinned;
    // at the telescope the experience looks through it
    experience.scope = tour.active && tour.stop === 'scope' && !tour.moving;
    experience.frame(target, fixedTime ?? now / 1000, dt);
    ui.scope.set(experience.scope);
    ui.scope.track(experience.camera, 1 - experience.wet);
    ui.update(experience.p, intro, tour.active ? stops[tour.stop] : null);
    ui.tour.track(experience.camera, dt);
    if (site.screenVideo) {
      // The film on the loft's monitor runs for as long as the visitor is upstairs, and from the moment they set
      // off up the stair, so that it is well under way when they get there; anywhere else it waits, paused.
      const up = tour.active && UPSTAIRS.includes(tour.goal as StopId);
      const eye = experience.camera.position;
      // (in sight once the eye is over the loft's floor: nothing up there stands between a walker and the screen)
      ui.tube.set(site.screenVideo, up, up && !experience.scope && eye.y > F1 + 1.15 && eye.x < 8.2 && eye.z < 2.3);
      ui.tube.track(experience.camera, experience.house.screen);
    }
    experience.holdLook = ui.tour.reaching;
    // how far out of doors the walk has gone, and how near the fire bowl: the sound follows the feet
    const eye = tour.view.pos;
    const walk = tour.active ? { open: eye.y < 4.4 ? clamp((eye.z + 0.4) / 1.3) : 0, fireside: clamp(1 - (Math.hypot(eye.x + 4.6, eye.z - 3.1) - 1.2) / 4.3) } : null;
    // the visitor's own footfall: on the level, or on the stair
    const pace = tour.active && tour.moving && !tour.near ? eye.distanceTo(was) / Math.max(dt, 1e-3) : 0;
    const steep = Math.abs(eye.y - was.y) > eye.distanceTo(was) * 0.28;
    was.copy(eye);
    audio.update(experience.p, walk, experience.gust, {
      rain: experience.wet,
      stride: steep ? 0 : clamp(pace / 1.1),
      climb: steep ? clamp(pace / 0.7) : 0,
      record: done.record,
      stoked: experience.stoked,
    });

    if (++frames === 8) window.__ready = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

boot().catch((err) => {
  console.error(err);
  document.body.classList.remove('is-loading');
  const label = document.querySelector('[data-label]');
  if (label) label.textContent = 'WebGL 2 is required to enter';
});
