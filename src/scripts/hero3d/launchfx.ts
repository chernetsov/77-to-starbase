import * as THREE from 'three';
import type { Puffs } from './puffs';

export type FxState = { engines: boolean; spool: number; alt: number; enginesY: number };

const STEAM = 0;
const EXHAUST = 1;
const TRAIL = 2;

const smooth = THREE.MathUtils.smoothstep;

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
        if (lastY < 0) lastY = y;
        const climb = Math.max(0, y - lastY);
        if (st.alt > 3 && st.alt < 1700) {
          exhaustCarry += climb;
          const spacing = (lowPower ? 7 : 4) * (1 + st.alt / 900);
          const fade = 1 - smooth(st.alt, 500, 1700);
          while (exhaustCarry >= spacing) {
            exhaustCarry -= spacing;
            const ey = y - exhaustCarry - 6;
            spawn(
              EXHAUST,
              (Math.random() - 0.5) * 3,
              ey,
              (Math.random() - 0.5) * 3,
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
            spawn(TRAIL, (Math.random() - 0.5) * 2, ey, (Math.random() - 0.5) * 2, 0, -4, 0, 6 + Math.random() * 3, 0.9, 30, 0.42 * fadeIn, 0.2);
          }
        }
        lastY = y;
        flamePos.set(0, y - 12, 0);
        flamePower = st.spool * 1.3;
      }

      for (let i = 0; i < max; i++) {
        const o = i * F;
        if (s[o + AGE] >= s[o + LIFE]) continue;
        const age = (s[o + AGE] += dt);
        const kind = Math.floor(s[o + META] / 4);
        const life = s[o + LIFE];
        const t = age / life;
        if (kind === STEAM) {
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
        const shade = kind === STEAM ? 0.78 + 0.22 * Math.min(1, y / 140) : kind === EXHAUST ? 0.93 : 1;
        puffs.push(s[o + X], y, s[o + Z], s[o + SIZE], s[o + ROT], alpha, heat, s[o + META] % 4, shade);
      }
      puffs.setFlame(flamePos, flamePower);
    },
    clear() {
      for (let i = 0; i < max; i++) s[i * F + AGE] = 1e9;
      steamCarry = exhaustCarry = trailCarry = 0;
      lastY = -1;
      flamePower = 0;
    },
  };
}
