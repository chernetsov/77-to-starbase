import * as THREE from 'three';

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
    } while ((Math.abs(x) < 80 && Math.abs(z) < 90) || (Math.abs(x - 120) < 60 && Math.abs(z + 330) < 60));
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

/** A high cumulus layer: a large horizontal plane with fbm coverage, lit from the sun side. */
export function buildClouds(sunDir: THREE.Vector3) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uSun: { value: sunDir.clone() }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
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
        vec2 p = vWorld.xz * 0.00045 + vec2(uTime * 0.004, 0.0);
        float d = fbm(p);
        float cover = smoothstep(0.5, 0.72, d);
        float toward = fbm(p + uSun.xz * 0.12);
        float lit = clamp(0.55 + (d - toward) * 2.6, 0.0, 1.0);
        vec3 col = mix(vec3(0.58, 0.62, 0.7), vec3(1.0, 0.95, 0.88), lit);
        vec3 rel = vWorld - cameraPosition;
        float dist = length(rel.xz);
        float fade = 1.0 - smoothstep(6000.0, 17000.0, dist);
        gl_FragColor = vec4(col, cover * fade * 0.92);
      }`,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), mat);
  plane.rotation.x = Math.PI / 2;
  plane.position.y = 1500;
  plane.frustumCulled = false;
  plane.renderOrder = -1;
  return {
    mesh: plane,
    update(time: number) {
      mat.uniforms.uTime.value = time;
    },
  };
}
