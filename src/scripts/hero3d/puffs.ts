import * as THREE from 'three';
import { fbm } from './scenery';

/**
 * A 2×2 atlas of billowing puffs. Red is density; green and blue are the surface normal (x, y) of a lumpy dome
 * over it, so each sprite is lit by its own billows rather than as a smooth ball. Edges are fairly crisp, like
 * the cauliflower boundaries of real steam and cumulus, with fine lumps along them.
 */
export function puffTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S * 2;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S * 2, S * 2);
  const smooth = THREE.MathUtils.smoothstep;
  const dens = new Float32Array(S * S);
  const height = new Float32Array(S * S);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * S;
    const oy = Math.floor(v / 2) * S;
    const seed = 3.7 + v * 17.3;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = ((x + 0.5) / S) * 2 - 1;
        const w = ((y + 0.5) / S) * 2 - 1;
        const r = Math.hypot(u, w);
        // Billows: big lobes bulge the outline, smaller ones crinkle it.
        const lobes = fbm(u * 2.0 + seed, w * 2.0 - seed, 3);
        const crinkle = fbm(u * 7 + seed * 2, w * 7 + seed, 3);
        const edge = r + (lobes - 0.5) * 0.7 + (crinkle - 0.5) * 0.08;
        const body = 1 - smooth(edge, 0.5, 0.66);
        const detail = fbm(u * 5 + seed * 3, w * 5 - seed, 4);
        const k = y * S + x;
        dens[k] = Math.min(1, body * (0.7 + 0.45 * detail)) * (1 - smooth(r, 0.86, 1));
        height[k] = smooth(edge, 0.1, 0.66) * -0.6 + 0.35 * lobes;
      }
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const k = y * S + x;
        const hx = height[y * S + Math.min(S - 1, x + 1)] - height[y * S + Math.max(0, x - 1)];
        const hy = height[Math.min(S - 1, y + 1) * S + x] - height[Math.max(0, y - 1) * S + x];
        // Image rows run down while the sprite's y runs up, hence the flip on y.
        let nx = -hx * S * 0.05, ny = hy * S * 0.05;
        const l = Math.hypot(nx, ny, 1);
        nx /= l;
        ny /= l;
        const i = ((oy + y) * S * 2 + ox + x) * 4;
        img.data[i] = Math.round(dens[k] * 255);
        img.data[i + 1] = Math.round((nx * 0.5 + 0.5) * 255);
        img.data[i + 2] = Math.round((ny * 0.5 + 0.5) * 255);
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
  attribute vec3 iC; // horizontal stretch, cloud base height (0 for none), cloud depth
  uniform vec3 uFlamePos;
  uniform float uFlame;
  uniform vec2 uHaze;
  uniform vec3 uUpView;
  varying vec2 vUv;
  varying vec2 vP;
  varying vec2 vRot;
  varying vec3 vRight;
  varying vec3 vUp;
  varying vec3 vBack;
  varying float vAlpha;
  varying float vGlow;
  varying vec3 vToFlame;
  varying float vShade;
  varying float vHaze;
  varying float vBase;
  varying float vGrad;
  void main() {
    float size = iA.x;
    vec4 mv = viewMatrix * vec4(iPos, 1.0);
    // Face the camera along the ray to the puff but stay upright to the world, so the sky turns with
    // the view instead of sticking to the screen when the camera looks up and pans.
    vec3 back = normalize(-mv.xyz);
    vec3 up = uUpView - back * dot(uUpView, back);
    up = length(up) < 0.02 ? normalize(cross(back, vec3(1.0, 0.0, 0.0))) : normalize(up);
    vec3 right = cross(up, back);
    float c = cos(iA.y), s = sin(iA.y);
    vRot = vec2(c, s);
    vec2 q = position.xy;
    vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    vec3 off = (right * r.x * iC.x + up * r.y) * size;
    mv.xyz += off;
    vRight = right;
    vUp = up;
    vBack = back;
    vP = r * 2.0;
    vUv = (q + 0.5) * 0.5 + vec2(mod(iB.x, 2.0), floor(iB.x / 2.0)) * 0.5;
    float depth = -mv.z;
    // Fade puffs that swell past the camera instead of letting them fill the screen.
    vAlpha = iA.z * smoothstep(size * 0.2, size * 0.9, depth);
    vGlow = uFlame * exp(-distance(iPos, uFlamePos) / (36.0 + min(size, 50.0) * 0.6)) + iA.w;
    vToFlame = (viewMatrix * vec4(uFlamePos, 1.0)).xyz - mv.xyz;
    vShade = iB.y;
    vHaze = smoothstep(uHaze.x, uHaze.y, depth);
    // Height above the cloud base, in base-softening widths; seen from below, the base is a face, not an edge.
    float wy = iPos.y + dot(off, uUpView);
    float side = 1.0 - smoothstep(0.45, 0.8, abs(dot(back, uUpView)));
    vBase = iC.y > 0.0 ? mix(1e3, (wy - iC.y) / max(6.0, size * 0.06), side) : 1e3;
    vGrad = iC.y > 0.0 ? clamp((wy - iC.y) / max(1.0, iC.z), 0.0, 1.0) : 1.0;
    gl_Position = projectionMatrix * mv;
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec3 uSunView;
  uniform vec3 uUpView;
  uniform vec3 uSunCol;
  uniform vec3 uShadowCol;
  uniform vec3 uSkyCol;
  uniform vec3 uGroundCol;
  uniform vec3 uGlowCol;
  uniform vec3 uHazeCol;
  uniform vec3 uBaseShade;
  varying vec2 vUv;
  varying vec2 vP;
  varying vec2 vRot;
  varying vec3 vRight;
  varying vec3 vUp;
  varying vec3 vBack;
  varying float vAlpha;
  varying float vGlow;
  varying vec3 vToFlame;
  varying float vShade;
  varying float vHaze;
  varying float vBase;
  varying float vGrad;
  void main() {
    vec4 t = texture2D(uTex, vUv);
    float d = t.r;
    float a = d * vAlpha * (1.0 - vHaze * vHaze) * smoothstep(0.0, 1.0, vBase);
    if (a < 0.003) discard;
    // The billows' normal, turned with the sprite, over the rough sphere of the whole puff.
    vec2 b = t.gb * 2.0 - 1.0;
    b = vec2(vRot.x * b.x - vRot.y * b.y, vRot.y * b.x + vRot.x * b.y);
    vec2 sph = vP * 0.55;
    vec2 nl = sph + b * 0.5;
    vec3 n = normalize(vRight * nl.x + vUp * nl.y + vBack * sqrt(max(0.05, 1.0 - dot(sph, sph))));
    float ndl = dot(n, uSunView);
    float lit = smoothstep(-0.3, 0.9, ndl);
    // Dense cores on the shadow side are where the sun has the most cloud to get through.
    float shadowed = (1.0 - lit) * (0.35 + 0.65 * d);
    vec3 sky = mix(uGroundCol, uSkyCol, dot(n, uUpView) * 0.5 + 0.5);
    vec3 col = uSunCol * lit * (1.0 - 0.25 * d * (1.0 - lit)) + mix(uShadowCol, sky, 0.5) * (0.62 - 0.22 * shadowed);
    // Sun behind the cloud: thin edges light up (forward scattering).
    float mu = -uSunView.z;
    float g = 0.65;
    float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.08;
    col += uSunCol * phase * (1.0 - d) * 1.6;
    // Cumulus go grey toward their flat bases, where the cloud above shades them.
    col *= vShade * (0.86 + 0.14 * d) * mix(uBaseShade, vec3(1.0), smoothstep(0.0, 0.75, vGrad));
    // Fire light falls on the side of each puff facing the flame.
    float facing = 0.35 + 0.65 * max(0.0, dot(n, normalize(vToFlame)));
    // Saturates toward the fire's colour rather than burning out to white.
    col += uGlowCol * (1.0 - exp(-vGlow * facing * (0.5 + 0.8 * d))) * 0.8;
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
  private readonly aC: THREE.InstancedBufferAttribute;
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
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iB', this.aB);
    geo.setAttribute('iC', this.aC);
    geo.instanceCount = 0;
    this.geo = geo;
    this.data = new Float32Array(max * 12);
    this.depth = new Float32Array(max);
    this.order = new Uint32Array(max);
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTex: { value: tex },
        uSunView: { value: new THREE.Vector3() },
        uUpView: { value: new THREE.Vector3() },
        uSunCol: { value: new THREE.Color(1.0, 0.84, 0.66) },
        uShadowCol: { value: new THREE.Color(0.42, 0.46, 0.58) },
        uSkyCol: { value: new THREE.Color(0.5, 0.62, 0.8) },
        uGroundCol: { value: new THREE.Color(0.62, 0.52, 0.42) },
        uGlowCol: { value: new THREE.Color(0.95, 0.5, 0.16) },
        uBaseShade: { value: new THREE.Color(0.62, 0.66, 0.76) },
        uHazeCol: { value: new THREE.Color(0.88, 0.76, 0.66) },
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

  /** `stretch` widens the puff horizontally; a cloud `base` above 0 flattens its underside, greying over `depth` above it. */
  push(x: number, y: number, z: number, size: number, rot: number, alpha: number, heat: number, variant: number, shade: number, stretch = 1, base = 0, depth = 0) {
    if (this.n >= this.max || alpha <= 0.002) return;
    this.data.set([x, y, z, size, rot, alpha, heat, variant, shade, stretch, base, depth], this.n * 12);
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
      const o = i * 12;
      depth[i] = v[2] * data[o] + v[6] * data[o + 1] + v[10] * data[o + 2] + v[14];
      order[i] = i;
    }
    // View-space z is negative in front of the camera, so ascending z is far to near.
    order.subarray(0, n).sort((a, b) => depth[a] - depth[b]);
    const p = this.aPos.array as Float32Array;
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const o = order[k] * 12;
      p[k * 3] = data[o];
      p[k * 3 + 1] = data[o + 1];
      p[k * 3 + 2] = data[o + 2];
      A[k * 4] = data[o + 3];
      A[k * 4 + 1] = data[o + 4];
      A[k * 4 + 2] = data[o + 5];
      A[k * 4 + 3] = data[o + 6];
      B[k * 2] = data[o + 7];
      B[k * 2 + 1] = data[o + 8];
      C[k * 3] = data[o + 9];
      C[k * 3 + 1] = data[o + 10];
      C[k * 3 + 2] = data[o + 11];
    }
    this.aPos.needsUpdate = this.aA.needsUpdate = this.aB.needsUpdate = this.aC.needsUpdate = true;
    this.geo.instanceCount = n;
    this.material.uniforms.uSunView.value.copy(this.sun).transformDirection(camera.matrixWorldInverse);
    this.material.uniforms.uUpView.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
  }
}
