import * as THREE from 'three';

// Production Cybertruck, in meters: length 5.683, width 2.03 (no mirrors), height 1.791,
// wheelbase 3.635, 35" tires. The body is a faceted loft through cross-sections along x;
// x = 0 is the nose, +x runs toward the tailgate, y is up, z is across (mirrored).
const L = 5.683;
const H = 1.791;
const HALF_W = 1.0;
const APEX_X = 2.85;
const NOSE_Y = 1.02;
const TAIL_Y = 1.3;
const FRONT_AXLE = 0.98;
const REAR_AXLE = FRONT_AXLE + 3.635;
const TIRE_R = 0.445;
const TIRE_W = 0.29;
const TRACK_HALF = HALF_W - TIRE_W / 2 - 0.01;

const lerp = THREE.MathUtils.lerp;

function roofY(x: number) {
  return x <= APEX_X ? lerp(NOSE_Y, H, x / APEX_X) : lerp(H, TAIL_Y, (x - APEX_X) / (L - APEX_X));
}
function beltY(x: number) {
  return lerp(NOSE_Y - 0.01, 1.1, x / L);
}
function roofHalfWidth(x: number) {
  return x <= APEX_X ? lerp(0.985, 0.74, x / APEX_X) : lerp(0.74, 0.8, (x - APEX_X) / (L - APEX_X));
}

// Angular wheel arch: rises from the rocker to a flat top over the tire.
function archY(x: number, axle: number) {
  const d = Math.abs(x - axle);
  if (d >= 0.68) return 0.45;
  if (d >= 0.56) return lerp(0.45, 0.9, (0.68 - d) / 0.12);
  if (d >= 0.36) return lerp(0.9, 0.98, (0.56 - d) / 0.2);
  return 0.98;
}
function bottomY(x: number) {
  if (x < 0.24) return lerp(1.0, 0.45, x / 0.24);
  if (x > 5.45) return lerp(0.45, 0.62, (x - 5.45) / (L - 5.45));
  return Math.max(archY(x, FRONT_AXLE), archY(x, REAR_AXLE));
}

type Pt = [number, number]; // [y, z]

function section(x: number): Pt[] {
  const yb = bottomY(x);
  const belt = beltY(x);
  const roof = roofY(x);
  const hw = roofHalfWidth(x);
  const crease = Math.min(belt, Math.max(0.6, yb + 0.12));
  const upper = Math.max(roof - belt, 0);
  const zAt = (y: number) => (upper < 1e-4 ? HALF_W : lerp(HALF_W, hw, (y - belt) / upper));
  const inset = Math.min(0.05, upper * 0.25);
  return [
    [yb, HALF_W + 0.025],
    [crease, HALF_W],
    [belt, HALF_W],
    [belt + inset, zAt(belt + inset)],
    [roof - inset, zAt(roof - inset)],
    [roof, hw],
    [roof, Math.max(hw - 0.08, 0)],
    [roof, 0],
  ];
}

const STATIONS = [
  0, 0.04, 0.12, 0.24, 0.3, 0.42, 0.62, 1.0, 1.3, 1.34, 1.54, 1.66, 2.0, 2.24, 2.32, 2.45, APEX_X, 3.35, 3.5, 3.75,
  3.935, 4.055, 4.255, 4.615, 4.975, 5.175, 5.295, 5.45, 5.58, L,
];

type Bucket = 'steel' | 'glass' | 'cladding' | 'tonneau';

function stripMaterial(strip: number, x: number): Bucket {
  if (strip === 0) return 'cladding';
  if (strip === 3) return x >= 1.3 && x < 3.5 && (x < 2.24 || x > 2.32) ? 'glass' : 'steel';
  if (strip === 6) {
    if (x >= 1.0 && x < 3.35) return 'glass';
    if (x >= 3.75) return 'tonneau';
  }
  return 'steel';
}

function buildBody() {
  const buckets: Record<Bucket, number[]> = { steel: [], glass: [], cladding: [], tonneau: [] };
  const normals: Record<Bucket, number[]> = { steel: [], glass: [], cladding: [], tonneau: [] };
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const pushNormal = (b: Bucket, count: number) => {
    n.normalize();
    for (let k = 0; k < count; k++) normals[b].push(n.x, n.y, n.z);
  };
  // One normal per quad (from its diagonals) so slightly non-planar facets still shade as a single flat panel.
  const quad = (b: Bucket, a: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, e: THREE.Vector3) => {
    buckets[b].push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z, a.x, a.y, a.z, d.x, d.y, d.z, e.x, e.y, e.z);
    n.subVectors(d, a).cross(tmp.subVectors(e, c));
    pushNormal(b, 6);
  };
  const v = (x: number, p: Pt, side: number) => new THREE.Vector3(x, p[0], p[1] * side);

  for (let i = 0; i < STATIONS.length - 1; i++) {
    const x0 = STATIONS[i];
    const x1 = STATIONS[i + 1];
    const s0 = section(x0);
    const s1 = section(x1);
    const mid = (x0 + x1) / 2;
    for (let j = 0; j < s0.length - 1; j++) {
      const b = stripMaterial(j, mid);
      quad(b, v(x0, s0[j], 1), v(x1, s1[j], 1), v(x1, s1[j + 1], 1), v(x0, s0[j + 1], 1));
      quad(b, v(x0, s0[j + 1], -1), v(x1, s1[j + 1], -1), v(x1, s1[j], -1), v(x0, s0[j], -1));
    }
    quad('cladding', v(x0, s0[0], -1), v(x1, s1[0], -1), v(x1, s1[0], 1), v(x0, s0[0], 1));
  }

  // End caps: the vertical tailgate and the thin nose.
  for (const x of [0, L]) {
    const s = section(x);
    const ring = [...s.map((p) => v(x, p, 1)), ...s.slice().reverse().map((p) => v(x, p, -1))];
    const c = ring.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(ring.length);
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      buckets.steel.push(c.x, c.y, c.z, a.x, a.y, a.z, b.x, b.y, b.z);
      n.set(x === 0 ? -1 : 1, 0, 0);
      pushNormal('steel', 3);
    }
  }

  return Object.fromEntries(
    (Object.keys(buckets) as Bucket[]).map((k) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(buckets[k], 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(normals[k], 3));
      return [k, g];
    }),
  ) as Record<Bucket, THREE.BufferGeometry>;
}

function buildWheel(rubber: THREE.Material, cover: THREE.Material, side: number) {
  const wheel = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(TIRE_R, TIRE_R, TIRE_W, 36), rubber);
  tire.rotation.x = Math.PI / 2;
  wheel.add(tire);
  const shoulder = new THREE.Mesh(new THREE.TorusGeometry(TIRE_R - 0.05, 0.05, 6, 36), rubber);
  shoulder.position.z = side * (TIRE_W / 2 - 0.02);
  wheel.add(shoulder);
  // Flat, faceted aero cover like the production wheels.
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.03, 6), cover);
  disc.rotation.x = Math.PI / 2;
  disc.position.z = side * (TIRE_W / 2 + 0.005);
  wheel.add(disc);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.035, 6), rubber);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = side * (TIRE_W / 2 + 0.02);
  wheel.add(hub);
  return wheel;
}

export function buildCybertruck(_env: THREE.Texture | null = null) {
  const g = new THREE.Group();
  g.name = 'cybertruck';

  const mats = {
    steel: new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 1, roughness: 0.36, side: THREE.DoubleSide }),
    glass: new THREE.MeshStandardMaterial({ color: 0x050607, metalness: 0.6, roughness: 0.06, side: THREE.DoubleSide }),
    cladding: new THREE.MeshStandardMaterial({ color: 0x2b2c2f, roughness: 0.8, side: THREE.DoubleSide }),
    tonneau: new THREE.MeshStandardMaterial({ color: 0x1d1e20, metalness: 0.4, roughness: 0.55, side: THREE.DoubleSide }),
  };
  const body = buildBody();
  for (const k of Object.keys(body) as Bucket[]) {
    const m = new THREE.Mesh(body[k], mats[k]);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }

  const lightWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f7ff, emissiveIntensity: 8 });
  const lightRed = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 5 });
  const front = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.028, 1.94), lightWhite);
  front.position.set(0.012, NOSE_Y - 0.035, 0);
  g.add(front);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, 1.9), lightRed);
  rear.position.set(L + 0.01, TAIL_Y - 0.06, 0);
  g.add(rear);

  // Small door mirrors just behind the A-pillar, and the door shut lines on the flat flank.
  const mirrorGeo = new THREE.BoxGeometry(0.17, 0.09, 0.13);
  const seam = new THREE.MeshBasicMaterial({ color: 0x1a1b1d });
  for (const side of [-1, 1]) {
    const mirror = new THREE.Mesh(mirrorGeo, mats.cladding);
    mirror.position.set(1.4, beltY(1.4) + 0.08, side * (HALF_W + 0.06));
    mirror.rotation.y = side * 0.12;
    g.add(mirror);
    for (const x of [1.62, 2.28, 3.48]) {
      const top = beltY(x);
      const bottom = Math.min(top, Math.max(0.6, bottomY(x) + 0.12));
      const line = new THREE.Mesh(new THREE.BoxGeometry(0.008, top - bottom, 0.004), seam);
      line.position.set(x, (top + bottom) / 2, side * (HALF_W + 0.002));
      g.add(line);
    }
  }

  const rubber = new THREE.MeshStandardMaterial({ color: 0x141415, roughness: 0.95 });
  const cover = new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.6, roughness: 0.45, flatShading: true });
  const wheels: THREE.Group[] = [];
  for (const axle of [FRONT_AXLE, REAR_AXLE]) {
    for (const side of [-1, 1]) {
      const w = buildWheel(rubber, cover, side);
      w.position.set(axle, TIRE_R, side * TRACK_HALF);
      w.traverse((o) => ((o as THREE.Mesh).castShadow = true));
      g.add(w);
      wheels.push(w);
    }
  }

  g.children.forEach((c) => (c.position.x -= L / 2));
  return { group: g, wheels, length: L };
}

export default () => buildCybertruck().group;
