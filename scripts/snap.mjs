#!/usr/bin/env node
// Shared screenshot tool: one persistent GPU (Metal) headless Chrome, reused by every agent via CDP.
// usage: node scripts/snap.mjs <url> <w> <h> <prefix> <ms,...> [launchAtMs] [scrollSelector] [options]
//   --out <dir>        write PNGs into dir (prefix basename is kept)
//   --mobile           DPR 2 + touch + mobile viewport   (--dpr <n> to override DPR)
//   --crop x,y,w,h     clip region (CSS px)
//   --clock ready|nav|load  t=0 is when the hero scene is ready (default), navigate+1500ms (old shoot.mjs),
//                      or the load event without waiting for ready (to catch the loader)
//   --gate             don't append `autostart`, so the hero shows its loader and start gate
//   --sound            don't append `mute`
//   --timeout <s>      hard per-job timeout (default 120)
//   --console          print page console errors/warnings and exceptions
//   --eval <js>        evaluate JS in the page after ready (before timed shots); prints the result
//   --no-js            disable JavaScript in the tab;  --no-webgl  make getContext(webgl*) return null
// admin: snap.mjs --status | --stop | --start
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';

const HOME = '/tmp/77shots';
const STATE = join(HOME, '.snap');
const PORT = 9555;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = join(STATE, 'profile');
const PIDFILE = join(STATE, 'chrome.pid');
const LAST_USED = join(STATE, 'last-used');
const START_LOCK = join(STATE, 'start.lock');
const SLOTS = 2;
const IDLE_SHUTDOWN_MS = 20 * 60 * 1000;
const dbg = (...m) => process.env.SNAP_DEBUG && console.error(`[${new Date().toISOString().slice(17,23)}]`, ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(STATE, { recursive: true });

const alive = (pid) => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const readPid = (f) => { try { return Number(readFileSync(f, 'utf8').trim()) || 0; } catch { return 0; } };
const touch = () => { const t = new Date(); try { utimesSync(LAST_USED, t, t); } catch { writeFileSync(LAST_USED, ''); } };

async function version() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch { return null; }
}

// Atomic mkdir lock; stale if the owner pid is gone or it is older than maxAgeMs.
async function acquire(dir, maxAgeMs, waitMs) {
  const t0 = Date.now();
  for (;;) {
    try { mkdirSync(dir); writeFileSync(join(dir, 'owner'), String(process.pid)); return true; } catch {}
    const owner = readPid(join(dir, 'owner'));
    let age = 0; try { age = Date.now() - statSync(dir).mtimeMs; } catch { continue; }
    if ((owner && !alive(owner)) || (!owner && age > 5000) || age > maxAgeMs) { try { rmSync(dir, { recursive: true, force: true }); } catch {} continue; }
    if (Date.now() - t0 > waitMs) return false;
    await sleep(150);
  }
}
const release = (dir) => { if (readPid(join(dir, 'owner')) === process.pid) rmSync(dir, { recursive: true, force: true }); };

async function ensureChrome() {
  if (await version()) return;
  if (!(await acquire(START_LOCK, 30000, 30000))) throw new Error('could not get start lock');
  try {
    if (await version()) return;
    const old = readPid(PIDFILE);
    if (old && alive(old)) { try { process.kill(old, 'SIGKILL'); } catch {} await sleep(300); }
    const c = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
      '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--disable-background-networking', '--disable-extensions', '--disable-sync', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,900', 'about:blank',
    ], { detached: true, stdio: 'ignore' });
    c.unref();
    writeFileSync(PIDFILE, String(c.pid));
    touch();
    const w = spawn(process.execPath, [new URL(import.meta.url).pathname, '--watchdog'], { detached: true, stdio: 'ignore' });
    w.unref();
    for (let i = 0; i < 100; i++) { if (await version()) return; await sleep(100); }
    throw new Error('chrome did not come up');
  } finally { release(START_LOCK); }
}

async function stopChrome() {
  const v = await version();
  if (v) {
    try {
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(800);
    } catch {}
  }
  const pid = readPid(PIDFILE);
  if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  rmSync(PIDFILE, { force: true });
}

// Close page tabs left behind by SIGKILLed jobs: anything not owned by a live slot. Fresh about:blank
// tabs are skipped because a job may not have recorded its target yet.
async function reap() {
  const v = await version();
  if (!v) return 0;
  const owned = new Set();
  for (const f of readdirSync(STATE).filter((f) => f.startsWith('slot-'))) {
    if (!alive(readPid(join(STATE, f, 'owner')))) continue;
    try { owned.add(readFileSync(join(STATE, f, 'target'), 'utf8').trim()); } catch {}
  }
  const b = cdp(v.webSocketDebuggerUrl);
  let n = 0;
  try {
    await b.open;
    const { targetInfos } = await b.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type !== 'page' || t.url === 'about:blank' || t.url.startsWith('chrome://') || owned.has(t.targetId)) continue;
      await b.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      n++;
    }
  } finally { b.close(); }
  return n;
}

// Detached watchdog: reaps orphan tabs and shuts the shared Chrome down after IDLE_SHUTDOWN_MS without jobs.
async function watchdog() {
  const myChrome = readPid(PIDFILE);
  for (;;) {
    await sleep(30000);
    await reap().catch(() => {});
    if (readPid(PIDFILE) !== myChrome || !alive(myChrome)) process.exit(0);
    let idle = 0; try { idle = Date.now() - statSync(LAST_USED).mtimeMs; } catch {}
    const busy = readdirSync(STATE).some((f) => f.startsWith('slot-') && alive(readPid(join(STATE, f, 'owner'))));
    if (!busy && idle > IDLE_SHUTDOWN_MS) { await stopChrome(); process.exit(0); }
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(`${d.error.message}`)) : res(d.result); }
    else if (d.method) for (const l of listeners) l(d);
  };
  ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('cdp socket closed')); pending.clear(); };
  return {
    open: new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('cdp connect failed')); }),
    send: (method, params = {}, sessionId) => new Promise((res, rej) => {
      const i = ++id;
      const limit = method === 'Runtime.evaluate' && params.awaitPromise ? 60000 : 30000;
      const timer = setTimeout(() => { pending.delete(i); rej(new Error(`${method} timed out after ${limit / 1000}s`)); }, limit);
      pending.set(i, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) }));
    }),
    on: (fn) => listeners.push(fn),
    close: () => { try { ws.close(); } catch {} },
  };
}

function parseArgs(argv) {
  const pos = []; const o = { clock: 'ready', timeout: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--mobile') o.mobile = true;
    else if (a === '--dpr') o.dpr = Number(argv[++i]);
    else if (a === '--crop') o.crop = argv[++i].split(',').map(Number);
    else if (a === '--clock') o.clock = argv[++i];
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--console') o.console = true;
    else if (a === '--eval') o.eval = argv[++i];
    else if (a === '--no-js') o.noJs = true;
    else if (a === '--no-webgl') o.noWebgl = true;
    else if (a === '--sound') o.sound = true;
    else if (a === '--gate') o.gate = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  const [url, w, h, prefix, times, launchAt, scrollSel] = pos;
  if (!url || !w || !h || !prefix || !times) throw new Error('usage: snap.mjs <url> <w> <h> <prefix> <ms,...> [launchAtMs] [scrollSelector] [--out dir] [--mobile] [--dpr n] [--crop x,y,w,h] [--clock ready|nav|load] [--timeout s] [--console] [--eval js] [--no-js] [--no-webgl] [--sound] [--gate]');
  return { url, w: +w, h: +h, prefix, times: times.split(',').map(Number), launchAt: launchAt && launchAt !== '-' ? +launchAt : null, scrollSel: scrollSel || null, ...o };
}

async function job(a) {
  const tStart = Date.now();
  let slot = null; let browser = null; let targetId = null;
  const cleanup = async () => {
    try { if (browser && targetId) await Promise.race([browser.send('Target.closeTarget', { targetId }), sleep(2000)]); } catch {}
    browser?.close();
    if (slot) release(slot);
    touch();
  };
  const hard = setTimeout(async () => { console.error(`snap: TIMEOUT after ${a.timeout}s`); await cleanup(); process.exit(2); }, a.timeout * 1000);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => { await cleanup(); process.exit(130); });
  try {
    await ensureChrome();
    for (let waited = 0; !slot; ) {
      for (let s = 0; s < SLOTS && !slot; s++) if (await acquire(join(STATE, `slot-${s}`), a.timeout * 1000 + 30000, 0)) slot = join(STATE, `slot-${s}`);
      if (!slot) { if (waited === 0) console.error('snap: queued (another job is running)…'); waited += 300; await sleep(300); }
    }
    const tQueued = Date.now();
    touch();
    await ensureChrome();
    await reap().catch(() => {});
    browser = cdp((await version()).webSocketDebuggerUrl);
    await browser.open;
    ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank', newWindow: true, width: a.w, height: a.h }));
    writeFileSync(join(slot, 'target'), targetId);
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (m, p) => browser.send(m, p, sessionId);
    const errors = [];
    browser.on((d) => {
      if (d.sessionId !== sessionId) return;
      if (d.method === 'Runtime.exceptionThrown') errors.push(`EXC ${d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text}`.slice(0, 500));
      if (d.method === 'Runtime.consoleAPICalled' && /error|warn/.test(d.params.type)) errors.push(`${d.params.type} ${d.params.args.map((x) => x.value ?? x.description).join(' ')}`.slice(0, 500));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    const mobile = !!a.mobile || a.w < 600;
    await send('Emulation.setDeviceMetricsOverride', { width: a.w, height: a.h, deviceScaleFactor: a.dpr || (a.mobile ? 2 : 1), mobile });
    if (a.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    if (a.noJs) await send('Emulation.setScriptExecutionDisabled', { value: true });
    if (a.noWebgl) await send('Page.addScriptToEvaluateOnNewDocument', { source: `{const g=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...r){return /webgl/i.test(t)?null:g.call(this,t,...r)}}` });
    let tLoad = 0;
    const loaded = new Promise((r) => browser.on((d) => d.sessionId === sessionId && d.method === 'Page.loadEventFired' && r((tLoad = Date.now()))));
    dbg("target ready", targetId);
    const tNav = Date.now();
    // The hero waits behind a start gate and plays sound; shots skip the gate (`autostart`) and stay
    // silent (`mute`) unless --gate / --sound are given.
    const navUrl = new URL(a.url);
    if (!a.gate && !navUrl.searchParams.has('autostart')) navUrl.searchParams.append('autostart', '');
    if (!a.sound && !navUrl.searchParams.has('mute')) navUrl.searchParams.append('mute', '');
    const nav = await send('Page.navigate', { url: navUrl.href.replace(/([?&])(mute|autostart)=(?=&|$)/g, '$1$2') });
    if (nav.errorText) throw new Error(`navigate failed: ${nav.errorText}`);
    dbg("navigated");
    await Promise.race([loaded, sleep(30000)]);
    dbg("load event");

    // Readiness: window.__heroReady, or [data-hero3d] gaining .ready/.fallback, else 2 rAFs after load.
    const ready = a.noJs ? { result: { value: 'load(no-js)' } } : a.clock === 'load' ? { result: { value: 'load(not awaited)' } } : await send('Runtime.evaluate', {
      awaitPromise: true, returnByValue: true,
      expression: `new Promise((res) => {
        const raf2 = (s) => requestAnimationFrame(() => requestAnimationFrame(() => res(s)));
        const hero = document.querySelector('[data-hero3d]');
        const check = () => window.__heroReady ? 'heroReady' : hero && hero.classList.contains('ready') ? 'ready' : hero && hero.classList.contains('fallback') ? 'fallback' : null;
        if (!hero && !('__heroReady' in window)) return raf2('load');
        const s = check(); if (s) return raf2(s);
        const id = setInterval(() => { const s = check(); if (s) { clearInterval(id); raf2(s); } }, 25);
        setTimeout(() => { clearInterval(id); res('timeout'); }, 45000);
      })`,
    });
    const readyState = ready.result.value;
    dbg("ready", readyState);
    const tReady = Date.now();
    if (readyState === 'fallback') errors.push('hero entered FALLBACK (WebGL/scene failed)');

    if (a.scrollSel) await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(a.scrollSel)})?.scrollIntoView({block:'start'})` });
    if (a.eval) { const r = await send('Runtime.evaluate', { expression: a.eval, awaitPromise: true, returnByValue: true }); console.log('eval:', JSON.stringify(r.exceptionDetails ? r.exceptionDetails.exception?.description : r.result.value)); }
    const t0 = a.clock === 'nav' ? tNav + 1500 : a.clock === 'load' ? tLoad || tReady : tReady;
    if (a.clock === 'nav') await sleep(Math.max(0, t0 - Date.now()));

    const outDir = a.out ? resolve(a.out) : dirname(resolve(a.prefix));
    mkdirSync(outDir, { recursive: true });
    const base = join(outDir, basename(a.prefix));
    const files = [];
    const viewportClip = async () => {
      if (!a.crop) return undefined;
      const { result } = await send('Runtime.evaluate', { returnByValue: true, expression: '[scrollX, scrollY]' });
      const [sx, sy] = result.value;
      return { x: a.crop[0] + sx, y: a.crop[1] + sy, width: a.crop[2], height: a.crop[3], scale: 1 };
    };
    let launched = a.launchAt == null;
    for (const at of a.times) {
      if (!launched && at >= a.launchAt) {
        await sleep(Math.max(0, t0 + a.launchAt - Date.now()));
        await send('Runtime.evaluate', { expression: `document.querySelector('[data-launch]')?.click()`, userGesture: true });
        launched = true;
      }
      const late = Date.now() - (t0 + at);
      await sleep(Math.max(0, -late));
      const clip = await viewportClip();
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip && { clip }) });
      dbg("captured", at);
      const f = `${base}-${at}.png`;
      writeFileSync(f, Buffer.from(data, 'base64'));
      files.push(late > 250 ? `${f} (late ${late}ms)` : f);
    }
    const gl = await send('Runtime.evaluate', { returnByValue: true, expression: `(()=>{try{const g=document.createElement('canvas').getContext('webgl2');return g.getParameter(g.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)}catch(e){return 'no webgl'}})()` });
    if (a.console && errors.length) console.log(errors.join('\n'));
    else if (errors.some((e) => e.startsWith('EXC') || e.includes('FALLBACK'))) console.log(errors.filter((e) => e.startsWith('EXC') || e.includes('FALLBACK')).join('\n'));
    console.log(files.join('\n'));
    console.log(`snap: ok ready=${readyState} queue=${((tQueued - tStart) / 1000).toFixed(1)}s load=${((tReady - tNav) / 1000).toFixed(1)}s total=${((Date.now() - tStart) / 1000).toFixed(1)}s gl="${gl.result.value}"`);
  } finally {
    clearTimeout(hard);
    await cleanup();
  }
}

const argv = process.argv.slice(2);
try {
  if (argv[0] === '--watchdog') await watchdog();
  else if (argv[0] === '--stop') { await stopChrome(); console.log('snap: chrome stopped'); }
  else if (argv[0] === '--start') { await ensureChrome(); console.log('snap: chrome up on', PORT); }
  else if (argv[0] === '--status') {
    const v = await version();
    const slots = readdirSync(STATE).filter((f) => f.startsWith('slot-')).map((f) => `${f}(pid ${readPid(join(STATE, f, 'owner'))})`);
    console.log(v ? `snap: chrome up port ${PORT} pid ${readPid(PIDFILE)} ${v.Browser}` : 'snap: chrome not running', '| busy:', slots.join(' ') || 'none');
  } else await job(parseArgs(argv));
  process.exit(0);
} catch (e) {
  console.error('snap: ERROR', e.message);
  process.exit(1);
}
