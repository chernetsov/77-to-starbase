import * as THREE from 'three';
import { fbm } from './scenery';

/**
 * A 4×2 atlas of billowing puffs. Red is density; green and blue are the surface normal (x, y) of a lumpy dome
 * over it, so each sprite is lit by its own billows rather than as a smooth ball. Variants 0–3 (steam) have
 * fairly crisp, finely crinkled edges like the cauliflower boundaries of fresh steam; 4–7 (cloud) are denser,
 * with billows and creases inside the outline as well.
 */
export function puffTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S * 4;
  c.height = S * 2;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S * 4, S * 2);
  const smooth = THREE.MathUtils.smoothstep;
  const dens = new Float32Array(S * S);
  const height = new Float32Array(S * S);
  for (let v = 0; v < 8; v++) {
    const cloud = v >= 4;
    const ox = (v % 4) * S;
    // The texture is flipped on upload, so the atlas row in uv space is the opposite canvas row.
    const oy = (1 - Math.floor(v / 4)) * S;
    const seed = 3.7 + v * 17.3;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = ((x + 0.5) / S) * 2 - 1;
        const w = ((y + 0.5) / S) * 2 - 1;
        const r = Math.hypot(u, w);
        // Billows: big lobes bulge the outline, smaller ones crinkle it.
        const lobes = fbm(u * 2.0 + seed, w * 2.0 - seed, 3);
        const crinkle = fbm(u * 7 + seed * 2, w * 7 + seed, 3);
        const edge = r + (lobes - 0.5) * 0.7 + (crinkle - 0.5) * (cloud ? 0.035 : 0.08);
        const body = cloud ? 1 - smooth(edge, 0.36, 0.7) : 1 - smooth(edge, 0.5, 0.66);
        const detail = fbm(u * 5 + seed * 3, w * 5 - seed, 4);
        const k = y * S + x;
        dens[k] = Math.min(1, body * (cloud ? 1.05 + 0.1 * detail : 0.7 + 0.45 * detail)) * (1 - smooth(r, 0.86, 1));
        // Clouds bulge into separate billows inside the outline too, with creases between them.
        height[k] = smooth(edge, 0.1, 0.66) * -0.6 + (cloud ? 0.55 * lobes + 0.06 * crinkle : 0.35 * lobes);
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
        const i = ((oy + y) * S * 4 + ox + x) * 4;
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

/** Floats per puff: position, iA, iB, iC (stretch, base, depth, haze scale), iD (cloud centre and extents), sun depth. */
const STRIDE = 18;

const vertexShader = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iA; // size, rotation, alpha, heat
  attribute vec3 iB; // atlas variant, shade, cloud in front of it toward the sun (m)
  attribute vec4 iC; // horizontal stretch, cloud base height (0 for none), cloud depth, haze distance scale
  attribute vec4 iD; // cloud centre x, z and half width, half depth (0 for none)
  uniform vec3 uFlamePos;
  uniform float uFlame;
  uniform float uHaze;
  uniform vec3 uUpView;
  varying vec4 vUvP;
  varying vec3 vRotH;
  varying vec3 vRight;
  varying vec3 vUp;
  varying vec3 vBack;
  varying vec3 vToFlame;
  varying vec3 vWorld;
  varying vec4 vA; // alpha, glow, shade, haze
  varying vec4 vB; // base, grade, size, cloud base height
  varying vec4 vCloud;
  varying vec3 vSun;
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
    vec2 q = position.xy;
    vec2 r = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
    vec3 off = (right * r.x * iC.x + up * r.y) * size;
    mv.xyz += off;
    vRight = right;
    vUp = up;
    vBack = back;
    vWorld = iPos + (vec4(off, 0.0) * viewMatrix).xyz;
    vec2 uv = (q + 0.5) * vec2(0.25, 0.5) + vec2(mod(iB.x, 4.0) * 0.25, floor(iB.x / 4.0) * 0.5);
    vUvP = vec4(uv, r * 2.0);
    vRotH = vec3(c, s, iC.z * 1.25);
    float depth = -mv.z;
    // Fade puffs that swell past the camera instead of letting them fill the screen.
    float alpha = iA.z * smoothstep(size * 0.2, size * 0.9, depth);
    float glow = uFlame * exp(-distance(iPos, uFlamePos) / (36.0 + min(size, 50.0) * 0.6)) + iA.w;
    vToFlame = (viewMatrix * vec4(uFlamePos, 1.0)).xyz - mv.xyz;
    // Aerial perspective over the cloud's true distance (far clouds are drawn nearer, scaled down).
    float haze = 1.0 - exp(-depth * iC.w / uHaze);
    vA = vec4(alpha, glow, iB.y, haze);
    // Height above the cloud base, in base-softening widths; seen from below, the base is a face, not an edge.
    float wy = vWorld.y;
    float side = 1.0 - smoothstep(0.45, 0.8, abs(dot(back, uUpView)));
    float base = iC.y > 0.0 ? mix(1e3, (wy - iC.y) / max(3.0, size * 0.06), side) : 1e3;
    float grade = iC.y > 0.0 ? clamp((wy - iC.y) / max(1.0, iC.z), 0.0, 1.0) : 1.0;
    vB = vec4(base, grade, size, iC.y);
    vCloud = iD;
    // How far inside its cloud's outline this puff sits as seen from here: 0 on the rim, 1 in the middle.
    float inner = 0.0;
    if (iD.z > 0.0) {
      vec3 v = iPos - vec3(iD.x, iC.y + iC.z * 0.6, iD.y);
      vec3 ray = normalize(iPos - cameraPosition);
      vec3 across = v - ray * dot(v, ray);
      float e = length(across / vec3(iD.z, iC.z * 0.75, iD.w));
      inner = 1.0 - smoothstep(0.45, 0.92, e);
    }
    vSun = vec3(iB.z, iC.w, inner);
    gl_Position = projectionMatrix * mv;
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec3 uSunView;
  uniform vec3 uSunWorld;
  uniform vec3 uUpView;
  uniform vec3 uSunCol;
  uniform vec3 uSteamSunCol;
  uniform vec3 uShadowCol;
  uniform vec3 uSkyCol;
  uniform vec3 uGroundCol;
  uniform vec3 uGlowCol;
  uniform vec3 uHazeCol;
  uniform vec3 uBaseShade;
  uniform float uSelfShadow;
  uniform float uSigma;
  uniform float uSunPower;
  uniform float uAmbient;
  uniform float uPowder;
  uniform float uExposure;
  float hg(float mu, float g) { return (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5); }
  varying vec4 vUvP;
  varying vec3 vRotH;
  varying vec3 vRight;
  varying vec3 vUp;
  varying vec3 vBack;
  varying vec3 vToFlame;
  varying vec3 vWorld;
  varying vec4 vA;
  varying vec4 vB;
  varying vec4 vCloud;
  varying vec3 vSun;
  void main() {
    vec4 t = texture2D(uTex, vUvP.xy);
    float d = t.r;
    float haze = vA.w;
    // Puffs inside a cloud's outline are fainter and softer-edged, so the layers behind blend into one body.
    float a = d * (1.0 - 0.55 * vSun.z * (1.0 - d)) * mix(1.0, 0.95, vSun.z) * vA.x * (1.0 - 0.6 * haze * haze) * smoothstep(0.0, 1.0, vB.x);
    if (a < 0.003) discard;
    // The billows' normal, turned with the sprite, over the rough sphere of the whole puff.
    vec2 b = t.gb * 2.0 - 1.0;
    b = vec2(vRotH.x * b.x - vRotH.y * b.y, vRotH.y * b.x + vRotH.x * b.y);
    // Cloud lobes shade as full balls; steam as flatter, lumpier puffs.
    vec2 sph = vUvP.zw * (vCloud.z > 0.0 ? 0.85 : 0.55);
    vec2 nl = sph + b * (vCloud.z > 0.0 ? 0.15 * (1.0 - vSun.z) : 0.5);
    float bulge = sqrt(max(0.05, 1.0 - dot(sph, sph)));
    vec3 n = normalize(vRight * nl.x + vUp * nl.y + vBack * bulge);
    float ndl = dot(n, uSunView);
    float lit = smoothstep(-0.3, 0.9, ndl);
    vec3 col;
    if (vCloud.z > 0.0) {
      // Sunlight through the cloud: how much cloud lies toward the sun from here. A smooth ellipsoid over the
      // whole cloud plus what the puffs in front of this one block (baked when the cloud is built).
      vec3 p = vWorld + normalize(cameraPosition - vWorld) * vB.z * 0.35 * bulge;
      vec3 R = vec3(vCloud.z, vRotH.z, vCloud.w);
      vec3 q = (p - vec3(vCloud.x, vB.w, vCloud.y)) / R;
      vec3 sd = uSunWorld / R;
      float A = dot(sd, sd), B = dot(q, sd), C = dot(q, q) - 1.0;
      float disc = B * B - A * C;
      float root = disc > 0.0 ? sqrt(disc) : 0.0;
      float through = disc > 0.0 ? max(0.0, (-B + root) / A - max(0.0, (-B - root) / A)) : 0.0;
      // Inside the outline, shade by the cloud's rounded body more than by each lump.
      vec3 body = normalize((viewMatrix * vec4(normalize(q / R), 0.0)).xyz);
      n = normalize(mix(n, body, vSun.z * 0.9));
      ndl = dot(n, uSunView);
      // Plus the lobe's own body: a point on its shadow side looks at the sun through the rest of the lobe.
      float own = vB.z * 0.45 * clamp(0.5 - 0.5 * ndl, 0.0, 1.0);
      // The baked per-puff depth steps from puff to puff, so inner puffs lean on it less.
      float depthSun = (through * uSelfShadow + vSun.x * 0.45 * (1.0 - 0.6 * vSun.z) + own) * vSun.y;
      // Multiple scattering as a few ever softer, wider-spread octaves of single scattering (Wrenninge;
      // Hillaire 2016), so shadowed parts glow instead of going grey, and edges toward the sun shine.
      float mu = dot(-vBack, uSunView);
      float ms = 0.0, amp = 1.0, ext = 1.0, ecc = 1.0;
      for (int i = 0; i < 4; i++) {
        // Two lobes: forward (silver linings) and a weaker backward one, so a cloud lit from behind the
        // viewer is still bright (Frostbite's dual-lobe phase).
        ms += amp * exp(-uSigma * ext * depthSun) * mix(hg(mu, 0.6 * ecc), hg(mu, -0.3 * ecc), 0.35);
        amp *= 0.38; ext *= 0.4; ecc *= 0.5;
      }
      // Powder (Schneider 2015): the sun-facing skin has had little cloud to scatter light into it yet.
      float powder = 1.0 - uPowder * exp(-uSigma * 3.0 * (depthSun + vB.z * 0.3 * d));
      float lobe = mix(0.45, 1.0, smoothstep(-0.25, 0.7, ndl));
      float upness = dot(n, uUpView) * 0.35 + 0.5;
      vec3 amb = mix(mix(uSkyCol, uGroundCol, 0.4), uSkyCol, upness) * mix(0.5, 1.0, smoothstep(0.0, 0.8, vB.y));
      col = uSunCol * ms * lobe * powder * uSunPower + amb * uAmbient;
      // Roll highlights off toward white the way film does, instead of clipping one channel.
      col = 1.0 - exp(-col * uExposure);
    } else {
      // Dense cores on the shadow side are where the sun has the most cloud to get through.
      float shadowed = (1.0 - lit) * (0.35 + 0.65 * d);
      vec3 sky = mix(uGroundCol, uSkyCol, dot(n, uUpView) * 0.5 + 0.5);
      col = uSteamSunCol * lit * (1.0 - 0.25 * d * (1.0 - lit)) + mix(uShadowCol, sky, 0.5) * (0.62 - 0.22 * shadowed);
      // Sun behind the steam: thin edges light up (forward scattering).
      float mu = -uSunView.z;
      float g = 0.65;
      float phase = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) * 0.08;
      col += uSteamSunCol * phase * (1.0 - d) * 1.6;
    }
    // Cumulus go grey toward their flat bases, where the cloud above shades them.
    col *= vA.z * (0.86 + 0.14 * d) * mix(uBaseShade, vec3(1.0), smoothstep(0.0, 0.75, vB.y));
    // Fire light falls on the side of each puff facing the flame.
    float facing = 0.35 + 0.65 * max(0.0, dot(n, normalize(vToFlame)));
    // Saturates toward the fire's colour rather than burning out to white.
    col += uGlowCol * (1.0 - exp(-vA.y * facing * (0.5 + 0.8 * d))) * 0.8;
    col = mix(col, uHazeCol, haze * 0.8);
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
  private readonly aD: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(readonly max: number, tex: THREE.Texture, sunDir: THREE.Vector3) {
    this.sun = sunDir.clone();
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.attributes.position);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iA', this.aA);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aD = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iB', this.aB);
    geo.setAttribute('iC', this.aC);
    geo.setAttribute('iD', this.aD);
    geo.instanceCount = 0;
    this.geo = geo;
    this.data = new Float32Array(max * STRIDE);
    this.depth = new Float32Array(max);
    this.order = new Uint32Array(max);
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTex: { value: tex },
        uSunView: { value: new THREE.Vector3() },
        uSunWorld: { value: this.sun },
        uSelfShadow: { value: 0.4 },
        uSigma: { value: 0.007 },
        uSunPower: { value: 2.4 },
        uAmbient: { value: 0.5 },
        uPowder: { value: 0.3 },
        uExposure: { value: 1.6 },
        uUpView: { value: new THREE.Vector3() },
        uSunCol: { value: new THREE.Color(1.3, 0.8, 0.45) },
        uSteamSunCol: { value: new THREE.Color(1.12, 0.8, 0.54) },
        uShadowCol: { value: new THREE.Color(0.34, 0.36, 0.54) },
        uSkyCol: { value: new THREE.Color(0.38, 0.52, 0.82) },
        uGroundCol: { value: new THREE.Color(0.62, 0.52, 0.42) },
        uGlowCol: { value: new THREE.Color(0.95, 0.5, 0.16) },
        uBaseShade: { value: new THREE.Color(0.5, 0.55, 0.68) },
        uHazeCol: { value: new THREE.Color(0.88, 0.76, 0.66) },
        uHaze: { value: 32000 },
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

  /**
   * `stretch` widens the puff horizontally. For a cloud puff, `cloud` is the cloud it belongs to: its flat base
   * height, the depth above that greys toward it, its centre and half extents (for self-shadowing), and how
   * much farther it really is than drawn (for haze).
   */
  push(x: number, y: number, z: number, size: number, rot: number, alpha: number, heat: number, variant: number, shade: number, stretch = 1, cloud?: ArrayLike<number>) {
    if (this.n >= this.max || alpha <= 0.002) return;
    const d = this.data;
    const o = this.n * STRIDE;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = size; d[o + 4] = rot; d[o + 5] = alpha; d[o + 6] = heat;
    d[o + 7] = variant; d[o + 8] = shade; d[o + 9] = stretch;
    if (cloud) for (let k = 0; k < 8; k++) d[o + 10 + k] = cloud[k];
    else d.fill(0, o + 10, o + 18);
    if (!cloud) d[o + 12] = 1;
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
      const o = i * STRIDE;
      depth[i] = v[2] * data[o] + v[6] * data[o + 1] + v[10] * data[o + 2] + v[14];
      order[i] = i;
    }
    // View-space z is negative in front of the camera, so ascending z is far to near.
    order.subarray(0, n).sort((a, b) => depth[a] - depth[b]);
    const p = this.aPos.array as Float32Array;
    const A = this.aA.array as Float32Array;
    const B = this.aB.array as Float32Array;
    const C = this.aC.array as Float32Array;
    const D = this.aD.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const o = order[k] * STRIDE;
      p[k * 3] = data[o];
      p[k * 3 + 1] = data[o + 1];
      p[k * 3 + 2] = data[o + 2];
      A[k * 4] = data[o + 3];
      A[k * 4 + 1] = data[o + 4];
      A[k * 4 + 2] = data[o + 5];
      A[k * 4 + 3] = data[o + 6];
      B[k * 3] = data[o + 7];
      B[k * 3 + 1] = data[o + 8];
      B[k * 3 + 2] = data[o + 17];
      C[k * 4] = data[o + 9];
      C[k * 4 + 1] = data[o + 10];
      C[k * 4 + 2] = data[o + 11];
      C[k * 4 + 3] = data[o + 12];
      D[k * 4] = data[o + 13];
      D[k * 4 + 1] = data[o + 14];
      D[k * 4 + 2] = data[o + 15];
      D[k * 4 + 3] = data[o + 16];
    }
    this.aPos.needsUpdate = this.aA.needsUpdate = this.aB.needsUpdate = this.aC.needsUpdate = this.aD.needsUpdate = true;
    this.geo.instanceCount = n;
    this.material.uniforms.uSunView.value.copy(this.sun).transformDirection(camera.matrixWorldInverse);
    this.material.uniforms.uUpView.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
  }
}
