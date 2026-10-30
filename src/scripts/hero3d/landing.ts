import * as THREE from 'three';
import { hermite, monotoneKeys } from './curves';
import { SHIP_H, STACK_YAW } from './starship';

/**
 * The ship's return to Pad 2, timed by `b`: seconds from the start of the landing burn. World axes as in
 * scenery.ts (mount at the origin, +x east, tower at +z).
 *
 * The ship comes home from the west, over Mexico and the Rio Grande Valley, and falls the last kilometres
 * belly-first, heat shield down, nose north (the heat shield faces away from the tower). Flights 12 and 14 flew
 * the same landing burn: flip 2 s after ignition, three engines down to two at +10 s and to one at +17 s, done
 * at +19 s. Here the flip swings the nose up and on past vertical toward the tower, so the thrust slides the
 * ship south into the open chopsticks; it rights itself as the slide stops, and the arms close under the pins.
 */
export const BURN = { flip: 2, two: 10, one: 17, contact: 18.6, cutoff: 19.2 };
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
const SLIDE: [number, number] = [1.5, 14];
const FLIP: [number, number] = [0.4, 4];
const ARMS_CLOSE: [number, number] = [13.5, 17.2];
/** Carriage shock absorbers: stroke (m) and time constant (s). Stroke over time is the contact speed. */
const SAG = 1.4;
const SAG_TAU = 1.4;

// Descent rate (m/s, down) through the belly flop and the burn.
const FALL_T = [-BELLY_S, 0, 2, 4, 7, 10, 14, 17, BURN.contact];
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
  THREE.MathUtils.smoothstep(b, 0, 0.6) * (1 - THREE.MathUtils.smoothstep(b, off - 0.25, off));

export function shipPose(b: number, out: ShipPose): ShipPose {
  const cg = track(b, out.cg);
  const pitch = pitchAt(b);
  const bank = THREE.MathUtils.degToRad(1.2 * Math.sin(b * 0.9 + 2)) * (1 - THREE.MathUtils.smootherstep(b, FLIP[0], FLIP[1]));
  out.quaternion.multiplyQuaternions(qBank.setFromAxisAngle(Z_AXIS, bank), qPitch.setFromAxisAngle(X_AXIS, -pitch)).multiply(qYaw);
  out.base.copy(UP).applyQuaternion(out.quaternion).multiplyScalar(-SHIP_CG).add(cg);
  out.alt = cg.y;
  const h = 1 / 30;
  out.speed = track(b + h, tmpB).sub(track(b - h, tmpC)).length() / (2 * h);
  out.engines[0] = flame(b, BURN.cutoff);
  out.engines[1] = flame(b, BURN.one);
  out.engines[2] = flame(b, BURN.two);
  out.arms = 1 - THREE.MathUtils.smootherstep(b, ARMS_CLOSE[0], ARMS_CLOSE[1]);
  out.sag = sag(b - BURN.contact);
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
});
