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
  buildVariety,
  coastHeight,
  HIGHWAY,
} from './scenery';
import { BOOSTER_H, buildMount, buildPlume, buildStack, buildTower, MOUNT_H, R, SHIP_H, TOWER_OFFSET, STACK_H } from './starship';

export type Hud = { phase: 'idle' | 'countdown' | 'flight'; t: number; alt: number; vel: number };

// World units are meters. Launch mount at the origin, +x east toward the Gulf, +z south toward Highway 4.
// The camera stands on Boca Chica Beach looking west-southwest, so the build site lines up behind the pads.
const CAMERA_POS = new THREE.Vector3(480, 2.4, -60);
const LOOK_AT = new THREE.Vector3(0, 52, 0);
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

  // Low morning sun in the east-southeast, behind the beach and over the camera's left shoulder.
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 11), THREE.MathUtils.degToRad(67));
  const sky = new Sky();
  sky.scale.setScalar(20000);
  const u = sky.material.uniforms;
  u.turbidity.value = 7;
  u.rayleigh.value = 2.4;
  u.mieCoefficient.value = 0.006;
  u.mieDirectionalG.value = 0.86;
  u.sunPosition.value.copy(sunDir);
  // The built-in sky clouds smear into a grey wall when the camera tilts up; puffs and cirrus replace them.
  u.cloudCoverage.value = 0;
  scene.add(sky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(1000);
  Object.assign(envSky.material.uniforms.turbidity, { value: 7 });
  envSky.material.uniforms.rayleigh.value = 2.4;
  envSky.material.uniforms.mieCoefficient.value = 0.006;
  envSky.material.uniforms.mieDirectionalG.value = 0.86;
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.cloudCoverage.value = 0;
  envScene.add(envSky);
  const envGround = new THREE.Mesh(new THREE.CircleGeometry(900, 32), new THREE.MeshBasicMaterial({ color: 0x6b5c48 }));
  envGround.rotation.x = -Math.PI / 2;
  envGround.position.y = -2;
  envScene.add(envGround);
  const env = pmrem.fromScene(envScene, 0.02).texture;
  scene.environment = env;
  scene.fog = new THREE.FogExp2(0xb8a995, 0.00011);

  const sun = new THREE.DirectionalLight(0xffd2a6, 3.2);
  sun.position.copy(sunDir).multiplyScalar(400).add(CAMERA_POS);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xa9c2e0, 0x6e5a42, 0.6));

  scene.add(buildFlats());
  scene.add(buildCoast(CAMERA_POS.z));
  scene.add(buildVariety(CAMERA_POS.z, lowPower));
  scene.add(buildPadInfrastructure());
  scene.add(buildBuildSite());
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
  const truckHome = CAMERA_POS.clone().addScaledVector(fwd, 36).addScaledVector(right, 3.5).setY(0.01);

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

  const stack = buildStack(null);
  stack.position.y = MOUNT_H;
  stack.rotation.y = 0.55;
  scene.add(stack);

  // The stack is fueled: frost on the tank sections and boil-off venting while it waits.
  stack.add(buildFrost(R, [[3, BOOSTER_H * 0.47], [BOOSTER_H * 0.53, BOOSTER_H * 0.9], [BOOSTER_H + 4, BOOSTER_H + SHIP_H * 0.36], [BOOSTER_H + SHIP_H * 0.4, BOOSTER_H + SHIP_H * 0.58]]));
  const ventSpots = [
    [BOOSTER_H * 0.93, 0.3, 1.2], [BOOSTER_H * 0.93, 3.4, 1.2], [BOOSTER_H + SHIP_H * 0.37, 1.9, 1],
    [BOOSTER_H + SHIP_H * 0.62, -1.2, 0.7], [2, 1.0, 1.6], [BOOSTER_H + 20, 2.12, 1.2],
  ].map(([y, a, weight]) => ({
    local: new THREE.Vector3(Math.cos(a) * R, y, Math.sin(a) * R),
    localDir: new THREE.Vector3(Math.cos(a), -0.15, Math.sin(a)),
    pos: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    weight,
  }));
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

  sun.target.position.copy(truckHome);
  scene.add(sun.target);
  sun.position.copy(truckHome).addScaledVector(sunDir, 60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 140 });
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
    trackAim = aspect < 1.25 ? 0.13 : 0;
    trackDist = THREE.MathUtils.clamp(CYBERTRUCK_LENGTH / (Math.tan(THREE.MathUtils.degToRad(19)) * aspect), 9, 28);
    applyLens();
  }

  // Opening, in seconds, one continuous move: a low tracking shot along Highway 4 past the build site, a
  // speed-ramped drone chase toward the pads, down past the stack into a chase along the beach track, and
  // a pull-back to the wide vantage as the truck rolls to a stop. Anything else staged during the opening
  // (stacking the ship) keys off the same intro clock.
  const INTRO = { pass: 2.6, rise: 5.0, descend: 7.4, beach: 9.2, park: 11.8, total: 12.5 };
  const PARK_HEADING = 1.15;
  const parkDir = new THREE.Vector3(Math.cos(PARK_HEADING), 0, -Math.sin(PARK_HEADING));
  const START_X = -2240;
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
  let routeStart = 0;
  for (let u = 0; u < 1 && route.getPointAt(u).x < START_X; u += 1 / 6000) routeStart = u * routeLength;

  // Cruising speed plus a time-lapse ramp, scaled so the truck covers the route exactly by INTRO.park.
  const CRUISE = 31;
  const cruise = (time: number) => CRUISE * (1 - THREE.MathUtils.smoothstep(time, INTRO.beach + 0.8, INTRO.park));
  const ramp = (time: number) =>
    THREE.MathUtils.smoothstep(time, 2.4, 4.6) * (1 - THREE.MathUtils.smoothstep(time, 6.8, INTRO.beach + 1));
  const DIST_STEPS = 1000;
  const cruiseDist = new Float32Array(DIST_STEPS + 1);
  const rampDist = new Float32Array(DIST_STEPS + 1);
  for (let i = 1; i <= DIST_STEPS; i++) {
    const a = ((i - 1) / DIST_STEPS) * INTRO.park;
    const b = (i / DIST_STEPS) * INTRO.park;
    const h = b - a;
    cruiseDist[i] = cruiseDist[i - 1] + ((cruise(a) + cruise(b)) / 2) * h;
    rampDist[i] = rampDist[i - 1] + ((ramp(a) + ramp(b)) / 2) * h;
  }
  const rampSpeed = (routeLength - routeStart - cruiseDist[DIST_STEPS]) / rampDist[DIST_STEPS];
  function distanceAt(time: number) {
    const f = THREE.MathUtils.clamp(time / INTRO.park, 0, 1) * DIST_STEPS;
    const i = Math.min(DIST_STEPS - 1, Math.floor(f));
    const k = f - i;
    const c = cruiseDist[i] + (cruiseDist[i + 1] - cruiseDist[i]) * k;
    const r = rampDist[i] + (rampDist[i + 1] - rampDist[i]) * k;
    return Math.min(routeLength, routeStart + c + rampSpeed * r);
  }

  const tangent = new THREE.Vector3();
  /** Point at a distance along the route, continuing straight past either end. */
  function routeAt(d: number, out: THREE.Vector3) {
    const c = THREE.MathUtils.clamp(d, 0, routeLength);
    route.getPointAt(c / routeLength, out);
    if (c !== d) out.addScaledVector(route.getTangentAt(c / routeLength, tangent), d - c);
    return out;
  }

  const truckPos = new THREE.Vector3();
  const camFrom = new THREE.Vector3();
  const lookFrom = new THREE.Vector3();
  let trackDist = 10;
  let trackAim = 0;
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
    truck.group.rotation.set(0, Math.atan2(-tangent.z, tangent.x), Math.atan2(front - back, half * 2));
    for (const w of truck.wheels) w.rotation.z = (travelled - routeStart) / truck.wheelRadius;
    sun.target.position.copy(truckPos);
    sun.position.copy(truckPos).addScaledVector(sunDir, 60);
  }

  // Camera relative to the route: `back` meters behind the truck along it (negative is ahead), `side` to the
  // left of it, `up` above the road; it aims `lead` meters ahead of the truck along the route, `aimY` up,
  // and swings toward the stack (`toStack`) while passing the pads.
  const camKeys = [0, INTRO.pass, INTRO.rise, INTRO.descend, INTRO.beach, INTRO.beach + 1.2];
  const camOffset = new THREE.Vector3();
  const STACK_AIM = new THREE.Vector3(0, 70, 0);
  function introCamera(time: number) {
    const D = trackDist;
    const chase = Math.sqrt(D / 9);
    const at = (values: number[]) => monotoneKeys(camKeys, values, time);
    const back = at([-0.45 * D, -0.15 * D, 110, 110, 16 * chase, 9 * chase]);
    const side = at([1.05 * D, 1.05 * D, 26, 26, -6 * chase, -9 * chase]);
    const up = at([1.7, 1.7, 46, 40, 2.4, 1.7]);
    const lead = at([-D * trackAim, -D * trackAim, 150, 30, 6, 0]);
    const aimY = at([1.4 + 0.17 * D, 1.4 + 0.17 * D, 0, 0, 1, 1]);
    const toStack = monotoneKeys([INTRO.rise, 6.4, 7.4], [0, 0.75, 0], time);
    const d = travelled - back;
    routeAt(d, camFrom);
    route.getTangentAt(THREE.MathUtils.clamp(d / routeLength, 0, 1), tangent);
    camFrom.add(camOffset.set(tangent.z * side, up + coastHeight(camFrom.x, camFrom.z), -tangent.x * side));
    routeAt(travelled + lead, lookFrom).y = truckPos.y + aimY;
    lookFrom.lerp(STACK_AIM, toStack);
  }

  const lens = { fov: 32, offset: 0 };
  let lensK = 0;
  function applyLens() {
    camera.fov = THREE.MathUtils.lerp(38, lens.fov, lensK);
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
  let launchHeld = false;
  let pointerX = 0;
  let pointerY = 0;
  const look = LOOK_AT.clone();
  const lookNow = new THREE.Vector3();
  const lookDirA = new THREE.Vector3();
  const lookDirB = new THREE.Vector3();
  const camBase = new THREE.Vector3();
  const clock = new THREE.Clock();

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
      introT = introHold ?? Math.min(1, now / INTRO.total);
      const it = introT * INTRO.total;
      poseTruck(it);
      introCamera(it);
      // The pull-back to the vantage starts while the chase is still settling; the tilt up to the stack lags it.
      camK = easeInOut(THREE.MathUtils.clamp((it - INTRO.beach) / (INTRO.total - INTRO.beach), 0, 1));
      lookK = easeInOut(THREE.MathUtils.clamp((it - INTRO.beach - 0.6) / (INTRO.total - INTRO.beach - 0.6), 0, 1));
      lensK = camK;
      applyLens();
    } else if (lensK !== 1) {
      lensK = 1;
      applyLens();
    }

    let alt = 0;
    let vel = 0;
    let shake = 0;
    if (phase !== 'idle') {
      if (!launchHeld) t += dt;
      if (tower.qdArm) {
        const k = THREE.MathUtils.smoothstep(t, -8, -4);
        tower.qdArm.rotation.y = k * 1.4;
      }
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
    const rate = ventRate();
    if (rate > 0 && !launchHeld) {
      stack.updateMatrixWorld();
      for (const v of ventSpots) {
        v.pos.copy(v.local).applyMatrix4(stack.matrixWorld);
        v.dir.copy(v.localDir).transformDirection(stack.matrixWorld);
      }
      fx.vent(dt, rate, ventSpots);
    }
    clouds.update(now);

    const target = new THREE.Vector3(0, Math.max(LOOK_AT.y, MOUNT_H + alt + STACK_H * 0.35), 0);
    look.lerp(target, 1 - Math.exp(-dt * 2.5));
    camBase.set(
      CAMERA_POS.x + Math.sin(now * 0.07) * 0.6 + pointerX * 0.8,
      CAMERA_POS.y + pointerY * 0.15,
      CAMERA_POS.z,
    );
    camera.position.lerpVectors(camFrom, camBase, camK);
    // Blend look directions, not points: the truck is metres away and the stack hundreds.
    lookDirA.subVectors(lookFrom, camera.position).normalize();
    lookDirB.subVectors(look, camera.position).normalize();
    lookNow.copy(camera.position).add(lookDirA.lerp(lookDirB, lookK).normalize());
    camera.lookAt(lookNow);
    if (shake > 0) {
      camera.rotation.x += (Math.random() - 0.5) * shake;
      camera.rotation.y += (Math.random() - 0.5) * shake;
    }

    camera.updateMatrixWorld();
    puffs.begin();
    clouds.push(puffs);
    fx.push(puffs);
    puffs.commit(camera);

    renderer.render(scene, camera);
    onHud({ phase, t, alt, vel });
  }

  function reset() {
    phase = 'idle';
    t = 0;
    stack.position.y = MOUNT_H;
    plume.group.visible = false;
    flameLight.intensity = 0;
    if (tower.qdArm) tower.qdArm.rotation.y = 0;
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
    renderOnce() {
      introT = 1;
      poseTruck(INTRO.total);
      step();
    },
    skipIntro() {
      introT = 1;
      poseTruck(INTRO.total);
    },
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
      if (from > 0) look.set(0, Math.max(LOOK_AT.y, MOUNT_H + altitudeAt(from) + STACK_H * 0.35), 0);
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
