import * as THREE from 'three';
import { hermite, monotoneKeys } from './curves';
import { SHIP_H, SHIP_SL_EXITS, STACK_YAW } from './starship';

/**
 * The ship's return to Pad 2, timed by `b`: seconds from the start of the landing burn. World axes as in
 * scenery.ts (mount at the origin, +x east, tower at +z).
 *
 * The ship comes home from the west, over Mexico and the Rio Grande Valley, and falls the last kilometres
 * belly-first, heat shield down, nose north (the heat shield faces away from the tower). SpaceX's Flight 12
 * timeline: flip 2 s after ignition, three engines down to two at +11 s and to one at +18 s, touchdown at
 * +20 s. Here the flip swings the nose up and on past vertical toward the tower, so the thrust slides the
 * ship south into the open chopsticks; it rights itself as the slide stops, and the arms close under the pins.
 * The last engine holds the ship until its pins are on the rails and cuts as the shock absorbers take it.
 */
export const BURN = { flip: 2, two: 11, one: 18, contact: 20, cutoff: 20.35 };
/** Seconds of real-time belly flop before the burn; earlier than this the return is on fast-forward. */
export const BELLY_S = 17;
/** Start of the path: the end of the fast-forward sweeps the ship in along it from the west. */
export const PATH_FROM = -120;
/** Ship base above grade when the catch pins land on the chopstick rails. */
export const CATCH_BASE_Y = 76;
/** Flip pivot up the ship axis from its base: about where the near-empty ship's mass centre sits. */
const SHIP_CG = SHIP_H * 0.35;
const G = 9.81;

/** Where the fast-forward picks the ship up: ~15 km west, 9 km up, gliding east. */
const FAR = new THREE.Vector3(-14500, 9000, -420);
const FAR_VEL = new THREE.Vector3(175, -105, 2.5);
/** Eastward drift left at the start of the real-time belly flop, bled off by the burn. */
const DRIFT_X = 250;
/** North of the mount, where the ship flips before sliding south into the arms. */
const STANDOFF_Z = -55;
const DRIFT_Z = 25;
const SLIDE: [number, number] = [1.5, 15];
const FLIP: [number, number] = [0.4, 4];
const ARMS_CLOSE: [number, number] = [14.6, 18.6];
/** Carriage shock absorbers: stroke (m) and time constant (s). Stroke over time is the contact speed. */
const SAG = 1.4;
const SAG_TAU = 1.4;

// Descent rate (m/s, down) through the belly flop and the burn.
const FALL_T = [-BELLY_S, 0, 2, 4, 7, 10.5, 15, 18.4, BURN.contact];
const FALL_V = [84, 80, 70, 45, 22, 10, 4, 1.6, SAG / SAG_TAU];
const STEP = 1 / 120;
const fallen: number[] = [0];
for (let b = -BELLY_S; b < BURN.contact; b += STEP) fallen.push(fallen[fallen.length - 1] + monotoneKeys(FALL_T, FALL_V, b + STEP / 2) * STEP);
const FALL_TOTAL = fallen[fallen.length - 1];
const fallenAt = (b: number) => {
  const i = (b + BELLY_S) / STEP;
  const i0 = Math.min(fallen.length - 2, Math.max(0, Math.floor(i)));
  return THREE.MathUtils.lerp(fallen[i0], fallen[i0 + 1], i - i0);
};
const sag = (s: number) => (s <= 0 ? 0 : SAG * (1 - Math.exp(-s / SAG_TAU)));

/** Mass-centre position at `b`, without the flap wobble. */
function track(b: number, out: THREE.Vector3): THREE.Vector3 {
  if (b < -BELLY_S) {
    const T = -BELLY_S - PATH_FROM;
    const u = THREE.MathUtils.clamp((b - PATH_FROM) / T, 0, 1);
    return hermite(out, FAR, FAR_VEL, BELLY_START, BELLY_VEL, T, u);
  }
  const y = b < BURN.contact ? FALL_TOTAL - fallenAt(b) : -sag(b - BURN.contact);
  out.y = CATCH_BASE_Y + SHIP_CG + y;
  if (b < 0) {
    const k = (b / BELLY_S) ** 2;
    out.x = -DRIFT_X * k;
    out.z = STANDOFF_Z - DRIFT_Z * k;
  } else {
    out.x = 0;
    // Septic, so the acceleration (and with it the ship's lean) eases out as well as the speed.
    const u = THREE.MathUtils.clamp((b - SLIDE[0]) / (SLIDE[1] - SLIDE[0]), 0, 1);
    out.z = STANDOFF_Z * (1 - u ** 4 * (35 - 84 * u + 70 * u * u - 20 * u ** 3));
  }
  return out;
}
const BELLY_START = new THREE.Vector3();
const BELLY_VEL = new THREE.Vector3();
track(-BELLY_S, BELLY_START);
BELLY_VEL.set((2 * DRIFT_X) / BELLY_S, -FALL_V[0], (2 * DRIFT_Z) / BELLY_S);

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
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
  /** Per sea-level engine flame power, 0–1. */
  engines: [number, number, number];
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

/** Pitch from vertical (radians, positive = nose north): belly flop, then the flip into the slide's lean. */
function pitchAt(b: number) {
  const belly = Math.PI / 2 + THREE.MathUtils.degToRad(1.6 * Math.sin(b * 1.45) + 0.7 * Math.sin(b * 3.1 + 1));
  const k = THREE.MathUtils.smootherstep(b, FLIP[0], FLIP[1]);
  if (k <= 0) return belly;
  // Lean the thrust into the slide: horizontal over vertical acceleration (gravity plus the braking).
  const h = 0.05;
  const az = (track(b + h, tmpA).z - 2 * track(b, tmpB).z + track(b - h, tmpC).z) / (h * h);
  const ay = (track(b + h, tmpA).y - 2 * track(b, tmpB).y + track(b - h, tmpC).y) / (h * h);
  const lean = b < BURN.contact ? -Math.atan2(az, G + ay) : 0;
  return THREE.MathUtils.lerp(belly, lean, k);
}

const flame = (b: number, off: number) =>
  THREE.MathUtils.smoothstep(b, 0, 0.6) * (1 - THREE.MathUtils.smoothstep(b, off - 0.2, off));

const bankAt = (b: number) => THREE.MathUtils.degToRad(1.2 * Math.sin(b * 0.9 + 2)) * (1 - THREE.MathUtils.smootherstep(b, FLIP[0], FLIP[1]));

function orient(b: number, out: THREE.Quaternion) {
  return out.multiplyQuaternions(qBank.setFromAxisAngle(Z_AXIS, bankAt(b)), qPitch.setFromAxisAngle(X_AXIS, -pitchAt(b))).multiply(qYaw);
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const w0 = new THREE.Vector3();
const w1 = new THREE.Vector3();
/** World angular velocity over [b0, b1] (small-angle). */
function spin(b0: number, b1: number, out: THREE.Vector3) {
  orient(b0, qa);
  orient(b1, qb).multiply(qa.invert());
  if (qb.w < 0) qb.set(-qb.x, -qb.y, -qb.z, -qb.w);
  return out.set(qb.x, qb.y, qb.z).multiplyScalar(2 / (b1 - b0));
}

const deg = THREE.MathUtils.degToRad;
const { smoothstep, smootherstep } = THREE.MathUtils;
/** Exhaust tilt per rad/s² of angular acceleration, and the gimbal's travel. */
const GIMBAL_K = 0.34;
const GIMBAL_MAX = deg(15);
/** Sea-level engines' tangential directions (ship-local x, z), for the differential roll trim. */
const SL_TANGENT = SHIP_SL_EXITS.map((p) => new THREE.Vector2(-p.z, p.x).normalize());

/**
 * Flaps and engines, which keep working almost to the end. Belly-first, all four flaps trim pitch and roll
 * against the wobble. For the flip the aft pair folds back out of the airflow and the forward pair spreads, so
 * the tail drops. Under power the engines gimbal for whatever angular acceleration the pose asks of them, hard
 * (to the 15° stops) to start and then stop the flip, with continual small corrections after; the flaps keep
 * trimming, then fold in as the arms close.
 */
function controls(b: number, out: ShipPose) {
  const flip = smootherstep(b, -0.3, 1.8);
  const post = smootherstep(b, 3.2, 6);
  const stow = smootherstep(b, BURN.contact - 2.4, BURN.contact - 0.4);
  const wobble = 1 - flip;
  const trimP = deg(7 * Math.cos(b * 1.45) + 3 * Math.cos(b * 3.1 + 1)) * wobble;
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

  // Angular acceleration in the ship frame. The engines sit h below the mass centre, so an exhaust tilted
  // (ex, ez) pushes with torque ∝ (h·ez, 0, −h·ex).
  const h = 0.05;
  const alpha = spin(b, b + h, w1).sub(spin(b - h, b, w0)).divideScalar(h).applyQuaternion(orient(b, qa).invert());
  const fine = deg(2.2) * (1 - 0.75 * smoothstep(b, 15, BURN.contact));
  const cx = THREE.MathUtils.clamp(-GIMBAL_K * alpha.z, -GIMBAL_MAX, GIMBAL_MAX) + fine * (0.6 * Math.sin(b * 2.3 + 0.4) + 0.4 * Math.sin(b * 5.1 + 1.7));
  const cz = THREE.MathUtils.clamp(GIMBAL_K * alpha.x, -GIMBAL_MAX, GIMBAL_MAX) + fine * (0.6 * Math.sin(b * 1.9 + 2.1) + 0.4 * Math.sin(b * 4.4 + 0.3));
  const roll = deg(0.8) * Math.sin(b * 3.3);
  out.gimbal.forEach((g, i) => {
    const on = smoothstep(out.engines[i], 0, 0.6);
    g[0] = (cx + roll * SL_TANGENT[i].x) * on;
    g[1] = (cz + roll * SL_TANGENT[i].y) * on;
  });
}

export function shipPose(b: number, out: ShipPose): ShipPose {
  const cg = track(b, out.cg);
  orient(b, out.quaternion);
  out.base.copy(UP).applyQuaternion(out.quaternion).multiplyScalar(-SHIP_CG).add(cg);
  out.alt = cg.y;
  const h = 1 / 30;
  out.speed = track(b + h, tmpB).sub(track(b - h, tmpC)).length() / (2 * h);
  out.engines[0] = flame(b, BURN.cutoff);
  out.engines[1] = flame(b, BURN.one);
  out.engines[2] = flame(b, BURN.two);
  out.arms = 1 - THREE.MathUtils.smootherstep(b, ARMS_CLOSE[0], ARMS_CLOSE[1]);
  out.sag = sag(b - BURN.contact);
  controls(b, out);
  return out;
}

export const newShipPose = (): ShipPose => ({
  base: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  cg: new THREE.Vector3(),
  alt: 0,
  speed: 0,
  engines: [0, 0, 0],
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
