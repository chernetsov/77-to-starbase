import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const vertexShader = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/**
 * Draws a layer of clouds through a blur that only acts where the cloud is solid: the inside of each cloud
 * melts into one smooth body while its outline, where the cloud thins out, stays as sharp as drawn.
 * Render the clouds' own scene through `render`, over whatever is already in the target.
 */
export class CloudBlur {
  /** Blur radius in pixels at full resolution. */
  radius = 7;
  private readonly full: THREE.WebGLRenderTarget;
  private readonly half: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly blur: FullScreenQuad;
  private readonly comp: FullScreenQuad;
  private readonly clear = new THREE.Color();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const opts = { type: THREE.HalfFloatType };
    this.full = new THREE.WebGLRenderTarget(1, 1, opts);
    this.half = [new THREE.WebGLRenderTarget(1, 1, opts), new THREE.WebGLRenderTarget(1, 1, opts)];
    this.blur = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
        vertexShader,
        fragmentShader: /* glsl */ `
          uniform sampler2D tSrc;
          uniform vec2 uStep;
          varying vec2 vUv;
          void main() {
            // Nine-tap Gaussian on premultiplied colour, so transparent sky never bleeds in as black.
            vec4 s = texture2D(tSrc, vUv) * 0.2270;
            s += (texture2D(tSrc, vUv + uStep * 1.385) + texture2D(tSrc, vUv - uStep * 1.385)) * 0.3162;
            s += (texture2D(tSrc, vUv + uStep * 3.231) + texture2D(tSrc, vUv - uStep * 3.231)) * 0.0703;
            gl_FragColor = s;
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.comp = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: { tSharp: { value: this.full.texture }, tSoft: { value: this.half[0].texture } },
        vertexShader,
        fragmentShader: /* glsl */ `
          uniform sampler2D tSharp;
          uniform sampler2D tSoft;
          varying vec2 vUv;
          void main() {
            vec4 sharp = texture2D(tSharp, vUv);
            vec4 soft = texture2D(tSoft, vUv);
            // Solid all around (the blurred coverage is still near 1): take the smooth colour.
            float inside = smoothstep(0.86, 0.99, soft.a) * smoothstep(0.9, 1.0, sharp.a);
            vec3 soft3 = soft.rgb / max(soft.a, 1e-4) * sharp.a;
            gl_FragColor = vec4(mix(sharp.rgb, soft3, inside), sharp.a);
          }`,
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  setSize(width: number, height: number) {
    this.full.setSize(width, height);
    for (const t of this.half) t.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
  }

  render(clouds: THREE.Object3D, camera: THREE.Camera) {
    const r = this.renderer;
    const target = r.getRenderTarget();
    const autoClear = r.autoClear;
    const alpha = r.getClearAlpha();
    r.getClearColor(this.clear);
    r.setRenderTarget(this.full);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(clouds, camera);

    const blur = this.blur.material as THREE.ShaderMaterial;
    const step = (this.radius / 3.231) * 0.5;
    const [a, b] = this.half;
    blur.uniforms.tSrc.value = this.full.texture;
    blur.uniforms.uStep.value.set(step / a.width, 0);
    r.setRenderTarget(b);
    this.blur.render(r);
    blur.uniforms.tSrc.value = b.texture;
    blur.uniforms.uStep.value.set(0, step / a.height);
    r.setRenderTarget(a);
    this.blur.render(r);

    r.setClearColor(this.clear, alpha);
    r.setRenderTarget(target);
    r.autoClear = false;
    this.comp.render(r);
    r.autoClear = autoClear;
  }
}
