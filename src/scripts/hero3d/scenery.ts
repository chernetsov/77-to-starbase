import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Puffs } from './puffs';

// Boca Chica geography around the launch mount at the origin (+x east toward the Gulf, +z south).
// The beach runs north–south; the build site (Starfactory, Mega Bays) is ~3.3 km west-southwest.
export const SHORE = { duneCrest: 378, beachStart: 425, wetStart: 538, water: 575 };

/** Highway 4 centerline, west to east: along the north edge of the build site, then past the pads to the dunes. */
// West of the pads the road swings south of its true line so the build site along it stands in clear
// sky left of the pad from the beach, as the real one does from farther away.
export const HIGHWAY = new THREE.CatmullRomCurve3(
  [[-3400, 1006], [-2700, 1000], [-2150, 1002], [-1750, 1000], [-1400, 920], [-1050, 700], [-700, 440], [-350, 338], [0, 330], [318, 330]].map(
    ([x, z]) => new THREE.Vector3(x, 0, z),
  ),
  false,
  'centripetal',
);
HIGHWAY.arcLengthDivisions = 2000;

/** Sand track from the end of the road through a cut in the foredune, then north up the beach to the parking spot. */
export const BEACH_TRACK: [number, number][] = [[346, 318], [360, 280], [366, 200], [372, 130], [388, 70], [405, 27], [425, -17], [444, -59]];

const routeLine: [number, number][] = [...HIGHWAY.getSpacedPoints(160).map((p) => [p.x, p.z] as [number, number]), ...BEACH_TRACK];
function segDistance(line: [number, number][], x: number, z: number) {
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, az] = line[i];
    const dx = line[i + 1][0] - ax;
    const dz = line[i + 1][1] - az;
    const u = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return best;
}
/** Distance in meters from the truck's route (Highway 4 plus the beach track). */
export function routeDistance(x: number, z: number) {
  return segDistance(routeLine, x, z);
}

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, octaves = 4) {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    s += amp * vnoise(x * f, y * f);
    f *= 2;
    amp *= 0.5;
  }
  return s / (1 - Math.pow(0.5, octaves));
}

const smooth = THREE.MathUtils.smoothstep;

function mergeCards(card: THREE.BufferGeometry, count: number) {
  const pos: number[] = [];
  const uv: number[] = [];
  const normal: number[] = [];
  const src = card.toNonIndexed();
  const p = src.attributes.position;
  const u = src.attributes.uv;
  for (let k = 0; k < count; k++) {
    const m = new THREE.Matrix4().makeRotationY((k / count) * Math.PI);
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      uv.push(u.getX(i), u.getY(i));
      normal.push(0, 1, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // Upward normals light the cards like the ground under them instead of flickering per face.
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  return g;
}

/** Foredune ridge between the beach and the flats, low where the view opens toward the pads. */
export function duneHeight(x: number, z: number) {
  const crest = SHORE.duneCrest + 28 * (fbm(z * 0.006, 3.1) - 0.5);
  const open = smooth(Math.abs(z + 40), 12, 90);
  const hc = (1.5 + 3.4 * open) * (0.75 + 0.5 * fbm(z * 0.02, 7.3));
  const d = (x - crest) / 26;
  const ridge = Math.exp(-d * d);
  const hummocks = 1.1 * (fbm(x * 0.06, z * 0.06) - 0.45) * Math.exp(-d * d * 0.5) * (0.5 + open * 0.5);
  // The beach access track is cut down through the ridge.
  const t = segDistance(beachAccess, x, z) / 9;
  return Math.max(0, hc * ridge + hummocks) * (1 - 0.9 * Math.exp(-t * t));
}
const beachAccess: [number, number][] = [[318, 331], ...BEACH_TRACK];

const COAST_X = [290, 450] as const;
/** Ground height of the foredune mesh (0 on the flats and the beach). */
export function coastHeight(x: number, z: number) {
  const [x0, x1] = COAST_X;
  if (x <= x0 || x >= x1) return 0;
  const edge = Math.min(smooth(x, x0, x0 + 20), 1 - smooth(x, x1 - 20, x1));
  return Math.max(0, duneHeight(x, z) * edge - 0.05);
}

function vegetation(x: number, z: number) {
  const n = fbm(x * 0.05 + 11, z * 0.05);
  const seaward = smooth(x, SHORE.duneCrest + 8, SHORE.beachStart);
  return smooth(n, 0.38, 0.62) * (1 - 0.85 * seaward);
}

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], spread: number) {
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const n = (Math.random() - 0.5) * spread;
    img.data[i * 4] = base[0] + n;
    img.data[i * 4 + 1] = base[1] + n;
    img.data[i * 4 + 2] = base[2] + n * 0.8;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function buildCoast(cameraZ: number) {
  const g = new THREE.Group();

  // Dry beach with faint tire tracks running along the shore (texture v runs along z).
  const sandTex = canvasTexture(512, 512, (ctx) => {
    speckle(ctx, 512, 512, [214, 196, 160], 22);
    ctx.strokeStyle = 'rgba(120,100,70,0.16)';
    for (let i = 0; i < 7; i++) {
      const x0 = 40 + Math.random() * 430;
      ctx.lineWidth = 6 + Math.random() * 5;
      ctx.beginPath();
      ctx.moveTo(x0, 0);
      ctx.bezierCurveTo(x0 + 20, 170, x0 - 20, 340, x0, 512);
      ctx.stroke();
    }
  });
  sandTex.repeat.set(1, 30);
  const beachW = SHORE.wetStart - SHORE.beachStart + 30;
  const beach = new THREE.Mesh(
    new THREE.PlaneGeometry(beachW, 6000),
    new THREE.MeshStandardMaterial({ map: sandTex, roughness: 0.95 }),
  );
  beach.rotation.x = -Math.PI / 2;
  beach.position.set(SHORE.beachStart - 30 + beachW / 2, 0.01, cameraZ);
  beach.receiveShadow = true;
  g.add(beach);

  const wetTex = canvasTexture(256, 256, (ctx) => speckle(ctx, 256, 256, [150, 136, 110], 14));
  wetTex.repeat.set(1, 60);
  const wet = new THREE.Mesh(
    new THREE.PlaneGeometry(SHORE.water - SHORE.wetStart + 4, 6000),
    new THREE.MeshStandardMaterial({ map: wetTex, roughness: 0.22, metalness: 0.15 }),
  );
  wet.rotation.x = -Math.PI / 2;
  wet.position.set((SHORE.wetStart + SHORE.water) / 2, 0.02, cameraZ);
  wet.receiveShadow = true;
  g.add(wet);

  const foamMat = new THREE.MeshBasicMaterial({ color: 0xf2efe6, transparent: true, opacity: 0.85 });
  for (const [dx, w] of [[0, 2.5], [14, 1.6], [31, 1.2]] as const) {
    const foam = new THREE.Mesh(new THREE.PlaneGeometry(w, 6000), foamMat);
    foam.rotation.x = -Math.PI / 2;
    foam.position.set(SHORE.water + dx, 0.06, cameraZ);
    g.add(foam);
  }
  const ocean = new THREE.Mesh(
    new THREE.PlaneGeometry(14000, 24000),
    new THREE.MeshStandardMaterial({ color: 0x3f6470, metalness: 0.35, roughness: 0.16 }),
  );
  ocean.rotation.x = -Math.PI / 2;
  ocean.position.set(SHORE.water + 7000, 0.04, 0);
  g.add(ocean);

  // Foredune heightfield with vertex-colored sand and vegetation.
  const x0 = 290;
  const x1 = 450;
  const geo = new THREE.PlaneGeometry(x1 - x0, 1800, 80, 600);
  geo.rotateX(-Math.PI / 2);
  geo.translate((x0 + x1) / 2, 0, cameraZ);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const sand = new THREE.Color(0xd6c4a0);
  const green = new THREE.Color(0x5d6a3a);
  const straw = new THREE.Color(0x9a8a5c);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const edge = Math.min(smooth(x, x0, x0 + 20), 1 - smooth(x, x1 - 20, x1));
    pos.setY(i, duneHeight(x, z) * edge - 0.05);
    const veg = vegetation(x, z);
    c.copy(sand).lerp(fbm(x * 0.2, z * 0.2) > 0.5 ? green : straw, veg * 0.85);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const dunes = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  dunes.receiveShadow = true;
  dunes.castShadow = true;
  g.add(dunes);

  // Sea oats and beach grass: clumps of crossed alpha-tested blade cards.
  const bladeTex = canvasTexture(128, 128, (ctx) => {
    for (let i = 0; i < 46; i++) {
      const x = 64 + (Math.random() - 0.5) * 30;
      const lean = (Math.random() - 0.5) * 110;
      const top = 6 + Math.random() * 50;
      const shade = 150 + Math.random() * 90;
      ctx.strokeStyle = `rgb(${shade},${shade * 0.95},${shade * 0.72})`;
      ctx.lineWidth = 1.5 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(x, 128);
      ctx.quadraticCurveTo(x + lean * 0.3, 70, x + lean, top);
      ctx.stroke();
    }
  });
  bladeTex.wrapS = bladeTex.wrapT = THREE.ClampToEdgeWrapping;
  const card = new THREE.PlaneGeometry(1, 1);
  card.translate(0, 0.5, 0);
  const tuftGeo = mergeCards(card, 3);
  const tuftMat = new THREE.MeshStandardMaterial({ map: bladeTex, alphaTest: 0.45, roughness: 1, side: THREE.DoubleSide });
  const N = 11000;
  const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, N);
  const tmp = new THREE.Object3D();
  const palette = [0x7f9450, 0x96a35e, 0xb6ab78, 0x6d8445, 0x8c9a58].map((h) => new THREE.Color(h));
  let n = 0;
  for (let tries = 0; n < N && tries < N * 8; tries++) {
    const x = x0 + 15 + Math.random() * (x1 - x0 - 25);
    const z = cameraZ - 500 + Math.random() * 900;
    if (Math.random() > vegetation(x, z)) continue;
    const s = 0.45 + Math.random() * 0.6;
    tmp.position.set(x, duneHeight(x, z) - 0.08, z);
    tmp.scale.set(s * (1.2 + Math.random()), s * (0.7 + Math.random() * 0.6), s * (1.2 + Math.random()));
    tmp.rotation.set(0, Math.random() * 6, 0);
    tmp.updateMatrix();
    tufts.setMatrixAt(n, tmp.matrix);
    tufts.setColorAt(n, palette[n % palette.length]);
    n++;
  }
  tufts.count = n;
  tufts.receiveShadow = true;
  g.add(tufts);

  return g;
}

/** Tidal flats west of the dunes: marsh ground with sky-reflecting puddles. */
export function buildFlats() {
  const g = new THREE.Group();
  const groundTex = canvasTexture(512, 512, (ctx) => {
    speckle(ctx, 512, 512, [158, 146, 112], 24);
    for (let i = 0; i < 260; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      const r = 4 + Math.random() * 40;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      const pick = Math.random();
      grad.addColorStop(0, pick < 0.55 ? 'rgba(86,100,56,0.6)' : pick < 0.8 ? 'rgba(122,128,74,0.5)' : 'rgba(190,176,140,0.5)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  groundTex.repeat.set(220, 220);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24000, 24000),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  g.add(ground);

  const water = new THREE.MeshStandardMaterial({ color: 0x9fb4c2, metalness: 0.9, roughness: 0.06 });
  const puddle = new THREE.CircleGeometry(1, 14);
  for (let i = 0; i < 70; i++) {
    const x = -900 + Math.random() * 1190;
    const z = -700 + Math.random() * 1300;
    if (Math.abs(x) < 80 && Math.abs(z) < 80) continue;
    const m = new THREE.Mesh(puddle, water);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * 6;
    m.scale.set(8 + Math.random() * 40, 3 + Math.random() * 14, 1);
    m.position.set(x, 0.03, z);
    g.add(m);
  }

  // Low marsh scrub, kept off the pads.
  const bushGeo = new THREE.IcosahedronGeometry(1, 1);
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x66703f, roughness: 1 });
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, 1800);
  const tmp = new THREE.Object3D();
  for (let i = 0; i < 1800; i++) {
    let x: number;
    let z: number;
    do {
      x = -900 + Math.random() * 1200;
      z = -800 + Math.random() * 1500;
    } while ((Math.abs(x) < 80 && Math.abs(z) < 90) || (Math.abs(x - 120) < 60 && Math.abs(z + 330) < 60) || routeDistance(x, z) < 30);
    const s = 0.4 + Math.random() * 1.1;
    tmp.position.set(x, s * 0.3, z);
    tmp.scale.set(s * (1 + Math.random()), s * 0.55, s * (1 + Math.random()));
    tmp.rotation.y = Math.random() * 6;
    tmp.updateMatrix();
    bushes.setMatrixAt(i, tmp.matrix);
  }
  bushes.receiveShadow = true;
  g.add(bushes);
  return g;
}

function colored(geo: THREE.BufferGeometry, hex: number) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

function merge(parts: THREE.BufferGeometry[]) {
  const geo = mergeGeometries(parts)!;
  geo.computeVertexNormals();
  return geo;
}

/** Spanish dagger: a short trunk topped by a rosette of stiff sword leaves. */
function yuccaGeometry() {
  const parts = [colored(new THREE.CylinderGeometry(0.1, 0.16, 0.9, 6).translate(0, 0.45, 0), 0x6b5a44)];
  for (let i = 0; i < 30; i++) {
    const elev = 0.25 + (i / 30) * 1.2;
    const len = 0.7 + Math.random() * 0.35;
    const blade = new THREE.PlaneGeometry(0.07, len).translate(0, len / 2, 0);
    blade.rotateZ(-(Math.PI / 2 - elev));
    blade.rotateY(i * 2.4);
    blade.translate(0, 0.88, 0);
    parts.push(colored(blade, i < 6 ? 0x8a8a5a : 0x6f7f4a));
  }
  return merge(parts);
}

/** Prickly pear: a clump of flat oval pads, a few with purple fruit on the rims. */
function pricklyPearGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const pads: [number, number, number, number, number][] = [
    [0, 0.22, 0, 0, 0.2], [0.3, 0.2, 0.1, 1.3, -0.3], [-0.28, 0.18, -0.08, 2.1, 0.35], [0.05, 0.55, 0.02, 0.4, 0.15],
    [0.35, 0.5, 0.12, 1.2, -0.45], [-0.25, 0.48, -0.05, 2.4, 0.4], [0.1, 0.85, 0.05, 0.7, -0.2],
  ];
  for (const [x, y, z, ry, rz] of pads) {
    const pad = new THREE.SphereGeometry(0.2, 9, 6).scale(1, 1.3, 0.26);
    pad.rotateZ(rz);
    pad.rotateY(ry);
    pad.translate(x, y, z);
    parts.push(colored(pad, 0x6e8a46));
  }
  for (const [x, y, z] of [[0.08, 1.1, 0.05], [0.42, 0.78, 0.12], [-0.3, 0.74, -0.05], [0.18, 1.08, 0.02]]) {
    parts.push(colored(new THREE.SphereGeometry(0.045, 6, 4).scale(1, 1.3, 1).translate(x, y, z), 0x8c2f52));
  }
  return merge(parts);
}

function stoneGeometry(detail: number) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    v.multiplyScalar(0.8 + 0.4 * fbm(v.x * 1.7 + 4, v.y * 1.7 + v.z));
    p.setXYZ(i, v.x, v.y * 0.6, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * Coastal variety: yucca and prickly pear on the dune backs, railroad vine creeping over the foredune,
 * scattered stones on the flats, a shell wrack line and bleached driftwood on the beach.
 */
/**
 * Highway 4 west of the pads, where the opening drives: scrub on both shoulders and a line of power poles
 * along the north side, so the ground reads as moving at speed. Keeps off the build site footprint and
 * out of the strip south of the road where the opening's tracking camera runs alongside the truck.
 */
export function buildRoadside(lowPower: boolean) {
  const g = new THREE.Group();
  const rand = rng(404);
  const tmp = new THREE.Object3D();
  const onSite = (x: number, z: number) => x > -2680 && x < -1820 && z > 618 && z < 980;

  const count = lowPower ? 900 : 2000;
  const bushes = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0x66703f, roughness: 1 }),
    count,
  );
  const color = new THREE.Color();
  const p = new THREE.Vector3();
  const tan = new THREE.Vector3();
  let n = 0;
  for (let tries = 0; n < count && tries < count * 4; tries++) {
    const u = 0.02 + rand() * 0.66;
    HIGHWAY.getPointAt(u, p);
    HIGHWAY.getTangentAt(u, tan);
    const side = rand() < 0.5 ? -1 : 1;
    const off = side * (9 + Math.pow(rand(), 1.8) * 170);
    const x = p.x - tan.z * off;
    const z = p.z + tan.x * off;
    if (onSite(x, z) || x > -880 || (off > 5 && off < 34 && x > -2900 && x < -1600)) continue;
    const s = 0.4 + rand() * 1.2;
    tmp.position.set(x, s * 0.3, z);
    tmp.scale.set(s * (1 + rand()), s * 0.55, s * (1 + rand()));
    tmp.rotation.y = rand() * 6;
    tmp.updateMatrix();
    bushes.setMatrixAt(n, tmp.matrix);
    bushes.setColorAt(n, color.setHSL(0.18 + rand() * 0.06, 0.25 + rand() * 0.15, 0.75 + rand() * 0.4));
    n++;
  }
  bushes.count = n;
  bushes.receiveShadow = true;
  g.add(bushes);

  const pole = mergeGeometries([
    new THREE.CylinderGeometry(0.12, 0.17, 10.5, 6).translate(0, 5.25, 0),
    new THREE.BoxGeometry(0.14, 0.14, 2.6).translate(0, 9.6, 0),
  ]);
  const spacing = 42;
  const length = HIGHWAY.getLength();
  const poles = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0x5b5146, roughness: 0.9 }), Math.ceil(length / spacing));
  n = 0;
  for (let d = 30; d < length; d += spacing) {
    const u = d / length;
    HIGHWAY.getPointAt(u, p);
    if (p.x > -450) break;
    HIGHWAY.getTangentAt(u, tan);
    tmp.position.set(p.x + tan.z * 12, 0, p.z - tan.x * 12);
    tmp.rotation.set((rand() - 0.5) * 0.03, Math.atan2(-tan.z, tan.x), (rand() - 0.5) * 0.03);
    tmp.scale.setScalar(1);
    tmp.updateMatrix();
    poles.setMatrixAt(n++, tmp.matrix);
  }
  poles.count = n;
  poles.castShadow = true;
  g.add(poles);
  return g;
}

export function buildVariety(cameraZ: number, lowPower: boolean) {
  const g = new THREE.Group();
  const rand = rng(1977);
  const tmp = new THREE.Object3D();
  const color = new THREE.Color();
  const scale = lowPower ? 0.6 : 1;
  const zMin = cameraZ - 500;
  const zSpan = 900;
  // Leave the beach clear where the truck rolls in and parks, and around the camera.
  const clearOfTruck = (x: number, z: number) => !(x > 410 && x < 470 && z > -80 && z < 10) && routeDistance(x, z) > 7;
  const groundY = (x: number, z: number) => (x > 290 && x < 450 ? duneHeight(x, z) : 0);

  const scatter = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    count: number,
    place: () => [number, number] | null,
    pose: (x: number, z: number, i: number) => void,
  ) => {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    let n = 0;
    for (let tries = 0; n < count && tries < count * 30; tries++) {
      const at = place();
      if (!at || !clearOfTruck(at[0], at[1])) continue;
      pose(at[0], at[1], n);
      tmp.updateMatrix();
      mesh.setMatrixAt(n, tmp.matrix);
      mesh.setColorAt(n, color);
      n++;
    }
    mesh.count = n;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };

  const plantMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  const backDune = () => {
    const x = 180 + rand() * 200;
    const z = zMin + rand() * zSpan;
    const crest = SHORE.duneCrest + 28 * (fbm(z * 0.006, 3.1) - 0.5);
    // Densest just behind the crest, thinning out across the flats.
    return rand() < Math.exp(-Math.max(0, crest - 12 - x) / 60) * (0.35 + vegetation(x, z)) ? ([x, z] as [number, number]) : null;
  };

  scatter(yuccaGeometry(), plantMat, Math.round(220 * scale), backDune, (x, z) => {
    const s = 0.8 + rand() * 1.4;
    tmp.position.set(x, groundY(x, z) - 0.05, z);
    tmp.rotation.set((rand() - 0.5) * 0.15, rand() * 6.28, (rand() - 0.5) * 0.15);
    tmp.scale.set(s, s * (0.8 + rand() * 0.5), s);
    color.setHSL(0.2 + rand() * 0.05, 0.15, 0.85 + rand() * 0.25);
  });

  scatter(pricklyPearGeometry(), plantMat, Math.round(320 * scale), backDune, (x, z) => {
    const s = 0.7 + rand() * 1.1;
    tmp.position.set(x, groundY(x, z) - 0.04, z);
    tmp.rotation.set(0, rand() * 6.28, 0);
    tmp.scale.set(s * (1 + rand() * 0.6), s, s * (1 + rand() * 0.6));
    color.setHSL(0.24 + rand() * 0.05, 0.25, 0.8 + rand() * 0.3);
  });

  // Railroad vine (beach morning glory): leafy mats with pink flowers, laid on the dune slope.
  const vineTex = canvasTexture(256, 256, (ctx) => {
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 100;
      const x = 128 + Math.cos(a) * r;
      const y = 128 + Math.sin(a) * r;
      ctx.fillStyle = `rgb(${70 + Math.random() * 40},${105 + Math.random() * 40},${50 + Math.random() * 20})`;
      ctx.beginPath();
      ctx.ellipse(x, y, 9 + Math.random() * 6, 7 + Math.random() * 5, a, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = Math.random() < 0.8 ? '#d0569a' : '#e9a6c9';
      ctx.beginPath();
      ctx.arc(128 + (Math.random() - 0.5) * 170, 128 + (Math.random() - 0.5) * 170, 5 + Math.random() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  vineTex.wrapS = vineTex.wrapT = THREE.ClampToEdgeWrapping;
  const vineMat = new THREE.MeshStandardMaterial({ map: vineTex, alphaTest: 0.5, roughness: 0.95, side: THREE.DoubleSide });
  const up = new THREE.Vector3(0, 1, 0);
  const normal = new THREE.Vector3();
  const vines = scatter(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    vineMat,
    Math.round(520 * scale),
    () => {
      const x = 340 + rand() * 95;
      const z = zMin + rand() * zSpan;
      return rand() < 0.3 + 0.7 * fbm(x * 0.03, z * 0.03 + 9) ? [x, z] : null;
    },
    (x, z) => {
      const e = 0.6;
      normal.set(groundY(x - e, z) - groundY(x + e, z), 2 * e, groundY(x, z - e) - groundY(x, z + e)).normalize();
      tmp.position.set(x, groundY(x, z) + 0.04, z);
      tmp.quaternion.setFromUnitVectors(up, normal);
      tmp.rotateY(rand() * 6.28);
      const s = 1.2 + rand() * 2.4;
      tmp.scale.set(s * (1 + rand()), 1, s);
      color.setHSL(0, 0, 0.85 + rand() * 0.3);
    },
  );
  vines.castShadow = false;
  tmp.quaternion.identity();

  const stoneMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  const stonePalette = [0x8a8274, 0x6f6a62, 0xa39a86, 0x7d6f5c, 0x5e5a55];
  scatter(stoneGeometry(1), stoneMat, Math.round(420 * scale), () => [-300 + rand() * 720, zMin + rand() * zSpan], (x, z) => {
    const s = 0.12 + Math.pow(rand(), 3) * 0.7;
    tmp.position.set(x, groundY(x, z) + s * 0.15, z);
    tmp.rotation.set(rand() * 0.6, rand() * 6.28, rand() * 0.6);
    tmp.scale.set(s * (1 + rand() * 0.6), s, s * (0.8 + rand() * 0.5));
    color.setHex(stonePalette[Math.floor(rand() * stonePalette.length)]);
  });

  // Shell hash and small debris along strands of the wrack line, the beach band in front of the camera.
  const shellMat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  const shellPalette = [0xf1ebdf, 0xe6d6bf, 0xd9c3a5, 0xefd9d0, 0xbfb3a0];
  const shells = scatter(
    stoneGeometry(0).scale(1, 0.45, 1),
    shellMat,
    Math.round(2200 * scale),
    () => {
      const strand = Math.floor(rand() * 4);
      const x = 432 + strand * 11 + (rand() - 0.5) * (3 + strand * 2) + 4 * Math.sin(rand() * 6.28);
      return [x, zMin + rand() * zSpan];
    },
    (x, z) => {
      const s = 0.035 + rand() * 0.07;
      tmp.position.set(x, 0.02, z);
      tmp.rotation.set(0, rand() * 6.28, 0);
      tmp.scale.setScalar(s);
      color.setHex(shellPalette[Math.floor(rand() * shellPalette.length)]);
    },
  );
  shells.castShadow = false;

  const woodMat = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  const woodGeo = new THREE.CylinderGeometry(0.07, 0.11, 1, 7).rotateZ(Math.PI / 2);
  scatter(woodGeo, woodMat, Math.round(60 * scale), () => [424 + rand() * 30, zMin + rand() * zSpan], (x, z) => {
    const len = 0.8 + rand() * 3.5;
    const r = 0.6 + rand() * 1.4;
    tmp.position.set(x, 0.07 * r, z);
    tmp.rotation.set(0, rand() * 6.28, (rand() - 0.5) * 0.1);
    tmp.scale.set(len, r, r);
    color.setHSL(0.09, 0.12, 0.55 + rand() * 0.15);
  });

  return g;
}

/** Ground support around Pad 2: tank farm, horizontal storage tanks, lightning masts. */
export function buildPadInfrastructure() {
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 0.75, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x5d6166, metalness: 0.6, roughness: 0.5 });
  const white = new THREE.MeshStandardMaterial({ color: 0xeceae4, roughness: 0.5 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x9a968d, roughness: 0.95 });

  const vertical: [number, number, number, number, THREE.Material][] = [
    [-70, 70, 5, 28, steel], [-84, 70, 5, 28, steel], [-98, 70, 5, 28, dark], [-112, 70, 5, 28, steel],
    [-70, 88, 4, 22, dark], [-84, 88, 4, 22, steel], [-140, 60, 8, 20, concrete], [-160, 60, 8, 20, concrete],
  ];
  for (const [x, z, r, h, m] of vertical) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32), m);
    t.position.set(x, h / 2, z);
    t.castShadow = true;
    g.add(t);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), m);
    cap.scale.y = 0.3;
    cap.position.set(x, h, z);
    g.add(cap);
  }
  const hGeo = new THREE.CylinderGeometry(2.3, 2.3, 26, 24);
  hGeo.rotateZ(Math.PI / 2);
  for (let i = 0; i < 6; i++) {
    const t = new THREE.Mesh(hGeo, white);
    t.position.set(-60 - (i % 3) * 30, 3, 120 + Math.floor(i / 3) * 8);
    t.castShadow = true;
    g.add(t);
  }
  const mastGeo = new THREE.CylinderGeometry(0.15, 0.35, 64, 6);
  mastGeo.translate(0, 32, 0);
  for (const [x, z] of [[-55, 45], [-50, -50]]) {
    const m = new THREE.Mesh(mastGeo, steel);
    m.position.set(x, 0, z);
    g.add(m);
  }
  const apron = new THREE.Mesh(new THREE.BoxGeometry(150, 0.6, 120), concrete);
  apron.position.set(-100, 0.3, 90);
  apron.receiveShadow = true;
  g.add(apron);
  return g;
}

export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Floats per cloud puff in an item list, as `Puffs.push` takes them (position first, then the cloud block). */
export const CLOUD_STRIDE = 18;

/** Appends one puff of a cloud whose flat base is at `base`, `h` tall, centred on (cx, cz) with half extents w/2 × deep. */
function cloudPuff(items: number[], rand: () => number, x: number, y: number, z: number, size: number, stretch: number, alpha: number, cx: number, base: number, cz: number, w: number, h: number, deep: number, far: number) {
  items.push(x, y, z, size, (rand() - 0.5) * 1.2, alpha, 0, 4 + Math.floor(rand() * 4), 1, stretch, base, h * 0.8, far, cx, cz, w * 0.55, deep + w * 0.1, 0);
}

/**
 * For each puff from `first` on, how much of the other puffs' cloud lies between it and the sun (m): the summed
 * chords of the sun ray through their spheres (Harris & Lastra 2001, with the sun fixed).
 */
function bakeSunDepth(items: number[], first: number, sun: THREE.Vector3) {
  const S = CLOUD_STRIDE;
  for (let i = first; i < items.length; i += S) {
    let depth = 0;
    for (let j = first; j < items.length; j += S) {
      if (j === i) continue;
      const vx = items[j] - items[i], vy = items[j + 1] - items[i + 1], vz = items[j + 2] - items[i + 2];
      const t = vx * sun.x + vy * sun.y + vz * sun.z;
      if (t <= 0) continue;
      const r = items[j + 3] * 0.42;
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      if (perp2 < r * r) depth += 2 * Math.sqrt(r * r - perp2) * items[j + 5];
    }
    items[i + 17] = depth;
  }
}

/**
 * One cumulus `w` wide, built like the real thing: a wide, flat, darker base sheet that reaches out past the
 * towers; two to four rising towers of different heights packed with big lobes; on each lobe's upper and outer
 * side, smaller lobes (and on those, smaller again), the cauliflower; and a few tiny detached cloudlets and
 * thin wisps beside and below it. `far` > 1 marks a cloud drawn nearer and smaller than it really is.
 */
export function addCumulus(items: number[], rand: () => number, cx: number, base: number, cz: number, w: number, far = 1, lp = 1, sun?: THREE.Vector3) {
  const first = items.length;
  const h = w * (0.36 + rand() * 0.2);
  const deep = w * 0.36;
  const detail = Math.min(1, lp / Math.sqrt(far));
  const add = (x: number, y: number, z: number, size: number, stretch: number, alpha: number) =>
    cloudPuff(items, rand, x, y, z, size, stretch, alpha, cx, base, cz, w, h, deep, far);
  const towers: [number, number, number][] = [];
  for (let i = 0, m = 2 + Math.floor(rand() * 3); i < m; i++) towers.push([rand() * 1.0 - 0.5, 0.42 + rand() * 0.3, h * (i === 0 ? 1 : 0.5 + rand() * 0.4)]);
  const top = (u: number) => {
    let t = h * 0.35 * Math.sqrt(Math.max(0, 1 - u * u));
    for (const [tu, tw, th] of towers) t = Math.max(t, th * Math.sqrt(Math.max(0, 1 - ((u - tu) / tw) ** 2)));
    return t;
  };

  // The base sheet: flattened, overlapping, a little wider than the towers above.
  for (let k = 0, m = Math.round(12 * Math.max(far > 1 ? 0.4 : 0.5, detail)); k < m; k++) {
    const u = (k / (m - 1)) * 2 - 1 + (rand() - 0.5) * 0.1;
    const size = w * (0.17 + rand() * 0.04) * (1 - 0.3 * Math.abs(u));
    add(cx + u * w * 0.5, base + size * 0.28, cz + (rand() * 2 - 1) * deep * 0.35, size, 1.6, 1);
  }
  // Solid cores inside each tower, so no sky shows through the body.
  for (const [tu, tw, th] of towers) {
    for (let k = 0; k < (far > 1 ? 2 : 3); k++) {
      const size = Math.min(th * 0.95, w * tw * 0.7) * (0.85 + rand() * 0.3);
      add(cx + (tu + (rand() - 0.5) * tw * 0.6) * w * 0.5, base + size * 0.32 + rand() * Math.max(0, th - size) * 0.6, cz + (rand() - 0.5) * deep * 0.3, size, 1.15, 1);
    }
  }
  // A regular grid of buried fill under the towers' profile: random lobes alone leave gaps the sky shows through.
  for (let k = 0, m = Math.round(10 * Math.max(far > 1 ? 0.45 : 0.6, detail)); k < m; k++) {
    const u = (k / (m - 1)) * 1.7 - 0.85;
    const t = top(u);
    if (t < h * 0.15) continue;
    for (const f of [0.3, 0.62]) {
      const size = Math.min(t * 0.8, w * 0.26);
      add(cx + u * w * 0.5, base + Math.max(size * 0.3, t * f), cz + (rand() - 0.5) * deep * 0.2, size, 1.1, 1);
    }
  }
  // Lobes that fill each tower, then the cauliflower on their outer skin.
  const lobes: [number, number, number, number][] = [];
  for (let k = 0, m = Math.round(34 * (far > 1 ? detail * detail : Math.max(0.5, detail))); k < m; k++) {
    const u = rand() * 1.9 - 0.95;
    const t = top(u);
    if (t < h * 0.1) continue;
    const size = Math.min(t * 1.1, w * (0.22 + rand() * 0.12));
    const y = base + size * 0.3 + Math.sqrt(rand()) * Math.max(0, t - size * 0.45);
    const z = cz + (rand() * 2 - 1) * deep * 0.55;
    add(cx + u * w * 0.5, y, z, size, 1.1, 0.95);
    lobes.push([cx + u * w * 0.5, y, z, size]);
  }
  const sprout = (x: number, y: number, z: number, size: number, level: number) => {
    const kids = 2;
    for (let k = 0; k < kids; k++) {
      // Mostly up and outward: billows rise from the lobe below.
      const a = rand() * Math.PI * 2;
      const up = 0.25 + rand() * 0.75;
      const side = Math.sqrt(1 - up * up);
      const r = size * 0.34;
      const s = size * (0.55 + rand() * 0.15);
      const nx = x + Math.cos(a) * side * r * 1.4, ny = y + up * r, nz = z + Math.sin(a) * side * r;
      if (ny - s * 0.4 < base) continue;
      add(nx, ny, nz, s, 1, 0.92);
      if (level < 2 && rand() < detail * 0.3) sprout(nx, ny, nz, s, level + 1);
    }
  };
  // Only lobes on the outer skin sprout; buried ones would add nothing.
  for (const [x, y, z, size] of lobes) if (y + size * 0.5 > base + top((x - cx) / (w * 0.5)) * 0.7 && detail > 0.8 && rand() < 0.4 + 0.6 * detail) sprout(x, y, z, size, 1);

  // Tiny cloudlets and wisps nearby, mostly near the base: what's left of thermals that didn't make it.
  if (detail > 0.4) {
    for (let k = 0, m = 2 + Math.floor(rand() * 4); k < m; k++) {
      const side = rand() < 0.5 ? -1 : 1;
      const x = cx + side * w * (0.5 + rand() * 0.35);
      const y = base + (rand() - 0.6) * h * 0.35;
      const z = cz + (rand() * 2 - 1) * deep;
      const s = w * (0.04 + rand() * 0.05);
      for (let j = 0, pieces = 2 + Math.floor(rand() * 4); j < pieces; j++) {
        add(x + (rand() - 0.5) * s * 2, y + (rand() - 0.3) * s * 0.6, z + (rand() - 0.5) * s, s * (0.6 + rand() * 0.6), 1.4 + rand(), 0.35 + rand() * 0.35);
      }
    }
    for (let k = 0, m = 1 + Math.floor(rand() * 2); k < m; k++) {
      const side = rand() < 0.5 ? -1 : 1;
      add(cx + side * w * (0.45 + rand() * 0.2), base + h * (0.05 + rand() * 0.2), cz + (rand() - 0.5) * deep, w * (0.1 + rand() * 0.06), 3 + rand() * 1.5, 0.22 + rand() * 0.15);
    }
  }
  if (sun) bakeSunDepth(items, first, sun);
}

/** Pushes cloud items into `puffs`, shifted by `offset`. */
export function pushCloudItems(puffs: Puffs, items: ArrayLike<number>, offset: THREE.Vector3, cloud = new Float32Array(8)) {
  const { x, y, z } = offset;
  const it = items;
  for (let o = 0; o < it.length; o += CLOUD_STRIDE) {
    cloud[0] = it[o + 10] + y;
    cloud[1] = it[o + 11];
    cloud[2] = it[o + 12];
    cloud[3] = it[o + 13] + x;
    cloud[4] = it[o + 14] + z;
    cloud[5] = it[o + 15];
    cloud[6] = it[o + 16];
    cloud[7] = it[o + 17];
    puffs.push(it[o] + x, it[o + 1] + y, it[o + 2] + z, it[o + 3], it[o + 4], it[o + 5], it[o + 6], it[o + 7], it[o + 8], it[o + 9], cloud);
  }
}

/**
 * Sky over the Gulf coast: fair-weather cumulus sharing one flat base near 800 m (so they line up in rows toward
 * the horizon, a few right on the ascent path for the climb to pass), a broken stratocumulus deck near
 * 2.3–3 km, and thin cirrus up high. The field carries on to the horizon: clouds out to ~90 km are drawn
 * nearer and scaled down to the same size as seen from the beach, keeping the haze of their true distance.
 */
/** Onshore breeze carrying the low clouds inland (m/s). */
const WIND_SPEED = 5;

export function buildClouds(lowPower: boolean, sun?: THREE.Vector3) {
  const rand = rng(77);
  const items: number[] = [];
  const CUMULUS_BASE = 800;
  const lp = lowPower ? 0.6 : 1;
  const puff = (x: number, y: number, z: number, size: number, stretch: number, alpha: number, cx: number, base: number, cz: number, w: number, h: number, deep: number, far: number) =>
    cloudPuff(items, rand, x, y, z, size, stretch, alpha, cx, base, cz, w, h, deep, far);
  /** A flat sheet of stratocumulus. */
  const deck = (cx: number, base: number, cz: number, w: number) => {
    const first = items.length;
    deckPuffs(cx, base, cz, w);
    record(first, cx, cz, 1);
  };
  const deckPuffs = (cx: number, base: number, cz: number, w: number) => {
    const h = w * 0.1;
    const deep = w * 0.5;
    for (let k = 0; k < 16 * lp; k++) {
      const u = rand() * 2 - 1;
      const size = w * (0.24 + rand() * 0.16);
      puff(cx + u * w * 0.5, base + size * 0.3 + rand() * h * 0.5, cz + (rand() * 2 - 1) * deep, size, 1.7, 0.45, cx, base, cz, w, h, deep, 1);
    }
  };
  /** Each cloud's puffs, `[first, end)` in items, its anchor, how far nearer than real it's drawn, and phases. */
  const groups: { first: number; end: number; cx: number; cz: number; f: number; wrap: boolean; phase: number; period: number }[] = [];
  const record = (first: number, cx: number, cz: number, f: number) =>
    groups.push({ first, end: items.length, cx, cz, f, wrap: f === 1, phase: rand() * Math.PI * 2, period: 1800 + rand() * 2400 });
  const cumulus = (cx: number, base: number, cz: number, w: number, far = 1) => {
    const first = items.length;
    addCumulus(items, rand, cx, base, cz, w, far, lp, sun);
    record(first, cx, cz, 1 / far);
  };
  const cu = (x: number, z: number, w: number) => cumulus(x, CUMULUS_BASE + (rand() - 0.5) * 90, z, w);

  // Clouds near the ascent sit beside and beyond the rocket as seen from the beach, not over the camera.
  for (const [x, z, w] of [[-220, 300, 620], [-60, -460, 700], [-420, -160, 820]]) cu(x, z, w);
  for (const [x, y, z, w] of [[-420, 2300, 520, 760], [-700, 2600, -560, 860]]) cumulus(x, y, z, w);
  for (const [x, y, z, w] of [[-2600, 2900, 1400, 1500], [-1800, 3100, -2200, 1700]]) deck(x, y, z, w);
  // From the beach camera, keep nearby clouds out of a cone around the ship and tower so they never sit
  // right behind it; the composition frames the stack with sky.
  const CAM = [480, -60];
  const padBearing = Math.atan2(-CAM[1], -CAM[0]);
  const clearOfShip = (x: number, z: number, w: number) => {
    const d = Math.hypot(x - CAM[0], z - CAM[1]);
    let da = Math.abs(Math.atan2(z - CAM[1], x - CAM[0]) - padBearing);
    if (da > Math.PI) da = Math.PI * 2 - da;
    return d > 15000 || da > (w * 0.6) / d + 0.05;
  };
  for (let i = 0; i < 12; i++) {
    const x = -11000 + rand() * 13000;
    const z = -8000 + rand() * 16000;
    const w = 700 + rand() * 900;
    if (Math.hypot(x, z) < 700 || Math.hypot(x - 480, z + 60) < 2200 || !clearOfShip(x, z, w)) continue;
    cu(x, z, w);
  }
  // The beach view, composed: bearing from the pad as seen from the camera (degrees, + is left, toward the
  // south), distance (m) and width (m). Bigger clouds stand off to the sides, smaller ones nearer the stack.
  const view: [number, number, number][] = [
    [-11, 4200, 800], [-21, 6800, 1500], [-33, 3600, 1000], [-15, 11000, 1300],
    [12, 7600, 1100], [24, 5200, 1300], [37, 8800, 1600], [18, 12500, 1400],
  ];
  for (const [deg, d, w] of view) {
    const a = padBearing + THREE.MathUtils.degToRad(deg);
    cu(CAM[0] + Math.cos(a) * d, CAM[1] + Math.sin(a) * d, w);
  }
  for (let i = 0; i < 6; i++) deck(-9000 + rand() * 8000, 2300 + rand() * 900, -7000 + rand() * 14000, 1200 + rand() * 1000);
  // On to the horizon, all the way round but thickest over the land the beach looks at. Spread evenly by area,
  // as a real cloud field is, so they crowd together toward the horizon; the Earth's curvature (R = 6371 km)
  // lowers the far ones onto it.
  const FAR_DRAWN = [12000, 24000];
  for (let i = 0; i < (lowPower ? 80 : 200); i++) {
    const a = rand() < 0.8 ? padBearing + (rand() - 0.5) * 1.3 : rand() * Math.PI * 2;
    const D = Math.sqrt(12000 ** 2 + rand() * (90000 ** 2 - 12000 ** 2));
    const d = FAR_DRAWN[0] + ((D - 12000) / 78000) * (FAR_DRAWN[1] - FAR_DRAWN[0]);
    const f = d / D;
    const drop = (D * D) / (2 * 6371000);
    cumulus(CAM[0] + Math.cos(a) * d, (CUMULUS_BASE + (rand() - 0.5) * 120 - drop) * f, CAM[1] + Math.sin(a) * d, (900 + rand() * 1500) * f, 1 / f);
  }
  const cirrusMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uOffset: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uOffset;
      varying vec3 vWorld;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), u.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { s += a * n(p); p *= 2.03; a *= 0.5; }
        return s;
      }
      void main() {
        vec3 world = vWorld - uOffset;
        vec2 p = vec2(world.z * 0.00011 + uTime * 0.002, world.x * 0.0004);
        p.y += fbm(p * vec2(1.0, 0.5) + 3.0) * 0.9;
        float streaks = fbm(p * vec2(1.0, 2.2));
        float patches = smoothstep(0.38, 0.62, fbm(world.xz * 0.00006 + 7.0));
        float cover = smoothstep(0.56, 0.84, streaks) * patches;
        float fade = 1.0 - smoothstep(9000.0, 26000.0, length(vWorld.xz - cameraPosition.xz));
        gl_FragColor = vec4(1.0, 0.9, 0.8, cover * fade * 0.4);
      }`,
  });
  const cirrus = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), cirrusMat);
  cirrus.rotation.x = Math.PI / 2;
  cirrus.position.y = 9000;
  cirrus.frustumCulled = false;
  cirrus.renderOrder = -1;

  const offset = cirrusMat.uniforms.uOffset.value as THREE.Vector3;
  const cloud = new Float32Array(8);
  // Clouds drawn at true distance wrap round along the wind across the span they cover, so as they drift on, new
  // ones come in off the Gulf; they fade out and in at the two ends.
  const wind = new THREE.Vector2(-0.6, -0.8);
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const g of groups) {
    if (!g.wrap) continue;
    const sv = (g.cx - CAM[0]) * wind.x + (g.cz - CAM[1]) * wind.y;
    sMin = Math.min(sMin, sv - 1500);
    sMax = Math.max(sMax, sv + 1500);
  }
  const span = sMax - sMin;
  let weather = 0;
  return {
    mesh: cirrus,
    count: items.length / CLOUD_STRIDE,
    /** Shifts the whole sky, so a camera cut can land on an identical view of it. */
    setOffset(v: THREE.Vector3) {
      offset.copy(v);
      cirrus.position.y = 9000 + v.y;
    },
    /**
     * Seconds of weather since launch (the fast-forward skips most of an hour): the clouds drift on the onshore
     * breeze (WIND_SPEED, from the south-southeast), each grows or decays over half an hour to an hour, and
     * their billows churn over a few minutes.
     */
    setWeather(seconds: number) {
      weather = seconds;
    },
    push(puffs: Puffs) {
      if (weather <= 0) {
        pushCloudItems(puffs, items, offset, cloud);
        return;
      }
      const run = weather * WIND_SPEED;
      const fadeIn = THREE.MathUtils.smoothstep(run, 0, 600);
      const it = items;
      for (const g of groups) {
        let dx = wind.x * run * g.f;
        let dz = wind.y * run * g.f;
        let alpha = 1;
        if (g.wrap) {
          const s0 = (g.cx - CAM[0]) * wind.x + (g.cz - CAM[1]) * wind.y;
          const s1 = sMin + ((((s0 + run - sMin) % span) + span) % span);
          dx = wind.x * (s1 - s0);
          dz = wind.y * (s1 - s0);
          const edge = THREE.MathUtils.smoothstep(s1, sMin, sMin + span * 0.12) * (1 - THREE.MathUtils.smoothstep(s1, sMax - span * 0.12, sMax));
          alpha = 1 - fadeIn * (1 - edge);
        }
        // Life: 1 now, swelling or shrinking from there; towers rise and sink more than the cloud widens.
        const life = THREE.MathUtils.clamp(1 + 0.3 * (Math.sin(g.phase + (weather * Math.PI * 2) / g.period) - Math.sin(g.phase)), 0.5, 1.3);
        const lh = Math.pow(life, 0.4);
        const lv = Math.pow(life, 1.2);
        alpha *= THREE.MathUtils.smoothstep(life, 0.5, 0.8);
        if (alpha <= 0.01) continue;
        const x = offset.x + dx;
        const z = offset.z + dz;
        for (let o = g.first; o < g.end; o += CLOUD_STRIDE) {
          const base = it[o + 10];
          const cx = it[o + 13];
          const cz = it[o + 14];
          // Each billow swells and settles on its own few-minute cycle.
          const k = o / CLOUD_STRIDE;
          const ph = (k * 2.399) % (Math.PI * 2);
          const w = (Math.PI * 2) / (300 + ((k * 97) % 500));
          const churn = Math.sin(ph + weather * w) - Math.sin(ph);
          const size = it[o + 3] * Math.pow(life, 0.6) * (1 + 0.14 * churn);
          const px = cx + (it[o] - cx) * lh;
          const py = base + (it[o + 1] - base) * lv + it[o + 3] * 0.08 * churn;
          const pz = cz + (it[o + 2] - cz) * lh;
          cloud[0] = base + offset.y;
          cloud[1] = it[o + 11] * lv;
          cloud[2] = it[o + 12];
          cloud[3] = cx + x;
          cloud[4] = cz + z;
          cloud[5] = it[o + 15] * lh;
          cloud[6] = it[o + 16] * lh;
          cloud[7] = it[o + 17];
          puffs.push(px + x, py + offset.y, pz + z, size, it[o + 4], it[o + 5] * alpha, it[o + 6], it[o + 7], it[o + 8], it[o + 9], cloud);
        }
      }
    },
    update(time: number) {
      cirrusMat.uniforms.uTime.value = time;
    },
  };
}

/**
 * Depth toward the horizon: a band of mesquite and brush ~3 km out and a resaca treeline ~6.5 km
 * out (land side only, gapped for the road), faded by aerial perspective. `glow` returns a haze band
 * that follows the camera and softens where land and sea meet the sky, warmest toward the sun.
 */
export function buildHorizon(sunDir: THREE.Vector3, haze: THREE.Color) {
  const g = new THREE.Group();
  const ring = (radius: number, step: number, lo: number, hi: number, color: number, fade: number, seed: number) => {
    const pos: number[] = [];
    const col: number[] = [];
    const n = Math.ceil((Math.PI * 2 * radius) / step);
    const near = new THREE.Color(color).lerp(haze, fade);
    const far = near.clone().lerp(haze, 0.25);
    let prev: number[] | null = null;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      const land = x < SHORE.duneCrest - 250 && routeDistance(x, z) > 30;
      // Clumps: broad rolling height with sharp gaps and crowns on top.
      const clump = fbm(a * radius * 0.012, seed, 3);
      const crown = fbm(a * radius * 0.06, seed + 9, 2);
      const h = clump < 0.38 ? lo * 0.35 : lo + (hi - lo) * THREE.MathUtils.smoothstep(clump, 0.38, 0.8) * (0.6 + 0.6 * crown);
      const cur = [x, z, h];
      if (land && prev) {
        const [px, pz, ph] = prev;
        pos.push(px, -3, pz, x, -3, z, x, h, z, px, -3, pz, x, h, z, px, ph, pz);
        const c = far.clone().lerp(near, 0.5 + 0.5 * crown);
        for (let k = 0; k < 6; k++) col.push(k === 2 || k === 4 || k === 5 ? c.r * 1.08 : c.r * 0.82, c.g * (k === 2 || k === 4 || k === 5 ? 1.06 : 0.84), c.b * 0.9);
      }
      prev = land ? cur : null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    mesh.frustumCulled = false;
    return mesh;
  };
  g.add(ring(3200, 5, 3, 12, 0x4a5534, 0.38, 2.7));
  g.add(ring(6600, 10, 8, 30, 0x3f4a33, 0.62, 5.1));

  const glowMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
    uniforms: {
      uSun: { value: sunDir.clone().setY(0).normalize() },
      uWarm: { value: new THREE.Color(1.0, 0.72, 0.42) },
      uCool: { value: new THREE.Color(0.95, 0.76, 0.68) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      uniform vec3 uWarm;
      uniform vec3 uCool;
      varying vec3 vWorld;
      void main() {
        vec3 d = normalize(vWorld - cameraPosition);
        float toSun = dot(normalize(d.xz), uSun.xz) * 0.5 + 0.5;
        float elev = max(d.y, 0.0);
        float a = exp(-elev / 0.03) * 0.62 + exp(-elev / 0.11) * 0.16;
        a *= smoothstep(-0.02, 0.0, d.y + 0.004) * 0.75 + 0.25;
        gl_FragColor = vec4(mix(uCool, uWarm, toSun * toSun), a * (0.8 + 0.35 * toSun));
      }`,
  });
  const glow = new THREE.Mesh(new THREE.CylinderGeometry(10500, 10500, 3600, 96, 1, true), glowMat);
  glow.position.y = 1200;
  glow.frustumCulled = false;
  glow.renderOrder = -1;
  g.add(glow);
  return { group: g, glow };
}
