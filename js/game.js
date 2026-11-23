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

  // 带节流的提示，避免同一条消息刷屏。只动界面（G.ui.toast 不取随机数、不改游戏状态），所以按真实时间节流：
  // 面板开着（游戏时间不走）时点「分解」「拾取」之类的提示照样能再出来
  const toastAt = {};
  function toast(msg, color, key, gapMs) {
    if (key) {
      const now = Date.now();
      if (now - (toastAt[key] || 0) < (gapMs || 1500)) return;
      toastAt[key] = now;
    }
    G.ui.toast(msg, color);
  }
  // 场景里的飘字提示（没有目标、魔力不足……）按游戏时间节流：飘字要取随机数，节流若看真实时间，
  // 帧快帧慢会让同一个种子打出不同的随机序列。暂停 / 面板开着时游戏时间不走，节流也跟着停
  const hintAt = {};
  function hintDue(key, gap) {
    const t = state.time;
    if (key in hintAt && t - hintAt[key] < gap && t >= hintAt[key]) return false;
    hintAt[key] = t;
    return true;
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
    if (G.save && G.save.opts && G.save.opts.hitStop === false) return; // 设置里关了顿帧（测伤害的用例也用它关）
    flow.stop = Math.min(0.16, Math.max(flow.stop, ms / 1000));
  };
  // 法术的顿帧（vf-vfx2）：只给重的法术命中（陨火落地、重击档的法术暴击），法术来源每 0.3 秒最多一次；顿了返回 true
  let spellStopAt = -9;
  G.spellStop = function (ms) {
    const t = G.state ? G.state.time : 0;
    if (Math.abs(t - spellStopAt) < 0.3) return false;
    spellStopAt = t;
    G.hitStop(ms);
    return true;
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
      twinMig: false, // 读档时把旧双生坠升成了四行、「双生坠升级」提示还没看过（见 migrateTwin）
      bowMig: false, // 读档时把旧长弓改成了鹰眼长弓、「远程改版」提示还没看过（见 sanitize）
      xzMig: false, // 读档时把旧熄烛冠原地升级了、提示还没看过（见 migrateXizhu）
      passives: ['start'], cleared: {}, bossKills: {},
      tier: 0, maxTier: 0, lastZone: 0,
      // 选项：自动拾取普通物品 / 折叠普通物品的名牌 / 拾取时自动分解普通物品 / 一键分解是否包含魔法物品 / 是否包含稀有物品
      // salvageRare 开着时魔法物品也一起分解（界面上「含魔法」显示为勾上且不能点），salvageMagic 本身不改，关掉「含稀有」就回到原来的状态
      // quality：画质档位 high / mid / low（世界层读取，见 G.world.setQuality）；auto = 玩家还没选过，每次启动按设备推断，掉帧时自动降档
      // hitFlash / hitStop / shake：打击手感的三个开关（受击闪光、顿帧、镜头震动），默认都开（vf-vfx2）
      opts: { autoWhite: false, hideNormal: false, autoSalvage: false, salvageMagic: false, salvageRare: false, quality: 'auto', hitFlash: true, hitStop: true, shake: true, ambience: true,
        volMaster: 80, volSfx: 80, volAmb: 60, volMusic: 50, mute: false }, // 音量（0–100，见 js/audio.js 的 G.audio.DEFAULTS）和静音
      seenHelp: false,
      seenStory: false, // 开场故事放过（或跳过）了；只有新角色（seenHelp 为假）才会放，老存档没有这一项也不会看到
      tut: {}, // 已经看过的新手提示：{ 提示 id: 1 }（界面层维护）
      blankGems: [], // 手里的无铭技能宝石：每颗的等级，从高到低排
      autoSummon: autoSummonDefaults(), // 召唤技能的「自动召唤」开关：{ 技能 id: true / false }，默认关
      // 烬铸图鉴：found 拾到过的烬铸武器 { id: true }，best 见过的最高完美度 { id: 0..100 }，
      // pity 各首领（层级 1 起）连续多少次没掉它的武器 { 首领: 次数 }
      uniq: { found: {}, best: {}, pity: {} },
      // 渊契图鉴：格式同 uniq；pity 按保底的键计（首领 / 异兆来源按渊契 id，烈印来源按 'seal'）
      relic: { found: {}, best: {}, pity: {} },
      // 刻式：variants 选了的刻式 { 技能 id: 'a' | 'b' }（没有的就是原式）；variantFree 已经用过免费那一次的技能 { 技能 id: true }；
      // variantGen 刻式的版本（G.VARIANT_GEN）；varNote 读档时刻式重做过、「刻式重做」提示还没看过（见 sanitize）
      variants: {}, variantFree: {}, variantGen: G.VARIANT_GEN, varNote: false,
      // 渊式（第三种刻式 'c'，戴着对应的渊契才生效）：variantPrev 选渊式时替下的那种 { 技能 id: 'a' | 'b' }（没有 = 原式），摘下渊契就退回它；
      // rqAuto 已经自动选过一次渊式的技能（第一次戴上渊契时替你选上，之后不再自动改）；rqVar 读档迁移过的标记；rqNote「渊式」提示还没看过
      variantPrev: {}, rqAuto: {}, rqVar: 1, rqNote: false,
      wsCap: 1, wsNote: false, // 旋涡斩加「每下最多 9 个」之后的存档；wsNote：选着旋涡斩的老存档，提示还没看过
      bhCap: 1, bhNote: false, // 黑洞加「每跳最多伤到最近的 N 个」之后的存档；bhNote：学了黑洞的老存档，提示还没看过
      stFz: 1, stNote: false, // 魂潮狂热改成 12 秒 +15%（dur-tune）之后的存档；stNote：拿着魂幡（R 是魂潮）的老存档，提示还没看过
      // 渊印：sealSeq 真正进区的次数（择印面板的随机种子，关掉地图再打开还是同样三枚）；
      // run 这一次进区 { zone, tier, seq, seal }（seal 为 null 是素印），读档时区域 / 层级对得上就接着用，倒下重生不动，换区 / 重进清掉
      sealSeq: 0, run: null,
      // 烛芯（异兆一期）：各种类的个数（熄烛者的开启材料）
      frags: { seal: 0, rift: 0, vow: 0, box: 0 },
      // 熄烛者（D5）：击杀次数、巅峰渊契的保底计数（连续几次没掉）。正在打的那一次挂在 run.pin = { tier, lives }
      pinnacle: { kills: 0, pity: 0 },
      // 主线（quest D1）：n 已完成的步数 0–G.QUEST_N（步骤按顺序，奖励按 n 只给一次）；off 地图页关掉了「显示主线」（D2 才有开关）；
      // told 已经放过的首领旁白 { 步骤 id: true }（D3 用，见 G.questTell）
      quest: { n: 0, off: false, told: {} },
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
    if (G.audio) G.audio.apply(); // 音量设置跟着存档走（audio.js 在 game.js 之后才载入，启动时由它自己读）
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
    // 锁定（lk: 1）：只认 1，别的值一律去掉（老存档没有这一项 = 没锁）
    if (it.lk === 1 || it.lk === true) it.lk = 1;
    else delete it.lk;
    if (it.rarity === 3) fixUnique(it);
    if (it.rarity === 4 && it.rq === 'xizhu') migrateXizhu(it);
    if (it.rarity === 4 && it.rq === 'shuangsheng') migrateTwin(it);
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

  // 熄烛冠巅峰改版（rqv 2）之前的旧物品：在 fixRelic 之前原地升级。旧的第 i 行按它在旧区间里的分位，换算到新的第 i 行区间的同一位置
  // （冰霜抗性 → 生命回复）；新加的行（暗域增伤）按物品 uid 推出一个固定的分位（同一件物品每次读档结果一样）。
  // 旧的词缀行和区间按改版前的定义（只在这里记一份）
  const XIZHU_OLD = [{ id: 'life', k: [1.2, 1.6] }, { id: 'crit', k: [1.2, 1.6] }, { id: 'resCold', k: [1.0, 1.3] }];
  function uidQ(uid, salt) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < uid.length; i++) h = Math.imul(h ^ uid.charCodeAt(i), 16777619);
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  }
  G.uidQ = uidQ;
  function migrateXizhu(it) {
    if (it.rqv >= 2) return false;
    const R = G.RELICS.xizhu;
    const ilvl = G.clamp(Math.round(it.ilvl), 1, 999);
    const tier = G.clamp(G.TIER_ILVL.filter((l) => l <= ilvl).length - 1, 0, G.TIER_ILVL.length - 1);
    const out = R.lines.map((ln, i) => {
      const r = G.relicLineRange('xizhu', ilvl, i);
      const o = XIZHU_OLD[i];
      const old = o && it.affixes.find((a) => a.id === o.id);
      let q;
      if (old) {
        const t = G.affixRange(G.AFFIX_BY_ID[o.id], tier);
        const lo = Math.max(1, Math.round(t[0] * o.k[0])), hi = Math.max(lo, Math.round(t[1] * o.k[1]));
        q = hi > lo ? G.clamp((old.v - lo) / (hi - lo), 0, 1) : 1;
      } else q = uidQ(it.uid, i + 1);
      return { id: ln.id, tier, v: Math.round(r[0] + (r[1] - r[0]) * q) };
    });
    it.affixes = out;
    it.rqv = 2;
    G.xizhuMigrated = (G.xizhuMigrated || 0) + 1; // 界面层据此提示一次「熄烛冠升级了」
    return true;
  }
  G.migrateXizhu = migrateXizhu; // 测试用

  // 双生坠升级（twin-rework）：旧版只有两行（伤害提高 k 1.0–1.4、攻击与施法速度 k 1.0–1.3）。
  // 原有两行保留在旧区间里的位置（百分位），换算到新区间；新加的行按物品 uid 定一个位置（同一件每次读档结果一样）。
  // 已经是新版（有「双生」那一行）的不动；升过的记 it.rqv = 2。G.twinMigrated 给界面层提示一次
  const TWIN_OLD_K = { incAll: [1.0, 1.4], speed: [1.0, 1.3] };
  function twinSeed(uid, i) {
    const str = String(uid) + ':' + i;
    let h = 2166136261;
    for (let j = 0; j < str.length; j++) h = Math.imul(h ^ str.charCodeAt(j), 16777619);
    return ((h >>> 0) % 10007) / 10006;
  }
  function migrateTwin(it) {
    const R = G.RELICS.shuangsheng;
    if (it.rqv >= 2 || !Array.isArray(it.affixes) || it.affixes.some((a) => a.id === 'uAllMore')) return;
    const ilvl = G.clamp(Math.round(it.ilvl) || 1, 1, 999);
    const tier = G.clamp(G.TIER_ILVL.filter((l) => l <= ilvl).length - 1, 0, G.TIER_ILVL.length - 1);
    it.affixes = R.lines.map((ln, i) => {
      const r = G.relicLineRange('shuangsheng', ilvl, i);
      const old = it.affixes.find((a) => a.id === ln.id);
      const ok = old && TWIN_OLD_K[ln.id];
      let q;
      if (ok) {
        const b = G.affixRange(G.AFFIX_BY_ID[ln.id], tier), lo = Math.max(1, Math.round(b[0] * ok[0])), hi = Math.max(lo, Math.round(b[1] * ok[1]));
        q = hi > lo ? G.clamp((old.v - lo) / (hi - lo), 0, 1) : 1;
      } else q = twinSeed(it.uid, i);
      return { id: ln.id, tier, v: Math.round(r[0] + (r[1] - r[0]) * q) };
    });
    it.rqv = 2;
    G.twinMigrated = (G.twinMigrated || 0) + 1;
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
    G.twinMigrated = 0;
    G.bowMigrated = 0;
    G.xizhuMigrated = 0; // 熄烛冠巅峰改版：读档时原地升级了几件（见 migrateXizhu）
    G.variantRedone = 0; // 刻式第二版：读档时把旧刻式的免费那一次还了回去，界面层提示一次（见下面「刻式」）
    G.rmbMigrated = null; // 武器普攻改版：右键上的技能挪去了哪（见下面「右键固定是武器普攻」）
    G.cleaveRefund = null; // 裂石击退成的无铭宝石
    G.sockDropped = []; // 读档时取下的辅助（技能的哪种刻式都用不上了）：{ sup, id }
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
        if (sup && s.supports.indexOf(sup) >= 0 && !used.has(sup) && G.supportFitsAny(id, sup)) {
          arr[i] = sup;
          used.add(sup);
        } else if (sup && s.supports.indexOf(sup) >= 0 && !used.has(sup) && G.SKILLS[id]) G.sockDropped.push({ sup, id }); // 哪种刻式都用不上了：取下放回宝石栏（宝石还在），界面层提示一次
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
      salvageRare: !!ro.salvageRare, // 一键分解含稀有：老存档没有 = 关
      quality: G.QUALITY_IDS.indexOf(ro.quality) >= 0 ? ro.quality : 'auto',
      hitFlash: ro.hitFlash !== false, hitStop: ro.hitStop !== false, shake: ro.shake !== false, // 老存档没有这三项：按默认开
      ambience: ro.ambience !== false, // vf-vfx3：环境特效（区域氛围），老存档没有 = 开
      // sfx-synth：音量 0–100 和静音。老存档没有：音效按改版前的响度（总音量 / 音效 80），环境音 60、音乐 50
      volMaster: toInt(ro.volMaster, 0, 100, 80), volSfx: toInt(ro.volSfx, 0, 100, 80),
      volAmb: toInt(ro.volAmb, 0, 100, 60), volMusic: toInt(ro.volMusic, 0, 100, 50), mute: !!ro.mute,
    };
    s.seenHelp = !!raw.seenHelp;
    s.seenStory = !!raw.seenStory;
    s.tut = {};
    if (isObj(raw.tut)) {
      for (const k of Object.keys(raw.tut).slice(0, 64)) {
        if (raw.tut[k] && /^[a-z][a-z0-9_]{0,23}$/i.test(k)) s.tut[k] = 1;
      }
    }
    // 双生坠升级同长弓改名：记一笔 twinMig，直到「双生坠升级」提示看过（tut.sxmig）才清掉
    s.twinMig = G.twinMigrated > 0 || (raw.twinMig === true && !s.tut.sxmig);
    if (s.twinMig) G.twinMigrated = Math.max(1, G.twinMigrated);
    // 长弓改名只在第一次读档时发生（改完的名字随即存回去）：存档里记一笔 bowMig，直到「远程改版」提示看过（tut.bowmig）才清掉，
    // 不让第一次会话在提示弹出前就结束的玩家永远看不到它
    s.bowMig = G.bowMigrated > 0 || (raw.bowMig === true && !s.tut.bowmig);
    if (s.bowMig) G.bowMigrated = Math.max(1, G.bowMigrated);
    // 熄烛冠巅峰改版：同上，记一笔 xzMig，直到提示看过（tut.xzmig）
    s.xzMig = G.xizhuMigrated > 0 || (raw.xzMig === true && !s.tut.xzmig);
    if (s.xzMig) G.xizhuMigrated = Math.max(1, G.xizhuMigrated);
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
    // 刻式：只认 G.VARIANTS 里的技能和 a / b（宝石还没到解锁等级的照样保留，到了才生效）；选过刻式的技能免费那一次算用过了。
    // 第二版之前的存档（没有 variantGen 或比 G.VARIANT_GEN 小）：A / B 的意思整个变了——选择按位置留着（a 还是 a、b 还是 b），
    // 但每个技能的免费那一次都还给玩家；有到解锁等级的宝石或选过刻式的，提示一次「刻式重做」（varNote，看过 tut.variant2 才清掉）
    const rv = isObj(raw.variants) ? raw.variants : {};
    const rvf = isObj(raw.variantFree) ? raw.variantFree : {};
    const oldGen = !(isNum(raw.variantGen) && raw.variantGen >= G.VARIANT_GEN);
    for (const id of Object.keys(G.VARIANTS)) {
      if (rv[id] === 'a' || rv[id] === 'b' || (rv[id] === 'c' && G.VARIANTS[id].c)) s.variants[id] = rv[id];
      if (!oldGen && (rvf[id] === true || (s.variants[id] && s.variants[id] !== 'c'))) s.variantFree[id] = true;
    }
    // 渊式：替下的那种只认 a / b（而且只在选着渊式时留着）；rqAuto 只认有渊式的技能。
    // 渊式之前的存档（没有 rqVar）：身上戴着的这六件渊契原来直接改技能打法——迁移成选上它的渊式，原来的 A / B 记成替下的那种，提示一次（rqNote）
    const rvp = isObj(raw.variantPrev) ? raw.variantPrev : {}, rqa = isObj(raw.rqAuto) ? raw.rqAuto : {};
    let rqMoved = false;
    for (const rq of Object.keys(G.VARIANT_RELIC)) {
      const id = G.VARIANT_RELIC[rq];
      if (s.variants[id] === 'c' && (rvp[id] === 'a' || rvp[id] === 'b')) s.variantPrev[id] = rvp[id];
      if (rqa[id] === true) s.rqAuto[id] = true;
      const it = s.equip[G.RELICS[rq].slot];
      if (raw.rqVar === undefined && it && it.rarity === 4 && it.rq === rq) {
        if (s.variants[id] === 'a' || s.variants[id] === 'b') s.variantPrev[id] = s.variants[id];
        s.variants[id] = 'c';
        s.rqAuto[id] = true;
        rqMoved = true;
      }
    }
    s.rqVar = 1;
    s.rqNote = !s.tut.rqvar && (rqMoved || raw.rqNote === true);
    G.rqMigrated = s.rqNote ? 1 : 0;
    // 旋涡斩加「每下最多绞到最近的 9 个」之前的存档（没有 wsCap）：选着旋涡斩的提示一次（tut.wsnerf 看过就不再提示）
    s.wsNote = !s.tut.wsnerf && ((raw.wsCap === undefined && s.variants.whirl === 'b') || raw.wsNote === true);
    s.wsCap = 1;
    G.whirlNerfed = s.wsNote ? 1 : 0;
    // 黑洞加「每跳最多伤到最近的 N 个」之前的存档（没有 bhCap）：学了黑洞的（哪种刻式都算）提示一次（tut.bhnerf 看过就不再提示）
    s.bhNote = !s.tut.bhnerf && ((raw.bhCap === undefined && s.skills.blackhole > 0) || raw.bhNote === true);
    s.bhCap = 1;
    G.holeNerfed = s.bhNote ? 1 : 0;
    // 魂潮狂热 4 秒 +30% → 12 秒 +15%（dur-tune）之前的存档（没有 stFz）：手里的武器技是魂潮的提示一次（tut.stfz 看过就不再提示）
    s.stNote = !s.tut.stfz && ((raw.stFz === undefined && G.weaponSkillOf(s.equip && s.equip.weapon) === 'soultide') || raw.stNote === true);
    s.stFz = 1;
    G.frenzyNerfed = s.stNote ? 1 : 0;
    s.variantGen = G.VARIANT_GEN;
    const hadVar = Object.keys(s.variants).length > 0 || Object.keys(G.VARIANTS).some((id) => s.skills[id] >= G.VARIANT_LVL);
    s.varNote = !s.tut.variant2 && ((oldGen && hadVar) || raw.varNote === true);
    G.variantRedone = s.varNote ? 1 : 0;
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
    // 渊印：旧存档没有这两项（sealSeq 0、run null）。run 的区域 / 层级要对得上存档的 lastZone / tier，印纹只认表里的 id，W 按表重算
    s.sealSeq = toInt(raw.sealSeq, 0, 1e9, 0);
    const rrun = isObj(raw.run) ? raw.run : null;
    if (rrun && rrun.zone === s.lastZone && rrun.tier === s.tier) {
      s.run = { zone: s.lastZone, tier: s.tier, seq: toInt(rrun.seq, 0, 1e9, 0), seal: G.cleanSeal(rrun.seal, s.tier, s.bar) };
      // 余烛殿（D5）：正在打的那一次。层级要在 minTier..maxTier 里，魂灯 1..G.PIN_LIVES；不合法就丢掉（读档回到那一区）
      const rp = isObj(rrun.pin) ? rrun.pin : null;
      if (rp && Number.isInteger(rp.tier) && rp.tier >= G.PIN.minTier && rp.tier <= s.maxTier && Number.isInteger(rp.lives) && rp.lives >= 1 && rp.lives <= G.PIN_LIVES) {
        s.run.seal = null;
        s.run.pin = { tier: rp.tier, lives: rp.lives };
      }
    }
    // 熄烛者：击杀次数、巅峰渊契保底（旧存档没有 → 0）
    const rpk = isObj(raw.pinnacle) ? raw.pinnacle : {};
    s.pinnacle = { kills: toInt(rpk.kills, 0, 1e6, 0), pity: toInt(rpk.pity, 0, G.RELIC_DROP.pinnacle.pity, 0) };
    // 长明（class-d2b1）的保底计数：只在不为 0 时才有这个字段（没打过熄烛者 / 刚掉过的存档和以前一字不差，旧版本读到也不认识、照常丢掉）
    const lp = toInt(raw.lampPity, 0, G.RELIGHT.pity, 0);
    if (lp > 0) s.lampPity = lp;
    // 烛芯：旧存档没有（全 0）；只认 G.FRAGS 的种类，个数 0–max。旧存档的保底计数 fragPity 不再读，也不再存
    const rfr = isObj(raw.frags) ? raw.frags : {};
    s.frags = {};
    for (const id of G.FRAG_IDS) s.frags[id] = toInt(rfr[id], 0, G.FRAG_DROP.max, 0);
    // 主线：老存档没有这一项（或被老代码读档再存时丢掉了）→ 从现有进度推算，取两者大的（只增不减）。推算出来的步骤不补发奖励
    const rq = isObj(raw.quest) ? raw.quest : {};
    s.quest = { n: Math.max(toInt(rq.n, 0, G.QUEST_N, 0), questDerive(s)), off: rq.off === true, told: {} };
    if (isObj(rq.told)) for (const q of G.QUEST) if (rq.told[q.id] === true) s.quest.told[q.id] = true;
    // 职业（class-d2）：只有认识的职业才读，没有职业的存档一个新键都不加（JSON 和职业之前一字不差）
    if (typeof raw.cls === 'string' && G.CLASSES[raw.cls]) sanitizeClass(s, raw);
    return s;
  }
  function sanitizeClass(s, raw) {
    const cls = raw.cls, C = G.CLASSES[cls];
    s.cls = cls;
    if (raw.clsRe === true) s.clsRe = true;
    // 锁定：按职业重算（已学、用不了的）。学会的技能不会因此消失，改选到能用它的职业就解开
    s.clsLock = {};
    for (const id of Object.keys(s.skills)) if (!G.classCanUse(cls, id)) s.clsLock[id] = 1;
    // 起步天赋：本职业那个一定在（和起点相邻，总连得上）；改选时留下的旧的那个只认还点着的
    const rf = Array.isArray(raw.clsFree) ? raw.clsFree : [];
    s.clsFree = [C.node.id];
    for (const id of rf) if (G.TREE[id] && id !== C.node.id && s.passives.indexOf(id) >= 0 && s.clsFree.length < 2) s.clsFree.push(id);
    if (s.passives.indexOf(C.node.id) < 0) s.passives.push(C.node.id);
    // 手改过的存档身上挂着别的职业的武器：背包有空就卸进去（不删）
    const w = s.equip.weapon;
    if (w && G.WTYPE_CLS[(G.BASES.weapon[w.baseIdx | 0] || {}).type] !== cls && s.bag.length < BAG_SIZE) {
      delete s.equip.weapon;
      s.bag.push(w);
    }
  }
  // 主线：存档能证明完成到第几步（设计稿 §5）。后面任何一步能证明完成，前面的都算完成。
  // 走到门口（gate）本身不留痕迹，只有荒原首领倒下才证明它；进区步看 cleared 或 lastZone（只能一区一区往下开）；
  // 进轮回层级看当前层级或任何区域在层级 ≥ 1 通关过
  function questDerive(s) {
    let n = 0;
    for (let k = 0; k < G.QUEST_N; k++) {
      const q = G.QUEST[k], c = q.zone ? s.cleared[q.zone] : undefined;
      let ok = false;
      if (q.kind === 'gate' || q.kind === 'boss') ok = c !== undefined;
      else if (q.kind === 'in') ok = c !== undefined || (s.lastZone | 0) >= G.ZONES.findIndex((z) => z.id === q.zone);
      else if (q.kind === 'tier') ok = (s.tier | 0) >= 1 || G.ZONES.some((z) => s.cleared[z.id] >= 1);
      if (ok) n = k + 1;
    }
    return n;
  }
  G.questDerive = (s) => questDerive(s || G.save);
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

  // =====================================================================
  // 角色栏位（多存档）
  // =====================================================================
  // 存储布局：
  //   cinder-abyss-save-v1            第 1 栏（原来的单存档，key 不变：退回旧代码时，旧代码读到的就是它）
  //   cinder-abyss-save-v1-s2 … -s6   第 2–6 栏，格式和第 1 栏完全一样（同一个 sanitize）
  //   cinder-abyss-save-v1-bak        第一次迁移前第 1 栏的原文，原样复制；只写这一次，以后永远不覆盖
  //   cinder-abyss-chars              索引 { v: 1, active, slots: [{ cls, level, zone, tier, pin, t, h } | null] }：只是摘要，丢了能按各栏重建。
  //                                   h = 新代码上次写进这一栏的原文的哈希：对不上就是别的代码（旧版本）写过这一栏，读档时以这一栏为准
  //   cinder-abyss-global             所有角色共用：设置 opts、新手提示 tut、开场卡片 helpSeen、图鉴（各角色拾到过 / 最高完美度的并集）
  //   cinder-abyss-trash              最近删掉的一个角色 { v: 1, slot, t, played, text }（text 是那一栏的原文），恢复后清空
  // 每一栏照旧存整份存档（opts / tut / 图鉴也在里面），所以旧代码读第 1 栏不缺东西。全局那份只是读档时盖上去（没被别的代码改过的栏位才盖），
  // 存档时再从当前角色取回来。图鉴的保底和「拾到过」（巅峰掉落挑没拾到过的）仍然按角色算，全局图鉴只用来显示。
  // 栏位之间搬东西（回收位、恢复、备份）一律搬原文，不经 sanitize：不认识的字段（以后的 cls、quest……）原样跟着走。
  const SLOT_N = (G.SLOT_N = 6);
  const CHARS_KEY = 'cinder-abyss-chars';
  const GLOBAL_KEY = 'cinder-abyss-global';
  const TRASH_KEY = 'cinder-abyss-trash';
  const BAK_KEY = SAVE_KEY + '-bak';
  const slotKey = (G.slotKey = (i) => (i === 0 ? SAVE_KEY : SAVE_KEY + '-s' + (i + 1)));
  G.SAVE_KEYS = { save: SAVE_KEY, chars: CHARS_KEY, global: GLOBAL_KEY, trash: TRASH_KEY, bak: BAK_KEY };
  const slot = {
    cur: 0, // 这份存档写回哪一栏（下标 0–5）
    hash: null, // 当前这一栏上次读到 / 写进去的原文的哈希（null = 这个角色还没存过）
    legacy: false, // 迁移没做成（备份写不进去）：照旧只用第 1 栏，不写索引和全局，下次启动再试
    stale: false, // 另一个标签页写了这一栏 / 换了角色：这边不再写，等刷新
    dead: false, // 当前角色刚被删掉（或被恢复的角色顶替）：不再写回，马上重载
    failed: false, // 上一次写存档没写进去（提示条亮着）
  };
  let glob = null; // 内存里的全局那份（legacy / 存储不可用时为 null）
  let globTxt = null; // 上次写进去的全局原文：没变就不再写
  const lsGet = (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch (err) {
      return null;
    }
  };
  const lsSet = (k, v) => {
    try {
      window.localStorage.setItem(k, v);
      return true;
    } catch (err) {
      return false;
    }
  };
  const lsDel = (k) => {
    try {
      window.localStorage.removeItem(k);
      return true;
    } catch (err) {
      return false;
    }
  };
  const readJson = (k) => {
    const t = lsGet(k);
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch (err) {
      return null;
    }
  };
  // 原文的指纹：FNV-1a + 长度（只用来判断「是不是我上次写的那份」）
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(36) + '.' + s.length;
  }
  const intIn = (v, lo, hi, def) => (isNum(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : def);
  // 卡片摘要：从存档对象里取（不跑 sanitize、不取随机数）。cls 是 D2 的职业字段，D1 里一直是 null（卡片显示「未定」）
  function summaryOf(r) {
    if (!isObj(r) || r.v !== 1) return { cls: null, level: 1, zone: 0, tier: 0, pin: false, bad: true };
    return {
      cls: typeof r.cls === 'string' ? r.cls : null,
      level: intIn(r.level, 1, MAX_LEVEL, 1),
      zone: intIn(r.lastZone, 0, G.ZONES.length - 1, 0),
      tier: intIn(r.tier, 0, 999, 0),
      pin: !!(isObj(r.run) && r.run.pin),
    };
  }
  function summaryOfText(txt) {
    let r = null;
    try {
      r = JSON.parse(txt);
    } catch (err) {
      r = null;
    }
    return summaryOf(r);
  }
  function readIndex() {
    const r = readJson(CHARS_KEY);
    if (!isObj(r) || r.v !== 1 || !Array.isArray(r.slots)) return null;
    const slots = [];
    for (let i = 0; i < SLOT_N; i++) {
      const s = r.slots[i];
      slots.push(isObj(s) ? Object.assign(summaryOf(Object.assign({ v: 1 }, s, { lastZone: s.zone })), { t: isNum(s.t) ? s.t : 0, h: typeof s.h === 'string' ? s.h : null }) : null);
    }
    return { v: 1, active: intIn(r.active, 0, SLOT_N - 1, 0), slots };
  }
  // 按各栏实际的存档校正索引：有存档没记的补上摘要（h 记 null = 不是新代码写的），记着但存档没了的清掉；active 指着空栏时挪到第一个有存档的栏
  function syncIndex(idx) {
    const out = { v: 1, active: idx ? idx.active : 0, slots: [] };
    for (let i = 0; i < SLOT_N; i++) {
      const txt = lsGet(slotKey(i));
      const old = idx && idx.slots[i];
      if (!txt) out.slots.push(null);
      else if (old && old.h && old.h === hashStr(txt)) out.slots.push(old);
      else out.slots.push(Object.assign(summaryOfText(txt), { t: old ? old.t : 0, h: null }));
    }
    if (!out.slots[out.active]) {
      const f = out.slots.findIndex(Boolean);
      if (f >= 0) out.active = f;
    }
    return out;
  }
  const writeIndex = (idx) => lsSet(CHARS_KEY, JSON.stringify(idx));
  // 启动时进哪一栏：索引的 active；那一栏空了就是第一个有存档的栏
  function resolveActive(idx) {
    if (!idx) return 0;
    if (lsGet(slotKey(idx.active))) return idx.active;
    for (let i = 0; i < SLOT_N; i++) if (lsGet(slotKey(i))) return i;
    return idx.active;
  }
  // 图鉴：{ found: { id: true }, best: { id: 0..100 } }（不认识的 id 也留着，以后的版本认得）
  function cxOf(c) {
    const o = { found: {}, best: {} };
    if (!isObj(c)) return o;
    if (isObj(c.found)) for (const k of Object.keys(c.found)) if (c.found[k] === true) o.found[k] = true;
    if (isObj(c.best)) for (const k of Object.keys(c.best)) if (isNum(c.best[k])) o.best[k] = G.clamp(Math.round(c.best[k]), 0, 100);
    return o;
  }
  function cxMerge(...list) {
    const o = { found: {}, best: {} };
    for (const c of list) {
      if (!c) continue;
      for (const k of Object.keys(c.found || {})) if (c.found[k] === true) o.found[k] = true;
      for (const k of Object.keys(c.best || {})) if (isNum(c.best[k]) && !(o.best[k] >= c.best[k])) o.best[k] = c.best[k];
    }
    return o;
  }
  function readGlobal() {
    const r = readJson(GLOBAL_KEY);
    if (!isObj(r) || r.v !== 1) return null;
    const cx = isObj(r.codex) ? r.codex : {};
    return { v: 1, opts: isObj(r.opts) ? r.opts : null, tut: isObj(r.tut) ? r.tut : {}, helpSeen: r.helpSeen === true, codex: { uniq: cxOf(cx.uniq), relic: cxOf(cx.relic) } };
  }
  function writeGlobal() {
    const S = G.save;
    const g0 = readGlobal(); // 别的标签页可能写过：图鉴和 helpSeen 合并，不丢
    const cx = (k) => cxMerge(glob && glob.codex[k], g0 && g0.codex[k], S[k] && cxOf(S[k]));
    const g = { v: 1, opts: S.opts, tut: S.tut, helpSeen: !!((glob && glob.helpSeen) || (g0 && g0.helpSeen) || S.seenHelp), codex: { uniq: cx('uniq'), relic: cx('relic') } };
    const txt = JSON.stringify(g);
    glob = JSON.parse(txt);
    if (txt === globTxt) return true;
    if (!lsSet(GLOBAL_KEY, txt)) return false;
    globTxt = txt;
    return true;
  }
  // 图鉴显示用：全局的并集 + 当前角色（保底计数另外按角色读 save.uniq.pity / save.relic.pity）
  G.codexView = function () {
    const S = G.save || {};
    return { uniq: cxMerge(glob && glob.codex.uniq, S.uniq && cxOf(S.uniq)), relic: cxMerge(glob && glob.codex.relic, S.relic && cxOf(S.relic)) };
  };
  // 开场卡片（操作说明）在任何一个角色上看过没有：看过的话新角色只放开场故事、不再弹卡片
  G.helpSeenGlobal = () => !!(glob && glob.helpSeen);

  function saveFailed(why) {
    slot.failed = true;
    if (G.ui && G.ui.saveBar) G.ui.saveBar(why || 'fail');
    return false;
  }
  function saveOk() {
    if (!slot.failed) return;
    slot.failed = false;
    if (G.ui && G.ui.saveBar) G.ui.saveBar(null);
  }

  G.loadSave = function () {
    G.slotMigrated = false;
    slot.legacy = false;
    let idx = readIndex();
    const old = lsGet(SAVE_KEY);
    if (!idx) {
      let any = old !== null;
      for (let i = 1; i < SLOT_N && !any; i++) any = lsGet(slotKey(i)) !== null;
      if (any) {
        // 迁移（只加不改）：先把第 1 栏的原文原样写进备份（已经有备份就不动），再建索引。第 1 栏本身一个字节都不碰。
        // 备份或索引写不进去（满了 / 隐私模式）：不迁移，照旧按单存档跑第 1 栏，下次启动再试
        if (old !== null && lsGet(BAK_KEY) === null && !lsSet(BAK_KEY, old)) slot.legacy = true;
        if (!slot.legacy) {
          const built = syncIndex(null);
          if (writeIndex(built)) {
            idx = built;
            G.slotMigrated = true;
          } else slot.legacy = true;
        }
      }
    }
    const cur = slot.legacy ? 0 : resolveActive(idx);
    const txt = slot.legacy ? old : lsGet(slotKey(cur));
    slot.cur = cur;
    slot.hash = txt ? hashStr(txt) : null;
    slot.dead = false;
    let raw = null;
    try {
      if (txt) raw = JSON.parse(txt);
    } catch (err) {
      raw = null;
    }
    glob = null;
    globTxt = null;
    if (!slot.legacy && idx) {
      glob = readGlobal();
      globTxt = lsGet(GLOBAL_KEY);
      // 这一栏是新代码上次写的（哈希对得上）：盖上全局的设置和新手提示。别的代码（旧版本、手改）写过就以这一栏为准，存档时再写回全局
      const mine = isObj(raw) && !!idx.slots[cur] && idx.slots[cur].h === slot.hash;
      if (glob && mine) {
        raw = Object.assign({}, raw);
        if (glob.opts) raw.opts = glob.opts;
        raw.tut = Object.assign({}, isObj(raw.tut) ? raw.tut : {}, glob.tut);
      }
      if (!glob) glob = { v: 1, opts: null, tut: {}, helpSeen: false, codex: { uniq: cxOf(null), relic: cxOf(null) } };
      if (isObj(raw) && raw.seenHelp === true) glob.helpSeen = true;
    }
    setSave(sanitize(raw));
    // 共享仓库：同一个 uid 既在仓库又在这个角色身上（存放 / 取出中途崩了）时留仓库那份。没有仓库（测试、bench）时什么也不做
    G.stashDeduped = !slot.legacy ? G.stash.dedupe() : 0;
    return G.save;
  };

  // 当前栏位有没有存档（标题画面据此决定显示「继续游戏」）。main.js 在 loadSave 之前就会问，所以自己按索引找栏位
  G.hasSave = function () {
    try {
      if (slot.dead) return false;
      const idx = readIndex();
      return !!window.localStorage.getItem(slotKey(idx ? resolveActive(idx) : 0));
    } catch (err) {
      return false;
    }
  };

  G.persist = function () {
    if (slot.stale || slot.dead || !G.save) return false;
    const txt = JSON.stringify(G.save);
    if (!lsSet(slotKey(slot.cur), txt)) return saveFailed('fail');
    slot.hash = hashStr(txt);
    if (!slot.legacy) {
      let idx = readIndex();
      if (!idx) {
        idx = syncIndex(null); // 第一次存（或索引被清掉了）：按各栏重建
        idx.active = slot.cur;
      }
      idx.slots[slot.cur] = Object.assign(summaryOf(G.save), { t: Date.now(), h: slot.hash });
      if (!glob) glob = { v: 1, opts: null, tut: {}, helpSeen: false, codex: { uniq: cxOf(null), relic: cxOf(null) } };
      if (!writeIndex(idx) || !writeGlobal()) return saveFailed('fail');
    }
    saveOk();
    return true;
  };

  // 删除当前角色、换成一个新角色（地图页的「删除这个角色」走这里，确认两次之后）：原来那份先进回收位，回收位写不进去就什么都不删
  G.resetSave = function () {
    const txt = slot.dead ? null : lsGet(slotKey(slot.cur));
    if (txt && !slot.stale && !trashPut(slot.cur, txt)) {
      saveFailed('fail');
      return null;
    }
    slot.hash = null;
    setSave(G.newSave()); // 召唤物在 setSave 里一并散掉
    G.computeStats();
    G.persist();
    return G.save;
  };

  function readTrash() {
    const r = readJson(TRASH_KEY);
    if (!isObj(r) || r.v !== 1 || typeof r.text !== 'string' || !r.text) return null;
    return { slot: intIn(r.slot, 0, SLOT_N - 1, 0), t: isNum(r.t) ? r.t : 0, played: isNum(r.played) ? r.played : 0, text: r.text, sum: summaryOfText(r.text) };
  }
  function trashPut(k, txt) {
    const idx = readIndex();
    const played = idx && idx.slots[k] ? idx.slots[k].t : 0;
    return lsSet(TRASH_KEY, JSON.stringify({ v: 1, slot: k, t: Date.now(), played, text: txt }));
  }

  // 角色栏位的操作（标题画面的角色页用）。都直接读写存储，不经 G.persist；另一个标签页改过存档（stale）时一律不做
  G.slots = {
    N: SLOT_N,
    cur: () => slot.cur,
    legacy: () => slot.legacy,
    stale: () => slot.stale,
    // 当前加载的角色是不是 k 栏里存着的那个（继续玩就行，不用重载）
    loaded: (k) => k === slot.cur && !slot.dead && slot.hash !== null && lsGet(slotKey(k)) !== null && hashStr(lsGet(slotKey(k))) === slot.hash,
    // 卡片：[{ cls, level, zone, tier, pin, t } | null] × 6，按各栏实际的存档
    list() {
      const idx = syncIndex(readIndex());
      return { active: idx.active, slots: idx.slots };
    },
    trash() {
      const r = readTrash();
      return r ? { slot: r.slot, t: r.t, played: r.played, sum: r.sum } : null;
    },
    firstEmpty() {
      if (slot.legacy) return -1;
      for (let i = 0; i < SLOT_N; i++) if (!lsGet(slotKey(i))) return i;
      return -1;
    },
    // 在空栏 k 建一个新角色（现在的随机起手），设成 active。返回 true 后由界面重载页面进去
    create(k, cls) {
      if (slot.legacy || slot.stale || !(k >= 0 && k < SLOT_N) || lsGet(slotKey(k)) !== null) return false;
      const txt = JSON.stringify(G.newClassSave(cls)); // cls：选好的职业（class-d2）；不给就是职业之前的随机起手
      if (!lsSet(slotKey(k), txt)) return saveFailed('fail');
      const idx = syncIndex(readIndex());
      idx.slots[k] = Object.assign(summaryOfText(txt), { t: Date.now(), h: hashStr(txt) });
      idx.active = k;
      if (!writeIndex(idx)) return saveFailed('fail');
      return true;
    },
    // 换到 k 栏的角色：设成 active，由界面重载页面进去（重载保证上一个角色的召唤物、区域、计时器一点不剩）
    select(k) {
      if (slot.legacy || slot.stale || !lsGet(slotKey(k))) return false;
      const idx = syncIndex(readIndex());
      idx.active = k;
      return writeIndex(idx) || saveFailed('fail');
    },
    // 删除 k 栏（界面上已经确认过两次）：原文先进回收位（顶掉回收位里原来那个），再清这一栏。删的是当前角色时不再写回
    remove(k) {
      if (slot.legacy || slot.stale) return false;
      const txt = lsGet(slotKey(k));
      if (txt === null) return false;
      if (!trashPut(k, txt)) return saveFailed('fail');
      if (!lsDel(slotKey(k))) return false;
      if (k === slot.cur) slot.dead = true;
      const idx = syncIndex(readIndex());
      writeIndex(idx);
      return true;
    },
    // 恢复回收位里的角色：回原来那一栏，被占了就放第一个空栏；没有空栏返回 -1。恢复后清空回收位
    restore() {
      if (slot.legacy || slot.stale) return -1;
      const tr = readTrash();
      if (!tr) return -1;
      let k = lsGet(slotKey(tr.slot)) === null ? tr.slot : -1;
      if (k < 0) for (let i = 0; i < SLOT_N && k < 0; i++) if (lsGet(slotKey(i)) === null) k = i;
      if (k < 0) return -1;
      if (!lsSet(slotKey(k), tr.text)) {
        saveFailed('fail');
        return -1;
      }
      // 恢复进了当前（还没存过的新角色占着的）栏位：内存里那个不再写回，界面重载
      if (k === slot.cur) slot.dead = true;
      const idx = syncIndex(readIndex());
      idx.slots[k] = Object.assign(tr.sum, { t: tr.played, h: hashStr(tr.text) });
      writeIndex(idx);
      lsDel(TRASH_KEY);
      return k;
    },
    // 还没存过的新角色（标题画面上点「新游戏」/ 空栏的「新建角色」）就落在 k 栏
    claim(k) {
      if (slot.hash !== null || !(k >= 0 && k < SLOT_N) || lsGet(slotKey(k)) !== null) return false;
      slot.cur = k;
      return true;
    },
  };

  // 多开标签页：另一个标签页写了这一栏（或清了存储）、或者换了角色，这边就不再写，提示刷新（不覆盖它的进度）
  function activeOf(txt) {
    try {
      const r = JSON.parse(txt);
      return isObj(r) && isNum(r.active) ? r.active : null;
    } catch (err) {
      return null;
    }
  }
  window.addEventListener('storage', (e) => {
    if (slot.stale || slot.dead) return;
    try {
      if (e.storageArea && e.storageArea !== window.localStorage) return;
    } catch (err) {
      return;
    }
    let hit = e.key === null || e.key === slotKey(slot.cur);
    if (!hit && e.key === CHARS_KEY && !slot.legacy) hit = activeOf(e.oldValue) !== activeOf(e.newValue);
    if (!hit) return;
    slot.stale = true;
    if (G.ui && G.ui.saveBar) G.ui.saveBar('stale');
  });

  // =====================================================================
  // 职业（class-d2）
  // =====================================================================
  // 存档字段（全部只加不改；只有 save.cls 是认识的职业时才写进存档，没有职业的存档一个新键都不多）：
  //   cls      职业 id（G.CLASS_IDS）
  //   clsRe    老角色还有一次免费改选（新角色选定后不能改，没有这一项）
  //   clsLock  { 技能 id: 1 }：已学、但这个职业用不了的技能（还在已学列表和技能栏上，变灰，改选时按新职业重算）
  //   clsFree  [天赋 id]：白送的起步天赋（不花天赋点）。改选时旧的那个能摘就摘，摘不了又没有空余点数时两个都算白送
  // 没有职业（或不认识）时：G.clsDef() 为 null，下面每个钩子都原样放行，掉落权重、Math.random 的调用次数都和职业之前一样
  G.clsDef = () => (G.save && typeof G.save.cls === 'string' && G.CLASSES[G.save.cls]) || null;
  const wTypeOfItem = (w) => (w && w.slot === 'weapon' && G.BASES.weapon[w.baseIdx | 0] ? G.BASES.weapon[w.baseIdx | 0].type : null);
  G.wTypeOfItem = wTypeOfItem;
  // 这件物品是不是别的职业的武器（没有职业时永远不是）
  G.offClassItem = function (it, cls) {
    const c = cls === undefined ? G.save && G.save.cls : cls;
    if (!G.CLASSES[c] || !it || it.slot !== 'weapon') return false;
    return G.WTYPE_CLS[wTypeOfItem(it)] !== c;
  };
  // 技能为什么不能放：null = 能放。只在有职业时才检查
  G.castBlock = function (id) {
    const C = G.clsDef();
    if (!C || !G.SKILLS[id] || G.SKILLS[id].weaponOnly || G.SKILLS[id].basic) return null;
    const need = G.GEM_NEED[id] || null;
    if (!G.classCanUse(G.save.cls, id)) return { why: 'cls', text: C.name + '用不了：需要' + G.NEED_NAME[need] };
    if (!G.typeFitsNeed(wTypeOfItem(G.save.equip && G.save.equip.weapon), need)) return { why: 'weapon', text: '需要' + G.NEED_NAME[need] };
    return null;
  };
  G.canCast = (id) => !G.castBlock(id);
  // 能不能装上这件物品（只限制武器：别的职业的武器装不上）
  G.canEquip = (it) => !G.offClassItem(it);

  // 起步天赋：本职业白送的那个节点（名字按职业起）
  G.clsNodeOf = (id) => {
    const C = G.clsDef();
    return C && C.node.id === id && G.save.clsFree && G.save.clsFree.indexOf(id) >= 0 ? C.node : null;
  };
  G.clsFreeCount = function () {
    const S = G.save;
    if (!G.clsDef() || !Array.isArray(S.clsFree)) return 0;
    let n = 0;
    for (const id of S.clsFree) if (S.passives.indexOf(id) >= 0) n++;
    return n;
  };

  // 选职业时的推荐：装备着的武器所属职业 +3；技能栏上每个要武器的宝石，能用它的职业各 +1；同分按武器。
  // 手里没武器、技能栏上只有通用宝石时：召唤宝石偏掌灯人、掷焰 / 光环偏引星人（各 +0.5 / +0.25，只用来分先后），都没有就烬卫。
  // 返回 { cls, why（卡片上的推荐理由）, score }
  G.classRecommend = function (s) {
    const S = s || G.save;
    const score = {};
    for (const c of G.CLASS_IDS) score[c] = 0;
    const wt = wTypeOfItem(S.equip && S.equip.weapon);
    const wc = wt ? G.WTYPE_CLS[wt] : null;
    if (wc) score[wc] += 3;
    const bar = (S.bar || []).concat(S.rmbKeep ? [S.rmbKeep] : []).filter((id) => id && G.SKILLS[id] && S.skills && S.skills[id]);
    const bound = [];
    for (const id of bar) {
      if (G.GEM_NEED[id]) {
        bound.push(id);
        for (const c of G.CLASS_IDS) if (G.classCanUse(c, id)) score[c] += 1;
      } else if (G.SKILLS[id].kind === 'summon') score.lamp += 0.5;
      else score.star += 0.25;
    }
    let best = G.CLASS_IDS[0], bs = -1;
    for (const c of G.CLASS_IDS) {
      const v = score[c] + (c === wc ? 0.01 : 0); // 同分按武器
      if (v > bs) {
        bs = v;
        best = c;
      }
    }
    const wName = wt ? G.wTypeLabel(wt) : null;
    const gems = bar.filter((id) => G.classCanUse(best, id) && (G.GEM_NEED[id] || (best === 'lamp' && G.SKILLS[id].kind === 'summon') || best === 'star')).map((id) => G.SKILLS[id].name);
    let why;
    if (bs <= 0) why = '手里没有武器，技能栏上也没有要武器的技能：先从烬卫开始，刃最好上手';
    else if (wc === best && gems.length) why = '你现在用的是' + wName + '和' + gems.slice(0, 2).join('、');
    else if (wc === best) why = '你现在用的是' + wName;
    else if (gems.length) why = '你技能栏上的' + gems.slice(0, 3).join('、') + (wName ? '（手里的' + wName + '归' + G.CLASSES[wc].name + '）' : '') + '都归这个职业';
    else why = '最贴近你现在的打法';
    return { cls: best, why, score };
  };

  // 新角色的起手（存档对象 S 上原地改）：该类型 1 级普通、平均成色的武器（不像职业之前那样折成 1 级刃的秒伤，D3 的开局 bench 再定），
  // 只学起手技能、放在左键
  function classKit(S, cls) {
    const C = G.CLASSES[cls];
    const bi = G.BASES.weapon.findIndex((b) => b.type === C.start.type);
    const w = G.rollItem(1, 0, 'weapon', bi);
    w.wbase = G.weaponBaseDmg(bi, 1);
    G.refreshWeapon(w);
    S.equip = { weapon: w };
    const sk = C.start.skill;
    S.skills = { [sk]: 1 };
    S.sockets = { [sk]: [null, null, null], [G.BASIC_CARD]: [null, null, null] };
    S.bar = [sk, null, null, null];
    S.rmbKeep = null;
    S.cls = cls;
    S.clsLock = {};
    S.clsFree = [C.node.id];
    if (S.passives.indexOf(C.node.id) < 0) S.passives.push(C.node.id);
    return S;
  }
  G.newClassSave = (cls) => (G.CLASSES[cls] ? classKit(G.newSave(), cls) : G.newSave());
  // 选职业 / 改选。mode：'new' 新角色（换上起手武器和起手技能）/ 'pick' 老角色第一次选 / 'repick' 老角色用掉那一次免费改选。
  // 老角色：已学的技能一个不删，用不了的记进 clsLock；装备着的别的职业的武器卸进背包，背包满了进共享仓库（都满了就留在身上，不删）；
  // 手里空了就从背包里挑一把本职业的（物品等级最高的）换上。返回 { ok, moved: [{ name, to: 'bag' | 'stash' | 'kept' }], equipped }
  G.applyClass = function (cls, mode) {
    const S = G.save;
    const C = G.CLASSES[cls];
    if (!C) return { ok: false };
    if (mode === 'repick' && !(S.cls && S.clsRe)) return { ok: false };
    if (mode === 'pick' && S.cls) return { ok: false };
    const out = { ok: true, moved: [], equipped: null };
    const prevNode = mode === 'repick' && G.clsDef() ? G.clsDef().node.id : null;
    const prevFree = Array.isArray(S.clsFree) ? S.clsFree.slice() : [];
    if (mode === 'new') classKit(S, cls);
    S.cls = cls;
    if (mode === 'pick') S.clsRe = true;
    else if (mode === 'repick') S.clsRe = false;
    else delete S.clsRe;
    // 锁定：已学、但这个职业用不了的技能
    S.clsLock = {};
    for (const id of Object.keys(S.skills)) if (!G.classCanUse(cls, id)) S.clsLock[id] = 1;
    // 起步天赋
    const node = C.node.id;
    if (S.passives.indexOf(node) < 0) S.passives.push(node);
    let free = [node];
    if (prevNode && prevNode !== node && S.passives.indexOf(prevNode) >= 0 && prevFree.indexOf(prevNode) >= 0) {
      const rest = S.passives.filter((p) => p !== prevNode);
      if (reachable(rest).size === rest.length) S.passives = rest; // 旧的起步天赋摘得掉：摘掉（它本来就是白送的）
      else {
        S.clsFree = free;
        if (G.passivePoints().free < 0) free = [node, prevNode]; // 摘不掉又没有空余点数：两个都算白送，点数不变负
      }
    }
    S.clsFree = free;
    // 别的职业的武器：卸下
    const w = S.equip && S.equip.weapon;
    if (w && G.offClassItem(w, cls)) {
      if (S.bag.length < BAG_SIZE) {
        delete S.equip.weapon;
        S.bag.push(w);
        out.moved.push({ name: w.name, to: 'bag' });
      } else if (G.stash.put(w, true)) {
        delete S.equip.weapon;
        out.moved.push({ name: w.name, to: 'stash' });
      } else out.moved.push({ name: w.name, to: 'kept' });
    }
    if (!S.equip.weapon) {
      let best = -1;
      S.bag.forEach((it, i) => {
        if (it.slot !== 'weapon' || G.offClassItem(it, cls)) return;
        const b = best >= 0 ? S.bag[best] : null;
        if (!b || it.ilvl > b.ilvl || (it.ilvl === b.ilvl && it.rarity > b.rarity)) best = i;
      });
      if (best >= 0) {
        const it = S.bag.splice(best, 1)[0];
        S.equip.weapon = it;
        out.equipped = it.name;
      }
    }
    G.computeStats();
    if (G.refreshMinions) G.refreshMinions();
    G.persist();
    return out;
  };
  // 老角色要不要先选职业：有存档（不是刚建、还没存过的新角色）、没有职业，而且不是测试环境（__skipTitle / ?play）
  G.needClassPick = function () {
    if (G.clsDef() || !G.save) return false;
    if (window.__skipTitle || /[?&]play\b/.test(location.search)) return false;
    return slot.hash !== null;
  };

  // ---------- 共享仓库（cinder-abyss-stash，所有角色共用）----------
  // { v: 1, items: [物品 × 最多 160] }，4 页 × 40 格。只放物品（通货、宝石不进）。
  // 存放和取出都先写「收的那一边」再写「给的那一边」：中途崩了最坏是两边各一份，不会丢；读档时同一个 uid 既在仓库又在角色身上的，
  // 只留仓库那份（G.stash.dedupe），崩溃不会变成复制的手段。另一个标签页让这边停写（stale）、角色刚删掉（dead）、存档层没迁移成（legacy）时一律不写
  const STASH_KEY = (G.SAVE_KEYS.stash = 'cinder-abyss-stash');
  const STASH_PAGE = 40, STASH_PAGES = 4, STASH_MAX = STASH_PAGE * STASH_PAGES;
  function stashRead() {
    const r = readJson(STASH_KEY);
    const items = [];
    if (isObj(r) && r.v === 1 && Array.isArray(r.items)) {
      const seen = new Set();
      for (const it of r.items) {
        if (items.length >= STASH_MAX) break;
        if (!isItem(it) || seen.has(it.uid)) continue;
        seen.add(it.uid);
        items.push(fixItem(it, Math.max(1, it.ilvl | 0), false));
      }
    }
    return items;
  }
  const stashWrite = (items) => lsSet(STASH_KEY, JSON.stringify({ v: 1, items }));
  const stashOk = () => !slot.stale && !slot.dead && !slot.legacy;
  G.stash = {
    PAGE: STASH_PAGE,
    PAGES: STASH_PAGES,
    MAX: STASH_MAX,
    ok: stashOk,
    list: () => stashRead(),
    // 背包里的一件放进仓库（raw：调用方自己处理角色那一边，比如选职业时卸下来的武器）
    put(item, raw) {
      if (!stashOk() || !item) return false;
      const items = stashRead();
      if (items.length >= STASH_MAX) return false;
      if (items.some((x) => x.uid === item.uid)) return false;
      const i = raw ? -1 : bagIndex(item);
      if (!raw && i < 0) return false;
      const it = raw ? item : G.save.bag[i];
      items.push(JSON.parse(JSON.stringify(it)));
      if (!stashWrite(items)) return saveFailed('fail');
      if (!raw) {
        G.save.bag.splice(i, 1);
        G.persist();
      }
      return true;
    },
    // 仓库里的一件（按 uid）取进背包
    take(uid) {
      if (!stashOk()) return false;
      const S = G.save;
      if (S.bag.length >= BAG_SIZE) return 'bag';
      const items = stashRead();
      const i = items.findIndex((x) => x.uid === uid);
      if (i < 0) return false;
      const it = items[i];
      if (it.rarity === 3) noteUnique(it);
      if (it.rarity === 4) noteRelic(it);
      S.bag.push(it);
      if (!G.persist()) {
        S.bag.pop();
        return false;
      }
      items.splice(i, 1);
      if (!stashWrite(items)) saveFailed('fail'); // 写不回仓库：两边各一份，下次读档按 uid 去重（留仓库那份）
      return true;
    },
    // 读档时：同一个 uid 既在仓库又在这个角色的背包 / 身上时，留仓库那份。返回去掉的件数
    dedupe() {
      const r = readJson(STASH_KEY);
      if (!isObj(r) || !Array.isArray(r.items) || !r.items.length) return 0;
      const ids = new Set(r.items.filter(isItem).map((it) => it.uid));
      const S = G.save;
      const n0 = S.bag.length;
      S.bag = S.bag.filter((it) => !ids.has(it.uid));
      let n = n0 - S.bag.length;
      for (const k of G.SLOTS) {
        if (S.equip[k] && ids.has(S.equip[k].uid)) {
          delete S.equip[k];
          n++;
        }
      }
      return n;
    },
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
    sk.alt = V.alt || ''; // 按住 Alt 的详情跟着刻式换（原式的留在 SKILL_BASE 里）
    return sk;
  }
  // 这一刻生效的刻式：'o' / 'a' / 'b' / 'c'（存档里记着、但宝石还没到解锁等级的 A / B 不生效）。
  // 渊式 'c'：戴着解锁它的渊契才生效（不看宝石等级），没戴就是替下的那种（variantPrev，没有就是原式）
  // 换装试算（G.statTrial）期间「假如换上那件装备」时生效的刻式（id → 'o' / 'a' / 'b' / 'c'，由 dry 模式的 relicSync 填）；平时 null
  let trialVar = null;
  G.variantOf = function (id) {
    if (trialVar && trialVar[id] !== undefined) return trialVar[id];
    const s = G.save;
    if (s && s.variants && s.variants[id] === 'c' && G.variantRelicOn(id)) return 'c';
    return G.variantFallback(id);
  };
  // 替下的那种：选着渊式时是 variantPrev（没有就是原式），没选渊式时就是选着的 A / B；宝石没到解锁等级的 A / B 算原式。
  // 返回 'a' / 'b' / 'o'（不看渊契戴没戴；双生坠等需要「渊式之外那一种」的地方用它，别直接读存档）
  G.variantFallback = function (id) {
    const s = G.save;
    let v = s && s.variants && s.variants[id];
    if (v === 'c') v = s.variantPrev && s.variantPrev[id];
    return (v === 'a' || v === 'b') && G.VARIANTS[id] && s.skills && s.skills[id] >= G.VARIANT_LVL ? v : 'o';
  };
  // 这个技能的渊式此刻能不能用：身上那个部位戴着解锁它的渊契（直接看存档的装备，不等 computeStats）
  G.variantRelicOn = function (id) {
    const V = G.VARIANTS[id] && G.VARIANTS[id].c, eq = G.save && G.save.equip;
    if (!V || !eq) return false;
    const it = eq[G.RELICS[V.relic].slot];
    return !!(it && it.rarity === 4 && it.rq === V.relic);
  };
  const isVar = (id, v) => v === 'o' || v === 'a' || v === 'b' || (v === 'c' && !!G.VARIANTS[id] && !!G.VARIANTS[id].c);
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
    if (G.SKILL_V[id] && isVar(id, v)) G.SKILLS[id] = G.skillVariant(id, v);
    return prev;
  };
  // 换刻式的价格：这个技能第一次选免费，之后每换一次 G.VARIANT_COST
  G.variantCost = (id) => (G.save.variantFree && G.save.variantFree[id] ? G.VARIANT_COST.n : 0);
  // 战斗中：G.VARIANT_SAFE_R 以内有醒着的敌人
  G.variantBusy = function () {
    const R = G.VARIANT_SAFE_R;
    return state.enemies.some((e) => !e.dead && e.awake && dist(e.x, e.z, P.x, P.z) <= R);
  };
  // 换刻式（技能页）：v = 'o' 原式 / 'a' / 'b' / 'c' 渊式。返回 { ok, msg, cost }
  // 渊式：戴着渊契才能选，选进去不花钱，替下的那种记在 variantPrev；退回替下的那种也不花钱（相当于没换过）。
  // 渊式选着、但渊契没戴（技能此刻用的是替下的那种）时点别的 A / B：改的是替下的那种（照常付钱），渊式仍记着，戴上就恢复
  G.setVariant = function (id, v) {
    const save = G.save, VC = G.VARIANT_COST;
    if (!G.VARIANTS[id] || !isVar(id, v)) return { ok: false, msg: '没有这种刻式' };
    const cur = save.variants[id] || 'o', prev = cur === 'c' ? save.variantPrev[id] || 'o' : cur;
    let cost = 0;
    if (v === 'c') {
      if (!G.variantRelicOn(id)) return { ok: false, msg: '装备' + G.RELICS[G.VARIANTS[id].c.relic].name + '解锁' };
      if (cur === 'c') return { ok: true, cost: 0, same: true };
      if (G.variantBusy()) return { ok: false, msg: '战斗中不能换刻式（' + G.VARIANT_SAFE_R + ' 米内还有醒着的敌人）' };
      if (cur === 'a' || cur === 'b') save.variantPrev[id] = cur;
      else delete save.variantPrev[id];
      save.variants[id] = 'c';
    } else if (cur === 'c' && v === prev) {
      if (G.variantBusy()) return { ok: false, msg: '战斗中不能换刻式（' + G.VARIANT_SAFE_R + ' 米内还有醒着的敌人）' };
      delete save.variantPrev[id];
      if (v === 'o') delete save.variants[id];
      else save.variants[id] = v;
    } else {
      if (!(save.skills[id] >= G.VARIANT_LVL)) return { ok: false, msg: '宝石 ' + G.VARIANT_LVL + ' 级才能选刻式' };
      if (cur !== 'c' && cur === v) return { ok: true, cost: 0, same: true };
      if (G.variantBusy()) return { ok: false, msg: '战斗中不能换刻式（' + G.VARIANT_SAFE_R + ' 米内还有醒着的敌人）' };
      cost = G.variantCost(id);
      if ((save.cur[VC.cur] || 0) < cost) return { ok: false, msg: '需要 ' + cost + ' 颗' + G.CURRENCY[VC.cur].name };
      save.cur[VC.cur] -= cost;
      save.variantFree[id] = true;
      if (cur === 'c' && !G.variantRelicOn(id)) {
        if (v === 'o') delete save.variantPrev[id];
        else save.variantPrev[id] = v;
      } else {
        delete save.variantPrev[id];
        if (v === 'o') delete save.variants[id];
        else save.variants[id] = v;
      }
    }
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
    const T = Math.max((ctx.cycle || ctx.time) + ctx.stopAvg, 0.01) + (ctx.cd > 0 ? ctx.cd : 0);
    return (G.avgHit(ctx) * G.durDpsK(ctx)) / T + G.bleedDps(ctx, G.bleedHps(ctx, 1 / T)); // 流血（放血和它的刻式）也算进去
  };
  // 刻式 v 和原式的比值。霜环按「主力技能 + 霜环」的总秒伤（主力取技能栏上秒伤最高的非光环技能，没有就按掷焰）；
  // 黑焰按每一击的 (1 + 黑焰%)（蚀印把攒进去的那一份也算上，传焰点在身上的和附带的一样多）
  G.variantRatio = function (id, v) {
    if (!G.SKILL_V[id]) return 1;
    const prev = G.SKILLS[id];
    const val = (w) => {
      G.SKILLS[id] = G.skillVariant(id, w);
      const sk = G.SKILLS[id];
      if (sk.buff) return 1 + (sk.brand ? 2 : 1) * Math.min(sk.flame.cap, sk.flame.k0 + sk.flame.k1 * ((G.save.skills[id] || 1) - 1)) * (1 + Math.max(0, P.S.flameEff || 0) / 100) / 100; // 蚀印：攒进去的那一份和附带的一样多
      return G.variantDps(id);
    };
    let ref = 0;
    const o0 = G.SKILL_V[id].o; // 按原式判断要不要加主力技能（选着护涡光环时，汇涡的比值仍按单体）
    if (o0.kind === 'aura' && !o0.buff) {
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
    const used = save.passives.length - 1 - (save.cls ? G.clsFreeCount() : 0); // 职业白送的起步天赋不花点
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
  // opt.dry：只算属性（换装试算 G.statTrial 用）。照样把结果写进 P 的属性字段（P.S、上限、抗性、P.relic……，见 TRIAL_KEYS），
  // 但不碰任何战斗中的状态、不写存档：不对技能栏、渊契机制只汇总不生效（千目计数、双生待发、换刻式时的持续施放 / 光环计时 / 召唤物、
  // 雾和暗域都不动，刻式只在 trialVar 里换）、不收护涡、不压当前生命 / 魔力、不换武器模型
  G.computeStats = function (opt) {
    const save = G.save;
    const dry = !!(opt && opt.dry);
    if (!dry) syncRanged(); // 光环保留看技能栏：先把右键接管对好
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
    if (P.encBuff && G.SHRINE_BUFFS[P.encBuff.id] && G.SHRINE_BUFFS[P.encBuff.id].stats) add(G.SHRINE_BUFFS[P.encBuff.id].stats); // 异兆：祈坛的增益
    P.S = S;
    G.relicSync(dry); // 身上渊契的机制（P.relic）：光环保留（星雨）在下面就要用

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
    if (G.guardSync && !dry) G.guardSync(); // 刻式「护涡」光环：不在技能栏上了就当场收起
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
    // 渊印：裂御（元素抗性在 75% 上限之后再扣，同 resLoss）、枯竭（生命 / 魔力回复降低）
    const RM = G.runMods;
    if (RM.frail) for (const t of ['fire', 'cold', 'light']) P.res[t] -= RM.frail.res;
    if (RM.drain) {
      P.lifeRegen *= 1 - RM.drain.regen;
      P.manaRegen *= 1 - RM.drain.regen;
    }
    if (!dry) {
      P.life = Math.min(P.life, P.maxLife);
      P.mana = Math.min(P.mana, P.maxMana);
    }
    // 手里烬铸武器的机制（blade 残刃 / tri 三相共鸣 / soul 魂火轮回），没有时 null
    const w = save.equip.weapon;
    P.uMech = w && w.rarity === 3 && G.UNIQUES[w.uq] ? G.UNIQUES[w.uq].mech : null;
    if (P.ent && !dry) G.world.setPlayerGear(save.equip); // 手里的武器模型跟着装备走
    return P;
  };

  // 换装试算：把 item 临时放进 slot，按 dry 模式算一遍属性，交给 fn 读（P 的属性、G.skillCtx / G.skillDps……），返回 fn 的结果；
  // 之后装备、P 的属性字段、P.relic、刻式定义原样还回去。全程不碰战斗中的状态、不写存档（见 computeStats 的 dry），
  // 所以地面名牌每帧问、背包重渲染时问都不会改变正在打的仗。fn 只能读，不能推进模拟
  const TRIAL_KEYS = ['S', 'gearLife', 'maxLifeRaw', 'maxManaRaw', 'reservePct', 'reserveLife', 'reserved', 'maxLife', 'maxMana', 'armour', 'speedMult', 'moveSpeed', 'lifeRegen', 'manaRegen', 'uMech'];
  G.statTrial = function (slot, item, fn) {
    const eq = G.save.equip;
    const had = Object.prototype.hasOwnProperty.call(eq, slot);
    const cur = eq[slot];
    const keep = {};
    for (const k of TRIAL_KEYS) if (Object.prototype.hasOwnProperty.call(P, k)) keep[k] = P[k];
    const res = Object.assign({}, P.res);
    const relic = Object.assign({}, P.relic);
    const defs = {};
    for (const id of Object.keys(G.SKILL_V || {})) defs[id] = G.SKILLS[id];
    trialVar = {};
    try {
      eq[slot] = item;
      G.computeStats({ dry: true });
      return fn();
    } finally {
      trialVar = null;
      if (had) eq[slot] = cur;
      else delete eq[slot];
      for (const k of TRIAL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(keep, k)) P[k] = keep[k];
        else delete P[k];
      }
      Object.assign(P.res, res);
      for (const k in P.relic) delete P.relic[k];
      Object.assign(P.relic, relic);
      for (const id in defs) G.SKILLS[id] = defs[id];
    }
  };

  // ---------- 光环 ----------
  // 光环技能只要绑在技能栏任意一格上就生效（宝石得已经学会），而且保留放得下（见 G.auraFits）
  G.auraSlotted = function (id) {
    const save = G.save;
    const sk = G.SKILLS[id];
    return !!(sk && sk.kind === 'aura' && save && save.skills && save.skills[id] && save.bar && save.bar.indexOf(id) >= 0);
  };
  G.auraOn = (id) => G.auraSlotted(id) && G.auraFits(id);
  // 保留上限：一共最多保留 RESERVE_CAP%。超出时（用户定「保留放不下的光环不生效」）：先算渊契的保留（G.relicReserve），
  // 再按技能栏从左到右（第 1 格 → 第 4 格）逐个加光环，加上去会超过上限的那个光环不生效（不脉冲、不附带黑焰、护涡不绕身），技能栏上变暗、标「保留不足」
  const RESERVE_CAP = (G.RESERVE_CAP = 90);
  G.auraFits = function (id) {
    let pct = G.relicReserve ? G.relicReserve() : 0;
    const bar = G.save.bar;
    for (let i = 0; i < bar.length; i++) {
      const b = bar[i];
      if (!b || bar.indexOf(b) !== i || !G.auraSlotted(b)) continue;
      const r = G.auraReserve(b);
      if (pct + r > RESERVE_CAP + 1e-9) {
        if (b === id) return false;
        continue;
      }
      if (b === id) return true;
      pct += r;
    }
    return true;
  };
  // 某个光环保留的魔力百分比：辅助宝石的消耗倍率照样乘在保留上——节流（×0.6）降低保留，迅捷、扩域这类（×1.2 上下）抬高保留
  G.auraReserve = function (id) {
    const sk = G.SKILLS[id];
    if (!sk || !sk.reserve) return 0;
    let k = 1;
    for (const supId of (G.save.sockets && G.save.sockets[id]) || []) {
      const sup = supId && G.SUPPORTS[supId];
      if (sup && G.supportFits(id, supId)) k *= sup.cost; // 对这一刻的刻式不生效的辅助不算
    }
    const wane = G.runMods.wane ? G.runMods.wane.reserve : 0; // 渊印「蚀环」：每个光环的保留 +10 个百分点
    return Math.round((sk.reserve * k + wane) * 10) / 10;
  };
  // 黑焰：此刻每一击额外的混沌伤害百分比（没放在技能栏上为 0）。F = min(cap, k0 + k1 × (等级 − 1)) × (1 + 黑焰效果%)
  G.flamePct = function () {
    if (!G.auraOn('blackflame')) return 0;
    const f = G.SKILLS.blackflame.flame;
    const lvl = G.save.skills.blackflame || 1;
    const wane = G.runMods.wane ? 1 - G.runMods.wane.eff : 1; // 渊印「蚀环」：黑焰的额外比例 −30%
    return Math.min(f.cap, f.k0 + f.k1 * (lvl - 1)) * (1 + Math.max(0, (P.S && P.S.flameEff) || 0) / 100) * wane * G.auraEffK('blackflame'); // 盛环：光环效果
  };
  // 技能栏上所有生效的光环一共保留的百分比（封顶 90%）
  G.reservePct = function () {
    let pct = 0;
    for (const id of Object.keys(G.SKILLS)) if (G.auraOn(id)) pct += G.auraReserve(id);
    pct += G.relicReserve(); // 渊式「星雨」：自动落星改为保留魔力
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
    if (sk.buff) return sup.cost < 1 || !!(sup.auraUp && sk.kind === 'aura'); // 黑焰这类增益光环：只认降低消耗（保留）的辅助，和加强光环效果的盛环
    if (sup.needCd && !(sk.cd > 0)) return false; // 储能：只能镶在有冷却的技能上
    if (sup.noId && sup.noId.indexOf(skillId) >= 0) return false; // 标签对得上、机制用不上的技能
    if (sup.no && sup.no.some((tag) => sk.tags.indexOf(tag) >= 0)) return false;
    if (sup.noKind && sk.minion && sup.noKind.indexOf(sk.minion) >= 0) return false;
    if (!sup.req) return true;
    return sup.req.some((tag) => sk.tags.indexOf(tag) >= 0);
  };

  // 某个辅助能不能镶在这个技能的任意一种刻式上（读档时用：刻式会换标签，镶着的辅助只要有一种刻式用得上就留着，换到用不上的刻式时显示「不生效」）
  G.supportFitsAny = function (skillId, supId) {
    if (G.supportFits(skillId, supId)) return true;
    const V = G.SKILL_V && G.SKILL_V[skillId];
    if (!V || !G.VARIANTS[skillId]) return false;
    const keep = G.SKILLS[skillId];
    let ok = false;
    for (const v of ['o'].concat(Object.keys(G.VARIANTS[skillId]))) {
      G.SKILLS[skillId] = G.skillVariant(skillId, v);
      if (G.supportFits(skillId, supId)) ok = true;
      if (ok) break;
    }
    G.SKILLS[skillId] = keep;
    return ok;
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
  G.cdAps = (sk) => !!(sk && sk.wm && sk.cd > 0 && !sk.weaponOnly && sk.kind !== 'summon' && !sk.round); // 特殊弹按普攻折算，攻速已经算在发数里
  // 按普攻折算的量表技（熔光射线：basicOf / basicSec）：一发 = 普攻转满之后扫射 basicSec 秒的发数。
  // 每秒发数 = 武器攻速 × 攻击速度 ÷ 普攻的 time（不算辅助宝石：武器技镶不了辅助）；没拿着对应的武器时按 1.0 攻速算
  G.basicShots = function (sk) {
    const b = G.SKILLS[sk.basicOf || G.roundBasicId(sk)]; // 特殊弹（class-d2b1）按手里那把枪的右键折算
    if (!b) return 1;
    const wp = G.weaponStats(G.save.equip.weapon);
    return (sk.basicSec * (P.speedMult || 1) * (wp.aps > 0 ? wp.aps : 1)) / b.time;
  };
  // 攻击技能实际的武器倍率：按普攻折算的 = 普攻的 wm × 折算的发数，其余就是 wm
  G.skillWm = (sk) => {
    const bo = sk.basicOf || G.roundBasicId(sk);
    return bo && G.SKILLS[bo] ? G.SKILLS[bo].wm * G.basicShots(sk) : sk.wm;
  };
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
      // fixElem：元素固定（提灯的点灯 / 借火 / 灯海是纯火焰，class-d2b1）
      const el = sk.fixElem ? sk.elem : sk.kind === 'wwand' && P.uMech === 'void' ? 'chaos' : G.topElem(sk.elem);
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
    const bsk = G.SKILLS[sk.basicOf || G.roundBasicId(sk)]; // 特殊弹：按这把枪自己的 addEff（机炮 25% / 喷枪 30% / 左轮 75%）× 折算的发数
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
    if (S.allMore) more *= 1 + S.allMore / 100; // 双生坠：你和召唤物的总伤害额外
    const extra = {};
    // 长弓的隐含穿透作用于你所有的投射物技能
    let proj = 0, pierce = !mScale && sk.tags.indexOf('projectile') >= 0 ? S.pierce || 0 : 0, chain = 0, area = mScale ? S.minionArea || 0 : S.area || 0, speedPct = 0; // 召唤物的范围只吃「召唤物的范围效果」
    let critFlat = sk.critFlat || 0, critMulti = 150 + (mScale ? 0 : S.critMulti || 0) + (sk.critMulti || 0); // 鹰眼长弓的普攻自带暴击
    let leech = 0, stun = 0, ailment = (mScale ? 0 : S.ailment || 0) + (sk.ailment || 0), echo = 0, cdr = 0, costMult = 1;
    let mLife = 0, mDR = 0, mCap = 0, mSpeed = 0, durPct = 0, durCap = 0;
    let pen = 0; // 辅助「破障」的元素穿透（装备上的「元素穿透」在 G.hitEnemy 里按你亲手的命中另加）
    let bleed = sk.bleed || 0; // 流血：放血自带 + 开刃（见 data.js 的 G.BLEED）

    // 远程普攻：辅助镶在武器普攻卡上（只取对这个普攻生效的）；别的武器技不吃辅助。
    // 刻式换了标签（例如只有雷桩带「持续」）：对这一刻的刻式不适用的辅助照样镶着，但不生效、不算消耗
    const sups = sk.basic ? G.basicSupports(id) : isWs ? [] : (save.sockets[id] || []).filter((supId) => supId && G.supportFits(id, supId));
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
      if (e.dur) durPct += e.dur;
      if (e.cap) durCap += e.cap;
      if (e.pen) pen += e.pen;
      if (e.bleed) bleed += e.bleed;
      costMult *= sup.cost;
    }
    if (S.encCdr) cdr += S.encCdr; // 异兆：祈坛「渊涌」的冷却缩短

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
      // 绵延：持续效果存在的时间倍率；有同时存在数量上限的效果，上限再加 durCap
      durK: Math.max(0.1, 1 + durPct / 100), durCap,
      pen,
      bleed,
      // 混沌异常值（渊缚）另外再加的累积速度（异常累积速度 ailment 对它同样生效）
      bindAil: mScale ? 0 : S.bindAil || 0,
      // 黑焰：每一击额外的混沌伤害（%）。光环自己的脉冲（霜环）不带
      flame: isAura ? 0 : G.flamePct(),
      flameDot: !!G.SKILLS.blackflame.flameDot, // 刻式「传焰」：黑焰那一份不直接加在这一击上，改成点在敌人身上慢慢烧（见 G.vHit）
      reserve: isAura ? G.auraReserve(id) : 0,
      minion: null,
      // 攻击技能：attack 为 true，weapon 是此刻的武器面板（G.weaponStats），wm 武器倍率，levelK 等级加成
      attack: isAttack,
      weapon: wp,
      wm: isAttack ? G.skillWm(sk) : 0,
      levelK: isAttack ? 1 + G.ATTACK_GEM_LVL * (lvl - 1) : mScale ? G.minionDmgK(lvl) : 1 + 0.2 * (lvl - 1),
      asMinion: mScale && !isMinion, // 魂潮：伤害按召唤物算的武器技（ctx.minion 仍为 null）
    };
    // 刻式：持续存在的东西按补满的间隔（cycle，固定秒数），带收尾 / 起手的按 time 的倍数（cycleK）
    if (sk.cycle) ctx.cycle = sk.cycle;
    else if (sk.cycleK) ctx.cycle = ctx.time * sk.cycleK;
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
      const cap = sk.cap + (sk.minion === 'thrall' ? Math.max(0, Math.round((S.minionCap || 0) + mCap)) : sk.minion === 'pyre' ? Math.max(0, Math.round(mCap)) : 0);
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
        mech: sk.mech, vx: sk.mech ? sk[sk.mech] : null, // 刻式：机制和它的参数（minions.js 按它分支）
      };
      if (sk.minion === 'pyre') {
        // 焚骨祭司：火弹爆炸 / 坠焰的半径吃扩域；多重投射让它一次掷出几枚（分头砸向不同的敌人）
        const mi = ctx.minion, ak = Math.sqrt(ctx.area);
        mi.keep = sk.keep;
        mi.flee = sk.flee;
        mi.speed = sk.speed;
        mi.explode = sk.explode * ak;
        mi.bolts = Math.max(1, ctx.proj);
        mi.charge = sk.mech === 'link' ? null : sk.charge; // 刻式「魂链」：没有焰蓄、没有大招
        mi.chargeK = 1 + Math.max(0, S.minionCharge || 0) / 100; // 焰蓄攒得快（天赋「焚骨圣咏」）
        mi.meteor = Object.assign({}, sk.meteor, { radius: sk.meteor.radius * ak, r: sk.meteor.r * ak });
        mi.beam = sk.beam;
      }
    }
    G.supXCtx(ctx, sups, isAura); // 取舍型 / 改玩法的辅助（support-expand）：ctx.x、冷却、穿透、光环效果
    if (P.relic.any || ctx.sk.mech === 'king') G.relicCtx(ctx); // 渊契：必然、同殇等改上下文；渊式「独骸」
    G.sealCtx(ctx); // 渊印的玩家侧印纹（迟滞 / 蚀环 / 孤影）
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
    if (mi && mi.mech === 'link') return G.avgHit(ctx) * mi.cap * (mi.vx.k1 / (mi.vx.tick * Math.min(1, mi.interval / ctx.sk.rate))); // 刻式「魂链」：烧满之后的灼链
    if (mi && mi.mech === 'field') {
      // 刻式「焰田」打单体：火弹（每秒 r 枚）+ 脚下火地（几片共用一个计时，每 tick 秒一跳）+ 燎原（每 charge.max 枚一次，引爆这期间留下、还没灭的火地）
      const F = mi.vx, r = mi.cap / mi.interval, gap = (mi.charge.max * mi.interval) / mi.cap;
      // 燎原时还压在目标脚下的火地实测约三成（火弹落点散、火地先灭）
      return G.avgHit(ctx) * (r + F.mult / F.tick + (0.3 * Math.min(F.dur * ctx.durK, gap) * r * F.burst) / gap); // 绵延：火地更久
    }
    if (mi && mi.beam && mi.charge) {
      // 焚骨祭司打单体：每 charge.max 枚火弹接一轮灼链（单体时一弹只攒 1 点焰蓄）
      const ticks = Math.floor(mi.beam.dur / (mi.beam.tick * Math.min(1, mi.interval / ctx.sk.rate)) + 1e-6); // 召唤物速度也加快灼链的跳数
      const cyc = mi.charge.max * mi.interval + mi.beam.dur;
      return (G.avgHit(ctx) * mi.cap * (mi.charge.max + ticks * mi.beam.mult)) / cyc;
    }
    if (mi) return ((G.avgHit(ctx) * mi.cap) / Math.max(0.05, mi.interval) + G.bleedDps(ctx, mi.cap / Math.max(0.05, mi.interval))) * twinDpsK(ctx);
    const rate = G.skillRate(ctx);
    return (G.avgHit(ctx) * rate * G.durDpsK(ctx) + G.bleedDps(ctx, G.bleedHps(ctx, rate))) * twinDpsK(ctx);
  };
  // 流血的秒伤估算（打单体、层数叠稳之后）：每层 = 每击的物理部分 × bleed%，摊在 dur 秒里；稳定层数 = min(上限, 每秒命中 hps × dur)。
  // 散钉（hitCap）一次施放中 useMult 枚、每枚各叠一层，所以 hps = 每秒施放 × useMult（G.bleedHps）
  // 出手快的被层数上限卡住，慢而重的吃满
  G.bleedInfo = function (ctx, hps) {
    if (!(ctx.bleed > 0) || !ctx.base.phys) return null;
    const b = ctx.base.phys, sk = ctx.sk;
    const critK = 1 + (ctx.crit / 100) * (ctx.critMulti / 100 - 1);
    const phys = ((b[0] + b[1]) / 2) * typeMult(ctx, 'phys') * ctx.more * critK * (sk.comboAvg || 1); // 每一击（散钉是每一枚）
    const per = (phys * ctx.bleed) / 100;
    const n = Math.min(Math.max(G.BLEED.cap, sk.bleedCap || 0), hps * G.BLEED.dur);
    return { per, n, dps: (n * per) / G.BLEED.dur, ramp: n / Math.max(0.01, hps) };
  };
  G.bleedHps = (ctx, rate) => rate * (ctx.sk.hitCap ? ctx.sk.useMult || 1 : 1);
  G.bleedDps = (ctx, hps) => {
    const b = G.bleedInfo(ctx, hps);
    return b ? b.dps : 0;
  };
  // 绵延对秒伤估算的折算：黑洞、黑旋风原式的跳数随持续时间变多；雷桩、环刃满编时多一个（补的节奏按 寿命 ÷ 上限，几乎不变）
  G.durDpsK = function (ctx) {
    const sk = ctx.sk;
    if (!ctx.durCap && ctx.durK === 1) return 1;
    if (sk.mech === 'pylon') return (sk.pylon.max + ctx.durCap) / sk.pylon.max;
    if (sk.mech === 'orbit') return (sk.orbit.max + ctx.durCap) / sk.orbit.max;
    if (sk.kind === 'hole' || (sk.kind === 'vortex' && !sk.mech) || sk.kind === 'rain') return ctx.durK; // 坠凌：多落几根
    return 1;
  };
  // 双生坠「余响」：刻式技能的秒伤多算一份 k（技能页、换装对比都读 skillDps；单次伤害 avgHit 不变，处决的基数不受影响）
  const twinDpsK = (ctx) => (P.relic.shuangsheng && G.twinOn && G.twinOn(ctx.id) ? 1 + G.RELIC_MECH.shuangsheng.k : 1);
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
    if (ctx.flame > 0 && !ctx.flameDot) parts.chaos = (parts.chaos || 0) + (pre * ctx.flame) / 100; // 传焰：这一份点在敌人身上慢慢烧
    const crit = P.relic.qianmu ? G.relicCrit(ctx) : Math.random() * 100 < ctx.crit; // 渊契「必然」：暴击按计数
    const k = ctx.more * (crit ? ctx.critMulti / 100 : 1) * m;
    let total = 0;
    for (const t in parts) {
      parts[t] *= k;
      total += parts[t];
    }
    // flame：其中黑焰的那一部分（刻式「蚀印」攒进蚀印、「传焰」点在敌人身上的都是这个数）
    return { total, parts, crit, flame: ctx.flame > 0 ? ((pre * ctx.flame) / 100) * k : 0 };
  };

  // ---------- 敌人的元素抗性（数值见 data.js 的 G.ENEMY_RES）----------
  // e 对伤害类型 t 的抗性（%，未算感电和穿透）：抗自己的元素（e.elem），区域可以按 id 覆盖；物理、混沌为 0
  G.enemyRes = function (e, t) {
    if (t !== 'fire' && t !== 'cold' && t !== 'light') return 0;
    const R = G.ENEMY_RES, zd = G.state.zone && G.state.zone.def, zo = zd && R.zone[zd.id];
    const r = zo && zo[t] !== undefined ? zo[t] : t === e.elem ? (e.isBoss ? R.boss : e.elite ? R.elite : R.mob) : 0;
    return Math.min(R.cap, r);
  };
  // 算上感电：三种元素抗性各降 shock 点，单靠感电不会降到 0 以下
  G.enemyResNow = function (e, t) {
    const r = G.enemyRes(e, t);
    return e.shockT > 0 && r > 0 ? Math.max(0, r - G.ENEMY_RES.shock) : r;
  };
  // 这一类伤害打到 e 身上的倍率：穿透 pen 能把抗性压到负数，最低 floor
  G.resistMul = function (e, t, pen) {
    if (t !== 'fire' && t !== 'cold' && t !== 'light') return 1;
    const r = G.enemyResNow(e, t);
    if (!r && !(pen > 0)) return 1;
    return 1 - Math.max(G.ENEMY_RES.floor, r - (pen || 0)) / 100;
  };
  // 一击结算抗性（只在 G.hitEnemy 里调这一处）：各元素那一份 × resistMul，total 跟着减；物理、混沌、黑焰那一份不变
  G.applyResist = function (e, hit, pen) {
    const parts = hit.parts;
    for (let i = 0; i < G.ELEMS.length; i++) {
      const t = G.ELEMS[i], v = parts[t];
      if (!(v > 0)) continue;
      const k = G.resistMul(e, t, pen);
      if (k === 1) continue;
      parts[t] = v * k;
      hit.total -= v - v * k;
    }
  };

  G.avgHit = function (ctx) {
    let pre = 0;
    for (const t in ctx.base) pre += ((ctx.base[t][0] + ctx.base[t][1]) / 2) * typeMult(ctx, t);
    let extraPct = ctx.flame > 0 ? ctx.flame * (G.SKILLS.blackflame.brand ? 2 : 1) : 0; // 蚀印：附带的那一份之外，再攒一份同样多的进蚀印（满层炸开）
    for (const t in ctx.extra) extraPct += ctx.extra[t];
    const critK = 1 + (ctx.crit / 100) * (ctx.critMulti / 100 - 1);
    // 连击技能按三段的平均倍率折算（ctx.time 也是平均段长）；武器技按一次施放对单体的倍率总和（useMult）折算
    // ——必定暴击的（影刺）按暴击伤害算，不按暴击率折算
    const sk = ctx.sk;
    // 特殊弹（class-d2b1）：ctx 是一份，一次施放按枪的形状打出 n 枚 × k 份（useMult 是在这之上的倍数：铁水、放电、重弹）
    const rk = sk.round ? G.roundShape().n * G.roundShape().k : 1;
    return pre * (1 + extraPct / 100) * ctx.more * (sk.sureCrit ? ctx.critMulti / 100 : critK) * (sk.comboAvg || sk.useMult || 1) * rk;
  };

  // =====================================================================
  // 取舍型 / 改玩法的辅助（support-expand）：数据在 data.js G.SUPPORTS 末尾那一段。
  // skillCtx 末尾调 G.supXCtx 把这些辅助的新字段汇总进 ctx.x（没镶的技能共用一个空的 NO_X）；
  // 各处只留一行钩子：投射物速度（G.spawnProjectile / 黑旋风）、储能（施放处 + 每帧计时）、异常触发（hitEnemy → supXAil → triggerAilment）
  // =====================================================================
  const NO_X = Object.freeze({});
  const X_SUM = ['projSpd', 'auraEff', 'charges', 'cdMore', 'blastK', 'blastR', 'blastCap', 'freezeK', 'chillK', 'shockN', 'shockT', 'fork', 'forkAng', 'splash', 'splashR', 'cull', 'cullElite', 'convert'];
  G.supXCtx = function (ctx, sups, isAura) {
    let x = null;
    for (const supId of sups) {
      const sup = supId && G.SUPPORTS[supId];
      if (!sup) continue;
      const e = sup.eff;
      for (const k of X_SUM) if (e[k]) (x || (x = {}))[k] = (x[k] || 0) + e[k];
      if (e.noPass) (x || (x = {})).noPass = 1;
    }
    ctx.x = x || NO_X;
    if (!x) return;
    // 储能：冷却延长（秒伤估算按延长后的冷却算，存着的那一次只多出爆发）
    if (x.cdMore && ctx.cd > 0) ctx.cd *= 1 + x.cdMore / 100;
    // 远劲：穿透、连锁全部作废；弓的「一矢穿心」照样贯穿（它是 R 的效果，不是穿透属性）
    if (x.noPass) {
      const b = ctx.sk.basic && RFAM[ctx.sk.rtype] === 'bow' ? G.rangedBuff() : null;
      ctx.pierce = b && b.pierce ? b.pierce : 0;
      ctx.chain = 0;
    }
    // 盛环：霜环 / 护涡的光环伤害（黑焰这类增益光环在 G.flamePct 里按 G.auraEffK 算）
    if (x.auraEff && isAura && !ctx.sk.buff) ctx.more *= 1 + x.auraEff / 100;
    // 化元：基础物理伤害的 convert% 在吃任何加成之前挪进一种元素（G.convertEl 选），之后照常按类型吃提高 / 总额外
    if (x.convert && ctx.base.phys) {
      const k = Math.min(1, x.convert / 100), el = G.convertEl(ctx), p = ctx.base.phys;
      const b = ctx.base[el] || [0, 0];
      ctx.base[el] = [b[0] + p[0] * k, b[1] + p[1] * k];
      if (k >= 1) delete ctx.base.phys;
      else ctx.base.phys = [p[0] * (1 - k), p[1] * (1 - k)];
    }
  };
  // 化元转成哪种元素：此刻你火焰 / 冰霜 / 闪电伤害提高里最高的那种（并列取火焰，同施法武器的普攻，见 G.topElem）。
  // 以后要按目标挑（例如敌人抗性）只改这一处
  G.convertEl = () => G.topElem('fire');

  // 断命：这一击之后生命低于门槛的非首领敌人直接倒下（hitEnemy 里一行钩子；触发伤害的 ctx 没有 x，不算）
  function cullCheck(e, ctx) {
    const x = ctx.x;
    if (!x || !x.cull || e.isBoss || !(e.hp > 0)) return;
    if (e.hp > e.maxHp * ((e.elite ? x.cullElite || x.cull : x.cull) / 100)) return;
    e.hp = 0;
    state.stats.culls = (state.stats.culls || 0) + 1;
    G.world.text(e.x, e.z, '断命', '#ff8aa0', e.elite ? 22 : 18, { kind: 'tag', y: Math.min(3.4, (e.height || 2) * (e.elite ? 1.3 : 1)) + 0.3 });
  }

  // 溅击：近战的直接命中排进 splashQ，每帧在投射物更新开头统一结算（这时这一帧所有挥砍都打完了，
  // 同一下已经直接打中的敌人不再吃溅射，免得一刀扫到的一圈怪各吃两遍）。溅射 = 这一击各类型伤害 × splash%，
  // 打到目标身边 splashR 米内的其他敌人，用固定数值的触发伤害结算（不暴击、不吸血、不再溅射），照常累积异常值
  const splashQ = [];
  function splashQueue(e, ctx, hit, inf) {
    e.splDirT = state.time;
    e.splDirId = ctx.id;
    if (inf.proc || inf.aura || inf.minion || ctx.minion || ctx.sk.tags.indexOf('melee') < 0) return;
    splashQ.push({ e, ctx, parts: hit.parts, x: e.x, z: e.z });
  }
  function flushSplash() {
    if (!splashQ.length) return;
    const W = G.world, t = state.time;
    for (const q of splashQ.splice(0)) {
      const x = q.ctx.x, R = x.splashR || 2.5, k = (x.splash || 0) / 100;
      const base = {};
      for (const ty in q.parts) if (q.parts[ty] > 0) base[ty] = [q.parts[ty] * k, q.parts[ty] * k];
      const sc = { sk: PROC_SK, base, inc: {}, moreType: {}, more: 1, extra: {}, crit: 0, critMulti: 100, ailment: q.ctx.ailment, bindAil: q.ctx.bindAil, stun: 0, leech: 0, echo: 0, area: 1, proc: true, x: NO_X };
      let n = 0;
      for (const o of state.enemies) {
        if (o === q.e || o.dead || dist(o.x, o.z, q.x, q.z) - o.r > R) continue;
        if (o.splDirT === t && o.splDirId === q.ctx.id) continue; // 这一帧已经被同一个技能直接打中
        if (o.splT === t && o.splId === q.ctx.id) continue; // 这一帧已经吃过同一个技能的溅射
        o.splT = t;
        o.splId = q.ctx.id;
        G.hitEnemy(o, sc, 1, { ang: Math.atan2(o.x - q.x, o.z - q.z), w: 0, kb: 0, poise: 0, quiet: true, proc: true, faint: true, splash: n < 3 ? 1 : 2 }); // 不击退：推开会把怪群推出技能的范围
        n++;
      }
      if (n) {
        state.stats.splashes = (state.stats.splashes || 0) + n;
        W.burst(q.x, 0.9, q.z, 0xffc89a, 4 + Math.min(4, n), 3.5, 0.25);
      }
    }
  }

  // 分岔：玩家投射物第一次命中时左右各分出一枚（afterPlayerHit 里一行钩子）。分出来的不再分岔、不穿透、不连锁，
  // 和母弹共用这次施放的已命中集合（不会重复打同一个敌人）；飞行时间取母弹剩下的和 8 米里较长的
  function forkProj(p, e) {
    const x = p.ctx.x, n = x.fork || 0;
    if (!n || p.forked || p.pin || p.stick || p.skip || p.minion || p.aura) return;
    p.forked = true;
    const a0 = Math.atan2(p.dx, p.dz), da = ((x.forkAng || 35) * Math.PI) / 180;
    for (let i = 0; i < n; i++) {
      const a = a0 + (i % 2 ? 1 : -1) * da * (1 + Math.floor(i / 2));
      const dx = Math.sin(a), dz = Math.cos(a);
      G.spawnProjectile({
        owner: 'p', x: e.x + dx * (e.r + 0.15), z: e.z + dz * (e.r + 0.15), dx, dz,
        speed: p.speed, r: p.r, life: Math.max(p.life, 8 / p.speed), color: p.color,
        ctx: p.ctx, pierce: 0, chain: 0, explode: p.explode, hit: new Set(p.hit), cast: p.cast,
        vk: p.vk, tint: p.tint, rtype: p.rtype, mult: p.mult || 1, multFn: p.multFn || null, after: p.after || null, ranged: p.ranged,
        kb: p.kb, poise: p.poise, blastMult: p.blastMult, forked: true,
      });
    }
    state.stats.forks = (state.stats.forks || 0) + n;
  }


  // 光环效果倍率（盛环）：镶在这个光环上、对它生效的辅助的 auraEff 之和
  G.auraEffK = function (id) {
    let k = 0;
    for (const supId of (G.save.sockets && G.save.sockets[id]) || []) {
      const sup = supId && G.SUPPORTS[supId];
      if (sup && sup.eff.auraEff && G.supportFits(id, supId)) k += sup.eff.auraEff;
    }
    return 1 + k / 100;
  };
  // 远劲：投射物速度倍率（飞行时间不变，射程跟着放大）
  G.projSpdK = (ctx) => (ctx && ctx.x && ctx.x.projSpd ? 1 + ctx.x.projSpd / 100 : 1);

  // 储能：CHG[id] = { n 存着几次, max 最多几次, t 下一次补上还要几秒, cd 每补一次的秒数 }。
  // 有存货时 P.cds[id] 保持 0（随时能放），用完了 P.cds[id] = 补上下一次的剩余时间（技能栏照常显示冷却）。
  // P.cds 被整个换掉（重生、换区域）时存货一并补满
  let CHG = {}, chgRef = null;
  function chgSync() {
    if (chgRef !== P.cds) {
      CHG = {};
      chgRef = P.cds;
    }
  }
  // 技能栏上的小格：这个技能最多存几次、现在存着几次；没镶储能时 null
  G.chargeInfo = function (id) {
    const socks = id && G.save.sockets && G.save.sockets[id];
    if (!socks || socks.indexOf('charge') < 0 || !G.supportFits(id, 'charge')) return null;
    chgSync();
    const max = 1 + G.SUPPORTS.charge.eff.charges, c = CHG[id];
    return { n: c ? c.n : max, max: c ? c.max : max };
  };
  // 施放进冷却的那一刻（P.cds 已按 ctx.cd 设好）：有储能就扣一次存货，冷却改由存货决定
  G.useCharge = function (id, ctx) {
    chgSync();
    const max = ctx.x && ctx.x.charges && ctx.cd > 0 ? 1 + ctx.x.charges : 0;
    if (!max) {
      delete CHG[id];
      return;
    }
    const c = CHG[id] || (CHG[id] = { n: max, max, t: 0, cd: ctx.cd });
    c.max = max;
    c.cd = ctx.cd;
    c.n = Math.max(0, Math.min(c.n, max) - 1);
    if (!(c.t > 0)) c.t = ctx.cd;
    P.cds[id] = c.n > 0 ? 0 : c.t;
    P.cdMax[id] = ctx.cd;
  };
  function tickCharges(dt) {
    chgSync();
    for (const id in CHG) {
      const c = CHG[id];
      if (c.t > 0) {
        c.t -= dt;
        if (c.t <= 0) {
          c.n = Math.min(c.max, c.n + 1);
          c.t = c.n < c.max ? c.t + c.cd : 0;
        }
      }
      if (c.n >= c.max && !(c.t > 0)) {
        delete CHG[id];
        continue;
      }
      P.cds[id] = c.n > 0 ? 0 : c.t;
    }
  }

  // 异常触发（烈爆 / 深寒 / 雷涌）：hitEnemy 里这一击灌出来的触发（procQ 从 q0 起）记上 ctx.x，triggerAilment 按它加强；
  // 深寒的冰缓按最近一次灌冰霜的技能算（e.chillK）
  function supXAil(e, ctx, hit, q0) {
    const x = ctx.x;
    if (hit.parts.cold > 0) e.chillK = x.chillK ? 1 + x.chillK / 100 : 0;
    if (x === NO_X) return;
    for (let i = q0; i < procQ.length; i++) {
      const p = procQ[i];
      if (p.e !== e || p.death) continue;
      p.ax = x;
      // 烈爆：按没封顶的平均每击重算爆燃伤害，封顶一起提高
      if (p.t === 'fire' && (x.blastK || x.blastCap)) p.fire = Math.min((p.raw || 0) * (1 + (x.blastK || 0) / 100), e.buTh * BU.blastCap * (1 + (x.blastCap || 0) / 100));
    }
  }
  const axK = (p, k) => (p.ax && p.ax[k] ? 1 + p.ax[k] / 100 : 1);

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
  // 最近一次造成 / 受到伤害的模拟时间（音乐的战斗强度只读它，见 js/score.js 的 G.music）。纯赋值：不分配、不取随机数，开不开音乐都一样
  const combat = (G.combat = { dealt: -1e9, taken: -1e9 });
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

  // ---------- 流血（数值见 data.js 的 G.BLEED）----------
  // 每个敌人两条定长数组：e.blR[k] 这一层每秒的伤害、e.blT[k] 剩余秒数（前 e.blN 格有效），e.blTT 距下一跳的秒数。
  // 正在流血的敌人记在 bleeders 里；每跳把所有层合成一次结算（一个淡的小数字），过期的层从末尾挪过来补位——热路径上不分配对象
  const BL = G.BLEED;
  const bleeders = [];
  const BLEED_BASE = [0, 0];
  const BLEED_CTX = Object.assign(procCtx('phys', 0), { base: { phys: BLEED_BASE }, bleedTick: true });
  const BLEED_INFO = { proc: true, quiet: true, faint: true, dot: true, bolt: true, noBuild: true, kb: 0, poise: 0, w: 0, ang: 0 };
  // cap：这一击允许叠到几层（缺省 BL.cap；刻式「剜创」更多，最多 BL.capMax）。层数已经超过 cap 时（剜创叠上去的）照样顶掉最弱的
  function addBleed(e, total, cap) {
    if (!(total > 0) || e.dead) return;
    cap = Math.min(BL.capMax, Math.max(BL.cap, cap || 0));
    if (!e.blR) {
      e.blR = new Float32Array(BL.capMax);
      e.blT = new Float32Array(BL.capMax);
      e.blN = 0;
    }
    let i = e.blN;
    if (i >= cap) {
      // 满了：顶掉剩余伤害最少的那层（新的这层比它们都弱时，它自己就是最弱的那层，不加）
      let wv = Infinity;
      for (let k = 0; k < e.blN; k++) {
        const v = e.blR[k] * e.blT[k];
        if (v < wv) {
          wv = v;
          i = k;
        }
      }
      if (wv >= total) return;
    } else e.blN++;
    e.blR[i] = total / BL.dur;
    e.blT[i] = BL.dur;
    if (!e.blOn) {
      e.blOn = true;
      e.blTT = BL.tick;
      bleeders.push(e);
    }
    const st = state.stats;
    st.bleedStacks = (st.bleedStacks || 0) + 1;
  }
  G.bleedStacks = (e) => (e && e.blOn && !e.dead ? e.blN : 0);
  function tickBleed(dt) {
    let j = 0;
    const st = state.stats;
    for (let i = 0; i < bleeders.length; i++) {
      const e = bleeders[i];
      if (e.dead || !e.blN) {
        e.blOn = false;
        e.blN = 0;
        continue;
      }
      e.blTT -= dt;
      if (e.blTT <= 0) {
        e.blTT += BL.tick;
        let v = 0;
        for (let k = 0; k < e.blN; k++) {
          v += e.blR[k] * Math.min(BL.tick, e.blT[k]);
          e.blT[k] -= BL.tick;
        }
        for (let k = 0; k < e.blN; ) {
          if (e.blT[k] <= 1e-4) {
            e.blN--;
            e.blR[k] = e.blR[e.blN];
            e.blT[k] = e.blT[e.blN];
          } else k++;
        }
        if (v > 0) {
          const n = e.blN;
          BLEED_BASE[0] = BLEED_BASE[1] = v;
          BLEED_INFO.ang = Math.atan2(e.x - P.x, e.z - P.z);
          const dealt = G.hitEnemy(e, BLEED_CTX, 1, BLEED_INFO) || 0;
          st.bleedTicks = (st.bleedTicks || 0) + 1;
          st.bleedDmg = (st.bleedDmg || 0) + dealt;
          if (!e.dead) fxOpt('bleedDrip', e.x, e.z, e.height || 2, e.r, n);
        }
        if (e.dead || !e.blN) {
          e.blOn = false;
          e.blN = 0;
          continue;
        }
      }
      bleeders[j++] = e;
    }
    bleeders.length = j;
  }
  // 换区域 / 重生：流血全部清掉（不结算）
  function resetBleed() {
    for (const e of bleeders) {
      e.blOn = false;
      e.blN = 0;
    }
    bleeders.length = 0;
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
    if (G.runMods.ailRes) e.buTh *= G.runMods.ailRes.th; // 渊印「坚蜕」：异常阈值 ×1.6（首领也吃）
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
    queueProc(procs, { t, e, fire: t === 'fire' ? blastDmg(e) : 0, raw: t === 'fire' ? (e.buFire / Math.max(1, e.buFireN)) * BU.blast : 0 }); // raw：没封顶的（烈爆按它重算）
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
        e.bossChill = BU.bossChill * axK(p, 'freezeK'); // 深寒
        W.text(e.x, e.z, '冰缓', '#bfeaff', 26, { kind: 'tag', y: ty, py: -30 });
      } else {
        // 渊印「坚蜕」：冻结 ×0.75
        e.freeze = Math.max(e.freeze || 0, (e.elite ? BU.freezeElite : BU.freeze) * (G.runMods.ailRes ? G.runMods.ailRes.dur : 1) * axK(p, 'freezeK')); // 深寒
        W.text(e.x, e.z, '冻结', '#d6f3ff', e.elite ? 24 : 20, { kind: 'tag', y: ty });
      }
      W.freezeFx(e.x, e.z, e.r, h, !!e.isBoss);
      G.sfx('impact', { type: 'cold', w: 1, crit: false });
      if (G.SKILLS.nova.mech === 'burst' && G.auraOn('nova')) novaBurst(e); // 刻式「冰爆」：光环里冻住的那一刻炸开
    } else if (p.t === 'fire') {
      st.blasts = (st.blasts || 0) + 1;
      e.blastT = 1;
      const R = (BU.blastR + e.r * 0.5) * axK(p, 'blastR'); // 烈爆：范围
      const dmg = p.fire;
      W.blastFx(e.x, e.z, R);
      W.text(e.x, e.z, '爆燃', '#ffb070', e.isBoss ? 26 : 22, { kind: 'tag', y: ty, py: e.isBoss ? -30 : 0 });
      G.sfx('impact', { type: 'fire', w: 2, crit: false });
      fireBlast(e.x, e.z, R, dmg);
    } else if (p.t === 'light') {
      if (e.dead) return;
      st.shocks = (st.shocks || 0) + 1;
      e.shockT = BU.shock * axK(p, 'shockT'); // 雷涌：时间、电弧数
      e.shockN = BU.shockN + ((p.ax && p.ax.shockN) || 0);
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
    e.bindT = Math.max(e.bindT || 0, (e.elite ? BU.bindElite : BU.bind) * (G.runMods.ailRes ? G.runMods.ailRes.dur : 1)); // 坚蜕：渊缚 ×0.75
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
      more: Math.max(0, (1 + (S.moreDmg || 0) / 100) * (1 + (S.allMore || 0) / 100) * (1 - Math.min(90, S.ownLess || 0) / 100)), extra: {},
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
    const tgts = nearestOthers(e, BU.shockR, e.shockN || BU.shockN); // 雷涌打满的感电多一道
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
  // varEff：有渊式的技能上一次对账时生效的刻式（戴上 / 摘下渊契时据此判断要不要换定义）
  // twinQ / twinFx：双生坠挂着待发双生一击的敌人、正在播的双月特效
  const RQ = { crit: 0, spin: 0, spinCtx: null, spinR: 0, spinFull: false, slamT: 0, metT: 0, bridges: [], chainT: 0, kingT: 0, shareT: 0, twinQ: new Set(), twinFx: [], varEff: {} };
  G.relicState = RQ; // 测试 / 调试用

  // computeStats 里调用：按身上的装备汇总 P.relic（同一种机制穿两件也只算一次）
  // dry（换装试算）：只汇总 P.relic、把试算时生效的刻式记进 trialVar，机制的运行时状态一概不动（见 G.statTrial）
  G.relicSync = function (dry) {
    const r = P.relic;
    for (const k in r) delete r[k];
    const eq = G.save && G.save.equip;
    if (!eq) return r;
    for (const slot of G.SLOTS) {
      const it = slot !== 'weapon' && eq[slot];
      const R = it && it.rarity === 4 && G.RELICS[it.rq];
      if (R && R.slot === slot) {
        r[it.rq] = true;
        r.any = true;
      }
    }
    if (dry) {
      relicVariantTrial();
      return r;
    }
    if (!r.qianmu) RQ.crit = 0;
    relicVariantSync();
    // 双生：摘下时还没落下的双生一击当场作废
    if (!r.shuangsheng && (RQ.twinQ.size || RQ.twinFx.length)) twinClear();
    // 暗域（熄烛冠）：暖光半径缩小（和幽晦叠加时雾近端有下限）；脚下 / 召唤物脚下的暗域圈
    const XZ = RM.xizhu;
    if (G.world && G.world.lampScale) G.world.lampScale(r.xizhu ? 1 - XZ.lamp : 1, r.xizhu ? XZ.fogMin : 0);
    if (G.world && G.world.setDark) G.world.setDark(r.xizhu ? XZ.r : 0, XZ.mr);
    return r;
  };

  // 渊式（relicSync 里调用）：戴上 / 摘下 / 卖掉 / 丢掉这六件渊契时技能定义跟着换——摘下退回替下的那种，再戴上恢复渊式；
  // 换的那一刻正在转的旋风斩停下（蓄潮攒着的潮势在 relicTick 里拍下），已经放出去的投射物 / 黑洞 / 电桥按施放时的定义走完。
  // 某件渊契第一次戴上时替你选上它的渊式（每个技能只自动一次，之后全看技能页）
  function relicVariantSync() {
    const save = G.save;
    if (!save || !save.variants || !G.SKILL_V) return;
    if (!save.variantPrev) save.variantPrev = {};
    if (!save.rqAuto) save.rqAuto = {};
    for (const rq of Object.keys(G.VARIANT_RELIC)) {
      const id = G.VARIANT_RELIC[rq];
      if (!G.SKILL_V[id]) continue;
      if (!save.rqAuto[id] && G.variantRelicOn(id)) {
        save.rqAuto[id] = true;
        if (save.variants[id] !== 'c') {
          const cur = save.variants[id];
          if (cur === 'a' || cur === 'b') save.variantPrev[id] = cur;
          else delete save.variantPrev[id];
          save.variants[id] = 'c';
          if (G.ui && G.ui.toast) toast(G.SKILLS[id].name + '换成了渊式「' + G.VARIANTS[id].c.name + '」，技能页可换回', G.RELIC_COLOR);
        }
      }
      const eff = G.variantOf(id);
      if (RQ.varEff[id] === eff) continue;
      const was = RQ.varEff[id];
      RQ.varEff[id] = eff;
      if (was === undefined && (G.SKILLS[id].variant || 'o') === eff) continue; // 第一次对账：已经是这一种
      G.SKILLS[id] = G.skillVariant(id, eff);
      if (G.SKILLS[id].kind === 'summon') RQ.varMin = true; // 召唤物的上限 / 数值 / 体型：下一帧在 relicTick 里刷新（这里还在 computeStats 当中）
      if (P.cast && P.cast.id === id) endChannel();
      if (P.auraT) delete P.auraT[id];
    }
  }

  // 试算版的 relicVariantSync：同样的规则算出「换上之后」生效的刻式（第一次戴上这件渊契会自动选上渊式——试算也按选上算），
  // 只记进 trialVar、换 G.SKILLS 里的定义（G.statTrial 结束时换回）；不写存档、不弹提示、不停持续施放、不动光环计时和召唤物
  function relicVariantTrial() {
    const save = G.save;
    if (!save || !save.variants || !G.SKILL_V || !trialVar) return;
    for (const rq of Object.keys(G.VARIANT_RELIC)) {
      const id = G.VARIANT_RELIC[rq];
      if (!G.SKILL_V[id]) continue;
      const auto = !(save.rqAuto && save.rqAuto[id]) && G.variantRelicOn(id);
      const eff = auto || (save.variants[id] === 'c' && G.variantRelicOn(id)) ? 'c' : G.variantFallback(id);
      trialVar[id] = eff;
      if ((G.SKILLS[id].variant || 'o') !== eff) G.SKILLS[id] = G.skillVariant(id, eff);
    }
  }

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
    if (mi.kind === 'thrall' && ctx.sk.mech === 'king') {
      // 渊式「独骸」：多出来的仆从上限（群聚、天赋、护符、万魂旗）每个折成伤害和生命
      const H = ctx.sk.king, extra = Math.max(0, mi.cap - ctx.sk.cap);
      ctx.more *= H.dmg * (1 + H.perDmg * extra);
      mi.life = Math.max(1, Math.round(mi.life * H.life * (1 + H.perLife * extra)));
      mi.soulK = ctx.sk.cap / (H.life * (1 + H.perLife * extra)); // 万魂旗的魂火按「普通上限那么多具普通仆从」的生命算
      mi.cap = 1;
      mi.cleave = H.cleave;
      mi.arc = (H.arc * Math.PI) / 180;
      mi.hold = H.hold;
      mi.dr = Math.min(75, mi.dr + H.dr);
      mi.reach *= H.reach || 1.3;
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

  // ---------- 双生（双生坠，巅峰）：hitEnemy 末尾一行钩子 ----------
  // 刻式技能（宝石 ≥ 解锁等级，或选着渊式）的每一次命中——你亲手的、它的召唤物的、光环脉冲——把这一下结算后伤害的 k 记在敌人身上，
  // delay 秒后在同一个敌人身上落一记「双生一击」。黑焰附带的那一份也算（传焰点上的、蚀印攒进去的按施加时记）。
  // 同一个敌人身上的累加成一记（每个敌人最多一记待发）；双生一击只扣生命：不暴击、不累积异常值、不削架势、不吸血、不触发命中效果，
  // 也不攒层数（蓄潮、影印、坍缩的质量、蚀印都不吃）。只看命中，不碰技能自己的状态，所以原式 / A / B / 渊式、持续施放、再按、召唤、光环都一样
  const TW = RM.shuangsheng;
  G.twinOn = (id) => !!(id && G.SKILL_V[id]) && ((G.save.skills[id] || 0) >= G.VARIANT_LVL || G.variantOf(id) === 'c');
  G.relicTwinHit = function (e, ctx, hit, inf) {
    if (inf.proc || inf.twin || ctx.proc || !(hit.total > 0 || hit.flame > 0)) return;
    const own = G.twinOn(ctx.id);
    let v = own ? hit.total : 0;
    if (hit.flame > 0 && G.twinOn('blackflame')) {
      // 黑焰：直接附带的那份在 hit.total 里（自己的技能不是刻式时单算）；传焰点上的、蚀印攒进去的不在 total 里，另算
      const inTotal = ctx.flameDot ? 0 : hit.flame, stored = ctx.flameDot || G.SKILLS.blackflame.brand ? hit.flame : 0;
      v += (own ? 0 : inTotal) + stored;
    }
    if (!(v > 0)) return;
    const src = own ? ctx.id : 'blackflame';
    if (!e.twin) e.twin = { v: 0, t: 0, by: {} };
    const q = e.twin;
    if (!RQ.twinQ.has(e)) {
      q.v = 0;
      q.by = {};
      q.t = TW.delay;
      RQ.twinQ.add(e);
    }
    q.v += v * TW.k;
    q.by[src] = (q.by[src] || 0) + v * TW.k;
  };
  // 每帧（relicTick）：到时间的落下；敌人死了 / 不在场上的作废
  function twinTick(dt) {
    for (const e of RQ.twinQ) {
      if (e.dead || state.enemies.indexOf(e) < 0) {
        RQ.twinQ.delete(e);
        continue;
      }
      e.twin.t -= dt;
      if (e.twin.t <= 0) {
        RQ.twinQ.delete(e);
        twinStrike(e);
      }
    }
    for (let i = RQ.twinFx.length - 1; i >= 0; i--) {
      const f = RQ.twinFx[i];
      f.t += dt;
      const u = f.t / 0.28;
      if (u >= 1 || !f.h.on) {
        G.world.kvOff(f.h);
        RQ.twinFx.splice(i, 1);
        continue;
      }
      f.h.s = f.s * (1 + u * 0.35);
      f.h.a = 1 - u;
    }
  }
  function twinStrike(e) {
    const q = e.twin, dmg = q.v, W = G.world;
    q.v = 0;
    if (!(dmg > 0)) return;
    const hp0 = e.hp;
    e.hp -= dmg;
    e.hurtAt = state.time;
    combat.dealt = state.time;
    const st = state.stats;
    st.twinHits = (st.twinHits || 0) + 1;
    st.twinDmg = (st.twinDmg || 0) + dmg;
    if (!st.twinBy) st.twinBy = {};
    for (const id in q.by) st.twinBy[id] = (st.twinBy[id] || 0) + q.by[id];
    // 双月：一暖一冷两片背靠背的半月，在胸口一闪（实例化，场上再多也是一次 draw call），数字是冷白色的小字
    const h = e.height || 2, ang = Math.atan2(e.x - P.x, e.z - P.z);
    if (W.kv) {
      // 平铺在脚下：两片半月的内缘落在身形外 0.15 米，身子挡住后半圈（深度测试），不画在怪身上（灰度检查要求怪的亮面不被抬高）
      const s = Math.min(4, (e.r + 0.15) * 3.05);
      RQ.twinFx.push({ t: 0, s, h: W.kv('twin', { x: e.x, y: 0.08, z: e.z, s, hex: twinHex(), a: 1, k: ang + Math.PI / 2 }) });
    }
    const jx = ((st.twinHits % 3) - 1) * 0.3; // 数字左右错开一点（不用随机数：不扰动暴击、伤害的随机序列）
    W.text(e.x + jx, e.z, Math.max(1, Math.round(dmg)), '#cfe8ff', 13, { kind: 'faint', y: Math.min(2.8, h * 0.62) });
    wake(e);
    if (e.hp <= 0) {
      // 打死时的异常（尸爆 / 放电 / 碎冰）照常排进触发队列，当场结算
      procDepth++;
      G.killEnemy(e, { ang, type: 'phys', w: 0, over: Math.min(2, (dmg - hp0) / e.maxHp) });
      procDepth--;
      flushProcs();
    }
  }
  // 双月的颜色：暖金 #ffc070 × fx（另一片取它的 bgr，冷蓝）。fx 压着怪群脚边的亮度（灰度检查：不抬高旁边怪的亮面）
  function twinHex() {
    const f = G.clamp(TW.fx, 0, 1), r = Math.round(0xff * f), g = Math.round(0xc0 * f), b = Math.round(0x70 * f);
    return (r << 16) | (g << 8) | b;
  }
  function twinClear() {
    for (const e of RQ.twinQ) if (e.twin) e.twin.v = 0;
    RQ.twinQ.clear();
    for (const f of RQ.twinFx) G.world.kvOff(f.h);
    RQ.twinFx.length = 0;
  }
  G.twinClear = twinClear;

  // ---------- 暗域（熄烛冠，巅峰）：hitEnemy / hurtPlayer / hurtMinion 里各一行钩子 ----------
  // 暗域增伤（专属词缀 darkDmg）：你的伤害对所有敌人 × (1 + darkDmg%)，召唤物的伤害只对暗域内的敌人（e.dark，enemies.js 每帧算）且按 mk 倍 × (1 + darkDmg% × mk)；
  // 还没发现你（没醒）的敌人，你的第一击必定暴击
  G.relicDarkHit = function (e, ctx, m, minion) {
    const v = Math.max(0, (P.S && P.S.darkDmg) || 0) / 100, k = 1 + v;
    if (minion) return G.calcHit(ctx, e.dark ? m * (1 + v * RM.xizhu.mk) : m);
    if (e.awake) return G.calcHit(ctx, m * k);
    const c0 = ctx.crit;
    ctx.crit = 100;
    try {
      return G.calcHit(ctx, m * k);
    } finally {
      ctx.crit = c0;
    }
  };
  // 面板秒伤（技能卡、物品对比、技能页）把暗域增伤算进去：你的技能对所有敌人都吃；召唤物按目标在暗域里算（它们身边 mr 米就是暗域），按 mk 倍
  const skillDps0 = G.skillDps;
  G.skillDps = (ctx) => {
    if (!P.relic.xizhu) return skillDps0(ctx);
    const v = Math.max(0, (P.S && P.S.darkDmg) || 0) / 100;
    return skillDps0(ctx) * (1 + v * (ctx.minion || ctx.asMinion ? RM.xizhu.mk : 1));
  };
  // 暗域内的敌人造成的伤害倍率：src 是敌人本身，或带 owner 的预警圈 / 弹丸。首领 1 − weakBoss，熄烛者（pin）不吃
  G.darkWeakK = function (src) {
    const e = src && src.owner && typeof src.owner === 'object' ? src.owner : src;
    if (!e || !e.dark || e.dead) return 1;
    const X = RM.xizhu;
    return e.pin ? 1 : e.isBoss ? 1 - X.weakBoss : 1 - X.weak;
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
      more: Math.max(0, (1 + (S.moreDmg || 0) / 100) * (1 + (S.allMore || 0) / 100) * (1 - Math.min(90, S.ownLess || 0) / 100)), extra: {},
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
      const ms = state.minions.filter((m) => !m.dead && !(m.rising > 0) && !(m.ctx && m.ctx.minion && m.ctx.minion.mech === 'bastion')); // 刻式「磐垒」扎根不动，不跟着闪
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

  // ---------- 蓄潮（渊式，怒潮解锁）：旋风斩每一跳的一行钩子，返回这一跳的伤害倍率 ----------
  G.relicSpinPulse = function (ctx) {
    const B = ctx.sk.tide;
    RQ.spin = Math.min(B.max, RQ.spin + 1);
    RQ.spinCtx = ctx;
    RQ.spinR = ctx.sk.radius * Math.sqrt(ctx.area);
    if (G.world.relicTide) G.world.relicTide(P.x, P.z, RQ.spin / B.max);
    if (G.world.rvTide) G.world.rvTide(RQ.spin / B.max);
    return B.pulse;
  };
  // 满层（旋风斩那一下打完）/ 松手 / 翻滚 / 被打断 / 换了别的技能：卷起潮涌——先把 R 内的敌人拽到你脚下（首领不动），
  // 再以你为中心按层数拍下（松手等情况每帧在 relicTick 里检查）。每层 burst 倍满额一跳，拆成拽进来之后的一下，不另加大招
  function relicTideBurst() {
    const n = RQ.spin, ctx = RQ.spinCtx;
    RQ.spin = 0;
    RQ.spinFull = false;
    if (G.world.rvTide) G.world.rvTide(0);
    if (!ctx || n <= 0 || P.dead) return 0;
    const B = ctx.sk.tide, W = G.world;
    const R = RQ.spinR * B.r;
    for (const e of enemiesIn(P.x, P.z, R)) {
      if (e.isBoss || pinned(e) || !G.pullEnemy) continue;
      const d = dist(e.x, e.z, P.x, P.z);
      if (d > B.pull + e.r) G.pullEnemy(e, P.x, P.z, d - B.pull - e.r);
    }
    let hits = 0, crit = false;
    for (const e of whirlCap(enemiesIn(P.x, P.z, R), ctx.sk)) {
      G.hitEnemy(e, ctx, n * B.burst, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: n >= B.max / 2 ? 2 : 1, kb: 0.2, poise: (ctx.sk.poise || 0) * n * B.burst, quiet: true });
      crit = crit || lastHit.crit;
      hits++;
    }
    if (W.rvTideBurst) W.rvTideBurst(P.x, P.z, R, n / B.max);
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
  // 飞刃的渊式「回旋」按 sk.boom（去程穿透所有敌人，回程 back 倍）；戴着回旋时弓 / 左轮的普攻照旧折返（RM.huixuan）
  const BOOM_BASIC = { revolver: 1, huntbow: 1, eagle: 1, runebow: 1, emberbow: 1 };
  G.relicBoomerang = function (p) {
    const sk = p.ctx && p.ctx.sk;
    if (!sk || p.explode > 0 || p.wisp || p.seeker || p.pin) return;
    if (sk.mech === 'boom') {
      p.boom = 1;
      p.boomBack = sk.boom.back;
      p.life *= sk.boom.range;
      return;
    }
    const ok = P.relic.huixuan && sk.basic && BOOM_BASIC[sk.rtype] && !(P.rbuff && P.rbuff.t > 0 && P.rbuff.id === 'volley');
    if (!ok) return;
    p.boom = 1;
    p.boomBack = RM.huixuan.back;
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
    p.boomK = p.boomBack || RM.huixuan.back;
    if (G.world.relicProjTurn) G.world.relicProjTurn(p.mesh, p.dx, p.dz);
    if (p.ctx.sk.mech === 'boom') {
      if (p.mesh && p.mesh.userData) p.mesh.userData.boom2 = true; // 丝线回程变亮
      if (G.world.rvTurn) G.world.rvTurn(p.x, p.z);
    }
    state.stats.relicTurns = (state.stats.relicTurns || 0) + 1;
    return true;
  };

  // ---------- 星雨（陨织袍） ----------
  // 渊式「星雨」（陨织袍解锁）：陨火选着星雨、学了、放在技能栏上
  const starOn = () => G.SKILLS.meteor.mech === 'star';
  const meteorOn = () => !!(starOn() && G.save.skills.meteor && G.save.bar.indexOf('meteor') >= 0 && (!G.save.cls || G.canCast('meteor')));
  // 光环保留里多算的那一份（reservePct 里的一行钩子）
  G.relicReserve = () => (meteorOn() ? G.SKILLS.meteor.star.reserve : 0);
  // 陨火不能手动施放（tryStartCast 里的一行钩子）：轻点只提示一句。返回 true 表示这个键跳过
  G.relicNoCast = function (slot, id) {
    if (id !== 'meteor' || !starOn()) return false;
    if (G.input.tap[slot] > 0) {
      G.input.tap[slot] = 0;
      if (hintDue('relic', 1.5)) {
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
    const ctx = G.skillCtx('meteor');
    const sk = ctx.sk, F = sk.star;
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
  // 渊式「电桥」（电桥戒解锁）：链雷施放之后（SKILL_FX.chain 末尾的一行钩子）。pts[0] 是你，之后是依次打中的目标；
  // 电弧走过的每一段（你 → 第一个目标、目标之间）各留一道，参数在 ctx.sk.bridge
  G.relicBridges = function (pts, ctx) {
    const D = ctx.sk.bridge;
    for (let i = 0; i + 1 < pts.length; i++) {
      while (RQ.bridges.length >= D.max) relicBridgeOff(0);
      const t = D.t * (ctx.durK || 1); // 绵延：电桥留得更久
      const b = { x0: pts[i].x, z0: pts[i].z, x1: pts[i + 1].x, z1: pts[i + 1].z, t, tt: D.tick, ctx, D };
      b.fx = G.world.relicBridgeOn ? G.world.relicBridgeOn(b.x0, b.z0, b.x1, b.z1, t, D.w) : -1;
      RQ.bridges.push(b);
    }
  };
  function relicBridgeOff(i) {
    const b = RQ.bridges[i];
    RQ.bridges.splice(i, 1);
    if (G.world.relicBridgeOff) G.world.relicBridgeOff(b.fx);
  }
  function relicBridgeTick(dt) {
    for (let i = RQ.bridges.length - 1; i >= 0; i--) {
      const b = RQ.bridges[i], D = b.D, half = D.w / 2;
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
      const k = want ? G.VARIANTS.thrall.c.set.king.scale : 1;
      m.r = m.r0 * k;
      m.height = m.h0 * k;
      if (G.world.relicKing) G.world.relicKing(m.ent, k);
      if (G.world.rvCrown) G.world.rvCrown(m.ent, want);
    }
  }

  // ---------- 随核（引力核）：黑洞施放（SKILL_FX.hole 里的一行钩子）和跟随 ----------
  G.relicHole = function (ctx, R, dur) {
    const sk = ctx.sk, Y = sk.follow;
    const r = R * Y.radius;
    G.sfx('cast', { id: ctx.id });
    const h = addHole({ x: P.x, z: P.z, R: r, pullR: r * sk.pullR, t: 0, dur: dur * Y.dur, tick: sk.tick, tt: sk.tick, ctx, mult: Y.dmg, pullMul: Y.pull, mouth: false, follow: true });
    if (h.fx && G.world.rvOrbit) G.world.rvOrbit(h.fx, r);
    return h;
  };
  G.relicHoleList = () => holes.filter((h) => h.follow); // 测试用：场上跟着你的黑洞
  // 跟着你走（updateChaos 每帧调用）；每 wave.iv 秒把 R × wave.k 内的敌人往你身边拽一把（最多 step 米，首领 / 定身的不动）
  G.relicHoleFollow = function (h) {
    h.x = P.x;
    h.z = P.z;
    if (h.fx && G.world.relicHoleAt) G.world.relicHoleAt(h.fx, h.x, h.z);
    const Wv = h.ctx.sk.follow && h.ctx.sk.follow.wave;
    if (!Wv || h.t < (h.waveN || 0) * Wv.iv) return;
    h.waveN = (h.waveN || 0) + 1;
    const R = h.R * Wv.k, core = h.ctx.sk.core;
    for (const e of enemiesIn(h.x, h.z, R)) {
      if (e.isBoss || pinned(e) || !G.pullEnemy) continue;
      const d = dist(e.x, e.z, h.x, h.z);
      if (d > core + e.r) G.pullEnemy(e, h.x, h.z, Math.min(Wv.step, d - core - e.r));
    }
    if (G.world.vSuck) G.world.vSuck(h.x, h.z, R, 0x6a4a80, 4); // 暗紫、稀一点（灰度里不抬亮你周围的地面和怪）
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
    if (RQ.varMin) {
      RQ.varMin = false;
      if (G.refreshMinions) G.refreshMinions();
    }
    if (RQ.slamT > 0) RQ.slamT -= dt;
    if (RQ.chainT > 0) RQ.chainT -= dt;
    if (RQ.shareT > 0) RQ.shareT -= dt;
    // 蓄潮：不在转旋风斩了（松手、翻滚、被打断、换了别的技能、摘下手套），攒着的层数炸开
    if (RQ.spin > 0 && !(P.cast && P.cast.channel && P.cast.id === 'whirl' && G.SKILLS.whirl.mech === 'tide')) relicTideBurst();
    if (starOn()) relicMeteorDue(dt);
    if (RQ.twinQ.size || RQ.twinFx.length) twinTick(dt);
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
    if (G.world.rvTide) G.world.rvTide(0);
    RQ.metT = 0.6;
    RQ.slamT = 0;
    twinClear();
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
    return Math.max(G.chillSlow(e, e.bu.cold), e.bossChill > 0 ? BU.bossSlow : 0, e.bossBind > 0 ? BU.bossBindSlow : 0, G.bastionSlow(e)); // 磐垒的护域：敌人在里面变慢
  };
  // 轻度冰缓的减速比例：冰霜异常值 frac（0..1）大于 0 就有保底，越满越慢（普通 / 精英 / 首领各有上下限，见 G.BUILDUP）
  G.chillSlow = function (e, frac) {
    if (!(frac > 0)) return 0;
    const boss = e && e.isBoss, el = e && e.elite && !boss;
    const lo = boss ? BU.chillMinBoss : el ? BU.chillMinElite : BU.chillMin;
    const hi = boss ? BU.chillBoss : el ? BU.chillElite : BU.chill;
    const k = !boss && G.runMods.ailRes ? G.runMods.ailRes.chillCap : 1; // 渊印「坚蜕」：冰缓 ×0.7（首领不吃）
    return (lo + (hi - lo) * Math.pow(Math.min(1, frac), BU.chillPow)) * k * (e && e.chillK > 0 ? e.chillK : 1); // 深寒：最近一次灌冰霜的技能镶着它
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
  // vf-vfx3：飘字用的伤害类型色，压在同一亮度带（灰度 65–75 %）：黑描边上一眼分得出类型，又不和暴击的金白字心、终结技的纯白抢
  const NUM_COLOR = { phys: '#c6bcaa', fire: '#ff9a50', cold: '#78c6f2', light: '#e2be40', chaos: '#ff86dc' };
  G.hitEnemy = function (e, ctx, mult, info) {
    if (!e || e.dead) return 0;
    const W = G.world;
    const sk = ctx.sk;
    const inf = info || NO_INFO;
    const PO = G.POISE;
    const broken = e.brokenT > 0;
    // rqBrk：渊契「崩势」扩散出来的破绽；渊印「领群」：领群者附近同群的怪受到的伤害 −15%；encDR：异兆的减伤（灰誓者有图腾立着时）
    const m = (mult === undefined ? 1 : mult) * (broken || e.rqBrk > 0 ? PO.taken : 1) * (e.auraBuff ? 1 - G.runMods.aura.dr : 1) * (e.encDR > 0 ? 1 - e.encDR : 1);
    e.hurtAt = state.time; // 渊印「回生」：几秒没挨打才回血
    combat.dealt = state.time; // 含流血等持续伤害、召唤物的命中（都走这里）
    const hit = P.relic.xizhu ? G.relicDarkHit(e, ctx, m, !!(inf.minion || ctx.minion || ctx.asMinion)) : G.calcHit(ctx, m); // 渊契「暗域」：增伤、没发现你时必暴
    const hp0 = e.hp;
    // 敌人的元素抗性：穿透 = 技能的（破障）+ 你亲手的命中再加装备上的「元素穿透」（召唤物不吃）。
    // 异常触发的伤害（ctx.proc：爆燃 / 电弧 / 尸爆 / 放电 / 锁链等）本来就是按扣过抗性的伤害算的，不再扣一次
    // 借火（class-d2b1）：召唤物每一击附带一份火焰伤害
    if (inf.minion && !ctx.proc && P.lend && P.lend.t > 0) {
      const a = (hit.total * P.lend.fire) / 100;
      hit.parts.fire = (hit.parts.fire || 0) + a;
      hit.total += a;
    }
    if (!ctx.proc) G.applyResist(e, hit, (ctx.pen || 0) + (inf.minion || ctx.minion || ctx.asMinion ? 0 : P.S.elemPen || 0));
    e.hp -= hit.total;
    if (ctx.bleed > 0 && !ctx.proc && hit.parts.phys > 0 && e.hp > 0) addBleed(e, (hit.parts.phys * ctx.bleed) / 100, ctx.sk.bleedCap); // 流血：这一击的物理部分（剜创：它打中的最多叠 bleedCap 层）
    if (ctx.x && ctx.x !== NO_X) {
      if (ctx.x.cull) cullCheck(e, ctx); // 断命
      if (ctx.x.splash) splashQueue(e, ctx, hit, inf); // 溅击
    }

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
        W.text(tx, tz, shown, NUM_COLOR[top] || G.TYPE_COLOR[top], 11, { kind: 'faint', y: ty });
      }
    } else if (w >= 2) W.text(tx, tz, shown + (hit.crit ? '!' : ''), G.TYPE_COLOR[top], hit.crit ? 30 : 23, { kind: 'big', y: ty });
    else {
      // vf-vfx3：普通数字的字号随这一下占怪最大生命的比例 −15 % … +20 %（小怪身上打出的大数更大，首领身上的零碎更小），暴击只放大；普通数字用同一亮度带的数字色（NUM_COLOR），
      // 同一只怪 0.25 秒内的普通数字并成一个往上跳的数（W.text 的 key / val）
      const nk = 0.85 + 0.35 * Math.min(1, Math.sqrt(Math.max(0, hit.total / Math.max(1, e.maxHp)) * 2));
      if (hit.crit) W.text(tx, tz, shown + '!', G.TYPE_COLOR[top], Math.round(24 * Math.max(1, nk)), { kind: 'crit', y: ty }); // 暴击只放大不缩小：始终比普通数字（最大 19）大一号
      else W.text(tx, tz, shown, NUM_COLOR[top] || G.TYPE_COLOR[top], Math.round(16 * nk), { y: ty, key: e, val: shown });
    }

    if (inf.aura) {
      // 光环：只在身上闪一点霜屑，不闪白、不后仰
      W.frostSparkle(e.x, h * 0.55, e.z, e.r);
    } else if (inf.dot) {
      // 流血的跳：不闪白、不后仰、不甩命中火花（掉落的暗红碎屑在 tickBleed 里另放）
    } else {
      if (!inf.splash && !inf.noFlash) W.flash(e.ent, 1 + feel * 0.7 + (hit.crit ? 0.5 : 0)); // 溅击的溅射不闪白（一下溅到一群时整群闪白会糊成一片，闪白有下限、调不淡）；vf-vfx2：暴击再亮一点
      W.hitReact(e.ent, ang, 0.9 + feel * 0.4); // 顺着这一击的方向一仰
      // 持续伤害的跳（黑洞 / 黑旋风，inf.tick）：只甩几片实例化的尖片，不留地面贴花、不打闪光（怪堆里每秒几十跳，贴花每片一次 draw call）
      if (inf.tick && W.chaosTick) W.chaosTick(e.x - sn * e.r * 0.7, h * 0.5, e.z - cs * e.r * 0.7, ang, hit.crit);
      else if (inf.splash !== 2) W.impact(e.x - sn * e.r * 0.7, h * 0.5, e.z - cs * e.r * 0.7, ang, top, feel, hit.crit); // 溅击：一次溅射只给前 3 个敌人冒火花
      if (ctx.flame > 0 && W.flameHit) W.flameHit(e.x, h * 0.55, e.z, e.r, ang); // 黑焰：命中点甩出几片品红的小火舌
    }
    // vf-vfx2：重击档的法术暴击顿一下、镜头轻震（法术来源每 0.3 秒最多一次；持续伤害 / 光环 / 召唤物 / 异常触发的不算）
    if (hit.crit && w >= 2 && !inf.tick && !inf.aura && !inf.proc && !inf.splash && !inf.minion && !ctx.minion && !ctx.asMinion && sk.tags && sk.tags.indexOf('spell') >= 0 && G.spellStop(40)) W.shake(0.1);
    if (!inf.quiet) {
      // 投射物 / 法术逐个出声；暴击时镜头也轻轻一顶（近战由技能统一处理）
      G.sfx('impact', { type: top, w, crit: hit.crit, id: ctx.id });
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
    const q0 = procQ.length;
    if (!inf.noBuild) addBuildUp(e, hit.parts, ctx.ailment, procQ, ctx.bindAil);
    if (ctx.x && (ctx.x !== NO_X || e.chillK)) supXAil(e, ctx, hit, q0); // 烈爆 / 深寒 / 雷涌
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
    if (hit.flame > 0 || (VS.cores.length && hit.parts.fire > 0 && !inf.core)) vHit(e, hit, inf); // 刻式：蚀印 / 传焰 / 熔核
    if (P.relic.shuangsheng) G.relicTwinHit(e, ctx, hit, inf); // 渊契「双生」：刻式技能的命中，稍后余响一次
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
    if (e.vDot && e.vDot.pool > 0) dotJump(e); // 刻式「传焰」：宿主死了，没烧完的黑焰跳出去
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
    if (P.uMech === 'relight') relightCheck(e); // 长明「续火」（class-d2b1）
    // 烬断（残刃）：倒下的敌人身上的残刃飞到 MARK.jump 米内最近的敌人身上接着叠（够层数就引爆）
    if (e.marks > 0) {
      if (P.uMech === 'blade') markJump(e);
      e.marks = 0;
      if (W.bladeMarks) W.bladeMarks(e.ent, 0);
    }

    // 经验
    // 压级衰减 / 越级封顶见 data.js 的「经验」；渊印的经验加成 X，领群者另 × 2
    const xp = G.killXp(e, save.level) * (1 + G.runMods.xp) * (e.leader && G.runMods.aura ? G.runMods.aura.xp : 1);

    if (P.S.lifeOnKill > 0) G.healPlayer(P.S.lifeOnKill);
    const charge = (0.12 + (e.elite ? 1 : 0) + (e.isBoss ? 3 : 0)) * (G.runMods.drain ? 1 - G.runMods.drain.flask : 1); // 渊印「枯竭」：充能 −30%
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

    if (!e.encNoLoot) G.encDropLoot(e); // 异兆：游荡者 / 残影 / 静物的奖励走异兆自己的结算；祈坛「丰饶」放大物品 / 通货
    G.gainXp(xp);
    sealOnKill(e);
    if (e.enc || e.encClones) G.encOnKill(e);

    if (e.isBoss && e.pin) G.pinKill(e); // 熄烛者：不记区域通关、不开下一层，掉落走 §6.6
    else if (e.isBoss && !e.echo) {
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
      G.questSync(true); // 主线：首领步（cleared 刚写入）
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
    combat.taken = state.time;
    if (P.relic.xizhu) amount *= G.darkWeakK(src); // 渊契「暗域」：域内的敌人伤害降低
    if (P.relic.tongshang) amount = G.relicShareHurt(amount, dtype, src); // 渊契「同殇」
    const W = G.world;
    let dmg = amount;
    if (!dtype || dtype === 'phys') dmg *= 1 - Math.min(0.8, P.armour / (P.armour + 10 * amount));
    else dmg *= 1 - (P.res[dtype] || 0) / 100;
    // 渊印「焚染 / 霜染 / 雷染」：怪物的每一击另带 frac 倍的该元素伤害（吃抗性）；地形、余烬地、殁爆不带（src 为空或 sealFx）
    const TI = G.runMods.tint;
    if (TI && src && !src.sealFx) dmg += amount * TI.frac * (1 - (P.res[TI.el] || 0) / 100);
    dmg *= 1 - Math.min(90, P.S.lessTaken || 0) / 100;
    dmg *= 1 + Math.max(0, P.S.moreTaken || 0) / 100; // 基石「刃舞」的代价
    dmg *= G.bastionK(P.x, P.z); // 刻式「磐垒」：站在护域里少受伤
    if (src && (src.pin || (src.owner && src.owner.pin))) dmg = Math.min(dmg, P.maxLife * G.PIN.hitCap); // 熄烛者：单次最多扣 hitCap（不会一下打空）
    dmg = Math.max(1, dmg);
    if (P.vShield && P.vShield.v > 0) {
      // 刻式「过载」的雷盾：先吸掉这一下
      const ab = Math.min(P.vShield.v, dmg);
      P.vShield.v -= ab;
      dmg -= ab;
      if (P.vShield.v <= 0) vShieldOff();
      if (dmg <= 0) {
        W.text(P.x, P.z, '吸收', '#ffe45e', 14);
        return true;
      }
    }

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
    if (state.pin && G.pinDeath()) return; // 余烛殿：熄一盏魂灯；第 3 次倒下失败退出（不在这里重生）
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
    clearSealFx(); // 余烬地也一起灭掉
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
    const l = Math.hypot(dx, dz);
    if (t.shape === 'arc') return l <= t.r && (l < 1e-6 || Math.abs(angDiff(Math.atan2(dx, dz), t.ang)) <= t.arc); // 扇形（D5 拂烛）
    if (t.shape === 'ring') return l <= t.r && l >= t.rin; // 圆环（D5 焰潮）
    return l <= t.r;
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
      if (p.ctx && p.ctx.x && p.ctx.x.projSpd && !p.forked) p.speed *= G.projSpdK(p.ctx); // 远劲：飞得更快，飞行时间不变 → 射程一起放大（分岔分出来的已经带着母弹的速度）
      if (!p.hit) p.hit = new Set();
      p.pierce = p.pierce || 0;
      p.chain = p.chain || 0;
      p.explode = p.explode || 0;
      if (P.relic.huixuan || (p.ctx && p.ctx.sk && p.ctx.sk.mech === 'boom')) G.relicBoomerang(p); // 渊式「回旋」/ 渊契「回旋」的普攻折返
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
    if (p.boom && p.ctx.sk.mech === 'boom' && W0.rvThread) W0.rvThread(p.mesh); // 渊式「回旋」：你和利刃之间的丝线
    state.projectiles.push(p);
    return p;
  };

  const recentVolleys = []; // 最近伤到过玩家的齐射编号

  // 敌方弹丸撞上召唤物：挡在弹道上的召唤物吃下这一发，弹丸就此消失（p.pierce > 0 的才继续飞，敌方弹丸目前都不穿透）。
  // 同一轮齐射对同一只召唤物只结算一次伤害（和玩家一样：贴脸吃满一圈弹幕不会被瞬间打空），后到的弹丸照样被它挡下。
  // 候选：这一帧弹道的包围盒附近的召唤物（minionsNear 每发弹丸每帧筛一次，通常 0～2 只），每小步只和它们比距离
  const _mNear = [];
  function minionsNear(p, total) {
    _mNear.length = 0;
    const ms = state.minions, pad = p.r + 1.0; // 1.0：最大的召唤物（守像）半径 0.95
    const x0 = Math.min(p.x, p.x + p.dx * total) - pad, x1 = Math.max(p.x, p.x + p.dx * total) + pad;
    const z0 = Math.min(p.z, p.z + p.dz * total) - pad, z1 = Math.max(p.z, p.z + p.dz * total) + pad;
    for (let j = 0; j < ms.length; j++) {
      const m = ms[j];
      if (m.dead || m.rising > 0 || m.x < x0 || m.x > x1 || m.z < z0 || m.z > z1) continue;
      _mNear.push(m);
    }
    return _mNear.length;
  }
  // 这一小步撞上了候选里的哪只召唤物：结算并返回 true（弹丸该消失）；没撞上 / 穿透了返回 false
  function hostileHitsMinion(p) {
    for (let j = 0; j < _mNear.length; j++) {
      const m = _mNear[j];
      if (m.dead || dist(m.x, m.z, p.x, p.z) > p.r + m.r) continue;
      if (p.mHit && p.mHit.indexOf(m) >= 0) continue; // 穿透弹已经打过它
      const v = p.volley;
      if (v === undefined || v === null || m.volley !== v) {
        if (v !== undefined && v !== null) m.volley = v;
        G.hurtMinion(m, p.dmg, p.dtype, { x: p.x - p.dx, z: p.z - p.dz, owner: p.shooter || null });
      }
      if (!projFx(p, 'hit')) G.world.burst(p.x, 1.1, p.z, p.color, 6, 3, 0.25);
      if (p.pierce > 0) {
        p.pierce--;
        (p.mHit || (p.mHit = [])).push(m);
        continue;
      }
      return true;
    }
    return false;
  }

  // 散钉：同一次施放对这个敌人还能不能再中一枚（能就记上一枚）
  function capTake(p, e) {
    const n = p.capMap.get(e) || 0;
    if (n >= p.hitCap) return false;
    p.capMap.set(e, n + 1);
    return true;
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
      G.hitEnemy(e, p.ctx, p.blastMult || 1, { ang: Math.atan2(e.x - p.x, e.z - p.z), kb: p.kb, poise: p.poise }); // 从爆心往外推；blastMult：灵弹这一段的倍率
    }
    if (p.burst) staffBurst(p, R, skip); // 灵弹的重弹：按元素追加
    // 魂火炸开有自己的特效（world.wispBurst，可选）
    if (!(p.wisp && fxOpt('wispBurst', p.x, p.z, R, p.color)) && !projFx(p, 'blast', R)) {
      W.ring(p.x, p.z, R, p.color, 0.3);
      W.burst(p.x, 1.0, p.z, p.color, 16, 6, 0.4);
    }
  }

  // 玩家投射物命中一个敌人后的去留；返回 false 表示投射物消失
  function afterPlayerHit(p, e) {
    if (p.ctx.x && p.ctx.x.fork) forkProj(p, e); // 分岔
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

  G.updateProjectiles = function (dt) {
    flushSplash(); // 溅击：这一帧的近战挥砍都打完了，统一结算溅射
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
      // 分小步前进，快的投射物不会穿过细小目标
      const total = p.speed * dt;
      const steps = Math.max(1, Math.ceil(total / 0.45));
      const step = total / steps;
      const mNear = p.owner !== 'p' && state.minions.length && G.hurtMinion ? minionsNear(p, total) : 0; // 敌方弹丸：这一帧可能撞上的召唤物
      for (let s = 0; s < steps && alive; s++) {
        p.x += p.dx * step;
        p.z += p.dz * step;
        if (p.skip && (p.skip.d += step) >= p.skip.seg && !skipLand(p)) {
          alive = false; // 刻式「跳焰」：跳完最后一下
          break;
        }
        if (!W.shotFree(p.x, p.z, -0.4)) {
          if (p.boom === 1 && G.relicTurn(p, step)) break; // 渊契「回旋」：第一次撞墙折返
          if (p.skip && skipWall(p, step)) break; // 刻式「跳焰」：撞墙弹回来接着跳
          if (p.pin) {
            // 刻式「钉刃」：撞墙就立在墙前
            p.x -= p.dx * step;
            p.z -= p.dz * step;
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
          if (p.skip) continue; // 跳焰飞在半空：不碰敌人，落地才炸
          for (const e of state.enemies) {
            if (e.dead || p.hit.has(e)) continue;
            if (dist(e.x, e.z, p.x, p.z) > p.r + e.r) continue;
            p.hit.add(e);
            if (p.capMap && (p.capMap.get(e) || 0) >= p.hitCap) continue; // 散钉：这个敌人这一把已经中满，钉子穿过去
            if (p.stick) {
              // 刻式「黏焰」：粘上去，不当场伤害
              emberStick(p.ctx, e, 0, 1);
              alive = false;
              break;
            }
            // 同一次施放的多枚投射物不叠加命中同一个敌人（多重投射打单体不会变成数倍伤害）；
            // 后到的那枚照常消耗穿透 / 连锁 / 引爆，只是不再对它结算直击
            if (p.capMap ? capTake(p, e) : !p.cast || !p.cast.has(e)) {
              if (p.cast) p.cast.add(e);
              // 远程武器的箭 / 子弹：multFn 算这一下的倍率（鹰眼的远距离加成），after 接着结算余烬 / 元素爆炸 / 熔芯弹；src 让专注按箭计数
              const m = (p.multFn ? p.multFn(p, e) : p.mult || 1) * (p.boomK || 1); // boomK：回旋的回程
              G.hitEnemy(e, p.ctx, m, { ang: Math.atan2(p.dx, p.dz), src: p, aura: p.aura, minion: p.minion, kb: p.kb, poise: p.poise }); // 顺着弹道推；aura：霜环「冰棱」的冰棱和光环脉冲一样不算连击；minion：骸弓的骨箭算召唤物的；kb / poise：灵弹的重弹（缺省按技能）
              if (p.after) p.after(p, e, lastHit.killed, lastHit.crit);
              if (p.ctx.sk.mech === 'hook' && !e.dead) nailHook(p, e); // 刻式「钩钉」：往你身边拽
            }
            if (!p.explode) projFx(p, 'hit'); // 飞刃擦过敌人的金属火花（爆炸弹的特效在爆炸那一下）
            if (p.pin) {
              bladePin(p, e); // 刻式「钉刃」：钉住第一个，立在它脚下
              alive = false;
              break;
            }
            alive = afterPlayerHit(p, e);
            break; // 每小步最多命中一个
          }
        } else {
          // 召唤物挡在弹道上：它吃下这一发，弹丸到此为止，身后的玩家不再挨这一下
          if (mNear && hostileHitsMinion(p)) {
            alive = false;
            break;
          }
          if (P.dead || dist(P.x, P.z, p.x, p.z) > p.r + 0.5) continue;
          // 同一轮齐射（volley 相同）只结算一次伤害：贴脸吃满一圈弹幕不该被瞬间打空
          const v = p.volley;
          const from = { x: p.x - p.dx, z: p.z - p.dz, owner: p.shooter || null };
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
        if (p.pin && !p.pinned) bladePin(p, null); // 钉刃没碰到敌人：立在飞行的尽头 / 墙前
        if (p.onEnd && !p.ended) {
          // class-d2b1：点灯落地留灯、铁水弹 / 雷网的楔子没打中时落在尽头（只调一次；自己看 p.didHit / p.lampAt）
          p.ended = true;
          p.onEnd(p);
        }
        // 到达射程尽头的爆炸弹也要炸开（fizzle 的——魂火——没碰到敌人就悄悄散掉）
        if (p.life <= 0 && p.owner === 'p' && p.explode > 0 && !p.fizzle) explodeAt(p, null);
        else if (p.life <= 0 && p.fizzle) W.burst(p.x, 1.1, p.z, p.color, 6, 2, 0.3);
        const idx = list.indexOf(p);
        if (idx >= 0) removeProjectile(idx);
        continue;
      }
      let py = 1.1;
      if (p.skip) {
        // 跳焰：每一跳一道抛物线（落地 0.3，最高 1.9）
        const k = Math.min(1, p.skip.d / p.skip.seg);
        py = 0.3 + 1.6 * 4 * k * (1 - k);
      } else if (p.y0 !== undefined) {
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

  // 职业（class-d2）：变灰的宝石（别的职业的 / 手里武器不对）按下去不放，轻点时头上提示一句原因
  function classNoCast(slot, id) {
    const b = G.castBlock(id);
    if (!b) return false;
    if (G.input.tap[slot] > 0) {
      G.input.tap[slot] = 0;
      if (hintDue('clsCast', 1.5)) G.world.text(P.x, P.z, b.text, '#c9c2b4', 14);
    }
    return true;
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
          if (hintDue('noWeapon', 1.5)) {
            G.world.text(P.x, P.z, '没有武器，没有武器技', '#c9c2b4', 14);
          }
        }
        continue;
      }
      if (!id || !G.SKILLS[id] || (!isWs && !G.SKILLS[id].basic && !save.skills[id])) continue;
      if (id === 'meteor' && G.relicNoCast(slot, id)) continue; // 渊式「星雨」：陨火只能自动落下
      if (!isWs && !G.SKILLS[id].basic && save.cls && classNoCast(slot, id)) continue; // 职业（class-d2）：变灰的宝石放不出来
      if (chan && chan.slot === slot) continue; // 还按着正在转的那个键：接着转，不从头起
      // 刻式：坍缩的黑洞还在时再按引爆、掷旋飞出去时再按召回（不看冷却、不扣消耗）；掷旋飞着时按住不放也不再掷
      const rc = vRecast(slot, id);
      if (rc === 1) return true;
      if (rc === 2) continue;
      if (P.cds[id] > 0) continue;
      if (isWs && G.SKILLS[id].rgauge && !G.gaugeReady()) {
        // 远程武器的 R：量表没满放不出来，轻点只提示一句
        if (G.input.tap[slot] > 0) {
          G.input.tap[slot] = 0;
          const rw = G.rangedWeapon();
          if (rw && hintDue('gauge', 1.2)) {
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
          if (hintDue('aura', 1.5)) {
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
        if (hintDue('noCost', 1.2)) {
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
      if (sk.kind === 'spin' && sk.mech !== 'throw') {
        // 持续施放：没有固定时长，按住就一直转。第一下很快出手，之后每 iv 秒一下；出手之后随时可以接别的动作（刻式「掷旋」是一次普通的掷出）
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
      if (sk.kind === 'tether') {
        // 引雷：持续施放，按住就一直引。第一跳很快出手，之后每 time 秒一跳；加成状态记在这次施放上（停手 / 换技能就从零开始）
        comboReset();
        P.cast = {
          slot, id, t: 0, fired: false, aim: ang, step: -1, st: null, channel: true, tether: true,
          fireT: Math.min(0.08, ctx.time * 0.4), nextT: Math.min(0.08, ctx.time * 0.4), cancelT: Infinity, dur: Infinity, pulses: 0, move: sk.move || 0.4,
          rampT: 0, rampK: 1, lastZap: -1, lastHit: -1, tgt: null, tgtOn: false, lx: P.x, lz: P.z,
        };
        G.world.play(P.ent, 'cast', { loop: true, dur: 0.5 });
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
      } else if (sk.cyc) {
        // 施法武器普攻的出手节奏（灵弹三下一轮、疾咒左右换手）：借连招的计数（停手、翻滚、放别的技能照样从头来），但这一下仍是普通施法
        if (P.combo.id !== id) comboReset();
        P.combo.id = id;
        step = P.combo.step % sk.cyc.length;
      } else {
        comboReset();
      }
      const cs = sk.cyc && !st ? sk.cyc[step] : null;
      const sp = ctx.speed;
      // fireT：生效时刻；cancelT：之后可以接下一个动作（下一段 / 别的技能）；dur：没有后续输入时动作自然结束
      const c = (P.cast = {
        slot, id, t: 0, fired: false, aim: ang, step, st, cs,
        dur: st ? (st.time + st.tail) / sp : cs ? cs.time / sp : ctx.time,
        fireT: st ? st.hit / sp : cs ? (cs.time * (cs.hit || 0.5)) / sp : ctx.time * 0.5,
        cancelT: st ? st.time / sp : cs ? cs.time / sp : ctx.time,
      });
      // 出手动作：连击三段各有各的挥法，其余按技能类型；命中帧对在生效的时刻
      const kind = sk.kind;
      const clip = st ? st.clip : cs ? cs.clip : sk.bclip || (kind === 'proj' || sk.mech === 'throw' ? 'throw' : kind === 'blink' ? 'blink' : kind === 'melee' ? 'attack1' : 'cast'); // 召唤也用施法动作；bclip：武器普攻自己的出手动作
      if (kind === 'round' && G.roundShape().move) c.mv = G.roundShape().move; // 特殊弹 + 左轮：可以边走边打（照常经过上面的职业 / 魔力 / 冷却检查）
      G.world.play(P.ent, clip, { dur: st ? c.dur + 0.1 : c.dur * 1.3, contact: c.fireT });
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
    if (P.cast && P.cast.flicker && VS.marks.size) shadeMarkBurst(); // 刻式「影印」：连斩停下时所有影印一齐引爆
    const tc = P.cast && P.cast.tether;
    P.cast = null;
    P.spinning = false;
    if (G.world.clipOf(P.ent) === 'spin' || (tc && G.world.clipOf(P.ent) === 'cast')) G.world.stop(P.ent, 0.16);
  }

  function updateChannel(c, dt) {
    c.t += dt;
    c.aim = aimInfo().ang;
    P.face = c.aim;
    const held = slotHeld(c.slot) && G.save.bar[c.slot] === c.id;
    // 至少转出一下；之后一松手就停（刻式「旋涡斩」松手时砸地收尾）
    if (c.pulses > 0 && !held) {
      if (G.SKILLS[c.id].mech === 'pull') return whirlSlam(c);
      endChannel();
      return;
    }
    if (c.t < c.nextT) return;
    const ctx = G.skillCtx(c.id);
    if (!G.canAfford(ctx.cost)) {
      if (hintDue('noCost', 1.2)) {
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
    if (ctx.sk.mech === 'pull' && c.pulses >= ctx.sk.pull.max && P.cast === c) whirlSlam(c); // 旋涡斩：转满就砸
  }

  // ---------- 影步连斩 ----------
  // 每一下分两拍：先闪到目标身边（闪现途中无敌），lead 秒后落地出刀（这一刻不无敌）
  const _fs = { e: null, x: 0, z: 0, a: 0 };
  const FLICK_TRY = [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.5, -2.5, Math.PI]; // 落点从首选方位往两边依次偏开
  const FLICK_TURN = 2.4; // 反复砍同一个目标时，每次落点绕着它转过的角度（约 137°，几刀下来落点散在四周）

  function flickerNoTarget() {
    if (hintDue('noTarget', 1.2)) {
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
    if (c) {
      // 候选全都砍过了：这一轮结束，计数清零
      if (_cand.every((it) => c.hit.get(it.e) > 0)) c.hit.clear();
      const S = FLICK_SCORE;
      for (const it of _cand) {
        const e = it.e;
        let n = 0; // 以它为中心这一刀能砍到几个（含它自己）
        for (const o of state.enemies) if (!o.dead && dist(o.x, o.z, e.x, e.z) - o.r <= R) n++;
        it.score = n * S.crowd - (c.hit.get(e) || 0) * S.hit - (e === c.last ? S.last : 0) - it.dp * S.far;
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
      if (hintDue('noCost', 1.2)) {
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
    if (sk.mech === 'clone') shadeClone(ctx, e, cx, cz, R); // 刻式「影分」：另一侧的影子 0.3 秒后补这一刀
    if (!hits.length) return;
    let crit = false;
    let top = 'phys';
    for (const o of hits) {
      G.hitEnemy(o, ctx, 1, { ang: Math.atan2(o.x - P.x, o.z - P.z), w: 0, kb: sk.kb, poise: sk.poise, quiet: true });
      crit = crit || lastHit.crit;
      top = lastHit.type;
      if (sk.mech === 'mark' && !o.dead) {
        // 刻式「影印」：烙一层；已经烙满的当场引爆它身上的（这一刀不再烙）
        if ((o.vMark || 0) >= sk.mark.max) markPop(o, ctx, sk.mark);
        else markAdd(o, sk.mark);
      }
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
          if (ctx.x.charges || CHG[c.id]) G.useCharge(c.id, ctx); // 储能：扣一次存货
        }
        c.fired = true;
        if (c.st) {
          // 这一段打出去了：下一次出下一段，窗口从「可以接下一段」的时刻算起
          P.combo.step = (c.step + 1) % ctx.sk.combo.length;
          P.combo.t = c.cancelT - c.fireT + COMBO_WINDOW;
        } else {
          if (c.cs) {
            // 施法普攻的下一段（同连招的窗口）
            P.combo.step = (c.step + 1) % ctx.sk.cyc.length;
            P.combo.t = c.cancelT - c.fireT + COMBO_WINDOW;
          }
          G.sfx('cast', { id: c.id, type: mainType(ctx) });
        }
        G.execSkill(ctx, c.st || c.cs || undefined);
        for (let i = 1; i <= ctx.echo; i++) {
          G.after(0.22 * i, () => {
            if (!P.dead) G.execSkill(ctx, c.cs || undefined); // 回响：灵弹的重弹也重放成重弹
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
  const rainsLive = []; // 坠凌：还在下的冰凌雨（只记有 sk.max 上限的那几种），换区时清掉
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
    if (!fxOpt('emberGround', f.x, f.z, f.r, f.dur, f.kind === 'burn', !!f.noDecal)) G.world.decal(1, f.x, f.z, f.r * 0.9, Math.random() * TAU, f.hex || 0xff7a2c, f.dur);
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
        G.hitEnemy(e, f.ctx, f.mult, { ang: Math.atan2(e.x - f.x, e.z - f.z), w: 0, kb: 0, poise: 1, quiet: true, faint: true, extra: true, minion: f.minion || undefined });
      }
    }
  }
  G.rangedFields = () => fields;
  G.vField = (f) => addField(f); // 刻式「焰田」：祭司的火弹落地留火地（minions.js 调用）

  // =====================================================================
  // 施法武器的普攻：灵弹（三下一轮，重弹按元素追加）、疾咒（咒痕）
  // =====================================================================
  // 灵弹的一枚：和普通投射物一样吃多重投射 / 穿透 / 连锁；倍率、个头、飞行速度、炸开的半径按这一段（cs）。
  // 重弹带上 burst（这一下的元素和 data 的追加参数），炸开时由 staffBurst 结算
  function staffBolt(ctx, a, cs) {
    const sk = ctx.sk;
    const n = Math.max(1, ctx.proj);
    const spread = Math.min(60, 12 * (n - 1)) * DEG;
    const stepA = n > 1 ? spread / (n - 1) : 0;
    const el = mainType(ctx);
    const B = cs.heavy && sk.burst ? sk.burst[el] : null; // 伤害被转换成物理之类时没有追加
    const mult = B && B.orb ? B.orb : cs.mult; // 火的重弹本身轻一些（orb），剩下的在燃地里
    const cast = new Set();
    const tint = infuseHex(ctx);
    const speed = cs.speed || sk.speed;
    for (let i = 0; i < n; i++) {
      const ang = a.ang - spread / 2 + stepA * i;
      const dx = Math.sin(ang);
      const dz = Math.cos(ang);
      G.spawnProjectile({
        owner: 'p', x: P.x + dx * 0.7, z: P.z + dz * 0.7, dx, dz,
        speed, r: cs.projR || sk.projR, life: 30 / speed, color: G.TYPE_HEX[el],
        ctx, pierce: ctx.pierce, chain: ctx.chain, explode: cs.explode || sk.explode, hit: new Set(), cast,
        vk: cs.vk || sk.vk, tint, mult, blastMult: mult, kb: cs.kb, poise: cs.poise,
        burst: B ? { el, B } : null,
      });
    }
    if (cs.heavy) state.stats.cbHeavy = (state.stats.cbHeavy || 0) + 1;
  }
  // 重弹炸开（爆炸已经结算完，p.cast 里是这一次施放炸到 / 直击过的敌人）：按元素追加一次（连锁 / 穿透再炸不再追加）。
  // 直接打中了敌人（e）时追加的东西以它为中心（燃地铺在它脚下），不然以炸开的那一点为中心
  function staffBurst(p, R, e0) {
    const { el, B } = p.burst;
    p.burst = null;
    const W = G.world;
    const ctx = p.ctx;
    const hex = p.color;
    const ak = Math.sqrt(ctx.area);
    const st = state.stats;
    const ox = e0 ? e0.x : p.x;
    const oz = e0 ? e0.z : p.z;
    if (el === 'fire') {
      // 燃地：吃范围加成，和喷枪的余烬同一套（每个敌人在同一类火里每 tick 秒只挨一下）
      addField({ kind: 'cbfire', x: ox, z: oz, r: B.r * ak, dur: B.dur, tick: B.tick, mult: B.tickMult, ctx, key: 'cbBurnAt', hex: 0xff7a2c });
      st.cbFire = (st.cbFire || 0) + 1;
    } else if (el === 'cold') {
      // 冰棱：从爆心往外均匀飞出 n 根（第一根顺着弹道），炸到的敌人直接穿过、每个敌人至多挨一根；飞行距离吃范围加成
      const skip = new Set(p.cast);
      const cast = new Set();
      const a0 = Math.atan2(p.dx, p.dz);
      const len = B.len * ak;
      for (let i = 0; i < B.n; i++) {
        const a = a0 + (i * TAU) / B.n + Math.PI / B.n;
        const dx = Math.sin(a);
        const dz = Math.cos(a);
        G.spawnProjectile({
          owner: 'p', x: ox + dx * 0.4, z: oz + dz * 0.4, dx, dz, speed: B.speed, r: 0.25, life: len / B.speed, color: hex,
          ctx, pierce: 0, chain: 0, explode: 0, hit: new Set(skip), cast, vk: 'ishard', mult: B.mult, kb: 0.4, poise: 4,
        });
      }
      for (const e of p.cast) if (!e.dead) G.fillMeter(e, 'cold', B.chill); // 炸到的再灌一截冰缓
      st.cbCold = (st.cbCold || 0) + 1;
    } else if (el === 'light') {
      // 电弧：爆炸圈外、r 米内最近的 n 个（看得见的）敌人；一道折线从第一个经爆心连到第二个（一次 draw call）
      const pick = [];
      for (const e of state.enemies) {
        if (e.dead || p.cast.has(e)) continue;
        const d = dist(e.x, e.z, ox, oz);
        if (d - e.r > B.r * ak || !losClear(ox, oz, e.x, e.z)) continue;
        pick.push({ e, d });
      }
      pick.sort((u, v) => u.d - v.d);
      const pts = [{ x: ox, z: oz }];
      for (let i = 0; i < Math.min(B.n, pick.length); i++) {
        const e = pick[i].e;
        if (i === 0) pts.unshift({ x: e.x, z: e.z });
        else pts.push({ x: e.x, z: e.z });
        G.hitEnemy(e, ctx, B.mult, { ang: Math.atan2(e.x - ox, e.z - oz), quiet: true });
        st.cbArcHits = (st.cbArcHits || 0) + 1;
      }
      if (pts.length > 1) W.bolt(pts, hex);
      st.cbLight = (st.cbLight || 0) + 1;
    }
    fxOpt('cbBurst', ox, oz, R, el, hex); // 元素的形状（world.cbBurst：火舌 / 冰晶 / 电花），没有时只有爆炸本身
  }

  // 疾咒的咒痕：CB.marks 是身上有咒痕的敌人（层数 e.cbMark、最后一次叠上的时刻 e.cbMarkT、脚下符环的句柄 e.cbMarkFx）
  const CB = { marks: new Set() };
  function wandMark(e, ctx) {
    if (!e) return;
    const M = ctx.sk.mark;
    if (e.dead) {
      // 这一下打死了它：叠满了照样引爆（跳向其余带咒痕的），没满就算了
      if ((e.cbMark || 0) + 1 >= M.max) wandPop(e, ctx);
      else if (CB.marks.has(e)) wandUnmark(e);
      return;
    }
    e.cbMark = Math.min(M.max, (e.cbMark || 0) + 1);
    e.cbMarkT = state.time;
    if (!CB.marks.has(e)) {
      CB.marks.add(e);
      e.cbMarkFx = G.world.kv('glyph', { hex: G.TYPE_HEX[mainType(ctx)], s: (e.r + 0.55) * 2, y: 0.08, x: e.x, z: e.z });
    }
    e.cbMarkFx.hex = G.TYPE_HEX[mainType(ctx)];
    e.cbMarkFx.k = e.cbMark / M.max; // 外圈亮着的那一段 = 层数
    state.stats.cbMarks = (state.stats.cbMarks || 0) + 1;
    if (e.cbMark >= M.max) wandPop(e, ctx);
  }
  function wandUnmark(e) {
    kvOff(e.cbMarkFx);
    e.cbMarkFx = null;
    e.cbMark = 0;
    CB.marks.delete(e);
  }
  // 叠满的那一下：它和 r 米内所有带咒痕的敌人各挨「每层 ×mult」，咒痕清空；咒光从它跳向其余的
  function wandPop(src, ctx) {
    const W = G.world;
    const M = ctx.sk.mark;
    const hex = G.TYPE_HEX[mainType(ctx)];
    const list = [src];
    for (const e of CB.marks) if (e !== src && !e.dead && dist(e.x, e.z, src.x, src.z) <= M.r) list.push(e);
    const pts = [];
    let n = 0;
    for (const e of list) {
      const k = e === src ? M.max : e.cbMark || 0;
      wandUnmark(e);
      if (e.dead || !k) continue;
      if (e !== src) {
        if (pts.length < 6) pts.push({ x: src.x, z: src.z }, { x: e.x, z: e.z }); // 折线来回：一道 bolt 连起所有跳过去的（最多 3 只，多了不画）
        n++;
      }
      G.hitEnemy(e, ctx, M.mult * k, { ang: Math.atan2(e.x - src.x, e.z - src.z), w: 0, kb: 0.5, poise: 3 * k, quiet: e !== src }); // w 0：几只一起炸时命中的亮星别连成一片
      state.stats.cbPopHits = (state.stats.cbPopHits || 0) + 1;
    }
    if (pts.length) W.bolt(pts, hex);
    if (!fxOpt('cbPop', src.x, src.z, src.r, hex, src.height || 2) && W.vShock) W.vShock(src.x, src.z, src.r + 1.0, hex, 0.24, 0.5);
    state.stats.cbPops = (state.stats.cbPops || 0) + 1;
    state.stats.cbJumps = (state.stats.cbJumps || 0) + n;
    G.sfx('impact', { type: mainType(ctx), w: 1, crit: false });
  }
  function tickWandMarks() {
    const dur = G.SKILLS.basic_wand.mark.dur;
    for (const e of Array.from(CB.marks)) {
      if (e.dead || state.time - e.cbMarkT > dur) {
        wandUnmark(e);
        continue;
      }
      const f = e.cbMarkFx;
      f.x = e.x;
      f.z = e.z;
      f.ry -= 0.03;
      // 最后一秒闪着淡掉
      f.a = state.time - e.cbMarkT > dur - 1 ? 0.5 + 0.5 * Math.sin(state.time * 20) : 1;
    }
  }
  function resetWandMarks() {
    for (const e of Array.from(CB.marks)) wandUnmark(e);
  }
  G.wandMarks = () => CB.marks; // 测试用

  // =====================================================================
  // 混沌流：黑洞、黑旋风（以及星蚀的渊口）
  // =====================================================================
  // 黑洞 { x, z, R 伤害半径, pullR 牵引半径, t, dur, tick, tt, ctx, mult, pullMul, mouth 是不是渊口, fx world 的句柄 }
  // 黑旋风 { x, z, a 朝向（弧度）, speed, life, R, ctx, cast 同一次施放共用的「敌人 → { next 下次可挨跳的时刻, n 已挨跳数 }」,
  //   seen 这一团吸过的「敌人 → 时刻」, lat 正吸着的敌人, latT 吸附剩下的秒数, latN 吸过几次, bounce 剩几次反弹, skip 贯穿剩几个, chain, wf 摆动参数, fx }
  const holes = [];
  const vortices = [];
  const HOLE_MAX = 6; // 场上玩家的黑洞（含渊口）最多几个，多了顶掉最老的（刻式「双极」一次开两个：2 次施放 × 2 + 渊口 2）
  const HOLE_CAST = 2; // 你施放的黑洞最多同时几个（双极的一对算一个；渊口另算），第三个顶掉最老的
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
    if (h.tether) {
      // 双极：一个洞没了，另一个和索一起收
      G.world.kvOff(h.tether);
      const o = h.twin;
      h.tether = null;
      if (o) {
        o.tether = null;
        o.twin = null;
        const j = holes.indexOf(o);
        if (j >= 0) removeHole(j);
      }
    }
  }
  // 这一跳挨打的：渊口不叠在黑洞上（刚吃过任何黑洞 / 渊口跳的敌人，渊口跳过它）；你施放的黑洞（最多 HOLE_CAST 个）重叠时各跳各的。
  //   每跳最多伤到离洞（双极：离引力索）最近的 sk.cap 个，聚成一团时不再每只都吃满，散开的怪和单体照旧。渊口不封顶
  function holeCap(h, tw, list) {
    let k = list.length;
    if (h.mouth) {
      k = 0;
      for (const e of list) if (!(state.time - (e.holeT || -99) < h.tick * 0.95)) list[k++] = e;
      list.length = k;
    }
    const cap = h.mouth ? 0 : h.ctx.sk.cap;
    if (!cap || k <= cap) return list;
    const d = (e) => {
      if (!tw) return dist(e.x, e.z, h.x, h.z);
      const sx = tw.x - h.x, sz = tw.z - h.z, u = G.clamp(((e.x - h.x) * sx + (e.z - h.z) * sz) / (sx * sx + sz * sz || 1), 0, 1);
      return dist(e.x, e.z, h.x + sx * u, h.z + sz * u);
    };
    return list.map((e) => [d(e), e]).sort((a, b) => a[0] - b[0]).slice(0, cap).map((p) => p[1]);
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
    return addHole({ x, z, R, pullR: R * sk.pullR, t: 0, dur: VM.dur, tick: VM.tick, tt: VM.tick, ctx, mult: VM.dmg, pullMul: VM.pull, mouth: true });
  }
  G.voidMouth = voidMouth;

  function updateChaos(dt) {
    const W = G.world;
    if (mouthCd > 0) mouthCd -= dt;
    // ---- 黑洞 ----
    for (let i = holes.length - 1; i >= 0; i--) {
      const h = holes[i];
      h.t += dt;
      if (h.follow) G.relicHoleFollow(h); // 渊契「随核」
      if (h.t >= h.dur) {
        if (h.collapse) holeCollapse(h, h.ctx.sk.collapse.end); // 刻式「坍缩」：没按就自己塌，伤害打折
        removeHole(i);
        continue;
      }
      if (h.twinB) {
        // 双极的第二个洞：牵引和伤害都由第一个洞连着索一起算，这里只画
        if (h.fx && W.updateHole) W.updateHole(h.fx, h.t / h.dur, dt);
        continue;
      }
      const sk = h.ctx.sk;
      const tw = h.twin ? h.twin : null; // 双极：拽向两洞之间的那条索（最近的一点）
      for (const e of state.enemies) {
        if (e.dead) continue;
        let gx = h.x, gz = h.z;
        if (tw) {
          const sx = tw.x - h.x, sz = tw.z - h.z, u = G.clamp(((e.x - h.x) * sx + (e.z - h.z) * sz) / (sx * sx + sz * sz || 1), 0, 1);
          gx = h.x + sx * u;
          gz = h.z + sz * u;
        }
        const d = dist(e.x, e.z, gx, gz);
        if (d - e.r > h.pullR || d <= sk.core) continue;
        let v;
        if (e.isBoss) v = sk.bossPull * (h.follow ? 1 : h.pullMul); // 随核：首领的牵引不变
        else {
          if (pinned(e)) continue;
          v = G.bindPullSpeed(e, sk.pull) * (0.6 + 0.4 * (1 - Math.min(1, d / h.pullR))) * h.pullMul;
          if (e.freeze > 0 || e.brokenT > 0) v *= 0.35;
        }
        if (G.pullEnemy) G.pullEnemy(e, gx, gz, Math.min(v * dt, d - sk.core));
      }
      h.tt -= dt;
      if (h.tt <= 0) {
        h.tt += h.tick;
        let n = 0;
        for (const e of holeCap(h, tw, tw ? twinTargets(h, tw) : enemiesIn(h.x, h.z, h.R))) {
          e.holeT = state.time;
          n++;
          G.hitEnemy(e, h.ctx, h.mult, { ang: Math.atan2(e.x - h.x, e.z - h.z), w: 0, kb: 0, poise: sk.poise, quiet: true, faint: true, tick: true });
          if (h.collapse) holeGrow(h); // 坍缩：每伤到一个敌人长一点质量
        }
        if (!h.mouth) state.stats.vHoleTick = n; // 测试用：这一跳伤到几个
      }
      if (h.fx && W.updateHole) W.updateHole(h.fx, h.t / h.dur, dt);
      if (h.tether) {
        h.tether.x0 = h.x;
        h.tether.z0 = h.z;
        h.tether.x1 = tw.x;
        h.tether.z1 = tw.z;
        h.tether.a = h.t < 0.3 || h.t > h.dur - 0.3 ? 0.5 : 1;
      }
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
    if (v.guard) return guardStep(v, dt); // 刻式「护涡」：绕着你转
    if (v.lvl) mergeSteer(v, dt); // 刻式「汇涡」：拐向最近的另一团
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
          v.latT = L.t * v.ctx.durK; // 绵延：吸附得更久
          v.latN++;
          let lc = v.cast.get(e);
          if (!lc) v.cast.set(e, (lc = { next: 0, n: 0, g: (v.cast.size * 0.618034) % 1 }));
          lc.lat = true;
          state.stats.vortexLatches = (state.stats.vortexLatches || 0) + 1;
        }
      }
      let c = v.cast.get(e);
      if (!c) v.cast.set(e, (c = { next: 0, n: 0, g: (v.cast.size * 0.618034) % 1 }));
      // 汇涡：每个敌人能挨的跳数 = 层数 × merge.cap（合进来几团就加几份），不分首领 / 吸附。
      // 绵延：上限 × 持续时间的倍率；小数部分按敌人分摊（c.g：这次施放里第几个碰到的敌人，取黄金分割序列——2 × 1.3 = 2.6 就是六成敌人 3 跳、四成 2 跳）
      const capX = (v.lvl ? v.lvl * sk.merge.cap : e.isBoss ? sk.bossCap : c.lat ? sk.cap : sk.splashCap) * v.ctx.durK, capN = Math.floor(capX + 1e-9);
      if (c.n >= capN + ((c.g || 0) < capX - capN - 1e-9 ? 1 : 0) || state.time < c.next) continue;
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
    tickD2b(dt); // 特殊弹 / 提灯（class-d2b1）
    if (CB.marks.size) tickWandMarks();
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
    rainsLive.length = 0; // 冰凌雨的同场计数
    resetWandMarks(); // 疾咒的咒痕
    resetChaos(); // 黑洞、黑旋风一起收起
    resetVariants(); // 刻式第二版留在场上的东西
    resetBleed(); // 流血
    G.relicReset(); // 渊契的电桥、蓄潮
    resetD2b(); // 特殊弹的铁水 / 雷网，提灯的小灯 / 灯海 / 借火（class-d2b1）
  }
  G.resetRanged = resetRanged;

  // ---------- 技能效果 ----------
  const SKILL_FX = {
    // st：连击的哪一段（缺省按第一段）
    melee(ctx, a, st) {
      const W = G.world;
      const sk = ctx.sk;
      if (!st) st = sk.combo ? sk.combo[0] : sk.st || { shape: 'arc', range: sk.range, arc: sk.arc, mult: 1, dir: 1, w: 0, stop: 35, kb: sk.kb, poise: sk.poise }; // st：放血这类单段近战自带的一刀
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
        // st.fx：换一种画法（刻式「血镰」：往前飞的血镰，画在形状批里）
        if (!(st.fx && fxOpt(st.fx, P.x, P.z, a.ang, reach, hex)) && !fxOpt('thrustFx', P.x, P.z, a.ang, reach, hex)) W.slash(P.x, P.z, a.ang, reach, 24, hex, { dur: 0.14, inner: 0.15, y: 1.1 });
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

    // cs：施法普攻这一段（灵弹的小弹 / 重弹，见 data.js 的 cyc）
    proj(ctx, a, cs) {
      const sk = ctx.sk;
      if (sk.mech === 'orbit') return bladeOrbit(ctx); // 刻式「环刃」：不飞出去，绕着你转
      if (sk.cyc) return staffBolt(ctx, a, cs || sk.cyc[0]);
      const n = Math.max(1, ctx.proj + (sk.count || 1) - 1); // count：散钉一次几枚（多重投射再加）
      const ring = sk.mech === 'ring'; // 刻式「环钉」：朝四周均匀散开，正对准星的那枚在中间
      const spread = ring ? TAU * (1 - 1 / n) : Math.min(60, (sk.spread || 12) * (n - 1)) * DEG;
      const stepA = n > 1 ? spread / (n - 1) : 0;
      const hex = sk.elemHex ? G.TYPE_HEX[mainType(ctx)] : hexOf(sk.color); // elemHex：武器普攻按这一下的元素取色
      // hitCap（散钉）：同一次施放对同一个敌人最多中几枚，用计数代替「只中一次」
      const cast = sk.hitCap ? null : new Set(); // 这一次施放里已经受过伤（直击或爆炸）的敌人，所有投射物共用
      const capMap = sk.hitCap ? new Map() : null;
      const tint = infuseHex(ctx);
      // 刻式「跳焰」：第一跳落在准星处（min..max 米），之后每 hop 米一跳
      const sp = sk.mech === 'skip' ? sk.skip : null;
      const d0 = sp ? G.clamp(a.dist, sp.min, sp.max) : 0;
      if (ring) state.stats.nailRings = (state.stats.nailRings || 0) + 1;
      for (let i = 0; i < n; i++) {
        const ang = ring ? a.ang + stepA * i : a.ang - spread / 2 + stepA * i;
        const dx = Math.sin(ang);
        const dz = Math.cos(ang);
        G.spawnProjectile({
          owner: 'p', x: P.x + dx * 0.7, z: P.z + dz * 0.7, dx, dz,
          speed: sk.speed, r: sk.projR || 0.3, life: sp ? (d0 + sp.hop * (sp.n - 1)) / sk.speed + 1 : sk.life || 30 / sk.speed, color: hex,
          ctx, pierce: sk.mech === 'pin' ? 0 : ctx.pierce, chain: sk.mech ? 0 : ctx.chain, explode: sk.explode || 0, hit: new Set(), cast, capMap, hitCap: sk.hitCap || 0,
          vk: sk.vk || ctx.id, tint,
          skip: sp ? { d: 0, seg: Math.max(0.5, d0 - 0.7), left: sp.n, walls: 3 } : null, stick: sk.mech === 'stick', pin: sk.mech === 'pin',
        });
      }
    },

    // cs：疾咒这一下（左 / 右手，见 data.js 的 cyc）
    chain(ctx, a, cs) {
      const W = G.world;
      const sk = ctx.sk;
      const hex = sk.elemHex ? G.TYPE_HEX[mainType(ctx)] : hexOf(sk.color);
      if (sk.mech === 'pylon') return arcPylon(ctx, a); // 刻式「雷桩」：插一根导雷桩
      const ov = sk.mech === 'overload' ? sk.over : null; // 刻式「过载」：一跳比一跳痛，最后折回你身上
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
      const bo = { v2: true }; // vf-vfx2：链雷的折线语言（刻式「过载」也用；「雷桩」走自己的 arcPylon）
      if (!first) {
        pts.push({ x: P.x + a.dx * 6, z: P.z + a.dz * 6 });
        W.bolt(pts, hex, false, bo);
        return;
      }
      const hit = new Set();
      let cur = first;
      let jumps = ctx.chain;
      let px = P.x;
      let pz = P.z;
      let mk = sk.cyc ? (cs || sk.cyc[0]).mult : 1;
      while (cur) {
        hit.add(cur);
        pts.push({ x: cur.x, z: cur.z });
        const cx = cur.x;
        const cz = cur.z;
        G.hitEnemy(cur, ctx, mk, { ang: Math.atan2(cx - px, cz - pz) }); // 顺着电弧来的方向
        if (sk.mark) wandMark(cur, ctx); // 疾咒：叠一层咒痕（叠满当场引爆）
        if (ov) mk *= ov.k;
        px = cx;
        pz = cz;
        cur = null;
        if (jumps-- <= 0) break;
        let nd = 7; // 跳距
        for (const e of state.enemies) {
          if (e.dead || hit.has(e)) continue;
          const d = dist(e.x, e.z, cx, cz);
          if (d <= nd) {
            nd = d;
            cur = e;
          }
        }
      }
      W.bolt(pts, hex, false, bo);
      if (sk.mech === 'bridge') G.relicBridges(pts, ctx); // 渊式「电桥」
      if (ov) arcOverload(ctx, pts, hit.size, hex);
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
      // 刻式：熔核 / 犁焰落地那一下打折（k0），之后留下熔核 / 顺着瞄准方向犁出去
      const vm = sk.mech === 'core' || sk.mech === 'plough' ? sk[sk.mech] : null, R0 = sk.mech === 'plough' ? vm.r * Math.sqrt(ctx.area) : R;
      const star = sk.mech === 'star'; // 渊式「星雨」：自动落下的星（淡翠白的星、落点符环）
      const tok = W.meteorFall(x, z, sk.delay, star ? 0x9fe8cc : hex, false, star); // 星雨：中等亮度的淡翠星，落地不放大火团 / 闪光
      if (star) { if (W.rvStar) W.rvStar(x, z, R, sk.delay); } // 星雨不走 meteorMark（不画落影、不换 meteorLand2），落点符环自己画
      else if (W.meteorMark) W.meteorMark(tok, R0); // vf-vfx2：落影 + 新的落地特效（刻式的熔核 / 犁焰也用，落地之后各自的件照旧）
      G.telegraph({
        shape: 'circle', x, z, r: R0, dur: sk.delay, dmg: 0, friendly: true, hidden: star, // 星雨：落点只画淡翠符环，不铺实心预警圈
        onFire() {
          const hs = enemiesIn(x, z, R0);
          if (hs.length && !star) G.spellStop(45); // vf-vfx2：重的法术命中顿一下（法术来源每 0.3 秒最多一次）；渊式「星雨」自己落的星不顿（自动触发的不算）
          for (const e of hs) G.hitEnemy(e, ctx, vm ? vm.k0 : 1, { ang: Math.atan2(e.x - x, e.z - z), core: true, kb: sk.mech === 'plough' ? 0.2 : undefined }); // 从落点往外炸开；core：不点燃自己留下的熔核；犁焰落地不推人（留给犁）
          if (sk.mech === 'core') meteorCore(ctx, x, z);
          else if (sk.mech === 'plough') meteorPlough(ctx, x, z, a.dx, a.dz);
          if (star) {
            if (W.rvStarHit) W.rvStarHit(x, z, R);
            W.shake(0.2);
            G.sfx('hit');
            return;
          }
          if (vm) {
            // vf-vfx2：落地的样子交给 meteorLand2（外沿细环、火舌、岩块）；震动和原式一样打中才震 0.2（原来每次 0.35）
            W.burst(x, 0.8, z, hex, 10, 7, 0.6);
            if (hs.length) W.shake(0.2);
            G.sfx('hit');
            return;
          }
          // vf-vfx2：落地的样子在世界层（meteorLand2：外沿冲击环、环上的火舌、暗色岩块、熔岩裂纹）；这里不再叠第二块焦斑、
          // 一道亮环和 62 粒亮点（它们和大火团一起把落点里的怪糊成一片白），只留一小把火星
          W.burst(x, 0.8, z, hex, 12, 8, 0.6);
          if (hs.length) W.shake(0.2); // vf-vfx2（需求方定）：打中才震、轻一点（原来每次落地都震 0.5）
          G.sfx('hit');
        },
      });
    },

    // 旋风斩的一下：身边一整圈。击退顺着旋转方向带一下（切向为主），敌人被卷着走而不是被推出圈外
    spin(ctx) {
      const W = G.world;
      const sk = ctx.sk;
      if (sk.mech === 'throw') return whirlThrow(ctx); // 刻式「掷旋」：把旋转的武器掷出去
      const R = sk.radius * Math.sqrt(ctx.area);
      const hex = hexOf(sk.color);
      const c = P.cast;
      const n = c && c.channel ? c.pulses : 0;
      const rk = sk.mech === 'tide' ? G.relicSpinPulse(ctx) : 1; // 渊式「蓄潮」：每跳打得轻、攒层
      if (sk.mech === 'pull') whirlPull(ctx); // 刻式「旋涡斩」：先把一圈敌人往身边吸
      W.slash(P.x, P.z, Math.random() * TAU, R, 360, hex, sk.mech === 'pull' ? { dur: 0.2, inner: 0.35, y: 0.6, dir: -1 } : { dur: 0.2, inner: 0.6, y: 0.9 });
      if (W.spinPulse) W.spinPulse(P.ent, R, hex, ctx.time * 1.6, n === 1, sk.mech === 'pull' ? -1 : 1); // vf-vfx2：绕身的风刃、脚下的风纹、起手的尘环；刻式「旋涡斩」风刃反着转、往里收
      if (n % 2 === 1) W.burst(P.x, 0.25, P.z, 0xbfb3a0, 4, R * 0.9, 0.3); // 脚下扬起的尘
      G.sfx('swing', { step: n % 2 });
      const hits = whirlCap(enemiesIn(P.x, P.z, R), sk);
      const full = sk.mech === 'tide' && G.relicState.spin >= sk.tide.max; // 渊式「蓄潮」：满层这一下打完就卷起潮涌
      if (!hits.length) {
        if (full) G.relicTideBurst();
        return;
      }
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
      if (full) G.relicTideBurst();
    },

    blink(ctx, a) {
      const W = G.world;
      const sk = ctx.sk;
      if (sk.mech === 'swap') return blinkSwap(ctx, a); // 刻式「换影」：和敌人换位置
      const hex = hexOf(sk.color);
      const ox = P.x;
      const oz = P.z;
      if (sk.mech === 'decoy') blinkDecoy(ctx, ox, oz); // 刻式「残像」：原地留一个嘲讽的残像
      // 从目标点往回退，直到落在可走的地方
      let d = Math.min(sk.range, a.dist);
      while (d > 0 && !W.walkable(ox + a.dx * d, oz + a.dz * d, 0.6)) d -= 0.4;
      // skill-b1：起点不再放一团火花、路上不再是旧的近白闪电，换成贴地的残影带（W.bolt 走鬼影：随机数照取、不显示）
      if (W.blinkOrigin) W.blinkOrigin();
      else W.burst(ox, 1.0, oz, hex, 18, 4, 0.4);
      if (d > 0) {
        P.x = ox + a.dx * d;
        P.z = oz + a.dz * d;
        W.bolt([{ x: ox, z: oz }, { x: P.x, z: P.z }], hex, false, { ghost: !!W.blinkBand });
        if (W.blinkBand) W.blinkBand(ox, oz, P.x, P.z, hex);
      }
      P.roll.t = 0;
      P.iframe = Math.max(P.iframe, 0.2);
      const dc = sk.mech === 'decoy' ? sk.decoy : null;
      const R = (dc ? dc.r0 : sk.radius) * Math.sqrt(ctx.area);
      if (W.blinkLand) W.blinkLand(P.x, P.z, R, hex); // skill-b1：落点一道细环 + 碎石（原来一团闪光 + 火花）
      else {
        W.burst(P.x, 1.0, P.z, hex, 24, 6, 0.45);
        W.ring(P.x, P.z, R, hex, 0.3);
      }
      let n = 0;
      let crit = false;
      for (const e of enemiesIn(P.x, P.z, R)) {
        G.hitEnemy(e, ctx, dc ? dc.k0 : 1, { quiet: true });
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

  // =====================================================================
  // 刻式第二版：每个刻式的那条新规则（数据在 data.js 的 G.VARIANTS，mech 标出是哪一条、参数在同名的对象里）
  // 留在场上的东西都记在 VS 里，每帧 updateVariants 推进；外形用 world 的刻式件（W.kv：实例化，每种外形一次 draw call）
  // =====================================================================
  const VS = {
    n: 0, // 下面这些列表一共几项（为 0 时整个跳过）
    sticks: [], // 黏焰：{ e, ctx, gen, k, t, fuse, x, z, fx, ring }
    traps: [], // 钉刃：{ x, z, ctx, t, tt, fx, ring, ph }
    orbits: [], // 环刃：{ ctx, t, fx, hitAt: Map(敌人 → 时刻) }
    pylons: [], // 雷桩：{ x, z, ctx, t, tt, fx, top }
    links: [], // 雷桩之间的电弧：band 句柄
    cores: [], // 熔核：{ x, z, ctx, t, n, gap, fx, glow }
    ploughs: [], // 犁焰：{ x, z, dx, dz, d, len, sp, ctx, hit, fx, fd }
    decoys: [], // 残像：{ decoy, x, z, r, height, dead, rising, hp, t, ctx, ring }
    clones: 0, // 影分：排在计时器里、还没补出去的刀
    focus: { e: null, n: 0 }, // 聚雷：连着打中的那个敌人和数到第几下
    marks: new Set(), // 影印：身上有影印的敌人（层数在 e.vMark，过期时刻 e.vMarkT，句柄 e.vMarkFx）
    disc: null, // 掷旋：{ x, z, tx, tz, ph 'out' / 'hover' / 'back', t, hover, ctx, hits: Map, fx }
    brands: new Set(), // 蚀印：身上有蚀印的敌人（层数 e.vBrand、攒下的伤害 e.vBrandV、句柄 e.vBrandFx）
    dots: new Set(), // 传焰：身上烧着黑焰的敌人（e.vDot = { pool, depth, tt, fx }）
    crystals: [], // 冰棱：环身的冰晶句柄
    shell: null, // 过载：雷盾的罩子句柄
    orbA: 0, // 环刃的公转角
  };
  function vCount() {
    VS.n = VS.sticks.length + VS.traps.length + VS.orbits.length + VS.pylons.length + VS.cores.length + VS.ploughs.length + VS.decoys.length +
      VS.marks.size + (VS.disc ? 1 : 0) + VS.brands.size + VS.dots.size + (P.vShield ? 1 : 0) + VS.links.length;
  }
  const kvOff = (h) => h && G.world.kvOff(h);

  // ---------- 掷焰「跳焰」 ----------
  // 落地：小范围爆炸（每个敌人每次落地一次），留一片火地；还有跳数就接着跳（返回 true），没有就收起（返回 false）
  function skipLand(p) {
    const W = G.world, sk = p.ctx.sk, S = sk.skip, ak = Math.sqrt(p.ctx.area), R = S.r * ak;
    for (const e of enemiesIn(p.x, p.z, R)) G.hitEnemy(e, p.ctx, 1, { ang: Math.atan2(e.x - p.x, e.z - p.z), kb: 0.15, poise: sk.poise, quiet: true }); // 推得很轻：留在火地里
    const F = S.field;
    addField({ kind: 'burn', x: p.x, z: p.z, r: F.r * ak, dur: F.dur, tick: F.tick, mult: F.mult, ctx: p.ctx, key: 'vSkipT', hex: 0xff7a2c, noDecal: true });
    W.ring(p.x, p.z, R, 0xff8a3c, 0.25);
    W.burst(p.x, 0.4, p.z, 0xffb050, 12, 5, 0.35);
    G.sfx('impact', { type: 'fire', w: 0, crit: false });
    state.stats.vSkipLands = (state.stats.vSkipLands || 0) + 1;
    p.skip.left--;
    if (p.skip.left <= 0) return false;
    p.skip.d = 0;
    p.skip.seg = S.hop;
    return true;
  }
  // 撞墙：按墙的法线弹回来（最多 walls 次），这一跳接着走完
  function skipWall(p, step) {
    if (p.skip.walls <= 0) return false;
    p.x -= p.dx * step;
    p.z -= p.dz * step;
    const n = vxNormal(p.x + p.dx * step, p.z + p.dz * step, p.x, p.z, p.dx, p.dz);
    const dn = p.dx * n.x + p.dz * n.z;
    p.dx = dn < 0 ? p.dx - 2 * dn * n.x : n.x;
    p.dz = dn < 0 ? p.dz - 2 * dn * n.z : n.z;
    p.skip.walls--;
    if (G.world.relicProjTurn) G.world.relicProjTurn(p.mesh, p.dx, p.dz);
    state.stats.vSkipWalls = (state.stats.vSkipWalls || 0) + 1;
    return true;
  }

  // ---------- 掷焰「黏焰」 ----------
  // 粘上一颗：gen 第几代（0 = 你亲手掷的），k 伤害倍率（往外传一代乘一次 stick.k）
  function emberStick(ctx, e, gen, k) {
    const W = G.world, S = ctx.sk.stick;
    if (VS.sticks.length >= 24) stickBoom(VS.sticks[0]);
    e.vStick = (e.vStick || 0) + 1;
    VS.sticks.push({
      e, ctx, gen, k, t: S.fuse, fuse: S.fuse, x: e.x, z: e.z,
      fx: W.kv('orb', { hex: 0xffa040, s: 0.34 }), ring: W.kv('glyph', { hex: 0xff7a2c, s: (e.r + 0.7) * 2, y: 0.06 }),
    });
    W.burst(e.x, (e.height || 2) * 0.6, e.z, 0xffb050, 6, 2, 0.25);
    vCount();
  }
  function stickBoom(st) {
    const W = G.world, ctx = st.ctx, S = ctx.sk.stick, ak = Math.sqrt(ctx.area), R = S.r * ak;
    const i = VS.sticks.indexOf(st);
    if (i >= 0) VS.sticks.splice(i, 1);
    kvOff(st.fx);
    kvOff(st.ring);
    if (st.e) st.e.vStick = Math.max(0, (st.e.vStick || 0) - 1);
    const x = st.e && !st.e.dead ? st.e.x : st.x, z = st.e && !st.e.dead ? st.e.z : st.z;
    const hits = enemiesIn(x, z, R);
    for (const o of hits) G.hitEnemy(o, ctx, st.k, { ang: Math.atan2(o.x - x, o.z - z), kb: 0.6, poise: 10, quiet: true });
    if (W.blastFx) W.blastFx(x, z, R);
    else W.ring(x, z, R, 0xff8a3c, 0.3);
    G.sfx('impact', { type: 'fire', w: 1, crit: false });
    state.stats.vStickBooms = (state.stats.vStickBooms || 0) + 1;
    // 往外传：附近还没粘上的敌人里挑最近的几个
    if (st.gen < S.gen) {
      const c = [];
      for (const o of state.enemies) if (!o.dead && o !== st.e && !(o.vStick > 0) && dist(o.x, o.z, x, z) - o.r <= S.sr * ak) c.push(o);
      c.sort((p, q) => dist(p.x, p.z, x, z) - dist(q.x, q.z, x, z));
      for (let j = 0; j < Math.min(S.spread, c.length); j++) {
        emberStick(ctx, c[j], st.gen + 1, st.k * S.k);
        W.bolt([{ x, z }, { x: c[j].x, z: c[j].z }], 0xff8a3c, true);
        state.stats.vStickSpread = (state.stats.vStickSpread || 0) + 1;
      }
    }
    vCount();
  }
  function tickSticks(dt) {
    for (let i = VS.sticks.length - 1; i >= 0; i--) {
      const st = VS.sticks[i];
      if (!st) continue;
      st.t -= dt;
      const e = st.e;
      if (e && !e.dead) {
        st.x = e.x;
        st.z = e.z;
      }
      if (st.t <= 0 || !e || e.dead) {
        stickBoom(st);
        continue;
      }
      // 火核贴在胸口朝镜头那一面，越临近引爆闪得越快；引信圈的亮段跟着走完
      const f = 1 - st.t / st.fuse, h = (e.height || 2) * 0.6;
      st.fx.x = e.x;
      st.fx.z = e.z + e.r * 0.6;
      st.fx.y = h;
      st.fx.k = Math.sin(state.time * (6 + f * 26)) > 0 ? 0.85 : 0.15;
      st.fx.s = 0.3 + f * 0.14;
      st.ring.x = e.x;
      st.ring.z = e.z;
      st.ring.k = f;
      st.ring.s = (e.r + 0.7) * 2 * (1.25 - f * 0.25);
    }
  }

  // ---------- 飞刃「钉刃」 ----------
  // 钉住：e 是钉中的敌人（null 就立在当前位置）。定身 root 秒（首领不会），立起一把旋转的锯刃
  function bladePin(p, e) {
    const W = G.world, sk = p.ctx.sk, S = sk.pin;
    p.pinned = true;
    let x = p.x, z = p.z;
    if (e) {
      x = e.x - p.dx * Math.min(e.r * 0.5, 0.5);
      z = e.z - p.dz * Math.min(e.r * 0.5, 0.5);
      if (!e.isBoss && !e.dead) {
        e.stunT = Math.max(e.stunT || 0, S.root);
        W.text(e.x, e.z, '钉住', '#cfd6e6', 16, { kind: 'tag', y: Math.min(3, (e.height || 2) + 0.4) });
      }
    }
    while (VS.traps.length >= S.max) trapOff(VS.traps[0]);
    const R = S.r * Math.sqrt(p.ctx.area);
    VS.traps.push({
      x, z, ctx: p.ctx, t: S.dur, tt: 0.05, ph: Math.atan2(p.dx, p.dz), R,
      fx: W.kv('blade', { hex: 0xdfe6f2, s: 0.75, y: 0.7 }), ring: W.kv('glyph', { hex: 0xcfd6e6, s: R * 2, y: 0.05 }),
    });
    W.decal(0, x, z, 0.8, Math.atan2(p.dx, p.dz), 0xcfd6e6, S.dur, 0.12);
    W.burst(x, 0.6, z, 0xffffff, 10, 4, 0.25);
    state.stats.vPins = (state.stats.vPins || 0) + 1;
    vCount();
  }
  function trapOff(tr) {
    const i = VS.traps.indexOf(tr);
    if (i >= 0) VS.traps.splice(i, 1);
    kvOff(tr.fx);
    kvOff(tr.ring);
    G.world.burst(tr.x, 0.6, tr.z, 0xcfd6e6, 6, 2, 0.25);
    vCount();
  }
  function tickTraps(dt) {
    for (let i = VS.traps.length - 1; i >= 0; i--) {
      const tr = VS.traps[i], S = tr.ctx.sk.pin;
      tr.t -= dt;
      if (tr.t <= 0) {
        trapOff(tr);
        continue;
      }
      // 竖着立在地上、绕自己的轴飞快地转，侧面朝着来的方向；最后 0.4 秒往下沉
      tr.fx.x = tr.x;
      tr.fx.z = tr.z;
      tr.fx.ry = tr.ph + Math.PI / 2;
      tr.fx.rz += dt * 22;
      tr.fx.y = tr.t < 0.4 ? 0.7 * (tr.t / 0.4) : 0.7;
      tr.ring.x = tr.x;
      tr.ring.z = tr.z;
      tr.ring.k = tr.t / S.dur;
      tr.tt -= dt;
      if (tr.tt > 0) continue;
      tr.tt += S.tick;
      let n = 0;
      for (const e of enemiesIn(tr.x, tr.z, tr.R)) {
        // 同一个敌人同一时刻只吃一把锯刃（几把叠在一起不翻倍）
        if (state.time - (e.vPinT || -99) < S.tick * 0.95) continue;
        e.vPinT = state.time;
        G.hitEnemy(e, tr.ctx, S.mult, { ang: Math.atan2(e.x - tr.x, e.z - tr.z), w: 0, kb: 0.05, poise: 1, quiet: true, faint: true });
        n++;
      }
      if (n) {
        G.world.burst(tr.x, 0.7, tr.z, 0xfff0d0, 3, 3, 0.15);
        state.stats.vTrapHits = (state.stats.vTrapHits || 0) + n;
      }
    }
  }

  // ---------- 飞刃「环刃」 ----------
  function bladeOrbit(ctx) {
    const W = G.world, O = ctx.sk.orbit, add = Math.max(1, ctx.proj), max = O.max + add - 1 + ctx.durCap; // 绵延：上限 +1、每把转得更久
    for (let i = 0; i < add; i++) {
      while (VS.orbits.length >= max) orbitOff(VS.orbits[0]);
      VS.orbits.push({ ctx, t: O.dur * ctx.durK, fx: W.kv('blade', { hex: 0xdfe6f2, s: 0.55, rx: Math.PI / 2 - 0.25, y: 1.0 }), hitAt: new Map() });
    }
    W.burst(P.x, 1.0, P.z, 0xcfd6e6, 8, 3, 0.25);
    G.sfx('swing', { step: 0 });
    vCount();
  }
  function orbitOff(o) {
    const i = VS.orbits.indexOf(o);
    if (i >= 0) VS.orbits.splice(i, 1);
    kvOff(o.fx);
    vCount();
  }
  function tickOrbits(dt) {
    const L = VS.orbits;
    if (!L.length) return;
    const O = L[0].ctx.sk.orbit;
    VS.orbA += O.w * dt;
    for (let i = L.length - 1; i >= 0; i--) {
      const o = L[i];
      o.t -= dt;
      if (o.t <= 0 || P.dead) orbitOff(o);
    }
    const n = L.length;
    for (let i = 0; i < n; i++) {
      const o = L[i], S = o.ctx.sk.orbit, ak = Math.sqrt(o.ctx.area), r = S.r * ak;
      const a = VS.orbA + (i / n) * TAU, x = P.x + Math.sin(a) * r, z = P.z + Math.cos(a) * r;
      o.fx.x = x;
      o.fx.z = z;
      o.fx.ry = a;
      o.fx.rz += dt * 18;
      o.fx.a = o.t < 0.3 ? 0.3 : 1;
      for (const e of state.enemies) {
        if (e.dead || dist(e.x, e.z, x, z) > S.hr * ak + e.r) continue;
        if (state.time - (o.hitAt.get(e) || -99) < S.gap) continue;
        o.hitAt.set(e, state.time);
        G.hitEnemy(e, o.ctx, 1, { ang: a + Math.PI / 2, kb: 0.15, quiet: true });
        G.world.burst(x, 1.0, z, 0xfff0d0, 3, 3, 0.15);
        state.stats.vOrbitHits = (state.stats.vOrbitHits || 0) + 1;
      }
    }
  }

  // ---------- 霜环「冰棱」「冰爆」 ----------
  // 冰棱：每次脉冲朝 range 以内（吃范围加成）最近的 n 个看得见的敌人各射一枚追踪冰棱（和光环脉冲一样不算连击）
  function novaShards(ctx) {
    const S = ctx.sk.shard, R = S.range * Math.sqrt(ctx.area);
    const c = [];
    for (const e of state.enemies) {
      if (e.dead || dist(e.x, e.z, P.x, P.z) - e.r > R || !losClear(P.x, P.z, e.x, e.z)) continue;
      c.push(e);
    }
    if (!c.length) return 0;
    c.sort((p, q) => dist(p.x, p.z, P.x, P.z) - dist(q.x, q.z, P.x, P.z));
    for (let i = 0; i < Math.min(S.n, c.length); i++) {
      const e = c[i], k = VS.crystals.length ? VS.crystals[i % VS.crystals.length] : null;
      const x = k ? k.x : P.x, z = k ? k.z : P.z;
      const dx = e.x - x, dz = e.z - z;
      G.spawnProjectile({
        owner: 'p', x, z, y0: 1.6, dx, dz, speed: S.speed, r: 0.22, life: R / S.speed + 0.6, color: 0x9fe4ff,
        ctx, pierce: 0, chain: 0, explode: 0, hit: new Set(), home: e, turn: 9, seeker: true, aura: true, vk: 'dart',
      });
    }
    state.stats.vShards = (state.stats.vShards || 0) + Math.min(S.n, c.length);
    return c.length;
  }
  // 环身的冰晶：on 时三枚冰晶绕着胸口慢慢转（每帧在 updateAuras 里调用）
  function novaCrystals(on) {
    const W = G.world;
    if (!on) {
      while (VS.crystals.length) kvOff(VS.crystals.pop());
      return;
    }
    while (VS.crystals.length < 3) VS.crystals.push(W.kv('shard', { hex: 0x9fe4ff, s: 0.32, k: 0.25 }));
    for (let i = 0; i < 3; i++) {
      const h = VS.crystals[i], a = state.time * 1.8 + (i / 3) * TAU;
      h.x = P.x + Math.sin(a) * 0.95;
      h.z = P.z + Math.cos(a) * 0.95;
      h.y = 1.55 + Math.sin(state.time * 3 + i * 2) * 0.12;
      h.ry = a;
    }
  }
  // 冰爆：光环里的敌人被冻住（首领是重度冰缓）的那一刻，以它为中心炸开：伤害 = 每跳的 burst.mult 倍，周围的敌人灌 burst.fill 的冰霜异常值
  function novaBurst(e) {
    if (state.time - (e.vBurstT || -99) < G.SKILLS.nova.burst.cd) return;
    const ctx = G.skillCtx('nova'), B = ctx.sk.burst;
    if (dist(e.x, e.z, P.x, P.z) - e.r > G.auraRadius(ctx)) return;
    e.vBurstT = state.time;
    const R = B.r * Math.sqrt(ctx.area);
    for (const o of enemiesIn(e.x, e.z, R)) {
      G.hitEnemy(o, ctx, B.mult, { ang: Math.atan2(o.x - e.x, o.z - e.z), w: 0, kb: 0.3, poise: 4, quiet: true, aura: true, noBuild: o === e });
      if (o !== e && !o.dead) fillMeter(o, 'cold', B.fill, procQ);
    }
    if (G.world.frostBlast) G.world.frostBlast(e.x, e.z, R);
    state.stats.vNovaBursts = (state.stats.vNovaBursts || 0) + 1;
  }

  // ---------- 链雷「雷桩」「过载」 ----------
  function arcPylon(ctx, a) {
    const W = G.world, sk = ctx.sk, S = sk.pylon;
    const d = rayLen(P.x, P.z, a.ang, Math.min(sk.range, a.dist), 0.4);
    let x = P.x + a.dx * d, z = P.z + a.dz * d;
    if (!W.walkable(x, z, 0.2)) {
      x = P.x + a.dx * 0.8;
      z = P.z + a.dz * 0.8;
    }
    while (VS.pylons.length >= S.max + ctx.durCap) pylonOff(VS.pylons[0]); // 绵延：上限 +1
    const py = {
      x, z, ctx, t: S.dur * ctx.durK, tt: 0,
      fx: W.kv('spike', { hex: 0xc9a83a, x, z, sx: 1, sz: 1, sy: 2.3 }), top: W.kv('orb', { hex: 0xffe45e, x, z, y: 2.35, s: 0.42, k: 0.6 }),
    };
    VS.pylons.push(py);
    W.bolt([{ x: P.x, z: P.z }, { x, z }], 0xffe45e, true);
    if (W.vShock) W.vShock(x, z, S.r * Math.sqrt(ctx.area), 0xffe45e, 0.3, 0); // 电桩的范围：一道往外推的细环
    else W.ring(x, z, S.r * Math.sqrt(ctx.area), 0xffe45e, 0.3);
    W.decal(3, x, z, 0.9, Math.random() * TAU, 0xffe45e, py.t);
    py.tt = S.tick * 0.6; // 插下去之后很快电第一下（不当帧电：按住连插也不会多电）
    state.stats.vPylons = (state.stats.vPylons || 0) + 1;
    vCount();
  }
  function pylonOff(py) {
    const i = VS.pylons.indexOf(py);
    if (i >= 0) VS.pylons.splice(i, 1);
    kvOff(py.fx);
    kvOff(py.top);
    G.world.burst(py.x, 1.4, py.z, 0xffe45e, 8, 3, 0.3);
    vCount();
  }
  // 电一下 r 米内最近的敌人（看得见的），返回电到的敌人
  function pylonZap(py) {
    const S = py.ctx.sk.pylon, R = S.r * Math.sqrt(py.ctx.area);
    let best = null, bd = R;
    for (const e of state.enemies) {
      if (e.dead) continue;
      const d = dist(e.x, e.z, py.x, py.z) - e.r;
      if (d <= bd && losClear(py.x, py.z, e.x, e.z)) {
        bd = d;
        best = e;
      }
    }
    if (!best) return null;
    G.hitEnemy(best, py.ctx, S.mult, { ang: Math.atan2(best.x - py.x, best.z - py.z), quiet: true });
    G.world.bolt([{ x: py.x, z: py.z }, { x: best.x, z: best.z }], 0xffe45e, true);
    py.top.k = 1;
    state.stats.vZaps = (state.stats.vZaps || 0) + 1;
    return best;
  }
  function tickPylons(dt) {
    const L = VS.pylons;
    for (let i = L.length - 1; i >= 0; i--) {
      const py = L[i];
      py.t -= dt;
      if (py.t <= 0) {
        pylonOff(py);
        continue;
      }
      py.top.k = Math.max(0.35, py.top.k - dt * 3);
      py.top.y = 2.35 + Math.sin(state.time * 4 + i) * 0.06;
      py.fx.sy = py.t < 0.3 ? 2.3 * (py.t / 0.3) : 2.3;
      py.tt -= dt;
      if (py.tt <= 0) {
        py.tt += py.ctx.sk.pylon.tick;
        pylonZap(py);
        pylonLinkTick(py);
      }
    }
    // 桩与桩之间的电弧：相距 link 以内的每一对一道（最多 3 对），句柄按需增减
    let k = 0;
    for (let i = 0; i < L.length; i++) {
      for (let j = i + 1; j < L.length; j++) {
        const a = L[i], b = L[j];
        if (dist(a.x, a.z, b.x, b.z) > a.ctx.sk.pylon.link) continue;
        if (!VS.links[k]) VS.links[k] = G.world.kv('band', { hex: 0xffe45e, w: a.ctx.sk.pylon.lw, y: 1.6 });
        const h = VS.links[k++];
        h.x0 = a.x;
        h.z0 = a.z;
        h.x1 = b.x;
        h.z1 = b.z;
        h.a = Math.min(a.t, b.t) < 0.4 ? 0.5 : 1;
      }
    }
    while (VS.links.length > k) kvOff(VS.links.pop());
  }
  // 电弧扫过：每根桩跳的时候结算它连着的那几道（每道只由编号小的那根结算一次）
  function pylonLinkTick(py) {
    const L = VS.pylons, S = py.ctx.sk.pylon, half = (S.lw / 2) * Math.sqrt(py.ctx.area);
    const i = L.indexOf(py);
    for (let j = i + 1; j < L.length; j++) {
      const b = L[j];
      if (dist(py.x, py.z, b.x, b.z) > S.link) continue;
      const sx = b.x - py.x, sz = b.z - py.z, L2 = sx * sx + sz * sz || 1;
      for (const e of state.enemies) {
        if (e.dead) continue;
        const u = G.clamp(((e.x - py.x) * sx + (e.z - py.z) * sz) / L2, 0, 1);
        if (dist(e.x, e.z, py.x + sx * u, py.z + sz * u) - e.r > half) continue;
        if (state.time - (e.vLinkT || -99) < S.tick * 0.95) continue; // 同一时刻只吃一道
        e.vLinkT = state.time;
        G.hitEnemy(e, py.ctx, S.lmult, { ang: Math.atan2(sz, sx), w: 0, kb: 0, poise: 1, quiet: true, faint: true });
        state.stats.vLinkHits = (state.stats.vLinkHits || 0) + 1;
      }
    }
  }
  // 过载：最后一下折回你身上，n 个敌人各给一份雷盾、回一点魔力；电弧一跳比一跳粗（后面的段多叠一道）
  function arcOverload(ctx, pts, n, hex) {
    const W = G.world, O = ctx.sk.over;
    for (let i = 2; i < pts.length; i++) W.bolt([pts[i - 1], pts[i]], 0xfffbe6, i < 3);
    if (!n) return;
    const last = pts[pts.length - 1];
    W.bolt([last, { x: P.x, z: P.z }], hex, true);
    W.burst(P.x, 1.1, P.z, 0xffe45e, 10, 3, 0.3);
    const v = P.maxLife * O.shield * n;
    P.vShield = { v: Math.max(v, (P.vShield && P.vShield.v) || 0), t: O.dur };
    P.mana = Math.min(P.maxMana, P.mana + O.mana * n);
    if (!VS.shell) VS.shell = W.kv('dome', { hex: 0xffe45e, s: 1.15 });
    state.stats.vOverloads = (state.stats.vOverloads || 0) + 1;
    vCount();
  }
  function vShieldOff() {
    P.vShield = null;
    kvOff(VS.shell);
    VS.shell = null;
    vCount();
  }
  function tickShield(dt) {
    const s = P.vShield;
    s.t -= dt;
    if (s.t <= 0 || P.dead) return vShieldOff();
    const h = VS.shell;
    if (h) {
      h.x = P.x;
      h.z = P.z;
      h.y = 0;
      h.sy = 1.9;
      h.sx = h.sz = 1.0;
      h.a = s.t < 0.5 ? 0.3 : Math.sin(state.time * 30) > -0.3 ? 1 : 0.62;
    }
  }

  // ---------- 陨火「熔核」「犁焰」 ----------
  function meteorCore(ctx, x, z) {
    const W = G.world, C = ctx.sk.core;
    while (VS.cores.length >= 3) coreOff(VS.cores[0], true);
    VS.cores.push({
      x, z, ctx, t: C.dur, n: 0, gap: 0.3, R: C.r * Math.sqrt(ctx.area),
      fx: W.kv('rock', { hex: 0x3a1a10, x, z, y: 0.25, s: 1.25, ry: Math.random() * TAU }), glow: W.kv('orb', { hex: 0xff5a1c, x, z, y: 0.45, s: 0.8, k: 0.4 }),
      ring: W.kv('glyph', { hex: 0xff5a2c, x, z, y: 0.05, s: C.r * Math.sqrt(ctx.area) * 2, k: 1 }),
    });
    state.stats.vCores = (state.stats.vCores || 0) + 1;
    vCount();
  }
  function coreBoom(c, mult) {
    const W = G.world;
    for (const e of enemiesIn(c.x, c.z, c.R)) G.hitEnemy(e, c.ctx, mult, { ang: Math.atan2(e.x - c.x, e.z - c.z), w: 1, kb: 0.8, poise: 8, quiet: true, core: true });
    if (W.blastFx) W.blastFx(c.x, c.z, c.R);
    W.shake(0.15);
    G.sfx('impact', { type: 'fire', w: 1, crit: false });
  }
  function coreOff(c, quietEnd) {
    const i = VS.cores.indexOf(c);
    if (i >= 0) VS.cores.splice(i, 1);
    if (!quietEnd) coreBoom(c, c.ctx.sk.core.end);
    kvOff(c.fx);
    kvOff(c.glow);
    kvOff(c.ring);
    vCount();
  }
  // 你的火焰伤害打中熔核旁边的敌人：熔核再炸一次（gap 秒最多一次，最多 n 次）
  function coreTouch(e) {
    for (const c of VS.cores) {
      const C = c.ctx.sk.core;
      if (c.gap > 0 || c.n >= C.n || dist(e.x, e.z, c.x, c.z) - e.r > c.R) continue;
      c.n++;
      c.gap = C.gap;
      c.glow.k = 1;
      state.stats.vCoreRe = (state.stats.vCoreRe || 0) + 1;
      G.after(0, () => {
        if (VS.cores.indexOf(c) >= 0) coreBoom(c, C.mult);
      });
    }
  }
  function tickCores(dt) {
    for (let i = VS.cores.length - 1; i >= 0; i--) {
      const c = VS.cores[i];
      c.t -= dt;
      if (c.gap > 0) c.gap -= dt;
      if (c.t <= 0) {
        coreOff(c);
        continue;
      }
      // 裂纹一明一暗；刚被点爆时整团发白，慢慢暗回去；用掉的次数在地上的符环里少一段
      c.glow.k = Math.max(0.2 + 0.25 * (Math.sin(state.time * 5 + i) > 0 ? 1 : 0), c.glow.k - dt * 2);
      c.glow.s = 0.75 + 0.1 * c.glow.k;
      c.ring.k = 1 - c.n / c.ctx.sk.core.n;
      c.ring.a = c.t < 0.5 ? 0.3 : 1;
    }
  }
  function meteorPlough(ctx, x, z, dx, dz) {
    const W = G.world, S = ctx.sk.plough;
    const len = Math.max(0.5, rayLen(x, z, Math.atan2(dx, dz), S.len, 0.3));
    VS.ploughs.push({
      x, z, x0: x, z0: z, dx, dz, d: 0, len, sp: S.len / S.t, ctx, hit: new Set(), fd: -9, // fd：上一片火的位置（落点那一片第一帧就铺）
      fx: W.kv('rock', { hex: 0x5a2a14, x, z, y: 0.55, s: 1.3 }), glow: W.kv('orb', { hex: 0xff6a20, x, z, y: 0.6, s: 0.95, k: 0.7 }),
    });
    // 长条的犁痕一次铺好（贴地擦痕，长度的一半 = len / 2）
    W.decal(0, x + (dx * len) / 2, z + (dz * len) / 2, len / 2, Math.atan2(dx, dz), 0xff6a2c, S.field.dur + 0.5, S.w * 0.45);
    state.stats.vPloughs = (state.stats.vPloughs || 0) + 1;
    vCount();
  }
  function tickPloughs(dt) {
    const W = G.world;
    for (let i = VS.ploughs.length - 1; i >= 0; i--) {
      const p = VS.ploughs[i], S = p.ctx.sk.plough, ak = Math.sqrt(p.ctx.area);
      const step = Math.min(p.sp * dt, p.len - p.d);
      p.d += step;
      p.x = p.x0 + p.dx * p.d;
      p.z = p.z0 + p.dz * p.d;
      p.fx.x = p.glow.x = p.x;
      p.fx.z = p.glow.z = p.z;
      p.fx.rx += dt * 9; // 滚着往前犁
      const ang = Math.atan2(p.dx, p.dz);
      for (const e of state.enemies) {
        if (e.dead || p.hit.has(e) || dist(e.x, e.z, p.x, p.z) - e.r > S.w * ak) continue;
        p.hit.add(e);
        // 掀向两侧：看它在犁线的哪一边
        const side = (e.x - p.x) * p.dz - (e.z - p.z) * p.dx >= 0 ? 1 : -1;
        G.hitEnemy(e, p.ctx, S.mult, { ang: ang + (side * Math.PI) / 2, w: 1, kb: 1.8, poise: 14, quiet: true, core: true });
        if (!e.isBoss && W.knockUp) W.knockUp(e.ent, 0.5);
      }
      if (Math.random() < 0.6) W.burst(p.x, 0.4, p.z, 0xffa040, 3, 3, 0.3);
      // 每 2.6 米留一片火（沟里的火）
      if (p.d - p.fd >= 2.6 || (p.d >= p.len && p.fd < p.len - 0.5)) {
        p.fd = p.d;
        const F = S.field;
        addField({ kind: 'burn', x: p.x, z: p.z, r: F.r * ak, dur: F.dur, tick: F.tick, mult: F.mult, ctx: p.ctx, key: 'vPloughT', hex: 0xff6a2c, noDecal: true });
      }
      if (p.d >= p.len) {
        W.burst(p.x, 0.6, p.z, 0xffb050, 14, 5, 0.4);
        W.ring(p.x, p.z, 1.6, 0xff6a2c, 0.3);
        W.shake(0.15);
        kvOff(p.fx);
        kvOff(p.glow);
        VS.ploughs.splice(i, 1);
        vCount();
      }
    }
  }

  // ---------- 闪袭「残像」「换影」 ----------
  // 残像：一个不会动的诱饵（敌人把它当召唤物打，受伤直接吃掉），dur 秒后炸开
  function blinkDecoy(ctx, x, z) {
    const W = G.world, D = ctx.sk.decoy;
    const d = { decoy: true, x, z, r: 0.5, height: 1.8, dead: false, rising: 0, hp: D.hp, maxHp: D.hp, t: D.dur, ctx, ring: W.kv('glyph', { hex: 0xc7a6ff, x, z, y: 0.06, s: D.taunt * 2, k: 1, edge: 1, dash: 28, a: 0.62, ew: 0.08 }) }; // skill-b1：嘲讽范围是一圈淡的细虚线（原来 7 米近白粗环）
    VS.decoys.push(d);
    W.afterimage(P.ent, x, z, 0xc7a6ff, 1, D.dur + 0.15, 0, P.face);
    let n = 0;
    for (const e of state.enemies) {
      if (e.dead || dist(e.x, e.z, x, z) - e.r > D.taunt) continue;
      if (G.tauntEnemy && G.tauntEnemy(e, d, D.dur, D.boss)) n++;
    }
    if (n) W.text(x, z, '嘲讽', '#c7a6ff', 18, { y: 2.6 });
    state.stats.vDecoys = (state.stats.vDecoys || 0) + 1;
    state.stats.vDecoyTaunts = (state.stats.vDecoyTaunts || 0) + n;
    vCount();
  }
  function tickDecoys(dt) {
    const W = G.world;
    for (let i = VS.decoys.length - 1; i >= 0; i--) {
      const d = VS.decoys[i], D = d.ctx.sk.decoy;
      d.t -= dt;
      d.ring.k = Math.max(0, d.t / D.dur);
      d.ring.ry += dt * 1.2;
      if (d.t > 0) continue;
      d.dead = true; // 敌人的嘲讽随即失效
      VS.decoys.splice(i, 1);
      kvOff(d.ring);
      const R = D.r * Math.sqrt(d.ctx.area);
      for (const e of enemiesIn(d.x, d.z, R)) G.hitEnemy(e, d.ctx, D.mult, { ang: Math.atan2(e.x - d.x, e.z - d.z), w: 1, kb: 1.2, poise: 18, quiet: true });
      if (W.vShock) W.vShock(d.x, d.z, R, 0xc7a6ff, 0.32, 0);
      else W.ring(d.x, d.z, R, 0xc7a6ff, 0.35);
      W.burst(d.x, 1.0, d.z, 0xc7a6ff, 22, 6, 0.45);
      W.shake(0.25);
      G.sfx('impact', { type: 'phys', w: 1, crit: false });
      state.stats.vDecoyBursts = (state.stats.vDecoyBursts || 0) + 1;
      vCount();
    }
  }
  // 换影：准星 seek 米内最近的敌人（看得见、够得着）。首领换不动：闪到它身后，削 poise 倍的架势
  function blinkSwap(ctx, a) {
    const W = G.world, sk = ctx.sk, S = sk.swap, hex = hexOf(sk.color);
    let e = null, bd = S.seek;
    for (const o of state.enemies) {
      if (o.dead || o.executed) continue;
      const dc = dist(o.x, o.z, a.tx, a.tz) - o.r;
      if (dc <= bd && dist(o.x, o.z, P.x, P.z) - o.r <= sk.range && losClear(P.x, P.z, o.x, o.z)) {
        bd = dc;
        e = o;
      }
    }
    const ox = P.x, oz = P.z;
    if (!e) {
      // 没有能换的：就地一闪，不打人（冷却照进）
      W.text(P.x, P.z, '没有目标', '#c9c2b4', 14);
      W.burst(ox, 1.0, oz, hex, 10, 3, 0.3);
      return;
    }
    const ex = e.x, ez = e.z;
    let px = ex, pz = ez;
    if (e.isBoss) {
      // 闪到首领身后（离你远的那一侧）
      const ang = Math.atan2(ex - ox, ez - oz);
      for (let k = 0; k < 6; k++) {
        const r = e.r + 0.9, aa = ang + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.5;
        px = ex + Math.sin(aa) * r;
        pz = ez + Math.cos(aa) * r;
        if (W.walkable(px, pz, 0.5)) break;
        px = ox;
        pz = oz;
      }
    } else {
      if (W.walkable(ox, oz, e.r * 0.8)) {
        e.x = ox;
        e.z = oz;
      }
      e.stunT = Math.max(e.stunT || 0, S.stun);
      W.text(e.x, e.z, '定身', '#c7a6ff', 16, { kind: 'tag', y: Math.min(3, (e.height || 2) + 0.4) });
      if (!W.walkable(px, pz, 0.5)) {
        px = ox;
        pz = oz;
      }
    }
    P.x = px;
    P.z = pz;
    P.roll.t = 0;
    P.iframe = Math.max(P.iframe, 0.2);
    // 两道交叉的闪光、两头各一团旋影
    // skill-b1：两道闪电换成贴地的残影带（你过去的那道亮一些，敌人被换回来的那道窄、暗）；W.bolt 走鬼影（随机数照取、不显示）
    const gh = !!W.blinkBand;
    W.bolt([{ x: ox, z: oz }, { x: px, z: pz }], hex, false, { ghost: gh });
    if (!e.isBoss) W.bolt([{ x: px + 0.3, z: pz }, { x: e.x + 0.3, z: e.z }], 0xffffff, true, { ghost: gh });
    if (gh) {
      W.blinkBand(ox, oz, px, pz, hex);
      if (!e.isBoss) W.blinkBand(px, pz, e.x, e.z, 0x8a7aa0, { w: 0.6 });
    }
    if (W.shadowStep) W.shadowStep(ox, oz, px, pz, hex);
    W.afterimage(P.ent, ox, oz, hex, 0.8, 0.35, 0, P.face);
    W.slash(px, pz, Math.random() * TAU, 1.6, 360, hex, { dur: 0.25, inner: 0.7, y: 1.0 });
    G.hitEnemy(e, ctx, 1, { ang: Math.atan2(e.x - px, e.z - pz), w: 2, poise: (sk.poise || 0) * (e.isBoss ? S.poise : 1), quiet: true });
    const R = S.r * Math.sqrt(ctx.area);
    for (const o of enemiesIn(px, pz, R)) if (o !== e) G.hitEnemy(o, ctx, S.side, { ang: Math.atan2(o.x - px, o.z - pz), quiet: true });
    G.hitStop(((sk.stop || 70) + 10) * ctx.stopK);
    W.shake(0.3);
    G.sfx('impact', { type: 'phys', w: 2, crit: lastHit.crit });
    state.stats.vSwaps = (state.stats.vSwaps || 0) + 1;
  }

  // ---------- 旋风斩「掷旋」「旋涡斩」 ----------
  function whirlThrow(ctx) {
    const W = G.world, S = ctx.sk.throw, ai = aimInfo();
    const d = G.clamp(ai.dist, S.min, S.range);
    const len = Math.max(1, rayLen(P.x, P.z, ai.ang, d, 0.3));
    if (VS.disc) discOff();
    const flight = len / S.speed;
    VS.disc = {
      x: P.x + ai.dx * 0.8, z: P.z + ai.dz * 0.8, tx: P.x + ai.dx * len, tz: P.z + ai.dz * len, ph: 'out', t: 0,
      hover: Math.max(S.hover, S.trip - 2 * flight), ctx, hits: new Map(),
      fx: W.kv('blade', { hex: 0xe8c9a0, s: 1.3, rx: Math.PI / 2, y: 1.0 }), ring: W.kv('glyph', { hex: 0xe8c9a0, s: S.r * Math.sqrt(ctx.area) * 2, y: 0.05, k: 1 }),
    };
    G.sfx('swing', { step: 1 });
    state.stats.vThrows = (state.stats.vThrows || 0) + 1;
    vCount();
  }
  function discOff() {
    const c = VS.disc;
    if (!c) return;
    kvOff(c.fx);
    kvOff(c.ring);
    VS.disc = null;
    vCount();
  }
  function tickDisc(dt) {
    const c = VS.disc, S = c.ctx.sk.throw, W = G.world;
    c.t += dt;
    let gx = c.tx, gz = c.tz;
    if (c.ph === 'hover') {
      if (c.t >= c.hover) {
        c.ph = 'back';
        c.t = 0;
      }
    }
    if (c.ph === 'back') {
      gx = P.x;
      gz = P.z;
    }
    if (c.ph !== 'hover') {
      const dx = gx - c.x, dz = gz - c.z, d = Math.hypot(dx, dz), st = S.speed * dt;
      if (d <= st) {
        c.x = gx;
        c.z = gz;
        if (c.ph === 'out') {
          c.ph = 'hover';
          c.t = 0;
        } else {
          // 回到手里
          W.burst(P.x, 1.0, P.z, 0xe8c9a0, 6, 2, 0.2);
          return discOff();
        }
      } else {
        c.x += (dx / d) * st;
        c.z += (dz / d) * st;
      }
    }
    c.fx.x = c.ring.x = c.x;
    c.fx.z = c.ring.z = c.z;
    c.fx.rz += dt * 26;
    c.fx.y = c.ph === 'hover' ? 0.9 + Math.sin(state.time * 12) * 0.05 : 1.0;
    c.ring.a = c.ph === 'hover' ? 1 : 0.3;
    if (Math.random() < 0.5) W.burst(c.x, 0.9, c.z, 0xe8c9a0, 1, 1.5, 0.2);
    const R = S.r * Math.sqrt(c.ctx.area);
    let n = 0;
    for (const e of enemiesIn(c.x, c.z, R)) {
      let h = c.hits.get(e);
      if (!h) c.hits.set(e, (h = { n: 0, next: 0 }));
      if (h.n >= S.cap || state.time < h.next) continue;
      h.n++;
      h.next = state.time + S.gap;
      G.hitEnemy(e, c.ctx, 1, { ang: Math.atan2(e.x - c.x, e.z - c.z) + 1.2, kb: 0.15, poise: 6, quiet: true });
      n++;
    }
    if (n) {
      W.slash(c.x, c.z, Math.random() * TAU, R, 360, 0xe8c9a0, { dur: 0.14, inner: 0.7, y: 0.95 });
      G.sfx('impact', { type: 'phys', w: 0, crit: lastHit.crit });
      state.stats.vDiscHits = (state.stats.vDiscHits || 0) + n;
    }
  }
  // 旋涡斩：每一下把 pull.r 以内的敌人往身边吸（首领不动；被吸到离你 1.2 米就停）
  // 旋涡斩 / 蓄潮：每下最多绞到离你最近的 cap 个（聚成一团时不再每只都吃满；散开、单体照旧）
  function whirlCap(list, sk) {
    const cap = sk.mech === 'pull' ? sk.pull.cap : sk.mech === 'tide' ? sk.tide.cap : 0;
    if (!cap || list.length <= cap) return list;
    return list.sort((a, b) => dist(a.x, a.z, P.x, P.z) - dist(b.x, b.z, P.x, P.z)).slice(0, cap);
  }
  function whirlPull(ctx) {
    const S = ctx.sk.pull, R = S.r * Math.sqrt(ctx.area), stepD = S.v * ctx.time;
    for (const e of state.enemies) {
      if (e.dead || e.isBoss || pinned(e)) continue;
      const d = dist(e.x, e.z, P.x, P.z);
      if (d - e.r > R || d < 1.2 + e.r) continue;
      if (G.pullEnemy) G.pullEnemy(e, P.x, P.z, Math.min(G.bindPullSpeed(e, stepD), d - 1.2 - e.r));
    }
    G.world.vSuck(P.x, P.z, R, 0xcbbba6, 10);
  }
  // 砸地收尾：转了几下就砸几成（封顶 max），之后有一小段收招
  function whirlSlam(c) {
    const W = G.world, ctx = G.skillCtx(c.id), sk = ctx.sk, S = sk.pull;
    const n = Math.min(c.pulses, S.max), R = S.sr * Math.sqrt(ctx.area);
    endChannel();
    const ang = P.face;
    let k = 0;
    for (const e of whirlCap(enemiesIn(P.x, P.z, R), sk)) {
      G.hitEnemy(e, ctx, S.slam * n, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: 2, kb: 1.4, poise: 6 * n, quiet: true });
      k++;
    }
    W.smashFx(P.x, P.z, R, ang);
    W.decal(5, P.x, P.z, R * 0.9, Math.random() * TAU, 0xffb050, 2.4);
    if (W.vShock) W.vShock(P.x, P.z, R, hexOf(sk.color), 0.3, 0);
    else W.ring(P.x, P.z, R, hexOf(sk.color), 0.35);
    W.shake(0.2 + 0.04 * n);
    G.sfx(k ? 'impact' : 'hit', { type: 'phys', w: 2, crit: false });
    W.play(P.ent, 'attack3', { dur: 0.4, contact: 0.05 });
    P.cast = { slot: c.slot, id: c.id, t: 0, fired: true, aim: ang, step: -1, st: null, dur: 0.34, fireT: 0, cancelT: 0.22 };
    state.stats.vSlams = (state.stats.vSlams || 0) + 1;
    state.stats.vSlamN = n;
  }

  // ---------- 影步连斩「影印」「影分」 ----------
  function markAdd(e, M) {
    e.vMark = Math.min(M.max, (e.vMark || 0) + 1);
    e.vMarkT = state.time + M.dur;
    if (!VS.marks.has(e)) {
      VS.marks.add(e);
      e.vMarkFx = [];
      vCount();
    }
    while (e.vMarkFx.length < e.vMark) e.vMarkFx.push(G.world.kv('shard', { hex: 0x9fb4ff, s: 0.22, k: 0.5 }));
    state.stats.vMarks = (state.stats.vMarks || 0) + 1;
  }
  function markClear(e) {
    if (e.vMarkFx) for (const h of e.vMarkFx) kvOff(h);
    e.vMarkFx = null;
    e.vMark = 0;
    VS.marks.delete(e);
  }
  // 满层再砍：只引爆这一只身上的
  function markPop(e, ctx, M) {
    const k = e.vMark || 0;
    markClear(e);
    G.hitEnemy(e, ctx, M.mult * k, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: 1, kb: 0.3, poise: 4 * k, quiet: true });
    // 单只引爆：一圈环 + 一团碎光（四面刀光留给松手时的齐爆，连斩里一刀一爆的话刀光太多、draw call 也多）
    const W = G.world, h = e.height || 2;
    if (W.vShock) W.vShock(e.x, e.z, e.r + 0.9, 0x9fb4ff, 0.22, 0);
    W.burst(e.x, h * 0.6, e.z, 0xdfe6ff, 14, 5, 0.3);
    state.stats.vMarkPops = (state.stats.vMarkPops || 0) + 1;
    vCount();
  }
  // 连斩停下：所有影印一齐引爆，每层 mark.mult 倍（名字别和残刃的 markBurst(e) 撞上：同一个作用域里后声明的会顶掉前面的）
  function shadeMarkBurst() {
    const W = G.world, ctx = G.skillCtx('shadestep'), M = ctx.sk.mark;
    let fx = 0, n = 0;
    for (const e of Array.from(VS.marks)) {
      const k = e.vMark || 0;
      markClear(e);
      if (e.dead || !k || !M) continue;
      G.hitEnemy(e, ctx, M.mult * k, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: 1, kb: 0.4, poise: 4 * k, quiet: true });
      if (fx++ < 2 && W.markBurstFx) W.markBurstFx(e.x, e.z, e.height || 2, e.r, e.r + 0.6); // 四面刀光最多两处，其余只放碎光
      else W.burst(e.x, (e.height || 2) * 0.6, e.z, 0x9fb4ff, 10, 4, 0.3);
      n += k;
    }
    if (n) {
      W.shake(0.2);
      G.sfx('impact', { type: 'phys', w: 1, crit: false });
      state.stats.vMarkBursts = (state.stats.vMarkBursts || 0) + 1;
      state.stats.vMarkStacks = (state.stats.vMarkStacks || 0) + n;
    }
    vCount();
  }
  function tickMarks() {
    const M = G.SKILLS.shadestep.mark || { max: 3 };
    let i = 0;
    for (const e of Array.from(VS.marks)) {
      if (e.dead || state.time > e.vMarkT) {
        markClear(e);
        continue;
      }
      // 层数：几枚小晶片绕着头顶转
      const h = (e.height || 2) + 0.35, n = e.vMarkFx.length;
      for (let k = 0; k < n; k++) {
        const f = e.vMarkFx[k], a = state.time * 3 + (k / n) * TAU + i;
        f.x = e.x + Math.sin(a) * 0.45;
        f.z = e.z + Math.cos(a) * 0.45;
        f.y = h;
        f.ry = a;
        f.k = e.vMark >= M.max ? 0.9 : 0.45; // 满层更亮
      }
      i++;
    }
    if (!VS.marks.size) vCount();
  }
  // 影分：在目标另一侧留一个影子，delay 秒后它把这一刀再砍一遍（目标还在附近就以它为中心，不然砍原来那一点）
  function shadeClone(ctx, e, cx, cz, R) {
    const W = G.world, C = ctx.sk.clone;
    const ax = cx - P.x, az = cz - P.z, al = Math.hypot(ax, az) || 1;
    const off = (e.dead ? 0 : e.r) + 0.9;
    const kx = cx + (ax / al) * off, kz = cz + (az / al) * off;
    const face = Math.atan2(cx - kx, cz - kz);
    W.afterimage(P.ent, kx, kz, 0x4a5aa8, 0.9, C.delay + 0.2, 0, face);
    VS.clones++;
    G.after(C.delay, () => {
      VS.clones--;
      let x = cx, z = cz;
      if (!e.dead && dist(e.x, e.z, cx, cz) < 3) {
        x = e.x;
        z = e.z;
      }
      W.slash(kx, kz, Math.atan2(x - kx, z - kz), dist(x, z, kx, kz) + R * 0.75, 140, 0x4a5aa8, { dir: -1, dur: 0.16 });
      let n = 0;
      for (const o of enemiesIn(x, z, R)) {
        G.hitEnemy(o, ctx, C.mult, { ang: Math.atan2(o.x - kx, o.z - kz), w: 0, kb: 0.1, poise: 4, quiet: true });
        n++;
      }
      if (n) G.sfx('impact', { type: 'phys', w: 0, crit: false });
      state.stats.vCloneStrikes = (state.stats.vCloneStrikes || 0) + 1;
      state.stats.vCloneHits = (state.stats.vCloneHits || 0) + n;
    });
  }

  // ---------- 黑洞「双极」「坍缩」 ----------
  function holeMark(h, sk) {
    if (h && sk.mech === 'collapse') {
      h.collapse = true;
      h.mass = 0;
      h.R0 = h.R;
    }
    return h;
  }
  // 双极：准星两侧各一个（垂直于瞄准方向，相距 gap，撞墙就往中间收），第一个洞管牵引和伤害，第二个只画
  function holeTwin(ctx, x, z, a, R, dur) {
    const sk = ctx.sk, T = sk.twin, px = Math.cos(a.ang), pz = -Math.sin(a.ang);
    const half = T.gap / 2, mk = (s) => {
      const d = rayLen(x, z, Math.atan2(px * s, pz * s), half, 0.3);
      return { x: x + px * s * d, z: z + pz * s * d };
    };
    const p0 = mk(1), p1 = mk(-1);
    const base = { R, pullR: R * sk.pullR, t: 0, dur, tick: sk.tick, tt: sk.tick, ctx, mult: 1, pullMul: 1, mouth: false };
    const h0 = addHole(Object.assign({ x: p0.x, z: p0.z }, base));
    const h1 = addHole(Object.assign({ x: p1.x, z: p1.z }, base, { twinB: true }));
    h0.twin = h1;
    h1.twin = h0;
    h0.tether = G.world.kv('band', { hex: 0xff6ad2, w: T.w * Math.sqrt(ctx.area), y: 0.35, x0: p0.x, z0: p0.z, x1: p1.x, z1: p1.z });
    h1.tether = null;
    state.stats.vTwins = (state.stats.vTwins || 0) + 1;
    return h0;
  }
  // 双极这一跳挨打的：两个洞里的、索上的（索宽 twin.w，吃范围加成）
  function twinTargets(h, tw) {
    const out = [], T = h.ctx.sk.twin, half = (T.w / 2) * Math.sqrt(h.ctx.area);
    const sx = tw.x - h.x, sz = tw.z - h.z, L2 = sx * sx + sz * sz || 1;
    for (const e of state.enemies) {
      if (e.dead) continue;
      if (dist(e.x, e.z, h.x, h.z) - e.r <= h.R || dist(e.x, e.z, tw.x, tw.z) - e.r <= tw.R) {
        out.push(e);
        continue;
      }
      const u = G.clamp(((e.x - h.x) * sx + (e.z - h.z) * sz) / L2, 0, 1);
      if (dist(e.x, e.z, h.x + sx * u, h.z + sz * u) - e.r <= half) {
        out.push(e);
        state.stats.vTetherHits = (state.stats.vTetherHits || 0) + 1;
      }
    }
    return out;
  }
  // 坍缩：长一点质量（封顶 cap），半径和画面跟着变大
  function holeGrow(h) {
    const C = h.ctx.sk.collapse;
    if (h.mass >= C.cap) return;
    h.mass++;
    const k = 1 + h.mass / C.grow;
    h.R = h.R0 * k;
    h.pullR = h.R * h.ctx.sk.pullR;
    if (h.fx && G.world.holeScale) G.world.holeScale(h.fx, k);
  }
  function holeCollapse(h, k) {
    const W = G.world, C = h.ctx.sk.collapse, R = h.R * C.r, mult = (C.k0 + C.k1 * h.mass) * k;
    let list = enemiesIn(h.x, h.z, R);
    const cap = C.hit || 0; // 坍缩也最多砸到离洞最近的 collapse.hit 个
    if (cap && list.length > cap) list = list.sort((a, b) => dist(a.x, a.z, h.x, h.z) - dist(b.x, b.z, h.x, h.z)).slice(0, cap);
    for (const e of list) G.hitEnemy(e, h.ctx, mult, { ang: Math.atan2(e.x - h.x, e.z - h.z), w: 2, kb: 1.0, poise: 10 + h.mass, quiet: true });
    // 空心的冲击环 + 近黑的核一闪（不画实心圆盘：圈里的怪要看得清）
    if (W.vShock) W.vShock(h.x, h.z, R, 0xff6ad2, 0.38, 1.2);
    else W.ring(h.x, h.z, R, 0xff6ad2, 0.4);
    W.burst(h.x, 0.8, h.z, 0xff6ad2, 16 + Math.min(16, h.mass >> 1), 7, 0.4);
    W.shake(0.2 + Math.min(0.3, h.mass * 0.01));
    G.sfx('hit');
    state.stats.vCollapses = (state.stats.vCollapses || 0) + 1;
    state.stats.vCollapseMass = h.mass;
    state.stats.vCollapseN = list.length; // 测试用：这次坍缩砸到几个
    h.collapse = false; // 只塌一次
  }
  // 再按一次：坍缩的黑洞还在就当场引爆；掷旋飞出去时召回。返回 1 这一下用掉了，2 这个键这一帧跳过，0 照常施放
  function vRecast(slot, id) {
    if (!(G.input.tap[slot] > 0)) return id === 'whirl' && VS.disc && G.SKILLS.whirl.mech === 'throw' ? 2 : 0;
    if (id === 'blackhole' && G.SKILLS.blackhole.mech === 'collapse') {
      const i = holes.findIndex((h) => h.collapse && !h.mouth);
      if (i < 0) return 0;
      G.input.tap[slot] = 0;
      holeCollapse(holes[i], 1);
      removeHole(i);
      return 1;
    }
    if (id === 'whirl' && VS.disc && G.SKILLS.whirl.mech === 'throw') {
      G.input.tap[slot] = 0;
      if (VS.disc.ph !== 'back') {
        VS.disc.ph = 'back';
        VS.disc.t = 0;
      }
      return 1;
    }
    return 0;
  }

  // ---------- 黑旋风「护涡」「汇涡」 ----------
  // 外形参数：交给 world 的龙卷渲染器（W.makeVortex 的 o / W.vortexSet；没有这套参数的渲染器就忽略）——
  // 护涡矮、粗、不前倾、不拖尾迹，转得急；汇涡按合并后的半径重算高 / 口子 / 吸尘范围 / 转速，层数越高越像一根粗柱子
  function vortexLook(v) {
    if (v.guard) return { H: 1.25, rT: 0.6, taper: 0.32, spin: 13, lean: 0, ground: 0.6, trail: false, motes: 4 };
    if (v.lvl) {
      const R = v.R;
      return { H: Math.min(3.6, 1.3 + 1.65 * R), rT: 0.15 + 0.5 * R, taper: 0.18 + 0.05 * (v.lvl - 1), pull: 1.35 * R + 0.3, spin: 9 * Math.pow(0.9 / R, 0.8), motes: 4 + 2 * v.lvl };
    }
    return undefined;
  }
  function clearGuard() {
    for (let i = vortices.length - 1; i >= 0; i--) if (vortices[i].guard) removeVortex(i);
  }
  // 护涡（光环）：放在技能栏上就一直有 n 团绕着你转（基础三团，多重投射再加），寿命无限；少了（死亡、换区域、被顶掉）就整组补上，
  //   团数变了就整组重排（转的相位接着原来的）。每 ctx.time 秒按此刻的属性换一次三团共用的 ctx（升级、换辅助、换装备马上生效），
  //   顺手把已死敌人的跳数记录清掉。伤害、拽怪、吞弹都在 guardStep 里，和原来按一次放出的那组一样
  function guardAura(ctx, dt) {
    const sk = ctx.sk, n = sk.count + Math.max(0, ctx.proj - 1), R = sk.radius * Math.sqrt(ctx.area);
    const mine = vortices.filter((v) => v.guard && v.guard.aura);
    const t0 = mine.length ? mine[0].t : 0;
    P.auraT.vortex = (P.auraT.vortex === undefined ? 0 : P.auraT.vortex) - dt;
    if (mine.length && mine.length !== n) {
      clearGuard();
      mine.length = 0;
    }
    if (!mine.length) {
      clearGuard();
      P.auraT.vortex = ctx.time;
      const cast = new Map();
      for (let i = 0; i < n; i++) {
        const a = t0 * sk.guard.w + (i / n) * TAU, r = sk.guard.r * Math.sqrt(ctx.area);
        const v = { x: P.x + Math.sin(a) * r, z: P.z + Math.cos(a) * r, a: a + Math.PI / 2, speed: 0, life: Infinity, t: t0, R, R0: R, ctx, cast, seen: new Map(), lat: null, latT: 0, latN: 0, bounce: 0, skip: 0, chain: 0, wf: [0, 0, 0, 0], guard: { i, n, aura: true }, lvl: 0 };
        while (vortices.length >= VORTEX_MAX) removeVortex(0);
        v.fx = G.world.makeVortex ? G.world.makeVortex(v.x, v.z, R, i, vortexLook(v)) : null;
        vortices.push(v);
      }
      state.stats.vGuardSpawn = (state.stats.vGuardSpawn || 0) + 1;
      return;
    }
    if (P.auraT.vortex > 0) return;
    P.auraT.vortex = ctx.time;
    for (const v of mine) {
      v.ctx = ctx;
      v.R = v.R0 = R;
    }
    for (const e of mine[0].cast.keys()) if (e.dead) mine[0].cast.delete(e);
  }
  // 护涡光环不生效了（拿下技能栏、换了刻式）：当场收起。computeStats 里调用（绑技能 / 镶辅助 / 穿脱装备 / 换刻式都会走到）
  G.guardSync = function () {
    if (!G.auraOn('vortex') && vortices.some((v) => v.guard && v.guard.aura)) clearGuard();
  };
  // 护涡：绕着你转（guard.r，吃范围加成），把 guard.pull 以内的小怪往旋风拽，吞掉碰到的敌方弹丸；半径内的敌人每 tick 一跳（不受跳数上限）
  function guardStep(v, dt) {
    const sk = v.ctx.sk, Gd = sk.guard, ak = Math.sqrt(v.ctx.area), r = Gd.r * ak;
    if (P.dead) return false;
    const a = v.t * Gd.w + (v.guard.i / v.guard.n) * TAU;
    v.x = P.x + Math.sin(a) * r;
    v.z = P.z + Math.cos(a) * r;
    v.a = a + Math.PI / 2;
    for (const o of state.enemies) {
      if (o.dead || o.isBoss || pinned(o)) continue;
      const d = dist(o.x, o.z, v.x, v.z);
      if (d - o.r > Gd.pull || d < 0.5) continue;
      if (G.pullEnemy) G.pullEnemy(o, v.x, v.z, Math.min(G.bindPullSpeed(o, sk.latch.pull) * dt, d - 0.5));
    }
    const list = state.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (!p || p.owner === 'p' || dist(p.x, p.z, v.x, v.z) > v.R + p.r + 0.2) continue;
      G.world.burst(p.x, 1.0, p.z, 0xff6ad2, 5, 2, 0.2);
      removeProjectile(i);
      state.stats.vEaten = (state.stats.vEaten || 0) + 1;
    }
    for (const e of enemiesIn(v.x, v.z, v.R)) {
      let c = v.cast.get(e);
      if (!c) v.cast.set(e, (c = { next: 0, n: 0 }));
      if (state.time < c.next) continue;
      c.next = state.time + sk.tick * 0.95;
      c.n++;
      G.hitEnemy(e, v.ctx, 1, { ang: v.a, quiet: true, tick: true });
      state.stats.vGuardHits = (state.stats.vGuardHits || 0) + 1;
    }
    if (v.fx && G.world.vortexTighten) G.world.vortexTighten(v.fx, 0.6);
    return true;
  }
  // 汇涡：拐向 seek 米内最近的另一团汇涡；碰上了就并成一团（层数相加，封顶 max；半径按层数的平方根长，寿命接上 life 秒）
  function mergeSteer(v, dt) {
    const M = v.ctx.sk.merge;
    let best = null, bd = M.seek;
    for (const o of vortices) {
      if (o === v || !o.lvl || o.dead) continue;
      const d = dist(o.x, o.z, v.x, v.z);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    if (!best) {
      // 附近没有别的汇涡：拐向 seek 米内最近的敌人，压到它身上就放慢（合得越多越沉）
      let tg = null, td = M.seek;
      for (const e of state.enemies) {
        if (e.dead) continue;
        const d = dist(e.x, e.z, v.x, v.z) - e.r;
        if (d < td) {
          td = d;
          tg = e;
        }
      }
      if (!tg) return;
      v.a += G.clamp(angDiff(Math.atan2(tg.x - v.x, tg.z - v.z), v.a), -M.turn * dt, M.turn * dt);
      v.speed = (v.ctx.sk.speed / Math.sqrt(v.lvl)) * (td < v.R ? 0.35 : 1);
      return;
    }
    if (bd < (v.R + best.R) * 0.6 && v.lvl >= best.lvl && v.t >= M.after && best.t >= M.after) { // 刚放出来的先各飞一会儿，看得出是在靠拢
      v.lvl = Math.min(M.max, v.lvl + best.lvl);
      v.R = v.R0 * Math.sqrt(v.lvl);
      v.life = Math.max(v.life, best.life) + M.life * v.ctx.durK;
      v.speed = v.ctx.sk.speed / Math.sqrt(v.lvl);
      for (const [e, c] of best.cast) if (!v.cast.has(e)) v.cast.set(e, c);
      best.dead = true;
      best.life = 0; // 下一帧在 updateChaos 里收起
      const W = G.world;
      if (v.fx && W.vortexSet) {
        W.vortexSet(v.fx, vortexLook(v));
        if (W.vortexPuff) W.vortexPuff(v.x, v.z, 1 + 0.3 * v.lvl);
      } else if (v.fx && W.makeVortex && W.removeVortex) {
        W.removeVortex(v.fx);
        v.fx = W.makeVortex(v.x, v.z, v.R, 0);
      }
      W.ring(v.x, v.z, v.R + 0.4, 0xff6ad2, 0.3);
      W.burst(v.x, 0.8, v.z, 0xff6ad2, 12, 4, 0.35);
      state.stats.vMerges = (state.stats.vMerges || 0) + 1;
      state.stats.vMergeTop = Math.max(state.stats.vMergeTop || 0, v.lvl);
      return;
    }
    const want = Math.atan2(best.x - v.x, best.z - v.z);
    v.a += G.clamp(angDiff(want, v.a), -M.turn * dt, M.turn * dt);
  }

  // ---------- 黑焰「蚀印」「传焰」 ----------
  // 命中时的钩子（hitEnemy 里）：带黑焰的一击给蚀印攒上同样多 / 把黑焰那一份点在身上；火焰伤害点燃旁边的熔核
  function vHit(e, hit, inf) {
    if (VS.cores.length && hit.parts.fire > 0 && !inf.core) coreTouch(e);
    if (!(hit.flame > 0) || e.dead) return;
    const bf = G.SKILLS.blackflame;
    if (bf.brand) brandAdd(e, hit.flame, bf.brand);
    else if (bf.flameDot) dotAdd(e, hit.flame, 0);
  }
  function brandAdd(e, v, B) {
    e.vBrand = (e.vBrand || 0) + 1;
    e.vBrandV = (e.vBrandV || 0) + v;
    if (!VS.brands.has(e)) {
      VS.brands.add(e);
      e.vBrandFx = G.world.kv('glyph', { hex: 0xe04cc0, s: (e.r + 0.5) * 2, y: 0.07 });
      vCount();
    }
    e.vBrandFx.k = e.vBrand / B.n;
    if (e.vBrand < B.n || e.hp <= 0) return;
    // 满层：下一帧炸开（不在这一击里面再打一层伤害）
    const amt = e.vBrandV;
    e.vBrand = 0;
    e.vBrandV = 0;
    e.vBrandFx.k = 0;
    G.after(0, () => {
      if (e.dead && !(e.deathT > 0)) return;
      const W = G.world, R = B.r + e.r * 0.5;
      const pc = procCtx('chaos', amt);
      if (!e.dead) G.hitEnemy(e, pc, 1, { proc: true, w: 1, kb: 0, poise: 6 });
      for (const o of enemiesIn(e.x, e.z, R)) if (o !== e) G.hitEnemy(o, pc, 0.5, { proc: true, quiet: true, kb: 0.3 });
      if (W.vShock) W.vShock(e.x, e.z, R, 0xe04cc0, 0.28, 0.6); // 细环 + 一闪的暗核（渊陷那圈实心的环会盖住怪）
      else if (W.voidFx) W.voidFx(e.x, e.z, R);
      state.stats.vBrandBursts = (state.stats.vBrandBursts || 0) + 1;
    });
  }
  function brandClear(e) {
    kvOff(e.vBrandFx);
    e.vBrandFx = null;
    e.vBrand = e.vBrandV = 0;
    VS.brands.delete(e);
  }
  function tickBrands() {
    for (const e of Array.from(VS.brands)) {
      if (e.dead) {
        brandClear(e);
        continue;
      }
      const f = e.vBrandFx;
      f.x = e.x;
      f.z = e.z;
      f.ry += 0.02;
    }
    if (!VS.brands.size) vCount();
  }
  // 传焰：把 v 点的伤害加进它身上的黑焰池，dur 秒内匀速烧完；depth 跳过几次（跳过来的已经乘过了）
  function dotAdd(e, v, depth) {
    if (!e.vDot) e.vDot = { pool: 0, depth: 0, tt: 0.25, rate: 0, fx: null };
    const d = e.vDot;
    d.pool += v;
    d.depth = Math.max(d.depth, depth);
    d.rate = d.pool / G.SKILLS.blackflame.dot.dur; // 每秒烧掉多少（池子变大就烧得快）
    if (!VS.dots.has(e)) {
      VS.dots.add(e);
      d.fx = G.world.kv('orb', { hex: 0xb02aa0, s: 0.3, k: 0.4 });
      vCount();
    }
  }
  function dotOff(e) {
    if (e.vDot) kvOff(e.vDot.fx);
    e.vDot = null;
    VS.dots.delete(e);
  }
  function tickDots(dt) {
    for (const e of Array.from(VS.dots)) {
      const d = e.vDot;
      if (!d || e.dead) {
        dotOff(e);
        continue;
      }
      d.tt -= dt;
      const h = e.height || 2, f = d.fx;
      f.x = e.x + Math.sin(state.time * 7) * 0.12;
      f.z = e.z + e.r * 0.5;
      f.y = h * 0.75 + Math.abs(Math.sin(state.time * 9)) * 0.15;
      f.s = 0.24 + 0.06 * (d.depth + 1);
      f.k = Math.sin(state.time * 13) > 0 ? 0.6 : 0.2;
      if (d.tt > 0) continue;
      d.tt += 0.25;
      const v = Math.min(d.pool, Math.max(d.rate * 0.25, 0.5));
      d.pool -= v;
      if (v > 0) G.hitEnemy(e, procCtx('chaos', v), 1, { proc: true, quiet: true, faint: true, tick: true, kb: 0, poise: 0, noBuild: false });
      if (d.pool <= 0.01) dotOff(e);
    }
    if (!VS.dots.size) vCount();
  }
  // 宿主死了（killEnemy 开头）：没烧完的跳到 jump 米内最近的敌人，加深 k 倍（最多跳 max 次）
  function dotJump(e) {
    const d = e.vDot, D = G.SKILLS.blackflame.dot;
    if (!d || !D || d.depth >= D.max) return;
    let best = null, bd = D.jump;
    for (const o of state.enemies) {
      if (o.dead || o === e) continue;
      const dd = dist(o.x, o.z, e.x, e.z) - o.r;
      if (dd <= bd) {
        bd = dd;
        best = o;
      }
    }
    if (!best) return;
    dotAdd(best, d.pool * D.k, d.depth + 1);
    d.pool = 0;
    G.world.bolt([{ x: e.x, z: e.z }, { x: best.x, z: best.z }], 0xe04cc0, true);
    G.world.burst(best.x, (best.height || 2) * 0.7, best.z, 0xe04cc0, 8, 2.5, 0.3);
    state.stats.vDotJumps = (state.stats.vDotJumps || 0) + 1;
  }

  // ---------- 磐垒（守像）：护域里你受到的伤害倍率、敌人的减速 ----------
  // 场上的磐垒守像在 minions.js 里；这里只按位置查。没有磐垒时 1 / 0
  function bastionAt(x, z) {
    for (const m of state.minions) {
      if (m.dead || m.rising > 0 || !m.ctx || !m.ctx.minion || m.ctx.minion.mech !== 'bastion') continue;
      const B = m.ctx.minion.vx;
      if (dist(m.x, m.z, x, z) <= B.r) return B;
    }
    return null;
  }
  G.bastionK = function (x, z) {
    if (!state.minions.length) return 1;
    const B = bastionAt(x, z);
    return B ? 1 - B.dr / 100 : 1;
  };
  G.bastionSlow = function (e) {
    if (!state.minions.length) return 0;
    const B = bastionAt(e.x, e.z);
    return B ? B.slow : 0;
  };

  // ---------- 每帧 ----------
  function updateVariants(dt) {
    if (VS.sticks.length) tickSticks(dt);
    if (VS.traps.length) tickTraps(dt);
    if (VS.orbits.length) tickOrbits(dt);
    if (VS.pylons.length || VS.links.length) tickPylons(dt);
    if (VS.cores.length) tickCores(dt);
    if (VS.ploughs.length) tickPloughs(dt);
    if (VS.decoys.length) tickDecoys(dt);
    if (VS.disc) tickDisc(dt);
    if (VS.marks.size) tickMarks();
    if (VS.brands.size) tickBrands();
    if (VS.dots.size) tickDots(dt);
    if (P.vShield) tickShield(dt);
    vCount();
  }
  // 换区域 / 重生：全部收起（不炸、不结算）
  function resetVariants() {
    for (const st of VS.sticks) if (st.e) st.e.vStick = 0;
    VS.sticks.length = VS.traps.length = VS.orbits.length = VS.pylons.length = VS.cores.length = VS.ploughs.length = 0;
    for (const d of VS.decoys) d.dead = true;
    VS.decoys.length = 0;
    VS.links.length = 0;
    for (const e of VS.marks) e.vMark = 0;
    VS.marks.clear();
    for (const e of VS.brands) e.vBrand = e.vBrandV = 0;
    VS.brands.clear();
    for (const e of VS.dots) e.vDot = null;
    VS.dots.clear();
    VS.disc = null;
    VS.focus.e = null;
    VS.focus.n = 0;
    VS.crystals.length = 0;
    VS.shell = null;
    P.vShield = null;
    if (G.world.kvClear) G.world.kvClear();
    vCount();
  }
  G.variantState = () => VS; // 测试用

  // 光环的一次脉冲：身边 radius（吃范围加成）以内的所有敌人各挨一小下（光环不经过施放，这里只在被直接调用时生效）
  // =====================================================================
  // 第一批新技能（skill-expand）：冰脊 / 坠凌 / 迸电 / 引雷。散钉走 proj（count / hitCap），放血走 melee（sk.st + 流血）。
  // 特效先走 fxOpt 的可选接口（world 有就画形状批的版本），没有时只用现成的池化零件（frostSparkle / bolt / vDecal / 预警圈），不建新网格
  // =====================================================================
  // 冰脊：从脚下朝准星逐段刺出冰棱，撞墙截断；同一次施放每个敌人只吃一下（回响重放是新的一次）
  SKILL_FX.line = function (ctx, a) {
    const sk = ctx.sk;
    const k = Math.sqrt(ctx.area);
    const half = (sk.width / 2) * k;
    const x0 = P.x, z0 = P.z, ang = a.ang;
    const sn = Math.sin(ang), cs = Math.cos(ang);
    const len = Math.max(1, rayLen(x0, z0, ang, sk.len * k, -0.2) + 0.3);
    const n = sk.seg, segL = len / n;
    const hex = hexOf(sk.color);
    const hit = new Set();
    state.stats.lineCasts = (state.stats.lineCasts || 0) + 1;
    G.sfx('impact', { type: 'cold', w: 0, crit: false });
    const FK = sk.mech === 'fork' ? sk.fork : null; // 刻式「岔脊」
    const lance = sk.mech === 'lance'; // 刻式「冰枪」：扎中第一个就停
    let forks = 0, stop = false;
    // 岔脊：在 (ex, ez) 脚下向两侧各横刺一道 len 米（撞墙截断），这一次施放已经打中的不再打
    const inMain = (e) => {
      const dx = e.x - x0, dz = e.z - z0, along = dx * sn + dz * cs;
      return along >= -e.r && along <= len + e.r && Math.abs(dx * cs - dz * sn) <= half + e.r;
    };
    const fork = (ex, ez) => {
      const fh = (FK.width / 2) * k;
      for (const sd of [1, -1]) {
        const fa = ang + (sd * Math.PI) / 2;
        const fl = Math.max(0.5, rayLen(ex, ez, fa, FK.len * k, -0.2) + 0.3);
        const fn = 2, fsl = fl / fn;
        for (let j = 0; j < fn; j++) {
          G.after(0.05 + j * sk.segT, () => {
            if (P.dead) return;
            const fx = ex + Math.sin(fa) * fsl * j, fz = ez + Math.cos(fa) * fsl * j;
            fxOpt('frostLineSeg', fx, fz, fa, fsl, fh, j, 4, hex, 0.7);
            for (const e of enemiesInLine(fx, fz, fa, fsl, fh)) {
              if (hit.has(e) || inMain(e) || !losClear(ex, ez, e.x, e.z)) continue; // 主脊会刺到的留给主脊
              hit.add(e);
              state.stats.forkHits = (state.stats.forkHits || 0) + 1;
              G.hitEnemy(e, ctx, FK.k, { ang: fa, quiet: true });
            }
          });
        }
      }
    };
    for (let i = 0; i < n; i++) {
      const seg = () => {
        if (P.dead || stop) return;
        const sx = x0 + sn * segL * i, sz = z0 + cs * segL * i;
        let segHit = null;
        if (lance) {
          // 冰枪：这一段里离你最近的那个就是扎中的，冰枪停在它身上
          for (const e of enemiesInLine(sx, sz, ang, segL, half)) {
            if (hit.has(e) || !losClear(x0, z0, e.x, e.z)) continue;
            if (!segHit || dist(e.x, e.z, x0, z0) < dist(segHit.x, segHit.z, x0, z0)) segHit = e;
          }
        }
        const drawL = segHit ? Math.max(0.3, (segHit.x - sx) * sn + (segHit.z - sz) * cs) : segL;
        if (!fxOpt('frostLineSeg', sx, sz, ang, drawL, half, i, n, hex, lance ? 0.6 : 1)) {
          G.world.frostSparkle(sx + sn * drawL * 0.5, 0.35, sz + cs * drawL * 0.5, half);
          G.world.vDecal('frost', sx + sn * drawL * 0.5, sz + cs * drawL * 0.5, Math.max(half, drawL * 0.5), 1.5, 0x9fdcff, { a: 0.6 });
        }
        if (segHit) {
          stop = true;
          hit.add(segHit);
          state.stats.lanceHits = (state.stats.lanceHits || 0) + 1;
          fxOpt('lanceTip', segHit.x, segHit.z, hex);
          G.hitEnemy(segHit, ctx, 1, { ang, quiet: true });
          return;
        }
        if (lance) return;
        for (const e of enemiesInLine(sx, sz, ang, segL, half)) {
          if (hit.has(e) || !losClear(x0, z0, e.x, e.z)) continue;
          hit.add(e);
          G.hitEnemy(e, ctx, 1, { ang, quiet: true });
          if (FK && forks < FK.max) {
            forks++;
            state.stats.forks = (state.stats.forks || 0) + 1;
            fork(e.x, e.z);
          }
        }
      };
      if (i === 0) seg();
      else G.after(i * sk.segT, seg);
    }
  };
  // 坠凌：准星处 dur × 绵延 秒里每 tick 秒落一根冰凌（落下要 fall 秒）。每 5 根里 scatter 那几根随便落在圈里，
  // 其余优先砸向这一场里被砸得少的敌人（看得见圈心的）；砸中落点 hitR 内的敌人
  G.rainsLive = () => rainsLive.filter((r) => !r.dead && r.end > state.time);
  SKILL_FX.rain = function (ctx, a) {
    const sk = ctx.sk;
    const ak = Math.sqrt(ctx.area);
    const d = rayLen(P.x, P.z, a.ang, Math.min(sk.range, a.dist), 0);
    let x = P.x + Math.sin(a.ang) * d, z = P.z + Math.cos(a.ang) * d;
    if (sk.mech === 'follow') {
      x = P.x;
      z = P.z;
    }
    const R = sk.radius * ak, hr = sk.hitR * ak;
    const n = Math.max(1, Math.round((sk.dur * (ctx.durK || 1)) / sk.tick));
    const total = sk.delay + (n - 1) * sk.tick + sk.fall;
    const struck = new Map();
    const hex = hexOf(sk.color);
    const rain = { x, z, R, n, hits: 0, end: state.time + total, dead: false };
    state.stats.rains = (state.stats.rains || 0) + 1;
    if (sk.mech === 'slam') return icicleSlam(ctx, x, z, R, hex, rain);
    // 同时最多 sk.max 场（dur-tune：冷却 = 持续之后，绵延 / 储能 / 节流叠在一起时才会两场重叠）：再多一场就停掉最老那场还没落的冰凌
    if (sk.max) {
      for (let k = rainsLive.length - 1; k >= 0; k--) if (rainsLive[k].dead || rainsLive[k].end <= state.time) rainsLive.splice(k, 1);
      while (rainsLive.length >= sk.max) {
        rainsLive.shift().dead = true;
        state.stats.rainCut = (state.stats.rainCut || 0) + 1;
      }
      rainsLive.push(rain);
    }
    const follow = sk.mech === 'follow'; // 刻式「随凌」：圈心每一根都按你此刻的位置
    if (follow) fxOpt('iceRainFollow', P.x, P.z, R, sk.tick * 1.3);
    else if (!fxOpt('iceRain', x, z, R, total, hex)) G.telegraph({ shape: 'circle', x, z, r: R, dur: total, dmg: 0, friendly: true });
    G.sfx('cast', { id: ctx.id });
    const icicle = (i) => {
      if (P.dead || rain.dead) return;
      let px, pz;
      if (follow) {
        x = P.x;
        z = P.z;
        rain.x = x;
        rain.z = z;
        if (i > 0) fxOpt('iceRainFollow', x, z, R, sk.tick * 1.3);
      }
      const pool = sk.scatter && sk.scatter.indexOf(i % 5) >= 0 ? null : enemiesIn(x, z, R).filter((e) => losClear(x, z, e.x, e.z));
      if (pool && pool.length) {
        let best = pool[0], bv = Infinity;
        for (const e of pool) {
          const v = (struck.get(e) || 0) + Math.random() * 0.6 + (follow ? dist(e.x, e.z, x, z) * 0.15 : 0); // 随凌：近的先砸
          if (v < bv) {
            bv = v;
            best = e;
          }
        }
        struck.set(best, (struck.get(best) || 0) + 1);
        px = best.x + G.rand(-0.3, 0.3);
        pz = best.z + G.rand(-0.3, 0.3);
      } else {
        const rr = R * 0.9 * Math.sqrt(Math.random()), aa = Math.random() * TAU;
        px = x + Math.sin(aa) * rr;
        pz = z + Math.cos(aa) * rr;
      }
      fxOpt('icicleFall', px, pz, hr, sk.fall, hex);
      G.after(sk.fall, () => {
        if (P.dead) return;
        if (!fxOpt('icicleLand', px, pz, hr, hex)) {
          G.world.frostSparkle(px, 0.4, pz, hr * 0.7);
          G.world.vDecal('frost', px, pz, hr, 1.6, 0x9fdcff, { a: 0.55 });
        }
        if (i % 2 === 0) G.sfx('impact', { type: 'cold', w: 0, crit: false });
        for (const e of enemiesIn(px, pz, hr)) {
          if (!losClear(px, pz, e.x, e.z)) continue;
          G.hitEnemy(e, ctx, 1, { ang: Math.atan2(e.x - px, e.z - pz), w: sk.w, kb: sk.kb, poise: sk.poise, quiet: true });
          rain.hits++;
          state.stats.rainHits = (state.stats.rainHits || 0) + 1;
        }
      });
    };
    for (let i = 0; i < n; i++) G.after(sk.delay + i * sk.tick, () => icicle(i));
    return rain;
  };
  // 刻式「重凌」：先画出落点范围，delay 秒后一根大冰凌落下（fall 秒），砸中 R 以内看得见落点的所有敌人（每个吃整根）
  function icicleSlam(ctx, x, z, R, hex, rain) {
    const SL = ctx.sk.slam;
    fxOpt('iceRain', x, z, R, SL.delay + SL.fall, hex);
    G.sfx('cast', { id: ctx.id });
    G.after(SL.delay, () => {
      if (P.dead) return;
      fxOpt('icicleSlamFall', x, z, R, SL.fall, hex);
      G.after(SL.fall, () => {
        if (P.dead) return;
        if (!fxOpt('icicleSlam', x, z, R, hex)) G.world.frostSparkle(x, 0.4, z, R * 0.6);
        G.sfx('impact', { type: 'cold', w: 1, crit: false });
        G.world.shake(0.12);
        state.stats.slams = (state.stats.slams || 0) + 1;
        for (const e of enemiesIn(x, z, R)) {
          if (!losClear(x, z, e.x, e.z)) continue;
          G.hitEnemy(e, ctx, 1, { ang: Math.atan2(e.x - x, e.z - z), w: 1, kb: 0.6, poise: ctx.sk.poise * 6, quiet: true });
          rain.hits++;
          state.stats.rainHits = (state.stats.rainHits || 0) + 1;
        }
      });
    });
    return rain;
  }
  // 刻式「钩钉」：每中一枚把敌人往你身边拽 d 米（精英 × elite，首领拽不动；墙挡着就拽到墙前，G.pullEnemy 处理），不拽到贴脸 1 米以内
  function nailHook(p, e) {
    const H = p.ctx.sk.hook;
    if (e.isBoss) return;
    const d = dist(e.x, e.z, P.x, P.z);
    const step = Math.min(H.d * (e.elite ? H.elite : 1), d - 1 - e.r);
    if (step <= 0.02) return;
    if (G.pullEnemy) G.pullEnemy(e, P.x, P.z, step);
    state.stats.hooks = (state.stats.hooks || 0) + 1;
    fxOpt('hookLine', e.x, e.z, P.x, P.z);
  }
  // 刻式「闪迸」：朝准星冲出至多 max 米（墙 / 关着的门 / 不能走的地方截断：rayLen 用 W.walkable 带玩家的半径），
  // 停在路上第一个敌人前 stop 米、也不越过准星；冲刺不给无敌（翻滚的无敌照旧只来自翻滚）
  function dischargeDash(ctx, a, hex) {
    const D = ctx.sk.dash;
    let want = Math.min(D.max, Math.max(0, a.dist - D.stop));
    for (const e of enemiesInLine(P.x, P.z, a.ang, want + D.stop, 0.5)) {
      const along = (e.x - P.x) * a.dx + (e.z - P.z) * a.dz - e.r - D.stop;
      if (along < want) want = Math.max(0, along);
    }
    const d = rayLen(P.x, P.z, a.ang, want, PLAYER_PAD);
    const x0 = P.x, z0 = P.z;
    if (d > 0.05) {
      P.x += a.dx * d;
      P.z += a.dz * d;
      fxOpt('dischargeDash', x0, z0, P.x, P.z, hex);
    }
    state.stats.dashes = (state.stats.dashes || 0) + 1;
    state.stats.dashLast = d;
  }
  // 刻式「聚雷」：只打 R 以内看得见的最近一个；连着打中同一个敌人到第 n 下时过载（k 倍）：
  // 普通敌人眩晕 stun 秒（同一个敌人 scd 秒最多一次），精英和首领不眩晕，改为 poise 倍削架势
  function dischargeFocus(ctx, R, hex) {
    const F = ctx.sk.focus;
    let best = null, bd = Infinity;
    for (const e of enemiesIn(P.x, P.z, R)) {
      const d = dist(e.x, e.z, P.x, P.z) - e.r;
      if (d < bd && losClear(P.x, P.z, e.x, e.z)) {
        bd = d;
        best = e;
      }
    }
    state.stats.bursts = (state.stats.bursts || 0) + 1;
    if (!best) {
      fxOpt('focusZap', [{ x: P.x, z: P.z }, { x: P.x + Math.sin(P.face) * R * 0.6, z: P.z + Math.cos(P.face) * R * 0.6 }], hex, false);
      return;
    }
    const fc = VS.focus;
    if (fc.e !== best || best.dead) {
      fc.e = best;
      fc.n = 0;
    }
    fc.n++;
    const over = fc.n >= F.n;
    if (over) fc.n = 0;
    const tough = best.isBoss || best.elite;
    G.hitEnemy(best, ctx, over ? F.k : 1, { ang: Math.atan2(best.x - P.x, best.z - P.z), quiet: true, poise: (ctx.sk.poise || 0) * (over && tough ? F.poise : 1) });
    if (over) {
      state.stats.overloads = (state.stats.overloads || 0) + 1;
      if (!tough && !best.dead && !(best.vFocusCd > state.time)) {
        best.stunT = Math.max(best.stunT || 0, F.stun);
        best.vFocusCd = state.time + F.scd;
        state.stats.focusStuns = (state.stats.focusStuns || 0) + 1;
      }
    }
    fxOpt('focusZap', [{ x: P.x, z: P.z }, { x: best.x, z: best.z }], hex, over);
    G.sfx('impact', { type: 'light', w: over ? 1 : 0, crit: lastHit.crit });
  }
  // 迸电：以自身为圆心的一圈电击（不穿墙）
  SKILL_FX.burst = function (ctx, a) {
    const W = G.world;
    const sk = ctx.sk;
    const R = sk.radius * Math.sqrt(ctx.area);
    const hex = hexOf(sk.color);
    if (sk.mech === 'dash' && a) dischargeDash(ctx, a, hex); // 刻式「闪迸」：先冲出去
    if (sk.mech === 'focus') return dischargeFocus(ctx, R, hex); // 刻式「聚雷」：只打最近的一个
    if (!fxOpt('dischargeFx', P.x, P.z, R, hex)) {
      // 没有形状批时：6 道细电弧从身上放射出去（池化的电弧，minor 不带闪光和贴花）
      const a0 = Math.random() * TAU;
      for (let i = 0; i < 6; i++) {
        const aa = a0 + (i / 6) * TAU, am = aa + G.rand(-0.35, 0.35);
        W.bolt([{ x: P.x, z: P.z }, { x: P.x + Math.sin(am) * R * 0.5, z: P.z + Math.cos(am) * R * 0.5 }, { x: P.x + Math.sin(aa) * R, z: P.z + Math.cos(aa) * R }], hex, true);
      }
    }
    state.stats.bursts = (state.stats.bursts || 0) + 1;
    let any = false;
    // 最多打最近的 maxHit 个（看得见的）
    const list = enemiesIn(P.x, P.z, R).filter((e) => losClear(P.x, P.z, e.x, e.z));
    if (sk.maxHit && list.length > sk.maxHit) {
      list.sort((p, q) => dist(p.x, p.z, P.x, P.z) - p.r - (dist(q.x, q.z, P.x, P.z) - q.r));
      list.length = sk.maxHit;
    }
    for (const e of list) {
      G.hitEnemy(e, ctx, 1, { ang: Math.atan2(e.x - P.x, e.z - P.z), quiet: true });
      any = true;
    }
    G.sfx('impact', { type: 'light', w: 0, crit: any && lastHit.crit });
  };
  // 引雷的一跳（持续施放 updateChannel 每 time 秒调一次）：接在准星附近的敌人身上，再连锁。
  // 加成（c.rampT 秒，按模拟时间累计）：一直引着就涨；走动、断开目标超过 keep 秒清零；停手 / 换技能时 P.cast 换掉，从零开始
  SKILL_FX.tether = function (ctx, a) {
    const W = G.world;
    const sk = ctx.sk;
    const RP = sk.ramp;
    const c = P.cast && P.cast.tether && P.cast.id === ctx.id ? P.cast : null;
    const hex = hexOf(sk.color);
    const now = state.time;
    // 主目标：还在射程里、离准星不远的上一个目标优先（加成不因为准星晃一下就断）；否则准星 5 米内最近的；再否则瞄准方向上最近的
    let first = null;
    const ok = (e) => e && !e.dead && dist(e.x, e.z, P.x, P.z) - e.r <= sk.range && losClear(P.x, P.z, e.x, e.z);
    if (c && ok(c.tgt) && dist(c.tgt.x, c.tgt.z, a.tx, a.tz) - c.tgt.r <= 5) first = c.tgt;
    // 刻式「锁雷」：目标倒下时，加成转到它身边 carry 米内最近的敌人
    if (!first && c && sk.lock && c.tgt && c.tgt.dead) {
      let bd = Infinity;
      for (const e of state.enemies) {
        if (e.dead) continue;
        const dc = dist(e.x, e.z, c.tgt.x, c.tgt.z);
        if (dc - e.r <= sk.lock.carry && dc < bd && ok(e)) {
          bd = dc;
          first = e;
        }
      }
      if (first) state.stats.lockCarry = (state.stats.lockCarry || 0) + 1;
    }
    if (!first) {
      let bd = Infinity;
      for (const e of state.enemies) {
        if (e.dead) continue;
        const dc = dist(e.x, e.z, a.tx, a.tz);
        if (dc - e.r <= 5 && dc < bd && ok(e)) {
          bd = dc;
          first = e;
        }
      }
    }
    if (!first) {
      let bd = Infinity;
      for (const e of state.enemies) {
        if (e.dead) continue;
        const dp = dist(e.x, e.z, P.x, P.z);
        if (dp - e.r > sk.range || dp >= bd) continue;
        const diff = Math.abs(angDiff(Math.atan2(e.x - P.x, e.z - P.z), a.ang));
        if (dp > e.r + 0.6 && diff > 0.6 + Math.asin(Math.min(1, e.r / dp))) continue;
        if (!losClear(P.x, P.z, e.x, e.z)) continue;
        bd = dp;
        first = e;
      }
    }
    let mult = 1;
    if (c) {
      const moved = c.lastZap >= 0 && dist(P.x, P.z, c.lx, c.lz) > RP.moveTol;
      if (moved || (c.lastHit >= 0 && now - c.lastHit > RP.keep)) c.rampT = 0;
      else if (first && c.lastZap >= 0 && c.tgtOn) c.rampT += now - c.lastZap;
      c.lx = P.x;
      c.lz = P.z;
      c.lastZap = now;
      c.tgtOn = !!first;
      if (first) {
        c.lastHit = now;
        c.tgt = first;
      }
      mult = 1 + Math.min(RP.max, RP.perSec * c.rampT) / 100;
      c.rampK = mult;
    }
    const pts = [{ x: P.x, z: P.z }];
    if (!first) {
      pts.push({ x: P.x + a.dx * 5, z: P.z + a.dz * 5 });
      if (!fxOpt('tetherFx', pts, hex, 1)) W.bolt(pts, hex, true);
      return;
    }
    const hit = new Set();
    let cur = first, jumps = ctx.chain, px = P.x, pz = P.z;
    while (cur) {
      hit.add(cur);
      pts.push({ x: cur.x, z: cur.z });
      const cx = cur.x, cz = cur.z;
      // 一秒 5 跳：每一跳都闪白的话，被引着的怪一直是白的（灰度里怪的亮面到 p85 80）。每 3 跳才闪一次
      G.hitEnemy(cur, ctx, mult, { ang: Math.atan2(cx - px, cz - pz), quiet: true, faint: cur !== first, noFlash: !!c && c.pulses % 3 !== 1 });
      px = cx;
      pz = cz;
      cur = null;
      if (jumps-- <= 0) break;
      let nd = sk.jump || 7; // 游雷：每跳最远 9 米
      for (const e of state.enemies) {
        if (e.dead || hit.has(e)) continue;
        const dd = dist(e.x, e.z, cx, cz);
        if (dd <= nd) {
          nd = dd;
          cur = e;
        }
      }
    }
    state.stats.tetherZaps = (state.stats.tetherZaps || 0) + 1;
    state.stats.tetherLast = hit.size; // 这一跳打到几个（主目标 + 连锁）
    if (!fxOpt('tetherFx', pts, hex, mult)) W.bolt(pts, hex, true);
  };

  SKILL_FX.aura = function (ctx) {
    if (ctx.sk.mech === 'shard') return novaShards(ctx); // 刻式「冰棱」：不脉冲，朝最近的敌人射冰棱
    const R = G.auraRadius(ctx);
    const hits = enemiesIn(P.x, P.z, R);
    if (ctx.sk.mech === 'burst') G.world.vSpikeRing(P.x, P.z, 0.8, R, 0x9fe4ff, 0.34, 14); // 刻式「冰爆」：一圈往外冒的冰刺
    else G.world.auraPulse(hits.length > 0);
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
      if (!shown && !ctx.sk.mech) shown = G.auraRadius(ctx); // 冰棱 / 冰爆：地上没有那圈霜环
      if (id === 'nova') novaCrystals(ctx.sk.mech === 'shard');
      if (P.dead) continue;
      if (ctx.sk.mech === 'guard') {
        guardAura(ctx, dt); // 刻式「护涡」：三团旋风常驻绕身，伤害由旋风自己按 tick 跳
        continue;
      }
      if (P.auraT[id] === undefined) P.auraT[id] = Math.min(0.2, ctx.time); // 刚放上技能栏：很快来第一下
      P.auraT[id] -= dt;
      if (P.auraT[id] <= 0) {
        P.auraT[id] += ctx.time;
        if (P.auraT[id] < 0) P.auraT[id] = ctx.time * 0.5;
        SKILL_FX.aura(ctx);
      }
    }
    if (!G.auraOn('nova') || P.dead) novaCrystals(false);
    W.setAura(P.dead ? 0 : shown);
    if (W.setAuraBoost) W.setAuraBoost(!P.dead && shown > 0 && G.auraEffK('nova') > 1); // 盛环：地上的霜环多一道淡环
    if (W.setFlame) W.setFlame(!P.dead && G.auraOn('blackflame'));
  }
  G.updateAuras = updateAuras;

  // 召唤：在准星处唤起召唤物（落点、数量上限与替换都由 minions.js 处理）
  SKILL_FX.summon = function (ctx, a) {
    if (G.summonMinion) G.summonMinion(ctx.id, a.tx, a.tz, ctx);
  };

  // 混沌流的两招（逻辑在上面「混沌流」一节：黑洞 / 黑旋风的每帧更新）
  // 新开一个施放的黑洞前：已经有 HOLE_CAST 个就收掉最老的（双极连同另一个洞一起收；不触发坍缩）
  function holeRoom() {
    for (;;) {
      const own = holes.filter((h) => !h.mouth && !h.twinB);
      if (own.length < HOLE_CAST) return;
      removeHole(holes.indexOf(own[0]));
    }
  }
  SKILL_FX.hole = function (ctx, a) {
    holeRoom();
    const sk = ctx.sk;
    const d = rayLen(P.x, P.z, a.ang, Math.min(sk.range, a.dist), 0.3); // 撞墙截在墙前
    const R = sk.radius * Math.sqrt(ctx.area);
    const dur = sk.dur * (1 + Math.max(0, P.S.holeDur || 0) / 100) * ctx.durK; // 绵延另外再乘
    if (sk.mech === 'follow') return holeMark(G.relicHole(ctx, R, dur), sk); // 渊式「随核」：黑洞开在你身上、跟着你走
    G.sfx('cast', { id: ctx.id });
    if (sk.mech === 'twin') return holeTwin(ctx, P.x + a.dx * d, P.z + a.dz * d, a, R, dur); // 刻式「双极」
    return holeMark(addHole({ x: P.x + a.dx * d, z: P.z + a.dz * d, R, pullR: R * sk.pullR, t: 0, dur, tick: sk.tick, tt: sk.tick, ctx, mult: 1, pullMul: 1, mouth: false }), sk);
  };

  SKILL_FX.vortex = function (ctx, a) {
    const sk = ctx.sk;
    if (sk.mech === 'guard') clearGuard(); // 刻式「护涡」：换一组新的
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
        x, z, a: ang, speed: sk.speed * G.projSpdK(ctx), life: sk.life * ctx.durK, t: 0, R, ctx, cast, seen: new Map(), lat: null, latT: 0, latN: 0, // 远劲：飞得更快更远；绵延：寿命更长
        bounce: sk.bounce, skip: ctx.pierce, chain: ctx.chain,
        // 摆动：两路正弦的频率 / 相位，每团不同
        wf: [G.rand(2.2, 3.4), i * 2.1 + G.rand(0, TAU), G.rand(4.5, 6.5), i * 1.3 + G.rand(0, TAU)],
        // 刻式：护涡绕着你转（第几团、共几团）；汇涡的层数
        guard: sk.mech === 'guard' ? { i, n } : null, lvl: sk.mech === 'merge' ? 1 : 0, R0: R,
      };
      while (vortices.length >= VORTEX_MAX) removeVortex(0);
      v.fx = G.world.makeVortex ? G.world.makeVortex(v.x, v.z, R, i, vortexLook(v)) : null;
      vortices.push(v);
    }
    G.sfx('cast', { id: ctx.id });
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
    whammer: ['attack3'], wkatana: ['blink'], wbanner: ['cast'], wlantern: ['cast'],
    ukatana: ['flicker'], ustaff: ['cast'], ubanner: ['cast'], ulantern: ['cast'],
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
      // 召唤英灵的技能（万魂降临，sk.champ）：sk.move 是英灵的移速，不是施放时你的走速——施放途中站定不动（原来按 8.2 倍走速冲出去一大截）
      move: sk.champ ? 0 : sk.move || 0, fb: false, data: {}, ctx: null, tick: null,
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
      G.sfx('cast', { id: ctx.id, type: t });
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
        G.sfx('cast', { id: ctx.id, type: t });
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
    G.sfx('cast', { id: ctx.id });
  };

  // =====================================================================
  // class-d2b1：炉匠的特殊弹（铁水弹 / 雷楔 / 霜霰弹 / 反冲弹）和掌灯人的提灯（点灯 / 借火 / 灯海 / 续火）
  // 地上的东西都有同时存在的上限：小灯 3 盏、铁水 4 摊、雷网 3 根线（绵延各 +durCap），续火的骸骨 4 具
  // =====================================================================
  // ---------- 特殊弹 ----------
  // 手里这把枪（机炮 / 喷枪 / 左轮）；不是枪返回 null
  function roundGun() {
    const t = wTypeOfItem(G.save && G.save.equip && G.save.equip.weapon);
    return t && G.ROUND_GUN[t] ? t : null;
  }
  G.roundGun = roundGun;
  // 特殊弹按哪一招普攻折算伤害（同熔光射线的 basicOf）：手里那把枪的右键；不是枪时 null（按 wm 乘手里武器的伤害）
  G.roundBasicId = function (sk) {
    if (!sk || !sk.round) return null;
    const t = roundGun();
    return t ? 'basic_' + t : null;
  };
  G.roundShape = () => G.ROUND_GUN[roundGun() || 'none'];
  const roundPools = []; // 铁水 { x, z, r, t, dur, tt, tick, mult, ctx }
  const netWedges = []; // 雷网：钉在地上的楔子 { x, z, t, ctx, born }
  let netLines = []; // 拉出来的电线 [{ a, b }]
  let netTT = 0;
  let push = null; // 反冲弹的后坐力 { dx, dz, left, sp, arena }
  const NET_MAX = 6; // 地上的楔子最多这么多枚（电线另有上限）
  // 这一枚弹的热度：这把枪开火 basicSec 秒的热度 × 这一枚的份数（打中过东西时才按全额，同普攻）
  function roundHeat(sk, gun, k) {
    if (!gun) return;
    const b = G.SKILLS['basic_' + gun];
    const hps = b.heatShot ? b.heatShot / b.time : b.heat;
    gainHeat(hps * (sk.basicSec || 0) * k);
  }
  function roundCast(ctx) {
    const sk = ctx.sk;
    const gun = roundGun();
    const sh = G.ROUND_GUN[gun || 'none'];
    const rctx = sk.elem && sk.elem !== 'phys' ? elemCtx(ctx, sk.elem) : ctx;
    const aim = P.cast && P.cast.id === ctx.id ? P.cast.aim : aimInfo().ang;
    const x0 = P.x, z0 = P.z;
    const fire = (i) => {
      if (P.dead) return;
      roundShell(rctx, sk, gun, sh, i, aim);
    };
    fire(0);
    for (let i = 1; i < sh.n; i++) {
      if (sh.gap) G.after(sh.gap * i, () => fire(i));
      else fire(i);
    }
    if (sk.round === 'recoil') {
      if (sk.mech === 'shock') recoilShock(rctx, x0, z0);
      if (sk.push) recoilPush(sk, aim);
    }
    G.sfx('round', { type: sk.round, gun: gun || 'revolver' });
  }
  function roundShell(ctx, sk, gun, sh, i, aim) {
    const n = Math.max(1, ctx.proj);
    let a0 = aim;
    if (sh.fan && sh.n > 1) a0 += (-sh.fan / 2 + (sh.fan * i) / (sh.n - 1)) * DEG;
    else if (sh.spread) a0 += (i - (sh.n - 1) / 2) * sh.spread * DEG;
    const fan = n > 1 ? Math.min(30, 8 * (n - 1)) * DEG : 0;
    const cast = new Set();
    const k = sh.k * (sk.heavy || 1);
    const line = sk.mech === 'bore' && sk.line;
    const range = (line ? line.len : sk.range) * (sh.rangeK || 1);
    const pk = sh.k / 1.1; // 击退、架势按这一枚的份数摊（机炮三枚加起来和左轮一发差不多）
    const W0 = sk.wedge;
    for (let j = 0; j < n; j++) {
      const ang = a0 + (n > 1 ? -fan / 2 + (fan * j) / (n - 1) : 0);
      const p = shootProj(ctx, ang, { cast, vk: 'rd_' + sk.round, mult: W0 ? k * W0.hit : k, range, speed: line ? 70 : sk.speed, r: sk.projR, after: roundAfter });
      p.rk = k;
      p.round = sk.round;
      p.kb = (sk.kb || 0) * pk;
      p.poise = (sk.poise || 0) * pk;
      p.ranged = false; // 不当普攻的弹算（专注、普攻的命中特效）
      if (sk.round === 'molten') {
        if (sk.explode > 0) {
          p.explode = sk.explode;
          p.blastMult = k;
        }
        if (sk.pool) p.onEnd = moltenEnd;
        if (sk.mech === 'bore') {
          const B = sk.bore;
          p.pierce = 999;
          p.multFn = (q) => q.rk * (1 + Math.min(B.max, B.step * Math.max(0, q.hit.size - 1)));
        }
      } else if (line) p.pierce = 999;
      else if (sk.round === 'wedge' && sk.mech === 'net') {
        const ai = aimInfo();
        p.life = Math.max(0.05, (G.clamp(ai.dist, 2, range) - 0.8) / p.speed); // 打空的楔子钉在准星处
        p.onEnd = netEnd;
      } else if (sk.round === 'rime' && sk.mech === 'deep') {
        const D = sk.deep;
        p.multFn = (q, e) => {
          q.frz = e.freeze > 0 || e.bossChill > 0;
          return q.rk * (q.frz ? D.frozen : 1);
        };
      }
    }
    roundHeat(sk, gun, sh.k);
  }
  // 弹打中一个敌人之后（直击已经结算过）
  function roundAfter(p, e) {
    P.gun.hitT = 0; // 打中过东西：热度按全额涨
    p.didHit = true;
    const sk = p.ctx.sk;
    if (sk.round === 'molten') {
      if (sk.mech === 'splash') moltenSplash(p, e);
      else if (sk.pool) moltenPool(p.ctx, e.x, e.z);
    } else if (sk.round === 'wedge') wedgeStick(p, e);
    else if (sk.round === 'rime') {
      if (sk.mech === 'deep') {
        if (p.frz) {
          const D = sk.deep;
          for (const o of enemiesIn(e.x, e.z, D.r * Math.sqrt(p.ctx.area))) if (o !== e) G.hitEnemy(o, p.ctx, p.rk * D.k, { ang: Math.atan2(o.x - e.x, o.z - e.z), w: 0, kb: 0.3, poise: 4, quiet: true });
          fxOpt('rimeBurst', e.x, e.z, D.r, true);
        }
      } else rimeShards(p, e);
    }
  }
  // 铁水弹没打中敌人（撞墙 / 飞到尽头炸开）：照样留一摊铁水
  function moltenEnd(p) {
    if (p.didHit) return;
    let x = p.x, z = p.z;
    if (!G.world.walkable(x, z, 0.2)) {
      x -= p.dx * 0.6;
      z -= p.dz * 0.6;
    }
    moltenPool(p.ctx, x, z);
  }
  function moltenPool(ctx, x, z) {
    const sk = ctx.sk, D = sk.pool;
    if (!D) return null;
    const cap = D.max + (ctx.durCap || 0);
    while (roundPools.length >= cap) poolOff(roundPools.shift());
    const f = { x, z, r: D.r * Math.sqrt(ctx.area), t: D.dur * ctx.durK, dur: D.dur * ctx.durK, tt: 0.15, tick: D.tick, mult: D.mult, ctx };
    roundPools.push(f);
    fxOpt('moltenPool', f, true);
    return f;
  }
  function poolOff(f) {
    if (f) fxOpt('moltenPool', f, false);
  }
  // 溅铁：从命中处朝前方溅出 n 道铁水，每道打一条线；每个敌人这一枚只挨一道
  function moltenSplash(p, e) {
    const S0 = p.ctx.sk.splash;
    const ang = Math.atan2(p.dx, p.dz);
    const done = new Set([e]);
    const len = S0.len * Math.sqrt(p.ctx.area);
    for (let i = 0; i < S0.n; i++) {
      const a = ang + (S0.n > 1 ? -S0.arc / 2 + (S0.arc * i) / (S0.n - 1) : 0) * DEG;
      const L = rayLen(e.x, e.z, a, len, -0.3);
      for (const o of enemiesInLine(e.x, e.z, a, L, S0.w / 2)) {
        if (done.has(o)) continue;
        done.add(o);
        G.hitEnemy(o, p.ctx, p.rk * S0.k, { ang: a, w: 0, kb: 0.4, poise: 4, quiet: true });
      }
    }
    fxOpt('moltenSplash', e.x, e.z, ang, S0.arc, len, S0.n);
  }
  // 雷楔：钉进敌人，delay 秒后放电（身上的楔子越多越痛），再连到附近的敌人
  function wedgeStick(p, e) {
    const W0 = p.ctx.sk.wedge, ctx = p.ctx, k = p.rk;
    e.wedges = (e.wedges || 0) + 1;
    fxOpt('wedgeStick', e, W0.delay);
    G.after(W0.delay, () => {
      e.wedges = Math.max(0, (e.wedges || 1) - 1);
      if (e.dead) return;
      const st = Math.min(W0.maxStack, e.wedges + 1);
      const m = k * W0.zap * (1 + W0.stack * (st - 1));
      G.hitEnemy(e, ctx, m, { ang: Math.atan2(e.x - P.x, e.z - P.z), w: 1, kb: 0, poise: 4 });
      const tg = W0.n > 0 ? nearestOthers(e, W0.r * Math.sqrt(ctx.area), W0.n) : [];
      for (const o of tg) G.hitEnemy(o, ctx, m * W0.chainK, { ang: Math.atan2(o.x - e.x, o.z - e.z), w: 0, kb: 0, poise: 2, quiet: true });
      fxOpt('wedgeZap', e, tg, st);
      G.sfx('round', { type: 'zap' });
    });
  }
  // 雷网：打空的楔子钉在地上，link 米内的两两拉线
  function netEnd(p) {
    if (p.didHit) return;
    let x = p.x, z = p.z;
    if (!G.world.walkable(x, z, 0.2)) {
      x -= p.dx * 0.6;
      z -= p.dz * 0.6;
    }
    const N = p.ctx.sk.net;
    while (netWedges.length >= NET_MAX) fxOpt('netWedge', netWedges.shift(), false);
    const w = { x, z, t: N.dur * p.ctx.durK, ctx: p.ctx, born: state.time + netWedges.length * 1e-6 };
    netWedges.push(w);
    fxOpt('netWedge', w, true);
    netRelink();
  }
  function netRelink() {
    const pairs = [];
    for (let i = 0; i < netWedges.length; i++)
      for (let j = i + 1; j < netWedges.length; j++) {
        const a = netWedges[i], b = netWedges[j];
        const N = (b.born > a.born ? b : a).ctx.sk.net;
        if (!N || dist(a.x, a.z, b.x, b.z) > N.link * Math.sqrt(b.ctx.area) || !losClear(a.x, a.z, b.x, b.z)) continue;
        pairs.push({ a, b, age: Math.min(a.born, b.born), newest: Math.max(a.born, b.born) });
      }
    // 新的顶掉旧的：按两端里较新的那一枚排，再按较旧的那一枚
    pairs.sort((u, v) => v.newest - u.newest || v.age - u.age);
    const last = netWedges.length ? netWedges[netWedges.length - 1].ctx : null;
    const cap = last && last.sk.net ? last.sk.net.lines + (last.durCap || 0) : 3;
    netLines = pairs.slice(0, cap);
  }
  function segDist(px, pz, ax, az, bx, bz) {
    const vx = bx - ax, vz = bz - az;
    const L2 = vx * vx + vz * vz || 1;
    const t = G.clamp(((px - ax) * vx + (pz - az) * vz) / L2, 0, 1);
    return Math.hypot(px - ax - vx * t, pz - az - vz * t);
  }
  function tickNet(dt) {
    let gone = false;
    for (let i = netWedges.length - 1; i >= 0; i--) {
      const w = netWedges[i];
      w.t -= dt;
      if (w.t <= 0) {
        netWedges.splice(i, 1);
        fxOpt('netWedge', w, false);
        gone = true;
      }
    }
    if (gone) netRelink();
    if (!netLines.length) return;
    netTT -= dt;
    if (netTT > 0) return;
    const ctx = netWedges[netWedges.length - 1].ctx, N = ctx.sk.net;
    netTT += N.tick;
    for (const e of state.enemies) {
      if (e.dead || state.time - (e.netAt || -99) < N.tick * 0.95) continue;
      for (const L of netLines) {
        if (segDist(e.x, e.z, L.a.x, L.a.z, L.b.x, L.b.z) > N.w / 2 + e.r) continue;
        e.netAt = state.time;
        G.hitEnemy(e, ctx, N.k, { ang: 0, w: 0, kb: 0, poise: 1, quiet: true, faint: true, extra: true });
        break;
      }
    }
  }
  G.netState = () => ({ wedges: netWedges, lines: netLines });
  G.roundPools = () => roundPools;
  // 霜霰弹：冰屑（原式：敌人背后的扇面；散霜：四周一圈）。不打被命中的那个
  function rimeShards(p, e) {
    const S0 = p.ctx.sk.shard;
    if (!S0) return;
    const ak = Math.sqrt(p.ctx.area);
    const dir = Math.atan2(p.dx, p.dz);
    if (S0.r) {
      const R = S0.r * ak;
      for (const o of enemiesIn(e.x, e.z, R)) if (o !== e) G.hitEnemy(o, p.ctx, p.rk * S0.k, { ang: Math.atan2(o.x - e.x, o.z - e.z), w: 0, kb: 0.3, poise: 3, quiet: true });
      fxOpt('rimeBurst', e.x, e.z, R, false);
      return;
    }
    const L = S0.len * ak, half = (S0.arc / 2) * DEG;
    for (const o of enemiesIn(e.x, e.z, L)) {
      if (o === e) continue;
      const d = dist(o.x, o.z, e.x, e.z);
      if (d > o.r + 0.3 && Math.abs(angDiff(Math.atan2(o.x - e.x, o.z - e.z), dir)) > half + Math.asin(Math.min(1, o.r / Math.max(0.01, d)))) continue;
      if (!losClear(e.x, e.z, o.x, o.z)) continue;
      G.hitEnemy(o, p.ctx, p.rk * S0.k, { ang: Math.atan2(o.x - e.x, o.z - e.z), w: 0, kb: 0.3, poise: 3, quiet: true });
    }
    fxOpt('rimeFan', e.x, e.z, dir, S0.arc, L);
  }
  // 反冲弹：后坐力把你往后推（撞墙即停；起跳时在首领场地里就不出场地）
  function recoilPush(sk, aim) {
    const W = G.world;
    const D = sk.push;
    push = { dx: -Math.sin(aim), dz: -Math.cos(aim), left: D.d, sp: D.d / D.dur, arena: !!(W.zone && W.zone.arena && W.inArena(P.x, P.z)), x0: P.x, z0: P.z };
    fxOpt('recoilSlide', P.x, P.z, aim, D.dur);
  }
  function tickPush(dt) {
    if (!push) return;
    if (P.dead || P.roll.t > 0) {
      push = null;
      return;
    }
    const W = G.world;
    let step = Math.min(push.left, push.sp * dt);
    push.left -= step;
    while (step > 1e-5) {
      const s = Math.min(0.12, step);
      step -= s;
      const nx = P.x + push.dx * s, nz = P.z + push.dz * s;
      if (!W.walkable(nx, nz, PLAYER_PAD) || (push.arena && !W.inArena(nx, nz))) {
        push.left = 0;
        break;
      }
      P.x = nx;
      P.z = nz;
    }
    if (push.left <= 1e-5) {
      state.stats.recoilDist = dist(P.x, P.z, push.x0, push.z0); // 测试用：这一次推了多远
      push = null;
    }
  }
  G.pushState = () => push;
  // 震膛：起跳的地方震出一圈冲击，把贴身的怪推开
  function recoilShock(ctx, x, z) {
    const S0 = ctx.sk.shock, R = S0.r * Math.sqrt(ctx.area);
    for (const e of enemiesIn(x, z, R)) G.hitEnemy(e, ctx, S0.k, { ang: Math.atan2(e.x - x, e.z - z), w: 1, kb: S0.kb, poise: 20 });
    fxOpt('recoilShock', x, z, R);
  }
  SKILL_FX.round = function (ctx) {
    roundCast(ctx);
  };

  // ---------- 提灯：点灯 / 借火 / 灯海 / 续火 ----------
  const lamps = []; // { x, z, t, dur, tt, r0, ak, tick, mult, haste, ctx, born }
  let sea = null; // 灯海 { x, z, r, t, dur, tt, ctx }
  G.lampState = () => ({ lamps, sea, lend: P.lend && P.lend.t > 0 ? P.lend : null });
  const lendOn = () => !!(P.lend && P.lend.t > 0);
  function lampR(l) {
    return (lendOn() ? G.SKILLS.lendfire.buff.lampR : l.r0) * l.ak;
  }
  G.lampR = lampR;
  SKILL_FX.blamp = function (ctx) {
    const sk = ctx.sk;
    const ai = aimInfo();
    const aim = P.cast && P.cast.id === ctx.id ? P.cast.aim : ai.ang;
    const d = G.clamp(ai.dist, 2, sk.range);
    const n = Math.max(1, ctx.proj);
    const fan = n > 1 ? Math.min(40, 14 * (n - 1)) * DEG : 0;
    const cast = new Set();
    for (let j = 0; j < n; j++) {
      const ang = aim + (n > 1 ? -fan / 2 + (fan * j) / (n - 1) : 0);
      const dx = Math.sin(ang), dz = Math.cos(ang);
      const p = G.spawnProjectile({
        owner: 'p', x: P.x + dx * 0.6, z: P.z + dz * 0.6, dx, dz, speed: sk.speed, r: sk.projR, life: Math.max(0.05, (d - 0.6) / sk.speed),
        color: hexOf(sk.color), ctx, pierce: 0, chain: 0, explode: sk.explode, hit: new Set(), cast, vk: 'lampglob',
      });
      p.after = (q, e) => {
        q.lampAt = { x: e.x, z: e.z };
      };
      p.onEnd = lampEnd;
    }
    G.sfx('lamp', { phase: 'throw' });
  };
  function lampEnd(p) {
    let x = p.lampAt ? p.lampAt.x : p.x, z = p.lampAt ? p.lampAt.z : p.z;
    if (!G.world.walkable(x, z, 0.2)) {
      x = p.x - p.dx * 0.7;
      z = p.z - p.dz * 0.7;
      if (!G.world.walkable(x, z, 0.2)) return;
    }
    placeLamp(p.ctx, x, z);
  }
  function placeLamp(ctx, x, z) {
    const L = ctx.sk.lamp;
    if (!L) return null;
    const cap = L.max + (ctx.durCap || 0);
    while (lamps.length >= cap) lampOff(lamps.shift(), false);
    const l = { x, z, t: L.dur * ctx.durK, dur: L.dur * ctx.durK, tt: 0.2, r0: L.r, ak: Math.sqrt(ctx.area), tick: L.tick, mult: L.mult, haste: L.haste, ctx, born: state.time };
    lamps.push(l);
    fxOpt('lampPlace', l, true);
    G.sfx('lamp', { phase: 'land' });
    state.stats.lampsPlaced = (state.stats.lampsPlaced || 0) + 1;
    return l;
  }
  G.placeLamp = (x, z) => placeLamp(G.skillCtx('basic_lantern'), x, z); // 测试用
  function lampOff(l, boom) {
    if (l) fxOpt('lampPlace', l, false, !!boom);
  }
  // 借火结束：每盏小灯炸开
  function lendEnd(boom) {
    const L = P.lend;
    P.lend = null;
    fxOpt('lendFx', false);
    if (!boom || !L) return;
    const B = G.SKILLS.lendfire.boom;
    while (lamps.length) {
      const l = lamps.shift();
      const R = B.r * l.ak;
      for (const e of enemiesIn(l.x, l.z, R)) G.hitEnemy(e, L.ctx, B.mult, { ang: Math.atan2(e.x - l.x, e.z - l.z), w: 1, kb: 0.8, poise: 10, quiet: true });
      lampOff(l, true);
      fxOpt('lampBoom', l.x, l.z, R);
    }
    G.sfx('lamp', { phase: 'boom' });
  }
  WS_FX.wlantern = function (ctx) {
    const B = ctx.sk.buff;
    P.lend = { t: B.dur, dur: B.dur, ctx, fire: B.minionFire, burn: B.burn };
    fxOpt('lendFx', true);
    G.world.text(P.x, P.z, '借火', ctx.sk.color, 16);
    G.sfx('lamp', { phase: 'lend' });
  };
  WS_FX.ulantern = function (ctx) {
    const sk = ctx.sk;
    if (sea) fxOpt('lampSea', sea, false);
    sea = { x: P.x, z: P.z, r: sk.r * Math.sqrt(ctx.area), n: sk.n, t: sk.dur, dur: sk.dur, tt: 0.2, tick: sk.tick, mult: sk.mult, haste: sk.haste, ctx };
    fxOpt('lampSea', sea, true);
    G.sfx('lamp', { phase: 'sea' });
  };
  // 召唤物在灯光里的攻速倍率（minions.js 的攻击倒计时用）
  G.lampAny = () => lamps.length > 0 || !!sea;
  G.lampHaste = function (m) {
    if (sea && dist(m.x, m.z, sea.x, sea.z) <= sea.r) return 1 + sea.haste;
    for (const l of lamps) if (dist(m.x, m.z, l.x, l.z) <= lampR(l)) return 1 + l.haste;
    return 1;
  };
  // 借火：召唤物每一击附带的火焰伤害（%），没有借火时 0
  G.lendFire = () => (lendOn() ? P.lend.fire : 0);
  function tickLamps(dt) {
    // 借火：到点炸灯；换下了提灯就悄悄结束
    if (P.lend) {
      if (wTypeOfItem(G.save.equip.weapon) !== 'lantern') lendEnd(false);
      else {
        P.lend.t -= dt;
        if (P.lend.t <= 0) lendEnd(true);
      }
    }
    const lb = lendOn() ? P.lend.burn : 1;
    for (let i = lamps.length - 1; i >= 0; i--) {
      const l = lamps[i];
      l.t -= dt;
      if (l.t <= 0) {
        lamps.splice(i, 1);
        lampOff(l, false);
        continue;
      }
      l.tt -= dt;
      if (l.tt > 0) continue;
      l.tt += l.tick;
      const R = lampR(l);
      for (const e of enemiesIn(l.x, l.z, R)) {
        if (state.time - (e.lampAt || -99) < l.tick * 0.95) continue;
        e.lampAt = state.time;
        G.hitEnemy(e, l.ctx, l.mult * lb, { ang: Math.atan2(e.x - l.x, e.z - l.z), w: 0, kb: 0, poise: 1, quiet: true, faint: true, extra: true });
      }
    }
    if (sea) {
      sea.t -= dt;
      if (sea.t <= 0 || wTypeOfItem(G.save.equip.weapon) !== 'lantern') {
        fxOpt('lampSea', sea, false);
        sea = null;
      } else {
        sea.tt -= dt;
        if (sea.tt <= 0) {
          sea.tt += sea.tick;
          for (const e of enemiesIn(sea.x, sea.z, sea.r)) {
            if (state.time - (e.seaAt || -99) < sea.tick * 0.95) continue;
            e.seaAt = state.time;
            G.hitEnemy(e, sea.ctx, sea.mult, { ang: Math.atan2(e.x - sea.x, e.z - sea.z), w: 0, kb: 0, poise: 1, quiet: true, faint: true, extra: true });
          }
        }
      }
    }
    if (lamps.length || sea || P.lend) fxOpt('lampTick', lamps, sea, lendOn(), dt);
  }
  // 续火（长明）：死在灯光里的普通怪站起来替你打一会儿
  function relightCheck(e) {
    if (e.elite || e.isBoss || e.pin || e.noXp) return;
    const L = G.RELIGHT;
    let lit = sea && dist(e.x, e.z, sea.x, sea.z) <= sea.r ? 2 : 0;
    if (!lit && dist(e.x, e.z, P.x, P.z) <= L.near) lit = 1;
    if (!lit) for (const l of lamps) if (dist(e.x, e.z, l.x, l.z) <= lampR(l)) {
      lit = 1;
      break;
    }
    if (!lit) return;
    if (lit === 1 && Math.random() >= L.chance) return;
    if (!G.summonRelit || G.relitCount() >= L.cap) return;
    if (G.summonRelit(e.x, e.z, L.dur)) state.stats.relit = (state.stats.relit || 0) + 1;
  }
  G.relightCheck = relightCheck;
  // 每帧（tickRanged 里）和换区域时
  function tickD2b(dt) {
    if (push) tickPush(dt);
    if (roundPools.length) {
      for (let i = roundPools.length - 1; i >= 0; i--) {
        const f = roundPools[i];
        f.t -= dt;
        if (f.t <= 0) {
          roundPools.splice(i, 1);
          poolOff(f);
          continue;
        }
        f.tt -= dt;
        if (f.tt > 0) continue;
        f.tt += f.tick;
        for (const e of enemiesIn(f.x, f.z, f.r)) {
          if (state.time - (e.moltenAt || -99) < f.tick * 0.95) continue;
          e.moltenAt = state.time;
          G.hitEnemy(e, f.ctx, f.mult, { ang: Math.atan2(e.x - f.x, e.z - f.z), w: 0, kb: 0, poise: 1, quiet: true, faint: true, extra: true });
        }
      }
      fxOpt('moltenTick', roundPools, dt);
    }
    if (netWedges.length) {
      tickNet(dt);
      fxOpt('netTick', netWedges, netLines, dt);
    }
    if (lamps.length || sea || P.lend) tickLamps(dt);
  }
  function resetD2b() {
    for (const f of roundPools) poolOff(f);
    roundPools.length = 0;
    for (const w of netWedges) fxOpt('netWedge', w, false);
    netWedges.length = 0;
    netLines = [];
    netTT = 0;
    push = null;
    for (const l of lamps) lampOff(l, false);
    lamps.length = 0;
    if (sea) fxOpt('lampSea', sea, false);
    sea = null;
    if (P.lend) lendEnd(false);
  }
  G.d2bState = () => ({ pools: roundPools.length, wedges: netWedges.length, lines: netLines.length, lamps: lamps.length, sea: !!sea, lend: lendOn(), push: !!push });

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
    G.sfx('cast', { id: ctx.id });
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
        G.shuffle(pool).sort((p, q) => (storm.struck.get(p) || 0) - (storm.struck.get(q) || 0)); // 先洗牌再稳定排序：砸得一样少的随机挑
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
    G.sfx('cast', { id: ctx.id });
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
    G.sfx('cast', { id: ctx.id });
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
    G.sfx('cast', { id: ctx.id });
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
    if (G.runMods.sluggish) r.cdMax *= 1 + G.runMods.sluggish.roll; // 渊印「迟滞」
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
    combat.dealt = state.time;
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
      toast(isLife ? '生命药剂已空，击杀敌人补充' : '魔力药剂已空，击杀敌人补充', '#c8b89a', 'flask-' + kind, 2000);
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
    tickCharges(dt); // 储能：补存货
    tickRanged(dt);
    updateChaos(dt);
    if (VS.n) updateVariants(dt); // 刻式第二版：留在场上的东西
    if (bleeders.length) tickBleed(dt); // 流血
    if (P.relic.any || G.relicState.bridges.length || G.relicState.spin || state.minions.length) G.relicTick(dt); // 渊契 / 渊式：蓄潮、星雨、电桥、骸王外形……
    updateAuras(dt);
    updateAutoSummon(dt);
    if (P.roll.cd > 0) P.roll.cd = Math.max(0, P.roll.cd - dt);
    if (P.iframe > 0) P.iframe = Math.max(0, P.iframe - dt);
    if (P.graceT > 0) P.graceT = Math.max(0, P.graceT - dt);
    terrainTick(dt);
    sealTick(dt);
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
            let k = !c ? 1 : c.channel || c.ws ? c.move : c.st ? (c.fired ? 0.55 : 0.25) : c.mv !== undefined ? c.mv : 0.4; // mv：特殊弹拿左轮时边走边打（class-d2b1）
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
  // 辅助宝石的掉落：首领固定掉 boss 颗（第一颗必是还没有的），精英 elite、普通怪 mob 的几率各掉一颗。
  // 辅助从 22 种（含绵延、破障）加到 33 种（support-expand 两批）：几率 ×1.5（原来 2 / 0.3 / 0.025），每一种辅助的掉率和原来差不多，老宝石不会变稀
  const SUPPORT_DROP = (G.SUPPORT_DROP = { boss: 3, elite: 0.45, mob: 0.0375 });
  // 随机技能宝石（首领另有一颗必掉）：技能宝石从 14 种加到 20 种（skill-expand），精英 / 普通怪的几率 × 20/14（原来 0.075 / 0.012），每一种老宝石的掉率不变
  // 有职业的存档再乘 G.gemDropK（宝石总数 / 20：特殊弹加到 24 种，class-d2b1）；没有职业时池子还是那 20 种，几率不变
  const SKILL_DROP = (G.SKILL_DROP = { elite: (0.075 * 20) / 14, mob: (0.012 * 20) / 14 });
  // preferNew：挑玩家还没有的宝石的概率
  // 有职业时（class-d2）：最后那一下 G.pick 换成一次 G.weighted，本职业能用的宝石合起来占 G.CLASS_LOOT.gem（75%），
  // 随机数次数和没有职业时一样；用不上的那 25% 由 G.spawnLoot 变成同等级的无铭宝石。usable：只挑能用的（拾烬客的货架）
  function pickSkillGem(preferNew, usable) {
    const C = G.clsDef();
    // 武器技不掉落；没有职业时不掉 clsOnly 的宝石（特殊弹，class-d2b1），池子和随机数次数都和以前一样
    const all = C && usable ? G.classGems(G.save.cls) : G.gemDropPool(G.save.cls);
    const fresh = all.filter((id) => !G.save.skills[id]);
    const pool = fresh.length && Math.random() < preferNew ? fresh : all;
    const id = C ? classGemPick(pool) : G.pick(pool);
    return { id, lvl: gemLevel() };
  }
  function classGemPick(pool) {
    const cls = G.save.cls;
    let own = 0;
    for (const id of pool) if (G.classCanUse(cls, id)) own++;
    const other = pool.length - own;
    if (!own || !other) return G.weighted(pool, () => 1);
    const k = G.CLASS_LOOT.gem;
    return G.weighted(pool, (id) => (G.classCanUse(cls, id) ? k / own : (1 - k) / other));
  }
  G.pickSkillGem = pickSkillGem; // 测试用：加权抽样
  function pickSupportGem(preferNew) {
    const all = Object.keys(G.SUPPORTS);
    const fresh = all.filter((id) => G.save.supports.indexOf(id) < 0);
    return fresh.length && Math.random() < preferNew ? G.pick(fresh) : G.pick(all);
  }

  G.dropLoot = function (e) {
    const save = G.save;
    const ilvl = Math.max(1, e.level);
    // 渊印：稀有度 × (1 + R)；物品 / 通货的件数或几率 × (1 + Q)（sealCount）。技能宝石、辅助、无铭宝石都不吃 Q
    const RM = G.runMods;
    const rm = (1 + (P.S.rarity || 0) / 100) * (1 + RM.rar);
    const qk = 1 + RM.qty;
    const x = e.x;
    const z = e.z;

    if (e.isBoss) {
      G.spawnLoot('item', G.rollItem(ilvl, 2), x, z);
      for (let i = 0, n = sealCount(3) - 1; i < n; i++) G.spawnLoot('item', G.rollItem(ilvl, Math.max(1, G.rollRarity(rm))), x, z);
      for (let i = 0, n = sealCount(4); i < n; i++) G.spawnLoot('cur', G.rollCurrency(), x, z);
      // 首领第一次倒下：另外保底升华石、乱流石各一颗
      if (e.bossKind && !save.bossKills[e.bossKind]) for (const id of G.BOSS_FIRST_CUR) G.spawnLoot('cur', id, x, z);
      G.spawnLoot('skill', pickSkillGem(1), x, z);
      for (let i = 0; i < SUPPORT_DROP.boss; i++) G.spawnLoot('support', pickSupportGem(i ? 0.7 : 1), x, z);
      // 无铭技能宝石：每个首领第一次倒下必掉一颗（第一个区域的首领就是新角色的保底），之后再打有小几率
      if ((e.bossKind && !save.bossKills[e.bossKind]) || Math.random() < BLANK_DROP.boss) G.spawnLoot('blank', { lvl: gemLevel() }, x, z);
      uniqueDrop(e, ilvl);
      G.relicBossDrop(e, ilvl); // 渊契：和烬铸分开掷
      // 击杀区域首领：印烛芯（任何印下都掷，几率按这次进区的印，见 G.fragChance）
      if (G.fragSealDrop) G.fragSealDrop(e);
      return;
    }
    if (e.elite) {
      for (let i = 0, n = sealCount(2); i < n; i++) G.spawnLoot('item', G.rollItem(ilvl, G.rollRarity(rm * 2)), x, z);
      for (let i = 0, n = sealCount(1); i < n; i++) G.spawnLoot('cur', G.rollCurrency(), x, z);
      // 还没有任何辅助宝石时，第一只精英必掉一颗
      const needFirst = save.supports.length === 0 && !state.loot.some((l) => l.kind === 'support');
      if (needFirst || Math.random() < SUPPORT_DROP.elite) G.spawnLoot('support', pickSupportGem(needFirst ? 1 : 0.7), x, z);
      if (Math.random() < SKILL_DROP.elite * G.gemDropK(save.cls)) G.spawnLoot('skill', pickSkillGem(0.7), x, z);
      if (Math.random() < BLANK_DROP.elite) G.spawnLoot('blank', { lvl: gemLevel() }, x, z);
      return;
    }
    // 区域刷的普通怪（horde）掉落几率按 G.BALANCE.loot 打折：怪多了一倍，一整区合计约 ×1.15
    const L = e.horde ? G.BALANCE.loot : null;
    const zk = L ? e.hordeK || 1 : 1, kItem = L ? L.item * zk : 1, kCur = L ? L.cur * zk : 1, kGem = L ? L.gem * zk : 1;
    if (Math.random() < 0.14 * kItem * qk) G.spawnLoot('item', G.rollItem(ilvl, G.rollRarity(rm)), x, z);
    if (Math.random() < 0.09 * kCur * qk) G.spawnLoot('cur', G.rollCurrency(), x, z);
    if (Math.random() < SKILL_DROP.mob * kGem * G.gemDropK(save.cls)) G.spawnLoot('skill', pickSkillGem(0.7), x, z);
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
  // 长明（class-d2b1）：熄烛者每次击杀 G.RELIGHT.drop 几率，连续 pity 次没掉下一次必掉（save.lampPity，0 时不写，和巅峰渊契的保底分开）。
  // 没有职业的存档不掷（Math.random 的次数和以前一样）
  function lampDrop(ilvl, x, z) {
    if (!G.clsDef()) return null;
    const S = G.save, L = G.RELIGHT;
    const n = S.lampPity || 0;
    if (n >= L.pity || Math.random() < L.drop) {
      delete S.lampPity;
      const item = G.rollUnique('changming', ilvl);
      const loot = G.spawnLoot('item', item, x, z);
      G.sfx('unique');
      if (G.ui.bigToast) G.ui.bigToast('烬铸武器', item.name, G.RARITY_COLOR[3], G.UNIQUES.changming.mechName);
      state.stats.uniqueDrops = (state.stats.uniqueDrops || 0) + 1;
      return loot;
    }
    S.lampPity = n + 1;
    return null;
  }
  G.lampDrop = lampDrop; // 测试用

  G.spawnLoot = function (kind, data, x, z) {
    const W = G.world;
    // 有职业时（class-d2）：这个职业用不上的技能宝石掉下来就是同等级的无铭技能宝石（不浪费）。没有职业时不动
    if (kind === 'skill' && G.clsDef() && !G.classCanUse(G.save.cls, data.id)) {
      kind = 'blank';
      data = { lvl: data.lvl, from: data.id };
    }
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
    } else if (kind === 'frag') {
      label = G.FRAGS[data].name;
      color = G.FRAGS[data].color;
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
    return G.blankTargets().some((id) => !sk[id] || sk[id] < lvl);
  };
  // 无铭宝石能学 / 能升的技能：有职业时只限这个职业能用的
  G.blankTargets = () => (G.clsDef() ? G.classGems(G.save.cls) : G.GEM_SKILLS);
  // 对某个技能用一颗无铭宝石：没学会就学会，学会了就升到宝石的等级。总是用手里等级最高的那颗；
  // 已学技能的等级不低于它时不能用。成功返回 { id, lvl, from（原等级，新学为 0）, slot（新学时放进的技能栏格子，-1 为没有空格） }
  G.useBlankGem = function (id) {
    const save = G.save;
    const sk = G.SKILLS[id];
    const lvl = G.blankBest();
    const have = save.skills[id] || 0;
    if (!sk || sk.weaponOnly || !lvl || lvl <= have) return null;
    if (G.clsDef() && !G.classCanUse(save.cls, id)) return null; // 别的职业的技能：学不了
    save.blankGems.shift();
    const B = G.BLANK_GEM;
    let slot = -1;
    if (!have) {
      slot = learnSkill(id, lvl);
      toast('习得技能：' + sk.name + ' Lv ' + save.skills[id] + (slot >= 0 ? '' : '（去技能页绑定）') + ' · 用掉一颗' + B.short, GEM_COLOR);
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
    const scrapped = loot.kind === 'item' && loot.data.rarity === 0 && !!save.opts.autoSalvage && !loot.data.lk; // 锁定的物品（丢出去又捡回来）照常进背包
    if (scrapped) {
      const res = G.salvageResult(loot.data);
      for (const id in res) grantCurrency(id, res[id]);
      G.sfx('pickup', { r: 0 });
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
      G.sfx('pickup', { r: loot.data.rarity });
    } else if (loot.kind === 'cur') {
      grantCurrency(loot.data, 1);
      W.text(P.x, P.z, '+1 ' + G.CURRENCY[loot.data].name, loot.color, 13);
      G.sfx('pickup', { cur: 1 });
    } else if (loot.kind === 'skill') {
      const id = loot.data.id;
      const lvl = loot.data.lvl;
      const name = G.SKILLS[id].name;
      const have = save.skills[id];
      if (!have) {
        const free = learnSkill(id, lvl);
        toast('习得技能：' + name + ' Lv ' + save.skills[id] + (free >= 0 ? '' : '（按 G 绑定）'), GEM_COLOR);
      } else if (lvl > have) {
        save.skills[id] = lvl;
        toast(name + ' 升至 Lv ' + lvl, GEM_COLOR);
      } else {
        grantCurrency('dust', 1);
        toast('重复的技能宝石化为 1 ' + G.CURRENCY.dust.name, G.CURRENCY.dust.color);
      }
      G.sfx('gem');
      G.persist();
    } else if (loot.kind === 'frag') {
      // 烛芯：按种类计数（熄烛者的开启材料，见 G.FRAGS）
      const F = save.frags;
      F[loot.data] = Math.min(G.FRAG_DROP.max, (F[loot.data] || 0) + 1);
      toast('获得' + G.FRAGS[loot.data].name + '（共 ' + F[loot.data] + ' 个）', G.FRAGS[loot.data].color);
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
        toast('获得' + B.name + ' Lv ' + lvl + '（共 ' + save.blankGems.length + ' 颗，按 G 使用）', B.color);
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
    if (W.lootPick) W.lootPick(loot.x, loot.z, hexOf(loot.color), !!(loot.mesh.userData && loot.mesh.userData.bt)); // vf-vfx3：拾取的环 + 飞向脚下的碎晶
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
    if (bc) return G.openChest(bc);
    // 再没有宝箱：3.5 m 内能互动的异兆（祈坛、缚匣、拾烬客、落烬的烬核）
    const en = G.encNearest && G.encNearest(3.5);
    return en ? G.encUse(en) : false;
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
    if (G.world.levelUpFx) G.world.levelUpFx(P.x, P.z); // vf-vfx3：金色的环往外画开 + 竖直的细光痕（原来 4.5 米环 + 30 粒金光点）
    else G.world.ring(P.x, P.z, 4.5, 0xffd75e, 0.6);
    G.sfx('level');
    G.persist();
  };

  // =====================================================================
  // 背包 / 构筑操作（供 UI 调用）
  // =====================================================================
  function commit() {
    G.computeStats();
    syncWsCd();
    if (G.refreshMinions) G.refreshMinions(); // 技能栏 / 装备变了：来源不在的召唤物马上解散，上限降了的马上裁掉
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
    if (!G.canEquip(it)) return false; // 别的职业的武器（class-d2）：提示由背包页自己显示
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

  // 锁定：物品上的 lk: 1。锁定的物品不会被分解（单件 / 一键 / 拾取时自动）、不能卖给拾烬客；装备、丢弃、改造照常
  G.toggleLock = function (item) {
    const save = G.save;
    const i = bagIndex(item);
    let it = i >= 0 ? save.bag[i] : null;
    if (!it && item) for (const s of G.SLOTS) if (save.equip[s] && (save.equip[s] === item || save.equip[s].uid === item.uid)) it = save.equip[s];
    if (!it) return null;
    if (it.lk) delete it.lk;
    else it.lk = 1;
    G.persist();
    return !!it.lk;
  };

  G.salvage = function (item) {
    const save = G.save;
    const i = bagIndex(item);
    if (i < 0) return false; // 只能分解背包里的物品
    const it = save.bag[i];
    if (it.lk) return false; // 锁定的物品：界面层提示先解锁
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
      if (it.rarity === 0 && !it.lk) {
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

  // 一键分解会分掉哪些：稀有度不高于 maxRarity（0 普通，1 魔法，2 稀有）的背包物品，锁定的不算；
  // keep(it) 返回真的也留下（界面层用它留住换装评估为 ▲ 的稀有物品）。烬铸 / 渊契永远不在里面，身上的装备不在背包里。不改存档
  G.salvagePlan = function (maxRarity, keep) {
    const cap = maxRarity >= 2 ? 2 : maxRarity >= 1 ? 1 : 0;
    return G.save.bag.filter((it) => it.rarity <= cap && !it.lk && !(keep && keep(it)));
  };
  // 一键分解：分掉 G.salvagePlan 里的物品（按背包顺序逐件结算，和以前一样）。
  // 返回 { n, byRarity: [普通件数, 魔法件数, 稀有件数], gained: { 通货 id: 数量 } }，没有可分解的返回 null
  G.salvageBulk = function (maxRarity, keep) {
    const save = G.save;
    const go = new Set(G.salvagePlan(maxRarity, keep));
    const kept = [];
    const out = { n: 0, byRarity: [0, 0, 0], gained: {} };
    for (const it of save.bag) {
      if (go.has(it)) {
        addResult(out.gained, G.salvageResult(it));
        out.byRarity[it.rarity]++;
        out.n++;
      } else {
        kept.push(it);
      }
    }
    if (!out.n) return null;
    save.bag = kept;
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
    if (G.clsNodeOf(id)) return false; // 职业白送的起步天赋摘不掉（提示由天赋页自己显示）
    const rest = save.passives.filter((p) => p !== id);
    if (reachable(rest).size !== rest.length) return false; // 提示由天赋页自己显示
    save.passives = rest;
    return commit();
  };

  G.resetPassives = function () {
    G.save.passives = ['start'];
    if (G.clsDef() && Array.isArray(G.save.clsFree)) for (const id of G.save.clsFree) if (G.TREE[id]) G.save.passives.push(id); // 白送的起步天赋留着
    return commit();
  };

  // =====================================================================
  // 渊印（区域词缀）
  // =====================================================================
  // 一枚印：{ g 档（0 浅印 / 1 深印 / 2 烬印）, mods: [{ id, el? }], W 生效权重 }。素印 = null。
  // G.runMods：这次进区生效的印纹，进区时算好一次（各处热路径只读标志位，不查表）：
  //   W 生效权重、qty / rar / xp 三项奖励（小数）、lie 是否烈印；每条印纹以 id 为键，值是 G.SEAL_MODS 里它的 p（tint 另带 el）
  const PLAIN_MODS = Object.freeze({ W: 0, qty: 0, rar: 0, xp: 0, lie: false });
  G.runMods = PLAIN_MODS;
  state.run = { seal: null, mods: PLAIN_MODS };
  // 技能栏上有没有这类技能（蚀环要光环、孤影要召唤；没有时这条印纹的权重按 0 算）
  function barHas(bar, kind) {
    if (!Array.isArray(bar)) return false;
    for (const id of bar) if (id && G.SKILLS[id] && G.SKILLS[id].kind === kind) return true;
    return false;
  }
  G.sealModW = (m, bar) => {
    const d = G.SEAL_MODS[m.id];
    return !d ? 0 : d.need && !barHas(bar || (G.save && G.save.bar), d.need) ? 0 : d.w;
  };
  G.sealW = (seal, bar) => (seal ? seal.mods.reduce((a, m) => a + G.sealModW(m, bar), 0) : 0);
  // W 换成三项奖励（小数，各有上限）
  G.sealReward = (W) => {
    const S = G.SEAL;
    return {
      qty: Math.min(S.cap.qty, S.perW.qty * W) / 100,
      rar: Math.min(S.cap.rar, S.perW.rar * W) / 100,
      xp: Math.min(S.cap.xp, S.perW.xp * W) / 100,
    };
  };
  // 存档 / 外部传进来的印：只认表里的 id（不重复，tint 至多一条且元素合法），W 按表重算（存档里写的不算数）；层级 0 没有渊印
  G.cleanSeal = function (raw, tier, bar) {
    if (!isObj(raw) || !Array.isArray(raw.mods) || !((tier | 0) >= 1)) return null;
    const mods = [];
    const seen = {};
    for (const m of raw.mods.slice(0, 6)) {
      if (!isObj(m) || !G.SEAL_MODS[m.id] || seen[m.id]) continue;
      if (m.id === 'tint' && !G.SEAL_TINT[m.el]) continue;
      seen[m.id] = true;
      mods.push(m.id === 'tint' ? { id: m.id, el: m.el } : { id: m.id });
    }
    if (!mods.length) return null;
    const seal = { g: toInt(raw.g, 0, G.SEAL.grades.length - 1, 0), mods, W: 0 };
    seal.W = G.sealW(seal, bar);
    return seal;
  };
  // 印纹的名字 / 单字（焚染 / 霜染 / 雷染按元素）
  G.sealModName = (m) => (m.id === 'tint' ? G.SEAL_TINT[m.el].name : G.SEAL_MODS[m.id].name);
  G.sealModGlyph = (m) => (m.id === 'tint' ? G.SEAL_TINT[m.el].glyph : G.SEAL_MODS[m.id].glyph);
  // 印名：档名 + 前两条的单字，比如「烬印·戾躁」
  G.sealName = (seal) => (seal ? G.SEAL.grades[seal.g] + '·' + seal.mods.slice(0, 2).map(G.sealModGlyph).join('') : '素印');
  function sealMods(seal) {
    if (!seal) return PLAIN_MODS;
    const r = G.sealReward(seal.W);
    const o = { W: seal.W, qty: r.qty, rar: r.rar, xp: r.xp, lie: seal.W >= G.SEAL.lieW };
    for (const m of seal.mods) o[m.id] = m.id === 'tint' ? Object.assign({ el: m.el }, G.SEAL_MODS.tint.p) : G.SEAL_MODS[m.id].p;
    return o;
  }
  // ---------- 掷印 ----------
  // 一枚印：按档位的目标 W 从池里不放回地抽，每次只从「加上它不超 W、不超预算、不和已选的互斥」的印纹里抽；
  // 抽不出就重来（最多 TRIES 次），仍不行就把目标 W 降 1。烬印在条数上限内凑不到目标 W 时，可以多 1 条（权重最大 2，
  // 层级 1 的 3 条最多凑到 6，到不了 7）。焚染 / 霜染 / 雷染的元素取本区元素以外的一种
  const SEAL_TRIES = 20;
  function sealRng(seed) {
    let a = seed >>> 0; // mulberry32（同 world.js 的布局随机源），不碰 Math.random
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SEAL_ELEMS = ['fire', 'cold', 'light'];
  function rollOneSeal(R, g, T, elem, bar) {
    const nMin = Math.max(T.n[0], g === 2 ? T.minN3 : 0);
    const range = T.W[g];
    let target = range[0] + Math.floor(R() * (range[1] - range[0] + 1));
    for (; target >= range[0]; target--) {
      for (let tryN = 0; tryN < SEAL_TRIES; tryN++) {
        const nMax = T.n[1] + (g === 2 && tryN >= SEAL_TRIES / 2 ? 1 : 0);
        const mods = [];
        let W = 0, prod = 1, rage = 0, dead = 0;
        while (mods.length < nMax && !(W === target && mods.length >= nMin)) {
          const cand = [];
          for (const id of G.SEAL_MOD_IDS) {
            const d = G.SEAL_MODS[id];
            if (mods.some((m) => m.id === id)) continue;
            const w = G.sealModW({ id }, bar);
            // 「对你无效」的（w = 0）至多 1 条，而且只在条数不够时才进来
            if (w === 0 && (dead >= 1 || W < target)) continue;
            if (W + w > target || prod * d.dmgK > T.budget + 1e-9 || (d.rage && rage >= 2)) continue;
            // 往后还凑得齐：剩下的权重要能用剩下的条数补上（每条 1–2；条数不够下限时每条至少 1）
            const n1 = mods.length + 1, need = target - W - w, room = nMax - n1;
            if (w > 0 && (need > room * 2 || need < Math.max(0, nMin - n1))) continue;
            cand.push(id);
          }
          if (!cand.length) break;
          const id = cand[Math.floor(R() * cand.length)];
          const d = G.SEAL_MODS[id], w = G.sealModW({ id }, bar);
          const m = { id };
          if (id === 'tint') {
            const els = SEAL_ELEMS.filter((t) => t !== elem);
            m.el = els[Math.floor(R() * els.length)];
          }
          mods.push(m);
          W += w;
          prod *= d.dmgK;
          if (d.rage) rage++;
          if (w === 0) dead++;
        }
        if (W === target && mods.length >= nMin) return { g, mods, W };
      }
    }
    return null;
  }
  // 择印面板的三枚（浅印 / 深印 / 烬印）：种子 = sealSeq ^ 区域 × 7919 ^ 层级 × 104729，同一次进区之前怎么开关面板都是这三枚
  G.rollSeals = function (idx, tier, seq, bar) {
    if (!((tier | 0) >= 1)) return [];
    const s = seq === undefined ? G.save.sealSeq || 0 : seq;
    const R = sealRng((s ^ Math.imul(idx | 0, 7919) ^ Math.imul(tier | 0, 104729)) >>> 0);
    const T = G.sealTierDef(tier);
    const elem = G.ZONES[idx] ? G.ZONES[idx].elem : null;
    const out = [];
    for (let g = 0; g < 3; g++) {
      const seal = rollOneSeal(R, g, T, elem, bar || G.save.bar);
      if (seal) out.push(seal);
    }
    return out;
  };
  // 危险度：各条 dmgK 的乘积（面板的危险度条按本档预算画满）
  G.sealDanger = (seal) => (seal ? seal.mods.reduce((a, m) => a * G.SEAL_MODS[m.id].dmgK, 1) : 1);

  // ---------- 玩家侧印纹 ----------
  // 技能上下文末尾一行钩子：迟滞（冷却 +25%）、蚀环（光环效果 −30%：霜环每跳伤害、半径）、孤影（召唤物生命 −35%、伤害 −10%）
  G.sealCtx = function (ctx) {
    const RM = G.runMods;
    if (RM.sluggish && ctx.cd > 0) ctx.cd *= 1 + RM.sluggish.cd;
    if (RM.wane && ctx.sk.kind === 'aura') {
      ctx.more *= 1 - RM.wane.eff;
      ctx.area *= (1 - RM.wane.eff) * (1 - RM.wane.eff); // 半径 = 基础 × √area
    }
    if (RM.lonely && ctx.minion) {
      ctx.minion.life = Math.max(1, Math.round(ctx.minion.life * (1 - RM.lonely.life)));
      ctx.more *= 1 - RM.lonely.dmg;
    }
    return ctx;
  };

  // 当前这次进区的生效权重（渊契的烈印来源、首领渊契 ×1.5 读它）
  G.runSealW = () => G.runMods.W;
  // 渊契（relics 分支）合入之后：烈印来源随渊印一起打开
  if (G.RELIC_DROP && G.RELIC_DROP.src) G.RELIC_DROP.src.seal = true;
  // 固定件数按渊印数量 Q 变成期望 n × (1 + Q)：多出来的整数部分照给，零头按几率补一件
  function sealCount(n) {
    const v = n * (1 + G.runMods.qty);
    const k = Math.floor(v);
    return k + (v > k && Math.random() < v - k ? 1 : 0); // 素印时不多掷随机数
  }
  G.sealCount = sealCount;

  // ---------- 怪物侧：殁爆、余烬地（挂在 killEnemy） ----------
  // 殁爆：普通怪死后 delay 秒在尸体处炸开，预警圈从死亡那一刻就亮着（走 G.telegraph，每个 1 draw）；同时最多 max 个，多出来的不炸。
  // 伤害 = 它一击（不算领群 / 濒狂的加成）× k，不带焚染。余烬地：普通怪死亡时 chance 几率留下 t 秒的燃烧地面（同浅滩灼烧，对怪也生效），最多 max 块
  const cinders = (state.sealCinders = []); // { x, z, t, tick }
  let cinderPT = 0;
  let burstHitAt = -1e9; // 殁爆上一次伤到玩家的时刻
  function sealOnKill(e) {
    const RM = G.runMods;
    if (e.isBoss || (!RM.burst && !RM.cinder)) return;
    const W = G.world;
    const B = RM.burst;
    if (B) {
      let n = 0;
      for (const t of state.telegraphs) if (t.sealBurst) n++;
      if (n < B.max) {
        // 伤害不走预警圈的通用结算（dmg 0）：在 onFire 里自己判，玩家和每只召唤物都是 gap 秒内只挨一下
        const x = e.x, z = e.z, r = e.elite ? B.eR : B.r, hex = G.TYPE_HEX[e.elem] || 0xff6a2a, dmg = (e.dmgBase || e.dmg) * B.k;
        const tele = G.telegraph({
          shape: 'circle', x, z, r, dur: e.elite ? B.eDelay : B.delay, dmg: 0, dtype: 'phys',
          friendly: false, sealBurst: true, sealFx: true, burstDmg: dmg,
          onFire() {
            if (W.foeHit) W.foeHit(x, z, r, e.elem, { k: e.elite ? 1 : 0.7 }); // vf-vfx3：按元素的形状（原来 14–22 粒光点 + 环）
            else W.burst(x, 0.5, z, hex, e.elite ? 22 : 14, r * 2.6, 0.45);
            G.sfx('hit');
            if (!P.dead && insideTelegraph(tele, P.x, P.z) && !(state.time - burstHitAt < B.gap)) {
              burstHitAt = state.time;
              G.hurtPlayer(dmg, 'phys', tele);
            }
            if (G.hurtMinion) {
              for (let j = state.minions.length - 1; j >= 0; j--) {
                const m = state.minions[j];
                if (!m || m.dead || !insideTelegraph(tele, m.x, m.z) || state.time - (m.sealBurstAt || -1e9) < B.gap) continue;
                m.sealBurstAt = state.time;
                G.hurtMinion(m, dmg, 'phys', tele);
              }
            }
          },
        });
      }
    }
    const C = RM.cinder;
    if (C && !e.elite && Math.random() < C.chance) {
      if (cinders.length >= C.max) cinders.shift(); // 最早的那块先灭
      cinders.push({ x: e.x, z: e.z, t: C.t, tick: 0 });
      if (W.sealCinders) W.sealCinders(cinders, C);
    }
  }
  function clearSealFx() {
    cinders.length = 0;
    cinderPT = 0;
    if (G.world.sealCinders) G.world.sealCinders(cinders, null);
  }
  // 每帧（updatePlayer 里，地形危险区之后）：余烬地的灼烧和寿命
  function sealTick(dt) {
    if (!cinders.length) return;
    const W = G.world, TR = G.TERRAIN, C = G.runMods.cinder || G.SEAL_MODS.cinder.p;
    let inP = false;
    for (let i = cinders.length - 1; i >= 0; i--) {
      const c = cinders[i];
      c.t -= dt;
      if (c.t <= 0) {
        cinders.splice(i, 1);
        continue;
      }
      if (!P.dead && dist(P.x, P.z, c.x, c.z) <= C.r) inP = true;
      c.tick += dt;
      if (c.tick >= TR.burnTick) {
        c.tick -= TR.burnTick;
        for (const e of state.enemies) if (!e.dead && dist(e.x, e.z, c.x, c.z) <= C.r + e.r * 0.5) G.terrainBurnEnemy(e);
      }
    }
    if (inP) {
      cinderPT += dt;
      if (cinderPT >= TR.burnTick) {
        cinderPT -= TR.burnTick;
        G.hurtPlayer(TR.burn * G.dmgScale(state.zone.level), 'fire', null);
      }
    } else cinderPT = 0;
    if (W.sealCinders) W.sealCinders(cinders, C);
  }

  // =====================================================================
  // 异兆（随机遭遇，D4）
  // =====================================================================
  // 每次进区刷完怪之后掷一次（G.rollEncounters）：层级 0 只有 ENC.t0Chance 出 1 个，层级 ≥ 1 一定 1 个、ENC.second 再多 1 个。
  // 选址见 world.js 的「异兆」一节（W.encSite），找不到点位就换下一种。异兆不存档，读档重进跟着重掷。
  // **懒生成**：进区时只选址，不建道具、不刷怪（state.enemies 不变）；玩家走到 ENC.lazy 内或进了那个房间才「醒来」建道具，
  // 守隙 / 残影 / 落烬还要等所在房间的怪群死光（enc.roomMobs 全死）才张开。
  // 一个异兆 enc：{ kind, site, st, seen, live, k, level, roomMobs, mobs, pend }。st：sleep 等房间清空 / open 能开始 / idle 等玩家碰 /
  // run 进行中 / done 成功 / fail 失败。seen：小地图上换成图样。mobs：它刷出来的怪；pend：还在预警的刷怪 { t, x, z, fn }
  state.enc = [];
  // 渊契（relics 分支）合入之前没有 G.RELIC_DROP：异兆来源（6 件）和拾烬客的渊契货架这两处都不做事；合入之后自动打开
  const ENC_RELIC = !!(G.RELIC_DROP && G.RELIC_DROP.src);
  if (ENC_RELIC) G.RELIC_DROP.src.enc = G.RELIC_DROP.src.trader = true;
  G.encRelicOn = () => ENC_RELIC && typeof G.relicEncDrop === 'function';
  // 静物（不进 G.MOBS）：灰誓者的图腾、落烬的烬晶。生命在 spawnMob 里照常 × hpScale
  const TOTEM_DEF = { name: '誓灰图腾', hp: 0, dmg: 0, speed: 0, r: 0.5, range: 0, windup: 1, cd: 99, xp: 0.3, ai: 'still', mass: 99, poise: 0, h: 2.1, sturdy: true };
  const SHARD_DEF = { name: '烬晶', hp: 0, dmg: 0, speed: 0, r: 0.55, range: 0, windup: 1, cd: 99, xp: 0.5, ai: 'still', mass: 99, poise: 0, h: 1.9, sturdy: true };
  const LIGHT = (mobs) => {
    const l = mobs.filter((t) => t !== 'brute' && t !== 'charger' && t !== 'bomber');
    return l.length ? l : ['husk'];
  };
  function roomLevel(zone, room) {
    const rm = zone.rooms && zone.rooms[room];
    return zone.level + (rm && rm.lv !== undefined ? rm.lv : Math.floor((rm ? rm.order : 0) / 2));
  }
  function clearEnc() {
    state.enc.length = 0;
    state.trader = null;
  }
  // 掷这次进区的异兆。force（调试 / 测试）：按给的种类依次放，不掷个数、不看层级的池
  G.rollEncounters = function (zone, tier, force) {
    clearEnc();
    const W = G.world;
    if (!zone || !W.encSite || (G.debug && G.debug.noEnc && !force)) return state.enc;
    const E = G.ENC, t0 = !((tier | 0) >= 1), wi = t0 ? 0 : 1;
    let n = force ? force.length : t0 ? (Math.random() < E.t0Chance ? 1 : 0) : 1 + (Math.random() < E.second ? 1 : 0);
    if (!n) return state.enc;
    const pool = force ? force.slice() : G.ENC_IDS.filter((id) => G.ENCOUNTERS[id].w[wi] > 0);
    const taken = [];
    while (n > 0 && pool.length) {
      const id = force ? pool[0] : G.weighted(pool, (k) => G.ENCOUNTERS[k].w[wi]);
      pool.splice(pool.indexOf(id), 1);
      const D = G.ENCOUNTERS[id];
      const site = W.encSite(D.site, taken, id === 'guard' ? (s) => s.nodeD >= 14 : null); // 雷枢 14 m 内不放守隙
      if (!site) continue; // 找不到合格点位：换下一种
      taken.push(site);
      state.enc.push(makeEnc(id, site, zone, tier));
      n--;
    }
    return state.enc;
  };
  function makeEnc(kind, site, zone, tier) {
    const enc = { kind, site, st: 'sleep', seen: false, live: false, k: 0, t: 0, level: roomLevel(zone, site.room), tier: tier | 0, mobs: [], pend: [], roomMobs: null, mob: null };
    // 守隙 / 残影 / 落烬：记下这个房间原有的怪（按出生点算房间），全死了就是「房间清空」
    if (site.type === 'core') {
      const W = G.world;
      enc.roomMobs = state.enemies.filter((e) => !e.isBoss && !e.dead && W.roomAt(e.home.x, e.home.z) === site.room);
    }
    if (kind === 'box') {
      const a0 = Math.random() * TAU;
      enc.anchors = [0, 1, 2].map((i) => a0 + (i * TAU) / 3);
      site.ang = Math.random() * TAU;
    }
    if (kind === 'trader') site.face = Math.atan2(zone.start.x - site.x, zone.start.z - site.z);
    if (kind === 'wanderer') enc.title = G.pick(G.WANDERER_TITLES);
    return enc;
  }
  const roomClear = (enc) => !enc.roomMobs || enc.roomMobs.every((e) => e.dead);
  const aliveOf = (list) => {
    let n = 0;
    for (const e of list) if (!e.dead) n++;
    return n;
  };
  // 刷怪：先在 (x, z) 打一个 ENC.warn 秒的环形预警（环形池），到点再生成（不走 G.after：倒下重生会清掉计时器，这里自己数）
  function encSpawn(enc, x, z, hex, fn) {
    const W = G.world;
    W.ring(x, z, 1.4, hex, G.ENC.warn);
    W.burst(x, 0.3, z, hex, 6, 2.5, 0.5);
    enc.pend.push({ t: G.ENC.warn, x, z, fn });
  }
  function tickPend(enc, dt) {
    for (let i = enc.pend.length - 1; i >= 0; i--) {
      const p = enc.pend[i];
      p.t -= dt;
      if (p.t > 0) continue;
      enc.pend.splice(i, 1);
      const e = p.fn(p.x, p.z);
      if (e) {
        e.enc = enc;
        if (enc.tier < 1) e.xpK = G.ENC.t0Xp; // 层级 0 的异兆经验 ×0.5
        enc.mobs.push(e);
        G.world.burst(p.x, 0.6, p.z, 0xd8c8ff, 10, 3.5, 0.5);
      }
    }
  }
  // 在 (cx, cz) 附近 r0–r1 的环上找一个可走、看得见圆心的点（找不到返回 null）
  function ringSpot(cx, cz, r0, r1, sd, room, tries) {
    const W = G.world;
    for (let i = 0; i < (tries || 24); i++) {
      const a = Math.random() * TAU, d = G.rand(r0, r1);
      const x = cx + Math.sin(a) * d, z = cz + Math.cos(a) * d;
      if (!(W.sdAt(x, z) >= sd) || !W.walkable(x, z, 0.8)) continue;
      if (room !== undefined && W.roomAt(x, z) !== room) continue;
      let ok = true;
      const n = Math.ceil(d / 0.5);
      for (let k = 1; k < n && ok; k++) if (!W.shotFree(cx + ((x - cx) * k) / n, cz + ((z - cz) * k) / n, -0.2)) ok = false;
      if (ok) return { x, z };
    }
    return null;
  }
  // 残影的浮现点：默认是房间芯 s。玩家多半一进门就触发，芯常在镜头北边六到九米，首领那么高的残影连同预警环都在画面顶上之外。
  // 芯的脚下和头顶都在画面里就不动；否则在这个房间里找离芯最近、离玩家 5–9 m、整个身子都在画面里、玩家看得见的点，
  // 找不到再退一步只要半身在画面里，都没有就还是芯（只挪浮现的位置，拴绳、等级、招式都不变；不用随机数）
  const ECHO_H = 4.6;
  function echoSpot(s) {
    const W = G.world;
    const seen = (x, z, h) => W.inView(x, z, 0.2) && W.inView(x, z, h);
    if (seen(s.x, s.z, ECHO_H)) return s;
    for (const h of [ECHO_H, ECHO_H * 0.5]) {
      for (let r = 1; r <= 12; r++) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * TAU, x = s.x + Math.sin(a) * r, z = s.z + Math.cos(a) * r;
          const dp = Math.hypot(x - P.x, z - P.z);
          if (dp < 5 || dp > 9 || W.roomAt(x, z) !== s.room || !(W.sdAt(x, z) >= 2) || !W.walkable(x, z, 1) || !seen(x, z, h)) continue;
          let ok = true;
          const n = Math.ceil(dp / 0.5);
          for (let i = 1; i < n && ok; i++) if (!W.shotFree(P.x + ((x - P.x) * i) / n, P.z + ((z - P.z) * i) / n, -0.2)) ok = false;
          if (ok) return { x, z };
        }
      }
    }
    return s;
  }
  // 异兆里的怪：普通小怪（区域怪群同一套打折，horde）、awake 直接醒着
  function encMob(enc, type, x, z, o) {
    const e = G.spawnMob(type, x, z, (o && o.level) || enc.level, { elite: !!(o && o.elite), awake: true, horde: !(o && (o.elite || o.noHorde)), pack: null });
    e.wasAwake = false;
    return e;
  }
  // 让一只异兆的怪不打招呼地散掉（试锋超时、落烬失败、镜影客本体死了）：不给经验、不掉东西
  function encVanish(e) {
    if (!e || e.dead) return;
    e.dead = true;
    e.deathT = 0.25;
    e.hp = 0;
    e.seq++;
    G.world.die(e.ent, { ang: 0, type: 'chaos', over: 0, force: 0 });
    G.world.burst(e.x, 1, e.z, 0xb8a8d8, 10, 3, 0.5);
  }
  G.encVanish = encVanish;

  // ---------- 奖励（自己的掉落代码，不改 G.dropLoot；件数 / 稀有度照样吃渊印的 Q / R）----------
  function encRm() {
    return (1 + (P.S.rarity || 0) / 100) * (1 + G.runMods.rar);
  }
  function eliteRoll(lvl, x, z, rk) {
    const rm = encRm() * (rk || 1);
    for (let i = 0, n = sealCount(2); i < n; i++) G.spawnLoot('item', G.rollItem(lvl, G.rollRarity(rm * 2)), x, z);
    for (let i = 0, n = sealCount(1); i < n; i++) G.spawnLoot('cur', G.rollCurrency(), x, z);
    if (Math.random() < SUPPORT_DROP.elite) G.spawnLoot('support', pickSupportGem(0.7), x, z);
    if (Math.random() < BLANK_DROP.elite) G.spawnLoot('blank', { lvl: gemLevel() }, x, z);
  }
  G.encReward = function (R, lvl, x, z) {
    const rm = encRm();
    for (let i = 0; i < (R.elite || 0); i++) eliteRoll(lvl, x, z, R.rar);
    for (let i = 0, n = R.rare ? sealCount(R.rare) : 0; i < n; i++) G.spawnLoot('item', G.rollItem(lvl, 2), x, z);
    for (let i = 0, n = R.items ? sealCount(R.items) : 0; i < n; i++) G.spawnLoot('item', G.rollItem(lvl, G.rollRarity(rm)), x, z);
    for (let i = 0, n = R.magic ? sealCount(R.magic) : 0; i < n; i++) G.spawnLoot('item', G.rollItem(lvl, Math.max(1, G.rollRarity(rm * (R.magicRar || 1)))), x, z);
    for (let i = 0, n = R.cur ? sealCount(R.cur) : 0; i < n; i++) G.spawnLoot('cur', G.rollCurrency(), x, z);
    if (R.gem) {
      if (Math.random() < 0.5) G.spawnLoot('skill', pickSkillGem(0.7), x, z);
      else G.spawnLoot('support', pickSupportGem(0.7), x, z);
    }
  };
  // 烛芯：按这次进区择的印掷一次（层级 < minTier 为 0；没有保底）
  function fragRoll() {
    const p = G.fragChance(state.run && state.run.seal, state.tier || 0);
    return p > 0 && Math.random() < p;
  }
  G.fragRoll = fragRoll;
  function dropFrag(id, x, z) {
    G.spawnLoot('frag', id, x, z);
    G.world.text(x, z, G.FRAGS[id].name, G.FRAGS[id].color, 22, { kind: 'tag', y: 2.4 });
    G.sfx('unique');
    state.stats.frags = (state.stats.frags || 0) + 1;
  }
  // 异兆成功掉的烛芯（层级 ≥ 2）：隙 / 誓 / 匣
  G.encFragDrop = function (kind, x, z) {
    const id = G.ENCOUNTERS[kind] && G.ENCOUNTERS[kind].frag;
    if (!id || !fragRoll()) return false;
    dropFrag(id, x, z);
    return true;
  };
  // 印烛芯：击杀区域首领（G.dropLoot 首领分支的钩子；任何印下都掷，几率同上）
  G.fragSealDrop = function (e) {
    if (!fragRoll()) return false;
    dropFrag('seal', e.x, e.z);
    return true;
  };
  // 异兆成功：奖励 + 烛芯 + 渊契（渊契分支合入后才有）
  function encWin(enc, R, x, z, lvl, frag) {
    if (R) G.encReward(R, lvl || enc.level, x, z);
    if (frag !== false) G.encFragDrop(enc.kind, x, z);
    const D = G.ENCOUNTERS[enc.kind];
    if (D.relic && G.encRelicOn()) G.relicEncDrop(D.relic, lvl || enc.level, x, z);
    G.persist();
  }
  function finish(enc, ok, msg) {
    enc.st = ok ? 'done' : 'fail';
    enc.k = ok ? 1 : enc.k;
    enc.pend.length = 0;
    const D = G.ENCOUNTERS[enc.kind];
    toast(D.name + (msg ? '：' + msg : ok ? '：完成' : '：失败'), ok ? '#c8b0ff' : '#a89a8a');
    state.stats.encDone = (state.stats.encDone || 0) + (ok ? 1 : 0);
  }

  // ---------- 各异兆的运行时 ----------
  // wake(enc)：醒来（建道具 / 刷游荡者）；tick(enc, dt, d, pr)：每个模拟步（d 玩家到点位的距离，pr 玩家所在房间）
  const ENC_RUN = {
    guard: {
      wake(enc) {
        G.world.encProp(enc);
      },
      tick(enc, dt, d) {
        const D = G.ENCOUNTERS.guard.p, s = enc.site, W = G.world;
        if (enc.st === 'sleep') {
          if (!roomClear(enc)) return;
          enc.st = 'open';
          W.ring(s.x, s.z, D.r, 0xa98cff, 0.6);
          W.burst(s.x, 1.4, s.z, 0xb090ff, 30, 5, 0.8);
          if (d < 40) toast('裂隙张开了：站进圈里坚守 ' + D.hold + ' 秒', '#c8b0ff');
          return;
        }
        if (enc.st === 'open') {
          if (d > D.r || P.dead) return;
          enc.st = 'run';
          enc.t = 0;
          enc.wave = 0;
          enc.away = 0;
          enc.zeroT = 0;
          enc.queue = [];
          enc.hold = false;
          // 刷怪点：r 9–12 的环上、sd ≥ 1.5、看得见圈心
          enc.pts = [];
          for (let i = 0; i < D.pts; i++) {
            const p = ringSpot(s.x, s.z, D.ring[0], D.ring[1], 1.5, undefined, 30) || ringSpot(s.x, s.z, D.r + 1, D.ring[1], 1.0, undefined, 30);
            if (p) enc.pts.push(p);
          }
          if (!enc.pts.length) enc.pts.push({ x: s.x + D.r + 2, z: s.z });
          return;
        }
        if (enc.st !== 'run') return;
        if (P.dead) return finish(enc, false, '你倒下了，裂隙闭合');
        // 坚守计时：圈里才走；离圈超过 grace 秒开始倒退；退回 0 之后 failT 秒内没回圈就失败
        if (d <= D.r) {
          enc.away = 0;
          enc.zeroT = 0;
          enc.t += dt;
        } else {
          enc.away += dt;
          if (enc.away > D.grace) enc.t = Math.max(0, enc.t - D.back * dt);
          if (enc.t <= 0) {
            enc.zeroT += dt;
            if (enc.zeroT > D.failT) return finish(enc, false, '离圈太久，裂隙闭合');
          }
        }
        enc.k = G.clamp(enc.t / D.hold, 0, 1);
        // 波次：按坚守计时刷出；最后一波另加精英（层级 ≥ 2 两只）
        while (enc.wave < D.waves.length && enc.t >= D.waves[enc.wave]) {
          const light = LIGHT(state.zone.def.mobs);
          for (let i = 0; i < D.n[enc.wave]; i++) enc.queue.push({ type: G.pick(light), elite: false });
          if (enc.wave === D.waves.length - 1) {
            const ne = enc.tier >= 2 ? D.elite[1] : D.elite[0];
            const pool = state.zone.def.mobs.filter((t) => t !== 'bomber');
            for (let i = 0; i < ne; i++) enc.queue.push({ type: G.pick(pool.length ? pool : ['husk']), elite: true });
          }
          enc.wave++;
        }
        // 同场 ≤ cap：满了就排队，场上（含预警中的）≤ resume 再接着刷
        const live = aliveOf(enc.mobs) + enc.pend.length;
        if (live >= D.cap) enc.hold = true;
        else if (enc.hold && live <= D.resume) enc.hold = false;
        if (!enc.hold && enc.queue.length && live < D.cap) {
          const q = enc.queue.shift(), p = enc.pts[Math.floor(Math.random() * enc.pts.length)];
          const j = ringSpot(p.x, p.z, 0, 1.4, 1.0, undefined, 8) || p;
          encSpawn(enc, j.x, j.z, q.elite ? 0xffc04a : 0xa98cff, (x, z) => encMob(enc, q.type, x, z, { elite: q.elite }));
        }
        if (enc.t >= D.hold) {
          finish(enc, true, '坚守成功');
          encWin(enc, G.ENCOUNTERS.guard.rew, s.x, s.z);
        }
      },
    },
    box: {
      wake(enc) {
        enc.st = 'idle';
        G.world.encProp(enc);
      },
      tick(enc, dt, d) {
        const D = G.ENCOUNTERS.box.p, s = enc.site;
        if (enc.st === 'idle') {
          if (d <= D.touch && !P.dead) ENC_RUN.box.use(enc);
          return;
        }
        if (enc.st !== 'run') return;
        enc.t -= dt;
        enc.k = G.clamp(enc.t / D.time, 0, 1);
        if (enc.pend.length || aliveOf(enc.mobs)) return;
        const ok = enc.t > 0;
        enc.how = ok ? 'free' : 'late';
        finish(enc, true, ok ? '解缚' : '残缚');
        enc.openT = 0;
        G.world.burst(s.x, 0.7, s.z, 0xffd36a, 24, 4.5, 0.6);
        if (ok) encWin(enc, G.ENCOUNTERS.box.rew, s.x, s.z);
        else G.encReward(G.ENCOUNTERS.box.rewFail, enc.level, s.x, s.z), G.persist();
      },
      // 锁链崩开：三个锚点各刷一只匣卫
      use(enc) {
        if (enc.st !== 'idle') return false;
        const D = G.ENCOUNTERS.box.p, s = enc.site, W = G.world;
        enc.st = 'run';
        enc.t = D.time;
        W.burst(s.x, 0.6, s.z, 0x8a8490, 26, 5, 0.6);
        W.shake(0.25);
        G.sfx('hit');
        const pool = state.zone.def.mobs.filter((t) => t !== 'bomber');
        for (const a of enc.anchors) {
          let x = s.x + Math.sin(a) * D.anchor, z = s.z + Math.cos(a) * D.anchor;
          if (!W.walkable(x, z, 0.8)) {
            const q = ringSpot(s.x, s.z, 1.5, D.anchor, 0.8, undefined, 16);
            if (q) (x = q.x), (z = q.z);
          }
          const type = G.pick(pool.length ? pool : ['husk']);
          encSpawn(enc, x, z, 0xffc04a, (x2, z2) => {
            const e = encMob(enc, type, x2, z2, { noHorde: true });
            e.maxHp = e.hp = Math.max(1, Math.round(e.hp * D.hp));
            e.dmg *= D.dmg;
            e.dmgBase = e.dmg; // 渊印的濒狂 / 领群按 dmgBase 重算 e.dmg：一起改
            e.xpW = D.xpW;
            e.name = '匣卫·' + e.def.name;
            G.initBuildUp(e);
            return e;
          });
        }
        toast('锁链崩开：' + D.time + ' 秒内打倒三只匣卫', '#ffd36a');
        return true;
      },
    },
    wanderer: {
      wake(enc) {
        const Wd = G.WANDERER, s = enc.site, zone = state.zone;
        const type = Wd.types.find((t) => zone.def.mobs.indexOf(t) >= 0) || zone.def.mobs[0];
        const e = G.spawnMob(type, s.a.x, s.a.z, enc.level, { elite: true, awake: false, pack: null });
        e.maxHp = e.hp = Math.max(1, Math.round(e.hp * Wd.hp));
        e.poiseBase = e.poiseMax = e.poise = Math.round((e.poiseMax || e.def.poise) * Wd.poise);
        e.r = e.def.r * Wd.size;
        e.height = (e.def.h || (type === 'brute' ? 2.8 : 2)) * Wd.size;
        e.reach = e.def.range + (e.r - e.def.r);
        e.ent.k = Wd.size;
        e.ent.body.scale.setScalar(Wd.size);
        e.xpW = Wd.xpW;
        e.encNoLoot = true; // 奖励走 encWin，不走精英掉落表
        const N = Wd.names;
        const a = Math.floor(Math.random() * N.length);
        const b = (a + 1 + Math.floor(Math.random() * (N.length - 1))) % N.length;
        e.name = Wd.titles[enc.title].name + '·' + N[a] + N[b];
        e.enc = enc;
        if (enc.tier < 1) e.xpK = G.ENC.t0Xp;
        G.initBuildUp(e);
        G.makeWanderer(e, enc.title, s.rooms, s.doors, s.a, s.b);
        enc.mob = e;
        enc.mobs.push(e);
        enc.st = 'run';
      },
      tick(enc) {
        const e = enc.mob;
        if (enc.st === 'run' && e && e.dead && !e.encDone) enc.st = 'fail'; // 被调试 / 测试清掉（正常击杀在 encOnKill 里结算）
      },
    },
    shrine: {
      wake(enc) {
        enc.st = 'idle';
        G.world.encProp(enc);
      },
      tick() {},
      use(enc) {
        if (enc.used) return false;
        enc.used = true;
        enc.st = 'done';
        const id = G.pick(G.SHRINE_IDS), B = G.SHRINE_BUFFS[id];
        G.encBuff(id);
        const W = G.world;
        W.burst(enc.site.x, 2.4, enc.site.z, 0x9fe7ff, 30, 5, 0.8);
        W.ring(P.x, P.z, 2.4, 0x9fe7ff, 0.5);
        W.text(P.x, P.z, B.name, B.color, 26, { kind: 'tag', y: 2.6 });
        toast('祈坛：' + B.name + '（' + B.desc + '）' + B.dur + ' 秒', B.color);
        G.sfx('gem');
        return true;
      },
    },
    trial: {
      wake(enc) {
        enc.st = 'idle';
        G.world.encProp(enc);
      },
      tick(enc, dt, d, pr) {
        const D = G.ENCOUNTERS.trial.p, s = enc.site;
        if (enc.st === 'idle') {
          // 跨过门口的符文才开始：在小室里、并且离门比符文还远（站在门洞里不算，免得人还半在门外就开打）
          if (pr !== s.room || P.dead) return;
          if (dist(P.x, P.z, s.door.x, s.door.z) < dist(s.rune.x, s.rune.z, s.door.x, s.door.z) - 0.1) return;
          enc.st = 'run';
          enc.t = D.time;
          enc.wave = 0;
          enc.leaveT = 0;
          ENC_RUN.trial.wave(enc);
          toast('试锋开始：' + D.time + ' 秒内打完三波', '#ff8a6a');
          return;
        }
        if (enc.st !== 'run') return;
        enc.t -= dt;
        enc.k = G.clamp(enc.t / D.time, 0, 1);
        // 离开小室超过 leave 秒（倒下重生也算）：弃权
        const inside = pr === s.room || Math.hypot(P.x - s.door.x, P.z - s.door.z) <= D.door;
        enc.leaveT = inside && !P.dead ? 0 : enc.leaveT + dt;
        if (enc.leaveT > D.leave) return ENC_RUN.trial.end(enc, 'quit');
        if (enc.t <= 0) return ENC_RUN.trial.end(enc, 'late');
        if (enc.pend.length || aliveOf(enc.mobs)) return;
        if (enc.wave < D.n.length) ENC_RUN.trial.wave(enc);
        else ENC_RUN.trial.end(enc, enc.t >= D.good ? 'top' : 'mid');
      },
      wave(enc) {
        const D = G.ENCOUNTERS.trial.p, s = enc.site, W = G.world;
        const n = D.n[enc.wave], last = enc.wave === D.n.length - 1, mobs = state.zone.def.mobs;
        const doors = [s.door];
        for (let i = 0; i < n; i++) {
          let p = null;
          for (let k = 0; k < 20 && !p; k++) {
            const q = ringSpot(s.x, s.z, 0, Math.max(1.5, s.r * 0.8), 1.0, s.room, 1);
            if (q && Math.hypot(q.x - s.door.x, q.z - s.door.z) >= D.door) p = q;
          }
          if (!p) p = { x: s.x, z: s.z };
          const elite = last && i < D.elite;
          const type = elite ? G.pick(mobs.filter((t) => t !== 'bomber').concat(['husk'])) : G.pick(mobs);
          encSpawn(enc, p.x, p.z, elite ? 0xffc04a : 0xff5a4a, (x, z) => {
            const e = encMob(enc, type, x, z, { elite });
            e.leashRooms = [s.room];
            e.leashDoors = doors;
            return e;
          });
        }
        enc.wave++;
        if (enc.wave > 1) W.text(P.x, P.z, '第 ' + enc.wave + ' 波', '#ff9a7a', 22, { kind: 'tag', y: 2.6 });
      },
      end(enc, how) {
        const T = G.ENCOUNTERS.trial, s = enc.site;
        if (how === 'top' || how === 'mid') {
          finish(enc, true, how === 'top' ? '「上」（剩 ' + Math.floor(enc.t) + ' 秒）' : '「中」');
          encWin(enc, how === 'top' ? T.rew : T.rewMid, s.x, s.z);
        } else {
          // 超时 / 弃权：没清掉的怪淡出消失，给 1 颗通货
          for (const e of enc.mobs) encVanish(e);
          finish(enc, false, how === 'quit' ? '弃权' : '超时');
          G.encReward(T.rewFail, enc.level, s.x, s.z);
        }
        enc.how = how;
      },
    },
    trader: {
      wake(enc) {
        enc.st = 'idle';
        G.world.encProp(enc);
      },
      tick() {},
      use(enc) {
        G.traderOpen(enc);
        return true;
      },
    },
    echo: {
      wake() {},
      tick(enc, dt, d, pr) {
        if (enc.st === 'run' && enc.mob && enc.mob.dead && !enc.mob.encDone) enc.st = 'fail'; // 被调试 / 测试清掉（正常击杀在 encOnKill 里结算）
        // 房间清空、玩家就在这个房间里才浮现
        if (enc.st !== 'sleep' || pr !== enc.site.room || !roomClear(enc)) return;
        const D = G.ENCOUNTERS.echo.p, s = enc.site, zone = state.zone;
        enc.st = 'run';
        const lvl = enc.level + D.lv;
        const at = (enc.at = echoSpot(s));
        encSpawn(enc, at.x, at.z, 0xb090ff, (x, z) => {
          const e = G.spawnBoss(zone.def.boss, x, z, lvl, { echo: true, hpK: D.hp, pats: D.pats });
          e.leashRooms = [s.room];
          e.leashDoors = zone.links.filter((L) => L.door && (L.a === s.room || L.b === s.room)).map((L) => L.door);
          e.xpW = D.xpW;
          e.encNoLoot = true;
          enc.mob = e;
          return e;
        });
        G.world.ring(at.x, at.z, 4, 0xb090ff, G.ENC.warn);
        toast('「' + G.BOSSES[zone.def.boss].name + '」的残影浮现了', '#c8b0ff');
      },
    },
    ember: {
      wake(enc) {
        G.world.encProp(enc);
      },
      tick(enc, dt, d) {
        const D = G.ENCOUNTERS.ember.p, s = enc.site, W = G.world;
        if (enc.st === 'sleep') {
          if (roomClear(enc)) enc.st = 'open';
          return;
        }
        if (enc.st === 'open') {
          if (d <= D.touch && !P.dead) ENC_RUN.ember.use(enc);
          return;
        }
        if (enc.st !== 'run') return;
        enc.t -= dt;
        enc.k = G.clamp(enc.t / D.time, 0, 1);
        if (!enc.pend.length && enc.shards && enc.shards.every((e) => e.dead)) {
          finish(enc, true, '烬晶全碎');
          enc.tele.length = 0;
          return encWin(enc, G.ENCOUNTERS.ember.rew, s.x, s.z);
        }
        if (enc.t <= 0) {
          for (const e of enc.shards || []) encVanish(e);
          return finish(enc, false, '超时');
        }
        // 落烬：每 every 秒一团，同时 ≤ max 个预警；aim 的几率瞄着玩家（玩家在范围里时）
        enc.fallT -= dt;
        // 已经结算的（或倒下重生时被整个清掉的）预警不再占名额
        for (let i = enc.tele.length - 1; i >= 0; i--) if (enc.tele[i].t >= enc.tele[i].dur || state.telegraphs.indexOf(enc.tele[i]) < 0) enc.tele.splice(i, 1);
        if (enc.fallT > 0 || enc.tele.length >= D.max) return;
        enc.fallT = D.every;
        let x, z;
        const pin = Math.hypot(P.x - s.x, P.z - s.z) <= D.area + 2 && Math.random() < D.aim;
        if (pin) (x = P.x + G.rand(-0.6, 0.6)), (z = P.z + G.rand(-0.6, 0.6));
        else {
          const q = ringSpot(s.x, s.z, 0, D.area, 0.3, undefined, 6);
          if (!q) return;
          x = q.x;
          z = q.z;
        }
        const hit = D.hitK * G.MOBS.husk.dmg * G.dmgScale(enc.level);
        const t = G.telegraph({
          shape: 'circle', x, z, r: D.r, dur: D.warn, dmg: hit, dtype: 'fire', owner: null, friendly: false,
          onFire() {
            W.burst(x, 0.5, z, 0xff8a3c, 16, 5, 0.5);
            W.decal(1, x, z, D.r * 0.8, Math.random() * TAU, 0xff6a2a, 3);
            // 打怪 × mobK（烬晶不吃：要你自己打碎）
            for (const e of state.enemies) if (!e.dead && !e.fixed && !e.isBoss && dist(e.x, e.z, x, z) <= D.r + e.r * 0.5) encHurt(e, hit * D.mobK);
          },
        });
        enc.tele.push(t);
      },
      use(enc) {
        if (enc.st !== 'open') return false;
        const D = G.ENCOUNTERS.ember.p, s = enc.site;
        enc.st = 'run';
        enc.t = D.time;
        enc.fallT = 1.0;
        enc.tele = [];
        enc.shards = [];
        const a0 = Math.random() * TAU;
        for (let i = 0; i < D.n; i++) {
          let p = null;
          for (let k = 0; k < 10 && !p; k++) {
            const a = a0 + (i * TAU) / D.n + G.rand(-0.35, 0.35), dd = G.rand(D.ring[0], D.ring[1]);
            const x = s.x + Math.sin(a) * dd, z = s.z + Math.cos(a) * dd;
            if (G.world.sdAt(x, z) >= 1.0) p = { x, z };
          }
          if (!p) p = ringSpot(s.x, s.z, 3, D.ring[1], 0.8, undefined, 20) || { x: s.x + 3, z: s.z };
          encSpawn(enc, p.x, p.z, 0xff8a3c, (x, z) => {
            const def = Object.assign({}, SHARD_DEF, { hp: G.MOBS.husk.hp * D.hp });
            const e = G.spawnMob('shard', x, z, enc.level, { def, awake: true });
            e.fixed = true;
            e.encNoLoot = true;
            e.ang = 0;
            enc.shards.push(e);
            return e;
          });
        }
        G.world.burst(s.x, 1.2, s.z, 0xffa64a, 30, 5, 0.7);
        toast('余烬开始落下：' + D.time + ' 秒内打碎四块烬晶', '#ffb070');
        return true;
      },
    },
  };
  // 余烬打到怪：直接扣血（不算玩家的命中，不触发技能效果）
  function encHurt(e, dmg) {
    if (!e || e.dead) return;
    e.hp -= dmg;
    e.awake = true;
    G.world.flash(e.ent, 0.6);
    G.world.text(e.x, e.z, '-' + Math.round(dmg), '#ff8a3c', 14);
    if (e.hp <= 0) G.killEnemy(e);
  }

  // 灰誓者的图腾（enemies.js 在生命过阈值时调）
  G.encSpawnTotems = function (w, T) {
    const W = G.world, a0 = Math.random() * TAU;
    w.encTotems = w.encTotems || [];
    for (let i = 0; i < T.n; i++) {
      const a = a0 + (i * TAU) / T.n;
      let x = w.x + Math.sin(a) * T.ring, z = w.z + Math.cos(a) * T.ring;
      if (!W.walkable(x, z, 0.6)) {
        const q = ringSpot(w.x, w.z, 1.5, T.ring + 1, 0.6, undefined, 12);
        if (!q) continue;
        x = q.x;
        z = q.z;
      }
      const def = Object.assign({}, TOTEM_DEF, { hp: G.MOBS.husk.hp * T.hp });
      const t = G.spawnMob('totem', x, z, w.level, { def, awake: true });
      t.fixed = true;
      t.summoned = true; // 玩家重生时直接移除（同首领召来的小怪）
      t.encNoLoot = true;
      t.ang = 0;
      w.encTotems.push(t);
      if (w.enc) w.enc.mobs.push(t);
      W.ring(x, z, 1.4, 0xc8c0b0, 0.5);
      W.burst(x, 1, z, 0xc8c0b0, 12, 3, 0.5);
    }
    W.text(w.x, w.z, '立誓', '#e8e0d0', 22, { kind: 'tag', y: 3.6 });
  };
  // 镜影客的分身：同样的怪、同样的普攻，生命 hp 倍、伤害 dmg 倍，不会再分；本体死了一起散
  G.encSpawnClone = function (w, T) {
    const W = G.world;
    const q = ringSpot(w.x, w.z, 1.5, 3.5, 0.8, undefined, 12) || { x: w.x + 1.5, z: w.z };
    const c = G.spawnMob(w.type, q.x, q.z, w.level, { elite: false, awake: true, pack: null });
    c.maxHp = c.hp = Math.max(1, Math.round(w.maxHp * T.hp));
    c.dmg = (w.dmgBase || w.dmg) * T.dmg;
    c.dmgBase = c.dmg; // 渊印的濒狂 / 领群按 dmgBase 重算 e.dmg
    c.name = '镜影';
    c.summoned = true;
    c.encNoLoot = true;
    c.xpK = 0;
    c.encOwner = w;
    c.leashRooms = w.leashRooms;
    c.leashDoors = w.leashDoors;
    c.ent.k = w.ent.k;
    c.ent.body.scale.setScalar(w.ent.k);
    if (W.echoTint) W.echoTint(c.ent);
    G.initBuildUp(c);
    (w.encClones || (w.encClones = [])).push(c);
    if (w.enc) w.enc.mobs.push(c);
    W.burst(q.x, 1, q.z, 0xb8a8ff, 16, 4, 0.5);
    W.text(w.x, w.z, '镜影', '#d0c0ff', 22, { kind: 'tag', y: 3.6 });
  };
  // G.killEnemy 的钩子：游荡者 / 残影倒下结算奖励；游荡者死了分身一起散
  G.encOnKill = function (e) {
    const enc = e.enc;
    if (e.encClones) for (const c of e.encClones) encVanish(c);
    if (!enc || e !== enc.mob || enc.st !== 'run') return;
    e.encDone = true;
    const D = G.ENCOUNTERS[enc.kind];
    finish(enc, true, '已击败「' + e.name + '」');
    encWin(enc, D.rew, e.x, e.z, e.level);
  };

  // ---------- 每个模拟步（main.js 的 sim 调）----------
  G.updateEncounters = function (dt) {
    // 祈坛的增益倒计时（不跟着异兆走：换区也带着）
    const B = P.encBuff;
    if (B) {
      B.t -= dt;
      if (B.t <= 0) {
        P.encBuff = null;
        G.computeStats();
      }
    }
    const list = state.enc;
    if (!list.length || !state.zone) return;
    const W = G.world, E = G.ENC;
    const pr = W.roomAt(P.x, P.z);
    for (let i = 0; i < list.length; i++) {
      const enc = list[i], s = enc.site;
      const d = dist(P.x, P.z, s.x, s.z);
      const inRoom = pr >= 0 && (pr === s.room || (s.rooms && s.rooms.indexOf(pr) >= 0));
      if (!enc.seen && (d <= E.reveal || inRoom)) enc.seen = true;
      if (!enc.live) {
        // 醒来：走到 lazy 内 / 进了房间；游荡者只看房间：玩家进到巡逻段或它的相邻房间时才生成（不按距离，起点附近不会冒出来）
        let near = s.rooms ? inRoom : d <= E.lazy || inRoom;
        if (!near && s.rooms && pr >= 0) for (const r of s.rooms) if (W.roomLink(pr, r) >= 0) near = true;
        if (!near) continue;
        enc.live = true;
        ENC_RUN[enc.kind].wake(enc);
        // 能互动的几种：醒来时提示一句怎么用（同一种只在这次进区提示一次）
        const HINT = { shrine: '祈坛：走近按 F 激活', trader: '拾烬客：走近按 F 交易', box: '缚匣：走近崩开锁链（会惊醒匣卫）' };
        if (HINT[enc.kind]) toast(HINT[enc.kind], '#d8c8a8', 'enc-' + enc.kind, 2600);
      }
      if (enc.pend.length) tickPend(enc, dt);
      ENC_RUN[enc.kind].tick(enc, dt, d, pr);
    }
  };
  // 祈坛增益：P.encBuff = { id, t }，属性在 computeStats 里加
  G.encBuff = function (id, dur) {
    const B = G.SHRINE_BUFFS[id];
    if (!B) return false;
    P.encBuff = { id, t: dur === undefined ? B.dur : dur };
    G.computeStats();
    return true;
  };
  // 能互动的异兆（祈坛、缚匣、拾烬客、落烬的烬核）：互动点和最大距离
  function encUsable(enc) {
    if (!enc.live) return false;
    if (enc.kind === 'shrine') return !enc.used;
    if (enc.kind === 'box') return enc.st === 'idle';
    if (enc.kind === 'trader') return true;
    if (enc.kind === 'ember') return enc.st === 'open';
    return false;
  }
  G.encUse = function (enc) {
    if (!enc || !encUsable(enc) || P.dead) return false;
    return ENC_RUN[enc.kind].use(enc);
  };
  // F 键（附近没有掉落和宝箱时）：3.5 m 内最近的一个
  G.encNearest = function (r) {
    let best = null, bd = r || 3.5;
    for (const enc of state.enc) {
      if (!encUsable(enc)) continue;
      const d = dist(enc.site.x, enc.site.z, P.x, P.z);
      if (d <= bd) (bd = d), (best = enc);
    }
    return best;
  };
  // 点击（main.js）：鼠标落在互动点 1.4 m 内（同宝箱，判定圆往北挪 0.35 m）
  G.encAt = function (wx, wz) {
    let best = null, bd = 1.4;
    for (const enc of state.enc) {
      if (!encUsable(enc)) continue;
      const d = dist(wx, wz, enc.site.x, enc.site.z - 0.35);
      if (d < bd) (bd = d), (best = enc);
    }
    return best;
  };
  G.clickEnc = function (enc) {
    if (!enc || P.dead) return false;
    if (dist(enc.site.x, enc.site.z, P.x, P.z) > 7) {
      toast('走近一点', '#c8b89a', 'far', 900);
      return false;
    }
    return G.encUse(enc);
  };
  // 祈坛「丰饶」：期间击杀的物品 / 通货件数和几率 × loot（只临时放大渊印的 Q 传给 G.dropLoot，宝石不吃 Q 所以不变）
  G.encDropLoot = function (e) {
    const B = P.encBuff && G.SHRINE_BUFFS[P.encBuff.id];
    if (!B || !B.loot) return G.dropLoot(e);
    const RM = G.runMods;
    G.runMods = Object.assign({}, RM, { qty: (1 + RM.qty) * B.loot - 1 });
    try {
      G.dropLoot(e);
    } finally {
      G.runMods = RM;
    }
  };

  // ---------- 拾烬客 ----------
  // 进店时掷一次货架：items 件当前物品等级的装备（部位优先补空着的或物品等级最低的，至少 1 件稀有）、1 颗技能宝石或辅助、
  // 层级 ≥ 2 有几率摆一件渊契（G.relicTraderPick，渊契分支合入后才有）
  G.traderOpen = function (enc) {
    if (!enc.stock) enc.stock = rollStock(enc);
    state.trader = enc;
    if (G.ui && G.ui.open) G.ui.open('trader');
    return enc.stock;
  };
  function rollStock(enc) {
    const T = G.TRADER, save = G.save, lvl = enc.level;
    const want = G.shuffle(G.SLOTS.slice()).sort((a, b) => { // 先洗牌再稳定排序：物品等级一样的部位随机先后
      const ia = save.equip[a] ? save.equip[a].ilvl || 0 : -1, ib = save.equip[b] ? save.equip[b].ilvl || 0 : -1;
      return ia - ib;
    });
    const out = [];
    for (let i = 0; i < T.items; i++) {
      const rar = i === 0 ? 2 : Math.max(1, G.rollRarity(encRm()));
      const item = G.rollItem(lvl, rar, want[i % want.length]);
      out.push({ kind: 'item', item, price: item.rarity >= 2 ? T.price.rare : T.price.magic });
    }
    out.push(Math.random() < 0.5 ? { kind: 'skill', data: pickSkillGem(0.7, true), price: T.price.gem } : { kind: 'support', data: pickSupportGem(0.7), price: T.price.gem }); // 有职业时只摆能用的宝石
    // 另外固定一格辅助宝石（辅助种类多了，support-expand）：和上一格不重样
    let sid = pickSupportGem(0.7);
    for (let k = 0; k < 6 && out[out.length - 1].data === sid; k++) sid = pickSupportGem(0.7);
    out.push({ kind: 'support', data: sid, price: T.price.gem });
    const rq = ENC_RELIC && typeof G.relicTraderPick === 'function' ? G.relicTraderPick() : null;
    if (rq && G.rollRelic) out.push({ kind: 'item', item: G.rollRelic(rq, lvl), price: T.price.relic, relic: true });
    return out;
  }
  G.traderCanPay = function (price) {
    for (const id in price) if ((G.save.cur[id] || 0) < price[id]) return false;
    return true;
  };
  // 买第 i 件：付钱、进背包（宝石照拾取的规则学会 / 升级 / 化尘）。返回 true / 失败原因
  G.traderBuy = function (i) {
    const enc = state.trader, save = G.save;
    const o = enc && enc.stock && enc.stock[i];
    if (!o || o.sold) return 'none';
    if (!G.traderCanPay(o.price)) return 'cost';
    if (o.kind === 'item' && save.bag.length >= BAG_SIZE) return 'bag';
    for (const id in o.price) save.cur[id] -= o.price[id];
    o.sold = true;
    if (o.kind === 'item') {
      save.bag.push(o.item);
      if (o.item.rarity === 3) noteUnique(o.item);
      if (G.ui && G.ui.onPickup) G.ui.onPickup({ kind: 'item', data: o.item }, false);
    } else {
      // 宝石：照地上拾取的规则结算（就地生成一个掉落再拾起，省得再写一遍）
      const l = G.spawnLoot(o.kind, o.data, P.x, P.z);
      l.x = P.x;
      l.z = P.z;
      G.pickup(l);
    }
    G.sfx('pickup');
    G.persist();
    return true;
  };
  // 卖：背包里的一件，按分解的价收（魔法以上再加 1 颗微光尘）
  G.traderSell = function (item) {
    const save = G.save, i = save.bag.indexOf(item);
    if (!state.trader || i < 0 || item.lk) return false; // 锁定的不卖
    save.bag.splice(i, 1);
    const res = G.salvageResult(item);
    if (item.rarity >= 1) res.dust = (res.dust || 0) + 1;
    for (const id in res) grantCurrency(id, res[id]);
    const txt = resultText(res);
    if (txt) toast('卖给拾烬客：' + txt, '#7fe07a');
    G.sfx('pickup');
    G.persist();
    return res;
  };
  // 烛芯 2 换 1（层级 ≥ fragTier，不要钱）：从你最多的其它种类里扣 swap 个，换 1 个 want
  G.traderSwap = function (want) {
    const T = G.TRADER, F = G.save.frags;
    if (!state.trader || !G.FRAGS[want] || !((state.tier || 0) >= T.fragTier)) return false;
    let left = T.swap;
    const plan = {};
    const others = G.FRAG_IDS.filter((id) => id !== want).sort((a, b) => (F[b] || 0) - (F[a] || 0));
    for (const id of others) {
      const k = Math.min(left, (F[id] || 0) - (plan[id] || 0));
      if (k > 0) (plan[id] = (plan[id] || 0) + k), (left -= k);
      if (!left) break;
    }
    if (left > 0) return false;
    for (const id in plan) F[id] -= plan[id];
    F[want] = Math.min(G.FRAG_DROP.max, (F[want] || 0) + 1);
    toast('换得 1 个' + G.FRAGS[want].name, G.FRAGS[want].color);
    G.persist();
    return plan;
  };

  // =====================================================================
  // 余烛殿（熄烛者，巅峰首领，D5）：开启、进场、魂灯、火盆 / 暗潮 / 焰潮 / 重燃、失败退还、掉落
  // 首领的招式在 enemies.js「熄烛者」一节；场地布局和外观在 world.js「区域地形：crown」。
  // 运行时状态 state.pin（不在余烛殿时为 null）：tier / level / lives 魂灯，phase 场地阶段（0 残焰、1 熄灯、2 冠焰），
  //   lit 四个火盆的亮灭、start 这一阶段开始时的亮灭（倒下重生时恢复），tideK 暗潮进度、tideT / snuffT 二阶段的计时（首领读），
  //   relit / relitT 正在重燃的火盆和进度，popT / warnT 三阶段进场的两段计时，burn 外圈起火了没有
  // =====================================================================
  const PINS = G.PIN;
  G.pinOpen = () => (G.save.maxTier || 0) >= PINS.minTier;
  G.pinReady = () => G.FRAG_IDS.every((id) => (G.save.frags[id] || 0) >= 1);
  // 地图页的「点燃」：最高层级 ≥ minTier、四种烛芯各 ≥ 1，扣掉各 1 个进场。返回 { ok, msg }
  G.lightPinnacle = function (tier) {
    const save = G.save;
    tier = toInt(tier, 0, 999, PINS.minTier);
    if (!G.pinOpen()) return { ok: false, msg: '轮回层级 ' + PINS.minTier + ' 起才开放' };
    if (tier < PINS.minTier || tier > save.maxTier) return { ok: false, msg: '只能选层级 ' + PINS.minTier + '–' + save.maxTier };
    if (!G.pinReady()) return { ok: false, msg: '四种烛芯各需要 1 个' };
    for (const id of G.FRAG_IDS) save.frags[id] -= 1;
    G.enterPinnacle(tier);
    return { ok: true };
  };
  function pinRingOff() {
    const S = state.pin;
    if (S && S.ring) {
      G.world.removeTelegraph(S.ring);
      S.ring = null;
      S.ringI = -1;
    }
  }
  // 换区 / 退出时收尾：重燃的进度环、变暗、场地外观
  function pinClear() {
    pinRingOff();
    if (state.pin && G.world.setGloom) G.world.setGloom(null);
    state.pin = null;
  }
  // 进场。resume = 'resume'：读档接着存档里的魂灯数（首领满血、从头打）
  G.enterPinnacle = function (tier, resume) {
    P.graceT = 0;
    resetAction();
    const W = G.world, save = G.save;
    tier = toInt(tier, PINS.minTier, 999, PINS.minTier);
    const r0 = save.run, lives = resume === 'resume' && r0 && r0.pin && r0.pin.tier === tier ? toInt(r0.pin.lives, 1, G.PIN_LIVES, G.PIN_LIVES) : G.PIN_LIVES;
    // 存档：run 挂上 pin（区域 / 层级照旧是进来之前那一区，读档时 main.js 看到 pin 就回余烛殿）；没有渊印
    save.run = { zone: save.lastZone, tier: save.tier, seq: save.sealSeq || 0, seal: null, pin: { tier, lives } };
    save.sealSeq = (save.sealSeq || 0) + 1;
    G.runMods = sealMods(null);
    state.run = { seal: null, mods: G.runMods };
    G.clearEnemies();
    clearProjectiles();
    clearTelegraphs();
    for (const l of state.loot) W.removeMesh(l.mesh);
    state.loot.length = 0;
    state.timers.length = 0;
    if (state.portal) W.removeMesh(state.portal.mesh);
    state.portal = null;
    state.boss = null;
    clearSealFx();
    clearEnc();
    pinClear();
    const level = G.pinLevel(tier);
    state.zone = W.buildZone(G.PINNACLE, level);
    if (W.setGloom) W.setGloom(null);
    state.tier = tier; // 掉落的层级判定按余烛殿的层级；state.zoneIdx 保持原值（G.ZONES 里没有余烛殿）
    const br = state.zone.feats.filter((f) => f.kind === 'brazier').sort((a, b) => a.i - b.i).map((f) => ({ x: f.x, z: f.z }));
    state.pin = {
      tier, level, lives, phase: 0, lit: [1, 1, 1, 1], start: [1, 1, 1, 1], br,
      tideK: 0, tideT: PINS.tide.iv, snuffT: PINS.snuffIv, relit: -1, relitT: 0, ring: null, ringI: -1,
      popT: 0, warnT: 0, burn: false, burnAcc: 0, done: false,
    };
    const bp = state.zone.bossPos;
    const boss = G.spawnBoss('snuffer', bp.x, bp.z, level);
    boss.leash = true;
    boss.pin = true;
    boss.noRage = true; // 40% 狂暴由三阶段代替
    boss.phase = 0;
    boss.encNoLoot = true; // 掉落走 pinKill（§6.6），不走区域首领的那一套
    boss.xpW = 60; // 经验：首领权重 20 × 3

    G.computeStats();
    P.dead = false;
    P.deadT = 0;
    P.cds = {};
    P.roll.cd = 0;
    P.iframe = 0.6;
    P.face = Math.PI;
    P.ent.group.visible = true;
    placePlayer(state.zone.start.x, state.zone.start.z);
    refill();
    resetRanged();
    state.focus = null;
    state.focusT = 0;
    if (G.regroupMinions) G.regroupMinions();
    G.autoSummonDelay();
    if (W.precompile) W.precompile();
    if (W.crownBraziers) W.crownBraziers(state.pin.lit, -1, 0);
    G.persist();
    toast(G.PINNACLE.name + ' · 轮回 ' + tier + '　首领等级 ' + level, '#ffd27a');
    return state.zone;
  };
  const pinHere = () => !!(state.pin && state.zone && state.zone.def.id === G.PINNACLE.id);
  const pinSafe = (S, x, z) => {
    for (let i = 0; i < 4; i++) if (S.lit[i] && dist(x, z, S.br[i].x, S.br[i].z) <= PINS.tide.safe) return true;
    return false;
  };
  G.pinSafeAt = (x, z) => (pinHere() ? pinSafe(state.pin, x, z) : false);
  // 二阶段进场（首领掐灯那一下）：掐灭两个火盆（离玩家近的那两个，逼人挪位），场地变暗
  G.pinEnterDark = function () {
    const S = state.pin;
    if (!pinHere() || S.phase >= 1) return;
    S.phase = 1;
    const order = [0, 1, 2, 3].filter((i) => S.lit[i]).sort((a, b) => dist(P.x, P.z, S.br[a].x, S.br[a].z) - dist(P.x, P.z, S.br[b].x, S.br[b].z));
    for (const i of order.slice(0, Math.min(2, order.length - 1))) pinOut(S, i);
    S.start = S.lit.slice();
    S.tideT = PINS.tide.iv;
    S.snuffT = PINS.snuffIv;
    if (G.world.setGloom) G.world.setGloom(PINS.gloom);
    toast('场地暗了：站在亮着的火盆旁躲暗潮，熄灭的可重新点燃', '#ffd27a', 'pinDark', 4000);
  };
  // 三阶段进场：亮着的火盆炸开（首领那边出预警），popT 秒后全部永久点燃、亮度复原，再出外圈的预警环，warnT 秒后起火
  G.pinEnterCrown = function () {
    const S = state.pin;
    if (!pinHere() || S.phase >= 2) return;
    S.phase = 2;
    S.tideK = 0;
    S.popT = 1.0;
    S.warnT = 0;
    S.start = S.lit.slice();
  };
  G.pinBurnOn = function () {
    const S = state.pin;
    if (!pinHere()) return;
    S.burn = true;
    S.warnT = 0;
    if (G.world.crownBurn) G.world.crownBurn(true);
  };
  function pinOut(S, i) {
    if (!S.lit[i]) return;
    S.lit[i] = 0;
    const b = S.br[i], W = G.world;
    W.burst(b.x, 1.8, b.z, 0x5a5462, 16, 2.5, 0.8);
    W.ring(b.x, b.z, 2.2, 0x9a6ad8, 0.4);
  }
  // 首领每 14 s 冲过去掐灭一个；永远留至少 1 个亮着
  G.pinSnuff = function (i) {
    const S = state.pin;
    if (!pinHere() || S.phase !== 1 || !S.lit[i] || S.lit.reduce((a, b) => a + b, 0) < 2) return false;
    pinOut(S, i);
    if (S.relit === i) S.relit = -1;
    return true;
  };
  // 暗潮结算（首领的 tide 招式到点时调）：不在亮着的火盆 safe 米内的玩家、召唤物都挨一下
  G.pinTideHit = function (e) {
    const S = state.pin;
    if (!pinHere()) return;
    const W = G.world, dmg = e.dmg * PINS.tide.k;
    if (!P.dead && !pinSafe(S, P.x, P.z)) G.hurtPlayer(dmg, 'cold', e);
    for (let j = state.minions.length - 1; j >= 0; j--) {
      const m = state.minions[j];
      if (m && !m.dead && !pinSafe(S, m.x, m.z) && G.hurtMinion) G.hurtMinion(m, dmg * BOSS_VS_MINION, 'cold', e);
    }
    W.shake(0.3);
    W.ring(PINS.arena.x, PINS.arena.z, PINS.arena.r, 0x9a6ad8, 0.4);
    G.sfx('hit');
  };
  // 每个模拟步（world.js 的 ZONE_TERRAIN.crown.tick 调）：重燃、三阶段进场的计时、外圈灼烧，把状态交给外观
  G.pinTick = function (dt) {
    if (!pinHere()) return;
    const S = state.pin, W = G.world, A = PINS.arena, RL = PINS.relight, wall = PINS.braziers.wall;
    // 重燃：二阶段里站在熄灭的火盆 r 米内（从火盆台边量）t 秒
    let near = -1;
    if (S.phase === 1 && !P.dead && !S.done) {
      for (let i = 0; i < 4; i++) if (!S.lit[i] && dist(P.x, P.z, S.br[i].x, S.br[i].z) <= wall + RL.r) near = i;
    }
    if (near >= 0 && near === S.relit) S.relitT += dt;
    else {
      S.relit = near;
      S.relitT = near >= 0 ? dt : 0;
    }
    if (S.relit >= 0 && S.relitT >= RL.t) {
      const b = S.br[S.relit];
      S.lit[S.relit] = 1;
      W.burst(b.x, 1.8, b.z, 0xffc060, 28, 6, 0.6);
      W.ring(b.x, b.z, PINS.tide.safe, 0xffc870, 0.5);
      G.sfx('pickup');
      S.relit = -1;
      S.relitT = 0;
    }
    if (S.relit >= 0) {
      if (!S.ring || S.ringI !== S.relit) {
        pinRingOff();
        const b = S.br[S.relit];
        S.ring = W.makeTelegraph({ shape: 'circle', x: b.x, z: b.z, r: wall + RL.r }, true);
        S.ringI = S.relit;
      }
      S.ring.setProgress(S.relitT / RL.t);
    } else pinRingOff();
    // 三阶段：炸完全部点燃、亮度复原，再出外圈预警环（没有主人，首领被打出破绽也照常走完）
    if (S.popT > 0) {
      S.popT -= dt;
      if (S.popT <= 0) {
        S.lit = [1, 1, 1, 1];
        S.start = S.lit.slice();
        if (W.setGloom) W.setGloom(null);
        S.warnT = PINS.burnWarn;
        G.telegraph({ shape: 'ring', x: A.x, z: A.z, r: PINS.burnOut, rin: PINS.burnIn, dur: PINS.burnWarn, dmg: 0, dtype: 'fire', owner: null, friendly: false });
      }
    } else if (S.warnT > 0) {
      S.warnT -= dt;
      if (S.warnT <= 0) G.pinBurnOn();
    }
    // 焰潮：外圈 burnIn..burnOut 每 burnTick 秒灼烧一次（同地形灼烧：G.TERRAIN.burn × dmgScale）
    if (S.burn && !P.dead && !S.done) {
      const d = dist(P.x, P.z, A.x, A.z);
      if (d > PINS.burnIn && d <= PINS.burnOut + 0.6) {
        S.burnAcc += dt;
        if (S.burnAcc >= G.TERRAIN.burnTick) {
          S.burnAcc -= G.TERRAIN.burnTick;
          G.hurtPlayer(G.TERRAIN.burn * G.dmgScale(S.level), 'fire', null);
        }
      } else S.burnAcc = 0;
    }
    if (W.crownBraziers) W.crownBraziers(S.lit, S.relit, S.relit >= 0 ? S.relitT / RL.t : 0);
    if (W.crownTide) W.crownTide(S.tideK, S.phase === 1 && !S.done ? (S.tideK > 0 ? 1 : 0.42) : 0);
  };
  // 倒下（G.respawn 开头调）：熄一盏魂灯；第 G.PIN_LIVES 次倒下算失败（退还烛芯、回到地图），返回 true 表示已经处理完、不在这里重生
  G.pinDeath = function () {
    const S = state.pin;
    if (!pinHere() || S.done) return false;
    S.lives = Math.max(0, S.lives - 1);
    if (G.save.run && G.save.run.pin) G.save.run.pin.lives = S.lives;
    if (S.lives <= 0) {
      G.pinFail();
      return true;
    }
    // 重生在场地门外，首领保留生命和阶段；火盆回到这一阶段开始时的样子，二阶段的计时重来
    S.lit = S.start.slice();
    S.relit = -1;
    S.relitT = 0;
    S.tideK = 0;
    S.tideT = PINS.tide.iv;
    S.snuffT = PINS.snuffIv;
    pinRingOff();
    G.persist();
    toast('一盏魂灯熄灭了（还剩 ' + S.lives + ' 盏）', '#ffd27a');
    return false;
  };
  // 魂灯燃尽：四个烛芯里随机退还 G.PIN_REFUND 个（不同种类），回到进来之前那一区、打开地图
  G.pinFail = function () {
    const save = G.save, ids = G.FRAG_IDS.slice();
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = ids[i];
      ids[i] = ids[j];
      ids[j] = t;
    }
    const back = ids.slice(0, Math.max(0, Math.min(ids.length, G.PIN_REFUND)));
    for (const id of back) save.frags[id] = Math.min(G.FRAG_DROP.max, (save.frags[id] || 0) + 1);
    state.stats.pinFails = (state.stats.pinFails || 0) + 1;
    state.pinRefund = back.slice(); // 界面 / 测试读
    save.run = null;
    pinClear();
    G.enterZone(save.lastZone, save.tier);
    toast('魂灯燃尽。退还了 ' + back.map((id) => '「' + G.FRAGS[id].name + '」').join(''), '#ffd27a');
    if (G.ui && G.ui.open) G.ui.open('map');
  };
  // 击杀（killEnemy 的首领分支）：首杀记录、掉落（§6.6）、传送门；场地熄火亮灯
  G.pinKill = function (e) {
    const save = G.save, W = G.world, S = state.pin, D = G.RELIC_DROP.pinnacle;
    const first = !save.bossKills.snuffer;
    if (first) {
      save.bossKills.snuffer = true;
      toast('首次击败「' + e.name + '」：获得 2 点天赋点', '#ffd75e');
    } else toast('「' + e.name + '」已被击败', '#ffb46a');
    const PK = save.pinnacle;
    const ilvl = Math.max(1, e.level), x = e.x, z = e.z;
    for (let i = 0; i < 3; i++) G.spawnLoot('item', G.rollItem(ilvl, 2), x, z);
    for (const id of ['exalt', 'exalt', 'divine']) G.spawnLoot('cur', id, x, z);
    for (let i = 0; i < 3; i++) G.spawnLoot('cur', G.rollCurrency(), x, z);
    G.spawnLoot('blank', { lvl: gemLevel() }, x, z);
    for (let i = 0; i < 2; i++) G.spawnLoot('support', pickSupportGem(i ? 0.7 : 1), x, z);
    // 巅峰渊契：首杀必掉；之后 chance、连续 pity 次没掉下一次必掉。两件里还没拾到过的优先，都拾到过就各半
    let pid = null;
    if (PK.kills === 0 || PK.pity >= D.pity || Math.random() < D.chance) {
      PK.pity = 0;
      const miss = G.RELIC_PINNACLE.filter((id) => !save.relic.found[id]);
      pid = G.pick(miss.length ? miss : G.RELIC_PINNACLE);
      relicSpawn(pid, ilvl, x, z);
    } else PK.pity++;
    if (Math.random() < D.normal) relicSpawn(G.pick(G.RELIC_IDS), ilvl, x, z);
    lampDrop(ilvl, x, z);
    PK.kills++;
    state.stats.pinKills = (state.stats.pinKills || 0) + 1;
    state.pinLast = { relic: pid, first };
    if (S) {
      S.done = true;
      S.burn = false;
      S.tideK = 0;
      pinRingOff();
      S.lit = [1, 1, 1, 1];
      if (W.crownBurn) W.crownBurn(false);
      if (W.setGloom) W.setGloom(null);
    }
    if (save.run) save.run.pin = null; // 打完了：读档不再回余烛殿
    for (let i = state.projectiles.length - 1; i >= 0; i--) if (state.projectiles[i].owner === 'e') removeProjectile(i);
    if (!state.portal) {
      const bp = state.zone.bossPos;
      state.portal = { x: bp.x, z: bp.z, mesh: W.makePortal(bp.x, bp.z), armed: dist(P.x, P.z, bp.x, bp.z) > 3.5 };
    }
    G.sfx('boss');
    G.persist();
  };

  // =====================================================================
  // 主线（quest D1，设计稿 game-workspace/notes/quest-design）
  // =====================================================================
  // 只读现有进度（cleared / lastZone / tier）和「走到首领场地门口」，不加新事件。推进时不取随机数、不改任何模拟用到的状态：
  // 奖励直接加进 save.cur，提示交给界面层排队（G.ui.questDone）。固定种子的仗打出来和没有主线时逐位相同
  const questFns = [];
  // D3 的挂钩：首领步在这次游戏里真正完成时（不是读档推算出来的）调 fn({ step, id, zone, live: true })。
  // 放过旁白后调 G.questTell(id) 记进 save.quest.told，G.questTold(id) 读
  G.onQuest = (fn) => {
    if (typeof fn === 'function') questFns.push(fn);
  };
  G.questTell = (id) => {
    const Q = G.save.quest;
    if (Q && G.QUEST.some((q) => q.id === id)) Q.told[id] = true;
  };
  G.questTold = (id) => !!(G.save.quest && G.save.quest.told[id]);
  // 下一步（0 起）；主线走完 = G.QUEST_N
  G.questStep = () => (G.save.quest ? G.save.quest.n : G.QUEST_N);
  // 第 1 步：在灰烬荒原走到首领场地门口（和「前方是首领竞技场」提示同一个判定）。只读，不分配
  function questGate() {
    return !!(state.zone && state.zoneIdx === 0 && !state.pin && !P.dead && G.world.nearArena(P.x, P.z));
  }
  // live：这次游戏里真的做到了（进区、首领倒下、走到门口）→ 推进并发奖励；不是 live（读档）只推进。
  // 推算（questDerive）早在读档时并进 n 了，所以这里发的只会是读档之后新完成的步骤。返回这次推进了几步
  G.questSync = function (live) {
    const save = G.save, Q = save.quest;
    if (!Q || Q.n >= G.QUEST_N) return 0;
    let n = Math.max(Q.n, questDerive(save));
    if (n === 0 && live && questGate()) n = 1;
    const from = Q.n;
    if (n <= from) return 0;
    Q.n = n;
    if (!live) return 0;
    const got = {};
    let any = false;
    for (let k = from; k < n; k++) {
      const rw = G.QUEST[k].rw;
      if (!rw) continue;
      for (const id in rw) {
        save.cur[id] = (save.cur[id] || 0) + rw[id];
        got[id] = (got[id] || 0) + rw[id];
        any = true;
      }
    }
    G.persist(); // 马上存：走到门口这一步没有别的存档痕迹，不等 10 秒自动存档，关页面后不会再给一次
    if (G.ui && G.ui.questDone) G.ui.questDone(n, any ? got : null);
    for (let k = from; k < n; k++) {
      const q = G.QUEST[k];
      if (q.kind !== 'boss') continue;
      for (const fn of questFns) {
        try {
          fn({ step: k + 1, id: q.id, zone: q.zone, live: true });
        } catch (err) {
          if (window.console) console.error(err);
        }
      }
    }
    return n - from;
  };
  // 模拟里每 0.5 秒（游戏时间）查一次第 1 步；其余步骤都由事件推进（G.enterZone、首领倒下）
  let questT = 0;
  G.updateQuest = function (dt) {
    const Q = G.save.quest;
    if (!Q || Q.n !== 0) return;
    questT += dt;
    if (questT < 0.5) return;
    questT = 0;
    if (questGate()) G.questSync(true);
  };

  // =====================================================================
  // 区域
  // =====================================================================
  // seal（可选）：这次进区的渊印（择印面板选的那一枚，见 G.rollSeals）；'resume' = 读档时接着存档里的那一次
  // （区域 / 层级对得上才接着用，否则当素印重进）。不带 = 素印：没有任何印纹效果（测试和层级 0 都走这里）
  G.enterZone = function (idx, tier, seal) {
    P.graceT = 0;
    resetAction(); // 顿帧 / 慢动作 / 处决 / 缓冲的输入都不带进下一个区域
    const W = G.world;
    const save = G.save;
    idx = toInt(idx, 0, G.ZONES.length - 1, 0);
    tier = toInt(tier, 0, 999, 0);
    const def = G.ZONES[idx];
    // 渊印：先定下这一次的印纹（刷怪时就要读）。真正新进一次区 sealSeq +1（择印面板的种子随之换掉）
    let run = null;
    if (seal === 'resume') {
      const r = save.run;
      run = r && r.zone === idx && r.tier === tier && !r.pin ? r : null; // 挂着余烛殿的那一次不接着用（main.js 读档时先看 pin）
    }
    if (!run) {
      run = { zone: idx, tier, seq: save.sealSeq || 0, seal: seal && seal !== 'resume' ? G.cleanSeal(seal, tier, save.bar) : null };
      save.sealSeq = (save.sealSeq || 0) + 1;
    }
    save.run = run;
    G.runMods = sealMods(run.seal);
    state.run = { seal: run.seal, mods: G.runMods };

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

    clearSealFx();
    pinClear(); // 从余烛殿出来：收掉重燃环、变暗
    const level = def.level + tier * G.TIER_LEVELS;
    state.zone = W.buildZone(def, level);
    if (W.setGloom) W.setGloom(G.runMods.gloom || null); // 渊印「幽晦」：雾和暖光收近；不是幽晦就复位
    state.zoneIdx = idx;
    state.tier = tier;
    G.spawnZoneMobs(state.zone);
    const te = performance.now();
    G.rollEncounters(state.zone, tier); // 异兆：只选址（道具和怪都懒生成），刷完怪之后才掷，进区时的怪物列表不变
    state.zone.ms.enc = performance.now() - te;

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
    G.questSync(true); // 主线：进区步、进轮回层级（lastZone / tier 刚写入）
    G.persist();
    toast(def.name + (tier > 0 ? ' · 轮回 ' + tier : '') + '　怪物等级 ' + level, '#ffb46a');
    return state.zone;
  };
})();
