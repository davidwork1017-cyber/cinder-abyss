// 开场故事：新角色第一次进游戏时放一遍的动态漫画（约 70 秒），标题画面的「开场故事」可以重看。
// 只在要放的时候才由 ui.js 插进页面（G.ui.playStory），平常进游戏、?play、测试的 window.__skipTitle 都不会加载这个文件和它的图。
// 画格是用游戏自己的引擎摆拍、加墨线 / 网点后烘成的分层图（tools/story/bake.mjs → assets/story/<格>/<层>.webp），
// 这里只做 2D 的播放：各层视差、镜头慢推、飘起来的余烬和灰（2D 画布）、字幕。不碰 WebGL，放的时候游戏画面停止渲染。
(function () {
  'use strict';
  const ROOT = 'assets/story/';
  // ---------- 画格 ----------
  // cap：字幕（每格 1–3 行）；at：字幕框位置 tl / tr / bl / br；layers：[层名, 视差深度 0..1]（从后往前）；
  // push：镜头推近的起止缩放；drift：视差漂移的方向（-1..1，按画面宽高的 1.2%）；
  // fx：2D 粒子，一个或一组 { kind: rise 余烬上飘 / fall 落灰 / smoke 烟和灰团, n 数量, area [x0, x1, y0, y1] 出生范围（比例） }；
  // glow：火光的呼吸 { x, y, r 半径, a 强度, core 带一粒亮芯, d 跟着哪个深度的层动, ramp 几秒内亮起来 }（按画格宽高的比例）；
  // shake：进格时的一下震动（秒）；
  // frames（多格的一页）：[x, y, w, h]（占整页的比例）+ 各自的层；sfx：这一格开头的音效（G.sfx 的名字）
  const PANELS = [
    {
      id: 'p1', at: 'tl', cap: ['地底下有道裂口，叫烬渊。', '有一天，灰烬从里面涌了出来。'],
      layers: [['bg', 0.15], ['bg-near', 0.7]], push: [1.0, 1.08], drift: [0, -1], sfx: 'boss',
      fx: [{ kind: 'rise', n: 70 }, { kind: 'smoke', n: 12, area: [0.3, 0.7, 0.45, 1.0] }],
      glow: [{ x: 0.5, y: 1.02, r: 0.5, a: 0.26 }, { x: 0.55, y: 0.55, r: 0.22, a: 0.12 }],
    },
    {
      // 一页三格：上面一整条灰烬荒原，下面左霜骨沼泽、右雷鸣遗迹（右下这格隔一会儿打一道雷）
      id: 'p2', at: 'tl', cap: ['灰落到哪儿，哪儿就烧光。', '荒原、沼泽、老遗迹，人都死在了灰里。'],
      frames: [
        { id: 'p2a', rect: [0, 0, 1, 0.34], layers: [['bg', 0.2], ['bg-near', 0.6]] },
        { id: 'p2b', rect: [0, 0.34, 0.5, 0.66], layers: [['bg', 0.2], ['bg-near', 0.6]] },
        { id: 'p2c', rect: [0.5, 0.34, 0.5, 0.66], layers: [['bg', 0.2], ['bg-near', 0.45], ['actors', 0.7]] },
      ],
      push: [1.0, 1.04], drift: [1, 0],
      fx: [{ kind: 'fall', n: 70 }, { kind: 'bolt', area: [0.6, 0.88, 0.36, 0.8], from: 2 }],
    },
    {
      id: 'p3', at: 'bl', cap: ['人死了，心里那点火也就灭了。', '魂没处去，成了游魂，见着活物就扑。'],
      layers: [['bg', 0.2], ['actors', 0.65]], push: [1.02, 1.08], drift: [1, 0], fx: { kind: 'fall', n: 40 },
    },
    {
      // 刚灭的火盆冒着烟（烘焙时记下的位置：panels.mjs p4 的 points.smoke）
      id: 'p4', at: 'tr', cap: ['还有个东西专找剩下的火，一盏盏掐灭。', '它叫熄烛者。'],
      layers: [['bg', 0.15], ['actors', 0.6]], push: [1.0, 1.07], drift: [-1, 0],
      fx: [{ kind: 'smoke', n: 14, area: [0.54, 0.62, 0.6, 0.7] }, { kind: 'fall', n: 24 }],
      glow: [{ x: 0.578, y: 0.69, r: 0.05, a: 0.18, d: 0.15 }],
    },
    {
      id: 'p5', at: 'bl', cap: ['你也死在了灰里，可心口的火它没掐着。', '余烬未冷。'],
      layers: [['bg', 0.1], ['actors', 0.5]], push: [1.04, 1.12], drift: [0, 1],
      // 掌心的余烬（panels.mjs p5 的 points.ember）
      fx: [{ kind: 'rise', n: 18, area: [0.37, 0.42, 0.27, 0.31] }, { kind: 'rise', n: 16 }],
      glow: [{ x: 0.3953, y: 0.3015, r: 0.12, a: 0.4, core: 1, d: 0.5, ramp: 1.2 }],
    },
    {
      // 掌心的余烬（panels.mjs p6 的 points.ember）一点点亮起来，火星从手上和身边往上飘
      id: 'p6', at: 'tl', cap: ['火还在，所以你没变成游魂。', '只要它不灭，倒下多少次都能重燃。'],
      layers: [['bg', 0.15], ['actors', 0.7]], push: [1.0, 1.07], drift: [0, -0.6], sfx: 'cast',
      fx: [{ kind: 'rise', n: 40, area: [0.3, 0.72, 0.62, 0.98] }, { kind: 'rise', n: 16, area: [0.47, 0.515, 0.33, 0.37] }],
      glow: [{ x: 0.4912, y: 0.355, r: 0.09, a: 0.42, core: 1, d: 0.7, ramp: 1.6 }, { x: 0.5, y: 0.82, r: 0.3, a: 0.12, d: 0.7 }],
    },
    {
      // 一页四格：上面三个首领，下面一整条：拿着烬铸武器的主角对着烬渊之主
      id: 'p7', at: 'br', cap: ['灰里的火，聚到了最凶的东西身上。', '它们各守一方，一个比一个难缠。', '打倒它们，把它们攒的火铸成你的兵器。'],
      frames: [
        { id: 'p7a', rect: [0, 0, 0.334, 0.5], layers: [['bg', 0.2], ['actors', 0.6]] },
        { id: 'p7b', rect: [0.333, 0, 0.334, 0.5], layers: [['bg', 0.2], ['actors', 0.6]] },
        { id: 'p7c', rect: [0.666, 0, 0.334, 0.5], layers: [['bg', 0.2], ['actors', 0.6]] },
        { id: 'p7d', rect: [0, 0.5, 1, 0.5], layers: [['bg', 0.2], ['actors', 0.6]] },
      ],
      push: [1.0, 1.04], drift: [1, 0], sfx: 'unique',
      fx: { kind: 'rise', n: 30, area: [0.02, 0.98, 0.55, 0.99] },
      glow: [{ x: 0.399, y: 0.8331, r: 0.06, a: 0.3, core: 1, d: 0.6, f: 3, ramp: 2.5 }],
    },
    {
      // 最后一格是游戏自己的开局镜头：推到 1:1 时和真正的游戏画面对上，然后淡出进游戏
      id: 'p8', at: 'tl', cap: ['先从灰烬荒原走起。', '一路下到烬渊，看看灰是从哪儿来的。'],
      layers: [['bg', 0.12], ['actors', 0.4]], push: [1.1, 1.0], drift: [0, 0], fx: { kind: 'fall', n: 40 }, last: true,
    },
  ];

  // ---------- 时间 ----------
  const TRANS = 0.7; // 换格
  const CAP_IN = 0.45, LINE_GAP = 0.55; // 第一行字幕出现的时间、第二行晚多少
  const hanzi = (s) => (s.match(/[㐀-鿿]/g) || []).length;
  // 每格停留：2.6 秒（看画）+ 每个字 0.22 秒，至少 5 秒；一页多格的再多 2 秒（子格一格格弹出来）；加上字幕淡入的时间
  function holdOf(p) {
    const n = p.cap.reduce((a, s) => a + hanzi(s), 0);
    return Math.max(5, 2.6 + 0.22 * n) + (p.frames ? 2 : 0) + CAP_IN + LINE_GAP * (p.cap.length - 1);
  }
  let T0 = 0;
  for (const p of PANELS) {
    p.t0 = T0;
    p.dur = holdOf(p) + TRANS;
    T0 += p.dur;
  }
  const TOTAL = T0;
  const END_FADE = 1.0;

  // ---------- 状态 ----------
  const st = {
    on: false, t: 0, last: 0, raf: 0, done: null, el: null, stage: null, fx: null, fxc: null, caps: [], panels: [],
    hold: null, holdEl: null, cur: -1, wait: false, reduce: false, low: false, parts: [], seed: 1, ended: false, endT: -1, opts: null,
  };
  const img = {}; // url → { el, ok, p }
  function urlOf(id, layer) {
    return ROOT + id + '/' + layer + '.webp';
  }
  function load(url) {
    if (img[url]) return img[url].p;
    const el = new Image();
    el.decoding = 'async';
    const rec = { el, ok: false, bad: false, p: null };
    rec.p = new Promise((res) => {
      el.onload = () => {
        rec.ok = true;
        (el.decode ? el.decode().catch(() => {}) : Promise.resolve()).then(res);
      };
      el.onerror = () => {
        rec.bad = true; // 缺一张图不卡住：这一层留空，照常往下放
        res();
      };
    });
    el.src = url;
    img[url] = rec;
    return rec.p;
  }
  function panelUrls(p) {
    const out = [];
    for (const f of p.frames || [p]) for (const L of f.layers) out.push(urlOf(f.id, L[0]));
    return out;
  }
  const preload = (i) => (PANELS[i] ? Promise.all(panelUrls(PANELS[i]).map(load)) : Promise.resolve());
  const ready = (i) => !PANELS[i] || panelUrls(PANELS[i]).every((u) => img[u] && (img[u].ok || img[u].bad));

  // ---------- DOM ----------
  function h(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function build() {
    const root = document.getElementById('story') || h('div', '', document.body);
    root.id = 'story';
    root.innerHTML = '';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '开场故事');
    const stage = h('div', 'st-stage', root);
    st.panels = PANELS.map((p) => {
      const pe = h('div', 'st-panel', stage);
      const frames = (p.frames || [{ id: p.id, rect: [0, 0, 1, 1], layers: p.layers }]).map((f) => {
        const fe = h('div', 'st-frame', pe);
        const r = f.rect;
        fe.style.left = r[0] * 100 + '%';
        fe.style.top = r[1] * 100 + '%';
        fe.style.width = r[2] * 100 + '%';
        fe.style.height = r[3] * 100 + '%';
        const inner = h('div', 'st-inner', fe);
        const layers = f.layers.map((L) => {
          const le = h('img', 'st-layer', inner);
          le.alt = '';
          le.draggable = false;
          le.dataset.src = urlOf(f.id, L[0]);
          return { el: le, d: L[1] };
        });
        return { el: fe, inner, layers };
      });
      return { el: pe, frames };
    });
    const fx = h('canvas', 'st-fx', stage);
    const cap = h('div', 'st-cap', root);
    const skip = h('button', 'st-skip', root);
    skip.type = 'button';
    skip.tabIndex = -1;
    skip.innerHTML = '跳过<kbd>Esc</kbd>';
    const hint = h('div', 'st-hint', root);
    hint.textContent = '点击继续 · 按住跳过';
    const holdEl = h('div', 'st-holdring', root);
    holdEl.innerHTML = '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16"/><circle class="st-hr" cx="20" cy="20" r="16"/></svg>';
    st.el = root;
    st.stage = stage;
    st.fx = fx;
    st.fxc = fx.getContext('2d');
    st.capEl = cap;
    st.skipEl = skip;
    st.holdEl = holdEl;
    skip.addEventListener('click', (e) => {
      e.stopPropagation();
      finish('skip');
    });
    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointerup', onUp);
    root.addEventListener('pointercancel', onCancel);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', swallow, true);
    window.addEventListener('resize', layout);
    layout();
  }
  // 舞台：16:10，整个塞进窗口（四周留黑边）；竖屏手机字幕挪到画面下面
  function layout() {
    if (!st.el) return;
    const vw = G.viewW ? G.viewW() : window.innerWidth, vh = G.viewH ? G.viewH() : window.innerHeight; // 旋转横屏时按转过的画面算
    const tall = vw / vh < 1.2;
    const capH = tall ? Math.min(160, vh * 0.24) : 0;
    let w = vw, hh = vw / 1.6;
    if (hh > vh - capH) {
      hh = vh - capH;
      w = hh * 1.6;
    }
    const s = st.stage.style;
    s.width = Math.round(w) + 'px';
    s.height = Math.round(hh) + 'px';
    s.left = Math.round((vw - w) / 2) + 'px';
    s.top = Math.round(tall ? Math.max(0, (vh - capH - hh) / 2) : (vh - hh) / 2) + 'px';
    st.el.classList.toggle('tall', tall);
    // 字幕框：横屏压在画面上（跟着舞台定位），竖屏放到画面下面
    const host = tall ? st.el : st.stage;
    if (st.capEl.parentNode !== host) host.appendChild(st.capEl);
    st.el.style.setProperty('--st-w', Math.round(w) + 'px');
    st.capEl.style.setProperty('--st-top', Math.round(tall ? (vh - capH - hh) / 2 + hh + 12 : 0) + 'px');
    st.stageBox = { x: (vw - w) / 2, y: parseFloat(s.top), w, h: hh };
    const dpr = Math.min(window.devicePixelRatio || 1, st.low ? 1 : 1.5);
    st.fx.width = Math.round(w * dpr);
    st.fx.height = Math.round(hh * dpr);
    st.fxDpr = dpr;
  }

  // ---------- 输入 ----------
  const HOLD_MS = 600, TAP_MS = 280;
  function onDown(e) {
    if (e.target === st.skipEl || (e.button !== undefined && e.button > 0 && e.pointerType === 'mouse')) return;
    e.preventDefault();
    const p = G.toFrame ? G.toFrame(e.clientX, e.clientY) : { x: e.clientX, y: e.clientY };
    st.hold = { t0: performance.now(), x: p.x, y: p.y, id: e.pointerId };
    const r = st.holdEl.style;
    r.left = p.x + 'px';
    r.top = p.y + 'px';
  }
  function onUp(e) {
    const hd = st.hold;
    st.hold = null;
    st.holdEl.classList.remove('on');
    if (!hd) return;
    if (performance.now() - hd.t0 < TAP_MS) advance();
  }
  function onCancel() {
    st.hold = null;
    st.holdEl.classList.remove('on');
  }
  function swallow(e) {
    if (!st.on) return;
    if (e.ctrlKey || e.metaKey) return; // 浏览器快捷键照常
    e.stopImmediatePropagation();
    e.stopPropagation();
  }
  function onKey(e) {
    if (!st.on) return;
    if (e.ctrlKey || e.metaKey) return;
    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'Escape') finish('skip');
    else if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'ArrowRight') advance();
  }
  // 点一下：字幕还没出全就先出全；出全了就进下一格
  function advance() {
    if (!st.on || st.ended) return;
    const i = idxAt(st.t), p = PANELS[i];
    const capDone = p.t0 + CAP_IN + LINE_GAP * (p.cap.length - 1) + 0.3;
    if (st.t < capDone) st.t = capDone;
    else if (p.last) finish('end');
    else st.t = Math.max(st.t, p.t0 + p.dur - TRANS);
  }

  // ---------- 渲染（t 的纯函数，seek 可以直接跳） ----------
  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  function idxAt(t) {
    for (let i = PANELS.length - 1; i >= 0; i--) if (t >= PANELS[i].t0) return i;
    return 0;
  }
  function render(t) {
    const i = idxAt(t);
    if (i !== st.cur) enter(i);
    for (let k = 0; k < PANELS.length; k++) {
      const p = PANELS[k], pe = st.panels[k];
      const lt = t - p.t0; // 这一格自己的时间
      const show = k === i || (k === i - 1 && t - PANELS[i].t0 < TRANS) || (k === i + 1 && lt > -TRANS && lt < 0);
      // 下一格在这一格的最后 TRANS 秒里从右边推进来（盖住），上一格留在底下变暗
      if (!show) {
        if (pe.vis) {
          pe.el.style.visibility = 'hidden';
          pe.vis = false;
        }
        continue;
      }
      if (!pe.vis) {
        pe.el.style.visibility = 'visible';
        pe.vis = true;
        for (const f of pe.frames) for (const L of f.layers) if (!L.el.src) L.el.src = L.el.dataset.src;
      }
      const inT = ease((lt + TRANS) / TRANS); // 进场 0..1（lt 从 -TRANS 到 0）
      if (lt < 0) {
        pe.el.style.zIndex = 3;
        if (st.reduce) {
          pe.el.style.opacity = inT;
          pe.el.style.clipPath = 'none';
        } else {
          pe.el.style.opacity = 1;
          pe.el.style.clipPath = 'inset(0 0 0 ' + ((1 - inT) * 100).toFixed(2) + '%)';
        }
      } else {
        pe.el.style.zIndex = k === i ? 2 : 1;
        pe.el.style.opacity = 1;
        pe.el.style.clipPath = 'none';
      }
      const pr = Math.max(0, Math.min(1, (lt + TRANS) / (p.dur + TRANS))); // 镜头进度（含进场）
      if (k === i) st.xf = { lt, sc: 0, dx: 0, dy: 0, sx: 0, sy: 0 };
      const pe2 = ease(pr * 0.85 + 0.15 * pr * pr);
      const sc = st.reduce ? 1 : p.push[0] + (p.push[1] - p.push[0]) * pe2;
      const dx = st.reduce ? 0 : p.drift[0] * (pe2 - 0.5), dy = st.reduce ? 0 : p.drift[1] * (pe2 - 0.5);
      // 进格的一下震动（动作格）：衰减的抖动，0.45 秒内停住
      let sx = 0, sy = 0;
      if (p.shake && !st.reduce && lt > 0 && lt < p.shake) {
        const k = 1 - lt / p.shake, a = 0.9 * k * k;
        sx = Math.sin(lt * 71) * a;
        sy = Math.cos(lt * 53) * a * 0.6;
      }
      if (k === i) Object.assign(st.xf, { sc, dx, dy, sx, sy });
      const nF = pe.frames.length;
      for (let fi = 0; fi < nF; fi++) {
        const f = pe.frames[fi];
        // 多格的一页：子格按字幕节奏依次弹出来
        if (nF > 1) {
          const at = (fi / nF) * Math.max(1.6, holdOf(p) * 0.55);
          const a = st.reduce ? (lt >= at ? 1 : 0) : ease((lt - at) / 0.45);
          f.el.style.opacity = lt < 0 && fi === 0 ? 1 : a;
          f.el.style.transform = st.reduce ? 'none' : 'scale(' + (0.965 + 0.035 * a).toFixed(4) + ')';
        }
        for (const L of f.layers) {
          const k2 = 1.2 * L.d; // 视差：%（相对画格）
          const s2 = p.last ? sc : sc * (1 + 0.03 * L.d) + 0.012; // 多放大一点，边缘不露底（最后一格要推到正好 1:1）
          const sk = 0.5 + L.d; // 近的层抖得多
          L.el.style.transform = 'translate(' + (dx * k2 + sx * sk).toFixed(3) + '%,' + (dy * k2 + sy * sk).toFixed(3) + '%) scale(' + s2.toFixed(4) + ')';
        }
      }
    }
    // 字幕
    const p = PANELS[i], lt = t - p.t0;
    const fadeOut = p.last ? 1 : 1 - ease((lt - (p.dur - TRANS)) / (TRANS * 0.6));
    for (let k = 0; k < st.caps.length; k++) {
      const a = ease((lt - CAP_IN - k * LINE_GAP) / 0.35) * fadeOut;
      const c = st.caps[k];
      c.style.opacity = a.toFixed(3);
      c.style.transform = 'translateY(' + ((1 - a) * 6).toFixed(2) + 'px)';
    }
    // 字幕框跟着第一行出现、跟着整格淡出
    const boxA = ease((lt - CAP_IN + 0.1) / 0.3) * fadeOut;
    st.capEl.style.opacity = boxA.toFixed(3);
    st.capEl.style.visibility = boxA > 0.01 ? 'visible' : 'hidden';
  }
  // 进入第 i 格：换字幕、预载后面两格、放音效
  function enter(i) {
    st.cur = i;
    const p = PANELS[i];
    st.capEl.className = 'st-cap at-' + p.at;
    st.capEl.innerHTML = '';
    st.caps = p.cap.map((s) => {
      const e = h('p', '', st.capEl);
      e.textContent = s;
      return e;
    });
    preload(i + 1);
    preload(i + 2);
    if (p.sfx && st.on && !st.opts.silent && typeof G !== 'undefined' && G.sfx) G.sfx(p.sfx);
    st.fxList = (Array.isArray(p.fx) ? p.fx : p.fx ? [p.fx] : []).map((f, k) => Object.assign({ key: f.kind + k + ':' + i }, f));
  }

  // ---------- 2D 粒子：余烬、落灰、烟 ----------
  function rnd() {
    st.seed = (st.seed * 16807) % 2147483647;
    return (st.seed - 1) / 2147483646;
  }
  function spawn(F, w, hh, init) {
    const kind = F.kind, p = { kind, key: F.key, life: 0 };
    if (kind === 'rise') {
      p.x = rnd() * w;
      p.y = init ? rnd() * hh : hh + 10;
      p.vx = (rnd() - 0.5) * 18;
      p.vy = -(22 + rnd() * 46);
      p.r = 0.8 + rnd() * 2.2;
      p.max = 3 + rnd() * 4;
      p.ph = rnd() * 6.28;
    } else if (kind === 'fall') {
      p.x = rnd() * w;
      p.y = init ? rnd() * hh : -10;
      p.vx = 8 + rnd() * 16;
      p.vy = 14 + rnd() * 22;
      p.r = 1 + rnd() * 2.4;
      p.max = 6 + rnd() * 5;
      p.ph = rnd() * 6.28;
    } else {
      p.x = w * (0.35 + rnd() * 0.5);
      p.y = init ? hh * (0.3 + rnd() * 0.6) : hh * (0.55 + rnd() * 0.3);
      p.vx = (rnd() - 0.5) * 10;
      p.vy = -(8 + rnd() * 10);
      p.r = 18 + rnd() * 30;
      p.max = 5 + rnd() * 4;
      p.ph = rnd() * 6.28;
    }
    // area：出生范围（画格宽高的比例）；上飘的从范围底边冒出来，落灰从顶边落下
    if (F.area) {
      const [x0, x1, y0, y1] = F.area;
      p.x = w * (x0 + rnd() * (x1 - x0));
      if (init || kind === 'smoke') p.y = hh * (y0 + rnd() * (y1 - y0));
      else p.y = kind === 'fall' ? hh * y0 : hh * y1;
    }
    if (init) p.life = rnd() * p.max;
    return p;
  }
  function stepFx(dt) {
    const c = st.fxc, cv = st.fx, d = st.fxDpr || 1;
    if (!c) return;
    const w = cv.width / d, hh = cv.height / d;
    c.setTransform(d, 0, 0, d, 0, 0);
    c.clearRect(0, 0, w, hh);
    const list = st.fxList || [];
    const keys = {};
    for (const F of list) {
      keys[F.key] = 1;
      const want = st.reduce ? 0 : Math.round((F.n || 0) * (st.low ? 0.5 : 1) * Math.min(1, w / 1100 + 0.25));
      let alive = 0;
      for (const p of st.parts) if (p.key === F.key) alive++;
      // 刚进这一格：一下铺满（已经在飘的样子）；之后按缺口慢慢补
      if (!F.seeded && want) {
        F.seeded = true;
        for (let k = alive; k < want; k++) st.parts.push(spawn(F, w, hh, true));
      } else if (alive < want && rnd() < dt * want * 0.6) st.parts.push(spawn(F, w, hh, false));
    }
    c.globalCompositeOperation = 'lighter';
    // 画格里火光的呼吸：几团暖色的径向光（glow：[x, y, 半径, 强度]，按画格宽高的比例）
    const P = PANELS[st.cur];
    if (P && P.glow && !st.reduce) {
      st.gT = (st.gT || 0) + dt;
      const xf = st.xf || { lt: 1, sc: 1, dx: 0, dy: 0, sx: 0, sy: 0 };
      for (const G2 of P.glow) {
        // 跟着所在那一层的推近 / 视差走（和 render 里各层的 transform 同一个算法）
        let x = G2.x, y = G2.y;
        if (G2.d !== undefined) {
          const s2 = xf.sc * (1 + 0.03 * G2.d) + 0.012, k2 = 1.2 * G2.d, sk = 0.5 + G2.d;
          x = 0.5 + (x - 0.5) * s2 + (xf.dx * k2 + xf.sx * sk) / 100;
          y = 0.5 + (y - 0.5) * s2 + (xf.dy * k2 + xf.sy * sk) / 100;
        }
        // f：位置是一页里第几格的局部坐标，换到整页
        if (G2.f !== undefined && P.frames) {
          const r = P.frames[G2.f].rect;
          x = r[0] + x * r[2];
          y = r[1] + y * r[3];
        }
        const ramp = G2.ramp ? ease((xf.lt - 0.2) / G2.ramp) : 1;
        const fl = (0.82 + 0.12 * Math.sin(st.gT * 2.3 + G2.x * 9) + 0.06 * Math.sin(st.gT * 7.1 + G2.y * 5)) * ramp;
        const R = G2.r * w, g = c.createRadialGradient(x * w, y * hh, 0, x * w, y * hh, R);
        g.addColorStop(0, 'rgba(255,120,50,' + (G2.a * fl).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,90,30,0)');
        c.fillStyle = g;
        c.fillRect(x * w - R, y * hh - R, 2 * R, 2 * R);
        if (G2.core) {
          // 一粒小亮芯（不是一大块亮斑）
          const r0 = Math.max(2, R * 0.09);
          const g2 = c.createRadialGradient(x * w, y * hh, 0, x * w, y * hh, r0);
          g2.addColorStop(0, 'rgba(255,240,200,' + (0.95 * fl).toFixed(3) + ')');
          g2.addColorStop(0.5, 'rgba(255,170,80,' + (0.6 * fl).toFixed(3) + ')');
          g2.addColorStop(1, 'rgba(255,120,40,0)');
          c.fillStyle = g2;
          c.fillRect(x * w - r0, y * hh - r0, 2 * r0, 2 * r0);
        }
      }
    }
    // 雷：area 里隔 2–3.5 秒劈一道折线（白芯 + 黄边，0.2 秒），区域里淡淡亮一下（不是一整块亮斑）
    for (const F of list) {
      if (F.kind !== 'bolt' || st.reduce) continue;
      const lt0 = st.xf ? st.xf.lt : 0;
      if (F.from && lt0 < F.from) continue;
      F.t = (F.t === undefined ? 0.6 : F.t) - dt;
      if (F.t <= 0 && !F.on) {
        const [x0, x1, y0, y1] = F.area;
        const pts = [];
        let x = w * (x0 + (x1 - x0) * (0.25 + rnd() * 0.5)), y = hh * y0;
        const yEnd = hh * (y0 + (y1 - y0) * (0.5 + rnd() * 0.3));
        pts.push([x, y]);
        while (y < yEnd) {
          y += hh * (0.02 + rnd() * 0.035);
          x += w * (rnd() - 0.5) * 0.03;
          pts.push([x, Math.min(y, yEnd)]);
        }
        F.on = { pts, t: 0.2 };
        F.t = 2 + rnd() * 1.5;
      }
      if (F.on) {
        const [x0, x1, y0, y1] = F.area, a = F.on.t / 0.2;
        c.save();
        c.beginPath();
        c.rect(w * x0, hh * y0, w * (x1 - x0), hh * (y1 - y0));
        c.clip();
        c.fillStyle = 'rgba(200,190,255,' + (0.1 * a).toFixed(3) + ')';
        c.fillRect(w * x0, hh * y0, w * (x1 - x0), hh * (y1 - y0));
        for (const [lw, col] of [[5, 'rgba(255,228,94,' + (0.55 * a).toFixed(3) + ')'], [1.8, 'rgba(255,255,240,' + a.toFixed(3) + ')']]) {
          c.lineWidth = lw;
          c.strokeStyle = col;
          c.lineJoin = 'round';
          c.beginPath();
          F.on.pts.forEach(([px, py], k) => (k ? c.lineTo(px, py) : c.moveTo(px, py)));
          c.stroke();
        }
        c.restore();
        F.on.t -= dt;
        if (F.on.t <= 0) F.on = null;
      }
    }
    const out = [];
    for (const p of st.parts) {
      p.life += dt * (keys[p.key] ? 1 : 3); // 上一格留下的：加速消失
      if (p.life >= p.max) continue;
      p.x += (p.vx + Math.sin(p.life * 1.7 + p.ph) * 9) * dt;
      p.y += p.vy * dt;
      if (p.y < -40 || p.y > hh + 40) continue;
      out.push(p);
      const a = Math.min(1, p.life / 0.6, (p.max - p.life) / 1.2);
      if (p.kind === 'rise') {
        const fl = 0.75 + 0.25 * Math.sin(p.life * 9 + p.ph);
        c.fillStyle = 'rgba(255,' + Math.round(120 + 70 * fl) + ',60,' + (0.85 * a * fl).toFixed(3) + ')';
        c.beginPath();
        c.arc(p.x, p.y, p.r, 0, 6.2832);
        c.fill();
        if (!st.low) {
          c.fillStyle = 'rgba(255,110,40,' + (0.16 * a).toFixed(3) + ')';
          c.beginPath();
          c.arc(p.x, p.y, p.r * 3.2, 0, 6.2832);
          c.fill();
        }
      }
    }
    c.globalCompositeOperation = 'source-over';
    for (const p of out) {
      const a = Math.min(1, p.life / 0.8, (p.max - p.life) / 1.5);
      if (p.kind === 'fall') {
        c.fillStyle = 'rgba(176,164,160,' + (0.5 * a).toFixed(3) + ')';
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.life * 1.3 + p.ph);
        c.fillRect(-p.r, -p.r * 0.45, p.r * 2, p.r * 0.9);
        c.restore();
      } else if (p.kind === 'smoke') {
        const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, 'rgba(112,100,112,' + (0.15 * a).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(112,100,112,0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(p.x, p.y, p.r, 0, 6.2832);
        c.fill();
        p.r += dt * 6;
      }
    }
    st.parts = out;
  }

  // ---------- 主循环 ----------
  function loop(now) {
    if (!st.on) return;
    st.raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, Math.max(0, (now - st.last) / 1000));
    st.last = now;
    if (st.hold) {
      const k = (now - st.hold.t0) / HOLD_MS;
      if (k > 0.25) st.holdEl.classList.add('on');
      st.holdEl.style.setProperty('--k', Math.min(1, k).toFixed(3));
      if (k >= 1) {
        st.hold = null;
        finish('skip');
        return;
      }
    }
    if (st.ended) {
      const k = (now - st.endT) / (END_FADE * 1000);
      st.el.style.opacity = Math.max(0, 1 - k).toFixed(3);
      if (k >= 1) teardown();
      return;
    }
    if (!st.paused) {
      // 下一格的图还没到：停在这一格的末尾等（字幕留着），不切到一张空格
      const i = idxAt(st.t), p = PANELS[i];
      const edge = p.t0 + p.dur - TRANS;
      const nt = st.t + dt;
      if (nt >= edge && !ready(i + 1)) st.t = Math.max(st.t, Math.min(nt, edge - 0.001));
      else st.t = nt;
      if (st.t >= TOTAL) {
        st.t = TOTAL;
        finish('end');
      }
    }
    render(st.t);
    stepFx(dt);
  }

  // reason：'end' 放完 / 'skip' 跳过。最后一格放完是淡出到游戏画面
  function finish(reason) {
    if (!st.on || st.ended) return;
    st.ended = true;
    st.reason = reason;
    st.endT = performance.now();
    st.el.classList.add('ending');
    if (st.opts && st.opts.onEnd) st.opts.onEnd(reason);
  }
  function teardown() {
    st.on = false;
    cancelAnimationFrame(st.raf);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', swallow, true);
    window.removeEventListener('resize', layout);
    if (st.el) {
      st.el.classList.remove('on', 'ending');
      st.el.style.opacity = '';
      st.el.innerHTML = '';
    }
    st.parts = [];
    const d = st.done;
    st.done = null;
    if (d) d(st.reason || 'end');
  }

  // opts：{ from: 第几格开始（0 起）, silent: 不放音效, paused: 只摆画面不走时间（测试 / 截图用） }
  function play(opts) {
    if (st.on) return Promise.resolve('busy');
    opts = opts || {};
    st.opts = opts;
    st.reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    st.low = !!(typeof G !== 'undefined' && G.world && G.world.quality && G.world.quality() === 'low');
    st.seed = 7;
    st.parts = [];
    st.cur = -1;
    st.ended = false;
    st.reason = null;
    st.paused = !!opts.paused;
    const from = Math.max(0, Math.min(PANELS.length - 1, opts.from | 0));
    st.t = PANELS[from].t0;
    build();
    st.el.classList.add('on');
    st.on = true;
    return new Promise((res) => {
      st.done = res;
      // 先等当前这一格的图（最多 4 秒；网络很慢时也不让人对着黑屏一直等）
      const first = preload(from);
      preload(from + 1);
      const go = () => {
        if (!st.on) return;
        st.el.classList.add('ready');
        st.last = performance.now();
        render(st.t);
        st.raf = requestAnimationFrame(loop);
      };
      Promise.race([first, new Promise((r) => setTimeout(r, 4000))]).then(go);
    });
  }

  G.story = {
    play,
    skip: () => finish('skip'),
    // 测试 / 截图：跳到 t 秒（画面立即按 t 摆好）
    seek(t) {
      st.t = Math.max(0, Math.min(TOTAL, +t || 0));
      if (st.on) {
        render(st.t);
        stepFx(0);
      }
      return st.t;
    },
    pause(on) {
      st.paused = on === undefined ? true : !!on;
      return st.paused;
    },
    // 走粒子若干步（截图前让火星铺开；paused 时主循环不推进时间，粒子照常）
    stepFx(n, dt) {
      for (let k = 0; k < (n || 1); k++) stepFx(dt || 1 / 60);
    },
    active: () => st.on,
    // 画面完全盖住游戏的时候（主循环据此不渲染 3D）；收尾淡出时游戏画面要先画出来
    opaque: () => st.on && !st.ended,
    info: () => ({ on: st.on, t: st.t, total: TOTAL, idx: idxAt(st.t), ended: st.ended, reduce: st.reduce, low: st.low, panels: PANELS.map((p) => ({ id: p.id, t0: p.t0, dur: p.dur, cap: p.cap.slice() })) }),
    urls: () => PANELS.map(panelUrls),
    loaded: () => Object.keys(img).filter((u) => img[u].ok),
    failed: () => Object.keys(img).filter((u) => img[u].bad),
    total: TOTAL,
  };
})();
