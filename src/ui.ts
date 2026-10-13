import * as THREE from 'three';
import { chapters, clock, outro, site, type Stop, type Way } from './content';
import type { Work } from './works';
import { clamp, easeOut, lerp, smoothstep } from './core/math';

interface Block {
  el: HTMLElement;
  parts: HTMLElement[];
  enter: (p: number, intro: number) => number;
  exit: (p: number) => number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const lines = (t: string[]) => t.map((l) => `<span class="line"><span data-part="line">${l}</span></span>`).join('');

export function createUI(root: HTMLElement, onJump: (p: number) => void) {
  const total = chapters.length + 1;
  root.innerHTML = `
    <div id="loader">
      <div class="loader__mark">${site.name}</div>
      <div class="loader__bar"><i></i></div>
      <div class="loader__meta mono"><span data-label>Preparing</span><span data-pct>0</span></div>
      <div class="loader__enter">
        <button class="cta" type="button" data-enter="sound"><span>Enter with sound</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
        <button class="mono loader__quiet" type="button" data-enter="quiet">or enter in silence</button>
      </div>
    </div>

    <header class="hud hud--top">
      <a class="mark" href="#" data-jump="0">${site.name}</a>
      <nav>
        <button class="chip mono" id="sound" type="button" aria-pressed="false">Sound <b>Off</b></button>
        <a class="chip chip--solid mono" href="#" data-jump="1">Enquire</a>
      </nav>
    </header>

    <section class="hero" data-block>
      <p class="mono hero__kicker" data-part>${site.kicker}&ensp;—&ensp;${site.coords}</p>
      <h1 class="hero__title">${lines([site.name])}</h1>
      <p class="hero__tag" data-part>${site.tagline}</p>
    </section>

    ${chapters
      .map(
        (c, i) => `
      <section class="chapter" data-block data-align="${c.align}" id="${c.id}">
        <p class="mono eyebrow" data-part><b>${pad(i + 1)}</b><i></i>${c.label}</p>
        <h2>${lines(c.title)}</h2>
        <p class="body" data-part>${c.body}</p>
      </section>`,
      )
      .join('')}

    <section class="outro" data-block>
      <p class="mono eyebrow" data-part><b>${pad(total)}</b><i></i>${outro.label}</p>
      <h2>${lines(outro.title)}</h2>
      <p class="body" data-part>${outro.body}</p>
      <a class="cta" data-part href="mailto:${site.email}?subject=Vesper"><span>${outro.cta}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></a>
      <p class="mono credit" data-part>Concept, 3D &amp; code — <a href="${site.authorUrl}">${site.author}</a><br />Light baked, cloth simulated, forest, mountains and sky computed in Blender<br />Materials &amp; models: Poly Haven (CC0); Sketchfab, CC BY — umkhero, blackcube4, PoneMyintMyat, fenik0, cc0archviz, trijoko.maryadi, nocyde, JDegville, digrafstudio, isaackgamma, DuduPav, gilles.schaeck, AleixoAlonso, topfrank2013, Smart3DScan, aeonfitzgerald; lamp © Wayfair (Khronos) · Stars: Yale Bright Star Catalogue, NASA SVS; constellations: d3-celestial (BSD) · Recordings: Freesound (CC0) · Music: Satie, Gymnopédie No. 1 — R. Alciatore (Musopen)</p>
    </section>

    <section class="tour" aria-live="polite">
      <p class="mono eyebrow"><b data-tour="idx"></b><i></i><span data-tour="label"></span></p>
      <h2 data-tour="title"></h2>
      <p class="body" data-tour="body"></p>
      <p class="mono ways__hint" data-tour="hint"></p>
    </section>
    <nav class="ways" data-tour="ways" aria-label="Where to go from here"></nav>
    <div class="tube" aria-hidden="true"></div>
    <aside class="work">
      <p class="mono eyebrow"><b data-work="n"></b><i></i><span data-work="meta"></span></p>
      <h2 data-work="title"></h2>
      <p class="body" data-work="body"></p>
      <p class="work__more"><a class="chip chip--solid mono" data-work="link" target="_blank" rel="noopener"></a><button type="button" class="chip mono" data-work="close">Back to the board</button></p>
    </aside>
    <div class="scope" aria-hidden="true"><div class="scope__sky" data-scope="sky"></div><i class="scope__ring"></i></div>

    <div class="scroll-hint mono" aria-hidden="true"><span>Scroll</span><i></i></div>

    <aside class="rail" aria-label="Chapters">
      <i class="rail__fill"></i>
      ${chapters.map((c, i) => `<button type="button" style="top:${(((c.at[0] + c.at[1]) / 2) * 100).toFixed(2)}%" data-jump="${((c.at[0] + c.at[1]) / 2).toFixed(4)}" aria-label="${c.label}"><span class="mono">${pad(i + 1)}</span></button>`).join('')}
    </aside>

    <footer class="hud hud--bottom">
      <div class="clock"><b data-clock>21:38</b><span class="mono">${site.coords}</span></div>
      <div class="where mono"><b data-idx>00</b><span>/ ${pad(total)}</span><em data-name>Prologue</em></div>
    </footer>
  `;

  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const loader = $('#loader');
  const bar = $<HTMLElement>('.loader__bar i');
  const pct = $('[data-pct]');
  const label = $('[data-label]');
  const clockEl = $('[data-clock]');
  const idxEl = $('[data-idx]');
  const nameEl = $('[data-name]');
  const fill = $<HTMLElement>('.rail__fill');
  const hint = $<HTMLElement>('.scroll-hint');
  const railBtns = [...root.querySelectorAll<HTMLButtonElement>('.rail button')];

  root.querySelectorAll<HTMLElement>('[data-jump]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.preventDefault();
      onJump(parseFloat(el.dataset.jump!));
    }),
  );

  const els = [...root.querySelectorAll<HTMLElement>('[data-block]')];
  const blocks: Block[] = els.map((el, i) => {
    const parts = [...el.querySelectorAll<HTMLElement>('[data-part]')];
    if (i === 0) return { el, parts, enter: (_p, intro) => intro, exit: (p) => smoothstep(0.022, 0.07, p) };
    if (i === els.length - 1) return { el, parts, enter: (p) => smoothstep(outro.at, outro.at + 0.045, p), exit: () => 0 };
    const [a, b] = chapters[i - 1].at;
    return { el, parts, enter: (p) => smoothstep(a - 0.03, a + 0.012, p), exit: (p) => smoothstep(b, b + 0.03, p) };
  });

  let shownIdx = -1;
  let shownClock = '';
  let shownName = '';

  /* --- the walk: a caption for the place the visitor stands in, and the ways on from it --- */
  const tourEl = $('.tour');
  const tourParts = { idx: $('[data-tour="idx"]'), label: $('[data-tour="label"]'), title: $('[data-tour="title"]'), body: $('[data-tour="body"]'), ways: $('[data-tour="ways"]'), hint: $('[data-tour="hint"]') };
  let pick: ((to: Way['to']) => void) | null = null;
  tourParts.ways.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-to]');
    if (btn && pick) pick(btn.dataset.to as Way['to']);
  });
  addEventListener('keydown', (e) => {
    if (!tourEl.classList.contains('is-on') || e.metaKey || e.ctrlKey || e.altKey) return;
    const btn = tourParts.ways.querySelectorAll<HTMLButtonElement>('button')[parseInt(e.key, 10) - 1];
    if (btn) btn.click();
  });
  // The ways on are not a list: each is a plate fixed in the house itself, in the air over the place it leads to,
  // and it stays there as the view moves, the way a thing in the room would — nearer ones larger, a far one small.
  // Only a place that is off the screen has its plate wait in a tidy column at that side, mid-height, with an arrow
  // for a dot; when the head turns far enough to see the place, the plate glides out to it.
  // The name always stands to the right of its dot.
  interface Spot {
    el: HTMLButtonElement;
    at: THREE.Vector3;
    /** where its place is on screen, and how far off */
    px: number;
    py: number;
    far: number;
    wide: number;
    off: boolean;
    west: boolean;
    near: number;
    /** 0 waiting in its column … 1 on its place */
    mix: number;
    /** its place in the column, when it waits in one */
    cx: number;
    cy: number;
    /** where it is put when its place is in sight: on the place, or as near it as the rest of the screen allows */
    tx: number;
    ty: number;
    x: number;
    y: number;
  }
  const spots: Spot[] = [];
  let fresh = true;
  let rects: { caption: DOMRect; fixtures: { rail: boolean; r: DOMRect }[] } | null = null;
  addEventListener('resize', () => (rects = null));
  const seen = new THREE.Vector3();
  const pointer = { x: -1e4, y: -1e4 };
  addEventListener('pointermove', (e) => ((pointer.x = e.clientX), (pointer.y = e.clientY)));
  /** the pointer is closing on a plate: the head should keep still, or the plate slides away from under it */
  let reaching = false;
  // what else is on the screen, which no plate may lie on: the mark and the two buttons at the top, the chapter rail,
  // the clock and the counter at the bottom, and this stop's own caption
  const fixtures = ['.mark', '.hud nav', '.rail', '.clock', '.where'].map((q) => root.querySelector<HTMLElement>(q)).filter((el): el is HTMLElement => !!el);
  type Box = { l: number; t: number; r: number; b: number };
  const hits = (a: Box, b: Box) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  /** the room a plate takes up with its dot at (x, y) */
  const boxOf = (s: Spot, x: number, y: number, scale = 1): Box => ({ l: x - 16, t: y - 25 * scale, r: x + s.wide * scale + 8, b: y + 25 * scale });
  /**
   * Every frame: puts each plate where the camera now sees its place. The rule is the visitor's: what can be seen
   * has its plate on it. A plate goes to a column only when its place is off the screen altogether; one whose
   * place is on screen but under something else (the caption, the rail, another plate) is moved aside just far
   * enough to clear it, and no further.
   */
  function track(camera: THREE.PerspectiveCamera, dt: number) {
    reaching = false;
    if (!spots.length || !tourEl.classList.contains('is-on')) return;
    const W = innerWidth;
    const H = innerHeight;
    const phone = W <= 720;
    const side = phone ? 20 : 44;
    // (measured when a stop is shown and when the window changes, not every frame)
    if (!rects) rects = { caption: tourEl.getBoundingClientRect(), fixtures: fixtures.map((el) => ({ rail: el.classList.contains('rail'), r: el.getBoundingClientRect() })) };
    const caption = rects.caption;
    const taken: Box[] = [{ l: caption.left - 10, t: caption.top - 14, r: caption.right + 16, b: caption.bottom + 10 }];
    let top = phone ? 80 : 96;
    let bottom = H - 76;
    let east = W - side; // plates end here on the right
    for (const { rail, r } of rects.fixtures) {
      if (!r.width && !r.height) continue; // not shown at this size
      // (the rail is a hair-line with its numbers hung to the left of it)
      taken.push({ l: r.left - (rail ? 44 : 12), t: r.top - 12, r: r.right + 12, b: r.bottom + 12 });
      if (rail) east = Math.min(east, r.left - 52);
      else if (r.top < H / 2) top = Math.max(top, r.bottom + 16);
      else bottom = Math.min(bottom, r.top - 16);
    }
    if (phone) bottom = Math.min(bottom, caption.top - 30);
    for (const s of spots) {
      seen.copy(s.at).applyMatrix4(camera.matrixWorldInverse); // in the eye's own space: -z is ahead
      s.far = seen.length();
      const behind = seen.z > -0.1;
      s.west = seen.x < 0;
      seen.applyMatrix4(camera.projectionMatrix);
      s.px = (seen.x * 0.5 + 0.5) * W;
      s.py = (-seen.y * 0.5 + 0.5) * H;
      s.near = Math.min(1.2, Math.max(0.74, 2.0 / Math.sqrt(s.far)));
      // off the screen: its place itself, not merely its plate. (One already waiting comes back only once its place
      // is properly in view, so that it does not dither at the edge.)
      const m = s.off ? 24 : -30;
      s.off = behind || s.px < m || s.px > W - m || s.py < m || s.py > H - m;
      if (!behind) s.west = s.px < W / 2;
    }
    // the columns, for what is out of sight: evenly spaced about the middle of the screen, in the order the ways are given
    const gap = phone ? 46 : 56;
    for (const west of [true, false]) {
      const column = spots.filter((s) => s.off && s.west === west);
      const span = (column.length - 1) * gap;
      const floor = (west ? Math.min(bottom, caption.top - 20) : bottom) - 28;
      let y = Math.max(top + 28, Math.min(H * 0.46 - span / 2, floor - span));
      for (const s of column) {
        s.cx = west ? side : east - s.wide * 0.92;
        s.cy = y;
        y += gap;
      }
    }
    // What is in sight: on its place, then kept on the screen and clear of everything else, nearest first.
    const placed: Box[] = [...taken, ...spots.filter((s) => s.off).map((s) => boxOf(s, s.cx, s.cy, 0.92))];
    for (const s of spots.filter((t) => !t.off).sort((p, q) => p.far - q.far)) {
      const half = 25 * s.near;
      let x = Math.min(east - s.wide * s.near, Math.max(side, s.px));
      let y = Math.min(bottom - half, Math.max(top + half, s.py));
      for (let tries = 0; tries < 6; tries++) {
        const box = boxOf(s, x, y, s.near);
        const other = placed.find((t) => hits(box, t));
        if (!other) break;
        // step off it the short way: up or down, unless that leaves the screen, then sideways
        const up = other.t - half - 2;
        const down = other.b + half + 2;
        if (Math.abs(up - y) <= Math.abs(down - y) ? up >= top + half : down > bottom - half) y = up;
        else if (down <= bottom - half) y = down;
        else x = Math.min(east - s.wide * s.near, Math.max(side, other.r + 18));
      }
      s.tx = x;
      s.ty = y;
      placed.push(boxOf(s, x, y, s.near));
    }
    for (const s of spots) {
      // the glide between a column and a place
      s.mix = fresh ? (s.off ? 0 : 1) : Math.min(1, Math.max(0, s.mix + (s.off ? -dt : dt) / 0.32));
      const k = s.mix * s.mix * (3 - 2 * s.mix);
      const gx = s.off ? Math.min(W + 60, Math.max(-60 - s.wide, s.px)) : s.tx;
      const gy = s.off ? Math.min(H + 40, Math.max(-40, s.py)) : s.ty;
      s.x = s.mix >= 1 ? gx : s.cx + (gx - s.cx) * k;
      s.y = s.mix >= 1 ? gy : s.cy + (gy - s.cy) * k;
      const docked = s.mix < 0.5;
      s.el.classList.toggle('is-off', docked);
      s.el.classList.toggle('is-west', docked && s.west);
      s.el.style.setProperty('--near', (0.92 + (s.near - 0.92) * k).toFixed(3));
      s.el.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0)`;
      if (pointer.x > s.x - 70 && pointer.x < s.x + s.wide + 60 && Math.abs(pointer.y - s.y) < 62) reaching = true;
    }
    fresh = false;
  }

  // The monitor's own film is a texture; the owner's choice of film is on YouTube, and may only be shown by
  // YouTube's player. So at the desk that player is laid over the monitor: an ordinary frame in the page, bent by a
  // 2D projective transform onto the four corners of the screen as the camera sees them, every frame.
  const tubeEl = $('.tube');
  const TW = 1280;
  const TH = 720;
  let tubeFrame: HTMLIFrameElement | null = null;
  let tubePlaying = false;
  const corner = new THREE.Vector3();
  const say = (func: string) => tubeFrame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*');
  const tube = {
    /**
     * `want`: the film should be running (the visitor is upstairs, or on the way up: it is started early, so that
     * it is already playing when the monitor comes into sight). Otherwise it is paused where it is.
     * `seen`: the monitor is in view, with nothing between it and the eye.
     */
    set(id: string, want: boolean, seen: boolean) {
      if (want && !tubeFrame) {
        const q = `autoplay=1&mute=1&controls=0&loop=1&playlist=${id}&playsinline=1&rel=0&iv_load_policy=3&disablekb=1&fs=0&enablejsapi=1`;
        tubeEl.innerHTML = `<iframe width="${TW}" height="${TH}" src="https://www.youtube-nocookie.com/embed/${id}?${q}" title="" tabindex="-1" allow="autoplay; encrypted-media" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
        tubeFrame = tubeEl.querySelector('iframe');
        tubePlaying = true;
      } else if (tubeFrame && want !== tubePlaying) {
        tubePlaying = want;
        say(want ? 'playVideo' : 'pauseVideo');
      }
      tubeEl.classList.toggle('is-on', want && seen && !!tubeFrame);
    },
    /** Every frame while it shows: `corners` are the screen's, in the world — top left, top right, bottom right, bottom left. */
    track(camera: THREE.PerspectiveCamera, corners: THREE.Vector3[]) {
      if (!tubeFrame || corners.length < 4) return;
      const p: number[] = [];
      for (const c of corners) {
        corner.copy(c).project(camera);
        if (corner.z > 1) return void (tubeEl.style.visibility = 'hidden'); // behind the eye
        p.push((corner.x * 0.5 + 0.5) * innerWidth, (-corner.y * 0.5 + 0.5) * innerHeight);
      }
      tubeEl.style.visibility = '';
      // the projective map taking the unit square to the quad p0 p1 p2 p3
      const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
      const dx1 = x1 - x2;
      const dx2 = x3 - x2;
      const dx3 = x0 - x1 + x2 - x3;
      const dy1 = y1 - y2;
      const dy2 = y3 - y2;
      const dy3 = y0 - y1 + y2 - y3;
      const den = dx1 * dy2 - dx2 * dy1;
      const g = (dx3 * dy2 - dx2 * dy3) / den;
      const h = (dx1 * dy3 - dx3 * dy1) / den;
      const a = x1 - x0 + g * x1;
      const b = x3 - x0 + h * x3;
      const d = y1 - y0 + g * y1;
      const e = y3 - y0 + h * y3;
      tubeEl.style.transform = `matrix3d(${a / TW},${d / TW},0,${g / TW}, ${b / TH},${e / TH},0,${h / TH}, 0,0,1,0, ${x0},${y0},0,1)`;
    },
  };

  /* --- a sheet from the board, read up close --- */
  const workEl = $('.work');
  const workParts = { n: $('[data-work="n"]'), meta: $('[data-work="meta"]'), title: $('[data-work="title"]'), body: $('[data-work="body"]'), link: $<HTMLAnchorElement>('[data-work="link"]'), close: $('[data-work="close"]') };
  let shut: (() => void) | null = null;
  workParts.close.addEventListener('click', () => shut?.());
  addEventListener('keydown', (e) => e.key === 'Escape' && shut?.());
  const work = {
    open(w: Work, n: number, of: number, onClose: () => void) {
      shut = onClose;
      workParts.n.textContent = `${pad(n)} / ${pad(of)}`;
      workParts.meta.textContent = w.meta;
      workParts.title.textContent = w.title;
      workParts.body.textContent = w.body;
      workParts.link.hidden = !w.link;
      if (w.link) {
        workParts.link.textContent = w.link.label;
        workParts.link.href = w.link.href;
      }
      workEl.classList.add('is-on');
    },
    close() {
      shut = null;
      workEl.classList.remove('is-on');
    },
  };

  /* --- the telescope: a round field of view, and the chart's names set over the sky in it --- */
  const scopeEl = $('.scope');
  const skyEl = $('[data-scope="sky"]');
  const marks: { el: HTMLElement; dir: THREE.Vector3 }[] = [];
  const mark = new THREE.Vector3();
  const scope = {
    /** `names`: what to name, each with its direction in the sky; `star` names are set smaller than constellations' */
    chart(names: { dir: THREE.Vector3; text: string; star: boolean }[]) {
      skyEl.innerHTML = names.map((n) => `<span class="${n.star ? 'is-star' : ''}">${n.text}</span>`).join('');
      skyEl.querySelectorAll<HTMLElement>('span').forEach((el, i) => marks.push({ el, dir: names[i].dir }));
    },
    set(on: boolean) {
      scopeEl.classList.toggle('is-on', on);
    },
    /** Every frame while it is on: puts each name beside its star, inside the eyepiece's circle. */
    track(camera: THREE.PerspectiveCamera, clear = 1) {
      if (!scopeEl.classList.contains('is-on')) return;
      skyEl.style.opacity = clear.toFixed(2); // under cloud there are no stars to name
      const W = innerWidth;
      const H = innerHeight;
      const R = Math.min(W, H) * 0.42;
      for (const m of marks) {
        mark.copy(m.dir).multiplyScalar(1000).add(camera.position).project(camera);
        const x = (mark.x * 0.5 + 0.5) * W;
        const y = (-mark.y * 0.5 + 0.5) * H;
        const show = mark.z < 1 && Math.hypot(x - W / 2, y - H / 2) < R - 24;
        m.el.style.display = show ? '' : 'none';
        if (show) m.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      }
    },
  };

  /** `touring`: the stop the visitor is at (or heading for) while walking the house; null while the film runs. */
  function update(p: number, intro: number, touring: Stop | null = null) {
    blocks.forEach((blk, i) => {
      const chapter = i > 0 && i < blocks.length - 1;
      const e = blk.enter(p, intro);
      const x = blk.exit(p);
      // indoors the walk has captions of its own
      const on = e > 0.001 && x < 0.999 && !(touring && chapter);
      blk.el.classList.toggle('is-on', on);
      if (!on) return;
      const n = blk.parts.length;
      const stagger = 0.13;
      blk.parts.forEach((part, i) => {
        const t = easeOut(clamp((e - i * stagger) / (1 - (n - 1) * stagger)));
        if (part.dataset.part === 'line') {
          part.style.transform = `translate3d(0, ${((1 - t) * 108 - x * 108).toFixed(2)}%, 0)`;
        } else {
          part.style.opacity = (t * (1 - x)).toFixed(3);
          part.style.transform = `translate3d(0, ${((1 - t) * 18 - x * 22).toFixed(2)}px, 0)`;
        }
      });
      blk.el.style.setProperty('--scrim', (Math.min(e, 1 - x) * 1).toFixed(3));
    });

    // corner clock follows the sky
    let k = 0;
    while (k < clock.length - 2 && p > clock[k + 1][0]) k++;
    const mins = Math.round(lerp(clock[k][1], clock[k + 1][1], clamp((p - clock[k][0]) / (clock[k + 1][0] - clock[k][0])))) % 1440;
    const txt = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    if (txt !== shownClock) clockEl.textContent = shownClock = txt;

    // which chapter are we in
    let idx = 0;
    chapters.forEach((c, i) => {
      if (p >= c.at[0] - 0.03) idx = i + 1;
    });
    if (p >= outro.at) idx = total;
    if (touring) idx = touring.chapter;
    const name = touring ? touring.label : idx === 0 ? 'Prologue' : idx === total ? outro.label : chapters[idx - 1].label;
    if (idx !== shownIdx || name !== shownName) {
      shownIdx = idx;
      shownName = name;
      idxEl.textContent = pad(idx);
      nameEl.textContent = name;
      railBtns.forEach((b, i) => b.classList.toggle('is-current', i === idx - 1));
    }
    fill.style.transform = `scaleY(${p.toFixed(4)})`;
    hint.style.opacity = (intro * (1 - smoothstep(0.004, 0.03, p))).toFixed(3);
  }

  return {
    update,
    tour: {
      /** Shows a stop: what it is, and where one can go from it — `at` is where in the house each way's tag hangs. `choose` gets the way picked. */
      show(stop: Stop, at: [number, number, number][], choose: (to: Way['to']) => void) {
        pick = choose;
        tourParts.idx.textContent = pad(stop.chapter);
        tourParts.label.textContent = stop.label;
        tourParts.title.innerHTML = lines(stop.title);
        tourParts.body.textContent = stop.body;
        tourParts.hint.textContent = stop.hint ?? '';
        tourParts.ways.innerHTML = stop.ways
          .map(
            (w, i) =>
              `<button type="button" data-to="${w.to}" style="--i:${i}"><i class="ways__dot"></i><span class="ways__tag"><span class="ways__label">${w.label}</span></span></button>`,
          )
          .join('');
        spots.length = 0;
        tourParts.ways.querySelectorAll<HTMLButtonElement>('button').forEach((el, i) =>
          spots.push({ el, at: new THREE.Vector3(...at[i]), px: 0, py: 0, far: 1, near: 1, x: 0, y: 0, cx: 0, cy: 0, tx: 0, ty: 0, mix: 0, off: false, west: false, wide: 24 + el.querySelector<HTMLElement>('.ways__tag')!.offsetWidth }),
        );
        fresh = true;
        rects = null;
        // restart the reveal
        for (const el of [tourEl, tourParts.ways]) {
          el.classList.remove('is-on');
          void el.offsetWidth;
          el.classList.add('is-on');
        }
      },
      hide() {
        pick = null;
        tourEl.classList.remove('is-on');
        tourParts.ways.classList.remove('is-on');
      },
      track,
      /** Changes what one of the plates says (a thing done here has been done: the plate now offers to undo it). */
      relabel(to: Way['to'], label: string) {
        const el = tourParts.ways.querySelector<HTMLElement>(`button[data-to="${to}"] .ways__label`);
        const s = spots.find((p) => p.el.dataset.to === to);
        if (!el || !s) return;
        el.textContent = label;
        s.wide = 24 + el.parentElement!.offsetWidth;
      },
      /** the pointer is about to press a tag */
      get reaching() {
        return reaching;
      },
    },
    tube,
    work,
    scope,
    sound: $<HTMLButtonElement>('#sound'),
    progress(f: number, text: string) {
      bar.style.transform = `scaleX(${f})`;
      pct.textContent = String(Math.round(f * 100));
      label.textContent = text;
    },
    /** Shows the two doors and resolves with the one the visitor takes. */
    entrance() {
      loader.classList.add('is-ready');
      return new Promise<boolean>((resolve) => {
        loader.querySelectorAll<HTMLButtonElement>('[data-enter]').forEach((btn) =>
          btn.addEventListener('click', () => resolve(btn.dataset.enter === 'sound'), { once: true }),
        );
      });
    },
    setSound(on: boolean) {
      const btn = $<HTMLButtonElement>('#sound');
      btn.setAttribute('aria-pressed', String(on));
      btn.querySelector('b')!.textContent = on ? 'On' : 'Off';
    },
    reveal() {
      loader.classList.add('is-done');
      root.classList.add('is-live');
      setTimeout(() => loader.remove(), 1600);
    },
  };
}
