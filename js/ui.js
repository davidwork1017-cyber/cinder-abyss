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
  // 按住 Alt 才展开的详情（触发规则、边界情况）：数据里的 alt / mechAlt。没有详情就什么都不加，提示行也不出；
  // 展开与否由 body 的 alt-on 类切换（见 update），所以浮窗、技能卡都不用重渲染
  const altBox = (d) => (d ? '<div class="alt-box"><div class="alt-d">' + d + '</div><div class="alt-h">按住 <kbd>Alt</kbd> 查看详情</div></div>' : '');

  const KEY_LABEL = ['左键', '右键', 'Q', 'E'];
  const W_SLOT = 4; // 施放系统里武器技的格子号（R 键）；技能栏存档只有前 4 格，这一格由手里的武器决定

  // ---------- 武器 ----------
  // 武器类型名：优先用数据里的写法，没有就用这张表
  const WTYPE_NAME = { blade: '刃', staff: '长杖', wand: '短杖', daggers: '双匕', hammer: '战锤', bow: '长弓', katana: '太刀', banner: '魂幡', gatling: '机炮', flamer: '喷枪', revolver: '左轮', huntbow: '猎弓', eagle: '长弓', runebow: '符文弓', emberbow: '霜弓' };
  const WTYPE_ORDER = ['blade', 'staff', 'wand', 'daggers', 'hammer', 'bow', 'katana', 'banner'];
  const GUN_TYPES = ['gatling', 'flamer', 'revolver'];
  const wBase = (item) => (item && item.slot === 'weapon' && G.BASES.weapon ? G.BASES.weapon[item.baseIdx | 0] || null : null);
  const wTypeOf = (baseIdx) => {
    const b = G.BASES.weapon && G.BASES.weapon[baseIdx];
    return (b && b.type) || (IC.weaponType ? IC.weaponType(baseIdx) : WTYPE_ORDER[baseIdx]) || 'blade';
  };
  const wTypeName = (baseIdx) => {
    const b = G.BASES.weapon && G.BASES.weapon[baseIdx];
    return (b && (b.typeName || b.label)) || WTYPE_NAME[wTypeOf(baseIdx)] || '武器';
  };
  // 武器的伤害数值：{ min, max, aps（每秒攻击次数）, dps, type }；不是武器、或数据里还没有伤害时返回 null
  function wStats(item) {
    if (!item || item.slot !== 'weapon') return null;
    try {
      if (typeof G.weaponStats === 'function') {
        const s = G.weaponStats(item);
        if (s && isFinite(s.min) && isFinite(s.max)) {
          const aps = s.aps > 0 ? s.aps : 1;
          return { min: s.min, max: s.max, aps, dps: isFinite(s.dps) ? s.dps : ((s.min + s.max) / 2) * aps, type: s.type || wTypeOf(item.baseIdx | 0) };
        }
      }
    } catch (e) {
      /* 数据层还没就绪时退回物品上的字段 */
    }
    if (Array.isArray(item.dmg) && isFinite(item.dmg[0])) {
      const aps = item.aps > 0 ? item.aps : 1;
      return { min: item.dmg[0], max: item.dmg[1], aps, dps: ((item.dmg[0] + item.dmg[1]) / 2) * aps, type: wTypeOf(item.baseIdx | 0) };
    }
    return null;
  }
  // 武器技的成长方式：attack 随武器伤害；minion 按召唤物（魂幡）；其余是法术，随武器物品等级与元素加成
  const wGrowKind = (sk) => (sk.tags.indexOf('attack') >= 0 ? 'attack' : sk.tags.indexOf('minion') >= 0 || sk.minion || sk.wtype === 'banner' ? 'minion' : 'spell');
  const WGROW_TIP = { attack: '随武器伤害成长', minion: '按召唤物计算', spell: '随武器物品等级与元素加成成长' };
  const isWSkill = (id) => !!(id && G.SKILLS[id] && (G.SKILLS[id].weaponOnly || G.SKILLS[id].tags.indexOf('weapon') >= 0));
  // 某件武器自带的武器技 id（数据里没有时为 null）
  const wSkillOf = (item) => {
    if (item && typeof G.weaponSkillOf === 'function') return G.weaponSkillOf(item); // 烬铸武器：它的烬铸技
    const b = wBase(item);
    return b && b.wskill && G.SKILLS[b.wskill] ? b.wskill : null;
  };
  // 烬铸技：拿着烬铸武器时顶替普通武器技的那一招（数据里 uskill: true，replaces 是被顶替的那个）
  const isUSkill = (id) => !!(id && G.SKILLS[id] && G.SKILLS[id].uskill);
  // 烬铸技 id → 它所属的烬铸武器的数据（G.UNIQUES 里的一项）
  const uOfSkill = (id) => {
    for (const k of G.UNIQUE_IDS || []) if (G.UNIQUES[k].uskill === id) return G.UNIQUES[k];
    return null;
  };
  // 烬铸技的一句来历：「烬断专属 · 替换「瞬断」」
  const uSkillSrc = (id) => {
    const sk = G.SKILLS[id], U = uOfSkill(id), rp = sk && sk.replaces && G.SKILLS[sk.replaces];
    return (U ? U.name + '专属' : '烬铸武器专属') + (rp ? ' · 替换「' + rp.name + '」' : '');
  };
  // 当前 R 键上的武器技 id（没拿武器 / 数据还没有时为 null）
  function curWSkill() {
    let id = null;
    try {
      id = typeof G.weaponSkill === 'function' ? G.weaponSkill() : wSkillOf(G.save.equip.weapon);
    } catch (e) {
      id = null;
    }
    return id && G.SKILLS[id] ? id : null;
  }
  const fmtDmg = (v) => (v < 10 ? fmt1(v) : fmtInt(v));
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
    m: { name: '统御', hint: '召唤物 · 继承装备' },
    c: { name: '噬渊', hint: '混沌 · 渊缚 · 黑洞' },
    o: { name: '交汇', hint: '相邻支路之间的混合' },
  };
  const ARM_ORDER = ['s', 'd', 'i', 'm', 'c', 'o'];
  const KIND_NAME = { small: '小型天赋', notable: '核心天赋', keystone: '基石天赋', start: '起点' };
  const ALLY = G.icons.ally || '#4fe3c8'; // 友方召唤物的青色（与世界里的血条、地面圈同色）
  const MINION_STATS = ['minionDmg', 'minionLife', 'minionSpeed', 'minionCap', 'minionMore', 'minionArea', 'minionCharge'];
  const MINION_NAME = { thrall: '烬骸仆从', colossus: '石誓守像', pyre: '焚骨祭司' };
  const ZONE_GLYPH = { ash: '烬', frost: '霜', storm: '雷', abyss: '渊', rift: '星' };
  const ZONE_ORD = ['第一境', '第二境', '第三境', '第四境', '第五境', '第六境'];

  // 音效（G.sfx）和混音总线在 js/audio.js（G.audio）

  // ============================================================
  // 界面状态
  // ============================================================
  const ui = {
    isOpen: false,
    tab: 'inv',
    sel: null, // 背包页选中的物品 uid
    invMsg: '',
    invOk: '', // 成功提示（琢刻石换了哪一条），绿色
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
    sealPick: null, // 择印面板（层级 ≥ 1 点「进入」后叠在地图页上）：{ zone, tier, seals: [浅印, 深印, 烬印] }
    delArmed: false,
    tipEl: null,
    mouseX: -1,
    mouseY: -1,
    overCanvas: false, // 鼠标正停在游戏画面上（不是面板 / HUD 按钮）
    intro: false, // 开场卡片开着（此时游戏暂停，isOpen() 也算打开）
    altOn: false, // body 上的 alt-on 类现在的状态（跟着 G.input.alt）
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
        '<i class="s-ring"></i><span class="s-auto">自动</span>' + // 召唤技能开着自动召唤：转动的光圈 + 角标
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
        auto: false, // 自动召唤开着
        left: 0, // 上一帧的冷却剩余
        held: false, // 上一帧这个键是否按着
        fxT: -1e9, // 拒绝施放 / 冷却转好 的动画起点
        fx: '',
      });
    }
    // 第五格「武器技」（R）：不在 #slots 里（那四格对应存档里的技能栏），隔一道竖线跟在后面，内容随手里的武器变
    const wsep = document.createElement('div');
    wsep.className = 'bar-sep';
    const ws = document.createElement('div');
    ws.id = 'wslot';
    ws.className = 'slot wslot empty nowpn';
    ws.innerHTML =
      '<div class="s-icon"><i class="s-img ico"></i><div class="s-gfill"><i></i></div><div class="s-cd"></div><span class="s-cdnum"></span><span class="s-none">无武器</span></div>' +
      '<div class="s-key"><b>R</b><span class="s-ktxt">武器技</span></div><div class="s-bubble"></div><div class="s-combo"><i></i><i></i><i></i></div><i class="s-ember"></i>';
    // 远程武器的量表（热度 / 专注）：R 格左边一根竖条，满了才能放 R；R 格里也跟着从下往上灌
    const gauge = document.createElement('div');
    gauge.id = 'gauge';
    gauge.innerHTML = '<div class="g-track"><i class="g-fill"></i><i class="g-ticks"></i><span class="g-num"></span></div><div class="s-key g-name">热度</div>';
    $('bar').appendChild(wsep);
    $('bar').appendChild(gauge);
    $('bar').appendChild(ws);
    hud.gauge = { el: gauge, fill: gauge.querySelector('.g-fill'), num: gauge.querySelector('.g-num'), name: gauge.querySelector('.g-name'), kind: '', q: -1, full: null, on: null, wfill: ws.querySelector('.s-gfill > i') };
    hud.slots.push({
      el: ws, icon: ws.querySelector('.s-icon'), img: ws.querySelector('.s-img'), cd: ws.querySelector('.s-cd'), num: ws.querySelector('.s-cdnum'),
      bubble: ws.querySelector('.s-bubble'), pips: Array.from(ws.querySelectorAll('.s-combo > i')),
      lit: 0, id: undefined, cdq: 0, numTxt: '', na: false, casting: false, left: 0, held: false, fxT: -1e9, fx: '',
      wpn: undefined, // 上一帧有没有拿武器
      keyTxt: ws.querySelector('.s-ktxt'),
    });
    const orb = (name) => ({ fill: $(name + '-fill'), num: $(name + '-num'), maxEl: $(name + '-max'), v: -1, max: -1, q: -1, res: $(name + '-res'), rq: -1 });
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
    hud.zone = { name: $('zone-name'), sub: $('zone-sub'), seal: $('seal-chips'), ref: null, tier: -1 };
    hud.boss = { box: $('boss-box'), name: $('boss-name'), fill: $('boss-fill'), trail: $('boss-trail'), num: $('boss-num'), ail: $('boss-ail'), ailSig: '', on: false, ref: null, q: -1, hp: -1, poise: $('boss-poise-fill'), pq: -1, brk: false, far: false, brkTxt: $('boss-break-txt') };
    // 首领的元素异常值三小段
    hud.boss.bu = {};
    for (const t of G.ELEMS) {
      const el = document.querySelector('.boss-bu .' + t);
      hud.boss.bu[t] = { el, fill: el.querySelector('b'), q: -1, on: false };
    }
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

  // 手里的远程武器（G.rangedWeapon）：null，或 { family, type, basic, gauge: { kind, v, max, full, name } }
  function rangedNow() {
    try {
      const rw = typeof G.rangedWeapon === 'function' ? G.rangedWeapon() : null;
      return rw && rw.gauge ? rw : null;
    } catch (e) {
      return null;
    }
  }
  // 量表：R 格左边的竖条（热度橙红 / 专注青绿），R 格里同步从下往上灌；没满时 R 格压暗，满了一闪一闪
  function updateGauge(rw) {
    const g = hud.gauge;
    if (!g) return;
    const on = !!rw;
    if (on !== g.on) {
      g.on = on;
      g.el.classList.toggle('on', on);
      hud.slots[W_SLOT].el.classList.toggle('ranged', on);
      if (!on) {
        hud.slots[W_SLOT].el.classList.remove('gated', 'gfull');
        g.full = null;
      }
    }
    if (!on) return;
    const kind = rw.gauge.kind;
    if (kind !== g.kind) {
      g.kind = kind;
      g.el.dataset.kind = kind;
      hud.slots[W_SLOT].el.dataset.gauge = kind;
      g.name.textContent = rw.gauge.name || (kind === 'heat' ? '热度' : '专注');
    }
    const max = rw.gauge.max > 0 ? rw.gauge.max : 100;
    const q = Math.round(G.clamp(rw.gauge.v / max, 0, 1) * 200) / 2;
    if (q !== g.q) {
      g.q = q;
      g.fill.style.transform = 'scaleY(' + q / 100 + ')';
      g.wfill.style.transform = 'scaleY(' + q / 100 + ')';
      g.num.textContent = Math.floor(q);
    }
    const full = !!rw.gauge.full || q >= 100;
    if (full !== g.full) {
      if (full && g.full === false) slotFx(hud.slots[W_SLOT], 'ready', '', performance.now());
      g.full = full;
      g.el.classList.toggle('full', full);
      hud.slots[W_SLOT].el.classList.toggle('gated', !full);
      hud.slots[W_SLOT].el.classList.toggle('gfull', full);
    }
  }

  // full（可选）：球满格对应的数值（魔力球按保留前的上限画，顶上那一截是光环保留）
  function setOrb(o, cur, max, full) {
    const v = Math.max(0, Math.ceil(cur));
    if (v !== o.v) {
      o.v = v;
      o.num.textContent = v;
    }
    if (max !== o.max) {
      o.max = max;
      o.maxEl.textContent = '/ ' + max;
    }
    const fm = full > 0 ? full : max;
    const q = fm > 0 ? Math.round(G.clamp(cur / fm, 0, 1) * 200) / 2 : 0; // 0.5% 精度
    if (q !== o.q) {
      o.q = q;
      o.fill.style.transform = 'translateY(' + (100 - q) + '%)';
    }
    if (o.res) {
      const rq = fm > 0 ? Math.round(G.clamp(1 - max / fm, 0, 1) * 200) / 2 : 0;
      if (rq !== o.rq) {
        o.rq = rq;
        o.res.classList.toggle('on', rq > 0);
        o.res.style.height = rq + '%';
      }
    }
  }

  // 技能格下面的连段格：近战连招按段数；施法普攻三下以上一轮的（灵弹）也亮，疾咒只是左右换手、不显示
  const comboSteps = (sk) => sk.combo || (sk.cyc && sk.cyc.length > 2 ? sk.cyc : null);
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
    // 按住 Alt：浮窗和技能卡里的详情由 body 上的 alt-on 类切换（不重渲染）；浮窗变高了要重新摆位
    const altOn = !!(G.input && G.input.alt);
    if (altOn !== ui.altOn) {
      ui.altOn = altOn;
      document.body.classList.toggle('alt-on', altOn);
      if (ui.tipEl && el.tip.classList.contains('on')) placeTip(ui.tipEl.getBoundingClientRect());
      else if (ui.groundLoot) wui.tipX = -1;
    }
    updateEncHud();
    updatePinHud();
    updateQuestHud(now);

    setOrb(hud.life, P.life, P.maxLife, P.maxLifeRaw || P.maxLife);
    setOrb(hud.mana, P.mana, P.maxMana, P.maxManaRaw || P.maxMana);
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
      const wid = curWSkill();
      if (wid) hud.cost[wid] = skillCost(wid);
      hud.free = G.passivePoints().free;
      // 「新」标记只对还在背包里的物品有意义（装备、分解、丢弃之后就不算了）
      if (ui.fresh.size) {
        for (const uid of Array.from(ui.fresh)) if (!S.bag.some((it) => it.uid === uid)) ui.fresh.delete(uid);
      }
    }

    // 技能栏
    const blood = P.S.bloodMagic > 0;
    const wpn = !!S.equip.weapon;
    const rw = rangedNow();
    for (let i = 0; i < hud.slots.length; i++) {
      const s = hud.slots[i];
      const basic = i === 1 && G.weaponBasic ? G.weaponBasic() : null; // 右键就是手里武器的普攻（空手是拳击）
      const id = (i === W_SLOT ? curWSkill() : basic || S.bar[i]) || null;
      if (i === 1 && !!basic !== !!s.basic) {
        s.basic = !!basic;
        s.el.classList.toggle('basic', !!basic);
      }
      if (i === W_SLOT && wpn !== s.wpn) {
        s.wpn = wpn;
        s.el.classList.toggle('nowpn', !wpn); // 空手：格子里写「无武器」
      }
      if (id !== s.id) {
        s.id = id;
        s.el.classList.toggle('empty', !id);
        s.el.dataset.skill = id || '';
        s.left = 0;
        if (id) {
          const sk = G.SKILLS[id];
          s.img.className = 's-img ico ' + IC.cls('sk-' + id);
          s.icon.style.setProperty('--c', sk.color);
          s.el.classList.toggle('has-combo', !!comboSteps(sk));
          s.el.classList.toggle('aura', sk.kind === 'aura');
          if (i === W_SLOT) {
            // 烬铸技：R 格换上余烬光框，键位下的字换成「烬铸技」
            s.el.classList.toggle('uskill', !!sk.uskill);
            if (s.keyTxt) s.keyTxt.textContent = sk.uskill ? '烬铸技' : '武器技';
          }
          if (!(id in hud.cost)) hud.cost[id] = skillCost(id);
        } else {
          s.img.className = 's-img ico';
          s.el.classList.remove('has-combo');
          s.el.classList.remove('aura');
          if (i === W_SLOT) {
            s.el.classList.remove('uskill');
            if (s.keyTxt) s.keyTxt.textContent = '武器技';
          }
        }
      }
      // 连段指示：正在出第几段（出手中算上这一段），窗口过了就熄灭
      let lit = 0;
      if (id && comboSteps(G.SKILLS[id]) && !P.dead) {
        if (P.cast && P.cast.id === id && (P.cast.st || P.cast.cs)) lit = P.cast.step + 1;
        else if (P.combo.t > 0) lit = P.combo.step;
      }
      // 连段格按这一招的段数显示：武器普攻的连招大多 3 段（多的藏起来），双匕 4 段（不够就补一格）
      let nc = id && comboSteps(G.SKILLS[id]) ? comboSteps(G.SKILLS[id]).length : 3;
      // 储能：格子上方的小格改成显示存着几次（亮着的是存货）
      const chg = id && !P.dead ? G.chargeInfo(id) : null;
      if (chg) {
        nc = chg.max;
        lit = chg.n;
      }
      if (!!chg !== !!s.chg) {
        s.chg = !!chg;
        s.el.classList.toggle('has-combo', !!chg || !!(id && comboSteps(G.SKILLS[id])));
        s.el.classList.toggle('chg', !!chg); // 储能的小格：更大、亮着的是青色
      }
      while (nc > s.pips.length) s.pips.push(s.pips[0].parentNode.appendChild(document.createElement('i')));
      if (lit !== s.lit || nc !== s.nc) {
        s.lit = lit;
        s.nc = nc;
        for (let k = 0; k < s.pips.length; k++) s.pips[k].className = (k >= nc ? 'x' : k < lit ? 'on' : '') + (k === nc - 1 ? ' fin' : '');
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
          const sk = G.SKILLS[id];
          const shift = !!(G.input.keys.ShiftLeft || G.input.keys.ShiftRight);
          if (sk.kind === 'aura') slotFx(s, s.aoff ? 'deny' : 'ready', s.aoff ? '保留不足' : '', now); // 光环：按了也只是亮一下，提示它一直生效（保留放不下时说明为什么没生效）
          else if (sk.kind === 'summon' && !shift) slotFx(s, 'ready', '', now); // 召唤：按键是自动召唤的开关，不是施放
          else if (i === W_SLOT && rw && !rw.gauge.full) slotFx(s, 'deny', rw.gauge.name + '未满', now); // 远程武器的 R 要量表灌满
          else if (left > 0.15) slotFx(s, 'deny', '冷却中', now);
          else if (na) slotFx(s, 'deny', blood ? '生命不足' : '魔力不足', now);
        }
      } else if (i === W_SLOT && !P.dead && held && !s.held) {
        slotFx(s, 'deny', wpn ? '没有武器技' : '没有武器', now); // R 格空着也按了：说清楚为什么放不出来
      }
      s.left = left;
      s.held = held;
      // 光环保留放不下（超过 90%，见 G.auraFits）：格子变暗、角标「保留不足」
      const aoff = !!(id && G.SKILLS[id] && G.SKILLS[id].kind === 'aura' && !G.auraOn(id));
      if (aoff !== !!s.aoff) {
        s.aoff = aoff;
        s.el.classList.toggle('aoff', aoff);
        const tag = s.el.querySelector('.s-auto');
        if (tag) tag.textContent = aoff ? '保留不足' : '自动';
      }
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
      const auto = i !== W_SLOT && !!id && G.SKILLS[id].kind === 'summon' && G.autoSummonOn(id);
      if (auto !== s.auto) {
        s.auto = auto;
        s.el.classList.toggle('auto', auto);
      }
    }

    updateGauge(rw);

    // 武器技的新手提示亮着时，R 格跟着一闪一闪，指给玩家看
    const wHint = !!(coach.cur && (coach.cur.id === 'wskill' || coach.cur.id === 'rgauge') && coach.state === 'show');
    if (wHint !== hud.wHint) {
      hud.wHint = wHint;
      hud.slots[W_SLOT].el.classList.toggle('hint', wHint);
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
      if (z.seal) z.seal.innerHTML = sealChips(st.run && st.run.seal, 'hud');
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
      // 元素抗性小签（血条左上，和右上的异常状态对称）
      const rsig = resSig(b);
      if (rsig !== hb.resSig) {
        hb.resSig = rsig;
        if (!hb.res) {
          hb.res = document.createElement('div');
          hb.res.id = 'boss-res';
          hb.box.appendChild(hb.res);
        }
        hb.res.innerHTML = resChips(b, false);
      }
      // 元素异常值：平时按累积量涨，触发中（重度冰缓 / 感电 / 刚爆燃）整段亮着闪动
      if (b.bu) {
        const on = { fire: b.blastT > 0, cold: b.bossChill > 0, light: b.shockT > 0 };
        for (const t of G.ELEMS) {
          const u = hb.bu[t];
          const q = on[t] ? 1 : Math.round(G.clamp(b.bu[t], 0, 1) * 200) / 200;
          if (q !== u.q) {
            u.q = q;
            u.fill.style.transform = 'scaleX(' + q + ')';
          }
          if (on[t] !== u.on) {
            u.on = on[t];
            u.el.classList.toggle('on', on[t]);
          }
        }
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
      if (x && !x.dead && x.kind !== 'colossus' && x.kind !== 'pyre') list.push(x);
    }
    for (let i = 0; i < src.length; i++) {
      const x = src[i];
      if (x && !x.dead && x.kind === 'pyre') list.push(x);
    }
    const on = list.length > 0 && !G.player.dead;
    if (on !== m.on) {
      m.on = on;
      m.root.classList.toggle('on', on);
    }
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      const c = mnChip(i);
      const kind = x.kind === 'colossus' || x.kind === 'pyre' ? x.kind : 'thrall';
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
      } else if (kind === 'pyre') {
        // 焚骨祭司：下面一道焰蓄条，攒满时整枚图标亮起（马上放坠焰 / 灼链）
        const max = x.ctx && x.ctx.minion && x.ctx.minion.charge ? x.ctx.minion.charge.max : 0;
        const tq = max > 0 ? Math.round(G.clamp((x.charge || 0) / max, 0, 1) * 28) / 28 : 0;
        if (tq !== c.tq) {
          c.tq = tq;
          c.tc.style.transform = 'scaleX(' + tq + ')';
        }
        const ready = tq >= 1 || x.state === 'beam' || x.state === 'meteor';
        if (ready !== c.ready) {
          c.ready = ready;
          c.el.classList.toggle('ready', ready);
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
    return !!inp.keys[i === 2 ? 'KeyQ' : i === 3 ? 'KeyE' : 'KeyR'];
  }
  // 技能消耗：武器技可能还没接进 skillCtx，算不出来就当没有消耗
  function skillCost(id) {
    try {
      const c = G.skillCtx(id).cost;
      return isFinite(c) ? c : 0;
    } catch (e) {
      return 0;
    }
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
  // 元素异常值触发后的状态：爆燃（刚炸过，亮 1 秒）、冻结、冰缓（首领的重度冰缓，或冰霜异常值带来的轻度冰缓）、感电
  const AIL_NAME = { burn: '爆燃', chill: '冰缓', freeze: '冻结', shock: '感电', stun: '眩晕', bleed: '流血' };
  function ailList(e) {
    const out = [];
    if (e.blastT > 0) out.push('burn');
    if (e.freeze > 0) out.push('freeze');
    else if (e.bossChill > 0 || (e.bu && e.bu.cold > 0)) out.push('chill'); // 轻度冰缓有保底：异常值不为空就在减速
    if (e.shockT > 0) out.push('shock');
    if (e.stunT > 0) out.push('stun');
    if (G.bleedStacks(e) > 0) out.push('bleed'); // 流血（skill-expand）
    return out;
  }
  const ailSig = (e) => ailList(e).join(',');
  function ailHtml(e, named) {
    return ailList(e).map((a) => '<span class="ail ' + a + '">' + IC.ail(a) + (named ? AIL_NAME[a] : '') + '</span>').join('');
  }
  // 敌人的元素抗性小签（名牌、首领血条）：「抗火 15%」，前面一面元素色的小盾（纯 CSS，不画图标画布）；感电压低时变暗、写压低后的数。
  // 没有抗性的敌人不出。alt：名牌上带「按住 Alt 查看详情」
  const RES_CH = { fire: '火', cold: '冰', light: '雷' };
  function resSig(e) {
    let s = '';
    for (const t of G.ELEMS) {
      const r = G.enemyResNow(e, t);
      if (r) s += t + r;
    }
    return s + (e.shockT > 0 ? 's' : '');
  }
  function resChips(e, alt) {
    let h = '', d = '';
    for (const t of G.ELEMS) {
      const r0 = G.enemyRes(e, t);
      if (!r0) continue;
      const r = G.enemyResNow(e, t);
      h += '<span class="res-chip' + (r < r0 ? ' low' : '') + '" style="--ac:' + G.TYPE_COLOR[t] + '"><i></i>抗' + RES_CH[t] + ' ' + r + '%</span>';
      const rs = Math.max(0, r0 - G.ENEMY_RES.shock);
      d += G.TYPE_NAME[t] + '伤害 −' + r0 + '%；感电时' + (rs > 0 ? '抗性降到 ' + rs + '%' : '抗性归零') + '。';
    }
    if (!h) return '';
    return h + (alt ? altBox(d + '破障、元素穿透能把抗性压到负数（最低 −' + Math.abs(G.ENEMY_RES.floor) + '%）。') : '');
  }

  // ============================================================
  // 烬铸 / 渊契掉落：屏幕正中的大字提示（几秒后淡出）。
  // 上一条还没放完又来一条（同一只首领同时掉渊契和烬铸）：新的占正中的大字，先到的缩成一行排在下面（#big-toast-stack），
  // 各自放满自己的时间（被挤下去的至少再留 BT_KEEP 毫秒），谁也不会被顶掉；排着的超过 BT_MAX 条时只留最新的 BT_MAX - 1 条，其余并成「另有 N 件珍品」
  // ============================================================
  const BT_SHOW = 4300, BT_KEEP = 2600, BT_MAX = 3;
  let btCur = null; // 正中那一条：{ title, name, color, until }
  const btStack = []; // 缩到下面的几条（先到的在前）
  function btStackRender() {
    let box = el.bigToastStack;
    if (!box) {
      box = el.bigToastStack = document.createElement('div');
      box.id = 'big-toast-stack';
      document.body.appendChild(box);
    }
    const now = performance.now();
    for (let i = btStack.length - 1; i >= 0; i--) if (btStack[i].until <= now) btStack.splice(i, 1);
    const rows = btStack.length > BT_MAX ? btStack.slice(btStack.length - (BT_MAX - 1)) : btStack.slice();
    let html = rows
      .slice()
      .reverse()
      .map((b) => '<div class="bts-row" style="--c:' + esc(b.color || '#ff9b3d') + '"><span class="bts-t">' + esc(b.title) + '</span>' + esc(b.name) + '</div>')
      .join('');
    if (btStack.length > rows.length) html += '<div class="bts-row bts-more">另有 ' + (btStack.length - rows.length) + ' 件珍品</div>';
    box.innerHTML = html;
    box.classList.toggle('on', btStack.length > 0);
    clearTimeout(box._t);
    if (btStack.length) box._t = setTimeout(btStackRender, Math.max(30, Math.min.apply(null, btStack.map((b) => b.until)) - now + 5));
  }
  // 收起全部大字提示（正中那条和排在下面的）：测试用
  function bigToastReset() {
    btCur = null;
    btStack.length = 0;
    if (el.bigToastStack) btStackRender();
    const box = el.bigToast;
    if (box) {
      clearTimeout(box._t1);
      clearTimeout(box._t2);
      box.classList.remove('on', 'out');
    }
  }
  function bigToast(title, name, color, sub) {
    let box = el.bigToast;
    if (!box) {
      box = el.bigToast = document.createElement('div');
      box.id = 'big-toast';
      document.body.appendChild(box);
    }
    const now = performance.now();
    if (btCur && btCur.until > now) {
      btCur.until = Math.max(btCur.until, now + BT_KEEP);
      btStack.push(btCur);
    }
    btCur = { title, name, color, until: now + BT_SHOW };
    btStackRender();
    box.innerHTML = '<div class="bt-t">' + esc(title) + '</div><div class="bt-n">' + esc(name) + '</div>' + (sub ? '<div class="bt-s">' + esc(sub) + '</div>' : '');
    if (color) box.style.setProperty('--c', color);
    box.classList.toggle('rq', color === G.RELIC_COLOR); // 渊契：底色和光晕换成冷的翠色
    box.classList.remove('on', 'out');
    void box.offsetWidth; // 重新触发入场动画
    box.classList.add('on');
    clearTimeout(box._t1);
    clearTimeout(box._t2);
    box._t1 = setTimeout(() => box.classList.add('out'), 3600);
    box._t2 = setTimeout(() => box.classList.remove('on', 'out'), 4300);
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
  const VD_TTL = 700; // 毫秒；地面名牌每帧都会问，面板重渲染时整体清空
  const vdCache = new Map(); // uid → { t, v }

  function statSnap() {
    const P = G.player;
    const save = G.save;
    const dps = {};
    // 武器普攻（basic）不是学会的技能，但它就是右键
    const usable = (id) => !!(id && G.SKILLS[id] && (G.SKILLS[id].basic || save.skills[id]));
    for (const i of [0, 2, 3]) {
      const id = save.bar[i];
      if (!usable(id) || dps[id] !== undefined) continue;
      dps[id] = G.skillDps(G.skillCtx(id));
    }
    // 右键单独记：换武器会换掉右键的武器普攻（换了类型）或改变它的伤害
    const rid = G.slotSkill(1);
    const rmb = usable(rid) ? { id: rid, dps: dps[rid] !== undefined ? dps[rid] : G.skillDps(G.skillCtx(rid)) } : null;
    // R 键的武器技：换武器会换掉它（换类型）或改变它的伤害（同类型，等级 / 武器伤害不同）
    const wid = typeof G.weaponSkill === 'function' ? G.weaponSkill() : null;
    const ws = wid ? { id: wid, dps: G.skillDps(G.skillCtx(wid)) } : null;
    return {
      dps, rmb, ws, life: P.maxLife, mana: P.maxMana, armour: P.armour,
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
  // 物品正穿在身上时返回 null。不改存档，不改当前生命 / 魔力，也不碰战斗中的状态（千目计数、双生待发、持续施放……，见 G.statTrial）。
  function verdict(item) {
    const save = G.save;
    const slot = item.slot;
    const cur = save.equip[slot];
    if (cur === item || (cur && cur.uid === item.uid)) return null;
    const now = performance.now();
    const hit = vdCache.get(item.uid);
    if (hit && now - hit.t < VD_TTL) return hit.v;

    const a = statSnap();
    // 换上之后的数值：G.statTrial 按 dry 模式试算（不碰正在打的仗、不写存档、不动武器模型），算完原样还回去
    const b = G.statTrial(slot, item, statSnap);

    const lines = [];
    let off = 0;
    let nOff = 0;
    let faint = false; // 有变化，但小到不值得单列一行
    // 两边右键是同一个技能时，和技能栏上的技能一起比；不是同一个时单独列一行「右键：A → B」，再比两边右键的秒伤
    if (a.rmb && b.rmb && a.rmb.id === b.rmb.id) {
      if (a.dps[a.rmb.id] === undefined) a.dps[a.rmb.id] = a.rmb.dps;
      if (b.dps[b.rmb.id] === undefined) b.dps[b.rmb.id] = b.rmb.dps;
    } else if (a.rmb || b.rmb) {
      const nm = (r) => (r ? '「' + G.SKILLS[r.id].name + '」' : '无');
      lines.push({ label: '右键', text: nm(a.rmb) + ' → ' + nm(b.rmb), pct: null, neutral: true });
      const ra = a.rmb ? a.rmb.dps || 0 : 0;
      const rb = b.rmb ? b.rmb.dps || 0 : 0;
      const d = rb - ra;
      const pct = ra > 0 ? (d / ra) * 100 : null;
      if (pct !== null) {
        off += G.clamp(pct, -100, 100);
        nOff++;
      }
      if (Math.abs(d) >= 0.05 && (pct === null || Math.abs(pct) >= 0.5)) lines.push({ label: '右键秒伤', text: signed(d), pct, good: d > 0 });
      else if (Math.abs(d) > 1e-6) faint = true;
    }
    for (const id in Object.assign({}, a.dps, b.dps)) {
      const av = a.dps[id] || 0;
      const bv = b.dps[id] || 0;
      const d = bv - av;
      const pct = av > 0 ? (d / av) * 100 : null;
      if (pct !== null) {
        off += pct;
        nOff++;
      }
      // 秒伤变化不到 0.5% 的不列出来（否则会出现「+0.1 +0%」这种噪音行）
      if (Math.abs(d) >= 0.05 && (pct === null || Math.abs(pct) >= 0.5)) {
        lines.push({ label: G.SKILLS[id].name + ' 秒伤', text: signed(d), pct, good: d > 0 });
      } else if (Math.abs(d) > 1e-6) faint = true;
    }
    // 武器技：同一个技能时比秒伤，按四分之一计入评分（最多 ±10），不让它压过技能栏上的主力技能；换了另一类武器就只列出换成了什么
    let wsScore = 0;
    if (a.ws && b.ws && a.ws.id === b.ws.id) {
      const d = b.ws.dps - a.ws.dps;
      const pct = a.ws.dps > 0 ? (d / a.ws.dps) * 100 : null;
      if (Math.abs(d) >= 0.05 && (pct === null || Math.abs(pct) >= 0.5)) {
        lines.push({ label: '武器技 ' + G.SKILLS[a.ws.id].name + ' 秒伤', text: signed(d), pct, good: d > 0 });
        wsScore = pct === null ? 0 : G.clamp(pct, -40, 40) * 0.25;
      } else if (Math.abs(d) > 1e-6) faint = true;
    } else if (a.ws || b.ws) {
      const nm = (w) => (w ? '「' + G.SKILLS[w.id].name + '」' : '无');
      lines.push({ label: '武器技', text: nm(a.ws) + ' → ' + nm(b.ws), pct: null, neutral: true });
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
    const score = (nOff ? off / nOff : 0) + def + util + wsScore;
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
      h += '<div class="vd-line ' + (l.neutral ? 'neutral' : l.good ? 'good' : 'bad') + '"><span>' + l.label + '</span><b>' + (l.neutral ? l.text : l.text.replace('-', '−')) + '</b>' +
        (l.pct === null ? '' : '<em>' + (l.pct >= 0 ? '+' : '−') + (ap < 9.95 ? ap.toFixed(1) : Math.round(ap)) + '%</em>') + '</div>';
    }
    return h + '</div>';
  }

  // 词缀某一阶的数值区间（与 items.js 的掷骰公式一致）
  function tierRange(def, tier) {
    return G.affixRange(def, tier);
  }
  function maxTierFor(ilvl) {
    let t = 0;
    for (let i = 0; i < G.TIER_ILVL.length; i++) if (G.TIER_ILVL[i] <= ilvl) t = i;
    return t;
  }

  // o：{ tag 顶部角标, vd 换装评估, hint 底部操作提示, affTips 词缀行可悬停看阶级区间, compact 烬铸卡片省掉来历等（详情栏用） }
  function itemCard(item, o) {
    o = o || {};
    const L = G.itemLines(item);
    let h = '<div class="icard r' + item.rarity + '">';
    if (o.tag) h += '<div class="ic-tag">' + o.tag + '</div>';
    h += '<div class="ic-head">' + itemIcon(item) + '<div class="ic-ttl"><div class="ic-name">' + esc(item.name) + '</div>';
    if (item.name !== item.baseName) h += '<div class="ic-base">' + esc(item.baseName) + '</div>';
    h += '</div></div>';
    const isW = item.slot === 'weapon';
    h += '<div class="ic-meta"><span>' + G.RARITY_NAME[item.rarity] + ' · ' + (isW ? G.SLOT_NAME.weapon + ' · ' + wTypeName(item.baseIdx | 0) : G.SLOT_NAME[item.slot]) + '</span><span>物品等级 ' + item.ilvl + '</span></div>';
    if (isW) h += weaponBlock(item, o.cmp);
    if (L.armour) h += '<div class="ic-line arm">护甲 <b>' + L.armour + '</b></div>';
    if (L.imp) h += '<div class="ic-line imp">' + esc(L.imp) + '</div>';
    const U = (item.rarity === 3 && G.UNIQUES[item.uq]) || (item.rarity === 4 && G.RELICS[item.rq]);
    if (U) {
      // 烬铸：词缀行后面写区间（固定行不写），再给完美度、机制、来历和「无法改造」
      h += '<div class="ic-sep"></div>';
      L.affixes.forEach((a, i) => {
        const r = G.uniqueRange(item, i);
        const fixed = U.lines[i] && U.lines[i].fixed !== undefined;
        h += '<div class="ic-line aff uq">' + esc(a.text) + (fixed ? '' : '<em class="ic-rng">（' + r[0] + '–' + r[1] + '）</em>') + '</div>';
      });
      const pf = Math.round(G.uniquePerfect(item) * 100);
      h += '<div class="ic-perf"><span>完美度 <b>' + pf + '%</b></span><i style="--p:' + pf + '%"></i></div>';
      h += '<div class="ic-uq"><b>' + esc(U.mechName) + '</b><span>' + esc(U.mechDesc) + '</span>' + altBox(U.mechAlt ? esc(U.mechAlt) : '') + '</div>';
      // 背包详情栏（o.compact）里省掉来历和「无法改造」（下面的通货栏已经写了），免得把按钮挤出窗口
      if (!o.compact) {
        if (U.lore) h += '<div class="ic-lore">' + esc(U.lore) + '</div>'; // 有几件没有来历，整行不出
        h += '<div class="ic-lock">' + lockText(item) + '</div>';
      }
    } else if (L.affixes.length) {
      h += '<div class="ic-sep"></div>';
      L.affixes.forEach((a, i) => {
        // 武器的本地词缀（只改这把武器的伤害）标一下，免得以为会再加一遍
        const af = item.affixes[i];
        const def = af && G.AFFIX_BY_ID[af.id];
        const local = !!(a.local || (def && (def.local || (G.LOCAL_STATS && G.LOCAL_STATS[def.stat]))));
        h += '<div class="ic-line aff ' + a.type + '"' + (o.affTips ? ' data-tip="aff:' + item.uid + ':' + i + '"' : '') + '><span class="ic-tier t' + a.tier + '">T' + a.tier + '</span>' + esc(a.text) +
          (local ? '<em class="ic-loc">已计入武器</em>' : '') + '</div>';
      });
    } else {
      h += '<div class="ic-sep"></div><div class="ic-line none">没有词缀</div>';
    }
    if (o.vd) h += verdictBlock(o.vd);
    if (o.hint) h += '<div class="ic-hint">' + o.hint + '</div>';
    h += '</div>';
    return h;
  }

  // 烬铸 / 渊契「无法改造」的说法
  const lockText = (it) => G.RARITY_NAME[it.rarity] + (it.rarity === 3 ? '武器' : '') + '无法改造';

  // 武器卡片上的伤害一节：物理伤害、每秒攻击、武器秒伤（cmp 给出时，每行后面标出与它相比的变化），以及自带的武器技
  function weaponBlock(item, cmp) {
    const w = wStats(item);
    const c = cmp && cmp !== item && cmp.uid !== item.uid ? wStats(cmp) : null;
    let h = '<div class="ic-wpn">';
    if (w) {
      // d：差值；pct：是否带百分比
      const delta = (d, base, digits) => {
        if (!c || Math.abs(d) < (digits ? 0.005 : 0.05)) return c ? '<em class="wd-eq">＝</em>' : '';
        const p = base > 0 ? (d / base) * 100 : 0;
        const ap = Math.abs(p);
        return '<em class="' + (d > 0 ? 'wd-up' : 'wd-down') + '">' + (d > 0 ? '▲' : '▼') + (digits ? Math.abs(d).toFixed(2) : fmt1(Math.abs(d))) +
          (base > 0 ? '<i>' + (d > 0 ? '+' : '−') + (ap < 9.95 ? ap.toFixed(1) : Math.round(ap)) + '%</i>' : '') + '</em>';
      };
      h +=
        '<div class="ic-line wd"><span>物理伤害</span><b>' + Math.round(w.min) + '–' + Math.round(w.max) + '</b>' + (c ? delta((w.min + w.max - c.min - c.max) / 2, (c.min + c.max) / 2) : '') + '</div>' +
        '<div class="ic-line wd"><span>每秒攻击</span><b>' + w.aps.toFixed(2) + '</b>' + (c ? delta(w.aps - c.aps, c.aps, 2) : '') + '</div>' +
        '<div class="ic-line wd dps"><span>武器秒伤</span><b>' + fmt1(w.dps) + '</b>' + (c ? delta(w.dps - c.dps, c.dps) : '') + '</div>';
      const b = wBase(item);
      if (b && b.caster) h += '<div class="ic-wcmp">施法武器：武器伤害低，法术与召唤不看它</div>';
      if (c) h += '<div class="ic-wcmp">箭头是与身上那把（秒伤 ' + fmt1(c.dps) + '）相比</div>';
    }
    const wid = wSkillOf(item);
    if (wid) {
      const sk = G.SKILLS[wid];
      const cw = cmp ? wSkillOf(cmp) : null;
      const u = !!sk.uskill;
      const rp = u && sk.replaces && G.SKILLS[sk.replaces];
      h +=
        '<div class="ic-wsk' + (u ? ' uq' : '') + '" style="--c:' + sk.color + '"' + (u ? ' data-tip="wsk:' + wid + '"' : '') + '><span class="tc-skico sm">' + IC.skill(wid) + '</span><span><em>' + (u ? '烬铸技' : '武器技') + ' <kbd>R</kbd></em><b>' + sk.name + '</b></span>' +
        (sk.cd > 0 ? '<i>冷却 ' + fmt1(sk.cd) + ' 秒</i>' : '') + '</div>' +
        (u ? '<div class="ic-usk"><span class="u-d">' + esc(sk.desc) + '</span>' + (rp ? '<em>替换这类武器的武器技「' + rp.name + '」</em>' : '') + '</div>' : '') +
        (cw && cw !== wid ? '<div class="ic-wcmp">换上后 <kbd>R</kbd> 从「' + G.SKILLS[cw].name + '」变为「' + sk.name + '」</div>' : '');
    }
    return h + '</div>';
  }

  // 物品提示：卡片 + 换装评估，身上同部位有装备时并排列出来对比
  function itemTip(item, equipped, hint) {
    if (equipped) return itemCard(item, { tag: '已装备', hint });
    const eq = G.save.equip[item.slot];
    const card = itemCard(item, { vd: verdict(item), hint, cmp: eq });
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
    // 混沌：吃三种元素各自的提高（元素伤害提高只算一次）+ 混沌伤害提高。学了混沌技能、或身上有混沌专属的属性时才列出来
    const chInc = s('incFire') + s('incCold') + s('incLight') + s('incChaos');
    const chaosSk = Object.keys(G.save.skills).some((id) => G.SKILLS[id] && G.SKILLS[id].tags.indexOf('chaos') >= 0);
    if (chaosSk || s('incChaos') || s('moreChaos') || s('addChaos')) {
      h += row('混沌伤害', pct(s('incAll') + s('incElem') + chInc), G.TYPE_COLOR.chaos);
      if (s('moreChaos')) h += row('混沌总额外', pct(s('moreChaos')), G.TYPE_COLOR.chaos);
    }
    if (G.flamePct && G.flamePct() > 0) h += row('黑焰额外混沌', fmt1(G.flamePct()) + '%', G.TYPE_COLOR.chaos);
    if (s('elemPen')) h += row('元素穿透', fmt1(s('elemPen')) + '%'); // 装备上的「元素穿透」（辅助「破障」另算在技能上）
    for (const t of G.TYPES) {
      const v = s('add' + G.CAP[t]);
      if (v) h += row('附加' + G.TYPE_NAME[t], Math.max(1, Math.round(v * 0.7)) + '–' + Math.max(2, Math.round(v * 1.3)), G.TYPE_COLOR[t]);
    }
    if (s('ownLess')) h += row('自身总伤害', '-' + fmt1(s('ownLess')) + '%', '#ff7a6a');
    // 召唤物：学会了召唤技能，或者身上 / 天赋里有召唤物属性时才列出来
    const hasSummon = Object.keys(G.save.skills).some((id) => G.SKILLS[id] && G.SKILLS[id].kind === 'summon');
    if (hasSummon || MINION_STATS.some((k) => s(k)) || s('mWeapon') || s('mDef') || s('mLife')) {
      h += '</div><div class="st-group ally">召唤物</div><div class="st-grid">';
      h += row('召唤物伤害', pct(s('minionDmg')), ALLY);
      h += row('召唤物生命', pct(s('minionLife')), ALLY);
      h += row('攻击与移动速度', pct(s('minionSpeed')), ALLY);
      h += row('仆从数量上限', '+' + fmt1(s('minionCap')), ALLY);
      if (s('minionMore')) h += row('召唤物总伤害', pct(s('minionMore')), s('minionMore') > 0 ? '#ffb066' : '#ff7a6a');
      if (s('minionArea')) h += row('召唤物范围', pct(s('minionArea')), ALLY);
      if (s('minionCharge')) h += row('焰蓄攒得快', pct(s('minionCharge')), ALLY);
      if (s('mWeapon')) {
        // 万魂旗：显示提高后的比例，并写明倍数（倍数随武器物品等级折算）
        const wMul = P.uMech === 'soul' ? G.minionInherit(null).wMul : 1;
        h += row('继承武器伤害', wMul > 1 ? fmt1(s('mWeapon') * wMul) + '%（万魂旗 × ' + +wMul.toFixed(2) + '）' : fmt1(s('mWeapon')) + '%', ALLY);
      }
      if (s('mDef')) h += row('继承护甲与抗性', fmt1(Math.min(100, s('mDef'))) + '%', ALLY);
      if (s('mLife')) h += row('继承装备生命', fmt1(s('mLife')) + '%', ALLY);
    }
    h += '</div><div class="st-group">其他</div><div class="st-grid">';
    h += row('技能范围', pct(s('area')));
    h += row('异常累积速度', (s('ailment') > 0 ? '+' : '') + pct(s('ailment')));
    h += row('物品稀有度', pct(s('rarity')));
    h += row('击杀回复', fmt1(s('lifeOnKill')));
    if (s('costReduce')) h += row('消耗降低', fmt1(s('costReduce')) + '%');
    if (s('dodgeCd')) h += row('翻滚冷却', pct(-s('dodgeCd')), s('dodgeCd') > 0 ? null : '#ff7a6a');
    if (s('moreElem')) h += row('元素总伤害', pct(s('moreElem')), s('moreElem') > 0 ? '#ffb066' : '#ff7a6a');
    if (s('moreTaken')) h += row('承受伤害', '+' + fmt1(s('moreTaken')) + '%', '#ff7a6a');
    if (s('resLoss')) h += row('元素抗性（上限后）', '-' + fmt1(s('resLoss')) + '%', '#ff7a6a');
    if (s('moreDmg')) h += row('总伤害', pct(s('moreDmg')), s('moreDmg') > 0 ? '#ffb066' : '#ff7a6a');
    if (s('allMore')) h += row('你和召唤物总伤害', pct(s('allMore')), '#ffb066');
    if (s('lessTaken')) h += row('承受伤害', '-' + fmt1(s('lessTaken')) + '%', '#9fdc8a');
    if (s('moreLife')) h += row('生命总量', pct(s('moreLife')), s('moreLife') > 0 ? '#9fdc8a' : '#ff7a6a');
    if (s('bloodMagic')) h += row('技能消耗', '生命', '#ff7a6a');
    h += '</div>';
    return h;
  }

  // 烬铸图鉴：三把烬铸武器（拾到过没有、见过的最高完美度）和各首领的保底进度
  // 和这把烬铸共用首领掉落与保底的另一把（衔星巨兽：凛羽 / 星蚀），没有时 null
  function shareOf(id) {
    const D = G.UNIQUES[id], alt = (G.UNIQUE_ALT && G.UNIQUE_ALT[D.boss]) || [];
    if (!alt.length) return null;
    const first = G.UNIQUE_BY_BOSS[D.boss];
    return id === first ? alt[0] : first;
  }
  function codexHtml() {
    const U = G.save.uniq || { found: {}, best: {}, pity: {} };
    const pity = G.UNIQUE_DROP.pity;
    const nFound = G.UNIQUE_IDS.filter((id) => U.found[id]).length;
    let rows = '';
    for (const id of G.UNIQUE_IDS) {
      const D = G.UNIQUES[id];
      const found = !!U.found[id];
      const boss = G.BOSSES[D.boss];
      const n = U.pity[D.boss] || 0;
      const fake = { slot: 'weapon', baseIdx: D.base, baseName: G.BASES.weapon[D.base].names[2], rarity: 3, uq: id };
      rows +=
        '<div class="cx-row' + (found ? ' found' : '') + '" data-uq="' + id + '">' +
        '<span class="ibox r3' + (found ? '' : ' unk') + '">' + IC.item(fake) + '</span>' +
        '<div class="cx-main"><div class="cx-name">' + (found ? esc(D.name) : '？？？') + '<em>' + wTypeName(D.base) + '</em></div>' +
        '<div class="cx-sub"><b>' + esc(D.mechName) + '</b> · ' + esc(boss.name) + '（轮回 1 起）' + (shareOf(id) ? ' · 与' + esc(G.UNIQUES[shareOf(id)].name) + '共用掉落与保底' : '') + '</div>' +
        '<div class="cx-stat"><span>' + (found ? '最高完美度 <b>' + (U.best[id] || 0) + '%</b>' : '尚未拾到') + '</span>' +
        '<span class="cx-pity">保底 <b>' + n + '</b>/' + pity + '<i style="--p:' + Math.round((n / pity) * 100) + '%"></i></span></div></div></div>';
    }
    return (
      '<div class="sec-title sm codex-t">烬铸图鉴<span class="sec-note">已拾到 ' + nFound + ' / ' + G.UNIQUE_IDS.length + '</span></div>' +
      '<div class="codex">' + rows +
      '<div class="cx-note">层级 1 约 ' + Math.round(G.UNIQUE_DROP.chance[1] * 100) + '%、层级 2 起约 ' + Math.round(G.UNIQUE_DROP.chance[2] * 100) + '%，最晚第 ' + (pity + 1) + ' 次必掉</div></div>' +
      relicCodexHtml()
    );
  }
  // 渊契图鉴（排在烬铸后面）：13 件普通渊契 + 2 件巅峰专属（G.RELIC_CODEX，巅峰的排在最后），拾到过的显示名字、图标和最高完美度；没拾到的是基底的暗剪影。
  // 每件写来源（首领 / 异兆 / 烈印 / 熄烛者；来源还没开放时写「尚未开放」）和保底进度（烈印两件共用一份，巅峰两件共用 save.pinnacle.pity）
  function relicCodexHtml() {
    const U = G.save.relic || { found: {}, best: {}, pity: {} };
    const D = G.RELIC_DROP;
    const list = G.RELIC_CODEX || G.RELIC_IDS;
    const nFound = list.filter((id) => U.found[id]).length;
    let rows = '';
    for (const id of list) {
      const R = G.RELICS[id];
      const found = !!U.found[id];
      const pin = R.src === 'pinnacle';
      const key = R.src === 'seal' ? 'seal' : id;
      const max = pin ? D.pinnacle.pity : G.relicPityMax(key);
      const n = pin ? (G.save.pinnacle && G.save.pinnacle.pity) || 0 : U.pity[key] || 0;
      const open = pin || !!D.src[R.src];
      const src = R.src === 'boss' ? esc(G.BOSSES[R.boss].name) + '（轮回 1 起）' : R.src === 'enc' ? '异兆「' + esc(G.RELIC_ENC_NAME[R.enc] || R.enc) + '」' : pin ? esc(G.BOSSES.snuffer.name) + '（巅峰，首杀必掉）' : '烈印下击杀首领';
      const icon = found ? IC.item({ slot: R.slot, baseIdx: R.base, baseName: '', rarity: 4, rq: id }) : IC.item({ slot: R.slot, baseIdx: R.base, baseName: G.BASES[R.slot][R.base].names[2], rarity: 0 });
      rows +=
        '<div class="cx-row rq' + (pin ? ' pin' : '') + (found ? ' found' : '') + '" data-rq="' + id + '">' +
        '<span class="ibox r4' + (found ? '' : ' unk') + '">' + icon + '</span>' +
        '<div class="cx-main"><div class="cx-name">' + (found ? esc(R.name) : '？？？') + '<em>' + G.SLOT_NAME[R.slot] + '</em></div>' +
        '<div class="cx-sub"><b>' + esc(R.mechName) + '</b> · ' + src + (open ? '' : ' · 尚未开放') + '</div>' +
        '<div class="cx-stat"><span>' + (found ? '最高完美度 <b>' + (U.best[id] || 0) + '%</b>' : '尚未拾到') + '</span>' +
        (open ? '<span class="cx-pity">保底 <b>' + n + '</b>/' + max + '<i style="--p:' + Math.round((n / max) * 100) + '%"></i></span>' : '') + '</div></div></div>';
    }
    return (
      '<div class="sec-title sm codex-t rq">' + G.RELIC_NAME + '图鉴<span class="sec-note">已拾到 ' + nFound + ' / ' + list.length + '</span></div>' +
      '<div class="codex rq">' + rows +
      '<div class="cx-note">区域首领：层级 1 约 ' + Math.round(D.boss.chance[1] * 100) + '%、层级 2 起约 ' + Math.round(D.boss.chance[2] * 100) + '%，最晚第 ' + (D.boss.pity + 1) + ' 次必掉</div></div>'
    );
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
      const acts =
        '<div class="act-row' + (it.rarity >= 3 ? ' top' : '') + '">' +
        (sel.equipped
          ? '<button type="button" tabindex="-1" class="btn" data-act="unequip">卸下</button>'
          : '<button type="button" tabindex="-1" class="btn primary" data-act="equip">装备</button>' +
            '<button type="button" tabindex="-1" class="btn" data-act="salvage">分解</button>' +
            '<button type="button" tabindex="-1" class="btn" data-act="drop">丢弃</button>') +
        '</div>' +
        (ui.invMsg ? '<div class="inv-msg">' + esc(ui.invMsg) + '</div>' : ui.invOk ? '<div class="inv-msg ok">' + esc(ui.invOk) + '</div>' : '');
      // 烬铸武器 / 渊契的卡片很长（区间、完美度、机制说明）：按钮放到卡片上面，小窗口里也不用往下滚就能点到
      const fixed = it.rarity >= 3;
      detail =
        '<div class="sec-title">' + (sel.equipped ? '已装备' : '背包物品') + '</div>' +
        (fixed ? acts : '') +
        '<div class="detail-card' + (ui.flash ? ' flash' : '') + '" data-item="' + it.uid + '">' +
        itemCard(it, { vd: sel.equipped ? null : verdict(it), affTips: !fixed, compact: fixed, cmp: sel.equipped ? null : S.equip[it.slot] }) + '</div>' +
        (fixed
          ? ''
          : (cap
            ? '<div class="aff-count">前缀 <b>' + np + '</b>/' + cap + '<i></i>后缀 <b>' + ns + '</b>/' + cap + '<i></i>悬停词缀查看阶级</div>'
            : '<div class="aff-count">普通物品没有词缀，可以用通货改造</div>') + acts) +
        '<div class="sec-title sm">通货改造<span class="sec-note">' + (fixed ? lockText(it) : '点击，或把通货拖到物品上') + '</span></div>' +
        '<div class="craft-grid' + (fixed ? ' locked' : '') + '">' + craft + '</div>';
    } else {
      detail =
        '<div class="sec-title">物品详情</div>' +
        '<div class="detail-empty"><div class="de-glyph"><span>鉴</span></div>' +
        '<p>点击物品看详情，悬停与身上的对比。</p>' +
        '<p><b>右键</b>或拖到装备栏穿上，<b class="vd-up">▲</b> 表示更强。</p>' +
        '<p>把<b>通货</b>拖到物品上改造；拖出窗口丢弃。</p>' +
        (ui.invMsg ? '<p class="inv-msg">' + esc(ui.invMsg) + '</p>' : '') + '</div>' + codexHtml();
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
      '<button type="button" tabindex="-1" class="btn sm uqb' + (sel ? '' : ' on') + '" data-act="codex" data-tip="txt:烬铸与渊契的收集和保底进度">图鉴</button>' +
      '<button type="button" tabindex="-1" class="btn sm" data-act="sort"' + (S.bag.length > 1 ? '' : ' disabled') + '>整理</button>' +
      '<button type="button" tabindex="-1" class="chk' + (withMagic ? ' on' : '') + '" data-act="opt" data-opt="salvageMagic"><i></i>含魔法</button>' +
      '<button type="button" tabindex="-1" class="btn sm" data-act="salvage-all"' + (bulkN ? '' : ' disabled') + '>一键分解' + (bulkN ? '（' + bulkN + '）' : '') + '</button></div>' +
      '<div class="bag">' + bag + '</div>' +
      '<div class="sec-title">通货<span class="sec-note">拖到物品上使用</span></div><div class="cur-row">' + cur + '</div>' +
      fragRow() +
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
    if (sup.needCd && sk && !(sk.cd > 0)) return '只能用于有冷却的技能'; // 储能
    if (sup.noId && sup.noId.indexOf(skillId) >= 0) return sk.name + '用不上';
    const vs = fitVariants(skillId, sup);
    if (vs.length) return '选' + vs.join(' / ') + '刻式时才能镶';
    return '需要标签：' + reqText(sup);
  }
  // 这个技能的哪几种刻式用得上这颗辅助（标签随刻式变的时候，例如绵延只认雷桩）：刻式名的数组
  function fitVariants(skillId, sup) {
    const supId = Object.keys(G.SUPPORTS).find((k) => G.SUPPORTS[k] === sup);
    if (!supId || !G.VARIANTS[skillId] || !G.SKILL_V || !G.SKILL_V[skillId]) return [];
    const keep = G.SKILLS[skillId], out = [];
    for (const v of ['o'].concat(Object.keys(G.VARIANTS[skillId]))) {
      G.SKILLS[skillId] = G.skillVariant(skillId, v);
      if (G.supportFits(skillId, supId)) out.push(v === 'o' ? G.VARIANT_NAME.o : G.VARIANTS[skillId][v].name);
    }
    G.SKILLS[skillId] = keep;
    return out;
  }
  // 适用范围的一句话：「任意技能」/ 「物理」/ 「任意技能（召唤物除外）」
  function scopeText(sup) {
    const no = sup.no && sup.no.length ? '（' + sup.no.map((t) => G.TAG_NAME[t] || t).join(' / ') + '除外）' : '';
    return (sup.req ? reqText(sup) : sup.needCd ? '有冷却的技能' : '任意技能') + no;
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

  // 召唤技能卡上的「继承装备」一行：统御外圈的天赋让召唤物继承你的武器伤害、护甲 / 抗性、装备生命。
  // 一点都没有时给一句去哪里点的提示
  function inheritNote(ctx) {
    const h = ctx.minion && ctx.minion.inherit;
    if (!h) return '';
    if (!(h.weapon > 0 || h.def > 0 || h.lifePct > 0)) {
      return '<div class="sk-inh off"><i></i>统御外圈天赋可让召唤物继承武器伤害、护甲与抗性、装备生命</div>';
    }
    const parts = [];
    if (h.add) {
      const item = G.save.equip.weapon;
      const src = item ? wTypeName(item.baseIdx | 0) : '空手';
      parts.push('武器 <b>' + fmtInt(h.add[0]) + '–' + fmtInt(h.add[1]) + '</b> 物理 / 每击（' + src + '伤害 × ' + fmt1(h.wMul > 1 ? h.wBase : h.weapon) + '%' + (h.wMul > 1 ? ' × 万魂旗 ' + +h.wMul.toFixed(2) : '') +
        (h.gate < 1 ? ' × 物品等级 ' + h.ilvl + ' 折算 ' + Math.round(h.gate * 100) + '%' : '') + (h.soul > 1 ? ' × ' + h.soul + ' 倍' : '') + (ctx.sk.inherit > 1 ? ' × 守像 ' + ctx.sk.inherit : '') + '）');
    } else if (h.weapon > 0) {
      parts.push('武器：没有装备武器，无可继承');
    }
    if ((h.def > 0 || h.lifePct > 0) && h.gateDef < 1) parts.push('防御与生命按装备平均物品等级 ' + h.ilvlDef + ' 折算 ' + Math.round(h.gateDef * 100) + '%');
    if (h.def > 0) {
      parts.push('护甲 <b>' + fmtInt(h.armour) + '</b>');
      parts.push('抗性 <b>' + G.ELEMS.map((t) => '<span style="color:' + G.TYPE_COLOR[t] + '">' + Math.round(h.res[t]) + '%</span>').join(' / ') + '</b>');
    }
    if (h.lifePct > 0) parts.push('生命 <b>+' + fmtInt(h.life) + '</b>');
    return '<div class="sk-inh"><i></i><span>继承装备：' + parts.join(' · ') + '</span></div>';
  }

  // 攻击技能卡上的一行：每一击 = 武器伤害 × 武器倍率 × 宝石等级加成，出手速度随武器攻速
  function attackNote(ctx) {
    const w = ctx.weapon || G.FISTS || null;
    if (!w || !(ctx.wm > 0)) return '';
    const item = G.save.equip.weapon;
    const src = item ? wTypeName(item.baseIdx | 0) : '空手';
    const lk = ctx.levelK > 1.0005 ? '<span class="wn-op">×</span>宝石 <b>+' + Math.round((ctx.levelK - 1) * 100) + '%</b>' : '';
    return (
      '<div class="sk-anote wpn"><i></i><span>伤害取自武器：' + src + ' <b>' + Math.round(w.min) + '–' + Math.round(w.max) + '</b><span class="wn-op">×</span>倍率 <b>' + Math.round(ctx.wm * 100) + '%</b>' + lk +
      ' · 攻速 <b>×' + (w.aps > 0 ? w.aps : 1).toFixed(2) + '</b>' + (G.cdAps && G.cdAps(ctx.sk) ? '（攻速折进伤害）' : '') + (item ? '' : '（空手很弱）') + '</span></div>'
    );
  }

  // ---------- 武器普攻卡：右键固定是手里武器的普攻（空手是拳击）；3 个辅助孔属于卡片本身（save.sockets[G.BASIC_CARD]） ----------
  const BASIC_KEY = () => G.BASIC_CARD || 'wbasic';
  const RANGED_ORDER = ['gatling', 'flamer', 'revolver', 'huntbow', 'eagle', 'runebow', 'emberbow'];
  // 卡片底下一排：每种武器各自的普攻（近战、施法、魂幡、空手在前，远程在后）
  const BASIC_ORDER = ['blade', 'daggers', 'hammer', 'katana', 'staff', 'wand', 'banner', 'fists'].concat(RANGED_ORDER);
  const basicTypeName = (t) => {
    if (t === 'fists') return '空手';
    const bi = (G.BASES.weapon || []).findIndex((b) => b && b.type === t);
    return bi >= 0 ? wTypeName(bi) : t;
  };
  const GAUGE_TXT = {
    heat: '热度：开火上涨，停火回落。满了 <kbd>R</kbd> 亮起，放出时排空',
    focus: '专注：命中上涨，暴击和远距离更多，挨打会掉。满了 <kbd>R</kbd> 亮起，放出限时增益',
  };
  // 技能名（辅助孔的主人可能是武器普攻卡，它不是一个技能）
  const skName = (id) => (id === BASIC_KEY() ? '武器普攻' : G.SKILLS[id] ? G.SKILLS[id].name : String(id));
  function basicCard() {
    const S = G.save, key = BASIC_KEY(), rw = rangedNow();
    const id = G.weaponBasic ? G.weaponBasic() : null;
    const sk = id ? G.SKILLS[id] : null;
    const socks = S.sockets[key] || [null, null, null];
    let live = [];
    try {
      live = id && typeof G.basicSupports === 'function' ? G.basicSupports(id) : [];
    } catch (e) {
      live = [];
    }
    let sockets = '';
    for (let i = 0; i < 3; i++) {
      const sup = socks[i];
      const picking = ui.picker && ui.picker.skill === key && ui.picker.idx === i;
      if (sup && G.SUPPORTS[sup]) {
        const idle = id && live.indexOf(sup) < 0; // 镶着，但对现在这把武器的普攻不生效
        sockets +=
          '<button type="button" tabindex="-1" class="sock full' + (idle ? ' idle' : '') + '" data-act="socket" data-skill="' + key + '" data-idx="' + i + '" data-tip="sock:' + sup + '" data-drag="sup:' + sup + '">' +
          IC.sup(sup) + G.SUPPORTS[sup].name + (idle ? '<em>不生效</em>' : '') + '</button>';
      } else {
        sockets += '<button type="button" tabindex="-1" class="sock' + (picking ? ' picking' : '') + '" data-act="socket" data-skill="' + key + '" data-idx="' + i + '"><i></i>空槽</button>';
      }
    }
    const row = BASIC_ORDER.filter((t) => G.SKILLS['basic_' + t]).map((t) => {
      const bid = 'basic_' + t, bs = G.SKILLS[bid];
      return '<span class="wsl' + (bid === id ? ' on' : '') + '" style="--c:' + bs.color + '" data-tip="wsk:' + bid + '">' + IC.skill(bid) + '<em>' + basicTypeName(t) + '</em></span>';
    }).join('');
    const num = (label, val, cls) => '<div class="sk-num' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span><b>' + val + '</b></div>';
    let body;
    if (sk) {
      let ctx = null, avg = 0, rate = 0;
      try {
        ctx = G.skillCtx(id);
        avg = G.avgHit(ctx);
        rate = G.skillRate(ctx);
      } catch (e) {
        ctx = null;
      }
      const g = sk.rtype && rw ? rw.gauge : null;
      let nums = '';
      if (ctx && sk.combo) {
        // 近战连招：每段平均、整套的段数和秒伤（按住右键一路打完、攻速快慢整串一起缩放）
        nums = num('每段平均', fmtDmg(avg), 'hl') + num('连招', sk.combo.length + ' 段') + num('估算秒伤', fmtDmg(avg * rate)) +
          num('暴击率', fmt1(ctx.crit) + '%') + num('魔力消耗', '无');
      } else if (ctx) {
        nums = num(sk.rtype === 'flamer' ? '每一跳' : sk.cyc ? '每发平均' : '每发伤害', fmtDmg(avg), 'hl') +
          num(sk.rtype === 'flamer' ? '每秒几跳' : '每秒几发', rate > 0 ? rate.toFixed(2) : '—') +
          num('估算秒伤', fmtDmg(avg * rate)) +
          num('暴击率', fmt1(ctx.crit) + '%') +
          (g ? num(g.name, Math.floor(g.v) + ' / ' + g.max, g.full ? 'full' : '') : '') +
          (sk.perMinion ? num('召唤物加成', '+' + Math.round(((ctx.more / Math.max(1e-6, 1 + (G.player.S.minionMore || 0) / 100)) - 1) * 100) + '%') : '') +
          num('魔力消耗', '无');
      }
      // 元素：施法武器的普攻取你加成最高的元素
      const el = ctx && !ctx.attack && !sk.asMinion ? Object.keys(ctx.base)[0] : null;
      body =
        '<div class="sk-desc"><span class="sk-dt">' + sk.desc + '</span>' + altBox(sk.alt) + '</div>' +
        (sk.combo ? '<div class="sk-combo">' + sk.combo.map((c, i) => '<span' + (c.w >= 2 ? ' class="fin"' : '') + '>' + (c.w >= 2 ? '终结 ' : '第 ' + (i + 1) + ' 段 ') + '×' + c.mult + '</span>').join('<i></i>') + '</div>' : '') +
        (comboSteps(sk) && !sk.combo ? '<div class="sk-combo">' + sk.cyc.map((c, i) => '<span' + (c.heavy ? ' class="fin">重弹 ' : '>第 ' + (i + 1) + ' 发 ') + '×' + c.mult + '</span>').join('<i></i>') + '</div>' : '') + // 灵弹：三下一轮
        (nums ? '<div class="sk-nums">' + nums + '</div>' : '') +
        (ctx && ctx.attack ? attackNote(ctx) : '') +
        (el ? '<div class="sk-anote"><i></i><span>法术：随武器物品等级成长，属性取加成最高的元素（现在是 <b style="color:' + G.TYPE_COLOR[el] + '">' + G.TYPE_NAME[el] + '</b>）</span></div>' : '') +
        (sk.asMinion ? '<div class="sk-anote"><i></i><span>伤害按召唤物计算，吃召唤物加成和辅助</span></div>' : '') +
        (g ? '<div class="sk-anote gauge ' + g.kind + '"><i></i><span>' + (GAUGE_TXT[g.kind] || '') + '</span></div>' : '');
    } else {
      body =
        '<div class="sk-desc"><kbd>右键</kbd>是武器自己的普攻，不耗魔力。</div>' +
        '<div class="sk-anote"><i></i><span>辅助孔属于这张卡，换武器不用取下</span></div>';
    }
    const item = S.equip.weapon;
    return (
      '<div class="skill-card basic-card' + (sk ? '' : ' off') + (sk && /revolver|emberbow/.test(sk.rtype) ? ' uq' : '') + '" style="--c:' + (sk ? sk.color : '#a08868') + '">' +
      '<div class="sk-top"><div class="sk-icon"' + (id ? ' data-tip="wsk:' + id + '"' : '') + '>' + (id ? IC.skill(id) : IC.basicBlank ? IC.basicBlank() : '') + '</div>' +
      '<div class="sk-title"><div class="sk-name">武器普攻' + (sk ? '<em class="bc-name">' + sk.name + '</em>' : '') + '</div>' +
      '<div class="wsk-src">' + (item ? '来自 ' + esc(item.name) + ' · ' + wTypeName(item.baseIdx | 0) : '空手') + '</div></div>' +
      '<div class="sk-binds"><span class="bind lock' + (sk ? ' on' : '') + '">右键</span></div></div>' +
      body +
      '<div class="wsk-row">' + row + '</div>' +
      '<div class="sk-socks"><span class="sk-socks-label">辅助</span>' + sockets + '</div>' +
      '</div>'
    );
  }

  // 技能页右栏顶上的武器技一节：当前武器技的卡片（数值、成长方式；不能镶辅助），下面一排是每种武器各自的武器技
  function wskillSection() {
    const S = G.save;
    const item = S.equip.weapon;
    const id = curWSkill();
    const row = (G.BASES.weapon || [])
      .map((b, bi) => {
        const wid = b && b.wskill && G.SKILLS[b.wskill] ? b.wskill : null;
        const type = wTypeOf(bi);
        const on = !!item && (item.baseIdx | 0) === bi;
        return (
          '<span class="wsl' + (on ? ' on' : '') + '" style="--c:' + (wid ? G.SKILLS[wid].color : IC.wskColor(type)) + '"' + (wid ? ' data-tip="wsk:' + wid + '"' : '') + '>' +
          (wid ? IC.skill(wid) : IC.wsk(type)) + '<em>' + wTypeName(bi) + '</em></span>'
        );
      })
      .join('');
    let main;
    if (!id) {
      main =
        '<div class="wsk-empty"><div class="wsk-slot">R</div><div><b>' + (item ? '这把武器没有武器技' : '没有装备武器') + '</b>' +
        '<p>每种武器自带一招 <kbd>R</kbd> 键<b>武器技</b>。' + (item ? '' : '装备武器即可使用。') + '</p></div></div>';
    } else {
      const sk = G.SKILLS[id];
      let ctx = null;
      let avg = 0;
      let rate = 0;
      try {
        ctx = G.skillCtx(id);
        avg = G.avgHit(ctx);
        rate = G.skillRate(ctx);
      } catch (e) {
        ctx = null;
      }
      const blood = G.player.S.bloodMagic > 0;
      const num = (label, val, cls) => '<div class="sk-num' + (cls ? ' ' + cls : '') + '"><span>' + label + '</span><b>' + val + '</b></div>';
      const isAtk = sk.tags.indexOf('attack') >= 0;
      let lvl = 0;
      try {
        lvl = typeof G.weaponSkillLevel === 'function' ? G.weaponSkillLevel(id) : 0;
      } catch (e) {
        lvl = 0;
      }
      let nums = ctx
        ? num('每次伤害', fmtDmg(avg), 'hl') +
          num('冷却', ctx.cd > 0 ? fmt1(ctx.cd) + ' 秒' : '无') +
          num('估算秒伤', fmtDmg(avg * rate)) +
          num(blood ? '生命消耗' : '魔力消耗', ctx.cost > 0 ? fmt1(ctx.cost) : '无') +
          num('暴击率', sk.sureCrit ? '必定暴击' : fmt1(ctx.crit) + '%') +
          num('等级', lvl ? 'Lv ' + lvl : '—')
        : '';
      // 烬铸技：换一组更能说明它的数字
      if (ctx && sk.uskill) {
        const cdN = num('冷却', fmt1(ctx.cd) + ' 秒');
        const costN = num(blood ? '生命消耗' : '魔力消耗', ctx.cost > 0 ? fmt1(ctx.cost) : '无');
        if (ctx.minion) {
          const one = G.avgHit(ctx);
          nums = num('英灵每击', fmtDmg(one), 'hl') + num('英灵生命', fmtInt(ctx.minion.life)) + num('数量 · 持续', sk.n + ' 位 · ' + sk.dur + ' 秒') + cdN + costN + num('等级', lvl ? 'Lv ' + lvl : '—');
        } else if (sk.kind === 'ustaff') {
          const per = avg / (sk.useMult || 1);
          nums = num('每一击', fmtDmg(per), 'hl') + num('击数', Math.round(sk.dur / sk.tick) + ' 击 · ' + sk.dur + ' 秒') + num('异常累积', '+' + sk.ailment + '%') + cdN + costN + num('等级', lvl ? 'Lv ' + lvl : '—');
        } else {
          const per = avg / (sk.useMult || 1);
          nums = num('单体总伤', fmtDmg(avg), 'hl') + num('每一闪 · 斩痕', fmtDmg(per * sk.pass) + ' · ' + fmtDmg(per * sk.cut)) + num('每层残刃', fmtDmg(per * sk.mark)) + cdN + costN + num('暴击率', fmt1(ctx.crit) + '%');
        }
      }
      // 远程武器的量表技：没有冷却、不耗魔力，量表满了才能放
      if (ctx && sk.rgauge) {
        const rw = rangedNow(), g = rw && rw.gauge;
        const gN = num(g ? g.name : '量表', g ? Math.floor(g.v) + ' / ' + g.max : '—', g && g.full ? 'full' : '');
        if (sk.buff) {
          const dur = sk.buff.dur * Math.max(0.1, 1 + ((G.player.S && G.player.S.buffDur) || 0) / 100);
          nums = num('增益持续', fmt1(dur) + ' 秒', 'hl') + gN + num('冷却', '无') + num('魔力消耗', '无') + num('暴击率', fmt1(ctx.crit) + '%') + num('等级', lvl ? 'Lv ' + lvl : '—');
        } else if (sk.basicOf) {
          // 按普攻折算的（熔光射线、焚天炎爆）：蓄满一发 / 整招的伤害，冷却那格换成折合几秒普攻
          nums = num(sk.charge ? '蓄满一发' : '整招伤害', fmtDmg(avg), 'hl') + gN + num('折合普攻', fmt1(sk.basicSec * (sk.useMult || 1)) + ' 秒') + num('魔力消耗', '无') + num('暴击率', fmt1(ctx.crit) + '%') + num('等级', lvl ? 'Lv ' + lvl : '—');
        } else {
          nums = num(sk.useMult > 1 ? '整招伤害' : '每次伤害', fmtDmg(avg), 'hl') + gN + num('冷却', '无') + num('魔力消耗', '无') + num('暴击率', fmt1(ctx.crit) + '%') + num('等级', lvl ? 'Lv ' + lvl : '—');
        }
      }
      const w = ctx && ctx.weapon ? ctx.weapon : wStats(item);
      const gk = wGrowKind(sk);
      const bsk = sk.basicOf && G.SKILLS[sk.basicOf];
      const grow = gk === 'attack' && bsk && ctx
        ? '攻击型：按普攻折算——' + (sk.charge
            ? '蓄满一发 = 机炮转满之后扫射 <b>' + fmt1(sk.basicSec) + ' 秒</b>（每秒约 <b>' + fmt1(G.basicShots(sk) / sk.basicSec) + '</b> 发'
            : '火浪 = 喷枪持续喷射 <b>' + fmt1(sk.basicSec) + ' 秒</b>，火场烧满再加 <b>' + fmt1(sk.basicSec * ((sk.useMult || 1) - 1)) + ' 秒</b>（每秒约 <b>' + fmt1(G.basicShots(sk) / sk.basicSec) + '</b> 跳') +
          '），伤害取自武器' + (w ? ' <b>' + Math.round(w.min) + '–' + Math.round(w.max) + '</b>' : '') + '，等级随角色等级'
        : gk === 'attack'
        ? '攻击型：伤害取自武器' + (w ? ' <b>' + Math.round(w.min) + '–' + Math.round(w.max) + '</b>' : '') + (ctx && ctx.wm > 0 ? '<span class="wn-op">×</span>倍率 <b>' + Math.round(ctx.wm * 100) + '%</b>' : '') + '，等级随角色等级'
        : gk === 'minion'
          ? '召唤型：' + (sk.champ ? '英灵' : '魂火') + '按召唤物计算，等级随武器物品等级' + (lvl ? '（Lv ' + lvl + '）' : '') + '，吃召唤物伤害加成' + (sk.champ ? '、生命加成与继承' : '') + '（辅助宝石不算）'
          : '法术型：等级 = 武器物品等级 × 0.75' + (lvl ? '（Lv ' + lvl + '）' : '') + (sk.kind === 'wwand' && G.player.uMech === 'void' ? '，属性固定为混沌' : '，吃元素伤害加成');
      main =
        '<div class="sk-top"><div class="sk-icon">' + IC.skill(id) + '</div>' +
        '<div class="sk-title"><div class="sk-name">' + sk.name + (sk.uskill ? '<em class="usk-tag">烬铸技</em>' : '') + '</div><div class="wsk-src">来自 ' + esc(item ? item.name : '') + ' · ' + wTypeName(item ? item.baseIdx | 0 : 0) +
        (sk.uskill && sk.replaces && G.SKILLS[sk.replaces] ? ' · 替换「' + G.SKILLS[sk.replaces].name + '」' : '') +
        (sk.kind === 'wwand' && G.player.uMech === 'void' ? ' · 属性固定为混沌' : '') + '</div></div></div>' +
        '<div class="sk-desc">' + sk.desc + altBox(sk.alt) + '</div>' +
        (nums ? '<div class="sk-nums">' + nums + '</div>' : '') +
        '<div class="sk-anote wpn"><i></i><span>' + grow + '</span></div>' +
        (sk.rgauge
          ? '<div class="sk-anote gauge ' + (GUN_TYPES.indexOf(sk.wtype) >= 0 ? 'heat' : 'focus') + '"><i></i><span>' + (GUN_TYPES.indexOf(sk.wtype) >= 0 ? '热度' : '专注') + '满时 R 亮起，放出后清零' + (sk.uskill ? '；烬铸武器专属' : '') + '；不能镶辅助</span></div>'
          : '<div class="sk-anote cd"><i></i><span>' + (sk.uskill ? '烬铸武器专属；' : '') + '不能镶辅助</span></div>');
    }
    // 第二排：三把烬铸武器各自的烬铸技（拿着的那把亮起）
    const urow = Object.keys(G.SKILLS).filter(isUSkill).map((u) =>
      '<span class="usl' + (u === id ? ' on' : '') + '" style="--c:' + G.SKILLS[u].color + '" data-tip="wsk:' + u + '">' + IC.skill(u) + '<em>' + esc((uOfSkill(u) || {}).name || '') + '</em></span>').join('');
    return '<div class="wsk-card' + (isUSkill(id) ? ' uskill' : '') + '" style="--c:' + (id ? G.SKILLS[id].color : '#8c7f6d') + '">' + main + '<div class="wsk-row">' + row + '</div>' +
      (urow ? '<div class="wsk-row urow"><b>烬铸技</b>' + urow + '</div>' : '') + '</div>';
  }

  // 召唤技能卡上的「自动召唤」开关：点它切换；写明在技能栏上按哪个键也能切换、Shift 是手动召唤
  function autoRow(id) {
    const on = G.autoSummonOn(id);
    const slot = G.save.bar.indexOf(id);
    const k = slot >= 0 ? KEY_LABEL[slot] : '';
    const how = slot < 0
      ? '放进技能栏后生效'
      : (on ? '数量不满时在你身边自动补上，魔力不够就暂停' : '开启后自动召唤到上限') + ' · 按 <kbd>' + k + '</kbd> 切换 · <kbd>Shift</kbd>+<kbd>' + k + '</kbd> 在准星处召唤一次';
    return (
      '<div class="sk-auto' + (on ? ' on' : '') + '">' +
      '<button type="button" tabindex="-1" class="sk-auto-btn" data-act="autosum" data-skill="' + id + '" aria-pressed="' + on + '"><i></i>自动召唤<b>' + (on ? '开' : '关') + '</b></button>' +
      '<span>' + how + '</span></div>'
    );
  }

  function skillCard(id) {
    const S = G.save;
    const sk = G.SKILLS[id];
    const ctx = G.skillCtx(id);
    const avg = G.avgHit(ctx);
    const rate = G.skillRate(ctx); // 含命中时的顿帧，受冷却限制，和实际打出来的节奏一致
    const blood = G.player.S.bloodMagic > 0;
    const socks = S.sockets[id] || [null, null, null];

    let binds = '';
    for (let i = 0; i < 4; i++) {
      if (i === 1) {
        binds += '<span class="bind locked" data-tip="txt:右键固定是武器普攻，不能绑别的技能">' + KEY_LABEL[i] + '</span>';
        // 右键改版时三格都满、被收起来的技能：标一下，点任意一个按键标签绑上就取出来
        if (S.rmbKeep === id) binds += '<span class="bind locked kept" data-tip="txt:武器普攻改版：右键固定是普攻，这个技能原来在右键上、当时没有空格，先收在这里。点左键 / Q / E 绑上">收起</span>';
        continue;
      }
      binds +=
        '<button type="button" tabindex="-1" class="bind' + (S.bar[i] === id ? ' on' : '') + '" data-act="bind" data-skill="' + id + '" data-slot="' + i + '">' + KEY_LABEL[i] + '</button>';
    }
    let sockets = '';
    for (let i = 0; i < 3; i++) {
      const sup = socks[i];
      const picking = ui.picker && ui.picker.skill === id && ui.picker.idx === i;
      if (sup) {
        const idle = !G.supportFits(id, sup); // 镶着，但对这一刻的刻式不生效（换回用得上的刻式就生效）
        sockets +=
          '<button type="button" tabindex="-1" class="sock full' + (idle ? ' idle' : '') + '" data-act="socket" data-skill="' + id + '" data-idx="' + i + '" data-tip="sock:' + sup + '" data-drag="sup:' + sup + '">' +
          IC.sup(sup) + G.SUPPORTS[sup].name + (idle ? '<em>不生效</em>' : '') + '</button>';
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
      const pm = ctx.minion && ctx.minion.charge ? ctx.minion : null;
      if (pm) {
        // 焚骨祭司：火弹的爆炸半径、一次几枚，焰蓄攒满放的两种大招
        bits.push('火弹爆炸半径 ' + fmt1(pm.explode) + (pm.bolts > 1 ? ' · 一次 ' + pm.bolts + ' 枚' : ''));
        bits.push('焰蓄 ' + pm.charge.max + ' 点：坠焰 ' + fmt1(pm.meteor.mult) + ' 倍 / 半径 ' + fmt1(pm.meteor.radius) + '，灼链 ' + fmt1(pm.beam.dur) + ' 秒 × 每跳 ' + fmt1(pm.beam.mult) + ' 倍');
      }
      if (mi.dps > 0) bits.push((mi.cap > 1 ? '满员秒伤约 ' : '秒伤约 ') + fmtInt(mi.dps) + (pm ? '（单体）' : ''));
      note = '<div class="sk-mnote"><i></i>' + bits.join(' · ') + '</div>' + inheritNote(ctx) + autoRow(id);
    } else if (sk.buff) {
      // 黑焰：不脉冲、自己没有伤害；卡片上是每一击额外的混沌伤害比例和保留
      const F = G.auraOn(id) ? G.flamePct() : Math.min(sk.flame.cap, sk.flame.k0 + sk.flame.k1 * (S.skills[id] - 1)) * (1 + Math.max(0, G.player.S.flameEff || 0) / 100);
      nums =
        num('额外混沌', fmt1(F) + '%', 'hl') +
        num(blood ? '生命保留' : '魔力保留', fmt1(ctx.reserve) + '%') +
        num('封顶', fmt1(sk.flame.cap) + '%');
      note = '<div class="sk-anote"><i></i>' + (G.auraOn(id) ? '生效中' : G.auraSlotted(id) ? '保留不足，未生效' : '放进技能栏即生效') + ' · 不用按键</div>';
    } else if (sk.kind === 'aura' && sk.mech === 'guard') {
      // 刻式「护涡」光环：常驻绕身的旋风。avg 是贴身单体每秒挨的总量（useMult 跳），每跳 = avg ÷ useMult
      const tick = avg / sk.useMult, dps = avg * rate;
      nums =
        num('每跳伤害', tick < 10 ? fmt1(tick) : fmtInt(tick), 'hl') +
        num('估算秒伤', dps < 10 ? fmt1(dps) : fmtInt(dps)) +
        num('旋风', sk.count + Math.max(0, ctx.proj - 1) + ' 团') +
        num(blood ? '生命保留' : '魔力保留', fmt1(ctx.reserve) + '%') +
        num('绕身半径', fmt1(sk.guard.r * Math.sqrt(ctx.area))) +
        num('暴击率', fmt1(ctx.crit) + '%');
      note = '<div class="sk-anote"><i></i>' + (G.auraOn(id) ? '生效中' : G.auraSlotted(id) ? '保留不足，未生效' : '放进技能栏即生效') + ' · 不用按键</div>';
    } else if (sk.kind === 'aura') {
      // 光环：没有施放，只有保留；卡片上是每一跳的伤害、每秒几跳和半径
      nums =
        num('每跳伤害', avg < 10 ? fmt1(avg) : fmtInt(avg), 'hl') +
        num('每秒脉冲', rate.toFixed(2)) +
        num('估算秒伤', avg * rate < 10 ? fmt1(avg * rate) : fmtInt(avg * rate)) +
        num(blood ? '生命保留' : '魔力保留', fmt1(ctx.reserve) + '%') +
        num('半径', fmt1(G.auraRadius(ctx))) +
        num('暴击率', fmt1(ctx.crit) + '%');
      note = '<div class="sk-anote"><i></i>' + (G.auraOn(id) ? '生效中' : G.auraSlotted(id) ? '保留不足，未生效' : '放进技能栏即生效') + ' · 不用按键</div>';
    } else {
      nums =
        num(ctx.cd > 0 ? '每次伤害' : '平均击中', fmtInt(avg), 'hl') +
        num(sk.kind === 'spin' || sk.kind === 'flicker' ? '每秒斩击' : '每秒施放', rate.toFixed(2)) +
        num('估算秒伤', fmtInt(avg * rate * G.durDpsK(ctx) + G.bleedDps(ctx, G.bleedHps(ctx, rate)))) + // 绵延：黑洞 / 黑旋风多跳几下、雷桩 / 环刃多一个；流血叠稳之后的那一份
        num((blood ? '生命消耗' : '魔力消耗') + (sk.kind === 'spin' || sk.kind === 'flicker' ? ' / 每下' : ''), ctx.cost > 0 ? fmt1(ctx.cost) : '无') +
        num('冷却', ctx.cd > 0 ? fmt1(ctx.cd) + ' 秒' : '无') +
        num('暴击率', fmt1(ctx.crit) + '%');
      // 冷却技能：秒伤按冷却折算（单独循环施放打不过主力技能），价值在于穿插
      if (ctx.cd > 0) note = '<div class="sk-anote cd"><i></i>冷却技能：秒伤按冷却折算</div>';
      // 混沌流的两招：写清每次伤害是怎么算出来的
      if (sk.kind === 'hole') {
        const dur = sk.dur * (1 + Math.max(0, G.player.S.holeDur || 0) / 100);
        note += '<div class="sk-anote"><i></i>持续 ' + fmt1(dur) + ' 秒 · 每 ' + sk.tick + ' 秒一跳（每次伤害按 ' + sk.useMult + ' 跳计）· 半径 ' + fmt1(sk.radius * Math.sqrt(ctx.area)) + '</div>';
      } else if (sk.kind === 'vortex') {
        const L = sk.latch, nv = sk.count + Math.max(0, ctx.proj - 1);
        note =
          '<div class="sk-anote"><i></i>每次 ' + nv + ' 团 · 吸附 ' + L.t + ' 秒，拽近 ' + fmt1(L.r) + ' 米内的小怪 · 每团最多吸 ' + L.max + ' 次、撞墙弹 ' + sk.bounce + ' 次、飞 ' + sk.life + ' 秒</div>' +
          '<div class="sk-anote"><i></i>同一次施放对同一个敌人每 ' + sk.tick + ' 秒最多一跳；被吸附的一共最多 ' + sk.cap + ' 跳、卷到的 ' + sk.splashCap + ' 跳、首领 ' + sk.bossCap + ' 跳（单体平均每次约 ' + sk.useMult + ' 跳）· 贯穿：前几个敌人不吸附、直接穿过 · 连锁：松开后拐向附近下一个敌人</div>';
      }
      // 第一批新技能（skill-expand）：换一组更能说明它的数字
      const blood2 = blood ? '生命消耗' : '魔力消耗';
      if (sk.kind === 'tether' && !(sk.ramp.max > 0)) {
        // 刻式「游雷」：没有加成
        const per0 = avg / (sk.useMult || 1);
        nums =
          num('每跳伤害', fmtInt(per0), 'hl') +
          num('每秒跳数', rate.toFixed(2)) +
          num('估算秒伤', fmtInt(per0 * rate)) +
          num(blood2 + ' / 每跳', ctx.cost > 0 ? fmt1(ctx.cost) : '无') +
          num('冷却', '无') +
          num('暴击率', fmt1(ctx.crit) + '%');
        note = '<div class="sk-anote"><i></i>不叠加成，牵引时照常走动 · 连锁 ' + ctx.chain + ' 次（每跳最远 ' + (sk.jump || 7) + ' 米）· 射程 ' + sk.range + ' 米</div>';
      } else if (sk.kind === 'tether') {
        const per0 = avg / (sk.useMult || 1), kMax = 1 + sk.ramp.max / 100;
        nums =
          num('每跳伤害', fmtInt(per0) + ' → ' + fmtInt(per0 * kMax), 'hl') +
          num('每秒跳数', rate.toFixed(2)) +
          num('估算秒伤', fmtInt(per0 * rate) + ' → ' + fmtInt(per0 * kMax * rate)) +
          num(blood2 + ' / 每跳', ctx.cost > 0 ? fmt1(ctx.cost) : '无') +
          num('冷却', '无') +
          num('暴击率', fmt1(ctx.crit) + '%');
        note = '<div class="sk-anote"><i></i>站定引满 ' + fmt1(sk.ramp.max / sk.ramp.perSec) + ' 秒伤害 +' + sk.ramp.max + '% · 连锁 ' + ctx.chain + ' 次 · 射程 ' + sk.range + ' 米</div>';
      } else if (sk.kind === 'rain' && sk.slam) {
        // 刻式「重凌」：一根大冰凌
        nums =
          num('整根伤害', fmtInt(avg), 'hl') +
          num('落地', fmt1(sk.slam.delay + sk.slam.fall) + ' 秒后') +
          num('半径', fmt1(sk.radius * Math.sqrt(ctx.area)) + ' 米') +
          num('异常累积', '+' + Math.round(ctx.ailment) + '%') +
          num('冷却', fmt1(ctx.cd) + ' 秒') +
          num(blood2, ctx.cost > 0 ? fmt1(ctx.cost) : '无');
        note = '<div class="sk-anote cd"><i></i>冷却技能：秒伤按冷却折算 · 范围里的每个敌人都吃整根</div>';
      } else if (sk.kind === 'rain') {
        const n = Math.max(1, Math.round((sk.dur * ctx.durK) / sk.tick));
        nums =
          num('每根伤害', fmtInt(avg / (sk.useMult || 1)), 'hl') +
          num('根数 · 持续', n + ' 根 · ' + fmt1(sk.dur * ctx.durK) + ' 秒') +
          num('单体每次约', fmtInt(avg * ctx.durK)) +
          num('异常累积', '+' + Math.round(ctx.ailment) + '%') +
          num('冷却', fmt1(ctx.cd) + ' 秒') +
          num(blood2, ctx.cost > 0 ? fmt1(ctx.cost) : '无');
        note = '<div class="sk-anote cd"><i></i>冷却技能：秒伤按冷却折算 · 半径 ' + fmt1(sk.radius * Math.sqrt(ctx.area)) + ' 米' + (sk.mech === 'follow' ? '（圈心跟着你）' : '') + ' · 单体按 ' + sk.useMult + ' 根计</div>';
      } else if (sk.hitCap) {
        const per = avg / (sk.useMult || 1), nn = sk.count + Math.max(0, ctx.proj - 1);
        nums =
          num('每枚伤害', fmtInt(per), 'hl') +
          num('贴近每次', fmtInt(avg)) +
          num('每秒施放', rate.toFixed(2)) +
          num('估算秒伤', fmtInt(G.skillDps(ctx))) +
          num(blood2, ctx.cost > 0 ? fmt1(ctx.cost) : '无') +
          num('暴击率', fmt1(ctx.crit) + '%');
        note = '<div class="sk-anote"><i></i>每次 ' + nn + ' 枚 · 同一个敌人最多中 ' + sk.hitCap + ' 枚 · 射程约 ' + fmt1(sk.speed * sk.life * G.projSpdK(ctx)) + ' 米（贴近的估算按中 ' + sk.useMult + ' 枚算）</div>';
      } else if (sk.kind === 'line') {
        const k = Math.sqrt(ctx.area);
        note += '<div class="sk-anote"><i></i>长 ' + fmt1(sk.len * k) + ' 米 · 宽 ' + fmt1(sk.width * k) + ' 米 · ' +
          (sk.mech === 'lance' ? '扎中第一个敌人就停' : sk.mech === 'fork' ? '前 ' + sk.fork.max + ' 个敌人脚下各刺出两道 ' + fmt1(sk.fork.len * k) + ' 米的岔脊（伤害 ' + Math.round(sk.fork.k * 100) + '%）' : '同一次施放每个敌人只中一下') + '</div>';
      } else if (sk.kind === 'burst' && sk.focus) {
        note += '<div class="sk-anote"><i></i>只打身边 ' + fmt1(sk.radius * Math.sqrt(ctx.area)) + ' 米内最近的 1 个 · 连着第 ' + sk.focus.n + ' 下过载 ×' + sk.focus.k + '（平均击中已按这个折算）</div>';
      } else if (sk.kind === 'burst') {
        note += '<div class="sk-anote"><i></i>' + (sk.dash ? '先朝准星冲出至多 ' + sk.dash.max + ' 米 · ' : '') + '以自身为中心，半径 ' + fmt1(sk.radius * Math.sqrt(ctx.area)) + ' 米，最多打最近的 ' + sk.maxHit + ' 个，不穿墙</div>';
      }
      // 流血（放血自带 / 开刃）：每层多少、叠稳几层、流血那一份秒伤
      const bl = G.bleedInfo(ctx, G.bleedHps(ctx, rate));
      if (bl) note += '<div class="sk-anote"><i></i>流血：每层 ' + fmtInt(bl.per) + '（' + G.BLEED.dur + ' 秒）· 打单体叠到 ' + fmt1(bl.n) + ' 层（上限 ' + Math.max(G.BLEED.cap, sk.bleedCap || 0) + '）· 流血秒伤约 ' + fmtInt(bl.dps) + '</div>';
      // 攻击技能：伤害取自手里的武器
      if (ctx.attack) note = attackNote(ctx) + note;
    }
    return (
      '<div class="skill-card" style="--c:' + sk.color + '">' +
      '<div class="sk-top"><div class="sk-icon" data-drag="skill:' + id + '" data-tip="skdrag:' + id + '">' + IC.skill(id) + '</div>' +
      '<div class="sk-title"><div class="sk-name">' + sk.name + (sk.vname ? '<i class="sk-vn">' + sk.vname + '</i>' : '') + '<em>Lv ' + S.skills[id] + '</em>' + blankUp + '</div>' +
      '<div class="sk-tags">' + cardTags(sk).map((t) => '<span>' + G.TAG_NAME[t] + '</span>').join('') + '</div></div>' +
      '<div class="sk-binds">' + binds + '</div></div>' +
      '<div class="sk-desc"><span class="sk-dt">' + sk.desc + '</span>' + altBox(sk.alt) + '</div>' + variantRow(id) +
      (sk.combo ? '<div class="sk-combo">' + sk.combo.map((c, i) => '<span' + (c.w >= 2 ? ' class="fin"' : '') + '>' + (c.w >= 2 ? '终结 ' : '第 ' + (i + 1) + ' 段 ') + '×' + c.mult + '</span>').join('<i></i>') + '</div>' : '') +
      '<div class="sk-nums' + (mi ? ' ally' : '') + '">' + nums + '</div>' + note +
      '<div class="sk-socks"><span class="sk-socks-label">辅助</span>' + sockets + '</div>' +
      '</div>'
    );
  }

  function renderSkills() {
    const S = G.save;
    // 武器技不进技能列表：它们跟着武器走，在最上面单独一节
    const known = Object.keys(G.SKILLS).filter((id) => S.skills[id] && !isWSkill(id));
    const unknown = Object.keys(G.SKILLS).filter((id) => !S.skills[id] && !isWSkill(id));
    const B = G.BLANK_GEM;
    const best = G.blankBest();
    let cards = basicCard() + known.map(skillCard).join('');
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
        '<div class="sm-note">怪物掉落技能宝石，首领必掉一颗。' + B.name + '可在这里换成任意技能。</div></div>';
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
        ? '点「尚未获得」里的技能学会，或点卡上的「升至 Lv ' + best + '」，点两下确认'
        : '';
      blank =
        '<div class="blank-bar" style="--c:' + B.color + '">' + ibox(IC.blank(), 'gemb') + '<div class="bk-txt"><div class="bk-top">' + lv + '</div>' +
        (ui.blankMsg ? '<div class="bk-msg">' + ui.blankMsg + '</div>' : how ? '<div class="bk-how">' + how + '</div>' : '') + '</div></div>';
    }

    // 技能栏：四个格子，可以把技能图标拖进来
    let bar = '';
    const bidB = G.weaponBasic ? G.weaponBasic() : null;
    for (let i = 0; i < 4; i++) {
      if (i === 1 && bidB) {
        // 右键固定是武器普攻：不能拖进拖出
        const bk = G.SKILLS[bidB];
        bar +=
          '<div class="barslot basic" data-tip="txt:右键固定是武器普攻' + (S.rmbKeep && G.SKILLS[S.rmbKeep] ? '；收起的「' + G.SKILLS[S.rmbKeep].name + '」在下面列表里，点按键标签绑上' : '') + '" style="--c:' + bk.color + '">' +
          '<div class="bs-icon">' + IC.skill(bidB) + '</div><div class="bs-txt"><span>右键 · <i class="bs-long">武器</i>普攻</span><b>' + bk.name + '</b></div></div>';
        continue;
      }
      const id = S.bar[i];
      bar +=
        '<div class="barslot' + (id ? '' : ' empty') + '" data-slot="' + i + '"' + (id ? ' data-drag="skill:' + id + '" data-tip="skdrag:' + id + '" style="--c:' + G.SKILLS[id].color + '"' : '') + '>' +
        '<div class="bs-icon">' + (id ? IC.skill(id) : '') + '</div><div class="bs-txt"><span>' + KEY_LABEL[i] + '</span><b>' + (id ? G.SKILLS[id].name : '空') + '</b></div></div>';
    }
    // 第五格：武器技，跟着武器走，不能拖放
    const wid = curWSkill();
    bar +=
      '<div class="wbarslot' + (wid ? '' : ' empty') + (isUSkill(wid) ? ' uskill' : '') + '"' + (wid ? ' data-tip="wsk:' + wid + '" style="--c:' + G.SKILLS[wid].color + '"' : ' data-tip="txt:' + (S.equip.weapon ? '这把武器没有武器技' : '装备武器后 R 是它的武器技') + '"') + '>' +
      '<div class="bs-icon">' + (wid ? IC.skill(wid) : '') + '</div><div class="bs-txt"><span>R · ' + (isUSkill(wid) ? '烬铸技' : '武器技') + '</span><b>' + (wid ? G.SKILLS[wid].name : S.equip.weapon ? '无' : '无武器') + '</b></div></div>';

    let sups = '';
    for (const id of Object.keys(G.SUPPORTS)) {
      if (!S.supports.includes(id)) continue;
      const sp = G.SUPPORTS[id];
      const loc = supLocation(id);
      sups +=
        '<div class="sup' + (loc ? ' used' : '') + '" data-drag="sup:' + id + '" style="--c:' + IC.supColor(id) + '"><div class="sup-top">' + IC.sup(id) + '<b>' + sp.name + '</b>' +
        '<span class="sup-req">' + scopeText(sp) + '</span></div>' +
        '<div class="sup-desc">' + sp.desc + altBox(sp.alt) + '</div>' +
        '<div class="sup-foot"><span>消耗 ×' + sp.cost + '</span>' +
        (loc ? '<span class="sup-loc">镶于 ' + skName(loc.skill) + '</span>' : '<span class="sup-free">未使用</span>') +
        '</div></div>';
    }
    if (!sups) {
      sups = '<div class="sup-none">还没有辅助宝石。<br>精英和首领会掉落。</div>';
    }
    const coach = coachBanner('skills');

    el.body.innerHTML =
      '<div class="skills">' +
      '<div class="col col-main">' + blank + '<div class="sec-title">技能栏<span class="sec-note">拖进格子，或点卡上的按键标签</span></div>' +
      '<div class="barstrip">' + bar + '</div>' +
      '<div class="sec-title">技能<span class="sec-note">点辅助槽，或把宝石拖进来</span></div>' +
      '<div class="skill-list scroll" data-scroll="skills">' + cards + '</div></div>' +
      '<div class="col col-side"><div class="sec-title">武器技<span class="sec-note"><kbd>R</kbd> 随武器更换</span></div>' + wskillSection() +
      '<div class="sec-title">辅助宝石<span class="sec-note">' + S.supports.length + ' / ' + Object.keys(G.SUPPORTS).length + '</span></div>' +
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
          (loc ? '<span class="pk-note warn">正用于 ' + skName(loc.skill) + ' · 选择后移过来</span>' : '<span class="pk-note">消耗 ×' + sp.cost + '</span>') +
          '</div><div class="pk-desc">' + sp.desc + '</div></button>';
      }
      rows.push({ rank, html });
    }
    rows.sort((a, b) => a.rank - b.rank);
    box.innerHTML =
      '<div class="pk-title">为「' + skName(pk.skill) + '」选择辅助宝石</div>' +
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

  // 核心 / 基石天赋名字的摆放（相对节点中心的 x / y 与对齐方式）：在上 / 下 / 左 / 右几个候选位置里挑一个
  // 和其他节点、已经摆好的名字重叠最少的。按全览时的名字放大倍数（约 1.45）估算，天赋盘是静态的，算一次缓存
  let treeLabelCache = null;
  function treeLabels() {
    if (treeLabelCache) return treeLabelCache;
    const T = G.TREE;
    const K = 1.45;
    const out = {};
    const boxes = [];
    const ids = Object.keys(T).filter((id) => T[id].kind === 'notable' || T[id].kind === 'keystone');
    ids.sort((a, b) => (T[a].kind === 'keystone' ? 0 : 1) - (T[b].kind === 'keystone' ? 0 : 1));
    let yTop = Infinity;
    for (const id in T) yTop = Math.min(yTop, T[id].y);
    yTop -= 20;
    const over = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    for (const id of ids) {
      const n = T[id];
      const r = NODE_R[n.kind] * (n.kind === 'keystone' ? 1.42 : 1);
      const fs = n.kind === 'keystone' ? 18.5 : 17;
      const w = n.name.length * (fs + (n.kind === 'keystone' ? 2 : 1));
      const len = Math.hypot(n.x, n.y) || 1;
      const ux = n.x / len, uy = n.y / len;
      // 候选：x / y 是文字基线锚点，a 是对齐；pref 是偏好（越小越优先：沿半径朝外的一侧优先）
      const C = [
        { x: 0, y: -(r + 10), a: 'middle', pref: uy < 0 ? 0 : 2 },
        { x: 0, y: r + fs + 6, a: 'middle', pref: uy > 0 ? 0 : 2 },
        { x: r + 10, y: 6, a: 'start', pref: ux > 0 ? 0.5 : 2.5 },
        { x: -(r + 10), y: 6, a: 'end', pref: ux < 0 ? 0.5 : 2.5 },
        { x: 0, y: -(r + 26), a: 'middle', pref: 3 },
        { x: 0, y: r + fs + 22, a: 'middle', pref: 3 },
      ];
      let best = null;
      for (const c of C) {
        const x0 = c.a === 'middle' ? c.x - w / 2 : c.a === 'start' ? c.x : c.x - w;
        // 放大 K 倍（以节点为原点），换成绝对坐标
        const b = [n.x + x0 * K, n.y + (c.y - fs * 0.86) * K, n.x + (x0 + w) * K, n.y + (c.y + fs * 0.18) * K];
        let cost = c.pref * 40;
        for (const oid in T) {
          if (oid === id) continue;
          const o = T[oid];
          const rr = NODE_R[o.kind] + 5;
          cost += over(b, [o.x - rr, o.y - rr, o.x + rr, o.y + rr]) * 3;
        }
        for (const ob of boxes) cost += over(b, ob) * 4;
        if (b[1] < yTop) cost += (yTop - b[1]) * w * K * 3; // 全览时盘面最上方压着图例，名字别往那里放
        if (!best || cost < best.cost) best = { c, b, cost };
      }
      boxes.push(best.b);
      out[id] = { x: best.c.x, y: best.c.y, a: best.c.a };
    }
    treeLabelCache = out;
    return out;
  }

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

      // 核心 / 基石天赋直接标出名字（摆放位置见 treeLabels）
      if (n.kind === 'notable' || n.kind === 'keystone') {
        const L = treeLabels()[id];
        labels +=
          '<g transform="translate(' + n1(n.x) + ' ' + n1(n.y) + ')"><text class="tl ' + n.kind + ' ' + (isAlloc ? 'alloc' : avail ? 'avail' : '') + '" style="--c:' + n.color + '" x="' + n1(L.x) + '" y="' + n1(L.y) + '" text-anchor="' + L.a + '">' + n.name + '</text></g>';
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
    if (!sumHtml) sumHtml = '<div class="ts-none">还没有点亮天赋。<br>从中央起点沿连线向外点亮。</div>';

    el.body.innerHTML =
      '<div class="tree">' +
      '<div class="tree-view"><svg id="tree-svg" viewBox="' + vbStr(treeVb()) + '" preserveAspectRatio="xMidYMid meet">' +
      '<g class="tdeco"><circle r="81"/><circle r="231"/><circle r="381"/><circle r="462"/><circle r="564"/><circle r="636"/></g>' +
      '<g>' + edges + '</g><g>' + nodes + '</g><g>' + labels + '</g></svg>' +
      '<div class="tree-legend"><span class="lg alloc"><i></i>已点亮</span><span class="lg avail"><i></i>可点亮</span><span class="lg locked"><i></i>未连接</span>' +
      '<span class="lg-sep"></span><span>点击点亮 · 再次点击退回 · 滚轮缩放 · 拖动平移</span></div>' +
      '<div class="tree-zoom">' +
      '<button type="button" tabindex="-1" data-act="tree-zoom" data-z="out" title="缩小">－</button>' +
      '<button type="button" tabindex="-1" data-act="tree-zoom" data-z="fit"' + (ui.tv ? '' : ' class="on"') + '>全览</button>' +
      '<button type="button" tabindex="-1" data-act="tree-zoom" data-z="in" title="放大">＋</button></div></div>' +
      '<div class="col col-side tree-side">' +
      '<div class="sec-title">天赋点</div>' +
      '<div class="pts' + (pts.free > 0 ? ' has' : '') + '"><b>' + pts.free + '</b><div><span>可用天赋点</span><em>已用 ' + pts.used + ' · 共 ' + pts.total + '</em></div></div>' +
      '<div class="pts-note">每级 1 点；首次击败每个首领 +2 点。</div>' +
      (coachBanner('tree') ? '<div class="side-coach">' + coachBanner('tree') + '</div>' : '') +
      '<div class="arms">' + arms + '</div>' +
      '<div class="sec-title">已获得的加成</div>' +
      '<div class="tree-sum scroll" data-scroll="treesum">' + sumHtml + '</div>' +
      '<div class="tree-msg' + (ui.treeMsgBad ? ' bad' : '') + '">' + esc(ui.treeMsg) + '</div>' +
      '<button type="button" tabindex="-1" class="btn' + (ui.resetArmed ? ' danger' : '') + '" data-act="tree-reset"' + (pts.used > 0 ? '' : ' disabled') + '>' +
      (ui.resetArmed ? '再点一次确认重置' : '重置全部天赋') + '</button>' +
      '</div></div>';
    treeApply();
  }

  // ---------- 天赋盘的缩放与平移 ----------
  // ui.tv：当前视口（SVG 用户坐标的 { x, y, w, h }），null 表示「全览」——整个盘缩放到正好放下。
  // 视口的宽高比始终和全览一致（preserveAspectRatio meet 负责留边），缩放范围是全览的 1 倍到 1 / TREE_ZMAX 倍
  const TREE_ZMAX = 3.2;
  let treeBox = null;
  function treeFit() {
    if (treeBox) return treeBox;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id in G.TREE) {
      const n = G.TREE[id];
      x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x);
      y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
    }
    // 四周留出节点、光圈和名字的位置（名字左右伸出去最多）
    // 顶上多留一些：图例和缩放按钮压在盘面上方
    const px = 92, py = 60, top = 96;
    treeBox = { x: x0 - px, y: y0 - top, w: x1 - x0 + 2 * px, h: y1 - y0 + py + top };
    return treeBox;
  }
  const treeVb = () => ui.tv || treeFit();
  const vbStr = (v) => n1(v.x) + ' ' + n1(v.y) + ' ' + n1(v.w) + ' ' + n1(v.h);
  // 视口中心不出全览的范围，宽度夹在缩放范围内
  function treeClamp(v) {
    const F = treeFit();
    const w = G.clamp(v.w, F.w / TREE_ZMAX, F.w);
    const h = (w * F.h) / F.w;
    let cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    cx = G.clamp(cx, F.x + w / 2, F.x + F.w - w / 2);
    cy = G.clamp(cy, F.y + h / 2, F.y + F.h - h / 2);
    return w >= F.w - 0.5 ? null : { x: cx - w / 2, y: cy - h / 2, w, h };
  }
  // 屏幕像素 / SVG 用户单位
  function treeScale(svg, v) {
    const cw = svg.clientWidth || 1, ch = svg.clientHeight || 1;
    return Math.min(cw / v.w, ch / v.h);
  }
  // 把视口写到 SVG 上，并按缩放调整名字的字号：缩得越小名字相对越大，屏幕上不小于约 11 像素
  function treeApply() {
    const svg = document.getElementById('tree-svg');
    if (!svg) return;
    const v = treeVb();
    svg.setAttribute('viewBox', vbStr(v));
    const k = treeScale(svg, v);
    svg.style.setProperty('--lk', G.clamp(0.66 / k, 1, 2.2).toFixed(3));
    svg.classList.toggle('zoomed', !!ui.tv);
    const fit = el.body.querySelector('.tree-zoom [data-z="fit"]');
    if (fit) fit.classList.toggle('on', !ui.tv);
  }
  // 以屏幕点 (sx, sy) 为中心缩放 f 倍（f < 1 放大）；不给点就以视口中心
  function treeZoom(f, sx, sy) {
    const svg = document.getElementById('tree-svg');
    if (!svg) return;
    const v = treeVb();
    const r = svg.getBoundingClientRect();
    const k = treeScale(svg, v);
    const ox = r.left + (r.width - v.w * k) / 2, oy = r.top + (r.height - v.h * k) / 2;
    if (sx === undefined) {
      sx = r.left + r.width / 2;
      sy = r.top + r.height / 2;
    }
    const ux = v.x + (sx - ox) / k, uy = v.y + (sy - oy) / k; // 鼠标下的那一点（用户坐标）
    const F = treeFit();
    const w = G.clamp(v.w * f, F.w / TREE_ZMAX, F.w);
    const h = (w * F.h) / F.w;
    const k2 = Math.min(r.width / w, r.height / h);
    const ox2 = r.left + (r.width - w * k2) / 2, oy2 = r.top + (r.height - h * k2) / 2;
    ui.tv = treeClamp({ x: ux - (sx - ox2) / k2, y: uy - (sy - oy2) / k2, w, h });
    treeApply();
  }
  // 拖动平移：在盘面上按下左键拖动（挪出几像素才算拖，没挪动就还是一次点击）
  const tpan = { on: false, armed: false, x: 0, y: 0, v: null };
  function treePanDown(e) {
    if (e.button !== 0 || !ui.isOpen || ui.tab !== 'tree') return;
    const view = e.target.closest ? e.target.closest('.tree-view') : null;
    if (!view || e.target.closest('.tree-zoom') || !ui.tv) return; // 全览时没有可平移的余地
    tpan.armed = true;
    tpan.on = false;
    tpan.x = e.clientX;
    tpan.y = e.clientY;
    tpan.v = Object.assign({}, ui.tv);
  }
  function treePanMove(e) {
    if (!tpan.armed) return;
    if (!(e.buttons & 1)) {
      tpan.armed = tpan.on = false;
      return;
    }
    const dx = e.clientX - tpan.x, dy = e.clientY - tpan.y;
    if (!tpan.on && Math.hypot(dx, dy) < 6) return;
    if (!tpan.on) {
      tpan.on = true;
      hideTip();
    }
    const svg = document.getElementById('tree-svg');
    if (!svg) return;
    const k = treeScale(svg, tpan.v);
    ui.tv = treeClamp({ x: tpan.v.x - dx / k, y: tpan.v.y - dy / k, w: tpan.v.w, h: tpan.v.h }) || ui.tv;
    treeApply();
    el.body.querySelector('.tree-view').classList.add('panning');
  }
  function treePanUp() {
    if (!tpan.armed) return;
    if (tpan.on) {
      swallowClick(); // 拖完松手不算点了节点
      const view = el.body.querySelector('.tree-view');
      if (view) view.classList.remove('panning');
    }
    tpan.armed = tpan.on = false;
  }
  function treeWheel(e) {
    if (!ui.isOpen || ui.tab !== 'tree') return;
    const view = e.target.closest ? e.target.closest('.tree-view') : null;
    if (!view) return;
    e.preventDefault();
    hideTip();
    const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    treeZoom(Math.exp(G.clamp(d, -240, 240) * 0.0016), e.clientX, e.clientY);
  }

  // ============================================================
  // 渊印：择印面板、印纹小签、说明
  // ============================================================
  const sPct = (v) => +(v * 100).toFixed(1) + '%';
  // 每条印纹一行说明（数值都读 G.SEAL_MODS，改数值时说明跟着变）
  const SEAL_DESC = {
    tint: (p, m) => '怪物每一击另带相当于 ' + sPct(p.frac) + ' 伤害的' + G.TYPE_NAME[m.el] + '伤害（吃你的抗性）',
    haste: (p) => '怪物移速 +' + sPct(p.speed) + '，出手间隔 −' + sPct(p.cd),
    elites: (p) => {
      const cap = G.SEAL_ELITE_CAP || {}, few = G.ZONES.filter((z) => cap[z.id]).map((z) => z.name + ' ' + cap[z.id]);
      return '关键路径房间的精英几率 45% → ' + sPct(p.chance) + '，全区精英上限 6 → ' + p.cap + (few.length ? '（' + few.join('、') + '）' : '');
    },
    burst: (p) => '普通怪死后 ' + p.delay + ' 秒炸开（半径 ' + p.r + ' 米；精英 ' + p.eR + ' 米、' + p.eDelay + ' 秒），伤害为它一击的 ' + sPct(p.k) + '，有预警圈',
    ailRes: (p) => '怪物异常阈值 ×' + p.th + '，冰缓 ×' + p.chillCap + '，冻结和渊缚时长 ×' + p.dur + '（首领只吃阈值）',
    aura: (p) => '每群一只领群者（橙环）：' + p.r + ' 米内同群的怪伤害 +' + sPct(p.dmg) + '、受到的伤害 −' + sPct(p.dr) + '；领群者经验 ×' + p.xp,
    tough: (p) => '怪物生命 +' + sPct(p.hp) + '（首领 +' + sPct(p.boss) + '）',
    fierce: (p) => '怪物伤害 +' + sPct(p.dmg) + '（首领 +' + sPct(p.boss) + '）',
    volley: (p) => '喷吐者、隙影每次出手射 ' + p.n + ' 发（夹角 ' + p.spread + '°），弹速 +' + sPct(p.speed),
    mend: (p) => '怪物 ' + p.idle + ' 秒没挨打后，每秒回复 ' + sPct(p.rate) + ' 最大生命（首领 ' + sPct(p.boss) + '）',
    alert: (p) => '唤醒距离 12 → ' + p.wake + ' 米；一群怪醒来，同房间的其它怪群 ' + p.call + ' 秒后也醒',
    frenzy: (p) => '怪物生命低于 ' + sPct(p.th) + ' 时移速 +' + sPct(p.speed) + '、伤害 +' + sPct(p.dmg) + '（首领除外）',
    escort: (p) => '首领醒来时召来 ' + p.n + ' 只本区精英，首领半血时再来 ' + p.n + ' 只',
    cinder: (p) => '普通怪死亡时 ' + sPct(p.chance) + ' 几率留下 ' + p.t + ' 秒的燃烧地面（对怪也生效）',
    drain: (p) => '你的生命回复、魔力回复 −' + sPct(p.regen) + '，药剂充能获取 −' + sPct(p.flask),
    gloom: (p) => '视野收近，' + p.tag + ' 米外的敌人不显示血条',
    wane: (p) => '光环效果 −' + sPct(p.eff) + '，每个光环保留 +' + p.reserve + '%',
    sluggish: (p) => '技能冷却 +' + sPct(p.cd) + '，翻滚冷却 +' + sPct(p.roll),
    frail: (p) => '你的元素抗性各 −' + p.res + '%（上限之后扣）',
    lonely: (p) => '召唤物最大生命 −' + sPct(p.life) + '、伤害 −' + sPct(p.dmg),
  };
  G.sealModDesc = (m) => SEAL_DESC[m.id](m.id === 'tint' ? G.SEAL_MODS.tint.p : G.SEAL_MODS[m.id].p, m);
  function sealRewardText(W) {
    const r = G.sealReward(W);
    return '数量 +' + sPct(r.qty) + ' · 稀有度 +' + sPct(r.rar) + ' · 经验 +' + sPct(r.xp);
  }
  // 印纹小签：每条一个单字签（怪物侧橙红、玩家侧紫色），最后一个签写总加成（数量）。where：hud / map / card
  function sealChips(seal, where) {
    if (!seal) return '';
    let h = '<span class="seal-chips">';
    seal.mods.forEach((m, i) => {
      const d = G.SEAL_MODS[m.id], dead = G.sealModW(m) === 0;
      h += '<i class="sc ' + d.side + (dead ? ' dead' : '') + '" data-tip="seal:' + where + ':' + i + '">' + G.sealModGlyph(m) + '</i>';
    });
    h += '<i class="sc sum' + (seal.W >= G.SEAL.lieW ? ' lie' : '') + '" data-tip="seal:' + where + ':sum">+' + Math.round(G.sealReward(seal.W).qty * 100) + '%</i></span>';
    return h;
  }
  // 悬停说明：hud / map 读这次进区的印，card:<第几张>:<第几条> 读择印面板上的
  function sealTip(id) {
    const a = id.split(':');
    let seal = null, i = a[1];
    if (a[0] === 'card') {
      seal = ui.sealPick && ui.sealPick.seals[+a[1]];
      i = a[2];
    } else seal = G.state.run && G.state.run.seal;
    if (!seal) return '';
    if (i === 'sum') {
      return '<div class="tcard seal-tc"><div class="tc-name">' + G.sealName(seal) + '</div><div class="tc-kind">渊印 · 权重 ' + seal.W + (seal.W >= G.SEAL.lieW ? ' · 烈印' : '') + '</div>' +
        '<div class="tc-desc">' + sealRewardText(seal.W) + '</div>' +
        (seal.W >= G.SEAL.lieW ? '<div class="tc-desc">烈印：击败区域首领时可掉陨织袍、渊缚链</div>' : '') +
        fragLine(seal, a[0] === 'card' ? ui.sealPick && ui.sealPick.tier : G.state.tier, 'tc-desc') + '</div>';
    }
    const m = seal.mods[+i];
    if (!m) return '';
    const d = G.SEAL_MODS[m.id], w = G.sealModW(m);
    return '<div class="tcard seal-tc"><div class="tc-name">' + G.sealModName(m) + '</div><div class="tc-kind">' + (d.side === 'mob' ? '怪物侧' : '玩家侧') + '印纹 · 权重 ' + (w === 0 ? '0（对你无效）' : w) + '</div>' +
      '<div class="tc-desc">' + G.sealModDesc(m) + '</div></div>';
  }
  function sealCardHtml(seal, i, T) {
    const key = '<kbd>' + (i + 1) + '</kbd>';
    if (!seal) {
      return '<button type="button" tabindex="-1" class="seal-card plain" data-act="seal-pick" data-i="0">' + key +
        '<div class="sk-name">素印</div><div class="sk-none">没有词缀和加成</div><div class="sk-fill"></div><div class="sk-rw dim">数量 +0% · 稀有度 +0% · 经验 +0%</div>' +
        fragLine(null, ui.sealPick && ui.sealPick.tier, 'sk-frag') + '</button>';
    }
    const lie = seal.W >= G.SEAL.lieW, dz = G.sealDanger(seal), dk = G.clamp((dz - 1) / Math.max(0.01, T.budget - 1), 0, 1);
    let rows = '';
    seal.mods.forEach((m, j) => {
      const d = G.SEAL_MODS[m.id], dead = G.sealModW(m) === 0;
      rows += '<div class="sk-mod' + (dead ? ' dead' : '') + '" data-tip="seal:card:' + (i - 1) + ':' + j + '"><i class="sc ' + d.side + '">' + G.sealModGlyph(m) + '</i><b>' + G.sealModName(m) + '</b>' +
        (dead ? '<em>对你无效</em>' : '') + '<span>' + G.sealModDesc(m) + '</span></div>';
    });
    return '<button type="button" tabindex="-1" class="seal-card g' + seal.g + (lie ? ' lie' : '') + '" data-act="seal-pick" data-i="' + i + '">' + key +
      (lie ? '<span class="sk-lie">烈</span>' : '') +
      '<div class="sk-name">' + G.sealName(seal) + '</div>' +
      '<div class="sk-mods">' + rows + '</div><div class="sk-fill"></div>' +
      '<div class="sk-rw">' + sealRewardText(seal.W) + '</div>' +
      '<div class="sk-danger"><span>危险度</span><div class="sk-bar"><i style="width:' + Math.round(dk * 100) + '%"></i></div></div>' +
      fragLine(seal, ui.sealPick && ui.sealPick.tier, 'sk-frag') +
      (lie ? '<div class="sk-drop">可掉：陨织袍 · 渊缚链</div>' : '') + '</button>';
  }
  function sealPickHtml() {
    const sp = ui.sealPick;
    if (!sp) return '';
    const z = G.ZONES[sp.zone], T = G.sealTierDef(sp.tier);
    let cards = sealCardHtml(null, 0, T);
    sp.seals.forEach((s, i) => (cards += sealCardHtml(s, i + 1, T)));
    return '<div class="seal-pick"><div class="sp-box">' +
      '<div class="sp-head"><div class="sec-title">择印 · ' + z.name + ' · 轮回 ' + sp.tier + '</div>' +
      '<span class="sp-note">词缀越凶，掉落和经验越多。数字键 1–4 选择，Esc 返回</span>' +
      '<button type="button" tabindex="-1" class="btn sm" data-act="seal-cancel">返回</button></div>' +
      '<div class="sp-cards">' + cards + '</div></div></div>';
  }
  function pickSeal(i) {
    const sp = ui.sealPick;
    if (!sp) return false;
    const seal = i > 0 ? sp.seals[i - 1] : null;
    if (i > 0 && !seal) return false;
    ui.sealPick = null;
    G.sfx('click');
    G.enterZone(sp.zone, sp.tier, seal);
    close();
    return true;
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
      const here = st.zoneIdx === i && st.tier === tier && !st.pin; // 在余烛殿里时不算在哪个区域
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

    const run = st.run && st.run.seal;
    el.body.innerHTML =
      '<div class="map">' +
      '<div class="map-top"><div class="sec-title">轮回层级</div>' +
      '<div class="tier-row"><div class="tiers">' + tiers + '</div>' +
      '<div class="tier-note">每高一层，怪物等级 +' + G.TIER_LEVELS + '，物品等级随之提高。' +
      (S.maxTier === 0 ? '击败最后一个区域的首领后开启下一层。' : '在最高层级击败最后一个区域的首领开启下一层。') + '</div></div>' +
      // 渊印：这次进区的印（层级 ≥ 1 才有）和图例
      (S.maxTier >= 1
        ? '<div class="seal-now"><span class="sn-k">本次进区</span>' +
          (run ? '<b class="sn-name g' + run.g + '">' + G.sealName(run) + '</b>' + sealChips(run, 'map') + '<span class="sn-rw">' + sealRewardText(run.W) + '</span>' : '<b class="sn-name plain">素印</b><span class="sn-rw">没有词缀</span>') +
          '<span class="seal-legend"><i class="sc mob">戾</i>怪物侧印纹<i class="sc player">竭</i>玩家侧印纹<i class="lg-ring"></i>小地图上的领群者</span></div>'
        : '') +
      '</div>' +
      '<div class="zones" style="--nz:' + G.ZONES.length + '">' + cards + '</div>' +
      pinNodeHtml() +
      sealPickHtml() +
      '<div class="map-opts">' +
      '<div class="opt-text"><b>普通物品</b><span>魔法、稀有物品总是自动拾取</span></div>' +
      '<div class="seg">' +
      [['manual', '手动拾取', '走过不捡，按 F 或点击名牌拾取'], ['auto', '自动拾取', '走过就捡进背包'], ['scrap', '自动丢弃', '走过就地丢弃']]
        .map((o) => '<button type="button" tabindex="-1" class="seg-b' + (normMode() === o[0] ? ' on' : '') + '" data-act="normmode" data-mode="' + o[0] + '" data-tip="txt:' + o[2] + '">' + o[1] + '</button>')
        .join('') +
      '</div>' +
      '<div class="opt-sep"></div>' +
      '<button type="button" tabindex="-1" class="switch' + (S.opts.hideNormal ? ' on' : '') + '" data-act="opt" data-opt="hideNormal"><i></i></button>' +
      '<div class="opt-text"><b>折叠普通物品的名牌</b><span>地上只留一个小点，悬停或按住 Alt 展开</span></div>' +
      '<div class="opt-sep"></div>' +
      '<div class="opt-text"><b>画质</b><span>' + (S.opts.quality === 'auto' ? '自动选择，明显掉帧时会自动调低' : '电脑吃力时调低') + '</span></div>' +
      '<div class="seg">' +
      [['high', '高', '泛光、调色与暗角，4 倍多重采样抗锯齿，高分屏最高按 1.5 倍像素渲染'], ['mid', '中', '保留泛光与调色；泛光按一半分辨率计算，不画贴地薄雾，阴影精度减半，抗锯齿降为 2 倍，高分屏最高 1.25 倍像素'], ['low', '低', '关闭泛光、调色等后期效果和贴地薄雾，阴影精度减半，适合老旧电脑']]
        .map((o) => '<button type="button" tabindex="-1" class="seg-b' + ((G.world.quality ? G.world.quality() : S.opts.quality) === o[0] ? ' on' : '') + '" data-act="quality" data-q="' + o[0] + '" data-tip="txt:' + o[2] + '">' + o[1] + '</button>')
        .join('') +
      '</div>' +
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
    const blocked = ['echo', 'leech', 'pierce', 'chain'].filter((id) => G.SUPPORTS[id]).map((id) => G.SUPPORTS[id].name).join('、');
    return (
      '<div class="sec-title">召唤与集火</div>' +
      '<p>召唤技能的按键开关<b class="c-ally">自动召唤</b>（技能卡上也能切换）：没到上限、魔力够时自动补，魔力不够暂停（以血为引时低于四成生命不补）。按住 <kbd>Shift</kbd> 再按键，在准星处手动召唤。</p>' +
      '<p><b class="c-ally">' + name('thrall', '烬骸仆从') + '</b>满了再召唤会替换伤得最重的那具；<b class="c-ally">' + name('colossus', '石誓守像') + '</b>只有一尊，会<b>嘲讽</b>周围的敌人（含首领）。</p>' +
      '<p><b class="c-ally">' + name('pyre', '焚骨祭司') + '</b>是清怪主力：在后排掷火弹、攒<b>焰蓄</b>放大招，很脆。上限 2 位，只有镶在它身上的群聚能多唤一位；多重投射让它分头掷；拿杖或魂幡时继承更多武器伤害。</p>' +
      '<p>召唤物优先<b>集火</b>你<b>亲手打中</b>的敌人。仆从最多缠住两只怪、守像四只。</p>' +
      '<p>召唤物<b>不吃你自己的伤害属性</b>，只随宝石等级、「召唤物」属性和辅助成长；<b class="c-ally">统御</b>外圈天赋让它们<b>继承武器伤害、护甲与抗性、装备生命</b>。</p>' +
      (gems ? '<div class="hc-list">' + gems + '</div>' : '') +
      '<p>通用辅助也能镶：迅捷、注入、蛮力、致命、震慑、蚀染作用于召唤物，扩域放大守像砸地和祭司火弹。' + (blocked ? blocked + '镶不上召唤技能。' : '') + '</p>'
    );
  }

  // 帮助页的元素异常值一节（数值从 G.BUILDUP 取，数据改了这里跟着变）
  function helpBuildUp() {
    const B = G.BUILDUP;
    const c = (t, txt) => '<b style="color:' + G.TYPE_COLOR[t] + '">' + txt + '</b>';
    const pc = (v) => Math.round(v * 100) + '%';
    return (
      '<div class="sec-title">元素异常值</div>' +
      '<p>每个敌人有' + c('fire', '火焰') + '、' + c('cold', '冰霜') + '、' + c('light', '闪电') + '三条<b>异常值</b>（血条下三小段），命中时按元素伤害灌入：普通敌人受到其生命 ' + pc(B.th) + ' 的火焰伤害灌满，精英 ' + pc(B.thElite) + '，首领最慢且越打越难。' +
      '累积速度：' + c('light', '闪电 ×' + B.rate.light) + '、' + c('cold', '冰霜 ×' + B.rate.cold) + '、' + c('fire', '火焰 ×' + B.rate.fire) + '。' +
      '几秒不受该元素伤害就回落。</p>' +
      '<p>' + c('cold', '冰霜 → 冻结') + '：冻住 ' + B.freeze + ' 秒（精英 ' + B.freezeElite + ' 秒）。首领改为 ' + B.bossChill + ' 秒重度冰缓，移动和出手慢 ' + pc(B.bossSlow) + '。未满时也有冰缓：挨一下冰就慢 ' + pc(B.chillMin) + '，越满越慢，最多 ' + pc(B.chill) + '（精英 ' + pc(B.chillMinElite) + '～' + pc(B.chillElite) + '，首领 ' + pc(B.chillMinBoss) + '～' + pc(B.chillBoss) + '）。</p>' +
      '<p>' + c('fire', '火焰 → 爆燃') + '：炸伤周围 ' + B.blastR + ' 米内的敌人，伤害' + (B.blast === 1 ? '为灌满期间你平均一击的火焰伤害' : '为灌满期间平均一击火焰伤害的 ' + pc(B.blast)) + '，吃异常累积速度加成（有上限）。爆炸不再引发爆燃。</p>' +
      '<p>' + c('light', '闪电 → 感电') + '：' + B.shock + ' 秒内它每挨一下，射出至多 ' + B.shockN + ' 道电弧打向最近的其他敌人，每道为该击伤害的 ' + pc(B.bolt) + '；身边没有别的敌人时打回它自己。电弧不再引发电弧。</p>' +
      '<p><b>死亡时的异常</b>：死时某条过了中间的刻度（' + pc(B.deathMin) + ' 以上；正冻着算冰霜、正感电算闪电），在尸体处再触发一次：' +
      c('fire', '尸爆') + '（同爆燃）、' + c('light', '放电') + '（向最近 ' + B.deathBoltN + ' 个敌人各射一道电弧，每道为平均一击闪电伤害的 ' + pc(B.deathBolt) + '）、' +
      c('cold', '碎冰') + '（给 ' + B.shatterR + ' 米内的敌人灌一截冰霜异常值）。一串最多连 ' + B.deathGen + ' 层。</p>' +
      '<p><b>异常累积速度</b>（蚀染、侵蚀、元素使）让异常值涨得更快。物理伤害不累积异常值，它削架势。</p>' +
      '<p><b>流血</b>（放血、开刃）：带流血的物理命中给敌人叠一层，' + G.BLEED.dur + ' 秒内再造成这一击物理伤害的一部分（放血 ' + G.SKILLS.rend.bleed + '%，开刃 ' + G.SUPPORTS.serrate.eff.bleed + '%）。' +
      '每个敌人最多 ' + G.BLEED.cap + ' 层（血条右下的暗红小格），满了顶掉最弱的一层。流血不算命中，不引发电弧、不汲生。</p>' +
      '<p>' + c('chaos', '混沌') + '伤害有自己的一条（第四段），满了就' + c('chaos', '渊缚') + '：小怪定住 ' + B.bind + ' 秒（精英 ' + B.bindElite + ' 秒），并被拽向 ' + B.bindR +
      ' 米内最近的黑洞，没有就拽向怪群中心；首领改为 ' + B.bossBind + ' 秒减速 ' + Math.round(B.bossBindSlow * 100) + '%。正被渊缚或混沌过半的敌人死时' +
      c('chaos', '渊陷') + '：把身边的小怪往里拽（无伤害）。混沌伤害吃火焰、冰霜、闪电伤害提高的总和，不吃「元素过载」。</p>'
    );
  }

  // 帮助页的武器一节：攻击技能吃武器伤害、武器技在 R 上；各种武器的攻速、隐含属性与武器技从数据里取
  function helpWeapons() {
    const atk = Object.keys(G.SKILLS).filter((id) => {
      const sk = G.SKILLS[id];
      return !isWSkill(id) && sk.tags.indexOf('attack') >= 0 && sk.kind !== 'summon';
    }).map((id) => G.SKILLS[id].name);
    const F = G.FISTS || { min: 2, max: 4 };
    const gl = G.ATTACK_GEM_LVL ? +(G.ATTACK_GEM_LVL * 100).toFixed(1) : 1.5;
    const rows = (G.BASES.weapon || []).map((b, bi) => {
      const wid = b.wskill && G.SKILLS[b.wskill] ? b.wskill : null;
      const sk = wid ? G.SKILLS[wid] : null;
      let imp = '';
      if (b.imp) {
        const lo = G.fmtStat(b.imp.stat, b.imp.lo);
        imp = b.imp.lo === b.imp.hi || b.imp.fixed ? lo : lo.replace(String(b.imp.lo), b.imp.lo + '–' + b.imp.hi);
        // 附带的第二条隐含属性（魂幡：召唤物生命）
        const a = b.imp.also;
        if (a && a.stat && a.k > 0) {
          const alo = Math.max(1, Math.round(b.imp.lo * a.k));
          const ahi = Math.max(1, Math.round(b.imp.hi * a.k));
          const t = G.fmtStat(a.stat, alo);
          imp += '，' + (alo === ahi ? t : t.replace(String(alo), alo + '–' + ahi));
        }
      }
      const bits = [];
      if (b.aps) bits.push('每秒攻击 ' + b.aps.toFixed(2));
      if (b.caster) bits.push('施法武器，武器伤害低');
      if (b.ranged) bits.push(b.ranged === 'gun' ? '枪械 · 热度' : '弓 · 专注');
      if (b.hands === 2) bits.push('双手');
      if (imp) bits.push(esc(imp));
      return (
        '<div class="hc hw" style="--c:' + (sk ? sk.color : '#c9b48e') + '">' + IC.html('it-weapon-' + bi + '-0') + '<b>' + wTypeName(bi) + '</b>' +
        '<span>' + bits.join(' · ') + (G.SKILLS['basic_' + b.type] ? '<br><em>右键「' + G.SKILLS['basic_' + b.type].name + '」</em>' + G.SKILLS['basic_' + b.type].desc : '') +
        (sk ? '<br><em>' + (sk.rgauge ? (b.ranged === 'gun' ? '热度技' : '专注技') : '武器技') + '「' + sk.name + '」</em>' + (sk.cd > 0 ? '冷却 ' + fmt1(sk.cd) + ' 秒。' : '') + sk.desc : '') + '</span></div>'
      );
    }).join('');
    return (
      '<div class="sec-title">武器与武器技</div>' +
      '<p>武器决定<b>攻击</b>技能' + (atk.length ? '（' + atk.join('、') + '）' : '') + '的伤害：每一击 = 武器物理伤害 × 技能<b>武器倍率</b>，宝石每级再 +' + gl + '%，出手速度乘武器<b>攻击速度</b>。法术和召唤不看武器。空手只有 ' + F.min + '–' + F.max + ' 的拳头伤害。</p>' +
      '<p><b>本地词缀</b>（如「附加物理伤害」）已算进武器伤害。</p>' +
      '<p>每种武器自带 <kbd>R</kbd> 键<b>武器技</b>，换武器就换招，不能镶辅助。</p>' +
      helpBasics() +
      helpRanged() +
      helpUSkills() +
      (rows ? '<div class="hc-list">' + rows + '</div>' : '')
    );
  }

  // 帮助页：武器普攻（右键）——每种武器一招，近战是连招
  function helpBasics() {
    if (!G.SKILLS.basic_blade) return '';
    return (
      '<div class="sec-title">武器普攻（右键）</div>' +
      '<p><kbd>右键</kbd>是武器自己的<b>普攻</b>，不耗魔力：近战武器是<b>连招</b>，杖是法术，魂幡放出魂灵。</p>' +
      '<p>技能页最上面的<b>「武器普攻」卡</b>有 3 个辅助孔，按当前普攻的标签生效，换武器不用取下。</p>'
    );
  }

  // 帮助页：远程武器（枪械 / 弓）——右键普攻、量表与 R
  function helpRanged() {
    if (!G.SKILLS.basic_gatling && !G.SKILLS.basic_eagle) return '';
    const R = G.RANGED || {};
    return (
      '<div class="sec-title">枪械与弓</div>' +
      '<p>拿着<b>枪械</b>或<b>弓</b>时，<kbd>右键</kbd>是这把武器的射击，按住连发。</p>' +
      '<p><kbd>R</kbd> 被<b>量表</b>卡着（R 格左边的竖条），满了才亮，放出后清零。' +
      '枪械攒<b style="color:#ffb36a">热度</b>：开火上涨，停火回落，R 是排空热度的大招。' +
      '弓攒<b style="color:#9fe0b8">专注</b>：命中上涨，暴击和' + (R.farD ? ' ' + R.farD + ' 米外' : '远距离') + '命中涨得更多，挨打会掉，R 是约 8 秒的增益（期间不涨）。</p>'
    );
  }

  // 帮助页：烬铸技（拿着烬铸武器时顶替 R 上的武器技）
  function helpUSkills() {
    const ids = Object.keys(G.SKILLS).filter(isUSkill);
    if (!ids.length) return '';
    const rows = ids.map((id) => {
      const sk = G.SKILLS[id];
      return '<div class="hc hw uskill" style="--c:' + sk.color + '">' + IC.skill(id) + '<b>' + sk.name + '</b><span><em>' + esc(uSkillSrc(id)) + '</em>' + (sk.cd > 0 ? '冷却 ' + fmt1(sk.cd) + ' 秒。' : '') + sk.desc + '</span></div>';
    }).join('');
    return (
      '<p><b style="color:' + G.RARITY_COLOR[3] + '">烬铸技</b>：拿着烬铸武器时 <kbd>R</kbd> 换成它专属的烬铸技，更强、冷却更长。</p>' +
      '<div class="hc-list">' + rows + '</div>'
    );
  }

  // 按键表：帮助页和标题画面 / 暂停菜单里的「操作说明」共用
  const HELP_KEYS = [
    [['W', 'A', 'S', 'D'], '移动（方向键亦可）'],
    [['左键', 'Q', 'E'], '朝准星施放技能，可按住'],
    [['右键'], '武器普攻，随武器而变'],
    [['R'], '武器技（枪械和弓要先攒满量表）'],
    [['空格'], '翻滚，短暂无敌，可取消挥砍'],
    [['1', '2'], '生命 / 魔力药剂'],
    [['F'], '处决破绽中的敌人，否则拾取'],
    [['Alt'], '按住：展开名牌概要和浮窗详情'],
    [['I', 'G', 'P', 'M'], '背包 / 技能 / 天赋 / 地图'],
    [['H', 'Esc'], '打开帮助 / 关闭面板；没有面板时 Esc 暂停'],
  ];
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
      HELP_KEYS.map((k) => key(k[0], k[1])).join('') +
      '<div class="sec-title">战斗须知</div>' +
      '<p>地上的<b class="c-red">红色区域</b>是即将落下的攻击，填满前走出去或翻滚穿过。</p>' +
      '<p>护甲减少物理伤害，抗性减少对应元素伤害（上限 75%）。</p>' +
      // 敌人的元素抗性（数值读 G.ENEMY_RES）
      '<p><b>敌人的抗性</b>：每个区的敌人抗本区的元素' + (G.ENEMY_RES.boss === G.ENEMY_RES.mob ? ' ' + G.ENEMY_RES.mob + '%（首领也是）' : '，小怪和精英 ' + G.ENEMY_RES.mob + '%，首领 ' + G.ENEMY_RES.boss + '%') + '，名牌和首领血条上写着「抗火」这类小签。物理、混沌不受抗性影响。' +
      '感电让三种元素抗性各降 ' + G.ENEMY_RES.shock + '%（不会降到 0 以下）；辅助<b>破障</b>和装备上的<b>元素穿透</b>能把抗性压到负数，最低 −' + Math.abs(G.ENEMY_RES.floor) + '%。</p>' +
      helpBuildUp() +
      '<div class="sec-title">连击、架势与处决</div>' +
      '<p><b>连击</b>：近战普攻按住逐段打出（双匕四段，其余三段），末段<b>终结技</b>伤害最高、打飞敌人。停手、翻滚或换技能会从头开始。</p>' +
      '<p>动作中的按键会被记住，能出手时立刻放出。<b>翻滚可以取消挥砍</b>。</p>' +
      '<p><b>架势</b>：精英和首领血条下的白条，命中削减，几秒不挨打回复。打空后露出<b class="c-gold">破绽</b>：停止出招，受到的伤害 +25%。</p>' +
      '<p><b>处决</b>：对破绽中的敌人按 <kbd>F</kbd>，无敌重创，回复生命、魔力和药剂。首领每被击破一次，架势更难打空。</p>' +
      '<p>屏幕边缘的箭头指向画面外的精英、首领和传送门。</p>' +
      '<p>死亡不损失经验和物品：在区域入口重生（首领战则在竞技场门外），怪物回到原位，首领回满生命。</p>' +
      '</div>' +
      '<div class="col scroll" data-scroll="help2"><div class="sec-title">技能与辅助宝石</div>' +
      '<p>怪物掉落<b class="c-teal">技能宝石</b>，更高等级的同名宝石直接升级。在技能页把技能拖到技能栏。</p>' +
      '<p><b class="c-blank">无铭技能宝石</b>可学会任一技能，或把更低等级的已学技能升到它的等级，先用最高的那颗。每个首领首次倒下必掉一颗。</p>' +
      '<p>每个技能有 3 个辅助槽。<b>辅助宝石</b>改变所镶的技能，代价是更高的魔力消耗。一颗只能镶一个技能，技能要带它要求的标签。</p>' +
      '<p><b>刻式</b>：宝石 ' + G.VARIANT_LVL + ' 级后可选 A / B 两种刻式，各加一条新规则。首次免费，之后每换一次 ' + G.VARIANT_COST.n + ' 颗' + G.CURRENCY[G.VARIANT_COST.cur].name + '；' + G.VARIANT_SAFE_R + ' 米内有醒着的敌人时不能换。</p>' +
      '<p><b>光环</b>（' + (G.SKILLS.nova ? G.SKILLS.nova.name : '霜环') + '）放进技能栏即常驻生效，<b>保留</b>一部分最大魔力（以血为引时保留生命）。</p>' +
      helpSummon() +
      '<div class="sec-title">天赋盘</div>' +
      '<p>每升一级得 1 点天赋，首次击败每个首领再得 2 点。五条支路：<b style="color:#e2705a">铸躯</b>（生命与物理）、<b style="color:#7ed67a">迅影</b>（速度与暴击）、<b style="color:#6fb2ff">秘识</b>（魔力与元素）、<b class="c-ally">统御</b>（召唤物）、<b style="color:#ff6ad2">噬渊</b>（混沌、渊缚与黑洞）；相邻支路间有<b style="color:#e0be6e">交汇</b>天赋。满级也点不满，要有取舍。</p>' +
      '<p>每条支路有两个<b>基石天赋</b>，效果强但有代价。天赋可随时免费退回。</p>' +
      helpEnc() +
      '<div class="sec-title">区域与轮回</div>' +
      '<p>每个区域尽头有一名首领，击败后出现通往地图的传送门。</p>' +
      '<p>击败最后一个区域（' + G.ZONES[G.ZONES.length - 1].name + '）的首领开启<b>轮回层级</b>：每高一层，怪物等级 +' + G.TIER_LEVELS + '，物品等级随之提高。</p>' +
      '<p><b>渊印</b>：轮回 1 起进区前选印。印纹越多越凶（<b class="c-red">橙红</b>签强化怪物，<b style="color:#c49cff">紫色</b>签削弱你），物品数量、稀有度和经验加得越多。总权重 ' + G.SEAL.lieW + ' 以上为<b>烈印</b>，首领可掉两件渊契。轮回 ' + G.FRAG_DROP.minTier + ' 起，印还决定<b>烛芯</b>几率：' + fragRates() + '。</p>' +
      '<p>游戏会自动存档。</p>' +
      '<div class="sec-title">素材来源</div>' +
      '<p class="credits">地面与岩壁贴图来自 <b>Poly Haven</b>、<b>ambientCG</b>，布景模型来自 <b>KayKit</b>（Kay Lousberg）与 <b>Kenney</b>，主角、游魂、烬骸仆从与喷吐者的模型和人形角色的部分动作来自 <b>Quaternius</b>，均以 CC0 授权公开，在此致谢。</p>' +
      '<div class="help-foot"><button type="button" tabindex="-1" class="btn sm" data-act="tut-reset">重新显示新手提示</button>' +
      '<span>' + (ui.tutMsg || '已看过 ' + Object.keys(G.save.tut).length + ' / ' + HINTS.length + ' 条') + '</span></div>' +
      '</div>' +
      '<div class="col scroll" data-scroll="help3">' + helpWeapons() + '<div class="sec-title">装备与词缀</div>' +
      '<p>装备分<b style="color:' + G.RARITY_COLOR[0] + '">普通</b>、<b style="color:' + G.RARITY_COLOR[1] + '">魔法</b>（最多 2 条词缀）和<b style="color:' + G.RARITY_COLOR[2] + '">稀有</b>（最多 6 条）。词缀分前缀与后缀，各占一半。</p>' +
      '<p><span class="ic-tier t4">T4</span> 是词缀阶级，物品等级决定最高阶。</p>' +
      '<p><b class="vd-up">▲</b> <b class="vd-down">▼</b> 是与身上同部位的比较。悬停背包格子或<b>地上的名牌</b>看完整属性。</p>' +
      '<p><b style="color:' + G.RARITY_COLOR[3] + '">烬铸</b>武器由轮回层级的首领掉落：词缀行固定、数值在区间内掷出（<b>完美度</b>），带独有机制并把 <kbd>R</kbd> 换成<b>烬铸技</b>。无法改造。「烬铸图鉴」记录收集和保底。</p>' +
      '<p><b>背包操作</b>：右键装备 / 卸下；拖动换装、整理，拖出窗口丢弃；Shift+点击分解（稀有需再点一次）。</p>' +
      '<div class="sec-title">通货</div>' +
      '<p>通货用来改造装备：<b>拖到一件物品上</b>，或选中物品后点右侧的通货按钮。</p>' +
      '<div class="hc-list">' + curs + '</div>' +
      '<p><b style="color:' + G.CURRENCY.chisel.color + '">' + G.CURRENCY.chisel.name + '</b>：拖到物品上后点选一条词缀，只重洗这一条。取消或 <kbd>Esc</kbd> 不消耗。</p>' +
      '<p>分解魔法物品可能得微光尘，稀有物品必得增幅尘。首领首次被击败保底掉升华石和乱流石各一颗。</p>' +
      '</div></div>';
  }

  // ============================================================
  // 渲染调度
  // ============================================================
  const RENDER = { inv: renderInv, skills: renderSkills, tree: renderTree, map: renderMap, help: renderHelp, trader: renderTrader }; // trader：异兆「拾烬客」，不在页签里

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
      '<div class="tc-foot">技能等级 = 宝石等级；先用最高的那颗</div>' + state + '</div>'
    );
  }

  // ---------- 刻式 ----------
  // 技能卡上的刻式一行：宝石 ≥ 解锁等级时「原式 / A 名 / B 名」三个按钮 + 价格；没到时一行灰字。
  // 有渊式的技能下面再一行「渊式」按钮（不看宝石等级）：没戴渊契时灰着、写「装备某某解锁」；选着渊式时亮的是渊式，渊契没戴时亮替下的那种
  function variantRow(id) {
    const V = G.VARIANTS[id];
    if (!V) return '';
    const S = G.save;
    const m0 = ui.varMsg && ui.varMsg.id === id ? '<div class="sv-msg' + (ui.varMsg.bad ? ' bad' : '') + '">' + ui.varMsg.text + '</div>' : '';
    if (!(S.skills[id] >= G.VARIANT_LVL)) return '<div class="sk-var lock"><span class="sv-label">刻式</span><span class="sv-lock">宝石 Lv ' + G.VARIANT_LVL + ' 解锁 A / B 两种刻式</span></div>' + (V.c ? rqRow(id) + m0 : '');
    const sel = S.variants[id] || 'o', cur = sel === 'c' ? (G.variantRelicOn(id) ? 'c' : S.variantPrev[id] || 'o') : sel;
    const VC = G.VARIANT_COST, cost = G.variantCost(id), have = S.cur[VC.cur] || 0;
    let btns = '';
    for (const v of ['o', 'a', 'b']) {
      btns +=
        '<button type="button" tabindex="-1" class="sv-btn' + (cur === v ? ' on' : '') + '" data-act="variant" data-skill="' + id + '" data-v="' + v + '" data-tip="var:' + id + '.' + v + '">' +
        (v === 'o' ? '原式' : '<em>' + G.VARIANT_NAME[v] + '</em>' + V[v].name) + '</button>';
    }
    const price = cost
      ? '<span class="sv-cost' + (have < cost ? ' bad' : '') + '">换一次 ' + cost + ' ' + G.CURRENCY[VC.cur].name + '（持有 ' + have + '）</span>'
      : '<span class="sv-cost free">第一次选免费</span>';
    return '<div class="sk-var"><span class="sv-label">刻式</span>' + btns + price + '</div>' + (V.c ? rqRow(id) : '') + m0;
  }
  // 渊式那一行：按钮（渊式名）+ 右边一句状态（使用中 / 免费切换 / 装备某某解锁）
  function rqRow(id) {
    const V = G.VARIANTS[id].c, S = G.save, worn = G.variantRelicOn(id), sel = S.variants[id] === 'c', R = G.RELICS[V.relic];
    const note = !worn ? '装备' + R.name + '解锁' + (sel ? '（已选，戴上恢复）' : '') : sel ? '使用中' : '免费切换';
    return (
      '<div class="sk-var sk-rq"><span class="sv-label">渊式</span>' +
      '<button type="button" tabindex="-1" class="sv-btn sv-rq' + (worn && sel ? ' on' : '') + (worn ? '' : ' lock') + '" data-act="variant" data-skill="' + id + '" data-v="c" data-tip="var:' + id + '.c"' + (worn ? '' : ' aria-disabled="true"') + '>' +
      V.name + '</button><span class="sv-cost' + (worn ? ' free' : ' rqlock') + '">' + note + '</span></div>'
    );
  }
  // 刻式改动的字段怎么写（悬停里逐条列「原式 → 刻式」）
  const VAR_FIELD = {
    time: ['出手', '秒'], cd: ['冷却', '秒'], radius: ['半径', ''], explode: ['爆炸半径', ''], speed: ['弹速', ''], mana: ['魔力消耗', ''],
    dur: ['持续', '秒'], pull: ['牵引', ''], delay: ['延迟', '秒'], range: ['范围', ''], chain: ['连锁', '次'], pierce: ['穿透', ''],
    count: ['一次', '团'], rate: ['出手间隔', '秒'], move: ['移动', ''], dr: ['减伤', '%'], cleave: ['横斩带到', '个'], reserve: ['保留', '%'],
  };
  function variantTip(key) {
    const cut = key.lastIndexOf('.');
    const id = key.slice(0, cut), v = key.slice(cut + 1);
    const V = G.VARIANTS[id];
    if (!V || !(v === 'o' || v === 'a' || v === 'b' || (v === 'c' && V.c))) return '';
    const S = G.save, base = G.SKILL_BASE[id];
    // 数值按这一刻式临时拼好的定义算（宝石、辅助、装备都是现在的）
    const keep = G.useVariant(id, v);
    const sk = G.SKILLS[id], ctx = G.skillCtx(id);
    let nums = '';
    if (sk.buff) {
      const F = Math.min(sk.flame.cap, sk.flame.k0 + sk.flame.k1 * ((S.skills[id] || 1) - 1)) * (1 + Math.max(0, G.player.S.flameEff || 0) / 100);
      nums = (sk.flameDot ? '黑焰灼烧 ' : '额外混沌 ') + fmt1(F) + '%' + (sk.brand ? ' + 蚀印 ' + fmt1(F) + '%' : '') + ' · 保留 ' + fmt1(ctx.reserve) + '%';
    } else if (sk.kind === 'aura' && sk.mech === 'guard') {
      nums = '每跳 ' + fmt1(G.avgHit(ctx) / sk.useMult) + ' · 贴身秒伤约 ' + fmtInt(G.skillDps(ctx)) + ' · 保留 ' + fmt1(ctx.reserve) + '%'; // 刻式「护涡」光环
    } else if (sk.kind === 'aura') {
      nums = '每跳 ' + fmt1(G.avgHit(ctx)) + ' · 半径 ' + fmt1(G.auraRadius(ctx)) + ' · 保留 ' + fmt1(ctx.reserve) + '%';
    } else if (ctx.minion) {
      nums = '每击 ' + fmtInt(G.avgHit(ctx)) + ' · 每秒 ' + (1 / ctx.minion.interval).toFixed(2) + ' 击 · 生命 ' + fmtInt(ctx.minion.life) + ' · 上限 ' + ctx.minion.cap + ' · 满员秒伤约 ' + fmtInt(G.skillDps(ctx));
    } else {
      // 秒伤和技能卡同一个算法（G.skillDps，冷却技能按冷却折算）；下面的比值按设计稿 §5.2 的口径
      nums = (ctx.cd > 0 ? '每次伤害 ' : '平均击中 ') + fmtInt(G.avgHit(ctx)) + ' · 估算秒伤约 ' + fmtInt(G.skillDps(ctx)) + (ctx.cd > 0 ? ' · 冷却 ' + fmt1(ctx.cd) + ' 秒' : '');
    }
    G.SKILLS[id] = keep;
    const rows = [];
    const toAura = sk.kind === 'aura' && base.kind !== 'aura'; // 刻式「护涡」：按键技能改成光环，出手 / 冷却 / 魔力 / 飞行这些行不再有意义
    if (toAura) rows.push('改为光环：保留魔力 ' + fmt1(ctx.reserve) + '%，不用按键');
    if (v !== 'o') {
      const set = V[v].set;
      for (const k of Object.keys(set)) {
        if (toAura && k !== 'dmg') continue;
        const f = VAR_FIELD[k];
        if (k === 'dmg' || k === 'wm') {
          const avg = (s) => (k === 'wm' ? s.wm : Object.keys(s.dmg).reduce((a, t) => a + s.dmg[t][0] + s.dmg[t][1], 0));
          rows.push('每一击伤害 ×' + (Math.round((avg(sk) / avg(base)) * 100) / 100));
        } else if (k === 'life' && sk.kind === 'summon') rows.push('召唤物生命 ' + base.life + ' → ' + fmt1(sk.life));
        else if (k === 'life') rows.push('飞行 ' + base.life + ' → ' + sk.life + ' 秒');
        else if (f && typeof set[k] === 'number' && typeof base[k] === 'number' && set[k] !== base[k]) rows.push(f[0] + ' ' + fmt1(base[k]) + ' → ' + fmt1(set[k]) + f[1]);
      }
    }
    const r = v === 'o' ? 1 : G.variantRatio(id, v);
    const total = sk.kind === 'aura' && !toAura;
    // 渊式：选进去、退回替下的那种都不花钱；渊契没戴时渊式按钮灰着
    const sel = S.variants[id] || 'o', worn = !V.c || G.variantRelicOn(id);
    const cur = (sel === 'c' && !worn ? S.variantPrev[id] || 'o' : sel) === v;
    const cost = v === 'c' || (sel === 'c' && v === (S.variantPrev[id] || 'o')) ? 0 : G.variantCost(id), VC = G.VARIANT_COST, have = S.cur[VC.cur] || 0;
    const state = v === 'c' && !worn
      ? '<div class="tc-state dup">装备' + G.RELICS[V.c.relic].name + '解锁' + (sel === 'c' ? '（已选，戴上恢复）' : '') + '</div>'
      : cur
      ? '<div class="tc-state dup">当前刻式</div>'
      : G.variantBusy()
        ? '<div class="tc-state dup">战斗中不能换（' + G.VARIANT_SAFE_R + ' 米内还有醒着的敌人）</div>'
        : '<div class="tc-state new">点击换成它：' + (cost ? cost + ' ' + G.CURRENCY[VC.cur].name + '（持有 ' + have + '）' : v === 'c' || sel === 'c' ? '免费（渊式切换不花钱）' : '免费（这个技能第一次选）') + '</div>';
    return (
      '<div class="tcard" style="--c:' + base.color + '">' + tcHead('<div class="tc-skico">' + IC.skill(id) + '</div>', v === 'o' ? '原式' : V[v].name, base.name + ' · ' + (v === 'o' ? '不选刻式' : v === 'c' ? '渊式（' + G.RELICS[V.c.relic].name + '解锁）' : '刻式 ' + G.VARIANT_NAME[v])) +
      '<div class="tc-desc">' + (v === 'o' ? base.desc : V[v].desc) + '</div>' + altBox(v === 'o' ? base.alt : V[v].alt) +
      (rows.length ? '<div class="tc-foot">' + rows.join(' · ') + '</div>' : '') +
      '<div class="tc-stat">' + nums + '</div>' +
      (v === 'o' ? '' : '<div class="tc-foot">' + (total ? '总秒伤' : '单体秒伤') + ' <b>×' + r.toFixed(2) + '</b>（相对原式）' + (total ? ' · ' + (sk.buff ? '按你自己每一击的黑焰比例' : '按主力技能 + 霜环') : toAura ? ' · 光环常驻，不占出手' : '') + '</div>' +
        '<div class="tc-foot">怪群：' + V[v].pack + '</div>') +
      state + '</div>'
    );
  }

  function tipHtml(kind, id) {
    if (kind === 'frag') return fragTip(id);
    if (kind === 'trd') {
      const o = G.state.trader && G.state.trader.stock && G.state.trader.stock[+id];
      return o && o.kind === 'item' ? itemTip(o.item, false, '拾烬客的货架 · 点「买下」') : '';
    }
    if (kind === 'var') return variantTip(id);
    if (kind === 'seal') return sealTip(id);
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
        '<div class="tc-hint' + (n ? '' : ' dim') + '">' + (n ? (id === 'chisel' ? '拖到一件物品上，再点选要重洗的词缀' : '拖到一件物品上使用') : '还没有 · 怪物掉落或分解获得') + '</div></div>'
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
    if (kind === 'wsk') {
      // 武器技说明：名字、来自哪种武器、描述、冷却；正拿着这把武器时说清楚在 R 上
      const sk = G.SKILLS[id];
      if (!sk) return '';
      const cur = curWSkill() === id;
      // 远程武器的普攻 / 量表技
      const rt = sk.rtype || sk.wtype, rbi = (G.BASES.weapon || []).findIndex((b) => b && b.type === rt), rName = rbi >= 0 ? wTypeName(rbi) : '远程武器';
      const gName = GUN_TYPES.indexOf(rt) >= 0 ? '热度' : '专注';
      if (sk.basic) {
        const on = !!(G.weaponBasic && G.weaponBasic() === id);
        const bName = sk.rtype ? rName : basicTypeName(sk.btype);
        const grow = sk.combo ? sk.combo.length + ' 段连招 · 伤害随武器成长' : sk.asMinion ? '伤害按召唤物计算' : sk.edmg ? '法术 · 随武器的物品等级成长' : '伤害随武器成长';
        return (
          '<div class="tcard" style="--c:' + sk.color + '">' + tcHead('<span class="tc-skico">' + IC.skill(id) + '</span>', sk.name, '武器普攻 · ' + bName + ' · 右键') +
          '<div class="tc-desc">' + sk.desc + '</div>' + altBox(sk.alt) +
          '<div class="tc-foot">' + grow + ' · 不耗魔力' + (sk.rtype ? ' · 积攒' + gName : '') + '</div>' +
          '<div class="tc-hint' + (on ? ' ok' : '') + '">' + (on ? '正在右键上' : sk.btype === 'fists' ? '空手时右键' : '装备' + bName + '即可用右键') + '</div></div>'
        );
      }
      if (sk.rgauge) {
        const U = sk.uskill ? uOfSkill(id) : null;
        return (
          '<div class="tcard' + (sk.uskill ? ' uskill' : '') + '" style="--c:' + sk.color + '">' + tcHead('<span class="tc-skico">' + IC.skill(id) + '</span>', sk.name, (sk.uskill ? '烬铸技' : '武器技') + ' · ' + rName + ' · ' + gName + '技') +
          '<div class="tc-desc">' + sk.desc + '</div>' + altBox(sk.alt) +
          '<div class="tc-foot">' + gName + '满时 R 亮起，放出后清零' + (sk.buff ? ' · 吃增益持续时间' : ' · 吃热度技伤害') + ' · 不能镶辅助</div>' +
          '<div class="tc-hint' + (cur ? ' ok' : '') + '">' + (cur ? '正在 R 键上' : '装备' + (U ? '「' + U.name + '」' : rName) + '即可在 R 键使用') + '</div></div>'
        );
      }
      if (sk.uskill) {
        // 烬铸技：余烬框；写明是哪把烬铸武器专属、顶替了哪个武器技
        const U = uOfSkill(id);
        const rp = sk.replaces && G.SKILLS[sk.replaces];
        return (
          '<div class="tcard uskill" style="--c:' + sk.color + '">' + tcHead('<span class="tc-skico">' + IC.skill(id) + '</span>', sk.name, '烬铸技 · ' + esc(uSkillSrc(id)) + (sk.cd > 0 ? ' · 冷却 ' + fmt1(sk.cd) + ' 秒' : '')) +
          '<div class="tc-desc">' + sk.desc + '</div>' + altBox(sk.alt) +
          '<div class="tc-foot">' + WGROW_TIP[wGrowKind(sk)] + ' · 不能镶辅助' + (rp ? ' · 替换「' + rp.name + '」' : '') + '</div>' +
          '<div class="tc-hint' + (cur ? ' ok' : '') + '">' + (cur ? '正在 R 键上' : '装备' + (U ? '「' + U.name + '」' : '对应的烬铸武器') + '即可在 R 键使用') + '</div></div>'
        );
      }
      const bi = (G.BASES.weapon || []).findIndex((b) => b && b.wskill === id);
      return (
        '<div class="tcard" style="--c:' + sk.color + '">' + tcHead('<span class="tc-skico">' + IC.skill(id) + '</span>', sk.name, '武器技 · ' + (bi >= 0 ? wTypeName(bi) : '武器') + (sk.cd > 0 ? ' · 冷却 ' + fmt1(sk.cd) + ' 秒' : '')) +
        '<div class="tc-desc">' + sk.desc + '</div>' + altBox(sk.alt) +
        '<div class="tc-foot">' + WGROW_TIP[wGrowKind(sk)] + ' · 不能镶辅助</div>' +
        '<div class="tc-hint' + (cur ? ' ok' : '') + '">' + (cur ? '正在 R 键上' : '装备一把' + (bi >= 0 ? wTypeName(bi) : '这种武器') + '即可在 R 键使用') + '</div></div>'
      );
    }
    if (kind === 'skdrag') {
      const sk = G.SKILLS[id];
      return '<div class="tcard slim" style="--c:' + sk.color + '"><div class="tc-name">' + sk.name + '</div><div class="tc-hint">拖到技能栏的格子里绑定按键</div></div>';
    }
    if (kind === 'sock') {
      const sp = G.SUPPORTS[id];
      return (
        '<div class="tcard" style="--c:' + IC.supColor(id) + '">' + tcHead(ibox(IC.sup(id), 'gemb'), sp.name, '辅助宝石') + '<div class="tc-desc">' + sp.desc + '</div>' + altBox(sp.alt) +
        '<div class="tc-foot">魔力消耗 ×' + sp.cost + (sp.req || sp.no ? ' · 适用：' + scopeText(sp) : '') + '</div>' +
        '<div class="tc-hint">点击取下 · 拖到别的辅助槽移动</div></div>'
      );
    }
    if (kind === 'node') {
      const n = G.TREE[id];
      const alloc = G.save.passives.includes(id);
      const avail = !alloc && n.links.some((l) => G.save.passives.includes(l));
      let lines = '';
      for (const k in n.stats) lines += '<div class="tc-stat' + (G.statBad(k, n.stats[k]) ? ' bad' : '') + '">' + esc(G.fmtStat(k, n.stats[k])) + '</div>';
      let hint;
      if (n.kind === 'start') hint = '<div class="tc-desc">所有支路从这里出发。</div>';
      else if (alloc) hint = '<div class="tc-hint ok">已点亮 · 点击退回</div>';
      else if (avail) hint = '<div class="tc-hint">' + (G.passivePoints().free > 0 ? '点击点亮' : '可点亮 · 没有可用的天赋点') + '</div>';
      else hint = '<div class="tc-hint dim">未连接 · 先点亮相邻的天赋</div>';
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
    // ---- 拾烬客（异兆）----
    'trd-buy'(d) {
      const r = G.traderBuy(+d.i);
      ui.trdMsg = r === true ? '成交' : r === 'cost' ? '通货不够' : r === 'bag' ? '背包已满' : '';
      render();
    },
    'trd-sell'(d) {
      const f = findItem(d.item);
      if (!f || f.equipped) return;
      const now = performance.now();
      // 稀有以上要再点一次确认（同 Shift+点击分解）
      if (f.item.rarity >= 2 && !(ui.trdArm && ui.trdArm.uid === d.item && now - ui.trdArm.t < 3000)) {
        ui.trdArm = { uid: d.item, t: now };
        ui.trdMsg = '再点一次，确认卖掉「' + f.item.name + '」';
        G.sfx('click');
        return render();
      }
      ui.trdArm = null;
      const res = G.traderSell(f.item);
      ui.fresh.delete(d.item);
      ui.trdMsg = res ? '卖掉了「' + f.item.name + '」' : '';
      render();
    },
    'trd-swap'(d) {
      const r = G.traderSwap(d.frag);
      ui.trdMsg = r ? '换得 1 个' + G.FRAGS[d.frag].name : '烛芯不够（要 ' + G.TRADER.swap + ' 个其它种类的）';
      render();
    },
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
          ui.invMsg = '再 Shift+点击一次，确认分解' + G.RARITY_NAME[f.item.rarity] + (f.item.rarity === 3 ? '武器' : f.item.rarity === 4 ? '' : '物品') + '「' + f.item.name + '」';
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
      const now = performance.now();
      if (f.item.rarity >= 3 && !(ui.salvArm.uid === f.item.uid && now - ui.salvArm.t < 4000)) {
        // 烬铸武器 / 渊契：第一次点只是上膛，4 秒内再点一次「分解」才真的分解
        ui.salvArm = { uid: f.item.uid, t: now };
        const SV = f.item.rarity === 4 ? G.RELIC_SALVAGE : G.UNIQUE_SALVAGE;
        const got = Object.keys(SV).map((id) => G.CURRENCY[id].name + ' ×' + SV[id]).join('、');
        ui.invMsg = '再点一次「分解」确认：分解「' + f.item.name + '」可得 ' + got;
        G.sfx('click');
        render();
        return;
      }
      ui.salvArm = { uid: null, t: 0 };
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
      if (d.opt === 'mute' && G.audio) G.audio.apply();
      G.sfx('click');
      render();
    },
    // 画质：立即生效并存档
    quality(d) {
      if (G.QUALITY_IDS.indexOf(d.q) < 0) return;
      G.save.opts.quality = d.q;
      if (G.world.setQuality) G.world.setQuality(d.q);
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
    'chisel-pick'(d) {
      const c = ui.confirm;
      ui.confirm = null;
      const f = c && c.kind === 'chisel' ? findItem(c.uid) : null;
      if (f) useChisel(f.item, +d.idx);
      render();
    },
    'drop-yes'() {
      const c = ui.confirm;
      ui.confirm = null;
      const f = c && !c.kind ? findItem(c.uid) : null;
      if (f && !f.equipped) dropToGround(f.item);
      render();
    },
    'drop-no'() {
      // 丢弃确认和琢刻石选择框共用的「取消」：什么都不做，也不消耗
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
      if (d.cur === 'chisel' && G.canCraft(f.item, 'chisel')) return askChisel(f.item, ui.mouseX, ui.mouseY);
      if (G.applyCurrency(f.item, d.cur)) {
        ui.invMsg = '';
        ui.flash = true;
        G.sfx('craft');
      } else {
        ui.invMsg = f.item.rarity >= 3 ? lockText(f.item) : '这件物品现在不能使用' + G.CURRENCY[d.cur].name;
        if (f.item.rarity >= 3) G.sfx('deny');
      }
      render();
    },
    codex() {
      ui.sel = null;
      ui.invMsg = '';
      G.sfx('click');
      render();
      const n = el.body.querySelector('.codex-t');
      if (n && n.scrollIntoView) n.scrollIntoView({ block: 'nearest' });
    },

    // ---- 技能 ----
    autosum(d) {
      G.toggleAutoSummon(d.skill, undefined, true);
      render();
    },
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
    // 换刻式：点哪个换哪个（扣费、战斗中拒绝都在 G.setVariant 里），结果写在这张卡下面
    variant(d) {
      const id = d.skill;
      if (!G.VARIANTS[id]) return;
      const r = G.setVariant(id, d.v);
      const nm = d.v === 'o' ? '原式' : G.VARIANTS[id][d.v].name;
      const kept = r.ok && d.v !== 'c' && G.save.variants[id] === 'c'; // 渊式选着、渊契没戴：改的是替下的那种
      ui.varMsg = r.ok
        ? { id, text: r.same ? '已经是「' + nm + '」' : kept ? '渊契没戴时用「' + nm + '」，戴上恢复渊式' + (r.cost ? '（用掉 ' + r.cost + ' ' + G.CURRENCY[G.VARIANT_COST.cur].name + '）' : '') : '「' + G.SKILLS[id].name + '」换成了「' + nm + '」' + (r.cost ? '，用掉 ' + r.cost + ' ' + G.CURRENCY[G.VARIANT_COST.cur].name : '（免费）') }
        : { id, text: r.msg, bad: true };
      G.sfx(r.ok && !r.same ? 'gem' : r.ok ? 'click' : 'deny');
      render();
      retip();
    },
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
    'tree-zoom'(d) {
      if (d.z === 'fit') ui.tv = null;
      else treeZoom(d.z === 'in' ? 0.7 : 1 / 0.7);
      treeApply();
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
      // 渊印：轮回层级 ≥ 1 先弹择印面板（三枚印由 sealSeq 定，关掉再开还是这三枚），层级 0 直接进
      if (ui.mapTier >= 1) {
        ui.sealPick = { zone: +d.zone, tier: ui.mapTier, seals: G.rollSeals(+d.zone, ui.mapTier) };
        render();
        return;
      }
      G.enterZone(+d.zone, ui.mapTier);
      close();
    },
    'seal-pick'(d) {
      pickSeal(+d.i);
    },
    // 余烛殿（D5）：选层级、点燃
    'pin-tier'(d) {
      ui.pinTier = +d.tier;
      ui.pinMsg = '';
      G.sfx('click');
      render();
    },
    'pin-light'() {
      const r = G.lightPinnacle(ui.pinTier || G.PIN.minTier);
      if (!r.ok) {
        ui.pinMsg = r.msg;
        G.sfx('deny');
        render();
        return;
      }
      ui.pinMsg = '';
      G.sfx('click');
      close();
    },
    'seal-cancel'() {
      ui.sealPick = null;
      G.sfx('click');
      render();
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
    if (a.dataset.act !== 'chisel-pick') ui.invOk = ''; // 琢刻石换了哪一条：留到下一次操作
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
  // 琢刻石：先弹出这件物品的词缀列表，玩家点一条再真正使用（取消不消耗）
  function askChisel(item, x, y) {
    ui.confirm = { kind: 'chisel', uid: item.uid, x, y };
    G.sfx('click');
    render();
  }
  function useChisel(item, idx) {
    const before = G.itemLines(item).affixes[idx];
    if (G.applyCurrency(item, 'chisel', idx)) {
      const after = G.itemLines(item).affixes[idx];
      ui.sel = item.uid;
      ui.flash = true;
      ui.invMsg = '';
      ui.invOk = G.CURRENCY.chisel.name + '：' + (before ? before.text : '') + ' → ' + (after ? after.text : '');
      G.sfx('craft');
    } else {
      ui.invMsg = '这条词缀现在不能用' + G.CURRENCY.chisel.name + '重洗';
    }
  }
  function chiselBox(box, item) {
    const c = G.CURRENCY.chisel;
    const lines = G.itemLines(item).affixes;
    const can = G.chiselable(item);
    let rows = '';
    lines.forEach((a, i) => {
      const kind = a.type === 'prefix' ? '前缀' : '后缀';
      rows += can[i]
        ? '<button type="button" tabindex="-1" class="cz-aff ' + a.type + '" data-act="chisel-pick" data-idx="' + i + '"><span class="ic-tier t' + a.tier + '">T' + a.tier + '</span>' +
          '<span class="cz-txt">' + esc(a.text) + '</span><em>' + kind + '</em><b>重洗这一条</b></button>'
        : '<div class="cz-aff off ' + a.type + '"><span class="ic-tier t' + a.tier + '">T' + a.tier + '</span><span class="cz-txt">' + esc(a.text) + '</span><em>' + kind + '</em><b>没有可换的同类' + kind + '</b></div>';
    });
    box.innerHTML =
      '<div class="cf-top">' + ibox(IC.cur('chisel'), 'curb') + '<div><b style="color:' + c.color + '">' + c.name + ' · ' + esc(item.name) + '</b>' +
      '<span>点一条词缀，只把它重洗成另一条同类词缀（前缀换前缀、后缀换后缀），其他词缀不变。消耗 1 ' + c.name + '（持有 ' + (G.save.cur.chisel || 0) + '）。</span></div></div>' +
      '<div class="cz-list">' + rows + '</div>' +
      '<div class="cf-row"><button type="button" tabindex="-1" class="btn" data-act="drop-no">取消</button><span class="cz-esc"><kbd>Esc</kbd> 取消，不消耗</span></div>';
  }
  function renderConfirm() {
    const box = el.confirm;
    const c = ui.confirm;
    const f = c && ui.isOpen && ui.tab === 'inv' ? findItem(c.uid) : null;
    const chisel = !!(c && c.kind === 'chisel');
    if (!f || (chisel ? !G.canCraft(f.item, 'chisel') || !(G.save.cur.chisel > 0) : f.equipped)) {
      ui.confirm = null;
      box.classList.remove('on', 'chisel');
      return;
    }
    box.classList.toggle('chisel', chisel);
    if (chisel) {
      chiselBox(box, f.item);
      box.classList.add('on');
      // 没有鼠标位置（键盘 / 测试）时放在窗口中间
      const x = c.x >= 0 ? c.x : window.innerWidth / 2;
      const y = c.y >= 0 ? c.y : window.innerHeight / 2 + box.offsetHeight / 2;
      box.style.left = Math.round(G.clamp(x - box.offsetWidth / 2, 8, window.innerWidth - box.offsetWidth - 8)) + 'px';
      box.style.top = Math.round(G.clamp(y - box.offsetHeight - 12, 8, window.innerHeight - box.offsetHeight - 8)) + 'px';
      return;
    }
    box.innerHTML =
      '<div class="cf-top">' + itemIcon(f.item) + '<div><b style="color:' + G.RARITY_COLOR[f.item.rarity] + '">' + esc(f.item.name) + '</b>' +
      '<span>把这件稀有物品丢到地上？<br>离开区域后消失。</span></div></div>' +
      '<div class="cf-row"><button type="button" tabindex="-1" class="btn danger" data-act="drop-yes">丢下</button>' +
      '<button type="button" tabindex="-1" class="btn" data-act="drop-no">取消</button></div>';
    box.classList.add('on');
    box.style.left = Math.round(G.clamp(c.x - box.offsetWidth / 2, 8, window.innerWidth - box.offsetWidth - 8)) + 'px';
    box.style.top = Math.round(G.clamp(c.y - box.offsetHeight - 12, 8, window.innerHeight - box.offsetHeight - 8)) + 'px';
  }

  // ============================================================
  // 余烛殿（D5）：魂灯（HUD 左上 3 个小烛，纯 CSS，不画图标画布）、首领血条上的阶段名、地图页的「余烛殿」节点
  // ============================================================
  const pinHud = { box: null, key: '', bkey: '' };
  const PIN_PHASE = ['残焰', '熄灯', '冠焰'];
  // ============================================================
  // 主线追踪条（quest D1）：右上小地图正下方，三行字（主线 k/11 · 做什么 · 怎么做），按住 Alt 多出等级、奖励和一句背景。
  // 只有 DOM（WebGL draw 0 增加）。每帧只比几个整数 / 布尔（步数、存档代数、要不要显示），内容最多每秒重算两次
  // ============================================================
  const qh = { root: null, k: null, goal: null, how: null, alt: null, n: -1, epoch: -1, vis: null, key: '', at: 0, pulse: false, toastQ: [], toastAt: 0 };
  function initQuestHud() {
    const r = (qh.root = document.createElement('div'));
    r.id = 'quest';
    r.innerHTML = '<div class="q-k"></div><div class="q-goal"></div><div class="q-how"></div><div class="q-alt"></div><div class="q-h">按住 <kbd>Alt</kbd> 查看详情</div>';
    qh.k = r.children[0];
    qh.goal = r.children[1];
    qh.how = r.children[2];
    qh.alt = r.children[3];
    $('hud').appendChild(r);
  }
  const curList = (o) => Object.keys(o).map((id) => G.CURRENCY[id].name + ' ×' + o[id]).join('、');
  // 第 n 步（0 起）现在该显示的三行和 Alt 详情。首领等级、区域等级按 G.ZONES 现算
  function questView(n) {
    const q = G.QUEST[n], st = G.state, S = G.save;
    const Z = q.zone ? G.ZONES.find((z) => z.id === q.zone) : null;
    let goal = q.l1 || '', how = q.l2 || '';
    if (q.kind === 'boss') {
      goal = '击败' + G.BOSSES[Z.boss].name;
      how = q.l2 || '首领 ' + (Z.level + G.QUEST_BOSS_LV) + ' 级';
    } else if (q.kind === 'in') {
      goal = '去' + Z.name;
      // 本区首领倒下、传送门还在：指传送门；传送门没了（重进过区域）：按 M 开地图
      how = st.portal && !st.pin ? '走进传送门，在地图上选它' : q.l2 || '按 M 打开地图选它';
    }
    const det = [];
    if (Z) det.push('怪物 ' + Z.level + ' 级 · 首领 ' + (Z.level + G.QUEST_BOSS_LV) + ' 级（你 ' + S.level + ' 级）');
    else det.push('层级 1 怪物等级 +' + G.TIER_LEVELS + '（你 ' + S.level + ' 级）');
    det.push(q.rw ? '奖励 ' + curList(q.rw) : '首次击败另得 2 点天赋');
    return { k: '主线 ' + (n + 1) + '/' + G.QUEST_N, goal, how, det, lore: q.lore };
  }
  function updateQuestHud(now) {
    const Q = G.save.quest, st = G.state;
    const n = Q ? Q.n : G.QUEST_N;
    const vis = !!(Q && n < G.QUEST_N && !Q.off && !ui.intro && !story.on && !menu.title && !menu.pause);
    if (vis !== qh.vis) {
      qh.vis = vis;
      qh.root.classList.toggle('on', vis);
      document.body.classList.toggle('quest-on', vis);
    }
    // 完成提示：排在同一时刻的其它飘字（首领倒下、层级解锁、区域名）后面，前一条出来 0.45 秒后再出（最多等 2.5 秒）
    if (qh.toastQ.length && (now - lastToast.t > 450 || now - qh.toastAt > 2500)) {
      toast(qh.toastQ.shift(), '#ffd98a');
      qh.toastAt = now;
    }
    if (G.saveEpoch !== qh.epoch) {
      // 换了存档（读档 / 新游戏）：不亮
      qh.epoch = G.saveEpoch;
      qh.n = n;
      qh.pulse = false;
      qh.key = '';
    } else if (n !== qh.n) {
      if (n > qh.n) qh.pulse = true;
      qh.n = n;
      qh.key = '';
    }
    if (!vis) return;
    if (qh.key && now - qh.at < 500 && !qh.pulse) return;
    qh.at = now;
    const key = n + '|' + (st.portal && !st.pin ? 1 : 0) + '|' + G.save.level;
    if (key !== qh.key) {
      qh.key = key;
      const v = questView(n);
      qh.k.textContent = v.k;
      qh.goal.textContent = v.goal;
      qh.how.textContent = v.how;
      qh.alt.innerHTML = v.det.map((t) => '<div>' + esc(t) + '</div>').join('') + '<div class="q-lore">' + (v.lore.match(/[^，。]+[，。]?/g) || []).map((c) => '<span>' + esc(c) + '</span>').join('') + '</div>';
    }
    // 换步骤时亮一下（1.2 秒）；首领醒着时不亮，打完再亮
    if (qh.pulse && !(st.boss && st.boss.awake && !st.boss.dead)) {
      qh.pulse = false;
      qh.root.classList.remove('pulse');
      void qh.root.offsetWidth; // 重新开始动画
      qh.root.classList.add('pulse');
    }
  }
  // game.js 推进主线时调：n 完成到第几步，got 这次加进背包的通货（首领步为 null）
  function questDone(n, got) {
    qh.toastQ.push('主线 ' + n + '/' + G.QUEST_N + ' 完成' + (got ? ' · ' + curList(got) : ''));
  }

  function initPinHud() {
    const d = document.createElement('div');
    d.id = 'pin-lamps';
    $('zone-box').insertBefore(d, $('keyhints'));
    pinHud.box = d;
  }
  function updatePinHud() {
    const S = G.state.pin;
    const key = S ? S.lives + '|' + G.PIN_LIVES + '|' + S.phase + '|' + (S.done ? 1 : 0) : '';
    if (key !== pinHud.key) {
      pinHud.key = key;
      pinHud.box.classList.toggle('on', !!S);
      if (S) {
        let h = '<span class="pl-k">魂灯</span>';
        for (let i = 0; i < G.PIN_LIVES; i++) h += '<i class="lamp' + (i < S.lives ? ' on' : '') + '"></i>';
        h += '<span class="pl-ph">' + (S.done ? '熄烛者已倒下' : PIN_PHASE[S.phase] || '') + '</span>';
        pinHud.box.innerHTML = h;
        pinHud.box.dataset.tip = 'txt:倒下熄一盏魂灯，在门外重生；' + G.PIN_LIVES + ' 盏都熄灭即失败，退还 ' + G.PIN_REFUND + ' 个烛芯';
      }
    }
    // 首领血条上写阶段名
    const b = G.state.boss, hb = hud.boss;
    const bkey = b && b.pin && hb.ref === b ? b.name + PIN_PHASE[b.phase || 0] : '';
    if (bkey && bkey !== pinHud.bkey) hb.name.textContent = b.name + ' · ' + PIN_PHASE[b.phase || 0];
    pinHud.bkey = bkey;
  }
  // 地图页的「余烛殿」节点：最高层级 ≥ G.PIN.minTier 才有。4 个烛芯槽、层级选择、「点燃」（扣 4 个烛芯进场）
  function pinNodeHtml() {
    const S = G.save, PN = G.PIN;
    if (!G.pinOpen || !G.pinOpen()) return '';
    const ready = G.pinReady();
    const t = (ui.pinTier = G.clamp(ui.pinTier || PN.minTier, PN.minTier, S.maxTier));
    let slots = '';
    for (const id of G.FRAG_IDS) {
      const f = G.FRAGS[id], n = (S.frags && S.frags[id]) || 0;
      slots += '<div class="pn-slot' + (n ? ' ok' : '') + '" data-tip="frag:' + id + '" style="--c:' + f.color + '">' + ibox(IC.frag(id), 'curb') + '<span>' + f.name + '</span><b>' + n + '</b></div>';
    }
    let tiers = '';
    for (let k = PN.minTier; k <= S.maxTier; k++) tiers += '<button type="button" tabindex="-1" class="tier' + (k === t ? ' on' : '') + '" data-act="pin-tier" data-tier="' + k + '">' + k + '</button>';
    const here = !!G.state.pin, kills = (S.pinnacle && S.pinnacle.kills) || 0;
    return '<div class="pin-node' + (ready ? ' ready' : '') + (here ? ' here' : '') + '">' +
      '<div class="pn-art"><span class="pn-glyph">烛</span>' + (here ? '<span class="z-here">当前所在</span>' : '') + '</div>' +
      '<div class="pn-body"><div class="pn-head"><b class="pn-name">' + G.PINNACLE.name + '</b><span class="pn-boss">首领 <b>' + G.BOSSES.snuffer.name + '</b>' + (S.bossKills.snuffer ? '<em>已击败 ' + kills + ' 次</em>' : '') + '</span></div>' +
      '<div class="pn-desc">' + G.PINNACLE.desc + '四种烛芯各献 1 个进场；倒下 ' + G.PIN_LIVES + ' 次失败，退还 ' + G.PIN_REFUND + ' 个。</div>' +
      '<div class="pn-slots">' + slots + '</div>' +
      '<div class="pn-row"><span class="pn-k">层级</span><div class="tiers">' + tiers + '</div><span class="pn-lv">首领等级 <b>' + G.pinLevel(t) + '</b></span>' +
      '<button type="button" tabindex="-1" class="btn primary pn-go" data-act="pin-light"' + (ready ? '' : ' disabled') + '>点燃</button></div>' +
      (ready ? '' : '<div class="pn-need">四种烛芯各需 1 个：轮回 ' + G.FRAG_DROP.minTier + ' 起的首领和异兆会掉（' + fragRates() + '），拾烬客 2 换 1</div>') +
      (ui.pinMsg ? '<div class="pn-need bad">' + esc(ui.pinMsg) + '</div>' : '') +
      '</div></div>';
  }

  // ============================================================
  // 异兆（D4）：计时条（守隙 / 缚匣 / 试锋 / 落烬）、祈坛增益小签、拾烬客面板、背包里的烛芯
  // ============================================================
  const encHud = { bar: null, fill: null, name: null, txt: null, buff: null, key: '', bkey: '' };
  function initEncHud() {
    const b = document.createElement('div');
    b.id = 'enc-bar';
    b.innerHTML = '<div class="eb-name"></div><div class="eb-track"><i class="eb-fill"></i></div><div class="eb-txt"></div>';
    $('hud').appendChild(b);
    encHud.bar = b;
    encHud.name = b.querySelector('.eb-name');
    encHud.fill = b.querySelector('.eb-fill');
    encHud.txt = b.querySelector('.eb-txt');
    const t = document.createElement('div');
    t.id = 'enc-buff';
    $('zone-box').appendChild(t);
    encHud.buff = t;
  }
  const ENC_TIMED = { guard: 1, box: 1, trial: 1, ember: 1 };
  function updateEncHud() {
    const st = G.state, P = G.player;
    let run = null;
    for (const e of st.enc || []) if (e.st === 'run' && ENC_TIMED[e.kind]) (run = run || e);
    let key = '';
    if (run) {
      const D = G.ENCOUNTERS[run.kind], p = D.p;
      let txt = '';
      if (run.kind === 'guard') txt = '坚守 ' + Math.floor(run.t) + ' / ' + p.hold + ' 秒' + (run.away > 0.3 ? (run.away > p.grace ? ' · 正在倒退，回到圈里！' : ' · 回到圈里') : '');
      else if (run.kind === 'box') txt = run.t > 0 ? '剩 ' + Math.ceil(run.t) + ' 秒 · 匣卫 ' + run.mobs.filter((e) => !e.dead).length + ' 只' : '超时：只能残缚';
      else if (run.kind === 'trial') txt = '剩 ' + Math.max(0, Math.ceil(run.t)) + ' 秒 · 第 ' + run.wave + ' / ' + p.n.length + ' 波' + (run.leaveT > 0.2 ? ' · 回到小室里！' : '');
      else if (run.kind === 'ember') txt = '剩 ' + Math.max(0, Math.ceil(run.t)) + ' 秒 · 烬晶 ' + (run.shards ? run.shards.filter((e) => !e.dead).length : p.n) + ' / ' + p.n;
      key = run.kind + '|' + txt + '|' + Math.round(run.k * 200);
      if (key !== encHud.key) {
        encHud.name.textContent = D.name;
        encHud.txt.textContent = txt;
        encHud.fill.style.width = (G.clamp(run.k, 0, 1) * 100).toFixed(1) + '%';
        encHud.bar.dataset.kind = run.kind;
      }
    }
    if (key !== encHud.key) {
      encHud.key = key;
      encHud.bar.classList.toggle('on', !!run);
    }
    const B = P.encBuff, BD = B && G.SHRINE_BUFFS[B.id];
    const bkey = BD ? B.id + Math.ceil(B.t) : '';
    if (bkey !== encHud.bkey) {
      encHud.bkey = bkey;
      encHud.buff.classList.toggle('on', !!BD);
      if (BD) {
        encHud.buff.style.setProperty('--c', BD.color);
        encHud.buff.innerHTML = '<b>' + BD.name + '</b><span>' + Math.ceil(B.t) + ' 秒</span>';
        encHud.buff.dataset.tip = 'txt:' + BD.desc;
      }
    }
  }
  // 背包：烛芯一行（拾到过才显示，新角色的背包页布局不变）
  function fragRow() {
    const F = G.save.frags || {};
    let total = 0;
    for (const id of G.FRAG_IDS) total += F[id] || 0;
    if (!total) return '';
    let h = '';
    for (const id of G.FRAG_IDS) {
      const f = G.FRAGS[id], n = F[id] || 0;
      h += '<div class="cur frag' + (n ? '' : ' zero') + '" data-tip="frag:' + id + '" style="--c:' + f.color + '">' + IC.frag(id) + '<span class="cur-name">' + f.name + '</span><b>' + n + '</b></div>';
    }
    return '<div class="sec-title">烛芯<span class="sec-note">熄烛者的开启材料</span></div><div class="cur-row frag-row">' + h + '</div>';
  }
  function fragTip(id) {
    const f = G.FRAGS[id];
    if (!f) return '';
    const n = (G.save.frags && G.save.frags[id]) || 0, D = G.FRAG_DROP;
    return (
      '<div class="tcard" style="--c:' + f.color + '">' + tcHead(ibox(IC.frag(id), 'curb'), f.name, '烛芯 · 持有 ' + n) +
      '<div class="tc-desc">开启熄烛者用，四种各需一个。来源：' + f.src + '（轮回 ' + D.minTier + ' 起）；拾烬客 ' + G.TRADER.swap + ' 换 1。</div>' +
      '<div class="tc-hint">几率看择的印：' + fragRates() + '</div></div>'
    );
  }
  // 烛芯几率（G.fragChance）：「素印 40%、浅印 40%、深印 70%、烬印 100%」
  function fragRates() {
    const D = G.FRAG_DROP, pc = (v) => Math.round(v * 100) + '%';
    return '素印 ' + pc(D.plain) + '、' + G.SEAL.grades.map((g, i) => g + ' ' + pc(D.bySeal[i])).join('、');
  }
  // 择印卡片 / 印的悬停里的一行「烛芯 70%」：层级 < minTier 不写
  function fragLine(seal, tier, cls) {
    const p = G.fragChance(seal, tier || 0);
    return p > 0 ? '<div class="' + cls + '">烛芯 ' + Math.round(p * 100) + '%</div>' : '';
  }
  function helpEnc() {
    return (
      '<div class="sec-title">异兆</div>' +
      '<p><b>异兆</b>在小地图上是<b>灰色六边形</b>。轮回 1 起每次进区至少一个。</p>' +
      '<p><b style="color:#b48cff">守隙</b>：清空房间后站进圈里坚守 30 秒。<b style="color:#ffd75e">缚匣</b>：崩开锁链，25 秒内打倒三只匣卫。' +
      '<b style="color:#ff9a3c">游荡者</b>：带名号的精英。<b style="color:#5fe0f0">祈坛</b>：按 <kbd>F</kbd> 得到一种增益。' +
      '<b style="color:#ff5a4a">试锋</b>：跨过符文开始限时试炼。<b style="color:#5fe07a">拾烬客</b>：按 <kbd>F</kbd> 交易。' +
      '<b style="color:#ff9a9a">残影</b>：清空房间后首领残影浮现。<b style="color:#ff8a3c">落烬</b>：触碰烬核，打碎四块烬晶。</p>' +
      '<p>轮回 ' + G.FRAG_DROP.minTier + ' 起，区域首领和异兆（守隙、游荡者、缚匣、试锋、落烬）会掉<b>烛芯</b>，用来开启巅峰首领。几率看这次进区择的印：' + fragRates() + '，没有保底。</p>' +
      // 余烛殿（D5）
      '<div class="sec-title">余烛殿</div>' +
      '<p>最高轮回层级到 ' + G.PIN.minTier + ' 后，地图页出现<b style="color:#ffb24a">余烛殿</b>：印、隙、誓、匣四种烛芯各献 1 个，选好层级点「点燃」，挑战<b style="color:#ffd27a">熄烛者</b>（首领等级 = 17 + ' + G.TIER_LEVELS + ' × 层级 + ' + G.PIN.levelAdd + '）。</p>' +
      '<p>三个阶段：<b>残焰</b>；' + Math.round(G.PIN.phase[0] * 100) + '% 进入<b>熄灯</b>，场地变暗，定时涌来<b style="color:#b48cff">暗潮</b>，站在亮着的火盆<b style="color:#ffc870">暖金色圈</b>里躲，熄灭的火盆旁站 ' + G.PIN.relight.t + ' 秒可重新点燃；' + Math.round(G.PIN.phase[1] * 100) + '% 进入<b>冠焰</b>，外圈起火、场地缩小。</p>' +
      '<p><b>魂灯</b>：倒下熄一盏并在门外重生，首领保留进度；' + G.PIN_LIVES + ' 盏熄灭即失败，退还 ' + G.PIN_REFUND + ' 个烛芯。首次击败必掉一件巅峰' + G.RELIC_NAME + '。</p>'
    );
  }
  function renderTrader() {
    const enc = G.state.trader, S = G.save;
    if (!enc || !enc.stock) {
      el.body.innerHTML = '<div class="trader"><div class="sec-title">拾烬客</div><p class="trd-none">拾烬客不在这里。</p></div>';
      return;
    }
    const price = (pr) =>
      Object.keys(pr).map((id) => '<span class="tp' + ((S.cur[id] || 0) >= pr[id] ? '' : ' short') + '" data-tip="cur:' + id + '" style="--c:' + G.CURRENCY[id].color + '">' + IC.cur(id) + '<b>' + pr[id] + '</b></span>').join('');
    let stock = '';
    enc.stock.forEach((o, i) => {
      let icon, name, color, tip = '';
      if (o.kind === 'item') {
        icon = IC.item(o.item);
        name = o.item.name;
        color = G.RARITY_COLOR[o.item.rarity];
        tip = ' data-tip="trd:' + i + '"';
      } else if (o.kind === 'skill') {
        const sk = G.SKILLS[o.data.id];
        icon = IC.skill(o.data.id);
        name = '技能宝石 · ' + sk.name + ' Lv ' + o.data.lvl;
        color = '#3fe0c8';
      } else {
        icon = IC.sup(o.data);
        name = '辅助宝石 · ' + G.SUPPORTS[o.data].name;
        color = '#f0f0f4';
      }
      const ok = !o.sold && G.traderCanPay(o.price);
      stock +=
        '<div class="trd-row' + (o.sold ? ' sold' : '') + (o.relic ? ' relic' : '') + '"' + tip + '>' + ibox(icon) + '<span class="trd-name" style="color:' + color + '">' + esc(name) + '</span>' +
        '<span class="trd-price">' + price(o.price) + '</span>' +
        '<button type="button" tabindex="-1" class="btn sm" data-act="trd-buy" data-i="' + i + '"' + (ok ? '' : ' disabled') + '>' + (o.sold ? '已售' : '买下') + '</button></div>';
    });
    let sell = '';
    for (const it of S.bag) {
      const res = G.salvageResult(it);
      if (it.rarity >= 1) res.dust = (res.dust || 0) + 1;
      const got = Object.keys(res).map((id) => '<span class="tp" style="--c:' + G.CURRENCY[id].color + '">' + IC.cur(id) + '<b>' + res[id] + '</b></span>').join('') || '<span class="tp dim">—</span>';
      sell +=
        '<div class="trd-row" data-tip="item:' + it.uid + '">' + ibox(IC.item(it)) + '<span class="trd-name" style="color:' + G.RARITY_COLOR[it.rarity] + '">' + esc(it.name) + '</span>' +
        '<span class="trd-price">' + got + '</span><button type="button" tabindex="-1" class="btn sm" data-act="trd-sell" data-item="' + it.uid + '">卖</button></div>';
    }
    const F = S.frags || {}, swapOn = (G.state.tier || 0) >= G.TRADER.fragTier;
    let frags = '';
    for (const id of G.FRAG_IDS) {
      const f = G.FRAGS[id];
      let other = 0;
      for (const o of G.FRAG_IDS) if (o !== id) other += F[o] || 0;
      frags +=
        '<div class="trd-frag" data-tip="frag:' + id + '" style="--c:' + f.color + '">' + ibox(IC.frag(id), 'curb') + '<span>' + f.name + ' <b>' + (F[id] || 0) + '</b></span>' +
        '<button type="button" tabindex="-1" class="btn sm" data-act="trd-swap" data-frag="' + id + '"' + (swapOn && other >= G.TRADER.swap ? '' : ' disabled') + '>换 1 个</button></div>';
    }
    el.body.innerHTML =
      '<div class="trader">' +
      '<div class="col scroll" data-scroll="trd1"><div class="sec-title">拾烬客的货架<span class="sec-note">物品等级 ' + enc.level + '</span></div>' + stock +
      '<div class="sec-title">烛芯换取<span class="sec-note">' + (swapOn ? '任意 ' + G.TRADER.swap + ' 个换 1 个指定种类，不收钱' : '轮回 ' + G.TRADER.fragTier + ' 起开放') + '</span></div><div class="trd-frags">' + frags + '</div>' +
      '<p class="trd-msg">' + esc(ui.trdMsg || '') + '</p></div>' +
      '<div class="col scroll" data-scroll="trd2"><div class="sec-title">卖给拾烬客<span class="sec-note">按分解价，魔法以上多 1 颗微光尘</span></div>' + (sell || '<p class="trd-none">背包是空的</p>') + '</div>' +
      '</div>';
  }

  // ============================================================
  // 打开 / 关闭
  // ============================================================
  function open(tab) {
    if (menu.title) return; // 标题画面上不开面板
    if (!RENDER[tab]) tab = 'inv';
    if (ui.intro) closeIntro();
    closePause();
    const wasOpen = ui.isOpen;
    if (!wasOpen || tab !== ui.tab) {
      // 换页时清掉各页的临时状态
      cancelDrag();
      ui.picker = null;
      ui.confirm = null;
      ui.delArmed = false;
      ui.invMsg = '';
      ui.invOk = '';
      ui.bagMsg = '';
      ui.tutMsg = '';
      ui.treeMsg = '';
      ui.treeMsgBad = false;
      ui.blankMsg = '';
      ui.trdMsg = '';
      ui.trdArm = null;
      disarmReset();
      ui.sealPick = null;
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
    closePause();
    if (!ui.isOpen) return;
    cancelDrag();
    ui.isOpen = false;
    ui.picker = null;
    ui.confirm = null;
    ui.sealPick = null;
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

  // 开场故事（js/story.js）：用到时才插进页面，平常进游戏不加载它和它的图。
  // done(reason)：放完 'end' / 跳过 'skip' / 加载失败 'fail' 都会调；放着的时候游戏暂停（isOpen() 算打开）
  const story = { on: false, loading: null };
  function loadStory() {
    if (G.story) return Promise.resolve(true);
    if (!story.loading) {
      story.loading = new Promise((res) => {
        const s = document.createElement('script');
        s.src = 'js/story.js';
        s.onload = () => res(!!G.story);
        s.onerror = () => {
          story.loading = null; // 没加载上（断网）：下次再试，这次直接跳过
          res(false);
        };
        document.head.appendChild(s);
      });
    }
    return story.loading;
  }
  function playStory(done, opts) {
    if (story.on) return false;
    story.on = true;
    hideTip();
    const root = document.getElementById('story');
    if (root) root.classList.add('on'); // 先盖一层黑，脚本和第一格的图到了再开始
    const end = (r) => {
      story.on = false;
      if (root) root.classList.remove('on');
      if (done) done(r);
    };
    loadStory().then((ok) => {
      if (!ok) return end('fail');
      G.story.play(opts).then(end);
    });
    return true;
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
  // 标题画面与暂停菜单
  // ============================================================
  // 标题画面：载入时盖在存档所在的区域上（main.js 照常进区；模拟不推进，敌人先藏起来，镜头绕着角色缓慢漂移）。
  // 暂停菜单：没有面板开着时按 Esc 打开。两者开着时 isOpen() 都算打开，主循环不推进模拟，冷却、增益都停着
  const menu = {
    title: false,
    pause: false,
    ready: false, // 区域建好了（main.js 调 titleReady）：继续 / 新游戏才能点
    view: null, // 菜单里打开的子页：settings / help / credits / confirm
    hidden: [], // 标题画面期间藏起来的敌人 / 召唤物模型
    after: null, // 离开标题画面后要做的事（首次运行的开场卡片）
    t: 0, // 标题画面开了多久（秒，镜头漂移的相位）
    q0: null, // 进标题画面前镜头的朝向（游戏镜头只平移不旋转，离开时还原）
    focus: null,
    off: null,
  };
  const hasSave = () => (G.hasSave ? G.hasSave() : true);

  // 存档概要：等级 / 手里的武器 / 轮回层级 / 所在区域（游戏没有职业，起手武器类型就是这个角色的路子）
  function saveLine() {
    const S = G.save;
    const w = S.equip && S.equip.weapon;
    const zone = S.run && S.run.pin ? G.PINNACLE.name : (G.ZONES[S.lastZone | 0] || G.ZONES[0]).name;
    return (
      '<i>' + (S.level || 1) + ' 级</i>' +
      '<i>' + (w && w.slot === 'weapon' ? esc(wTypeName(w.baseIdx | 0)) : '空手') + '</i>' +
      '<i>' + (S.tier > 0 ? '轮回 ' + S.tier : '初入') + '</i>' +
      '<i>' + esc(zone) + '</i>'
    );
  }

  const SET_Q = [['high', '高'], ['mid', '中'], ['low', '低']];
  const SET_N = [['manual', '手动拾取'], ['auto', '自动拾取'], ['scrap', '自动丢弃']];
  // 音量滑条：[存档里的键, 名字, 说明]
  const SET_VOL = [
    ['volMaster', '总音量', '所有声音一起调'],
    ['volSfx', '音效', '打击、技能、拾取和界面'],
    ['volAmb', '环境音', '各区的风声、水声、火声'],
    ['volMusic', '音乐', '各区的背景音乐，交战时换成战斗段'],
  ];
  function volSlider(k) {
    const v = G.save.opts[k] | 0;
    return '<div class="vol"><input type="range" tabindex="-1" min="0" max="100" step="5" value="' + v + '" data-tact="vol" data-k="' + k + '"><output>' + v + '</output></div>';
  }
  function menuSettings() {
    const S = G.save;
    const q = G.world.quality ? G.world.quality() : S.opts.quality;
    const row = (name, note, ctrl) => '<div class="m-row"><div class="opt-text"><b>' + name + '</b><span>' + note + '</span></div>' + ctrl + '</div>';
    return (
      row('画质', S.opts.quality === 'auto' ? '自动选择，明显掉帧时会自动调低' : '电脑吃力时调低',
        '<div class="seg">' + SET_Q.map((o) => '<button type="button" tabindex="-1" class="seg-b' + (q === o[0] ? ' on' : '') + '" data-tact="quality" data-q="' + o[0] + '">' + o[1] + '</button>').join('') + '</div>') +
      row('普通物品', '魔法、稀有物品总是自动拾取',
        '<div class="seg">' + SET_N.map((o) => '<button type="button" tabindex="-1" class="seg-b' + (normMode() === o[0] ? ' on' : '') + '" data-tact="normmode" data-mode="' + o[0] + '">' + o[1] + '</button>').join('') + '</div>') +
      row('折叠普通物品的名牌', '地上只留一个小点，悬停或按住 Alt 展开',
        '<button type="button" tabindex="-1" class="switch' + (S.opts.hideNormal ? ' on' : '') + '" data-tact="opt" data-opt="hideNormal"><i></i></button>') +
      // 打击手感（vf-vfx2）：三个开关，默认都开
      row('受击闪光', '敌人挨打时闪一下亮光',
        '<button type="button" tabindex="-1" class="switch' + (S.opts.hitFlash !== false ? ' on' : '') + '" data-tact="opt" data-opt="hitFlash"><i></i></button>') +
      row('顿帧', '重击、暴击时画面停顿一瞬',
        '<button type="button" tabindex="-1" class="switch' + (S.opts.hitStop !== false ? ' on' : '') + '" data-tact="opt" data-opt="hitStop"><i></i></button>') +
      row('镜头震动', '大招落地、挨重击时镜头晃一下',
        '<button type="button" tabindex="-1" class="switch' + (S.opts.shake !== false ? ' on' : '') + '" data-tact="opt" data-opt="shake"><i></i></button>') +
      // vf-vfx3：区域氛围（飘雪、余烬、远处的雷……），默认开
      row('环境特效', '各区飘雪、余烬、远雷这类背景效果',
        '<button type="button" tabindex="-1" class="switch' + (S.opts.ambience !== false ? ' on' : '') + '" data-tact="opt" data-opt="ambience"><i></i></button>') +
      // sfx-synth：声音。滑条拖动时立即生效（onMenuInput），松手才存档
      row('静音', '关掉所有声音',
        '<button type="button" tabindex="-1" class="switch' + (S.opts.mute ? ' on' : '') + '" data-tact="opt" data-opt="mute"><i></i></button>') +
      SET_VOL.map((o) => row(o[1], o[2], volSlider(o[0]))).join('') +
      '<p class="m-note">设置会存进存档，前三项在游戏里的地图页也能改。</p>'
    );
  }
  function menuHelp() {
    return (
      '<div class="m-keys">' + HELP_KEYS.map((k) => '<div class="hk"><span class="hk-keys">' + k[0].map((x) => '<kbd>' + x + '</kbd>').join('') + '</span><span>' + k[1] + '</span></div>').join('') + '</div>' +
      '<p class="m-note">沿着路一直向前，击败尽头的首领。战斗、宝石、天赋和通货的说明在游戏里按 <kbd>H</kbd> 查看。</p>'
    );
  }
  // 素材致谢：和 assets/README.md 的清单一致（全部 CC0）
  const CREDITS = [
    ['Poly Haven', '地面与岩壁贴图'],
    ['ambientCG', '地面与岩壁贴图'],
    ['KayKit Dungeon Remastered、Halloween Bits（Kay Lousberg）', '布景模型'],
    ['Kenney Nature Kit', '布景模型'],
    ['Quaternius Ultimate Modular Men', '主角模型'],
    ['Quaternius Animated Zombie、Animated Monster、Easy Enemy', '游魂、烬骸仆从、喷吐者等角色模型'],
    ['Quaternius Universal Animation Library 1 / 2', '人形角色的走路、受击、倒地动作'],
  ];
  function menuCredits() {
    return (
      '<div class="m-credits">' + CREDITS.map((c) => '<div class="m-cr"><b>' + c[0] + '</b><span>' + c[1] + ' · CC0</span></div>').join('') + '</div>' +
      '<p class="m-note">以上素材均以 CC0 授权公开，在此致谢。渲染用 three.js r128（MIT 许可）。其余美术、音效与玩法均为原创。</p>'
    );
  }
  function menuConfirm() {
    return (
      '<p class="m-warn">开始新游戏会覆盖现有的存档，无法恢复：</p>' +
      '<div class="m-save">' + saveLine() + '</div>' +
      '<div class="m-acts"><button type="button" tabindex="-1" class="btn danger" data-tact="new-confirm">覆盖存档，开始新游戏</button>' +
      '<button type="button" tabindex="-1" class="btn" data-tact="back">取消</button></div>'
    );
  }
  const MENU_VIEW = {
    settings: ['设置', menuSettings],
    help: ['操作说明', menuHelp],
    credits: ['致谢', menuCredits],
    confirm: ['新游戏', menuConfirm],
  };

  function renderMenu() {
    if (menu.title) {
      const has = hasSave();
      el.tContinue.classList.toggle('has', has); // 没有存档时不显示「继续游戏」
      el.tSave.innerHTML = has ? saveLine() : '';
      el.title.classList.toggle('ready', menu.ready);
    }
    const host = menu.title ? el.tView : el.pView;
    const list = menu.title ? el.tMenu : el.pMenu;
    const v = MENU_VIEW[menu.view];
    list.style.display = v ? 'none' : '';
    host.innerHTML = v
      ? '<div class="m-view" data-view="' + menu.view + '"><div class="m-head"><b>' + v[0] + '</b>' +
        '<button type="button" tabindex="-1" class="btn sm" data-tact="back">返回<kbd>Esc</kbd></button></div>' +
        '<div class="m-body">' + v[1]() + '</div></div>'
      : '';
    (menu.title ? el.title : el.pause).classList.toggle('sub', !!v);
  }

  // 标题画面期间敌人 / 召唤物先藏起来（模拟不推进，它们会定在原地）
  function hideActors() {
    const st = G.state;
    for (const list of [st.enemies, st.minions || []]) {
      for (const e of list) {
        const g = e.ent && e.ent.group;
        if (g && g.visible) {
          g.visible = false;
          menu.hidden.push(g);
        }
      }
    }
  }
  function showActors() {
    for (const g of menu.hidden) g.visible = true;
    menu.hidden.length = 0;
  }

  // fromGame：从暂停菜单回来（区域早就建好了）；false：载入时，等 main.js 进区后调 titleReady
  function showTitle(fromGame) {
    if (ui.isOpen) close();
    closeIntro();
    closePause();
    menu.title = true;
    menu.view = null;
    menu.ready = !!fromGame;
    menu.t = 0;
    menu.focus = null;
    const cam = G.world.camera;
    menu.q0 = cam ? cam.quaternion.clone() : null;
    document.documentElement.classList.add('title-on');
    el.title.classList.add('on');
    hideTip();
    if (fromGame) hideActors();
    renderMenu();
  }
  function titleReady() {
    menu.ready = true;
    hideActors();
    if (menu.title) renderMenu();
  }
  function hideTitle() {
    if (!menu.title) return;
    menu.title = false;
    menu.view = null;
    document.documentElement.classList.remove('title-on');
    el.title.classList.remove('on', 'sub');
    showActors();
    const cam = G.world.camera;
    if (cam && menu.q0) {
      cam.quaternion.copy(menu.q0); // 镜头位置下一帧由 W.update 摆回角色身上
      cam.updateMatrixWorld();
    }
    G.world.update(0);
    const f = menu.after;
    menu.after = null;
    if (f) f();
  }
  // 每帧（标题画面开着时，由 main.js 调用）：区域的火光、飘尘照常动，角色原地站着呼吸，镜头绕着角色慢慢转一点、平移一点
  function titleFrame(dt) {
    const W = G.world, P = G.player, cam = W.camera;
    if (!cam || !menu.ready) return;
    menu.t += dt;
    W.update(dt);
    if (P.ent) W.animEnt(P.ent, dt, false);
    if (!menu.focus) {
      // 游戏镜头的焦点：视线和 1 米高的水平面的交点；镜头相对焦点的偏移在整个标题画面期间不变
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(menu.q0 || cam.quaternion);
      const k = (1 - cam.position.y) / fwd.y;
      menu.focus = new THREE.Vector3(cam.position.x + fwd.x * k, 1, cam.position.z + fwd.z * k);
      menu.off = cam.position.clone().sub(menu.focus).multiplyScalar(1.12);
    }
    const t = menu.t;
    const yaw = Math.sin(t * 0.06) * 0.26; // 左右各转约 15 度，一个来回约 100 秒
    const c = Math.cos(yaw), s = Math.sin(yaw), o = menu.off;
    // 焦点往镜头左边让 3.5 米：角色站在画面右侧，左边一栏留给标志和按钮
    const fx = menu.focus.x + Math.sin(t * 0.045) * 1.6 - 3.5 * c, fz = menu.focus.z + Math.cos(t * 0.07) * 1.0 + 3.5 * s;
    cam.position.set(fx + o.x * c + o.z * s, menu.focus.y + o.y, fz - o.x * s + o.z * c);
    cam.lookAt(fx, menu.focus.y, fz);
    cam.updateMatrixWorld();
  }

  function openPause() {
    if (menu.title || menu.pause || ui.isOpen || ui.intro) return false;
    menu.pause = true;
    menu.view = null;
    el.pause.classList.add('on');
    document.body.classList.add('paused');
    hideTip();
    renderMenu();
    G.sfx('click');
    return true;
  }
  function closePause() {
    if (!menu.pause) return;
    menu.pause = false;
    menu.view = null;
    el.pause.classList.remove('on', 'sub');
    document.body.classList.remove('paused');
    el.pView.innerHTML = '';
    el.pMenu.style.display = '';
    hideTip();
  }

  // 新游戏：没有存档时直接开始（区域已经在背后建好）；有存档时先确认，确认后走原来的删档流程（重置存档后重载页面，重载后跳过标题画面）
  function newGame() {
    if (hasSave()) {
      menu.view = 'confirm';
      G.sfx('click');
      renderMenu();
      return;
    }
    if (G.holdSave) G.holdSave(false);
    G.persist();
    G.sfx('click');
    hideTitle();
  }
  const MENU_ACT = {
    continue() {
      G.sfx('click');
      hideTitle();
    },
    new: newGame,
    // 标题画面的「开场故事」：重看一遍，放完回到标题画面（存档不动）
    story() {
      G.sfx('click');
      playStory(null, {});
    },
    'new-confirm'() {
      G.resetSave();
      try {
        window.sessionStorage.setItem(G.PLAY_ONCE_KEY, '1');
      } catch (err) {
        /* 存储不可用：重载后还是先到标题画面，「继续游戏」就是新角色 */
      }
      location.reload();
    },
    resume() {
      G.sfx('click');
      closePause();
    },
    // 返回主菜单：先存档，再盖上标题画面；「继续游戏」回到刚才的位置
    menu() {
      G.persist();
      G.sfx('click');
      showTitle(true);
    },
    back() {
      menu.view = null;
      G.sfx('click');
      renderMenu();
    },
  };
  function onMenuClick(e) {
    const a = e.target.closest('[data-tact]');
    if (!a) return;
    const d = a.dataset;
    const k = d.tact;
    if ((k === 'continue' || k === 'new') && !menu.ready) return;
    if (MENU_VIEW[k] && k !== 'confirm') {
      menu.view = k;
      G.sfx('click');
      renderMenu();
    } else if (k === 'quality' || k === 'opt' || k === 'normmode') {
      ACT[k](d); // 和地图页的选项走同一套：立即生效并存档
      renderMenu();
    } else if (MENU_ACT[k]) MENU_ACT[k](d);
  }
  // 音量滑条：拖动时立即生效，松手（change）时存档并放一声试听
  function onMenuInput(e) {
    const a = e.target;
    if (!a || a.dataset.tact !== 'vol') return;
    const k = a.dataset.k;
    if (!SET_VOL.some((o) => o[0] === k)) return;
    const v = Math.max(0, Math.min(100, Math.round(+a.value) || 0));
    G.save.opts[k] = v;
    const out = a.parentNode.querySelector('output');
    if (out) out.textContent = String(v);
    if (G.audio) G.audio.apply();
    if (e.type === 'change') {
      G.persist();
      if (k === 'volMaster' || k === 'volSfx') G.sfx('impact', { type: 'phys', w: 1, crit: false });
    }
  }
  // 标题画面 / 暂停菜单的按键（抢在 main.js 之前）：子页里 Esc 返回上一层；标题画面上回车 = 第一个按钮，其余按键都不进游戏
  function onMenuKey(e) {
    if (story.on) return; // 开场故事放着：按键归它
    if (!menu.title && !menu.pause) return;
    if (e.code === 'Escape' && menu.view) {
      MENU_ACT.back();
    } else if (menu.title) {
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !menu.view && menu.ready) {
        if (hasSave()) MENU_ACT.continue();
        else newGame();
      }
      if (e.ctrlKey || e.metaKey) return; // 浏览器快捷键照常
    } else return;
    e.stopPropagation();
    e.preventDefault();
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
    edge.t = edge.acc = edge.inAt = 0;
    if (!edge.raf) edge.raf = requestAnimationFrame(edgeScroll);
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
        el: t, ok: true, label: id === 'chisel' ? '对「' + f.item.name + '」使用' + c.name + '，再挑一条词缀' : '对「' + f.item.name + '」使用' + c.name,
        run: () => {
          if (id === 'chisel') {
            ui.sel = f.item.uid;
            ui.invMsg = '';
            askChisel(f.item, ui.mouseX, ui.mouseY);
            return;
          }
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
        return { el: sock, ok: true, label: '镶进 ' + skName(skill), run: () => socketDrop(skill, idx) };
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

  // 技能页拖宝石 / 技能时，指针贴近技能列表的上下边（EDGE_SCROLL 像素内）就自动滚动，越贴边越快，
  // 远处的孔不用松手再滚。滚轮照常能滚（拖拽不拦 wheel）；列表一滚，scroll 监听会按指针位置重算落点。
  // 进了边带先停 EDGE_DELAY 再滚：从贴边的孔拖起、或松手落在贴边的孔上时，列表不会被顺手带走
  const EDGE_SCROLL = 40, EDGE_SPEED = 900, EDGE_DELAY = 250; // 边带宽度；贴到边上时每秒滚多少像素；进边带后等多少毫秒
  const edge = { raf: 0, t: 0, acc: 0, inAt: 0 };
  function edgeScroll(now) {
    edge.raf = 0;
    if (!drag.on || (drag.kind !== 'sup' && drag.kind !== 'skill') || ui.tab !== 'skills') return;
    edge.raf = requestAnimationFrame(edgeScroll);
    const dt = edge.t ? Math.min(0.25, (now - edge.t) / 1000) : 0; // 按真实时间滚，帧率低时速度不变；一帧最多按 250 毫秒算，卡顿后不会一下跳很远
    edge.t = now;
    const list = el.body.querySelector('.skill-list');
    if (!list || !dt) return;
    const r = list.getBoundingClientRect();
    const x = drag.x, y = drag.y;
    let k = 0;
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      if (y < r.top + EDGE_SCROLL) k = -(1 - (y - r.top) / EDGE_SCROLL);
      else if (y > r.bottom - EDGE_SCROLL) k = 1 - (r.bottom - y) / EDGE_SCROLL;
    }
    if (!k) {
      edge.acc = edge.inAt = 0;
      return;
    }
    if (!edge.inAt) edge.inAt = now;
    if (now - edge.inAt < EDGE_DELAY) return;
    // 慢的时候一帧不到 1 像素：攒够整像素再滚
    edge.acc += k * EDGE_SPEED * dt;
    const step = edge.acc < 0 ? Math.ceil(edge.acc) : Math.floor(edge.acc);
    if (!step) return;
    edge.acc -= step;
    list.scrollTop += step;
  }

  function endDrag() {
    if (edge.raf) cancelAnimationFrame(edge.raf);
    edge.raf = 0;
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
    // r-ping 是「找准星」时从外面收拢过来的一圈
    wui.ret.innerHTML = '<i class="r-ping"></i><i class="r-ring"></i><i class="r-dot"></i><i class="r-t t1"></i><i class="r-t t2"></i><i class="r-t t3"></i><i class="r-t t4"></i>';
    rx.ping = wui.ret.firstChild;
    wui.feed = $('feed');
  }

  // 准星要随时找得到：鼠标停了一阵再动、从隐藏变回显示（关面板、鼠标回到窗口）、换区域、复活、切回窗口时，
  // 外圈从大往小收拢一下，把视线引到准星上
  const RET_IDLE = 2200; // 毫秒：鼠标停这么久后再动就提示一下
  const rx = { ping: null, pingAt: -1e9, pings: 0, moveAt: 0, live: false, zone: null, dead: false, want: false };
  function retOnCanvas(t) {
    return !!t && (t === document.body || t === document.documentElement || t.tagName === 'CANVAS');
  }
  function retPing(now) {
    if (now - rx.pingAt < 700 || !rx.ping || !rx.ping.animate) return;
    rx.pingAt = now;
    wui.ret.dataset.ping = ++rx.pings; // 测试用：提示过几次
    // 0.09 秒内从 3.2 倍淡入，再用 0.36 秒减速收拢到准星外圈，最后 0.15 秒淡掉
    rx.ping.animate(
      [
        { transform: 'scale(3.2)', opacity: 0 },
        { transform: 'scale(2.7)', opacity: 1, offset: 0.15, easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)' },
        { transform: 'scale(1.05)', opacity: 0.9, offset: 0.75 },
        { transform: 'scale(1)', opacity: 0 },
      ],
      { duration: 600 }
    );
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
  const MINION_H = { thrall: 1.75, colossus: 2.9, pyre: 1.95 };
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
    const doing = x.rising > 0 ? '正在现身' : x.state === 'beam' && tg ? '灼链 ' + tg.name : x.state === 'meteor' ? '召下坠焰' : tg ? (tg === focus ? '集火 ' : '攻击 ') + tg.name : '跟随中';
    const cmax = x.kind === 'pyre' && x.ctx && x.ctx.minion && x.ctx.minion.charge ? x.ctx.minion.charge.max : 0;
    const taunt = x.kind === 'colossus' && x.tauntCdMax > 0 ? (x.tauntCd > 0.05 ? '嘲讽 ' + Math.ceil(x.tauntCd) + ' 秒' : '嘲讽就绪')
      : cmax ? (x.charge >= cmax ? '焰蓄已满' : '焰蓄 ' + Math.floor(x.charge || 0) + ' / ' + cmax) : '';
    const sig = name + '|' + Math.ceil(x.hp) + '|' + x.maxHp + '|' + doing + '|' + taunt;
    if (sig !== wui.mpSig) {
      wui.mpSig = sig;
      p.className = 'on ' + (x.kind === 'colossus' || x.kind === 'pyre' ? x.kind : 'thrall');
      p.innerHTML =
        '<div class="mp-top"><b>' + esc(name) + '</b><em>召唤物</em></div>' +
        '<div class="mp-hp"><i style="width:' + Math.round(G.clamp(x.maxHp > 0 ? x.hp / x.maxHp : 0, 0, 1) * 100) + '%"></i><span>' + fmtInt(Math.max(0, Math.ceil(x.hp))) + ' / ' + fmtInt(x.maxHp) + '</span></div>' +
        '<div class="mp-note"><span' + (tg && tg === focus ? ' class="focus"' : '') + '>' + esc(doing) + '</span>' + (taunt ? '<span class="' + ((cmax ? x.charge < cmax : x.tauntCd > 0.05) ? '' : 'ready') + '">' + taunt + '</span>' : '') + '</div>';
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
      const k = (sk.kind === 'summon' ? G.minionDmgK(l.data.lvl) : 1 + 0.2 * (l.data.lvl - 1)) * (sk.chaosEarly && G.chaosEarlyK ? G.chaosEarlyK(l.data.lvl) : 1);
      const dmgs = sk.dmg || {};
      let dmg = Object.keys(dmgs).map((t) => '<b style="color:' + G.TYPE_COLOR[t] + '">' + Math.round(dmgs[t][0] * k) + '–' + Math.round(dmgs[t][1] * k) + ' ' + G.TYPE_NAME[t] + '</b>').join(' + ') || '无';
      if (sk.wm && sk.kind !== 'summon') {
        // 攻击技能：伤害取自武器，写倍率和按当前武器算出的数
        const wb = (G.skillBase && G.skillBase(id, l.data.lvl).phys) || null;
        // 有冷却的攻击技能（闪袭）把武器攻速折进每一击（G.cdAps）：倍率后面也写上，和括号里的数对得上
        const cdA = !!(G.cdAps && G.cdAps(sk));
        const aps = cdA ? G.weaponStats(save.equip.weapon).aps : 1;
        dmg = '武器伤害 × ' + Math.round(sk.wm * (1 + (G.ATTACK_GEM_LVL || 0.03) * (l.data.lvl - 1)) * 100) + '%' +
          (cdA ? ' × 攻速 ' + aps.toFixed(2) : '') +
          (wb ? '（当前武器 <b style="color:' + G.TYPE_COLOR.phys + '">' + Math.round(wb[0]) + '–' + Math.round(wb[1]) + ' ' + G.TYPE_NAME.phys + '</b>）' : '');
      }
      if (sk.kind === 'summon') {
        // 召唤宝石：写召唤物自己的基础数值（还没算召唤物属性和辅助）
        dmg = '<span class="c-ally">召唤物</span>每击 ' + dmg + (sk.life ? '<br>召唤物生命 ' + Math.round(sk.life * G.minionLifeK(l.data.lvl)) : '') + (sk.cap ? (sk.cap > 1 ? ' · 基础上限 ' + sk.cap + ' 具' : ' · 只有 1 尊') : '');
      }
      const state = !have
        ? '<div class="tc-state new">新技能 · 拾取后学会' + (save.bar.indexOf(null) >= 0 ? '，并放进技能栏的空格' : '，在技能页绑定按键') + '</div>'
        : l.data.lvl > have
          ? '<div class="tc-state new">升级 · 当前 Lv ' + have + ' → Lv ' + l.data.lvl + '</div>'
          : '<div class="tc-state dup">等级不高于已学会的 Lv ' + have + ' · 拾取后化为 1 ' + G.CURRENCY.dust.name + '</div>';
      return (
        '<div class="tcard" style="--c:' + sk.color + '">' + tcHead('<span class="ibox sk" style="--c:' + sk.color + '">' + IC.skill(id) + '</span>', sk.name, '技能宝石 · Lv ' + l.data.lvl) +
        '<div class="tc-tags">' + cardTags(sk).map((t) => '<span>' + G.TAG_NAME[t] + '</span>').join('') + '</div>' +
        '<div class="tc-desc">' + sk.desc + '</div>' + altBox(sk.alt) +
        '<div class="tc-foot">' + (sk.buff ? '额外混沌 ' + fmt1(Math.min(sk.flame.cap, sk.flame.k0 + sk.flame.k1 * (l.data.lvl - 1))) + '%（每一击）' : (sk.kind === 'summon' ? '' : sk.kind === 'aura' ? '每跳基础伤害 ' : sk.useMult > 1 && !sk.weaponOnly ? '每跳基础伤害 ' : '基础伤害 ') + dmg) + '<br>' +
        (sk.buff
          ? '魔力保留 ' + sk.reserve + '%'
          : sk.kind === 'aura'
          ? '魔力保留 ' + sk.reserve + '% · ' + (sk.mech === 'guard' ? '旋风绕身 · 每 ' + sk.tick + ' 秒一跳' : '每 ' + sk.time + ' 秒一跳 · 半径 ' + sk.radius)
          : '魔力 ' + (sk.mana ? Math.round(sk.mana * (1 + 0.05 * (l.data.lvl - 1))) : '无') + ' · 施放 ' + sk.time + ' 秒' + (sk.cd ? ' · 冷却 ' + sk.cd + ' 秒' : '')) +
        '</div>' +
        state + foot + '</div>'
      );
    }
    if (l.kind === 'blank') {
      const ok = G.blankUseful(l.data.lvl);
      return blankTip(null, l.data.lvl).replace(/<\/div>$/, '') +
        (ok
          ? '<div class="tc-state new">到技能页（<kbd>G</kbd>）学会任一技能，或升级 Lv ' + l.data.lvl + ' 以下的技能</div>'
          : '<div class="tc-state dup">所有技能都已学会且不低于 Lv ' + l.data.lvl + ' · 拾取后化为 1 ' + G.CURRENCY.dust.name + '</div>') +
        foot + '</div>';
    }
    const sp = G.SUPPORTS[l.data];
    const have = save.supports.indexOf(l.data) >= 0;
    const fits = Object.keys(save.skills).filter((id) => G.supportFits(id, l.data)).map((id) => G.SKILLS[id].name);
    return (
      '<div class="tcard" style="--c:' + IC.supColor(l.data) + '">' + tcHead(ibox(IC.sup(l.data), 'gemb'), sp.name, '辅助宝石') +
      '<div class="tc-desc">' + sp.desc + '</div>' + altBox(sp.alt) +
      '<div class="tc-foot">魔力消耗 ×' + sp.cost + ' · 适用：' + scopeText(sp) +
      '<br>你的技能里可镶嵌：' + (fits.length ? fits.join('、') : '暂无') + '</div>' +
      (have
        ? '<div class="tc-state dup">已经拥有 · 拾取后化为 1 ' + G.CURRENCY.augment.name + '</div>'
        : '<div class="tc-state new">新的辅助宝石</div>') +
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
    if (slotDown(0) || slotDown(1) || slotDown(2) || slotDown(3) || slotDown(W_SLOT) || G.player.cast || G.player.exec) wui.busyAt = now;
    const mini = now - wui.busyAt < 900;
    if (!e || e.isBoss || (e.elite && (mini || e.brokenT > 0))) {
      if (wui.plateOn) {
        wui.plateOn = false;
        wui.plateSig = '';
        p.classList.remove('on');
      }
      return false;
    }
    const sig = (mini ? 'm|' : 'f|') + e.name + '|' + e.level + '|' + (mini ? '' : Math.ceil(e.hp) + '|' + resSig(e)) + '|' + ailSig(e) + '|' + (e.awake ? 1 : 0);
    if (sig !== wui.plateSig) {
      wui.plateSig = sig;
      p.className = 'on' + (e.elite ? ' elite' : '') + (mini ? ' mini' : '');
      const top = '<b>' + esc(e.name) + '</b><span>Lv ' + e.level + '</span>' + (e.elite ? '<em>精英</em>' : '');
      p.innerHTML = mini
        ? '<div class="np-top">' + top + ailHtml(e, false) + '</div>'
        : '<div class="np-top">' + top + '</div>' +
          '<div class="np-hp"><i style="width:' + Math.round(G.clamp(e.hp / e.maxHp, 0, 1) * 100) + '%"></i><span>' + fmtInt(Math.max(0, Math.ceil(e.hp))) + ' / ' + fmtInt(e.maxHp) + '</span></div>' +
          (resSig(e) ? '<div class="np-res">' + resChips(e, true) + '</div>' : '') + // 元素抗性：只在停手细看的完整名牌上
          (ailSig(e) ? '<div class="np-ail">' + ailHtml(e, true) + '</div>' : e.awake ? '' : '<div class="np-note">尚未察觉你</div>');
      // 尺寸只在内容变了的时候量一次（下面用它把名牌夹在屏幕里）
      wui.plateW = p.offsetWidth;
      wui.plateH = p.offsetHeight;
    }
    wui.plateOn = true;
    const h = (e.height || 1.8) * (e.elite ? 1.3 : 1);
    const q = G.world.project(e.x, h + 0.35, e.z);
    // 镜头近了以后，画面上方的高个子敌人头顶会顶出屏幕：名牌夹在屏幕里（左右各留 6 像素，上边留 6 像素）
    const hw = (wui.plateW || 0) / 2, vw = window.innerWidth;
    const x = Math.min(Math.max(q.x, hw + 6), Math.max(hw + 6, vw - hw - 6));
    const y = Math.max(q.y - (e.elite ? 24 : mini ? 16 : 10), (wui.plateH || 0) + 6);
    p.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px) translate(-50%,-100%)';
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
    // 面板 / 开场卡片刚关掉：鼠标不动就没有 mousemove，overCanvas 还停在「鼠标在面板上」，准星和系统指针会一起消失。
    // 这里按鼠标现在的位置重新判断一次（只在关掉的那一帧读一次布局）
    if (live && !rx.live && ui.mouseX >= 0) ui.overCanvas = retOnCanvas(document.elementFromPoint(ui.mouseX, ui.mouseY));
    rx.live = live;
    const aim = live && ui.overCanvas && ui.mouseX >= 0;
    if (aim && !P.dead) {
      loot = W.lootLabelAt(ui.mouseX, ui.mouseY);
      if (!loot) enemy = enemyAt(ui.mouseX, ui.mouseY);
      if (!loot && !enemy) ally = minionAt(ui.mouseX, ui.mouseY); // 敌人优先：准星压在混战里时总是先看敌人
    }
    minionPlate(ally);
    const rs = !aim ? 'off' : loot ? 'loot' : enemy ? 'enemy' : ally ? 'ally' : 'aim';
    if (rs !== wui.retState) {
      if (wui.retState === 'off') rx.want = true; // 从隐藏变回显示：提示一下在哪
      wui.retState = rs;
      wui.ret.className = rs;
    }
    // 换区域 / 复活后画面整个变了，也提示一下；隐藏着的时候先记下，显示出来再提示
    if (G.state.zone !== rx.zone) {
      if (rx.zone) rx.want = true;
      rx.zone = G.state.zone;
    }
    if (P.dead !== rx.dead) {
      if (!P.dead) rx.want = true;
      rx.dead = P.dead;
    }
    if (rx.want && rs !== 'off') {
      rx.want = false;
      retPing(now);
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
    } else if (loot.kind === 'frag') {
      const F = G.FRAGS[loot.data];
      feedPush('f' + loot.data, ibox(IC.frag(loot.data), 'curb'), F.name, F.color, '<em class="fd-note">共 ' + (G.save.frags[loot.data] || 0) + ' 个</em>');
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
    px: null, pz: 0, moved: 0, cast: [false, false, false, false, false], rolled: false, sawGround: false, cur0: -1,
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
  // 右键的武器普攻是连招（近战武器 / 空手），或者技能栏上有连招技能
  const comboOnBar = () => !!(G.weaponBasic && G.weaponBasic() && G.SKILLS[G.weaponBasic()].combo) || G.save.bar.some((id) => id && G.SKILLS[id] && G.SKILLS[id].combo);
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
      html: '敌人露出<b class="c-gold">破绽</b>：靠近按 <kbd>F</kbd> <b>处决</b>，重创并回复生命、魔力和药剂',
      when: () => enemyNear(16, (e) => e.brokenT > 0.8 && !e.executed),
      done: (b) => G.state.stats.execs > b.execs,
    },
    {
      id: 'flask', urgent: true, max: 14,
      html: '生命见底：按 <kbd>1</kbd> 喝<b>生命药剂</b>（<kbd>2</kbd> 魔力）。击杀敌人充能',
      when: () => lifeFrac() < 0.5 && G.player.flask.life >= 1,
      done: (b) => G.player.flask.life < b.flask - 0.5 || lifeFrac() > 0.9,
    },
    {
      // 旧存档第一次读进来（武器补上了伤害）：说一次攻击技能改为吃武器伤害
      id: 'wmig', calm: true, max: 14,
      html: '<b>武器改版</b>：攻击技能的伤害改取自<b>手中武器</b>，旧武器已按等级折算。杖和魂幡的武器伤害低，走攻击路线请换刃、双匕、战锤、太刀或长弓。每种武器自带一招 <kbd>R</kbd> 键<b>武器技</b>',
      when: () => !!G.weaponMigrated,
      done: () => false,
    },
    {
      // 成长改版前的老角色第一次读进来：天赋盘扩大、宝石 / 武器 / 词缀不再封顶
      id: 'growth', calm: true, max: 16,
      get html() {
        const free = G.passivePoints().free;
        const n = Object.keys(G.TREE).length - 1;
        return '<b>成长改版</b>：天赋盘扩大到 <b>' + n + '</b> 个节点，原有天赋全部保留' + (free > 0 ? '，还有 <b class="c-gold">' + free + '</b> 点可用（<kbd>P</kbd>）' : '') +
          '。宝石上限提到 Lv ' + G.MAX_GEM_LEVEL + '，武器伤害随物品等级成长，物品等级 31 起出现更高阶词缀。' +
          '比怪物高 3 级以上时经验迅速减少，经验条已折算';
      },
      when: () => !!G.growthMigrated,
      done: () => false,
    },
    {
      // 读档时有辅助对技能的哪种刻式都用不上了（标签改过）：已经取下放回宝石栏，说一声去了哪
      id: 'sockdrop', calm: true, max: 20,
      get html() {
        const L = (G.sockDropped || []).filter((d) => G.SUPPORTS[d.sup] && G.SKILLS[d.id]);
        return '<b>辅助宝石</b>：' + L.map((d) => '「' + G.SUPPORTS[d.sup].name + '」').join('、') + '对所镶的技能不再适用，已取下放回宝石栏（<kbd>G</kbd>）';
      },
      when: () => !!(G.sockDropped && G.sockDropped.length),
      done: () => false,
    },
    {
      // 武器普攻改版（右键固定是武器普攻、裂石击删除）之前的存档第一次读进来：说清右键变了什么、原来的东西去了哪
      id: 'basicmig', calm: true, max: 20,
      get html() {
        const kn = ['左键', '右键', 'Q', 'E'];
        let h = '<b>武器普攻改版</b>：<kbd>右键</kbd>固定为武器自己的普攻（近战是连招，不耗魔力）。';
        const cr = G.cleaveRefund;
        if (cr) h += '<b>裂石击</b>已移除，退还一颗 <b class="c-teal">Lv ' + cr.lvl + ' 无铭技能宝石</b>' + (cr.sups && cr.sups.length ? '，辅助已取下' : '') + '。';
        for (const m of G.rmbMigrated || []) {
          const sk = G.SKILLS[m.id];
          if (!sk) continue;
          h += '「' + sk.name + '」' + (m.to >= 0 ? '移到 <kbd>' + kn[m.to] + '</kbd>' : '已收起（技能栏满），在技能页重新绑定') + '。';
        }
        return h;
      },
      when: () => !!(G.cleaveRefund || (G.rmbMigrated && G.rmbMigrated.length)),
      done: () => false,
    },
    {
      id: 'move', basic: true, max: 40,
      html: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 移动，沿着路一直往前走',
      when: () => true,
      done: () => coach.moved > 5,
    },
    {
      id: 'attack', basic: true, need: 'move', max: 60,
      // 右键是武器普攻（刃起手是「挥斩」连招，杖类是「灵弹」/「疾咒」），左键是起手的掷焰
      get html() {
        const bid = G.weaponBasic ? G.weaponBasic() : null;
        const bk = bid && G.SKILLS[bid];
        const l = G.save && G.save.bar[0] && G.SKILLS[G.save.bar[0]];
        return '按住 <kbd>右键</kbd> 武器普攻' + (bk ? '「' + bk.name + '」' : '') + '，<kbd>左键</kbd> ' + (l ? '施放「' + l.name + '」' : '放技能') + '，都朝准星方向';
      },
      when: () => true,
      done: () => coach.cast[0] && coach.cast[1],
    },
    {
      id: 'dodge', basic: true, need: 'attack', max: 40,
      html: '<kbd>空格</kbd> 翻滚，途中无敌。滚出地上的<b class="c-red">红色区域</b>',
      when: () => G.state.enemies.some((e) => e.awake && !e.dead),
      done: () => coach.rolled,
    },
    {
      id: 'combo', need: 'attack', max: 30,
      get html() {
        const bid = G.weaponBasic ? G.weaponBasic() : null;
        const sk = bid && G.SKILLS[bid];
        const n = sk && sk.combo ? sk.combo.length : 3;
        return '按住 <kbd>右键</kbd> 连出<b>' + (['', '一', '两', '三', '四'][n] || n) + '段</b>' + (sk ? '「' + sk.name + '」' : '') + '，末段是<b>终结技</b>，伤害最高。出招中可按 <kbd>空格</kbd> 翻滚取消';
      },
      when: () => comboOnBar() && enemyNear(9, (e) => e.awake),
      done: (b) => G.state.stats.finishers > b.finishers,
    },
    {
      // 第一次能用 R：手里的武器有武器技、它没在冷却、身边有醒着的敌人
      id: 'wskill', need: 'attack', max: 30,
      get html() {
        const id = curWSkill();
        const sk = id ? G.SKILLS[id] : null;
        return '按 <kbd>R</kbd> 放<b>武器技</b>' + (sk ? '「' + sk.name + '」' : '') + '：每种武器自带一招，有冷却、单次伤害高';
      },
      when: () => {
        const id = curWSkill();
        return !!id && !rangedNow() && !(G.player.cds[id] > 0) && enemyNear(11, (e) => e.awake); // 远程武器的 R 由下面的量表提示讲
      },
      done: () => {
        const id = curWSkill();
        return !!coach.cast[W_SLOT] || !!(id && G.player.cds[id] > 0);
      },
    },
    {
      // 第一次拿上枪械或弓：右键变成武器普攻、R 被量表卡住
      id: 'ranged', max: 26,
      get html() {
        const rw = rangedNow();
        const gun = rw && rw.family === 'gun';
        const bk = rw && G.SKILLS[rw.basic];
        const g = rw ? rw.gauge.name : '量表';
        return '拿上了' + (gun ? '<b>枪械</b>' : '<b>弓</b>') + '：<kbd>右键</kbd>现在是它的普攻「' + (bk ? bk.name : gun ? '开火' : '射击') + '」。' +
          (gun ? '开火' : '命中') + '积攒<b class="c-gold">' + g + '</b>（R 格旁的竖条），满了 <kbd>R</kbd> 才亮';
      },
      when: () => !!rangedNow(),
      done: () => {
        const rw = rangedNow();
        return !!rw && rw.gauge.v > rw.gauge.max * 0.15;
      },
    },
    {
      // 量表第一次灌满：按 R
      id: 'rgauge', urgent: true, need: 'ranged', max: 18,
      get html() {
        const rw = rangedNow(), id = curWSkill(), sk = id ? G.SKILLS[id] : null;
        return '<b class="c-gold">' + (rw ? rw.gauge.name : '量表') + '满了</b>：按 <kbd>R</kbd> 放出' + (sk ? '「' + sk.name + '」' : '这把武器的 R 技');
      },
      when: () => {
        const rw = rangedNow();
        return !!rw && rw.gauge.full && !!curWSkill();
      },
      done: () => {
        const rw = rangedNow();
        return !rw || !rw.gauge.full;
      },
    },
    {
      // 远程改版前的存档里有长弓：读档时改成了鹰眼长弓（箭雨换成了一矢穿心）
      id: 'bowmig', calm: true, max: 16,
      html: '<b>远程改版</b>：长弓分为追猎弓、鹰眼长弓、符文弓，你的长弓已改为<b>鹰眼长弓</b>（伤害与词缀不变）。' +
        '命中积攒<b class="c-gold">专注</b>，满了按 <kbd>R</kbd> 放「一矢穿心」',
      when: () => G.bowMigrated > 0,
      done: () => false,
    },
    {
      // 刻式第二版之前的存档：A / B 整个重做了，免费那一次还给了每个技能
      id: 'variant2', calm: true, max: 16,
      html: '<b>刻式重做</b>：A / B 刻式都换成了新打法，原选择按位置保留。每个技能可<b class="c-gold">免费重选一次</b>（<kbd>G</kbd>）',
      when: () => G.variantRedone > 0,
      done: () => false,
    },
    {
      // 渊式之前的存档：身上戴着的渊契原来直接改技能打法，读档时换成了这个技能的渊式（G.rqMigrated，见 game.js 的 sanitize）
      id: 'rqvar', calm: true, max: 16,
      html: '<b>渊式</b>：改技能打法的渊契换成了技能的第三种刻式，已替你选上；摘下渊契退回原来的刻式（<kbd>G</kbd>）',
      when: () => G.rqMigrated > 0,
      done: () => false,
    },
    {
      // 旋涡斩加了「每下最多 9 个」之前、选着旋涡斩的老存档：提示一次（见 game.js 的 wsNote）
      id: 'wsnerf', calm: true, max: 14,
      html: '<b>旋涡斩</b>：每下最多绞到离你最近的 9 个敌人，怪聚成一团时伤害约 −40%；分散的怪和单体不变',
      when: () => G.whirlNerfed > 0,
      done: () => false,
    },
    {
      // 旧版双生坠：读档时升成四行（见 game.js 的 migrateTwin）
      id: 'sxmig', calm: true, max: 16,
      html: '<b>双生坠升级</b>：多了暴击伤害和总伤害两行，原有两行按原来的成色换算到新数值；效果改为「余响」',
      when: () => G.twinMigrated > 0,
      done: () => false,
    },
    {
      // 第五区上线前就打通过烬渊深处的老存档：提示一次多了一个区域（文字在数据里；读档时 sanitize 按 G.zoneNoticeFor 把 G.newZoneNotice 置上）
      get id() {
        return (G.NEW_ZONE_NOTICE && G.NEW_ZONE_NOTICE.id) || 'zone5';
      },
      calm: true, max: 16,
      get html() {
        return (G.NEW_ZONE_NOTICE && G.NEW_ZONE_NOTICE.html) || '<b>新区域</b>：烬渊深处之后新增一个区域。<kbd>M</kbd> 打开地图';
      },
      when: () => !!G.newZoneNotice,
      done: () => false,
    },
    {
      // 熄烛冠巅峰改版之前的存档里有熄烛冠：读档时原地升级（见 game.js 的 migrateXizhu），提示一次
      id: 'xzmig', calm: true, max: 14,
      html: '<b>熄烛冠已升级</b>：原有词缀按原品质提到新数值（冰霜抗性改为生命回复），新增一条「暗域增伤」，机制换成「暗域」',
      when: () => G.xizhuMigrated > 0,
      done: () => false,
    },
    {
      id: 'poise', max: 30,
      html: '精英和首领血条下的<b>白条是架势</b>，打空后敌人露出<b class="c-gold">破绽</b>。近战和终结技削得最多',
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
        const k = i >= 0 && KEY_LABEL[i] ? KEY_LABEL[i] : '';
        const how = k
          ? '按 <kbd>' + k + '</kbd> 开关<b>自动召唤</b>（补到上限，魔力不够时暂停），<kbd>Shift</kbd>+<kbd>' + k + '</kbd> 在准星处召唤'
          : '放进技能栏，按它的键开关<b>自动召唤</b>';
        return '学会了<b class="c-ally">召唤</b>：' + how + '。召唤物优先<b>集火</b>你打中的敌人';
      },
      when: () => coach.summonPing,
      done: () => minionCount() > 0 && !!focusNow(),
    },
    {
      // 第一次唤起焚骨祭司：讲清楚它站后排、靠焰蓄放大招、怕被贴身
      id: 'pyre', max: 30,
      html: '<b class="c-ally">焚骨祭司</b>在后排掷火弹，炸到敌人攒<b>焰蓄</b>（图标下的橙条），满了放<b>坠焰</b>或<b>灼链</b>。它很脆，让仆从挡在前面',
      when: () => G.state.minions.some((m) => m && !m.dead && m.kind === 'pyre' && !(m.rising > 0)),
      done: () => (G.state.stats.pyreMeteors || 0) + (G.state.stats.pyreBeamTicks || 0) > 0,
    },
    {
      id: 'loot', calm: true, max: 22,
      html: '有掉落：魔法、稀有物品走过去就捡，普通物品按 <kbd>F</kbd> 或点名牌。<br>准星停在名牌上看属性，按住 <kbd>Alt</kbd> 看概要',
      when: () => G.state.loot.some((l) => l.kind === 'item' && Math.hypot(l.x - G.player.x, l.z - G.player.z) < 9),
      done: (b) => coach.sawGround || G.save.bag.length > b.bag,
    },
    {
      id: 'bag', calm: true, max: 45,
      html: '背包里有装备：按 <kbd>I</kbd>，<b>右键</b>或拖到装备栏穿上。<b class="vd-up">▲</b> 表示比身上的强',
      when: () => G.save.bag.length > 0,
      done: (b) => equipSig() !== b.equip,
      panel: { tab: 'inv', html: '<b>右键</b>穿上带 <b class="vd-up">▲</b> 的装备，或拖到左边装备栏' },
    },
    {
      id: 'craft', calm: true, max: 45,
      html: '捡到<b>通货</b>：用来改造装备。按 <kbd>I</kbd>，把它<b>拖到一件物品上</b>',
      when: () => curTotal() > coach.cur0 && G.save.bag.length + Object.keys(G.save.equip).length > 0,
      done: (b) => curTotal() < b.cur,
      panel: { tab: 'inv', html: '把通货<b>拖到一件物品上</b>；微光尘让普通物品长出一条词缀' },
    },
    {
      id: 'support', calm: true, max: 45,
      html: '得到<b>辅助宝石</b>：按 <kbd>G</kbd>，<b>拖进技能的辅助槽</b>',
      when: () => G.save.supports.length > 0 && socketCount() === 0,
      done: () => socketCount() > 0,
      panel: { tab: 'skills', html: '把宝石<b>拖进</b>技能的辅助槽（技能要有它要求的标签）' },
    },
    {
      id: 'blank', calm: true, max: 45,
      html: '捡到<b class="c-blank">无铭技能宝石</b>：按 <kbd>G</kbd> 在技能页<b>任选一个技能</b>学会或升级',
      when: () => G.save.blankGems.length > 0,
      done: (b) => G.save.blankGems.length < b.blank,
      panel: { tab: 'skills', html: '点「尚未获得」里的技能（或卡上的「升至 Lv」），<b>再点一次</b>确认，用掉最高等级的那颗' },
    },
    {
      id: 'passive', calm: true, max: 45,
      html: '有<b>天赋点</b>可用：按 <kbd>P</kbd> 打开天赋盘',
      when: () => G.passivePoints().free > 0,
      done: (b) => G.save.passives.length > b.passives || G.passivePoints().free <= 0,
      panel: { tab: 'tree', html: '从中央出发，点亮<b>相邻</b>的天赋，随时可退回' },
    },
    {
      id: 'boss', urgent: true, max: 9,
      html: '前方是<b>首领</b>竞技场。看清红色预警，留好翻滚和药剂',
      when: () => {
        const st = G.state;
        const z = st.zone;
        return !!(z && st.boss && !st.boss.dead && !st.boss.awake && G.world.nearArena(G.player.x, G.player.z));
      },
      done: () => !G.state.boss || G.state.boss.awake || G.state.boss.dead,
    },
    {
      id: 'portal', calm: true, max: 40,
      html: '首领倒下了。捡完战利品走进<b>传送门</b>，在地图上选下一个区域',
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
    coach.cast = [false, false, false, false, false];
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
    if (id === 'sxmig') {
      G.save.twinMig = false;
      G.twinMigrated = 0;
    }
    if (id === 'bowmig') G.save.bowMig = false;
    if (id === 'xzmig') G.save.xzMig = false;
    if (id === 'variant2') {
      G.save.varNote = false;
      G.variantRedone = 0;
    }
    if (id === 'rqvar') {
      G.save.rqNote = false;
      G.rqMigrated = 0;
    }
    if (id === 'wsnerf') {
      G.save.wsNote = false;
      G.whirlNerfed = 0;
    }
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
    if (ui.intro || menu.pause) return;

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
    if (!coach.summonPing && minionCount() > 0 && !G.save.tut.summon) summonPing(); // 自动召唤不经过 P.cast：看到召唤物就算第一次召唤
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
    el.title = $('title');
    el.tMenu = $('t-menu');
    el.tView = $('t-view');
    el.tContinue = $('t-continue');
    el.tSave = $('t-save');
    el.pause = $('pause');
    el.pMenu = $('p-menu');
    el.pView = $('p-view');

    const tabs = $('tabs');
    tabs.innerHTML = TABS.map(
      (t) => '<button type="button" tabindex="-1" class="tab" data-act="tab" data-tab="' + t[0] + '">' + t[1] + '<kbd>' + t[2] + '</kbd></button>'
    ).join('');
    el.tabBtns = Array.from(tabs.children);

    initHud();
    initEncHud();
    initPinHud();
    initQuestHud();
    initWorldUi();
    IC.warm(); // 图标趁空闲分批画好，第一次打开背包不再卡顿
    document.documentElement.style.setProperty('--relic', G.RELIC_COLOR); // 渊契的颜色只在 data.js 写一次，样式表里读 --relic

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
    // 天赋盘：滚轮缩放、拖动平移
    el.body.addEventListener('wheel', treeWheel, { passive: false });
    el.body.addEventListener('pointerdown', treePanDown);
    window.addEventListener('pointermove', treePanMove);
    window.addEventListener('pointerup', treePanUp);
    window.addEventListener('pointercancel', treePanUp);
    // 抢在 main.js 之前处理的按键：拖拽中 / 确认框开着时 Esc 只取消这一步，不关面板；开场卡片用回车或空格关闭
    window.addEventListener(
      'keydown',
      (e) => {
        const sp = ui.isOpen && ui.tab === 'map' && ui.sealPick;
        const dg = sp && /^(Digit|Numpad)([1-4])$/.exec(e.code);
        if (dg || (sp && e.code === 'Escape')) {
          // 择印面板：数字键 1–4 直接选（1 是素印），Esc 只收起面板
          if (dg) pickSeal(+dg[2] - 1);
          else ACT['seal-cancel']();
          e.stopPropagation();
          e.preventDefault();
        } else if (e.code === 'Escape' && (drag.on || ui.confirm)) {
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
    // 标题画面 / 暂停菜单：点击不是游戏输入，按钮不拿焦点
    window.addEventListener('keydown', onMenuKey, true);
    for (const m of [el.title, el.pause]) {
      m.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (e.target.closest('button')) e.preventDefault();
      });
      m.addEventListener('click', onMenuClick);
      m.addEventListener('input', onMenuInput);
      m.addEventListener('change', onMenuInput);
    }
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
        if (drag.on) dragTrack(drag.x, drag.y); // 拖拽中滚动（滚轮 / 贴边自动滚）：指针没动，底下的东西换了
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
      const now = performance.now();
      if (now - rx.moveAt > RET_IDLE && wui.retState !== 'off') retPing(now); // 停了一阵再动：提示一下准星在哪
      rx.moveAt = now;
    });
    // 鼠标不动、它下面的东西变了（面板关掉、提示卡收起）时浏览器会补发 mouseover：顺手更新准星的位置和「在不在画面上」
    document.addEventListener('mouseover', (e) => {
      ui.mouseX = e.clientX;
      ui.mouseY = e.clientY;
      ui.overCanvas = retOnCanvas(e.target);
      wui.ret.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
    });
    // 切回窗口：鼠标可能一直停在原处，提示一下准星在哪
    window.addEventListener('focus', () => {
      rx.want = true;
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
        if (ui.tab === 'tree') treeApply(); // 名字字号跟着面板尺寸重算
      }
    });
  }

  G.ui = {
    init,
    update,
    open,
    close,
    toggle,
    isOpen: () => ui.isOpen || ui.intro || menu.pause || menu.title || story.on, // 面板、开场卡片、暂停菜单、标题画面或开场故事开着：游戏暂停
    playStory,
    storyOn: () => story.on,
    refresh,
    toast,
    hurt,
    showHelp,
    showIntro,
    pause: openPause, // 暂停菜单（没有面板开着时才打开，返回是否打开了）
    paused: () => menu.pause,
    showTitle,
    titleReady,
    titleOn: () => menu.title,
    titleFrame,
    afterTitle: (f) => {
      menu.after = f;
    },
    onPickup,
    bigToast,
    bigToastReset,
    verdict, // 换装评估（只读）：{ badge, score, empty, lines } | null
    questDone,
    // 测试读：追踪条现在显示的字、显不显示、排队中的完成提示
    quest: () => ({ on: !!qh.vis, k: qh.k.textContent, goal: qh.goal.textContent, how: qh.how.textContent, alt: qh.alt.textContent, queued: qh.toastQ.slice() }),
    hints: () => ({ current: coach.cur ? coach.cur.id : null, state: coach.state, all: HINTS.map((h) => h.id), veteran: coach.vet, minShow: coach.minT, shownFor: coach.t }),
  };
})();
