'use strict';
// 音频：WebAudio 合成音效 + 混音总线（sfx-synth）。不用任何采样文件，全部现场合成。
//
// 信号链（每个 AudioContext 一套，实时的和离线渲染的结构相同）：
//   一次音效 = 一个「声部」：各层（振荡器 / 滤波噪声 / FM）→ 声部增益（被抢占时淡出）→ 声像 → 总线
//   总线 sfx / ui / amb / music → 总音量 master（静音 = 0）→ 总线压缩（轻）→ 限幅（快）→ 软削波（顶到 −1 dBFS 为止）→ 输出
//   每条总线另有一路送到共用混响（卷积，脉冲响应由 sfxRand 现场生成），混响回来进 master
//
// 给下一位（环境音 / 音乐）用的接口，都挂在 G.audio 上：
//   G.audio.onStart(cb)     AudioContext 第一次建好（首次按键 / 点击）后调 cb(ctx)；已经建好就立刻调。没有 WebAudio 就永远不调
//   G.audio.ctx()           实时的 AudioContext（还没建 / 建不了是 null）
//   G.audio.bus(name)       'sfx' | 'ui' | 'amb' | 'music' 的输入 GainNode（音量设置已经乘在总线上，接上去就行）；没建好是 null
//   G.audio.reverb()        共用混响的输入（想多送一点混响就再接一路过去）
//   G.audio.noise()         1 秒的白噪声 AudioBuffer（单声道，可 loop）
//   G.audio.rng(seed)       私有随机序列工厂：返回 () => [0, 1)。声音里一律用它，不碰 Math.random（G.sfx 在模拟里调用，见 fc94b21）
//   G.audio.apply()         重新读 G.save.opts 的音量 / 静音并应用（设置页改了就调）
//   G.audio.vol(v)          滑条 0–100 → 增益的曲线（平方，听感上比较均匀）
//   G.audio.levels()        按 G.save.opts 算出的各级目标增益 { master, sfx, ui, amb, music, silent }（没有 AudioContext 也能用）
//   G.audio.render(events, dur, o)  离线渲染（OfflineAudioContext，同一套链路和配方）：events = [{ t, name, p }]，
//                           o = { seed, noThrottle, opts, sr, attach(oc, { bus, reverb }) }；返回 Promise<{ buf, peak, stats }>。测试和试听用
//   音乐和环境音（js/score.js 的 G.music）接在 amb / music 两条总线上；静音或音量为 0 时整个停掉
//   G.audio.stats(reset)    { calls, played, ms, maxMs, voices, peakVoices, stolen, dropped, throttled }：G.sfx 的主线程耗时和声部数
// 存档里的设置（save.opts）：volMaster / volSfx / volAmb / volMusic（0–100）、mute（布尔）；默认见 G.audio.DEFAULTS
(function () {
  const G = window.G;

  const DEFAULTS = { volMaster: 80, volSfx: 80, volAmb: 60, volMusic: 50, mute: false };
  // 默认音量（80 / 80）时音效的整体响度和改版前一样（试听样本里按战斗混剪的 LUFS 对齐，见 tools/sfx-listen.mjs）
  const BASE = 0.2;
  const BUS_TRIM = { sfx: 1, ui: 0.85, amb: 1, music: 1 };
  const BUS_SEND = { sfx: 0.13, ui: 0.07, amb: 0.22, music: 0.12 }; // 送混响的量
  const MAX_VOICES = 16;
  const CEIL = 0.89; // −1 dBFS：软削波的天花板

  const mkRng = (seed) => {
    let s = seed >>> 0 || 1;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  };
  // 音效自己的随机序列（噪声、混响的脉冲响应、音高 / 滤波 / 时机的浮动）：音效按真实时间限流、要等第一次按键才建，
  // 用 Math.random 的话放没放出声会挪动游戏的随机序列（同一个种子帧快帧慢打出来不一样）
  const sfxRand = mkRng(0x5f3759df);
  let rand = sfxRand; // 离线渲染时临时换成渲染自己的序列

  const vol = (v) => {
    const x = Math.max(0, Math.min(100, +v || 0)) / 100;
    return x * x;
  };

  // 软削波曲线：|x| < 0.6 原样通过，往上按 tanh 平滑地压到 CEIL。WaveShaper 只认 [−1, 1] 的输入：先缩小 K 倍送进去，
  // 曲线第 i 格对应的原电平是 x = x′ × K、输出直接是原电平下的 y，所以覆盖到 +12 dB、出来不用再放大
  const CLIP_K = 4;
  let clipCurve = null;
  function getClipCurve() {
    if (clipCurve) return clipCurve;
    const n = 4097, a = 0.6, c = CEIL;
    clipCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * CLIP_K;
      const ax = Math.abs(x);
      const y = ax < a ? ax : a + (c - a) * Math.tanh((ax - a) / (c - a));
      clipCurve[i] = x < 0 ? -y : y;
    }
    return clipCurve;
  }

  // 混响的脉冲响应：立体声 1.1 秒衰减噪声，越往后越闷（空气吸收），开头 8 ms 渐入
  function makeIR(ac, R) {
    const sr = ac.sampleRate, len = Math.floor(sr * 1.1);
    const ir = ac.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let y = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const k = 0.75 - 0.6 * (i / len); // 一阶低通系数：越到尾巴越闷
        y += k * ((R() * 2 - 1) - y);
        const fade = t < 0.008 ? t / 0.008 : 1;
        d[i] = y * fade * Math.exp(-t * 5.2);
      }
    }
    return ir;
  }

  function buildGraph(ac, R) {
    const g = { ac, bus: {}, send: {}, voices: [], lastPlay: {}, stolen: 0, dropped: 0, peakVoices: 0, throttled: 0, silent: false, victims: {} };
    const out = ac.createGain();
    out.gain.value = 1 / CLIP_K;
    const clip = ac.createWaveShaper();
    clip.curve = getClipCurve();
    clip.oversample = 'none'; // 过采样的抗混叠滤波会冲过天花板一点，这里要硬上限
    // 限幅：快启动、高压缩比。DynamicsCompressor 会自带补偿增益，最后由软削波兜底
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 0;
    lim.ratio.value = 20;
    lim.attack.value = 0.001;
    lim.release.value = 0.09;
    // 总线压缩：轻，把一串命中粘在一起
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 10;
    comp.ratio.value = 2.5;
    comp.attack.value = 0.006;
    comp.release.value = 0.2;
    const master = ac.createGain();
    master.gain.value = BASE;
    master.connect(comp);
    comp.connect(lim);
    lim.connect(out);
    out.connect(clip);
    clip.connect(ac.destination); // 曲线的输出已经是原来的电平（见 getClipCurve），不用再放大回去
    // 混响：卷积 → 去掉低频糊和高频刺 → 回到 master
    const rvIn = ac.createGain();
    const conv = ac.createConvolver();
    conv.normalize = true;
    conv.buffer = makeIR(ac, R);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 220;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4800;
    const rvOut = ac.createGain();
    rvOut.gain.value = 0.7;
    rvIn.connect(conv);
    conv.connect(hp);
    hp.connect(lp);
    lp.connect(rvOut);
    rvOut.connect(master);
    for (const k of ['sfx', 'ui', 'amb', 'music']) {
      const b = ac.createGain();
      b.connect(master);
      const s = ac.createGain();
      s.gain.value = BUS_SEND[k];
      b.connect(s);
      s.connect(rvIn);
      g.bus[k] = b;
      g.send[k] = s;
    }
    g.master = master;
    g.rvIn = rvIn;
    g.lim = lim;
    g.noise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const ch = g.noise.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = R() * 2 - 1;
    return g;
  }

  // 存档里的设置 → 各级的目标增益（没有 AudioContext 也能算，测试和设置页用）
  function levelsOf(o) {
    o = o || DEFAULTS;
    const num = (k) => (typeof o[k] === 'number' ? o[k] : DEFAULTS[k]);
    const m = o.mute ? 0 : vol(num('volMaster'));
    const sfx = vol(num('volSfx'));
    return {
      master: m * BASE, sfx: sfx * BUS_TRIM.sfx, ui: sfx * BUS_TRIM.ui,
      amb: vol(num('volAmb')) * BUS_TRIM.amb, music: vol(num('volMusic')) * BUS_TRIM.music, silent: m === 0 || sfx === 0,
    };
  }
  function applyTo(g, o, now) {
    const L = levelsOf(o);
    const set = (p, v) => {
      if (now === null) p.value = v;
      else p.setTargetAtTime(v, now, 0.03);
    };
    set(g.master.gain, L.master);
    set(g.bus.sfx.gain, L.sfx);
    set(g.bus.ui.gain, L.ui);
    set(g.bus.amb.gain, L.amb);
    set(g.bus.music.gain, L.music);
    g.silent = L.silent; // 音效听不见就干脆不排（省主线程）
  }

  let live = null; // 实时那一套
  let ac = null; // 当前正在往里排声音的 context（实时的，或离线渲染时的那个）
  let gr = null;
  const starters = [];

  function audioInit() {
    try {
      if (live) {
        // iOS 切后台回来是 'interrupted'（桌面只有 suspended / running / closed 三种，和原来一样）
        if (live.ac.state !== 'running' && live.ac.state !== 'closed') live.ac.resume();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const c = new AC();
      live = buildGraph(c, sfxRand);
      applyTo(live, G.save && G.save.opts, null);
      ac = c;
      gr = live;
    } catch (e) {
      live = null;
      ac = null;
      gr = null;
      return;
    }
    for (const f of starters.splice(0)) {
      try {
        f(live.ac);
      } catch (e) {
        /* 静默 */
      }
    }
  }
  window.addEventListener('pointerdown', audioInit, true);
  window.addEventListener('keydown', audioInit, true);

  // ============================================================
  // 声部和各层
  // ============================================================
  let V = null; // 正在搭的声部

  // 优先级：0 界面小声、1 敌方的声音、2 自己的普通命中 / 挥砍 / 射击、3 击杀 / 施法 / 暴击、4 终结 / 处决 / 升级 / 首领 / 受伤
  function voiceBegin(t, name, bus, prio, wet, pan) {
    const g = gr;
    // 已经放完的声部从表里拿掉
    const vs = g.voices;
    for (let i = vs.length - 1; i >= 0; i--) if (vs[i].end <= t) vs.splice(i, 1);
    if (vs.length >= MAX_VOICES) {
      // 抢占：先挑优先级最低的，同级挑最早开始的；它在 15 ms 内淡出
      let vi = -1;
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        if (vi < 0 || v.prio < vs[vi].prio || (v.prio === vs[vi].prio && v.t < vs[vi].t)) vi = i;
      }
      const v = vs[vi];
      if (v.prio > prio) return false; // 正在响的全都比这一声重要：这一声不放
      vs.splice(vi, 1);
      killVoice(v, t);
      g.stolen++;
      const vk = v.name + '/' + v.prio;
      g.victims[vk] = (g.victims[vk] || 0) + 1;
    }
    const vg = ac.createGain();
    let tail = vg;
    if (pan && ac.createStereoPanner) {
      const pn = ac.createStereoPanner();
      pn.pan.value = pan;
      vg.connect(pn);
      tail = pn;
    }
    tail.connect(g.bus[bus]);
    if (wet) {
      const s = ac.createGain();
      s.gain.value = wet;
      tail.connect(s);
      s.connect(g.rvIn);
    }
    V = { g: vg, t, end: t, prio, srcs: [], name, k: 1 };
    return true;
  }
  function killVoice(v, t) {
    v.g.gain.setValueAtTime(v.k, t);
    v.g.gain.setTargetAtTime(0, t, 0.005);
    const st = t + 0.04;
    for (const s of v.srcs) if (s.e > st) s.n.stop(st);
  }
  function voiceEnd() {
    if (!V) return;
    gr.voices.push(V);
    if (gr.voices.length > gr.peakVoices) gr.peakVoices = gr.voices.length;
    V = null;
  }
  // 这一声整体的电平（各配方按类别对齐响度用，见 tools 里的试听指标）
  function trim(k) {
    V.k *= k;
    V.g.gain.value = V.k;
  }
  function addSrc(n, e) {
    V.srcs.push({ n, e });
    if (e > V.end) V.end = e;
  }

  function env(g, t0, dur, vol, attack) {
    const a = Math.min(attack || 0.005, dur * 0.8);
    // 增益节点默认是 1、而 BufferSource 的起点是亚采样精度：不先置 0 的话，起点前那一个采样会按 1 倍漏过去，
    // 过高通以后就是一个单采样的尖峰（实测比整段响 20 多倍）
    g.gain.value = 0;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }
  // 单个振荡器音：频率 f0 → f1 滑动。lp：再过一个低通（锯齿 / 方波去刺）
  function tone(type, f0, f1, t0, dur, vol, attack, lp) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    env(g, t0, dur, vol, attack);
    if (lp) {
      const f = ac.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lp;
      f.Q.value = 0.5;
      o.connect(f);
      f.connect(g);
    } else o.connect(g);
    g.connect(V.g);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
    addSrc(o, t0 + dur + 0.03);
  }
  // 滤波噪声：滤波频率 f0 → f1 扫动
  function noise(ftype, f0, f1, t0, dur, vol, q, attack) {
    const s = ac.createBufferSource();
    const f = ac.createBiquadFilter();
    const g = ac.createGain();
    s.buffer = gr.noise;
    s.loop = true;
    f.type = ftype;
    f.Q.value = q || 0.8;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    env(g, t0, dur, vol, attack);
    s.connect(f);
    f.connect(g);
    g.connect(V.g);
    s.start(t0, rand() * 0.6);
    s.stop(t0 + dur + 0.03);
    addSrc(s, t0 + dur + 0.03);
  }
  // FM 钟 / 金属音：载波 fc（→ fc1），调制器 fc × ratio，调制深度从 idx 衰减到 0（起音亮、尾巴纯）
  // ratio 取非整数（1.41、2.76）是金属 / 冰的不谐和泛音，取整数是钟 / 铃
  function fm(fc, ratio, idx, t0, dur, vol, attack, fc1) {
    const c = ac.createOscillator();
    const m = ac.createOscillator();
    const mg = ac.createGain();
    const g = ac.createGain();
    c.frequency.setValueAtTime(fc, t0);
    if (fc1 && fc1 !== fc) c.frequency.exponentialRampToValueAtTime(fc1, t0 + dur);
    m.frequency.setValueAtTime(fc * ratio, t0);
    const d = fc * ratio * idx;
    mg.gain.setValueAtTime(d, t0);
    mg.gain.exponentialRampToValueAtTime(Math.max(1, d * 0.02), t0 + dur);
    m.connect(mg);
    mg.connect(c.frequency);
    env(g, t0, dur, vol, attack || 0.002);
    c.connect(g);
    g.connect(V.g);
    c.start(t0);
    m.start(t0);
    c.stop(t0 + dur + 0.03);
    m.stop(t0 + dur + 0.03);
    addSrc(c, t0 + dur + 0.03);
    addSrc(m, t0 + dur + 0.03);
  }
  // 起音的「咔」：极短的高通噪声
  function tick(t0, f, vol, dur) {
    noise('highpass', f, f * 0.7, t0, dur || 0.012, vol, 0.7, 0.0008);
  }
  // 一串随机的小爆裂（火的噼啪、冰碴、电火花）：一个噪声源 + 一个带通，颗粒全排在同一个增益上（每颗一个短脉冲），
  // 比每颗各建一套节点省得多
  function crackle(t0, span, n, f, vol) {
    const s = ac.createBufferSource();
    const fl = ac.createBiquadFilter();
    const g = ac.createGain();
    s.buffer = gr.noise;
    s.loop = true;
    fl.type = 'bandpass';
    fl.Q.value = 1.6;
    fl.frequency.value = f * (0.9 + rand() * 0.3);
    const ts = [];
    for (let i = 0; i < n; i++) ts.push([t0 + rand() * span, 0.008 + rand() * 0.01, vol * (0.6 + rand() * 0.4)]);
    ts.sort((a, b) => a[0] - b[0]);
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t0);
    for (const [tt, d, v] of ts) {
      g.gain.setValueAtTime(v, tt);
      g.gain.setTargetAtTime(0, tt + 0.0006, d / 4);
    }
    s.connect(fl);
    fl.connect(g);
    g.connect(V.g);
    const end = ts[ts.length - 1][0] + 0.04;
    s.start(t0, rand() * 0.6);
    s.stop(end);
    addSrc(s, end);
  }
  const jit = (a) => 1 + (rand() * 2 - 1) * a; // 1 ± a
  const dt = () => rand() * 0.004; // 层与层之间几毫秒的错位

  // ============================================================
  // 配方
  // ============================================================
  // 伤害类型的音色层（命中 / 击杀都用）：分量 w（0 轻、1 重、2 很重）
  const TYPE_LAYER = {
    phys(t, v, w) {
      // 金属磕碰：不谐和的 FM 短音 + 窄带噪声；重的多一层碎裂
      fm(860 * v, 1.41, 2.2, t + dt(), 0.08 + w * 0.02, 0.1, 0.001, 620 * v);
      noise('bandpass', 2700 * v, 2000, t, 0.04, 0.13, 2.2, 0.001);
      if (w >= 1) noise('bandpass', 900 * v, 380, t + 0.008, 0.1 + w * 0.03, 0.22, 1.1, 0.002);
    },
    fire(t, v, w) {
      // 火：闷燃的一团（滤波往上开），后面几声噼啪
      noise('lowpass', 380 * v, 1700 * v, t, 0.15 + w * 0.05, 0.36, 0.9, 0.012);
      tone('sawtooth', 130 * v, 66, t, 0.12 + w * 0.04, 0.1, 0.006, 700);
      crackle(t + 0.05, 0.16 + w * 0.06, 3 + w, 2600, 0.11);
    },
    cold(t, v, w) {
      // 冰：玻璃一样的钟音（2.76 的不谐和泛音）+ 冰碴
      fm(2050 * v, 2.76, 1.4, t + dt(), 0.16 + w * 0.05, 0.1, 0.001, 1900 * v);
      noise('bandpass', 4300 * v, 3200, t, 0.05, 0.12, 3, 0.001);
      crackle(t + 0.015, 0.06 + w * 0.03, 2 + w, 5200, 0.09);
    },
    light(t, v, w) {
      // 电：两声噼啪的电弧，中间夹一下嗡
      tone('square', 1500 * v, 230, t, 0.055, 0.06, 0.001, 5000);
      noise('highpass', 3600 * v, 1900, t, 0.05, 0.15, 0.9, 0.001);
      tone('sawtooth', 95 * v, 80, t + 0.01, 0.07 + w * 0.03, 0.08, 0.004, 1600);
      tone('square', 1100 * v, 180, t + 0.03 + rand() * 0.01, 0.04, 0.045, 0.001, 5000);
    },
    chaos(t, v, w) {
      // 混沌：两条略微走调的正弦一起往下沉（拍频的颤），尾巴一点倒吸的嘶声
      tone('sine', 250 * v, 78, t, 0.16 + w * 0.04, 0.11, 0.004);
      tone('sine', 257 * v, 76, t, 0.16 + w * 0.04, 0.08, 0.004);
      noise('bandpass', 650 * v, 300, t + 0.02, 0.15 + w * 0.04, 0.12, 1.5, 0.03);
    },
  };

  // 主要技能命中时多一层自己的点缀（叠在伤害类型的音色上，很短，不改响度的大局）
  const IMPACT_ID = {
    // 掷焰：火团炸开的「噗」
    ember(t, v) {
      tone('sine', 230 * v, 85, t, 0.07, 0.22, 0.002);
      noise('bandpass', 900 * v, 320, t, 0.09, 0.14, 1.1, 0.004);
    },
    // 飞刃：刃口划过的「嚓」
    blade(t, v) {
      fm(2300 * v, 1.41, 1.2, t + 0.004, 0.06, 0.06, 0.001, 2000 * v);
      noise('bandpass', 2600 * v, 3400 * v, t, 0.05, 0.1, 2.5, 0.002);
    },
    // 链雷：电弧跳走的尾巴
    arc(t, v) {
      crackle(t + 0.02, 0.07, 3, 2600, 0.1);
    },
    // 陨火：落地的爆炸，带碎石
    meteor(t, v) {
      noise('lowpass', 900 * v, 90, t, 0.3, 0.3, 0.8, 0.003);
      crackle(t + 0.05, 0.2, 4, 1300, 0.1);
    },
    // 冰系：碎冰的余韵
    frost(t, v) {
      fm(3000 * v, 2.76, 0.8, t + 0.01, 0.12, 0.05, 0.001, 2800 * v);
    },
  };
  const IMPACT_MAP = { ember: 'ember', blade: 'blade', arc: 'arc', arcvolley: 'arc', meteor: 'meteor', firestorm: 'meteor', frostline: 'frost', icefall: 'frost' };

  // 施法的音色（按技能挑，没有专门的就按元素）
  const CAST_TYPE = {
    fire(t, v) {
      noise('bandpass', 420 * v, 2000 * v, t, 0.2, 0.32, 1.1, 0.03);
      tone('sine', 200 * v, 430 * v, t, 0.15, 0.14, 0.01);
      crackle(t + 0.06, 0.12, 2, 2400, 0.07);
    },
    cold(t, v) {
      fm(1450 * v, 2.76, 0.9, t, 0.24, 0.08, 0.02, 1560 * v);
      noise('highpass', 5200, 3800, t, 0.16, 0.07, 0.8, 0.03);
      noise('bandpass', 700 * v, 1800 * v, t, 0.14, 0.18, 1.2, 0.02);
    },
    light(t, v) {
      tone('sawtooth', 280 * v, 1700 * v, t, 0.12, 0.06, 0.01, 3000);
      noise('bandpass', 1400 * v, 4600 * v, t, 0.11, 0.17, 1.4, 0.01);
      crackle(t + 0.04, 0.08, 2, 3800, 0.07);
    },
    chaos(t, v) {
      tone('sine', 190 * v, 115 * v, t, 0.28, 0.17, 0.06);
      tone('sine', 196 * v, 112 * v, t, 0.28, 0.12, 0.06);
      noise('bandpass', 1100 * v, 380, t, 0.24, 0.18, 1.3, 0.08);
    },
    phys(t, v) {
      noise('bandpass', 900 * v, 2900 * v, t, 0.12, 0.3, 1.3, 0.02);
      tone('sine', 300 * v, 560 * v, t, 0.1, 0.1, 0.01);
    },
  };
  // 主要技能各自的施法声
  const CAST_ID = {
    // 掷焰：甩出去的一下 + 点燃
    ember(t, v) {
      noise('bandpass', 1100 * v, 2600 * v, t, 0.07, 0.2, 1.4, 0.008);
      CAST_TYPE.fire(t + 0.02, v);
    },
    // 飞刃：旋转利刃出手的「锵」+ 呼呼的转
    blade(t, v) {
      fm(1250 * v, 1.41, 1.8, t, 0.16, 0.08, 0.001, 1150 * v);
      noise('bandpass', 2100 * v, 1500 * v, t, 0.2, 0.2, 4, 0.02);
      tick(t, 3500, 0.12);
    },
    // 链雷：充能往上一窜，接一串电火花
    arc(t, v) {
      tone('sawtooth', 300 * v, 1400 * v, t, 0.1, 0.16, 0.005, 2500);
      crackle(t + 0.03, 0.1, 4, 2200, 0.2);
      noise('bandpass', 1800 * v, 900, t + 0.04, 0.08, 0.3, 2, 0.002);
    },
    // 陨火：一声往上的呼啸，底下滚着火
    meteor(t, v) {
      tone('sine', 620 * v, 1750 * v, t, 0.34, 0.07, 0.2);
      noise('lowpass', 200, 600, t, 0.4, 0.3, 0.8, 0.1);
      noise('bandpass', 800 * v, 2400 * v, t + 0.05, 0.3, 0.12, 1.2, 0.15);
    },
    // 旋风斩：一高一低两道破空声转起来
    whirl(t, v) {
      noise('bandpass', 700 * v, 2400 * v, t, 0.26, 0.28, 1.4, 0.08);
      noise('bandpass', 2200 * v, 900 * v, t + 0.06, 0.24, 0.2, 1.4, 0.07);
    },
    // 闪身类：短促的一声「嗖」
    blink(t, v) {
      noise('bandpass', 600 * v, 4200 * v, t, 0.1, 0.28, 1.2, 0.01);
      tone('sine', 800 * v, 2100 * v, t, 0.08, 0.05, 0.01);
    },
    // 冰系：冰碴往上长
    frost(t, v) {
      crackle(t, 0.14, 4, 5000, 0.1);
      fm(1300 * v, 2.76, 1.1, t + 0.02, 0.26, 0.08, 0.01, 1500 * v);
      noise('bandpass', 600 * v, 1600 * v, t, 0.18, 0.16, 1.2, 0.04);
    },
    // 电系持续 / 引导：电流的嗡一下起来，带两声噼啪
    surge(t, v) {
      tone('sawtooth', 110 * v, 140 * v, t, 0.26, 0.09, 0.05, 1400);
      tone('sawtooth', 220 * v, 280 * v, t, 0.22, 0.04, 0.05, 2500);
      crackle(t + 0.05, 0.16, 3, 3400, 0.09);
    },
    // 黑洞 / 黑旋风 / 黑焰：空气被吸进去
    void(t, v) {
      noise('bandpass', 3000 * v, 320, t, 0.36, 0.26, 1.3, 0.22);
      tone('sine', 320 * v, 85, t + 0.05, 0.34, 0.2, 0.15);
      tone('sine', 60, 42, t + 0.22, 0.3, 0.3, 0.02);
    },
    // 召唤：地面一声闷响 + 一点空灵的回声
    summon(t, v) {
      tone('sine', 92 * v, 44, t, 0.26, 0.42, 0.004);
      noise('lowpass', 1200, 160, t, 0.18, 0.3, 0.8, 0.004);
      tone('triangle', 330 * v, 334 * v, t + 0.04, 0.42, 0.06, 0.08);
      tone('sine', 495 * v, 497 * v, t + 0.06, 0.36, 0.035, 0.08);
    },
    // 震地 / 地脉：闷闷的隆一下
    quake(t, v) {
      tone('sine', 72 * v, 36, t, 0.36, 0.5, 0.01);
      noise('lowpass', 320, 110, t, 0.34, 0.36, 0.8, 0.02);
      crackle(t + 0.06, 0.2, 3, 900, 0.12);
    },
    // 连射 / 散射：出膛很快的几下
    volley(t, v) {
      for (let i = 0; i < 3; i++) noise('bandpass', 1600 * v, 3400 * v, t + i * 0.035 + dt(), 0.06, 0.18, 1.6, 0.004);
      tick(t, 3000, 0.08);
    },
    // 刃类近战技：金属出鞘的「锵」
    steel(t, v) {
      fm(1500 * v, 1.41, 2, t, 0.2, 0.09, 0.001, 1400 * v);
      noise('bandpass', 3000 * v, 2200, t, 0.08, 0.1, 2, 0.002);
      noise('bandpass', 900 * v, 2600 * v, t, 0.11, 0.2, 1.3, 0.015);
    },
    // 光环：轻轻一声环
    aura(t, v) {
      fm(880 * v, 2, 0.8, t, 0.4, 0.06, 0.03);
      fm(1320 * v, 2, 0.6, t + 0.05, 0.36, 0.04, 0.03);
      noise('highpass', 5000, 6000, t, 0.25, 0.04, 0.7, 0.08);
    },
  };
  const CAST_MAP = {
    ember: 'ember', blade: 'blade', arc: 'arc', arcvolley: 'arc', meteor: 'meteor', firestorm: 'meteor',
    whirl: 'whirl', blink: 'blink', shadestep: 'blink', flashcut: 'blink', shadowstab: 'blink',
    frostline: 'frost', icefall: 'frost', emberstorm: 'frost', discharge: 'surge', tether: 'surge', meltray: 'surge',
    blackhole: 'void', vortex: 'void', blackflame: 'void', soultide: 'void',
    thrall: 'summon', colossus: 'summon', pyre: 'summon', quake: 'quake', leyburst: 'quake',
    nails: 'volley', volley: 'volley', wildfire: 'volley', rend: 'steel', riposte: 'steel', pierceheart: 'steel',
    nova: 'aura',
  };
  // 各施法声的电平（dB 换算后的倍数），让它们都落在「轻命中 − 5 LU」附近
  const db2k = (d) => Math.pow(10, d / 20);
  const CAST_GAIN = {
    ember: db2k(4.8), blade: db2k(9.6), arc: db2k(8.3), meteor: db2k(3.7), whirl: db2k(7.5), blink: db2k(16), frost: db2k(4.6),
    surge: db2k(8.6), void: db2k(-4.7), summon: 1, quake: db2k(-4.3), volley: db2k(6), steel: db2k(8.4), aura: db2k(5),
  };
  function skillType(id) {
    const sk = G.SKILLS && G.SKILLS[id];
    if (!sk || !sk.tags) return null;
    for (const k of ['fire', 'cold', 'light', 'chaos', 'phys']) if (sk.tags.indexOf(k) >= 0) return k;
    return null;
  }

  // 拾取的音阶（按稀有度）：普通 → 魔法 → 稀有 → 烬铸 → 渊契
  const PICK_NOTES = [[660], [660, 990], [784, 988, 1175], [784, 988, 1175, 1568], [523, 622, 784, 1047]];
  const PICK_GAIN = [1.41, 0.66, 0.72, 0.65, 0.68]; // 越稀有越响，但一档只差 2 LU 左右，不压过打斗

  // name → [总线, 优先级, 额外混响, 电平]。电平按试听样本的 LUFS 对齐：轻命中为基准，击杀略高，施法低 5 LU，界面再低
  const META = {
    click: ['ui', 0, 0, 1.23], deny: ['ui', 1, 0], ready: ['ui', 1, 0.05], craft: ['ui', 2, 0.15, 1.41], gem: ['ui', 2, 0.18, 0.86],
    pickup: ['ui', 2, 0.08], drop: ['ui', 1, 0], level: ['ui', 4, 0.3, 1.41], unique: ['ui', 4, 0.3, 1.41],
    hit: ['sfx', 1, 0], hurt: ['sfx', 4, 0.06, 1.6], swing: ['sfx', 2, 0], shot: ['sfx', 2, 0.04], impact: ['sfx', 2, 0],
    kill: ['sfx', 3, 0.1, 2.5], cast: ['sfx', 3, 0.08], crit: ['sfx', 3, 0.05], roll: ['sfx', 2, 0], heart: ['sfx', 4, 0],
    death: ['sfx', 4, 0.35], boss: ['sfx', 4, 0.3, 1.41], finisher: ['sfx', 4, 0.2, 1.58], break: ['sfx', 4, 0.25, 1.58],
    execstart: ['sfx', 4, 0.1], execute: ['sfx', 4, 0.3, 1.58], markburst: ['sfx', 3, 0.15], ashcuts: ['sfx', 4, 0.3, 1.41],
    tristorm: ['sfx', 4, 0.3, 1.41], soulhost: ['sfx', 4, 0.35, 1.41], soulfire: ['sfx', 3, 0.15],
    round: ['sfx', 2, 0.05], lamp: ['sfx', 2, 0.08], // 特殊弹 / 提灯（class-d2b1）
  };

  const SFX = {
    // 特殊弹（class-d2b1）：p.type 弹种（zap = 雷楔放电）。铁水弹闷响一枪接滋滋声；雷楔叮地钉进去；霜霰弹一枪清脆的接碎冰声；反冲弹很重的一声炮响接靴底刮地
    round(t, p) {
      const v = jit(0.05);
      if (p.type === 'molten') {
        noise('lowpass', 1800 * v, 200, t, 0.14, 0.42, 0.8, 0.002);
        tone('sine', 95 * v, 42, t, 0.16, 0.26, 0.003);
        crackle(t + 0.08, 0.45, 9, 3200, 0.07);
        noise('highpass', 2600, 3400, t + 0.08, 0.4, 0.045, 0.7, 0.05);
      } else if (p.type === 'wedge') {
        noise('bandpass', 2400 * v, 900, t, 0.06, 0.24, 1.2, 0.002);
        fm(1900 * v, 2.4, 1.6, t + 0.01, 0.12, 0.09, 0.001);
        tick(t + 0.005, 4200, 0.16);
      } else if (p.type === 'zap') {
        trim(0.9);
        crackle(t, 0.07, 7, 4600, 0.16);
        noise('highpass', 3000 * v, 5200, t, 0.05, 0.18, 0.8, 0.001);
        tone('square', 180 * v, 90, t, 0.04, 0.05, 0.001, 2400);
      } else if (p.type === 'rime') {
        tick(t, 5200, 0.3, 0.008);
        noise('highpass', 2600 * v, 1400, t, 0.09, 0.3, 0.9, 0.001);
        crackle(t + 0.05, 0.16, 8, 5200, 0.09);
        noise('bandpass', 3800, 2600, t + 0.05, 0.14, 0.06, 1.4, 0.004);
      } else {
        noise('lowpass', 2200 * v, 140, t, 0.32, 0.6, 0.7, 0.002);
        tone('sine', 72 * v, 30, t, 0.3, 0.42, 0.003);
        tick(t, 2600, 0.3, 0.014);
        noise('bandpass', 700 * v, 380, t + 0.08, 0.26, 0.1, 1.1, 0.02);
      }
    },
    // 提灯（class-d2b1）：p.phase。甩灯 = 一声短的铜铃加呼的一下；落地 = 一下噗火；借火 = 低沉的火声往上涨；炸灯 = 闷的一声；灯海 = 往上涨的火声加两声铃
    lamp(t, p) {
      const v = jit(0.04);
      const bell = (t0, f, vol) => {
        fm(f * v, 2.76, 1.4, t0, 0.32, vol, 0.002);
        tone('sine', f * 2.01 * v, f * 2.0 * v, t0, 0.22, vol * 0.35, 0.002);
      };
      if (p.phase === 'throw') {
        bell(t, 1250, 0.07);
        noise('bandpass', 700 * v, 1500, t, 0.16, 0.1, 0.8, 0.03);
      } else if (p.phase === 'land') {
        noise('lowpass', 900 * v, 220, t, 0.13, 0.22, 0.8, 0.004);
        crackle(t + 0.03, 0.18, 4, 2600, 0.04);
      } else if (p.phase === 'lend' || p.phase === 'sea') {
        noise('lowpass', 220 * v, 1100, t, 0.7, 0.24, 0.9, 0.25);
        tone('sine', 70 * v, 120, t, 0.6, 0.12, 0.2);
        crackle(t + 0.2, 0.5, 8, 2400, 0.05);
        if (p.phase === 'sea') {
          bell(t + 0.05, 1050, 0.06);
          bell(t + 0.18, 1400, 0.05);
        }
      } else {
        noise('lowpass', 1300 * v, 180, t, 0.2, 0.34, 0.8, 0.003);
        tone('sine', 88 * v, 40, t, 0.18, 0.2, 0.003);
      }
    },
    // 远程普攻：机炮短促的「哒」、左轮沉的一声「砰」带金属尾音、弓弦的「嘣」
    shot(t, p) {
      const v = jit(0.05);
      if (p.type === 'gatling') {
        trim(1.9);
        // 连发很快，起音不用高通（高频听久了累）：带通的短「哒」
        noise('bandpass', 1500 * v, 1100, t, 0.008, 0.22, 1.4, 0.0006);
        noise('bandpass', 1800 * v, 600, t, 0.05, 0.3, 1.2, 0.002);
        tone('square', 140 * v, 70, t, 0.045, 0.1, 0.002, 1200);
      } else if (p.type === 'revolver') {
        tick(t, 3500, 0.35, 0.01);
        noise('lowpass', 4200 * v, 300, t, 0.16, 0.55, 0.8, 0.002);
        tone('sine', 120 * v, 46, t, 0.13, 0.24, 0.002);
        fm(2200 * v, 1.41, 0.8, t + 0.02, 0.14, 0.035, 0.002);
        noise('bandpass', 900, 500, t + 0.05, 0.22, 0.08, 0.9, 0.04);
      } else {
        // 弓：弦的「嘣」（低频拨弦）+ 箭离弦的嗖
        trim(1.25);
        fm(210 * v, 1, 2.5, t, 0.13, 0.22, 0.002, 160 * v);
        noise('highpass', 1800, 4200, t + 0.01, 0.09, 0.14, 0.9, 0.004);
        tick(t, 2400, 0.08);
      }
    },
    // 施法：p.id 技能（自己放的），p.type 主伤害类型；p.foe 敌人放的（压低、换成暗一点的音色）；什么都不给 = 召唤物 / 其它
    cast(t, p) {
      const v = jit(0.05);
      if (p.foe >= 2) {
        // 精英 / 首领带预警的施法：躲闪提示。两个不谐和的音一起往上抬（FM 1.41），底下一层气声；首领再加一声低的
        trim(p.foe >= 3 ? 1.1 : 1.25);
        fm(330 * v, 1.41, 1.6, t, 0.26, 0.16, 0.02, 470 * v);
        fm(349 * v, 1.41, 1.2, t + 0.02, 0.24, 0.1, 0.02, 494 * v);
        noise('bandpass', 600 * v, 1900 * v, t, 0.22, 0.2, 1.4, 0.05);
        if (p.foe >= 3) tone('sine', 110, 82, t, 0.3, 0.16, 0.01);
        return;
      }
      if (p.foe) {
        trim(2.2);
        noise('bandpass', 380 * v, 1500 * v, t, 0.16, 0.2, 1.3, 0.03);
        tone('sine', 190 * v, 300 * v, t, 0.13, 0.08, 0.02);
        return;
      }
      const id = p.id && CAST_MAP[p.id];
      if (id) {
        trim(CAST_GAIN[id] || 1);
        return CAST_ID[id](t, v);
      }
      trim(1.6);
      const ty = p.type || skillType(p.id);
      if (ty && CAST_TYPE[ty]) return CAST_TYPE[ty](t, v);
      // 没有参数：原来的那一声
      noise('bandpass', 500 * v, 2600 * v, t, 0.14, 0.32, 1.4, 0.02);
      tone('sine', 300 * v, 620 * v, t, 0.12, 0.15, 0.01);
    },
    // 敌人打中你 / 召唤物之类的普通一下
    hit(t) {
      const v = jit(0.08);
      tick(t, 2500, 0.14);
      noise('lowpass', 1700 * v, 300, t, 0.07, 0.45);
      tone('sine', 165 * v, 72, t, 0.08, 0.32, 0.002);
      tone('square', 170 * v, 80, t, 0.06, 0.07, 0.002, 900);
    },
    crit(t) {
      SFX.impact(t, { type: 'phys', w: 1, crit: true });
    },
    // 自己受伤：有分量但不刺耳
    hurt(t) {
      const v = jit(0.04);
      tick(t, 1800, 0.18, 0.015);
      tone('triangle', 190 * v, 62, t, 0.24, 0.42, 0.004);
      tone('sawtooth', 160 * v, 60, t, 0.2, 0.12, 0.004, 900);
      noise('lowpass', 950, 170, t, 0.18, 0.42, 0.8, 0.003);
    },
    pickup(t, p) {
      if (p.cur) {
        // 通货：两下清脆的小碰撞
        const v = jit(0.04);
        fm(2100 * v, 1.5, 1.2, t, 0.09, 0.12, 0.001);
        fm(2650 * v, 1.5, 1.0, t + 0.055, 0.12, 0.1, 0.001);
        return;
      }
      const r = typeof p.r === 'number' ? Math.max(0, Math.min(4, p.r | 0)) : -1;
      if (r < 0) {
        // 其它（药、宝箱、卖东西……）：原来那两声
        tone('sine', 700, 700, t, 0.07, 0.24);
        tone('sine', 1050, 1050, t + 0.06, 0.1, 0.24);
        fm(2100, 2, 0.5, t + 0.06, 0.12, 0.03);
        return;
      }
      trim(PICK_GAIN[r]);
      const notes = PICK_NOTES[r];
      const gap = r >= 3 ? 0.07 : 0.055;
      tick(t, 3000, 0.05);
      notes.forEach((f, i) => {
        const tt = t + i * gap;
        if (r === 4) {
          // 渊契：低一点、偏小调，带一层低鸣
          tone('triangle', f, f, tt, 0.24, 0.17, 0.004);
          fm(f, 2, 0.6, tt, 0.22, 0.05);
        } else {
          tone(r >= 2 ? 'triangle' : 'sine', f, f, tt, 0.12 + r * 0.04, 0.2, 0.004);
          if (r >= 1) fm(f * 2, 2, 0.4, tt, 0.12 + r * 0.03, 0.04);
        }
      });
      if (r === 4) tone('sine', 131, 128, t, 0.5, 0.18, 0.05);
      if (r >= 2) noise('highpass', 6000, 7500, t + 0.1, 0.25, 0.03 + r * 0.008, 0.7, 0.05);
    },
    gem(t) {
      [784, 1047, 1568].forEach((f, i) => {
        tone('triangle', f, f, t + i * 0.08, 0.16 + i * 0.07, 0.22);
        fm(f, 2, 0.7, t + i * 0.08, 0.16 + i * 0.08, 0.06);
      });
      fm(3136, 2, 0.3, t + 0.16, 0.36, 0.035);
    },
    level(t) {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => {
        tone('triangle', f, f, t + i * 0.09, 0.3, 0.24);
        fm(f * 2, 2, 0.5, t + i * 0.09, 0.3, 0.06);
      });
      // 落在一个和弦上
      for (const f of [523, 784, 1319]) tone('triangle', f, f, t + 0.4, 0.75, 0.13, 0.02);
      fm(2093, 2, 0.4, t + 0.4, 0.8, 0.04, 0.02);
      noise('highpass', 5000, 8000, t + 0.36, 0.5, 0.05, 0.7, 0.05);
    },
    death(t) {
      tone('sawtooth', 220, 48, t, 1.1, 0.3, 0.02, 1200);
      tone('sine', 110, 36, t, 1.2, 0.42, 0.02);
      noise('lowpass', 1200, 90, t, 1.0, 0.32, 0.8, 0.03);
      fm(440, 1.41, 0.8, t + 0.05, 0.9, 0.05, 0.05, 330);
    },
    boss(t) {
      tone('sawtooth', 55, 52, t, 1.4, 0.36, 0.2, 600);
      tone('sawtooth', 58.3, 55, t, 1.4, 0.36, 0.2, 600);
      tone('sine', 110, 82, t + 0.1, 1.2, 0.28, 0.3);
      noise('lowpass', 200, 900, t, 1.1, 0.24, 0.8, 0.5);
      fm(220, 1.41, 1.2, t + 0.3, 1.0, 0.04, 0.3, 207);
    },
    click(t) {
      const v = jit(0.03);
      tone('sine', 1700 * v, 1150 * v, t, 0.03, 0.08, 0.001);
      tick(t, 3500, 0.04, 0.006);
    },
    // 烬铸掉落：一声短的低鸣托起一串上行的钟音，尾巴是余烬的嘶嘶声（低频比原来短，不盖住打斗）
    unique(t) {
      tone('sine', 65, 49, t, 0.8, 0.45, 0.02);
      tone('sawtooth', 98, 92, t, 0.7, 0.1, 0.05, 700);
      [392, 494, 587, 784, 988].forEach((f, i) => {
        const tt = t + 0.12 + i * 0.11;
        tone('triangle', f, f, tt, 1.0, 0.18, 0.01);
        fm(f * 1.5, 2, 0.5, tt, 0.8, 0.05, 0.01);
      });
      fm(1568, 2, 0.4, t + 0.75, 1.3, 0.1, 0.02, 1560);
      noise('bandpass', 2600, 5200, t + 0.2, 1.3, 0.1, 0.6, 0.4);
      crackle(t + 0.3, 0.9, 5, 3000, 0.05);
    },
    // 残刃引爆：几道刀刃同时出鞘的金属声
    markburst(t) {
      for (let i = 0; i < 4; i++) fm(2300 - i * 240, 1.41, 1.2, t + i * 0.012 + dt(), 0.18, 0.08, 0.001, 950);
      noise('highpass', 5200, 2600, t, 0.2, 0.2, 1, 0.003);
      tick(t, 3000, 0.15);
    },
    // ---- 烬铸技 ----
    // 千刃归烬：「咔」的一声入鞘，紧跟着千刃齐鸣的金属嗡响和一记沉闷的爆裂
    ashcuts(t) {
      tone('square', 2600, 1800, t, 0.03, 0.12, 0.001, 5000);
      noise('highpass', 6000, 3000, t, 0.05, 0.25, 1, 0.001);
      for (let i = 0; i < 6; i++) fm(3000 - i * 300, 1.41, 0.9, t + 0.02 + i * 0.014, 0.42, 0.06, 0.002, 1300 - i * 90);
      tone('sine', 70, 30, t + 0.02, 0.6, 0.75, 0.004);
      noise('lowpass', 3000, 140, t + 0.02, 0.5, 0.6, 0.8, 0.004);
      fm(1760, 2, 0.4, t + 0.1, 0.9, 0.06, 0.02, 1755);
    },
    // 三相天灾：低沉的雷云翻滚，三声上行的元素音
    tristorm(t) {
      noise('lowpass', 160, 700, t, 1.1, 0.4, 0.8, 0.25);
      tone('sawtooth', 55, 50, t, 1.0, 0.16, 0.2, 500);
      fm(330, 2, 0.8, t + 0.05, 0.4, 0.13, 0.01);
      fm(440, 2.76, 1, t + 0.16, 0.4, 0.12, 0.01);
      fm(587, 1.41, 1.2, t + 0.27, 0.6, 0.12, 0.01);
      crackle(t + 0.3, 0.4, 4, 3600, 0.06);
    },
    // 万魂降临：幡杆杵地的一声闷响，随后一片空灵的魂鸣
    soulhost(t) {
      tone('sine', 85, 34, t, 0.5, 0.8, 0.004);
      noise('lowpass', 1800, 150, t, 0.35, 0.5, 0.8, 0.004);
      [294, 370, 440, 587].forEach((f, i) => {
        tone('sine', f, f * 1.01, t + 0.08 + i * 0.07, 1.1, 0.11, 0.08);
        tone('triangle', f * 2, f * 2, t + 0.08 + i * 0.07, 0.8, 0.035, 0.08);
      });
      noise('bandpass', 600, 2400, t + 0.1, 1.0, 0.16, 0.6, 0.3);
    },
    // 魂火：呼的一声燃起
    soulfire(t) {
      const v = jit(0.05);
      noise('bandpass', 500 * v, 1800 * v, t, 0.4, 0.36, 0.8, 0.03);
      tone('sine', 180 * v, 320 * v, t, 0.3, 0.16, 0.02);
      crackle(t + 0.1, 0.25, 3, 2400, 0.06);
    },
    // 打造：铁砧上的「叮」
    craft(t) {
      tick(t, 4000, 0.12);
      fm(1320, 1.41, 1.6, t, 0.32, 0.16, 0.001, 1310);
      fm(1980, 2, 0.6, t + 0.03, 0.36, 0.08, 0.002);
      noise('highpass', 6000, 7000, t + 0.02, 0.2, 0.04, 0.7, 0.03);
    },
    roll(t) {
      const v = jit(0.06);
      noise('bandpass', 1400 * v, 320, t, 0.22, 0.36, 1.0, 0.03);
      noise('lowpass', 400, 150, t + 0.12, 0.1, 0.18, 0.8, 0.004); // 落地
    },
    // 濒死心跳：咚-咚
    heart(t) {
      tone('sine', 82, 44, t, 0.16, 0.8, 0.008);
      tone('sine', 70, 40, t + 0.21, 0.2, 0.62, 0.008);
      noise('lowpass', 160, 60, t, 0.1, 0.28, 0.7, 0.005);
    },
    // 技能放不出来：短的「嗯嗯」，闷，不刺耳
    deny(t) {
      tone('triangle', 230, 170, t, 0.08, 0.22, 0.004);
      tone('square', 150, 110, t, 0.08, 0.05, 0.004, 700);
      tone('triangle', 190, 140, t + 0.09, 0.1, 0.2, 0.004);
      tone('square', 125, 95, t + 0.09, 0.1, 0.045, 0.004, 700);
    },
    // 冷却结束：轻轻两声
    ready(t) {
      fm(1180, 2, 0.5, t, 0.1, 0.09, 0.003);
      fm(1770, 2, 0.4, t + 0.045, 0.18, 0.08, 0.003);
    },
    // 放下 / 丢下物品
    drop(t) {
      noise('lowpass', 900, 220, t, 0.09, 0.36, 0.8, 0.004);
      tone('sine', 190, 110, t, 0.1, 0.2, 0.004);
    },
    // ---- 打击感 ----
    // 挥砍的破空声：三段一段比一段沉，终结技拖得更长
    swing(t, p) {
      const s = p.step || 0;
      const v = jit(0.08);
      if (s < 2) trim(1.7);
      if (s >= 2) {
        noise('bandpass', 380 * v, 2400 * v, t, 0.27, 0.38, 1.1, 0.13);
        noise('bandpass', 2200, 3200, t + 0.08, 0.14, 0.04, 1.2, 0.06);
        tone('sine', 150 * v, 70, t + 0.12, 0.16, 0.2);
      } else {
        noise('bandpass', (950 - s * 200) * v, (2700 - s * 500) * v, t, 0.13, 0.28, 1.3, 0.03);
        noise('bandpass', 2400 * v, 3200 * v, t + 0.03, 0.07, 0.03, 1.2, 0.03);
      }
    },
    // 命中：起音的「咔」+ 一层闷响打底 + 随伤害类型变化的音色；分量越重越低沉、越长，每次音高略有浮动
    impact(t, p) {
      const w = Math.max(0, Math.min(2, p.w || 0));
      const v = jit(0.08);
      const ty = TYPE_LAYER[p.type] ? p.type : 'phys';
      if (w) trim(1 + w * 0.25); // 重一档整体再响一点（重 ≈ 轻 + 5 LU）
      tick(t, 2600 * v, 0.6 + w * 0.08 + (p.crit ? 0.15 : 0));
      tone('sine', 900 * v, 300, t, 0.022, 0.42 + w * 0.06, 0.0004); // 「哒」的一下：很短的中频敲击，让起音更利
      tone('sine', (155 - w * 18) * v, 52 - w * 4, t + 0.002, 0.08 + w * 0.05, 0.55 + w * 0.12, 0.0015);
      noise('lowpass', 1700 * v, 280, t, 0.06 + w * 0.03, 0.4 + w * 0.06, 0.8, 0.0015);
      // 重：中低频的一记闷响（K 计权听得见的频段），而不是拖长的超低频
      if (w >= 1) noise('lowpass', 650 * v, 180, t + 0.004, 0.09 + w * 0.03, 0.62 + w * 0.12, 1.0, 0.002);
      TYPE_LAYER[ty](t, v, w);
      const ik = p.id && IMPACT_MAP[p.id];
      if (ik) IMPACT_ID[ik](t, v);
      if (w >= 2) {
        tone('sine', 92 * v, 38, t, 0.22, 0.4, 0.003);
        noise('lowpass', 520, 120, t + 0.01, 0.14, 0.28, 0.8, 0.004);
      }
      if (p.crit) {
        // 暴击：一声亮的「叮」压在上面
        fm(1320 * v, 2, 1.1, t + 0.008, 0.22, 0.13, 0.001, 1240 * v);
        fm(2640 * v, 2, 0.4, t + 0.012, 0.12, 0.04, 0.001);
      }
    },
    // 终结技砸中：低频轰一下，碎石落地
    finisher(t) {
      const v = jit(0.04);
      tick(t, 2200, 0.3, 0.015);
      tone('sine', 92 * v, 36, t, 0.34, 0.9, 0.003);
      tone('square', 150 * v, 48, t, 0.2, 0.12, 0.003, 900);
      noise('lowpass', 2600, 180, t, 0.27, 0.62, 0.8, 0.003);
      crackle(t + 0.08, 0.25, 5, 1500, 0.14);
      noise('highpass', 2800, 5200, t + 0.1, 0.2, 0.08, 0.7, 0.03);
    },
    // 架势被打空：一声碎裂 + 钟鸣
    break(t) {
      tick(t, 3000, 0.25);
      tone('triangle', 1560, 310, t, 0.26, 0.28, 0.003);
      noise('highpass', 6500, 2000, t, 0.28, 0.22, 0.8, 0.003);
      crackle(t + 0.02, 0.15, 4, 4500, 0.1);
      tone('sine', 74, 40, t, 0.45, 0.65, 0.006);
      fm(660, 2, 0.8, t + 0.03, 0.7, 0.16, 0.01, 655);
      fm(990, 2, 0.5, t + 0.03, 0.5, 0.06, 0.01, 985);
    },
    // 处决起手：空气被吸进去
    execstart(t) {
      noise('bandpass', 300, 3200, t, 0.3, 0.32, 1.2, 0.24);
      tone('sine', 220, 520, t, 0.28, 0.1, 0.2);
      noise('highpass', 4000, 7000, t + 0.1, 0.2, 0.04, 0.7, 0.15);
    },
    // 处决命中：利刃 + 重击 + 余音
    execute(t) {
      tick(t, 3500, 0.35, 0.012);
      noise('bandpass', 4200, 600, t, 0.13, 0.45, 1.4, 0.002);
      tone('sine', 104, 30, t + 0.015, 0.5, 0.95, 0.003);
      tone('sawtooth', 220, 52, t + 0.015, 0.3, 0.22, 0.003, 1200);
      noise('lowpass', 2400, 120, t + 0.015, 0.38, 0.55, 0.8, 0.003);
      fm(880, 2, 0.6, t + 0.16, 0.6, 0.13, 0.01);
      fm(1320, 2, 0.5, t + 0.22, 0.7, 0.1, 0.01);
    },
    // 敌人倒下：一声闷破；按致命伤害的类型收尾，精英 / 首领更沉
    kill(t, p) {
      const big = !!p.big;
      const v = (big ? 0.72 : 1) * jit(0.08);
      const ty = p.type || 'phys';
      tick(t, 2000 * v, 0.18);
      tone('triangle', 280 * v, 62 * v, t, big ? 0.26 : 0.15, 0.24, 0.002);
      noise('lowpass', 1600 * v, 200, t, big ? 0.3 : 0.16, 0.36, 0.8, 0.003);
      if (ty === 'fire') {
        noise('bandpass', 600, 2300, t + 0.03, 0.28, 0.2, 0.9, 0.05);
        crackle(t + 0.08, 0.25, 4, 2500, 0.08);
      } else if (ty === 'cold') {
        crackle(t + 0.01, 0.12, 5, 5800, 0.12);
        fm(2800 * v, 2.76, 1.2, t + 0.02, 0.2, 0.08, 0.001);
      } else if (ty === 'light') {
        tone('square', 2200 * v, 170, t + 0.01, 0.13, 0.05, 0.002, 4500);
        crackle(t + 0.02, 0.1, 3, 3600, 0.1);
      } else if (ty === 'chaos') {
        tone('sine', 420 * v, 62, t + 0.02, 0.26, 0.2, 0.01);
        noise('bandpass', 2000 * v, 300, t, 0.22, 0.16, 1.3, 0.08);
      } else {
        noise('bandpass', 480, 190, t + 0.03, 0.2, 0.3, 0.9, 0.015);
        tone('square', 120 * v, 60, t + 0.02, 0.1, 0.06, 0.003, 700);
      }
      if (big) {
        tone('sine', 70, 32, t, 0.36, 0.26, 0.004);
        noise('lowpass', 700, 140, t + 0.05, 0.3, 0.14, 0.8, 0.02);
      }
    },
  };

  // 同名音效限流（毫秒）：避免同帧叠成一声巨响
  const MIN_GAP = { round: 40, lamp: 50, shot: 40, hit: 55, crit: 70, cast: 60, hurt: 120, pickup: 60, click: 30, roll: 100, heart: 300, deny: 160, ready: 120, drop: 80, impact: 40, swing: 70, finisher: 150, ashcuts: 300, tristorm: 300, soulhost: 300, break: 200, execute: 200, execstart: 200, kill: 70 };
  const NO_P = {};

  // 排一次音效：nowMs 限流用的时钟，t 开始时间（AudioContext 时间）
  function play(name, p, nowMs, t, noThrottle) {
    const fn = SFX[name];
    if (!fn) return false;
    p = p || NO_P;
    if (!noThrottle) {
      // 敌人施法单独限流：一群敌人连着施法时不能把自己的施法声挡掉
      const key = p.foe ? name + (p.foe >= 2 ? ':cue' : ':foe') : name; // 首领 / 精英的预警施法也不被小怪的挡掉
      if (nowMs - (gr.lastPlay[key] === undefined ? -1e9 : gr.lastPlay[key]) < (MIN_GAP[name] || 45)) {
        gr.throttled++;
        return false;
      }
      gr.lastPlay[key] = nowMs;
    }
    const m = META[name] || ['sfx', 2, 0];
    let prio = m[1];
    if (name === 'cast' && p.foe) prio = p.foe >= 2 ? 2 : 1; // 精英 / 首领的施法是躲闪提示：和自己的命中同级
    else if (name === 'impact' && (p.crit || p.w >= 2)) prio = 3;
    else if (name === 'kill' && p.big) prio = 4;
    const pan = m[0] === 'sfx' ? (rand() - 0.5) * 0.24 : 0;
    if (!voiceBegin(t, name, m[0], prio, m[2], pan)) {
      gr.dropped++; // 正在响的都比它重要，这一声让掉
      return false;
    }
    if (m[3]) trim(m[3]);
    try {
      fn(t, p);
    } catch (e) {
      /* 静默 */
    }
    voiceEnd();
    return true;
  }

  const stats = { calls: 0, played: 0, ms: 0, maxMs: 0 };
  // p（可选）：给音效的参数（命中的伤害类型 / 分量 / 是否暴击，挥砍的段数，施法的技能……）
  G.sfx = function (name, p) {
    if (!live || live.ac.state !== 'running' || live.silent || gr !== live) return;
    const t0 = performance.now();
    stats.calls++;
    if (play(name, p, t0, live.ac.currentTime + 0.004)) stats.played++;
    const d = performance.now() - t0;
    stats.ms += d;
    if (d > stats.maxMs) stats.maxMs = d;
  };

  function liveVoices() {
    if (!live) return 0;
    const t = live.ac.currentTime;
    let n = 0;
    for (const v of live.voices) if (v.end > t) n++;
    return n;
  }

  G.audio = {
    DEFAULTS,
    MAX_VOICES,
    CEIL,
    init: audioInit,
    ctx: () => (live ? live.ac : null),
    // 在用户手势里建 / 唤醒 AudioContext（同首次按键、点击）。iOS 只认 touchend，触屏模式（js/touch.js）在 touchend 里调它
    unlock: () => audioInit(),
    running: () => !!live && live.ac.state === 'running',
    bus: (name) => (live && live.bus[name]) || null,
    reverb: () => (live ? live.rvIn : null),
    noise: () => (live ? live.noise : null),
    rng: (seed) => mkRng(seed),
    vol,
    names: () => Object.keys(SFX),
    onStart(cb) {
      if (live) cb(live.ac);
      else starters.push(cb);
    },
    apply() {
      if (live) applyTo(live, G.save && G.save.opts, live.ac.currentTime);
      if (G.music) G.music.refresh(); // 音乐 / 环境音：静音或音量为 0 时整个停掉（js/score.js）
    },
    voices: liveVoices,
    levels: () => levelsOf(G.save && G.save.opts),
    stats(reset) {
      const r = {
        calls: stats.calls, played: stats.played, ms: +stats.ms.toFixed(3), maxMs: +stats.maxMs.toFixed(3),
        voices: liveVoices(), peakVoices: live ? live.peakVoices : 0, stolen: live ? live.stolen : 0, dropped: live ? live.dropped : 0, throttled: live ? live.throttled : 0,
      };
      if (reset) {
        stats.calls = stats.played = stats.ms = stats.maxMs = 0;
        if (live) live.peakVoices = live.stolen = live.dropped = live.throttled = 0;
      }
      return r;
    },
    // 离线渲染：同一套链路和配方，按 events 的时间排（限流的时钟也按事件时间走）。不碰实时那一套的状态和随机序列
    render(events, dur, o) {
      o = o || {};
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OAC) return Promise.reject(new Error('no OfflineAudioContext'));
      const sr = o.sr || 48000;
      const oc = new OAC(2, Math.ceil(dur * sr), sr);
      const keep = { ac, gr, rand, V };
      const R = mkRng(o.seed === undefined ? 12345 : o.seed);
      rand = R;
      const g = buildGraph(oc, R);
      applyTo(g, o.opts || DEFAULTS, null);
      ac = oc;
      gr = g;
      const timeline = [];
      let played = 0;
      try {
        const evs = events.slice().sort((a, b) => a.t - b.t);
        for (const e of evs) {
          const ok = play(e.name, e.p, e.t * 1000, e.t + 0.004, !!o.noThrottle);
          if (ok) played++;
          // 每个事件之后记一次：时间、此刻在响的声部数、这一声放没放（给混剪的统计用）
          let n = 0;
          for (const v of g.voices) if (v.end > e.t) n++;
          timeline.push([+e.t.toFixed(3), n, ok ? 1 : 0]);
        }
      } finally {
        ac = keep.ac;
        gr = keep.gr;
        rand = keep.rand;
        V = keep.V;
      }
      // o.attach(oc, { bus, reverb })：渲染前把别的声源接到同一套总线上（音乐 / 环境音按游戏内电平一起渲染，见 tools/score）
      if (o.attach) o.attach(oc, { bus: g.bus, reverb: g.rvIn });
      return oc.startRendering().then((buf) => {
        let peak = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < d.length; i++) {
            const a = d[i] < 0 ? -d[i] : d[i];
            if (a > peak) peak = a;
          }
        }
        return { buf, peak, stats: { events: events.length, played, stolen: g.stolen, victims: g.victims, dropped: g.dropped, throttled: g.throttled, peakVoices: g.peakVoices, timeline } };
      });
    },
  };
})();
