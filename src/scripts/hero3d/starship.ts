import * as THREE from 'three';

// Block 3 stack, in meters: 9 m diameter, Super Heavy ≈72 m, Ship ≈52 m, 124.4 m total.
export const R = 4.5;
export const BOOSTER_H = 72.3;
export const SHIP_H = 52.1;
export const STACK_H = BOOSTER_H + SHIP_H;
export const MOUNT_H = 20;
export const TOWER_H = 146;
export const TOWER_W = 9.5;
export const TOWER_OFFSET = 21.5;

function ringTexture(rings: number, base: number, variance: number) {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const step = c.height / rings;
  for (let i = 0; i < rings; i++) {
    const v = base + (Math.sin(i * 12.9898) * 43758.5453 % 1) * variance;
    ctx.fillStyle = `rgb(${v},${v},${v + 3})`;
    ctx.fillRect(0, i * step, c.width, step);
    ctx.fillStyle = 'rgba(60,60,64,0.35)';
    ctx.fillRect(0, i * step, c.width, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function steelMaterial(rings: number, env: THREE.Texture | null) {
  const m = new THREE.MeshStandardMaterial({
    map: ringTexture(rings, 176, 14),
    metalness: 0.95,
    roughness: 0.34,
  });
  if (env) m.envMap = env;
  return m;
}

function gridFin(mat: THREE.Material) {
  const g = new THREE.Group();
  const radial = 5.2;
  const chord = 1.4;
  const span = 4.2;
  const bar = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
  };
  bar(radial, chord, 0.18, radial / 2, 0, span / 2);
  bar(radial, chord, 0.18, radial / 2, 0, -span / 2);
  bar(0.18, chord, span, radial, 0, 0);
  for (let i = 1; i < 6; i++) bar(0.07, chord, span, (radial * i) / 6, 0, 0);
  for (let i = 1; i < 5; i++) bar(radial, chord, 0.07, radial / 2, 0, -span / 2 + (span * i) / 5);
  return g;
}

function flap(w: number, h: number, depth: number, mat: THREE.Material) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(depth, h * 0.12);
  s.lineTo(depth, h * 0.8);
  s.lineTo(0, h);
  s.lineTo(0, 0);
  const geo = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
  geo.translate(0, 0, -w / 2);
  return new THREE.Mesh(geo, mat);
}

export function buildStack(env: THREE.Texture | null) {
  const stack = new THREE.Group();
  stack.name = 'stack';

  const tiles = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2c30, metalness: 0.6, roughness: 0.6 });
  const finMat = new THREE.MeshStandardMaterial({ color: 0x3a3b3f, metalness: 0.8, roughness: 0.5 });

  // Super Heavy.
  const boosterMat = steelMaterial(39, env);
  boosterMat.map!.repeat.set(1, 1);
  const booster = new THREE.Mesh(new THREE.CylinderGeometry(R, R, BOOSTER_H - 2, 64, 1, true), boosterMat);
  booster.position.y = (BOOSTER_H - 2) / 2;
  stack.add(booster);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.05, R + 0.2, 4.5, 64, 1, true), dark);
  skirt.position.y = 2.25;
  stack.add(skirt);

  // Vented hot-staging ring.
  const ringY = BOOSTER_H - 2;
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(R, R, 2, 64, 1, true), boosterMat);
  ring.position.y = ringY + 1;
  stack.add(ring);
  const ventGeo = new THREE.BoxGeometry(0.25, 1.3, 1.2);
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const v = new THREE.Mesh(ventGeo, tiles);
    v.position.set(Math.cos(a) * (R + 0.02), ringY + 1, Math.sin(a) * (R + 0.02));
    v.rotation.y = -a;
    stack.add(v);
  }

  for (let i = 0; i < 3; i++) {
    const fin = gridFin(finMat);
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    fin.position.set(Math.cos(a) * R, ringY - 3.5, Math.sin(a) * R);
    fin.rotation.y = -a;
    stack.add(fin);
  }

  // Ship: steel leeward half, black heat-shield tiles on the windward half.
  const ship = new THREE.Group();
  ship.position.y = BOOSTER_H;
  const NOSE_H = 17;
  const barrelH = SHIP_H - NOSE_H;
  const shipSteel = steelMaterial(20, env);
  const leeward = new THREE.Mesh(new THREE.CylinderGeometry(R, R, barrelH, 48, 1, true, 0, Math.PI), shipSteel);
  const windward = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 0.03, R + 0.03, barrelH, 48, 1, true, Math.PI, Math.PI),
    tiles,
  );
  leeward.position.y = windward.position.y = barrelH / 2;
  ship.add(leeward, windward);

  const ogive: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const r = R * Math.sqrt(Math.max(0, 1 - Math.pow(t, 1.9))) * (1 - 0.06 * t);
    ogive.push(new THREE.Vector2(Math.max(r, 0.02), t * NOSE_H));
  }
  const noseSteel = new THREE.Mesh(new THREE.LatheGeometry(ogive, 48, 0, Math.PI), shipSteel);
  const noseTiles = new THREE.Mesh(new THREE.LatheGeometry(ogive.map((v) => v.clone().setX(v.x + 0.03)), 48, Math.PI, Math.PI), tiles);
  noseSteel.position.y = noseTiles.position.y = barrelH;
  ship.add(noseSteel, noseTiles);

  // Flaps sit on the boundary between steel and tiles, like the real vehicle.
  // Cylinder theta 0..PI is the +x half, so the steel/tile seams run along ±z.
  for (const side of [-1, 1]) {
    const aft = flap(4.2, 11, 3.2, tiles);
    aft.position.y = 0.6;
    const aftHolder = new THREE.Group();
    aftHolder.add(aft);
    aftHolder.position.set(0, 0, side * (R - 0.1));
    aftHolder.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    ship.add(aftHolder);

    const fwd = flap(2.6, 7, 2.2, tiles);
    fwd.rotation.z = 0.3;
    const fwdHolder = new THREE.Group();
    fwdHolder.add(fwd);
    fwdHolder.position.set(1.2, barrelH + 2.5, side * R * 0.86);
    fwdHolder.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    ship.add(fwdHolder);
  }
  stack.add(ship);

  stack.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return stack;
}

export function buildMount(env: THREE.Texture | null) {
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8d8a83, roughness: 0.95 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9a9da2, metalness: 0.85, roughness: 0.45 });
  if (env) steel.envMap = env;

  const pad = new THREE.Mesh(new THREE.BoxGeometry(70, 1.2, 70), concrete);
  pad.position.y = 0.6;
  pad.receiveShadow = true;
  g.add(pad);

  // Flame trench berms on either side of the mount.
  for (const side of [-1, 1]) {
    const berm = new THREE.Mesh(new THREE.BoxGeometry(12, 9, 40), concrete);
    berm.position.set(side * 13, 4.5, 6);
    g.add(berm);
  }

  const ring = new THREE.Mesh(new THREE.CylinderGeometry(R + 2.2, R + 2.2, 4, 48, 1, true), steel);
  ring.position.y = MOUNT_H - 2;
  g.add(ring);
  const top = new THREE.Mesh(new THREE.RingGeometry(R - 0.3, R + 2.2, 48), steel);
  top.rotation.x = -Math.PI / 2;
  top.position.y = MOUNT_H;
  g.add(top);

  const legGeo = new THREE.BoxGeometry(1.6, MOUNT_H - 3, 1.6);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leg = new THREE.Mesh(legGeo, steel);
    leg.position.set(Math.cos(a) * (R + 3.4), (MOUNT_H - 3) / 2 + 1.2, Math.sin(a) * (R + 3.4));
    leg.rotation.z = Math.cos(a) * 0.09;
    leg.rotation.x = -Math.sin(a) * 0.09;
    g.add(leg);
  }
  return g;
}

// Collects box "bars" between two points and turns them into one InstancedMesh per material.
class BarSet {
  private bars: THREE.Matrix4[] = [];
  private tmp = new THREE.Object3D();
  private up = new THREE.Vector3(0, 1, 0);
  add(a: THREE.Vector3, b: THREE.Vector3, thick: number, depth = thick) {
    const t = this.tmp;
    t.position.copy(a).add(b).multiplyScalar(0.5);
    t.scale.set(thick, a.distanceTo(b), depth);
    t.quaternion.setFromUnitVectors(this.up, b.clone().sub(a).normalize());
    t.updateMatrix();
    this.bars.push(t.matrix.clone());
  }
  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, thick: number) {
    this.add(new THREE.Vector3(ax, ay, az), new THREE.Vector3(bx, by, bz), thick);
  }
  mesh(mat: THREE.Material) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, this.bars.length);
    this.bars.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.castShadow = true;
    inst.receiveShadow = true;
    return inst;
  }
}

// A rectangular box truss along +x from the origin: four chords, verticals, and alternating diagonals.
function truss(bars: BarSet, len: number, h: number, w: number, bay: number, chord: number, web: number, x0 = 0, y0 = 0, z0 = 0) {
  const n = Math.max(1, Math.round(len / bay));
  const step = len / n;
  for (const y of [-h / 2, h / 2]) for (const z of [-w / 2, w / 2]) bars.line(x0, y0 + y, z0 + z, x0 + len, y0 + y, z0 + z, chord);
  for (let i = 0; i <= n; i++) {
    const x = x0 + i * step;
    for (const z of [-w / 2, w / 2]) bars.line(x, y0 - h / 2, z0 + z, x, y0 + h / 2, z0 + z, web);
    bars.line(x, y0 + h / 2, z0 - w / 2, x, y0 + h / 2, z0 + w / 2, web);
    if (i === n) break;
    const flip = i % 2 ? 1 : -1;
    for (const z of [-w / 2, w / 2]) bars.line(x, y0 - flip * h / 2, z0 + z, x + step, y0 + flip * h / 2, z0 + z, web);
  }
}

// Mechazilla-style launch tower: galvanized square lattice with X-braced bays, decks, a crown, black truss arms.
// Arms point toward +x, where the launch mount sits.
export function buildTower(env: THREE.Texture | null, withArms = true) {
  const g = new THREE.Group();
  const galv = new THREE.MeshStandardMaterial({ color: 0xb4b8bc, metalness: 0.75, roughness: 0.42 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, metalness: 0.5, roughness: 0.55 });
  const grating = new THREE.MeshStandardMaterial({ color: 0x6d7074, metalness: 0.6, roughness: 0.6 });
  for (const m of [galv, black, grating]) if (env) m.envMap = env;

  const half = TOWER_W / 2;
  const BAYS = 30;
  const bay = TOWER_H / BAYS;
  const lat = new BarSet();
  const corners: [number, number][] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  for (const [x, z] of corners) lat.line(x, 0, z, x, TOWER_H, z, 1.15);
  for (let s = 0; s <= BAYS; s++) {
    const y = s * bay;
    for (let c = 0; c < 4; c++) {
      const [x1, z1] = corners[c];
      const [x2, z2] = corners[(c + 1) % 4];
      lat.line(x1, y, z1, x2, y, z2, s % 6 === 0 ? 0.8 : 0.5);
      if (s === BAYS) continue;
      // Full X on every face, with a mid-face post, like the real tower's bays.
      lat.line(x1, y, z1, x2, y + bay, z2, 0.32);
      lat.line(x2, y, z2, x1, y + bay, z1, 0.32);
      lat.line((x1 + x2) / 2, y, (z1 + z2) / 2, (x1 + x2) / 2, y + bay, (z1 + z2) / 2, 0.3);
    }
  }

  // Crown: a wider frame above the lattice that carries the hoist sheaves.
  const crownY = TOWER_H;
  const ch = half + 1.2;
  const crownCorners: [number, number][] = [
    [-ch, -ch],
    [ch, -ch],
    [ch, ch],
    [-ch, ch],
  ];
  for (const [x, z] of crownCorners) lat.line(x, crownY - 2, z, x, crownY + 7, z, 0.7);
  for (const y of [crownY, crownY + 3.5, crownY + 7]) {
    for (let c = 0; c < 4; c++) {
      const [x1, z1] = crownCorners[c];
      const [x2, z2] = crownCorners[(c + 1) % 4];
      lat.line(x1, y, z1, x2, y, z2, 0.45);
      if (y < crownY + 7) lat.line(x1, y, z1, x2, y + 3.5, z2, 0.25);
    }
  }
  g.add(lat.mesh(galv));

  const sheaves = new THREE.Mesh(new THREE.BoxGeometry(TOWER_W - 1, 3.2, TOWER_W - 3), black);
  sheaves.position.y = crownY + 5.2;
  g.add(sheaves);
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.45, 14, 8), galv);
  rod.position.set(-half + 1, crownY + 14, -half + 1);
  g.add(rod);

  // Grated decks every six bays.
  const deckGeo = new THREE.BoxGeometry(TOWER_W + 2.4, 0.35, TOWER_W + 2.4);
  for (let s = 6; s < BAYS; s += 6) {
    const deck = new THREE.Mesh(deckGeo, grating);
    deck.position.y = s * bay;
    deck.castShadow = true;
    g.add(deck);
  }

  // Propellant and electrical runs up the back face.
  const pipeGeo = new THREE.CylinderGeometry(0.32, 0.32, MOUNT_H + BOOSTER_H + 22, 10);
  for (let i = 0; i < 3; i++) {
    const pipe = new THREE.Mesh(pipeGeo, i === 1 ? black : galv);
    pipe.position.set(-half - 0.6, (MOUNT_H + BOOSTER_H + 22) / 2, -2 + i * 1.6);
    g.add(pipe);
  }

  const parts: { qdArm?: THREE.Group; carriage?: THREE.Group } = {};
  if (withArms) {
    // Chopsticks on a carriage that rides the tower, parked at booster-catch height.
    const carriage = new THREE.Group();
    carriage.position.y = MOUNT_H + BOOSTER_H - 2;
    const cb = new BarSet();
    const cw = half + 1.4;
    for (const y of [-3.5, 3.5]) {
      cb.line(-cw, y, -cw, cw, y, -cw, 0.9);
      cb.line(-cw, y, cw, cw, y, cw, 0.9);
      cb.line(-cw, y, -cw, -cw, y, cw, 0.9);
      cb.line(cw, y, -cw, cw, y, cw, 0.9);
    }
    for (const [x, z] of [[-cw, -cw], [cw, -cw], [cw, cw], [-cw, cw]]) cb.line(x, -3.5, z, x, 3.5, z, 0.9);
    cb.line(cw, -3.5, -cw, cw, 3.5, cw, 0.5);
    cb.line(cw, -3.5, cw, cw, 3.5, -cw, 0.5);
    carriage.add(cb.mesh(black));
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(cw, 0, side * 3.6);
      pivot.rotation.y = -side * 0.08;
      const ab = new BarSet();
      truss(ab, 34, 3.4, 1.8, 3.4, 0.38, 0.18, 0, 0, 0);
      pivot.add(ab.mesh(black));
      // Catch rail along the inner face of each arm.
      const rail = new THREE.Mesh(new THREE.BoxGeometry(22, 0.6, 0.6), galv);
      rail.position.set(22, 1.9, -side * 1.1);
      pivot.add(rail);
      carriage.add(pivot);
    }
    g.add(carriage);
    parts.carriage = carriage;

    // Ship quick-disconnect arm near the top of the ship.
    const qd = new THREE.Group();
    qd.position.set(half, MOUNT_H + BOOSTER_H + 20, -2);
    const reach = TOWER_OFFSET - half - R + 0.3;
    const qb = new BarSet();
    truss(qb, reach - 1.2, 3, 2.6, 2.4, 0.32, 0.16, 0, 0, 0);
    qd.add(qb.mesh(black));
    const clamp = new THREE.Mesh(new THREE.BoxGeometry(1.4, 4.2, 4.6), black);
    clamp.position.x = reach - 0.7;
    qd.add(clamp);
    g.add(qd);
    parts.qdArm = qd;
  }

  return { group: g, ...parts };
}

const plumeVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormalV = normalize(normalMatrix * normal);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const plumeFragment = /* glsl */ `
  uniform float uTime;
  uniform float uPower;
  uniform vec3 uColor;
  uniform float uFalloff;
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying vec3 vViewDir;
  void main() {
    float along = 1.0 - vUv.y;
    float rim = abs(dot(vNormalV, vViewDir));
    float flicker = 0.85 + 0.15 * sin(uTime * 53.0 + vUv.y * 40.0) * sin(uTime * 31.0 + vUv.x * 25.0);
    float a = pow(rim, 1.3) * pow(1.0 - along, uFalloff) * flicker * uPower;
    gl_FragColor = vec4(uColor * a * 2.2, a);
  }
`;

export function buildPlume() {
  const g = new THREE.Group();
  const mk = (rTop: number, rBot: number, len: number, color: number, falloff: number) => {
    const geo = new THREE.CylinderGeometry(rTop, rBot, len, 48, 1, true);
    geo.translate(0, -len / 2, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: plumeVertex,
      fragmentShader: plumeFragment,
      uniforms: {
        uTime: { value: 0 },
        uPower: { value: 0 },
        uColor: { value: new THREE.Color(color) },
        uFalloff: { value: falloff },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(geo, mat);
    g.add(m);
    return mat;
  };
  const mats = [
    mk(R * 0.92, R * 1.6, 70, 0xfff6dc, 0.6),
    mk(R * 1.0, R * 2.8, 160, 0xffb04a, 1.1),
    mk(R * 1.1, R * 4.5, 280, 0xff7426, 1.8),
  ];
  return {
    group: g,
    update(time: number, power: number) {
      for (const m of mats) {
        m.uniforms.uTime.value = time;
        m.uniforms.uPower.value = power;
      }
    },
  };
}
