import * as THREE from 'three';
import { BUILD_SITE } from './scenery';

// Starbase build site as of late 2026, seen ~3 km away from Boca Chica Beach.
// Local frame: +x is the Starfactory front (glass, black band, STARBASE sign), facing the beach;
// -z is north toward the Mega Bays. The Gigabay rises behind the factory on the old High Bay lot.
// Dimensions follow published figures: Mega Bays ~38 × 54 × 99 m, Gigabay ~110 × 130 × 116 m,
// Starfactory ~1M ft² over three roof heights, Super Heavy ~71 m and Ship ~52 m at 9 m diameter.

type Glow = { mat: THREE.MeshStandardMaterial; base: number };

const HAZE = {
  uHazeColor: { value: new THREE.Vector3(0.74, 0.78, 0.8) },
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

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
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

/** Super Heavy skin, wrapped once around: ring seams, chines, hot-stage ring at the top. */
function boosterTexture() {
  return canvasTexture(128, 512, (ctx) => {
    for (let y = 0; y < 512; y += 13) {
      const t = 176 + Math.floor(rand() * 34);
      ctx.fillStyle = `rgb(${t},${t + 3},${t + 6})`;
      ctx.fillRect(0, y, 128, 13);
      ctx.fillStyle = 'rgba(60,62,66,0.4)';
      ctx.fillRect(0, y, 128, 1);
    }
    ctx.fillStyle = '#5a5e63';
    ctx.fillRect(30, 40, 4, 440);
    ctx.fillRect(94, 40, 4, 440);
    // Vented hot-staging ring.
    ctx.fillStyle = '#22252a';
    ctx.fillRect(0, 0, 128, 18);
    ctx.fillStyle = '#9da2a7';
    for (let x = 2; x < 128; x += 6) ctx.fillRect(x, 3, 2, 12);
    // Aft skirt.
    ctx.fillStyle = '#3d4145';
    ctx.fillRect(0, 498, 128, 14);
  });
}

/** Ship skin: hex-tile heat shield on the windward half, bare steel on the lee side. */
function shipTexture() {
  return canvasTexture(128, 256, (ctx) => {
    for (let y = 0; y < 256; y += 10) {
      const t = 180 + Math.floor(rand() * 30);
      ctx.fillStyle = `rgb(${t},${t + 3},${t + 6})`;
      ctx.fillRect(0, y, 128, 10);
    }
    ctx.fillStyle = '#17181a';
    ctx.fillRect(0, 0, 60, 256);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    for (let y = 0; y < 256; y += 3) for (let x = (y / 3) % 2 ? 0 : 1.5; x < 60; x += 3) ctx.fillRect(x, y, 1, 1);
    // A few white replacement tiles.
    ctx.fillStyle = '#d8d8d4';
    for (let i = 0; i < 18; i++) ctx.fillRect(Math.floor(rand() * 58), Math.floor(rand() * 254), 2, 2);
  });
}

function latticeTexture(color: string) {
  return canvasTexture(32, 32, (ctx) => {
    ctx.fillStyle = '#4c4038';
    ctx.fillRect(0, 0, 32, 32);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(2, -4, 28, 40);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(32, 32);
    ctx.moveTo(32, 0);
    ctx.lineTo(0, 32);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 32, 3);
  });
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

const Y = new THREE.Vector3(0, 1, 0);

function placed(x: number, y: number, z: number, ry = 0, rz = 0, sx = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz, 'YZX')),
    new THREE.Vector3(sx, 1, sx),
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

/** Flat-top tower crane: lattice mast, slewing jib and counter-jib with ballast. */
function towerCrane(lattice: Mesher, dark: Mesher, x: number, z: number, h: number, yaw: number, jib: number) {
  lattice.at(placed(x, 0, z, yaw)).box(-1.3, 1.3, 0, h, -1.3, 1.3, 2.6);
  lattice.box(-1.2, jib, h, h + 3.2, -1.1, 1.1, 3.2);
  lattice.box(-24, -1.2, h, h + 2.6, -1.4, 1.4, 3.2);
  dark.at(placed(x, 0, z, yaw)).box(-22, -15, h - 3.5, h + 1, -1.8, 1.8, 4);
  dark.box(1.4, 4.6, h - 3.5, h + 0.2, -1.4, 1.4, 4);
  dark.box(jib * 0.55 - 1, jib * 0.55 + 1, h - 2, h, -1.2, 1.2, 4);
  // Hook block on a thin line.
  dark.box(jib * 0.55 - 0.15, jib * 0.55 + 0.15, h * 0.45, h - 2, -0.15, 0.15, 4);
  dark.box(jib * 0.55 - 1, jib * 0.55 + 1, h * 0.45 - 2, h * 0.45, -1, 1, 4);
}

/** Liebherr LR 11000-style crawler: tracks, superstructure, luffing lattice main boom. */
function crawlerCrane(lattice: Mesher, dark: Mesher, x: number, z: number, yaw: number) {
  dark.at(placed(x, 0, z, yaw)).box(-9, 9, 0, 2.6, -7, -3.6, 4);
  dark.box(-9, 9, 0, 2.6, 3.6, 7, 4);
  dark.box(-7, 6, 2.6, 7.5, -5, 5, 4);
  dark.box(-15, -7, 2.6, 10.5, -5.5, 5.5, 4);
  const boom = 112;
  const tilt = 0.32;
  lattice.at(placed(x, 0, z, yaw).multiply(placed(4, 6, 0, 0, -tilt))).box(-1.6, 1.6, 0, boom, -2.2, 2.2, 3.2);
  // Derrick mast leaning back.
  lattice.at(placed(x, 0, z, yaw).multiply(placed(-4, 7, 0, 0, 0.55))).box(-1.2, 1.2, 0, 34, -1.6, 1.6, 3.2);
  const tipX = 4 + Math.sin(tilt) * boom;
  const tipY = 6 + Math.cos(tilt) * boom;
  dark.at(placed(x, 0, z, yaw)).box(tipX - 0.15, tipX + 0.15, tipY * 0.38, tipY, -0.15, 0.15, 4);
  dark.box(tipX - 1.4, tipX + 1.4, tipY * 0.38 - 2.4, tipY * 0.38, -1.4, 1.4, 4);
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
 * Default placement: the real build site (BUILD_SITE) is ~3.3 km from the pad. It is pulled in to
 * ~2.3 km and swung 7.5° south around the pad, so from the beach the bays sit ~2.9 km out (about 1.3×
 * their true angular size) in the clear sky between the hero copy and the pad's tank farm.
 */
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
    return m.at(null);
  };

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

  // --- Starfactory: three roof heights along a 300 m front, offices in the northeast corner.
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

  // --- Mega Bays 1 and 2 behind the factory's north half; doors face the beach.
  const bays: [number, number, number, number][] = [
    [-105, 1, 30, 0], // MB1 (boosters), door partly open
    [-157, 2, 0, 0.35], // MB2 (ships), twice the windows
  ];
  for (const [z0, rows, open] of bays) {
    const z1 = z0 + 38;
    const x1 = -190;
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
    const lat = M(std({ map: latticeTexture('#e0532c'), roughness: 0.6 }));
    const dk = new Mesher();
    towerCrane(lat, dk, x1 + 8, z0 - 8, 152, 2.4, 68);
    towerCrane(lat, dk, x1 + 8, z1 + 8, 146, -2.0, 62);
    towerCrane(lat, dk, x0 - 8, z0 - 8, 158, 0.9, 70);
    towerCrane(lat, dk, x0 - 8, z1 + 8, 141, -0.6, 66);
    meshers.set(darkMat, merge(meshers.get(darkMat), dk));
  }

  // --- Parking garage south of the factory.
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

  // --- Rocket garden and ring yard in front of the factory.
  {
    const btex = boosterTexture();
    const stex = shipTexture();
    const boosterMat = std({ map: btex, roughness: 0.3, metalness: 0.85 });
    const shipMat = std({ map: stex, roughness: 0.38, metalness: 0.7 }, 0, true);
    const R = 4.5;
    const booster = (x: number, z: number, yaw: number) => {
      M(darkMat).box(x - 7, x + 7, 0, 6, z - 7, z + 7, 4);
      M(boosterMat).at(placed(x, 6 + 35.5, z, yaw)).geo(new THREE.CylinderGeometry(R, R, 71, 32, 1, false));
      const d = M(darkMat);
      for (let k = 0; k < 4; k++) {
        const a = yaw + Math.PI / 4 + (k * Math.PI) / 2;
        d.at(placed(x + Math.cos(a) * (R + 1.6), 0, z - Math.sin(a) * (R + 1.6), a)).box(-1.6, 1.6, 6 + 62, 6 + 68.5, -2.8, 2.8, 4);
      }
    };
    const ship = (x: number, z: number, yaw: number, stand: number) => {
      M(darkMat).box(x - 6, x + 6, 0, stand, z - 6, z + 6, 4);
      M(shipMat).at(placed(x, stand + 17, z, yaw)).geo(new THREE.CylinderGeometry(R, R, 34, 32, 1, true));
      M(shipMat).at(placed(x, stand + 34, z, yaw)).geo(nosecone(R, 18));
      const d = M(darkMat);
      // Flaps on the heat-shield side.
      for (const [y0, y1, w] of [[stand + 2, stand + 13, 3.2], [stand + 38, stand + 45, 2.2]] as const) {
        for (const side of [-1, 1]) {
          const a = yaw + Math.PI * 0.75 + side * 0.55;
          d.at(placed(x + Math.cos(a) * (R + w * 0.5), 0, z - Math.sin(a) * (R + w * 0.5), a)).box(-w * 0.5, w * 0.5, y0, y1, -0.35, 0.35, 4);
        }
      }
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
      M(steelMat).at(placed(x, h / 2, z)).geo(new THREE.CylinderGeometry(R, R, h, 24, 1, false));
    }
    M(steelMat).at(placed(46, 0.1, -80, 0.3)).geo(nosecone(R, 18, 24));
    M(steelMat).at(placed(34, 0.1, -80, 1.9)).geo(nosecone(R, 18, 24));
  }

  const cranes = new Mesher();
  const craneDark = new Mesher();
  crawlerCrane(cranes, craneDark, 112, -6, Math.PI - 0.15);
  meshers.set(darkMat, merge(meshers.get(darkMat), craneDark));
  meshers.set(std({ map: latticeTexture('#e8b62c'), roughness: 0.6 }), cranes);

  // --- Concrete aprons, surface lot with cars, flood light masts.
  M(concreteMat).box(-10, 125, 0, 0.35, -150, 175, 16);
  M(concreteMat).box(-340, -165, 0, 0.35, -175, 100, 16);
  const lights: number[] = [];
  const pole = M(std({ color: 0x9aa0a4, roughness: 0.6, metalness: 0.5 }));
  const lampMat = std({ color: 0xdedcd4, roughness: 0.4 }, 3);
  const lamp = new Mesher();
  const mast = (x: number, z: number, h: number) => {
    pole.box(x - 0.35, x + 0.35, 0, h, z - 0.35, z + 0.35, 4);
    lamp.box(x - 0.6, x + 0.9, h - 1.2, h + 0.4, z - 2, z + 2, 4);
    lights.push(x + 1.2, h - 0.2, z);
  };
  for (let z = -140; z <= 170; z += 38) mast(32, z, 30);
  for (let z = -120; z <= 150; z += 54) mast(122, z, 36);
  for (let z = -170; z <= 90; z += 52) mast(-172, z, 34);
  mast(-330, -170, 40);
  mast(-330, 90, 40);
  meshers.set(lampMat, lamp);

  const carGeo = new THREE.BoxGeometry(4.6, 1.5, 1.9);
  carGeo.translate(0, 1.1, 0);
  const cars = new THREE.InstancedMesh(carGeo, std({ roughness: 0.4, metalness: 0.5 }), 320);
  const tmp = new THREE.Object3D();
  const palette = [0xe9e9e6, 0x1d1f22, 0x8c9196, 0xbfc3c6, 0x6e2a24, 0x2e4058, 0x4e5257].map((h) => new THREE.Color(h));
  let n = 0;
  for (let row = 0; row < 10 && n < 320; row++) {
    for (let k = 0; k < 40 && n < 320; k++) {
      if (rand() < 0.22) continue;
      tmp.position.set(10 + row * 6.5 + (row % 2) * 0.6, 0.35, 76 + k * 2.6);
      tmp.rotation.y = Math.PI / 2 + (rand() - 0.5) * 0.08;
      tmp.updateMatrix();
      cars.setMatrixAt(n, tmp.matrix);
      cars.setColorAt(n, palette[Math.floor(rand() * palette.length)]);
      n++;
    }
  }
  cars.count = n;
  g.add(cars);

  for (const [mat, m] of meshers) {
    const mesh = m.mesh(mat);
    mesh.matrixAutoUpdate = false;
    g.add(mesh);
  }

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

  g.position.copy(opts.position ?? BUILD_SITE.clone().applyAxisAngle(Y, 0.13).multiplyScalar(0.675));
  g.rotation.y = opts.rotationY ?? -0.15;
  return g;
}

function merge(a: Mesher | undefined, b: Mesher) {
  if (!a) return b;
  a.pos.push(...b.pos);
  a.nor.push(...b.nor);
  a.uv.push(...b.uv);
  return a;
}
