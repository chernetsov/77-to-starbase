import * as THREE from 'three';
import { splitByNormal } from './procedural';
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

// SpaceX wordmark from Wikimedia Commons (SpaceX_logo_black.svg), viewBox 400 × 50. The letters sit
// in y 17.3–49.3; the swoosh rises to the top-right corner.
const SPACEX_LOGO = [
  'M37.5 30.5H10.9v-6.6h34.3c-.9-2.8-3.8-5.4-8.9-5.4H11.4c-5.7 0-9 2.1-9 6.7v4.9c0 4 3.4 6.3 8.4 6.3h26.9v7H1.5c.9 3.8 3.8 5.8 9 5.8h27.1c5.7 0 8.5-2.2 8.5-6.9v-4.9c0-4.3-3.3-6.6-8.6-6.9z',
  'M91.8 18.6H59v30.7h9.3V37.5h24.2c6.7 0 10.4-2.3 10.4-7.7v-3.4c-.1-5-4.3-7.8-11.1-7.8zm3 9.8c0 2.2-.4 3.4-4 3.4H68.3l.1-8h22c4 0 4.5 1.2 4.5 3.3v1.3z',
  'M129.9 17.3L124.3 24.2L133.8 37.3L114 37.3L109.1 42.5L137.7 42.5L142.6 49.3L153.6 49.3z',
  'M171.4 23.9h34.8c-.9-3.6-4.4-5.4-9.4-5.4h-26c-4.5 0-8.8 1.8-8.8 6.7v17.2c0 4.9 4.3 6.7 8.8 6.7h26.3c6 0 8.1-1.7 9.1-5.8h-34.8V23.9z',
  'M228.3 43.5L228.3 34.1L247 34.1L247 28.9L218.9 28.9L218.9 49.3L260.4 49.3L260.4 43.5zM219.9 18.6h41.9v5.4h-41.9z',
  'M287.6 18.6H273l17.2 12.6c2.5-1.7 5.4-3.5 8-5l-10.6-7.6zm21.2 15.7c-2.5 1.7-5 3.6-7.4 5.4l13 9.5h14.7l-20.3-14.9z',
  'M399 .7c-80 4.6-117 38.8-125.3 46.9l-1.7 1.6h14.8C326.8 9.1 384.3 2 399 .7z',
].join('');

function wordmark(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, h: number, w: number, color: string, logo: boolean) {
  ctx.save();
  ctx.fillStyle = color;
  if (logo) {
    // Fit inside w (full 400-unit width) and h (32-unit letter height), centered on (x, y).
    const k = Math.min(h / 32, w / 400);
    ctx.translate(x - 200 * k, y - 33.3 * k);
    ctx.scale(k, k);
    ctx.fill(new Path2D(SPACEX_LOGO));
  } else {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${h}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    const m = ctx.measureText(text).width;
    ctx.translate(x, y);
    ctx.scale(w / m, 1);
    ctx.fillText(text, 0, 0);
  }
  ctx.restore();
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
    wordmark(ctx, 'SPACEX', W / 2, yy(86.3 - (windowRows - 1) * 2), px(4.4), px(34), '#1b1e22', true);
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

/** Height of the Starfactory's glazed ground level, including the plinth and the trim above it. */
const GLASS_TOP = 13.4;
/** Repeat of the Starfactory glazing tile along the front, in meters (30 bays of 1.6 m). */
const GLASS_TILE = 48;

/**
 * Starfactory glazing, one 48 m × 13.4 m tile at 32 px/m: concrete plinth, two tiers of 1.6 m panes
 * between aluminum mullions and transoms, faint ceiling light strips behind the glass.
 */
function starfactoryGlass() {
  const k = 32 / TEX_SCALE;
  const W = GLASS_TILE * k;
  const H = GLASS_TOP * k;
  const yy = (m: number) => H - m * k;
  const tiers = [[1.5, 7.5], [7.5, 13]] as const;
  const shade: number[] = [];
  for (let i = 0; i < 60; i++) shade.push(0.85 + rand() * 0.3);
  const color = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#d9dcdc';
    ctx.fillRect(0, 0, W, H);
    tiers.forEach(([y0, y1], t) => {
      for (let c = 0; c < 30; c++) {
        const g = ctx.createLinearGradient(0, yy(y1), 0, yy(y0));
        const s = shade[t * 30 + c];
        g.addColorStop(0, `rgb(${58 * s},${72 * s},${86 * s})`);
        g.addColorStop(1, `rgb(${26 * s},${34 * s},${42 * s})`);
        ctx.fillStyle = g;
        ctx.fillRect(c * 1.6 * k, yy(y1), 1.6 * k, (y1 - y0) * k);
        // Ceiling light strip seen through the glass.
        ctx.fillStyle = 'rgba(210,205,190,0.18)';
        ctx.fillRect(c * 1.6 * k, yy(y1 - 0.5), 1.6 * k, 0.12 * k);
      }
    });
    ctx.fillStyle = '#9aa1a7';
    for (let c = 0; c <= 30; c++) ctx.fillRect(c * 1.6 * k - 0.05 * k, yy(13), 0.1 * k, 11.5 * k);
    for (const y of [1.5, 7.5, 13]) ctx.fillRect(0, yy(y + 0.07), W, 0.14 * k);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, yy(1.5), W, 0.06 * k);
    ctx.fillStyle = '#5b6066';
    ctx.fillRect(0, 0, W, 0.4 * k);
  });
  const emissive = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    for (let c = 0; c < 30; c++) {
      const lit = rand();
      for (const [y0, y1] of tiers) {
        const b = lit < 0.25 ? 40 : 110 + rand() * 120;
        ctx.fillStyle = `rgb(${b},${b * 0.84},${b * 0.6})`;
        ctx.fillRect(c * 1.6 * k + 0.06 * k, yy(y1), 1.48 * k, (y1 - y0) * k);
      }
    }
  });
  return { color, emissive };
}

/** Starfactory upper band, 300 m × 20 m above the glazing at ~13.6 px/m: black ribbed panels and the STARBASE lettering. */
function starfactoryBand() {
  const W = 1365;
  const H = 91;
  const sx = W / 300;
  const sy = H / 20;
  const yy = (m: number) => H - (m - GLASS_TOP) * sy;
  const color = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#141619';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = 0; x < 300; x += 0.9) ctx.fillRect(x * sx, 0, 0.6, H);
    wordmark(ctx, 'STARBASE', 50 * sx, yy(21), 8 * sy, 84 * sx, '#f1f1ee', false);
  });
  const emissive = canvasTexture(W, H, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    wordmark(ctx, 'STARBASE', 50 * sx, yy(21), 8 * sy, 84 * sx, '#ffffff', false);
  });
  return { color, emissive };
}

/** Roll-up bay door, 4 m tile: lift panels with a shadow line every 0.8 m and a darker bottom seal. */
function rollDoorTexture() {
  return canvasTexture(64, 64, (ctx) => {
    ctx.fillStyle = '#c4c8cb';
    ctx.fillRect(0, 0, 64, 64);
    for (let y = 0; y < 64; y += 12.8) {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(0, y, 64, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(0, y + 1, 64, 0.6);
    }
  });
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
 * Gigabay cladding, 116 m tall: white panels up to ~row 10 with a ragged leading edge. Everything
 * above is transparent (cut with alphaTest) so the real 3D steel frame and dark interior show.
 */
function gigabayFace(widthM: number, seed: number) {
  const W = 384;
  const H = 405;
  const sx = W / widthM;
  const sy = H / 116;
  const yy = (m: number) => H - m * sy;
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const color = canvasTexture(W, H, (ctx) => {
    const cols = 24;
    for (let c = 0; c < cols; c++) {
      const top = 76 + Math.floor(r() * 3) * 8.5 + (r() < 0.25 ? 8.5 : 0);
      const x = (c * widthM) / cols;
      const t = 222 + Math.floor(r() * 12);
      ctx.fillStyle = `rgb(${t},${t + 2},${t + 2})`;
      ctx.fillRect(x * sx, yy(top), (widthM / cols) * sx + 1, top * sy);
    }
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(30,34,38,0.22)';
    for (let y = 0; y < 100; y += 4.25) ctx.fillRect(0, yy(y), W, 1);
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

/**
 * Outline of one block letter of the roadside sign, 2.5 m cap height, 0.42 m strokes, origin at the
 * bottom left. Only the glyphs of STARBASE.
 */
function letterShape(ch: string): { shape: THREE.Shape; w: number } {
  const t = 0.42;
  const V = (x: number, y: number) => new THREE.Vector2(x, y);
  const poly = (pts: number[][]) => new THREE.Shape(pts.map(([x, y]) => V(x, y)));
  const hole = (pts: number[][]) => new THREE.Path(pts.map(([x, y]) => V(x, y)));
  if (ch === 'T') return { shape: poly([[0.7, 0], [1.12, 0], [1.12, 2.08], [1.82, 2.08], [1.82, 2.5], [0, 2.5], [0, 2.08], [0.7, 2.08]]), w: 1.82 };
  if (ch === 'E') return { shape: poly([[0, 0], [1.4, 0], [1.4, t], [t, t], [t, 1.04], [1.2, 1.04], [1.2, 1.46], [t, 1.46], [t, 2.08], [1.4, 2.08], [1.4, 2.5], [0, 2.5]]), w: 1.4 };
  if (ch === 'A') {
    const s = poly([[0, 0], [0.46, 0], [0.6, 0.52], [1.2, 0.52], [1.34, 0], [1.8, 0], [1.12, 2.5], [0.68, 2.5]]);
    s.holes.push(hole([[0.71, 0.92], [1.09, 0.92], [0.9, 1.66]]));
    return { shape: s, w: 1.8 };
  }
  if (ch === 'B' || ch === 'R') {
    const s = new THREE.Shape();
    const top = ch === 'B' ? 0.625 : 0.73;
    s.moveTo(0, 0);
    if (ch === 'B') {
      s.lineTo(0.95, 0);
      s.absarc(0.95, 0.625, 0.625, -Math.PI / 2, Math.PI / 2, false);
      s.lineTo(0.92, 1.25);
    } else {
      s.lineTo(t, 0);
      s.lineTo(t, 1.04);
      s.lineTo(0.62, 1.04);
      s.lineTo(1.08, 0);
      s.lineTo(1.56, 0);
      s.lineTo(1.1, 1.1);
    }
    s.absarc(0.92, 2.5 - top, top, -Math.PI / 2 + (ch === 'R' ? 0.25 : 0), Math.PI / 2, false);
    s.lineTo(0, 2.5);
    s.lineTo(0, 0);
    const bowl = (cy: number, r: number) => {
      const p = new THREE.Path();
      p.moveTo(t, cy - r);
      p.lineTo(0.92, cy - r);
      p.absarc(0.92, cy, r, -Math.PI / 2, Math.PI / 2, false);
      p.lineTo(t, cy + r);
      return p;
    };
    s.holes.push(bowl(2.5 - top, top - t));
    if (ch === 'B') s.holes.push(bowl(0.625, 0.625 - t));
    return { shape: s, w: ch === 'B' ? 1.57 : 1.65 };
  }
  // S: a centerline of two stacked loops, offset by half a stroke to either side.
  const rc = (2.5 - t) / 4;
  const cx = rc + t / 2;
  const c1 = 2.5 - t / 2 - rc;
  const c2 = t / 2 + rc;
  const left: THREE.Vector2[] = [];
  const right: THREE.Vector2[] = [];
  const along = (cy: number, a0: number, a1: number, inner: 1 | -1) => {
    for (let i = 0; i <= 14; i++) {
      const a = a0 + ((a1 - a0) * i) / 14;
      const d = V(Math.cos(a), Math.sin(a));
      left.push(V(cx, cy).addScaledVector(d, rc - (inner * t) / 2));
      right.push(V(cx, cy).addScaledVector(d, rc + (inner * t) / 2));
    }
  };
  along(c1, 0.45, 1.5 * Math.PI, 1);
  along(c2, Math.PI / 2, -Math.PI + 0.45, -1);
  return { shape: new THREE.Shape([...left, ...right.reverse()]), w: 2 * cx };
}

/** Black knitted privacy screen on chain link, one 3 m × 2.4 m bay: hems with grommets and ties. */
function fenceScreenTexture() {
  return canvasTexture(150, 120, (ctx) => {
    ctx.fillStyle = '#16191a';
    ctx.fillRect(0, 0, 150, 120);
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    for (let x = 0; x < 150; x += 2) ctx.fillRect(x, 0, 1, 120);
    for (let y = 0; y < 120; y += 3) ctx.fillRect(0, y, 150, 1);
    // Chain link showing above and below the screen.
    ctx.strokeStyle = 'rgba(170,176,180,0.55)';
    ctx.lineWidth = 0.6;
    for (const [y0, y1] of [[0, 6], [114, 120]]) {
      ctx.beginPath();
      for (let x = -6; x < 156; x += 3) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x + y1 - y0, y1);
        ctx.moveTo(x + y1 - y0, y0);
        ctx.lineTo(x, y1);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#0c0d0e';
    ctx.fillRect(0, 6, 150, 3);
    ctx.fillRect(0, 111, 150, 3);
    ctx.fillStyle = 'rgba(200,204,206,0.6)';
    for (let x = 4; x < 150; x += 12) {
      ctx.fillRect(x, 7, 1.2, 1.2);
      ctx.fillRect(x, 112, 1.2, 1.2);
    }
    // Slight sag between ties.
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    for (let x = 0; x < 150; x += 30) ctx.fillRect(x + 10, 9, 10, 102);
  });
}

function propertySignTexture() {
  return canvasTexture(120, 80, (ctx) => {
    ctx.fillStyle = '#f2f2ef';
    ctx.fillRect(0, 0, 120, 80);
    ctx.fillStyle = '#c3272b';
    ctx.fillRect(0, 0, 120, 22);
    ctx.fillStyle = '#fff';
    ctx.font = '800 15px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('NO TRESPASSING', 60, 11.5);
    ctx.fillStyle = '#1b1e22';
    ctx.font = '700 11px Arial, sans-serif';
    ctx.fillText('PRIVATE PROPERTY', 60, 36);
    ctx.fillText('SPACEX · STARBASE', 60, 52);
    ctx.font = '500 7px Arial, sans-serif';
    ctx.fillText('VIOLATORS WILL BE PROSECUTED', 60, 68);
  }, false);
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

/**
 * Each logical part is a named child group, for `getObjectByName`: starfactory, megabay1, megabay2,
 * gigabay, cranes, garage, rocketGarden (stands, rings, and the 'stack'/'ship' clones), aprons,
 * floodmasts (including 'halos'), cars, fence, sign.
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
  // Geometry is merged per material within each named part (a child group of the site), so a part
  // can be shown on its own while draw calls stay at one per material per part.
  type Part = { group: THREE.Group; meshers: Map<THREE.Material, Mesher> };
  const parts = new Map<string, Part>();
  let current!: Part;
  const part = (name: string) => {
    let p = parts.get(name);
    if (!p) {
      const group = new THREE.Group();
      group.name = name;
      g.add(group);
      parts.set(name, (p = { group, meshers: new Map() }));
    }
    current = p;
    return p.group;
  };
  const M = (mat: THREE.Material) => {
    let m = current.meshers.get(mat);
    if (!m) current.meshers.set(mat, (m = new Mesher()));
    return m.at(section.clone());
  };
  /** Folds a separately built Mesher into the current part's mesher for `mat`. */
  const adopt = (mat: THREE.Material, m: Mesher) => current.meshers.set(mat, merge(current.meshers.get(mat), m));
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
  part('starfactory');
  placeSection(-70, -145);
  const glass = starfactoryGlass();
  const glassMat = std({ map: glass.color, emissiveMap: glass.emissive, roughness: 0.5, metalness: 0.2 }, 1.6, true);
  const band = starfactoryBand();
  const bandMat = std({ map: band.color, emissiveMap: band.emissive, roughness: 0.82 }, 1.6, true);
  const sections: [number, number, number][] = [[-130, -40, 27], [-40, 70, 22], [70, 170, 31]];
  const backX = -165;
  for (const [z0, z1, h] of sections) {
    M(glassMat).wall(0, z1, 0, z0, 0, GLASS_TOP, GLASS_TILE, GLASS_TOP, 170 - z1);
    M(bandMat).wall(0, z1, 0, z0, GLASS_TOP, h, 300, 20, 170 - z1, GLASS_TOP);
    const cm = M(claddingMat);
    cm.wall(backX, z0, backX, z1, 0, h, 32, 32);
    M(roofMat).flat(backX, 0, z0, z1, h, 16);
  }
  // Bay doors over the glazing, 12 m tall, at 96–108 m and 180–196 m along the front from its west end.
  const doorMat = std({ map: rollDoorTexture(), roughness: 0.6, metalness: 0.4 });
  Object.assign(doorMat, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
  for (const [a, b] of [[96, 108], [180, 196]]) {
    M(doorMat).wall(0.05, 170 - a, 0.05, 170 - b, 0, 12, 4, 4);
    M(darkMat).box(0, 0.3, 12, 12.6, 170 - b - 0.3, 170 - a + 0.3, 4);
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
  bays.forEach(([z0, rows, open], i) => {
    part(`megabay${i + 1}`);
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
  });

  // --- Gigabay: 110 × 130 × 116 m, cladding most of the way up, frame and cranes still on top.
  part('gigabay');
  placeSection(90, 80);
  {
    const x1 = -200;
    const x0 = x1 - 110;
    const z0 = -52;
    const z1 = z0 + 130;
    const clad = { roughness: 0.92, alphaTest: 0.5, side: THREE.DoubleSide };
    const eastMat = floodlit(std({ map: gigabayFace(130, 11), ...clad }, 0, true), 0.06);
    const sideMat = floodlit(std({ map: gigabayFace(110, 23), ...clad }, 0, true), 0.06);
    M(eastMat).wall(x1, z1, x1, z0, 0, 116, 130, 116);
    M(eastMat).wall(x0, z0, x0, z1, 0, 116, 130, 116);
    M(sideMat).wall(x1, z0, x0, z0, 0, 116, 110, 116);
    M(sideMat).wall(x0, z1, x1, z1, 0, 116, 110, 116);
    M(roofMat).flat(x0, x1, z0, z1, 116, 16);
    // Shadowed interior behind the open frame, inset so the frame reads with depth.
    M(std({ color: 0x0c0d0f, roughness: 1 })).box(x0 + 7, x1 - 7, 0, 115.5, z0 + 7, z1 - 7, 8);

    // Bare steel frame above the cladding: columns, a ring beam every 8.5 m, X bracing in the end bays.
    const frame = M(std({ color: 0x8f969c, roughness: 0.55, metalness: 0.6 }));
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const walls: [number, number, number, number][] = [
      [x1, z0, x1, z1],
      [x0, z0, x0, z1],
      [x0, z0, x1, z0],
      [x0, z1, x1, z1],
    ];
    for (const [ax, az, bx, bz] of walls) {
      const at = (f: number, y: number) => V(ax + (bx - ax) * f, y, az + (bz - az) * f);
      for (let i = 0; i <= 12; i++) beam(frame, section, at(i / 12, 66), at(i / 12, 116), 0.9);
      for (let y = 67.5; y <= 116; y += 8.5) beam(frame, section, at(0, y), at(1, y), 0.6);
      for (const bay of [1, 10]) {
        for (let y = 67.5; y + 8.5 <= 116; y += 8.5) {
          beam(frame, section, at(bay / 12, y), at((bay + 1) / 12, y + 8.5), 0.35);
          beam(frame, section, at((bay + 1) / 12, y), at(bay / 12, y + 8.5), 0.35);
        }
      }
    }
    // Roof trusses spanning the short way, visible through the top tier.
    for (let i = 1; i < 12; i++) {
      const z = z0 + (i * (z1 - z0)) / 12;
      beam(frame, section, V(x0, 114.5, z), V(x1, 114.5, z), 0.7);
      beam(frame, section, V(x0, 111.5, z), V(x1, 111.5, z), 0.4);
    }
    M(darkMat).box(x0 + 30, x1 - 30, 116, 122, z0 + 20, z1 - 20, 4);
    part('cranes');
    const lat = M(std({ color: 0xc8401e, roughness: 0.6, metalness: 0.1 }));
    const dk = new Mesher();
    const gl = M(cabGlass);
    towerCrane(lat, dk, gl, x1 + 8, z0 - 8, 152, 2.4, 68);
    towerCrane(lat, dk, gl, x1 + 8, z1 + 8, 146, -2.0, 62);
    towerCrane(lat, dk, gl, x0 - 8, z0 - 8, 158, 0.9, 70);
    towerCrane(lat, dk, gl, x0 - 8, z1 + 8, 141, -0.6, 66);
    adopt(darkMat, dk);
  }

  // --- Parking garage behind the Gigabay.
  part('garage');
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
  const garden = part('rocketGarden');
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
      garden.add(c);
    };
    /** Open steel transport stand: octagonal top and bottom rings, eight legs, X-braced bays, support pads. */
    const stand = (x: number, z: number, h: number) => {
      const st = M(darkMat);
      const base = placed(x, 0, z);
      const r = R + 0.5;
      const P = (a: number, y: number, rr = r) => new THREE.Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr);
      for (let i = 0; i < 8; i++) {
        const a0 = ((i + 0.5) / 8) * Math.PI * 2;
        const a1 = ((i + 1.5) / 8) * Math.PI * 2;
        beam(st, base, P(a0, h - 0.25), P(a1, h - 0.25), 0.5);
        beam(st, base, P(a0, 0.2, r + 0.6), P(a1, 0.2, r + 0.6), 0.4);
        beam(st, base, P(a0, 0, r + 0.6), P(a0, h - 0.25), 0.45);
        beam(st, base, P(a0, 0.2, r + 0.6), P(a1, h - 0.6), 0.16);
        beam(st, base, P(a1, 0.2, r + 0.6), P(a0, h - 0.6), 0.16);
        st.at(base.clone().multiply(new THREE.Matrix4().makeTranslation(Math.cos(a0) * (R - 0.2), h - 0.1, Math.sin(a0) * (R - 0.2)))).box(-0.5, 0.5, 0, 0.2, -0.5, 0.5, 4, true);
      }
    };
    const booster = (x: number, z: number, yaw: number) => {
      stand(x, z, 6.4);
      show(proto, x, 6.5, z, yaw);
    };
    const ship = (x: number, z: number, yaw: number, h: number) => {
      stand(x, z, h);
      show(shipProto, x, h + 0.1, z, yaw);
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

  part('cranes');
  const cranes = new Mesher();
  const craneDark = new Mesher();
  crawlerCrane(cranes, craneDark, M(cabGlass), 112, -6, Math.PI - 0.15);
  adopt(darkMat, craneDark);
  adopt(std({ color: 0xe0a820, roughness: 0.6, metalness: 0.1 }), cranes);

  // --- Concrete aprons, surface lot with cars, flood light masts.
  part('aprons');
  placeSection(0, 0);
  M(concreteMat).box(-128, -4, 0, 0.35, -300, 300, 16);
  M(concreteMat).box(-140, -20, 0, 0.3, 250, 360, 16);
  M(concreteMat).box(-345, -235, 0, 0.35, -300, 155, 16);
  const floodGroup = part('floodmasts');
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
  part('cars').add(cars);

  // --- Roadside fence: chain link with a black privacy screen on galvanized posts, top rail and
  // three strands of barbed wire on angled arms, property signs every 60 m. The 2.5 m illuminated
  // STARBASE letters stand free in front of it on a bed of rock, lit from below.
  part('fence');
  const FENCE_H = 2.6;
  const Z0 = -330;
  const Z1 = 470;
  const screenMat = std({ map: fenceScreenTexture(), roughness: 0.95 });
  const screen = M(screenMat);
  screen.wall(0, Z1, 0, Z0, 0.3, FENCE_H, 3, FENCE_H - 0.3, 0, 0.3);
  screen.wall(-0.04, Z0, -0.04, Z1, 0.3, FENCE_H, 3, FENCE_H - 0.3, 0, 0.3);
  const galv = M(std({ color: 0xa4a9ac, roughness: 0.5, metalness: 0.75 }));
  const origin = placed(0, 0, 0);
  const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  for (let z = Z0; z <= Z1; z += 3) {
    // Heavier line posts every 30 m, braced back into the lot.
    const r = z % 30 === 0 ? 0.06 : 0.045;
    galv.at(placed(-0.02, 0, z)).geo(new THREE.CylinderGeometry(r, r, FENCE_H + 0.15, 8).translate(0, (FENCE_H + 0.15) / 2, 0));
    beam(galv, origin, V3(-0.02, FENCE_H + 0.1, z), V3(0.4, FENCE_H + 0.5, z), 0.04);
    if (r > 0.05) for (const s of [-1, 1]) beam(galv, origin, V3(-0.05, FENCE_H * 0.55, z), V3(-1.1, 0.3, z + s * 1.4), 0.05);
  }
  galv.at(origin).geo(new THREE.CylinderGeometry(0.03, 0.03, Z1 - Z0, 6).rotateX(Math.PI / 2).translate(-0.02, FENCE_H + 0.05, (Z0 + Z1) / 2));
  for (const [x, y] of [[0.12, FENCE_H + 0.23], [0.26, FENCE_H + 0.36], [0.39, FENCE_H + 0.49]]) galv.box(x - 0.01, x + 0.01, y - 0.01, y + 0.01, Z0, Z1, 6);
  M(concreteMat).box(-0.2, 0.15, 0, 0.3, Z0, Z1, 6);
  const signMat = std({ map: propertySignTexture(), roughness: 0.6 });
  for (let z = Z0 + 33; z < Z1; z += 60) {
    if (z > 240 && z < 330) continue;
    M(signMat).wall(0.03, z + 0.45, 0.03, z - 0.45, 1.25, 1.85, 0.9, 0.6, 0, 1.25);
  }
  // Rock bed along the frontage under the letters.
  part('sign');
  const rockMat = std({ color: 0xa79d8c, roughness: 1 });
  M(rockMat).box(1.2, 8.5, 0, 0.18, 250, 316, 4);
  const rocks = M(rockMat);
  for (let i = 0; i < 140; i++) {
    const r = 0.18 + rand() * 0.35;
    rocks.at(placed(1.4 + rand() * 7, 0.1, 251 + rand() * 64, rand() * 6)).geo(new THREE.DodecahedronGeometry(r, 0).scale(1, 0.6, 1));
  }
  // Extruded channel letters: lit acrylic faces toward the road, dark steel returns, each on a footing.
  const faceMat = std({ color: 0xf6f4ef, roughness: 0.35, emissive: 0xfff4e6, emissiveIntensity: 0.85 });
  const returnMat = std({ color: 0x24272b, roughness: 0.4, metalness: 0.7 });
  const PITCH = 46 / 8;
  'STARBASE'.split('').forEach((ch, i) => {
    const { shape, w } = letterShape(ch);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.42, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1, curveSegments: 10 });
    const [face, sides] = splitByNormal(geo, new THREE.Vector3(0, 0, 1));
    const zc = 306 - (i + 0.5) * PITCH;
    // Shape x reads along −z seen from the road, shape +z (the face) points at the road.
    const at = placed(3.9, 0.3, zc + w / 2, Math.PI / 2);
    M(faceMat).at(at).geo(face);
    M(returnMat).at(at).geo(sides);
    M(concreteMat).box(3.3, 4.5, 0, 0.3, zc - w / 2 - 0.3, zc + w / 2 + 0.3, 4, false);
    geo.dispose();
  });
  const up = M(darkMat);
  for (let i = 0; i < 8; i++) {
    const z = 306 - (i + 0.5) * PITCH;
    up.box(5.3, 5.8, 0.15, 0.45, z - 0.35, z + 0.35, 4);
    M(lampMat).flat(5.36, 5.74, z - 0.29, z + 0.29, 0.46, 4);
  }

  for (const { group, meshers } of parts.values()) {
    for (const [mat, m] of meshers) {
      const mesh = m.mesh(mat);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }

  for (const m of mastMeshes) floodGroup.add(m);

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
  halos.name = 'halos';
  floodGroup.add(halos);

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
