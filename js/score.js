/* score.js — 烬渊 seeded generative score: per-zone ambience beds + background music in WebAudio (audio-score → audio-int).
 * Classic script, no dependencies, never touches Math.random (own PRNG streams) and never reads or writes game state,
 * so seeded fights are bit-identical with music on or off. The second block at the bottom (G.music) is the game glue:
 * it reads game state (zone, combat stamps, boss) and drives the engine; it only exists when window.G does.
 *
 *   const S = CinderScore.create(ctx, { seed, music: node, ambience: node, mode: 'live'|'loop', loopBars, ambLoop, hq, lite,
 *                                       reverb: node (shared reverb input, used instead of the zone's own IR when verb: 'shared'), log });
 *   S.setZone('ash');          // builds the zone's voices / reverb; crossfades from the previous zone
 *   S.setIntensity(0|1|2);     // 0 explore, 1 fight, 2 boss — applied on the next beat, layers ramp over one beat
 *   S.start(t) / S.stop(t, fade)
 *   S.pause(fade) / S.resume() // stop every live source and disconnect the zone (no nodes, no CPU) / rebuild the beds and go on
 *   S.setParts(music, amb)     // per-output on/off: an off output is disconnected and not scheduled
 *   S.tick(now)                // schedule everything up to now + lookahead (live: S.run() calls it on a timer)
 *   S.live()                   // sources still scheduled to sound (0 after pause)
 *
 * mode 'live' (approach A): endless, sections generated forever from the performance PRNG.
 * mode 'loop' (approach B renderer): the music plan is loopBars long and repeats exactly, ambience events and
 *   modulation repeat every ambLoop seconds, so rendering [0, 2L) and keeping [L, 2L) gives a steady-state loop.
 *
 * Tools: tools/score/ (lab.html + render.mjs render through OfflineAudioContext, analyze.mjs / listen.mjs do the checks).
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- utils
  function prng(seed) {
    let a = seed >>> 0 || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
  function pickW(r, obj) {
    let tot = 0;
    for (const k in obj) tot += obj[k];
    let x = r() * tot;
    for (const k in obj) {
      x -= obj[k];
      if (x <= 0) return k;
    }
    return Object.keys(obj)[0];
  }
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  // ---------------------------------------------------------------- zone themes
  // chords: name -> [root semitones above tonic, [shape variants as intervals]]
  // walk: Markov weights between chord names; cadence: chords allowed as the last chord before the section restarts on 'i'
  // grid: steps per bar, beat = steps per beat, bpm = beats per minute
  const ZONES = {
    // audio-int brightening (ash / frost / rift explore): major-leaning walks, higher pad (pad.lo/hi) and lead registers,
    // brighter pad cutoffs, more melody / glints and an explore-only arpeggio (arp). fightSwap / fscale turn the bright
    // chords back into their minor forms while intensity ≥ 1, so fights keep their edge. abyss / crown are unchanged.
    ash: {
      label: '灰烬荒原', tonic: 50, scale: [0, 2, 4, 5, 7, 9, 10], fscale: [0, 2, 3, 5, 7, 9, 10], bpm: 76, grid: 16, beat: 4, start: 'I',
      chords: { I: [0, [[0, 4, 7], [0, 4, 7, 14], [0, 7, 14]]], IV: [5, [[0, 4, 7], [0, 4, 7, 14]]], bVII: [10, [[0, 4, 7], [0, 2, 7]]], ii: [2, [[0, 3, 7], [0, 3, 7, 10]]], vi: [9, [[0, 3, 7]]], v: [7, [[0, 3, 7]]],
        i: [0, [[0, 3, 7], [0, 2, 7], [0, 3, 7, 14]]], III: [3, [[0, 4, 7]]] },
      walk: { I: { IV: 4, bVII: 3, ii: 2, vi: 2 }, IV: { I: 4, bVII: 2, ii: 1, vi: 1 }, bVII: { I: 3, IV: 3, vi: 1 }, ii: { IV: 2, bVII: 2, I: 1, v: 1 }, vi: { IV: 3, ii: 2, bVII: 1 }, v: { IV: 2, I: 2 } },
      fightSwap: { I: 'i', vi: 'III' },
      cadence: ['bVII', 'IV', 'v'], hr: [[2, 2], [2, 1, 1], [1, 1, 2], [4]],
      pad: { wave: 'warm', cut: 1500, att: 1.8, rel: 2.6, lvl: 0.055, det: 7, lo: 55, hi: 76 },
      lead: { kind: 'pluck', ratio: 1, idx: 1.7, dec: 2.4, lvl: 0.16, lo: 67, hi: 84 }, answer: { kind: 'hum', lvl: 0.05 },
      arp: { kind: 'pluck', ratio: 2, idx: 0.9, dec: 1.4, lvl: 0.05, every: 2, p: 0.7 },
      bass: { lvl: 0.06 }, ost: { lvl: 0.098, cut: 700 }, perc: { kit: 'frame', lvl: 0.416 }, choir: null,
      glint: 0.45, melodyP: 0.72, verb: 2.4, send: 0.32,
      cells: [[4, 4, 8], [2, 2, 4, 8], [6, 2, 8], [4, 2, 2, 8], [3, 3, 2, 8]],
      amb: { verb: 1.3, send: 0.12, layers: [
        { type: 'wind', f: [320, 900], q: 0.8, lvl: 0.10, rate: 0.07 },
        { type: 'rumble', f: 85, lvl: 0.26, rate: 0.05 },
        { type: 'crackle', rate: 4.5, f: [900, 2200], lvl: 0.05, cluster: 0.35 },
        { type: 'hiss', f: 1400, lvl: 0.012, rate: 0.11 },
      ] },
    },
    frost: {
      label: '霜骨沼泽', tonic: 52, scale: [0, 2, 3, 5, 7, 9, 10], fscale: [0, 2, 3, 5, 7, 8, 10], bpm: 63, grid: 12, beat: 4,
      chords: { i: [0, [[0, 7, 14], [0, 3, 7, 14], [0, 3, 7]]], III: [3, [[0, 4, 7], [0, 4, 7, 14]]], IV: [5, [[0, 4, 7], [0, 4, 7, 14]]], VII: [10, [[0, 4, 7], [0, 2, 7]]], v: [7, [[0, 3, 7]]],
        iv: [5, [[0, 3, 7], [0, 3, 7, 10]]] },
      walk: { i: { III: 3, IV: 3, VII: 2, v: 1 }, III: { IV: 2, VII: 2, i: 2 }, IV: { i: 3, VII: 2, III: 1 }, VII: { i: 3, III: 2, IV: 1 }, v: { III: 2, IV: 2, i: 1 } },
      fightSwap: { IV: 'iv' },
      cadence: ['VII', 'IV'], hr: [[2, 2], [4], [2, 1, 1]],
      pad: { wave: 'glass', cut: 2000, att: 2.4, rel: 3.2, lvl: 0.06, det: 5, lo: 57, hi: 79 },
      lead: { kind: 'bell', ratio: 3.5, idx: 1.1, dec: 3.6, lvl: 0.11, lo: 69, hi: 86 }, answer: { kind: 'pluck', ratio: 2, idx: 1.0, dec: 2.0, lvl: 0.1 },
      arp: { kind: 'bell', ratio: 3, idx: 0.6, dec: 1.8, lvl: 0.04, every: 2, p: 0.6 },
      bass: { lvl: 0.05 }, ost: { lvl: 0.084, cut: 600 }, perc: { kit: 'soft', lvl: 0.338 }, choir: null,
      glint: 0.5, melodyP: 0.65, verb: 3.4, send: 0.42,
      cells: [[3, 3, 6], [6, 3, 3], [2, 2, 2, 6], [4, 2, 6], [6, 6]],
      amb: { verb: 2.6, send: 0.2, layers: [
        { type: 'water', f: [380, 700], lvl: 0.08, rate: 0.2 },
        { type: 'wind', f: [600, 1300], q: 1.1, lvl: 0.04, rate: 0.05 },
        { type: 'creak', every: [4, 11], f: [480, 900], lvl: 0.10 },
        { type: 'drip', rate: 0.45, lvl: 0.035 },
        { type: 'clack', every: [9, 20], lvl: 0.05 },
      ] },
    },
    storm: {
      label: '雷鸣遗迹', legacyDeg: true, tonic: 43, scale: [0, 2, 4, 5, 7, 8, 10], bpm: 88, grid: 16, beat: 4,
      chords: { I: [0, [[0, 4, 7], [0, 7, 12]]], bVI: [8, [[0, 4, 7], [0, 7, 12]]], bVII: [10, [[0, 4, 7], [0, 5, 7]]], iv: [5, [[0, 3, 7]]], v: [7, [[0, 3, 7], [0, 5, 7]]] },
      walk: { I: { bVI: 3, bVII: 3, iv: 2 }, bVI: { bVII: 3, I: 2, iv: 1 }, bVII: { I: 3, bVI: 1, v: 1 }, iv: { I: 2, bVI: 2, v: 1 }, v: { bVI: 2, I: 1, iv: 2 } },
      start: 'I', cadence: ['bVII', 'iv'], hr: [[2, 2], [1, 1, 2], [2, 1, 1]],
      pad: { wave: 'reed', cut: 900, att: 1.4, rel: 2.2, lvl: 0.05, det: 6 },
      lead: { kind: 'horn', lvl: 0.07, lo: 55, hi: 72 }, answer: { kind: 'pluck', ratio: 1, idx: 1.4, dec: 1.6, lvl: 0.12 },
      bass: { lvl: 0.06 }, ost: { lvl: 0.105, cut: 650 }, perc: { kit: 'taiko', lvl: 0.468 }, choir: null,
      glint: 0.2, melodyP: 0.5, verb: 2.6, send: 0.3,
      cells: [[4, 4, 8], [6, 2, 4, 4], [2, 2, 4, 8], [8, 8], [3, 3, 2, 8]],
      amb: { verb: 2.2, send: 0.22, layers: [
        { type: 'wind', f: [240, 700], q: 0.7, lvl: 0.12, rate: 0.12, gust: 1 },
        { type: 'whistle', f: [620, 980], lvl: 0.012, rate: 0.06 },
        { type: 'thunder', every: [13, 27], lvl: 0.35 },
        { type: 'clack', every: [7, 16], lvl: 0.06 },
      ] },
    },
    abyss: {
      label: '烬渊深处', legacyDeg: true, tonic: 49, scale: [0, 1, 3, 5, 7, 8, 10], bpm: 54, grid: 16, beat: 4,
      chords: { i: [0, [[0, 7], [0, 7, 15], [0, 3, 7]]], bII: [1, [[0, 4, 7], [0, 7]]], iv: [5, [[0, 3, 7], [0, 7]]], bVI: [8, [[0, 4, 7]]], bvii: [10, [[0, 3, 7]]], cl: [0, [[0, 1, 7], [0, 2, 3, 7]]] },
      walk: { i: { bII: 3, iv: 2, bvii: 2, cl: 1 }, bII: { i: 4, bvii: 1 }, iv: { i: 2, bII: 2, bVI: 1 }, bVI: { bII: 2, i: 2 }, bvii: { i: 3, iv: 1 }, cl: { i: 3 } },
      cadence: ['bII', 'bvii'], hr: [[2, 2], [4], [4]], tension: ['cl'],
      pad: { wave: 'hollow', cut: 700, att: 3.2, rel: 4.0, lvl: 0.07, det: 11 },
      lead: { kind: 'bell', ratio: 1.41, idx: 0.9, dec: 5.0, lvl: 0.1, lo: 49, hi: 68 }, answer: { kind: 'hum', lvl: 0.045 },
      bass: { lvl: 0.07 }, ost: { lvl: 0.098, cut: 450 }, perc: { kit: 'pulse', lvl: 0.52 }, choir: null,
      glint: 0.15, melodyP: 0.3, verb: 4.5, send: 0.45,
      cells: [[8, 8], [4, 4, 8], [12, 4], [6, 2, 8]],
      amb: { verb: 4.2, send: 0.3, layers: [
        { type: 'drone', f: 55.4, lvl: 0.06, rate: 0.03 },
        { type: 'breath', f: 230, lvl: 0.05, rate: 0.09 },
        { type: 'rumble', f: 60, lvl: 0.12, rate: 0.03 },
        { type: 'shimmer', rate: 0.08, lvl: 0.012, base: 61, scale: [0, 1, 5, 7, 8] },
      ] },
    },
    rift: {
      label: '坠星裂谷', tonic: 53, scale: [0, 2, 4, 6, 7, 9, 11], bpm: 70, grid: 12, beat: 6,
      chords: { I: [0, [[0, 4, 7], [0, 4, 7, 14], [0, 7, 14]]], II: [2, [[0, 4, 7], [0, 4, 7, 14]]], iii: [4, [[0, 3, 7]]], V: [7, [[0, 4, 7], [0, 2, 7]]], vi: [9, [[0, 3, 7], [0, 3, 7, 14]]],
        i: [0, [[0, 3, 7], [0, 7, 14]]], ii: [2, [[0, 3, 7]]], v: [7, [[0, 3, 7], [0, 7, 12]]], bIII: [3, [[0, 4, 7]]] },
      walk: { I: { II: 4, vi: 2, V: 1, iii: 1 }, II: { I: 3, iii: 1, vi: 2 }, vi: { II: 2, V: 2, I: 1 }, V: { I: 2, II: 2 }, iii: { vi: 2, II: 1 } },
      fightSwap: { I: 'i', II: 'ii', V: 'v', iii: 'bIII' }, fscale: [0, 2, 3, 5, 7, 9, 10],
      start: 'I', cadence: ['II', 'V'], hr: [[2, 2], [1, 1, 2], [4]],
      pad: { wave: 'glass', cut: 2200, att: 2.0, rel: 3.0, lvl: 0.05, det: 6, lo: 57, hi: 79 },
      lead: { kind: 'bell', ratio: 3, idx: 1.0, dec: 3.2, lvl: 0.1, lo: 67, hi: 86 }, answer: { kind: 'pluck', ratio: 2, idx: 1.2, dec: 1.8, lvl: 0.1 },
      arp: { kind: 'pluck', ratio: 2, idx: 1.0, dec: 1.6, lvl: 0.045, every: 2, p: 0.75 },
      bass: { lvl: 0.05 }, ost: { lvl: 0.084, cut: 700 }, perc: { kit: 'frame', lvl: 0.338 }, choir: null,
      glint: 0.55, melodyP: 0.72, verb: 3.8, send: 0.42,
      cells: [[3, 3, 6], [6, 3, 3], [2, 2, 2, 6], [3, 3, 3, 3], [6, 6]],
      amb: { verb: 3.2, send: 0.3, layers: [
        { type: 'wind', f: [500, 1100], q: 0.9, lvl: 0.035, rate: 0.05 },
        { type: 'shimmer', rate: 0.6, lvl: 0.02, base: 77, scale: [0, 2, 4, 6, 7, 9, 11] },
        { type: 'hum', f: 87.3, lvl: 0.035, rate: 0.04 },
        { type: 'crackle', rate: 0.8, f: [1500, 2600], lvl: 0.02, cluster: 0.1 },
      ] },
    },
    crown: {
      label: '余烛殿', legacyDeg: true, tonic: 47, scale: [0, 2, 3, 5, 7, 8, 11], bpm: 66, grid: 16, beat: 4,
      chords: { i: [0, [[0, 3, 7], [0, 3, 7, 14]]], iv: [5, [[0, 3, 7]]], VI: [8, [[0, 4, 7], [0, 4, 7, 11]]], V: [7, [[0, 4, 7], [0, 4, 7, 10]]], III: [3, [[0, 4, 7]]] },
      walk: { i: { VI: 3, iv: 3, III: 1, V: 1 }, iv: { V: 3, i: 2, VI: 1 }, VI: { iv: 2, V: 2, III: 1 }, V: { i: 4, VI: 1 }, III: { VI: 2, iv: 2 } },
      cadence: ['V'], hr: [[2, 2], [2, 1, 1], [1, 1, 1, 1]],
      pad: { wave: 'organ', cut: 1300, att: 2.0, rel: 3.0, lvl: 0.045, det: 3 },
      lead: { kind: 'hum', lvl: 0.06, lo: 59, hi: 76 }, answer: { kind: 'bell', ratio: 1.41, idx: 0.8, dec: 4.0, lvl: 0.09 },
      bass: { lvl: 0.065 }, ost: { lvl: 0.112, cut: 600 }, perc: { kit: 'taiko', lvl: 0.494 }, choir: { lvl: 0.018 },
      glint: 0.2, melodyP: 0.45, verb: 4.2, send: 0.4,
      cells: [[4, 4, 8], [8, 4, 4], [6, 2, 8], [4, 2, 2, 8]],
      amb: { verb: 3.8, send: 0.35, layers: [
        { type: 'fire', f: 260, lvl: 0.06, rate: 0.5 },
        { type: 'crackle', rate: 3.0, f: [800, 1900], lvl: 0.04, cluster: 0.3 },
        { type: 'rumble', f: 70, lvl: 0.08, rate: 0.04 },
        { type: 'wind', f: [180, 420], q: 0.7, lvl: 0.035, rate: 0.03 },
      ] },
    },
  };
  // intensity -> layer gains (explore / fight / boss)
  const LAYER_GAIN = {
    // audio-int: boss ost / perc 1.15 / 1.25 → 1.0 / 1.05 (the boss mix sat +2.9 LU over explore and ate the hit-band margin)
    pad: [1, 0.85, 0.85], lead: [1, 0.6, 0.55], bass: [1, 0.5, 0.45], ost: [0, 1, 1.0], perc: [0, 1, 1.05], choir: [0, 0, 1], arp: [1, 0, 0],
  };
  // per-zone loudness trims (dB) from calibration renders (tools/score/README.md)
  // audio-int: re-measured after the brightening and the ambience hit-band cut (targets: explore music −23 LUFS, ambience −29 LUFS)
  const TRIM = { ash: { m: -0.7, a: 10.2 }, frost: { m: -0.7, a: 12.7 }, storm: { m: -0.7, a: 6.2 }, abyss: { m: -2.6, a: 3.7 }, rift: { m: 0.1, a: 5.8 }, crown: { m: -0.1, a: 14.0 } };

  // loop length in frames: a whole number of 128-frame render quanta, so every period meets the renderer in the same phase
  function loopFrames(th, bars, sr) {
    return Math.round((bars * th.grid * 60 * sr) / th.bpm / th.beat / 128) * 128;
  }

  // ---------------------------------------------------------------- engine
  function create(ctx, opts) {
    opts = opts || {};
    const sr = ctx.sampleRate;
    const seed = (opts.seed >>> 0) || 1;
    const loop = opts.mode === 'loop';
    const hq = !!opts.hq;
    const lite = !!opts.lite; // 低 画质 profile: fewer pad voices, shorter reverbs, thinner ambience grains
    const LOOK = opts.lookahead || 1.2;
    const musicOut = opts.music || ctx.destination;
    const ambOut = opts.ambience || ctx.destination;
    // reverb per output: 'own' (the zone's IR, sliced convolvers), 'shared' (send into opts.reverb, e.g. G.audio.reverb()), 'none'
    const mVerbMode = opts.mVerb || 'own';
    const aVerbMode = opts.aVerb || (lite ? 'none' : 'own');
    let partM = true, partA = true; // setParts
    let paused = false;
    // every source node the engine starts, with its stop time: pause() stops the ones still due to sound
    let liveSrc = [];
    function track(n) {
      n.__end = Infinity;
      const st = n.stop;
      n.stop = function (t) {
        n.__end = t === undefined ? 0 : t;
        return st.call(n, t);
      };
      liveSrc.push(n);
      return n;
    }
    const osc = () => track(ctx.createOscillator());
    const bsrc = () => track(ctx.createBufferSource());
    function pruneLive(now) {
      let j = 0;
      for (let i = 0; i < liveSrc.length; i++) if (liveSrc[i].__end > now) liveSrc[j++] = liveSrc[i];
      liveSrc.length = j;
    }
    const log = opts.log ? [] : null;
    const stats = { ticks: 0, tickMs: [], nodes: 0, voices: 0, maxVoices: 0, initMs: 0 };
    const ends = []; // voice end times for the concurrency count

    let Z = null; // current zone graph
    let started = false;
    let t0 = 0;
    let intensity = opts.intensity | 0;
    let pending = intensity;
    let timer = null;

    function voice(start, end) {
      stats.voices++;
      for (let i = ends.length - 1; i >= 0; i--) if (ends[i] <= start) ends.splice(i, 1);
      ends.push(end);
      if (ends.length > stats.maxVoices) stats.maxVoices = ends.length;
    }
    const N = (n) => ((stats.nodes += n), n);
    const c0 = (typeof performance !== 'undefined' ? performance : Date).now();

    // ------------------------------------------------ shared buffers / waves (built once per engine)
    const noiseLen = Math.round((loop ? (opts.ambLoop || 64) / 16 : 5.37) * sr);
    const noise = ctx.createBuffer(2, noiseLen, sr);
    // heavy buffer fills run as sliced jobs (pump), so no single main-thread slice gets long
    const jobs = [];
    stats.pumpMs = [];
    stats.convMs = [];
    function pump(budget) {
      if (!jobs.length) return;
      const p0 = (typeof performance !== 'undefined' ? performance : Date).now();
      while (jobs.length && (typeof performance !== 'undefined' ? performance : Date).now() - p0 < budget) if (jobs[0]()) jobs.shift();
      stats.pumpMs.push((typeof performance !== 'undefined' ? performance : Date).now() - p0);
    }
    const CH = 16384; // samples per job step
    {
      const r = prng(seed ^ 0xa5a5);
      let c = 0, i = 0;
      jobs.push(() => {
        const d = noise.getChannelData(c);
        const e = Math.min(d.length, i + CH);
        for (; i < e; i++) d[i] = r() * 2 - 1;
        if (i >= d.length) (c++, (i = 0));
        return c >= 2;
      });
    }
    stats.createMs = (typeof performance !== 'undefined' ? performance : Date).now() - c0;
    const waves = {};
    function wave(name) {
      if (waves[name]) return waves[name];
      const n = 24;
      const re = new Float32Array(n), im = new Float32Array(n);
      for (let k = 1; k < n; k++) {
        let a = 0;
        if (name === 'warm') a = 1 / Math.pow(k, 1.7);
        else if (name === 'glass') a = k === 1 ? 1 : k === 2 ? 0.25 : k === 3 ? 0.18 : k === 5 ? 0.08 : 0.0;
        else if (name === 'reed') a = k % 2 ? 1 / Math.pow(k, 1.3) : 0.08 / k;
        else if (name === 'hollow') a = k % 2 ? 1 / (k * k) : 0;
        else if (name === 'organ') a = { 1: 1, 2: 0.6, 3: 0.35, 4: 0.3, 6: 0.15, 8: 0.12 }[k] || 0;
        else if (name === 'hum') a = k === 1 ? 1 : k === 2 ? 0.3 : k === 3 ? 0.12 : 0;
        im[k] = a;
      }
      return (waves[name] = ctx.createPeriodicWave(re, im));
    }
    // reverb impulse: decaying, darkening noise + a few early reflections, filled in slices. Live: split into ≤ 1 s
    // segments, each on its own convolver behind a sample-exact delay (convolution is linear, so the sum is the same IR),
    // so each convolver's own setup on the main thread stays short. Normalised once over the whole IR (Chrome's formula).
    function queueIR(seconds, bright, rs) {
      const inp = ctx.createGain(), out = ctx.createGain();
      if (opts.noVerb) return { inp, out }; // cost breakdown only
      // live: truncate at 0.65·RT60 (≤ 2.2 s, faded)
      const len = Math.max(128, Math.round((loop ? seconds : Math.min(seconds * 0.65, 2.2)) * sr));
      const fadeAt = Math.round(len * 0.85);
      const data = [new Float32Array(len), new Float32Array(len)];
      const r = prng(rs);
      const pre = Math.round(0.018 * sr);
      const de = Math.exp(-6.9 / seconds / sr); // −60 dB at `seconds`
      const dk = Math.exp(-1.6 / sr); // darker as it decays
      let c = 0, i = pre, lp = 0, env = 1, k = clamp(bright, 0.03, 0.95), power = 0;
      jobs.push(() => {
        const d = data[c];
        const e = Math.min(len, i + CH);
        for (; i < e; i++) {
          lp += k * (r() * 2 - 1 - lp);
          const x = lp * env * (i > fadeAt ? (len - i) / (len - fadeAt) : 1);
          d[i] = x;
          power += x * x;
          env *= de;
          if (k > 0.03) k *= dk;
        }
        if (i < len) return false;
        for (let q = 0; q < 6; q++) {
          const at = pre + Math.round((0.008 + r() * 0.05) * sr);
          if (at < len) d[at] += (0.5 - q * 0.06) * (r() < 0.5 ? -1 : 1);
        }
        c++;
        (i = pre), (lp = 0), (env = 1), (k = clamp(bright, 0.03, 0.95));
        return c >= 2;
      });
      const seg = loop ? len : Math.round((sr * (opts.segS || 1)) / 128) * 128;
      for (let s0 = 0; s0 < len; s0 += seg) {
        jobs.push(() => {
          const n = Math.min(seg, len - s0);
          const scale = (1 / Math.max(1e-6, Math.sqrt(power / (2 * len)))) * 0.00125 * (44100 / sr);
          const b = ctx.createBuffer(2, n, sr);
          for (let ch = 0; ch < 2; ch++) {
            const src = data[ch], dst = b.getChannelData(ch);
            for (let j = 0; j < n; j++) dst[j] = src[s0 + j] * scale;
          }
          const conv = ctx.createConvolver();
          conv.normalize = false;
          const q0 = (typeof performance !== 'undefined' ? performance : Date).now();
          conv.buffer = b;
          stats.convMs.push((typeof performance !== 'undefined' ? performance : Date).now() - q0);
          if (s0 === 0) inp.connect(conv);
          else {
            const dl = ctx.createDelay(s0 / sr + 0.01);
            dl.delayTime.value = s0 / sr;
            inp.connect(dl);
            dl.connect(conv);
            N(1);
          }
          conv.connect(out);
          N(1);
          return true;
        });
      }
      N(2);
      return { inp, out };
    }
    // periodic-or-not modulation: sum of sines; in loop mode each frequency gets an integer cycle count per period
    function makeMod(r, rate, period) {
      const parts = [];
      let tot = 0;
      for (let i = 0; i < 4; i++) {
        let f = rate * (0.5 + r() * 1.5) * (i + 1) * 0.6;
        if (period) f = Math.max(1, Math.round(f * period)) / period;
        const a = 1 / (i + 1);
        tot += a;
        parts.push([f, r() * 6.283, a]);
      }
      return (t) => {
        let s = 0;
        for (const [f, ph, a] of parts) s += a * Math.sin(6.283185307 * f * t + ph);
        return s / tot; // ~[-1, 1]
      };
    }

    // no own IR: 'shared' sends into opts.reverb (out stays silent), 'none' goes nowhere
    function verbStub(mode) {
      const inp = ctx.createGain(), out = ctx.createGain();
      if (mode === 'shared' && opts.reverb) inp.connect(opts.reverb);
      return { inp, out };
    }
    function wire(z) {
      const m = partM && !paused, a = partA && !paused;
      if (m !== z.mOn) (m ? z.mGain.connect(musicOut) : z.mGain.disconnect(), (z.mOn = m));
      if (a !== z.aOn) (a ? z.aGain.connect(ambOut) : z.aGain.disconnect(), (z.aOn = a));
    }

    // ------------------------------------------------ zone graph
    function buildZone(id) {
      const tStart = (typeof performance !== 'undefined' ? performance : Date).now();
      const th = ZONES[id];
      const zs = hashStr(id); // theme seed: the zone's motif / patterns stay recognisable across sessions
      const tr = (opts.trim && opts.trim[id]) || TRIM[id] || { m: 0, a: 0 };
      const z = { id, th, nodes: [] };
      z.themeR = prng(zs);
      z.perfR = prng(zs ^ seed);
      z.ambR = prng((zs * 31) ^ seed ^ 0x5151);
      // music chain: layers -> pre -> EQ (shelf down the 2–5 kHz hit band, gentle top cut) -> dry + reverb -> zone gain -> musicOut
      z.mGain = ctx.createGain();
      z.mGain.gain.value = Math.pow(10, tr.m / 20);
      z.mPre = ctx.createGain();
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 2500;
      shelf.gain.value = -4;
      const top = ctx.createBiquadFilter();
      top.type = 'lowpass';
      top.frequency.value = 6500;
      top.Q.value = 0.5;
      const mVerb = mVerbMode === 'own' ? queueIR(th.verb * (lite ? 0.45 : hq ? 1.25 : 1), 0.5, zs ^ 0x77) : verbStub(mVerbMode);
      const mSend = ctx.createGain();
      mSend.gain.value = th.send * (mVerbMode === 'shared' ? 0.6 : 1);
      z.mPre.connect(shelf);
      shelf.connect(top);
      top.connect(z.mGain);
      top.connect(mSend);
      mSend.connect(mVerb.inp);
      mVerb.out.connect(z.mGain);
      z.mLvl = z.mGain.gain.value;
      z.mOn = false; // connected to musicOut (beginZone / setParts / pause manage it)
      z.layer = {};
      for (const k of Object.keys(LAYER_GAIN)) {
        const g = ctx.createGain();
        g.gain.value = LAYER_GAIN[k][intensity];
        g.connect(z.mPre);
        z.layer[k] = g;
      }
      N(8 + 6);
      // ambience chain
      z.aGain = ctx.createGain();
      z.aGain.gain.value = Math.pow(10, tr.a / 20);
      z.aPre = ctx.createGain();
      const aTop = ctx.createBiquadFilter();
      aTop.type = 'lowpass';
      aTop.frequency.value = 7000;
      // audio-int: carve the 2–5 kHz hit band out of the beds (crackle / hiss sat only ~5 dB under busy sfx there)
      const aCut = ctx.createBiquadFilter();
      aCut.type = 'peaking';
      aCut.frequency.value = 3200;
      aCut.Q.value = 0.7;
      aCut.gain.value = -8;
      // 低: no ambience reverb (the beds are noise-like; the reverb is most of the audio cost)
      const aVerb = aVerbMode === 'own' ? queueIR(th.amb.verb, 0.4, zs ^ 0x99) : verbStub(aVerbMode);
      const aSend = ctx.createGain();
      aSend.gain.value = th.amb.send * (aVerbMode === 'shared' ? 0.6 : 1);
      z.aPre.connect(aCut);
      aCut.connect(aTop);
      aTop.connect(z.aGain);
      aTop.connect(aSend);
      aSend.connect(aVerb.inp);
      aVerb.out.connect(z.aGain);
      z.aLvl = z.aGain.gain.value;
      z.aOn = false;
      N(7);
      // music plan state
      z.motif = makeMotif(z.themeR, th);
      z.ostPat = makeOst(z.themeR, th);
      z.percPat = makePerc(z.themeR, th);
      z.sections = [];
      z.lastDeg = null;
      z.voicing = null;
      z.bar = 0;
      z.step = 0;
      z.nextStepT = 0;
      z.ambLayers = th.amb.layers.map((L, i) => makeAmbLayer(z, L, i));
      if (opts.ambMask) z.ambLayers = z.ambLayers.filter((A) => opts.ambMask.includes(A.L.type)); // tools only: render single layers
      z.ambT = 0; // automation scheduled up to here
      if (loop) {
        const bars = opts.loopBars || 32;
        const r = prng(zs ^ seed ^ 0x1234);
        let prev = null;
        for (let s = 0; s < bars / 16; s++) {
          const sec = planSection(r, z, prev, s === bars / 16 - 1);
          z.sections.push(sec);
          prev = sec;
        }
        z.loopSections = z.sections.length;
      }
      stats.initMs += (typeof performance !== 'undefined' ? performance : Date).now() - tStart;
      return z;
    }

    // ------------------------------------------------ plan generation
    // the zone's motif: one bar, mostly steps with an occasional leap; redrawn (same stream) until it spans ≥ 3 scale steps,
    // so it reads as a shape rather than a note repeated
    function makeMotif(r, th) {
      let m = null;
      for (let k = 0; k < 12; k++) {
        m = drawMotif(r, th);
        const ss = m.map((n) => n.s);
        if (Math.max(...ss) - Math.min(...ss) >= 3 && new Set(ss).size >= Math.min(3, ss.length)) break;
      }
      return m;
    }
    function drawMotif(r, th) {
      const cell = pick(r, th.cells).slice();
      const notes = [];
      let s = pick(r, [0, 2, 4]);
      let pos = 0;
      for (let i = 0; i < cell.length; i++) {
        notes.push({ s, at: pos, d: cell[i] });
        pos += cell[i];
        const leap = r() < 0.2;
        s += leap ? pick(r, [3, -3, 4, -2]) : pick(r, [1, -1, 2, -1, 1, -2]);
      }
      return notes;
    }
    function makeOst(r, th) {
      const pat = [];
      const every = th.grid === 12 ? 2 : 2;
      for (let st = 0; st < th.grid; st += every) {
        if (st === 0) pat.push({ st, v: 'r', acc: 1 });
        else if (r() < 0.62) pat.push({ st, v: pick(r, ['r', 'r', 'f', 'o', 'f']), acc: st % th.beat === 0 ? 0.9 : 0.65 });
      }
      return pat;
    }
    function makePerc(r, th) {
      const g = th.grid;
      const drum = [{ st: 0, v: 1 }];
      const half = g === 16 ? 8 : th.beat === 6 ? 6 : 8;
      drum.push({ st: pick(r, g === 16 ? [8, 10, 6] : [half, half, half + 2 < g ? half + 2 : half]), v: 0.75 });
      if (r() < 0.5 && g === 16) drum.push({ st: pick(r, [3, 11, 14]), v: 0.5 });
      const tok = [];
      for (let st = 2; st < g; st += 4 > g / 4 ? 2 : 4) if (r() < 0.5) tok.push({ st, v: 0.4 + r() * 0.3 });
      if (!tok.length) tok.push({ st: g / 2 + (g === 16 ? 2 : 1), v: 0.5 });
      const boss = [];
      for (const st of g === 16 ? [4, 12, 14, 15] : [3, 9, 10, 11]) if (r() < 0.6) boss.push({ st, v: 0.55 });
      return { drum, tok, boss };
    }
    function planSection(r, z, prev, last) {
      const th = z.th;
      const start = th.start || 'i';
      const bars = [];
      const chordSeq = [];
      let name = start;
      for (let p = 0; p < 4; p++) {
        const hr = pick(r, th.hr);
        for (let k = 0; k < hr.length; k++) {
          if (!(p === 0 && k === 0)) name = pickW(r, th.walk[name]);
          if (p === 3 && k === hr.length - 1) name = pick(r, th.cadence);
          const def = th.chords[name];
          const shape = pick(r, def[1]);
          const c = { name, root: def[0], shape, len: hr[k], tension: !!(th.tension && th.tension.includes(name)) };
          for (let b = 0; b < hr[k]; b++) bars.push({ chord: c, first: b === 0 });
          chordSeq.push(c);
        }
      }
      // melody: per phrase 'M' (motif + answer) or '-' (pad + glints)
      for (let p = 0; p < 4; p++) {
        const M = r() < th.melodyP || (p === 1 && !prev);
        const b0 = p * 4;
        for (let b = 0; b < 4; b++) bars[b0 + b].mel = [];
        if (M) {
          const v1 = variant(r, z.motif, th);
          const v2 = variant(r, z.motif, th, true);
          const off1 = pick(r, [0, 0, th.beat / 2, th.beat]);
          placeMel(bars[b0], v1, off1, th, z, 'lead');
          placeMel(bars[b0 + 2], v2, pick(r, [0, th.beat / 2]), th, z, 'answer');
        } else {
          for (let b = 0; b < 4; b++)
            if (r() < th.glint) bars[b0 + b].mel.push({ st: pick(r, [0, th.beat, 2 * th.beat, th.beat + th.beat / 2].filter((x) => x < th.grid)), s: pick(r, [0, 2, 4, 7]), d: th.grid, voice: 'glint', glint: true });
        }
        // thinning flags for fights: keep every other melody note, always the phrase head
        for (let b = 0; b < 4; b++) bars[b0 + b].mel.forEach((n, i) => (n.keep = i % 2 === 0 || n.head));
        // explore arpeggio (zones with th.arp): full density in pad-only phrases, light in the gaps of melody phrases
        if (th.arp) for (let b = 0; b < 4; b++) bars[b0 + b].arp = M ? (b % 2 ? 0.4 : 0) : 1;
      }
      return { bars, chordSeq };
    }
    function variant(r, motif, th, answer) {
      const op = pick(r, answer ? ['shift', 'inv', 'tail', 'ret', 'orig'] : ['orig', 'orig', 'shift', 'aug', 'frag', 'tail']);
      let v = motif.map((n) => ({ s: n.s, at: n.at, d: n.d }));
      if (op === 'shift') {
        const k = pick(r, [1, -1, 2, -2, 3]);
        v.forEach((n) => (n.s += k));
      } else if (op === 'inv') {
        const s0 = v[0].s;
        v.forEach((n) => (n.s = s0 - (n.s - s0)));
      } else if (op === 'aug') {
        v.forEach((n) => ((n.at *= 2), (n.d *= 2)));
        v = v.filter((n) => n.at < th.grid * 2);
      } else if (op === 'frag') {
        v = v.slice(0, 3);
        v[v.length - 1].d = th.grid;
      } else if (op === 'tail') {
        v[v.length - 1].s += pick(r, [1, -1, 2]);
      } else if (op === 'ret') {
        const ss = v.map((n) => n.s).reverse();
        v.forEach((n, i) => (n.s = ss[i]));
      }
      if (answer && r() < 0.5) v[v.length - 1].s = Math.round(v[v.length - 1].s / 7) * 7; // land on the chord root
      v[0].head = true;
      return v;
    }
    function placeMel(bar, v, off, th, z, voice) {
      for (const n of v) {
        const st = n.at + off;
        if (st < th.grid * 2) (st < th.grid ? bar.mel : (bar.next = bar.next || [])).push({ st: st % th.grid, s: n.s, d: n.d, voice, head: n.head, spill: st >= th.grid });
      }
    }
    // voice-leading for the pad: chord tones placed in [lo, hi], closest total motion to the previous voicing
    function voice4(th, chord, prev) {
      const lo = th.pad.lo || 52, hi = th.pad.hi || 72;
      const pcs = chord.shape.map((iv) => (th.tonic + chord.root + iv) % 12);
      const uniq = [...new Set(pcs)];
      let best = null, bestCost = 1e9;
      for (let rot = 0; rot < uniq.length; rot++) {
        for (let base = lo; base < lo + 12; base++) {
          if (base % 12 !== uniq[rot]) continue;
          const v = [base];
          for (let k = 1; k < uniq.length; k++) {
            let m = v[v.length - 1] + 1;
            while (m % 12 !== uniq[(rot + k) % uniq.length]) m++;
            v.push(m);
          }
          if (v[v.length - 1] > hi) continue;
          // open up semitone rubs (and whole tones low down) by lifting the upper note an octave — except deliberate clusters
          if (!chord.tension)
            for (let q = 1; q < v.length; q++) {
              const gap = v[q] - v[q - 1];
              if (gap === 1 || (gap === 2 && v[q - 1] < 57)) v[q] += 12;
              v.sort((a, b) => a - b);
            }
          if (v[v.length - 1] > hi + 7) continue;
          let cost = 0;
          if (prev) for (const m of v) cost += Math.min(...prev.map((p) => Math.abs(p - m)));
          else cost = Math.abs(v[0] - (lo + 5));
          if (cost < bestCost) (bestCost = cost), (best = v);
        }
      }
      if (best) return best;
      // fallback: root position from the first root at/above lo, rubs opened the same way
      let m = lo;
      while (m % 12 !== pcs[0]) m++;
      const v = chord.shape.map((iv) => m + iv);
      if (!chord.tension) for (let q = 1; q < v.length; q++) if (v[q] - v[q - 1] === 1) v[q] += 12;
      return v.sort((a, b) => a - b);
    }
    function scaleMidi(th, chordRoot, s, lo, fight) {
      // scale step s counted from the chord root's position in the scale (the fight scale while the fight harmony sounds)
      const sc = (fight && th.fscale) || th.scale;
      let idx0 = 0, bestD = 99;
      for (let i = 0; i < 7; i++) {
        // audio-int: degree 0 = the chord root. The prototype compared the absolute pitch class (chordRoot % 12) with degrees above
        // the tonic, which put every motif on an offset degree (abyss on ♭2, crown on the leading tone); zones with legacyDeg keep that
        // accepted sound unchanged
        const d = Math.abs(sc[i] - (th.legacyDeg ? chordRoot % 12 : (((chordRoot - th.tonic) % 12) + 12) % 12));
        if (d < bestD) (bestD = d), (idx0 = i);
      }
      const idx = idx0 + s;
      const o = Math.floor(idx / 7);
      const m = th.tonic + sc[((idx % 7) + 7) % 7] + 12 * o;
      let x = m;
      while (x < lo) x += 12;
      while (x > lo + 19) x -= 12;
      return x;
    }

    // ------------------------------------------------ music voices
    function env(g, t, a, peak, hold, rel) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + a);
      if (hold > 0) g.gain.setValueAtTime(peak, t + a + hold);
      g.gain.linearRampToValueAtTime(0, t + a + Math.max(0, hold) + rel);
    }
    function pan(x) {
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (p.pan) p.pan.value = clamp(x, -1, 1);
      return p;
    }
    function vPad(z, t, dur, midis, lvlMul) {
      const P = z.th.pad;
      const per = lite ? 1 : hq ? 3 : 2;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 0.6;
      const cut = P.cut * 1.5;
      f.frequency.setValueAtTime(cut * 0.55, t);
      f.frequency.linearRampToValueAtTime(cut, t + P.att + 0.6);
      f.frequency.linearRampToValueAtTime(cut * 0.7, t + dur + P.rel);
      const g = ctx.createGain();
      const lvl = (P.lvl * (lvlMul || 1)) / Math.sqrt(midis.length * per / 2);
      env(g, t, P.att, lvl, Math.max(0, dur - P.att), P.rel);
      f.connect(g);
      g.connect(z.layer.pad);
      const end = t + dur + P.rel + 0.05;
      // one panner per detune layer (not per oscillator): the spread comes from detuned layers sitting left / right
      const pans = [];
      for (let k = 0; k < per; k++) {
        const p = pan(per === 1 ? 0 : (k / (per - 1) - 0.5) * 0.8);
        p.connect(f);
        pans.push(p);
      }
      midis.forEach((m) => {
        for (let k = 0; k < per; k++) {
          const o = osc();
          o.setPeriodicWave(wave(P.wave));
          o.frequency.value = mtof(m);
          o.detune.value = per === 1 ? 0 : (k / (per - 1) - 0.5) * 2 * P.det + (z.perfR() - 0.5) * 2;
          o.connect(pans[k]);
          o.start(t);
          o.stop(end);
          N(1);
          voice(t, end);
        }
      });
      N(2 + per);
    }
    function vFM(z, t, m, vel, V, dest, panX) {
      const f = mtof(m);
      const car = osc();
      const mod = osc();
      const mg = ctx.createGain();
      const amp = ctx.createGain();
      car.frequency.value = f;
      mod.frequency.value = f * V.ratio;
      const I = V.idx * f;
      mg.gain.setValueAtTime(I, t);
      mg.gain.exponentialRampToValueAtTime(I * 0.08 + 0.01, t + V.dec * 0.35);
      amp.gain.setValueAtTime(0, t);
      amp.gain.linearRampToValueAtTime(V.lvl * vel, t + 0.006);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + V.dec);
      mod.connect(mg);
      mg.connect(car.frequency);
      const p = pan(panX);
      car.connect(amp);
      amp.connect(p);
      p.connect(dest);
      car.start(t);
      mod.start(t);
      car.stop(t + V.dec + 0.05);
      mod.stop(t + V.dec + 0.05);
      N(5);
      voice(t, t + V.dec);
    }
    function vHum(z, t, m, dur, vel, V, dest, panX) {
      const o = osc();
      o.setPeriodicWave(wave('hum'));
      o.frequency.value = mtof(m);
      const lfo = osc();
      const lg = ctx.createGain();
      lfo.frequency.value = 4.6 + z.perfR() * 0.8;
      lg.gain.setValueAtTime(0, t);
      lg.gain.linearRampToValueAtTime(mtof(m) * 0.006, t + 0.6);
      lfo.connect(lg);
      lg.connect(o.frequency);
      const g = ctx.createGain();
      const rel = 0.9;
      env(g, t, 0.12, V.lvl * vel, Math.max(0.05, dur - 0.12), rel);
      const p = pan(panX);
      o.connect(g);
      g.connect(p);
      p.connect(dest);
      const end = t + dur + rel + 0.05;
      o.start(t);
      lfo.start(t);
      o.stop(end);
      lfo.stop(end);
      N(5);
      voice(t, end);
    }
    function vHorn(z, t, m, dur, vel, V, dest, panX) {
      const o = osc();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      o.detune.value = (z.perfR() - 0.5) * 6;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 0.7;
      f.frequency.setValueAtTime(300, t);
      f.frequency.linearRampToValueAtTime(1300, t + 0.18);
      f.frequency.linearRampToValueAtTime(750, t + 0.18 + dur);
      const g = ctx.createGain();
      const rel = 0.7;
      env(g, t, 0.16, V.lvl * vel, Math.max(0.05, dur - 0.16), rel);
      const p = pan(panX);
      o.connect(f);
      f.connect(g);
      g.connect(p);
      p.connect(dest);
      const end = t + dur + rel + 0.05;
      o.start(t);
      o.stop(end);
      N(4);
      voice(t, end);
    }
    function vBass(z, t, m, dur, lvl) {
      const o = osc();
      o.frequency.value = mtof(m);
      const o2 = osc();
      o2.type = 'triangle';
      o2.frequency.value = mtof(m) * 2;
      const g2 = ctx.createGain();
      g2.gain.value = 0.3;
      const g = ctx.createGain();
      env(g, t, 0.08, lvl, Math.max(0.05, dur - 0.08), 0.8);
      o.connect(g);
      o2.connect(g2);
      g2.connect(g);
      g.connect(z.layer.bass);
      const end = t + dur + 0.9;
      o.start(t);
      o2.start(t);
      o.stop(end);
      o2.stop(end);
      N(5);
      voice(t, end);
    }
    function vOst(z, t, m, vel) {
      const O = z.th.ost;
      const o = osc();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 2.2;
      f.frequency.setValueAtTime(O.cut * (0.9 + vel * 0.5), t);
      f.frequency.exponentialRampToValueAtTime(140, t + 0.22);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(O.lvl * vel, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      o.connect(f);
      f.connect(g);
      g.connect(z.layer.ost);
      o.start(t);
      o.stop(t + 0.36);
      N(3);
      voice(t, t + 0.36);
    }
    function vDrum(z, t, vel, kind) {
      const K = z.th.perc;
      const big = kind === 'taiko' || K.kit === 'taiko';
      const pulse = K.kit === 'pulse';
      const o = osc();
      const f0 = pulse ? 62 : big ? 88 : 115;
      const f1 = pulse ? 38 : big ? 42 : 52;
      const dec = pulse ? 0.7 : big ? 0.9 : 0.45;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(K.lvl * vel, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      o.connect(g);
      g.connect(z.layer.perc);
      o.start(t);
      o.stop(t + dec + 0.02);
      N(3);
      if (!pulse) {
        const s = bsrc();
        s.buffer = noise;
        const nf = ctx.createBiquadFilter();
        nf.type = 'lowpass';
        nf.frequency.value = big ? 380 : 650;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(K.lvl * vel * 0.35, t);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + (big ? 0.18 : 0.07));
        s.connect(nf);
        nf.connect(ng);
        ng.connect(z.layer.perc);
        s.start(t, z.perfR() * 2);
        s.stop(t + 0.2);
        N(3);
      }
      voice(t, t + dec);
    }
    function vTok(z, t, vel) {
      const K = z.th.perc;
      const s = bsrc();
      s.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = K.kit === 'soft' ? 520 : 380;
      f.Q.value = 3.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(K.lvl * vel * 0.9, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      const p = pan((z.perfR() - 0.5) * 0.6);
      s.connect(f);
      f.connect(g);
      g.connect(p);
      p.connect(z.layer.perc);
      s.start(t, z.perfR() * 2);
      s.stop(t + 0.1);
      N(4);
      voice(t, t + 0.1);
    }
    function vChoir(z, t, dur, midis) {
      // two soft formants ('oh'), slow attack, gentle vibrato; kept low in the mix on purpose
      const C = z.th.choir;
      const g = ctx.createGain();
      env(g, t, 2.2, C.lvl / Math.sqrt(midis.length), Math.max(0, dur - 2.2), 2.5);
      const f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 420;
      f1.Q.value = 5;
      const f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 820;
      f2.Q.value = 7;
      const f2g = ctx.createGain();
      f2g.gain.value = 0.5;
      f1.connect(g);
      f2.connect(f2g);
      f2g.connect(g);
      g.connect(z.layer.choir);
      const end = t + dur + 2.6;
      midis.forEach((m, i) => {
        const o = osc();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = (z.perfR() - 0.5) * 12;
        const lfo = osc();
        lfo.frequency.value = 4.2 + z.perfR();
        const lg = ctx.createGain();
        lg.gain.value = 9; // cents-ish via detune
        lfo.connect(lg);
        lg.connect(o.detune);
        o.connect(f1);
        o.connect(f2);
        o.start(t);
        lfo.start(t);
        o.stop(end);
        lfo.stop(end);
        N(3);
        voice(t, end);
      });
      N(5);
    }
    function playMel(z, t, n, chord, bar) {
      const th = z.th;
      const V = n.voice === 'answer' ? th.answer : th.lead;
      const isGlint = n.glint;
      const lo = V.lo || th.lead.lo;
      const m = scaleMidi(th, th.tonic + chord.root, n.s, isGlint ? lo + 7 : lo, z.harmFight);
      const dur = (n.d * 60) / th.bpm / th.beat;
      const vel = (isGlint ? 0.55 : n.head ? 1 : 0.8) * (0.9 + z.perfR() * 0.2);
      const px = (z.perfR() - 0.5) * 0.5;
      const kind = isGlint ? (th.lead.kind === 'horn' || th.lead.kind === 'hum' ? th.answer.kind : th.lead.kind) : V.kind;
      const VV = isGlint && kind !== V.kind ? th.answer : V;
      if (kind === 'pluck' || kind === 'bell') vFM(z, t, m, vel, VV, z.layer.lead, px);
      else if (kind === 'hum') vHum(z, t, m, dur, vel, VV, z.layer.lead, px);
      else if (kind === 'horn') vHorn(z, t, m, dur, vel, VV, z.layer.lead, px);
      if (log) log.push({ t: t - t0, k: 'note', layer: isGlint ? 'glint' : n.voice, m, bar, I: intensity, vel: +vel.toFixed(4), px: +px.toFixed(4) });
    }

    // ------------------------------------------------ music scheduler (step grid)
    function sectionFor(z, barIdx) {
      const s = Math.floor(barIdx / 16);
      if (loop) return z.sections[s % z.loopSections];
      while (z.sections.length <= s) {
        const prev = z.sections[z.sections.length - 1] || null;
        z.sections.push(planSection(z.perfR, z, prev, true));
        if (z.sections.length > 4) z.sections[z.sections.length - 5] = null; // free old plans
      }
      return z.sections[s];
    }
    // loop mode: the loop is a whole number of samples, so every period puts each note on the same sub-sample phase
    function stepDurOf(th) {
      const raw = 60 / th.bpm / th.beat;
      if (!loop) return raw;
      const steps = (opts.loopBars || 32) * th.grid;
      return loopFrames(th, opts.loopBars || 32, sr) / sr / steps;
    }
    function schedMusic(z, horizon) {
      const th = z.th;
      const stepDur = stepDurOf(th);
      while (z.nextStepT < horizon) {
        const t = z.nextStepT;
        const st = z.step;
        if (loop && st === 0 && z.bar % (z.loopSections * 16) === 0) z.perfR = prng(hashStr(z.id) ^ seed ^ 0x2468); // identical per-note randomness every loop
        const sec = sectionFor(z, z.bar);
        const bi = z.bar % 16;
        const bar = sec.bars[bi];
        // intensity changes land on beats
        if (st % th.beat === 0 && pending !== intensity) applyIntensity(z, t, pending);
        // harmony: the chord as planned, or its fight form (fightSwap) when the chord starts while intensity ≥ 1;
        // melody / ostinato follow whatever the pad is sounding until the next chord
        if (st === 0 && bar.first) {
          const sw = intensity >= 1 && th.fightSwap ? th.fightSwap[bar.chord.name] : null;
          z.harmFight = intensity >= 1 && !!th.fightSwap;
          z.curSrc = bar.chord;
          z.cur = sw ? fightChord(th, bar.chord, sw) : bar.chord;
        }
        if (z.curSrc !== bar.chord) (z.curSrc = bar.chord), (z.cur = bar.chord), (z.harmFight = false); // joined mid-chord (resync)
        const chord = z.cur;
        if (st === 0) {
          if (bar.first) {
            const midis = loop && chord.voicing ? chord.voicing : voice4(th, chord, z.voicing);
            if (loop) chord.voicing = midis; // fixed per loop: every period identical
            z.voicing = midis;
            let len = chord.len;
            const dur = len * th.grid * stepDur;
            vPad(z, t, dur, midis, intensity === 2 ? 1.1 : 1);
            const bm = 36 + ((th.tonic + chord.root) % 12);
            vBass(z, t, bm, dur * 0.95, th.bass.lvl);
            if (th.choir && intensity === 2) vChoir(z, t, dur, midis.slice(0, 3).map((m) => m - 12 + 12));
            if (log) log.push({ t: t - t0, k: 'chord', name: chord.name, midis: midis.slice(), bass: bm, bar: z.bar, I: intensity });
          }
        }
        // melody
        const prevBar = bi > 0 ? sec.bars[bi - 1] : null;
        const notes = bar.mel.concat(prevBar && prevBar.next ? prevBar.next : []);
        let played = 0;
        for (const n of notes) {
          if (n.st !== st) continue;
          if (intensity >= 1 && (n.glint || !n.keep)) continue;
          if (intensity === 2 && n.voice === 'answer') continue;
          playMel(z, t, n, chord, z.bar);
          played++;
        }
        // explore arpeggio: pad tones an octave up, up-and-down, on the arp grid; never on a melody note or the downbeat
        const A = th.arp;
        if (A && intensity === 0 && bar.arp && st > 0 && st % A.every === 0 && !played && z.voicing && z.perfR() < bar.arp * A.p) {
          const tones = z.voicing, n = tones.length, cyc = Math.max(1, 2 * n - 2);
          let i = (st / A.every) % cyc;
          if (i >= n) i = cyc - i;
          let m = tones[i] + 12;
          while (m > (th.lead.hi || 84)) m -= 12;
          const vel = 0.6 + z.perfR() * 0.3;
          vFM(z, t, m, vel, A, z.layer.arp, (i / Math.max(1, n - 1) - 0.5) * 0.6);
          if (log) log.push({ t: t - t0, k: 'note', layer: 'arp', m, bar: z.bar, I: intensity });
        }
        // fight layers
        if (intensity >= 1) {
          const root = 36 + ((th.tonic + chord.root) % 12);
          for (const o of z.ostPat) {
            if (o.st !== st) continue;
            const iv = o.v === 'r' ? 0 : o.v === 'o' ? 12 : chord.shape.includes(7) ? 7 : chord.shape[chord.shape.length - 1] % 12;
            vOst(z, t, root + iv, o.acc);
            if (log) log.push({ t: t - t0, k: 'note', layer: 'ost', m: root + iv, bar: z.bar, I: intensity });
          }
          for (const d of z.percPat.drum) if (d.st === st) { vDrum(z, t, d.v); if (log) log.push({ t: t - t0, k: 'note', layer: 'perc', bar: z.bar, I: intensity }); }
          for (const d of z.percPat.tok) if (d.st === st) { vTok(z, t, d.v); if (log) log.push({ t: t - t0, k: 'note', layer: 'perc', bar: z.bar, I: intensity }); }
          if (intensity === 2) {
            for (const d of z.percPat.boss) if (d.st === st) { vDrum(z, t, d.v, 'taiko'); if (log) log.push({ t: t - t0, k: 'note', layer: 'perc', bar: z.bar, I: intensity }); }
            // short roll into each phrase end
            if (bi % 4 === 3 && st >= th.grid - th.beat && st % 1 === 0) { vTok(z, t, 0.3 + (st - (th.grid - th.beat)) * 0.08); if (log) log.push({ t: t - t0, k: 'note', layer: 'perc', bar: z.bar, I: intensity }); }
          }
        }
        // advance
        z.step++;
        if (z.step >= th.grid) {
          z.step = 0;
          z.bar++;
        }
        z.nextStepT = t0 + (z.bar * th.grid + z.step) * stepDur + (z.barOffset || 0);
      }
    }
    function fightChord(th, c, sw) {
      if (c.fight && c.fight.name === sw) return c.fight;
      const def = th.chords[sw];
      return (c.fight = { name: sw, root: def[0], shape: def[1][0], len: c.len, tension: false });
    }
    function applyIntensity(z, t, lvl) {
      const th = z.th;
      const beatDur = 60 / th.bpm;
      const up = lvl > intensity;
      intensity = lvl;
      for (const k in z.layer) {
        const p = z.layer[k].gain;
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t); // value at schedule time is close enough: ramps are slow
        p.linearRampToValueAtTime(LAYER_GAIN[k][lvl], t + beatDur * (up ? 1 : 3));
      }
      if (up) vDrum(z, t, 1.0, 'taiko'); // entry hit so the switch reads immediately
      if (log) log.push({ t: t - t0, k: 'intensity', I: lvl });
    }

    // ------------------------------------------------ ambience layers
    function makeAmbLayer(z, L, idx) {
      const r = prng((hashStr(z.id) ^ seed) + idx * 977);
      const period = loop ? opts.ambLoop || 64 : 0;
      const A = { L, r, period, mod: makeMod(r, L.rate || 0.05, period), mod2: makeMod(r, (L.rate || 0.05) * 3.1, period), nextT: 0, list: null };
      const dest = z.aPre;
      // continuous beds: the filter / gain chain is built once per zone; the source itself is made by mk() (again on resume)
      const cont = (ftype, freq, q, lvl, lp) => {
        const f = ctx.createBiquadFilter();
        f.type = ftype;
        f.frequency.value = freq;
        f.Q.value = q;
        const g = ctx.createGain();
        g.gain.value = 0;
        const p = pan(0);
        if (lp) {
          // audio-int: wind's noise skirt was the largest 2–5 kHz source in the beds; a gentle lowpass keeps it out of the hit band
          const l = ctx.createBiquadFilter();
          l.type = 'lowpass';
          l.frequency.value = lp;
          l.Q.value = 0.5;
          f.connect(l);
          l.connect(g);
          N(1);
        } else f.connect(g);
        g.connect(p);
        p.connect(dest);
        N(4);
        const c = { s: null, f, g, p, lvl };
        c.mk = () => {
          c.s = bsrc();
          c.s.buffer = noise;
          c.s.loop = true;
          c.s.connect(f);
        };
        return c;
      };
      const T = L.type;
      if (T === 'wind') A.c = cont('bandpass', L.f[0], L.q, L.lvl, 1700);
      else if (T === 'whistle') A.c = cont('bandpass', L.f[0], 9, L.lvl);
      else if (T === 'rumble') A.c = cont('lowpass', L.f, 0.7, L.lvl);
      else if (T === 'hiss') A.c = cont('highpass', L.f, 0.5, L.lvl);
      else if (T === 'water') A.c = cont('lowpass', L.f[0], 0.9, L.lvl);
      else if (T === 'breath') A.c = cont('bandpass', L.f, 1.2, L.lvl);
      else if (T === 'fire') A.c = cont('bandpass', L.f, 0.8, L.lvl);
      else if (T === 'drone' || T === 'hum') {
        const g = ctx.createGain();
        g.gain.value = 0;
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = T === 'drone' ? 220 : 400;
        f.connect(g);
        g.connect(dest);
        const ogs = [];
        const ratios = T === 'drone' ? [1, 1.5, 2.003, 3.01] : [1, 2, 3];
        ratios.forEach((k, i) => {
          let fr = L.f * k * (1 + (i % 2 ? 0.0021 : -0.0013));
          if (period) fr = Math.round(fr * period) / period; // whole cycles per loop: no phase jump at the seam
          const og = ctx.createGain();
          og.gain.value = 1 / (i + 1);
          const p = pan((i - 1.5) * 0.4);
          og.connect(p);
          p.connect(f);
          ogs.push([og, fr, i]);
          N(3);
        });
        const c = (A.c = { oscs: null, f, g, lvl: L.lvl });
        c.mk = () => {
          c.oscs = ogs.map(([og, fr, i]) => {
            const o = osc();
            o.type = i === 0 ? 'sine' : 'triangle';
            o.frequency.value = fr;
            o.connect(og);
            return o;
          });
        };
        N(2);
      }
      if (loop && ['crackle', 'creak', 'drip', 'clack', 'thunder', 'shimmer'].includes(T)) {
        // pre-generate one period of events; replayed every period
        A.list = [];
        let t = 0;
        while (true) {
          t = nextEventT(A, t);
          if (t >= period) break;
          A.list.push({ t, u: [r(), r(), r(), r(), r(), r(), r(), r()] });
        }
      }
      return A;
    }
    function nextEventT(A, t) {
      const L = A.L;
      if (L.every) return t + L.every[0] + A.r() * (L.every[1] - L.every[0]);
      return t - Math.log(1 - A.r() * 0.999) / (L.rate * (lite ? 0.6 : 1));
    }
    function startAmb(z, t) {
      for (const A of z.ambLayers) {
        if (!A.c) continue;
        A.c.mk();
        if (A.c.s) A.c.s.start(t, 0);
        if (A.c.oscs) for (const o of A.c.oscs) o.start(t);
        voice(t, 1e9);
      }
    }
    function stopAmb(z, t) {
      for (const A of z.ambLayers) {
        if (!A.c) continue;
        if (A.c.s) A.c.s.stop(t);
        if (A.c.oscs) for (const o of A.c.oscs) o.stop(t);
      }
    }
    const AMB_STEP = 0.25;
    function schedAmb(z, horizon) {
      while (z.ambT < horizon) {
        const t = z.ambT;
        const tt = t - t0; // zone-relative time drives the (periodic) modulation
        for (const A of z.ambLayers) ambAuto(z, A, t, tt);
        z.ambT += AMB_STEP;
      }
      for (const A of z.ambLayers) ambEvents(z, A, horizon);
    }
    function ambAuto(z, A, t, tt) {
      const L = A.L, c = A.c;
      if (!c) return;
      const m = A.mod(tt), m2 = A.mod2(tt);
      const T = L.type;
      if (T === 'wind' || T === 'whistle') {
        const u = 0.5 + 0.5 * m;
        const gust = L.gust ? Math.max(0, m2) * 0.8 : 0;
        c.f.frequency.linearRampToValueAtTime(L.f[0] + (L.f[1] - L.f[0]) * clamp(u + gust * 0.3, 0, 1), t);
        c.g.gain.linearRampToValueAtTime(c.lvl * (0.35 + 0.65 * u + gust), t);
        c.p.pan && c.p.pan.linearRampToValueAtTime(0.5 * m2, t);
      } else if (T === 'rumble' || T === 'hiss') {
        c.g.gain.linearRampToValueAtTime(c.lvl * (0.6 + 0.4 * m), t);
      } else if (T === 'water') {
        const lapP = A.period ? A.period / Math.round(A.period / 2.9) : 2.9;
        const lap = 0.5 + 0.5 * Math.sin((6.283185307 * tt) / lapP + 3 * m2); // slow lapping
        c.f.frequency.linearRampToValueAtTime(L.f[0] + (L.f[1] - L.f[0]) * lap, t);
        c.g.gain.linearRampToValueAtTime(c.lvl * (0.45 + 0.55 * lap) * (0.8 + 0.2 * m), t);
        c.p.pan && c.p.pan.linearRampToValueAtTime(0.4 * m, t);
      } else if (T === 'breath') {
        const b = Math.max(0, Math.sin(6.283 * tt / (A.period ? A.period / Math.round(A.period / 9) : 9) + m));
        c.g.gain.linearRampToValueAtTime(c.lvl * (0.15 + b * b), t);
        c.f.frequency.linearRampToValueAtTime(L.f * (0.8 + 0.4 * b), t);
      } else if (T === 'fire') {
        c.g.gain.linearRampToValueAtTime(c.lvl * (0.7 + 0.3 * m2 + 0.15 * m), t);
        c.f.frequency.linearRampToValueAtTime(L.f * (0.85 + 0.3 * (0.5 + 0.5 * m2)), t);
      } else if (T === 'drone' || T === 'hum') {
        c.g.gain.linearRampToValueAtTime(c.lvl * (0.7 + 0.3 * m), t);
        c.f.frequency.linearRampToValueAtTime((T === 'drone' ? 160 : 300) * (1 + 0.5 * (0.5 + 0.5 * m2)), t);
      }
    }
    function ambEvents(z, A, horizon) {
      const T = A.L.type;
      if (!['crackle', 'creak', 'drip', 'clack', 'thunder', 'shimmer'].includes(T)) return;
      if (A.list) {
        // loop mode: replay the period's list
        const P = A.period;
        if (A.done === undefined) A.done = 0; // absolute time scheduled up to (zone-relative)
        const from = A.done, to = horizon - t0;
        for (let k = Math.floor(from / P); k * P < to; k++) {
          for (const e of A.list) {
            const et = k * P + e.t;
            if (et >= from && et < to) ambEvent(z, A, t0 + et, e.u);
          }
        }
        A.done = to;
        return;
      }
      if (!A.nextT) A.nextT = t0 + nextEventT(A, 0) * 0.5;
      while (A.nextT < horizon) {
        const r = A.r;
        ambEvent(z, A, A.nextT, [r(), r(), r(), r(), r(), r(), r(), r()]);
        A.nextT = nextEventT(A, A.nextT);
      }
    }
    function grain(z, t, dur, ftype, freq, q, lvl, px, dest) {
      const s = bsrc();
      s.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = ftype;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(lvl, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const p = pan(px);
      s.connect(f);
      f.connect(g);
      g.connect(p);
      p.connect(dest || z.aPre);
      s.start(t, (px + 1) * 1.3);
      s.stop(t + dur + 0.01);
      N(4);
      voice(t, t + dur);
    }
    function ambEvent(z, A, t, u) {
      const L = A.L, T = L.type;
      const px = (u[0] - 0.5) * 1.4;
      if (T === 'crackle') {
        const n = u[1] < L.cluster ? 2 + Math.floor(u[2] * 4) : 1;
        for (let i = 0; i < n; i++) grain(z, t + i * (0.012 + u[3] * 0.03), 0.006 + u[4] * 0.02, 'bandpass', L.f[0] + (L.f[1] - L.f[0]) * ((u[5] + i * 0.37) % 1), 1.3, L.lvl * (0.4 + 0.6 * u[6]), px);
      } else if (T === 'creak') {
        // stick-slip: a run of tiny clicks through one resonant filter, rate slowing then speeding
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        const fq = L.f[0] + (L.f[1] - L.f[0]) * u[1];
        f.frequency.setValueAtTime(fq, t);
        f.frequency.linearRampToValueAtTime(fq * (0.8 + u[2] * 0.4), t + 0.6);
        f.Q.value = 14;
        const p = pan(px);
        f.connect(p);
        p.connect(z.aPre);
        N(2);
        const clicks = 10 + Math.floor(u[3] * 18);
        let tt = t;
        for (let i = 0; i < clicks; i++) {
          const x = i / clicks;
          tt += 0.012 + 0.03 * Math.sin(Math.PI * x) * (0.6 + u[4] * 0.8);
          grain(z, tt, 0.004, 'highpass', 300, 0.5, L.lvl * (0.5 + 0.5 * Math.sin(Math.PI * x)), 0, f);
        }
      } else if (T === 'drip') {
        const o = osc();
        const f0 = 500 + u[1] * 500;
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f0 * (1.8 + u[2]), t + 0.04);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(L.lvl * (0.5 + 0.5 * u[3]), t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
        const p = pan(px);
        o.connect(g);
        g.connect(p);
        p.connect(z.aPre);
        o.start(t);
        o.stop(t + 0.08);
        N(4);
        voice(t, t + 0.08);
      } else if (T === 'clack') {
        // bones / pebbles: a short tumble of dull knocks
        const n = 2 + Math.floor(u[1] * 4);
        let tt = t;
        for (let i = 0; i < n; i++) {
          grain(z, tt, 0.03, 'bandpass', 600 + u[2] * 500, 4, L.lvl * (1 - i / (n + 1)), px);
          tt += 0.06 + u[3] * 0.12 * (1 - i / n);
        }
      } else if (T === 'thunder') {
        // distant: low-passed noise swells, two to four overlapping rolls
        const rolls = 2 + Math.floor(u[1] * 3);
        for (let i = 0; i < rolls; i++) {
          const st = t + i * (0.25 + u[2] * 0.6);
          const dur = 2.5 + u[3] * 3;
          const s = bsrc();
          s.buffer = noise;
          s.loop = true;
          const f = ctx.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.setValueAtTime(600 + u[4] * 500, st);
          f.frequency.exponentialRampToValueAtTime(70, st + dur);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, st);
          g.gain.linearRampToValueAtTime(L.lvl * (1 - i * 0.2), st + 0.08 + u[5] * 0.25);
          g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
          const p = pan(px * 0.6);
          s.connect(f);
          f.connect(g);
          g.connect(p);
          p.connect(z.aPre);
          s.start(st, u[6] * 3);
          s.stop(st + dur + 0.02);
          N(4);
          voice(st, st + dur);
        }
      } else if (T === 'shimmer') {
        const deg = L.scale[Math.floor(u[1] * L.scale.length) % L.scale.length];
        const m = L.base + deg + (u[2] < 0.3 ? 12 : 0);
        vFM(z, t, m, 0.5 + 0.5 * u[3], { ratio: 2.76, idx: 0.5, dec: 3 + u[4] * 2, lvl: L.lvl }, z.aPre, px);
      }
    }

    // ------------------------------------------------ public
    const S = {
      zones: ZONES,
      stats,
      log,
      get intensity() { return intensity; },
      get zone() { return Z ? Z.id : null; },
      get paused() { return paused; },
      get running() { return !!timer; },
      setZone(id, t, fade) {
        t = t === undefined ? ctx.currentTime : t;
        const old = Z;
        if (old) {
          fade = fade || 2;
          old.mGain.gain.setTargetAtTime(0, t, fade / 4);
          old.aGain.gain.setTargetAtTime(0, t, fade / 4);
          stopAmb(old, t + fade * 2);
          setTimeoutSafe(() => {
            try {
              old.mGain.disconnect();
              old.aGain.disconnect();
            } catch (e) {}
            old.mOn = old.aOn = false;
          }, (fade * 2 + 1) * 1000);
        }
        Z = buildZone(id);
        Z.waiting = true;
        if (started && !paused && !jobs.length) beginZone(Z, t);
        return S;
      },
      setIntensity(lvl) {
        pending = clamp(lvl | 0, 0, 2);
        return S;
      },
      start(t) {
        t = t === undefined ? ctx.currentTime + 0.05 : t;
        started = true;
        if (Z && !paused && !jobs.length) beginZone(Z, t);
        return S;
      },
      stop(t, fade) {
        t = t === undefined ? ctx.currentTime : t;
        fade = fade || 1.5;
        if (Z) {
          Z.mGain.gain.setTargetAtTime(0, t, fade / 4);
          Z.aGain.gain.setTargetAtTime(0, t, fade / 4);
          stopAmb(Z, t + fade * 2);
        }
        started = false;
        if (timer) clearInterval(timer), (timer = null);
        return S;
      },
      // pause: fade out, stop every source still due to sound, disconnect the zone, drop the timer. Nothing is left running:
      // no timers, no live voices, no graph pulled by the buses. resume() restarts the beds and the music from a fresh bar.
      pause(fade) {
        if (paused) return S;
        paused = true;
        if (timer) clearInterval(timer), (timer = null);
        const t = ctx.currentTime;
        fade = fade === undefined ? 0.3 : fade;
        if (Z && !Z.waiting) {
          Z.mGain.gain.cancelScheduledValues(t);
          Z.aGain.gain.cancelScheduledValues(t);
          Z.mGain.gain.setTargetAtTime(0, t, fade / 4 + 1e-3);
          Z.aGain.gain.setTargetAtTime(0, t, fade / 4 + 1e-3);
          Z.waiting = true; // resume() begins the zone again
        }
        for (const n of liveSrc) {
          if (n.__end > t + fade)
            try {
              n.stop(t + fade);
            } catch (e) {
              n.__end = t + fade;
            }
        }
        liveSrc = [];
        ends.length = 0;
        const z = Z;
        // disconnect once the fade is through (a real context); an offline render keeps the (silent) graph
        setTimeoutSafe(() => {
          if (paused && z) wire(z);
        }, fade * 1000 + 60);
        return S;
      },
      resume(ms) {
        if (!paused) return S;
        paused = false;
        if (Z && started && !jobs.length) beginZone(Z, ctx.currentTime + 0.05);
        if (ms !== false) S.run(ms || 200);
        return S;
      },
      setParts(music, amb) {
        music = !!music;
        amb = !!amb;
        if (music === partM && amb === partA) return S;
        const offM = partM && !music, offA = partA && !amb, onM = !partM && music, onA = !partA && amb;
        partM = music;
        partA = amb;
        if (Z && !Z.waiting) {
          const t = ctx.currentTime, z = Z;
          // switching a part off: stop scheduling now, fade what is already queued, disconnect after the fade
          if (offM) (z.mGain.gain.cancelScheduledValues(t), z.mGain.gain.setTargetAtTime(0, t, 0.12));
          if (offA) (z.aGain.gain.cancelScheduledValues(t), z.aGain.gain.setTargetAtTime(0, t, 0.12));
          // switching it back on: rejoin the plan at the current time (resync skips the gap) and fade in
          if (onM) fadeIn(z.mGain.gain, z.mLvl, t, 1.5);
          if (onA) fadeIn(z.aGain.gain, z.aLvl, t, 1.5);
          if (onM && !z.mOn) z.mGain.connect(musicOut), (z.mOn = true);
          if (onA && !z.aOn) z.aGain.connect(ambOut), (z.aOn = true);
          if (offM || offA) setTimeoutSafe(() => Z === z && !z.waiting && wire(z), 700);
        }
        return S;
      },
      // finish all pending buffer work now (offline renders, loading screens)
      prepare() {
        pump(Infinity);
        return S;
      },
      get ready() { return !jobs.length; },
      live() {
        pruneLive(ctx.currentTime);
        return liveSrc.length;
      },
      tick(now) {
        now = now === undefined ? ctx.currentTime : now;
        if (paused) return;
        if (jobs.length) {
          pump(opts.budgetMs || 4);
          if (jobs.length) return;
        }
        if (!started || !Z) return;
        if (Z.waiting) beginZone(Z, now + 0.05);
        const c0 = typeof performance !== 'undefined' ? performance.now() : 0;
        resync(Z, now);
        const h = now + LOOK;
        if (opts.parts !== 'amb' && partM) schedMusic(Z, h);
        if (opts.parts !== 'music' && partA) schedAmb(Z, h);
        else Z.ambT = Math.max(Z.ambT, h); // nothing owed when the ambience comes back
        pruneLive(now);
        stats.ticks++;
        if (typeof performance !== 'undefined') {
          stats.tickMs.push(performance.now() - c0);
          if (stats.tickMs.length > 600) stats.tickMs.splice(0, 300); // keep the last few minutes for stats
          if (stats.pumpMs.length > 600) stats.pumpMs.splice(0, 300);
          if (stats.convMs.length > 600) stats.convMs.splice(0, 300);
        }
      },
      run(ms) {
        if (timer) clearInterval(timer);
        timer = setInterval(() => S.tick(), ms || 200);
        S.tick();
        return S;
      },
    };
    // the timer stalled (background tab, long frame): skip the gap silently instead of firing every missed note at once
    function resync(z, now) {
      if (loop) return;
      const stepDur = stepDurOf(z.th);
      if (z.nextStepT < now - 0.25) {
        const k = Math.ceil((now - z.nextStepT) / stepDur);
        const abs = z.bar * z.th.grid + z.step + k;
        z.bar = Math.floor(abs / z.th.grid);
        z.step = abs % z.th.grid;
        z.nextStepT = t0 + abs * stepDur;
        stats.resyncs = (stats.resyncs || 0) + 1;
      }
      if (z.ambT < now - 0.25) z.ambT = now;
      for (const A of z.ambLayers) if (A.nextT && A.nextT < now - 0.25) A.nextT = now + nextEventT(A, 0) * 0.5;
    }
    function fadeIn(p, lvl, t, dur) {
      p.cancelScheduledValues(t);
      p.setValueAtTime(0, t);
      p.linearRampToValueAtTime(lvl, t + dur);
    }
    function beginZone(z, t) {
      z.waiting = false;
      t0 = t;
      z.nextStepT = t;
      z.ambT = t;
      z.bar = 0;
      z.step = 0;
      if (!loop && z.sections.length && !z.sections[0]) {
        // resumed after old plans were freed: start a fresh section plan (same streams, so it simply continues the music)
        z.sections = [];
        z.voicing = null;
      }
      for (const A of z.ambLayers) (A.nextT = 0), (A.done = undefined);
      // layer gains straight to the current intensity (a pause can cut a ramp)
      for (const k in z.layer) {
        const p = z.layer[k].gain;
        p.cancelScheduledValues(t);
        p.setValueAtTime(LAYER_GAIN[k][intensity], t);
      }
      startAmb(z, t);
      // fade the zone in
      const fi = opts.fadeIn === undefined ? 2 : opts.fadeIn;
      fadeIn(z.mGain.gain, z.mLvl, t, fi);
      fadeIn(z.aGain.gain, z.aLvl, t, fi);
      wire(z);
    }
    function setTimeoutSafe(fn, ms) {
      if (typeof setTimeout !== 'undefined' && !(ctx instanceof (root.OfflineAudioContext || function () {}))) setTimeout(fn, ms);
    }
    return S;
  }
  root.CinderScore = { create, ZONES, TRIM, LAYER_GAIN, loopFrames, version: 1 };
})(typeof window !== 'undefined' ? window : globalThis);

// ============================================================ G.music：游戏这边的接线（只在游戏页面里有）
// 引擎（上面的 CinderScore）不读也不写游戏状态；这里只读：当前区域、G.combat 的两个时间戳（js/game.js 里命中 / 受伤时写）、
// 首领、标题画面 / 开场故事、画质、音量设置。没有 Math.random（会话种子取自时钟），所以开不开音乐，同一个种子的战斗完全一样。
//   G.audio.onStart → 建引擎（第一次按键 / 点击之后，标题画面不会多一帧卡顿）；输出 → 增益（OUT）→ G.audio.bus('music' / 'amb')
//   区域：余烛殿 = crown，其余按 G.ZONES[state.zoneIdx].id；换区时 2 秒交叉淡化。没有城镇；标题画面和开场故事只放这一区的环境音、不放音乐
//   强度（模拟时间，暂停时保持不变）：4 秒内造成或受到伤害 → 1，一直保持到 6 秒没有战斗；首领醒着、在 30 米内、12 秒内有交手 → 2；
//     首领死了、玩家倒下、换区 → 0
//   停：静音、总音量 0、环境音和音乐都是 0、标签页在后台、AudioContext 没在跑 → 引擎 pause()：没有定时器、没有在响的声部、
//     区域的图从总线上断开。设置改了（G.audio.apply）、切回前台、AudioContext 状态变了时重新判断，恢复时从新的一小节接上
//   画质：低 → lite（每个和弦一层振荡器、音乐混响 0.45 倍、不加环境音混响、环境颗粒少 40%）；中 / 高 → 完整版
(function () {
  const G = typeof window !== 'undefined' ? window.G : null;
  if (!G || !window.CinderScore) return;
  const CS = window.CinderScore;
  // 引擎输出到总线的增益：默认滑条（总 80 / 音效 80 / 环境音 60 / 音乐 50）下，探索音乐比密集战斗音效低约 12 LU、环境音低约 18 LU
  // （规则是至少 11 / 17 LU；tools/score/README.md 里有量法）
  // 实测（默认滑条，同一条链路）：音效 −33.3 LUFS；探索音乐 −46.2…−46.7、战斗 −45.9…−48.3、首领 −44.7；环境音 −51.3 左右
  const OUT = { music: 0.767, amb: 0.569 }; // −2.3 dB / −4.9 dB
  const LITE = { low: true, mid: false, high: false };
  const TICK = 200; // ms：调度 + 状态判断的周期
  const BOSS_R = 30, BOSS_HOLD = 12, FIGHT_IN = 4, FIGHT_HOLD = 6;
  const NOC = { dealt: -1e9, taken: -1e9 };
  const M = { ctx: null, eng: null, mOut: null, aOut: null, lite: null, zone: null, timer: null, I: 0, calm: -1e9, boss: null, active: false, parts: [false, false], seed: 0, ticks: 0, ms: 0, maxMs: 0 };

  const quality = () => (G.world && G.world.quality ? G.world.quality() : (G.save && G.save.opts && G.save.opts.quality) || 'high');
  function zoneId() {
    const st = G.state;
    if (!st || !st.zone) return null;
    if (st.pin) return 'crown';
    const d = G.ZONES && G.ZONES[st.zoneIdx];
    return d && CS.ZONES[d.id] ? d.id : 'ash';
  }
  function want() {
    const c = M.ctx;
    if (!c || c.state !== 'running' || (typeof document !== 'undefined' && document.hidden)) return false;
    const L = G.audio.levels();
    return L.master > 0 && (L.music > 0 || L.amb > 0);
  }
  function make() {
    const lite = !!LITE[quality()];
    M.lite = lite;
    M.eng = CS.create(M.ctx, { seed: M.seed, music: M.mOut, ambience: M.aOut, lite, reverb: G.audio.reverb() });
    M.zone = null;
    M.parts = [true, true];
  }
  // 强度：只读游戏状态
  function intensity() {
    const st = G.state, P = G.player;
    if (!st || !P || !st.zone || P.dead) return 0;
    const now = st.time, C = G.combat || NOC;
    let last = C.dealt > C.taken ? C.dealt : C.taken;
    if (last > now + 0.01 || last <= M.calm) last = -1e9; // 读档后模拟时钟重来 / 首领刚死、刚换区：之前的交手不算
    const since = now - last;
    const mb = M.boss;
    if (mb && (mb.dead || !(mb.hp > 0))) {
      M.boss = null;
      M.calm = now; // 首领倒下：直接回到探索
      return 0;
    }
    const b = st.boss;
    if (b && !b.dead && b.hp > 0 && b.awake && since < BOSS_HOLD) {
      const dx = b.x - P.x, dz = b.z - P.z;
      if (dx * dx + dz * dz < BOSS_R * BOSS_R) {
        M.boss = b;
        return 2;
      }
    }
    return since < (M.I >= 1 ? FIGHT_HOLD : FIGHT_IN) ? 1 : 0;
  }
  function step() {
    const t0 = performance.now();
    const lite = !!LITE[quality()];
    if (lite !== M.lite) {
      // 换了画质档：旧引擎淡出、停掉，按新档重建（区域照旧）
      M.eng.pause(0.4);
      make();
    }
    const id = zoneId();
    const E = M.eng;
    if (id && id !== M.zone) {
      E.setZone(id);
      if (!M.zone) E.start();
      M.zone = id;
      M.I = 0;
      M.boss = null;
      M.calm = G.state.time;
      E.setIntensity(0);
    }
    const L = G.audio.levels();
    const menu = G.ui && ((G.ui.titleOn && G.ui.titleOn()) || (G.ui.storyOn && G.ui.storyOn()));
    const pm = L.music > 0 && !menu, pa = L.amb > 0;
    if (pm !== M.parts[0] || pa !== M.parts[1]) E.setParts(pm, pa), (M.parts = [pm, pa]);
    const I = id ? intensity() : 0;
    if (I !== M.I) (M.I = I), E.setIntensity(I);
    E.tick();
    const d = performance.now() - t0;
    M.ticks++;
    M.ms += d;
    if (d > M.maxMs) M.maxMs = d;
  }
  function refresh() {
    if (!M.ctx) return;
    const w = want();
    if (w && !M.active) {
      M.active = true;
      if (!M.eng) make();
      else M.eng.resume(false);
      M.timer = setInterval(step, TICK);
      step();
    } else if (!w && M.active) {
      M.active = false;
      clearInterval(M.timer);
      M.timer = null;
      if (M.eng) M.eng.pause();
    }
  }
  G.audio.onStart((ctx) => {
    M.ctx = ctx;
    M.seed = ((performance.now() * 1000) ^ Date.now()) >>> 0 || 1; // 每次会话不同；不取 Math.random
    M.mOut = ctx.createGain();
    M.mOut.gain.value = OUT.music;
    M.mOut.connect(G.audio.bus('music'));
    M.aOut = ctx.createGain();
    M.aOut.gain.value = OUT.amb;
    M.aOut.connect(G.audio.bus('amb'));
    if (ctx.addEventListener) ctx.addEventListener('statechange', refresh);
    refresh();
  });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);

  G.music = {
    OUT,
    LITE,
    refresh,
    engine: () => M.eng,
    // 测试 / 调试用：同步走一拍（不等定时器）
    step: () => M.active && step(),
    state() {
      const E = M.eng;
      return {
        started: !!M.ctx, active: M.active, timer: !!M.timer, engineTimer: !!(E && E.running), paused: E ? E.paused : null,
        live: E ? E.live() : 0, zone: E ? E.zone : null, intensity: M.I, engineIntensity: E ? E.intensity : 0, parts: M.parts.slice(), lite: M.lite,
        ticks: M.ticks, avgMs: M.ticks ? +(M.ms / M.ticks).toFixed(3) : 0, maxMs: +M.maxMs.toFixed(3),
      };
    },
  };
})();
