import type * as THREE from 'three';

/** C1 interpolation through keyed values (monotone cubic Hermite), flat at the first and last key. */
export function monotoneKeys(times: number[], values: number[], x: number) {
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

/**
 * Quintic Hermite from p0 (velocity v0) to p1 (velocity v1) over T seconds, with zero acceleration at both
 * ends: a cubic matches velocity but jumps straight to full acceleration, which reads as a kick.
 */
export function hermite(out: THREE.Vector3, p0: THREE.Vector3, v0: THREE.Vector3, p1: THREE.Vector3, v1: THREE.Vector3, T: number, u: number) {
  const u3 = u * u * u;
  const u4 = u3 * u;
  const u5 = u4 * u;
  const h5 = 10 * u3 - 15 * u4 + 6 * u5;
  return out
    .copy(p0)
    .multiplyScalar(1 - h5)
    .addScaledVector(v0, (u - 6 * u3 + 8 * u4 - 3 * u5) * T)
    .addScaledVector(p1, h5)
    .addScaledVector(v1, (-4 * u3 + 7 * u4 - 3 * u5) * T);
}
