'use strict';
// 敌人：生成、区域布怪、每帧 AI（6 种小怪 + 首领 11 种招式）、状态效果、重置与清空
(function () {
  const G = window.G;
  const TAU = Math.PI * 2;

  // 玩家进入该距离时小怪苏醒。镜头朝屏幕下方只看得到 12 左右，
  // 再远的话怪会在画面外醒过来、从画面外扑进来
  const WAKE_DIST = 12;
  const RANGED_HOLD = 9; // 喷吐者与玩家保持的最远距离
  const RANGED_FLEE = 4.5; // 喷吐者被贴到这个距离以内就后撤
  const SKIP_DIST = 50; // 超过该距离的敌人整帧跳过
  const SAFE_START = 12; // 出生点周围不刷怪
  const PLAYER_R = 0.5;
  const DEATH_T = 0.25;
  const WARN_HEX = 0xff4a3a; // 近战起手提示用的警示色
  const POUNCE = 1.3; // 近战小怪出手时前扑的最远距离
  const COMMIT = 0.4; // 起手只剩最后这一成时已经收不住了：重击也打断不了
  const POUNCE_T = 0.1; // 前扑摊在起手的最后这么多秒里（不是一帧瞬移过去）
  // 召唤物：小怪在玩家与附近的召唤物之间挑一个打。离自己 FOE_RANGE 以内的召唤物才考虑；
  // 召唤物要比玩家近出 FOE_BIAS 才会被选中（偏向玩家）。被嘲讽时无条件打嘲讽者
  const FOE_RANGE = 7;
  const FOE_BIAS = 2.5;
  // 远程小怪和爆裂虫更认准玩家：召唤物得贴到跟前（比玩家近出这么多）才会转火，躲在召唤物后面的人照样挨射、照样被扑
  const FOE_BIAS_RANGED = 6;

  let packSeq = 1; // 怪群编号
  let spawnZone = null; // spawnZoneMobs 进行中时的 zone（此时 G.state.zone 可能还没赋值）

  // ---------- 小工具 ----------
  function hexOf(e) {
    return G.TYPE_HEX[e.elem];
  }
  // 延迟回调的统一校验：主人还活着、没被重置过、区域没换
  function live(e, seq) {
    return !e.dead && e.seq === seq && G.state.zone === e.zone;
  }
  function angTo(e, x, z) {
    return Math.atan2(x - e.x, z - e.z);
  }
  function turn(e, target, rate, dt) {
    let d = (target - e.ang) % TAU;
    if (d > Math.PI) d -= TAU;
    else if (d < -Math.PI) d += TAU;
    const m = rate * dt;
    e.ang += Math.abs(d) <= m ? d : Math.sign(d) * m;
  }
  function distToSeg(s, x, z) {
    const ux = s.bx - s.ax, uz = s.bz - s.az;
    const l2 = ux * ux + uz * uz;
    const t = l2 > 0 ? G.clamp(((x - s.ax) * ux + (z - s.az) * uz) / l2, 0, 1) : 0;
    return Math.hypot(x - (s.ax + ux * t), z - (s.az + uz * t));
  }

  // ---------- 移动：贴墙滑动 ----------
  function tryMove(e, mx, mz) {
    const W = G.world, pad = e.r * 0.8;
    if (W.walkable(e.x + mx, e.z + mz, pad)) {
      e.x += mx;
      e.z += mz;
      return true;
    }
    if (mx !== 0 && W.walkable(e.x + mx, e.z, pad)) {
      e.x += mx;
      return true;
    }
    if (mz !== 0 && W.walkable(e.x, e.z + mz, pad)) {
      e.z += mz;
      return true;
    }
    return false;
  }
  // 牵引（黑洞、黑旋风、渊缚、渊陷）：把 e 朝 (x, z) 挪 step 米，带撞墙检测（贴墙滑），不会被拽进墙里。返回实际挪动的距离
  G.pullEnemy = function (e, x, z, step) {
    if (!e || e.dead || !(step > 0)) return 0;
    const dx = x - e.x, dz = z - e.z, d = Math.hypot(dx, dz);
    if (d < 1e-4) return 0;
    const m = Math.min(step, d), ox = e.x, oz = e.z;
    tryMove(e, (dx / d) * m, (dz / d) * m);
    return Math.hypot(e.x - ox, e.z - oz);
  };
  const SLIDE = [0.9, -0.9, 1.45, -1.45];
  function moveDir(e, dx, dz, step) {
    if (tryMove(e, dx * step, dz * step)) return true;
    // 两个轴向都被挡（斜向的弧形边缘）：把方向沿墙偏转后再试
    const W = G.world, pad = e.r * 0.8;
    for (const a of SLIDE) {
      const c = Math.cos(a), s = Math.sin(a);
      const nx = e.x + (dx * c + dz * s) * step, nz = e.z + (dz * c - dx * s) * step;
      if (W.walkable(nx, nz, pad)) {
        e.x = nx;
        e.z = nz;
        return true;
      }
    }
    return false;
  }

  // ---------- 轻量寻路：区域是「空地—通道—空地」的链，被墙挡住时沿通道轴线走 ----------
  const navCache = new WeakMap();
  function navInfo(zone) {
    let n = navCache.get(zone);
    if (n) return n;
    const cs = zone.circles, ss = zone.segs;
    n = { ok: ss.length === cs.length - 1, fwd: [] };
    for (let i = 0; n.ok && i < ss.length; i++) {
      const s = ss[i], a = cs[i], b = cs[i + 1];
      const aA = Math.hypot(s.ax - a.x, s.az - a.z) <= a.r + 0.5;
      const bB = Math.hypot(s.bx - b.x, s.bz - b.z) <= b.r + 0.5;
      const aB = Math.hypot(s.ax - b.x, s.az - b.z) <= b.r + 0.5;
      const bA = Math.hypot(s.bx - a.x, s.bz - a.z) <= a.r + 0.5;
      if (aA && bB) n.fwd.push(true); // a 端在第 i 个空地，b 端通向 i+1
      else if (aB && bA) n.fwd.push(false);
      else n.ok = false; // 布局不是预期的链式：退回纯贴墙滑动
    }
    navCache.set(zone, n);
    return n;
  }
  // 链上的位置：空地 i → 2i，通道 i → 2i+1，不在任何区域 → -1
  function chainLoc(zone, x, z) {
    const cs = zone.circles, ss = zone.segs;
    for (let i = 0; i < cs.length; i++) if (Math.hypot(x - cs[i].x, z - cs[i].z) <= cs[i].r) return 2 * i;
    for (let i = 0; i < ss.length; i++) if (distToSeg(ss[i], x, z) <= ss[i].hw) return 2 * i + 1;
    return -1;
  }
  function lineClear(x0, z0, x1, z1, pad) {
    const W = G.world, dx = x1 - x0, dz = z1 - z0;
    const n = Math.ceil(Math.hypot(dx, dz) / 0.9);
    for (let i = 1; i < n; i++) {
      const k = i / n;
      if (!W.walkable(x0 + dx * k, z0 + dz * k, pad)) return false;
    }
    return true;
  }
  function refreshNav(e, tx, tz) {
    e.navDirect = lineClear(e.x, e.z, tx, tz, e.r * 0.6);
    e.navWp = false;
    if (e.navDirect) return;
    const zone = e.zone, n = navInfo(zone);
    if (!n.ok) return;
    const le = chainLoc(zone, e.x, e.z), lt = chainLoc(zone, tx, tz);
    if (le < 0 || lt < 0 || le === lt) return;
    const fwd = lt > le;
    const si = le & 1 ? (le - 1) / 2 : fwd ? le / 2 : le / 2 - 1;
    const s = zone.segs[si];
    const ux = s.bx - s.ax, uz = s.bz - s.az, len = Math.hypot(ux, uz) || 1;
    const t = ((e.x - s.ax) * ux + (e.z - s.az) * uz) / len;
    const t2 = G.clamp(t + (fwd === n.fwd[si] ? 3.5 : -3.5), 0, len);
    e.navX = s.ax + (ux / len) * t2;
    e.navZ = s.az + (uz / len) * t2;
    e.navWp = true;
  }
  // 给召唤物用的寻路：从 (x, z) 去 (tx, tz)，直线走得通就返回目标本身，否则沿通道轴线给一个路点（写进 out）
  const navProbe = { x: 0, z: 0, r: 0.5, zone: null, navDirect: true, navWp: false, navX: 0, navZ: 0 };
  G.navPoint = function (x, z, tx, tz, r, out) {
    const o = out || { x: 0, z: 0 };
    o.x = tx;
    o.z = tz;
    const zone = G.state.zone;
    if (!zone) return o;
    navProbe.x = x;
    navProbe.z = z;
    navProbe.r = r || 0.5;
    navProbe.zone = zone;
    refreshNav(navProbe, tx, tz);
    if (navProbe.navWp) {
      o.x = navProbe.navX;
      o.z = navProbe.navZ;
    }
    return o;
  };
  function updateNav(e, P, dt) {
    e.navT -= dt;
    if (e.navT > 0) return;
    e.navT = 0.2 + Math.random() * 0.1;
    refreshNav(e, P.x, P.z);
  }
  // 朝玩家（或当前路点）走一步，同时转向行进方向
  function chase(e, P, speed, dt) {
    const tx = e.navWp ? e.navX : P.x, tz = e.navWp ? e.navZ : P.z;
    const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    turn(e, Math.atan2(dx, dz), e.isBoss ? 6 : 10, dt);
    moveDir(e, dx / d, dz / d, Math.min(d, speed * dt));
  }

  // ---------- 生成 ----------
  function runtimeFields(e, zone) {
    e.zone = zone;
    e.home = { x: e.x, z: e.z };
    e.homeAng = e.ang;
    e.state = 'idle'; // idle | windup | fuse | recover
    e.stateT = 0;
    e.atkCd = 0;
    e.vis = 0; // 模型沿朝向的视觉偏移（蓄力后仰 / 出手前扑），不影响判定位置
    e.seq = 0; // 每次重置 +1，使旧的延迟回调失效
    e.wasAwake = false;
    e.moving = false;
    e.navT = Math.random() * 0.2;
    e.navDirect = true;
    e.navWp = false;
    e.navX = 0;
    e.navZ = 0;
    e.summoned = false;
    // 打击反馈：击退速度、被重击后的踉跄时间
    e.kvx = 0;
    e.kvz = 0;
    e.stagT = 0;
    // 架势（poiseMax 为 0 表示没有架势条）：poiseT 距离开始回复还有多久，poiseHit 刚挨打的闪动，
    // brokenT 破绽剩余秒数，executed 这次破绽已经被处决过，execLock 正在被处决（破绽不会到点结束）
    e.poiseBase = e.poiseMax = e.poise = e.poiseMax || 0;
    e.poiseT = 0;
    e.poiseHit = 0;
    e.brokenT = 0;
    e.brokenMax = 1;
    e.breaks = 0;
    e.executed = false;
    e.execLock = false;
    // 攻击对象：foe 为 null 表示玩家，否则是一只召唤物；foeT 下次重新挑选的倒计时；
    // tauntT / taunter：被守像嘲讽的剩余秒数与嘲讽者
    e.foe = null;
    e.foeT = 0;
    e.tauntT = 0;
    e.taunter = null;
    return e;
  }

  G.spawnMob = function (type, x, z, level, opts) {
    const o = opts || {};
    const def = G.MOBS[type];
    const zone = spawnZone || G.state.zone;
    const elite = !!o.elite;
    const elem = zone.def.elem;
    const hp = Math.max(1, Math.round(def.hp * G.hpScale(level) * (elite ? 4.5 : 1))); // 精英血量 4 → 4.5：补偿破绽易伤与处决
    const r = def.r * (elite ? 1.25 : 1);
    const e = runtimeFields({
      type, def, name: elite ? '精英' + def.name : def.name, x, z, r, hp, maxHp: hp,
      dmg: def.dmg * G.dmgScale(level) * (elite ? 1.3 : 1), level, speed: def.speed, elem, elite,
      isBoss: false, bossKind: null, pack: o.pack == null ? null : o.pack, awake: !!o.awake,
      dead: false, deathT: 0, height: (def.h || (type === 'brute' ? 2.8 : 2)) * (elite ? 1.35 : 1),
      freeze: 0, stunT: 0, slowK: 1, iced: false,
      ent: G.world.makeMob(type, G.TYPE_HEX[elem], elite),
      ang: Math.random() * TAU,
      reach: def.range + (r - def.r), // 攻击距离随体型略增
      mass: def.mass * (elite ? 1.7 : 1), poiseMax: elite ? def.poise : 0,
    }, zone);
    G.initBuildUp(e); // 元素异常值（阈值按最大生命定）
    e.blinkCd = G.rand(1.5, 3); // 隙影：第一次闪身前的冷却
    G.world.setEnt(e.ent, x, z, e.ang);
    G.state.enemies.push(e);
    return e;
  };

  G.spawnBoss = function (kind, x, z, level) {
    const def = G.BOSSES[kind];
    const zone = spawnZone || G.state.zone;
    const elem = zone.def.elem;
    const hp = Math.round(def.hp * G.hpScale(level));
    const e = runtimeFields({
      type: kind, def, name: def.name, x, z, r: def.r, hp, maxHp: hp,
      dmg: def.dmg * G.dmgScale(level), level, speed: def.speed, elem, elite: false,
      isBoss: true, bossKind: kind, pack: null, awake: false,
      dead: false, deathT: 0, height: 4.6,
      freeze: 0, stunT: 0, slowK: 1, iced: false,
      ent: G.world.makeBoss(kind, G.TYPE_HEX[elem]),
      ang: 0,
      busy: 0, cd: 1, enraged: false, lastPattern: null, dash: null, aim: 0,
      mass: 50, poiseMax: def.poise,
    }, zone);
    G.initBuildUp(e);
    G.world.setEnt(e.ent, x, z, e.ang);
    G.state.enemies.push(e);
    G.state.boss = e;
    return e;
  };

  // ---------- 区域布怪 ----------
  function farFromStart(zone, x, z) {
    return Math.hypot(x - zone.start.x, z - zone.start.z) >= SAFE_START;
  }
  function spaced(list, x, z, min) {
    for (const p of list) if (Math.hypot(p.x - x, p.z - z) < min) return false;
    return true;
  }
  // 坠星裂谷的两种新怪，在轮回层级 1 起也会零星混进其它区域的怪群里
  const LATE_MOBS = ['phaser', 'charger'];
  const LATE_CHANCE = 0.05;
  function packType(mobs, main, zone) {
    if (zone && zone.level > zone.def.level && Math.random() < LATE_CHANCE) {
      const t = G.pick(LATE_MOBS);
      if (mobs.indexOf(t) < 0 && G.MOBS[t]) return t;
    }
    return Math.random() < 0.78 ? main : G.pick(mobs);
  }
  // 一个空地里的若干怪群：先排好位置和类型，再决定精英，最后统一生成
  function populateClearing(zone, ci) {
    const W = G.world, c = zone.circles[ci], mobs = zone.def.mobs;
    const level = zone.level + Math.floor(ci / 2);
    const nPacks = c.r > 10.5 ? 3 : 2;
    const inner = c.r - 3; // 成员离空地边缘至少 3
    const centres = [], packs = [];
    for (let p = 0; p < nPacks; p++) {
      let cx = c.x, cz = c.z, found = false;
      for (let tries = 0; tries < 16 && !found; tries++) {
        const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * Math.max(0.5, inner - 1.6);
        cx = c.x + Math.sin(a) * d;
        cz = c.z + Math.cos(a) * d;
        // 前几次尝试要求怪群之间拉开距离，实在排不开就放宽
        found = farFromStart(zone, cx, cz) && spaced(centres, cx, cz, tries < 10 ? 6 : 3.5);
      }
      if (!found) continue;
      centres.push({ x: cx, z: cz });
      const main = G.pick(mobs), want = G.randInt(4, 6), members = [];
      for (let m = 0; m < want; m++) {
        for (let tries = 0; tries < 12; tries++) {
          const a = Math.random() * TAU, d = G.rand(0.4, 2.6);
          const x = cx + Math.sin(a) * d, z = cz + Math.cos(a) * d;
          if (Math.hypot(x - c.x, z - c.z) > inner) continue;
          if (!W.walkable(x, z, 1) || !farFromStart(zone, x, z) || !spaced(members, x, z, 1.4)) continue;
          members.push({ x, z, type: packType(mobs, main, zone), elite: false });
          break;
        }
      }
      if (members.length) packs.push(members);
    }
    if (packs.length && Math.random() < 0.55) {
      // 精英尽量不选自爆虫（自爆不掉落，做成精英没有意义）
      const pack = G.pick(packs);
      let m = G.pick(pack);
      if (m.type === 'bomber') {
        m = pack.find((q) => q.type !== 'bomber') || m;
        if (m.type === 'bomber') m.type = mobs.find((t) => t !== 'bomber') || 'husk';
      }
      m.elite = true;
    }
    for (const members of packs) {
      const pack = packSeq++;
      for (const m of members) G.spawnMob(m.type, m.x, m.z, level, { elite: m.elite, pack, awake: false });
    }
  }
  // 通道露在两端空地之外那一段的中点（退化时用几何中点）
  function corridorMid(zone, s) {
    const out = [];
    for (let i = 0; i <= 24; i++) {
      const k = i / 24, x = s.ax + (s.bx - s.ax) * k, z = s.az + (s.bz - s.az) * k;
      let inCircle = false;
      for (const c of zone.circles) if (Math.hypot(x - c.x, z - c.z) <= c.r) inCircle = true;
      if (!inCircle) out.push({ x, z });
    }
    return out.length ? out[out.length >> 1] : { x: (s.ax + s.bx) / 2, z: (s.az + s.bz) / 2 };
  }
  function populateCorridor(zone, si) {
    const W = G.world, mobs = zone.def.mobs, mid = corridorMid(zone, zone.segs[si]);
    const level = zone.level + Math.floor(si / 2);
    const main = G.pick(mobs), want = G.randInt(2, 3), pack = packSeq++, members = [];
    for (let m = 0; m < want; m++) {
      for (let tries = 0; tries < 12; tries++) {
        const a = Math.random() * TAU, d = G.rand(0, 1.7);
        const x = mid.x + Math.sin(a) * d, z = mid.z + Math.cos(a) * d;
        if (!W.walkable(x, z, 1) || !farFromStart(zone, x, z) || !spaced(members, x, z, 1.3)) continue;
        members.push({ x, z });
        G.spawnMob(packType(mobs, main, zone), x, z, level, { elite: false, pack, awake: false });
        break;
      }
    }
  }

  G.spawnZoneMobs = function (zone) {
    spawnZone = zone;
    try {
      const last = zone.circles.length - 1; // 最后一个空地是首领场地
      for (let ci = 1; ci < last; ci++) populateClearing(zone, ci);
      for (let si = 1; si < zone.segs.length; si++) populateCorridor(zone, si);
      G.spawnBoss(zone.def.boss, zone.bossPos.x, zone.bossPos.z, zone.level + 3);
    } finally {
      spawnZone = null;
    }
  };

  // ---------- 苏醒 ----------
  function wakePack(e) {
    e.awake = true;
    if (e.pack == null) return;
    for (const o of G.state.enemies) if (o.pack === e.pack && !o.dead) o.awake = true;
  }
  // 从沉睡到苏醒的那一帧（也覆盖 game.js 命中时直接置 awake 的情况）
  function onWake(e) {
    e.wasAwake = true;
    e.navT = 0;
    if (e.isBoss) {
      e.cd = 1.1; // 开场先给玩家一拍反应时间
      e.busy = 0;
      G.world.ring(e.x, e.z, e.r + 3, hexOf(e), 0.6);
      G.world.shake(0.3);
      G.sfx('boss');
    } else {
      e.atkCd = Math.max(e.atkCd, G.rand(0.15, 0.6)); // 错开同一群怪的首次出手
    }
  }

  // ---------- 攻击对象 ----------
  // 打中攻击对象：玩家走 G.hurtPlayer，召唤物走 G.hurtMinion
  function strike(tg, dmg, dtype, src) {
    if (tg === G.player) G.hurtPlayer(dmg, dtype, src);
    else if (G.hurtMinion) G.hurtMinion(tg, dmg, dtype, src);
  }
  function foeOk(m) {
    return !!m && !m.dead && !(m.rising > 0);
  }
  // 一只召唤物同时最多牵制几只小怪（仆从 2、守像 4；嘲讽不受这个限制）：多出来的怪照样冲着玩家去
  function minionHold(m) {
    return (m.ctx && m.ctx.minion && m.ctx.minion.hold) || 2;
  }
  // 除了 self 以外，眼下有几只怪正盯着召唤物 m
  function aggroOn(m, self) {
    const es = G.state.enemies;
    let n = 0;
    for (let i = 0; i < es.length; i++) {
      const o = es[i];
      if (o !== self && o.foe === m && !o.dead && o.awake) n++;
    }
    return n;
  }
  // 这一帧小怪 / 首领的攻击对象（玩家或某只召唤物）。出手途中不换对象，预警和扑击才对得上
  function pickFoe(e, P, dt) {
    if (e.tauntT > 0) {
      e.tauntT -= dt;
      if (foeOk(e.taunter)) return e.taunter;
      e.tauntT = 0;
    }
    e.taunter = null;
    if (e.isBoss) return P; // 首领只会被嘲讽短暂吸引，平时只盯玩家
    const ms = G.state.minions;
    if (!ms || !ms.length) {
      e.foe = null;
      return P;
    }
    const busy = e.state !== 'idle';
    e.foeT -= dt;
    if ((e.foeT > 0 || busy) && (e.foe === null || foeOk(e.foe))) return e.foe || P;
    e.foeT = 0.35 + Math.random() * 0.25;
    let best = null, bd = FOE_RANGE;
    for (let i = 0; i < ms.length; i++) {
      const m = ms[i];
      if (!foeOk(m) || aggroOn(m, e) >= minionHold(m)) continue; // 已经被围满的召唤物不再吸引更多的怪
      const d = Math.hypot(m.x - e.x, m.z - e.z) - m.r;
      if (d < bd) {
        bd = d;
        best = m;
      }
    }
    const bias = e.def && (e.def.ai === 'ranged' || e.def.ai === 'bomb' || e.def.ai === 'blink') ? FOE_BIAS_RANGED : FOE_BIAS;
    e.foe = best && (P.dead || bd + bias < Math.hypot(P.x - e.x, P.z - e.z)) ? best : null;
    return e.foe || P;
  }
  // 守像的嘲讽：dur 秒内只打它（首领用 bossDur，且不打断已经开始的招式）
  G.tauntEnemy = function (e, m, dur, bossDur) {
    if (!e || e.dead || !m || m.dead) return false;
    e.tauntT = Math.max(e.tauntT || 0, e.isBoss ? bossDur : dur);
    e.taunter = m;
    if (!e.isBoss) {
      e.foe = m;
      e.foeT = e.tauntT;
    }
    e.awake = true;
    return true;
  };

  // ---------- 小怪 AI ----------
  // volley：同一轮齐射共用一个编号，game.js 保证一轮齐射对玩家只结算一次伤害
  let volleySeq = 1;
  // 敌弹的外形（只管样子）：喷吐者吐黏液弹，首领各有各的——霜织者冰棱、雷霆监察者雷球、熔渣巨像 / 烬渊之主火弹
  const BOSS_SHOT = { weaver: 'shard', warden: 'spark', golem: 'firebolt', lord: 'firebolt', behemoth: 'spark' };
  const MOB_SHOT = { phaser: 'spark' }; // 隙影放的是电弹
  function shoot(e, ang, speed, dmg, r, life, off, volley) {
    const dx = Math.sin(ang), dz = Math.cos(ang);
    // 矮个子（喷吐者的蜘蛛）从嘴边吐出来，而不是凭空出现在统一的弹道高度上
    const y0 = e.height < 1.5 && e.ent && G.world.entSocket ? Math.max(0.2, G.world.entSocket(e.ent, 'weapon').y) : undefined;
    G.spawnProjectile({
      owner: 'e', x: e.x + dx * off, z: e.z + dz * off, y0, dx, dz, speed, r, life,
      color: hexOf(e), dmg, dtype: e.elem, volley,
      vk: e.isBoss ? BOSS_SHOT[e.bossKind] : MOB_SHOT[e.type] || 'glob',
    });
  }

  // 出手动作要提前播：动作从第一帧到「命中帧」还要走一小段（W.clipLead），
  // 所以在起手只剩这么久的时候就开始播，并把命中帧对在伤害结算的那一刻——玩家看到的是「打中了才掉血」。
  // 被眩晕 / 踉跄打断过的（动作被换掉了）解控后会重新对一次。
  function strikeAnim(e, left) {
    const W = G.world;
    if (W.clipOf(e.ent) === 'attack') return;
    const lead = W.clipLead(e.ent, 'attack');
    if (left <= lead) W.play(e.ent, 'attack', { contact: Math.max(left, 0.001) });
  }

  function aiMelee(e, dt, P, dist, spd) {
    const def = e.def, W = G.world;
    if (e.state === 'windup') {
      const t0 = e.stateT;
      e.stateT -= dt;
      turn(e, angTo(e, P.x, P.z), 3, dt);
      strikeAnim(e, e.stateT);
      if (e.stateT > POUNCE_T) {
        e.vis = -0.32 * (1 - e.stateT / def.windup); // 蓄力后仰
        return;
      }
      // 起手的最后一瞬：朝玩家扑出去（摊在这 0.1 秒里走完），落地时按当时的距离判定。
      // 扑得够远，蓄力时被轻击推开一两步照样够得着
      const f = 1 - Math.max(0, e.stateT) / POUNCE_T;
      const gap = dist - (e.r + PLAYER_R + 0.2); // dist 已按召唤物的体型折算过
      if (gap > 0) {
        const a = angTo(e, P.x, P.z), d = Math.min((POUNCE * (Math.min(t0, POUNCE_T) - Math.max(0, e.stateT))) / POUNCE_T, gap);
        if (d > 0) tryMove(e, Math.sin(a) * d, Math.cos(a) * d);
      }
      e.vis = -0.32 * (1 - POUNCE_T / def.windup) * (1 - f) + 0.35 * f; // 后仰顺势变成前探
      if (e.stateT > 0) return;
      W.slash(e.x, e.z, e.ang, e.reach + 0.5, 100, WARN_HEX);
      if (W.clipOf(e.ent) !== 'attack') W.play(e.ent, 'attack');
      if (Math.hypot(P.x - e.x, P.z - e.z) <= e.reach + 0.2 + (P.r || PLAYER_R)) strike(P, e.dmg, 'phys', e);
      e.state = 'recover';
      e.stateT = 0.28;
      e.vis = 0.35;
      e.atkCd = def.cd * G.rand(0.9, 1.2);
      return;
    }
    if (e.state === 'recover') {
      e.stateT -= dt;
      e.vis = Math.max(0, e.vis - dt * 1.6);
      if (e.stateT <= 0) {
        e.state = 'idle';
        e.vis = 0;
      }
      return;
    }
    if (dist <= e.reach && e.atkCd <= 0 && e.navDirect) {
      e.state = 'windup';
      e.stateT = def.windup;
      W.play(e.ent, 'windup', { dur: def.windup });
      W.ring(e.x, e.z, e.r + 0.8, WARN_HEX, def.windup / (e.slowK || 1)); // 起手提示（冰缓时起手变慢，环跟着多亮一会儿）
      return;
    }
    if (dist > e.reach * 0.8) chase(e, P, spd, dt);
    else turn(e, angTo(e, P.x, P.z), 10, dt);
  }

  function aiSlam(e, dt, P, dist, spd) {
    const def = e.def, W = G.world;
    if (e.state === 'windup') {
      e.stateT -= dt;
      const lead = W.clipLead(e.ent, 'attack');
      if (e.stateT > lead) e.vis = -0.3 * (1 - e.stateT / def.windup);
      else if (e.stateT > 0) {
        // 双拳开始往下砸：身子从后仰变成前倾，拳头落地正好是预警圈结算的那一刻
        const f = 1 - e.stateT / lead;
        e.vis = -0.3 * (1 - lead / def.windup) * (1 - f) + 0.35 * f;
      }
      strikeAnim(e, e.stateT);
      // 正常由预警圈的 onFire 结束；预警圈被外部清掉时靠本地计时兜底
      if (e.stateT <= -0.3) {
        e.state = 'recover';
        e.stateT = 0.3;
        e.atkCd = def.cd;
      }
      return;
    }
    if (e.state === 'recover') {
      e.stateT -= dt;
      e.vis = Math.max(0, e.vis - dt * 1.2);
      if (e.stateT <= 0) {
        e.state = 'idle';
        e.vis = 0;
      }
      return;
    }
    if (dist <= e.reach && e.atkCd <= 0 && e.navDirect) {
      const seq = e.seq, a = angTo(e, P.x, P.z), off = 1.8 + (e.r - def.r);
      const x = e.x + Math.sin(a) * off, z = e.z + Math.cos(a) * off;
      e.ang = a;
      e.state = 'windup';
      e.stateT = def.windup;
      W.play(e.ent, 'windup', { dur: def.windup });
      G.telegraph({
        shape: 'circle', x, z, r: 2.6, dur: def.windup, dmg: e.dmg, dtype: 'phys',
        owner: e, cancelIfOwnerDead: true, friendly: false,
        onFire() {
          if (!live(e, seq)) return;
          if (W.clipOf(e.ent) !== 'attack') W.play(e.ent, 'attack');
          W.burst(x, 0.3, z, 0xcbbba6, 12, 5, 0.4);
          W.shake(0.2);
          G.sfx('hit');
          e.state = 'recover';
          e.stateT = 0.4;
          e.vis = 0.35;
          e.atkCd = def.cd * G.rand(0.9, 1.15);
        },
      });
      return;
    }
    if (dist > e.reach * 0.75) chase(e, P, spd, dt);
    else turn(e, angTo(e, P.x, P.z), 6, dt);
  }

  function aiRanged(e, dt, P, dist, spd) {
    const def = e.def, W = G.world;
    if (e.state === 'windup') {
      e.stateT -= dt;
      turn(e, angTo(e, P.x, P.z), 9, dt);
      e.vis = -0.2 * (1 - Math.max(0, e.stateT) / def.windup);
      if (W.inView(e.x, e.z)) strikeAnim(e, e.stateT);
      if (e.stateT > 0) return;
      e.state = 'idle';
      e.vis = 0;
      if (!W.inView(e.x, e.z)) {
        // 蓄力期间玩家把它甩出了画面：这一发作废，回到画面里再来
        e.atkCd = 0.3;
        W.stop(e.ent);
        return;
      }
      const a = angTo(e, P.x, P.z);
      e.ang = a;
      if (W.clipOf(e.ent) !== 'attack') W.play(e.ent, 'attack');
      shoot(e, a, 11, e.dmg, 0.35, 2.5, e.r + 0.25);
      G.sfx('cast');
      e.atkCd = def.cd * G.rand(0.9, 1.25);
      return;
    }
    // 只在玩家看得见它的时候开火：画面外飞来的弹丸没法躲
    const seen = W.inView(e.x, e.z);
    if (seen && dist <= def.range && e.navDirect && e.atkCd <= 0) {
      e.state = 'windup';
      e.stateT = def.windup;
      W.play(e.ent, 'windup', { dur: def.windup });
      const mo = W.entSocket(e.ent, 'weapon');
      W.burst(mo.x, mo.y, mo.z, hexOf(e), 5, 1.6, def.windup / (e.slowK || 1)); // 嘴边聚能
      return;
    }
    if (dist > RANGED_HOLD || !e.navDirect || !seen) {
      chase(e, P, spd, dt);
      return;
    }
    turn(e, angTo(e, P.x, P.z), 9, dt);
    if (dist < RANGED_FLEE && dist > 0.01) {
      // 被贴近了就后撤；正后方走不通时试着斜着退
      const ux = (e.x - P.x) / dist, uz = (e.z - P.z) / dist, step = spd * 0.85 * dt;
      const pad = e.r * 0.8;
      for (const a of [0, 0.8, -0.8]) {
        const c = Math.cos(a), s = Math.sin(a);
        const nx = e.x + (ux * c + uz * s) * step, nz = e.z + (uz * c - ux * s) * step;
        if (W.walkable(nx, nz, pad) && W.inView(nx, nz)) {
          e.x = nx;
          e.z = nz;
          break;
        }
      }
    }
  }

  function aiBomb(e, dt, P, dist, spd) {
    const def = e.def, W = G.world;
    if (e.state === 'fuse') {
      e.stateT -= dt;
      strikeAnim(e, e.stateT); // 腹囊撑到最大的那一帧对在爆炸上
      if (e.stateT <= -0.3) {
        // 预警圈被外部清掉了：解除引信，稍后再来
        e.state = 'idle';
        e.atkCd = 1;
        W.stop(e.ent);
      }
      return;
    }
    if (dist <= e.reach && e.atkCd <= 0 && e.navDirect) {
      const seq = e.seq, x = e.x, z = e.z, hex = hexOf(e);
      e.state = 'fuse';
      e.stateT = def.windup;
      W.play(e.ent, 'windup', { dur: def.windup });
      G.telegraph({
        shape: 'circle', x, z, r: 3.0, dur: def.windup, dmg: e.dmg, dtype: e.elem,
        owner: e, cancelIfOwnerDead: true, friendly: false,
        onFire() {
          if (!live(e, seq)) return;
          // 自爆：直接标记死亡，不走 G.killEnemy，所以没有经验和掉落
          e.selfDestruct = true;
          if (W.clipOf(e.ent) !== 'attack') W.play(e.ent, 'attack');
          e.hp = 0;
          e.dead = true;
          e.deathT = DEATH_T;
          W.burst(x, 0.8, z, hex, 26, 8, 0.5);
          W.ring(x, z, 3.0, hex, 0.3);
          W.shake(0.3);
          G.sfx('hit');
        },
      });
      return;
    }
    if (dist > e.reach * 0.7) chase(e, P, spd, dt);
    else turn(e, angTo(e, P.x, P.z), 10, dt);
  }

  // ---------- 持续型危险区（引力井、横扫射线）：每帧推进，主人被打出破绽 / 死亡 / 换区时立即作废 ----------
  const hazards = [];
  function addHazard(h) {
    hazards.push(h);
    return h;
  }
  function updateHazards(dt) {
    for (let i = hazards.length - 1; i >= 0; i--) {
      const h = hazards[i];
      if (!live(h.e, h.seq) || h.update(dt) === false) {
        hazards.splice(i, 1);
        if (h.end) h.end();
      }
    }
  }
  function clearHazards() {
    const list = hazards.splice(0, hazards.length);
    for (const h of list) if (h.end) h.end();
  }
  // 一次招式里同一个目标只结算一次（玩家 / 每只召唤物）
  const mkOnce = () => ({ p: false, m: new Set() });
  // 以 (x, z) 为中心、半径 r 的一次打击：玩家与范围内的召唤物（首领打召唤物按 BOSS_VS_MINION 加重）
  function zap(e, x, z, r, dmg, dtype, once) {
    const P = G.player;
    if (!(once && once.p) && !P.dead && Math.hypot(P.x - x, P.z - z) <= r + PLAYER_R) {
      if (G.hurtPlayer(dmg, dtype, e) && once) once.p = true;
    }
    const ms = G.state.minions;
    if (!ms || !G.hurtMinion) return;
    const k = e.isBoss ? G.BOSS_VS_MINION || 1.6 : 1;
    for (let j = ms.length - 1; j >= 0; j--) {
      const m = ms[j];
      if (!m || m.dead || (once && once.m.has(m))) continue;
      if (Math.hypot(m.x - x, m.z - z) <= r + (m.r || 0.5)) {
        G.hurtMinion(m, dmg * k, dtype, e);
        if (once) once.m.add(m);
      }
    }
  }
  function segDist(x, z, ax, az, bx, bz) {
    const ux = bx - ax, uz = bz - az, l2 = ux * ux + uz * uz;
    const t = l2 > 0 ? G.clamp(((x - ax) * ux + (z - az) * uz) / l2, 0, 1) : 0;
    return Math.hypot(x - (ax + ux * t), z - (az + uz * t));
  }

  // ---------- 隙影：保持距离放电弹；隔一阵闪到玩家侧面，现身后补一轮三连扇射 ----------
  const BLINK_T = 0.45; // 闪身：原地隐去、落点亮预警环的时长
  const BLINK_AIM = 0.5; // 现身到开火
  function blinkSpot(e, P) {
    const W = G.world, away = Math.atan2(e.x - P.x, e.z - P.z), es = G.state.enemies;
    for (let i = 0; i < 12; i++) {
      const a = away + (i & 1 ? 1 : -1) * G.rand(1.1, 2.1), d = G.rand(5.5, 7.5);
      const x = P.x + Math.sin(a) * d, z = P.z + Math.cos(a) * d;
      if (!W.walkable(x, z, e.r + 0.4) || !W.inView(x, z)) continue;
      if (Math.hypot(x - e.x, z - e.z) < 3 || !lineClear(x, z, P.x, P.z, 0.3)) continue;
      let crowd = false;
      for (let j = 0; j < es.length && !crowd; j++) {
        const o = es[j];
        if (o !== e && !o.dead && Math.hypot(o.x - x, o.z - z) < 1.5) crowd = true;
      }
      if (!crowd) return { x, z };
    }
    return null;
  }
  function aiBlink(e, dt, P, dist, spd) {
    const def = e.def, W = G.world, hex = hexOf(e);
    if (e.blinkCd > 0) e.blinkCd -= dt; // dt 已是冰缓放慢后的时钟
    if (e.state === 'blink') {
      e.stateT -= dt;
      if (e.stateT > 0) return;
      // 现身：落在预警环里，转向目标，短暂瞄准后三连扇射
      e.x = e.blinkX;
      e.z = e.blinkZ;
      e.ang = angTo(e, P.x, P.z);
      e.kvx = e.kvz = 0;
      W.setEnt(e.ent, e.x, e.z, e.ang);
      W.play(e.ent, 'appear');
      W.burst(e.x, 1.3, e.z, hex, 16, 4.5, 0.4);
      W.ring(e.x, e.z, 1.6, hex, 0.3);
      e.state = 'windup';
      e.stateT = BLINK_AIM;
      e.fan = true;
      e.navT = 0;
      return;
    }
    if (e.state === 'windup' && e.fan) {
      e.stateT -= dt;
      turn(e, angTo(e, P.x, P.z), 9, dt);
      strikeAnim(e, e.stateT);
      if (e.stateT > 0) return;
      e.state = 'idle';
      e.fan = false;
      if (!W.inView(e.x, e.z)) {
        e.atkCd = 0.3;
        W.stop(e.ent);
        return;
      }
      const a = angTo(e, P.x, P.z), volley = volleySeq++;
      e.ang = a;
      if (W.clipOf(e.ent) !== 'attack') W.play(e.ent, 'attack');
      for (let i = -1; i <= 1; i++) shoot(e, a + i * 0.24, 12, e.dmg * 0.85, 0.32, 2.3, e.r + 0.3, volley);
      G.sfx('cast');
      e.atkCd = def.cd * G.rand(0.9, 1.2);
      return;
    }
    // 闪身：被贴近了，或者正好准备出手——落点在玩家侧面 5.5–7.5 远、画面之内、和玩家之间没有遮挡
    if (e.state === 'idle' && e.blinkCd <= 0 && W.inView(e.x, e.z) && dist < 13 && (dist < RANGED_FLEE + 0.5 || e.atkCd <= 0.2)) {
      const d = blinkSpot(e, P);
      if (d) {
        e.state = 'blink';
        e.stateT = BLINK_T;
        e.blinkX = d.x;
        e.blinkZ = d.z;
        e.blinkCd = G.rand(4.5, 6.5);
        e.vis = 0;
        W.play(e.ent, 'blink', { dur: BLINK_T });
        W.ring(d.x, d.z, 1.3, hex, BLINK_T / (e.slowK || 1)); // 落点预警（冰缓时闪身变慢，环跟着多亮一会儿）
        W.burst(e.x, 1.2, e.z, hex, 10, 3, 0.35);
        return;
      }
      e.blinkCd = 0.8;
    }
    aiRanged(e, dt, P, dist, spd);
  }

  // ---------- 陨角兽：刨地蓄力（地上亮出冲锋道），沿直线猛冲，撞墙会晕；贴身时用角顶 ----------
  const CHARGE_SPEED = 17;
  const GORE_T = 0.45;
  const GORE_REACH = 1.7;
  function chargeHits(e, P) {
    const once = e.dashHit, R = e.r + 0.35;
    P = G.player; // 冲锋撞上谁算谁：不管它原本盯的是玩家还是召唤物
    if (!once.p && !P.dead && Math.hypot(P.x - e.x, P.z - e.z) <= R + PLAYER_R) {
      if (G.hurtPlayer(e.dmg, 'phys', e)) {
        once.p = true;
        G.world.shake(0.25);
      }
    }
    const ms = G.state.minions;
    if (!ms || !G.hurtMinion) return;
    for (let j = ms.length - 1; j >= 0; j--) {
      const m = ms[j];
      if (!m || m.dead || once.m.has(m) || m.rising > 0) continue;
      if (Math.hypot(m.x - e.x, m.z - e.z) <= R + (m.r || 0.5)) {
        G.hurtMinion(m, e.dmg, 'phys', e);
        once.m.add(m);
      }
    }
  }
  function aiCharge(e, dt, P, dist, spd) {
    const def = e.def, W = G.world;
    if (e.goreCd > 0) e.goreCd -= dt;
    if (e.state === 'windup') {
      e.stateT -= dt;
      if (e.gore) {
        turn(e, angTo(e, P.x, P.z), 4, dt);
        strikeAnim(e, e.stateT);
        e.vis = -0.25 * (1 - Math.max(0, e.stateT) / GORE_T);
        if (e.stateT > 0) return;
        W.slash(e.x, e.z, e.ang, GORE_REACH + e.r + 0.4, 90, WARN_HEX);
        if (W.clipOf(e.ent) !== 'attack') W.play(e.ent, 'attack');
        if (Math.hypot(P.x - e.x, P.z - e.z) <= GORE_REACH + e.r + (P.r || PLAYER_R)) strike(P, e.dmg * 0.7, 'phys', e);
        e.gore = false;
        e.state = 'recover';
        e.stateT = 0.4;
        e.vis = 0.3;
        e.goreCd = 1.6;
        return;
      }
      // 冲锋蓄力：方向锁死在预警道上，后蹄刨地扬尘
      e.vis = -0.28 * (1 - Math.max(0, e.stateT) / def.windup);
      if (Math.random() < dt * 14) W.burst(e.x - e.laneDx * e.r, 0.2, e.z - e.laneDz * e.r, 0xbfb6a6, 2, 2, 0.35);
      if (e.stateT > 0) return;
      e.state = 'dash';
      e.dashLeft = e.laneLen;
      e.dashHit = mkOnce();
      e.vis = 0;
      e.ang = Math.atan2(e.laneDx, e.laneDz);
      W.play(e.ent, 'charge', { loop: true });
      W.ring(e.x, e.z, e.r + 1, WARN_HEX, 0.25);
      G.sfx('hit');
      return;
    }
    if (e.state === 'dash') {
      const pad = e.r * 0.8;
      let remain = Math.min(e.dashLeft, CHARGE_SPEED * dt), wall = false; // dt 已是冰缓放慢后的时钟
      e.dashLeft -= remain;
      while (remain > 1e-6) {
        const m = Math.min(0.35, remain);
        const nx = e.x + e.laneDx * m, nz = e.z + e.laneDz * m;
        if (!W.walkable(nx, nz, pad)) {
          wall = true;
          break;
        }
        e.x = nx;
        e.z = nz;
        remain -= m;
        chargeHits(e, P);
      }
      if (Math.random() < dt * 20) W.burst(e.x, 0.2, e.z, 0xbfb6a6, 2, 2.5, 0.3);
      if (wall || e.dashLeft <= 1e-3) {
        W.stop(e.ent, 0.15);
        e.state = 'recover';
        e.atkCd = def.cd * G.rand(0.9, 1.2);
        if (wall) {
          // 一头撞上岩壁：晕一下，正是还手的时候
          e.stateT = 0.15;
          e.stagT = Math.max(e.stagT, 1.2);
          W.burst(e.x + e.laneDx * e.r, 1, e.z + e.laneDz * e.r, 0xd8c8b0, 14, 5, 0.4);
          W.shake(0.18);
          G.sfx('hit');
        } else e.stateT = 0.6;
      }
      return;
    }
    if (e.state === 'recover') {
      e.stateT -= dt;
      e.vis = Math.max(0, e.vis - dt * 1.4);
      if (e.stateT <= 0) {
        e.state = 'idle';
        e.vis = 0;
      }
      return;
    }
    if (dist <= GORE_REACH + 0.5 && !(e.goreCd > 0) && e.navDirect) {
      e.state = 'windup';
      e.gore = true;
      e.stateT = GORE_T;
      W.play(e.ent, 'windup', { dur: GORE_T });
      W.ring(e.x, e.z, e.r + 0.8, WARN_HEX, GORE_T / (e.slowK || 1));
      return;
    }
    if (e.atkCd <= 0 && dist >= 3.2 && dist <= def.range && e.navDirect && W.inView(e.x, e.z)) {
      const a = angTo(e, P.x, P.z), len = Math.min(13, dist + 4), w = 2 * (e.r + 0.45);
      e.ang = a;
      e.laneDx = Math.sin(a);
      e.laneDz = Math.cos(a);
      e.laneLen = len;
      e.state = 'windup';
      e.gore = false;
      e.stateT = def.windup;
      W.play(e.ent, 'windup', { dur: def.windup });
      G.telegraph({
        shape: 'rect', x: e.x + e.laneDx * len * 0.5, z: e.z + e.laneDz * len * 0.5, len, w, ang: a, dur: def.windup,
        dmg: 0, dtype: 'phys', owner: e, cancelIfOwnerDead: true, friendly: false,
      });
      return;
    }
    if (dist > def.range * 0.7 || !e.navDirect) chase(e, P, spd, dt);
    else if (dist > GORE_REACH + 0.3) chase(e, P, spd * 0.45, dt);
    else turn(e, angTo(e, P.x, P.z), 8, dt);
  }

  const MOB_AI = { melee: aiMelee, slam: aiSlam, ranged: aiRanged, bomb: aiBomb, blink: aiBlink, charge: aiCharge };

  // ---------- 首领招式 ----------
  // 弹幕类招式出手前的蓄力提示
  function cue(e, dur) {
    const W = G.world, hex = hexOf(e);
    W.ring(e.x, e.z, e.r + 1.4, hex, dur);
    W.burst(e.x, e.height * 0.6, e.z, hex, 10, 3, dur);
  }
  // 只数已经醒着、在首领附近的小怪：隔壁空地里还在沉睡的怪群不该挡住召唤
  function nearbyMobCount(e) {
    let n = 0;
    for (const o of G.state.enemies) {
      if (!o.isBoss && !o.dead && o.awake && Math.hypot(o.x - e.x, o.z - e.z) < 30) n++;
    }
    return n;
  }
  function summonSpots(e, count) {
    const W = G.world, spots = [], base = Math.random() * TAU;
    for (let k = 0; k < count; k++) {
      for (let tries = 0; tries < 10; tries++) {
        const a = base + (k * TAU) / count + tries * 0.7, d = e.r + G.rand(1.8, 3.4);
        const x = e.x + Math.sin(a) * d, z = e.z + Math.cos(a) * d;
        if (!W.walkable(x, z, 1) || !spaced(spots, x, z, 1.6)) continue;
        if (Math.hypot(x - G.player.x, z - G.player.z) < 2) continue; // 不直接刷在玩家脚下
        spots.push({ x, z });
        break;
      }
    }
    return spots;
  }

  // 引力井把玩家往 (x, z) 拽：越靠近井心拽得越狠；翻滚时只剩四成；处决途中不动
  function pullPlayer(x, z, R, dt) {
    const P = G.player, W = G.world;
    if (P.dead || P.exec) return;
    const dx = x - P.x, dz = z - P.z, d = Math.hypot(dx, dz);
    if (d >= R || d < 0.25) return;
    let v = 3.4 * (0.55 + 0.45 * (1 - d / R));
    if (P.roll && P.roll.t > 0) v *= 0.4;
    const m = Math.min(d - 0.2, v * dt), nx = P.x + (dx / d) * m, nz = P.z + (dz / d) * m;
    if (W.walkable(nx, nz, 0.5)) {
      P.x = nx;
      P.z = nz;
    }
  }

  const PATTERNS = {
    // 砸地：预警圈落在朝玩家方向最多 5 远处
    slam(e, P, dist) {
      const W = G.world, seq = e.seq, hex = hexOf(e);
      const a = angTo(e, P.x, P.z), d = Math.min(dist, 5);
      const x = e.x + Math.sin(a) * d, z = e.z + Math.cos(a) * d;
      e.aim = a;
      e.busy = 1.2;
      G.telegraph({
        shape: 'circle', x, z, r: 4.6, dur: 0.95, dmg: e.dmg * 1.5, dtype: 'phys',
        owner: e, cancelIfOwnerDead: true, friendly: false,
        onFire() {
          if (!live(e, seq)) return;
          W.burst(x, 0.4, z, 0xd8c8b0, 24, 7, 0.5);
          W.ring(x, z, 4.6, hex, 0.35);
          W.shake(0.5);
          G.sfx('hit');
        },
      });
    },
    // 冲锋：矩形预警结算后，首领沿预警方向冲刺，撞墙即停（冲刺本身不再造成伤害）
    charge(e, P) {
      const seq = e.seq, a = angTo(e, P.x, P.z), dx = Math.sin(a), dz = Math.cos(a);
      e.aim = a;
      e.busy = 1.5;
      G.telegraph({
        shape: 'rect', x: e.x + dx * 8, z: e.z + dz * 8, len: 16, w: 3.4, ang: a, dur: 0.75,
        dmg: e.dmg * 1.4, dtype: 'phys', owner: e, cancelIfOwnerDead: true, friendly: false,
        onFire() {
          if (!live(e, seq)) return;
          e.dash = { dx, dz, t: 0.25, speed: 16 / 0.25 };
          G.world.shake(0.35);
          G.sfx('hit');
        },
      });
    },
    // 环形弹幕
    ring(e, P) {
      const seq = e.seq, n = e.enraged ? 18 : 12;
      e.aim = angTo(e, P.x, P.z);
      e.busy = 0.7;
      cue(e, 0.45);
      G.after(0.45, () => {
        if (!live(e, seq)) return;
        const off = Math.random() * TAU, volley = volleySeq++;
        for (let i = 0; i < n; i++) shoot(e, off + (i * TAU) / n, 8.5, e.dmg * 0.8, 0.4, 3.2, e.r * 0.6, volley);
        G.world.ring(e.x, e.z, e.r + 1.6, hexOf(e), 0.3);
        G.sfx('cast');
      });
    },
    // 三连扇形弹幕，每轮重新瞄准
    fan(e, P) {
      const seq = e.seq;
      e.aim = angTo(e, P.x, P.z);
      e.busy = 1.3;
      cue(e, 0.4);
      for (let v = 0; v < 3; v++) {
        G.after(0.4 + v * 0.35, () => {
          if (!live(e, seq)) return;
          const a = angTo(e, G.player.x, G.player.z), volley = volleySeq++;
          e.aim = a;
          for (let i = -2; i <= 2; i++) shoot(e, a + i * 0.2, 12, e.dmg * 0.8, 0.38, 2.6, e.r * 0.6, volley);
          G.sfx('cast');
        });
      }
    },
    // 落点轰炸：第一发正对玩家，其余在玩家周围随机散布
    barrage(e, P) {
      const W = G.world, seq = e.seq, hex = hexOf(e), n = e.enraged ? 10 : 7;
      e.aim = angTo(e, P.x, P.z);
      e.busy = 1.4;
      cue(e, 0.3);
      const drop = (i) => {
        if (!live(e, seq)) return;
        const p = G.player, a = Math.random() * TAU, d = i === 0 ? 0 : Math.sqrt(Math.random()) * 6;
        const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
        const meteor = W.meteorFall(x, z, 0.85, hex, true);
        G.telegraph({
          shape: 'circle', x, z, r: 2.7, dur: 0.85, dmg: e.dmg * 1.1, dtype: e.elem,
          owner: e, cancelIfOwnerDead: true, friendly: false, meteor, // 预警被取消时落石一起消失
          onFire() {
            if (G.state.zone !== e.zone) return;
            W.burst(x, 0.3, z, hex, 12, 5, 0.4);
          },
        });
      };
      drop(0);
      for (let i = 1; i < n; i++) G.after(i * 0.16, () => drop(i));
    },
    // 召唤：先在落点亮出标记，半秒后小怪出现
    summon(e) {
      const W = G.world, seq = e.seq, hex = hexOf(e), spots = summonSpots(e, 3);
      e.aim = e.ang;
      e.busy = 0.8;
      cue(e, 0.5);
      for (const s of spots) W.ring(s.x, s.z, 1.3, hex, 0.5);
      G.after(0.5, () => {
        if (!live(e, seq)) return;
        for (const s of spots) {
          const m = G.spawnMob(G.pick(e.zone.def.mobs), s.x, s.z, e.zone.level, { elite: false, pack: null, awake: true });
          m.summoned = true; // 玩家重生时直接移除
          m.atkCd = 0.9; // 落地后不会立刻出手
          W.burst(s.x, 1, s.z, hex, 12, 4, 0.4);
        }
        G.sfx('boss');
      });
    },
    // 螺旋弹幕
    spiral(e, P) {
      const seq = e.seq, base = angTo(e, P.x, P.z), dir = Math.random() < 0.5 ? 1 : -1;
      e.aim = base;
      e.busy = 1.9;
      cue(e, 0.25);
      for (let i = 0; i < 24; i++) {
        G.after(0.25 + i * 0.07, () => {
          if (!live(e, seq)) return;
          const a = base + dir * i * 0.55;
          e.aim = a;
          shoot(e, a, 9, e.dmg * 0.7, 0.36, 3, e.r * 0.6);
        });
      }
    },
    // 十字裂隙：先放一组十字，0.6 秒后再放一组转 45° 的
    cross(e) {
      const W = G.world, seq = e.seq, hex = hexOf(e), x = e.x, z = e.z;
      const base = Math.random() * Math.PI * 0.5;
      e.aim = e.ang;
      e.busy = 1.7;
      cue(e, 0.4);
      const lay = (off) => {
        for (let k = 0; k < 2; k++) {
          const ang = base + off + (k * Math.PI) / 2, sx = Math.sin(ang), cz = Math.cos(ang);
          G.telegraph({
            shape: 'rect', x, z, len: 30, w: 2.8, ang, dur: 0.9, dmg: e.dmg * 1.3, dtype: e.elem,
            owner: e, cancelIfOwnerDead: true, friendly: false,
            onFire() {
              if (!live(e, seq)) return;
              const pts = [];
              for (let i = -3; i <= 3; i++) pts.push({ x: x + sx * i * 5, z: z + cz * i * 5 });
              W.bolt(pts, hex);
              if (k === 0) {
                W.shake(0.3);
                G.sfx('hit');
              }
            },
          });
        }
      };
      lay(0);
      G.after(0.6, () => {
        if (live(e, seq)) lay(Math.PI / 4);
      });
    },
    // ----- 衔星巨兽的三种新招式 -----
    // 流星犁地：几道落点从首领脚下沿直线朝外一路推进（像犁过地面），每道线对同一个目标只打一次；狂暴时 5 道
    starfall(e, P) {
      const W = G.world, seq = e.seq, hex = hexOf(e), x0 = e.x, z0 = e.z;
      const WIND = 0.7, FUSE = 0.55, GAP = 0.085, STEP = 2.1, R = 1.35;
      const n = e.enraged ? 5 : 3, spread = e.enraged ? 0.36 : 0.5, base = angTo(e, P.x, P.z);
      e.aim = base;
      let maxK = 0;
      for (let l = 0; l < n; l++) {
        const a = base + (l - (n - 1) / 2) * spread, sx = Math.sin(a), sz = Math.cos(a), once = mkOnce();
        for (let k = 0; k < 14; k++) {
          const d = e.r + 1.4 + k * STEP, x = x0 + sx * d, z = z0 + sz * d;
          if (!G.world.walkable(x, z, 0)) break;
          maxK = Math.max(maxK, k);
          G.after(Math.max(0, WIND - FUSE + k * GAP), () => {
            if (!live(e, seq)) return;
            G.telegraph({
              shape: 'circle', x, z, r: R, dur: FUSE, dmg: 0, dtype: e.elem, owner: e, cancelIfOwnerDead: true, friendly: false,
              onFire() {
                if (!live(e, seq)) return;
                zap(e, x, z, R, e.dmg * 1.05, e.elem, once);
                if (W.riftStrike) W.riftStrike(x, z, R, hex, k === 0);
                else W.burst(x, 0.4, z, hex, 10, 5, 0.35);
                if (k === 0 && l === 0) {
                  W.shake(0.3);
                  G.sfx('hit');
                }
              },
            });
          });
        }
      }
      e.busy = WIND + maxK * GAP + 0.6;
      cue(e, WIND);
    },
    // 坍缩：玩家脚下张开一口引力井，半径 7 以内的人被往井心拽（翻滚时拽得轻）；到点内爆，井心 2.8 以内重创。
    // 狂暴时内爆再向外炸出一圈星屑弹
    gravity(e, P) {
      const W = G.world, seq = e.seq, hex = hexOf(e);
      const WIND = 0.6, PULL = e.enraged ? 1.8 : 1.6, R = 7, CORE = 2.8;
      e.aim = angTo(e, P.x, P.z);
      e.busy = WIND + PULL + 0.45;
      cue(e, WIND);
      G.after(WIND, () => {
        if (!live(e, seq)) return;
        const x = P.x, z = P.z, once = mkOnce();
        let t = 0;
        G.telegraph({ shape: 'circle', x, z, r: CORE, dur: PULL, dmg: 0, dtype: e.elem, owner: e, cancelIfOwnerDead: true, friendly: false });
        addHazard({
          e, seq,
          update(dt) {
            t += dt;
            pullPlayer(x, z, R, dt);
            if (W.riftWell) W.riftWell(x, z, R, CORE, hex, Math.min(1, t / PULL), dt);
            if (t < PULL) return true;
            zap(e, x, z, CORE, e.dmg * 1.8, e.elem, once);
            if (W.riftWell) W.riftWell(x, z, R, CORE, hex, -1, 0);
            else W.burst(x, 0.6, z, hex, 30, 8, 0.5);
            W.shake(0.45);
            G.sfx('hit');
            if (e.enraged) {
              const volley = volleySeq++, off = Math.random() * TAU;
              for (let i = 0; i < 10; i++) {
                const a = off + (i * TAU) / 10;
                G.spawnProjectile({
                  owner: 'e', x: x + Math.sin(a) * 0.8, z: z + Math.cos(a) * 0.8, dx: Math.sin(a), dz: Math.cos(a), speed: 7.5, r: 0.38, life: 2.4,
                  color: hex, dmg: e.dmg * 0.7, dtype: e.elem, volley, vk: BOSS_SHOT[e.bossKind],
                });
              }
            }
            return false;
          },
          end() {
            if (W.riftWell) W.riftWell(x, z, R, CORE, hex, -2, 0);
          },
        });
      });
      return PULL;
    },
    // 衔星吐息：先亮出射线的起始方向，然后口中射线横扫约 110°（起点偏在玩家一侧，躲法是绕到起始线后面或者翻滚穿过去）；
    // 狂暴时扫过去再扫回来
    sweep(e, P) {
      const W = G.world, seq = e.seq, hex = hexOf(e);
      const WIND = 0.9, LEN = 24, HW = 1.1, ARC = 1.9, SW = e.enraged ? 2.3 : 1.6;
      const side = Math.random() < 0.5 ? 1 : -1, a0 = angTo(e, P.x, P.z) - side * ARC * 0.4;
      const mouth = (a, o) => {
        o.x = e.x + Math.sin(a) * e.r * 1.1;
        o.z = e.z + Math.cos(a) * e.r * 1.1;
        return o;
      };
      const o = mouth(a0, { x: 0, z: 0 });
      e.aim = a0;
      e.busy = WIND + SW + 0.45;
      G.telegraph({
        shape: 'rect', x: o.x + Math.sin(a0) * LEN * 0.5, z: o.z + Math.cos(a0) * LEN * 0.5, len: LEN, w: HW * 2, ang: a0, dur: WIND,
        dmg: 0, dtype: e.elem, owner: e, cancelIfOwnerDead: true, friendly: false,
      });
      G.after(WIND, () => {
        if (!live(e, seq)) return;
        const lane = G.telegraph({
          shape: 'rect', x: o.x + Math.sin(a0) * LEN * 0.5, z: o.z + Math.cos(a0) * LEN * 0.5, len: LEN, w: HW * 2, ang: a0, dur: SW + 0.1,
          dmg: 0, dtype: e.elem, owner: e, cancelIfOwnerDead: true, friendly: false,
        });
        const mHit = new Map();
        let t = 0, hitT = -9;
        addHazard({
          e, seq,
          update(dt) {
            t += dt;
            const k = Math.min(1, t / SW), sm = (v) => v * v * (3 - 2 * v);
            const u = e.enraged ? (k < 0.5 ? sm(k / 0.5) : 1 - sm((k - 0.5) / 0.5)) : sm(k);
            const a = a0 + side * ARC * u, sx = Math.sin(a), sz = Math.cos(a);
            e.aim = e.ang = a;
            mouth(a, o);
            const ex = o.x + sx * LEN, ez = o.z + sz * LEN;
            lane.x = o.x + sx * LEN * 0.5;
            lane.z = o.z + sz * LEN * 0.5;
            lane.ang = a;
            if (lane.handle && lane.handle.mesh) {
              lane.handle.mesh.position.x = lane.x;
              lane.handle.mesh.position.z = lane.z;
              lane.handle.mesh.rotation.y = a;
            }
            if (W.riftBeam) W.riftBeam(o.x, o.z, ex, ez, hex, 1);
            const Pl = G.player;
            if (t - hitT >= 0.45 && !Pl.dead && segDist(Pl.x, Pl.z, o.x, o.z, ex, ez) <= HW + PLAYER_R) {
              if (G.hurtPlayer(e.dmg * 0.9, e.elem, e)) hitT = t;
            }
            const ms = G.state.minions;
            if (ms && G.hurtMinion) {
              for (let j = ms.length - 1; j >= 0; j--) {
                const m = ms[j];
                if (!m || m.dead || t - (mHit.has(m) ? mHit.get(m) : -9) < 0.45) continue;
                if (segDist(m.x, m.z, o.x, o.z, ex, ez) <= HW + (m.r || 0.5)) {
                  G.hurtMinion(m, e.dmg * 0.9 * (G.BOSS_VS_MINION || 1.6), e.elem, e);
                  mHit.set(m, t);
                }
              }
            }
            return t < SW;
          },
          end() {
            if (W.riftBeam) W.riftBeam(0, 0, 0, 0, hex, 0);
          },
        });
      });
      return SW;
    },
  };

  // 各招式从起手到出手的秒数（和上面预警 / 延时的数值对应），以及之后追加出手的时刻
  const PATTERN_WIND = { slam: 0.95, charge: 0.75, ring: 0.45, fan: 0.4, barrage: 0.3, summon: 0.5, spiral: 0.25, cross: 0.9, starfall: 0.7, gravity: 0.6, sweep: 0.9 };
  const PATTERN_HITS = { fan: [0, 0.35, 0.7], cross: [0, 0.6] };
  function startPattern(e, P, dist) {
    const pats = e.def.patterns;
    const canSummon = nearbyMobCount(e) < 6;
    let opts = pats.filter(
      (p) => p !== e.lastPattern && (p !== 'summon' || canSummon) && (p !== 'slam' || dist <= 10.5)
    );
    if (!opts.length) opts = pats.filter((p) => p !== e.lastPattern && p !== 'summon');
    if (!opts.length) opts = pats;
    const p = G.pick(opts);
    e.lastPattern = p;
    const hold = PATTERNS[p](e, P, dist); // 返回值：持续型招式在出手之后还要持续多久（出手动作跟着拉长）
    // 动作：先摆蓄力姿势，出手动作提前「命中帧之前的那一小段」开始播，
    // 这样锤子落地 / 弹幕离手正好对在预警结算（伤害生效）的那一刻；多段的招式每一段都出手一次
    const W = G.world, seq = e.seq, wind = PATTERN_WIND[p];
    const lead0 = W.clipLead(e.ent, p);
    W.play(e.ent, p + '_w', { dur: Math.max(0.1, wind - lead0) });
    for (const at of PATTERN_HITS[p] || [0]) {
      const lead = Math.min(lead0, wind + at);
      const opts = { contact: Math.max(lead, 0.001) };
      if (p === 'spiral') opts.dur = 1.8 + lead;
      else if (p === 'barrage') opts.dur = 1.1 + lead;
      else if (hold > 0) opts.dur = hold + lead;
      G.after(wind + at - lead, () => {
        if (live(e, seq)) W.play(e.ent, p, opts);
      });
    }
  }

  function updateBoss(e, dt, P, dist, spd) {
    const W = G.world;
    if (!e.enraged && e.hp < e.maxHp * 0.4) {
      e.enraged = true;
      W.ring(e.x, e.z, e.r + 4, 0xff3a2a, 0.6);
      W.text(e.x, e.z, '狂暴', '#ff5040', 26);
      W.shake(0.4);
      G.sfx('boss');
    }
    if (e.dash) {
      // 冲刺：分小步推进，下一步不可走就停
      const d = e.dash, pad = e.r * 0.8;
      let remain = d.speed * Math.min(dt, d.t);
      d.t -= dt;
      while (remain > 1e-6) {
        const m = Math.min(0.4, remain);
        if (!W.walkable(e.x + d.dx * m, e.z + d.dz * m, pad)) {
          d.t = 0;
          break;
        }
        e.x += d.dx * m;
        e.z += d.dz * m;
        remain -= m;
      }
      if (d.t <= 0) {
        e.dash = null;
        W.burst(e.x, 0.4, e.z, 0xd8c8b0, 16, 6, 0.4);
      }
    }
    // 冰缓（重度冰缓 50%）：招式之间的停顿和收招一起拉长
    const sk = e.slowK > 0 ? e.slowK : 1;
    if (e.busy > 0) {
      e.busy -= dt * sk;
      turn(e, e.aim, 12, dt);
      return;
    }
    if (dist > 5) chase(e, P, spd, dt);
    else turn(e, angTo(e, P.x, P.z), 6, dt);
    e.cd -= dt * sk;
    if (e.cd <= 0 && dist <= 26 && !e.dash) {
      e.cd = e.enraged ? 0.6 : 1.0; // busy 结束后才继续倒数，所以这是招式之间的停顿
      startPattern(e, P, dist);
    }
  }

  // ---------- 打断、击破、恢复 ----------

  // 重击打断普通小怪：正在起手 / 点引信的作废（预警圈一并取消），并踉跄 dur 秒。返回是否真的打断了一次出手
  G.interruptEnemy = function (e, dur) {
    if (!e || e.dead || e.isBoss || e.elite || e.def.sturdy) return false;
    let cut = false;
    if (e.state === 'dash') {
      // 陨角兽冲到一半被重击：冲锋就此停下
      e.state = 'recover';
      e.stateT = 0.3;
      e.atkCd = Math.max(e.atkCd, e.def.cd * 0.6);
      G.world.stop(e.ent);
      cut = true;
    }
    if (e.state === 'windup' || e.state === 'fuse') {
      // 起手已经走完大半：收不住了，这一下照常打出来（要打断就得趁早）
      if (e.stateT < e.def.windup * COMMIT) return false;
      G.cancelTelegraphs(e);
      e.state = 'idle';
      e.stateT = 0;
      e.vis = 0;
      e.fan = e.gore = false;
      e.atkCd = Math.max(e.atkCd, G.rand(0.35, 0.6));
      G.world.stop(e.ent);
      cut = true;
    }
    e.stagT = Math.max(e.stagT, dur || 0.3);
    return cut;
  };

  // 架势打空：停下手上的一切（预警圈、还没放出去的弹幕 / 召唤都作废），进入破绽——不行动、易伤、可被处决
  G.breakEnemy = function (e) {
    if (!e || e.dead || !(e.poiseMax > 0) || e.brokenT > 0) return false;
    const W = G.world, PO = G.POISE, h = e.height || 2;
    e.poise = 0;
    e.brokenMax = e.brokenT = e.isBoss ? PO.brokenBoss : PO.brokenElite;
    e.breaks++;
    e.executed = false;
    e.execLock = false;
    e.seq++; // 挂起的延时回调（后续弹幕、落点、召唤、出手动作）全部失效
    G.cancelTelegraphs(e);
    e.state = 'idle';
    e.stateT = 0;
    e.vis = 0;
    e.fan = e.gore = false;
    e.stunT = e.freeze = e.stagT = 0;
    e.bindT = e.bindLeft = 0; // 破绽中不再被缚住、不被拽（留在原地给你处决）
    e.stunAnim = false;
    if (e.isBoss) {
      e.busy = 0;
      e.dash = null;
      e.cd = 1;
    } else e.atkCd = Math.max(e.atkCd, 0.8);
    W.play(e.ent, 'broken', { loop: true });
    W.flash(e.ent, 3);
    // 「破绽」二字弹在处决提示（头顶那块 F 牌）的上方，两者不互相遮挡
    W.text(e.x, e.z, '破绽', '#fff0c0', e.isBoss ? 32 : 26, { kind: 'tag', y: Math.min(3.6, h * (e.elite ? 1.3 : 1)) + 0.5, py: e.isBoss ? -52 : -78 });
    W.ring(e.x, e.z, e.r + 2.8, 0xfff0c0, 0.45);
    W.ring(e.x, e.z, e.r + 1.4, 0xffffff, 0.25);
    W.burst(e.x, h * 0.6, e.z, 0xfff0c0, 28, 7, 0.55);
    W.shake(e.isBoss ? 0.55 : 0.4);
    W.fovKick(1.6);
    G.hitStop(90);
    G.sfx('break');
    G.state.stats.breaks++;
    return true;
  };

  // 破绽结束：重新站稳，架势回满；首领每被击破一次，架势上限就高一截
  function recover(e) {
    const PO = G.POISE;
    e.brokenT = 0;
    e.executed = false;
    e.execLock = false;
    if (e.isBoss) e.poiseMax = Math.min(e.poiseBase * PO.bossGrowMax, e.poiseMax + e.poiseBase * PO.bossGrow);
    e.poise = e.poiseMax;
    e.poiseT = 0;
    if (e.isBoss) {
      e.cd = 0.9;
      e.busy = 0;
    } else e.atkCd = Math.max(e.atkCd, 0.5);
    G.world.stop(e.ent, 0.3);
    G.world.ring(e.x, e.z, e.r + 1.6, hexOf(e), 0.4);
  }

  // ---------- 互相推开 ----------
  function pushWeight(e) {
    if (e.isBoss) return 0;
    if (e.brokenT > 0) return 0; // 破绽中钉在原地（处决的落点才对得上）
    if (e.state === 'windup' || e.state === 'fuse' || e.state === 'dash' || e.state === 'blink') return 0; // 出手中不被挤动，预警位置才对得上
    if (e.freeze > 0 || e.stunT > 0) return 0.2;
    return 1;
  }
  function separate(act, dt, P) {
    const k = Math.min(1, 9 * dt);
    for (let i = 0; i < act.length; i++) {
      const a = act[i], wa = pushWeight(a);
      for (let j = i + 1; j < act.length; j++) {
        const b = act[j];
        const min = (a.r + b.r) * 0.95;
        let dx = b.x - a.x, dz = b.z - a.z;
        if (Math.abs(dx) >= min || Math.abs(dz) >= min) continue;
        let d = Math.hypot(dx, dz);
        if (d >= min) continue;
        const wb = pushWeight(b), sum = wa + wb;
        if (sum <= 0) continue;
        const push = (min - d) * k;
        if (d < 1e-3) {
          const r = Math.random() * TAU;
          dx = Math.sin(r);
          dz = Math.cos(r);
          d = 1;
        }
        const ux = dx / d, uz = dz / d;
        if (wa > 0) tryMove(a, (-ux * push * wa) / sum, (-uz * push * wa) / sum);
        if (wb > 0) tryMove(b, (ux * push * wb) / sum, (uz * push * wb) / sum);
      }
      // 小怪不叠在玩家身上
      if (wa >= 1 && !P.dead) {
        const dx = a.x - P.x, dz = a.z - P.z, d = Math.hypot(dx, dz), min = a.r + PLAYER_R;
        if (d < min && d > 1e-3) tryMove(a, (dx / d) * (min - d) * k, (dz / d) * (min - d) * k);
      }
    }
  }

  // ---------- 每帧更新 ----------
  const near = [], active = [];
  // 冰缓的显示档位（W.chill）：0 没有；轻度冰缓按冰霜异常值分三档；首领的重度冰缓是最高档；冻着的交给冻结的冰色
  function chillBand(e) {
    if (e.freeze > 0 || !e.bu) return 0;
    if (e.bossChill > 0) return 3;
    const c = e.bu.cold;
    return c > 0 ? (c < 0.34 ? 1 : c < 0.67 ? 2 : 3) : 0;
  }

  G.updateEnemies = function (dt) {
    const S = G.state, P = G.player, W = G.world, list = S.enemies, zone = S.zone;
    near.length = 0;
    active.length = 0;
    const bossNear = Math.hypot(P.x - zone.bossPos.x, P.z - zone.bossPos.z) < zone.bossR - 1;
    if (hazards.length) updateHazards(dt);

    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.dead) {
        // 死亡收缩，结束后移除
        e.deathT -= dt;
        if (e.deathT <= 0) {
          W.removeEnt(e.ent);
          list.splice(i, 1);
        } else {
          W.setEntScale(e.ent, G.clamp(e.deathT / DEATH_T, 0.02, 1));
        }
        continue;
      }
      const dist = Math.hypot(P.x - e.x, P.z - e.z);
      if (dist > SKIP_DIST) continue;

      if (!e.awake && !P.dead) {
        if (e.isBoss) {
          if (bossNear) e.awake = true;
        } else if (dist < WAKE_DIST && !(G.player.graceT > 0)) wakePack(e); // 刚重生的几秒内不会被就近的怪发现
      }
      if (e.awake && !e.wasAwake) onWake(e);

      // 元素异常值：回落、感电 / 重度冰缓倒计时；slow 是冰缓的减速比例（移动和出手节奏一起放慢）
      const slow = G.tickBuildUp(e, dt);
      e.slowK = 1 - slow;
      if (e.isBoss) e.freeze = e.stunT = e.stagT = e.bindT = 0; // 首领免疫冻结、眩晕与踉跄（渊缚对首领只减速）
      // 架势：破绽倒计时（被处决途中不走）；平时几秒不挨打后回复
      if (e.poiseMax > 0) {
        if (e.poiseHit > 0) e.poiseHit -= dt;
        if (e.brokenT > 0) {
          if (!e.execLock) {
            e.brokenT -= dt;
            if (e.brokenT <= 0) recover(e);
          }
        } else if (e.poiseT > 0) e.poiseT -= dt;
        else if (e.poise < e.poiseMax) e.poise = Math.min(e.poiseMax, e.poise + e.poiseMax * G.POISE.regen * dt);
      }
      const held = e.freeze > 0 || e.stunT > 0 || e.stagT > 0 || e.brokenT > 0 || e.bindT > 0; // 渊缚：定身，和冻结一样暂停 AI
      if (e.freeze > 0) e.freeze -= dt;
      if (e.stunT > 0) e.stunT -= dt;
      if (e.stagT > 0) e.stagT -= dt;
      const iced = e.freeze > 0;
      if (iced !== e.iced) {
        e.iced = iced;
        W.frost(e.ent, iced); // 冻住时整个身子罩一层冰色
      }
      const spd = e.speed * e.slowK;

      // 击退：带着撞墙检测滑出去，速度按指数衰减
      if (e.kvx !== 0 || e.kvz !== 0) {
        if (!tryMove(e, e.kvx * dt, e.kvz * dt)) e.kvx = e.kvz = 0;
        const dr = Math.exp(-dt * G.KB_DECAY);
        e.kvx *= dr;
        e.kvz *= dr;
        if (Math.abs(e.kvx) + Math.abs(e.kvz) < 0.4) e.kvx = e.kvz = 0;
      }

      // 渊缚 / 渊陷的牵引（冻结中不拽，破绽中不拽；一次渊缚最多拽 bindPullMax 米，到目标点 0.6 米以内就停）
      if (e.bindT > 0 && e.bindLeft > 0 && !(e.freeze > 0) && !(e.brokenT > 0)) {
        const gap = Math.hypot(e.bindX - e.x, e.bindZ - e.z) - 0.6;
        if (gap > 0) e.bindLeft -= G.pullEnemy(e, e.bindX, e.bindZ, Math.min(gap, e.bindLeft, G.bindPullSpeed(e, G.BUILDUP.bindPull) * dt));
        else e.bindLeft = 0;
      }
      if (e.voidT > 0 && !e.isBoss && !(e.freeze > 0)) {
        const gap = Math.hypot(e.voidX - e.x, e.voidZ - e.z) - 0.6;
        if (gap > 0) G.pullEnemy(e, e.voidX, e.voidZ, Math.min(gap, G.bindPullSpeed(e, G.BUILDUP.voidPull) * dt));
      }
      const ox = e.x, oz = e.z; // 之后的位移才是它自己走的（被推开不算迈步）
      if (e.awake && !held && !P.dead) {
        // 攻击对象：玩家或附近的召唤物（被嘲讽时是守像）；AI 把它当成「玩家」来追、来打
        const tg = pickFoe(e, P, dt);
        const td = tg === P ? dist : Math.max(0, Math.hypot(tg.x - e.x, tg.z - e.z) - (tg.r - PLAYER_R)); // 按体型折算成「到玩家那么大的目标」的距离
        updateNav(e, tg, dt);
        if (e.isBoss) updateBoss(e, dt, tg, td, spd);
        else {
          // 冰缓：小怪的 AI 按它自己放慢了的时钟走——移动、出手间隔、起手 / 收招、冲锋一起变慢
          // （移动 = 速度 × 这个时钟，所以传原速；预警圈在 G.updateTelegraphs 里按同一个倍率走，动作在下面按同一个倍率播）
          const ldt = dt * e.slowK;
          if (e.atkCd > 0) e.atkCd -= ldt;
          MOB_AI[e.def.ai](e, ldt, tg, td, e.speed);
        }
      } else if (e.tauntT > 0) e.tauntT -= dt;
      e.moving = Math.hypot(e.x - ox, e.z - oz) > dt * 0.6;
      e.held = held;
      near.push(e);
      if (e.awake) active.push(e);
    }

    separate(active, dt, P);
    if (G.updateMinions) G.updateMinions(dt); // 召唤物在敌人之后更新：读到的是敌人这一帧的位置

    for (const e of near) {
      const s = Math.sin(e.ang), c = Math.cos(e.ang);
      W.setEnt(e.ent, e.x + s * e.vis, e.z + c * e.vis, e.ang);
      // 眩晕 / 被重击后的踉跄：播失衡动作；冻结：模型定格；破绽中的动作由 G.breakEnemy 播，这里不插手
      const stunned = (e.stunT > 0 || e.stagT > 0.1) && !(e.freeze > 0) && !e.isBoss && !(e.brokenT > 0);
      if (stunned && !e.stunAnim) {
        e.stunAnim = true;
        W.play(e.ent, 'stagger');
      } else if (!stunned && e.stunAnim) {
        e.stunAnim = false;
        if (W.clipOf(e.ent) === 'stagger' && !(e.brokenT > 0)) W.stop(e.ent);
      }
      // 冰缓：动作跟着放慢（小怪和 AI 用同一个时钟，起手动作仍对得上出手；首领的招式按固定节奏和预警对齐，只在招式之外放慢）
      if (!(e.freeze > 0)) W.animEnt(e.ent, dt, e.moving, S.time, e.isBoss && e.busy > 0 ? 1 : e.slowK);
      W.chill(e.ent, chillBand(e), dt, e.r);
    }
  };

  // ---------- 重置与清空 ----------
  // 玩家重生：全部回到出生点并沉睡，首领回满血
  G.resetEnemies = function () {
    const W = G.world, list = G.state.enemies;
    clearHazards();
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.dead) continue; // 正在收缩的尸体交给 updateEnemies 收尾
      e.seq++;
      if (e.summoned) {
        e.dead = true;
        W.removeEnt(e.ent);
        list.splice(i, 1);
        continue;
      }
      e.x = e.home.x;
      e.z = e.home.z;
      e.ang = e.homeAng;
      e.awake = false;
      e.wasAwake = false;
      e.state = 'idle';
      e.stateT = 0;
      e.atkCd = 0;
      e.vis = 0;
      e.moving = false;
      e.held = false;
      e.navT = 0;
      e.navDirect = true;
      e.navWp = false;
      e.freeze = e.stunT = 0;
      e.slowK = 1;
      if (e.iced) W.frost(e.ent, false);
      e.iced = false;
      G.initBuildUp(e);
      e.stunAnim = false;
      e.kvx = e.kvz = e.stagT = 0;
      e.foe = e.taunter = null;
      e.foeT = e.tauntT = 0;
      e.poiseMax = e.poise = e.poiseBase;
      e.poiseT = e.poiseHit = e.brokenT = 0;
      e.breaks = 0;
      e.executed = e.execLock = false;
      e.fan = e.gore = false;
      e.blinkCd = G.rand(1.5, 3);
      e.goreCd = 0;
      W.stop(e.ent, 0);
      if (e.isBoss) {
        e.hp = e.maxHp;
        e.busy = 0;
        e.cd = 1;
        e.enraged = false;
        e.lastPattern = null;
        e.dash = null;
      }
      W.setEnt(e.ent, e.x, e.z, e.ang);
    }
  };

  G.clearEnemies = function () {
    const W = G.world, list = G.state.enemies;
    clearHazards();
    for (const e of list) {
      e.dead = true; // 让还挂着的延迟回调和预警圈全部失效
      e.seq++;
      W.removeEnt(e.ent);
    }
    list.length = 0;
    G.state.boss = null;
  };
})();
