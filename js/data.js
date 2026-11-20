'use strict';
// 静态数据：技能、辅助宝石、词缀、装备基底、通货、天赋盘、区域、怪物
(function () {
  const G = (window.G = {});

  G.rand = (a, b) => a + Math.random() * (b - a);
  G.randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  G.pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  G.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  G.weighted = function (arr, wf) {
    let total = 0;
    for (const a of arr) total += wf(a);
    let r = Math.random() * total;
    for (const a of arr) {
      r -= wf(a);
      if (r <= 0) return a;
    }
    return arr[arr.length - 1];
  };

  // 混沌（chaos）：伤害提高 = 伤害提高 + 元素伤害提高（只算一次）+ 火焰 / 冰霜 / 闪电三项各自的提高 + 混沌伤害提高，
  // 总额外只吃 moreChaos，不吃「元素过载」的 moreElem（见 game.js 的 skillCtx）。混沌不是元素：G.ELEMS 里没有它
  G.TYPES = ['phys', 'fire', 'cold', 'light', 'chaos'];
  G.TYPE_NAME = { phys: '物理', fire: '火焰', cold: '冰霜', light: '闪电', chaos: '混沌' };
  G.TYPE_COLOR = { phys: '#e6dfd0', fire: '#ff8a3c', cold: '#86d8ff', light: '#ffe45e', chaos: '#ff6ad2' };
  G.TYPE_HEX = { phys: 0xe6dfd0, fire: 0xff7a2c, cold: 0x7fd4ff, light: 0xffe45e, chaos: 0xe0279f };
  G.CAP = { phys: 'Phys', fire: 'Fire', cold: 'Cold', light: 'Light', chaos: 'Chaos' };

  G.TAG_NAME = {
    attack: '攻击', spell: '法术', melee: '近战', projectile: '投射物', area: '范围',
    chaining: '连锁', phys: '物理', fire: '火焰', cold: '冰霜', light: '闪电', movement: '位移',
    minion: '召唤物', summon: '召唤', aura: '光环', weapon: '武器技', chaos: '混沌', duration: '持续',
  };

  // ---------- 武器伤害 ----------
  // 攻击技能（带 attack 标签）的伤害来自手里的武器：每一击 = 武器伤害 × 技能的武器倍率 wm × (1 + ATTACK_GEM_LVL × (宝石等级 − 1))，
  // 出手速度再乘上武器的攻击速度（有冷却的攻击技能——闪袭——攻速改为乘在每一击的伤害上，见 G.cdAps）。法术和召唤不看武器伤害。
  // 武器基础伤害 = 基底的 1 级伤害 × (1 + WEAPON_LVL × (物品等级 − 1))，再乘一个 0.9–1.1 的成色。
  // 攻击技能的成长几乎全在武器上（宝石等级只给一点点）：拿着当前区域物品等级的武器、宝石在成长下限时，
  // 两者相乘和改版前「宝石每级 +20%」的曲线贴得很近（角色 1–27 级都在 ±5% 以内）。起手的 1 级刃（8–12）× 裂石击 1.25 = 改版前的 10–15
  G.WEAPON_LVL = 0.12;
  // 武器伤害按物品等级一直线性成长到这么高（轮回层级 2 的物品等级到 48，层级 3 到 64；再往上不再提高）。
  // 改版前到 27 就封顶了：WEAPON_LVL_OLD_CAP 只用于修旧存档（见 game.js 的 fixItem）
  G.WEAPON_LVL_CAP = 80;
  G.WEAPON_LVL_OLD_CAP = 27;
  G.ATTACK_GEM_LVL = 0.012;
  G.FISTS = { min: 2, max: 4, aps: 1 }; // 空手

  // ---------- 远程武器：量表 ----------
  // 拿着枪械或弓时右键是这把武器的普攻（G.rangedWeapon()），R 被量表卡住：满了（max）才亮，放出去清零。
  // 热度（枪械）：开火时上涨（每种普攻的 heat / heatShot），最近 hitKeep 秒内没打中任何东西时只涨 miss 倍（对着空地预热很慢）；
  //   停火 hold 秒后每秒回落 decay。没有过热惩罚。
  // 专注（弓）：普攻的箭每命中一次 +hit，暴击 × crit，离你 farD 米以外命中 × far；一支箭最多算 cap 次命中（贯穿进怪堆不会一下灌满）；
  //   你每挨一下 −hurt；hold 秒没有命中后每秒回落 decay；增益生效期间不涨。按发积攒的量（专注、左轮的热度）除以出手速度倍率：射得快不等于 R 来得快。
  // 节奏（平衡机器人量过）：持续作战时第一次 R 在 11–16 秒，枪械之后每 12–16 秒一次；弓的增益 8 秒里专注不涨，一轮约 18–22 秒。
  // 远距离：命中点离你 farMin 米以内不算远，到 farMax 米算满（鹰眼的额外伤害、rangeDmg 都按这个比例）
  G.RANGED = {
    max: 100,
    heat: { hold: 1.5, decay: 6, miss: 0.5, hitKeep: 1.0 },
    focus: { hit: 2.5, crit: 1.6, far: 1.5, farD: 8, cap: 3, hurt: 5, hold: 8, decay: 3 },
    farMin: 4, farMax: 14,
  };
  G.GAUGE_NAME = { heat: '热度', focus: '专注' };
  // 技能页上「武器普攻」卡的 id：辅助宝石镶在 save.sockets[G.BASIC_CARD] 里，换武器时不动（每种武器的普攻都用这张卡）
  G.BASIC_CARD = 'wbasic';
  // 旧存档里长弓（下标 5）的三个名字：读档时换成鹰眼长弓的同阶名字
  G.BOW_OLD_NAMES = ['榆木长弓', '筋角长弓', '渊鸣长弓'];
  // 冰弓（type 'emberbow'）第三阶原来叫「烬铸长弓」（和烬铸稀有度、烬铸左轮撞名，又带火味），改叫「凛晶长弓」。
  // 旧存档读档时按位置换成同阶的新名字（见 game.js 的 fixItem）；前两阶没改名，照抄
  G.EMBERBOW_OLD_NAMES = ['霜木长弓', '寒羽长弓', '烬铸长弓'];
  // ---------- 主动技能 ----------
  // 每个技能的打击手感：w 分量（0 轻 / 1 重 / 2 终结），kb 击退距离（世界单位，按怪物体重折算），
  // poise 每次命中削掉的架势。近战削得最多，法术次之。
  // 攻击技能没有自己的伤害区间：wm 是武器倍率（见上面的「武器伤害」），法术 / 召唤照旧用 dmg
  G.SKILLS = {
    // 裂石击（cleave）已删除：近战的三段连击改成每种武器右键的武器普攻（见下面的「武器普攻」）。
    // 旧存档里学过的裂石击读档时退成一颗同等级的无铭技能宝石（见 game.js 的 sanitize），连击的机制（combo）留给武器普攻用。
    ember: {
      name: '掷焰', icon: '焰', color: '#ff8a3c', tags: ['spell', 'projectile', 'area', 'fire'], kind: 'proj',
      dmg: { fire: [11, 17] }, time: 0.5, mana: 6, cd: 0, speed: 22, explode: 1.9, projR: 0.32, w: 0, kb: 0.45, poise: 10,
      desc: '掷出火团，命中后小范围爆炸。',
    },
    blade: {
      name: '飞刃', icon: '刃', color: '#cfd6e6', tags: ['attack', 'projectile', 'phys'], kind: 'proj',
      wm: 1.0, time: 0.36, mana: 4, cd: 0, speed: 28, pierce: 2, projR: 0.28, w: 0, kb: 0.35, poise: 8,
      desc: '掷出旋转利刃，穿透 2 个敌人。',
    },
    // 光环：放在技能栏任意一格上就常驻生效，不用按键。reserve 保留最大魔力的百分比（乘上所镶辅助的消耗倍率：节流降低，迅捷 / 扩域等抬高）；
    // time 是两次脉冲的间隔（受出手速度与迅捷影响），每次脉冲对 radius 以内（吃范围加成）的所有敌人造成一小下冰霜伤害。
    // 伤害本身很低，主要价值是不断累积冰霜异常值
    nova: {
      name: '霜环', icon: '霜', color: '#86d8ff', tags: ['spell', 'area', 'cold', 'aura'], kind: 'aura',
      dmg: { cold: [3.2, 4.8] }, time: 0.5, mana: 0, reserve: 25, cd: 0, radius: 4.5, w: 0, kb: 0, poise: 0,
      desc: '光环：身边一圈寒气定时刺痛所有敌人，伤害低，但持续累积冰霜异常值，冰缓乃至冻结。',
    },
    arc: {
      name: '链雷', icon: '雷', color: '#ffe45e', tags: ['spell', 'chaining', 'light'], kind: 'chain',
      dmg: { light: [6, 22] }, time: 0.5, mana: 8, cd: 0, chain: 3, range: 15, w: 0, kb: 0.25, poise: 8,
      desc: '电弧击中准星附近的敌人，连锁 3 次。',
    },
    meteor: {
      name: '陨火', icon: '陨', color: '#ff5a2c', tags: ['spell', 'area', 'fire'], kind: 'meteor',
      // 冷却 + 延迟落地（会被走开躲掉）：每一次的伤害要明显高过主力技能，穿插着放才划算
      dmg: { fire: [56, 78] }, time: 0.6, mana: 22, cd: 5, radius: 3.6, delay: 0.75, range: 15, w: 2, kb: 2.4, poise: 45,
      desc: '在准星处召下陨石，短暂延迟后落地，造成巨量火焰伤害。',
    },
    blink: {
      name: '闪袭', icon: '闪', color: '#c7a6ff', tags: ['attack', 'melee', 'area', 'phys', 'movement'], kind: 'blink',
      // 有冷却：每一下的伤害按「穿插在主力技能之间」来定，单独按冷却循环打不过主力技能
      wm: 3.6, time: 0.2, mana: 10, cd: 3.5, radius: 3.0, range: 10, w: 2, kb: 1.8, poise: 30, stop: 80,
      desc: '瞬移到准星处，重砸落点周围的敌人。',
    },
    whirl: {
      name: '旋风斩', icon: '旋', color: '#e8c9a0', tags: ['attack', 'melee', 'area', 'phys'], kind: 'spin',
      // 持续施放：按住时原地旋转，每 time 秒（受出手速度影响）对身边一圈造成一次伤害、扣一次魔力。
      // radius 半径；move 旋转中的移动速度倍率；kb 击退（顺着旋转方向带一下，不把敌人推出圈外）；stop 每跳的顿帧毫秒数
      wm: 0.8, time: 0.3, mana: 2, cd: 0, radius: 3.0, move: 0.6, w: 0, kb: 0.18, poise: 6, stop: 12,
      desc: '按住旋转，斩击身边一圈敌人，每下耗少量魔力。松手、翻滚或施放别的技能即停。', alt: '旋转时可以慢慢走动。',
    },
    shadestep: {
      name: '影步连斩', icon: '影', color: '#9fb4ff', tags: ['attack', 'melee', 'area', 'phys', 'movement'], kind: 'flicker',
      // 持续施放：按住时自动瞬移到身边 range 以内（走得过去的）敌人旁边斩一刀，再闪向下一个。
      // 每 time 秒一刀（受出手速度影响），每刀扣一次魔力；radius 是每一刀波及目标周围的半径（吃范围加成）；
      // lead 闪现到落地出刀之间的秒数（第一刀 / 之后每一刀），闪现期间无敌，出刀那一刻不无敌；stop 每刀的顿帧毫秒数
      wm: 0.6, time: 0.18, mana: 2, cd: 0, range: 8, radius: 1.6, lead: [0.08, 0.1], move: 0, w: 0, kb: 0.25, poise: 9, stop: 25,
      desc: '按住自动闪到附近敌人身边斩击，逐个连闪，波及目标身边的敌人。闪现瞬间无敌；遇到破绽敌人直接处决。', alt: '优先砍准星附近、这一轮还没砍过的敌人。落地出刀时不无敌。每刀消耗少量魔力。松手、翻滚、施放别的技能或附近没有敌人时停下。',
    },
    // 召唤：按键开关自动召唤（在玩家身边补到上限），Shift + 按键在准星处（最远 range，落在可走的地面上）手动唤起召唤物。召唤物不吃玩家自己的伤害属性，
    // 只按宝石等级、「召唤物」类属性（minionDmg / minionLife / minionSpeed / minionCap）和镶在这个技能上的辅助宝石成长。
    // dmg：召唤物每一击的基础伤害；life：基础生命；rate：两次出手的间隔（秒）；cap：数量上限；
    // reach：近战够得着的距离（到目标边缘）；cleave / arc：仆从横斩额外带到的敌人数与扇面角度；move：移动速度；dr：自带的伤害减免（%）；kb / poise / w：每一击的击退、削架势、分量
    thrall: {
      name: '烬骸仆从', icon: '骸', color: '#4fe3c8', tags: ['spell', 'minion', 'summon', 'phys'], kind: 'summon', minion: 'thrall',
      dmg: { phys: [11, 15] }, time: 0.6, mana: 12, cd: 0, range: 6,
      cap: 3, life: 54, rate: 0.8, reach: 0.9, move: 7.4, dr: 0, w: 0, kb: 0.1, poise: 3,
      cleave: 4, arc: 160, // 横斩：身前 160° 扇面里贴着的敌人再带到至多 4 个
      inherit: 1, // 继承武器伤害 / 装备生命时的系数（见 game.js 的 G.minionInherit）
      hold: 2, // 同时最多牵制 2 只小怪（守像 4 只）；被围满后其余的怪会去找玩家
      desc: '召唤烬骸仆从：迅捷的骸骨剑士，横斩身前的敌人，优先攻击你最近打中的目标。上限 3 具。', alt: '手动召唤时数量已满，替换受伤最重的那具。',
    },
    colossus: {
      name: '石誓守像', icon: '像', color: '#c9a86a', tags: ['spell', 'minion', 'summon', 'phys', 'area'], kind: 'summon', minion: 'colossus',
      dmg: { phys: [24, 36] }, time: 1.0, mana: 30, cd: 6, range: 6,
      cap: 1, life: 220, rate: 2.5, reach: 1.6, move: 4.4, dr: 25, w: 1, kb: 1.1, poise: 9,
      radius: 3.2, // 砸地半径（受扩域影响）
      inherit: 2.4, // 出手慢、一击重：继承的武器伤害与装备生命按 2.4 倍计
      hold: 4,
      // 首领被嘲讽的秒数原来是 0.8：首领几乎从不看守像一眼，招式全砸在玩家（站在后排的召唤师）身上，召唤师打首领反倒最容易死。
      // 和小怪一样 3 秒之后，首领每 7 秒里有 3 秒冲着守像去（招式照放，只是对准守像）
      taunt: { cd: 7, r: 6, dur: 3, boss: 3 }, // 嘲讽：冷却、半径、小怪被嘲讽的秒数、首领被嘲讽的秒数
      desc: '立起石誓守像：定时砸地伤害一圈敌人，不时嘲讽周围的敌人（含首领）。只能有 1 尊。', alt: '手动召唤时，已有的那尊在新位置重铸。',
    },
    // 焚骨祭司：法师召唤物。站在前排身后 keep 米左右（离玩家不超过 CHASE 的范围），每 rate 秒朝怪最密的地方掷一枚焚骨火弹（cast：射程，到目标边缘），
    // 火弹飞行 speed、碰到敌人或到达落点在 explode 半径内炸开（吃扩域）。每个被炸到的敌人给它攒 1 点焰蓄（一弹最多 charge.per），
    // 攒满 charge.max 放一次大招：目标身边（meteor.r 内）至少 meteor.min 个敌人时召下「坠焰」（延迟 meteor.delay 后落在最密处，半径 meteor.radius、mult 倍一击），
    // 否则对目标（首领 / 精英 / 集火目标优先）引导「灼链」：dur 秒、每 tick 秒一跳、每跳 mult 倍。
    // 身子骨很脆：没有减伤、生命很低；敌人贴到 flee 米以内时先往玩家那边退开再施法。
    // 数量上限只吃镶在它身上的「群聚」，不吃天赋 / 护符的「仆从数量」。继承武器伤害时，施法武器（杖 / 短杖 / 魂幡）按 casterInherit 倍计
    pyre: {
      name: '焚骨祭司', icon: '焚', color: '#ff9a4a', tags: ['spell', 'minion', 'summon', 'fire', 'projectile', 'area'], kind: 'summon', minion: 'pyre',
      dmg: { fire: [10, 15] }, time: 0.8, mana: 22, cd: 0, range: 6,
      cap: 2, life: 30, rate: 1.3, reach: 10, keep: 7, flee: 3.2, move: 6.6, dr: 0, w: 0, kb: 0.6, poise: 6, ailment: 20,
      speed: 17, explode: 2.1,
      charge: { per: 3, max: 7 },
      meteor: { min: 3, r: 3.4, radius: 3.4, delay: 0.85, mult: 3.2, kb: 2.2, poise: 22, w: 2 },
      beam: { dur: 2.2, tick: 0.2, mult: 0.42, poise: 3 },
      inherit: 1, casterInherit: 2.2,
      hold: 1,
      desc: '召唤焚骨祭司：在后排朝怪最密处掷火弹，攒满焰蓄放大招。很脆。上限 2 位，只有镶在它身上的群聚能多唤一位。', alt: '敌人贴近会退开。每炸到一个敌人攒一点焰蓄。大招：怪多时召坠焰砸向最密的一团，单个强敌（首领、精英、你的集火目标）用灼链持续灼烧。天赋与装备的仆从数量不加祭司。拿着杖、短杖或魂幡时继承的武器伤害更多。',
    },

    // ---------- 混沌技能（混沌流） ----------
    // 混沌吃三种元素伤害提高的总和，基础伤害按同类元素技能的 0.75 倍定：专门堆混沌的角色在 20 / 40 级和堆单一元素的角色秒伤持平。
    // 前期（宝石等级 15 以内）装备还堆不出三份元素加成：chaosEarly 的技能按 G.chaosEarlyK 再乘一点，1 级相当于 0.95 倍，到 15 级收回 0.75 倍
    // 黑洞：在准星处（最远 range，撞墙截在墙前）撕开 dur 秒的黑洞，每 tick 秒对 radius 以内的敌人造成一跳伤害；
    //   pullR × radius 以内的敌人被往中心拽：速度 pull × (0.6 + 0.4 × 越靠近中心越快) / √体重，首领固定 bossPull，离中心 core 以内不再拽。
    //   同一个敌人同一时刻只吃一个黑洞的跳（渊口的小黑洞也算）。持续类法术：回响镶不上
    blackhole: {
      name: '黑洞', icon: '洞', color: '#ff6ad2', tags: ['spell', 'area', 'chaos', 'duration'], kind: 'hole',
      dmg: { chaos: [3.9, 5.8] }, chaosEarly: true, time: 0.5, mana: 20, cd: 6, range: 14,
      radius: 3.2, pullR: 1.35, dur: 3, tick: 0.25, pull: 4.5, bossPull: 0.5, core: 0.7,
      w: 0, kb: 0, poise: 2, useMult: 12,
      desc: '在准星处撕开黑洞 3 秒，把周围敌人拽向中心并持续造成混沌伤害。越轻拽得越狠，首领几乎拽不动。',
    },
    // 黑旋风（第三轮改）：每次施放放出 count 团又快又小的漩涡（多重投射再加），扇形每团隔 spread°，路线带一点随机的摆动（wander 弧度 / 秒）。
    //   碰到敌人就吸附 latch.t 秒（贴着它不走），期间把 latch.r 以内的小怪往漩涡拽（latch.pull / √体重，首领只挪 latch.bossPull），松开后接着飞。
    //   半径 radius 以内的敌人每 tick 秒挨一跳；撞上真墙 / 悬崖按法线反弹（最多 bounce 次，再撞就散），寿命 life 秒。
    //   上限：同一次施放对同一个敌人每 tick 秒最多一跳；被这次施放吸附过的敌人一共最多 cap 跳，只是被拽过来、卷到的最多 splashCap 跳，首领 bossCap 跳；每团最多吸附 latch.max 次，同一个敌人 latch.again 秒内不再吸。
    //   贯穿：前 N 个敌人不吸附，直接穿过（照样挨跳）；连锁：每次松开后拐向 hop.r 米内这一团还没吸过的最近敌人（每拐一次消耗 1 次）
    vortex: {
      name: '黑旋风', icon: '涡', color: '#ff6ad2', tags: ['spell', 'projectile', 'area', 'chaos'], kind: 'vortex',
      // cd 1 秒（用户定：没有冷却太强）：一秒最多放一次，伤害不补，空出来的时间穿插别的技能
      dmg: { chaos: [3.1, 4.85] }, chaosEarly: true, time: 0.55, mana: 9, cd: 1,
      count: 3, speed: 14, life: 2.2, radius: 0.9, spread: 13, wander: 1.6,
      latch: { t: 0.4, r: 2.4, pull: 4.5, bossPull: 0.3, max: 3, again: 0.8 },
      bounce: 4, tick: 0.2, cap: 3, splashCap: 2, bossCap: 4, hop: { r: 7 },
      // useMult：单体小怪每次施放实测平均 2.9 跳（chaos-tools/fx-hits.mjs，5 个种子共 112 次）；每跳伤害按「平均每跳 × 跳数」和第二轮的 4.6 × 2.5 相同定
      w: 0, kb: 0, poise: 3, useMult: 2.9,
      desc: '放出三团飘忽的小黑旋风：吸附在敌人身上片刻，把周围小怪拽来一起绞，持续造成混沌伤害；撞墙反弹。',
    },
    // 黑焰：光环（buff：不脉冲、自己不造成伤害）。你和召唤物的每一击额外造成 F% 的混沌伤害，
    //   F = min(cap, k0 + k1 × (宝石等级 − 1)) × (1 + 黑焰效果%)，40 级（宝石 30）约 13%，37 级宝石封顶 15%；和注入一样按加成之后、暴击之前的伤害折算（相加，不再吃混沌加成）。
    //   爆燃 / 电弧这类触发伤害与霜环的脉冲不带黑焰。只能镶节流
    blackflame: {
      name: '黑焰', icon: '冥', color: '#e04cc0', tags: ['spell', 'aura', 'chaos'], kind: 'aura', buff: true,
      mana: 0, reserve: 35, cd: 0, time: 1, w: 0, kb: 0, poise: 0,
      flame: { k0: 6, k1: 0.25, cap: 15 },
      desc: '光环：你和召唤物的每一击附带一缕黑焰，造成该击一定比例的额外混沌伤害。只能镶节流。',
    },

    // ---------- 武器技（R 键）：每种武器自带一个，跟着手里的武器走 ----------
    // weaponOnly：不掉落、不进技能页的普通列表、镶不了辅助宝石、不占技能栏的 4 格。wtype 是对应的武器类型。
    // 攻击型（带 attack）按武器伤害 × wm 成长（等级 = 宝石的成长下限，只给一点点加成），出手节奏不吃武器攻速；
    // 法术型（长杖 / 短杖）用 edmg 作基础伤害，等级 = 武器物品等级 × 0.75，元素取你元素伤害加成最高的那一种（并列时取 elem）。
    // wt：phases 各段生效的时刻（第一段扣消耗、进冷却），cancel 之后可以接别的动作，dur 自然收招；都按秒，受出手速度影响。
    // useMult：一次施放里同一个目标平均吃到的倍率总和（技能卡 / 秒伤估算用；avgHit 返回的是「每次施放」对单体的伤害）。
    // move：施放途中的移动速度倍率。冷却技能每次的伤害按「穿插在主力技能之间额外多出 20–35% 秒伤」来定
    riposte: {
      name: '回锋斩', icon: '回', color: '#f0e2c4', tags: ['weapon', 'attack', 'melee', 'area', 'phys'], kind: 'wblade', weaponOnly: true, wtype: 'blade',
      wm: 2.2, time: 0.58, mana: 6, cd: 4, w: 1, kb: 1.0, poise: 16, move: 0.2,
      wt: { phases: [0.16, 0.4], cancel: 0.58, dur: 0.72, clip: { dur: 0.69 } }, // clip：动作时长 / 命中帧对到的时刻（缺省第一段），让回身横扫的姿势落在第二段
      // 先突刺：朝准星踏出 lunge，贯穿身前 len × width 的一条直线（撞墙截断）；再回身横扫身边一整圈
      thrust: { mult: 1.0, len: 5.5, width: 1.4, lunge: 1.0, kb: 1.0, poise: 16, stop: 50, w: 1 },
      sweep: { mult: 1.6, range: 3.4, kb: 1.6, poise: 26, stop: 90, w: 2 },
      useMult: 2.6,
      desc: '朝准星突刺贯穿一条直线，随即回身横扫一圈。',
    },
    leyburst: {
      name: '地脉涌', icon: '涌', color: '#ffb07a', tags: ['weapon', 'spell', 'area'], kind: 'wstaff', weaponOnly: true, wtype: 'staff',
      edmg: [48, 72], elem: 'fire', time: 0.55, mana: 12, cd: 6, radius: 5.2, ailment: 60, w: 1, kb: 1.4, poise: 22, move: 0.3,
      wt: { phases: [0.38], cancel: 0.55, dur: 0.7 },
      useMult: 1,
      desc: '顿地炸开一圈地脉之力，属性取你加成最高的元素，大幅累积该元素异常值。不穿墙。',
    },
    arcvolley: {
      name: '秘弹连射', icon: '弹', color: '#c9b4ff', tags: ['weapon', 'spell', 'projectile'], kind: 'wwand', weaponOnly: true, wtype: 'wand',
      edmg: [7.5, 11.5], elem: 'light', time: 0.45, mana: 10, cd: 5, n: 5, gap: 0.09, speed: 21, projR: 0.26, range: 18, seek: 6, turn: 9, explode: 1.8,
      w: 0, kb: 0.3, poise: 6, move: 0.5,
      wt: { phases: [0.2], cancel: 0.45, dur: 0.6 },
      useMult: 5,
      desc: '连射 5 枚追踪秘弹，飞向准星附近的敌人，命中后小范围炸开。属性取你加成最高的元素。', alt: '有多个敌人时轮流分配。秘弹撞墙即散。',
    },
    shadowstab: {
      name: '影刺', icon: '刺', color: '#a9a2ff', tags: ['weapon', 'attack', 'melee', 'phys', 'movement'], kind: 'wdaggers', weaponOnly: true, wtype: 'daggers',
      wm: 3.85, time: 0.34, mana: 6, cd: 4, range: 8, radius: 1.4, w: 2, kb: 1.2, poise: 30, stop: 90, iframe: 0.3, move: 0,
      wt: { phases: [0.06, 0.16], cancel: 0.34, dur: 0.45, clip: { dur: 0.55, at: 0.16 } }, // 动作的命中帧是刺出那一下
      useMult: 1, sureCrit: true, // 必定暴击
      desc: '闪到准星附近敌人身后刺击，必定暴击，波及身边的敌人。闪现瞬间无敌。', alt: '目标要在 8 格以内、中间没有墙；附近没有目标时不会施放。',
    },
    quake: {
      name: '震地', icon: '震', color: '#d8b07a', tags: ['weapon', 'attack', 'melee', 'area', 'phys'], kind: 'whammer', weaponOnly: true, wtype: 'hammer',
      wm: 6.0, time: 0.85, mana: 8, cd: 6, len: 9, w0: 2.0, w1: 5.5, reach: 1.4, slamR: 2.2, wave: 28, w: 2, kb: 3.2, poise: 60, stop: 110, move: 0.1,
      wt: { phases: [0.5], cancel: 0.85, dur: 1.0 },
      useMult: 1,
      desc: '砸地放出冲击波，朝准星推进、越远越宽，震飞沿途敌人并大量削减架势。遇墙即止。',
    },
    flashcut: {
      name: '瞬断', icon: '断', color: '#e8f0ff', tags: ['weapon', 'attack', 'melee', 'phys', 'movement'], kind: 'wkatana', weaponOnly: true, wtype: 'katana',
      wm: 6.9, time: 0.26, mana: 8, cd: 6, range: 8, width: 1.0, dash: 0.14, delay: 0.35, w: 2, kb: 1.0, poise: 40, stop: 100, move: 0,
      wt: { phases: [0.08], cancel: 0.26, dur: 0.4, clip: { dur: 0.75, at: 0.22 } }, // 命中帧对到冲刺结束，收刀的一甩正好对上斩开
      useMult: 1,
      desc: '朝准星疾冲（途中无敌，遇墙即停），约 0.35 秒后斩开沿途所有敌人，伤害极高。',
    },
    // 魂潮：召唤型。asMinion：伤害按召唤物算——dmg 是每只魂火的基础伤害，等级 = 武器物品等级 × 0.75，每级 +MINION_DMG_LVL，
    // 只吃召唤物伤害（minionDmg / minionMore），不吃你自己的伤害属性、暴击与「万骸之主」的减伤。
    // n 只魂火，每隔 gap 秒放出一只，飞向准星附近（seek 以内）的敌人，碰到就在 explode 半径内炸开；life 秒内没碰到就消散。
    // frenzy：同时让所有召唤物狂热 dur 秒，攻击与移动速度 ×(1 + k)
    soultide: {
      name: '魂潮', icon: '潮', color: '#4fe3c8', tags: ['weapon', 'spell', 'minion', 'projectile'], kind: 'wbanner', weaponOnly: true, wtype: 'banner', asMinion: true,
      dmg: { phys: [17, 24] }, time: 0.5, mana: 14, cd: 8, n: 4, gap: 0.07, speed: 17, projR: 0.3, life: 1.5, range: 16, seek: 6, turn: 11, explode: 1.6,
      w: 0, kb: 0.5, poise: 8, move: 0.4,
      frenzy: { dur: 4, k: 0.3 },
      wt: { phases: [0.28], cancel: 0.5, dur: 0.62 },
      useMult: 4,
      desc: '放出 4 只魂火扑向准星附近的敌人，伤害按召唤物计算。同时令召唤物狂热 4 秒：攻击与移动速度 +30%。',
    },

    // ---------- 远程武器（枪械 / 弓）：右键 = 武器普攻，R = 量表技 ----------
    // 右键固定是手里这把武器的普攻（basic: true，id 为 basic_<武器类型>；近战 / 施法 / 魂幡 / 空手的见下面一节）：不掉落、不进技能栏，技能页上是一张「武器普攻」卡，
    // 3 个辅助孔属于卡片本身（save.sockets[G.BASIC_CARD]），换武器时宝石不动，只按当前普攻的标签生效。
    // 普攻按武器伤害 × wm 成长（等级 = 宝石的成长下限），出手节奏乘武器攻速与出手速度，不消耗魔力。
    // time：两发之间的秒数（机炮是转满之后的最快间隔；喷枪是两跳之间）；draw：弓第一箭的拉弓时间；
    // heat：枪械每秒开火增加的热度（左轮按发：heatShot），见 G.RANGED。conv：伤害转换（{ 元素: 比例 }，'rune' = 符文弓按元素加成取元素）
    basic_gatling: {
      name: '开火', icon: '射', color: '#ffc46a', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'gatling', weaponOnly: true, basic: true,
      // spin：枪管空转多久才开火；rate0：刚转起来时的射速比例，ramp 秒后到最快；spread：弹道散布（度）
      // pierce：每发子弹自带穿透 1 个敌人（扫怪群时打得到后排）
      wm: 0.7, time: 0.083, mana: 0, cd: 0, spin: 0.5, rate0: 0.4, ramp: 2.5, speed: 42, projR: 0.18, range: 18, spread: 4, pierce: 1,
      heat: 6.5, move: 0.35, w: 0, kb: 0.06, poise: 4, addEff: 0.25,
      desc: '按住右键：空转约 0.5 秒后开火，射速渐快，子弹穿透 1 个敌人。开火时移动很慢。', alt: '约 2.5 秒射速最快。每发削不少架势。装备附加伤害按 25% 计。',
    },
    basic_flamer: {
      name: '开火', icon: '焰', color: '#ff8a3c', tags: ['attack', 'area', 'fire'], kind: 'rbasic', rtype: 'flamer', weaponOnly: true, basic: true,
      // 身前 range 半径、arc 度的扇面，每 time 秒一跳；ember：每 gap 秒在火舌尽头留下一团余烬（半径 r、持续 dur 秒、每 tick 秒对里面的敌人造成 mult 倍伤害，
      // 同一个敌人站在几团余烬里也只按一团算）
      wm: 0.45, time: 0.1, mana: 0, cd: 0, range: 5.5, arc: 60, conv: { fire: 1 }, ailment: 50,
      ember: { gap: 0.3, r: 1.5, dur: 2.5, tick: 0.5, mult: 0.3 },
      heat: 6.5, move: 0.55, w: 0, kb: 0, poise: 2, addEff: 0.3, // 火舌不推人：一秒十跳，推开了就喷不到了
      desc: '按住右键喷火，灼烧身前短扇面内的敌人，异常值累积快，地上留下燃烧的余烬。', alt: '纯火焰伤害。装备附加伤害按 30% 计。',
    },
    basic_revolver: {
      name: '开火', icon: '射', color: '#ffd28a', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'revolver', weaponOnly: true, basic: true,
      // clip 发一轮，打空后 reload 秒自动装填
      wm: 1.05, time: 0.27, mana: 0, cd: 0, clip: 6, reload: 0.6, speed: 46, projR: 0.2, range: 20,
      heatShot: 2.4, move: 0.8, w: 0, kb: 0.35, poise: 9, stop: 12, addEff: 0.75,
      desc: '右键开枪：单发伤害高，可边走边打，每 6 发自动装填。', alt: '装备附加伤害按 75% 计。',
    },
    basic_huntbow: {
      name: '射击', icon: '矢', color: '#bfe8a0', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'huntbow', weaponOnly: true, basic: true,
      // seek：箭会拐向身边 seek 米内的敌人，turn 每秒最多转的弧度；pierce：自带穿透 1 个敌人，穿过之后重新找下一个猎物（见 afterPlayerHit）
      wm: 0.9, time: 0.38, mana: 0, cd: 0, draw: 0.12, speed: 30, projR: 0.24, range: 22, seek: 7, turn: 7, pierce: 1,
      move: 0.6, w: 0, kb: 0.3, poise: 6,
      desc: '右键射箭：箭会拐向附近的敌人，命中后穿过去追下一个。暴击和远距离命中积攒更多专注。',
    },
    basic_eagle: {
      name: '射击', icon: '矢', color: '#e8f0d0', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'eagle', weaponOnly: true, basic: true,
      // critFlat / critMulti：普攻自带的暴击率与暴击伤害；far：距离 G.RANGED.farMax 以外命中时额外的伤害（之间按距离线性）
      wm: 1.0, time: 0.48, mana: 0, cd: 0, draw: 0.16, speed: 40, projR: 0.22, range: 26, critFlat: 12, critMulti: 50, far: 0.35,
      move: 0.5, w: 0, kb: 0.5, poise: 9,
      desc: '右键射箭：暴击率与暴击伤害很高，越远伤害越高。暴击和远距离命中积攒更多专注。',
    },
    basic_runebow: {
      name: '射击', icon: '矢', color: '#c9a6ff', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'runebow', weaponOnly: true, basic: true,
      // conv 'rune'：convK 的伤害转成你元素伤害加成最高的那种元素（都没有加成时火 / 冰 / 雷轮流）
      // chain：符文箭命中后弹向附近另一个敌人一次（打怪群时元素异常铺得开）
      wm: 1.15, time: 0.4, mana: 0, cd: 0, draw: 0.13, speed: 32, projR: 0.24, range: 22, conv: 'rune', convK: 0.6, ailment: 40, chain: 1,
      move: 0.6, w: 0, kb: 0.3, poise: 6,
      desc: '右键射箭：箭带元素，异常值累积快，命中后再弹向另一个敌人一次。', alt: '元素取你元素伤害加成最高的一种；没有加成时火、冰、雷轮流。',
    },
    basic_emberbow: {
      name: '射击', icon: '矢', color: '#9fd8ff', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'emberbow', weaponOnly: true, basic: true,
      // spark：每支箭命中后迸出一枚冰晶，跳向 r 米内最近的另一个敌人，最多跳 n 次，每跳 mult 倍伤害（全部转为冰霜）
      wm: 1.1, time: 0.42, mana: 0, cd: 0, draw: 0.13, speed: 34, projR: 0.24, range: 22, spark: { n: 2, r: 6, mult: 0.35 },
      move: 0.6, w: 0, kb: 0.3, poise: 7,
      desc: '右键射箭：命中后迸出冰晶，在附近敌人间连跳 2 次，造成冰霜伤害。',
    },

    // ---------- 武器普攻（近战 / 施法 / 召唤 / 空手）：每种武器的右键 ----------
    // 和枪械、弓一样：右键固定是手里这把武器的普攻（id 为 basic_<武器类型>，空手是 basic_fists），不耗魔力、不掉落、不占技能栏，
    // 辅助宝石镶在同一张「武器普攻」卡上（按这招的标签生效）。btype：对应的武器类型（'fists' = 空手）。
    // 近战的普攻是连招（combo，机制和原来裂石击的三段连击是同一套）：按住右键或连点接下一段，停手约 0.55 秒（收招之后）、翻滚或放别的技能就从头再来。
    //   每段的字段同原来的裂石击：clip 动作、time 多久之后能接下一段、hit 命中时刻、tail 收招、mult 倍率、lunge 踏步、stop 顿帧、w 分量；
    //   shape：'arc' 扇形（range / arc / dir）、'smash' 身前砸地的圆（reach / range）、'line' 身前一条直线（len 长、width 宽）；
    //   dash：这一段命中时朝准星冲过 dash 米（撞墙截断），冲过的整条路都算 line 的范围；cross：扇形画成交叉的两道；
    //   wave：砸地之后再荡开的一圈冲击波（r 半径、mult 倍率，已经被砸到的不再吃）。
    //   time（整招的平均段长）、comboAvg / comboStop 在下面统一算。单体秒伤定在同一把武器配原来裂石击的 0.8 倍左右（四种近战武器按武器秒伤对齐到 ±1%；刃的连招和旋风斩单体持平），
    //   不比各流派的主力技能强（旋风斩持平、影步连斩略低），打怪群更差：是不耗魔力的稳定输出，不是主力
    basic_blade: {
      name: '挥斩', icon: '斩', color: '#e6dfd0', tags: ['attack', 'melee', 'area', 'phys'], kind: 'melee', btype: 'blade', weaponOnly: true, basic: true,
      wm: 0.97, mana: 0, cd: 0, range: 3.4, arc: 120,
      combo: [
        { clip: 'attack1', time: 0.34, hit: 0.15, tail: 0.14, mult: 0.85, shape: 'arc', range: 3.3, arc: 120, dir: 1, lunge: 0.6, kb: 0.5, poise: 12, stop: 30, w: 0 },
        { clip: 'attack2', time: 0.34, hit: 0.15, tail: 0.14, mult: 0.9, shape: 'arc', range: 3.4, arc: 120, dir: -1, lunge: 0.6, kb: 0.6, poise: 14, stop: 35, w: 0 },
        { clip: 'b_thrust', time: 0.54, hit: 0.22, tail: 0.22, mult: 1.85, shape: 'line', len: 4.6, width: 1.4, lunge: 1.2, kb: 2.0, poise: 30, stop: 80, w: 2 },
      ],
      desc: '右键连招：横斩、回斩，第三下突刺终结，贯穿一条直线并顶飞敌人。',
    },
    basic_daggers: {
      name: '连刺', icon: '刺', color: '#bdb6ff', tags: ['attack', 'melee', 'area', 'phys'], kind: 'melee', btype: 'daggers', weaponOnly: true, basic: true,
      wm: 0.85, mana: 0, cd: 0, range: 2.8, arc: 60,
      combo: [
        { clip: 'b_stabR', time: 0.2, hit: 0.08, tail: 0.1, mult: 0.6, shape: 'line', len: 2.8, width: 1.1, lunge: 0.35, kb: 0.2, poise: 6, stop: 18, w: 0 },
        { clip: 'b_stabL', time: 0.2, hit: 0.08, tail: 0.1, mult: 0.6, shape: 'line', len: 2.8, width: 1.1, lunge: 0.35, kb: 0.2, poise: 6, stop: 18, w: 0 },
        { clip: 'b_stabR', time: 0.22, hit: 0.08, tail: 0.1, mult: 0.7, shape: 'line', len: 2.9, width: 1.1, lunge: 0.4, kb: 0.25, poise: 7, stop: 20, w: 0 },
        { clip: 'b_cross', time: 0.42, hit: 0.17, tail: 0.2, mult: 1.6, shape: 'arc', range: 3.0, arc: 170, dir: 1, cross: true, lunge: 0.6, kb: 1.2, poise: 22, stop: 70, w: 2 },
      ],
      desc: '右键连招：左右快刺三下，第四下交叉横斩终结，扫开身前一片。出手极快。',
    },
    basic_hammer: {
      name: '重击', icon: '锤', color: '#d8b07a', tags: ['attack', 'melee', 'area', 'phys'], kind: 'melee', btype: 'hammer', weaponOnly: true, basic: true,
      wm: 1.19, mana: 0, cd: 0, range: 3.6, arc: 140,
      combo: [
        { clip: 'attack1', time: 0.52, hit: 0.26, tail: 0.2, mult: 1.0, shape: 'arc', range: 3.6, arc: 140, dir: 1, lunge: 0.5, kb: 1.0, poise: 22, stop: 55, w: 1 },
        { clip: 'attack2', time: 0.52, hit: 0.26, tail: 0.2, mult: 1.1, shape: 'arc', range: 3.6, arc: 140, dir: -1, lunge: 0.5, kb: 1.1, poise: 24, stop: 60, w: 1 },
        { clip: 'b_slam', time: 0.78, hit: 0.38, tail: 0.3, mult: 2.2, shape: 'smash', range: 2.4, reach: 2.0, lunge: 0.8, kb: 2.6, poise: 55, stop: 110, w: 2,
          wave: { r: 4.4, mult: 0.6, kb: 1.6, poise: 20 } },
      ],
      desc: '右键连招：两记抡锤，第三下砸地终结，并荡开一圈冲击波。出手慢，大量削减架势。',
    },
    basic_katana: {
      name: '拔刀', icon: '拔', color: '#e8f0ff', tags: ['attack', 'melee', 'area', 'phys', 'movement'], kind: 'melee', btype: 'katana', weaponOnly: true, basic: true,
      wm: 0.95, mana: 0, cd: 0, range: 3.3, arc: 120,
      combo: [
        { clip: 'b_iai', time: 0.3, hit: 0.1, tail: 0.14, mult: 0.95, shape: 'arc', range: 3.3, arc: 120, dir: -1, lunge: 0.4, kb: 0.4, poise: 12, stop: 35, w: 0 },
        { clip: 'attack1', time: 0.32, hit: 0.14, tail: 0.14, mult: 0.85, shape: 'arc', range: 3.2, arc: 110, dir: 1, lunge: 0.4, kb: 0.5, poise: 12, stop: 35, w: 0 },
        { clip: 'flicker', time: 0.5, hit: 0.14, tail: 0.26, mult: 1.8, shape: 'line', dash: 3.5, len: 0, width: 1.3, lunge: 0, kb: 0.8, poise: 28, stop: 85, w: 2 },
      ],
      desc: '右键连招：出鞘横斩、反手回刀，第三下朝准星冲斩 3.5 米，斩到沿途敌人。',
    },
    basic_fists: {
      name: '拳击', icon: '拳', color: '#f0d6b8', tags: ['attack', 'melee', 'phys'], kind: 'melee', btype: 'fists', weaponOnly: true, basic: true,
      wm: 0.87, mana: 0, cd: 0, range: 2.4, arc: 80,
      combo: [
        { clip: 'b_jabL', time: 0.24, hit: 0.09, tail: 0.12, mult: 0.8, shape: 'arc', range: 2.4, arc: 70, dir: 1, lunge: 0.3, kb: 0.3, poise: 6, stop: 22, w: 0 },
        { clip: 'b_jabR', time: 0.24, hit: 0.09, tail: 0.12, mult: 0.8, shape: 'arc', range: 2.4, arc: 70, dir: -1, lunge: 0.3, kb: 0.3, poise: 6, stop: 22, w: 0 },
        { clip: 'b_hook', time: 0.46, hit: 0.2, tail: 0.22, mult: 1.9, shape: 'arc', range: 2.6, arc: 100, dir: 1, lunge: 0.7, kb: 2.0, poise: 24, stop: 80, w: 2 },
      ],
      desc: '空手右键连招：两记刺拳，接一记打飞敌人的重拳。',
    },
    // 施法武器的普攻：法术（spell），不看武器伤害。edmg 是基础伤害，等级 = 武器物品等级 × 0.75（和法术型武器技一样），每级 +20%；
    // 元素取你火 / 冰 / 雷里伤害加成最高的那一种（并列时取 elem；不取混沌），吃法术的伤害提高、施法速度和镶着的法术辅助。
    // 单体秒伤约是同等级掷焰的六成：一直按着不耗蓝，打不过主力技能
    // vk：投射物外形（world 的 PF_DRAW）；cyc：出手节奏（按住 / 连点一段接一段，停手约 0.55 秒、翻滚或放别的技能从第一段起，
    //   和近战连招共用 P.combo 的计数，但不是连招：走路、可取消的时刻照普通施法），每段 clip 出手动作、time 段长（再除以施法速度）、
    //   hit 生效时刻占段长的比例（缺省 0.5）、mult 这一下的倍率。time / comboAvg（平均段长 / 平均倍率）在下面统一算，秒伤估算用
    // 灵弹：两枚小灵弹接一枚蓄力的重弹（heavy：飞得慢、个头大、炸得大），重弹炸开时按这一下的元素追加 burst 里那一种：
    //   fire 火：重弹本身改成 ×orb，脚下留一片燃地（r、dur 秒，每 tick 秒 ×tickMult；站着不动的目标正好补回 ×1.8）；
    //   cold 冰：n 根冰棱从爆心往外飞 len 米（×mult，只打爆炸没炸到的、每个敌人至多一根），炸到的敌人再灌 chill 的冰缓；
    //   light 雷：电弧弹向爆炸圈外 r 米内最近的 n 个敌人（×mult）。打单体三种元素一样，追加的部分只在怪群里多出伤害
    basic_staff: {
      name: '灵弹', icon: '弹', color: '#ffb07a', tags: ['spell', 'projectile', 'area'], kind: 'proj', btype: 'staff', weaponOnly: true, basic: true, elemHex: true, vk: 'lbolt', bclip: 'b_staffA',
      edmg: [8, 12], elem: 'fire', mana: 0, cd: 0, speed: 20, explode: 1.4, projR: 0.3, w: 0, kb: 0.5, poise: 9,
      cyc: [
        { clip: 'b_staffA', time: 0.45, mult: 0.7 },
        { clip: 'b_staffB', time: 0.45, mult: 0.7 },
        { clip: 'b_staffH', time: 0.85, hit: 0.62, mult: 1.8, heavy: true, speed: 14, projR: 0.45, explode: 2.4, vk: 'lbolt3', kb: 1.6, poise: 24 },
      ],
      burst: {
        fire: { orb: 1.5, r: 1.8, dur: 1.5, tick: 0.3, tickMult: 0.06 },
        cold: { n: 4, len: 4, speed: 16, mult: 0.45, chill: 0.2 },
        light: { n: 2, r: 6, mult: 0.5 },
      },
      desc: '右键三下一轮：两枚灵弹，第三枚蓄力重弹（×1.8）大范围炸开，按元素追加：火留燃地，冰溅冰棱，雷弹向 2 个敌人。属性取你加成最高的元素。',
      alt: '停手约半秒、翻滚或施放别的技能后从第一下重来。火的重弹本身 ×1.5，燃地烧 1.5 秒；冰棱 4 根，只打爆炸圈外的敌人，炸到的敌人被冰缓；电弧打爆炸圈外 6 米内最近的 2 个（各 ×0.5）。',
    },
    // 疾咒：左右手交替甩出咒光（cyc 两段只是换手），弹向旁边 chain 个敌人；每次命中给目标叠 1 层咒痕（mark：最多 max 层、dur 秒不再叠就消失），
    // 叠到 max 的那一下引爆：它和 r 米内所有带咒痕的敌人各挨「每层 ×mult」，咒痕清空。打单体每 5 下：5 × 0.75 + 5 × 0.25 = 平均每下 ×1
    basic_wand: {
      name: '疾咒', icon: '咒', color: '#c9b4ff', tags: ['spell', 'chaining'], kind: 'chain', btype: 'wand', weaponOnly: true, basic: true, elemHex: true, bclip: 'b_wandL',
      edmg: [5, 8.5], elem: 'light', mana: 0, cd: 0, chain: 1, range: 14, w: 0, kb: 0.2, poise: 5,
      cyc: [
        { clip: 'b_wandL', time: 0.34, mult: 0.75 },
        { clip: 'b_wandR', time: 0.34, mult: 0.75 },
      ],
      mark: { max: 5, dur: 4, mult: 0.25, r: 8 },
      desc: '右键左右甩出咒光，再弹向 1 个敌人；每次命中叠 1 层咒痕，叠满 5 层引爆，附近带咒痕的敌人一起炸开。属性取你加成最高的元素。',
      alt: '咒光每下 ×0.75，引爆每层 ×0.25。咒痕 4 秒不再叠就消失；引爆波及 8 米内带咒痕的敌人，没有咒痕的不挨。',
    },
    // 魂幡的普攻：asMinion（同魂潮）——伤害按召唤物算，只吃召唤物伤害加成和镶着的召唤物辅助，等级 = 武器物品等级 × 0.75。
    // 放出一缕魂灵扑向准星附近（seek 以内）的敌人，碰到就炸开（explode），并把那个敌人标成集火目标（召唤物优先去打它）。
    // perMinion：你每有一只活着的召唤物，这一下的伤害提高这么多（最多 maxMinion 只）；没有召唤物时照样能打
    basic_banner: {
      name: '魂引', icon: '引', color: '#4fe3c8', tags: ['spell', 'minion', 'projectile'], kind: 'bspirit', btype: 'banner', weaponOnly: true, basic: true, asMinion: true, bclip: 'b_point',
      dmg: { phys: [11, 15] }, time: 0.5, mana: 0, cd: 0, speed: 15, projR: 0.3, life: 1.4, range: 15, seek: 5, turn: 11, explode: 1.6,
      perMinion: 8, maxMinion: 5, w: 0, kb: 0.4, poise: 6,
      noSup: ['ossify', 'horde', 'frenzy'], // 只作用于召唤物本身（生命、数量、速度）的辅助对这一缕魂灵没用，不让镶
      desc: '右键放出魂灵扑向准星附近的敌人，碰到即炸，召唤物集火它。每有一只召唤物伤害 +8%（最多 5 只）。', alt: '伤害按召唤物计算。',
    },

    // R（量表技）：rgauge 为 true——没有冷却、不扣魔力，量表满了才能放，放出去量表清零。枪械的三招按武器伤害成长（吃「热度技伤害」），
    // 弓的四招是限时增益（buff.dur 秒，吃「增益持续时间」）
    meltray: {
      name: '熔光射线', icon: '光', color: '#ffb36a', tags: ['weapon', 'attack', 'fire', 'light'], kind: 'rgatling', weaponOnly: true, wtype: 'gatling', rgauge: true,
      // 按住 R 蓄力（瞄准线跟着准星），松手放出一道贯穿射线：长 len、宽 width 的直线上所有敌人挨一下（一半火焰一半闪电）。
      // 伤害按机炮普攻折算（basicOf / basicSec，见 game.js 的 G.basicShots）：蓄满一发 = 机炮转满之后扫射 basicSec 秒——
      //   普攻每发的武器伤害 × 普攻 wm、装备附加 × 普攻 addEff，乘上这几秒的发数（武器攻速、攻击速度算在内，辅助宝石不算），
      //   再按射线自己的伤害加成、暴击和「热度技伤害」结算。wm 只是标明这是攻击技能，实际倍率由折算决定。
      //   原来是 wm 40 × 一发的武器伤害：附加伤害只算一份、攻速不算，越往后越不值得放（蓄力加机炮重新转起来要停火约 3.5 秒）
      // 蓄力 charge 秒满；伤害按蓄力程度 minK → 1；蓄满后再按住 hold 秒自动放出。蓄力时移动速度 × move
      wm: 1, basicOf: 'basic_gatling', basicSec: 8, time: 0.3, mana: 0, cd: 0, charge: 1.4, hold: 1.0, minK: 0.3, len: 24, width: 2.4, beamT: 0.4, conv: { fire: 0.5, light: 0.5 }, ailment: 100,
      w: 2, kb: 1.4, poise: 80, stop: 120, move: 0.35,
      wclip: 'r_gatling',
      wt: { phases: [0.3], cancel: 9, dur: 9, clip: { dur: 3.2, at: 0.3 } }, // 时长由蓄力自己管（起手 0.3 秒 + 蓄力 + 射线）
      useMult: 1, // 一次施放对单体就是一击（倍率已经折算进伤害里）
      desc: '按住 R 蓄力（1.4 秒蓄满），松手放出熔光射线，贯穿一条直线并重重击退。蓄满约等于机炮满速扫射 {basicSec} 秒。', alt: '伤害一半火焰、一半闪电，同时累积两种异常值。蓄力越久伤害越高；蓄满后再按住 1 秒自动放出。伤害随武器、附加伤害与攻击速度成长。',
    },
    firestorm: {
      name: '焚天炎爆', icon: '爆', color: '#ff6a2c', tags: ['weapon', 'attack', 'area', 'fire'], kind: 'rflamer', weaponOnly: true, wtype: 'flamer', rgauge: true,
      // 半径 radius 的火浪（全部火焰）；之后留下半径 burn.r 的火场，burn.dur 秒内每 burn.tick 秒一跳。
      // 伤害和熔光射线一样按普攻折算（basicOf / basicSec，见 game.js 的 G.basicShots）：火浪 = 喷枪持续喷射 basicSec 秒，
      //   火场每一跳 = 喷射 burn.sec 秒（不算余烬）；整招单体 = 3.3 + 10 × 0.23 ≈ 5.6 秒。原来是火浪 wm 14、每跳 1 倍武器伤害：
      //   装备附加只算一份、攻速不算，40 级时放一发只比一直喷多赚约 1.5 秒普攻（镶了辅助只剩 0.5 秒）
      wm: 1, basicOf: 'basic_flamer', basicSec: 3.3, time: 0.75, mana: 0, cd: 0, radius: 7.5, conv: { fire: 1 }, ailment: 100, burn: { r: 6, dur: 5, tick: 0.5, sec: 0.23 },
      w: 2, kb: 2.6, poise: 70, stop: 110, move: 0.1,
      wclip: 'r_flamer',
      wt: { phases: [0.42], cancel: 0.75, dur: 0.9 },
      // 单体整招按火浪那一击的倍数计：火浪 1 击 + 火场 10 跳 × (0.23 / 3.3) ≈ 1.7（G.SKILLS 定义完之后按 burn.sec 重算一遍）
      useMult: 1.7,
      desc: '排空热度，以你为中心炸开巨大火浪，震退周围敌人，留下 5 秒火场。总伤害约等于喷枪持续喷射 {basicSec} 秒。', alt: '伤害随武器、附加伤害与攻击速度成长。',
    },
    wildfire: {
      name: '乱射', icon: '乱', color: '#ffcf7a', tags: ['weapon', 'attack', 'projectile', 'phys'], kind: 'rrevolver', weaponOnly: true, wtype: 'revolver', rgauge: true, uskill: true,
      // dur 秒里每 gap 秒朝 range 米内的敌人开一枪：在最近的 spread 个敌人之间轮流点射，没有敌人时朝四周乱射；期间照常走动、不会被打断
      // 每发子弹贯穿 pierce 个敌人，命中处炸开半径 splash.r 的弹片，波及周围其他敌人（splash.mult 倍，不伤被打中的那个）
      wm: 0.5, time: 0.2, mana: 0, cd: 0, dur: 3, gap: 0.07, range: 13, speed: 46, projR: 0.2, spread: 8, pierce: 1, splash: { r: 2, mult: 0.45 },
      w: 0, kb: 0.25, poise: 5, move: 1,
      wclip: 'r_revolver',
      wt: { phases: [0.08], cancel: 0.15, dur: 0.2, clip: { dur: 3, at: 0.08 } },
      useMult: 18,
      desc: '3 秒内朝身边最多 8 个敌人轮流扫射，每发贯穿 1 个，弹片波及周围。可边走边打，不会被打断。',
    },
    volley: {
      name: '万矢', icon: '矢', color: '#bfe8a0', tags: ['weapon', 'attack'], kind: 'rbuff', weaponOnly: true, wtype: 'huntbow', rgauge: true,
      // split：每支箭分成几支追踪箭，每支 mult 倍伤害；fan：散开的角度
      buff: { dur: 8, split: 5, mult: 0.4, fan: 50 },
      time: 0.4, mana: 0, cd: 0, w: 0, kb: 0, poise: 0, move: 0.5,
      wclip: 'r_huntbow',
      wt: { phases: [0.22], cancel: 0.4, dur: 0.5 },
      useMult: 0,
      desc: '8 秒内每支箭分裂成 5 支追踪箭（每支 40% 伤害）。',
    },
    pierceheart: {
      name: '一矢穿心', icon: '穿', color: '#e8f4ff', tags: ['weapon', 'attack'], kind: 'rbuff', weaponOnly: true, wtype: 'eagle', rgauge: true,
      buff: { dur: 8, crit: 100, pierce: 99 },
      time: 0.4, mana: 0, cd: 0, w: 0, kb: 0, poise: 0, move: 0.5,
      wclip: 'r_eagle',
      wt: { phases: [0.22], cancel: 0.4, dur: 0.5 },
      useMult: 0,
      desc: '8 秒内每支箭必定暴击，并贯穿所有敌人。',
    },
    overflow: {
      name: '元素满溢', icon: '溢', color: '#c9a6ff', tags: ['weapon', 'attack'], kind: 'rbuff', weaponOnly: true, wtype: 'runebow', rgauge: true,
      // 箭的伤害全部转成元素，火 → 冰 → 雷轮流；异常累积 × ailment；每次命中在目标处炸开半径 burst.r、burst.mult 倍伤害的同元素小爆炸
      buff: { dur: 8, ailment: 2, burst: { r: 2.2, mult: 0.4 } },
      time: 0.4, mana: 0, cd: 0, w: 0, kb: 0, poise: 0, move: 0.5,
      wclip: 'r_runebow',
      wt: { phases: [0.22], cancel: 0.4, dur: 0.5 },
      useMult: 0,
      desc: '8 秒内箭矢化为元素（火、冰、雷轮流），异常值累积翻倍，命中处炸开同元素小爆炸。',
    },
    emberstorm: {
      name: '凛冬', icon: '凛', color: '#9fd8ff', tags: ['weapon', 'attack', 'cold'], kind: 'rbuff', weaponOnly: true, wtype: 'emberbow', rgauge: true, uskill: true,
      // fan：每次射出几支箭（各 mult 倍伤害）；spark：冰晶改为跳 n 次、每跳 mult 倍；blast：被箭或冰晶打死的敌人碎成冰爆（半径 r、mult 倍冰霜伤害）
      buff: { dur: 8, fan: 3, mult: 0.75, spread: 16, spark: { n: 4, mult: 0.45 }, blast: { r: 3, mult: 0.6 } },
      time: 0.4, mana: 0, cd: 0, w: 0, kb: 0, poise: 0, move: 0.5,
      wclip: 'r_emberbow',
      wt: { phases: [0.22], cancel: 0.4, dur: 0.5 },
      useMult: 0,
      desc: '8 秒内每次射出 3 支寒冰箭，冰晶连跳 4 次、伤害更高；被它们打死的敌人碎成一圈冰爆。',
    },

    // ---------- 烬铸技：拿着烬铸武器时，R 上的武器技换成它专属的这一招（G.weaponSkill 按 G.UNIQUES[..].uskill 换） ----------
    // uskill：烬铸技（界面上带余烬框 / 余烬光）；replaces：它顶替的那个普通武器技。比普通武器技强、更花哨，冷却也长得多。
    // 千刃归烬（太刀）：在附近的敌人之间连闪至多 hops 次（每次闪 dash 秒、落地停 gap 秒；闪现途中无敌、不穿墙），
    //   每一闪对沿路和目标身边 splash 米内的敌人斩出 pass 倍武器伤害的一刀，并在这一闪的目标身上留下一道斩痕（别的挨了刀的留 side 道）；最后一闪之后 delay 秒收刀，所有斩痕一齐炸开：
    //   每道斩痕 cut 倍武器伤害（同一个敌人的斩痕合成一击结算），带着残刃的敌人每层残刃再多 mark 倍（残刃被吃掉）。
    //   range：每一闪找下一个目标的距离（从你此刻的位置量到敌人边缘）；第一闪取准星附近的
    ashcuts: {
      name: '千刃归烬', icon: '烬', color: '#ffb066', tags: ['weapon', 'attack', 'melee', 'phys', 'movement'], kind: 'ukatana', weaponOnly: true, wtype: 'katana', uskill: true, replaces: 'flashcut',
      wm: 1, time: 0.3, mana: 16, cd: 10, range: 7.5, hops: 6, dash: 0.08, gap: 0.075, width: 1.1, splash: 1.8, pass: 2.8, cut: 6.5, side: 0.5, mark: 6, delay: 0.42,
      w: 2, kb: 0.6, poise: 14, stop: 30, cutPoise: 45, cutStop: 160, move: 0,
      wclip: null, // 起手不另播动作：每一闪播影步的闪斩，最后播收刀「u_katana」
      wt: { phases: [0.05], cancel: 9, dur: 9 }, // 时长由连闪自己管（打完收刀才结束）
      useMult: 55.8, // 单体首领：6 闪 × (2.8 + 6.5)
      desc: '在准星附近的敌人间连闪至多 6 次，每刀留下斩痕；收刀时斩痕一齐炸开，残刃每层追加伤害。闪现途中无敌。', alt: '残刃会被吃掉。不穿墙；附近没有敌人时提前收手，一个都没有时不会施放。',
    },
    // 三相天灾（长杖）：在准星一带（最远 range，被墙挡住时落在墙前）召来 dur 秒的元素风暴，半径 radius。
    //   每 tick 秒落下一击，火 → 冰 → 雷轮流（每种都按它自己的元素伤害加成算），落点优先砸在范围里的敌人身上，炸开半径 hitR；
    //   每一击额外 ailment% 异常累积，冻结 / 爆燃 / 感电（以及三相共鸣）会在怪群里接连触发。
    //   风暴打出来的异常照常让首领的阈值变高（拿着三相之心也一样），首领不会被冻结
    tristorm: {
      name: '三相天灾', icon: '灾', color: '#ffd08a', tags: ['weapon', 'spell', 'area', 'fire', 'cold', 'light'], kind: 'ustaff', weaponOnly: true, wtype: 'staff', uskill: true, replaces: 'leyburst',
      edmg: [16, 24], elem: 'fire', time: 0.7, mana: 26, cd: 12, range: 14, radius: 4.6, dur: 4, tick: 0.2, hitR: 1.8, ailment: 120, delay: 0.35,
      w: 1, kb: 0.5, poise: 6, move: 0.25,
      wclip: 'u_staff',
      wt: { phases: [0.42], cancel: 0.7, dur: 0.95, clip: { dur: 1.0 } },
      useMult: 14, // 单体平均吃到的击数（20 击里大约七成落在同一个目标身上）
      desc: '在准星一带召来 4 秒元素风暴：陨火、冰棱、落雷每秒 5 击，优先砸向敌人，大幅累积异常值。', alt: '每一击按它自己的元素伤害加成计算。首领的阈值照常变高，不会被冻结。',
    },
    // 万魂降临（魂幡）：召来 n 位英灵（champ：伤害 / 生命按召唤物算——等级 = 武器物品等级 × 0.75，吃召唤物伤害 / 生命加成与继承），
    //   在准星一带（最远 range）落下，落地时各砸一圈（slam 倍英灵一击、半径 slamR），之后自动作战 life 秒，
    //   时间到了消散（拿着万魂旗时化作魂火炸开，同魂火轮回）。英灵不占仆从的数量上限。
    //   同时把你现有的召唤物全部治疗到满，并狂热 frenzy.dur 秒
    soulhost: {
      name: '万魂降临', icon: '降', color: '#7ff0d8', tags: ['weapon', 'spell', 'minion', 'phys'], kind: 'ubanner', weaponOnly: true, wtype: 'banner', uskill: true, replaces: 'soultide',
      champ: true, minion: 'wraith',
      dmg: { phys: [5, 7] }, time: 0.75, mana: 30, cd: 15, range: 9, n: 6, life: 40, dur: 8, rate: 0.75, reach: 1.0, move: 8.2, dr: 20, cap: 6,
      cleave: 3, arc: 170, inherit: 0.35, hold: 3, slam: 4, slamR: 2.2, spread: 2.6,
      w: 0, kb: 0.4, poise: 4,
      frenzy: { dur: 4, k: 0.3 },
      wclip: 'u_banner',
      wt: { phases: [0.5], cancel: 0.75, dur: 1.0, clip: { dur: 1.05 } },
      useMult: 1,
      desc: '召下 6 位英灵在准星一带厮杀 8 秒，消散时化作魂火炸开。同时治满你的召唤物，令其狂热 4 秒。', alt: '英灵落地时各砸出一圈冲击。伤害与生命按召唤物计算，吃召唤物加成与继承，不占仆从数量。',
    },
  };
  // 按普攻折算的武器技（熔光射线、焚天炎爆）：描述里的「{basicSec} 秒」按数值填上——火浪 basicSec + 火场每跳 burn.sec × 跳数，
  // 改 basicSec / burn.sec 时文字跟着变（技能卡上的数字本来就是实时算的）
  for (const id in G.SKILLS) {
    const s = G.SKILLS[id];
    if (!s.basicOf || typeof s.desc !== 'string') continue;
    const B = s.burn, sec = s.basicSec + (B && B.sec !== undefined ? Math.round(B.dur / B.tick) * B.sec : 0);
    s.desc = s.desc.replace('{basicSec}', String(Math.round(sec * 10) / 10));
    s.useMult = sec / s.basicSec; // 单体整招按 ctx 一击的倍数（熔光射线 1，焚天炎爆 = 5.6 / 3.3），和上面写的一致
  }
  // 混沌技能的前期补偿（只乘在 chaosEarly 的技能上）：倍率按宝石等级从 k0 / k1（1 级）缓缓降到 1（lvl 级），之后不变。
  // 先平后陡（1 − t²）：5–10 级的角色还能拿到大部分补偿，15 级（角色 20 级左右）收回到 0.75 倍的基础
  G.CHAOS_EARLY = { k0: 0.95, k1: 0.75, lvl: 15 };
  G.chaosEarlyK = function (lvl) {
    const E = G.CHAOS_EARLY, t = Math.min(1, Math.max(0, (lvl - 1) / (E.lvl - 1)));
    return (E.k1 + (E.k0 - E.k1) * (1 - t * t)) / E.k1;
  };
  // 武器技之外的技能：能学、能掉落、能放进技能栏的那些
  G.GEM_SKILLS = Object.keys(G.SKILLS).filter((id) => !G.SKILLS[id].weaponOnly);
  for (const id in G.SKILLS) {
    const sk = G.SKILLS[id];
    if (sk.combo) {
      sk.comboAvg = sk.combo.reduce((s, c) => s + c.mult, 0) / sk.combo.length; // 连击三段的平均倍率
      sk.comboStop = sk.combo.reduce((s, c) => s + c.stop, 0) / sk.combo.length; // 三段平均的顿帧毫秒数
      if (sk.basic) sk.time = sk.combo.reduce((s, c) => s + c.time, 0) / sk.combo.length; // 武器普攻的连招：平均段长（秒伤估算用）
    }
    if (sk.cyc) {
      // 施法武器普攻的出手节奏：平均段长、平均倍率（秒伤估算用）；疾咒每一下留的一层咒痕最终都会引爆，也摊进每一下
      sk.time = sk.cyc.reduce((s, c) => s + c.time, 0) / sk.cyc.length;
      sk.comboAvg = sk.cyc.reduce((s, c) => s + c.mult, 0) / sk.cyc.length + (sk.mark ? sk.mark.mult : 0);
    }
  }

  // ---------- 刻式（技能宝石 10 级起，每个宝石技能两种变体 A / B；不选就是「原式」） ----------
  // 原表深拷一份到 G.SKILL_BASE（启动时、还没有任何代码改过 G.SKILLS 的时候）；G.applyVariants（game.js）按 save.variants
  // 重新拼出 G.SKILLS[id] = 合并(原式, set)。没选刻式的技能 G.SKILLS[id] 就是原来那个对象，一字不差。
  // set：要覆盖的字段（普通对象按字段合并，数组和 null 整个替换，combo 换了会重算 comboAvg / comboStop）。
  // 第二版（variants-v2，用户嫌第一版「只是攻速慢了、伤害高了，没有机制上的变化，特效也几乎相同」）：每个刻式都加一条原式没有的规则，
  //   由 mech 标出、参数放在和 mech 同名的对象里，技能代码按 mech 分支（game.js「刻式第二版」一节、minions.js 里标着「刻式」的地方）。
  //   数值只用来补偿机制：单体按 useMult（一次施放对单体的倍率总和，含持续 / 触发的那部分）折算，
  //   cycle：持续存在的东西（环刃、雷桩、护涡）要隔多久补一次才能一直满编，秒伤按它算、不吃出手速度；cycleK：一下的平均间隔是 time 的几倍（收尾 / 起手摊进来）。
  // name 刻式名，desc 换掉技能说明，pack 怪群 / 首领上的取舍（技能页悬停显示）。对等表见 endgame-notes/variants-v2.md（单体 ±10%，光环按总秒伤 ±5%）。
  // 裂石击不做刻式（用户定：它要从可学技能里拿掉，近战的右键连段接替），所以是 14 个技能；G.VARIANTS 里没有的技能照常是原式
  G.SKILL_BASE = JSON.parse(JSON.stringify(G.SKILLS));
  G.VARIANT_LVL = 10; // 宝石等级到这一级才能选
  G.VARIANT_COST = { cur: 'chaos', n: 1 }; // 每个技能第一次选免费，之后每换一次（含改回原式）付 1 颗乱流石
  G.VARIANT_SAFE_R = 25; // 这么远以内有醒着的怪就算在战斗中，不能换
  G.VARIANT_NAME = { o: '原式', a: 'A', b: 'B' };
  G.VARIANT_GEN = 2; // 刻式的版本：存档里记着的比它小，读档时清空免费那一次并提示一次（第二版整个重做了，旧的选择意思变了）
  G.VARIANTS = {
    ember: {
      a: {
        name: '跳焰', pack: '打一条线；跳点之间打不到',
        desc: '火团贴地弹跳 4 次：首跳落在准星，之后每 3.5 米一跳，撞墙弹回。每跳小范围爆炸，留下 2.5 秒火地。', alt: '飞在半空时不碰敌人。',
        set: { mech: 'skip', dmg: { fire: [10.1, 15.6] }, speed: 16, useMult: 1.09, skip: { hop: 3.5, n: 4, min: 2, max: 10, r: 1.7, field: { r: 1.2, dur: 2.5, tick: 0.5, mult: 0.15 } } },
      },
      b: {
        name: '黏焰', pack: '慢 1.5 秒；怪群里一串串地炸',
        desc: '火团粘在第一个敌人身上，1.5 秒后引爆，并给附近至多 2 个敌人各粘一颗较弱的火团。', alt: '宿主先死就当场爆炸。最多往外传两代，已粘上的敌人不会再粘。',
        set: { mech: 'stick', explode: 0, stick: { fuse: 1.5, r: 1.9, spread: 2, sr: 4.5, gen: 2, k: 0.25 } },
      },
    },
    blade: {
      a: {
        name: '钉刃', pack: '不再穿透；钉住一只锯一片',
        desc: '利刃钉住第一个敌人 1.2 秒，随后原地旋转 3 秒，割伤身边的敌人。最多同时 3 把。', alt: '首领不会被定住。没碰到敌人就立在飞行尽头。',
        set: { mech: 'pin', wm: 0.77, pierce: 0, useMult: 1.3, pin: { dur: 3, r: 1.3, tick: 0.3, mult: 0.25, root: 1.2, max: 3 } },
      },
      b: {
        name: '环刃', pack: '要贴身；满 3 把后偶尔补一把',
        desc: '利刃绕着你转 4 秒，割伤碰到的敌人；再放多一把，最多 3 把。', alt: '满 3 把时替换最旧的那把。',
        set: { mech: 'orbit', wm: 0.75, useMult: 5.18, cycle: 1.333, orbit: { r: 2.0, w: 7, dur: 4, max: 3, gap: 0.4, hr: 0.55 } },
      },
    },
    nova: {
      a: {
        name: '冰棱', pack: '只打 2 个；射程翻倍',
        desc: '光环：每隔片刻朝 9 米内最近的 2 个敌人各射一枚追踪冰棱，累积冰霜异常值。',
        set: { mech: 'shard', shard: { n: 2, range: 9, speed: 20 } },
      },
      b: {
        name: '冰爆', pack: '每跳略轻；一冻冻一片',
        desc: '光环：脚下定时冒出一圈冰刺；光环里的敌人被冻住时炸开冰爆，伤害周围敌人并灌入大量冰霜异常值。', alt: '首领被重度冰缓时同样炸开。',
        set: { mech: 'burst', dmg: { cold: [2.88, 4.32] }, burst: { r: 2.5, mult: 1.0, fill: 0.25, cd: 2 } },
      },
    },
    arc: {
      a: {
        name: '雷桩', pack: '定点输出；约两秒补一根',
        desc: '在准星插下导雷桩（6 秒，最多 3 根），每 0.5 秒电击 6 米内最近的敌人；10 米内的桩连起电弧。', alt: '多了替换最旧的。穿过电弧的敌人也会挨电。',
        set: { mech: 'pylon', useMult: 3.84, cycle: 2, pylon: { dur: 6, max: 3, r: 6, tick: 0.5, mult: 0.32, link: 10, lw: 0.9, lmult: 0.15 } },
      },
      b: {
        name: '过载', pack: '连锁少，一跳比一跳痛',
        desc: '连锁 2 次，每跳伤害 +20%；最后折回你身上，每命中一个敌人给 4% 最大生命的雷盾（3 秒），并回少量魔力。',
        set: { mech: 'overload', chain: 2, over: { k: 1.2, shield: 0.04, mana: 1.5, dur: 3 } },
      },
    },
    meteor: {
      a: {
        name: '熔核', pack: '配火焰技能更强（首领约 ×1.4）',
        desc: '落地伤害较低，留下熔核 6 秒：你的火焰伤害打中熔核旁的敌人时再炸一次（最多 4 次），消散时再炸一下。', alt: '每 0.8 秒最多引爆一次。',
        set: { mech: 'core', useMult: 1.02, core: { k0: 0.6, r: 2.6, dur: 6, mult: 0.12, n: 4, gap: 0.8, end: 0.42 } },
      },
      b: {
        name: '犁焰', pack: '打一条 8 米的沟',
        desc: '陨石落在准星后顺瞄准方向犁出 8 米，把敌人掀向两侧，留下 3 秒火沟。', alt: '撞墙就停。',
        set: { mech: 'plough', useMult: 1.0, plough: { k0: 0.55, r: 2.4, len: 8, w: 1.6, mult: 0.3, t: 0.6, field: { r: 1.3, dur: 3, tick: 0.5, mult: 0.03 } } },
      },
    },
    blink: {
      a: {
        name: '残像', pack: '适合闪离怪群；落点一击变轻',
        desc: '落地一击较轻；原地留下残像，嘲讽 7 米内的敌人 1.5 秒（首领 1 秒）后炸开。',
        set: { mech: 'decoy', useMult: 1.08, decoy: { k0: 0.45, r0: 2.4, taunt: 7, dur: 1.5, boss: 1.0, r: 3.5, mult: 0.65, hp: 99999 } },
      },
      b: {
        name: '换影', pack: '只换一个；首领改削架势',
        desc: '与准星附近的一个敌人换位，定身 1 秒并重击；落点身边的敌人挨半下。首领换不动，改为闪到它身后削 3 倍架势。',
        set: { mech: 'swap', swap: { seek: 4, stun: 1.0, r: 2.4, side: 0.5, poise: 3 } },
      },
    },
    whirl: {
      a: {
        name: '掷旋', pack: '打一条线；你可以边走边放别的',
        desc: '把旋转的武器朝准星掷出 4–9 米，在尽头悬停后飞回，全程伤到碰到的敌人。再按一次提前召回。',
        set: { mech: 'throw', wm: 1.1, time: 0.45, mana: 8, useMult: 5, cycle: 2.25, throw: { range: 9, min: 4, speed: 16, hover: 0.6, trip: 1.8, r: 1.6, gap: 0.3, cap: 5 } },
      },
      b: {
        name: '旋涡斩', pack: '吸怪聚拢；每下变轻',
        desc: '按住旋转，每下把 5 米内的敌人吸向你；松手或转满 6 下时砸地收尾，转得越久越重。', alt: '翻滚或施放别的技能会停下，不砸地。',
        set: { mech: 'pull', wm: 0.65, useMult: 1.36, cycleK: 1.194, pull: { r: 5, v: 5, max: 6, slam: 0.36, sr: 3.5 } },
      },
    },
    shadestep: {
      a: {
        name: '影印', pack: '每刀变轻；松手一齐引爆',
        desc: '自动闪砍，每刀烙一层影印（最多 3 层）；砍到满层的敌人当场引爆，松手时全部引爆，层数越多越痛。', alt: '附近没有敌人时也会全部引爆。闪现瞬间无敌；选中破绽敌人直接处决。',
        set: { mech: 'mark', wm: 0.35, useMult: 1.71, mark: { max: 3, mult: 0.95, dur: 4 } },
      },
      b: {
        name: '影分', pack: '每刀变轻；目标被击退时补刀落空',
        desc: '自动闪砍，每刀在目标另一侧留下分身，0.3 秒后补砍一刀（较轻）。', alt: '闪现瞬间无敌；选中破绽敌人直接处决。',
        set: { mech: 'clone', wm: 0.42, useMult: 1.43, clone: { delay: 0.3, mult: 0.46 } },
      },
    },
    thrall: {
      a: {
        name: '骸弓', pack: '后排输出；不挡怪',
        desc: '召唤骸骨射手：站在 5 米外射骨箭，贯穿 1 个敌人；敌人贴近时后退。上限 3 具。',
        set: { mech: 'archer', dmg: { phys: [10.45, 14.25] }, reach: 9, cleave: 0, archer: { keep: 5, flee: 2.5, speed: 24, pierce: 1 } },
      },
      b: {
        name: '骸爆', pack: '更脆；倒下后自己拼回来',
        desc: '召唤骸骨剑士：生命较低，倒下时炸开骨片，3 秒后原地重组（不耗魔力）。上限 3 具。', alt: '重组不占自动召唤的间隔。',
        set: { mech: 'bone', life: 37.8, bone: { r: 2.5, mult: 2, back: 3 } },
      },
    },
    colossus: {
      a: {
        name: '磐垒', pack: '要把怪拉进护域；不嘲讽',
        desc: '守像扎根，撑起 6 米护域：你和召唤物在里面受到的伤害 −20%，敌人变慢。不嘲讽。', alt: '只砸走进护域的敌人。',
        set: { mech: 'bastion', move: 0, taunt: null, kb: 0.3, bastion: { r: 6, dr: 20, slow: 0.25 } },
      },
      b: {
        name: '掷岩', pack: '11 米远程；不嘲讽',
        desc: '守像跟着你，朝 11 米内的敌人抛掷巨石，落地砸开一圈。不嘲讽，减伤降到 15%。',
        set: { mech: 'boulder', taunt: null, dr: 15, reach: 11, boulder: { keep: 6, r: 2.6, flight: 0.8 } },
      },
    },
    pyre: {
      a: {
        name: '焰田', pack: '怪站在火地上最痛',
        desc: '火弹较轻，落地留下 3 秒火地。焰蓄满时改放「燎原」：场上所有火地同时爆燃。上限 2 位。',
        set: { mech: 'field', dmg: { fire: [9, 13.5] }, field: { r: 1.6, dur: 3, tick: 0.5, mult: 0.15, burst: 1.8, br: 2.0 } },
      },
      b: {
        name: '魂链', pack: '首领战强；清群弱',
        desc: '不掷火弹，一直对目标引导灼链，烧同一目标 3 秒后伤害翻倍；分出一道细链烧旁边一个敌人（伤害减半）。上限 2 位。',
        set: { mech: 'link', link: { tick: 0.2, k0: 0.103, k1: 0.206, ramp: 3, side: 0.5, sr: 5 } },
      },
    },
    blackhole: {
      a: {
        name: '双极', pack: '拉成一排；覆盖面小',
        desc: '在准星两侧各开一个小黑洞（相距 6.5 米），持续 3 秒；之间的引力索把敌人拽成一排，索上同样受伤。',
        set: { mech: 'twin', radius: 2.0, twin: { gap: 6.5, w: 0.9 } },
      },
      b: {
        name: '坍缩', pack: '怪越多越重；每跳较轻',
        desc: '黑洞持续 4 秒，伤到敌人就长大。期间再按一次当场坍缩，伤害按攒下的质量；不按则结束时坍缩，伤害减半。',
        set: { mech: 'collapse', dur: 4, dmg: { chaos: [2.34, 3.48] }, useMult: 20, collapse: { cap: 30, k0: 0.8, k1: 0.2, end: 0.5, grow: 40, r: 1.2 } },
      },
    },
    vortex: {
      a: {
        name: '护涡', pack: '贴身护盾；打不到远处',
        desc: '三团黑旋风绕着你转 3 秒，绞伤并拽来身边的小怪，吞掉碰到的敌方弹丸。再放一次换新的一组。',
        set: { mech: 'guard', life: 3, dmg: { chaos: [1.3, 2.04] }, useMult: 17.6, cycle: 3, guard: { r: 2.4, w: 3.5, pull: 2.2 } },
      },
      b: {
        name: '汇涡', pack: '同一处连放越滚越大',
        desc: '三团较慢的黑旋风相互靠拢，撞到一起合成更大的一团：范围更大、更持久，最多 5 层。每跳较轻。', alt: '附近没有别的旋风时拐向最近的敌人，压在它身上就放慢。合成后的跳数是合进来的几团相加；没散的旋风会和下一次施放的合到一起。',
        set: { mech: 'merge', speed: 7, life: 3, spread: 28, dmg: { chaos: [1.86, 2.91] }, useMult: 4.9, latch: { t: 0, max: 0 }, merge: { seek: 8, turn: 3, cap: 3, max: 5, life: 1.2, after: 0.35 } },
      },
    },
    blackflame: {
      a: {
        name: '蚀印', pack: '没叠满就死的层数浪费',
        desc: '光环：附带的黑焰减半，另一半给敌人叠蚀印；满 6 层炸开，对它和身边敌人造成攒下的混沌伤害。只能镶节流。',
        set: { mech: 'brand', flame: { k0: 3, k1: 0.125, cap: 7.5 }, brand: { n: 6, r: 2 } },
      },
      b: {
        name: '传焰', pack: '慢一点到；越跳越旺',
        desc: '光环：每一击改为点上黑焰，2 秒内烧完同样多的混沌伤害；宿主死时余焰跳到 6 米内最近的敌人，每跳 +25%（最多 3 跳）。只能镶节流。',
        set: { mech: 'dot', flameDot: true, dot: { dur: 2, jump: 6, k: 1.25, max: 3 } },
      },
    },
  };

  // ---------- 架势与处决 ----------
  // 精英和首领有架势条：命中削减，几秒不挨打后回复；打空即「破绽」——停手、易伤，可被处决。
  G.POISE = {
    delay: 3, // 多久不挨打后开始回复
    regen: 0.22, // 每秒回复的比例
    brokenElite: 4, brokenBoss: 4, // 破绽持续秒数
    taken: 1.25, // 破绽中受到的伤害倍率
    critMult: 1.3, // 暴击削架势的倍率
    bossGrow: 0.2, bossGrowMax: 2, // 首领每被击破一次，架势上限提高的比例与封顶倍率
    execRange: 7, // F 处决的最远距离（到目标边缘）
    execMelee: 2.6, // 近战键贴身处决的距离（到目标边缘）
    execHits: 8, // 处决伤害 = 这么多次平均击中……
    execEliteHp: 0.4, execEliteKill: 0.15, // ……精英至少扣 40% 最大生命，之后剩余不足 15% 的直接毙命
    execBossMin: 0.06, execBossMax: 0.12, // 首领按最大生命的比例设上下限
    execLife: 0.18, execLifeBoss: 0.1, execMana: 0.25, // 处决回复的生命（精英 / 首领）/ 魔力比例
    execFlaskElite: 0.5, execFlaskBoss: 0.34, // 处决补充的药剂充能（首领战一场能破好几次，给多了会让首领战失去压力）
  };

  // ---------- 元素异常值 ----------
  // 每个敌人有火 / 冰 / 雷三条异常值（0..1）。每次命中按这一击里该元素的伤害累积：伤害 ÷ 阈值 × rate[元素] × (1 + 异常累积速度% / 100)。
  // rate：各元素自己的累积速度——闪电（高频群伤）最快，冰霜次之，火焰最慢（靠爆燃的大伤害回本）。
  // 阈值 = 最大生命 × th（精英用 thElite，首领用 boss），首领每触发一次，该元素的阈值提高 bossGrow（封顶 bossGrowMax 倍），像架势一样越打越难。
  // 死亡时的异常：敌人死的那一刻某条异常值 ≥ deathMin（冰霜另算上「正冻着」，闪电另算上「正感电」），就按那个元素在尸体处触发一次（见 game.js 的 queueDeathProcs）：
  //   火 → 尸爆：和爆燃同一个公式；雷 → 放电：向 shockR 以内最近的 deathBoltN 个敌人各射一道电弧，每道 = 灌进闪电异常值的平均每击闪电伤害 × deathBolt；
  //   冰 → 碎冰：尸体碎成冰碴，给 shatterR 以内的敌人灌冰霜异常值（量 = 死者的阈值 × shatter，折算到对方的阈值，每个至多 shatterCap 条）。
  //   连锁保护：死亡触发打死的敌人还能再触发，但从玩家亲手的命中算起最多 deathGen 代；每帧最多 deathMax 次；死亡电弧 / 尸爆同样不累积异常值。
  // hold 秒没有再受到该元素伤害后，按每秒 decay 回落。满了即触发：
  //   冰 → 冻结 freeze 秒（精英 freezeElite 秒）；首领不会被冻结，改为 bossChill 秒的重度冰缓（移动与出手放慢 bossSlow）。
  //        异常值大于 0 时附带轻度冰缓：减速 = chillMin + (chill − chillMin) × 异常值^chillPow——挨上一下冰就有 chillMin 的保底，
  //        越满越慢，冻结前一刻到 chill（精英 chillMinElite..chillElite，首领 chillMinBoss..chillBoss）。冻结 / 重度冰缓期间不再累积冰霜异常值。
  //        冰缓放慢的是这只敌人自己的时钟：移动、出手间隔、起手 / 收招、预警圈和动作一起变慢（首领的招式和预警按固定节奏，只放慢走动、招式之间的停顿和收招）
  //   火 → 爆燃：以敌人为中心半径 blastR 的爆炸，伤害 = 灌满期间平均每击的火焰伤害 × (1 + 异常累积速度%) × blast，封顶为该敌人阈值 × blastCap；爆炸本身不累积异常值（不会连锁）
  //   雷 → 感电 shock 秒：期间它每受到一次命中，就射出 shockN 道电弧，射向 shockR 以内最近的其他敌人（附近一个都没有时，只有一道打回它自己），
  //        每道 = 这一击的 bolt 倍；电弧不再触发电弧、不累积异常值，同一个敌人每 shockGap 秒最多放一次。感电期间不再累积闪电异常值
  G.BUILDUP = {
    th: 0.18, thElite: 0.3, boss: 0.15, bossGrow: 0.5, bossGrowMax: 4,
    rate: { fire: 1, cold: 1.2, light: 1.6 },
    hold: 3, decay: 0.5,
    chill: 0.48, chillMin: 0.18, chillPow: 0.7, chillElite: 0.4, chillMinElite: 0.15, chillBoss: 0.3, chillMinBoss: 0.12,
    freeze: 1.5, freezeElite: 1.0, bossChill: 3, bossSlow: 0.5,
    blastR: 3, blast: 1, blastCap: 0.5,
    shock: 4, shockR: 6, shockN: 2, bolt: 0.3, shockGap: 0.15,
    deathMin: 0.5, deathGen: 2, deathMax: 10,
    deathBoltN: 3, deathBolt: 0.6,
    shatterR: 3, shatter: 0.4, shatterCap: 0.6,
    // 混沌 → 渊缚：小怪定身 bind 秒（精英 bindElite）并被往最近的黑洞（bindR 以内）拽，附近没有黑洞就往 packR 以内的怪群中心拽：
    //   每秒 bindPull / √体重 米，一次最多 bindPullMax 米；冻结中不拽。首领不定不拽，改为 bossBind 秒减速 bossBindSlow（和冰缓取较大的那个）。
    //   渊缚期间不再累积混沌异常值。死亡时（异常值 ≥ deathMin 或正被渊缚）在尸体处「渊陷」：voidR 以内的小怪被往尸体拽 voidT 秒（每秒 voidPull / √体重 米），不造成伤害
    bind: 1.0, bindElite: 0.6, bossBind: 2.5, bossBindSlow: 0.4,
    bindPull: 6, bindPullMax: 3.5, bindR: 8, packR: 5,
    voidR: 3, voidPull: 5, voidT: 0.35,
  };
  G.BUILDUP.rate.chaos = 1.4; // 混沌技能的基础伤害低，累积速度放在冰霜和闪电之间
  G.ELEMS = ['fire', 'cold', 'light'];
  // 有异常值的伤害类型：三种元素 + 混沌（混沌另有自己的触发「渊缚」）
  G.BUILD_TYPES = ['fire', 'cold', 'light', 'chaos'];

  // ---------- 辅助宝石 ----------
  // req：技能需带有其中任一标签；no：带有其中任一标签的技能不能镶（可缺省）；eff：效果；cost：魔力消耗倍率。
  // 镶在召唤技能上时，通用辅助作用在召唤物身上：迅捷也加快召唤物出手，注入 / 蛮力 / 致命 / 震慑 / 蚀染作用于召唤物的每一击，
  // 扩域放大守像的砸地，节流照常减消耗和冷却；回响、汲生、投射物 / 连锁类镶不上
  G.SUPPORTS = {
    multi: { name: '多重投射', req: ['projectile'], cost: 1.3, eff: { proj: 2, more: -25 }, desc: '额外发射 2 个投射物，伤害减少 25%' },
    // 焚骨祭司的火弹碰到就炸：穿透、连锁对它没有意义，镶不上召唤技能（多重投射可以：一次掷出几枚，分头砸向不同的敌人）
    pierce: { name: '贯穿', req: ['projectile'], no: ['minion'], cost: 1.15, eff: { pierce: 3 }, desc: '投射物额外穿透 3 个敌人' },
    chain: { name: '连锁', req: ['projectile', 'chaining'], no: ['minion'], cost: 1.25, eff: { chain: 2, more: -15 }, desc: '额外连锁 2 次，伤害减少 15%' },
    expanse: { name: '扩域', req: ['area'], cost: 1.2, eff: { area: 40 }, desc: '技能范围扩大 40%' },
    haste: { name: '迅捷', req: null, cost: 1.25, eff: { speed: 25 }, desc: '攻击与施法速度加快 25%' },
    fire: { name: '灼炎注入', req: null, cost: 1.2, eff: { extra: { fire: 30 } }, desc: '附加等于伤害 30% 的火焰伤害' },
    cold: { name: '寒霜注入', req: null, cost: 1.2, eff: { extra: { cold: 30 } }, desc: '附加等于伤害 30% 的冰霜伤害' },
    light: { name: '雷霆注入', req: null, cost: 1.2, eff: { extra: { light: 30 } }, desc: '附加等于伤害 30% 的闪电伤害' },
    chaos: { name: '混沌注入', req: null, cost: 1.2, eff: { extra: { chaos: 30 } }, desc: '附加等于伤害 30% 的混沌伤害' },
    brutal: { name: '蛮力', req: ['phys'], cost: 1.2, eff: { moreType: { phys: 35 } }, desc: '物理伤害额外提高 35%' },
    precise: { name: '致命', req: null, cost: 1.15, eff: { critFlat: 8, critMulti: 40 }, desc: '暴击率 +8%，暴击伤害 +40%' },
    leech: { name: '汲生', req: null, no: ['minion'], cost: 1.1, eff: { leech: 3 }, desc: '伤害的 3% 转为生命' },
    echo: { name: '回响', req: ['spell'], no: ['summon', 'aura', 'duration'], cost: 1.4, eff: { echo: 1, more: -30 }, desc: '法术自动重复施放一次，伤害减少 30%' },
    stagger: { name: '震慑', req: ['attack', 'minion'], cost: 1.15, eff: { stun: 0.7 }, desc: '击中使非首领敌人眩晕 0.7 秒' },
    ailment: { name: '蚀染', req: null, cost: 1.1, eff: { ailment: 35 }, desc: '异常值累积速度加快 35%' },
    frugal: { name: '节流', req: null, cost: 0.6, eff: { cdr: 25 }, desc: '魔力消耗与光环保留减少 40%，冷却缩短 25%' },
    // 召唤物专用
    dominion: { name: '驭灵', req: ['minion'], cost: 1.25, eff: { minionMore: 30 }, desc: '召唤物伤害额外提高 30%' },
    ossify: { name: '坚骨', req: ['minion'], cost: 1.15, eff: { minionLife: 40, minionDR: 15 }, desc: '召唤物最大生命 +40%，受到的伤害 −15%' },
    // noKind：这些召唤物镶不上（守像只能有 1 尊）。镶在焚骨祭司上时是祭司 +1
    horde: { name: '群聚', req: ['minion'], noKind: ['colossus'], cost: 1.3, eff: { minionCap: 1, minionMore: -15 }, desc: '召唤数量上限 +1（仆从或祭司，守像镶不上），召唤物伤害额外降低 15%' },
    frenzy: { name: '狂怒', req: ['minion'], cost: 1.2, eff: { minionSpeed: 20 }, desc: '召唤物攻击与移动速度 +20%' },
  };

  // ---------- 属性显示 ----------
  G.STAT_FMT = {
    life: '+{v} 最大生命', mana: '+{v} 最大魔力', armour: '+{v} 护甲',
    incLife: '最大生命提高 {v}%', incMana: '最大魔力提高 {v}%', incArmour: '护甲提高 {v}%',
    incPhys: '物理伤害提高 {v}%', incFire: '火焰伤害提高 {v}%', incCold: '冰霜伤害提高 {v}%',
    incLight: '闪电伤害提高 {v}%', incElem: '元素伤害提高 {v}%', incAll: '伤害提高 {v}%',
    addPhys: '附加 {a}–{b} 物理伤害', addFire: '附加 {a}–{b} 火焰伤害',
    addCold: '附加 {a}–{b} 冰霜伤害', addLight: '附加 {a}–{b} 闪电伤害',
    incChaos: '混沌伤害提高 {v}%', addChaos: '附加 {a}–{b} 混沌伤害', moreChaos: '混沌伤害总额外 {s}{v}%',
    bindAil: '渊缚累积速度加快 {v}%', flameEff: '黑焰的额外混沌伤害提高 {v}%', holeDur: '黑洞持续时间延长 {v}%', pullK: '黑洞与渊缚的牵引力提高 {v}%',
    resFire: '+{v}% 火焰抗性', resCold: '+{v}% 冰霜抗性', resLight: '+{v}% 闪电抗性',
    speed: '攻击与施法速度提高 {v}%', crit: '暴击率提高 {v}%', critMulti: '+{v}% 暴击伤害',
    lifeRegen: '每秒回复 {v} 生命', manaRegen: '魔力回复速度提高 {v}%', lifeOnKill: '击杀回复 {v} 生命',
    moveSpeed: '移动速度提高 {v}%', rarity: '掉落物品稀有度提高 {v}%',
    area: '技能范围扩大 {v}%', ailment: '异常值累积速度加快 {v}%（含渊缚）', costReduce: '技能消耗降低 {v}%',
    dodgeCd: '翻滚冷却缩短 {v}%', moreDmg: '总伤害额外 {s}{v}%', lessTaken: '受到的伤害减少 {v}%',
    moreLife: '最大生命额外 {s}{v}%', bloodMagic: '技能消耗生命而非魔力，光环改为保留生命',
    minionDmg: '召唤物伤害提高 {v}%', minionLife: '召唤物最大生命提高 {v}%',
    minionSpeed: '召唤物攻击与移动速度提高 {v}%', minionCap: '烬骸仆从数量上限 +{v}',
    minionMore: '召唤物总伤害额外 {s}{v}%', ownLess: '你自身（非召唤物）的总伤害额外 -{v}%',
    minionArea: '召唤物的范围效果扩大 {v}%', minionCharge: '焚骨祭司攒焰蓄加快 {v}%',
    poiseDmg: '架势削减提高 {v}%', pierce: '投射物额外穿透 {v} 个敌人',
    moreElem: '元素伤害总额外 {s}{v}%', moreTaken: '受到的伤害增加 {v}%',
    // 在 75% 上限之后才扣：溢出的抗性抵消不了（基石「元素过载」的代价）
    resLoss: '各项元素抗性 -{v}%（在 75% 上限之后扣除）',
    // 召唤物继承你的装备（见 game.js 的 G.minionInherit）
    mWeapon: '召唤物每一击附加相当于你武器伤害 {v}% 的物理伤害（按武器物品等级折算）', mDef: '召唤物获得你 {v}% 的护甲与抗性（按装备物品等级折算）',
    mLife: '召唤物获得你装备上最大生命总和 {v}% 的额外生命（按装备物品等级折算）',
    // 武器的本地词缀：只改这把武器自己的伤害（不进角色属性汇总），已经算在物品的 dmg 里
    wInc: '武器物理伤害提高 {v}%', wAdd: '附加 {a}–{b} 物理伤害',
    // 远程武器（见 G.RANGED）：枪械的热度、弓的专注
    heatGain: '热度积攒速度加快 {v}%', heatDmg: '热度满时枪械普攻伤害提高 {v}%（随热度线性）', rDmg: '枪械热度技（R）伤害提高 {v}%',
    // 熄烛冠专属：你对所有敌人、召唤物对暗域内的敌人（见 G.RELIC_MECH.xizhu）
    darkDmg: '暗域增伤 {v}%',
    focusGain: '专注积攒速度加快 {v}%', buffDur: '弓的专注技（R）增益持续时间延长 {v}%', rangeDmg: '远距离命中时弓的伤害提高 {v}%',
  };
  G.LOCAL_STATS = { wInc: 1, wAdd: 1 };
  // 「提高 / 缩短 / 减少……」类的写法遇到负值时换成反义词、写绝对值（「移动速度降低 15%」，而不是「提高 -15%」）
  const FLIP = [['提高', '降低'], ['缩短', '延长'], ['减少', '增加'], ['加快', '减慢'], ['扩大', '缩小']];
  // 代价：负值，或者本身就是坏处的属性（界面上标红）
  G.statBad = (stat, v) => (stat === 'ownLess' || stat === 'moreTaken' || stat === 'resLoss' ? v > 0 : v < 0);
  G.fmtStat = function (stat, v) {
    let f = G.STAT_FMT[stat] || stat + ' {v}';
    let r = Math.round(v * 10) / 10;
    if (r < 0 && f.indexOf('{s}') < 0 && f.indexOf('+{v}') < 0) {
      const w = FLIP.find((p) => f.indexOf(p[0]) >= 0);
      if (w) {
        f = f.replace(w[0], w[1]);
        r = -r;
      }
    }
    return f
      .replace('{s}', r >= 0 ? '+' : '')
      .replace('+{v}', (r >= 0 ? '+' : '') + r)
      .replace('{v}', r)
      .replace('{a}', Math.max(1, Math.round(v * 0.7)))
      .replace('{b}', Math.max(2, Math.round(v * 1.3)));
  };

  // ---------- 装备 ----------
  G.SLOTS = ['weapon', 'helm', 'body', 'gloves', 'boots', 'belt', 'ring', 'amulet'];
  G.SLOT_NAME = { weapon: '武器', helm: '头盔', body: '胸甲', gloves: '手套', boots: '鞋子', belt: '腰带', ring: '戒指', amulet: '护符' };
  G.SLOT_GLYPH = { weapon: '武', helm: '盔', body: '甲', gloves: '手', boots: '靴', belt: '带', ring: '戒', amulet: '坠' };
  // 3 = 烬铸：只有轮回层级里的首领会掉的固定武器（见下面的「烬铸武器」），名字是偏暗的金红色，和稀有的亮黄分开
  // 4 = 渊契：只出在非武器部位的固定物品（见下面的「渊契」），翠色。名字和颜色各只在这里写一次（界面、光柱、图鉴都读这两个）
  G.RELIC_RARITY = 4;
  G.RELIC_NAME = '渊契';
  G.RELIC_COLOR = '#6fe0b0';
  G.RARITY_NAME = ['普通', '魔法', '稀有', '烬铸', G.RELIC_NAME];
  G.RARITY_COLOR = ['#d6d1c4', '#7f9dff', '#ffd75e', '#ff9b3d', G.RELIC_COLOR];

  // 武器：type 武器类型；wskill 自带的武器技（G.SKILLS 里的 id）；dmg 1 级时的物理伤害区间（按物品等级成长，见「武器伤害」）；
  // aps 攻击速度：攻击技能的出手速度倍率（1 = 技能本身的节奏），武器秒伤 = 平均伤害 × aps；
  // hands 1 单手 / 2 双手（模型握法用）。前三种的下标 0 / 1 / 2 不能动（旧存档靠 baseIdx 认基底），新类型只能往后加。
  // 隐含属性 imp：fixed 为 true 时不随物品等级放大，step 是每多少物品等级 +1（长弓的穿透）；also 附带的第二条（G.impAlso）。
  // caster：施法武器（武器伤害低）；drop：随机掉落时的基底权重（缺省 1）。
  // 双匕 / 长弓 / 太刀的武器秒伤比刃高一成左右：刃的隐含「物理伤害提高」随物品等级放大，其余的隐含几乎不加单体秒伤，
  // 这样同物品等级下各类攻击武器配攻击技能的秒伤都在刃的 ±10% 以内（长弓单体略低，靠穿透打群）
  G.BASES = {
    weapon: [
      { names: ['铁刃', '战刃', '烬钢刃'], type: 'blade', wskill: 'riposte', dmg: [8, 12], aps: 1.0, hands: 1, imp: { stat: 'incPhys', lo: 8, hi: 14 } },
      { names: ['木杖', '符文杖', '渊晶杖'], type: 'staff', wskill: 'leyburst', dmg: [5, 8], aps: 0.9, hands: 2, caster: true, imp: { stat: 'incElem', lo: 8, hi: 14 } },
      { names: ['骨杖', '灵枝', '雷纹短杖'], type: 'wand', wskill: 'arcvolley', dmg: [4, 8], aps: 1.0, hands: 1, caster: true, imp: { stat: 'speed', lo: 4, hi: 7 } },
      { names: ['双骨匕', '鸦喙双匕', '烬牙双刺'], type: 'daggers', wskill: 'shadowstab', dmg: [7, 13], aps: 1.2, hands: 1, imp: { stat: 'crit', lo: 20, hi: 30 } },
      { names: ['石锤', '铁誓战锤', '熔心巨锤'], type: 'hammer', wskill: 'quake', dmg: [11, 18], aps: 0.8, hands: 2, imp: { stat: 'poiseDmg', lo: 15, hi: 25 } },
      // 下标 5：原来的长弓（type 'bow'、R 箭雨）改成鹰眼长弓，旧存档里的长弓读档时换成这里的名字（见 game.js 的 fixItem / G.BOW_OLD_NAMES）
      { names: ['榆木鹰眼弓', '鹰眼长弓', '渊鸣鹰眼弓'], type: 'eagle', ranged: 'bow', wskill: 'pierceheart', dmg: [8, 15], aps: 1.0, hands: 2, imp: { stat: 'pierce', lo: 1, hi: 1, fixed: true, step: 12 } },
      { names: ['直刃太刀', '霜纹太刀', '烬月太刀'], type: 'katana', wskill: 'flashcut', dmg: [8, 14], aps: 1.05, hands: 2, imp: { stat: 'critMulti', lo: 12, hi: 20 } },
      // 魂幡：召唤师的武器，武器伤害很低；隐含属性带一点召唤物生命（also：数值 = 主隐含 × k，取整）
      // soul：召唤物继承武器伤害时按这么多倍计（魂幡的武器伤害只有刃的四成多，乘上之后和刃相当，召唤师拿魂幡不吃亏）
      { names: ['骨铃魂幡', '残旌魂幡', '渊引魂幡'], type: 'banner', wskill: 'soultide', dmg: [3, 6], aps: 0.9, hands: 2, caster: true, drop: 0.8, soul: 2.2, imp: { stat: 'minionDmg', lo: 10, hi: 16, also: { stat: 'minionLife', k: 0.5 } } },
      // ---------- 远程武器（ranged：'gun' 枪械 / 'bow' 弓）：右键是武器普攻（basic_<type>），R 由量表决定（见 G.RANGED） ----------
      // 机炮一发伤害低、射速高（转满后约 12 发 / 秒），喷枪一跳伤害低、范围打满；单体秒伤和刃配裂石击在同一档（不耗魔力，靠站得远换一点）
      { names: ['铆钉机炮', '转膛机炮', '熔轮机炮'], type: 'gatling', ranged: 'gun', wskill: 'meltray', dmg: [3, 5], aps: 1.0, hands: 2, imp: { stat: 'poiseDmg', lo: 10, hi: 16 } },
      { names: ['铁皮喷枪', '焚炉喷枪', '熔岩喷枪'], type: 'flamer', ranged: 'gun', wskill: 'firestorm', dmg: [4, 7], aps: 1.0, hands: 2, imp: { stat: 'ailment', lo: 8, hi: 12 } },
      { names: ['桦木猎弓', '追猎弓', '影羽猎弓'], type: 'huntbow', ranged: 'bow', wskill: 'volley', dmg: [7, 12], aps: 1.1, hands: 2, imp: { stat: 'speed', lo: 4, hi: 7 } },
      { names: ['刻纹弓', '符文弓', '辉纹符文弓'], type: 'runebow', ranged: 'bow', wskill: 'overflow', dmg: [7, 12], aps: 1.0, hands: 2, imp: { stat: 'incElem', lo: 6, hi: 10 } },
      // 下面两种只有烬铸武器用（drop 0：随机掉落不出）；烬铸武器的物品等级在 21 以上，实际只会用到第三阶的名字
      { names: ['黄铜左轮', '铁芯左轮', '烬铸左轮'], type: 'revolver', ranged: 'gun', wskill: 'wildfire', dmg: [8, 12], aps: 1.0, hands: 1, drop: 0, imp: { stat: 'crit', lo: 10, hi: 16 } },
      { names: ['霜木长弓', '寒羽长弓', '凛晶长弓'], type: 'emberbow', ranged: 'bow', wskill: 'emberstorm', dmg: [8, 14], aps: 1.05, hands: 2, drop: 0, imp: { stat: 'incCold', lo: 8, hi: 14 } },
    ],
    helm: [{ names: ['皮盔', '铁盔', '烬钢盔'], armour: [10, 4] }],
    body: [{ names: ['皮甲', '锁甲', '烬钢甲'], armour: [20, 8] }],
    gloves: [{ names: ['皮手套', '铁护手', '烬钢护手'], armour: [6, 3] }],
    boots: [{ names: ['皮靴', '铁胫甲', '烬钢靴'], armour: [6, 3] }],
    belt: [{ names: ['皮带', '重腰带', '符文腰带'], imp: { stat: 'life', lo: 10, hi: 16 } }],
    ring: [
      { names: ['赤铜戒'], imp: { stat: 'resFire', lo: 6, hi: 10 } },
      { names: ['霜银戒'], imp: { stat: 'resCold', lo: 6, hi: 10 } },
      { names: ['雷纹戒'], imp: { stat: 'resLight', lo: 6, hi: 10 } },
      { names: ['灵石戒'], imp: { stat: 'mana', lo: 10, hi: 16 } },
    ],
    amulet: [
      { names: ['骨坠'], imp: { stat: 'incAll', lo: 4, hi: 7 } },
      { names: ['血石坠'], imp: { stat: 'lifeRegen', lo: 1, hi: 2 } },
      { names: ['星芒坠'], imp: { stat: 'crit', lo: 8, hi: 12 } },
    ],
  };

  // 词缀：tiers 由 lo/hi 按 g 的幂次增长；TIER_ILVL 是各阶所需物品等级。
  // 前 6 阶（物品等级 24 以内，层级 0 能见到的全部）和改版前一样；后 4 阶（31 / 38 / 46 / 55）给轮回层级 1 以后用，
  // 按同样的 g 接着涨。soft 的词缀（抗性、速度、暴击这类有上限或收益递增的）从 SOFT_TIER 阶往上每阶只按 √g 涨，
  // 免得一条抗性就顶满、一双鞋子跑出两倍移速
  G.TIER_ILVL = [1, 5, 9, 13, 18, 24, 31, 38, 46, 55];
  G.SOFT_TIER = 5;
  const ARM = ['helm', 'body', 'gloves', 'boots'];
  const JEW = ['ring', 'amulet'];
  function A(id, type, label, stat, lo, hi, g, slots, w) {
    return { id, type, label, stat, lo, hi, g, slots, w };
  }
  G.AFFIXES = [
    A('life', 'prefix', '健壮', 'life', 8, 14, 1.42, ARM.concat(['belt'], JEW), 10),
    A('mana', 'prefix', '灵慧', 'mana', 8, 13, 1.38, ['helm', 'belt', 'weapon'].concat(JEW), 6),
    A('armour', 'prefix', '坚固', 'armour', 10, 18, 1.5, ARM.concat(['belt']), 8),
    A('incPhys', 'prefix', '锋锐', 'incPhys', 6, 10, 1.35, ['weapon', 'gloves'].concat(JEW), 6),
    A('incFire', 'prefix', '炽燃', 'incFire', 6, 10, 1.35, ['weapon'].concat(JEW), 5),
    A('incCold', 'prefix', '凛冬', 'incCold', 6, 10, 1.35, ['weapon'].concat(JEW), 5),
    A('incLight', 'prefix', '雷殛', 'incLight', 6, 10, 1.35, ['weapon'].concat(JEW), 5),
    A('incAll', 'prefix', '凶暴', 'incAll', 4, 7, 1.33, ['weapon', 'amulet'], 4),
    // 武器上的物理附加改为本地词缀（wAdd，只加这把武器的伤害）；手套 / 首饰上的照旧对所有技能生效
    A('addPhys', 'prefix', '裂伤', 'addPhys', 2, 3, 1.5, ['gloves'].concat(JEW), 5),
    A('addFire', 'prefix', '淬火', 'addFire', 2, 4, 1.5, ['weapon', 'gloves'].concat(JEW), 4),
    A('addCold', 'prefix', '覆霜', 'addCold', 2, 4, 1.5, ['weapon', 'gloves'].concat(JEW), 4),
    A('addLight', 'prefix', '蓄电', 'addLight', 2, 4, 1.5, ['weapon', 'gloves'].concat(JEW), 4),
    A('moveSpeed', 'prefix', '迅足', 'moveSpeed', 4, 6, 1.22, ['boots'], 9),
    A('resFire', 'suffix', '御火', 'resFire', 6, 10, 1.3, ARM.concat(['belt'], JEW), 8),
    A('resCold', 'suffix', '御霜', 'resCold', 6, 10, 1.3, ARM.concat(['belt'], JEW), 8),
    A('resLight', 'suffix', '御雷', 'resLight', 6, 10, 1.3, ARM.concat(['belt'], JEW), 8),
    A('speed', 'suffix', '迅击', 'speed', 3, 5, 1.3, ['weapon', 'gloves', 'ring'], 6),
    A('crit', 'suffix', '洞察', 'crit', 6, 10, 1.35, ['weapon', 'helm', 'gloves'].concat(JEW), 6),
    A('critMulti', 'suffix', '致命', 'critMulti', 6, 10, 1.3, ['weapon'].concat(JEW), 5),
    A('lifeRegen', 'suffix', '复苏', 'lifeRegen', 1, 2, 1.5, ['helm', 'body', 'belt'].concat(JEW), 5),
    A('manaRegen', 'suffix', '清明', 'manaRegen', 8, 14, 1.3, ['helm', 'weapon'].concat(JEW), 5),
    A('lifeOnKill', 'suffix', '嗜血', 'lifeOnKill', 1, 3, 1.4, ['weapon', 'gloves', 'ring'], 4),
    A('rarity', 'suffix', '寻宝', 'rarity', 5, 9, 1.25, ['helm', 'gloves', 'boots'].concat(JEW), 4),
    // 混沌：混沌伤害提高只给混沌（三种元素的提高也给混沌），附加混沌比元素附加低一档（混沌吃三份加成）
    A('incChaos', 'prefix', '渊蚀', 'incChaos', 6, 10, 1.35, ['weapon'].concat(JEW), 4),
    A('addChaos', 'prefix', '蚀刻', 'addChaos', 1, 3, 1.5, ['weapon', 'gloves'].concat(JEW), 3),
    A('bindAil', 'suffix', '缚渊', 'bindAil', 8, 13, 1.3, ['weapon', 'gloves', 'amulet'], 4),
    // 召唤物词缀。baseW：按基底（BASES 里的下标）调整出现权重——杖类武器（木杖 / 骨杖）更容易出召唤物伤害；
    // minIlvl / rareOnly：只在物品等级够高的稀有物品上出现
    Object.assign(A('minionDmg', 'prefix', '统御', 'minionDmg', 6, 10, 1.35, ['weapon'].concat(JEW), 5), { baseW: { weapon: [0.4, 1.8, 1.8, 0.4, 0.4, 0.4, 0.4, 2.6, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2] } }),
    // 武器本地词缀（local）：改的是这把武器自己的伤害，施法武器（杖类、魂幡）很少出
    Object.assign(A('wInc', 'prefix', '淬锋', 'wInc', 8, 13, 1.25, ['weapon'], 7), { local: true, baseW: { weapon: [1, 0.3, 0.3, 1, 1, 1, 1, 0.2] } }),
    // 机炮 / 喷枪不出「重锻」：它们的基础伤害低、出手极快，固定的本地附加对它们是几倍的收益
    Object.assign(A('wAdd', 'prefix', '重锻', 'wAdd', 2, 3, 1.33, ['weapon'], 6), { local: true, baseW: { weapon: [1, 0.3, 0.3, 1, 1, 1, 1, 0.2, 0, 0] } }),
    // 远程武器专属：baseW 只给枪械（机炮 / 喷枪 / 左轮）或弓（鹰眼 / 追猎 / 符文 / 霜弓）非零权重
    Object.assign(A('heatGain', 'suffix', '炽膛', 'heatGain', 6, 10, 1.2, ['weapon'], 6), { baseW: { weapon: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0] } }),
    Object.assign(A('heatDmg', 'prefix', '赤热', 'heatDmg', 10, 16, 1.3, ['weapon'], 5), { baseW: { weapon: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0] } }),
    Object.assign(A('focusGain', 'suffix', '凝神', 'focusGain', 6, 10, 1.2, ['weapon'], 6), { baseW: { weapon: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1] } }),
    Object.assign(A('rangeDmg', 'prefix', '远矢', 'rangeDmg', 10, 16, 1.3, ['weapon'], 5), { baseW: { weapon: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1] } }),
    A('minionLife', 'prefix', '骸固', 'minionLife', 8, 13, 1.3, ['helm', 'body', 'belt'], 5),
    Object.assign(A('minionCap', 'suffix', '万骸', 'minionCap', 1, 1, 1, ['amulet'], 2), { minIlvl: 18, rareOnly: true }),
    // 只出现在烬铸武器上的词缀行（slots 为空、权重 0：随机掉落和打造都不会出）
    A('uIncElem', 'prefix', '三相', 'incElem', 8, 13, 1.35, [], 0),
    A('uAilment', 'suffix', '蚀相', 'ailment', 8, 13, 1.3, [], 0),
    // 只出现在熄烛冠上（巅峰渊契的专属行）：不随物品等级变（g 1），区间就是 [lo, hi]
    A('darkDmg', 'suffix', '暗域', 'darkDmg', 20, 28, 1, [], 0),
  ];
  G.AFFIX_BY_ID = {};
  for (const a of G.AFFIXES) G.AFFIX_BY_ID[a.id] = a;
  for (const id of ['moveSpeed', 'resFire', 'resCold', 'resLight', 'speed', 'crit', 'critMulti', 'manaRegen', 'rarity', 'uAilment', 'heatGain', 'focusGain', 'bindAil']) G.AFFIX_BY_ID[id].soft = true;

  // ---------- 烬铸武器（稀有度 3）----------
  // 名字、武器类型和词缀行都是固定的，只有数值在区间里掷。区间跟着物品等级走：每一行取这条词缀在该物品等级最高阶的区间，
  // 下限 × k[0]、上限 × k[1]（fixed 的行是固定值，不进完美度）。基础伤害按普通武器的公式在掉落的物品等级上算，成色固定取 BASE_Q
  // （普通武器 0.9–1.1 的上沿），所以层级越高掉的同一把越强。裸属性大致相当于同物品等级最好的稀有武器，强在机制上。
  // boss：只由这个首领掉（层级 1 起）；mech：机制（game.js 里按 P.uMech 判断）
  G.UNIQUE_BASE_Q = 1.1;
  G.UNIQUES = {
    jinduan: {
      name: '烬断', base: 6, boss: 'warden', mech: 'blade', mechName: '残刃', uskill: 'ashcuts',
      lines: [{ id: 'wInc', k: [1.7, 2.3] }, { id: 'crit', k: [1.6, 2.2] }, { id: 'critMulti', k: [1.1, 1.5] }, { id: 'speed', k: [0.9, 1.3] }],
      lore: '监察者的断刀，还烫手。',
    },
    sanxiang: {
      name: '三相之心', base: 1, boss: 'weaver', mech: 'tri', mechName: '三相共鸣', uskill: 'tristorm',
      lines: [{ id: 'uIncElem', k: [1.15, 1.65] }, { id: 'uAilment', k: [1.0, 1.5] }, { id: 'speed', k: [1.0, 1.4] }, { id: 'addLight', k: [0.95, 1.35] }],
      lore: '三种元素，谁也不服谁。',
    },
    wanhun: {
      name: '万魂旗', base: 7, boss: 'lord', mech: 'soul', mechName: '魂火轮回', uskill: 'soulhost',
      lines: [{ id: 'minionDmg', k: [0.1, 0.2] }, { id: 'minionLife', k: [0.3, 0.6] }, { id: 'minionCap', fixed: 1 }, { id: 'wInc', k: [2.0, 2.8] }],
      lore: '旗上拴着亡魂。',
    },
    // 熔芯（左轮）：熔渣巨像掉。R 是它专属的「乱射」；机制「熔芯弹」——每一轮的最后一发必定暴击，并在命中处炸开
    rongxin: {
      name: '熔芯', base: 12, boss: 'golem', mech: 'core', mechName: '熔芯弹', uskill: 'wildfire',
      lines: [{ id: 'wInc', k: [1.7, 2.3] }, { id: 'critMulti', k: [1.1, 1.5] }, { id: 'heatGain', k: [1.2, 1.7] }, { id: 'speed', k: [0.9, 1.3] }],
      lore: '巨像的芯做的枪。',
    },
    // 凛羽（弓，内部 id 仍是 jinyu）：第五个区域（坠星裂谷）的首领衔星巨兽掉（bossZone 兜底：首领 id 对不上时取这个区域的首领，见 G.syncUniqueBosses）。
    // R 是专属的「凛冬」；机制「碎晶连跳」写在它的普攻里（basic_emberbow 的 spark），这里加强：冰晶给目标灌冰霜异常值
    // （内部 id 仍沿用 jinyu / emberbow / emberstorm / mech 'ember'，旧存档不用迁移）
    jinyu: {
      name: '凛羽', base: 13, boss: 'behemoth', bossZone: 'rift', mech: 'ember', mechName: '碎晶连跳', uskill: 'emberstorm',
      lines: [{ id: 'wInc', k: [1.6, 2.2] }, { id: 'incCold', k: [1.2, 1.7] }, { id: 'focusGain', k: [1.2, 1.7] }, { id: 'crit', k: [1.2, 1.7] }],
      lore: '用坠星的冰削的弓。',
    },
    // 星蚀（短杖）：衔星巨兽掉，和凛羽共用一次掉落判定与保底（G.UNIQUE_ALT）。没有专属烬铸技：拿着它时武器技秘弹连射的属性固定为混沌。
    // 机制「渊口」见 G.VOID_MOUTH
    xingshi: {
      name: '星蚀', base: 2, boss: 'behemoth', bossZone: 'rift', mech: 'void', mechName: '渊口',
      lines: [{ id: 'incChaos', k: [1.6, 2.2] }, { id: 'addChaos', k: [1.2, 1.6] }, { id: 'bindAil', k: [1.3, 1.8] }, { id: 'speed', k: [1.0, 1.4] }],
      lore: '一颗烧空的坠星。',
    },
  };
  G.UNIQUE_IDS = Object.keys(G.UNIQUES);
  G.UNIQUE_BY_BOSS = {};
  // 同一个首领的第二把（及以后的）烬铸：首领 → [烬铸 id]。掉落判定次数与保底不变，掉了之后一半给 UNIQUE_BY_BOSS 的那把、一半给这里的（见 game.js 的 uniqueDrop）
  G.UNIQUE_ALT = {};
  // 首领 → 它掉的烬铸 id。boss 不在 G.BOSSES 里时（新首领还没定名）按 bossZone 取那个区域的首领（game.js 启动时再对一遍）
  // 实在对不上（那个首领还不存在）时：U.boss 暂时指向最后一个区域的首领（只为界面能显示），但不登记掉落
  G.syncUniqueBosses = function () {
    for (const k of Object.keys(G.UNIQUE_BY_BOSS)) delete G.UNIQUE_BY_BOSS[k];
    for (const k of Object.keys(G.UNIQUE_ALT)) delete G.UNIQUE_ALT[k];
    const B = G.BOSSES || {};
    for (const id of G.UNIQUE_IDS) {
      const U = G.UNIQUES[id];
      if (U.boss0 === undefined) U.boss0 = U.boss;
      let b = U.boss0;
      if (!B[b] && U.bossZone && G.ZONES) {
        const z = G.ZONES.find((zz) => zz.id === U.bossZone) || (G.ZONES.length > 4 ? G.ZONES[4] : null);
        if (z && B[z.boss]) b = z.boss;
      }
      if (B[b] && !G.UNIQUE_BY_BOSS[b]) {
        U.boss = b;
        G.UNIQUE_BY_BOSS[b] = id;
      } else if (B[b]) {
        U.boss = b;
        (G.UNIQUE_ALT[b] = G.UNIQUE_ALT[b] || []).push(id);
      } else if (!B[b] && G.ZONES && G.ZONES.length) {
        U.boss = G.ZONES[G.ZONES.length - 1].boss;
      }
    }
  };
  G.syncUniqueBosses();
  // 掉率：层级 1 为 chance[1]（15%），层级 2 起 chance[2]（25%）；首领连续 pity（2）次没掉它的武器，下一次必掉
  // （最晚第 3 次击杀，掉了就清零）。五个首领各掉一把：巨像 → 熔芯，霜织者 → 三相之心，监察者 → 烬断，烬渊之主 → 万魂旗，第五区首领 → 凛羽
  G.UNIQUE_DROP = { chance: [0, 0.15, 0.25], pity: 2 };
  G.uniqueChance = (tier) => (tier >= 2 ? G.UNIQUE_DROP.chance[2] : tier >= 1 ? G.UNIQUE_DROP.chance[1] : 0);
  // 机制数值（平衡机器人量过：对位构筑比同物品等级「6 条最高阶词缀取中值」的顶级稀有快约两到三成）：
  // 残刃：max 层引爆，mult 倍武器伤害（必定暴击），波及 r 米内别的敌人 splash 倍；带残刃的敌人倒下，残刃飞到 jump 米内最近的敌人身上
  //   （拿着烬断时 R 上是烬铸技「千刃归烬」，不再是瞬断；它收刀时把残刃吃掉换成额外伤害）
  // 三相共鸣：半径 r、另外两种元素各灌 k 条；refresh：已感电 / 冰缓的续满时间；heat：没攒过火焰伤害的敌人被灌爆时按源头的火焰伤害爆燃；
  //   grow：拿着它时首领因正常触发而变高的阈值 × grow（0 = 不变高）
  // 魂火轮回：魂火 k 倍最大生命、半径 r；继承武器伤害的比例最多 × inherit（gated：提高的部分按武器物品等级的继承折算走）；
  //   free：自动召唤不耗魔力
  G.MARK = { max: 5, mult: 11, r: 2.5, splash: 0.3, jump: 5 };
  G.TRI = { r: 5, k: 0.75, refresh: true, heat: true, grow: 0 };
  G.SOULFIRE = { k: 0.15, r: 3, inherit: 1.5, gated: true, free: true };
  // 机制说明按上面的数值写（改数值时说明跟着变）
  const pc = (x) => Math.round(x * 100) + '%';
  G.UNIQUES.jinduan.mechDesc = '暴击留下残刃；叠满 ' + G.MARK.max + ' 道引爆，造成 ' + pc(G.MARK.mult) + ' 武器伤害的物理伤害（必定暴击），' + G.MARK.r + ' 米内其他敌人受到其中 ' + pc(G.MARK.splash) + '。';
  G.UNIQUES.jinduan.mechAlt = '带着残刃的敌人倒下时，残刃飞到 ' + G.MARK.jump + ' 米内最近的敌人身上。';
  G.UNIQUES.sanxiang.mechDesc = '任何敌人触发冻结、爆燃或感电时，' + G.TRI.r + ' 米内的敌人获得另外两种元素各 ' + pc(G.TRI.k) + ' 条异常值。' +
    (G.TRI.grow < 1 ? '首领的异常阈值不再变高。' : '');
  G.UNIQUES.sanxiang.mechAlt = '包括触发者自己。已在感电或冰缓中的改为续满时间；被灌爆的爆燃沿用源头的火焰伤害；共鸣灌满的异常不再引发共鸣。';
  G.UNIQUES.wanhun.mechDesc = '召唤物倒下时化作魂火，对 ' + G.SOULFIRE.r + ' 米内的敌人造成它最大生命 ' + pc(G.SOULFIRE.k) + ' 的火焰伤害。自动召唤不耗魔力。召唤物继承的武器伤害' +
    (G.SOULFIRE.gated ? '最多' : '') + '提高 ' + pc(G.SOULFIRE.inherit - 1) + '。';
  G.UNIQUES.wanhun.mechAlt = G.SOULFIRE.gated ? '继承的加成和继承本身一样，按武器的物品等级折算。' : '';
  // 熔芯弹：每一轮（6 发）的最后一发必定暴击，命中时在目标处炸开半径 r、mult 倍伤害的火焰爆炸（不伤目标本身）
  G.CORE_ROUND = { r: 2.5, mult: 0.8 };
  // 碎晶连跳（凛羽）：普攻的冰晶（basic_emberbow.spark）每跳额外灌入 ignite 条冰霜异常值
  G.EMBER_MECH = { ignite: 0.12 };
  G.UNIQUES.rongxin.mechDesc = '每轮最后一发必定暴击，并在命中处炸开，对 ' + G.CORE_ROUND.r + ' 米内其他敌人造成 ' + pc(G.CORE_ROUND.mult) + ' 的火焰伤害。';
  G.UNIQUES.jinyu.mechDesc = '普攻的冰晶每跳额外灌入 ' + pc(G.EMBER_MECH.ignite) + ' 条冰霜异常值。';
  // 渊口（星蚀）：任何敌人触发渊缚时，脚下张开一道小黑洞：半径 radius、持续 dur 秒、牵引 × pull、每跳伤害按你的黑洞宝石的 dmg 倍
  //   （没学黑洞时按同等级的基础值）；同时最多 max 道，每 gap 秒最多新开一道
  G.VOID_MOUTH = { radius: 2.4, dur: 1.5, pull: 0.6, dmg: 0.5, max: 2, gap: 2 };
  G.UNIQUES.xingshi.mechDesc = '敌人触发渊缚时，脚下张开渊口：' + G.VOID_MOUTH.dur + ' 秒的小黑洞，半径 ' + G.VOID_MOUTH.radius + ' 米，牵引为黑洞的 ' + pc(G.VOID_MOUTH.pull) +
    '，每跳伤害为你黑洞的 ' + pc(G.VOID_MOUTH.dmg) + '。秘弹连射固定为混沌。';
  G.UNIQUES.xingshi.mechAlt = '同时最多 ' + G.VOID_MOUTH.max + ' 道，每 ' + G.VOID_MOUTH.gap + ' 秒最多新开一道。';
  // 分解烬铸武器固定得到的通货
  G.UNIQUE_SALVAGE = { exalt: 2, chaos: 2, divine: 1, chisel: 1 };

  // ---------- 渊契（稀有度 4）----------
  // 只出在非武器的 7 个部位，和烬铸武器是两条线（不进 G.UNIQUES：syncUniqueBosses 不会把它们挂到首领的烬铸掉落上）。
  // 词缀行固定，数值按烬铸的同一套规则在掉落时的物品等级上掷（G.relicLineRange）；裸属性比同物品等级的好稀有少一行，强在机制。
  // base：这个部位 BASES 里的下标；src：掉落来源（boss 区域首领 / enc 异兆 / seal 烈印 / pinnacle 熄烛者，见 G.RELIC_DROP）；
  // boss / enc：具体哪个首领、哪种异兆。机制按 id 判断（game.js「渊契」一节的 P.relic[id]），数值在 G.RELIC_MECH
  G.RELICS = {
    panzhong: {
      name: '磐踵', slot: 'boots', base: 0, src: 'boss', boss: 'golem', mechName: '踏震',
      lines: [{ id: 'moveSpeed', k: [0.9, 1.2] }, { id: 'life', k: [1.0, 1.4] }, { id: 'armour', k: [1.0, 1.3] }],
      lore: '从巨像脚上扒下来的。',
    },
    nuchao: {
      name: '怒潮', slot: 'gloves', base: 0, src: 'boss', boss: 'warden', mechName: '蓄潮',
      lines: [{ id: 'incPhys', k: [1.0, 1.4] }, { id: 'speed', k: [0.9, 1.2] }, { id: 'life', k: [0.9, 1.2] }],
    },
    duanyue: {
      name: '断岳', slot: 'belt', base: 0, src: 'enc', enc: 'trial', mechName: '崩势',
      lines: [{ id: 'life', k: [1.1, 1.5] }, { id: 'armour', k: [1.0, 1.3] }, { id: 'resCold', k: [1.0, 1.3] }],
      lore: '带扣是块山石。',
    },
    qianmu: {
      name: '千目', slot: 'helm', base: 0, src: 'enc', enc: 'wanderer', mechName: '必然',
      lines: [{ id: 'crit', k: [1.3, 1.8] }, { id: 'life', k: [0.9, 1.2] }, { id: 'resLight', k: [1.0, 1.3] }],
      lore: '七只眼，轮流睁着。',
    },
    huixuan: {
      name: '回旋', slot: 'amulet', base: 0, src: 'boss', boss: 'weaver', mechName: '回旋',
      lines: [{ id: 'critMulti', k: [1.0, 1.4] }, { id: 'incPhys', k: [1.0, 1.3] }],
      lore: '扔出去的总会回来。',
    },
    zhuixing: {
      name: '陨织袍', slot: 'body', base: 0, src: 'seal', mechName: '星雨',
      lines: [{ id: 'life', k: [1.0, 1.4] }, { id: 'resFire', k: [1.2, 1.6] }, { id: 'lifeRegen', k: [1.0, 1.3] }],
      lore: '下摆缀满了星星。',
    },
    dianqiao: {
      name: '电桥', slot: 'ring', base: 2, src: 'enc', enc: 'guard', mechName: '电桥',
      lines: [{ id: 'incLight', k: [1.2, 1.6] }, { id: 'addLight', k: [1.0, 1.3] }, { id: 'mana', k: [1.0, 1.3] }],
    },
    yibian: {
      name: '异变', slot: 'amulet', base: 2, src: 'enc', enc: 'ember', mechName: '混相',
      lines: [{ id: 'incFire', k: [0.7, 1.0] }, { id: 'incCold', k: [0.7, 1.0] }, { id: 'incLight', k: [0.7, 1.0] }],
    },
    haiwang: {
      name: '骸王冠', slot: 'helm', base: 0, src: 'boss', boss: 'lord', mechName: '独骸',
      lines: [{ id: 'minionLife', k: [1.2, 1.6] }, { id: 'life', k: [1.0, 1.3] }, { id: 'resFire', k: [1.0, 1.3] }],
      lore: '王只能有一个。',
    },
    tongshang: {
      name: '同殇甲', slot: 'body', base: 0, src: 'enc', enc: 'box', mechName: '同殇',
      lines: [{ id: 'minionLife', k: [1.2, 1.6] }, { id: 'life', k: [1.0, 1.4] }, { id: 'armour', k: [1.0, 1.3] }],
    },
    zhaohun: {
      name: '招魂带', slot: 'belt', base: 0, src: 'enc', enc: 'echo', mechName: '随影',
      lines: [{ id: 'life', k: [1.0, 1.3] }, { id: 'minionLife', k: [1.0, 1.4] }, { id: 'mana', k: [1.0, 1.3] }],
      lore: '铃一响，都会赶来。',
    },
    yinli: {
      name: '引力核', slot: 'ring', base: 3, src: 'boss', boss: 'behemoth', mechName: '随核',
      lines: [{ id: 'incChaos', k: [1.2, 1.6] }, { id: 'addChaos', k: [1.0, 1.3] }, { id: 'mana', k: [1.0, 1.3] }],
      lore: '个头小，分量重。',
    },
    yuanfu: {
      name: '渊缚链', slot: 'gloves', base: 0, src: 'seal', mechName: '锁链',
      lines: [{ id: 'addChaos', k: [1.2, 1.6] }, { id: 'bindAil', k: [1.2, 1.6] }, { id: 'life', k: [1.0, 1.3] }],
    },
    // 巅峰专属（只有熄烛者掉，D5）：不进 G.RELIC_IDS（随机掉落、拾烬客都不出），图鉴另列在普通渊契后面（G.RELIC_CODEX）
    xizhu: {
      // rqv 2：巅峰改版（机制「暗域」、四行词缀，冰霜抗性换成生命回复、新增专属的暗域增伤）。
      // 旧存档里的熄烛冠读档时按原来的分位原地升级，见 game.js 的 migrateXizhu
      name: '熄烛冠', slot: 'helm', base: 0, src: 'pinnacle', pinnacle: true, mechName: '暗域', rqv: 2,
      lines: [{ id: 'life', k: [1.6, 2.0] }, { id: 'crit', k: [1.8, 2.3] }, { id: 'lifeRegen', k: [1.4, 1.8] }, { id: 'darkDmg', k: [1, 1] }],
      lore: '只剩一根烛芯在冒烟。',
    },
    shuangsheng: {
      name: '双生坠', slot: 'amulet', base: 0, src: 'pinnacle', pinnacle: true, mechName: '双生',
      lines: [{ id: 'incAll', k: [1.0, 1.4] }, { id: 'speed', k: [1.0, 1.3] }],
      lore: '一半暖，一半冷。',
    },
  };
  // 普通渊契（随机掉落、图鉴、图标都按这个列表）；巅峰专属另列
  G.RELIC_IDS = Object.keys(G.RELICS).filter((id) => !G.RELICS[id].pinnacle);
  G.RELIC_PINNACLE = Object.keys(G.RELICS).filter((id) => G.RELICS[id].pinnacle);
  G.RELIC_CODEX = G.RELIC_IDS.concat(G.RELIC_PINNACLE); // 图鉴、图标按这个列表（巅峰专属排在最后）
  // 掉落来源：src 是各来源的总开关（boss 现在开；enc 异兆、seal 烈印等 D4 / D3 上线再开；trader 拾烬客的货架随 D4）。
  // boss：每个区域首领一件、和烬铸分开掷，几率和保底跟烬铸（G.UNIQUE_DROP）一样：层级 1 为 chance[1]（15%）、层级 2 起 chance[2]（25%），
  //   烈印（W ≥ 6）再 × sealMul、最终几率不超过 sealCap（35%）；连续 pity（2）次没掉，下一次必掉（按渊契 id 计）
  // enc：异兆成功才掷（层级 ≥ 1，15%、保底 3）；seal：烈印下击杀区域首领（10%、保底 3，陨织袍 / 渊缚链各半，按 'seal' 一起计保底）；trader：拾烬客货架（层级 ≥ 2）摆一件的几率
  // 旧存档里攒下的保底计数读档时截到新的 pity（见 game.js 的 sanitize），超过的下一次就必掉
  G.RELIC_DROP = {
    src: { boss: true, enc: false, seal: false, trader: false },
    boss: { chance: [0, 0.15, 0.25], pity: 2 },
    enc: { chance: 0.15, pity: 3, minTier: 1 },
    seal: { chance: 0.1, pity: 3, minW: 6, ids: ['zhuixing', 'yuanfu'] },
    trader: { chance: 0.06, minTier: 2 },
    // 熄烛者（D5）：巅峰专属（熄烛冠 / 双生坠各半）首杀必掉，之后 chance、连续 pity 次没掉下一次必掉（保底按 'pinnacle' 存在 save.pinnacle.pity）；
    // 另外 normal 的几率掉一件随机普通渊契
    pinnacle: { chance: 0.3, pity: 3, normal: 0.2 },
    sealMul: 1.5,
    sealCap: 0.35,
  };
  // 异兆的名字（图鉴里写来源用；D4 的 G.ENCOUNTERS 上线后以那边为准）
  G.RELIC_ENC_NAME = { guard: '守隙', wanderer: '游荡者', trial: '试锋', box: '缚匣', echo: '残影', ember: '落烬' };
  G.RELIC_BY_BOSS = {};
  G.RELIC_BY_ENC = {};
  for (const id of G.RELIC_IDS) {
    const R = G.RELICS[id];
    if (R.src === 'boss') G.RELIC_BY_BOSS[R.boss] = id;
    if (R.src === 'enc') G.RELIC_BY_ENC[R.enc] = id;
  }
  G.relicChance = (tier) => (tier >= 2 ? G.RELIC_DROP.boss.chance[2] : tier >= 1 ? G.RELIC_DROP.boss.chance[1] : 0);
  // 机制数值（game.js 的「渊契」一节读这里；改数值时说明跟着变）：
  // 踏震 panzhong：翻滚落地震地，半径 r（吃范围）、mult 倍武器伤害（物理攻击，吃你的加成、不吃辅助）、削架势 poise、击退 kb；两次至少隔 gap 秒；翻滚冷却 × (1 + rollCd)
  // 蓄潮 nuchao：旋风斩每跳只打 pulse 倍、攒 1 层（上限 max）；松手 / 翻滚 / 被打断时以你为中心炸开，半径 = 旋风半径 × r，每层 burst 倍满额一跳
  // 崩势 duanyue：精英 / 首领被打出破绽时，r 米内的普通怪同时破绽 t 秒（停手、受伤 × 破绽倍率）；处决时目标 sweepR 米内处于破绽的敌人各吃处决伤害的 sweep
  // 必然 qianmu：命中把暴击率加进计数器，满 100 必暴并扣 100；暴击伤害 critMulti（点）
  // 回旋 huixuan：投射物到射程尽头或第一次撞墙时折返，回程 back 倍、可再中；射程 × range
  // 星雨 zhuixing：陨火每 iv 秒（吃出手速度和迅捷，节流缩短间隔）自动落在 r 米内敌人最密处，伤害 × mult、半径 × area，保留 reserve% 最大魔力、不耗魔力
  // 电桥 dianqiao：链雷每跳在前后两个目标之间留一道 t 秒、宽 w 米的电桥，每 tick 秒对碰到的敌人造成一跳的 mult 倍闪电伤害；同时最多 max 道
  // 混相 yibian：火 / 冰 / 雷灌进同一条异常值，累积速度 rate，满了三种效果各 × k
  // 独骸 haiwang：仆从上限固定 1，多出来的上限每 1 个 +perDmg 伤害、+perLife 生命；骸王体型 × scale、生命 × life、伤害 × dmg，横斩带 cleave 个、arc 度，牵制 hold 只，受伤 −dr%
  // 同殇 tongshang：你受到的伤害 share 转给 r 米内最近的召唤物；召唤物最大生命 +life%；召唤物倒下时你回复它最大生命的 heal
  // 随影 zhaohun：翻滚 delay 秒后召唤物闪到你落点周围、各砸一下（半径 r，各自一击 × mult，守像 × multBig）；翻滚冷却 × (1 + rollCd)
  // 随核 yinli：黑洞以你为中心跟着你走；持续 × dur、半径 × radius、牵引 × pull（首领不变）、每跳伤害 × dmg
  // 锁链 yuanfu：同一时刻处于渊缚的敌人连成一串（最多 max 个），其中一个受到你的伤害，其余每个分到 share
  // 暗域 xizhu（巅峰，熄烛冠）：你身周 r 米、每个召唤物身周 mr 米是暗域。域内的敌人造成的伤害 × (1 − weak)（首领 weakBoss，熄烛者不吃）；
  //   暗域增伤（专属词缀 darkDmg）：你的伤害对所有敌人、召唤物的伤害对域内的敌人 × (1 + darkDmg%)；
  //   far 米外的怪不会因为距离醒来；已醒的怪在 far 米外 lose 秒看不到你就失去目标、回原地（首领不吃）；还没被发现（没醒）时你的第一击必定暴击；
  //   暖光半径 × (1 − lamp)，和幽晦叠加时雾近端不低于 fogMin
  // 双生 shuangsheng（巅峰）：选了刻式的技能每次施放在 A / B 之间交替（光环、召唤除外），交替出来的那一下（不是你选的那一种）伤害 × (1 + dmg)
  G.RELIC_MECH = {
    // r 4.5（设计稿 3.0）：从近战距离朝目标翻滚，落地离目标约 4 米，3 米够不着翻过去的那个目标
    panzhong: { r: 4.5, mult: 1.1, poise: 28, kb: 1.2, gap: 0.8, rollCd: 0.3 },
    nuchao: { pulse: 0.55, max: 12, burst: 0.5, r: 1.4 },
    duanyue: { r: 8, t: 2.5, sweepR: 3, sweep: 0.35 },
    qianmu: { critMulti: -15 },
    huixuan: { back: 0.6, range: 0.8 },
    zhuixing: { iv: 1.8, r: 12, mult: 0.4, area: 0.85, reserve: 20 },
    dianqiao: { t: 1.5, w: 0.9, tick: 0.25, mult: 0.18, max: 8 },
    yibian: { rate: 1.27, k: 0.6 },
    haiwang: { perDmg: 0.35, perLife: 0.4, scale: 1.5, life: 3, dmg: 2.9, cleave: 6, arc: 220, hold: 5, dr: 15 },
    tongshang: { share: 0.3, r: 10, life: 25, heal: 0.08 },
    zhaohun: { delay: 0.15, r: 1.6, mult: 1.5, multBig: 1.0, rollCd: 0.15 },
    yinli: { dur: 0.8, radius: 0.85, pull: 0.75, dmg: 1.2 },
    yuanfu: { max: 6, share: 0.2 },
    xizhu: { r: 8, mr: 2.5, weak: 0.2, weakBoss: 0.1, far: 9, lose: 3, lamp: 0.4, fogMin: 14 },
    shuangsheng: { dmg: 0.1 },
  };
  // 机制说明（物品提示、图鉴用），按上面的数值拼
  G.relicDescs = function () {
    const M = G.RELIC_MECH, R = G.RELICS;
    const a = M.panzhong, b = M.nuchao, c = M.duanyue, d = M.huixuan, f = M.zhuixing, g = M.dianqiao, h = M.yibian, k = M.haiwang, t = M.tongshang, z = M.zhaohun, y = M.yinli, u = M.yuanfu;
    R.panzhong.mechDesc = '翻滚落地时震地：对 ' + a.r + ' 米内的敌人造成 ' + pc(a.mult) + ' 武器伤害的物理攻击伤害，削架势并击退。翻滚冷却延长 ' + pc(a.rollCd) + '。';
    R.panzhong.mechAlt = '半径吃范围加成；伤害吃你的伤害加成，不吃辅助宝石。两次至少间隔 ' + a.gap + ' 秒。';
    R.nuchao.mechDesc = '旋风斩改为蓄力：按住时每跳只有 ' + pc(b.pulse) + ' 伤害并攒 1 层潮势（最多 ' + b.max + ' 层）；松手时炸开，每层造成一跳满额的 ' + pc(b.burst) + '。';
    R.nuchao.mechAlt = '翻滚或被打断时同样炸开。爆炸以你为中心，半径为旋风斩的 ' + pc(b.r) + '。';
    R.duanyue.mechDesc = '精英或首领破绽时，' + c.r + ' 米内的普通怪一起破绽 ' + c.t + ' 秒。处决时，目标 ' + c.sweepR + ' 米内破绽中的敌人各受处决伤害的 ' + pc(c.sweep) + '。';
    R.qianmu.mechDesc = '暴击不再随机：命中时累积暴击率，满 100% 必定暴击。暴击伤害 ' + M.qianmu.critMulti + '%。';
    R.qianmu.mechAlt = '暴击后扣掉 100%，多出的留着。必定暴击的招式照旧必暴，不动计数。召唤物不受影响。';
    R.huixuan.mechDesc = '飞刃、弓箭和左轮子弹到射程尽头或第一次撞墙时折返，回程伤害 ' + pc(d.back) + '，可再次命中。射程缩短 ' + pc(1 - d.range) + '。';
    R.huixuan.mechAlt = '弓箭含普攻。机炮、会爆炸的投射物和万矢分出的箭不会折返。';
    R.zhuixing.mechDesc = '陨火改为自动：放在技能栏上时每 ' + f.iv + ' 秒落在 ' + f.r + ' 米内敌人最密处，伤害 ' + pc(f.mult) + '、半径 ' + pc(f.area) + '。不耗魔力，改为保留 ' + f.reserve + '% 最大魔力。';
    R.zhuixing.mechAlt = '不能手动施放。间隔受出手速度和迅捷影响，节流缩短间隔。自动落下的不算施放，回响不生效。';
    R.dianqiao.mechDesc = '链雷每跳在前后两个目标间留下电桥 ' + g.t + ' 秒，每 ' + g.tick + ' 秒对碰到的敌人造成一跳 ' + pc(g.mult) + ' 的闪电伤害。最多 ' + g.max + ' 道。';
    R.dianqiao.mechAlt = '电桥累积闪电异常值，但不引发感电电弧。超过上限时顶掉最老的。';
    R.yibian.mechDesc = '火焰、冰霜、闪电灌进同一条「混相」异常值；满时同时触发爆燃、冻结和感电，效果各 ' + pc(h.k) + '。';
    R.yibian.mechAlt = '首领改为重度冰缓，阈值每次只提高一次。佩戴时三相之心的共鸣不生效。';
    R.haiwang.mechDesc = '烬骸仆从上限固定为 1：骸王生命 ×' + k.life + '、伤害 ×' + k.dmg + '，横斩 ' + k.arc + '° 带到 ' + k.cleave + ' 个敌人，受到的伤害减少 ' + k.dr + '%。多出的仆从上限每个折成 +' + pc(k.perDmg) + ' 伤害、+' + pc(k.perLife) + ' 生命。';
    R.haiwang.mechAlt = '骸王体型更大，同时牵制 ' + k.hold + ' 只小怪。多出的上限来自群聚、天赋、护符、万魂旗。';
    R.tongshang.mechDesc = '你受到伤害的 ' + pc(t.share) + ' 转给 ' + t.r + ' 米内最近的召唤物。召唤物最大生命提高 ' + t.life + '%；召唤物倒下时，你回复它最大生命的 ' + pc(t.heal) + '。';
    R.tongshang.mechAlt = '转过去的伤害按召唤物的减伤结算。';
    R.zhaohun.mechDesc = '翻滚时召唤物闪到你落点周围，各砸一下（半径 ' + z.r + ' 米，一击的 ' + pc(z.mult) + '，守像 ' + pc(z.multBig) + '），削减架势。翻滚冷却延长 ' + pc(z.rollCd) + '。';
    R.zhaohun.mechAlt = '召唤物在翻滚 ' + z.delay + ' 秒后到达。';
    R.yinli.mechDesc = '黑洞以你为中心跟着你移动：持续 ' + pc(y.dur) + '、半径 ' + pc(y.radius) + '、牵引 ' + pc(y.pull) + '，每跳伤害 ' + pc(y.dmg) + '。';
    R.yinli.mechAlt = '首领的牵引不变。冷却不变。星蚀的渊口照常在敌人脚下张开。';
    R.yuanfu.mechDesc = '渊缚中的敌人连成一串（最多 ' + u.max + ' 个）：其中一个受你伤害时，其余各分到 ' + pc(u.share) + '。';
    R.yuanfu.mechAlt = '分到的伤害不暴击、不触发命中效果、不累积异常值、不带黑焰。渊缚结束即断开。首领不会被渊缚。';
    for (const id of ['nuchao', 'zhuixing', 'dianqiao', 'haiwang', 'yinli']) R[id].mechAlt = (R[id].mechAlt || '') + '只改原式，刻式 A / B 下不生效。';
    const x = M.xizhu, s2 = M.shuangsheng;
    R.xizhu.mechDesc = '身周 ' + x.r + ' 米是暗域：域内敌人伤害降低 ' + pc(x.weak) + '。暗域增伤：你的伤害对所有敌人生效，召唤物只对域内敌人生效。';
    R.xizhu.mechAlt = '召唤物身周 ' + x.mr + ' 米也算暗域。首领在域内只降低 ' + pc(x.weakBoss) + '，熄烛者不受影响。' + x.far + ' 米外的怪不会因距离醒来；已醒的怪在 ' + x.far +
      ' 米外连续 ' + x.lose + ' 秒看不到你就失去目标（首领不会）。对没发现你的敌人第一击必定暴击。暖光半径缩小 ' + pc(x.lamp) + '。';
    R.shuangsheng.mechDesc = '有刻式的技能每次施放在 A、B 间交替，不是你选的那一下伤害提高 ' + pc(s2.dmg) + '。';
    R.shuangsheng.mechAlt = '光环和召唤技能不交替，始终是你选的那种。宝石 ' + G.VARIANT_LVL + ' 级并选过刻式才生效；已放出的黑洞、旋风等按施放时的刻式走完。';
  };
  G.relicDescs();
  // 分解渊契固定得到的通货（同烬铸）
  G.RELIC_SALVAGE = { exalt: 2, chaos: 2, divine: 1, chisel: 1 };

  G.RARE_A = ['灰烬', '霜骨', '雷鸣', '渊影', '残月', '裂魂', '荆棘', '苍白', '余烬', '暮光', '锈蚀', '血誓'];
  G.RARE_B = ['之握', '之誓', '之眼', '壁垒', '挽歌', '獠牙', '回响', '枷锁', '之冠', '低语', '印记', '之怒'];

  // ---------- 通货 ----------
  G.CURRENCY = {
    dust: { name: '微光尘', color: '#9fb4ff', w: 34, desc: '把普通物品升为魔法物品，带 1 条词缀' },
    augment: { name: '增幅尘', color: '#7fe0c0', w: 22, desc: '给只有 1 条词缀的魔法物品追加 1 条词缀' },
    alch: { name: '点金石', color: '#ffd75e', w: 10, desc: '把普通物品升为稀有物品，带 4 条词缀' },
    regal: { name: '冠冕石', color: '#ffb46a', w: 12, desc: '把魔法物品升为稀有物品，并追加 1 条词缀' },
    exalt: { name: '升华石', color: '#f2e6b0', w: 13, desc: '给稀有物品追加 1 条词缀（最多 6 条）' },
    chaos: { name: '乱流石', color: '#d98cff', w: 13, desc: '移除稀有物品的 1 条随机词缀，再追加 1 条新词缀' },
    chisel: { name: '琢刻石', color: '#a6e36a', w: 7, desc: '魔法或稀有物品：挑一条词缀重洗成同类的另一条，其余不变' },
    divine: { name: '重铸石', color: '#ff8fa8', w: 6, desc: '重新随机物品所有词缀的数值' },
  };
  // 首领第一次倒下时，在随机通货之外保底给的通货
  G.BOSS_FIRST_CUR = ['exalt', 'chaos'];
  // 分解稀有物品时额外给出升华石或乱流石（各占一半）的几率
  G.SALVAGE_RARE_HI = 0.2;
  G.CUR_IDS = Object.keys(G.CURRENCY);

  // ---------- 无铭技能宝石：没有刻下技能的空白宝石，带等级；在技能页挑一个技能学会，或给等级更低的已学技能升级 ----------
  // color 是名牌 / 界面里的珍珠色（和青色的技能宝石、白色的辅助宝石区分开）；crystal 是地上那枚晶体本身的素银色
  G.BLANK_GEM = {
    name: '无铭技能宝石', short: '无铭宝石', color: '#e2ccff', crystal: '#dfe6f0',
    desc: '在技能页（G）用它学会任一技能，或把更低等级的已学技能升到它的等级',
  };

  // ---------- 天赋盘 ----------
  (function buildTree() {
    const U = 60;
    const T = (G.TREE = { start: { id: 'start', x: 0, y: 0, name: '起点', kind: 'start', arm: 'n', stats: {}, links: [] } });
    const arms = [
      {
        key: 's', color: '#e2705a', ang: 150,
        m: [['体魄', { life: 15 }], ['膂力', { incPhys: 8 }], ['体魄', { life: 15 }], ['铁骨', { incArmour: 15 }], ['膂力', { incPhys: 10 }], ['坚韧', { incLife: 5 }]],
        l: [['膂力', { incPhys: 8 }], ['横扫', { area: 8 }], ['屠戮者', { incPhys: 25, area: 12 }]],
        r: [['体魄', { life: 15 }], ['愈合', { lifeRegen: 2 }], ['不屈', { incLife: 10, lifeRegen: 4, armour: 60 }]],
        k: ['铁壁', { lessTaken: 25, moreDmg: -12 }],
      },
      {
        key: 'd', color: '#7ed67a', ang: 30,
        m: [['敏捷', { speed: 3 }], ['锐眼', { crit: 10 }], ['轻步', { moveSpeed: 3 }], ['敏捷', { speed: 4 }], ['锐眼', { crit: 12 }], ['猎手', { incAll: 6 }]],
        l: [['锐眼', { crit: 10 }], ['要害', { critMulti: 12 }], ['鹰眼', { crit: 30, critMulti: 25 }]],
        r: [['轻步', { moveSpeed: 3 }], ['敏捷', { speed: 4 }], ['疾风', { moveSpeed: 8, speed: 8, dodgeCd: 25 }]],
        k: ['玻璃大炮', { moreDmg: 35, moreLife: -25 }],
      },
      {
        key: 'i', color: '#6fb2ff', ang: 210,
        m: [['心智', { mana: 15 }], ['元素亲和', { incElem: 8 }], ['冥想', { manaRegen: 15 }], ['元素亲和', { incElem: 10 }], ['延展', { area: 8 }], ['博识', { incMana: 8 }]],
        l: [['元素亲和', { incElem: 8 }], ['侵蚀', { ailment: 8 }], ['元素使', { incElem: 25, ailment: 15 }]],
        r: [['心智', { mana: 15 }], ['精算', { costReduce: 5 }], ['奥能涌流', { mana: 40, manaRegen: 30, costReduce: 10 }]],
        k: ['以血为引', { bloodMagic: 1, moreDmg: 20 }],
      },
    ];
    function add(arm, id, r, off, parent, name, stats, kind) {
      const a = ((arm.ang + off) * Math.PI) / 180;
      T[id] = { id, x: Math.cos(a) * r * U, y: Math.sin(a) * r * U, name, stats, kind: kind || 'small', arm: arm.key, color: arm.color, links: [parent] };
      T[parent].links.push(id);
    }
    for (const arm of arms) {
      const k = arm.key;
      let prev = 'start';
      arm.m.forEach((n, i) => {
        add(arm, k + 'm' + i, 1.35 + i, 0, prev, n[0], n[1]);
        prev = k + 'm' + i;
      });
      add(arm, k + 'k', 7.7, 0, prev, arm.k[0], arm.k[1], 'keystone');
      add(arm, k + 'l0', 3.1, -21, k + 'm1', arm.l[0][0], arm.l[0][1]);
      add(arm, k + 'l1', 4.1, -25, k + 'l0', arm.l[1][0], arm.l[1][1]);
      add(arm, k + 'l2', 5.2, -26, k + 'l1', arm.l[2][0], arm.l[2][1], 'notable');
      add(arm, k + 'r0', 4.1, 19, k + 'm2', arm.r[0][0], arm.r[0][1]);
      add(arm, k + 'r1', 5.1, 22, k + 'r0', arm.r[1][0], arm.r[1][1]);
      add(arm, k + 'r2', 6.2, 22, k + 'r1', arm.r[2][0], arm.r[2][1], 'notable');
    }
    // 统御（召唤物）支路：朝右上，和另外三支成「X」形四等分，基石同样落在外圈上。
    // 主干 5 个节点 + 两条各 2 个节点的旁支，末端是基石「万骸之主」
    const mArm = { key: 'm', color: '#4fe3c8', ang: 330 };
    const mm = [['统御', { minionDmg: 10 }], ['骸骨坚韧', { minionLife: 15 }], ['统御', { minionDmg: 10 }], ['灵契', { minionDmg: 10, minionLife: 10 }], ['统御', { minionDmg: 8 }]];
    let prev = 'start';
    mm.forEach((n, i) => {
      add(mArm, 'mm' + i, 1.35 + i * 1.2, 0, prev, n[0], n[1]);
      prev = 'mm' + i;
    });
    add(mArm, 'mk', 7.7, 0, prev, '万骸之主', { minionCap: 1, minionMore: 25, ownLess: 30 }, 'keystone');
    add(mArm, 'ml0', 3.3, -21, 'mm1', '迅令', { speed: 4, mana: 10 });
    add(mArm, 'ml1', 4.4, -25, 'ml0', '亡者狂潮', { minionSpeed: 10, minionDmg: 8 }, 'notable');
    add(mArm, 'mr0', 4.5, 19, 'mm2', '心智', { mana: 20 });
    add(mArm, 'mr1', 5.6, 22, 'mr0', '骸军', { minionCap: 1, minionLife: 15 }, 'notable');

    // ---------- 外圈（成长改版加的 68 个节点）----------
    // 上面 49 个节点的 id、位置和连线一个都没动：老存档点过的天赋原样有效。新节点只往外长：
    //   每条支路的两条旁支各再延伸 2–4 个节点（末端是核心天赋），再由两条外延小路汇到半径 10.6 处的第二个基石；
    //   相邻支路之间：上下两个大空隙各有一团「交汇」天赋（两头都能进），左右两个窄空隙各有一座桥。
    // 统御的两条外延就是「召唤物继承装备」的两条线：左边继承武器伤害，右边继承护甲 / 抗性 / 生命。
    // 满级 60 级约有 67 点，整个盘 117 个节点，点不满，要取舍。
    const ARMS = { s: arms[0], d: arms[1], i: arms[2], m: mArm };
    const OUTER = { key: 'o', color: '#e0be6e' };
    // 极坐标（半径 r × U，绝对角度 ang 度）放一个节点，links 是要连上的已有节点
    function at(arm, id, r, ang, name, stats, kind, links) {
      const a = (ang * Math.PI) / 180;
      T[id] = { id, x: Math.cos(a) * r * U, y: Math.sin(a) * r * U, name, stats, kind: kind || 'small', arm: arm.key, color: arm.color, links: [] };
      for (const l of links) link(id, l);
    }
    function link(a, b) {
      if (T[a].links.indexOf(b) < 0) T[a].links.push(b);
      if (T[b].links.indexOf(a) < 0) T[b].links.push(a);
    }
    // 三条经典支路的外延：off 是相对支路角度的偏移（l 旁支朝负方向、r 旁支朝正方向，和原来的旁支一致）
    const EXT = {
      s: {
        l: [['膂力', { incPhys: 8 }], ['体魄', { life: 20 }], ['碎骨', { incPhys: 20, poiseDmg: 25, area: 6 }]],
        r: [['铁骨', { incArmour: 15 }], ['铁甲', { armour: 120, incArmour: 30 }]],
        o: [['体魄', { life: 25 }], ['坚韧', { incLife: 6 }], ['铁骨', { incArmour: 15 }], ['愈合', { lifeRegen: 4 }]],
        k: ['不动如山', { lessTaken: 15, incArmour: 40, moveSpeed: -15, dodgeCd: -50 }],
      },
      d: {
        l: [['锐眼', { crit: 12 }], ['要害', { critMulti: 10 }], ['致命节奏', { crit: 25, critMulti: 20 }]],
        r: [['敏捷', { speed: 4 }], ['疾行', { moveSpeed: 6, speed: 6, dodgeCd: 15 }]],
        o: [['敏捷', { speed: 3 }], ['猎手', { incAll: 6 }], ['轻步', { moveSpeed: 3 }], ['锐眼', { crit: 12 }]],
        k: ['刃舞', { speed: 20, crit: 40, moreTaken: 15 }],
      },
      i: {
        l: [['元素亲和', { incElem: 8 }], ['侵蚀', { ailment: 8 }], ['元素共鸣', { incElem: 16, ailment: 10, area: 6 }]],
        r: [['心智', { mana: 20 }], ['深思', { incMana: 12, manaRegen: 25, costReduce: 5 }]],
        o: [['元素亲和', { incElem: 8 }], ['博识', { incMana: 6 }], ['冥想', { manaRegen: 15 }], ['延展', { area: 6 }]],
        k: ['元素过载', { moreElem: 30, resLoss: 20 }],
      },
    };
    for (const k of ['s', 'd', 'i']) {
      const arm = ARMS[k], e = EXT[k], A = arm.ang;
      const N = (j, n) => (j === n - 1 ? 'notable' : 'small');
      at(arm, k + 'l3', 6.3, A - 24, e.l[0][0], e.l[0][1], N(0, 3), [k + 'l2']);
      at(arm, k + 'l4', 7.4, A - 22, e.l[1][0], e.l[1][1], N(1, 3), [k + 'l3']);
      at(arm, k + 'l5', 8.5, A - 21, e.l[2][0], e.l[2][1], N(2, 3), [k + 'l4']);
      at(arm, k + 'r3', 7.3, A + 25, e.r[0][0], e.r[0][1], N(0, 2), [k + 'r2']);
      at(arm, k + 'r4', 8.4, A + 27, e.r[1][0], e.r[1][1], N(1, 2), [k + 'r3']);
      at(arm, k + 'o0', 9.4, A - 16, e.o[0][0], e.o[0][1], 'small', [k + 'l5']);
      at(arm, k + 'o1', 10.1, A - 8, e.o[1][0], e.o[1][1], 'small', [k + 'o0']);
      at(arm, k + 'o2', 9.4, A + 18, e.o[2][0], e.o[2][1], 'small', [k + 'r4']);
      at(arm, k + 'o3', 10.1, A + 9, e.o[3][0], e.o[3][1], 'small', [k + 'o2']);
      at(arm, k + 'k2', 10.6, A, e.k[0], e.k[1], 'keystone', [k + 'o1', k + 'o3']);
    }
    // 统御外延：左线继承武器伤害，右线继承护甲 / 抗性 / 生命，两线各自通向基石「器魂共鸣」。
    // 这两条线上只放继承属性、不放普通的召唤物伤害 / 生命：继承的武器伤害按物品等级折算，层级 0 的召唤师点进来几乎白点，
    // 不会因为天赋盘变大而在层级 0 变强（改版前统御只有 13 个节点，多出来的点只能去点通用节点）
    const M = mArm;
    at(M, 'ml2', 5.5, 303, '承锋', { mWeapon: 4 }, 'small', ['ml1']);
    at(M, 'ml3', 6.5, 303, '承锋', { mWeapon: 5 }, 'small', ['ml2']);
    at(M, 'ml4', 7.5, 304, '器灵', { mWeapon: 12 }, 'notable', ['ml3']);
    at(M, 'ml5', 8.5, 305, '承锋', { mWeapon: 5 }, 'small', ['ml4']);
    at(M, 'ml6', 9.5, 306, '兵魂', { mWeapon: 20 }, 'notable', ['ml5']);
    at(M, 'mr2', 6.6, 355, '骸甲', { mDef: 6 }, 'small', ['mr1']);
    at(M, 'mr3', 7.5, 355, '骸甲', { mDef: 8 }, 'small', ['mr2']);
    at(M, 'mr4', 8.4, 355, '承甲', { mDef: 20 }, 'notable', ['mr3']);
    at(M, 'mr5', 9.3, 354, '骸甲', { mDef: 8 }, 'small', ['mr4']);
    at(M, 'mr6', 10.2, 353, '同命', { mLife: 30 }, 'notable', ['mr5']);
    at(M, 'mo0', 10.3, 312, '承锋', { mWeapon: 5 }, 'small', ['ml6']);
    at(M, 'mo1', 10.9, 317, '承锋', { mWeapon: 5 }, 'small', ['mo0']);
    at(M, 'mo3', 11.4, 323, '器契', { mWeapon: 4, mDef: 4 }, 'small', ['mo1']);
    at(M, 'mo2', 10.9, 344, '骸甲', { mDef: 6 }, 'small', ['mr6']);
    at(M, 'mo4', 11.4, 337, '器契', { mWeapon: 4, mDef: 4 }, 'small', ['mo2']);
    // 基石的代价对召唤师也是真的：你自己的伤害大减，最大生命也跟着降
    at(M, 'mk2', 11.6, 330, '器魂共鸣', { mWeapon: 50, mDef: 30, mLife: 25, ownLess: 40, moreLife: -15 }, 'keystone', ['mo3', 'mo4']);
    // 交汇：下方（铸躯 × 迅影，近战）与上方（秘识 × 统御，法术与召唤）各一团，两头的旁支都能进；
    // 左（铸躯 × 秘识）右（迅影 × 统御）两座桥
    const O = OUTER;
    at(O, 'bi0', 6.0, 72, '坚毅', { life: 15, speed: 2 }, 'small', ['dr2']);
    at(O, 'bi1', 6.0, 108, '坚毅', { life: 15, incPhys: 5 }, 'small', ['sl2']);
    at(O, 'bx0', 8.0, 68, '锋芒', { incPhys: 6, crit: 8 }, 'small', ['dr4']);
    at(O, 'bx1', 8.0, 112, '韧皮', { life: 20, incArmour: 8 }, 'small', ['sl5']);
    at(O, 'bx2', 7.4, 79, '膂力', { incPhys: 8 }, 'small', ['bi0', 'bx0']);
    at(O, 'bx3', 7.4, 101, '体魄', { life: 20 }, 'small', ['bi1', 'bx1']);
    at(O, 'bn1', 7.0, 90, '百战', { incPhys: 15, life: 30, speed: 4 }, 'notable', ['bx2', 'bx3']);
    at(O, 'bx4', 8.4, 90, '膂力', { incPhys: 8 }, 'small', ['bn1']);
    at(O, 'bn2', 9.6, 90, '浴血', { incPhys: 12, lifeOnKill: 8, lifeRegen: 5 }, 'notable', ['bx4']);
    at(O, 'ti0', 6.0, 252, '灵引', { mana: 15, incElem: 5 }, 'small', ['ir2']);
    at(O, 'ti1', 6.0, 288, '灵引', { minionDmg: 8 }, 'small', ['ml3']);
    at(O, 'tx0', 8.0, 248, '元素亲和', { incElem: 8 }, 'small', ['ir4']);
    at(O, 'tx1', 8.0, 292, '骸骨坚韧', { minionLife: 12 }, 'small', ['ml5']);
    at(O, 'tx2', 7.4, 259, '灵契', { incElem: 6, minionDmg: 6 }, 'small', ['ti0', 'tx0']);
    at(O, 'tx3', 7.4, 281, '灵契', { minionDmg: 6, mana: 10 }, 'small', ['ti1', 'tx1']);
    at(O, 'tn1', 7.0, 270, '灵契共振', { incElem: 10, minionDmg: 10, mana: 20 }, 'notable', ['tx2', 'tx3']);
    at(O, 'tx4', 8.4, 270, '亡者狂潮', { minionSpeed: 5 }, 'small', ['tn1']);
    at(O, 'tn2', 9.6, 270, '魂火', { incElem: 15, minionDmg: 15, ailment: 10 }, 'notable', ['tx4']);
    at(O, 'lx0', 9.4, 183, '血与智', { life: 15, mana: 15 }, 'small', ['sr4', 'il5']);
    at(O, 'ln', 10.4, 183, '血智', { life: 30, mana: 30, incLife: 5, incMana: 5 }, 'notable', ['lx0']);
    at(O, 'rx0', 9.2, 2, '疾令', { speed: 3, minionSpeed: 5 }, 'small', ['dl5', 'mr5']);
    at(O, 'rn', 10.2, 4, '狩群', { speed: 6, minionSpeed: 10, moveSpeed: 4 }, 'notable', ['rx0']);
    // ---------- 焚骨祭司（法师召唤物改版加的 3 个节点）----------
    // 从统御主干的 mm4 往右上分出一小支，落在「万骸之主」和右边继承线之间的空地上：两个小节点 + 一个核心。
    // 范围效果吃到守像的砸地和祭司的火弹 / 坠焰，焰蓄只有祭司用得上。125 → 128 个节点
    at(M, 'mp0', 7.0, 341, '焚契', { minionDmg: 6, minionArea: 6 }, 'small', ['mm4']);
    at(M, 'mp1', 8.2, 343, '焚契', { minionDmg: 6, minionArea: 9 }, 'small', ['mp0']);
    at(M, 'mpn', 9.3, 338, '焚骨圣咏', { minionDmg: 6, minionArea: 15, minionCharge: 30 }, 'notable', ['mp1']);
    // ---------- 远程武器（远程改版加的 8 个节点）----------
    // 下方两条旁支和交汇团之间原来是空的：铸躯一侧（sl1 往下）是枪械的热度，迅影一侧（dr0 往下）是弓的专注，各 3 个小节点 + 1 个核心，
    // 末端的两个核心隔着正下方相望。117 → 125 个节点
    const D = ARMS.d, S2 = ARMS.s;
    at(S2, 'gn0', 4.0, 112, '炽膛', { heatGain: 15 }, 'small', ['sl1']);
    at(S2, 'gn1', 4.7, 104, '赤热', { heatDmg: 15 }, 'small', ['gn0']);
    at(S2, 'gn2', 4.2, 94, '淬膛', { rDmg: 20 }, 'small', ['gn1']);
    at(S2, 'gnn', 3.1, 100, '熔炉之心', { heatGain: 15, heatDmg: 10, rDmg: 25 }, 'notable', ['gn2']);
    at(D, 'bw0', 3.8, 60, '凝神', { focusGain: 15 }, 'small', ['dr0']);
    at(D, 'bw1', 4.6, 67, '远射', { rangeDmg: 20 }, 'small', ['bw0']);
    at(D, 'bw2', 4.2, 78, '屏息', { buffDur: 15 }, 'small', ['bw1']);
    at(D, 'bwn', 3.1, 80, '鹰隼之息', { focusGain: 15, buffDur: 20, rangeDmg: 15 }, 'notable', ['bw2']);
    // ---------- 噬渊（混沌流加的 9 个节点）----------
    // 正上方（270°）内圈原来空着的楔形：半径 1.3–5.2（两个旁支往外张开一点，核心 / 基石的名字在全览时互不压住，也不压住奥能涌流 / 灵契共振），夹在秘识的右旁支（≤ 232°）、统御的左旁支（≥ 303°）和上方交汇团（半径 6 起）之间。
    // 只从起点连出去，不连交汇团（不给上方交汇团开捷径）。旧节点一个不动。128 → 137 个节点（不含起点）
    const C = { key: 'c', color: '#ff6ad2' };
    at(C, 'cm0', 1.3, 270, '蚀心', { incChaos: 8 }, 'small', ['start']);
    at(C, 'cm1', 2.25, 270, '缚引', { bindAil: 10 }, 'small', ['cm0']);
    at(C, 'cm2', 3.2, 270, '蚀心', { incChaos: 10 }, 'small', ['cm1']);
    at(C, 'cm3', 4.25, 270, '渊潮', { incChaos: 15, incElem: 8, area: 6 }, 'notable', ['cm2']);
    // 基石：混沌伤害总额外提高，代价是最大生命（纯混沌流也躲不开的代价）
    at(C, 'ck', 5.2, 270, '万籁俱寂', { moreChaos: 25, moreLife: -15 }, 'keystone', ['cm3']);
    at(C, 'cl0', 3.0, 252, '噬光', { incChaos: 8, mana: 10 }, 'small', ['cm1']);
    at(C, 'cl1', 3.85, 243, '幽焰', { flameEff: 25, incChaos: 10 }, 'notable', ['cl0']);
    at(C, 'cr0', 2.95, 287, '沉坠', { bindAil: 10, holeDur: 10 }, 'small', ['cm1']);
    at(C, 'cr1', 3.85, 294, '视界', { holeDur: 20, pullK: 30, bindAil: 15 }, 'notable', ['cr0']);
  })();

  // ---------- 区域地形的数值（world.js「区域地形」一节）----------
  // slow：浅水 / 冰泥的移速系数，slowRoll：翻滚距离系数；burn：灼烧每跳伤害 = burn × G.dmgScale(区域等级)，burnTick 秒一跳；
  // thinT：薄冰站多久裂开，thinBack：离开后多久复原；wakeLos：小怪苏醒要看得见玩家；bossLeash：区域首领拴在场地里
  G.TERRAIN = { slow: 0.65, slowRoll: 0.85, burn: 3, burnTick: 0.5, thinT: 1.0, thinBack: 4, wakeLos: true, bossLeash: true };

  // ---------- 区域 ----------
  G.ZONES = [
    {
      id: 'ash', name: '灰烬荒原', level: 1, elem: 'fire', boss: 'golem',
      fog: 0x1c130f, voidc: 0x130d0b, path: 0x7a6252, rock: 0x4b3a33, accent: 0xff6a2a, sky: 0xffc9a0,
      mobs: ['husk', 'husk', 'spitter', 'brute'], desc: '烧光了的荒地。',
    },
    {
      id: 'frost', name: '霜骨沼泽', level: 5, elem: 'cold', boss: 'weaver',
      fog: 0x0e161c, voidc: 0x0a1014, path: 0x56707a, rock: 0x33454f, accent: 0x7fd4ff, sky: 0xbfe6ff,
      mobs: ['husk', 'spitter', 'bomber', 'brute'], desc: '冰下全是骨头。',
    },
    {
      id: 'storm', name: '雷鸣遗迹', level: 9, elem: 'light', boss: 'warden',
      fog: 0x14131f, voidc: 0x0c0b14, path: 0x6a6480, rock: 0x3d3a52, accent: 0xffe45e, sky: 0xe0d8ff,
      mobs: ['husk', 'spitter', 'bomber', 'brute', 'spitter'], desc: '老机关还在转，雷没停过。',
    },
    {
      // zones-integrate：配色改成 zones-abyss 定的炭灰紫底子（原 fog 0x1a0c10、voidc 0x0f0709、path 0x6e4a4a、rock 0x3f2a2c、accent 0xff3a4a，太红太饱和），红橙只做点缀
      id: 'abyss', name: '烬渊深处', level: 13, elem: 'fire', boss: 'lord',
      fog: 0x18121e, voidc: 0x0c0810, path: 0x57525c, rock: 0x48424f, accent: 0xff6a2a, sky: 0xffb0a0,
      mobs: ['husk', 'bomber', 'spitter', 'brute', 'brute'], desc: '灰烬从这里来。',
    },
    {
      // 第五区：烬渊之下，天穹裂开、星骸坠落的谷地。地面是墨绿的熔融琉璃，裂纹里流着星辉
      id: 'rift', name: '坠星裂谷', level: 17, elem: 'light', boss: 'behemoth',
      fog: 0x0a1613, voidc: 0x050c0a, path: 0x44685a, rock: 0x263a35, accent: 0x6effc8, sky: 0xc4ffe6,
      mobs: ['husk', 'phaser', 'charger', 'spitter', 'brute', 'phaser', 'charger'], desc: '天裂了，星星往下掉。',
    },
  ];
  // 第五区上线之前就打通过烬渊深处的老存档：读档时提示一次「烬渊深处之后多了一个区域」。
  // 判定看原始存档：烬渊深处有通关记录、坠星裂谷还没有、而且这条提示没看过（save.tut[id]）。
  // 老角色的 maxTier 原样保留：已经开启的层级照常能进，只是在最高层级要打通新的末区才开下一层
  G.NEW_ZONE_NOTICE = {
    id: 'zone5', zone: 'rift', after: 'abyss',
    html: '<b>新区域</b>：烬渊深处之后新增<b>坠星裂谷</b>（怪物等级 17 起）。已开的轮回层级保留；每层怪物等级改为 +20，在最高层级击败裂谷首领才开下一层。<kbd>M</kbd> 打开地图',
  };
  G.zoneNoticeFor = function (raw) {
    const N = G.NEW_ZONE_NOTICE;
    const c = raw && typeof raw === 'object' && raw.cleared && typeof raw.cleared === 'object' ? raw.cleared : null;
    const seen = raw && raw.tut && typeof raw.tut === 'object' && raw.tut[N.id];
    return !!(c && typeof c[N.after] === 'number' && typeof c[N.zone] !== 'number' && !seen);
  };
  // 每个轮回层级提高的怪物等级。五个区域是 1 / 5 / 9 / 13 / 17，每区 +4；
  // 取 20 让下一层从 21 接着往上走，不会比上一层的末区（17，首领 20）倒退：层级 n 覆盖 1+20n … 20+20n 级
  G.TIER_LEVELS = 20;

  // ---------- 余烛殿（熄烛者，巅峰首领，D5）----------
  // 不进 G.ZONES（「最后一区解锁下一层」、烬铸的 bossZone 都按 ZONES 的长度算）；G.enterPinnacle(tier) 进场，state.zoneIdx 保持原值。
  // 配色沿用烬渊深处的炭灰紫底子，强调色换成烛火的暖金。level 只是写在这里对照：场地等级按 G.pinLevel(tier) 算
  G.PINNACLE = {
    id: 'crown', name: '余烛殿', level: 17, elem: 'fire', boss: 'snuffer', pin: true,
    fog: 0x18121e, voidc: 0x0c0810, path: 0x57525c, rock: 0x48424f, accent: 0xffb24a, sky: 0xffd8a0,
    mobs: ['husk'], desc: '殿里四只火盆还亮着。',
  };
  // 两个待拍板的默认值（设计稿 §13 第 2 条）：魂灯 3 盏，失败退还 2 个烛芯。改这两行即可
  G.PIN_LIVES = 3;
  G.PIN_REFUND = 2;
  // minTier：最高层级到这一层才开放；levelAdd：等级 = 17 + 20 × 层级 + levelAdd（层级 2 是 62）；
  // arena：场地圆心 / 半径（布局见 world.js「区域地形：crown」），bossR：首领的场地半径（苏醒、拴绳）；
  // braziers：火盆台在场地圆心外 r 米处、方位 angs（度，从正北顺时针），WALL 圆半径 wall；
  // phase：进入二 / 三阶段的生命比例；pause：三个阶段招式之间的停顿；pats：各阶段的招式（data 里的 patterns 是一阶段，给残影 / 测试用）；
  // gloom：二阶段的变暗（雾起止、暖光半径，走 W.setGloom）；tide：暗潮（每 iv 秒、预警 warn、伤害 k 倍、火盆 safe 米内安全）；
  // relight：站在熄灭的火盆 r 米内 t 秒点燃；snuffIv：首领每隔几秒去掐灭一个（至少留 1 个亮着）；
  // thralls：召「烛奴」的生命阈值、每次几只、同场上限；burnIn / burnOut：三阶段外圈起火的范围，burnWarn 预警，灼烧同地形（G.TERRAIN.burn × dmgScale / burnTick 秒）
  G.PIN = {
    minTier: 2, levelAdd: 5,
    arena: { x: 0, z: -34, r: 17 }, bossR: 15,
    braziers: { r: 10.5, angs: [45, 135, 225, 315], wall: 0.9 },
    phase: [0.7, 0.35], pause: [1.0, 0.85, 0.7],
    pats: [['brush', 'tears', 'wick'], ['brush', 'tears', 'wick'], ['spiral', 'crown', 'dbrush']],
    gloom: { near: 16, far: 34, lamp: 10, tag: 0 },
    tide: { iv: 9, warn: 1.6, k: 0.6, safe: 4 },
    relight: { r: 2, t: 1.5 }, snuffIv: 14, snuffAct: 1.2,
    thralls: { at: [0.6, 0.45], n: 2, cap: 4 },
    burnIn: 12, burnOut: 17, burnWarn: 1.5,
    // 不会一下打空：余烛殿里首领的任何单次伤害（预警圈、暗潮、冲锋）结算后最多扣最大生命的 hitCap。
    // 层级 2 碰不到（坠冕约 45–56%）；层级 3 起怪物等级超过角色上限，坠冕 / 拂烛原本能到 90–108%
    hitCap: 0.85,
  };
  G.pinLevel = (tier) => G.PINNACLE.level + G.TIER_LEVELS * tier + G.PIN.levelAdd;

  // ---------- 怪物 ----------
  G.MOBS = {
    // mass：体重，击退距离按它折算；poise：做成精英时的架势上限（普通小怪没有架势条）；
    // sturdy：皮糙肉厚，重击也打断不了它的起手（只能躲）
    husk: { name: '游魂', hp: 30, dmg: 7, speed: 5.0, r: 0.55, range: 1.7, windup: 0.35, cd: 1.1, xp: 1, ai: 'melee', mass: 1, poise: 100 },
    brute: { name: '巨躯', hp: 100, dmg: 17, speed: 3.1, r: 0.95, range: 2.6, windup: 0.85, cd: 2.2, xp: 2.6, ai: 'slam', mass: 2.2, poise: 140, sturdy: true },
    spitter: { name: '喷吐者', hp: 24, dmg: 9, speed: 4.2, r: 0.55, range: 13, windup: 0.45, cd: 2.2, xp: 1.3, ai: 'ranged', mass: 0.9, poise: 90, h: 0.9 },
    bomber: { name: '爆裂虫', hp: 15, dmg: 20, speed: 7.2, r: 0.5, range: 2.2, windup: 0.7, cd: 9, xp: 0.9, ai: 'bomb', mass: 0.8, poise: 80 },
    // h：模型高度（血条 / 飘字 / 受击特效的位置），不写时 2（巨躯 2.8）；喷吐者是一只矮蜘蛛
    // 坠星裂谷的两种新怪
    // 隙影：保持距离放单发电弹；隔几秒会闪到玩家侧面（落点先亮预警环），现身后补一轮三连扇射；被贴脸也是闪走而不是后撤
    phaser: { name: '隙影', hp: 26, dmg: 10, speed: 4.4, r: 0.55, range: 12, windup: 0.45, cd: 2.6, xp: 1.5, ai: 'blink', mass: 0.8, poise: 90, h: 2.3 },
    // 陨角兽：中距离刨地蓄力（地上亮一条冲锋道），然后沿直线猛冲；撞墙会晕一下。贴身时用角顶
    charger: { name: '陨角兽', hp: 70, dmg: 16, speed: 4.2, r: 0.85, range: 10, windup: 0.8, cd: 3.6, xp: 2.0, ai: 'charge', mass: 1.8, poise: 130, h: 2.2 },
  };
  // 首领生命比 v1 高约 12%：补偿破绽易伤与处决，战斗时长大致不变
  G.BOSSES = {
    golem: { name: '熔渣巨像', hp: 695, dmg: 16.5, speed: 3.4, r: 1.9, poise: 500, patterns: ['slam', 'charge', 'ring'] },
    weaver: { name: '霜织者', hp: 785, dmg: 15.4, speed: 3.8, r: 1.5, poise: 450, patterns: ['fan', 'barrage', 'summon', 'ring'] },
    warden: { name: '雷霆监察者', hp: 875, dmg: 15.4, speed: 4.0, r: 1.7, poise: 480, patterns: ['cross', 'barrage', 'charge', 'ring'] },
    lord: { name: '烬渊之主', hp: 1175, dmg: 15, speed: 4.0, r: 1.9, poise: 550, patterns: ['slam', 'fan', 'spiral', 'cross', 'barrage', 'summon'] },
    // 衔星巨兽：背上嵌着一块坠星的四足古兽。starfall 流星犁地（几道落点沿直线朝外推进）、gravity 坍缩（玩家脚下的引力井把人往里拽，到点内爆）、
    // sweep 衔星吐息（口中射线横扫一大片扇面）、slam 前蹄践踏
    behemoth: { name: '衔星巨兽', hp: 1250, dmg: 15, speed: 4.2, r: 2.0, poise: 600, patterns: ['starfall', 'gravity', 'sweep', 'slam'] },
    // 熄烛者（余烛殿的巅峰首领，D5）：高瘦的长袍身形，头顶一圈烛芯冠，双手各提一盏熄灭的提灯。生命约衔星巨兽的 2.6 倍。
    // 招式按阶段换（G.PIN.pats，enemies.js「熄烛者」一节）；这里的 patterns 是一阶段的三种
    snuffer: { name: '熄烛者', hp: 3300, dmg: 15, speed: 3.6, r: 1.6, poise: 900, patterns: ['brush', 'tears', 'wick'], pin: true },
  };
  // 区域加大后的小怪（zones-balance）：关键路径 / 面积约 ×1.6，怪群数跟着面积走（×1.6），每群的人数再 ×packSize，
  // 普通怪总数约 ×2。区域刷出来的普通怪（e.horde）更脆，每只的经验 / 掉落几率打折，一整区合计约为改版前的 ×1.15。
  // 精英、首领、首领召唤的小怪、宝箱都不打折；怪物伤害不变。
  //   mobHp：普通怪生命倍率；packSize：生成器怪群人数的倍率（随机取整，期望值正好 ×packSize），站位半径 ×√packSize；
  //   多出来的人手只放轻怪（游魂 / 喷吐者 / 隙影），巨躯、陨角兽、爆裂虫的数量和以前一样（见 enemies.js 的 populatePack）；
  //   mobXp：普通怪经验倍率；loot：普通怪掉落几率的倍率（item 物品、cur 通货、gem 技能 / 辅助 / 无铭宝石）
  //   zoneK：各区普通怪的经验 / 掉落再乘一个系数，补各区布局加长后普通怪 / 精英涨得不一样多（普通怪灰烬、霜骨约 ×2.2，雷鸣、烬渊、裂谷约 ×1.9），
  //   让每区合计都落在 ×1.15 附近
  G.BALANCE = { mobHp: 0.55, packSize: 1.25, mobXp: 0.6, loot: { item: 0.38, cur: 0.5, gem: 0.57 }, zoneK: { ash: 1, frost: 0.97, storm: 1.08, abyss: 1.15, rift: 1.15 } };
  // 怪物成长：MOB_KNEE（16，前四个区域的最高怪物等级）以内是原来的 1.2 / 1.15 倍每级，一位不差；
  // 再往上分三段，对上轮回层级里角色的实际成长（宝石 / 武器 / 词缀阶 / 生命都不再封顶，经验曲线也让角色等级跟着怪物等级走），
  // 用平衡机器人在层级 0 末区（第五区）、层级 1 中段与末区、层级 2 中段与末区量出来（每层 5 个区域、+TIER_LEVELS = 20 级）：
  //   17–32 级（MOB_HP_LATE / MOB_DMG_LATE）：第五区和层级 1 的前三个区域，和每层 16 级时的同等级一样；
  //   33–40 级（…LATE2）：层级 1 的后两个区域。角色的物品等级在这里跨过 31 / 38 两档词缀阶，生命跟得上每级 1.12；
  //     伤害每级只涨 1.03——层级 1 末区（第五区，37–40 级，角色 43 级左右）的首领用时与受伤和每层 16 级时的层级 1 末区相当；
  //   41 级以上（…LATE3）：层级 2。角色在 60 级封顶、物品等级还在涨，怪物生命每级 1.08、伤害每级 1.03：
  //     层级 2 中段和以前的层级 2 中段相当，末区（57–60 级）更难一截，但好装备打得过。
  G.MOB_KNEE = 16;
  G.MOB_KNEE2 = 32;
  G.MOB_KNEE3 = 40;
  G.MOB_HP_LATE = 1.09;
  G.MOB_HP_LATE2 = 1.12;
  G.MOB_HP_LATE3 = 1.08;
  G.MOB_DMG_LATE = 1.1;
  G.MOB_DMG_LATE2 = 1.03;
  G.MOB_DMG_LATE3 = 1.03;
  const late = (l, k1, k2, k3) =>
    Math.pow(k1, Math.min(l, G.MOB_KNEE2) - G.MOB_KNEE) *
    Math.pow(k2, Math.max(0, Math.min(l, G.MOB_KNEE3) - G.MOB_KNEE2)) *
    Math.pow(k3, Math.max(0, l - G.MOB_KNEE3));
  G.hpScale = (l) => (l <= G.MOB_KNEE ? Math.pow(1.2, l - 1) : Math.pow(1.2, G.MOB_KNEE - 1) * late(l, G.MOB_HP_LATE, G.MOB_HP_LATE2, G.MOB_HP_LATE3));
  G.dmgScale = (l) => (l <= G.MOB_KNEE ? Math.pow(1.15, l - 1) : Math.pow(1.15, G.MOB_KNEE - 1) * late(l, G.MOB_DMG_LATE, G.MOB_DMG_LATE2, G.MOB_DMG_LATE3));

  // ---------- 经验 ----------
  // 每只怪的经验按怪物等级指数成长（mobXp，1.17 倍 / 级）。升级所需经验在 XP_KNEE 级以内和改版前一样（多项式），
  // 再往上改为和 mobXp 同样按 1.17 倍 / 级增长——「每升一级要杀多少只同级怪」从此不变，角色等级就跟着怪物等级走，
  // 不会像改版前那样越往后升得越快（改版前轮回层级 1 打完是 42 级、怪物才 29–32 级）。
  // 每层改成 5 个区域、+20 级之后曲线不用动：每个区域清一遍，清完时仍比该区最高的怪物高 3–4 级（层级 2 的末区碰到 60 级上限）。
  // 压级：角色比怪物高出 XP_OVER 级以上，每多 1 级经验 × XP_FALL（最低 XP_FLOOR），反复刷低等级区域收益递减；
  // 越级：怪物比角色高出 XP_UNDER 级以上的部分不再多给。
  G.XP_KNEE = 16;
  G.XP_OVER = 3;
  G.XP_FALL = 0.72;
  G.XP_FLOOR = 0.02;
  G.XP_UNDER = 8;
  const xpPoly = (G.xpNeedOld = (l) => Math.round(40 + 30 * Math.pow(l, 1.5))); // 改版前的升级所需经验（读旧存档时换算经验条用）
  G.xpNeed = (l) => (l <= G.XP_KNEE ? xpPoly(l) : Math.round(xpPoly(G.XP_KNEE) * Math.pow(1.17, l - G.XP_KNEE)));
  G.mobXp = (l) => 10 * Math.pow(1.17, l - 1);
  // 等级差带来的经验倍率（d = 角色等级 − 怪物等级）
  G.xpLevelK = (d) => (d > G.XP_OVER ? Math.max(G.XP_FLOOR, Math.pow(G.XP_FALL, d - G.XP_OVER)) : 1);
  // 击杀一个敌人（{ level, isBoss, elite, def }）在角色 charLvl 级时得到的经验
  G.killXp = function (e, charLvl) {
    // xpW：异兆里的怪自带的经验权重（匣卫 1.5、游荡者 / 残影 4，乘在 def.xp 上）；xpK：再乘的倍率（层级 0 的异兆 ×0.5）
    const w = e.xpW ? ((e.def && e.def.xp) || 1) * e.xpW : e.isBoss ? 20 : ((e.def && e.def.xp) || 1) * (e.elite ? 3 : e.horde ? G.BALANCE.mobXp * (e.hordeK || 1) : 1); // horde：区域刷的普通怪（见 G.BALANCE）
    return G.mobXp(Math.min(e.level, charLvl + G.XP_UNDER)) * w * G.xpLevelK(charLvl - e.level) * (e.xpK === undefined ? 1 : e.xpK);
  };

  // ---------- 渊印（区域词缀，轮回层级 ≥ 1） ----------
  // 进区前三选一（浅印 / 深印 / 烬印）外加素印；每枚印 2–4 条印纹。w：权重，一枚印的生效权重 W 每点给数量 / 稀有度 / 经验
  // （G.SEAL.perW，各有上限 cap）；dmgK：这条印纹对「玩家每秒受到的伤害」的估算倍率，只用来算危险预算，不进战斗公式。
  // dmgK 按 D3 的清图 bot 实测校过（层级 1，单条印纹的 3 s 受伤峰值 ÷ 素印，只往上调、不往下调）：设计稿的估算里
  // 厚躯 1.0 → 1.15、领群 1.1 → 1.2、殁爆 1.08 → 1.15、疾躁 / 焚染 1.12 → 1.2、群首 1.05 → 1.1、警觉 1.05 → 1.08、回生 1.0 → 1.03
  // side：mob 怪物侧 / player 玩家侧；glyph：HUD 小签上的单字；need：技能栏上没有这类技能时这条的权重按 0 算（面板写「对你无效」）；
  // rage：同一枚印里这一组至多 2 条；p：效果的数值（game.js / enemies.js 的「渊印」各处读这里）
  G.SEAL_MODS = {
    // 焚染 / 霜染 / 雷染：怪物每一击另带 frac 倍伤害的该元素伤害（吃抗性）；元素取本区元素以外的一种，存在印纹的 el 上
    tint: { name: '染', side: 'mob', w: 1, dmgK: 1.2, p: { frac: 0.3 } },
    haste: { name: '疾躁', glyph: '躁', side: 'mob', w: 2, dmgK: 1.2, rage: true, p: { speed: 0.2, cd: 0.15 } }, // 起手和预警时长不变
    elites: { name: '群首', glyph: '首', side: 'mob', w: 2, dmgK: 1.1, p: { chance: 0.7, cap: 8 } }, // 关键路径房间精英几率 45% → chance，全区上限 6 → cap
    // 殁爆：普通怪死后 delay 秒在尸体处炸开（半径 r，伤害 = 它一击的 k 倍），精英用 eDelay / eR；场上最多 max 个；
    // gap 秒内只伤玩家一次（一群怪同时死、几个圈叠在脚下时只算一下，不会一口气打空）
    burst: { name: '殁爆', glyph: '殁', side: 'mob', w: 2, dmgK: 1.15, p: { delay: 0.9, r: 1.8, eDelay: 1.1, eR: 2.6, k: 0.7, max: 8, gap: 0.35 } },
    ailRes: { name: '坚蜕', glyph: '蜕', side: 'mob', w: 2, dmgK: 1.0, p: { th: 1.6, chillCap: 0.7, dur: 0.75 } }, // 首领只吃异常阈值
    // 领群：每群一只领群者，r 米内同群的怪伤害 +dmg、受到的伤害 −dr；领群者经验 × xp
    aura: { name: '领群', glyph: '领', side: 'mob', w: 2, dmgK: 1.2, p: { r: 6, dmg: 0.2, dr: 0.15, xp: 2 } },
    tough: { name: '厚躯', glyph: '厚', side: 'mob', w: 2, dmgK: 1.15, p: { hp: 0.35, boss: 0.2 } },
    fierce: { name: '凶戾', glyph: '戾', side: 'mob', w: 2, dmgK: 1.2, rage: true, p: { dmg: 0.2, boss: 0.15 } },
    volley: { name: '连发', glyph: '连', side: 'mob', w: 1, dmgK: 1.05, p: { n: 2, spread: 14, speed: 0.15 } }, // spread：两发的夹角（度）
    mend: { name: '回生', glyph: '生', side: 'mob', w: 1, dmgK: 1.03, p: { idle: 3, rate: 0.02, boss: 0.005 } },
    alert: { name: '警觉', glyph: '觉', side: 'mob', w: 2, dmgK: 1.08, p: { wake: 16, call: 1.5 } },
    frenzy: { name: '濒狂', glyph: '狂', side: 'mob', w: 1, dmgK: 1.05, rage: true, p: { th: 0.3, speed: 0.3, dmg: 0.15 } },
    escort: { name: '侍从', glyph: '从', side: 'mob', w: 2, dmgK: 1.08, p: { n: 2, at: 0.5 } },
    cinder: { name: '余烬地', glyph: '烬', side: 'mob', w: 1, dmgK: 1.03, p: { chance: 0.25, t: 3, r: 1.4, max: 6 } },
    drain: { name: '枯竭', glyph: '竭', side: 'player', w: 2, dmgK: 1.0, p: { regen: 0.4, flask: 0.3 } },
    gloom: { name: '幽晦', glyph: '晦', side: 'player', w: 1, dmgK: 1.0, p: { near: 17, far: 38, lamp: 12, tag: 18 } },
    wane: { name: '蚀环', glyph: '蚀', side: 'player', w: 2, dmgK: 1.0, need: 'aura', p: { eff: 0.3, reserve: 10 } },
    sluggish: { name: '迟滞', glyph: '滞', side: 'player', w: 2, dmgK: 1.05, p: { cd: 0.25, roll: 0.25 } },
    frail: { name: '裂御', glyph: '裂', side: 'player', w: 2, dmgK: 1.12, p: { res: 20 } },
    lonely: { name: '孤影', glyph: '孤', side: 'player', w: 1, dmgK: 1.0, need: 'summon', p: { life: 0.35, dmg: 0.1 } },
  };
  G.SEAL_MOD_IDS = Object.keys(G.SEAL_MODS);
  // 群首在这几个区的全区精英上限（风险 1）：烬渊深处、坠星裂谷的混战离 135 个 draw 只差几个，多 2 只精英会超，这里只多 1 只
  G.SEAL_ELITE_CAP = { abyss: 7, rift: 7 };
  G.SEAL_TINT = { fire: { name: '焚染', glyph: '焚' }, cold: { name: '霜染', glyph: '霜' }, light: { name: '雷染', glyph: '雷' } };
  // perW：每点权重给的物品数量 / 稀有度 / 经验（%），cap 是上限；lieW：「烈印」的门槛（生效 W ≥ lieW）。
  // tiers：轮回层级 1 / 2 / ≥3 各一档。n 每枚印的条数，W[0..2] 浅印 / 深印 / 烬印的权重区间，budget 危险预算（dmgK 乘积上限），
  // minN3：烬印至少几条。烛芯的几率按档位，见 G.FRAG_DROP.bySeal
  G.SEAL = {
    perW: { qty: 5, rar: 6, xp: 4 },
    cap: { qty: 45, rar: 60, xp: 35 },
    lieW: 6,
    grades: ['浅印', '深印', '烬印'],
    tiers: [
      { n: [2, 3], W: [[2, 3], [4, 5], [6, 7]], budget: 1.25, minN3: 0 },
      { n: [2, 4], W: [[2, 3], [4, 6], [7, 9]], budget: 1.35, minN3: 0 },
      { n: [3, 4], W: [[3, 4], [5, 7], [8, 10]], budget: 1.45, minN3: 3 },
    ],
  };
  G.sealTierDef = (tier) => G.SEAL.tiers[G.clamp((tier | 0) - 1, 0, G.SEAL.tiers.length - 1)];

  // ---------- 异兆（随机遭遇，D4） ----------
  // 每次进区掷一次（不存档，读档重进跟着重掷）。t0Chance：层级 0 出 1 个的几率（只从 w[0] > 0 的 5 种低风险里挑）【需拍板 §13-3，单一常量】；
  // second：层级 ≥ 1 一定出 1 个，再多 1 个（不重复）的几率。reveal：走到这么近或进了那个房间，小地图上的灰色六边形换成这一种的图样；
  // lazy：走到这么近或进了那个房间才建道具、刷怪（懒生成：进区时 state.enemies 不变）。gap / startGap / chestGap / doorGap：选址的间距（异兆之间、
  // 离起点、离宝箱、离场地门）；warn：刷怪前的环形预警秒数；t0Xp：层级 0 异兆里的怪经验倍率
  G.ENC = { t0Chance: 0.4, second: 0.4, reveal: 24, lazy: 28, gap: 25, startGap: 12, chestGap: 8, doorGap: 18, warn: 0.8, t0Xp: 0.5 };
  // 8 种异兆。w：[层级 0, 层级 ≥ 1] 的权重；site：点位类型（core 大房间中心 / side 死路旁支 / nook 偏离主线的空地 / patrol 巡逻段）；
  // frag：成功时掉哪种烛芯（层级 ≥ 2）；relic：成功时掷哪件渊契（G.RELIC_BY_ENC 的键，层级 ≥ 1）；p：机制数值；rew：奖励
  //   rew.elite 按精英掉落表掷几次、rar 那几次的稀有度倍率、cur 另给几颗通货、rare 另给几件必定稀有、magic 另给几件至少魔法（稀有度 × magicRar）、gem 另给 1 颗技能宝石或辅助
  G.ENCOUNTERS = {
    // 守隙：房间清空后张开裂隙，走进 r 的圈开始坚守 hold 秒；离圈超过 grace 秒计时每秒倒退 back；退回 0 后 failT 秒内没回圈（或倒下）算失败。
    // 波次在坚守计时的 waves 秒刷出 n 只本区轻怪，最后一波另加精英（层级 1 为 elite[0]、≥ 2 为 elite[1]）；刷怪点 pts 个，在 ring 环上；同场 ≤ cap，超了排队，场上 ≤ resume 再刷
    guard: {
      name: '守隙', site: 'core', w: [0, 18], frag: 'rift', relic: 'guard',
      p: { r: 5, hold: 30, grace: 5, back: 0.5, failT: 6, waves: [0, 8, 16, 24], n: [4, 5, 6, 6], elite: [1, 2], ring: [9, 12], pts: 3, cap: 8, resume: 4 },
      rew: { elite: 2, rare: 1, cur: 2 },
      desc: '清空房间后裂隙张开：站在圈里坚守 30 秒，挡住四波怪物。',
    },
    // 缚匣：走到 touch 以内或点击，锁链崩开，n 个锚点各刷 1 只匣卫（生命 = 普通怪 × hp、伤害 × dmg、经验权重 xpW）；time 秒内全杀是解缚，否则残缚
    box: {
      name: '缚匣', site: 'nook', w: [25, 14], frag: 'box', relic: 'box',
      p: { touch: 1.4, n: 3, hp: 2.2, dmg: 1.15, xpW: 1.5, time: 25, anchor: 3 },
      rew: { elite: 2, rar: 2, cur: 1 }, rewFail: { elite: 1 },
      desc: '锁链宝箱：崩开后 25 秒内打倒三只匣卫，才能完整解缚。',
    },
    wanderer: {
      name: '游荡者', site: 'patrol', w: [15, 16], frag: 'vow', relic: 'wanderer',
      rew: { magic: 3, magicRar: 3, cur: 2 },
      desc: '在两个房间间游荡的名号精英，各有独门手段。',
    },
    shrine: {
      name: '祈坛', site: 'nook', w: [30, 10], p: { touch: 3.5 },
      desc: '走近按 F 激活，随机获得一种增益。',
    },
    // 试锋：跨过旁支门口的符文开始，time 秒内打完 n 三波（最后一波含 elite 只精英）；离开小室超过 leave 秒算弃权；剩 good 秒以上是「上」
    trial: {
      name: '试锋', site: 'side', w: [0, 12], frag: 'box', relic: 'trial',
      p: { time: 45, n: [5, 6, 6], elite: 2, leave: 4, good: 15, door: 3, rune: 1.6 },
      rew: { rare: 2, cur: 3, gem: 1 }, rewMid: { rare: 1, cur: 2 }, rewFail: { cur: 1 },
      desc: '跨过符文开始限时试炼，剩余时间越多奖励越好。',
    },
    trader: {
      name: '拾烬客', site: 'nook', w: [20, 8], p: { touch: 3.5 },
      desc: '用通货换货架上的东西，也收你用不上的装备。',
    },
    // 残影：房间清空后浮现本区首领的残影。等级 = 房间等级 + lv，生命 = 首领 × hp，只用前 pats 种招式，不狂暴、拴在房间里；经验权重 xpW
    echo: {
      name: '残影', site: 'core', w: [0, 10], relic: 'echo',
      p: { lv: 2, hp: 0.35, pats: 2, xpW: 4 },
      rew: { rare: 1, items: 1, cur: 3 },
      desc: '清空房间后，本区首领的残影在中心浮现。',
    },
    // 落烬：房间清空后摸一下中心的烬核开始。time 秒内每 every 秒落一团余烬（预警 r、warn 秒，落点在 area 内随机，aim 的几率瞄着玩家），
    // 打玩家 hitK 倍本区小怪一击、打怪 × mobK；同时 ≤ max 个预警。n 块烬晶立在 ring 环上（生命 = 本级游魂 × hp），全部打碎就成功
    ember: {
      name: '落烬', site: 'core', w: [10, 12], frag: 'box', relic: 'ember',
      p: { touch: 1.4, time: 25, every: 0.6, r: 2.0, warn: 1.1, area: 10, aim: 0.4, hitK: 0.5, mobK: 3, max: 3, n: 4, ring: [6, 8], hp: 3 },
      rew: { elite: 2, rar: 1.5, cur: 1 },
      desc: '清空房间后触碰中心的烬核：25 秒内打碎四块烬晶。',
    },
  };
  G.ENC_IDS = Object.keys(G.ENCOUNTERS);
  // 游荡者：本区最结实的那种怪（按 types 的顺序在区域怪物表里找），体型 × size，生命 = 精英 × hp，伤害 × dmg（同精英），架势 = 精英 × poise，
  // 经验权重 xpW（精英是 3），巡逻速度 × speed。名字「称号·名」，名从 names 里取两个字拼
  G.WANDERER = {
    types: ['brute', 'charger', 'husk'], size: 1.4, hp: 1.6, dmg: 1.3, poise: 1.5, xpW: 4, speed: 0.6,
    names: '戈烬岚朔砾霾溟烛骸刃翳殁苍蚀魇棘',
    titles: {
      // 拖链者：每 every 秒甩一次钩链（长 len、宽 w 的长条预警 warn 秒），打中把玩家往它那边拽 pull 米（拽到 sdAt < stop 就停），附带 dmg 倍伤害
      chain: { name: '拖链者', every: 6, len: 11, w: 1.4, warn: 0.85, pull: 4, stop: 0.6, dmg: 0.6 },
      // 灰誓者：生命降到 at 各立 n 根图腾（生命 = 普通怪 × hp）；有图腾立着时它受到的伤害 −dr，每秒回 regen
      oath: { name: '灰誓者', at: [0.75, 0.4], n: 2, hp: 1.2, dr: 0.4, regen: 0.01, ring: 4 },
      // 镜影客：生命降到 at 各分出 1 个分身（hp 倍最大生命、dmg 倍伤害，不会再分），本体死了分身一起散
      mirror: { name: '镜影客', at: [0.6, 0.3], hp: 0.3, dmg: 0.6 },
      // 拖烬者：移动时每 every 秒留一块燃烧地面（r、t 秒，最多 max 块）；生命降到 at 时一圈 ring 个圆形预警（rr、warn 秒，伤害 burst 倍）
      cinder: { name: '拖烬者', every: 0.5, r: 1.2, t: 4, max: 10, at: 0.5, ring: 8, rr: 2, rd: 4.5, warn: 1.0, burst: 0.6 },
    },
  };
  G.WANDERER_TITLES = Object.keys(G.WANDERER.titles);
  // 祈坛的四种增益：dur 秒；stats 加进 computeStats（moveSpeed / speed / lessTaken / costReduce 都是现成的属性，encCdr 是技能冷却缩短 %）；
  // noKb：不会被击退；loot：期间击杀的物品 / 通货掉落 × loot（宝石不算）
  G.SHRINE_BUFFS = {
    gale: { name: '疾风', dur: 45, color: '#9fe7ff', stats: { moveSpeed: 25, speed: 15 }, desc: '移动速度 +25%，攻击 / 施法速度 +15%' },
    ward: { name: '坚壁', dur: 45, color: '#ffd28a', stats: { lessTaken: 25 }, noKb: true, desc: '受到的伤害 −25%，不会被击退' },
    bounty: { name: '丰饶', dur: 60, color: '#ffe36a', loot: 1.5, desc: '掉落物品 / 通货的几率 ×1.5（宝石不算）' },
    surge: { name: '渊涌', dur: 30, color: '#d9a0ff', stats: { encCdr: 40, costReduce: 50 }, desc: '技能冷却 −40%，技能消耗 −50%' },
  };
  G.SHRINE_IDS = Object.keys(G.SHRINE_BUFFS);
  // 烛芯：熄烛者（D5）的开启材料，层级 ≥ minTier 才掉，按种类计数存档（save.frags，0–max）。没有保底：
  // 每个合格机会（区域首领 / 守隙 / 游荡者 / 缚匣 / 试锋 / 落烬）按这次进区择的印掷一次，bySeal[seal.g] 是浅印 / 深印 / 烬印，
  // 素印（没有印，包括读档 / 跳过择印进来的）用 plain。几率见 G.fragChance
  G.FRAGS = {
    seal: { name: '印烛芯', color: '#f0a6d8', src: '击杀区域首领' },
    rift: { name: '隙烛芯', color: '#b48cff', src: '守隙成功' },
    vow: { name: '誓烛芯', color: '#ffae5c', src: '击杀游荡者' },
    box: { name: '匣烛芯', color: '#ffd96a', src: '缚匣解缚、试锋「中」以上、落烬成功' },
  };
  G.FRAG_IDS = Object.keys(G.FRAGS);
  G.FRAG_DROP = { minTier: 2, max: 99, bySeal: [0.4, 0.7, 1.0], plain: 0.4 };
  G.fragChance = (seal, tier) => {
    const D = G.FRAG_DROP;
    if (!((tier | 0) >= D.minTier)) return 0;
    return seal ? D.bySeal[G.clamp(seal.g | 0, 0, D.bySeal.length - 1)] : D.plain;
  };
  // 拾烬客的货架（进店时掷一次）：items 件当前物品等级的装备（至少 1 件稀有），1 颗技能宝石或辅助；价格按 price；
  // swap：任意 swap 个烛芯换 1 个指定种类（层级 ≥ fragTier，不要钱）；渊契（层级 ≥ 2，几率和开关见 G.RELIC_DROP.trader）
  G.TRADER = {
    items: 3, fragTier: 2, swap: 2,
    price: { rare: { regal: 2, exalt: 1 }, magic: { dust: 3 }, gem: { augment: 2 }, relic: { exalt: 4, chaos: 4, divine: 2 } },
  };

  // ---------- 角色基础生命 / 魔力 ----------
  // LIFE_KNEE 级以内和改版前一样（每级 +12 生命、+6 魔力）；再往上每级多给 LIFE_LATE / MANA_LATE，
  // 跟上轮回层级里怪物伤害的成长
  G.LIFE_KNEE = 20; // 前四个区域打完大约 19–20 级：之前的生命 / 魔力曲线和改版前完全一样（第五区起开始多给）
  G.LIFE_LATE = 24;
  G.MANA_LATE = 4;
  G.baseLife = (l) => 100 + 12 * (l - 1) + G.LIFE_LATE * Math.max(0, l - G.LIFE_KNEE);
  G.baseMana = (l) => 60 + 6 * (l - 1) + G.MANA_LATE * Math.max(0, l - G.LIFE_KNEE);
})();
