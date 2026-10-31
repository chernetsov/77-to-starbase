import * as THREE from 'three';
import { hermite } from './curves';
import { DESCENT_BELLY_S, sampleAt, simulateDescent, type Descent } from './descent';
import { SHIP_H, SHIP_SL_EXITS, STACK_YAW } from './starship';

/**
 * The ship's return to Pad 2, timed by `b`: seconds from the start of the landing burn. World axes as in
 * scenery.ts (mount at the origin, +x east, tower at +z).
 *
 * The ship comes home from the west, over Mexico and the Rio Grande Valley, and falls the last kilometres
 * belly-first, heat shield down, nose north (the heat shield faces away from the tower). From BELLY_S before the
 * burn to the catch, the motion is the rigid-body simulation in descent.ts (calibrated to the Flight 13–14
 * webcast readouts): the flip north of the mount, the hard braking on three engines, the slide south into the
 * open chopsticks on two, and the last metres on one, which holds the ship until its pins are on the rails and
 * cuts as the shock absorbers take it. Here that is played back, with the flaps' and engines' visible motion.
 */
export const BELLY_S = DESCENT_BELLY_S;
/** Start of the path: the end of the fast-forward sweeps the ship in along it from the west. */
export const PATH_FROM = -120;
/** Ship base above grade when the catch pins land on the chopstick rails. */
export const CATCH_BASE_Y = 76;
/** Flip pivot up the ship axis from its base: about where the near-empty ship's mass centre sits. */
const SHIP_CG_FRAC = 0.35;
const SHIP_CG = SHIP_H * SHIP_CG_FRAC;

const SIM = simulateDescent({ catchAlt: CATCH_BASE_Y + SHIP_CG, length: SHIP_H, cgFrac: SHIP_CG_FRAC });
/** The burn's milestones as the simulation flew them: flip, the two shutdowns, the catch, the last cutoff. */
export const BURN = {
  flip: 2,
  two: SIM.shutdowns[0] ?? 11,
  one: SIM.shutdowns[1] ?? 18,
  contact: SIM.contact,
  cutoff: SIM.contact + 0.35,
};

/** Where the fast-forward picks the ship up: ~15 km west, 9 km up, gliding east. */
const FAR = new THREE.Vector3(-14500, 9000, -420);
const FAR_VEL = new THREE.Vector3(175, -105, 2.5);
/** Carriage shock absorbers: stroke (m); the time constant matches the ship's closing speed at contact. */
const SAG = 1.4;
/** The simulation settles within a metre of the slot; the last seconds take out the rest, so the pins meet the rails. */
const SETTLE: [number, number] = [BURN.contact - 3, BURN.contact];
/** Chopsticks in a run: 1 = wide open, closing from 5.4 s to 1.4 s before contact. */
export const armsOpen = (sim: Descent, b: number) => 1 - THREE.MathUtils.smootherstep(b, sim.contact - 5.4, sim.contact - 1.4);
/** How far the carriage has sunk on its shock absorbers in a run, taking up the ship's closing speed. */
export function carriageSag(sim: Descent, b: number) {
  const s = b - sim.contact;
  return s <= 0 ? 0 : SAG * (1 - Math.exp(-s / (SAG / Math.max(1, sim.contactSpeed[1]))));
}
/** A channel of a run at `b`, held at its value on contact. */
const atRun = (sim: Descent, ch: Float32Array, b: number) => sampleAt(sim, ch, Math.min(b, sim.contact));
const at = (ch: Float32Array, b: number) => atRun(SIM, ch, b);
const miss = new THREE.Vector3(at(SIM.x, BURN.contact), 0, at(SIM.z, BURN.contact));

const { smoothstep, smootherstep } = THREE.MathUtils;

/** Mass-centre position at `b`. */
function track(b: number, out: THREE.Vector3): THREE.Vector3 {
  if (b < -BELLY_S) {
    const T = -BELLY_S - PATH_FROM;
    const u = THREE.MathUtils.clamp((b - PATH_FROM) / T, 0, 1);
    return hermite(out, FAR, FAR_VEL, BELLY_START, BELLY_VEL, T, u);
  }
  out.set(at(SIM.x, b), at(SIM.y, b), at(SIM.z, b));
  out.addScaledVector(miss, -smootherstep(b, SETTLE[0], SETTLE[1]));
  out.y -= carriageSag(SIM, b);
  return out;
}
const BELLY_START = new THREE.Vector3(SIM.x[0], SIM.y[0], SIM.z[0]);
const BELLY_VEL = new THREE.Vector3(SIM.vx[0], SIM.vy[0], SIM.vz[0]);

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const qPitch = new THREE.Quaternion();
const qBank = new THREE.Quaternion();
const qYaw = new THREE.Quaternion().setFromAxisAngle(UP, STACK_YAW);

export type ShipPose = {
  /** Ship base (the ship group's origin) and orientation in world space. */
  base: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Mass centre, the flip's pivot: what a tracking camera keeps centred. */
  cg: THREE.Vector3;
  /** Altitude of the mass centre and speed, for the HUD. */
  alt: number;
  speed: number;
  /** Per sea-level engine spool, 0–1, and the throttle they share. */
  engines: [number, number, number];
  throttle: number;
  /** Chopsticks: 1 = wide open, 0 = closed on the hull. */
  arms: number;
  /** How far the carriage has sunk on its shock absorbers. */
  sag: number;
  /** Flap fold (radians toward the leeward side) for the `[+1, −1]` sides, as `ShipRig.setFlaps` takes them. */
  aftFlaps: [number, number];
  fwdFlaps: [number, number];
  /** Per sea-level engine exhaust tilt `[x, z]` in ship-local radians, as `ShipRig.setGimbal` takes it. */
  gimbal: [number, number][];
};

const deg = THREE.MathUtils.degToRad;
/** The flip, as the flaps see it: from relight until the hull is near upright. */
const FLIP: [number, number] = [1.6, 5];
/** A little roll wobble in the belly flop, on top of the simulated pitch, fading through the flip. */
const bankAt = (sim: Descent, b: number) =>
  deg(1.2 * Math.sin(b * 0.9 + 2)) * (1 - smootherstep(b, FLIP[0], FLIP[1])) + atRun(sim, sim.bank, b);
/** Pitch from vertical (positive = nose north), with the last of it taken out as the pins meet the rails. */
const pitchAt = (sim: Descent, b: number) => atRun(sim, sim.pitch, b) * (1 - smootherstep(b, sim.contact - 2, sim.contact));

/** The ship's orientation at `b` in a run, as the ship group's quaternion. */
export function orientShip(sim: Descent, b: number, out: THREE.Quaternion) {
  return out
    .multiplyQuaternions(qBank.setFromAxisAngle(Z_AXIS, bankAt(sim, b)), qPitch.setFromAxisAngle(X_AXIS, -pitchAt(sim, b)))
    .multiply(qYaw);
}

/** Sea-level engines' tangential directions (ship-local x, z), for the differential roll trim. */
const SL_TANGENT = SHIP_SL_EXITS.map((p) => new THREE.Vector2(-p.z, p.x).normalize());
const tilt = new THREE.Vector3();
const qInv = new THREE.Quaternion();

/**
 * Flaps and engines, which keep working almost to the end. Belly-first, all four flaps trim pitch (the
 * simulation's flap command) and roll against the wobble. For the flip the aft pair folds back out of the airflow
 * and the forward pair spreads, so the tail drops. Under power the engines gimbal as the simulation steers: hard
 * to start and stop the flip, then smaller corrections through the slide; the flaps keep trimming, then fold in
 * as the arms close.
 */
export function shipControls(sim: Descent, b: number, out: Pick<ShipPose, 'quaternion' | 'engines' | 'aftFlaps' | 'fwdFlaps' | 'gimbal'>) {
  const contact = sim.contact;
  const flip = smootherstep(b, FLIP[0] - 1.6, FLIP[0] + 0.6);
  const post = smootherstep(b, FLIP[1] - 1.8, FLIP[1] + 1);
  const stow = smootherstep(b, contact - 2.4, contact - 0.4);
  const wobble = 1 - flip;
  const trimP = deg(12) * atRun(sim, sim.flap, b) * (1 - post);
  const trimR = deg(6 * Math.cos(b * 0.9 + 2)) * wobble;
  const busy = deg(6) * post * (1 - 0.7 * smoothstep(b, 11, 17)) * (1 - stow);
  [1, -1].forEach((s, k) => {
    const aftBase = THREE.MathUtils.lerp(THREE.MathUtils.lerp(deg(20), deg(78), flip), deg(45), post);
    const fwdBase = THREE.MathUtils.lerp(THREE.MathUtils.lerp(deg(28), deg(5), flip), deg(35), post);
    const jitterA = busy * (0.6 * Math.sin(b * 1.7 + s * 0.9) + 0.4 * Math.sin(b * 4.3 + k * 2.2));
    const jitterF = busy * (0.6 * Math.sin(b * 1.3 + s * 1.7 + 0.5) + 0.4 * Math.sin(b * 3.7 + k * 1.3));
    out.aftFlaps[k] = THREE.MathUtils.lerp(aftBase - trimP + s * trimR + jitterA, deg(78), stow);
    out.fwdFlaps[k] = THREE.MathUtils.lerp(fwdBase + trimP + s * trimR + jitterF, deg(55), stow);
  });

  // The simulated gimbal swings the exhaust in the pitch plane (positive turns the nose north, about world −x)
  // and across it (positive banks, about world +z). In the ship frame an exhaust tilt (ex, ez) turns it about
  // (ez, 0, −ex).
  tilt.set(-atRun(sim, sim.gimbal, b), 0, atRun(sim, sim.gimbalBank, b)).applyQuaternion(qInv.copy(out.quaternion).invert());
  const fine = deg(1.2) * (1 - 0.75 * smoothstep(b, 15, contact));
  const cx = -tilt.z + fine * (0.6 * Math.sin(b * 2.3 + 0.4) + 0.4 * Math.sin(b * 5.1 + 1.7));
  const cz = tilt.x + fine * (0.6 * Math.sin(b * 1.9 + 2.1) + 0.4 * Math.sin(b * 4.4 + 0.3));
  const roll = deg(0.8) * Math.sin(b * 3.3);
  out.gimbal.forEach((g, i) => {
    const on = smoothstep(out.engines[i], 0, 0.6);
    g[0] = (cx + roll * SL_TANGENT[i].x) * on;
    g[1] = (cz + roll * SL_TANGENT[i].y) * on;
  });
}

const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();

export function shipPose(b: number, out: ShipPose): ShipPose {
  const cg = track(b, out.cg);
  orientShip(SIM, b, out.quaternion);
  out.base.copy(UP).applyQuaternion(out.quaternion).multiplyScalar(-SHIP_CG).add(cg);
  out.alt = cg.y;
  const h = 1 / 30;
  out.speed = track(b + h, tmpB).sub(track(b - h, tmpC)).length() / (2 * h);
  const live = b >= -BELLY_S && b < BURN.cutoff + 0.3;
  for (let i = 0; i < 3; i++) out.engines[i] = live ? sampleAt(SIM, SIM.engine[i], b) : 0;
  out.throttle = live ? sampleAt(SIM, SIM.throttle, b) : 0;
  out.arms = armsOpen(SIM, b);
  out.sag = carriageSag(SIM, b);
  shipControls(SIM, b, out);
  return out;
}

export const newShipPose = (): ShipPose => ({
  base: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  cg: new THREE.Vector3(),
  alt: 0,
  speed: 0,
  engines: [0, 0, 0],
  throttle: 0,
  arms: 1,
  sag: 0,
  aftFlaps: [0, 0],
  fwdFlaps: [0, 0],
  gimbal: [
    [0, 0],
    [0, 0],
    [0, 0],
  ],
});
