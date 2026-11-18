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
  // 技能页上「武器普攻」卡的 id：辅助宝石镶在 save.sockets[G.BASIC_CARD] 里，换远程武器时不动
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
    cleave: {
      name: '裂石击', icon: '斩', color: '#e6dfd0', tags: ['attack', 'melee', 'area', 'phys'], kind: 'melee',
      // time 是三段的平均段长（界面估算秒伤用），range / arc 是前两段的大致范围
      wm: 1.25, time: 0.45, mana: 0, cd: 0, range: 3.6, arc: 125,
      // 三段连击。time：这一段多久之后可以接下一段 / 别的动作；hit：命中时刻；tail：没有后续输入时的收招；
      // mult 伤害倍率；lunge 出手时朝准星踏出的距离；stop 顿帧毫秒数。
      // 前两段是扇形（range 半径、arc 角度、dir 刀光扫过的方向），第三段是跃起下劈：落点在身前 reach 处、半径 range 的圆
      combo: [
        { clip: 'attack1', time: 0.36, hit: 0.17, tail: 0.14, mult: 0.8, shape: 'arc', range: 3.5, arc: 130, dir: 1, lunge: 0.8, kb: 0.55, poise: 11, stop: 35, w: 0 },
        { clip: 'attack2', time: 0.36, hit: 0.17, tail: 0.14, mult: 0.95, shape: 'arc', range: 3.8, arc: 120, dir: -1, lunge: 0.9, kb: 0.7, poise: 13, stop: 45, w: 0 },
        { clip: 'attack3', time: 0.62, hit: 0.3, tail: 0.2, mult: 2.2, shape: 'smash', range: 3.0, reach: 2.5, lunge: 1.9, kb: 3.0, poise: 30, stop: 110, w: 2 },
      ],
      desc: '三段连击：横斩、反手上挑，最后一段是跃起下劈的终结技——范围更大、伤害翻倍，并把敌人震飞。不消耗魔力。',
    },
    ember: {
      name: '掷焰', icon: '焰', color: '#ff8a3c', tags: ['spell', 'projectile', 'area', 'fire'], kind: 'proj',
      dmg: { fire: [11, 17] }, time: 0.5, mana: 6, cd: 0, speed: 22, explode: 1.9, projR: 0.32, w: 0, kb: 0.45, poise: 10,
      desc: '掷出一团火焰，命中后在小范围内爆炸。',
    },
    blade: {
      name: '飞刃', icon: '刃', color: '#cfd6e6', tags: ['attack', 'projectile', 'phys'], kind: 'proj',
      wm: 1.0, time: 0.36, mana: 4, cd: 0, speed: 28, pierce: 2, projR: 0.28, w: 0, kb: 0.35, poise: 8,
      desc: '掷出一柄旋转的利刃，可穿透 2 个敌人。',
    },
    // 光环：放在技能栏任意一格上就常驻生效，不用按键。reserve 保留最大魔力的百分比（乘上所镶辅助的消耗倍率：节流降低，迅捷 / 扩域等抬高）；
    // time 是两次脉冲的间隔（受出手速度与迅捷影响），每次脉冲对 radius 以内（吃范围加成）的所有敌人造成一小下冰霜伤害。
    // 伤害本身很低，主要价值是不断累积冰霜异常值
    nova: {
      name: '霜环', icon: '霜', color: '#86d8ff', tags: ['spell', 'area', 'cold', 'aura'], kind: 'aura',
      dmg: { cold: [3.2, 4.8] }, time: 0.5, mana: 0, reserve: 25, cd: 0, radius: 4.5, w: 0, kb: 0, poise: 0,
      desc: '光环：放在技能栏上即常驻生效，保留 25% 最大魔力（以血为引时改为保留生命）。身边一圈寒气每隔片刻刺痛范围内所有敌人，伤害很低，但会不断累积冰霜异常值，冰缓乃至冻结它们。',
    },
    arc: {
      name: '链雷', icon: '雷', color: '#ffe45e', tags: ['spell', 'chaining', 'light'], kind: 'chain',
      dmg: { light: [6, 22] }, time: 0.5, mana: 8, cd: 0, chain: 3, range: 15, w: 0, kb: 0.25, poise: 8,
      desc: '电弧击中鼠标附近的敌人，并在敌人之间连锁 3 次。',
    },
    meteor: {
      name: '陨火', icon: '陨', color: '#ff5a2c', tags: ['spell', 'area', 'fire'], kind: 'meteor',
      // 冷却 + 延迟落地（会被走开躲掉）：每一次的伤害要明显高过主力技能，穿插着放才划算
      dmg: { fire: [56, 78] }, time: 0.6, mana: 22, cd: 5, radius: 3.6, delay: 0.75, range: 15, w: 2, kb: 2.4, poise: 45,
      desc: '在鼠标位置召来一颗陨石，短暂延迟后轰然落地，造成巨量火焰伤害。冷却较长，适合穿插在主力技能之间。',
    },
    blink: {
      name: '闪袭', icon: '闪', color: '#c7a6ff', tags: ['attack', 'melee', 'area', 'phys', 'movement'], kind: 'blink',
      // 有冷却：每一下的伤害按「穿插在主力技能之间」来定，单独按冷却循环打不过主力技能
      wm: 3.6, time: 0.2, mana: 10, cd: 3.5, radius: 3.0, range: 10, w: 2, kb: 1.8, poise: 30, stop: 80,
      desc: '瞬移到鼠标位置，重重砸在落点，对周围的敌人造成大量伤害。冷却期间穿插主力技能。',
    },
    whirl: {
      name: '旋风斩', icon: '旋', color: '#e8c9a0', tags: ['attack', 'melee', 'area', 'phys'], kind: 'spin',
      // 持续施放：按住时原地旋转，每 time 秒（受出手速度影响）对身边一圈造成一次伤害、扣一次魔力。
      // radius 半径；move 旋转中的移动速度倍率；kb 击退（顺着旋转方向带一下，不把敌人推出圈外）；stop 每跳的顿帧毫秒数
      wm: 0.8, time: 0.3, mana: 2, cd: 0, radius: 3.0, move: 0.6, w: 0, kb: 0.18, poise: 6, stop: 12,
      desc: '按住持续旋转，不断斩击身边一圈的敌人，每一下都消耗少量魔力。转起来可以慢慢走动；松手、翻滚或施放别的技能就停下。',
    },
    shadestep: {
      name: '影步连斩', icon: '影', color: '#9fb4ff', tags: ['attack', 'melee', 'area', 'phys', 'movement'], kind: 'flicker',
      // 持续施放：按住时自动瞬移到身边 range 以内（走得过去的）敌人旁边斩一刀，再闪向下一个。
      // 每 time 秒一刀（受出手速度影响），每刀扣一次魔力；radius 是每一刀波及目标周围的半径（吃范围加成）；
      // lead 闪现到落地出刀之间的秒数（第一刀 / 之后每一刀），闪现期间无敌，出刀那一刻不无敌；stop 每刀的顿帧毫秒数
      wm: 0.6, time: 0.18, mana: 2, cd: 0, range: 8, radius: 1.6, lead: [0.08, 0.1], move: 0, w: 0, kb: 0.25, poise: 9, stop: 25,
      desc: '按住后自动闪到附近的敌人身边斩击，再闪向下一个，不用瞄准。优先砍准星附近和这一轮还没砍过的敌人，每一刀也波及目标身边的敌人，消耗少量魔力。闪现的瞬间无敌，落地出刀时没有；选中露出破绽的敌人直接处决。松手、翻滚、施放别的技能或附近没有敌人时停下。',
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
      desc: '唤起烬骸仆从：迅捷的骸骨剑士，自动寻找敌人厮杀，横斩会带到身前贴着的敌人，优先攻击你最近打中的目标。基础上限 3 具。按键开关自动召唤（在你身边补到上限）；Shift + 按键在准星处召唤一具，数量已满时替换受伤最重的那具。',
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
      desc: '立起一尊石誓守像：缓慢而坚不可摧，每隔几秒双拳砸地伤害一圈敌人，并不时怒吼嘲讽，迫使周围的敌人（首领也一样）转而攻击它几秒。只能存在 1 尊。按键开关自动召唤；Shift + 按键在准星处召唤，已有的那尊会在新位置重铸。',
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
      desc: '唤起焚骨祭司：裹着焦黑法袍的骸骨术士，站在前排身后远远施法，朝怪最密的地方掷出焚骨火弹，落地炸开一片火焰。每炸到一个敌人攒一点焰蓄，攒满就放大招：怪多时召下坠焰砸向最密的一团，单个强敌（首领、精英、你的集火目标）则引导灼链持续灼烧。身子骨很脆，敌人贴近会先退开，需要仆从和守像挡在前面。基础上限 2 位，只有镶在它身上的群聚能多唤一位（天赋与装备的仆从数量不算）；拿着杖、短杖或魂幡时继承的武器伤害更多。',
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
      desc: '在准星处撕开一个黑洞，持续 3 秒：把周围的敌人往中心拽（越轻拽得越狠，首领几乎拽不动），并持续造成混沌伤害。冷却较长。',
    },
    // 黑旋风（第三轮改）：每次施放放出 count 团又快又小的漩涡（多重投射再加），扇形每团隔 spread°，路线带一点随机的摆动（wander 弧度 / 秒）。
    //   碰到敌人就吸附 latch.t 秒（贴着它不走），期间把 latch.r 以内的小怪往漩涡拽（latch.pull / √体重，首领只挪 latch.bossPull），松开后接着飞。
    //   半径 radius 以内的敌人每 tick 秒挨一跳；撞上真墙 / 悬崖按法线反弹（最多 bounce 次，再撞就散），寿命 life 秒。
    //   上限：同一次施放对同一个敌人每 tick 秒最多一跳、一共最多 cap 跳（首领 bossCap 跳）；每团最多吸附 latch.max 次，同一个敌人 latch.again 秒内不再吸。
    //   贯穿：前 N 个敌人不吸附，直接穿过（照样挨跳）；连锁：每次松开后拐向 hop.r 米内这一团还没吸过的最近敌人（每拐一次消耗 1 次）
    vortex: {
      name: '黑旋风', icon: '涡', color: '#ff6ad2', tags: ['spell', 'projectile', 'area', 'chaos'], kind: 'vortex',
      dmg: { chaos: [3.1, 4.85] }, chaosEarly: true, time: 0.55, mana: 9, cd: 0,
      count: 3, speed: 14, life: 2.2, radius: 0.9, spread: 13, wander: 1.6,
      latch: { t: 0.4, r: 2.4, pull: 4.5, bossPull: 0.3, max: 3, again: 0.8 },
      bounce: 4, tick: 0.2, cap: 3, bossCap: 4, hop: { r: 7 },
      // useMult：单体小怪每次施放实测平均 2.9 跳（chaos-tools/fx-hits.mjs，5 个种子共 112 次）；每跳伤害按「平均每跳 × 跳数」和第二轮的 4.6 × 2.5 相同定
      w: 0, kb: 0, poise: 3, useMult: 2.9,
      desc: '放出三团疾飞的小黑旋风，路线飘忽不定。碰到敌人就吸附在它身上片刻，把周围的小怪拽过来一起绞，持续造成混沌伤害，然后接着飞；撞到墙会弹开，在狭窄的地方来回反弹。',
    },
    // 黑焰：光环（buff：不脉冲、自己不造成伤害）。你和召唤物的每一击额外造成 F% 的混沌伤害，
    //   F = min(cap, k0 + k1 × (宝石等级 − 1)) × (1 + 黑焰效果%)，40 级（宝石 30）约 13%，37 级宝石封顶 15%；和注入一样按加成之后、暴击之前的伤害折算（相加，不再吃混沌加成）。
    //   爆燃 / 电弧这类触发伤害与霜环的脉冲不带黑焰。只能镶节流
    blackflame: {
      name: '黑焰', icon: '冥', color: '#e04cc0', tags: ['spell', 'aura', 'chaos'], kind: 'aura', buff: true,
      mana: 0, reserve: 35, cd: 0, time: 1, w: 0, kb: 0, poise: 0,
      flame: { k0: 6, k1: 0.25, cap: 15 },
      desc: '光环：放在技能栏上即常驻生效，保留 35% 最大魔力（以血为引时改为保留生命）。你和召唤物的每一击都附带一缕黑焰，造成相当于这一击伤害一定比例的额外混沌伤害。只能镶节流。',
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
      desc: '先朝准星突刺，贯穿一条直线上的所有敌人；随即回身横扫，斩击身边一整圈。',
    },
    leyburst: {
      name: '地脉涌', icon: '涌', color: '#ffb07a', tags: ['weapon', 'spell', 'area'], kind: 'wstaff', weaponOnly: true, wtype: 'staff',
      edmg: [48, 72], elem: 'fire', time: 0.55, mana: 12, cd: 6, radius: 5.2, ailment: 60, w: 1, kb: 1.4, poise: 22, move: 0.3,
      wt: { phases: [0.38], cancel: 0.55, dur: 0.7 },
      useMult: 1,
      desc: '以杖顿地，地脉之力在身边炸开一圈，属性取你加成最高的元素，并大幅累积该元素的异常值。墙后的敌人不受波及。',
    },
    arcvolley: {
      name: '秘弹连射', icon: '弹', color: '#c9b4ff', tags: ['weapon', 'spell', 'projectile'], kind: 'wwand', weaponOnly: true, wtype: 'wand',
      edmg: [7.5, 11.5], elem: 'light', time: 0.45, mana: 10, cd: 5, n: 5, gap: 0.09, speed: 21, projR: 0.26, range: 18, seek: 6, turn: 9, explode: 1.8,
      w: 0, kb: 0.3, poise: 6, move: 0.5,
      wt: { phases: [0.2], cancel: 0.45, dur: 0.6 },
      useMult: 5,
      desc: '快速连射 5 枚追踪秘弹，飞向准星附近的敌人（有多个时轮流分配），命中后在小范围内炸开，属性取你加成最高的元素。秘弹撞墙即散。',
    },
    shadowstab: {
      name: '影刺', icon: '刺', color: '#a9a2ff', tags: ['weapon', 'attack', 'melee', 'phys', 'movement'], kind: 'wdaggers', weaponOnly: true, wtype: 'daggers',
      wm: 3.85, time: 0.34, mana: 6, cd: 4, range: 8, radius: 1.4, w: 2, kb: 1.2, poise: 30, stop: 90, iframe: 0.3, move: 0,
      wt: { phases: [0.06, 0.16], cancel: 0.34, dur: 0.45, clip: { dur: 0.55, at: 0.16 } }, // 动作的命中帧是刺出那一下
      useMult: 1, sureCrit: true, // 必定暴击
      desc: '闪到准星附近敌人（8 格以内、中间没有墙）的身后刺出一击，必定暴击，并波及目标身边的敌人。闪现的瞬间无敌。附近没有目标时不会施放。',
    },
    quake: {
      name: '震地', icon: '震', color: '#d8b07a', tags: ['weapon', 'attack', 'melee', 'area', 'phys'], kind: 'whammer', weaponOnly: true, wtype: 'hammer',
      wm: 6.0, time: 0.85, mana: 8, cd: 6, len: 9, w0: 2.0, w1: 5.5, reach: 1.4, slamR: 2.2, wave: 28, w: 2, kb: 3.2, poise: 60, stop: 110, move: 0.1,
      wt: { phases: [0.5], cancel: 0.85, dur: 1.0 },
      useMult: 1,
      desc: '高举战锤砸向地面，冲击波朝准星方向推进、越远越宽，重创沿途敌人并将其震飞，削减大量架势。冲击波遇墙即止。',
    },
    flashcut: {
      name: '瞬断', icon: '断', color: '#e8f0ff', tags: ['weapon', 'attack', 'melee', 'phys', 'movement'], kind: 'wkatana', weaponOnly: true, wtype: 'katana',
      wm: 6.9, time: 0.26, mana: 8, cd: 6, range: 8, width: 1.0, dash: 0.14, delay: 0.35, w: 2, kb: 1.0, poise: 40, stop: 100, move: 0,
      wt: { phases: [0.08], cancel: 0.26, dur: 0.4, clip: { dur: 0.75, at: 0.22 } }, // 命中帧对到冲刺结束，收刀的一甩正好对上斩开
      useMult: 1,
      desc: '朝准星疾冲而过（途中无敌，遇墙即停），约 0.35 秒后，沿途经过的每一个敌人同时被斩开，伤害极高。',
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
      desc: '挥动魂幡，放出 4 只魂火扑向准星附近的敌人，碰到即炸开，伤害按召唤物计算（吃召唤物伤害加成）。同时令你所有的召唤物狂热 4 秒：攻击与移动速度提高 30%。没有召唤物时也能用，有召唤物时更强。',
    },

    // ---------- 远程武器（枪械 / 弓）：右键 = 武器普攻，R = 量表技 ----------
    // 拿着枪械或弓时，右键自动换成这把武器的普攻（basic: true，id 为 basic_<武器类型>）：不掉落、不进技能栏，技能页上是一张「武器普攻」卡，
    // 3 个辅助孔属于卡片本身（save.sockets[G.BASIC_CARD]），换别的远程武器时宝石不动，只按当前普攻的标签生效。
    // 普攻按武器伤害 × wm 成长（等级 = 宝石的成长下限），出手节奏乘武器攻速与出手速度，不消耗魔力。
    // time：两发之间的秒数（机炮是转满之后的最快间隔；喷枪是两跳之间）；draw：弓第一箭的拉弓时间；
    // heat：枪械每秒开火增加的热度（左轮按发：heatShot），见 G.RANGED。conv：伤害转换（{ 元素: 比例 }，'rune' = 符文弓按元素加成取元素）
    basic_gatling: {
      name: '开火', icon: '射', color: '#ffc46a', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'gatling', weaponOnly: true, basic: true,
      // spin：枪管空转多久才开火；rate0：刚转起来时的射速比例，ramp 秒后到最快；spread：弹道散布（度）
      // pierce：每发子弹自带穿透 1 个敌人（扫怪群时打得到后排）
      wm: 0.7, time: 0.083, mana: 0, cd: 0, spin: 0.5, rate0: 0.4, ramp: 2.5, speed: 42, projR: 0.18, range: 18, spread: 4, pierce: 1,
      heat: 6.5, move: 0.35, w: 0, kb: 0.06, poise: 4, addEff: 0.25,
      desc: '按住右键：枪管先空转约 0.5 秒，转起来之后开火，射速越打越快（约 2.5 秒后最快）。每一发子弹穿透 1 个敌人。开火时移动很慢，每一发都削不少架势。持续开火积攒热度。装备上的附加伤害只按 25% 计。',
    },
    basic_flamer: {
      name: '开火', icon: '焰', color: '#ff8a3c', tags: ['attack', 'area', 'fire'], kind: 'rbasic', rtype: 'flamer', weaponOnly: true, basic: true,
      // 身前 range 半径、arc 度的扇面，每 time 秒一跳；ember：每 gap 秒在火舌尽头留下一团余烬（半径 r、持续 dur 秒、每 tick 秒对里面的敌人造成 mult 倍伤害，
      // 同一个敌人站在几团余烬里也只按一团算）
      wm: 0.45, time: 0.1, mana: 0, cd: 0, range: 5.5, arc: 60, conv: { fire: 1 }, ailment: 50,
      ember: { gap: 0.3, r: 1.5, dur: 2.5, tick: 0.5, mult: 0.3 },
      heat: 6.5, move: 0.55, w: 0, kb: 0, poise: 2, addEff: 0.3, // 火舌不推人：一秒十跳，推开了就喷不到了
      desc: '按住右键喷出火舌：身前短距离的扇面内持续灼烧所有敌人（全部是火焰伤害，异常值累积很快），并在地上留下燃烧的余烬。持续开火积攒热度。装备上的附加伤害只按 30% 计。',
    },
    basic_revolver: {
      name: '开火', icon: '射', color: '#ffd28a', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'revolver', weaponOnly: true, basic: true,
      // clip 发一轮，打空后 reload 秒自动装填
      wm: 1.05, time: 0.27, mana: 0, cd: 0, clip: 6, reload: 0.6, speed: 46, projR: 0.2, range: 20,
      heatShot: 2.4, move: 0.8, w: 0, kb: 0.35, poise: 9, stop: 12, addEff: 0.75,
      desc: '右键开枪：单发伤害高、又快又准，可以边走边打。每打完 6 发自动快速装填。每一发都积攒热度。装备上的附加伤害按 75% 计。',
    },
    basic_huntbow: {
      name: '射击', icon: '矢', color: '#bfe8a0', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'huntbow', weaponOnly: true, basic: true,
      // seek：箭会拐向身边 seek 米内的敌人，turn 每秒最多转的弧度；pierce：自带穿透 1 个敌人，穿过之后重新找下一个猎物（见 afterPlayerHit）
      wm: 0.9, time: 0.38, mana: 0, cd: 0, draw: 0.12, speed: 30, projR: 0.24, range: 22, seek: 7, turn: 7, pierce: 1,
      move: 0.6, w: 0, kb: 0.3, poise: 6,
      desc: '右键射箭：箭矢会自己拐向附近的敌人，射中后还会穿过去、再追下一个敌人。命中积攒专注，暴击和远距离命中积攒得更多。',
    },
    basic_eagle: {
      name: '射击', icon: '矢', color: '#e8f0d0', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'eagle', weaponOnly: true, basic: true,
      // critFlat / critMulti：普攻自带的暴击率与暴击伤害；far：距离 G.RANGED.farMax 以外命中时额外的伤害（之间按距离线性）
      wm: 1.0, time: 0.48, mana: 0, cd: 0, draw: 0.16, speed: 40, projR: 0.22, range: 26, critFlat: 12, critMulti: 50, far: 0.35,
      move: 0.5, w: 0, kb: 0.5, poise: 9,
      desc: '右键射箭：暴击率与暴击伤害很高，离得越远伤害越高。命中积攒专注，暴击和远距离命中积攒得更多。',
    },
    basic_runebow: {
      name: '射击', icon: '矢', color: '#c9a6ff', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'runebow', weaponOnly: true, basic: true,
      // conv 'rune'：convK 的伤害转成你元素伤害加成最高的那种元素（都没有加成时火 / 冰 / 雷轮流）
      // chain：符文箭命中后弹向附近另一个敌人一次（打怪群时元素异常铺得开）
      wm: 1.15, time: 0.4, mana: 0, cd: 0, draw: 0.13, speed: 32, projR: 0.24, range: 22, conv: 'rune', convK: 0.6, ailment: 40, chain: 1,
      move: 0.6, w: 0, kb: 0.3, poise: 6,
      desc: '右键射箭：箭上带着元素（取你元素伤害加成最高的那种，没有加成时火、冰、雷轮流），异常值累积很快，命中后还会弹向附近另一个敌人一次。命中积攒专注。',
    },
    basic_emberbow: {
      name: '射击', icon: '矢', color: '#9fd8ff', tags: ['attack', 'projectile', 'phys'], kind: 'rbasic', rtype: 'emberbow', weaponOnly: true, basic: true,
      // spark：每支箭命中后迸出一枚冰晶，跳向 r 米内最近的另一个敌人，最多跳 n 次，每跳 mult 倍伤害（全部转为冰霜）
      wm: 1.1, time: 0.42, mana: 0, cd: 0, draw: 0.13, speed: 34, projR: 0.24, range: 22, spark: { n: 2, r: 6, mult: 0.35 },
      move: 0.6, w: 0, kb: 0.3, poise: 7,
      desc: '右键射箭：每支箭命中后迸出冰晶，在附近的敌人之间连跳 2 次，造成冰霜伤害。命中积攒专注。',
    },

    // R（量表技）：rgauge 为 true——没有冷却、不扣魔力，量表满了才能放，放出去量表清零。枪械的三招按武器伤害成长（吃「热度技伤害」），
    // 弓的四招是限时增益（buff.dur 秒，吃「增益持续时间」）
    meltray: {
      name: '熔光射线', icon: '光', color: '#ffb36a', tags: ['weapon', 'attack', 'fire', 'light'], kind: 'rgatling', weaponOnly: true, wtype: 'gatling', rgauge: true,
      // 按住 R 蓄力（瞄准线跟着准星），松手放出一道贯穿射线：长 len、宽 width 的直线上所有敌人挨一下 wm 倍伤害（一半火焰一半闪电）。
      // 蓄力 charge 秒满；伤害按蓄力程度 minK → 1；蓄满后再按住 hold 秒自动放出。蓄力时移动速度 × move
      wm: 40, time: 0.3, mana: 0, cd: 0, charge: 1.4, hold: 1.0, minK: 0.3, len: 24, width: 2.4, beamT: 0.4, conv: { fire: 0.5, light: 0.5 }, ailment: 100,
      w: 2, kb: 1.4, poise: 80, stop: 120, move: 0.35,
      wclip: 'r_gatling',
      wt: { phases: [0.3], cancel: 9, dur: 9, clip: { dur: 3.2, at: 0.3 } }, // 时长由蓄力自己管（起手 0.3 秒 + 蓄力 + 射线）
      useMult: 40,
      desc: '热度满时可用：按住 R 蓄力，枪口的瞄准线跟着准星走；松手放出一道巨大的熔光射线，贯穿一整条直线上的所有敌人，造成一次性的巨额伤害并重重击退。蓄力越久伤害越高（1.4 秒蓄满，蓄满后再按住 1 秒会自动放出）。伤害一半火焰、一半闪电，同时累积两种异常值。放完热度归零。',
    },
    firestorm: {
      name: '焚天炎爆', icon: '爆', color: '#ff6a2c', tags: ['weapon', 'attack', 'area', 'fire'], kind: 'rflamer', weaponOnly: true, wtype: 'flamer', rgauge: true,
      // 半径 radius 的火浪，wm 倍武器伤害（全部火焰）；之后留下半径 burn.r 的火场，burn.dur 秒内每 burn.tick 秒 burn.mult 倍武器伤害
      wm: 14, time: 0.75, mana: 0, cd: 0, radius: 7.5, conv: { fire: 1 }, ailment: 100, burn: { r: 6, dur: 5, tick: 0.5, mult: 1 },
      w: 2, kb: 2.6, poise: 70, stop: 110, move: 0.1,
      wclip: 'r_flamer',
      wt: { phases: [0.42], cancel: 0.75, dur: 0.9 },
      useMult: 24,
      desc: '热度满时可用：一口气排空所有热度，以你为中心炸开一圈巨大的火浪，重创并震退周围的敌人，并留下 5 秒的大片火场。',
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
      desc: '热度满时可用：接下来 3 秒里朝四面八方疯狂开火，子弹在身边最多 8 个敌人之间轮流扫射，每发贯穿 1 个敌人，命中处炸开弹片波及周围的敌人。期间可以自由走动、不会被打断。放完热度归零。',
    },
    volley: {
      name: '万矢', icon: '矢', color: '#bfe8a0', tags: ['weapon', 'attack'], kind: 'rbuff', weaponOnly: true, wtype: 'huntbow', rgauge: true,
      // split：每支箭分成几支追踪箭，每支 mult 倍伤害；fan：散开的角度
      buff: { dur: 8, split: 5, mult: 0.4, fan: 50 },
      time: 0.4, mana: 0, cd: 0, w: 0, kb: 0, poise: 0, move: 0.5,
      wclip: 'r_huntbow',
      wt: { phases: [0.22], cancel: 0.4, dur: 0.5 },
      useMult: 0,
      desc: '专注满时可用：8 秒内每一支箭都分裂成 5 支追踪箭（每支 40% 伤害），各自扑向附近的敌人。放完专注归零。',
    },
    pierceheart: {
      name: '一矢穿心', icon: '穿', color: '#e8f4ff', tags: ['weapon', 'attack'], kind: 'rbuff', weaponOnly: true, wtype: 'eagle', rgauge: true,
      buff: { dur: 8, crit: 100, pierce: 99 },
      time: 0.4, mana: 0, cd: 0, w: 0, kb: 0, poise: 0, move: 0.5,
      wclip: 'r_eagle',
      wt: { phases: [0.22], cancel: 0.4, dur: 0.5 },
      useMult: 0,
      desc: '专注满时可用：8 秒内每一支箭都必定暴击，并贯穿路上的所有敌人。放完专注归零。',
    },
    overflow: {
      name: '元素满溢', icon: '溢', color: '#c9a6ff', tags: ['weapon', 'attack'], kind: 'rbuff', weaponOnly: true, wtype: 'runebow', rgauge: true,
      // 箭的伤害全部转成元素，火 → 冰 → 雷轮流；异常累积 × ailment；每次命中在目标处炸开半径 burst.r、burst.mult 倍伤害的同元素小爆炸
      buff: { dur: 8, ailment: 2, burst: { r: 2.2, mult: 0.4 } },
      time: 0.4, mana: 0, cd: 0, w: 0, kb: 0, poise: 0, move: 0.5,
      wclip: 'r_runebow',
      wt: { phases: [0.22], cancel: 0.4, dur: 0.5 },
      useMult: 0,
      desc: '专注满时可用：8 秒内箭矢全部化为元素，火、冰、雷轮流，异常值累积翻倍，每次命中还在目标处炸开一团同元素的小爆炸。放完专注归零。',
    },
    emberstorm: {
      name: '凛冬', icon: '凛', color: '#9fd8ff', tags: ['weapon', 'attack', 'cold'], kind: 'rbuff', weaponOnly: true, wtype: 'emberbow', rgauge: true, uskill: true,
      // fan：每次射出几支箭（各 mult 倍伤害）；spark：冰晶改为跳 n 次、每跳 mult 倍；blast：被箭或冰晶打死的敌人碎成冰爆（半径 r、mult 倍冰霜伤害）
      buff: { dur: 8, fan: 3, mult: 0.75, spread: 16, spark: { n: 4, mult: 0.45 }, blast: { r: 3, mult: 0.6 } },
      time: 0.4, mana: 0, cd: 0, w: 0, kb: 0, poise: 0, move: 0.5,
      wclip: 'r_emberbow',
      wt: { phases: [0.22], cancel: 0.4, dur: 0.5 },
      useMult: 0,
      desc: '专注满时可用：8 秒内每次射出 3 支寒冰箭，冰晶在敌人之间连跳 4 次、伤害更高，被箭或冰晶打死的敌人当场碎成一圈冰爆。放完专注归零。',
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
      desc: '在准星附近的敌人之间连闪至多 6 次（闪现途中无敌，不穿墙，附近没有敌人就提前收手），每一闪斩出一刀并留下斩痕。收刀的一瞬，所有斩痕一齐炸开；带着残刃的敌人每层残刃再受到额外伤害（残刃被吃掉）。附近没有敌人时不会施放。',
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
      desc: '在准星一带召来持续 4 秒的元素风暴：陨火、冰棱与落雷轮番砸下，每秒 5 击，优先落在范围里的敌人身上，每一击都按它自己的元素伤害加成计算，并大幅累积异常值——冻结、爆燃、感电会在怪群里接连炸开。首领的阈值照常变高，不会被冻结。',
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
      desc: '把魂幡插进地里：6 位英灵从天而降，落在准星一带，落地时各砸出一圈冲击，随后自动厮杀 8 秒再消散（化作魂火炸开）。英灵的伤害与生命按召唤物计算，吃召唤物加成与继承，不占仆从数量。同时把你现有的召唤物全部治疗到满，并令它们狂热 4 秒。',
    },
  };
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
    }
  }

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
  //        异常值大于 0 时附带轻度冰缓，减速 = 异常值 × chill。冻结 / 重度冰缓期间不再累积冰霜异常值
  //   火 → 爆燃：以敌人为中心半径 blastR 的爆炸，伤害 = 灌满期间平均每击的火焰伤害 × (1 + 异常累积速度%) × blast，封顶为该敌人阈值 × blastCap；爆炸本身不累积异常值（不会连锁）
  //   雷 → 感电 shock 秒：期间它每受到一次命中，就射出 shockN 道电弧，射向 shockR 以内最近的其他敌人（附近一个都没有时，只有一道打回它自己），
  //        每道 = 这一击的 bolt 倍；电弧不再触发电弧、不累积异常值，同一个敌人每 shockGap 秒最多放一次。感电期间不再累积闪电异常值
  G.BUILDUP = {
    th: 0.18, thElite: 0.3, boss: 0.15, bossGrow: 0.5, bossGrowMax: 4,
    rate: { fire: 1, cold: 1.2, light: 1.6 },
    hold: 3, decay: 0.5,
    chill: 0.3, freeze: 1.5, freezeElite: 1.0, bossChill: 3, bossSlow: 0.5,
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
    fire: { name: '灼炎注入', req: null, cost: 1.2, eff: { extra: { fire: 30 } }, desc: '获得相当于伤害 30% 的额外火焰伤害' },
    cold: { name: '寒霜注入', req: null, cost: 1.2, eff: { extra: { cold: 30 } }, desc: '获得相当于伤害 30% 的额外冰霜伤害' },
    light: { name: '雷霆注入', req: null, cost: 1.2, eff: { extra: { light: 30 } }, desc: '获得相当于伤害 30% 的额外闪电伤害' },
    chaos: { name: '混沌注入', req: null, cost: 1.2, eff: { extra: { chaos: 30 } }, desc: '获得相当于伤害 30% 的额外混沌伤害' },
    brutal: { name: '蛮力', req: ['phys'], cost: 1.2, eff: { moreType: { phys: 35 } }, desc: '物理伤害额外提高 35%' },
    precise: { name: '致命', req: null, cost: 1.15, eff: { critFlat: 8, critMulti: 40 }, desc: '暴击率 +8%，暴击伤害 +40%' },
    leech: { name: '汲生', req: null, no: ['minion'], cost: 1.1, eff: { leech: 3 }, desc: '造成伤害的 3% 转化为生命' },
    echo: { name: '回响', req: ['spell'], no: ['summon', 'aura', 'duration'], cost: 1.4, eff: { echo: 1, more: -30 }, desc: '法术自动重复施放一次，伤害减少 30%（持续类法术镶不上）' },
    stagger: { name: '震慑', req: ['attack', 'minion'], cost: 1.15, eff: { stun: 0.7 }, desc: '击中时使非首领敌人眩晕 0.7 秒' },
    ailment: { name: '蚀染', req: null, cost: 1.1, eff: { ailment: 35 }, desc: '异常值的累积速度加快 35%（更快触发爆燃、冻结、感电与渊缚）' },
    frugal: { name: '节流', req: null, cost: 0.6, eff: { cdr: 25 }, desc: '魔力消耗减少 40%（光环的魔力保留同样减少 40%），冷却时间缩短 25%' },
    // 召唤物专用
    dominion: { name: '驭灵', req: ['minion'], cost: 1.25, eff: { minionMore: 30 }, desc: '召唤物造成的伤害额外提高 30%' },
    ossify: { name: '坚骨', req: ['minion'], cost: 1.15, eff: { minionLife: 40, minionDR: 15 }, desc: '召唤物最大生命提高 40%，受到的伤害减少 15%' },
    // noKind：这些召唤物镶不上（守像只能有 1 尊）。镶在焚骨祭司上时是祭司 +1
    horde: { name: '群聚', req: ['minion'], noKind: ['colossus'], cost: 1.3, eff: { minionCap: 1, minionMore: -15 }, desc: '所镶召唤技能的数量上限 +1（烬骸仆从或焚骨祭司；守像镶不上），召唤物造成的伤害额外降低 15%' },
    frenzy: { name: '狂怒', req: ['minion'], cost: 1.2, eff: { minionSpeed: 20 }, desc: '召唤物的攻击速度与移动速度提高 20%' },
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
  G.RARITY_NAME = ['普通', '魔法', '稀有', '烬铸'];
  G.RARITY_COLOR = ['#d6d1c4', '#7f9dff', '#ffd75e', '#ff9b3d'];

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
      lore: '雷霆监察者的刑刀断在烬渊里，断口至今还在发烫。',
    },
    sanxiang: {
      name: '三相之心', base: 1, boss: 'weaver', mech: 'tri', mechName: '三相共鸣', uskill: 'tristorm',
      lines: [{ id: 'uIncElem', k: [1.15, 1.65] }, { id: 'uAilment', k: [1.0, 1.5] }, { id: 'speed', k: [1.0, 1.4] }, { id: 'addLight', k: [0.95, 1.35] }],
      lore: '霜织者把三种元素织进同一颗心里，它们至今仍在互相拉扯。',
    },
    wanhun: {
      name: '万魂旗', base: 7, boss: 'lord', mech: 'soul', mechName: '魂火轮回', uskill: 'soulhost',
      lines: [{ id: 'minionDmg', k: [0.1, 0.2] }, { id: 'minionLife', k: [0.3, 0.6] }, { id: 'minionCap', fixed: 1 }, { id: 'wInc', k: [2.0, 2.8] }],
      lore: '烬渊之主麾下的亡魂都系在这面旗上，倒下一个，就烧起一团。',
    },
    // 熔芯（左轮）：熔渣巨像掉。R 是它专属的「乱射」；机制「熔芯弹」——每一轮的最后一发必定暴击，并在命中处炸开
    rongxin: {
      name: '熔芯', base: 12, boss: 'golem', mech: 'core', mechName: '熔芯弹', uskill: 'wildfire',
      lines: [{ id: 'wInc', k: [1.7, 2.3] }, { id: 'critMulti', k: [1.1, 1.5] }, { id: 'heatGain', k: [1.2, 1.7] }, { id: 'speed', k: [0.9, 1.3] }],
      lore: '熔渣巨像胸腔里那块烧不化的芯子，被人车成了枪膛。',
    },
    // 凛羽（弓，内部 id 仍是 jinyu）：第五个区域（坠星裂谷）的首领衔星巨兽掉（bossZone 兜底：首领 id 对不上时取这个区域的首领，见 G.syncUniqueBosses）。
    // R 是专属的「凛冬」；机制「碎晶连跳」写在它的普攻里（basic_emberbow 的 spark），这里加强：冰晶给目标灌冰霜异常值
    // （内部 id 仍沿用 jinyu / emberbow / emberstorm / mech 'ember'，旧存档不用迁移）
    jinyu: {
      name: '凛羽', base: 13, boss: 'behemoth', bossZone: 'rift', mech: 'ember', mechName: '碎晶连跳', uskill: 'emberstorm',
      lines: [{ id: 'wInc', k: [1.6, 2.2] }, { id: 'incCold', k: [1.2, 1.7] }, { id: 'focusGain', k: [1.2, 1.7] }, { id: 'crit', k: [1.2, 1.7] }],
      lore: '衔星巨兽吞下的星辰在它腹中冻成了冰，坠落时迸出的每一片，都削成了一根羽箭。',
    },
    // 星蚀（短杖）：衔星巨兽掉，和凛羽共用一次掉落判定与保底（G.UNIQUE_ALT）。没有专属烬铸技：拿着它时武器技秘弹连射的属性固定为混沌。
    // 机制「渊口」见 G.VOID_MOUTH
    xingshi: {
      name: '星蚀', base: 2, boss: 'behemoth', bossZone: 'rift', mech: 'void', mechName: '渊口',
      lines: [{ id: 'incChaos', k: [1.6, 2.2] }, { id: 'addChaos', k: [1.2, 1.6] }, { id: 'bindAil', k: [1.3, 1.8] }, { id: 'speed', k: [1.0, 1.4] }],
      lore: '衔星巨兽背上那块坠星早已烧空了芯，只剩一圈吞光的黑，握在手里能听见它在往里塌。',
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
  G.UNIQUES.jinduan.mechDesc = '每次暴击在目标身上留下一道残刃；叠满 ' + G.MARK.max + ' 道一齐引爆，造成 ' + pc(G.MARK.mult) + ' 武器伤害的物理伤害（必定暴击），周围 ' + G.MARK.r + ' 米内的其他敌人受到其中 ' + pc(G.MARK.splash) +
    '。带着残刃的敌人倒下时，残刃飞到 ' + G.MARK.jump + ' 米内最近的敌人身上。';
  G.UNIQUES.sanxiang.mechDesc = '任何敌人触发冻结、爆燃或感电时，' + G.TRI.r + ' 米内的敌人（含它自己）获得另外两种元素各 ' + pc(G.TRI.k) + ' 条异常值；已在感电或冰缓中的改为续满时间，被灌爆的爆燃沿用源头的火焰伤害。共鸣灌满的异常不再引发共鸣。' +
    (G.TRI.grow < 1 ? '首领不会因为异常越打越难触发。' : '');
  G.UNIQUES.wanhun.mechDesc = '召唤物倒下时化作魂火炸开，对周围 ' + G.SOULFIRE.r + ' 米内的敌人造成它最大生命 ' + pc(G.SOULFIRE.k) + ' 的火焰伤害。自动召唤不消耗魔力。召唤物继承武器伤害的比例' +
    (G.SOULFIRE.gated ? '最多' : '') + '提高 ' + pc(G.SOULFIRE.inherit - 1) + (G.SOULFIRE.gated ? '（和继承一样按武器物品等级折算）' : '') + '。';
  // 熔芯弹：每一轮（6 发）的最后一发必定暴击，命中时在目标处炸开半径 r、mult 倍伤害的火焰爆炸（不伤目标本身）
  G.CORE_ROUND = { r: 2.5, mult: 0.8 };
  // 碎晶连跳（凛羽）：普攻的冰晶（basic_emberbow.spark）每跳额外灌入 ignite 条冰霜异常值
  G.EMBER_MECH = { ignite: 0.12 };
  G.UNIQUES.rongxin.mechDesc = '每一轮的最后一发是熔芯弹：必定暴击，并在命中处炸开，对周围 ' + G.CORE_ROUND.r + ' 米内的其他敌人造成 ' + pc(G.CORE_ROUND.mult) + ' 的火焰伤害。';
  G.UNIQUES.jinyu.mechDesc = '每支箭命中后迸出冰晶，在附近的敌人之间连跳，每跳造成冰霜伤害并额外灌入 ' + pc(G.EMBER_MECH.ignite) + ' 条冰霜异常值。';
  // 渊口（星蚀）：任何敌人触发渊缚时，脚下张开一道小黑洞：半径 radius、持续 dur 秒、牵引 × pull、每跳伤害按你的黑洞宝石的 dmg 倍
  //   （没学黑洞时按同等级的基础值）；同时最多 max 道，每 gap 秒最多新开一道
  G.VOID_MOUTH = { radius: 2.4, dur: 1.5, pull: 0.6, dmg: 0.5, max: 2, gap: 2 };
  G.UNIQUES.xingshi.mechDesc = '任何敌人触发渊缚时，在它脚下张开一道渊口：持续 ' + G.VOID_MOUTH.dur + ' 秒的小黑洞，半径 ' + G.VOID_MOUTH.radius + ' 米，牵引是黑洞的 ' + pc(G.VOID_MOUTH.pull) +
    '，每跳伤害按你的黑洞的 ' + pc(G.VOID_MOUTH.dmg) + '。同时最多 ' + G.VOID_MOUTH.max + ' 道，每 ' + G.VOID_MOUTH.gap + ' 秒最多新开一道。武器技秘弹连射的属性固定为混沌。';
  // 分解烬铸武器固定得到的通货
  G.UNIQUE_SALVAGE = { exalt: 2, chaos: 2, divine: 1, chisel: 1 };

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
    chisel: { name: '琢刻石', color: '#a6e36a', w: 7, desc: '用于魔法或稀有物品：从词缀里挑一条，只把这一条重洗成另一条同类词缀（前缀换前缀、后缀换后缀），其他词缀不变' },
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
    desc: '尚未刻下技能的宝石。在技能页（G）挑一个技能用它学会，或把等级更低的已学技能升到它的等级',
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

  // ---------- 区域 ----------
  G.ZONES = [
    {
      id: 'ash', name: '灰烬荒原', level: 1, elem: 'fire', boss: 'golem',
      fog: 0x1c130f, voidc: 0x130d0b, path: 0x7a6252, rock: 0x4b3a33, accent: 0xff6a2a, sky: 0xffc9a0,
      mobs: ['husk', 'husk', 'spitter', 'brute'], desc: '大火烧尽之后的荒地，余烬里有东西在动。',
    },
    {
      id: 'frost', name: '霜骨沼泽', level: 5, elem: 'cold', boss: 'weaver',
      fog: 0x0e161c, voidc: 0x0a1014, path: 0x56707a, rock: 0x33454f, accent: 0x7fd4ff, sky: 0xbfe6ff,
      mobs: ['husk', 'spitter', 'bomber', 'brute'], desc: '冻住的沼地，冰层下埋着旧时代的骨头。',
    },
    {
      id: 'storm', name: '雷鸣遗迹', level: 9, elem: 'light', boss: 'warden',
      fog: 0x14131f, voidc: 0x0c0b14, path: 0x6a6480, rock: 0x3d3a52, accent: 0xffe45e, sky: 0xe0d8ff,
      mobs: ['husk', 'spitter', 'bomber', 'brute', 'spitter'], desc: '仍在运转的古代机关，雷声从不停歇。',
    },
    {
      id: 'abyss', name: '烬渊深处', level: 13, elem: 'fire', boss: 'lord',
      fog: 0x1a0c10, voidc: 0x0f0709, path: 0x6e4a4a, rock: 0x3f2a2c, accent: 0xff3a4a, sky: 0xffb0a0,
      mobs: ['husk', 'bomber', 'spitter', 'brute', 'brute'], desc: '一切灰烬的源头。',
    },
    {
      // 第五区：烬渊之下，天穹裂开、星骸坠落的谷地。地面是墨绿的熔融琉璃，裂纹里流着星辉
      id: 'rift', name: '坠星裂谷', level: 17, elem: 'light', boss: 'behemoth',
      fog: 0x0a1613, voidc: 0x050c0a, path: 0x44685a, rock: 0x263a35, accent: 0x6effc8, sky: 0xc4ffe6,
      mobs: ['husk', 'phaser', 'charger', 'spitter', 'brute', 'phaser', 'charger'], desc: '天穹在这里裂开过一道口子，坠下来的星骸至今还在放电。',
    },
  ];
  // 第五区上线之前就打通过烬渊深处的老存档：读档时提示一次「烬渊深处之后多了一个区域」。
  // 判定看原始存档：烬渊深处有通关记录、坠星裂谷还没有、而且这条提示没看过（save.tut[id]）。
  // 老角色的 maxTier 原样保留：已经开启的层级照常能进，只是在最高层级要打通新的末区才开下一层
  G.NEW_ZONE_NOTICE = {
    id: 'zone5', zone: 'rift', after: 'abyss',
    html: '<b>新区域开放</b>：「烬渊深处」之后多了一个区域——<b>坠星裂谷</b>（怪物等级 17 起），首领是<b>衔星巨兽</b>。' +
      '已经开启的轮回层级全部保留；今后在最高层级击败坠星裂谷的首领，才会开启更高一层。每个轮回层级的怪物等级改为 +20（原来 +16），五个区域接着往上走。按 <kbd>M</kbd> 打开地图',
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
  };
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
    const w = e.isBoss ? 20 : ((e.def && e.def.xp) || 1) * (e.elite ? 3 : 1);
    return G.mobXp(Math.min(e.level, charLvl + G.XP_UNDER)) * w * G.xpLevelK(charLvl - e.level);
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
