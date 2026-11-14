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
    minion: '召唤物', summon: '召唤', aura: '光环',
  };

  // ---------- 主动技能 ----------
  // 每个技能的打击手感：w 分量（0 轻 / 1 重 / 2 终结），kb 击退距离（世界单位，按怪物体重折算），
  // poise 每次命中削掉的架势。近战削得最多，法术次之。
  G.SKILLS = {
    cleave: {
      name: '裂石击', icon: '斩', color: '#e6dfd0', tags: ['attack', 'melee', 'area', 'phys'], kind: 'melee',
      // time 是三段的平均段长（界面估算秒伤用），range / arc 是前两段的大致范围
      dmg: { phys: [10, 15] }, time: 0.45, mana: 0, cd: 0, range: 3.6, arc: 125,
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
      dmg: { phys: [8, 12] }, time: 0.36, mana: 4, cd: 0, speed: 28, pierce: 2, projR: 0.28, w: 0, kb: 0.35, poise: 8,
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
      dmg: { phys: [30, 42] }, time: 0.2, mana: 10, cd: 3.5, radius: 3.0, range: 10, w: 2, kb: 1.8, poise: 30, stop: 80,
      desc: '瞬移到鼠标位置，重重砸在落点，对周围的敌人造成大量伤害。冷却期间穿插主力技能。',
    },
    whirl: {
      name: '旋风斩', icon: '旋', color: '#e8c9a0', tags: ['attack', 'melee', 'area', 'phys'], kind: 'spin',
      // 持续施放：按住时原地旋转，每 time 秒（受出手速度影响）对身边一圈造成一次伤害、扣一次魔力。
      // radius 半径；move 旋转中的移动速度倍率；kb 击退（顺着旋转方向带一下，不把敌人推出圈外）；stop 每跳的顿帧毫秒数
      dmg: { phys: [6, 10] }, time: 0.3, mana: 2, cd: 0, radius: 3.0, move: 0.6, w: 0, kb: 0.18, poise: 6, stop: 12,
      desc: '按住持续旋转，不断斩击身边一圈的敌人，每一下都消耗少量魔力。转起来可以慢慢走动；松手、翻滚或施放别的技能就停下。',
    },
    shadestep: {
      name: '影步连斩', icon: '影', color: '#9fb4ff', tags: ['attack', 'melee', 'area', 'phys', 'movement'], kind: 'flicker',
      // 持续施放：按住时自动瞬移到身边 range 以内（走得过去的）敌人旁边斩一刀，再闪向下一个。
      // 每 time 秒一刀（受出手速度影响），每刀扣一次魔力；radius 是每一刀波及目标周围的半径（吃范围加成）；
      // lead 闪现到落地出刀之间的秒数（第一刀 / 之后每一刀），闪现期间无敌，出刀那一刻不无敌；stop 每刀的顿帧毫秒数
      dmg: { phys: [5, 7] }, time: 0.18, mana: 2, cd: 0, range: 8, radius: 1.6, lead: [0.08, 0.1], move: 0, w: 0, kb: 0.25, poise: 9, stop: 25,
      desc: '按住后自动闪到附近的敌人身边斩击，再闪向下一个，不用瞄准。优先砍准星附近和这一轮还没砍过的敌人，每一刀也波及目标身边的敌人，消耗少量魔力。闪现的瞬间无敌，落地出刀时没有；选中露出破绽的敌人直接处决。松手、翻滚、施放别的技能或附近没有敌人时停下。',
    },
    // 召唤：在准星处（最远 range，落在可走的地面上）唤起召唤物。召唤物不吃玩家自己的伤害属性，
    // 只按宝石等级、「召唤物」类属性（minionDmg / minionLife / minionSpeed / minionCap）和镶在这个技能上的辅助宝石成长。
    // dmg：召唤物每一击的基础伤害；life：基础生命；rate：两次出手的间隔（秒）；cap：数量上限；
    // reach：近战够得着的距离（到目标边缘）；cleave / arc：仆从横斩额外带到的敌人数与扇面角度；move：移动速度；dr：自带的伤害减免（%）；kb / poise / w：每一击的击退、削架势、分量
    thrall: {
      name: '烬骸仆从', icon: '骸', color: '#4fe3c8', tags: ['spell', 'minion', 'summon', 'phys'], kind: 'summon', minion: 'thrall',
      dmg: { phys: [11, 15] }, time: 0.6, mana: 12, cd: 0, range: 6,
      cap: 3, life: 54, rate: 0.8, reach: 0.9, move: 7.4, dr: 0, w: 0, kb: 0.1, poise: 3,
      cleave: 4, arc: 160, // 横斩：身前 160° 扇面里贴着的敌人再带到至多 4 个
      hold: 2, // 同时最多牵制 2 只小怪（守像 4 只）；被围满后其余的怪会去找玩家
      desc: '在准星处唤起一具烬骸仆从：迅捷的骸骨剑士，自动寻找敌人厮杀，横斩会带到身前贴着的敌人，优先攻击你最近打中的目标。基础上限 3 具，数量已满时替换受伤最重的那具。',
    },
    colossus: {
      name: '石誓守像', icon: '像', color: '#c9a86a', tags: ['spell', 'minion', 'summon', 'phys', 'area'], kind: 'summon', minion: 'colossus',
      dmg: { phys: [24, 36] }, time: 1.0, mana: 30, cd: 6, range: 6,
      cap: 1, life: 220, rate: 2.5, reach: 1.6, move: 4.4, dr: 25, w: 1, kb: 1.1, poise: 9,
      radius: 3.2, // 砸地半径（受扩域影响）
      hold: 4,
      taunt: { cd: 7, r: 6, dur: 3, boss: 0.8 }, // 嘲讽：冷却、半径、小怪被嘲讽的秒数、首领被嘲讽的秒数
      desc: '在准星处立起一尊石誓守像：缓慢而坚不可摧，每隔几秒双拳砸地伤害一圈敌人，并不时怒吼嘲讽，迫使周围的敌人转而攻击它。只能存在 1 尊，再次施放会在新位置重铸。',
    },
  };
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
  };
  G.fmtStat = function (stat, v) {
    const f = G.STAT_FMT[stat] || stat + ' {v}';
    const r = Math.round(v * 10) / 10;
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
  G.RARITY_NAME = ['普通', '魔法', '稀有'];
  G.RARITY_COLOR = ['#d6d1c4', '#7f9dff', '#ffd75e'];

  G.BASES = {
    weapon: [
      { names: ['铁刃', '战刃', '烬钢刃'], imp: { stat: 'incPhys', lo: 8, hi: 14 } },
      { names: ['木杖', '符文杖', '渊晶杖'], imp: { stat: 'incElem', lo: 8, hi: 14 } },
      { names: ['骨杖', '灵枝', '雷纹短杖'], imp: { stat: 'speed', lo: 4, hi: 7 } },
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

  // 词缀：tiers 由 lo/hi 按 g 的幂次增长；TIER_ILVL 是各阶所需物品等级
  G.TIER_ILVL = [1, 5, 9, 13, 18, 24];
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
    A('addPhys', 'prefix', '裂伤', 'addPhys', 2, 3, 1.5, ['weapon', 'gloves'].concat(JEW), 5),
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
    Object.assign(A('minionDmg', 'prefix', '统御', 'minionDmg', 6, 10, 1.35, ['weapon'].concat(JEW), 5), { baseW: { weapon: [0.4, 1.8, 1.8] } }),
    A('minionLife', 'prefix', '骸固', 'minionLife', 8, 13, 1.3, ['helm', 'body', 'belt'], 5),
    Object.assign(A('minionCap', 'suffix', '万骸', 'minionCap', 1, 1, 1, ['amulet'], 2), { minIlvl: 18, rareOnly: true }),
  ];
  G.AFFIX_BY_ID = {};
  for (const a of G.AFFIXES) G.AFFIX_BY_ID[a.id] = a;

  G.RARE_A = ['灰烬', '霜骨', '雷鸣', '渊影', '残月', '裂魂', '荆棘', '苍白', '余烬', '暮光', '锈蚀', '血誓'];
  G.RARE_B = ['之握', '之誓', '之眼', '壁垒', '挽歌', '獠牙', '回响', '枷锁', '之冠', '低语', '印记', '之怒'];

  // ---------- 通货 ----------
  G.CURRENCY = {
    dust: { name: '微光尘', color: '#9fb4ff', w: 34, desc: '把普通物品升为魔法物品，带 1 条词缀' },
    augment: { name: '增幅尘', color: '#7fe0c0', w: 22, desc: '给只有 1 条词缀的魔法物品追加 1 条词缀' },
    alch: { name: '点金石', color: '#ffd75e', w: 10, desc: '把普通物品升为稀有物品，带 4 条词缀' },
    regal: { name: '冠冕石', color: '#ffb46a', w: 12, desc: '把魔法物品升为稀有物品，并追加 1 条词缀' },
    exalt: { name: '升华石', color: '#f2e6b0', w: 9, desc: '给稀有物品追加 1 条词缀（最多 6 条）' },
    chaos: { name: '乱流石', color: '#d98cff', w: 9, desc: '移除稀有物品的 1 条随机词缀，再追加 1 条新词缀' },
    divine: { name: '重铸石', color: '#ff8fa8', w: 4, desc: '重新随机物品所有词缀的数值' },
  };
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
  G.hpScale = (l) => Math.pow(1.2, l - 1);
  G.dmgScale = (l) => Math.pow(1.15, l - 1);
  G.xpNeed = (l) => Math.round(40 + 30 * Math.pow(l, 1.5));
  G.mobXp = (l) => 10 * Math.pow(1.17, l - 1);
})();
