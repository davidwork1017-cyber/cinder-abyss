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

  G.TYPES = ['phys', 'fire', 'cold', 'light'];
  G.TYPE_NAME = { phys: '物理', fire: '火焰', cold: '冰霜', light: '闪电' };
  G.TYPE_COLOR = { phys: '#e6dfd0', fire: '#ff8a3c', cold: '#86d8ff', light: '#ffe45e' };
  G.TYPE_HEX = { phys: 0xe6dfd0, fire: 0xff7a2c, cold: 0x7fd4ff, light: 0xffe45e };
  G.CAP = { phys: 'Phys', fire: 'Fire', cold: 'Cold', light: 'Light' };

  G.TAG_NAME = {
    attack: '攻击', spell: '法术', melee: '近战', projectile: '投射物', area: '范围',
    chaining: '连锁', phys: '物理', fire: '火焰', cold: '冰霜', light: '闪电', movement: '位移',
    minion: '召唤物', summon: '召唤', aura: '光环', weapon: '武器技',
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
      taunt: { cd: 7, r: 6, dur: 3, boss: 0.8 }, // 嘲讽：冷却、半径、小怪被嘲讽的秒数、首领被嘲讽的秒数
      desc: '立起一尊石誓守像：缓慢而坚不可摧，每隔几秒双拳砸地伤害一圈敌人，并不时怒吼嘲讽，迫使周围的敌人转而攻击它。只能存在 1 尊。按键开关自动召唤；Shift + 按键在准星处召唤，已有的那尊会在新位置重铸。',
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
    arrowrain: {
      name: '箭雨', icon: '雨', color: '#bfe0a0', tags: ['weapon', 'attack', 'area', 'phys'], kind: 'wbow', weaponOnly: true, wtype: 'bow',
      wm: 0.62, time: 0.45, mana: 12, cd: 8, range: 14, radius: 3.5, delay: 0.35, ticks: 12, tick: 0.25, ailment: 50, infuse: true,
      w: 0, kb: 0.1, poise: 5, move: 0.4,
      wt: { phases: [0.3], cancel: 0.45, dur: 0.55 },
      useMult: 12,
      desc: '朝天射出一蓬箭，约 3 秒内箭矢不断落在准星一带，反复命中范围内的敌人。技能栏上任何技能镶着的注入宝石（灼炎 / 寒霜 / 雷霆）都会附在箭上，并更快累积元素异常值。',
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
  // 每个敌人有火 / 冰 / 雷三条异常值（0..1）。每次命中按这一击里该元素的伤害累积：伤害 ÷ 阈值 × (1 + 异常累积速度% / 100)。
  // 阈值 = 最大生命 × th（精英再 × elite，首领用 boss），首领每触发一次，该元素的阈值提高 bossGrow（封顶 bossGrowMax 倍），像架势一样越打越难。
  // hold 秒没有再受到该元素伤害后，按每秒 decay 回落。满了即触发：
  //   冰 → 冻结 freeze 秒（精英 freezeElite 秒）；首领不会被冻结，改为 bossChill 秒的重度冰缓（移动与出手放慢 bossSlow）。
  //        异常值大于 0 时附带轻度冰缓，减速 = 异常值 × chill。冻结 / 重度冰缓期间不再累积冰霜异常值
  //   火 → 爆燃：以敌人为中心半径 blastR 的爆炸，伤害 = 灌满期间平均每击的火焰伤害 × (1 + 异常累积速度%) × blast，封顶为该敌人阈值 × blastCap；爆炸本身不累积异常值（不会连锁）
  //   雷 → 感电 shock 秒：期间它每受到一次命中，就射出 shockN 道电弧，射向 shockR 以内最近的其他敌人（附近一个都没有时，只有一道打回它自己），
  //        每道 = 这一击的 bolt 倍；电弧不再触发电弧、不累积异常值，同一个敌人每 shockGap 秒最多放一次。感电期间不再累积闪电异常值
  G.BUILDUP = {
    th: 0.5, elite: 1.5, boss: 0.15, bossGrow: 0.5, bossGrowMax: 4,
    hold: 3, decay: 0.5,
    chill: 0.3, freeze: 1.5, freezeElite: 1.0, bossChill: 3, bossSlow: 0.5,
    blastR: 3, blast: 1, blastCap: 0.5,
    shock: 4, shockR: 6, shockN: 2, bolt: 0.3, shockGap: 0.15,
  };
  G.ELEMS = ['fire', 'cold', 'light'];

  // ---------- 辅助宝石 ----------
  // req：技能需带有其中任一标签；no：带有其中任一标签的技能不能镶（可缺省）；eff：效果；cost：魔力消耗倍率。
  // 镶在召唤技能上时，通用辅助作用在召唤物身上：迅捷也加快召唤物出手，注入 / 蛮力 / 致命 / 震慑 / 蚀染作用于召唤物的每一击，
  // 扩域放大守像的砸地，节流照常减消耗和冷却；回响、汲生、投射物 / 连锁类镶不上
  G.SUPPORTS = {
    multi: { name: '多重投射', req: ['projectile'], cost: 1.3, eff: { proj: 2, more: -25 }, desc: '额外发射 2 个投射物，伤害减少 25%' },
    pierce: { name: '贯穿', req: ['projectile'], cost: 1.15, eff: { pierce: 3 }, desc: '投射物额外穿透 3 个敌人' },
    chain: { name: '连锁', req: ['projectile', 'chaining'], cost: 1.25, eff: { chain: 2, more: -15 }, desc: '额外连锁 2 次，伤害减少 15%' },
    expanse: { name: '扩域', req: ['area'], cost: 1.2, eff: { area: 40 }, desc: '技能范围扩大 40%' },
    haste: { name: '迅捷', req: null, cost: 1.25, eff: { speed: 25 }, desc: '攻击与施法速度加快 25%' },
    fire: { name: '灼炎注入', req: null, cost: 1.2, eff: { extra: { fire: 30 } }, desc: '获得相当于伤害 30% 的额外火焰伤害' },
    cold: { name: '寒霜注入', req: null, cost: 1.2, eff: { extra: { cold: 30 } }, desc: '获得相当于伤害 30% 的额外冰霜伤害' },
    light: { name: '雷霆注入', req: null, cost: 1.2, eff: { extra: { light: 30 } }, desc: '获得相当于伤害 30% 的额外闪电伤害' },
    brutal: { name: '蛮力', req: ['phys'], cost: 1.2, eff: { moreType: { phys: 35 } }, desc: '物理伤害额外提高 35%' },
    precise: { name: '致命', req: null, cost: 1.15, eff: { critFlat: 8, critMulti: 40 }, desc: '暴击率 +8%，暴击伤害 +40%' },
    leech: { name: '汲生', req: null, no: ['minion'], cost: 1.1, eff: { leech: 3 }, desc: '造成伤害的 3% 转化为生命' },
    echo: { name: '回响', req: ['spell'], no: ['summon', 'aura'], cost: 1.4, eff: { echo: 1, more: -30 }, desc: '法术自动重复施放一次，伤害减少 30%' },
    stagger: { name: '震慑', req: ['attack', 'minion'], cost: 1.15, eff: { stun: 0.7 }, desc: '击中时使非首领敌人眩晕 0.7 秒' },
    ailment: { name: '蚀染', req: null, cost: 1.1, eff: { ailment: 35 }, desc: '元素异常值的累积速度加快 35%（更快触发爆燃、冻结、感电）' },
    frugal: { name: '节流', req: null, cost: 0.6, eff: { cdr: 25 }, desc: '魔力消耗减少 40%（光环的魔力保留同样减少 40%），冷却时间缩短 25%' },
    // 召唤物专用
    dominion: { name: '驭灵', req: ['minion'], cost: 1.25, eff: { minionMore: 30 }, desc: '召唤物造成的伤害额外提高 30%' },
    ossify: { name: '坚骨', req: ['minion'], cost: 1.15, eff: { minionLife: 40, minionDR: 15 }, desc: '召唤物最大生命提高 40%，受到的伤害减少 15%' },
    horde: { name: '群聚', req: ['minion'], no: ['area'], cost: 1.3, eff: { minionCap: 1, minionMore: -15 }, desc: '烬骸仆从数量上限 +1，召唤物造成的伤害额外降低 15%' },
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
    resFire: '+{v}% 火焰抗性', resCold: '+{v}% 冰霜抗性', resLight: '+{v}% 闪电抗性',
    speed: '攻击与施法速度提高 {v}%', crit: '暴击率提高 {v}%', critMulti: '+{v}% 暴击伤害',
    lifeRegen: '每秒回复 {v} 生命', manaRegen: '魔力回复速度提高 {v}%', lifeOnKill: '击杀回复 {v} 生命',
    moveSpeed: '移动速度提高 {v}%', rarity: '掉落物品稀有度提高 {v}%',
    area: '技能范围扩大 {v}%', ailment: '元素异常值累积速度加快 {v}%', costReduce: '技能消耗降低 {v}%',
    dodgeCd: '翻滚冷却缩短 {v}%', moreDmg: '总伤害额外 {s}{v}%', lessTaken: '受到的伤害减少 {v}%',
    moreLife: '最大生命额外 {s}{v}%', bloodMagic: '技能消耗生命而非魔力，光环改为保留生命',
    minionDmg: '召唤物伤害提高 {v}%', minionLife: '召唤物最大生命提高 {v}%',
    minionSpeed: '召唤物攻击与移动速度提高 {v}%', minionCap: '烬骸仆从数量上限 +{v}',
    minionMore: '召唤物总伤害额外 {s}{v}%', ownLess: '你自身（非召唤物）的总伤害额外 -{v}%',
    poiseDmg: '架势削减提高 {v}%', pierce: '投射物额外穿透 {v} 个敌人',
    moreElem: '元素伤害总额外 {s}{v}%', moreTaken: '受到的伤害增加 {v}%',
    // 在 75% 上限之后才扣：溢出的抗性抵消不了（基石「元素过载」的代价）
    resLoss: '各项元素抗性 -{v}%（在 75% 上限之后扣除）',
    // 召唤物继承你的装备（见 game.js 的 G.minionInherit）
    mWeapon: '召唤物每一击附加相当于你武器伤害 {v}% 的物理伤害（按武器物品等级折算）', mDef: '召唤物获得你 {v}% 的护甲与抗性（按装备物品等级折算）',
    mLife: '召唤物获得你装备上最大生命总和 {v}% 的额外生命（按装备物品等级折算）',
    // 武器的本地词缀：只改这把武器自己的伤害（不进角色属性汇总），已经算在物品的 dmg 里
    wInc: '武器物理伤害提高 {v}%', wAdd: '附加 {a}–{b} 物理伤害',
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
      { names: ['榆木长弓', '筋角长弓', '渊鸣长弓'], type: 'bow', wskill: 'arrowrain', dmg: [8, 15], aps: 1.0, hands: 2, imp: { stat: 'pierce', lo: 1, hi: 1, fixed: true, step: 12 } },
      { names: ['直刃太刀', '霜纹太刀', '烬月太刀'], type: 'katana', wskill: 'flashcut', dmg: [8, 14], aps: 1.05, hands: 2, imp: { stat: 'critMulti', lo: 12, hi: 20 } },
      // 魂幡：召唤师的武器，武器伤害很低；隐含属性带一点召唤物生命（also：数值 = 主隐含 × k，取整）
      // soul：召唤物继承武器伤害时按这么多倍计（魂幡的武器伤害只有刃的四成多，乘上之后和刃相当，召唤师拿魂幡不吃亏）
      { names: ['骨铃魂幡', '残旌魂幡', '渊引魂幡'], type: 'banner', wskill: 'soultide', dmg: [3, 6], aps: 0.9, hands: 2, caster: true, drop: 0.8, soul: 2.2, imp: { stat: 'minionDmg', lo: 10, hi: 16, also: { stat: 'minionLife', k: 0.5 } } },
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
    // 召唤物词缀。baseW：按基底（BASES 里的下标）调整出现权重——杖类武器（木杖 / 骨杖）更容易出召唤物伤害；
    // minIlvl / rareOnly：只在物品等级够高的稀有物品上出现
    Object.assign(A('minionDmg', 'prefix', '统御', 'minionDmg', 6, 10, 1.35, ['weapon'].concat(JEW), 5), { baseW: { weapon: [0.4, 1.8, 1.8, 0.4, 0.4, 0.4, 0.4, 2.6] } }),
    // 武器本地词缀（local）：改的是这把武器自己的伤害，施法武器（杖类、魂幡）很少出
    Object.assign(A('wInc', 'prefix', '淬锋', 'wInc', 8, 13, 1.25, ['weapon'], 7), { local: true, baseW: { weapon: [1, 0.3, 0.3, 1, 1, 1, 1, 0.2] } }),
    Object.assign(A('wAdd', 'prefix', '重锻', 'wAdd', 2, 3, 1.33, ['weapon'], 6), { local: true, baseW: { weapon: [1, 0.3, 0.3, 1, 1, 1, 1, 0.2] } }),
    A('minionLife', 'prefix', '骸固', 'minionLife', 8, 13, 1.3, ['helm', 'body', 'belt'], 5),
    Object.assign(A('minionCap', 'suffix', '万骸', 'minionCap', 1, 1, 1, ['amulet'], 2), { minIlvl: 18, rareOnly: true }),
    // 只出现在烬铸武器上的词缀行（slots 为空、权重 0：随机掉落和打造都不会出）
    A('uIncElem', 'prefix', '三相', 'incElem', 8, 13, 1.35, [], 0),
    A('uAilment', 'suffix', '蚀相', 'ailment', 8, 13, 1.3, [], 0),
  ];
  G.AFFIX_BY_ID = {};
  for (const a of G.AFFIXES) G.AFFIX_BY_ID[a.id] = a;
  for (const id of ['moveSpeed', 'resFire', 'resCold', 'resLight', 'speed', 'crit', 'critMulti', 'manaRegen', 'rarity', 'uAilment']) G.AFFIX_BY_ID[id].soft = true;

  // ---------- 烬铸武器（稀有度 3）----------
  // 名字、武器类型和词缀行都是固定的，只有数值在区间里掷。区间跟着物品等级走：每一行取这条词缀在该物品等级最高阶的区间，
  // 下限 × k[0]、上限 × k[1]（fixed 的行是固定值，不进完美度）。基础伤害按普通武器的公式在掉落的物品等级上算，成色固定取 BASE_Q
  // （普通武器 0.9–1.1 的上沿），所以层级越高掉的同一把越强。裸属性大致相当于同物品等级最好的稀有武器，强在机制上。
  // boss：只由这个首领掉（层级 1 起）；mech：机制（game.js 里按 P.uMech 判断）
  G.UNIQUE_BASE_Q = 1.1;
  G.UNIQUES = {
    jinduan: {
      name: '烬断', base: 6, boss: 'warden', mech: 'blade', mechName: '残刃',
      lines: [{ id: 'wInc', k: [1.7, 2.3] }, { id: 'crit', k: [1.6, 2.2] }, { id: 'critMulti', k: [1.1, 1.5] }, { id: 'speed', k: [0.9, 1.3] }],
      lore: '雷霆监察者的刑刀断在烬渊里，断口至今还在发烫。',
    },
    sanxiang: {
      name: '三相之心', base: 1, boss: 'weaver', mech: 'tri', mechName: '三相共鸣',
      lines: [{ id: 'uIncElem', k: [1.15, 1.65] }, { id: 'uAilment', k: [1.0, 1.5] }, { id: 'speed', k: [1.0, 1.4] }, { id: 'addLight', k: [0.95, 1.35] }],
      lore: '霜织者把三种元素织进同一颗心里，它们至今仍在互相拉扯。',
    },
    wanhun: {
      name: '万魂旗', base: 7, boss: 'lord', mech: 'soul', mechName: '魂火轮回',
      lines: [{ id: 'minionDmg', k: [0.1, 0.2] }, { id: 'minionLife', k: [0.3, 0.6] }, { id: 'minionCap', fixed: 1 }, { id: 'wInc', k: [2.0, 2.8] }],
      lore: '烬渊之主麾下的亡魂都系在这面旗上，倒下一个，就烧起一团。',
    },
  };
  G.UNIQUE_IDS = Object.keys(G.UNIQUES);
  G.UNIQUE_BY_BOSS = {};
  for (const id of G.UNIQUE_IDS) G.UNIQUE_BY_BOSS[G.UNIQUES[id].boss] = id;
  // 掉率：层级 1 为 chance[1]（15%），层级 2 起 chance[2]（25%）；首领连续 pity（2）次没掉它的武器，下一次必掉
  // （最晚第 3 次击杀，掉了就清零）。熔渣巨像不掉：它是第一个区域的首领、打得最快，四个首领分三把武器，留给后三个
  G.UNIQUE_DROP = { chance: [0, 0.15, 0.25], pity: 2 };
  G.uniqueChance = (tier) => (tier >= 2 ? G.UNIQUE_DROP.chance[2] : tier >= 1 ? G.UNIQUE_DROP.chance[1] : 0);
  // 机制数值（平衡机器人量过：对位构筑比同物品等级「6 条最高阶词缀取中值」的顶级稀有快约两到三成）：
  // 残刃：max 层引爆，mult 倍武器伤害（必定暴击），波及 r 米内别的敌人 splash 倍；带残刃的敌人倒下，残刃飞到 jump 米内最近的敌人身上；
  //   瞬断冷却 × cdK
  // 三相共鸣：半径 r、另外两种元素各灌 k 条；refresh：已感电 / 冰缓的续满时间；heat：没攒过火焰伤害的敌人被灌爆时按源头的火焰伤害爆燃；
  //   grow：拿着它时首领因正常触发而变高的阈值 × grow（0 = 不变高）
  // 魂火轮回：魂火 k 倍最大生命、半径 r；继承武器伤害的比例最多 × inherit（gated：提高的部分按武器物品等级的继承折算走）；
  //   free：自动召唤不耗魔力
  G.MARK = { max: 5, mult: 11, cdK: 0.5, r: 2.5, splash: 0.3, jump: 5 };
  G.TRI = { r: 5, k: 0.75, refresh: true, heat: true, grow: 0 };
  G.SOULFIRE = { k: 0.15, r: 3, inherit: 1.5, gated: true, free: true };
  // 机制说明按上面的数值写（改数值时说明跟着变）
  const pc = (x) => Math.round(x * 100) + '%';
  G.UNIQUES.jinduan.mechDesc = '每次暴击在目标身上留下一道残刃；叠满 ' + G.MARK.max + ' 道一齐引爆，造成 ' + pc(G.MARK.mult) + ' 武器伤害的物理伤害（必定暴击），周围 ' + G.MARK.r + ' 米内的其他敌人受到其中 ' + pc(G.MARK.splash) +
    '。带着残刃的敌人倒下时，残刃飞到 ' + G.MARK.jump + ' 米内最近的敌人身上。瞬断的冷却时间减半。';
  G.UNIQUES.sanxiang.mechDesc = '任何敌人触发冻结、爆燃或感电时，' + G.TRI.r + ' 米内的敌人（含它自己）获得另外两种元素各 ' + pc(G.TRI.k) + ' 条异常值；已在感电或冰缓中的改为续满时间，被灌爆的爆燃沿用源头的火焰伤害。共鸣灌满的异常不再引发共鸣。' +
    (G.TRI.grow < 1 ? '首领不会因为异常越打越难触发。' : '');
  G.UNIQUES.wanhun.mechDesc = '召唤物倒下时化作魂火炸开，对周围 ' + G.SOULFIRE.r + ' 米内的敌人造成它最大生命 ' + pc(G.SOULFIRE.k) + ' 的火焰伤害。自动召唤不消耗魔力。召唤物继承武器伤害的比例' +
    (G.SOULFIRE.gated ? '最多' : '') + '提高 ' + pc(G.SOULFIRE.inherit - 1) + (G.SOULFIRE.gated ? '（和继承一样按武器物品等级折算）' : '') + '。';
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
  ];
  // 每个轮回层级提高的怪物等级。四个区域是 1 / 5 / 9 / 13，每区 +4；
  // 取 16 让下一层从 17 接着往上走，不会比上一层的末区（13，首领 16）倒退
  G.TIER_LEVELS = 16;

  // ---------- 怪物 ----------
  G.MOBS = {
    // mass：体重，击退距离按它折算；poise：做成精英时的架势上限（普通小怪没有架势条）；
    // sturdy：皮糙肉厚，重击也打断不了它的起手（只能躲）
    husk: { name: '游魂', hp: 30, dmg: 7, speed: 5.0, r: 0.55, range: 1.7, windup: 0.35, cd: 1.1, xp: 1, ai: 'melee', mass: 1, poise: 100 },
    brute: { name: '巨躯', hp: 100, dmg: 17, speed: 3.1, r: 0.95, range: 2.6, windup: 0.85, cd: 2.2, xp: 2.6, ai: 'slam', mass: 2.2, poise: 140, sturdy: true },
    spitter: { name: '喷吐者', hp: 24, dmg: 9, speed: 4.2, r: 0.55, range: 13, windup: 0.45, cd: 2.2, xp: 1.3, ai: 'ranged', mass: 0.9, poise: 90 },
    bomber: { name: '爆裂虫', hp: 15, dmg: 20, speed: 7.2, r: 0.5, range: 2.2, windup: 0.7, cd: 9, xp: 0.9, ai: 'bomb', mass: 0.8, poise: 80 },
  };
  // 首领生命比 v1 高约 12%：补偿破绽易伤与处决，战斗时长大致不变
  G.BOSSES = {
    golem: { name: '熔渣巨像', hp: 695, dmg: 16.5, speed: 3.4, r: 1.9, poise: 500, patterns: ['slam', 'charge', 'ring'] },
    weaver: { name: '霜织者', hp: 785, dmg: 15.4, speed: 3.8, r: 1.5, poise: 450, patterns: ['fan', 'barrage', 'summon', 'ring'] },
    warden: { name: '雷霆监察者', hp: 875, dmg: 15.4, speed: 4.0, r: 1.7, poise: 480, patterns: ['cross', 'barrage', 'charge', 'ring'] },
    lord: { name: '烬渊之主', hp: 1175, dmg: 15, speed: 4.0, r: 1.9, poise: 550, patterns: ['slam', 'fan', 'spiral', 'cross', 'barrage', 'summon'] },
  };
  // 怪物成长：MOB_KNEE（16，层级 0 的最高怪物等级）以内是原来的 1.2 / 1.15 倍每级，一位不差；
  // 再往上按 MOB_HP_LATE / MOB_DMG_LATE 每级成长——对上轮回层级里角色的实际成长（宝石 / 武器 / 词缀阶 / 生命都不再封顶，
  // 经验曲线也让角色等级跟着怪物等级走），用平衡机器人在层级 1、2 的中段和末区量出来：
  // 比层级 0 末区难一截但打得过，层级 2 再难一些。
  // 生命和伤害都分两段：层级 1（17–32 级）每级 MOB_HP_LATE / MOB_DMG_LATE，层级 2 起（33 级以上）每级 MOB_HP_LATE2 / MOB_DMG_LATE2。
  // 生命：层级 1 里角色的词缀阶只从 5 阶涨到 7 阶，层级 2 一口气涨到 8–10 阶，怪物生命跟着这个节奏走（层级 2 的首领用时明显长过层级 1）。
  // 伤害：层级 1 每级 1.10，期望等级（35 级左右）打层级 1 末区时每秒受到的伤害（按生命算）和层级 0 末区相当；
  // 层级 2 角色生命、护甲的成长放缓，伤害每级只再涨 1.055，每秒受到的伤害仍是层级 1 的 1.5 倍以上
  G.MOB_KNEE = 16;
  G.MOB_KNEE2 = 32;
  G.MOB_HP_LATE = 1.09;
  G.MOB_HP_LATE2 = 1.13;
  G.MOB_DMG_LATE = 1.1;
  G.MOB_DMG_LATE2 = 1.055;
  const late = (l, k1, k2) => Math.pow(k1, Math.min(l, G.MOB_KNEE2) - G.MOB_KNEE) * Math.pow(k2, Math.max(0, l - G.MOB_KNEE2));
  G.hpScale = (l) => (l <= G.MOB_KNEE ? Math.pow(1.2, l - 1) : Math.pow(1.2, G.MOB_KNEE - 1) * late(l, G.MOB_HP_LATE, G.MOB_HP_LATE2));
  G.dmgScale = (l) => (l <= G.MOB_KNEE ? Math.pow(1.15, l - 1) : Math.pow(1.15, G.MOB_KNEE - 1) * late(l, G.MOB_DMG_LATE, G.MOB_DMG_LATE2));

  // ---------- 经验 ----------
  // 每只怪的经验按怪物等级指数成长（mobXp，1.17 倍 / 级）。升级所需经验在 XP_KNEE 级以内和改版前一样（多项式），
  // 再往上改为和 mobXp 同样按 1.17 倍 / 级增长——「每升一级要杀多少只同级怪」从此不变，角色等级就跟着怪物等级走，
  // 不会像改版前那样越往后升得越快（改版前轮回层级 1 打完是 42 级、怪物才 29–32 级）。
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
  G.LIFE_KNEE = 20; // 层级 0 打完大约 19–20 级：之前的生命 / 魔力曲线和改版前完全一样
  G.LIFE_LATE = 24;
  G.MANA_LATE = 4;
  G.baseLife = (l) => 100 + 12 * (l - 1) + G.LIFE_LATE * Math.max(0, l - G.LIFE_KNEE);
  G.baseMana = (l) => 60 + 6 * (l - 1) + G.MANA_LATE * Math.max(0, l - G.LIFE_KNEE);
})();
