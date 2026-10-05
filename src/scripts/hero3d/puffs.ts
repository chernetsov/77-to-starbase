import * as THREE from 'three';
import { fbm } from './scenery';

/** A 2×2 atlas of soft, noisy puffs; the red channel is density. */
export function puffTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S * 2;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S * 2, S * 2);
  const smooth = THREE.MathUtils.smoothstep;
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * S;
    const oy = Math.floor(v / 2) * S;
    const seed = 3.7 + v * 17.3;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = ((x + 0.5) / S) * 2 - 1;
        const w = ((y + 0.5) / S) * 2 - 1;
        const r = Math.hypot(u, w);
        const lumps = fbm(u * 2.2 + seed, w * 2.2 - seed, 5);
        const body = 1 - smooth(r + (lumps - 0.5) * 0.6, 0.3, 0.92);
        const detail = fbm(u * 5.5 + seed * 2, w * 5.5 + seed, 4);
        const d = Math.min(1, body * (0.5 + 0.7 * detail)) * (1 - smooth(r, 0.82, 1));
        const i = ((oy + y) * S * 2 + ox + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(d * 255);
        img.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const vertexShader = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iA; // size, rotation, alpha, heat
  attribute vec2 iB; // atlas variant, shade
  uniform vec3 uFlamePos;
  uniform float uFlame;
  uniform vec2 uHaze;
  varying vec2 vUv;
  varying vec2 vP;
  varying float vAlpha;
  varying float vGlow;
  varying float vShade;
  varying float vHaze;
  void main() {
    float size = iA.x;
    vec4 mv = viewMatrix * vec4(iPos, 1.0);
    float c = cos(iA.y), s = sin(iA.y);
    vec2 q = position.xy;
    vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    mv.xy += r * size;
    vP = r * 2.0;
    vUv = (q + 0.5) * 0.5 + vec2(mod(iB.x, 2.0), floor(iB.x / 2.0)) * 0.5;
    float depth = -mv.z;
    // Fade puffs that swell past the camera instead of letting them fill the screen.
    vAlpha = iA.z * smoothstep(size * 0.2, size * 0.9, depth);
    vGlow = uFlame * exp(-distance(iPos, uFlamePos) / (24.0 + min(size, 50.0) * 0.5)) + iA.w;
    vShade = iB.y;
    vHaze = smoothstep(uHaze.x, uHaze.y, depth);
    gl_Position = projectionMatrix * mv;
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec3 uSunView;
  uniform vec3 uSunCol;
  uniform vec3 uShadowCol;
  uniform vec3 uGlowCol;
  uniform vec3 uHazeCol;
  varying vec2 vUv;
  varying vec2 vP;
  varying float vAlpha;
  varying float vGlow;
  varying float vShade;
  varying float vHaze;
  void main() {
    float d = texture2D(uTex, vUv).r;
    float a = d * vAlpha * (1.0 - vHaze * vHaze);
    if (a < 0.003) discard;
    // Light each sprite as a rough sphere so the sun side reads brighter.
    vec3 n = normalize(vec3(vP, sqrt(max(0.0, 1.0 - dot(vP, vP))) + 0.3));
    float lit = smoothstep(-0.35, 0.95, dot(n, uSunView));
    vec3 col = mix(uShadowCol, uSunCol, lit) * vShade * (0.84 + 0.16 * d);
    col += uGlowCol * vGlow * (0.3 + 0.7 * d);
    col = mix(col, uHazeCol, vHaze * 0.75);
    gl_FragColor = vec4(col, min(a, 1.0));
  }`;

/**
 * Camera-facing soft sprites, depth-sorted on the CPU each frame. Clouds and launch steam share one
 * system so they sort correctly against each other.
 */
export class Puffs {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  n = 0;
  private readonly sun: THREE.Vector3;
  private readonly data: Float32Array;
  private readonly depth: Float32Array;
  private readonly order: Uint32Array;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aA: THREE.InstancedBufferAttribute;
  private readonly aB: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(readonly max: number, tex: THREE.Texture, sunDir: THREE.Vector3) {
    this.sun = sunDir.clone();
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iA', this.aA);
    geo.setAttribute('iB', this.aB);
    geo.instanceCount = 0;
    this.geo = geo;
    this.data = new Float32Array(max * 9);
    this.depth = new Float32Array(max);
    this.order = new Uint32Array(max);
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTex: { value: tex },
        uSunView: { value: new THREE.Vector3() },
        uSunCol: { value: new THREE.Color(1.0, 0.96, 0.9) },
        uShadowCol: { value: new THREE.Color(0.6, 0.65, 0.74) },
        uGlowCol: { value: new THREE.Color(1.0, 0.52, 0.2) },
        uHazeCol: { value: new THREE.Color(0.76, 0.79, 0.84) },
        uHaze: { value: new THREE.Vector2(7000, 19000) },
        uFlamePos: { value: new THREE.Vector3() },
        uFlame: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  begin() {
    this.n = 0;
  }

  push(x: number, y: number, z: number, size: number, rot: number, alpha: number, heat: number, variant: number, shade: number) {
    if (this.n >= this.max || alpha <= 0.002) return;
    this.data.set([x, y, z, size, rot, alpha, heat, variant, shade], this.n * 9);
    this.n++;
  }

  setFlame(pos: THREE.Vector3, power: number) {
    this.material.uniforms.uFlamePos.value.copy(pos);
    this.material.uniforms.uFlame.value = power;
  }

  /** Sort back to front for this camera and upload. Call after the camera's final pose is set. */
  commit(camera: THREE.Camera) {
    const v = camera.matrixWorldInverse.elements;
    const { data, depth, order, n } = this;
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      depth[i] = v[2] * data[o] + v[6] * data[o + 1] + v[10] * data[o + 2] + v[14];
      order[i] = i;
    }
    // View-space z is negative in front of the camera, so ascending z is far to near.
    order.subarray(0, n).sort((a, b) => depth[a] - depth[b]);
    const p = this.aPos.array as Float32Array;
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const o = order[k] * 9;
      p[k * 3] = data[o];
      p[k * 3 + 1] = data[o + 1];
      p[k * 3 + 2] = data[o + 2];
      A[k * 4] = data[o + 3];
      A[k * 4 + 1] = data[o + 4];
      A[k * 4 + 2] = data[o + 5];
      A[k * 4 + 3] = data[o + 6];
      B[k * 2] = data[o + 7];
      B[k * 2 + 1] = data[o + 8];
    }
    this.aPos.needsUpdate = this.aA.needsUpdate = this.aB.needsUpdate = true;
    this.geo.instanceCount = n;
    this.material.uniforms.uSunView.value.copy(this.sun).transformDirection(camera.matrixWorldInverse);
  }
}
