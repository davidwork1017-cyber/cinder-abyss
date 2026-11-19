'use strict';
// 核心玩法：存档、属性、技能、伤害、投射物、预警圈、掉落、成长
(function () {
  const G = window.G;

  const SAVE_KEY = 'cinder-abyss-save-v1';
  const BAG_SIZE = (G.BAG_SIZE = 40);
  const MAX_LEVEL = (G.MAX_LEVEL = 60);
  // 宝石等级上限：成长下限 round(角色等级 × 0.75) 一直涨到满级 60 时的 45（改版前 20 级封顶，角色 27 级以后宝石就不再变强）
  const MAX_GEM_LEVEL = (G.MAX_GEM_LEVEL = 45);
  const BLANK_MAX = 99; // 无铭技能宝石最多攒这么多颗（存档读入时截断）
  const PLAYER_PAD = 0.5; // 玩家与墙的距离
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const TYPES = G.TYPES;
  const GEM_COLOR = '#3fe0c8';
  const SUP_COLOR = '#ffffff';
  if (G.syncUniqueBosses) G.syncUniqueBosses(); // data.js 里首领表在烬铸表之后才定义：到这里再把「首领 → 烬铸」对一遍

  // ---------- 小工具 ----------
  function angDiff(a, b) {
    let d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }
  const hexOf = (css) => parseInt(css.slice(1), 16);
  const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

  // 带节流的提示，避免同一条消息刷屏
  const toastAt = {};
  function toast(msg, color, key, gapMs) {
    if (key) {
      const now = Date.now();
      if (now - (toastAt[key] || 0) < (gapMs || 1500)) return;
      toastAt[key] = now;
    }
    G.ui.toast(msg, color);
  }

  // ---------- 运行时状态（对象本身永不替换，其他模块可以安全持有引用） ----------
  const state = (G.state = {
    time: 0, paused: false, zone: null, zoneIdx: 0, tier: 0,
    enemies: [], projectiles: [], telegraphs: [], loot: [], timers: [],
    boss: null, portal: null,
    hover: null, // 准星正指着的敌人（界面层写入；world 据此不重复画名字）
    // 召唤物（minions.js 维护）：{ kind, skill, ent, x, z, hp, maxHp, dead, target, atkT, tauntCd, tauntCdMax, ... }
    minions: [],
    // 集火目标：玩家最近一次亲手打中的敌人，focusT 秒后失效（召唤物优先攻击它）
    focus: null, focusT: 0,
    // 战斗统计（新手提示与测试读取）：命中 / 暴击 / 终结技命中 / 击破 / 处决 / 击杀
    stats: { hits: 0, crits: 0, finishers: 0, breaks: 0, execs: 0, kills: 0 },
  });

  const P = (G.player = {
    x: 0, z: 0, face: 0, drawFace: 0,
    life: 100, mana: 60, maxLife: 100, maxMana: 60, armour: 0,
    res: { fire: 0, cold: 0, light: 0 },
    speedMult: 1, moveSpeed: 7.2, lifeRegen: 0, manaRegen: 4,
    S: {}, cast: null, cds: {}, cdMax: {}, auraT: {}, // auraT：每个光环距离下一次脉冲的秒数
    roll: { t: 0, cd: 0, cdMax: 0.9, dx: 0, dz: 1 },
    iframe: 0, flask: { life: 3, mana: 3 },
    hot: { life: null, mana: null }, // 药剂的持续回复 {left, rate}
    dead: false, deadT: 0, moving: false, ent: null, god: false, dustT: 0,
    combo: { step: 0, t: 0, id: null }, // 连段：下一次近战出第几段（0 起）；t 归零则从头再来；id 这串连段属于哪一招（换了招 / 换了武器的普攻就从头来）
    chain: { n: 0, t: 0, best: 0 }, // 连击计数：连续命中的次数，t 秒内没有新的命中就清零
    exec: null, // 正在进行的处决 { e, t, x0, z0, hit }
    // 远程武器（见 G.RANGED）：gauge 量表（热度 / 专注各自记着，换枪换弓不清零）；heatIdle / focusIdle 距离上次开火 / 命中的秒数
    gauge: { heat: 0, focus: 0, heatIdle: 99, focusIdle: 99 },
    // gun：枪械与弓的出手状态。spin 机炮枪管转速（0..1）、ramp 转满后连续开火的秒数、ammo 左轮弹仓、reloadT 装填剩余秒数、
    // cdT 距离下一发最早能出手的秒数（轻点也快不过射速）、hitT 距离上次普攻命中的秒数、cycle 符文弓轮到的元素、emberT 喷枪下一团余烬
    gun: { spin: 0, ramp: 0, ammo: 6, reloadT: 0, cdT: 0, hitT: 99, cycle: 0, emberT: 0, firing: false },
    rbuff: null, // 弓的专注技增益 { id, t, dur }
    rstate: null, // 乱射这类脱离施放系统、不会被打断的持续效果 { id, t, dur, nextT, i, ctx }
    relic: {}, // 身上渊契的机制：{ 渊契 id: true, any: 至少一件 }（computeStats 里由 G.relicSync 汇总，见「渊契」一节）
  });

  // ---------- 时间流：顿帧与慢动作 ----------
  // 两者都实现成「游戏时间倍率」：主循环每帧先问一次 G.flowStep(真实 dt)，再用缩放后的 dt 推进所有系统，
  // 所以计时器、预警圈、冷却、动作之间不会错位；面板打开时主循环不推进，顿帧 / 慢动作也跟着停住。
  // flow.act：只算顿帧的倍率（0 = 定格）。处决的时间轴按它走——世界放慢时玩家这一击照常利落。
  const flow = (G.flow = { stop: 0, slow: 0, slowDur: 0, slowK: 1, k: 1, act: 1 });
  G.flowStep = function (raw) {
    let act = 1;
    if (flow.stop > 0) {
      if (flow.stop >= raw) {
        flow.stop -= raw;
        act = 0;
      } else {
        act = raw > 0 ? (raw - flow.stop) / raw : 0; // 顿帧在这一帧中途结束：剩下的时间照常推进
        flow.stop = 0;
      }
    }
    let k = 1;
    if (flow.slow > 0) {
      const out = flow.slowDur * 0.4; // 最后 40% 的时间里渐渐回到正常速度
      k = flow.slow >= out ? flow.slowK : flow.slowK + (1 - flow.slowK) * (1 - flow.slow / out);
      flow.slow -= raw * act;
      if (flow.slow < 1e-6) flow.slow = 0;
    }
    flow.act = act;
    flow.k = act * k;
    return flow.k;
  };
  // 顿帧：整个世界定格 ms 毫秒（多次触发取最长的，不叠加）
  G.hitStop = function (ms) {
    flow.stop = Math.min(0.16, Math.max(flow.stop, ms / 1000));
  };
  // 慢动作：接下来 sec 秒（真实时间）里游戏时间按 k 倍流逝
  G.slowMo = function (k, sec) {
    flow.slowK = G.clamp(k, 0.05, 1);
    flow.slow = flow.slowDur = sec;
  };
  function flowReset() {
    flow.stop = flow.slow = 0;
    flow.k = flow.act = 1;
  }
  G.BUFFER = 0.3; // 输入缓冲的下限（秒）：动作途中按下的攻击 / 技能 / 翻滚 / 处决，在这段时间内一旦能出手就出手
  const BUFFER_PAD = 0.12; // 缓冲至少比「手上的动作还要多久才能接下一个」多出这么久
  const BUFFER_MAX = 0.85; // 封顶：再长的动作，太早按下的输入也不会一直挂着

  // =====================================================================
  // 存档
  // =====================================================================
  G.newSave = function () {
    const cur = {};
    for (const id of G.CUR_IDS) cur[id] = 0;
    cur.dust = 2;
    // 起手武器和改版前一样：刃 / 长杖 / 短杖随机一把普通的 1 级武器（只在原来的三种里挑）。
    // 武器伤害决定攻击技能（起手的裂石击）的伤害，所以起手这一把的基础伤害不看基底：按平均成色的 1 级刃（8–12）
    // 折成同样的武器秒伤（除以攻速），每个新角色的裂石击都和改版前一样，杖类起手也不会弱四成
    const start = G.rollItem(1, 0, 'weapon', G.randInt(0, 2));
    const ref = G.weaponBaseDmg(0, 1);
    const aps = G.BASES.weapon[start.baseIdx].aps;
    start.wbase = [Math.round(ref[0] / aps), Math.round(ref[1] / aps)];
    G.refreshWeapon(start);
    return {
      // gv：成长版本。2 = 宝石 / 武器 / 词缀阶不再在 20 / 27 / 24 封顶、天赋盘扩大之后的存档
      v: 1, gv: 2, level: 1, xp: 0, bag: [], equip: { weapon: start }, cur,
      // 裂石击删除之后：起手只学掷焰、放在左键；右键是手里武器的普攻（刃的连招 / 杖的灵弹 / 短杖的疾咒），技能栏的右键格（下标 1）一直空着
      skills: { ember: 1 }, supports: [],
      sockets: { ember: [null, null, null], [G.BASIC_CARD]: [null, null, null] },
      bar: ['ember', null, null, null],
      // 右键固定是武器普攻：旧存档右键上的技能读档时挪到第一个空格（左键 / Q / E）；三格都满时收在这里，
      // 技能页上标着「收起」，绑到任意一格就取出来（见 sanitize、syncRanged）。镶着的辅助跟着技能走（save.sockets 按技能 id 记），不会丢
      rmbKeep: null,
      bowMig: false, // 读档时把旧长弓改成了鹰眼长弓、「远程改版」提示还没看过（见 sanitize）
      passives: ['start'], cleared: {}, bossKills: {},
      tier: 0, maxTier: 0, lastZone: 0,
      // 选项：自动拾取普通物品 / 折叠普通物品的名牌 / 拾取时自动分解普通物品 / 一键分解是否包含魔法物品
      // quality：画质档位 high / mid / low（世界层读取，见 G.world.setQuality）；auto = 玩家还没选过，每次启动按设备推断，掉帧时自动降档
      opts: { autoWhite: false, hideNormal: false, autoSalvage: false, salvageMagic: false, quality: 'auto' },
      seenHelp: false,
      tut: {}, // 已经看过的新手提示：{ 提示 id: 1 }（界面层维护）
      blankGems: [], // 手里的无铭技能宝石：每颗的等级，从高到低排
      autoSummon: autoSummonDefaults(), // 召唤技能的「自动召唤」开关：{ 技能 id: true / false }，默认关
      // 烬铸图鉴：found 拾到过的烬铸武器 { id: true }，best 见过的最高完美度 { id: 0..100 }，
      // pity 各首领（层级 1 起）连续多少次没掉它的武器 { 首领: 次数 }
      uniq: { found: {}, best: {}, pity: {} },
      // 渊契图鉴：格式同 uniq；pity 按保底的键计（首领 / 异兆来源按渊契 id，烈印来源按 'seal'）
      relic: { found: {}, best: {}, pity: {} },
      // 刻式：variants 选了的刻式 { 技能 id: 'a' | 'b' }（没有的就是原式）；variantFree 已经用过免费那一次的技能 { 技能 id: true }
      variants: {}, variantFree: {},
    };
  };
  function autoSummonDefaults() {
    const o = {};
    for (const id of Object.keys(G.SKILLS)) if (G.SKILLS[id].kind === 'summon') o[id] = false;
    return o;
  }

  // G.save 始终是同一个对象：换存档时原地覆盖内容
  function setSave(s) {
    G.saveEpoch = (G.saveEpoch || 0) + 1; // 换了一份存档（读档 / 删档）：界面层据此重新判断「是不是老角色」
    if (G.clearMinions) G.clearMinions(); // 召唤物不进存档：换了角色就散掉
    if (G.save && G.save !== s) {
      for (const k of Object.keys(G.save)) delete G.save[k];
      Object.assign(G.save, s);
    } else {
      G.save = s;
    }
    G.syncGemLevels();
    G.applyVariants(); // 刻式：按这份存档重新拼 G.SKILLS
    return G.save;
  }

  // 已学会的技能宝石随角色成长：等级不低于「角色等级 × 0.75」（和掉落宝石的等级曲线一致）。
  // 否则宝石只能靠捡到更高等级的同名宝石来升，十几个技能里很难刷到想要的那个；召唤物不吃装备伤害，更依赖宝石等级。
  // 返回这次被抬高的技能 id 列表
  G.gemFloor = function () {
    return G.clamp(Math.round((G.save.level || 1) * 0.75), 1, MAX_GEM_LEVEL);
  };
  G.syncGemLevels = function () {
    const save = G.save;
    const up = [];
    if (!save || !save.skills) return up;
    const t = G.gemFloor();
    for (const id of Object.keys(save.skills)) {
      if (G.SKILLS[id] && save.skills[id] < t) {
        save.skills[id] = t;
        up.push(id);
      }
    }
    if (up.length && G.applyVariants) G.applyVariants(); // 存档里记着、宝石刚到解锁等级的刻式这时生效
    return up;
  };

  const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  // 存档里的物品必须字段齐全、词缀都认识，否则 itemStats / itemLines 会直接抛错
  const isItem = (it) =>
    isObj(it) && G.SLOTS.indexOf(it.slot) >= 0 && typeof it.uid === 'string' &&
    typeof it.name === 'string' && typeof it.baseName === 'string' &&
    (it.rarity === 0 || it.rarity === 1 || it.rarity === 2 || (it.rarity === 3 && it.slot === 'weapon' && typeof it.uq === 'string' && !!G.UNIQUES[it.uq]) ||
      (it.rarity === 4 && typeof it.rq === 'string' && !!G.RELICS[it.rq] && it.slot === G.RELICS[it.rq].slot)) && isNum(it.ilvl) &&
    (it.armour === undefined || isNum(it.armour)) &&
    (it.imp == null || (isObj(it.imp) && typeof it.imp.stat === 'string' && isNum(it.imp.v))) &&
    Array.isArray(it.affixes) &&
    it.affixes.every((a) => isObj(a) && !!G.AFFIX_BY_ID[a.id] && isNum(a.v) && a.tier >= 0 && a.tier < G.TIER_ILVL.length && a.tier === Math.floor(a.tier));
  const toInt = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v) ? G.clamp(Math.floor(v), lo, hi) : def);

  // 物品的基底下标修成合法值；武器补齐伤害字段。旧存档的武器没有 wbase：按基底取平均成色推出来（确定、公平，不会是 0）。
  // 改版前物品等级不影响伤害，老角色手里常常还是低等级的武器：推导时的等级取 max(物品等级, 角色等级)（再受 WEAPON_LVL_CAP 限制），
  // 不让攻击流派的老角色一读档就掉一大截。dmg / aps 总是由 wbase 和本地词缀重新推导（存档里写的不算数）
  // oldGrowth：存档来自成长改版之前（没有 gv 字段）。那时武器伤害到物品等级 27 就封顶，物品等级更高的武器
  // 把 wbase 按「现在这个物品等级的成长 ÷ 27 级的成长」放大一次（成色不变），老角色手里的高等级武器不吃亏
  function fixItem(it, charLvl, oldGrowth) {
    if (it.rarity === 3) fixUnique(it);
    if (it.rarity === 4) fixRelic(it);
    const bases = G.BASES[it.slot];
    if (!(it.baseIdx >= 0 && it.baseIdx < bases.length) || it.baseIdx !== Math.floor(it.baseIdx)) it.baseIdx = 0;
    // 远程改版：长弓（下标 5）改成鹰眼长弓。旧名字换成同阶的新名字，普通 / 魔法物品的显示名跟着重拼（稀有的随机名不动）
    if (it.slot === 'weapon' && it.baseIdx === 5) {
      const oi = G.BOW_OLD_NAMES.indexOf(it.baseName);
      if (oi >= 0) {
        it.baseName = bases[5].names[oi];
        if (it.rarity < 2) G.updateItemName(it);
        G.bowMigrated = (G.bowMigrated || 0) + 1; // 界面层据此提示一次「长弓改成了鹰眼长弓」
      }
    }
    // 冰弓改名：旧存档里的「烬铸长弓」换成同阶的「凛晶长弓」，普通 / 魔法物品的显示名跟着重拼（按基底的 type 认，不看下标）
    if (it.slot === 'weapon' && bases[it.baseIdx] && bases[it.baseIdx].type === 'emberbow' && bases[it.baseIdx].names.indexOf(it.baseName) < 0) {
      const oi = G.EMBERBOW_OLD_NAMES.indexOf(it.baseName);
      if (oi >= 0 && bases[it.baseIdx].names[oi]) {
        it.baseName = bases[it.baseIdx].names[oi];
        if (it.rarity < 2) G.updateItemName(it);
      }
    }
    if (it.slot === 'weapon') {
      const wb = it.wbase;
      const ok = Array.isArray(wb) && wb.length === 2 && isNum(wb[0]) && isNum(wb[1]) && wb[0] >= 1 && wb[1] >= wb[0] && wb[1] <= 1e6;
      if (ok) {
        it.wbase = [Math.round(wb[0]), Math.round(wb[1])];
        const cap0 = G.WEAPON_LVL_OLD_CAP;
        if (oldGrowth && it.ilvl > cap0) {
          const k = G.weaponLvlK(it.ilvl) / G.weaponLvlK(cap0);
          it.wbase = [Math.max(1, Math.round(wb[0] * k)), Math.max(Math.round(wb[0] * k) + 1, Math.round(wb[1] * k))];
        }
      } else {
        // 更早的存档（还没有武器伤害字段）：照旧按 max(物品等级, 角色等级) 推导，角色等级那一项按改版前的 27 封顶
        it.wbase = G.weaponBaseDmg(it.baseIdx, Math.max(it.ilvl, Math.min(charLvl || 1, G.WEAPON_LVL_OLD_CAP)));
        G.weaponMigrated = true; // 界面层据此提示一次「攻击技能改为吃武器伤害」
      }
      G.refreshWeapon(it);
    }
    return it;
  }

  // 烬铸武器：基底、名字、词缀行都按定义修回来；数值夹回各自的区间（缺的行取区间中点）。武器伤害照常由下面的 wbase 推导
  function fixUnique(it) {
    const U = G.UNIQUES[it.uq];
    it.ilvl = G.clamp(Math.round(it.ilvl), 1, 999);
    it.baseIdx = U.base;
    it.name = U.name;
    const base = G.BASES.weapon[U.base];
    if (base.names.indexOf(it.baseName) < 0) it.baseName = base.names[Math.min(G.nameTier(it.ilvl), base.names.length - 1)];
    const tier = G.clamp(G.TIER_ILVL.filter((l) => l <= it.ilvl).length - 1, 0, G.TIER_ILVL.length - 1);
    it.affixes = U.lines.map((ln, i) => {
      const r = G.uniqueLineRange(it.uq, it.ilvl, i);
      const old = it.affixes.find((a) => a.id === ln.id);
      const v = old ? G.clamp(Math.round(old.v), r[0], r[1]) : Math.round((r[0] + r[1]) / 2);
      return { id: ln.id, tier, v };
    });
    it.armour = 0;
    return it;
  }

  // 渊契：基底、名字、词缀行按定义修回来，数值夹回各自的区间（缺的行取区间中点）；护甲 / 隐含属性照旧（随基底和物品等级）
  function fixRelic(it) {
    const R = G.RELICS[it.rq];
    it.ilvl = G.clamp(Math.round(it.ilvl), 1, 999);
    it.baseIdx = R.base;
    it.name = R.name;
    const base = G.BASES[R.slot][R.base];
    if (base.names.indexOf(it.baseName) < 0) it.baseName = base.names[Math.min(G.nameTier(it.ilvl), base.names.length - 1)];
    const tier = G.clamp(G.TIER_ILVL.filter((l) => l <= it.ilvl).length - 1, 0, G.TIER_ILVL.length - 1);
    it.affixes = R.lines.map((ln, i) => {
      const r = G.relicLineRange(it.rq, it.ilvl, i);
      const old = it.affixes.find((a) => a.id === ln.id);
      const v = old ? G.clamp(Math.round(old.v), r[0], r[1]) : Math.round((r[0] + r[1]) / 2);
      return { id: ln.id, tier, v };
    });
    if (!base.armour) it.armour = 0;
    if (!base.imp) it.imp = null;
    return it;
  }

  // 从 start 出发，在给定节点集合内能走到的节点
  function reachable(ids) {
    const set = new Set(ids);
    const seen = new Set(['start']);
    const stack = ['start'];
    while (stack.length) {
      const node = G.TREE[stack.pop()];
      for (const l of node.links) {
        if (set.has(l) && !seen.has(l)) {
          seen.add(l);
          stack.push(l);
        }
      }
    }
    return seen;
  }

  // 把读到的存档修成合法形状（字段缺失、被改动、旧数据都不该让游戏崩掉）
  function sanitize(raw) {
    G.weaponMigrated = false;
    G.growthMigrated = null;
    G.bowMigrated = 0;
    G.rmbMigrated = null; // 武器普攻改版：右键上的技能挪去了哪（见下面「右键固定是武器普攻」）
    G.cleaveRefund = null; // 裂石击退成的无铭宝石
    G.newZoneNotice = G.zoneNoticeFor(raw); // 第五区上线前打通过烬渊深处的老存档：界面层提示一次新区域
    const d = G.newSave();
    if (!isObj(raw) || raw.v !== 1) return d;
    const s = d;

    s.level = toInt(raw.level, 1, MAX_LEVEL, 1);
    s.xp = typeof raw.xp === 'number' && isFinite(raw.xp) && raw.xp > 0 ? raw.xp : 0;
    const oldGrowth = !(raw.gv >= 2); // 成长改版之前的存档（见 fixItem、下面的天赋）
    // 改版前升级所需经验是多项式（G.xpNeedOld）：等级不动，经验条的进度（百分比）原样换算到新的升级所需经验上，
    // 不让高等级的老角色一读档经验条就从六成掉到几个百分点
    if (oldGrowth && s.level < MAX_LEVEL && s.xp > 0) s.xp = Math.min(0.999, s.xp / G.xpNeedOld(s.level)) * G.xpNeed(s.level);
    s.bag = Array.isArray(raw.bag) ? raw.bag.filter(isItem).map((it) => fixItem(it, s.level, oldGrowth)) : [];
    if (isObj(raw.equip)) {
      s.equip = {};
      for (const slot of G.SLOTS) {
        const it = raw.equip[slot];
        if (isItem(it) && it.slot === slot) s.equip[slot] = fixItem(it, s.level, oldGrowth);
      }
    }
    if (isObj(raw.cur)) {
      for (const id of G.CUR_IDS) s.cur[id] = toInt(raw.cur[id], 0, 1e9, 0);
    }

    if (isObj(raw.skills)) {
      const skills = {};
      for (const id of Object.keys(raw.skills)) {
        if (G.SKILLS[id] && !G.SKILLS[id].weaponOnly) skills[id] = toInt(raw.skills[id], 1, MAX_GEM_LEVEL, 1);
      }
      if (Object.keys(skills).length) s.skills = skills;
    }
    s.supports = [];
    if (Array.isArray(raw.supports)) {
      for (const id of raw.supports) {
        if (G.SUPPORTS[id] && s.supports.indexOf(id) < 0) s.supports.push(id);
      }
    }
    // 镶嵌：每个已学技能 3 个孔；辅助必须已拥有、适配，且全局只能出现一次
    const used = new Set();
    const rawSockets = isObj(raw.sockets) ? raw.sockets : {};
    s.sockets = {};
    for (const id of Object.keys(s.skills)) {
      const src = Array.isArray(rawSockets[id]) ? rawSockets[id] : [];
      const arr = [null, null, null];
      for (let i = 0; i < 3; i++) {
        const sup = src[i];
        if (sup && s.supports.indexOf(sup) >= 0 && !used.has(sup) && G.supportFits(id, sup)) {
          arr[i] = sup;
          used.add(sup);
        }
      }
      s.sockets[id] = arr;
    }
    // 武器普攻卡的 3 个孔（不属于哪个已学技能，换远程武器时不动）
    {
      const src = Array.isArray(rawSockets[G.BASIC_CARD]) ? rawSockets[G.BASIC_CARD] : [];
      const arr = [null, null, null];
      for (let i = 0; i < 3; i++) {
        const sup = src[i];
        if (sup && s.supports.indexOf(sup) >= 0 && !used.has(sup) && G.supportFits(G.BASIC_CARD, sup)) {
          arr[i] = sup;
          used.add(sup);
        }
      }
      s.sockets[G.BASIC_CARD] = arr;
    }
    // 技能栏：4 格，技能必须已学，同一技能只占一格
    const rawBar = Array.isArray(raw.bar) ? raw.bar : d.bar;
    s.bar = [null, null, null, null];
    for (let i = 0; i < 4; i++) {
      const id = rawBar[i];
      if (id && s.skills[id] && s.bar.indexOf(id) < 0) s.bar[i] = id;
    }
    s.rmbKeep = typeof raw.rmbKeep === 'string' && s.skills[raw.rmbKeep] && s.bar.indexOf(raw.rmbKeep) < 0 ? raw.rmbKeep : null;
    // 武器普攻改版：右键固定是武器普攻（改版前只有拿着枪械 / 弓时这样）。右键格上的技能挪到第一个空格（左键 / Q / E），
    // 三格都满时收进 rmbKeep；改版前拿着远程武器时收起来的 rmbKeep 也趁这时放进空格。G.rmbMigrated 给界面提示一次
    {
      const moved = [];
      const id = s.bar[1];
      if (id) {
        s.bar[1] = null;
        const i = barFree(s.bar);
        if (i >= 0) {
          s.bar[i] = id;
          moved.push({ id, to: i });
        } else if (!s.rmbKeep) {
          s.rmbKeep = id;
          moved.push({ id, to: -1 });
        } else moved.push({ id, to: -2 }); // 收着的位置也占了：技能还在（已学、辅助照镶），只是不在技能栏上
      }
      if (s.rmbKeep) {
        const i = barFree(s.bar);
        if (i >= 0) {
          moved.push({ id: s.rmbKeep, to: i });
          s.bar[i] = s.rmbKeep;
          s.rmbKeep = null;
        }
      }
      if (moved.length) G.rmbMigrated = moved;
    }

    // 天赋：只保留存在且与起点连通的节点
    const pas = ['start'];
    if (Array.isArray(raw.passives)) {
      for (const id of raw.passives) {
        if (G.TREE[id] && pas.indexOf(id) < 0) pas.push(id);
      }
    }
    const ok = reachable(pas);
    s.passives = pas.filter((id) => ok.has(id));
    // 成长改版前的老角色：天赋盘扩大时原有节点的 id 和连线都没有动，点过的天赋原样保留（这里不需要搬动或退点），
    // 只是记一笔，让界面层提示一次「天赋盘扩大了、多出来的天赋点可以接着点」
    if (oldGrowth && s.level > 1) G.growthMigrated = { kept: s.passives.length - 1 };

    s.cleared = {};
    if (isObj(raw.cleared)) {
      for (const z of G.ZONES) {
        if (typeof raw.cleared[z.id] === 'number') s.cleared[z.id] = toInt(raw.cleared[z.id], 0, 999, 0);
      }
    }
    s.bossKills = {};
    if (isObj(raw.bossKills)) {
      for (const k of Object.keys(G.BOSSES)) if (raw.bossKills[k]) s.bossKills[k] = true;
    }
    s.maxTier = toInt(raw.maxTier, 0, 999, 0);
    s.tier = toInt(raw.tier, 0, s.maxTier, 0);
    s.lastZone = toInt(raw.lastZone, 0, G.ZONES.length - 1, 0);
    const ro = isObj(raw.opts) ? raw.opts : {};
    s.opts = {
      autoWhite: !!ro.autoWhite, hideNormal: !!ro.hideNormal, autoSalvage: !!ro.autoSalvage, salvageMagic: !!ro.salvageMagic,
      quality: G.QUALITY_IDS.indexOf(ro.quality) >= 0 ? ro.quality : 'auto',
    };
    s.seenHelp = !!raw.seenHelp;
    s.tut = {};
    if (isObj(raw.tut)) {
      for (const k of Object.keys(raw.tut).slice(0, 64)) {
        if (raw.tut[k] && /^[a-z][a-z0-9_]{0,23}$/i.test(k)) s.tut[k] = 1;
      }
    }
    // 长弓改名只在第一次读档时发生（改完的名字随即存回去）：存档里记一笔 bowMig，直到「远程改版」提示看过（tut.bowmig）才清掉，
    // 不让第一次会话在提示弹出前就结束的玩家永远看不到它
    s.bowMig = G.bowMigrated > 0 || (raw.bowMig === true && !s.tut.bowmig);
    if (s.bowMig) G.bowMigrated = Math.max(1, G.bowMigrated);
    s.blankGems = Array.isArray(raw.blankGems)
      ? raw.blankGems.filter(isNum).slice(0, BLANK_MAX).map((v) => G.clamp(Math.floor(v), 1, MAX_GEM_LEVEL)).sort((a, b) => b - a)
      : [];
    // 裂石击已删除：学过的退成一颗同等级的无铭技能宝石（上面读技能时它已经被滤掉，技能栏的格子随之空出来；
    // 镶在它上面的辅助回到「已拥有、没镶」的状态——辅助的归属记在 s.supports，孔只是按技能记的位置）。G.cleaveRefund 给界面提示一次
    if (isObj(raw.skills) && raw.skills.cleave !== undefined && !G.SKILLS.cleave) {
      const lvl = toInt(raw.skills.cleave, 1, MAX_GEM_LEVEL, 1);
      if (s.blankGems.length < BLANK_MAX) {
        s.blankGems.push(lvl);
        s.blankGems.sort((a, b) => b - a);
      }
      const socks = isObj(raw.sockets) && Array.isArray(raw.sockets.cleave) ? raw.sockets.cleave.filter((x) => x && G.SUPPORTS[x] && s.supports.indexOf(x) >= 0) : [];
      G.cleaveRefund = { lvl, sups: socks };
      // 技能栏上只放着裂石击的老存档：腾空之后一个技能都不剩，把已学的第一个技能放进左键（右键的普攻照样能打）
      if (s.bar.every((b) => !b)) s.bar[0] = Object.keys(s.skills).find((id) => G.SKILLS[id].kind !== 'aura') || null;
    }
    // 自动召唤开关：只认召唤技能，旧存档没有这一项就保持默认（关）
    const ra = isObj(raw.autoSummon) ? raw.autoSummon : {};
    for (const id of Object.keys(s.autoSummon)) s.autoSummon[id] = ra[id] === true;
    // 烬铸图鉴：只认存在的烬铸 id / 首领，完美度 0–100、保底计数 0–上限
    const ru = isObj(raw.uniq) ? raw.uniq : {};
    const rf = isObj(ru.found) ? ru.found : {};
    const rb = isObj(ru.best) ? ru.best : {};
    const rp = isObj(ru.pity) ? ru.pity : {};
    for (const id of G.UNIQUE_IDS) {
      if (rf[id] === true) s.uniq.found[id] = true;
      if (isNum(rb[id]) && rb[id] > 0) s.uniq.best[id] = G.clamp(Math.round(rb[id]), 0, 100);
    }
    for (const k of Object.keys(G.UNIQUE_BY_BOSS)) {
      const n = toInt(rp[k], 0, G.UNIQUE_DROP.pity, 0);
      if (n > 0) s.uniq.pity[k] = n;
    }
    // 刻式：只认 G.VARIANTS 里的技能和 a / b（宝石还没到解锁等级的照样保留，到了才生效）；选过刻式的技能免费那一次算用过了
    const rv = isObj(raw.variants) ? raw.variants : {};
    const rvf = isObj(raw.variantFree) ? raw.variantFree : {};
    for (const id of Object.keys(G.VARIANTS)) {
      if (rv[id] === 'a' || rv[id] === 'b') s.variants[id] = rv[id];
      if (rvf[id] === true || s.variants[id]) s.variantFree[id] = true;
    }
    // 身上 / 背包里已有的烬铸武器也算拾到过（旧数据缺图鉴时补上）
    for (const it of s.bag.concat(s.equip.weapon ? [s.equip.weapon] : [])) if (it.rarity === 3) noteUnique(it, s);
    // 渊契图鉴：同上，只认 G.RELICS 的 id 和保底的键（渊契 id、'seal'）；旧存档没有这一项就是空的。
    // 保底计数截到现在的上限：掉率改版前攒下的（旧上限 10 / 8 / 15）超过新上限时按满计，下一次必掉
    const rr = isObj(raw.relic) ? raw.relic : {};
    const qf = isObj(rr.found) ? rr.found : {};
    const qb = isObj(rr.best) ? rr.best : {};
    const qp = isObj(rr.pity) ? rr.pity : {};
    for (const id of Object.keys(G.RELICS)) {
      if (qf[id] === true) s.relic.found[id] = true;
      if (isNum(qb[id]) && qb[id] > 0) s.relic.best[id] = G.clamp(Math.round(qb[id]), 0, 100);
    }
    for (const k of G.relicPityKeys()) {
      const n = toInt(qp[k], 0, G.relicPityMax(k), 0);
      if (n > 0) s.relic.pity[k] = n;
    }
    for (const slot of G.SLOTS) if (s.equip[slot] && s.equip[slot].rarity === 4) noteRelic(s.equip[slot], s);
    for (const it of s.bag) if (it.rarity === 4) noteRelic(it, s);
    return s;
  }
  // 图鉴记一笔：拾到过、最高完美度
  function noteUnique(it, save) {
    const U = (save || G.save).uniq;
    if (!it || it.rarity !== 3 || !U) return;
    const p = Math.round(G.uniquePerfect(it) * 100);
    U.found[it.uq] = true;
    if (!(U.best[it.uq] >= p)) U.best[it.uq] = p;
  }
  G.noteUnique = (it) => noteUnique(it);
  function noteRelic(it, save) {
    const U = (save || G.save).relic;
    if (!it || it.rarity !== 4 || !U) return;
    const p = Math.round(G.uniquePerfect(it) * 100);
    U.found[it.rq] = true;
    if (!(U.best[it.rq] >= p)) U.best[it.rq] = p;
  }
  G.noteRelic = (it) => noteRelic(it);

  // 画质档位：桌面默认高，手机 / 平板默认中
  G.QUALITY_IDS = ['high', 'mid', 'low'];
  // 浏览器在用软件渲染（显卡被禁用、SwiftShader / llvmpipe 之类）时默认低：后期处理在 CPU 上太贵
  let softGL = null;
  function isSoftGL() {
    if (softGL !== null) return softGL;
    softGL = false;
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      softGL = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
      const lose = gl && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch (e) {
      softGL = false;
    }
    return softGL;
  }
  G.defaultQuality = () => (isSoftGL() ? 'low' : /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ? 'mid' : 'high');

  G.loadSave = function () {
    let raw = null;
    try {
      const txt = window.localStorage.getItem(SAVE_KEY);
      if (txt) raw = JSON.parse(txt);
    } catch (err) {
      raw = null;
    }
    return setSave(sanitize(raw));
  };

  G.persist = function () {
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(G.save));
      return true;
    } catch (err) {
      return false;
    }
  };

  G.resetSave = function () {
    try {
      window.localStorage.removeItem(SAVE_KEY);
    } catch (err) {
      /* 存储不可用时也照常重置内存里的存档 */
    }
    setSave(G.newSave()); // 召唤物在 setSave 里一并散掉
    G.computeStats();
    G.persist();
    return G.save;
  };

  // ---------- 刻式 ----------
  // G.SKILL_V[id] = { o, a, b }：o 就是 data.js 里原来那个对象（原式一字不差），a / b 第一次用到时按 G.SKILL_BASE + set 拼一份、之后复用。
  // G.applyVariants 按存档把 G.SKILLS[id] 指向其中一份（读档、换刻式、宝石到解锁等级时调用）；游戏里读 G.SKILLS[...] 的地方都不用改。
  // 双生坠（D5）：施放前用 G.useVariant(id, 'a' / 'b') 临时指向另一份，返回原来那份，施放完指回去。
  //   黑洞、黑旋风、投射物、陨石在生成时拿着自己那份 ctx（ctx.sk），之后再换也不影响已经放出去的
  G.SKILL_V = {};
  for (const id of Object.keys(G.VARIANTS)) if (G.SKILLS[id]) G.SKILL_V[id] = { o: G.SKILLS[id] };
  const isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  function deepSet(dst, set) {
    for (const k of Object.keys(set)) {
      const v = set[k];
      if (isPlain(v) && isPlain(dst[k])) deepSet(dst[k], v);
      else dst[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
  }
  function buildVariant(id, v) {
    const V = G.VARIANTS[id][v];
    const sk = JSON.parse(JSON.stringify(G.SKILL_BASE[id]));
    deepSet(sk, V.set);
    if (V.set.combo) {
      sk.comboAvg = sk.combo.reduce((s, c) => s + c.mult, 0) / sk.combo.length;
      sk.comboStop = sk.combo.reduce((s, c) => s + c.stop, 0) / sk.combo.length;
    }
    sk.variant = v;
    sk.vname = V.name;
    sk.desc = V.desc;
    return sk;
  }
  // 这一刻生效的刻式：'o' / 'a' / 'b'（存档里记着、但宝石还没到解锁等级的不生效）
  G.variantOf = function (id) {
    const s = G.save, v = s && s.variants && s.variants[id];
    return (v === 'a' || v === 'b') && G.VARIANTS[id] && s.skills && s.skills[id] >= G.VARIANT_LVL ? v : 'o';
  };
  G.skillVariant = function (id, v) {
    const C = G.SKILL_V[id];
    if (!C) return G.SKILLS[id];
    if (!C[v]) C[v] = buildVariant(id, v);
    return C[v];
  };
  G.applyVariants = function () {
    for (const id of Object.keys(G.SKILL_V)) G.SKILLS[id] = G.skillVariant(id, G.variantOf(id));
  };
  G.useVariant = function (id, v) {
    const prev = G.SKILLS[id];
    if (G.SKILL_V[id] && (v === 'o' || v === 'a' || v === 'b')) G.SKILLS[id] = G.skillVariant(id, v);
    return prev;
  };
  // 换刻式的价格：这个技能第一次选免费，之后每换一次 G.VARIANT_COST
  G.variantCost = (id) => (G.save.variantFree && G.save.variantFree[id] ? G.VARIANT_COST.n : 0);
  // 战斗中：G.VARIANT_SAFE_R 以内有醒着的敌人
  G.variantBusy = function () {
    const R = G.VARIANT_SAFE_R;
    return state.enemies.some((e) => !e.dead && e.awake && dist(e.x, e.z, P.x, P.z) <= R);
  };
  // 换刻式（技能页）：v = 'o' 原式 / 'a' / 'b'。返回 { ok, msg, cost }
  G.setVariant = function (id, v) {
    const save = G.save, VC = G.VARIANT_COST;
    if (!G.VARIANTS[id] || !(v === 'o' || v === 'a' || v === 'b')) return { ok: false, msg: '没有这种刻式' };
    if (!(save.skills[id] >= G.VARIANT_LVL)) return { ok: false, msg: '宝石 ' + G.VARIANT_LVL + ' 级才能选刻式' };
    if ((save.variants[id] || 'o') === v) return { ok: true, cost: 0, same: true };
    if (G.variantBusy()) return { ok: false, msg: '战斗中不能换刻式（' + G.VARIANT_SAFE_R + ' 米内还有醒着的敌人）' };
    const cost = G.variantCost(id);
    if ((save.cur[VC.cur] || 0) < cost) return { ok: false, msg: '需要 ' + cost + ' 颗' + G.CURRENCY[VC.cur].name };
    save.cur[VC.cur] -= cost;
    save.variantFree[id] = true;
    if (v === 'o') delete save.variants[id];
    else save.variants[id] = v;
    G.applyVariants();
    // 旧定义的残留：连段从头来，正在转的旋风 / 连斩停下，光环的计时重来
    comboReset();
    if (P.cast && P.cast.id === id) endChannel();
    delete P.auraT[id];
    G.computeStats(); // 保留比例可能变了
    if (G.refreshMinions) G.refreshMinions(); // 召唤物的上限、数值、体型
    G.persist();
    return { ok: true, cost };
  };
  // 单体秒伤（设计稿 §5.2 的口径）：平均击中 × 每次施放对单体的倍率 ÷ 一轮的时间（出手 + 顿帧，冷却技能再加冷却）；
  // 召唤按满编的 skillDps，光环按脉冲。技能页的刻式悬停和测试用
  G.variantDps = function (id) {
    const ctx = G.skillCtx(id);
    if (ctx.minion) return G.skillDps(ctx);
    return G.avgHit(ctx) / (Math.max((ctx.cycle || ctx.time) + ctx.stopAvg, 0.01) + (ctx.cd > 0 ? ctx.cd : 0));
  };
  // 刻式 v 和原式的比值。霜环按「主力技能 + 霜环」的总秒伤（主力取技能栏上秒伤最高的非光环技能，没有就按掷焰）；
  // 黑焰按你自己每一击的 (1 + 黑焰%)（召唤物的部分不算，炽契给召唤物的是 0）
  G.variantRatio = function (id, v) {
    if (!G.SKILL_V[id]) return 1;
    const prev = G.SKILLS[id];
    const val = (w) => {
      G.SKILLS[id] = G.skillVariant(id, w);
      const sk = G.SKILLS[id];
      if (sk.buff) return 1 + Math.min(sk.flame.cap, sk.flame.k0 + sk.flame.k1 * ((G.save.skills[id] || 1) - 1)) * (1 + Math.max(0, P.S.flameEff || 0) / 100) / 100;
      return G.variantDps(id);
    };
    let ref = 0;
    if (G.SKILLS[id].kind === 'aura' && !G.SKILLS[id].buff) {
      for (const b of G.save.bar) if (b && b !== id && G.SKILLS[b] && G.SKILLS[b].kind !== 'aura' && !G.SKILLS[b].weaponOnly && G.save.skills[b]) ref = Math.max(ref, G.variantDps(b));
      if (!ref) ref = G.variantDps('ember');
    }
    const o = val('o'), x = val(v);
    G.SKILLS[id] = prev;
    return (ref + x) / Math.max(1e-9, ref + o);
  };

  G.passivePoints = function () {
    const save = G.save;
    const total = save.level - 1 + 2 * Object.keys(save.bossKills).length;
    const used = save.passives.length - 1;
    return { total, used, free: total - used };
  };

  // =====================================================================
  // 远程武器：右键接管、量表
  // =====================================================================
  // 一把武器是不是远程武器：是的话返回它的基底（带 ranged / type），否则 null
  G.rangedOf = function (w) {
    const base = w && w.slot === 'weapon' && G.BASES.weapon[w.baseIdx];
    return base && base.ranged ? base : null;
  };
  // 手里的远程武器：null，或 { family: 'gun' | 'bow', type, basic: 普攻技能 id, gauge: { kind: 'heat' | 'focus', v, max, full, name } }
  G.rangedWeapon = function () {
    const base = G.rangedOf(G.save && G.save.equip && G.save.equip.weapon);
    if (!base) return null;
    const kind = base.ranged === 'gun' ? 'heat' : 'focus';
    const max = G.RANGED.max;
    const v = Math.min(max, P.gauge[kind] || 0);
    return { family: base.ranged, type: base.type, basic: 'basic_' + base.type, gauge: { kind, v, max, full: v >= max, name: G.GAUGE_NAME[kind] } };
  };
  // R 能不能放：不是远程武器时总是 true（照常看冷却）；远程武器要量表满
  G.gaugeReady = function () {
    const rw = G.rangedWeapon();
    return !rw || rw.gauge.full;
  };
  // 往量表里加 v（可以是负数）；满的那一刻记一笔（新手提示 / 界面读 state.stats.gaugeFull）
  G.addGauge = function (kind, v) {
    const g = P.gauge;
    const max = G.RANGED.max;
    const was = g[kind] >= max;
    g[kind] = G.clamp((g[kind] || 0) + v, 0, max);
    if (!was && g[kind] >= max) {
      state.stats.gaugeFull = (state.stats.gaugeFull || 0) + 1;
      const rw = G.rangedWeapon();
      if (rw && rw.gauge.kind === kind && G.world && P.ent) {
        G.world.text(P.x, P.z, G.GAUGE_NAME[kind] + '已满 · R', kind === 'heat' ? '#ffb36a' : '#bfe8a0', 15);
        fxOpt('gaugeFull', P.ent, kind);
      }
    }
    return g[kind];
  };
  // ---------- 武器普攻：右键 ----------
  // 手里武器的普攻 id：枪械 / 弓 / 近战 / 施法 / 魂幡都是 basic_<武器类型>，空手是 basic_fists
  G.basicForWeapon = function (w) {
    const base = w && w.slot === 'weapon' && G.BASES.weapon[w.baseIdx];
    const id = base ? 'basic_' + base.type : 'basic_fists';
    return G.SKILLS[id] ? id : null;
  };
  G.weaponBasic = function () {
    return G.basicForWeapon(G.save && G.save.equip && G.save.equip.weapon);
  };
  // 技能栏里除了右键（下标 1）之外的第一个空格，没有时 -1
  function barFree(bar) {
    for (const i of [0, 2, 3]) if (!bar[i]) return i;
    return -1;
  }
  // 右键接管（武器普攻改版前只在拿着远程武器时接管，现在一直接管）：右键格（下标 1）上要是还有技能，挪到第一个空格，
  // 三格都满时收进 save.rmbKeep（rmbKeep 已经有别的技能时不顶掉它：那个技能留在已学里，技能页上照样能绑）。
  // 读档时 sanitize 已经挪过一遍，这里只兜住运行中意外写进右键格的情况
  function syncRanged() {
    const save = G.save;
    if (!save || !Array.isArray(save.bar)) return;
    const id = save.bar[1];
    if (!id) return;
    save.bar[1] = null;
    const i = barFree(save.bar);
    if (i >= 0 && save.bar.indexOf(id) < 0) save.bar[i] = id;
    else if (!save.rmbKeep || !save.skills[save.rmbKeep] || save.bar.indexOf(save.rmbKeep) >= 0) save.rmbKeep = id;
  }
  G.syncRanged = syncRanged;
  // 新学的技能自动放进技能栏时用的空格：右键一直是武器普攻，不算空格
  G.freeBarSlot = function () {
    return barFree(G.save.bar);
  };

  // =====================================================================
  // 属性
  // =====================================================================
  G.computeStats = function () {
    const save = G.save;
    syncRanged(); // 光环保留看技能栏：先把右键接管对好
    const S = {};
    for (const k of Object.keys(G.STAT_FMT)) S[k] = 0;
    const add = (stats) => {
      for (const k in stats) S[k] = (S[k] || 0) + stats[k];
    };
    for (const slot of G.SLOTS) {
      const it = save.equip[slot];
      if (it) add(G.itemStats(it));
    }
    const gearLife = S.life;
    for (const id of save.passives) add(G.TREE[id].stats);
    P.S = S;
    G.relicSync(); // 身上渊契的机制（P.relic）：光环保留（星雨）在下面就要用

    P.gearLife = gearLife; // 装备给的「+最大生命」（召唤物继承生命用）
    P.maxLifeRaw = Math.max(1, Math.round((G.baseLife(save.level) + S.life) * (1 + S.incLife / 100) * (1 + S.moreLife / 100)));
    // 光环保留：技能栏上的光环按百分比扣掉最大魔力（maxManaRaw 是保留之前的上限）。
    // 魔力回复按保留之后的上限算：保留的那部分魔力既不能用，也不再回复。
    // 以血为引（技能消耗生命）时光环改为保留最大生命——不然魔力用不上，保留等于白送
    P.maxManaRaw = Math.max(0, Math.round((G.baseMana(save.level) + S.mana) * (1 + S.incMana / 100)));
    P.reservePct = G.reservePct();
    P.reserveLife = !!S.bloodMagic;
    P.reserved = Math.round(((P.reserveLife ? P.maxLifeRaw : P.maxManaRaw) * P.reservePct) / 100);
    P.maxLife = P.reserveLife ? Math.max(1, P.maxLifeRaw - P.reserved) : P.maxLifeRaw;
    P.maxMana = P.reserveLife ? P.maxManaRaw : Math.max(0, P.maxManaRaw - P.reserved);
    P.armour = Math.max(0, Math.round(S.armour * (1 + S.incArmour / 100)));
    // resLoss（基石「元素过载」）在 75% 上限之后才扣，溢出的抗性抵消不了
    const resLoss = Math.max(0, S.resLoss || 0);
    P.res.fire = Math.min(75, S.resFire) - resLoss;
    P.res.cold = Math.min(75, S.resCold) - resLoss;
    P.res.light = Math.min(75, S.resLight) - resLoss;
    P.speedMult = Math.max(0.2, 1 + S.speed / 100);
    P.moveSpeed = 7.2 * Math.max(0.2, 1 + S.moveSpeed / 100);
    P.lifeRegen = S.lifeRegen;
    P.manaRegen = (2 + P.maxMana * 0.035) * (1 + S.manaRegen / 100);
    P.life = Math.min(P.life, P.maxLife);
    P.mana = Math.min(P.mana, P.maxMana);
    // 手里烬铸武器的机制（blade 残刃 / tri 三相共鸣 / soul 魂火轮回），没有时 null
    const w = save.equip.weapon;
    P.uMech = w && w.rarity === 3 && G.UNIQUES[w.uq] ? G.UNIQUES[w.uq].mech : null;
    if (P.ent) G.world.setPlayerGear(save.equip); // 手里的武器模型跟着装备走
    return P;
  };

  // ---------- 光环 ----------
  // 光环技能只要绑在技能栏任意一格上就生效（宝石得已经学会）
  G.auraOn = function (id) {
    const save = G.save;
    const sk = G.SKILLS[id];
    return !!(sk && sk.kind === 'aura' && save && save.skills && save.skills[id] && save.bar && save.bar.indexOf(id) >= 0);
  };
  // 某个光环保留的魔力百分比：辅助宝石的消耗倍率照样乘在保留上——节流（×0.6）降低保留，迅捷、扩域这类（×1.2 上下）抬高保留
  G.auraReserve = function (id) {
    const sk = G.SKILLS[id];
    if (!sk || !sk.reserve) return 0;
    let k = 1;
    for (const supId of (G.save.sockets && G.save.sockets[id]) || []) {
      const sup = supId && G.SUPPORTS[supId];
      if (sup) k *= sup.cost;
    }
    return Math.round(sk.reserve * k * 10) / 10;
  };
  // 黑焰：此刻每一击额外的混沌伤害百分比（没放在技能栏上为 0）。F = min(cap, k0 + k1 × (等级 − 1)) × (1 + 黑焰效果%)
  // minion：算的是召唤物的一击（刻式「炽契」只给你自己，召唤物为 0）
  G.flamePct = function (minion) {
    if (!G.auraOn('blackflame') || (minion && G.SKILLS.blackflame.selfOnly)) return 0;
    const f = G.SKILLS.blackflame.flame;
    const lvl = G.save.skills.blackflame || 1;
    return Math.min(f.cap, f.k0 + f.k1 * (lvl - 1)) * (1 + Math.max(0, (P.S && P.S.flameEff) || 0) / 100);
  };
  // 刻式「噬契」：黑焰的那一部分按 flameAil 倍累积混沌异常（没放黑焰、或不是噬契时为 0）
  G.flameAil = () => (G.SKILLS.blackflame.flameAil && G.auraOn('blackflame') ? G.SKILLS.blackflame.flameAil : 0);
  // 技能栏上所有生效的光环一共保留的百分比（封顶 90%）
  G.reservePct = function () {
    let pct = 0;
    for (const id of Object.keys(G.SKILLS)) if (G.auraOn(id)) pct += G.auraReserve(id);
    if (P.relic.zhuixing) pct += G.relicReserve(); // 渊契「星雨」：自动陨火改为保留魔力
    return Math.min(90, pct);
  };

  // 武器普攻卡（G.BASIC_CARD）：能镶任何一种武器普攻用得上的辅助（至少对一种普攻适配），生效时再按当前普攻筛（G.basicSupports）。
  // 改版前只有远程普攻、按它们标签的并集判断；现在普攻里有召唤物（魂幡）也有法术，并集会把「不能给召唤物用」的贯穿 / 连锁 / 汲生误判成镶不上，改成逐个普攻判断
  G.supportFits = function (skillId, supId) {
    if (skillId === G.BASIC_CARD) {
      if (!G.SUPPORTS[supId]) return false;
      for (const id in G.SKILLS) if (G.SKILLS[id].basic && G.supportFits(id, supId)) return true;
      return false;
    }
    const sk = G.SKILLS[skillId];
    const sup = G.SUPPORTS[supId];
    if (!sk || !sup || (sk.weaponOnly && !sk.basic)) return false; // 武器技镶不了辅助（远程普攻例外：镶在武器普攻卡上）
    if (sk.noSup && sk.noSup.indexOf(supId) >= 0) return false; // 技能自己排除的辅助
    if (sk.buff) return sup.cost < 1; // 黑焰这类增益光环：只认降低消耗（保留）的辅助
    if (sup.no && sup.no.some((tag) => sk.tags.indexOf(tag) >= 0)) return false;
    if (sup.noKind && sk.minion && sup.noKind.indexOf(sk.minion) >= 0) return false;
    if (!sup.req) return true;
    return sup.req.some((tag) => sk.tags.indexOf(tag) >= 0);
  };

  // 武器普攻卡上对这个普攻生效的辅助（卡上镶着、标签对得上）；不适用的照样镶着，换到合适的远程武器再生效
  G.basicSupports = function (id) {
    const arr = (G.save.sockets && G.save.sockets[G.BASIC_CARD]) || [];
    return arr.filter((supId) => supId && G.SUPPORTS[supId] && G.supportFits(id, supId));
  };

  // 顿帧时长随攻击 / 施法速度的缩放：越快越短，但不低于六成（再短就没有顿挫感了）
  const STOP_K = (speed) => G.clamp(1 / (speed > 0 ? speed : 1), 0.6, 1);

  // 每次命中都要用到的技能上下文。
  // 召唤技能（kind 'summon'）的伤害字段描述的是召唤物的每一击：不吃玩家自己的伤害属性（附加伤害、伤害提高、
  // 总伤害、暴击、异常几率、范围），只吃 minionDmg / minionMore 与镶在这个技能上的辅助；ctx.minion 是召唤物的其余数值
  // ---------- 武器技 ----------
  // 当前武器自带的武器技 id（没拿武器时 null）
  // 烬铸武器：换成它专属的烬铸技（G.UNIQUES[..].uskill），顶替这类武器的普通武器技
  G.weaponSkillOf = function (w) {
    const U = w && w.rarity === 3 && G.UNIQUES[w.uq];
    if (U && U.uskill && G.SKILLS[U.uskill]) return U.uskill;
    const base = w && G.BASES.weapon[w.baseIdx];
    return (base && base.wskill && G.SKILLS[base.wskill] && base.wskill) || null;
  };
  G.weaponSkill = function () {
    return G.weaponSkillOf(G.save && G.save.equip && G.save.equip.weapon);
  };
  // 武器技共用一个冷却：换了武器技（换了另一类武器）时，把上一个武器技剩下的冷却按比例带到新的武器技上，
  // 免得在两类武器之间来回换就能连放。换装（commit）和每帧开头各对一次；同类武器之间换本来就是同一个 id
  let wsLast = null;
  function syncWsCd() {
    const id = G.weaponSkill();
    // 武器技起手途中换掉了武器：还没生效的那一招作废（否则会用新武器的数值打出旧武器的招、又不占新武器技的冷却）
    if (P.cast && P.cast.ws && !P.cast.fired && P.cast.id !== id) P.cast = null;
    if (!id || id === wsLast) return;
    // 远程武器的 R 没有冷却（量表卡着）：不接手冷却，wsLast 留在上一个有冷却的武器技上——
    // 否则「近战 → 弓 → 近战」一换就把近战武器技的冷却洗掉了
    if (!(G.SKILLS[id].cd > 0)) return;
    const old = wsLast;
    wsLast = id;
    const left = old ? P.cds[old] || 0 : 0;
    const max = old ? P.cdMax[old] || 0 : 0;
    if (!(left > 0 && max > 0)) return;
    const cd = G.skillCtx(id).cd;
    if (!(cd > 0)) return;
    const v = cd * Math.min(1, left / max);
    if (!(P.cds[id] >= v)) {
      P.cds[id] = v;
      P.cdMax[id] = cd;
    }
  }
  // 武器技的等级：攻击型 = 宝石的成长下限（只给攻击技能那一点点等级加成）；法术型 = 武器物品等级 × 0.75（和掉落宝石的等级曲线一致）
  G.weaponSkillLevel = function (id) {
    const sk = G.SKILLS[id];
    if (!sk || !sk.weaponOnly) return 1;
    if (sk.tags.indexOf('attack') >= 0) return G.gemFloor();
    const w = G.save.equip.weapon;
    return G.clamp(Math.round((w ? w.ilvl : 1) * 0.75), 1, MAX_GEM_LEVEL);
  };
  // 元素伤害加成最高的元素（法术型武器技用它）；都一样高时取 def
  G.topElem = function (def) {
    const S = P.S;
    let best = def || 'fire';
    let bv = (S['inc' + G.CAP[best]] || 0) + 1e-6;
    for (const t of G.ELEMS) {
      const v = S['inc' + G.CAP[t]] || 0;
      if (v > bv) {
        bv = v;
        best = t;
      }
    }
    return best;
  };
  // 远程武器类型 → 'gun' / 'bow'
  const RFAM = {};
  for (const b of G.BASES.weapon) if (b.ranged) RFAM[b.type] = b.ranged;
  G.RFAM = RFAM;
  const RUNE_CYCLE = ['fire', 'cold', 'light'];
  // 符文弓这一箭的元素：你有元素伤害加成就取最高的那种，都没有（或元素满溢期间）就火 / 冰 / 雷轮流（P.gun.cycle 每射一箭往下走一格）
  G.runeElem = function (forceCycle) {
    const S = P.S;
    if (!forceCycle) {
      let best = null, bv = 0, tie = false;
      for (const t of G.ELEMS) {
        const v = S['inc' + G.CAP[t]] || 0;
        if (v > bv) {
          bv = v;
          best = t;
          tie = false;
        } else if (v === bv && v > 0) tie = true;
      }
      if (best && !tie) return best;
    }
    return RUNE_CYCLE[((P.gun.cycle % 3) + 3) % 3];
  };
  // 此刻生效的弓增益（数据在 G.SKILLS[id].buff），没有时 null
  G.rangedBuff = function () {
    const b = P.rbuff;
    return b && b.t > 0 && G.SKILLS[b.id] ? G.SKILLS[b.id].buff : null;
  };
  // 武器伤害的转换：conv { 元素: 比例 }（'rune' = 符文弓按 G.runeElem 取元素、转 convK）；元素满溢期间符文弓的箭全部转成轮到的元素
  function convertBase(sk, out) {
    let conv = sk.conv;
    if (sk.basic && sk.rtype === 'runebow' && P.rbuff && P.rbuff.t > 0 && P.rbuff.id === 'overflow') conv = { [G.runeElem(true)]: 1 };
    else if (conv === 'rune') conv = { [G.runeElem()]: sk.convK || 0.6 };
    if (!conv || !out.phys) return out;
    const p = out.phys;
    let left = 1;
    for (const t in conv) {
      const k = Math.min(left, conv[t]);
      left -= k;
      if (!out[t]) out[t] = [0, 0];
      out[t][0] += p[0] * k;
      out[t][1] += p[1] * k;
    }
    if (left <= 1e-6) delete out.phys;
    else out.phys = [p[0] * left, p[1] * left];
    return out;
  }

  // 技能在某个等级下的基础伤害（还没算你的伤害属性）：{ 类型: [最小, 最大] }。攻击技能按当前武器算。
  // 技能卡 / 宝石提示用；lvl 缺省取已学等级
  // 攻速折进伤害的攻击技能：有冷却、不是武器技（武器技各自按自己的武器定好了数值）
  G.cdAps = (sk) => !!(sk && sk.wm && sk.cd > 0 && !sk.weaponOnly && sk.kind !== 'summon');
  // 按普攻折算的量表技（熔光射线：basicOf / basicSec）：一发 = 普攻转满之后扫射 basicSec 秒的发数。
  // 每秒发数 = 武器攻速 × 攻击速度 ÷ 普攻的 time（不算辅助宝石：武器技镶不了辅助）；没拿着对应的武器时按 1.0 攻速算
  G.basicShots = function (sk) {
    const b = G.SKILLS[sk.basicOf];
    if (!b) return 1;
    const wp = G.weaponStats(G.save.equip.weapon);
    return (sk.basicSec * (P.speedMult || 1) * (wp.aps > 0 ? wp.aps : 1)) / b.time;
  };
  // 攻击技能实际的武器倍率：按普攻折算的 = 普攻的 wm × 折算的发数，其余就是 wm
  G.skillWm = (sk) => (sk.basicOf && G.SKILLS[sk.basicOf] ? G.SKILLS[sk.basicOf].wm * G.basicShots(sk) : sk.wm);
  G.skillBase = function (id, lvl) {
    const sk = G.SKILLS[id];
    if (!sk) return {};
    if (lvl === undefined) lvl = sk.weaponOnly ? G.weaponSkillLevel(id) : G.save.skills[id] || 1;
    const out = {};
    if (sk.wm && sk.kind !== 'summon') {
      const wp = G.weaponStats(G.save.equip.weapon);
      // 有冷却的攻击技能（闪袭）出手次数由冷却决定，攻速快也多打不了几下：把武器攻速折进每一击的伤害（G.cdAps），
      // 否则慢而重的战锤配冷却技能会比双匕强出四成
      const k = G.skillWm(sk) * (1 + G.ATTACK_GEM_LVL * (lvl - 1)) * (G.cdAps(sk) ? wp.aps : 1);
      out.phys = [wp.min * k, wp.max * k];
      return convertBase(sk, out);
    }
    const scale = sk.kind === 'summon' || sk.asMinion || sk.champ ? G.minionDmgK(lvl) : 1 + 0.2 * (lvl - 1);
    if (sk.edmg) {
      // 星蚀（渊口）：拿着它时短杖的秘弹连射固定为混沌
      // 施法武器的普攻（灵弹 / 疾咒）也只取火 / 冰 / 雷里加成最高的那种，不取混沌（编排者定：混沌吃三种元素各自的伤害提高，
      // 普攻跟着混沌走就比冷却之后的黑旋风还痛）
      const el = sk.kind === 'wwand' && P.uMech === 'void' ? 'chaos' : G.topElem(sk.elem);
      out[el] = [sk.edmg[0] * scale, sk.edmg[1] * scale];
      return out;
    }
    // 混沌技能的前期补偿（G.chaosEarlyK：宝石 1 级相当于 0.95 倍，15 级起 0.75 倍）
    const ek = sk.chaosEarly && G.chaosEarlyK ? G.chaosEarlyK(lvl) : 1;
    for (const t in sk.dmg) out[t] = [sk.dmg[t][0] * scale * ek, sk.dmg[t][1] * scale * ek];
    return out;
  };

  G.skillCtx = function (id) {
    const save = G.save;
    const S = P.S;
    const sk = G.SKILLS[id];
    const isWs = !!sk.weaponOnly;
    const lvl = isWs ? G.weaponSkillLevel(id) : save.skills[id] || 1;
    // champ：万魂降临的英灵——数值按召唤物算（ctx.minion），但它是武器技，不吃辅助宝石
    const isMinion = sk.kind === 'summon' || !!sk.champ;
    // mScale：伤害按召唤物算（召唤技能，以及魂潮这种 asMinion 的武器技）——只吃召唤物类属性
    const mScale = isMinion || !!sk.asMinion;
    // 攻击技能：伤害 = 武器伤害 × wm × (1 + ATTACK_GEM_LVL × (等级 − 1))，出手速度再乘武器攻速（武器技的节奏是按各自的武器定好的，不再乘）
    const isAttack = !mScale && !!sk.wm;
    const wp = isAttack ? G.weaponStats(save.equip.weapon) : null;

    // 召唤物的基础伤害起点高、每级成长慢一些（G.MINION_DMG_LVL）：前期只有 3 具仆从、几乎没有加成时也打得动，后期不至于碾压首领
    const base = G.skillBase(id, lvl);
    // 召唤物继承你的装备（统御外圈的天赋）：每一击附加「你的武器伤害 × 继承比例 × 魂幡倍率 × 技能的继承系数」点物理伤害，
    // 和基础伤害一样再吃召唤物伤害加成；防御 / 生命的继承在下面 ctx.minion 里算
    const inh = isMinion ? G.minionInherit(sk) : null;
    if (inh && inh.add) {
      if (!base.phys) base.phys = [0, 0];
      base.phys[0] += inh.add[0];
      base.phys[1] += inh.add[1];
    }
    // 装备上的「附加 X 伤害」每一击都加一份：机炮、喷枪这类一秒十几跳的普攻只按 addEff 计（不然附加伤害按发数翻好几倍）
    // 按普攻折算的量表技：普攻每发的那一份 × 折算的发数（和武器伤害一样按扫射 basicSec 秒算）
    const bsk = sk.basicOf && G.SKILLS[sk.basicOf];
    const addEff = bsk ? (bsk.addEff === undefined ? 1 : bsk.addEff) * G.basicShots(sk) : sk.addEff === undefined ? 1 : sk.addEff;
    if (!mScale) for (const t of TYPES) {
      const v = (S['add' + G.CAP[t]] || 0) * addEff;
      if (v > 0) {
        if (!base[t]) base[t] = [0, 0];
        base[t][0] += v * 0.7;
        base[t][1] += v * 1.3;
      }
    }

    const inc = {};
    const moreType = {};
    for (const t of TYPES) {
      inc[t] = mScale ? S.minionDmg || 0 : (S.incAll || 0) + (t === 'phys' ? S.incPhys || 0 : (S.incElem || 0) + (S['inc' + G.CAP[t]] || 0));
      // 基石「元素过载」：你的元素伤害总额外提高（召唤物不吃）
      moreType[t] = !mScale && t !== 'phys' && t !== 'chaos' ? Math.max(0, 1 + (S.moreElem || 0) / 100) : 1;
    }
    // 混沌：吃三种元素各自的伤害提高（元素伤害提高上面已经算过一次）+ 混沌伤害提高；总额外只吃 moreChaos（不吃元素过载）
    if (!mScale) {
      inc.chaos += (S.incFire || 0) + (S.incCold || 0) + (S.incLight || 0);
      moreType.chaos = Math.max(0, 1 + (S.moreChaos || 0) / 100);
    }

    // 基石「万骸之主」：你自己（非召唤物）的伤害总额外降低（处决也算你自己的伤害）
    let more = mScale ? 1 + (S.minionMore || 0) / 100 : (1 + (S.moreDmg || 0) / 100) * (1 - Math.min(90, S.ownLess || 0) / 100);
    const extra = {};
    // 长弓的隐含穿透作用于你所有的投射物技能
    let proj = 0, pierce = !mScale && sk.tags.indexOf('projectile') >= 0 ? S.pierce || 0 : 0, chain = 0, area = mScale ? S.minionArea || 0 : S.area || 0, speedPct = 0; // 召唤物的范围只吃「召唤物的范围效果」
    let critFlat = sk.critFlat || 0, critMulti = 150 + (mScale ? 0 : S.critMulti || 0) + (sk.critMulti || 0); // 鹰眼长弓的普攻自带暴击
    let leech = 0, stun = 0, ailment = (mScale ? 0 : S.ailment || 0) + (sk.ailment || 0), echo = 0, cdr = 0, costMult = 1;
    let mLife = 0, mDR = 0, mCap = 0, mSpeed = 0;

    // 远程普攻：辅助镶在武器普攻卡上（只取对这个普攻生效的）；别的武器技不吃辅助
    const sups = sk.basic ? G.basicSupports(id) : (!isWs && save.sockets[id]) || [];
    for (const supId of sups) {
      const sup = supId && G.SUPPORTS[supId];
      if (!sup) continue;
      const e = sup.eff;
      if (e.more) more *= 1 + e.more / 100;
      if (e.moreType) for (const t in e.moreType) moreType[t] *= 1 + e.moreType[t] / 100;
      if (e.extra) for (const t in e.extra) extra[t] = (extra[t] || 0) + e.extra[t];
      if (e.proj) proj += e.proj;
      if (e.pierce) pierce += e.pierce;
      if (e.chain) chain += e.chain;
      if (e.area) area += e.area;
      if (e.speed) speedPct += e.speed;
      if (e.critFlat) critFlat += e.critFlat;
      if (e.critMulti) critMulti += e.critMulti;
      if (e.leech) leech += e.leech;
      if (e.stun) stun = Math.max(stun, e.stun);
      if (e.ailment) ailment += e.ailment;
      if (e.echo) echo += e.echo;
      if (e.cdr) cdr += e.cdr;
      if (e.minionMore) more *= 1 + e.minionMore / 100;
      if (e.minionLife) mLife += e.minionLife;
      if (e.minionDR) mDR += e.minionDR;
      if (e.minionCap) mCap += e.minionCap;
      if (e.minionSpeed) mSpeed += e.minionSpeed;
      costMult *= sup.cost;
    }

    // 魂幡的普攻：每只活着的召唤物让这一下的伤害提高 perMinion%（最多 maxMinion 只）
    if (sk.perMinion) {
      let n = 0;
      for (const m of state.minions) if (!m.dead) n++;
      more *= 1 + (sk.perMinion * Math.min(sk.maxMinion || 0, n)) / 100;
    }
    // 远程武器：热度越高枪械普攻越痛（heatDmg），热度技吃 rDmg
    const fam = sk.basic ? RFAM[sk.rtype] : sk.rgauge ? RFAM[sk.wtype] : null;
    if (fam === 'gun' && sk.basic && S.heatDmg) more *= 1 + (S.heatDmg / 100) * Math.min(1, (P.gauge.heat || 0) / G.RANGED.max);
    if (fam === 'gun' && sk.rgauge && S.rDmg) more *= 1 + S.rDmg / 100;
    // 远程普攻的出手节奏也乘武器攻速（别的武器技按各自的武器定好了节奏，不乘）
    const speed = P.speedMult * (1 + speedPct / 100) * (isAttack && (!isWs || sk.basic) ? wp.aps : 1);
    let cost = sk.mana * (1 + 0.05 * (lvl - 1)) * costMult * (1 - Math.min(80, S.costReduce || 0) / 100);
    cost = sk.mana > 0 ? Math.max(1, Math.round(cost)) : 0;
    const isAura = sk.kind === 'aura';

    const ctx = {
      id, sk, lvl, base, inc, moreType,
      more: Math.max(0, more),
      extra,
      crit: G.clamp((mScale ? 5 : 5 * (1 + (S.crit || 0) / 100)) + critFlat, 0, 100),
      critMulti: Math.max(100, critMulti),
      proj: 1 + proj,
      pierce: (sk.pierce || 0) + pierce,
      chain: (sk.chain || 0) + chain,
      area: Math.max(0.1, 1 + area / 100),
      speed,
      time: sk.time / speed,
      // 顿帧随出手速度缩短（下限 60%），stopAvg 是每次出手平均搭上的定格秒数——秒伤估算要把它算进去
      stopK: STOP_K(speed),
      stopAvg: ((sk.combo ? sk.comboStop : sk.stop || 0) / 1000) * STOP_K(speed),
      cost,
      // 烬断（残刃）：瞬断的冷却减半
      cd: sk.cd * (1 - Math.min(80, cdr) / 100),
      leech, stun, ailment, echo: isAura ? 0 : echo,
      // 混沌异常值（渊缚）另外再加的累积速度（异常累积速度 ailment 对它同样生效）
      bindAil: mScale ? 0 : S.bindAil || 0,
      // 黑焰：每一击额外的混沌伤害（%）。光环自己的脉冲（霜环）不带
      flame: isAura ? 0 : G.flamePct(mScale),
      flameAil: isAura ? 0 : G.flameAil(), // 刻式「噬契」：黑焰那一部分累积混沌异常的倍率（没有时 0）
      reserve: isAura ? G.auraReserve(id) : 0,
      minion: null,
      // 攻击技能：attack 为 true，weapon 是此刻的武器面板（G.weaponStats），wm 武器倍率，levelK 等级加成
      attack: isAttack,
      weapon: wp,
      wm: isAttack ? G.skillWm(sk) : 0,
      levelK: isAttack ? 1 + G.ATTACK_GEM_LVL * (lvl - 1) : mScale ? G.minionDmgK(lvl) : 1 + 0.2 * (lvl - 1),
      asMinion: mScale && !isMinion, // 魂潮：伤害按召唤物算的武器技（ctx.minion 仍为 null）
    };
    if (sk.basic) {
      // 远程普攻的平均出手间隔（秒伤估算用）：左轮把装填摊进每一发
      if (sk.clip) ctx.cycle = (sk.clip * ctx.time + sk.reload / speed) / sk.clip;
      // 弓的增益（一矢穿心：必定暴击、贯穿所有；元素满溢：异常累积翻倍）
      const b = G.rangedBuff();
      if (b && fam === 'bow') {
        if (b.crit) ctx.crit = Math.max(ctx.crit, b.crit);
        if (b.pierce) ctx.pierce += b.pierce;
        if (b.ailment) ctx.ailment = (100 + ctx.ailment) * b.ailment - 100;
      }
    }
    if (isMinion) {
      // 召唤物：生命随宝石等级成长（比伤害快一些，跟得上怪物的伤害成长）；攻速吃「召唤物速度」和迅捷，移动只吃前者
      const spdK = Math.max(0.2, 1 + ((S.minionSpeed || 0) + mSpeed) / 100);
      const atkK = spdK * (1 + speedPct / 100);
      // 数量上限：仆从吃天赋 / 护符的「仆从数量」和镶着的群聚；焚骨祭司只吃镶在它身上的群聚；守像固定 1 尊
      let cap = sk.cap + (sk.minion === 'thrall' ? Math.max(0, Math.round((S.minionCap || 0) + mCap)) : sk.minion === 'pyre' ? Math.max(0, Math.round(mCap)) : 0);
      if (sk.capK) {
        // 刻式（骸卫 / 炎祭）：上限按比例折，凑不成整数的那一点折进每一击的伤害（数量加成越多也不会越超标）
        const c = Math.max(1, cap * sk.capK);
        cap = Math.max(1, Math.round(c));
        ctx.more *= c / cap;
      }
      ctx.minion = {
        kind: sk.minion, cap,
        life: Math.max(1, Math.round((sk.life * G.minionLifeK(lvl) + inh.life) * Math.max(0.1, 1 + ((S.minionLife || 0) + mLife) / 100))),
        dr: Math.min(75, (sk.dr || 0) + mDR),
        // 继承来的护甲 / 抗性（受击时和你一样结算：护甲减物理、抗性减元素）；inherit 是技能卡上显示用的明细
        armour: inh.armour,
        res: inh.res,
        inherit: inh,
        interval: sk.rate / atkK,
        move: sk.move * spdK,
        reach: sk.reach || 1,
        cleave: sk.cleave || 0, // 仆从横斩额外带到的敌人数与扇面（弧度）
        hold: sk.hold || 2, // 同时最多牵制几只小怪（多出来的去找玩家）
        arc: ((sk.arc || 0) * Math.PI) / 180,
        radius: (sk.radius || 0) * Math.sqrt(ctx.area),
        taunt: sk.taunt || null,
        size: sk.size, // 刻式「骸卫」：体型倍率（原式没有）
      };
      if (sk.minion === 'pyre') {
        // 焚骨祭司：火弹爆炸 / 坠焰的半径吃扩域；多重投射让它一次掷出几枚（分头砸向不同的敌人）
        const mi = ctx.minion, ak = Math.sqrt(ctx.area);
        mi.keep = sk.keep;
        mi.flee = sk.flee;
        mi.speed = sk.speed;
        mi.explode = sk.explode * ak;
        mi.bolts = Math.max(1, ctx.proj);
        mi.charge = sk.noCharge ? null : sk.charge; // 刻式「连焚」：没有焰蓄、没有大招
        mi.chargeK = 1 + Math.max(0, S.minionCharge || 0) / 100; // 焰蓄攒得快（天赋「焚骨圣咏」）
        mi.meteor = Object.assign({}, sk.meteor, { radius: sk.meteor.radius * ak, r: sk.meteor.r * ak });
        mi.beam = sk.beam;
      }
    }
    if (P.relic.any) G.relicCtx(ctx); // 渊契：必然、独骸、同殇等改上下文
    return ctx;
  };

  // 召唤物继承你的装备（天赋里的 mWeapon / mDef / mLife，单位 %）：
  //   武器：每一击附加 你武器的伤害区间 × mWeapon% × 物品等级折算（G.inheritGate：物品等级 INHERIT_ILVL0 以下为 0，到 INHERIT_ILVL 线性涨满）× 魂幡倍率（BASES 里的 soul，魂幡武器伤害低，按倍数计）× 技能的 inherit 系数
  //        （守像出手慢、一击重，系数更高）——武器的物品等级、成色和本地词缀从此也影响召唤师；
  //   防御：护甲 = 你的护甲 × mDef%，各项抗性 = 你的抗性 × mDef%（封顶 75%）；
  //   生命：额外基础生命 = 你装备上「+最大生命」的总和 × mLife% × inherit 系数（再吃召唤物生命加成）。
  //   防御和生命同样按物品等级折算：用武器以外的装备的平均物品等级。
  // 返回 { weapon, def, lifePct 三项比例, add 附加伤害 [最小, 最大] 或 null, armour, res: { fire, cold, light }, life, soul, gate, gateDef, ilvlDef }
  // 折算从物品等级 INHERIT_ILVL0 起步：层级 0 的装备（物品等级 ≤ 19）几乎继承不到，这条线是给轮回层级用的，
  // 天赋盘变大后层级 0 的召唤师不会因此变强（改版前统御只有 13 个节点）
  G.INHERIT_ILVL0 = 12;
  G.INHERIT_ILVL = 46;
  G.inheritGate = (ilvl) => G.clamp((ilvl - G.INHERIT_ILVL0) / (G.INHERIT_ILVL - G.INHERIT_ILVL0), 0, 1);
  G.minionInherit = function (sk) {
    const S = P.S;
    const k = (sk && sk.inherit) || 1;
    const item = G.save.equip.weapon;
    // 器魂随武器的物品等级成长（层级 0 的武器只继承一成左右）：召唤师靠后期的装备变强，而不是在层级 0 就把这条线点满
    const gate = item ? G.inheritGate(item.ilvl || 1) : 0;
    // 万魂旗（魂火轮回）：继承武器伤害的比例 × wMul，最多 SOULFIRE.inherit 倍；SOULFIRE.gated 时提高的部分也跟着上面的折算走
    const wMul = P.uMech === 'soul' ? 1 + (G.SOULFIRE.inherit - 1) * (G.SOULFIRE.gated ? gate : 1) : 1;
    const wPct = Math.max(0, S.mWeapon || 0) * wMul;
    const dPct = Math.min(100, Math.max(0, S.mDef || 0));
    const lPct = Math.max(0, S.mLife || 0);
    const base = item && G.BASES.weapon[item.baseIdx];
    // 焚骨祭司（casterInherit）：拿着施法武器（杖 / 短杖 / 魂幡）时按 casterInherit 倍继承，和魂幡的倍数取高的那个
    const soul = Math.max((base && base.soul) || 1, base && base.caster && sk && sk.casterInherit ? sk.casterInherit : 1);
    // 防御 / 生命：按身上其余装备的平均物品等级折算（和武器一样靠后期的装备成长）
    let iSum = 0, iN = 0;
    for (const slot of G.SLOTS) {
      const it = slot !== 'weapon' && G.save.equip[slot];
      if (it) { iSum += it.ilvl || 1; iN++; }
    }
    const ilvlDef = iN ? Math.round(iSum / iN) : 0;
    const gateDef = iN ? G.inheritGate(iSum / iN) : 0;
    const dK = (dPct / 100) * gateDef;
    let add = null;
    if (wPct > 0 && gate > 0) {
      const w = G.weaponStats(item);
      const f = (wPct / 100) * gate * soul * k;
      add = [w.min * f, w.max * f];
    }
    const res = {};
    for (const t of G.ELEMS) res[t] = Math.min(75, Math.max(0, (P.res[t] || 0) * dK));
    return {
      weapon: wPct, wBase: Math.max(0, S.mWeapon || 0), wMul, def: dPct, lifePct: lPct, soul, add, gate, ilvl: item ? item.ilvl : 0, gateDef, ilvlDef,
      armour: Math.round((P.armour || 0) * dK),
      res,
      life: Math.round((P.gearLife || 0) * lPct / 100 * gateDef * k),
    };
  };

  G.MINION_LIFE_LVL = 0.28; // 召唤物生命每级宝石的成长（伤害是 MINION_DMG_LVL，生命要跟得上怪物伤害 1.15 倍 / 级的成长）
  // 宝石 20 级以上（轮回层级里）每级再多 MINION_LIFE_LATE：线性成长越往后占比越小，仆从会跟不上层级 2 的怪物伤害
  G.MINION_LIFE_LATE = 0.8;
  G.minionLifeK = (lvl) => 1 + G.MINION_LIFE_LVL * (lvl - 1) + G.MINION_LIFE_LATE * Math.max(0, lvl - 20);
  G.MINION_DMG_LVL = 0.11; // 召唤物伤害每级宝石的成长（其他技能是 0.2；召唤宝石的基础伤害相应高一截）
  G.MINION_DMG_LATE = 0.09; // 宝石 20 级以上每级再多这么多（和生命一样，层级 0 用不到；召唤物吃不到武器 / 词缀阶的成长，层级 2 靠它跟上）
  // 宝石 MINION_DMG_KNEE 级以上（层级 1 后段起）每级再乘 MINION_DMG_GROW：怪物生命是按等级指数成长的（每级 ×1.08–1.12），
  // 线性的等级加成越往后占比越小（32 级时每级只 +3.6%），别的流派在这一段还有武器物品等级、词缀阶、暴击一起往上乘，
  // 召唤物只有宝石等级和继承这两条路，平衡机器人量出来层级 1 末区到层级 2 掉得最狠。乘上这一项后每级的成长跟得上怪物
  G.MINION_DMG_KNEE = 28;
  G.MINION_DMG_GROW = 1.04;
  G.minionDmgK = (lvl) => (1 + G.MINION_DMG_LVL * (lvl - 1) + G.MINION_DMG_LATE * Math.max(0, lvl - 20)) * Math.pow(G.MINION_DMG_GROW, Math.max(0, lvl - G.MINION_DMG_KNEE));

  // 估算秒伤（技能卡、换装评估用）：平均击中 ÷ 每次出手实际占用的时间（含命中时的顿帧），受冷却限制。
  // 召唤技能：数量上限内的召唤物一起出手的秒伤（单体）
  // 冷却技能按冷却折算（单独循环施放时的秒伤）；光环是每秒脉冲次数 × 每跳伤害（单体）
  G.skillDps = function (ctx) {
    const mi = ctx.minion;
    if (mi && mi.beam && mi.charge) {
      // 焚骨祭司打单体：每 charge.max 枚火弹接一轮灼链（单体时一弹只攒 1 点焰蓄）
      const ticks = Math.floor(mi.beam.dur / (mi.beam.tick * Math.min(1, mi.interval / ctx.sk.rate)) + 1e-6); // 召唤物速度也加快灼链的跳数
      const cyc = mi.charge.max * mi.interval + mi.beam.dur;
      return (G.avgHit(ctx) * mi.cap * (mi.charge.max + ticks * mi.beam.mult)) / cyc;
    }
    if (mi) return (G.avgHit(ctx) * mi.cap) / Math.max(0.05, mi.interval);
    return G.avgHit(ctx) * G.skillRate(ctx);
  };
  // 每秒出手（施放 / 斩击 / 脉冲）次数：含命中时的顿帧，受冷却限制
  G.skillRate = function (ctx) {
    return 1 / Math.max((ctx.cycle || ctx.time) + ctx.stopAvg, ctx.cd || 0, 0.01);
  };

  // 每种伤害类型在暴击前的倍率
  const typeMult = (ctx, t) => Math.max(0, 1 + (ctx.inc[t] || 0) / 100) * (ctx.moreType[t] === undefined ? 1 : ctx.moreType[t]);

  G.calcHit = function (ctx, mult) {
    const m = mult === undefined ? 1 : mult;
    const parts = {};
    let pre = 0;
    for (const t in ctx.base) {
      const b = ctx.base[t];
      const v = G.rand(b[0], b[1]) * typeMult(ctx, t);
      parts[t] = v;
      pre += v;
    }
    // 额外伤害按暴击前的总伤害折算
    for (const t in ctx.extra) parts[t] = (parts[t] || 0) + (pre * ctx.extra[t]) / 100;
    // 黑焰：同一个 pre（和注入相加，不再吃混沌加成）
    if (ctx.flame > 0) parts.chaos = (parts.chaos || 0) + (pre * ctx.flame) / 100;
    const crit = P.relic.qianmu ? G.relicCrit(ctx) : Math.random() * 100 < ctx.crit; // 渊契「必然」：暴击按计数
    const k = ctx.more * (crit ? ctx.critMulti / 100 : 1) * m;
    let total = 0;
    for (const t in parts) {
      parts[t] *= k;
      total += parts[t];
    }
    // flame：其中黑焰的那一部分（刻式「噬契」累积混沌异常时另算）
    return { total, parts, crit, flame: ctx.flame > 0 ? ((pre * ctx.flame) / 100) * k : 0 };
  };

  G.avgHit = function (ctx) {
    let pre = 0;
    for (const t in ctx.base) pre += ((ctx.base[t][0] + ctx.base[t][1]) / 2) * typeMult(ctx, t);
    let extraPct = ctx.flame > 0 ? ctx.flame : 0;
    for (const t in ctx.extra) extraPct += ctx.extra[t];
    const critK = 1 + (ctx.crit / 100) * (ctx.critMulti / 100 - 1);
    // 连击技能按三段的平均倍率折算（ctx.time 也是平均段长）；武器技按一次施放对单体的倍率总和（useMult）折算
    // ——必定暴击的（影刺）按暴击伤害算，不按暴击率折算
    const sk = ctx.sk;
    return pre * (1 + extraPct / 100) * ctx.more * (sk.sureCrit ? ctx.critMulti / 100 : critK) * (sk.comboAvg || sk.useMult || 1);
  };

  // 技能消耗：bloodMagic 时扣生命（不会降到 1 以下），否则扣魔力
  G.canAfford = function (cost) {
    if (cost <= 0) return true;
    return P.S.bloodMagic ? P.life - cost >= 1 : P.mana >= cost;
  };
  function payCost(cost) {
    if (cost <= 0) return;
    if (P.S.bloodMagic) P.life = Math.max(1, P.life - cost);
    else P.mana = Math.max(0, P.mana - cost);
  }

  // =====================================================================
  // 战斗
  // =====================================================================
  function wake(e) {
    e.awake = true;
    if (e.pack === undefined || e.pack === null) return;
    for (const o of state.enemies) if (o.pack === e.pack) o.awake = true;
  }

  // 圆内（算上敌人半径）还活着的敌人，返回新数组，方便边打边杀
  function enemiesIn(x, z, R) {
    const out = [];
    for (const e of state.enemies) {
      if (e.dead) continue;
      if (dist(e.x, e.z, x, z) - e.r <= R) out.push(e);
    }
    return out;
  }

  const NO_INFO = {};
  // 最近一次 G.hitEnemy 的结果（一次挥砍打到好几个敌人时，技能逻辑逐个读它来汇总）
  const lastHit = (G.lastHit = { crit: false, type: 'phys', killed: false, total: 0 });
  const KB_DECAY = (G.KB_DECAY = 7); // 击退速度每秒的衰减率：初速度 = 距离 × 衰减率（enemies.js 按同一个数衰减）
  const CHAIN_KEEP = 2.5; // 连击计数：多久没有命中就清零
  const FOCUS_KEEP = (G.FOCUS_KEEP = 4); // 集火目标保留的秒数

  // 把敌人朝 ang 方向推开 dist（世界单位，按体重折算）；真正的位移在 updateEnemies 里带着撞墙检测做
  function knock(e, ang, dist) {
    if (!(dist > 0) || e.isBoss || e.dead) return;
    // 砸地 / 引信蓄力中的怪钉在原地（预警圈的位置才对得上）；被打断的不在此列
    if (e.state === 'fuse' || e.state === 'dash' || (e.state === 'windup' && e.def.ai === 'slam')) return; // 陨角兽冲锋中也不被推离冲锋道
    let v = (dist * KB_DECAY) / (e.mass || 1);
    if (e.freeze > 0 || e.brokenT > 0 || e.bindT > 0) v *= 0.35; // 渊缚中也只推三成多，免得刚拽进来又被打飞
    e.kvx += Math.sin(ang) * v;
    e.kvz += Math.cos(ang) * v;
    const m = Math.hypot(e.kvx, e.kvz), cap = 26;
    if (m > cap) {
      e.kvx *= cap / m;
      e.kvz *= cap / m;
    }
  }

  // ---------- 元素异常值 ----------
  const BU = G.BUILDUP;
  // 爆燃 / 感电电弧这类「异常触发出来的伤害」：固定数值、不暴击、不吃任何加成（加成在算触发量时已经算过了）
  const PROC_SK = { w: 0, kb: 0, poise: 0 };
  function procCtx(type, v) {
    const base = {};
    base[type] = [v, v];
    return { sk: PROC_SK, base, inc: {}, moreType: {}, more: 1, extra: {}, crit: 0, critMulti: 100, ailment: 0, stun: 0, leech: 0, echo: 0, area: 1, proc: true };
  }
  // 敌人某个元素当前的阈值（首领随触发次数成长）
  G.buThreshold = function (e, t) {
    if (!e.bu) G.initBuildUp(e);
    return e.buTh * e.buGrow[t];
  };
  G.initBuildUp = function (e) {
    e.bu = { fire: 0, cold: 0, light: 0, chaos: 0 };
    e.buT = { fire: 0, cold: 0, light: 0, chaos: 0 }; // 距离开始回落还有多久
    e.buGrow = { fire: 1, cold: 1, light: 1, chaos: 1 };
    e.buTrig = { fire: 0, cold: 0, light: 0, chaos: 0 }; // 各元素触发过几次
    // 渊缚：bindT 定身剩余秒数；bindX / bindZ 牵引的目标点，bindLeft 还能拽多远；bossBind 首领的减速剩余秒数；
    // voidT / voidX / voidZ 渊陷的牵引（死亡触发拽附近的小怪）
    e.bindT = e.bindLeft = e.bossBind = e.voidT = 0;
    e.bindX = e.bindZ = e.voidX = e.voidZ = 0;
    e.buFire = e.buFireN = 0; // 灌进火焰异常值的火焰伤害（已乘上异常累积速度）与命中次数：爆燃按平均每击算
    e.buLit = e.buLitN = 0; // 同上，闪电：死亡放电按平均每击算
    e.buTh = Math.max(1, e.maxHp * (e.isBoss ? BU.boss : e.elite ? BU.thElite : BU.th));
    e.shockT = e.shockCd = e.bossChill = e.blastT = 0;
  };
  // 爆燃（含尸爆）的伤害 = 灌进火焰异常值期间平均每击的火焰伤害 × (1 + 异常累积速度%) × blast，封顶为阈值 × blastCap：
  // 跟着你的火焰伤害走，而不是跟着爆的那只怪的生命走
  function blastDmg(e) {
    return Math.min((e.buFire / Math.max(1, e.buFireN)) * BU.blast, e.buTh * BU.blastCap);
  }
  // 触发记进 procs，带上当前在结算第几代（见 flushProcs）
  function queueProc(procs, p) {
    p.gen = procGen;
    procs.push(p);
  }
  // 往某条异常值里灌 frac（0..1 的比例，已折算好阈值与各种速度）。所有来源（命中、碎冰……）都走这里：
  // 冻着 / 感电中的锁定、回落计时、灌满触发都在这一处。满了就把触发记进 procs，返回是否触发
  function fillMeter(e, t, frac, procs) {
    if (!e.bu) G.initBuildUp(e);
    if (!(frac > 0)) return false;
    if (t === 'cold' && (e.freeze > 0 || e.bossChill > 0 || e.brokenT > 0)) return false; // 冻着 / 重度冰缓 / 破绽中不再累积
    if (t === 'light' && e.shockT > 0) return false;
    if (t === 'chaos' && (e.bindT > 0 || e.bossBind > 0 || e.brokenT > 0)) return false; // 渊缚中 / 破绽中不再累积
    e.bu[t] += frac;
    e.buT[t] = BU.hold;
    if (e.bu[t] < 1) return false;
    if (e.hp <= 0) {
      // 这一击同时打死了它：不走活着时的触发，留满让 G.killEnemy 按死亡触发结算（冰霜才会碎成冰碴、闪电才会放电）
      e.bu[t] = 1;
      return false;
    }
    e.bu[t] = 0;
    queueProc(procs, { t, e, fire: t === 'fire' ? blastDmg(e) : 0 });
    if (t === 'fire') e.buFire = e.buFireN = 0; // 闪电的平均每击不清：感电中死掉也要放电（回落到底才清）
    return true;
  }
  G.fillMeter = function (e, t, frac) {
    fillMeter(e, t, frac, procQ);
    flushProcs();
  };
  // 一击的元素伤害累积进异常值；满了就把触发记进 procs（由最外层的 G.hitEnemy 统一结算，触发出来的伤害不会打乱技能逐个读取 lastHit）
  function addBuildUp(e, parts, ailment, procs, bindAil) {
    if (!e.bu) G.initBuildUp(e);
    const k = Math.max(0, 1 + (ailment || 0) / 100);
    for (const t of G.BUILD_TYPES) {
      const v = parts[t];
      if (!(v > 0)) continue;
      if (t === 'chaos') {
        // 混沌：另外再吃渊缚累积速度
        fillMeter(e, t, (v / G.buThreshold(e, t)) * Math.max(0, k + (bindAil || 0) / 100) * BU.rate.chaos, procs);
        continue;
      }
      if (P.relic.yibian && relicMix(e, t, v, k, procs)) continue; // 渊契「混相」：三种元素灌进同一条
      // 锁定中（见 fillMeter）的这一击不计入平均每击
      if (t === 'cold' && (e.freeze > 0 || e.bossChill > 0 || e.brokenT > 0)) continue;
      if (t === 'light' && e.shockT > 0) continue;
      if (t === 'fire') {
        e.buFire += v * k;
        e.buFireN++;
      } else if (t === 'light') {
        e.buLit += v * k;
        e.buLitN++;
      }
      fillMeter(e, t, (v / G.buThreshold(e, t)) * k * (BU.rate[t] || 1), procs);
    }
  }
  G.addBuildUp = function (e, parts, ailment, bindAil) {
    const procs = [];
    addBuildUp(e, parts, ailment, procs, bindAil);
    for (const p of procs) triggerAilment(p);
    return procs.length;
  };
  // 满了：冻结 / 爆燃 / 感电
  function triggerAilment(p) {
    const W = G.world;
    const e = p.e;
    const h = e.height || 2;
    const ty = Math.min(3.4, h * (e.elite ? 1.3 : 1)) + 0.3;
    const st = state.stats;
    if (p.t === 'mix') return relicMixFire(p); // 渊契「混相」灌满
    e.buTrig[p.t]++;
    // 三相共鸣直接灌满的那一下不让首领的阈值变高（不然共鸣越多，首领反而越难触发异常）
    // 拿着三相之心时，正常触发让首领阈值变高的幅度 × TRI.grow；烬铸技「三相天灾」打出来的触发不打这个折扣（首领照常越打越难）
    if (e.isBoss && !p.spread) e.buGrow[p.t] = Math.min(BU.bossGrowMax, e.buGrow[p.t] + BU.bossGrow * (P.uMech === 'tri' && !(p.storm || stormDepth > 0) ? G.TRI.grow : 1));
    if (p.t === 'cold') {
      if (e.dead) return;
      st.freezes = (st.freezes || 0) + 1;
      if (e.isBoss) {
        e.bossChill = BU.bossChill;
        W.text(e.x, e.z, '冰缓', '#bfeaff', 26, { kind: 'tag', y: ty, py: -30 });
      } else {
        // 刻式「寒心」在技能栏上：冻结时长 × freezeK
        e.freeze = Math.max(e.freeze || 0, (e.elite ? BU.freezeElite : BU.freeze) * (G.SKILLS.nova.freezeK && G.auraOn('nova') ? G.SKILLS.nova.freezeK : 1));
        W.text(e.x, e.z, '冻结', '#d6f3ff', e.elite ? 24 : 20, { kind: 'tag', y: ty });
      }
      W.freezeFx(e.x, e.z, e.r, h, !!e.isBoss);
      G.sfx('impact', { type: 'cold', w: 1, crit: false });
    } else if (p.t === 'fire') {
      st.blasts = (st.blasts || 0) + 1;
      e.blastT = 1;
      const R = BU.blastR + e.r * 0.5;
      const dmg = p.fire;
      W.blastFx(e.x, e.z, R);
      W.text(e.x, e.z, '爆燃', '#ffb070', e.isBoss ? 26 : 22, { kind: 'tag', y: ty, py: e.isBoss ? -30 : 0 });
      G.sfx('impact', { type: 'fire', w: 2, crit: false });
      fireBlast(e.x, e.z, R, dmg);
    } else if (p.t === 'light') {
      if (e.dead) return;
      st.shocks = (st.shocks || 0) + 1;
      e.shockT = BU.shock;
      e.shockCd = 0;
      W.text(e.x, e.z, '感电', '#fff08a', e.isBoss ? 26 : 22, { kind: 'tag', y: ty, py: e.isBoss ? -30 : 0 });
      W.burst(e.x, h * 0.6, e.z, 0xffe45e, 18, 5, 0.35);
      G.sfx('impact', { type: 'light', w: 1, crit: false });
    } else if (p.t === 'chaos') {
      if (e.dead) return;
      triggerBind(e, ty);
      return; // 混沌不是元素：不引发三相共鸣
    }
    // 三相之心：正常触发的异常引发共鸣；共鸣直接灌满触发的（p.spread）不再引发，链条到此为止
    if (P.uMech === 'tri' && !p.spread && !P.relic.yibian) triSpread(e, p.t, p.t === 'fire' ? p.fire : e.buFireN > 0 ? Math.min((e.buFire / e.buFireN) * BU.blast, e.buTh * BU.blastCap) : 0);
  }

  // ---------- 渊缚（混沌异常）----------
  // 飘字节流：怪堆里渊缚 / 渊陷接连触发时，同一片地方（TAG_R 米内）每 TAG_GAP 秒只冒一个字；精英、首领照常每次都冒
  const TAG_GAP = 1, TAG_R = 6;
  const tagLog = [];
  function tagOk(kind, x, z) {
    const now = state.time;
    for (let i = tagLog.length - 1; i >= 0; i--) if (now - tagLog[i].t >= TAG_GAP || now < tagLog[i].t) tagLog.splice(i, 1);
    for (const g of tagLog) if (g.kind === kind && dist(g.x, g.z, x, z) <= TAG_R) return false;
    tagLog.push({ kind, x, z, t: now });
    return true;
  }
  // 小怪 / 精英：定身并往最近的黑洞（bindR 以内）拽，没有黑洞就往怪群中心（packR 以内活着的敌人的平均位置）拽，附近只有它自己时只定身；
  // 首领：不定不拽，bossBind 秒减速。拽的位移在 enemies.js 里按 bindX / bindZ / bindLeft 每帧走（撞墙即停、冻结中不拽）
  function triggerBind(e, ty) {
    const W = G.world;
    const st = state.stats;
    st.binds = (st.binds || 0) + 1;
    if (e.isBoss) {
      e.bossBind = BU.bossBind;
      W.text(e.x, e.z, '渊缚', '#ffb3e6', 26, { kind: 'tag', y: ty, py: -30 });
      if (W.bindFx) W.bindFx(e.x, e.z, e.r, e.height || 2, true);
      G.sfx('impact', { type: 'chaos', w: 1, crit: false });
      return;
    }
    e.bindT = Math.max(e.bindT || 0, e.elite ? BU.bindElite : BU.bind);
    let tx = null, tz = null;
    const hole = nearestHole(e.x, e.z, BU.bindR);
    if (hole) {
      tx = hole.x;
      tz = hole.z;
    } else {
      let sx = 0, sz = 0, n = 0;
      for (const o of state.enemies) {
        if (o.dead || o.isBoss || dist(o.x, o.z, e.x, e.z) > BU.packR) continue;
        sx += o.x;
        sz += o.z;
        n++;
      }
      if (n > 1) {
        tx = sx / n;
        tz = sz / n;
      }
    }
    if (tx !== null) {
      e.bindX = tx;
      e.bindZ = tz;
      e.bindLeft = BU.bindPullMax;
    } else e.bindLeft = 0;
    if (e.elite || tagOk('bind', e.x, e.z)) W.text(e.x, e.z, '渊缚', '#ffb3e6', e.elite ? 24 : 20, { kind: 'tag', y: ty });
    if (W.bindFx) W.bindFx(e.x, e.z, e.r, e.height || 2, false);
    G.sfx('impact', { type: 'chaos', w: 1, crit: false });
    // 星蚀（渊口）：触发渊缚的敌人脚下张开一道小黑洞
    if (P.uMech === 'void') voidMouth(e.x, e.z);
  }
  G.triggerBind = function (e) {
    triggerBind(e, Math.min(3.4, (e.height || 2) * (e.elite ? 1.3 : 1)) + 0.3);
  };
  // 渊缚 / 渊陷的牵引速度（米 / 秒）：体重越大越慢
  G.bindPullSpeed = (e, v) => (v * (1 + Math.max(0, (P.S && P.S.pullK) || 0) / 100)) / Math.sqrt(e.mass || 1);

  // ---------- 烬铸武器的机制 ----------
  // 三相共鸣：src 身上触发了 t，半径 TRI.r 内的敌人（包括 src 自己）立刻获得另外两种元素各 TRI.k 条异常值。
  // 灌满的照常触发异常，但带上 spread 标记——不会再引发共鸣（防止无限连锁）；之后玩家的命中再把某一条灌满时，照常共鸣
  let triDepth = 0;
  // heat：源头的爆燃伤害（或它身上攒着的平均火焰伤害）。TRI.heat 时，被共鸣灌爆的敌人自己没攒过火焰伤害，就按这个爆
  function triSpread(src, t, heat) {
    if (triDepth > 0) return 0; // 双保险：共鸣结算途中不会再开一轮
    triDepth++;
    const R = G.TRI.r;
    const others = G.ELEMS.filter((x) => x !== t);
    const x0 = src.x, z0 = src.z;
    const hit = [];
    const trig = [];
    for (const o of state.enemies) {
      if (o.dead || dist(o.x, o.z, x0, z0) - o.r > R) continue;
      if (!o.bu) G.initBuildUp(o);
      let any = false;
      for (const u of others) {
        // 已经冰缓 / 感电的：灌不进去，改为把剩余时间续满（TRI.refresh）；冻结中 / 破绽中的不动
        if (u === 'cold' && (o.freeze > 0 || o.bossChill > 0 || o.brokenT > 0)) {
          if (G.TRI.refresh && o.bossChill > 0 && !(o.brokenT > 0)) { o.bossChill = Math.max(o.bossChill, BU.bossChill); any = true; }
          continue;
        }
        if (u === 'light' && o.shockT > 0) {
          if (G.TRI.refresh) { o.shockT = Math.max(o.shockT, BU.shock); any = true; }
          continue;
        }
        o.bu[u] += G.TRI.k;
        o.buT[u] = G.BUILDUP.hold;
        any = true;
        if (o.bu[u] >= 1) {
          o.bu[u] = 0;
          let fire = u === 'fire' ? Math.min((o.buFire / Math.max(1, o.buFireN)) * BU.blast, o.buTh * BU.blastCap) : 0;
          if (u === 'fire' && G.TRI.heat && heat > 0) fire = Math.max(fire, Math.min(heat, o.buTh * BU.blastCap));
          if (u === 'fire') o.buFire = o.buFireN = 0;
          trig.push({ t: u, e: o, fire, spread: true });
        }
      }
      if (any) hit.push(o);
    }
    state.stats.triSpreads = (state.stats.triSpreads || 0) + 1;
    state.stats.triTargets = (state.stats.triTargets || 0) + hit.length;
    if (G.world.triFx) G.world.triFx(x0, z0, R, t, hit.map((o) => ({ x: o.x, z: o.z, h: o.height || 2, self: o === src })));
    G.world.text(x0, z0, '三相共鸣', '#ffd9a8', src.isBoss ? 24 : 20, { kind: 'tag', y: Math.min(3.4, (src.height || 2) * 1.2) + 0.9, py: -48 });
    for (const p of trig) triggerAilment(p);
    triDepth--;
    return hit.length;
  }
  G.triSpread = triSpread;

  // 残刃引爆：MARK.mult 倍武器伤害的物理伤害（吃你的物理伤害提高、总伤害和暴击伤害——必定暴击；不再留下残刃），
  // 周围 MARK.r 米内的别的敌人挨 MARK.splash 倍
  const MARK_SK = { w: 2, kb: 0.8, poise: 30 };
  function markBurst(e) {
    if (!e || e.dead) return 0;
    const W = G.world;
    const S = P.S;
    const ws = G.weaponStats(G.save.equip.weapon);
    const k = G.MARK.mult;
    const ctx = {
      sk: MARK_SK, base: { phys: [ws.min * k, ws.max * k] }, inc: { phys: (S.incAll || 0) + (S.incPhys || 0) }, moreType: { phys: 1 },
      more: Math.max(0, (1 + (S.moreDmg || 0) / 100) * (1 - Math.min(90, S.ownLess || 0) / 100)), extra: {},
      crit: 100, critMulti: Math.max(100, 150 + (S.critMulti || 0)), ailment: 0, stun: 0, leech: 0, echo: 0, area: 1, proc: true,
    };
    const h = e.height || 2;
    const x0 = e.x, z0 = e.z, r0 = e.r;
    // 波及：引爆点周围 MARK.r 米内的别的敌人挨 MARK.splash 倍的同一击（先圈定再结算，免得打死目标后圈子跟着变）
    const near = G.MARK.splash > 0 ? enemiesIn(x0, z0, G.MARK.r + r0).filter((o) => o !== e) : [];
    let dmg = G.hitEnemy(e, ctx, 1, { ang: Math.atan2(x0 - P.x, z0 - P.z), w: 2, kb: 0.8, poise: 30, quiet: true, proc: true, mark: true });
    for (const o of near) {
      if (o.dead) continue;
      dmg += G.hitEnemy(o, ctx, G.MARK.splash, { ang: Math.atan2(o.x - x0, o.z - z0), w: 1.5, kb: 0.6, poise: 15, quiet: true, proc: true, mark: true }) || 0;
    }
    state.stats.markSplash = (state.stats.markSplash || 0) + near.length;
    if (W.markBurstFx) W.markBurstFx(x0, z0, h, r0, G.MARK.r);
    W.text(x0, z0, '残刃', '#ffc27a', e.isBoss ? 26 : 22, { kind: 'tag', y: Math.min(3.4, h * 1.2) + 0.5, py: e.isBoss ? -30 : 0 });
    G.hitStop(70);
    W.shake(0.28);
    G.sfx('impact', { type: 'phys', w: 2, crit: true });
    G.sfx('markburst');
    state.stats.markBursts = (state.stats.markBursts || 0) + 1;
    return dmg;
  }
  G.markBurst = markBurst;
  function markJump(e) {
    let best = null, bd = G.MARK.jump || 0;
    for (const o of state.enemies) {
      if (o.dead || o === e) continue;
      const d = dist(o.x, o.z, e.x, e.z) - o.r;
      if (d <= bd) { bd = d; best = o; }
    }
    if (!best) return null;
    const W = G.world;
    best.marks = (best.marks || 0) + e.marks;
    state.stats.markJumps = (state.stats.markJumps || 0) + 1;
    if (W.markJumpFx) W.markJumpFx(e.x, e.z, best.x, best.z, best.height || 2);
    if (best.marks >= G.MARK.max) {
      best.marks = 0;
      if (procDepth > 0) procQ.push({ t: 'mark', e: best });
      else markBurst(best);
    }
    if (W.bladeMarks) W.bladeMarks(best.ent, best.marks, best);
    return best;
  }
  G.markJump = markJump;

  // 魂火轮回：召唤物倒下时炸开，对周围 SOULFIRE.r 内的敌人造成它最大生命 × SOULFIRE.k 的火焰伤害（不暴击、不累积异常值）
  G.soulFire = function (m) {
    if (P.uMech !== 'soul' || !m || !state.zone) return 0;
    const v = (m.maxHp || 0) * G.SOULFIRE.k * ((m.ctx && m.ctx.minion && m.ctx.minion.soulK) || 1); // 骸王按普通仆从的生命算
    const R = G.SOULFIRE.r + (m.r || 0.5) * 0.5;
    const x = m.x, z = m.z;
    if (G.world.soulFireFx) G.world.soulFireFx(x, z, R, m.height || 2);
    G.sfx('soulfire');
    state.stats.soulBursts = (state.stats.soulBursts || 0) + 1;
    let n = 0;
    if (v > 0) {
      const ctx = procCtx('fire', v);
      for (const o of enemiesIn(x, z, R)) {
        G.hitEnemy(o, ctx, 1, { ang: Math.atan2(o.x - x, o.z - z), w: 1, kb: 1.0, poise: 10, quiet: true, proc: true, noBuild: true });
        n++;
      }
    }
    state.stats.soulHits = (state.stats.soulHits || 0) + n;
    return n;
  };
  // 感电的敌人挨了一下：射出至多 shockN 道电弧，射向附近最近的别的敌人；附近一个别的敌人都没有时，只有一道打回它自己。电弧不再触发电弧
  function shockDischarge(e, total) {
    if (!(total > 0)) return;
    e.shockCd = BU.shockGap;
    const tgts = nearestOthers(e, BU.shockR, BU.shockN);
    if (!tgts.length && !e.dead) tgts.push(e);
    shootBolts(e, tgts, total * BU.bolt);
    state.stats.bolts = (state.stats.bolts || 0) + tgts.length;
  }
  // 爆燃 / 尸爆的爆炸：半径 R 内的敌人各挨一下 dmg 的火焰伤害（不累积异常值，所以不会连锁出新的爆燃）
  function fireBlast(x, z, R, dmg) {
    if (!(dmg > 0)) return;
    const ctx = procCtx('fire', dmg);
    for (const o of enemiesIn(x, z, R)) G.hitEnemy(o, ctx, 1, { ang: Math.atan2(o.x - x, o.z - z), w: 1, kb: 1.2, poise: 0, quiet: true, proc: true, noBuild: true });
  }
  // e 身边 R 以内最近的至多 n 个别的（活着的）敌人
  function nearestOthers(e, R, n) {
    const near = [];
    for (const o of state.enemies) {
      if (o === e || o.dead) continue;
      const d = dist(o.x, o.z, e.x, e.z) - o.r;
      if (d <= R) near.push({ o, d });
    }
    near.sort((a, b) => a.d - b.d);
    return near.slice(0, n).map((m) => m.o);
  }
  // 从 e 身上向 tgts 各射一道 v 点闪电伤害的电弧（电弧不再放电弧、不累积异常值）
  function shootBolts(e, tgts, v) {
    const W = G.world;
    const ctx = procCtx('light', v);
    const y0 = (e.height || 2) * 0.6;
    for (const o of tgts) {
      W.spark(e.x, y0, e.z, o.x, (o.height || 2) * 0.55, o.z, o === e);
      G.hitEnemy(o, ctx, 1, { ang: Math.atan2(o.x - e.x, o.z - e.z), w: 0, kb: 0.15, poise: 0, quiet: true, proc: true, bolt: true, noBuild: true, faint: true });
    }
  }

  // =====================================================================
  // 渊契（稀有度 4）：身上的机制汇总、各技能函数里一行钩子调用的实现、掉落与保底
  // 判断点都是 P.relic[id]；数值在 data.js 的 G.RELIC_MECH。技能函数里只留一行 G.relicXxx(...) 的调用，逻辑都在这里
  // =====================================================================
  const RM = G.RELIC_MECH;
  // 运行时状态（不存档）：crit 必然的暴击计数；spin / spinCtx / spinR 蓄潮的层数和最后一跳的上下文；slamT 踏震的间隔；
  // metT 星雨距离下一次自动落下的秒数；bridges 电桥；chainT 锁链特效的节流；kingT 骸王外形的检查间隔；shareT 同殇连线的节流
  const RQ = { crit: 0, spin: 0, spinCtx: null, spinR: 0, spinFull: false, slamT: 0, metT: 0, bridges: [], chainT: 0, kingT: 0, shareT: 0 };
  G.relicState = RQ; // 测试 / 调试用

  // computeStats 里调用：按身上的装备汇总 P.relic（同一种机制穿两件也只算一次）。巅峰专属的数据桩还没有机制，不算
  G.relicSync = function () {
    const r = P.relic;
    for (const k in r) delete r[k];
    const eq = G.save && G.save.equip;
    if (!eq) return r;
    for (const slot of G.SLOTS) {
      const it = slot !== 'weapon' && eq[slot];
      const R = it && it.rarity === 4 && G.RELICS[it.rq];
      if (R && !R.pinnacle && R.slot === slot) {
        r[it.rq] = true;
        r.any = true;
      }
    }
    if (!r.qianmu) RQ.crit = 0;
    if (!r.nuchao) RQ.spin = 0;
    return r;
  };

  // ---------- 保底和掉落 ----------
  // 保底的键：首领 / 异兆来源按渊契 id，烈印来源两件共用 'seal'
  G.relicPityKeys = () => G.RELIC_IDS.filter((id) => G.RELICS[id].src === 'boss' || G.RELICS[id].src === 'enc').concat(['seal']);
  G.relicPityMax = (k) => (k === 'seal' ? G.RELIC_DROP.seal.pity : G.RELICS[k] && G.RELICS[k].src === 'enc' ? G.RELIC_DROP.enc.pity : G.RELIC_DROP.boss.pity);
  // 按几率 p 掷一次：连续 max 次没掉，这一次必掉；掉了清零，没掉 +1（计数存档）
  function relicRoll(key, p, max) {
    const U = G.save.relic;
    const n = U.pity[key] || 0;
    if (n >= max || Math.random() < p) {
      delete U.pity[key];
      return true;
    }
    U.pity[key] = n + 1;
    return false;
  }
  G.relicRoll = relicRoll;
  // 掉一件渊契：大字提示、计数（和烬铸一样）
  function relicSpawn(id, ilvl, x, z) {
    const item = G.rollRelic(id, ilvl);
    if (!item) return null;
    G.spawnLoot('item', item, x, z);
    G.sfx('unique');
    if (G.ui.bigToast) G.ui.bigToast(G.RELIC_NAME, item.name, G.RELIC_COLOR, G.RELICS[id].mechName);
    state.stats.relicDrops = (state.stats.relicDrops || 0) + 1;
    return item;
  }
  // 烈印的总权重 W（D3 的 G.runSealW 提供；还没有渊印时为 0）
  const sealW = () => (typeof G.runSealW === 'function' ? G.runSealW() || 0 : 0);
  // 区域首领的那一件：只掷、不掉（返回掉了的渊契 id 或 null）。和烬铸分开掷、各计各的保底；层级 0 不掉也不计保底
  // 烈印（W ≥ seal.minW）下几率 × sealMul，最多 sealCap
  G.relicBossRoll = function (kind, tier) {
    const D = G.RELIC_DROP;
    const id = G.RELIC_BY_BOSS[kind];
    if (!D.src.boss || !id || !(tier >= 1)) return null;
    const p = sealW() >= D.seal.minW ? Math.min(D.sealCap, G.relicChance(tier) * D.sealMul) : G.relicChance(tier);
    return relicRoll(id, p, D.boss.pity) ? id : null;
  };
  // dropLoot 首领分支的一行钩子：首领那一件 + 烈印来源
  G.relicBossDrop = function (e, ilvl) {
    if (!e || !e.isBoss) return null;
    const id = G.relicBossRoll(e.bossKind, state.tier || 0);
    const item = id ? relicSpawn(id, ilvl, e.x, e.z) : null;
    G.relicSealDrop(e, ilvl);
    return item;
  };
  // 烈印（W ≥ minW）下击杀区域首领：陨织袍 / 渊缚链各半，两件共用 'seal' 保底。来源开关 src.seal 由 D3 打开
  G.relicSealDrop = function (e, ilvl) {
    const D = G.RELIC_DROP, S = D.seal;
    if (!D.src.seal || !e || !e.isBoss || !(sealW() >= S.minW)) return null;
    if (!relicRoll('seal', S.chance, S.pity)) return null;
    return relicSpawn(G.pick(S.ids), ilvl, e.x, e.z);
  };
  // 异兆成功：这种异兆对应的那一件（D4 的异兆运行时调用；来源开关 src.enc 由 D4 打开）
  G.relicEncDrop = function (enc, ilvl, x, z) {
    const D = G.RELIC_DROP;
    const id = G.RELIC_BY_ENC[enc];
    if (!D.src.enc || !id || !((state.tier || 0) >= D.enc.minTier)) return null;
    if (!relicRoll(id, D.enc.chance, D.enc.pity)) return null;
    return relicSpawn(id, ilvl, x, z);
  };
  // 拾烬客的货架（层级 ≥ 2）：返回要摆上的渊契 id，没有时 null（来源开关 src.trader 随 D4）
  G.relicTraderPick = function () {
    const D = G.RELIC_DROP;
    if (!D.src.trader || !((state.tier || 0) >= D.trader.minTier) || Math.random() >= D.trader.chance) return null;
    return G.pick(G.RELIC_IDS);
  };

  // ---------- 技能上下文（skillCtx 末尾的一行钩子） ----------
  G.relicCtx = function (ctx) {
    const r = P.relic, mi = ctx.minion;
    // 必然：你自己的暴击伤害降低（召唤物不受影响）
    if (r.qianmu && !mi && !ctx.asMinion) ctx.critMulti = Math.max(100, ctx.critMulti + RM.qianmu.critMulti);
    if (!mi) return ctx;
    if (r.tongshang) mi.life = Math.max(1, Math.round(mi.life * (1 + RM.tongshang.life / 100)));
    if (r.haiwang && mi.kind === 'thrall') {
      // 独骸：多出来的仆从上限（群聚、天赋、护符、万魂旗）每个折成伤害和生命
      const H = RM.haiwang, extra = Math.max(0, mi.cap - ctx.sk.cap);
      ctx.more *= H.dmg * (1 + H.perDmg * extra);
      mi.life = Math.max(1, Math.round(mi.life * H.life * (1 + H.perLife * extra)));
      mi.soulK = ctx.sk.cap / (H.life * (1 + H.perLife * extra)); // 万魂旗的魂火按「普通上限那么多具普通仆从」的生命算
      mi.cap = 1;
      mi.cleave = H.cleave;
      mi.arc = (H.arc * Math.PI) / 180;
      mi.hold = H.hold;
      mi.dr = Math.min(75, mi.dr + H.dr);
      mi.reach *= 1.3;
      mi.king = true;
    }
    return ctx;
  };

  // ---------- 必然（千目）：calcHit 里的一行钩子 ----------
  G.relicCrit = function (ctx) {
    if (ctx.proc || ctx.minion || ctx.asMinion) return Math.random() * 100 < ctx.crit;
    if (ctx.crit >= 100) return true; // 必暴的招式照旧必暴，不动计数
    if (!(ctx.crit > 0)) return false;
    RQ.crit += ctx.crit;
    if (RQ.crit >= 100) {
      RQ.crit -= 100;
      return true;
    }
    return false;
  };

  // ---------- 踏震（磐踵）/ 随影（招魂带）：翻滚 ----------
  // 翻滚冷却的倍率（dodge 里的一行钩子）
  G.relicRollK = () => 1 + (P.relic.panzhong ? RM.panzhong.rollCd : 0) + (P.relic.zhaohun ? RM.zhaohun.rollCd : 0);
  // 物理攻击的上下文（踏震、蓄潮之外的「武器一击」）：武器伤害 × mult，吃你的伤害属性、暴击，不吃任何辅助宝石
  function relicAtkCtx(mult, w, kb, poise) {
    const S = P.S, wp = G.weaponStats(G.save.equip.weapon);
    const base = { phys: [wp.min * mult, wp.max * mult] };
    for (const t of TYPES) {
      const v = S['add' + G.CAP[t]] || 0;
      if (v > 0) {
        if (!base[t]) base[t] = [0, 0];
        base[t][0] += v * 0.7;
        base[t][1] += v * 1.3;
      }
    }
    const inc = {}, moreType = {};
    for (const t of TYPES) {
      inc[t] = (S.incAll || 0) + (t === 'phys' ? S.incPhys || 0 : (S.incElem || 0) + (S['inc' + G.CAP[t]] || 0));
      moreType[t] = t !== 'phys' && t !== 'chaos' ? Math.max(0, 1 + (S.moreElem || 0) / 100) : 1;
    }
    inc.chaos += (S.incFire || 0) + (S.incCold || 0) + (S.incLight || 0);
    moreType.chaos = Math.max(0, 1 + (S.moreChaos || 0) / 100);
    return {
      id: 'relic', sk: { w, kb, poise, tags: ['attack', 'melee', 'area', 'phys'] }, lvl: 1, base, inc, moreType,
      more: Math.max(0, (1 + (S.moreDmg || 0) / 100) * (1 - Math.min(90, S.ownLess || 0) / 100)), extra: {},
      crit: G.clamp(5 * (1 + (S.crit || 0) / 100), 0, 100),
      critMulti: Math.max(100, 150 + (S.critMulti || 0) + (P.relic.qianmu ? RM.qianmu.critMulti : 0)),
      proj: 1, pierce: 0, chain: 0, area: Math.max(0.1, 1 + (S.area || 0) / 100), speed: P.speedMult, time: 1, stopK: 1, stopAvg: 0, cost: 0, cd: 0,
      leech: 0, stun: 0, ailment: S.ailment || 0, echo: 0, bindAil: S.bindAil || 0, flame: G.flamePct(), reserve: 0, minion: null, attack: true, weapon: wp, wm: mult, levelK: 1,
    };
  }
  G.relicAtkCtx = relicAtkCtx;
  // 翻滚落地（updatePlayer 翻滚那一段的一行钩子）
  G.relicLand = function () {
    if (!P.relic.panzhong || RQ.slamT > 0 || P.dead) return 0;
    const A = RM.panzhong;
    RQ.slamT = A.gap;
    const ctx = relicAtkCtx(A.mult, 1, A.kb, A.poise);
    const R = A.r * Math.sqrt(ctx.area);
    const W = G.world;
    let n = 0, crit = false;
    for (const e of enemiesIn(P.x, P.z, R)) {
      G.hitEnemy(e, ctx, 1, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: 1, kb: A.kb, poise: A.poise, quiet: true });
      crit = crit || lastHit.crit;
      n++;
    }
    if (W.relicStomp) W.relicStomp(P.x, P.z, R, P.face);
    else W.ring(P.x, P.z, R, 0xffc070, 0.35);
    W.shake(n ? 0.22 : 0.1);
    if (n) {
      G.hitStop(40);
      G.sfx('impact', { type: 'phys', w: 1, crit });
    }
    state.stats.relicStomps = (state.stats.relicStomps || 0) + 1;
    return n;
  };
  // 随影：翻滚 delay 秒后召唤物闪到落点周围、各砸一下（dodge 里的一行钩子）
  G.relicRollCall = function () {
    if (!P.relic.zhaohun) return;
    const Z = RM.zhaohun;
    G.after(Z.delay, () => {
      if (P.dead || !state.zone) return;
      const W = G.world;
      // 落点：按翻滚剩下的路程往前推，撞墙就截在墙前
      let d = P.roll.t > 0 ? P.moveSpeed * 2.6 * P.roll.t : 0;
      while (d > 0 && !W.walkable(P.x + P.roll.dx * d, P.z + P.roll.dz * d, 0.6)) d -= 0.4;
      const lx = P.x + P.roll.dx * Math.max(0, d), lz = P.z + P.roll.dz * Math.max(0, d);
      const ms = state.minions.filter((m) => !m.dead && !(m.rising > 0));
      const n = ms.length;
      ms.forEach((m, i) => {
        const a = P.face + Math.PI + (i - (n - 1) / 2) * (TAU / Math.max(3, n + 1));
        let rr = 1.8 + m.r, x = lx, z = lz;
        for (let k = 0; k < 4; k++, rr *= 0.7) {
          const tx = lx + Math.sin(a) * rr, tz = lz + Math.cos(a) * rr;
          if (W.walkable(tx, tz, m.r + 0.1)) {
            x = tx;
            z = tz;
            break;
          }
        }
        if (W.relicBlinkFx) W.relicBlinkFx(m.x, m.z, x, z);
        m.x = x;
        m.z = z;
        m.target = null;
        m.stuckT = 0;
        if (m.state !== 'attack') m.stateT = 0;
        W.setEnt(m.ent, x, z, m.ang);
        const mult = m.kind === 'colossus' ? Z.multBig : Z.mult;
        for (const e of enemiesIn(x, z, Z.r + m.r)) {
          if (e.execLock) continue;
          G.hitEnemy(e, m.ctx, mult, { ang: Math.atan2(e.x - x, e.z - z), w: 1, kb: 0.8, poise: 12, quiet: true, minion: m });
        }
        W.ring(x, z, Z.r + m.r, G.ALLY_HEX || 0x4fe3c8, 0.3);
      });
      if (n) G.sfx('impact', { type: 'phys', w: 1, crit: false });
      state.stats.relicCalls = (state.stats.relicCalls || 0) + 1;
    });
  };

  // ---------- 蓄潮（怒潮）：旋风斩每一跳的一行钩子，返回这一跳的伤害倍率 ----------
  G.relicSpinPulse = function (ctx) {
    const B = RM.nuchao;
    RQ.spin = Math.min(B.max, RQ.spin + 1);
    RQ.spinCtx = ctx;
    RQ.spinR = ctx.sk.radius * Math.sqrt(ctx.area);
    if (RQ.spin >= B.max && !RQ.spinFull) {
      RQ.spinFull = true;
      G.world.text(P.x, P.z, '潮满', '#cfe8ff', 18, { kind: 'tag', y: 2.4 });
    }
    if (G.world.relicTide) G.world.relicTide(P.x, P.z, RQ.spin / B.max);
    return B.pulse;
  };
  // 松手 / 翻滚 / 被打断 / 换了别的技能：以你为中心炸开（每帧在 relicTick 里检查）
  function relicTideBurst() {
    const n = RQ.spin, ctx = RQ.spinCtx;
    RQ.spin = 0;
    RQ.spinFull = false;
    if (!ctx || n <= 0 || P.dead) return 0;
    const B = RM.nuchao, W = G.world;
    const R = RQ.spinR * B.r;
    let hits = 0, crit = false;
    for (const e of enemiesIn(P.x, P.z, R)) {
      G.hitEnemy(e, ctx, n * B.burst, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: n >= B.max / 2 ? 2 : 1, kb: 0.6 + n * 0.12, poise: (ctx.sk.poise || 0) * n * B.burst, quiet: true });
      crit = crit || lastHit.crit;
      hits++;
    }
    if (W.relicTideBurst) W.relicTideBurst(P.x, P.z, R, n / B.max);
    else W.ring(P.x, P.z, R, 0xcfe8ff, 0.4);
    W.shake(0.12 + 0.3 * (n / B.max));
    if (hits) {
      G.hitStop(30 + 5 * n);
      G.sfx('impact', { type: 'phys', w: n >= B.max / 2 ? 2 : 1, crit });
    }
    state.stats.relicTides = (state.stats.relicTides || 0) + 1;
    return hits;
  }
  G.relicTideBurst = relicTideBurst;

  // ---------- 崩势（断岳） ----------
  // 精英 / 首领被打出破绽（hitEnemy 削架势那一行的钩子）：r 米内的普通怪一起破绽 t 秒
  G.relicSpread = function (e) {
    if (!e || !(e.elite || e.isBoss)) return 0;
    const C = RM.duanyue, W = G.world;
    let n = 0;
    for (const o of state.enemies) {
      if (o === e || o.dead || o.elite || o.isBoss || dist(o.x, o.z, e.x, e.z) > C.r) continue;
      o.rqBrk = C.t;
      o.stunT = Math.max(o.stunT || 0, C.t);
      if (tagOk('rqbrk', o.x, o.z)) W.text(o.x, o.z, '破绽', '#fff0c0', 20, { kind: 'tag', y: Math.min(3.4, o.height || 2) + 0.3 });
      W.ring(o.x, o.z, o.r + 0.9, 0xfff0c0, 0.3);
      n++;
    }
    if (n) W.ring(e.x, e.z, C.r, 0xfff0c0, 0.4);
    state.stats.relicSpread = (state.stats.relicSpread || 0) + n;
    return n;
  };
  // 处决之后（execHit 末尾的一行钩子）：目标身边处于破绽的敌人各吃一部分处决伤害
  G.relicSweep = function (e, dmg) {
    const C = RM.duanyue;
    if (!(dmg > 0)) return 0;
    const ctx = procCtx('phys', dmg * C.sweep);
    let n = 0;
    for (const o of enemiesIn(e.x, e.z, C.sweepR)) {
      if (o === e || !(o.brokenT > 0 || o.rqBrk > 0)) continue;
      G.hitEnemy(o, ctx, 1, { ang: Math.atan2(o.x - e.x, o.z - e.z), w: 2, kb: 1.6, poise: 0, quiet: true, proc: true, noBuild: true });
      n++;
    }
    if (n) G.world.slash(e.x, e.z, P.face, C.sweepR + e.r, 360, 0xfff0c0, { dur: 0.22, inner: 0.7, y: 0.9 });
    return n;
  };
  // 每个敌人每帧（tickBuildUp 里的一行钩子）：崩势的破绽倒计时、混相的回落
  G.relicEnemyTick = function (e, dt) {
    if (e.rqBrk > 0) {
      e.rqBrk -= dt;
      if (e.rqBrk <= 0) e.rqBrk = 0;
    }
    if (e.bu.mix > 0) {
      if (e.buT.mix > 0) e.buT.mix -= dt;
      else e.bu.mix = Math.max(0, e.bu.mix - BU.decay * dt);
    }
  };

  // ---------- 混相（异变）：addBuildUp 里的一行钩子。火 / 冰 / 雷都灌进 e.bu.mix ----------
  function relicMix(e, t, v, k, procs) {
    if (e.bu.mix === undefined) {
      e.bu.mix = 0;
      e.buT.mix = 0;
      e.buGrow.mix = 1;
      e.buTrig.mix = 0;
    }
    // 混相的三种效果还在身上时（冻着 / 重度冰缓 / 感电 / 破绽）不再累积
    if (e.freeze > 0 || e.bossChill > 0 || e.shockT > 0 || e.brokenT > 0) return true;
    if (t === 'fire') {
      e.buFire += v * k;
      e.buFireN++;
    } else if (t === 'light') {
      e.buLit += v * k;
      e.buLitN++;
    }
    e.bu.mix += (v / (e.buTh * e.buGrow.mix)) * k * RM.yibian.rate;
    e.buT.mix = BU.hold;
    if (e.bu.mix < 1) return true;
    if (e.hp <= 0) {
      e.bu.mix = 1;
      return true;
    }
    e.bu.mix = 0;
    queueProc(procs, { t: 'mix', e, fire: blastDmg(e) * RM.yibian.k });
    e.buFire = e.buFireN = 0;
    return true;
  }
  G.relicMix = relicMix;
  // 混相灌满：爆燃、冻结（首领重度冰缓）、感电同时触发，各 × k；首领的阈值只涨一次（triggerAilment 开头的一行钩子）
  function relicMixFire(p) {
    const W = G.world, e = p.e, K = RM.yibian.k, st = state.stats;
    const h = e.height || 2;
    const ty = Math.min(3.4, h * (e.elite ? 1.3 : 1)) + 0.3;
    e.buTrig.mix = (e.buTrig.mix || 0) + 1;
    if (e.isBoss) e.buGrow.mix = Math.min(BU.bossGrowMax, (e.buGrow.mix || 1) + BU.bossGrow);
    st.mixes = (st.mixes || 0) + 1;
    W.text(e.x, e.z, '混相', '#e8f0ff', e.isBoss ? 26 : 22, { kind: 'tag', y: ty, py: e.isBoss ? -30 : 0 });
    // 火：爆燃（打周围一圈，含它自己）
    const R = BU.blastR + e.r * 0.5;
    W.blastFx(e.x, e.z, R);
    fireBlast(e.x, e.z, R, p.fire);
    if (e.dead) return;
    // 冰：冻结 / 首领重度冰缓
    if (e.isBoss) e.bossChill = BU.bossChill * K;
    else e.freeze = Math.max(e.freeze || 0, (e.elite ? BU.freezeElite : BU.freeze) * K);
    W.freezeFx(e.x, e.z, e.r, h, !!e.isBoss);
    // 雷：感电
    e.shockT = BU.shock * K;
    e.shockCd = 0;
    W.burst(e.x, h * 0.6, e.z, 0xffe45e, 14, 5, 0.35);
    G.sfx('impact', { type: 'fire', w: 2, crit: false });
  }

  // ---------- 回旋：spawnProjectile 里的一行钩子（标记这一发会不会折返），updateProjectiles 里两处折返 ----------
  const BOOM_BASIC = { revolver: 1, huntbow: 1, eagle: 1, runebow: 1, emberbow: 1 };
  G.relicBoomerang = function (p) {
    const sk = p.ctx && p.ctx.sk;
    if (!sk || p.explode > 0 || p.wisp || p.seeker || p.ret) return; // p.ret：飞刃的刻式「回刃」自己会折返，不再叠一次回旋
    const ok = p.ctx.id === 'blade' || (sk.basic && BOOM_BASIC[sk.rtype] && !(P.rbuff && P.rbuff.t > 0 && P.rbuff.id === 'volley'));
    if (!ok) return;
    p.boom = 1;
    p.life *= RM.huixuan.range;
  };
  // 折返：到射程尽头（step 为 0）或撞墙（先退回墙前一步）时调用；成功返回 true。回程朝着你飞，飞到你身边为止，
  // 穿过路上所有敌人（每个敌人一次，同一次施放的几发共用一份），伤害 × back
  G.relicTurn = function (p, step) {
    if (p.boom !== 1) return false;
    if (step) {
      p.x -= p.dx * step;
      p.z -= p.dz * step;
    }
    const d = dist(P.x, P.z, p.x, p.z);
    if (d < 1.2 || P.dead) return false;
    p.boom = 2;
    p.dx = (P.x - p.x) / d;
    p.dz = (P.z - p.z) / d;
    p.life = d / p.speed + 0.05;
    p.hit = new Set();
    if (p.cast) p.cast = p.cast.ret || (p.cast.ret = new Set());
    p.pierce = 99;
    p.chain = 0;
    p.home = null;
    p.reseek = 0;
    p.boomK = RM.huixuan.back;
    if (G.world.relicProjTurn) G.world.relicProjTurn(p.mesh, p.dx, p.dz);
    state.stats.relicTurns = (state.stats.relicTurns || 0) + 1;
    return true;
  };

  // ---------- 星雨（陨织袍） ----------
  const meteorOn = () => !!(P.relic.zhuixing && G.save.skills.meteor && G.save.bar.indexOf('meteor') >= 0);
  // 光环保留里多算的那一份（reservePct 里的一行钩子）
  G.relicReserve = () => (meteorOn() ? RM.zhuixing.reserve : 0);
  // 陨火不能手动施放（tryStartCast 里的一行钩子）：轻点只提示一句。返回 true 表示这个键跳过
  G.relicNoCast = function (slot, id) {
    if (id !== 'meteor' || !P.relic.zhuixing) return false;
    if (G.input.tap[slot] > 0) {
      G.input.tap[slot] = 0;
      if (Date.now() - (toastAt.relic || 0) > 1500) {
        toastAt.relic = Date.now();
        G.world.text(P.x, P.z, '星雨：陨火自动落下', G.RELIC_COLOR, 15);
      }
    }
    return true;
  };
  // 自动落下：r 米内敌人最密的地方（每个敌人当圆心数一遍半径内的敌人）
  function relicMeteorDue(dt) {
    if (!meteorOn() || P.dead || P.exec) {
      RQ.metT = Math.min(RQ.metT, 0.5);
      return;
    }
    RQ.metT -= dt;
    if (RQ.metT > 0) return;
    const F = RM.zhuixing;
    const ctx = G.skillCtx('meteor');
    const sk = ctx.sk;
    const iv = (F.iv / ctx.speed) * (sk.cd > 0 ? ctx.cd / sk.cd : 1); // 迅捷 / 出手速度加快，节流缩短间隔
    const R = sk.radius * Math.sqrt(ctx.area) * F.area;
    let best = null, bn = 0;
    for (const e of state.enemies) {
      if (e.dead || dist(e.x, e.z, P.x, P.z) - e.r > F.r) continue;
      let n = 0;
      for (const o of state.enemies) if (!o.dead && dist(o.x, o.z, e.x, e.z) - o.r <= R) n++;
      if (n > bn) {
        bn = n;
        best = e;
      }
    }
    if (!best) {
      RQ.metT = 0.25; // 附近没有敌人：过一会儿再找
      return;
    }
    RQ.metT = iv;
    ctx.more *= F.mult;
    ctx.area *= F.area * F.area;
    const dx = best.x - P.x, dz = best.z - P.z, d = Math.hypot(dx, dz) || 1;
    SKILL_FX.meteor(ctx, { dx: dx / d, dz: dz / d, dist: d, ang: Math.atan2(dx, dz), tx: best.x, tz: best.z });
    state.stats.relicMeteors = (state.stats.relicMeteors || 0) + 1;
  }

  // ---------- 电桥 ----------
  // 链雷施放之后（SKILL_FX.chain 末尾的一行钩子）：pts[0] 是你，之后是依次打中的目标，相邻两个目标之间各留一道
  G.relicBridges = function (pts, ctx) {
    const D = RM.dianqiao;
    for (let i = 1; i + 1 < pts.length; i++) {
      while (RQ.bridges.length >= D.max) relicBridgeOff(0);
      const b = { x0: pts[i].x, z0: pts[i].z, x1: pts[i + 1].x, z1: pts[i + 1].z, t: D.t, tt: D.tick, ctx };
      b.fx = G.world.relicBridgeOn ? G.world.relicBridgeOn(b.x0, b.z0, b.x1, b.z1) : -1;
      RQ.bridges.push(b);
    }
  };
  function relicBridgeOff(i) {
    const b = RQ.bridges[i];
    RQ.bridges.splice(i, 1);
    if (G.world.relicBridgeOff) G.world.relicBridgeOff(b.fx);
  }
  function relicBridgeTick(dt) {
    const D = RM.dianqiao, half = D.w / 2;
    for (let i = RQ.bridges.length - 1; i >= 0; i--) {
      const b = RQ.bridges[i];
      b.t -= dt;
      if (b.t <= 0) {
        relicBridgeOff(i);
        continue;
      }
      b.tt -= dt;
      if (b.tt > 0) continue;
      b.tt += D.tick;
      const sx = b.x1 - b.x0, sz = b.z1 - b.z0, L2 = sx * sx + sz * sz || 1;
      for (const e of state.enemies) {
        if (e.dead) continue;
        const u = G.clamp(((e.x - b.x0) * sx + (e.z - b.z0) * sz) / L2, 0, 1);
        if (dist(e.x, e.z, b.x0 + sx * u, b.z0 + sz * u) - e.r > half) continue;
        // 同一个敌人同一时刻只吃一道电桥的跳（重叠的电桥不叠加）
        if (state.time - (e.bridgeT || -99) < D.tick * 0.95) continue;
        e.bridgeT = state.time;
        G.hitEnemy(e, b.ctx, D.mult, { ang: Math.atan2(sz, sx), w: 0, kb: 0, poise: 1, quiet: true, faint: true, bolt: true });
      }
    }
    if (G.world.relicBridgeTick) G.world.relicBridgeTick(dt);
  }

  // ---------- 同殇（同殇甲） ----------
  // 你挨打（hurtPlayer 开头的一行钩子）：share 转给 r 米内最近的召唤物，返回你自己还要挨的部分
  G.relicShareHurt = function (amount, dtype, src) {
    const T = RM.tongshang;
    let best = null, bd = T.r;
    for (const m of state.minions) {
      if (m.dead || m.rising > 0) continue;
      const d = dist(m.x, m.z, P.x, P.z);
      if (d <= bd) {
        bd = d;
        best = m;
      }
    }
    if (!best || !G.hurtMinion) return amount;
    if (RQ.shareT <= 0 && G.world.relicShareFx) {
      RQ.shareT = 0.3;
      G.world.relicShareFx(P.x, P.z, best.x, best.z);
    }
    G.hurtMinion(best, amount * T.share, dtype, src);
    state.stats.relicShared = (state.stats.relicShared || 0) + amount * T.share;
    return amount * (1 - T.share);
  };
  // 召唤物倒下（minions.js 的 hurtMinion 里的一行钩子）：回复它最大生命的一部分
  G.relicMinionDown = function (m) {
    if (!P.relic.tongshang || !m) return;
    G.healPlayer((m.maxHp || 0) * RM.tongshang.heal);
    G.world.burst(P.x, 1.1, P.z, G.ALLY_HEX || 0x4fe3c8, 8, 2, 0.4);
  };

  // ---------- 骸王（骸王冠）：外形跟着数值走（每 0.25 秒对一遍，戴上 / 摘下都对得上） ----------
  function relicKings() {
    for (const m of state.minions) {
      if (m.dead || m.kind !== 'thrall' || !m.ctx || !m.ctx.minion) continue;
      const want = !!m.ctx.minion.king;
      if (!!m.king === want) continue;
      m.king = want;
      if (m.r0 === undefined) {
        m.r0 = m.r;
        m.h0 = m.height;
      }
      const k = want ? RM.haiwang.scale : 1;
      m.r = m.r0 * k;
      m.height = m.h0 * k;
      if (G.world.relicKing) G.world.relicKing(m.ent, k);
    }
  }

  // ---------- 随核（引力核）：黑洞施放（SKILL_FX.hole 里的一行钩子）和跟随 ----------
  G.relicHole = function (ctx, R, dur) {
    const Y = RM.yinli, sk = ctx.sk;
    const r = R * Y.radius;
    G.sfx('cast');
    return addHole({ x: P.x, z: P.z, R: r, pullR: r * sk.pullR, t: 0, dur: dur * Y.dur, tick: sk.tick, tt: sk.tick, ctx, mult: Y.dmg, pullMul: Y.pull, mouth: false, follow: true });
  };
  G.relicHoleList = () => holes.filter((h) => h.follow); // 测试用：场上跟着你的黑洞
  G.relicHoleFollow = function (h) {
    h.x = P.x;
    h.z = P.z;
    if (h.fx && G.world.relicHoleAt) G.world.relicHoleAt(h.fx, h.x, h.z);
  };

  // ---------- 锁链（渊缚链）：hitEnemy 里的一行钩子 ----------
  // 渊缚中的 e 受到你的伤害：其余处于渊缚的敌人（离 e 最近的至多 max − 1 个）各分到 share。分到的伤害不暴击、不触发命中效果、
  // 不累积异常、不带黑焰，也不会再分出去（proc）
  G.relicChain = function (e, total, type) {
    const U = RM.yuanfu;
    if (!(total > 0)) return 0;
    const list = [];
    for (const o of state.enemies) if (o !== e && !o.dead && !o.isBoss && o.bindT > 0) list.push(o);
    if (!list.length) return 0;
    list.sort((a, b) => dist(a.x, a.z, e.x, e.z) - dist(b.x, b.z, e.x, e.z));
    list.length = Math.min(list.length, U.max - 1);
    const ctx = procCtx(G.TYPE_NAME[type] ? type : 'chaos', total * U.share);
    for (const o of list) G.hitEnemy(o, ctx, 1, { ang: Math.atan2(o.x - e.x, o.z - e.z), w: 0, kb: 0, poise: 0, quiet: true, faint: true, proc: true, noBuild: true, bolt: true });
    if (RQ.chainT <= 0) {
      RQ.chainT = 0.2;
      const pts = [{ x: e.x, z: e.z }];
      for (const o of list) pts.push({ x: o.x, z: o.z });
      G.world.bolt(pts, 0xe0279f);
    }
    state.stats.relicChained = (state.stats.relicChained || 0) + list.length;
    return list.length;
  };

  // ---------- 每帧（updatePlayer 里的一行钩子） ----------
  G.relicTick = function (dt) {
    if (RQ.slamT > 0) RQ.slamT -= dt;
    if (RQ.chainT > 0) RQ.chainT -= dt;
    if (RQ.shareT > 0) RQ.shareT -= dt;
    // 蓄潮：不在转旋风斩了（松手、翻滚、被打断、换了别的技能、摘下手套），攒着的层数炸开
    if (RQ.spin > 0 && !(P.relic.nuchao && P.cast && P.cast.channel && P.cast.id === 'whirl')) relicTideBurst();
    if (P.relic.zhuixing) relicMeteorDue(dt);
    if (RQ.bridges.length) relicBridgeTick(dt);
    RQ.kingT -= dt;
    if (RQ.kingT <= 0) {
      RQ.kingT = 0.25;
      if (state.minions.length) relicKings();
    }
  };
  // 换区域 / 重生（resetRanged 里的一行钩子）：电桥收起，蓄潮、星雨的计时清零
  G.relicReset = function () {
    while (RQ.bridges.length) relicBridgeOff(0);
    RQ.spin = 0;
    RQ.spinFull = false;
    RQ.metT = 0.6;
    RQ.slamT = 0;
  };

  // ---------- 死亡时的异常 ----------
  // 敌人死的那一刻（G.killEnemy 调 queueDeathProcs）查它的三条异常值：≥ deathMin 的（冰霜另算上正冻着的、闪电另算上正感电的）各在尸体处触发一次，
  // 和活着时的触发一起排进 procQ 统一结算。连锁保护：
  //   代数——玩家亲手的命中打死的是第 1 代；死亡触发（以及它连带的爆燃 / 电弧）打死的再 +1，超过 deathGen 代不再触发；
  //   每帧至多 deathMax 次；死亡电弧 / 尸爆都不累积异常值；procQ 每次结算至多 PROC_MAX 条。
  let deathFrame = -1;
  let deathN = 0;
  function queueDeathProcs(e) {
    if (!e.bu) return false;
    const st = state.stats;
    const gen = procGen + 1;
    let shatter = false;
    for (const t of G.BUILD_TYPES) {
      if (!(e.bu[t] >= BU.deathMin || (t === 'cold' && e.freeze > 0) || (t === 'light' && e.shockT > 0) || (t === 'chaos' && e.bindT > 0))) continue;
      if (state.time !== deathFrame) {
        deathFrame = state.time;
        deathN = 0;
      }
      if (gen > BU.deathGen || deathN >= BU.deathMax) {
        st.deathCapped = (st.deathCapped || 0) + 1;
        continue;
      }
      deathN++;
      const p = { t, e, death: true, gen, fire: 0, lit: 0 };
      if (t === 'fire') p.fire = blastDmg(e);
      else if (t === 'light') p.lit = (e.buLit / Math.max(1, e.buLitN)) * BU.deathBolt;
      else if (t === 'cold') shatter = true;
      procQ.push(p);
    }
    return shatter;
  }
  // 结算一条死亡触发：火 → 尸爆，雷 → 放电，冰 → 碎冰
  function deathTrigger(p) {
    if (p.t === 'fire') corpseBlast(p);
    else if (p.t === 'light') deathDischarge(p);
    else if (p.t === 'chaos') voidImplode(p);
    else shatterCold(p);
  }
  // 渊陷：尸体处往里一陷，voidR 以内的小怪被往尸体拽 voidT 秒（精英 / 首领不拽）；不造成伤害、不累积异常值，不会连锁
  function voidImplode(p) {
    const e = p.e, W = G.world, st = state.stats;
    st.voids = (st.voids || 0) + 1;
    const R = BU.voidR + e.r * 0.5;
    if (W.voidFx) W.voidFx(e.x, e.z, R);
    if (e.elite || e.isBoss || tagOk('void', e.x, e.z)) W.text(e.x, e.z, '渊陷', '#ffb3e6', 22, { kind: 'tag', y: deathTag(e) });
    for (const o of enemiesIn(e.x, e.z, R)) {
      if (o === e || o.isBoss || o.elite) continue;
      o.voidT = BU.voidT;
      o.voidX = e.x;
      o.voidZ = e.z;
    }
  }
  function deathTag(e) {
    return Math.min(3.4, (e.height || 2) * (e.elite ? 1.3 : 1)) + 0.3;
  }
  function corpseBlast(p) {
    const e = p.e, W = G.world, st = state.stats;
    st.corpseBlasts = (st.corpseBlasts || 0) + 1;
    const R = BU.blastR + e.r * 0.5;
    W.blastFx(e.x, e.z, R);
    W.text(e.x, e.z, '尸爆', '#ffb070', 22, { kind: 'tag', y: deathTag(e) });
    G.sfx('impact', { type: 'fire', w: 2, crit: false });
    fireBlast(e.x, e.z, R, p.fire);
  }
  function deathDischarge(p) {
    const e = p.e, W = G.world, st = state.stats;
    const tgts = nearestOthers(e, BU.shockR, BU.deathBoltN);
    st.deathShocks = (st.deathShocks || 0) + 1;
    W.text(e.x, e.z, '放电', '#fff08a', 22, { kind: 'tag', y: deathTag(e) });
    W.burst(e.x, (e.height || 2) * 0.6, e.z, 0xffe45e, 22, 6, 0.4);
    G.sfx('impact', { type: 'light', w: 1, crit: false });
    if (!tgts.length || !(p.lit > 0)) return;
    shootBolts(e, tgts, p.lit);
    st.bolts = (st.bolts || 0) + tgts.length;
  }
  function shatterCold(p) {
    const e = p.e, W = G.world, st = state.stats;
    st.shatters = (st.shatters || 0) + 1;
    const R = BU.shatterR + e.r * 0.5;
    W.freezeFx(e.x, e.z, e.r, e.height || 2, false);
    W.ring(e.x, e.z, R, 0xd6f3ff, 0.4);
    W.text(e.x, e.z, '碎冰', '#d6f3ff', 22, { kind: 'tag', y: deathTag(e) });
    G.sfx('impact', { type: 'cold', w: 2, crit: false });
    // 灌的量按死者的阈值折算到对方的阈值：小怪碎在精英 / 首领身上灌得少
    for (const o of enemiesIn(e.x, e.z, R)) fillMeter(o, 'cold', Math.min(BU.shatterCap, (e.buTh * BU.shatter) / G.buThreshold(o, 'cold')), procQ);
  }
  // 敌人身上的异常值每帧走：回落、感电 / 重度冰缓 / 爆燃标记倒计时。返回此刻的减速比例（0..1）
  G.tickBuildUp = function (e, dt) {
    if (!e.bu) G.initBuildUp(e);
    for (const t of G.BUILD_TYPES) {
      if (e.buT[t] > 0) e.buT[t] -= dt;
      else if (e.bu[t] > 0) {
        const b0 = e.bu[t];
        e.bu[t] = Math.max(0, b0 - BU.decay * dt);
        if (e.bu[t] <= 0) {
          // 回落到底才清空：平均每击不随回落变化
          if (t === 'fire') e.buFire = e.buFireN = 0;
          else if (t === 'light') e.buLit = e.buLitN = 0;
        }
      }
    }
    if (e.shockT > 0) e.shockT -= dt;
    if (e.shockCd > 0) e.shockCd -= dt;
    if (e.bossChill > 0) e.bossChill -= dt;
    if (e.blastT > 0) e.blastT -= dt;
    if (e.faintT > 0) e.faintT -= dt;
    if (e.bindT > 0) {
      e.bindT -= dt;
      if (e.bindT <= 0) e.bindT = e.bindLeft = 0;
    }
    if (e.bossBind > 0) e.bossBind -= dt;
    if (e.voidT > 0) e.voidT -= dt;
    if (e.bu.mix > 0 || e.rqBrk > 0) G.relicEnemyTick(e, dt); // 渊契：混相回落、崩势的破绽倒计时
    // 冰缓 / 重度冰缓 / 首领的渊缚减速：取较大的那个，不相加
    return Math.max(G.chillSlow(e, e.bu.cold), e.bossChill > 0 ? BU.bossSlow : 0, e.bossBind > 0 ? BU.bossBindSlow : 0);
  };
  // 轻度冰缓的减速比例：冰霜异常值 frac（0..1）大于 0 就有保底，越满越慢（普通 / 精英 / 首领各有上下限，见 G.BUILDUP）
  G.chillSlow = function (e, frac) {
    if (!(frac > 0)) return 0;
    const boss = e && e.isBoss, el = e && e.elite && !boss;
    const lo = boss ? BU.chillMinBoss : el ? BU.chillMinElite : BU.chillMin;
    const hi = boss ? BU.chillBoss : el ? BU.chillElite : BU.chill;
    return lo + (hi - lo) * Math.pow(Math.min(1, frac), BU.chillPow);
  };

  // info（可选）：{ ang 这一击行进的方向（缺省 = 从玩家指向敌人）, w 分量（0 轻 / 1 重 / 2 终结；缺省取技能数据）,
  //   kb 击退距离, poise 削掉的架势, quiet 不单独出声（一次挥砍打到多个敌人时由技能统一出一声）,
  //   minion 出手的召唤物（召唤物的命中不算玩家的连击、不改集火目标；镜头不跟着顶）,
  //   aura 光环的脉冲（数字小而淡、不算连击）, proc 爆燃 / 电弧等异常触发的伤害（不算连击）,
  //   noBuild 不累积元素异常值, bolt 感电电弧（不再触发电弧）, faint 数字小而淡 }
  let procDepth = 0;
  let procGen = 0;
  const procQ = [];
  const PROC_MAX = 200;
  const FAINT_GAP = 0.3;
  // 刻式「噬契」：累积异常时黑焰那一部分按 k 倍算（只换累积用的数，伤害不变）
  function flameAilParts(hit, k) {
    const o = Object.assign({}, hit.parts);
    o.chaos = (o.chaos || 0) + hit.flame * (k - 1);
    return o;
  }
  G.hitEnemy = function (e, ctx, mult, info) {
    if (!e || e.dead) return 0;
    const W = G.world;
    const sk = ctx.sk;
    const inf = info || NO_INFO;
    const PO = G.POISE;
    const broken = e.brokenT > 0;
    const m = (mult === undefined ? 1 : mult) * (broken || e.rqBrk > 0 ? PO.taken : 1); // rqBrk：渊契「崩势」扩散出来的破绽
    const hit = G.calcHit(ctx, m);
    const hp0 = e.hp;
    e.hp -= hit.total;

    // 数字颜色 / 特效花样取占比最大的伤害类型
    let top = 'phys';
    let tv = -1;
    for (const t in hit.parts) {
      if (hit.parts[t] > tv) {
        tv = hit.parts[t];
        top = t;
      }
    }
    const ang = inf.ang !== undefined ? inf.ang : Math.atan2(e.x - P.x, e.z - P.z);
    const w = inf.w !== undefined ? inf.w : sk.w || 0;
    const feel = Math.min(3, w + (hit.crit ? 1 : 0)); // 暴击的手感按重一级来
    const h = e.height || 2;
    const sn = Math.sin(ang);
    const cs = Math.cos(ang);

    // 数字：普通的小而快；暴击更大、换一套配色、沿抛物线甩出去；终结技最大
    const shown = Math.max(1, Math.round(hit.total));
    const tx = e.x + G.rand(-0.35, 0.35);
    const tz = e.z + G.rand(-0.25, 0.25);
    const ty = Math.min(2.6, h * 0.5); // 从胸口冒出来，升到头顶为止，不压住血条和名字
    const faint = inf.aura || inf.faint;
    if (faint) {
      // 光环脉冲 / 电弧：小而淡的数字，一圈敌人同时挨打时不刷屏；同一个敌人每 FAINT_GAP 秒最多冒一个
      if (!(e.faintT > 0)) {
        e.faintT = FAINT_GAP;
        W.text(tx, tz, shown, G.TYPE_COLOR[top], 11, { kind: 'faint', y: ty });
      }
    } else if (w >= 2) W.text(tx, tz, shown + (hit.crit ? '!' : ''), G.TYPE_COLOR[top], hit.crit ? 30 : 23, { kind: 'big', y: ty });
    else if (hit.crit) W.text(tx, tz, shown + '!', G.TYPE_COLOR[top], 24, { kind: 'crit', y: ty });
    else W.text(tx, tz, shown, G.TYPE_COLOR[top], 16, { y: ty });

    if (inf.aura) {
      // 光环：只在身上闪一点霜屑，不闪白、不后仰
      W.frostSparkle(e.x, h * 0.55, e.z, e.r);
    } else {
      W.flash(e.ent, 1 + feel * 0.7);
      W.hitReact(e.ent, ang, 0.9 + feel * 0.4); // 顺着这一击的方向一仰
      // 持续伤害的跳（黑洞 / 黑旋风，inf.tick）：只甩几片实例化的尖片，不留地面贴花、不打闪光（怪堆里每秒几十跳，贴花每片一次 draw call）
      if (inf.tick && W.chaosTick) W.chaosTick(e.x - sn * e.r * 0.7, h * 0.5, e.z - cs * e.r * 0.7, ang, hit.crit);
      else W.impact(e.x - sn * e.r * 0.7, h * 0.5, e.z - cs * e.r * 0.7, ang, top, feel, hit.crit);
      if (ctx.flame > 0 && W.flameHit) W.flameHit(e.x, h * 0.55, e.z, e.r, ang); // 黑焰：命中点甩出几片品红的小火舌
    }
    if (!inf.quiet) {
      // 投射物 / 法术逐个出声；暴击时镜头也轻轻一顶（近战由技能统一处理）
      G.sfx('impact', { type: top, w, crit: hit.crit });
      if (hit.crit) W.punch(ang, 0.12);
    }
    wake(e);

    const st = state.stats;
    if (inf.minion) {
      st.minionHits = (st.minionHits || 0) + 1;
    } else if (inf.aura || inf.proc) {
      // 光环脉冲与异常触发的伤害不算你的连击，也不改召唤物的集火目标
    } else {
      st.hits++;
      if (hit.crit) st.crits++;
      const ch = P.chain;
      ch.n++;
      ch.t = CHAIN_KEEP;
      if (ch.n > ch.best) ch.best = ch.n;
      // 集火：玩家亲手打中的敌人成为召唤物的优先目标
      state.focus = e;
      state.focusT = FOCUS_KEEP;
      if (sk.rtype) rangedOnHit(e, ctx, hit, inf); // 远程普攻：热度的「最近打中过」、弓的专注
    }

    // 重击打断普通小怪的起手；所有命中都把小怪推开（首领不被推动）
    if (!e.isBoss) {
      if (w >= 1 && !e.elite) G.interruptEnemy(e, w >= 2 ? 0.45 : 0.3);
      knock(e, ang, (inf.kb !== undefined ? inf.kb : sk.kb || 0) * (hit.crit ? 1.25 : 1));
    }

    // 元素异常值：这一击里的每种元素按伤害累积，满了就触发（结算放到最外层的命中结束时）
    procDepth++;
    if (!inf.noBuild) addBuildUp(e, ctx.flameAil > 1 && hit.flame > 0 ? flameAilParts(hit, ctx.flameAil) : hit.parts, ctx.ailment, procQ, ctx.bindAil);
    // 感电中的敌人挨打：放电弧（电弧本身不再触发）
    if (!inf.bolt && e.shockT > 0 && !(e.shockCd > 0)) {
      e.shockCd = BU.shockGap; // 排进队列时就开始节流：同一击里再挨一下（比如紧跟着的爆燃）不会再排第二次
      queueProc(procQ, { t: 'arc', e, total: hit.total });
    }
    if (ctx.stun > 0 && !e.isBoss && !broken) e.stunT = Math.max(e.stunT || 0, ctx.stun);
    if (ctx.leech > 0) G.healPlayer((hit.total * ctx.leech) / 100);
    // 烬断（残刃）：你亲手的暴击留下一道残刃，叠满就排进队列引爆（引爆本身是 proc，不再留残刃）
    if (hit.crit && P.uMech === 'blade' && !inf.minion && !inf.proc && !inf.aura && e.hp > 0) {
      e.marks = (e.marks || 0) + 1;
      state.stats.marks = (state.stats.marks || 0) + 1;
      if (e.marks >= G.MARK.max) {
        e.marks = 0;
        procQ.push({ t: 'mark', e });
      }
      if (W.bladeMarks) W.bladeMarks(e.ent, e.marks, e);
    }

    if (P.relic.yuanfu && e.bindT > 0 && !inf.proc && !inf.minion) G.relicChain(e, hit.total, top); // 渊契「锁链」
    lastHit.crit = hit.crit;
    lastHit.type = top;
    lastHit.total = hit.total;
    lastHit.killed = false;
    if (e.hp <= 0) {
      lastHit.killed = true;
      // over：溢出的伤害相当于几倍最大生命——越多，尸体飞得越远、碎得越快
      G.killEnemy(e, { ang, type: top, w, over: Math.min(2, (hit.total - hp0) / e.maxHp) });
    } else if (e.poiseMax > 0 && !broken) {
      // 削架势：打空即破绽
      // 「架势削减提高」（战锤的隐含属性）只算你亲手的命中
      const own = !inf.minion && !inf.proc && !inf.aura ? 1 + Math.max(-100, P.S.poiseDmg || 0) / 100 : 1;
      const pd = (inf.poise !== undefined ? inf.poise : sk.poise || 0) * (hit.crit ? PO.critMult : 1) * own;
      if (pd > 0) {
        e.poise -= pd;
        e.poiseT = PO.delay;
        e.poiseHit = 0.12;
        if (e.poise <= 0 && G.breakEnemy(e, ang) && P.relic.duanyue) G.relicSpread(e); // 渊契「崩势」
      }
    }
    procDepth--;
    flushProcs();
    return hit.total;
  };
  // 结算排着的触发（活着时的冻结 / 爆燃 / 感电、感电电弧、死亡触发）。只在最外层结算：触发出来的伤害里再触发的照样排进来、按顺序结算。
  // procGen 记着正在结算的这一条是第几代，期间打死的敌人的死亡触发就是下一代（见 queueDeathProcs）
  function flushProcs() {
    if (procDepth > 0 || !procQ.length) return;
    // 触发出来的伤害会改写 lastHit：结算完把这一击的结果还原，技能照常逐个读取
    const keep = { crit: lastHit.crit, type: lastHit.type, total: lastHit.total, killed: lastHit.killed };
    procDepth++;
    for (let i = 0; i < procQ.length && i < PROC_MAX; i++) {
      const p = procQ[i];
      procGen = p.gen || 0;
      if (p.t === 'arc') shockDischarge(p.e, p.total);
      else if (p.t === 'mark') markBurst(p.e); // 烬断 · 残刃叠满引爆
      else if (p.death) deathTrigger(p);
      else triggerAilment(p);
    }
    procGen = 0;
    procQ.length = 0;
    procDepth--;
    Object.assign(lastHit, keep);
  }

  // info（可选）：{ ang 致命一击行进的方向, type 致命伤害的类型, w 这一击的分量, over 过量击杀的程度 }
  G.killEnemy = function (e, info) {
    if (!e || e.dead) return;
    const W = G.world;
    const save = G.save;
    const inf = info || NO_INFO;
    e.dead = true;
    e.deathT = 0.25;
    e.hp = 0;
    e.brokenT = 0;
    e.execLock = false;
    // 尸体顺着致命一击飞出去，按伤害类型碎裂 / 消散（world 接管；尸体照常在 deathT 后从列表里移除）
    const ang = inf.ang !== undefined ? inf.ang : Math.atan2(e.x - P.x, e.z - P.z);
    const kw = inf.w || 0;
    const over = Math.max(0, inf.over || 0);
    // 死亡时的异常（尸爆 / 放电 / 碎冰）排进触发队列；碎冰的尸体按冰霜碎成冰碴
    const type = queueDeathProcs(e) ? 'cold' : inf.type || 'phys';
    W.die(e.ent, {
      ang, type, over: over + (kw >= 2 ? 0.6 : 0),
      force: e.isBoss ? 0 : (4.5 + kw * 4 + over * 3) / Math.sqrt(e.mass || 1),
    });
    state.stats.kills++;
    G.sfx('kill', { type, big: !!(e.elite || e.isBoss) });
    // 烬断（残刃）：倒下的敌人身上的残刃飞到 MARK.jump 米内最近的敌人身上接着叠（够层数就引爆）
    if (e.marks > 0) {
      if (P.uMech === 'blade') markJump(e);
      e.marks = 0;
      if (W.bladeMarks) W.bladeMarks(e.ent, 0);
    }

    // 经验
    const xp = G.killXp(e, save.level); // 压级衰减 / 越级封顶见 data.js 的「经验」

    if (P.S.lifeOnKill > 0) G.healPlayer(P.S.lifeOnKill);
    const charge = 0.12 + (e.elite ? 1 : 0) + (e.isBoss ? 3 : 0);
    P.flask.life = Math.min(3, P.flask.life + charge);
    P.flask.mana = Math.min(3, P.flask.mana + charge);

    const hex = G.TYPE_HEX[e.elem] || 0xe6dfd0;
    const mid = (e.height || 2) * 0.5;
    if (e.isBoss) {
      W.burst(e.x, mid, e.z, hex, 70, 9, 1.0);
      W.burst(e.x, mid, e.z, 0xffffff, 30, 6, 0.7);
      W.ring(e.x, e.z, 9, hex, 0.7);
      W.shake(0.7);
    } else {
      W.burst(e.x, mid, e.z, hex, e.elite ? 26 : 12, e.elite ? 6 : 4.5, e.elite ? 0.6 : 0.45);
      if (e.elite) W.ring(e.x, e.z, 2.6, hex, 0.35);
    }

    G.dropLoot(e);
    G.gainXp(xp);

    if (e.isBoss) {
      const zone = state.zone;
      const zid = zone.def.id;
      const prev = save.cleared[zid];
      save.cleared[zid] = prev === undefined ? state.tier : Math.max(prev, state.tier);
      const kind = e.bossKind;
      if (kind && !save.bossKills[kind]) {
        save.bossKills[kind] = true;
        toast('首次击败「' + e.name + '」：获得 2 点天赋点', '#ffd75e');
      } else {
        toast('「' + e.name + '」已被击败', '#ffb46a');
      }
      if (state.zoneIdx === G.ZONES.length - 1 && state.tier >= save.maxTier) {
        save.maxTier = state.tier + 1;
        toast('轮回层级 ' + save.maxTier + ' 已解锁', '#d98cff');
      }
      // 首领倒下后清掉敌方弹幕，再开传送门
      for (let i = state.projectiles.length - 1; i >= 0; i--) {
        if (state.projectiles[i].owner === 'e') removeProjectile(i);
      }
      if (!state.portal) {
        const bp = zone.bossPos;
        // 贴着场地中心打死首领时，传送门先不待命：走开再回来才打开地图，不打断击杀后的那一刻
        state.portal = { x: bp.x, z: bp.z, mesh: W.makePortal(bp.x, bp.z), armed: dist(P.x, P.z, bp.x, bp.z) > 3.5 };
      }
      G.sfx('boss');
      G.persist();
    }
    flushProcs(); // 不是在命中里打死的（处决等）：死亡触发就地结算；在命中里打死的由那一击结束时统一结算
  };

  // 打断玩家手上的一切：施法、翻滚、处决、连段、连击计数、输入缓冲、顿帧 / 慢动作（倒下、重生、换区时用）
  function resetAction() {
    if (P.exec) {
      if (P.exec.e) P.exec.e.execLock = false;
      if (P.ent) G.world.stop(P.ent, 0);
    }
    P.exec = null;
    P.cast = null;
    P.rstate = null; // 乱射不会被打断，但倒下 / 换区 / 重生时到此为止
    P.roll.t = 0;
    P.combo.step = 0;
    P.combo.t = 0;
    P.chain.n = 0;
    P.chain.t = 0;
    const inp = G.input;
    if (inp) {
      inp.tap[0] = inp.tap[1] = inp.tap[2] = inp.tap[3] = inp.tap[4] = 0;
      inp.tapDodge = inp.tapExec = 0;
    }
    flowReset();
  }

  // src（可选）：伤害的来源 { x, z }，决定受击后仰的方向
  G.hurtPlayer = function (amount, dtype, src) {
    if (P.dead || P.iframe > 0 || P.god) return false;
    if (!(amount > 0)) return false;
    if (P.relic.tongshang) amount = G.relicShareHurt(amount, dtype, src); // 渊契「同殇」
    const W = G.world;
    let dmg = amount;
    if (!dtype || dtype === 'phys') dmg *= 1 - Math.min(0.8, P.armour / (P.armour + 10 * amount));
    else dmg *= 1 - (P.res[dtype] || 0) / 100;
    dmg *= 1 - Math.min(90, P.S.lessTaken || 0) / 100;
    dmg *= 1 + Math.max(0, P.S.moreTaken || 0) / 100; // 基石「刃舞」的代价
    dmg = Math.max(1, dmg);

    P.life -= dmg;
    W.text(P.x + G.rand(-0.3, 0.3), P.z, '-' + Math.round(dmg), '#ff5a4a', 17);
    W.shake(Math.min(0.6, 0.18 + (dmg / P.maxLife) * 1.6));
    G.ui.hurt();
    const far = src && Math.hypot(P.x - src.x, P.z - src.z) > 0.05;
    W.play(P.ent, 'hit', { strength: Math.min(1.6, 0.6 + (dmg / P.maxLife) * 4), ang: far ? Math.atan2(P.x - src.x, P.z - src.z) : undefined });
    G.sfx('hurt');
    P.chain.n = 0; // 挨打：连击中断
    P.chain.t = 0;
    const rw = G.rangedWeapon();
    if (rw && rw.family === 'bow') G.addGauge('focus', -G.RANGED.focus.hurt); // 挨打掉一点专注

    if (P.life <= 0) {
      P.life = 0;
      P.dead = true;
      P.deadT = 1.6;
      P.respawnAt = G.bossDoor(); // 倒在首领战里：重生在竞技场门外，不用再从入口空跑一遍
      resetAction(); // 缓冲着的输入、顿帧、慢动作都到此为止
      P.hot.life = P.hot.mana = null;
      P.moving = false;
      W.die(P.ent); // 留下一具替身演倒地，本体照旧隐藏到重生
      P.ent.group.visible = false;
      W.burst(P.x, 1, P.z, 0xff5a4a, 40, 6, 0.9);
      G.sfx('death');
      toast('你倒下了……', '#ff6a5a');
    }
    return true;
  };

  G.healPlayer = function (v) {
    if (P.dead || !(v > 0)) return;
    P.life = Math.min(P.maxLife, P.life + v);
  };

  function refill() {
    P.life = P.maxLife;
    P.mana = P.maxMana;
    P.flask.life = P.flask.mana = 3;
    P.hot.life = P.hot.mana = null;
  }

  function clearProjectiles() {
    const W = G.world;
    for (const p of state.projectiles) W.removeMesh(p.mesh);
    state.projectiles.length = 0;
  }
  function clearTelegraphs() {
    const W = G.world;
    for (const t of state.telegraphs) W.removeTelegraph(t.handle);
    state.telegraphs.length = 0;
  }

  function placePlayer(x, z) {
    P.x = x;
    P.z = z;
    resetAction();
    P.moving = false;
    P.drawFace = P.face;
    G.world.setEnt(P.ent, P.x, P.z, P.drawFace);
  }

  // 首领醒着（正在打）时返回它竞技场门外的重生点 zone.bossDoor：场地的门上、离场地中心 bossR + 2，
  // 在首领的唤醒范围之外。其余情况（或门点站不住）返回 null，表示回区域入口。
  G.bossDoor = function () {
    const zone = state.zone;
    const b = state.boss;
    if (!zone || !b || b.dead || !b.awake) return null;
    const d = zone.bossDoor;
    if (!d) return null;
    return G.world.walkable(d.x, d.z, PLAYER_PAD) ? { x: d.x, z: d.z } : null;
  };

  G.respawn = function () {
    const at = P.respawnAt || state.zone.start;
    P.respawnAt = null;
    P.dead = false;
    P.deadT = 0;
    P.cds = {};
    P.roll.cd = 0;
    P.iframe = 1.0;
    P.graceT = 2.5; // 门外可能还有没清掉的怪：给玩家一点站稳的时间，期间不会惊动它们（主动攻击仍会）
    P.ent.group.visible = true;
    // 先清计时器，再让敌人复位（首领延时招式不该在重生后才落下）
    flowReset();
    state.timers.length = 0;
    clearProjectiles();
    clearTelegraphs();
    G.world.clearFx(); // 还在半空的陨石、冲击环等不该跟到重生之后
    placePlayer(at.x, at.z);
    refill();
    resetRanged();
    G.resetEnemies();
    if (G.regroupMinions) G.regroupMinions(); // 召唤物回到重生点身边
    G.autoSummonDelay(); // 倒下的那些等它们现身之后再补
    if (state.portal) state.portal.armed = true;
  };

  // ---------- 预警圈 ----------
  const BOSS_VS_MINION = (G.BOSS_VS_MINION = 1.6); // 首领的预警招式打在召唤物身上的伤害倍率
  G.telegraph = function (spec) {
    const t = spec;
    if (!t.shape) t.shape = 'circle';
    if (t.dur === undefined) t.dur = 1;
    if (t.dmg === undefined) t.dmg = 0;
    if (!t.dtype) t.dtype = 'phys';
    if (t.owner === undefined) t.owner = null;
    if (t.ang === undefined) t.ang = 0;
    t.cancelIfOwnerDead = !!t.cancelIfOwnerDead;
    t.friendly = !!t.friendly;
    t.t = 0;
    t.handle = G.world.makeTelegraph(t, t.friendly);
    t.handle.setProgress(0);
    state.telegraphs.push(t);
    return t;
  };

  // 取消某个敌人名下所有还没结算的预警圈（起手被打断 / 被打出破绽）；它召来的落石一并消失
  G.cancelTelegraphs = function (owner) {
    const W = G.world;
    const list = state.telegraphs;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (!t || t.owner !== owner || t.friendly) continue;
      list.splice(i, 1);
      W.removeTelegraph(t.handle);
      if (t.meteor) W.cancelMeteor(t.meteor);
      n++;
    }
    return n;
  };

  function insideTelegraph(t, x, z) {
    const dx = x - t.x;
    const dz = z - t.z;
    if (t.shape === 'rect') {
      const along = dx * Math.sin(t.ang) + dz * Math.cos(t.ang);
      const perp = dx * Math.cos(t.ang) - dz * Math.sin(t.ang);
      return Math.abs(along) <= t.len / 2 && Math.abs(perp) <= t.w / 2;
    }
    return Math.hypot(dx, dz) <= t.r;
  }

  G.updateTelegraphs = function (dt) {
    const W = G.world;
    const list = state.telegraphs;
    // 倒序遍历：回调里新加的预警圈排在末尾，本帧不会被处理
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (!t) continue;
      if (t.cancelIfOwnerDead && t.owner && t.owner.dead) {
        list.splice(i, 1);
        W.removeTelegraph(t.handle);
        continue;
      }
      // 主人被冻结 / 眩晕时预警圈跟着停住，解控后接着走（首领免疫，不受影响）。
      // held 是 updateEnemies 本帧算出的「AI 没有运行」标记，和怪物自己的出手计时正好对齐
      if (t.owner && !t.owner.isBoss && t.owner.held && !t.friendly) continue;
      // 冰缓：小怪的预警圈按它自己放慢了的时钟走（和它的起手计时、起手动作一致）；首领的招式按固定节奏，不放慢
      t.t += t.owner && !t.owner.isBoss && !t.friendly && t.owner.slowK > 0 ? dt * t.owner.slowK : dt;
      if (t.t < t.dur) {
        t.handle.setProgress(t.dur > 0 ? t.t / t.dur : 1);
        continue;
      }
      list.splice(i, 1);
      W.removeTelegraph(t.handle);
      if (!t.friendly && t.dmg > 0 && insideTelegraph(t, P.x, P.z)) G.hurtPlayer(t.dmg, t.dtype, t);
      if (!t.friendly && t.dmg > 0 && G.hurtMinion) {
        // 敌方的预警圈对站在里面的召唤物同样结算。召唤物不会躲：首领的招式对它们加重（BOSS_VS_MINION），
        // 一直让召唤物围着首领硬砍会成片倒下，得重新召唤
        const ms = state.minions;
        const k = t.owner && t.owner.isBoss ? BOSS_VS_MINION : 1;
        for (let j = ms.length - 1; j >= 0; j--) {
          const m = ms[j];
          if (m && !m.dead && insideTelegraph(t, m.x, m.z)) G.hurtMinion(m, t.dmg * k, t.dtype, t);
        }
      }
      if (t.onFire) t.onFire(t);
    }
  };

  // ---------- 投射物 ----------
  G.spawnProjectile = function (p) {
    const len = Math.hypot(p.dx, p.dz) || 1;
    p.dx /= len;
    p.dz /= len;
    if (!p.owner) p.owner = 'e';
    if (p.speed === undefined) p.speed = 10;
    if (p.r === undefined) p.r = 0.3;
    if (p.life === undefined) p.life = 2.5;
    if (p.owner === 'p') {
      if (!p.hit) p.hit = new Set();
      p.pierce = p.pierce || 0;
      p.chain = p.chain || 0;
      p.explode = p.explode || 0;
      if (P.relic.huixuan) G.relicBoomerang(p); // 渊契「回旋」
    } else {
      if (!p.dtype) p.dtype = 'phys';
      if (p.dmg === undefined) p.dmg = 0;
    }
    if (p.color === undefined) p.color = p.owner === 'p' ? 0xffffff : G.TYPE_HEX[p.dtype];
    p.trailT = 0;
    // 敌方弹丸换一套外形，和玩家的投射物分得开；秘弹连射的追踪弹有自己的样子（朝着飞行方向）
    // 魂潮的魂火（p.wisp）优先用 world.makeWisp，没有时借追踪弹的样子。
    // p.vk：外形（掷焰 ember、飞刃 blade、喷吐者 glob、霜织者 shard……，world 不认得的退回通用光球），p.tint：注入的元素色
    const W0 = G.world;
    const look = { kind: p.vk, dx: p.dx, dz: p.dz, tint: p.tint };
    p.mesh =
      p.wisp && W0.makeWisp ? W0.makeWisp(p.color)
      : (p.seeker || p.wisp) && W0.makeSeeker ? W0.makeSeeker(p.color, look)
      : W0.makeProjectile(p.color, p.r, p.owner !== 'p', look);
    // p.y0：出手高度（矮个子的嘴边），飞出去一小段后升到统一的弹道高度 1.1
    p.mesh.position.set(p.x, p.y0 !== undefined ? p.y0 : 1.1, p.z);
    state.projectiles.push(p);
    return p;
  };

  const recentVolleys = []; // 最近伤到过玩家的齐射编号

  // 敌方弹丸擦过召唤物（至多五六只，逐个比距离）：每发弹丸对每只召唤物至多结算一次，
  // 同一轮齐射对同一只召唤物也只结算一次。弹丸不会被挡下：躲在召唤物身后照样挨射
  function hostileGrazesMinions(p) {
    const ms = state.minions;
    for (let j = 0; j < ms.length; j++) {
      const m = ms[j];
      if (m.dead || m.rising > 0) continue;
      if (dist(m.x, m.z, p.x, p.z) > p.r + m.r) continue;
      if (!p.mHit) p.mHit = [];
      else if (p.mHit.indexOf(m) >= 0) continue;
      p.mHit.push(m);
      const v = p.volley;
      if (v !== undefined && v !== null) {
        if (m.volley === v) continue;
        m.volley = v;
      }
      G.hurtMinion(m, p.dmg, p.dtype, { x: p.x - p.dx, z: p.z - p.dz });
      if (!projFx(p, 'hit')) G.world.burst(p.x, 1.1, p.z, p.color, 4, 3, 0.2);
    }
  }

  // 投射物的命中 / 撞墙 / 爆炸特效：world 认得这种外形就由它画（返回 true），否则调用方用通用火花
  function projFx(p, how, R) {
    const W = G.world;
    return !!(W.projImpact && W.projImpact(p.mesh, p.x, p.z, how, R || 0));
  }

  function removeProjectile(i) {
    const p = state.projectiles[i];
    state.projectiles.splice(i, 1);
    G.world.removeMesh(p.mesh);
  }

  // 爆炸：对范围内除 skip 以外的敌人各结算一次。
  // 同一次施放里已经挨过直击或爆炸的敌人不再受伤：多重 / 贯穿 / 连锁带来的是覆盖面，不是对同一群怪的数倍伤害
  function explodeAt(p, skip) {
    const W = G.world;
    const R = p.explode * Math.sqrt(p.ctx.area);
    for (const e of enemiesIn(p.x, p.z, R)) {
      if (e === skip) continue;
      if (p.wisp && !losClear(p.x, p.z, e.x, e.z)) continue; // 魂火炸不到墙后
      if (p.cast) {
        if (p.cast.has(e)) continue;
        p.cast.add(e);
      }
      G.hitEnemy(e, p.ctx, 1, { ang: Math.atan2(e.x - p.x, e.z - p.z) }); // 从爆心往外推
    }
    // 魂火炸开有自己的特效（world.wispBurst，可选）
    if (!(p.wisp && fxOpt('wispBurst', p.x, p.z, R, p.color)) && !projFx(p, 'blast', R)) {
      W.ring(p.x, p.z, R, p.color, 0.3);
      W.burst(p.x, 1.0, p.z, p.color, 16, 6, 0.4);
    }
  }

  // 玩家投射物命中一个敌人后的去留；返回 false 表示投射物消失
  function afterPlayerHit(p, e) {
    if (p.explode > 0) explodeAt(p, e);
    if (p.chain > 0) {
      let best = null;
      let bd = 8;
      for (const o of state.enemies) {
        if (o.dead || p.hit.has(o) || (p.cast && p.cast.has(o))) continue;
        const d = dist(o.x, o.z, p.x, p.z);
        if (d <= bd) {
          bd = d;
          best = o;
        }
      }
      if (best) {
        p.chain--;
        const len = bd || 1;
        p.dx = (best.x - p.x) / len;
        p.dz = (best.z - p.z) / len;
        p.life = Math.max(p.life, 8 / p.speed + 0.15);
        return true;
      }
    }
    if (p.pierce > 0) {
      p.pierce--;
      // 追猎弓的箭穿过之后不再盯着刚射中的那个：重新在附近找下一个猎物
      if (p.reseek > 0) {
        p.home = null;
        p.seekT = 0;
        p.life = Math.max(p.life, p.reseek / p.speed + 0.15);
      }
      return true;
    }
    return false;
  }

  // 刻式「回刃」：折返。回程重新记命中（另一份 cast，同一个敌人两趟都能打中）、穿透照原来的数，朝玩家飞回来
  function bladeTurn(p) {
    p.retOn = true;
    p.hit = new Set();
    p.cast = p.back;
    p.pierce = p.ctx.pierce;
    p.life = Math.max(p.life, 30 / p.speed);
  }
  G.updateProjectiles = function (dt) {
    const W = G.world;
    const list = state.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p) continue; // 命中回调里可能批量移除过投射物（首领死亡清弹幕）
      p.life -= dt;
      let alive = p.life > 0;
      if (!alive && p.boom === 1) alive = G.relicTurn(p, 0); // 渊契「回旋」：到射程尽头折返
      // 追踪弹（秘弹连射）：每秒最多转 turn 弧度拐向目标；目标死了就直飞
      // 追猎弓的箭：目标没了就在 reseek 米内重新找一个（每 0.1 秒找一次）
      if (p.reseek > 0 && (!p.home || p.home.dead)) {
        p.home = null;
        p.seekT = (p.seekT || 0) - dt;
        if (p.seekT <= 0) {
          p.seekT = 0.1;
          const cur = Math.atan2(p.dx, p.dz);
          let bd = p.reseek;
          for (const e of state.enemies) {
            if (e.dead || p.hit.has(e)) continue;
            const d = dist(e.x, e.z, p.x, p.z) - e.r;
            if (d >= bd || Math.abs(angDiff(Math.atan2(e.x - p.x, e.z - p.z), cur)) > 1.6) continue;
            bd = d;
            p.home = e;
          }
        }
      }
      if (p.home) {
        if (p.home.dead) p.home = null;
        else {
          const cur = Math.atan2(p.dx, p.dz);
          const want = Math.atan2(p.home.x - p.x, p.home.z - p.z);
          const near = dist(p.x, p.z, p.home.x, p.home.z) < 3; // 贴近了转得更急，免得绕着目标打转
          const lim = (p.turn || 6) * dt * (near ? 3 : 1);
          const na = cur + G.clamp(angDiff(want, cur), -lim, lim);
          p.dx = Math.sin(na);
          p.dz = Math.cos(na);
        }
      }
      if (p.retOn) {
        // 刻式「回刃」：回程一直朝着玩家飞，回到身边就收起
        const dx = P.x - p.x, dz = P.z - p.z, d = Math.hypot(dx, dz);
        if (d < 0.9) alive = false;
        else {
          p.dx = dx / d;
          p.dz = dz / d;
        }
      }
      // 分小步前进，快的投射物不会穿过细小目标
      const total = p.speed * dt;
      const steps = Math.max(1, Math.ceil(total / 0.45));
      const step = total / steps;
      for (let s = 0; s < steps && alive; s++) {
        p.x += p.dx * step;
        p.z += p.dz * step;
        if (p.ret && !p.retOn && (p.retD = (p.retD || 0) + step) >= p.ret) bladeTurn(p); // 刻式「回刃」：飞到头折返
        if (!W.shotFree(p.x, p.z, -0.4)) {
          if (p.boom === 1 && G.relicTurn(p, step)) break; // 渊契「回旋」：第一次撞墙折返
          if (p.ret && !p.retOn) {
            // 刻式「回刃」：去程撞墙也折返
            p.x -= p.dx * step;
            p.z -= p.dz * step;
            projFx(p, 'wall');
            bladeTurn(p);
            break;
          }
          if (p.wisp) {
            // 魂火退回墙前再炸
            p.x -= p.dx * step;
            p.z -= p.dz * step;
          }
          if (p.owner === 'p' && p.explode > 0) explodeAt(p, null);
          else if (!projFx(p, 'wall')) W.burst(p.x, 1.1, p.z, p.color, 5, 3, 0.25);
          alive = false;
          break;
        }
        if (p.owner === 'p') {
          for (const e of state.enemies) {
            if (e.dead || p.hit.has(e)) continue;
            if (dist(e.x, e.z, p.x, p.z) > p.r + e.r) continue;
            p.hit.add(e);
            // 同一次施放的多枚投射物不叠加命中同一个敌人（多重投射打单体不会变成数倍伤害）；
            // 后到的那枚照常消耗穿透 / 连锁 / 引爆，只是不再对它结算直击
            if (!p.cast || !p.cast.has(e)) {
              if (p.cast) p.cast.add(e);
              // 远程武器的箭 / 子弹：multFn 算这一下的倍率（鹰眼的远距离加成），after 接着结算余烬 / 元素爆炸 / 熔芯弹；src 让专注按箭计数
              const m = (p.multFn ? p.multFn(p, e) : p.mult || 1) * (p.boomK || 1); // boomK：回旋的回程
              G.hitEnemy(e, p.ctx, m, { ang: Math.atan2(p.dx, p.dz), src: p }); // 顺着弹道推
              if (p.after) p.after(p, e, lastHit.killed, lastHit.crit);
            }
            if (!p.explode) projFx(p, 'hit'); // 飞刃擦过敌人的金属火花（爆炸弹的特效在爆炸那一下）
            alive = afterPlayerHit(p, e);
            if (!alive && p.ret && !p.retOn) {
              bladeTurn(p); // 刻式「回刃」：去程穿透用完也折返
              alive = true;
            }
            break; // 每小步最多命中一个
          }
        } else {
          // 擦过召唤物照样结算它的那一份，但弹丸不会被挡下，继续飞向身后的玩家
          if (G.hurtMinion && state.minions.length) hostileGrazesMinions(p);
          if (P.dead || dist(P.x, P.z, p.x, p.z) > p.r + 0.5) continue;
          // 同一轮齐射（volley 相同）只结算一次伤害：贴脸吃满一圈弹幕不该被瞬间打空
          const v = p.volley;
          const from = { x: p.x - p.dx, z: p.z - p.dz };
          if (v === undefined || v === null) G.hurtPlayer(p.dmg, p.dtype, from);
          else if (recentVolleys.indexOf(v) < 0 && G.hurtPlayer(p.dmg, p.dtype, from)) {
            recentVolleys.push(v);
            if (recentVolleys.length > 8) recentVolleys.shift();
          }
          if (!projFx(p, 'hit')) W.burst(p.x, 1.1, p.z, p.color, 6, 3, 0.25);
          alive = false;
        }
      }
      if (!alive) {
        // 到达射程尽头的爆炸弹也要炸开（fizzle 的——魂火——没碰到敌人就悄悄散掉）
        if (p.life <= 0 && p.owner === 'p' && p.explode > 0 && !p.fizzle) explodeAt(p, null);
        else if (p.life <= 0 && p.fizzle) W.burst(p.x, 1.1, p.z, p.color, 6, 2, 0.3);
        const idx = list.indexOf(p);
        if (idx >= 0) removeProjectile(idx);
        continue;
      }
      let py = 1.1;
      if (p.y0 !== undefined) {
        p.yT = (p.yT || 0) + dt;
        const k = Math.min(1, p.yT / 0.22);
        py = p.y0 + (1.1 - p.y0) * k * (2 - k);
      }
      p.mesh.position.set(p.x, py, p.z);
      p.trailT -= dt;
      if (p.trailT <= 0 && !p.mesh.userData.trail) {
        p.trailT = p.owner === 'p' ? 0.04 : 0.09;
        W.burst(p.x, py, p.z, p.color, 1, 0.6, 0.25);
      }
    }
  };

  // ---------- 计时器 ----------
  G.after = function (sec, fn) {
    const t = { t: sec, fn };
    state.timers.push(t);
    return t;
  };

  G.updateTimers = function (dt) {
    const list = state.timers;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (!t) continue; // 回调里清空过列表
      t.t -= dt;
      if (t.t <= 0) {
        list.splice(i, 1);
        t.fn();
      }
    }
  };

  // =====================================================================
  // 玩家
  // =====================================================================
  // 键盘移动方向（单位向量），没按则为 null
  function moveDir() {
    const k = G.input.keys;
    const mx = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
    const mz = (k.KeyS || k.ArrowDown ? 1 : 0) - (k.KeyW || k.ArrowUp ? 1 : 0);
    if (!mx && !mz) return null;
    const len = Math.hypot(mx, mz);
    return { x: mx / len, z: mz / len };
  }

  // 从玩家指向鼠标落点
  function aimInfo() {
    const m = G.input.mouse;
    const dx = m.wx - P.x;
    const dz = m.wz - P.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return { ang: P.face, dx: Math.sin(P.face), dz: Math.cos(P.face), dist: 0, tx: P.x, tz: P.z };
    return { ang: Math.atan2(dx, dz), dx: dx / d, dz: dz / d, dist: d, tx: m.wx, tz: m.wz };
  }

  // 撞墙时依次尝试偏转这些角度，沿墙滑行
  const SLIDE = [0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.35, -1.35, 1.5, -1.5];

  function movePlayer(dx, dz) {
    const W = G.world;
    const total = Math.hypot(dx, dz);
    if (total < 1e-6) return;
    // 万一站在不可走的位置（不该发生），沿地形的梯度挪回可走的地方
    if (!W.walkable(P.x, P.z, PLAYER_PAD)) {
      W.pushOut(P.x, P.z, PLAYER_PAD, total, P);
      return;
    }
    const n = Math.ceil(total / 0.3);
    const sx = dx / n;
    const sz = dz / n;
    for (let i = 0; i < n; i++) {
      if (W.walkable(P.x + sx, P.z + sz, PLAYER_PAD)) {
        P.x += sx;
        P.z += sz;
        continue;
      }
      let moved = false;
      for (const a of SLIDE) {
        const c = Math.cos(a);
        const s = Math.sin(a);
        const rx = (sx * c - sz * s) * c;
        const rz = (sx * s + sz * c) * c;
        if (W.walkable(P.x + rx, P.z + rz, PLAYER_PAD)) {
          P.x += rx;
          P.z += rz;
          moved = true;
          break;
        }
      }
      if (!moved) break;
    }
  }

  // 技能栏输入：0 左键，1 右键，2 Q，3 E，4 R（武器技，技能固定是当前武器的，不存进 save.bar）；
  // tap 是短暂的按键缓冲，轻点也不会丢
  const WS_SLOT = (G.WEAPON_SLOT = 4);
  function slotHeld(slot) {
    const inp = G.input;
    if (inp.tap[slot] > 0) return true;
    if (slot === 0) return inp.mouse.b[0];
    if (slot === 1) return inp.mouse.b[2];
    if (slot === WS_SLOT) return !!inp.keys.KeyR;
    return !!inp.keys[slot === 2 ? 'KeyQ' : 'KeyE'];
  }
  // 某个输入槽此刻对应的技能
  // 右键（1）固定是手里武器的普攻（空手是拳击）
  G.slotSkill = function (slot) {
    if (slot === WS_SLOT) return G.weaponSkill();
    if (slot === 1) return G.weaponBasic();
    return G.save.bar[slot] || null;
  };

  // 同时按住时，键位技能优先于鼠标技能，这样按住左键普攻时仍能插入 Q / E / R
  const CAST_ORDER = [WS_SLOT, 2, 3, 1, 0];
  const COMBO_WINDOW = 0.55; // 一段打完（可以接下一段）之后，多久之内再出手算接上
  const LUNGE_KEEP = 1.0; // 连击踏步时与准星落点保持的最小距离

  function comboReset() {
    P.combo.step = 0;
    P.combo.t = 0;
  }

  // 注入的元素色：镶着的注入里最强、又不是这次出手主元素的那一种（投射物的拖尾 / 命中往这个颜色偏）；没有返回 undefined
  function infuseHex(ctx) {
    const top = mainType(ctx);
    let best = null;
    let bv = 0;
    for (const t in ctx.extra) {
      if (t === top || t === 'phys' || !(ctx.extra[t] > bv)) continue;
      bv = ctx.extra[t];
      best = t;
    }
    return best ? G.TYPE_HEX[best] : undefined;
  }

  // 这次出手里占比最大的伤害类型（刀光用它的颜色）
  function mainType(ctx) {
    let top = 'phys';
    let tv = -1;
    for (const t in ctx.base) {
      const v = (ctx.base[t][0] + ctx.base[t][1]) * typeMult(ctx, t);
      if (v > tv) {
        tv = v;
        top = t;
      }
    }
    return top;
  }

  // 开始一次施放。只在「能出手」的时刻被调用：手上没有动作，或者上一个动作已经过了可取消的时刻
  function tryStartCast() {
    const save = G.save;
    const chan = P.cast && P.cast.channel ? P.cast : null;
    for (const slot of CAST_ORDER) {
      if (!slotHeld(slot)) continue;
      const isWs = slot === WS_SLOT;
      const id = G.slotSkill(slot);
      if (isWs && !id) {
        // 空手按 R：提示一句
        if (G.input.tap[slot] > 0) {
          G.input.tap[slot] = 0;
          const now = Date.now();
          if (now - (toastAt.noWeapon || 0) > 1500) {
            toastAt.noWeapon = now;
            G.world.text(P.x, P.z, '没有武器，没有武器技', '#c9c2b4', 14);
          }
        }
        continue;
      }
      if (!id || !G.SKILLS[id] || (!isWs && !G.SKILLS[id].basic && !save.skills[id])) continue;
      if (P.relic.zhuixing && G.relicNoCast(slot, id)) continue; // 渊契「星雨」：陨火只能自动落下
      if (chan && chan.slot === slot) continue; // 还按着正在转的那个键：接着转，不从头起
      if (P.cds[id] > 0) continue;
      if (isWs && G.SKILLS[id].rgauge && !G.gaugeReady()) {
        // 远程武器的 R：量表没满放不出来，轻点只提示一句
        if (G.input.tap[slot] > 0) {
          G.input.tap[slot] = 0;
          const rw = G.rangedWeapon();
          if (rw && Date.now() - (toastAt.gauge || 0) > 1200) {
            toastAt.gauge = Date.now();
            G.world.text(P.x, P.z, rw.gauge.name + '未满（' + Math.floor(rw.gauge.v) + '/' + rw.gauge.max + '）', '#c9c2b4', 14);
          }
        }
        continue;
      }
      if (G.SKILLS[id].basic && P.rstate) continue; // 乱射期间不另外开火
      if (G.SKILLS[id].kind === 'aura') {
        // 光环不用按：轻点它的键只提示一句
        if (G.input.tap[slot] > 0) {
          G.input.tap[slot] = 0;
          const now = Date.now();
          if (now - (toastAt.aura || 0) > 1500) {
            toastAt.aura = now;
            G.world.text(P.x, P.z, '光环常驻生效', G.SKILLS[id].color, 15);
          }
        }
        continue;
      }
      // 召唤技能：按键本身是「自动召唤」开关（main.js 里直接切换，不进缓冲）；
      // 只有 Shift + 按键留下的缓冲才是在准星处手动召唤一次，按住不放也不会连着召唤
      if (G.SKILLS[id].kind === 'summon' && !(G.input.tap[slot] > 0)) continue;
      const ctx = G.skillCtx(id);
      if (!G.canAfford(ctx.cost)) {
        const now = Date.now();
        if (now - (toastAt.noCost || 0) > 1200) {
          toastAt.noCost = now;
          G.world.text(P.x, P.z, P.S.bloodMagic ? '生命不足' : '魔力不足', P.S.bloodMagic ? '#ff7a6a' : '#7fa8ff', 14);
        }
        continue;
      }
      const sk = ctx.sk;
      const ang = aimInfo().ang;
      if (sk.kind === 'rbasic') {
        startRanged(slot, ctx, ang);
        return true;
      }
      // 武器普攻（近战连招 / 施法 / 魂幡 / 空手）走下面普通技能的施放；武器技（R）分段施放
      if (sk.weaponOnly && !sk.basic) {
        if (startWeaponSkill(slot, ctx, ang)) return true;
        continue;
      }
      if (sk.kind === 'flicker') {
        // 影步连斩：附近没有够得着的敌人就不起手（不扣魔力、原地不动）；选中的第一个目标露出破绽则直接处决
        if (!flickerPick(sk, null, _fs)) {
          flickerNoTarget();
          continue;
        }
        G.input.tap[slot] = 0;
        if (_fs.e.brokenT > 0 && G.execute(_fs.e)) return true;
        // 持续施放：第一下当帧闪过去（nextT = 0），lead 秒后落地出刀；之后每 time 秒一刀
        comboReset();
        P.cast = {
          slot, id, t: 0, fired: false, aim: ang, step: -1, st: null, channel: true, flicker: true,
          nextT: 0, strikeT: Infinity, pend: null, last: null, lastAng: 0, alt: false, hit: new Map(), // hit：这一轮每个敌人被砍过几次
          cancelT: Infinity, dur: Infinity, pulses: 0, move: sk.move || 0,
        };
        P.face = ang;
        return true;
      }
      // 近战键贴身按下、面前正好有露出破绽的敌人：直接处决
      if (sk.kind === 'melee' || sk.kind === 'spin') {
        const tgt = G.execTarget(G.POISE.execMelee, ang);
        if (tgt && G.execute(tgt)) {
          G.input.tap[slot] = 0;
          return true;
        }
      }
      G.input.tap[slot] = 0;
      if (sk.kind === 'spin') {
        // 持续施放：没有固定时长，按住就一直转。第一下很快出手，之后每 iv 秒一下；出手之后随时可以接别的动作
        comboReset();
        const iv = ctx.time;
        P.cast = {
          slot, id, t: 0, fired: false, aim: ang, step: -1, st: null, channel: true,
          fireT: Math.min(0.12, iv * 0.4), nextT: Math.min(0.12, iv * 0.4), cancelT: Infinity, dur: Infinity, pulses: 0, move: sk.move || 0.6,
        };
        G.world.play(P.ent, 'spin', { loop: true, dur: iv * 1.2 });
        G.world.setTrail(G.TYPE_HEX[mainType(ctx)]);
        P.spinning = true;
        P.face = ang;
        return true;
      }
      // 连击技能：出当前这一段；其他技能：连段从头再来
      let st = null;
      let step = -1;
      if (sk.combo) {
        if (P.combo.id !== id) comboReset(); // 换了一招（换了武器、普攻变了）：从第一段起
        P.combo.id = id;
        step = P.combo.step % sk.combo.length;
        st = sk.combo[step];
      } else {
        comboReset();
      }
      const sp = ctx.speed;
      // fireT：生效时刻；cancelT：之后可以接下一个动作（下一段 / 别的技能）；dur：没有后续输入时动作自然结束
      const c = (P.cast = {
        slot, id, t: 0, fired: false, aim: ang, step, st,
        dur: st ? (st.time + st.tail) / sp : ctx.time,
        fireT: st ? st.hit / sp : ctx.time * 0.5,
        cancelT: st ? st.time / sp : ctx.time,
      });
      // 出手动作：连击三段各有各的挥法，其余按技能类型；命中帧对在生效的时刻
      const kind = sk.kind;
      const clip = st ? st.clip : sk.bclip || (kind === 'proj' ? 'throw' : kind === 'blink' ? 'blink' : kind === 'melee' ? 'attack1' : 'cast'); // 召唤也用施法动作；bclip：武器普攻自己的出手动作
      G.world.play(P.ent, clip, { dur: st ? c.dur + 0.1 : ctx.time * 1.3, contact: c.fireT });
      if (st) {
        G.world.setTrail(G.TYPE_HEX[mainType(ctx)]);
        G.sfx('swing', { step });
      } else if (kind === 'proj') G.world.castTint(G.TYPE_HEX[mainType(ctx)]); // 投掷蓄力的火星按伤害类型取色
      P.face = ang;
      return true;
    }
    return false;
  }

  // 连击段出手前朝准星踏出的一小步：加速冲出去，撞墙或贴到敌人身前就停
  function lungeStep(c, t0) {
    const st = c.st;
    const a0 = c.fireT * 0.3;
    const span = c.fireT - a0;
    const f0 = G.clamp((t0 - a0) / span, 0, 1);
    const f1 = G.clamp((c.t - a0) / span, 0, 1);
    let d = (f1 * f1 - f0 * f0) * st.lunge;
    if (d <= 0) return;
    // 不越过准星：停在离落点 1 之外。否则准星贴身时这一步会冲过头，下一帧瞄准方向翻转，角色原地掉头
    d = Math.min(d, Math.max(0, aimInfo().dist - LUNGE_KEEP));
    if (d <= 0) return;
    const sn = Math.sin(c.aim);
    const cs = Math.cos(c.aim);
    for (const e of state.enemies) {
      if (e.dead) continue;
      const dx = e.x - P.x;
      const dz = e.z - P.z;
      const along = dx * sn + dz * cs;
      if (along <= 0 || along > st.lunge + e.r + 1.2) continue;
      if (Math.abs(dx * cs - dz * sn) > e.r + 0.5) continue;
      d = Math.min(d, Math.max(0, along - (e.r + 0.95)));
    }
    if (d > 0) movePlayer(sn * d, cs * d);
  }

  // 停下持续施放（松手、魔力不够、键位被换掉）：动作淡回站立 / 移动
  function endChannel() {
    P.cast = null;
    P.spinning = false;
    if (G.world.clipOf(P.ent) === 'spin') G.world.stop(P.ent, 0.16);
  }

  function updateChannel(c, dt) {
    c.t += dt;
    c.aim = aimInfo().ang;
    P.face = c.aim;
    const held = slotHeld(c.slot) && G.save.bar[c.slot] === c.id;
    // 至少转出一下；之后一松手就停
    if (c.pulses > 0 && !held) {
      endChannel();
      return;
    }
    if (c.t < c.nextT) return;
    const ctx = G.skillCtx(c.id);
    if (!G.canAfford(ctx.cost)) {
      const now = Date.now();
      if (now - (toastAt.noCost || 0) > 1200) {
        toastAt.noCost = now;
        G.world.text(P.x, P.z, P.S.bloodMagic ? '生命不足' : '魔力不足', P.S.bloodMagic ? '#ff7a6a' : '#7fa8ff', 14);
      }
      endChannel();
      return;
    }
    payCost(ctx.cost);
    c.fired = true;
    c.cancelT = 0;
    c.pulses++;
    c.nextT += ctx.time; // 出手速度中途变了（迅捷、天赋）也按新的间隔走
    G.execSkill(ctx);
  }

  // ---------- 影步连斩 ----------
  // 每一下分两拍：先闪到目标身边（闪现途中无敌），lead 秒后落地出刀（这一刻不无敌）
  const _fs = { e: null, x: 0, z: 0, a: 0 };
  const FLICK_TRY = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.5, -2.5, Math.PI]; // 落点从首选方位往两边依次偏开
  const FLICK_TURN = 2.4; // 反复砍同一个目标时，每次落点绕着它转过的角度（约 137°，几刀下来落点散在四周）

  function flickerNoTarget() {
    const now = Date.now();
    if (now - (toastAt.noTarget || 0) > 1200) {
      toastAt.noTarget = now;
      G.world.text(P.x, P.z, '没有目标', '#c9c2b4', 14);
    }
  }

  // 敌人 e 身边贴着体型半径的落点：从 ang0 方位开始找，要求可走、从玩家这里直线过去不穿墙；
  // 先找不和别的敌人挤在一起的，再放宽；贴身一圈都不行（比如它缩在墙角）就退远半步再找一圈（仍在刀够得着的距离内）
  function flickerSpot(e, ang0, out) {
    const W = G.world;
    for (let pass = 0; pass < 3; pass++) {
      const gap = e.r + (pass < 2 ? 0.9 : 1.5);
      for (const da of FLICK_TRY) {
        const a = ang0 + da;
        const x = e.x + Math.sin(a) * gap;
        const z = e.z + Math.cos(a) * gap;
        if (!W.walkable(x, z, PLAYER_PAD) || !pathClear(P.x, P.z, x, z)) continue;
        if (pass === 0) {
          let crowd = false;
          for (const o of state.enemies) {
            if (o !== e && !o.dead && dist(o.x, o.z, x, z) < o.r + 0.45) {
              crowd = true;
              break;
            }
          }
          if (crowd) continue;
        }
        out.e = e;
        out.x = x;
        out.z = z;
        out.a = a;
        return true;
      }
    }
    return false;
  }

  // 挑下一刀的目标和落点，写进 out；没有够得着的返回 false。R 是这一刀的波及半径（已乘范围加成）。
  // c 为空：第一刀——准星 5 格以内离准星最近的优先，没有就取离玩家最近的。
  // 否则给 8 格内的候选打分，从高到低找第一个有落点的：身边 R 以内的敌人越多（这一刀能砍到几个）分越高；
  // 这一轮每被砍过一次扣一些、刚砍过的那只再扣一点（不绝对排除；候选都砍过一遍算一轮，计数清零）；离当前位置远的略扣。
  // 于是会一直往怪堆里跳，又在堆里轮着砍；堆打散了，落单的也轮得到。只剩一个目标时反复砍它，落点绕着它换方位
  const FLICK_SCORE = { crowd: 1, hit: 0.3, last: 0.3, far: 0.05 };
  const _cand = [];
  function flickerPick(sk, c, out, R) {
    const m = G.input.mouse;
    _cand.length = 0;
    for (const e of state.enemies) {
      if (e.dead || e.executed) continue;
      const dp = dist(e.x, e.z, P.x, P.z);
      if (dp - e.r > sk.range) continue;
      let score = 0;
      if (!c) {
        const dm = dist(e.x, e.z, m.wx, m.wz);
        score = dm - e.r <= 5 ? -dm : -1000 - dp;
      }
      _cand.push({ e, dp, score });
    }
    if (!_cand.length) return false;
    if (sk.pick === 'big' && _cand.length > 1) {
      // 刻式「斩首」：只闪向精英 / 首领；都没有就只留最大生命最高的那一个
      const big = _cand.filter((it) => it.e.elite || it.e.isBoss);
      if (big.length) _cand.splice(0, _cand.length, ...big);
      else {
        const top = _cand.reduce((p, q) => (q.e.maxHp > p.e.maxHp ? q : p));
        _cand.splice(0, _cand.length, top);
      }
    }
    if (c) {
      // 候选全都砍过了：这一轮结束，计数清零
      if (_cand.every((it) => c.hit.get(it.e) > 0)) c.hit.clear();
      const S = FLICK_SCORE;
      for (const it of _cand) {
        const e = it.e;
        let n = 0; // 以它为中心这一刀能砍到几个（含它自己）
        for (const o of state.enemies) if (!o.dead && dist(o.x, o.z, e.x, e.z) - o.r <= R) n++;
        it.score = n * S.crowd - (c.hit.get(e) || 0) * S.hit - (e === c.last ? S.last : 0) - it.dp * S.far;
        if (sk.noRepeat && e === c.last && _cand.length > 1) it.score -= 1000; // 刻式「乱刃」：有别的目标时不连砍同一个
      }
    }
    _cand.sort((a, b) => b.score - a.score);
    for (const it of _cand) {
      const e = it.e;
      // 新目标从靠近自己的一侧切入；同一个目标换个方位
      const ang0 = c && e === c.last ? c.lastAng + FLICK_TURN : Math.atan2(P.x - e.x, P.z - e.z);
      if (flickerSpot(e, ang0, out)) return true;
    }
    return false;
  }

  function updateFlicker(c, dt) {
    c.t += dt;
    if (c.pend) {
      // 已经闪到目标身边：盯着它，到点出刀。魔力已经付过，这时松手也把这一刀砍完
      const e = c.pend;
      if (!e.dead) P.face = c.aim = Math.atan2(e.x - P.x, e.z - P.z);
      if (c.t < c.strikeT) return;
      c.pend = null;
      c.pulses++;
      flickerStrike(c, e);
      return;
    }
    const held = slotHeld(c.slot) && G.save.bar[c.slot] === c.id;
    if (!held && c.pulses > 0) {
      endChannel();
      return;
    }
    if (c.t < c.nextT) return;
    const ctx = G.skillCtx(c.id);
    const sk = ctx.sk;
    if (!G.canAfford(ctx.cost)) {
      const now = Date.now();
      if (now - (toastAt.noCost || 0) > 1200) {
        toastAt.noCost = now;
        G.world.text(P.x, P.z, P.S.bloodMagic ? '生命不足' : '魔力不足', P.S.bloodMagic ? '#ff7a6a' : '#7fa8ff', 14);
      }
      endChannel();
      return;
    }
    if (!flickerPick(sk, c.last ? c : null, _fs, sk.radius * Math.sqrt(ctx.area))) {
      flickerNoTarget();
      endChannel();
      return;
    }
    const e = _fs.e;
    if (e.brokenT > 0 && G.execute(e)) return; // 处决接管（P.cast 已清掉）；还按着的话处决完接着连斩
    payCost(ctx.cost);
    // 闪过去：原地留下一团散开的影子，路上一串往后飘的光屑
    const W = G.world;
    const hex = hexOf(sk.color);
    const ox = P.x;
    const oz = P.z;
    P.x = _fs.x;
    P.z = _fs.z;
    W.burst(ox, 1.0, oz, 0x1c2238, 10, 2.2, 0.35);
    W.burst(ox, 1.1, oz, hex, 8, 3, 0.25);
    const dd = dist(ox, oz, P.x, P.z);
    if (dd > 0.3) {
      W.dashFx(ox, oz, P.x, P.z, hex);
      W.decal(0, (ox + P.x) / 2, (oz + P.z) / 2, dd / 2, Math.atan2(P.x - ox, P.z - oz), hex, 0.3, 0.22); // 贴地一道擦痕
    }
    W.burst(P.x, 1.0, P.z, hex, 8, 2.4, 0.22);
    const lead = Math.min(sk.lead[c.last ? 1 : 0], ctx.time * 0.55);
    const leadNext = Math.min(sk.lead[1], ctx.time * 0.55);
    P.iframe = Math.max(P.iframe, lead * 0.95); // 到出刀那一刻已经过期
    c.fired = true;
    c.cancelT = 0; // 闪出去之后随时可以接别的动作
    c.pend = e;
    c.last = e;
    c.lastAng = _fs.a;
    c.alt = !c.alt;
    c.strikeT = c.t + lead;
    c.nextT = c.strikeT + ctx.time - leadNext; // 两刀之间隔 time 秒（出手速度中途变了也按新的走）
    P.face = c.aim = Math.atan2(e.x - P.x, e.z - P.z);
    W.play(P.ent, c.alt ? 'flicker' : 'flicker2', { dur: lead + 0.17, contact: lead });
    W.setTrail(G.TYPE_HEX[mainType(ctx)]);
    G.sfx('roll');
  }

  // 落地出刀：砍中目标本身，外加目标身边 radius 以内的敌人（吃范围加成）
  function flickerStrike(c, e) {
    const W = G.world;
    const ctx = G.skillCtx(c.id);
    const sk = ctx.sk;
    const hex = hexOf(sk.color);
    const R = sk.radius * Math.sqrt(ctx.area);
    // 目标还在刀够得着的地方就以它为中心；被别的伤害打死或推远了，就砍向面前
    let cx = P.x + Math.sin(P.face) * 1.3;
    let cz = P.z + Math.cos(P.face) * 1.3;
    if (!e.dead && dist(e.x, e.z, P.x, P.z) - e.r <= 2.4) {
      cx = e.x;
      cz = e.z;
    }
    const ang = Math.atan2(cx - P.x, cz - P.z);
    P.face = c.aim = ang;
    c.hit.set(e, (c.hit.get(e) || 0) + 1);
    W.slash(P.x, P.z, ang, dist(cx, cz, P.x, P.z) + R * 0.75, 140, hex, { dir: c.alt ? 1 : -1, dur: 0.16 });
    G.sfx('swing', { step: c.alt ? 0 : 1 });
    const hits = enemiesIn(cx, cz, R);
    if (!hits.length) return;
    let crit = false;
    let top = 'phys';
    for (const o of hits) {
      G.hitEnemy(o, ctx, 1, { ang: Math.atan2(o.x - P.x, o.z - P.z), w: 0, kb: sk.kb, poise: sk.poise, quiet: true });
      crit = crit || lastHit.crit;
      top = lastHit.type;
    }
    const stop = ((sk.stop || 0) + (crit ? 15 : 0)) * ctx.stopK;
    G.hitStop(stop);
    W.shudder(P.ent, 0.02, stop / 1000);
    W.punch(ang, 0.12 + (crit ? 0.08 : 0));
    W.shake(crit ? 0.14 : 0.07);
    G.sfx('impact', { type: top, w: 0, crit });
  }

  function updateCast(dt) {
    const c = P.cast;
    if (c.ws) {
      updateWeaponCast(c, dt);
      return;
    }
    if (c.channel) {
      if (c.ranged) updateRanged(c, dt);
      else if (c.flicker) updateFlicker(c, dt);
      else updateChannel(c, dt);
      return;
    }
    const t0 = c.t;
    c.t += dt;
    if (!c.fired) {
      c.aim = aimInfo().ang; // 出手前一直跟随鼠标
      if (c.st && c.st.lunge > 0) lungeStep(c, t0);
      if (c.t >= c.fireT) {
        const ctx = G.skillCtx(c.id);
        if (!G.canAfford(ctx.cost)) {
          P.cast = null;
          return;
        }
        payCost(ctx.cost);
        if (ctx.cd > 0) {
          P.cds[c.id] = ctx.cd;
          P.cdMax[c.id] = ctx.cd;
        }
        c.fired = true;
        if (c.st) {
          // 这一段打出去了：下一次出下一段，窗口从「可以接下一段」的时刻算起
          P.combo.step = (c.step + 1) % ctx.sk.combo.length;
          P.combo.t = c.cancelT - c.fireT + COMBO_WINDOW;
        } else {
          G.sfx('cast');
        }
        G.execSkill(ctx, c.st);
        for (let i = 1; i <= ctx.echo; i++) {
          G.after(0.22 * i, () => {
            if (!P.dead) G.execSkill(ctx);
          });
        }
      }
    }
    if (P.cast === c) {
      P.face = c.aim;
      if (c.t >= c.dur) P.cast = null;
    }
  }

  // =====================================================================
  // 远程普攻（右键）：枪械与弓
  // =====================================================================
  // 按住右键是一个持续施放（P.cast.ranged）：机炮 / 喷枪按住才开火，左轮 / 弓轻点也至少出一发，按住连发。
  // 出手节奏 = 普攻的 time ÷ 出手速度（含武器攻速与迅捷）；P.gun.cdT 记着下一发最早能出手的时刻，反复轻点也快不过射速。
  // 动作优先播 world 的 'fire_<类型>'（机炮 / 喷枪循环播），没有时弓和左轮借用掷出的动作。
  // 外形与特效：投射物的 vk（bullet 机炮 / slug 左轮 / arrow 箭 / emberarrow 烬铸燃箭）由 world 画，枪口焰、弹壳、喷火跟着动作和弹丸自动出；
  // 地上的火（world.emberGround）、焚天炎爆（fireNova）、熔光射线（laser，每帧）、弓的增益光环（rangedBuff）是可选接口，没有时用通用特效顶上
  const RANGED_HOLD = { gatling: true, flamer: true }; // 这两种松手就停（不会因为轻点的缓冲多打一发）
  const MAX_FIELDS = 40;
  const fields = []; // 地上的火：喷枪的余烬、焚天炎爆的火场 { kind, x, z, r, t, tick, tt, mult, ctx, key, hex }
  const VK = { gatling: 'bullet', revolver: 'slug', flamer: 'flamelet', huntbow: 'arrow', eagle: 'arrow', runebow: 'arrow', emberbow: 'emberarrow' };

  function playFire(type, opts) {
    const W = G.world;
    if (W.play(P.ent, 'fire_' + type, opts)) return true;
    if (opts && opts.loop) return false;
    return W.play(P.ent, 'throw', opts);
  }
  function stopFireClip() {
    const W = G.world;
    const cl = W.clipOf(P.ent);
    if (cl && cl.indexOf('fire_') === 0) W.stop(P.ent, 0.14);
  }

  function startRanged(slot, ctx, ang) {
    const sk = ctx.sk;
    const g = P.gun;
    G.input.tap[slot] = 0;
    comboReset();
    let first = 0;
    if (sk.rtype === 'flamer') first = 0.04;
    else if (sk.rtype === 'revolver') first = g.reloadT > 0 ? g.reloadT : 0.03;
    else if (sk.draw) first = sk.draw / ctx.speed;
    first = Math.max(first, g.cdT);
    P.cast = {
      slot, id: ctx.id, t: 0, fired: false, aim: ang, step: -1, st: null, channel: true, ranged: true, rtype: sk.rtype,
      nextT: first, cancelT: Infinity, dur: Infinity, pulses: 0, move: sk.move, emberT: 0,
    };
    P.face = ang;
    if (RANGED_HOLD[sk.rtype]) {
      // 机炮 / 喷枪：按住期间随时可以接别的技能（空转时也是），不用等第一发
      P.cast.fired = true;
      P.cast.cancelT = 0;
      P.cast.clipOk = playFire(sk.rtype, { loop: true, dur: 0.6 });
    }
    // 弓：切入过渡不长于拉弓起手的 0.4（攻速很快时第一箭不会还没摆好侧身、手还在半路就开始拉弦）
    else if (sk.draw) playFire(sk.rtype, { dur: Math.max(0.2, first + 0.18), contact: Math.max(0.02, first), fade: Math.min(0.06, Math.max(0.02, first) * 0.4) });
    return true;
  }

  function endRanged() {
    P.cast = null;
    P.gun.firing = false;
    stopFireClip();
  }

  // 普攻的出手速度倍率（迅捷、攻速词缀 / 天赋，不含武器本身的攻速）：按发积攒的量表除以它，射得快不等于 R 来得快
  const speedK = (ctx) => Math.max(1, ctx.speed / ((ctx.weapon && ctx.weapon.aps) || 1));
  // 热度：开火时上涨（最近没打中东西时只涨 miss 倍），吃 heatGain
  function gainHeat(v) {
    const H = G.RANGED.heat;
    const k = (P.gun.hitT <= H.hitKeep ? 1 : H.miss) * Math.max(0, 1 + (P.S.heatGain || 0) / 100);
    P.gauge.heatIdle = 0;
    G.addGauge('heat', v * k);
  }

  function updateRanged(c, dt) {
    c.t += dt;
    c.aim = aimInfo().ang;
    P.face = c.aim;
    const sk = G.SKILLS[c.id];
    const g = P.gun;
    const held = slotHeld(c.slot) && G.slotSkill(c.slot) === c.id && !P.rstate;
    if (G.slotSkill(c.slot) !== c.id || P.rstate || (!held && (c.pulses > 0 || RANGED_HOLD[sk.rtype]))) {
      endRanged();
      return;
    }
    g.firing = true;
    if (sk.rtype === 'gatling') {
      // 枪管先转起来（spin 秒），转满之后才开火；射速从 rate0 倍涨到满，转满后连续开火 ramp 秒到最快
      g.spin = Math.min(1, g.spin + dt / Math.max(0.1, sk.spin / P.speedMult));
      if (g.spin < 1) {
        c.move = Math.max(sk.move, 0.5);
        c.nextT = c.t;
        return;
      }
      c.move = sk.move;
      g.ramp = Math.min(sk.ramp, g.ramp + dt);
      for (let n = 0; n < 4 && c.t >= c.nextT; n++) {
        const ctx = G.skillCtx(c.id);
        const iv = ctx.time / (sk.rate0 + (1 - sk.rate0) * (g.ramp / sk.ramp));
        c.nextT += iv;
        shotDone(c);
        fireGatling(ctx, c);
        gainHeat(sk.heat * iv);
      }
      return;
    }
    if (sk.rtype === 'flamer') {
      for (let n = 0; n < 3 && c.t >= c.nextT; n++) {
        const ctx = G.skillCtx(c.id);
        c.nextT += ctx.time;
        shotDone(c);
        fireFlamer(ctx, c);
        gainHeat(sk.heat * ctx.time);
      }
      return;
    }
    if (sk.rtype === 'revolver' && g.reloadT > 0) {
      c.nextT = Math.max(c.nextT, c.t + g.reloadT);
      return;
    }
    if (c.t < c.nextT) return;
    if (RFAM[sk.rtype] === 'bow') P.gun.cycle++; // 符文弓轮到下一个元素
    const ctx = G.skillCtx(c.id);
    c.nextT = c.t + ctx.time;
    g.cdT = ctx.time;
    shotDone(c);
    if (sk.rtype === 'revolver') {
      fireRevolver(ctx, c);
      gainHeat(sk.heatShot / speedK(ctx)); // 按发计，但出手速度不加快积攒：和机炮 / 喷枪一样按开火的时间涨
      playFire('revolver', { dur: Math.min(0.3, ctx.time * 0.95), contact: 0.02 });
    } else {
      fireBow(ctx, c);
      // 下一箭：拉弓的动作对到下一次放箭的时刻
      if (held) playFire(sk.rtype, { dur: Math.max(0.2, ctx.time + 0.05), contact: ctx.time * 0.92, fade: Math.min(0.06, ctx.time * 0.92 * 0.4) });
    }
  }
  // 打出了一发：之后随时可以接别的动作；记进统计（新手提示读）
  function shotDone(c) {
    c.fired = true;
    c.cancelT = 0;
    c.pulses++;
    state.stats.rShots = (state.stats.rShots || 0) + 1;
  }

  // 一发子弹 / 一支箭。o：{ cast 同一次出手共用的已命中集合, mult, multFn, after, vk 外形, tint, home, turn, reseek, pierce, chain, color, speed, range }
  function shootProj(ctx, ang, o) {
    const sk = ctx.sk;
    const dx = Math.sin(ang);
    const dz = Math.cos(ang);
    const speed = o.speed || sk.speed || 30;
    return G.spawnProjectile({
      owner: 'p', x: P.x + dx * 0.8, z: P.z + dz * 0.8, dx, dz,
      speed, r: o.r || sk.projR || 0.22, life: (o.range || sk.range || 20) / speed, color: o.color !== undefined ? o.color : hexOf(sk.color),
      ctx, pierce: o.pierce !== undefined ? o.pierce : ctx.pierce, chain: o.chain !== undefined ? o.chain : ctx.chain, explode: 0, hit: new Set(), cast: o.cast,
      vk: o.vk || VK[sk.rtype || sk.wtype], tint: o.tint, rtype: sk.rtype || sk.wtype, home: o.home || null, turn: o.turn || 0, reseek: o.reseek || 0,
      mult: o.mult || 1, multFn: o.multFn || null, after: o.after || null, ranged: true,
    });
  }
  function fireGatling(ctx, c) {
    const sk = ctx.sk;
    const n = Math.max(1, ctx.proj);
    const cast = new Set();
    const spr = sk.spread * DEG;
    const fan = n > 1 ? Math.min(30, 8 * (n - 1)) * DEG : 0;
    const tint = infuseHex(ctx);
    for (let i = 0; i < n; i++) {
      const ang = c.aim + (n > 1 ? -fan / 2 + (fan * i) / (n - 1) : 0) + G.rand(-spr, spr);
      shootProj(ctx, ang, { cast, vk: 'bullet', tint });
    }
    G.sfx('shot', { type: 'gatling' });
  }

  function fireRevolver(ctx, c) {
    const g = P.gun;
    const core = g.ammo <= 1 && P.uMech === 'core'; // 熔芯：一轮的最后一发是熔芯弹
    const use = core ? Object.assign({}, ctx, { crit: 100 }) : ctx;
    const n = Math.max(1, ctx.proj);
    const cast = new Set();
    const fan = n > 1 ? Math.min(30, 9 * (n - 1)) * DEG : 0;
    const tint = core ? G.TYPE_HEX.fire : infuseHex(ctx);
    for (let i = 0; i < n; i++) {
      const ang = c.aim + (n > 1 ? -fan / 2 + (fan * i) / (n - 1) : 0);
      shootProj(use, ang, { cast, vk: 'slug', tint, after: core ? coreBlast : null });
    }
    G.sfx('shot', { type: 'revolver' });
    g.ammo--;
    if (g.ammo <= 0) startReload(ctx);
  }
  function startReload(ctx) {
    const sk = G.SKILLS.basic_revolver;
    P.gun.ammo = 0;
    P.gun.reloadT = sk.reload / Math.max(0.2, (ctx && ctx.speed) || P.speedMult);
    fxOpt('reload', P.ent, P.gun.reloadT);
  }
  // 把一次出手的伤害全部换成某个元素（余烬、熔芯弹、元素爆炸用）
  function elemCtx(ctx, t) {
    let lo = 0, hi = 0;
    for (const k in ctx.base) {
      lo += ctx.base[k][0];
      hi += ctx.base[k][1];
    }
    const base = {};
    base[t] = [lo, hi];
    return Object.assign({}, ctx, { base });
  }
  function coreBlast(p, e) {
    const C = G.CORE_ROUND;
    const fctx = elemCtx(p.ctx, 'fire');
    fctx.crit = 0;
    const x = e.x, z = e.z;
    if (!fxOpt('coreBlast', x, z, C.r)) {
      G.world.ring(x, z, C.r, 0xff8a3c, 0.3);
      G.world.burst(x, 1.0, z, 0xff8a3c, 18, 6, 0.4);
    }
    for (const o of enemiesIn(x, z, C.r)) if (o !== e) G.hitEnemy(o, fctx, C.mult, { ang: Math.atan2(o.x - x, o.z - z), w: 1, quiet: true, extra: true });
    state.stats.coreRounds = (state.stats.coreRounds || 0) + 1;
  }

  // 喷枪：身前扇面（被墙截短）里的敌人每跳挨一下；每隔 ember.gap 秒在火舌尽头留下一团余烬
  function fireFlamer(ctx, c) {
    const W = G.world;
    const sk = ctx.sk;
    const R = rayLen(P.x, P.z, c.aim, sk.range * Math.sqrt(ctx.area), -0.3);
    const half = (sk.arc / 2) * DEG;
    const hits = [];
    for (const e of enemiesIn(P.x, P.z, R)) {
      const d = dist(e.x, e.z, P.x, P.z);
      if (d > e.r + 0.6) {
        const diff = Math.abs(angDiff(Math.atan2(e.x - P.x, e.z - P.z), c.aim));
        if (diff > half + Math.asin(Math.min(1, e.r / d))) continue;
      }
      if (!losClear(P.x, P.z, e.x, e.z)) continue;
      hits.push(e);
    }
    if (!c.clipOk && !fxOpt('flameCone', P.x, P.z, c.aim, R, sk.arc, ctx.time * 2.2)) {
      // world 没有喷火的动作（它会自己画火舌）时：撒几点火星顶上
      for (let i = 0; i < 3; i++) {
        const a = c.aim + G.rand(-half, half) * 0.8;
        const d = G.rand(0.8, R);
        W.burst(P.x + Math.sin(a) * d, 1.0, P.z + Math.cos(a) * d, i ? 0xff8a3c : 0xffd28a, 2, 1.6, 0.25);
      }
    }
    for (const e of hits) G.hitEnemy(e, ctx, 1, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: 0, kb: sk.kb, poise: sk.poise, quiet: true, faint: true });
    if (hits.length) G.sfx('impact', { type: 'fire', w: 0, crit: false });
    // 余烬
    const E = sk.ember;
    c.emberT -= ctx.time;
    if (E && c.emberT <= 0) {
      c.emberT += E.gap;
      const d = Math.max(1, R * 0.85);
      const x = P.x + Math.sin(c.aim) * d;
      const z = P.z + Math.cos(c.aim) * d;
      addField({ kind: 'ember', x, z, r: E.r * Math.sqrt(ctx.area), dur: E.dur, tick: E.tick, mult: E.mult, ctx, key: 'emberAt', hex: 0xff7a2c });
    }
  }

  // 地上的火：每 tick 秒对范围里的敌人造成 mult 倍伤害；同一个敌人在同一类火（key）里每 tick 秒只挨一下（几团余烬叠在一起也一样）
  function addField(f) {
    f.t = f.dur;
    f.tt = Math.min(0.15, f.tick);
    if (fields.length >= MAX_FIELDS) fields.shift();
    fields.push(f);
    if (!fxOpt('emberGround', f.x, f.z, f.r, f.dur, f.kind === 'burn')) G.world.decal(1, f.x, f.z, f.r * 0.9, Math.random() * TAU, f.hex || 0xff7a2c, f.dur);
    return f;
  }
  function updateFields(dt) {
    for (let i = fields.length - 1; i >= 0; i--) {
      const f = fields[i];
      f.t -= dt;
      if (f.t <= 0) {
        fields.splice(i, 1);
        continue;
      }
      f.tt -= dt;
      if (f.tt > 0) continue;
      f.tt += f.tick;
      for (const e of enemiesIn(f.x, f.z, f.r)) {
        if (state.time - (e[f.key] || -99) < f.tick * 0.95) continue;
        e[f.key] = state.time;
        G.hitEnemy(e, f.ctx, f.mult, { ang: Math.atan2(e.x - f.x, e.z - f.z), w: 0, kb: 0, poise: 1, quiet: true, faint: true, extra: true });
      }
    }
  }
  G.rangedFields = () => fields;

  // =====================================================================
  // 混沌流：黑洞、黑旋风（以及星蚀的渊口）
  // =====================================================================
  // 黑洞 { x, z, R 伤害半径, pullR 牵引半径, t, dur, tick, tt, ctx, mult, pullMul, mouth 是不是渊口, fx world 的句柄 }
  // 黑旋风 { x, z, a 朝向（弧度）, speed, life, R, ctx, cast 同一次施放共用的「敌人 → { next 下次可挨跳的时刻, n 已挨跳数 }」,
  //   seen 这一团吸过的「敌人 → 时刻」, lat 正吸着的敌人, latT 吸附剩下的秒数, latN 吸过几次, bounce 剩几次反弹, skip 贯穿剩几个, chain, wf 摆动参数, fx }
  const holes = [];
  const vortices = [];
  const HOLE_MAX = 3; // 场上玩家的黑洞（含渊口）最多几个，多了顶掉最老的
  const VORTEX_MAX = 20; // 场上的黑旋风最多几团（多重投射每次 5 团、寿命 2.2 秒，正常出手节奏下大约 20 团），多了顶掉最老的
  let mouthCd = 0; // 渊口：距离下次能新开还有几秒
  // 和击退一样的豁免：砸地蓄力、引信、陨角兽冲锋中的怪钉在原地（预警圈的位置才对得上）
  const pinned = (e) => e.state === 'fuse' || e.state === 'dash' || (e.state === 'windup' && e.def && e.def.ai === 'slam');
  function nearestHole(x, z, R) {
    let best = null, bd = R;
    for (const h of holes) {
      const d = dist(h.x, h.z, x, z);
      if (d <= bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }
  function addHole(h) {
    while (holes.length >= HOLE_MAX) removeHole(0);
    h.fx = G.world.makeHole ? G.world.makeHole(h.x, h.z, h.R, h.mouth, h.pullR) : null;
    holes.push(h);
    return h;
  }
  function removeHole(i) {
    const h = holes[i];
    holes.splice(i, 1);
    if (h.fx && G.world.removeHole) G.world.removeHole(h.fx);
  }
  function removeVortex(i) {
    const v = vortices[i];
    vortices.splice(i, 1);
    if (v.fx && G.world.removeVortex) G.world.removeVortex(v.fx);
  }
  // 渊口：小黑洞，伤害按黑洞宝石（没学时按同等级的基础值）× VOID_MOUTH.dmg
  function voidMouth(x, z) {
    const VM = G.VOID_MOUTH;
    if (mouthCd > 0 || !G.SKILLS.blackhole) return null;
    if (holes.filter((h) => h.mouth).length >= VM.max) return null;
    mouthCd = VM.gap;
    // 渊口按黑洞的原式算（刻式改的持续、伤害、牵引不带到渊口上）
    const keep = G.useVariant('blackhole', 'o');
    const ctx = G.skillCtx('blackhole');
    G.SKILLS.blackhole = keep;
    if (!G.save.skills.blackhole) ctx.base = G.skillBase('blackhole', G.gemFloor());
    const sk = ctx.sk, R = VM.radius * Math.sqrt(ctx.area);
    state.stats.mouths = (state.stats.mouths || 0) + 1;
    return addHole({ x, z, R, pullR: R * sk.pullR, t: 0, dur: VM.dur, tick: sk.tick, tt: sk.tick, ctx, mult: VM.dmg, pullMul: VM.pull, mouth: true });
  }
  G.voidMouth = voidMouth;
  // 刻式「奇点」：黑洞结束时向内坍塌，对中心 implode.r（吃范围加成）以内的敌人一次 implode.mult 倍的重击
  function holeImplode(h) {
    const W = G.world, I = h.ctx.sk.implode, R = I.r * Math.sqrt(h.ctx.area), hex = hexOf(h.ctx.sk.color);
    for (const e of enemiesIn(h.x, h.z, R)) G.hitEnemy(e, h.ctx, h.mult * I.mult, { ang: Math.atan2(e.x - h.x, e.z - h.z), w: 2, kb: 0.8, poise: 24 });
    W.ring(h.x, h.z, R, hex, 0.3);
    W.ring(h.x, h.z, R * 0.45, 0xffd6f2, 0.2);
    W.burst(h.x, 0.8, h.z, hex, 22, 7, 0.45);
    W.shake(0.28);
    G.sfx('hit');
    state.stats.implodes = (state.stats.implodes || 0) + 1;
  }

  function updateChaos(dt) {
    const W = G.world;
    if (mouthCd > 0) mouthCd -= dt;
    // ---- 黑洞 ----
    for (let i = holes.length - 1; i >= 0; i--) {
      const h = holes[i];
      h.t += dt;
      if (h.follow) G.relicHoleFollow(h); // 渊契「随核」
      if (h.t >= h.dur) {
        if (h.ctx.sk.implode && !h.mouth) holeImplode(h); // 刻式「奇点」：结束时内爆
        removeHole(i);
        continue;
      }
      const sk = h.ctx.sk;
      for (const e of state.enemies) {
        if (e.dead) continue;
        const d = dist(e.x, e.z, h.x, h.z);
        if (d - e.r > h.pullR || d <= sk.core) continue;
        let v;
        if (e.isBoss) v = sk.bossPull * (h.follow ? 1 : h.pullMul); // 随核：首领的牵引不变
        else {
          if (pinned(e)) continue;
          v = G.bindPullSpeed(e, sk.pull) * (0.6 + 0.4 * (1 - Math.min(1, d / h.pullR))) * h.pullMul;
          if (e.freeze > 0 || e.brokenT > 0) v *= 0.35;
        }
        if (G.pullEnemy) G.pullEnemy(e, h.x, h.z, Math.min(v * dt, d - sk.core));
      }
      h.tt -= dt;
      if (h.tt <= 0) {
        h.tt += h.tick;
        for (const e of enemiesIn(h.x, h.z, h.R)) {
          // 同一个敌人同一时刻只吃一个黑洞的跳（两个重叠的黑洞、渊口都不叠加）
          if (state.time - (e.holeT || -99) < h.tick * 0.95) continue;
          e.holeT = state.time;
          G.hitEnemy(e, h.ctx, h.mult, { ang: Math.atan2(e.x - h.x, e.z - h.z), w: 0, kb: 0, poise: sk.poise, quiet: true, faint: true, tick: true });
        }
      }
      if (h.fx && W.updateHole) W.updateHole(h.fx, h.t / h.dur, dt);
    }
    // ---- 黑旋风 ----
    for (let i = vortices.length - 1; i >= 0; i--) {
      const v = vortices[i];
      if (!updateVortex(v, dt)) {
        removeVortex(i);
        continue;
      }
      if (v.fx && W.updateVortex) W.updateVortex(v.fx, v.x, v.z, dt, !!v.lat);
    }
  }

  // ---- 黑旋风的地形：一层小包装，区域改版合进来以后不用改 ----
  // 投射物能不能飞过 (x, z)：有 W.shotFree 就用它（虚空 / 熔岩 / 深水上照样飞，只有真墙和悬崖挡），没有就退回 W.walkable
  function vxFree(x, z, pad) {
    const W = G.world;
    return W.shotFree ? W.shotFree(x, z, pad) : W.walkable(x, z, pad);
  }
  // 撞墙点 (x, z) 的法线（单位向量，指向能飞的一侧）；(px, pz) 是撞墙前最后一个能飞的点，(dx, dz) 是行进方向。
  // 有 W.sdAt：用它的梯度（中心差分）。W.sdAt 是「可走」的距离场，虚空 / 熔岩上也有梯度（指向岸边），所以只在撞墙前那一点在地面上
  //   （sd > −0.35：漩涡飞的时候可以压进墙 0.3）时用，并且反弹后的方向要真的能飞才算数；
  //   不满足就和没有 W.sdAt 时一样，在撞墙点周围一圈探 vxFree，能飞的方向加起来就是法线（state.stats 里分别计数）
  const VX_RING = [];
  for (let k = 0; k < 16; k++) VX_RING.push([Math.sin((k / 16) * TAU), Math.cos((k / 16) * TAU)]);
  function vxNormal(x, z, px, pz, dx, dz) {
    const W = G.world;
    if (W.sdAt && W.sdAt(px, pz) > -0.35) {
      const e = 0.25;
      let gx = W.sdAt(x + e, z) - W.sdAt(x - e, z), gz = W.sdAt(x, z + e) - W.sdAt(x, z - e);
      const gl = Math.hypot(gx, gz);
      if (gl > 1e-4) {
        gx /= gl;
        gz /= gl;
        const dn = dx * gx + dz * gz;
        if (dn < -0.05) {
          const rx = dx - 2 * dn * gx, rz = dz - 2 * dn * gz;
          if (vxFree(px + rx * 0.5, pz + rz * 0.5, -0.3)) {
            state.stats.vortexNormSdf = (state.stats.vortexNormSdf || 0) + 1;
            return { x: gx, z: gz, sdf: true };
          }
        }
      }
    }
    state.stats.vortexNormProbe = (state.stats.vortexNormProbe || 0) + 1;
    let nx = 0, nz = 0;
    for (const r of VX_RING) {
      if (vxFree(x + r[0] * 0.8, z + r[1] * 0.8, -0.3)) {
        nx += r[0];
        nz += r[1];
      }
    }
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-3) return { x: -dx, z: -dz, sdf: false };
    return { x: nx / nl, z: nz / nl, sdf: false };
  }
  G.vortexTerrain = { free: vxFree, normal: vxNormal };

  // 一团漩涡走一帧；返回 false 表示散了
  function updateVortex(v, dt) {
    const sk = v.ctx.sk, L = sk.latch;
    v.life -= dt;
    if (v.life <= 0) return false;
    v.t += dt;
    if (v.lat) {
      // 吸附中：贴着那只敌人，绕着它小小地转；把附近的小怪往漩涡拽
      const e = v.lat;
      v.latT -= dt;
      if (e.dead || v.latT <= 0) {
        v.lat = null;
        if (v.chain > 0) {
          // 连锁：拐向附近这一团还没吸过的最近敌人
          let best = null, bd = sk.hop.r;
          for (const o of state.enemies) {
            if (o.dead || v.seen.has(o)) continue;
            const d = dist(o.x, o.z, v.x, v.z);
            if (d <= bd) {
              bd = d;
              best = o;
            }
          }
          if (best) {
            v.chain--;
            v.a = Math.atan2(best.x - v.x, best.z - v.z);
            state.stats.vortexHops = (state.stats.vortexHops || 0) + 1;
          }
        }
      } else {
        const oa = v.t * 9;
        const tx = e.x + Math.sin(oa) * 0.25, tz = e.z + Math.cos(oa) * 0.25;
        if (vxFree(tx, tz, -0.3)) {
          v.x = tx;
          v.z = tz;
        }
        for (const o of state.enemies) {
          if (o.dead || o === e) continue;
          const d = dist(o.x, o.z, v.x, v.z);
          if (d - o.r > L.r || d < 0.6) continue;
          let sp;
          if (o.isBoss) sp = L.bossPull;
          else {
            if (pinned(o)) continue;
            sp = G.bindPullSpeed(o, L.pull) * (o.freeze > 0 || o.brokenT > 0 ? 0.35 : 1);
          }
          if (G.pullEnemy) G.pullEnemy(o, v.x, v.z, Math.min(sp * dt, d - 0.6));
        }
      }
    }
    if (!v.lat) {
      // 飞：朝向带一点摆动（两路正弦叠加），分小步走，撞墙按法线反弹
      v.a += sk.wander * (Math.sin(v.t * v.wf[0] + v.wf[1]) * 0.7 + Math.sin(v.t * v.wf[2] + v.wf[3]) * 0.5) * dt;
      const total = v.speed * dt;
      const steps = Math.max(1, Math.ceil(total / 0.3));
      for (let s = 0; s < steps; s++) {
        const dx = Math.sin(v.a), dz = Math.cos(v.a);
        const nx = v.x + (dx * total) / steps, nz = v.z + (dz * total) / steps;
        if (vxFree(nx, nz, -0.3)) {
          v.x = nx;
          v.z = nz;
          continue;
        }
        if (v.bounce <= 0) return false; // 反弹次数用完：再撞就散
        const n = vxNormal(nx, nz, v.x, v.z, dx, dz);
        const dn = dx * n.x + dz * n.z;
        let rx = dx - 2 * dn * n.x, rz = dz - 2 * dn * n.z;
        if (dn >= 0) {
          rx = n.x;
          rz = n.z;
        }
        v.a = Math.atan2(rx, rz);
        v.bounce--;
        state.stats.vortexBounces = (state.stats.vortexBounces || 0) + 1;
        if (v.fx && G.world.vortexBounce) G.world.vortexBounce(v.x, v.z, rx, rz);
      }
    }
    // 伤害：半径以内的敌人，同一次施放每 tick 秒最多一跳；吸附过的一共最多 cap 跳、只是卷到的 splashCap 跳（首领 bossCap）；碰到新的敌人就吸附
    for (const e of enemiesIn(v.x, v.z, v.R)) {
      if (!v.lat && v.latN < L.max && state.time - (v.seen.get(e) || -99) >= L.again) {
        v.seen.set(e, state.time);
        if (v.skip > 0) v.skip--; // 贯穿：这一只不吸，直接穿过
        else {
          v.lat = e;
          v.latT = L.t;
          v.latN++;
          let lc = v.cast.get(e);
          if (!lc) v.cast.set(e, (lc = { next: 0, n: 0 }));
          lc.lat = true;
          state.stats.vortexLatches = (state.stats.vortexLatches || 0) + 1;
        }
      }
      let c = v.cast.get(e);
      if (!c) v.cast.set(e, (c = { next: 0, n: 0 }));
      if (c.n >= (e.isBoss ? sk.bossCap : c.lat ? sk.cap : sk.splashCap) || state.time < c.next) continue;
      c.next = state.time + sk.tick * 0.95;
      c.n++;
      G.hitEnemy(e, v.ctx, 1, { ang: v.a, quiet: true, tick: true });
    }
    return true;
  }
  // 换区域 / 重生：黑洞和漩涡全部收起
  function resetChaos() {
    while (holes.length) removeHole(holes.length - 1);
    while (vortices.length) removeVortex(vortices.length - 1);
    mouthCd = 0;
  }
  G.chaosHoles = () => holes;
  G.chaosVortices = () => vortices;
  G.updateChaos = updateChaos;

  // 远距离系数（0..1）：命中点离你 farMin 以内为 0，farMax 以外为 1
  function farK(e) {
    const RG = G.RANGED;
    return G.clamp((dist(e.x, e.z, P.x, P.z) - RG.farMin) / (RG.farMax - RG.farMin), 0, 1);
  }
  // 弓的伤害倍率：鹰眼长弓的远距离加成（sk.far）+ rangeDmg
  function bowMult(p, e) {
    const sk = p.ctx.sk;
    const far = (sk.far || 0) + (P.S.rangeDmg || 0) / 100;
    return (p.mult || 1) * (1 + farK(e) * far);
  }
  // 追猎：挑一个大致在箭头方向上、离你 range 以内的敌人（越近、越正前方越优先）；exclude 里的跳过
  function pickHome(ang, R, exclude) {
    let best = null;
    let bs = Infinity;
    for (const e of state.enemies) {
      if (e.dead || (exclude && exclude.has(e))) continue;
      const d = dist(e.x, e.z, P.x, P.z);
      if (d - e.r > R) continue;
      const diff = Math.abs(angDiff(Math.atan2(e.x - P.x, e.z - P.z), ang));
      if (diff > 1.1) continue;
      const sc = d + diff * 6;
      if (sc < bs) {
        bs = sc;
        best = e;
      }
    }
    return best;
  }

  function fireBow(ctx, c) {
    const sk = ctx.sk;
    const type = sk.rtype;
    const buffId = P.rbuff && P.rbuff.t > 0 ? P.rbuff.id : null;
    const b = G.rangedBuff();
    const n = Math.max(1, ctx.proj);
    const fan = n > 1 ? Math.min(40, 10 * (n - 1)) * DEG : 0;
    const mainT = mainType(ctx);
    const tint = mainT !== 'phys' ? G.TYPE_HEX[mainT] : infuseHex(ctx);
    const color = mainT !== 'phys' ? G.TYPE_HEX[mainT] : hexOf(sk.color);
    const shared = new Set();
    const after = arrowAfter;
    for (let i = 0; i < n; i++) {
      const ang = c.aim + (n > 1 ? -fan / 2 + (fan * i) / (n - 1) : 0);
      if (buffId === 'volley' && b) {
        // 万矢：每支箭分成 split 支追踪箭，分给附近不同的敌人
        const used = new Set();
        const spr = b.fan * DEG;
        for (let j = 0; j < b.split; j++) {
          const a = ang - spr / 2 + (spr * j) / Math.max(1, b.split - 1);
          const home = pickHome(a, sk.range, used) || pickHome(ang, sk.range, null);
          if (home) used.add(home);
          shootProj(ctx, a, { vk: 'arrow', tint, color, mult: b.mult, multFn: bowMult, after, home, turn: sk.turn || 8, reseek: sk.seek || 7, cast: new Set() });
        }
        continue;
      }
      if (buffId === 'emberstorm' && b) {
        // 凛冬：一次射出 fan 支寒冰箭
        const spr = b.spread * DEG;
        for (let j = 0; j < b.fan; j++) {
          const a = ang - spr / 2 + (spr * j) / Math.max(1, b.fan - 1);
          shootProj(ctx, a, { vk: 'emberarrow', tint: G.TYPE_HEX.cold, color, mult: b.mult, multFn: bowMult, after, cast: new Set() });
        }
        continue;
      }
      const o = { vk: VK[type], tint, color, multFn: bowMult, after, cast: shared };
      if (type === 'huntbow') {
        o.home = pickHome(ang, sk.range, null);
        o.turn = sk.turn;
        o.reseek = sk.seek;
      }
      shootProj(ctx, ang, o);
    }
    G.sfx('shot', { type: 'bow' });
  }

  // 箭的直击之后：符文弓的元素满溢小爆炸、凛羽的冰晶连跳、凛冬的冰爆
  function arrowAfter(p, e, killed) {
    const sk = p.ctx.sk;
    const buffId = P.rbuff && P.rbuff.t > 0 ? P.rbuff.id : null;
    const b = G.rangedBuff();
    if (buffId === 'overflow' && b && b.burst) {
      const t = mainType(p.ctx);
      const ectx = elemCtx(p.ctx, t === 'phys' ? 'fire' : t);
      const R = b.burst.r;
      const x = e.x, z = e.z;
      if (!fxOpt('elemBurst', x, z, R, t)) {
        G.world.ring(x, z, R, G.TYPE_HEX[t] || 0xffffff, 0.25);
        G.world.burst(x, 1.0, z, G.TYPE_HEX[t] || 0xffffff, 10, 4, 0.3);
      }
      for (const o of enemiesIn(x, z, R)) G.hitEnemy(o, ectx, b.burst.mult, { ang: Math.atan2(o.x - x, o.z - z), w: 0, kb: 0.2, poise: 2, quiet: true, faint: o !== e, extra: true });
    }
    if (sk.spark) emberChain(p.ctx, e, buffId === 'emberstorm' && b ? b.spark : null);
    if (killed && buffId === 'emberstorm' && b && b.blast) emberBlast(p.ctx, e, b.blast);
  }
  // 冰晶（凛羽）：从 e 跳向 r 米内最近的、这一串还没跳过的敌人，最多 n 跳，每跳 mult 倍（冰霜）。拿着凛羽时每跳再灌一点冰霜异常值
  function emberChain(ctx, e0, boost) {
    const S0 = ctx.sk.spark;
    const n = boost ? boost.n : S0.n;
    const mult = boost ? boost.mult : S0.mult;
    const fctx = elemCtx(ctx, 'cold');
    const seen = new Set([e0]);
    let from = { x: e0.x, z: e0.z };
    let i = 0;
    const hop = () => {
      if (P.dead || i >= n) return;
      let best = null;
      let bd = S0.r;
      for (const o of state.enemies) {
        if (o.dead || seen.has(o)) continue;
        const d = dist(o.x, o.z, from.x, from.z) - o.r;
        if (d < bd) {
          bd = d;
          best = o;
        }
      }
      if (!best) return;
      seen.add(best);
      i++;
      if (!fxOpt('emberSpark', from.x, from.z, best.x, best.z)) G.world.bolt([{ x: from.x, z: from.z }, { x: best.x, z: best.z }], 0x9fd8ff, true);
      G.hitEnemy(best, fctx, mult, { ang: Math.atan2(best.x - from.x, best.z - from.z), w: 0, kb: 0.2, poise: 3, quiet: true, extra: true });
      const killed = lastHit.killed;
      if (P.uMech === 'ember' && !best.dead) G.fillMeter(best, 'cold', G.EMBER_MECH.ignite);
      state.stats.embers = (state.stats.embers || 0) + 1;
      const b = G.rangedBuff();
      if (killed && P.rbuff && P.rbuff.id === 'emberstorm' && b && b.blast) emberBlast(ctx, best, b.blast);
      from = { x: best.x, z: best.z };
      G.after(0.06, hop);
    };
    G.after(0.05, hop);
  }
  function emberBlast(ctx, e, B) {
    const fctx = elemCtx(ctx, 'cold');
    const x = e.x, z = e.z;
    if (!fxOpt('frostBlast', x, z, B.r)) {
      G.world.ring(x, z, B.r, 0x9fd8ff, 0.3);
      G.world.burst(x, 1.0, z, 0xbfe8ff, 16, 6, 0.4);
    }
    for (const o of enemiesIn(x, z, B.r)) G.hitEnemy(o, fctx, B.mult, { ang: Math.atan2(o.x - x, o.z - z), w: 1, kb: 0.8, poise: 6, quiet: true, extra: true });
    state.stats.emberBlasts = (state.stats.emberBlasts || 0) + 1;
  }

  // 远程普攻 / 量表技的命中：枪械记下「最近打中过」（热度按它涨满速），弓的普攻按命中积攒专注
  function rangedOnHit(e, ctx, hit, inf) {
    const sk = ctx.sk;
    if (!sk.basic || !sk.rtype || inf.extra) return; // 近战 / 施法 / 魂幡的普攻没有量表
    const fam = RFAM[sk.rtype];
    P.gun.hitT = 0;
    state.stats.rHits = (state.stats.rHits || 0) + 1;
    if (fam !== 'bow' || (P.rbuff && P.rbuff.t > 0)) return;
    const F = G.RANGED.focus;
    const src = inf.src;
    if (src) {
      src.fHits = (src.fHits || 0) + 1;
      if (src.fHits > F.cap) return;
    }
    let v = F.hit * (hit.crit ? F.crit : 1) * (dist(e.x, e.z, P.x, P.z) >= F.farD ? F.far : 1);
    v *= Math.max(0, 1 + (P.S.focusGain || 0) / 100) / speedK(ctx);
    P.gauge.focusIdle = 0;
    G.addGauge('focus', v);
  }

  // 每帧：机炮的转速回落、左轮装填、量表回落、增益 / 乱射计时、地上的火
  function tickRanged(dt) {
    const g = P.gun;
    const gg = P.gauge;
    const RG = G.RANGED;
    g.hitT += dt;
    if (g.cdT > 0) g.cdT = Math.max(0, g.cdT - dt);
    const c = P.cast && P.cast.ranged ? P.cast : null;
    if (!c) g.firing = false;
    if (!(c && c.rtype === 'gatling')) {
      g.spin = Math.max(0, g.spin - dt / 0.6);
      g.ramp = Math.max(0, g.ramp - dt * 2);
    }
    // 左轮：打空自动装填；停火一会儿也把没打完的这一轮补满
    if (g.reloadT > 0) {
      g.reloadT -= dt;
      if (g.reloadT <= 0) {
        g.reloadT = 0;
        g.ammo = G.SKILLS.basic_revolver.clip;
      }
    } else if (g.ammo < G.SKILLS.basic_revolver.clip && !c && g.cdT <= 0 && gg.heatIdle > 1.5 && G.rangedWeapon() && G.rangedWeapon().type === 'revolver') {
      startReload(null);
    }
    // 量表：满了就一直亮着等你放；没满时停火 / 没命中一阵子后慢慢回落
    gg.heatIdle += dt;
    gg.focusIdle += dt;
    if (gg.heat < RG.max && gg.heatIdle > RG.heat.hold) gg.heat = Math.max(0, gg.heat - RG.heat.decay * dt);
    if (gg.focus < RG.max && gg.focusIdle > RG.focus.hold) gg.focus = Math.max(0, gg.focus - RG.focus.decay * dt);
    // 弓的增益：到点，或者换下了那把弓，就结束
    if (P.rbuff) {
      P.rbuff.t -= dt;
      const rw = G.rangedWeapon();
      if (P.rbuff.t <= 0 || !rw || rw.type !== G.SKILLS[P.rbuff.id].wtype) endBuff();
    }
    if (P.rstate) updateWildfire(dt);
    updateFields(dt);
  }
  function endBuff() {
    if (!P.rbuff) return;
    P.rbuff = null;
    fxOpt('rangedBuff', null);
  }
  // 换区域 / 重生：量表、增益、乱射、地上的火、枪的状态都清掉
  function resetRanged() {
    P.gauge.heat = P.gauge.focus = 0;
    P.gauge.heatIdle = P.gauge.focusIdle = 99;
    const g = P.gun;
    g.spin = g.ramp = g.reloadT = g.cdT = 0;
    g.ammo = G.SKILLS.basic_revolver.clip;
    g.hitT = 99;
    g.firing = false;
    endBuff();
    P.rstate = null;
    fields.length = 0;
    resetChaos(); // 黑洞、黑旋风一起收起
    G.relicReset(); // 渊契的电桥、蓄潮
  }
  G.resetRanged = resetRanged;

  // ---------- 技能效果 ----------
  const SKILL_FX = {
    // st：连击的哪一段（缺省按第一段）
    melee(ctx, a, st) {
      const W = G.world;
      const sk = ctx.sk;
      if (!st) st = sk.combo ? sk.combo[0] : { shape: 'arc', range: sk.range, arc: sk.arc, mult: 1, dir: 1, w: 0, stop: 35, kb: sk.kb, poise: sk.poise };
      const k = Math.sqrt(ctx.area);
      const hex = hexOf(sk.color);
      const R = (st.range || 0) * k;
      const hits = [];
      let cx = P.x;
      let cz = P.z;
      if (st.shape === 'smash') {
        // 跃起下劈：落点在身前 reach 处，砸出一个圆；贴身的敌人也躲不掉
        cx = P.x + a.dx * st.reach * k;
        cz = P.z + a.dz * st.reach * k;
        for (const e of state.enemies) {
          if (e.dead) continue;
          if (dist(e.x, e.z, cx, cz) - e.r <= R || dist(e.x, e.z, P.x, P.z) <= e.r + 1.0) hits.push(e);
        }
        // 卡通版：一弯竖起来的月牙从头顶劈到身前的地上（tilt π/2 竖起、pitch 把弧的中线抬高 30°，dir -1 从上往下扫），
        // 落点一圈实心的尘团 + 碎石尖片 + 一颗大星（W.smashFx），地裂是硬边的
        W.slash(P.x, P.z, a.ang, st.reach * k + 0.4, 130, hex, { dur: 0.22, inner: 0.62, y: 1.1, tilt: Math.PI / 2, pitch: -0.52, dir: -1 });
        W.ring(cx, cz, R, hex, 0.34);
        if (!st.wave) W.ring(cx, cz, R * 0.55, 0xffe2b0, 0.2); // 带冲击波的（战锤普攻的终结）外面还要荡一圈：里面这圈省掉，场上同时的环（各占一次 draw call）不多出来
        W.decal(5, cx, cz, R * 0.95, Math.random() * TAU, 0xffb050, 2.6);
        W.smashFx(cx, cz, R, a.ang);
        W.shake(0.24);
      } else if (st.shape === 'line') {
        // 武器普攻的直线（刃的突刺、双匕的快刺、太刀的冲斩）：身前 len × width 的一条，撞墙截断；
        // dash：先朝准星冲过 dash 米（撞墙截断，冲过敌人不停），冲过的路连同身前 len 都算
        const half = (st.width / 2) * k;
        const x0 = P.x;
        const z0 = P.z;
        let len = st.len * k;
        if (st.dash) {
          const d = rayLen(P.x, P.z, a.ang, st.dash, PLAYER_PAD);
          if (d > 0) {
            P.x += a.dx * d;
            P.z += a.dz * d;
          }
          len = d + Math.max(0.9, len);
          if (!fxOpt('basicDash', x0, z0, P.x, P.z, hex)) W.dashFx(x0, z0, P.x, P.z, hex);
        } else len = Math.max(0.6, rayLen(x0, z0, a.ang, len, -0.2) + 0.4);
        for (const e of enemiesInLine(x0, z0, a.ang, len, half)) if (losClear(x0, z0, e.x, e.z)) hits.push(e);
        // 锋芒：一道细长的直线刀光（world.thrustFx，没有时用窄扇形顶上）
        const reach = st.dash ? len - dist(x0, z0, P.x, P.z) : len;
        if (!fxOpt('thrustFx', P.x, P.z, a.ang, reach, hex)) W.slash(P.x, P.z, a.ang, reach, 24, hex, { dur: 0.14, inner: 0.15, y: 1.1 });
      } else {
        const half = (st.arc / 2) * DEG;
        for (const e of enemiesIn(P.x, P.z, R)) {
          const d = dist(e.x, e.z, P.x, P.z);
          // 贴脸的敌人必中；体型大的敌人放宽夹角
          if (d > e.r + 0.6) {
            const diff = Math.abs(angDiff(Math.atan2(e.x - P.x, e.z - P.z), a.ang));
            if (diff > half + Math.asin(Math.min(1, e.r / d))) continue;
          }
          hits.push(e);
        }
        // 卡通版：实色月牙只占外圈（inner 0.8），刀光本身由跟着武器的月牙带子画；
        // 月牙的终点一侧抬起来（tilt = dir × k）：横斩微微斜着，反手上挑斜得明显
        W.slash(P.x, P.z, a.ang, R, st.arc, hex, { dir: st.dir, inner: 0.8, dur: 0.2, tilt: st.dir === -1 ? -0.3 : 0.12 }); // phase 3：inner 0.74 → 0.8，月牙带子窄约 23%
        // 双匕的交叉斩：再反向画一道，两道月牙交成一个叉
        if (st.cross) W.slash(P.x, P.z, a.ang, R * 0.94, st.arc, hex, { dir: -st.dir, inner: 0.8, dur: 0.2, tilt: st.dir === -1 ? 0.3 : -0.3 });
      }
      // 砸地之后荡开的冲击波（战锤普攻的终结）：砸中的不再吃，墙后的不吃
      if (st.wave) {
        const wr = st.wave.r * k;
        if (!fxOpt('basicWave', cx, cz, wr, hex)) {
          W.ring(cx, cz, wr, 0xffe2b0, 0.42);
          W.burst(cx, 0.3, cz, 0xcbbba6, 12, 6, 0.4);
        }
        const wave = [];
        for (const e of enemiesIn(cx, cz, wr)) if (hits.indexOf(e) < 0 && losClear(cx, cz, e.x, e.z)) wave.push(e);
        for (const e of wave) G.hitEnemy(e, ctx, st.wave.mult, { ang: Math.atan2(e.x - cx, e.z - cz), w: 1, kb: st.wave.kb, poise: st.wave.poise, quiet: true });
      }
      if (!hits.length) return;
      let crit = false;
      let top = 'phys';
      for (const e of hits) {
        // 击退方向：从玩家指向敌人；横斩再带一点顺着刀势的切向，两段的手感因此不同
        let ang = Math.atan2(e.x - P.x, e.z - P.z);
        if (st.shape === 'line') ang = a.ang; // 直线：顺着刺出的方向顶出去
        else if (st.shape !== 'smash') ang += (st.dir || 1) * 0.4;
        G.hitEnemy(e, ctx, st.mult, { ang, w: st.w, kb: st.kb, poise: st.poise, quiet: true });
        crit = crit || lastHit.crit;
        top = lastHit.type;
        if (!e.dead) W.shudder(e.ent, 0.05 + st.w * 0.03, (st.stop + 50) / 1000);
      }
      // 这一刀砍中了：顿帧、镜头顺势一顶、一声闷响；终结技再加一记推近
      const stop = (st.stop + (crit ? 25 : 0)) * ctx.stopK;
      G.hitStop(stop);
      W.shudder(P.ent, 0.022, stop / 1000);
      // 卡通版：镜头的顶（有方向）多一点，乱抖少一点、收得更快（衰减见 world.js W.update 的 shakeAmt）
      W.punch(a.ang, 0.2 + st.w * 0.24 + (crit ? 0.1 : 0));
      W.shake(st.w >= 2 ? 0.4 : crit ? 0.17 : 0.07);
      G.sfx('impact', { type: top, w: st.w, crit });
      if (st.w >= 2) {
        W.fovKick(2.6);
        G.sfx('finisher');
        state.stats.finishers++;
      }
    },

    proj(ctx, a) {
      const sk = ctx.sk;
      const n = Math.max(1, ctx.proj) + (sk.count > 1 ? sk.count - 1 : 0); // 刻式「散焰」：基础 count 团，多重投射再加
      const spread = Math.min(60, (sk.spread || 12) * (n - 1)) * DEG;
      const stepA = n > 1 ? spread / (n - 1) : 0;
      const hex = sk.elemHex ? G.TYPE_HEX[mainType(ctx)] : hexOf(sk.color); // elemHex：武器普攻按这一下的元素取色
      const cast = new Set(); // 这一次施放里已经受过伤（直击或爆炸）的敌人，所有投射物共用
      // 刻式：「散焰」每团各记各的（多重投射多出来的轮流并进这几份），同一次施放对同一个敌人最多 count 下；「回刃」回程另记一份
      const casts = sk.count > 1 ? [] : null;
      if (casts) for (let i = 0; i < sk.count; i++) casts.push(i ? new Set() : cast);
      const back = sk.returns ? new Set() : null;
      const tint = infuseHex(ctx);
      for (let i = 0; i < n; i++) {
        const ang = a.ang - spread / 2 + stepA * i;
        const dx = Math.sin(ang);
        const dz = Math.cos(ang);
        G.spawnProjectile({
          owner: 'p', x: P.x + dx * 0.7, z: P.z + dz * 0.7, dx, dz,
          speed: sk.speed, r: sk.projR || 0.3, life: 30 / sk.speed, color: hex,
          ctx, pierce: ctx.pierce, chain: ctx.chain, explode: sk.explode || 0, hit: new Set(), cast: casts ? casts[i % casts.length] : cast,
          vk: sk.vk || ctx.id, tint, ret: sk.returns || 0, back,
        });
      }
    },

    chain(ctx, a) {
      const W = G.world;
      const sk = ctx.sk;
      const hex = sk.elemHex ? G.TYPE_HEX[mainType(ctx)] : hexOf(sk.color);
      if (sk.line) return lineBolt(ctx, a); // 刻式「贯雷」：不连锁，改一道直线
      // 首个目标：准星附近优先，其次是瞄准方向上最近的敌人
      let first = null;
      let bd = Infinity;
      for (const e of state.enemies) {
        if (e.dead) continue;
        const dc = dist(e.x, e.z, a.tx, a.tz);
        if (dc - e.r <= 5 && dist(e.x, e.z, P.x, P.z) - e.r <= sk.range && dc < bd) {
          bd = dc;
          first = e;
        }
      }
      if (!first) {
        for (const e of state.enemies) {
          if (e.dead) continue;
          const dp = dist(e.x, e.z, P.x, P.z);
          if (dp - e.r > 12 || dp >= bd) continue;
          const diff = Math.abs(angDiff(Math.atan2(e.x - P.x, e.z - P.z), a.ang));
          if (dp > e.r + 0.6 && diff > 0.6 + Math.asin(Math.min(1, e.r / dp))) continue;
          bd = dp;
          first = e;
        }
      }
      const pts = [{ x: P.x, z: P.z }];
      if (!first) {
        pts.push({ x: P.x + a.dx * 6, z: P.z + a.dz * 6 });
        W.bolt(pts, hex);
        return;
      }
      const hit = new Set();
      let cur = first;
      let jumps = ctx.chain;
      let px = P.x;
      let pz = P.z;
      while (cur) {
        hit.add(cur);
        pts.push({ x: cur.x, z: cur.z });
        const cx = cur.x;
        const cz = cur.z;
        G.hitEnemy(cur, ctx, 1, { ang: Math.atan2(cx - px, cz - pz) }); // 顺着电弧来的方向
        px = cx;
        pz = cz;
        cur = null;
        if (jumps-- <= 0) break;
        let nd = sk.jump || 7; // 跳距（刻式「雷网」更远）
        for (const e of state.enemies) {
          if (e.dead || hit.has(e)) continue;
          const d = dist(e.x, e.z, cx, cz);
          if (d <= nd) {
            nd = d;
            cur = e;
          }
        }
      }
      W.bolt(pts, hex);
      if (P.relic.dianqiao) G.relicBridges(pts, ctx); // 渊契「电桥」
    },

    // 魂幡的普攻「魂引」：一缕魂灵扑向准星附近的敌人（没有就朝准星飞），碰到即炸开；目标标成集火（召唤物优先打它）
    bspirit(ctx, a) {
      const sk = ctx.sk;
      const hex = hexOf(sk.color);
      let e = null;
      let bd = Infinity;
      for (const o of state.enemies) {
        if (o.dead) continue;
        const dc = dist(o.x, o.z, a.tx, a.tz) - o.r;
        if (dc <= sk.seek && dist(o.x, o.z, P.x, P.z) - o.r <= sk.range && dc < bd && losClear(P.x, P.z, o.x, o.z)) {
          bd = dc;
          e = o;
        }
      }
      if (e) {
        state.focus = e;
        state.focusT = FOCUS_KEEP;
      }
      const ang = e ? Math.atan2(e.x - P.x, e.z - P.z) : a.ang;
      const dx = Math.sin(ang);
      const dz = Math.cos(ang);
      G.spawnProjectile({
        owner: 'p', x: P.x + dx * 0.7, z: P.z + dz * 0.7, dx, dz,
        speed: sk.speed, r: sk.projR, life: sk.life, color: hex,
        ctx, pierce: 0, chain: 0, explode: sk.explode, hit: new Set(), home: e, turn: sk.turn, wisp: true, fizzle: true,
      });
      fxOpt('spiritCall', P.x, P.z, ang, hex, e);
    },

    meteor(ctx, a) {
      const W = G.world;
      const sk = ctx.sk;
      const d = Math.min(sk.range, a.dist);
      const x = P.x + a.dx * d;
      const z = P.z + a.dz * d;
      const R = sk.radius * Math.sqrt(ctx.area);
      const hex = hexOf(sk.color);
      if (sk.fall) return starFall(ctx, x, z); // 刻式「星落」：接连落下几颗小陨石
      W.meteorFall(x, z, sk.delay, hex);
      G.telegraph({
        shape: 'circle', x, z, r: R, dur: sk.delay, dmg: 0, friendly: true,
        onFire() {
          for (const e of enemiesIn(x, z, R)) G.hitEnemy(e, ctx, 1, { ang: Math.atan2(e.x - x, e.z - z) }); // 从落点往外炸开
          W.decal(1, x, z, R * 0.95, Math.random() * TAU, hex, 5);
          W.ring(x, z, R, hex, 0.45);
          W.burst(x, 0.8, z, hex, 46, 9, 0.7);
          W.burst(x, 0.5, z, 0xffe0a0, 16, 5, 0.5);
          W.shake(0.5);
          G.sfx('hit');
        },
      });
    },

    // 旋风斩的一下：身边一整圈。击退顺着旋转方向带一下（切向为主），敌人被卷着走而不是被推出圈外
    spin(ctx) {
      const W = G.world;
      const sk = ctx.sk;
      const R = sk.radius * Math.sqrt(ctx.area);
      const hex = hexOf(sk.color);
      const c = P.cast;
      const n = c && c.channel ? c.pulses : 0;
      const rk = P.relic.nuchao ? G.relicSpinPulse(ctx) : 1; // 渊契「蓄潮」：每跳打得轻、攒层
      W.slash(P.x, P.z, Math.random() * TAU, R, 360, hex, { dur: 0.2, inner: 0.6, y: 0.9 });
      if (n % 2 === 1) W.burst(P.x, 0.25, P.z, 0xbfb3a0, 4, R * 0.9, 0.3); // 脚下扬起的尘
      G.sfx('swing', { step: n % 2 });
      const hits = enemiesIn(P.x, P.z, R);
      if (!hits.length) return;
      let crit = false;
      let top = 'phys';
      for (const e of hits) {
        const ang = Math.atan2(e.x - P.x, e.z - P.z) + 1.15; // 旋转是逆时针（俯视），切向偏一点向外
        G.hitEnemy(e, ctx, rk, { ang, w: 0, kb: sk.kb, poise: sk.poise, quiet: true });
        crit = crit || lastHit.crit;
        top = lastHit.type;
      }
      G.hitStop(((sk.stop || 0) + (crit ? 15 : 0)) * ctx.stopK);
      W.shake(crit ? 0.14 : 0.06);
      G.sfx('impact', { type: top, w: 0, crit });
    },

    blink(ctx, a) {
      const W = G.world;
      const sk = ctx.sk;
      const hex = hexOf(sk.color);
      const ox = P.x;
      const oz = P.z;
      // 从目标点往回退，直到落在可走的地方
      let d = Math.min(sk.range, a.dist);
      while (d > 0 && !W.walkable(ox + a.dx * d, oz + a.dz * d, 0.6)) d -= 0.4;
      W.burst(ox, 1.0, oz, hex, 18, 4, 0.4);
      if (d > 0) {
        P.x = ox + a.dx * d;
        P.z = oz + a.dz * d;
        W.bolt([{ x: ox, z: oz }, { x: P.x, z: P.z }], hex);
      }
      P.roll.t = 0;
      P.iframe = Math.max(P.iframe, 0.2);
      const R = sk.radius * Math.sqrt(ctx.area);
      W.burst(P.x, 1.0, P.z, hex, 24, 6, 0.45);
      W.ring(P.x, P.z, R, hex, 0.3);
      let n = 0;
      let crit = false;
      for (const e of enemiesIn(P.x, P.z, R)) {
        G.hitEnemy(e, ctx, 1, { quiet: true });
        crit = crit || lastHit.crit;
        n++;
      }
      if (n) {
        // 落地砸中：一记重击的顿帧
        G.hitStop(((sk.stop || 70) + (crit ? 20 : 0)) * ctx.stopK);
        W.punch(a.ang, 0.3);
        W.shake(0.3);
        G.sfx('impact', { type: lastHit.type, w: 1, crit });
      }
    },
  };

  // ---------- 刻式的两个新形状 ----------
  // 贯雷：朝准星放一道 line.len 长、line.width 宽的直线（吃范围加成的是宽度），遇墙即止（虚空 / 熔岩上照样过去），贯穿线上所有敌人
  function lineBolt(ctx, a) {
    const W = G.world, sk = ctx.sk, L = sk.line, hex = hexOf(sk.color);
    let len = 0;
    while (len + 0.25 <= L.len && W.shotFree(P.x + a.dx * (len + 0.25), P.z + a.dz * (len + 0.25), -0.3)) len += 0.25;
    const hits = enemiesInLine(P.x, P.z, a.ang, len, (L.width / 2) * Math.sqrt(ctx.area));
    const along = (e) => (e.x - P.x) * a.dx + (e.z - P.z) * a.dz;
    hits.sort((p, q) => along(p) - along(q));
    const pts = [{ x: P.x, z: P.z }];
    for (const e of hits) {
      pts.push({ x: e.x, z: e.z });
      G.hitEnemy(e, ctx, 1, { ang: a.ang });
    }
    pts.push({ x: P.x + a.dx * len, z: P.z + a.dz * len });
    W.bolt(pts, hex);
    W.bolt([pts[0], pts[pts.length - 1]], hex, true); // 再叠一道细的直线，看得出是一条贯穿线
  }
  // 星落：fall.span 秒内接连落下 fall.n 颗小陨石（半径 radius，各自 delay 秒后落地），
  // 先在准星 fall.r 以内（吃范围加成）的敌人里按离准星远近轮流挑落点，一颗砸一个，敌人少就轮回来；没有敌人就散落在这一圈里
  function starFall(ctx, x, z) {
    const W = G.world, sk = ctx.sk, F = sk.fall, hex = hexOf(sk.color), ak = Math.sqrt(ctx.area);
    const R = sk.radius * ak, FR = F.r * ak;
    const tg = enemiesIn(x, z, FR).sort((p, q) => dist(p.x, p.z, x, z) - dist(q.x, q.z, x, z));
    for (let i = 0; i < F.n; i++) {
      G.after((F.span * i) / Math.max(1, F.n - 1), () => {
        let e = tg.length ? tg[i % tg.length] : null;
        if (e && e.dead) e = tg.find((o) => !o.dead) || null;
        let px = x, pz = z;
        if (e) {
          px = e.x;
          pz = e.z;
        } else {
          const r = FR * Math.sqrt(Math.random()), t = Math.random() * TAU;
          if (W.walkable(x + Math.sin(t) * r, z + Math.cos(t) * r, 0)) {
            px = x + Math.sin(t) * r;
            pz = z + Math.cos(t) * r;
          }
        }
        W.meteorFall(px, pz, sk.delay, hex);
        G.telegraph({
          shape: 'circle', x: px, z: pz, r: R, dur: sk.delay, dmg: 0, friendly: true,
          onFire() {
            for (const o of enemiesIn(px, pz, R)) G.hitEnemy(o, ctx, 1, { ang: Math.atan2(o.x - px, o.z - pz) });
            W.decal(1, px, pz, R * 0.95, Math.random() * TAU, hex, 3);
            W.ring(px, pz, R, hex, 0.35);
            W.burst(px, 0.7, pz, hex, 16, 6, 0.5);
            W.shake(0.2);
            G.sfx('hit');
          },
        });
      });
    }
  }

  // 光环的一次脉冲：身边 radius（吃范围加成）以内的所有敌人各挨一小下（光环不经过施放，这里只在被直接调用时生效）
  SKILL_FX.aura = function (ctx) {
    const R = G.auraRadius(ctx);
    const hits = enemiesIn(P.x, P.z, R);
    G.world.auraPulse(hits.length > 0);
    for (const e of hits) G.hitEnemy(e, ctx, 1, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: 0, kb: 0, poise: ctx.sk.poise || 0, quiet: true, aura: true });
    return hits.length;
  };
  G.auraRadius = (ctx) => ctx.sk.radius * Math.sqrt(ctx.area);
  // 每帧：技能栏上的光环按各自的间隔脉冲；地上的霜环跟着玩家（光环不在技能栏上就收起）
  function updateAuras(dt) {
    const W = G.world;
    let shown = 0;
    // 兜底：技能栏变了却没人重算属性时，保留比例对不上就当场重算（不然光环生效了却没扣保留）
    if (G.reservePct() !== P.reservePct) G.computeStats();
    for (const id of Object.keys(G.SKILLS)) {
      if (!G.auraOn(id)) {
        if (P.auraT[id] !== undefined) delete P.auraT[id];
        continue;
      }
      if (G.SKILLS[id].buff) continue; // 黑焰这类增益光环：不脉冲、不画地上的霜环（特效见 W.setFlame）
      const ctx = G.skillCtx(id);
      if (!shown) shown = G.auraRadius(ctx);
      if (P.dead) continue;
      if (P.auraT[id] === undefined) P.auraT[id] = Math.min(0.2, ctx.time); // 刚放上技能栏：很快来第一下
      P.auraT[id] -= dt;
      if (P.auraT[id] <= 0) {
        P.auraT[id] += ctx.time;
        if (P.auraT[id] < 0) P.auraT[id] = ctx.time * 0.5;
        SKILL_FX.aura(ctx);
      }
    }
    W.setAura(P.dead ? 0 : shown);
    if (W.setFlame) W.setFlame(!P.dead && G.auraOn('blackflame'));
  }
  G.updateAuras = updateAuras;

  // 召唤：在准星处唤起召唤物（落点、数量上限与替换都由 minions.js 处理）
  SKILL_FX.summon = function (ctx, a) {
    if (G.summonMinion) G.summonMinion(ctx.id, a.tx, a.tz, ctx);
  };

  // 混沌流的两招（逻辑在上面「混沌流」一节：黑洞 / 黑旋风的每帧更新）
  SKILL_FX.hole = function (ctx, a) {
    const sk = ctx.sk;
    const d = rayLen(P.x, P.z, a.ang, Math.min(sk.range, a.dist), 0.3); // 撞墙截在墙前
    const R = sk.radius * Math.sqrt(ctx.area);
    const dur = sk.dur * (1 + Math.max(0, P.S.holeDur || 0) / 100);
    if (P.relic.yinli) return G.relicHole(ctx, R, dur); // 渊契「随核」：黑洞跟着你
    G.sfx('cast');
    return addHole({ x: P.x + a.dx * d, z: P.z + a.dz * d, R, pullR: R * sk.pullR, t: 0, dur, tick: sk.tick, tt: sk.tick, ctx, mult: 1, pullMul: 1, mouth: false });
  };

  SKILL_FX.vortex = function (ctx, a) {
    const sk = ctx.sk;
    const n = sk.count + Math.max(0, ctx.proj - 1); // 基础三团，多重投射再加
    const spread = Math.min(80, sk.spread * (n - 1)) * DEG;
    const stepA = n > 1 ? spread / (n - 1) : 0;
    const cast = new Map(); // 同一次施放的几团共用：同一个敌人每 tick 秒最多一跳、一共最多 cap 跳
    const R = sk.radius * Math.sqrt(ctx.area);
    for (let i = 0; i < n; i++) {
      const ang = a.ang - spread / 2 + stepA * i;
      let x = P.x + Math.sin(ang) * 0.8, z = P.z + Math.cos(ang) * 0.8;
      if (!vxFree(x, z, -0.3)) {
        x = P.x;
        z = P.z;
      }
      const v = {
        x, z, a: ang, speed: sk.speed, life: sk.life, t: 0, R, ctx, cast, seen: new Map(), lat: null, latT: 0, latN: 0,
        bounce: sk.bounce, skip: ctx.pierce, chain: ctx.chain,
        // 摆动：两路正弦的频率 / 相位，每团不同
        wf: [G.rand(2.2, 3.4), i * 2.1 + G.rand(0, TAU), G.rand(4.5, 6.5), i * 1.3 + G.rand(0, TAU)],
      };
      while (vortices.length >= VORTEX_MAX) removeVortex(0);
      v.fx = G.world.makeVortex ? G.world.makeVortex(v.x, v.z, R, i) : null;
      vortices.push(v);
    }
    G.sfx('cast');
  };

  // ---------- 自动召唤 ----------
  // 开关按技能存在 save.autoSummon 里；只对放在技能栏上的召唤技能生效（拿下来时保留开关，放回去接着补）。
  // 开着时：数量没到上限、消耗付得起、冷却好了，就在玩家身边可走的地方召唤一只。正常扣消耗、进冷却。
  // 玩家身上不播动作、不碰 P.cast 和输入缓冲：施法、连招、翻滚照常进行，只在落点出召唤特效，从玩家身上飘出一缕魂火。
  // 处决途中、死亡时不补；面板打开时整个模拟暂停，自然也不补。换区域 / 重生时召唤物原样回到身边，数量没变，不会重复召唤
  const AUTO_GAP = (G.AUTO_SUMMON_GAP = 0.5); // 两次自动召唤之间至少隔这么久
  const AUTO_ENTER = 0.8; // 进入区域 / 重生后先等这么久再开始补（召唤物正在入口处重新现身）
  const AUTO_BLOOD_KEEP = 0.4; // 以血为引时：付完消耗生命仍不低于这个比例才自动召唤（不替玩家把血抽干）
  let autoT = 0;
  G.autoSummonOn = (id) => !!(G.save && G.save.autoSummon && G.save.autoSummon[id]);
  // 切换（on 缺省时取反）；quiet：不在玩家头顶飘字（技能页里点的）。返回切换后的状态
  G.toggleAutoSummon = function (id, on, quiet) {
    const sk = G.SKILLS[id];
    if (!sk || sk.kind !== 'summon' || !G.save.skills[id]) return false;
    if (!G.save.autoSummon) G.save.autoSummon = autoSummonDefaults();
    const v = on === undefined ? !G.autoSummonOn(id) : !!on;
    G.save.autoSummon[id] = v;
    G.persist();
    if (!quiet && G.world && P.ent) G.world.text(P.x, P.z, '自动召唤：' + (v ? '开' : '关'), v ? '#4fe3c8' : '#c9c2b4', 15);
    G.sfx('click');
    return v;
  };
  function autoSummonReady(id) {
    if (!G.autoSummonOn(id) || !G.save.skills[id] || P.cds[id] > 0) return null;
    const ctx = G.skillCtx(id);
    if (!ctx.minion || G.minionCount(id) >= ctx.minion.cap) return null;
    if (P.uMech === 'soul' && G.SOULFIRE.free) ctx.cost = 0; // 万魂旗：自动召唤不消耗魔力
    if (!G.canAfford(ctx.cost)) return null;
    if (P.S.bloodMagic && ctx.cost > 0 && P.life - ctx.cost < P.maxLife * AUTO_BLOOD_KEEP) return null;
    return ctx;
  }
  function updateAutoSummon(dt) {
    if (autoT > 0) autoT -= dt;
    if (autoT > 0 || P.dead || P.exec || !state.zone || !G.summonMinion || !G.minionCount) return;
    const bar = G.save.bar;
    for (let i = 0; i < bar.length; i++) {
      const id = bar[i];
      if (!id || !G.SKILLS[id] || G.SKILLS[id].kind !== 'summon') continue;
      const ctx = autoSummonReady(id);
      if (!ctx) continue;
      // 落点：玩家身后两侧（不挡在身前的视线和准星上），由 minions.js 落到可走的地面
      const r = ctx.minion.kind === 'colossus' ? 2.6 : 1.9;
      const a = P.face + Math.PI + (Math.random() < 0.5 ? -1 : 1) * G.rand(0.5, 1.3);
      const m = G.summonMinion(id, P.x + Math.sin(a) * r, P.z + Math.cos(a) * r, ctx);
      if (!m) continue;
      payCost(ctx.cost);
      if (ctx.cd > 0) {
        P.cds[id] = ctx.cd;
        P.cdMax[id] = ctx.cd;
      }
      m.auto = true;
      G.world.burst(P.x, 1.1, P.z, G.ALLY_HEX || 0x4fe3c8, 6, 1.4, 0.35);
      state.stats.autoSummons = (state.stats.autoSummons || 0) + 1;
      autoT = AUTO_GAP;
      return;
    }
  }
  // 进入区域 / 重生：等召唤物在身边重新现身之后再开始补
  G.autoSummonDelay = function (t) {
    autoT = Math.max(autoT, t === undefined ? AUTO_ENTER : t);
  };

  // =====================================================================
  // 武器技（R）
  // =====================================================================
  // 施放分几段（sk.wt.phases，第一段扣消耗、进冷却），每一段到点时调用 WS_FX[kind](ctx, c, 段号)。
  // 翻滚在第一段之前取消不扣消耗、不进冷却；之后取消会丢掉还没到点的段（已经排进计时器的延时伤害——
  // 瞬断的斩开、秘弹、震地的冲击波——照常结算）。远程武器的 R 不进冷却，第一段生效时清空量表（翻滚在那之前取消不清空）。
  // 动作优先播 world 的 'w_<武器类型>'（k0 对在第一段），没有时退回现有动作 WS_FALLBACK（逐段播）。
  // 特效先找 world 里可选的专用函数（见各技能里的 fxOpt 调用），没有就用现有的通用特效顶上
  const WS_FALLBACK = {
    wblade: ['attack1', 'attack2'], wstaff: ['cast'], wwand: ['cast'], wdaggers: ['blink', 'flicker'],
    whammer: ['attack3'], wkatana: ['blink'], wbanner: ['cast'],
    ukatana: ['flicker'], ustaff: ['cast'], ubanner: ['cast'],
    rgatling: ['cast'], rflamer: ['cast'], rrevolver: ['throw'], rbuff: ['cast'],
  };
  function fxOpt(name) {
    const W = G.world;
    if (typeof W[name] !== 'function') return false;
    W[name].apply(W, Array.prototype.slice.call(arguments, 1));
    return true;
  }
  // 地面视线：两点之间没有墙（比 pathClear 宽松，用于判定伤害能不能打过去；虚空 / 深水 / 熔岩不挡）
  function losClear(x0, z0, x1, z1) {
    const W = G.world;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const n = Math.ceil(Math.hypot(dx, dz) / 0.35);
    for (let i = 1; i < n; i++) {
      if (!W.shotFree(x0 + (dx * i) / n, z0 + (dz * i) / n, -0.3)) return false;
    }
    return true;
  }
  // 从 (x0, z0) 朝 ang 最远 len、在撞墙之前能走多远（pad：要求的离墙距离）
  function rayLen(x0, z0, ang, len, pad) {
    const W = G.world;
    const sn = Math.sin(ang);
    const cs = Math.cos(ang);
    const step = 0.25;
    let d = 0;
    while (d + step <= len + 1e-6) {
      if (!W.walkable(x0 + sn * (d + step), z0 + cs * (d + step), pad)) return d;
      d += step;
    }
    if (d < len && W.walkable(x0 + sn * len, z0 + cs * len, pad)) d = len;
    return d;
  }
  // 线段 (x0, z0) → 朝 ang 长 len、半宽 half 的矩形里（算上敌人半径）的敌人
  function enemiesInLine(x0, z0, ang, len, half) {
    const sn = Math.sin(ang);
    const cs = Math.cos(ang);
    const out = [];
    for (const e of state.enemies) {
      if (e.dead) continue;
      const dx = e.x - x0;
      const dz = e.z - z0;
      const along = dx * sn + dz * cs;
      if (along < -e.r || along > len + e.r) continue;
      if (Math.abs(dx * cs - dz * sn) > half + e.r) continue;
      out.push(e);
    }
    return out;
  }
  // 一次武器技的命中：逐个结算，再统一给顿帧 / 镜头 / 声音。o：{ ang（数值或 e => 数值）, w, kb, poise, stop, ctx（替换用的上下文）, dir 镜头顶的方向 }
  function wsStrike(ctx, hits, mult, o) {
    if (!hits.length) return 0;
    const W = G.world;
    const use = o.ctx || ctx;
    let crit = false;
    let top = 'phys';
    for (const e of hits) {
      if (e.dead) continue;
      const ang = typeof o.ang === 'function' ? o.ang(e) : o.ang !== undefined ? o.ang : Math.atan2(e.x - P.x, e.z - P.z);
      G.hitEnemy(e, use, mult, { ang, w: o.w, kb: o.kb, poise: o.poise, quiet: true });
      crit = crit || lastHit.crit;
      top = lastHit.type;
      if (!e.dead && o.w >= 1) W.shudder(e.ent, 0.05 + o.w * 0.03, ((o.stop || 0) + 50) / 1000);
      if (o.knockUp && !e.dead && !e.isBoss) fxOpt('knockUp', e.ent, o.knockUp);
    }
    const stop = ((o.stop || 0) + (crit ? 25 : 0)) * ctx.stopK;
    if (stop > 0) {
      G.hitStop(stop);
      W.shudder(P.ent, 0.022, stop / 1000);
    }
    W.punch(o.dir !== undefined ? o.dir : P.face, 0.14 + (o.w || 0) * 0.14 + (crit ? 0.1 : 0));
    W.shake(o.w >= 2 ? 0.38 : crit ? 0.2 : 0.1);
    G.sfx('impact', { type: top, w: o.w || 0, crit });
    if (o.w >= 2) W.fovKick(2);
    return hits.length;
  }

  // 影刺：准星附近（离准星最近的优先）、离你 range 以内的敌人，落点在它身后（从你这边看过去的另一侧），可走且直线过去不穿墙
  const SHADOW_TRY = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6];
  function shadowSpot(e, out) {
    const W = G.world;
    const ab = Math.atan2(e.x - P.x, e.z - P.z);
    const gap = e.r + 0.9;
    for (const da of SHADOW_TRY) {
      const a = ab + da;
      const x = e.x + Math.sin(a) * gap;
      const z = e.z + Math.cos(a) * gap;
      if (!W.walkable(x, z, PLAYER_PAD) || !pathClear(P.x, P.z, x, z)) continue;
      out.e = e;
      out.x = x;
      out.z = z;
      return true;
    }
    return false;
  }
  function shadowPick(sk, out) {
    const m = G.input.mouse;
    const cand = [];
    for (const e of state.enemies) {
      if (e.dead || e.executed) continue;
      if (dist(e.x, e.z, P.x, P.z) - e.r > sk.range) continue;
      cand.push({ e, d: dist(e.x, e.z, m.wx, m.wz) });
    }
    cand.sort((a, b) => a.d - b.d);
    for (const it of cand) if (shadowSpot(it.e, out)) return true;
    return false;
  }

  function startWeaponSkill(slot, ctx, ang) {
    const W = G.world;
    const sk = ctx.sk;
    const sp = ctx.speed;
    const wt = sk.wt;
    const c = {
      slot, id: ctx.id, t: 0, fired: false, aim: ang, step: -1, st: null, ws: true, phase: 0,
      phases: wt.phases.map((t) => t / sp), cancelT: wt.cancel / sp, dur: wt.dur / sp,
      move: sk.move || 0, fb: false, data: {}, ctx: null, tick: null,
    };
    c.fireT = c.phases[0];
    if (sk.kind === 'wdaggers') {
      if (!shadowPick(sk, c.data)) {
        flickerNoTarget();
        return false;
      }
      c.aim = Math.atan2(c.data.e.x - P.x, c.data.e.z - P.z);
    }
    if (sk.kind === 'ukatana') {
      // 千刃归烬：附近没有闪得过去的敌人就不起手（不扣魔力、不进冷却）
      if (!cutPick(sk, null, _cs)) {
        flickerNoTarget();
        return false;
      }
      c.aim = Math.atan2(_cs.e.x - P.x, _cs.e.z - P.z);
    }
    G.input.tap[slot] = 0;
    comboReset();
    P.cast = c;
    P.face = c.aim;
    // 动作的「命中帧」对到 wt.clip.at（缺省第一段），时长 wt.clip.dur（缺省收招 + 0.1）：让刺、扫、砸、放箭的姿势和伤害同一刻
    const cl = wt.clip || {};
    const clipDur = (cl.dur || wt.dur + 0.1) / sp;
    const clipAt = cl.at !== undefined ? cl.at / sp : c.fireT;
    // 烬铸技有自己的动作（sk.wclip；null = 起手不另播，由技能自己按段播）
    const clipName = sk.wclip !== undefined ? sk.wclip : 'w_' + sk.wtype;
    if (clipName && !W.play(P.ent, clipName, { dur: clipDur, contact: clipAt })) {
      c.fb = true;
      W.play(P.ent, WS_FALLBACK[sk.kind][0], { dur: Math.max(c.fireT * 2.2, 0.3), contact: c.fireT });
    }
    if (sk.tags.indexOf('melee') >= 0) W.setTrail(hexOf(sk.color));
    return true;
  }

  function updateWeaponCast(c, dt) {
    c.t += dt;
    const sk = G.SKILLS[c.id];
    if (!c.fired) {
      if (sk.kind === 'wdaggers') {
        const e = c.data.e;
        if (e && !e.dead) c.aim = Math.atan2(e.x - P.x, e.z - P.z);
      } else {
        c.aim = aimInfo().ang; // 出手前一直跟随鼠标
      }
      if (c.t >= c.phases[0]) {
        const ctx = G.skillCtx(c.id);
        if (!G.canAfford(ctx.cost)) {
          P.cast = null;
          return;
        }
        payCost(ctx.cost);
        if (ctx.cd > 0) {
          P.cds[c.id] = ctx.cd;
          P.cdMax[c.id] = ctx.cd;
        }
        c.fired = true;
        c.ctx = ctx;
        state.stats.wskills = (state.stats.wskills || 0) + 1;
        if (sk.rgauge) {
          // 远程武器的 R：量表清零
          const rw = G.rangedWeapon();
          if (rw) P.gauge[rw.gauge.kind] = 0;
          state.stats.rUses = (state.stats.rUses || 0) + 1;
        }
        WS_FX[sk.kind](ctx, c, 0);
        c.phase = 1;
      }
    }
    while (P.cast === c && c.fired && c.phase < c.phases.length && c.t >= c.phases[c.phase]) {
      const ph = c.phase++;
      if (c.fb && WS_FALLBACK[sk.kind][ph]) G.world.play(P.ent, WS_FALLBACK[sk.kind][ph], { dur: 0.3, contact: 0.04 });
      WS_FX[sk.kind](c.ctx, c, ph);
    }
    if (P.cast === c && c.tick) c.tick(c, dt);
    if (P.cast === c) {
      P.face = c.aim;
      if (c.t >= c.dur) P.cast = null;
    }
  }

  const WS_FX = {
    // 回锋斩：0 突刺（贯穿一条直线，撞墙截断）；1 回身横扫一整圈
    wblade(ctx, c, ph) {
      const W = G.world;
      const sk = ctx.sk;
      const k = Math.sqrt(ctx.area);
      const hex = hexOf(sk.color);
      if (ph === 0) {
        const st = sk.thrust;
        const a = c.aim;
        const sn = Math.sin(a);
        const cs = Math.cos(a);
        // 先朝准星踏一步：贴到敌人身前或撞墙就停
        let d = st.lunge;
        for (const e of state.enemies) {
          if (e.dead) continue;
          const dx = e.x - P.x;
          const dz = e.z - P.z;
          const along = dx * sn + dz * cs;
          if (along <= 0 || along > st.lunge + e.r + 1.2 || Math.abs(dx * cs - dz * sn) > e.r + 0.5) continue;
          d = Math.min(d, Math.max(0, along - (e.r + 0.95)));
        }
        if (d > 0) movePlayer(sn * d, cs * d);
        const len = rayLen(P.x, P.z, a, st.len * k, -0.2);
        const hits = enemiesInLine(P.x, P.z, a, len, (st.width / 2) * k);
        if (!fxOpt('thrustFx', P.x, P.z, a, len, hex)) {
          W.slash(P.x, P.z, a, Math.max(1.5, len), 14, hex, { dur: 0.16, inner: 0.1, y: 1.1 });
          W.decal(0, P.x + sn * len * 0.5, P.z + cs * len * 0.5, len * 0.5, a, hex, 0.3, 0.2);
        }
        G.sfx('swing', { step: 0 });
        wsStrike(ctx, hits, st.mult, { ang: a, w: st.w, kb: st.kb, poise: st.poise, stop: st.stop, dir: a });
      } else {
        const st = sk.sweep;
        const R = st.range * k;
        const hits = enemiesIn(P.x, P.z, R);
        if (!fxOpt('sweepFx', P.x, P.z, R, hex)) {
          W.slash(P.x, P.z, c.aim + Math.PI, R, 360, hex, { dir: -1, dur: 0.22, inner: 0.35, y: 1.0 });
          W.burst(P.x, 0.3, P.z, 0xcbbba6, 8, R, 0.35);
        }
        G.sfx('swing', { step: 1 });
        // 击退：从你往外，再顺着回身的方向带一点
        wsStrike(ctx, hits, st.mult, { ang: (e) => Math.atan2(e.x - P.x, e.z - P.z) - 0.4, w: st.w, kb: st.kb, poise: st.poise, stop: st.stop });
      }
    },

    // 地脉涌：身边一圈，元素取加成最高的那种；墙后的敌人不受波及
    wstaff(ctx) {
      const W = G.world;
      const sk = ctx.sk;
      const R = sk.radius * Math.sqrt(ctx.area);
      const t = mainType(ctx);
      const hex = G.TYPE_HEX[t];
      const hits = enemiesIn(P.x, P.z, R).filter((e) => losClear(P.x, P.z, e.x, e.z));
      if (!fxOpt('groundBurst', P.x, P.z, R, hex, t)) {
        W.ring(P.x, P.z, R, hex, 0.45);
        W.ring(P.x, P.z, R * 0.6, 0xffffff, 0.25);
        W.decal(t === 'fire' ? 1 : t === 'cold' ? 2 : 3, P.x, P.z, R * 0.85, Math.random() * TAU, hex, 3);
        W.burst(P.x, 0.4, P.z, hex, 40, R * 1.6, 0.6);
      }
      G.sfx('cast');
      wsStrike(ctx, hits, 1, { ang: (e) => Math.atan2(e.x - P.x, e.z - P.z), w: sk.w, kb: sk.kb, poise: sk.poise, stop: 60 });
    },

    // 秘弹连射：n 枚追踪秘弹，每隔 gap 秒一枚，分给准星附近（seek 以内、离你 range 以内、看得见）的敌人
    wwand(ctx, c) {
      const sk = ctx.sk;
      const m = G.input.mouse;
      const tg = state.enemies
        .filter((e) => !e.dead && dist(e.x, e.z, m.wx, m.wz) - e.r <= sk.seek && dist(e.x, e.z, P.x, P.z) - e.r <= sk.range && losClear(P.x, P.z, e.x, e.z))
        .sort((a, b) => dist(a.x, a.z, m.wx, m.wz) - dist(b.x, b.z, m.wx, m.wz));
      const aim0 = c.aim;
      const t = mainType(ctx);
      const fire = (i) => {
        if (P.dead) return;
        let e = tg.length ? tg[i % tg.length] : null;
        if (e && e.dead) e = tg.find((o) => !o.dead) || null;
        const base = e ? Math.atan2(e.x - P.x, e.z - P.z) : aim0;
        const ang = base + (i % 2 ? 1 : -1) * (0.35 + 0.08 * i); // 左右交替甩出去，再拐向目标
        const dx = Math.sin(ang);
        const dz = Math.cos(ang);
        G.spawnProjectile({
          owner: 'p', x: P.x + dx * 0.6, z: P.z + dz * 0.6, dx, dz,
          speed: sk.speed, r: sk.projR, life: (sk.range + 4) / sk.speed, color: G.TYPE_HEX[t],
          ctx, pierce: 0, chain: 0, explode: sk.explode || 0, hit: new Set(), home: e, turn: sk.turn, seeker: true, vk: 'dart',
        });
        fxOpt('seekerFx', P.x + dx * 0.6, 1.1, P.z + dz * 0.6, G.TYPE_HEX[t]);
        G.sfx('cast');
      };
      fire(0);
      for (let i = 1; i < sk.n; i++) G.after(sk.gap * i, () => fire(i));
    },

    // 影刺：0 闪到目标身后（无敌）；1 刺出必定暴击的一击，波及目标身边
    wdaggers(ctx, c, ph) {
      const W = G.world;
      const sk = ctx.sk;
      const hex = hexOf(sk.color);
      const e = c.data.e;
      if (ph === 0) {
        if (e && !e.dead) shadowSpot(e, c.data); // 目标挪了位置：按它现在的位置重找身后的落点
        const ox = P.x;
        const oz = P.z;
        if (W.walkable(c.data.x, c.data.z, PLAYER_PAD * 0.8)) {
          P.x = c.data.x;
          P.z = c.data.z;
        }
        P.iframe = Math.max(P.iframe, sk.iframe);
        if (!fxOpt('shadowStep', ox, oz, P.x, P.z, hex)) {
          W.burst(ox, 1.0, oz, 0x1c2238, 12, 2.4, 0.35);
          W.dashFx(ox, oz, P.x, P.z, hex);
          W.burst(P.x, 1.0, P.z, hex, 10, 2.6, 0.25);
        }
        if (e && !e.dead) c.aim = Math.atan2(e.x - P.x, e.z - P.z);
        G.sfx('roll');
        return;
      }
      const R = sk.radius * Math.sqrt(ctx.area);
      let cx = P.x + Math.sin(c.aim) * 1.3;
      let cz = P.z + Math.cos(c.aim) * 1.3;
      if (e && !e.dead && dist(e.x, e.z, P.x, P.z) - e.r <= 2.6) {
        cx = e.x;
        cz = e.z;
        c.aim = Math.atan2(e.x - P.x, e.z - P.z);
      }
      const hits = enemiesIn(cx, cz, R);
      if (e && !e.dead && hits.indexOf(e) < 0 && dist(e.x, e.z, P.x, P.z) - e.r <= 2.6) hits.push(e);
      const reachS = dist(cx, cz, P.x, P.z) + R * 0.6;
      W.slash(P.x, P.z, c.aim, reachS, 24, hex, { dur: 0.14, inner: 0.15, y: 1.1 });
      fxOpt('thrustFx', P.x, P.z, c.aim, reachS, hex); // 匕首直刺的一道锋芒
      G.sfx('swing', { step: 1 });
      const sure = Object.assign({}, ctx, { crit: 100 });
      wsStrike(ctx, hits, 1, { ctx: sure, w: sk.w, kb: sk.kb, poise: sk.poise, stop: sk.stop, dir: c.aim });
    },

    // 震地：身前砸地 + 朝准星推进的冲击波（越远越宽，遇墙即止）。冲击波按距离稍晚一点到达
    whammer(ctx, c) {
      const W = G.world;
      const sk = ctx.sk;
      const k = Math.sqrt(ctx.area);
      const a = c.aim;
      const sn = Math.sin(a);
      const cs = Math.cos(a);
      const hex = hexOf(sk.color);
      const len = Math.max(sk.reach, rayLen(P.x, P.z, a, sk.len * k, -0.2));
      const ix = P.x + sn * sk.reach;
      const iz = P.z + cs * sk.reach;
      const R = sk.slamR * k;
      const x0 = P.x;
      const z0 = P.z;
      const now = [];
      const later = [];
      for (const e of state.enemies) {
        if (e.dead) continue;
        const dx = e.x - x0;
        const dz = e.z - z0;
        const along = dx * sn + dz * cs;
        const perp = Math.abs(dx * cs - dz * sn);
        const half = ((sk.w0 + (sk.w1 - sk.w0) * G.clamp(along / len, 0, 1)) / 2) * k;
        const inSlam = dist(e.x, e.z, ix, iz) - e.r <= R;
        const inWave = along >= 0 && along <= len + e.r && perp <= half + e.r;
        if (!inSlam && !inWave) continue;
        if (!losClear(x0, z0, e.x, e.z)) continue;
        const delay = inSlam ? 0 : Math.max(0, along - sk.reach) / sk.wave;
        if (delay < 0.03) now.push(e);
        else later.push({ e, delay });
      }
      // 冲击波从落锤点推出去：world 的波前在 72% 时长处走到尽头，换算成和伤害同样的推进速度
      const wl = Math.max(0.5, len - sk.reach);
      if (!fxOpt('shockwave', ix, iz, a, wl, sk.w0 * k, sk.w1 * k, hex, wl / sk.wave / 0.72)) {
        W.ring(ix, iz, R, hex, 0.35);
        W.decal(5, ix, iz, R * 0.95, Math.random() * TAU, 0xffc890, 2.6);
        W.burst(ix, 0.3, iz, 0xcbbba6, 18, 6.5, 0.45);
        for (let d = sk.reach + 1.5; d <= len; d += 1.5) {
          const px = x0 + sn * d;
          const pz = z0 + cs * d;
          const half = ((sk.w0 + (sk.w1 - sk.w0) * (d / len)) / 2) * k;
          G.after((d - sk.reach) / sk.wave, () => {
            W.burst(px, 0.3, pz, 0xcbbba6, 6, 2 + half, 0.4);
            W.decal(5, px, pz, half * 0.8, Math.random() * TAU, 0xffc890, 1.6);
          });
        }
      }
      W.shake(0.45);
      W.fovKick(2.4);
      G.sfx('finisher');
      const o = { ang: a, w: sk.w, kb: sk.kb, poise: sk.poise, stop: sk.stop, dir: a, knockUp: 0.8 };
      if (now.length) wsStrike(ctx, now, 1, o);
      for (const it of later) {
        G.after(it.delay, () => {
          if (!it.e.dead) wsStrike(ctx, [it.e], 1, Object.assign({}, o, { stop: 0 }));
        });
      }
    },

    // 瞬断：疾冲到准星方向（最远 range，遇墙即停，途中无敌）；delay 秒后沿途经过的敌人同时被斩开
    wkatana(ctx, c) {
      const W = G.world;
      const sk = ctx.sk;
      const a = c.aim;
      const sn = Math.sin(a);
      const cs = Math.cos(a);
      const hex = hexOf(sk.color);
      const x0 = P.x;
      const z0 = P.z;
      // 一步步往前探：每一步都要站得住（离墙 PLAYER_PAD），一碰墙就停在墙前
      let d = 0;
      while (d + 0.25 <= sk.range && W.walkable(x0 + sn * (d + 0.25), z0 + cs * (d + 0.25), PLAYER_PAD)) d += 0.25;
      const x1 = x0 + sn * d;
      const z1 = z0 + cs * d;
      const dashT = sk.dash / ctx.speed;
      // 每个敌人在冲刺线上的位置（离起点多远）记下来：冲刺被翻滚打断时，只有真正冲过去的那一段上的敌人会被斩开
      const passed = enemiesInLine(x0, z0, a, d, sk.width * Math.sqrt(ctx.area))
        .filter((e) => losClear(x0, z0, e.x, e.z))
        .map((e) => ({ e, at: (e.x - x0) * sn + (e.z - z0) * cs - (e.r || 0) }));
      P.iframe = Math.max(P.iframe, dashT + 0.12);
      P.roll.t = 0;
      const data = (c.data = { x0, z0, x1, z1, t0: c.t, dashT, f: 0 });
      c.tick = (cc) => {
        const f = G.clamp((cc.t - cc.data.t0) / cc.data.dashT, 0, 1);
        cc.data.f = f; // 实际冲到了哪里：施放被取消后 tick 不再走，f 停在那一刻
        P.x = cc.data.x0 + (cc.data.x1 - cc.data.x0) * f;
        P.z = cc.data.z0 + (cc.data.z1 - cc.data.z0) * f;
        if (f >= 1) cc.tick = null;
      };
      // 冲出去多远：施放还在继续就是整段（计时器和 tick 谁先走不一定），被翻滚取消了就停在取消那一刻
      const reachD = () => (P.cast === c ? d : d * data.f);
      const reached = () => passed.filter((p) => !p.e.dead && p.at <= reachD() + 0.05).map((p) => p.e);
      G.sfx('roll');
      // 冲到头：沿路留下残影和光带，每个被穿过的敌人身上先浮出一道暗线，到斩开那一刻骤亮
      G.after(dashT, () => {
        const dd = reachD();
        const xe = x0 + sn * dd;
        const ze = z0 + cs * dd;
        if (dd > 0.05 && !fxOpt('dashCut', P.ent, x0, z0, xe, ze, hex)) {
          W.dashFx(x0, z0, xe, ze, hex);
          if (dd > 0.3) W.decal(0, (x0 + xe) / 2, (z0 + ze) / 2, dd / 2, a, hex, 0.6, 0.25);
        }
        if (W.cutLine) for (const e of reached()) W.cutLine(e.x, e.z, a + Math.PI / 2 + (Math.random() - 0.5) * 0.7, 1.8 + e.r * 2, hex, sk.delay);
      });
      G.after(dashT + sk.delay, () => {
        if (P.dead) return;
        const alive = reached();
        if (!W.cutLine) for (const e of alive) W.slash(e.x, e.z, a + Math.PI / 2, 1.6 + e.r, 30, hex, { dur: 0.18, inner: 0.5, y: 1.1 });
        if (!alive.length) return;
        wsStrike(ctx, alive, 1, { ang: a, w: sk.w, kb: sk.kb, poise: sk.poise, stop: sk.stop, dir: a });
        G.sfx('finisher');
      });
    },
  };

  // 魂潮：n 只魂火（伤害按召唤物算），每隔 gap 秒一只，轮流扑向准星附近（seek 以内、离你 range 以内、看得见）的敌人，
  // 碰到即炸开；没有目标就朝准星飞，life 秒后散掉。同时所有召唤物狂热 frenzy.dur 秒
  WS_FX.wbanner = function (ctx, c) {
    const sk = ctx.sk;
    const m = G.input.mouse;
    const hex = hexOf(sk.color);
    const tg = state.enemies
      .filter((e) => !e.dead && dist(e.x, e.z, m.wx, m.wz) - e.r <= sk.seek && dist(e.x, e.z, P.x, P.z) - e.r <= sk.range && losClear(P.x, P.z, e.x, e.z))
      .sort((a, b) => dist(a.x, a.z, m.wx, m.wz) - dist(b.x, b.z, m.wx, m.wz));
    const aim0 = c.aim;
    fxOpt('soulTide', P.x, P.z, aim0, hex);
    const fire = (i) => {
      if (P.dead) return;
      let e = tg.length ? tg[i % tg.length] : null;
      if (e && e.dead) e = tg.find((o) => !o.dead) || null;
      const base = e ? Math.atan2(e.x - P.x, e.z - P.z) : aim0;
      const ang = base + (i - (sk.n - 1) / 2) * 0.45; // 从幡上扇形散出，再各自拐向目标
      const dx = Math.sin(ang);
      const dz = Math.cos(ang);
      G.spawnProjectile({
        owner: 'p', x: P.x + dx * 0.7, z: P.z + dz * 0.7, dx, dz,
        speed: sk.speed, r: sk.projR, life: sk.life, color: hex,
        ctx, pierce: 0, chain: 0, explode: sk.explode, hit: new Set(), home: e, turn: sk.turn, wisp: true, fizzle: true,
      });
    };
    fire(0);
    for (let i = 1; i < sk.n; i++) G.after(sk.gap * i, () => fire(i));
    const fz = sk.frenzy;
    const n = G.minionFrenzy ? G.minionFrenzy(fz.dur, fz.k) : 0;
    if (n) G.world.text(P.x, P.z, '狂热', '#4fe3c8', 16);
    G.sfx('cast');
  };

  // =====================================================================
  // 烬铸技（拿着烬铸武器时 R 上的那一招，见 data.js 的 ashcuts / tristorm / soulhost）
  // =====================================================================
  // ---------- 千刃归烬：连闪 → 收刀 → 斩痕齐爆 ----------
  // 落点：穿过目标、落在它身后（从你这边看过去的另一侧）；身后站不住就在它身边找（flickerSpot）
  const CUT_TRY = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4];
  function cutSpot(e, out) {
    const W = G.world;
    const ab = Math.atan2(e.x - P.x, e.z - P.z);
    const gap = e.r + 1.1;
    for (const da of CUT_TRY) {
      const a = ab + da;
      const x = e.x + Math.sin(a) * gap;
      const z = e.z + Math.cos(a) * gap;
      if (!W.walkable(x, z, PLAYER_PAD) || !pathClear(P.x, P.z, x, z)) continue;
      out.e = e;
      out.x = x;
      out.z = z;
      return true;
    }
    return flickerSpot(e, ab + Math.PI, out);
  }
  // 下一闪的目标：range 以内（量到敌人边缘）。第一闪取准星 5 格以内离准星最近的，没有就取最近的；
  // 之后优先没斩过的、斩得少的、近的；刚斩过的那个只在没有别的可选时再斩（只剩一个目标时来回穿它）
  const _cs = { e: null, x: 0, z: 0, a: 0 };
  function cutPick(sk, run, out) {
    const m = G.input.mouse;
    const cand = [];
    for (const e of state.enemies) {
      if (e.dead || e.executed) continue;
      const dp = dist(e.x, e.z, P.x, P.z);
      if (dp - e.r > sk.range) continue;
      let s;
      if (!run || !run.last) {
        const dm = dist(e.x, e.z, m.wx, m.wz);
        s = dm - e.r <= 5 ? -dm : -1000 - dp;
      } else {
        const n = run.cuts.has(e) ? run.cuts.get(e) : 0;
        s = -n * 4 - dp * 0.15 - (e === run.last ? 100 : 0);
      }
      cand.push({ e, s });
    }
    cand.sort((a, b) => b.s - a.s);
    for (const it of cand) if (cutSpot(it.e, out)) return true;
    return false;
  }
  function addCut(run, e, k) {
    run.cuts.set(e, (run.cuts.get(e) || 0) + k);
  }
  // 一闪：从此刻的位置闪到 _cs 的落点（途中无敌），沿路的敌人各挨一刀、各留一道斩痕；闪到之后停 gap 秒再闪下一次
  function cutHop(c, run) {
    if (run.done) return;
    const sk = run.sk, ctx = run.ctx, W = G.world;
    if (P.cast !== c || P.dead) {
      // 被翻滚取消 / 倒下：已经留下的斩痕照样炸开
      cutFinish(c, run, 0.12, false);
      return;
    }
    if (run.hops >= sk.hops || !cutPick(sk, run, _cs)) {
      cutFinish(c, run, sk.delay, true);
      return;
    }
    const e = _cs.e;
    const x0 = P.x, z0 = P.z, x1 = _cs.x, z1 = _cs.z;
    const a = Math.atan2(x1 - x0, z1 - z0);
    const d = dist(x0, z0, x1, z1);
    const dashT = sk.dash / ctx.speed;
    const gapT = sk.gap / ctx.speed;
    run.hops++;
    run.last = e;
    state.stats.ashHops = (state.stats.ashHops || 0) + 1;
    // 沿路、以及目标身边 splash 米内的敌人：各挨一刀
    const hits = enemiesInLine(x0, z0, a, d, sk.width * Math.sqrt(ctx.area)).filter((o) => losClear(x0, z0, o.x, o.z));
    for (const o of enemiesIn(e.x, e.z, sk.splash * Math.sqrt(ctx.area))) if (hits.indexOf(o) < 0 && losClear(x1, z1, o.x, o.z)) hits.push(o);
    if (hits.indexOf(e) < 0) hits.push(e);
    P.iframe = Math.max(P.iframe, dashT + gapT + 0.06);
    P.roll.t = 0;
    c.data.mv = { x0, z0, x1, z1, t0: c.t, dt: dashT };
    c.aim = a;
    P.face = a;
    const hex = hexOf(sk.color);
    W.play(P.ent, run.hops % 2 ? 'flicker' : 'flicker2', { dur: dashT + gapT + 0.12, contact: dashT });
    W.setTrail(hex);
    G.sfx('roll');
    G.after(dashT, () => {
      if (run.done) return;
      if (!fxOpt('ashDash', P.ent, x0, z0, P.x, P.z, hex)) W.dashFx(x0, z0, P.x, P.z, hex);
      const live = hits.filter((o) => !o.dead);
      // 斩痕：这一闪的目标留一整道，沿路 / 身边挨了刀的留半道（sk.side）——怪群里多炸一些，单挑首领不变
      for (const o of live) {
        addCut(run, o, o === e ? 1 : sk.side);
        fxOpt('ashMark', o.ent, a + Math.PI / 2 + G.rand(-0.6, 0.6), run.cuts.get(o), o.height || 2);
      }
      G.sfx('swing', { step: run.hops % 2 });
      if (live.length) wsStrike(ctx, live, sk.pass, { ang: a, w: 0, kb: sk.kb, poise: sk.poise, stop: sk.stop, dir: a });
      G.after(gapT, () => cutHop(c, run));
    });
  }
  // 收刀：delay 秒后所有斩痕一齐炸开。sheath：正常打完（播收刀动作；被取消时不播）
  function cutFinish(c, run, delay, sheath) {
    if (run.done) return;
    run.done = true;
    const sk = run.sk, W = G.world;
    if (P.cast === c) {
      c.data.mv = null;
      c.tick = null;
      if (sheath) {
        W.play(P.ent, 'u_katana', { dur: delay + 0.42, contact: delay });
        c.cancelT = c.t + delay; // 炸开之后就能接别的动作
        c.dur = c.t + delay + 0.42;
      }
    }
    fxOpt('ashSheathe', P.x, P.z, delay);
    G.after(delay, () => cutBurst(run));
  }
  function cutBurst(run) {
    const sk = run.sk, ctx = run.ctx, W = G.world;
    const list = [];
    run.cuts.forEach((n, e) => {
      if (!e.dead) list.push({ e, n });
    });
    fxOpt('ashClear');
    state.stats.ashBursts = (state.stats.ashBursts || 0) + 1;
    if (!list.length) return;
    let crit = false, marks = 0, total = 0;
    for (const it of list) {
      const e = it.e;
      // 残刃：每层再多 mark 倍，吃掉
      const mk = P.uMech === 'blade' ? e.marks || 0 : 0;
      if (mk > 0) {
        e.marks = 0;
        if (W.bladeMarks) W.bladeMarks(e.ent, 0);
        marks += mk;
      }
      fxOpt('ashBurst', e.x, e.z, e.height || 2, e.r, it.n, mk);
      total += G.hitEnemy(e, ctx, it.n * sk.cut + mk * sk.mark, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: 2, kb: sk.kb * 2, poise: sk.cutPoise, quiet: true }) || 0;
      crit = crit || lastHit.crit;
      if (!e.dead) W.shudder(e.ent, 0.14, 0.24);
    }
    state.stats.ashCuts = (state.stats.ashCuts || 0) + list.reduce((s, it) => s + it.n, 0);
    state.stats.ashMarks = (state.stats.ashMarks || 0) + marks;
    run.total = total;
    state.stats.ashDmg = (state.stats.ashDmg || 0) + total;
    G.hitStop(sk.cutStop * ctx.stopK + (crit ? 20 : 0));
    W.shudder(P.ent, 0.03, 0.16);
    W.punch(P.face + Math.PI, 0.5);
    W.shake(0.62);
    W.fovKick(4);
    G.slowMo(0.35, 0.22);
    G.sfx('impact', { type: 'phys', w: 2, crit });
    G.sfx('finisher');
    G.sfx('ashcuts');
  }
  WS_FX.ukatana = function (ctx, c) {
    const sk = ctx.sk;
    const run = (c.data.run = { sk, ctx, cuts: new Map(), hops: 0, last: null, done: false, total: 0 });
    // 连闪的位移：每帧把玩家从这一闪的起点插到落点
    c.tick = (cc) => {
      const mv = cc.data.mv;
      if (!mv) return;
      const f = G.clamp((cc.t - mv.t0) / mv.dt, 0, 1);
      P.x = mv.x0 + (mv.x1 - mv.x0) * f;
      P.z = mv.z0 + (mv.z1 - mv.z0) * f;
      if (f >= 1) cc.data.mv = null;
    };
    cutHop(c, run);
  };

  // ---------- 三相天灾：准星处的元素风暴 ----------
  // 风暴打出来的异常：stormDepth > 0 时，首领照常因触发变高阈值（三相之心的 TRI.grow 不管这里）
  let stormDepth = 0;
  const STORM_ELEMS = ['fire', 'cold', 'light'];
  // 某一种元素的一击：基础伤害整个换成这个元素（等级与地脉涌一样按武器物品等级），再加上你的附加伤害
  function stormCtx(ctx, t) {
    const sk = ctx.sk, S = P.S;
    const k = ctx.levelK;
    const base = {};
    base[t] = [sk.edmg[0] * k, sk.edmg[1] * k];
    for (const u of TYPES) {
      const v = S['add' + G.CAP[u]] || 0;
      if (v > 0) {
        if (!base[u]) base[u] = [0, 0];
        base[u][0] += v * 0.7;
        base[u][1] += v * 1.3;
      }
    }
    return Object.assign({}, ctx, { base });
  }
  WS_FX.ustaff = function (ctx, c) {
    const W = G.world;
    const sk = ctx.sk;
    const a = aimInfo();
    const d = rayLen(P.x, P.z, a.ang, Math.min(sk.range, a.dist), 0);
    const x = P.x + Math.sin(a.ang) * d;
    const z = P.z + Math.cos(a.ang) * d;
    const R = sk.radius * Math.sqrt(ctx.area);
    const ctxs = {};
    for (const t of STORM_ELEMS) ctxs[t] = stormCtx(ctx, t);
    const n = Math.round(sk.dur / sk.tick);
    const storm = { x, z, R, n, hits: 0, struck: new Map() };
    c.data.storm = storm;
    if (!fxOpt('triStorm', x, z, R, sk.delay + sk.dur + 0.3)) G.telegraph({ shape: 'circle', x, z, r: R, dur: sk.delay + sk.dur, dmg: 0, friendly: true });
    W.shake(0.25);
    G.sfx('cast');
    G.sfx('tristorm');
    state.stats.storms = (state.stats.storms || 0) + 1;
    const FALL = 0.24; // 从天上落到地面的时间（陨火 / 冰棱 / 落雷的特效在这之前出手）
    const strike = (i) => {
      if (P.dead) return;
      const t = STORM_ELEMS[i % 3];
      const hr = sk.hitR * Math.sqrt(ctx.area);
      // 落点：范围里（看得见风暴中心）的敌人里挑一个，被砸得少的优先；一个都没有就随便落在圈里
      const pool = enemiesIn(x, z, R).filter((e) => losClear(x, z, e.x, e.z));
      let px, pz;
      if (pool.length) {
        pool.sort((p, q) => (storm.struck.get(p) || 0) - (storm.struck.get(q) || 0) + (Math.random() - 0.5) * 1.2);
        const e = pool[0];
        storm.struck.set(e, (storm.struck.get(e) || 0) + 1);
        px = e.x + G.rand(-0.4, 0.4);
        pz = e.z + G.rand(-0.4, 0.4);
      } else {
        const rr = R * 0.85 * Math.sqrt(Math.random());
        const aa = Math.random() * TAU;
        px = x + Math.sin(aa) * rr;
        pz = z + Math.cos(aa) * rr;
      }
      fxOpt('triStrike', px, pz, t, hr, FALL);
      G.after(FALL, () => {
        if (P.dead) return;
        const hits = enemiesIn(px, pz, hr).filter((e) => losClear(px, pz, e.x, e.z));
        fxOpt('triStrikeLand', px, pz, t, hr);
        if (i % 2 === 0) G.sfx('impact', { type: t, w: 1, crit: false });
        if (!hits.length) return;
        stormDepth++;
        for (const e of hits) G.hitEnemy(e, ctxs[t], 1, { ang: Math.atan2(e.x - px, e.z - pz), w: sk.w, kb: sk.kb, poise: sk.poise, quiet: true });
        stormDepth--;
        storm.hits += hits.length;
        state.stats.stormHits = (state.stats.stormHits || 0) + hits.length;
        if (i % 3 === 0) W.shake(0.12);
      });
    };
    for (let i = 0; i < n; i++) G.after(sk.delay + i * sk.tick, () => strike(i));
  };

  // ---------- 万魂降临：英灵降临 + 治疗 / 狂热现有的召唤物 ----------
  WS_FX.ubanner = function (ctx, c) {
    const W = G.world;
    const sk = ctx.sk;
    const a = aimInfo();
    const d = rayLen(P.x, P.z, a.ang, Math.min(sk.range, Math.max(2.5, a.dist)), 0.6);
    const cx = P.x + Math.sin(a.ang) * d;
    const cz = P.z + Math.cos(a.ang) * d;
    // 先把现有的召唤物治疗到满、狂热（新来的英灵不算在内）
    let healed = 0;
    for (const m of state.minions) {
      if (m.dead || m.expire) continue;
      m.hp = m.maxHp;
      healed++;
      fxOpt('soulHeal', m.ent, m.x, m.z, m.height || 2);
    }
    const fz = sk.frenzy;
    if (G.minionFrenzy) G.minionFrenzy(fz.dur, fz.k);
    if (healed) W.text(P.x, P.z, '治疗 · 狂热', '#7ff0d8', 16);
    fxOpt('soulHost', cx, cz, sk.spread + 1.6, P.x, P.z);
    W.shake(0.35);
    W.fovKick(2.5);
    G.sfx('soulhost');
    state.stats.hosts = (state.stats.hosts || 0) + 1;
    // 英灵：一圈落在准星一带，依次落下
    if (!G.summonChampion) return;
    const n = sk.n;
    const a0 = Math.random() * TAU;
    for (let i = 0; i < n; i++) {
      const aa = a0 + (i / n) * TAU;
      const rr = sk.spread * (i % 2 ? 1 : 0.62);
      G.after(0.06 * i, () => {
        if (P.dead) return;
        const m = G.summonChampion(c.id, cx + Math.sin(aa) * rr, cz + Math.cos(aa) * rr, ctx, sk.dur);
        if (!m) return;
        // 落地一砸：slam 倍英灵一击，半径 slamR
        const R = sk.slamR;
        const hits = enemiesIn(m.x, m.z, R);
        fxOpt('champLand', m.x, m.z, R);
        for (const e of hits) G.hitEnemy(e, ctx, sk.slam, { ang: Math.atan2(e.x - m.x, e.z - m.z), w: 1, kb: 1.2, poise: 12, quiet: true, minion: m });
        if (hits.length) G.sfx('impact', { type: 'phys', w: 1, crit: false });
        state.stats.champions = (state.stats.champions || 0) + 1;
      });
    }
  };

  // =====================================================================
  // 远程武器的 R（量表技，见 data.js 的 meltray / firestorm / wildfire / volley / pierceheart / overflow / emberstorm）
  // =====================================================================
  // 熔光射线：按住 R 蓄力（瞄准线跟准星），松手（或蓄满后再按 hold 秒）放出一道贯穿射线，一次结算直线上的所有敌人。
  // 射线每帧交给 world.laser 画（可选，没有时画一道电弧顶上）
  WS_FX.rgatling = function (ctx, c) {
    const W = G.world;
    const sk = ctx.sk;
    const hex = hexOf(sk.color);
    c.dur = c.t + sk.charge + sk.hold + 0.2;
    c.cancelT = c.dur;
    c.data = { ang: c.aim, ch: 0, shot: false, beamT: 0, len: sk.len };
    G.sfx('cast');
    c.tick = (cc, dt) => {
      const d = cc.data;
      if (!d.shot) {
        d.ang = aimInfo().ang;
        cc.aim = d.ang;
        d.ch += dt;
        const k = Math.min(1, d.ch / sk.charge);
        const sn = Math.sin(d.ang), cs = Math.cos(d.ang);
        const len = Math.max(1, rayLen(P.x, P.z, d.ang, sk.len, -0.3));
        fxOpt('laser', P.x, P.z, sn, cs, len, { charge: k });
        if (k >= 1 && !d.full) {
          d.full = true;
          fxOpt('gaugeFull', P.ent, 'heat');
        }
        if (!slotHeld(WS_SLOT) || d.ch >= sk.charge + sk.hold) {
          // 放：一次结算整条线
          d.shot = true;
          d.k = sk.minK + (1 - sk.minK) * k;
          d.len = len;
          d.beamT = sk.beamT;
          cc.dur = cc.t + sk.beamT + 0.15;
          cc.cancelT = cc.dur;
          if (!fxOpt('laser', P.x, P.z, sn, cs, len, { w: 1 + 1.6 * k })) W.bolt([{ x: P.x + sn * 0.8, z: P.z + cs * 0.8 }, { x: P.x + sn * len, z: P.z + cs * len }], hex, true);
          const hits = enemiesInLine(P.x, P.z, d.ang, len, (sk.width * (0.6 + 0.4 * k)) / 2);
          if (hits.length) wsStrike(ctx, hits, d.k, { ang: d.ang, w: k >= 1 ? sk.w : 1, kb: sk.kb * (0.5 + 0.5 * k), poise: sk.poise * d.k, stop: sk.stop * (0.4 + 0.6 * k), dir: d.ang });
          else G.sfx('impact', { type: 'fire', w: 1, crit: false });
          W.shake(0.2 + 0.3 * k);
          state.stats.beamShots = (state.stats.beamShots || 0) + 1;
          state.stats.beamHits = (state.stats.beamHits || 0) + hits.length;
          state.stats.beamK = d.k;
        }
      } else {
        // 射线余晖：粗细跟着蓄力，慢慢收细
        d.beamT -= dt;
        if (d.beamT > 0) {
          const f = d.beamT / sk.beamT;
          fxOpt('laser', P.x, P.z, Math.sin(d.ang), Math.cos(d.ang), d.len, { w: (0.4 + 2.2 * (d.k || 1)) * f });
        } else G.world.stop && G.world.stop(P.ent, 0.15);
      }
    };
  };

  // 焚天炎爆：以你为中心半径 radius 的火浪（墙后的不挨），之后留下半径 burn.r 的火场
  WS_FX.rflamer = function (ctx) {
    const W = G.world;
    const sk = ctx.sk;
    const k = Math.sqrt(ctx.area);
    const R = sk.radius * k;
    const hex = hexOf(sk.color);
    const hits = enemiesIn(P.x, P.z, R).filter((e) => losClear(P.x, P.z, e.x, e.z));
    if (!fxOpt('fireNova', P.x, P.z, R)) {
      W.ring(P.x, P.z, R, hex, 0.5);
      W.ring(P.x, P.z, R * 0.6, 0xffd28a, 0.3);
      W.burst(P.x, 0.6, P.z, hex, 60, R * 1.6, 0.7);
    }
    W.fovKick(2.4);
    G.sfx('finisher');
    wsStrike(ctx, hits, 1, { ang: (e) => Math.atan2(e.x - P.x, e.z - P.z), w: sk.w, kb: sk.kb, poise: sk.poise, stop: sk.stop });
    const B = sk.burn;
    // 每一跳按火浪那一击的倍数：按普攻折算时 = burn.sec / basicSec（ctx 的一击是喷射 basicSec 秒）；
    // 否则 burn.mult 是武器伤害的倍数，ctx 里已经乘了火浪的 wm，这里折回去
    const tickK = B.sec !== undefined && sk.basicSec ? B.sec / sk.basicSec : B.mult / (sk.wm || 1);
    addField({ kind: 'burn', x: P.x, z: P.z, r: B.r * k, dur: B.dur, tick: B.tick, mult: tickK, ctx, key: 'burnAt', hex });
  };

  // 乱射：脱离施放系统的持续效果（P.rstate）——翻滚、走动、放别的技能都不打断它
  WS_FX.rrevolver = function (ctx) {
    const sk = ctx.sk;
    P.rstate = { id: ctx.id, t: sk.dur, dur: sk.dur, nextT: 0, i: 0, ctx };
    if (P.cast && P.cast.ranged) endRanged();
    G.world.text(P.x, P.z, sk.name, sk.color, 18);
    G.sfx('cast');
  };
  function updateWildfire(dt) {
    const rs = P.rstate;
    const sk = G.SKILLS[rs.id];
    rs.t -= dt;
    rs.nextT -= dt;
    for (let n = 0; n < 4 && rs.nextT <= 0 && rs.t > -1e-6; n++) {
      rs.nextT += sk.gap;
      // 身边看得见的敌人按距离排，在最近的 spread 个之间轮流点射；一个都没有就朝四周乱射
      const tg = [];
      for (const e of state.enemies) {
        if (e.dead) continue;
        const d = dist(e.x, e.z, P.x, P.z) - e.r;
        if (d <= sk.range && losClear(P.x, P.z, e.x, e.z)) tg.push({ e, d });
      }
      tg.sort((a, b) => a.d - b.d);
      let ang;
      if (tg.length) {
        const e = tg[rs.i % Math.min(sk.spread || 4, tg.length)].e;
        ang = Math.atan2(e.x - P.x, e.z - P.z) + G.rand(-0.07, 0.07);
      } else ang = Math.random() * TAU;
      rs.i++;
      shootProj(rs.ctx, ang, { vk: 'slug', range: sk.range + 4, pierce: (rs.ctx.pierce || 0) + (sk.pierce || 0), after: sk.splash ? wildSplash : null });
      if (rs.i % 2) G.sfx('shot', { type: 'revolver' });
      state.stats.wildShots = (state.stats.wildShots || 0) + 1;
    }
    if (rs.t <= 0) P.rstate = null;
  }

  // 乱射的弹片：命中处半径 splash.r 内的其他敌人挨 splash.mult 倍（不伤被打中的那个）
  function wildSplash(p, e) {
    const S = p.ctx.sk.splash;
    if (!S) return;
    const R = S.r * Math.sqrt(p.ctx.area || 1);
    const x = e.x, z = e.z;
    let n = 0;
    for (const o of enemiesIn(x, z, R)) {
      if (o === e) continue;
      G.hitEnemy(o, p.ctx, S.mult, { ang: Math.atan2(o.x - x, o.z - z), w: 0, kb: 0.15, poise: 2, quiet: true, faint: true, extra: true });
      n++;
    }
    if (n && Math.random() < 0.5) G.world.burst(x, 1.0, z, 0xffcf7a, 6, 4, 0.2);
    state.stats.wildSplash = (state.stats.wildSplash || 0) + n;
  }

  // 弓的专注技：限时增益（P.rbuff），持续时间吃 buffDur
  WS_FX.rbuff = function (ctx) {
    const W = G.world;
    const sk = ctx.sk;
    const dur = sk.buff.dur * Math.max(0.1, 1 + (P.S.buffDur || 0) / 100);
    P.rbuff = { id: ctx.id, t: dur, dur };
    const hex = hexOf(sk.color);
    if (!fxOpt('rangedBuff', sk.wtype, dur)) {
      W.ring(P.x, P.z, 2.6, hex, 0.45);
      W.burst(P.x, 1.2, P.z, hex, 24, 4, 0.6);
    }
    W.text(P.x, P.z, sk.name, sk.color, 18);
    G.sfx('cast');
  };

  // 以当前鼠标落点为目标执行一次技能效果（不扣消耗、不进冷却）
  // st（可选）：连击技能的哪一段
  G.execSkill = function (ctx, st) {
    const fx = SKILL_FX[ctx.sk.kind];
    if (!fx) return false; // 武器技分段施放，只能经由施放系统（R）
    fx(ctx, aimInfo(), st);
    return true;
  };

  // 此刻按下的输入该缓冲多久。固定的 0.3 秒比终结技（0.62 秒后才能接招）和法术都短，
  // 前半段轻点的按键会被悄悄吃掉——所以缓冲要活过手上这个动作：到它「可以接下一个动作」的时刻再多一点。
  // kind：'cast' 技能栏输入 / 'dodge' 翻滚 / 'exec' 处决
  G.bufferTime = function (kind) {
    let wait = 0;
    const x = P.exec;
    if (kind === 'dodge') {
      if (x && !x.hit) wait = EXEC.hit - x.t; // 处决命中之后才能翻滚取消
    } else if (x) wait = EXEC.dur - x.t;
    else if (P.roll.t > 0) wait = P.roll.t;
    else if (kind === 'cast' && P.cast) wait = P.cast.cancelT - P.cast.t;
    return G.clamp(wait + BUFFER_PAD, G.BUFFER, BUFFER_MAX);
  };

  G.dodge = function () {
    if (P.dead || P.roll.t > 0 || P.roll.cd > 0) return false;
    if (P.exec) {
      if (!P.exec.hit) return false; // 处决出手前不能取消
      endExec(false); // 处决命中之后的收招可以翻滚取消
    }
    const mv = moveDir();
    let dx, dz;
    if (mv) {
      dx = mv.x;
      dz = mv.z;
    } else {
      const a = aimInfo();
      dx = a.dx;
      dz = a.dz;
    }
    const r = P.roll;
    r.t = 0.32;
    G.world.play(P.ent, 'roll', { dur: 0.32 });
    r.dx = dx;
    r.dz = dz;
    r.cdMax = 0.9 * (1 - Math.min(90, P.S.dodgeCd || 0) / 100) * (P.relic.any ? G.relicRollK() : 1); // 渊契：踏震 / 随影延长翻滚冷却
    r.cd = r.cdMax;
    P.iframe = Math.max(P.iframe, 0.32);
    P.cast = null; // 翻滚取消挥砍：没出手的起手直接作废，已出手的跳过收招
    comboReset(); // 换了别的动作：连段从头再来
    // 翻滚之前缓冲着的技能输入一并作废（玩家改了主意）；滚的途中再按的会留到滚完
    const inp = G.input;
    inp.tap[0] = inp.tap[1] = inp.tap[2] = inp.tap[3] = inp.tap[4] = 0;
    inp.tapDodge = 0;
    P.face = Math.atan2(dx, dz);
    G.world.burst(P.x, 0.3, P.z, 0xbfb3a0, 8, 2.5, 0.35);
    G.sfx('roll');
    if (P.relic.zhaohun) G.relicRollCall(); // 渊契「随影」
    return true;
  };

  // ---------- 处决 ----------
  // 各阶段的时刻（秒，按不受慢动作影响的动作时间计）：dashA ~ dashB 冲到目标身前，hit 命中，dur 结束
  const EXEC = { dashA: 0.05, dashB: 0.27, hit: 0.33, dur: 0.78 };
  const _spot = { x: 0, z: 0 };

  // 从 (x0, z0) 到 (x1, z1) 的直线是否一路可走（中间没有墙）
  function pathClear(x0, z0, x1, z1) {
    const W = G.world;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const n = Math.ceil(Math.hypot(dx, dz) / 0.4);
    for (let i = 1; i <= n; i++) {
      if (!W.walkable(x0 + (dx * i) / n, z0 + (dz * i) / n, PLAYER_PAD * 0.8)) return false;
    }
    return true;
  }
  // 处决时玩家站的位置：从 (x0, z0) 朝目标冲过去，停在它身前；本来就贴着的话原地不动
  function execSpot(e, x0, z0, out) {
    const dx = x0 - e.x;
    const dz = z0 - e.z;
    const d = Math.hypot(dx, dz);
    const gap = e.r + 0.95;
    if (d <= gap) {
      out.x = x0;
      out.z = z0;
    } else {
      out.x = e.x + (dx / d) * gap;
      out.z = e.z + (dz / d) * gap;
    }
    return out;
  }

  // 找一个可以处决的目标：破绽中、离得够近（range 量到目标边缘）、中间没有墙。
  // 给了 aim 时还要求它大致在瞄准方向上（贴身的不论）。有多个时取最近的
  G.execTarget = function (range, aim) {
    if (P.dead || P.exec) return null;
    let best = null;
    let bd = Infinity;
    for (const e of state.enemies) {
      if (e.dead || !(e.brokenT > 0) || e.executed) continue;
      const d = dist(e.x, e.z, P.x, P.z);
      if (d - e.r > range || d >= bd) continue;
      if (aim !== undefined && d > e.r + 0.8 && Math.abs(angDiff(Math.atan2(e.x - P.x, e.z - P.z), aim)) > 1.25) continue;
      execSpot(e, P.x, P.z, _spot);
      if (!pathClear(P.x, P.z, _spot.x, _spot.z)) continue;
      best = e;
      bd = d;
    }
    return best;
  };

  // 这个破绽中的敌人此刻够不够得着（F 的距离以内、中间没有墙）。界面上的两处处决提示都用它，说法才一致
  G.execReach = function (e) {
    if (P.dead || !e || e.dead || !(e.brokenT > 0) || e.executed) return false;
    if (dist(e.x, e.z, P.x, P.z) - e.r > G.POISE.execRange) return false;
    execSpot(e, P.x, P.z, _spot);
    return pathClear(P.x, P.z, _spot.x, _spot.z);
  };

  // 处决伤害的基数：技能栏上平均击中最高的那个技能。
  // 召唤技能按召唤物的一击算，但处决是玩家自己的伤害：「万骸之主」的自身伤害惩罚照样要乘上
  function execHitOf(id) {
    const ctx = G.skillCtx(id);
    const v = G.avgHit(ctx);
    if (ctx.minion) return v * (1 - Math.min(90, P.S.ownLess || 0) / 100);
    // 有冷却的技能（陨火、闪袭）一下打得重是为了补偿冷却：按「同样的出手时间里能打出多少」折算，免得放上技能栏就把处决抬高几倍
    if (ctx.cd > 0) return (v * ctx.time) / (ctx.time + ctx.cd);
    // 没有冷却的攻击技能：每一击的伤害跟着武器走，慢而重的战锤一击大、快的双匕一击小。处决按秒伤算（乘上攻速，
    // 1.0 攻速的刃正好不变），不然同样秒伤的战锤处决会比双匕重近一半
    // 远程普攻：按秒伤折成「同样秒伤的刃挥一刀」（0.45 秒一刀）
    if (ctx.sk.basic) return G.skillDps(ctx) * 0.45;
    if (ctx.sk.wm && ctx.sk.kind !== 'summon') return v * G.weaponStats(G.save.equip.weapon).aps;
    return v;
  }
  function execBase() {
    const save = G.save;
    let best = 0;
    for (const id of save.bar) if (id && save.skills[id]) best = Math.max(best, execHitOf(id));
    const bid = G.weaponBasic(); // 右键的武器普攻也算
    if (bid) best = Math.max(best, execHitOf(bid));
    if (!best) for (const id in save.skills) best = Math.max(best, execHitOf(id));
    return best;
  }
  G.execBase = execBase; // 处决伤害的基数（测试与技能页用）

  // 对一个破绽中的敌人发动处决：短暂慢动作、冲到身前、一记重击；全程无敌。成功开始返回 true
  G.execute = function (e) {
    if (P.dead || P.exec || P.roll.t > 0) return false;
    if (!e || e.dead || !(e.brokenT > 0) || e.executed || state.enemies.indexOf(e) < 0) return false;
    execSpot(e, P.x, P.z, _spot);
    if (!pathClear(P.x, P.z, _spot.x, _spot.z)) return false; // 隔着墙够不着
    const W = G.world;
    const ang = Math.atan2(e.x - P.x, e.z - P.z);
    P.cast = null;
    comboReset();
    P.exec = { e, t: 0, x0: P.x, z0: P.z, hit: false };
    P.face = P.drawFace = ang;
    P.moving = false;
    P.iframe = Math.max(P.iframe, EXEC.dur + 0.25);
    e.execLock = true; // 处决途中破绽不会到点结束
    e.kvx = e.kvz = 0;
    G.input.tapExec = 0;
    W.play(P.ent, 'execute', { dur: EXEC.dur + 0.1, contact: EXEC.hit });
    W.setTrail(0xfff0c0);
    W.fovKick(3);
    G.slowMo(0.25, 0.5);
    G.sfx('execstart');
    return true;
  };

  // F 键：够得着的破绽目标就处决（正在翻滚时先记下，滚完立刻出手）。没有可处决的目标时返回 false
  G.tryExecute = function () {
    if (P.dead || P.exec) return false;
    const e = G.execTarget(G.POISE.execRange);
    if (!e) return false;
    if (!G.execute(e)) G.input.tapExec = G.bufferTime('exec');
    return true;
  };

  // aborted：目标中途没了——收手，不结算
  function endExec(aborted) {
    const x = P.exec;
    if (!x) return;
    P.exec = null;
    if (x.e) x.e.execLock = false;
    if (aborted) {
      G.world.stop(P.ent);
      P.iframe = Math.min(P.iframe, 0.25);
      flow.slow = 0;
    }
  }

  function execHit(e) {
    const W = G.world;
    const PO = G.POISE;
    const ang = Math.atan2(e.x - P.x, e.z - P.z);
    const base = execBase();
    let dmg;
    if (e.isBoss) {
      // 首领：一大截，但按最大生命封顶
      dmg = G.clamp(base * PO.execHits, e.maxHp * PO.execBossMin, e.maxHp * PO.execBossMax);
    } else {
      // 精英：至少四成最大生命；打完所剩无几的直接毙命
      dmg = Math.max(base * PO.execHits, e.maxHp * PO.execEliteHp);
      if (e.hp - dmg <= e.maxHp * PO.execEliteKill) dmg = Math.max(dmg, e.hp);
    }
    const hp0 = e.hp;
    e.hp -= dmg;
    e.awake = true;
    e.execLock = false;
    e.executed = true; // 一次破绽只能处决一次

    const h = e.height || 2;
    const sn = Math.sin(ang);
    const cs = Math.cos(ang);
    const hx = e.x - sn * e.r * 0.6;
    const hz = e.z - cs * e.r * 0.6;
    W.text(e.x, e.z, Math.round(dmg) + '!', '#ffd75e', 40, { kind: 'big', y: Math.min(3.8, h * 0.8 + 0.7) });
    W.flash(e.ent, 3);
    W.hitReact(e.ent, ang, 2.2);
    W.impact(hx, h * 0.5, hz, ang, 'phys', 3, true);
    W.impact(hx, h * 0.5, hz, ang + 0.5, G.state.zone.def.elem, 2, false);
    W.ring(e.x, e.z, e.r + 3.4, 0xfff0c0, 0.4);
    W.ring(e.x, e.z, e.r + 1.8, 0xffffff, 0.22);
    W.burst(hx, h * 0.5, hz, 0xfff0c0, 34, 9, 0.6);
    W.decal(5, e.x, e.z, e.r + 2.2, Math.random() * TAU, 0xffd28a, 3.2);
    W.shake(0.8);
    W.punch(ang, 0.75);
    W.fovKick(5);
    W.shudder(e.ent, 0.1, 0.18);
    W.shudder(P.ent, 0.03, 0.13);
    G.hitStop(130);
    G.sfx('execute');

    // 奖励：生命、魔力、药剂充能
    G.healPlayer(P.maxLife * (e.isBoss ? PO.execLifeBoss : PO.execLife));
    P.mana = Math.min(P.maxMana, P.mana + P.maxMana * PO.execMana);
    const fl = e.isBoss ? PO.execFlaskBoss : PO.execFlaskElite;
    P.flask.life = Math.min(3, P.flask.life + fl);
    P.flask.mana = Math.min(3, P.flask.mana + fl);
    W.burst(P.x, 1.1, P.z, 0xff6a5a, 10, 2.5, 0.6);
    W.burst(P.x, 1.1, P.z, 0x6a9cff, 10, 2.5, 0.6);

    const st = state.stats;
    st.execs++;
    st.hits++;
    const ch = P.chain;
    ch.n++;
    ch.t = CHAIN_KEEP;
    if (ch.n > ch.best) ch.best = ch.n;

    if (e.hp <= 0) {
      G.killEnemy(e, { ang, type: 'phys', w: 3, over: 1.2 });
    } else {
      // 没死：挣扎着爬起来（首领慢一些），架势回满
      e.brokenT = Math.min(e.brokenT, e.isBoss ? 1.1 : 0.7);
      if (!e.isBoss) {
        const v = (2.2 * KB_DECAY) / (e.mass || 1);
        e.kvx = sn * v;
        e.kvz = cs * v;
      }
    }
    if (P.relic.duanyue) G.relicSweep(e, dmg); // 渊契「崩势」：处决横扫
    return hp0 - Math.max(0, e.hp);
  }

  function updateExec(adt) {
    const W = G.world;
    const x = P.exec;
    const e = x.e;
    // 目标没了（被别的伤害打死、被清掉、破绽结束）：收手
    if (!x.hit && (e.dead || !(e.brokenT > 0) || state.enemies.indexOf(e) < 0)) {
      endExec(true);
      return;
    }
    x.t += adt;
    if (!x.hit) {
      // 冲到目标身前：落点每帧按它现在的位置重算；下一步不可走就停在原地
      execSpot(e, x.x0, x.z0, _spot);
      const f = G.clamp((x.t - EXEC.dashA) / (EXEC.dashB - EXEC.dashA), 0, 1);
      const s = f * f * (3 - 2 * f);
      const nx = x.x0 + (_spot.x - x.x0) * s;
      const nz = x.z0 + (_spot.z - x.z0) * s;
      if ((nx !== P.x || nz !== P.z) && W.walkable(nx, nz, PLAYER_PAD * 0.8)) {
        if (dist(nx, nz, P.x, P.z) > 0.05) W.dashFx(P.x, P.z, nx, nz, 0xfff0c0);
        P.x = nx;
        P.z = nz;
      }
      if (dist(e.x, e.z, P.x, P.z) > 0.1) P.face = Math.atan2(e.x - P.x, e.z - P.z);
      if (x.t >= EXEC.hit) {
        // 冲到一半被挡住、够不着了：收手，不结算
        if (dist(e.x, e.z, P.x, P.z) > e.r + 2.4) {
          endExec(true);
          return;
        }
        x.hit = true;
        execHit(e);
      }
    }
    if (P.exec === x && x.t >= EXEC.dur) endExec(false);
  }

  G.useFlask = function (kind) {
    if (P.dead) return false;
    const isLife = kind === 'life';
    const cur = isLife ? P.life : P.mana;
    const max = isLife ? P.maxLife : P.maxMana;
    if (cur >= max && !P.hot[kind]) return false; // 满的时候不浪费
    if (P.flask[kind] < 1) {
      toast(isLife ? '生命药剂已用尽，击杀敌人可补充' : '魔力药剂已用尽，击杀敌人可补充', '#c8b89a', 'flask-' + kind, 2000);
      return false;
    }
    P.flask[kind] -= 1;
    const amount = max * (isLife ? 0.45 : 0.5);
    const left = (P.hot[kind] ? P.hot[kind].left : 0) + amount;
    P.hot[kind] = { left, rate: left / 1.2 };
    G.world.burst(P.x, 1.0, P.z, isLife ? 0xff5a5a : 0x5a8cff, 12, 2.5, 0.5);
    G.sfx('pickup');
    return true;
  };

  function tickFlask(kind, dt) {
    const h = P.hot[kind];
    if (!h) return;
    const v = Math.min(h.left, h.rate * dt);
    h.left -= v;
    if (kind === 'life') P.life = Math.min(P.maxLife, P.life + v);
    else P.mana = Math.min(P.maxMana, P.mana + v);
    if (h.left <= 1e-6) P.hot[kind] = null;
  }

  // dt：游戏时间；adt（可选）：动作时间——不受慢动作影响（顿帧时照样为 0），输入缓冲和处决按它走
  // ---------- 地形危险区（每帧一次）：减速、灼烧、薄冰 ----------
  // 数值在 G.TERRAIN。legacy 布局没有危险区格子（hazAny = 0），直接返回，系数保持 1
  const terr = { k: 1, roll: 1, burnT: 0, thinT: 0, thinId: -1, crack: {} };
  function terrainTick(dt) {
    const zone = state.zone, W = G.world, TR = G.TERRAIN, H = W.HAZ;
    terr.k = terr.roll = 1;
    const mask = zone && zone.map ? zone.map.hazAny : 0;
    if (!mask) {
      terr.burnT = terr.thinT = 0;
      terr.thinId = -1;
      return;
    }
    const hz = W.hazardAt(P.x, P.z);
    let slow = !!(hz & H.slow);
    // 薄冰：在同一块上站够 thinT 秒就裂开，裂开的那块算减速；离开后 thinBack 秒复原（只有视觉和音效，不会掉下去）
    const tid = hz & H.thin ? W.hazPrimAt(P.x, P.z, 'thin') : -1;
    for (const id in terr.crack) {
      const c = terr.crack[id];
      if (+id === tid) c.back = TR.thinBack;
      else if ((c.back -= dt) <= 0) delete terr.crack[id];
    }
    if (tid >= 0 && terr.crack[tid]) slow = true;
    else if (tid >= 0) {
      terr.thinT = terr.thinId === tid ? terr.thinT + dt : dt;
      terr.thinId = tid;
      if (terr.thinT >= TR.thinT) {
        terr.crack[tid] = { back: TR.thinBack };
        terr.thinT = 0;
        W.burst(P.x, 0.2, P.z, 0xcfefff, 14, 3, 0.4);
        G.sfx('impact');
      }
    } else {
      terr.thinId = -1;
      terr.thinT = 0;
    }
    if (slow) {
      terr.k = TR.slow;
      terr.roll = TR.slowRoll;
    }
    // 灼烧：每 burnTick 秒一跳火焰伤害；召唤物也吃
    const burn = TR.burn * G.dmgScale(zone.level);
    if (hz & H.burn) {
      terr.burnT += dt;
      if (terr.burnT >= TR.burnTick) {
        terr.burnT -= TR.burnTick;
        G.hurtPlayer(burn, 'fire', null);
      }
    } else terr.burnT = 0;
    if (mask & H.burn && G.hurtMinion && state.minions) {
      for (const m of state.minions.slice()) {
        if (m.dead) continue;
        if (W.hazardAt(m.x, m.z) & H.burn) {
          m.burnT = (m.burnT || 0) + dt;
          if (m.burnT >= TR.burnTick) {
            m.burnT -= TR.burnTick;
            G.hurtMinion(m, burn, 'fire', null);
          }
        } else m.burnT = 0;
      }
    }
  }
  // 地形灼烧打到小怪（enemies.js 每 burnTick 秒调一次；首领免疫）：不算玩家的命中，不触发技能效果
  G.terrainBurnEnemy = function (e) {
    if (!e || e.dead || e.isBoss || !state.zone) return;
    const W = G.world;
    const dmg = Math.max(1, G.TERRAIN.burn * G.dmgScale(state.zone.level));
    e.hp -= dmg;
    W.flash(e.ent, 0.6);
    W.text(e.x, e.z, '-' + Math.round(dmg), '#ff8a3c', 14);
    if (e.hp <= 0) G.killEnemy(e);
  };

  // ---------- 宝箱 ----------
  // 走到 CHEST_R 以内自动打开；掉落约等于打死一只精英（按精英的掉落表掷一次，物品等级 = 宝箱所在房间的怪物等级）。
  // 只对这次进区有效（布局不存档）
  const CHEST_R = 1.4;
  G.openChest = function (c) {
    const zone = state.zone;
    if (!zone || !c || c.open) return false;
    c.open = true;
    const rm = zone.rooms && zone.rooms[c.room];
    const level = zone.level + (rm && rm.lv !== undefined ? rm.lv : Math.floor((rm ? rm.order : 0) / 2)); // rm.lv：和房间里的怪同一个等级（zones-polish，加长后的区域按路径比例折算）
    G.dropLoot({ elite: true, level, x: c.x, z: c.z });
    G.world.openChest(c);
    G.sfx('pickup');
    state.stats.chests = (state.stats.chests || 0) + 1;
    return true;
  };
  // 点击打开（zones-polish）：和点掉落名牌一样，7 m 以内直接打开，远了提示走近。
  // 点在箱体上时，鼠标射线落到地面的点会比宝箱的中心往远处偏一点（镜头俯角 50°，箱高约 0.9 m），所以判定圆往北挪 0.35 m
  G.chestAt = function (wx, wz) {
    const list = state.zone && state.zone.chests;
    if (!list) return null;
    let best = null, bd = 1.4;
    for (const c of list) {
      if (c.open) continue;
      const d = dist(wx, wz, c.x, c.z - 0.35);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  G.clickChest = function (c) {
    if (!c || c.open || P.dead) return false;
    if (dist(c.x, c.z, P.x, P.z) > 7) {
      toast('走近一点', '#c8b89a', 'far', 900);
      return false;
    }
    return G.openChest(c);
  };
  function updateChests() {
    const list = state.zone && state.zone.chests;
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.open && dist(P.x, P.z, c.x, c.z) < CHEST_R) G.openChest(c);
    }
  }

  G.updatePlayer = function (dt, adt) {
    const W = G.world;
    const inp = G.input;
    if (adt === undefined) adt = dt;
    syncWsCd();

    if (P.dead) {
      W.setAura(0);
      if (W.setFlame) W.setFlame(false);
      P.deadT -= dt;
      if (P.deadT <= 0) G.respawn();
      return;
    }

    // 回复
    P.life = Math.min(P.maxLife, P.life + P.lifeRegen * dt);
    P.mana = Math.min(P.maxMana, P.mana + P.manaRegen * dt);
    tickFlask('life', dt);
    tickFlask('mana', dt);

    // 各种计时
    for (const id in P.cds) if (P.cds[id] > 0) P.cds[id] = Math.max(0, P.cds[id] - dt);
    tickRanged(dt);
    updateChaos(dt);
    if (P.relic.any || G.relicState.bridges.length || G.relicState.spin) G.relicTick(dt); // 渊契：蓄潮、星雨、电桥……
    updateAuras(dt);
    updateAutoSummon(dt);
    if (P.roll.cd > 0) P.roll.cd = Math.max(0, P.roll.cd - dt);
    if (P.iframe > 0) P.iframe = Math.max(0, P.iframe - dt);
    if (P.graceT > 0) P.graceT = Math.max(0, P.graceT - dt);
    terrainTick(dt);
    updateChests();
    for (let i = 0; i < 5; i++) if (inp.tap[i] > 0) inp.tap[i] -= adt;
    if (inp.tapDodge > 0) inp.tapDodge -= adt;
    if (inp.tapExec > 0) inp.tapExec -= adt;
    // 连击计数与连段窗口
    const ch = P.chain;
    if (ch.n > 0) {
      ch.t -= dt;
      if (ch.t <= 0) ch.n = 0;
    }
    if (P.combo.t > 0) {
      P.combo.t -= dt;
      if (P.combo.t <= 0) P.combo.step = 0;
    }

    const mv = moveDir();
    if (P.exec) {
      // 处决：位置和朝向都由处决自己管
      updateExec(adt);
      P.moving = false;
    } else if (P.roll.t > 0) {
      // 翻滚：固定方向冲刺，期间不施法（按下的技能留在缓冲里，滚完就出）
      const step = Math.min(dt, P.roll.t);
      P.roll.t -= dt;
      if (P.roll.t <= 0 && P.relic.panzhong) G.relicLand(); // 渊契「踏震」：翻滚落地
      const sp = P.moveSpeed * 2.6 * step * terr.roll; // 地形减速时翻滚距离也短一点
      movePlayer(P.roll.dx * sp, P.roll.dz * sp);
      P.moving = true;
      P.dustT -= dt;
      if (P.dustT <= 0) {
        P.dustT = 0.05;
        W.burst(P.x, 0.25, P.z, 0xbfb3a0, 2, 1.2, 0.3);
      }
    } else {
      // 缓冲着的处决 / 翻滚优先于施法：一旦能动就出手
      let acted = false;
      if (inp.tapExec > 0) {
        const e = G.execTarget(G.POISE.execRange);
        acted = !!e && G.execute(e);
      }
      if (!acted && inp.tapDodge > 0) acted = G.dodge();
      if (acted) {
        P.moving = P.roll.t > 0;
      } else {
        // 手上没有动作，或上一个动作已经过了可取消的时刻（连击段的收招）：可以开始下一个
        if (!P.cast || (P.cast.fired && P.cast.t >= P.cast.cancelT)) tryStartCast();
        if (P.exec) {
          P.moving = false; // 近战键贴身触发了处决
        } else {
          if (P.cast) updateCast(dt);
          // 影步连斩途中站定不走（位移全靠闪现）；连斩选中破绽目标时当帧转入处决，这一帧也不走
          const still = !!P.exec || !!(P.cast && (P.cast.flicker || (P.cast.ws && !P.cast.move))); // 影刺 / 瞬断途中位移全由技能接管
          if (mv && !still) {
            // 施法中走得慢；挥砍出手前几乎钉在原地（那一小步由连击自己迈）；旋风斩边转边走
            const c = P.cast;
            let k = !c ? 1 : c.channel || c.ws ? c.move : c.st ? (c.fired ? 0.55 : 0.25) : 0.4;
            if (P.rstate) k = Math.max(k, G.SKILLS[P.rstate.id].move || 1); // 乱射期间照常走动
            const sp = P.moveSpeed * k * dt * terr.k;
            movePlayer(mv.x * sp, mv.z * sp);
            if (!P.cast) P.face = Math.atan2(mv.x, mv.z);
          }
          P.moving = !!mv && !still;
        }
      }
    }

    // 持续施放被别处打断（换区域、复活、改键位……）：转圈的动作别留着
    if (P.spinning && !(P.cast && P.cast.channel)) {
      P.spinning = false;
      if (W.clipOf(P.ent) === 'spin') W.stop(P.ent, 0.16);
    }

    // 传送门：走近打开地图，离开后重新待命
    const portal = state.portal;
    if (portal) {
      const d = dist(P.x, P.z, portal.x, portal.z);
      if (portal.armed && d < 1.8) {
        portal.armed = false;
        G.ui.open('map');
      } else if (!portal.armed && d > 3.5) {
        portal.armed = true;
      }
    }

    // 朝向做一点平滑，逻辑朝向仍是即时的。拉弓时转得快一些（约 3 帧转过来）；这次出手的方向交给动画，
    // 身子还没转过来的那几帧由上身先转向准星（world 的 bowLead，只对带 draw 的拉弓动作生效）
    const bowDraw = !!(P.cast && P.cast.ranged && RFAM[P.cast.rtype] === 'bow');
    P.drawFace += angDiff(P.face, P.drawFace) * Math.min(1, (P.exec ? adt : dt) * (bowDraw ? 40 : 24));
    P.ent.aimYaw = P.cast && P.cast.aim !== undefined ? P.cast.aim : null;
    W.setEnt(P.ent, P.x, P.z, P.drawFace);
    W.animEnt(P.ent, P.exec ? adt : dt, P.moving, state.time); // 处决的动作按动作时间播，世界放慢时这一击照常利落
  };

  // =====================================================================
  // 掉落与拾取
  // =====================================================================
  function gemLevel() {
    return G.clamp(Math.round(state.zone.level * 0.75) + G.randInt(0, 1), 1, MAX_GEM_LEVEL);
  }
  // 无铭技能宝石的掉落几率（首领首杀另外必掉）：普通怪比随机技能宝石的 1.2% 略低
  const BLANK_DROP = (G.BLANK_DROP = { boss: 0.2, elite: 0.04, mob: 0.008 });
  // 辅助宝石的掉落：首领固定掉 boss 颗（第一颗必是还没有的），精英 elite、普通怪 mob 的几率各掉一颗
  const SUPPORT_DROP = (G.SUPPORT_DROP = { boss: 2, elite: 0.3, mob: 0.025 });
  // preferNew：挑玩家还没有的宝石的概率
  function pickSkillGem(preferNew) {
    const all = G.GEM_SKILLS; // 武器技不掉落
    const fresh = all.filter((id) => !G.save.skills[id]);
    const id = fresh.length && Math.random() < preferNew ? G.pick(fresh) : G.pick(all);
    return { id, lvl: gemLevel() };
  }
  function pickSupportGem(preferNew) {
    const all = Object.keys(G.SUPPORTS);
    const fresh = all.filter((id) => G.save.supports.indexOf(id) < 0);
    return fresh.length && Math.random() < preferNew ? G.pick(fresh) : G.pick(all);
  }

  G.dropLoot = function (e) {
    const save = G.save;
    const ilvl = Math.max(1, e.level);
    const rm = 1 + (P.S.rarity || 0) / 100;
    const x = e.x;
    const z = e.z;

    if (e.isBoss) {
      G.spawnLoot('item', G.rollItem(ilvl, 2), x, z);
      for (let i = 0; i < 2; i++) G.spawnLoot('item', G.rollItem(ilvl, Math.max(1, G.rollRarity(rm))), x, z);
      for (let i = 0; i < 4; i++) G.spawnLoot('cur', G.rollCurrency(), x, z);
      // 首领第一次倒下：另外保底升华石、乱流石各一颗
      if (e.bossKind && !save.bossKills[e.bossKind]) for (const id of G.BOSS_FIRST_CUR) G.spawnLoot('cur', id, x, z);
      G.spawnLoot('skill', pickSkillGem(1), x, z);
      for (let i = 0; i < SUPPORT_DROP.boss; i++) G.spawnLoot('support', pickSupportGem(i ? 0.7 : 1), x, z);
      // 无铭技能宝石：每个首领第一次倒下必掉一颗（第一个区域的首领就是新角色的保底），之后再打有小几率
      if ((e.bossKind && !save.bossKills[e.bossKind]) || Math.random() < BLANK_DROP.boss) G.spawnLoot('blank', { lvl: gemLevel() }, x, z);
      uniqueDrop(e, ilvl);
      G.relicBossDrop(e, ilvl); // 渊契：和烬铸分开掷
      return;
    }
    if (e.elite) {
      for (let i = 0; i < 2; i++) G.spawnLoot('item', G.rollItem(ilvl, G.rollRarity(rm * 2)), x, z);
      G.spawnLoot('cur', G.rollCurrency(), x, z);
      // 还没有任何辅助宝石时，第一只精英必掉一颗
      const needFirst = save.supports.length === 0 && !state.loot.some((l) => l.kind === 'support');
      if (needFirst || Math.random() < SUPPORT_DROP.elite) G.spawnLoot('support', pickSupportGem(needFirst ? 1 : 0.7), x, z);
      if (Math.random() < 0.075) G.spawnLoot('skill', pickSkillGem(0.7), x, z);
      if (Math.random() < BLANK_DROP.elite) G.spawnLoot('blank', { lvl: gemLevel() }, x, z);
      return;
    }
    // 区域刷的普通怪（horde）掉落几率按 G.BALANCE.loot 打折：怪多了一倍，一整区合计约 ×1.15
    const L = e.horde ? G.BALANCE.loot : null;
    const zk = L ? e.hordeK || 1 : 1, kItem = L ? L.item * zk : 1, kCur = L ? L.cur * zk : 1, kGem = L ? L.gem * zk : 1;
    if (Math.random() < 0.14 * kItem) G.spawnLoot('item', G.rollItem(ilvl, G.rollRarity(rm)), x, z);
    if (Math.random() < 0.09 * kCur) G.spawnLoot('cur', G.rollCurrency(), x, z);
    if (Math.random() < 0.012 * kGem) G.spawnLoot('skill', pickSkillGem(0.7), x, z);
    if (Math.random() < SUPPORT_DROP.mob * kGem) G.spawnLoot('support', pickSupportGem(0.7), x, z);
    if (Math.random() < BLANK_DROP.mob * kGem) G.spawnLoot('blank', { lvl: gemLevel() }, x, z);
  };

  // 烬铸武器：五个首领都会掉（层级 1 起），各掉各的那一把；连续 pity 次没掉，下一次必掉（计数存档，掉了清零）
  function uniqueDrop(e, ilvl) {
    const kind = e.bossKind;
    const id = kind && G.UNIQUE_BY_BOSS[kind];
    const tier = state.tier || 0;
    if (!id || tier < 1) return null;
    const U = G.save.uniq;
    const n = U.pity[kind] || 0;
    if (n >= G.UNIQUE_DROP.pity || Math.random() < G.uniqueChance(tier)) {
      U.pity[kind] = 0;
      // 同一个首领有两把（衔星巨兽：凛羽 / 星蚀）：判定次数和保底不变，掉了之后一半给第一把、一半给另一把
      const alt = G.UNIQUE_ALT && G.UNIQUE_ALT[kind];
      const item = G.rollUnique(alt && alt.length && Math.random() >= 0.5 ? alt[Math.floor(Math.random() * alt.length)] : id, ilvl);
      const loot = G.spawnLoot('item', item, e.x, e.z);
      G.sfx('unique');
      if (G.ui.bigToast) G.ui.bigToast('烬铸武器', item.name, G.RARITY_COLOR[3], G.UNIQUES[item.uq].mechName);
      state.stats.uniqueDrops = (state.stats.uniqueDrops || 0) + 1;
      return loot;
    }
    U.pity[kind] = n + 1;
    return null;
  }
  G.uniqueDrop = uniqueDrop;

  G.spawnLoot = function (kind, data, x, z) {
    const W = G.world;
    // 在落点周围找一个可走、且尽量不与其他掉落重叠的位置
    let bx = x;
    let bz = z;
    let bestScore = -1;
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU;
      const r = G.rand(0.5, 2.4);
      const cx = x + Math.sin(a) * r;
      const cz = z + Math.cos(a) * r;
      if (!W.walkable(cx, cz, 0.4)) continue;
      let near = 4;
      for (const l of state.loot) near = Math.min(near, dist(l.x, l.z, cx, cz));
      if (near > bestScore) {
        bestScore = near;
        bx = cx;
        bz = cz;
      }
      if (near >= 1.4) break;
    }

    let label, color, beam;
    if (kind === 'item') {
      label = data.name;
      color = G.RARITY_COLOR[data.rarity];
      beam = data.rarity >= 2;
    } else if (kind === 'cur') {
      label = G.CURRENCY[data].name;
      color = G.CURRENCY[data].color;
      beam = false;
    } else if (kind === 'skill') {
      label = '技能宝石：' + G.SKILLS[data.id].name + ' Lv ' + data.lvl;
      color = GEM_COLOR;
      beam = true;
    } else if (kind === 'blank') {
      label = G.BLANK_GEM.name + ' Lv ' + data.lvl;
      color = G.BLANK_GEM.color;
      beam = true;
    } else {
      label = '辅助宝石：' + G.SUPPORTS[data].name;
      color = SUP_COLOR;
      beam = true;
    }
    const loot = { kind, data, x: bx, z: bz, label, color, mesh: W.makeLoot(kind, hexOf(kind === 'blank' ? G.BLANK_GEM.crystal : color), beam, bx, bz, kind === 'item' ? data : undefined), t: 0 };
    state.loot.push(loot);
    return loot;
  };

  // 学会一个新技能：开好 3 个辅助槽，技能栏有空格就放进去；返回放进的格子（没有空格时 -1）
  function learnSkill(id, lvl) {
    const save = G.save;
    save.skills[id] = Math.max(lvl, G.gemFloor()); // 新学的技能也不低于随角色成长的等级
    save.sockets[id] = [null, null, null];
    const free = G.freeBarSlot();
    if (free >= 0) save.bar[free] = id;
    G.computeStats(); // 光环宝石自动绑上技能栏就立刻生效：保留魔力要马上算进去
    return free;
  }

  // ---------- 无铭技能宝石 ----------
  // 手里最高的一颗（没有时 0）
  G.blankBest = () => G.save.blankGems[0] || 0;
  // 某个等级的无铭宝石还有没有用处：有没学会的技能，或有低于这个等级的已学技能
  G.blankUseful = function (lvl) {
    const sk = G.save.skills;
    return G.GEM_SKILLS.some((id) => !sk[id] || sk[id] < lvl);
  };
  // 对某个技能用一颗无铭宝石：没学会就学会，学会了就升到宝石的等级。总是用手里等级最高的那颗；
  // 已学技能的等级不低于它时不能用。成功返回 { id, lvl, from（原等级，新学为 0）, slot（新学时放进的技能栏格子，-1 为没有空格） }
  G.useBlankGem = function (id) {
    const save = G.save;
    const sk = G.SKILLS[id];
    const lvl = G.blankBest();
    const have = save.skills[id] || 0;
    if (!sk || sk.weaponOnly || !lvl || lvl <= have) return null;
    save.blankGems.shift();
    const B = G.BLANK_GEM;
    let slot = -1;
    if (!have) {
      slot = learnSkill(id, lvl);
      toast('习得技能：' + sk.name + ' Lv ' + save.skills[id] + (slot >= 0 ? '' : '（在技能页绑定到技能栏）') + ' · 用掉一颗' + B.short, GEM_COLOR);
    } else {
      save.skills[id] = lvl;
      toast(sk.name + ' 升至 Lv ' + lvl + ' · 用掉一颗' + B.short, GEM_COLOR);
    }
    G.sfx('gem');
    G.persist();
    return { id, lvl, from: have, slot };
  };

  function grantCurrency(id, n) {
    G.save.cur[id] = (G.save.cur[id] || 0) + n;
  }

  G.pickup = function (loot) {
    const W = G.world;
    const save = G.save;
    const idx = state.loot.indexOf(loot);
    if (idx < 0 || P.dead) return false;
    if (dist(loot.x, loot.z, P.x, P.z) > 7) {
      toast('走近一点', '#c8b89a', 'far', 900);
      return false;
    }

    // 选项「拾取时自动分解普通物品」：不进背包，直接化成通货（普通物品通常什么也分解不出）
    const scrapped = loot.kind === 'item' && loot.data.rarity === 0 && !!save.opts.autoSalvage;
    if (scrapped) {
      const res = G.salvageResult(loot.data);
      for (const id in res) grantCurrency(id, res[id]);
      G.sfx('pickup');
    } else if (loot.kind === 'item') {
      if (save.bag.length >= BAG_SIZE) {
        toast('背包已满', '#ff8a6a', 'bagfull', 2500);
        return false;
      }
      save.bag.push(loot.data);
      if (loot.data.rarity === 3) {
        noteUnique(loot.data);
        G.persist();
      }
      if (loot.data.rarity === 4) {
        // 渊契：记进图鉴；它的图标从这时起才进低画质的预热（见 icons.js 的 warm）
        noteRelic(loot.data);
        if (G.icons && G.icons.warmRelic) G.icons.warmRelic(loot.data.rq);
        G.persist();
      }
      G.sfx('pickup');
    } else if (loot.kind === 'cur') {
      grantCurrency(loot.data, 1);
      W.text(P.x, P.z, '+1 ' + G.CURRENCY[loot.data].name, loot.color, 13);
      G.sfx('pickup');
    } else if (loot.kind === 'skill') {
      const id = loot.data.id;
      const lvl = loot.data.lvl;
      const name = G.SKILLS[id].name;
      const have = save.skills[id];
      if (!have) {
        const free = learnSkill(id, lvl);
        toast('习得技能：' + name + ' Lv ' + save.skills[id] + (free >= 0 ? '' : '（按 G 绑定到技能栏）'), GEM_COLOR);
      } else if (lvl > have) {
        save.skills[id] = lvl;
        toast(name + ' 升至 Lv ' + lvl, GEM_COLOR);
      } else {
        grantCurrency('dust', 1);
        toast('重复的技能宝石化为 1 ' + G.CURRENCY.dust.name, G.CURRENCY.dust.color);
      }
      G.sfx('gem');
      G.persist();
    } else if (loot.kind === 'blank') {
      const lvl = loot.data.lvl;
      const B = G.BLANK_GEM;
      if (!G.blankUseful(lvl) || save.blankGems.length >= BLANK_MAX) {
        // 所有技能都已学会且都不低于这个等级：这颗再也用不上，和重复的技能宝石一样化成尘
        grantCurrency('dust', 1);
        toast('用不上的' + B.name + '化为 1 ' + G.CURRENCY.dust.name, G.CURRENCY.dust.color);
      } else {
        save.blankGems.push(lvl);
        save.blankGems.sort((a, b) => b - a);
        toast('获得' + B.name + ' Lv ' + lvl + '（共 ' + save.blankGems.length + ' 颗，按 G 在技能页挑选技能）', B.color);
      }
      G.sfx('gem');
      G.persist();
    } else {
      const id = loot.data;
      if (save.supports.indexOf(id) < 0) {
        save.supports.push(id);
        toast('获得辅助宝石：' + G.SUPPORTS[id].name + '（按 G 镶嵌）', SUP_COLOR);
      } else {
        grantCurrency('augment', 1);
        toast('重复的辅助宝石化为 1 ' + G.CURRENCY.augment.name, G.CURRENCY.augment.color);
      }
      G.sfx('gem');
      G.persist();
    }

    state.loot.splice(idx, 1);
    W.removeMesh(loot.mesh);
    G.ui.onPickup(loot, scrapped); // 拾取记录（带图标）、背包里的「新」标记
    return true;
  };

  // F 键：拾取 3.5 以内最近的掉落
  G.pickupNearest = function () {
    let best = null;
    let bd = 3.5;
    for (const l of state.loot) {
      const d = dist(l.x, l.z, P.x, P.z);
      if (d <= bd) {
        bd = d;
        best = l;
      }
    }
    if (best) return G.pickup(best);
    // 附近没有掉落：打开 3.5 以内最近的宝箱（zones-polish）
    const list = state.zone && state.zone.chests;
    let bc = null, cd = 3.5;
    if (list) for (const c of list) {
      const d = dist(c.x, c.z, P.x, P.z);
      if (!c.open && d <= cd) {
        cd = d;
        bc = c;
      }
    }
    return bc ? G.openChest(bc) : false;
  };

  G.updateLoot = function (dt) {
    const save = G.save;
    const list = state.loot;
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      l.t += dt;
      if (P.dead || l.t < 0.3) continue; // 刚落地的先让玩家看一眼
      const d = dist(l.x, l.z, P.x, P.z);
      if (l.noAuto) {
        // 玩家自己丢下的东西：走开之前不自动捡回来（F 键 / 点名牌仍然可以）
        if (d > 3.2) l.noAuto = false;
        continue;
      }
      if (l.kind === 'item') {
        if (d <= 1.6 && (l.data.rarity >= 1 || save.opts.autoWhite)) G.pickup(l);
      } else if (d <= 2.2) {
        G.pickup(l);
      }
    }
  };

  G.gainXp = function (v) {
    const save = G.save;
    if (!(v > 0) || save.level >= MAX_LEVEL) return;
    save.xp += v;
    let gained = 0;
    while (save.level < MAX_LEVEL && save.xp >= G.xpNeed(save.level)) {
      save.xp -= G.xpNeed(save.level);
      save.level++;
      gained++;
    }
    if (save.level >= MAX_LEVEL) save.xp = 0;
    if (!gained) return;
    const gemsUp = G.syncGemLevels();
    G.computeStats();
    if (!P.dead) {
      P.life = P.maxLife;
      P.mana = P.maxMana;
    }
    toast('等级提升：Lv ' + save.level + '（获得 ' + gained + ' 点天赋点）', '#ffd75e');
    if (gemsUp.length) toast('技能宝石随之成长到 Lv ' + G.gemFloor() + '：' + gemsUp.map((id) => G.SKILLS[id].name).join('、'), GEM_COLOR);
    G.world.ring(P.x, P.z, 4.5, 0xffd75e, 0.6);
    G.world.burst(P.x, 1.2, P.z, 0xffd75e, 30, 5, 0.8);
    G.sfx('level');
    G.persist();
  };

  // =====================================================================
  // 背包 / 构筑操作（供 UI 调用）
  // =====================================================================
  function commit() {
    G.computeStats();
    syncWsCd();
    G.persist();
    return true;
  }

  function bagIndex(item) {
    const bag = G.save.bag;
    const i = bag.indexOf(item);
    if (i >= 0 || !item) return i;
    return bag.findIndex((b) => b.uid === item.uid);
  }

  G.equip = function (item) {
    const save = G.save;
    const i = bagIndex(item);
    if (i < 0) return false;
    const it = save.bag[i];
    const old = save.equip[it.slot];
    save.equip[it.slot] = it;
    // 换下来的装备放回原格子，背包不会因此溢出
    if (old) save.bag.splice(i, 1, old);
    else save.bag.splice(i, 1);
    return commit();
  };

  G.unequip = function (slot) {
    const save = G.save;
    const it = save.equip[slot];
    if (!it) return false;
    if (save.bag.length >= BAG_SIZE) return false; // 提示由背包页自己显示
    delete save.equip[slot];
    save.bag.push(it);
    return commit();
  };

  function addResult(sum, res) {
    for (const id in res) sum[id] = (sum[id] || 0) + res[id];
  }
  function resultText(sum) {
    return Object.keys(sum).map((id) => G.CURRENCY[id].name + ' ×' + sum[id]).join('、');
  }

  G.salvage = function (item) {
    const save = G.save;
    const i = bagIndex(item);
    if (i < 0) return false; // 只能分解背包里的物品
    const it = save.bag[i];
    save.bag.splice(i, 1);
    const res = G.salvageResult(it);
    for (const id in res) grantCurrency(id, res[id]);
    const txt = resultText(res);
    if (txt) toast('分解获得：' + txt, '#7fe0c0');
    return commit();
  };

  G.salvageAllNormal = function () {
    const save = G.save;
    const keep = [];
    const sum = {};
    let n = 0;
    for (const it of save.bag) {
      if (it.rarity === 0) {
        addResult(sum, G.salvageResult(it));
        n++;
      } else {
        keep.push(it);
      }
    }
    if (!n) return false;
    save.bag = keep;
    for (const id in sum) grantCurrency(id, sum[id]);
    const txt = resultText(sum);
    toast('分解了 ' + n + ' 件普通物品' + (txt ? '，获得：' + txt : ''), '#c8b89a');
    return commit();
  };

  // idx：琢刻石要重洗的词缀下标（其他通货不用）。没选或选了不能洗的那条：不消耗，返回 false
  G.applyCurrency = function (item, curId, idx) {
    const save = G.save;
    if (!item || !G.CURRENCY[curId] || !(save.cur[curId] > 0)) return false;
    if (item.rarity === 3) {
      toast('烬铸武器无法改造', '#ff8a6a', 'uqlock', 600);
      return false;
    }
    if (item.rarity === 4) {
      toast(G.RELIC_NAME + '无法改造', '#ff8a6a', 'uqlock', 600);
      return false;
    }
    if (!G.canCraft(item, curId)) return false;
    const r = G.craft(item, curId, idx);
    if (!r.ok) {
      if (r.msg) toast(r.msg, '#ff8a6a');
      return false;
    }
    save.cur[curId]--;
    return commit();
  };

  // ---------- 背包整理（拖拽 / 排序 / 丢弃 / 批量分解） ----------
  // 把背包里的物品挪到第 toIdx 格：那一格有东西就互换，否则排到末尾（背包是紧凑数组，顺序即存档顺序）
  G.moveBagItem = function (item, toIdx) {
    const bag = G.save.bag;
    const i = bagIndex(item);
    if (i < 0 || !(toIdx >= 0) || toIdx !== Math.floor(toIdx)) return false;
    if (toIdx >= bag.length) {
      bag.push(bag.splice(i, 1)[0]);
    } else if (toIdx !== i) {
      const other = bag[toIdx];
      bag[toIdx] = bag[i];
      bag[i] = other;
    }
    G.persist();
    return true;
  };

  // 排序：部位 → 稀有度（高在前）→ 物品等级（高在前）→ 名称
  G.sortBag = function () {
    const order = {};
    G.SLOTS.forEach((s, i) => (order[s] = i));
    G.save.bag.sort((a, b) => order[a.slot] - order[b.slot] || b.rarity - a.rarity || b.ilvl - a.ilvl || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    G.persist();
    return true;
  };

  // 把背包里的一件物品丢在玩家脚边；返回地上的掉落物，失败返回 null
  G.dropItem = function (item) {
    const save = G.save;
    const i = bagIndex(item);
    if (i < 0 || !state.zone) return null;
    const it = save.bag.splice(i, 1)[0];
    const loot = G.spawnLoot('item', it, P.x, P.z);
    loot.noAuto = true;
    G.persist();
    return loot;
  };

  // 一键分解：稀有度不高于 maxRarity（0 普通，1 魔法）的背包物品。
  // 返回 { n, byRarity: [普通件数, 魔法件数], gained: { 通货 id: 数量 } }，没有可分解的返回 null
  G.salvageBulk = function (maxRarity) {
    const save = G.save;
    const cap = maxRarity >= 1 ? 1 : 0;
    const keep = [];
    const out = { n: 0, byRarity: [0, 0], gained: {} };
    for (const it of save.bag) {
      if (it.rarity <= cap) {
        addResult(out.gained, G.salvageResult(it));
        out.byRarity[it.rarity]++;
        out.n++;
      } else {
        keep.push(it);
      }
    }
    if (!out.n) return null;
    save.bag = keep;
    for (const id in out.gained) grantCurrency(id, out.gained[id]);
    commit();
    return out;
  };

  G.bindSkill = function (slot, skillId) {
    const save = G.save;
    if (!(slot >= 0 && slot < 4) || slot !== Math.floor(slot)) return false;
    if (slot === 1) return false; // 右键固定是武器普攻：什么也绑不上
    if (!skillId) {
      save.bar[slot] = null;
      return commit();
    }
    if (!save.skills[skillId]) return false;
    // 一个技能只占一格：如果它原来在别的格子，就和目标格互换
    const from = save.bar.indexOf(skillId);
    if (from === slot) return true;
    if (from >= 0) save.bar[from] = save.bar[slot];
    if (save.rmbKeep === skillId) save.rmbKeep = null; // 收着的技能被你绑到了技能栏上：不再算收着
    save.bar[slot] = skillId;
    if (P.cast && (P.cast.slot === slot || P.cast.slot === from) && !P.cast.fired) P.cast = null;
    return commit();
  };

  G.socketSupport = function (skillId, idx, supId) {
    const save = G.save;
    // 武器普攻卡（G.BASIC_CARD）不是学会的技能，但一样有 3 个孔
    if ((skillId !== G.BASIC_CARD && !save.skills[skillId]) || !(idx >= 0 && idx < 3) || idx !== Math.floor(idx)) return false;
    let arr = save.sockets[skillId];
    if (!Array.isArray(arr)) arr = save.sockets[skillId] = [null, null, null];
    while (arr.length < 3) arr.push(null);
    if (!supId) {
      arr[idx] = null;
      return commit();
    }
    if (save.supports.indexOf(supId) < 0 || !G.supportFits(skillId, supId)) return false;
    // 一颗辅助宝石全局只能镶在一个孔里：先从别处取下
    for (const k of Object.keys(save.sockets)) {
      const a = save.sockets[k];
      if (!Array.isArray(a)) continue;
      for (let i = 0; i < a.length; i++) if (a[i] === supId) a[i] = null;
    }
    arr[idx] = supId;
    return commit();
  };

  G.allocPassive = function (id) {
    const save = G.save;
    const node = G.TREE[id];
    if (!node || save.passives.indexOf(id) >= 0) return false;
    if (G.passivePoints().free <= 0) return false;
    if (!node.links.some((l) => save.passives.indexOf(l) >= 0)) return false;
    save.passives.push(id);
    return commit();
  };

  G.refundPassive = function (id) {
    const save = G.save;
    if (id === 'start' || save.passives.indexOf(id) < 0) return false;
    const rest = save.passives.filter((p) => p !== id);
    if (reachable(rest).size !== rest.length) return false; // 提示由天赋页自己显示
    save.passives = rest;
    return commit();
  };

  G.resetPassives = function () {
    G.save.passives = ['start'];
    return commit();
  };

  // =====================================================================
  // 区域
  // =====================================================================
  G.enterZone = function (idx, tier) {
    P.graceT = 0;
    resetAction(); // 顿帧 / 慢动作 / 处决 / 缓冲的输入都不带进下一个区域
    const W = G.world;
    const save = G.save;
    idx = toInt(idx, 0, G.ZONES.length - 1, 0);
    tier = toInt(tier, 0, 999, 0);
    const def = G.ZONES[idx];

    // 清掉上一个区域的所有运行时实体
    G.clearEnemies();
    clearProjectiles();
    clearTelegraphs();
    for (const l of state.loot) W.removeMesh(l.mesh);
    state.loot.length = 0;
    state.timers.length = 0;
    if (state.portal) W.removeMesh(state.portal.mesh);
    state.portal = null;
    state.boss = null;

    const level = def.level + tier * G.TIER_LEVELS;
    state.zone = W.buildZone(def, level);
    state.zoneIdx = idx;
    state.tier = tier;
    G.spawnZoneMobs(state.zone);

    G.computeStats();
    P.dead = false;
    P.deadT = 0;
    P.cds = {};
    P.roll.cd = 0;
    P.iframe = 0.6;
    P.face = Math.PI; // 朝屏幕上方（世界 −z）
    P.ent.group.visible = true;
    placePlayer(state.zone.start.x, state.zone.start.z);
    refill();
    resetRanged();
    state.focus = null;
    state.focusT = 0;
    if (G.regroupMinions) G.regroupMinions(); // 召唤物跟着进入新区域，在入口处重新现身
    G.autoSummonDelay(); // 数量没变，不会重复召唤；缺的等它们现身之后再补
    if (W.precompile) W.precompile(); // 第一次进这个区：着色器 / 贴图在进区时就准备好，不留到第一场仗（zones-integrate）

    save.lastZone = idx;
    save.tier = tier;
    G.persist();
    toast(def.name + (tier > 0 ? ' · 轮回 ' + tier : '') + '　怪物等级 ' + level, '#ffb46a');
    return state.zone;
  };
})();
