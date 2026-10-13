import { lerp, smoothstep } from './core/math';

const BASE = `${import.meta.env.BASE_URL}assets/audio/`;
const LAYERS = ['lake', 'night', 'wind', 'fire', 'dawn', 'music', 'music2', 'rain', 'steps', 'stairs'] as const;
/** sounds that happen once: a fish rising, a needle set down on a record */
const SHOTS = ['splash', 'needle'] as const;
type Layer = (typeof LAYERS)[number];

/** Plays a recording forever by cross-fading each pass into the next, so the join is never heard. */
class Loop {
  private next = 0;

  constructor(
    private ctx: AudioContext,
    private buffer: AudioBuffer,
    private out: AudioNode,
    private overlap: number,
    /** silence between passes — the music breathes before it starts again */
    private gap = 0,
  ) {}

  private play(at: number, offset = 0) {
    const { ctx, buffer, overlap } = this;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const env = ctx.createGain();
    const length = buffer.duration - offset;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(1, at + Math.min(overlap, length / 3));
    env.gain.setValueAtTime(1, at + length - overlap);
    env.gain.linearRampToValueAtTime(0, at + length);
    src.connect(env).connect(this.out);
    src.start(at, offset);
    src.stop(at + length + 0.1);
    this.next = at + length - overlap + this.gap;
  }

  start(randomOffset: boolean) {
    this.play(this.ctx.currentTime + 0.05, randomOffset ? Math.random() * this.buffer.duration * 0.5 : 0);
  }

  /** call a few times a second */
  tick() {
    if (this.ctx.currentTime > this.next - 1.5) this.play(Math.max(this.next, this.ctx.currentTime + 0.05));
  }
}

/**
 * The soundtrack: field recordings of the lake, the night forest, wind, a wood fire and a dawn chorus,
 * mixed by where the camera is — plus Satie's first Gymnopédie underneath.
 */
export class Ambience {
  on = false;
  private ctx?: AudioContext;
  private master!: GainNode;
  private outdoors!: BiquadFilterNode;
  private gains = {} as Record<Layer, GainNode>;
  private loops: Loop[] = [];
  private loading?: Promise<void>;
  private noise!: AudioBuffer;
  private shots = {} as Record<(typeof SHOTS)[number], AudioBuffer>;
  private doorWas = 0;
  private skyWas = 0;

  private async load() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    // everything that lives outside passes through one filter: walls and glass take the top off it
    this.outdoors = ctx.createBiquadFilter();
    this.outdoors.type = 'lowpass';
    this.outdoors.frequency.value = 18000;
    this.outdoors.connect(this.master);

    const buffers = await Promise.all(
      LAYERS.map(async (name) => ctx.decodeAudioData(await (await fetch(`${BASE}${name}.mp3`)).arrayBuffer())),
    );
    LAYERS.forEach((name, i) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      // (what is heard in the room itself goes straight out; the weather comes through the walls)
      g.connect(name === 'lake' || name === 'night' || name === 'wind' || name === 'dawn' ? this.outdoors : this.master);
      this.gains[name] = g;
      const tune = name === 'music' || name === 'music2';
      const loop = tune ? new Loop(ctx, buffers[i], g, 0.5, 6) : new Loop(ctx, buffers[i], g, name === 'steps' || name === 'stairs' ? 1.2 : 3.5);
      loop.start(!tune);
      this.loops.push(loop);
    });
    window.setInterval(() => this.on && this.loops.forEach((l) => l.tick()), 400);
    await Promise.all(SHOTS.map(async (name) => (this.shots[name] = await ctx.decodeAudioData(await (await fetch(`${BASE}${name}.mp3`)).arrayBuffer()))));

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Must be called from a click: browsers only start audio on a user gesture. */
  async enable(on: boolean) {
    this.on = on;
    if (on && !this.loading) this.loading = this.load();
    if (!this.loading) return;
    await this.loading;
    const ctx = this.ctx!;
    if (this.on) await ctx.resume();
    this.master.gain.setTargetAtTime(this.on ? 1 : 0, ctx.currentTime, this.on ? 1.2 : 0.3);
    if (!this.on) window.setTimeout(() => !this.on && void ctx.suspend(), 1500);
  }

  /** Plays one of the single sounds, once. */
  play(name: (typeof SHOTS)[number], level = 0.6) {
    if (!this.ctx || !this.on || !this.shots[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.shots[name];
    const g = this.ctx.createGain();
    g.gain.value = level;
    src.connect(g).connect(this.master);
    src.start();
  }

  /** The glass sliding in its track: a short band of noise swept upward. */
  private whoosh(level: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(260, t);
    band.frequency.exponentialRampToValueAtTime(900, t + 1.1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 1.5);
    src.connect(band).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 1.6);
  }

  /**
   * Mix follows the film: open air → the room and its fire → the quiet loft → open air at dawn.
   * `walk`, while the visitor is walking the house: how far out of doors they are, and how near the fire bowl (both 0–1).
   * `gust`: how hard the wind is blowing just now (0–1), as the trees show it.
   * `more`: what else is going on — rain (0–1), the visitor walking (`stride`) or on the stair (`climb`), the record
   * playing, a log just put on the fire (`stoked`, 1 fading to 0).
   */
  update(p: number, walk: { open: number; fireside: number } | null = null, gust = 0.5, more: { rain?: number; stride?: number; climb?: number; record?: boolean; stoked?: number } = {}) {
    if (!this.ctx || !this.on || !this.gains.music) return;
    const t = this.ctx.currentTime;
    let inside = smoothstep(0.27, 0.335, p) * (1 - smoothstep(0.862, 0.9, p));
    if (walk) inside = Math.min(inside, 1 - walk.open);
    const upstairs = smoothstep(0.66, 0.75, p);
    const dawn = smoothstep(0.875, 0.95, p);
    const nearFire = smoothstep(0.3, 0.4, p) * (1 - smoothstep(0.5, 0.62, p));
    const skylight = smoothstep(0.838, 0.88, p);
    const set = (name: Layer, v: number, tau = 0.35) => this.gains[name].gain.setTargetAtTime(v, t, tau);

    // the lake is a murmur at the edge of hearing, not surf: quiet outside, all but gone behind glass, stiller yet at dawn
    set('lake', lerp(0.3, lerp(0.03, skylight * 0.05, upstairs), inside) * (1 - dawn * 0.45));
    set('night', (1 - dawn) * lerp(0.5, lerp(0.16, 0.05 + skylight * 0.3, upstairs), inside));
    // the wind in the spruce: never loud, a little more of it as each gust leans the trees
    set('wind', lerp(0.34, 0.04 + skylight * 0.12, inside) * (1 - dawn * 0.5) * (0.7 + 0.6 * gust), 0.6);
    set('dawn', dawn * 0.75, 0.8);
    // the bowl on the terrace as you arrive, the hearth once you are in, embers by morning
    const hearth = lerp(0.1 * (1 - smoothstep(0.2, 0.27, p)) + 0.06, 0.22 + 0.78 * nearFire, inside) * (1 - upstairs * 0.88);
    // (the fires are out by morning; a fresh log makes one speak up for a few seconds)
    set('fire', Math.max(hearth, (walk?.fireside ?? 0) * 0.85) * (1 - dawn) * (1 + 0.8 * (more.stoked ?? 0)));
    // one tune at a time: the house's own, or the record on the player
    const tune = 0.62 + inside * 0.14;
    set('music', more.record ? 0 : tune, 1.0);
    set('music2', more.record ? tune * 0.95 : 0, 1.0);
    // rain is on the roof and the glass: louder under them than out in it
    set('rain', (more.rain ?? 0) * lerp(0.45, 0.62, inside), 0.9);
    // the visitor's own feet: boards on the level, the treads of the stair
    set('steps', (more.stride ?? 0) * 0.42, 0.12);
    set('stairs', (more.climb ?? 0) * 0.5, 0.15);
    this.outdoors.frequency.setTargetAtTime(lerp(18000, lerp(4200, 1100 + skylight * 5000, upstairs), inside), t, 0.3);

    const door = p > 0.25 ? 1 : 0;
    const sky = p > 0.858 ? 1 : 0;
    if (door !== this.doorWas && Math.abs(p - 0.25) < 0.05) this.whoosh(0.07);
    if (sky !== this.skyWas && Math.abs(p - 0.858) < 0.05) this.whoosh(0.05);
    this.doorWas = door;
    this.skyWas = sky;
  }
}
