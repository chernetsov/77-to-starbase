import * as THREE from 'three';

// Published dimensions in meters: length 5.683, width 2.03 (no mirrors), height 1.791,
// wheelbase 3.635, 35" tires. Origin is ground level at the body center; the truck faces +x.
const L = 5.683;
const W = 2.03;
const H = 1.791;
const WHEELBASE = 3.635;
const FRONT_AXLE = 0.98;
const REAR_AXLE = FRONT_AXLE + WHEELBASE;
const TIRE_R = 0.445;
const TIRE_W = 0.3;

const NOSE = { x: 0.04, y: 1.06 };
const APEX = { x: 3.08, y: H };
const TAIL = { x: L, y: 1.31 };

function roofY(x: number) {
  if (x <= APEX.x) return NOSE.y + ((APEX.y - NOSE.y) * (x - NOSE.x)) / (APEX.x - NOSE.x);
  return APEX.y + ((TAIL.y - APEX.y) * (x - APEX.x)) / (TAIL.x - APEX.x);
}

// Sides lean inward above the beltline, so the roof is narrower than the body.
function halfWidth(y: number) {
  const t = THREE.MathUtils.clamp((y - 1.0) / (H - 1.0), 0, 1);
  return W / 2 - 0.2 * t;
}

function taper(geo: THREE.BufferGeometry) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const z = p.getZ(i);
    p.setZ(i, (z / (W / 2)) * halfWidth(y));
  }
  geo.computeVertexNormals();
}

function arch(path: THREE.Path | THREE.Shape, axle: number, reverse: boolean) {
  const pts: [number, number][] = [
    [axle + 0.66, 0.42],
    [axle + 0.5, 0.98],
    [axle - 0.5, 0.98],
    [axle - 0.66, 0.42],
  ];
  (reverse ? pts.slice().reverse() : pts).forEach(([x, y]) => path.lineTo(x, y));
}

function bodyShape() {
  const s = new THREE.Shape();
  s.moveTo(0.14, 0.42);
  s.lineTo(0.0, 0.62);
  s.lineTo(0.0, 0.98);
  s.lineTo(NOSE.x, NOSE.y);
  s.lineTo(APEX.x, APEX.y);
  s.lineTo(TAIL.x, TAIL.y);
  s.lineTo(L, 0.64);
  s.lineTo(L - 0.16, 0.42);
  arch(s, REAR_AXLE, false);
  arch(s, FRONT_AXLE, false);
  s.lineTo(0.14, 0.42);
  return s;
}

export function buildCybertruck(envMap: THREE.Texture | null) {
  const g = new THREE.Group();
  g.name = 'cybertruck';

  const steel = new THREE.MeshStandardMaterial({
    color: 0xc4c8cc,
    metalness: 1,
    roughness: 0.32,
    envMapIntensity: 1.1,
  });
  if (envMap) steel.envMap = envMap;
  const glass = new THREE.MeshStandardMaterial({
    color: 0x07090b,
    metalness: 0.9,
    roughness: 0.08,
    side: THREE.DoubleSide,
  });
  const cladding = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.85 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.95 });
  const hub = new THREE.MeshStandardMaterial({ color: 0x8b8f94, metalness: 0.7, roughness: 0.4 });
  const lightWhite = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f7ff, emissiveIntensity: 6 });
  const lightRed = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a12, emissiveIntensity: 4 });

  const body = new THREE.ExtrudeGeometry(bodyShape(), {
    depth: W,
    bevelEnabled: true,
    bevelThickness: 0.015,
    bevelSize: 0.015,
    bevelSegments: 1,
    curveSegments: 1,
  });
  body.translate(0, 0, -W / 2);
  taper(body);
  const bodyMesh = new THREE.Mesh(body, steel);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  g.add(bodyMesh);

  // Windshield and glass roof: a strip lying on the top surface.
  const roofGlass = new THREE.BufferGeometry();
  const xs = [1.0, 1.6, 2.2, 2.7, APEX.x, 3.42];
  const verts: number[] = [];
  const idx: number[] = [];
  xs.forEach((x, i) => {
    const y = roofY(x) + 0.018;
    const hw = halfWidth(y) - 0.11;
    verts.push(x, y, -hw, x, y, hw);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  roofGlass.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  roofGlass.setIndex(idx);
  roofGlass.computeVertexNormals();
  g.add(new THREE.Mesh(roofGlass, glass));

  // Side windows, pushed just outside the tapered side surface.
  for (const side of [-1, 1]) {
    const pts: [number, number][] = [
      [1.62, 1.27],
      [1.78, roofY(1.78) - 0.075],
      [APEX.x, APEX.y - 0.085],
      [3.58, roofY(3.58) - 0.09],
      [3.58, 1.27],
    ];
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ShapeGeometry(shape);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, side * (halfWidth(p.getY(i)) + 0.02));
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, glass));
  }

  // Angular wheel-arch cladding.
  for (const axle of [FRONT_AXLE, REAR_AXLE]) {
    const outer = new THREE.Shape();
    outer.moveTo(axle + 0.8, 0.42);
    outer.lineTo(axle + 0.6, 1.08);
    outer.lineTo(axle - 0.6, 1.08);
    outer.lineTo(axle - 0.8, 0.42);
    outer.lineTo(axle + 0.8, 0.42);
    const hole = new THREE.Path();
    hole.moveTo(axle + 0.66, 0.42);
    hole.lineTo(axle - 0.66, 0.42);
    hole.lineTo(axle - 0.5, 0.98);
    hole.lineTo(axle + 0.5, 0.98);
    hole.lineTo(axle + 0.66, 0.42);
    outer.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(outer, { depth: W + 0.07, bevelEnabled: false });
    geo.translate(0, 0, -(W + 0.07) / 2);
    g.add(new THREE.Mesh(geo, cladding));
  }
  const rocker = new THREE.Mesh(new THREE.BoxGeometry(REAR_AXLE - FRONT_AXLE - 1.6, 0.16, W + 0.05), cladding);
  rocker.position.set((FRONT_AXLE + REAR_AXLE) / 2, 0.5, 0);
  g.add(rocker);

  const wheels: THREE.Group[] = [];
  const tireGeo = new THREE.CylinderGeometry(TIRE_R, TIRE_R, TIRE_W, 40, 1);
  tireGeo.rotateX(Math.PI / 2);
  const coverGeo = new THREE.CylinderGeometry(TIRE_R * 0.72, TIRE_R * 0.72, 0.02, 6);
  coverGeo.rotateX(Math.PI / 2);
  for (const axle of [FRONT_AXLE, REAR_AXLE]) {
    for (const side of [-1, 1]) {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, rubber);
      tire.castShadow = true;
      wheel.add(tire);
      const cover = new THREE.Mesh(coverGeo, hub);
      cover.position.z = side * (TIRE_W / 2 + 0.005);
      wheel.add(cover);
      wheel.position.set(axle, TIRE_R, side * (0.86 - TIRE_W / 2 + 0.15));
      g.add(wheel);
      wheels.push(wheel);
    }
  }

  const front = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, W - 0.12), lightWhite);
  front.position.set(0.035, 1.03, 0);
  g.add(front);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, W - 0.2), lightRed);
  rear.position.set(L + 0.012, 1.27, 0);
  g.add(rear);

  // Center the group on the wheelbase so rotations look natural.
  g.children.forEach((c) => (c.position.x -= L / 2));

  return { group: g, wheels, length: L };
}
