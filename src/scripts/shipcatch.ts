import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  buildMount,
  buildStack,
  buildTower,
  R,
  RAIL_TOP,
  SHIP_H,
  SHIP_LIFT_PIN_Y,
  TOWER_OFFSET,
  type Tower,
} from './hero3d/starship';

/**
 * Terminal ship-catch, at the same true scale as the hero (52.1 m ship, 146 m tower).
 *
 * Profile, compressed only by starting in the last few hundred metres:
 * - Belly-flop / skydiver: heat shield down, ~12° nose-up, falling in from the Gulf (world +x,
 *   east). Suborbital hops and every orbital flight through Flight 14 flipped from this attitude.
 * - Flip and landing burn: three sea-level Raptors (the ship’s landing engines; the vac bells stay
 *   dark) rotate it tail-down to vertical in a few seconds. Flight 5’s booster did the analogous
 *   burn from about a kilometre, 13 engines then 3, then translated into the arms.
 * - Catch: the chopsticks close on the lifting pins just under the forward flaps (this model’s
 *   pins are 1.1 m below the flap root) and the engines cut so the ship drops onto the rails.
 *   That drop-on, not a hover-and-place, is how Booster 12 was caught on Oct 13, 2024.
 *   The tower stands south of the mount, so the pins face ±x, into the rails.
 *
 * Musk, X Takeover, Oct 10 2026: the next flight will try this, booster catches are already
 * proven, and a success would be the first full recovery of an orbital-class rocket.
 * Not a SpaceX plan — NASASpaceflight, Oct 9 2026: neither catch is confirmed for Flight 15,
 * and a ship catch would need an FAA license change.
 *
 * `?catch=<0..1>` holds the sequence for stills. The clock runs only while the canvas is on screen.
 */

export const CATCH_DUR = 22;

const T = { bellyEnd: 7.4, flipEnd: 10.2, arrive: 15.2, caught: 16.3 };
const PIVOT_Y = SHIP_H * 0.46;
const BASE_Y = 46;
const HOVER = 0.65;
/** Same yaw the stacked ship uses, which turns the pin azimuth out to world ±x. */
const CAUGHT_YAW = 0.55;
const AOA = THREE.MathUtils.degToRad(12);

type Key = { t: number; p: THREE.Vector3; v: THREE.Vector3 };

const PATH: Key[] = [
  { t: 0, p: new THREE.Vector3(168, 250, 14), v: new THREE.Vector3(0, 0, 0) },
  { t: T.bellyEnd, p: new THREE.Vector3(54, 104, 0), v: new THREE.Vector3(-15, -16, -1.4) },
  { t: T.flipEnd, p: new THREE.Vector3(13, BASE_Y + PIVOT_Y + HOVER, 0), v: new THREE.Vector3(-7, -2.2, 0) },
  { t: T.arrive, p: new THREE.Vector3(0, BASE_Y + PIVOT_Y + HOVER, 0), v: new THREE.Vector3(0, -0.35, 0) },
  { t: T.caught, p: new THREE.Vector3(0, BASE_Y + PIVOT_Y, 0), v: new THREE.Vector3(0, 0, 0) },
  { t: CATCH_DUR, p: new THREE.Vector3(0, BASE_Y + PIVOT_Y, 0), v: new THREE.Vector3(0, 0, 0) },
];

const CAM: Key[] = [
  { t: 0, p: new THREE.Vector3(118, 42, 96), v: new THREE.Vector3() },
  { t: T.bellyEnd, p: new THREE.Vector3(18, 26, 78), v: new THREE.Vector3() },
  { t: 11.6, p: new THREE.Vector3(30, 32, -28), v: new THREE.Vector3() },
  { t: T.caught, p: new THREE.Vector3(26, 54, -22), v: new THREE.Vector3() },
  { t: CATCH_DUR, p: new THREE.Vector3(22, 60, -18), v: new THREE.Vector3() },
];
const AIM: Key[] = [
  { t: 0, p: new THREE.Vector3(148, 200, 8), v: new THREE.Vector3() },
  { t: T.bellyEnd, p: new THREE.Vector3(42, 96, 0), v: new THREE.Vector3() },
  { t: 11.6, p: new THREE.Vector3(6, 74, 0), v: new THREE.Vector3() },
  { t: T.caught, p: new THREE.Vector3(0, 78, 3), v: new THREE.Vector3() },
  { t: CATCH_DUR, p: new THREE.Vector3(-1, 82, 2), v: new THREE.Vector3() },
];

function stitch(keys: Key[]) {
  for (let i = 1; i < keys.length - 1; i++) {
    const dt = keys[i + 1].t - keys[i - 1].t;
    keys[i].v.copy(keys[i + 1].p).sub(keys[i - 1].p).divideScalar(dt).multiplyScalar(0.82);
  }
}
stitch(CAM);
stitch(AIM);

/** Quintic Hermite, zero acceleration at both ends. Same blend the hero camera uses. */
function hermite(out: THREE.Vector3, p0: THREE.Vector3, v0: THREE.Vector3, p1: THREE.Vector3, v1: THREE.Vector3, span: number, u: number) {
  const u3 = u * u * u;
  const u4 = u3 * u;
  const u5 = u4 * u;
  const h5 = 10 * u3 - 15 * u4 + 6 * u5;
  return out
    .copy(p0)
    .multiplyScalar(1 - h5)
    .addScaledVector(v0, (u - 6 * u3 + 8 * u4 - 3 * u5) * span)
    .addScaledVector(p1, h5)
    .addScaledVector(v1, (-4 * u3 + 7 * u4 - 3 * u5) * span);
}

function sampleKeys(keys: Key[], t: number, out: THREE.Vector3) {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const u = THREE.MathUtils.clamp((t - a.t) / span, 0, 1);
  return hermite(out, a.p, a.v, b.p, b.v, span, u);
}

const bellyQ = new THREE.Quaternion();
const caughtQ = new THREE.Quaternion();
{
  const nose = new THREE.Vector3(-Math.cos(AOA), Math.sin(AOA), 0);
  const flank = new THREE.Vector3(0, 0, 1);
  const leeward = new THREE.Vector3().crossVectors(nose, flank);
  bellyQ.setFromRotationMatrix(new THREE.Matrix4().makeBasis(leeward, nose, flank));
  caughtQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), CAUGHT_YAW);
}

const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const camPos = new THREE.Vector3();
const camAim = new THREE.Vector3();
const pivot = new THREE.Vector3();

export function catchPhase(t: number) {
  if (t < T.bellyEnd) return 'Belly flop';
  if (t < T.flipEnd) return 'Flip';
  if (t < T.arrive - 0.15) return 'Landing burn';
  if (t < T.caught) return 'Catch';
  return 'Caught';
}

function enginePower(t: number) {
  const on = THREE.MathUtils.smootherstep(t, T.bellyEnd, T.bellyEnd + 0.4);
  const off = THREE.MathUtils.smootherstep(t, T.arrive - 0.55, T.arrive + 0.05);
  return on * (1 - off);
}

function armsOpen(t: number) {
  const eased = THREE.MathUtils.lerp(0.82, 0.2, THREE.MathUtils.smootherstep(t, T.flipEnd + 1.2, T.arrive - 0.35));
  return THREE.MathUtils.lerp(eased, 0, THREE.MathUtils.smootherstep(t, T.arrive - 0.2, T.arrive + 0.5));
}

function heatAmount(t: number) {
  return 1 - THREE.MathUtils.smootherstep(t, T.bellyEnd - 0.4, T.flipEnd);
}

const plumeVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vView;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const plumeFragment = /* glsl */ `
  uniform float uTime;
  uniform float uPower;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vView;
  void main() {
    float along = 1.0 - vUv.y;
    float rim = abs(dot(vNormalV, vView));
    float flicker = 0.86 + 0.14 * sin(uTime * 47.0 + vUv.y * 28.0);
    float a = pow(rim, 1.15) * pow(1.0 - along, 1.35) * flicker * uPower;
    gl_FragColor = vec4(uColor * a * 2.4, a);
  }
`;

function makePlumeMaterial(color: number) {
  return new THREE.ShaderMaterial({
    vertexShader: plumeVertex,
    fragmentShader: plumeFragment,
    uniforms: {
      uTime: { value: 0 },
      uPower: { value: 0 },
      uColor: { value: new THREE.Color(color) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function holdFraction() {
  const raw = new URLSearchParams(location.search).get('catch');
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? THREE.MathUtils.clamp(n, 0, 1) : null;
}

export async function mountShipCatch(canvas: HTMLCanvasElement) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const held = holdFraction();
  const stage = canvas.closest('.catch-stage');
  const phaseEl = stage?.querySelector<HTMLElement>('[data-catch-phase]');
  const fadeEl = stage?.querySelector<HTMLElement>('[data-catch-fade]');
  const replay = stage?.querySelector<HTMLButtonElement>('[data-catch-replay]');

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0x87a0b8, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.62;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setSize(canvas.clientWidth || 960, canvas.clientHeight || 540, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.4, 40000);

  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(84.5), THREE.MathUtils.degToRad(67));
  const skyVals = { turbidity: 9, rayleigh: 3.1, mieCoefficient: 0.008, mieDirectionalG: 0.88 };
  const sky = new Sky();
  sky.scale.setScalar(20000);
  for (const [k, v] of Object.entries(skyVals)) sky.material.uniforms[k].value = v;
  sky.material.uniforms.sunPosition.value.copy(sunDir);
  sky.material.uniforms.cloudCoverage.value = 0;
  scene.add(sky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  for (const [k, v] of Object.entries(skyVals)) envSky.material.uniforms[k].value = v;
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.cloudCoverage.value = 0;
  envScene.add(envSky);
  const envGround = new THREE.Mesh(new THREE.CircleGeometry(900, 24), new THREE.MeshBasicMaterial({ color: 0x8f7356 }));
  envGround.rotation.x = -Math.PI / 2;
  envGround.position.y = -2;
  envScene.add(envGround);
  const env = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  scene.environment = env;
  const haze = new THREE.Color(0xc9a788);
  scene.fog = new THREE.FogExp2(haze, 0.00022);
  scene.add(new THREE.HemisphereLight(0x9fb2d4, 0x7a5a3c, 0.66));
  const sun = new THREE.DirectionalLight(0xffb878, 3.3);
  sun.position.copy(sunDir).multiplyScalar(800);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6000, 48),
    new THREE.MeshStandardMaterial({ color: 0x8a7d68, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);
  const gulf = new THREE.Mesh(
    new THREE.PlaneGeometry(5000, 5000),
    new THREE.MeshStandardMaterial({ color: 0x8eabbc, metalness: 0.45, roughness: 0.16 }),
  );
  gulf.rotation.x = -Math.PI / 2;
  gulf.position.set(80 + 2500, -0.2, 0);
  scene.add(gulf);

  scene.add(buildMount(env));
  const tower: Tower = buildTower(env);
  tower.group.position.set(0, 0, TOWER_OFFSET);
  tower.group.rotation.y = Math.PI / 2;
  scene.add(tower.group);

  const stack = buildStack(env);
  const ship = stack.getObjectByName('ship')!;
  ship.removeFromParent();
  const shipMats = new Set<THREE.Material>();
  ship.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) if (mat) shipMats.add(mat);
  });
  stack.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) if (mat && !shipMats.has(mat)) mat.dispose();
  });
  scene.add(ship);

  const plumeMats = [makePlumeMaterial(0xfff4d2), makePlumeMaterial(0xff9a3c)];
  const plumes = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const a = Math.PI + (i / 3) * Math.PI * 2;
    const x = Math.cos(a) * 0.95;
    const z = Math.sin(a) * 0.95;
    for (const [mat, len, r0, r1] of [
      [plumeMats[0], 14, 0.28, 0.7],
      [plumeMats[1], 26, 0.45, 1.35],
    ] as const) {
      const geo = new THREE.CylinderGeometry(r0, r1, len, 20, 1, true);
      geo.translate(0, -len / 2, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, 0.35, z);
      mesh.frustumCulled = false;
      plumes.add(mesh);
    }
  }
  ship.add(plumes);
  const burn = new THREE.PointLight(0xffb070, 0, 90, 2);
  burn.position.set(0, -1.2, 0);
  ship.add(burn);

  const heatMat = new THREE.MeshBasicMaterial({
    color: 0xff5a28,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const heat = new THREE.Mesh(new THREE.PlaneGeometry(SHIP_H * 0.62, R * 2.4), heatMat);
  heat.position.set(-(R + 0.55), SHIP_H * 0.42, 0);
  heat.rotation.y = Math.PI / 2;
  heat.frustumCulled = false;
  ship.add(heat);

  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if ((mat as THREE.MeshStandardMaterial)?.isMeshStandardMaterial && !mat.transparent) {
        (mat as THREE.MeshStandardMaterial).envMapIntensity = 1.7;
      }
    }
  });

  const carriageY = BASE_Y + SHIP_LIFT_PIN_Y - RAIL_TOP;
  let clock = held !== null ? held * CATCH_DUR : reduce ? T.caught + 0.4 : 0;
  let playing = held === null && !reduce;
  let once = false;
  let shown = '';
  let visible = false;

  const apply = (t: number) => {
    sampleKeys(PATH, t, pivot);
    const spin = THREE.MathUtils.smootherstep(t, T.bellyEnd, T.flipEnd);
    tmpQ.copy(bellyQ).slerp(caughtQ, spin);
    ship.quaternion.copy(tmpQ);
    tmpV.set(0, PIVOT_Y, 0).applyQuaternion(tmpQ);
    ship.position.copy(pivot).sub(tmpV);

    const power = enginePower(t);
    plumes.visible = power > 0.02;
    for (const mat of plumeMats) {
      mat.uniforms.uTime.value = t;
      mat.uniforms.uPower.value = power;
    }
    burn.intensity = power * 420;
    heatMat.opacity = heatAmount(t) * 0.42;
    tower.setPose({
      carriageY,
      holdX: TOWER_OFFSET,
      holdZ: 0,
      armsOpen: armsOpen(t),
      qdArm: 1,
    });

    sampleKeys(CAM, t, camPos);
    sampleKeys(AIM, t, camAim);
    const aspect = camera.aspect;
    if (aspect < 1.45) {
      const pull = aspect < 1.05 ? 1.34 : 1.16;
      camPos.addScaledVector(tmpV.copy(camPos).sub(camAim), pull - 1);
    }
    camera.position.copy(camPos);
    camera.lookAt(camAim);

    const phase = catchPhase(t);
    if (phaseEl && phase !== shown) {
      shown = phase;
      phaseEl.textContent = phase;
    }
    if (fadeEl && held === null && !reduce && !once) {
      const edge = Math.min(t / 0.45, (CATCH_DUR - t) / 0.45, 1);
      fadeEl.style.opacity = String(1 - THREE.MathUtils.clamp(edge, 0, 1));
    } else if (fadeEl) fadeEl.style.opacity = '0';
  };

  const frame = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    apply(clock);
    renderer.render(scene, camera);
  };

  let last = performance.now();
  const loop = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (playing) {
      clock += dt;
      if (clock >= CATCH_DUR) {
        if (once || reduce) {
          clock = T.caught + 0.4;
          playing = false;
          once = false;
        } else clock %= CATCH_DUR;
      }
    }
    frame();
  };

  const sync = () => {
    const run = visible && !document.hidden && (playing || held !== null);
    last = performance.now();
    renderer.setAnimationLoop(run && playing ? loop : null);
    if (!run || !playing) frame();
  };

  replay?.addEventListener('click', () => {
    clock = 0;
    once = reduce;
    playing = true;
    if (fadeEl) fadeEl.style.opacity = '0';
    visible = true;
    sync();
  });

  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener('visibilitychange', sync);
  new ResizeObserver(() => frame()).observe(canvas);
  frame();
  canvas.classList.add('ready');
}
