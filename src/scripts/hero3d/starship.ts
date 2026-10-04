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

export function buildTower(env: THREE.Texture | null, withArms = true) {
  const g = new THREE.Group();
  const lattice = new THREE.MeshStandardMaterial({ color: 0x3c3e42, metalness: 0.6, roughness: 0.6 });
  if (env) lattice.envMap = env;

  const segment = TOWER_H / 16;
  const half = TOWER_W / 2;
  const bars: THREE.Matrix4[] = [];
  const box = new THREE.BoxGeometry(1, 1, 1);
  const tmp = new THREE.Object3D();
  const addBar = (a: THREE.Vector3, b: THREE.Vector3, thick: number) => {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const len = a.distanceTo(b);
    tmp.position.copy(mid);
    tmp.scale.set(thick, len, thick);
    tmp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    tmp.updateMatrix();
    bars.push(tmp.matrix.clone());
  };
  const corners = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  for (const [x, z] of corners) addBar(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, TOWER_H, z), 1.1);
  for (let s = 0; s <= 16; s++) {
    const y = s * segment;
    for (let c = 0; c < 4; c++) {
      const [x1, z1] = corners[c];
      const [x2, z2] = corners[(c + 1) % 4];
      addBar(new THREE.Vector3(x1, y, z1), new THREE.Vector3(x2, y, z2), 0.6);
      if (s < 16) {
        const flip = (s + c) % 2 === 0;
        addBar(
          new THREE.Vector3(flip ? x1 : x2, y, flip ? z1 : z2),
          new THREE.Vector3(flip ? x2 : x1, y + segment, flip ? z2 : z1),
          0.45,
        );
      }
    }
  }
  const inst = new THREE.InstancedMesh(box, lattice, bars.length);
  bars.forEach((m, i) => inst.setMatrixAt(i, m));
  inst.castShadow = true;
  g.add(inst);

  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.5, 12, 8), lattice);
  rod.position.y = TOWER_H + 6;
  g.add(rod);

  const parts: { qdArm?: THREE.Group; carriage?: THREE.Group } = {};
  if (withArms) {
    const carriage = new THREE.Group();
    carriage.position.y = 92;
    const block = new THREE.Mesh(new THREE.BoxGeometry(TOWER_W + 1.6, 6, TOWER_W + 1.6), lattice);
    carriage.add(block);
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(30, 2.4, 1.4), lattice);
      arm.position.set(16, -1, 0);
      const pivot = new THREE.Group();
      pivot.position.set(half + 1, 0, side * 4.2);
      pivot.rotation.y = -side * 0.05;
      pivot.add(arm);
      carriage.add(pivot);
    }
    g.add(carriage);
    parts.carriage = carriage;

    const qd = new THREE.Group();
    qd.position.set(half, MOUNT_H + BOOSTER_H + 20, -2);
    const qdArm = new THREE.Mesh(new THREE.BoxGeometry(TOWER_OFFSET - half - R + 0.3, 2.4, 2.6), lattice);
    qdArm.position.x = (TOWER_OFFSET - half - R + 0.3) / 2;
    qd.add(qdArm);
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
