'use strict';
// 召唤物：烬骸仆从（快速近战，最多 3 具起）与石誓守像（缓慢、坚固、砸地 + 嘲讽，只有 1 尊）。
// 全自动：跟随玩家、自己挑目标，优先打玩家最近亲手打中的敌人（集火目标）；敌人也会转头打它们。
// 召唤物不进存档：读档后需要重新召唤（开着自动召唤的技能会自己补上，见 game.js 的 updateAutoSummon）。数值来自 G.skillCtx(技能).minion（宝石等级、召唤物属性、镶在技能上的辅助）
(function () {
  const G = window.G;
  const TAU = Math.PI * 2;
  const S = G.state;
  const P = G.player;

  const ALLY_HEX = (G.ALLY_HEX = 0x4fe3c8); // 友方召唤物统一的魂火青（与 world 的血条 / 地面圈、界面的 --ally 同色）
  const LEASH = 20; // 离玩家超过这么远：直接回到玩家身边重新现身
  const ENGAGE = 11; // 离玩家或离自己这么近的敌人才会被盯上（太近了召唤物会干站着等怪走过来，清图慢）
  const CHASE_MAX = 14; // 不追离玩家超过这么远的敌人
  const SEEK_GAP = 0.25; // 多久重新挑一次目标
  const REFRESH_GAP = 0.5; // 多久按当前属性 / 辅助刷新一次数值（生命上限、伤害、攻速）
  const STUCK_T = 1.5; // 想走却走不动这么久：跟随时直接回到玩家身边，追击时放弃这个目标
  const PLAYER_R = 0.5;

  // 各类召唤物的体型与动作节奏（秒，按 1 倍攻速）
  const KIND = {
    thrall: { r: 0.5, height: 2.0, rise: 0.7, atkDur: 0.5, atkHit: 0.22, name: '烬骸仆从', fallback: 'husk' },
    colossus: { r: 0.95, height: 3.0, rise: 1.0, atkDur: 1.0, atkHit: 0.55, tauntDur: 0.8, tauntHit: 0.35, name: '石誓守像', fallback: 'brute' },
  };

  const list = S.minions;
  let markShown = null; // 当前头顶有集火标记的敌人
  let refreshT = 0;
  // 狂热（魂潮）：剩余秒数与攻击 / 移动速度的加成比例。期间出手间隔、攻击动作与移动都快 (1 + frenzyK) 倍
  let frenzyT = 0;
  let frenzyK = 0;
  const frenzyMul = () => (frenzyT > 0 ? 1 + frenzyK : 1);

  const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
  function turn(m, target, rate, dt) {
    let d = (target - m.ang) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    const k = rate * dt;
    m.ang += Math.abs(d) <= k ? d : Math.sign(d) * k;
  }

  // ---------- 模型（world 的召唤物骨架还没好时，先借小怪的骨架染成青色） ----------
  function makeEnt(kind) {
    const W = G.world;
    if (typeof W.makeMinion === 'function') return W.makeMinion(kind, ALLY_HEX);
    return W.makeMob(KIND[kind].fallback, ALLY_HEX, false);
  }
  function riseFx(x, z, big) {
    const W = G.world;
    if (typeof W.summonFx === 'function') W.summonFx(x, z, !!big);
    else {
      W.ring(x, z, big ? 2.4 : 1.4, ALLY_HEX, 0.5);
      W.burst(x, 0.4, z, ALLY_HEX, big ? 26 : 14, big ? 5 : 3.5, 0.6);
    }
  }
  function startRise(m) {
    const k = KIND[m.kind];
    m.rising = m.riseMax = k.rise;
    m.state = 'idle';
    m.stateT = 0;
    m.strikeT = -1;
    m.target = null;
    m.moving = false;
    m.stuckT = 0;
    m.riseClip = G.world.play(m.ent, 'rise', { dur: k.rise });
    if (!m.riseClip) G.world.setEntScale(m.ent, 0.25); // 没有破土动作：从地里长出来
    G.world.setEnt(m.ent, m.x, m.z, m.ang);
    riseFx(m.x, m.z, m.kind === 'colossus');
  }

  // ---------- 落点 ----------
  const _spot = { x: 0, z: 0 };
  // 从玩家朝 (tx, tz) 方向、最远 range 处找一个可走的位置；整条线都不行就在玩家身边找
  function spotToward(tx, tz, range, pad) {
    const W = G.world;
    let dx = tx - P.x, dz = tz - P.z, d = Math.hypot(dx, dz);
    if (d > 1e-3) {
      dx /= d;
      dz /= d;
    } else {
      dx = Math.sin(P.face);
      dz = Math.cos(P.face);
      d = 1.5;
    }
    d = Math.min(d, range);
    while (d > 0.8) {
      const x = P.x + dx * d, z = P.z + dz * d;
      if (W.walkable(x, z, pad)) {
        _spot.x = x;
        _spot.z = z;
        return _spot;
      }
      d -= 0.4;
    }
    return spotNear(1.6, pad, Math.atan2(dx, dz));
  }
  // 玩家身边半径约 r 的一圈里找一个可走的位置（从 a0 方向开始转圈试）
  function spotNear(r, pad, a0) {
    const W = G.world;
    for (let ring = 0; ring < 3; ring++) {
      const rr = r * (1 - ring * 0.3);
      for (let i = 0; i < 10; i++) {
        const a = a0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.63;
        const x = P.x + Math.sin(a) * rr, z = P.z + Math.cos(a) * rr;
        if (W.walkable(x, z, pad)) {
          _spot.x = x;
          _spot.z = z;
          return _spot;
        }
      }
    }
    _spot.x = P.x;
    _spot.z = P.z;
    return _spot;
  }

  // ---------- 召唤 / 解散 ----------
  function aliveOf(skill) {
    let n = 0;
    for (let i = 0; i < list.length; i++) if (!list[i].dead && list[i].skill === skill) n++;
    return n;
  }
  G.minionCount = aliveOf; // 某个召唤技能现存的召唤物数量（自动召唤据此判断要不要补）
  // 受伤最重（生命比例最低）的那只；一样时取最早召唤的
  function weakestOf(skill) {
    let best = null;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.dead || m.skill !== skill) continue;
      const f = m.hp / m.maxHp;
      if (!best || f < best.hp / best.maxHp - 1e-6 || (Math.abs(f - best.hp / best.maxHp) <= 1e-6 && m.born < best.born)) best = m;
    }
    return best;
  }
  // 从列表里拿掉一只召唤物。ang / type：倒下的方向与死法；quiet：不演倒地（换区域、删档时直接消失）
  function removeMinion(m, ang, type, quiet) {
    const W = G.world;
    if (m.dead) return;
    m.dead = true;
    m.hp = 0;
    m.target = null;
    if (!quiet) {
      // 物理致死不传 type：骸骨 / 石像化作一圈魂火青的消散，不留灰土；元素致死照常带上元素的死法
      W.die(m.ent, { ang: ang === undefined ? m.ang + Math.PI : ang, type: type && type !== 'phys' ? type : undefined, force: m.kind === 'colossus' ? 0 : 3, color: ALLY_HEX });
      W.burst(m.x, m.height * 0.5, m.z, ALLY_HEX, m.kind === 'colossus' ? 22 : 10, 3.5, 0.5);
    }
    W.removeEnt(m.ent);
    const i = list.indexOf(m);
    if (i >= 0) list.splice(i, 1);
  }

  // 召唤一只（由技能的施放调用）：落点限制在 range 以内的可走地面；数量已满时先替换受伤最重的那只
  G.summonMinion = function (skillId, tx, tz, ctxIn) {
    const sk = G.SKILLS[skillId];
    if (!sk || sk.kind !== 'summon' || !S.zone) return null;
    const ctx = ctxIn && ctxIn.minion ? ctxIn : G.skillCtx(skillId);
    const mi = ctx.minion;
    const kind = mi.kind;
    const K = KIND[kind];
    const at = spotToward(tx, tz, sk.range || 6, K.r + 0.1);
    const x = at.x, z = at.z;
    let guard = 0;
    while (aliveOf(skillId) >= mi.cap && guard++ < 20) {
      const w = weakestOf(skillId);
      if (!w) break;
      removeMinion(w);
    }
    const m = {
      kind, skill: skillId, name: K.name, ent: makeEnt(kind),
      x, z, ang: Math.atan2(x - P.x, z - P.z), r: K.r, height: K.height,
      hp: mi.life, maxHp: mi.life, dr: mi.dr, dead: false,
      target: null, atkT: 0.25, tauntCd: mi.taunt ? 1.5 : 0, tauntCdMax: mi.taunt ? mi.taunt.cd : 0,
      state: 'idle', stateT: 0, strikeT: -1, rising: 0, riseMax: K.rise, riseClip: true,
      moving: false, stuckT: 0, seekT: 0, hurtT: 0, volley: null, ignore: null, ignoreT: 0,
      navT: 0, navWp: false, navX: 0, navZ: 0, navTx: 0, navTz: 0,
      spX: 0, spZ: 0, spBest: Infinity, spT: 0,
      born: S.time, ctx,
    };
    list.push(m);
    startRise(m);
    G.sfx('cast');
    return m;
  };

  // 散掉所有召唤物（删档 / 换存档时）
  G.clearMinions = function () {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      m.dead = true;
      m.target = null;
      if (G.world && m.ent) G.world.removeEnt(m.ent);
    }
    list.length = 0;
    S.focus = null;
    S.focusT = 0;
    frenzyT = 0;
    setMark(null);
  };

  // 让所有召唤物狂热 dur 秒，攻击与移动速度 ×(1 + k)（重复施放刷新时长，取较高的加成）。返回受影响的召唤物数量。
  // 每只召唤物身上的特效走 world.frenzyFx(ent, dur)（可选）
  G.minionFrenzy = function (dur, k) {
    frenzyK = frenzyT > 0 ? Math.max(frenzyK, k) : k;
    frenzyT = Math.max(frenzyT, dur);
    let n = 0;
    for (const m of list) {
      if (m.dead) continue;
      n++;
      if (G.world && typeof G.world.frenzyFx === 'function') G.world.frenzyFx(m.ent, dur);
      else if (G.world) G.world.burst(m.x, m.height * 0.6, m.z, ALLY_HEX, 10, 3, 0.4);
    }
    return n;
  };
  // 狂热剩余秒数与当前倍率（界面 / 测试用）
  G.minionFrenzyState = () => ({ t: frenzyT, mult: frenzyMul() });

  // 全部回到玩家身边重新现身（换区域、重生、离得太远）
  function regroup(m, i, n) {
    const p = spotNear(m.kind === 'colossus' ? 3 : 2.2, m.r + 0.1, P.face + Math.PI + (n > 1 ? (i - (n - 1) / 2) * 0.8 : 0));
    m.x = p.x;
    m.z = p.z;
    m.ang = P.face;
    startRise(m);
  }
  G.regroupMinions = function () {
    for (let i = 0; i < list.length; i++) regroup(list[i], i, list.length);
    S.focus = null;
    S.focusT = 0;
    setMark(null);
  };

  // 召唤物受到伤害（敌人近战、预警圈、弹丸都走这里）。src：伤害来源 { x, z }
  G.hurtMinion = function (m, amount, dtype, src) {
    if (!m || m.dead || !(amount > 0)) return false;
    const W = G.world;
    const dmg = Math.max(1, amount * (1 - (m.dr || 0) / 100));
    m.hp -= dmg;
    m.hurtT = 0.35;
    const ang = src && dist(src.x, src.z, m.x, m.z) > 0.05 ? Math.atan2(m.x - src.x, m.z - src.z) : m.ang + Math.PI;
    W.flash(m.ent, 0.8);
    W.hitReact(m.ent, ang, m.kind === 'colossus' ? 0.5 : 0.9);
    if (m.hp <= 0) removeMinion(m, ang, G.TYPE_NAME[dtype] ? dtype : 'phys');
    return true;
  };

  // ---------- 集火目标 ----------
  G.focusTarget = function () {
    const e = S.focus;
    if (!e || e.dead || !(S.focusT > 0)) return null;
    return e;
  };
  function setMark(e) {
    if (markShown === e) return;
    markShown = e;
    const W = G.world;
    if (W && typeof W.focusMark === 'function') W.focusMark(e ? e.ent : null);
  }

  // ---------- 技能卡用的数值 ----------
  const typeMult = (ctx, t) => Math.max(0, 1 + (ctx.inc[t] || 0) / 100) * (ctx.moreType[t] === undefined ? 1 : ctx.moreType[t]);
  // { count 现有数量, cap 上限, dmgMin / dmgMax 每一击（不算暴击）, avg 平均每一击（含暴击）, life 生命上限,
  //   rate 每秒出手次数, interval 出手间隔秒数, dps 满编时的秒伤, move 移动速度, dr 伤害减免 %,
  //   radius 砸地半径（守像）, taunt 嘲讽 { cd, r, dur }（守像）, kind }
  G.minionInfo = function (skillId) {
    const sk = G.SKILLS[skillId];
    if (!sk || sk.kind !== 'summon' || !G.save) return null;
    const ctx = G.skillCtx(skillId);
    const mi = ctx.minion;
    let lo = 0, hi = 0, extra = 0;
    for (const t in ctx.base) {
      lo += ctx.base[t][0] * typeMult(ctx, t);
      hi += ctx.base[t][1] * typeMult(ctx, t);
    }
    for (const t in ctx.extra) extra += ctx.extra[t];
    const k = (1 + extra / 100) * ctx.more;
    return {
      count: aliveOf(skillId), cap: mi.cap, dmgMin: lo * k, dmgMax: hi * k, avg: G.avgHit(ctx),
      life: mi.life, rate: 1 / mi.interval, interval: mi.interval, dps: G.skillDps(ctx),
      move: mi.move, dr: mi.dr, radius: mi.radius, kind: mi.kind,
      taunt: mi.taunt ? { cd: mi.taunt.cd, r: mi.taunt.r, dur: mi.taunt.dur } : null,
    };
  };

  // ---------- 数值刷新：属性 / 辅助变了以后，生命上限按比例跟着变；超出上限的解散 ----------
  function refreshAll() {
    const save = G.save;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!save.skills[m.skill]) {
        removeMinion(m);
        continue;
      }
      const ctx = G.skillCtx(m.skill);
      const mi = ctx.minion;
      m.ctx = ctx;
      m.dr = mi.dr;
      if (mi.life !== m.maxHp) {
        m.hp = Math.max(1, (m.hp / m.maxHp) * mi.life);
        m.maxHp = mi.life;
      }
      if (mi.taunt) m.tauntCdMax = mi.taunt.cd;
    }
    for (const id in G.SKILLS) {
      if (G.SKILLS[id].kind !== 'summon' || !aliveOf(id)) continue;
      const cap = G.skillCtx(id).minion.cap;
      let guard = 0;
      while (aliveOf(id) > cap && guard++ < 20) removeMinion(weakestOf(id));
    }
  }

  // ---------- 移动 ----------
  const SLIDE = [0.7, -0.7, 1.3, -1.3];
  function step(m, dx, dz, d) {
    const W = G.world, pad = m.r * 0.8;
    let nx = m.x + dx * d, nz = m.z + dz * d;
    if (W.walkable(nx, nz, pad)) {
      m.x = nx;
      m.z = nz;
      return true;
    }
    for (let i = 0; i < SLIDE.length; i++) {
      const c = Math.cos(SLIDE[i]), s = Math.sin(SLIDE[i]);
      nx = m.x + (dx * c + dz * s) * d;
      nz = m.z + (dz * c - dx * s) * d;
      if (W.walkable(nx, nz, pad)) {
        m.x = nx;
        m.z = nz;
        return true;
      }
    }
    return false;
  }
  // 朝 (tx, tz) 走到 stop 以内；在 stop + slack 以内就算到了（互相推挤会把召唤物往外挤一点）。返回是否已经到了
  // 隔着墙时沿通道走（G.navPoint 给路点，每 0.25 秒或目标挪远了重算一次）
  const _nav = { x: 0, z: 0 };
  function moveTo(m, tx, tz, speed, stop, dt, slack) {
    const d = Math.hypot(tx - m.x, tz - m.z);
    if (d <= stop + (slack || 0)) return true;
    m.navT -= dt;
    if (m.navT <= 0 || Math.abs(m.navTx - tx) + Math.abs(m.navTz - tz) > 1.5) {
      m.navT = 0.25;
      m.navTx = tx;
      m.navTz = tz;
      m.navWp = false;
      if (G.navPoint) {
        G.navPoint(m.x, m.z, tx, tz, m.r, _nav);
        m.navWp = _nav.x !== tx || _nav.z !== tz;
        m.navX = _nav.x;
        m.navZ = _nav.z;
      }
    }
    const gx = m.navWp ? m.navX : tx, gz = m.navWp ? m.navZ : tz;
    const dx = gx - m.x, dz = gz - m.z, dd = Math.hypot(dx, dz);
    if (dd < 1e-3) {
      m.navT = 0;
      return false;
    }
    turn(m, Math.atan2(dx, dz), 9, dt);
    const ok = step(m, dx / dd, dz / dd, Math.min(m.navWp ? dd : d - stop, speed * dt));
    m.moving = true;
    m.stuckT = ok ? Math.max(0, m.stuckT - dt) : m.stuckT + dt;
    return false;
  }
  // 互相推开：不和敌人、玩家、别的召唤物叠在一起（只推召唤物自己）
  function pushOff(m, ox, oz, min, k) {
    const dx = m.x - ox, dz = m.z - oz;
    if (Math.abs(dx) >= min || Math.abs(dz) >= min) return;
    const d = Math.hypot(dx, dz);
    if (d >= min || d < 1e-4) return;
    const nx = m.x + (dx / d) * (min - d) * k, nz = m.z + (dz / d) * (min - d) * k;
    if (G.world.walkable(nx, nz, m.r * 0.8)) {
      m.x = nx;
      m.z = nz;
    }
  }
  function separate(m, dt) {
    const k = Math.min(1, 10 * dt), es = S.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (!e.dead) pushOff(m, e.x, e.z, (m.r + e.r) * 0.92, k);
    }
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o !== m && !o.dead) pushOff(m, o.x, o.z, (m.r + o.r) * 0.9, k);
    }
    if (!P.dead) pushOff(m, P.x, P.z, m.r + PLAYER_R, k);
  }

  // ---------- 目标 ----------
  function inReach(m, e) {
    if (!e || e.dead) return false;
    const dp = dist(e.x, e.z, P.x, P.z) - e.r;
    if (dp > CHASE_MAX) return false;
    return dp <= ENGAGE || dist(e.x, e.z, m.x, m.z) - e.r <= ENGAGE;
  }
  function pickTarget(m) {
    const skip = m.ignoreT > 0 ? m.ignore : null; // 刚放弃的（够不着的）目标先不考虑
    const f = G.focusTarget();
    if (f && f !== skip && dist(f.x, f.z, P.x, P.z) - f.r <= CHASE_MAX) return f; // 集火目标：只要不太远就去打它
    if (m.target && m.target !== skip && inReach(m, m.target)) return m.target;
    let best = null, bd = Infinity;
    const es = S.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e === skip || !inReach(m, e)) continue;
      const d = dist(e.x, e.z, m.x, m.z) - e.r;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  // ---------- 出手 ----------
  function hitInfo(m, ang) {
    const sk = m.ctx.sk;
    _info.ang = ang;
    _info.w = sk.w || 0;
    _info.kb = sk.kb || 0;
    _info.poise = sk.poise || 0;
    _info.minion = m;
    return _info;
  }
  const _info = { ang: 0, w: 0, kb: 0, poise: 0, quiet: true, minion: null };

  function startAttack(m, e) {
    const K = KIND[m.kind], mi = m.ctx.minion, fz = frenzyMul();
    const k = Math.min(1, mi.interval / fz / m.ctx.sk.rate); // 攻速快了（含狂热），动作也跟着快（不慢于原速）
    const dur = K.atkDur * k, hit = K.atkHit * k;
    m.state = 'attack';
    m.stateT = dur;
    m.strikeT = hit;
    m.target = e;
    m.atkT = mi.interval; // 狂热的加速在倒计时里算（每秒减 fz），这里不再除，免得算两遍
    m.ang = Math.atan2(e.x - m.x, e.z - m.z);
    G.world.play(m.ent, 'attack', { dur, contact: hit });
  }
  // 命中帧：仆从砍面前的目标；守像在身前砸出一圈
  function strike(m) {
    const W = G.world, ctx = m.ctx;
    if (m.kind === 'thrall') {
      const e = m.target;
      // 玩家正在处决的目标不去抢（处决只属于玩家）
      const reach = ctx.minion.reach + m.r + 0.6;
      if (!e || e.dead || e.execLock || dist(e.x, e.z, m.x, m.z) - e.r > reach) return;
      const a0 = Math.atan2(e.x - m.x, e.z - m.z);
      G.hitEnemy(e, ctx, 1, hitInfo(m, a0));
      const crit = G.lastHit.crit, type = G.lastHit.type;
      // 横斩带到身前扇面里贴着的其他敌人（至多 cleave 个）：清怪群有用，单挑首领不变
      let extra = ctx.minion.cleave;
      if (extra > 0) {
        const es = S.enemies, half = ctx.minion.arc / 2;
        for (let i = 0; i < es.length && extra > 0; i++) {
          const o = es[i];
          if (o === e || o.dead || o.execLock || dist(o.x, o.z, m.x, m.z) - o.r > reach) continue;
          let d = (Math.atan2(o.x - m.x, o.z - m.z) - a0) % TAU;
          if (d > Math.PI) d -= TAU;
          else if (d < -Math.PI) d += TAU;
          if (Math.abs(d) > half) continue;
          G.hitEnemy(o, ctx, 1, hitInfo(m, a0 + d));
          extra--;
        }
      }
      G.sfx('impact', { type, w: 0, crit });
      return;
    }
    const R = ctx.minion.radius;
    const cx = m.x + Math.sin(m.ang) * 1.3, cz = m.z + Math.cos(m.ang) * 1.3;
    const es = S.enemies;
    let n = 0;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead || e.execLock || dist(e.x, e.z, cx, cz) - e.r > R) continue;
      G.hitEnemy(e, ctx, 1, hitInfo(m, Math.atan2(e.x - cx, e.z - cz)));
      n++;
    }
    W.ring(cx, cz, R, ALLY_HEX, 0.35);
    W.burst(cx, 0.3, cz, 0xcbbba6, 14, 5, 0.45);
    W.decal(5, cx, cz, R * 0.8, Math.random() * TAU, 0x9fe8da, 2.2);
    if (dist(cx, cz, P.x, P.z) < 14) W.shake(0.1);
    G.sfx(n ? 'impact' : 'hit', { type: 'phys', w: 1, crit: false });
  }
  // 嘲讽：周围的敌人在几秒内只打守像（首领时间更短，招式照放不误）
  function canTaunt(m) {
    const t = m.ctx.minion.taunt;
    if (!t || m.tauntCd > 0) return false;
    const es = S.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (!e.dead && e.awake && dist(e.x, e.z, m.x, m.z) - e.r <= t.r) return true;
    }
    return false;
  }
  function startTaunt(m) {
    const K = KIND[m.kind];
    m.state = 'taunt';
    m.stateT = K.tauntDur;
    m.strikeT = K.tauntHit;
    m.tauntCd = m.tauntCdMax;
    G.world.play(m.ent, 'taunt', { dur: K.tauntDur, contact: K.tauntHit });
  }
  function taunt(m) {
    const W = G.world, t = m.ctx.minion.taunt, es = S.enemies;
    let n = 0;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead || dist(e.x, e.z, m.x, m.z) - e.r > t.r) continue;
      if (G.tauntEnemy && G.tauntEnemy(e, m, t.dur, t.boss)) n++;
    }
    W.ring(m.x, m.z, t.r, ALLY_HEX, 0.5);
    W.ring(m.x, m.z, t.r * 0.55, 0xffffff, 0.3);
    W.burst(m.x, m.height * 0.7, m.z, ALLY_HEX, 16, 4, 0.5);
    if (n) W.text(m.x, m.z, '嘲讽', '#4fe3c8', 18, { y: m.height + 1.2 }); // 抬到头顶血条上方，不压住血条
    G.sfx('boss');
    m.taunted = n;
  }

  // ---------- 闪避小怪的预警圈 ----------
  // 预警圈出现 DODGE_REACT 秒以后（反应时间），站在里面的仆从朝圈外迈步；返回单位方向（写进 _esc），不用躲时返回 null
  const DODGE_REACT = 0.3;
  const _esc = { x: 0, z: 0 };
  function dodgeDir(m) {
    const ts = S.telegraphs;
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (!t || t.friendly || !(t.dmg > 0) || t.t < DODGE_REACT || (t.owner && t.owner.isBoss)) continue;
      const dx = m.x - t.x, dz = m.z - t.z;
      if (t.shape === 'rect') {
        const s = Math.sin(t.ang), c = Math.cos(t.ang);
        const along = dx * s + dz * c, perp = dx * c - dz * s;
        if (Math.abs(along) > t.len / 2 + m.r || Math.abs(perp) > t.w / 2 + m.r) continue;
        const k = perp >= 0 ? 1 : -1;
        _esc.x = c * k;
        _esc.z = -s * k;
        return _esc;
      }
      const d = Math.hypot(dx, dz);
      if (d > t.r + m.r) continue;
      if (d < 1e-3) {
        _esc.x = Math.sin(m.ang + Math.PI / 2);
        _esc.z = Math.cos(m.ang + Math.PI / 2);
      } else {
        _esc.x = dx / d;
        _esc.z = dz / d;
      }
      return _esc;
    }
    return null;
  }

  // ---------- 跟随 ----------
  function followSpot(m, idx, n) {
    const W = G.world;
    const back = P.drawFace + Math.PI;
    let a, r;
    if (m.kind === 'colossus') {
      a = back;
      r = 4;
    } else {
      a = back + (n > 1 ? (idx - (n - 1) / 2) * (TAU / Math.max(3, n + 1)) : 0.6);
      r = 2.4 + (idx % 2) * 1.2;
    }
    let x = P.x + Math.sin(a) * r, z = P.z + Math.cos(a) * r;
    if (W.walkable(x, z, m.r)) {
      _spot.x = x;
      _spot.z = z;
      return _spot;
    }
    x = P.x + Math.sin(a) * r * 0.45;
    z = P.z + Math.cos(a) * r * 0.45;
    if (W.walkable(x, z, m.r)) {
      _spot.x = x;
      _spot.z = z;
      return _spot;
    }
    // 走廊里两侧都是墙：在玩家身边转圈找一个真正能站的位置（找不到就站在玩家脚边，由停步判定接手）
    return spotNear(r * 0.8, m.r, a);
  }

  // ---------- 每帧 ----------
  G.updateMinions = function (dt) {
    const W = G.world;
    // 集火目标：过期或死了就清掉；有召唤物时在它头顶标出来
    if (S.focusT > 0) S.focusT -= dt;
    if (S.focus && (S.focus.dead || !(S.focusT > 0))) S.focus = null;
    if (frenzyT > 0) frenzyT = Math.max(0, frenzyT - dt);
    const fz = frenzyMul();
    if (!list.length) {
      setMark(null);
      return;
    }
    setMark(S.focus && !S.focus.dead ? S.focus : null);

    refreshT -= dt;
    if (refreshT <= 0) {
      refreshT = REFRESH_GAP;
      refreshAll();
    }

    let ti = 0, tn = 0;
    for (let i = 0; i < list.length; i++) if (list[i].kind === 'thrall') tn++;

    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m || m.dead) continue;
      const K = KIND[m.kind];
      const mi = m.ctx.minion;
      m.moving = false;
      if (m.hurtT > 0) m.hurtT -= dt;
      if (m.ignoreT > 0) m.ignoreT -= dt;
      if (m.atkT > 0) m.atkT -= dt * fz;
      if (m.tauntCd > 0) m.tauntCd = Math.max(0, m.tauntCd - dt);

      if (m.rising > 0) {
        m.rising -= dt;
        if (!m.riseClip) W.setEntScale(m.ent, 0.25 + 0.75 * G.clamp(1 - m.rising / m.riseMax, 0, 1));
        if (m.rising <= 0) {
          m.rising = 0;
          if (!m.riseClip) W.setEntScale(m.ent, 1);
        }
      } else if (!P.dead) {
        if (dist(m.x, m.z, P.x, P.z) > LEASH) {
          regroup(m, i, list.length);
          continue;
        }
        if (m.state !== 'idle') {
          // 出手中：站定，到命中帧结算
          const t0 = m.strikeT;
          m.stateT -= dt;
          if (t0 >= 0) {
            m.strikeT -= dt;
            if (m.strikeT < 0) {
              if (m.state === 'attack') strike(m);
              else taunt(m);
            }
          }
          if (m.target && !m.target.dead) turn(m, Math.atan2(m.target.x - m.x, m.target.z - m.z), 6, dt);
          if (m.stateT <= 0) {
            m.state = 'idle';
            m.strikeT = -1;
          }
        } else {
          m.seekT -= dt;
          if (m.seekT <= 0 || (m.target && m.target.dead)) {
            m.seekT = SEEK_GAP;
            const nt = pickTarget(m);
            if (nt !== m.target) m.stuckT = 0;
            m.target = nt;
          }
          const e = m.target;
          const esc = m.kind === 'thrall' ? dodgeDir(m) : null;
          if (esc) {
            // 仆从身手灵活：看清小怪的预警圈之后会闪出去（守像太慢不躲；首领的招式也不躲，照样要吃）
            turn(m, Math.atan2(esc.x, esc.z), 12, dt);
            step(m, esc.x, esc.z, mi.move * fz * dt);
            m.moving = true;
          } else if (m.kind === 'colossus' && canTaunt(m)) startTaunt(m);
          else if (e) {
            const gap = m.kind === 'colossus' ? Math.max(mi.reach, mi.radius * 0.7) : mi.reach;
            const stop = e.r + m.r + gap * 0.85;
            if (moveTo(m, e.x, e.z, mi.move * fz, stop, dt, 0.45)) {
              m.stuckT = 0;
              turn(m, Math.atan2(e.x - m.x, e.z - m.z), 10, dt);
              if (m.atkT <= 0) startAttack(m, e);
            } else if (m.stuckT > STUCK_T) {
              m.ignore = e;
              m.ignoreT = 2.5;
              m.target = null;
              m.seekT = 1;
              m.stuckT = 0;
            }
          } else {
            const idx = m.kind === 'thrall' ? ti : 0;
            const sp = followSpot(m, idx, tn);
            const far = dist(m.x, m.z, sp.x, sp.z);
            const speed = mi.move * fz * (far > 6 ? 1.35 : 1);
            // 跟随点挪远了（玩家走动 / 转身）就重新开始计「走不过去」的时间
            if (Math.abs(sp.x - m.spX) + Math.abs(sp.z - m.spZ) > 1.2) {
              m.spX = sp.x;
              m.spZ = sp.z;
              m.spBest = far;
              m.spT = 0;
            } else if (far < m.spBest - 0.25) {
              m.spBest = far;
              m.spT = 0;
            } else m.spT += dt;
            const nearP = dist(m.x, m.z, P.x, P.z) <= 6;
            if (nearP && (m.spT > 1.0 || m.stuckT > STUCK_T)) {
              // 离玩家不远、却一直挪不近跟随点（走廊里被墙 / 同伴挡着）：就地站好，不对着墙原地踏步
              m.stuckT = 0;
              if (dist(m.x, m.z, P.x, P.z) > 1.2) turn(m, Math.atan2(P.x - m.x, P.z - m.z), 4, dt);
            } else if (!moveTo(m, sp.x, sp.z, speed, m.moving0 ? 0.3 : 1.0, dt)) {
              if (m.stuckT > STUCK_T && !nearP) {
                regroup(m, i, list.length);
                continue;
              }
            } else m.stuckT = 0;
          }
        }
        if (m.kind === 'thrall') ti++;
        separate(m, dt);
      }
      m.moving0 = m.moving;
      // 站在玩家和镜头之间（镜头在 +z 一侧俯视）、身子正好盖住玩家：镂空显示，玩家不会被挡没
      if (W.allyOcclude) {
        const oz = m.z - P.z;
        W.allyOcclude(m.ent, !P.dead && oz > 0.1 && oz < m.height * 0.95 && Math.abs(m.x - P.x) < m.r + 0.6, dt);
      }
      W.setEnt(m.ent, m.x, m.z, m.ang);
      W.animEnt(m.ent, dt, m.moving, S.time);
    }
  };
})();
