import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Batch, canvasTexture, hexTileTexture, mat4, panelTexture, ringTexture, splitByNormal } from './procedural';

// Starship V3 / Block 3 stack, in meters: 9 m diameter, Super Heavy ≈72 m, Ship ≈52 m, 124.4 m total.
export const R = 4.5;
export const BOOSTER_H = 72.3;
export const SHIP_H = 52.1;
export const STACK_H = BOOSTER_H + SHIP_H;
// Height of the booster's base above grade: top of the hold-down clamps on the Pad 2 mount.
export const MOUNT_H = 20;
export const TOWER_H = 146;
export const TOWER_W = 9.5;
export const TOWER_OFFSET = 21.5;

// The scene yaws the stack by this much about +y; the ship QD plate is placed to face the tower at world +z.
const SCENE_STACK_YAW = 0.55;

// Stack-local frame: polar angle φ measured from +x toward +z. The ship's leeward (steel) side faces φ = 0,
// its windward heat shield faces φ = π, and the aft flaps sit on the seams at φ = ±π/2.
const LEEWARD_FWD_FLAP = THREE.MathUtils.degToRad(70);

const SKIRT_H = 4.2;
const HOT_STAGE_H = 2.6;
const HOT_STAGE_Y = BOOSTER_H - HOT_STAGE_H;
const NOSE_H = 17.5;
const BARREL_H = SHIP_H - NOSE_H;

/** Places a part whose local +x points outward at polar angle `phi`, radius `r`, height `y`. */
function radial(phi: number, r: number, y: number, extra?: THREE.Matrix4) {
  const m = new THREE.Matrix4().makeRotationY(-phi).setPosition(Math.cos(phi) * r, y, Math.sin(phi) * r);
  return extra ? m.multiply(extra) : m;
}

function steelMaterial(rings: number, env: THREE.Texture | null) {
  const m = new THREE.MeshStandardMaterial({ map: ringTexture(rings, 176, 14), metalness: 0.95, roughness: 0.34 });
  if (env) m.envMap = env;
  return m;
}

/** Tangent ogive with a spherical blunt tip, scaled to NOSE_H. Points are (radius, height) from the nose base. */
function noseProfile() {
  const L = NOSE_H;
  const rho = (R * R + L * L) / (2 * R);
  const ogive = (y: number) => Math.sqrt(rho * rho - y * y) - (rho - R);
  const r1 = 1.25;
  const y1 = Math.sqrt(rho * rho - (r1 + rho - R) ** 2);
  const yc = ((rho - R) / (r1 + rho - R)) * y1;
  const a = Math.hypot(r1, y1 - yc);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 22; i++) {
    const y = y1 * (1 - Math.pow(1 - i / 22, 1.4));
    pts.push(new THREE.Vector2(ogive(y), y));
  }
  const t0 = Math.atan2(y1 - yc, r1);
  for (let i = 1; i <= 6; i++) {
    const t = t0 + ((Math.PI / 2 - t0) * i) / 6;
    pts.push(new THREE.Vector2(Math.max(0.001, a * Math.cos(t)), yc + a * Math.sin(t)));
  }
  const k = L / (yc + a);
  for (const p of pts) p.y *= k;
  const radiusAt = (y: number) => {
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].y >= y) {
        const f = (y - pts[i - 1].y) / (pts[i].y - pts[i - 1].y);
        return THREE.MathUtils.lerp(pts[i - 1].x, pts[i].x, f);
      }
    }
    return 0;
  };
  return { pts, radiusAt };
}

/**
 * A flap planform in (distance from the ship axis, height) extruded to `thickness`.
 * Shape +z is the windward (tiled) face; returns [tiled faces and edges, steel leeward face].
 */
function flapGeometry(outline: [number, number][], thickness: number) {
  const s = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const bevel = Math.min(0.12, thickness * 0.3);
  const geo = new THREE.ExtrudeGeometry(s, { depth: thickness - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2 });
  geo.translate(0, 0, -(thickness - 2 * bevel) / 2);
  const [windward, rest] = splitByNormal(geo, new THREE.Vector3(0, 0, 1));
  const [leeward, edges] = splitByNormal(rest, new THREE.Vector3(0, 0, -1));
  geo.dispose();
  return { tiled: mergeGeometries([windward, edges]), steel: leeward };
}

function engineBell() {
  const pts = [
    [0.2, 1.5],
    [0.27, 1.32],
    [0.38, 1.0],
    [0.48, 0.5],
    [0.56, 0.0],
    [0.62, -0.5],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const bell = new THREE.LatheGeometry(pts, 18);
  const throat = new THREE.CircleGeometry(0.21, 12);
  throat.rotateX(Math.PI / 2);
  throat.translate(0, 1.48, 0);
  return mergeGeometries([bell, throat]);
}

/**
 * Raptor 3 nozzle hanging from its throat at y = 0 down to the exit plane at −len: a short converging
 * neck, then a bell flaring to `exitR`. Lathe v runs from the exit lip (0) to the throat (1).
 */
export function raptorNozzle(exitR: number, len: number, seg = 28) {
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.3, 0.12), new THREE.Vector2(0.22, 0)];
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    pts.push(new THREE.Vector2(0.22 + (exitR - 0.22) * Math.pow(t, 0.62), -len * t));
  }
  pts.push(new THREE.Vector2(exitR + 0.025, -len), new THREE.Vector2(exitR + 0.025, -len + 0.08));
  return new THREE.LatheGeometry(pts.reverse(), seg);
}

/** Compact Raptor 3 powerhead above the throat: turbopump body, injector dome and the two preburner domes. */
export function raptorPowerhead(h: number) {
  const parts = [
    new THREE.CylinderGeometry(0.42, 0.34, h * 0.6, 16).translate(0, h * 0.3 + 0.1, 0),
    new THREE.SphereGeometry(0.42, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, h * 0.6 + 0.1, 0),
    new THREE.CylinderGeometry(0.17, 0.17, h * 0.7, 10).translate(0.42, h * 0.45, 0),
    new THREE.CylinderGeometry(0.17, 0.17, h * 0.7, 10).translate(-0.42, h * 0.45, 0),
  ];
  return mergeGeometries(parts.map((g) => g.toNonIndexed()));
}

/** Regeneratively cooled nozzle steel: copper-bronze at the throat, blue-violet heat tint toward the lip. */
function heatTintTexture() {
  return canvasTexture(4, 256, (ctx) => {
    const grad = ctx.createLinearGradient(0, 256, 0, 0);
    grad.addColorStop(0, '#8a8a90');
    grad.addColorStop(0.06, '#2c2d35');
    grad.addColorStop(0.4, '#3c3c48');
    grad.addColorStop(0.72, '#55463e');
    grad.addColorStop(1, '#6e5442');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
  });
}

export function buildStack(env: THREE.Texture | null) {
  const stack = new THREE.Group();
  stack.name = 'stack';
  const b = new Batch();
  const box = new THREE.BoxGeometry(1, 1, 1);

  const tile = hexTileTexture();
  const tileMat = (u: number, v: number) => {
    const map = tile.tex.clone();
    map.repeat.set(u, v);
    map.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ map, roughness: 0.82, metalness: 0.05 });
  };
  const plain = new THREE.MeshStandardMaterial({ color: 0xb4b4b8, metalness: 0.95, roughness: 0.36 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x26272a, metalness: 0.6, roughness: 0.6 });
  const finMat = new THREE.MeshStandardMaterial({ color: 0x3c3d41, metalness: 0.8, roughness: 0.48 });
  const raceway = new THREE.MeshStandardMaterial({ color: 0x8a8b8f, metalness: 0.8, roughness: 0.55 });
  if (env) for (const m of [plain, dark, finMat, raceway]) m.envMap = env;

  // Super Heavy: ring-welded tanks over an aft skirt that darkens with engine soot toward the base.
  const tankH = HOT_STAGE_Y - SKIRT_H;
  const boosterMat = steelMaterial(Math.round(tankH / 1.83), env);
  b.add(new THREE.CylinderGeometry(R, R, tankH, 72, 1, true), boosterMat, mat4(0, SKIRT_H + tankH / 2));
  const skirtMat = new THREE.MeshStandardMaterial({
    map: canvasTexture(4, 256, (ctx) => {
      const grad = ctx.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0, 'rgb(176,176,180)');
      grad.addColorStop(0.55, 'rgb(150,148,146)');
      grad.addColorStop(1, 'rgb(52,48,46)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 4, 256);
    }),
    metalness: 0.9,
    roughness: 0.42,
  });
  if (env) skirtMat.envMap = env;
  b.add(new THREE.CylinderGeometry(R + 0.04, R + 0.12, SKIRT_H, 72, 1, true), skirtMat, mat4(0, SKIRT_H / 2));
  b.add(new THREE.CylinderGeometry(R + 0.18, R + 0.18, 0.35, 72, 1, true), dark, mat4(0, 0.18));
  const puck = new THREE.CircleGeometry(R + 0.1, 48);
  puck.rotateX(Math.PI / 2);
  b.add(puck, dark, mat4(0, 1.55));

  // Raceway and the pair of chines on the LOX tank.
  b.add(box, raceway, radial(0.35, R + 0.15, (5 + HOT_STAGE_Y - 1) / 2, mat4(0, 0, 0, 0, 0, 0, 0.36, HOT_STAGE_Y - 6, 0.8)));
  for (const phi of [Math.PI / 2, -Math.PI / 2]) {
    b.add(box, plain, radial(phi, R, 19, mat4(0, 0, 0, 0, Math.PI / 4, 0, 0.8, 26, 0.8)));
  }

  // Integrated V3 hot-stage: open vent bays with a zig-zag truss in front of the booster's forward dome.
  const bays = 20;
  const bayH = HOT_STAGE_H - 0.8;
  b.add(new THREE.CylinderGeometry(R, R, 0.4, 72, 1, true), plain, mat4(0, HOT_STAGE_Y + 0.2));
  b.add(new THREE.CylinderGeometry(R, R, 0.4, 72, 1, true), plain, mat4(0, BOOSTER_H - 0.2));
  b.add(new THREE.CylinderGeometry(R - 0.45, R - 0.45, HOT_STAGE_H, 48, 1, true), dark, mat4(0, HOT_STAGE_Y + HOT_STAGE_H / 2));
  b.add(new THREE.SphereGeometry(R - 0.45, 32, 6, 0, Math.PI * 2, 0, Math.PI / 2), dark, mat4(0, HOT_STAGE_Y + 0.3, 0, 0, 0, 0, 1, 0.4, 1));
  const bayW = (2 * Math.PI * (R - 0.15)) / bays;
  const diag = Math.hypot(bayW, bayH);
  const tilt = Math.atan2(bayW, bayH);
  for (let i = 0; i < bays; i++) {
    const phi = (i / bays) * Math.PI * 2;
    b.add(box, plain, radial(phi, R - 0.12, HOT_STAGE_Y + HOT_STAGE_H / 2, mat4(0, 0, 0, 0, 0, 0, 0.34, bayH, 0.3)));
    const mid = phi + Math.PI / bays;
    b.add(box, plain, radial(mid, R - 0.2, HOT_STAGE_Y + HOT_STAGE_H / 2, mat4(0, 0, 0, i % 2 ? tilt : -tilt, 0, 0, 0.2, diag, 0.2)));
  }

  // Three enlarged grid fins in a T: two on the flap seams and one under the heat shield, on pods welded
  // to the methane tank with a catch point on top.
  const finY = HOT_STAGE_Y - 4.6;
  const W = 5.4;
  const S = 4.6;
  const C = 0.55;
  const r0 = R + 1.1;
  for (const phi of [Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const base = radial(phi, 0, finY);
    const bar = (x0: number, z0: number, x1: number, z1: number, t: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const m = mat4((x0 + x1) / 2, 0, (z0 + z1) / 2, 0, -Math.atan2(z1 - z0, x1 - x0), 0, len + t, C, t);
      b.add(box, finMat, base.clone().multiply(m));
    };
    bar(r0, -S / 2, r0 + W, -S / 2, 0.12);
    bar(r0, S / 2, r0 + W, S / 2, 0.12);
    bar(r0 + W, -S / 2, r0 + W, S / 2, 0.12);
    bar(r0, -S / 2, r0, S / 2, 0.12);
    const d = 0.62;
    for (let c = -S / 2 + d / 2; c < W + S / 2; c += d) {
      const xa = Math.max(0, c - S / 2);
      const xb = Math.min(W, c + S / 2);
      if (xb - xa < 0.1) continue;
      bar(r0 + xa, xa - c, r0 + xb, xb - c, 0.035);
      bar(r0 + xa, c - xa, r0 + xb, c - xb, 0.035);
    }
    b.add(box, dark, base.clone().multiply(mat4(R + 0.6, 0, 0, 0, 0, 0, 1.1, 1.6, 1.8)));
    b.add(box, dark, base.clone().multiply(mat4(R + 0.65, 1.1, 0, 0, 0, 0, 0.8, 0.5, 0.8)));
  }

  // 33 Raptor 3s: no engine shrouds on V3, so the bells sit bare under the thrust puck.
  const bells: [number, number, number][] = [];
  for (let i = 0; i < 3; i++) bells.push([0.95, (i / 3) * Math.PI * 2 + Math.PI / 2, 1]);
  for (let i = 0; i < 10; i++) bells.push([2.45, (i / 10) * Math.PI * 2, 1]);
  for (let i = 0; i < 20; i++) bells.push([3.88, ((i + 0.5) / 20) * Math.PI * 2, 0.94]);
  const bellMat = new THREE.MeshStandardMaterial({ color: 0x3d3532, metalness: 0.75, roughness: 0.42, side: THREE.DoubleSide });
  if (env) bellMat.envMap = env;
  const engines = new THREE.InstancedMesh(engineBell(), bellMat, bells.length);
  bells.forEach(([r, a, s], i) => engines.setMatrixAt(i, mat4(Math.cos(a) * r, 0, Math.sin(a) * r, 0, 0, 0, s, s, s)));
  engines.castShadow = true;
  stack.add(engines);

  // Ship: steel leeward half, black hexagonal heat-shield tiles on the windward half.
  const sb = new Batch();
  const shipSteel = steelMaterial(19, env);
  const noseSteel = steelMaterial(9, env);
  const halfCirc = Math.PI * (R + 0.03);
  const { pts: nose, radiusAt } = noseProfile();
  const tilesBarrel = tileMat(halfCirc / tile.width, BARREL_H / tile.height);
  const tilesNose = tileMat(halfCirc / tile.width, 19.5 / tile.height);
  const tilesFlap = tileMat(1 / tile.width, 1 / tile.height);
  sb.add(new THREE.CylinderGeometry(R, R, BARREL_H, 64, 1, true, 0, Math.PI), shipSteel, mat4(0, BARREL_H / 2));
  sb.add(new THREE.CylinderGeometry(R + 0.03, R + 0.03, BARREL_H, 64, 1, true, Math.PI, Math.PI), tilesBarrel, mat4(0, BARREL_H / 2));
  sb.add(new THREE.LatheGeometry(nose, 48, 0, Math.PI), noseSteel, mat4(0, BARREL_H));
  sb.add(new THREE.LatheGeometry(nose.map((v) => new THREE.Vector2(v.x + 0.03, v.y)), 48, Math.PI, Math.PI), tilesNose, mat4(0, BARREL_H));

  // Aft flaps: large clipped trapezoids hinged on the seams, with a steel aerocover over the hinge line
  // and the single V3 actuator housing at the top of the root.
  const aftT = 0.55;
  const aft = flapGeometry(
    [
      [R - 0.05, 0.4],
      [R + 3.9, 0.4],
      [R + 4.35, 0.95],
      [R + 4.35, 6.6],
      [R + 0.9, 11.3],
      [R - 0.05, 11.6],
    ],
    aftT,
  );
  // Forward flaps: smaller, swept, and rooted on the nosecone following its curve, rotated 20° leeward.
  const fwdT = 0.34;
  const ya = BARREL_H + 2.6;
  const yb = BARREL_H + 9.4;
  const rootPts: [number, number][] = [];
  for (let i = 8; i >= 0; i--) {
    const y = ya + ((yb - ya) * i) / 8;
    rootPts.push([radiusAt(y - BARREL_H) - 0.05, y]);
  }
  const rb = rootPts[rootPts.length - 1][0];
  const rt = rootPts[0][0];
  const fwd = flapGeometry([[rb, ya], [rb + 2.9, ya + 0.9], [rb + 2.55, ya + 3.3], ...rootPts.slice(0, -1)], fwdT);
  const cover = new THREE.CylinderGeometry(1, 1, 10.6, 16);
  const fwdCoverLen = Math.hypot(rb - rt, yb - ya);
  const fwdCover = new THREE.CylinderGeometry(0.3, 0.3, fwdCoverLen, 10);
  const fwdLean = Math.atan2(rb - rt, yb - ya);

  for (const side of [1, -1]) {
    const flip = mat4(0, 0, 0, 0, 0, 0, 1, 1, side);
    const aftFrame = new THREE.Matrix4().makeRotationY((-side * Math.PI) / 2).multiply(flip);
    sb.add(aft.tiled, tilesFlap, aftFrame);
    sb.add(aft.steel, plain, aftFrame);
    sb.add(cover, plain, aftFrame.clone().multiply(mat4(R - 0.1, 6.0, -(aftT / 2 + 0.3), 0, 0, 0, 0.6, 1, 0.8)));
    sb.add(box, plain, aftFrame.clone().multiply(mat4(R + 0.35, 10.5, -(aftT / 2 + 0.55), 0, 0, 0, 1.6, 1.8, 1.0)));

    const fwdFrame = new THREE.Matrix4().makeRotationY(-side * LEEWARD_FWD_FLAP).multiply(flip);
    sb.add(fwd.tiled, tilesFlap, fwdFrame);
    sb.add(fwd.steel, plain, fwdFrame);
    sb.add(fwdCover, plain, fwdFrame.clone().multiply(mat4((rb + rt) / 2 + 0.05, (ya + yb) / 2, -(fwdT / 2 + 0.1), 0, 0, fwdLean)));
  }

  // Engine bay, seen from below while the ship is off the booster: a steel liner up to the aft dome,
  // three sea-level Raptors (1.3 m exits) on the thrust puck and three RVacs (2.3 m exits) on the
  // outer ring. The pattern is mirror-symmetric about the windward/leeward plane: RVacs at φ = 0 and
  // ±120° sit between the aft flap roots, sea-level engines at 180° and ±60°. RVac exits end almost
  // flush with the skirt edge; the gimballing sea-level bells hang a little higher.
  const bayTop = 5;
  const liner = new THREE.MeshStandardMaterial({ color: 0x5a5b60, metalness: 0.7, roughness: 0.5, side: THREE.BackSide });
  sb.add(new THREE.CylinderGeometry(R - 0.04, R - 0.04, bayTop, 64, 1, true), liner, mat4(0, bayTop / 2));
  const bulkhead = new THREE.CircleGeometry(R - 0.04, 48);
  bulkhead.rotateX(Math.PI / 2);
  sb.add(bulkhead, raceway, mat4(0, bayTop));
  const thrustPuck = new THREE.CircleGeometry(1.75, 32);
  thrustPuck.rotateX(Math.PI / 2);
  sb.add(thrustPuck, dark, mat4(0, bayTop - 0.06));
  const nozzleMat = new THREE.MeshStandardMaterial({ map: heatTintTexture(), metalness: 0.85, roughness: 0.38, side: THREE.DoubleSide });
  if (env) nozzleMat.envMap = env;
  const SL = { r: 0.95, exitR: 0.65, len: 2.05, throat: 2.95 };
  const VAC = { r: 3.18, exitR: 1.15, len: 3.7, throat: 3.8 };
  for (let i = 0; i < 3; i++) {
    const vac = (i / 3) * Math.PI * 2;
    const sl = vac + Math.PI;
    for (const [e, a] of [[SL, sl], [VAC, vac]] as const) {
      const x = Math.cos(a) * e.r;
      const z = Math.sin(a) * e.r;
      sb.add(raptorNozzle(e.exitR, e.len), nozzleMat, mat4(x, e.throat, z));
      sb.add(raptorPowerhead(bayTop - e.throat), dark, mat4(x, e.throat, z, 0, -a, 0));
    }
  }

  // Leeward raceway, and the ship QD plate where the tower's ship arm docks.
  sb.add(box, raceway, radial(0.95, R + 0.12, 23, mat4(0, 0, 0, 0, 0, 0, 0.3, 22, 0.6)));
  sb.add(box, dark, radial(Math.PI / 2 + SCENE_STACK_YAW, R + 0.1, 20, mat4(0, 0, 0, 0, 0, 0, 0.3, 3.4, 3.0)));

  // Ship lifting pins just below the forward flaps, facing the chopsticks when stacked.
  for (const phi of [SCENE_STACK_YAW, SCENE_STACK_YAW + Math.PI]) {
    sb.add(box, dark, radial(phi, R + 0.45, SHIP_LIFT_PIN_Y, mat4(0, 0, 0, 0, 0, 0, 1.0, 0.6, 0.9)));
  }

  for (const mesh of b.build()) stack.add(mesh);
  const ship = new THREE.Group();
  ship.name = 'ship';
  ship.position.y = BOOSTER_H;
  for (const mesh of sb.build()) ship.add(mesh);
  stack.add(ship);
  return stack;
}

// Pad 2 ground systems: a raised concrete plinth cut by a steel-lined flame trench along ±x (the tower stands
// beside it at +z), a double-sided water-cooled flame bucket under a cuboid launch mount with a round opening,
// 20 hold-down clamps, and two hooded booster quick disconnects.
export const PLINTH_H = 6;
const TRENCH_HALF_W = 8;
const PLINTH_HALF_L = 36;
const MOUNT_HALF = 13;
const MOUNT_DECK = MOUNT_H - 1.2;
const OPENING_R = R + 1.7;

export function buildMount(env: THREE.Texture | null) {
  const g = new THREE.Group();
  const b = new Batch();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8f8b83, roughness: 0.95 });
  const trenchSteel = new THREE.MeshStandardMaterial({ color: 0x75726f, metalness: 0.7, roughness: 0.55 });
  const scorched = new THREE.MeshStandardMaterial({ color: 0x4d4643, metalness: 0.6, roughness: 0.62 });
  const cladTex = panelTexture(138, 'rgba(70,72,76,0.9)');
  cladTex.repeat.set(1 / 4, 1 / 4);
  const clad = new THREE.MeshStandardMaterial({ map: cladTex, metalness: 0.6, roughness: 0.45 });
  const deckTex = panelTexture(96, 'rgba(40,40,42,0.95)');
  deckTex.repeat.set(1 / 3.2, 1 / 3.2);
  const deck = new THREE.MeshStandardMaterial({ map: deckTex, metalness: 0.7, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, metalness: 0.5, roughness: 0.6 });
  if (env) for (const m of [trenchSteel, scorched, clad, deck, dark]) m.envMap = env;

  // Plinth halves either side of the trench: vertical trench walls, sloped outer berms.
  for (const s of [1, -1]) {
    const u = (v: number) => s * v;
    const shape = new THREE.Shape([
      new THREE.Vector2(u(TRENCH_HALF_W), 0),
      new THREE.Vector2(u(40), 0),
      new THREE.Vector2(u(34), PLINTH_H),
      new THREE.Vector2(u(TRENCH_HALF_W), PLINTH_H),
    ]);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: PLINTH_HALF_L * 2, bevelEnabled: false });
    geo.translate(0, 0, -PLINTH_HALF_L);
    b.add(geo, concrete, mat4(0, 0, 0, 0, Math.PI / 2));
    b.add(box, trenchSteel, mat4(0, PLINTH_H / 2, -s * (TRENCH_HALF_W - 0.15), 0, 0, 0, PLINTH_HALF_L * 2, PLINTH_H, 0.3));
  }
  b.add(box, trenchSteel, mat4(0, 0.12, 0, 0, 0, 0, PLINTH_HALF_L * 2, 0.24, TRENCH_HALF_W * 2 - 0.6));

  // Flame bucket: two concave halves meeting at a ridge cap directly under the opening.
  const bucketHalf = 16;
  const bucketW = TRENCH_HALF_W * 2 - 0.6;
  const curve: THREE.Vector2[] = [new THREE.Vector2(-bucketHalf, 0.24), new THREE.Vector2(bucketHalf, 0.24)];
  for (let i = 0; i <= 28; i++) {
    const x = bucketHalf - (2 * bucketHalf * i) / 28;
    curve.push(new THREE.Vector2(x, 0.24 + 5.1 * Math.pow(1 - Math.abs(x) / bucketHalf, 1.7)));
  }
  const bucket = new THREE.ExtrudeGeometry(new THREE.Shape(curve), { depth: bucketW, bevelEnabled: false });
  bucket.translate(0, 0, -bucketW / 2);
  b.add(bucket, scorched);
  const ridge = new THREE.CylinderGeometry(0.6, 0.6, bucketW, 14);
  ridge.rotateX(Math.PI / 2);
  b.add(ridge, trenchSteel, mat4(0, 5.3, 0));
  for (const x of [-12.2, 12.2]) for (const z of [-6.6, 6.6]) b.add(box, trenchSteel, mat4(x, PLINTH_H / 2, z, 0, 0, 0, 1.2, PLINTH_H, 1.2));

  // Launch mount: clad cuboid with a round opening, water-cooled steel top deck, dark trim at the deck edge.
  const outline = new THREE.Shape([
    new THREE.Vector2(-MOUNT_HALF, -MOUNT_HALF),
    new THREE.Vector2(MOUNT_HALF, -MOUNT_HALF),
    new THREE.Vector2(MOUNT_HALF, MOUNT_HALF),
    new THREE.Vector2(-MOUNT_HALF, MOUNT_HALF),
  ]);
  outline.holes.push(new THREE.Path().absarc(0, 0, OPENING_R, 0, Math.PI * 2, true));
  const block = new THREE.ExtrudeGeometry(outline, { depth: MOUNT_DECK - PLINTH_H, bevelEnabled: false, curveSegments: 48 });
  block.rotateX(-Math.PI / 2);
  block.translate(0, PLINTH_H, 0);
  const [top, rest] = splitByNormal(block, new THREE.Vector3(0, 1, 0));
  const [under, sides] = splitByNormal(rest, new THREE.Vector3(0, -1, 0));
  b.add(top, deck).add(under, scorched).add(sides, clad);
  for (const [x, z, sx, sz] of [
    [0, MOUNT_HALF, MOUNT_HALF * 2 + 0.3, 0.3],
    [0, -MOUNT_HALF, MOUNT_HALF * 2 + 0.3, 0.3],
    [MOUNT_HALF, 0, 0.3, MOUNT_HALF * 2 + 0.3],
    [-MOUNT_HALF, 0, 0.3, MOUNT_HALF * 2 + 0.3],
  ]) {
    b.add(box, dark, mat4(x, MOUNT_DECK - 0.35, z, 0, 0, 0, sx, 0.7, sz));
    b.add(box, dark, mat4(x, PLINTH_H + 4.6, z, 0, 0, 0, sx, 0.25, sz));
  }
  // Exposed columns at the corners and mid-faces of the mount's steel frame.
  const colH = MOUNT_DECK - PLINTH_H;
  for (const x of [-MOUNT_HALF, 0, MOUNT_HALF]) {
    for (const z of [-MOUNT_HALF, 0, MOUNT_HALF]) {
      if (x === 0 && z === 0) continue;
      b.add(box, trenchSteel, mat4(x, PLINTH_H + colH / 2, z, 0, 0, 0, x === 0 ? 1.0 : 0.9, colH, z === 0 ? 1.0 : 0.9));
    }
  }

  // 22 slots around the opening: 20 hold-down clamps with support shelves, and two BQD hoods facing the tower.
  const slots = 22;
  const hood = new THREE.ExtrudeGeometry(
    new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(4.6, 0), new THREE.Vector2(4.6, 0.9), new THREE.Vector2(1.0, 3.4), new THREE.Vector2(0, 3.4)]),
    { depth: 1.9, bevelEnabled: false },
  );
  hood.translate(0, 0, -0.95);
  for (let k = 0; k < slots; k++) {
    const a = Math.PI / 2 + (k * Math.PI * 2) / slots;
    if (k === 2 || k === slots - 2) {
      b.add(hood, clad, radial(a, R + 0.6, MOUNT_DECK));
      b.add(box, dark, radial(a, R + 0.62, MOUNT_DECK + 1.3, mat4(0, 0, 0, 0, 0, 0, 0.08, 2.0, 1.4)));
      continue;
    }
    b.add(box, dark, radial(a, R + 1.35, MOUNT_DECK + 1.2, mat4(0, 0, 0, 0, 0, 0, 2.4, 2.4, 0.9)));
    b.add(box, dark, radial(a, R - 0.2, MOUNT_H - 0.25, mat4(0, 0, 0, 0, 0, 0, 1.0, 0.5, 0.8)));
  }

  // Service structure (GSE bunker) beside the mount on the tower side, with feed lines into the mount.
  b.add(box, clad, mat4(-23, PLINTH_H + 4.5, 19, 0, 0, 0, 12, 9, 14));
  const pipe = new THREE.CylinderGeometry(0.45, 0.45, 4.2, 10);
  pipe.rotateZ(Math.PI / 2);
  for (const z of [10.6, 12.0]) b.add(pipe, trenchSteel, mat4(-15.1, PLINTH_H + 2.6, z));

  for (const mesh of b.build()) g.add(mesh);
  return g;
}

// Collects box "bars" between two points and turns them into one InstancedMesh per material.
class BarSet {
  private bars: THREE.Matrix4[] = [];
  private tmp = new THREE.Object3D();
  private up = new THREE.Vector3(0, 1, 0);
  add(a: THREE.Vector3, b: THREE.Vector3, thick: number, depth = thick) {
    const t = this.tmp;
    t.position.copy(a).add(b).multiplyScalar(0.5);
    t.scale.set(thick, a.distanceTo(b), depth);
    t.quaternion.setFromUnitVectors(this.up, b.clone().sub(a).normalize());
    t.updateMatrix();
    this.bars.push(t.matrix.clone());
  }
  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, thick: number) {
    this.add(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), thick);
  }
  mesh(mat: THREE.Material) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, this.bars.length);
    this.bars.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.castShadow = true;
    inst.receiveShadow = true;
    return inst;
  }
}

// A rectangular box truss along +x from the origin: four chords, verticals, and alternating diagonals.
function truss(bars: BarSet, len: number, h: number, w: number, bay: number, chord: number, web: number, x0 = 0, y0 = 0, z0 = 0) {
  const n = Math.max(1, Math.round(len / bay));
  const step = len / n;
  for (const y of [-h / 2, h / 2]) for (const z of [-w / 2, w / 2]) bars.line(x0, y0 + y, z0 + z, x0 + len, y0 + y, z0 + z, chord);
  for (let i = 0; i <= n; i++) {
    const x = x0 + i * step;
    for (const z of [-w / 2, w / 2]) bars.line(x, y0 - h / 2, z0 + z, x, y0 + h / 2, z0 + z, web);
    bars.line(x, y0 + h / 2, z0 - w / 2, x, y0 + h / 2, z0 + w / 2, web);
    if (i === n) break;
    const flip = i % 2 ? 1 : -1;
    for (const z of [-w / 2, w / 2]) bars.line(x, y0 - flip * h / 2, z0 + z, x + step, y0 + flip * h / 2, z0 + z, web);
  }
}

// Mechazilla-style launch tower: galvanized square lattice with X-braced bays, decks, a crown, black truss arms.
// Arms point toward +x, where the launch mount sits.
export function buildTower(env: THREE.Texture | null, withArms = true) {
  const g = new THREE.Group();
  const galv = new THREE.MeshStandardMaterial({ color: 0xb4b8bc, metalness: 0.75, roughness: 0.42 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, metalness: 0.5, roughness: 0.55 });
  const grating = new THREE.MeshStandardMaterial({ color: 0x6d7074, metalness: 0.6, roughness: 0.6 });
  for (const m of [galv, black, grating]) if (env) m.envMap = env;

  const half = TOWER_W / 2;
  const BAYS = 30;
  const bay = TOWER_H / BAYS;
  const lat = new BarSet();
  const corners: [number, number][] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  for (const [x, z] of corners) lat.line(x, 0, z, x, TOWER_H, z, 1.15);
  for (let s = 0; s <= BAYS; s++) {
    const y = s * bay;
    for (let c = 0; c < 4; c++) {
      const [x1, z1] = corners[c];
      const [x2, z2] = corners[(c + 1) % 4];
      lat.line(x1, y, z1, x2, y, z2, s % 6 === 0 ? 0.8 : 0.5);
      if (s === BAYS) continue;
      // Full X on every face, with a mid-face post, like the real tower's bays.
      lat.line(x1, y, z1, x2, y + bay, z2, 0.32);
      lat.line(x2, y, z2, x1, y + bay, z1, 0.32);
      lat.line((x1 + x2) / 2, y, (z1 + z2) / 2, (x1 + x2) / 2, y + bay, (z1 + z2) / 2, 0.3);
    }
  }

  // Crown: a wider frame above the lattice that carries the hoist sheaves.
  const crownY = TOWER_H;
  const ch = half + 1.2;
  const crownCorners: [number, number][] = [
    [-ch, -ch],
    [ch, -ch],
    [ch, ch],
    [-ch, ch],
  ];
  for (const [x, z] of crownCorners) lat.line(x, crownY - 2, z, x, crownY + 7, z, 0.7);
  for (const y of [crownY, crownY + 3.5, crownY + 7]) {
    for (let c = 0; c < 4; c++) {
      const [x1, z1] = crownCorners[c];
      const [x2, z2] = crownCorners[(c + 1) % 4];
      lat.line(x1, y, z1, x2, y, z2, 0.45);
      if (y < crownY + 7) lat.line(x1, y, z1, x2, y + 3.5, z2, 0.25);
    }
  }
  g.add(lat.mesh(galv));

  const sheaves = new THREE.Mesh(new THREE.BoxGeometry(TOWER_W - 1, 3.2, TOWER_W - 3), black);
  sheaves.position.y = crownY + 5.2;
  g.add(sheaves);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.45, 14, 8), galv);
  rod.position.set(-half + 1, crownY + 14, -half + 1);
  g.add(rod);

  // Grated decks every six bays.
  const deckGeo = new THREE.BoxGeometry(TOWER_W + 2.4, 0.35, TOWER_W + 2.4);
  for (let s = 6; s < BAYS; s += 6) {
    const deck = new THREE.Mesh(deckGeo, grating);
    deck.position.y = s * bay;
    deck.castShadow = true;
    g.add(deck);
  }

  // Propellant and electrical runs up the back face.
  const pipeGeo = new THREE.CylinderGeometry(0.32, 0.32, MOUNT_H + BOOSTER_H + 22, 10);
  for (let i = 0; i < 3; i++) {
    const pipe = new THREE.Mesh(pipeGeo, i === 1 ? black : galv);
    pipe.position.set(-half - 0.6, (MOUNT_H + BOOSTER_H + 22) / 2, -2 + i * 1.6);
    g.add(pipe);
  }

  const tower: Tower = { group: g, setPose: () => {} };
  if (withArms) {
    // Chopsticks on a carriage that rides the tower.
    const carriage = new THREE.Group();
    const cb = new BarSet();
    const cw = CARRIAGE_HALF;
    for (const y of [-3.5, 3.5]) {
      cb.line(-cw, y, -cw, cw, y, -cw, 0.9);
      cb.line(-cw, y, cw, cw, y, cw, 0.9);
      cb.line(-cw, y, -cw, -cw, y, cw, 0.9);
      cb.line(cw, y, -cw, cw, y, cw, 0.9);
    }
    for (const [x, z] of [[-cw, -cw], [cw, -cw], [cw, cw], [-cw, cw]]) cb.line(x, -3.5, z, x, 3.5, z, 0.9);
    cb.line(cw, -3.5, -cw, cw, 3.5, cw, 0.5);
    cb.line(cw, -3.5, cw, cw, 3.5, -cw, 0.5);
    carriage.add(cb.mesh(black));
    const pivots: THREE.Group[] = [];
    for (const side of ARM_SIDES) {
      const pivot = new THREE.Group();
      pivot.position.set(cw, 0, side * ARM_PIVOT_Z);
      const ab = new BarSet();
      truss(ab, ARM_LEN, 3.4, 1.8, 3.4, 0.38, 0.18, 0, 0, 0);
      pivot.add(ab.mesh(black));
      // Catch rail along the inner face of each arm; the vehicle's pins seat on top of it.
      const rail = new THREE.Mesh(new THREE.BoxGeometry(ARM_LEN - 9, 0.6, 0.6), galv);
      rail.position.set((ARM_LEN + 9) / 2, RAIL_TOP - 0.3, -side * (GRIP_R - R - 0.3));
      pivot.add(rail);
      carriage.add(pivot);
      pivots.push(pivot);
    }
    g.add(carriage);
    tower.carriage = carriage;

    // Ship transport stand on the plinth, inside the reach of the arm tips.
    const stand = new BarSet();
    const ringY = [STAND_TOP - PLINTH_H - 0.25, 0.25];
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2;
      const a1 = ((i + 1) / 8) * Math.PI * 2;
      const p = (a: number, r: number) => [STAND.x + Math.cos(a) * r, STAND.z + Math.sin(a) * r];
      const [x0, z0] = p(a0, R + 0.2);
      const [x1, z1] = p(a1, R + 0.2);
      for (const y of ringY) stand.line(x0, PLINTH_H + y, z0, x1, PLINTH_H + y, z1, 0.5);
      stand.line(x0, PLINTH_H, z0, x0, STAND_TOP, z0, 0.45);
    }
    g.add(stand.mesh(black));

    // Ship quick-disconnect arm, docked at the ship's QD plate.
    const qd = new THREE.Group();
    qd.position.set(half, MOUNT_H + BOOSTER_H + 20, -2);
    const reach = TOWER_OFFSET - half - R + 0.3;
    const qb = new BarSet();
    truss(qb, reach - 1.2, 3, 2.6, 2.4, 0.32, 0.16, 0, 0, 0);
    qd.add(qb.mesh(black));
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(1.4, 4.2, 4.6), black);
    clamp.position.x = reach - 0.7;
    qd.add(clamp);
    g.add(qd);
    tower.qdArm = qd;

    tower.setPose = (p) => {
      carriage.position.y = p.carriageY;
      ARM_SIDES.forEach((side, i) => (pivots[i].rotation.y = -armYaw(side, p.holdX, p.holdZ, p.armsOpen)));
      qd.rotation.y = p.qdArm * QD_SWING;
    };
    tower.setPose(padSequence({ introS: 1, introTotal: 1, launchT: null }).pose);
  }

  return tower;
}

// ---------------------------------------------------------------------------------------------------------
// Pad sequence. Tower-local frame: +x out of the tower face toward the mount (the stack axis is at
// x = TOWER_OFFSET, z = 0), +z along the face (world east in the scene), y = height above grade.

export type TowerPose = {
  /** Height of the chopstick carriage centerline. */
  carriageY: number;
  /** Tower-local point the arms close around (the held vehicle's axis, or the stack when parked). */
  holdX: number;
  holdZ: number;
  /** 0 = rails touching a 9 m vehicle at the hold point, 1 = swung fully open. */
  armsOpen: number;
  /** 0 = ship QD arm docked, 1 = swung clear. */
  qdArm: number;
};

export type Tower = {
  group: THREE.Group;
  carriage?: THREE.Group;
  qdArm?: THREE.Group;
  setPose: (pose: TowerPose) => void;
};

/** Tower-local ship base position and yaw relative to its stacked orientation; null once it sits on the booster. */
export type PadState = { pose: TowerPose; ship: { x: number; y: number; z: number; yaw: number } | null };

const CARRIAGE_HALF = TOWER_W / 2 + 1.4;
const ARM_SIDES = [-1, 1] as const;
const ARM_PIVOT_Z = 3.6;
const ARM_LEN = 41;
const RAIL_TOP = 2.2;
const GRIP_R = R + 1.4;
const ARMS_OPEN_MAX = 0.5;
const QD_SWING = 1.4;
/** Ship-local height of the lifting pins the chopsticks pick it up by. */
export const SHIP_LIFT_PIN_Y = BARREL_H + 1.5;

const STAND_TOP = PLINTH_H + 2;
// North plinth, east of the mount: clear of the mount block, and close enough that the arm tips reach it.
const STAND = { x: TOWER_OFFSET + 13, z: 25.5 };
const PARK_Y = MOUNT_H + BOOSTER_H - 2;
const carriageForShipBase = (y: number) => y + SHIP_LIFT_PIN_Y - RAIL_TOP;
const PICK_Y = carriageForShipBase(STAND_TOP);
const HIGH_Y = carriageForShipBase(MOUNT_H + BOOSTER_H + 4);
const STACK_Y = carriageForShipBase(MOUNT_H + BOOSTER_H);
/** After stacking the arms stay swung wide open, so the vehicle can lift off between them. */
const IDLE_OPEN = 1;

/** Yaw of one arm about its pivot so its catch rail is tangent to a vehicle at the hold point, plus opening. */
function armYaw(side: number, hx: number, hz: number, open: number) {
  const vx = hx - CARRIAGE_HALF;
  const vz = hz - side * ARM_PIVOT_Z;
  const tangent = Math.asin(Math.min(1, GRIP_R / Math.hypot(vx, vz)));
  return Math.atan2(vz, vx) + side * (tangent + open * ARMS_OPEN_MAX);
}

const ease = (x: number) => THREE.MathUtils.smoothstep(x, 0, 1);
const lerp = THREE.MathUtils.lerp;

/**
 * Pure pad choreography.
 *
 * Intro (time-lapsed stacking, inside `window` as fractions of the intro): the chopsticks close on the ship's
 * lifting pins at the transport stand, hoist it above the booster, swing it over, lower it onto the hot stage,
 * release and swing wide open, the ship QD arm swings back in to dock, and the carriage drops to its launch position.
 * The arms stay wide open from then on. Countdown (sim t from -10, ignition at -2.5): the ship QD arm
 * releases and swings clear before ignition. Pass `launchT: null` outside a launch.
 */
/** Where each move of the stacking starts, as a fraction of the padSequence window. */
export const STACKING_PHASES = { lift: 0.06, move: 0.26, lower: 0.42, release: 0.62, park: 0.67, parked: 0.96 };

export function padSequence(opts: { introS: number; introTotal: number; launchT: number | null; window?: [number, number] }): PadState {
  const { introS, introTotal, launchT, window: [w0, w1] = [0.04, 0.96] } = opts;
  const pose: TowerPose = { carriageY: PARK_Y, holdX: TOWER_OFFSET, holdZ: 0, armsOpen: IDLE_OPEN, qdArm: 0 };
  if (launchT !== null) {
    pose.qdArm = THREE.MathUtils.smoothstep(launchT, -4.6, -2.7);
    return { pose, ship: null };
  }
  const u = THREE.MathUtils.clamp((introS / introTotal - w0) / (w1 - w0), 0, 1);
  if (u >= 1) return { pose, ship: null };
  const seg = (a: number, b: number) => ease(THREE.MathUtils.clamp((u - a) / (b - a), 0, 1));
  const gentle = (a: number, b: number) => THREE.MathUtils.smootherstep(u, a, b);

  const P = STACKING_PHASES;
  const lift = seg(P.lift, P.move);
  const move = seg(P.move, P.lower);
  // Setting the ship down and bringing the arms back down the tower are slow, gentle moves.
  const lower = gentle(P.lower, P.release);
  const release = seg(P.release, P.park);
  const park = gentle(P.park, P.parked);
  pose.carriageY = u < P.lower ? lerp(PICK_Y, HIGH_Y, lift) : u < P.park ? lerp(HIGH_Y, STACK_Y, lower) : lerp(STACK_Y, PARK_Y, park);
  pose.holdX = lerp(STAND.x, TOWER_OFFSET, move);
  pose.holdZ = lerp(STAND.z, 0, move);
  pose.armsOpen = u < P.park ? lerp(0.1, 0, seg(0, P.lift)) + release : IDLE_OPEN;
  pose.qdArm = 1 - seg(P.release + 0.02, P.park + 0.12);
  if (u >= P.release) return { pose, ship: null };
  return {
    pose,
    ship: {
      x: pose.holdX,
      y: pose.carriageY + RAIL_TOP - SHIP_LIFT_PIN_Y,
      z: pose.holdZ,
      yaw: -Math.atan2(pose.holdZ, pose.holdX - CARRIAGE_HALF),
    },
  };
}

const tmpShip = new THREE.Vector3();

/** Applies a PadState: poses the tower and moves the stack's ship (a child of `stack`) into the arms or onto the booster. */
export function applyPadState(state: PadState, tower: Tower, stack: THREE.Object3D) {
  tower.setPose(state.pose);
  const ship = stack.getObjectByName('ship');
  if (!ship) return;
  if (!state.ship) {
    ship.position.set(0, BOOSTER_H, 0);
    ship.rotation.set(0, 0, 0);
    return;
  }
  tower.group.updateWorldMatrix(true, false);
  stack.updateWorldMatrix(true, false);
  stack.worldToLocal(tower.group.localToWorld(tmpShip.set(state.ship.x, state.ship.y, state.ship.z)));
  ship.position.copy(tmpShip);
  ship.rotation.set(0, state.ship.yaw, 0);
}

const plumeVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const plumeFragment = /* glsl */ `
  uniform float uTime;
  uniform float uPower;
  uniform vec3 uColor;
  uniform float uFalloff;
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    float along = 1.0 - vUv.y;
    float rim = abs(dot(vNormalV, vViewDir));
    float flicker = 0.85 + 0.15 * sin(uTime * 53.0 + vUv.y * 40.0) * sin(uTime * 31.0 + vUv.x * 25.0);
    float a = pow(rim, 1.3) * pow(1.0 - along, uFalloff) * flicker * uPower;
    gl_FragColor = vec4(uColor * a * 2.2, a);
  }
`;

export function buildPlume() {
  const g = new THREE.Group();
  const mk = (rTop: number, rBot: number, len: number, color: number, falloff: number, parent: THREE.Object3D = g, turn = 0) => {
    const geo = new THREE.CylinderGeometry(rTop, rBot, len, 48, 1, true);
    geo.translate(0, -len / 2, 0);
    if (turn) geo.rotateZ(turn);
    const mat = new THREE.ShaderMaterial({
      vertexShader: plumeVertex,
      fragmentShader: plumeFragment,
      uniforms: {
        uTime: { value: 0 },
        uPower: { value: 0 },
        uColor: { value: new THREE.Color(color) },
        uFalloff: { value: falloff },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    parent.add(m);
    return mat;
  };
  const mats = [
    mk(R * 0.92, R * 1.6, 70, 0xfff6dc, 0.6),
    mk(R * 1.0, R * 2.8, 160, 0xffb04a, 1.1),
    mk(R * 1.1, R * 4.5, 280, 0xff7426, 1.8),
  ];

  // Exhaust turned by the flame bucket and thrown out both ends of the trench. It stays on the pad while
  // the stack climbs, so it is re-anchored in world space every update (the main pad sits at the origin).
  const trench = new THREE.Group();
  g.add(trench);
  const trenchMats: THREE.ShaderMaterial[] = [];
  for (const turn of [Math.PI / 2, -Math.PI / 2]) {
    trenchMats.push(mk(2.6, 3.6, 24, 0xfff0d0, 0.8, trench, turn), mk(3.4, 5.6, 48, 0xffa040, 1.4, trench, turn));
  }
  const parentPos = new THREE.Vector3();
  const parentQuat = new THREE.Quaternion();

  return {
    group: g,
    update(time: number, power: number) {
      for (const m of mats) {
        m.uniforms.uTime.value = time;
        m.uniforms.uPower.value = power;
      }
      const parent = g.parent;
      if (!parent) return;
      parent.getWorldPosition(parentPos);
      parent.getWorldQuaternion(parentQuat);
      const deflected = power * (1 - THREE.MathUtils.smoothstep(parentPos.y - MOUNT_H, 8, 90));
      trench.visible = deflected > 0.002;
      trench.quaternion.copy(parentQuat).invert();
      trench.position.set(-parentPos.x, 2.6 - parentPos.y, -parentPos.z).applyQuaternion(trench.quaternion);
      for (const m of trenchMats) {
        m.uniforms.uTime.value = time;
        m.uniforms.uPower.value = deflected;
      }
    },
  };
}
