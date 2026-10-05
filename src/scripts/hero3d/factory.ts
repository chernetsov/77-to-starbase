import * as THREE from 'three';
import { buildStack } from './starship';

// Starbase build site as of late 2026, strung along the north side of Highway 4.
// Local frame: +x faces the road (the Starfactory front, bay doors, the fence), +z runs west.
// The Gigabay rises between the Mega Bays and the factory on the old High Bay lot.
// Dimensions follow published figures: Mega Bays ~38 × 54 × 99 m, Gigabay ~110 × 130 × 116 m,
// Starfactory ~1M ft² over three roof heights, Super Heavy ~71 m and Ship ~52 m at 9 m diameter.

type Glow = { mat: THREE.MeshStandardMaterial; base: number };

const HAZE = {
  uHazeColor: { value: new THREE.Vector3(0.82, 0.7, 0.58) },
  uHazeDensity: { value: 1.6e-4 },
  uHazeMax: { value: 0.55 },
};

/** Distance haze on top of scene fog so the site sits at ~3 km instead of looking pasted on. */
function hazed<T extends THREE.Material>(m: T): T {
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, HAZE);
    s.vertexShader =
      'varying float vHazeDist;\n' +
      s.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvHazeDist = -mvPosition.z;');
    s.fragmentShader =
      'uniform vec3 uHazeColor;\nuniform float uHazeDensity;\nuniform float uHazeMax;\nvarying float vHazeDist;\n' +
      s.fragmentShader.replace(
        '#include <fog_fragment>',
        '#include <fog_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, uHazeColor, uHazeMax * (1.0 - exp(-vHazeDist * uHazeDensity)));',
      );
  };
  m.customProgramCacheKey = () => 'starbase-haze';
  return m;
}

/** Draws in w × h units at TEX_SCALE× resolution, so window grids and mullions stay crisp up close. */
const TEX_SCALE = 3;
function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w * TEX_SCALE;
  c.height = h * TEX_SCALE;
  const ctx = c.getContext('2d')!;
  ctx.scale(TEX_SCALE, TEX_SCALE);
  draw(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 16;
  return tex;
}

/**
 * Ambient occlusion derived from a facade's color canvas: dark texels are glass, open frame or
 * door cavities, which the sky can't reach. Without this the bright sky env lifts them to grey.
 */
function aoFrom(tex: THREE.CanvasTexture) {
  const src = tex.image as HTMLCanvasElement;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const sctx = src.getContext('2d')!;
  const octx = out.getContext('2d')!;
  const img = sctx.getImageData(0, 0, src.width, src.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) / 255;
    const ao = 255 * THREE.MathUtils.clamp((lum - 0.06) / 0.34, 0.1, 1);
    d[i] = d[i + 1] = d[i + 2] = ao;
  }
  octx.putImageData(img, 0, 0);
  const ao = new THREE.CanvasTexture(out);
  ao.wrapS = tex.wrapS;
  ao.wrapT = tex.wrapT;
  return ao;
}

const rand = (() => {
  let s = 77;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
})();

/** Accumulates triangles for one material so each material is a single draw call. */
class Mesher {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  m = new THREE.Matrix4();
  nm = new THREE.Matrix3();
  private v = new THREE.Vector3();

  at(m: THREE.Matrix4 | null) {
    this.m = m ?? new THREE.Matrix4();
    this.nm.getNormalMatrix(this.m);
    return this;
  }

  private push(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number) {
    this.v.copy(p).applyMatrix4(this.m);
    this.pos.push(this.v.x, this.v.y, this.v.z);
    this.v.copy(n).applyMatrix3(this.nm).normalize();
    this.nor.push(this.v.x, this.v.y, this.v.z);
    this.uv.push(u, v);
  }

  /** Quad a-b-c-d counter-clockwise seen from the front. */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uv: number[]) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    this.push(a, n, uv[0], uv[1]);
    this.push(b, n, uv[2], uv[3]);
    this.push(c, n, uv[4], uv[5]);
    this.push(a, n, uv[0], uv[1]);
    this.push(c, n, uv[4], uv[5]);
    this.push(d, n, uv[6], uv[7]);
  }

  /**
   * Vertical wall from p0 to p1 (bottom-left to bottom-right seen from outside).
   * UV: u = (u0 + s) / su along the wall, v = (y - v0) / sv.
   */
  wall(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, su: number, sv: number, u0 = 0, v0 = 0) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const ua = u0 / su;
    const ub = (u0 + len) / su;
    const va = (y0 - v0) / sv;
    const vb = (y1 - v0) / sv;
    this.quad(
      new THREE.Vector3(x0, y0, z0),
      new THREE.Vector3(x1, y0, z1),
      new THREE.Vector3(x1, y1, z1),
      new THREE.Vector3(x0, y1, z0),
      [ua, va, ub, va, ub, vb, ua, vb],
    );
  }

  /** Horizontal face at height y; up=false faces down. UV in meters / s. */
  flat(x0: number, x1: number, z0: number, z1: number, y: number, s: number, up = true) {
    const a = new THREE.Vector3(x0, y, z0);
    const b = new THREE.Vector3(x0, y, z1);
    const c = new THREE.Vector3(x1, y, z1);
    const d = new THREE.Vector3(x1, y, z0);
    const uv = [x0 / s, z0 / s, x0 / s, z1 / s, x1 / s, z1 / s, x1 / s, z0 / s];
    if (up) this.quad(a, b, c, d, uv);
    else this.quad(a, d, c, b, [uv[0], uv[1], uv[6], uv[7], uv[4], uv[5], uv[2], uv[3]]);
  }

  /** Axis-aligned box with world-scaled UVs on every face. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, s = 8, bottom = false) {
    this.wall(x1, z1, x1, z0, y0, y1, s, s);
    this.wall(x0, z0, x0, z1, y0, y1, s, s);
    this.wall(x0, z1, x1, z1, y0, y1, s, s);
    this.wall(x1, z0, x0, z0, y0, y1, s, s);
    this.flat(x0, x1, z0, z1, y1, s);
    if (bottom) this.flat(x0, x1, z0, z1, y0, s, false);
  }

  /** Appends a library geometry (positions, normals, uvs). */
  geo(g: THREE.BufferGeometry) {
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.attributes.position;
    const n = src.attributes.normal;
    const u = src.attributes.uv;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(n, i);
      this.push(a, b, u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
    g.dispose();
  }

  mesh(mat: THREE.Material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return new THREE.Mesh(g, mat);
  }
}

// ---------------------------------------------------------------- textures

/** Insulated metal panel cladding: 32 m tile, panel seams every 4 m, faint ribs. */
function claddingTexture() {
  return canvasTexture(256, 256, (ctx) => {
    for (let y = 0; y < 256; y += 32) {
      for (let x = 0; x < 256; x += 64) {
        const t = 222 + Math.floor(rand() * 14);
        ctx.fillStyle = `rgb(${t},${t + 2},${t + 1})`;
        ctx.fillRect(x, y, 64, 32);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let x = 0; x < 256; x += 3) ctx.fillRect(x, 0, 1, 256);
    ctx.fillStyle = 'rgba(40,44,48,0.28)';
    for (let y = 0; y < 256; y += 32) ctx.fillRect(0, y, 256, 1);
  });
}

function wordmark(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, h: number, w: number, color: string, swoosh: boolean) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${h}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  const m = ctx.measureText(text).width;
  ctx.translate(x, y);
  ctx.scale(w / m, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
  if (swoosh) {
    // The SpaceX "X" carries a long swoosh across the wordmark.
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, h * 0.09);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - w * 0.42, y + h * 0.18);
    ctx.quadraticCurveTo(x + w * 0.05, y - h * 0.2, x + w * 0.5, y - h * 0.62);
    ctx.stroke();
    ctx.restore();
  }
}

/** East (door) face of a Mega Bay, 38 m × 99 m at 6 px/m, with a matching emissive map. */
function megaBayFace(windowRows: number, doorOpen: number) {
  const W = 228;
  const H = 594;
  const px = (m: number) => m * 6;
  const yy = (m: number) => H - px(m);
  const doorL = px(5);
  const doorR = px(33);
  const doorTop = 80;
  const color = canvasTexture(W, H, (ctx) => {
    for (let y = 0; y < H; y += px(4)) {
      const t = 220 + Math.floor(rand() * 14);
      ctx.fillStyle = `rgb(${t},${t + 2},${t + 2})`;
      ctx.fillRect(0, y, W, px(4));
    }
    ctx.fillStyle = 'rgba(30,34,38,0.25)';
    for (let y = 0; y < H; y += px(4)) ctx.fillRect(0, y, W, 1);
    // Corner pilasters.
    ctx.fillStyle = '#cfd3d5';
    ctx.fillRect(0, 0, px(2.2), H);
    ctx.fillRect(W - px(2.2), 0, px(2.2), H);
    // Door: stacked lift panels, split down the middle, recessed frame.
    ctx.fillStyle = '#4a4f55';
    ctx.fillRect(doorL - 4, yy(doorTop) - 4, doorR - doorL + 8, px(doorTop) + 4);
    ctx.fillStyle = '#c9cdd0';
    ctx.fillRect(doorL, yy(doorTop), doorR - doorL, px(doorTop - doorOpen));
    ctx.fillStyle = 'rgba(40,44,50,0.35)';
    for (let m = doorOpen; m < doorTop; m += 3.2) ctx.fillRect(doorL, yy(m), doorR - doorL, 1);
    ctx.fillRect(W / 2 - 1, yy(doorTop), 2, px(doorTop - doorOpen));
    if (doorOpen > 0) {
      // Lit high bay interior with a work platform.
      const g = ctx.createLinearGradient(0, yy(doorOpen), 0, H);
      g.addColorStop(0, '#6b665c');
      g.addColorStop(1, '#a39a86');
      ctx.fillStyle = g;
      ctx.fillRect(doorL, yy(doorOpen), doorR - doorL, px(doorOpen));
      ctx.fillStyle = '#d6dadc';
      ctx.fillRect(W / 2 - px(4.5), yy(doorOpen), px(9), px(doorOpen));
      ctx.fillStyle = '#3a3c40';
      ctx.fillRect(doorL, yy(doorOpen * 0.55), doorR - doorL, 3);
    }
    // Window bands in the upper office level.
    for (let r = 0; r < windowRows; r++) {
      const top = 97 - r * 4.2;
      ctx.fillStyle = '#26303a';
      ctx.fillRect(px(3), yy(top), W - px(6), px(2.4));
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (let x = px(3); x < W - px(3); x += px(1.6)) ctx.fillRect(x, yy(top), 1, px(2.4));
    }
    wordmark(ctx, 'SPACEX', W / 2, yy(86.3 - (windowRows - 1) * 2), px(4.4), px(27), '#1b1e22', true);
  });
  const emissive = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < windowRows; r++) {
      const top = 97 - r * 4.2;
      for (let x = px(3); x < W - px(3); x += px(1.6)) {
        if (rand() < 0.55) continue;
        const b = 140 + rand() * 110;
        ctx.fillStyle = `rgb(${b},${b * 0.82},${b * 0.55})`;
        ctx.fillRect(x + 1, yy(top), px(1.6) - 1, px(2.4));
      }
    }
    if (doorOpen > 0) {
      ctx.fillStyle = '#c9a77a';
      ctx.fillRect(doorL, yy(doorOpen), doorR - doorL, px(doorOpen));
      ctx.fillStyle = '#ffe9c4';
      ctx.fillRect(W / 2 - px(4.5), yy(doorOpen), px(9), px(doorOpen));
    }
  });
  return { color, emissive };
}

/**
 * Starfactory front: 300 m × 33 m at ~3.4 px/m. Glass curtain wall at ground level, black band above
 * with the big STARBASE lettering on the south section.
 */
function starfactoryFront() {
  const W = 1024;
  const H = 112;
  const sx = W / 300;
  const sy = H / 33;
  const yy = (m: number) => H - m * sy;
  const glass = (ctx: CanvasRenderingContext2D, a: number, b: number) => {
    ctx.fillStyle = '#25303a';
    ctx.fillRect(a * sx, yy(13), (b - a) * sx, 11.5 * sy);
    ctx.fillStyle = 'rgba(190,210,225,0.22)';
    for (let x = a; x < b; x += 1.6) ctx.fillRect(x * sx, yy(13), 1, 11.5 * sy);
    ctx.fillRect(a * sx, yy(7.5), (b - a) * sx, 1);
  };
  const doors: [number, number][] = [[96, 108], [180, 196]];
  const color = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#141619';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = 0; x < W; x += 6) ctx.fillRect(x, 0, 1, yy(13));
    ctx.fillStyle = '#5b6066';
    ctx.fillRect(0, yy(13.4), W, 2);
    ctx.fillStyle = '#d9dcdc';
    ctx.fillRect(0, yy(1.5), W, 1.5 * sy);
    glass(ctx, 0, 96);
    glass(ctx, 108, 180);
    glass(ctx, 196, 300);
    for (const [a, b] of doors) {
      ctx.fillStyle = '#c4c8cb';
      ctx.fillRect(a * sx, yy(12), (b - a) * sx, 12 * sy);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      for (let m = 0; m < 12; m += 0.8) ctx.fillRect(a * sx, yy(m), (b - a) * sx, 1);
    }
    wordmark(ctx, 'STARBASE', 50 * sx, yy(21), 8 * sy, 84 * sx, '#f1f1ee', false);
  });
  const emissive = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    for (let x = 0; x < 300; x += 1.6) {
      if (doors.some(([a, b]) => x >= a && x < b)) continue;
      const lit = rand();
      for (const [y0, h] of [[1.5, 6], [7.5, 5.5]] as const) {
        const b = lit < 0.25 ? 40 : 110 + rand() * 120;
        ctx.fillStyle = `rgb(${b},${b * 0.84},${b * 0.6})`;
        ctx.fillRect(x * sx + 1, yy(y0 + h), 1.6 * sx - 1, h * sy);
      }
    }
    wordmark(ctx, 'STARBASE', 50 * sx, yy(21), 8 * sy, 84 * sx, '#ffffff', false);
  });
  return { color, emissive };
}

/** Black-glass office block: tiled, 4 m per floor, 1.5 m mullions. 32 m tile. */
function officeTexture() {
  const S = 256;
  const k = S / 32;
  const color = canvasTexture(S, S, (ctx) => {
    ctx.fillStyle = '#1d232a';
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = 'rgba(160,185,205,0.25)';
    for (let x = 0; x < S; x += 1.5 * k) ctx.fillRect(x, 0, 1, S);
    ctx.fillStyle = '#0d0f12';
    for (let y = 0; y < S; y += 4 * k) ctx.fillRect(0, y, S, 0.6 * k);
  });
  const emissive = canvasTexture(S, S, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += 4 * k) {
      for (let x = 0; x < S; x += 1.5 * k) {
        if (rand() < 0.45) continue;
        const b = 120 + rand() * 120;
        ctx.fillStyle = `rgb(${b},${b * 0.86},${b * 0.66})`;
        ctx.fillRect(x + 1, y + 0.6 * k, 1.5 * k - 1, 3.4 * k);
      }
    }
  });
  return { color, emissive };
}

/** The illuminated X on the administration block, as a square decal texture. */
function xSignTexture() {
  const draw = (fill: string, bg: string) => (ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = fill;
    ctx.lineCap = 'butt';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(18, 14);
    ctx.lineTo(110, 114);
    ctx.stroke();
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(110, 14);
    ctx.lineTo(18, 114);
    ctx.stroke();
  };
  return { color: canvasTexture(128, 128, draw('#e9e9e6', '#1d232a'), false), emissive: canvasTexture(128, 128, draw('#ffffff', '#000'), false) };
}

/**
 * Gigabay wall, 116 m tall: white cladding up to ~row 10 with a ragged leading edge, then bare
 * steel frame over the dark interior and the roof trusses.
 */
function gigabayFace(widthM: number, seed: number) {
  const W = 256;
  const H = 270;
  const sx = W / widthM;
  const sy = H / 116;
  const yy = (m: number) => H - m * sy;
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const color = canvasTexture(W, H, (ctx) => {
    // The interior is in shadow even where the sun hits the face, so the cavity is near black.
    ctx.fillStyle = '#0c0d0f';
    ctx.fillRect(0, 0, W, H);
    // Steel frame: columns every ~9 m, floors every ~8.5 m, X bracing in the end bays.
    ctx.fillStyle = '#8f969c';
    for (let x = 0; x <= widthM; x += widthM / 12) ctx.fillRect(x * sx - 1, 0, 3, H);
    for (let y = 0; y <= 116; y += 8.5) ctx.fillRect(0, yy(y), W, 2);
    ctx.strokeStyle = '#7d848a';
    ctx.lineWidth = 1;
    for (const bay of [1, 10]) {
      const x0 = (bay * widthM) / 12;
      const x1 = ((bay + 1) * widthM) / 12;
      for (let y = 0; y < 116; y += 8.5) {
        ctx.beginPath();
        ctx.moveTo(x0 * sx, yy(y));
        ctx.lineTo(x1 * sx, yy(y + 8.5));
        ctx.moveTo(x1 * sx, yy(y));
        ctx.lineTo(x0 * sx, yy(y + 8.5));
        ctx.stroke();
      }
    }
    // Cladding rows.
    const cols = 24;
    for (let c = 0; c < cols; c++) {
      const top = 76 + Math.floor(r() * 3) * 8.5 + (r() < 0.25 ? 8.5 : 0);
      const x = (c * widthM) / cols;
      const t = 222 + Math.floor(r() * 12);
      ctx.fillStyle = `rgb(${t},${t + 2},${t + 2})`;
      ctx.fillRect(x * sx, yy(top), (widthM / cols) * sx + 1, top * sy);
    }
    ctx.fillStyle = 'rgba(30,34,38,0.22)';
    for (let y = 0; y < 100; y += 4.25) ctx.fillRect(0, yy(y), W, 1);
    // Roof truss line and parapet.
    ctx.fillStyle = '#a9aeb2';
    ctx.fillRect(0, 0, W, 3);
  });
  return color;
}

function parkingTexture() {
  // 3.4 m per deck, 8 m tile: slab band, dark open level with cars and lamps.
  const S = 64;
  const k = S / 8;
  const color = canvasTexture(S, S, (ctx) => {
    ctx.fillStyle = '#3a3c3e';
    ctx.fillRect(0, 0, S, S);
    for (let y = 0; y < S; y += 3.4 * k) {
      ctx.fillStyle = '#d4d6d4';
      ctx.fillRect(0, y, S, 1.0 * k);
      for (let x = 0; x < S; x += 2.6 * k) {
        const c = ['#9aa0a6', '#2b2d30', '#e6e6e2', '#7b2b25', '#45556a'][Math.floor(rand() * 5)];
        ctx.fillStyle = c;
        ctx.fillRect(x + 2, y + 1.0 * k + 6, 2.2 * k, 1.2 * k);
      }
    }
    ctx.fillStyle = '#c7c9c8';
    for (let x = 0; x < S; x += 8 * k) ctx.fillRect(x, 0, 0.5 * k, S);
  });
  const emissive = canvasTexture(S, S, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    ctx.fillStyle = '#ffdcae';
    for (let y = 0; y < S; y += 3.4 * k) for (let x = 2; x < S; x += 2 * k) ctx.fillRect(x, y + 1.0 * k + 1, 3, 2);
  });
  return { color, emissive };
}

function glowSpriteTexture() {
  const tex = canvasTexture(
    64,
    64,
    (ctx) => {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,240,215,1)');
      g.addColorStop(0.18, 'rgba(255,205,140,0.55)');
      g.addColorStop(1, 'rgba(255,170,90,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    },
    false,
  );
  return tex;
}

// ---------------------------------------------------------------- vehicles & cranes

/** Offset of the section being built, applied by `placed` and `M`. */
const section = new THREE.Matrix4();

function placed(x: number, y: number, z: number, ry = 0, rz = 0, sx = 1) {
  return section.clone().multiply(
    new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz, 'YZX')),
      new THREE.Vector3(sx, 1, sx),
    ),
  );
}

function nosecone(r: number, h: number, seg = 28) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    pts.push(new THREE.Vector2(Math.max(0.05, r * Math.sqrt(1 - t * t) * (1 - 0.12 * t)), t * h));
  }
  return new THREE.LatheGeometry(pts, seg);
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Square-section bar from a to b in the frame `base`, closed on every side. */
function beam(m: Mesher, base: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3, t: number) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir.divideScalar(len));
  const at = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  m.at(base.clone().multiply(at)).box(-t / 2, t / 2, -len / 2, len / 2, -t / 2, t / 2, 4, true);
}

/**
 * Lattice truss along local +y from 0 to `len`, `w` × `d` in section: four corner chords, a ring of
 * horizontals every panel and a zigzag diagonal on each face.
 */
function truss(m: Mesher, base: THREE.Matrix4, len: number, w: number, d: number, panel: number, chord: number, brace: number) {
  const x = w / 2 - chord / 2;
  const z = d / 2 - chord / 2;
  for (const [cx, cz] of [[-x, -z], [x, -z], [x, z], [-x, z]]) m.at(base).box(cx - chord / 2, cx + chord / 2, 0, len, cz - chord / 2, cz + chord / 2, 4, true);
  const n = Math.max(1, Math.round(len / panel));
  const P = (px: number, py: number, pz: number) => new THREE.Vector3(px, py, pz);
  for (let i = 0; i <= n; i++) {
    const y = (i / n) * len;
    beam(m, base, P(-x, y, -z), P(x, y, -z), brace);
    beam(m, base, P(-x, y, z), P(x, y, z), brace);
    beam(m, base, P(-x, y, -z), P(-x, y, z), brace);
    beam(m, base, P(x, y, -z), P(x, y, z), brace);
    if (i === n) break;
    const y1 = ((i + 1) / n) * len;
    const f = i % 2 ? 1 : -1;
    beam(m, base, P(-x * f, y, -z), P(x * f, y1, -z), brace);
    beam(m, base, P(x * f, y, z), P(-x * f, y1, z), brace);
    beam(m, base, P(-x, y, -z * f), P(-x, y1, z * f), brace);
    beam(m, base, P(x, y, z * f), P(x, y1, -z * f), brace);
  }
}

/** Frame turned so a truss built along +y runs along +x (`sign` 1) or −x (−1), starting at (x, y). */
const alongX = (base: THREE.Matrix4, x: number, y: number, sign: 1 | -1) =>
  base.clone().multiply(new THREE.Matrix4().makeTranslation(x, y, 0)).multiply(new THREE.Matrix4().makeRotationZ(-sign * Math.PI / 2));

/**
 * Flat-top tower crane: lattice mast, slewing unit with the operator's cab, lattice jib with a
 * trolley and hook, and a counter-jib carrying stacked concrete ballast.
 */
function towerCrane(lattice: Mesher, dark: Mesher, glass: Mesher, x: number, z: number, h: number, yaw: number, jib: number) {
  const base = placed(x, 0, z, yaw);
  truss(lattice, base, h, 2.4, 2.4, 2.4, 0.26, 0.11);
  // Slewing unit: ring, turntable and the A-frame cap the jibs hang off.
  dark.at(base.clone().multiply(new THREE.Matrix4().makeTranslation(0, h + 0.3, 0))).geo(new THREE.CylinderGeometry(1.6, 1.6, 0.6, 24));
  lattice.at(base).box(-1.6, 1.6, h + 0.6, h + 2.0, -1.4, 1.4, 4, true);
  // Cab beside the slewing unit, glazed on the front, the outer side and the floor.
  dark.at(base).box(1.4, 3.6, h - 0.4, h + 2.2, 1.1, 3.1, 4, true);
  glass.at(base).box(3.6, 3.85, h - 0.3, h + 2.1, 1.2, 3.0, 4, true);
  glass.box(1.6, 3.6, h - 0.3, h + 2.0, 3.1, 3.16, 4);
  lattice.at(base).box(3.6, 3.9, h + 2.1, h + 2.3, 1.1, 3.1, 4, true);
  const top = h + 2.0;
  truss(lattice, alongX(base, 1.6, top + 0.9, 1), jib - 1.6, 1.8, 1.7, 2.6, 0.18, 0.08);
  truss(lattice, alongX(base, -1.6, top + 0.7, -1), 22.4, 1.4, 2.6, 2.8, 0.18, 0.08);
  // Walkway deck along the counter-jib and the ballast blocks at its tail.
  dark.at(base).box(-24, -1.6, top - 0.05, top + 0.05, -1.5, 1.5, 4, true);
  for (let k = 0; k < 5; k++) {
    const x0 = -23.6 + k * 1.3;
    dark.box(x0, x0 + 1.15, top - 3.8, top - 0.05, -1.4, 1.4, 4, true);
  }
  // Hoist winch and electrics on the counter-jib.
  dark.box(-12, -8.5, top + 0.05, top + 1.6, -1.1, 1.1, 4, true);
  // Trolley under the jib.
  const tx = jib * 0.55;
  dark.box(tx - 1, tx + 1, top - 0.4, top, -1, 1, 4, true);
  hookBlock(dark, base, tx, top - 0.4, h * 0.45);
}

/** Crane hook block hanging on two falls: sheave housing, side plates, swivel and hook. */
function hookBlock(m: Mesher, base: THREE.Matrix4, x: number, top: number, y: number) {
  for (const dz of [-0.32, 0.32]) m.at(base).box(x - 0.035, x + 0.035, y + 1.5, top, dz - 0.035, dz + 0.035, 4);
  m.at(base.clone().multiply(new THREE.Matrix4().makeTranslation(x, y + 1.25, 0)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))).geo(
    new THREE.CylinderGeometry(0.62, 0.62, 0.95, 20),
  );
  m.at(base).box(x - 0.7, x + 0.7, y + 0.35, y + 1.25, -0.34, 0.34, 4);
  m.box(x - 0.42, x + 0.42, y + 0.1, y + 0.35, -0.22, 0.22, 4);
  m.at(base.clone().multiply(new THREE.Matrix4().makeTranslation(x, y - 0.15, 0))).geo(new THREE.CylinderGeometry(0.12, 0.16, 0.5, 10));
  const hook = new THREE.TorusGeometry(0.34, 0.1, 8, 18, Math.PI * 1.45);
  hook.rotateZ(Math.PI * 0.55);
  m.at(base.clone().multiply(new THREE.Matrix4().makeTranslation(x, y - 0.68, 0))).geo(hook);
}

/** Liebherr LR 11000-style crawler: tracks, superstructure, luffing lattice main boom and derrick. */
function crawlerCrane(lattice: Mesher, dark: Mesher, glass: Mesher, x: number, z: number, yaw: number) {
  const base = placed(x, 0, z, yaw);
  dark.at(base).box(-9, 9, 0, 2.6, -7, -3.6, 4, true);
  dark.box(-9, 9, 0, 2.6, 3.6, 7, 4, true);
  // Track shoes and drive sprockets.
  for (const [z0, z1] of [[-7, -3.6], [3.6, 7]]) {
    for (let k = -8.6; k < 8.6; k += 0.9) dark.box(k, k + 0.6, -0.02, 2.66, z0 - 0.08, z1 + 0.08, 4);
    for (const sx of [-9, 9]) dark.at(base.clone().multiply(new THREE.Matrix4().makeTranslation(sx, 1.3, (z0 + z1) / 2)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))).geo(new THREE.CylinderGeometry(1.3, 1.3, z1 - z0, 16));
    dark.at(base);
  }
  dark.box(-3, 3, 2.6, 3.4, -3.6, 3.6, 4, true);
  dark.box(-7, 6, 3.4, 7.5, -5, 5, 4, true);
  // Cab on the left front, counterweight stack at the back.
  lattice.at(base).box(3.5, 6.5, 3.4, 6.6, -5.9, -4.1, 4, true);
  glass.at(base).box(6.5, 6.6, 3.9, 6.4, -5.8, -4.2, 4);
  glass.box(3.7, 6.3, 3.9, 6.4, -5.96, -5.9, 4);
  for (let k = 0; k < 4; k++) dark.box(-15, -7.5, 2.6 + k * 2.05, 4.5 + k * 2.05, -5.5, 5.5, 4, true);
  const boom = 112;
  const tilt = 0.32;
  truss(lattice, base.clone().multiply(placed(4, 6, 0, 0, -tilt)), boom, 3.2, 4.4, 4.4, 0.34, 0.14);
  // Derrick mast leaning back.
  const derrick = 34;
  truss(lattice, base.clone().multiply(placed(-4, 7, 0, 0, 0.55)), derrick, 2.4, 3.2, 3.4, 0.28, 0.12);
  const tipX = 4 + Math.sin(tilt) * boom;
  const tipY = 6 + Math.cos(tilt) * boom;
  const dTip = new THREE.Vector3(-4 - Math.sin(0.55) * derrick, 7 + Math.cos(0.55) * derrick, 0);
  // Pendants from the derrick head to the boom tip and back down to the ballast.
  for (const dz of [-1.2, 1.2]) {
    beam(dark, base, dTip.clone().setZ(dz), new THREE.Vector3(tipX, tipY, dz * 1.4), 0.12);
    beam(dark, base, dTip.clone().setZ(dz), new THREE.Vector3(-14, 10.6, dz * 2.5), 0.12);
  }
  hookBlock(dark, base, tipX, tipY, tipY * 0.38);
}

/** Ribbed steel wall panel, 6 m wide × 3.2 m: a deep rib every 0.3 m with a soft highlight. */
function wallPanelTexture() {
  return canvasTexture(240, 128, (ctx) => {
    ctx.fillStyle = '#4a4e52';
    ctx.fillRect(0, 0, 240, 128);
    for (let x = 0; x < 240; x += 12) {
      ctx.fillStyle = 'rgba(0,0,0,0.38)';
      ctx.fillRect(x, 0, 3, 128);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x + 3, 0, 2, 128);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, 240, 2);
    ctx.fillRect(238, 0, 2, 128);
  });
}

/**
 * Head of a Starbase-style flood light mast, facing +x, origin at the pole top: cap, bracket arm, a two-row crossbar frame and six angled flood
 * fixtures (housing, yoke, fins, visor) whose lenses are a separate emissive geometry, and the cable
 * drop into a junction box.
 */
function floodMast() {
  const head = new Mesher();
  const lens = new Mesher();
  const I = new THREE.Matrix4();
  head.at(I).geo(new THREE.CylinderGeometry(0.42, 0.42, 0.14, 12).translate(0, 0.07, 0));
  head.at(I).geo(new THREE.ConeGeometry(0.26, 0.4, 10).translate(0, 0.34, 0));
  // Junction box and cable loop under the head.
  head.at(I).box(-0.55, -0.25, -2.2, -1.4, -0.22, 0.22, 4, true);
  for (const dz of [-0.12, 0.12]) beam(head, I, new THREE.Vector3(-0.3, -1.4, dz), new THREE.Vector3(0.55, -0.15, dz * 8), 0.05);
  // Bracket arm out to the frame.
  head.at(I).box(0, 0.62, -0.25, -0.05, -0.12, 0.12, 4, true);
  beam(head, I, new THREE.Vector3(0.05, -1.1, 0), new THREE.Vector3(0.6, -0.25, 0), 0.1);
  const FX = 0.6;
  const rows = [-0.15, 0.85];
  for (const y of rows) head.box(FX, FX + 0.12, y - 0.06, y + 0.06, -2.15, 2.15, 4, true);
  for (const z of [-2.15, 0, 2.15]) head.box(FX, FX + 0.12, rows[0] - 0.06, rows[1] + 0.06, z - 0.06, z + 0.06, 4, true);
  for (const y of rows) {
    for (const z of [-1.45, 0, 1.45]) {
      // Aimed down at the lot and fanned outward.
      const tilt = -0.42;
      const fan = z * -0.12;
      const fixture = new THREE.Matrix4().compose(
        new THREE.Vector3(FX + 0.42, y + 0.18, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, fan, tilt, 'YZX')),
        new THREE.Vector3(1, 1, 1),
      );
      head.at(I).box(FX + 0.12, FX + 0.3, y - 0.03, y + 0.03, z - 0.04, z + 0.04, 4, true);
      head.at(fixture).box(-0.2, 0.18, -0.28, 0.28, -0.5, 0.5, 4, true);
      // Cooling fins on the back and a visor over the lens.
      for (let k = -2; k <= 2; k++) head.box(-0.3, -0.2, -0.24, 0.24, k * 0.2 - 0.02, k * 0.2 + 0.02, 4);
      head.box(0.18, 0.36, 0.26, 0.3, -0.5, 0.5, 4, true);
      lens.at(fixture).wall(0.185, 0.46, 0.185, -0.46, -0.24, 0.24, 1, 1);
    }
  }
  const geo = (m: Mesher) => m.mesh(new THREE.MeshBasicMaterial()).geometry;
  return { head: geo(head), lens: geo(lens) };
}

function starbaseLetters() {
  const c = document.createElement('canvas');
  c.width = 4096;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.scale(2, 2);
  ctx.fillStyle = '#fff';
  ctx.font = '700 118px "Helvetica Neue", Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const text = 'STARBASE';
  for (let i = 0; i < text.length; i++) ctx.fillText(text[i], ((i + 0.5) / text.length) * 2048, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------- builder

export type BuildSite = THREE.Group & {
  /** 0 = lights off, 1 = full dusk/night lighting. */
  setGlow(k: number): void;
};

export type BuildSiteOptions = {
  /** World position of the site origin (front facade, center). Defaults to slightly inside the real distance. */
  position?: THREE.Vector3;
  rotationY?: number;
  glow?: number;
  /** Extra distance haze; 0 for close inspection. */
  haze?: number;
};

/**
 * Default placement: on the north side of Highway 4 with the fence 26 m from the road centerline, as
 * on the real road, but ~2.4 km from the pad instead of ~3.3 km so the bays still read from the beach.
 */
export const SITE_ORIGIN = new THREE.Vector3(-2180, 0, 975);

export function buildBuildSite(opts: BuildSiteOptions = {}): BuildSite {
  const g = new THREE.Group() as BuildSite;
  const glows: Glow[] = [];
  if (opts.haze !== undefined) HAZE.uHazeMax.value = opts.haze;

  const std = (p: THREE.MeshStandardMaterialParameters, glow = 0, occlude = false) => {
    const m = hazed(new THREE.MeshStandardMaterial(p));
    if (occlude && p.map) m.aoMap = aoFrom(p.map as THREE.CanvasTexture);
    if (glow > 0) {
      m.emissive = new THREE.Color(0xffc488);
      glows.push({ mat: m, base: glow });
    }
    return m;
  };
  const meshers = new Map<THREE.Material, Mesher>();
  const M = (mat: THREE.Material) => {
    let m = meshers.get(mat);
    if (!m) meshers.set(mat, (m = new Mesher()));
    return m.at(section.clone());
  };
  const placeSection = (x: number, z: number) => section.makeTranslation(x, 0, z);

  /** Floodlit walls at night: emissive follows the albedo so cladding glows and cavities stay dark. */
  const floodlit = (m: THREE.MeshStandardMaterial, base: number) => {
    m.emissiveMap = m.map;
    m.emissive = new THREE.Color(0xffe2bf);
    glows.push({ mat: m, base });
    return m;
  };
  // Facades stay matte: the low sun sits behind the beach viewpoint, so glossy walls facing the
  // camera would catch a retro-specular wash and lose all their dark detail.
  const claddingMat = floodlit(std({ map: claddingTexture(), roughness: 0.92 }), 0.06);
  const roofMat = std({ color: 0xb9bcbd, roughness: 0.95 });
  const darkMat = std({ color: 0x3b3e42, roughness: 0.85, metalness: 0.2 });
  const steelMat = std({ color: 0xcfd3d7, roughness: 0.32, metalness: 0.85 });
  const concreteMat = std({ color: 0xa8a49b, roughness: 0.95 });
  const cabGlass = std({ color: 0x1a232b, roughness: 0.12, metalness: 0.7 });

  // Local frame: +x points at Highway 4 (the fence line is x = 0, the road centerline x = +26) and
  // +z runs west along it. West to east a driver passes the STARBASE letters on the fence, the rocket
  // garden, Mega Bay 2, Mega Bay 1, the Gigabay and the 300 m Starfactory front.

  // --- Starfactory: three roof heights along a 300 m front, offices at its east end.
  placeSection(-70, -145);
  const front = starfactoryFront();
  const frontMat = std({ map: front.color, emissiveMap: front.emissive, roughness: 0.82 }, 1.6, true);
  const sections: [number, number, number][] = [[-130, -40, 27], [-40, 70, 22], [70, 170, 31]];
  const backX = -165;
  for (const [z0, z1, h] of sections) {
    const fm = M(frontMat);
    fm.wall(0, z1, 0, z0, 0, h, 300, 33, 170 - z1);
    const cm = M(claddingMat);
    cm.wall(backX, z0, backX, z1, 0, h, 32, 32);
    M(roofMat).flat(backX, 0, z0, z1, h, 16);
  }
  const cm = M(claddingMat);
  cm.wall(0, -130, backX, -130, 0, 27, 32, 32);
  cm.wall(backX, 170, 0, 170, 0, 31, 32, 32);
  // Steps between roof heights face the taller side's neighbor.
  cm.wall(backX, -40, 0, -40, 22, 27, 32, 32);
  cm.wall(0, 70, backX, 70, 22, 31, 32, 32);
  // Rooftop air handlers and ducts.
  const units = M(darkMat);
  for (const [z0, z1, h] of sections) {
    for (let i = 0; i < 26; i++) {
      const x = backX + 12 + rand() * (Math.abs(backX) - 30);
      const z = z0 + 6 + rand() * (z1 - z0 - 12);
      units.box(x, x + 4 + rand() * 4, h, h + 2.6 + rand() * 1.5, z, z + 3 + rand() * 3, 4);
    }
  }
  const ac = M(steelMat);
  for (const [z0, z1, h] of sections) ac.box(-120, -20, h, h + 1.6, (z0 + z1) / 2 - 1, (z0 + z1) / 2 + 1, 4);

  // Office block (black glass, launch control on top) with the illuminated X.
  const office = officeTexture();
  const officeMat = std({ map: office.color, emissiveMap: office.emissive, roughness: 0.6, metalness: 0.1 }, 0.8, true);
  const om = M(officeMat);
  om.wall(18, -78, 18, -130, 0, 26, 32, 32);
  om.wall(18, -130, 0, -130, 0, 26, 32, 32);
  om.wall(0, -78, 18, -78, 0, 26, 32, 32);
  M(roofMat).flat(0, 18, -130, -78, 26, 16);
  M(darkMat).box(2, 14, 26, 29, -120, -96, 4);
  const xs = xSignTexture();
  const xMat = std({ map: xs.color, emissiveMap: xs.emissive, roughness: 0.8 }, 2.4);
  // Decal on the glass: polygon offset instead of a physical gap, which would z-fight at 3 km.
  Object.assign(xMat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
  M(xMat).wall(18, -91, 18, -105, 9, 23, 14, 14, 0, 9);

  // --- Mega Bays 1 and 2 west of the Gigabay; doors face the road.
  placeSection(0, 0);
  const bays: [number, number, number, number][] = [
    [175, 1, 30, 0], // MB1 (boosters), door partly open
    [227, 2, 0, 0.35], // MB2 (ships), twice the windows
  ];
  for (const [z0, rows, open] of bays) {
    const z1 = z0 + 38;
    const x1 = -120;
    const x0 = x1 - 54;
    const face = megaBayFace(rows, open);
    const bayMat = std({ map: face.color, emissiveMap: face.emissive, roughness: 0.92 }, 1.4, true);
    M(bayMat).wall(x1, z1, x1, z0, 0, 99, 38, 99);
    const c = M(claddingMat);
    c.wall(x0, z0, x0, z1, 0, 99, 32, 32);
    c.wall(x1, z0, x0, z0, 0, 99, 32, 32);
    c.wall(x0, z1, x1, z1, 0, 99, 32, 32);
    M(roofMat).flat(x0, x1, z0, z1, 99, 16);
    // Exterior bracing columns proud of the long walls.
    const d = M(claddingMat);
    for (let x = x0 + 9; x < x1; x += 12) {
      d.box(x - 1.5, x + 1.5, 0, 99.5, z0 - 3, z0, 4);
      d.box(x - 1.5, x + 1.5, 0, 99.5, z1, z1 + 3, 4);
    }
    M(darkMat).box(x0 + 8, x0 + 22, 99, 103, z0 + 8, z1 - 8, 4);
  }

  // --- Gigabay: 110 × 130 × 116 m, cladding most of the way up, frame and cranes still on top.
  placeSection(90, 80);
  {
    const x1 = -200;
    const x0 = x1 - 110;
    const z0 = -52;
    const z1 = z0 + 130;
    const eastMat = floodlit(std({ map: gigabayFace(130, 11), roughness: 0.92 }, 0, true), 0.06);
    const sideMat = floodlit(std({ map: gigabayFace(110, 23), roughness: 0.92 }, 0, true), 0.06);
    M(eastMat).wall(x1, z1, x1, z0, 0, 116, 130, 116);
    M(eastMat).wall(x0, z0, x0, z1, 0, 116, 130, 116);
    M(sideMat).wall(x1, z0, x0, z0, 0, 116, 110, 116);
    M(sideMat).wall(x0, z1, x1, z1, 0, 116, 110, 116);
    M(roofMat).flat(x0, x1, z0, z1, 116, 16);
    M(darkMat).box(x0 + 30, x1 - 30, 116, 122, z0 + 20, z1 - 20, 4);
    const lat = M(std({ color: 0xc8401e, roughness: 0.6, metalness: 0.1 }));
    const dk = new Mesher();
    const gl = M(cabGlass);
    towerCrane(lat, dk, gl, x1 + 8, z0 - 8, 152, 2.4, 68);
    towerCrane(lat, dk, gl, x1 + 8, z1 + 8, 146, -2.0, 62);
    towerCrane(lat, dk, gl, x0 - 8, z0 - 8, 158, 0.9, 70);
    towerCrane(lat, dk, gl, x0 - 8, z1 + 8, 141, -0.6, 66);
    meshers.set(darkMat, merge(meshers.get(darkMat), dk));
  }

  // --- Parking garage behind the Gigabay.
  placeSection(-210, -144);
  {
    const p = parkingTexture();
    const pm = std({ map: p.color, emissiveMap: p.emissive, roughness: 0.9 }, 1.0, true);
    const x1 = -20;
    const x0 = -120;
    const z0 = 182;
    const z1 = 238;
    const m = M(pm);
    m.wall(x1, z1, x1, z0, 0, 17, 8, 8);
    m.wall(x0, z1 - 56, x0, z1, 0, 17, 8, 8);
    m.wall(x1, z0, x0, z0, 0, 17, 8, 8);
    m.wall(x0, z1, x1, z1, 0, 17, 8, 8);
    M(concreteMat).flat(x0, x1, z0, z1, 17, 16);
    M(darkMat).box(x1 - 14, x1 - 2, 17, 21, z0 + 4, z0 + 12, 4);
  }

  // --- Rocket garden and ring yard behind the STARBASE letters.
  placeSection(-150, 260);
  {
    // The same Super Heavy and Ship models as on the pad, cloned onto display stands.
    const proto = buildStack(null);
    const shipProto = proto.getObjectByName('ship')!;
    proto.remove(shipProto);
    shipProto.position.set(0, 0, 0);
    for (const o of [proto, shipProto]) {
      o.traverse((c) => {
        const mat = (c as THREE.Mesh).material as THREE.Material | undefined;
        if (mat) hazed(mat);
      });
    }
    const R = 4.5;
    const show = (obj: THREE.Object3D, x: number, y: number, z: number, yaw: number) => {
      const c = obj.clone();
      c.applyMatrix4(placed(x, y, z, yaw));
      g.add(c);
    };
    const booster = (x: number, z: number, yaw: number) => {
      M(darkMat).box(x - 7, x + 7, 0, 6, z - 7, z + 7, 4);
      show(proto, x, 6.5, z, yaw);
    };
    const ship = (x: number, z: number, yaw: number, stand: number) => {
      M(darkMat).box(x - 6, x + 6, 0, stand, z - 6, z + 6, 4);
      show(shipProto, x, stand, z, yaw);
    };
    booster(72, -50, 0.4);
    booster(78, -22, 1.3);
    ship(70, 8, 0.6, 7);
    ship(84, 32, -2.4, 12);
    // Ring stacks and a nosecone waiting outside.
    for (let i = 0; i < 9; i++) {
      const x = 38 + (i % 3) * 12;
      const z = 52 + Math.floor(i / 3) * 12;
      const h = 4 + Math.floor(rand() * 3) * 2;
      M(steelMat).at(placed(x, h / 2, z)).geo(new THREE.CylinderGeometry(R, R, h, 48, 1, false));
    }
    M(steelMat).at(placed(46, 0.1, -80, 0.3)).geo(nosecone(R, 18, 48));
    M(steelMat).at(placed(34, 0.1, -80, 1.9)).geo(nosecone(R, 18, 48));
  }

  const cranes = new Mesher();
  const craneDark = new Mesher();
  crawlerCrane(cranes, craneDark, M(cabGlass), 112, -6, Math.PI - 0.15);
  meshers.set(darkMat, merge(meshers.get(darkMat), craneDark));
  meshers.set(std({ color: 0xe0a820, roughness: 0.6, metalness: 0.1 }), cranes);

  // --- Concrete aprons, surface lot with cars, flood light masts.
  placeSection(0, 0);
  M(concreteMat).box(-128, -4, 0, 0.35, -300, 300, 16);
  M(concreteMat).box(-140, -20, 0, 0.3, 250, 360, 16);
  M(concreteMat).box(-345, -235, 0, 0.35, -300, 155, 16);
  const lights: number[] = [];
  const masts: [number, number, number][] = [];
  const mast = (x: number, z: number, h: number) => {
    masts.push([x, z, h]);
    lights.push(x + 1.4, h + 0.3, z);
  };
  for (let z = -280; z <= 220; z += 40) mast(-8, z, 30);
  for (let z = 260; z <= 352; z += 46) mast(-14, z, 30);
  for (let z = -280; z <= 160; z += 52) mast(-250, z, 34);
  mast(-340, 185, 40);
  mast(-340, -290, 40);
  const lampMat = std({ color: 0xfff1dc, roughness: 0.3 }, 3);
  const lensMat = std({ color: 0xb8ae9c, roughness: 0.18, metalness: 0.2 }, 1.6);
  const floods = floodMast();
  const poles = M(std({ color: 0x9aa0a4, roughness: 0.55, metalness: 0.55 }));
  for (const [x, z, h] of masts) {
    // Galvanized taper in two sections with a slip-joint collar, on a base plate and concrete plinth.
    poles.at(placed(x, 0, z)).geo(new THREE.CylinderGeometry(0.2, 0.36, h, 16).translate(0, h / 2, 0));
    poles.geo(new THREE.CylinderGeometry(0.33, 0.33, 0.5, 16).translate(0, h * 0.45, 0));
    poles.box(-0.62, 0.62, 0.9, 0.98, -0.62, 0.62, 4);
    poles.box(-0.38, -0.3, 0, h - 1.4, -0.05, 0.05, 4);
    M(concreteMat).at(placed(x, 0, z)).geo(new THREE.CylinderGeometry(0.75, 0.8, 0.9, 16).translate(0, 0.45, 0));
  }
  const mastMeshes = [
    new THREE.InstancedMesh(floods.head, std({ color: 0x5d6266, roughness: 0.5, metalness: 0.6 }), masts.length),
    new THREE.InstancedMesh(floods.lens, lensMat, masts.length),
  ];
  {
    const at = new THREE.Matrix4();
    masts.forEach(([x, z, h], i) => {
      at.makeTranslation(x, h, z);
      for (const m of mastMeshes) m.setMatrixAt(i, at);
    });
  }

  const carGeo = new THREE.BoxGeometry(4.6, 1.5, 1.9);
  carGeo.translate(0, 1.1, 0);
  const cars = new THREE.InstancedMesh(carGeo, std({ roughness: 0.4, metalness: 0.5 }), 320);
  const tmp = new THREE.Object3D();
  const palette = [0xe9e9e6, 0x1d1f22, 0x8c9196, 0xbfc3c6, 0x6e2a24, 0x2e4058, 0x4e5257].map((h) => new THREE.Color(h));
  let n = 0;
  for (let row = 0; row < 9 && n < 320; row++) {
    for (let k = 0; k < 40 && n < 320; k++) {
      if (rand() < 0.22) continue;
      tmp.position.set(-66 + row * 6.5 + (row % 2) * 0.6, 0.35, -262 + k * 2.6);
      tmp.rotation.y = Math.PI / 2 + (rand() - 0.5) * 0.08;
      tmp.updateMatrix();
      cars.setMatrixAt(n, tmp.matrix);
      cars.setColorAt(n, palette[Math.floor(rand() * palette.length)]);
      n++;
    }
  }
  cars.count = n;
  g.add(cars);

  // --- Roadside wall: ribbed steel panels between H-section pilasters with a cap rail. The 2.5 m
  // illuminated STARBASE letters stand free in front of it on a bed of rock, lit from below.
  const wallMat = std({ map: wallPanelTexture(), roughness: 0.7, metalness: 0.35 });
  const WALL_H = 3.2;
  const wall = M(wallMat);
  wall.wall(0, 470, 0, -330, 0, WALL_H, 6, WALL_H);
  wall.wall(-0.12, -330, -0.12, 470, 0, WALL_H, 6, WALL_H);
  const steelDark = M(std({ color: 0x2a2d31, roughness: 0.45, metalness: 0.7 }));
  for (let z = -330; z <= 470; z += 6) {
    steelDark.box(-0.2, 0.14, 0, WALL_H + 0.25, z - 0.17, z - 0.11, 4);
    steelDark.box(-0.2, 0.14, 0, WALL_H + 0.25, z + 0.11, z + 0.17, 4);
    steelDark.box(-0.05, 0.0, 0, WALL_H + 0.25, z - 0.11, z + 0.11, 4);
  }
  steelDark.box(-0.22, 0.16, WALL_H, WALL_H + 0.12, -330, 470, 6);
  M(concreteMat).box(-0.3, 0.25, 0, 0.3, -330, 470, 6);
  // Rock bed along the frontage under the letters.
  const rockMat = std({ color: 0xa79d8c, roughness: 1 });
  M(rockMat).box(1.2, 8.5, 0, 0.18, 250, 316, 4);
  const rocks = M(rockMat);
  for (let i = 0; i < 140; i++) {
    const r = 0.18 + rand() * 0.35;
    rocks.at(placed(1.4 + rand() * 7, 0.1, 251 + rand() * 64, rand() * 6)).geo(new THREE.DodecahedronGeometry(r, 0).scale(1, 0.6, 1));
  }
  const word = starbaseLetters();
  const wordMat = std({ map: word, emissiveMap: word, alphaTest: 0.5, roughness: 0.4, metalness: 0.3, emissive: 0xfff4e6, emissiveIntensity: 0.85 });
  // Stacked cut-outs give the letters 0.4 m of depth when seen at an angle from the road.
  const letters = M(wordMat);
  for (let k = 0; k < 9; k++) letters.wall(4.1 - k * 0.05, 306, 4.1 - k * 0.05, 260, 0.25, 3.05, 46, 2.8, 0, 0.25);
  const up = M(darkMat);
  for (let i = 0; i < 8; i++) {
    const z = 306 - (i + 0.5) * (46 / 8);
    up.box(5.3, 5.8, 0.15, 0.45, z - 0.35, z + 0.35, 4);
    M(lampMat).flat(5.36, 5.74, z - 0.29, z + 0.29, 0.46, 4);
  }

  for (const [mat, m] of meshers) {
    const mesh = m.mesh(mat);
    mesh.matrixAutoUpdate = false;
    g.add(mesh);
  }

  for (const m of mastMeshes) g.add(m);

  // Floodlight halos: additive points, sized in meters so they shrink with distance.
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
  const glowMat = new THREE.PointsMaterial({
    map: glowSpriteTexture(),
    size: 22,
    sizeAttenuation: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    color: 0xffd6a0,
    fog: false,
  });
  const halos = new THREE.Points(glowGeo, glowMat);
  g.add(halos);

  const dayHaze = HAZE.uHazeColor.value.clone();
  g.setGlow = (k: number) => {
    for (const { mat, base } of glows) mat.emissiveIntensity = base * k;
    // Glow is meant for dusk and night, when the haze darkens with the sky.
    HAZE.uHazeColor.value.copy(dayHaze).multiplyScalar(1 - 0.85 * THREE.MathUtils.smoothstep(k, 0.3, 1));
    glowMat.opacity = THREE.MathUtils.clamp((k - 0.15) * 1.2, 0, 1);
    halos.visible = glowMat.opacity > 0.01;
  };
  g.setGlow(opts.glow ?? 0.15);

  g.position.copy(opts.position ?? SITE_ORIGIN);
  g.rotation.y = opts.rotationY ?? -Math.PI / 2;
  return g;
}

function merge(a: Mesher | undefined, b: Mesher) {
  if (!a) return b;
  a.pos = a.pos.concat(b.pos);
  a.nor = a.nor.concat(b.nor);
  a.uv = a.uv.concat(b.uv);
  return a;
}
