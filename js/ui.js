'use strict';
// 界面：HUD、面板（背包 / 技能 / 天赋 / 地图 / 帮助）、悬浮提示、飘字提示、音效合成
(function () {
  const G = window.G;

  // ============================================================
  // 小工具
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const hexCss = (n) => '#' + n.toString(16).padStart(6, '0');
  const fmt1 = (v) => String(Math.round(v * 10) / 10);
  const fmtInt = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const signed = (v) => (v >= 0 ? '+' : '') + fmt1(v);
  const IC = G.icons;
  // 带稀有度底框的物品图标
  const ibox = (inner, cls) => '<span class="ibox' + (cls ? ' ' + cls : '') + '">' + inner + '</span>';
  const itemIcon = (item, cls) => ibox(IC.item(item), 'r' + item.rarity + (cls ? ' ' + cls : ''));

  const KEY_LABEL = ['左键', '右键', 'Q', 'E'];
  // 卡片上的标签行：「召唤」紧挨着「召唤物」是重复的说法（1280 宽时还会把标签行挤成两行），卡片上不显示
  const cardTags = (sk) => (sk.tags.indexOf('minion') >= 0 ? sk.tags.filter((t) => t !== 'summon') : sk.tags);
  const TABS = [
    ['inv', '背包', 'I'],
    ['skills', '技能', 'G'],
    ['tree', '天赋', 'P'],
    ['map', '地图', 'M'],
    ['help', '帮助', 'H'],
  ];
  const ARM_INFO = {
    s: { name: '铸躯', hint: '生命 · 护甲 · 物理' },
    d: { name: '迅影', hint: '速度 · 暴击 · 机动' },
    i: { name: '秘识', hint: '魔力 · 元素 · 范围' },
    m: { name: '统御', hint: '召唤物 · 数量 · 魔力' },
  };
  const ARM_ORDER = ['s', 'd', 'i', 'm'];
  const KIND_NAME = { small: '小型天赋', notable: '核心天赋', keystone: '基石天赋', start: '起点' };
  const ALLY = G.icons.ally || '#4fe3c8'; // 友方召唤物的青色（与世界里的血条、地面圈同色）
  const MINION_STATS = ['minionDmg', 'minionLife', 'minionSpeed', 'minionCap', 'minionMore'];
  const MINION_NAME = { thrall: '烬骸仆从', colossus: '石誓守像' };
  const ZONE_GLYPH = { ash: '烬', frost: '霜', storm: '雷', abyss: '渊' };
  const ZONE_ORD = ['第一境', '第二境', '第三境', '第四境', '第五境', '第六境'];

  // ============================================================
  // 音效：WebAudio 小合成器（首次用户操作时才创建；任何失败都静默）
  // ============================================================
  const NO_P = {};
  let actx = null;
  let master = null;
  let noiseBuf = null;
  const lastPlay = {};
  const MIN_GAP = { hit: 55, crit: 70, cast: 60, hurt: 120, pickup: 60, click: 30, roll: 100, heart: 300, deny: 160, ready: 120, drop: 80, impact: 40, swing: 70, finisher: 150, break: 200, execute: 200, execstart: 200, kill: 70 };

  function audioInit() {
    try {
      if (actx) {
        if (actx.state === 'suspended') actx.resume();
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.2;
      const comp = actx.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(actx.destination);
      noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    } catch (e) {
      actx = null;
    }
  }
  window.addEventListener('pointerdown', audioInit, true);
  window.addEventListener('keydown', audioInit, true);

  function env(g, t0, dur, vol, attack) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }
  // 单个振荡器音：频率 f0 → f1 滑动
  function tone(type, f0, f1, t0, dur, vol, attack) {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    env(g, t0, dur, vol, attack);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }
  // 滤波噪声：滤波频率 f0 → f1 扫动
  function noise(ftype, f0, f1, t0, dur, vol, q, attack) {
    const s = actx.createBufferSource();
    const f = actx.createBiquadFilter();
    const g = actx.createGain();
    s.buffer = noiseBuf;
    s.loop = true;
    f.type = ftype;
    f.Q.value = q || 0.8;
    f.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    env(g, t0, dur, vol, attack);
    s.connect(f);
    f.connect(g);
    g.connect(master);
    s.start(t0, Math.random() * 0.6);
    s.stop(t0 + dur + 0.03);
  }

  const SFX = {
    cast(t) {
      noise('bandpass', 500, 2600, t, 0.14, 0.35, 1.4, 0.02);
      tone('sine', 300, 620, t, 0.12, 0.18);
    },
    hit(t) {
      noise('lowpass', 1800, 300, t, 0.07, 0.55);
      tone('square', 170, 80, t, 0.07, 0.16);
    },
    crit(t) {
      noise('lowpass', 3200, 400, t, 0.1, 0.6);
      tone('square', 220, 70, t, 0.11, 0.2);
      tone('triangle', 1320, 660, t + 0.01, 0.2, 0.3);
    },
    hurt(t) {
      tone('sawtooth', 170, 62, t, 0.24, 0.42);
      noise('lowpass', 900, 180, t, 0.18, 0.45);
    },
    pickup(t) {
      tone('sine', 700, 700, t, 0.07, 0.3);
      tone('sine', 1050, 1050, t + 0.06, 0.1, 0.3);
    },
    gem(t) {
      tone('triangle', 784, 784, t, 0.14, 0.3);
      tone('triangle', 1047, 1047, t + 0.08, 0.14, 0.3);
      tone('triangle', 1568, 1568, t + 0.16, 0.3, 0.3);
      tone('sine', 3136, 3136, t + 0.16, 0.35, 0.08);
    },
    level(t) {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => {
        tone('triangle', f, f, t + i * 0.09, 0.3, 0.3);
        tone('sine', f * 2, f * 2, t + i * 0.09, 0.3, 0.1);
      });
      tone('triangle', 1319, 1319, t + 0.4, 0.7, 0.28, 0.02);
      noise('highpass', 5000, 9000, t + 0.36, 0.5, 0.08, 0.7, 0.05);
    },
    death(t) {
      tone('sawtooth', 220, 48, t, 1.1, 0.4, 0.02);
      tone('sine', 110, 36, t, 1.3, 0.5, 0.02);
      noise('lowpass', 1200, 90, t, 1.0, 0.35, 0.8, 0.03);
    },
    boss(t) {
      tone('sawtooth', 55, 52, t, 1.5, 0.4, 0.2);
      tone('sawtooth', 58.3, 55, t, 1.5, 0.4, 0.2);
      tone('sine', 110, 82, t + 0.1, 1.3, 0.3, 0.3);
      noise('lowpass', 200, 900, t, 1.2, 0.25, 0.8, 0.5);
    },
    click(t) {
      tone('square', 1500, 900, t, 0.03, 0.09, 0.002);
    },
    craft(t) {
      tone('triangle', 1320, 1320, t, 0.3, 0.3);
      tone('triangle', 1980, 1980, t + 0.03, 0.34, 0.2);
      tone('sine', 2640, 2640, t + 0.06, 0.4, 0.1);
      noise('highpass', 6000, 6000, t, 0.04, 0.2);
    },
    roll(t) {
      noise('bandpass', 1400, 320, t, 0.22, 0.4, 1.0, 0.03);
    },
    // 濒死心跳：咚-咚
    heart(t) {
      tone('sine', 82, 44, t, 0.16, 0.9, 0.008);
      tone('sine', 70, 40, t + 0.21, 0.2, 0.7, 0.008);
      noise('lowpass', 160, 60, t, 0.1, 0.3, 0.7, 0.005);
    },
    // 技能放不出来：闷闷的一声
    deny(t) {
      tone('square', 150, 96, t, 0.09, 0.16, 0.004);
      tone('square', 118, 80, t + 0.07, 0.11, 0.13, 0.004);
    },
    // 冷却结束
    ready(t) {
      tone('triangle', 1180, 1180, t, 0.09, 0.12, 0.004);
      tone('sine', 1770, 1770, t + 0.04, 0.16, 0.1, 0.004);
    },
    // 放下 / 丢下物品
    drop(t) {
      noise('lowpass', 900, 220, t, 0.09, 0.4, 0.8, 0.004);
      tone('sine', 190, 110, t, 0.1, 0.22, 0.004);
    },
    // ---- 打击感 ----
    // 挥砍的破空声：三段一段比一段沉，终结技拖得更长
    swing(t, p) {
      const s = p.step || 0;
      const v = 0.92 + Math.random() * 0.16;
      if (s >= 2) {
        noise('bandpass', 380 * v, 2400 * v, t, 0.27, 0.42, 1.1, 0.13);
        tone('sine', 150, 70, t + 0.12, 0.16, 0.2);
      } else {
        noise('bandpass', (900 - s * 200) * v, (2600 - s * 500) * v, t, 0.13, 0.3, 1.3, 0.03);
      }
    },
    // 命中：一层闷响打底，再叠一层随伤害类型变化的音色；分量越重越低沉、越长，每次音高略有浮动
    impact(t, p) {
      const w = p.w || 0;
      const v = 0.9 + Math.random() * 0.2;
      const ty = p.type || 'phys';
      noise('lowpass', 1900 * v, 280, t, 0.07 + w * 0.03, 0.55 + w * 0.08);
      tone('square', (175 - w * 20) * v, 78 - w * 8, t, 0.07 + w * 0.03, 0.17);
      if (w >= 1) tone('sine', 120 * v, 44, t, 0.17 + w * 0.05, 0.55);
      if (ty === 'fire') {
        // 火：一声闷燃
        noise('bandpass', 950 * v, 260, t, 0.17, 0.34, 0.9, 0.012);
        tone('sawtooth', 140 * v, 62, t, 0.13, 0.12);
      } else if (ty === 'cold') {
        // 冰：清脆的碎裂
        tone('triangle', 2500 * v, 1750, t, 0.09, 0.2, 0.002);
        tone('sine', 3700 * v, 3000, t + 0.015, 0.07, 0.1, 0.002);
        noise('highpass', 5200, 7000, t, 0.05, 0.16);
      } else if (ty === 'light') {
        // 电：短促的噼啪
        tone('square', 1900 * v, 260, t, 0.07, 0.13, 0.002);
        noise('highpass', 4200, 2400, t, 0.06, 0.2);
      } else {
        // 物理：金属磕碰
        tone('triangle', 920 * v, 480, t, 0.05, 0.14, 0.002);
        noise('bandpass', 3200 * v, 2200, t, 0.04, 0.16, 2);
      }
      if (p.crit) {
        tone('triangle', 1320 * v, 660, t + 0.01, 0.2, 0.3);
        tone('sine', 2640 * v, 1980, t + 0.02, 0.12, 0.1);
      }
    },
    // 终结技砸中：低频轰一下，碎石落地
    finisher(t) {
      tone('sine', 92, 36, t, 0.34, 0.95, 0.004);
      tone('square', 150, 48, t, 0.2, 0.2, 0.003);
      noise('lowpass', 2600, 180, t, 0.27, 0.7, 0.8, 0.004);
      noise('highpass', 2800, 5200, t + 0.1, 0.22, 0.12, 0.7, 0.03);
    },
    // 架势被打空：一声碎裂 + 钟鸣
    break(t) {
      tone('triangle', 1560, 310, t, 0.26, 0.34, 0.003);
      noise('highpass', 7000, 2000, t, 0.3, 0.3, 0.8, 0.003);
      tone('sine', 74, 40, t, 0.5, 0.75, 0.006);
      tone('triangle', 660, 655, t + 0.03, 0.7, 0.2, 0.01);
      tone('sine', 990, 985, t + 0.03, 0.5, 0.09, 0.01);
    },
    // 处决起手：空气被吸进去
    execstart(t) {
      noise('bandpass', 300, 3200, t, 0.3, 0.36, 1.2, 0.24);
      tone('sine', 220, 520, t, 0.28, 0.12, 0.2);
    },
    // 处决命中：利刃 + 重击 + 余音
    execute(t) {
      noise('bandpass', 4200, 600, t, 0.13, 0.5, 1.4, 0.003);
      tone('sine', 104, 30, t + 0.015, 0.55, 1.0, 0.004);
      tone('sawtooth', 220, 52, t + 0.015, 0.34, 0.3, 0.004);
      noise('lowpass', 2400, 120, t + 0.015, 0.4, 0.6, 0.8, 0.004);
      tone('triangle', 880, 880, t + 0.16, 0.6, 0.16, 0.01);
      tone('triangle', 1320, 1320, t + 0.22, 0.7, 0.13, 0.01);
    },
    // 敌人倒下：一声闷破；按致命伤害的类型收尾，精英 / 首领更沉
    kill(t, p) {
      const v = (p.big ? 0.7 : 1) * (0.92 + Math.random() * 0.16);
      const ty = p.type || 'phys';
      tone('square', 250 * v, 58 * v, t, p.big ? 0.26 : 0.15, 0.2, 0.003);
      noise('lowpass', 1500 * v, 200, t, p.big ? 0.3 : 0.16, 0.4, 0.8, 0.004);
      if (ty === 'fire') noise('bandpass', 700, 2200, t + 0.03, 0.26, 0.2, 0.9, 0.06);
      else if (ty === 'cold') {
        tone('triangle', 3100 * v, 1500, t + 0.02, 0.16, 0.16, 0.002);
        noise('highpass', 6000, 3000, t + 0.02, 0.2, 0.2);
      } else if (ty === 'light') tone('square', 2400 * v, 180, t + 0.01, 0.12, 0.1, 0.002);
      else noise('bandpass', 420, 180, t + 0.04, 0.2, 0.3, 0.9, 0.02);
    },
  };

  // p（可选）：给音效的参数（命中的伤害类型 / 分量 / 是否暴击，挥砍的段数……）
  G.sfx = function (name, p) {
    if (!actx || actx.state !== 'running') return;
    const fn = SFX[name];
    if (!fn) return;
    const now = performance.now();
    if (now - (lastPlay[name] || 0) < (MIN_GAP[name] || 45)) return; // 同名音效限流，避免同帧叠成一声巨响
    lastPlay[name] = now;
    try {
      fn(actx.currentTime + 0.004, p || NO_P);
    } catch (e) {
      /* 静默 */
    }
  };

  // ============================================================
  // 界面状态
  // ============================================================
  const ui = {
    isOpen: false,
    tab: 'inv',
    sel: null, // 背包页选中的物品 uid
    invMsg: '',
    flash: false, // 下一次渲染让详情卡闪一下（通货改造成功）
    lastSel: { uid: null, t: 0 }, // 自己判定双击，避免重渲染后原生 dblclick 丢失
    picker: null, // { skill, idx } 正在选辅助宝石的插槽
    treeMsg: '',
    restored: {}, // render() 写回的滚动位置：data-scroll → { node, top }
    treeMsgBad: false,
    resetArmed: false,
    resetTimer: 0,
    blankArm: null, // 无铭技能宝石：点了第一下、等着确认的技能 id（再点一次才真的用掉）
    blankTimer: 0,
    blankMsg: '', // 技能页顶部的一行结果（刚用无铭宝石学会 / 升级了什么）
    mapTier: 0,
    delArmed: false,
    tipEl: null,
    mouseX: -1,
    mouseY: -1,
    overCanvas: false, // 鼠标正停在游戏画面上（不是面板 / HUD 按钮）
    intro: false, // 开场卡片开着（此时游戏暂停，isOpen() 也算打开）
    fresh: new Set(), // 刚拾到、还没看过的物品 uid
    bagMsg: '', // 背包页底部的一行结果（一键分解的收获等）
    confirm: null, // { uid, x, y } 正在确认丢弃的稀有物品
    salvArm: { uid: null, t: 0 }, // Shift+点击分解稀有物品：第一次点击只是上膛
    noClick: false, // 拖拽松手时浏览器紧跟着派发的那一次 click 不算数
    groundLoot: null, // 鼠标正指着的地面掉落
    groundSig: '',
    hoverEnemy: null,
  };

  const el = {}; // 常用 DOM 引用
  const hud = {}; // HUD 缓存：只在数值变化时写 DOM

  // ============================================================
  // HUD
  // ============================================================
  function initHud() {
    const slotsEl = $('slots');
    hud.slots = [];
    for (let i = 0; i < 4; i++) {
      const d = document.createElement('div');
      d.className = 'slot empty';
      d.innerHTML =
        '<div class="s-icon"><i class="s-img ico"></i><div class="s-cd"></div><span class="s-cdnum"></span></div>' +
        '<div class="s-key">' + KEY_LABEL[i] + '</div><div class="s-bubble"></div><div class="s-combo"><i></i><i></i><i></i></div>';
      slotsEl.appendChild(d);
      hud.slots.push({
        el: d,
        icon: d.querySelector('.s-icon'),
        img: d.querySelector('.s-img'),
        cd: d.querySelector('.s-cd'),
        num: d.querySelector('.s-cdnum'),
        bubble: d.querySelector('.s-bubble'),
        pips: Array.from(d.querySelectorAll('.s-combo > i')),
        lit: 0, // 连段指示：亮着几格
        id: undefined,
        cdq: 0,
        numTxt: '',
        na: false,
        casting: false,
        left: 0, // 上一帧的冷却剩余
        held: false, // 上一帧这个键是否按着
        fxT: -1e9, // 拒绝施放 / 冷却转好 的动画起点
        fx: '',
      });
    }
    const orb = (name) => ({ fill: $(name + '-fill'), num: $(name + '-num'), maxEl: $(name + '-max'), v: -1, max: -1, q: -1 });
    hud.life = orb('life');
    hud.mana = orb('mana');
    const flask = (name) => {
      const root = $('flask-' + name);
      return { root, pips: Array.from(root.querySelectorAll('.pip > i')), q: [-1, -1, -1], ready: null };
    };
    hud.flaskLife = flask('life');
    hud.flaskMana = flask('mana');
    hud.dodge = { root: $('dodge'), cd: $('dodge').querySelector('.d-cd'), q: -1 };
    hud.xp = { fill: $('xp-fill'), lv: $('xp-lv'), pct: $('xp-pct'), level: -1, need: 1, q: -1 };
    hud.zone = { name: $('zone-name'), sub: $('zone-sub'), ref: null, tier: -1 };
    hud.boss = { box: $('boss-box'), name: $('boss-name'), fill: $('boss-fill'), trail: $('boss-trail'), num: $('boss-num'), ail: $('boss-ail'), ailSig: '', on: false, ref: null, q: -1, hp: -1, poise: $('boss-poise-fill'), pq: -1, brk: false, far: false, brkTxt: $('boss-break-txt') };
    hud.combo = { el: $('combo'), num: $('combo-n'), bar: $('combo-bar'), n: 0, tier: -1, q: -1, fading: false };
    hud.low = { el: $('lowlife'), orb: document.querySelector('.orb.life'), on: false, beatT: -1e9 };
    hud.bagN = { el: $('kh-new'), n: -1 };
    hud.remind = { el: $('pp-remind'), n: -1 };
    hud.vig = { el: $('vignette'), q: 0, hurtAt: -1e9 };
    hud.death = { el: $('death'), sub: $('death').querySelector('.death-sub'), on: false };
    hud.cost = {};
    hud.costT = -1e9;
    hud.free = 0;
    // 召唤物条：生命球右边、技能栏左边的一小条，每只召唤物一个图标 + 血条；守像另有嘲讽冷却
    const mn = document.createElement('div');
    mn.id = 'minions';
    $('hud').appendChild(mn);
    hud.mn = { root: mn, chips: [], n: -1, on: false, list: [] };

    // HUD 上真正可点的按钮：快捷键提示与天赋提醒
    const hudEl = $('hud');
    hudEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) {
        e.preventDefault(); // 不抢键盘焦点，免得之后空格 / 回车误触按钮
        e.stopPropagation(); // 不当作游戏里的鼠标输入
      }
    });
    hudEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (b) {
        G.sfx('click');
        toggle(b.dataset.open);
      }
    });
  }

  function setOrb(o, cur, max) {
    const v = Math.max(0, Math.ceil(cur));
    if (v !== o.v) {
      o.v = v;
      o.num.textContent = v;
    }
    if (max !== o.max) {
      o.max = max;
      o.maxEl.textContent = '/ ' + max;
    }
    const q = max > 0 ? Math.round(G.clamp(cur / max, 0, 1) * 200) / 2 : 0; // 0.5% 精度
    if (q !== o.q) {
      o.q = q;
      o.fill.style.transform = 'translateY(' + (100 - q) + '%)';
    }
  }

  function setFlask(f, charges) {
    for (let i = 0; i < 3; i++) {
      const q = Math.round(G.clamp(charges - i, 0, 1) * 20) / 20;
      if (q !== f.q[i]) {
        f.q[i] = q;
        f.pips[i].style.transform = 'scaleY(' + q + ')';
        f.pips[i].parentNode.classList.toggle('full', q >= 1);
      }
    }
    const ready = charges >= 1;
    if (ready !== f.ready) {
      f.ready = ready;
      f.root.classList.toggle('ready', ready);
    }
  }

  function update() {
    const P = G.player;
    const S = G.save;
    const st = G.state;
    const now = performance.now();

    setOrb(hud.life, P.life, P.maxLife);
    setOrb(hud.mana, P.mana, P.maxMana);
    setFlask(hud.flaskLife, P.flask.life);
    setFlask(hud.flaskMana, P.flask.mana);

    // 翻滚冷却
    const dq = P.roll.cd > 0 && P.roll.cdMax > 0 ? Math.ceil(G.clamp(P.roll.cd / P.roll.cdMax, 0, 1) * 50) / 50 : 0;
    if (dq !== hud.dodge.q) {
      hud.dodge.q = dq;
      hud.dodge.cd.style.setProperty('--cd', dq);
      hud.dodge.root.classList.toggle('cooling', dq > 0);
    }

    // 技能消耗与天赋点：不必每帧算，约 0.4 秒刷新一次
    if (now - hud.costT > 400) {
      hud.costT = now;
      for (let i = 0; i < 4; i++) {
        const id = S.bar[i];
        if (id) hud.cost[id] = G.skillCtx(id).cost;
      }
      hud.free = G.passivePoints().free;
      // 「新」标记只对还在背包里的物品有意义（装备、分解、丢弃之后就不算了）
      if (ui.fresh.size) {
        for (const uid of Array.from(ui.fresh)) if (!S.bag.some((it) => it.uid === uid)) ui.fresh.delete(uid);
      }
    }

    // 技能栏
    const blood = P.S.bloodMagic > 0;
    for (let i = 0; i < 4; i++) {
      const s = hud.slots[i];
      const id = S.bar[i] || null;
      if (id !== s.id) {
        s.id = id;
        s.el.classList.toggle('empty', !id);
        s.el.dataset.skill = id || '';
        s.left = 0;
        if (id) {
          const sk = G.SKILLS[id];
          s.img.className = 's-img ico ' + IC.cls('sk-' + id);
          s.icon.style.setProperty('--c', sk.color);
          s.el.classList.toggle('has-combo', !!sk.combo);
          if (!(id in hud.cost)) hud.cost[id] = G.skillCtx(id).cost;
        } else {
          s.img.className = 's-img ico';
          s.el.classList.remove('has-combo');
        }
      }
      // 连段指示：正在出第几段（出手中算上这一段），窗口过了就熄灭
      let lit = 0;
      if (id && G.SKILLS[id].combo && !P.dead) {
        if (P.cast && P.cast.id === id && P.cast.st) lit = P.cast.step + 1;
        else if (P.combo.t > 0) lit = P.combo.step;
      }
      if (lit !== s.lit) {
        s.lit = lit;
        for (let k = 0; k < 3; k++) s.pips[k].className = k < lit ? 'on' : '';
      }
      let cdq = 0;
      let numTxt = '';
      let na = false;
      let left = 0;
      if (id) {
        left = P.cds[id] || 0;
        if (left > 0) {
          cdq = Math.ceil(G.clamp(left / (P.cdMax[id] || left), 0, 1) * 60) / 60;
          numTxt = left >= 1 ? String(Math.ceil(left)) : left.toFixed(1);
        }
        const cost = hud.cost[id];
        na = cost > 0 && (blood ? P.life <= cost : P.mana < cost);
      }
      // 冷却自然走完：闪一下。按下却放不出来：格子抖一下并说明原因
      const held = !st.paused && slotDown(i);
      if (id && !P.dead) {
        if (s.left > 0 && s.left < 0.3 && left <= 0) slotFx(s, 'ready', '', now);
        if (held && !s.held) {
          if (left > 0.15) slotFx(s, 'deny', '冷却中', now);
          else if (na) slotFx(s, 'deny', blood ? '生命不足' : '魔力不足', now);
        }
      }
      s.left = left;
      s.held = held;
      if (s.fx && now - s.fxT > 620) {
        s.el.classList.remove(s.fx);
        s.fx = '';
      }
      if (cdq !== s.cdq) {
        s.cdq = cdq;
        s.cd.style.setProperty('--cd', cdq);
      }
      if (numTxt !== s.numTxt) {
        if (!numTxt !== !s.numTxt) s.el.classList.toggle('cooling', !!numTxt);
        s.numTxt = numTxt;
        s.num.textContent = numTxt;
      }
      if (na !== s.na) {
        s.na = na;
        s.el.classList.toggle('na', na);
      }
      const casting = !!(P.cast && P.cast.slot === i);
      if (casting !== s.casting) {
        s.casting = casting;
        s.el.classList.toggle('casting', casting);
      }
    }

    // 经验条
    const x = hud.xp;
    if (S.level !== x.level) {
      x.level = S.level;
      x.need = G.xpNeed(S.level);
      x.lv.textContent = '等级 ' + S.level;
    }
    const xq = Math.round(G.clamp(S.xp / x.need, 0, 1) * 500) / 5;
    if (xq !== x.q) {
      x.q = xq;
      x.fill.style.transform = 'scaleX(' + xq / 100 + ')';
      x.pct.textContent = Math.floor(xq) + '%';
    }

    // 区域信息
    const z = hud.zone;
    if (st.zone !== z.ref || st.tier !== z.tier) {
      z.ref = st.zone;
      z.tier = st.tier;
      z.name.textContent = st.zone.def.name;
      z.sub.innerHTML =
        '怪物等级 <b>' + st.zone.level + '</b><i></i>轮回层级 <b>' + st.tier + '</b>';
    }

    // 首领血条
    const b = st.boss;
    const hb = hud.boss;
    const bossOn = !!(b && b.awake && !b.dead);
    if (bossOn !== hb.on) {
      hb.on = bossOn;
      hb.box.classList.toggle('on', bossOn);
      if (bossOn) G.sfx('boss');
    }
    if (bossOn) {
      if (b !== hb.ref) {
        hb.ref = b;
        hb.name.textContent = b.name;
        hb.q = -1;
      }
      const bq = Math.round(G.clamp(b.hp / b.maxHp, 0, 1) * 1000) / 1000;
      if (bq !== hb.q) {
        hb.q = bq;
        hb.fill.style.transform = 'scaleX(' + bq + ')';
        hb.trail.style.transform = 'scaleX(' + bq + ')';
      }
      const hp = Math.max(0, Math.ceil(b.hp));
      if (hp !== hb.hp) {
        hb.hp = hp;
        hb.num.textContent = fmtInt(hp) + ' / ' + fmtInt(b.maxHp);
      }
      const enr = !!b.enraged;
      if (enr !== hb.enr) {
        hb.enr = enr;
        hb.box.classList.toggle('enraged', enr);
      }
      const asig = ailSig(b);
      if (asig !== hb.ailSig) {
        hb.ailSig = asig;
        hb.ail.innerHTML = ailHtml(b, false);
      }
      // 架势条：平时是剩余架势；破绽中变成金色，随破绽时间缩短
      const brk = b.brokenT > 0 && !b.executed; // 处决过之后只是在爬起来，不再提示
      if (brk !== hb.brk) {
        hb.brk = brk;
        hb.box.classList.toggle('broken', brk);
      }
      // 够不着的时候和头顶的提示说同一句话：「靠近处决」
      const bfar = brk && !G.execReach(b);
      if (bfar !== hb.far) {
        hb.far = bfar;
        hb.box.classList.toggle('far', bfar);
        hb.brkTxt.textContent = bfar ? '靠近处决' : '处决';
      }
      const pq = Math.round(G.clamp(brk ? b.brokenT / (b.brokenMax || 1) : b.poiseMax > 0 ? b.poise / b.poiseMax : 0, 0, 1) * 250) / 250;
      if (pq !== hb.pq) {
        hb.pq = pq;
        hb.poise.style.transform = 'scaleX(' + pq + ')';
      }
    } else {
      hb.ref = null;
      if (hb.brk) {
        hb.brk = false;
        hb.box.classList.remove('broken');
      }
    }

    // 连击计数：连续命中 2 次起显示，数字每涨一次弹一下；最后 0.8 秒变淡，断了就收起
    const cb = hud.combo;
    const cn = P.dead ? 0 : P.chain.n;
    if (cn !== cb.n) {
      if (cn >= 2 && cn > cb.n) {
        cb.num.textContent = cn;
        const tier = cn >= 50 ? 3 : cn >= 25 ? 2 : cn >= 10 ? 1 : 0;
        cb.el.classList.remove('pop');
        void cb.el.offsetWidth; // 重新触发弹跳动画
        cb.el.className = 'on pop t' + tier;
        cb.fading = false;
      } else if (cn < 2) {
        cb.el.className = '';
        cb.fading = false;
      }
      cb.n = cn;
    }
    if (cn >= 2) {
      const cq = Math.round(G.clamp(P.chain.t / 2.5, 0, 1) * 48) / 48;
      if (cq !== cb.q) {
        cb.q = cq;
        cb.bar.style.transform = 'scaleX(' + cq + ')';
      }
      const fading = P.chain.t < 0.8;
      if (fading !== cb.fading) {
        cb.fading = fading;
        cb.el.classList.toggle('fading', fading);
      }
    }

    // 背包里还没看过的新物品数
    const bn = hud.bagN;
    if (ui.fresh.size !== bn.n) {
      bn.n = ui.fresh.size;
      bn.el.textContent = bn.n ? String(bn.n) : '';
      bn.el.classList.toggle('on', bn.n > 0);
    }

    // 未分配天赋点提醒
    const r = hud.remind;
    if (hud.free !== r.n) {
      r.n = hud.free;
      r.el.classList.toggle('on', r.n > 0);
      if (r.n > 0) r.el.innerHTML = '有 <b>' + r.n + '</b> 点天赋尚未分配<kbd>P</kbd>';
    }

    // 受伤闪红 + 濒死脉动
    const v = hud.vig;
    let op = 0;
    const hk = 1 - (now - v.hurtAt) / 480;
    if (hk > 0) op = hk * 0.9;
    const lf = P.maxLife > 0 ? P.life / P.maxLife : 1;
    const lowOn = lf < LOW_LIFE && !P.dead;
    if (lowOn) {
      const low = ((LOW_LIFE - lf) / LOW_LIFE) * 0.34 + 0.1;
      if (low > op) op = low;
    }
    op = Math.round(op * 50) / 50;
    if (op !== v.q) {
      v.q = op;
      v.el.style.opacity = op;
    }
    // 濒死警告：屏幕边缘随心跳一下一下地亮，越危险跳得越快
    const lw = hud.low;
    if (lowOn !== lw.on) {
      lw.on = lowOn;
      lw.el.classList.toggle('on', lowOn);
      lw.orb.classList.toggle('low', lowOn);
      if (!lowOn) lw.el.classList.remove('beat');
    }
    if (lowOn && !st.paused && now - lw.beatT > 620 + (lf / LOW_LIFE) * 520) {
      lw.beatT = now;
      lw.el.classList.remove('beat');
      void lw.el.offsetWidth; // 重新触发一次脉冲动画
      lw.el.classList.add('beat');
      G.sfx('heart');
    }

    // 死亡遮罩
    const dead = !!P.dead;
    if (dead !== hud.death.on) {
      hud.death.on = dead;
      hud.death.el.classList.toggle('on', dead);
      if (dead) hud.death.sub.textContent = P.respawnAt ? '余烬未冷 · 即将在首领的竞技场门外重燃' : '余烬未冷 · 即将在区域入口重燃';
    }

    updateMinionBar();
    updateWorldUi(now);
    updateCoach(now);
  }

  // ---------- 召唤物条 ----------
  // 守像排最前，其余按召唤的先后；格子复用，只在数值变化时写 DOM
  function mnChip(i) {
    const m = hud.mn;
    let c = m.chips[i];
    if (c) return c;
    const d = document.createElement('div');
    d.className = 'mn';
    d.innerHTML = '<div class="mn-icon"><i class="ico"></i><b class="mn-t"></b></div><div class="mn-hp"><i></i></div><div class="mn-tc"><i></i></div>';
    m.root.appendChild(d);
    c = { el: d, img: d.querySelector('.ico'), hp: d.querySelector('.mn-hp > i'), tc: d.querySelector('.mn-tc > i'), tTxt: d.querySelector('.mn-t'), kind: '', q: -1, low: null, tq: -1, tn: '', ready: null, rise: null, on: false };
    m.chips.push(c);
    return c;
  }
  function updateMinionBar() {
    const m = hud.mn;
    const src = liveMinions();
    const list = m.list;
    list.length = 0;
    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      if (x && !x.dead && x.kind === 'colossus') list.push(x);
    }
    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      if (x && !x.dead && x.kind !== 'colossus') list.push(x);
    }
    const on = list.length > 0 && !G.player.dead;
    if (on !== m.on) {
      m.on = on;
      m.root.classList.toggle('on', on);
    }
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      const c = mnChip(i);
      const kind = x.kind === 'colossus' ? 'colossus' : 'thrall';
      if (!c.on || c.kind !== kind) {
        c.on = true;
        c.kind = kind;
        c.el.className = 'mn ' + kind;
        const sid = x.skill && G.SKILLS[x.skill] ? x.skill : kind;
        c.img.className = 'ico ' + (G.SKILLS[sid] ? IC.cls('sk-' + sid) : '');
        c.q = c.tq = -1;
        c.tn = '';
        c.ready = c.low = c.rise = null;
      }
      const f = x.maxHp > 0 ? G.clamp(x.hp / x.maxHp, 0, 1) : 0;
      const q = Math.round(f * 50) / 50;
      if (q !== c.q) {
        c.q = q;
        c.hp.style.transform = 'scaleX(' + q + ')';
      }
      const low = f < 0.35;
      if (low !== c.low) {
        c.low = low;
        c.el.classList.toggle('low', low);
      }
      const rise = x.rising > 0;
      if (rise !== c.rise) {
        c.rise = rise;
        c.el.classList.toggle('rise', rise);
      }
      if (kind === 'colossus') {
        // 嘲讽：冷却中时条从空涨到满、角上写剩余秒数；转好时角标亮起
        const max = x.tauntCdMax > 0 ? x.tauntCdMax : 0;
        const left = Math.max(0, x.tauntCd || 0);
        const tq = max > 0 ? Math.round((1 - G.clamp(left / max, 0, 1)) * 40) / 40 : 1;
        if (tq !== c.tq) {
          c.tq = tq;
          c.tc.style.transform = 'scaleX(' + tq + ')';
        }
        const ready = left <= 0.05;
        if (ready !== c.ready) {
          c.ready = ready;
          c.el.classList.toggle('ready', ready);
        }
        const tn = ready ? '嘲' : String(Math.ceil(left));
        if (tn !== c.tn) {
          c.tn = tn;
          c.tTxt.textContent = tn;
        }
      }
    }
    for (let i = list.length; i < m.chips.length; i++) {
      const c = m.chips[i];
      if (c.on) {
        c.on = false;
        c.kind = '';
        c.el.className = 'mn off';
      }
    }
  }

  function hurt() {
    hud.vig.hurtAt = performance.now();
  }

  const LOW_LIFE = 0.35;
  // 技能栏第 i 格对应的输入此刻是否按着（与 game.js 的判定一致，不含按键缓冲）
  function slotDown(i) {
    const inp = G.input;
    if (i === 0) return inp.mouse.b[0];
    if (i === 1) return inp.mouse.b[2];
    return !!inp.keys[i === 2 ? 'KeyQ' : 'KeyE'];
  }
  function slotFx(s, kind, text, now) {
    if (s.fx) s.el.classList.remove(s.fx);
    void s.el.offsetWidth;
    s.fx = kind;
    s.fxT = now;
    s.bubble.textContent = text;
    s.el.classList.add(kind);
    G.sfx(kind);
  }

  // 敌人身上的异常状态
  const AIL_NAME = { burn: '点燃', chill: '冰缓', freeze: '冻结', shock: '感电', stun: '眩晕' };
  function ailList(e) {
    const out = [];
    if (e.burnT > 0 && e.burn > 0) out.push('burn');
    if (e.freeze > 0) out.push('freeze');
    else if (e.chill > 0) out.push('chill');
    if (e.shock > 0) out.push('shock');
    if (e.stunT > 0) out.push('stun');
    return out;
  }
  const ailSig = (e) => ailList(e).join(',');
  function ailHtml(e, named) {
    return ailList(e).map((a) => '<span class="ail ' + a + '">' + IC.ail(a) + (named ? AIL_NAME[a] : '') + '</span>').join('');
  }

  // ============================================================
  // 飘字提示（toast）
  // ============================================================
  let lastToast = { msg: '', t: 0 };
  // icon：可选的图标 HTML（G.icons.* 的返回值），显示在文字前面
  function toast(msg, color, icon) {
    const box = el.toasts || (el.toasts = $('toasts'));
    const now = performance.now();
    if (msg === lastToast.msg && now - lastToast.t < 500) return; // 同一句话短时间内不重复刷
    lastToast = { msg, t: now };
    const d = document.createElement('div');
    d.className = 'toast';
    if (icon) {
      d.classList.add('has-icon');
      d.innerHTML = icon;
      d.appendChild(document.createTextNode(msg));
    } else {
      d.textContent = msg;
    }
    if (color) d.style.setProperty('--c', color);
    box.appendChild(d);
    while (box.children.length > 5) box.removeChild(box.firstChild);
    setTimeout(() => d.classList.add('out'), 2400);
    setTimeout(() => {
      if (d.parentNode) d.parentNode.removeChild(d);
    }, 2900);
  }

  // ============================================================
  // 物品相关的 HTML 片段
  // ============================================================
  function findItem(uid) {
    const S = G.save;
    for (const it of S.bag) if (it.uid === uid) return { item: it, equipped: false };
    for (const slot of G.SLOTS) {
      const it = S.equip[slot];
      if (it && it.uid === uid) return { item: it, equipped: true };
    }
    return null;
  }

  // ============================================================
  // 换装评估：把物品临时换上身算一遍，再原样换回来
  // ============================================================
  const NOOP = function () {};
  const VD_TTL = 700; // 毫秒；地面名牌每帧都会问，面板重渲染时整体清空
  const vdCache = new Map(); // uid → { t, v }

  function statSnap() {
    const P = G.player;
    const save = G.save;
    const dps = {};
    for (let i = 0; i < 4; i++) {
      const id = save.bar[i];
      if (!id || dps[id] !== undefined || !G.SKILLS[id] || !save.skills[id]) continue;
      const ctx = G.skillCtx(id);
      dps[id] = G.skillDps(ctx);
    }
    return {
      dps, life: P.maxLife, mana: P.maxMana, armour: P.armour,
      rf: P.res.fire, rc: P.res.cold, rl: P.res.light, res: P.res.fire + P.res.cold + P.res.light,
      move: P.moveSpeed, regen: P.lifeRegen,
    };
  }
  // 粗略的「有效生命」：一半按物理（护甲对一次典型攻击的减免），一半按三种元素平均
  function effLife(s) {
    const hit = 9 * G.dmgScale(G.state.zone ? G.state.zone.level : G.save.level);
    const red = Math.min(0.8, s.armour / (s.armour + 10 * hit));
    const el3 = (1 / (1 - s.rf / 100) + 1 / (1 - s.rc / 100) + 1 / (1 - s.rl / 100)) / 3;
    return s.life * (0.5 / (1 - red) + 0.5 * el3);
  }

  // 返回 { badge: 'up' | 'down' | 'eq', score, empty, lines: [{ label, text, pct, good }] }；
  // 物品正穿在身上时返回 null。不改存档，也不改当前生命 / 魔力。
  function verdict(item) {
    const save = G.save;
    const P = G.player;
    const slot = item.slot;
    const cur = save.equip[slot];
    if (cur === item || (cur && cur.uid === item.uid)) return null;
    const now = performance.now();
    const hit = vdCache.get(item.uid);
    if (hit && now - hit.t < VD_TTL) return hit.v;

    const life = P.life;
    const mana = P.mana;
    const had = Object.prototype.hasOwnProperty.call(save.equip, slot);
    const a = statSnap();
    let b;
    // computeStats 会顺手让角色手里的武器模型跟着装备换；试算期间不该动模型，先把那个调用架空
    const W = G.world;
    const gear = W.setPlayerGear;
    W.setPlayerGear = NOOP;
    try {
      save.equip[slot] = item;
      G.computeStats();
      b = statSnap();
    } finally {
      if (had) save.equip[slot] = cur;
      else delete save.equip[slot];
      G.computeStats();
      P.life = life;
      P.mana = mana;
      W.setPlayerGear = gear;
    }

    const lines = [];
    let off = 0;
    let nOff = 0;
    let faint = false; // 有变化，但小到不值得单列一行
    for (const id in a.dps) {
      const d = b.dps[id] - a.dps[id];
      const pct = a.dps[id] > 0 ? (d / a.dps[id]) * 100 : null;
      if (pct !== null) {
        off += pct;
        nOff++;
      }
      // 秒伤变化不到 0.5% 的不列出来（否则会出现「+0.1 +0%」这种噪音行）
      if (Math.abs(d) >= 0.05 && (pct === null || Math.abs(pct) >= 0.5)) {
        lines.push({ label: G.SKILLS[id].name + ' 秒伤', text: signed(d), pct, good: d > 0 });
      } else if (Math.abs(d) > 1e-6) faint = true;
    }
    const num = (label, d, unit, pct) => {
      if (Math.abs(d) >= 0.05) lines.push({ label, text: signed(d) + (unit || ''), pct: pct === undefined ? null : pct, good: d > 0 });
    };
    num('最大生命', b.life - a.life, '', a.life > 0 ? ((b.life - a.life) / a.life) * 100 : undefined);
    num('护甲', b.armour - a.armour);
    num('元素抗性合计', b.res - a.res, '%');
    num('最大魔力', b.mana - a.mana);
    num('移动速度', (b.move / a.move - 1) * 100, '%');
    num('生命回复', b.regen - a.regen, ' /秒');

    const ea = effLife(a);
    const def = ea > 0 ? (effLife(b) / ea - 1) * 100 : 0;
    const util = (a.mana > 0 ? (b.mana / a.mana - 1) * 15 : 0) + (b.move / a.move - 1) * 50 + (a.life > 0 ? ((b.regen - a.regen) / a.life) * 300 : 0);
    const score = (nOff ? off / nOff : 0) + def + util;
    const v = { badge: score > 0.5 ? 'up' : score < -0.5 ? 'down' : 'eq', score, empty: !cur, lines, faint };
    vdCache.set(item.uid, { t: now, v });
    return v;
  }
  const VD_GLYPH = { up: '▲', down: '▼', eq: '＝' };
  const VD_HEAD = { up: '装备后更强', down: '装备后变弱', eq: '装备后基本持平' };

  function verdictBlock(v) {
    let h = '<div class="ic-vd vd-' + v.badge + '"><div class="vd-head"><b>' + VD_GLYPH[v.badge] + '</b>' +
      (v.empty ? '这个部位还空着 · ' : '') + VD_HEAD[v.badge] + '</div>';
    if (!v.lines.length) h += '<div class="vd-line none">' + (v.faint ? '秒伤的变化不到 0.5%，可以忽略' : '与当前装备没有数值上的差别') + '</div>';
    for (const l of v.lines) {
      // 百分比不到 10% 时带一位小数，不会把 0.6% 写成「+1%」或「+0%」
      const ap = l.pct === null ? 0 : Math.abs(l.pct);
      h += '<div class="vd-line ' + (l.good ? 'good' : 'bad') + '"><span>' + l.label + '</span><b>' + l.text.replace('-', '−') + '</b>' +
        (l.pct === null ? '' : '<em>' + (l.pct >= 0 ? '+' : '−') + (ap < 9.95 ? ap.toFixed(1) : Math.round(ap)) + '%</em>') + '</div>';
    }
    return h + '</div>';
  }

  // 词缀某一阶的数值区间（与 items.js 的掷骰公式一致）
  function tierRange(def, tier) {
    const k = Math.pow(def.g, tier);
    const lo = Math.round(def.lo * k);
    return [lo, Math.max(lo, Math.round(def.hi * k))];
  }
  function maxTierFor(ilvl) {
    let t = 0;
    for (let i = 0; i < G.TIER_ILVL.length; i++) if (G.TIER_ILVL[i] <= ilvl) t = i;
    return t;
  }

  // o：{ tag 顶部角标, vd 换装评估, hint 底部操作提示, affTips 词缀行可悬停看阶级区间 }
  function itemCard(item, o) {
    o = o || {};
    const L = G.itemLines(item);
    let h = '<div class="icard r' + item.rarity + '">';
    if (o.tag) h += '<div class="ic-tag">' + o.tag + '</div>';
    h += '<div class="ic-head">' + itemIcon(item) + '<div class="ic-ttl"><div class="ic-name">' + esc(item.name) + '</div>';
    if (item.name !== item.baseName) h += '<div class="ic-base">' + esc(item.baseName) + '</div>';
    h += '</div></div>';
    h += '<div class="ic-meta"><span>' + G.RARITY_NAME[item.rarity] + ' · ' + G.SLOT_NAME[item.slot] + '</span><span>物品等级 ' + item.ilvl + '</span></div>';
    if (L.armour) h += '<div class="ic-line arm">护甲 <b>' + L.armour + '</b></div>';
    if (L.imp) h += '<div class="ic-line imp">' + esc(L.imp) + '</div>';
    if (L.affixes.length) {
      h += '<div class="ic-sep"></div>';
      L.affixes.forEach((a, i) => {
        h += '<div class="ic-line aff ' + a.type + '"' + (o.affTips ? ' data-tip="aff:' + item.uid + ':' + i + '"' : '') + '><span class="ic-tier t' + a.tier + '">T' + a.tier + '</span>' + esc(a.text) + '</div>';
      });
    } else {
      h += '<div class="ic-sep"></div><div class="ic-line none">没有词缀</div>';
    }
    if (o.vd) h += verdictBlock(o.vd);
    if (o.hint) h += '<div class="ic-hint">' + o.hint + '</div>';
    h += '</div>';
    return h;
  }

  // 物品提示：卡片 + 换装评估，身上同部位有装备时并排列出来对比
  function itemTip(item, equipped, hint) {
    if (equipped) return itemCard(item, { tag: '已装备', hint });
    const eq = G.save.equip[item.slot];
    const card = itemCard(item, { vd: verdict(item), hint });
    return eq ? '<div class="tip-pair">' + card + itemCard(eq, { tag: '当前装备' }) + '</div>' : card;
  }

  function bagCell(item, sel, idx) {
    const v = verdict(item);
    return (
      '<div class="cell r' + item.rarity + (sel ? ' sel' : '') + '" data-act="sel" data-item="' + item.uid + '" data-idx="' + idx + '" data-tip="item:' + item.uid + '" data-drag="item:' + item.uid + '">' +
      IC.item(item) +
      '<span class="c-ilvl">' + item.ilvl + '</span>' +
      (v ? '<span class="c-vd vd-' + v.badge + '">' + VD_GLYPH[v.badge] + '</span>' : '') +
      (item.affixes.length ? '<span class="c-aff">' + '<i></i>'.repeat(item.affixes.length) + '</span>' : '') +
      (ui.fresh.has(item.uid) ? '<span class="c-new"></span>' : '') +
      '</div>'
    );
  }

  // 角色属性表
  function statSheet() {
    const P = G.player;
    const S = P.S;
    const s = (k) => S[k] || 0;
    const row = (label, val, color) =>
      '<div class="st-row"><span>' + label + '</span><b' + (color ? ' style="color:' + color + '"' : '') + '>' + val + '</b></div>';
    const pct = (v) => signed(v) + '%';
    let h = '<div class="st-group">生存</div><div class="st-grid">';
    h += row('生命', Math.max(0, Math.ceil(P.life)) + ' / ' + P.maxLife, '#ff8a7a');
    h += row('魔力', Math.max(0, Math.floor(P.mana)) + ' / ' + P.maxMana, '#8ab4ff');
    h += row('护甲', fmtInt(P.armour));
    h += row('生命回复', fmt1(P.lifeRegen) + ' /秒');
    for (const t of ['fire', 'cold', 'light']) {
      const v = Math.round(P.res[t]);
      h += row(G.TYPE_NAME[t] + '抗性', v + '%' + (v >= 75 ? ' 满' : ''), G.TYPE_COLOR[t]);
    }
    h += row('魔力回复', fmt1(P.manaRegen) + ' /秒');
    h += '</div><div class="st-group">攻势</div><div class="st-grid">';
    h += row('攻击与施法速度', pct((P.speedMult - 1) * 100));
    h += row('移动速度', Math.round((P.moveSpeed / 7.2) * 100) + '%');
    h += row('暴击率', fmt1(5 * (1 + s('crit') / 100)) + '%');
    h += row('暴击伤害', Math.round(150 + s('critMulti')) + '%');
    h += row('物理伤害', pct(s('incAll') + s('incPhys')), G.TYPE_COLOR.phys);
    h += row('元素伤害', pct(s('incAll') + s('incElem')));
    for (const t of ['fire', 'cold', 'light']) {
      const v = s('inc' + G.CAP[t]);
      if (v) h += row(G.TYPE_NAME[t] + '伤害', pct(s('incAll') + s('incElem') + v), G.TYPE_COLOR[t]);
    }
    for (const t of G.TYPES) {
      const v = s('add' + G.CAP[t]);
      if (v) h += row('附加' + G.TYPE_NAME[t], Math.max(1, Math.round(v * 0.7)) + '–' + Math.max(2, Math.round(v * 1.3)), G.TYPE_COLOR[t]);
    }
    if (s('ownLess')) h += row('自身总伤害', '-' + fmt1(s('ownLess')) + '%', '#ff7a6a');
    // 召唤物：学会了召唤技能，或者身上 / 天赋里有召唤物属性时才列出来
    const hasSummon = Object.keys(G.save.skills).some((id) => G.SKILLS[id] && G.SKILLS[id].kind === 'summon');
    if (hasSummon || MINION_STATS.some((k) => s(k))) {
      h += '</div><div class="st-group ally">召唤物</div><div class="st-grid">';
      h += row('召唤物伤害', pct(s('minionDmg')), ALLY);
      h += row('召唤物生命', pct(s('minionLife')), ALLY);
      h += row('攻击与移动速度', pct(s('minionSpeed')), ALLY);
      h += row('仆从数量上限', '+' + fmt1(s('minionCap')), ALLY);
      if (s('minionMore')) h += row('召唤物总伤害', pct(s('minionMore')), s('minionMore') > 0 ? '#ffb066' : '#ff7a6a');
    }
    h += '</div><div class="st-group">其他</div><div class="st-grid">';
    h += row('技能范围', pct(s('area')));
    h += row('异常状态几率', pct(s('ailment')));
    h += row('物品稀有度', pct(s('rarity')));
    h += row('击杀回复', fmt1(s('lifeOnKill')));
    if (s('costReduce')) h += row('消耗降低', fmt1(s('costReduce')) + '%');
    if (s('dodgeCd')) h += row('翻滚冷却', '-' + fmt1(s('dodgeCd')) + '%');
    if (s('moreDmg')) h += row('总伤害', pct(s('moreDmg')), s('moreDmg') > 0 ? '#ffb066' : '#ff7a6a');
    if (s('lessTaken')) h += row('承受伤害', '-' + fmt1(s('lessTaken')) + '%', '#9fdc8a');
    if (s('moreLife')) h += row('生命总量', pct(s('moreLife')), s('moreLife') > 0 ? '#9fdc8a' : '#ff7a6a');
    if (s('bloodMagic')) h += row('技能消耗', '生命', '#ff7a6a');
    h += '</div>';
    return h;
  }

  // ============================================================
  // 背包页
  // ============================================================
  function renderInv() {
    const S = G.save;
    let sel = ui.sel ? findItem(ui.sel) : null;
    if (!sel) ui.sel = null;

    // 装备栏
    let eq = '';
    for (const slot of G.SLOTS) {
      const it = S.equip[slot];
      if (it) {
        eq +=
          '<div class="eq r' + it.rarity + (ui.sel === it.uid ? ' sel' : '') + '" data-slot="' + slot + '" data-act="sel" data-item="' + it.uid + '" data-tip="item:' + it.uid + '" data-drag="item:' + it.uid + '">' +
          IC.item(it) + '<span class="c-ilvl">' + it.ilvl + '</span>' +
          '<span class="eq-name">' + G.SLOT_NAME[slot] + '</span></div>';
      } else {
        eq += '<div class="eq empty" data-slot="' + slot + '">' + IC.slot(slot) + '<span class="eq-name">' + G.SLOT_NAME[slot] + '</span></div>';
      }
    }

    // 背包格
    let bag = '';
    let normals = 0;
    let magics = 0;
    for (let i = 0; i < G.BAG_SIZE; i++) {
      const it = S.bag[i];
      if (it) {
        if (it.rarity === 0) normals++;
        else if (it.rarity === 1) magics++;
        bag += bagCell(it, ui.sel === it.uid, i);
      } else {
        bag += '<div class="cell empty" data-idx="' + i + '"></div>';
      }
    }
    const withMagic = !!S.opts.salvageMagic;
    const bulkN = normals + (withMagic ? magics : 0);

    // 通货
    let cur = '';
    for (const id of G.CUR_IDS) {
      const c = G.CURRENCY[id];
      const n = S.cur[id] || 0;
      cur +=
        '<div class="cur' + (n ? '' : ' zero') + '" data-cur="' + id + '" data-tip="cur:' + id + '"' + (n ? ' data-drag="cur:' + id + '"' : '') + ' style="--c:' + c.color + '">' +
        IC.cur(id) + '<span class="cur-name">' + c.name + '</span><b>' + n + '</b></div>';
    }

    // 右侧详情
    let detail;
    if (sel) {
      const it = sel.item;
      let np = 0;
      let ns = 0;
      for (const a of it.affixes) {
        if (G.AFFIX_BY_ID[a.id].type === 'prefix') np++;
        else ns++;
      }
      const cap = it.rarity === 2 ? 3 : it.rarity === 1 ? 1 : 0;
      let craft = '';
      for (const id of G.CUR_IDS) {
        const c = G.CURRENCY[id];
        const n = S.cur[id] || 0;
        const ok = n > 0 && G.canCraft(it, id);
        craft +=
          '<button type="button" tabindex="-1" class="craft-btn" data-act="craft" data-cur="' + id + '" data-tip="cur:' + id + '" style="--c:' + c.color + '"' +
          (ok ? '' : ' disabled') + '>' + IC.cur(id) + '<span>' + c.name + '</span><b>' + n + '</b></button>';
      }
      detail =
        '<div class="sec-title">' + (sel.equipped ? '已装备' : '背包物品') + '</div>' +
        '<div class="detail-card' + (ui.flash ? ' flash' : '') + '" data-item="' + it.uid + '">' +
        itemCard(it, { vd: sel.equipped ? null : verdict(it), affTips: true }) + '</div>' +
        (cap
          ? '<div class="aff-count">前缀 <b>' + np + '</b>/' + cap + '<i></i>后缀 <b>' + ns + '</b>/' + cap + '<i></i>悬停词缀查看阶级</div>'
          : '<div class="aff-count">普通物品没有词缀，可以用通货改造</div>') +
        '<div class="act-row">' +
        (sel.equipped
          ? '<button type="button" tabindex="-1" class="btn" data-act="unequip">卸下</button>'
          : '<button type="button" tabindex="-1" class="btn primary" data-act="equip">装备</button>' +
            '<button type="button" tabindex="-1" class="btn" data-act="salvage">分解</button>' +
            '<button type="button" tabindex="-1" class="btn" data-act="drop">丢弃</button>') +
        '</div>' +
        (ui.invMsg ? '<div class="inv-msg">' + esc(ui.invMsg) + '</div>' : '') +
        '<div class="sec-title sm">通货改造<span class="sec-note">点击，或把通货拖到物品上</span></div>' +
        '<div class="craft-grid">' + craft + '</div>';
    } else {
      detail =
        '<div class="sec-title">物品详情</div>' +
        '<div class="detail-empty"><div class="de-glyph"><span>鉴</span></div>' +
        '<p>点击物品查看详情，悬停与身上的装备对比。</p>' +
        '<p><b>右键</b>或<b>拖到装备栏</b>直接穿上，<b class="vd-up">▲</b> 表示比身上的更强。</p>' +
        '<p>把<b>通货</b>拖到物品上改造它的词缀；把物品拖出窗口丢到地上。</p>' +
        (ui.invMsg ? '<p class="inv-msg">' + esc(ui.invMsg) + '</p>' : '') + '</div>';
    }
    ui.flash = false;

    const coach = coachBanner('inv');
    const foot = ui.bagMsg
      ? '<div class="inv-tips res">' + ui.bagMsg + '</div>'
      : coach
        ? '<div class="inv-tips coach">' + coach + '</div>'
        : '<div class="inv-tips"><span>右键 装备 / 卸下</span><i></i><span>拖动 整理 · 换装 · 丢弃</span><i></i><span>Shift+点击 分解</span><i></i><span>通货拖到物品上 改造</span></div>';

    el.body.innerHTML =
      '<div class="inv">' +
      '<div class="col col-l"><div class="sec-title">装备</div><div class="eq-grid">' + eq + '</div>' +
      '<div class="sec-title">属性<span class="sec-note">等级 ' + S.level + '</span></div><div class="stats scroll" data-scroll="stats">' + statSheet() + '</div></div>' +
      '<div class="col col-m"><div class="sec-title">背包<span class="sec-note">' + S.bag.length + ' / ' + G.BAG_SIZE + '</span>' +
      '<button type="button" tabindex="-1" class="btn sm" data-act="sort"' + (S.bag.length > 1 ? '' : ' disabled') + '>整理</button>' +
      '<button type="button" tabindex="-1" class="chk' + (withMagic ? ' on' : '') + '" data-act="opt" data-opt="salvageMagic"><i></i>含魔法</button>' +
      '<button type="button" tabindex="-1" class="btn sm" data-act="salvage-all"' + (bulkN ? '' : ' disabled') + '>一键分解' + (bulkN ? '（' + bulkN + '）' : '') + '</button></div>' +
      '<div class="bag">' + bag + '</div>' +
      '<div class="sec-title">通货<span class="sec-note">拖到物品上使用</span></div><div class="cur-row">' + cur + '</div>' +
      foot + '</div>' +
      '<div class="col col-r scroll" data-scroll="detail">' + detail + '</div>' +
      '</div>';
  }

  // ============================================================
  // 技能页
  // ============================================================
  // 某个辅助宝石现在镶在哪：{ skill, idx } 或 null
  function supLocation(supId) {
    const sockets = G.save.sockets;
    for (const sid in sockets) {
      const arr = sockets[sid];
      for (let i = 0; i < arr.length; i++) if (arr[i] === supId) return { skill: sid, idx: i };
    }
    return null;
  }
  function reqText(sup) {
    return sup.req ? sup.req.map((t) => G.TAG_NAME[t]).join(' / ') : '';
  }
  // 辅助宝石镶不上某个技能的原因：缺标签，或者技能带着它排斥的标签（例如回响不能用于召唤）
  function unfitText(skillId, sup) {
    const sk = G.SKILLS[skillId];
    const bad = sup.no && sk ? sup.no.filter((t) => sk.tags.indexOf(t) >= 0) : [];
    if (bad.length) return '不能用于' + bad.map((t) => G.TAG_NAME[t] || t).join(' / ') + '技能';
    return '需要标签：' + reqText(sup);
  }
  // 适用范围的一句话：「任意技能」/ 「物理」/ 「任意技能（召唤物除外）」
  function scopeText(sup) {
    const no = sup.no && sup.no.length ? '（' + sup.no.map((t) => G.TAG_NAME[t] || t).join(' / ') + '除外）' : '';
    return (sup.req ? reqText(sup) : '任意技能') + no;
  }

  // 召唤技能的召唤物数值：优先用 G.minionInfo（minions.js），缺的字段按 ctx.minion 自己算，都没有就给个不出错的空值
  function minionStats(id, ctx) {
    ctx = ctx || G.skillCtx(id);
    const m = ctx.minion || null;
    let info = null;
    try {
      info = typeof G.minionInfo === 'function' ? G.minionInfo(id) : null;
    } catch (err) {
      info = null;
    }
    info = info || {};
    // 不含暴击的每一击区间（与 G.calcHit 同一套乘法）
    let lo = 0;
    let hi = 0;
    for (const t in ctx.base) {
      const k = Math.max(0, 1 + ((ctx.inc && ctx.inc[t]) || 0) / 100) * (ctx.moreType && ctx.moreType[t] !== undefined ? ctx.moreType[t] : 1);
      lo += ctx.base[t][0] * k;
      hi += ctx.base[t][1] * k;
    }
    let ex = 0;
    for (const t in ctx.extra) ex += ctx.extra[t];
    lo *= (1 + ex / 100) * ctx.more;
    hi *= (1 + ex / 100) * ctx.more;
    const n = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    const sk = G.SKILLS[id] || {};
    let count = 0;
    for (const mm of liveMinions()) if (mm && !mm.dead && (mm.skill === id || (!mm.skill && mm.kind === sk.minion))) count++;
    const rateCtx = m && m.interval > 0 ? 1 / m.interval : 0;
    return {
      count: n(info.count, count),
      cap: n(info.cap, m ? m.cap : sk.cap || 0),
      dmgMin: Math.round(n(info.dmgMin, lo)),
      dmgMax: Math.round(n(info.dmgMax, hi)),
      life: Math.round(n(info.life, m ? m.life : sk.life || 0)),
      // 每秒出手次数。minionInfo.rate 若给的是间隔秒数（> 1 秒一次的召唤物也只有守像），以 ctx 为准
      rate: rateCtx || n(info.rate, 0),
      dr: m ? m.dr : sk.dr || 0,
      radius: m ? m.radius : 0,
      taunt: m ? m.taunt : sk.taunt || null,
      dps: ctx.minion && G.skillDps ? G.skillDps(ctx) : 0,
    };
  }
  const liveMinions = () => (G.state && Array.isArray(G.state.minions) ? G.state.minions : []);

  function skillCard(id) {
    const S = G.save;
    const sk = G.SKILLS[id];
    const ctx = G.skillCtx(id);
    const avg = G.avgHit(ctx);
    const rate = 1 / Math.max(ctx.time + ctx.stopAvg, ctx.cd || 0, 0.01); // 含命中时的顿帧，和实际打出来的节奏一致
    const blood = G.player.S.bloodMagic > 0;
    const socks = S.sockets[id] || [null, null, null];

    let binds = '';
    for (let i = 0; i < 4; i++) {
      binds +=
        '<button type="button" tabindex="-1" class="bind' + (S.bar[i] === id ? ' on' : '') + '" data-act="bind" data-skill="' + id + '" data-slot="' + i + '">' + KEY_LABEL[i] + '</button>';
    }
    let sockets = '';
    for (let i = 0; i < 3; i++) {
      const sup = socks[i];
      const picking = ui.picker && ui.picker.skill === id && ui.picker.idx === i;
      if (sup) {
        sockets +=
          '<button type="button" tabindex="-1" class="sock full" data-act="socket" data-skill="' + id + '" data-idx="' + i + '" data-tip="sock:' + sup + '" data-drag="sup:' + sup + '">' +
          IC.sup(sup) + G.SUPPORTS[sup].name + '</button>';
      } else {
        sockets +=
          '<button type="button" tabindex="-1" class="sock' + (picking ? ' picking' : '') + '" data-act="socket" data-skill="' + id + '" data-idx="' + i + '"><i></i>空槽</button>';
      }
    }
    // 手里有比当前等级高的无铭宝石：卡上给一个升级入口（点两下才用掉）
    const best = G.blankBest();
    const armed = ui.blankArm === id;
    const blankUp = best > S.skills[id]
      ? '<button type="button" tabindex="-1" class="blank-up' + (armed ? ' armed' : '') + '" data-act="blank" data-skill="' + id + '" data-tip="blank:' + id + '">' +
        IC.blank() + (armed ? '确认升至 Lv ' + best + '？再点一次' : '升至 Lv ' + best) + '</button>'
      : '';
    const num = (label, val, cls) => '<div class="sk-num' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span><b>' + val + '</b></div>';
    let nums;
    let note = '';
    const mi = sk.kind === 'summon' ? minionStats(id, ctx) : null;
    if (mi) {
      // 召唤技能：卡片上是召唤物自己的数值（每一击、出手频率、生命、现存数量 / 上限）
      nums =
        num('每击伤害', mi.dmgMin === mi.dmgMax ? fmtInt(mi.dmgMin) : fmtInt(mi.dmgMin) + '–' + fmtInt(mi.dmgMax), 'hl') +
        num('每秒攻击', mi.rate > 0 ? mi.rate.toFixed(2) : '—') +
        num('召唤物生命', fmtInt(mi.life)) +
        num('数量', mi.count + ' / ' + mi.cap, mi.count >= mi.cap ? 'full' : '') +
        num(blood ? '生命消耗' : '魔力消耗', ctx.cost > 0 ? fmt1(ctx.cost) : '无') +
        num('冷却', ctx.cd > 0 ? fmt1(ctx.cd) + ' 秒' : '无');
      const bits = ['施放 ' + fmt1(ctx.time) + ' 秒'];
      if (mi.dr > 0) bits.push('减伤 ' + Math.round(mi.dr) + '%');
      if (mi.radius > 0) bits.push('砸地半径 ' + fmt1(mi.radius));
      if (mi.taunt) bits.push('嘲讽 ' + fmt1(mi.taunt.cd) + ' 秒 / 半径 ' + fmt1(mi.taunt.r));
      if (mi.dps > 0) bits.push((mi.cap > 1 ? '满员秒伤约 ' : '秒伤约 ') + fmtInt(mi.dps));
      note = '<div class="sk-mnote"><i></i>' + bits.join(' · ') + '</div>';
    } else {
      nums =
        num('平均击中', fmtInt(avg), 'hl') +
        num(sk.kind === 'spin' || sk.kind === 'flicker' ? '每秒斩击' : '每秒施放', rate.toFixed(2)) +
        num('估算秒伤', fmtInt(avg * rate)) +
        num((blood ? '生命消耗' : '魔力消耗') + (sk.kind === 'spin' || sk.kind === 'flicker' ? ' / 每下' : ''), ctx.cost > 0 ? fmt1(ctx.cost) : '无') +
        num('冷却', ctx.cd > 0 ? fmt1(ctx.cd) + ' 秒' : '无') +
        num('暴击率', fmt1(ctx.crit) + '%');
    }
    return (
      '<div class="skill-card" style="--c:' + sk.color + '">' +
      '<div class="sk-top"><div class="sk-icon" data-drag="skill:' + id + '" data-tip="skdrag:' + id + '">' + IC.skill(id) + '</div>' +
      '<div class="sk-title"><div class="sk-name">' + sk.name + '<em>Lv ' + S.skills[id] + '</em>' + blankUp + '</div>' +
      '<div class="sk-tags">' + cardTags(sk).map((t) => '<span>' + G.TAG_NAME[t] + '</span>').join('') + '</div></div>' +
      '<div class="sk-binds">' + binds + '</div></div>' +
      '<div class="sk-desc">' + sk.desc + '</div>' +
      (sk.combo ? '<div class="sk-combo">' + sk.combo.map((c, i) => '<span' + (c.w >= 2 ? ' class="fin"' : '') + '>' + (c.w >= 2 ? '终结 ' : '第 ' + (i + 1) + ' 段 ') + '×' + c.mult + '</span>').join('<i></i>') + '</div>' : '') +
      '<div class="sk-nums' + (mi ? ' ally' : '') + '">' + nums + '</div>' + note +
      '<div class="sk-socks"><span class="sk-socks-label">辅助</span>' + sockets + '</div>' +
      '</div>'
    );
  }

  function renderSkills() {
    const S = G.save;
    const known = Object.keys(G.SKILLS).filter((id) => S.skills[id]);
    const unknown = Object.keys(G.SKILLS).filter((id) => !S.skills[id]);
    const B = G.BLANK_GEM;
    const best = G.blankBest();
    let cards = known.map(skillCard).join('');
    if (unknown.length) {
      // 有无铭宝石时，每个没学会的技能都能点：第一下只是选中，再点一次才用掉
      const item = (id) => {
        const c = G.SKILLS[id];
        if (!best) return '<span style="--c:' + c.color + '">' + IC.skill(id) + c.name + '</span>';
        const armed = ui.blankArm === id;
        return (
          '<button type="button" tabindex="-1" class="sm-learn' + (armed ? ' armed' : '') + '" style="--c:' + c.color + '" data-act="blank" data-skill="' + id + '" data-tip="blank:' + id + '">' +
          IC.skill(id) + c.name + '<em>' + (armed ? '确认学会？再点一次' : '学会 · Lv ' + best) + '</em></button>'
        );
      };
      cards +=
        '<div class="skill-more' + (best ? ' can-learn' : '') + '"><div class="sm-title">尚未获得的技能宝石' + (best ? '<span>点一个技能，用 Lv ' + best + ' 的' + B.short + '学会它</span>' : '') + '</div>' +
        '<div class="sm-list">' + unknown.map(item).join('') + '</div>' +
        '<div class="sm-note">技能宝石由怪物掉落，首领必定掉落一颗。重复拾取更高等级的宝石会提升技能等级。' + B.name + '可以在这里换成任意一个技能。</div></div>';
    }
    // 顶部：手里的无铭宝石（数量、最高等级、怎么用），以及刚才用掉一颗的结果
    let blank = '';
    const gems = S.blankGems;
    if (gems.length || ui.blankMsg) {
      const lv = gems.length
        ? '<b>' + B.name + ' ×' + gems.length + '</b><span class="bk-lv">最高 Lv ' + best + '</span>' +
          (gems.length > 1 ? '<span class="bk-all">' + gems.slice(0, 8).map((v) => 'Lv ' + v).join(' · ') + (gems.length > 8 ? ' …' : '') + '</span>' : '')
        : '<b>' + B.name + '已用完</b>';
      const how = gems.length
        ? '在下方「尚未获得」里点一个技能学会它，或点技能卡上的「升至 Lv ' + best + '」。每次用最高等级的那颗，点两下才确认'
        : '';
      blank =
        '<div class="blank-bar" style="--c:' + B.color + '">' + ibox(IC.blank(), 'gemb') + '<div class="bk-txt"><div class="bk-top">' + lv + '</div>' +
        (ui.blankMsg ? '<div class="bk-msg">' + ui.blankMsg + '</div>' : how ? '<div class="bk-how">' + how + '</div>' : '') + '</div></div>';
    }

    // 技能栏：四个格子，可以把技能图标拖进来
    let bar = '';
    for (let i = 0; i < 4; i++) {
      const id = S.bar[i];
      bar +=
        '<div class="barslot' + (id ? '' : ' empty') + '" data-slot="' + i + '"' + (id ? ' data-drag="skill:' + id + '" data-tip="skdrag:' + id + '" style="--c:' + G.SKILLS[id].color + '"' : '') + '>' +
        '<div class="bs-icon">' + (id ? IC.skill(id) : '') + '</div><div class="bs-txt"><span>' + KEY_LABEL[i] + '</span><b>' + (id ? G.SKILLS[id].name : '空') + '</b></div></div>';
    }

    let sups = '';
    for (const id of Object.keys(G.SUPPORTS)) {
      if (!S.supports.includes(id)) continue;
      const sp = G.SUPPORTS[id];
      const loc = supLocation(id);
      sups +=
        '<div class="sup' + (loc ? ' used' : '') + '" data-drag="sup:' + id + '" style="--c:' + IC.supColor(id) + '"><div class="sup-top">' + IC.sup(id) + '<b>' + sp.name + '</b>' +
        '<span class="sup-req">' + scopeText(sp) + '</span></div>' +
        '<div class="sup-desc">' + sp.desc + '</div>' +
        '<div class="sup-foot"><span>消耗 ×' + sp.cost + '</span>' +
        (loc ? '<span class="sup-loc">镶于 ' + G.SKILLS[loc.skill].name + '</span>' : '<span class="sup-free">未使用</span>') +
        '</div></div>';
    }
    if (!sups) {
      sups = '<div class="sup-none">还没有辅助宝石。<br>精英怪和首领会掉落它们，把它们镶进技能的辅助槽，就能改变技能的行为。</div>';
    }
    const coach = coachBanner('skills');

    el.body.innerHTML =
      '<div class="skills">' +
      '<div class="col col-main">' + blank + '<div class="sec-title">技能栏<span class="sec-note">把技能图标拖进格子，或点技能卡上的按键标签</span></div>' +
      '<div class="barstrip">' + bar + '</div>' +
      '<div class="sec-title">技能<span class="sec-note">点击辅助槽选择宝石，或把右侧的宝石拖进来</span></div>' +
      '<div class="skill-list scroll" data-scroll="skills">' + cards + '</div></div>' +
      '<div class="col col-side"><div class="sec-title">辅助宝石<span class="sec-note">' + S.supports.length + ' / ' + Object.keys(G.SUPPORTS).length + '</span></div>' +
      (coach ? '<div class="side-coach">' + coach + '</div>' : '') +
      '<div class="sup-list scroll" data-scroll="sups">' + sups + '</div></div>' +
      '</div>';
  }

  // 辅助宝石选择器
  function renderPicker() {
    const pk = ui.picker;
    const box = el.picker;
    if (!pk || ui.tab !== 'skills' || !ui.isOpen) {
      box.classList.remove('on');
      return;
    }
    const anchor = el.body.querySelector('[data-act="socket"][data-skill="' + pk.skill + '"][data-idx="' + pk.idx + '"]');
    if (!anchor) {
      ui.picker = null;
      box.classList.remove('on');
      return;
    }
    const S = G.save;
    const rows = [];
    for (const id of Object.keys(G.SUPPORTS)) {
      if (!S.supports.includes(id)) continue;
      const sp = G.SUPPORTS[id];
      const loc = supLocation(id);
      const fits = G.supportFits(pk.skill, id);
      let rank;
      let html;
      if (!fits) {
        rank = 3;
        html =
          '<div class="pk-row off"><div class="pk-top">' + IC.sup(id) + '<b>' + sp.name + '</b><span class="pk-note bad">' + unfitText(pk.skill, sp) + '</span></div>' +
          '<div class="pk-desc">' + sp.desc + '</div></div>';
      } else if (loc && loc.skill === pk.skill) {
        rank = 2;
        html =
          '<div class="pk-row off"><div class="pk-top">' + IC.sup(id) + '<b>' + sp.name + '</b><span class="pk-note">已镶在这个技能上</span></div>' +
          '<div class="pk-desc">' + sp.desc + '</div></div>';
      } else {
        rank = loc ? 1 : 0;
        html =
          '<button type="button" tabindex="-1" class="pk-row" data-act="pick" data-sup="' + id + '"><div class="pk-top">' + IC.sup(id) + '<b>' + sp.name + '</b>' +
          (loc ? '<span class="pk-note warn">正用于 ' + G.SKILLS[loc.skill].name + ' · 选择后移过来</span>' : '<span class="pk-note">消耗 ×' + sp.cost + '</span>') +
          '</div><div class="pk-desc">' + sp.desc + '</div></button>';
      }
      rows.push({ rank, html });
    }
    rows.sort((a, b) => a.rank - b.rank);
    box.innerHTML =
      '<div class="pk-title">为「' + G.SKILLS[pk.skill].name + '」选择辅助宝石</div>' +
      (rows.length
        ? '<div class="pk-list scroll">' + rows.map((r) => r.html).join('') + '</div>'
        : '<div class="pk-empty">还没有辅助宝石。精英怪和首领会掉落。</div>');
    box.classList.add('on');
    // 贴着插槽放在下方；放不下就放上方；两边都不够就选宽裕的一边并压缩列表高度，始终不盖住插槽
    const list = box.querySelector('.pk-list');
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - r.bottom - 14;
    const above = r.top - 14;
    let h = box.offsetHeight;
    let up = false;
    if (h > below) {
      if (h <= above) {
        up = true;
      } else {
        up = above > below;
        if (list) list.style.maxHeight = Math.max(80, (up ? above : below) - (h - list.offsetHeight)) + 'px';
        h = box.offsetHeight;
      }
    }
    box.style.left = G.clamp(r.left, 8, vw - box.offsetWidth - 8) + 'px';
    box.style.top = Math.max(8, up ? r.top - h - 6 : r.bottom + 6) + 'px';
  }
  function closePicker() {
    if (!ui.picker) return;
    ui.picker = null;
    el.picker.classList.remove('on');
    const p = el.body.querySelector('.sock.picking');
    if (p) p.classList.remove('picking');
  }

  // ============================================================
  // 天赋页（SVG）
  // ============================================================
  const NODE_R = { small: 12, notable: 17, keystone: 18, start: 16 };
  const n1 = (v) => Math.round(v * 10) / 10;

  function renderTree() {
    const S = G.save;
    const T = G.TREE;
    const alloc = new Set(S.passives);
    const pts = G.passivePoints();
    const canSpend = pts.free > 0;

    let edges = '';
    let nodes = '';
    let labels = '';
    for (const id in T) {
      const n = T[id];
      for (const l of n.links) {
        if (id < l) {
          const m = T[l];
          const a = alloc.has(id);
          const b = alloc.has(l);
          edges +=
            '<line class="te' + (a && b ? ' on' : a || b ? ' near' : '') + '" style="--c:' + (n.color || m.color) + '" x1="' + n1(n.x) + '" y1="' + n1(n.y) + '" x2="' + n1(m.x) + '" y2="' + n1(m.y) + '"/>';
        }
      }
    }
    for (const id in T) {
      const n = T[id];
      const r = NODE_R[n.kind];
      const isAlloc = alloc.has(id);
      const avail = !isAlloc && n.links.some((l) => alloc.has(l));
      const state = isAlloc ? 'alloc' : avail ? 'avail' + (canSpend ? ' can' : '') : 'locked';
      let shape;
      if (n.kind === 'keystone') {
        shape =
          '<rect class="shape" x="' + -r + '" y="' + -r + '" width="' + 2 * r + '" height="' + 2 * r + '" rx="2" transform="rotate(45)"/>' +
          '<rect class="inner" x="-7" y="-7" width="14" height="14" transform="rotate(45)"/>';
      } else if (n.kind === 'notable') {
        shape = '<circle class="shape" r="' + r + '"/><circle class="inner ring" r="' + (r - 6) + '"/>';
      } else if (n.kind === 'start') {
        shape = '<circle class="shape" r="' + r + '"/><rect class="inner" x="-5" y="-5" width="10" height="10" transform="rotate(45)"/>';
      } else {
        shape = '<circle class="shape" r="' + r + '"/>';
      }
      nodes +=
        '<g class="tn ' + n.kind + ' ' + state + '" data-act="node" data-node="' + id + '" data-tip="node:' + id + '" style="--c:' + (n.color || '#ffb066') + '" transform="translate(' + n1(n.x) + ' ' + n1(n.y) + ')">' +
        '<circle class="halo" r="' + (r + (n.kind === 'small' ? 7 : 11)) + '"/>' + shape + '<circle class="hit" r="' + (r + 8) + '"/></g>';

      // 核心 / 基石天赋直接标出名字
      if (n.kind === 'notable' || n.kind === 'keystone') {
        const len = Math.hypot(n.x, n.y) || 1;
        const dx = n.x / len;
        const dy = n.y / len;
        let lx;
        let ly;
        let anchor = 'middle';
        if (n.kind === 'keystone') {
          lx = n.x;
          ly = n.y + (dy < 0 ? -(r * 1.42 + 12) : r * 1.42 + 26);
        } else if (Math.abs(dy) > 0.7) {
          // 偏上 / 偏下的节点：名字放正上方或正下方
          lx = n.x;
          ly = n.y + (dy < 0 ? -(r + 12) : r + 24);
        } else {
          lx = n.x + (dx > 0 ? r + 12 : -(r + 12));
          ly = n.y + 6;
          anchor = dx > 0 ? 'start' : 'end';
        }
        labels +=
          '<text class="tl ' + n.kind + ' ' + (isAlloc ? 'alloc' : avail ? 'avail' : '') + '" style="--c:' + n.color + '" x="' + n1(lx) + '" y="' + n1(ly) + '" text-anchor="' + anchor + '">' + n.name + '</text>';
      }
    }

    // 各支路已点数量与属性汇总
    const armCount = {};
    const armTotal = {};
    const armColor = {};
    const sum = {};
    for (const id in T) {
      const n = T[id];
      if (n.kind === 'start') continue;
      armTotal[n.arm] = (armTotal[n.arm] || 0) + 1;
      armCount[n.arm] = armCount[n.arm] || 0;
      armColor[n.arm] = n.color;
      if (alloc.has(id)) {
        armCount[n.arm]++;
        for (const k in n.stats) sum[k] = (sum[k] || 0) + n.stats[k];
      }
    }
    let arms = '';
    // 已知的支路按固定顺序排，数据里新加了别的支路也照样列出来
    const armKeys = ARM_ORDER.filter((k) => armTotal[k]).concat(Object.keys(armTotal).filter((k) => ARM_ORDER.indexOf(k) < 0));
    for (const k of armKeys) {
      const info = ARM_INFO[k] || { name: '支路', hint: '' };
      arms +=
        '<div class="arm" style="--c:' + armColor[k] + '"><i></i><b>' + info.name + '</b><span>' + info.hint + '</span><em>' + armCount[k] + ' / ' + armTotal[k] + '</em></div>';
    }
    let sumHtml = '';
    for (const k in sum) sumHtml += '<div class="ts-line">' + esc(G.fmtStat(k, sum[k])) + '</div>';
    if (!sumHtml) sumHtml = '<div class="ts-none">还没有点亮任何天赋。<br>从中央的起点出发，沿着连线向外点亮。</div>';

    el.body.innerHTML =
      '<div class="tree">' +
      '<div class="tree-view"><svg id="tree-svg" viewBox="-480 -395 960 760" preserveAspectRatio="xMidYMid meet">' +
      '<g class="tdeco"><circle r="81"/><circle r="231"/><circle r="381"/><circle r="462"/></g>' +
      '<g>' + edges + '</g><g>' + nodes + '</g><g>' + labels + '</g></svg>' +
      '<div class="tree-legend"><span class="lg alloc"><i></i>已点亮</span><span class="lg avail"><i></i>可点亮</span><span class="lg locked"><i></i>未连接</span>' +
      '<span class="lg-sep"></span><span>点击点亮 · 再次点击退回</span></div></div>' +
      '<div class="col col-side tree-side">' +
      '<div class="sec-title">天赋点</div>' +
      '<div class="pts' + (pts.free > 0 ? ' has' : '') + '"><b>' + pts.free + '</b><div><span>可用天赋点</span><em>已用 ' + pts.used + ' · 共 ' + pts.total + '</em></div></div>' +
      '<div class="pts-note">每升一级获得 1 点；首次击败每个首领额外获得 2 点。</div>' +
      (coachBanner('tree') ? '<div class="side-coach">' + coachBanner('tree') + '</div>' : '') +
      '<div class="arms">' + arms + '</div>' +
      '<div class="sec-title">已获得的加成</div>' +
      '<div class="tree-sum scroll" data-scroll="treesum">' + sumHtml + '</div>' +
      '<div class="tree-msg' + (ui.treeMsgBad ? ' bad' : '') + '">' + esc(ui.treeMsg) + '</div>' +
      '<button type="button" tabindex="-1" class="btn' + (ui.resetArmed ? ' danger' : '') + '" data-act="tree-reset"' + (pts.used > 0 ? '' : ' disabled') + '>' +
      (ui.resetArmed ? '再点一次确认重置' : '重置全部天赋') + '</button>' +
      '</div></div>';
  }

  // ============================================================
  // 地图页
  // ============================================================
  function renderMap() {
    const S = G.save;
    const st = G.state;
    const tier = (ui.mapTier = G.clamp(ui.mapTier, 0, S.maxTier));
    const clearedAt = (z) => S.cleared[z.id] !== undefined && S.cleared[z.id] >= tier;

    let tiers = '';
    for (let t = 0; t <= S.maxTier; t++) {
      tiers += '<button type="button" tabindex="-1" class="tier' + (t === tier ? ' on' : '') + '" data-act="tier" data-tier="' + t + '">' + t + '</button>';
    }

    let cards = '';
    G.ZONES.forEach((z, i) => {
      const locked = i > 0 && !clearedAt(G.ZONES[i - 1]);
      const cleared = clearedAt(z);
      const here = st.zoneIdx === i && st.tier === tier;
      const lvl = z.level + tier * G.TIER_LEVELS;
      const boss = G.BOSSES[z.boss];
      cards +=
        '<div class="zone' + (locked ? ' locked' : '') + (here ? ' here' : '') + (cleared ? ' cleared' : '') + '" style="--fog:' + hexCss(z.fog) + ';--acc:' + hexCss(z.accent) + ';--path:' + hexCss(z.path) + ';--rock:' + hexCss(z.rock) + ';--sky:' + hexCss(z.sky) + '">' +
        '<div class="z-art"><div class="z-ridge b"></div><div class="z-ridge a"></div><span class="z-glyph">' + (ZONE_GLYPH[z.id] || z.name[0]) + '</span>' +
        '<span class="z-ord">' + (ZONE_ORD[i] || '') + '</span>' +
        (cleared ? '<span class="z-badge ok">已通关</span>' : locked ? '<span class="z-badge lock">未解锁</span>' : '') +
        (here ? '<span class="z-here">当前所在</span>' : '') +
        '</div>' +
        '<div class="z-body"><div class="z-name">' + z.name + '</div>' +
        '<div class="z-meta"><span>怪物等级 <b>' + lvl + '</b></span><span style="color:' + G.TYPE_COLOR[z.elem] + '">' + G.TYPE_NAME[z.elem] + '</span></div>' +
        '<div class="z-desc">' + z.desc + '</div>' +
        '<div class="z-boss"><span>首领</span><b>' + boss.name + '</b>' + (S.bossKills[z.boss] ? '<em>曾击败</em>' : '') + '</div>' +
        (locked
          ? '<div class="z-lock">先在本层级击败「' + G.ZONES[i - 1].name + '」的首领</div>'
          : '<button type="button" tabindex="-1" class="btn primary" data-act="enter" data-zone="' + i + '">' + (here ? '重新进入' : '进入') + '</button>') +
        '</div></div>';
    });

    el.body.innerHTML =
      '<div class="map">' +
      '<div class="map-top"><div class="sec-title">轮回层级</div>' +
      '<div class="tier-row"><div class="tiers">' + tiers + '</div>' +
      '<div class="tier-note">每提高一层，所有区域的怪物等级 +' + G.TIER_LEVELS + '，掉落的物品等级随之提高。' +
      (S.maxTier === 0 ? '击败最后一个区域的首领后开启下一层。' : '在当前最高层级击败最后一个区域的首领，开启更高一层。') + '</div></div></div>' +
      '<div class="zones">' + cards + '</div>' +
      '<div class="map-opts">' +
      '<div class="opt-text"><b>普通物品</b><span>魔法、稀有物品总是自动拾取</span></div>' +
      '<div class="seg">' +
      [['manual', '手动拾取', '走过不捡，按 F 或点击名牌拾取'], ['auto', '自动拾取', '走过就捡进背包'], ['scrap', '自动丢弃', '走过就地丢弃，不进背包（普通物品分解不出通货）']]
        .map((o) => '<button type="button" tabindex="-1" class="seg-b' + (normMode() === o[0] ? ' on' : '') + '" data-act="normmode" data-mode="' + o[0] + '" data-tip="txt:' + o[2] + '">' + o[1] + '</button>')
        .join('') +
      '</div>' +
      '<div class="opt-sep"></div>' +
      '<button type="button" tabindex="-1" class="switch' + (S.opts.hideNormal ? ' on' : '') + '" data-act="opt" data-opt="hideNormal"><i></i></button>' +
      '<div class="opt-text"><b>折叠普通物品的名牌</b><span>地上只留一个小点，悬停或按住 Alt 展开</span></div>' +
      '<div class="opt-gap"></div>' +
      (ui.delArmed
        ? '<span class="del-warn">存档删除后无法恢复，确定吗？</span>' +
          '<button type="button" tabindex="-1" class="btn danger" data-act="del-confirm">确认删除</button>' +
          '<button type="button" tabindex="-1" class="btn" data-act="del-cancel">取消</button>'
        : '<button type="button" tabindex="-1" class="btn ghost" data-act="del-save">删除存档</button>') +
      '</div></div>';
  }

  // ============================================================
  // 帮助页
  // ============================================================
  // 普通物品的处理方式：manual 手动拾取 / auto 自动拾取 / scrap 走过就分解
  function normMode() {
    const o = G.save.opts;
    return o.autoSalvage ? 'scrap' : o.autoWhite ? 'auto' : 'manual';
  }

  // 帮助页的召唤一节：召唤技能、集火、召唤物辅助宝石（宝石名单从数据里取，数据改了这里跟着变）
  function helpSummon() {
    const name = (id, fb) => (G.SKILLS[id] ? G.SKILLS[id].name : fb);
    const sups = Object.keys(G.SUPPORTS).filter((id) => {
      const sp = G.SUPPORTS[id];
      return sp.req && sp.req.length === 1 && sp.req[0] === 'minion';
    });
    const gems = sups.map((id) => '<div class="hc" style="--c:' + IC.supColor(id) + '">' + IC.sup(id) + '<b>' + G.SUPPORTS[id].name + '</b><span>' + G.SUPPORTS[id].desc + '</span></div>').join('');
    const blocked = ['echo', 'leech', 'multi', 'pierce', 'chain'].filter((id) => G.SUPPORTS[id]).map((id) => G.SUPPORTS[id].name).join('、');
    return (
      '<div class="sec-title">召唤与集火</div>' +
      '<p><b class="c-ally">' + name('thrall', '烬骸仆从') + '</b>在准星处唤起迅捷的骸骨剑士，数量满了再施放会替换伤得最重的那具；<b class="c-ally">' + name('colossus', '石誓守像') + '</b>只有一尊，缓慢而坚韧，会砸地伤害一圈敌人，并不时<b>嘲讽</b>，让周围的敌人转而攻击它。</p>' +
      '<p>召唤物全自动：跟在你身边，自己挑身边的敌人打。你<b>亲手打中</b>的敌人会被标记几秒，召唤物优先<b>集火</b>它——想先清掉谁，就先打它一下。敌人也会还手：一具仆从最多缠住两只怪、守像四只，多出来的照样冲你来，远程怪和爆裂虫更是认准了你。仆从会闪开小怪的预警圈，却躲不开首领的招式，挨得也更重；倒下的召唤物需要重新施放。</p>' +
      '<p>召唤物<b>不吃你自己的伤害属性</b>，只随宝石等级、带「召唤物」字样的属性（装备词缀与<b class="c-ally">统御</b>支路的天赋）和镶在召唤技能上的辅助宝石成长。屏幕左下、生命球旁边的一排小图标是它们的血量，守像的嘲讽冷却也在那里；技能页的卡片上有每一击的伤害、生命与数量。</p>' +
      (gems ? '<div class="hc-list">' + gems + '</div>' : '') +
      '<p>通用辅助也能镶在召唤技能上：迅捷加快召唤物出手，注入、蛮力、致命、震慑、蚀染作用于召唤物的每一击，扩域放大守像的砸地，节流照常减少消耗与冷却。' + (blocked ? blocked + '镶不上召唤技能。' : '') + '</p>'
    );
  }

  function renderHelp() {
    const key = (k, t) => '<div class="hk"><span class="hk-keys">' + k.map((x) => '<kbd>' + x + '</kbd>').join('') + '</span><span>' + t + '</span></div>';
    let curs = '';
    for (const id of G.CUR_IDS) {
      const c = G.CURRENCY[id];
      curs += '<div class="hc" style="--c:' + c.color + '">' + IC.cur(id) + '<b>' + c.name + '</b><span>' + c.desc + '</span></div>';
    }
    el.body.innerHTML =
      '<div class="help">' +
      '<div class="col scroll" data-scroll="help1"><div class="sec-title">操作</div>' +
      key(['W', 'A', 'S', 'D'], '移动（方向键亦可）') +
      key(['左键', '右键', 'Q', 'E'], '朝准星施放技能栏上的技能，可按住') +
      key(['空格'], '翻滚，途中短暂无敌；可以取消挥砍') +
      key(['1', '2'], '生命 / 魔力药剂，击杀怪物会充能') +
      key(['F'], '处决露出破绽的敌人；否则拾取最近的掉落') +
      key(['Alt'], '按住：展开地上所有名牌的概要') +
      key(['I', 'G', 'P', 'M'], '背包 / 技能 / 天赋 / 地图') +
      key(['H', 'Esc'], '打开帮助 / 关闭面板') +
      '<div class="sec-title">战斗须知</div>' +
      '<p>地面上的<b class="c-red">红色区域</b>是敌人即将落下的攻击，在它填满之前走出去或翻滚穿过。</p>' +
      '<p><b style="color:' + G.TYPE_COLOR.fire + '">火焰</b>会点燃敌人使其持续受伤，<b style="color:' + G.TYPE_COLOR.cold + '">冰霜</b>会冰缓并有几率冻结，<b style="color:' + G.TYPE_COLOR.light + '">闪电</b>会让敌人感电、承受更多伤害。把准星移到敌人身上可以看到它的等级和身上的异常状态。</p>' +
      '<p>护甲减少受到的物理伤害，抗性减少对应元素的伤害，上限为 75%。</p>' +
      '<div class="sec-title">连击、架势与处决</div>' +
      '<p><b>连击</b>：按住或连按<b>裂石击</b>会连出三段——横斩、反手上挑、跃起下劈。第三段是<b>终结技</b>：范围更大、伤害翻倍、把敌人震飞，还能打断小怪的起手。停手太久、翻滚或改用别的技能，连段就从头再来；技能图标上方的三格显示打到了第几段。</p>' +
      '<p><b>出招的节奏</b>：动作途中按下的攻击、技能和翻滚会被记住，能出手的一瞬间立刻放出，不必掐着时间狂点。<b>翻滚可以取消挥砍</b>——起手和收招都行。</p>' +
      '<p><b>架势</b>：精英和首领的血条下面有一道白条。每次命中都会削掉一些（近战最多，终结技尤其多，暴击更多），几秒不挨打才会回复。打空之后敌人露出<b class="c-gold">破绽</b>：停下手上的一切招式，在几秒内受到的伤害提高 25%。</p>' +
      '<p><b>处决</b>：对破绽中的敌人按 <kbd>F</kbd>（贴身时按近战键也行）。你会冲到它身前给出一记重创，全程无敌，并回复生命、魔力和药剂充能。精英多半当场毙命；首领会失去一大截生命，之后重新站稳——而且每被击破一次，架势就更难打空。</p>' +
      '<p>脚下的两道弧是生命（左）与魔力（右）。屏幕边缘的箭头指向画面外已经盯上你的精英、首领和传送门。</p>' +
      '<p>死亡不会损失经验和物品：你会在区域入口重生（倒在首领战里，则在它的竞技场门外），怪物回到原位，首领恢复全部生命。</p>' +
      '</div>' +
      '<div class="col scroll" data-scroll="help2"><div class="sec-title">技能与辅助宝石</div>' +
      '<p>怪物会掉落<b class="c-teal">技能宝石</b>。学会的技能在「技能」页拖到技能栏的格子里（左键 / 右键 / Q / E），或点技能卡上的按键标签；再次拾到更高等级的同名宝石会直接升级。</p>' +
      '<p><b class="c-blank">无铭技能宝石</b>没有刻下技能：每个首领第一次倒下时必掉一颗，精英和普通怪偶尔也会掉。在技能页里点一个没学会的技能就能用它学会，或把等级更低的已学技能升到它的等级；总是先用等级最高的那颗。</p>' +
      '<p>每个技能有 3 个辅助槽。<b>辅助宝石</b>不会单独生效，而是改变它所镶嵌的技能：多几枚投射物、范围更大、自动重复施放……代价是更高的魔力消耗。把宝石拖进辅助槽，或点击空槽挑选；点击已镶嵌的槽取下。</p>' +
      '<p>一颗辅助宝石同一时间只能镶在一个技能上，并且技能要带有它要求的标签。</p>' +
      helpSummon() +
      '<div class="sec-title">天赋盘</div>' +
      '<p>每升一级获得 1 点天赋，首次击败每个首领再得 2 点。从中央出发有四条支路：<b style="color:#e2705a">铸躯</b>偏向生命与物理，<b style="color:#7ed67a">迅影</b>偏向速度与暴击，<b style="color:#6fb2ff">秘识</b>偏向魔力与元素，<b class="c-ally">统御</b>强化召唤物。</p>' +
      '<p>支路尽头的<b>基石天赋</b>效果强烈但带有代价。天赋可以随时退回或整体重置，不需要任何花费。</p>' +
      '<div class="sec-title">区域与轮回</div>' +
      '<p>每个区域的尽头盘踞着一名首领。击败它之后会出现传送门，通往地图，可以前往下一个区域。</p>' +
      '<p>击败最后一个区域的首领会开启<b>轮回层级</b>：所有区域的怪物更强，掉落的物品等级也更高。</p>' +
      '<p>游戏会自动存档。</p>' +
      '<div class="help-foot"><button type="button" tabindex="-1" class="btn sm" data-act="tut-reset">重新显示新手提示</button>' +
      '<span>' + (ui.tutMsg || '已看过 ' + Object.keys(G.save.tut).length + ' / ' + HINTS.length + ' 条') + '</span></div>' +
      '</div>' +
      '<div class="col scroll" data-scroll="help3"><div class="sec-title">装备与词缀</div>' +
      '<p>装备分为<b style="color:' + G.RARITY_COLOR[0] + '">普通</b>、<b style="color:' + G.RARITY_COLOR[1] + '">魔法</b>（最多 2 条词缀）和<b style="color:' + G.RARITY_COLOR[2] + '">稀有</b>（最多 6 条词缀）。词缀分前缀与后缀，各占一半位置。</p>' +
      '<p>词缀前的 <span class="ic-tier t4">T4</span> 是它的阶级，数字越大数值越高；物品等级越高，能出现的阶级越高。在详情里悬停一条词缀可以看到每一阶的数值范围。</p>' +
      '<p>物品角上的 <b class="vd-up">▲</b> <b class="vd-down">▼</b> 是与身上同部位装备的比较：按技能栏上技能的秒伤、最大生命、护甲与抗性估算。把鼠标停在背包格子或<b>地上的名牌</b>上，都能看到完整属性和换上之后的变化。</p>' +
      '<p><b>背包操作</b>：右键装备 / 卸下；拖到装备栏换装，拖到别的格子整理，拖出窗口丢到地上；Shift+点击分解（稀有物品需要再点一次）。</p>' +
      '<div class="sec-title">通货</div>' +
      '<p>通货不是用来买东西的，而是直接改造装备。把通货<b>拖到一件物品上</b>，或者选中物品后点击右侧的通货按钮。</p>' +
      '<div class="hc-list">' + curs + '</div>' +
      '<p>分解魔法物品有机会得到微光尘，分解稀有物品必得增幅尘。</p>' +
      '</div></div>';
  }

  // ============================================================
  // 渲染调度
  // ============================================================
  const RENDER = { inv: renderInv, skills: renderSkills, tree: renderTree, map: renderMap, help: renderHelp };

  function render() {
    if (!ui.isOpen) return;
    vdCache.clear(); // 装备 / 构筑可能刚变过，换装评估重新算
    // 重建 DOM 会丢滚动位置，先记下来
    const scrolls = {};
    el.body.querySelectorAll('[data-scroll]').forEach((n) => {
      scrolls[n.dataset.scroll] = n.scrollTop;
    });
    RENDER[ui.tab]();
    // 写回 scrollTop 会让新元素各触发一次 scroll 事件；记下写回的值，
    // 监听那边据此认出「这是恢复位置，不是玩家在滚」，不去收起选择器
    ui.restored = {};
    el.body.querySelectorAll('[data-scroll]').forEach((n) => {
      const v = scrolls[n.dataset.scroll];
      if (!v) return;
      n.scrollTop = v;
      if (n.scrollTop > 0) ui.restored[n.dataset.scroll] = { node: n, top: n.scrollTop };
    });
    el.body.dataset.tab = ui.tab;
    for (const t of el.tabBtns) t.classList.toggle('on', t.dataset.tab === ui.tab);
    renderPicker();
    renderConfirm();
    retip();
    hud.costT = -1e9; // 构筑可能变了，HUD 下一帧重新算消耗与天赋点
  }

  // ============================================================
  // 悬浮提示
  // ============================================================
  const tcHead = (icon, name, kind) =>
    '<div class="tc-head">' + icon + '<div><div class="tc-name">' + name + '</div>' + (kind ? '<div class="tc-kind">' + kind + '</div>' : '') + '</div></div>';

  // 无铭技能宝石的说明卡；skillId 给出时说清楚对这个技能会发生什么、用的是哪一颗
  function blankTip(skillId, lootLvl) {
    const B = G.BLANK_GEM;
    const S = G.save;
    const gems = S.blankGems;
    let state = '';
    if (skillId && G.SKILLS[skillId]) {
      const sk = G.SKILLS[skillId];
      const best = G.blankBest();
      const have = S.skills[skillId] || 0;
      state = !best
        ? '<div class="tc-state dup">手里没有' + B.short + '</div>'
        : !have
          ? '<div class="tc-state new">用掉 Lv ' + best + ' 的那颗，学会「' + sk.name + '」' + (S.bar.indexOf(null) >= 0 ? '，并放进技能栏的空格' : '') + '</div>'
          : best > have
            ? '<div class="tc-state new">用掉 Lv ' + best + ' 的那颗，「' + sk.name + '」Lv ' + have + ' → Lv ' + best + '</div>'
            : '<div class="tc-state dup">最高的一颗是 Lv ' + best + '，不高于当前的 Lv ' + have + '</div>';
      state += '<div class="tc-hint">点一下选中，再点一次确认</div>';
    }
    const kind = (lootLvl ? '技能宝石 · Lv ' + lootLvl + ' · ' : '') + '持有 ' + gems.length + ' 颗' + (gems.length ? ' · 最高 Lv ' + gems[0] : '');
    return (
      '<div class="tcard" style="--c:' + B.color + '">' + tcHead(ibox(IC.blank(), 'gemb'), B.name, kind) +
      '<div class="tc-desc">' + B.desc + '。</div>' +
      '<div class="tc-foot">学会的技能等级就是宝石的等级；同时有好几颗时，总是先用等级最高的那颗</div>' + state + '</div>'
    );
  }

  function tipHtml(kind, id) {
    if (kind === 'item') {
      const f = findItem(id);
      if (!f) return '';
      return itemTip(f.item, f.equipped, f.equipped ? '右键 卸下 · 拖到背包 卸下' : '右键 装备 · 拖动 整理 / 换装 · Shift+点击 分解');
    }
    if (kind === 'cur') {
      const c = G.CURRENCY[id];
      const n = G.save.cur[id] || 0;
      return (
        '<div class="tcard" style="--c:' + c.color + '">' + tcHead(ibox(IC.cur(id), 'curb'), c.name, '通货 · 持有 ' + n) +
        '<div class="tc-desc">' + c.desc + '</div>' +
        '<div class="tc-hint' + (n ? '' : ' dim') + '">' + (n ? '拖到一件物品上使用' : '还没有这种通货 · 怪物掉落，或分解装备获得') + '</div></div>'
      );
    }
    if (kind === 'aff') {
      // 详情里的一条词缀：它所在的阶、每一阶的数值范围
      const cut = id.lastIndexOf(':');
      const f = findItem(id.slice(0, cut));
      const af = f && f.item.affixes[+id.slice(cut + 1)];
      if (!af) return '';
      const def = G.AFFIX_BY_ID[af.id];
      const top = maxTierFor(f.item.ilvl);
      const r = tierRange(def, af.tier);
      const span = r[1] - r[0];
      let rows = '';
      for (let t = 0; t < G.TIER_ILVL.length; t++) {
        const tr = tierRange(def, t);
        const sample = G.fmtStat(def.stat, tr[0]) === G.fmtStat(def.stat, tr[1]) ? String(tr[0]) : tr[0] + ' – ' + tr[1];
        rows +=
          '<div class="tr-row' + (t === af.tier ? ' now' : '') + (t > top ? ' off' : '') + '"><span class="ic-tier t' + (t + 1) + '">T' + (t + 1) + '</span>' +
          '<b>' + sample + '</b><em>物品等级 ' + G.TIER_ILVL[t] + '+</em></div>';
      }
      return (
        '<div class="tcard"><div class="tc-name">' + def.label + '</div>' +
        '<div class="tc-kind">' + (def.type === 'prefix' ? '前缀' : '后缀') + ' · 第 ' + (af.tier + 1) + ' 阶 / 共 ' + G.TIER_ILVL.length + ' 阶</div>' +
        '<div class="tc-stat">' + esc(G.fmtStat(def.stat, af.v)) + '</div>' +
        '<div class="tr-bar"><i style="width:' + (span > 0 ? Math.round(((af.v - r[0]) / span) * 100) : 100) + '%"></i></div>' +
        '<div class="tc-foot">本阶范围 ' + r[0] + ' – ' + r[1] + (span > 0 ? ' · 重铸石可在范围内重掷' : '') + '</div>' +
        '<div class="tr-list">' + rows + '</div>' +
        '<div class="tc-foot">这件物品（等级 ' + f.item.ilvl + '）最高可出现第 ' + (top + 1) + ' 阶</div></div>'
      );
    }
    if (kind === 'blank') return blankTip(id);
    if (kind === 'txt') return '<div class="tcard slim"><div class="tc-desc">' + esc(id) + '</div></div>';
    if (kind === 'skdrag') {
      const sk = G.SKILLS[id];
      return '<div class="tcard slim" style="--c:' + sk.color + '"><div class="tc-name">' + sk.name + '</div><div class="tc-hint">拖到技能栏的格子里绑定按键</div></div>';
    }
    if (kind === 'sock') {
      const sp = G.SUPPORTS[id];
      return (
        '<div class="tcard" style="--c:' + IC.supColor(id) + '">' + tcHead(ibox(IC.sup(id), 'gemb'), sp.name, '辅助宝石') + '<div class="tc-desc">' + sp.desc + '</div>' +
        '<div class="tc-foot">魔力消耗 ×' + sp.cost + (sp.req || sp.no ? ' · 适用：' + scopeText(sp) : '') + '</div>' +
        '<div class="tc-hint">点击取下 · 拖到别的辅助槽移动</div></div>'
      );
    }
    if (kind === 'node') {
      const n = G.TREE[id];
      const alloc = G.save.passives.includes(id);
      const avail = !alloc && n.links.some((l) => G.save.passives.includes(l));
      let lines = '';
      for (const k in n.stats) lines += '<div class="tc-stat">' + esc(G.fmtStat(k, n.stats[k])) + '</div>';
      let hint;
      if (n.kind === 'start') hint = '<div class="tc-desc">所有支路从这里出发。</div>';
      else if (alloc) hint = '<div class="tc-hint ok">已点亮 · 点击退回</div>';
      else if (avail) hint = '<div class="tc-hint">' + (G.passivePoints().free > 0 ? '点击点亮' : '可点亮 · 没有可用的天赋点') + '</div>';
      else hint = '<div class="tc-hint dim">尚未连接 · 需要先点亮相邻的天赋</div>';
      return (
        '<div class="tcard" style="--c:' + (n.color || '#ffb066') + '"><div class="tc-name">' + n.name + '</div>' +
        '<div class="tc-kind">' + KIND_NAME[n.kind] + (ARM_INFO[n.arm] ? ' · ' + ARM_INFO[n.arm].name : '') + '</div>' + lines + hint + '</div>'
      );
    }
    return '';
  }

  // 把提示框摆到矩形 r 旁边：优先右侧，放不下就左侧，再不行就贴边并躲到上 / 下方
  function placeTip(r, preferLeft) {
    const tip = el.tip;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = r.right + 12;
    if (x + w > vw - 8 || (preferLeft && r.left - 12 - w >= 8)) x = r.left - 12 - w;
    if (x < 8) x = G.clamp(r.left, 8, Math.max(8, vw - w - 8));
    let y = G.clamp(r.top - 6, 8, Math.max(8, vh - h - 8));
    if (x < r.right && x + w > r.left && y < r.bottom && y + h > r.top) {
      y = r.bottom + 10 + h <= vh - 8 ? r.bottom + 10 : Math.max(8, r.top - 10 - h);
    }
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
  }
  function showTip(target) {
    if (drag.on) return;
    const key = target.dataset.tip;
    const cut = key.indexOf(':');
    const kind = key.slice(0, cut);
    const id = key.slice(cut + 1);
    const html = tipHtml(kind, id);
    if (!html) return hideTip();
    ui.tipEl = target;
    ui.groundLoot = null;
    el.tip.innerHTML = html;
    el.tip.classList.add('on');
    placeTip(target.getBoundingClientRect());
    // 看过了：去掉「新」标记
    if (kind === 'item' && ui.fresh.delete(id)) {
      const dot = target.querySelector('.c-new');
      if (dot) dot.remove();
    }
  }
  function hideTip() {
    if (!ui.tipEl && !el.tip.classList.contains('on')) return;
    ui.tipEl = null;
    ui.groundLoot = null;
    ui.groundSig = '';
    el.tip.classList.remove('on');
  }
  // 重渲染之后，鼠标下面的元素换了一批：按鼠标位置重新决定提示
  function retip() {
    if (ui.mouseX < 0 || !ui.isOpen || drag.on) return hideTip();
    const under = document.elementFromPoint(ui.mouseX, ui.mouseY);
    const t = under && under.closest('[data-tip]');
    if (t) showTip(t);
    else hideTip();
  }

  // ============================================================
  // 面板操作
  // ============================================================
  const selItem = () => (ui.sel ? findItem(ui.sel) : null);
  function equipSel(item) {
    if (G.equip(item)) {
      ui.invMsg = '';
      G.sfx('pickup');
    } else {
      ui.invMsg = '无法装备这件物品';
    }
    render();
  }

  const ACT = {
    tab(d) {
      G.sfx('click');
      open(d.tab);
    },
    close() {
      G.sfx('click');
      close();
    },

    // ---- 背包 ----
    sel(d, a, e) {
      const f = findItem(d.item);
      if (!f) return;
      const now = performance.now();
      if (e && e.shiftKey) {
        // Shift+点击：分解背包物品；稀有物品要再点一次确认
        if (f.equipped) {
          ui.invMsg = '穿在身上的装备要先卸下才能分解';
        } else if (f.item.rarity >= 2 && !(ui.salvArm.uid === d.item && now - ui.salvArm.t < 3000)) {
          ui.salvArm = { uid: d.item, t: now };
          ui.sel = d.item;
          ui.invMsg = '再 Shift+点击一次，确认分解稀有物品「' + f.item.name + '」';
          G.sfx('click');
        } else {
          ui.salvArm = { uid: null, t: 0 };
          if (G.salvage(f.item)) {
            if (ui.sel === d.item) ui.sel = null;
            ui.fresh.delete(d.item);
            ui.invMsg = '';
            G.sfx('craft');
          }
        }
        ui.lastSel = { uid: null, t: 0 };
        render();
        return;
      }
      if (!f.equipped && ui.lastSel.uid === d.item && now - ui.lastSel.t < 380) {
        // 双击背包物品 → 装备
        ui.lastSel = { uid: null, t: 0 };
        ui.sel = d.item;
        equipSel(f.item);
        return;
      }
      ui.lastSel = { uid: d.item, t: now };
      if (ui.sel !== d.item) {
        ui.sel = d.item;
        ui.invMsg = '';
        G.sfx('click');
        render();
      }
    },
    equip() {
      const f = selItem();
      if (f) equipSel(f.item);
    },
    unequip() {
      const f = selItem();
      if (!f) return;
      ui.invMsg = G.unequip(f.item.slot) ? '' : '背包已满，无法卸下';
      G.sfx('click');
      render();
    },
    salvage() {
      const f = selItem();
      if (!f) return;
      if (G.salvage(f.item)) {
        ui.sel = null;
        ui.invMsg = '';
        G.sfx('craft');
      } else {
        ui.invMsg = '无法分解这件物品';
      }
      render();
    },
    'salvage-all'() {
      const r = G.salvageBulk(G.save.opts.salvageMagic ? 1 : 0);
      if (r) {
        // 一行小结：分解了几件、换回了什么
        const parts = [];
        if (r.byRarity[0]) parts.push('普通 ' + r.byRarity[0]);
        if (r.byRarity[1]) parts.push('魔法 ' + r.byRarity[1]);
        const got = Object.keys(r.gained).map((id) => '<span class="res-cur" style="--c:' + G.CURRENCY[id].color + '">' + IC.cur(id) + G.CURRENCY[id].name + ' ×' + r.gained[id] + '</span>').join('');
        ui.bagMsg = '<b>分解了 ' + r.n + ' 件</b><span>' + parts.join(' · ') + '</span><i></i>' + (got ? '<span>获得</span>' + got : '<span>没有分解出通货（普通物品不含通货）</span>');
        for (const uid of Array.from(ui.fresh)) if (!findItem(uid)) ui.fresh.delete(uid);
        if (ui.sel && !findItem(ui.sel)) ui.sel = null;
        G.sfx('craft');
      }
      render();
    },
    sort() {
      G.sortBag();
      G.sfx('click');
      render();
    },
    // 存档里的布尔选项开关
    opt(d) {
      const o = G.save.opts;
      if (!(d.opt in o)) return;
      o[d.opt] = !o[d.opt];
      G.persist();
      G.sfx('click');
      render();
    },
    normmode(d) {
      const o = G.save.opts;
      o.autoWhite = d.mode !== 'manual';
      o.autoSalvage = d.mode === 'scrap';
      G.persist();
      G.sfx('click');
      render();
    },
    drop() {
      const f = selItem();
      if (f && !f.equipped) askDrop(f.item, ui.mouseX, ui.mouseY);
    },
    'drop-yes'() {
      const c = ui.confirm;
      ui.confirm = null;
      const f = c ? findItem(c.uid) : null;
      if (f && !f.equipped) dropToGround(f.item);
      render();
    },
    'drop-no'() {
      ui.confirm = null;
      G.sfx('click');
      render();
    },
    'tut-reset'() {
      G.save.tut = {};
      G.persist();
      coach.cur = null;
      coach.gapT = 0;
      coach.vet = false; // 玩家自己要求从头再看一遍：基础操作的提示也照出
      coach.snooze = {};
      coach.shows = {};
      el.coach.className = '';
      ui.tutMsg = '已重置，提示会在用得上的时候再次出现';
      G.sfx('click');
      render();
    },
    craft(d) {
      const f = selItem();
      if (!f) return;
      if (G.applyCurrency(f.item, d.cur)) {
        ui.invMsg = '';
        ui.flash = true;
        G.sfx('craft');
      } else {
        ui.invMsg = '这件物品现在不能使用' + G.CURRENCY[d.cur].name;
      }
      render();
    },

    // ---- 技能 ----
    bind(d) {
      const slot = +d.slot;
      G.bindSkill(slot, G.save.bar[slot] === d.skill ? null : d.skill);
      G.sfx('click');
      render();
    },
    socket(d) {
      const idx = +d.idx;
      const socks = G.save.sockets[d.skill];
      if (socks && socks[idx]) {
        // 已镶嵌：点击取下
        G.socketSupport(d.skill, idx, null);
        ui.picker = null;
      } else if (ui.picker && ui.picker.skill === d.skill && ui.picker.idx === idx) {
        ui.picker = null;
      } else {
        ui.picker = { skill: d.skill, idx };
      }
      G.sfx('click');
      render();
    },
    // 无铭技能宝石：第一下选中（按钮变成「再点一次」），几秒内再点同一个才真的用掉
    blank(d) {
      const id = d.skill;
      const sk = G.SKILLS[id];
      if (!sk) return;
      clearTimeout(ui.blankTimer);
      if (ui.blankArm !== id) {
        ui.blankArm = id;
        ui.blankMsg = '';
        ui.blankTimer = setTimeout(() => {
          ui.blankArm = null;
          if (ui.isOpen && ui.tab === 'skills') render();
        }, BLANK_ARM_MS);
        G.sfx('click');
        render();
        return;
      }
      ui.blankArm = null;
      const r = G.useBlankGem(id);
      if (!r) ui.blankMsg = '<span class="bad">' + sk.name + '现在不能用' + G.BLANK_GEM.short + '：需要比当前等级更高的那颗</span>';
      else if (r.from) ui.blankMsg = '「' + sk.name + '」从 Lv ' + r.from + ' 升到了 Lv ' + r.lvl;
      else ui.blankMsg = '学会了「' + sk.name + '」Lv ' + r.lvl + (r.slot >= 0 ? '，已放进技能栏的 <kbd>' + KEY_LABEL[r.slot] + '</kbd>' : '，技能栏满了：点它卡片上的按键标签绑定');
      render();
    },
    pick(d) {
      const pk = ui.picker;
      if (!pk) return;
      // 一颗辅助宝石只能镶在一处：先从原来的技能上取下再镶过来
      const loc = supLocation(d.sup);
      if (loc) G.socketSupport(loc.skill, loc.idx, null);
      if (G.socketSupport(pk.skill, pk.idx, d.sup)) G.sfx('gem');
      ui.picker = null;
      render();
    },

    // ---- 天赋 ----
    node(d) {
      const id = d.node;
      const n = G.TREE[id];
      if (n.kind === 'start') return;
      if (G.save.passives.includes(id)) {
        if (G.refundPassive(id)) {
          ui.treeMsg = '已退回「' + n.name + '」';
          ui.treeMsgBad = false;
          G.sfx('click');
        } else {
          ui.treeMsg = '无法退回「' + n.name + '」：它后面的天赋会与起点断开';
          ui.treeMsgBad = true;
        }
      } else if (G.allocPassive(id)) {
        ui.treeMsg = '已点亮「' + n.name + '」';
        ui.treeMsgBad = false;
        G.sfx(n.kind === 'small' ? 'pickup' : 'gem');
      } else {
        ui.treeMsg = G.passivePoints().free <= 0 ? '没有可用的天赋点' : '需要先点亮与「' + n.name + '」相邻的天赋';
        ui.treeMsgBad = true;
      }
      disarmReset();
      render();
    },
    'tree-reset'() {
      if (!ui.resetArmed) {
        ui.resetArmed = true;
        clearTimeout(ui.resetTimer);
        ui.resetTimer = setTimeout(() => {
          ui.resetArmed = false;
          if (ui.isOpen && ui.tab === 'tree') render();
        }, 3500);
        G.sfx('click');
      } else {
        disarmReset();
        if (G.resetPassives()) {
          ui.treeMsg = '已重置全部天赋';
          ui.treeMsgBad = false;
          G.sfx('craft');
        }
      }
      render();
    },

    // ---- 地图 ----
    tier(d) {
      ui.mapTier = +d.tier;
      G.sfx('click');
      render();
    },
    enter(d) {
      G.sfx('click');
      G.enterZone(+d.zone, ui.mapTier);
      close();
    },
    'del-save'() {
      ui.delArmed = true;
      G.sfx('click');
      render();
    },
    'del-cancel'() {
      ui.delArmed = false;
      G.sfx('click');
      render();
    },
    'del-confirm'() {
      G.resetSave();
      location.reload();
    },
  };

  const BLANK_ARM_MS = 4000; // 无铭宝石的「再点一次确认」保持多久
  function disarmReset() {
    ui.resetArmed = false;
    clearTimeout(ui.resetTimer);
    ui.blankArm = null;
    clearTimeout(ui.blankTimer);
  }

  function onPanelClick(e) {
    if (ui.noClick) return; // 拖拽松手带出来的 click：不算点击
    const a = e.target.closest('[data-act]');
    // 选择器 / 确认框开着时，点到别处就先收起
    if (ui.picker && !e.target.closest('#picker') && !(a && a.dataset.act === 'socket')) closePicker();
    if (ui.confirm && !e.target.closest('#confirm')) {
      ui.confirm = null;
      renderConfirm();
    }
    if (!a || a.disabled) return;
    if (a.dataset.act !== 'salvage-all') ui.bagMsg = '';
    if (a.dataset.act !== 'tut-reset') ui.tutMsg = '';
    ACT[a.dataset.act](a.dataset, a, e);
  }

  // 右键：背包物品 → 装备；身上的装备 → 卸下
  function onPanelContext(e) {
    e.preventDefault();
    if (drag.on) return cancelDrag();
    const c = e.target.closest('[data-item]');
    if (!c || !c.dataset.act) return;
    const f = findItem(c.dataset.item);
    if (!f) return;
    ui.bagMsg = '';
    ui.sel = f.item.uid;
    if (f.equipped) {
      ui.invMsg = G.unequip(f.item.slot) ? '' : '背包已满，无法卸下';
      G.sfx('click');
      render();
    } else {
      ui.fresh.delete(f.item.uid);
      equipSel(f.item);
    }
  }

  // ---------- 丢到地上 ----------
  function dropToGround(item) {
    const name = item.name;
    const color = G.RARITY_COLOR[item.rarity];
    const icon = itemIcon(item);
    if (!G.dropItem(item)) {
      ui.invMsg = '现在不能丢弃物品';
      return false;
    }
    if (ui.sel === item.uid) ui.sel = null;
    ui.fresh.delete(item.uid);
    ui.invMsg = '';
    toast('丢下了 ' + name, color, icon);
    G.sfx('drop');
    return true;
  }
  // 稀有物品先问一句；其余直接丢
  function askDrop(item, x, y) {
    if (item.rarity >= 2) {
      ui.confirm = { uid: item.uid, x, y };
      G.sfx('click');
    } else {
      dropToGround(item);
    }
    render();
  }
  function renderConfirm() {
    const box = el.confirm;
    const c = ui.confirm;
    const f = c && ui.isOpen && ui.tab === 'inv' ? findItem(c.uid) : null;
    if (!f || f.equipped) {
      ui.confirm = null;
      box.classList.remove('on');
      return;
    }
    box.innerHTML =
      '<div class="cf-top">' + itemIcon(f.item) + '<div><b style="color:' + G.RARITY_COLOR[f.item.rarity] + '">' + esc(f.item.name) + '</b>' +
      '<span>把这件稀有物品丢到地上？<br>它会留在脚边，离开区域后消失。</span></div></div>' +
      '<div class="cf-row"><button type="button" tabindex="-1" class="btn danger" data-act="drop-yes">丢下</button>' +
      '<button type="button" tabindex="-1" class="btn" data-act="drop-no">取消</button></div>';
    box.classList.add('on');
    box.style.left = Math.round(G.clamp(c.x - box.offsetWidth / 2, 8, window.innerWidth - box.offsetWidth - 8)) + 'px';
    box.style.top = Math.round(G.clamp(c.y - box.offsetHeight - 12, 8, window.innerHeight - box.offsetHeight - 8)) + 'px';
  }

  // ============================================================
  // 打开 / 关闭
  // ============================================================
  function open(tab) {
    if (!RENDER[tab]) tab = 'inv';
    if (ui.intro) closeIntro();
    const wasOpen = ui.isOpen;
    if (!wasOpen || tab !== ui.tab) {
      // 换页时清掉各页的临时状态
      cancelDrag();
      ui.picker = null;
      ui.confirm = null;
      ui.delArmed = false;
      ui.invMsg = '';
      ui.bagMsg = '';
      ui.tutMsg = '';
      ui.treeMsg = '';
      ui.treeMsgBad = false;
      ui.blankMsg = '';
      disarmReset();
      if (tab === 'map') ui.mapTier = G.clamp(G.state.tier || 0, 0, G.save.maxTier);
    }
    ui.tab = tab;
    ui.isOpen = true;
    el.panel.classList.add('on');
    document.body.classList.add('panel-open');
    hideTip();
    render();
  }

  function close() {
    if (ui.intro) closeIntro();
    if (!ui.isOpen) return;
    cancelDrag();
    ui.isOpen = false;
    ui.picker = null;
    ui.confirm = null;
    disarmReset();
    el.panel.classList.remove('on');
    el.picker.classList.remove('on');
    el.confirm.classList.remove('on');
    document.body.classList.remove('panel-open');
    hideTip();
    hud.costT = -1e9;
    G.persist();
  }

  function toggle(tab) {
    if (ui.isOpen && ui.tab === tab) close();
    else open(tab);
  }

  function refresh() {
    hud.costT = -1e9;
    render();
  }

  function showHelp() {
    G.save.seenHelp = true;
    open('help');
  }

  // 开场卡片：只讲三件事，其余交给之后的情境提示。开着的时候游戏暂停
  function showIntro() {
    G.save.seenHelp = true;
    ui.intro = true;
    el.intro.classList.add('on');
  }
  function closeIntro() {
    if (!ui.intro) return;
    ui.intro = false;
    el.intro.classList.remove('on');
    G.sfx('click');
  }

  // ============================================================
  // 拖拽（指针事件 + 跟手的幽灵图标；不用 HTML5 DnD）
  // 来源：[data-drag="kind:id"]，kind = item / cur / sup / skill
  // ============================================================
  const drag = { on: false, armed: null, kind: '', id: '', src: null, hover: null, info: null, x: 0, y: 0, item: null, equipped: false, from: null, fromSlot: -1 };
  const NO_DROP = { el: null, ok: false, label: '', run: null };

  function dragDown(e) {
    drag.armed = null;
    if (e.button !== 0 || !ui.isOpen || drag.on) return;
    const src = e.target.closest ? e.target.closest('[data-drag]') : null;
    if (!src || !el.panel.contains(src)) return;
    const key = src.dataset.drag;
    const cut = key.indexOf(':');
    drag.armed = { kind: key.slice(0, cut), id: key.slice(cut + 1), src, x: e.clientX, y: e.clientY };
  }
  function dragMove(e) {
    if (drag.on) return dragTrack(e.clientX, e.clientY);
    const a = drag.armed;
    if (!a) return;
    if (!(e.buttons & 1)) {
      drag.armed = null;
      return;
    }
    if (Math.hypot(e.clientX - a.x, e.clientY - a.y) < 6) return; // 没挪出几像素：还是一次点击
    drag.armed = null;
    dragStart(a, e.clientX, e.clientY);
  }
  function dragUp(e) {
    drag.armed = null;
    if (!drag.on) return;
    dragTrack(e.clientX, e.clientY);
    const info = drag.info;
    endDrag();
    swallowClick();
    if (info && info.ok && info.run) {
      info.run();
    } else if (info && info.label && !info.ok) {
      if (ui.tab === 'inv') ui.invMsg = info.label;
      G.sfx('deny');
    }
    render();
  }

  function dragStart(a, x, y) {
    let icon;
    drag.item = null;
    drag.equipped = false;
    drag.from = null;
    drag.fromSlot = -1;
    if (a.kind === 'item') {
      const f = findItem(a.id);
      if (!f) return;
      drag.item = f.item;
      drag.equipped = f.equipped;
      icon = itemIcon(f.item);
    } else if (a.kind === 'cur') {
      if (!G.CURRENCY[a.id] || !(G.save.cur[a.id] > 0)) return;
      icon = ibox(IC.cur(a.id), 'curb');
    } else if (a.kind === 'sup') {
      if (!G.SUPPORTS[a.id]) return;
      if (a.src.classList.contains('sock')) drag.from = { skill: a.src.dataset.skill, idx: +a.src.dataset.idx };
      icon = ibox(IC.sup(a.id), 'gemb');
    } else if (a.kind === 'skill') {
      if (!G.SKILLS[a.id] || !G.save.skills[a.id]) return;
      if (a.src.classList.contains('barslot')) drag.fromSlot = +a.src.dataset.slot;
      icon = '<span class="ibox sk" style="--c:' + G.SKILLS[a.id].color + '">' + IC.skill(a.id) + '</span>';
    } else {
      return;
    }
    drag.on = true;
    drag.kind = a.kind;
    drag.id = a.id;
    drag.src = a.src;
    drag.hover = null;
    drag.info = NO_DROP;
    closePicker();
    if (ui.confirm) {
      ui.confirm = null;
      renderConfirm();
    }
    hideTip();
    a.src.classList.add('drag-src');
    el.ghost.innerHTML = icon + '<em></em>';
    el.ghost.className = 'on';
    document.body.classList.add('dragging');
    markTargets();
    dragTrack(x, y);
    G.sfx('click');
  }

  // 拖起来的瞬间把所有落点标出来：能放的亮，不能放的暗
  function markTargets() {
    const body = el.body;
    if (drag.kind === 'item') {
      if (!drag.equipped) {
        body.querySelectorAll('.eq').forEach((n) => n.classList.add(n.dataset.slot === drag.item.slot ? 'drop-ok' : 'drop-no'));
      } else {
        const bag = body.querySelector('.bag');
        if (bag) bag.classList.add('drop-zone');
      }
    } else if (drag.kind === 'cur') {
      body.querySelectorAll('.cell[data-item], .eq[data-item], .detail-card[data-item]').forEach((n) => {
        const f = findItem(n.dataset.item);
        n.classList.add(f && G.canCraft(f.item, drag.id) ? 'drop-ok' : 'drop-no');
      });
    } else if (drag.kind === 'sup') {
      body.querySelectorAll('.sock').forEach((n) => n.classList.add(G.supportFits(n.dataset.skill, drag.id) ? 'drop-ok' : 'drop-no'));
    } else if (drag.kind === 'skill') {
      body.querySelectorAll('.barslot').forEach((n) => n.classList.add('drop-ok'));
    }
  }

  function unequipTo(item, idx) {
    if (!G.unequip(item.slot)) {
      ui.invMsg = '背包已满，无法卸下';
      return;
    }
    if (idx >= 0) G.moveBagItem(item, idx);
    ui.invMsg = '';
    G.sfx('drop');
  }
  function socketDrop(skill, idx) {
    const from = drag.from;
    const sup = drag.id;
    const displaced = (G.save.sockets[skill] || [])[idx] || null;
    if (!G.socketSupport(skill, idx, sup)) return;
    // 从别的孔拖过来、目标孔里原本有宝石：能放回去就两颗对调
    if (from && displaced && displaced !== sup && G.supportFits(from.skill, displaced)) G.socketSupport(from.skill, from.idx, displaced);
    G.sfx('gem');
  }

  // 指针下面是 under 时，松手会发生什么
  function dropInfo(under) {
    const q = (sel) => (under && under.closest ? under.closest(sel) : null);
    const inWin = !!q('#panel-win');
    const save = G.save;
    if (drag.kind === 'item') {
      const item = drag.item;
      if (!inWin) {
        if (drag.equipped) return { el: null, ok: false, label: '先卸下，才能丢弃', run: null };
        const x = drag.x, y = drag.y;
        return { el: null, ok: true, label: '丢到地上', run: () => askDrop(item, x, y) };
      }
      const eqEl = q('.eq');
      if (eqEl) {
        if (drag.equipped) return NO_DROP;
        if (eqEl.dataset.slot !== item.slot) return { el: eqEl, ok: false, label: '这一格只能放' + G.SLOT_NAME[eqEl.dataset.slot], run: null };
        const old = save.equip[item.slot];
        return {
          el: eqEl, ok: true, label: old ? '替换 ' + old.name : '装备',
          run: () => {
            ui.sel = item.uid;
            ui.fresh.delete(item.uid);
            equipSel(item);
          },
        };
      }
      const cell = q('.cell');
      if (cell) {
        const idx = +cell.dataset.idx;
        if (!drag.equipped) {
          if (cell === drag.src) return NO_DROP;
          if (!cell.dataset.item) {
            // 背包是紧凑排列的：拖到空格 = 排到队尾。把真正的落点（第一个空格）亮出来，话也照实说
            const n = save.bag.length;
            if (save.bag[n - 1] === item) return NO_DROP; // 已经在队尾了
            return {
              el: el.body.querySelector('.cell[data-idx="' + n + '"]') || cell, ok: true, label: '移到末尾',
              run: () => {
                G.moveBagItem(item, n);
                G.sfx('drop');
              },
            };
          }
          return {
            el: cell, ok: true, label: '交换位置',
            run: () => {
              G.moveBagItem(item, idx);
              G.sfx('drop');
            },
          };
        }
        const other = cell.dataset.item ? findItem(cell.dataset.item) : null;
        if (other && other.item.slot === item.slot) {
          return {
            el: cell, ok: true, label: '换上 ' + other.item.name,
            run: () => {
              ui.sel = other.item.uid;
              ui.fresh.delete(other.item.uid);
              equipSel(other.item);
            },
          };
        }
        if (save.bag.length >= G.BAG_SIZE) return { el: cell, ok: false, label: '背包已满，无法卸下', run: null };
        return { el: cell, ok: true, label: '卸下', run: () => unequipTo(item, idx) };
      }
      if (drag.equipped && q('.col-m')) {
        const bag = el.body.querySelector('.bag');
        if (save.bag.length >= G.BAG_SIZE) return { el: bag, ok: false, label: '背包已满，无法卸下', run: null };
        return { el: bag, ok: true, label: '卸下', run: () => unequipTo(item, -1) };
      }
      return NO_DROP;
    }
    if (drag.kind === 'cur') {
      const t = inWin ? q('[data-item]') : null;
      const f = t ? findItem(t.dataset.item) : null;
      if (!f) return NO_DROP;
      const id = drag.id;
      const c = G.CURRENCY[id];
      if (!G.canCraft(f.item, id)) return { el: t, ok: false, label: G.craft(f.item, id).msg || '不能对它使用' + c.name, run: null };
      return {
        el: t, ok: true, label: '对「' + f.item.name + '」使用' + c.name,
        run: () => {
          if (G.applyCurrency(f.item, id)) {
            ui.sel = f.item.uid;
            ui.invMsg = '';
            ui.flash = true;
            G.sfx('craft');
          }
        },
      };
    }
    if (drag.kind === 'sup') {
      const sock = inWin ? q('.sock') : null;
      if (sock) {
        const skill = sock.dataset.skill;
        const idx = +sock.dataset.idx;
        if (drag.from && drag.from.skill === skill && drag.from.idx === idx) return NO_DROP;
        if (!G.supportFits(skill, drag.id)) return { el: sock, ok: false, label: unfitText(skill, G.SUPPORTS[drag.id]), run: null };
        return { el: sock, ok: true, label: '镶进 ' + G.SKILLS[skill].name, run: () => socketDrop(skill, idx) };
      }
      if (drag.from && inWin && q('.col-side')) {
        const from = drag.from;
        return {
          el: el.body.querySelector('.sup-list'), ok: true, label: '取下',
          run: () => {
            G.socketSupport(from.skill, from.idx, null);
            G.sfx('click');
          },
        };
      }
      return NO_DROP;
    }
    if (drag.kind === 'skill') {
      const bs = inWin ? q('.barslot') : null;
      const id = drag.id;
      if (bs) {
        const slot = +bs.dataset.slot;
        if (slot === drag.fromSlot) return NO_DROP;
        return {
          el: bs, ok: true, label: '绑定到 ' + KEY_LABEL[slot],
          run: () => {
            G.bindSkill(slot, id);
            G.sfx('pickup');
          },
        };
      }
      if (drag.fromSlot >= 0 && inWin && !q('.barstrip')) {
        const slot = drag.fromSlot;
        return {
          el: null, ok: true, label: '移出技能栏',
          run: () => {
            G.bindSkill(slot, null);
            G.sfx('click');
          },
        };
      }
    }
    return NO_DROP;
  }

  function dragTrack(x, y) {
    drag.x = x;
    drag.y = y;
    el.ghost.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    const info = dropInfo(document.elementFromPoint(x, y));
    if (drag.hover !== info.el || (drag.info && drag.info.ok !== info.ok)) {
      if (drag.hover) drag.hover.classList.remove('drop-hover', 'drop-bad');
      drag.hover = info.el;
      if (info.el) info.el.classList.add(info.ok ? 'drop-hover' : 'drop-bad');
    }
    drag.info = info;
    const cap = el.ghost.lastChild;
    if (cap.textContent !== info.label) cap.textContent = info.label;
    el.ghost.classList.toggle('ok', info.ok && !!info.label);
    el.ghost.classList.toggle('bad', !info.ok && !!info.label);
  }

  function endDrag() {
    drag.on = false;
    drag.hover = null;
    drag.info = null;
    el.ghost.className = '';
    document.body.classList.remove('dragging');
    el.panel.querySelectorAll('.drag-src, .drop-ok, .drop-no, .drop-hover, .drop-bad, .drop-zone').forEach((n) => {
      n.classList.remove('drag-src', 'drop-ok', 'drop-no', 'drop-hover', 'drop-bad', 'drop-zone');
    });
  }
  // Esc / 右键 / 失焦 / 换页：放弃这次拖拽，什么都不改
  function cancelDrag() {
    drag.armed = null;
    if (!drag.on) return false;
    endDrag();
    retip();
    return true;
  }
  // 松手后浏览器会立刻补一个 click（同一轮事件里）；只吞掉这一个，不影响玩家随后的真实点击
  function swallowClick() {
    ui.noClick = true;
    setTimeout(() => {
      ui.noClick = false;
    }, 0);
  }

  // ============================================================
  // 世界层：准星、脚下的生命 / 魔力弧、敌人名牌、方向箭头、地面掉落（提示 + 名牌文字）、拾取记录
  // ============================================================
  const wui = {
    ret: null, retState: 'off', arc: null, arcOn: null, arcX: 0, arcY: 0, lifeEl: null, manaEl: null, lifeQ: -1, manaQ: -1, lifeLow: null,
    plate: null, plateSig: '', plateOn: false, busyAt: -1e9, hits: -1, arrows: [], cands: [], tipX: 0, tipY: 0,
    feed: null, feedList: [],
    exec: null, execTxt: null, execOn: false, execFar: null, execX: -1, execY: -1,
    mplate: null, mpSig: '', mpOn: false, mpX: -1, mpY: -1,
  };

  function initWorldUi() {
    const root = $('wui');
    const arcL = 'M-5,23 C-24,23 -41,15 -45,2';
    const arcR = 'M5,23 C24,23 41,15 45,2';
    root.innerHTML =
      '<div id="parc"><svg viewBox="-52 -6 104 36" width="104" height="36">' +
      '<path class="pa-edge" d="' + arcL + '"/><path class="pa-edge" d="' + arcR + '"/>' +
      '<path class="pa-track" d="' + arcL + '"/><path class="pa-track" d="' + arcR + '"/>' +
      '<path class="pa-life" d="' + arcL + '" pathLength="100"/><path class="pa-mana" d="' + arcR + '" pathLength="100"/>' +
      '</svg></div><div id="nameplate"></div><div id="mplate"></div><div id="arrows"></div>' +
      '<div id="execp"><div class="ep"><kbd>F</kbd><span></span></div><i></i></div>';
    wui.exec = $('execp');
    wui.execTxt = wui.exec.querySelector('span');
    wui.arc = $('parc');
    wui.lifeEl = root.querySelector('.pa-life');
    wui.manaEl = root.querySelector('.pa-mana');
    wui.plate = $('nameplate');
    wui.mplate = $('mplate');
    const box = $('arrows');
    for (let i = 0; i < 6; i++) {
      const d = document.createElement('div');
      d.className = 'arrow';
      d.innerHTML = '<i></i><b></b>';
      box.appendChild(d);
      wui.arrows.push({ el: d, tip: d.firstChild, txt: d.lastChild, on: false, kind: '', x: -1, y: -1, a: 99 });
    }
    wui.ret = $('reticle');
    wui.ret.innerHTML = '<i class="r-ring"></i><i class="r-dot"></i><i class="r-t t1"></i><i class="r-t t2"></i><i class="r-t t3"></i><i class="r-t t4"></i>';
    wui.feed = $('feed');
  }

  // 鼠标指着哪个敌人：先用鼠标的地面落点粗筛，再按屏幕上「脚 → 头」的一条胶囊判定
  function enemyAt(mx, my) {
    const W = G.world;
    const m = G.input.mouse;
    const es = G.state.enemies;
    let best = null;
    let bd = 1e9;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead) continue;
      const h = (e.height || 1.8) * (e.elite ? 1.3 : 1);
      const dx = e.x - m.wx;
      const dz = e.z - m.wz;
      const reach = e.r + h * 1.6 + 1;
      if (dx * dx + dz * dz > reach * reach) continue;
      const f = W.project(e.x, 0, e.z);
      if (!f.ok) continue;
      const t = W.project(e.x, h, e.z);
      const s = W.project(e.x + e.r, 0, e.z);
      const rpx = Math.max(16, (s.x - f.x) * 1.2);
      const ty = G.clamp(my, t.y, f.y);
      const k = f.y !== t.y ? (ty - t.y) / (f.y - t.y) : 0;
      const d = Math.hypot(mx - (t.x + (f.x - t.x) * k), my - ty);
      if (d <= rpx && d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  // 召唤物的身高（世界单位）：名牌和悬停判定用
  const MINION_H = { thrall: 1.75, colossus: 2.9 };
  // 鼠标指着哪只召唤物（判定方法与 enemyAt 相同）
  function minionAt(mx, my) {
    const ms = liveMinions();
    if (!ms.length) return null;
    const W = G.world;
    const m = G.input.mouse;
    let best = null;
    let bd = 1e9;
    for (let i = 0; i < ms.length; i++) {
      const x = ms[i];
      if (!x || x.dead) continue;
      const h = x.height || MINION_H[x.kind] || 1.8;
      const r = x.r || (x.kind === 'colossus' ? 1.1 : 0.5);
      const dx = x.x - m.wx;
      const dz = x.z - m.wz;
      const reach = r + h * 1.6 + 1;
      if (dx * dx + dz * dz > reach * reach) continue;
      const f = W.project(x.x, 0, x.z);
      if (!f.ok) continue;
      const t = W.project(x.x, h, x.z);
      const s = W.project(x.x + r, 0, x.z);
      const rpx = Math.max(14, (s.x - f.x) * 1.2);
      const ty = G.clamp(my, t.y, f.y);
      const k = f.y !== t.y ? (ty - t.y) / (f.y - t.y) : 0;
      const d = Math.hypot(mx - (t.x + (f.x - t.x) * k), my - ty);
      if (d <= rpx && d < bd) {
        bd = d;
        best = x;
      }
    }
    return best;
  }
  // 召唤物的小名牌：名字、生命、在做什么（守像另写嘲讽冷却）
  function minionPlate(x) {
    const p = wui.mplate;
    if (!x) {
      if (wui.mpOn) {
        wui.mpOn = false;
        wui.mpSig = '';
        p.classList.remove('on');
      }
      return;
    }
    const sk = x.skill && G.SKILLS[x.skill];
    const name = x.name || MINION_NAME[x.kind] || (sk ? sk.name : '召唤物');
    const tg = x.target && !x.target.dead ? x.target : null;
    const focus = typeof G.focusTarget === 'function' ? G.focusTarget() : null;
    const doing = x.rising > 0 ? '正在现身' : tg ? (tg === focus ? '集火 ' : '攻击 ') + tg.name : '跟随中';
    const taunt = x.kind === 'colossus' && x.tauntCdMax > 0 ? (x.tauntCd > 0.05 ? '嘲讽 ' + Math.ceil(x.tauntCd) + ' 秒' : '嘲讽就绪') : '';
    const sig = name + '|' + Math.ceil(x.hp) + '|' + x.maxHp + '|' + doing + '|' + taunt;
    if (sig !== wui.mpSig) {
      wui.mpSig = sig;
      p.className = 'on ' + (x.kind === 'colossus' ? 'colossus' : 'thrall');
      p.innerHTML =
        '<div class="mp-top"><b>' + esc(name) + '</b><em>召唤物</em></div>' +
        '<div class="mp-hp"><i style="width:' + Math.round(G.clamp(x.maxHp > 0 ? x.hp / x.maxHp : 0, 0, 1) * 100) + '%"></i><span>' + fmtInt(Math.max(0, Math.ceil(x.hp))) + ' / ' + fmtInt(x.maxHp) + '</span></div>' +
        '<div class="mp-note"><span' + (tg && tg === focus ? ' class="focus"' : '') + '>' + esc(doing) + '</span>' + (taunt ? '<span class="' + (x.tauntCd > 0.05 ? '' : 'ready') + '">' + taunt + '</span>' : '') + '</div>';
    }
    wui.mpOn = true;
    const q = G.world.project(x.x, (x.height || MINION_H[x.kind] || 1.8) + 0.45, x.z);
    const px = Math.round(q.x);
    const py = Math.round(q.y - 8);
    if (px !== wui.mpX || py !== wui.mpY) {
      wui.mpX = px;
      wui.mpY = py;
      p.style.transform = 'translate(' + px + 'px,' + py + 'px) translate(-50%,-100%)';
    }
  }

  // 地面掉落的一行概要与升降标记（半秒重算一次）
  function lootInfo(l, now) {
    let u = l.ui;
    if (!u) u = l.ui = { base: l.label, t: -1e9, badge: '', alt: '', normal: false };
    if (now - u.t < 500) return u;
    u.t = now;
    const save = G.save;
    if (l.kind === 'item') {
      const v = verdict(l.data);
      u.badge = v ? VD_GLYPH[v.badge] : '';
      u.alt = G.RARITY_NAME[l.data.rarity] + ' ' + G.SLOT_NAME[l.data.slot] + ' · 物品等级 ' + l.data.ilvl;
      u.normal = l.data.rarity === 0;
    } else if (l.kind === 'cur') {
      u.alt = '通货 · 已有 ' + (save.cur[l.data] || 0);
    } else if (l.kind === 'skill') {
      const have = save.skills[l.data.id];
      u.badge = !have || l.data.lvl > have ? '▲' : '';
      u.alt = !have ? '新技能' : l.data.lvl > have ? '升级 Lv ' + have + ' → ' + l.data.lvl : '已学会 · 化为微光尘';
    } else if (l.kind === 'blank') {
      const ok = G.blankUseful(l.data.lvl);
      u.badge = ok ? '▲' : '';
      u.alt = ok ? '任选一个技能 · 已有 ' + save.blankGems.length + ' 颗' : '用不上 · 化为微光尘';
    } else {
      const have = save.supports.indexOf(l.data) >= 0;
      u.badge = have ? '' : '▲';
      u.alt = have ? '已拥有 · 化为增幅尘' : '新的辅助宝石';
    }
    return u;
  }
  // 名牌文字由 world.js 按 loot.label 画；这里只负责决定此刻写什么
  function syncLabels(hover, live, now) {
    const loot = G.state.loot;
    const alt = live && G.input.alt;
    const hide = G.save.opts.hideNormal;
    for (let i = 0; i < loot.length; i++) {
      const l = loot[i];
      const u = lootInfo(l, now);
      let txt;
      if (alt) txt = u.base + ' · ' + u.alt + (u.badge ? ' · ' + u.badge : '');
      else if (hide && u.normal && l !== hover) txt = '·';
      else txt = u.base + (u.badge && u.badge !== '＝' ? ' ' + u.badge : '');
      if (l.label !== txt) l.label = txt;
    }
  }

  function groundTipHtml(l) {
    const save = G.save;
    const P = G.player;
    const far = Math.hypot(l.x - P.x, l.z - P.z) > 7;
    if (l.kind === 'item') {
      const hint = far ? '太远了，走近一些再拾取' : save.bag.length >= G.BAG_SIZE ? '背包已满' : '点击名牌拾取 · 或靠近后按 F';
      return itemTip(l.data, false, hint);
    }
    const foot = '<div class="tc-hint">' + (far ? '太远了，走近一些' : '走过去自动拾取 · 或点击名牌') + '</div>';
    if (l.kind === 'cur') {
      const c = G.CURRENCY[l.data];
      return (
        '<div class="tcard" style="--c:' + c.color + '">' + tcHead(ibox(IC.cur(l.data), 'curb'), c.name, '通货 · 已有 ' + (save.cur[l.data] || 0)) +
        '<div class="tc-desc">' + c.desc + '</div><div class="tc-foot">在背包里把它拖到一件物品上使用</div>' + foot + '</div>'
      );
    }
    if (l.kind === 'skill') {
      const id = l.data.id;
      const sk = G.SKILLS[id];
      const have = save.skills[id];
      const k = 1 + (sk.kind === 'summon' ? G.MINION_DMG_LVL || 0.2 : 0.2) * (l.data.lvl - 1);
      const dmgs = sk.dmg || {};
      let dmg = Object.keys(dmgs).map((t) => '<b style="color:' + G.TYPE_COLOR[t] + '">' + Math.round(dmgs[t][0] * k) + '–' + Math.round(dmgs[t][1] * k) + ' ' + G.TYPE_NAME[t] + '</b>').join(' + ') || '无';
      if (sk.kind === 'summon') {
        // 召唤宝石：写召唤物自己的基础数值（还没算召唤物属性和辅助）
        dmg = '<span class="c-ally">召唤物</span>每击 ' + dmg + (sk.life ? '<br>召唤物生命 ' + Math.round(sk.life * (1 + (G.MINION_LIFE_LVL || 0.28) * (l.data.lvl - 1))) : '') + (sk.cap ? (sk.cap > 1 ? ' · 基础上限 ' + sk.cap + ' 具' : ' · 只有 1 尊') : '');
      }
      const state = !have
        ? '<div class="tc-state new">新技能 · 拾取后学会' + (save.bar.indexOf(null) >= 0 ? '，并放进技能栏的空格' : '，在技能页绑定按键') + '</div>'
        : l.data.lvl > have
          ? '<div class="tc-state new">升级 · 当前 Lv ' + have + ' → Lv ' + l.data.lvl + '</div>'
          : '<div class="tc-state dup">等级不高于已学会的 Lv ' + have + ' · 拾取后化为 1 ' + G.CURRENCY.dust.name + '</div>';
      return (
        '<div class="tcard" style="--c:' + sk.color + '">' + tcHead('<span class="ibox sk" style="--c:' + sk.color + '">' + IC.skill(id) + '</span>', sk.name, '技能宝石 · Lv ' + l.data.lvl) +
        '<div class="tc-tags">' + cardTags(sk).map((t) => '<span>' + G.TAG_NAME[t] + '</span>').join('') + '</div>' +
        '<div class="tc-desc">' + sk.desc + '</div>' +
        '<div class="tc-foot">' + (sk.kind === 'summon' ? '' : '基础伤害 ') + dmg + '<br>魔力 ' + (sk.mana ? Math.round(sk.mana * (1 + 0.05 * (l.data.lvl - 1))) : '无') + ' · 施放 ' + sk.time + ' 秒' + (sk.cd ? ' · 冷却 ' + sk.cd + ' 秒' : '') + '</div>' +
        state + foot + '</div>'
      );
    }
    if (l.kind === 'blank') {
      const ok = G.blankUseful(l.data.lvl);
      return blankTip(null, l.data.lvl).replace(/<\/div>$/, '') +
        (ok
          ? '<div class="tc-state new">拾取后存起来，到技能页（<kbd>G</kbd>）挑一个技能学会，或给 Lv ' + l.data.lvl + ' 以下的技能升级</div>'
          : '<div class="tc-state dup">所有技能都已学会且不低于 Lv ' + l.data.lvl + ' · 拾取后化为 1 ' + G.CURRENCY.dust.name + '</div>') +
        foot + '</div>';
    }
    const sp = G.SUPPORTS[l.data];
    const have = save.supports.indexOf(l.data) >= 0;
    const fits = Object.keys(save.skills).filter((id) => G.supportFits(id, l.data)).map((id) => G.SKILLS[id].name);
    return (
      '<div class="tcard" style="--c:' + IC.supColor(l.data) + '">' + tcHead(ibox(IC.sup(l.data), 'gemb'), sp.name, '辅助宝石') +
      '<div class="tc-desc">' + sp.desc + '</div>' +
      '<div class="tc-foot">魔力消耗 ×' + sp.cost + ' · 适用：' + scopeText(sp) +
      '<br>你的技能里可镶嵌：' + (fits.length ? fits.join('、') : '暂无') + '</div>' +
      (have
        ? '<div class="tc-state dup">已经拥有 · 拾取后化为 1 ' + G.CURRENCY.augment.name + '</div>'
        : '<div class="tc-state new">新的辅助宝石 · 镶进技能的辅助槽才会生效</div>') +
      foot + '</div>'
    );
  }

  function groundTip(l) {
    if (!l) {
      if (ui.groundLoot) hideTip();
      return;
    }
    const sig = l.kind + '|' + (l.kind === 'item' ? l.data.uid + '|' + ((G.save.equip[l.data.slot] || {}).uid || '') : l.kind === 'cur' ? G.save.cur[l.data] : l.kind === 'blank' ? G.save.blankGems.length : '') +
      '|' + (Math.hypot(l.x - G.player.x, l.z - G.player.z) > 7 ? 1 : 0) + '|' + G.save.bag.length;
    const tip = el.tip;
    if (l !== ui.groundLoot || sig !== ui.groundSig) {
      ui.tipEl = null;
      ui.groundLoot = l;
      ui.groundSig = sig;
      tip.innerHTML = groundTipHtml(l);
      tip.classList.add('on');
      wui.tipX = -1;
      coach.sawGround = true;
    }
    if (wui.tipX !== ui.mouseX || wui.tipY !== ui.mouseY) {
      wui.tipX = ui.mouseX;
      wui.tipY = ui.mouseY;
      // 提示框放在鼠标背向角色的一侧，尽量不盖住自己
      placeTip({ left: ui.mouseX - 14, right: ui.mouseX + 14, top: ui.mouseY - 40, bottom: ui.mouseY + 18 }, ui.mouseX < wui.arcX);
    }
  }

  // 准星指着的敌人的名牌；返回这一帧有没有显示。首领不出（名字、血量、异常状态都在首领血条上）。
  // 打起来的时候（按着攻击键、正在出招、刚命中过）头顶要留给伤害数字、血条和处决提示：
  // 小怪的名牌缩成血条上方的一行（名字、等级、异常状态图标）；精英干脆不出——它的名字和血条本来就画在头顶。
  // 停手细看时才是带血量的完整名牌。
  function plateFor(e, now) {
    const p = wui.plate;
    if (slotDown(0) || slotDown(1) || slotDown(2) || slotDown(3) || G.player.cast || G.player.exec) wui.busyAt = now;
    const mini = now - wui.busyAt < 900;
    if (!e || e.isBoss || (e.elite && (mini || e.brokenT > 0))) {
      if (wui.plateOn) {
        wui.plateOn = false;
        wui.plateSig = '';
        p.classList.remove('on');
      }
      return false;
    }
    const sig = (mini ? 'm|' : 'f|') + e.name + '|' + e.level + '|' + (mini ? '' : Math.ceil(e.hp)) + '|' + ailSig(e) + '|' + (e.awake ? 1 : 0);
    if (sig !== wui.plateSig) {
      wui.plateSig = sig;
      p.className = 'on' + (e.elite ? ' elite' : '') + (mini ? ' mini' : '');
      const top = '<b>' + esc(e.name) + '</b><span>Lv ' + e.level + '</span>' + (e.elite ? '<em>精英</em>' : '');
      p.innerHTML = mini
        ? '<div class="np-top">' + top + ailHtml(e, false) + '</div>'
        : '<div class="np-top">' + top + '</div>' +
          '<div class="np-hp"><i style="width:' + Math.round(G.clamp(e.hp / e.maxHp, 0, 1) * 100) + '%"></i><span>' + fmtInt(Math.max(0, Math.ceil(e.hp))) + ' / ' + fmtInt(e.maxHp) + '</span></div>' +
          (ailSig(e) ? '<div class="np-ail">' + ailHtml(e, true) + '</div>' : e.awake ? '' : '<div class="np-note">尚未察觉你</div>');
    }
    wui.plateOn = true;
    const h = (e.height || 1.8) * (e.elite ? 1.3 : 1);
    const q = G.world.project(e.x, h + 0.35, e.z);
    p.style.transform = 'translate(' + Math.round(q.x) + 'px,' + Math.round(q.y - (e.elite ? 24 : mini ? 16 : 10)) + 'px) translate(-50%,-100%)';
    return true;
  }

  const ARROW_TXT = { boss: '首', elite: '精', portal: '门' };
  function updateArrows(live) {
    const st = G.state;
    const P = G.player;
    const W = G.world;
    const c = wui.cands;
    let n = 0;
    const add = (kind, x, z) => {
      const o = c[n] || (c[n] = { kind: '', x: 0, z: 0, d: 0 });
      o.kind = kind;
      o.x = x;
      o.z = z;
      o.d = Math.hypot(x - P.x, z - P.z);
      n++;
    };
    if (live && !P.dead) {
      if (st.boss && st.boss.awake && !st.boss.dead) add('boss', st.boss.x, st.boss.z);
      if (st.portal) add('portal', st.portal.x, st.portal.z);
      const es = st.enemies;
      for (let i = 0; i < es.length && n < 12; i++) {
        const e = es[i];
        if (e.elite && e.awake && !e.dead && !e.isBoss) add('elite', e.x, e.z);
      }
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const L = 46, R = vw - 46, T = 120, B = vh - 218;
    let used = 0;
    let org = null;
    for (let i = 0; i < n && used < wui.arrows.length; i++) {
      const o = c[i];
      const p = W.project(o.x, 1, o.z);
      if (p.ok && p.x > 20 && p.x < vw - 20 && p.y > 20 && p.y < vh - 150) continue; // 在画面里，不需要箭头
      if (!org) org = W.project(P.x, 1, P.z);
      // 镜头不转：屏幕右 = 世界 +x，屏幕下 = 世界 +z（纵向按俯角压扁一些）
      const dx = o.x - P.x;
      const dy = (o.z - P.z) * 0.62;
      const cx = G.clamp(org.x, L + 1, R - 1);
      const cy = G.clamp(org.y, T + 1, B - 1);
      let k = 1e9;
      if (dx > 0) k = Math.min(k, (R - cx) / dx);
      else if (dx < 0) k = Math.min(k, (L - cx) / dx);
      if (dy > 0) k = Math.min(k, (B - cy) / dy);
      else if (dy < 0) k = Math.min(k, (T - cy) / dy);
      if (k === 1e9) continue;
      const x = Math.round(cx + dx * k);
      let y = Math.round(cy + dy * k);
      if (y < 240 && (x < 340 || x > vw - 210)) y = 240; // 让开左上的区域信息 / 提示卡和右上的小地图
      const a = Math.round(Math.atan2(dy, dx) * 50) / 50;
      const ar = wui.arrows[used++];
      if (!ar.on || ar.kind !== o.kind) {
        ar.on = true;
        ar.kind = o.kind;
        ar.el.className = 'arrow on ' + o.kind;
        ar.txt.textContent = ARROW_TXT[o.kind];
      }
      if (ar.x !== x || ar.y !== y) {
        ar.x = x;
        ar.y = y;
        ar.el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      }
      if (ar.a !== a) {
        ar.a = a;
        ar.tip.style.transform = 'rotate(' + a + 'rad) translate(21px, 0)';
      }
    }
    for (let i = used; i < wui.arrows.length; i++) {
      const ar = wui.arrows[i];
      if (ar.on) {
        ar.on = false;
        ar.el.className = 'arrow';
      }
    }
  }

  function updateWorldUi(now) {
    const P = G.player;
    const W = G.world;
    const live = !ui.isOpen && !ui.intro;

    // 准星 + 鼠标指着什么
    let loot = null;
    let enemy = null;
    let ally = null;
    const aim = live && ui.overCanvas && ui.mouseX >= 0;
    if (aim && !P.dead) {
      loot = W.lootLabelAt(ui.mouseX, ui.mouseY);
      if (!loot) enemy = enemyAt(ui.mouseX, ui.mouseY);
      if (!loot && !enemy) ally = minionAt(ui.mouseX, ui.mouseY); // 敌人优先：准星压在混战里时总是先看敌人
    }
    minionPlate(ally);
    const rs = !aim ? 'off' : loot ? 'loot' : enemy ? 'enemy' : ally ? 'ally' : 'aim';
    if (rs !== wui.retState) {
      wui.retState = rs;
      wui.ret.className = rs;
    }
    ui.hoverEnemy = enemy;
    syncLabels(loot, live, now);
    if (live) groundTip(loot);
    // 刚命中过也算「正在打」
    if (G.state.stats.hits !== wui.hits) {
      if (wui.hits >= 0 && G.state.stats.hits > wui.hits) wui.busyAt = now;
      wui.hits = G.state.stats.hits;
    }
    G.state.hover = plateFor(enemy, now) ? enemy : null; // 名牌亮着时 world 不重复画精英的名字

    // 脚下的生命 / 魔力弧
    const arcOn = live && !P.dead;
    if (arcOn !== wui.arcOn) {
      wui.arcOn = arcOn;
      wui.arc.classList.toggle('on', arcOn);
    }
    if (arcOn) {
      const f = W.project(P.x, 0, P.z);
      const ax = Math.round(f.x);
      const ay = Math.round(f.y);
      if (ax !== wui.arcX || ay !== wui.arcY) {
        wui.arcX = ax;
        wui.arcY = ay;
        wui.arc.style.transform = 'translate(' + ax + 'px,' + ay + 'px)';
      }
      const lq = P.maxLife > 0 ? Math.round(G.clamp(P.life / P.maxLife, 0, 1) * 100) : 0;
      if (lq !== wui.lifeQ) {
        wui.lifeQ = lq;
        wui.lifeEl.style.strokeDasharray = lq + ' 100';
      }
      const mq = P.maxMana > 0 ? Math.round(G.clamp(P.mana / P.maxMana, 0, 1) * 100) : 0;
      if (mq !== wui.manaQ) {
        wui.manaQ = mq;
        wui.manaEl.style.strokeDasharray = mq + ' 100';
      }
      const low = lq < LOW_LIFE * 100;
      if (low !== wui.lifeLow) {
        wui.lifeLow = low;
        wui.arc.classList.toggle('low', low);
      }
    }

    updateArrows(live);

    // 处决提示：浮在露出破绽的敌人头上（多个时取最近的）；够不着时变暗并改口
    let ex = null;
    if (live && !P.dead && !P.exec) {
      const es = G.state.enemies;
      let bd = 1e9;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        if (e.dead || !(e.brokenT > 0) || e.executed) continue;
        const d = Math.hypot(e.x - P.x, e.z - P.z);
        if (d < bd) {
          bd = d;
          ex = e;
        }
      }
    }
    if (!!ex !== wui.execOn) {
      wui.execOn = !!ex;
      wui.exec.classList.toggle('on', !!ex);
      wui.execFar = null;
    }
    if (ex) {
      const far = !G.execReach(ex);
      if (far !== wui.execFar) {
        wui.execFar = far;
        wui.exec.classList.toggle('far', far);
        wui.execTxt.textContent = far ? '靠近处决' : '处决';
      }
      const h = Math.min(3.6, (ex.height || 2) * (ex.elite ? 1.3 : 1));
      const q = W.project(ex.x, h + 0.5, ex.z);
      const vw = window.innerWidth;
      // 留在画面里，并且让开右上角的小地图（和方向箭头同一套避让）
      const qx = Math.round(G.clamp(q.x, 80, vw - 80));
      let qy = Math.round(G.clamp(q.y - (ex.isBoss ? 4 : 30), 96, window.innerHeight - 230));
      if (qx > vw - 290 && qy < 244) qy = 244;
      if (qx !== wui.execX || qy !== wui.execY) {
        wui.execX = qx;
        wui.execY = qy;
        wui.exec.style.transform = 'translate(' + qx + 'px,' + qy + 'px)';
      }
    }

    // 拾取记录：到点淡出
    const fl = wui.feedList;
    for (let i = fl.length - 1; i >= 0; i--) {
      const f = fl[i];
      if (now > f.die) {
        f.el.remove();
        fl.splice(i, 1);
      } else if (!f.out && now > f.die - 350) {
        f.out = true;
        f.el.classList.add('out');
      }
    }
  }

  // ---------- 拾取记录（左下角，带图标） ----------
  function feedPush(key, icon, name, color, extra) {
    const now = performance.now();
    const fl = wui.feedList;
    let f = null;
    for (const o of fl) if (o.key === key && !o.out) f = o;
    if (f) {
      f.n++;
      f.cnt.textContent = '×' + f.n;
      f.die = now + 3400;
      return;
    }
    const d = document.createElement('div');
    d.className = 'fd';
    d.style.setProperty('--c', color);
    d.innerHTML = icon + '<span>' + esc(name) + '</span>' + (extra || '') + '<b></b>';
    wui.feed.appendChild(d);
    fl.push({ key, el: d, cnt: d.lastChild, n: 1, die: now + 3400, out: false });
    while (fl.length > 5) fl.shift().el.remove();
  }
  // game.js 每成功拾取一件掉落就调一次
  function onPickup(loot, scrapped) {
    if (loot.kind === 'item') {
      const it = loot.data;
      if (scrapped) {
        feedPush('x' + it.uid, itemIcon(it), it.name, '#8c7f6d', '<em class="fd-note">已丢弃</em>');
        return;
      }
      ui.fresh.add(it.uid);
      const v = verdict(it);
      feedPush('i' + it.uid, itemIcon(it), it.name, G.RARITY_COLOR[it.rarity], v && v.badge === 'up' ? '<em class="fd-up">▲</em>' : '');
    } else if (loot.kind === 'cur') {
      feedPush('c' + loot.data, ibox(IC.cur(loot.data), 'curb'), G.CURRENCY[loot.data].name, G.CURRENCY[loot.data].color);
    } else if (loot.kind === 'skill') {
      const sk = G.SKILLS[loot.data.id];
      if (isSummon(loot.data.id)) summonPing();
      feedPush('s' + loot.data.id + loot.data.lvl, '<span class="ibox sk" style="--c:' + sk.color + '">' + IC.skill(loot.data.id) + '</span>', '技能宝石 · ' + sk.name + ' Lv ' + loot.data.lvl, '#3fe0c8');
    } else if (loot.kind === 'blank') {
      const B = G.BLANK_GEM;
      feedPush('b' + loot.data.lvl, ibox(IC.blank(), 'gemb'), B.name + ' Lv ' + loot.data.lvl, B.color, '<em class="fd-note">共 ' + G.save.blankGems.length + ' 颗</em>');
    } else {
      feedPush('p' + loot.data, ibox(IC.sup(loot.data), 'gemb'), '辅助宝石 · ' + G.SUPPORTS[loot.data].name, '#f0f0f4');
    }
  }

  // ============================================================
  // 新手引导：一次只出一条、用到的时候才出、做到了就消失；看过的记在 G.save.tut
  // ============================================================
  const coach = {
    cur: null, state: '', t: 0, last: 0, hideAt: 0, gapT: 0, pollT: 0, urgT: 0, base: null,
    px: null, pz: 0, moved: 0, cast: [false, false, false, false], rolled: false, sawGround: false, cur0: -1,
    minT: 0, // 当前这条至少要亮多久（秒，按字数算）——哪怕玩家一眨眼就做到了，也得留出读完的时间
    fightT: 0, // 需要清静的提示亮着的时候，已经连续打了多久
    epoch: -1, vet: false, // 这份存档读进来时是不是老角色（3 级以上）：只在读档 / 删档时判定一次
    snooze: {}, shows: {}, // 提示 id → 先别出、到这个时刻再说 / 已经出现过几次
    summonPing: false, // 第一次拾到召唤宝石 / 第一次施放召唤：等着出召唤提示（看过之后不再记）
  };
  const COACH_DONE_MS = 2000; // 「做到了」之后再留多久
  const COACH_GAP_MS = 1500; // 两条提示之间的间隔
  const COACH_GAP_FIGHT_MS = 3500; // 战斗中的间隔更长：不在打架的时候连珠炮似的换提示
  const curTotal = () => {
    let n = 0;
    for (const id of G.CUR_IDS) n += G.save.cur[id] || 0;
    return n;
  };
  const socketCount = () => {
    let n = 0;
    for (const id in G.save.sockets) for (const s of G.save.sockets[id]) if (s) n++;
    return n;
  };
  const equipSig = () => G.SLOTS.map((s) => (G.save.equip[s] ? G.save.equip[s].uid : '')).join(',');
  // 身边 r 以内有没有满足条件的活着的敌人
  const enemyNear = (r, fn) => {
    const P = G.player;
    return G.state.enemies.some((e) => !e.dead && Math.hypot(e.x - P.x, e.z - P.z) < r && fn(e));
  };
  const comboOnBar = () => G.save.bar.some((id) => id && G.SKILLS[id] && G.SKILLS[id].combo);
  const lifeFrac = () => (G.player.maxLife > 0 ? G.player.life / G.player.maxLife : 1);
  const inFight = () => enemyNear(14, (e) => e.awake); // 身边有醒着的敌人
  const isSummon = (id) => !!(id && G.SKILLS[id] && G.SKILLS[id].kind === 'summon');
  const minionCount = () => liveMinions().reduce((n, m) => n + (m && !m.dead ? 1 : 0), 0);
  const focusNow = () => (typeof G.focusTarget === 'function' ? G.focusTarget() : null);
  function summonPing() {
    if (!G.save.tut.summon) coach.summonPing = true;
  }

  // when：什么时候该出现；done(b)：玩家做到了（b 是出现那一刻的快照）；max：最多停留的秒数（只算游戏进行中的时间）
  // basic：基础操作，读档时已经 3 级以上的老角色直接跳过；need：要先看过哪一条；panel：打开对应页签时在面板里接着提示
  // urgent：稍纵即逝的时机——条件一满足就立刻顶掉正在显示的那条（被顶掉的不算看过，之后还会再出）。
  //   排在前面的更要紧：后面的紧急提示顶不掉前面的
  // calm：和战斗无关、需要腾出手来做的事（看掉落、开面板）——身边有敌人时不出，亮着的时候打起来了就先收起（不算看过）
  const HINTS = [
    {
      id: 'execute', urgent: true, max: 10,
      html: '敌人露出<b class="c-gold">破绽</b>了：靠近按 <kbd>F</kbd>（贴身时按攻击键也行）<b>处决</b>——一记重创，并回复生命、魔力和药剂',
      when: () => enemyNear(16, (e) => e.brokenT > 0.8 && !e.executed),
      done: (b) => G.state.stats.execs > b.execs,
    },
    {
      id: 'flask', urgent: true, max: 14,
      html: '生命见底了：按 <kbd>1</kbd> 喝<b>生命药剂</b>（<kbd>2</kbd> 是魔力药剂）。击杀敌人会重新充能',
      when: () => lifeFrac() < 0.5 && G.player.flask.life >= 1,
      done: (b) => G.player.flask.life < b.flask - 0.5 || lifeFrac() > 0.9,
    },
    {
      id: 'move', basic: true, max: 40,
      html: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动，沿着路一直往前走',
      when: () => true,
      done: () => coach.moved > 5,
    },
    {
      id: 'attack', basic: true, need: 'move', max: 60,
      html: '按住 <kbd>左键</kbd> 挥砍，<kbd>右键</kbd> 掷出火焰——都朝准星的方向。两个都试一下',
      when: () => true,
      done: () => coach.cast[0] && coach.cast[1],
    },
    {
      id: 'dodge', basic: true, need: 'attack', max: 40,
      html: '<kbd>空格</kbd> 翻滚，途中无敌。地上的<b class="c-red">红色区域</b>是敌人即将打到的地方，滚出去',
      when: () => G.state.enemies.some((e) => e.awake && !e.dead),
      done: () => coach.rolled,
    },
    {
      id: 'combo', need: 'attack', max: 30,
      html: '按住 <kbd>左键</kbd> 连出<b>三段</b>：横斩、上挑，第三段是跃起下劈的<b>终结技</b>——伤害翻倍，把敌人震飞。出招途中随时可以按 <kbd>空格</kbd> 翻滚取消',
      when: () => comboOnBar() && enemyNear(9, (e) => e.awake),
      done: (b) => G.state.stats.finishers > b.finishers,
    },
    {
      id: 'poise', max: 30,
      html: '精英和首领血条下的<b>白条是架势</b>。连续命中把它打空，敌人就会露出<b class="c-gold">破绽</b>——近战削得最多，终结技尤其多',
      when: () => enemyNear(12, (e) => e.awake && e.poiseMax > 0 && !(e.brokenT > 0)),
      done: (b) => G.state.stats.breaks > b.breaks,
    },
    {
      id: 'summon', max: 40,
      // 显示时按技能栏现场拼：召唤宝石绑在哪个键就写哪个键（不在技能栏上时退回不带键的说法）
      get html() {
        const bar = (G.save && G.save.bar) || [];
        let i = -1;
        for (let k = 0; k < bar.length && i < 0; k++) if (bar[k] && G.SKILLS[bar[k]] && G.SKILLS[bar[k]].kind === 'summon') i = k;
        const how = i >= 0 && KEY_LABEL[i] ? '按 <kbd>' + KEY_LABEL[i] + '</kbd> 朝准星施放' : '朝准星施放';
        return '学会了<b class="c-ally">召唤</b>：' + how + '，召唤物会自己寻敌厮杀。你<b>亲手打中</b>的敌人会被标记，召唤物优先<b>集火</b>它。召唤物的数值、辅助宝石在 <kbd>G</kbd> 技能页';
      },
      when: () => coach.summonPing,
      done: () => minionCount() > 0 && !!focusNow(),
    },
    {
      id: 'loot', calm: true, max: 22,
      html: '有东西掉了：魔法、稀有物品走过去就捡，普通物品按 <kbd>F</kbd> 或点它的名牌。<br>准星<b>停在名牌上</b>看完整属性，按住 <kbd>Alt</kbd> 看概要',
      when: () => G.state.loot.some((l) => l.kind === 'item' && Math.hypot(l.x - G.player.x, l.z - G.player.z) < 9),
      done: (b) => coach.sawGround || G.save.bag.length > b.bag,
    },
    {
      id: 'bag', calm: true, max: 45,
      html: '背包里有装备了：按 <kbd>I</kbd> 打开，<b>右键</b>或<b>拖到装备栏</b>穿上。角上的 <b class="vd-up">▲</b> 表示比身上的强',
      when: () => G.save.bag.length > 0,
      done: (b) => equipSig() !== b.equip,
      panel: { tab: 'inv', html: '把带 <b class="vd-up">▲</b> 的装备<b>右键</b>穿上，或者拖到左边对应的装备栏' },
    },
    {
      id: 'craft', calm: true, max: 45,
      html: '捡到了<b>通货</b>：它不是钱，而是用来改造装备的。按 <kbd>I</kbd>，把通货<b>拖到一件物品上</b>',
      when: () => curTotal() > coach.cur0 && G.save.bag.length + Object.keys(G.save.equip).length > 0,
      done: (b) => curTotal() < b.cur,
      panel: { tab: 'inv', html: '把下面的通货<b>拖到一件物品上</b>——微光尘能让普通物品长出一条词缀' },
    },
    {
      id: 'support', calm: true, max: 45,
      html: '得到了<b>辅助宝石</b>：按 <kbd>G</kbd>，把它<b>拖进技能的辅助槽</b>，那个技能就会随之改变',
      when: () => G.save.supports.length > 0 && socketCount() === 0,
      done: () => socketCount() > 0,
      panel: { tab: 'skills', html: '把宝石<b>拖进</b>左边某个技能的辅助槽（技能要带有它要求的标签）' },
    },
    {
      id: 'blank', calm: true, max: 45,
      html: '捡到了<b class="c-blank">无铭技能宝石</b>：按 <kbd>G</kbd> 打开技能页，<b>任选一个技能</b>用它学会，或给等级更低的技能升级',
      when: () => G.save.blankGems.length > 0,
      done: (b) => G.save.blankGems.length < b.blank,
      panel: { tab: 'skills', html: '点左边「尚未获得」里的一个技能（或技能卡上的「升至 Lv」），<b>再点一次</b>确认，就会用掉等级最高的那颗无铭技能宝石' },
    },
    {
      id: 'passive', calm: true, max: 45,
      html: '有<b>天赋点</b>可用：按 <kbd>P</kbd> 打开天赋盘',
      when: () => G.passivePoints().free > 0,
      done: (b) => G.save.passives.length > b.passives || G.passivePoints().free <= 0,
      panel: { tab: 'tree', html: '从中央出发，点亮与已点亮节点<b>相邻</b>的天赋。随时可以退回' },
    },
    {
      id: 'boss', urgent: true, max: 9,
      html: '前面是<b>首领</b>的竞技场。看清地上的红色预警再出手，留好翻滚和药剂',
      when: () => {
        const st = G.state;
        const z = st.zone;
        return !!(z && st.boss && !st.boss.dead && !st.boss.awake && Math.hypot(G.player.x - z.bossPos.x, G.player.z - z.bossPos.z) < z.bossR + 13);
      },
      done: () => !G.state.boss || G.state.boss.awake || G.state.boss.dead,
    },
    {
      id: 'portal', calm: true, max: 40,
      html: '首领倒下了。捡完战利品后走进<b>传送门</b>，在地图上选择下一个区域',
      when: () => !!G.state.portal,
      done: (b) => (ui.isOpen && ui.tab === 'map') || G.state.zone !== b.zone,
    },
  ];

  function coachShow(h, now) {
    const P = G.player;
    coach.cur = h;
    coach.state = 'show';
    coach.t = 0;
    coach.fightT = 0;
    coach.shows[h.id] = (coach.shows[h.id] || 0) + 1;
    // 至少亮够读完的时间：去掉标签后按字数算，4 ~ 8 秒
    coach.minT = G.clamp(1.5 + h.html.replace(/<[^>]*>/g, '').length * 0.06, 4, 8);
    coach.moved = 0;
    coach.cast = [false, false, false, false];
    coach.rolled = false;
    coach.sawGround = false;
    const cs = G.state.stats;
    coach.base = {
      bag: G.save.bag.length, cur: curTotal(), equip: equipSig(), passives: G.save.passives.length, flask: P.flask.life, zone: G.state.zone,
      finishers: cs.finishers, breaks: cs.breaks, execs: cs.execs, blank: G.save.blankGems.length,
    };
    el.coachBody.innerHTML = h.html;
    el.coach.dataset.hint = h.id;
    el.coach.className = 'on';
    G.sfx('pickup');
  }
  function coachSeen(id) {
    G.save.tut[id] = 1;
    G.persist();
  }
  // 面板里接着提示的那一句（当前提示与这个页签有关时）
  function coachBanner(tab) {
    const h = coach.cur;
    return h && coach.state === 'show' && h.panel && h.panel.tab === tab ? '<b class="co-mark">提示</b><span>' + h.panel.html + '</span>' : '';
  }

  function updateCoach(now) {
    const P = G.player;
    const st = G.state;
    const dt = Math.min(0.1, Math.max(0, (now - coach.last) / 1000));
    coach.last = now;
    if (ui.intro) return;

    // 累计：走了多远、用过哪几个键、有没有翻滚过
    if (coach.px !== null && !st.paused) {
      const d = Math.hypot(P.x - coach.px, P.z - coach.pz);
      if (d < 2) coach.moved += d;
    }
    coach.px = P.x;
    coach.pz = P.z;
    if (P.cast) {
      coach.cast[P.cast.slot] = true;
      if (!coach.summonPing && isSummon(P.cast.id)) summonPing();
    }
    if (coach.summonPing && G.save.tut.summon) coach.summonPing = false; // 已经看过（或测试里统一标成看过）
    if (P.roll.t > 0) coach.rolled = true;
    if (coach.cur0 < 0) coach.cur0 = curTotal();

    // 换了一份存档（读档 / 删档 / 新开）：重新判断是不是老角色。
    // 只在这一刻判定——本次从 1 级玩上来的新角色，中途升到 3 级也照样把基础提示看完
    if (coach.epoch !== G.saveEpoch) {
      coach.epoch = G.saveEpoch;
      coach.vet = G.save.level >= 3;
      coach.snooze = {};
      coach.shows = {};
      coach.summonPing = false;
    }

    // 稍纵即逝的提示（处决、濒死喝药、首领门口）：条件满足时不等间隔，直接顶掉正在显示的那条
    let urgent = null;
    if (now - coach.urgT > 200 && !st.paused && !P.dead) {
      coach.urgT = now;
      const holding = coach.cur && coach.cur.urgent && coach.state === 'show' ? HINTS.indexOf(coach.cur) : 1e9;
      for (let i = 0; i < HINTS.length && i < holding; i++) {
        const c = HINTS[i];
        if (c.urgent && !G.save.tut[c.id] && c !== coach.cur && c.when()) {
          urgent = c;
          break;
        }
      }
    }
    if (urgent) {
      coachShow(urgent, now);
      return;
    }

    const h = coach.cur;
    if (h) {
      if (coach.state === 'done') {
        if (now >= coach.hideAt) {
          coach.cur = null;
          coach.gapT = now + (inFight() ? COACH_GAP_FIGHT_MS : COACH_GAP_MS);
          el.coach.className = '';
        }
        return;
      }
      if (G.save.tut[h.id]) {
        // 存档里已经标成看过（比如刚换了存档）：直接收起
        coach.cur = null;
        el.coach.className = '';
        return;
      }
      if (!st.paused) coach.t += dt;
      // 需要清静的提示：打起来了就先收起来，不算看过，等这一仗打完再出
      if (h.calm && !st.paused && inFight()) {
        coach.fightT += dt;
        if (coach.fightT > 1.2) {
          coach.cur = null;
          coach.snooze[h.id] = now + 2500;
          coach.gapT = now + 600;
          el.coach.className = '';
          return;
        }
      } else coach.fightT = 0;
      const ok = !!h.done(coach.base);
      if (ok) {
        // 做到了：立刻记为看过、打上「做到了」，但卡片要留到读得完为止
        coachSeen(h.id);
        coach.state = 'done';
        coach.hideAt = now + Math.max(COACH_DONE_MS, (coach.minT - coach.t) * 1000);
        el.coach.className = 'on done';
        if (ui.isOpen && h.panel && h.panel.tab === ui.tab) render(); // 面板里的那一句也收掉
      } else if (coach.t > (h.max || 30)) {
        if (h.panel && coach.shows[h.id] < 3) {
          // 要开面板才做得了的事，玩家一直没顾上：先收起、过一阵再提醒，不占着提示位，也不当作已经看过
          coach.cur = null;
          coach.snooze[h.id] = now + 60000;
          coach.gapT = now + COACH_GAP_MS;
          el.coach.className = '';
        } else {
          coachSeen(h.id);
          coach.state = 'done';
          coach.hideAt = now;
        }
      }
      return;
    }
    if (now < coach.gapT || now - coach.pollT < 250) return;
    coach.pollT = now;
    if (st.paused || P.dead) return; // 面板开着 / 倒地时不弹新的
    const tut = G.save.tut;
    let fight = -1; // 用到的时候才算
    for (const c of HINTS) {
      if (tut[c.id]) continue;
      if (c.basic && coach.vet) {
        tut[c.id] = 1; // 老角色不需要基础操作提示
        continue;
      }
      if (c.need && !tut[c.need]) continue;
      if (coach.snooze[c.id] > now) continue;
      if (c.calm) {
        if (fight < 0) fight = inFight() ? 1 : 0;
        if (fight) continue;
      }
      if (!c.when()) continue;
      coachShow(c, now);
      break;
    }
  }

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    el.panel = $('panel');
    el.body = $('panel-body');
    el.picker = $('picker');
    el.tip = $('tip');
    el.toasts = $('toasts');
    el.intro = $('intro');
    el.ghost = $('drag-ghost');
    el.confirm = $('confirm');
    el.coach = $('coach');
    el.coachBody = el.coach.querySelector('.co-body');

    const tabs = $('tabs');
    tabs.innerHTML = TABS.map(
      (t) => '<button type="button" tabindex="-1" class="tab" data-act="tab" data-tab="' + t[0] + '">' + t[1] + '<kbd>' + t[2] + '</kbd></button>'
    ).join('');
    el.tabBtns = Array.from(tabs.children);

    initHud();
    initWorldUi();
    IC.warm(); // 图标趁空闲分批画好，第一次打开背包不再卡顿

    const panel = el.panel;
    panel.addEventListener('click', onPanelClick);
    panel.addEventListener('mousedown', (e) => {
      e.stopPropagation(); // 面板上的点击不是游戏输入
      if (e.target.closest('button')) e.preventDefault(); // 按钮不拿焦点，避免空格 / 回车重复触发
      if (e.target === panel) close(); // 点面板外的暗处关闭
    });
    panel.addEventListener('contextmenu', onPanelContext);

    // 拖拽：整窗监听，指针移出面板也跟得上
    window.addEventListener('pointerdown', dragDown, true);
    window.addEventListener('pointermove', dragMove, true);
    window.addEventListener('pointerup', dragUp, true);
    window.addEventListener('pointercancel', cancelDrag, true);
    window.addEventListener('blur', cancelDrag);
    // 抢在 main.js 之前处理的按键：拖拽中 / 确认框开着时 Esc 只取消这一步，不关面板；开场卡片用回车或空格关闭
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Escape' && (drag.on || ui.confirm)) {
          if (!cancelDrag()) {
            ui.confirm = null;
            renderConfirm();
          }
          e.stopPropagation();
          e.preventDefault();
        } else if (ui.intro && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')) {
          closeIntro();
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true
    );
    el.intro.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });
    el.intro.addEventListener('click', (e) => {
      if (e.target === el.intro || e.target.closest('#intro-go')) closeIntro();
    });
    // 列表滚动后选择器的位置就不对了，直接收起
    el.body.addEventListener(
      'scroll',
      (e) => {
        const n = e.target;
        const key = n && n.dataset ? n.dataset.scroll : undefined;
        const rec = key ? ui.restored[key] : null;
        if (rec) {
          // render() 刚把滚动位置写回去：不是玩家在滚
          delete ui.restored[key];
          if (rec.node === n && rec.top === n.scrollTop) return;
        }
        closePicker();
        hideTip();
      },
      true
    );

    // 悬浮提示：整个文档一个监听
    document.addEventListener('mouseover', (e) => {
      if (drag.on) return;
      const t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (t) {
        if (t !== ui.tipEl) showTip(t);
      } else if (!ui.groundLoot) {
        hideTip(); // 地面掉落的提示由 updateWorldUi 自己管
      }
    });
    document.addEventListener('mousemove', (e) => {
      ui.mouseX = e.clientX;
      ui.mouseY = e.clientY;
      const t = e.target;
      ui.overCanvas = !t || t === document.body || t === document.documentElement || t.tagName === 'CANVAS';
      wui.ret.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'; // 准星直接跟鼠标，不等下一帧
    });
    document.documentElement.addEventListener('mouseleave', () => {
      ui.mouseX = -1;
      ui.overCanvas = false;
      hideTip();
    });
    window.addEventListener('resize', () => {
      if (ui.isOpen) {
        renderPicker();
        hideTip();
      }
    });
  }

  G.ui = {
    init,
    update,
    open,
    close,
    toggle,
    isOpen: () => ui.isOpen || ui.intro, // 面板或开场卡片开着：游戏暂停
    refresh,
    toast,
    hurt,
    showHelp,
    showIntro,
    onPickup,
    verdict, // 换装评估（只读）：{ badge, score, empty, lines } | null
    hints: () => ({ current: coach.cur ? coach.cur.id : null, state: coach.state, all: HINTS.map((h) => h.id), veteran: coach.vet, minShow: coach.minT, shownFor: coach.t }),
  };
})();
