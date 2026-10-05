// Generative soundtrack for the hero: a deep-tech idle loop and a physically-motivated launch roar.
// Everything is synthesized with the Web Audio API; there are no audio assets.

export type LaunchHud = { phase: 'idle' | 'countdown' | 'flight'; t: number; alt: number; vel: number };

export type LaunchAudio = {
  /** Must be called from a user gesture (click/tap) — browsers block audio until then. */
  enable(): Promise<void>;
  disable(): Promise<void>;
  setMuted(muted: boolean): void;
  /** Call every frame with the scene HUD and the scene's `soundDelay`. */
  update(hud: LaunchHud, soundDelay: number): void;
  /** Schedules upcoming music notes. Called automatically for live contexts; call manually for offline renders. */
  pump(): void;
  dispose(): void;
  readonly enabled: boolean;
  readonly muted: boolean;
};

type Options = { context?: BaseAudioContext; volume?: number };

const C = 343;
const IGNITION = -2.5;
const SIM_END = 32;
const BPM = 118;
const STEP = 60 / BPM / 4;
const SWING = 0.09;
const LOOKAHEAD = 0.14;

// A-minor deep-house cycle, two bars each: Am9 · Fmaj9 · Dm9 · Em9.
const CHORDS = [
  { bass: 45, pad: [57, 60, 64, 67, 71] },
  { bass: 41, pad: [53, 57, 60, 64, 67] },
  { bass: 38, pad: [53, 57, 60, 62, 64] },
  { bass: 40, pad: [55, 59, 62, 64, 66] },
];
const ARP_STEPS = new Set([0, 3, 6, 8, 10, 13]);

const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smoothstep = (x: number, a: number, b: number) => {
  const k = clamp((x - a) / (b - a), 0, 1);
  return k * k * (3 - 2 * k);
};
const hash = (a: number, b: number) => {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
const altAt = (t: number) => (t > 0 ? 1.6 * t * t + 0.09 * t ** 3 : 0);
const velAt = (t: number) => (t > 0 ? 3.2 * t + 0.27 * t * t : 0);

/** Sim time at which the sound now reaching the listener left the vehicle. */
function emissionTime(t: number, pad: number) {
  let e = t - pad / C;
  for (let i = 0; i < 5; i++) e = t - Math.hypot(pad, altAt(e)) / C;
  return e;
}

/** Writes `fill` into a buffer and crossfades the tail into the head so it loops without a click. */
function loopBuffer(ctx: BaseAudioContext, seconds: number, fill: (out: Float32Array, ch: number) => void) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.15);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const raw = new Float32Array(n + fade);
    fill(raw, ch);
    const out = buf.getChannelData(ch);
    let peak = 1e-9;
    for (let i = 0; i < n; i++) {
      let v = raw[i];
      if (i < fade) {
        const k = i / fade;
        v = raw[i] * Math.sqrt(k) + raw[n + i] * Math.sqrt(1 - k);
      }
      out[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    for (let i = 0; i < n; i++) out[i] *= 0.95 / peak;
  }
  return buf;
}

function makeNoise(ctx: BaseAudioContext) {
  const white = loopBuffer(ctx, 4, (d) => {
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  });
  const pink = loopBuffer(ctx, 6, (d) => {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const x = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + x * 0.0555179;
      b1 = 0.99332 * b1 + x * 0.0750759;
      b2 = 0.969 * b2 + x * 0.153852;
      b3 = 0.8665 * b3 + x * 0.3104856;
      b4 = 0.55 * b4 + x * 0.5329522;
      b5 = -0.7616 * b5 - x * 0.016898;
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
      b6 = x * 0.115926;
    }
  });
  const brown = loopBuffer(ctx, 7, (d) => {
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = b;
    }
  });
  return { white, pink, brown };
}

/**
 * Raptor "crackle": a Poisson train of skewed shock pulses (sharp positive rise, slower
 * negative recovery) whose density wanders in bursts, plus occasional heavier pops.
 */
function makeCrackle(ctx: BaseAudioContext) {
  const sr = ctx.sampleRate;
  return loopBuffer(ctx, 6, (d, ch) => {
    const secs = d.length / sr;
    const knots = Array.from({ length: Math.ceil(secs / 0.07) + 2 }, () => Math.random());
    const density = (t: number) => {
      const x = t / 0.07;
      const i = Math.floor(x);
      const f = x - i;
      return knots[i] * (1 - f) + knots[i + 1] * f;
    };
    let t = ch * 0.0013;
    while (t < secs) {
      const rate = 120 + 900 * density(t) ** 2;
      t += -Math.log(1 - Math.random()) / rate;
      const pop = Math.random() < 0.012;
      const amp = pop ? 0.8 + Math.random() * 0.4 : (0.08 + 0.7 * Math.random() ** 3) * (Math.random() < 0.85 ? 1 : -0.5);
      const tau = (pop ? 0.0018 + Math.random() * 0.002 : 0.00025 + Math.random() * 0.0011) * sr;
      const start = Math.floor(t * sr);
      const len = Math.min(d.length - start, Math.floor(tau * 9));
      for (let k = 0; k < len; k++) d[start + k] += amp * (Math.exp(-k / tau) - 0.34 * Math.exp(-k / (tau * 3)));
    }
  });
}

function makeImpulse(ctx: BaseAudioContext, seconds: number) {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const pre = Math.floor(sr * 0.018);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let y = 0;
    for (let i = pre; i < n; i++) {
      const k = i / n;
      y += (0.55 - 0.45 * k) * (Math.random() * 2 - 1 - y);
      d[i] = y * (1 - k) ** 2.4 * 0.6;
    }
  }
  return buf;
}

function tanhCurve(drive: number) {
  const curve = new Float32Array(2048);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

function build(ctx: BaseAudioContext) {
  const gain = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const filter = (type: BiquadFilterType, f: number, q = 0.7) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };
  const loop = (buffer: AudioBuffer) => {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = true;
    s.start(0, Math.random() * buffer.duration);
    return s;
  };
  const lfo = (freq: number, depth: number, target: AudioParam) => {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = gain(depth);
    o.connect(g).connect(target);
    o.start();
  };

  const { white, pink, brown } = makeNoise(ctx);
  const ir = makeImpulse(ctx, 3.6);

  // Master: user volume → limiter → speakers.
  const master = gain(0);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -9;
  limiter.knee.value = 6;
  limiter.ratio.value = 14;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.22;
  master.connect(limiter).connect(ctx.destination);

  // ---- Music bus ----
  const musicLevel = gain(0);
  const musicFilter = filter('lowpass', 18000, 0.5);
  const mix = gain(0.5);
  mix.connect(musicFilter).connect(musicLevel).connect(master);

  const reverb = ctx.createConvolver();
  reverb.buffer = ir;
  const reverbSend = gain(1);
  reverbSend.connect(reverb).connect(gain(0.5)).connect(mix);

  const duck = gain(1);
  duck.connect(mix);
  const drums = gain(1);
  drums.connect(mix);

  const padFilter = filter('lowpass', 700, 1.4);
  const padBus = gain(0.55);
  padFilter.connect(padBus).connect(duck);
  padBus.connect(gain(0.7)).connect(reverbSend);
  lfo(0.043, 420, padFilter.frequency);

  const arpBus = gain(0.9);
  arpBus.connect(duck);
  const delay = ctx.createDelay(2);
  delay.delayTime.value = STEP * 3;
  const delayTone = filter('lowpass', 2200);
  const feedback = gain(0.42);
  arpBus.connect(delay).connect(delayTone).connect(feedback).connect(delay);
  delayTone.connect(gain(0.55)).connect(duck);
  arpBus.connect(gain(0.6)).connect(reverbSend);

  const bassBus = gain(0.75);
  bassBus.connect(duck);

  // Boca Chica surf: slow swells of filtered brown noise under the loop.
  const surfGain = gain(0.035);
  loop(brown).connect(filter('lowpass', 650)).connect(surfGain).connect(mix);
  lfo(0.07, 0.025, surfGain.gain);

  function kick(t: number, v: number) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.09);
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.48);
    o.connect(g).connect(drums);
    o.start(t);
    o.stop(t + 0.5);
    duck.gain.setTargetAtTime(0.32, t, 0.004);
    duck.gain.setTargetAtTime(1, t + 0.07, 0.11);
  }

  function hat(t: number, v: number, open: boolean, pan: number) {
    const s = ctx.createBufferSource();
    s.buffer = white;
    const g = gain(0);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (open ? 0.22 : 0.045));
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    s.connect(filter('highpass', 7200)).connect(g).connect(p).connect(drums);
    s.start(t, Math.random() * 3);
    s.stop(t + 0.3);
  }

  function clap(t: number, v: number) {
    const s = ctx.createBufferSource();
    s.buffer = white;
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    for (let k = 0; k < 3; k++) {
      const at = t + k * 0.011;
      g.gain.setValueAtTime(v, at);
      g.gain.exponentialRampToValueAtTime(v * 0.2, at + 0.009);
    }
    g.gain.setValueAtTime(v * 0.7, t + 0.034);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    s.connect(filter('bandpass', 1400, 0.9)).connect(g);
    g.connect(drums);
    g.connect(gain(0.8)).connect(reverbSend);
    s.start(t, Math.random() * 3);
    s.stop(t + 0.3);
  }

  function bass(t: number, midi: number, len: number) {
    const f = hz(midi);
    const sub = ctx.createOscillator();
    sub.frequency.value = f;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = f;
    const lp = filter('lowpass', 160, 4);
    lp.frequency.setValueAtTime(160, t);
    lp.frequency.exponentialRampToValueAtTime(720, t + 0.02);
    lp.frequency.exponentialRampToValueAtTime(170, t + len);
    const env = gain(0);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(1, t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.06);
    sub.connect(gain(0.55)).connect(env);
    saw.connect(gain(0.2)).connect(lp).connect(env);
    env.connect(bassBus);
    for (const o of [sub, saw]) {
      o.start(t);
      o.stop(t + len + 0.1);
    }
  }

  function pluck(t: number, midi: number, v: number) {
    const f = hz(midi);
    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.value = f;
    const sine = ctx.createOscillator();
    sine.frequency.value = f * 2;
    const env = gain(0);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(v, t + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    tri.connect(env);
    sine.connect(gain(0.25)).connect(env);
    env.connect(filter('lowpass', 3200)).connect(arpBus);
    for (const o of [tri, sine]) {
      o.start(t);
      o.stop(t + 0.65);
    }
  }

  function padChord(t: number, notes: number[], dur: number) {
    const g = gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 0.9);
    g.gain.setValueAtTime(1, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 1.4);
    g.connect(padFilter);
    for (const n of notes) {
      for (const cents of [-9, 9]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(n);
        o.detune.value = cents + (Math.random() - 0.5) * 4;
        o.connect(gain(0.045)).connect(g);
        o.start(t);
        o.stop(t + dur + 1.5);
      }
    }
  }

  type Layers = { kick: boolean; bass: boolean; hats: boolean; clap: boolean; arp: number; padCutoff: number };
  function layers(bar: number): Layers {
    const none = { kick: false, bass: false, hats: false, clap: false };
    if (bar < 2) return { ...none, arp: 0, padCutoff: 520 };
    if (bar < 4) return { ...none, arp: 0.45, padCutoff: 650 };
    if (bar < 8) return { ...none, kick: true, bass: true, arp: 0.55, padCutoff: 800 };
    if (bar < 12) return { kick: true, bass: true, hats: true, clap: false, arp: 0.55, padCutoff: 900 };
    const c = (bar - 12) % 32;
    if (c >= 24 && c < 28) return { ...none, hats: c >= 26, arp: 0.9, padCutoff: 1500 };
    return { kick: true, bass: true, hats: true, clap: true, arp: 0.5, padCutoff: 950 };
  }

  let songStep = 0;
  let nextTime = 0;
  let notesOn = false;

  function scheduleStep(step: number, time: number) {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const t = time + (s % 2 === 1 ? SWING * STEP : 0);
    const L = layers(bar);
    const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length];
    if (s === 0) padFilter.frequency.setTargetAtTime(L.padCutoff, t, 1.2);
    if (s === 0 && bar % 2 === 0) padChord(t, chord.pad, 32 * STEP);
    if (L.kick && s % 4 === 0) kick(t, 0.8);
    if (L.bass && s % 4 === 2) bass(t, chord.bass, STEP * 1.6);
    if (L.bass && s === 15 && bar % 4 === 3) bass(t, chord.bass + 12, STEP * 0.8);
    if (L.hats) {
      if (s % 4 === 2) hat(t, 0.085, false, 0.15);
      else if (s % 2 === 1 && Math.random() < 0.55) hat(t, 0.025 + Math.random() * 0.03, false, -0.2);
      if (s === 14 && bar % 2 === 1) hat(t, 0.045, true, 0.1);
    }
    if (L.clap && (s === 4 || s === 12)) clap(t, 0.14);
    if (L.arp > 0 && ARP_STEPS.has(s) && hash(bar % 8, s) < L.arp) {
      pluck(t, chord.pad[(s * 3 + (bar % 4)) % chord.pad.length] + 12, 0.09);
    }
  }

  function restartSong(at: number) {
    songStep = 0;
    nextTime = at;
  }

  function pump() {
    const now = ctx.currentTime;
    if (nextTime < now - 0.25) nextTime = now + 0.05;
    while (nextTime < now + LOOKAHEAD) {
      if (notesOn) scheduleStep(songStep, nextTime);
      songStep++;
      nextTime += STEP;
    }
  }

  // ---- Launch FX: countdown riser, ticks, roar ----
  const riserFilter = filter('bandpass', 250, 3);
  const riserGain = gain(0);
  const riserSrc = loop(pink);
  riserSrc.connect(riserFilter).connect(riserGain).connect(master);

  function tick(t: number, high: boolean) {
    const o = ctx.createOscillator();
    o.frequency.value = high ? 1320 : 880;
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.1);
  }

  const rocketLevel = gain(0);
  const rocketShaper = ctx.createWaveShaper();
  rocketShaper.curve = tanhCurve(1.6);
  rocketShaper.oversample = '2x';
  const rocketBus = gain(1);
  rocketBus.connect(rocketShaper).connect(rocketLevel).connect(master);
  const rocketVerb = ctx.createConvolver();
  rocketVerb.buffer = ir;
  rocketLevel.connect(gain(0.3)).connect(rocketVerb).connect(master);

  // Sub rumble with turbulent, slowly wandering amplitude.
  const subSrc = loop(brown);
  const subGain = gain(0);
  subSrc.connect(filter('lowpass', 110, 0.8)).connect(filter('highpass', 22)).connect(subGain).connect(rocketBus);
  const modSrc = loop(brown);
  const modDepth = gain(0);
  modSrc.connect(filter('lowpass', 5)).connect(modDepth).connect(subGain.gain);

  // Broadband roar body, low-passed by distance.
  const bodySrc = loop(pink);
  const bodyLP = filter('lowpass', 9000, 0.5);
  const bodyPeak = filter('peaking', 180, 0.8);
  bodyPeak.gain.value = 6;
  const bodyGain = gain(0);
  bodySrc.connect(bodyLP).connect(bodyPeak).connect(bodyGain).connect(rocketBus);

  // Shock crackle, which air absorption strips away first.
  const crackSrc = loop(makeCrackle(ctx));
  const crackLP = filter('lowpass', 14000, 0.5);
  const crackGain = gain(0);
  crackSrc.connect(filter('highpass', 350)).connect(crackLP).connect(crackGain).connect(rocketBus);
  const rocketSources = [subSrc, bodySrc, crackSrc];

  function thump(t: number) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(62, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.9);
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o.connect(g).connect(rocketBus);
    o.start(t);
    o.stop(t + 1.7);
    const n = ctx.createBufferSource();
    n.buffer = brown;
    const ng = gain(0);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.8, t + 0.01);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    n.connect(filter('lowpass', 260)).connect(ng).connect(rocketBus);
    n.start(t, Math.random() * 3);
    n.stop(t + 1.2);
  }

  return {
    master,
    musicLevel,
    musicFilter,
    riserGain,
    riserFilter,
    rocketLevel,
    subGain,
    modDepth,
    bodyGain,
    bodyLP,
    crackGain,
    crackLP,
    rocketSources,
    tick,
    thump,
    pump,
    restartSong,
    setNotesOn(on: boolean) {
      notesOn = on;
    },
  };
}

export function createLaunchAudio(opts: Options = {}): LaunchAudio {
  const volume = opts.volume ?? 0.8;
  const ownsContext = !opts.context;
  let ctx: BaseAudioContext | null = opts.context ?? null;
  let eng: ReturnType<typeof build> | null = null;
  let enabled = false;
  let muted = false;
  let timer = 0;
  let lastPhase: LaunchHud['phase'] = 'idle';
  let prevT: number | null = null;
  let prevHeard: number | null = null;
  let lastUpdate = 0;
  let stale = false;

  const isLive = () => typeof AudioContext !== 'undefined' && ctx instanceof AudioContext;

  function applyMaster() {
    if (!ctx || !eng) return;
    eng.master.gain.setTargetAtTime(enabled && !muted ? volume : 0, ctx.currentTime, 0.08);
  }

  function startMusic(delay = 0.1) {
    if (!ctx || !eng) return;
    const now = ctx.currentTime;
    eng.setNotesOn(true);
    eng.restartSong(now + delay);
    eng.musicFilter.frequency.cancelScheduledValues(now);
    eng.musicFilter.frequency.setValueAtTime(400, now);
    eng.musicFilter.frequency.setTargetAtTime(18000, now + delay, 2.5);
    eng.musicLevel.gain.cancelScheduledValues(now);
    eng.musicLevel.gain.setValueAtTime(eng.musicLevel.gain.value, now);
    eng.musicLevel.gain.setTargetAtTime(1, now + delay, 1.6);
  }

  function pump() {
    if (!ctx || !eng || !enabled) return;
    if (lastPhase !== 'idle' && !stale && performance.now() - lastUpdate > 400 && isLive()) {
      // The scene stopped rendering mid-launch (scrolled away); don't leave the roar droning.
      stale = true;
      eng.rocketLevel.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      eng.riserGain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    }
    eng.pump();
  }

  const onVisibility = () => {
    if (!isLive()) return;
    const live = ctx as AudioContext;
    if (document.hidden) live.suspend();
    else if (enabled) live.resume();
  };

  function update(h: LaunchHud, soundDelay: number) {
    lastUpdate = performance.now();
    stale = false;
    if (!ctx || !eng || !enabled) {
      lastPhase = h.phase;
      prevT = null;
      prevHeard = null;
      return;
    }
    const now = ctx.currentTime;
    const pad = soundDelay * C;
    const e = eng;

    if (h.phase === 'idle') {
      if (lastPhase !== 'idle') {
        e.rocketLevel.gain.setTargetAtTime(0, now, 0.5);
        e.riserGain.gain.setTargetAtTime(0, now, 0.2);
        startMusic(0.9);
      }
      lastPhase = 'idle';
      prevT = null;
      prevHeard = null;
      return;
    }

    const t = h.t;
    const heard = t - IGNITION - soundDelay;

    if (heard < 0) {
      const k = smoothstep(t, -10, -3);
      e.setNotesOn(true);
      e.musicLevel.gain.setTargetAtTime(1 - 0.5 * k, now, 0.15);
      e.musicFilter.frequency.setTargetAtTime(18000 * (450 / 18000) ** k, now, 0.15);
      const r = smoothstep(t, -7, IGNITION + soundDelay) ** 2;
      e.riserGain.gain.setTargetAtTime(0.07 * r, now, 0.08);
      e.riserFilter.frequency.setTargetAtTime(250 + 2600 * r, now, 0.08);
    } else {
      e.musicLevel.gain.setTargetAtTime(0, now, 0.3);
      e.riserGain.gain.setTargetAtTime(0, now, 0.06);
      if (heard > 3) e.setNotesOn(false);
    }

    if (prevT !== null && t < 0 && Math.floor(t) > Math.floor(prevT) && Math.floor(t) >= -9 && Math.floor(t) <= -1) {
      e.tick(now, Math.floor(t) >= -3);
    }

    if (heard <= 0) {
      e.rocketLevel.gain.setTargetAtTime(0, now, 0.05);
    } else {
      if (prevHeard !== null && prevHeard <= 0) e.thump(now);
      const em = emissionTime(t, pad);
      const spool = smoothstep(em, IGNITION, IGNITION + 1.2);
      const buildUp = 0.55 + 0.45 * smoothstep(em, -0.5, 6);
      const a = altAt(em);
      const d = Math.hypot(pad, a);
      const att = pad / d;
      const fade = 1 - smoothstep(t, 27, SIM_END);
      const lvl = spool * buildUp * fade;
      const low = lvl * att ** 0.7;
      const crack = smoothstep(em, IGNITION + 0.3, IGNITION + 2.5) * lvl * att ** 1.6;
      const radial = (velAt(em) * a) / d;
      const rate = clamp(C / (C + radial), 0.6, 1);
      const T = 0.06;
      e.rocketLevel.gain.setTargetAtTime(1, now, T);
      e.subGain.gain.setTargetAtTime(0.9 * low, now, T);
      e.modDepth.gain.setTargetAtTime(0.6 * low * (0.35 + 0.65 * (1 - att)), now, T);
      e.bodyGain.gain.setTargetAtTime(0.55 * lvl * att, now, T);
      e.bodyLP.frequency.setTargetAtTime(clamp(9000 * att ** 1.6, 220, 9000), now, T);
      e.crackGain.gain.setTargetAtTime(0.6 * crack, now, T);
      e.crackLP.frequency.setTargetAtTime(clamp(14000 * att ** 1.8, 300, 14000), now, T);
      for (const s of e.rocketSources) s.playbackRate.setTargetAtTime(rate, now, 0.2);
    }

    lastPhase = h.phase;
    prevT = t;
    prevHeard = heard;
  }

  return {
    async enable() {
      if (!ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new Ctor();
        const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
        if (session) session.type = 'playback';
      }
      const resumed = isLive() ? (ctx as AudioContext).resume() : Promise.resolve();
      const fresh = !eng;
      if (!eng) eng = build(ctx);
      const wasEnabled = enabled;
      enabled = true;
      applyMaster();
      if (fresh || !wasEnabled) startMusic();
      if (isLive() && !timer) {
        timer = window.setInterval(pump, 25);
        document.addEventListener('visibilitychange', onVisibility);
      }
      pump();
      await resumed;
    },
    async disable() {
      enabled = false;
      applyMaster();
      if (timer) {
        clearInterval(timer);
        timer = 0;
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (isLive()) {
        await new Promise((r) => setTimeout(r, 250));
        if (!enabled) await (ctx as AudioContext).suspend();
      }
    },
    setMuted(m: boolean) {
      muted = m;
      applyMaster();
    },
    update,
    pump,
    dispose() {
      enabled = false;
      if (timer) clearInterval(timer);
      timer = 0;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      if (ownsContext && isLive()) (ctx as AudioContext).close();
      ctx = null;
      eng = null;
    },
    get enabled() {
      return enabled;
    },
    get muted() {
      return muted;
    },
  };
}
