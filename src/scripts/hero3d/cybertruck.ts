import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// "Tesla Cybertruck" by Sketcher (jnanbr07) (https://sketchfab.com/3d-models/tesla-cybertruck-587a0833e60f465090145b139f6c1bfc),
// CC BY 4.0. Optimized copy in public/models; the source faces -x with the axles as two meshes.
export const CYBERTRUCK_LENGTH = 5.683;

export interface Cybertruck {
  group: THREE.Group;
  /** Axle pivots; positive rotation.z rolls the truck forward (toward +x). */
  wheels: THREE.Object3D[];
  wheelRadius: number;
  length: number;
  /** Fades in the spin-blur discs for a wheel turning at `omega` rad/s. */
  setSpin(omega: number): void;
}

/** A spinning wheel seen at speed: spokes smear into a dark rim with a soft highlight ring, the tread into a band. */
function spinBlurTexture() {
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const c = S / 2;
  const ring = (r0: number, r1: number, color: string) => {
    ctx.beginPath();
    ctx.arc(c, c, r1 * c, 0, Math.PI * 2);
    ctx.arc(c, c, r0 * c, 0, Math.PI * 2, true);
    ctx.fillStyle = color;
    ctx.fill();
  };
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  const stops: [number, string][] = [
    [0, 'rgba(70,72,76,1)'],
    [0.1, 'rgba(46,48,52,1)'],
    [0.16, 'rgba(18,19,21,1)'],
    [0.38, 'rgba(26,27,30,1)'],
    [0.48, 'rgba(64,66,70,1)'],
    [0.56, 'rgba(30,31,34,1)'],
    [0.62, 'rgba(20,21,23,1)'],
    [0.65, 'rgba(58,60,64,1)'],
    [0.68, 'rgba(26,26,28,1)'],
    [0.9, 'rgba(32,32,34,1)'],
    [0.95, 'rgba(44,44,46,0.9)'],
    [1, 'rgba(40,40,42,0)'],
  ];
  for (const [t, col] of stops) g.addColorStop(t, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // Faint concentric streaks from the tread blocks and sidewall lettering.
  for (let k = 0; k < 14; k++) {
    const r = 0.7 + Math.random() * 0.22;
    ring(r, r + 0.004 + Math.random() * 0.006, `rgba(70,70,74,${0.15 + Math.random() * 0.2})`);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** The tread at speed: knobs smear into grooves running around the tire (v runs across the tread). */
function treadBlurTexture() {
  const W = 8;
  const H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    const edge = Math.min(v, 1 - v);
    const shoulder = THREE.MathUtils.smoothstep(edge, 0, 0.12);
    const groove = 0.75 + 0.25 * Math.cos(v * Math.PI * 9) + (Math.random() - 0.5) * 0.15;
    const l = Math.round(24 + 22 * groove * shoulder);
    ctx.fillStyle = `rgba(${l},${l},${l + 2},${0.35 + 0.65 * shoulder})`;
    ctx.fillRect(0, y, W, 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function isDescendant(o: THREE.Object3D, ancestor: THREE.Object3D) {
  for (let p = o.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

export function cybertruckUrl() {
  return `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}models/cybertruck.glb`;
}

export async function loadCybertruck(url = cybertruckUrl(), onProgress?: (e: ProgressEvent) => void): Promise<Cybertruck> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, onProgress);
  const model = gltf.scene;

  // Frame the model in meters with the nose toward +x, centered on x/z and sitting on y = 0.
  const inner = new THREE.Group();
  inner.add(model);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  inner.scale.setScalar(CYBERTRUCK_LENGTH / size.x);
  inner.rotation.y = Math.PI;
  inner.updateMatrixWorld(true);

  const wheels: THREE.Object3D[] = [];
  let wheelRadius = 0.45;
  const blurMat = new THREE.MeshStandardMaterial({
    map: spinBlurTexture(),
    transparent: true,
    opacity: 0,
    roughness: 0.55,
    metalness: 0.35,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const treadMat = blurMat.clone();
  treadMat.map = treadBlurTexture();
  treadMat.side = THREE.DoubleSide;
  treadMat.roughness = 0.85;
  treadMat.metalness = 0;
  const blurDiscs: THREE.Mesh[] = [];
  const TIRE_W = 0.3;
  // Each axle is split into tread, sidewall, and rim nodes that share a name prefix (three.js suffixes duplicates).
  for (const name of ['axle_front', 'axle_rear']) {
    const parts: THREE.Object3D[] = [];
    model.traverse((o) => {
      if (o.name.startsWith(name) && !parts.some((p) => isDescendant(o, p))) parts.push(o);
    });
    if (!parts.length) continue;
    const b = new THREE.Box3();
    for (const p of parts) b.union(new THREE.Box3().setFromObject(p, true));
    const s = b.getSize(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.position.copy(b.getCenter(new THREE.Vector3()));
    pivot.position.y = b.min.y + s.x / 2;
    inner.worldToLocal(pivot.position);
    inner.add(pivot);
    pivot.updateMatrixWorld(true);
    for (const p of parts) pivot.attach(p);
    wheels.push(pivot);
    wheelRadius = s.x / 2;
    // A disc just outside each outer sidewall; the axle spans the full track along z.
    const unit = 1 / inner.scale.x;
    const disc = new THREE.CircleGeometry(wheelRadius * unit * 1.005, 48);
    const band = new THREE.CylinderGeometry(wheelRadius * unit * 1.012, wheelRadius * unit * 1.012, TIRE_W * unit, 64, 1, true).rotateX(Math.PI / 2);
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(disc, blurMat);
      m.position.z = side * (s.z / 2 + 0.006) * unit;
      if (side < 0) m.rotation.y = Math.PI;
      const tread = new THREE.Mesh(band, treadMat);
      tread.position.z = side * (s.z / 2 - TIRE_W / 2) * unit;
      for (const o of [m, tread]) {
        o.visible = false;
        o.renderOrder = 1;
        pivot.add(o);
        blurDiscs.push(o);
      }
    }
  }

  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat.name.startsWith('Light_W')) {
      mat.emissive = new THREE.Color(0xf4f7ff);
      mat.emissiveIntensity = 6;
    } else if (mat.name.startsWith('Light_R')) {
      mat.emissive = new THREE.Color(0xff1a12);
      mat.emissiveIntensity = 4;
    } else if (mat.name.startsWith('Glass')) {
      mesh.castShadow = false;
      // Factory privacy tint: dark, still glossy enough to pick up the sky.
      mat.color = new THREE.Color(0x0b0d10);
      mat.map = null;
      mat.transparent = true;
      mat.opacity = 0.82;
      mat.metalness = 0.2;
      mat.roughness = 0.05;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
  });

  const group = new THREE.Group();
  group.name = 'cybertruck';
  group.add(inner);
  // Blur grows with wheel speed but stays a veil over the real rim: at highway speed (~60 rad/s) the spokes
  // still show through. Eased per call so speed spikes don't pop it.
  let blur = 0;
  const setSpin = (omega: number) => {
    const target = 0.55 * THREE.MathUtils.clamp((Math.abs(omega) - 3) / 57, 0, 1);
    blur += (target - blur) * 0.12;
    if (blur < 0.004) blur = 0;
    blurMat.opacity = treadMat.opacity = blur;
    for (const d of blurDiscs) d.visible = blur > 0;
  };
  return { group, wheels, wheelRadius, length: CYBERTRUCK_LENGTH, setSpin };
}
