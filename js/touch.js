'use strict';
// 触屏操作（mobile-design M1）：浮动摇杆、右下按钮簇、自动瞄准 / 拖动瞄准、F 情境键、顶栏、竖屏遮罩、首次提示卡。
// 只写键鼠本来就写的那几个字段（input.keys / input.mouse.b / G.press / G.pressSlot / input.aim），不碰模拟。
// 触屏模式关着时什么都不做：不建 DOM、不挂触摸监听，只留一个 matchMedia 的 change 监听（换了主指针再判断一次）。
(function () {
  const G = window.G;
  const W = G.world;
  const input = G.input;

  // 设备级的设置（不进存档：触屏是这台设备的属性，换角色也不变）。隐私模式下存储可能抛错，读写都包着
  const MODE_KEY = 'cinder-abyss-touch'; // 'auto' | 'on' | 'off'，没有 = auto
  const HINT_KEY = 'cinder-abyss-touch-hint'; // 首次提示卡看过了
  const lsGet = (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      if (v === null) window.localStorage.removeItem(k);
      else window.localStorage.setItem(k, v);
      return true;
    } catch (e) {
      return false;
    }
  };
  let mq = null;
  try {
    mq = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
  } catch (e) {
    mq = null;
  }
  const readMode = () => {
    const m = lsGet(MODE_KEY);
    return m === 'on' || m === 'off' ? m : 'auto';
  };
  // 自动：主指针是 coarse 而且有触点（maxTouchPoints，读不到时看有没有触摸事件）。带触屏的笔记本主指针是 fine，照旧桌面模式；
  // iPadOS 的 UA 写 Macintosh，靠 coarse 也认得出
  const autoOn = () => !!(mq && mq.matches && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window));

  const T = (G.touch = {
    on: false,
    mode: readMode(),
    blocked: false, // 竖屏遮罩 / 首次提示卡盖着：main.js 的主循环据此暂停模拟
    portrait: false,
    autoOn,
    setMode,
  });
  const want = () => T.mode === 'on' || (T.mode === 'auto' && autoOn());
  function apply() {
    const w = want();
    if (w && !T.on) enable();
    else if (!w && T.on) disable();
    return T.on;
  }
  function setMode(m) {
    T.mode = m === 'on' || m === 'off' ? m : 'auto';
    lsSet(MODE_KEY, T.mode === 'auto' ? null : T.mode);
    return apply();
  }
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);
  }

  // ============================================================
  // 按钮簇：沿用 HUD 里现有的技能格 / 翻滚 / 药瓶（冷却、变灰、图标、拒绝提示都还是 ui.js 那一份），只在 html.touch-ui 下换摆法
  // ============================================================
  const SLOT_HOLD = [
    (on) => (input.mouse.b[0] = on), // 左键技能：主攻
    (on) => (input.mouse.b[2] = on), // 右键：武器普攻
    (on) => (input.keys.KeyQ = on),
    (on) => (input.keys.KeyE = on),
    (on) => (input.keys.KeyR = on), // 武器技
  ];
  const SLOT_CODE = [null, null, 'KeyQ', 'KeyE', 'KeyR'];
  const DRAG_PX = 20; // 从技能键拖出这么远才算手动瞄准
  const DRAG_FULL = 130; // 拖到这么远 = 技能射程
  const HOLD_MS = 450; // Q / E / R 按住不拖超过这么久：当成按住连放（之后再拖就是边放边改方向）
  const AIM_MAX = 14; // 自动瞄准最远（米）
  const RETARGET = 0.25; // 按住时每隔这么久重新选一次目标（秒）

  let dom = null; // 触屏 DOM（第一次打开触屏模式时才建）
  const btns = new Map(); // touch identifier → 按钮的按住状态
  let stick = null; // 摇杆：{ id, ox, oy, x, y, sec, t0, moved }
  const taps = new Map(); // 画布上的轻点：identifier → { x, y, t0, moved }
  let lastTouch = -1e9;
  let aimClearAt = 0;
  let labelsOn = false;
  let raf = 0;
  let introSaved = null;

  const live = () => T.on && !T.blocked && !G.ui.isOpen() && !!G.state.zone;
  const onCanvas = (t) => !t || t === document.body || t === document.documentElement || t.tagName === 'CANVAS';

  // ---------- 自动瞄准：只读 G.state.enemies，不调 Math.random ----------
  function skillRange(slot) {
    const id = slotSkill(slot);
    const sk = id && G.SKILLS[id];
    const r = sk && (sk.range || sk.reach);
    return Math.min(AIM_MAX, r > 0 ? r : AIM_MAX);
  }
  function slotSkill(slot) {
    if (slot === 4) return G.weaponSkill ? G.weaponSkill() : null;
    if (slot === 1 && G.weaponBasic) return G.weaponBasic() || G.save.bar[1];
    return G.save.bar[slot] || null;
  }
  // 先找朝向 ±45°、射程内最近的；没有就 6 m 内最近的；还没有就正前方 4 m
  function autoTarget(range) {
    const P = G.player;
    const fx = Math.sin(P.face), fz = Math.cos(P.face);
    let cone = null, cd = Infinity, near = null, nd = Infinity;
    for (const e of G.state.enemies) {
      if (e.dead || e.executed) continue;
      const dx = e.x - P.x, dz = e.z - P.z;
      const d = Math.hypot(dx, dz);
      if (d <= range && d < cd && d > 1e-6 && (dx * fx + dz * fz) / d >= Math.SQRT1_2) {
        cd = d;
        cone = e;
      }
      if (d <= 6 && d < nd) {
        nd = d;
        near = e;
      }
    }
    const e = cone || near;
    if (e) return { x: e.x, z: e.z, e };
    return { x: P.x + fx * 4, z: P.z + fz * 4, e: null };
  }
  // 瞄准落点：input.aim 给 main.js（refreshMouseWorld 直接用它），鼠标的屏幕坐标也挪到它的投影上（准星、退回屏幕坐标时都对得上）
  function setAim(x, z) {
    input.aim = { x, z };
    const q = W.project(x, 0, z);
    input.mouse.x = q.x;
    input.mouse.y = q.y;
    input.mouse.wx = x;
    input.mouse.wz = z;
    aimClearAt = 0;
  }
  function dragAim(b, cx, cy) {
    const P = G.player;
    const dx = cx - b.cx, dy = cy - b.cy;
    const L = Math.hypot(dx, dy) || 1;
    const f = Math.max(0.08, Math.min(1, (L - DRAG_PX) / (DRAG_FULL - DRAG_PX)));
    const r = b.range * f;
    // 镜头没有偏航：屏幕右 = +x，屏幕下 = +z
    setAim(P.x + (dx / L) * r, P.z + (dy / L) * r);
  }

  function slotOf(el) {
    const tb = el.dataset.tb;
    return tb && tb[0] === 's' ? +tb.slice(1) : -1;
  }
  function overBtn(b, x, y) {
    const r = b.el.getBoundingClientRect();
    return x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8;
  }

  function btnDown(t, el) {
    const kind = el.dataset.tb;
    if (!live()) return;
    if (kind === 'roll') return G.press('Space');
    if (kind === 'f1') return G.press('Digit1');
    if (kind === 'f2') return G.press('Digit2');
    if (kind === 'F') return G.press('KeyF');
    const slot = slotOf(el);
    if (slot < 0) return;
    const r = el.getBoundingClientRect();
    const b = { el, slot, x0: t.clientX, y0: t.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, t0: performance.now(), drag: false, held: false, range: skillRange(slot), retT: 0 };
    btns.set(t.identifier, b);
    el.classList.add('t-down');
    if (slot <= 1) {
      // 主攻 / 普攻：按下就放、按住连放（同按住鼠标键），自动瞄准
      autoAim(b);
      b.held = true;
      SLOT_HOLD[slot](true);
      G.pressSlot(slot, false);
    }
  }
  function autoAim(b) {
    const a = autoTarget(b.range);
    b.target = a.e;
    setAim(a.x, a.z);
  }
  function btnMove(t, b) {
    if (!b.drag && Math.hypot(t.clientX - b.x0, t.clientY - b.y0) >= DRAG_PX) {
      b.drag = true;
      document.documentElement.classList.add('t-aiming');
    }
    if (b.drag) dragAim(b, t.clientX, t.clientY);
  }
  function btnUp(t, b, cancel) {
    btns.delete(t.identifier);
    b.el.classList.remove('t-down');
    const slot = b.slot;
    if (b.drag && !anyDrag()) document.documentElement.classList.remove('t-aiming');
    if (b.held) SLOT_HOLD[slot](false);
    if (cancel || !live()) return armAimClear();
    if (slot >= 2 && !b.held) {
      // Q / E / R：松手才放。拖动的落在准星处（拖回按钮上 = 取消），轻点的自动瞄准
      if (b.drag) {
        if (overBtn(b, t.clientX, t.clientY)) return armAimClear();
        dragAim(b, t.clientX, t.clientY);
      } else autoAim(b);
      // 召唤技能：轻点切换自动召唤，拖动松手 = Shift + 键（在准星处手动召唤一次）
      G.press(SLOT_CODE[slot], { shift: b.drag });
    } else if (b.drag && slot <= 1 && overBtn(b, t.clientX, t.clientY)) {
      // 主攻拖回按钮上：只是不再按住，已经放出去的不收回
    }
    armAimClear();
  }
  const anyDrag = () => {
    for (const b of btns.values()) if (b.drag) return true;
    return false;
  };
  // 松手后瞄准点再留一会儿（缓冲中的施放出手时还要读它），之后交还给屏幕坐标
  function armAimClear() {
    if (!btns.size) aimClearAt = performance.now() + 700;
  }

  // ---------- 摇杆：8 方向，扇区加回差 ----------
  const STICK_ON = 12; // 拖过这么远才算移动
  const STICK_OFF = 8; // 回到这么近就停（回差）
  const STICK_R = 54; // 摇杆盘半径：拖得更远时底座跟着手指走
  const SEC_HYST = 0.14; // 扇区回差（弧度，约 8°）
  const SEC_KEYS = [['KeyD'], ['KeyD', 'KeyS'], ['KeyS'], ['KeyS', 'KeyA'], ['KeyA'], ['KeyA', 'KeyW'], ['KeyW'], ['KeyW', 'KeyD']]; // 从屏幕右起顺时针（屏幕 y 朝下）
  function setStickKeys(sec) {
    input.keys.KeyW = input.keys.KeyA = input.keys.KeyS = input.keys.KeyD = false;
    if (sec >= 0) for (const k of SEC_KEYS[sec]) input.keys[k] = true;
  }
  function stickMove(x, y) {
    const s = stick;
    let dx = x - s.ox, dy = y - s.oy;
    let d = Math.hypot(dx, dy);
    if (d > STICK_R) {
      s.ox = x - (dx / d) * STICK_R;
      s.oy = y - (dy / d) * STICK_R;
      dx = x - s.ox;
      dy = y - s.oy;
      d = STICK_R;
    }
    if (Math.hypot(x - s.x0, y - s.y0) > 10) s.moved = true;
    let sec = s.sec;
    if (sec < 0 ? d >= STICK_ON : d > STICK_OFF) {
      const a = Math.atan2(dy, dx);
      if (sec >= 0) {
        let off = a - (sec * Math.PI) / 4;
        off = Math.atan2(Math.sin(off), Math.cos(off));
        if (Math.abs(off) > Math.PI / 8 + SEC_HYST) sec = -1;
      }
      if (sec < 0) sec = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    } else sec = -1;
    if (sec !== s.sec) {
      s.sec = sec;
      if (live()) setStickKeys(sec);
    }
    if (dom) {
      dom.base.style.transform = 'translate(' + s.ox + 'px,' + s.oy + 'px)';
      dom.knob.style.transform = 'translate(' + (s.ox + dx) + 'px,' + (s.oy + dy) + 'px)';
    }
  }
  function stickEnd() {
    const s = stick;
    stick = null;
    setStickKeys(-1);
    if (dom) dom.stickEl.classList.remove('on');
    // 没拖动的轻点：当成点画面（摇杆区里也能点名牌、宝箱）
    if (s && !s.moved && performance.now() - s.t0 < 350 && live()) tapAt(s.x0, s.y0);
  }

  function tapAt(x, y) {
    input.aim = null; // 点的是这个位置，不是上一次的瞄准点
    G.canvasTap(x, y);
  }

  // ---------- 触摸事件 ----------
  function onStart(e) {
    if (!T.on) return;
    lastTouch = performance.now();
    for (const t of e.changedTouches) {
      const tg = t.target && t.target.closest ? t.target : null;
      const b = tg && tg.closest('[data-tb]');
      if (b) {
        e.preventDefault(); // 不出兼容鼠标事件、不出 click、不缩放
        btnDown(t, b);
        continue;
      }
      if (tg && tg.closest('#t-stick')) {
        e.preventDefault();
        if (!stick) {
          stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, x0: t.clientX, y0: t.clientY, sec: -1, t0: performance.now(), moved: false };
          dom.stickEl.classList.add('on');
          stickMove(t.clientX, t.clientY);
        }
        continue;
      }
      if (onCanvas(t.target)) {
        // 点画面：只有名牌 / 宝箱 / 异兆互动点有反应，点空地什么都不做（不再误放技能）
        e.preventDefault();
        taps.set(t.identifier, { x: t.clientX, y: t.clientY, t0: performance.now(), moved: false });
      }
      // 其余（面板、菜单、顶栏的按钮）照常：滚动、点击都交给浏览器
    }
  }
  function onMove(e) {
    if (!T.on) return;
    lastTouch = performance.now();
    for (const t of e.changedTouches) {
      const b = btns.get(t.identifier);
      if (b) {
        e.preventDefault();
        btnMove(t, b);
      } else if (stick && stick.id === t.identifier) {
        e.preventDefault();
        stickMove(t.clientX, t.clientY);
      } else {
        const tp = taps.get(t.identifier);
        if (tp) {
          e.preventDefault();
          if (Math.hypot(t.clientX - tp.x, t.clientY - tp.y) > 10) tp.moved = true;
        }
      }
    }
  }
  function onEnd(e) {
    if (!T.on) return;
    lastTouch = performance.now();
    // iOS 只在 touchend 里放行声音：第一次松手时建 AudioContext，切后台回来被挂起的也在这里唤醒
    if (G.audio && G.audio.unlock) G.audio.unlock();
    const cancel = e.type === 'touchcancel';
    for (const t of e.changedTouches) {
      const b = btns.get(t.identifier);
      if (b) {
        e.preventDefault();
        btnUp(t, b, cancel);
      } else if (stick && stick.id === t.identifier) {
        e.preventDefault();
        if (cancel) stick.moved = true;
        stickEnd();
      } else {
        const tp = taps.get(t.identifier);
        if (tp) {
          e.preventDefault();
          taps.delete(t.identifier);
          if (!cancel && !tp.moved && performance.now() - tp.t0 < 400 && live()) tapAt(tp.x, tp.y);
        }
      }
    }
  }
  // 兜底：触屏模式下，触摸带出来的兼容鼠标事件落在画布上的一律拦掉（main.js 的 mousedown 不会再放技能）。
  // 捕获阶段挂在 window 上，比 main.js 冒泡阶段的监听先到
  function onCompatMouse(e) {
    if (!T.on || !onCanvas(e.target)) return;
    const fromTouch = (e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) || performance.now() - lastTouch < 1000;
    if (!fromTouch) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  // 手指都离开以后：按住的技能键松开（面板打开、切后台时 main.js 也会清输入）
  function releaseAll() {
    for (const b of btns.values()) {
      if (b.held) SLOT_HOLD[b.slot](false);
      b.el.classList.remove('t-down');
    }
    btns.clear();
    taps.clear();
    if (stick) {
      stick.moved = true;
      stickEnd();
    }
    document.documentElement.classList.remove('t-aiming');
  }

  // ============================================================
  // DOM：摇杆区、顶栏（血条 / 法力条 / 面板入口）、F 键、竖屏遮罩、首次提示卡
  // ============================================================
  const TOP_BTNS = [
    ['inv', '包', '背包'],
    ['skills', '技', '技能'],
    ['tree', '赋', '天赋'],
    ['map', '图', '地图'],
    ['labels', '名牌', '展开地上的名牌'],
    ['menu', '≡', '暂停菜单'],
  ];
  function build() {
    const root = document.createElement('div');
    root.id = 'touch';
    root.innerHTML =
      '<div id="t-safe"></div>' +
      '<div id="t-stick"><i class="t-base"></i><i class="t-knob"></i></div>' +
      '<div id="t-top">' +
      '<div class="t-bars"><div class="t-bar life"><i></i><b></b></div><div class="t-bar mana"><i></i><b></b></div></div>' +
      '<div class="t-btns">' + TOP_BTNS.map((b) => '<button type="button" tabindex="-1" data-tt="' + b[0] + '" aria-label="' + b[2] + '">' + b[1] + '</button>').join('') + '</div>' +
      '</div>' +
      '<div id="t-f" data-tb="F">F</div>' +
      '<div id="t-portrait"><div><b>请横屏游玩</b><span>把手机横过来就能继续</span></div></div>' +
      '<div id="t-hint"><div class="th-card"><div class="th-title">触屏操作</div>' +
      '<div class="th-list">' +
      '<div><b>左下拖动</b>移动</div>' +
      '<div><b>按住大按钮</b>攻击，自动瞄准</div>' +
      '<div><b>从技能键拖出去</b>手动瞄准，松手放出</div>' +
      '<div><b>点地上的名牌</b>拾取</div>' +
      '</div>' +
      '<button type="button" class="btn primary" tabindex="-1" id="t-hint-ok">知道了</button></div></div>';
    document.body.appendChild(root);
    const q = (s) => root.querySelector(s);
    dom = {
      root,
      safe: q('#t-safe'),
      stickEl: q('#t-stick'),
      base: q('.t-base'),
      knob: q('.t-knob'),
      life: { fill: q('.t-bar.life i'), num: q('.t-bar.life b'), k: '' },
      mana: { fill: q('.t-bar.mana i'), num: q('.t-bar.mana b'), k: '' },
      f: q('#t-f'),
      portrait: q('#t-portrait'),
      hint: q('#t-hint'),
      tree: q('[data-tt="tree"]'),
      labels: q('[data-tt="labels"]'),
      fOn: null,
    };
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tt]');
      if (!b) return;
      const k = b.dataset.tt;
      if (k === 'labels') {
        labelsOn = !labelsOn;
        input.alt = labelsOn;
        b.classList.toggle('on', labelsOn);
      } else if (k === 'menu') {
        if (!G.ui.isOpen()) G.ui.pause();
      } else if (!G.ui.storyOn()) G.ui.toggle(k);
    });
    q('#t-hint-ok').addEventListener('click', () => {
      lsSet(HINT_KEY, '1');
      dom.hint.classList.remove('on');
      T.hintOn = false;
    });
  }

  // 现有的 HUD 元素标上按钮簇里的身份（只加 data 属性和类，不挪 DOM）
  function tagCluster(on) {
    const list = Array.from(document.querySelectorAll('#slots > .slot'));
    const ws = document.getElementById('wslot');
    if (ws) list.push(ws);
    list.forEach((el, i) => {
      if (on) el.dataset.tb = 's' + i;
      else delete el.dataset.tb;
    });
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (on) el.dataset.tb = v;
      else delete el.dataset.tb;
    };
    set('dodge', 'roll');
    set('flask-life', 'f1');
    set('flask-mana', 'f2');
  }

  // 开场卡片换成触屏说法（关掉触屏模式时换回来）
  const INTRO_TOUCH =
    '<div><span>左下</span>拖动移动</div>' +
    '<div><span>大按钮</span>按住攻击</div>' +
    '<div><span>技能键</span>轻点自动瞄准，拖出去手动瞄准</div>' +
    '<div><span>翻</span>翻滚闪避</div>';
  function swapIntro(on) {
    const keys = document.querySelector('.intro-keys');
    const foot = document.querySelector('.intro-foot');
    if (!keys || !foot) return;
    if (on) {
      if (!introSaved) introSaved = { keys: keys.innerHTML, foot: foot.innerHTML };
      keys.innerHTML = INTRO_TOUCH;
      foot.textContent = '操作说明在右上角的 ≡ 里';
    } else if (introSaved) {
      keys.innerHTML = introSaved.keys;
      foot.innerHTML = introSaved.foot;
      introSaved = null;
    }
  }

  function setViewportFit(on) {
    const m = document.querySelector('meta[name="viewport"]');
    if (!m) return;
    const base = 'width=device-width, initial-scale=1';
    m.setAttribute('content', on ? base + ', viewport-fit=cover' : base);
  }

  function enable() {
    T.on = true;
    if (!dom) build();
    document.documentElement.classList.add('touch-ui');
    setViewportFit(true);
    tagCluster(true);
    swapIntro(true);
    window.addEventListener('touchstart', onStart, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: false });
    window.addEventListener('touchcancel', onEnd, { passive: false });
    window.addEventListener('mousedown', onCompatMouse, true);
    window.addEventListener('resize', layout);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', resumeAudio);
    window.addEventListener('blur', releaseAll);
    setManifest(true);
    layout();
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function disable() {
    T.on = false;
    releaseAll();
    input.aim = null;
    if (labelsOn) input.alt = false;
    labelsOn = false;
    if (dom) dom.labels.classList.remove('on');
    document.documentElement.classList.remove('touch-ui', 't-portrait');
    setViewportFit(false);
    tagCluster(false);
    swapIntro(false);
    window.removeEventListener('touchstart', onStart, { passive: false });
    window.removeEventListener('touchmove', onMove, { passive: false });
    window.removeEventListener('touchend', onEnd, { passive: false });
    window.removeEventListener('touchcancel', onEnd, { passive: false });
    window.removeEventListener('mousedown', onCompatMouse, true);
    window.removeEventListener('resize', layout);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', layout);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pageshow', resumeAudio);
    window.removeEventListener('blur', releaseAll);
    setManifest(false);
    document.documentElement.style.removeProperty('--app-h');
    W.mmTouch = null;
    T.blocked = T.portrait = T.hintOn = false;
  }

  // 切到后台：松开所有按着的键；回来时停在暂停菜单（标题画面、面板开着时不管）
  function onVis() {
    if (!document.hidden) return resumeAudio();
    releaseAll();
    if (!G.ui.isOpen() && G.state.zone) G.ui.pause();
  }

  // 从后台回来：试着唤醒被系统挂起的 AudioContext（不行的话下一次松手时 G.audio.unlock 再唤醒）
  function resumeAudio() {
    const c = G.audio && G.audio.ctx && G.audio.ctx();
    if (c && c.state !== 'running' && c.state !== 'closed') {
      try {
        const p = c.resume();
        if (p && p.catch) p.catch(() => {});
      } catch (e) {
        /* 下一次松手再试 */
      }
    }
  }
  // 「添加到主屏幕」：清单只在触屏模式下挂上（桌面 Chrome 看到清单会在地址栏多一个安装图标）
  function setManifest(on) {
    let l = document.querySelector('link[rel="manifest"]');
    if (on && !l) {
      l = document.createElement('link');
      l.rel = 'manifest';
      l.href = 'manifest.json';
      document.head.appendChild(l);
    } else if (!on && l) l.remove();
  }

  // 安全区：真机读 env()（CSS 里），测试用 --t-safe-* 变量假装；小地图画在 2D 画布上，这里把 CSS 算出来的边距读回来
  // （自定义属性里的 env() / max() 读出来是原文，所以用一个按 --sa-* 摆放的隐形探针元素量出像素）
  function safe() {
    const cs = getComputedStyle(dom.safe);
    const n = (k) => parseFloat(cs[k]) || 0;
    return { t: n('top'), r: n('right'), b: n('bottom'), l: n('left') };
  }
  const MM_SIZE = 110;
  function layout() {
    if (!T.on) return;
    // 可见高度：iOS 的工具栏会占掉一截（100vh 比看得见的高），按 visualViewport 算
    const vv = window.visualViewport;
    document.documentElement.style.setProperty('--app-h', Math.round(vv && vv.height > 0 ? vv.height : window.innerHeight) + 'px');
    const s = safe();
    const k = MM_SIZE / ((W.minimapInfo && W.minimapInfo().size) || 172);
    W.mmTouch = { x: window.innerWidth - s.r - 8 - MM_SIZE, y: s.t + 6, k };
    T.portrait = window.innerHeight > window.innerWidth;
    document.documentElement.classList.toggle('t-portrait', T.portrait);
  }

  // ---------- 每帧：竖屏遮罩、提示卡、按住时重新选目标、F 显隐、血条 ----------
  function fShow() {
    const P = G.player;
    if (!P || P.dead || !G.state.zone) return false;
    if (G.execTarget && G.execTarget(G.POISE.execRange)) return true;
    for (const l of G.state.loot) if (Math.hypot(l.x - P.x, l.z - P.z) <= 3.5) return true;
    const cs = G.state.zone.chests;
    if (cs) for (const c of cs) if (!c.open && Math.hypot(c.x - P.x, c.z - P.z) <= 3.5) return true;
    return !!(G.encNearest && G.encNearest(3.5));
  }
  function bar(o, v, max) {
    const key = Math.round(v) + '/' + Math.round(max);
    if (key === o.k) return;
    o.k = key;
    o.fill.style.transform = 'scaleX(' + (max > 0 ? Math.max(0, Math.min(1, v / max)) : 0) + ')';
    o.num.textContent = key;
  }
  let lastT = 0;
  function tick(now) {
    if (!T.on) {
      raf = 0;
      return;
    }
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, Math.max(0, (now - (lastT || now)) / 1000));
    lastT = now;
    if (T.portrait !== window.innerHeight > window.innerWidth) layout();
    dom.portrait.classList.toggle('on', T.portrait);
    // 首次提示卡：第一次真正进到游戏画面（开场卡片、故事、标题都收起）时弹一次，每台设备一次
    if (!T.hintOn && G.state.zone && !G.ui.isOpen() && !T.portrait && lsGet(HINT_KEY) !== '1') {
      T.hintOn = true;
      dom.hint.classList.add('on');
    }
    const was = T.blocked;
    T.blocked = T.portrait || !!T.hintOn;
    if (T.blocked && !was) releaseAll();
    if (G.ui.isOpen() || T.blocked) {
      if (btns.size || stick) releaseAll();
    } else {
      // 按住主攻 / 普攻（没拖动）：每 0.25 秒重新选一次目标，目标死了立刻换
      for (const b of btns.values()) {
        // Q / E / R 按住不拖：当成按住键连放（同键盘按住）
        if (!b.held && !b.drag && b.slot >= 2 && now - b.t0 >= HOLD_MS) {
          b.held = true;
          autoAim(b);
          SLOT_HOLD[b.slot](true);
          G.press(SLOT_CODE[b.slot]);
        }
        if (!b.held || b.drag) continue;
        b.retT -= dt;
        if (b.retT <= 0 || (b.target && b.target.dead)) {
          b.retT = RETARGET;
          autoAim(b);
        }
      }
      if (aimClearAt && now >= aimClearAt && !btns.size) {
        input.aim = null;
        aimClearAt = 0;
      }
    }
    if (labelsOn && !input.alt) input.alt = true; // 失焦清输入会把 Alt 清掉：名牌开关开着就补回来
    // 拖动瞄准时准星跟着落点
    if (anyDrag()) {
      const r = document.getElementById('reticle');
      if (r) r.style.transform = 'translate(' + input.mouse.x + 'px,' + input.mouse.y + 'px)';
    }
    const f = fShow();
    if (f !== dom.fOn) {
      dom.fOn = f;
      dom.f.classList.toggle('on', f);
    }
    const P = G.player;
    if (P) {
      bar(dom.life, P.life, P.maxLife);
      bar(dom.mana, P.mana, P.maxMana);
    }
    const pp = document.getElementById('pp-remind');
    dom.tree.classList.toggle('dot', !!(pp && pp.classList.contains('on')));
  }

  // 调试 / 测试读
  T.state = () => ({
    on: T.on,
    mode: T.mode,
    blocked: T.blocked,
    portrait: T.portrait,
    hint: !!T.hintOn,
    stick: stick ? stick.sec : -1,
    held: Array.from(btns.values()).map((b) => ({ slot: b.slot, drag: b.drag, held: b.held })),
    aim: input.aim ? { x: input.aim.x, z: input.aim.z } : null,
    f: !!(dom && dom.fOn),
    labels: labelsOn,
  });
  T.keys = { MODE_KEY, HINT_KEY };

  const init = () => {
    if (want()) enable();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
