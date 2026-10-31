import * as THREE from 'three';
import type { Puffs } from './puffs';

export type FxState = { engines: boolean; spool: number; alt: number; enginesY: number };

const STEAM = 0;
const EXHAUST = 1;
const TRAIL = 2;
const VENT = 3;
/** Landing-burn smoke: like the exhaust, but drawn with the softer cloud sprites. */
const BURN = 4;
/** Vent puffs per unit of vent rate. */
const VENT_STREAM = 6;

const smooth = THREE.MathUtils.smoothstep;
/** Where the flame trench opens, either side of the mount (m along ±x). */
const TRENCH_END = 30;

/** Downrange heading: east over the Gulf, a touch south. */
export const DOWNRANGE = new THREE.Vector3(1, 0, 0.18).normalize();
const PITCH_ALT = 900;
const TURN_R = 22000;

/**
 * Gravity turn: straight up to PITCH_ALT, then the ground track grows as (alt − PITCH_ALT)² / 2·TURN_R.
 * Writes the horizontal offset at `alt` into `out` and returns the path's slope (downrange metres per metre climbed).
 */
export function flightPath(alt: number, out: THREE.Vector3) {
  const a = Math.max(0, alt - PITCH_ALT);
  out.copy(DOWNRANGE).multiplyScalar((a * a) / (2 * TURN_R));
  return a / TURN_R;
}
const along = new THREE.Vector3();

/**
 * Launch vapor: the deluge flashes to steam and rolls out along the ground for hundreds of meters,
 * an exhaust column trails the booster through the first kilometer or so, then a thin contrail.
 */
export function createLaunchFx(lowPower: boolean) {
  const max = lowPower ? 2000 : 5000;
  const density = lowPower ? 0.5 : 1;
  const F = 15;
  const s = new Float32Array(max * F);
  // Fields: x y z vx vy vz size grow life age alpha heat rot kind+variant stretch
  const X = 0, Y = 1, Z = 2, VX = 3, VY = 4, VZ = 5, SIZE = 6, GROW = 7, LIFE = 8, AGE = 9, ALPHA = 10, HEAT = 11, ROT = 12, META = 13, STRETCH = 14;
  for (let i = 0; i < max; i++) s[i * F + AGE] = s[i * F + LIFE] = 1e9;
  let cursor = 0;
  let steamCarry = 0;
  let lastY = -1;
  let exhaustCarry = 0;
  let trailCarry = 0;
  let ventCarry = 0;
  let burnCarry = 0;
  let wakeCarry = 0;
  const flamePos = new THREE.Vector3();
  let flamePower = 0;

  function spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grow: number, life: number, alpha: number, heat: number, stretch = 1, age = 0) {
    const o = cursor * F;
    cursor = (cursor + 1) % max;
    s.set([x, y, z, vx, vy, vz, size, grow, life, age, alpha, heat, Math.random() * 6.28, kind * 4 + Math.floor(Math.random() * 4), stretch], o);
  }

  /**
   * Deluge steam. Pad 2's flame trench runs east–west, so most of it blasts out of both trench ends low and fast
   * before it slows and billows up; some climbs straight off the mount, and the rest rolls out over the pad.
   */
  function emitSteam(n: number) {
    for (let k = 0; k < n; k++) {
      const pick = Math.random();
      if (pick < 0.6) {
        const side = Math.random() < 0.5 ? -1 : 1;
        const sp = 35 + Math.random() * 60;
        spawn(
          STEAM,
          side * (TRENCH_END + Math.random() * 8),
          2 + Math.random() * 4,
          (Math.random() - 0.5) * 12,
          side * sp,
          3 + Math.random() * 8,
          (Math.random() - 0.5) * sp * 0.25,
          10 + Math.random() * 10,
          5 + Math.random() * 4,
          40 + Math.random() * 25,
          0.65 + Math.random() * 0.3,
          0.6,
        );
        continue;
      }
      const a = Math.random() * Math.PI * 2;
      const column = pick < 0.85;
      const sp = column ? 4 + Math.random() * 8 : 20 + Math.random() * 40;
      const r = 4 + Math.random() * 8;
      spawn(
        STEAM,
        Math.cos(a) * r,
        3 + Math.random() * 5,
        Math.sin(a) * r,
        Math.cos(a) * sp,
        column ? 14 + Math.random() * 16 : 2 + Math.random() * 9,
        Math.sin(a) * sp,
        14 + Math.random() * 14,
        4 + Math.random() * 4,
        40 + Math.random() * 25,
        0.6 + Math.random() * 0.3,
        0.6,
      );
    }
  }

  return {
    max,
    simulate(dt: number, st: FxState) {
      if (dt <= 0) return;
      flamePower = 0;
      if (st.engines) {
        // Steam pours out while the plume is still hitting the deluge plate.
        const onPad = 1 - smooth(st.alt, 120, 420);
        steamCarry += dt * 70 * density * st.spool * onPad;
        const n = Math.floor(steamCarry);
        steamCarry -= n;
        emitSteam(n);

        const y = st.enginesY;
        const base = y - st.alt;
        if (lastY < 0) lastY = y;
        const climb = Math.max(0, y - lastY);
        if (st.alt > 3 && st.alt < 1700) {
          exhaustCarry += climb;
          const spacing = (lowPower ? 7 : 4) * (1 + st.alt / 900);
          const fade = 1 - smooth(st.alt, 500, 1700);
          while (exhaustCarry >= spacing) {
            exhaustCarry -= spacing;
            const ey = y - exhaustCarry - 6;
            flightPath(ey - base, along);
            spawn(
              EXHAUST,
              along.x + (Math.random() - 0.5) * 3,
              ey,
              along.z + (Math.random() - 0.5) * 3,
              (Math.random() - 0.5) * 5,
              -(6 + Math.random() * 12) * (1 - st.alt / 2500),
              (Math.random() - 0.5) * 5,
              12 + Math.random() * 6 + st.alt * 0.004,
              2 + Math.random() * 1.5,
              14 + Math.random() * 8,
              (0.45 + Math.random() * 0.25) * fade,
              0.55,
            );
          }
        }
        if (st.alt > 450) {
          // At hundreds of metres a second, puffs dropped at a fixed rate or climb would string out into beads.
          // A real trail at speed is one continuous line that widens behind the vehicle, so they are spaced by
          // distance flown, closer than their own size, and drawn tall along the (near-vertical) path.
          const slope = flightPath(st.alt, along);
          trailCarry += climb * Math.sqrt(1 + slope * slope);
          const size = 7 + st.alt * 0.003;
          const spacing = size * (lowPower ? 0.2 : 0.12);
          const fadeIn = smooth(st.alt, 450, 1200);
          while (trailCarry >= spacing) {
            trailCarry -= spacing;
            const ey = y - trailCarry / Math.sqrt(1 + slope * slope) - 10;
            flightPath(ey - base, along);
            spawn(TRAIL, along.x + (Math.random() - 0.5) * 2, ey, along.z + (Math.random() - 0.5) * 2, 0, -4, 0, size * (0.9 + Math.random() * 0.2), 1.1, 60, 0.13 * fadeIn, 0.2, 0.55);
          }
        }
        lastY = y;
        flightPath(st.alt - 12, along);
        // The flame keeps hitting the pad for the first tens of metres, lighting the steam from the ground up.
        flamePos.set(along.x, Math.max(8, y - 12 - Math.min(st.alt, 70)), along.z);
        flamePower = st.spool * 1.5;
      }

      for (let i = 0; i < max; i++) {
        const o = i * F;
        if (s[o + AGE] >= s[o + LIFE]) continue;
        const age = (s[o + AGE] += dt);
        const kind = Math.floor(s[o + META] / 4);
        const life = s[o + LIFE];
        const t = age / life;
        if (kind === VENT) {
          // Boil-off is colder and denser than the air: it slows quickly and sags as it drifts.
          const drag = Math.exp(-dt * 1.1);
          s[o + VX] *= drag;
          s[o + VY] = s[o + VY] * drag - dt * 0.35;
          s[o + VZ] *= drag;
        } else if (kind === STEAM) {
          const drag = Math.exp(-dt * 0.38);
          s[o + VX] *= drag;
          s[o + VZ] *= drag;
          // Warm and moist, it keeps rising as it slows, so the jets pile up into billows.
          s[o + VY] = s[o + VY] * Math.exp(-dt * 0.3) + dt * 1.6 * (1 - t);
        } else {
          const drag = Math.exp(-dt * (kind === EXHAUST || kind === BURN ? 0.9 : 2));
          s[o + VX] *= drag;
          s[o + VY] *= drag;
          s[o + VZ] *= drag;
          s[o + VY] += dt * 0.25;
        }
        const y = s[o + Y];
        // Onshore breeze from the Gulf, stronger with height.
        s[o + X] += (s[o + VX] - 1.4 - y * 0.0035) * dt;
        s[o + Y] += s[o + VY] * dt;
        s[o + Z] += (s[o + VZ] - 0.7 - y * 0.0018) * dt;
        s[o + SIZE] += s[o + GROW] * dt * 1.6 * Math.exp(-2 * t);
        if (kind === STEAM) s[o + Y] = Math.max(s[o + Y], s[o + SIZE] * 0.26);
        s[o + ROT] += dt * 0.04 * ((i & 1) * 2 - 1);
      }
    },
    /**
     * Landing-burn smoke: puffs shed along the flames below `at` (the nozzle exits) in the exhaust direction `dir`.
     * They lose their speed within a second or two and hang there, so the slowing ship sinks out from under them.
     */
    burn(dt: number, power: number, at: THREE.Vector3, dir: THREE.Vector3) {
      // Many faint, fast-spreading puffs so they overlap into a haze; no single one is dense enough to read as a ball.
      burnCarry += dt * 90 * density * power;
      while (burnCarry >= 1) {
        burnCarry -= 1;
        // Three Raptors leave a thin wake, and the flames (about 48 m) must stay clear of it.
        const d = 44 + Math.random() * 30;
        const sp = 8 + Math.random() * 16;
        spawn(
          BURN,
          at.x + dir.x * d + (Math.random() - 0.5) * 8,
          at.y + dir.y * d + (Math.random() - 0.5) * 8,
          at.z + dir.z * d + (Math.random() - 0.5) * 8,
          dir.x * sp + (Math.random() - 0.5) * 4,
          dir.y * sp + (Math.random() - 0.5) * 4,
          dir.z * sp + (Math.random() - 0.5) * 4,
          9 + Math.random() * 5,
          5 + Math.random() * 3,
          12 + Math.random() * 8,
          0.014 + Math.random() * 0.01,
          0.2,
        );
      }
    },
    /**
     * The returning ship's vapor trail along its path from `a` to `b`, spaced by distance like the ascent trail,
     * already `ageA` and `ageB` seconds old at the two ends (it is laid while time races). `strength` fades it
     * out as the ship slows. The engines are off, so it is only a faint condensation wake, not exhaust.
     */
    wake(a: THREE.Vector3, b: THREE.Vector3, strength: number, ageA: number, ageB: number) {
      const len = a.distanceTo(b);
      const size = lowPower ? 18 : 12;
      const spacing = size * (lowPower ? 0.2 : 0.12);
      const life = 90;
      const grow = 0.3;
      let d = spacing - wakeCarry;
      for (; d <= len; d += spacing) {
        if (strength <= 0.01) continue;
        const u = d / Math.max(len, 1e-3);
        const y = a.y + (b.y - a.y) * u;
        // Where the breeze and growth in `simulate` would have taken it by now.
        const k = Math.min(ageA + (ageB - ageA) * u, life);
        spawn(
          TRAIL,
          a.x + (b.x - a.x) * u + (Math.random() - 0.5) * 3 - (1.4 + y * 0.0035) * k,
          y + (Math.random() - 0.5) * 3,
          a.z + (b.z - a.z) * u + (Math.random() - 0.5) * 3 - (0.7 + y * 0.0018) * k,
          0,
          0,
          0,
          size * (0.8 + Math.random() * 0.4) + grow * 0.8 * life * (1 - Math.exp((-2 * k) / life)),
          grow,
          life,
          0.018 * strength,
          0,
          1,
          k,
        );
      }
      wakeCarry = len - (d - spacing);
    },
    /**
     * Cryogenic boil-off from vents on the fueled stack, a steady jet that thins out within a few metres; `rate`
     * sets its strength across all vents. Each unit of rate is VENT_STREAM small faint puffs, so they overlap
     * into a line instead of reading as separate balls.
     */
    vent(dt: number, rate: number, vents: { pos: THREE.Vector3; dir: THREE.Vector3; weight: number }[]) {
      ventCarry += dt * rate * VENT_STREAM * density;
      const total = vents.reduce((a, v) => a + v.weight, 0);
      while (ventCarry >= 1) {
        ventCarry -= 1;
        let pick = Math.random() * total;
        const v = vents.find((c) => (pick -= c.weight) <= 0) ?? vents[0];
        const sp = 7 + Math.random() * 5;
        // Spread over the frame along the jet, so puffs emitted together don't stack at the nozzle.
        const lead = Math.random() * dt * sp;
        spawn(
          VENT,
          v.pos.x + v.dir.x * lead + (Math.random() - 0.5) * 0.4,
          v.pos.y + v.dir.y * lead + (Math.random() - 0.5) * 0.4,
          v.pos.z + v.dir.z * lead + (Math.random() - 0.5) * 0.4,
          v.dir.x * sp + (Math.random() - 0.5) * 0.6,
          v.dir.y * sp + (Math.random() - 0.5) * 0.4,
          v.dir.z * sp + (Math.random() - 0.5) * 0.6,
          1.4 + Math.random() * 0.8,
          2.6 + Math.random() * 1.4,
          3 + Math.random() * 2,
          0.07 + Math.random() * 0.04,
          0,
        );
      }
    },
    push(puffs: Puffs) {
      for (let i = 0; i < max; i++) {
        const o = i * F;
        const age = s[o + AGE];
        const life = s[o + LIFE];
        if (age >= life) continue;
        const kind = Math.floor(s[o + META] / 4);
        // Trails thin out over their whole life, so the oldest end dissolves to nothing.
        const fade = kind === TRAIL || kind === VENT ? Math.pow(1 - age / life, 1.6) : 1 - smooth(age, life * 0.5, life);
        const alpha = s[o + ALPHA] * smooth(age, 0, kind === STEAM ? 0.8 : kind === BURN ? 1.5 : kind === VENT ? 0.08 : 0.3) * fade;
        const heat = s[o + HEAT] * Math.exp(-age * (kind === STEAM ? 2 : 2.5));
        const y = s[o + Y];
        const shade = kind === STEAM ? 0.7 + 0.3 * Math.min(1, y / 140) : kind === EXHAUST || kind === BURN ? 0.93 : kind === VENT ? 1.04 : 1;
        const soft = kind === TRAIL || kind === BURN || kind === VENT ? 4 : 0;
        puffs.push(s[o + X], y, s[o + Z], s[o + SIZE], s[o + ROT], alpha, heat, (s[o + META] % 4) + soft, shade, s[o + STRETCH]);
      }
      puffs.setFlame(flamePos, flamePower);
    },
    clear() {
      // Boil-off keeps drifting through a reset; only launch vapor is wiped.
      for (let i = 0; i < max; i++) if (Math.floor(s[i * F + META] / 4) !== VENT) s[i * F + AGE] = 1e9;
      steamCarry = exhaustCarry = trailCarry = burnCarry = wakeCarry = 0;
      lastY = -1;
      flamePower = 0;
    },
  };
}

/**
 * Frost on the propellant tanks of a fueled stack: soft-edged white bands with drip streaks, sitting
 * just proud of the hull. `bands` are [bottom, top] heights above the booster base.
 */
export function buildFrost(radius: number, bands: [number, number][]) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(256, 256);
  for (let y = 0; y < 256; y++) {
    const v = y / 255;
    const edge = smooth(v, 0, 0.12) * (1 - smooth(v, 0.85, 1));
    for (let x = 0; x < 256; x++) {
      const streak = 0.55 + 0.45 * Math.sin(x * 0.37 + Math.sin(x * 0.11) * 3) * Math.sin(x * 0.053 + 1.3);
      const n = Math.random() * 0.25;
      const a = Math.max(0, Math.min(1, edge * (0.55 + 0.35 * streak + n)));
      const i = (y * 256 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(a * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const alpha = new THREE.CanvasTexture(c);
  alpha.wrapS = THREE.RepeatWrapping;
  alpha.repeat.set(3, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xf4f7fa,
    roughness: 0.85,
    metalness: 0,
    alphaMap: alpha,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const g = new THREE.Group();
  for (const [y0, y1] of bands) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.006, radius * 1.006, y1 - y0, 64, 1, true), mat);
    m.position.y = (y0 + y1) / 2;
    g.add(m);
  }
  return g;
}
