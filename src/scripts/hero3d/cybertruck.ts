import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
// "Tesla Cybertruck" by Sketcher (jnanbr07) (https://sketchfab.com/3d-models/tesla-cybertruck-587a0833e60f465090145b139f6c1bfc),
// CC BY 4.0. Optimized copy in public/models; the source faces -x with the axles as two meshes.
export const CYBERTRUCK_LENGTH = 5.683;

export interface Cybertruck {
  group: THREE.Group;
  /** Axle pivots; positive rotation.z rolls the truck forward (toward +x). */
  wheels: THREE.Object3D[];
  wheelRadius: number;
  length: number;
}

function isDescendant(o: THREE.Object3D, ancestor: THREE.Object3D) {
  for (let p = o.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

// The source has prototype-style flush door handles (Cube.086 is both rear ones, one mesh across the truck).
const HANDLE = /^Cube\.?08[678]_/;
// Black B- and C-pillar appliqués, where the production truck has its door release buttons.
const PILLAR = /^Cube\.?(090|091|068|070)_/;
/**
 * Door release button, meters. Its width is the pillar's; `aspect` is height over width, `gap` the space above
 * the beltline, `rim` the width of the glass's chamfered edge, `dash` the painted mark as fractions of the width.
 */
export const DOOR_BUTTON = { aspect: 0.42, proud: 0.0015, rim: 0.0005, gap: 0.004, dash: { w: 0.06, h: 0.02 } };

function meshesMatching(root: THREE.Object3D, re: RegExp) {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && re.test(o.name)) out.push(o as THREE.Mesh);
  });
  return out;
}

/**
 * Removes the handles and flattens the 2 cm pockets they sat in onto the door skin: the pocket floor becomes
 * coplanar with the skin, its walls collapse and are dropped. Expects world matrices in truck meters.
 */
function removeDoorHandles(model: THREE.Object3D) {
  const handles = meshesMatching(model, HANDLE);
  const pockets: THREE.Box3[] = [];
  const p = new THREE.Vector3();
  for (const h of handles) {
    const pos = h.geometry.attributes.position;
    const sides = [new THREE.Box3(), new THREE.Box3()];
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(h.matrixWorld);
      sides[p.z > 0 ? 1 : 0].expandByPoint(p);
    }
    for (const b of sides) if (!b.isEmpty()) pockets.push(b.expandByVector(new THREE.Vector3(0.015, 0.015, 0.03)));
    h.removeFromParent();
  }

  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  for (const mesh of meshes) {
    const meshBox = new THREE.Box3().setFromObject(mesh, true);
    for (const pocket of pockets) {
      if (meshBox.intersectsBox(pocket)) flattenPocket(mesh, pocket);
    }
  }
}

function flattenPocket(mesh: THREE.Mesh, pocket: THREE.Box3) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const index = geo.index;
  if (!nor || !index) return;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const world: THREE.Vector3[] = [];
  const normals: THREE.Vector3[] = [];
  const inside: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (!pocket.containsPoint(v)) continue;
    inside.push(i);
    world[i] = v;
    normals[i] = new THREE.Vector3().fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
  }
  if (inside.length < 8) return;

  // The skin and the pocket floor share the outward normal, which is the most common one here.
  let plane = normals[inside[0]];
  let best = 0;
  for (const i of inside) {
    const n = inside.filter((j) => normals[j].dot(normals[i]) > 0.995).length;
    if (n > best) [best, plane] = [n, normals[i]];
  }
  let skin = -Infinity;
  for (const i of inside) if (normals[i].dot(plane) > 0.995) skin = Math.max(skin, world[i].dot(plane));

  // The floor's UVs point at the pocket's baked occlusion; give every moved vertex the skin's own planar mapping,
  // fitted (least squares, uv = a·s + b·t + c) from the flat skin vertices around the opening.
  const uv = geo.attributes.uv;
  const sAxis = new THREE.Vector3(1, 0, 0).addScaledVector(plane, -plane.x).normalize();
  const tAxis = new THREE.Vector3().crossVectors(plane, sAxis);
  const flat = inside.filter((i) => normals[i].dot(plane) > 0.995 && skin - world[i].dot(plane) < 0.0005);
  let fit: ((s: number, t: number) => [number, number]) | null = null;
  if (uv && flat.length >= 3) {
    const ata = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    const atu = new THREE.Vector3();
    const atv = new THREE.Vector3();
    for (const i of flat) {
      const r = new THREE.Vector3(world[i].dot(sAxis), world[i].dot(tAxis), 1);
      const ra = r.toArray();
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) ata.elements[a + b * 3] += ra[a] * ra[b];
      atu.addScaledVector(r, uv.getX(i));
      atv.addScaledVector(r, uv.getY(i));
    }
    if (Math.abs(ata.determinant()) > 1e-12) {
      const inv = ata.clone().invert();
      const cu = atu.applyMatrix3(inv);
      const cv = atv.applyMatrix3(inv);
      fit = (s, t) => [cu.x * s + cu.y * t + cu.z, cv.x * s + cv.y * t + cv.z];
    }
  }
  const tan = geo.attributes.tangent;
  const skinTangent = tan && flat.length ? [tan.getX(flat[0]), tan.getY(flat[0]), tan.getZ(flat[0]), tan.getW(flat[0])] : null;

  const toLocal = mesh.matrixWorld.clone().invert();
  const p = new THREE.Vector3();
  const localNormal = plane.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld).transpose()).normalize();
  for (const i of inside) {
    const v = world[i];
    v.addScaledVector(plane, skin - v.dot(plane));
    p.copy(v).applyMatrix4(toLocal);
    pos.setXYZ(i, p.x, p.y, p.z);
    nor.setXYZ(i, localNormal.x, localNormal.y, localNormal.z);
    if (fit) uv.setXY(i, ...fit(v.dot(sAxis), v.dot(tAxis)));
    if (skinTangent) tan.setXYZW(i, ...(skinTangent as [number, number, number, number]));
  }
  pos.needsUpdate = nor.needsUpdate = true;
  if (uv) uv.needsUpdate = true;
  if (tan) tan.needsUpdate = true;

  // Collapsed walls are slivers; drop them so edge and shadow passes don't pick them up.
  const kept: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    if (world[a] && world[b] && world[c]) {
      const ab = world[a].distanceTo(world[b]), bc = world[b].distanceTo(world[c]), ca = world[c].distanceTo(world[a]);
      if (Math.min(ab, bc, ca) < 0.0001) continue;
    }
    kept.push(a, b, c);
  }
  geo.setIndex(kept);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

/**
 * Release buttons: a black glass tile the full width of the pillar's foot, sitting on the beltline, with a thin
 * chamfered edge and a short white painted dash in the middle.
 */
function addDoorButtons(inner: THREE.Object3D) {
  const { aspect, proud, rim, gap, dash } = DOOR_BUTTON;
  const faceMat = new THREE.MeshStandardMaterial({ color: 0x030304, roughness: 0.06, metalness: 0 });
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6, metalness: 0 });
  const ray = new THREE.Raycaster();
  const glass = meshesMatching(inner, /^Side_glass/);
  const body = meshesMatching(inner, /_Bodyl_/);
  for (const pillar of meshesMatching(inner, PILLAR)) {
    const b = new THREE.Box3().setFromObject(pillar, true);
    const side = Math.sign(b.min.z + b.max.z);
    // Width of the pillar's outward face just above the beltline.
    const scanY = b.min.y + 0.015;
    let x0 = Infinity, x1 = -Infinity;
    for (let x = b.min.x; x <= b.max.x; x += 0.001) {
      ray.set(new THREE.Vector3(x, scanY, side * 2), new THREE.Vector3(0, 0, -side));
      if (ray.intersectObject(pillar, false).length) [x0, x1] = [Math.min(x0, x), Math.max(x1, x)];
    }
    if (x0 > x1) continue;
    const w = x1 - x0 - 2 * rim;
    const h = w * aspect;
    // The side glass runs over the pillars in this model; the button sits on whichever surface is outermost.
    const surface = (y: number) => {
      ray.set(new THREE.Vector3((x0 + x1) / 2, y, side * 2), new THREE.Vector3(0, 0, -side));
      return ray.intersectObjects([pillar, ...glass], false)[0];
    };
    let hit = surface(b.min.y + gap + h / 2 + rim);
    if (!hit?.face) continue;
    const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    if (n.z * side < 0) n.negate();
    // Stand it on the beltline cap, which sits proud of the glass, and run its long edge along the sill: probe
    // straight down just outside the face across the pillar's width.
    const belt: THREE.Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const probe = hit.point.clone().addScaledVector(n, 0.004).setX(x0 + ((x1 - x0) * i) / 8).setY(b.min.y + 0.2);
      ray.set(probe, new THREE.Vector3(0, -1, 0));
      const p = ray.intersectObjects(body, false)[0]?.point;
      if (p && p.y > b.min.y - 0.05) belt.push(p);
    }
    // Probes that land on the sail rather than the sill sit well above the sill line; keep the low, gently sloped run.
    const lowest = belt.reduce<THREE.Vector3 | null>((a, p) => (!a || p.y < a.y ? p : a), null);
    const run = lowest ? belt.filter((p) => p === lowest || Math.abs(p.y - lowest.y) < 0.15 * Math.abs(p.x - lowest.x)) : [];
    let sill = new THREE.Vector3(1, 0, 0);
    if (run.length >= 3) {
      const mx = run.reduce((s, p) => s + p.x, 0) / run.length;
      const my = run.reduce((s, p) => s + p.y, 0) / run.length;
      const slope = run.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / run.reduce((s, p) => s + (p.x - mx) ** 2, 0);
      sill = new THREE.Vector3(1, slope, 0);
      hit = surface(my + slope * ((x0 + x1) / 2 - mx) + gap + h / 2 + rim) ?? hit;
    }
    const xAxis = sill.addScaledVector(n, -sill.dot(n)).normalize();
    const yAxis = new THREE.Vector3().crossVectors(n, xAxis);
    if (yAxis.y < 0) {
      xAxis.negate();
      yAxis.negate();
    }

    // Outline: the sill below, the pillar's own edges at the sides (they lean), parallel to the sill on top.
    // Visible pillar: rays that reach it without first meeting the steel around it (the sail laps over the C-pillar).
    const steel = body.filter((m) => m !== pillar);
    const span = (v: number) => {
      let u0 = Infinity, u1 = -Infinity;
      for (let u = -0.15; u <= 0.15; u += 0.0005) {
        const o = hit!.point.clone().addScaledVector(xAxis, u).addScaledVector(yAxis, v).addScaledVector(n, 0.5);
        ray.set(o, n.clone().negate());
        const first = ray.intersectObjects([pillar, ...steel], false)[0];
        if (first?.object === pillar) [u0, u1] = [Math.min(u0, u), Math.max(u1, u)];
      }
      return u0 < u1 ? [u0, u1] : [-w / 2 - rim, w / 2 + rim];
    };
    // The pillar's foot is chamfered; take the edges from higher up and run them straight down to the sill.
    const vLow = -h / 4;
    const vTop = h / 2 + rim;
    const low = span(vLow);
    const [tl, tr] = span(vTop);
    const k = (-h / 2 - rim - vTop) / (vLow - vTop);
    const bl = tl + (low[0] - tl) * k;
    const br = tr + (low[1] - tr) * k;
    const quad = (inset: number) =>
      new THREE.Shape([
        new THREE.Vector2(bl + inset, -h / 2 - rim + inset),
        new THREE.Vector2(br - inset, -h / 2 - rim + inset),
        new THREE.Vector2(tr - inset, h / 2 + rim - inset),
        new THREE.Vector2(tl + inset, h / 2 + rim - inset),
      ]);
    const bevel = proud * 0.5;
    const faceGeo = new THREE.ExtrudeGeometry(quad(rim), {
      depth: 2 * proud - 2 * bevel,
      bevelThickness: bevel,
      bevelSize: rim,
      bevelSegments: 3,
    });
    faceGeo.translate(0, 0, -proud + bevel);

    const button = new THREE.Group();
    button.name = 'door_button';
    const face = new THREE.Mesh(faceGeo, faceMat);
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(w * dash.w, w * dash.h), dashMat);
    mark.position.set((bl + br + tl + tr) / 4, 0, proud + 0.0002);
    button.add(face, mark);
    for (const m of [face, mark]) m.receiveShadow = true;
    button.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, n));
    button.position.copy(hit.point);
    // inner carries the model's scale; attach keeps the button at true size.
    inner.attach(button);
  }
}

export function cybertruckUrl() {
  return `${import.meta.env.BASE_URL.replace(/\/?$/, '/')}models/cybertruck.glb`;
}

export async function loadCybertruck(url = cybertruckUrl(), onProgress?: (e: ProgressEvent) => void): Promise<Cybertruck> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, onProgress);
  const model = gltf.scene;

  // Frame the model in meters with the nose toward +x, centered on x/z and sitting on y = 0.
  const inner = new THREE.Group();
  inner.add(model);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model, true);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
  inner.scale.setScalar(CYBERTRUCK_LENGTH / size.x);
  inner.rotation.y = Math.PI;
  inner.updateMatrixWorld(true);
  removeDoorHandles(model);
  addDoorButtons(inner);

  const wheels: THREE.Object3D[] = [];
  let wheelRadius = 0.45;
  // Each axle is split into tread, sidewall, and rim nodes that share a name prefix (three.js suffixes duplicates).
  for (const name of ['axle_front', 'axle_rear']) {
    const parts: THREE.Object3D[] = [];
    model.traverse((o) => {
      if (o.name.startsWith(name) && !parts.some((p) => isDescendant(o, p))) parts.push(o);
    });
    if (!parts.length) continue;
    const b = new THREE.Box3();
    for (const p of parts) b.union(new THREE.Box3().setFromObject(p, true));
    const s = b.getSize(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.position.copy(b.getCenter(new THREE.Vector3()));
    pivot.position.y = b.min.y + s.x / 2;
    inner.worldToLocal(pivot.position);
    inner.add(pivot);
    pivot.updateMatrixWorld(true);
    for (const p of parts) pivot.attach(p);
    wheels.push(pivot);
    wheelRadius = s.x / 2;
  }

  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat.name.startsWith('Light_W')) {
      mat.emissive = new THREE.Color(0xf4f7ff);
      mat.emissiveIntensity = 6;
    } else if (mat.name.startsWith('Light_R')) {
      mat.emissive = new THREE.Color(0xff1a12);
      mat.emissiveIntensity = 4;
    } else if (mat.name.startsWith('Glass')) {
      mesh.castShadow = false;
      // Factory privacy tint: dark, still glossy enough to pick up the sky.
      mat.color = new THREE.Color(0x0b0d10);
      mat.map = null;
      mat.transparent = true;
      mat.opacity = 0.82;
      mat.metalness = 0.2;
      mat.roughness = 0.05;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
  });

  const group = new THREE.Group();
  group.name = 'cybertruck';
  group.add(inner);
  return { group, wheels, wheelRadius, length: CYBERTRUCK_LENGTH };
}
