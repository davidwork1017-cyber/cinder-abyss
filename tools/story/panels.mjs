// 开场故事每一格的摆拍：区域、角色站位 / 动作帧、镜头、分层。setup 在页面里执行（不能引用外部变量），
// 返回 { actors: [根节点…] }（setup 里把角色根节点挂在 window.__actors 上）。
// 镜头 cam：{ pos, at, fov, roll }（世界坐标，米）。layers：从后往前。
export const PANELS = {
  // 1 渊口：烬渊深处的崖路上往下看深渊，底下的熔岩缝一路延到雾里，余烬往上飘
  p1: {
    zone: 3,
    fog: [34, 120],
    // 深渊中线上往下打一条射线：打不到岩顶（深渊底是一张大平面，不在检测的网格里）或者打到崖下才算深渊建好了
    ready() {
      const rc = new THREE.Raycaster(new THREE.Vector3(-50, 20, -14), new THREE.Vector3(0, -1, 0), 0, 60);
      const ms = [];
      G.world.scene.traverseVisible((o) => { if (o.isMesh && !o.isInstancedMesh && o.geometry && o.geometry.attributes.position.count > 200) ms.push(o); });
      const h = rc.intersectObjects(ms, false)[0];
      return { ok: !h || h.point.y < -2, why: h ? 'hit y ' + h.point.y.toFixed(2) + ' n ' + ms.length : 'no hit, meshes ' + ms.length };
    },
    setup() {
      TT.clear();
      TT.tp(-45.7, -21.7, 0);
      TT.settle(60); // 地形 / 布景按玩家位置分块显隐：传送后先让世界更新一下
      G.player.ent.group.visible = false;
      if (G.player.ent.ring) G.player.ent.ring.visible = false;
      TT.tick(240); // 余烬口喷一轮、环境火星飘起来
      window.__actors = [];
    },
    cams: [
      { pos: [-35.7, 7, -21.7], at: [-57.7, -7, -8.7], fov: 50 },
      { pos: [-31, 9.5, -16], at: [-60, -7, -13], fov: 48 },
      { pos: [-38, 5, -26], at: [-56, -6, -10], fov: 55 },
    ],
    cam: 1,
    layers: [{ name: 'bg', mode: 'env', fx: false, hide: ['points'], split: 16, feather: 2, ink: { lineFar: 90 } }],
  },
  // 6 再起：灰烬荒原，主角单膝跪地、正要撑着长杖站起来，左手掌心的余烬亮起来；游魂从两边围上来
  p6: {
    zone: 0,
    fog: [24, 64],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      if (P.ent.ring) P.ent.ring.visible = false; // 脚下的闪避冷却环是玩法界面，画格里不要
      TT.tp(s.x, s.z - 2, 0.35);
      TT.settle(30);
      // 游魂从身后两侧围过来（主角面朝 +z 偏右，镜头在前方）：慢慢走近几步，定在迈步的那一刻
      const ring = [[-2.4, -2.6], [2.2, -3.3], [-4.0, -0.4], [3.9, -1.0]];
      for (const [dx, dz] of ring) {
        const e = TT.mob('husk', P.x + dx, P.z + dz, { move: true });
        e.speed = 1.3;
      }
      TT.tick(36);
      for (const e of G.state.enemies) e.speed = 0;
      // 单膝跪地、正要撑起来：左膝着地（靠镜头这一侧），右脚在前踩实；右手长杖斜着拄开，左手托着余烬伸在身前，抬头
      STORY_BAKE.pose(P.ent, 'storyRise', {
        'root.oy': -0.42, 'root.rx': 0.22, 'spine.rx': 0.15, 'chest.rx': -0.05, 'head.rx': -0.34, 'head.ry': 0.1,
        'thL.rx': 0.25, 'shL.rx': 1.95, 'ftL.rx': 0.5, 'thL.rz': 0.08,
        'thR.rx': -1.4, 'shR.rx': 1.35, 'ftR.rx': 0.05, 'thR.rz': -0.12,
        'uaR.rx': -0.35, 'uaR.rz': -0.35, 'faR.rx': -0.55, 'hR.rx': 0.4,
        'uaL.rx': -1.0, 'uaL.rz': 0.6, 'faL.rx': -0.9,
      });
      // 掌心余烬照亮脸和手（一盏小的暖光，只在烘焙时有）
      const em = STORY_BAKE.jointPos(P.ent, 'hL', [0, -0.06, 0.06]);
      const lt = new THREE.PointLight(0xff8a3a, 0.55, 2.2, 2);
      lt.position.copy(em);
      G.world.scene.add(lt);
      window.__tmp.push(lt);
      window.__actors = [P.ent.group].concat(G.state.enemies.filter((e) => !e.dead).map((e) => e.ent.group));
      window.__focus = [P.x, P.z];
      window.__points = { ember: em, feet: new THREE.Vector3(P.x, 0.05, P.z) };
    },
    // 镜头相对主角（rel）：低、近，3/4 正面
    cams: [{ rel: [2.6, 0.62, 1.55], at: [0, 0.8, 0], fov: 43, hide: ['points', 'normalfx'] }],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },

  // ---------- 2 落灰（一页三格）：灰烬荒原 / 霜骨沼泽 / 雷鸣遗迹 ----------
  // aspect：这一格在页面上的宽高比，烘焙时从整张渲染图正中裁出来
  p2a: {
    zone: 0, aspect: 4.6, fog: [30, 90],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      P.ent.group.visible = false;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(s.x, s.z, 0);
      TT.settle(30);
      window.__focus = [s.x, s.z];
    },
    cams: [
      { rel: [-6, 4.5, 8], at: [4, 0.5, -14], fov: 30 },
      { rel: [-6, 3.0, 6], at: [4, 1.0, -14], fov: 34 },
    ],
    cam: 0,
    layers: [{ name: 'bg', mode: 'env', fx: false, hide: ['points'], split: 14, feather: 2 }],
  },
  p2b: {
    zone: 1, aspect: 1.2, fog: [20, 60],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      P.ent.group.visible = false;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(-9, -36, 0); // 跟着主角走的暖光照着这一段
      TT.settle(30);
      window.__focus = [s.x, s.z];
    },
    // 巨兽的脊椎半沉在冰水里，肋骨拱过栈道（布局种子 1：脊椎从 (-6,-35) 到 (-16,-26)）
    cams: [
      { pos: [-4.2, 1.3, -42.5], at: [-14, 2.4, -29], fov: 46 },
      { pos: [-9.5, 0.7, -38.5], at: [-12.5, 3.0, -28], fov: 50 },
      { pos: [-1.5, 3.2, -44], at: [-13, 0.8, -30], fov: 44 },
    ],
    cam: 0,
    layers: [{ name: 'bg', mode: 'env', fx: false, hide: ['points'], split: 8, feather: 1.5 }],
  },
  p2c: {
    zone: 2, aspect: 1.2, fog: [26, 80],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      P.ent.group.visible = false;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(s.x, s.z, 0);
      TT.settle(30);
      TT.tp(-4, -31, 0); // 柱廊中间（布局种子 1：两排石柱从 (-13,-33) 到 (3,-30)，尽头是雷枢）
      TT.settle(30);
      TT.tick(120); // 机关转起来
      // 石柱之间站着一只游魂（画格的焦点，雷就劈在它身后）
      P.ent.group.visible = false;
      const e = TT.mob('husk', -3.2, -33.2, { face: -Math.PI / 2 });
      for (let i = 0; i < 40; i++) G.world.animEnt(e.ent, 1 / 60, true);
      window.__actors = [e.ent.group];
      window.__focus = [s.x, s.z];
    },
    cams: [
      { pos: [-12, 1.3, -26], at: [6, 3.0, -37], fov: 46 },
      { pos: [-14, 2.6, -34], at: [8, 2.4, -34], fov: 44 },
      { pos: [-3, 0.8, -22], at: [6, 3.5, -38], fov: 48 },
    ],
    cam: 1,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'], split: 12, feather: 2 },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
  // ---------- 3 游魂：雷鸣遗迹的老地方，几只游魂低着头慢慢走 ----------
  p3: {
    zone: 2, fog: [10, 40],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      P.ent.group.visible = false;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(6, -36, 0); // 主角藏在柱廊尽头：游魂在石柱之间朝那边慢慢挪
      TT.settle(30);
      const spots = [[-9, -31], [-6.5, -33.5], [-4, -29], [-2.5, -33], [-11.5, -28.5]];
      for (const [x, z] of spots) {
        const e = TT.mob('husk', x, z, { move: true });
        e.speed = 0.9;
      }
      TT.tick(50);
      for (const e of G.state.enemies) e.speed = 0;
      window.__actors = G.state.enemies.filter((e) => !e.dead).map((e) => e.ent.group);
      window.__focus = [s.x, s.z];
    },
    cams: [
      { pos: [-16, 1.0, -27], at: [-2, 1.4, -33], fov: 44, hide: ['points', 'normalfx'] },
      { pos: [-6, 0.9, -24], at: [-7, 1.5, -34], fov: 48, hide: ['points', 'normalfx'] },
    ],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
  // ---------- 4 熄烛者：余烛殿，高瘦的长袍身影举着提灯，身边的火盆刚灭，冒着烟 ----------
  p4: {
    pin: 2, fog: [18, 60], bosses: ['snuffer'],
    setup() {
      TT.clear();
      const P = G.player, A = G.PIN.arena, B = G.PIN.braziers;
      P.ent.group.visible = false;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(A.x, A.z + 14, Math.PI);
      TT.settle(30);
      // 四个火盆：两个灭、两个亮
      const bp = B.angs.map((a) => [A.x + B.r * Math.sin((a * Math.PI) / 180), A.z - B.r * Math.cos((a * Math.PI) / 180)]); // 和 world.js 的火盆摆法一致：从正北（−z）顺时针
      // 余烛殿的玩法每帧按 state.pin.lit 刷火盆：两边一起改
      if (G.state.pin) G.state.pin.lit = [1, 0, 1, 0];
      G.world.crownBraziers([1, 0, 1, 0], -1, 0);
      TT.settle(120); // 火苗是慢慢缩回去的（按帧插值），零时长的更新不会变
      const tgt = bp[1]; // 东南那个刚灭
      const bx = tgt[0] - 1.6, bz = tgt[1] - 1.0;
      const b = G.spawnBoss('snuffer', bx, bz, G.pinLevel(2), {});
      if (b) {
        b.x = bx; b.z = bz; b.awake = false;
        b.ang = Math.atan2(tgt[0] - bx, tgt[1] - bz);
        G.world.setEnt(b.ent, b.x, b.z, b.ang);
        G.world.play(b.ent, 'lift', { dur: 1.2, hold: true });
        for (let i = 0; i < 50; i++) G.world.animEnt(b.ent, 1 / 60, false);
      }
      window.__actors = b ? [b.ent.group] : [];
      window.__focus = [bx, bz];
      window.__points = { smoke: new THREE.Vector3(tgt[0], 1.4, tgt[1]), lit: new THREE.Vector3(bp[2][0], 1.4, bp[2][1]) };
    },
    cams: [
      { rel: [3.2, 0.9, 5.2], at: [0.4, 2.6, -0.4], fov: 44, hide: ['points', 'normalfx'] },
      { rel: [-2.6, 1.0, 5.8], at: [0.8, 2.4, 0], fov: 44, hide: ['points', 'normalfx'] },
      { rel: [5.5, 1.4, 1.5], at: [0, 2.2, 0], fov: 42, hide: ['points', 'normalfx'] },
    ],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
  // ---------- 5 余烬：主角的近景，左手掌心托着一点余烬，火光从下面照着脸 ----------
  p5: {
    zone: 0, fog: [5, 22],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(s.x + 3, s.z + 4, 0.6);
      TT.settle(30);
      // 低头看着伸在身前的左手（掌心托着余烬）；侧面看过去手和脸在暗处的天上连成一条线
      STORY_BAKE.pose(P.ent, 'storyEmber', {
        'head.rx': 0.45, 'head.ry': -0.3, 'chest.rx': 0.06, 'spine.rx': 0.05,
        'uaL.rx': -1.0, 'uaL.rz': 0.3, 'faL.rx': -1.0,
        'uaR.rx': -0.15, 'uaR.rz': -0.18, 'faR.rx': -0.35,
        'thR.rx': -0.08, 'thL.rx': 0.06,
      }, { base: 'rest' });
      const em = STORY_BAKE.jointPos(P.ent, 'hL', [0, -0.06, 0.06]);
      const lt = new THREE.PointLight(0xff8a3a, 0.9, 1.8, 2);
      lt.position.copy(em);
      G.world.scene.add(lt);
      window.__tmp.push(lt);
      window.__actors = [P.ent.group];
      window.__focus = [P.x, P.z];
      window.__points = { ember: em };
    },
    cams: [
      { rel: [1.651, 1.3, -0.581], at: [0.236, 1.35, 0.071], fov: 40, hide: ['points', 'normalfx'] }, // 主角左侧 75°
    ],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
  // 首领包（新模型）没有 taunt / call / howl：按格子退到一个蓄力的定格姿势（巨像举锤、霜织者举手、监察者双手交叉、烬渊之主举剑），0.6 s 播完、40 帧后停在收尾
  // ---------- 7 守关的（一页四格）：熔渣巨像 / 霜织者 / 雷霆监察者，下面一整条：拿着烬铸武器的主角对着烬渊之主 ----------
  p7a: {
    zone: 0, aspect: 1.05, fog: [16, 60], bosses: ['golem'],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      P.ent.group.visible = false;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(s.x, s.z + 10, Math.PI);
      TT.settle(30);
      const b = G.spawnBoss('golem', s.x, s.z - 2, 1, {});
      b.awake = false;
      b.ang = 0.25;
      G.world.setEnt(b.ent, b.x, b.z, b.ang);
      if (G.world.play(b.ent, 'taunt', { hold: true }) || G.world.play(b.ent, 'call', { hold: true }) || G.world.play(b.ent, 'howl', { hold: true }) || G.world.play(b.ent, 'slam_w', { hold: true, dur: 0.6 }));
      for (let i = 0; i < 40; i++) G.world.animEnt(b.ent, 1 / 60, false);
      window.__actors = [b.ent.group];
      window.__focus = [b.x, b.z];
    },
    cams: [
      { rel: [-3.6, 0.6, 9.0], at: [0, 2.7, 0], fov: 44, hide: ['points', 'normalfx'] },
    ],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
  p7b: {
    zone: 1, aspect: 1.05, fog: [16, 60], bosses: ['weaver'],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      P.ent.group.visible = false;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(s.x, s.z + 10, Math.PI);
      TT.settle(30);
      const b = G.spawnBoss('weaver', s.x, s.z - 2, 5, {});
      b.awake = false;
      b.ang = -0.2;
      G.world.setEnt(b.ent, b.x, b.z, b.ang);
      if (G.world.play(b.ent, 'taunt', { hold: true }) || G.world.play(b.ent, 'call', { hold: true }) || G.world.play(b.ent, 'barrage_w', { hold: true, dur: 0.6 }));
      for (let i = 0; i < 40; i++) G.world.animEnt(b.ent, 1 / 60, false);
      window.__actors = [b.ent.group];
      window.__focus = [b.x, b.z];
    },
    cams: [
      { rel: [-2.2, 0.7, 8.2], at: [0, 2.3, 0], fov: 44, hide: ['points', 'normalfx'] },
    ],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
  p7c: {
    zone: 2, aspect: 1.05, fog: [16, 60], bosses: ['warden'],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      P.ent.group.visible = false;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(s.x, s.z + 10, Math.PI);
      TT.settle(30);
      const b = G.spawnBoss('warden', s.x, s.z - 2, 9, {});
      b.awake = false;
      b.ang = 0.3;
      G.world.setEnt(b.ent, b.x, b.z, b.ang);
      if (G.world.play(b.ent, 'taunt', { hold: true }) || G.world.play(b.ent, 'call', { hold: true }) || G.world.play(b.ent, 'cross_w', { hold: true, dur: 0.6 }));
      for (let i = 0; i < 40; i++) G.world.animEnt(b.ent, 1 / 60, false);
      window.__actors = [b.ent.group];
      window.__focus = [b.x, b.z];
    },
    cams: [
      { rel: [2.2, 0.6, 8.8], at: [0, 2.8, 0], fov: 44, hide: ['points', 'normalfx'] },
    ],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
  p7d: {
    zone: 3, aspect: 3.1, fog: [18, 70], bosses: ['lord'],
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      if (P.ent.ring) P.ent.ring.visible = false;
      // 烬铸武器「烬断」（雷霆监察者掉的太刀）拿在手上
      const it = G.debug.giveItem(3, 'jinduan');
      if (it) G.equip(it);
      G.world.setPlayerGear(G.save.equip);
      TT.tp(s.x, s.z, Math.PI);
      TT.settle(30);
      const b = G.spawnBoss('lord', s.x - 0.5, s.z - 6.5, 13, {});
      b.awake = false;
      b.ang = 0;
      G.world.setEnt(b.ent, b.x, b.z, b.ang);
      if (G.world.play(b.ent, 'taunt', { hold: true }) || G.world.play(b.ent, 'call', { hold: true }) || G.world.play(b.ent, 'slam_w', { hold: true, dur: 0.6 }));
      for (let i = 0; i < 40; i++) G.world.animEnt(b.ent, 1 / 60, false);
      for (let i = 0; i < 30; i++) G.world.animEnt(P.ent, 1 / 60, false);
      window.__actors = [P.ent.group, b.ent.group];
      window.__focus = [s.x, s.z];
      window.__points = { blade: STORY_BAKE.jointPos(P.ent, 'hR') };
    },
    cams: [
      { rel: [1.8, 1.0, 3.8], at: [-0.5, 2.7, -6], fov: 46, hide: ['points', 'normalfx'] },
    ],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
  // ---------- 8 起点：灰烬荒原的起点，游戏自己的镜头（故事放完淡出到真正的游戏画面） ----------
  p8: {
    zone: 0,
    setup() {
      TT.clear();
      const P = G.player, s = G.state.zone.start;
      if (P.ent.ring) P.ent.ring.visible = false;
      TT.tp(s.x, s.z, Math.PI);
      for (let i = 0; i < 60; i++) G.world.animEnt(P.ent, 1 / 60, false);
      TT.settle(60);
      window.__actors = [P.ent.group];
      window.__focus = [s.x, s.z];
    },
    gamecam: true,
    cams: [{ hide: ['points', 'normalfx'] }],
    cam: 0,
    layers: [
      { name: 'bg', mode: 'env', fx: false, hide: ['points', 'normalfx'] },
      { name: 'actors', mode: 'actors', fx: false, hide: ['points', 'normalfx'] },
    ],
  },
};
