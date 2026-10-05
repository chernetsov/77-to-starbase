import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CYBERTRUCK_LENGTH, type Cybertruck } from './cybertruck';
import { buildFrost, createLaunchFx, type FxState } from './launchfx';
import { Puffs, puffTexture } from './puffs';
import { buildBuildSite } from './factory';
import {
  BEACH_TRACK,
  buildClouds,
  buildCoast,
  buildFlats,
  buildPadInfrastructure,
  buildRoadside,
  buildHorizon,
  buildVariety,
  coastHeight,
  fbm,
  HIGHWAY,
} from './scenery';
import {
  applyPadState,
  BOOSTER_H,
  buildMount,
  buildPlume,
  buildStack,
  buildTower,
  MOUNT_H,
  padSequence,
  R,
  SHIP_H,
  STACK_H,
  STACKING_PHASES,
  TOWER_OFFSET,
} from './starship';

/** `intro` is the opening's progress in [0, 1]; `introDone` turns true once it has finished playing. */
export type Hud = { phase: 'idle' | 'countdown' | 'flight'; t: number; alt: number; vel: number; intro: number; introDone: boolean };

/**
 * The opening, in seconds. Shots at road speed, with the truck relocated only while it is out of frame:
 * - 0 → `skyward`: wide shot of the build site from across Highway 4 as the truck drives past and out of frame;
 *   from `tiltUp` the camera tilts up into the sky.
 * - `skyward`: camera and truck relocate to the pads while the view is all sky.
 * - `skyward` → `padPass`: tilt down the stack to a low close-up of the truck on the road below it.
 * - `padPass` → `glide`: tracking the truck past the pads.
 * - `glide` → `settle`: the camera lets the truck go and glides around the stack to the beach vantage.
 * - `beach`: the truck, relocated out of frame, rolls up the beach and stops on its spot at `total`.
 */
export const INTRO = { tiltUp: 12.5, swap: 15, padPass: 18, stack: 22, glide: 30.5, beach: 30.6, settle: 35.2, total: 38 };
/** Chapter starts for the intro controls, in seconds. */
export const CHAPTERS = { site: 0, pad: INTRO.swap - 0.6, beach: INTRO.glide - 0.5 } as const;
export type Chapter = keyof typeof CHAPTERS;
// Lift while the truck passes and finish releasing at the end of the stacking hold; the arms then
// ride slowly back down the tower during the glide.
const LIFT_S = 19;
const RELEASE_S = 30;
const WINDOW_S = (RELEASE_S - LIFT_S) / (STACKING_PHASES.park - STACKING_PHASES.lift);
const WINDOW_START = LIFT_S - STACKING_PHASES.lift * WINDOW_S;
export const STACKING_WINDOW: [number, number] = [WINDOW_START / INTRO.total, (WINDOW_START + WINDOW_S) / INTRO.total];

// World units are meters. Launch mount at the origin, +x east toward the Gulf, +z south toward Highway 4.
// The camera stands on Boca Chica Beach looking west-southwest, so the build site lines up behind the pads.
const CAMERA_POS = new THREE.Vector3(480, 2.4, -60);
const LOOK_AT = new THREE.Vector3(0, 36, 0);
const SPEED_OF_SOUND = 343;
const IGNITION = -2.5;

function roadTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(512, 64);
  for (let i = 0; i < 512 * 64; i++) {
    const v = 52 + Math.random() * 18;
    img.data.set([v, v, v + 2, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = '#d8d8d2';
  ctx.fillRect(0, 3, 512, 2);
  ctx.fillRect(0, 59, 512, 2);
  ctx.fillStyle = '#d9a72c';
  ctx.fillRect(0, 31, 256, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** C1 interpolation through keyed values (monotone cubic Hermite), flat at the first and last key. */
function monotoneKeys(times: number[], values: number[], x: number) {
  const n = times.length;
  if (x <= times[0]) return values[0];
  if (x >= times[n - 1]) return values[n - 1];
  let i = 0;
  while (x > times[i + 1]) i++;
  const slope = (j: number) => {
    if (j === 0 || j === n - 1) return 0;
    const a = (values[j] - values[j - 1]) / (times[j] - times[j - 1]);
    const b = (values[j + 1] - values[j]) / (times[j + 1] - times[j]);
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  };
  const h = times[i + 1] - times[i];
  const u = (x - times[i]) / h;
  const m0 = slope(i) * h;
  const m1 = slope(i + 1) * h;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * values[i] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * values[i + 1] + (u3 - u2) * m1;
}

/** Flat strip along a curve; u runs along it in 24 m texture repeats. */
function roadRibbon(curve: THREE.Curve<THREE.Vector3>, width: number) {
  const pts = curve.getSpacedPoints(Math.ceil(curve.getLength() / 6));
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  let along = 0;
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    if (i > 0) along += p.distanceTo(pts[i - 1]);
    const ox = (-dz / l) * width * 0.5;
    const oz = (dx / l) * width * 0.5;
    pos.push(p.x - ox, 0, p.z - oz, p.x + ox, 0, p.z + oz);
    uv.push(along / 24, 1, along / 24, 0);
    if (i > 0) index.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

export function createHeroScene(canvas: HTMLCanvasElement, truck: Cybertruck, onHud: (h: Hud) => void) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const lowPower = Math.min(window.innerWidth, window.innerHeight) < 700 || matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, lowPower ? 1.5 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.62;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 30000);

  // Golden hour: the sun 5° up in the east-southeast, behind the beach and over the camera's left
  // shoulder, so everything the camera faces is lit warm and side-on with long shadows.
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 5.5), THREE.MathUtils.degToRad(67));
  const SKY = { turbidity: 9, rayleigh: 3.1, mieCoefficient: 0.008, mieDirectionalG: 0.88 };
  const sky = new Sky();
  sky.scale.setScalar(20000);
  const u = sky.material.uniforms;
  for (const [k, v] of Object.entries(SKY)) u[k].value = v;
  u.sunPosition.value.copy(sunDir);
  // The built-in sky clouds smear into a grey wall when the camera tilts up; puffs and cirrus replace them.
  u.cloudCoverage.value = 0;
  scene.add(sky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  for (const [k, v] of Object.entries(SKY)) envSky.material.uniforms[k].value = v;
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.cloudCoverage.value = 0;
  envScene.add(envSky);
  const envGround = new THREE.Mesh(new THREE.CircleGeometry(900, 32), new THREE.MeshBasicMaterial({ color: 0x8f7356 }));
  envGround.rotation.x = -Math.PI / 2;
  envGround.position.y = -2;
  envScene.add(envGround);
  const env = pmrem.fromScene(envScene, 0.02).texture;
  scene.environment = env;
  const hazeColor = new THREE.Color(0xc9a788);
  scene.fog = new THREE.FogExp2(hazeColor, 0.000115);

  const sun = new THREE.DirectionalLight(0xffb878, 3.3);
  sun.position.copy(sunDir).multiplyScalar(400).add(CAMERA_POS);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0x9fb2d4, 0x7a5a3c, 0.66));
  const horizon = buildHorizon(sunDir, hazeColor);
  scene.add(horizon.group);

  scene.add(buildFlats());
  scene.add(buildCoast(CAMERA_POS.z));
  scene.add(buildVariety(CAMERA_POS.z, lowPower));
  scene.add(buildPadInfrastructure());
  scene.add(buildBuildSite({ glow: 0.35 }));
  scene.add(buildRoadside(lowPower));
  const clouds = buildClouds(lowPower);
  scene.add(clouds.mesh);

  // Highway 4 runs from the build site east past the pads and ends at the beach.
  const road = new THREE.Mesh(roadRibbon(HIGHWAY, 7.4), new THREE.MeshStandardMaterial({ map: roadTexture(), roughness: 0.9 }));
  road.position.y = 0.04;
  road.receiveShadow = true;
  scene.add(road);

  // The truck is parked on the hard sand of Boca Chica Beach, broadside to the camera.
  const fwd = LOOK_AT.clone().sub(CAMERA_POS).setY(0).normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const truckHome = CAMERA_POS.clone().addScaledVector(fwd, 46).addScaledVector(right, 3.5).setY(0.01);

  // Pad 2: the tower stands south of the mount, arms reaching north toward the stack.
  scene.add(buildMount(null));
  const tower = buildTower(null);
  tower.group.position.set(0, 0, TOWER_OFFSET);
  tower.group.rotation.y = Math.PI / 2;
  scene.add(tower.group);

  // Pad 1, a few hundred meters north.
  const pad1 = new THREE.Group();
  pad1.add(buildMount(null));
  const tower1 = buildTower(null);
  tower1.group.position.set(0, 0, TOWER_OFFSET);
  tower1.group.rotation.y = Math.PI / 2;
  pad1.add(tower1.group);
  pad1.position.set(90, 0, -330);
  pad1.rotation.y = 0.3;
  scene.add(pad1);
  applyPadState(padSequence({ introS: 1, introTotal: 1, launchT: null }), tower1, new THREE.Object3D());

  const stack = buildStack(null);
  stack.position.y = MOUNT_H;
  stack.rotation.y = 0.55;
  scene.add(stack);

  // The stack is fueled: frost on the tank sections and boil-off venting while it waits. The ship's frost
  // and vents ride on the ship, which the chopsticks carry during the intro.
  const ship = stack.getObjectByName('ship')!;
  stack.add(buildFrost(R, [[3, BOOSTER_H * 0.47], [BOOSTER_H * 0.53, BOOSTER_H * 0.9]]));
  ship.add(buildFrost(R, [[4, SHIP_H * 0.36], [SHIP_H * 0.4, SHIP_H * 0.58]]));
  const ventSpots = [
    [BOOSTER_H * 0.93, 0.3, 1.2], [BOOSTER_H * 0.93, 3.4, 1.2], [BOOSTER_H + SHIP_H * 0.37, 1.9, 1],
    [BOOSTER_H + SHIP_H * 0.62, -1.2, 0.7], [2, 1.0, 1.6], [BOOSTER_H + 20, 2.12, 1.2],
  ].map(([y, a, weight]) => ({
    onShip: y > BOOSTER_H,
    local: new THREE.Vector3(Math.cos(a) * R, y > BOOSTER_H ? y - BOOSTER_H : y, Math.sin(a) * R),
    localDir: new THREE.Vector3(Math.cos(a), -0.15, Math.sin(a)),
    pos: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    weight,
  }));
  const ventWeight = ventSpots.reduce((n, v) => n + v.weight, 0);
  function ventRate() {
    if (phase === 'idle') return 22;
    if (t >= IGNITION) return 0;
    return 22 + 60 * THREE.MathUtils.smoothstep(t, -10, IGNITION);
  }

  const plume = buildPlume();
  stack.add(plume.group);
  plume.group.visible = false;
  const flameLight = new THREE.PointLight(0xff9a4a, 0, 0, 2);
  flameLight.position.set(0, -6, 0);
  stack.add(flameLight);

  const fx = createLaunchFx(lowPower);
  const puffs = new Puffs(clouds.count + fx.max, puffTexture(), sunDir);
  scene.add(puffs.mesh);

  // Soft contact shadow: the low sun throws the real one behind the truck, out of view.
  const contact = document.createElement('canvas');
  contact.width = contact.height = 128;
  const cctx = contact.getContext('2d')!;
  const grad = cctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.75)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  cctx.fillStyle = grad;
  cctx.fillRect(0, 0, 128, 128);
  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(CYBERTRUCK_LENGTH * 1.15, 3.1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(contact), transparent: true, depthWrite: false }),
  );
  contactShadow.position.y = 0.03;
  truck.group.add(contactShadow);
  truck.group.position.copy(truckHome);
  truck.group.rotation.y = 1.15;
  scene.add(truck.group);
  // The low sun only grazes the side the camera sees, so let the steel pick up more of the warm sky.
  truck.group.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (mat?.isMeshStandardMaterial && !mat.transparent) mat.envMapIntensity = 1.8;
  });

  // Suspension: the body rides spring-dampers over axles that follow the ground, so the truck rocks
  // over the beach sand. Each axle is one rigid pair that heaves and rolls with its two contacts.
  const BODY_Y = 0.9;
  const TRACK = 1.7;
  const inner = truck.group.children[0];
  const sprung = new THREE.Group();
  sprung.position.y = BODY_Y;
  const unsprung = new THREE.Group();
  unsprung.position.copy(inner.position);
  unsprung.quaternion.copy(inner.quaternion);
  unsprung.scale.copy(inner.scale);
  truck.group.add(sprung, unsprung);
  truck.group.updateMatrixWorld(true);
  for (const w of truck.wheels) unsprung.attach(w);
  sprung.attach(inner);
  truck.group.updateMatrixWorld(true);
  const axles = truck.wheels
    .map((pivot) => ({ pivot, x: truck.group.worldToLocal(pivot.getWorldPosition(new THREE.Vector3())).x, y: pivot.position.y, h: 0, roll: 0 }))
    .sort((a, b) => b.x - a.x);
  const wheelBase = axles.length > 1 ? axles[0].x - axles[axles.length - 1].x : 3.8;
  const ride = { heave: [0, 0], pitch: [0, 0], roll: [0, 0] } as Record<'heave' | 'pitch' | 'roll', [number, number]>;
  const RIDE_K = 70;
  const RIDE_C = 2 * 0.3 * Math.sqrt(RIDE_K);
  let rideTime = -1;
  let rideDist = 0;
  let rideSpeed = 0;
  let rideSettled = true;
  /** Ground under a wheel: firm asphalt on the road, wind-rippled ruts once on the beach sand. */
  const groundBump = (x: number, z: number) =>
    (0.004 + 0.07 * THREE.MathUtils.smoothstep(x, 330, 380)) * ((fbm(x * 0.45, z * 0.45, 3) - 0.5) * 2.2 + 0.35 * Math.sin(x * 1.7 + z * 0.9));

  sun.target.position.copy(truckHome);
  scene.add(sun.target);
  sun.position.copy(truckHome).addScaledVector(sunDir, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  // Wide enough for the long golden-hour shadow the truck throws across the sand.
  Object.assign(sun.shadow.camera, { left: -24, right: 24, top: 24, bottom: -24, near: 1, far: 160 });
  sun.shadow.bias = -0.0004;

  const padDistance = Math.hypot(CAMERA_POS.x, CAMERA_POS.z);
  const soundDelay = padDistance / SPEED_OF_SOUND;

  let width = 0;
  let height = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(r.width));
    height = Math.max(1, Math.round(r.height));
    renderer.setSize(width, height, false);
    const aspect = width / height;
    camera.aspect = aspect;
    // Keep roughly 30° of horizontal view on narrow screens so the truck and tower both fit.
    lens.fov = aspect < 1.25 ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(16)) / aspect)) : 32;
    lens.offset = aspect > 1.25 ? -0.16 : 0;
    // Keep the truck about half the frame wide in the road shot, whatever the aspect.
    // Portrait screens see a narrow slice; aim between the truck and the stack so both stay in.
    portrait = aspect < 1.25;
    const right = tmpA.subVectors(HOLD_SUBJECT, HOLD_TO).cross(THREE.Object3D.DEFAULT_UP).setY(0).normalize();
    HOLD_AIM.copy(HOLD_SUBJECT).addScaledVector(right, portrait ? 0 : -42);
    trackAim = portrait ? 0.13 : 0;
    trackDist = THREE.MathUtils.clamp(CYBERTRUCK_LENGTH / (Math.tan(THREE.MathUtils.degToRad(19)) * aspect), 9, 28);
    applyLens();
  }

  const PARK_HEADING = 1.15;
  const parkDir = new THREE.Vector3(Math.cos(PARK_HEADING), 0, -Math.sin(PARK_HEADING));
  const lane = HIGHWAY.getSpacedPoints(110).map((p, i, all) => {
    const d = all[Math.min(i + 1, all.length - 1)].clone().sub(all[Math.max(i - 1, 0)]).normalize();
    return p.clone().add(new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(1.8));
  });
  const route = new THREE.CatmullRomCurve3(
    [
      ...lane,
      ...BEACH_TRACK.slice(0, -2).map(([x, z]) => new THREE.Vector3(x, 0, z)),
      truckHome.clone().addScaledVector(parkDir, -46),
      truckHome.clone().addScaledVector(parkDir, -20),
      truckHome.clone(),
    ],
    false,
    'centripetal',
  );
  route.arcLengthDivisions = 6000;
  const routeLength = route.getLength();
  const distanceAtX = (x: number) => {
    let u = 0;
    while (u < 1 && route.getPointAt(u).x < x) u += 1 / 6000;
    return u * routeLength;
  };

  // Truck segments along the route, all at road speed; the jumps between them happen out of frame.
  const SPEED = 27;
  // Up the beach at a sand-driving pace, then an easy stop: cruise, then brake evenly to rest.
  const BEACH_SPEED = 8.5;
  const BEACH_CRUISE = 0.55;
  const BEACH_ROLL = BEACH_SPEED * (INTRO.total - INTRO.beach) * (BEACH_CRUISE + (1 - BEACH_CRUISE) / 2);
  const PAD_STOP = INTRO.stack + 2.5;
  const factoryStart = distanceAtX(-2585);
  const padStart = distanceAtX(110) - SPEED * (INTRO.padPass - INTRO.swap);
  function distanceAt(time: number) {
    if (time < INTRO.swap) return factoryStart + SPEED * time;
    // Parked out of frame once it has driven off past the pad, until the jump to the beach.
    if (time < INTRO.beach) return padStart + SPEED * (Math.min(time, PAD_STOP) - INTRO.swap);
    const T = INTRO.total - INTRO.beach;
    const u = THREE.MathUtils.clamp((time - INTRO.beach) / T, 0, 1);
    const b = Math.max(0, u - BEACH_CRUISE);
    return routeLength - BEACH_ROLL + BEACH_SPEED * T * (u - (b * b) / (2 * (1 - BEACH_CRUISE)));
  }
  const truckAt = (time: number, out: THREE.Vector3) => route.getPointAt(distanceAt(time) / routeLength, out);

  const tangent = new THREE.Vector3();
  const truckPos = new THREE.Vector3();
  const camFrom = new THREE.Vector3();
  const introDir = new THREE.Vector3();
  let trackDist = 10;
  let trackAim = 0;
  let portrait = false;
  let travelled = 0;

  function poseTruck(time: number) {
    travelled = distanceAt(time);
    const u = travelled / routeLength;
    route.getPointAt(u, truckPos);
    route.getTangentAt(u, tangent);
    const half = CYBERTRUCK_LENGTH * 0.4;
    const front = coastHeight(truckPos.x + tangent.x * half, truckPos.z + tangent.z * half);
    const back = coastHeight(truckPos.x - tangent.x * half, truckPos.z - tangent.z * half);
    truckPos.y = 0.01 + (front + back) / 2;
    truck.group.position.copy(truckPos);
    const heading = Math.atan2(-tangent.z, tangent.x);
    truck.group.rotation.set(0, heading, Math.atan2(front - back, half * 2));
    for (const w of truck.wheels) w.rotation.z = travelled / truck.wheelRadius;
    suspend(time, heading);
    sun.target.position.copy(truckPos);
    sun.position.copy(truckPos).addScaledVector(sunDir, 60);
  }

  function suspend(time: number, heading: number) {
    const fx = Math.cos(heading);
    const fz = -Math.sin(heading);
    const unit = 1 / unsprung.scale.x;
    for (const a of axles) {
      const cx = truckPos.x + fx * a.x;
      const cz = truckPos.z + fz * a.x;
      // Right of the nose is local +z: (sin, cos) of the heading in world x/z.
      const hl = groundBump(cx + fz * TRACK * 0.5, cz - fx * TRACK * 0.5);
      const hr = groundBump(cx - fz * TRACK * 0.5, cz + fx * TRACK * 0.5);
      a.h = (hl + hr) / 2;
      a.roll = Math.atan((hl - hr) / TRACK);
      a.pivot.position.y = a.y + a.h * unit;
      // The unsprung frame is turned half round, so its x axis runs nose to tail.
      a.pivot.rotation.x = -a.roll;
    }
    const front = axles[0];
    const rear = axles[axles.length - 1];
    const dt = time - rideTime;
    const moved = travelled - rideDist;
    const speed = dt > 0 ? moved / dt : 0;
    const target = {
      heave: (front.h + rear.h) / 2,
      // Nose dips under braking.
      pitch: Math.atan((front.h - rear.h) / wheelBase) + THREE.MathUtils.clamp((speed - rideSpeed) / Math.max(dt, 1e-3), -6, 6) * 0.004,
      roll: (front.roll + rear.roll) / 2,
    };
    if (rideTime < 0 || dt <= 0 || dt > 0.25 || Math.abs(moved) > 8) {
      for (const k of ['heave', 'pitch', 'roll'] as const) ride[k] = [target[k], 0];
    } else {
      const n = Math.ceil(dt * 240);
      const h = dt / n;
      for (let i = 0; i < n; i++)
        for (const k of ['heave', 'pitch', 'roll'] as const) {
          const st = ride[k];
          st[1] += (RIDE_K * (target[k] - st[0]) - RIDE_C * st[1]) * h;
          st[0] += st[1] * h;
        }
    }
    rideSettled = Math.abs(ride.heave[1]) + Math.abs(ride.pitch[1]) + Math.abs(ride.roll[1]) < 1e-4 && Math.abs(moved) < 1e-4;
    rideTime = time;
    rideDist = travelled;
    rideSpeed = dt > 0 && dt <= 0.25 ? speed : 0;
    sprung.position.y = BODY_Y + ride.heave[0];
    sprung.rotation.set(ride.roll[0], 0, ride.pitch[0]);
  }

  // Both sides of the sky relocation look exactly this way, with the clouds shifted by the jump.
  const SKY_DIR = new THREE.Vector3(0, Math.tan(THREE.MathUtils.degToRad(80)), -1).normalize();
  const STACK_MID = new THREE.Vector3(0, 95, 0);
  // Stacking hold: east-southeast of the pad, the tower to the left of the stack and the ship stand
  // to its right, so the swing reads across the frame. A slow push in over the whole hold.
  const HOLD_START = INTRO.stack + 3;
  const HOLD_FROM = new THREE.Vector3(198, 22, 154);
  const HOLD_TO = new THREE.Vector3(170, 25, 130);
  const HOLD_SUBJECT = new THREE.Vector3(8, 96, -4);
  const HOLD_AIM = new THREE.Vector3();
  const holdVel = HOLD_TO.clone().sub(HOLD_FROM).divideScalar(INTRO.glide - HOLD_START);
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const cloudShift = new THREE.Vector3();
  const rigPos = new THREE.Vector3();
  const rigVel = new THREE.Vector3();

  /** Side-on dolly beside the truck past the build site, looking square at the buildings. */
  function dollyRig(time: number, at: THREE.Vector3, outPos: THREE.Vector3) {
    const lift = THREE.MathUtils.smoothstep(time, INTRO.tiltUp, INTRO.swap) * 3;
    return outPos.set(at.x + (portrait ? -1.6 : -2.5) + time * 0.12, 2.6 + lift, at.z + (portrait ? 10 : 12));
  }
  const dollyDir = () => tmpC.set(Math.tan(THREE.MathUtils.degToRad(8)), Math.tan(THREE.MathUtils.degToRad(portrait ? 4 : 10)), -1).normalize();

  /** Low tracking rig on the south shoulder, slightly ahead of the truck, so the stack stands behind it. */
  function padRig(time: number, at: THREE.Vector3, outPos: THREE.Vector3, outAim: THREE.Vector3) {
    const D = trackDist;
    const k = THREE.MathUtils.clamp((time - INTRO.swap) / (INTRO.stack - INTRO.swap), 0, 1);
    const crane = THREE.MathUtils.lerp(10, 1.7, descent(time));
    outPos.set(at.x + D * THREE.MathUtils.lerp(0.5, 0.1, k), crane, at.z + D * 1.05);
    outAim.set(at.x - D * trackAim, 1 + D * 0.11, at.z);
  }

  /** Cubic Hermite from p0 (velocity v0) to p1 (velocity v1) over T seconds. */
  function hermite(out: THREE.Vector3, p0: THREE.Vector3, v0: THREE.Vector3, p1: THREE.Vector3, v1: THREE.Vector3, T: number, u: number) {
    const u2 = u * u;
    const u3 = u2 * u;
    return out
      .copy(p0)
      .multiplyScalar(2 * u3 - 3 * u2 + 1)
      .addScaledVector(v0, (u3 - 2 * u2 + u) * T)
      .addScaledVector(p1, -2 * u3 + 3 * u2)
      .addScaledVector(v1, (u3 - u2) * T);
  }

  // Through the sky cut the view keeps turning, from the dolly's heading east of north toward the
  // stack just west of north, so it never stands still at the zenith. Both rigs share this
  // direction at the swap itself.
  const UP = new THREE.Vector3(0, 1, 0);
  const SKY_YAW = 0.18;
  const skyDir = (time: number, out: THREE.Vector3) => out.copy(SKY_DIR).applyAxisAngle(UP, SKY_YAW * (time - INTRO.swap));
  const easeOutSine = (u: number) => Math.sin((u * Math.PI) / 2);
  /** Progress of the descent from the sky cut to the truck at padPass: starts from rest, lands softly. */
  function descent(time: number) {
    const u = THREE.MathUtils.clamp((time - INTRO.swap) / (INTRO.padPass - INTRO.swap), 0, 1);
    return 0.5 - 0.5 * Math.cos(Math.PI * u);
  }

  /** Sets camFrom, introDir and cloudShift for the intro moment; returns how far the view has handed over to the vantage. */

  function introCamera(time: number) {
    cloudShift.set(0, 0, 0);
    if (time < INTRO.swap) {
      dollyRig(time, truckPos, camFrom);
      const up = THREE.MathUtils.clamp((time - INTRO.tiltUp) / (INTRO.swap - INTRO.tiltUp), 0, 1);
      introDir.copy(dollyDir()).lerp(skyDir(time, tmpC), easeInOut(up) * 0.35 + easeOutSine(up) * 0.65).normalize();
      // Carry the sky along so it already sits where the pad camera will see it after the cut.
      dollyRig(INTRO.swap, route.getPointAt((factoryStart + SPEED * INTRO.swap) / routeLength, tmpA), cloudShift);
      padRig(INTRO.swap, truckAt(INTRO.swap, tmpA), tmpB, tmpA);
      cloudShift.sub(tmpB);
      return { camK: 0, lookK: 0 };
    }
    if (time < INTRO.stack) {
      // One eased move down from the sky onto the truck: the crane drop and the turn share `descent`,
      // and the view sweeps past the stack on the way (a quadratic Bezier over directions).
      padRig(time, truckPos, camFrom, tmpB);
      tmpB.sub(camFrom).normalize();
      tmpA.subVectors(STACK_MID, camFrom).normalize();
      const s = descent(time);
      skyDir(time, tmpC).lerp(tmpA, s).normalize();
      tmpA.lerp(tmpB, s).normalize();
      introDir.copy(tmpC).lerp(tmpA, s).normalize();
      return { camK: 0, lookK: 0 };
    }
    if (time < INTRO.glide) {
      if (time < HOLD_START) {
        // Crane up and back off the truck (leaving with the rig's velocity) into the stacking hold.
        // The truck drives on out of frame while the camera turns to the tower.
        padRig(INTRO.stack, truckAt(INTRO.stack, tmpA), rigPos, tmpB);
        const leaving = tmpB.sub(rigPos).normalize();
        padRig(INTRO.stack - 1 / 60, truckAt(INTRO.stack - 1 / 60, tmpA), rigVel, tmpA);
        rigVel.subVectors(rigPos, rigVel).multiplyScalar(60);
        const T = HOLD_START - INTRO.stack;
        const u = (time - INTRO.stack) / T;
        hermite(camFrom, rigPos, rigVel, HOLD_FROM, holdVel, T, u);
        introDir.subVectors(HOLD_AIM, camFrom).normalize();
        introDir.copy(leaving.lerp(introDir, easeInOut(u))).normalize();
      } else {
        camFrom.copy(HOLD_FROM).addScaledVector(holdVel, time - HOLD_START);
        introDir.subVectors(HOLD_AIM, camFrom).normalize();
      }
      return { camK: 0, lookK: 0 };
    }
    // Glide from the hold (leaving with its push) up and around to the vantage.
    const T = INTRO.settle - INTRO.glide;
    const u = THREE.MathUtils.clamp((time - INTRO.glide) / T, 0, 1);
    hermite(camFrom, HOLD_TO, holdVel, CAMERA_POS, tmpA.set(0, 0, 0), T, u);
    camFrom.y += 10 * Math.sin(Math.PI * u) ** 2;
    introDir.subVectors(HOLD_AIM, HOLD_TO).normalize();
    return {
      camK: THREE.MathUtils.smoothstep(time, INTRO.settle - 0.8, INTRO.total),
      lookK: easeInOut(THREE.MathUtils.clamp((time - INTRO.glide) / (INTRO.settle - 0.6 - INTRO.glide), 0, 1)),
    };
  }

  /** Lens for the intro moment: wide past the buildings and through the sky, long on the pad. */
  function introFov(time: number) {
    const wide = portrait ? 70 : 50;
    const hold = portrait ? 46 : 34;
    return monotoneKeys([0, INTRO.padPass - 1.5, INTRO.padPass + 0.5, INTRO.stack, HOLD_START], [wide, wide, 38, 38, hold], time);
  }
  let fovNow = 38;

  const lens = { fov: 32, offset: 0 };
  let lensK = 0;
  function applyLens() {
    camera.fov = THREE.MathUtils.lerp(fovNow, lens.fov, lensK);
    const off = lens.offset;
    if (off !== 0) camera.setViewOffset(width, height, width * off, 0, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }
  const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

  let phase: Hud['phase'] = 'idle';
  let t = 0;
  let introT = 0;
  let introHold: number | null = null;
  /** Clock time the intro (re)started at; chapter jumps move it. */
  let introStart = 0;
  let launchHeld = false;
  let pointerX = 0;
  let pointerY = 0;
  /** Mouse parallax at the settled view, eased toward the pointer so the camera trails it by ~0.7 s. */
  const parallax = { x: 0, y: 0 };
  const PARALLAX = { side: 3.6, rise: 1.3, yaw: 0.03, pitch: 0.02, lag: 0.7 };
  const viewRight = new THREE.Vector3();
  const look = LOOK_AT.clone();
  const lookNow = new THREE.Vector3();
  const lookDirA = new THREE.Vector3();
  const lookDirB = new THREE.Vector3();
  const camBase = new THREE.Vector3();
  const clock = new THREE.Clock();

  /** Aim height: low at rest so the parked truck clears the HUD, then riding with the climbing stack. */
  function lookHeight(alt: number) {
    return LOOK_AT.y + alt + THREE.MathUtils.smoothstep(alt, 0, 250) * (MOUNT_H + STACK_H * 0.35 - LOOK_AT.y);
  }

  // Dev guard: the truck must never be on screen in the frame it jumps between segments.
  const frustum = new THREE.Frustum();
  const truckSphere = new THREE.Sphere();
  let lastSegment = -1;
  function checkRelocation(time: number) {
    const segment = time < INTRO.swap ? 0 : time < INTRO.beach ? 1 : 2;
    if (segment !== lastSegment && lastSegment !== -1) {
      camera.position.copy(camFrom);
      camera.lookAt(tmpA.copy(camFrom).add(introDir));
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(tmpM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      if (frustum.intersectsSphere(truckSphere.set(truckPos, CYBERTRUCK_LENGTH * 0.6)))
        console.warn(`intro: truck visible when relocating at ${time.toFixed(2)}s`);
    }
    lastSegment = segment;
  }
  const tmpM = new THREE.Matrix4();

  function altitudeAt(time: number) {
    if (time <= 0) return 0;
    return 1.6 * time * time + 0.09 * time * time * time;
  }

  function fxState(time: number): FxState {
    const engines = time >= IGNITION;
    const alt = altitudeAt(time);
    return { engines, alt, spool: engines ? THREE.MathUtils.smoothstep(time, IGNITION, IGNITION + 1.2) : 0, enginesY: MOUNT_H + alt };
  }

  function step() {
    const dt = Math.min(clock.getDelta(), 0.25);
    const now = clock.elapsedTime;

    let camK = 1;
    let lookK = 1;
    if (introT < 1 || introHold !== null) {
      introT = introHold ?? Math.min(1, (now - introStart) / INTRO.total);
      const it = introT * INTRO.total;
      poseTruck(it);
      ({ camK, lookK } = introCamera(it));
      fovNow = introFov(it);
      lensK = THREE.MathUtils.smoothstep(it, INTRO.glide, INTRO.settle);
      applyLens();
      if (import.meta.env.DEV) checkRelocation(it);
    } else {
      // Let the body settle on its springs after the truck stops.
      if (!rideSettled) poseTruck(INTRO.total + Math.min(now - introStart - INTRO.total, 2));
      cloudShift.set(0, 0, 0);
      if (lensK !== 1) {
        lensK = 1;
        applyLens();
      }
    }
    clouds.setOffset(cloudShift);

    let alt = 0;
    let vel = 0;
    let shake = 0;
    if (phase !== 'idle') {
      if (!launchHeld) t += dt;
      const st = fxState(t);
      if (st.engines) {
        if (phase === 'countdown' && t >= 0) phase = 'flight';
        alt = st.alt;
        vel = 3.2 * Math.max(0, t) + 0.27 * Math.max(0, t) ** 2;
        stack.position.y = MOUNT_H + alt;
        plume.group.visible = true;
        // Near the pad the steam should swallow the flame base; once clear, the flame draws over the vapor trail.
        const flameOrder = alt < 200 ? 0 : 3;
        if (plume.group.children[0].renderOrder !== flameOrder) plume.group.traverse((o) => (o.renderOrder = flameOrder));
        plume.update(now, st.spool * (1 - THREE.MathUtils.smoothstep(alt, 2500, 6000) * 0.6));
        flameLight.intensity = st.spool * 5e5 * (0.85 + Math.random() * 0.3);
        const heard = t - IGNITION - soundDelay;
        if (heard > 0) shake = Math.min(1, heard * 2) * Math.max(0, 1 - alt / 3000) * 0.012;
      }
      if (!launchHeld) fx.simulate(dt, st);
      if (t > 32) reset();
    } else {
      fx.simulate(dt, fxState(-100));
    }
    const pad = padSequence({
      introS: introT * INTRO.total,
      introTotal: INTRO.total,
      launchT: phase !== 'idle' ? t : null,
      window: STACKING_WINDOW,
    });
    applyPadState(pad, tower, stack);

    const rate = ventRate();
    if (rate > 0 && !launchHeld) {
      stack.updateMatrixWorld(true);
      const venting = pad.ship ? ventSpots.filter((v) => !v.onShip) : ventSpots;
      for (const v of venting) {
        const frame = v.onShip ? ship.matrixWorld : stack.matrixWorld;
        v.pos.copy(v.local).applyMatrix4(frame);
        v.dir.copy(v.localDir).transformDirection(frame);
      }
      const share = venting.reduce((n, v) => n + v.weight, 0) / ventWeight;
      fx.vent(dt, rate * share, venting);
    }
    clouds.update(now);

    const target = new THREE.Vector3(0, lookHeight(alt), 0);
    look.lerp(target, 1 - Math.exp(-dt * 2.5));
    const settled = introT >= 1 && introHold === null && phase === 'idle';
    const follow = 1 - Math.exp(-dt / (PARALLAX.lag / 3));
    parallax.x += ((settled ? pointerX : 0) - parallax.x) * follow;
    parallax.y += ((settled ? pointerY : 0) - parallax.y) * follow;
    viewRight.subVectors(look, CAMERA_POS).setY(0).normalize().cross(UP);
    camBase
      .copy(CAMERA_POS)
      .addScaledVector(viewRight, parallax.x * PARALLAX.side)
      .add(tmpA.set(0, -parallax.y * PARALLAX.rise, 0));
    camBase.x += Math.sin(now * 0.07) * 0.6;
    camera.position.lerpVectors(camFrom, camBase, camK);
    // Blend look directions, not points: the truck is metres away and the stack hundreds.
    lookDirA.copy(introDir);
    lookDirB.subVectors(look, camera.position).normalize();
    lookNow.copy(camera.position).add(lookDirA.lerp(lookDirB, lookK).normalize());
    camera.lookAt(lookNow);
    if (parallax.x !== 0 || parallax.y !== 0) {
      camera.rotateY(-parallax.x * PARALLAX.yaw * camK);
      camera.rotateX(-parallax.y * PARALLAX.pitch * camK);
    }
    if (shake > 0) {
      camera.rotation.x += (Math.random() - 0.5) * shake;
      camera.rotation.y += (Math.random() - 0.5) * shake;
    }

    camera.updateMatrixWorld();
    horizon.glow.position.set(camera.position.x, 1200, camera.position.z);
    puffs.begin();
    clouds.push(puffs);
    fx.push(puffs);
    puffs.commit(camera);

    renderer.render(scene, camera);
    onHud({ phase, t, alt, vel, intro: introT, introDone: introT >= 1 && introHold === null });
  }

  function reset() {
    phase = 'idle';
    t = 0;
    stack.position.y = MOUNT_H;
    plume.group.visible = false;
    flameLight.intensity = 0;
  }

  /** Restarts the entrance from `seconds` in, cancelling any launch. */
  function seekIntro(seconds: number) {
    if (phase !== 'idle') {
      reset();
      fx.clear();
    }
    introHold = null;
    lastSegment = -1;
    introStart = clock.elapsedTime - THREE.MathUtils.clamp(seconds, 0, INTRO.total);
    introT = 0;
  }

  let running = false;
  let raf = 0;
  const loop = () => {
    step();
    raf = requestAnimationFrame(loop);
  };

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  return {
    start() {
      if (running) return;
      running = true;
      clock.getDelta();
      raf = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    /** Compiles shaders and renders one frame of each intro shot so playback starts without hitches; leaves the intro unheld. */
    async warmup(onProgress?: (k: number) => void) {
      await renderer.compileAsync(scene, camera);
      const shots = [CHAPTERS.pad + 3, INTRO.stack + 4, INTRO.glide + 2, INTRO.total, 0];
      for (const [i, s] of shots.entries()) {
        introHold = s / INTRO.total;
        lastSegment = -1;
        step();
        onProgress?.((i + 1) / shots.length);
        await new Promise(requestAnimationFrame);
      }
      introHold = null;
    },
    renderOnce() {
      introT = 1;
      poseTruck(INTRO.total);
      step();
    },
    skipIntro() {
      introT = 1;
      introHold = null;
      introStart = clock.elapsedTime - INTRO.total;
      poseTruck(INTRO.total);
    },
    seekIntro,
    jumpToIntro: (name: Chapter) => seekIntro(CHAPTERS[name]),
    /** Dev aid: freeze the entrance at a progress in [0, 1]. */
    holdIntro(p: number) {
      introHold = THREE.MathUtils.clamp(p, 0, 1);
    },
    launch(from = -10) {
      if (phase !== 'idle') return;
      fx.clear();
      phase = 'countdown';
      t = from;
      // Starting mid-flight (dev aid): run the vapor forward so it looks as it would by then.
      const h = 1 / 30;
      for (let s = IGNITION; s < from; s += h) fx.simulate(h, fxState(s));
      if (from > 0) look.set(0, lookHeight(altitudeAt(from)), 0);
    },
    /** Dev aid: freeze the launch clock (rendering continues). */
    holdLaunch() {
      launchHeld = true;
    },
    pointer(x: number, y: number) {
      pointerX = x;
      pointerY = y;
    },
    get soundDelay() {
      return soundDelay;
    },
    get padDistance() {
      return padDistance;
    },
  };
}
