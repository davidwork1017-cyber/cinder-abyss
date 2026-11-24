'use strict';
// 触屏操作（mobile-design M1 / M2）：浮动模拟摇杆、右下按钮簇、自动瞄准 / 拖动瞄准、F 情境键、顶栏、竖屏遮罩、首次提示卡。
// 只写键鼠本来就写的那几个字段（input.mouse.b / G.press / G.pressSlot / input.aim），外加触屏专用的 input.move（模拟摇杆；桌面永远是 null）。
// 触屏模式关着时什么都不做：不建 DOM、不挂触摸监听，只留一个 matchMedia 的 change 监听（换了主指针再判断一次）。
(function () {
  const G = window.G;
  const W = G.world;
  const input = G.input;

  // 设备级的设置（不进存档：触屏是这台设备的属性，换角色也不变）。隐私模式下存储可能抛错，读写都包着
  const MODE_KEY = 'cinder-abyss-touch'; // 'auto' | 'on' | 'off'，没有 = auto
  const HINT_KEY = 'cinder-abyss-touch-hint'; // 首次提示卡看过了
  // M2 的触屏设置，也存在这台设备上：按钮大小 s / m / l（没有 = m）、左手模式（'1' = 开）、震动（'0' = 关，没有 = 开）
  const SIZE_KEY = 'cinder-abyss-touch-size';
  const MIRROR_KEY = 'cinder-abyss-touch-mirror';
  const VIBE_KEY = 'cinder-abyss-touch-vibe';
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

  const readPrefs = () => {
    const sz = lsGet(SIZE_KEY);
    return { size: sz === 's' || sz === 'l' ? sz : 'm', mirror: lsGet(MIRROR_KEY) === '1', vibe: lsGet(VIBE_KEY) !== '0' };
  };
  // 安卓的 Chrome / 火狐有 navigator.vibrate；iPhone（包括 iPhone 上的 Chrome，底层是 WebKit）没有，震动这一项整个不显示
  const canVibe = () => typeof navigator.vibrate === 'function';

  const T = (G.touch = {
    on: false,
    mode: readMode(),
    blocked: false, // 竖屏遮罩 / 首次提示卡盖着：main.js 的主循环据此暂停模拟
    portrait: false,
    autoOn,
    setMode,
    prefs: readPrefs(),
    setPref,
    canVibe,
  });
  function setPref(k, v) {
    const P = T.prefs;
    if (k === 'size') {
      P.size = v === 's' || v === 'l' ? v : 'm';
      lsSet(SIZE_KEY, P.size === 'm' ? null : P.size);
    } else if (k === 'mirror') {
      P.mirror = !!v;
      lsSet(MIRROR_KEY, P.mirror ? '1' : null);
    } else if (k === 'vibe') {
      P.vibe = !!v;
      lsSet(VIBE_KEY, P.vibe ? null : '0');
      if (P.vibe) buzz('roll', true); // 打开时震一下，知道是什么感觉
    }
    applyPrefs();
    return P;
  }
  function applyPrefs() {
    const c = document.documentElement.classList, on = T.on, P = T.prefs;
    c.toggle('t-size-s', on && P.size === 's');
    c.toggle('t-size-l', on && P.size === 'l');
    c.toggle('t-mirror', on && P.mirror);
    if (on) layout();
  }

  // ---------- 震动（安卓）：重击、翻滚、残血时短震。只读玩家状态，不碰模拟；两次之间至少隔 120 ms，残血每 6 秒最多一次 ----------
  const BUZZ = { hit: 35, roll: 12, exec: 28, low: [40, 70, 40] };
  const BUZZ_GAP = 120;
  const LOW_FRAC = 0.3, LOW_GAP = 6000;
  const HIT_FRAC = 0.12; // 一帧里掉了这么多最大生命 = 重击
  const vb = { last: -1e9, lowAt: -1e9, life: -1, roll: false, exec: false, low: false, n: 0, log: [] };
  function buzz(kind, force) {
    if (!canVibe() || (!force && !(T.on && T.prefs.vibe))) return false;
    const now = performance.now();
    if (!force && now - vb.last < BUZZ_GAP) return false;
    vb.last = now;
    try {
      navigator.vibrate(BUZZ[kind]);
    } catch (e) {
      return false;
    }
    vb.n++;
    vb.log.push(kind);
    if (vb.log.length > 20) vb.log.shift();
    return true;
  }
  function vibeWatch(now) {
    const P = G.player;
    if (!P || !G.state.zone || P.dead || G.state.paused) {
      vb.life = -1;
      return;
    }
    const max = P.maxLife || 1;
    if (vb.life >= 0 && vb.life - P.life >= max * HIT_FRAC) buzz('hit');
    vb.life = P.life;
    const rolling = P.roll.t > 0;
    if (rolling && !vb.roll) buzz('roll');
    vb.roll = rolling;
    const ex = !!(P.exec && P.exec.hit);
    if (ex && !vb.exec) buzz('exec');
    vb.exec = ex;
    const low = P.life < max * LOW_FRAC;
    if (low && (!vb.low || now - vb.lowAt >= LOW_GAP) && buzz('low')) vb.lowAt = now;
    vb.low = low;
  }
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
  // Q / E / R 不做按住连放：一律松手才放（按住停一会儿再拖也还是拖动瞄准，不会先放出去）
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
  let introSeen = false; // 这台设备上触屏版的开场卡片弹过了

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
    let r = b.range * f;
    // 镜头没有偏航：屏幕右 = +x，屏幕下 = +z
    const ux = dx / L, uz = dy / L;
    // 落点只能在看得见的地方：准星投到顶栏、区域名、小地图 / 追踪条底下时，沿着这个方向往回收（二分，投影沿射线单调）
    if (!inPlay(b.play, P.x + ux * r, P.z + uz * r)) {
      let lo = 0, hi = r;
      for (let i = 0; i < 10; i++) {
        const m = (lo + hi) / 2;
        if (inPlay(b.play, P.x + ux * m, P.z + uz * m)) lo = m;
        else hi = m;
      }
      r = lo;
    }
    setAim(P.x + ux * r, P.z + uz * r);
  }
  // 能放准星的区域（屏幕坐标）：顶栏和区域名下面、四边安全区以内；右上角小地图和追踪条那一块再往下让
  function playArea() {
    const s = safe(), W0 = G.viewW(), H0 = G.viewH();
    const bot = (sel) => {
      const n = document.querySelector(sel);
      if (!n || !n.getClientRects().length) return 0;
      return G.rectToFrame(n.getBoundingClientRect()).bottom;
    };
    const q = document.getElementById('quest');
    const qr = q && q.getClientRects().length ? G.rectToFrame(q.getBoundingClientRect()) : null;
    const mm = W.mmTouch;
    return {
      l: s.l + 12, r: W0 - s.r - 12, b: H0 - s.b - 12,
      t: Math.max(bot('#t-top'), bot('#zone-box'), s.t) + 10,
      rt: Math.max(qr && q.textContent ? qr.bottom : 0, mm ? mm.y + MM_SIZE : 0) + 10, // 右上角那一块的下沿
      rx: Math.min(qr && q.textContent ? qr.left : W0, mm ? mm.x : W0) - 10, // 它的左沿
    };
  }
  function inPlay(a, x, z) {
    if (!a) return true;
    const q = W.project(x, 0, z);
    if (q.x < a.l || q.x > a.r || q.y > a.b || q.y < a.t) return false;
    return !(q.x > a.rx && q.y < a.rt);
  }

  function slotOf(el) {
    const tb = el.dataset.tb;
    return tb && tb[0] === 's' ? +tb.slice(1) : -1;
  }
  function overBtn(b, x, y) {
    const r = G.rectToFrame(b.el.getBoundingClientRect());
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
    const r = G.rectToFrame(el.getBoundingClientRect());
    const b = { el, slot, x0: t.clientX, y0: t.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, t0: performance.now(), drag: false, held: false, range: skillRange(slot), retT: 0 };
    b.play = slot >= 0 ? playArea() : null;
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

  // ---------- 摇杆：模拟量（任意角度 + 推杆幅度），写 input.move；桌面不碰它 ----------
  const STICK_ON = 12; // 拖过这么远才算移动
  const STICK_OFF = 8; // 回到这么近就停（回差）
  const STICK_R = 54; // 摇杆盘半径：拖得更远时底座跟着手指走
  const STICK_FULL = 36; // 推到这么远 = 全速（不用推到盘边）
  const STICK_MIN = 0.35; // 刚过死区时的速度比例（再慢就像在原地滑步）
  // 推杆幅度 → 速度比例：死区外从 STICK_MIN 线性涨到 1。走 / 跑的动作由 world.js 按实际速度混合，不另做档位
  const stickK = (d) => STICK_MIN + (1 - STICK_MIN) * Math.max(0, Math.min(1, (d - STICK_ON) / (STICK_FULL - STICK_ON)));
  function setStickMove(dx, dy, d) {
    if (d <= 0) input.move = null;
    else input.move = { x: dx / d, z: dy / d, k: stickK(d) }; // 镜头没有偏航：屏幕右 = +x，屏幕下 = +z
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
    s.on = s.on ? d > STICK_OFF : d >= STICK_ON;
    if (live()) setStickMove(dx, dy, s.on ? d : 0);
    if (dom) {
      dom.base.style.transform = 'translate(' + s.ox + 'px,' + s.oy + 'px)';
      dom.knob.style.transform = 'translate(' + (s.ox + dx) + 'px,' + (s.oy + dy) + 'px)';
    }
  }
  function stickEnd() {
    const s = stick;
    stick = null;
    input.move = null;
    if (dom) dom.stickEl.classList.remove('on');
    // 没拖动的轻点：当成点画面（摇杆区里也能点名牌、宝箱）
    if (s && !s.moved && performance.now() - s.t0 < 350 && live()) tapAt(s.x0, s.y0);
  }

  function tapAt(x, y) {
    input.aim = null; // 点的是这个位置，不是上一次的瞄准点
    G.canvasTap(x, y);
  }

  // ---------- 触摸事件 ----------
  // 触点换到画面坐标（旋转横屏时屏幕坐标和画面坐标差 90°；平时原样返回）。下面的摇杆、按钮、拖动瞄准、长按都按画面坐标算
  const fr = (t) => {
    if (!G.rot) return t;
    const q = G.toFrame(t.clientX, t.clientY);
    return { identifier: t.identifier, target: t.target, clientX: q.x, clientY: q.y };
  };
  function onStart(e) {
    if (!T.on) return;
    lastTouch = performance.now();
    for (const t0 of e.changedTouches) {
      const t = fr(t0);
      const tg = t.target && t.target.closest ? t.target : null;
      const b = tg && tg.closest('[data-tb]');
      if (b) {
        if (e.cancelable) e.preventDefault(); // 不出兼容鼠标事件、不出 click、不缩放
        btnDown(t, b);
        continue;
      }
      if (tg && tg.closest('#t-stick')) {
        if (e.cancelable) e.preventDefault();
        if (!stick) {
          stick = { id: t.identifier, ox: t.clientX, oy: t.clientY, x0: t.clientX, y0: t.clientY, on: false, t0: performance.now(), moved: false };
          dom.stickEl.classList.add('on');
          stickMove(t.clientX, t.clientY);
        }
        continue;
      }
      if (onCanvas(t.target)) {
        // 点画面：只有名牌 / 宝箱 / 异兆互动点有反应，点空地什么都不做（不再误放技能）
        if (e.cancelable) e.preventDefault();
        taps.set(t.identifier, { x: t.clientX, y: t.clientY, t0: performance.now(), moved: false });
      }
      // 其余（面板、菜单、顶栏的按钮）照常：滚动、点击都交给浏览器；按住不动是长按看详情
      lpStart(t, e.timeStamp);
    }
  }
  function onMove(e) {
    if (!T.on) return;
    lastTouch = performance.now();
    for (const t0 of e.changedTouches) {
      const t = fr(t0);
      lpMove(t);
      const b = btns.get(t.identifier);
      if (b) {
        if (e.cancelable) e.preventDefault();
        btnMove(t, b);
      } else if (stick && stick.id === t.identifier) {
        if (e.cancelable) e.preventDefault();
        stickMove(t.clientX, t.clientY);
      } else {
        const tp = taps.get(t.identifier);
        if (tp) {
          if (e.cancelable) e.preventDefault();
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
    for (const t0 of e.changedTouches) {
      const t = fr(t0);
      lpEnd(e, t, cancel);
      const b = btns.get(t.identifier);
      if (b) {
        if (e.cancelable) e.preventDefault();
        btnUp(t, b, cancel);
      } else if (stick && stick.id === t.identifier) {
        if (e.cancelable) e.preventDefault();
        if (cancel) stick.moved = true;
        stickEnd();
      } else {
        const tp = taps.get(t.identifier);
        if (tp) {
          if (e.cancelable) e.preventDefault();
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
    input.move = null; // 丢了 touchend 也不能让人物一直走下去
  }

  // ============================================================
  // 文字：面板、浮窗、菜单里写着鼠标 / 键盘操作的地方换成触屏说法（只在触屏模式下；桌面原样）。
  // 盯着正文改动（MutationObserver），只改文字节点和按键角标，不动结构和事件
  // ============================================================
  const TXT_HIT = /右键|左键|悬停|Alt|Shift|Ctrl|Esc|Enter|WASD/;
  const TXT_RULES = [
    [/点击物品看详情，悬停与身上的对比。/g, '点一下物品看详情和与身上的比较，点两下直接穿上。'],
    [/悬停背包格子或/g, '点背包格子或'],
    [/悬停词缀查看阶级/g, '点词缀查看阶级'],
    [/悬停或按住 ?Alt ?展开/g, '点顶栏的「名牌」展开'],
    [/按住 ?Alt ?(查看|看)/g, '长按$1'],
    [/再 ?Shift\+点击一次，确认分解/g, '再点一次「分解」确认'],
    [/Shift\+点击 ?分解 · ?Ctrl\+点击 ?锁定/g, '详情里分解 / 锁定'],
    [/Shift\+点击 ?/g, '详情里点'],
    [/点击或 ?Ctrl\+点击物品解锁/g, '点「已锁」解锁'],
    [/。也可以 ?Ctrl\+点击物品/g, '。'],
    [/（Ctrl\+点击）/g, '（点「已锁」）'],
    [/ · Ctrl\+点击解锁/g, ' · 点「已锁」解锁'],
    [/数字键 1–4 选择，Esc 返回/g, '点一条选择'],
    [/取消或 ?Esc ?不消耗/g, '取消不消耗'],
    [/没有面板时 ?Esc ?暂停/g, '右上角 ≡ 暂停'],
    [/悬停/g, '点'],
    [/左键/g, '大按钮'],
  ];
  // 右键：说的是穿装备（右键穿上 / 装备 / 卸下）就是「点两下」，其余是右下那颗普攻键
  const RMB_EQUIP = /右键\s*(或拖|装备|卸下|穿上)/;
  const BADGE = /^(Esc|Enter|Shift|Alt|Ctrl)$/;
  function blockOf(n) {
    let e = n.parentElement;
    while (e && /^(B|KBD|I|EM|STRONG|SMALL)$/.test(e.tagName) && e.parentElement) e = e.parentElement;
    return e;
  }
  const txtStats = { calls: 0, ms: 0 }; // 文字处理的开销（测试读）
  function fixText(node) {
    txtStats.calls++;
    const v = node.nodeValue;
    if (!v || !TXT_HIT.test(v)) return;
    const pe = node.parentElement;
    if (!pe || pe.closest('script,style,textarea,input')) return;
    if (pe.tagName === 'KBD' && BADGE.test(v.trim())) {
      pe.classList.add('t-kh'); // 按键角标：触屏上没有这个键，藏起来
      return;
    }
    let t = v;
    for (const [re, to] of TXT_RULES) t = t.replace(re, to);
    if (t.indexOf('右键') >= 0) {
      const b = blockOf(node);
      t = t.replace(/右键/g, b && RMB_EQUIP.test(b.textContent) ? '点两下' : '普攻键');
    }
    if (t !== v) node.nodeValue = t;
  }
  function fixTree(root) {
    if (!root) return;
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1 || !TXT_HIT.test(root.textContent || '')) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fixText(n);
  }
  // 只盯面板、浮窗、菜单、提示这几块（data-tip 的文字出现在 #tip 里时一起改）；HUD 的数字、连击、飘字每帧在变，不盯
  const TXT_ROOTS = ['panel', 'tip', 'title', 'pause', 'intro', 'toasts', 'coach', 'save-bar', 'story'];
  let txtObs = null;
  function watchText(on) {
    if (on && !txtObs && window.MutationObserver) {
      txtObs = new MutationObserver((list) => {
        const t0 = performance.now();
        for (const m of list) {
          if (m.type === 'characterData') fixText(m.target);
          else for (const n of m.addedNodes) fixTree(n);
        }
        txtStats.ms += performance.now() - t0;
      });
      for (const id of TXT_ROOTS) {
        const r = document.getElementById(id);
        if (!r) continue;
        txtObs.observe(r, { childList: true, subtree: true, characterData: true });
        fixTree(r);
      }
    } else if (!on && txtObs) {
      txtObs.disconnect();
      txtObs = null;
    }
  }

  // ---------- 长按看详情（面板、菜单里）：按住 450 ms 不动 = 按住 Alt，浮窗在手指旁边出来 ----------
  // 松手后浮窗留着（手指挡着时也能看完），下一次碰屏幕、面板关掉时收起；长按之后的那次 click 吞掉（不会顺手点亮天赋、穿上装备）。
  // 手指移动超过 8 px 就不是长按：在背包里是拖拽（ui.js 的拖拽对触摸用 8 px 的门槛），在列表里是滚动
  const LONG_MS = 450;
  const LP_MOVE = 8;
  let lp = null;
  let lpEndAt = -1e9; // 长按松手的时刻：之后 600 ms 内的 click 不算
  function lpStart(t, ts) {
    lpCancel();
    const tg = t.target && t.target.nodeType === 1 ? t.target : null;
    if (!tg || !tg.closest('#panel, #title, #pause, #tip')) return;
    const x = t.clientX, y = t.clientY, id = t.identifier;
    lp = { id, x, y, ts, on: false, stuck: false, timer: setTimeout(() => {
      if (!lp || lp.id !== id) return;
      lp.on = true;
      input.alt = true;
      document.documentElement.classList.add('t-lp'); // 浮窗只在长按时出现（轻点交给详情栏）
      // 浮窗按悬停出：在手指下面补一组 mouseover / mousemove
      const sp = G.toScreen(x, y); // 补发的鼠标事件用屏幕坐标（ui.js 自己再换回画面坐标）
      // 手指按下去的那个元素（机器忙时面板还在入场动画里挪动，按坐标找可能找到格子之间的空隙）；它已经不在页面上了才按坐标找
      const el = tg.isConnected ? tg : document.elementFromPoint(sp.x, sp.y);
      if (el) for (const type of ['mouseover', 'mousemove']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: sp.x, clientY: sp.y }));
      T.lpCount = (T.lpCount || 0) + 1;
    }, LONG_MS) };
  }
  function lpMove(t) {
    if (lp && !lp.stuck && lp.id === t.identifier && Math.hypot(t.clientX - lp.x, t.clientY - lp.y) > LP_MOVE) lpCancel(); // 是拖拽 / 滚动，不是长按
  }
  // 松手：没到 450 ms 的照常（click 交给浏览器）；已经弹出详情的留着浮窗，吞掉这次 click
  function lpEnd(e, t, cancel) {
    if (!lp || lp.id !== t.identifier) return;
    // 按住的时长按触摸事件自己的时间戳算：主线程卡的时候（一帧几百毫秒）计时器可能比松手的事件先跑，其实只按了一下，照轻点处理
    const short = lp.ts !== undefined && e.timeStamp - lp.ts < LONG_MS;
    if (!lp.on || cancel || short) return lpCancel();
    clearTimeout(lp.timer);
    lp.stuck = true;
    lp.id = null;
    lpEndAt = performance.now();
    if (e.cancelable) e.preventDefault();
  }
  function lpCancel() {
    if (!lp) return;
    clearTimeout(lp.timer);
    if (lp.on && !labelsOn) input.alt = false;
    document.documentElement.classList.remove('t-lp');
    lp = null;
  }
  function onLpClick(e) {
    if (!T.on || performance.now() - lpEndAt > 600) return;
    lpEndAt = -1e9;
    e.stopImmediatePropagation();
    e.preventDefault();
  }
  // 安卓长按会发 contextmenu：面板里它等于右键（穿上 / 卸下），触摸带出来的一律拦掉
  function onCtxMenu(e) {
    if (!T.on || performance.now() - lastTouch > 1500) return;
    e.stopImmediatePropagation();
    e.preventDefault();
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
    ['rot', '⟲', '画面换个方向'], // 只在旋转横屏时显示
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
      '<div id="t-portrait"><div><b>横过来玩</b><span>把手机横过来，或者点下面的按钮</span><button type="button" class="btn primary" tabindex="-1" data-trot="go">横屏开始</button></div></div>' +
      '<button type="button" id="t-rot-go" class="btn primary" tabindex="-1" data-trot="go">横屏开始</button>' +
      '<button type="button" id="t-rot-flip" class="btn" tabindex="-1" data-trot="flip" aria-label="换个方向">⟲</button>' +
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
      intro: document.getElementById('intro'),
      tree: q('[data-tt="tree"]'),
      labels: q('[data-tt="labels"]'),
      fOn: null,
    };
    // 提示卡在触屏下只显示两行，点一下展开 / 收起
    const coach = document.getElementById('coach');
    if (coach) coach.addEventListener('click', () => T.on && coach.classList.toggle('t-open'));
    root.addEventListener('click', (e) => {
      const rb = e.target.closest('[data-trot]');
      if (rb) return rb.dataset.trot === 'flip' ? flipRot() : goLandscape();
      const b = e.target.closest('[data-tt]');
      if (!b) return;
      const k = b.dataset.tt;
      if (k === 'rot') return flipRot();
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
    window.addEventListener('contextmenu', onCtxMenu, true);
    window.addEventListener('click', onLpClick, true);
    watchText(true);
    window.addEventListener('resize', layout);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', layout);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pageshow', resumeAudio);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('pagehide', releaseAll);
    watchTilt(true);
    setManifest(true);
    setThemeColor(true);
    applyPrefs();
    layout();
    if (!raf) raf = requestAnimationFrame(tick);
    lockLandscape();
    restoreRot();
  }
  function disable() {
    setRot(null);
    watchTilt(false);
    T.on = false;
    releaseAll();
    input.aim = null;
    if (labelsOn) input.alt = false;
    labelsOn = false;
    if (dom) dom.labels.classList.remove('on');
    document.documentElement.classList.remove('touch-ui', 't-portrait', 't-land', 't-boss', 't-aiming');
    if (dom) dom.bossOn = null;
    setViewportFit(false);
    tagCluster(false);
    swapIntro(false);
    window.removeEventListener('touchstart', onStart, { passive: false });
    window.removeEventListener('touchmove', onMove, { passive: false });
    window.removeEventListener('touchend', onEnd, { passive: false });
    window.removeEventListener('touchcancel', onEnd, { passive: false });
    window.removeEventListener('mousedown', onCompatMouse, true);
    window.removeEventListener('contextmenu', onCtxMenu, true);
    window.removeEventListener('click', onLpClick, true);
    watchText(false);
    lpCancel();
    window.removeEventListener('resize', layout);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', layout);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('pageshow', resumeAudio);
    window.removeEventListener('blur', releaseAll);
    window.removeEventListener('pagehide', releaseAll);
    setManifest(false);
    setThemeColor(false);
    applyPrefs();
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

  // 安卓的地址栏 / 任务切换里的颜色（只在触屏模式下挂；桌面不加，地址栏照旧）
  function setThemeColor(on) {
    let m = document.querySelector('meta[name="theme-color"]');
    if (on && !m) {
      m = document.createElement('meta');
      m.name = 'theme-color';
      m.content = '#0a0706';
      document.head.appendChild(m);
    } else if (!on && m) m.remove();
  }
  // 从主屏幕全屏打开时（安卓）锁横屏；浏览器里打开、iPhone 上都不支持，悄悄失败就算了（竖屏遮罩照旧兜底）
  function lockLandscape() {
    try {
      const so = screen.orientation;
      const full = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || !!document.fullscreenElement;
      if (full && so && so.lock) {
        const p = so.lock('landscape');
        if (p && p.catch) p.catch(() => {});
      }
    } catch (e) {
      /* 不支持 */
    }
  }

  // ============================================================
  // 横屏开始（手机版 M2）：竖着拿手机时点「横屏开始」。安卓等支持的浏览器进全屏、锁横屏；
  // iPhone（WebKit 没有 screen.orientation.lock，iPhone 上也不能让页面全屏）或者锁不住时，把整个页面转 90° 画（html.t-rot），
  // 手机转过来就是横屏，系统的方向锁开着也行。真横过来时自动退出。
  // body 整个转过去（画布、HUD、面板、菜单都在里面）；坐标换算见 world.js 的 G.toFrame / G.viewW，CSS 见 style.css 的 t-rot / t-rh* / --vw
  // ============================================================
  let tilt = null; // 最近一次的左右倾斜（deviceorientation 的 gamma，度）：安卓不用授权就有；iPhone 要弹授权框，不要它，默认顺时针
  const onTilt = (e) => {
    if (e.gamma !== null && e.gamma !== undefined) tilt = e.gamma;
  };
  function watchTilt(on) {
    const D = window.DeviceOrientationEvent;
    if (!D || typeof D.requestPermission === 'function') return;
    if (on) window.addEventListener('deviceorientation', onTilt, { passive: true });
    else window.removeEventListener('deviceorientation', onTilt, { passive: true });
  }
  // 往哪边转：手机往右倒（gamma > 0，右边往下）时画面逆时针转，否则顺时针（手机往左倒、左边往下，横过来时刘海在左）
  const pickDir = () => (tilt !== null && tilt > 20 ? 'ccw' : 'cw');
  const SAFE = ['t', 'r', 'b', 'l'];
  const SAFE_ENV = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
  // 画面的四边对应屏幕的哪一边（安全区跟着换：竖着时的刘海、底部横条转过去以后在画面的左右）
  const ROT_SIDE = { cw: { t: 'r', r: 'b', b: 'l', l: 't' }, ccw: { t: 'l', r: 't', b: 'r', l: 'b' } };
  function placeRot() {
    const R = G.rot, Ws = window.innerWidth, Hs = window.innerHeight, b = document.body.style, de = document.documentElement;
    b.position = 'fixed';
    b.left = b.top = '0px';
    b.width = Hs + 'px';
    b.height = Ws + 'px';
    b.transformOrigin = '0 0';
    b.transform = R.dir === 'cw' ? 'translate(' + Ws + 'px, 0) rotate(90deg)' : 'translate(0, ' + Hs + 'px) rotate(-90deg)';
    // CSS 里的 vw / vh 换成转过的画面（style.css 写的是 var(--vw, 1vw)，平时不设）
    de.style.setProperty('--vw', Hs / 100 + 'px');
    de.style.setProperty('--vh', Ws / 100 + 'px');
    de.style.setProperty('--dvh', Ws / 100 + 'px');
    for (const k of SAFE) {
      const sk = ROT_SIDE[R.dir][k];
      // 左右照样至少 12 px（屏幕四角是圆的，转过去以后画面的四角还是那几个圆角；同 style.css 的 --sa-l / --sa-r）
      de.style.setProperty('--sa-' + k, 'max(env(safe-area-inset-' + SAFE_ENV[sk] + ', 0px), var(--t-safe-' + sk + ', 0px)' + (k === 'l' || k === 'r' ? ', 12px)' : ')'));
    }
    // 按画面尺寸的那几段（max-height 780 / 600 / 360 / 345、max-width 720）：style.css 里有 t-rh* / t-rw720 的副本
    const fw = Hs, fh = Ws, c = de.classList;
    c.toggle('t-rh780', fh <= 780);
    c.toggle('t-rh600', fh <= 600);
    c.toggle('t-rh360', fh <= 360);
    c.toggle('t-rh345', fh <= 345);
    c.toggle('t-rw720', fw <= 720);
  }
  const ROT_KEY = 'cinder-abyss-rot'; // sessionStorage：这个标签页里转着的方向
  function restoreRot() {
    let d = null;
    try {
      d = sessionStorage.getItem(ROT_KEY);
    } catch (e) {
      d = null;
    }
    if ((d === 'cw' || d === 'ccw') && window.innerHeight > window.innerWidth) setRot(d);
  }
  const ROT_CLS = ['t-rot', 't-rot-cw', 't-rot-ccw', 't-tsub', 't-rh780', 't-rh600', 't-rh360', 't-rh345', 't-rw720'];
  function setRot(dir) {
    if (dir && !T.on) return false;
    const was = G.rot ? G.rot.dir : null;
    if ((dir || null) === was) return !!dir;
    const de = document.documentElement, c = de.classList;
    releaseAll();
    lpCancel();
    if (dir) {
      G.rot = { dir, get W() { return window.innerWidth; }, get H() { return window.innerHeight; } };
      c.add('t-rot');
      c.toggle('t-rot-cw', dir === 'cw');
      c.toggle('t-rot-ccw', dir === 'ccw');
      placeRot();
    } else {
      G.rot = null;
      for (const k of ROT_CLS) c.remove(k);
      const b = document.body.style;
      for (const k of ['position', 'left', 'top', 'width', 'height', 'transform', 'transform-origin']) b.removeProperty(k);
      for (const k of ['--vw', '--vh', '--dvh', '--sa-t', '--sa-r', '--sa-b', '--sa-l']) de.style.removeProperty(k);
    }
    T.rotN = (T.rotN || 0) + 1;
    // 这次会话里记住（选完职业、读档会重载页面，重载后手机还竖着就接着转）；真横过来退出时清掉
    try {
      if (dir) sessionStorage.setItem(ROT_KEY, dir);
      else sessionStorage.removeItem(ROT_KEY);
    } catch (e) {
      /* 隐私模式 */
    }
    layout();
    window.dispatchEvent(new Event('resize')); // 画布、叠加层、面板按新的画面尺寸重排（world.js / ui.js 听 resize）
    return !!dir;
  }
  function flipRot() {
    if (G.rot) setRot(G.rot.dir === 'cw' ? 'ccw' : 'cw');
  }
  // 「横屏开始」：先试真横屏（全屏 + 锁横屏，要在点击里直接调）；不支持、被拒绝，或者说锁住了画面却还是竖的，就转 90° 画
  function goLandscape() {
    if (!T.on || window.innerWidth > window.innerHeight) return Promise.resolve('land');
    if (G.rot) return Promise.resolve(G.rot.dir);
    const fallback = () => {
      if (window.innerWidth > window.innerHeight) return 'land';
      setRot(pickDir());
      return G.rot ? G.rot.dir : null;
    };
    let p = null;
    try {
      const de = document.documentElement;
      const full = !document.fullscreenElement && de.requestFullscreen ? de.requestFullscreen({ navigationUI: 'hide' }) : null;
      const so = window.screen && screen.orientation;
      if (so && so.lock) p = Promise.resolve(full).then(() => so.lock('landscape'));
    } catch (e) {
      p = null;
    }
    T.rotTry = p ? 'lock' : 'none';
    if (!p) return Promise.resolve(fallback());
    return p.then(
      () => new Promise((res) => setTimeout(() => res(fallback()), 700)),
      () => fallback()
    );
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
    if (G.rot) placeRot(); // 旋转横屏：屏幕尺寸变了（工具栏伸缩）就重新摆
    document.documentElement.style.setProperty('--app-h', Math.round(G.rot ? G.viewH() : vv && vv.height > 0 ? vv.height : window.innerHeight) + 'px');
    const s = safe();
    const k = MM_SIZE / ((W.minimapInfo && W.minimapInfo().size) || 172);
    W.mmTouch = { x: G.viewW() - s.r - 8 - MM_SIZE, y: Math.max(s.t, 4) + 6, k }; // 顶上留 4 px：和右边的 12 px 一起躲开圆角（同顶栏的 --sa-t4）
    T.portrait = G.viewH() > G.viewW(); // 画面是竖的（旋转横屏时画面是横的）
    const c = document.documentElement.classList;
    c.toggle('t-portrait', T.portrait);
    c.toggle('t-land', !T.portrait); // 画面是横的：真横屏或者旋转横屏（给面板布局用）
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
  function fighting() {
    const P = G.player, st = G.state;
    if (st.boss && st.boss.awake && !st.boss.dead) return true;
    for (const e of st.enemies) if (e.awake && !e.dead && Math.hypot(e.x - P.x, e.z - P.z) < 8) return true;
    return false;
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
    if (G.rot && window.innerWidth > window.innerHeight) setRot(null); // 手机真的横过来了：退出旋转横屏
    if (G.rot) {
      const ti = document.getElementById('title');
      document.documentElement.classList.toggle('t-tsub', !!(ti && ti.classList.contains('sub'))); // 标题画面在子页上：右上角让给「返回」
    }
    if (T.portrait !== G.viewH() > G.viewW()) layout();
    dom.portrait.classList.toggle('on', T.portrait);
    // 触屏下开场卡片讲的就是触屏操作（swapIntro）：它弹过，首次提示卡就不再弹，不然同一套操作连讲两遍。
    // 卡片一打开就记下（不等点「开始」）：开着卡片刷新页面，回来也不会补弹提示卡
    if (!introSeen && dom.intro && dom.intro.classList.contains('on')) {
      introSeen = true;
      lsSet(HINT_KEY, '1');
    }
    // 首次提示卡：第一次真正进到游戏画面（开场卡片、故事、标题都收起）时弹一次，每台设备一次；
    // 只给没弹开场卡片的人（这台设备上的老角色、别的角色看过开场卡片的新角色）
    if (!T.hintOn && !introSeen && G.state.zone && !G.ui.isOpen() && !T.portrait && lsGet(HINT_KEY) !== '1') {
      T.hintOn = true;
      dom.hint.classList.add('on');
    }
    const was = T.blocked;
    T.blocked = T.portrait || !!T.hintOn;
    if (T.blocked && !was) releaseAll();
    if (G.ui.isOpen() || T.blocked) {
      if (btns.size || stick) releaseAll();
      vb.life = -1;
    } else {
      vibeWatch(now);
      // 按住主攻 / 普攻（没拖动）：每 0.25 秒重新选一次目标，目标死了立刻换
      for (const b of btns.values()) {
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
    if (lp && lp.stuck && !G.ui.isOpen()) lpCancel(); // 面板关了：留着的详情浮窗收起
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
    // 打起来了（首领醒着，或 8 m 内有醒着的敌人）：提示卡亮了 4 秒后收成一行、变淡，不盖着战斗；点一下照样展开
    const co = document.getElementById('coach');
    if (co) {
      const shown = co.classList.contains('on');
      if (!shown || co.dataset.hint !== dom.coHint) {
        dom.coHint = co.dataset.hint;
        dom.coT = 0;
      }
      if (shown && !co.classList.contains('t-min')) {
        dom.coT = fighting() ? (dom.coT || 0) + dt : 0;
        if (dom.coT >= 4) co.classList.add('t-min');
      }
    }
    // 首领条出来时提示卡往下让（两者都在顶栏下方居中）
    const boss = document.getElementById('boss-box');
    const bon = !!(boss && boss.classList.contains('on'));
    if (bon !== dom.bossOn) {
      dom.bossOn = bon;
      document.documentElement.classList.toggle('t-boss', bon);
    }
  }

  // 调试 / 测试读
  T.state = () => ({
    on: T.on,
    mode: T.mode,
    blocked: T.blocked,
    portrait: T.portrait,
    hint: !!T.hintOn,
    stick: stick && stick.on && input.move ? { a: Math.atan2(input.move.z, input.move.x), k: input.move.k } : null, // 屏幕坐标里的角度（右 = 0，顺时针为正）和速度比例
    held: Array.from(btns.values()).map((b) => ({ slot: b.slot, drag: b.drag, held: b.held })),
    aim: input.aim ? { x: input.aim.x, z: input.aim.z } : null,
    f: !!(dom && dom.fOn),
    labels: labelsOn,
    lp: lp ? (lp.stuck ? 'stuck' : lp.on ? 'on' : 'wait') : '',
    prefs: Object.assign({}, T.prefs),
    rot: G.rot ? G.rot.dir : null,
    view: [G.viewW(), G.viewH()],
    vibe: { can: canVibe(), n: vb.n, log: vb.log.slice() },
    lpCount: T.lpCount || 0,
    txt: { calls: txtStats.calls, ms: +txtStats.ms.toFixed(2) },
  });
  T.keys = { MODE_KEY, HINT_KEY, SIZE_KEY, MIRROR_KEY, VIBE_KEY };
  T.setRot = setRot; // 测试用
  T.goLandscape = goLandscape;

  const init = () => {
    if (want()) enable();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
