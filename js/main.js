'use strict';
// 启动、输入、主循环、调试接口
(function () {
  const G = window.G;
  const W = G.world;

  // keys 以 KeyboardEvent.code 为键（KeyW / ArrowUp / Space ...），与键盘布局无关
  // tap：技能栏 5 个输入（左键 / 右键 / Q / E / R 武器技）的按键缓冲（秒），轻点一下也能在下一次可施法时放出来
  const input = (G.input = {
    keys: {},
    mouse: { x: window.innerWidth / 2, y: window.innerHeight / 2, wx: 0, wz: 0, b: [false, false, false] },
    tap: [0, 0, 0, 0, 0],
    tapDodge: 0, // 翻滚的输入缓冲：按下时滚不了（冷却、处决途中）就记下，能滚了立刻滚
    tapExec: 0, // 处决的输入缓冲
    alt: false, // 按住 Alt：展开地面掉落的名牌（界面层读取）
  });
  // 动作途中按下的输入会缓冲到「能出手」的那一刻：时长由 G.bufferTime 按手上的动作还剩多久来定
  const MOUSE_SLOT = { 0: 0, 2: 1 }; // 鼠标键 → 技能栏格子
  const PANEL_KEYS = { KeyI: 'inv', KeyG: 'skills', KeyP: 'tree', KeyM: 'map', KeyH: 'help' };
  const NO_SCROLL = { Space: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Tab: 1 };

  // keepAlt：面板开着时每帧都清一次输入，但 Alt 要留着（浮窗里「按住 Alt 查看详情」读它）
  function clearInput(keepAlt) {
    for (const k in input.keys) input.keys[k] = false;
    input.mouse.b[0] = input.mouse.b[1] = input.mouse.b[2] = false;
    input.tap[0] = input.tap[1] = input.tap[2] = input.tap[3] = input.tap[4] = 0;
    input.tapDodge = input.tapExec = 0;
    if (keepAlt !== true) input.alt = false;
  }

  // 按下技能栏的一格（0 左键 / 1 右键 / 2 Q / 3 E / 4 R）。召唤技能的格子：按一下切换它的「自动召唤」，
  // 按住 Shift 再按才是在准星处手动召唤一次（走正常的施放与缓冲）；其他技能照常记进缓冲
  function pressSlot(slot, shift) {
    const id = slot < 4 ? G.save.bar[slot] : null;
    const sk = id ? G.SKILLS[id] : null;
    if (sk && sk.kind === 'summon' && G.save.skills[id] && !shift) {
      G.toggleAutoSummon(id);
      return;
    }
    input.tap[slot] = G.bufferTime('cast');
  }
  G.pressSlot = pressSlot;

  function refreshMouseWorld() {
    const g = W.screenToGround(input.mouse.x, input.mouse.y);
    input.mouse.wx = g.x;
    input.mouse.wz = g.z;
  }

  function bindInput() {
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) return; // 浏览器快捷键照常工作
      if (G.ui.storyOn()) return; // 开场故事放着：按键归它（js/story.js 自己接）
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault(); // 不让 Alt 把焦点交给浏览器菜单
        input.alt = true; // 面板开着也记下：浮窗详情要用；名牌只在面板关着时展开（ui.js 的 syncLabels 自己判断）
        return;
      }
      if (e.altKey) e.preventDefault(); // 按住 Alt 看名牌时，移动 / 技能键照常生效，不触发浏览器的 Alt 组合键
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const code = e.code;
      if (NO_SCROLL[code]) e.preventDefault();

      if (PANEL_KEYS[code]) {
        if (!e.repeat) G.ui.toggle(PANEL_KEYS[code]);
        return;
      }
      if (code === 'Escape') {
        if (G.ui.isOpen()) G.ui.close();
        else if (!e.repeat) G.ui.pause(); // 没有面板开着：打开暂停菜单
        return;
      }
      if (G.ui.isOpen()) return; // 面板打开时不接受游戏输入

      input.keys[code] = true;
      if (e.repeat) return;
      if (code === 'Space') {
        // 能滚就立刻滚（挥砍的起手和收招都可以这样取消）；滚不了就先记下
        if (!G.dodge() && !G.player.dead) input.tapDodge = G.bufferTime('dodge');
      } else if (code === 'Digit1' || code === 'Numpad1') G.useFlask('life');
      else if (code === 'Digit2' || code === 'Numpad2') G.useFlask('mana');
      else if (code === 'KeyF') {
        // 够得着露出破绽的敌人就处决，否则拾取
        if (!G.tryExecute()) G.pickupNearest();
      }
      else if (code === 'KeyQ') pressSlot(2, e.shiftKey);
      else if (code === 'KeyE') pressSlot(3, e.shiftKey);
      else if (code === 'KeyR') pressSlot(4, e.shiftKey); // 武器技
    });

    window.addEventListener('keyup', (e) => {
      input.keys[e.code] = false;
      if (e.code === 'AltLeft' || e.code === 'AltRight') {
        e.preventDefault();
        input.alt = false;
      }
    });

    window.addEventListener('mousemove', (e) => {
      input.mouse.x = e.clientX;
      input.mouse.y = e.clientY;
    });

    // 只有落在画布上的按下才算游戏输入（HUD 上真正的按钮会自己接住事件）
    window.addEventListener('mousedown', (e) => {
      const t = e.target;
      const onCanvas = !t || t === document.body || t === document.documentElement || t.tagName === 'CANVAS';
      if (!onCanvas || G.ui.isOpen()) return;
      e.preventDefault();
      input.mouse.x = e.clientX;
      input.mouse.y = e.clientY;
      refreshMouseWorld();
      if (e.button === 0) {
        // 点在掉落名牌上：拾取，而不是施法
        const loot = W.lootLabelAt(e.clientX, e.clientY);
        if (loot) {
          G.pickup(loot);
          return;
        }
        // 点在没打开的宝箱上：打开（远了提示走近），也不施法（zones-polish）
        const chest = G.chestAt(input.mouse.wx, input.mouse.wz);
        if (chest) {
          G.clickChest(chest);
          return;
        }
        // 点在异兆的互动点上（祈坛、缚匣、拾烬客、烬核）：同宝箱
        const enc = G.encAt(input.mouse.wx, input.mouse.wz);
        if (enc) {
          G.clickEnc(enc);
          return;
        }
      }
      if (e.button >= 0 && e.button <= 2) input.mouse.b[e.button] = true;
      const slot = MOUSE_SLOT[e.button];
      if (slot !== undefined) pressSlot(slot, e.shiftKey);
    });

    window.addEventListener('mouseup', (e) => {
      if (e.button >= 0 && e.button <= 2) input.mouse.b[e.button] = false;
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', clearInput);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearInput();
    });
    window.addEventListener('beforeunload', () => G.persist());
  }

  // ---------- 模拟一步 ----------
  let saveT = 0;
  // raw 是真实时间；顿帧 / 慢动作把它缩成游戏时间 dt 后再推进各系统（定格的那几帧只更新镜头和飘字）
  function sim(raw) {
    const dt = raw * G.flowStep(raw);
    if (dt > 0) {
      G.state.time += dt;
      G.updatePlayer(dt, raw * G.flow.act);
      G.updateEnemies(dt);
      G.updateProjectiles(dt);
      G.updateTelegraphs(dt);
      W.terrainTick(dt); // 区域的定时机关（ZONE_TERRAIN[id].tick）
      G.updateLoot(dt);
      G.updateTimers(dt);
      G.updateEncounters(dt); // 异兆：懒生成、波次、计时
    }
    W.update(dt, raw);
    saveT += raw;
    if (saveT >= 10) {
      saveT = 0;
      G.persist();
    }
  }
  G.tick = sim;

  let last = 0;
  // 调试：暂停实时模拟（仍然渲染），让测试脚本用 step 精确推进。window.__simHold（只有测试会设，见 test/harness.mjs）：页面一打开就暂停，
  // 实时循环一帧模拟都不跑，同一个种子重载几次起点都一样
  let held = !!window.__simHold;
  function frame(now) {
    requestAnimationFrame(frame); // 先排下一帧：某一帧抛错时错误照常上报，循环不会悄悄停掉
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const open = G.ui.isOpen();
    G.state.paused = open;
    if (open) {
      clearInput(true); // 面板关掉后不会带着按住的键继续跑（Alt 除外）
      if (G.ui.titleOn()) G.ui.titleFrame(dt); // 标题画面：模拟照样不推进，只让区域的火光、飘尘动起来，镜头缓慢漂移
    } else {
      refreshMouseWorld();
      if (!held) sim(dt);
    }
    // 开场故事盖满屏幕的时候不画 3D（软件渲染的机器上省下整帧的开销；故事收尾淡出时照常画）
    if (!(G.story && G.story.opaque())) W.render();
    if (!G.ui.titleOn()) G.ui.update(); // 标题画面盖着 HUD，不用每帧刷新
  }

  // 标题画面开着、而且本地原本没有存档时，先不写存档：只是打开页面又关掉，下次不会凭空多出一个「继续游戏」。
  // 点了「新游戏」才放开（G.holdSave(false)）
  let holdSave = false;
  const persistRaw = G.persist;
  G.persist = () => (holdSave ? false : persistRaw());
  G.holdSave = (on) => {
    holdSave = !!on;
    return holdSave;
  };

  function boot() {
    const hadSave = G.hasSave();
    // 标题画面：index.html 开头已经按 ?play / window.__skipTitle / 一次性标记定好了（html 上有没有 title-on）
    const title = document.documentElement.classList.contains('title-on');
    try {
      window.sessionStorage.removeItem(G.PLAY_ONCE_KEY); // 「新游戏」重载后的一次性标记：用过就清掉
    } catch (err) {
      /* 存储不可用就算了 */
    }
    holdSave = title && !hadSave;
    const save = G.loadSave();
    // 首个区域的 CC0 素材包先开始下载（和下面的初始化同时进行），最多等 2.5 秒；等的时候盖一层「正在载入场景…」
    const pre = W.preloadZone(save.lastZone, 2500);
    W.init();
    G.ui.init();
    if (title) G.ui.showTitle(false);
    G.player.ent = W.makePlayer();
    G.computeStats();
    G.player.life = G.player.maxLife;
    G.player.mana = G.player.maxMana;
    // 先等首个区域的 CC0 素材包（失败或超时就先用程序化外观进场，右上角提示「正在载入场景…」，素材到了再换上）
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      bindInput();
      // 余烛殿（D5）：存档里挂着正在打的熄烛者就回余烛殿（首领满血，魂灯数照存档）；否则渊印：这一次进区的印接着用（区域 / 层级对不上就是素印）
      if (save.run && save.run.pin) G.enterPinnacle(save.run.pin.tier, 'resume');
      else G.enterZone(save.lastZone, save.tier, 'resume');
      W.update(0); // 首次运行会先停在开场卡片：先把镜头和灯光摆到玩家身上
      if (!save.seenHelp) {
        // 开场卡片讲的是操作，所有角色共用一份「看过」（G.helpSeenGlobal）：别的角色看过，新角色只放开场故事、不再弹卡片
        const helpSeen = !!(G.helpSeenGlobal && G.helpSeenGlobal());
        const intro = () => {
          save.seenHelp = true;
          G.persist();
          if (!helpSeen) G.ui.showIntro();
        };
        // 开场故事：新角色第一次进游戏先放一遍，放完 / 跳过再弹开场卡片。老存档早就看过开场卡片（seenHelp），不会放；
        // 测试的 window.__skipTitle、地址带 ?play 也不放（测试要看故事时另设 window.__story）
        const story = !save.seenStory && (!window.__skipTitle || window.__story) && !/[?&]play\b/.test(location.search);
        const first = () => {
          if (!story) return intro();
          G.ui.playStory(() => {
            G.save.seenStory = true;
            intro();
          });
        };
        if (G.ui.titleOn()) G.ui.afterTitle(first); // 开场卡片等离开标题画面再弹
        else first();
      }
      if (G.ui.titleOn()) G.ui.titleReady(); // 区域建好了：「继续游戏」「新游戏」可以点了
      last = performance.now();
      requestAnimationFrame(frame);
    };
    pre.then(start, start);
  }

  G.PLAY_ONCE_KEY = 'cinder-abyss-play-once'; // 和 index.html 开头的判断用同一个键

  // ---------- 自动化测试用的调试接口 ----------
  const refreshUi = () => {
    if (G.ui.isOpen()) G.ui.refresh();
  };

  G.debug = {
    // 暂停 / 恢复实时循环里的模拟（渲染与 HUD 照常），返回当前状态
    hold(on) {
      held = on === undefined ? true : !!on;
      if (held) clearInput();
      return held;
    },
    // 远程武器的量表直接设成 v（缺省填满）：kind 'heat' / 'focus'，缺省取手里远程武器的那一种
    gauge(v, kind) {
      const rw = G.rangedWeapon();
      const k = kind || (rw ? rw.gauge.kind : 'heat');
      G.player.gauge[k] = G.clamp(v === undefined ? G.RANGED.max : v, 0, G.RANGED.max);
      return G.player.gauge[k];
    },
    // 同步推进模拟（1/60 秒一步，不渲染）
    step(seconds) {
      const n = Math.max(1, Math.round((seconds || 0) * 60));
      for (let i = 0; i < n; i++) sim(1 / 60);
      return G.state.time;
    },
    god(on) {
      G.player.god = on === undefined ? true : !!on;
      return G.player.god;
    },
    give(curId, n) {
      if (!G.CURRENCY[curId]) return false;
      G.save.cur[curId] = (G.save.cur[curId] || 0) + (n === undefined ? 1 : n);
      refreshUi();
      return G.save.cur[curId];
    },
    // baseIdx（可选）：指定基底（武器 0..13 = 刃 / 长杖 / 短杖 / 双匕 / 战锤 / 鹰眼长弓 / 太刀 / 魂幡 / 转膛机炮 / 焚炉喷枪 / 追猎弓 / 符文弓 / 烬铸左轮 / 冰弓）；ilvl（可选）：指定物品等级
    // 烬铸武器：rarity 传 3，slot 传烬铸 id（jinduan / sanxiang / wanhun / rongxin / jinyu；不认识时按 baseIdx 找，再不行随机一把），
    // baseIdx 位置可以改传完美度（0..1，每条词缀行都取区间里这个位置）
    giveItem(rarity, slot, baseIdx, ilvl) {
      if (G.save.bag.length >= G.BAG_SIZE) return null;
      if (!(ilvl > 0)) ilvl = G.state.zone ? G.state.zone.level : G.save.level;
      if (rarity === 3) {
        let id = G.UNIQUES[slot] ? slot : G.UNIQUE_IDS.find((u) => G.UNIQUES[u].base === baseIdx);
        if (!id) id = G.pick(G.UNIQUE_IDS);
        const q = typeof baseIdx === 'number' && baseIdx >= 0 && baseIdx <= 1 && G.UNIQUES[slot] ? baseIdx : undefined;
        const u = G.rollUnique(id, Math.max(1, ilvl), q);
        G.save.bag.push(u);
        G.noteUnique(u);
        refreshUi();
        return u;
      }
      // 渊契：rarity 传 4，slot 传渊契 id（不认识时随机一件普通渊契），baseIdx 位置同样可以改传完美度
      if (rarity === 4) {
        const id = G.RELICS[slot] ? slot : G.pick(G.RELIC_IDS);
        const q = typeof baseIdx === 'number' && baseIdx >= 0 && baseIdx <= 1 && G.RELICS[slot] ? baseIdx : undefined;
        const r = G.rollRelic(id, Math.max(1, ilvl), q);
        G.save.bag.push(r);
        G.noteRelic(r);
        if (G.icons && G.icons.warmRelic) G.icons.warmRelic(id);
        refreshUi();
        return r;
      }
      const item = G.rollItem(Math.max(1, ilvl), rarity || 0, slot, baseIdx);
      G.save.bag.push(item);
      refreshUi();
      return item;
    },
    learnAll() {
      const save = G.save;
      for (const id of G.GEM_SKILLS) { // 武器技跟着武器走，不用学
        if (!save.skills[id]) save.skills[id] = G.gemFloor ? G.gemFloor() : 1;
        if (!Array.isArray(save.sockets[id])) save.sockets[id] = [null, null, null];
        if (save.bar.indexOf(id) < 0) {
          const free = G.freeBarSlot ? G.freeBarSlot() : save.bar.indexOf(null);
          if (free >= 0) save.bar[free] = id;
        }
      }
      for (const id of Object.keys(G.SUPPORTS)) {
        if (save.supports.indexOf(id) < 0) save.supports.push(id);
      }
      G.computeStats();
      G.persist();
      refreshUi();
      return true;
    },
    setLevel(n) {
      const P = G.player;
      G.save.level = G.clamp(Math.floor(n) || 1, 1, G.MAX_LEVEL);
      G.save.xp = 0;
      if (G.syncGemLevels) G.syncGemLevels();
      G.computeStats();
      P.life = P.maxLife;
      P.mana = P.maxMana;
      G.persist();
      refreshUi();
      return G.save.level;
    },
    killAll() {
      let n = 0;
      for (const e of G.state.enemies.slice()) {
        if (e.dead || e.isBoss) continue;
        G.killEnemy(e);
        n++;
      }
      return n;
    },
    tpBoss() {
      const P = G.player;
      const zone = G.state.zone;
      const bp = zone.bossPos;
      // 站在竞技场内离中心 7 的位置（zone.arena.tp：场地中心朝门；legacy 是朝起点一侧），足以唤醒首领
      let x = zone.arena.tp.x;
      let z = zone.arena.tp.z;
      if (!W.walkable(x, z, 0.6)) {
        x = bp.x;
        z = bp.z + 7;
      }
      P.x = x;
      P.z = z;
      P.cast = null;
      P.roll.t = 0;
      P.face = Math.atan2(bp.x - x, bp.z - z);
      P.drawFace = P.face;
      W.setEnt(P.ent, P.x, P.z, P.face);
      return { x, z };
    },
    // 固定之后进区用的布局种子（传 null 恢复每次随机）；返回当前固定的种子
    zoneSeed(n) {
      return W.pinZoneSeed(n);
    },
    // 异兆：在当前区域按给的种类重新放（找不到点位的跳过），返回 G.state.enc
    enc(kinds) {
      return G.rollEncounters(G.state.zone, G.state.tier, kinds || G.ENC_IDS.slice());
    },
    // 当前区域布局的摘要：种子、房间、连接、关键路径、怪群槽位、宝箱、首领场地、网格大小
    layout() {
      return W.layoutInfo();
    },
    // 在 (x, z) 放一个宝箱（缺省：玩家前方 3 m），返回它；走过去就会打开
    chest(x, z) {
      const P = G.player, zone = G.state.zone;
      if (x === undefined) {
        x = P.x + Math.sin(P.face) * 3;
        z = P.z + Math.cos(P.face) * 3;
      }
      const c = { x, z, room: W.roomAt(x, z), ang: 0, open: false };
      zone.chests.push(c);
      W.refreshChests();
      return c;
    },
    // 传送到第 i 个房间的 core 中心（core 整块可走）
    tpRoom(i) {
      const P = G.player;
      const rm = G.state.zone.rooms[i | 0];
      if (!rm) return null;
      P.x = rm.core.x;
      P.z = rm.core.z;
      P.cast = null;
      P.roll.t = 0;
      W.setEnt(P.ent, P.x, P.z, P.face);
      return { x: P.x, z: P.z, kind: rm.kind };
    },
    summary() {
      const P = G.player;
      const s = G.state;
      const save = G.save;
      const r2 = (v) => Math.round(v * 100) / 100;
      let alive = 0, awake = 0, elites = 0, nearest = null, nd = Infinity;
      for (const e of s.enemies) {
        if (e.dead) continue;
        alive++;
        if (e.awake) awake++;
        if (e.elite) elites++;
        const d = Math.hypot(e.x - P.x, e.z - P.z);
        if (d < nd) {
          nd = d;
          nearest = { type: e.type, name: e.name, x: r2(e.x), z: r2(e.z), hp: r2(e.hp), maxHp: r2(e.maxHp), dist: r2(d), isBoss: !!e.isBoss, elite: !!e.elite };
        }
      }
      const b = s.boss;
      return {
        time: r2(s.time),
        paused: !!s.paused,
        zone: s.zone ? { idx: s.zoneIdx, id: s.zone.def.id, name: s.zone.def.name, level: s.zone.level, tier: s.tier } : null,
        player: {
          x: r2(P.x), z: r2(P.z), face: r2(P.face), life: r2(P.life), maxLife: P.maxLife, mana: r2(P.mana), maxMana: P.maxMana,
          level: save.level, xp: r2(save.xp), dead: P.dead, casting: P.cast ? P.cast.id : null, rolling: P.roll.t > 0,
          comboStep: P.combo.step, chain: P.chain.n, executing: !!P.exec,
          flask: { life: r2(P.flask.life), mana: r2(P.flask.mana) }, god: P.god,
        },
        enemies: { total: s.enemies.length, alive, awake, elites, nearest },
        boss: b ? { kind: b.bossKind, name: b.name, x: r2(b.x), z: r2(b.z), hp: r2(b.hp), maxHp: r2(b.maxHp), awake: !!b.awake, dead: !!b.dead, poise: r2(b.poise), poiseMax: r2(b.poiseMax), broken: r2(b.brokenT) } : null,
        flow: { stop: r2(G.flow.stop), slow: r2(G.flow.slow), k: r2(G.flow.k) },
        stats: Object.assign({}, s.stats),
        loot: {
          count: s.loot.length,
          list: s.loot.map((l) => ({ kind: l.kind, label: l.label, x: r2(l.x), z: r2(l.z) })),
        },
        projectiles: s.projectiles.length,
        telegraphs: s.telegraphs.length,
        timers: s.timers.length,
        portal: s.portal ? { x: r2(s.portal.x), z: r2(s.portal.z), armed: s.portal.armed } : null,
        bag: save.bag.length,
        cur: Object.assign({}, save.cur),
        skills: Object.assign({}, save.skills),
        supports: save.supports.slice(),
        bar: save.bar.slice(),
        weaponSkill: G.weaponSkill(),
        ranged: G.rangedWeapon(),
        basic: G.weaponBasic ? G.weaponBasic() : null, // 右键此刻的武器普攻
        rbuff: G.player.rbuff ? { id: G.player.rbuff.id, t: r2(G.player.rbuff.t) } : null,
        rstate: G.player.rstate ? { id: G.player.rstate.id, t: r2(G.player.rstate.t) } : null,
        weapon: save.equip.weapon ? G.weaponStats(save.equip.weapon) : null,
        passives: G.passivePoints(),
      };
    },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
