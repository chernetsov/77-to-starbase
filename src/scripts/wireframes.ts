import * as THREE from 'three';
import { loadCybertruck } from './hero3d/cybertruck';
import { buildStack } from './hero3d/starship';

// Hidden-line schematics for the Vehicles cards: crease edges as thin lines over a panel-coloured fill whose
// silhouette glows (smooth hulls like the booster have no crease edges to outline them).

const PANEL = new THREE.Color(0x0b0b0c);
const LINE = new THREE.Color(0xf2f2f2);
const RIM = new THREE.Color(0xc9ccd1);
const ACCENT = new THREE.Color(0xe8622c);

const fillMat = new THREE.ShaderMaterial({
  uniforms: { panel: { value: PANEL }, rim: { value: RIM } },
  vertexShader: /* glsl */ `
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      vec4 p = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal);
      vV = -p.xyz;
      gl_Position = projectionMatrix * p;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 panel;
    uniform vec3 rim;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
      gl_FragColor = vec4(panel + rim * f * 0.55, 1.0);
    }`,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});
const lineMat = new THREE.LineBasicMaterial({ color: LINE, transparent: true, opacity: 0.62 });

/** Rebuilds every visible mesh under `src` as fill + crease edges, flattened into one group in `src`'s frame. */
function schematic(src: THREE.Object3D, creaseDeg: number) {
  const out = new THREE.Group();
  const edges = new Map<THREE.BufferGeometry, THREE.EdgesGeometry>();
  const m = new THREE.Matrix4();
  src.updateMatrixWorld(true);
  const inv = src.matrixWorld.clone().invert();
  src.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || o.frustumCulled === false || !mesh.geometry.attributes.normal) return;
    const g = mesh.geometry;
    let e = edges.get(g);
    if (!e) edges.set(g, (e = new THREE.EdgesGeometry(g, creaseDeg)));
    const base = inv.clone().multiply(mesh.matrixWorld);
    const im = mesh as THREE.InstancedMesh;
    const n = im.isInstancedMesh ? im.count : 1;
    for (let i = 0; i < n; i++) {
      if (im.isInstancedMesh) im.getMatrixAt(i, m);
      else m.identity();
      const world = base.clone().multiply(m);
      const fill = new THREE.Mesh(g, fillMat);
      const line = new THREE.LineSegments(e, lineMat);
      for (const x of [fill, line]) {
        x.matrixAutoUpdate = false;
        x.matrix.copy(world);
        out.add(x);
      }
    }
  });
  return out;
}

/** Faint deck ring with heading ticks, sized to the model's footprint. */
function deck(radius: number) {
  const pts: THREE.Vector3[] = [];
  const seg = 96;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a0) * radius, 0, Math.sin(a0) * radius));
    pts.push(new THREE.Vector3(Math.cos(a1) * radius, 0, Math.sin(a1) * radius));
  }
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const k = i % 6 === 0 ? 0.88 : 0.95;
    pts.push(new THREE.Vector3(Math.cos(a) * radius * k, 0, Math.sin(a) * radius * k));
    pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  return new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.45 }),
  );
}

type Kind = 'truck' | 'stack';
const VIEW: Record<Kind, { elevation: number; fov: number; crease: number; spin: number }> = {
  truck: { elevation: 0.32, fov: 24, crease: 28, spin: 0.32 },
  stack: { elevation: 0.1, fov: 18, crease: 24, spin: 0.22 },
};

async function build(kind: Kind) {
  if (kind === 'truck') {
    const truck = await loadCybertruck();
    return truck.group;
  }
  return buildStack(null);
}

export async function mountWireframe(canvas: HTMLCanvasElement) {
  const kind = canvas.dataset.wire as Kind;
  const view = VIEW[kind];
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(view.fov, 1, 0.1, 2000);
  const pivot = new THREE.Group();
  scene.add(pivot);

  const model = schematic(await build(kind), view.crease);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3());
  // Spin the truck about its middle; the stack about its own axis (pins and raceway make its box lopsided).
  const axis = kind === 'truck' ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  model.position.set(-axis.x, -box.min.y, -axis.z);
  pivot.add(model);
  const footprint = Math.max(
    ...[box.min.x, box.max.x].flatMap((x) => [box.min.z, box.max.z].map((z) => Math.hypot(x - axis.x, z - axis.z))),
  );
  pivot.add(deck(footprint * 1.08));

  // Frame the bounding cylinder the model sweeps while spinning.
  const target = new THREE.Vector3(0, size.y / 2, 0);
  function frame() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const tanV = Math.tan(THREE.MathUtils.degToRad(view.fov / 2));
    const tanH = tanV * camera.aspect;
    const r = footprint * 1.08;
    const halfH = size.y / 2 + r * Math.sin(view.elevation);
    const dist = Math.max(halfH / tanV, r / tanH) * 1.02 + r * 0.4;    camera.position.set(0, target.y + Math.sin(view.elevation) * dist, Math.cos(view.elevation) * dist);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  }
  frame();

  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  pivot.rotation.y = kind === 'truck' ? -0.7 : 0.5;
  let visible = false;
  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!still) pivot.rotation.y += dt * view.spin;
    renderer.render(scene, camera);
  };
  const sync = () => {
    const run = visible && !document.hidden && !still;
    last = performance.now();
    renderer.setAnimationLoop(run ? loop : null);
    if (!run) renderer.render(scene, camera);
  };
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener('visibilitychange', sync);
  new ResizeObserver(() => {
    frame();
    renderer.render(scene, camera);
  }).observe(canvas);
  canvas.classList.add('ready');
}
