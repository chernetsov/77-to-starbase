/**
 * The ship's descent as a small rigid-body simulation, from the last seconds of the belly flop to the catch.
 * World axes as in scenery.ts: mount at the origin, +x east, +y up, +z south (the tower stands at +z).
 *
 * The ship pitches in the y–z plane (`pitch` from vertical, positive = nose north, so the belly flop is +90°) and
 * leans a few degrees east–west (`bank`). Forces: gravity, drag split along and across the hull, and the
 * sea-level Raptors' thrust, gimballed. Moments: the gimbal, and in the belly flop and the flip the flaps.
 *
 * Control follows the textbook split for powered landing (Blackmore, Açıkmeşe et al.): guidance asks for an
 * acceleration vector, the attitude loop points the hull along it, and throttle sets its size.
 * - Vertically, guidance flies a sink-rate schedule: the speed at which constant braking (brakeDecel) would stop
 *   the ship on the rails, then a gentler glide below glideH, then a steady contactV for the last finalH metres.
 *   Throttle tracks it. (Apollo's fixed-time "E-guidance" law was tried first; it crept in late and stalled.)
 * - Horizontally, two nested loops with caps: position sets a wanted velocity (≤ 9 m/s), velocity sets a wanted
 *   acceleration (≤ 3.4 m/s²), and the hull leans to get it (≤ 20° in pitch, 8° in bank). The outer loops are
 *   kept slower than the attitude loop, because gimballing first pushes the ship the wrong way.
 * - Attitude is a saturating PD loop on the gimbal (±15°), with the flaps adding their moment while there is
 *   airflow over them. The flip is the same loop asked to swing 90°: it saturates, which makes it bang–bang.
 * - Engines relight one after another within a second. An engine shuts down when the throttle sinks near its
 *   floor and the others can carry the load; that comes out at about +11 s (three to two) and +18 s (two to
 *   one), as on the Flight 12–14 webcasts.
 *
 * The reaction-control thrusters are left out: down here their torque is a few percent of the flaps' or the gimbal's.
 *
 * Calibration (webcast readouts, Flights 13–14): ~100 m/s falling belly-first near 1 km, relight at ~1.1 km,
 * speed held through the flip to about +3 s, ~1.1 g of braking on three engines, ~30 m/s at +11, ~5 m/s at +18.
 */

export type DescentParams = {
  /** Ship mass at the start of the burn (kg) and sea-level Raptor thrust at full throttle (N). */
  mass: number;
  thrust: number;
  /** Throttle floor, as a fraction of full thrust. */
  minThrottle: number;
  /** Drag area across the hull (belly-first, flaps out) and along it (tail-first), m². */
  cdaBelly: number;
  cdaTail: number;
  /** Mass-centre altitude at relight (m), and the horizontal velocity at the start (m/s, east and south). */
  burnAlt: number;
  startVx: number;
  startVz: number;
  /** Where the mass centre is at the burn: east and south of the mount (m). */
  burnX: number;
  burnZ: number;
  /** Mass-centre altitude when the catch pins land on the rails. */
  catchAlt: number;
  /** Braking deceleration on three engines, and of the glide below glideH onto the rails (m/s², m). */
  brakeDecel: number;
  glideDecel: number;
  glideH: number;
  /** Height above the rails from which the ship holds its closing speed (m). */
  finalH: number;
  /** Closing speed on the rails (m/s, down). */
  contactV: number;
  /** Ship length and how far up it the mass centre sits (fraction). */
  length: number;
  cgFrac: number;
};

export const DESCENT_DEFAULTS: DescentParams = {
  mass: 220e3,
  thrust: 2.75e6,
  minThrottle: 0.36,
  cdaBelly: 340,
  cdaTail: 60,
  burnAlt: 1130,
  startVx: 15,
  startVz: 38,
  burnX: -25,
  burnZ: -105,
  catchAlt: 94,
  brakeDecel: 10.5,
  glideDecel: 3,
  glideH: 120,
  finalH: 8,
  contactV: 3.5,
  length: 52.1,
  cgFrac: 0.35,
};

/** Seconds from the burn: the real-time window starts BELLY_S before it. */
export const DESCENT_BELLY_S = 17;
export const DESCENT_TIMES = { light: [0, 0.35, 0.7], contact: 20, flip: 2 };
/** Throttle margin over the floor at which an engine is shut down, and how long the last one runs after contact. */
const SHUTDOWN_MARGIN = 0.08;
const CUTOFF_AFTER = 0.35;

const G = 9.81;
const ISP = 327;
const GIMBAL_MAX = (15 * Math.PI) / 180;
const LEAN_MAX = (20 * Math.PI) / 180;
const BANK_MAX = (8 * Math.PI) / 180;
const SPOOL = 0.6;
/** The flip is commanded this long after relight; guidance takes over once the hull is within FLIPPED of upright. */
const FLIP_CMD = 1.8;
const FLIPPED = (8 * Math.PI) / 180;
/** Flap pitch authority: angular acceleration per unit command per pascal of dynamic pressure. */
const FLAP_K = 4.5e-5;
/** Flap actuator rate: command units per second (full travel each way in under a second). */
const FLAP_RATE = 2.5;
const STEP = 1 / 240;
/** Samples per second in the output. */
export const DESCENT_RATE = 120;

/** Horizontal loops: position gain (1/s), speed cap (m/s), speed gain (1/s), sideways acceleration cap (m/s²). */
const H_KP = 0.26;
const H_VMAX = 9;
const H_KV = 0.5;
const H_AMAX = 3.4;
/** Sink-rate gain onto the glide (1/s). */
const V_K = 1.2;
/** Attitude loop's natural frequency under guidance (rad/s). */
const ATT_WN = 2.0;

const rho = (h: number) => 1.225 * Math.exp(-h / 8500);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (x: number, a: number, b: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Per-sample channels, all at DESCENT_RATE from `t0`. */
export type Descent = {
  t0: number;
  /** Whether the pins reached the rails (rather than the ship the ground, or the time running out). */
  landed: boolean;
  /** Seconds from the burn when the pins meet the rails (or the run ended). */
  contact: number;
  /** Sideways and downward speed (m/s) as the pins meet the rails. */
  contactSpeed: [number, number];
  /** When guidance shut engines down (three to two, two to one). */
  shutdowns: number[];
  n: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  pitch: Float32Array;
  bank: Float32Array;
  /** Pitch-plane gimbal (rad; positive swings the nose north) and the east–west one (rad; positive banks). */
  gimbal: Float32Array;
  gimbalBank: Float32Array;
  /** Flap pitch command, −1…1 (positive pushes the nose north). */
  flap: Float32Array;
  /** Per-engine spool, 0–1 (lit and up to pressure), and the throttle the lit engines share. */
  engine: [Float32Array, Float32Array, Float32Array];
  throttle: Float32Array;
  /** Rate of change of speed in g (negative = braking), and dynamic pressure (Pa). */
  accel: Float32Array;
  q: Float32Array;
  mass: Float32Array;
  /** For the lab: the worst throttle shortfalls under guidance, and seconds the gimbal spent on its stops. */
  saturated: { throttleHi: number; throttleLo: number; gimbal: number };
};

/** Engine i's spool (0–1): lights at its relight time, runs until `off` and fades over 0.2 s. */
const spool = (b: number, i: number, off: number) =>
  smooth(b, DESCENT_TIMES.light[i], DESCENT_TIMES.light[i] + SPOOL) * (b < off ? 1 : 1 - smooth(b, off, off + 0.2));

export function simulateDescent(p: Partial<DescentParams> = {}): Descent {
  const P = { ...DESCENT_DEFAULTS, ...p };
  const L = P.length;
  const arm = L * P.cgFrac;
  const inertia = (m: number) => m * L * L * (1 / 12 + (0.5 - P.cgFrac) ** 2);
  const t0 = -DESCENT_BELLY_S;
  /** Runs on 2 s past contact, so the last engine's cutoff is in the record; at most to tEnd. */
  const tEnd = 60;
  const n = Math.ceil((tEnd - t0) * DESCENT_RATE) + 1;
  const f = () => new Float32Array(n);
  const out: Descent = {
    t0,
    landed: false,
    contact: tEnd,
    contactSpeed: [0, 0],
    shutdowns: [],
    n,
    x: f(),
    y: f(),
    z: f(),
    vx: f(),
    vy: f(),
    vz: f(),
    pitch: f(),
    bank: f(),
    gimbal: f(),
    gimbalBank: f(),
    flap: f(),
    engine: [f(), f(), f()],
    throttle: f(),
    accel: f(),
    q: f(),
    mass: f(),
    saturated: { throttleHi: 0, throttleLo: 0, gimbal: 0 },
  };

  // The belly flop is near terminal: start there, high enough that the burn begins at burnAlt, then shift the
  // start sideways so it begins over the planned spot.
  const fallFrom = (alt: number) => {
    let h = alt, v = Math.sqrt((2 * P.mass * G) / (rho(h) * P.cdaBelly));
    for (let s = 0; s < DESCENT_BELLY_S; s += STEP) {
      v += (G - (0.5 * rho(h) * v * v * P.cdaBelly) / P.mass) * STEP;
      h -= v * STEP;
    }
    return h;
  };
  let lo = P.burnAlt, hi = P.burnAlt + 4000;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fallFrom(mid) > P.burnAlt) hi = mid;
    else lo = mid;
  }
  let x = 0, y = (lo + hi) / 2, z = 0;
  let vx = P.startVx, vz = P.startVz;
  let vy = -Math.sqrt((2 * P.mass * G) / (rho(y) * P.cdaBelly));
  let pitch = Math.PI / 2, w = 0;
  let bank = 0, bankRate = 0;
  let flap = 0;
  let m = P.mass;
  let shift: [number, number] | null = null;
  let contacted = false;
  let lastOff = 0;
  let lastThr = 0;
  let guiding = false;
  /** Shutdown times: engines 2 and 1 when the rest can carry the thrust, the last one just after contact. */
  const offAt = [Infinity, Infinity, Infinity];
  let k = 0;

  const every = Math.round(1 / (STEP * DESCENT_RATE));
  for (let j = 0; k < n; j++) {
    const b = t0 + j * STEP;
    if (!shift && b >= 0) {
      shift = [P.burnX - x, P.burnZ - z];
      // Re-run positions relative to the planned burn point: horizontal motion doesn't feed back on anything.
      for (let i = 0; i < k; i++) {
        out.x[i] += shift[0];
        out.z[i] += shift[1];
      }
      x += shift[0];
      z += shift[1];
    }
    const h = y;
    const r = rho(h);
    // Hull axis (base → nose) and drag split along and across it.
    const sp = Math.sin(pitch), cp = Math.cos(pitch), sb = Math.sin(bank), cb = Math.cos(bank);
    const ex = -sb * cp, ey = cb * cp, ez = -sp;
    const va = vx * ex + vy * ey + vz * ez;
    const nx = vx - va * ex, ny = vy - va * ey, nz = vz - va * ez;
    const vn = Math.hypot(nx, ny, nz);
    const speed = Math.hypot(vx, vy, vz);
    const q = 0.5 * r * speed * speed;
    let dx = -0.5 * r * (P.cdaTail * Math.abs(va) * va * ex + P.cdaBelly * vn * nx);
    let dy = -0.5 * r * (P.cdaTail * Math.abs(va) * va * ey + P.cdaBelly * vn * ny);
    let dz = -0.5 * r * (P.cdaTail * Math.abs(va) * va * ez + P.cdaBelly * vn * nz);

    // Guidance: an acceleration for the thrust to supply (net of gravity and drag), once the burn is on.
    const lit = [0, 1, 2].map((i) => spool(b, i, offAt[i]));
    const nLit = lit[0] + lit[1] + lit[2];
    let thrust = 0, thr = 0;
    let pitchCmd = Math.PI / 2, bankCmd = 0;
    if (b >= DESCENT_TIMES.flip && !guiding && pitch < FLIPPED) guiding = true;
    if (b >= 0 && !guiding && !contacted) {
      // The flip: swing upright on the flaps and the gimbal, at the throttle floor so the thrust (still mostly
      // sideways) doesn't throw the ship north.
      thr = P.minThrottle;
      thrust = nLit * P.thrust * thr;
      pitchCmd = b >= FLIP_CMD ? 0 : Math.PI / 2;
    }
    if (guiding && !contacted) {
      // Vertical channel: a sink rate for the height above the rails, from constant-deceleration slopes
      // v = √(v₀² + 2·a·h): hard braking on three engines, a gentle glide, and the last few metres at the closing
      // speed, which one engine near hover can hold.
      const above = Math.max(0, y - P.catchAlt);
      const vGate = Math.sqrt(P.contactV ** 2 + 2 * P.glideDecel * (P.glideH - P.finalH));
      const seg = above < P.finalH ? 0 : above < P.glideH ? 1 : 2;
      const vRef =
        seg === 0
          ? P.contactV
          : seg === 1
            ? Math.sqrt(P.contactV ** 2 + 2 * P.glideDecel * (above - P.finalH))
            : Math.sqrt(vGate ** 2 + 2 * P.brakeDecel * (above - P.glideH));
      const ff = seg === 0 ? 0 : seg === 1 ? P.glideDecel : P.brakeDecel;
      const ay = G - dy / m + clamp(ff + V_K * (-vRef - vy), 0, 1.3 * P.brakeDecel);
      // Horizontal channel: nested loops that stay well-behaved when the lean saturates. The offset from the slot
      // over the mount asks for a capped sideways speed, and the speed error for a capped sideways acceleration.
      const hv = (p: number, v: number) => H_KV * (clamp(-H_KP * p, -H_VMAX, H_VMAX) - v);
      let ax = hv(x, vx), az = hv(z, vz);
      const ah = Math.hypot(ax, az);
      if (ah > H_AMAX) {
        ax *= H_AMAX / ah;
        az *= H_AMAX / ah;
      }
      ax -= dx / m;
      az -= dz / m;
      // Shut an engine down when the throttle nears its floor and the others can take the load.
      const running = offAt.filter((o) => o === Infinity).length;
      if (running > 1 && nLit > running - 0.01 && b - lastOff > 2) {
        const each = (m * ay) / (running * P.thrust);
        if (each < P.minThrottle + SHUTDOWN_MARGIN && (each * running) / (running - 1) < 0.92) {
          offAt[running - 1] = b;
          lastOff = b;
          out.shutdowns.push(b);
        }
      }
      const cap = nLit * P.thrust;
      thr = cap > 1 ? (m * ay) / cap : 0;
      if (cap > 1) {
        out.saturated.throttleHi = Math.max(out.saturated.throttleHi, thr - 1);
        out.saturated.throttleLo = Math.max(out.saturated.throttleLo, P.minThrottle - thr);
      }
      thr = clamp(thr, P.minThrottle, 1);
      thrust = cap * thr;
      // Lean the thrust for the sideways part, within limits.
      const aT = Math.max(1, thrust / m);
      pitchCmd = Math.asin(clamp(-az / aT, -Math.sin(LEAN_MAX), Math.sin(LEAN_MAX)));
      bankCmd = Math.asin(clamp(-ax / aT, -Math.sin(BANK_MAX), Math.sin(BANK_MAX)));
      lastThr = thr;
    } else if (contacted) {
      // The last engine burns on briefly at its last setting while the shock absorbers take the ship.
      thr = lastThr;
      thrust = nLit * P.thrust * thr;
      pitchCmd = pitch;
      bankCmd = bank;
    }

    // Attitude: PD on the pitch error, met by the gimbal (when lit) plus the flaps (while there is airflow).
    const I = inertia(m);
    // Stiff for the flip; soft under guidance, where a hard gimbal would kick the ship sideways more than the
    // lean it is after.
    const wn = guiding ? ATT_WN : 1.5;
    const alphaCmd = wn * wn * (pitchCmd - pitch) - 2 * wn * w;
    // Shared between flaps and gimbal in proportion to what each can do at full travel, so neither bangs
    // between its stops doing work the other does better; whatever the flaps don't deliver goes to the gimbal.
    const flapAuth = q * FLAP_K * Math.abs(Math.sin(pitch));
    const gimAuth = (thrust * arm) / I;
    const both = flapAuth + gimAuth * Math.sin(GIMBAL_MAX);
    const flapWant = both > 1e-6 ? clamp(alphaCmd / both, -1, 1) : 0;
    flap += clamp(flapWant - flap, -FLAP_RATE * STEP, FLAP_RATE * STEP);
    const flapAlpha = flap * flapAuth;
    let gimbal = 0;
    if (gimAuth > 1e-6) {
      const sinG = (alphaCmd - flapAlpha) / gimAuth;
      if (Math.abs(sinG) > Math.sin(GIMBAL_MAX)) out.saturated.gimbal += STEP;
      gimbal = Math.asin(clamp(sinG, -Math.sin(GIMBAL_MAX), Math.sin(GIMBAL_MAX)));
    }
    // A little gusting in the belly flop for the flaps to work against.
    const gust = b < DESCENT_TIMES.flip ? 0.05 * (Math.sin(b * 1.45) + 0.6 * Math.sin(b * 3.1 + 1)) : 0;
    const alpha = flapAlpha + gimAuth * Math.sin(gimbal) + gust;
    // Bank: a second-order lag behind its command, its torque from the cross gimbal.
    const bankAlpha = 2.2 * 2.2 * (bankCmd - bank) - 2 * 2.2 * bankRate;
    const gimbalBank = gimAuth > 1e-6 ? Math.asin(clamp(bankAlpha / gimAuth, -Math.sin(GIMBAL_MAX), Math.sin(GIMBAL_MAX))) : 0;

    // Thrust leaves the nozzles along the hull, swung by the gimbal (positive tilts it south, swinging the nose north).
    const tp = pitch - gimbal;
    const tx = -sb * Math.cos(tp), ty = cb * Math.cos(tp), tz = -Math.sin(tp);
    const fx = thrust * tx + dx, fy = thrust * ty + dy, fz = thrust * tz + dz;

    if (j % every === 0) {
      out.x[k] = x;
      out.y[k] = y;
      out.z[k] = z;
      out.vx[k] = vx;
      out.vy[k] = vy;
      out.vz[k] = vz;
      out.pitch[k] = pitch;
      out.bank[k] = bank;
      out.gimbal[k] = gimbal;
      out.gimbalBank[k] = gimbalBank;
      out.flap[k] = flap;
      out.throttle[k] = thrust > 0 ? thr : 0;
      for (let i = 0; i < 3; i++) out.engine[i][k] = thrust > 0 ? lit[i] : 0;
      out.accel[k] = speed > 0.1 ? (fx * vx + fy * vy + fz * vz - m * G * vy) / (m * speed * G) : 0;
      out.q[k] = q;
      out.mass[k] = m;
      k++;
    }

    if (contacted) {
      if (b > out.contact + 2) break;
      continue;
    }
    vx += (fx / m) * STEP;
    vy += (fy / m - G) * STEP;
    vz += (fz / m) * STEP;
    x += vx * STEP;
    y += vy * STEP;
    z += vz * STEP;
    w += alpha * STEP;
    pitch += w * STEP;
    bankRate += bankAlpha * STEP;
    bank += bankRate * STEP;
    m -= (thrust / (ISP * G)) * STEP;
    if (y <= 0) {
      out.contact = b;
      out.contactSpeed = [Math.hypot(vx, vz), -vy];
      break;
    }
    if (guiding && y <= P.catchAlt) {
      contacted = true;
      out.landed = true;
      out.contact = b;
      out.contactSpeed = [Math.hypot(vx, vz), -vy];
      offAt[0] = b + CUTOFF_AFTER;
      y = P.catchAlt;
      vx = vy = vz = 0;
      w = 0;
    }
  }
  out.n = Math.max(2, k);
  return out;
}

/** Linear sample of a channel at `b` (seconds from the burn). */
export function sampleAt(d: Descent, ch: Float32Array, b: number) {
  const i = (b - d.t0) * DESCENT_RATE;
  const i0 = clamp(Math.floor(i), 0, d.n - 2);
  const u = clamp(i - i0, 0, 1);
  return ch[i0] + (ch[i0 + 1] - ch[i0]) * u;
}
