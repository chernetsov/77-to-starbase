import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const hash = (a: number, b = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** Stainless rings with a darker weld line between them and a staggered vertical seam on each ring. */
export function ringTexture(rings: number, base: number, variance: number) {
  return canvasTexture(256, 1024, (ctx) => {
    const step = 1024 / rings;
    for (let i = 0; i < rings; i++) {
      const v = base + hash(i) * variance;
      ctx.fillStyle = `rgb(${v},${v},${v + 3})`;
      ctx.fillRect(0, i * step, 256, step);
      ctx.fillStyle = 'rgba(70,70,74,0.4)';
      ctx.fillRect(0, i * step, 256, 2);
      ctx.fillStyle = 'rgba(70,70,74,0.25)';
      ctx.fillRect(Math.floor(hash(i, 7) * 256), i * step, 2, step);
    }
  });
}

/**
 * Pointy-top hexagonal heat-shield tiles. The texture covers `width` x `height` meters at repeat 1,
 * so callers divide their surface size by these to get a repeat.
 */
export function hexTileTexture(size = 0.26, cols = 16, rows = 24) {
  const w = Math.sqrt(3) * size;
  const pitch = 1.5 * size;
  const width = cols * w;
  const height = rows * pitch;
  const tex = canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = 'rgb(7,7,8)';
    ctx.fillRect(0, 0, 512, 512);
    ctx.scale(512 / width, 512 / height);
    for (let r = -1; r <= rows; r++) {
      for (let c = -1; c <= cols; c++) {
        const cx = c * w + (((r % 2) + 2) % 2 ? w / 2 : 0);
        const cy = r * pitch;
        const key = hash(((c % cols) + cols) % cols, ((r % rows) + rows) % rows);
        const v = key > 0.992 ? 74 : 20 + Math.floor(hash(key * 91) * 13);
        ctx.fillStyle = `rgb(${v},${v},${v + 2})`;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + (k * Math.PI) / 3;
          const px = cx + Math.cos(a) * size * 0.9;
          const py = cy + Math.sin(a) * size * 0.9;
          if (k) ctx.lineTo(px, py);
          else ctx.moveTo(px, py);
        }
        ctx.fill();
      }
    }
  });
  return { tex, width, height };
}

/** Square cladding panels with dark joints; `px` is the panel edge in texels on a 128 canvas. */
export function panelTexture(base: number, joint: string, px = 128) {
  return canvasTexture(px, px, (ctx) => {
    for (let y = 0; y < px; y += 4) {
      const v = base + (hash(y) - 0.5) * 6;
      ctx.fillStyle = `rgb(${v},${v},${v + 2})`;
      ctx.fillRect(0, y, px, 4);
    }
    ctx.fillStyle = joint;
    ctx.fillRect(0, 0, px, 2);
    ctx.fillRect(0, 0, 2, px);
    ctx.fillRect(0, px / 2, px, 1);
  });
}

export function mat4(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

const KEEP = new Set(['position', 'normal', 'uv']);

function flipWinding(g: THREE.BufferGeometry) {
  for (const attr of Object.values(g.attributes) as THREE.BufferAttribute[]) {
    const a = attr.array as Float32Array;
    const n = attr.itemSize;
    for (let t = 0; t < attr.count; t += 3) {
      for (let k = 0; k < n; k++) {
        const i1 = (t + 1) * n + k;
        const i2 = (t + 2) * n + k;
        const tmp = a[i1];
        a[i1] = a[i2];
        a[i2] = tmp;
      }
    }
  }
}

/** Collects static geometry in one frame and merges it into a single mesh per material. */
export class Batch {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(geo: THREE.BufferGeometry, mat: THREE.Material, m?: THREE.Matrix4) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const name of Object.keys(g.attributes)) if (!KEEP.has(name)) g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    if (m) {
      g.applyMatrix4(m);
      if (m.determinant() < 0) flipWinding(g);
    }
    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
    return this;
  }

  build(shadows = true) {
    const meshes: THREE.Mesh[] = [];
    for (const [mat, list] of this.parts) {
      const mesh = new THREE.Mesh(mergeGeometries(list), mat);
      mesh.castShadow = shadows;
      mesh.receiveShadow = shadows;
      meshes.push(mesh);
      for (const g of list) g.dispose();
    }
    this.parts.clear();
    return meshes;
  }
}

/** Splits a non-indexed geometry into triangles whose face normal points along `axis` and the rest. */
export function splitByNormal(geo: THREE.BufferGeometry, axis: THREE.Vector3, threshold = 0.6) {
  const src = geo.index ? geo.toNonIndexed() : geo;
  const names = Object.keys(src.attributes).filter((n) => KEEP.has(n));
  const out = [names.map(() => [] as number[]), names.map(() => [] as number[])];
  const pos = src.attributes.position;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    const n = b.sub(a).cross(c.sub(a)).normalize();
    const bucket = n.dot(axis) > threshold ? 0 : 1;
    names.forEach((name, i) => {
      const attr = src.attributes[name];
      for (let v = t; v < t + 3; v++) for (let k = 0; k < attr.itemSize; k++) out[bucket][i].push(attr.array[v * attr.itemSize + k]);
    });
  }
  return out.map((arrays) => {
    const g = new THREE.BufferGeometry();
    names.forEach((name, i) => g.setAttribute(name, new THREE.Float32BufferAttribute(arrays[i], src.attributes[name].itemSize)));
    return g;
  }) as [THREE.BufferGeometry, THREE.BufferGeometry];
}
