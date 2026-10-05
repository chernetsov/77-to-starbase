import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Puffs } from './puffs';

// Boca Chica geography around the launch mount at the origin (+x east toward the Gulf, +z south).
// The beach runs north–south; the build site (Starfactory, Mega Bays) is ~3.3 km west-southwest.
export const SHORE = { duneCrest: 378, beachStart: 425, wetStart: 538, water: 575 };
export const BUILD_SITE = new THREE.Vector3(-3180, 0, 1030);

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
  return Math.max(0, hc * ridge + hummocks);
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
    } while ((Math.abs(x) < 80 && Math.abs(z) < 90) || (Math.abs(x - 120) < 60 && Math.abs(z + 330) < 60) || Math.abs(z - 330) < 30);
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
export function buildVariety(cameraZ: number, lowPower: boolean) {
  const g = new THREE.Group();
  const rand = rng(1977);
  const tmp = new THREE.Object3D();
  const color = new THREE.Color();
  const scale = lowPower ? 0.6 : 1;
  const zMin = cameraZ - 500;
  const zSpan = 900;
  // Leave the beach clear where the truck rolls in and parks, and around the camera.
  const clearOfTruck = (x: number, z: number) => !(x > 410 && x < 470 && z > -80 && z < 10) && !(Math.abs(z - 330) < 7);
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

function bayTexture(base: string) {
  return canvasTexture(256, 512, (ctx) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 256, 512);
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x < 256; x += 8) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 512);
      ctx.stroke();
    }
    // External truss bands with X bracing, as on the Mega Bays.
    ctx.strokeStyle = '#e9ebee';
    ctx.lineWidth = 4;
    for (let y = 40; y < 512; y += 72) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.moveTo(0, y + 18);
      ctx.lineTo(256, y + 18);
      ctx.stroke();
      ctx.lineWidth = 2;
      for (let x = 0; x < 256; x += 32) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 32, y + 18);
        ctx.moveTo(x + 32, y);
        ctx.lineTo(x, y + 18);
        ctx.stroke();
      }
      ctx.lineWidth = 4;
    }
  });
}

function factoryTexture() {
  return canvasTexture(512, 128, (ctx) => {
    ctx.fillStyle = '#d9dcdf';
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#3d6f9a';
    ctx.fillRect(0, 14, 512, 22);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    for (let x = 0; x < 512; x += 16) ctx.fillRect(x, 14, 2, 22);
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    for (let x = 0; x < 512; x += 6) ctx.fillRect(x, 40, 1, 88);
  });
}

/** The build site: Starfactory, Mega Bays, High Bay, cranes, and a few vehicles in the rocket garden. */
export function buildFactory() {
  const g = new THREE.Group();
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, h / 2, z);
    g.add(m);
    return m;
  };
  const roof = new THREE.MeshStandardMaterial({ color: 0xbfc3c7, roughness: 0.6 });
  const factoryMat = new THREE.MeshStandardMaterial({ map: factoryTexture(), roughness: 0.55 });
  factoryMat.map!.repeat.set(4, 1);
  box(270, 34, 110, [factoryMat, factoryMat, roof, roof, factoryMat, factoryMat] as unknown as THREE.Material, 0, 0);

  const bay = (w: number, h: number, d: number, x: number, z: number, shade: string) => {
    const tex = bayTexture(shade);
    tex.repeat.set(Math.max(1, Math.round(w / 30)), h / 80);
    const side = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.2 });
    box(w, h, d, [side, side, roof, roof, side, side] as unknown as THREE.Material, x, z);
  };
  bay(56, 92, 44, 200, -40, '#7a7e83');
  bay(64, 102, 50, 272, -34, '#6f7378');
  bay(30, 81, 30, 140, -78, '#83878c');
  bay(24, 52, 24, 104, -96, '#8b8f94');

  const steel = new THREE.MeshStandardMaterial({ color: 0xd2d5d8, metalness: 0.85, roughness: 0.3 });
  for (const [x, z, h] of [[150, 40, 50], [166, 44, 52], [182, 40, 70]]) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, h - 12, 32), steel);
    body.position.set(x, (h - 12) / 2, z);
    g.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(4.5, 12, 32), steel);
    nose.position.set(x, h - 6, z);
    g.add(nose);
  }

  const craneMat = new THREE.MeshStandardMaterial({ color: 0xc8402c, roughness: 0.6 });
  for (const [x, z, h, tilt] of [[240, 20, 150, 0.18], [120, -20, 120, -0.22]]) {
    const boom = new THREE.Mesh(new THREE.BoxGeometry(2.4, h, 2.4), craneMat);
    boom.position.set(x + Math.sin(tilt) * h * 0.5, Math.cos(tilt) * h * 0.5, z);
    boom.rotation.z = -tilt;
    g.add(boom);
  }
  g.position.copy(BUILD_SITE);
  g.rotation.y = 0.05;
  return g;
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sky over the Gulf coast: fair-weather cumulus at 0.6–1.6 km (a few right on the ascent path, so the
 * climb has something to pass), a broken stratocumulus layer near 2.3–3.2 km, and thin cirrus up high.
 */
export function buildClouds(lowPower: boolean) {
  const rand = rng(77);
  const items: number[] = [];
  const cluster = (cx: number, base: number, cz: number, w: number, flat: boolean) => {
    const n = (flat ? 14 : 12) * (lowPower ? 0.6 : 1);
    const h = w * (flat ? 0.12 : 0.45);
    for (let k = 0; k < n; k++) {
      const u = rand() * 2 - 1;
      const edge = 1 - Math.abs(u) * 0.7;
      const y = base + Math.pow(rand(), 1.4) * h * edge;
      const size = w * (flat ? 0.22 + rand() * 0.18 : 0.3 + rand() * 0.28) * (0.6 + 0.4 * edge);
      const shade = 0.8 + 0.2 * ((y - base) / h);
      items.push(cx + u * w * 0.5, y + size * 0.2, cz + (rand() * 2 - 1) * w * (flat ? 0.5 : 0.32), size, rand() * 6.28, flat ? 0.36 : 0.82, 0, Math.floor(rand() * 4), shade);
    }
  };

  // Clouds near the ascent sit beside and beyond the rocket as seen from the beach, not over the camera.
  for (const [x, y, z, w] of [[-220, 700, 300, 380], [-60, 1050, -420, 420], [-380, 1450, -120, 520], [-150, 1250, 480, 300]]) {
    cluster(x, y, z, w, false);
  }
  for (const [x, y, z, w] of [[-420, 2300, 520, 520], [-700, 2700, -560, 600]]) cluster(x, y, z, w, false);
  for (const [x, y, z, w] of [[-2600, 2900, 1400, 1500], [-1800, 3100, -2200, 1700]]) cluster(x, y, z, w, true);
  for (let i = 0; i < 26; i++) {
    const x = -11000 + rand() * 13000;
    const z = -8000 + rand() * 16000;
    if (Math.hypot(x, z) < 700 || Math.hypot(x - 480, z + 60) < 2200) continue;
    cluster(x, 650 + rand() * 950, z, 350 + rand() * 750, false);
  }
  // A band of distant cumulus across the beach view toward the pads and the build site.
  for (let i = 0; i < 18; i++) {
    const az = Math.PI + 0.12 + (rand() - 0.5) * 1.1;
    const d = 2800 + rand() * 7000;
    cluster(480 + Math.cos(az) * d, 700 + rand() * 1100, -60 - Math.sin(az) * d, 300 + rand() * 600, false);
  }
  for (let i = 0; i < 6; i++) cluster(-9000 + rand() * 8000, 2300 + rand() * 900, -7000 + rand() * 14000, 1200 + rand() * 1000, true);

  const cirrusMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
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
        vec2 p = vec2(vWorld.z * 0.00011 + uTime * 0.002, vWorld.x * 0.0004);
        p.y += fbm(p * vec2(1.0, 0.5) + 3.0) * 0.9;
        float streaks = fbm(p * vec2(1.0, 2.2));
        float patches = smoothstep(0.38, 0.62, fbm(vWorld.xz * 0.00006 + 7.0));
        float cover = smoothstep(0.56, 0.84, streaks) * patches;
        float fade = 1.0 - smoothstep(9000.0, 26000.0, length(vWorld.xz - cameraPosition.xz));
        gl_FragColor = vec4(0.96, 0.96, 0.99, cover * fade * 0.4);
      }`,
  });
  const cirrus = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000), cirrusMat);
  cirrus.rotation.x = Math.PI / 2;
  cirrus.position.y = 9000;
  cirrus.frustumCulled = false;
  cirrus.renderOrder = -1;

  return {
    mesh: cirrus,
    count: items.length / 9,
    push(puffs: Puffs) {
      for (let o = 0; o < items.length; o += 9) {
        puffs.push(items[o], items[o + 1], items[o + 2], items[o + 3], items[o + 4], items[o + 5], items[o + 6], items[o + 7], items[o + 8]);
      }
    },
    update(time: number) {
      cirrusMat.uniforms.uTime.value = time;
    },
  };
}
