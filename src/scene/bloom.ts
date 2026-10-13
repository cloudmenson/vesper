import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** 13 taps in a pattern that leaves no gaps between neighbouring samples: a bright dot fades between pixels instead of popping. */
const TAPS = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 uPx;
  varying vec2 vUv;
  #define T(x, y) texture2D(tSrc, vUv + uPx * vec2(x, y)).rgb
  float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

const PREFILTER = /* glsl */ `
  ${TAPS}
  uniform float uThreshold, uKnee;
  // what of a colour is bright enough to glow, with a soft shoulder instead of a cliff at the threshold
  vec3 bright(vec3 c){
    c = min(c, vec3(24.0));
    float b = max(c.r, max(c.g, c.b));
    float soft = clamp(b - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    return c * max(soft, b - uThreshold) / max(b, 1e-4);
  }
  void main(){
    vec3 a = T(-2., 2.), b = T(0., 2.), c = T(2., 2.), d = T(-2., 0.), e = T(0., 0.), f = T(2., 0.), g = T(-2., -2.), h = T(0., -2.), i = T(2., -2.);
    vec3 j = T(-1., 1.), k = T(1., 1.), l = T(-1., -1.), m = T(1., -1.);
    // five overlapping boxes, each weighed down by its own brightness: one hot pixel cannot carry a whole box
    vec3 g0 = bright((a + b + d + e) * 0.25), g1 = bright((b + c + e + f) * 0.25), g2 = bright((d + e + g + h) * 0.25), g3 = bright((e + f + h + i) * 0.25), g4 = bright((j + k + l + m) * 0.25);
    float w0 = 0.125 / (1.0 + luma(g0)), w1 = 0.125 / (1.0 + luma(g1)), w2 = 0.125 / (1.0 + luma(g2)), w3 = 0.125 / (1.0 + luma(g3)), w4 = 0.5 / (1.0 + luma(g4));
    gl_FragColor = vec4((g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
  }
`;

const DOWN = /* glsl */ `
  ${TAPS}
  void main(){
    vec3 a = T(-2., 2.), b = T(0., 2.), c = T(2., 2.), d = T(-2., 0.), e = T(0., 0.), f = T(2., 0.), g = T(-2., -2.), h = T(0., -2.), i = T(2., -2.);
    vec3 j = T(-1., 1.), k = T(1., 1.), l = T(-1., -1.), m = T(1., -1.);
    gl_FragColor = vec4(e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125, 1.0);
  }
`;

/** tent-filtered upsample of the smaller level, blended with the level it lands on */
const UP = /* glsl */ `
  ${TAPS}
  uniform sampler2D tBase;
  uniform float uMix;
  void main(){
    vec3 s = T(0., 0.) * 4.0 + (T(-1., 0.) + T(1., 0.) + T(0., -1.) + T(0., 1.)) * 2.0 + T(-1., -1.) + T(1., -1.) + T(-1., 1.) + T(1., 1.);
    gl_FragColor = vec4(mix(texture2D(tBase, vUv).rgb, s * 0.0625, uMix), 1.0);
  }
`;

const COMPOSITE = /* glsl */ `
  uniform sampler2D tSrc, tBloom;
  uniform float uStrength;
  varying vec2 vUv;
  void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength, 1.0); }
`;

/**
 * Glow round bright things. A pyramid of ever smaller, ever softer copies of what is brighter than `threshold`,
 * built with filters that do not alias: the usual bloom lets a lamp one pixel wide flash as it crosses pixel edges.
 */
export class BloomPass extends Pass {
  strength = 1;
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private quad = new FullScreenQuad();
  private mats: Record<'prefilter' | 'down' | 'up' | 'composite', THREE.ShaderMaterial>;

  constructor(
    threshold = 1,
    knee = 0.5,
    private levels = 6,
    spread = 0.62,
  ) {
    super();
    const make = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.mats = {
      prefilter: make(PREFILTER, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() }, uThreshold: { value: threshold }, uKnee: { value: knee } }),
      down: make(DOWN, { tSrc: { value: null }, uPx: { value: new THREE.Vector2() } }),
      up: make(UP, { tSrc: { value: null }, tBase: { value: null }, uPx: { value: new THREE.Vector2() }, uMix: { value: spread } }),
      composite: make(COMPOSITE, { tSrc: { value: null }, tBloom: { value: null }, uStrength: { value: 1 } }),
    };
    for (let i = 0; i < levels; i++) {
      const o = { type: THREE.HalfFloatType, depthBuffer: false };
      this.down.push(new THREE.WebGLRenderTarget(1, 1, o));
      if (i < levels - 1) this.up.push(new THREE.WebGLRenderTarget(1, 1, o));
    }
  }

  setSize(width: number, height: number) {
    let w = Math.max(1, Math.ceil(width / 2));
    let h = Math.max(1, Math.ceil(height / 2));
    for (let i = 0; i < this.levels; i++) {
      this.down[i].setSize(w, h);
      this.up[i]?.setSize(w, h);
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
  }

  private draw(renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const { prefilter, down, up, composite } = this.mats;
    prefilter.uniforms.tSrc.value = readBuffer.texture;
    prefilter.uniforms.uPx.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    this.draw(renderer, prefilter, this.down[0]);
    for (let i = 1; i < this.levels; i++) {
      down.uniforms.tSrc.value = this.down[i - 1].texture;
      down.uniforms.uPx.value.set(1 / this.down[i - 1].width, 1 / this.down[i - 1].height);
      this.draw(renderer, down, this.down[i]);
    }
    let small = this.down[this.levels - 1];
    for (let i = this.levels - 2; i >= 0; i--) {
      up.uniforms.tSrc.value = small.texture;
      up.uniforms.tBase.value = this.down[i].texture;
      up.uniforms.uPx.value.set(1 / small.width, 1 / small.height);
      this.draw(renderer, up, this.up[i]);
      small = this.up[i];
    }
    composite.uniforms.tSrc.value = readBuffer.texture;
    composite.uniforms.tBloom.value = small.texture;
    composite.uniforms.uStrength.value = this.strength;
    this.draw(renderer, composite, this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    for (const t of [...this.down, ...this.up]) t.dispose();
    for (const m of Object.values(this.mats)) m.dispose();
    this.quad.dispose();
  }
}
