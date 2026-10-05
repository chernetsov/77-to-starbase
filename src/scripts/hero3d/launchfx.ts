import * as THREE from 'three';
import type { Puffs } from './puffs';

export type FxState = { engines: boolean; spool: number; alt: number; enginesY: number };

const STEAM = 0;
const EXHAUST = 1;
const TRAIL = 2;
const VENT = 3;

const smooth = THREE.MathUtils.smoothstep;

/** Downrange heading: east over the Gulf, a touch south. */
export const DOWNRANGE = new THREE.Vector3(-0.12, 0, 1).normalize();
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
  const max = lowPower ? 900 : 1900;
  const density = lowPower ? 0.5 : 1;
  const F = 14;
  const s = new Float32Array(max * F);
  // Fields: x y z vx vy vz size grow life age alpha heat rot spin kind+variant
  const X = 0, Y = 1, Z = 2, VX = 3, VY = 4, VZ = 5, SIZE = 6, GROW = 7, LIFE = 8, AGE = 9, ALPHA = 10, HEAT = 11, ROT = 12, META = 13;
  for (let i = 0; i < max; i++) s[i * F + AGE] = s[i * F + LIFE] = 1e9;
  let cursor = 0;
  let steamCarry = 0;
  let lastY = -1;
  let exhaustCarry = 0;
  let trailCarry = 0;
  let ventCarry = 0;
  const flamePos = new THREE.Vector3();
  let flamePower = 0;

  function spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, grow: number, life: number, alpha: number, heat: number) {
    const o = cursor * F;
    cursor = (cursor + 1) % max;
    s.set([x, y, z, vx, vy, vz, size, grow, life, 0, alpha, heat, Math.random() * 6.28, kind * 4 + Math.floor(Math.random() * 4)], o);
  }

  function emitSteam(n: number) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const column = Math.random() < 0.2;
      const sp = column ? 6 + Math.random() * 10 : 28 + Math.random() * 62;
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
        24 + Math.random() * 12,
        0.5 + Math.random() * 0.35,
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
          trailCarry += climb;
          const spacing = lowPower ? 16 : 9;
          const fadeIn = smooth(st.alt, 450, 1200);
          while (trailCarry >= spacing) {
            trailCarry -= spacing;
            const ey = y - trailCarry - 10;
            flightPath(ey - base, along);
            spawn(TRAIL, along.x + (Math.random() - 0.5) * 2, ey, along.z + (Math.random() - 0.5) * 2, 0, -4, 0, 6 + Math.random() * 3, 0.9, 30, 0.42 * fadeIn, 0.2);
          }
        }
        lastY = y;
        flightPath(st.alt - 12, along);
        flamePos.set(along.x, y - 12, along.z);
        flamePower = st.spool * 1.3;
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
          s[o + VY] = s[o + VY] * Math.exp(-dt * 0.3) + dt * 1.1 * (1 - t);
        } else {
          const drag = Math.exp(-dt * (kind === EXHAUST ? 0.9 : 2));
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
    /** Cryogenic boil-off from vents on the fueled stack; `rate` is puffs per second across all vents. */
    vent(dt: number, rate: number, vents: { pos: THREE.Vector3; dir: THREE.Vector3; weight: number }[]) {
      ventCarry += dt * rate * density;
      const total = vents.reduce((a, v) => a + v.weight, 0);
      while (ventCarry >= 1) {
        ventCarry -= 1;
        let pick = Math.random() * total;
        const v = vents.find((c) => (pick -= c.weight) <= 0) ?? vents[0];
        const sp = 2.5 + Math.random() * 4;
        spawn(
          VENT,
          v.pos.x + (Math.random() - 0.5) * 1.2,
          v.pos.y + (Math.random() - 0.5) * 1.2,
          v.pos.z + (Math.random() - 0.5) * 1.2,
          v.dir.x * sp + (Math.random() - 0.5),
          v.dir.y * sp + (Math.random() - 0.5) * 0.6,
          v.dir.z * sp + (Math.random() - 0.5),
          3 + Math.random() * 2.5,
          2.4 + Math.random() * 2,
          6 + Math.random() * 5,
          0.4 + Math.random() * 0.25,
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
        const alpha = s[o + ALPHA] * smooth(age, 0, kind === STEAM ? 0.8 : 0.3) * (1 - smooth(age, life * 0.5, life));
        const heat = s[o + HEAT] * Math.exp(-age * (kind === STEAM ? 2 : 2.5));
        const y = s[o + Y];
        const shade = kind === STEAM ? 0.78 + 0.22 * Math.min(1, y / 140) : kind === EXHAUST ? 0.93 : kind === VENT ? 1.04 : 1;
        puffs.push(s[o + X], y, s[o + Z], s[o + SIZE], s[o + ROT], alpha, heat, s[o + META] % 4, shade);
      }
      puffs.setFlame(flamePos, flamePower);
    },
    clear() {
      // Boil-off keeps drifting through a reset; only launch vapor is wiped.
      for (let i = 0; i < max; i++) if (Math.floor(s[i * F + META] / 4) !== VENT) s[i * F + AGE] = 1e9;
      steamCarry = exhaustCarry = trailCarry = 0;
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
