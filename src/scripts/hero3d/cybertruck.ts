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
