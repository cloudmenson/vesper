import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BloomPass } from './bloom';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/** Lens pass: a touch of chromatic fringe, vignette and film grain, plus the fade used by the intro. */
const LensShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uFade: { value: 1 },
    uCA: { value: 0.0016 },
    uVignette: { value: 0.42 },
    uGrain: { value: 0.035 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uFade, uCA, uVignette, uGrain;
    varying vec2 vUv;
    float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec2 c = vUv - 0.5;
      vec2 off = c * dot(c, c) * uCA * 4.0;
      vec3 col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      float v = smoothstep(0.92, 0.2, length(c * vec2(1.0, 1.12)));
      col *= mix(1.0, v, uVignette);
      float g = hash(gl_FragCoord.xy + fract(uTime) * 517.0) - 0.5;
      col += g * uGrain * (1.0 - 0.6 * dot(col, vec3(0.299, 0.587, 0.114)));
      gl_FragColor = vec4(col * uFade, 1.0);
    }
  `,
};

export function createPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  o: { samples: number },
) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: o.samples });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new BloomPass(1.0, 0.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const lens = new ShaderPass(LensShader);
  composer.addPass(lens);

  return { composer, bloom, lens: lens.uniforms };
}
