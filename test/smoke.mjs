// 端到端冒烟测试：无头 Chrome 里把整个游戏流程走一遍。
// 每一步打印一行 ok / FAIL；任何一步失败或页面出现报错，进程以非 0 退出。
import { launch } from './harness.mjs';

const SAVE_KEY = 'cinder-abyss-save-v1';
let G_CUR_N = 8, G_UQ_COLOR = '#ff9b3d', G_SOUL_INH = 1.5, G_SOUL_K = 0.2;
const G_USK = { jinduan: 'ashcuts', sanxiang: 'tristorm', wanhun: 'soulhost', rongxin: 'wildfire', jinyu: 'emberstorm' }; // 烬铸武器 → 它的烬铸技 // 烬铸步骤用到的数据（启动后从页面里读）
let browser, page, errors;
let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);
// 等游戏主循环实际跑过 n 帧（无头软件渲染很慢，不能按固定时间等）
const frames = (n) =>
  page.evaluate(
    (n) =>
      new Promise((res) => {
        let i = 0;
        const f = () => (++i > n ? res() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n
  );
const until = (fn, arg, timeout) => page.waitForFunction(fn, arg, { timeout: timeout || 45000 });

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    await sleep(30); // 给异步报错一点冒出来的时间
    if (errors && errors.length) throw new Error('页面报错：' + errors.splice(0).join(' | '));
    passed++;
    console.log('ok   ' + name + (info ? ' — ' + info : '') + '  (' + (Date.now() - t0) + 'ms)');
  } catch (e) {
    failed++;
    const extra = errors && errors.length ? ' ｜页面报错：' + errors.splice(0).join(' | ').slice(0, 600) : '';
    console.log('FAIL ' + name + ' — ' + String(e && e.message ? e.message : e).split('\n').slice(0, 6).join(' / ') + extra);
  }
}

// 页面内的测试小工具（每次加载页面后重新装一遍）
async function install() {
  await page.waitForFunction(() => window.G && G.debug && G.state && G.state.zone && G.player && G.player.ent, null, { timeout: 30000 });
  await ev(() => {
    const G = window.G, W = G.world, P = G.player, S = G.state;
    const T = (window.T = {
      // 键排序后的 JSON，用来比较存档
      canon(o) {
        const f = (v) =>
          Array.isArray(v) ? v.map(f) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((a, k) => ((a[k] = f(v[k])), a), {}) : v;
        return JSON.stringify(f(o));
      },
      tp(x, z) {
        P.x = x;
        P.z = z;
        P.cast = null;
        P.roll.t = 0;
        W.setEnt(P.ent, x, z, P.face);
      },
      // 只推进镜头与特效，不推进 AI
      settle() {
        for (let i = 0; i < 120; i++) W.update(1 / 60);
      },
      clearLoot() {
        for (const l of S.loot) W.removeMesh(l.mesh);
        S.loot.length = 0;
      },
      // 清空当前区域的敌人和杂物，玩家回到起点、满状态。
      // 手里换回同一把标准的刃（普通、物品等级 = 角色等级、平均成色、没有隐含属性）：攻击技能的伤害和出手速度跟着武器走，
      // 前面的背包步骤会随机换装甚至卸下武器，战斗步骤的数值得有个固定的起点
      arena() {
        G.clearMinions(); // 上一步召出来的召唤物不带进这一步
        for (const k in G.save.autoSummon || {}) G.save.autoSummon[k] = false; // 自动召唤也关掉，不然下一步一开始就补出来
        G.clearEnemies();
        G.respawn();
        T.clearLoot();
        P.iframe = 0;
        P.cds = {};
        const L = Math.max(1, G.save.level); // 物品等级跟着角色等级走：和改版前「攻击技能随宝石等级成长」的强度大致相当
        if (!T.std || T.std.ilvl !== L) T.std = T.stdBlade(L);
        G.save.equip.weapon = T.std;
        G.computeStats();
        P.life = P.maxLife;
        P.mana = P.maxMana;
        P.flask.life = P.flask.mana = 3;
        T.settle();
      },
      // 一只打不死、不会动的靶子
      // 从玩家出发、一路可走（两侧各留 1 米）最远的那个方向：{ x, z } 单位向量，len 是能走多远（最多 max 米）
      openDir(max) {
        let best = { x: 0, z: 1, len: 0 };
        for (let k = 0; k < 24; k++) {
          const a = (k * Math.PI) / 12, x = Math.sin(a), z = Math.cos(a);
          let d = 0.5;
          for (; d <= max; d += 0.5) if ([-1, 0, 1].some((o) => !W.walkable(P.x + x * d + z * o, P.z + z * d - x * o, 0.4))) break;
          if (d > best.len) best = { x, z, len: d };
        }
        return best;
      },
      dummy(dx, dz) {
        const e = G.spawnMob('brute', P.x + dx, P.z + dz, 1, { awake: true });
        e.hp = e.maxHp = 1e7;
        e.freeze = 1e9;
        T.d = e;
        return true;
      },
      scr(x, z) {
        const p = W.project(x, 0, z);
        return { x: p.x, y: p.y, ok: p.ok };
      },
      // 渲染一帧并统计画面亮度与颜色数（判断不是黑屏）
      frame() {
        W.render();
        const c = document.createElement('canvas');
        c.width = 144;
        c.height = 90;
        const g = c.getContext('2d');
        g.drawImage(document.getElementById('gl'), 0, 0, 144, 90);
        const d = g.getImageData(0, 0, 144, 90).data;
        let sum = 0;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4) {
          sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
          seen.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
        }
        return { mean: sum / (d.length / 4), colors: seen.size };
      },
      toasts() {
        return document.getElementById('toasts').textContent;
      },
      bodyText() {
        return document.getElementById('panel-body').innerText;
      },
      tab() {
        return document.getElementById('panel').classList.contains('on') ? document.getElementById('panel-body').dataset.tab : null;
      },
      introOpen() {
        return document.getElementById('intro').classList.contains('on');
      },
      rect(sel) {
        const n = typeof sel === 'string' ? document.querySelector(sel) : sel;
        if (!n) return null;
        const b = n.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2, l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
      },
      // 技能栏四格里的技能 id（空格为 ''）
      hudBar() {
        return Array.from(document.querySelectorAll('#slots .slot')).map((n) => n.dataset.skill).join(',');
      },
      // 某个掉落名牌上的一个点（名牌会互相避让，往上找）
      labelPt(l) {
        W.render();
        const p = W.project(l.x, 1.0, l.z);
        for (let dy = 30; dy < 420; dy += 6) {
          if (W.lootLabelAt(p.x, p.y - dy) === l) return { x: Math.round(p.x), y: Math.round(p.y - dy - 4) };
        }
        return null;
      },
      buildSnap() {
        const s = G.save;
        return JSON.stringify({ skills: s.skills, supports: s.supports, sockets: s.sockets, bar: s.bar, rmbKeep: s.rmbKeep || null });
      },
      buildRestore(json) {
        Object.assign(G.save, JSON.parse(json));
        G.computeStats();
        P.cds = {};
        P.cast = null;
      },
      // ---- 动作战斗的测试小工具 ----
      // 把随机数钉死（默认 0.5：不暴击、伤害取中值；0：必定暴击）
      fix(v) {
        if (!T._rand) T._rand = Math.random;
        const x = v === undefined ? 0.5 : v;
        Math.random = () => x;
      },
      unfix() {
        if (T._rand) {
          Math.random = T._rand;
          T._rand = null;
        }
      },
      // 一只醒着的靶子：默认打不死、不还手、站着不动（但可以被击退）
      mob(type, dx, dz, o) {
        o = o || {};
        const e = G.spawnMob(type, P.x + dx, P.z + dz, 1, { awake: true, elite: !!o.elite });
        e.wasAwake = true;
        e.hp = e.maxHp = o.hp || 1e6;
        e.atkCd = 1e9;
        e.speed = 0;
        return e;
      },
      aim(x, z) {
        G.input.mouse.wx = x;
        G.input.mouse.wz = z;
      },
      // 换上一把标准的刃（普通、平均成色、攻速 1），返回原来的武器；T.unblade(原武器) 换回去。
      // 攻击技能的出手速度和伤害跟着武器走：测节奏 / 数值的步骤先用它把武器固定下来
      blade(ilvl) {
        const old = G.save.equip.weapon;
        G.save.equip.weapon = T.stdBlade(ilvl);
        G.computeStats();
        return old;
      },
      stdBlade(ilvl) {
        const w = G.rollItem(ilvl || 1, 0, 'weapon', 0);
        w.wbase = G.weaponBaseDmg(0, ilvl || 1);
        w.imp = null;
        return G.refreshWeapon(w);
      },
      unblade(old) {
        if (old) G.save.equip.weapon = old;
        else delete G.save.equip.weapon;
        G.computeStats();
      },
      // 按住左键，推进到下一次连击命中帧为止；返回这一段的信息
      swing(target, max) {
        const out = { step: -1, clip: null, ticks: 0, stop: 0, fired: false };
        let seen = null;
        for (let i = 0; i < (max || 150); i++) {
          if (target) T.aim(target.x, target.z);
          G.input.mouse.b[0] = true;
          const c0 = P.cast, f0 = c0 ? c0.fired : false;
          G.tick(1 / 60);
          out.ticks++;
          const c = P.cast;
          if (c && c.st && !c.fired && seen !== c) {
            seen = c;
            out.clip = W.clipOf(P.ent);
            out.step = c.step;
          }
          if (c && c.st && c.fired && (c !== c0 || !f0)) {
            out.step = c.step;
            if (!out.clip) out.clip = W.clipOf(P.ent);
            out.stop = G.flow.stop;
            out.fired = true;
            break;
          }
        }
        G.input.mouse.b[0] = false;
        return out;
      },
      // 清场，并把玩家挪到起点空地的左侧：朝 +x 方向有一条 12 长的直线可用
      lane() {
        T.arena();
        const c = S.zone.circles[0];
        T.tp(c.x - 5, c.z);
        T.settle();
      },
      // 新手提示：全部标记为看过 / 清空
      hintsSeen() {
        for (const id of G.ui.hints().all) G.save.tut[id] = 1;
      },
    });
    T.hintsSeen(); // 情境提示按真实时间走，除了专门测它的那一步，其余步骤里都关掉
    G.debug.hold(true);
  });
}

// v2 界面的步骤：从「面板关着、模拟由测试推进」开始；结束时无论成败都把技能构筑（技能 / 辅助 / 镶嵌 / 技能栏）
// 还原成进来时的样子——后面的步骤（回响、多重投射……）依赖前面留下的构筑
async function uiStep(name, fn) {
  await step(name, async () => {
    const reset = () =>
      ev(() => {
        G.ui.close();
        G.debug.hold(true);
        T.hintsSeen();
      });
    await page.mouse.up();
    await reset();
    const build = await ev(() => T.buildSnap());
    try {
      return await fn();
    } finally {
      await page.mouse.up().catch(() => {});
      await reset().catch(() => {});
      await ev((b) => T.buildRestore(b), build).catch(() => {});
    }
  });
}

// 用真鼠标把 from 拖到 to（选择器或坐标）；mid 在松手前执行
async function dragTo(from, to, mid) {
  // 目标和起点都先滚进可视区（上一步可能把列表滚到了别处）
  if (typeof to === 'string') await page.locator(to).scrollIntoViewIfNeeded();
  if (typeof from === 'string') await page.locator(from).scrollIntoViewIfNeeded();
  const a = typeof from === 'string' ? await ev((s) => T.rect(s), from) : from;
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 9, a.y + 6, { steps: 2 });
  const b = typeof to === 'string' ? await ev((s) => T.rect(s), to) : to;
  await page.mouse.move(b.x, b.y, { steps: 5 });
  try {
    if (mid) await mid();
  } finally {
    await page.mouse.up();
  }
}

async function closePanel() {
  if (await ev(() => G.ui.isOpen())) await page.keyboard.press('Escape');
  assert(!(await ev(() => G.ui.isOpen())), 'Esc 没有关掉面板');
}

// 确认面板里的文字没有漏出 undefined / NaN
function cleanText(txt, where) {
  assert(txt.length > 40, where + ' 内容太少：' + JSON.stringify(txt.slice(0, 60)));
  assert(!/undefined|NaN|\[object|\{[a-z]\}/.test(txt), where + ' 里出现了未格式化的文本：' + (txt.match(/.{0,20}(undefined|NaN|\[object|\{[a-z]\}).{0,20}/) || [''])[0]);
}

const SKILL_IDS = ['cleave', 'ember', 'blade', 'nova', 'arc', 'meteor', 'blink', 'whirl', 'shadestep', 'thrall', 'colossus'];
const INPUT_NAME = ['左键', '右键', 'Q', 'E'];
async function holdInput(slot, down) {
  if (slot === 0) await page.mouse[down ? 'down' : 'up']({ button: 'left' });
  else if (slot === 1) await page.mouse[down ? 'down' : 'up']({ button: 'right' });
  else await page.keyboard[down ? 'down' : 'up'](slot === 2 ? 'KeyQ' : 'KeyE');
}

async function main() {
  // ------------------------------------------------------------------ 启动
  await step('启动：页面无报错，首次运行弹出开场卡片（游戏暂停），回车关闭', async () => {
    ({ browser, page, errors } = await launch({ width: 1440, height: 900 }));
    await install();
    await ev(() => G.debug.hold(false));
    await frames(3); // 着色器编译 + 首帧
    const s = await ev(() => ({ open: G.ui.isOpen(), intro: T.introOpen(), tab: T.tab(), sum: G.debug.summary(), key: !!localStorage.getItem('cinder-abyss-save-v1'), txt: document.getElementById('intro').innerText, card: T.rect('.intro-card'), w: innerWidth, h: innerHeight }));
    assert(s.open && s.intro && s.tab === null, '首次运行应弹出开场卡片而不是面板：' + JSON.stringify({ open: s.open, intro: s.intro, tab: s.tab }));
    assert(s.txt.includes('移动') && s.txt.includes('翻滚') && s.txt.length < 220, '开场卡片应当只有寥寥几句：' + s.txt.length + ' 字');
    assert(s.card.l >= 0 && s.card.t >= 0 && s.card.r <= s.w && s.card.b <= s.h, '开场卡片超出屏幕');
    assert(s.sum.zone && s.sum.zone.id === 'ash' && s.sum.zone.level === 1, '初始区域不对');
    assert(s.sum.enemies.total >= 20, '怪物太少：' + s.sum.enemies.total);
    assert(s.sum.boss && s.sum.boss.kind === 'golem' && !s.sum.boss.awake, '首领状态不对');
    assert(s.sum.player.level === 1 && s.sum.player.life === 100 && s.sum.player.mana === 60, '初始角色数值不对');
    assert(s.sum.bar[0] === 'cleave' && s.sum.bar[1] === 'ember' && s.sum.cur.dust === 2, '新存档内容不对');
    assert(s.key, '启动后应已写入存档');
    const t0 = await ev(() => G.state.time);
    await frames(2);
    assert((await ev(() => G.state.time)) === t0, '开场卡片开着时模拟应暂停');
    await page.keyboard.press('Enter');
    const c = await ev(() => ({ open: G.ui.isOpen(), intro: T.introOpen(), rolling: G.player.roll.t > 0 }));
    assert(!c.open && !c.intro && !c.rolling, '回车应关闭开场卡片：' + JSON.stringify(c));
    // 帮助页仍在，作为参考
    await page.keyboard.press('KeyH');
    assert((await ev(() => T.tab())) === 'help', 'H 应打开帮助页');
    cleanText(await ev(() => T.bodyText()), '帮助页');
    await closePanel();
    return '怪物 ' + s.sum.enemies.total + ' 只';
  });
  if (!page) {
    console.log('无法启动浏览器，终止。');
    process.exit(1);
  }

  await step('首屏：场景、玩家、HUD、小地图都画出来了', async () => {
    await frames(2);
    const r = await ev(() => {
      const rect = (sel) => {
        const n = document.querySelector(sel);
        if (!n) return null;
        const b = n.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom };
      };
      const ov = document.getElementById('overlay');
      const mm = ov.getContext('2d').getImageData(ov.width - 100, 100, 1, 1).data;
      return {
        fr: T.frame(),
        p: T.scr(G.player.x, G.player.z),
        vis: G.player.ent.group.visible && G.player.ent.group.parent === G.world.scene,
        zone: document.getElementById('zone-name').textContent,
        sub: document.getElementById('zone-sub').textContent,
        slots: document.querySelectorAll('#slots .slot').length,
        bar: T.hudBar(),
        icons: Array.from(document.querySelectorAll('#slots .slot .s-img')).map((n) => getComputedStyle(n).backgroundImage.startsWith('url("data:image/png')).join(),
        life: document.getElementById('life-num').textContent,
        mana: document.getElementById('mana-num').textContent,
        lv: document.getElementById('xp-lv').textContent,
        rects: { zone: rect('#zone-box'), bar: rect('#bar'), life: rect('.orb.life'), mana: rect('.orb.mana'), xp: rect('#xp') },
        mmAlpha: mm[3],
        w: innerWidth,
        h: innerHeight,
      };
    });
    assert(r.fr.mean > 6 && r.fr.colors > 40, '画面像是黑屏：' + JSON.stringify(r.fr));
    assert(r.vis, '玩家模型不在场景里');
    assert(r.p.ok && Math.abs(r.p.x - r.w / 2) < 60 && r.p.y > r.h * 0.35 && r.p.y < r.h * 0.7, '镜头没有对准玩家：' + JSON.stringify(r.p));
    assert(r.zone === '灰烬荒原' && /怪物等级\s*1/.test(r.sub), '区域信息不对：' + r.zone + ' / ' + r.sub);
    assert(r.slots === 4 && r.bar === 'cleave,ember,,' && r.icons === 'true,true,false,false', '技能栏不对：' + r.bar + ' / 图标 ' + r.icons);
    assert(r.life === '100' && r.mana === '60' && r.lv === '等级 1', '生命 / 魔力 / 等级显示不对');
    for (const k of Object.keys(r.rects)) {
      const b = r.rects[k];
      assert(b && b.w > 10 && b.h > 4 && b.x >= 0 && b.y >= 0 && b.r <= r.w + 1 && b.b <= r.h + 1, 'HUD 元素 ' + k + ' 不在屏幕内');
    }
    assert(r.rects.bar.x > r.rects.life.r && r.rects.bar.r < r.rects.mana.x, '技能栏与生命 / 魔力球重叠');
    assert(r.mmAlpha > 100, '小地图没有画出来');
    return '亮度 ' + r.fr.mean.toFixed(1) + '，颜色 ' + r.fr.colors;
  });

  await step('图标预热：启动后趁空闲分批画好全部图标，第一次打开背包不用现画', async () => {
    const t0 = Date.now();
    await until(() => G.icons.ready(), null, 60000).catch(() => {
      throw new Error('启动后图标没有在空闲时预先画好');
    });
    const n = await ev(() => G.icons.keys().length);
    assert(n >= 60, '图标数量不对：' + n);
    return n + ' 个图标，启动后 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒内就绪';
  });

  await step('模拟推进：G.debug.step 精确推进时间', async () => {
    const r = await ev(() => {
      G.debug.hold(true);
      const t0 = G.state.time;
      const ret = G.debug.step(1);
      return { dt: G.state.time - t0, ret: ret === G.state.time };
    });
    assert(Math.abs(r.dt - 1) < 1e-6 && r.ret, '推进 1 秒后时间变化 ' + r.dt);
    const t0 = await ev(() => G.state.time);
    await frames(2);
    assert((await ev(() => G.state.time)) === t0, 'hold 之后实时循环仍在推进');
  });

  // ------------------------------------------------------------------ 移动
  await step('键盘移动：WASD 与方向键按屏幕方向移动玩家', async () => {
    await ev(() => {
      T.arena();
      G.debug.god(true);
      G.debug.hold(false);
    });
    await page.mouse.move(720, 200);
    const dirs = [
      ['KeyD', 'x', 1], ['KeyA', 'x', -1], ['KeyS', 'z', 1], ['KeyW', 'z', -1],
      ['ArrowRight', 'x', 1], ['ArrowUp', 'z', -1],
    ];
    const out = [];
    for (const [key, axis, sign] of dirs) {
      await ev(() => T.tp(0, 0));
      await page.keyboard.down(key);
      try {
        await until(([a, s]) => G.player[a] * s > 2.5, [axis, sign]);
      } finally {
        await page.keyboard.up(key);
      }
      const p = await ev(() => ({ x: G.player.x, z: G.player.z, moving: G.player.moving }));
      const other = axis === 'x' ? p.z : p.x;
      assert(Math.abs(other) < 0.3, key + ' 移动方向歪了：' + JSON.stringify(p));
      out.push(key.replace('Key', ''));
    }
    await frames(2);
    assert(!(await ev(() => G.player.moving)), '松开按键后仍在移动');
    // 撞墙：一直往右走不会走出可行走区域
    await ev(() => {
      G.debug.hold(true);
      T.tp(0, 0);
      G.input.keys.KeyD = true;
      G.debug.step(4);
      G.input.keys.KeyD = false;
    });
    const w = await ev(() => ({ x: G.player.x, z: G.player.z, ok: G.world.walkable(G.player.x, G.player.z, 0.45) }));
    assert(w.ok, '玩家走出了可行走区域：' + JSON.stringify(w));
    return out.join(' ');
  });

  await step('翻滚：空格位移、无敌帧、冷却', async () => {
    await ev(() => {
      T.arena();
      G.debug.god(false);
      G.debug.hold(true);
    });
    const aim = await ev(() => T.scr(G.player.x + 5, G.player.z)); // 玩家正右方
    await page.mouse.move(Math.round(aim.x), Math.round(aim.y));
    await frames(2); // 等一帧把鼠标落点换算成世界坐标
    await page.keyboard.press('Space');
    const a = await ev(() => ({ t: G.player.roll.t, cd: G.player.roll.cd, ifr: G.player.iframe, hurt: G.hurtPlayer(10, 'phys') }));
    assert(a.t > 0.3 && a.cd > 0.8 && a.ifr >= 0.32, '空格没有触发翻滚：' + JSON.stringify(a));
    assert(a.hurt === false, '翻滚中仍然受伤');
    const b = await ev(() => {
      G.debug.step(0.34);
      return { x: G.player.x, z: G.player.z, t: G.player.roll.t };
    });
    assert(b.x > 4.5 && b.x < 7.5 && Math.abs(b.z) < 1.2 && b.t <= 0, '翻滚位移不对：' + JSON.stringify(b));
    await page.keyboard.press('Space');
    assert((await ev(() => G.player.roll.t)) <= 0, '冷却中不应再次翻滚');
    const c = await ev(() => {
      G.debug.step(0.2);
      const life0 = G.player.life;
      const hurt = G.hurtPlayer(10, 'phys');
      G.debug.step(0.5);
      return { hurt, lost: life0 - G.player.life, cd: G.player.roll.cd };
    });
    assert(c.hurt === true && c.lost > 5, '无敌帧结束后应能受伤：' + JSON.stringify(c));
    assert(c.cd === 0, '翻滚冷却没有走完');
    await page.keyboard.press('Space');
    assert((await ev(() => G.player.roll.t)) > 0.3, '冷却结束后应能再次翻滚');
    await ev(() => G.debug.step(0.5));
    return '位移 ' + b.x.toFixed(1);
  });

  await step('药剂：1 / 2 键回复生命与魔力，消耗充能', async () => {
    await ev(() => {
      T.arena();
      G.player.life = 20;
      G.player.mana = 0;
    });
    await page.keyboard.press('Digit1');
    await page.keyboard.press('Digit2');
    const a = await ev(() => {
      const f = { life: G.player.flask.life, mana: G.player.flask.mana };
      G.debug.step(1.3);
      return { f, life: G.player.life, mana: G.player.mana };
    });
    assert(a.f.life === 2 && a.f.mana === 2, '按键后药剂充能应为 2：' + JSON.stringify(a.f));
    assert(Math.abs(a.life - 65) < 1.5, '生命药剂应回复 45% 生命，实际生命 ' + a.life);
    assert(a.mana >= 30 && a.mana <= 40, '魔力药剂应回复 50% 魔力，实际魔力 ' + a.mana);
    await ev(() => {
      G.player.life = G.player.maxLife;
    });
    await page.keyboard.press('Digit1');
    assert((await ev(() => G.player.flask.life)) === 2, '满血时不应消耗药剂');
    await ev(() => {
      G.player.life = 10;
      G.player.flask.life = 0.6;
    });
    await page.keyboard.press('Digit1');
    const b = await ev(() => {
      G.debug.step(0.5);
      const r = { f: G.player.flask.life, life: G.player.life };
      const e = G.spawnMob('husk', 5, 0, 1, { awake: true });
      G.killEnemy(e);
      r.after = G.player.flask.life;
      G.debug.step(0.5);
      return r;
    });
    assert(b.f === 0.6 && b.life === 10, '充能不足 1 时不应生效');
    assert(Math.abs(b.after - 0.72) < 1e-6, '击杀应补充 0.12 充能，实际 ' + b.after);
  });

  // ------------------------------------------------------------------ 怪物
  await step('怪物：远处沉睡，靠近后整群苏醒并出现在画面里', async () => {
    const r = await ev(() => {
      G.enterZone(0, 0);
      G.debug.god(true);
      const S = G.state, W = G.world, P = G.player;
      G.debug.step(0.5);
      const awake0 = S.enemies.filter((e) => e.awake && Math.hypot(e.x - P.x, e.z - P.z) > 16).length;
      const badPos = S.enemies.filter((e) => !W.walkable(e.x, e.z, 0)).length;
      const nearStart = S.enemies.filter((e) => Math.hypot(e.x, e.z) < 12).length;
      const types = Array.from(new Set(S.enemies.filter((e) => !e.isBoss).map((e) => e.type)));
      const e = S.enemies.filter((q) => !q.isBoss).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
      let spot = null;
      for (let i = 0; i < 24 && !spot; i++) {
        const a = (i / 24) * Math.PI * 2;
        const x = e.x + Math.sin(a) * 8, z = e.z + Math.cos(a) * 8;
        if (W.walkable(x, z, 1)) spot = { x, z };
      }
      T.tp(spot.x, spot.z);
      G.debug.step(0.2);
      T.settle();
      const pack = S.enemies.filter((q) => q.pack === e.pack);
      const p = T.scr(e.x, e.z);
      return {
        awake0, badPos, nearStart, types, total: S.enemies.length,
        packAwake: pack.every((q) => q.awake), packN: pack.length,
        p, inScene: e.ent.group.parent === W.scene && e.ent.group.visible, fr: T.frame(), w: innerWidth, h: innerHeight,
      };
    });
    assert(r.awake0 === 0, '有 ' + r.awake0 + ' 只远处的怪醒着');
    assert(r.badPos === 0, r.badPos + ' 只怪生成在不可行走的位置');
    assert(r.nearStart === 0, '起点 12 以内有 ' + r.nearStart + ' 只怪');
    assert(r.types.every((t) => ['husk', 'spitter', 'brute'].includes(t)), '灰烬荒原出现了不该有的怪：' + r.types);
    assert(r.packAwake && r.packN >= 2, '靠近后怪群没有整群苏醒');
    assert(r.inScene && r.p.ok && r.p.x > 0 && r.p.x < r.w && r.p.y > 0 && r.p.y < r.h, '怪物不在画面内：' + JSON.stringify(r.p));
    assert(r.fr.mean > 6, '画面过暗');
    return '共 ' + r.total + ' 只，种类 ' + r.types.join('/');
  });

  for (const type of ['husk', 'brute', 'spitter', 'bomber']) {
    await step('怪物攻击：' + type + ' 会出手并伤到玩家', async () => {
      const r = await ev((type) => {
        T.arena();
        G.debug.god(false);
        const P = G.player, S = G.state;
        const xp0 = G.save.xp + G.save.level * 1e6;
        const e = G.spawnMob(type, 6.5, 0, S.zone.level, { awake: false });
        let t = 0, maxTel = 0, maxProj = 0, woke = false, hurtAt = -1;
        while (t < 15 && hurtAt < 0) {
          G.tick(1 / 60);
          t += 1 / 60;
          woke = woke || e.awake;
          maxTel = Math.max(maxTel, S.telegraphs.length);
          maxProj = Math.max(maxProj, S.projectiles.length);
          if (P.life < P.maxLife - 0.5 || P.dead) hurtAt = t;
        }
        const lost = P.maxLife - P.life;
        G.debug.step(0.4);
        const out = {
          woke, hurtAt, maxTel, maxProj, lost, dead: e.dead, sd: !!e.selfDestruct, loot: S.loot.length,
          xpSame: G.save.xp + G.save.level * 1e6 === xp0, gone: S.enemies.indexOf(e) < 0, pdead: P.dead,
        };
        G.debug.god(true);
        return out;
      }, type);
      assert(r.woke, '没有苏醒');
      assert(r.hurtAt > 0, '15 秒内没有伤到站着不动的玩家');
      assert(!r.pdead && r.lost < 60, '一下打掉了 ' + r.lost.toFixed(1) + ' 生命，过高');
      if (type === 'brute' || type === 'bomber') assert(r.maxTel >= 1, '没有出现预警圈');
      if (type === 'spitter') assert(r.maxProj >= 1, '没有发射投射物');
      if (type === 'bomber') assert(r.dead && r.sd && r.gone && r.loot === 0 && r.xpSame, '自爆后应死亡且不给经验 / 掉落：' + JSON.stringify(r));
      return r.hurtAt.toFixed(2) + ' 秒后命中，伤害 ' + r.lost.toFixed(1);
    });
  }

  await step('镜头与远程怪：脚下能看到 11 以上；屏幕下方画面外的喷吐者先走进画面再开火', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, W = G.world;
      const c = S.zone.circles[1];
      T.tp(c.x, c.z - 6.5);
      T.settle();
      const vw = innerWidth, vh = innerHeight;
      const on = (q) => q.ok && q.x >= 0 && q.x <= vw && q.y >= 0 && q.y <= vh;
      const out = { down: on(W.project(P.x, 0, P.z + 11)), up: on(W.project(P.x, 0, P.z - 13)), py: W.project(P.x, 0, P.z).y / vh };
      // 喷吐者放在正下方 11 处：在技能栏后面，算不得看得见
      const e = G.spawnMob('spitter', c.x, c.z + 4.5, 1, { awake: true });
      e.atkCd = 0;
      out.seen0 = W.inView(e.x, e.z);
      out.far = W.inView(P.x, P.z + 30) || W.inView(P.x + 40, P.z) || W.inView(P.x, P.z - 30);
      out.near = W.inView(P.x, P.z) && W.inView(P.x + 5, P.z + 5) && W.inView(P.x - 5, P.z - 5);
      const spawn = G.spawnProjectile;
      out.shots = 0;
      out.blind = 0;
      G.spawnProjectile = function (p) {
        if (p.owner === 'e') {
          out.shots++;
          const q = W.project(e.x, 1, e.z);
          if (!W.inView(e.x, e.z) || !on(q) || q.y > vh - 130) out.blind++;
        }
        return spawn(p);
      };
      let t = 0;
      while (t < 8 && out.shots < 2) {
        G.tick(1 / 60);
        t += 1 / 60;
      }
      G.spawnProjectile = spawn;
      out.t = t;
      out.dist = Math.hypot(e.x - P.x, e.z - P.z);
      G.clearEnemies();
      G.debug.step(0.1);
      return out;
    });
    assert(r.down && r.up, '镜头上下可视范围不够：' + JSON.stringify(r));
    assert(r.py > 0.3 && r.py < 0.5, '玩家应在画面中线偏上，实际 ' + r.py.toFixed(2));
    assert(!r.seen0 && !r.far && r.near, 'W.inView 判定不对：' + JSON.stringify(r));
    assert(r.shots >= 2, '喷吐者 8 秒内没有走进画面开火');
    assert(r.blind === 0, '喷吐者有 ' + r.blind + ' 发是在画面外（或技能栏后面）射出的');
    assert(r.dist < 10.5, '喷吐者应贴近到画面里，实际距离 ' + r.dist.toFixed(1));
    return '开火时距离 ' + r.dist.toFixed(1);
  });

  await step('控制：冻结 / 眩晕让巨躯砸地和爆裂虫引信停住，解控后继续', async () => {
    const r = await ev(() => {
      const P = G.player, S = G.state;
      const run = (type, dz, ctl) => {
        T.arena();
        const e = G.spawnMob(type, P.x, P.z + dz, 1, { awake: true });
        e.wasAwake = true;
        e.atkCd = 0;
        let t = 0;
        while (!S.telegraphs.length && t < 3) { G.tick(1 / 60); t += 1 / 60; }
        const tg = S.telegraphs[0];
        if (!tg) return { started: false };
        const dur = tg.dur;
        if (ctl) ctl(e);
        const p0 = tg.t;
        G.debug.step(0.5);
        const mid = { stalled: tg.t - p0, there: S.telegraphs.indexOf(tg) >= 0, dead: e.dead };
        let u = 0.5;
        while (S.telegraphs.indexOf(tg) >= 0 && u < 6) { G.tick(1 / 60); u += 1 / 60; }
        return { started: true, dur, took: u + p0, mid, dead: e.dead, sd: !!e.selfDestruct, state: e.state };
      };
      const out = {
        plain: run('brute', 2.2, null),
        stun: run('brute', 2.2, (e) => { e.stunT = 0.7; }),
        freeze: run('bomber', 1.5, (e) => { e.freeze = 1.2; }),
        kill: run('brute', 2.2, (e) => G.killEnemy(e)),
      };
      T.arena();
      T.clearLoot();
      return out;
    });
    for (const k of Object.keys(r)) assert(r[k].started, k + '：没有出现预警圈');
    assert(Math.abs(r.plain.took - r.plain.dur) < 0.06, '未受控的砸地应按原时长落下：' + JSON.stringify(r.plain));
    assert(r.stun.mid.stalled < 1e-6 && r.stun.mid.there, '眩晕期间预警圈还在推进：' + JSON.stringify(r.stun));
    assert(Math.abs(r.stun.took - (r.stun.dur + 0.7)) < 0.08 && r.stun.state === 'recover', '眩晕结束后砸地应接着走完：' + JSON.stringify(r.stun));
    assert(r.freeze.mid.stalled < 1e-6 && r.freeze.mid.there && !r.freeze.mid.dead, '冻结期间爆裂虫引信还在走：' + JSON.stringify(r.freeze));
    assert(Math.abs(r.freeze.took - (r.freeze.dur + 1.2)) < 0.08 && r.freeze.dead && r.freeze.sd, '解冻后爆裂虫应照常自爆：' + JSON.stringify(r.freeze));
    assert(!r.kill.mid.there, '主人被杀后预警圈应立即取消');
    return '眩晕 0.7s 把砸地从 ' + r.plain.took.toFixed(2) + 's 推迟到 ' + r.stun.took.toFixed(2) + 's';
  });

  // ------------------------------------------------------------------ 击杀 / 掉落 / 拾取
  await step('击杀：获得经验，精英必掉物品 + 通货 + 首颗辅助宝石', async () => {
    const r = await ev(() => {
      T.arena();
      const S = G.state;
      G.save.xp = 0;
      const xp0 = G.save.xp;
      // 离玩家远一点：掉落会散在落点 2.4 以内，太近会被自动拾取，下一步就找不到了
      G.spawnMob('husk', 7, 0, 1, { elite: true, awake: true });
      for (let i = 0; i < 3; i++) G.spawnMob('husk', 6, i - 1, 1, { awake: true });
      const n = G.debug.killAll();
      const kinds = {};
      for (const l of S.loot) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
      const bad = S.loot.filter((l) => !l.label || /undefined|NaN/.test(l.label) || !/^#[0-9a-f]{6}$/i.test(l.color) || !l.mesh || !G.world.walkable(l.x, l.z, 0)).length;
      const res = { n, xp: G.save.xp - xp0, level: G.save.level, kinds, bad, alive: S.enemies.filter((e) => !e.dead).length };
      G.debug.step(0.4);
      res.left = S.enemies.length;
      return res;
    });
    assert(r.n === 4 && r.alive === 0, 'killAll 应杀掉 4 只');
    assert(r.level === 1 && Math.abs(r.xp - 60) < 1e-6, '经验应为 10×3（精英）+ 10×3 = 60，实际 ' + r.xp);
    assert(r.kinds.item >= 2 && r.kinds.cur >= 1 && r.kinds.support >= 1, '精英掉落不对：' + JSON.stringify(r.kinds));
    assert(r.bad === 0, '有 ' + r.bad + ' 个掉落物数据不完整');
    assert(r.left === 0, '尸体没有被移除');
    return '掉落 ' + JSON.stringify(r.kinds);
  });

  await step('拾取：通货 / 宝石 / 魔法物品自动拾取，普通物品按 F 或点击名称', async () => {
    const a = await ev(() => {
      const S = G.state, P = G.player, save = G.save;
      const out = {};
      const sup = S.loot.find((l) => l.kind === 'support');
      const cur = S.loot.find((l) => l.kind === 'cur');
      const curN = save.cur[cur.data];
      T.tp(sup.x, sup.z);
      G.debug.step(0.1);
      out.sup = save.supports.indexOf(sup.data) >= 0 && S.loot.indexOf(sup) < 0; // 小怪也可能多掉一颗，只看捡起的这颗
      T.tp(cur.x, cur.z);
      G.debug.step(0.1);
      out.cur = save.cur[cur.data] >= curN + 1 && S.loot.indexOf(cur) < 0; // 同类通货落得很近时会一起捡到
      T.clearLoot();
      T.tp(0, 0);
      save.bag.length = 0;
      const magic = G.spawnLoot('item', G.rollItem(1, 1), 0, 0);
      const white = G.spawnLoot('item', G.rollItem(1, 0), 0, 0);
      white.x = magic.x + 0.5; // 两件挨着放，玩家站在魔法物品上
      white.z = magic.z;
      white.mesh.position.set(white.x, 0, white.z);
      T.tp(magic.x, magic.z);
      out.early = (G.debug.step(0.2), S.loot.length === 2); // 落地 0.3 秒内不自动拾取
      G.debug.step(0.4);
      out.magic = S.loot.indexOf(magic) < 0 && save.bag.some((it) => it === magic.data);
      out.whiteStays = S.loot.indexOf(white) >= 0;
      out.whiteUid = white.data.uid;
      return out;
    });
    assert(a.sup, '辅助宝石没有自动拾取');
    assert(a.cur, '通货没有自动拾取');
    assert(a.early, '刚落地的物品被立刻吸走了');
    assert(a.magic, '魔法物品没有自动拾取');
    assert(a.whiteStays, '普通物品不应自动拾取');
    await page.keyboard.press('KeyF');
    const b = await ev((uid) => ({ got: G.save.bag.some((it) => it.uid === uid), left: G.state.loot.length }), a.whiteUid);
    assert(b.got && b.left === 0, 'F 键没有拾取普通物品');

    // 点击名牌拾取
    const c = await ev(() => {
      T.tp(0, 0);
      const l = G.spawnLoot('item', G.rollItem(1, 0), 3, 0);
      l.x = 3.2;
      l.z = 0.4;
      l.mesh.position.set(l.x, 0, l.z);
      T.settle();
      G.world.render();
      const p = G.world.project(l.x, 1.0, l.z);
      const pt = { x: Math.round(p.x), y: Math.round(p.y - 36) };
      return { pt, hit: G.world.lootLabelAt(pt.x, pt.y) === l, uid: l.data.uid, label: l.label };
    });
    assert(c.hit, 'lootLabelAt 没有命中名牌：' + JSON.stringify(c.pt));
    await page.mouse.click(c.pt.x, c.pt.y);
    const d = await ev((uid) => ({ got: G.save.bag.some((it) => it.uid === uid), cast: !!G.player.cast, tap: G.input.tap[0], held: G.input.mouse.b[0] }), c.uid);
    assert(d.got, '点击名牌没有拾取');
    assert(!d.cast && !(d.tap > 0) && !d.held, '点击名牌时不应同时施法');

    // 太远 / 背包已满
    const e = await ev(() => {
      const far = G.spawnLoot('item', G.rollItem(1, 0), 0, 0);
      far.x = 7.6;
      far.z = 0;
      const r1 = G.pickup(far);
      const t1 = T.toasts();
      T.clearLoot();
      const keep = G.save.bag.slice();
      while (G.save.bag.length < G.BAG_SIZE) G.save.bag.push(G.rollItem(1, 0));
      const near = G.spawnLoot('item', G.rollItem(1, 2), 0.3, 0);
      T.tp(near.x, near.z); // 掉落会在落点附近散开，站到它上面才会触发自动拾取
      G.debug.step(0.5);
      const full = G.state.loot.indexOf(near) >= 0 && G.save.bag.length === G.BAG_SIZE;
      const t2 = T.toasts();
      G.save.bag = keep;
      T.clearLoot();
      return { r1, t1, full, t2 };
    });
    assert(e.r1 === false && e.t1.includes('走近一点'), '距离过远时应提示走近一点');
    assert(e.full && e.t2.includes('背包已满'), '背包已满时应保留掉落并提示');
  });

  await step('无铭技能宝石：首领首杀必掉（再打靠几率），精英 / 普通怪小几率；拾取进存档并按等级排好，拾取记录写数量；用不上时化为微光尘；旧存档补默认值，畸形数据被修正', async () => {
    const r = await ev((KEY) => {
      const S = G.state, save = G.save, P = G.player;
      T.arena();
      const out = {};
      const blanks = () => S.loot.filter((l) => l.kind === 'blank');
      const fake = (o) => Object.assign({ level: 3, x: P.x + 6, z: P.z, name: '测试' }, o);
      const kind = Object.keys(G.BOSSES)[0];
      const rnd = Math.random;
      const bk = save.bossKills;
      try {
        Math.random = () => 0.999; // 只看保底：靠几率的掉落一律不出
        save.bossKills = {};
        G.dropLoot(fake({ isBoss: true, bossKind: kind }));
        out.first = blanks().map((l) => ({ lvl: l.data.lvl, label: l.label, color: l.color }));
        T.clearLoot();
        save.bossKills = { [kind]: true };
        G.dropLoot(fake({ isBoss: true, bossKind: kind }));
        out.again = blanks().length;
        T.clearLoot();
        G.dropLoot(fake({ elite: true }));
        G.dropLoot(fake({}));
        out.unlucky = blanks().length;
        T.clearLoot();
        Math.random = () => 0.001; // 几率掉落全中
        G.dropLoot(fake({ isBoss: true, bossKind: kind }));
        out.bossLucky = blanks().length;
        T.clearLoot();
        G.dropLoot(fake({ elite: true }));
        out.eliteLucky = blanks().length;
        T.clearLoot();
        G.dropLoot(fake({}));
        out.mobLucky = blanks().length;
        T.clearLoot();
      } finally {
        Math.random = rnd;
        save.bossKills = bk;
      }
      out.rates = Object.assign({}, G.BLANK_DROP);

      // 拾取：走过去自动捡起，存进存档（从高到低排），提示与拾取记录里写数量
      save.blankGems = [];
      const dust0 = save.cur.dust;
      const pick = (lvl) => {
        const l = G.spawnLoot('blank', { lvl }, P.x, P.z);
        T.tp(l.x, l.z);
        G.debug.step(0.5);
        return S.loot.indexOf(l) < 0;
      };
      out.picked = pick(4);
      out.toast1 = T.toasts();
      out.feed = document.getElementById('feed').innerText;
      out.picked2 = pick(2) && pick(6);
      out.gems = save.blankGems.join();
      out.stored = (JSON.parse(localStorage.getItem(KEY)).blankGems || []).join();
      // 所有技能都学会了、而且都不低于这颗的等级：用不上，化为 1 微光尘
      const sk0 = save.skills;
      save.skills = {};
      for (const id of G.GEM_SKILLS) save.skills[id] = 9; // 武器技跟着武器走，不算在内
      out.useful9 = G.blankUseful(9);
      out.useful10 = G.blankUseful(10);
      out.uselessPicked = pick(5);
      out.useless = { gems: save.blankGems.join(), dust: save.cur.dust - dust0, toast: T.toasts() };
      save.skills = sk0;
      G.persist();

      // 旧存档没有这个字段：补成空数组；畸形数据被修正（取整、夹在 1–20、丢掉非数字、从高到低排）
      const keep = localStorage.getItem(KEY);
      const raw = JSON.parse(keep);
      delete raw.blankGems;
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      out.old = JSON.stringify(G.save.blankGems);
      raw.blankGems = ['x', 5.7, 99, -2, null, 3];
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      out.bad = G.save.blankGems.join();
      raw.blankGems = 'abc';
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      out.bad2 = JSON.stringify(G.save.blankGems);
      localStorage.setItem(KEY, keep);
      G.loadSave();
      G.computeStats();
      out.back = G.save.blankGems.join();
      out.fresh = JSON.stringify(G.newSave().blankGems);
      G.save.blankGems = []; // 不把宝石留给后面的步骤：技能页顶部多一条会改变布局
      G.persist();
      return out;
    }, SAVE_KEY);
    assert(r.first.length === 1 && r.first[0].lvl >= 1 && r.first[0].label.startsWith('无铭技能宝石 Lv ') && r.first[0].color !== '#3fe0c8', '首领首杀应必掉一颗无铭技能宝石，名牌颜色和技能宝石不同：' + JSON.stringify(r.first));
    assert(r.again === 0 && r.unlucky === 0, '首领再打 / 精英 / 普通怪没有中几率时不应掉：' + JSON.stringify(r));
    assert(r.bossLucky === 1 && r.eliteLucky === 1 && r.mobLucky === 1, '几率掉落没有生效：' + JSON.stringify(r));
    assert(r.rates.elite > 0 && r.rates.elite <= 0.1 && r.rates.mob > 0 && r.rates.mob < 0.012 && r.rates.boss < 1, '掉落几率不对：' + JSON.stringify(r.rates));
    assert(r.picked && r.picked2 && r.gems === '6,4,2' && r.stored === '6,4,2', '拾取后应按等级从高到低存进存档：' + JSON.stringify(r));
    assert(r.toast1.includes('无铭技能宝石 Lv 4') && r.toast1.includes('共 1 颗') && r.feed.includes('无铭技能宝石 Lv 4') && r.feed.includes('共 1 颗'), '拾取提示 / 拾取记录没有写数量：' + r.toast1 + ' | ' + r.feed);
    assert(r.useful9 === false && r.useful10 === true, 'blankUseful 判断不对');
    assert(r.uselessPicked && r.useless.gems === '6,4,2' && r.useless.dust === 1 && r.useless.toast.includes('用不上'), '用不上的无铭宝石应化为 1 微光尘：' + JSON.stringify(r.useless));
    assert(r.old === '[]' && r.bad === '45,5,3,1' && r.bad2 === '[]' && r.back === '6,4,2' && r.fresh === '[]', '旧存档 / 畸形存档没有修好：' + JSON.stringify(r));
    return '首杀掉 Lv ' + r.first[0].lvl + '，几率 ' + JSON.stringify(r.rates);
  });

  await step('掉落：升华石 / 乱流石 / 重铸石权重提高，琢刻石介于其间；首领首杀保底升华石和乱流石各一颗；分解稀有物品有几率给其一；辅助宝石掉率提高、首领掉两颗；重复的辅助宝石照旧化为增幅尘', async () => {
    const r = await ev(() => {
      const S = G.state, save = G.save, P = G.player;
      T.arena();
      const out = {};
      const C = G.CURRENCY;
      let tot = 0;
      for (const id of G.CUR_IDS) tot += C[id].w;
      out.w = { exalt: C.exalt.w, chaos: C.chaos.w, chisel: C.chisel.w, divine: C.divine.w, pExalt: C.exalt.w / tot, pDivine: C.divine.w / tot, tot };
      // 真实抽样：rollCurrency 的分布
      const cnt = {};
      for (let i = 0; i < 20000; i++) { const id = G.rollCurrency(); cnt[id] = (cnt[id] || 0) + 1; }
      out.roll = { exalt: cnt.exalt / 20000, chaos: cnt.chaos / 20000, chisel: (cnt.chisel || 0) / 20000, divine: cnt.divine / 20000 };

      const fake = (o) => Object.assign({ level: 5, x: P.x + 6, z: P.z, name: '测试' }, o);
      const kind = Object.keys(G.BOSSES)[1];
      const of = (k) => S.loot.filter((l) => l.kind === k).map((l) => l.data);
      const rnd = Math.random, bk = save.bossKills, sup0 = save.supports;
      try {
        save.supports = ['multi']; // 不触发「第一只精英必掉辅助宝石」
        Math.random = () => 0.999; // 靠几率的一律不出：只剩固定掉落和保底
        save.bossKills = {};
        G.dropLoot(fake({ isBoss: true, bossKind: kind }));
        out.first = { cur: of('cur').sort().join(), sup: of('support').length };
        T.clearLoot();
        save.bossKills = { [kind]: true };
        G.dropLoot(fake({ isBoss: true, bossKind: kind }));
        out.again = { cur: of('cur').sort().join(), sup: of('support').length };
        T.clearLoot();
        G.dropLoot(fake({ elite: true }));
        G.dropLoot(fake({}));
        out.unlucky = of('support').length;
        T.clearLoot();
        Math.random = () => 0.001;
        G.dropLoot(fake({ elite: true }));
        out.eliteLucky = of('support').length;
        T.clearLoot();
        G.dropLoot(fake({}));
        out.mobLucky = of('support').length;
        T.clearLoot();
        // 分解：稀有物品几率中了给升华石或乱流石，没中不给；魔法物品不给
        const rare = G.rollItem(5, 2, 'ring'), magic = G.rollItem(5, 1, 'ring');
        out.salvLucky = G.salvageResult(rare);
        out.salvMagic = G.salvageResult(magic);
        Math.random = () => 0.999;
        out.salvUnlucky = G.salvageResult(rare);
      } finally {
        Math.random = rnd;
        save.bossKills = bk;
      }
      // 抽样：分解稀有物品给出升华石 / 乱流石的比例
      let hi = 0;
      const rare = G.rollItem(5, 2, 'ring');
      for (let i = 0; i < 4000; i++) { const o = G.salvageResult(rare); if (o.exalt || o.chaos) hi++; }
      out.salvRate = hi / 4000;
      // 抽样：普通怪 / 精英掉辅助宝石的实际几率（不真的生成掉落物）
      const spawn = G.spawnLoot;
      let mobSup = 0, eliteSup = 0;
      try {
        let n = 0;
        G.spawnLoot = (k) => { if (k === 'support') n++; return {}; };
        for (let i = 0; i < 8000; i++) G.dropLoot(fake({}));
        mobSup = n / 8000;
        n = 0;
        for (let i = 0; i < 3000; i++) G.dropLoot(fake({ elite: true }));
        eliteSup = n / 3000;
      } finally {
        G.spawnLoot = spawn;
      }
      out.supRate = { mob: mobSup, elite: eliteSup, cfg: Object.assign({}, G.SUPPORT_DROP) };
      // 重复的辅助宝石：拾取后化为 1 增幅尘（保持原样）
      const aug0 = save.cur.augment;
      const l = G.spawnLoot('support', 'multi', P.x, P.z);
      T.tp(l.x, l.z);
      G.debug.step(0.5);
      out.dup = { picked: S.loot.indexOf(l) < 0, aug: save.cur.augment - aug0, n: save.supports.length, toast: T.toasts() };
      save.supports = sup0;
      T.clearLoot();
      G.persist();
      return out;
    });
    const w = r.w;
    assert(w.exalt >= 12 && w.chaos >= 12 && w.chisel > w.divine && w.chisel < w.exalt && w.chisel < w.chaos && w.divine >= 5, '通货权重不对：' + JSON.stringify(w));
    assert(w.pExalt > 0.1 && w.pDivine > 0.04, '升华石 / 重铸石的实际几率应比原来（9% / 4%）高：' + JSON.stringify(w));
    assert(Math.abs(r.roll.exalt - w.pExalt) < 0.015 && Math.abs(r.roll.chisel - w.chisel / w.tot) < 0.012, 'rollCurrency 的分布和权重对不上：' + JSON.stringify(r.roll));
    assert(r.first.sup === 2 && r.again.sup === 2, '首领应固定掉 2 颗辅助宝石：' + JSON.stringify(r));
    const firstCur = r.first.cur.split(','), againCur = r.again.cur.split(',');
    const n = (a, id) => a.filter((x) => x === id).length;
    assert(firstCur.length === 6 && n(firstCur, 'exalt') === 1 && n(firstCur, 'chaos') === 1, '首领首杀应在 4 颗随机通货之外保底升华石、乱流石各一颗：' + r.first.cur);
    assert(againCur.length === 4 && n(againCur, 'exalt') === 0 && n(againCur, 'chaos') === 0, '再打首领不应有保底：' + r.again.cur);
    assert(r.unlucky === 0 && r.eliteLucky === 1 && r.mobLucky === 1, '精英 / 普通怪的辅助宝石几率掉落不对：' + JSON.stringify(r));
    assert(r.salvLucky.augment === 1 && (r.salvLucky.exalt === 1) !== (r.salvLucky.chaos === 1), '分解稀有物品几率中了应给升华石或乱流石之一：' + JSON.stringify(r.salvLucky));
    assert(!r.salvUnlucky.exalt && !r.salvUnlucky.chaos && !r.salvMagic.exalt && !r.salvMagic.chaos, '没中几率 / 魔法物品不应给：' + JSON.stringify(r));
    assert(r.salvRate > 0.12 && r.salvRate < 0.3, '分解稀有物品给升华石 / 乱流石的比例不对：' + r.salvRate);
    assert(r.supRate.mob > 0.018 && r.supRate.mob < 0.035 && r.supRate.elite > 0.22 && r.supRate.elite < 0.4, '辅助宝石掉率应比原来（普通 1%、精英 7.5%）高：' + JSON.stringify(r.supRate));
    assert(r.dup.picked && r.dup.aug === 1 && r.dup.n === 1 && r.dup.toast.includes('增幅尘'), '重复的辅助宝石应化为 1 增幅尘：' + JSON.stringify(r.dup));
    return '升华石 ' + (w.pExalt * 100).toFixed(1) + '%，琢刻石 ' + ((w.chisel / w.tot) * 100).toFixed(1) + '%，辅助宝石 普通 ' + (r.supRate.mob * 100).toFixed(1) + '% / 精英 ' + (r.supRate.elite * 100).toFixed(0) + '%';
  });

  await step('升级：经验满后升级、回满、得到天赋点并在 HUD 上提醒', async () => {
    const r = await ev(() => {
      const P = G.player, save = G.save;
      P.life = 30;
      const need = G.xpNeed(save.level) - save.xp;
      const max0 = P.maxLife;
      G.gainXp(need + 5);
      return { level: save.level, xp: save.xp, life: P.life, max0, max: P.maxLife, pts: G.passivePoints(), toast: T.toasts() };
    });
    assert(r.level === 2 && Math.abs(r.xp - 5) < 1e-6, '应升到 2 级并保留溢出的经验：' + JSON.stringify(r));
    assert(r.max === r.max0 + 12 && r.life === r.max, '升级应 +12 生命上限并回满');
    assert(r.pts.total === 1 && r.pts.free === 1, '应获得 1 点天赋点');
    assert(r.toast.includes('等级提升'), '没有升级提示');
    await until(() => document.getElementById('pp-remind').classList.contains('on'));
    const h = await ev(() => ({
      lv: document.getElementById('xp-lv').textContent,
      remind: document.getElementById('pp-remind').classList.contains('on'),
      txt: document.getElementById('pp-remind').textContent,
    }));
    assert(h.lv === '等级 2', 'HUD 等级没有更新');
    assert(h.remind && h.txt.includes('1'), 'HUD 没有提醒未分配的天赋点');
  });

  // ------------------------------------------------------------------ 技能
  await step('learnAll：12 个技能与 19 个辅助宝石全部到手', async () => {
    const r = await ev(() => {
      G.debug.learnAll();
      return { skills: Object.keys(G.save.skills).length, sups: G.save.supports.length, bar: G.save.bar.slice() };
    });
    assert(r.skills === 12 && r.sups === 19 && r.bar.every((b) => b), JSON.stringify(r));
  });

  for (let i = 0; i < SKILL_IDS.length; i++) {
    const id = SKILL_IDS[i];
    const slot = i % 4;
    await step('技能：' + id + ' 绑定到' + INPUT_NAME[slot] + '，按住后对敌人造成伤害', async () => {
      const dist = id === 'cleave' || id === 'whirl' ? 2.4 : 5;
      const s = await ev(([id, slot, dist]) => {
        T.arena();
        G.debug.god(true);
        // 霜环是光环：在技能栏上就一直打身边的靶子。测别的技能时先取下，免得伤害算成光环的
        if (id !== 'nova') G.save.bar = G.save.bar.map((b) => (b === 'nova' ? null : b));
        const ok = G.bindSkill(slot, id);
        // 取下霜环后保留没了、上限回升：先补满，「不耗魔的技能不扣魔力」才比得出来
        G.computeStats();
        G.player.mana = G.player.maxMana;
        T.dummy(dist, 0);
        T.settle();
        G.debug.hold(false);
        return { ok, bar: G.save.bar.slice(), pt: T.scr(T.d.x, T.d.z), cost: G.skillCtx(id).cost, cd: G.skillCtx(id).cd, mana: G.player.mana };
      }, [id, slot, dist]);
      assert(s.ok && s.bar[slot] === id && s.bar.filter((b) => b === id).length === 1, '绑定失败：' + s.bar);
      await page.mouse.move(Math.round(s.pt.x), Math.round(s.pt.y));
      await holdInput(slot, true);
      let r;
      try {
        await until(() => T.d.hp < T.d.maxHp);
        r = await ev((id) => ({
          dmg: T.d.maxHp - T.d.hp, mana: G.player.mana, max: G.player.maxMana, cdMax: G.player.cdMax[id] || 0,
          px: G.player.x, awake: T.d.awake, aura: G.auraOn(id), res: G.player.reserved,
        }), id);
      } finally {
        await holdInput(slot, false);
        await ev(() => G.debug.hold(true));
      }
      assert(r.dmg > 1, '没有造成伤害');
      if (s.cost > 0) assert(r.mana < r.max - s.cost * 0.5, '没有扣魔力：' + r.mana + ' / ' + r.max);
      else assert(r.mana === r.max, '不耗魔的技能扣了魔力');
      if (s.cd > 0) assert(r.cdMax > 0, '没有进入冷却');
      if (id === 'blink') assert(r.px > 2, '闪袭没有位移：x=' + r.px);
      if (id === 'nova') assert(r.aura && r.res > 0, '霜环应作为光环常驻生效并保留魔力：' + JSON.stringify(r));
      return '伤害 ' + Math.round(r.dmg) + '，消耗 ' + s.cost;
    });
  }

  // ------------------------------------------------------------------ 武器
  await step('武器：十四种武器（含 6 种远程）各有伤害区间 / 攻速 / 隐含属性 / 武器技，伤害随物品等级与本地词缀成长；新基底进掉落池（烬铸专用的两种不出）；旧存档的武器读入时补齐伤害', async () => {
    const r = await ev(() => {
      const save = G.save, out = {};
      const B = G.BASES.weapon;
      out.types = B.map((b) => b.type).join();
      out.bad = [];
      for (let b = 0; b < B.length; b++) {
        const it = G.rollItem(10, 0, 'weapon', b);
        const s = G.weaponStats(it);
        const sk = G.SKILLS[B[b].wskill];
        const lo = G.weaponBaseDmg(b, 1), hi = G.weaponBaseDmg(b, 13);
        if (!(it.baseIdx === b && Array.isArray(it.dmg) && it.dmg[0] >= 1 && it.dmg[1] >= it.dmg[0] && it.dmg.every(Number.isInteger) && it.aps === B[b].aps && s.type === B[b].type && Math.abs(s.dps - ((s.min + s.max) / 2) * s.aps) < 1e-9))
          out.bad.push('stats:' + b + JSON.stringify(s));
        // 远程武器的 R 不进冷却、由量表卡住（rgauge）；普攻 basic_<type> 也得在
        if (!(sk && sk.weaponOnly && sk.tags.indexOf('weapon') >= 0 && sk.wtype === B[b].type && (B[b].ranged ? sk.rgauge && !sk.cd : sk.cd > 0) && G.GEM_SKILLS.indexOf(B[b].wskill) < 0)) out.bad.push('skill:' + b);
        if (B[b].ranged && !(G.SKILLS['basic_' + B[b].type] && G.SKILLS['basic_' + B[b].type].basic && G.GEM_SKILLS.indexOf('basic_' + B[b].type) < 0)) out.bad.push('basic:' + b);
        if (!(hi[0] + hi[1] > (lo[0] + lo[1]) * 1.8)) out.bad.push('grow:' + b + lo + '/' + hi);
        if (!(it.imp && G.STAT_FMT[it.imp.stat])) out.bad.push('imp:' + b);
      }
      // 攻速：双匕快、战锤慢；施法武器的伤害低
      const avg = (b) => { const d = G.weaponBaseDmg(b, 9); return (d[0] + d[1]) / 2; };
      out.speed = B[3].aps > B[0].aps && B[4].aps < B[0].aps && B[6].aps > B[0].aps;
      out.caster = avg(1) < avg(0) * 0.75 && avg(2) < avg(0) * 0.75 && avg(7) < avg(0) * 0.6 && avg(4) > avg(0);
      // 本地词缀：+50% 与附加 10（显示 7–13）
      const w = G.rollItem(9, 1, 'weapon', 0);
      w.affixes = [];
      G.refreshWeapon(w);
      const d0 = w.dmg.slice();
      w.affixes = [{ id: 'wInc', tier: 0, v: 50 }, { id: 'wAdd', tier: 0, v: 10 }];
      G.refreshWeapon(w);
      out.local = { d0, d1: w.dmg.slice(), want: [Math.round((w.wbase[0] + 7) * 1.5), Math.round((w.wbase[1] + 13) * 1.5)], stats: Object.keys(G.itemStats(w)).join(), lines: G.itemLines(w).affixes.map((l) => l.text + (l.local ? '*' : '')).join('|') };
      // 打造后 dmg 跟着本地词缀走
      let craftOk = true;
      for (let n = 0; n < 40; n++) {
        const it = G.rollItem(14, 0, 'weapon');
        G.craft(it, 'alch');
        for (let k = 0; k < 4; k++) G.craft(it, 'chaos');
        G.craft(it, 'divine');
        const copy = JSON.parse(JSON.stringify(it));
        delete copy.dmg;
        G.refreshWeapon(copy);
        if (copy.dmg.join() !== it.dmg.join()) craftOk = false;
      }
      out.craftOk = craftOk;
      // 本地词缀只出在武器上，物理附加不再出在武器上（武器上的是本地的 wAdd）
      out.localSlots = G.AFFIX_BY_ID.wInc.slots.join() + '/' + G.AFFIX_BY_ID.wAdd.slots.join() + '/' + (G.AFFIX_BY_ID.addPhys.slots.indexOf('weapon') < 0);
      // 掉落池：12 种都会出（烬铸专用的 12 / 13 不出）；新存档的起手武器和改版前一样是刃 / 长杖 / 短杖随机一把普通 1 级武器，
      // 武器秒伤都折成平均成色的 1 级刃（10）
      const seen = new Set();
      for (let n = 0; n < 1400; n++) seen.add(G.rollItem(1, 0, 'weapon').baseIdx);
      out.pool = seen.size;
      const starts = new Set();
      let startOk = true;
      for (let n = 0; n < 60; n++) {
        const sw = G.newSave().equip.weapon;
        starts.add(sw.baseIdx);
        if (!(sw.rarity === 0 && sw.ilvl === 1 && sw.baseIdx <= 2 && Math.abs(G.weaponStats(sw).dps - 10) < 0.8)) startOk = false;
      }
      out.start = [...starts].sort().join(',') + ':' + startOk;
      // 旧存档：武器没有伤害字段（还有基底下标越界的、伤害字段被改过的、技能里混进武器技的）
      const KEY = 'cinder-abyss-save-v1';
      const keep = localStorage.getItem(KEY);
      const old = (b, ilvl, uid) => ({ uid, slot: 'weapon', baseIdx: b, baseName: 'x', name: 'x', rarity: 1, ilvl, imp: null, affixes: [{ id: 'wInc', tier: 0, v: 20 }] });
      const raw = JSON.parse(keep);
      raw.bag = [old(4, 13, 'o1'), Object.assign(old(5, 9, 'o2'), { wbase: [1e9, 3], dmg: [99999, 99999], aps: 50 }), old(2, 1, 'o3')];
      raw.equip = { weapon: old(99, 5, 'o4') };
      raw.skills = Object.assign({}, raw.skills, { quake: 5 });
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      G.computeStats();
      // 旧武器按 max(物品等级, 角色等级) 推导（改版前物品等级不影响伤害，老角色常拿着低等级武器）
      const lvOf = (il) => Math.max(il, Math.min(save.level, G.WEAPON_LVL_OLD_CAP));
      const got = save.bag.map((it) => ({ b: it.baseIdx, dmg: it.dmg.join('-'), aps: it.aps, want: G.weaponBaseDmg(it.baseIdx, lvOf(it.ilvl)).map((v) => Math.round(v * 1.2)).join('-') }));
      const eq = save.equip.weapon;
      out.old = { lvl: save.level, mig: G.weaponMigrated, got, eq: eq && { b: eq.baseIdx, dmg: eq.dmg.join('-'), want: G.weaponBaseDmg(0, lvOf(5)).map((v) => Math.round(v * 1.2)).join('-') }, quake: save.skills.quake, ws: G.weaponSkill() };
      out.oldOk = got.every((g) => g.dmg === g.want && g.aps === B[g.b].aps) && out.old.eq && out.old.eq.dmg === out.old.eq.want && out.old.eq.b === 0 && !out.old.quake && out.old.mig === true;
      // 低物品等级的旧武器在高等级角色手里也按角色等级算
      const raw2 = JSON.parse(keep);
      raw2.level = 20;
      raw2.bag = [old(0, 1, 'o5')];
      raw2.equip = {};
      localStorage.setItem(KEY, JSON.stringify(raw2));
      G.loadSave();
      out.old.lowIlvl = save.bag[0].wbase.join('-') + ' vs ' + G.weaponBaseDmg(0, 20).join('-');
      out.oldOk = out.oldOk && save.bag[0].wbase.join() === G.weaponBaseDmg(0, 20).join();
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      // 存档里再读一遍：字段稳定（同一份存档读两次结果一样）
      G.persist();
      const once = JSON.stringify(save.bag.map((it) => [it.wbase, it.dmg, it.aps]));
      G.loadSave();
      out.stable = JSON.stringify(save.bag.map((it) => [it.wbase, it.dmg, it.aps])) === once && G.weaponMigrated === false;
      localStorage.setItem(KEY, keep);
      G.loadSave();
      G.computeStats();
      return out;
    });
    assert(r.types === 'blade,staff,wand,daggers,hammer,eagle,katana,banner,gatling,flamer,huntbow,runebow,revolver,emberbow', '武器类型（下标 0..13）不对：' + r.types);
    assert(!r.bad.length, '武器数据不对：' + r.bad.join(' '));
    assert(r.speed && r.caster, '双匕应比刃快、战锤慢；杖类的武器伤害应明显偏低：' + JSON.stringify(r));
    assert(r.local.d1.join() === r.local.want.join() && r.local.d1[0] > r.local.d0[0], '本地词缀没有正确加到武器伤害上：' + JSON.stringify(r.local));
    assert(r.local.stats.indexOf('wInc') < 0 && r.local.stats.indexOf('wAdd') < 0 && /武器物理伤害提高 50%\*/.test(r.local.lines) && /附加 7–13 物理伤害\*/.test(r.local.lines), '本地词缀不应进角色属性、文本应标成本地：' + JSON.stringify(r.local));
    assert(r.craftOk, '打造之后武器伤害没有跟着本地词缀重算');
    assert(r.localSlots === 'weapon/weapon/true', '本地词缀的部位不对：' + r.localSlots);
    assert(r.pool === 12 && r.start === '0,1,2:true', '掉落池应有 12 种武器（烬铸左轮 / 烬铸长弓不随机掉）、起手是刃 / 长杖 / 短杖随机一把普通 1 级武器，武器秒伤约 10：' + JSON.stringify({ pool: r.pool, start: r.start }));
    assert(r.oldOk && r.stable, '旧存档的武器应按基底与 max(物品等级, 角色等级) 补齐伤害（不是 0）、越界基底修正、武器技不进技能：' + JSON.stringify(r.old));
    return '起手 ' + r.start + '，本地词缀 ' + r.local.d0.join('–') + ' → ' + r.local.d1.join('–');
  });

  await step('攻击技能的伤害来自武器（倍率 × 武器伤害、乘武器攻速），法术与召唤不受影响；空手很弱；换装评估看得到武器秒伤', async () => {
    const r = await ev(() => {
      const save = G.save, P = G.player, out = {};
      const keepW = save.equip.weapon;
      const bar0 = save.bar.slice();
      const bag0 = save.bag.slice();
      const mk = (b, ilvl) => { const it = G.rollItem(ilvl, 0, 'weapon', b); it.wbase = G.weaponBaseDmg(b, ilvl); it.imp = null; G.refreshWeapon(it); return it; };
      const read = () => {
        G.computeStats();
        const c = G.skillCtx('cleave'), e = G.skillCtx('ember'), t = G.skillCtx('thrall');
        return { cl: c.base.phys.map((v) => +v.toFixed(3)), clSpeed: c.speed, clDps: G.skillDps(c), em: JSON.stringify(e.base), emSpeed: e.speed, th: JSON.stringify(t.base), wm: c.wm, k: c.levelK, attack: c.attack, emAttack: e.attack };
      };
      try {
        const lv = save.skills.cleave;
        save.equip.weapon = mk(0, 9);
        const a = read();
        save.equip.weapon = mk(0, 15);
        const b = read();
        save.equip.weapon = mk(3, 9);
        const dg = read();
        delete save.equip.weapon;
        const f = read();
        const wA = G.weaponBaseDmg(0, 9);
        out.formula = Math.abs(a.cl[0] - wA[0] * 1.25 * (1 + G.ATTACK_GEM_LVL * (lv - 1))) < 0.01 && a.wm === 1.25 && a.attack && !a.emAttack;
        out.scale = b.cl[1] / a.cl[1];
        out.spellSame = a.em === b.em && a.em === f.em && a.em === dg.em && a.th === f.th && a.emSpeed === dg.emSpeed;
        out.aps = +(dg.clSpeed / a.clSpeed).toFixed(3);
        out.fists = f.cl.join() === [2 * 1.25 * a.k, 4 * 1.25 * a.k].map((v) => +v.toFixed(3)).join();
        out.fistDps = f.clDps / a.clDps;
        // 有冷却的闪袭：出手次数由冷却定，攻速改为折进每一击（战锤 0.8 / 双匕 1.2 的平均伤害 × 攻速一样时，闪袭每一击一样）
        save.skills.blink = save.skills.blink || 1;
        const bl = (b, base) => { const w = mk(b, 9); w.wbase = base.slice(); G.refreshWeapon(w); save.equip.weapon = w; G.computeStats(); return G.skillCtx('blink').base.phys[1]; };
        out.cdAps = { hammer: +bl(4, [10, 15]).toFixed(3), daggers: +bl(3, [10, 15]).toFixed(3), blade: +bl(0, [10, 15]).toFixed(3), cleaveDg: +G.skillCtx('cleave').base.phys[1].toFixed(3) };
        // 换装评估：更强的武器 → 裂石击秒伤上升、角标 ▲；评估结果和真换上去一致
        save.bar[0] = 'cleave';
        save.equip.weapon = mk(0, 9);
        G.computeStats();
        const strong = mk(0, 15);
        strong.uid = 'vd-strong-' + Date.now();
        save.bag.push(strong);
        const v = G.ui.verdict(strong);
        const before = G.skillDps(G.skillCtx('cleave'));
        G.equip(strong);
        const after = G.skillDps(G.skillCtx('cleave'));
        const line = v.lines.find((l) => l.label === G.SKILLS.cleave.name + ' 秒伤');
        out.vd = { badge: v.badge, line: line && parseFloat(line.text), real: Math.round((after - before) * 10) / 10 };
      } finally {
        save.bag = bag0;
        save.equip.weapon = keepW;
        save.bar = bar0;
        G.computeStats();
      }
      return out;
    });
    assert(r.formula, '攻击技能的基础伤害应为 武器伤害 × 倍率 × 等级加成：' + JSON.stringify(r));
    assert(r.scale > 1.3, '更高物品等级的武器应明显提高攻击技能伤害：×' + r.scale);
    assert(r.spellSame, '法术 / 召唤的伤害不应随武器变化');
    assert(r.aps === 1.2, '双匕的攻速应让攻击技能出手快 1.2 倍：' + r.aps);
    assert(r.fists && r.fistDps < 0.4, '空手应该很弱：' + JSON.stringify(r));
    const ca = r.cdAps;
    assert(Math.abs(ca.hammer / ca.blade - 0.8) < 0.002 && Math.abs(ca.daggers / ca.blade - 1.2) < 0.002 && ca.cleaveDg < ca.daggers, '有冷却的攻击技能应把武器攻速折进每一击：' + JSON.stringify(ca));
    assert(r.vd.badge === 'up' && r.vd.line > 0 && Math.abs(r.vd.line - r.vd.real) <= 0.11, '换装评估应反映武器秒伤：' + JSON.stringify(r.vd));
    return '物品等级 9 → 15 ×' + r.scale.toFixed(2) + '，空手 ' + Math.round(r.fistDps * 100) + '%，评估 +' + r.vd.line;
  });

  // 近战 / 施法武器（远程武器的 R 由量表卡住，见后面的远程步骤）：下标 → 类型
  const WEAPON_TYPES = { 0: 'blade', 1: 'staff', 2: 'wand', 3: 'daggers', 4: 'hammer', 6: 'katana', 7: 'banner' };
  const MELEE_IDX = [0, 1, 2, 3, 4, 6, 7];
  for (const b of MELEE_IDX) {
    await step('武器技：拿着' + WEAPON_TYPES[b] + '按 R 施放它的武器技，造成伤害、扣魔力、进入冷却；冷却中再按不会施放', async () => {
      const s = await ev((b) => {
        T.arena();
        G.debug.god(true);
        const save = G.save;
        save.bar = save.bar.map((x) => (x === 'nova' ? null : x)); // 光环的伤害别算进来
        T.keepW = save.equip.weapon;
        save.equip.weapon = G.rollItem(5, 0, 'weapon', b);
        G.computeStats();
        G.player.mana = G.player.maxMana;
        T.dummy(5, 0);
        T.settle();
        G.debug.hold(false);
        const id = G.weaponSkill();
        return { id, name: G.SKILLS[id].name, cost: G.skillCtx(id).cost, pt: T.scr(T.d.x, T.d.z), mana: G.player.mana, slot4: G.slotSkill(4) };
      }, b);
      await page.mouse.move(Math.round(s.pt.x), Math.round(s.pt.y));
      await page.keyboard.down('KeyR');
      let r;
      try {
        await until(() => T.d.hp < T.d.maxHp);
        r = await ev((id) => ({ dmg: T.d.maxHp - T.d.hp, mana: G.player.mana, max: G.player.maxMana, cd: G.player.cds[id] || 0, cdMax: G.player.cdMax[id] || 0 }), s.id);
      } finally {
        await page.keyboard.up('KeyR');
      }
      const again = await ev((id) => {
        G.debug.hold(true);
        const P = G.player;
        // 冷却中轻点 R：不施放（冷却不会被重置）
        const cd0 = P.cds[id];
        G.input.tap[4] = 0.2;
        let recast = false;
        for (let i = 0; i < 6; i++) {
          G.tick(1 / 60);
          if (P.cds[id] > cd0) recast = true;
        }
        G.input.tap[4] = 0;
        G.save.equip.weapon = T.keepW;
        G.computeStats();
        G.debug.god(false);
        return { recast, cd: P.cds[id] };
      }, s.id);
      assert(s.slot4 === s.id, 'R 格应是当前武器的武器技：' + JSON.stringify(s));
      assert(r.dmg > 1, '没有造成伤害');
      assert(r.mana < r.max - s.cost * 0.5, '没有扣魔力：' + r.mana + ' / ' + r.max);
      assert(r.cdMax > 0 && r.cd > 0, '没有进入冷却：' + JSON.stringify(r));
      assert(!again.recast && again.cd > 0, '冷却中不应再次施放：' + JSON.stringify(again));
      return s.name + ' 伤害 ' + Math.round(r.dmg) + '，冷却 ' + r.cdMax + ' 秒';
    });
  }

  await step('武器技：R 跟着手里的武器换、空手没有；墙挡得住；影刺 / 瞬断有无敌；翻滚在出手前取消不进冷却；缓冲、连击计数、架势、异常值照常', async () => {
    const r = await ev(() => {
      const P = G.player, S = G.state, W = G.world, save = G.save, out = {};
      const keepW = save.equip.weapon;
      const bag0 = save.bag.slice();
      const barK = save.bar.slice();
      const th0 = G.BUILDUP.th;
      const lane = () => { T.arena(); const c = S.zone.circles[0]; T.tp(c.x - 5, c.z); return c; };
      const run = (n, aimX, aimZ) => {
        let ifr = 0;
        for (let i = 0; i < n; i++) {
          T.aim(aimX, aimZ);
          G.tick(1 / 60);
          if (P.iframe > ifr) ifr = P.iframe;
        }
        return ifr;
      };
      try {
        G.BUILDUP.th = 1e9; // 这一段先不让异常触发（爆燃 / 感电的连带伤害不受墙限制，会混进「墙后」的统计）
        // R 跟着武器换
        out.follow = [];
        for (let b = 0; b < G.BASES.weapon.length; b++) {
          const it = G.rollItem(3, 0, 'weapon', b);
          save.bag.push(it);
          G.equip(it);
          out.follow.push(G.weaponSkill() === G.BASES.weapon[b].wskill && G.slotSkill(4) === G.weaponSkill());
        }
        lane(); // （T.arena 会换回标准刃，空手的检查放在它之后）
        G.unequip('weapon');
        out.none = G.weaponSkill() === null && G.slotSkill(4) === null;
        G.input.tap[4] = 0.3;
        for (let i = 0; i < 5; i++) G.tick(1 / 60);
        out.noneCast = !!P.cast || Object.keys(P.cds).length > 0;
        // 每种武器技：墙前的敌人挨打、墙后的不挨，人不穿墙；影刺 / 瞬断途中无敌
        out.wall = {};
        for (const b of [0, 1, 2, 3, 4, 6, 7]) { // 远程武器的 R 要量表满，墙的检查在远程步骤里
          lane();
          save.equip.weapon = G.rollItem(5, 0, 'weapon', b);
          G.computeStats();
          P.mana = P.maxMana;
          const ow = W.walkable, wallX = P.x + 3;
          W.walkable = function (x, z, pad) { return Math.abs(x - wallX) < 0.5 ? false : ow.call(W, x, z, pad); };
          const front = T.mob('brute', 1.8, 0), behind = T.mob('brute', 5, 0);
          const x0 = P.x;
          G.input.tap[4] = 0.3;
          const ifr = run(240, x0 + 5, P.z);
          W.walkable = ow;
          out.wall[G.BASES.weapon[b].type] = { front: Math.round(front.maxHp - front.hp), behind: Math.round(behind.maxHp - behind.hp), x: +(P.x - x0).toFixed(2), ifr: +ifr.toFixed(2) };
        }
        // 翻滚取消：起手（第一段生效前）翻滚 → 不扣魔力、不进冷却
        lane();
        save.equip.weapon = G.rollItem(5, 0, 'weapon', 4); // 战锤：起手最长
        G.computeStats();
        P.mana = P.maxMana;
        T.mob('brute', 3, 0);
        G.input.tap[4] = 0.3;
        run(10, P.x + 4, P.z);
        const casting = !!(P.cast && P.cast.ws && !P.cast.fired);
        const m0 = P.mana;
        G.dodge();
        run(40, P.x + 4, P.z);
        out.roll = { casting, cd: P.cds.quake || 0, mana: +(m0 - P.mana).toFixed(2) };
        // 缓冲：挥砍途中按 R，挥完立刻出武器技
        lane();
        save.equip.weapon = G.rollItem(5, 0, 'weapon', 0);
        save.bar[0] = 'cleave';
        G.computeStats();
        const tgt = T.mob('brute', 2.2, 0);
        T.aim(tgt.x, tgt.z);
        G.input.tap[0] = 0.3;
        G.tick(1 / 60);
        const first = P.cast && P.cast.id;
        G.input.tap[0] = 0;
        G.input.tap[4] = G.bufferTime('cast');
        let at = -1;
        for (let i = 0; i < 60 && at < 0; i++) {
          T.aim(tgt.x, tgt.z);
          G.tick(1 / 60);
          if (P.cast && P.cast.id === 'riposte') at = i;
        }
        out.buffer = { first, at };
        // 连击计数、架势：精英挨回锋斩
        lane();
        const el = T.mob('brute', 2.2, 0, { elite: true });
        const chain0 = P.chain.n, poise0 = el.poise;
        G.input.tap[4] = 0.3;
        run(60, el.x, el.z);
        out.feel = { chain: P.chain.n - chain0, poise: +(poise0 - el.poise).toFixed(1), poiseMax: el.poiseMax };
        // 异常值：地脉涌取加成最高的元素（冰霜）并累积它的异常值
        G.BUILDUP.th = th0;
        lane();
        save.equip.weapon = G.rollItem(5, 0, 'weapon', 1);
        G.computeStats();
        P.S.incCold = (P.S.incCold || 0) + 40;
        const m = T.mob('husk', 2.5, 0, { hp: 2000 });
        out.elem = G.topElem('fire');
        const base = Object.keys(G.skillCtx('leyburst').base).join();
        G.input.tap[4] = 0.3;
        run(40, m.x, m.z);
        out.bu = { base, cold: (m.bu && m.bu.cold) || 0, frozen: (S.stats.freezes || 0) > 0 || m.freeze > 0 };
      } finally {
        G.BUILDUP.th = th0;
        save.bag = bag0;
        save.equip.weapon = keepW;
        save.bar = barK;
        G.computeStats();
        T.arena();
      }
      return out;
    });
    assert(r.follow.every(Boolean) && r.none && !r.noneCast, 'R 应跟着武器换、空手为空：' + JSON.stringify(r.follow));
    const w = r.wall;
    for (const k of Object.keys(w)) assert(w[k].behind === 0 && w[k].x < 2.6, k + '：墙后的敌人不应挨打、人不应穿墙：' + JSON.stringify(w[k]));
    for (const k of Object.keys(w)) assert(w[k].front > 0, k + '：墙前的敌人应挨打：' + JSON.stringify(w[k]));
    assert(w.daggers.ifr >= 0.25 && w.katana.ifr >= 0.2, '影刺 / 瞬断途中应无敌：' + JSON.stringify(w));
    assert(w.katana.x > 1.5 && w.daggers.x > 1, '瞬断应冲到墙前、影刺应闪到目标身后：' + JSON.stringify(w));
    assert(r.roll.casting && r.roll.cd === 0 && r.roll.mana <= 0, '出手前翻滚取消不应扣魔力 / 进冷却：' + JSON.stringify(r.roll));
    assert(r.buffer.first === 'cleave' && r.buffer.at >= 0, '挥砍途中按下的 R 应在挥完后放出：' + JSON.stringify(r.buffer));
    assert(r.feel.chain >= 2 && r.feel.poise > 30, '武器技应计入连击并削架势：' + JSON.stringify(r.feel));
    assert(r.elem === 'cold' && r.bu.base.indexOf('cold') >= 0 && (r.bu.cold > 0 || r.bu.frozen), '地脉涌应取加成最高的元素并累积其异常值：' + JSON.stringify(r));
    return '墙前伤害 ' + Object.keys(w).map((k) => k + ' ' + w[k].front).join(' / ');
  });

  await step('魂潮：4 只魂火扑向准星附近的敌人、碰到即炸开，伤害按召唤物算（吃召唤物伤害，不吃你自己的伤害加成）；没有召唤物也能用；有召唤物时令其狂热（攻击 / 移动更快）', async () => {
    const r = await ev(() => {
      const P = G.player, S = G.state, save = G.save, out = {};
      const keepW = save.equip.weapon;
      const sk0 = Object.assign({}, save.skills);
      try {
        T.arena();
        const ban = G.rollItem(9, 0, 'weapon', 7);
        save.equip.weapon = ban;
        G.computeStats();
        out.ws = G.weaponSkill();
        out.imp = G.itemLines(ban).imp;
        const st = G.itemStats(ban);
        out.impStats = st.minionDmg > 0 && st.minionLife > 0;
        // 伤害按召唤物算：玩家的伤害加成、暴击不影响，召唤物伤害加成影响
        const base0 = G.avgHit(G.skillCtx('soultide'));
        P.S.incPhys = (P.S.incPhys || 0) + 100;
        P.S.incAll = (P.S.incAll || 0) + 100;
        P.S.crit = (P.S.crit || 0) + 300;
        const own = G.avgHit(G.skillCtx('soultide'));
        const m0 = P.S.minionDmg || 0; // 魂幡自己的隐含属性已经带着召唤物伤害
        P.S.minionDmg = m0 + 100;
        const mdmg = G.avgHit(G.skillCtx('soultide'));
        out.scale = { own: +(own / base0).toFixed(3), minion: +(mdmg / base0).toFixed(3), wantM: +((2 + m0 / 100) / (1 + m0 / 100)).toFixed(3), lvl: G.skillCtx('soultide').lvl, want: Math.round(ban.ilvl * 0.75) };
        G.computeStats();
        // 没有召唤物：照样放、造成伤害、进冷却
        const c = S.zone.circles[0];
        T.tp(c.x - 5, c.z);
        const e1 = T.mob('brute', 5, 0);
        const e2 = T.mob('brute', 5.8, 1.0);
        T.aim(e1.x, e1.z);
        P.mana = P.maxMana;
        G.input.tap[4] = 0.3;
        let maxP = 0;
        const sp0 = G.spawnProjectile;
        G.spawnProjectile = function (p) {
          if (p.wisp) maxP++;
          return sp0.apply(this, arguments);
        };
        try {
          for (let i = 0; i < 90; i++) G.tick(1 / 60);
        } finally {
          G.spawnProjectile = sp0;
        }
        out.solo = { dmg: Math.round(e1.maxHp - e1.hp), splash: Math.round(e2.maxHp - e2.hp), maxP, cd: P.cds.soultide || 0, frenzy: G.minionFrenzyState().t };
        // 打空：魂火到点散掉，不留在场上
        T.arena();
        save.equip.weapon = ban;
        G.computeStats();
        P.mana = P.maxMana;
        G.input.tap[4] = 0.3;
        for (let i = 0; i < 150; i++) G.tick(1 / 60);
        out.fizzle = S.projectiles.length;
        // 有召唤物：狂热期间出手间隔与移动都快 30%
        T.arena();
        save.equip.weapon = ban;
        save.skills.thrall = G.skillCtx('soultide').lvl; // 仆从宝石和魂潮同级：穿插收益的估算才是同一档次比
        G.computeStats();
        G.summonMinion('thrall', P.x - 2, P.z, G.skillCtx('thrall'));
        G.summonMinion('thrall', P.x - 2, P.z + 1.2, G.skillCtx('thrall'));
        for (let i = 0; i < 60; i++) G.tick(1 / 60);
        P.mana = P.maxMana;
        G.input.tap[4] = 0.3;
        for (let i = 0; i < 30; i++) G.tick(1 / 60);
        const fz = G.minionFrenzyState();
        out.frenzy = { t: +fz.t.toFixed(2), mult: fz.mult, n: S.minions.length };
        for (let i = 0; i < 300; i++) G.tick(1 / 60);
        out.after = G.minionFrenzyState().mult;
        // 狂热的实际出手频率：同样 8 秒，仆从砍木桩的次数约多 30%（不是 1.3 × 1.3）
        const W = G.world;
        const ents = new Set(S.minions.map((m) => m.ent));
        let swings = 0;
        const play0 = W.play;
        W.play = function (ent, name) {
          if (name === 'attack' && ents.has(ent)) swings++;
          return play0.apply(this, arguments);
        };
        try {
          const dummy = T.mob('brute', -3.2, 0.6);
          for (let i = 0; i < 120; i++) G.tick(1 / 60);
          const count = (fz) => {
            swings = 0;
            if (fz) G.minionFrenzy(8.5, 0.3);
            for (let i = 0; i < 480; i++) {
              dummy.x = P.x - 3.2;
              dummy.z = P.z + 0.6;
              G.tick(1 / 60);
            }
            return swings;
          };
          const n0 = count(false);
          const n1 = count(true);
          out.swing = { n0, n1, k: +(n1 / Math.max(1, n0)).toFixed(2) };
        } finally {
          W.play = play0;
        }
        // 估算：穿插一次魂潮约为满编仆从秒伤的 +20–35%，单独循环施放打不过仆从
        const th = G.skillDps(G.skillCtx('thrall'));
        const wc = G.skillCtx('soultide');
        out.weave = +((G.avgHit(wc) / wc.cd) / th).toFixed(3);
        out.alone = +(G.skillDps(wc) / th).toFixed(3);
      } finally {
        save.equip.weapon = keepW;
        save.skills = sk0;
        G.computeStats();
        T.arena();
      }
      return out;
    });
    assert(r.ws === 'soultide' && /召唤物伤害提高 \d+%，召唤物最大生命提高 \d+%/.test(r.imp) && r.impStats, '魂幡的武器技 / 隐含属性不对：' + JSON.stringify(r));
    assert(r.scale.own === 1 && r.scale.minion > 1.5 && Math.abs(r.scale.minion - r.scale.wantM) < 0.002 && r.scale.lvl === r.scale.want, '魂潮的伤害应只吃召唤物伤害、等级 = 物品等级 × 0.75：' + JSON.stringify(r.scale));
    assert(r.solo.dmg > 0 && r.solo.splash > 0 && r.solo.maxP === 4 && r.solo.cd > 0, '没有召唤物时魂潮也应放出 4 只魂火、命中并炸开：' + JSON.stringify(r.solo));
    assert(r.fizzle === 0, '打空的魂火应散掉：' + r.fizzle);
    assert(r.frenzy.n === 2 && r.frenzy.mult === 1.3 && r.frenzy.t > 3 && r.after === 1, '召唤物应狂热约 4 秒（×1.3）：' + JSON.stringify(r));
    assert(r.weave >= 0.18 && r.weave <= 0.4 && r.alone < 1, '魂潮的强度不对：' + JSON.stringify(r));
    assert(r.swing.n0 >= 12 && r.swing.k >= 1.12 && r.swing.k <= 1.48, '狂热期间仆从的出手次数应多约 30%：' + JSON.stringify(r.swing));
    return '单发 ' + r.solo.dmg + '（溅射 ' + r.solo.splash + '），穿插 +' + Math.round(r.weave * 100) + '%（不算狂热），狂热 ×' + r.frenzy.mult + '（8 秒出手 ' + r.swing.n0 + ' → ' + r.swing.n1 + ' 次）';
  });

  await step('武器技共用冷却（换另一类武器带着剩余冷却）；瞬断被翻滚打断只斩冲过的那段；换装评估列出武器技；处决按秒伤算', async () => {
    const r = await ev(() => {
      const P = G.player, save = G.save, out = {};
      const keepW = save.equip.weapon;
      const bag0 = save.bag.slice();
      const bar0 = save.bar.slice();
      const run = (n, f) => { for (let i = 0; i < n; i++) { if (f) f(); G.tick(1 / 60); } };
      try {
        // 1) 震地进冷却后换成刃：回锋斩带着同样比例的冷却，不能立刻放；换回同类的另一把锤，震地冷却照旧
        T.arena();
        const L = Math.max(5, save.level);
        const hammer = G.rollItem(L, 0, 'weapon', 4), blade = G.rollItem(L, 0, 'weapon', 0), hammer2 = G.rollItem(L, 0, 'weapon', 4);
        save.bag.push(hammer, blade, hammer2);
        G.equip(hammer);
        const e = T.mob('brute', 0, 3);
        e.poiseMax = 0;
        G.input.tap[4] = 0.3;
        run(80, () => T.aim(P.x, P.z + 3));
        const q = P.cds.quake || 0, qMax = P.cdMax.quake || 1;
        G.equip(blade);
        const rip = P.cds.riposte || 0, ripMax = G.skillCtx('riposte').cd;
        G.input.tap[4] = 0.3;
        run(20, () => T.aim(P.x, P.z + 3));
        out.swap = { q: +q.toFixed(2), rip: +rip.toFixed(2), frac: +(rip / ripMax - q / qMax).toFixed(3), cast: !!(P.cast && P.cast.id === 'riposte') };
        G.equip(hammer2);
        out.swap.same = (P.cds.quake || 0) > 0;
        // 起手途中换成另一类武器：还没生效的那一招作废，不会用新武器打出旧武器技
        T.arena();
        G.equip(hammer);
        T.mob('brute', 0, 3).poiseMax = 0;
        G.input.tap[4] = 0.3;
        run(10, () => T.aim(P.x, P.z + 3));
        const started = !!(P.cast && P.cast.id === 'quake' && !P.cast.fired);
        G.equip(blade);
        run(60, () => T.aim(P.x, P.z + 3));
        out.swap.mid = { started, quakeCd: P.cds.quake || 0, ripCd: P.cds.riposte || 0 };
        // 2) 瞬断：冲刺第一帧就翻滚取消 → 远处的敌人不挨斩；不取消时两只都挨
        const katana = (cancel) => {
          T.arena();
          save.equip.weapon = G.rollItem(L, 0, 'weapon', 6);
          G.computeStats();
          P.mana = P.maxMana;
          const near = T.mob('brute', 0, 2), far = T.mob('brute', 0, 6);
          near.poiseMax = far.poiseMax = 0;
          const z0 = P.z;
          let dodged = false;
          G.input.tap[4] = 0.3;
          run(90, () => {
            T.aim(P.x, z0 + 9);
            if (cancel && !dodged && P.cast && P.cast.fired && P.cast.tick) { dodged = G.dodge(); }
          });
          return { near: Math.round(near.maxHp - near.hp), far: Math.round(far.maxHp - far.hp), dodged };
        };
        out.cut = { full: katana(false), cancel: katana(true) };
        // 3) 换装评估：同类武器比武器技秒伤，换另一类武器列出换成了什么
        T.arena();
        save.bar = ['ember', null, null, null];
        const st1 = G.rollItem(1, 0, 'weapon', 1), st2 = G.rollItem(20, 0, 'weapon', 1), bw = G.rollItem(20, 0, 'weapon', 0);
        st1.imp = st2.imp = { stat: 'incElem', v: 20 };
        save.equip.weapon = st1;
        G.computeStats();
        st2.uid = 'vd-st2-' + Date.now();
        bw.uid = 'vd-bw-' + Date.now();
        const v1 = G.ui.verdict(st2), v2 = G.ui.verdict(bw);
        const l1 = v1.lines.find((l) => l.label.indexOf('武器技') === 0), l2 = v2.lines.find((l) => l.label === '武器技');
        out.vd = { badge: v1.badge, l1: l1 && l1.label + ' ' + l1.text, l2: l2 && l2.text };
        // 4) 处决基数：同样武器秒伤的战锤和双匕一样重
        T.arena();
        save.bar = ['cleave', null, null, null];
        const ex = (b, base) => { const w = G.rollItem(9, 0, 'weapon', b); w.wbase = base; w.imp = null; G.refreshWeapon(w); save.equip.weapon = w; G.computeStats(); return G.execBase(); };
        out.exec = { hammer: ex(4, [15, 15]), daggers: ex(3, [10, 10]) };
      } finally {
        save.bag = bag0;
        save.bar = bar0;
        save.equip.weapon = keepW;
        G.computeStats();
        P.cds = {};
        P.cast = null;
      }
      return out;
    });
    const sw = r.swap;
    assert(sw.q > 4 && sw.rip > 2 && Math.abs(sw.frac) < 0.03 && !sw.cast && sw.same && sw.mid.started && sw.mid.quakeCd === 0 && sw.mid.ripCd === 0, '换另一类武器应带着剩余冷却（按比例），同类武器保持冷却：' + JSON.stringify(sw));
    const c = r.cut;
    assert(c.full.near > 0 && c.full.far > 0 && c.cancel.dodged && c.cancel.far === 0 && c.cancel.near === 0, '瞬断被翻滚取消时只该斩冲过的那段：' + JSON.stringify(c));
    assert(r.vd.badge === 'up' && r.vd.l1 && /地脉涌/.test(r.vd.l1) && /「地脉涌」 → 「回锋斩」/.test(r.vd.l2 || ''), '换装评估应列出武器技的变化：' + JSON.stringify(r.vd));
    assert(Math.abs(r.exec.hammer / r.exec.daggers - 1) < 0.01, '同样秒伤的战锤和双匕处决基数应一样：' + JSON.stringify(r.exec));
    return '换类冷却 ' + sw.q + ' → ' + sw.rip + '，瞬断取消 ' + JSON.stringify(c.cancel) + '，评估 ' + r.vd.l1;
  });

  await step('武器技的动作与特效：各自的 w_<类型> 动作、命中帧和伤害同一刻；用 world 的专用特效（不是通用顶替）；短杖秘弹是追踪弹模型并在命中处炸开', async () => {
    const r = await ev(() => {
      const P = G.player, S = G.state, W = G.world, save = G.save;
      const keepW = save.equip.weapon;
      // 记下每个专用特效被调用的次数，以及调用那一刻玩家动作的进度 / 命中帧
      const FX = ['thrustFx', 'sweepFx', 'groundBurst', 'shadowStep', 'shockwave', 'dashCut', 'cutLine', 'makeSeeker', 'seekerFx', 'makeWisp', 'soulTide', 'wispBurst'];
      const orig = {};
      let log = [];
      const has = FX.filter((n) => typeof W[n] === 'function'); // 只包 world 真有的（魂幡的特效可选，没有时 game 用通用特效顶上）
      for (const n of has) {
        orig[n] = W[n];
        W[n] = function () {
          const c = P.ent.clip;
          log.push({ n, clip: c ? c.name : null, k: P.ent.cK, k0: c ? c.k0 : -1 });
          return orig[n].apply(W, arguments);
        };
      }
      const out = {};
      try {
        for (const b of [0, 1, 2, 3, 4, 6, 7]) {
          T.arena();
          G.debug.god(true);
          save.bar = save.bar.map((x) => (x === 'nova' ? null : x));
          save.equip.weapon = G.rollItem(5, 0, 'weapon', b);
          G.computeStats();
          const type = G.BASES.weapon[b].type;
          const c = S.zone.circles[0];
          T.tp(c.x - 5, c.z);
          const ms = [T.mob('brute', 4, 0), T.mob('brute', 5.4, 1.1), T.mob('brute', 5.4, -1.1)];
          T.aim(P.x + 4.6, P.z);
          log = [];
          G.input.tap[4] = 0.3;
          G.tick(1 / 60);
          const clip0 = W.clipOf(P.ent);
          for (let i = 0; i < 150; i++) {
            T.aim(ms[0].x + 0.6, ms[0].z);
            G.tick(1 / 60);
          }
          const cnt = {};
          for (const l of log) cnt[l.n] = (cnt[l.n] || 0) + 1;
          out[type] = { clip0, cnt, log: log.slice(0, 4), hit: ms.filter((e) => e.hp < e.maxHp).length, seekers: S.projectiles.length };
        }
      } finally {
        for (const n of has) W[n] = orig[n];
        save.equip.weapon = keepW;
        G.computeStats();
        G.debug.god(false);
      }
      out.has = has;
      return out;
    });
    const NEED = { blade: ['thrustFx', 'sweepFx'], staff: ['groundBurst'], wand: ['makeSeeker', 'seekerFx'], daggers: ['shadowStep', 'thrustFx'], hammer: ['shockwave'], katana: ['dashCut', 'cutLine'], banner: ['makeWisp', 'soulTide'].filter((n) => r.has.indexOf(n) >= 0) };
    // 命中帧：这个特效被调用时，动作进度应在命中帧附近（刃的第二段是回身横扫，在 k≈0.62）
    const CONTACT = { blade: ['thrustFx', null], staff: ['groundBurst', null], daggers: ['thrustFx', null], hammer: ['shockwave', null], katana: ['dashCut', null], banner: r.has.indexOf('soulTide') >= 0 ? ['soulTide', null] : null };
    for (const type of Object.keys(NEED)) {
      const o = r[type];
      assert(o.clip0 === 'w_' + type, type + '：应播放自己的武器技动作 w_' + type + '：' + o.clip0);
      for (const n of NEED[type]) assert(o.cnt[n] > 0, type + '：应调用 world.' + n + '：' + JSON.stringify(o.cnt));
      assert(o.hit >= 1, type + '：没有打中任何敌人');
      if (CONTACT[type]) {
        const l = o.log.find((x) => x.n === CONTACT[type][0]);
        assert(l && l.clip === 'w_' + type && Math.abs(l.k - l.k0) < 0.07, type + '：伤害那一刻动作应在命中帧附近：' + JSON.stringify(l));
      }
    }
    const sw = r.blade.log.find((x) => x.n === 'sweepFx');
    assert(sw && Math.abs(sw.k - 0.62) < 0.08, '回锋斩的横扫应和动作的回身一扫同一刻：' + JSON.stringify(sw));
    assert(r.wand.cnt.makeSeeker === 5, '秘弹连射应射出 5 枚追踪弹模型：' + JSON.stringify(r.wand.cnt));
    assert(r.wand.hit >= 2, '秘弹在命中处炸开，应波及目标身边的敌人：' + r.wand.hit);
    assert(r.katana.cnt.cutLine >= 2, '瞬断应给每个穿过的敌人一道斩线：' + JSON.stringify(r.katana.cnt));
    return Object.keys(NEED).map((t) => t + ' ' + NEED[t].map((n) => n + '×' + r[t].cnt[n]).join('+')).join('，');
  });

  // ---------- 远程武器（枪械 / 弓） ----------
  // 远程步骤共用：换上一把指定基底的普通武器（平均成色、没有隐含属性），在起点空地朝 +x 摆靶子
  const rangedSetup = `
    window.RW = {
      arm(b, ilvl) {
        const it = G.rollItem(ilvl || 10, 0, 'weapon', b);
        it.wbase = G.weaponBaseDmg(b, ilvl || 10);
        it.imp = null;
        G.refreshWeapon(it);
        G.save.equip.weapon = it;
        G.computeStats();
        return it;
      },
      // 按住右键 n 帧（准星一直对着 aim），返回期间的统计
      hold(n, aim, btn) {
        const P = G.player;
        let firing = 0;
        for (let i = 0; i < n; i++) {
          if (aim) T.aim(aim.x, aim.z);
          G.input.mouse.b[btn === undefined ? 2 : btn] = true;
          G.tick(1 / 60);
          if (P.cast && P.cast.ranged) firing++;
        }
        G.input.mouse.b[btn === undefined ? 2 : btn] = false;
        return firing;
      },
      run(n, aim) {
        for (let i = 0; i < n; i++) {
          if (aim) T.aim(aim.x, aim.z);
          G.tick(1 / 60);
        }
      },
    };`;

  await step('远程武器：拿上枪械 / 弓时右键自动换成武器普攻（右键绑不上别的、新学的技能也不进右键），原来的右键技能记着，换回近战武器原样放回；存档刷新后不丢', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, out = {};
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      try {
        T.lane();
        save.bar = ['cleave', 'ember', null, null];
        save.rmbKeep = null;
        G.computeStats();
        out.before = G.slotSkill(1);
        for (const b of [8, 9, 5, 10, 11]) {
          RW.arm(b);
          const rw = G.rangedWeapon();
          (out.rw = out.rw || []).push(rw.type + ':' + rw.family + ':' + rw.basic + ':' + rw.gauge.kind + ':' + G.slotSkill(1) + ':' + (save.bar[1] === null) + ':' + save.rmbKeep);
        }
        // 右键绑不上；别的格子照常
        out.bindR = G.bindSkill(1, 'cleave');
        out.bindQ = G.bindSkill(2, 'ember');
        out.barQ = save.bar.join();
        // 收着的右键技能被你绑到了 Q：换回近战武器时右键空着（不会一个技能占两格）
        out.keepAfterQ = save.rmbKeep;
        G.bindSkill(2, null);
        save.rmbKeep = 'ember';
        // 新学的技能：右键不算空格
        delete save.skills.meteor;
        save.bar = ['cleave', null, null, 'arc'];
        save.skills.arc = save.skills.arc || 1;
        G.computeStats();
        G.debug.learnAll && null;
        G.state.loot.length = 0;
        const l = G.spawnLoot('skill', { id: 'meteor', lvl: 3 }, P.x, P.z);
        G.pickup(l);
        out.learn = save.bar.join();
        // 按右键：放出的是普攻（不是收着的掷焰）
        const tg = T.mob('brute', 6, 0);
        RW.arm(10);
        RW.hold(40, tg);
        out.cast = { hp: Math.round(tg.maxHp - tg.hp), shots: G.state.stats.rShots || 0 };
        // 存档：刷新（读档）后 rmbKeep 还在、右键仍是普攻
        G.persist();
        G.loadSave();
        G.computeStats();
        out.reload = save.rmbKeep + '|' + save.bar.join() + '|' + G.slotSkill(1);
        // 换回刃：放回原来的右键技能
        save.equip.weapon = T.stdBlade(10);
        G.computeStats();
        out.restored = save.bar.join() + '|' + save.rmbKeep + '|' + G.slotSkill(1);
        // 换装评估：近战 → 远程时右键换成普攻，单列「右键：掷焰 → 开火」并比两边右键的秒伤（不出 NaN）；试穿完技能栏原样
        const fin = (v) => isFinite(v.score) && v.lines.every((l) => !/NaN/.test(l.text) && (l.pct === null || isFinite(l.pct)));
        const gun = G.rollItem(40, 2, 'weapon', 8);
        gun.uid = 'vd-gun-' + Date.now();
        const vg = G.ui.verdict(gun);
        out.vdGun = { badge: vg.badge, fin: fin(vg), rmb: (vg.lines.find((x) => x.label === '右键') || {}).text, rd: !!vg.lines.find((x) => x.label === '右键秒伤'), bar: save.bar.join() + '|' + save.rmbKeep };
        // 远程 → 近战：反过来，掷焰回到右键
        save.equip.weapon = gun;
        G.computeStats();
        const bl = T.stdBlade(2);
        bl.uid = 'vd-bl-' + Date.now();
        const vb = G.ui.verdict(bl);
        out.vdBlade = { badge: vb.badge, fin: fin(vb), rmb: (vb.lines.find((x) => x.label === '右键') || {}).text };
        // 弓 → 更强的同类弓：普攻（射击）的秒伤算进评估
        const weak = G.rollItem(2, 0, 'weapon', 5);
        save.equip.weapon = weak;
        G.computeStats();
        const strong = G.rollItem(40, 2, 'weapon', 5);
        strong.uid = 'vd-bow-' + Date.now();
        const vw = G.ui.verdict(strong);
        out.vdBow = { badge: vw.badge, fin: fin(vw), basic: !!vw.lines.find((x) => x.label === '射击 秒伤' && x.good) };
        save.equip.weapon = T.stdBlade(10);
        G.computeStats();
        // 换回近战时右键已经有了别的技能：不覆盖，收着的那个丢开
        RW.arm(8);
        save.bar[1] = 'arc'; // 理论上绑不上；直接写进去模拟旧数据
        save.bar[3] = null;
        G.computeStats();
        out.clash = save.bar.join() + '|' + save.rmbKeep;
      } finally {
        save.equip.weapon = keepW;
        T.buildRestore(snap);
        save.rmbKeep = null;
        G.computeStats();
      }
      return out;
    }, rangedSetup);
    assert(r.before === 'ember', '起点右键应是掷焰：' + r.before);
    assert(r.rw.length === 5 && r.rw.every((x) => /:basic_\w+:(heat|focus):basic_\w+:true:ember$/.test(x)), '拿上远程武器时右键应是武器普攻、原技能收进 rmbKeep：' + r.rw.join(' | '));
    assert(/^gatling:gun:basic_gatling:heat/.test(r.rw[0]) && /^eagle:bow:basic_eagle:focus/.test(r.rw[2]), '武器族 / 量表不对：' + r.rw.join(' | '));
    assert(r.bindR === false && r.bindQ === true && r.barQ === 'cleave,,ember,' && r.keepAfterQ === null, '右键应绑不上、别的格子照常；收着的技能绑到别处后不再放回：' + JSON.stringify(r));
    assert(r.learn.split(',')[1] === '' && r.learn.indexOf('meteor') >= 0, '新学的技能不应放进被占着的右键：' + r.learn);
    assert(r.cast.hp > 0 && r.cast.shots > 0, '按右键应射出武器普攻：' + JSON.stringify(r.cast));
    assert(r.reload === 'ember|cleave,,meteor,arc|basic_huntbow', '读档后右键接管与收着的技能应保留：' + r.reload);
    assert(r.restored === 'cleave,ember,meteor,arc|null|ember', '换回近战武器应放回原来的右键技能：' + r.restored);
    assert(r.vdGun.fin && r.vdGun.badge !== 'eq' && r.vdGun.rmb === '「掷焰」 → 「开火」' && r.vdGun.rd && r.vdGun.bar === 'cleave,ember,meteor,arc|null', '近战换远程的评估应列出右键的变化、数值有限、试穿后技能栏不变：' + JSON.stringify(r.vdGun));
    assert(r.vdBlade.fin && r.vdBlade.rmb === '「开火」 → 「掷焰」', '远程换近战的评估应列出右键换回来：' + JSON.stringify(r.vdBlade));
    assert(r.vdBow.fin && r.vdBow.badge === 'up' && r.vdBow.basic, '弓换更强的弓应把射击的秒伤算进去：' + JSON.stringify(r.vdBow));
    // 已经收着一个（掷焰）时又冒出一个：右键照样清空，收着的仍是原来那个
    assert(r.clash === 'cleave,,meteor,|ember', '拿着远程武器时右键上的技能应被清掉、原来收着的不变：' + r.clash);
    return r.rw.map((x) => x.split(':').slice(0, 2).join('/')).join('、') + ' · 换回 ' + r.restored.split('|')[0];
  });

  await step('武器普攻卡：3 个辅助孔属于卡片（换远程武器时宝石不动），按当前普攻的标签生效（多重投射对机炮生效、对喷枪不生效；扩域反过来）；伤害按武器伤害 × 倍率；存档修正', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, out = {};
      const snap = T.buildSnap();
      const keepW = save.equip.weapon;
      try {
        T.lane();
        for (const id of ['multi', 'expanse', 'brutal', 'echo', 'dominion']) if (save.supports.indexOf(id) < 0) save.supports.push(id);
        const card = G.BASIC_CARD;
        save.sockets[card] = [null, null, null];
        RW.arm(8);
        out.fits = ['multi', 'expanse', 'brutal', 'echo', 'dominion', 'pierce', 'haste'].map((s) => s + ':' + G.supportFits(card, s)).join(' ');
        out.sock = [G.socketSupport(card, 0, 'multi'), G.socketSupport(card, 1, 'expanse'), G.socketSupport(card, 2, 'echo')];
        const g = G.skillCtx('basic_gatling');
        out.gat = { proj: g.proj, area: g.area, active: G.basicSupports('basic_gatling').join() };
        // 普攻伤害 = 武器伤害 × wm × 等级加成，出手节奏乘武器攻速
        const w = G.weaponStats(save.equip.weapon);
        out.formula = Math.abs(g.base.phys[0] - w.min * G.SKILLS.basic_gatling.wm * g.levelK * 0.75) < 1e-6 || Math.abs(g.base.phys[0] - w.min * G.SKILLS.basic_gatling.wm * g.levelK) < 1e-6;
        RW.arm(9);
        const f = G.skillCtx('basic_flamer');
        out.fla = { proj: f.proj, area: f.area, active: G.basicSupports('basic_flamer').join(), fire: Object.keys(f.base).join() };
        out.still = save.sockets[card].join();
        // 存档：卡片的宝石刷新后还在；不适配的（回响）、没有的宝石被丢掉
        save.sockets[card] = ['multi', 'expanse', 'echo'];
        G.persist();
        G.loadSave();
        G.computeStats();
        out.saved = save.sockets[card].join();
        // 实战：多重投射让机炮每次出 3 发
        RW.arm(8);
        save.sockets[card] = ['multi', null, null];
        G.computeStats();
        G.state.projectiles.length = 0;
        const tg = T.mob('brute', 8, 0);
        let maxP = 0, spawned = 0;
        const sp0 = G.spawnProjectile, shots0 = G.state.stats.rShots || 0;
        G.spawnProjectile = function (p) { if (p.owner === 'p') spawned++; return sp0.apply(this, arguments); };
        for (let i = 0; i < 70; i++) {
          T.aim(tg.x, tg.z);
          G.input.mouse.b[2] = true;
          G.tick(1 / 60);
          maxP = Math.max(maxP, G.state.projectiles.length);
        }
        G.input.mouse.b[2] = false;
        out.multiShots = maxP;
        out.perShot = +(spawned / Math.max(1, (G.state.stats.rShots || 0) - shots0)).toFixed(2);
        G.spawnProjectile = sp0;
      } finally {
        save.equip.weapon = keepW;
        T.buildRestore(snap);
        save.sockets[G.BASIC_CARD] = [null, null, null];
        G.computeStats();
      }
      return out;
    }, rangedSetup);
    assert(/multi:true/.test(r.fits) && /expanse:true/.test(r.fits) && /brutal:true/.test(r.fits) && /echo:false/.test(r.fits) && /dominion:false/.test(r.fits), '武器普攻卡能镶的辅助不对：' + r.fits);
    assert(r.sock[0] && r.sock[1] && !r.sock[2], '镶嵌结果不对：' + JSON.stringify(r.sock));
    assert(r.gat.proj === 3 && r.gat.area === 1 && r.gat.active === 'multi', '机炮应吃多重投射、不吃扩域：' + JSON.stringify(r.gat));
    assert(r.fla.proj === 1 && r.fla.area > 1.3 && r.fla.active === 'expanse' && r.fla.fire === 'fire', '喷枪应吃扩域、不吃多重投射，伤害全是火焰：' + JSON.stringify(r.fla));
    assert(r.formula, '普攻伤害应是武器伤害 × 倍率');
    assert(r.still === 'multi,expanse,', '换远程武器时卡上的宝石不该动：' + r.still);
    assert(r.saved === 'multi,expanse,', '存档里卡片的宝石应保留、不适配的丢掉：' + r.saved);
    assert(r.perShot === 3 && r.multiShots >= 3, '多重投射的机炮每次应出 3 发：' + JSON.stringify([r.perShot, r.multiShots]));
    return '机炮 ' + r.gat.active + ' · 喷枪 ' + r.fla.active + ' · 存档 ' + r.saved;
  });

  await step('远程普攻：机炮先空转约 0.5 秒才开火、射速越打越快、开火时走得慢；喷枪的扇面灼烧并留下余烬；左轮 6 发后自动装填；弓的箭有拉弓、追猎会拐弯、鹰眼远距离更痛、符文带元素', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, out = {};
      const keepW = save.equip.weapon;
      try {
        // 机炮：第一发的时刻、前 1 秒与第 3 秒的射速、移动倍率
        T.lane();
        RW.arm(8);
        const tg = T.mob('brute', 8, 0);
        const shots = [];
        let s0 = S.stats.rShots || 0, mv = null;
        for (let i = 0; i < 60 * 3.2; i++) {
          T.aim(tg.x, tg.z);
          G.input.mouse.b[2] = true;
          G.tick(1 / 60);
          const n = (S.stats.rShots || 0) - s0;
          shots.push(n);
          if (i === 100 && P.cast) mv = P.cast.move;
        }
        G.input.mouse.b[2] = false;
        out.spin0 = P.gun.spin;
        RW.run(60);
        const first = shots.findIndex((n) => n > 0) / 60;
        const r1 = shots[Math.round(60 * (first + 0.5))] - shots[Math.round(60 * first)];
        const r3 = shots[60 * 3.1 | 0] - shots[Math.round(60 * 2.6)];
        out.gat = { first: +first.toFixed(2), early: r1, late: r3, move: mv, heat: Math.round(P.gauge.heat), spin: +P.gun.spin.toFixed(2) };
        out.spin0 = +out.spin0.toFixed(2);
        // 喷枪：扇面里的敌人挨打，扇面外的不挨；地上留下余烬并灼烧
        T.lane();
        RW.arm(9);
        const inC = T.mob('husk', 3, 0, { hp: 1e6 }), side = T.mob('husk', 0, 3.5, { hp: 1e6 }), far = T.mob('husk', 9, 0, { hp: 1e6 });
        for (const e of [inC, side, far]) G.initBuildUp(e); // 阈值按改过的生命重算（不然几跳就爆燃，炸到旁边的）
        RW.hold(60, { x: inC.x, z: inC.z });
        out.fla = { inC: Math.round(inC.maxHp - inC.hp), side: Math.round(side.maxHp - side.hp), far: Math.round(far.maxHp - far.hp), fields: G.rangedFields().length, fire: inC.bu ? +inC.bu.fire.toPrecision(3) : 0 };
        // 余烬：普攻停了之后，站在余烬里的敌人还在挨烧
        const hp1 = inC.hp;
        RW.run(60);
        out.fla.burn = Math.round(hp1 - inC.hp);
        // 左轮：6 发后装填（装填期间不开火），装完接着打
        T.lane();
        RW.arm(12);
        const rv = T.mob('brute', 7, 0);
        s0 = S.stats.rShots || 0;
        let reloadSeen = false, ammoMin = 9;
        for (let i = 0; i < 60 * 3; i++) {
          T.aim(rv.x, rv.z);
          G.input.mouse.b[2] = true;
          G.tick(1 / 60);
          if (P.gun.reloadT > 0) reloadSeen = true;
          ammoMin = Math.min(ammoMin, P.gun.ammo);
        }
        G.input.mouse.b[2] = false;
        out.rev = { shots: (S.stats.rShots || 0) - s0, reloadSeen, ammoMin, heat: Math.round(P.gauge.heat) };
        // 追猎：朝旁边射，箭也会拐向敌人
        T.lane();
        RW.arm(10);
        const hb = T.mob('brute', 6, 2.2);
        RW.hold(20, { x: P.x + 6, z: P.z - 2.5 });
        RW.run(60);
        out.hunt = Math.round(hb.maxHp - hb.hp);
        // 鹰眼：远距离（12）比近距离（4.5）痛；暴击率高
        T.lane();
        RW.arm(5);
        T.fix(0.5);
        const ctxE = G.skillCtx('basic_eagle'), ctxH = G.skillCtx('basic_huntbow');
        out.eagleCrit = [ctxE.crit, ctxE.critMulti, ctxH.crit, ctxH.critMulti];
        const near = T.mob('brute', 4.5, 0);
        RW.hold(12, { x: near.x, z: near.z });
        RW.run(40);
        G.clearEnemies(); // 同一条线上换一个远的靶子（没有贯穿，近的会挡箭）
        const farE = T.mob('brute', 12, 0);
        RW.hold(12, { x: farE.x, z: farE.z });
        RW.run(60);
        out.eagle = { near: Math.round(near.maxHp - near.hp), far: Math.round(farE.maxHp - farE.hp) };
        T.unfix();
        // 符文：没有元素加成时火 / 冰 / 雷轮流；有冰霜加成时取冰霜
        T.lane();
        RW.arm(11);
        const els = [];
        for (let i = 0; i < 3; i++) {
          P.gun.cycle++;
          els.push(Object.keys(G.skillCtx('basic_runebow').base).filter((t) => t !== 'phys').join());
        }
        P.S.incCold = (P.S.incCold || 0) + 30;
        els.push(Object.keys(G.skillCtx('basic_runebow').base).filter((t) => t !== 'phys').join());
        G.computeStats();
        out.rune = els.join(' ');
      } finally {
        T.unfix();
        save.equip.weapon = keepW;
        G.computeStats();
        T.arena();
      }
      return out;
    }, rangedSetup);
    const g = r.gat;
    assert(g.first >= 0.45 && g.first <= 0.65, '机炮应空转约 0.5 秒才开第一枪：' + JSON.stringify(g));
    assert(g.late > g.early * 1.6 && g.late >= 5, '机炮的射速应越打越快：' + JSON.stringify(g));
    assert(g.move <= 0.4 && g.heat > 8 && r.spin0 === 1 && g.spin === 0, '机炮开火时应走得慢、积攒热度，松手后枪管停转：' + JSON.stringify(g));
    const f = r.fla;
    assert(f.inC > 0 && f.side === 0 && f.far === 0 && f.fields >= 2 && f.fire > 0 && f.burn > 0, '喷枪的扇面 / 余烬不对：' + JSON.stringify(f));
    assert(r.rev.reloadSeen && r.rev.ammoMin === 0 && r.rev.shots >= 9 && r.rev.shots <= 13 && r.rev.heat > 15, '左轮应 6 发一装填：' + JSON.stringify(r.rev));
    assert(r.hunt > 0, '追猎弓的箭应拐向旁边的敌人：' + r.hunt);
    assert(r.eagleCrit[0] > r.eagleCrit[2] + 8 && r.eagleCrit[1] >= r.eagleCrit[3] + 50, '鹰眼长弓应自带高暴击：' + r.eagleCrit);
    assert(r.eagle.far > r.eagle.near * 1.15, '鹰眼长弓远距离应更痛：' + JSON.stringify(r.eagle));
    assert(r.rune.split(' ').slice(0, 3).sort().join() === 'cold,fire,light' && r.rune.split(' ')[3] === 'cold', '符文弓的元素不对：' + r.rune);
    return '机炮首发 ' + g.first + 's、射速 ' + g.early + ' → ' + g.late + '/0.5s · 喷枪 ' + f.inC + '+余烬 ' + f.burn + ' · 左轮 ' + r.rev.shots + ' 发 · 鹰眼 近 ' + r.eagle.near + ' / 远 ' + r.eagle.far;
  });

  await step('量表：热度开火上涨、停火回落、满了不掉；专注命中上涨（暴击 / 远距离更多），挨打掉一点；量表没满时 R 灰着按不出，满了能放、放完清零；不扣魔力、不进冷却', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, out = {};
      const keepW = save.equip.weapon;
      try {
        T.lane();
        RW.arm(8);
        const tg = T.mob('brute', 8, 0);
        // 没满：R 按不出
        P.gauge.heat = 50;
        G.input.tap[4] = 0.3;
        RW.run(20, tg);
        out.blocked = { cast: !!(P.cast && P.cast.ws), heat: P.gauge.heat, ready: G.gaugeReady() };
        // 开火上涨、停火回落
        P.gauge.heat = 0;
        RW.hold(150, tg);
        const h1 = P.gauge.heat;
        RW.run(60 * 4);
        out.heat = { fire: Math.round(h1), after: Math.round(P.gauge.heat) };
        // 满了不掉
        G.debug.gauge();
        RW.run(60 * 4);
        out.fullStays = P.gauge.heat;
        // 满了：R 放得出，量表清零；不扣魔力、不进冷却
        const m0 = P.mana;
        G.input.tap[4] = 0.3;
        RW.run(40, tg);
        out.fire = { ws: G.weaponSkill(), heat: P.gauge.heat, mana: +(m0 - P.mana).toFixed(1), cd: P.cds.meltray || 0, uses: S.stats.rUses || 0 };
        RW.run(60 * 3.5, tg);
        // 弓：专注命中上涨、暴击更多、挨打掉一点、增益期间不涨
        T.lane();
        RW.arm(10);
        const b1 = T.mob('brute', 5, 0);
        T.fix(0.5);
        P.gauge.focus = 0;
        RW.hold(60, b1);
        RW.run(40);
        const f1 = P.gauge.focus, hits1 = S.stats.rHits;
        P.gauge.focus = 0;
        T.fix(0); // 必定暴击
        RW.hold(60, b1);
        RW.run(40);
        const f2 = P.gauge.focus;
        T.unfix();
        out.focus = { normal: +f1.toFixed(1), crit: +f2.toFixed(1) };
        const f3 = P.gauge.focus;
        P.iframe = 0;
        G.hurtPlayer(5, 'phys', { x: P.x + 1, z: P.z });
        out.focus.hurt = +(f3 - P.gauge.focus).toFixed(1);
        // 没满：R 按不出
        G.input.tap[4] = 0.3;
        RW.run(20);
        out.focus.blocked = !P.rbuff;
        // 满了：增益开、专注清零；增益期间命中不涨
        G.debug.gauge();
        G.input.tap[4] = 0.3;
        RW.run(30);
        out.focus.buff = P.rbuff && P.rbuff.id;
        out.focus.after = P.gauge.focus;
        RW.hold(60, b1);
        out.focus.during = P.gauge.focus;
      } finally {
        T.unfix();
        save.equip.weapon = keepW;
        G.computeStats();
        T.arena();
      }
      return out;
    }, rangedSetup);
    assert(!r.blocked.cast && r.blocked.heat > 40 && r.blocked.heat < 100 && !r.blocked.ready, '热度没满时 R 不应施放：' + JSON.stringify(r.blocked));
    assert(r.heat.fire >= 8 && r.heat.after < r.heat.fire, '热度应开火上涨、停火回落：' + JSON.stringify(r.heat));
    assert(r.fullStays === 100, '满了的热度不应回落：' + r.fullStays);
    assert(r.fire.ws === 'meltray' && r.fire.heat === 0 && r.fire.mana <= 0 && r.fire.cd === 0 && r.fire.uses >= 1, '热度满时 R 应放出熔光射线、清零、不扣魔力不进冷却：' + JSON.stringify(r.fire));
    const f = r.focus;
    assert(f.normal > 3 && f.crit > f.normal * 1.5 && f.hurt > 0, '专注应命中上涨、暴击更多、挨打下降：' + JSON.stringify(f));
    assert(f.blocked && f.buff === 'volley' && f.after === 0 && f.during === 0, '专注满了才能放、放完清零、增益期间不涨：' + JSON.stringify(f));
    return '热度 开火 ' + r.heat.fire + ' → 停火 ' + r.heat.after + ' · 专注 普通 ' + f.normal + ' / 暴击 ' + f.crit + ' / 挨打 −' + f.hurt;
  });

  await step('枪械的 R：熔光射线 3 秒贯穿一条线、跟着准星转、同时累积火与雷的异常值；焚天炎爆炸开一大圈并留下火场；乱射 3 秒自动打身边的敌人、翻滚也不断、照常走动', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, out = {};
      const keepW = save.equip.weapon;
      const th0 = G.BUILDUP.th;
      try {
        G.BUILDUP.th = 50; // 异常值慢一点，看得出两种都在涨
        T.lane();
        RW.arm(8);
        const line = [T.mob('brute', 4, 0, { hp: 1e7 }), T.mob('brute', 8, 0.3, { hp: 1e7 }), T.mob('brute', 12, -0.3, { hp: 1e7 })];
        const off = T.mob('brute', 5, 6, { hp: 1e7 });
        G.debug.gauge();
        G.input.tap[4] = 0.3;
        const t0 = S.time;
        let castT = 0;
        for (let i = 0; i < 60 * 1.6; i++) {
          T.aim(P.x + 10, P.z);
          G.tick(1 / 60);
          if (P.cast && P.cast.id === 'meltray') castT = S.time - t0;
        }
        out.line = line.map((e) => Math.round(e.maxHp - e.hp));
        out.bu = { fire: +(line[0].bu ? line[0].bu.fire : 0).toFixed(3), light: +(line[0].bu ? line[0].bu.light : 0).toFixed(3) };
        const offHp0 = off.hp;
        // 准星转到上方：光束慢慢转过去，扫到 off
        for (let i = 0; i < 60 * 2; i++) {
          T.aim(off.x, off.z);
          G.tick(1 / 60);
          if (P.cast && P.cast.id === 'meltray') castT = S.time - t0;
        }
        out.turn = Math.round(offHp0 - off.hp);
        out.castT = +castT.toFixed(2);
        out.ticks = S.stats.beamTicks || 0;
        // 焚天炎爆
        T.lane();
        RW.arm(9);
        const ring = [T.mob('husk', 3, 0.8, { hp: 1e6 }), T.mob('husk', 5, -0.8, { hp: 1e6 }), T.mob('husk', 6.8, 0, { hp: 1e6 })];
        const out9 = T.mob('husk', 11, 0, { hp: 1e6 });
        G.debug.gauge();
        G.input.tap[4] = 0.3;
        RW.run(40);
        out.nova = { hit: ring.map((e) => Math.round(e.maxHp - e.hp)), far: Math.round(out9.maxHp - out9.hp), heat: P.gauge.heat, fields: G.rangedFields().filter((f) => f.kind === 'burn').length };
        const hp2 = ring[0].hp;
        RW.run(60 * 2);
        out.nova.burn = Math.round(hp2 - ring[0].hp);
        // 乱射：烬铸左轮（熔芯）
        T.lane();
        const u = G.rollUnique('rongxin', 30, 0.5);
        save.equip.weapon = u;
        G.computeStats();
        out.wsU = G.weaponSkill();
        const around = [T.mob('brute', 5, 0), T.mob('brute', -5, 1), T.mob('brute', 0, -6)];
        G.debug.gauge();
        G.input.tap[4] = 0.3;
        RW.run(20);
        out.wild = { on: !!P.rstate, heat: P.gauge.heat };
        const x0 = P.x;
        G.input.keys.KeyD = true;
        RW.run(30);
        G.dodge();
        RW.run(40);
        out.wild.during = !!P.rstate;
        RW.run(120);
        G.input.keys.KeyD = false;
        out.wild.moved = +(P.x - x0).toFixed(1);
        out.wild.end = !!P.rstate;
        out.wild.hit = around.map((e) => Math.round(e.maxHp - e.hp));
        out.wild.shots = S.stats.wildShots || 0;
      } finally {
        G.BUILDUP.th = th0;
        G.input.keys.KeyD = false;
        save.equip.weapon = keepW;
        G.computeStats();
        T.arena();
      }
      return out;
    }, rangedSetup);
    assert(r.line.every((v) => v > 0), '熔光射线应贯穿直线上的所有敌人：' + r.line);
    assert(r.bu.fire > 0 && r.bu.light > 0, '熔光射线应同时累积火与雷的异常值：' + JSON.stringify(r.bu));
    assert(r.turn > 0 && r.castT >= 3 && r.castT < 3.6 && r.ticks >= 25, '光束应跟着准星转过去、持续约 3 秒：' + JSON.stringify(r));
    assert(r.nova.hit.every((v) => v > 0) && r.nova.far === 0 && r.nova.heat === 0 && r.nova.fields === 1 && r.nova.burn > 0, '焚天炎爆不对：' + JSON.stringify(r.nova));
    assert(r.wsU === 'wildfire' && r.wild.on && r.wild.heat === 0 && r.wild.during && !r.wild.end && r.wild.moved > 3, '乱射应开启、翻滚不断、照常走动、3 秒后结束：' + JSON.stringify(r.wild));
    assert(r.wild.hit.filter((v) => v > 0).length >= 2 && r.wild.shots >= 30, '乱射应自动打身边的敌人：' + JSON.stringify(r.wild));
    return '射线 ' + r.line.join('/') + '（' + r.castT + 's，' + r.ticks + ' 跳）· 炎爆 ' + r.nova.hit.join('/') + ' + 火场 ' + r.nova.burn + ' · 乱射 ' + r.wild.shots + ' 发';
  });

  await step('弓的 R 增益（约 8 秒）：万矢每箭分 5 支追踪箭；一矢穿心必定暴击、贯穿所有；元素满溢火冰雷轮流、异常翻倍、命中炸开；燎原 3 支燃箭、余烬多跳、烧死的炸开；换掉弓增益就没了', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, out = {};
      const keepW = save.equip.weapon;
      const buff = (b, it) => {
        T.lane();
        if (it) { save.equip.weapon = it; G.computeStats(); } else RW.arm(b);
        G.debug.gauge();
        G.input.tap[4] = 0.3;
        RW.run(30);
        return P.rbuff ? { id: P.rbuff.id, dur: +P.rbuff.dur.toFixed(2) } : null;
      };
      try {
        // 万矢
        out.volley = buff(10);
        S.projectiles.length = 0;
        const ms = [T.mob('husk', 6, -2), T.mob('husk', 7, 0), T.mob('husk', 6, 2), T.mob('husk', 8, 3.5), T.mob('husk', 8, -3.5)];
        let maxP = 0;
        for (let i = 0; i < 25; i++) {
          T.aim(P.x + 7, P.z);
          G.input.mouse.b[2] = true;
          G.tick(1 / 60);
          maxP = Math.max(maxP, S.projectiles.length);
        }
        G.input.mouse.b[2] = false;
        RW.run(60);
        out.volley.proj = maxP;
        out.volley.hit = ms.filter((e) => e.hp < e.maxHp).length;
        // 一矢穿心
        out.pierce = buff(5);
        out.pierce.ctx = (() => { const c = G.skillCtx('basic_eagle'); return [c.crit, c.pierce]; })();
        const row = [T.mob('husk', 4, 0), T.mob('husk', 6, 0), T.mob('husk', 8, 0), T.mob('husk', 10, 0), T.mob('husk', 12, 0)];
        const c0 = S.stats.crits;
        RW.hold(14, { x: P.x + 12, z: P.z });
        RW.run(60);
        out.pierce.hit = row.filter((e) => e.hp < e.maxHp).length;
        out.pierce.crits = S.stats.crits - c0;
        // 元素满溢
        out.over = buff(11);
        const els = new Set();
        for (let i = 0; i < 3; i++) { P.gun.cycle++; els.add(Object.keys(G.skillCtx('basic_runebow').base).join()); }
        out.over.els = [...els].sort().join(' ');
        out.over.ail = G.skillCtx('basic_runebow').ailment;
        const o1 = T.mob('husk', 6, 0), o2 = T.mob('husk', 6.6, 1.2);
        RW.hold(14, o1);
        RW.run(50);
        out.over.splash = Math.round(o2.maxHp - o2.hp);
        // 换下弓：增益结束
        save.equip.weapon = T.stdBlade(10);
        G.computeStats();
        RW.run(2);
        out.over.endOnSwap = !P.rbuff;
        // 燎原（烬羽）
        const jy = G.rollUnique('jinyu', 30, 0.5);
        out.storm = buff(13, jy);
        out.storm.ws = G.weaponSkill();
        S.projectiles.length = 0;
        const pack = [T.mob('husk', 6, 0, { hp: 30 }), T.mob('husk', 7, 1.5), T.mob('husk', 7.5, -1.5), T.mob('husk', 9, 0)];
        let maxS = 0;
        const e0 = S.stats.embers || 0, b0 = S.stats.emberBlasts || 0;
        for (let i = 0; i < 40; i++) {
          T.aim(pack[0].x, pack[0].z);
          G.input.mouse.b[2] = true;
          G.tick(1 / 60);
          maxS = Math.max(maxS, S.projectiles.length);
        }
        G.input.mouse.b[2] = false;
        RW.run(60);
        out.storm.proj = maxS;
        out.storm.embers = (S.stats.embers || 0) - e0;
        out.storm.blasts = (S.stats.emberBlasts || 0) - b0;
        out.storm.hit = pack.filter((e) => e.dead || e.hp < e.maxHp).length;
        // 增益到点结束
        RW.run(60 * 9);
        out.storm.ended = !P.rbuff;
      } finally {
        save.equip.weapon = keepW;
        G.computeStats();
        T.arena();
      }
      return out;
    }, rangedSetup);
    assert(r.volley && r.volley.id === 'volley' && r.volley.dur === 8 && r.volley.proj >= 5 && r.volley.hit >= 3, '万矢不对：' + JSON.stringify(r.volley));
    assert(r.pierce && r.pierce.id === 'pierceheart' && r.pierce.ctx[0] === 100 && r.pierce.ctx[1] >= 99 && r.pierce.hit === 5 && r.pierce.crits >= 5, '一矢穿心不对：' + JSON.stringify(r.pierce));
    assert(r.over && r.over.id === 'overflow' && r.over.els === 'cold fire light' && r.over.ail >= 180 && r.over.splash > 0 && r.over.endOnSwap, '元素满溢不对：' + JSON.stringify(r.over));
    assert(r.storm && r.storm.id === 'emberstorm' && r.storm.ws === 'emberstorm' && r.storm.proj >= 3 && r.storm.embers >= 3 && r.storm.blasts >= 1 && r.storm.hit >= 3 && r.storm.ended, '燎原不对：' + JSON.stringify(r.storm));
    return '万矢 ' + r.volley.proj + ' 支 · 穿心 ' + r.pierce.hit + ' 个 · 满溢 ' + r.over.els + ' · 燎原 余烬 ' + r.storm.embers + ' 跳 / 焚尸 ' + r.storm.blasts;
  });

  await step('烬铸远程：熔芯每轮最后一发必定暴击并炸开；烬羽的余烬连跳并灌火焰异常值；两者都按烬铸规则（固定词缀行、R 换成专属技）；旧存档的长弓读档后变成鹰眼长弓，R 不再是箭雨', async () => {
    const r = await ev((code) => {
      eval(code);
      const save = G.save, P = G.player, S = G.state, out = {};
      const keepW = save.equip.weapon;
      try {
        // 熔芯弹
        T.lane();
        save.equip.weapon = G.rollUnique('rongxin', 30, 0.5);
        G.computeStats();
        out.mech = P.uMech;
        const tg = T.mob('brute', 6, 0), side = T.mob('husk', 6.4, 1.4);
        T.fix(0.99); // 普通的几发不暴击
        const c0 = S.stats.crits, cr0 = S.stats.coreRounds || 0;
        RW.hold(60 * 2.2, tg);
        RW.run(30);
        out.core = { crits: S.stats.crits - c0, rounds: (S.stats.coreRounds || 0) - cr0, side: Math.round(side.maxHp - side.hp) };
        T.unfix();
        // 烬羽：余烬连跳 + 火焰异常
        T.lane();
        save.equip.weapon = G.rollUnique('jinyu', 30, 0.5);
        G.computeStats();
        out.mech2 = P.uMech;
        const a = T.mob('husk', 6, 0), b = T.mob('husk', 8, 2), c = T.mob('husk', 9, -2);
        const e0 = S.stats.embers || 0;
        RW.hold(10, a);
        RW.run(60);
        out.ember = { jumps: (S.stats.embers || 0) - e0, b: Math.round(b.maxHp - b.hp) + Math.round(c.maxHp - c.hp), fire: +(((b.bu && b.bu.fire) || 0) + ((c.bu && c.bu.fire) || 0)).toFixed(3) };
        // 旧存档的长弓
        const KEY = 'cinder-abyss-save-v1';
        const keep = localStorage.getItem(KEY);
        const raw = JSON.parse(keep);
        const bow = { uid: 'oldbow1', slot: 'weapon', baseIdx: 5, baseName: '筋角长弓', name: '锋锐的筋角长弓', rarity: 1, ilvl: 8, imp: { stat: 'pierce', v: 1 }, affixes: [{ id: 'incPhys', tier: 1, v: 9 }], wbase: [12, 22] };
        raw.equip = Object.assign({}, raw.equip, { weapon: bow });
        raw.bag = [Object.assign({}, bow, { uid: 'oldbow2', baseName: '渊鸣长弓', name: '灰烬之眼', rarity: 2 })];
        raw.bar = ['cleave', 'ember', null, null];
        localStorage.setItem(KEY, JSON.stringify(raw));
        G.loadSave();
        G.computeStats();
        const w = save.equip.weapon;
        out.mig = { base: w.baseName, name: w.name, type: G.BASES.weapon[w.baseIdx].type, ws: G.weaponSkill(), rare: save.bag[0].baseName + '/' + save.bag[0].name, flag: G.bowMigrated, bar: save.bar.join(), slot1: G.slotSkill(1), noRain: !G.SKILLS.arrowrain };
        localStorage.setItem(KEY, keep);
        G.loadSave();
      } finally {
        T.unfix();
        save.equip.weapon = keepW;
        G.computeStats();
        T.arena();
      }
      return out;
    }, rangedSetup);
    assert(r.mech === 'core' && r.core.rounds >= 1 && r.core.crits >= r.core.rounds && r.core.side > 0, '熔芯弹应必定暴击并炸开：' + JSON.stringify(r.core));
    assert(r.mech2 === 'ember' && r.ember.jumps >= 1 && r.ember.b > 0 && r.ember.fire > 0, '烬羽的余烬应连跳并灌火焰异常值：' + JSON.stringify(r.ember));
    const m = r.mig;
    assert(m.base === '鹰眼长弓' && m.name === '锋锐的鹰眼长弓' && m.type === 'eagle' && m.ws === 'pierceheart' && m.rare === '渊鸣鹰眼弓/灰烬之眼' && m.flag === 2 && m.noRain, '旧长弓应换成鹰眼长弓（名字同阶、稀有名不动），R 是一矢穿心：' + JSON.stringify(m));
    assert(m.bar === 'cleave,,,' && m.slot1 === 'basic_eagle', '读进拿着长弓的旧存档：右键应接管为射击：' + JSON.stringify(m));
    return '熔芯弹 ' + r.core.rounds + ' 发 · 余烬 ' + r.ember.jumps + ' 跳 · ' + m.name;
  });

  await step('攻击技能宝石的地面提示写的是武器伤害 × 倍率，不是「基础伤害 无」', async () => {
    await ev(() => {
      T.arena();
      T.clearLoot();
      const l = G.spawnLoot('skill', { id: 'whirl', lvl: 3 }, G.player.x - 3, G.player.z + 1.5);
      l.x = G.player.x - 3; l.z = G.player.z + 1.5; l.mesh.position.set(l.x, 0, l.z); l.t = 1; l.noAuto = true;
      window.__G1 = l;
      T.settle();
      G.debug.hold(false);
    });
    await page.mouse.move(1000, 620);
    await frames(3);
    const pt = await ev(() => T.labelPt(window.__G1));
    assert(pt, '旋风斩宝石的名牌不在画面里');
    await page.mouse.move(pt.x, pt.y);
    await until(() => document.getElementById('tip').classList.contains('on')).catch(() => {
      throw new Error('悬停技能宝石没有出现提示');
    });
    const txt = await ev(() => document.getElementById('tip').innerText);
    await page.mouse.move(1000, 620);
    await ev(() => {
      G.debug.hold(true);
      T.clearLoot();
    });
    cleanText(txt, '攻击宝石的地面提示');
    assert(txt.includes('旋风斩') && /武器伤害 × 8\d%/.test(txt) && txt.includes('当前武器') && !txt.includes('基础伤害 无'), '攻击宝石的地面提示应写武器伤害 × 倍率：' + txt.slice(0, 220));
    return txt.split('\n').find((s) => s.includes('武器伤害')) || '';
  });

  await step('旋风斩：按住持续旋转、身边一圈全中、边转边走；松手 / 翻滚 / 换技能 / 魔力耗尽即停', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, W = G.world, inp = G.input, out = {};
      const bar0 = G.save.bar.slice();
      G.bindSkill(0, 'whirl');
      G.bindSkill(2, 'arc');
      T.fix(0.5);
      try {
        const ring = [0, 1, 2, 3].map((i) => T.mob('husk', Math.sin((i * Math.PI) / 2) * 2.2, Math.cos((i * Math.PI) / 2) * 2.2));
        const far = T.mob('husk', 7, 0);
        const ctx = G.skillCtx('whirl');
        out.cost = ctx.cost;
        T.aim(P.x + 3, P.z);
        // 1. 按住一秒：一直在转，身边四个方向的都挨了打，圈外的没事
        inp.mouse.b[0] = true;
        for (let i = 0; i < 60; i++) G.tick(1 / 60);
        out.channel = !!(P.cast && P.cast.channel);
        out.pulses = P.cast ? P.cast.pulses : 0;
        out.clip = W.clipOf(P.ent);
        out.ringHit = ring.map((e) => Math.round(e.maxHp - e.hp));
        out.farHit = far.maxHp - far.hp;
        // 2. 边转边走：走得动，但比平时慢
        for (const e of ring.concat([far])) e.hp = 0, G.killEnemy(e);
        G.debug.step(0); // 让尸体离场
        const x0 = P.x, z0 = P.z;
        inp.keys.KeyD = true;
        for (let i = 0; i < 30; i++) G.tick(1 / 60);
        inp.keys.KeyD = false;
        out.moved = Math.hypot(P.x - x0, P.z - z0);
        out.full = P.moveSpeed * 0.5;
        out.stillSpin = !!(P.cast && P.cast.channel);
        // 3. 松手：立刻停，转圈的动作淡出
        inp.mouse.b[0] = false;
        inp.tap[0] = 0;
        G.tick(1 / 60);
        out.release = !P.cast && !P.spinning;
        for (let i = 0; i < 20; i++) G.tick(1 / 60);
        out.clipAfter = W.clipOf(P.ent);
        // 4. 翻滚打断；还按着的话滚完接着转
        inp.mouse.b[0] = true;
        for (let i = 0; i < 20; i++) G.tick(1 / 60);
        out.restart = !!(P.cast && P.cast.channel);
        G.dodge();
        out.roll = !P.cast && W.clipOf(P.ent) === 'roll';
        for (let i = 0; i < 40; i++) G.tick(1 / 60);
        out.resume = !!(P.cast && P.cast.channel) && W.clipOf(P.ent) === 'spin';
        // 5. 按 Q 放别的技能：旋风斩让位
        P.mana = P.maxMana;
        inp.keys.KeyQ = true;
        G.tick(1 / 60);
        G.tick(1 / 60);
        out.interrupt = P.cast ? P.cast.id : null;
        inp.keys.KeyQ = false;
        inp.tap[2] = 0;
        for (let i = 0; i < 60; i++) G.tick(1 / 60);
        out.back = !!(P.cast && P.cast.channel); // 左键一直按着：放完链雷又转起来
        // 6. 魔力见底：转不动就停（每帧都按回 0，不让自然回复把它又转起来）
        for (let i = 0; i < 30; i++) {
          P.mana = 0;
          G.tick(1 / 60);
        }
        out.noMana = !P.cast && W.clipOf(P.ent) !== 'spin';
      } finally {
        T.unfix();
        inp.mouse.b[0] = false;
        inp.keys.KeyQ = inp.keys.KeyD = false;
        inp.tap[0] = inp.tap[2] = 0;
        bar0.forEach((id, i) => G.bindSkill(i, id));
      }
      T.arena();
      return out;
    });
    assert(r.channel && r.clip === 'spin' && r.pulses >= 3, '按住一秒应一直在转、至少转出 3 下：' + JSON.stringify(r));
    assert(r.ringHit.every((d) => d > 0) && r.farHit === 0, '应打中身边一圈、打不到圈外：' + JSON.stringify(r));
    assert(r.stillSpin && r.moved > r.full * 0.35 && r.moved < r.full * 0.8, '旋转中应能慢慢走动：' + JSON.stringify(r));
    assert(r.release && r.clipAfter !== 'spin', '松手应立刻停下：' + JSON.stringify(r));
    assert(r.restart && r.roll && r.resume, '翻滚应打断旋转，还按着则滚完接着转：' + JSON.stringify(r));
    assert(r.interrupt === 'arc' && r.back, '按别的技能应打断旋转，放完继续转：' + JSON.stringify(r));
    assert(r.noMana, '魔力不足应停下：' + JSON.stringify(r));
    return '一秒转出 ' + r.pulses + ' 下，四周各受 ' + r.ringHit.join('/') + ' 伤害';
  });

  await step('影步连斩：按住自动往怪堆里闪砍、落单的也轮得到、落点不穿墙、单体换方位反复砍；没目标不出手；松手 / 翻滚 / 魔力耗尽即停；破绽精英直接处决', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, W = G.world, S = G.state, inp = G.input, out = {};
      const bar0 = G.save.bar.slice();
      const ow = W.walkable;
      const sx = P.x, sz = P.z; // 起点：后面几段都从这里开始，免得撞上场地本来的墙
      G.bindSkill(0, 'shadestep');
      T.fix(0.5);
      // 推进 n 帧，记下每一次闪现（落点、目标）
      let jumps = [], lastS = -1;
      const hold = (n, every) => {
        for (let i = 0; i < n; i++) {
          G.tick(1 / 60);
          const c = P.cast;
          if (c && c.flicker && c.pend && c.strikeT !== lastS) {
            lastS = c.strikeT;
            jumps.push({ x: P.x, z: P.z, e: c.pend, ifr: P.iframe });
          }
          if (every) every();
        }
      };
      const release = () => {
        inp.mouse.b[0] = false;
        inp.tap[0] = 0;
      };
      const kill = (list) => {
        for (const e of list) if (!e.dead) (e.hp = 0), G.killEnemy(e);
        G.debug.step(0); // 让尸体离场
      };
      try {
        const ctx = G.skillCtx('shadestep');
        out.cost = ctx.cost;
        // 1. 一侧三只挤成一堆、另一侧落单一只：第一刀砍准星旁边的落单那只，之后优先往怪堆里跳，
        //    在堆里轮着砍（不会连砍三刀同一只），每一跳都有位移；一直按着，落单的那只也会再轮到
        const mobs = [T.mob('husk', 4, 0), T.mob('husk', 5, 1), T.mob('husk', 5, -1), T.mob('husk', -2, 3)];
        const lone = mobs[3];
        T.aim(lone.x + 0.5, lone.z);
        const m0 = P.mana;
        inp.mouse.b[0] = true;
        hold(60);
        out.channel = !!(P.cast && P.cast.flicker);
        out.first = jumps.length ? mobs.indexOf(jumps[0].e) : -1;
        out.jumps = jumps.length;
        out.moves = jumps.slice(1).map((j, i) => +Math.hypot(j.x - jumps[i].x, j.z - jumps[i].z).toFixed(2));
        out.next = jumps.slice(1, 5).map((j) => mobs.indexOf(j.e)); // 落单之后的四刀
        out.spent = +(m0 - P.mana).toFixed(1);
        out.iframe = jumps.length > 1 ? +jumps[1].ifr.toFixed(3) : 0;
        hold(420); // 一共按 8 秒
        out.loneAgain = jumps.slice(1).filter((j) => j.e === lone).length;
        out.hit = mobs.map((e) => Math.round(e.maxHp - e.hp));
        // 2. 松手：停下，动作不残留
        release();
        hold(30);
        out.release = !P.cast;
        out.clipAfter = W.clipOf(P.ent);
        // 3. 只剩一个目标：围着它反复砍，每次落点换一个方位
        kill(mobs.slice(1));
        const solo = mobs[0], hp1 = solo.hp;
        jumps = [];
        T.aim(solo.x, solo.z);
        inp.mouse.b[0] = true;
        hold(80);
        const ang = jumps.map((j) => Math.atan2(j.x - solo.x, j.z - solo.z));
        out.solo = {
          n: jumps.length, same: jumps.every((j) => j.e === solo), dmg: Math.round(hp1 - solo.hp),
          turn: ang.slice(1).map((a, i) => +Math.abs(Math.atan2(Math.sin(a - ang[i]), Math.cos(a - ang[i]))).toFixed(2)),
          gap: jumps.map((j) => +(Math.hypot(j.x - solo.x, j.z - solo.z) - solo.r).toFixed(2)),
        };
        // 4. 翻滚打断；还按着的话滚完接着连斩
        G.dodge();
        out.roll = !P.cast && W.clipOf(P.ent) === 'roll';
        hold(40);
        out.resume = !!(P.cast && P.cast.flicker);
        // 5. 魔力见底：停下（每帧都按回 0，不让自然回复把它又续上）
        hold(30, () => (P.mana = 0));
        out.noMana = !P.cast;
        release();
        hold(5);
        // 6. 附近（8 格内）没有敌人：不出手、不扣魔力、原地不动
        kill([solo]);
        T.tp(sx, sz);
        const far = T.mob('husk', 10.5, 0);
        T.aim(far.x, far.z);
        P.mana = P.maxMana;
        let x0 = P.x, z0 = P.z;
        jumps = [];
        inp.mouse.b[0] = true;
        hold(30);
        out.none = { cast: !!P.cast, full: P.mana === P.maxMana, moved: +Math.hypot(P.x - x0, P.z - z0).toFixed(2), hit: far.maxHp - far.hp, jumps: jumps.length };
        release();
        kill([far]);
        // 7. 隔着墙：墙后的敌人够不着（不起手）；墙这边有敌人时只砍这边，人始终不过墙
        T.tp(sx, sz);
        const wallX = P.x + 2.2;
        W.walkable = function (x, z, pad) { return Math.abs(x - wallX) < 0.5 ? false : ow.call(W, x, z, pad); };
        const behind = T.mob('husk', 5, 0);
        T.aim(behind.x, behind.z);
        x0 = P.x;
        inp.mouse.b[0] = true;
        hold(20);
        out.wall1 = { cast: !!P.cast, moved: +Math.abs(P.x - x0).toFixed(2), hit: behind.maxHp - behind.hp };
        const front = T.mob('husk', -3, 1);
        let maxX = -Infinity;
        jumps = [];
        hold(60, () => (maxX = Math.max(maxX, P.x)));
        out.wall2 = { jumps: jumps.length, front: Math.round(front.maxHp - front.hp), behind: behind.maxHp - behind.hp, side: +(wallX - maxX).toFixed(2) };
        release();
        hold(20);
        W.walkable = ow;
        kill([behind, front]);
        // 8. 连斩途中选中露出破绽的精英：直接处决
        T.tp(sx, sz);
        const husk = T.mob('husk', 3, 0);
        const elite = T.mob('brute', -4, 0, { elite: true });
        G.breakEnemy(elite);
        G.debug.step(0.3); // 击破的顿帧走完
        P.iframe = 0;
        P.mana = P.maxMana;
        const execs0 = S.stats.execs, ehp = elite.hp;
        T.aim(husk.x, husk.z);
        jumps = [];
        let execAt = -1;
        inp.mouse.b[0] = true;
        for (let i = 0; i < 60 && execAt < 0; i++) {
          hold(1);
          if (P.exec) execAt = i;
        }
        out.exec = { at: execAt, target: P.exec && P.exec.e === elite, firstHusk: jumps.length > 0 && jumps[0].e === husk };
        release();
        for (let i = 0; i < 120 && P.exec; i++) G.tick(1 / 60);
        out.exec.done = S.stats.execs - execs0;
        out.exec.dmg = Math.round(ehp - elite.hp);
      } finally {
        W.walkable = ow;
        T.unfix();
        release();
        bar0.forEach((id, i) => G.bindSkill(i, id));
      }
      T.arena();
      return out;
    });
    assert(r.channel && r.jumps >= 4 && r.first === 3, '按住一秒应自动连跳至少 4 下、第一刀砍准星旁边的敌人：' + JSON.stringify(r));
    assert(r.next.length === 4 && r.next.every((i) => i >= 0 && i <= 2) && new Set(r.next).size >= 2 && r.next.every((i, k) => k < 2 || i !== r.next[k - 1] || i !== r.next[k - 2]),
      '之后应优先往怪堆里跳、在堆里轮着砍（不连砍三刀同一只）：' + JSON.stringify(r.next));
    assert(r.loneAgain >= 1 && r.hit.every((d) => d > 0), '一直按着，落单的敌人也应再轮到：' + JSON.stringify(r));
    // 连砍同一堆里挨着的两只时，落点可能离得很近：要求每一跳都动了，并且大多数跳得明显
    assert(r.moves.every((d) => d > 0.02) && r.moves.filter((d) => d > 0.3).length >= r.moves.length - 1, '每一跳都应有位移：' + JSON.stringify(r.moves));
    assert(r.spent > r.cost * 3 && r.iframe > 0.05 && r.iframe < 0.15, '每刀应扣魔力、闪现给短暂无敌：' + JSON.stringify(r));
    assert(r.release && r.clipAfter === null, '松手应停下且不残留动作：' + JSON.stringify(r));
    assert(r.solo.n >= 5 && r.solo.same && r.solo.dmg > 0 && r.solo.turn.every((a) => a > 0.8) && r.solo.gap.every((g) => g > 0.5 && g < 1.3),
      '只剩一个目标时应围着它换方位反复砍：' + JSON.stringify(r.solo));
    assert(r.roll && r.resume, '翻滚应打断连斩，还按着则滚完接着连：' + JSON.stringify(r));
    assert(r.noMana, '魔力不足应停下：' + JSON.stringify(r));
    assert(!r.none.cast && r.none.full && r.none.moved < 0.01 && r.none.hit === 0 && r.none.jumps === 0, '附近没有敌人时不应出手、扣魔力或移动：' + JSON.stringify(r.none));
    assert(!r.wall1.cast && r.wall1.moved < 0.01 && r.wall1.hit === 0, '墙后的敌人不应能闪过去：' + JSON.stringify(r.wall1));
    assert(r.wall2.jumps >= 3 && r.wall2.front > 0 && r.wall2.behind === 0 && r.wall2.side > 0.4, '有墙时只砍墙这边、人不过墙：' + JSON.stringify(r.wall2));
    assert(r.exec.at >= 0 && r.exec.target && r.exec.firstHusk && r.exec.done === 1 && r.exec.dmg > 0, '连斩选中破绽中的精英应直接处决：' + JSON.stringify(r.exec));
    return '一秒连跳 ' + r.jumps + ' 下，落单之后 ' + r.next.join('→') + '，八秒内落单的再挨 ' + r.loneAgain + ' 刀；单体 ' + r.solo.n + ' 刀';
  });

  await step('技能细节：魔力不足不能施放，冷却中不能再放，投射物会消失', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state;
      G.bindSkill(0, 'cleave');
      G.bindSkill(1, 'ember');
      G.bindSkill(2, 'meteor');
      G.bindSkill(3, 'blink');
      T.dummy(4, 0);
      G.input.mouse.wx = 4;
      G.input.mouse.wz = 0;
      const out = {};
      // 魔力不足
      P.mana = 2;
      G.input.mouse.b[2] = true;
      G.debug.step(0.6);
      G.input.mouse.b[2] = false;
      out.noMana = T.d.hp === T.d.maxHp && S.projectiles.length === 0;
      // 冷却
      P.mana = P.maxMana;
      G.input.keys.KeyQ = true;
      G.debug.step(0.5);
      out.cd1 = P.cds.meteor > 0;
      const m1 = P.mana;
      G.debug.step(1.2);
      out.onlyOnce = P.mana >= m1; // 冷却期间按住也不会再扣魔力
      G.input.keys.KeyQ = false;
      G.debug.step(G.SKILLS.meteor.cd);
      out.cdDone = P.cds.meteor === 0;
      // 投射物飞出场外后被清掉
      G.clearEnemies();
      P.mana = P.maxMana;
      G.input.mouse.b[2] = true;
      G.debug.step(0.4);
      G.input.mouse.b[2] = false;
      out.spawned = S.projectiles.length >= 1;
      const mesh = out.spawned ? S.projectiles[0].mesh : null;
      G.debug.step(3);
      out.cleared = S.projectiles.length === 0 && !!mesh && mesh.parent === null;
      out.tele = S.telegraphs.length;
      return out;
    });
    assert(r.noMana, '魔力不足时仍然放出了技能');
    assert(r.cd1 && r.onlyOnce && r.cdDone, '冷却逻辑不对：' + JSON.stringify(r));
    assert(r.spawned && r.cleared, '投射物没有生成或没有被清理：' + JSON.stringify(r));
    assert(r.tele === 0, '友方预警圈没有清理');
  });

  // ------------------------------------------------------------------ 光环与元素异常值
  // 这几步借用 summonStep：进来时记下构筑，结束时还原构筑、清场
  await summonStep('霜环光环：绑在技能栏上即生效、保留 25% 魔力（节流按消耗倍率降低）；按键只提示；定时脉冲伤害一圈敌人（不算连击、不扣魔力）；回响 / 投射物类镶不上；取下即失效', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, W = G.world, S = G.state, out = {};
      G.save.sockets.nova = [null, null, null];
      G.save.bar = ['cleave', 'ember', null, null];
      G.computeStats();
      P.mana = P.maxMana;
      out.off = { raw: P.maxManaRaw, max: P.maxMana, res: P.reserved, on: G.auraOn('nova') };
      G.bindSkill(2, 'nova');
      out.on = { raw: P.maxManaRaw, max: P.maxMana, res: P.reserved, pct: P.reservePct, on: G.auraOn('nova'), mana: P.mana };
      G.socketSupport('nova', 0, 'frugal');
      out.frugal = { pct: P.reservePct, max: P.maxMana, ctx: G.skillCtx('nova').reserve };
      G.socketSupport('nova', 0, null);
      out.fit = ['echo', 'multi', 'pierce', 'chain'].map((id) => G.supportFits('nova', id));
      out.fitOk = ['expanse', 'haste', 'cold', 'ailment', 'frugal', 'precise'].map((id) => G.supportFits('nova', id));
      // 脉冲：圈内的挨打，圈外的不挨；数字是小号的淡数字，不闪白
      T.fix(0.5);
      const ctx = G.skillCtx('nova');
      const near = T.mob('husk', 3, 0), far = T.mob('husk', 3 + ctx.sk.radius + 1.5, 0);
      near.freeze = far.freeze = 1e9; // 冻着不累积冰霜异常值，只看伤害
      const per = G.calcHit(ctx).total;
      const texts = [], flashes = [], ot = W.text, of = W.flash;
      W.text = function (x, z, str, col, size, style) { texts.push({ str: String(str), size, kind: style && style.kind }); return ot.apply(W, arguments); };
      W.flash = function () { flashes.push(1); return of.apply(W, arguments); };
      const h0 = near.hp, m0 = P.mana, hits0 = S.stats.hits;
      P.chain.n = 0;
      // 轻点光环的键：不施放，只提示
      G.input.tap[2] = 0.3;
      G.tick(1 / 60);
      out.cast = P.cast ? P.cast.id : null;
      out.tap = G.input.tap[2];
      out.hint = texts.some((t) => t.str === '光环常驻生效');
      for (let i = 0; i < 119; i++) G.tick(1 / 60);
      W.text = ot;
      W.flash = of;
      out.pulses = (h0 - near.hp) / per;
      out.far = far.maxHp - far.hp;
      out.spent = m0 - P.mana;
      out.chain = P.chain.n;
      out.hits = S.stats.hits - hits0;
      out.small = texts.filter((t) => t.kind === 'faint').length;
      out.big = texts.filter((t) => t.kind !== 'faint' && /^\d+$/.test(t.str)).length;
      out.flashes = flashes.length;
      out.ring = W.auraInfo();
      out.time = ctx.time;
      G.socketSupport('nova', 0, 'haste');
      G.socketSupport('nova', 1, 'expanse');
      const c2 = G.skillCtx('nova');
      out.haste = c2.time;
      out.R = [G.auraRadius(ctx), G.auraRadius(c2)];
      // 取下：保留解除，脉冲停止
      G.bindSkill(2, null);
      const h1 = near.hp;
      G.debug.step(1);
      out.after = { res: P.reserved, max: P.maxMana, raw: P.maxManaRaw, on: G.auraOn('nova'), dmg: h1 - near.hp, ring: W.auraInfo().r, regen: P.manaRegen };
      // 从地上捡起霜环：自动绑进空格，保留当场生效（不用等别的操作来重算属性）；保留的那部分魔力也不再回复
      const lvl0 = G.save.skills.nova || 1;
      delete G.save.skills.nova;
      G.save.bar = ['cleave', 'ember', null, null];
      G.computeStats();
      G.pickup(G.spawnLoot('skill', { id: 'nova', lvl: lvl0 }, P.x, P.z));
      out.pick = { on: G.auraOn('nova'), bar: G.save.bar.slice(), res: P.reserved, max: P.maxMana, raw: P.maxManaRaw, regen: P.manaRegen };
      // 以血为引：光环改为保留生命，魔力不受影响
      const bm = Object.keys(G.TREE).find((id) => G.TREE[id].stats && G.TREE[id].stats.bloodMagic);
      G.save.passives.push(bm);
      G.computeStats();
      out.blood = { res: P.reserved, life: P.maxLife, lifeRaw: P.maxLifeRaw, max: P.maxMana, raw: P.maxManaRaw, card: (G.ui.open('skills'), document.getElementById('panel').innerText.includes('生命保留')) };
      G.ui.close();
      G.save.passives.pop();
      G.computeStats();
      T.unfix();
      return out;
    });
    assert(!r.off.on && r.off.res === 0 && r.off.max === r.off.raw, '没绑光环时不应保留魔力：' + JSON.stringify(r.off));
    assert(r.on.on && r.on.pct === 25 && r.on.res === Math.round(r.on.raw * 0.25) && r.on.max === r.on.raw - r.on.res && r.on.mana <= r.on.max, '绑上霜环应保留 25% 最大魔力并压住当前魔力：' + JSON.stringify(r.on));
    assert(Math.abs(r.frugal.pct - 15) < 1e-9 && Math.abs(r.frugal.ctx - 15) < 1e-9 && r.frugal.max > r.on.max, '节流应把保留降到 15%：' + JSON.stringify(r.frugal));
    assert(r.fit.every((f) => !f) && r.fitOk.every((f) => f), '光环可镶的辅助不对：' + JSON.stringify([r.fit, r.fitOk]));
    assert(r.cast === null && r.tap === 0 && r.hint, '按光环的键不应施放，只提示「光环常驻生效」：' + JSON.stringify(r));
    assert(r.pulses > 3.5 && r.pulses < 4.6 && r.far === 0, '两秒应脉冲约 4 次、只打圈内：' + JSON.stringify(r));
    assert(r.spent <= 0 && r.chain === 0 && r.hits === 0, '光环脉冲不扣魔力、不算连击：' + JSON.stringify(r));
    assert(r.small >= 3 && r.big === 0 && r.flashes === 0, '光环的数字应是小号淡数字、不闪白：' + JSON.stringify(r));
    assert(r.ring.r > 4 && r.ring.visible, '脚下应有常驻的霜环：' + JSON.stringify(r.ring));
    assert(Math.abs(r.haste - r.time / 1.25) < 1e-9 && r.R[1] > r.R[0] * 1.1, '迅捷加快脉冲、扩域扩大半径：' + JSON.stringify(r));
    assert(!r.after.on && r.after.res === 0 && r.after.max === r.after.raw && r.after.dmg === 0 && r.after.ring === 0, '取下光环后应解除保留、停止脉冲：' + JSON.stringify(r.after));
    assert(r.pick.on && r.pick.bar[2] === 'nova' && r.pick.res === Math.round(r.pick.raw * 0.25) && r.pick.max === r.pick.raw - r.pick.res, '捡起霜环自动绑上技能栏后应立刻保留魔力：' + JSON.stringify(r.pick));
    assert(r.pick.regen < r.after.regen, '保留的魔力不应再回复（回复按保留后的上限算）：' + JSON.stringify([r.pick, r.after]));
    assert(r.blood.res === Math.round(r.blood.lifeRaw * 0.25) && r.blood.life === r.blood.lifeRaw - r.blood.res && r.blood.max === r.blood.raw && r.blood.card, '以血为引时光环应改为保留生命：' + JSON.stringify(r.blood));
    // 技能卡：保留、每跳伤害、秒伤
    await ev(() => { G.bindSkill(2, 'nova'); G.ui.open('skills'); });
    const txt = await ev(() => { const c = Array.from(document.querySelectorAll('.skill-card')).find((n) => n.querySelector('.sk-name').textContent.startsWith('霜环')); return c ? c.innerText : ''; });
    await ev(() => G.ui.close());
    assert(txt.includes('魔力保留') && txt.includes('25%') && txt.includes('每跳伤害') && txt.includes('每秒脉冲') && txt.includes('估算秒伤') && txt.includes('生效中') && !txt.includes('魔力消耗'), '霜环的技能卡应写魔力保留和每跳伤害：' + txt);
    return '两秒脉冲 ' + r.pulses.toFixed(1) + ' 次，半径 ' + r.R[0].toFixed(1) + '，保留 ' + r.on.res + ' 魔力';
  });

  await summonStep('元素异常值：按每种元素的伤害累积（物理不算），各元素速度不同（闪电 > 冰霜 > 火焰），阈值随生命 / 精英 / 首领而定，异常累积速度加快累积，几秒没挨打后回落；冰霜异常值带来轻度冰缓', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, B = G.BUILDUP, out = {};
      const mk = (type, elite) => {
        const e = T.mob(type, 4, 0, { elite });
        e.maxHp = 100 / B.th; // 阈值按最大生命：普通敌人的阈值正好 100
        G.initBuildUp(e);
        e.hp = e.maxHp = 1e6;
        return e;
      };
      const e = mk('brute');
      out.th = G.buThreshold(e, 'cold');
      G.addBuildUp(e, { cold: 30, phys: 500 }, 0);
      out.cold1 = e.bu.cold;
      out.phys = e.bu.fire + e.bu.light;
      G.addBuildUp(e, { cold: 20 }, 100); // 异常累积速度 +100%：翻倍
      out.cold2 = e.bu.cold;
      // 同样 30 点伤害：三种元素各灌多少
      const per = {};
      for (const t of G.ELEMS) {
        const x = T.mob('husk', -4, 0);
        x.maxHp = 100 / B.th;
        G.initBuildUp(x);
        x.hp = x.maxHp = 1e6;
        G.addBuildUp(x, { [t]: 30 }, 0);
        per[t] = x.bu[t];
      }
      out.per = per;
      G.tick(1 / 60);
      out.slowK = e.slowK;
      G.debug.step(B.hold - 0.2);
      out.held = e.bu.cold;
      G.debug.step(0.7);
      out.decayed = e.bu.cold;
      G.debug.step(4);
      out.gone = e.bu.cold;
      // 真实命中：掷焰的火焰伤害按 伤害 ÷ 阈值 × (1 + 异常累积速度%) 累积
      T.fix(0.5);
      G.socketSupport('ember', 0, 'ailment');
      const ctx = G.skillCtx('ember');
      const e2 = mk('brute');
      const fire = G.calcHit(ctx, 1).parts.fire; // 随机数钉死：和下面这一击的数值相同
      G.hitEnemy(e2, ctx, 1);
      out.fire = { bu: e2.bu.fire, want: (fire / G.buThreshold(e2, 'fire')) * B.rate.fire * (1 + ctx.ailment / 100), ail: ctx.ailment };
      T.unfix();
      // 阈值：精英更高，首领最高
      const el = T.mob('husk', 4, 2, { elite: true }), nm = T.mob('husk', 4, -2);
      const boss = G.spawnBoss('golem', P.x + 12, P.z, 1);
      out.ratio = { normal: nm.buTh / G.MOBS.husk.hp, elite: el.buTh / (G.MOBS.husk.hp * 4.5), boss: boss.buTh / boss.maxHp };
      return out;
    });
    const B = await ev(() => G.BUILDUP);
    const rc = B.rate.cold;
    assert(Math.abs(r.th - 100) < 1e-6 && Math.abs(r.cold1 - 0.3 * rc) < 1e-9 && r.phys === 0, '冰霜伤害 30 / 阈值 100 应累积 0.3 × 冰霜速度，物理不累积：' + JSON.stringify(r));
    assert(Math.abs(r.cold2 - 0.7 * rc) < 1e-9, '异常累积速度 +100% 应让累积翻倍：' + JSON.stringify(r));
    for (const t of ['fire', 'cold', 'light']) assert(Math.abs(r.per[t] - 0.3 * B.rate[t]) < 1e-9, t + ' 应按自己的速度累积：' + JSON.stringify(r.per));
    assert(B.rate.light > B.rate.cold && B.rate.cold > B.rate.fire && B.rate.light >= 1.5 && B.rate.fire === 1, '闪电最快、冰霜次之、火焰最慢：' + JSON.stringify(B.rate));
    assert(Math.abs(r.slowK - (1 - 0.7 * rc * B.chill)) < 0.01, '冰霜异常值应带来按比例的轻度冰缓：' + JSON.stringify(r));
    assert(Math.abs(r.held - 0.7 * rc) < 1e-9 && r.decayed < r.held - 0.15 && r.decayed > 0.3 && r.gone === 0, '异常值应在几秒后开始回落直到清空：' + JSON.stringify(r));
    assert(r.fire.bu > 0 && Math.abs(r.fire.bu - r.fire.want) < 1e-6 && r.fire.ail >= 35, '掷焰命中应按公式累积火焰异常值：' + JSON.stringify(r.fire));
    assert(Math.abs(r.ratio.normal - B.th) < 0.02 && Math.abs(r.ratio.elite - B.thElite) < 0.02 && Math.abs(r.ratio.boss - B.boss) < 1e-6 && B.thElite * 4.5 > B.th, '阈值比例不对：' + JSON.stringify(r.ratio));
    // 普通敌人打掉不到五分之一生命的火焰伤害就该灌满（改版前要一半），精英约三成
    assert(B.th <= 0.2 && B.th >= 0.12 && B.thElite <= 0.35 && B.thElite > B.th, '阈值应降到普通约 18%、精英约 30%：' + JSON.stringify({ th: B.th, el: B.thElite }));
  });

  await summonStep('异常触发：冰霜满 → 冻结（精英更短，冻结中不再累积）；火焰满 → 爆燃波及周围且不连锁；闪电满 → 感电，挨打时向附近敌人射电弧（不连锁、有节流，身边没人则打回自己）', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, W = G.world, S = G.state, B = G.BUILDUP, out = {};
      const texts = [], ot = W.text;
      W.text = function (x, z, str) { texts.push(String(str)); return ot.apply(W, arguments); };
      T.fix(0.5);
      try {
        const mk = (type, dx, dz, elite) => {
          const e = T.mob(type, dx, dz, { elite });
          e.maxHp = 100 / B.th; // 普通敌人的阈值 100
          G.initBuildUp(e);
          e.hp = e.maxHp = 1e6;
          return e;
        };
        // 冻结
        const f = mk('husk', 4, 0), fe = mk('husk', 4, 3, true);
        G.addBuildUp(f, { cold: G.buThreshold(f, 'cold') }, 0);
        G.addBuildUp(fe, { cold: G.buThreshold(fe, 'cold') }, 0);
        out.freeze = { n: f.freeze, e: fe.freeze, bu: f.bu.cold, text: texts.includes('冻结'), stat: S.stats.freezes };
        G.addBuildUp(f, { cold: 50 }, 0);
        out.freeze.locked = f.bu.cold;
        G.tick(1 / 60);
        out.freeze.iced = !!f.ent.iced;
        G.clearEnemies();
        // 爆燃：中心那只灌满；旁边的挨爆炸，但自己的火焰异常值不涨（不连锁）；远处的不受波及
        const c = mk('husk', 5, 0), n1 = mk('husk', 6.5, 0), n2 = mk('husk', 5, 1.8), farE = mk('husk', 5 + B.blastR + 4, 0);
        n1.bu.fire = 0.99;
        const th = G.buThreshold(c, 'fire');
        const nh0 = n2.hp, bl0 = S.stats.blasts || 0;
        G.hitEnemy(c, { sk: { w: 0, kb: 0, poise: 0 }, base: { fire: [th, th] }, inc: {}, moreType: {}, more: 1, extra: {}, crit: 0, critMulti: 100, ailment: 0, stun: 0, leech: 0 }, 1, { quiet: true });
        out.blast = { stat: S.stats.blasts - bl0, n1bu: n1.bu.fire, n1blast: n1.blastT, n2dmg: nh0 - n2.hp, want: Math.min(th * B.blast, c.buTh * B.blastCap), far: farE.maxHp - farE.hp, cbu: c.bu.fire, text: texts.includes('爆燃'), mark: c.blastT > 0 };
        G.clearEnemies();
        // 爆燃跟着你的火焰伤害走：同一只怪，每击火焰越高 / 异常累积速度越快，炸得越狠（不是只看怪的生命）
        const fctx = (v, ail) => ({ sk: { w: 0, kb: 0, poise: 0 }, base: { fire: [v, v] }, inc: {}, moreType: {}, more: 1, extra: {}, crit: 0, critMulti: 100, ailment: ail, stun: 0, leech: 0 });
        const blastOf = (v, ail) => {
          const src = mk('husk', 5, 0), nb = mk('husk', 6.5, 0);
          const h0 = nb.hp, b0 = S.stats.blasts || 0;
          for (let i = 0; i < 400 && (S.stats.blasts || 0) === b0; i++) G.hitEnemy(src, fctx(v, ail), 1, { quiet: true });
          const d = h0 - nb.hp;
          G.clearEnemies();
          return Math.round(d * 10) / 10;
        };
        out.scale = { small: blastOf(5, 0), bigger: blastOf(15, 0), ail: blastOf(5, 100), capped: blastOf(1000, 0), cap: 100 * B.blastCap };
        // 感电的敌人被同一击灌满火焰：紧跟着的爆燃也打到它，但这一击只放一次电弧
        const ds = mk('husk', 5, 0), dn = mk('husk', 7, 0);
        ds.shockT = 4;
        ds.bu.fire = 0.99;
        const db0 = S.stats.bolts || 0;
        G.hitEnemy(ds, fctx(50, 0), 1, { quiet: true });
        out.dbl = { bolts: (S.stats.bolts || 0) - db0, blasts: ds.blastT > 0 };
        G.clearEnemies();
        // 感电
        const s0 = mk('brute', 5, 0), a = mk('husk', 7, 0), b = mk('husk', 5, 2.5), c2 = mk('husk', 7, 2.5), far2 = mk('husk', 5 + B.shockR + 4, 0);
        G.addBuildUp(s0, { light: G.buThreshold(s0, 'light') }, 0);
        a.shockT = 4; // 电弧打在感电的敌人身上也不会再放电弧
        out.shock = { t: s0.shockT, bu: s0.bu.light, text: texts.includes('感电') };
        const ctx = G.skillCtx('cleave');
        const hp = () => [a, b, c2, far2].map((e) => e.maxHp - e.hp);
        const bolts0 = S.stats.bolts || 0;
        const sh0 = s0.hp;
        G.hitEnemy(s0, ctx, 1, { quiet: true });
        const dealt = sh0 - s0.hp;
        out.shock.d1 = hp();
        out.shock.bolts = (S.stats.bolts || 0) - bolts0;
        out.shock.want = dealt * B.bolt;
        out.shock.lightBu = [a, b, c2].map((e) => e.bu.light);
        G.hitEnemy(s0, ctx, 1, { quiet: true }); // 节流：紧接着再挨一下不放电弧
        out.shock.d2 = hp();
        G.debug.step(B.shockGap + 0.05);
        G.hitEnemy(s0, ctx, 1, { quiet: true });
        out.shock.d3 = hp();
        G.debug.step(B.shock);
        const b1 = S.stats.bolts;
        G.hitEnemy(s0, ctx, 1, { quiet: true });
        out.shock.expired = S.stats.bolts - b1;
        G.clearEnemies();
        // 身边没有别的敌人：电弧打回它自己
        const solo = mk('brute', 5, 0);
        solo.shockT = 4;
        const so0 = solo.hp;
        const sb0 = S.stats.bolts;
        G.hitEnemy(solo, ctx, 1, { quiet: true });
        out.solo = { bolts: S.stats.bolts - sb0, dmg: so0 - solo.hp };
        out.solo.base = G.calcHit(ctx, 1).total;
      } finally {
        W.text = ot;
        T.unfix();
      }
      return out;
    });
    const B = await ev(() => G.BUILDUP);
    assert(r.freeze.n === B.freeze && r.freeze.e === B.freezeElite && r.freeze.bu === 0 && r.freeze.text && r.freeze.stat >= 2, '冰霜灌满应冻结（精英更短）并清空：' + JSON.stringify(r.freeze));
    assert(r.freeze.locked === 0 && r.freeze.iced, '冻结中不再累积冰霜异常值，模型罩上冰色：' + JSON.stringify(r.freeze));
    assert(r.blast.stat === 1 && r.blast.text && r.blast.mark && r.blast.cbu === 0, '火焰灌满应爆燃一次：' + JSON.stringify(r.blast));
    assert(Math.abs(r.blast.n2dmg - r.blast.want) < r.blast.want * 0.05 + 0.5 && r.blast.far === 0, '爆燃应按灌满的火焰伤害波及周围：' + JSON.stringify(r.blast));
    assert(r.blast.n1bu === 0.99 && !(r.blast.n1blast > 0), '爆燃不应累积火焰异常值（不连锁）：' + JSON.stringify(r.blast));
    const sc = r.scale;
    assert(Math.abs(sc.small - 5 * B.blast) < 0.6 && Math.abs(sc.bigger - 15 * B.blast) < 0.6 && Math.abs(sc.ail - 10 * B.blast) < 0.6 && Math.abs(sc.capped - sc.cap) < 0.6, '爆燃应按平均每击的火焰伤害 × (1 + 异常累积速度%) 算、按阈值封顶：' + JSON.stringify(sc));
    assert(r.dbl.blasts && r.dbl.bolts === 1, '同一击触发的爆燃再打到感电的敌人，也只放一次电弧：' + JSON.stringify(r.dbl));
    assert(r.shock.t === B.shock && r.shock.bu === 0 && r.shock.text, '闪电灌满应感电 ' + B.shock + ' 秒：' + JSON.stringify(r.shock));
    const d1 = r.shock.d1;
    assert(r.shock.bolts === B.shockN && d1.filter((d) => d > 0).length === B.shockN && d1[3] === 0, '感电挨打应向最近的 ' + B.shockN + ' 个敌人射电弧，远处的不挨：' + JSON.stringify(r.shock));
    assert(d1.filter((d) => d > 0).every((d) => Math.abs(d - r.shock.want) < r.shock.want * 0.02 + 0.2), '每道电弧应是这一击的 ' + B.bolt * 100 + '%：' + JSON.stringify(r.shock));
    assert(r.shock.lightBu.every((v) => v === 0), '电弧不应累积闪电异常值：' + JSON.stringify(r.shock));
    assert(JSON.stringify(r.shock.d2) === JSON.stringify(d1) && r.shock.d3.some((d, i) => d > d1[i]), '同一个敌人 ' + B.shockGap + ' 秒内最多放一次电弧：' + JSON.stringify(r.shock));
    assert(r.shock.expired === 0, '感电结束后不再放电弧');
    assert(r.solo.bolts === 1 && Math.abs(r.solo.dmg - r.solo.base * (1 + B.bolt)) < r.solo.base * 0.03, '身边没有别的敌人时只有一道电弧打回它自己：' + JSON.stringify(r.solo));
  });

  await summonStep('首领与异常：不会被冻结，冰霜灌满是重度冰缓（移动与出手放慢）；每触发一次阈值就提高（封顶），不会被永久控住；首领血条下有三段异常值', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, B = G.BUILDUP, out = {};
      const b = G.spawnBoss('golem', P.x, P.z - 9, 1);
      b.awake = true;
      const th = [];
      for (let i = 0; i < 8; i++) {
        th.push(G.buThreshold(b, 'cold'));
        b.bossChill = 0;
        G.addBuildUp(b, { cold: G.buThreshold(b, 'cold') }, 0);
      }
      out.th = th.map((v) => Math.round((v / th[0]) * 100) / 100);
      out.fireTh = G.buThreshold(b, 'fire') / th[0]; // 各元素分开成长
      out.freeze = b.freeze;
      out.chill = b.bossChill;
      G.addBuildUp(b, { cold: 1e6 }, 0);
      out.locked = b.bu.cold;
      G.tick(1 / 60);
      out.slowK = b.slowK;
      G.debug.step(B.bossChill + 0.1);
      out.slowAfter = b.slowK;
      out.freezeAfter = b.freeze;
      // 首领血条下的异常值条按累积量涨
      b.bu.fire = 0.5;
      b.buT.fire = 1e9; // 别让它在等界面的时候回落
      G.debug.hold(false);
      return out;
    });
    await until(() => { const f = document.querySelector('.boss-bu .fire b'); return document.getElementById('boss-box').classList.contains('on') && f && /scaleX\(0\.5\)/.test(f.style.transform); }).catch(() => {
      throw new Error('首领血条下的火焰异常值没有按累积量显示');
    });
    await ev(() => G.debug.hold(true));
    const B = await ev(() => G.BUILDUP);
    assert(r.freeze === 0 && r.chill === B.bossChill && r.locked === 0, '首领不应被冻结，冰霜灌满应是重度冰缓（期间不再累积）：' + JSON.stringify(r));
    assert(Math.abs(r.slowK - (1 - B.bossSlow)) < 1e-6 && r.slowAfter > 0.99 && r.freezeAfter === 0, '重度冰缓应放慢 ' + B.bossSlow * 100 + '% 并按时结束：' + JSON.stringify(r));
    assert(r.th[1] === 1 + B.bossGrow && r.th[2] === 1 + 2 * B.bossGrow && r.th[7] === B.bossGrowMax && r.fireTh === 1, '首领阈值应每次提高、封顶，各元素分开：' + JSON.stringify(r.th));
  });

  await summonStep('死亡时的异常：死时异常值过半（或正冻着 / 正感电）→ 尸爆（爆燃公式）/ 放电（电弧射向最近的几个敌人）/ 碎冰（尸体碎成冰碴、给周围灌冰霜异常值）；打死它的那一击灌满也照样按死亡结算；连锁最多几代、每帧有上限；lastHit 不被打乱', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, W = G.world, S = G.state, B = G.BUILDUP, out = {};
      const texts = [], dies = [], ot = W.text, od = W.die;
      W.text = function (x, z, str) { texts.push(String(str)); return ot.apply(W, arguments); };
      W.die = function (ent, o) { dies.push(o && o.type); return od.apply(W, arguments); };
      T.fix(0.5);
      try {
        // 阈值 100 的靶子；hp 给小了就是一击必死的
        const mk = (type, dx, dz, hp, elite) => {
          const e = T.mob(type, dx, dz, { elite });
          e.maxHp = 100 / B.th;
          G.initBuildUp(e);
          e.hp = hp || 1e6;
          e.maxHp = 1e6;
          return e;
        };
        const phys = (v) => ({ sk: { w: 0, kb: 0, poise: 0 }, base: { phys: [v, v] }, inc: {}, moreType: {}, more: 1, extra: {}, crit: 0, critMulti: 100, ailment: 0, stun: 0, leech: 0 });
        const elem = (t, v) => ({ sk: { w: 0, kb: 0, poise: 0 }, base: { [t]: [v, v] }, inc: {}, moreType: {}, more: 1, extra: {}, crit: 0, critMulti: 100, ailment: 0, stun: 0, leech: 0 });
        const st = (k) => S.stats[k] || 0;
        const tick = () => G.debug.step(1 / 60); // 换一帧：每帧上限重新计数
        // 尸爆：火焰异常值 60% 的敌人被一下物理打死，尸体按爆燃公式炸开；旁边的挨炸但火焰异常值不涨，远处的不受波及
        {
          const v = mk('husk', 5, 0, 1), n = mk('husk', 6.5, 0), far = mk('husk', 5 + B.blastR + 4, 0), low = mk('husk', 5, -6, 1), ln = mk('husk', 6.5, -6);
          v.bu.fire = 0.6; v.buFire = 40; v.buFireN = 2; // 平均每击 20
          low.bu.fire = B.deathMin - 0.1; low.buFire = 40; low.buFireN = 2;
          const c0 = st('corpseBlasts');
          const got = G.hitEnemy(v, phys(7), 1, { quiet: true });
          out.fire = { dead: v.dead, n: 1e6 - n.hp, want: Math.min(20 * B.blast, 100 * B.blastCap), far: 1e6 - far.hp, nbu: n.bu.fire, stat: st('corpseBlasts') - c0, text: texts.includes('尸爆') };
          out.lastHit = { total: G.lastHit.total, killed: G.lastHit.killed, type: G.lastHit.type, got };
          G.hitEnemy(low, phys(7), 1, { quiet: true });
          out.fire.low = { dead: low.dead, ln: 1e6 - ln.hp, stat: st('corpseBlasts') - c0 };
          G.clearEnemies();
          tick();
        }
        // 放电：闪电异常值 60% 的敌人死时向最近的 deathBoltN 个敌人各射一道电弧（平均每击闪电伤害 × deathBolt），不累积闪电异常值；感电中死掉也放电
        {
          const v = mk('husk', 5, 0, 1);
          const ns = [mk('husk', 6.5, 0), mk('husk', 5, 1.6), mk('husk', 3.5, 0), mk('husk', 5, -1.8), mk('husk', 5 + B.shockR + 3, 0)];
          v.bu.light = 0.6; v.buLit = 30; v.buLitN = 1;
          const d0 = st('deathShocks'), b0 = st('bolts');
          G.hitEnemy(v, phys(7), 1, { quiet: true });
          out.light = { dmg: ns.map((e) => Math.round((1e6 - e.hp) * 10) / 10), want: 30 * B.deathBolt, bu: ns.map((e) => e.bu.light), stat: st('deathShocks') - d0, bolts: st('bolts') - b0, text: texts.includes('放电') };
          const s1 = mk('husk', 5, 4, 1), s1n = mk('husk', 6.5, 4);
          s1.shockT = 2; s1.buLit = 20; s1.buLitN = 1; // 感电中：异常值是 0，但死时照样放电
          G.hitEnemy(s1, phys(7), 1, { quiet: true });
          out.light.shocked = { stat: st('deathShocks') - d0, n: 1e6 - s1n.hp };
          G.clearEnemies();
          tick();
        }
        // 碎冰：冰霜异常值 60% 的敌人死时尸体按冰霜碎掉，给周围的敌人灌冰霜异常值（按死者的阈值折算；精英灌得少）；正冻着的死了也碎
        {
          const v = mk('husk', 5, 0, 1), n = mk('husk', 6.5, 0), el = mk('husk', 5, 1.8, 0, true), far = mk('husk', 5 + B.shatterR + 4, 0);
          el.hp = 1e6;
          v.bu.cold = 0.6;
          const s0 = st('shatters');
          dies.length = 0;
          G.hitEnemy(v, phys(7), 1, { quiet: true });
          out.cold = { die: dies.slice(), n: n.bu.cold, want: Math.min(B.shatterCap, B.shatter), el: el.bu.cold, elWant: (100 * B.shatter) / G.buThreshold(el, 'cold'), far: far.bu.cold, stat: st('shatters') - s0, text: texts.includes('碎冰') };
          const fz = mk('husk', 5, -5, 1), fzn = mk('husk', 6.5, -5);
          fz.freeze = 1;
          dies.length = 0;
          G.hitEnemy(fz, phys(7), 1, { quiet: true });
          out.cold.frozen = { stat: st('shatters') - s0, die: dies.slice(), n: fzn.bu.cold };
          G.clearEnemies();
          tick();
        }
        // 打死它的那一击正好灌满：不走活着时的冻结 / 感电，按死亡触发结算（冰霜就碎成冰碴）
        {
          const v = mk('husk', 5, 0, 1), n = mk('husk', 6.5, 0);
          v.bu.cold = 0.9;
          const f0 = st('freezes'), s0 = st('shatters');
          dies.length = 0;
          G.hitEnemy(v, elem('cold', 50), 1, { quiet: true });
          out.killFill = { freezes: st('freezes') - f0, shatters: st('shatters') - s0, die: dies.slice(), n: n.bu.cold };
          G.clearEnemies();
          tick();
        }
        // 不在命中里的击杀（处决等）也结算死亡触发
        {
          const v = mk('husk', 5, 0, 1), n = mk('husk', 6.5, 0);
          v.bu.fire = 0.7; v.buFire = 10; v.buFireN = 1;
          G.killEnemy(v, {});
          out.direct = { n: 1e6 - n.hp, want: 10 * B.blast };
          G.clearEnemies();
          tick();
        }
        // 连锁保护：一排一碰就死、火焰异常值都过半的敌人，每个尸爆只够得着下一个——最多连 deathGen 代
        {
          const row = [];
          for (let i = 0; i < 6; i++) {
            const e = mk('husk', 4 + i * 3.5, 0, 1);
            e.bu.fire = 0.6; e.buFire = 50; e.buFireN = 1;
            row.push(e);
          }
          const c0 = st('corpseBlasts'), k0 = st('deathCapped');
          G.hitEnemy(row[0], phys(7), 1, { quiet: true });
          out.chain = { blasts: st('corpseBlasts') - c0, capped: st('deathCapped') - k0, dead: row.map((e) => (e.dead ? 1 : 0)) };
          G.clearEnemies();
          tick();
        }
        // 每帧上限：同一帧里打死一大堆过半的敌人，死亡触发至多 deathMax 次；下一帧重新计数
        {
          const pile = [];
          for (let i = 0; i < B.deathMax + 4; i++) {
            const e = mk('husk', 4 + (i % 4) * 1.2, -3 + Math.floor(i / 4) * 1.2, 1);
            e.bu.light = 0.6; // 平均每击为 0：放电没有伤害，只看次数
            pile.push(e);
          }
          const d0 = st('deathShocks');
          for (const e of pile) G.hitEnemy(e, phys(7), 1, { quiet: true });
          out.cap = { n: st('deathShocks') - d0 };
          tick();
          const more = mk('husk', 4, 4, 1);
          more.bu.light = 0.6;
          G.hitEnemy(more, phys(7), 1, { quiet: true });
          out.cap.next = st('deathShocks') - d0;
          G.clearEnemies();
        }
      } finally {
        W.text = ot;
        W.die = od;
        T.unfix();
      }
      return out;
    });
    const B = await ev(() => G.BUILDUP);
    const near = (a, b) => Math.abs(a - b) < Math.max(0.5, b * 0.03);
    assert(r.fire.dead && r.fire.stat === 1 && r.fire.text && near(r.fire.n, r.fire.want) && r.fire.far === 0 && r.fire.nbu === 0, '火焰异常值过半的敌人死时应尸爆（爆燃公式、不累积火焰异常值）：' + JSON.stringify(r.fire));
    assert(r.fire.low.dead && r.fire.low.stat === 1 && r.fire.low.ln === 0, '没过半的不尸爆：' + JSON.stringify(r.fire.low));
    assert(r.lastHit.total === 7 && r.lastHit.killed === true && r.lastHit.type === 'phys' && r.lastHit.got === 7, '死亡触发结算完 lastHit 应还原成打死它的那一击：' + JSON.stringify(r.lastHit));
    const hitN = r.light.dmg.filter((d) => d > 0).length;
    assert(r.light.stat === 1 && r.light.text && hitN === B.deathBoltN && r.light.dmg[4] === 0 && r.light.bolts === B.deathBoltN, '闪电异常值过半的敌人死时应向最近的 ' + B.deathBoltN + ' 个敌人放电：' + JSON.stringify(r.light));
    assert(r.light.dmg.filter((d) => d > 0).every((d) => near(d, r.light.want)) && r.light.bu.every((v) => v === 0), '每道电弧 = 平均每击闪电伤害 × ' + B.deathBolt + '，不累积闪电异常值：' + JSON.stringify(r.light));
    // 旁边那只挨两下：活着时感电的电弧（这一击 7 × bolt）+ 死亡放电
    assert(r.light.shocked.stat === 2 && near(r.light.shocked.n, 20 * B.deathBolt + 7 * B.bolt), '感电中死掉也应放电：' + JSON.stringify(r.light.shocked));
    assert(r.cold.stat === 1 && r.cold.text && r.cold.die[0] === 'cold' && Math.abs(r.cold.n - r.cold.want) < 1e-6 && Math.abs(r.cold.el - r.cold.elWant) < 1e-6 && r.cold.el < r.cold.n && r.cold.far === 0, '冰霜异常值过半的敌人死时应碎冰（冰碴、给周围灌冰霜异常值、精英灌得少）：' + JSON.stringify(r.cold));
    assert(r.cold.frozen.stat === 2 && r.cold.frozen.die[0] === 'cold' && r.cold.frozen.n > 0, '冻着的敌人死了也应碎冰：' + JSON.stringify(r.cold.frozen));
    assert(r.killFill.freezes === 0 && r.killFill.shatters === 1 && r.killFill.die[0] === 'cold' && r.killFill.n > 0, '打死它的那一击灌满冰霜：应碎冰而不是冻结一具尸体：' + JSON.stringify(r.killFill));
    assert(near(r.direct.n, r.direct.want), '不在命中里的击杀也应结算死亡触发：' + JSON.stringify(r.direct));
    assert(r.chain.blasts === B.deathGen && r.chain.capped >= 1 && r.chain.dead.slice(0, B.deathGen + 1).every((d) => d) && r.chain.dead[B.deathGen + 1] === 0, '死亡触发连锁最多 ' + B.deathGen + ' 代：' + JSON.stringify(r.chain));
    assert(r.cap.n === B.deathMax && r.cap.next === B.deathMax + 1, '每帧至多 ' + B.deathMax + ' 次死亡触发，下一帧重新计数：' + JSON.stringify(r.cap));
    return '尸爆 ' + Math.round(r.fire.n) + '，放电 ' + B.deathBoltN + ' × ' + r.light.want + '，碎冰灌 ' + r.cold.n.toFixed(2) + '（精英 ' + r.cold.el.toFixed(2) + '），连锁 ' + r.chain.blasts + ' 代';
  });

  await step('冷却 / 延迟技能：每次的伤害明显高于主力技能的一下；单独按冷却循环的秒伤打不过主力技能；技能卡写「每次伤害」并说明冷却', async () => {
    const r = await ev(() => {
      const out = {};
      const one = (id) => { const c = G.skillCtx(id); return { avg: G.avgHit(c), dps: G.skillDps(c), cd: c.cd, rate: G.skillRate(c) }; };
      out.meteor = one('meteor');
      out.blink = one('blink');
      out.ember = one('ember');
      out.cleave = one('cleave');
      out.arc = one('arc');
      G.ui.open('skills');
      const card = (name) => { const c = Array.from(document.querySelectorAll('.skill-card')).find((n) => n.querySelector('.sk-name').textContent.startsWith(name)); return c ? c.innerText : ''; };
      out.card = card('陨火');
      G.ui.close();
      return out;
    });
    const m = r.meteor, b = r.blink;
    assert(Math.abs(m.rate - 1 / m.cd) < 1e-9 && Math.abs(b.rate - 1 / b.cd) < 1e-9, '冷却技能的出手频率应按冷却算：' + JSON.stringify(r));
    assert(m.avg > r.ember.avg * 4 && m.avg > r.arc.avg * 4, '陨火每次的伤害应是掷焰 / 链雷一下的 4 倍以上：' + JSON.stringify(r));
    assert(b.avg > (r.cleave.avg / 1.3) * 2.5, '闪袭每次的伤害应明显高于裂石击的一刀：' + JSON.stringify(r));
    assert(m.dps < r.ember.dps && m.dps < r.arc.dps && b.dps < r.cleave.dps, '单独按冷却循环施放不应打过主力技能：' + JSON.stringify(r));
    // 穿插的收益：每个冷却周期多出一次大伤害，少放（施放时间 ÷ 主力出手间隔）下主力技能
    const gain = (cd, main) => (cd.avg / cd.cd - main.dps * (cd.cd > 0 ? (cd.id === 'blink' ? 0.2 : 0.6) / cd.cd : 0)) / main.dps;
    const gm = gain(m, r.ember), gb = gain(Object.assign({ id: 'blink' }, b), r.cleave);
    // 陨火冷却 5 秒（用户定的）：每次伤害高、冷却也不长，穿插收益比闪袭大
    assert(gm > 0.2 && gm < 0.6 && gb > 0.12 && gb < 0.3, '穿插冷却技能的秒伤收益不对（陨火 20%–60%，闪袭 12%–30%）：' + JSON.stringify({ gm, gb }));
    assert(r.card.includes('每次伤害') && r.card.includes('冷却技能') && r.card.includes(String(m.cd)), '陨火的技能卡应写每次伤害和冷却：' + r.card);
    return '陨火每次 ' + Math.round(m.avg) + '（掷焰 ' + Math.round(r.ember.avg) + '），穿插收益约 ' + Math.round(gm * 100) + '%；闪袭约 ' + Math.round(gb * 100) + '%';
  });

  // ------------------------------------------------------------------ 召唤
  // 召唤步骤：进来时清场并记下构筑，结束时散掉召唤物、还原构筑与天赋（后面的步骤不该被召唤物打扰）
  async function summonStep(name, fn) {
    await step(name, async () => {
      const snap = await ev(() => JSON.stringify({ b: T.buildSnap(), p: G.save.passives.slice(), lv: G.save.level }));
      try {
        return await fn();
      } finally {
        await ev((s) => {
          const o = JSON.parse(s);
          T.unfix();
          G.clearMinions();
          for (const k in G.save.autoSummon || {}) G.save.autoSummon[k] = false;
          G.save.passives = o.p;
          G.save.level = o.lv;
          T.buildRestore(o.b);
          G.clearEnemies();
          G.input.keys.KeyQ = G.input.keys.KeyE = false;
          G.input.mouse.b[0] = G.input.mouse.b[2] = false;
          G.debug.god(false);
        }, snap).catch(() => {});
      }
    });
  }

  await summonStep('召唤：在准星处唤起仆从（最远 6、落在可走的地面）；满 3 具时替换受伤最重的那具；守像只有 1 尊，重放即在新位置重铸', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, S = G.state, out = {};
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.computeStats();
      G.bindSkill(2, 'thrall');
      G.bindSkill(3, 'colossus');
      const cast = (key, x, z) => {
        for (let i = 0; i < 120 && P.cast; i++) G.tick(1 / 60);
        T.aim(x, z);
        P.mana = P.maxMana;
        const m0 = P.mana;
        G.input.tap[key === 'KeyQ' ? 2 : 3] = 0.3;
        for (let i = 0; i < 90 && !(P.cast && P.cast.fired); i++) G.tick(1 / 60);
        const spent = m0 - P.mana;
        G.debug.step(0.4);
        return spent;
      };
      out.cost = cast('KeyQ', P.x + 4, P.z);
      const m1 = S.minions[0];
      out.first = m1 ? { kind: m1.kind, d: Math.hypot(m1.x - (P.x + 4), m1.z - P.z), rising: m1.riseMax, clip: G.world.clipOf(m1.ent) } : null;
      out.ctxCost = G.skillCtx('thrall').cost;
      cast('KeyQ', P.x + 30, P.z + 2); // 远处：落点被限制在 6 以内
      const m2 = S.minions[1];
      out.farD = m2 ? Math.hypot(m2.x - P.x, m2.z - P.z) : -1;
      out.farOk = m2 ? G.world.walkable(m2.x, m2.z, 0.3) : false;
      cast('KeyQ', P.x, P.z + 4);
      out.n3 = S.minions.filter((m) => m.kind === 'thrall').length;
      // 第 2 具受了重伤：满编再放一具，替换掉的应是它
      const hurt = S.minions[1];
      hurt.hp = hurt.maxHp * 0.2;
      S.minions[0].hp = S.minions[0].maxHp * 0.6;
      cast('KeyQ', P.x - 4, P.z);
      out.n4 = S.minions.filter((m) => m.kind === 'thrall').length;
      out.replaced = hurt.dead && S.minions.indexOf(hurt) < 0;
      out.keptHurt = S.minions.indexOf(m1) >= 0;
      // 守像
      cast('KeyE', P.x + 3, P.z + 3);
      const c1 = S.minions.find((m) => m.kind === 'colossus');
      out.cd = P.cds.colossus > 0;
      P.cds.colossus = 0;
      cast('KeyE', P.x - 3, P.z - 3);
      const cs = S.minions.filter((m) => m.kind === 'colossus');
      out.col = { n: cs.length, oldGone: !!c1 && c1.dead, moved: cs.length === 1 && Math.hypot(cs[0].x - (P.x - 3), cs[0].z - (P.z - 3)) < 1.5 };
      const info = G.minionInfo('thrall');
      out.info = { count: info.count, cap: info.cap, ok: info.dmgMin > 0 && info.dmgMax >= info.dmgMin && info.life > 0 && info.rate > 0 };
      out.infoC = G.minionInfo('colossus').count;
      out.fields = Object.keys(S.minions[0]).filter((k) => ['kind', 'skill', 'ent', 'x', 'z', 'hp', 'maxHp', 'dead', 'target', 'atkT', 'tauntCd', 'tauntCdMax'].includes(k)).length;
      out.focusFn = typeof G.focusTarget === 'function' && G.focusTarget() === null;
      return out;
    });
    assert(r.cost === r.ctxCost && r.cost > 0, '施放召唤应扣魔力：' + JSON.stringify(r));
    assert(r.first && r.first.kind === 'thrall' && r.first.d < 1.2, '仆从应出现在准星处：' + JSON.stringify(r.first));
    assert(r.farD > 0 && r.farD <= 6.3 && r.farOk, '远处的落点应限制在 6 以内的可走地面：' + r.farD);
    assert(r.n3 === 3 && r.n4 === 3 && r.replaced && r.keptHurt, '满编时应替换受伤最重的那具：' + JSON.stringify(r));
    assert(r.cd && r.col.n === 1 && r.col.oldGone && r.col.moved, '守像只有 1 尊，重放在新位置：' + JSON.stringify(r.col));
    assert(r.info.count === 3 && r.info.cap === 3 && r.info.ok && r.infoC === 1, 'G.minionInfo 不对：' + JSON.stringify(r.info));
    assert(r.fields === 12 && r.focusFn, 'G.state.minions 字段或 G.focusTarget 不对：' + r.fields);
    return '仆从消耗 ' + r.cost + '，远处落点 ' + r.farD.toFixed(1);
  });

  await summonStep('自动召唤：按召唤键切换开关（按技能存档，默认关）；开着时在身边补到上限、间隔 0.5 秒，倒下自动补，魔力不足暂停、回蓝继续，守像受冷却限制；不打断施法与翻滚、不吃输入缓冲；Shift + 按键在准星处手动召唤；技能卡和技能栏能看到并切换', async () => {
    const face0 = await ev(() => G.player.face);
    try {
      return await autoSummonBody();
    } finally {
      // 这一步翻滚、转身过：朝向还原，后面的步骤（召唤物跟在身后的位置）不受影响
      await ev((f) => { G.player.face = G.player.drawFace = f; G.player.roll.t = G.player.roll.cd = 0; }, face0).catch(() => {});
    }
  });
  async function autoSummonBody() {
    await ev(() => {
      T.arena();
      G.debug.hold(true);
      G.debug.god(true);
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.save.bar = G.save.bar.map((b) => (b === 'nova' ? null : b)); // 霜环保留魔力会干扰魔力的账
      G.bindSkill(1, 'ember');
      G.bindSkill(2, 'thrall');
      G.bindSkill(3, 'colossus');
      G.computeStats();
      G.player.mana = G.player.maxMana;
      G.debug.step(1); // 重生后的等待过去
    });
    // 开关：真按 Q（main.js 的输入路径），不进缓冲、不起手
    const before = await ev(() => ({ def: JSON.stringify(G.newSave().autoSummon), cur: G.save.autoSummon.thrall }));
    await page.keyboard.press('KeyQ');
    const sw = await ev((KEY) => ({
      on: G.save.autoSummon.thrall, col: G.save.autoSummon.colossus, tap: G.input.tap[2], cast: !!G.player.cast,
      stored: JSON.parse(localStorage.getItem(KEY)).autoSummon, hud: document.querySelectorAll('#slots .slot')[2].classList.contains('auto'),
    }), SAVE_KEY);
    await ev(() => G.ui.update());
    const hudOn = await ev(() => {
      G.ui.update();
      const n = document.querySelectorAll('#slots .slot')[2];
      return { cls: n.classList.contains('auto'), ring: getComputedStyle(n.querySelector('.s-ring')).display, badge: getComputedStyle(n.querySelector('.s-auto')).display, txt: n.querySelector('.s-auto').textContent };
    });
    assert(before.def === '{"thrall":false,"colossus":false,"pyre":false}' && before.cur === false, '自动召唤应默认关：' + JSON.stringify(before));
    assert(sw.on === true && sw.col === false && sw.stored.thrall === true && !(sw.tap > 0) && !sw.cast, '按 Q 应切换仆从的自动召唤并写进存档，不起手、不留缓冲：' + JSON.stringify(sw));
    assert(hudOn.cls && hudOn.ring === 'block' && hudOn.badge === 'block' && hudOn.txt === '自动', '技能栏格子应显示「自动」状态：' + JSON.stringify(hudOn));

    const r = await ev(() => {
      const P = G.player, S = G.state, out = {};
      const cost = G.skillCtx('thrall').cost;
      const thralls = () => S.minions.filter((m) => m.kind === 'thrall' && !m.dead);
      T.aim(P.x + 5, P.z); // 准星在远处：自动召唤落在身边，不在准星处
      // 补到上限：记下每一只出现的时刻、落点、那一帧扣掉的魔力
      const ev0 = [];
      let t = 0;
      for (let i = 0; i < 240; i++) {
        const n0 = thralls().length, m0 = P.mana;
        G.tick(1 / 60);
        t += 1 / 60;
        if (thralls().length > n0) {
          const m = thralls()[thralls().length - 1];
          ev0.push({ t: +t.toFixed(3), d: +Math.hypot(m.x - P.x, m.z - P.z).toFixed(2), aimD: +Math.hypot(m.x - (P.x + 5), m.z - P.z).toFixed(2), spent: +(m0 - P.mana).toFixed(2), ok: G.world.walkable(m.x, m.z, 0.3) });
        }
      }
      out.fill = ev0;
      out.n = thralls().length;
      out.cost = cost;
      out.noCast = !P.cast;
      // 死了一具：自动补上
      G.hurtMinion(thralls()[0], 1e9, 'phys', null);
      out.afterKill = thralls().length;
      G.debug.step(0.6);
      out.refill = thralls().length;
      // 魔力不足：暂停；回蓝后继续
      for (const m of thralls()) G.hurtMinion(m, 1e9, 'phys', null);
      P.manaRegen = 0;
      P.mana = cost - 1;
      G.debug.step(1.5);
      out.starved = { n: thralls().length, mana: +P.mana.toFixed(2) };
      P.mana = cost + 0.5;
      G.debug.step(0.3);
      out.resumed = { n: thralls().length, mana: +P.mana.toFixed(2) };
      G.debug.step(1.0);
      out.oneOnly = thralls().length;
      G.computeStats();
      P.mana = P.maxMana;
      G.debug.step(1.5);
      out.full = thralls().length;
      return out;
    });
    const gaps = r.fill.slice(1).map((e, i) => +(e.t - r.fill[i].t).toFixed(3));
    assert(r.fill.length === 3 && r.n === 3 && r.fill[0].t < 0.1, '开着时应立刻开始、补到 3 具：' + JSON.stringify(r.fill));
    assert(gaps.every((g) => g >= 0.49 && g < 0.6), '两次自动召唤之间应隔约 0.5 秒：' + JSON.stringify(gaps));
    assert(r.fill.every((e) => e.d < 3.2 && e.aimD > 2 && e.ok), '自动召唤应落在玩家身边可走的地方，不在准星处：' + JSON.stringify(r.fill));
    assert(r.fill.every((e) => Math.abs(e.spent - r.cost) < 0.3) && r.noCast, '每次自动召唤应扣一次魔力、不起手：' + JSON.stringify({ fill: r.fill, cost: r.cost }));
    assert(r.afterKill === 2 && r.refill === 3, '召唤物死后应自动补上：' + JSON.stringify(r));
    assert(r.starved.n === 0 && r.starved.mana === r.cost - 1, '魔力不足应暂停：' + JSON.stringify(r.starved));
    assert(r.resumed.n === 1 && r.resumed.mana < 1 && r.oneOnly === 1 && r.full === 3, '回蓝后应继续补：' + JSON.stringify(r));

    // 守像：真按 E 开启；受冷却限制
    await page.keyboard.press('KeyE');
    const c = await ev(() => {
      const P = G.player, S = G.state, out = {};
      const cols = () => S.minions.filter((m) => m.kind === 'colossus' && !m.dead);
      out.on = G.save.autoSummon.colossus;
      P.mana = P.maxMana;
      G.debug.step(0.6);
      out.n1 = cols().length;
      out.cd = +(P.cds.colossus || 0).toFixed(2);
      out.cdMax = G.skillCtx('colossus').cd;
      G.hurtMinion(cols()[0], 1e9, 'phys', null);
      G.debug.step(1.5);
      out.waiting = { n: cols().length, cd: +(P.cds.colossus || 0).toFixed(2) };
      P.cds.colossus = 0.2;
      G.debug.step(0.4);
      out.n2 = cols().length;
      out.cd2 = P.cds.colossus > 0;
      return out;
    });
    assert(c.on && c.n1 === 1 && c.cd > c.cdMax - 1 && c.cdMax > 0, '守像开启后应自动召唤并进冷却：' + JSON.stringify(c));
    assert(c.waiting.n === 0 && c.waiting.cd > 0 && c.n2 === 1 && c.cd2, '守像倒下后应等冷却好了再补：' + JSON.stringify(c));

    // 不打断：施法途中、翻滚途中照常补；施法不被换掉、缓冲着的下一次施法照常放出来
    const a = await ev(() => {
      const P = G.player, S = G.state, out = {};
      const thralls = () => S.minions.filter((m) => m.kind === 'thrall' && !m.dead);
      P.mana = P.maxMana;
      P.cds = {};
      G.debug.step(0.6); // 间隔走完
      T.aim(P.x + 5, P.z);
      G.input.tap[1] = 0.3;
      G.tick(1 / 60);
      const c1 = P.cast;
      out.started = !!c1 && c1.id === 'ember' && !c1.fired;
      G.hurtMinion(thralls()[0], 1e9, 'phys', null);
      G.input.tap[1] = 0.6; // 施法途中又按了一下：缓冲着
      const n0 = thralls().length;
      G.tick(1 / 60);
      out.summonedMidCast = thralls().length === n0 + 1;
      out.sameCast = P.cast === c1;
      out.bufKept = G.input.tap[1] > 0.5;
      let fired = false, second = null;
      for (let i = 0; i < 120; i++) {
        G.tick(1 / 60);
        if (c1.fired) fired = true;
        if (P.cast && P.cast !== c1 && P.cast.id === 'ember') {
          second = P.cast;
          break;
        }
      }
      out.fired = fired;
      out.second = !!second;
      for (let i = 0; i < 120 && P.cast; i++) G.tick(1 / 60);
      // 翻滚
      G.debug.step(0.6);
      G.input.keys.KeyD = true;
      const rolled = G.dodge();
      G.input.keys.KeyD = false;
      const x0 = P.x, z0 = P.z, rt = P.roll.t;
      G.hurtMinion(thralls()[0], 1e9, 'phys', null);
      const n1 = thralls().length;
      G.tick(1 / 60);
      out.roll = { rolled, summoned: thralls().length === n1 + 1, still: P.roll.t > 0 && P.roll.t < rt, moved: +Math.hypot(P.x - x0, P.z - z0).toFixed(3), cast: !!P.cast };
      for (let i = 0; i < 60 && P.roll.t > 0; i++) G.tick(1 / 60);
      out.roll.dist = +Math.hypot(P.x - x0, P.z - z0).toFixed(2);
      return out;
    });
    assert(a.started && a.summonedMidCast && a.sameCast && a.fired, '施法途中应照常自动补、不打断施法：' + JSON.stringify(a));
    assert(a.bufKept && a.second, '自动召唤不应吃掉玩家的输入缓冲：' + JSON.stringify(a));
    assert(a.roll.rolled && a.roll.summoned && a.roll.still && a.roll.moved > 0 && !a.roll.cast, '翻滚途中应照常自动补、不打断翻滚：' + JSON.stringify(a.roll));

    // 处决途中、死亡时不补；Shift + Q 在准星处手动召唤（满编时替换最弱的那具）
    const x = await ev(() => {
      const P = G.player, S = G.state, out = {};
      const thralls = () => S.minions.filter((m) => m.kind === 'thrall' && !m.dead);
      P.mana = P.maxMana;
      G.debug.step(0.6);
      out.full = thralls().length;
      // 处决：真的处决一只露出破绽的靶子，途中倒下的仆从等处决结束再补
      T.dummy(1.6, 0);
      T.d.brokenT = 4;
      out.exec = G.execute(T.d) && !!P.exec;
      G.hurtMinion(thralls()[0], 1e9, 'phys', null);
      let during = 0, frames = 0;
      for (let i = 0; i < 240 && P.exec; i++) {
        G.tick(1 / 60);
        frames++;
        during = Math.max(during, thralls().length);
      }
      out.execFrames = frames;
      out.during = during;
      G.debug.step(0.1);
      out.afterExec = thralls().length;
      // 死亡：不补；复活后接着补
      G.hurtMinion(thralls()[0], 1e9, 'phys', null);
      P.dead = true;
      P.deadT = 99;
      G.debug.step(0.6);
      out.deadN = thralls().length;
      P.dead = false;
      P.deadT = 0;
      G.debug.step(0.6); // 死着的时候间隔计时也停着
      out.aliveN = thralls().length;
      G.clearEnemies();
      return out;
    });
    await ev(() => {
      const st = G.state.zone.start;
      T.tp(st.x, st.z); // 翻滚、处决挪过位置：回到入口的空地上，准星处一定是可走的地面
      G.debug.step(0.5); // 召唤物跟回身边
    });
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyQ');
    await page.keyboard.up('Shift');
    const m = await ev(() => {
      const P = G.player, S = G.state, out = {};
      out.stillOn = G.save.autoSummon.thrall;
      out.tap = G.input.tap[2] > 0;
      T.aim(P.x - 4, P.z + 1); // 渲染循环每帧按鼠标的屏幕位置刷新准星：要在推进的同一次调用里设
      for (let i = 0; i < 90 && !(P.cast && P.cast.fired); i++) G.tick(1 / 60);
      out.fired = !!(P.cast && P.cast.fired && P.cast.id === 'thrall');
      out.aimOk = G.world.walkable(P.x - 4, P.z + 1, 0.6);
      G.debug.step(0.3);
      const near = S.minions.filter((mm) => mm.kind === 'thrall' && Math.hypot(mm.x - (P.x - 4), mm.z - (P.z + 1)) < 1.2);
      out.atAim = near.length;
      out.n = S.minions.filter((mm) => mm.kind === 'thrall').length;
      return out;
    });
    assert(x.full === 3 && x.exec && x.execFrames > 5 && x.during === 2 && x.afterExec === 3, '处决途中不应自动补，处决完接着补：' + JSON.stringify(x));
    assert(x.deadN === 2 && x.aliveN === 3, '死亡时不应自动补，复活后接着补：' + JSON.stringify(x));
    assert(m.stillOn && m.tap && m.atAim === 1 && m.n === 3, 'Shift + Q 应在准星处手动召唤一次（不切换开关）：' + JSON.stringify(m));

    // 技能卡：能看到并切换开关；关掉后不再补
    await page.keyboard.press('KeyG');
    await until(() => T.tab() === 'skills');
    const card = await ev(() => {
      const b = document.querySelector('.sk-auto-btn[data-skill="thrall"]');
      return { has: !!b, on: b && b.closest('.sk-auto').classList.contains('on'), txt: b ? b.closest('.sk-auto').innerText : '', other: document.querySelectorAll('.sk-auto-btn').length };
    });
    await page.click('.sk-auto-btn[data-skill="thrall"]');
    const card2 = await ev((KEY) => {
      const b = document.querySelector('.sk-auto-btn[data-skill="thrall"]');
      return { save: G.save.autoSummon.thrall, stored: JSON.parse(localStorage.getItem(KEY)).autoSummon.thrall, off: !b.closest('.sk-auto').classList.contains('on'), txt: b.innerText };
    }, SAVE_KEY);
    await closePanel();
    const off = await ev(() => {
      const P = G.player, S = G.state, out = {};
      G.debug.hold(true);
      G.ui.update();
      out.hud = document.querySelectorAll('#slots .slot')[2].classList.contains('auto');
      for (const mm of S.minions.filter((mm) => mm.kind === 'thrall')) G.hurtMinion(mm, 1e9, 'phys', null);
      P.mana = P.maxMana;
      G.debug.step(2);
      out.n = S.minions.filter((mm) => mm.kind === 'thrall').length;
      // 从技能栏拿下守像：不再补；开关保留，放回去接着补
      for (const mm of S.minions.filter((mm) => mm.kind === 'colossus')) G.hurtMinion(mm, 1e9, 'phys', null);
      P.cds = {};
      G.bindSkill(3, null);
      G.debug.step(1);
      out.unbound = { n: S.minions.filter((mm) => mm.kind === 'colossus').length, kept: G.save.autoSummon.colossus };
      G.bindSkill(0, 'colossus'); // 换到另一格：开关跟着技能走
      G.debug.step(0.6);
      out.rebound = S.minions.filter((mm) => mm.kind === 'colossus').length;
      G.ui.update();
      out.hud0 = document.querySelectorAll('#slots .slot')[0].classList.contains('auto');
      return out;
    });
    assert(card.has && card.on && card.other === 3 && card.txt.includes('自动召唤') && card.txt.includes('Shift'), '召唤技能卡上应有自动召唤开关：' + JSON.stringify(card));
    assert(card2.save === false && card2.stored === false && card2.off && card2.txt.includes('关'), '点技能卡上的开关应关掉并存档：' + JSON.stringify(card2));
    assert(!off.hud && off.n === 0, '关掉后不应再补、技能栏的「自动」应消失：' + JSON.stringify(off));
    assert(off.unbound.n === 0 && off.unbound.kept && off.rebound === 1 && off.hud0, '从技能栏拿下时不补、开关保留；换到别的格子照常：' + JSON.stringify(off));

    // 存档：读回保留；旧存档补默认值；畸形值按关处理。
    // 读档会让新手提示把当前（高等级）角色当成老角色：这里只测存档，读完把存档世代还原，提示系统察觉不到
    const sv = await ev((KEY) => {
      const out = {};
      const epoch = G.saveEpoch;
      G.save.autoSummon.thrall = true;
      G.persist();
      const keep = localStorage.getItem(KEY);
      G.loadSave();
      out.back = JSON.stringify(G.save.autoSummon);
      const raw = JSON.parse(keep);
      delete raw.autoSummon;
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      out.old = JSON.stringify(G.save.autoSummon);
      raw.autoSummon = { thrall: 'yes', colossus: 1, cleave: true, junk: true };
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      out.bad = JSON.stringify(G.save.autoSummon);
      localStorage.setItem(KEY, keep);
      G.loadSave();
      G.saveEpoch = epoch;
      G.computeStats();
      return out;
    }, SAVE_KEY);
    assert(sv.back === '{"thrall":true,"colossus":true,"pyre":false}' && sv.old === '{"thrall":false,"colossus":false,"pyre":false}' && sv.bad === '{"thrall":false,"colossus":false,"pyre":false}', '自动召唤的存档不对：' + JSON.stringify(sv));
    return '间隔 ' + gaps.join(' / ') + ' 秒，每次扣 ' + r.cost + ' 魔力';
  }

  await summonStep('召唤物：自动寻敌、走正常命中路径伤害敌人（不算玩家的连击）；小怪会转头打靠近它的召唤物', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, out = {};
      P.life = P.maxLife = 1e6;
      const dummy = T.mob('brute', 6, 0);
      for (let i = 0; i < 3; i++) G.summonMinion('thrall', P.x + 2, P.z + i - 1);
      G.summonMinion('colossus', P.x - 2, P.z + 2);
      const st0 = Object.assign({}, S.stats);
      G.debug.step(4);
      out.dummyDmg = dummy.maxHp - dummy.hp;
      out.minionHits = (S.stats.minionHits || 0) - (st0.minionHits || 0);
      out.playerHits = S.stats.hits - st0.hits;
      out.chain = P.chain.n;
      out.focus = G.focusTarget();
      out.targets = S.minions.filter((m) => m.target === dummy).length;
      // 敌人反击：一只真正会打的游魂离仆从比离玩家近得多
      G.clearEnemies();
      G.clearMinions();
      T.tp(S.zone.circles[0].x - 5, S.zone.circles[0].z);
      const t = G.summonMinion('thrall', P.x + 6, P.z);
      G.debug.step(0.8);
      const hp0 = t.hp;
      t.hp = t.maxHp = 1e6;
      const husk = G.spawnMob('husk', t.x + 2.5, t.z, 1, { awake: true });
      husk.hp = husk.maxHp = 1e6;
      const life0 = P.life;
      G.debug.step(4);
      out.huskFoe = husk.foe === t;
      out.thrallHurt = t.maxHp - t.hp;
      out.playerHurt = life0 - P.life;
      out.hp0 = hp0;
      return out;
    });
    assert(r.dummyDmg > 0 && r.minionHits >= 4, '召唤物应自己攻击敌人：' + JSON.stringify(r));
    assert(r.playerHits === 0 && r.chain === 0 && !r.focus, '召唤物的命中不应算作玩家的连击或集火：' + JSON.stringify(r));
    assert(r.targets >= 3, '召唤物应都盯上了唯一的敌人：' + r.targets);
    assert(r.huskFoe && r.thrallHurt > 0 && r.playerHurt === 0, '靠近仆从的小怪应该打仆从：' + JSON.stringify(r));
    return '4 秒造成 ' + Math.round(r.dummyDmg) + '（' + r.minionHits + ' 次命中），仆从挨了 ' + Math.round(r.thrallHurt);
  });

  await summonStep('集火：玩家亲手打中的敌人被标记（4 秒），召唤物优先攻击它', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, S = G.state, W = G.world, out = {};
      const marks = [];
      const orig = W.focusMark;
      W.focusMark = (ent) => { marks.push(ent); if (orig) orig(ent); };
      try {
        const near = T.mob('husk', 2.5, 0);
        const far = T.mob('husk', -5, 2);
        for (let i = 0; i < 3; i++) G.summonMinion('thrall', P.x + 2, P.z + i - 1);
        G.debug.step(1.5);
        out.before = S.minions.filter((m) => m.target === near).length;
        G.hitEnemy(far, G.skillCtx('cleave'), 1);
        out.focus = G.focusTarget() === far;
        G.debug.step(0.1);
        out.marked = marks.length > 0 && marks[marks.length - 1] === far.ent;
        G.debug.step(2);
        out.after = S.minions.filter((m) => m.target === far).length;
        out.farHurt = far.maxHp - far.hp;
        G.debug.step(3);
        out.expired = G.focusTarget() === null && marks[marks.length - 1] === null;
      } finally {
        W.focusMark = orig;
      }
      return out;
    });
    assert(r.before >= 2, '没有集火目标时应先打最近的敌人：' + JSON.stringify(r));
    assert(r.focus && r.marked, '玩家打中的敌人应成为集火目标并被标记：' + JSON.stringify(r));
    assert(r.after === 3 && r.farHurt > 0, '召唤物应转去打集火目标：' + JSON.stringify(r));
    assert(r.expired, '集火标记应在 4 秒后消失：' + JSON.stringify(r));
  });

  await summonStep('守像：砸地伤害一圈敌人；嘲讽让周围的小怪只打它（首领只被吸引片刻）', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, out = {};
      P.life = P.maxLife = 1e6;
      const col = G.summonMinion('colossus', P.x + 4, P.z);
      col.hp = col.maxHp = 1e6;
      G.debug.step(1.1);
      col.tauntCd = 1;
      // 三只游魂都贴着玩家：平时它们打玩家
      const pack = [0, 1, 2].map((i) => {
        const e = G.spawnMob('husk', P.x + 1.2, P.z + (i - 1) * 1.2, 1, { awake: true });
        e.hp = e.maxHp = 1e6;
        return e;
      });
      G.debug.step(0.3);
      out.foeBefore = pack.filter((e) => e.foe === null).length;
      out.cdMax = col.tauntCdMax;
      let t = 0;
      while (t < 4 && !pack.every((e) => e.taunter === col)) {
        G.debug.step(0.1);
        t += 0.1;
      }
      out.tauntAt = t;
      out.tauntT = Math.min.apply(null, pack.map((e) => e.tauntT));
      out.cd = col.tauntCd;
      const life0 = P.life, col0 = col.hp;
      G.debug.step(1.6);
      out.playerHurt = life0 - P.life;
      out.colHurt = col0 - col.hp;
      out.slam = pack.reduce((s, e) => s + (e.maxHp - e.hp), 0);
      // 首领：嘲讽时间短
      const boss = G.spawnBoss('golem', P.x - 6, P.z, 1);
      out.bossT = G.tauntEnemy(boss, col, 3, 1.2) ? boss.tauntT : -1;
      return out;
    });
    assert(r.foeBefore === 3, '嘲讽之前游魂应打玩家：' + JSON.stringify(r));
    assert(r.tauntAt < 3 && r.tauntT > 2 && r.cdMax >= 6 && r.cd > 5, '守像应很快嘲讽周围的敌人：' + JSON.stringify(r));
    assert(r.playerHurt === 0 && r.colHurt > 0, '被嘲讽的敌人应只打守像：' + JSON.stringify(r));
    assert(r.slam > 0, '守像的砸地应伤到周围的敌人：' + JSON.stringify(r));
    assert(r.bossT > 0 && r.bossT < 2, '首领被嘲讽的时间应更短：' + r.bossT);
  });

  await summonStep('敌方预警圈、首领招式与弹丸也会伤到召唤物；没有召唤物挡着的弹丸照常打中玩家', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, out = {};
      P.life = P.maxLife = 1e6;
      const t = G.summonMinion('thrall', P.x + 5, P.z);
      G.debug.step(0.8);
      // 记下实际结算到这只仆从身上的伤害（生命上限每 0.5 秒按属性刷新，直接改 hp 再相减不可靠）
      let dealt = 0;
      const hm0 = G.hurtMinion;
      G.hurtMinion = function (m, amount) {
        if (m === t) dealt += amount;
        return hm0.apply(this, arguments);
      };
      const took = () => { const d = dealt; dealt = 0; return d; };
      t.hp = t.maxHp = 1e6;
      G.telegraph({ shape: 'circle', x: t.x, z: t.z, r: 1.5, dur: 0.1, dmg: 40, dtype: 'fire' });
      G.debug.step(0.2);
      out.tele = took();
      G.spawnProjectile({ owner: 'e', x: t.x, z: t.z - 3, dx: 0, dz: 1, speed: 12, dmg: 25, dtype: 'phys' });
      G.debug.step(0.5);
      out.proj = took();
      const l0 = P.life;
      G.spawnProjectile({ owner: 'e', x: P.x, z: P.z - 3, dx: 0, dz: 1, speed: 12, dmg: 25, dtype: 'phys' });
      G.debug.step(0.5);
      out.playerProj = l0 - P.life;
      // 首领的砸地：落在仆从身上
      const boss = G.spawnBoss('golem', t.x + 6, t.z, 1);
      boss.awake = true;
      t.hp = t.maxHp = 1e6;
      G.telegraph({ shape: 'circle', x: t.x, z: t.z, r: 4.6, dur: 0.2, dmg: boss.dmg * 1.5, dtype: 'phys', owner: boss, cancelIfOwnerDead: true });
      G.debug.step(0.3);
      out.boss = took();
      G.hurtMinion = hm0;
      // 打死：倒地后从列表里移除
      G.hurtMinion(t, 1e6, 'phys', boss);
      out.dead = t.dead && S.minions.indexOf(t) < 0;
      return out;
    });
    assert(r.tele >= 39 && r.tele <= 40.5, '预警圈应对召唤物结算伤害：' + JSON.stringify(r));
    assert(r.proj > 0, '敌方弹丸应能打中召唤物：' + JSON.stringify(r));
    assert(r.playerProj > 0, '没有召唤物挡着的弹丸仍应打中玩家：' + JSON.stringify(r));
    assert(r.boss > 0 && r.dead, '首领的预警圈应伤到召唤物，打死后移除：' + JSON.stringify(r));
  });

  await summonStep('焚骨祭司：Shift + 按键在准星处唤起，自动召唤补到上限 2 位；镶群聚 +1，天赋 / 护符的「仆从数量」不算；站在后排朝怪堆掷火弹，一弹炸到多个敌人，攒满焰蓄召下坠焰', async () => {
    await ev(() => {
      T.arena();
      T._face = [G.player.face, G.player.drawFace]; // 手动召唤会转身：步骤结束时转回来，不影响后面的步骤
      G.debug.god(true);
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.computeStats();
      G.bindSkill(3, 'pyre');
      G.debug.step(0.05);
    });
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyE');
    await page.keyboard.up('Shift');
    const a = await ev(() => {
      const P = G.player, S = G.state, out = {};
      const pyres = () => S.minions.filter((m) => m.kind === 'pyre' && !m.dead);
      T.aim(P.x + 3, P.z + 2);
      for (let i = 0; i < 90 && !(P.cast && P.cast.fired); i++) G.tick(1 / 60);
      out.fired = !!(P.cast && P.cast.fired && P.cast.id === 'pyre');
      G.debug.step(0.2);
      const p0 = pyres()[0];
      out.manual = pyres().length;
      out.atAim = p0 ? +Math.hypot(p0.x - (P.x + 3), p0.z - (P.z + 2)).toFixed(2) : -1;
      out.rise = p0 ? G.world.clipOf(p0.ent) : null;
      out.auto0 = G.save.autoSummon.pyre;
      // 自动召唤：补到上限
      G.toggleAutoSummon('pyre', true, true);
      for (let i = 0; i < 400 && pyres().length < 2; i++) {
        P.mana = P.maxMana;
        G.tick(1 / 60);
      }
      G.debug.step(1.2);
      out.auto = pyres().length;
      out.cap = G.minionInfo('pyre').cap;
      // 上限：镶群聚 +1；全局的「仆从数量」（天赋 / 护符）只加仆从
      if (G.save.supports.indexOf('horde') < 0) G.save.supports.push('horde');
      out.hordeFits = G.supportFits('pyre', 'horde') && !G.supportFits('colossus', 'horde');
      G.save.sockets.pyre = ['horde', null, null];
      G.computeStats();
      out.hordeCap = G.skillCtx('pyre').minion.cap;
      G.save.sockets.pyre = [null, null, null];
      G.computeStats();
      const mc = P.S.minionCap;
      P.S.minionCap = (mc || 0) + 2;
      out.globalCap = G.skillCtx('pyre').minion.cap;
      out.thrallGlobal = G.skillCtx('thrall').minion.cap - G.SKILLS.thrall.cap - Math.round(mc || 0);
      P.S.minionCap = mc;
      G.save.sockets.pyre = [null, null, null];
      G.computeStats();
      G.toggleAutoSummon('pyre', false, true);
      out.desc = /2 位/.test(G.SKILLS.pyre.desc) && /群聚/.test(G.SKILLS.pyre.desc) && /祭司/.test(G.SUPPORTS.horde.desc);
      return out;
    });
    assert(a.fired && a.manual === 1 && a.atAim < 1.2 && a.rise === 'rise' && a.auto0 === false, 'Shift + E 应在准星处唤起一位祭司（播破土动作）：' + JSON.stringify(a));
    assert(a.auto === 2 && a.cap === 2, '自动召唤应补到 2 位：' + JSON.stringify(a));
    assert(a.hordeFits && a.hordeCap === 3 && a.globalCap === 2 && a.thrallGlobal === 2 && a.desc, '群聚镶在祭司上 +1 位、守像镶不上；全局的仆从数量只加仆从，说明里写清楚：' + JSON.stringify(a));

    const b = await ev(() => {
      const P = G.player, S = G.state, out = {};
      T.fix(0.5);
      // 一团冻住的游魂（不会动、不会还手），离玩家 8 米（挑一个 10 米内没有墙的方向）
      const dir = T.openDir(12);
      const cx = P.x + dir.x * Math.min(8, dir.len - 1.5), cz = P.z + dir.z * Math.min(8, dir.len - 1.5);
      const pack = [];
      for (let i = 0; i < 5; i++) {
        const e = G.spawnMob('husk', cx + ((i % 3) - 1) * 0.9, cz + (Math.floor(i / 3) - 0.5) * 0.9, 1, { awake: true });
        e.hp = e.maxHp = 1e6;
        e.freeze = 1e9;
        e.atkCd = 1e9;
        pack.push(e);
      }
      // 每一帧祭司打中了几个不同的敌人（一枚火弹炸开就是一帧里打中好几个）
      const oh = G.hitEnemy;
      let frame = new Set(), best = 0, meteorW = 0;
      G.hitEnemy = function (e, ctx, mult, info) {
        if (info && info.minion && info.minion.kind === 'pyre') {
          frame.add(e);
          if (info.w === 2) meteorW++;
        }
        return oh(e, ctx, mult, info);
      };
      let bolts = 0, keep = 99;
      try {
        for (let i = 0; i < 600; i++) {
          frame = new Set();
          G.tick(1 / 60);
          best = Math.max(best, frame.size);
          bolts = Math.max(bolts, G.minionBolts());
          for (const m of S.minions) if (m.kind === 'pyre' && m.state === 'attack') keep = Math.min(keep, Math.hypot(m.x - cx, m.z - cz));
        }
      } finally {
        G.hitEnemy = oh;
      }
      out.perBlast = best;
      out.bolts = bolts;
      out.keep = +keep.toFixed(2);
      out.hurt = pack.filter((e) => e.hp < e.maxHp).length;
      out.meteors = S.stats.pyreMeteors || 0;
      out.meteorHits = S.stats.pyreMeteorHits || 0;
      out.meteorW = meteorW;
      out.focus = G.focusTarget(); // 玩家没出手：没有集火目标，按怪堆挑
      T.unfix();
      [P.face, P.drawFace] = T._face;
      return { ...out, focus: !!out.focus };
    });
    assert(b.bolts >= 1 && b.perBlast >= 3 && b.hurt === 5, '火弹应炸到怪堆里的多个敌人：' + JSON.stringify(b));
    assert(b.keep >= 5, '祭司应站在后排施法（离怪堆至少 5 米）：' + JSON.stringify(b));
    assert(b.meteors >= 1 && b.meteorHits >= 4 && b.meteorW >= 4, '攒满焰蓄应对怪堆召下坠焰：' + JSON.stringify(b));
    return '一弹最多炸到 ' + b.perBlast + ' 个，坠焰 ' + b.meteors + ' 次';
  });

  await summonStep('焚骨祭司：单个首领时攒满焰蓄引导灼链；集火目标优先；敌人贴身先退开；倒下化作灰烬、自动召唤补回；技能卡写出火弹与大招，召唤物条上有焰蓄条', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, S = G.state, out = {};
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.computeStats();
      G.bindSkill(3, 'pyre');
      const ps = [G.summonMinion('pyre', P.x - 1.5, P.z - 1), G.summonMinion('pyre', P.x + 1.5, P.z - 1)];
      G.debug.step(1.0);
      // 一个冻住的首领：火弹只打得到它一个，焰蓄攒满后放灼链
      const dir = T.openDir(14);
      const bd = Math.min(9, dir.len - 2.5);
      const boss = G.spawnBoss('golem', P.x + dir.x * bd, P.z + dir.z * bd, 1);
      boss.hp = boss.maxHp = 1e8;
      boss.freeze = 1e9;
      boss.dmg = 0; // 首领不吃冻结：招式照放，但不伤人（这里只看祭司怎么打它）
      boss.cd = 1e9;
      boss.awake = true;
      for (const m of ps) m.charge = m.ctx.minion.charge.max - 1;
      let beamSeen = false, beamTicks0 = S.stats.pyreBeamTicks || 0, w = { met: S.stats.pyreMeteors || 0 };
      for (let i = 0; i < 600; i++) {
        G.tick(1 / 60);
        if (ps.some((m) => m.state === 'beam')) beamSeen = true;
      }
      out.alive = ps.filter((m) => !m.dead).length;
      out.beam = beamSeen;
      out.ticks = (S.stats.pyreBeamTicks || 0) - beamTicks0;
      out.noMeteor = (S.stats.pyreMeteors || 0) === w.met;
      out.bossHurt = boss.maxHp - boss.hp > 0;
      // 集火：玩家打中的敌人成了目标，祭司转而打它
      const far = G.spawnMob('brute', P.x + dir.x * (bd - 3) - dir.z * 2, P.z + dir.z * (bd - 3) + dir.x * 2, 1, { awake: true });
      far.hp = far.maxHp = 1e7;
      far.freeze = 1e9;
      G.hitEnemy(far, G.skillCtx('cleave'), 0.01, {});
      G.debug.step(0.4);
      out.focus = G.focusTarget() === far && ps.every((m) => m.dead || m.target === far || m.state === 'beam');
      G.clearEnemies();
      // 贴身：一只醒着的游魂站到祭司身边，祭司应退开（往玩家那边）
      const m = ps[0];
      m.charge = 0;
      const e = G.spawnMob('husk', m.x + 0.9, m.z - 0.6, 1, { awake: true });
      e.hp = e.maxHp = 1e6;
      e.freeze = 1e9;
      const d0 = Math.hypot(m.x - e.x, m.z - e.z);
      G.debug.step(1.0);
      out.flee = +(Math.hypot(m.x - e.x, m.z - e.z) - d0).toFixed(2);
      G.clearEnemies();
      // 倒下：从列表里拿掉、模型演倒地；开着自动召唤会补回
      G.toggleAutoSummon('pyre', true, true);
      P.mana = P.maxMana;
      const ent = m.ent;
      G.hurtMinion(m, 1e9, 'phys', null);
      out.dead = m.dead && S.minions.indexOf(m) < 0 && !!ent.dying;
      for (let i = 0; i < 240 && S.minions.filter((x) => x.kind === 'pyre').length < 2; i++) {
        P.mana = P.maxMana;
        G.tick(1 / 60);
      }
      out.refill = S.minions.filter((x) => x.kind === 'pyre').length;
      G.toggleAutoSummon('pyre', false, true);
      return out;
    });
    assert(r.alive === 2 && r.beam && r.ticks >= 8 && r.noMeteor && r.bossHurt, '只有一个首领时焰蓄满了应引导灼链（不放坠焰）：' + JSON.stringify(r));
    assert(r.focus, '祭司应转去打集火目标：' + JSON.stringify(r));
    assert(r.flee > 0.8, '敌人贴身时祭司应先退开：' + JSON.stringify(r));
    assert(r.dead && r.refill === 2, '祭司倒下应演倒地并由自动召唤补回：' + JSON.stringify(r));
    // 技能卡：火弹半径、焰蓄与两种大招
    await page.keyboard.press('KeyG');
    const card = await ev(() => {
      const c = Array.from(document.querySelectorAll('.skill-card')).find((n) => n.textContent.includes('焚骨祭司'));
      const ico = c && c.querySelector('.ico');
      return { txt: c ? c.textContent : '', ico: ico ? getComputedStyle(ico).backgroundImage.length > 30 : false };
    });
    await closePanel();
    assert(/火弹爆炸半径/.test(card.txt) && /焰蓄 7 点/.test(card.txt) && /坠焰/.test(card.txt) && /灼链/.test(card.txt) && /数量/.test(card.txt) && card.ico, '祭司的技能卡应写出火弹半径、焰蓄与大招，并有图标：' + card.txt.slice(0, 200));
    // 召唤物条：每位祭司一枚图标，下面一道焰蓄条（攒满时整枚亮起）
    await ev(() => {
      for (const m of G.state.minions) if (m.kind === 'pyre') m.charge = m.ctx.minion.charge.max;
    });
    await frames(4);
    const hud = await ev(() => {
      const chips = Array.from(document.querySelectorAll('.mn.pyre'));
      return { n: chips.length, bar: chips.every((c) => getComputedStyle(c.querySelector('.mn-tc')).display !== 'none'), ready: chips.filter((c) => c.classList.contains('ready')).length };
    });
    assert(hud.n === 2 && hud.bar && hud.ready === 2, '召唤物条上应有两位祭司和焰蓄条：' + JSON.stringify(hud));
    return '灼链 ' + r.ticks + ' 跳，贴身退开 ' + r.flee + ' 米';
  });

  await summonStep('焚骨祭司：继承武器伤害时施法武器（杖 / 短杖 / 魂幡）按 2.2 倍计；多重投射一次掷 3 枚分头砸、扩域放大爆炸与坠焰；穿透 / 连锁镶不上；天赋「焚骨圣咏」扩大召唤物范围、加快焰蓄', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, out = {};
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.computeStats();
      const soul = (base) => {
        G.equip(G.debug.giveItem(0, 'weapon', base, G.save.level));
        G.computeStats();
        return [G.minionInherit(G.SKILLS.pyre).soul, G.minionInherit(G.SKILLS.thrall).soul];
      };
      out.blade = soul(0);
      out.staff = soul(1);
      out.wand = soul(2);
      out.banner = soul(7);
      // 辅助
      for (const id of ['multi', 'expanse', 'pierce', 'chain', 'fire', 'dominion']) if (G.save.supports.indexOf(id) < 0) G.save.supports.push(id);
      out.fits = ['multi', 'expanse', 'fire', 'dominion', 'pierce', 'chain', 'echo'].map((id) => id + ':' + G.supportFits('pyre', id)).join(' ');
      const base = G.skillCtx('pyre').minion;
      G.save.sockets.pyre = ['multi', 'expanse', null];
      G.computeStats();
      const sup = G.skillCtx('pyre').minion;
      out.bolts = [base.bolts, sup.bolts];
      out.rk = +(sup.explode / base.explode).toFixed(3);
      out.mk = +(sup.meteor.radius / base.meteor.radius).toFixed(3);
      // 多重投射：一次 3 枚，分给目标身边不同的敌人
      T.arena();
      G.save.sockets.pyre = ['multi', null, null];
      G.computeStats();
      const m = G.summonMinion('pyre', P.x, P.z - 1);
      G.debug.step(1.0);
      const es = [];
      const dir = T.openDir(12);
      const vd = Math.min(7, dir.len - 1.5);
      for (let i = 0; i < 3; i++) {
        const e = G.spawnMob('husk', P.x + dir.x * vd + dir.z * (i - 1) * 2.6, P.z + dir.z * vd - dir.x * (i - 1) * 2.6, 1, { awake: true });
        e.hp = e.maxHp = 1e6;
        e.freeze = 1e9;
        es.push(e);
      }
      let peak = 0;
      for (let i = 0; i < 120; i++) {
        G.tick(1 / 60);
        peak = Math.max(peak, G.minionBolts());
      }
      out.volley = peak;
      out.spread = es.filter((e) => e.hp < e.maxHp).length;
      G.save.sockets.pyre = [null, null, null];
      // 天赋：mm4 往外的一小支
      const T2 = G.TREE;
      out.nodes = ['mp0', 'mp1', 'mpn'].map((id) => (T2[id] ? T2[id].kind + ':' + Object.keys(T2[id].stats).join('+') : '-')).join(' ');
      G.debug.setLevel(30);
      G.resetPassives();
      const path = ['mm0', 'mm1', 'mm2', 'mm3', 'mm4', 'mp0', 'mp1', 'mpn'];
      out.alloc = path.map((id) => G.allocPassive(id)).every(Boolean);
      G.computeStats();
      out.S = { area: P.S.minionArea, charge: P.S.minionCharge };
      const tree = G.skillCtx('pyre').minion;
      out.treeRk = +(tree.explode / base.explode).toFixed(3);
      out.chargeK = tree.chargeK;
      out.colR = +(G.skillCtx('colossus').minion.radius / G.SKILLS.colossus.radius).toFixed(3);
      return out;
    });
    assert(r.staff[0] === 2.2 && r.wand[0] === 2.2 && r.banner[0] === 2.2 && r.blade[0] === 1 && r.staff[1] === 1 && r.banner[1] === 2.2, '祭司拿施法武器时继承按 2.2 倍（仆从只有魂幡按倍数）：' + JSON.stringify(r));
    assert(/multi:true/.test(r.fits) && /expanse:true/.test(r.fits) && /fire:true/.test(r.fits) && /dominion:true/.test(r.fits) && /pierce:false/.test(r.fits) && /chain:false/.test(r.fits) && /echo:false/.test(r.fits), '祭司能镶的辅助不对：' + r.fits);
    assert(r.bolts[0] === 1 && r.bolts[1] === 3 && Math.abs(r.rk - Math.sqrt(1.4)) < 0.01 && Math.abs(r.mk - Math.sqrt(1.4)) < 0.01, '多重投射 / 扩域对祭司不对：' + JSON.stringify(r));
    assert(r.volley === 3 && r.spread >= 2, '多重投射时一次应掷出 3 枚、分头砸向不同的敌人：' + JSON.stringify(r));
    assert(/notable:minionDmg\+minionArea\+minionCharge/.test(r.nodes) && r.alloc && r.S.area >= 30 && r.S.charge >= 30 && r.treeRk > 1.1 && r.chargeK >= 1.3 && r.colR > 1.1, '天赋「焚骨圣咏」这一支不对：' + JSON.stringify(r));
    return '继承 ×' + r.staff[0] + '，多重投射 ' + r.volley + ' 枚';
  });

  await step('召唤师后期：宝石 28 级以内的召唤物伤害成长和改版前一样，之后每级再 ×1.04（层级 2 跟得上怪物生命）；守像嘲讽首领 3 秒；祭司打单体的秒伤估算含灼链', async () => {
    const r = await ev(() => {
      const old = (l) => 1 + 0.11 * (l - 1) + 0.09 * Math.max(0, l - 20);
      const out = {};
      out.same = [1, 10, 17, 20, 26, 28].every((l) => Math.abs(G.minionDmgK(l) - old(l)) < 1e-9);
      out.k32 = +(G.minionDmgK(32) / old(32)).toFixed(4);
      out.k45 = +(G.minionDmgK(45) / old(45)).toFixed(4);
      out.taunt = G.SKILLS.colossus.taunt.boss;
      const boss = G.spawnBoss('golem', G.player.x + 30, G.player.z, 1);
      const t = G.SKILLS.colossus.taunt;
      const col = { dead: false, x: 0, z: 0 };
      out.bossT = G.tauntEnemy(boss, col, t.dur, t.boss) ? boss.tauntT : -1;
      G.clearEnemies();
      const c = G.skillCtx('pyre'), mi = c.minion;
      const ticks = Math.floor(mi.beam.dur / (mi.beam.tick * Math.min(1, mi.interval / c.sk.rate)) + 1e-6);
      const want = (G.avgHit(c) * mi.cap * (mi.charge.max + ticks * mi.beam.mult)) / (mi.charge.max * mi.interval + mi.beam.dur);
      out.dps = Math.abs(G.skillDps(c) - want) < 1e-6 && G.skillDps(c) > G.avgHit(c) * mi.cap / mi.interval;
      return out;
    });
    assert(r.same && Math.abs(r.k32 - Math.pow(1.04, 4)) < 1e-3 && Math.abs(r.k45 - Math.pow(1.04, 17)) < 1e-3, '召唤物伤害的后期成长不对：' + JSON.stringify(r));
    assert(r.taunt === 3 && r.bossT === 3, '守像应能嘲讽首领 3 秒：' + JSON.stringify(r));
    assert(r.dps, '祭司的秒伤估算应含灼链：' + JSON.stringify(r));
    return '宝石 45 级 ×' + r.k45;
  });

  await summonStep('召唤物跟随：换区域、重生、离得太远都会回到玩家身边；不追离玩家太远的敌人', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, S = G.state, out = {};
      for (let i = 0; i < 3; i++) G.summonMinion('thrall', P.x + 3, P.z + i - 1);
      G.summonMinion('colossus', P.x - 3, P.z);
      G.debug.step(1.2);
      // 走开一段：跟上来
      const c = S.zone.circles[0];
      T.tp(c.x, c.z - 5);
      G.debug.step(3);
      out.follow = S.minions.map((m) => Math.round(Math.hypot(m.x - P.x, m.z - P.z) * 10) / 10);
      // 离得太远：直接回到身边
      const cs = S.zone.circles, fc = cs.reduce((a, b) => (Math.hypot(b.x - P.x, b.z - P.z) > Math.hypot(a.x - P.x, a.z - P.z) ? b : a));
      T.tp(fc.x, fc.z);
      G.clearEnemies();
      G.debug.step(0.1);
      out.leash = S.minions.every((m) => Math.hypot(m.x - P.x, m.z - P.z) < 5 && m.rising > 0);
      // 换区域
      G.enterZone(G.state.zoneIdx, G.state.tier);
      G.clearEnemies();
      out.zone = { n: S.minions.length, near: S.minions.every((m) => Math.hypot(m.x - P.x, m.z - P.z) < 5 && !m.dead) };
      G.debug.step(1.5);
      // 重生
      G.respawn();
      G.clearEnemies();
      out.respawn = S.minions.length === 4 && S.minions.every((m) => Math.hypot(m.x - P.x, m.z - P.z) < 5);
      G.debug.step(1.2);
      // 远处的敌人（离玩家 15）不去追
      const far = T.mob('husk', 15, 0);
      G.debug.step(1.5);
      out.chaseFar = S.minions.filter((m) => m.target === far).length;
      out.farHurt = far.maxHp - far.hp;
      return out;
    });
    assert(r.follow.every((d) => d < 6.5), '召唤物应跟上玩家：' + JSON.stringify(r.follow));
    assert(r.leash, '离得太远的召唤物应回到玩家身边重新现身');
    assert(r.zone.n === 4 && r.zone.near, '换区域后召唤物应跟着出现在入口：' + JSON.stringify(r.zone));
    assert(r.respawn, '重生后召唤物应回到重生点身边');
    assert(r.chaseFar === 0 && r.farHurt === 0, '不应追离玩家太远的敌人：' + JSON.stringify(r));
  });

  await summonStep('辅助宝石：驭灵 / 坚骨 / 群聚 / 狂怒与通用辅助（迅捷、注入、蛮力、致命、震慑、扩域、节流）作用在召唤物上；回响、汲生、投射物类镶不上', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const save = G.save, out = {};
      for (const id of Object.keys(save.sockets)) save.sockets[id] = [null, null, null];
      G.computeStats();
      const fits = {};
      for (const s of ['echo', 'leech', 'multi', 'pierce', 'chain', 'dominion', 'ossify', 'horde', 'frenzy', 'haste', 'fire', 'brutal', 'precise', 'stagger', 'ailment', 'frugal', 'expanse']) {
        fits[s] = G.supportFits('thrall', s) ? 1 : 0;
      }
      out.fits = fits;
      out.expanseC = G.supportFits('colossus', 'expanse');
      out.hordeC = G.supportFits('colossus', 'horde'); // 守像只有 1 尊，群聚对它只有坏处
      out.minionOnCleave = ['dominion', 'ossify', 'horde', 'frenzy'].some((s) => G.supportFits('cleave', s));
      const base = G.minionInfo('thrall');
      const baseC = G.minionInfo('colossus');
      const baseCtx = G.skillCtx('thrall');
      const sock = (sk, list) => list.forEach((s, i) => G.socketSupport(sk, i, s));
      sock('thrall', ['dominion', 'horde', 'brutal']);
      const a = G.minionInfo('thrall');
      out.dmgK = a.dmgMin / base.dmgMin;
      out.capA = a.cap;
      sock('thrall', ['frenzy', 'haste', 'fire']);
      const b = G.minionInfo('thrall');
      const ctxB = G.skillCtx('thrall');
      out.rateK = b.rate / base.rate;
      out.castK = baseCtx.time / ctxB.time;
      out.fireExtra = ctxB.extra.fire;
      out.moveK = b.move / base.move;
      sock('colossus', ['ossify', 'expanse', 'frugal']);
      const c = G.minionInfo('colossus');
      const ctxC = G.skillCtx('colossus');
      out.lifeK = c.life / baseC.life;
      out.dr = c.dr;
      out.radiusK = c.radius / baseC.radius;
      out.cdK = ctxC.cd / G.SKILLS.colossus.cd;
      // 真实命中：震慑 + 致命（随机数钉死在必暴击），仆从的一击按 G.minionInfo 的数值结算并眩晕敌人
      sock('thrall', ['stagger', 'precise', null]);
      const info = G.minionInfo('thrall');
      const ctx = G.skillCtx('thrall');
      out.crit = ctx.crit;
      const P = G.player;
      const e = T.mob('husk', 2.5, 0);
      G.summonMinion('thrall', P.x + 1.2, P.z);
      G.debug.step(0.75);
      T.fix(0);
      const hp0 = e.hp;
      let t = 0;
      while (e.hp === hp0 && t < 3) { G.debug.step(1 / 60); t += 1 / 60; }
      T.unfix();
      out.hit = hp0 - e.hp;
      out.want = info.dmgMin * (ctx.critMulti / 100); // 随机数钉在 0：取最低伤害、必暴击
      out.stun = e.stunT > 0;
      // 存档里也不允许镶不适配的
      out.socketEcho = G.socketSupport('thrall', 2, 'echo');
      return out;
    });
    const f = r.fits;
    assert(!f.echo && !f.leech && !f.multi && !f.pierce && !f.chain, '回响 / 汲生 / 投射物类不应能镶在召唤技能上：' + JSON.stringify(f));
    assert(f.dominion && f.ossify && f.horde && f.frenzy && f.haste && f.fire && f.brutal && f.precise && f.stagger && f.ailment && f.frugal && !f.expanse && r.expanseC && !r.hordeC, '召唤技能可镶的辅助不对：' + JSON.stringify(f));
    assert(!r.minionOnCleave, '召唤物辅助不应能镶在非召唤技能上');
    assert(Math.abs(r.dmgK - 1.3 * 0.85 * 1.35) < 1e-6 && r.capA === 4, '驭灵 / 群聚 / 蛮力：' + JSON.stringify(r));
    assert(Math.abs(r.rateK - 1.2 * 1.25) < 1e-6 && Math.abs(r.castK - 1.25) < 1e-6 && r.fireExtra === 30 && Math.abs(r.moveK - 1.2) < 1e-6, '狂怒 / 迅捷 / 灼炎注入：' + JSON.stringify(r));
    assert(Math.abs(r.lifeK - 1.4) < 0.01 && r.dr === 40 && Math.abs(r.radiusK - Math.sqrt(1.4)) < 1e-6 && Math.abs(r.cdK - 0.75) < 1e-6, '坚骨 / 扩域 / 节流：' + JSON.stringify(r));
    assert(r.crit === 13 && Math.abs(r.hit - r.want) < 0.01 && r.stun, '仆从的命中应吃致命 / 震慑：' + JSON.stringify(r));
    assert(r.socketEcho === false, '不能把回响镶在召唤技能上');
  });

  await summonStep('召唤物细节：仆从横斩带到身边的敌人、命中帧与伤害同帧；一只召唤物最多牵制几只怪，远程怪认准玩家；仆从闪开小怪的预警圈，首领的招式躲不开且更疼；友方统一青色', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, W = G.world, out = {};
      P.life = P.maxLife = 1e6;
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.computeStats();
      T.fix(0.5);
      // 横斩：目标 + 身旁扇面里的一只被带到，身后的那只不受伤；命中帧落在攻击动作的 contact 上
      const th = G.summonMinion('thrall', P.x + 3, P.z);
      G.debug.step(0.8);
      th.hp = th.maxHp = 1e6;
      const tgt = T.mob('husk', 4.4, 0), side = T.mob('husk', 4.1, 0.9), back = T.mob('husk', 1.9, 0);
      S.focus = tgt;
      S.focusT = 10;
      const contact = [];
      const hit0 = G.hitEnemy;
      G.hitEnemy = function (e, ctx, mult, info) {
        if (info && info.minion === th && e === tgt) contact.push({ clip: W.clipOf(th.ent), t: th.ent.cT, c: th.ent.cContact });
        return hit0.apply(this, arguments);
      };
      try {
        G.debug.step(2.5);
      } finally {
        G.hitEnemy = hit0;
      }
      out.cleave = { tgt: tgt.maxHp - tgt.hp, side: side.maxHp - side.hp, back: back.maxHp - back.hp };
      out.contact = contact.slice(0, 3);
      out.cleaveN = G.skillCtx('thrall').minion.cleave;
      // 牵制上限：三只游魂都离仆从比离玩家近得多，最多 2 只盯着仆从，第三只去找玩家；远程怪认准玩家
      G.clearEnemies();
      th.x = P.x + 6;
      th.z = P.z;
      const pack = [0, 1, 2].map((i) => {
        const e = G.spawnMob('husk', th.x + 1.2, th.z + (i - 1) * 1.1, 1, { awake: true });
        e.hp = e.maxHp = 1e6;
        e.atkCd = 1e9;
        e.speed = 0;
        return e;
      });
      G.debug.step(1.2);
      out.hold = G.skillCtx('thrall').minion.hold;
      out.onThrall = pack.filter((e) => e.foe === th).length;
      out.onPlayer = pack.filter((e) => e.foe === null).length;
      // 远程怪：仆从贴在它跟前（比玩家近 3 以上），近战怪会转火仆从，喷吐者照样盯着玩家
      G.clearEnemies();
      const ax = th.x + (P.x - th.x) * 0.3, az = th.z + 1.2;
      const sp = G.spawnMob('spitter', ax, az, 1, { awake: true });
      const hk = G.spawnMob('husk', ax, az + 0.4, 1, { awake: true });
      for (const e of [sp, hk]) {
        e.hp = e.maxHp = 1e6;
        e.atkCd = 1e9;
        e.speed = 0;
      }
      G.debug.step(2 / 60);
      out.foeGap = Math.hypot(P.x - ax, P.z - az) - (Math.hypot(th.x - ax, th.z - az) - th.r);
      out.spitterFoe = sp.foe === null ? 'player' : 'minion';
      out.huskFoe = hk.foe === th ? 'minion' : 'player';
      // 小怪的预警圈：仆从看清后闪出去，一点不掉血
      G.clearEnemies();
      G.debug.step(2.5); // 回到玩家身边站定
      const mob = { isBoss: false, dead: false, held: false }, boss = { isBoss: true, dead: false };
      const x0 = th.x, z0 = th.z, h0 = th.hp;
      G.telegraph({ shape: 'circle', x: x0, z: z0, r: 2.6, dur: 0.85, dmg: 50, dtype: 'phys', owner: mob, cancelIfOwnerDead: true });
      G.debug.step(1);
      out.dodged = { hurt: h0 - th.hp, moved: Math.hypot(th.x - x0, th.z - z0) };
      // 首领的预警圈：不躲，伤害按 BOSS_VS_MINION 加重
      // （召唤物的生命上限每 0.5 秒按属性刷新一次，所以这里记下实际结算的伤害，而不是看剩余生命）
      G.debug.step(2.5);
      let bossHit = 0;
      const hm0 = G.hurtMinion;
      G.hurtMinion = function (m, amount) {
        if (m === th) bossHit += amount * (1 - (m.dr || 0) / 100);
        return hm0.apply(this, arguments);
      };
      try {
        G.telegraph({ shape: 'circle', x: th.x, z: th.z, r: 2.6, dur: 0.85, dmg: 50, dtype: 'phys', owner: boss, cancelIfOwnerDead: true });
        G.debug.step(1);
      } finally {
        G.hurtMinion = hm0;
      }
      out.bossHit = bossHit;
      out.bossK = G.BOSS_VS_MINION;
      // 友方颜色：召唤物逻辑、界面 CSS、图标用的是同一种青
      const css = getComputedStyle(document.documentElement).getPropertyValue('--ally').trim().toLowerCase();
      out.ally = { hex: '#' + G.ALLY_HEX.toString(16).padStart(6, '0'), css, icon: (G.icons.ally || '').toLowerCase() };
      return out;
    });
    assert(r.cleaveN > 0 && r.cleave.tgt > 0 && r.cleave.side > 0 && r.cleave.back === 0, '仆从横斩应带到身旁扇面里的敌人、不碰身后的：' + JSON.stringify(r));
    assert(r.contact.length >= 2 && r.contact.every((c) => c.clip === 'attack' && c.c > 0 && Math.abs(c.t - c.c) <= 1.5 / 60), '仆从的伤害应落在攻击动作的命中帧上：' + JSON.stringify(r.contact));
    assert(r.hold === 2 && r.onThrall === 2 && r.onPlayer === 1, '一具仆从最多牵制 2 只小怪，多出来的去找玩家：' + JSON.stringify(r));
    assert(r.foeGap > 2.5 && r.huskFoe === 'minion' && r.spitterFoe === 'player', '近战小怪转火贴身的仆从，远程小怪应认准玩家：' + JSON.stringify(r));
    assert(r.dodged.hurt === 0 && r.dodged.moved > 1, '仆从应闪开小怪的预警圈：' + JSON.stringify(r.dodged));
    assert(r.bossK > 1 && Math.abs(r.bossHit - 50 * r.bossK) < 0.5, '首领的预警圈打在召唤物身上应加重、而且躲不开：' + JSON.stringify(r));
    assert(r.ally.hex === r.ally.css && r.ally.css === r.ally.icon, '友方颜色应统一：' + JSON.stringify(r.ally));
    return '横斩 ' + Math.round(r.cleave.tgt) + ' / ' + Math.round(r.cleave.side) + '，首领对召唤物 ×' + r.bossK;
  });

  await summonStep('统御支路与基石「万骸之主」：召唤物更强、仆从 +1，玩家自身（非召唤物）的伤害真的少 30%；天赋页完整显示这一支', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, save = G.save, out = {};
      for (const id of Object.keys(save.sockets)) save.sockets[id] = [null, null, null];
      G.debug.setLevel(30);
      G.resetPassives();
      const e = T.mob('husk', 2, 0);
      T.fix(0.5);
      const hit = () => { const h = e.hp; G.hitEnemy(e, G.skillCtx('cleave'), 1); return h - e.hp; };
      const own0 = hit();
      const info0 = G.minionInfo('thrall');
      const md0 = P.S.minionDmg, ml0 = P.S.minionLife; // 身上的装备可能也带召唤物词缀
      const ids = ['mm0', 'mm1', 'mm2', 'mm3', 'mm4', 'mk'];
      out.alloc = ids.map((id) => G.allocPassive(id));
      const own1 = hit();
      const info1 = G.minionInfo('thrall');
      out.ownK = own1 / own0;
      out.cap = [info0.cap, info1.cap];
      // 召唤物：统御 10+10+8、灵契 10 的伤害提高（minionDmg 38%），基石总伤害 +25%
      out.dmgK = info1.dmgMin / info0.dmgMin;
      out.want = ((1 + P.S.minionDmg / 100) / (1 + md0 / 100)) * 1.25;
      out.md = P.S.minionDmg - md0;
      out.life = info1.life / info0.life;
      out.lifeWant = (1 + P.S.minionLife / 100) / (1 + ml0 / 100);
      // 仆从的真实一击不受「自身伤害少 30%」影响
      G.summonMinion('thrall', P.x + 1, P.z);
      G.debug.step(0.75);
      T.fix(0.5);
      const hp0 = e.hp;
      let t = 0;
      while (e.hp === hp0 && t < 3) { G.debug.step(1 / 60); t += 1 / 60; }
      out.minionHit = hp0 - e.hp;
      out.minionWant = (info1.dmgMin + info1.dmgMax) / 2;
      T.unfix();
      out.more = G.skillCtx('ember').more;
      out.ml = ['ml0', 'ml1', 'mr0', 'mr1'].map((id) => G.allocPassive(id));
      out.cap2 = G.minionInfo('thrall').cap;
      out.S = { speed: P.S.speed, minionSpeed: P.S.minionSpeed, mana: P.S.mana };
      out.nodes = Object.keys(G.TREE).filter((id) => G.TREE[id].arm === 'm').length;
      return out;
    });
    assert(r.alloc.every(Boolean), '统御支路应能从起点一路点到基石：' + JSON.stringify(r.alloc));
    assert(Math.abs(r.ownK - 0.7) < 1e-6 && Math.abs(r.more - 0.7) < 1e-9, '万骸之主：自身伤害应少 30%：' + JSON.stringify(r));
    assert(r.cap[0] >= 3 && r.cap[1] === r.cap[0] + 1 && r.cap2 === r.cap[0] + 2, '万骸之主与「骸军」各 +1 仆从：' + JSON.stringify(r));
    assert(r.md === 38 && Math.abs(r.dmgK - r.want) < 1e-6 && Math.abs(r.life - r.lifeWant) < 0.02 && r.life > 1.05, '召唤物伤害 / 生命加成不对：' + JSON.stringify(r));
    assert(Math.abs(r.minionHit - r.minionWant) < 0.01, '召唤物的命中不应吃自身伤害惩罚：' + JSON.stringify(r));
    assert(r.ml.every(Boolean) && r.S.speed >= 4 && r.S.minionSpeed >= 10 && r.S.mana >= 30, '旁支的施法速度 / 召唤物速度 / 魔力：' + JSON.stringify(r.S));
    assert(r.nodes === 29, '统御支路应有 29 个节点（原有 10 个 + 外圈继承装备的两条线与基石 16 个 + 焚骨祭司的 3 个）：' + r.nodes);
    // 天赋页：这一支的每个节点和名字都在画面里、不和别的节点重叠
    await page.keyboard.press('KeyP');
    const v = await ev(() => {
      const svg = document.getElementById('tree-svg').getBoundingClientRect();
      const box = (n) => n.getBoundingClientRect();
      const inside = (b) => b.left >= svg.left - 1 && b.right <= svg.right + 1 && b.top >= svg.top - 1 && b.bottom <= svg.bottom + 1;
      const ns = Array.from(document.querySelectorAll('#tree-svg .tn'));
      const m = ns.filter((n) => G.TREE[n.dataset.node].arm === 'm');
      const out = { n: m.length, out: m.filter((n) => !inside(box(n.querySelector('.shape')))).map((n) => n.dataset.node), overlap: [], labels: 0, labelOut: [] };
      const ctr = (n) => { const b = box(n.querySelector('.shape')); return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2, r: b.width / 2 }; };
      for (const a of m) for (const b of ns) {
        if (a === b) continue;
        const p = ctr(a), q = ctr(b);
        if (Math.hypot(p.x - q.x, p.y - q.y) < (p.r + q.r) * 0.92) out.overlap.push(a.dataset.node + '/' + b.dataset.node);
      }
      for (const t of document.querySelectorAll('#tree-svg text.tl')) {
        if (['万骸之主', '亡者狂潮', '骸军'].includes(t.textContent)) {
          out.labels++;
          if (!inside(box(t))) out.labelOut.push(t.textContent);
        }
      }
      return out;
    });
    await closePanel();
    assert(v.n === r.nodes && v.out.length === 0 && v.overlap.length === 0, '天赋页里统御支路显示不全或重叠：' + JSON.stringify(v));
    assert(v.labels === 3 && v.labelOut.length === 0, '统御支路的核心 / 基石名字应完整显示：' + JSON.stringify(v));
    return '自身伤害 ×' + r.ownK.toFixed(2) + '，仆从上限 ' + r.cap2;
  });

  await step('召唤物词缀：召唤物伤害出在武器 / 戒指 / 护符上（杖类更多），召唤物生命出在头盔 / 胸甲 / 腰带上，「仆从数量 +1」只在高物品等级的稀有护符上', async () => {
    const r = await ev(() => {
      const out = { dmgSlots: {}, lifeSlots: {}, cap: { rare20: 0, rare10: 0, magic20: 0, val: [] }, staff: 0, blade: 0, staffN: 0, bladeN: 0 };
      for (let i = 0; i < 1600; i++) {
        const slot = G.SLOTS[i % 8];
        const it = G.rollItem(20, 2, slot);
        for (const a of it.affixes) {
          if (a.id === 'minionDmg') out.dmgSlots[slot] = 1;
          if (a.id === 'minionLife') out.lifeSlots[slot] = 1;
        }
      }
      for (let i = 0; i < 1500; i++) {
        const w = G.rollItem(20, 2, 'weapon');
        const has = w.affixes.some((a) => a.id === 'minionDmg');
        // 施法武器（长杖 / 短杖 / 魂幡）对比非施法武器（刃 / 双匕 / 战锤 / 长弓 / 太刀）
        if (!G.BASES.weapon[w.baseIdx].caster) { out.bladeN++; out.blade += has ? 1 : 0; } else { out.staffN++; out.staff += has ? 1 : 0; }
      }
      for (let i = 0; i < 600; i++) {
        const a = G.rollItem(20, 2, 'amulet').affixes.find((x) => x.id === 'minionCap');
        if (a) { out.cap.rare20++; out.cap.val.push(a.v); }
        if (G.rollItem(10, 2, 'amulet').affixes.some((x) => x.id === 'minionCap')) out.cap.rare10++;
        if (G.rollItem(20, 1, 'amulet').affixes.some((x) => x.id === 'minionCap')) out.cap.magic20++;
      }
      out.cap.val = Array.from(new Set(out.cap.val));
      out.fmt = [G.fmtStat('minionDmg', 12), G.fmtStat('minionLife', 20), G.fmtStat('minionSpeed', 10), G.fmtStat('minionCap', 1), G.fmtStat('minionMore', 25), G.fmtStat('ownLess', 30)];
      out.tags = [G.TAG_NAME.minion, G.TAG_NAME.summon];
      return out;
    });
    assert(Object.keys(r.dmgSlots).sort().join() === 'amulet,ring,weapon', '召唤物伤害词缀的部位不对：' + JSON.stringify(r.dmgSlots));
    assert(Object.keys(r.lifeSlots).sort().join() === 'belt,body,helm', '召唤物生命词缀的部位不对：' + JSON.stringify(r.lifeSlots));
    assert(r.staff / r.staffN > (r.blade / r.bladeN) * 2, '杖类武器应更容易出召唤物伤害：' + JSON.stringify(r));
    assert(r.cap.rare20 > 0 && r.cap.rare10 === 0 && r.cap.magic20 === 0 && r.cap.val.join() === '1', '「仆从数量 +1」只应出在高等级稀有护符上：' + JSON.stringify(r.cap));
    assert(r.fmt.every((s) => !/\{|undefined|NaN/.test(s)) && r.tags.every(Boolean), '召唤物属性 / 标签的文字不对：' + JSON.stringify(r));
    return r.fmt.join('；');
  });

  // ------------------------------------------------------------------ 面板
  await step('面板：I / G / P / M / H 打开对应页签并渲染内容，Esc 与再按一次关闭', async () => {
    await ev(() => {
      T.arena();
      G.debug.hold(false);
      for (let i = 0; i < 6; i++) G.debug.giveItem(i % 3);
    });
    const tabs = [['KeyI', 'inv'], ['KeyG', 'skills'], ['KeyP', 'tree'], ['KeyM', 'map'], ['KeyH', 'help']];
    for (const [key, tab] of tabs) {
      await page.keyboard.press(key);
      const r = await ev(() => ({ tab: T.tab(), txt: T.bodyText(), on: document.querySelector('.tab.on') && document.querySelector('.tab.on').dataset.tab }));
      assert(r.tab === tab && r.on === tab, key + ' 没有打开 ' + tab + '（实际 ' + r.tab + '）');
      cleanText(r.txt, tab + ' 页');
      const t0 = await ev(() => G.state.time);
      await page.keyboard.down('KeyD');
      await frames(2);
      await page.keyboard.up('KeyD');
      const p = await ev(() => ({ t: G.state.time, x: G.player.x }));
      assert(p.t === t0 && p.x === 0, '面板打开时游戏没有暂停');
      await page.keyboard.press(key);
      assert(!(await ev(() => G.ui.isOpen())), '再按一次 ' + key + ' 应关闭面板');
    }
    // 页签按钮、HUD 快捷按钮、关闭按钮、点击暗处
    await page.click('.kh[data-open="inv"]');
    assert((await ev(() => T.tab())) === 'inv', 'HUD 按钮没有打开背包');
    for (const [, tab] of tabs) {
      await page.click('.tab[data-tab="' + tab + '"]');
      assert((await ev(() => T.tab())) === tab, '页签按钮 ' + tab + ' 无效');
    }
    await page.click('#panel-close');
    assert(!(await ev(() => G.ui.isOpen())), '关闭按钮无效');
    await page.keyboard.press('KeyI');
    await page.mouse.click(6, 450);
    assert(!(await ev(() => G.ui.isOpen())), '点击面板外的暗处应关闭');
    await ev(() => G.debug.hold(true));
  });

  await step('背包：选中、装备、对比提示、双击换装、卸下、分解', async () => {
    const ids = await ev(() => {
      G.save.bag.length = 0;
      const a = G.debug.giveItem(1, 'helm');
      const b = G.debug.giveItem(2, 'helm');
      const c = G.debug.giveItem(2, 'boots');
      for (let i = 0; i < 3; i++) G.debug.giveItem(0);
      G.save.cur.augment = 0;
      return { a: a.uid, b: b.uid, c: c.uid, armour: G.player.armour };
    });
    await page.keyboard.press('KeyI');
    const cell = (uid) => '.cell[data-item="' + uid + '"]';
    await page.click(cell(ids.a));
    assert(await ev(() => !!document.querySelector('.detail-card .icard') && !!document.querySelector('[data-act="equip"]')), '选中后没有出现详情');
    await page.click('[data-act="equip"]');
    let r = await ev((ids) => ({
      eq: G.save.equip.helm && G.save.equip.helm.uid, inBag: G.save.bag.some((it) => it.uid === ids.a),
      armour: G.player.armour, slotEl: !!document.querySelector('.eq[data-item="' + ids.a + '"]'),
    }), ids);
    assert(r.eq === ids.a && !r.inBag && r.slotEl, '装备失败：' + JSON.stringify(r));
    assert(r.armour > ids.armour, '装备头盔后护甲没有增加');
    const armA = r.armour;

    await page.hover(cell(ids.b));
    r = await ev(() => ({ on: document.getElementById('tip').classList.contains('on'), pair: !!document.querySelector('#tip .tip-pair'), txt: document.getElementById('tip').innerText }));
    assert(r.on && r.pair && r.txt.includes('当前装备'), '悬停没有出现与当前装备的对比');
    cleanText(r.txt, '物品提示');

    const box = await page.locator(cell(ids.b)).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    r = await ev((ids) => ({ eq: G.save.equip.helm.uid, back: G.save.bag.some((it) => it.uid === ids.a), n: G.save.bag.length }), ids);
    assert(r.eq === ids.b && r.back && r.n === 5, '双击换装失败：' + JSON.stringify(r));

    await page.click('.eq[data-item="' + ids.b + '"]');
    await page.click('[data-act="unequip"]');
    r = await ev((ids) => ({ eq: G.save.equip.helm, back: G.save.bag.some((it) => it.uid === ids.b), armour: G.player.armour }), ids);
    assert(!r.eq && r.back && r.armour === ids.armour, '卸下失败：' + JSON.stringify(r));

    await page.click(cell(ids.c));
    await page.click('[data-act="salvage"]');
    r = await ev((ids) => ({ gone: !G.save.bag.some((it) => it.uid === ids.c), aug: G.save.cur.augment }), ids);
    assert(r.gone && r.aug === 1, '分解稀有物品应移除物品并得到 1 增幅尘：' + JSON.stringify(r));

    await page.click('[data-act="salvage-all"]');
    r = await ev(() => ({ normals: G.save.bag.filter((it) => it.rarity === 0).length, n: G.save.bag.length, dis: document.querySelector('[data-act="salvage-all"]').disabled }));
    assert(r.normals === 0 && r.n === 2 && r.dis, '分解所有普通物品失败：' + JSON.stringify(r));
    cleanText(await ev(() => T.bodyText()), '背包页');
    return '护甲 ' + ids.armour + ' → ' + armA;
  });

  await step('通货：8 种通货都能通过背包界面改造合适的物品', async () => {
    const uid = await ev(() => {
      G.save.bag.length = 0;
      for (const id of G.CUR_IDS) G.save.cur[id] = 1;
      const it = G.debug.giveItem(0, 'ring');
      const it2 = G.debug.giveItem(0, 'helm');
      return { ring: it.uid, helm: it2.uid };
    });
    const state = (u) => ev((u) => {
      const it = G.save.bag.find((x) => x.uid === u);
      const btn = {};
      document.querySelectorAll('.craft-btn').forEach((b) => (btn[b.dataset.cur] = !b.disabled));
      return { rarity: it.rarity, n: it.affixes.length, ids: it.affixes.map((a) => a.id).join(','), tiers: it.affixes.map((a) => a.tier).join(','), name: it.name, base: it.baseName, btn, cur: Object.assign({}, G.save.cur) };
    }, u);
    const use = async (cur) => {
      const sel = '.craft-btn[data-cur="' + cur + '"]';
      assert(await ev((s) => !document.querySelector(s).disabled, sel), cur + ' 按钮不可用');
      await page.click(sel);
    };
    await page.click('.cell[data-item="' + uid.ring + '"]');
    let s = await state(uid.ring);
    assert(s.btn.dust && s.btn.alch && !s.btn.augment && !s.btn.regal && !s.btn.exalt && !s.btn.chaos && !s.btn.chisel && !s.btn.divine, '普通物品的可用通货不对：' + JSON.stringify(s.btn));
    await use('dust');
    s = await state(uid.ring);
    assert(s.rarity === 1 && s.n === 1 && s.cur.dust === 0 && s.name !== s.base, '微光尘：' + JSON.stringify(s));
    assert(!s.btn.dust, '用完的通货按钮应禁用');
    await use('augment');
    s = await state(uid.ring);
    assert(s.rarity === 1 && s.n === 2 && s.cur.augment === 0, '增幅尘：' + JSON.stringify(s));
    await use('regal');
    s = await state(uid.ring);
    assert(s.rarity === 2 && s.n === 3 && s.cur.regal === 0, '冠冕石：' + JSON.stringify(s));
    const rareName = s.name;
    await use('exalt');
    s = await state(uid.ring);
    assert(s.rarity === 2 && s.n === 4 && s.cur.exalt === 0 && s.name === rareName, '升华石：' + JSON.stringify(s));
    const before = s.ids;
    await use('chaos');
    s = await state(uid.ring);
    assert(s.rarity === 2 && s.n === 4 && s.cur.chaos === 0 && s.ids !== before, '乱流石：' + JSON.stringify(s) + ' 之前 ' + before);
    const ids = s.ids, tiers = s.tiers;
    await use('divine');
    s = await state(uid.ring);
    assert(s.ids === ids && s.tiers === tiers && s.cur.divine === 0, '重铸石：' + JSON.stringify(s));
    assert(new Set(s.ids.split(',')).size === 4, '出现了重复词缀：' + s.ids);
    // 琢刻石：按钮先弹出词缀列表，点一条才真正使用
    await use('chisel');
    const pickIdx = await ev(() => { const b = document.querySelector('#confirm.on .cz-aff[data-act="chisel-pick"]'); return b ? +b.dataset.idx : -1; });
    assert(pickIdx >= 0, '琢刻石按钮应弹出词缀选择框');
    await page.click('#confirm .cz-aff[data-idx="' + pickIdx + '"]');
    s = await state(uid.ring);
    const a0 = ids.split(','), a1 = s.ids.split(',');
    assert(s.cur.chisel === 0 && a1.length === 4 && a1.filter((x, i) => x !== a0[i]).length === 1 && a1[pickIdx] !== a0[pickIdx] && new Set(a1).size === 4, '琢刻石：' + JSON.stringify(s) + ' 之前 ' + ids);

    await page.click('.cell[data-item="' + uid.helm + '"]');
    await use('alch');
    s = await state(uid.helm);
    assert(s.rarity === 2 && s.n === 4 && s.cur.alch === 0, '点金石：' + JSON.stringify(s));
    assert(Object.values(s.btn).every((v) => !v), '通货用完后所有按钮都应禁用');
    const refuse = await ev((u) => {
      G.save.cur.dust = 1;
      const it = G.save.bag.find((x) => x.uid === u);
      const r = G.applyCurrency(it, 'dust');
      const n = G.save.cur.dust;
      G.save.cur.dust = 0;
      return { r, n };
    }, uid.helm);
    assert(refuse.r === false && refuse.n === 1, '不适用的通货不应被消耗');
    // 装备着的物品也能改造，属性立即生效
    const eq = await ev(() => {
      G.save.cur.dust = 1;
      const w = G.save.equip.weapon;
      const r = G.applyCurrency(w, 'dust');
      return { r, rarity: w.rarity, n: w.affixes.length };
    });
    assert(eq.r && eq.rarity === 1 && eq.n === 1, '改造已装备的武器失败');
    cleanText(await ev(() => T.bodyText()), '改造后的背包页');
    await closePanel();
  });

  await step('琢刻石：只重洗选中的那一条（同为前缀 / 后缀、不重复、阶数不超过物品等级），其他词缀原样不动；普通物品、没选词缀时不能用且不消耗', async () => {
    const r = await ev(() => {
      const save = G.save;
      const out = { bad: [], trials: 0, types: { prefix: 0, suffix: 0 } };
      const snap = (it) => it.affixes.map((a) => a.id + ':' + a.tier + ':' + a.v);
      const maxTier = (ilvl) => { let t = 0; G.TIER_ILVL.forEach((v, i) => { if (v <= ilvl) t = i; }); return t; };
      save.cur.chisel = 0;
      for (let k = 0; k < 160; k++) {
        const slot = G.SLOTS[k % G.SLOTS.length];
        const ilvl = 1 + (k * 7) % 22;
        const it = G.rollItem(ilvl, k % 5 === 0 ? 1 : 2, slot);
        if (it.rarity === 2) while (it.affixes.length < 6 && G.addAffix(it)) { /* 尽量填满，池子最紧的时候也要守规矩 */ }
        const can = G.chiselable(it);
        const idx = can.indexOf(true, k % Math.max(1, it.affixes.length)) >= 0 ? can.indexOf(true, k % Math.max(1, it.affixes.length)) : can.indexOf(true);
        if (idx < 0) continue;
        const b = snap(it), name = it.name;
        const t0 = G.AFFIX_BY_ID[it.affixes[idx].id].type;
        save.cur.chisel = 1;
        const ok = G.applyCurrency(it, 'chisel', idx);
        const a = snap(it);
        const nw = it.affixes[idx], def = G.AFFIX_BY_ID[nw.id];
        out.trials++;
        out.types[t0]++;
        const why = [];
        if (!ok || save.cur.chisel !== 0) why.push('没有生效或没扣通货');
        if (a.length !== b.length) why.push('词缀条数变了');
        a.forEach((x, i) => { if (i !== idx && x !== b[i]) why.push('第 ' + i + ' 条被动了'); });
        if (b[idx].split(':')[0] === nw.id) why.push('洗回了同一条');
        if (def.type !== t0) why.push('类别变了 ' + t0 + ' → ' + def.type);
        if (new Set(it.affixes.map((x) => x.id)).size !== it.affixes.length) why.push('出现重复词缀');
        if (def.slots.indexOf(it.slot) < 0) why.push('不适用这个部位');
        if (nw.tier > maxTier(it.ilvl) || (def.minIlvl && it.ilvl < def.minIlvl) || (def.rareOnly && it.rarity < 2)) why.push('阶数 / 物品等级限制不对');
        if (it.rarity === 2 && it.name !== name) why.push('稀有物品的名字不该变');
        if (why.length) out.bad.push(slot + ' ' + idx + ' ' + why.join('、') + ' ' + b.join('|') + ' → ' + a.join('|'));
      }
      // 普通物品：不能用，不消耗；没选词缀 / 选了不存在的下标：不消耗
      const white = G.rollItem(5, 0, 'ring');
      save.cur.chisel = 1;
      out.white = { can: G.canCraft(white, 'chisel'), use: G.applyCurrency(white, 'chisel', 0), n: save.cur.chisel, msg: G.craft(white, 'chisel', 0).msg };
      const rare = G.rollItem(10, 2, 'ring');
      const before = snap(rare).join('|');
      out.noIdx = { use: G.applyCurrency(rare, 'chisel'), use2: G.applyCurrency(rare, 'chisel', 99), n: save.cur.chisel, same: snap(rare).join('|') === before };
      save.cur.chisel = 0;
      out.none = { use: G.applyCurrency(rare, 'chisel', 0), same: snap(rare).join('|') === before };
      // 魔法物品：前缀洗出来还是前缀，名字跟着词缀变
      const magic = G.rollItem(8, 1, 'helm');
      while (magic.affixes.length < 2 && G.addAffix(magic)) { /* 补满两条 */ }
      save.cur.chisel = 1;
      const mi = G.chiselable(magic).indexOf(true);
      const mb = snap(magic);
      out.magic = { ok: G.applyCurrency(magic, 'chisel', mi), n: magic.affixes.length, kept: snap(magic).filter((x, i) => i !== mi && x === mb[i]).length, nameOk: magic.name !== magic.baseName };
      save.cur.chisel = 0;
      return out;
    });
    assert(r.bad.length === 0, '琢刻石重洗出错：' + r.bad.slice(0, 4).join(' ｜ '));
    assert(r.trials >= 140 && r.types.prefix > 20 && r.types.suffix > 20, '琢刻石试得太少：' + JSON.stringify({ trials: r.trials, types: r.types }));
    assert(!r.white.can && r.white.use === false && r.white.n === 1 && r.white.msg.includes('魔法或稀有'), '普通物品不能用琢刻石，也不消耗：' + JSON.stringify(r.white));
    assert(r.noIdx.use === false && r.noIdx.use2 === false && r.noIdx.n === 1 && r.noIdx.same, '没选词缀时不应使用：' + JSON.stringify(r.noIdx));
    assert(r.none.use === false && r.none.same, '没有琢刻石时不能用：' + JSON.stringify(r.none));
    assert(r.magic.ok && r.magic.n === 2 && r.magic.kept === 1 && r.magic.nameOk, '魔法物品用琢刻石不对：' + JSON.stringify(r.magic));
    return r.trials + ' 次（前缀 ' + r.types.prefix + ' / 后缀 ' + r.types.suffix + '）';
  });

  await uiStep('琢刻石：拖到物品上 / 点改造按钮先弹出词缀列表（每条「重洗这一条」、取消、Esc），取消或 Esc 不消耗，点一条只换那一条', async () => {
    const uid = await ev(() => {
      G.save.bag.length = 0;
      G.save.cur.chisel = 2;
      const it = G.debug.giveItem(2, 'ring', undefined, 12);
      while (it.affixes.length < 6 && G.addAffix(it)) { /* 填满 */ }
      G.debug.giveItem(0, 'boots');
      return it.uid;
    });
    const cell = '.cell[data-item="' + uid + '"]';
    const st = () => ev((u) => {
      const it = G.save.bag.find((x) => x.uid === u);
      const box = document.getElementById('confirm');
      return {
        aff: it.affixes.map((a) => a.id + ':' + a.tier + ':' + a.v), n: G.save.cur.chisel, tab: T.tab(),
        on: box.classList.contains('on') && box.classList.contains('chisel'),
        picks: box.querySelectorAll('.cz-aff[data-act="chisel-pick"]').length,
        labels: Array.from(box.querySelectorAll('.cz-aff[data-act="chisel-pick"] b')).map((b) => b.textContent),
        cancel: !!box.querySelector('[data-act="drop-no"]'), text: box.innerText, rect: T.rect('#confirm'), w: innerWidth, h: innerHeight,
        msg: (document.querySelector('.inv-msg.ok') || {}).textContent || '',
      };
    }, uid);
    await page.keyboard.press('KeyI');
    // 拖到普通物品上：不适用（变暗）且没有选择框
    let mid = null;
    const white = await ev(() => G.save.bag.find((x) => x.rarity === 0).uid);
    await dragTo('.cur[data-cur="chisel"]', '.cell[data-item="' + white + '"]', async () => {
      mid = await ev((u) => ({ no: document.querySelector('.cell[data-item="' + u + '"]').classList.contains('drop-no'), cap: document.querySelector('#drag-ghost em').textContent }), white);
    });
    let s = await st();
    assert(mid.no && !s.on && s.n === 2, '琢刻石拖到普通物品上应拒绝：' + JSON.stringify(mid));
    // 拖到稀有物品上：弹出选择框，每条词缀一个「重洗这一条」
    const a0 = (await st()).aff;
    await dragTo('.cur[data-cur="chisel"]', cell, async () => {
      mid = await ev(() => document.querySelector('#drag-ghost em').textContent);
    });
    s = await st();
    assert(mid.includes('琢刻石') && s.on && s.picks === a0.length && s.labels.every((t) => t === '重洗这一条') && s.cancel && s.text.includes('Esc'), '拖放后应弹出词缀选择框：' + JSON.stringify(s));
    assert(s.rect.l >= 0 && s.rect.r <= s.w && s.rect.t >= 0 && s.rect.b <= s.h, '选择框跑出了窗口：' + JSON.stringify(s.rect));
    assert(s.n === 2 && s.aff.join() === a0.join(), '弹出选择框时还不该消耗：' + JSON.stringify(s));
    // Esc：只关选择框，背包还开着，什么都没变
    await page.keyboard.press('Escape');
    s = await st();
    assert(!s.on && s.tab === 'inv' && s.n === 2 && s.aff.join() === a0.join(), 'Esc 应只取消选择框且不消耗：' + JSON.stringify(s));
    // 改造按钮 → 选择框 → 取消
    await page.click(cell);
    await page.click('.craft-btn[data-cur="chisel"]');
    s = await st();
    assert(s.on && s.picks === a0.length, '点改造按钮应弹出选择框');
    await page.click('#confirm [data-act="drop-no"]');
    s = await st();
    assert(!s.on && s.tab === 'inv' && s.n === 2 && s.aff.join() === a0.join(), '取消后不应消耗：' + JSON.stringify(s));
    // 再开一次，点第一条后缀：只换这一条，类别不变
    await page.click('.craft-btn[data-cur="chisel"]');
    const idx = await ev(() => { const b = Array.from(document.querySelectorAll('#confirm .cz-aff.suffix[data-act="chisel-pick"]')); return b.length ? +b[0].dataset.idx : -1; });
    assert(idx >= 0, '选择框里应能选后缀');
    await page.click('#confirm .cz-aff[data-idx="' + idx + '"]');
    s = await st();
    const t = await ev((o) => G.AFFIX_BY_ID[o.id].type, { id: s.aff[idx].split(':')[0] });
    assert(!s.on && s.n === 1 && s.aff.filter((x, i) => x !== a0[i]).length === 1 && s.aff[idx] !== a0[idx] && t === 'suffix', '点选后应只重洗那一条：' + JSON.stringify({ a0, a: s.aff, idx, t }));
    assert(s.msg.includes('琢刻石') && s.msg.includes('→'), '应提示换掉了哪一条：' + s.msg);
    cleanText(await ev(() => T.bodyText()), '用过琢刻石的背包页');
    await closePanel();
    return '第 ' + (idx + 1) + ' 条：' + s.msg;
  });

  // ------------------------------------------------------------------ v2 界面：图标 / 拖拽 / 换装评估 / 背包整理
  await uiStep('图标：装备各基底各档、通货、技能、辅助宝石都有各不相同的图标，并用在背包 / 装备栏 / 通货 / 改造按钮上', async () => {
    const r = await ev(() => {
      const keys = G.icons.keys();
      const urls = keys.map((k) => G.icons.url(k));
      G.save.bag.length = 0;
      for (const slot of G.SLOTS) G.debug.giveItem(1, slot);
      G.ui.open('inv');
      const bg = (n) => getComputedStyle(n).backgroundImage;
      document.querySelector('.cell[data-item]').click(); // 选中一件，右侧出现详情与改造按钮（会重渲染）
      const cells = Array.from(document.querySelectorAll('.cell[data-item] > .ico'));
      const sizes = cells.map((n) => n.getBoundingClientRect().width);
      return {
        n: keys.length, bad: keys.filter((k, i) => !/^data:image\/png;base64,/.test(urls[i]) || urls[i].length < 1500), uniq: new Set(urls).size,
        kinds: ['it-', 'cur-', 'sk-', 'sup-', 'ail-', 'blank'].map((p) => keys.filter((k) => k.startsWith(p)).length).join(),
        // 应有的数量：每个装备基底的每一档名字、每个技能（含武器技、烬铸技、远程普攻与量表技）
        want: [G.SLOTS.reduce((n, sl) => n + G.BASES[sl].reduce((m, b) => m + b.names.length, 0), 0), G.CUR_IDS.length, Object.keys(G.SKILLS).length, Object.keys(G.SUPPORTS).length, 5, 1].join(),
        cellIcons: cells.length, cellOk: cells.every((n) => bg(n).startsWith('url("data:image/png')), minSize: Math.min.apply(null, sizes), maxSize: Math.max.apply(null, sizes),
        distinct: new Set(cells.map(bg)).size,
        eq: Array.from(document.querySelectorAll('.eq > .ico')).filter((n) => bg(n).startsWith('url("data:image/png')).length,
        cur: Array.from(document.querySelectorAll('.cur > .ico')).filter((n) => bg(n).startsWith('url("data:image/png')).length,
        craft: Array.from(document.querySelectorAll('.craft-btn > .ico')).filter((n) => bg(n).startsWith('url("data:image/png')).length,
        head: !!document.querySelector('.detail-card .ic-head .ibox > .ico'),
        glyphLeft: document.querySelectorAll('.c-glyph, .s-glyph').length,
      };
    });
    assert(r.bad.length === 0 && r.uniq === r.n, '有图标没画出来或重复：' + JSON.stringify(r.bad) + ' ' + r.uniq + '/' + r.n);
    // 远程改版后：装备 64（武器 14 种 × 3 档 + 其余 22）/ 通货 8 / 技能 35（11 个技能 + 7 个武器技 + 3 个烬铸技 + 7 个远程普攻 + 7 个量表技）/ 辅助 19 / 异常 5 / 无铭宝石 1
    assert(r.kinds === r.want, '图标数量不对（应为 ' + r.want + '）：' + r.kinds);
    assert(r.cellIcons === 8 && r.cellOk && r.distinct === 8, '背包格图标不对：' + JSON.stringify(r));
    assert(r.minSize >= 44 && r.maxSize <= 64, '背包格图标应在 44–64 像素之间：' + r.minSize + '–' + r.maxSize);
    assert(r.eq === 8 && r.cur === 8 && r.craft === 8 && r.head && r.glyphLeft === 0, '装备栏 / 通货 / 改造按钮 / 详情没有全部换成图标：' + JSON.stringify(r));
    await closePanel();
    return r.n + ' 个图标';
  });

  await uiStep('拖拽：背包 → 装备栏（高亮可放的格子）/ 互换 / 放错格子 / 装备栏 → 背包 / 背包内换位并存档 / Esc 取消', async () => {
    const ids = await ev(() => {
      G.save.bag.length = 0;
      for (const s of G.SLOTS) if (s !== 'weapon') delete G.save.equip[s];
      G.computeStats();
      const o = {
        helmA: G.debug.giveItem(2, 'helm').uid, helmB: G.debug.giveItem(1, 'helm').uid, boots: G.debug.giveItem(0, 'boots').uid,
        ring: G.debug.giveItem(0, 'ring').uid, body: G.debug.giveItem(2, 'body').uid, belt: G.debug.giveItem(0, 'belt').uid,
      };
      return o;
    });
    const cell = (u) => '.cell[data-item="' + u + '"]';
    const st = () => ev(() => ({ bag: G.save.bag.map((i) => i.uid), helm: (G.save.equip.helm || {}).uid, open: T.tab(), msg: (document.querySelector('.inv-msg') || {}).textContent || '' }));
    await page.keyboard.press('KeyI');
    let mid = null;
    await dragTo(cell(ids.helmA), '.eq[data-slot="helm"]', async () => {
      mid = await ev(() => ({
        ok: !!document.querySelector('.eq[data-slot="helm"].drop-ok.drop-hover'), dim: document.querySelectorAll('.eq.drop-no').length,
        ghost: document.getElementById('drag-ghost').classList.contains('on') && !!document.querySelector('#drag-ghost .ico'), cap: document.querySelector('#drag-ghost em').textContent,
        src: !!document.querySelector('.cell.drag-src'), tip: document.getElementById('tip').classList.contains('on'),
      }));
    });
    assert(mid.ok && mid.dim === 7 && mid.ghost && mid.cap === '装备' && mid.src && !mid.tip, '拖动中的反馈不对：' + JSON.stringify(mid));
    let s = await st();
    assert(s.helm === ids.helmA && !s.bag.includes(ids.helmA), '拖到装备栏没有装备上');
    assert(await ev(() => !document.querySelector('.drop-ok, .drop-no, .drop-hover, .drag-src') && !document.getElementById('drag-ghost').classList.contains('on')), '松手后拖拽状态没有清干净');
    await dragTo(cell(ids.helmB), '.eq[data-slot="helm"]');
    s = await st();
    assert(s.helm === ids.helmB && s.bag.includes(ids.helmA), '拖到已有装备的格子应互换');
    const before = JSON.stringify({ bag: s.bag, helm: s.helm });
    await dragTo(cell(ids.boots), '.eq[data-slot="weapon"]', async () => {
      mid = await ev(() => ({ bad: !!document.querySelector('.eq[data-slot="weapon"].drop-bad'), cap: document.querySelector('#drag-ghost em').textContent }));
    });
    s = await st();
    assert(mid.bad && mid.cap.includes('只能放武器') && JSON.stringify({ bag: s.bag, helm: s.helm }) === before && s.msg.includes('只能放'), '放错格子应拒绝并说明：' + JSON.stringify(mid) + ' ' + s.msg);
    await dragTo('.eq[data-slot="helm"]', '.cell.empty[data-idx="22"]');
    s = await st();
    assert(!s.helm && s.bag.includes(ids.helmB), '装备栏拖到背包应卸下');
    await ev((u) => { G.equip(G.save.bag.find((i) => i.uid === u)); G.ui.refresh(); }, ids.helmB);
    await dragTo('.eq[data-slot="helm"]', cell(ids.helmA));
    s = await st();
    assert(s.helm === ids.helmA && s.bag.includes(ids.helmB), '装备栏拖到同部位的背包物品上应互换');
    let b0 = s.bag;
    await dragTo(cell(b0[0]), cell(b0[3]));
    s = await st();
    assert(s.bag[0] === b0[3] && s.bag[3] === b0[0] && s.bag.length === b0.length, '背包内拖到另一格应互换位置');
    b0 = s.bag;
    let cap = null;
    await dragTo(cell(b0[1]), '.cell.empty[data-idx="35"]', async () => {
      cap = await ev(() => ({ txt: document.querySelector('#drag-ghost em').textContent, hover: +(document.querySelector('.cell.drop-hover') || { dataset: {} }).dataset.idx, n: G.save.bag.length }));
    });
    s = await st();
    assert(s.bag[s.bag.length - 1] === b0[1], '拖到空格应挪到末尾');
    // 背包是紧凑排列的：提示要照实说「移到末尾」，亮起来的是队尾的第一个空格，而不是鼠标下那一格
    assert(cap.txt === '移到末尾' && cap.hover === cap.n, '拖到空格时的提示 / 高亮落点不对：' + JSON.stringify(cap));
    const stored = await ev(() => JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).bag.map((i) => i.uid).join());
    assert(stored === s.bag.join(), '背包顺序没有写进存档');
    // 拖到一半按 Esc：取消拖拽，面板不关，什么都没变
    b0 = s.bag;
    await dragTo(cell(b0[0]), cell(b0[2]), async () => {
      await page.keyboard.press('Escape');
      mid = await ev(() => ({ tab: T.tab(), ghost: document.getElementById('drag-ghost').classList.contains('on') }));
    });
    s = await st();
    assert(mid.tab === 'inv' && !mid.ghost && s.bag.join() === b0.join() && s.open === 'inv', 'Esc 应只取消拖拽：' + JSON.stringify(mid));
    // 单击 / 右键 / Shift+点击 仍然可用
    await page.click(cell(ids.helmB));
    assert(await ev((u) => !!document.querySelector('.cell.sel[data-item="' + u + '"]'), ids.helmB), '拖拽之后单击选中失效');
    await page.click(cell(ids.helmB), { button: 'right' });
    assert((await st()).helm === ids.helmB, '右键背包物品应装备');
    await page.click('.eq[data-slot="helm"]', { button: 'right' });
    s = await st();
    assert(!s.helm && s.bag.includes(ids.helmB), '右键装备栏应卸下');
    await page.keyboard.down('Shift');
    try {
      await page.click(cell(ids.helmB));
      assert(!(await st()).bag.includes(ids.helmB), 'Shift+点击应分解魔法物品');
      await page.click(cell(ids.body));
      s = await st();
      assert(s.bag.includes(ids.body) && s.msg.includes('再 Shift'), 'Shift+点击稀有物品应先要求确认：' + s.msg);
      await page.click(cell(ids.body));
      assert(!(await st()).bag.includes(ids.body), '第二次 Shift+点击应分解稀有物品');
    } finally {
      await page.keyboard.up('Shift');
    }
    await closePanel();
  });

  await uiStep('拖拽：通货拖到物品上改造（不适用的变暗且不消耗），物品拖出窗口丢到脚边（稀有需确认），丢下的不会被立刻吸回', async () => {
    const ids = await ev(() => {
      G.save.bag.length = 0;
      for (const id of G.CUR_IDS) G.save.cur[id] = 2;
      T.clearLoot();
      return { boots: G.debug.giveItem(0, 'boots').uid, body: G.debug.giveItem(2, 'body').uid, belt: G.debug.giveItem(0, 'belt').uid, ring: G.debug.giveItem(0, 'ring').uid };
    });
    const cell = (u) => '.cell[data-item="' + u + '"]';
    await page.keyboard.press('KeyI');
    let mid = null;
    await dragTo('.cur[data-cur="dust"]', cell(ids.boots), async () => {
      mid = await ev((ids) => ({
        lit: document.querySelectorAll('.cell.drop-ok').length, rareDim: document.querySelector('.cell[data-item="' + ids.body + '"]').classList.contains('drop-no'),
        cap: document.querySelector('#drag-ghost em').textContent,
      }), ids);
    });
    assert(mid.lit === 3 && mid.rareDim && mid.cap.includes('使用微光尘'), '拖通货时可用 / 不可用的物品没有区分：' + JSON.stringify(mid));
    let r = await ev((u) => { const i = G.save.bag.find((x) => x.uid === u); return { rarity: i.rarity, n: i.affixes.length, dust: G.save.cur.dust, sel: !!document.querySelector('.cell.sel[data-item="' + u + '"]') }; }, ids.boots);
    assert(r.rarity === 1 && r.n === 1 && r.dust === 1 && r.sel, '通货拖到物品上没有生效：' + JSON.stringify(r));
    await dragTo('.cur[data-cur="dust"]', cell(ids.body));
    r = await ev(() => ({ dust: G.save.cur.dust, msg: (document.querySelector('.inv-msg') || {}).textContent || '' }));
    assert(r.dust === 1 && r.msg.includes('只能用于普通物品'), '不适用的通货不应消耗，并说明原因：' + JSON.stringify(r));
    await page.click(cell(ids.ring));
    await dragTo('.cur[data-cur="alch"]', '.detail-card');
    r = await ev((u) => ({ rarity: G.save.bag.find((x) => x.uid === u).rarity, alch: G.save.cur.alch }), ids.ring);
    assert(r.rarity === 2 && r.alch === 1, '通货拖到详情卡上没有生效：' + JSON.stringify(r));
    await dragTo('.cur[data-cur="divine"]', '.eq[data-slot="weapon"]');
    r = await ev(() => ({ divine: G.save.cur.divine, w: G.save.equip.weapon.rarity }));
    assert(r.divine === (r.w >= 1 ? 1 : 2), '通货拖到装备栏的结果不对：' + JSON.stringify(r));

    // 拖出窗口：普通物品直接丢，稀有物品先确认
    const vp = page.viewportSize();
    await dragTo(cell(ids.belt), { x: 10, y: vp.height / 2 }, async () => {
      mid = await ev(() => document.querySelector('#drag-ghost em').textContent);
    });
    r = await ev((u) => {
      const l = G.state.loot.find((x) => x.kind === 'item' && x.data.uid === u);
      return { cap: null, inBag: G.save.bag.some((i) => i.uid === u), d: l ? Math.hypot(l.x - G.player.x, l.z - G.player.z) : -1, tab: T.tab(), toast: T.toasts(), icon: !!document.querySelector('#toasts .toast .ico') };
    }, ids.belt);
    assert(mid === '丢到地上' && !r.inBag && r.d >= 0 && r.d < 3 && r.tab === 'inv', '拖出窗口应把物品丢在脚边：' + JSON.stringify(r));
    assert(r.toast.includes('丢下了') && r.icon, '丢弃提示应带图标');
    await dragTo(cell(ids.body), { x: vp.width - 8, y: vp.height / 2 });
    r = await ev((u) => ({ on: document.getElementById('confirm').classList.contains('on'), inBag: G.save.bag.some((i) => i.uid === u), box: T.rect('#confirm'), w: innerWidth, h: innerHeight }), ids.body);
    assert(r.on && r.inBag && r.box.l >= 0 && r.box.r <= r.w && r.box.t >= 0 && r.box.b <= r.h, '稀有物品应先弹出确认框：' + JSON.stringify(r));
    await page.keyboard.press('Escape');
    r = await ev(() => ({ on: document.getElementById('confirm').classList.contains('on'), tab: T.tab() }));
    assert(!r.on && r.tab === 'inv', 'Esc 应只关闭确认框');
    await dragTo(cell(ids.body), { x: vp.width - 8, y: vp.height / 2 });
    await page.click('[data-act="drop-no"]');
    assert(await ev((u) => G.save.bag.some((i) => i.uid === u), ids.body), '取消后稀有物品应留在背包');
    await dragTo(cell(ids.body), { x: vp.width - 8, y: vp.height / 2 });
    await page.click('[data-act="drop-yes"]');
    assert(await ev((u) => !G.save.bag.some((i) => i.uid === u) && G.state.loot.some((x) => x.kind === 'item' && x.data.uid === u), ids.body), '确认后稀有物品应到地上');
    await closePanel();
    r = await ev((u) => {
      const P = G.player;
      G.debug.step(1);
      const l = G.state.loot.find((x) => x.kind === 'item' && x.data.uid === u);
      const stay = !!l;
      const x = P.x, z = P.z;
      T.tp(l.x + 5, l.z);
      G.debug.step(0.2);
      T.tp(l.x, l.z);
      G.debug.step(0.2);
      const back = G.save.bag.some((i) => i.uid === u);
      T.tp(x, z);
      T.clearLoot();
      G.save.bag.length = 0;
      T.settle();
      return { stay, back };
    }, ids.body);
    assert(r.stay, '刚丢下的稀有物品站着不动就被吸回去了');
    assert(r.back, '走开再回来应能重新自动拾取');
  });

  await uiStep('换装评估：提示里的增减与真实换装后的变化一致；评估不改动角色、存档与 localStorage；背包角标与评估一致', async () => {
    const r = await ev(() => {
      const P = G.player, save = G.save;
      const canon = (o) => JSON.stringify(o, (k, v) => (k === 'ent' ? undefined : v));
      const dps = () => {
        const o = {};
        for (const i of [0, 2, 3]) { const id = save.bar[i]; if (id) o[id] = G.skillDps(G.skillCtx(id)); }
        return o;
      };
      const wsd = () => { const id = G.weaponSkill(); return id ? { id, dps: G.skillDps(G.skillCtx(id)) } : null; }; // R 键的武器技
      const rmbd = () => { const id = G.slotSkill(1); return id ? { id, dps: G.skillDps(G.skillCtx(id)) } : null; }; // 右键（拿着远程武器时是武器普攻）
      const snap = () => ({ dps: dps(), rmb: rmbd(), ws: wsd(), life: P.maxLife, armour: P.armour, res: P.res.fire + P.res.cold + P.res.light, mana: P.maxMana });
      const keep = { equip: Object.assign({}, save.equip), life: P.life, mana: P.mana };
      for (const slot of G.SLOTS) G.equip(G.debug.giveItem(1, slot));
      save.bag.length = 0;
      P.life = P.maxLife * 0.6;
      P.mana = P.maxMana * 0.4;
      G.persist();
      const out = { n: 0, mutated: 0, wrong: [], badges: '', badgeBad: 0 };
      for (let n = 0; n < 32; n++) {
        const slot = G.SLOTS[n % 8];
        const it = G.debug.giveItem(n % 3, slot);
        if (n % 5 === 0) { delete save.equip[slot]; G.computeStats(); }
        const p0 = canon(P), s0 = canon(save), l0 = localStorage.getItem('cinder-abyss-save-v1');
        const v = G.ui.verdict(it);
        if (canon(P) !== p0 || canon(save) !== s0 || localStorage.getItem('cinder-abyss-save-v1') !== l0) out.mutated++;
        const a = snap();
        G.equip(it);
        const b = snap();
        const want = {};
        const put = (k, d) => { if (Math.abs(d) >= 0.05) want[k] = Math.round(d * 10) / 10; };
        // 右键：两边是同一个技能时和技能栏一起比，不是同一个时单列「右键秒伤」
        if (a.rmb && b.rmb && a.rmb.id === b.rmb.id) {
          if (!(a.rmb.id in a.dps)) { a.dps[a.rmb.id] = a.rmb.dps; b.dps[b.rmb.id] = b.rmb.dps; }
        } else if (a.rmb || b.rmb) {
          const ra = a.rmb ? a.rmb.dps : 0, rb = b.rmb ? b.rmb.dps : 0;
          if (!(ra > 0) || Math.abs(rb / ra - 1) >= 0.005) put('右键秒伤', rb - ra);
        }
        // 秒伤变化不到 0.5% 的不单列一行（噪音）
        for (const id in a.dps) if (!(a.dps[id] > 0) || Math.abs(b.dps[id] / a.dps[id] - 1) >= 0.005) put(G.SKILLS[id].name + ' 秒伤', b.dps[id] - a.dps[id]);
        if (a.ws && b.ws && a.ws.id === b.ws.id && (!(a.ws.dps > 0) || Math.abs(b.ws.dps / a.ws.dps - 1) >= 0.005)) put('武器技 ' + G.SKILLS[a.ws.id].name + ' 秒伤', b.ws.dps - a.ws.dps);
        put('最大生命', b.life - a.life);
        put('护甲', b.armour - a.armour);
        put('元素抗性合计', b.res - a.res);
        put('最大魔力', b.mana - a.mana);
        const got = {};
        for (const l of v.lines) if (/秒伤$|^最大生命$|^护甲$|^元素抗性合计$|^最大魔力$/.test(l.label)) got[l.label] = parseFloat(l.text);
        const ser = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
        if (ser(want) !== ser(got)) out.wrong.push({ want, got });
        if ((v.badge === 'up') !== (v.score > 0.5) || (v.badge === 'down') !== (v.score < -0.5)) out.badgeBad++;
        if (v.lines.some((l) => !l.neutral && l.good !== parseFloat(l.text) > 0)) out.badgeBad++;
        if (v.lines.some((l) => /秒伤$/.test(l.label) && l.pct !== null && Math.abs(l.pct) < 0.5)) out.noise = (out.noise || 0) + 1;
        out.badges += v.badge[0];
        out.n++;
        save.bag.length = 0;
      }
      // 身上的装备不给评估；背包格的角标与评估一致
      out.equipped = G.ui.verdict(save.equip.helm);
      const items = [G.debug.giveItem(2, 'helm'), G.debug.giveItem(0, 'ring'), G.debug.giveItem(1, 'body')];
      G.ui.open('inv');
      const glyph = { up: '▲', down: '▼', eq: '＝' };
      out.cells = items.map((it) => {
        const c = document.querySelector('.cell[data-item="' + it.uid + '"] .c-vd');
        return { dom: c ? c.textContent : null, cls: c ? c.className : '', want: glyph[G.ui.verdict(it).badge] };
      });
      G.ui.close();
      // 还原
      save.bag.length = 0;
      for (const s of G.SLOTS) delete save.equip[s];
      Object.assign(save.equip, keep.equip);
      G.computeStats();
      P.life = P.maxLife;
      P.mana = P.maxMana;
      return out;
    });
    assert(r.mutated === 0, '评估改动了角色或存档：' + r.mutated + ' 次');
    assert(r.wrong.length === 0, '评估的增减与真实换装不一致：' + JSON.stringify(r.wrong.slice(0, 2)));
    assert(r.badgeBad === 0 && /u/.test(r.badges) && /d/.test(r.badges), '升降标记不对：' + r.badges);
    assert(r.equipped === null, '身上的装备不应给出评估');
    assert(!r.noise, '评估里不应列出变化不到 0.5% 的秒伤（会显示成「+0.1 +0%」）：' + r.noise + ' 次');
    assert(r.cells.every((c) => c.dom === c.want && c.cls.includes('vd-')), '背包角标与评估不一致：' + JSON.stringify(r.cells));
    return r.n + ' 件，' + r.badges;
  });

  await uiStep('背包整理：排序（部位 → 稀有度 → 等级）、一键分解（可含魔法，给出小结）、词缀阶级提示、筛选选项持久化、拾取时自动分解', async () => {
    await ev(() => {
      G.save.bag.length = 0;
      for (let i = 0; i < 14; i++) G.debug.giveItem(i % 3, G.SLOTS[(i * 3) % 8]);
      G.save.cur.dust = 0;
    });
    await page.keyboard.press('KeyI');
    await page.click('[data-act="sort"]');
    let r = await ev(() => {
      const ord = {};
      G.SLOTS.forEach((s, i) => (ord[s] = i));
      const b = G.save.bag;
      let sorted = true;
      for (let i = 1; i < b.length; i++) if ((ord[b[i - 1].slot] - ord[b[i].slot] || b[i].rarity - b[i - 1].rarity || b[i].ilvl - b[i - 1].ilvl) > 0) sorted = false;
      const uids = b.map((i) => i.uid).join();
      return {
        sorted, dom: Array.from(document.querySelectorAll('.cell[data-item]')).map((n) => n.dataset.item).join() === uids,
        stored: JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).bag.map((i) => i.uid).join() === uids,
        n0: b.filter((i) => i.rarity === 0).length, n1: b.filter((i) => i.rarity === 1).length, btn: document.querySelector('[data-act="salvage-all"]').textContent,
      };
    });
    assert(r.sorted && r.dom && r.stored, '排序不对或没有存档：' + JSON.stringify(r));
    assert(r.btn.includes('（' + r.n0 + '）'), '一键分解默认只算普通物品：' + r.btn);
    await page.click('[data-act="opt"][data-opt="salvageMagic"]');
    let r2 = await ev(() => ({ btn: document.querySelector('[data-act="salvage-all"]').textContent, opt: G.save.opts.salvageMagic }));
    assert(r2.opt && r2.btn.includes('（' + (r.n0 + r.n1) + '）'), '勾选「含魔法」后数量应包含魔法物品：' + r2.btn);
    await page.click('[data-act="salvage-all"]');
    r2 = await ev(() => ({ left: G.save.bag.map((i) => i.rarity).join(''), msg: (document.querySelector('.inv-tips.res') || {}).innerText || '', dis: document.querySelector('[data-act="salvage-all"]').disabled, dust: G.save.cur.dust }));
    assert(/^2+$/.test(r2.left) && r2.dis, '一键分解后应只剩稀有物品：' + r2.left);
    assert(r2.msg.includes('分解了 ' + (r.n0 + r.n1) + ' 件') && (r2.dust ? r2.msg.includes('微光尘 ×' + r2.dust) : r2.msg.includes('没有分解出通货')), '分解小结不对：' + r2.msg);
    await page.click('.cell[data-item]');
    await page.hover('.detail-card .ic-line.aff');
    r2 = await ev(() => ({ on: document.getElementById('tip').classList.contains('on'), rows: document.querySelectorAll('#tip .tr-row').length, now: document.querySelectorAll('#tip .tr-row.now').length, txt: document.getElementById('tip').innerText }));
    assert(r2.on && r2.rows === 10 && r2.now === 1 && r2.txt.includes('本阶范围'), '悬停词缀应说明各阶范围：' + JSON.stringify(r2));
    cleanText(r2.txt, '词缀提示');
    // 地图页的筛选选项
    await page.keyboard.press('KeyM');
    await page.click('[data-act="normmode"][data-mode="scrap"]');
    await page.click('[data-act="opt"][data-opt="hideNormal"]');
    r2 = await ev(() => {
      const row = document.querySelector('.map-opts').getBoundingClientRect();
      const kids = Array.from(document.querySelector('.map-opts').children).map((n) => n.getBoundingClientRect());
      return { o: G.save.opts, stored: JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).opts, fits: kids.every((k) => k.left >= row.left - 1 && k.right <= row.right + 1), on: document.querySelector('.seg-b.on').dataset.mode };
    });
    assert(r2.o.autoWhite && r2.o.autoSalvage && r2.o.hideNormal && r2.o.salvageMagic && JSON.stringify(r2.o) === JSON.stringify(r2.stored) && r2.on === 'scrap', '筛选选项没有生效或没有存档：' + JSON.stringify(r2));
    assert(r2.fits, '选项一行放不下');
    await closePanel();
    r2 = await ev(() => {
      T.clearLoot();
      G.save.bag.length = 0;
      T.tp(0, 0);
      const put = (kind, data, x) => { const l = G.spawnLoot(kind, data, 0, 0); l.x = x; l.z = 0; l.mesh.position.set(x, 0, 0); return l; };
      put('item', G.rollItem(1, 0, 'boots'), 0.3);
      put('item', G.rollItem(1, 1, 'ring'), -0.3);
      put('cur', 'regal', 0.1);
      put('cur', 'regal', -0.1);
      G.debug.step(0.6);
      const out = { loot: G.state.loot.length, bag: G.save.bag.map((i) => i.rarity).join(), feed: document.getElementById('feed').innerText, icons: document.querySelectorAll('#feed .fd .ico').length };
      // 折叠普通名牌
      const l = put('item', G.rollItem(1, 0, 'body'), 3);
      l.noAuto = true;
      window.__pip = l;
      return out;
    });
    assert(r2.loot === 0 && r2.bag === '1', '自动分解：普通物品不应进背包，魔法物品照常拾取：' + JSON.stringify(r2));
    assert(r2.feed.includes('已丢弃') && r2.feed.includes('冠冕石') && r2.feed.includes('×2') && r2.icons >= 3, '拾取记录不对：' + JSON.stringify(r2));
    await page.mouse.move(1000, 620);
    await ev(() => G.debug.hold(false));
    await until(() => window.__pip.label === '·').catch(() => {
      throw new Error('开启折叠后普通物品的名牌应收成一个点');
    });
    await ev(() => {
      G.debug.hold(true);
      Object.assign(G.save.opts, { autoWhite: false, hideNormal: false, autoSalvage: false, salvageMagic: false });
      G.save.bag.length = 0;
      T.clearLoot();
      delete window.__pip;
      G.persist();
    });
  });

  await uiStep('武器界面：HUD 的 R 格跟着武器换、空手写「无武器」并在按 R 时说明；武器提示有伤害 / 攻速 / 秒伤与对比；技能页有武器技卡；帮助页有武器一节', async () => {
    const r = await ev(async () => {
      const wait = (n) => new Promise((res) => { let i = 0; const f = () => (++i > n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
      const keep = G.save.equip.weapon;
      const bag0 = G.save.bag.slice();
      const ws = () => document.getElementById('wslot');
      const out = { follow: [], bar: T.hudBar() };
      try {
        for (const b of [0, 3, 4]) {
          G.save.equip.weapon = G.rollItem(5, 0, 'weapon', b);
          G.computeStats();
          await wait(2);
          out.follow.push(ws().dataset.skill === G.BASES.weapon[b].wskill && !ws().classList.contains('empty') && getComputedStyle(ws().querySelector('.s-img')).backgroundImage.startsWith('url("data:image/png'));
        }
        // 冷却：R 格上出现读秒与转圈
        const id = G.weaponSkill();
        G.player.cds[id] = 2.5;
        G.player.cdMax[id] = 5;
        await wait(2);
        out.cd = { cls: ws().classList.contains('cooling'), num: ws().querySelector('.s-cdnum').textContent, sweep: +ws().querySelector('.s-cd').style.getPropertyValue('--cd') };
        G.player.cds = {};
        // 空手：格子空着、写「无武器」，按 R 时冒出说明
        delete G.save.equip.weapon;
        G.computeStats();
        await wait(2);
        out.none = { empty: ws().classList.contains('empty') && ws().classList.contains('nowpn'), txt: ws().querySelector('.s-none').offsetParent ? ws().querySelector('.s-none').textContent : '' };
        G.input.keys.KeyR = true;
        await wait(2);
        out.none.deny = ws().classList.contains('deny') && ws().querySelector('.s-bubble').textContent;
        G.input.keys.KeyR = false;
        // 布局：五格都在技能栏里，不压生命 / 魔力球
        const bar = T.rect('#bar'), w = T.rect('#wslot'), life = T.rect('.orb.life'), mana = T.rect('.orb.mana');
        out.layout = w.l >= bar.l && w.r <= bar.r && bar.l > life.r && bar.r < mana.l;
        // 武器提示：拿着刃时看一把双匕
        G.save.equip.weapon = G.rollItem(5, 0, 'weapon', 0);
        G.computeStats();
        G.save.bag.length = 0;
        const d = G.debug.giveItem(2, 'weapon', 3, 14);
        G.ui.open('inv');
        const cell = document.querySelector('[data-tip="item:' + d.uid + '"]');
        const cb = cell.getBoundingClientRect();
        cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cb.left + 4, clientY: cb.top + 4 }));
        const tip = document.getElementById('tip');
        const card = tip.querySelector('.icard');
        out.tip = {
          on: tip.classList.contains('on'), lines: card ? card.querySelectorAll('.ic-line.wd').length : 0, cmp: card ? card.querySelectorAll('.ic-line.wd em').length : 0,
          txt: card ? card.innerText : '', pair: tip.querySelectorAll('.icard').length, want: G.weaponStats(d),
          names: [G.SKILLS[G.BASES.weapon[3].wskill].name, G.SKILLS[G.BASES.weapon[0].wskill].name],
        };
        G.ui.close();
        G.ui.open('skills');
        const wc = document.querySelector('.wsk-card');
        out.skills = { card: !!wc, name: wc ? wc.innerText.includes(G.SKILLS[G.weaponSkill()].name) : false, row: wc ? wc.querySelectorAll('.wsl').length : 0, atk: document.querySelectorAll('.sk-anote.wpn').length };
        G.ui.close();
        G.ui.open('help');
        out.help = document.getElementById('panel-body').innerText.includes('武器与武器技');
        G.ui.close();
      } finally {
        G.save.equip.weapon = keep;
        G.save.bag = bag0;
        G.input.keys.KeyR = false;
        G.player.cds = {};
        G.computeStats();
      }
      return out;
    });
    assert(r.follow.length === 3 && r.follow.every(Boolean), 'R 格应跟着手里的武器换成它的武器技：' + JSON.stringify(r.follow));
    assert(r.bar.split(',').length === 4, '#slots 里应仍是存档技能栏的 4 格：' + r.bar);
    assert(r.cd.cls && r.cd.num === '3' && r.cd.sweep > 0.4 && r.cd.sweep < 0.6, 'R 格冷却显示不对：' + JSON.stringify(r.cd));
    assert(r.none.empty && r.none.txt === '无武器' && r.none.deny === '没有武器', '空手时 R 格应写「无武器」，按 R 时说明：' + JSON.stringify(r.none));
    assert(r.layout, '武器技格挤出了技能栏或压到了生命 / 魔力球');
    const w = r.tip.want;
    assert(r.tip.on && r.tip.lines === 3 && r.tip.cmp === 3 && r.tip.pair === 2, '武器提示应有伤害 / 攻速 / 秒伤三行并与身上那把对比：' + JSON.stringify(r.tip));
    assert(r.tip.txt.includes(w.min + '–' + w.max) && r.tip.txt.includes(w.aps.toFixed(2)) && r.tip.names.every((n) => r.tip.txt.includes(n)), '武器提示的数值 / 武器技不对：' + r.tip.txt);
    // 武器技一览：原来的八种 + 远程武器（界面可以把烬铸专用的两种并进烬铸那一栏，所以按下限比）
    assert(r.skills.card && r.skills.name && r.skills.row >= 8 && r.skills.atk >= 1, '技能页应有武器技卡（含所有武器类型）与攻击技能的武器伤害说明：' + JSON.stringify(r.skills));
    assert(r.help, '帮助页缺少武器一节');
    return '八种武器技在 R 格上切换，提示与技能页正常';
  });

  await step('技能页：界面绑定按键；镶嵌 / 取下辅助宝石会改变 G.skillCtx', async () => {
    await ev(() => {
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.computeStats();
    });
    await page.keyboard.press('KeyG');
    cleanText(await ev(() => T.bodyText()), '技能页');
    // 武器普攻卡（.basic-card，拿着远程武器时才生效）另算
    const cards = await ev(() => ({ n: document.querySelectorAll('.skill-card:not(.wsk-card):not(.basic-card)').length, ws: document.querySelectorAll('.wsk-card').length }));
    assert(cards.n === 12 && cards.ws === 1, '技能卡数量不对（12 张技能卡 + 1 张武器技卡）：' + JSON.stringify(cards));
    await page.click('[data-act="bind"][data-skill="nova"][data-slot="2"]');
    let r = await ev(() => ({ bar: G.save.bar.slice(), on: document.querySelector('[data-act="bind"][data-skill="nova"][data-slot="2"]').classList.contains('on') }));
    assert(r.bar[2] === 'nova' && r.on && r.bar.filter((b) => b === 'nova').length === 1, '界面绑定失败：' + r.bar);
    await until(() => document.querySelectorAll('#slots .slot')[2].dataset.skill === 'nova').catch(() => {
      throw new Error('HUD 技能栏没有同步');
    });
    // 霜环是光环：一绑上就保留魔力，魔力球顶上出现保留的那一截，技能格带「光环」的样式
    r = await ev(() => ({ res: G.player.reserved, pct: G.player.reservePct, max: G.player.maxMana, raw: G.player.maxManaRaw, band: document.getElementById('mana-res').classList.contains('on'), aura: document.querySelectorAll('#slots .slot')[2].classList.contains('aura') }));
    assert(r.pct === 25 && r.res > 0 && r.max === r.raw - r.res && r.aura, '绑上霜环应保留 25% 魔力：' + JSON.stringify(r));
    await until(() => document.getElementById('mana-res').classList.contains('on')).catch(() => {
      throw new Error('魔力球上没有显示光环保留');
    });

    const base = await ev(() => { const c = G.skillCtx('ember'); return { proj: c.proj, cost: c.cost, more: c.more }; });
    const sock = (i) => '[data-act="socket"][data-skill="ember"][data-idx="' + i + '"]';
    await page.locator(sock(0)).scrollIntoViewIfNeeded();
    await page.click(sock(0));
    r = await ev(() => ({
      on: document.getElementById('picker').classList.contains('on'),
      can: !!document.querySelector('#picker [data-act="pick"][data-sup="multi"]'),
      unfit: !document.querySelector('#picker [data-act="pick"][data-sup="brutal"]'),
      txt: document.getElementById('picker').innerText,
    }));
    assert(r.on && r.can, '点击空槽没有打开辅助宝石选择器');
    assert(r.unfit && r.txt.includes('需要标签'), '不适配的辅助宝石应不可选并说明原因');
    await page.click('#picker [data-act="pick"][data-sup="multi"]');
    r = await ev(() => { const c = G.skillCtx('ember'); return { s: G.save.sockets.ember.slice(), proj: c.proj, cost: c.cost, more: c.more }; });
    assert(r.s[0] === 'multi' && r.proj === base.proj + 2 && r.cost > base.cost && Math.abs(r.more - base.more * 0.75) < 1e-9, '镶嵌多重投射后 skillCtx 没变：' + JSON.stringify(r));

    // 把同一颗宝石挪到另一个技能上：原来的孔自动空出
    const sock2 = '[data-act="socket"][data-skill="blade"][data-idx="1"]';
    await page.locator(sock2).scrollIntoViewIfNeeded();
    await page.click(sock2);
    await page.click('#picker [data-act="pick"][data-sup="multi"]');
    r = await ev(() => ({ e: G.save.sockets.ember.slice(), b: G.save.sockets.blade.slice(), pe: G.skillCtx('ember').proj, pb: G.skillCtx('blade').proj }));
    assert(r.e[0] === null && r.b[1] === 'multi' && r.pe === 1 && r.pb === 3, '辅助宝石应全局只在一处：' + JSON.stringify(r));
    await page.click(sock2); // 点已镶嵌的孔 = 取下
    r = await ev(() => ({ b: G.save.sockets.blade.slice(), pb: G.skillCtx('blade').proj, cost: G.skillCtx('blade').cost }));
    assert(r.b[1] === null && r.pb === 1, '取下辅助宝石后 skillCtx 没有还原：' + JSON.stringify(r));
    const misc = await ev(() => ({
      unfit: G.socketSupport('ember', 1, 'brutal'),
      echo: (G.socketSupport('arc', 0, 'echo'), G.skillCtx('arc').echo),
      auraEcho: G.socketSupport('nova', 0, 'echo'), // 光环不施放：回响镶不上
      area: (G.socketSupport('nova', 1, 'expanse'), G.skillCtx('nova').area),
      cdr: (G.socketSupport('meteor', 0, 'frugal'), G.skillCtx('meteor').cd),
      cdExp: G.SKILLS.meteor.cd * 0.75,
    }));
    assert(misc.unfit === false && misc.echo === 1 && misc.auraEcho === false && Math.abs(misc.area - 1.4) < 1e-9 && Math.abs(misc.cdr - misc.cdExp) < 1e-9, '辅助效果不对：' + JSON.stringify(misc));
    await ev(() => G.ui.refresh());
    cleanText(await ev(() => T.bodyText()), '镶嵌后的技能页');

    // 用真滚轮把列表滚到底，再给排在最后的闪袭镶宝石：重渲染恢复滚动位置时不能把选择器关掉
    const lr = await ev(() => { const b = document.querySelector('.skill-list').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.move(lr.x, lr.y);
    await page.mouse.wheel(0, 3000);
    await until(() => document.querySelector('.skill-list').scrollTop > 100).catch(() => {
      throw new Error('技能列表滚不动');
    });
    await frames(4);
    const sock3 = '[data-act="socket"][data-skill="blink"][data-idx="0"]';
    // 技能多了以后闪袭不一定排在最后：滚到底之后再把它的插槽带进视野（列表仍处在滚动过的状态）
    await ev((sel) => document.querySelector(sel).scrollIntoView({ block: 'nearest' }), sock3);
    await frames(4);
    const sr = await ev((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, sock3);
    await page.mouse.click(sr.x, sr.y);
    await frames(6);
    await sleep(400);
    await frames(6);
    r = await ev(() => ({
      on: document.getElementById('picker').classList.contains('on'),
      top: document.querySelector('.skill-list').scrollTop,
      picking: !!document.querySelector('.sock.picking[data-skill="blink"]'),
    }));
    assert(r.top > 100, '点击插槽后技能列表的滚动位置丢了');
    assert(r.on && r.picking, '技能列表滚动后，辅助宝石选择器一闪即关：' + JSON.stringify(r));
    await page.click('#picker [data-act="pick"][data-sup="stagger"]');
    await frames(4);
    r = await ev(() => ({ s: G.save.sockets.blink.slice(), stun: G.skillCtx('blink').stun, top: document.querySelector('.skill-list').scrollTop, on: document.getElementById('picker').classList.contains('on') }));
    assert(r.s[0] === 'stagger' && Math.abs(r.stun - 0.7) < 1e-9 && !r.on, '滚动后给闪袭镶嵌震慑失败：' + JSON.stringify(r));
    assert(r.top > 100, '镶嵌后技能列表跳回了顶部');
    // 选择器开着时玩家自己滚动列表：照旧收起
    const sr2 = await ev(() => { const b = document.querySelector('[data-act="socket"][data-skill="blink"][data-idx="1"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
    await page.mouse.click(sr2.x, sr2.y);
    await frames(4);
    assert(await ev(() => document.getElementById('picker').classList.contains('on')), '第二个插槽的选择器没有打开');
    // 选择器会盖住列表的一部分：把鼠标放到列表里没被它盖住的地方再滚
    const free = await ev(() => {
      const b = document.querySelector('.skill-list').getBoundingClientRect();
      for (const fx of [0.5, 0.08, 0.92, 0.25, 0.75]) for (const fy of [0.5, 0.15, 0.85]) {
        const x = b.left + b.width * fx, y = b.top + b.height * fy;
        const n = document.elementFromPoint(x, y);
        if (n && n.closest('.skill-list') && !n.closest('#picker')) return { x, y };
      }
      return null;
    });
    assert(free, '列表被选择器完全盖住了');
    await page.mouse.move(free.x, free.y);
    await page.mouse.wheel(0, -200);
    await until(() => !document.getElementById('picker').classList.contains('on'), null, 5000).catch(() => {
      throw new Error('玩家滚动列表后选择器应收起');
    });
    await ev(() => G.socketSupport('blink', 0, null));
    await closePanel();
  });

  await uiStep('技能页拖拽：辅助宝石拖进辅助槽（不适配的变暗）、孔间移动 / 对调 / 拖回列表取下；技能图标拖到技能栏、栏内互换', async () => {
    const bar0 = await ev(() => {
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.computeStats();
      return G.save.bar.slice();
    });
    await page.keyboard.press('KeyG');
    const sock = (sk, i) => '.sock[data-skill="' + sk + '"][data-idx="' + i + '"]';
    const sup = (id) => '.sup[data-drag="sup:' + id + '"]';
    let mid = null;
    await dragTo(sup('multi'), sock('ember', 0), async () => {
      // 武器普攻卡的 3 个孔（data-skill = G.BASIC_CARD）不算在内：它能镶投射物类的辅助，亮不亮看界面
      mid = await ev(() => { const own = (sel) => Array.from(document.querySelectorAll(sel)).filter((n) => n.dataset.skill !== G.BASIC_CARD).length; return { lit: own('.sock.drop-ok'), dim: own('.sock.drop-no'), cap: document.querySelector('#drag-ghost em').textContent }; });
    });
    assert(mid.lit === 9 && mid.dim === 27 && mid.cap === '镶进 掷焰', '拖辅助宝石时只有带「投射物」标签的技能的槽应亮起（掷焰、飞刃、焚骨祭司）：' + JSON.stringify(mid));
    let r = await ev(() => ({ e: G.save.sockets.ember.slice(), proj: G.skillCtx('ember').proj }));
    assert(r.e[0] === 'multi' && r.proj === 3, '宝石没有镶上：' + JSON.stringify(r));
    await dragTo(sup('brutal'), sock('ember', 1), async () => {
      mid = await ev(() => document.querySelector('#drag-ghost em').textContent);
    });
    assert(mid.includes('需要标签') && (await ev(() => G.save.sockets.ember[1])) === null, '不适配的宝石不应镶上：' + mid);
    await dragTo(sock('ember', 0), sock('blade', 2));
    r = await ev(() => ({ e: G.save.sockets.ember.slice(), b: G.save.sockets.blade.slice() }));
    assert(r.e[0] === null && r.b[2] === 'multi', '孔间拖动应移动宝石：' + JSON.stringify(r));
    await ev(() => { G.socketSupport('ember', 0, 'haste'); G.ui.refresh(); });
    await dragTo(sock('blade', 2), sock('ember', 0));
    r = await ev(() => ({ e: G.save.sockets.ember.slice(), b: G.save.sockets.blade.slice() }));
    assert(r.e[0] === 'multi' && r.b[2] === 'haste', '拖到有宝石的孔应对调：' + JSON.stringify(r));
    await dragTo(sock('ember', 0), '.sup-list');
    assert((await ev(() => G.save.sockets.ember[0])) === null, '拖回宝石列表应取下');
    await page.click(sock('blade', 2));
    assert((await ev(() => G.save.sockets.blade[2])) === null, '点击已镶嵌的孔仍应取下');

    // 技能 → 技能栏
    const free = SKILL_IDS.find((id) => !bar0.includes(id));
    await dragTo('.sk-icon[data-drag="skill:' + free + '"]', '.barslot[data-slot="2"]', async () => {
      mid = await ev(() => ({ cap: document.querySelector('#drag-ghost em').textContent, lit: document.querySelectorAll('.barslot.drop-ok').length }));
    });
    r = await ev(() => G.save.bar.slice());
    assert(mid.cap === '绑定到 Q' && mid.lit === 4 && r[2] === free && r.filter((x) => x === free).length === 1, '技能图标拖到技能栏失败：' + JSON.stringify({ mid, r }));
    await dragTo('.barslot[data-slot="2"]', '.barslot[data-slot="0"]');
    const r2 = await ev(() => G.save.bar.slice());
    assert(r2[0] === free && r2[2] === r[0], '技能栏内拖动应互换：' + r2);
    await ev((bar) => { bar.forEach((id, i) => G.bindSkill(i, id)); G.ui.refresh(); }, bar0);
    await closePanel();
    await until((want) => T.hudBar() === want, bar0.map((x) => x || '').join()).catch(() => {
      throw new Error('HUD 技能栏没有同步');
    });
  });

  // ------------------------------------------------------------------ v2 界面：地面掉落 / 战斗信息 / 新手提示
  await uiStep('地面掉落：悬停名牌显示完整属性与换装对比，通货 / 宝石有说明；升降标记；按住 Alt 展开概要且不影响操作', async () => {
    await ev(() => {
      T.arena();
      G.save.bag.length = 0;
      delete G.save.skills.nova;
      delete G.save.sockets.nova;
      G.save.bar = G.save.bar.map((id) => (id === 'nova' ? null : id));
      G.save.supports = G.save.supports.filter((id) => id !== 'multi');
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = G.save.sockets[id].map((x) => (x === 'multi' ? null : x));
      G.equip(G.debug.giveItem(1, 'belt'));
      const put = (kind, data, x, z) => { const l = G.spawnLoot(kind, data, x, z); l.x = x; l.z = z; l.mesh.position.set(x, 0, z); l.t = 1; l.noAuto = true; return l; };
      window.__L = {
        rare: put('item', G.rollItem(3, 2, 'belt'), -5, -3), white: put('item', G.rollItem(1, 0, 'helm'), 2.5, -3.5),
        cur: put('cur', 'alch', 5, -1), skill: put('skill', { id: 'nova', lvl: 2 }, -4.5, 1.5), sup: put('support', 'multi', 4.5, 2.5),
      };
      T.settle();
      G.debug.hold(false);
    });
    await page.mouse.move(1000, 620);
    await frames(3);
    const hover = async (k) => {
      const pt = await ev((k) => T.labelPt(window.__L[k]), k);
      assert(pt, k + ' 的名牌不在画面里');
      await page.mouse.move(pt.x, pt.y);
      await until((k) => document.getElementById('tip').classList.contains('on') && document.getElementById('reticle').className === 'loot', k).catch(() => {
        throw new Error('悬停 ' + k + ' 的名牌没有出现提示');
      });
      await frames(2);
      const r = await ev(() => ({
        txt: document.getElementById('tip').innerText, pair: !!document.querySelector('#tip .tip-pair'), vd: !!document.querySelector('#tip .ic-vd'), icon: !!document.querySelector('#tip .ibox > .ico'),
        box: T.rect('#tip'), w: innerWidth, h: innerHeight, t: G.state.time, paused: G.state.paused,
      }));
      cleanText(r.txt, k + ' 的地面提示');
      assert(r.icon && r.box.l >= 0 && r.box.t >= 0 && r.box.r <= r.w && r.box.b <= r.h, k + ' 的提示没有图标或超出屏幕：' + JSON.stringify(r.box));
      assert(!r.paused, '看地面提示时游戏不应暂停');
      return r;
    };
    let r = await hover('rare');
    assert(r.pair && r.vd && r.txt.includes('当前装备') && r.txt.includes('物品等级 3') && r.txt.includes('点击名牌拾取'), '稀有腰带的地面提示应与身上的腰带对比：' + r.txt.slice(0, 120));
    r = await hover('white');
    assert(!r.pair && r.vd && r.txt.includes('这个部位还空着') && r.txt.includes('护甲'), '空部位的评估不对：' + r.txt.slice(0, 120));
    r = await hover('cur');
    assert(r.txt.includes('点金石') && r.txt.includes('把普通物品升为稀有物品') && r.txt.includes('拖到一件物品上'), '通货的地面提示不对');
    r = await hover('skill');
    assert(r.txt.includes('霜环') && r.txt.includes('光环') && r.txt.includes('魔力保留 25%') && r.txt.includes('新技能') && r.txt.includes('每跳基础伤害'), '技能宝石的地面提示应说明它做什么：' + r.txt.slice(0, 200));
    r = await hover('sup');
    assert(r.txt.includes('多重投射') && r.txt.includes('额外发射 2 个投射物') && r.txt.includes('可镶嵌') && r.txt.includes('掷焰'), '辅助宝石的地面提示应说明它做什么');
    await page.mouse.move(1000, 620);
    await until(() => !document.getElementById('tip').classList.contains('on') && document.getElementById('reticle').className === 'aim').catch(() => {
      throw new Error('鼠标移开后提示没有消失');
    });
    r = await ev(() => Object.keys(window.__L).map((k) => window.__L[k].label));
    assert(/ ▲$/.test(r[0]) === (/▲/.test(r[0])) && r[1].endsWith(' ▲') && r[2] === '点金石' && r[3].endsWith(' ▲') && r[4].endsWith(' ▲'), '名牌上的升降标记不对：' + JSON.stringify(r));
    await page.keyboard.down('Alt');
    try {
      await until(() => /稀有 腰带 · 物品等级 3 · [▲▼＝]$/.test(window.__L.rare.label)).catch(() => {
        throw new Error('按住 Alt 没有展开名牌');
      });
      r = await ev(() => Object.keys(window.__L).map((k) => window.__L[k].label));
      assert(r[1].includes('普通 头盔 · 物品等级 1 · ▲') && r[2].includes('通货 · 已有') && r[3].includes('新技能') && r[4].includes('新的辅助宝石'), 'Alt 概要不对：' + JSON.stringify(r));
      // 按着 Alt 时移动键照常生效
      const x0 = await ev(() => G.player.x);
      await page.keyboard.down('KeyD');
      await until((x0) => G.player.x > x0 + 0.5, x0).catch(() => {
        throw new Error('按住 Alt 时无法移动');
      });
      await page.keyboard.up('KeyD');
    } finally {
      await page.keyboard.up('KeyD');
      await page.keyboard.up('Alt');
    }
    await until(() => window.__L.rare.label.indexOf(' · ') < 0).catch(() => {
      throw new Error('松开 Alt 后名牌没有收起');
    });
    // 点击名牌仍然是拾取
    const pt = await ev(() => { T.tp(0, 0); T.settle(); return T.labelPt(window.__L.white); });
    await page.mouse.click(pt.x, pt.y);
    r = await ev(() => ({ got: G.save.bag.some((i) => i === window.__L.white.data), fresh: null, kh: document.getElementById('kh-new').textContent }));
    await until(() => document.getElementById('kh-new').textContent === '1').catch(() => {
      throw new Error('拾到新物品后 HUD 的背包按钮没有计数');
    });
    assert(r.got, '点击名牌没有拾取');
    await page.keyboard.press('KeyI');
    r = await ev(() => ({ dot: document.querySelectorAll('.cell .c-new').length }));
    assert(r.dot === 1, '新拾到的物品应有「新」标记');
    await page.hover('.cell[data-item]:has(.c-new)');
    await until(() => document.querySelectorAll('.cell .c-new').length === 0 && document.getElementById('kh-new').textContent === '').catch(() => {
      throw new Error('悬停之后「新」标记应消失');
    });
    await closePanel();
    await ev(() => {
      G.debug.hold(true);
      G.debug.learnAll();
      G.save.bag.length = 0;
      delete G.save.equip.belt;
      G.computeStats();
      T.clearLoot();
      delete window.__L;
    });
  });

  await uiStep('战斗信息：准星随目标变化、敌人名牌（等级 / 精英 / 异常）、脚下的生命魔力弧、濒死警告、放不出技能时的反馈、冷却转好闪光、画面外目标的箭头、首领异常图标', async () => {
    const bar0 = await ev(() => {
      T.arena();
      G.debug.god(true);
      const bar = G.save.bar.slice();
      const e = G.spawnMob('brute', 3.5, -1.5, 3, { awake: true, elite: true });
      e.hp = e.maxHp * 0.6;
      e.freeze = 1e9; // 元素异常值触发后的三种状态：冻结、感电、刚爆燃过
      e.shockT = 1e9;
      e.blastT = 1e9;
      e.hp = e.maxHp = 1e7;
      const f1 = G.spawnMob('husk', 0, -6, 1, { awake: true, elite: true });
      f1.freeze = 1e9;
      f1.x = 40;
      f1.z = -3;
      const asleep = G.spawnMob('husk', 0, -6, 1, { elite: true });
      asleep.x = -40;
      asleep.z = 0;
      window.__E = e;
      T.settle();
      G.debug.hold(false);
      return bar;
    });
    await page.mouse.move(1000, 620);
    await until(() => document.getElementById('reticle').className === 'aim' && document.getElementById('parc').classList.contains('on')).catch(() => {
      throw new Error('准星 / 脚下的弧没有出现');
    });
    let r = await ev(() => {
      const p = G.world.project(G.player.x, 0, G.player.z);
      const a = T.rect('#parc svg');
      const ar = Array.from(document.querySelectorAll('.arrow.on'));
      return {
        ret: document.getElementById('reticle').style.transform, arc: a, px: p.x, py: p.y, cursor: getComputedStyle(document.getElementById('gl')).cursor,
        arrows: ar.map((n) => n.className.replace('arrow on ', '') + '@' + Math.round(n.getBoundingClientRect().left)), w: innerWidth,
        dash: [document.querySelector('.pa-life').style.strokeDasharray, document.querySelector('.pa-mana').style.strokeDasharray],
      };
    });
    assert(r.ret === 'translate(1000px, 620px)' && r.cursor === 'none', '准星没有跟着鼠标：' + r.ret);
    assert(Math.abs(r.arc.x - r.px) < 6 && r.arc.t >= r.py - 12 && r.arc.b <= r.py + 40 && parseInt(r.dash[0], 10) === 100 && parseInt(r.dash[1], 10) === 100, '脚下的弧位置或数值不对：' + JSON.stringify(r));
    assert(r.arrows.length === 1 && r.arrows[0].startsWith('elite@') && parseInt(r.arrows[0].split('@')[1], 10) > r.w * 0.8, '只有醒着的画面外精英应有箭头，且在它那一侧：' + JSON.stringify(r.arrows));
    const pt = await ev(() => { const p = G.world.project(window.__E.x, 1.2, window.__E.z); return { x: p.x, y: p.y }; });
    await page.mouse.move(pt.x, pt.y);
    await until(() => document.getElementById('reticle').className === 'enemy' && document.getElementById('nameplate').classList.contains('on')).catch(() => {
      throw new Error('指着敌人时准星 / 名牌没有反应');
    });
    r = await ev(() => ({ txt: document.getElementById('nameplate').innerText, cls: document.getElementById('nameplate').className, icons: document.querySelectorAll('#nameplate .ail .ico').length, box: T.rect('#nameplate'), w: innerWidth }));
    assert(r.cls.includes('elite') && r.txt.includes('精英巨躯') && r.txt.includes('Lv 3') && r.txt.includes('精英') && r.txt.includes('爆燃') && r.txt.includes('冻结') && r.txt.includes('感电') && r.icons === 3, '名牌内容不对：' + r.txt);
    assert(r.box.t >= 0 && r.box.l >= 0 && r.box.r <= r.w, '名牌超出屏幕');
    await page.mouse.move(1000, 620);
    await until(() => document.getElementById('reticle').className === 'aim' && !document.getElementById('nameplate').classList.contains('on')).catch(() => {
      throw new Error('移开后名牌没有消失');
    });

    // 放不出来：魔力不足 / 冷却中；冷却转好闪一下
    const slotOf = await ev(() => {
      G.bindSkill(1, 'ember');
      G.bindSkill(2, 'meteor');
      return 1;
    });
    await frames(3);
    await ev(() => { G.player.mana = 0; });
    await holdInput(slotOf, true);
    try {
      await until(() => document.querySelectorAll('#slots .slot')[1].classList.contains('deny')).catch(() => {
        throw new Error('魔力不足时技能格没有反馈');
      });
    } finally {
      await holdInput(slotOf, false);
    }
    r = await ev(() => { const s = document.querySelectorAll('#slots .slot')[1]; const b = s.querySelector('.s-bubble').getBoundingClientRect(), bar = document.getElementById('bar').getBoundingClientRect(); return { txt: s.querySelector('.s-bubble').textContent, inBar: b.left >= bar.left && b.right <= bar.right && b.top >= bar.top && b.bottom <= bar.bottom }; });
    assert(r.txt === '魔力不足' && r.inBar, '魔力不足的反馈不对：' + JSON.stringify(r));
    await ev(() => { G.player.mana = G.player.maxMana; G.player.cds.meteor = 30; G.player.cdMax.meteor = 30; });
    await frames(2);
    await holdInput(2, true);
    try {
      await until(() => document.querySelectorAll('#slots .slot')[2].classList.contains('deny')).catch(() => {
        throw new Error('冷却中按下技能键没有反馈');
      });
    } finally {
      await holdInput(2, false);
    }
    assert((await ev(() => document.querySelectorAll('#slots .slot')[2].querySelector('.s-bubble').textContent)) === '冷却中', '冷却中的提示文字不对');
    await ev(() => { G.player.cds.meteor = 0.15; });
    await until(() => document.querySelectorAll('#slots .slot')[2].classList.contains('ready')).catch(() => {
      throw new Error('冷却转好时技能格没有闪光');
    });
    await until(() => !document.querySelector('#slots .slot.ready, #slots .slot.deny')).catch(() => {
      throw new Error('技能格的反馈状态没有清掉');
    });

    // 濒死：边缘脉动 + 心跳声 + 生命球 / 弧变色；回血后消失
    await ev(() => {
      window.__beats = 0;
      window.__sfx = G.sfx;
      G.sfx = function (n) { if (n === 'heart') window.__beats++; return window.__sfx(n); };
      G.player.life = G.player.maxLife * 0.15;
    });
    await until(() => window.__beats >= 2 && document.getElementById('lowlife').classList.contains('on')).catch(() => {
      throw new Error('濒死时没有心跳 / 边缘警告');
    });
    r = await ev(() => ({ orb: document.querySelector('.orb.life').classList.contains('low'), arc: document.getElementById('parc').classList.contains('low'), dash: document.querySelector('.pa-life').style.strokeDasharray }));
    assert(r.orb && r.arc && parseInt(r.dash, 10) >= 13 && parseInt(r.dash, 10) <= 22, '濒死时生命球 / 脚下的弧没有反应：' + JSON.stringify(r));
    await ev(() => { G.player.life = G.player.maxLife; });
    await until(() => !document.getElementById('lowlife').classList.contains('on') && !document.querySelector('.orb.life').classList.contains('low')).catch(() => {
      throw new Error('回血后濒死警告没有消失');
    });
    await ev(() => { G.sfx = window.__sfx; delete window.__sfx; });

    // 首领：血条上的异常图标；走远后有箭头；传送门也有
    await ev(() => {
      G.clearEnemies();
      const b = G.spawnBoss('golem', G.player.x, G.player.z - 9, 1);
      b.awake = true;
      b.bossChill = 1e9; // 首领不会被冻结，冰霜异常值满了是重度冰缓
      b.shockT = 1e9;
      b.blastT = 1e9;
      b.hp = b.maxHp = 1e7;
    });
    await until(() => document.getElementById('boss-box').classList.contains('on') && document.querySelectorAll('#boss-ail .ail .ico').length === 3).catch(() => {
      throw new Error('首领血条上没有异常状态图标');
    });
    // 血条下的三段元素异常值：触发中整段亮着
    await until(() => document.querySelectorAll('.boss-bu i.on').length === 3).catch(() => {
      throw new Error('首领的元素异常值条没有跟着触发状态亮起');
    });
    r = await ev(() => ({ ail: T.rect('#boss-ail'), box: T.rect('#boss-box'), name: T.rect('#boss-name'), cls: Array.from(document.querySelectorAll('#boss-ail .ail')).map((n) => n.className.replace('ail ', '')).join() }));
    assert(r.cls === 'burn,chill,shock' && r.ail.r <= r.box.r + 1 && r.ail.l >= r.box.l && r.ail.b <= r.box.b, '首领异常图标的位置不对：' + JSON.stringify(r));
    await ev(() => {
      const b = G.state.boss;
      b.x = G.player.x - 45;
      b.z = G.player.z + 2;
      G.state.portal = { x: G.player.x + 3, z: G.player.z + 60, mesh: G.world.makePortal(G.player.x + 3, G.player.z + 60), armed: false };
    });
    await until(() => document.querySelector('.arrow.on.boss') && document.querySelector('.arrow.on.portal')).catch(() => {
      throw new Error('画面外的首领 / 传送门没有箭头');
    });
    r = await ev(() => {
      const hudRects = ['#zone-box', '#boss-box', '.orb-wrap.left', '.orb-wrap.right', '#console'].map((s) => document.querySelector(s).getBoundingClientRect());
      const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const ar = Array.from(document.querySelectorAll('.arrow.on b')).map((n) => n.getBoundingClientRect());
      return { n: ar.length, boss: document.querySelector('.arrow.on.boss b').getBoundingClientRect().left, portal: document.querySelector('.arrow.on.portal b').getBoundingClientRect().top, overlap: ar.some((a) => hudRects.some((h) => hit(a, h))), mm: ar.some((a) => a.right > innerWidth - 190 && a.top < 190), w: innerWidth, h: innerHeight };
    });
    assert(r.boss < r.w * 0.2 && r.portal > r.h * 0.6, '箭头没有指向目标所在的方向：' + JSON.stringify(r));
    assert(!r.overlap && !r.mm, '箭头压住了 HUD 或小地图');
    await ev((bar) => {
      G.world.removeMesh(G.state.portal.mesh);
      G.state.portal = null;
      T.arena();
      bar.forEach((id, i) => G.bindSkill(i, id));
      G.player.cds = {};
      G.debug.hold(true);
      delete window.__E;
    }, bar0);
  });

  await uiStep('无铭技能宝石：技能页顶部写数量和最高等级；点两下才用掉；学会新技能自动上技能栏；给已学技能升级；总是用最高的那颗；等级不够不能升；第一次捡到有新手提示', async () => {
    // 先让两个技能变回「没学会」，技能栏腾出一格
    await ev(() => {
      const s = G.save;
      for (const id of ['arc', 'meteor']) {
        delete s.skills[id];
        delete s.sockets[id];
        const i = s.bar.indexOf(id);
        if (i >= 0) s.bar[i] = null;
      }
      s.bar = ['cleave', 'ember', 'nova', null];
      s.skills.nova = 3;
      s.skills.blade = 8;
      s.blankGems = [7, 5, 2];
      G.computeStats();
    });
    await page.keyboard.press('KeyG');
    let r = await ev(() => ({
      bar: (document.querySelector('.blank-bar') || {}).innerText || '',
      learn: Array.from(document.querySelectorAll('.sm-learn')).map((b) => b.dataset.skill).sort().join(),
      learnTxt: (document.querySelector('.sm-learn') || {}).innerText || '',
      upNova: (document.querySelector('.blank-up[data-skill="nova"]') || {}).innerText || '',
      upBlade: !!document.querySelector('.blank-up[data-skill="blade"]'),
      icon: getComputedStyle(document.querySelector('.blank-bar .ico')).backgroundImage.startsWith('url("data:image/png'),
    }));
    assert(r.bar.includes('无铭技能宝石') && r.bar.includes('×3') && r.bar.includes('最高 Lv 7') && r.icon, '技能页顶部应写数量和最高等级：' + JSON.stringify(r));
    assert(r.learn === 'arc,meteor' && r.learnTxt.includes('Lv 7'), '「尚未获得」里每个技能都应能点、写明用哪一颗：' + JSON.stringify(r));
    assert(r.upNova.includes('Lv 7') && !r.upBlade, '已学技能卡上：等级更低的给升级入口，等级更高的不给：' + JSON.stringify(r));
    cleanText(await ev(() => T.bodyText()), '带无铭宝石的技能页');

    // 防误点：点一下只是选中；点别的就换成选中别的；悬停写清楚会用哪一颗
    await page.locator('.sm-learn[data-skill="arc"]').scrollIntoViewIfNeeded();
    await page.click('.sm-learn[data-skill="arc"]');
    r = await ev(() => ({ gems: G.save.blankGems.join(), arc: !!G.save.skills.arc, armed: document.querySelector('.sm-learn[data-skill="arc"]').classList.contains('armed'), txt: document.querySelector('.sm-learn[data-skill="arc"]').innerText, tip: document.getElementById('tip').innerText }));
    assert(r.gems === '7,5,2' && !r.arc && r.armed && r.txt.includes('再点一次'), '点第一下不应用掉宝石，而是等着确认：' + JSON.stringify(r));
    assert(r.tip.includes('Lv 7') && r.tip.includes('链雷'), '悬停提示应写明会用 Lv 7 的那颗学会链雷：' + r.tip);
    await page.click('.sm-learn[data-skill="meteor"]');
    r = await ev(() => ({ gems: G.save.blankGems.join(), arcArmed: document.querySelector('.sm-learn[data-skill="arc"]').classList.contains('armed'), metArmed: document.querySelector('.sm-learn[data-skill="meteor"]').classList.contains('armed') }));
    assert(r.gems === '7,5,2' && !r.arcArmed && r.metArmed, '点另一个技能应改为选中它，仍不用掉宝石：' + JSON.stringify(r));
    // 再点一次：学会，用的是最高的 Lv 7，自动放进技能栏的空格
    await page.click('.sm-learn[data-skill="meteor"]');
    r = await ev(() => ({ gems: G.save.blankGems.join(), lvl: G.save.skills.meteor, sock: JSON.stringify(G.save.sockets.meteor), bar: G.save.bar.join(), msg: (document.querySelector('.bk-msg') || {}).innerText || '', toast: T.toasts(), card: !!document.querySelector('.skill-card [data-act="bind"][data-skill="meteor"]'), stored: JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).blankGems.join() }));
    assert(r.lvl === 7 && r.gems === '5,2' && r.stored === '5,2', '应用掉最高的 Lv 7 那颗学会陨火：' + JSON.stringify(r));
    assert(r.sock === '[null,null,null]' && r.bar === 'cleave,ember,nova,meteor' && r.card, '学会后应开好辅助槽并自动放进技能栏的空格：' + JSON.stringify(r));
    assert(r.msg.includes('陨火') && r.msg.includes('Lv 7') && r.toast.includes('习得技能：陨火 Lv 7'), '学会后应给出提示：' + JSON.stringify(r));
    await until(() => document.querySelectorAll('#slots .slot')[3].dataset.skill === 'meteor').catch(() => {
      throw new Error('HUD 技能栏没有同步');
    });

    // 升级已学技能：用当前最高的 Lv 5；同样要点两下
    await page.locator('.blank-up[data-skill="nova"]').scrollIntoViewIfNeeded();
    r = await ev(() => document.querySelector('.blank-up[data-skill="nova"]').innerText);
    assert(r.includes('Lv 5'), '升级按钮应写明会升到 Lv 5：' + r);
    await page.click('.blank-up[data-skill="nova"]');
    r = await ev(() => ({ lvl: G.save.skills.nova, gems: G.save.blankGems.join(), txt: document.querySelector('.blank-up[data-skill="nova"]').innerText }));
    assert(r.lvl === 3 && r.gems === '5,2' && r.txt.includes('再点一次'), '升级也要点两下：' + JSON.stringify(r));
    await page.click('.blank-up[data-skill="nova"]');
    r = await ev(() => ({ lvl: G.save.skills.nova, gems: G.save.blankGems.join(), msg: (document.querySelector('.bk-msg') || {}).innerText || '', btn: !!document.querySelector('.blank-up[data-skill="nova"]'), toast: T.toasts() }));
    assert(r.lvl === 5 && r.gems === '2' && r.msg.includes('Lv 3') && r.msg.includes('Lv 5') && r.toast.includes('霜环 升至 Lv 5'), '应用掉 Lv 5 那颗把霜环升到 Lv 5：' + JSON.stringify(r));
    assert(!r.btn, '剩下的 Lv 2 不高于霜环的 Lv 5，卡上不应再有升级入口');

    // 等级不够：不能升级（接口直接拒绝，界面上不给入口）
    r = await ev(() => ({ api: G.useBlankGem('nova'), gems: G.save.blankGems.join(), lvl: G.save.skills.nova, ups: document.querySelectorAll('.blank-up').length, cleave: G.save.skills.cleave }));
    assert(r.api === null && r.gems === '2' && r.lvl === 5, '等级不高于当前时不应能升级：' + JSON.stringify(r));
    // 用完最后一颗：顶部写「已用完」，「尚未获得」变回不可点的列表
    r = await ev(() => {
      G.save.blankGems = [];
      G.ui.refresh();
      return { bar: (document.querySelector('.blank-bar') || {}).innerText || '', learn: document.querySelectorAll('.sm-learn').length, ups: document.querySelectorAll('.blank-up').length, api: G.useBlankGem('arc') };
    });
    assert(r.learn === 0 && r.ups === 0 && r.api === null, '没有无铭宝石时不应有使用入口：' + JSON.stringify(r));
    await closePanel();
    r = await ev(() => { G.ui.open('skills'); const b = !!document.querySelector('.blank-bar'); G.ui.close(); return b; });
    assert(!r, '手里没有无铭宝石时技能页顶部不应显示持有条');

    // 新手提示：第一次捡到时出现，告诉玩家到技能页去用；技能页里接着提示；用掉一颗就算做到了
    await ev(() => {
      T.arena();
      T.hintsSeen();
      delete G.save.tut.blank;
      G.save.blankGems = [];
      const P = G.player;
      const l = G.spawnLoot('blank', { lvl: 6 }, P.x, P.z);
      T.tp(l.x, l.z);
      G.debug.step(0.5);
      G.debug.hold(false);
    });
    await until(() => G.ui.hints().current === 'blank' && G.ui.hints().state === 'show' && document.getElementById('coach').classList.contains('on')).catch(() => {
      throw new Error('第一次捡到无铭宝石时没有出现新手提示');
    });
    r = await ev(() => document.getElementById('coach').innerText);
    assert(r.includes('无铭技能宝石') && r.includes('G') && r.includes('技能页'), '新手提示没有说清楚去技能页用：' + r);
    await page.keyboard.press('KeyG');
    r = await ev(() => (document.querySelector('.side-coach') || {}).innerText || '');
    assert(r.includes('再点一次'), '技能页里应接着提示怎么用：' + r);
    await page.locator('.sm-learn[data-skill="arc"]').scrollIntoViewIfNeeded();
    await page.click('.sm-learn[data-skill="arc"]');
    await page.click('.sm-learn[data-skill="arc"]');
    await until(() => !!G.save.tut.blank).catch(() => {
      throw new Error('用掉一颗之后新手提示没有标记为看过');
    });
    r = await ev(() => G.save.skills.arc);
    assert(r === 6, '通过提示引导学会的链雷应是 Lv 6：' + r);
    await closePanel();
    await ev(() => {
      G.debug.hold(true);
      G.save.blankGems = [];
      G.save.skills.blade = 1;
      G.save.skills.nova = 1;
      G.persist();
    });
  });

  await uiStep('新手提示：按情境逐条出现、做到即消失、不挡操作，看过的写进存档；面板里有对应的提示条；老角色跳过基础操作', async () => {
    const hint = () => ev(() => Object.assign(G.ui.hints(), { cls: document.getElementById('coach').className, txt: document.getElementById('coach').innerText, tut: Object.keys(G.save.tut).join() }));
    const shown = (id) => until((id) => G.ui.hints().current === id && G.ui.hints().state === 'show' && document.getElementById('coach').classList.contains('on'), id).catch(() => {
      throw new Error('提示「' + id + '」没有出现');
    });
    const seen = (id) => until((id) => !!G.save.tut[id], id).catch(() => {
      throw new Error('提示「' + id + '」没有在做到之后标记为看过');
    });
    const keep = await ev(() => {
      T.arena();
      const k = { level: G.save.level, xp: G.save.xp, bar: G.save.bar.slice() };
      G.bindSkill(0, 'cleave');
      G.bindSkill(1, 'ember');
      G.save.level = 1;
      G.computeStats();
      G.save.bag.length = 0;
      G.save.blankGems = []; // 前面的步骤里可能随机捡到过无铭宝石：它的提示会插队
      G.save.tut = {};
      G.ui.refresh();
      G.debug.hold(false);
      return k;
    });
    await page.mouse.move(900, 450);
    await shown('move');
    let r = await hint();
    // 远程改版又加了几条（拿上远程武器、量表满、长弓改名、新区域……），按下限比
    assert(r.txt.includes('移动') && r.all.length >= 19, '第一条提示应是移动（至少 19 条，含武器技、旧存档的武器改版与成长改版说明）：' + r.txt + ' / ' + r.all.join());
    r = await ev(() => { const c = T.rect('#coach'), k = T.rect('#keyhints'), f = T.rect('.orb-wrap.left'); return { c, under: c.t >= k.b, aboveOrb: c.b <= f.t, pe: getComputedStyle(document.getElementById('coach')).pointerEvents }; });
    assert(r.under && r.aboveOrb && r.c.l >= 0 && r.pe === 'none', '提示卡的位置不对或挡住了操作：' + JSON.stringify(r));
    await page.keyboard.down('KeyD');
    try {
      await seen('move');
    } finally {
      await page.keyboard.up('KeyD');
    }
    await shown('attack');
    await holdInput(0, true);
    try {
      await until(() => G.player.cast && G.player.cast.slot === 0);
    } finally {
      await holdInput(0, false);
    }
    await frames(3);
    r = await hint();
    assert(r.current === 'attack' && !r.tut.includes('attack'), '只用了一个键，提示不应消失');
    await holdInput(1, true);
    try {
      await seen('attack');
    } finally {
      await holdInput(1, false);
    }
    r = await ev(() => Object.keys(JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).tut).sort().join());
    assert(r === 'attack,move', '看过的提示没有写进存档：' + r);
    // 没有敌人时不提示翻滚；背包里有东西时提示背包，并在背包页里接着提示
    await ev(() => { G.save.tut.dodge = 1; G.debug.giveItem(1, 'helm'); });
    await shown('bag');
    await page.keyboard.press('KeyI');
    r = await ev(() => ({ banner: (document.querySelector('.inv-tips.coach') || {}).innerText || '', hidden: getComputedStyle(document.getElementById('coach')).display }));
    assert(r.banner.includes('右键') && r.hidden === 'none', '背包页里应有对应的提示条：' + JSON.stringify(r));
    await page.click('.cell[data-item]', { button: 'right' });
    await seen('bag');
    await until(() => !document.querySelector('.inv-tips.coach')).catch(() => {
      throw new Error('做到之后面板里的提示条没有收掉');
    });
    await closePanel();
    // 本次从 1 级玩上来的角色中途升到 3 级：基础提示照出，不会被当成老角色悄悄跳过（回归：翻滚提示曾因此从不出现）
    await ev(() => {
      G.save.tut = { move: 1, attack: 1, bag: 1, craft: 1, support: 1, passive: 1, combo: 1, poise: 1, wskill: 1 };
      G.save.level = 3;
      T.mob('husk', 9, 0, { speed: 0, atkCd: 1e9 });
    });
    await shown('dodge');
    r = await hint();
    assert(!r.veteran && r.txt.includes('翻滚') && !r.tut.includes('dodge'), '升到 3 级的新角色应照常看到翻滚提示：' + JSON.stringify(r));
    // 做到了：立刻记为看过，但卡片要留到读得完为止（至少 4 秒），不会一闪而过
    const t0 = Date.now();
    await page.keyboard.press('Space');
    await seen('dodge');
    r = await hint();
    assert(r.state === 'done' && r.cls.includes('done') && r.minShow >= 4, '做到之后应显示「做到了」：' + JSON.stringify(r));
    await until(() => G.ui.hints().current !== 'dodge');
    assert(Date.now() - t0 >= 1900, '提示在做到之后消失得太快：' + (Date.now() - t0) + ' ms');
    await ev(() => { G.clearEnemies(); G.player.roll.cd = 0; });
    // 读档时已经 3 级以上的老角色：基础操作的提示直接跳过（只在读档那一刻判定）
    await ev(() => {
      G.save.tut = { bag: 1, craft: 1, support: 1, passive: 1 };
      G.save.level = 5;
      G.persist();
      G.loadSave();
      G.computeStats();
    });
    await until(() => G.save.tut.move && G.save.tut.attack && G.save.tut.dodge).catch(() => {
      throw new Error('读档时 3 级以上的角色应跳过基础操作提示');
    });
    r = await hint();
    assert(r.current === null && r.veteran, '老角色不应看到基础提示：' + JSON.stringify(r));
    // 要开面板才做得了的提示（天赋）亮着时生命见底：喝药的提示立刻顶上来，被顶掉的那条不算看过，之后还会再出
    await ev(() => {
      G.save.tut = { move: 1, attack: 1, dodge: 1, combo: 1, poise: 1, loot: 1, bag: 1, craft: 1, support: 1, execute: 1, boss: 1, portal: 1, wskill: 1 };
      G.resetPassives();
      G.player.flask.life = 3;
    });
    await shown('passive');
    await ev(() => { G.player.life = G.player.maxLife * 0.2; });
    const tf = Date.now();
    await shown('flask');
    r = await hint();
    assert(Date.now() - tf < 5000 && !r.tut.includes('passive') && r.txt.includes('生命药剂'), '濒死时喝药的提示应立刻顶掉正在显示的面板提示：' + JSON.stringify(r));
    await ev(() => { G.player.life = G.player.maxLife; });
    await seen('flask');
    await shown('passive');
    // 打起来了：先收起，不占着提示位，也不算看过
    await ev(() => { T.mob('husk', 7, 0); });
    await until(() => G.ui.hints().current !== 'passive').catch(() => {
      throw new Error('战斗开始后，需要清静的提示没有收起');
    });
    r = await hint();
    assert(!r.tut.includes('passive'), '被战斗打断的提示不应算作看过：' + JSON.stringify(r));
    await frames(20);
    assert((await hint()).current !== 'passive', '身边有敌人时不应再弹出需要清静的提示');
    await ev(() => { G.clearEnemies(); });
    await shown('passive');
    // 帮助页可以重置
    await page.keyboard.press('KeyH');
    await page.click('[data-act="tut-reset"]');
    r = await ev(() => ({ n: Object.keys(G.save.tut).length, txt: document.querySelector('.help-foot').innerText }));
    assert(r.n === 0 && r.txt.includes('已重置'), '帮助页的「重新显示新手提示」无效');
    await closePanel();
    await ev((keep) => {
      G.debug.hold(true);
      T.hintsSeen();
      G.save.level = keep.level;
      G.save.xp = keep.xp;
      keep.bar.forEach((id, i) => G.bindSkill(i, id));
      G.save.bag.length = 0;
      delete G.save.equip.helm;
      G.computeStats();
      G.player.life = G.player.maxLife;
      G.player.mana = G.player.maxMana;
      G.persist();
    }, keep);
  });

  await step('面板内的提示：toast 不压页签栏和面板内容', async () => {
    await page.keyboard.press('KeyI');
    await until(() => G.ui.isOpen());
    const r = await ev(() => {
      G.ui.toast('较早的一条提示');
      G.ui.toast('分解获得：微光尘 ×1');
      const rect = (n) => { const b = n.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const vis = Array.from(document.querySelectorAll('#toasts .toast')).filter((n) => n.getBoundingClientRect().height > 0);
      return {
        n: vis.length, txt: vis.map((n) => n.textContent).join('|'), toast: vis.length ? rect(vis[vis.length - 1]) : null,
        tabs: rect(document.getElementById('tabs')), body: rect(document.getElementById('panel-body')), h: innerHeight,
      };
    });
    assert(r.n === 1 && r.txt.includes('分解获得'), '面板打开时应只显示最新的一条提示：' + JSON.stringify(r));
    assert(r.toast.t >= r.tabs.b, '提示压在页签栏上：' + JSON.stringify(r));
    assert(r.toast.t >= r.body.b - 2 && r.toast.b <= r.h, '提示压在面板内容上或超出屏幕：' + JSON.stringify(r));
    await closePanel();
    const out = await ev(() => {
      G.ui.toast('甲');
      G.ui.toast('乙');
      const vis = Array.from(document.querySelectorAll('#toasts .toast')).filter((n) => n.getBoundingClientRect().height > 0);
      return { t: vis[vis.length - 1].getBoundingClientRect().top, n: vis.length };
    });
    assert(out.t < 300 && out.n >= 2, '面板关闭后提示应回到屏幕上方并恢复多条：' + JSON.stringify(out));
  });

  await step('回响：法术自动重复一次，不再扣魔力', async () => {
    const r = await ev(() => {
      T.arena();
      T.fix(0.5); // 随机数钉死：伤害取中值、不暴击
      const P = G.player;
      G.bindSkill(2, 'arc'); // 链雷（镶着回响）放到 Q 上，顶掉霜环
      P.mana = P.maxMana;
      T.dummy(3, 0); // 两下链雷灌不满闪电异常值（阈值是靶子生命的一半），不会多出电弧
      G.input.mouse.wx = T.d.x;
      G.input.mouse.wz = T.d.z;
      const cost = G.skillCtx('arc').cost;
      G.input.tap[2] = 0.25; // 轻点一次 Q
      G.debug.step(0.31);
      const hp1 = T.d.hp, m1 = P.mana;
      G.debug.step(0.3);
      const hp2 = T.d.hp;
      G.debug.step(1);
      T.unfix();
      return { first: T.d.maxHp - hp1, second: hp1 - hp2, later: hp2 - T.d.hp, spent: P.maxMana - m1, cost };
    });
    assert(r.first > 0 && r.second > 0 && r.later === 0, '回响应正好多打一次：' + JSON.stringify(r));
    assert(r.spent <= r.cost && r.spent > r.cost - 3, '回响不应额外扣魔力：' + JSON.stringify(r));
    await ev(() => {
      G.socketSupport('arc', 0, null);
      G.socketSupport('nova', 1, null);
      G.socketSupport('meteor', 0, null);
    });
  });

  await step('天赋：界面点亮 / 退回 / 断连保护 / 重置，属性随之变化', async () => {
    const base = await ev(() => {
      G.debug.setLevel(12);
      G.resetPassives();
      return { life: G.player.maxLife, pts: G.passivePoints(), inc: G.skillCtx('cleave').inc.phys };
    });
    assert(base.pts.total === 11 && base.pts.free === 11, '12 级应有 11 点天赋：' + JSON.stringify(base.pts));
    await page.keyboard.press('KeyP');
    cleanText(await ev(() => T.bodyText()), '天赋页');
    const nodeCount = await ev(() => document.querySelectorAll('#tree-svg .tn').length);
    assert(nodeCount === Object.keys(await ev(() => Object.keys(G.TREE))).length, '天赋节点数量不对：' + nodeCount);
    const node = (id) => '#tree-svg [data-node="' + id + '"] .hit';
    await page.click(node('sk'), { force: true }); // 未连接的基石：不能点
    assert(!(await ev(() => G.save.passives.includes('sk'))), '未连接的天赋不应被点亮');
    await page.click(node('sm0'), { force: true });
    let r = await ev(() => ({ has: G.save.passives.includes('sm0'), life: G.player.maxLife, cls: document.querySelector('[data-node="sm0"]').getAttribute('class'), free: G.passivePoints().free }));
    assert(r.has && r.life === base.life + 15 && /alloc/.test(r.cls) && r.free === 10, '点亮体魄失败：' + JSON.stringify(r));
    await page.click(node('sm1'), { force: true });
    r = await ev(() => ({ has: G.save.passives.includes('sm1'), inc: G.skillCtx('cleave').inc.phys }));
    assert(r.has && r.inc === base.inc + 8, '点亮膂力后物理伤害加成没变');
    await page.click(node('sm0'), { force: true }); // 退回会断开 sm1：应被拒绝
    r = await ev(() => ({ has: G.save.passives.includes('sm0'), bad: !!document.querySelector('.tree-msg.bad') }));
    assert(r.has && r.bad, '退回会造成断连的天赋应被拒绝并提示');
    await page.click(node('sm1'), { force: true });
    r = await ev(() => ({ has: G.save.passives.includes('sm1'), inc: G.skillCtx('cleave').inc.phys, free: G.passivePoints().free }));
    assert(!r.has && r.inc === base.inc && r.free === 10, '退回膂力失败：' + JSON.stringify(r));
    await page.hover(node('dm0'), { force: true });
    r = await ev(() => ({ on: document.getElementById('tip').classList.contains('on'), txt: document.getElementById('tip').innerText }));
    assert(r.on && r.txt.includes('敏捷') && r.txt.includes('3%'), '天赋提示不对：' + r.txt);
    // 基石：以血为引（消耗生命而非魔力）
    for (const id of ['im0', 'im1', 'im2', 'im3', 'im4', 'im5', 'ik']) await page.click(node(id), { force: true });
    r = await ev(() => {
      const P = G.player;
      const out = { blood: P.S.bloodMagic, more: G.skillCtx('ember').more, free: G.passivePoints().free };
      T.arena();
      T.dummy(4, 0);
      G.input.mouse.wx = 4;
      G.input.mouse.wz = 0;
      const life0 = P.life, mana0 = P.mana;
      G.input.mouse.b[2] = true;
      G.debug.step(0.3);
      G.input.mouse.b[2] = false;
      out.lifeSpent = life0 - P.life;
      out.manaSame = P.mana === mana0;
      G.debug.step(1);
      out.hit = T.d.hp < T.d.maxHp;
      G.clearEnemies();
      return out;
    });
    assert(r.blood === 1 && Math.abs(r.more - 1.2) < 1e-9 && r.free === 3, '基石没有生效：' + JSON.stringify(r));
    assert(r.lifeSpent > 3 && r.manaSame && r.hit, '以血为引应消耗生命而非魔力：' + JSON.stringify(r));
    await ev(() => G.ui.refresh());
    await page.click('[data-act="tree-reset"]');
    assert((await ev(() => G.save.passives.length)) === 9, '重置应需要二次确认');
    await page.click('[data-act="tree-reset"]');
    r = await ev(() => ({ p: G.save.passives.slice(), life: G.player.maxLife, free: G.passivePoints().free, blood: G.player.S.bloodMagic }));
    assert(r.p.length === 1 && r.p[0] === 'start' && r.life === base.life && r.free === 11 && !r.blood, '重置天赋失败：' + JSON.stringify(r));
    // 没有点数时点不了
    r = await ev(() => {
      G.save.level = 1;
      const ok = G.allocPassive('sm0');
      G.save.level = 12;
      G.computeStats();
      return ok;
    });
    assert(r === false, '没有天赋点时不应点亮');
    await closePanel();
  });

  await step('多重投射 / 齐射：同一次施放不叠加命中同一目标；同一轮敌方弹幕只结算一次伤害', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state;
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.socketSupport('blade', 0, 'multi');
      G.bindSkill(1, 'blade');
      T.fix(0.5); // 随机装备上的附加元素伤害可能让靶子感电 / 着火，多算伤害：随机数钉死
      T.dummy(2.2, 0); // 贴脸：3 枚飞刃都会碰到它
      G.input.mouse.wx = P.x + 2.2;
      G.input.mouse.wz = P.z;
      const ctx = G.skillCtx('blade');
      const maxOne = ctx.base.phys[1] * (1 + ctx.inc.phys / 100) * ctx.moreType.phys * ctx.more * (ctx.critMulti / 100);
      G.input.tap[1] = 0.25;
      let maxProj = 0;
      for (let i = 0; i < 72; i++) {
        G.tick(1 / 60);
        maxProj = Math.max(maxProj, S.projectiles.length);
      }
      const out = { proj: ctx.proj, maxProj, dmg: T.d.maxHp - T.d.hp, maxOne };
      T.unfix();
      // 分散的目标：每个都会被打到
      G.clearEnemies();
      const ds = [];
      for (const a of [-0.21, 0, 0.21]) {
        const e = G.spawnMob('husk', P.x + Math.cos(a) * 5, P.z + Math.sin(a) * 5, 1, { awake: true });
        e.hp = e.maxHp = 1e6;
        e.freeze = 1e9;
        ds.push(e);
      }
      G.input.mouse.wx = P.x + 5;
      G.input.mouse.wz = P.z;
      G.input.tap[1] = 0.25;
      G.debug.step(1.2);
      out.spread = ds.filter((e) => e.hp < e.maxHp).length;
      G.socketSupport('blade', 0, null);
      // 掷焰 + 多重 / 贯穿 / 连锁 打挤在一起的 4 只：直击加爆炸，每只每次施放最多挨一下
      G.bindSkill(1, 'ember');
      const hitEnemy = G.hitEnemy;
      const hits = [];
      G.hitEnemy = function (e, c, m, inf) {
        if (!(inf && inf.proc)) hits.push(e); // 爆燃 / 电弧是异常值触发的额外伤害，不算这次施放的命中
        return hitEnemy(e, c, m, inf);
      };
      out.ember = {};
      for (const sups of [[], ['multi'], ['pierce'], ['chain'], ['multi', 'pierce', 'chain']]) {
        G.clearEnemies();
        G.save.sockets.ember = [null, null, null];
        sups.forEach((id, i) => G.socketSupport('ember', i, id));
        const pk = [[5, 0], [5.9, 0.9], [5.9, -0.9], [6.8, 0]].map((d) => {
          const e = G.spawnMob('husk', P.x + d[0], P.z + d[1], 1, { awake: true });
          e.hp = e.maxHp = 1e6;
          e.freeze = 1e9;
          return e;
        });
        hits.length = 0;
        P.mana = P.maxMana;
        G.input.mouse.wx = P.x + 5;
        G.input.mouse.wz = P.z;
        G.input.tap[1] = 0.25;
        G.debug.step(2);
        out.ember[sups.join('+') || 'none'] = pk.map((e) => hits.filter((h) => h === e).length);
      }
      G.hitEnemy = hitEnemy;
      G.save.sockets.ember = [null, null, null];
      G.bindSkill(1, 'blade');
      // 敌方齐射
      G.clearEnemies();
      G.debug.god(false);
      const shot = (n, volley) => {
        P.iframe = 0;
        P.life = P.maxLife;
        for (let i = 0; i < n; i++) G.spawnProjectile({ owner: 'e', x: P.x + 1.5, z: P.z + (i - (n - 1) / 2) * 0.12, dx: -1, dz: 0, speed: 10, r: 0.4, life: 2, dmg: 10, dtype: 'phys', volley });
        G.debug.step(0.5);
        return P.maxLife - P.life;
      };
      out.one = shot(1);
      out.volley = shot(5, 4242);
      out.loose = shot(3);
      out.left = S.projectiles.length;
      G.debug.god(true);
      P.life = P.maxLife;
      return out;
    });
    assert(r.proj === 3 && r.maxProj === 3, '多重投射应发射 3 枚：' + JSON.stringify(r));
    assert(r.dmg > 0 && r.dmg <= r.maxOne + 1e-6, '贴脸的 3 枚投射物叠加命中了同一个敌人：伤害 ' + r.dmg.toFixed(1) + '，单发上限 ' + r.maxOne.toFixed(1));
    assert(r.spread === 3, '分散的 3 个目标应各被命中一次，实际 ' + r.spread);
    for (const k of Object.keys(r.ember)) {
      assert(r.ember[k].length === 4 && r.ember[k].every((n) => n === 1), '掷焰（' + k + '）打 4 只挤在一起的怪，每只应正好挨 1 下，实际 ' + r.ember[k].join(' / '));
    }
    assert(r.one > 0 && Math.abs(r.volley - r.one) < 1e-6, '同一轮齐射应只结算一次：单发 ' + r.one + '，齐射 ' + r.volley);
    assert(Math.abs(r.loose - 3 * r.one) < 1e-6 && r.left === 0, '不同轮次的投射物应各自结算：' + JSON.stringify(r));
  });

  // ------------------------------------------------------------------ 动作战斗（v2-C）：连击 / 缓冲 / 受击反馈 / 架势 / 处决
  await uiStep('连击：裂石击三段动作、范围、伤害各不相同，终结技更重、击退更远、顿帧更长；停手、翻滚或换技能后从头再来；辅助宝石对每一段生效；连击计数与连段指示', async () => {
    const r = await ev(() => {
      T.lane();
      G.debug.god(true);
      const P = G.player, S = G.state, W = G.world;
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.bindSkill(0, 'cleave');
      G.bindSkill(1, 'ember');
      G.computeStats();
      const out = { walk: W.walkable(P.x + 7.4, P.z, 1), x0: P.x };
      T.fix(0.5); // 不暴击、伤害取中值：三段之间只差倍率
      const A = T.mob('husk', 2.6, 0); // 正前方
      const F = T.mob('husk', 6.6, 0); // 更远：扇形够不着，只有跃劈的落点能盖到
      const ctx = G.skillCtx('cleave');
      const mid = G.calcHit(ctx, 1).total; // 随机数钉死后的一次标准命中（含装备附加的各类伤害）
      out.steps = [];
      const st0 = Object.assign({}, S.stats);
      for (let i = 0; i < 4; i++) {
        const a0 = A.hp, f0 = F.hp, px = P.x;
        const s = T.swing(A);
        s.dmgA = a0 - A.hp;
        s.dmgF = f0 - F.hp;
        s.kv = Math.hypot(A.kvx, A.kvz);
        s.mult = s.dmgA / mid;
        s.px = px;
        s.castDur = P.cast ? P.cast.dur : 0;
        s.cancelT = P.cast ? P.cast.cancelT : 0;
        out.steps.push(s);
      }
      out.fin = S.stats.finishers - st0.finishers;
      out.hits = S.stats.hits - st0.hits;
      out.chain = P.chain.n;
      out.moved = P.x - out.x0;
      out.comboData = G.SKILLS.cleave.combo.map((c) => ({ mult: c.mult, stop: c.stop, clip: c.clip, time: c.time }));
      out.speed = ctx.speed;
      out.stopK = ctx.stopK;
      // 第 4 次出手是新一轮的第一段：现在连段应该指向第二段
      out.stepAfter = P.combo.step;
      return out;
    });
    assert(r.walk, '测试场地不够宽');
    const s = r.steps;
    assert(s.every((x) => x.fired), '按住左键没有连续打出四次：' + JSON.stringify(s));
    assert(s.map((x) => x.step).join() === '0,1,2,0', '连段顺序应为 0,1,2,0，实际 ' + s.map((x) => x.step).join());
    assert(s.map((x) => x.clip).join() === 'attack1,attack2,attack3,attack1', '三段应各用各的动作：' + s.map((x) => x.clip).join());
    for (let i = 0; i < 3; i++) {
      assert(Math.abs(s[i].mult - r.comboData[i].mult) < 0.01, '第 ' + (i + 1) + ' 段伤害倍率应为 ' + r.comboData[i].mult + '，实际 ' + s[i].mult.toFixed(3));
      assert(Math.abs(s[i].stop * 1000 - r.comboData[i].stop * r.stopK) < 0.5, '第 ' + (i + 1) + ' 段顿帧应为 ' + (r.comboData[i].stop * r.stopK).toFixed(1) + ' 毫秒（基础 ' + r.comboData[i].stop + ' × 出手速度系数 ' + r.stopK.toFixed(3) + '），实际 ' + (s[i].stop * 1000).toFixed(1));
    }
    assert(s[2].mult > s[0].mult * 2 && s[2].mult > s[1].mult * 2, '终结技的伤害应明显更高');
    assert(s[2].kv > s[0].kv * 3 && s[2].kv > s[1].kv * 3 && s[0].kv > 1, '终结技的击退应远大于前两段：' + s.map((x) => x.kv.toFixed(1)).join(' / '));
    assert(s[0].dmgF === 0 && s[1].dmgF === 0 && s[2].dmgF > 0, '远处的敌人应只被第三段（跃劈的落点）打到：' + s.map((x) => x.dmgF.toFixed(0)).join(' / '));
    assert(r.moved > 0.8, '出手时应朝准星踏步前冲，实际位移 ' + r.moved.toFixed(2));
    assert(r.fin === 1 && r.hits === 5 && r.chain === 5, '命中统计不对：' + JSON.stringify({ fin: r.fin, hits: r.hits, chain: r.chain }));
    assert(r.stepAfter === 1, '第四次出手后连段应指向第二段');
    // 连段节奏：按住时每段的间隔 ≈ 段长（+ 上一段的顿帧）
    const gap1 = s[1].ticks / 60, want1 = r.comboData[0].time / r.speed + r.comboData[0].stop / 1000;
    assert(Math.abs(gap1 - want1) < 0.06, '第一、二段之间的间隔应约为 ' + want1.toFixed(2) + ' 秒，实际 ' + gap1.toFixed(2));

    // HUD：连击计数、技能格上的连段指示
    await frames(3);
    await until(() => +getComputedStyle(document.getElementById('combo')).opacity > 0.9).catch(() => {
      throw new Error('连击计数没有显示出来');
    });
    let h = await ev(() => ({
      on: document.getElementById('combo').classList.contains('on'), n: document.getElementById('combo-n').textContent,
      pips: document.querySelectorAll('#slots .slot.has-combo .s-combo i').length, lit: document.querySelectorAll('#slots .slot.has-combo .s-combo i.on').length,
      slot: document.querySelector('#slots .slot.has-combo').dataset.skill, vis: +getComputedStyle(document.getElementById('combo')).opacity > 0.3,
      box: T.rect('#combo'), w: innerWidth, h: innerHeight,
    }));
    assert(h.on && h.n === '5' && h.vis, '连击计数没有显示 5：' + JSON.stringify(h));
    assert(h.box.r <= h.w && h.box.l > h.w * 0.7 && h.box.t > 190 && h.box.b < h.h - 200, '连击计数的位置不对（应在右侧中部，不压小地图和血球）：' + JSON.stringify(h.box));
    assert(h.slot === 'cleave' && h.pips === 3 && h.lit === 1, '技能格上的连段指示不对：' + JSON.stringify(h));

    // 窗口内再按接下一段；停手太久从头再来；翻滚、换技能也会重置
    const q = await ev(() => {
      const P = G.player, S = G.state, W = G.world;
      const out = {};
      const A = S.enemies.find((e) => !e.dead);
      const tap = () => { const s = T.swing(A); return s.step; };
      G.debug.step(1.6); // 等上一轮的窗口过去
      out.fresh = P.combo.step;
      out.a = tap(); // 0
      G.debug.step(0.55); // 这一段结束（0.19）后再等 0.36：还在 0.55 秒的窗口内
      out.b = tap(); // 1
      G.debug.step(1.3); // 超出窗口
      out.c = tap(); // 0
      // 连击计数 2.5 秒后清零
      out.chain0 = P.chain.n;
      G.debug.step(2.4);
      out.chain1 = P.chain.n;
      G.debug.step(0.3);
      out.chain2 = P.chain.n;
      // 翻滚重置
      tap();
      const st1 = P.combo.step;
      P.roll.cd = 0;
      G.dodge();
      out.afterRoll = [st1, P.combo.step];
      G.debug.step(0.5);
      out.d = tap(); // 0
      // 换技能重置
      const st2 = P.combo.step;
      P.mana = P.maxMana;
      G.input.tap[1] = 0.3;
      for (let i = 0; i < 40 && !(P.cast && P.cast.id === 'ember' && P.cast.fired); i++) { T.aim(A.x, A.z); G.tick(1 / 60); }
      out.ember = !!(P.cast && P.cast.id === 'ember');
      out.afterSkill = [st2, P.combo.step];
      G.debug.step(0.6);
      // 辅助宝石对每一段都生效：蛮力（物理 +35%）、迅捷（速度 +25%）
      T.fix(0.5);
      const dmg = (st) => { const h0 = A.hp; T.aim(A.x, A.z); P.x = A.x - 2; P.z = A.z; G.execSkill(G.skillCtx('cleave'), G.SKILLS.cleave.combo[st]); return h0 - A.hp; };
      const base = [dmg(0), dmg(1), dmg(2)];
      const dur0 = G.skillCtx('cleave').time;
      const unit0 = G.calcHit(G.skillCtx('cleave'), 1).total;
      G.socketSupport('cleave', 0, 'brutal');
      G.socketSupport('cleave', 1, 'haste');
      const sup = [dmg(0), dmg(1), dmg(2)];
      out.ratio = sup.map((v, i) => v / base[i]);
      out.wantRatio = G.calcHit(G.skillCtx('cleave'), 1).total / unit0; // 纯物理时正好 1.35；装备带元素附伤时略低
      out.durRatio = G.skillCtx('cleave').time / dur0;
      G.debug.step(0.3);
      const s = T.swing(A);
      out.hasteHit = P.cast ? P.cast.fireT : 0;
      out.hitData = G.SKILLS.cleave.combo[s.step].hit;
      out.speed = G.skillCtx('cleave').speed;
      T.unfix();
      G.debug.step(3);
      return out;
    });
    assert(q.fresh === 0 && q.a === 0 && q.b === 1 && q.c === 0, '连段窗口不对（应为 0 → 窗口内 1 → 超时回到 0）：' + JSON.stringify(q));
    assert(q.chain0 > 0 && q.chain1 > 0 && q.chain2 === 0, '连击计数应在 2.5 秒没有命中后清零：' + JSON.stringify([q.chain0, q.chain1, q.chain2]));
    assert(q.afterRoll[0] === 1 && q.afterRoll[1] === 0 && q.d === 0, '翻滚应让连段从头再来：' + JSON.stringify(q.afterRoll));
    assert(q.ember && q.afterSkill[0] === 1 && q.afterSkill[1] === 0, '换用别的技能应让连段从头再来：' + JSON.stringify(q.afterSkill));
    assert(q.wantRatio > 1.1 && q.wantRatio < 1.36 && q.ratio.every((v) => Math.abs(v - q.wantRatio) < 0.005), '蛮力（物理 +35%）应让三段同样受益：' + q.ratio.map((v) => v.toFixed(3)).join(' / ') + '，应为 ' + q.wantRatio.toFixed(3));
    assert(Math.abs(q.durRatio - 0.8) < 0.01 && Math.abs(q.hasteHit - q.hitData / q.speed) < 1e-6 && q.speed > 1.2, '迅捷应加快每一段的出手：' + JSON.stringify(q));
    await frames(3);
    h = await ev(() => ({ on: document.getElementById('combo').classList.contains('on'), lit: document.querySelectorAll('#slots .slot.has-combo .s-combo i.on').length }));
    assert(!h.on && h.lit === 0, '停手之后连击计数和连段指示应收起：' + JSON.stringify(h));
    return '倍率 ' + s.slice(0, 3).map((x) => x.mult.toFixed(2)).join(' / ') + '，顿帧 ' + s.slice(0, 3).map((x) => Math.round(x.stop * 1000)).join(' / ') + ' ms，击退初速 ' + s.slice(0, 3).map((x) => x.kv.toFixed(1)).join(' / ');
  });

  await uiStep('输入缓冲与翻滚取消：动作途中按下的技能 / 攻击 / 翻滚在能出手的瞬间放出，过期作废；翻滚取消起手（不出伤害）和收招；缓冲的输入不会在死亡后或面板打开后放出', async () => {
    const aim = async () => {
      const p = await ev(() => T.scr(G.player.x + 4, G.player.z));
      await page.mouse.move(Math.round(p.x), Math.round(p.y));
      await frames(2);
    };
    await ev(() => {
      T.arena();
      G.debug.god(true);
      G.bindSkill(0, 'cleave');
      G.bindSkill(1, 'ember');
      G.bindSkill(2, 'arc');
      G.bindSkill(3, null);
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.computeStats();
      T.mob('husk', 2.4, 0);
      T.settle();
    });
    await aim();
    // 1. 挥砍途中按 Q：收招一到可取消的时刻就放出链雷
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })));
    let r = await ev(() => { for (let i = 0; i < 6; i++) G.tick(1 / 60); const c = G.player.cast; return { id: c && c.id, step: c && c.step, t: c && c.t, cancelT: c && c.cancelT, fireT: c && c.fireT }; });
    assert(r.id === 'cleave' && r.step === 0 && r.t < r.fireT, '点击左键没有开始第一段：' + JSON.stringify(r));
    await page.keyboard.press('KeyQ');
    let b = await ev(() => {
      const P = G.player;
      const c0 = P.cast, tap = G.input.tap[2];
      let at = -1, mana0 = P.mana;
      for (let i = 0; i < 60 && at < 0; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'arc') at = c0.t; }
      for (let i = 0; i < 40; i++) G.tick(1 / 60);
      return { tap, at, cancelT: c0.cancelT, dur: c0.dur, spent: mana0 - P.mana, held: !!G.input.keys.KeyQ };
    });
    assert(b.tap > 0.2 && !b.held, '按下 Q 应记入缓冲：' + JSON.stringify(b));
    assert(b.at >= b.cancelT - 1e-6 && b.at < b.cancelT + 0.06 && b.at < b.dur - 0.05 && b.spent > 5, '缓冲的链雷应在挥砍可取消的那一刻（' + b.cancelT.toFixed(2) + ' 秒）放出，实际 ' + b.at.toFixed(2) + '：' + JSON.stringify(b));
    // 2. 终结技刚起手（+0.05 秒）就轻点 Q：缓冲要活到终结技可以接招的那一刻（0.62 秒）。
    //    回归：缓冲曾是固定的 0.3 秒，终结技和法术前半段轻点的按键会被悄悄吃掉
    r = await ev(() => {
      const P = G.player;
      G.debug.step(1.5);
      P.combo.step = 2; // 直接出终结技：0.62 秒后才能接别的动作
      G.input.tap[0] = 0.3;
      for (let i = 0; i < 3; i++) G.tick(1 / 60);
      return { step: P.cast && P.cast.step, cancelT: P.cast && P.cast.cancelT, t: P.cast && P.cast.t, buf: G.BUFFER };
    });
    assert(r.step === 2 && r.cancelT > r.buf + 0.2 && r.t < 0.07, '没有进入终结技：' + JSON.stringify(r));
    await page.keyboard.press('KeyQ');
    r = await ev(() => {
      const P = G.player;
      const c0 = P.cast, tap = G.input.tap[2], m0 = P.mana;
      let at = -1;
      for (let i = 0; i < 90 && at < 0; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'arc') at = c0.t; }
      for (let i = 0; i < 40; i++) G.tick(1 / 60);
      return { tap, at, cancelT: c0.cancelT, spent: m0 - P.mana, want: G.bufferTime('cast') };
    });
    assert(r.tap > r.cancelT - 0.06 && r.tap < 0.9, '终结技途中按下的输入，缓冲应覆盖到它可以接招为止：' + JSON.stringify(r));
    assert(r.at >= r.cancelT - 1e-6 && r.at < r.cancelT + 0.06 && r.spent > 5, '终结技起手时轻点的链雷应在可接招的那一刻放出：' + JSON.stringify(r));
    assert(Math.abs(r.want - 0.3) < 1e-6, '手上没有动作时缓冲应回到 0.3 秒：' + r.want);
    //    掷焰（法术）途中轻点 Q 也一样
    await ev(() => { G.debug.step(1); G.player.mana = G.player.maxMana; });
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'right' });
    r = await ev(() => { for (let i = 0; i < 2; i++) G.tick(1 / 60); const c = G.player.cast; return { id: c && c.id, t: c && c.t }; });
    assert(r.id === 'ember' && r.t < 0.06, '右键没有开始掷焰：' + JSON.stringify(r));
    await page.keyboard.press('KeyQ');
    r = await ev(() => { const P = G.player; let nova = false; for (let i = 0; i < 70; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'arc') nova = true; } return { nova }; });
    assert(r.nova, '掷焰起手时轻点的链雷被吃掉了');
    //    等不到的输入照样过期：技能还在冷却、离转好还远
    await ev(() => { const P = G.player; G.debug.step(1); P.mana = P.maxMana; P.cds.arc = 2; P.cdMax.arc = 2; });
    await page.keyboard.press('KeyQ');
    r = await ev(() => { const P = G.player; const tap = G.input.tap[2], m0 = P.mana; let nova = false; for (let i = 0; i < 200; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'arc') nova = true; } return { tap, nova, cd: P.cds.arc, spent: m0 - P.mana }; });
    assert(r.tap > 0.2 && r.tap < 0.35 && !r.nova && r.cd === 0, '过期的缓冲不应再放出技能：' + JSON.stringify(r));
    //    挥砍途中按了 Q 又翻滚：翻滚之前缓冲着的技能作废，滚完不会突然放出来
    await ev(() => { const P = G.player; P.mana = P.maxMana; P.roll.cd = 0; });
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })));
    await ev(() => { for (let i = 0; i < 4; i++) G.tick(1 / 60); });
    await page.keyboard.press('KeyQ');
    r = await ev(() => ({ tap: G.input.tap[2], cast: G.player.cast && G.player.cast.id }));
    assert(r.tap > 0.2 && r.cast === 'cleave', '挥砍途中按 Q 应记入缓冲：' + JSON.stringify(r));
    await page.keyboard.press('Space');
    r = await ev(() => { const P = G.player; const o = { tap: G.input.tap[2], roll: P.roll.t > 0 }; let nova = false; for (let i = 0; i < 80; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'arc') nova = true; } o.nova = nova; return o; });
    assert(r.roll && r.tap === 0 && !r.nova, '翻滚应清掉之前缓冲的技能输入：' + JSON.stringify(r));
    // 3. 翻滚途中点攻击：滚完立刻出手
    await ev(() => { G.player.roll.cd = 0; });
    await page.keyboard.press('Space');
    await ev(() => { for (let i = 0; i < 6; i++) G.tick(1 / 60); });
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })));
    r = await ev(() => {
      const P = G.player;
      const rolling = P.roll.t > 0, cast0 = !!P.cast;
      let at = -1;
      for (let i = 0; i < 40 && at < 0; i++) { G.tick(1 / 60); if (P.cast) at = P.roll.t; }
      return { rolling, cast0, at, id: P.cast && P.cast.id };
    });
    assert(r.rolling && !r.cast0 && r.id === 'cleave' && r.at <= 0 && r.at > -0.04, '翻滚途中按下的攻击应在翻滚结束的那一帧放出：' + JSON.stringify(r));
    // 4. 翻滚冷却快好时按空格：冷却一到就滚；离得还远则作废
    await ev(() => { const P = G.player; G.debug.step(1.2); P.roll.cd = 0.2; P.roll.cdMax = 0.9; });
    await page.keyboard.press('Space');
    r = await ev(() => {
      const P = G.player;
      const now = P.roll.t > 0, tap = G.input.tapDodge;
      let at = -1;
      for (let i = 0; i < 30 && at < 0; i++) { G.tick(1 / 60); if (P.roll.t > 0) at = (i + 1) / 60; }
      G.debug.step(0.6);
      P.roll.cd = 0.7;
      return { now, tap, at };
    });
    assert(!r.now && r.tap > 0.2 && r.at > 0.17 && r.at < 0.26, '缓冲的翻滚应在冷却结束时放出：' + JSON.stringify(r));
    await page.keyboard.press('Space');
    r = await ev(() => { const P = G.player; let rolled = false; for (let i = 0; i < 60; i++) { G.tick(1 / 60); if (P.roll.t > 0) rolled = true; } return { rolled }; });
    assert(!r.rolled, '离冷却结束还远时按下的翻滚应过期作废');
    // 5. 翻滚取消起手：不出伤害；取消收招：立刻能动
    await ev(() => { G.debug.step(0.5); G.player.roll.cd = 0; });
    await aim();
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })));
    r = await ev(() => { const P = G.player, e = G.state.enemies[0]; T.aim(e.x, e.z); for (let i = 0; i < 5; i++) G.tick(1 / 60); return { id: P.cast && P.cast.id, fired: P.cast && P.cast.fired, hp: e.hp }; });
    assert(r.id === 'cleave' && r.fired === false, '没有进入起手：' + JSON.stringify(r));
    await page.keyboard.press('Space');
    let c = await ev((hp) => {
      const P = G.player, e = G.state.enemies[0], W = G.world;
      const o = { roll: P.roll.t > 0, cast: !!P.cast, clip: W.clipOf(P.ent), step: P.combo.step };
      G.debug.step(0.8);
      o.dmg = hp - e.hp;
      P.roll.cd = 0;
      return o;
    }, r.hp);
    assert(c.roll && !c.cast && c.clip === 'roll' && c.step === 0 && c.dmg === 0, '翻滚应取消起手且不出伤害：' + JSON.stringify(c));
    await aim();
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })));
    r = await ev(() => { const P = G.player, e = G.state.enemies[0]; const s = T.swing(e); for (let i = 0; i < 4; i++) G.tick(1 / 60); return { fired: P.cast && P.cast.fired, t: P.cast && P.cast.t, cancelT: P.cast && P.cast.cancelT }; });
    assert(r.fired && r.t < r.cancelT, '应处在收招阶段：' + JSON.stringify(r));
    await page.keyboard.press('Space');
    c = await ev(() => { const P = G.player; const o = { roll: P.roll.t > 0, cast: !!P.cast }; G.debug.step(1); P.roll.cd = 0; return o; });
    assert(c.roll && !c.cast, '翻滚应取消收招：' + JSON.stringify(c));
    // 6. 缓冲的输入不会带进打开的面板
    await aim();
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })));
    await ev(() => { for (let i = 0; i < 4; i++) G.tick(1 / 60); });
    await page.keyboard.press('Space');
    await page.keyboard.press('KeyQ'); // 翻滚途中按下：留到滚完再出
    assert(await ev(() => G.player.roll.t > 0 && G.input.tap[2] > G.player.roll.t), '缓冲没有记下');
    await page.keyboard.press('KeyI');
    await frames(3);
    await page.keyboard.press('Escape');
    r = await ev(() => {
      const P = G.player;
      const o = { tap: G.input.tap.join(), dodge: G.input.tapDodge, exec: G.input.tapExec };
      const m0 = P.mana;
      let nova = false;
      for (let i = 0; i < 70; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'arc') nova = true; }
      o.nova = nova;
      o.spent = m0 - P.mana;
      return o;
    });
    assert(r.tap === '0,0,0,0,0' && r.dodge === 0 && r.exec === 0 && !r.nova && r.spent <= 0, '打开面板后缓冲的输入应全部清空：' + JSON.stringify(r));
    // 7. 也不会在死亡后放出
    r = await ev(() => {
      const P = G.player;
      G.debug.step(0.5);
      G.debug.god(false);
      P.iframe = 0;
      P.roll.cd = 0.25;
      G.input.tap[0] = 0.3;
      G.input.tap[2] = 0.3;
      G.input.tapDodge = 0.3;
      G.input.tapExec = 0.3;
      G.hitStop(120);
      G.slowMo(0.3, 0.6);
      G.hurtPlayer(1e9, 'phys');
      const o = { dead: P.dead, tap: G.input.tap.join(), dodge: G.input.tapDodge, exec: G.input.tapExec, stop: G.flow.stop, slow: G.flow.slow, k: G.flow.k };
      let acted = false;
      for (let i = 0; i < 180; i++) { G.tick(1 / 60); if (P.cast || P.roll.t > 0 || P.exec) acted = true; }
      o.acted = acted;
      o.alive = !P.dead;
      G.debug.god(true);
      return o;
    });
    assert(r.dead && r.tap === '0,0,0,0,0' && r.dodge === 0 && r.exec === 0, '倒下时应清空缓冲的输入：' + JSON.stringify(r));
    assert(r.stop === 0 && r.slow === 0 && r.k === 1, '倒下时顿帧 / 慢动作应一并结束：' + JSON.stringify(r));
    assert(r.alive && !r.acted, '重生后不应自动放出死前缓冲的动作：' + JSON.stringify(r));
    return '链雷在 ' + b.at.toFixed(2) + ' 秒接上（可取消时刻 ' + b.cancelT.toFixed(2) + '）';
  });

  await step('受击反馈：每次命中都有闪白 / 后仰 / 火花 / 数字，暴击与终结的数字另成一类；击退会撞墙，首领不被推动；重击打断小怪起手（过了收不住的时刻、皮糙肉厚的、精英除外）；死法随致命伤害类型', async () => {
    const r = await ev(() => {
      const P = G.player, S = G.state, W = G.world;
      const out = {};
      const fin = G.SKILLS.cleave.combo[2];
      const smash = () => G.execSkill(G.skillCtx('cleave'), fin);
      const place = (x, z) => { T.arena(); G.debug.god(true); T.tp(x, z); };
      G.bindSkill(0, 'cleave');
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.computeStats();

      // ---- 一次命中触发了哪些反馈 ----
      T.arena();
      G.debug.god(true);
      const calls = {};
      const names = ['flash', 'hitReact', 'impact', 'shudder', 'punch', 'text', 'fovKick'];
      const orig = {};
      for (const n of names) {
        orig[n] = W[n];
        W[n] = function () { (calls[n] = calls[n] || []).push(Array.prototype.slice.call(arguments)); return orig[n].apply(W, arguments); };
      }
      let A = T.mob('husk', 2.4, 0);
      T.fix(0.5);
      T.swing(A);
      out.light = { flash: (calls.flash || []).length, react: (calls.hitReact || []).length, impact: (calls.impact || []).length, shudder: (calls.shudder || []).length, punch: (calls.punch || []).length, text: (calls.text || []).map((a) => (a[5] && a[5].kind) || 'plain') };
      out.reactAng = calls.hitReact[0][1]; // 顺着这一击的方向（朝 +x，略带切向）
      out.impactType = calls.impact[0][4];
      for (const n of names) calls[n] = [];
      T.fix(0); // 必定暴击
      T.swing(A);
      out.crit = { text: calls.text.map((a) => (a[5] && a[5].kind) || 'plain'), str: calls.text.map((a) => a[2]), size: calls.text.map((a) => a[4]), impactCrit: calls.impact[0][6] };
      for (const n of names) calls[n] = [];
      T.fix(0.5);
      T.swing(A);
      out.fin = { text: calls.text.map((a) => (a[5] && a[5].kind) || 'plain'), fov: (calls.fovKick || []).length, flashK: calls.flash[0][1], impactW: calls.impact[0][5] };
      for (const n of names) W[n] = orig[n];
      G.debug.step(1);

      // ---- 击退：空地上滑出去，贴墙时被墙挡住 ----
      const c0 = S.zone.circles[0];
      place(c0.x, c0.z);
      A = T.mob('husk', 2.2, 0);
      T.aim(A.x + 3, A.z);
      const ax = A.x;
      smash();
      G.debug.step(1);
      out.open = A.x - ax;
      // 贴墙：朝背向通道出口的方向打（区域布局是随机的，那一侧一定是完整的弧形墙），怪离墙只有 1.2
      const c1 = S.zone.circles[1];
      const back = Math.atan2(c0.x - c1.x, c0.z - c1.z);
      const ux = Math.sin(back), uz = Math.cos(back);
      place(c0.x + ux * (c0.r - 3.2), c0.z + uz * (c0.r - 3.2));
      A = T.mob('husk', ux * 2.0, uz * 2.0);
      T.aim(A.x + ux * 3, A.z + uz * 3);
      const bx = A.x, bz = A.z;
      smash();
      let ok = true;
      for (let i = 0; i < 60; i++) { G.tick(1 / 60); if (!W.walkable(A.x, A.z, 0)) ok = false; }
      // 怪的碰撞半径约 0.44：最多还能往外挪 1.2 − 0.44
      out.wall = { moved: (A.x - bx) * ux + (A.z - bz) * uz, ok, room: 1.2 - A.r * 0.8, kv: Math.hypot(A.kvx, A.kvz), edge: c0.r - Math.hypot(A.x - c0.x, A.z - c0.z) };

      // ---- 首领不被推动；冻住的靶子几乎不动 ----
      place(c0.x, c0.z);
      const B = G.spawnBoss('golem', P.x + 3.4, P.z, 1);
      B.awake = B.wasAwake = true;
      B.cd = 1e9;
      const bx0 = B.x;
      T.aim(B.x, B.z);
      smash();
      G.debug.step(0.5);
      out.boss = { moved: Math.abs(B.x - bx0), kv: Math.hypot(B.kvx, B.kvz) };

      // ---- 打断 ----
      const wind = (type, elite, wait) => {
        place(c0.x, c0.z);
        G.debug.god(false);
        P.life = P.maxLife;
        const e = G.spawnMob(type, P.x + (type === 'brute' ? 2.4 : 1.4), P.z, 1, { awake: true, elite });
        e.wasAwake = true;
        e.atkCd = 0;
        e.hp = e.maxHp = 1e6;
        let t = 0;
        while (e.state !== 'windup' && e.state !== 'fuse' && t < 3) { G.tick(1 / 60); t += 1 / 60; }
        if (e.state !== 'windup' && e.state !== 'fuse') return { started: false };
        while (e.stateT > e.def.windup * wait) G.tick(1 / 60);
        const tel0 = S.telegraphs.filter((q) => q.owner === e).length;
        T.aim(e.x, e.z);
        P.iframe = 0;
        smash();
        const o = { started: true, state: e.state, stag: e.stagT, tel0, tel: S.telegraphs.filter((q) => q.owner === e).length, cd: e.atkCd };
        const life0 = P.life;
        // soon：原本那一下该落下的时间窗（半秒）；之后的是它重新起手打出来的
        let dead = false;
        for (let i = 0; i < 120; i++) {
          G.tick(1 / 60);
          if (e.dead) dead = true;
          if (i === 29) {
            o.hurtSoon = life0 - P.life;
            o.deadSoon = dead;
          }
        }
        o.hurt = life0 - P.life;
        o.dead = dead;
        G.debug.god(true);
        return o;
      };
      // 随机数继续钉在 0.5：测试角色的装备可能带冰 / 火附伤，不能让随机的冻结、点燃搅进来
      out.cutHusk = wind('husk', false, 0.75); // 起手刚开始：能打断
      out.lateHusk = wind('husk', false, 0.2); // 快出手了：收不住
      out.cutBomb = wind('bomber', false, 0.7);
      out.brute = wind('brute', false, 0.75); // 皮糙肉厚：打断不了
      out.elite = wind('husk', true, 0.75); // 精英：靠架势，不吃打断

      T.unfix();
      // ---- 死法：致命伤害的类型、过量击杀、地上的痕迹 ----
      place(c0.x, c0.z);
      const dies = [], decs = [];
      const od = W.die, oc = W.decal;
      W.die = function (ent, o) { dies.push(o ? { type: o.type, over: o.over, force: o.force } : null); return od.apply(W, arguments); };
      W.decal = function (kind) { decs.push(kind); return oc.apply(W, arguments); };
      const kill = (skill, hp, mult) => {
        const e = G.spawnMob('husk', P.x + 3, P.z, 1, { awake: true });
        e.atkCd = 1e9;
        e.hp = hp;
        G.hitEnemy(e, G.skillCtx(skill), mult);
        return e.dead;
      };
      out.kills = [kill('cleave', 0.001, 0.01), kill('ember', 0.001, 0.01), kill('nova', 0.001, 0.01), kill('arc', 0.001, 0.01), kill('cleave', 30, 50)];
      const n0 = decs.length;
      G.debug.step(2.2);
      W.die = od;
      W.decal = oc;
      out.dies = dies;
      out.decals = decs.slice(n0).sort().join();
      out.left = S.enemies.length;
      T.arena();
      T.clearLoot();
      return out;
    });
    const L = r.light;
    assert(L.flash === 1 && L.react === 1 && L.impact === 1 && L.shudder >= 2 && L.punch === 1 && L.text.join() === 'plain', '一次轻击应有闪白 / 后仰 / 火花 / 抖动 / 镜头顶一下 / 数字：' + JSON.stringify(L));
    assert(r.impactType === 'phys' && Math.abs(r.reactAng - (Math.PI / 2 + 0.4)) < 0.25, '受击方向应顺着这一击（朝右、略带刀势）：' + r.reactAng.toFixed(2));
    assert(r.crit.text.join() === 'crit' && /!$/.test(r.crit.str[0]) && r.crit.size[0] > 20 && r.crit.impactCrit === true, '暴击数字应另成一类（更大、带叹号）：' + JSON.stringify(r.crit));
    assert(r.fin.text.join() === 'big' && r.fin.fov === 1 && r.fin.flashK > 2 && r.fin.impactW === 2, '终结技应有大数字、视角推近和更强的闪白：' + JSON.stringify(r.fin));
    assert(r.open > 2.2 && r.open < 4, '终结技在空地上应把小怪推开 3 左右，实际 ' + r.open.toFixed(2));
    assert(r.wall.ok && r.wall.moved < r.open - 0.6 && r.wall.moved <= r.wall.room + 0.15 && r.wall.edge > 0.3 && r.wall.kv === 0, '击退应被墙挡住，不会把怪推出场地：' + JSON.stringify(r.wall));
    assert(r.boss.moved < 1e-6 && r.boss.kv === 0, '首领不应被击退：' + JSON.stringify(r.boss));
    for (const k of ['cutHusk', 'lateHusk', 'cutBomb', 'brute', 'elite']) assert(r[k].started, k + '：没有等到起手');
    assert(r.cutHusk.state === 'idle' && r.cutHusk.stag > 0.3 && r.cutHusk.hurtSoon === 0, '终结技应打断游魂刚开始的起手：' + JSON.stringify(r.cutHusk));
    assert(r.lateHusk.state === 'windup' && r.lateHusk.hurt > 0, '起手快结束时已经收不住，应照常打出来：' + JSON.stringify(r.lateHusk));
    assert(r.cutBomb.state === 'idle' && r.cutBomb.tel0 === 1 && r.cutBomb.tel === 0 && !r.cutBomb.deadSoon && r.cutBomb.hurtSoon === 0, '终结技应打断爆裂虫的引信并取消预警圈：' + JSON.stringify(r.cutBomb));
    assert(r.brute.state === 'windup' && r.brute.tel === 1 && r.brute.hurt > 0, '巨躯皮糙肉厚，砸地不应被打断：' + JSON.stringify(r.brute));
    assert(r.elite.state === 'windup' && r.elite.hurt > 0, '精英不吃打断：' + JSON.stringify(r.elite));
    assert(r.kills.every(Boolean) && r.dies.map((d) => d.type).join() === 'phys,fire,cold,light,phys', '尸体的死法应跟着致命伤害的类型：' + JSON.stringify(r.dies));
    assert(r.dies[4].over > 1.5 && r.dies[4].force > r.dies[0].force * 1.5 && r.dies[0].over < 0.1, '过量击杀应飞得更远：' + JSON.stringify([r.dies[0], r.dies[4]]));
    assert(r.decals === '1,2,3,4,4', '尸体消散时应在地上留下对应的痕迹（焦 / 霜 / 电 / 灰）：' + r.decals);
    assert(r.left === 0, '尸体没有清理干净');
    return '空地击退 ' + r.open.toFixed(2) + '，贴墙 ' + r.wall.moved.toFixed(2);
  });

  await uiStep('顿帧与慢动作：整个世界一起定格 / 放慢，计时器、预警圈、冷却、敌人出手互不错位；面板打开时不走', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, S = G.state, W = G.world, F = G.flow;
      G.bindSkill(0, 'cleave');
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.computeStats();
      const out = {};
      const A = T.mob('husk', 2.4, 0);
      T.fix(0.5);
      // 四个同样时长的东西：计时器、友方预警圈、技能冷却、另一只怪的引信
      const run = (hit) => {
        const DUR = 1.5;
        const ev = {};
        let ticks = 0;
        const t0 = S.time;
        G.after(DUR, () => { ev.timer = ticks; });
        G.telegraph({ shape: 'circle', x: P.x - 6, z: P.z, r: 1, dur: DUR, friendly: true, onFire() { ev.tele = ticks; } });
        P.cds.meteor = DUR;
        const st0 = S.stats.hits;
        let frozen = 0, stopSum = 0;
        while (ticks < 400 && (ev.timer === undefined || ev.tele === undefined || ev.cd === undefined)) {
          if (hit) { T.aim(A.x, A.z); G.input.mouse.b[0] = true; }
          const tm = S.time;
          G.tick(1 / 60);
          ticks++;
          if (S.time === tm) frozen++;
          if (ev.cd === undefined && !(P.cds.meteor > 0)) ev.cd = ticks;
        }
        G.input.mouse.b[0] = false;
        ev.ticks = ticks;
        ev.frozen = frozen;
        ev.game = S.time - t0;
        ev.hits = S.stats.hits - st0;
        G.debug.step(1.2);
        return ev;
      };
      out.plain = run(false);
      out.hit = run(true);
      // 单次顿帧的长度：35 毫秒 = 定格 2 帧 + 第 3 帧只走九成
      G.debug.step(1.5);
      const tA = S.time;
      G.hitStop(35);
      const steps = [];
      for (let i = 0; i < 4; i++) { const t = S.time; G.tick(1 / 60); steps.push(+((S.time - t) * 60).toFixed(2)); }
      out.stop35 = steps;
      // 多次触发取最长，不叠加；上限 160 毫秒
      G.hitStop(110);
      G.hitStop(35);
      out.max = F.stop;
      G.hitStop(999);
      out.cap = F.stop;
      G.debug.step(0.5);
      // 慢动作：0.4 秒真实时间里按 0.25 倍流逝，最后 40% 渐渐回到正常
      const tB = S.time;
      G.slowMo(0.25, 0.4);
      let minK = 1;
      for (let i = 0; i < 24; i++) { G.tick(1 / 60); minK = Math.min(minK, F.k); }
      const gameT = S.time - tB;
      G.tick(1 / 60);
      out.slow = { game: gameT, minK, k: F.k, left: F.slow };
      // 慢动作里敌人的预警圈和玩家的冷却同步放慢
      const e2 = G.spawnMob('bomber', P.x - 1.5, P.z, 1, { awake: true });
      e2.wasAwake = true;
      e2.atkCd = 0;
      let t = 0;
      while (!S.telegraphs.length && t < 3) { G.tick(1 / 60); t += 1 / 60; }
      const tg = S.telegraphs[0];
      if (tg) {
        P.cds.meteor = 1;
        const p0 = tg.t, tC = S.time;
        G.slowMo(0.25, 10);
        for (let i = 0; i < 12; i++) G.tick(1 / 60);
        out.sync = { tele: tg.t - p0, cd: 1 - P.cds.meteor, game: S.time - tC };
        F.slow = 0;
      }
      T.unfix();
      T.arena();
      G.debug.hold(false);
      return out;
    });
    const P0 = r.plain, H = r.hit;
    assert(P0.timer === P0.tele && Math.abs(P0.cd - P0.timer) <= 1 && P0.frozen === 0 && Math.abs(P0.ticks - 90) <= 1, '没有命中时 1.5 秒的计时应同时在第 90 步结束：' + JSON.stringify(P0));
    assert(H.hits >= 3 && H.frozen >= 6, '打在靶子上应触发若干帧顿帧：' + JSON.stringify(H));
    assert(H.timer === H.tele && Math.abs(H.cd - H.timer) <= 1, '顿帧不应让计时器 / 预警圈 / 冷却错位：' + JSON.stringify(H));
    assert(H.ticks > P0.ticks + 5 && Math.abs(H.game - 1.5) < 0.02, '顿帧只消耗真实时间，游戏时间仍是 1.5 秒：' + JSON.stringify(H));
    assert(r.stop35[0] === 0 && r.stop35[1] === 0 && Math.abs(r.stop35[2] - 0.9) < 0.02 && r.stop35[3] === 1, '35 毫秒顿帧的逐帧推进应为 0 / 0 / 0.9 / 1：' + r.stop35.join(' / '));
    assert(Math.abs(r.max - 0.11) < 1e-9 && Math.abs(r.cap - 0.16) < 1e-9, '顿帧应取最长且有上限：' + r.max + ' / ' + r.cap);
    assert(Math.abs(r.slow.minK - 0.25) < 1e-6 && r.slow.k === 1 && r.slow.left === 0 && r.slow.game > 0.12 && r.slow.game < 0.2, '慢动作的时间流逝不对：' + JSON.stringify(r.slow));
    assert(r.sync && Math.abs(r.sync.tele - r.sync.game) < 1e-6 && Math.abs(r.sync.cd - r.sync.game) < 1e-6 && Math.abs(r.sync.game - 0.05) < 0.002, '慢动作里预警圈 / 冷却应与游戏时间同步放慢：' + JSON.stringify(r.sync));
    // 面板打开：实时循环不推进，顿帧和慢动作原样保留；关掉后接着走完
    await page.keyboard.press('KeyI');
    const a = await ev(() => { G.hitStop(120); G.slowMo(0.3, 0.5); return { t: G.state.time, open: G.ui.isOpen() }; });
    await frames(5);
    const b2 = await ev(() => ({ t: G.state.time, stop: G.flow.stop, slow: G.flow.slow, paused: G.state.paused }));
    assert(a.open && b2.paused && b2.t === a.t && Math.abs(b2.stop - 0.12) < 1e-9 && b2.slow === 0.5, '面板打开时顿帧 / 慢动作不应流逝：' + JSON.stringify(b2));
    await closePanel();
    await until(() => G.flow.stop === 0 && G.flow.slow === 0 && G.flow.k === 1).catch(() => {
      throw new Error('关掉面板后顿帧 / 慢动作没有走完');
    });
    const c2 = await ev((t) => { G.debug.hold(true); return G.state.time > t; }, a.t);
    assert(c2, '关掉面板后游戏时间没有继续');
    return '命中 ' + H.hits + ' 次，定格 ' + H.frozen + ' 帧，1.5 秒的计时用了 ' + H.ticks + ' 步';
  });

  await uiStep('架势：精英与首领有架势条（小怪没有），近战削得比法术多、终结技最多；几秒不挨打后回复；打空即破绽——停手、易伤、预警与延时招式全部取消；首领越破越硬', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, S = G.state, W = G.world, PO = G.POISE;
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.computeStats();
      const out = { po: { delay: PO.delay, taken: PO.taken, el: PO.brokenElite, boss: PO.brokenBoss, grow: PO.bossGrow } };
      T.fix(0.5);
      const N = T.mob('husk', 3, 3);
      const E = T.mob('husk', 3, 0, { elite: true });
      out.normal = N.poiseMax;
      out.elite = [E.poiseMax, E.poise, G.MOBS.husk.poise];
      // 各种来源削掉多少
      const loss = (fn) => { const p = E.poise; fn(); return +(p - E.poise).toFixed(3); };
      const combo = G.SKILLS.cleave.combo;
      const cl = G.skillCtx('cleave');
      const pd0 = P.S.poiseDmg; // 手里若是战锤，隐含的「架势削减提高」会放大削减：先归零比对数据表，最后单独验证
      P.S.poiseDmg = 0;
      out.loss = {
        s1: loss(() => G.hitEnemy(E, cl, combo[0].mult, { w: 0, poise: combo[0].poise })),
        s3: loss(() => G.hitEnemy(E, cl, combo[2].mult, { w: 2, poise: combo[2].poise })),
        ember: loss(() => G.hitEnemy(E, G.skillCtx('ember'), 1)),
        arc: loss(() => G.hitEnemy(E, G.skillCtx('arc'), 1)),
      };
      T.fix(0);
      out.loss.crit = loss(() => G.hitEnemy(E, cl, combo[0].mult, { w: 0, poise: combo[0].poise }));
      T.fix(0.5);
      out.data = { s1: combo[0].poise, s3: combo[2].poise, ember: G.SKILLS.ember.poise, arc: G.SKILLS.arc.poise, critMult: PO.critMult };
      P.S.poiseDmg = 50;
      out.loss.pd50 = loss(() => G.hitEnemy(E, cl, combo[0].mult, { w: 0, poise: combo[0].poise }));
      P.S.poiseDmg = pd0;
      // 回复：先等 delay 秒
      const p0 = E.poise;
      G.debug.step(PO.delay - 0.2);
      out.hold = E.poise - p0;
      G.debug.step(0.7);
      out.regen = E.poise - p0;
      G.debug.step(6);
      out.full = E.poise === E.poiseMax;
      // 打空：破绽
      const E2 = G.spawnMob('husk', P.x + 1.5, P.z - 1, 1, { awake: true, elite: true });
      E2.wasAwake = true;
      E2.atkCd = 0;
      E2.hp = E2.maxHp = 1e6;
      G.debug.god(false);
      P.life = P.maxLife;
      let t = 0;
      while (E2.state !== 'windup' && t < 3) { G.tick(1 / 60); t += 1 / 60; }
      const before = G.hitEnemy(E2, cl, 1, { poise: 1 });
      E2.poise = 5;
      const b0 = S.stats.breaks;
      G.hitEnemy(E2, cl, 1, { poise: 10 });
      out.brk = { t: E2.brokenT, state: E2.state, clip: W.clipOf(E2.ent), breaks: S.stats.breaks - b0, stop: G.flow.stop };
      const during = G.hitEnemy(E2, cl, 1, { poise: 50 });
      out.taken = during / before;
      out.poiseWhile = E2.poise;
      E2.stunT = 0;
      const life0 = P.life;
      G.debug.step(PO.brokenElite - 0.3);
      out.quiet = { hurt: life0 - P.life, t: E2.brokenT, held: E2.held };
      G.debug.step(0.5);
      out.after = { t: E2.brokenT, poise: E2.poise, max: E2.poiseMax, clip: W.clipOf(E2.ent) };
      let hurtAt = -1;
      for (let i = 0; i < 240 && hurtAt < 0; i++) { G.tick(1 / 60); if (P.life < life0) hurtAt = i / 60; }
      out.resumed = hurtAt;
      G.debug.god(true);

      // ---- 首领：招式放到一半被打出破绽 ----
      const bossRun = (kind, pat) => {
        T.lane();
        G.debug.god(true);
        const b = G.spawnBoss(kind, P.x + 7, P.z, S.zone.level);
        b.def = Object.assign({}, b.def, { patterns: [pat] });
        b.awake = true;
        let t = 0;
        while (!(b.lastPattern === pat && b.busy > 0) && t < 6) { G.tick(1 / 60); t += 1 / 60; }
        if (b.lastPattern !== pat) return { started: false };
        G.debug.step(pat === 'spiral' ? 0.6 : pat === 'fan' ? 0.55 : 0.35); // 放到一半
        const o = { started: true, tel0: S.telegraphs.filter((q) => q.owner === b).length, timers0: S.timers.length, proj0: S.projectiles.length, busy0: b.busy };
        b.poise = 1;
        let shots = 0, mobs0 = S.enemies.length;
        const sp = G.spawnProjectile;
        G.spawnProjectile = function (p) { if (p.owner === 'e') shots++; return sp(p); };
        const life0 = P.life;
        G.debug.god(false);
        P.iframe = 0;
        P.life = P.maxLife;
        T.fix(0.5);
        G.hitEnemy(b, G.skillCtx('cleave'), 1, { poise: 30 });
        o.broken = b.brokenT;
        o.tel = S.telegraphs.filter((q) => q.owner === b).length;
        o.clip = W.clipOf(b.ent);
        o.busy = b.busy;
        o.dash = b.dash;
        // 已经飞在半空的弹幕不归破绽管：先清掉，再看之后有没有新的
        for (const p of S.projectiles.slice()) { p.life = 0; }
        G.tick(1 / 60);
        const bx = b.x, bz = b.z;
        let tel = 0;
        for (let i = 0; i < 150; i++) { G.tick(1 / 60); tel = Math.max(tel, S.telegraphs.filter((q) => q.owner === b).length); }
        G.spawnProjectile = sp;
        o.shots = shots;
        o.telAfter = tel;
        o.summoned = S.enemies.length - mobs0;
        o.moved = Math.hypot(b.x - bx, b.z - bz);
        o.hurt = P.maxLife - P.life;
        G.debug.god(true);
        // 破绽结束：架势回满且上限提高，重新开始放招
        o.max0 = b.poiseBase;
        G.debug.step(PO.brokenBoss - 2.5 + 0.2);
        o.after = { t: b.brokenT, poise: b.poise, max: b.poiseMax, clip: W.clipOf(b.ent) };
        const lp = b.busy;
        let again = -1;
        b.lastPattern = null;
        for (let i = 0; i < 300 && again < 0; i++) { G.tick(1 / 60); if (b.busy > 0 && b.lastPattern === pat) again = i / 60; }
        o.again = again;
        T.unfix();
        return o;
      };
      out.boss = {
        spiral: bossRun('lord', 'spiral'),
        barrage: bossRun('lord', 'barrage'),
        fan: bossRun('weaver', 'fan'),
        charge: bossRun('golem', 'charge'),
        cross: bossRun('warden', 'cross'),
        summon: bossRun('weaver', 'summon'),
      };
      out.bossPoise = Object.keys(G.BOSSES).map((k) => G.BOSSES[k].poise);
      T.unfix();
      // 留一只首领给 HUD 检查
      T.lane();
      const hb = G.spawnBoss('golem', P.x + 6, P.z, S.zone.level);
      hb.awake = hb.wasAwake = true;
      hb.cd = 1e9;
      hb.poise = hb.poiseMax * 0.4;
      G.debug.step(0.1);
      return out;
    });
    assert(r.normal === 0 && r.elite[0] === r.elite[2] && r.elite[1] === r.elite[0] && r.bossPoise.every((v) => v > 300), '架势上限不对（小怪应为 0，精英 / 首领取数据表）：' + JSON.stringify([r.normal, r.elite, r.bossPoise]));
    const Lz = r.loss, D = r.data;
    assert(Lz.s1 === D.s1 && Lz.s3 === D.s3 && Lz.ember === D.ember && Lz.arc === D.arc, '每次命中削掉的架势应取技能数据：' + JSON.stringify(Lz));
    assert(Math.abs(Lz.pd50 - D.s1 * 1.5) < 1e-6, '「架势削减提高 50%」应让削减 ×1.5：' + JSON.stringify(Lz));
    assert(Lz.s3 > Lz.s1 * 2 && Lz.s1 > Lz.ember && Lz.s1 > Lz.arc && Math.abs(Lz.crit - D.s1 * D.critMult) < 1e-6, '应为 终结技 > 近战 ≥ 法术，暴击再多三成：' + JSON.stringify(Lz));
    assert(Math.abs(r.hold) < 1e-9 && r.regen > 1 && r.full, '架势应在 ' + r.po.delay + ' 秒不挨打后才开始回复，并最终回满：' + JSON.stringify([r.hold, r.regen, r.full]));
    assert(Math.abs(r.brk.t - r.po.el) < 1e-6 && r.brk.state === 'idle' && r.brk.clip === 'stagger' && r.brk.breaks === 1 && r.brk.stop > 0.05, '架势打空应进入破绽并打断起手：' + JSON.stringify(r.brk));
    assert(Math.abs(r.taken - r.po.taken) < 0.01 && r.poiseWhile === 0, '破绽中应易伤 ' + r.po.taken + ' 倍且不再削架势：' + JSON.stringify([r.taken, r.poiseWhile]));
    assert(r.quiet.hurt === 0 && r.quiet.t > 0 && r.quiet.held, '破绽期间敌人不应行动：' + JSON.stringify(r.quiet));
    assert(r.after.t === 0 && r.after.poise === r.after.max && r.after.max === r.elite[0] && r.after.clip !== 'stagger', '破绽结束后应站稳、架势回满：' + JSON.stringify(r.after));
    assert(r.resumed >= 0, '破绽结束后精英应恢复攻击');
    for (const k of Object.keys(r.boss)) {
      const o = r.boss[k];
      assert(o.started, '首领没有放出 ' + k);
      assert(Math.abs(o.broken - r.po.boss) < 1e-6 && o.clip === 'broken' && o.busy === 0 && o.dash === null, k + '：首领没有进入破绽：' + JSON.stringify(o));
      assert(o.tel === 0 && o.telAfter === 0 && o.shots === 0 && o.summoned === 0 && o.moved < 1e-6 && o.hurt === 0, k + '：打出破绽后仍有预警 / 弹幕 / 召唤 / 位移 / 伤害：' + JSON.stringify(o));
      assert(o.after.t === 0 && o.after.poise === o.after.max && Math.abs(o.after.max - o.max0 * (1 + r.po.grow)) < 1e-6 && o.after.clip !== 'broken', k + '：破绽结束后架势应回满并提高两成：' + JSON.stringify(o.after));
      assert(o.again >= 0, k + '：破绽结束后首领没有重新出招');
    }
    assert(r.boss.spiral.timers0 > 5 && r.boss.barrage.tel0 >= 2 && r.boss.cross.tel0 >= 2 && r.boss.charge.tel0 === 1, '打断的时机应在招式中途（有挂起的预警 / 计时器）：' + JSON.stringify({ sp: r.boss.spiral.timers0, ba: r.boss.barrage.tel0, cr: r.boss.cross.tel0, ch: r.boss.charge.tel0 }));
    // HUD：首领架势条
    await ev(() => G.debug.hold(false));
    await until(() => document.getElementById('boss-box').classList.contains('on'));
    await frames(2);
    let h = await ev(() => {
      G.debug.hold(true);
      const b = G.state.boss;
      const m = /scaleX\(([\d.]+)\)/.exec(document.getElementById('boss-poise-fill').style.transform);
      const bar = T.rect('.boss-poise'), hp = T.rect('.boss-bar');
      return { q: m ? +m[1] : -1, want: b.poise / b.poiseMax, under: bar.t >= hp.b - 1 && bar.w > 200, broken: document.getElementById('boss-box').classList.contains('broken'), label: +getComputedStyle(document.getElementById('boss-break')).opacity };
    });
    assert(Math.abs(h.q - h.want) < 0.02 && h.under && !h.broken && h.label === 0, '首领血条下方应有架势条：' + JSON.stringify(h));
    await ev(() => { G.breakEnemy(G.state.boss); G.debug.hold(false); });
    await until(() => document.getElementById('boss-box').classList.contains('broken') && +getComputedStyle(document.getElementById('boss-break')).opacity > 0.9).catch(() => {
      throw new Error('首领破绽时 HUD 没有提示');
    });
    h = await ev(() => { G.debug.hold(true); return document.getElementById('boss-break').innerText.replace(/\s+/g, ''); });
    assert(h.includes('破绽') && h.includes('处决'), '首领破绽提示的文字不对：' + h);
    return '削架势 ' + Lz.s1 + ' / ' + Lz.s3 + '（终结）/ 掷焰 ' + Lz.ember + '，暴击 ' + Lz.crit;
  });

  await uiStep('处决：F（或贴身按近战键）冲到破绽中的敌人身前给出重创，全程无敌并回复生命 / 魔力 / 药剂；残血精英毙命，首领按比例封顶；隔墙、目标中途死亡 / 移动、换区都能正确收场', async () => {
    const setup = (o) => ev((o) => {
      const P = G.player, S = G.state;
      T.lane();
      G.debug.god(!!o.god);
      G.bindSkill(0, 'cleave');
      G.bindSkill(1, 'ember');
      G.bindSkill(2, null);
      G.bindSkill(3, null);
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.computeStats();
      const e = o.boss ? G.spawnBoss('golem', P.x + o.dx, P.z, S.zone.level) : G.spawnMob('brute', P.x + o.dx, P.z, 1, { awake: true, elite: true });
      e.awake = e.wasAwake = true;
      if (o.boss) e.cd = 1e9;
      else {
        e.atkCd = 1e9;
        // 血量相对角色的输出足够厚：处决伤害正好取「四成最大生命」这一档，和测试角色穿了什么无关
        const best = Math.max(G.avgHit(G.skillCtx('cleave')), G.avgHit(G.skillCtx('ember')));
        e.hp = e.maxHp = Math.max(e.maxHp, best * G.POISE.execHits * 4);
      }
      if (o.hpK) e.hp = e.maxHp * o.hpK;
      G.breakEnemy(e);
      G.debug.step(0.3); // 击破的顿帧走完
      P.life = P.maxLife * 0.5;
      P.mana = P.maxMana * 0.2;
      P.flask.life = P.flask.mana = 1;
      P.iframe = 0;
      window.E = e;
      T.settle();
      return { broken: e.brokenT, hp: e.hp, max: e.maxHp };
    }, o);
    const run = () => ev(() => {
      const P = G.player, S = G.state, W = G.world, e = window.E;
      const o = { exec: !!P.exec, clip: W.clipOf(P.ent), slow: G.flow.slow, k0: 0, hurt: null };
      const hp0 = e.hp, x0 = P.x, ex0 = e.x, st0 = S.stats.execs;
      let ticks = 0, hitAt = -1, maxStop = 0, minK = 1;
      const hurts = [];
      while (P.exec && ticks < 300) {
        G.tick(1 / 60);
        ticks++;
        minK = Math.min(minK, G.flow.k > 0 ? G.flow.k : 1);
        if (hitAt < 0 && e.hp < hp0) { hitAt = ticks; maxStop = G.flow.stop; o.gap = Math.hypot(e.x - P.x, e.z - P.z) - e.r; }
        if (ticks % 6 === 0) hurts.push(G.hurtPlayer(50, 'phys'));
      }
      o.ticks = ticks;
      o.hitAt = hitAt;
      o.stop = maxStop;
      o.minK = minK;
      o.invuln = hurts.length > 3 && hurts.every((h) => h === false);
      o.dmg = hp0 - Math.max(0, e.hp);
      o.dead = e.dead;
      o.moved = P.x - x0;
      o.execs = S.stats.execs - st0;
      o.life = P.life / P.maxLife;
      o.mana = P.mana / P.maxMana;
      o.flask = P.flask.life;
      o.broken = e.brokenT;
      o.executed = e.executed;
      o.again = G.tryExecute();
      o.pushed = e.x - ex0;
      return o;
    });
    // 1. 残血精英：F 处决，直接毙命
    let s = await setup({ dx: 6, hpK: 0.5 });
    assert(s.broken > 3, '精英没有进入破绽');
    await frames(3);
    let p = await ev(() => ({ on: document.getElementById('execp').classList.contains('on'), far: document.getElementById('execp').classList.contains('far'), txt: document.getElementById('execp').innerText.replace(/\s+/g, ''), box: T.rect('#execp .ep'), head: G.world.project(E.x, 3, E.z) }));
    assert(p.on && !p.far && p.txt === 'F处决' && Math.abs(p.box.x - p.head.x) < 40 && p.box.b < p.head.y + 60, '破绽中的敌人头上应有「F 处决」提示：' + JSON.stringify(p));
    await page.keyboard.press('KeyF');
    let r = await run();
    assert(r.exec && r.clip === 'execute' && r.slow > 0.4, '按 F 没有开始处决：' + JSON.stringify(r));
    assert(r.hitAt > 15 && r.hitAt < 26 && r.gap < 1.3 && r.moved > 3, '应冲到目标身前再命中：' + JSON.stringify(r));
    assert(r.minK <= 0.26 && Math.abs(r.stop - 0.13) < 1e-6, '处决应有慢动作和 130 毫秒顿帧：' + JSON.stringify(r));
    assert(r.invuln, '处决全程应无敌');
    assert(r.dead && r.dmg >= s.hp - 1e-6 && r.execs === 1, '残血精英应被直接处决：' + JSON.stringify(r));
    assert(r.life > 0.67 && r.life < 0.8 && r.mana > 0.44 && r.mana < 0.6 && r.flask >= 1.5, '处决应回复生命 / 魔力 / 药剂（击杀另算）：' + JSON.stringify(r));
    await frames(3);
    assert(!(await ev(() => document.getElementById('execp').classList.contains('on'))), '处决之后提示应消失');
    // 2. 满血精英：至少四成最大生命，活下来的很快爬起来，同一次破绽不能再处决
    s = await setup({ dx: 3 });
    await page.keyboard.press('KeyF');
    r = await run();
    assert(!r.dead && Math.abs(r.dmg - s.max * 0.4) < 1e-6 && r.executed && r.broken <= 0.7 && !r.again && r.pushed > 0.4, '满血精英应挨一记重创、被震退后爬起来：' + JSON.stringify(r));
    // 3. 首领：按最大生命封顶
    s = await setup({ dx: 7.5, boss: true });
    await page.keyboard.press('KeyF');
    r = await run();
    const po = await ev(() => G.POISE);
    assert(!r.dead && r.dmg >= s.max * po.execBossMin - 1e-6 && r.dmg <= s.max * po.execBossMax + 1e-6 && r.broken <= 1.1 && !r.again && Math.abs(r.pushed) < 1e-6, '首领应损失 ' + po.execBossMin * 100 + '% ~ ' + po.execBossMax * 100 + '% 最大生命：' + JSON.stringify(r) + ' / ' + s.max);
    const bossPct = (r.dmg / s.max) * 100;
    r = await ev(() => { G.debug.step(1.3); const b = window.E; return { t: b.brokenT, poise: b.poise, max: b.poiseMax, base: b.poiseBase, flask: G.player.flask.life }; });
    assert(r.t === 0 && r.poise === r.max && r.max > r.base, '首领被处决后应重新站稳、架势更硬：' + JSON.stringify(r));
    // 4. 贴身按近战键：处决而不是挥砍
    s = await setup({ dx: 2.6, god: true });
    const pt = await ev(() => { const q = T.scr(E.x, E.z); return { x: Math.round(q.x), y: Math.round(q.y) }; });
    await page.mouse.move(pt.x, pt.y);
    await frames(2);
    await page.mouse.down();
    r = await ev(() => { const P = G.player; for (let i = 0; i < 3; i++) G.tick(1 / 60); return { exec: !!P.exec, cast: !!P.cast }; });
    await page.mouse.up();
    assert(r.exec && !r.cast, '贴身按近战键应触发处决：' + JSON.stringify(r));
    await ev(() => { G.debug.step(1.5); });
    // 没有破绽目标时 F 仍然是拾取
    assert((await ev(() => G.tryExecute())) === false, '没有破绽目标时 G.tryExecute 应返回 false');
    // 5. 隔着墙：够不着，提示变成「靠近处决」
    s = await setup({ dx: 5, god: true });
    r = await ev(() => {
      const P = G.player, W = G.world, e = window.E;
      const ow = W.walkable, wallX = P.x + 2.2;
      W.walkable = function (x, z, pad) { return Math.abs(x - wallX) < 0.5 ? false : ow.call(W, x, z, pad); };
      window.UNWALL = () => { W.walkable = ow; };
      return { target: !!G.execTarget(G.POISE.execRange), tried: G.tryExecute(), exec: !!P.exec, ok: G.execute(e) };
    });
    assert(!r.target && !r.tried && !r.exec && !r.ok, '隔着墙不应能处决：' + JSON.stringify(r));
    await frames(3);
    p = await ev(() => ({ on: document.getElementById('execp').classList.contains('on'), far: document.getElementById('execp').classList.contains('far'), txt: document.getElementById('execp').innerText.replace(/\s+/g, '') }));
    await ev(() => window.UNWALL());
    assert(p.on && p.far && p.txt === 'F靠近处决', '够不着时提示应变暗并改口：' + JSON.stringify(p));
    // 6. 冲刺途中目标死了：收手，不结算，马上能动
    r = await ev(() => {
      const P = G.player, S = G.state, e = window.E;
      const st0 = S.stats.execs, life0 = P.life;
      const ok = G.tryExecute();
      for (let i = 0; i < 6; i++) G.tick(1 / 60);
      const mid = { exec: !!P.exec, x: P.x };
      G.killEnemy(e, { type: 'fire' });
      G.tick(1 / 60);
      const o = { ok, mid, exec: !!P.exec, slow: G.flow.slow, iframe: P.iframe, execs: S.stats.execs - st0, gain: (P.life - life0) / P.maxLife, clip: G.world.clipOf(P.ent) };
      G.input.tap[0] = 0.3;
      T.aim(P.x + 3, P.z);
      for (let i = 0; i < 4; i++) G.tick(1 / 60);
      o.canAct = !!P.cast;
      G.debug.step(1);
      return o;
    });
    assert(r.ok && r.mid.exec && !r.exec && r.slow === 0 && r.iframe <= 0.25 && r.execs === 0 && r.gain < 0.1 && r.clip !== 'execute' && r.canAct, '目标中途死亡时应干净收手（不给处决奖励）：' + JSON.stringify(r));
    // 7. 冲刺途中目标被挪走：落点跟着目标重算，照样命中
    s = await setup({ dx: 6, god: true });
    r = await ev(() => {
      const P = G.player, e = window.E;
      const hp0 = e.hp;
      G.tryExecute();
      for (let i = 0; i < 8; i++) G.tick(1 / 60);
      e.z += 2.2;
      let gap = -1;
      for (let i = 0; i < 120 && P.exec; i++) { G.tick(1 / 60); if (gap < 0 && e.hp < hp0) gap = Math.hypot(e.x - P.x, e.z - P.z) - e.r; }
      return { hit: e.hp < hp0, gap, exec: !!P.exec };
    });
    assert(r.hit && r.gap >= 0 && r.gap < 1.4 && !r.exec, '目标移动后处决应跟过去命中：' + JSON.stringify(r));
    // 8. 处决 / 顿帧 / 慢动作途中换区：全部归零，不留尾巴
    s = await setup({ dx: 6, god: true });
    r = await ev(() => {
      const P = G.player, S = G.state;
      G.tryExecute();
      for (let i = 0; i < 5; i++) G.tick(1 / 60);
      G.hitStop(110);
      G.input.tap[0] = 0.3;
      G.input.tapDodge = 0.3;
      const mid = { exec: !!P.exec, slow: G.flow.slow, stop: G.flow.stop };
      G.enterZone(S.zoneIdx, S.tier);
      const o = { mid, exec: !!P.exec, slow: G.flow.slow, stop: G.flow.stop, k: G.flow.k, tap: G.input.tap.join() + '|' + G.input.tapDodge, at: Math.hypot(P.x - S.zone.start.x, P.z - S.zone.start.z), clip: G.world.clipOf(P.ent) };
      const t0 = S.time;
      let acted = false;
      for (let i = 0; i < 30; i++) { G.tick(1 / 60); if (P.cast || P.roll.t > 0 || P.exec) acted = true; }
      o.dt = S.time - t0;
      o.acted = acted;
      G.debug.god(true);
      T.arena();
      return o;
    });
    assert(r.mid.exec && r.mid.slow > 0 && r.mid.stop > 0, '换区前应正处在处决 / 慢动作 / 顿帧中：' + JSON.stringify(r.mid));
    assert(!r.exec && r.slow === 0 && r.stop === 0 && r.k === 1 && r.tap === '0,0,0,0,0|0' && r.at < 0.01 && r.clip !== 'execute', '换区时处决 / 顿帧 / 慢动作 / 缓冲应全部清掉：' + JSON.stringify(r));
    assert(Math.abs(r.dt - 0.5) < 1e-6 && !r.acted, '换区后时间应正常流逝且不自动出招：' + JSON.stringify(r));
    return '首领一次处决损失 ' + bossPct.toFixed(1) + '% 生命';
  });

  await uiStep('复查回归：敌人出手的动作与伤害同帧、游魂不再瞬移；连击踏步不越过准星；顿帧随速度缩短并计入秒伤；翻滚时头不入地；两处处决提示说法一致且让开小地图；战斗中名牌让位', async () => {
    // 1. 小怪出手：伤害结算的那一刻，出手动作已经播到「命中帧」（以前是伤害先到、动作 0.12 秒后才挥下来）
    let r = await ev(() => {
      const P = G.player, W = G.world, S = G.state;
      const out = {};
      const hp = G.hurtPlayer, sp = G.spawnProjectile;
      try {
        for (const type of ['husk', 'brute', 'spitter']) {
          T.lane();
          G.debug.god(false);
          P.iframe = 0;
          const e = G.spawnMob(type, P.x + (type === 'spitter' ? 6 : type === 'brute' ? 2.4 : 3.2), P.z, 1, { awake: true });
          e.wasAwake = true;
          e.atkCd = 0;
          e.ang = -Math.PI / 2;
          let hit = null, wind = false, maxStep = 0, px = e.x, pz = e.z;
          const snap = () => ({ clip: W.clipOf(e.ent), cT: e.ent.cT, lead: W.clipLead(e.ent, 'attack'), state: e.state });
          G.hurtPlayer = function () { if (!hit) hit = snap(); return hp.apply(this, arguments); };
          G.spawnProjectile = function (q) { if (q.owner !== 'p' && !hit) hit = snap(); return sp.apply(this, arguments); };
          for (let i = 0; i < 500 && !hit; i++) {
            G.tick(1 / 60);
            if (e.state === 'windup') wind = true;
            if (wind) maxStep = Math.max(maxStep, Math.hypot(e.x - px, e.z - pz));
            px = e.x;
            pz = e.z;
          }
          out[type] = Object.assign({ maxStep }, hit);
        }
        // 首领砸地：锤子落地（命中帧）对在预警圈结算的那一刻
        T.lane();
        G.debug.god(false);
        P.iframe = 0;
        const b = G.spawnBoss('golem', P.x + 4, P.z, 1);
        b.def = Object.assign({}, b.def, { patterns: ['slam'] });
        b.awake = true;
        let hit = null;
        G.hurtPlayer = function () { if (!hit) hit = { same: b.ent.clip === b.ent.rig.clips.slam, cT: b.ent.cT, lead: W.clipLead(b.ent, 'slam'), tele: S.telegraphs.length }; return hp.apply(this, arguments); };
        for (let i = 0; i < 600 && !hit; i++) G.tick(1 / 60);
        out.boss = hit;
      } finally {
        G.hurtPlayer = hp;
        G.spawnProjectile = sp;
        G.debug.god(true);
      }
      return out;
    });
    for (const type of ['husk', 'brute', 'spitter']) {
      const m = r[type];
      assert(m && m.clip === 'attack' && m.lead > 0.05 && m.cT >= m.lead - 0.04 && m.cT <= m.lead + 0.04, type + ' 的伤害应落在出手动作的命中帧上：' + JSON.stringify(m));
    }
    assert(r.husk.maxStep < 0.3, '游魂的前扑应摊在起手的最后 0.1 秒里，不该一帧瞬移（单帧位移 ' + r.husk.maxStep.toFixed(2) + '）');
    const r0fmt = r.husk.maxStep.toFixed(2);
    assert(r.boss && r.boss.same && r.boss.lead > 0.05 && Math.abs(r.boss.cT - r.boss.lead) < 0.04, '首领砸地的伤害应落在砸地动作的命中帧上：' + JSON.stringify(r.boss));

    // 2. 准星贴在身前、面前没有敌人时按住左键：踏步不越过准星，角色不会冲过头再原地掉头
    r = await ev(() => {
      const P = G.player;
      T.lane();
      const x0 = P.x, z0 = P.z;
      let maxX = x0, flips = 0;
      for (let i = 0; i < 240; i++) {
        T.aim(x0 + 1.2, z0);
        G.input.mouse.b[0] = true;
        G.tick(1 / 60);
        maxX = Math.max(maxX, P.x);
        if (P.cast && Math.sin(P.face) < 0.5) flips++;
      }
      G.input.mouse.b[0] = false;
      G.debug.step(1);
      // 准星放远：踏步照常
      const x1 = P.x;
      for (let i = 0; i < 100; i++) { T.aim(x1 + 8, z0); G.input.mouse.b[0] = true; G.tick(1 / 60); }
      G.input.mouse.b[0] = false;
      const far = P.x - x1;
      G.debug.step(1);
      return { over: maxX - x0, flips, far };
    });
    assert(r.over < 0.25 && r.flips === 0, '踏步不应越过准星（最多停在离落点 1 之外）：' + JSON.stringify(r));
    assert(r.far > 1.5, '准星在远处时踏步应照常：' + JSON.stringify(r));

    // 3. 顿帧随出手速度缩短（下限六成）；技能卡 / 换装评估的秒伤把顿帧算进去，和实际打出来的对得上
    r = await ev(() => {
      const P = G.player;
      const out = {};
      T.fix(0.5);
      const w0 = T.blade();
      try {
        for (const haste of [false, true]) {
          T.lane();
          G.bindSkill(0, 'cleave');
          for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
          if (haste) G.socketSupport('cleave', 0, 'haste');
          G.computeStats();
          const e = T.mob('brute', 2.6, 0);
          e.mass = 1e6;
          const ctx = G.skillCtx('cleave');
          const first = T.swing(e);
          G.debug.step(1.5);
          const hp0 = e.hp;
          const secs = 24;
          for (let i = 0; i < secs * 60; i++) { T.aim(e.x, e.z); G.input.mouse.b[0] = true; G.tick(1 / 60); }
          G.input.mouse.b[0] = false;
          const critK = 1 + (ctx.crit / 100) * (ctx.critMulti / 100 - 1);
          out[haste ? 'haste' : 'base'] = { speed: ctx.speed, stopK: ctx.stopK, stop: first.stop, stopAvg: ctx.stopAvg, real: (hp0 - e.hp) / secs, est: G.skillDps(ctx) / critK, old: G.avgHit(ctx) / ctx.time / critK };
          G.debug.step(1);
        }
      } finally {
        T.unfix();
        T.unblade(w0);
      }
      return out;
    });
    assert(Math.abs(r.base.stopK - Math.min(1, Math.max(0.6, 1 / r.base.speed))) < 1e-9 && Math.abs(r.base.stop - 0.035 * r.base.stopK) < 1e-6, '不带迅捷时顿帧应只随角色自身的出手速度缩放：' + JSON.stringify(r.base));
    assert(r.haste.speed > 1.2 && Math.abs(r.haste.stopK - 1 / r.haste.speed) < 1e-6 && Math.abs(r.haste.stop - 0.035 / r.haste.speed) < 1e-6, '迅捷应让顿帧按出手速度缩短：' + JSON.stringify(r.haste));
    for (const k of ['base', 'haste']) {
      const m = r[k];
      assert(Math.abs(m.real / m.est - 1) < 0.07, (k === 'haste' ? '带迅捷' : '基础') + '的估算秒伤应与实打一致（差 7% 以内）：' + JSON.stringify(m));
      assert(m.old > m.est * 1.08, '估算秒伤应把顿帧算进去：' + JSON.stringify(m));
    }
    assert(r.haste.real / r.base.real > 1.2, '迅捷（+25% 速度）的实际收益不应被顿帧吃掉一大截：' + (r.haste.real / r.base.real).toFixed(3));
    const dpsFmt = r.base.real.toFixed(1) + ' / ' + r.base.est.toFixed(1) + '（迅捷 ' + r.haste.real.toFixed(1) + ' / ' + r.haste.est.toFixed(1) + '）';

    // 4. 翻滚：头和上身始终在地面以上
    r = await ev(() => {
      const P = G.player, W = G.world;
      T.lane();
      P.roll.cd = 0;
      G.input.keys.KeyD = true;
      G.debug.step(0.3);
      G.dodge();
      let head = 9, chest = 9;
      for (let i = 0; i < 24; i++) {
        G.tick(1 / 60);
        head = Math.min(head, W.entSocket(P.ent, 'head').y);
        chest = Math.min(chest, W.entSocket(P.ent, 'chest').y);
      }
      G.input.keys.KeyD = false;
      G.debug.step(0.8);
      return { head, chest };
    });
    assert(r.head > 0.15 && r.chest > 0.15, '翻滚时头 / 上身不应沉到地面以下：' + JSON.stringify(r));

    // 5. 处决提示：头顶的牌子和首领血条下的那一行说同一句话；够不着时都是「靠近处决」；牌子不压小地图
    await ev(() => {
      const P = G.player, S = G.state;
      T.lane();
      const b = (window.__B = G.spawnBoss('golem', P.x + 5, P.z, 1));
      b.awake = b.wasAwake = true;
      b.cd = 1e9;
      G.debug.step(0.2);
      G.breakEnemy(b);
      G.debug.step(0.4);
    });
    await page.mouse.move(700, 620);
    await frames(4);
    const both = () => ev(() => ({ bar: document.getElementById('boss-break').innerText.replace(/\s+/g, ''), chip: document.getElementById('execp').innerText.replace(/\s+/g, ''), far: document.getElementById('boss-box').classList.contains('far'), chipFar: document.getElementById('execp').classList.contains('far') }));
    r = await both();
    assert(r.bar === '破绽F处决' && r.chip === 'F处决' && !r.far && !r.chipFar, '够得着时两处提示都应是「处决」：' + JSON.stringify(r));
    await ev(() => { const b = window.__B; b.brokenT = 4; b.x = G.player.x + 14; G.world.setEnt(b.ent, b.x, b.z, b.ang); G.debug.step(0.05); });
    await frames(4);
    r = await both();
    assert(r.bar === '破绽F靠近处决' && r.chip === 'F靠近处决' && r.far && r.chipFar, '够不着时两处提示都应改口「靠近处决」：' + JSON.stringify(r));
    // 把破绽中的敌人摆到小地图底下：牌子要让开
    r = await ev(() => {
      const P = G.player, W = G.world, b = window.__B;
      b.brokenT = 4;
      let best = null;
      for (let dx = 6; dx <= 16 && !best; dx += 0.5) for (let dz = -12; dz <= -4; dz += 0.5) {
        const q = W.project(P.x + dx, 4.1, P.z + dz);
        if (q.x > innerWidth - 150 && q.x < innerWidth - 40 && q.y > 60 && q.y < 150) { best = { dx, dz }; break; }
      }
      if (!best) return null;
      b.x = P.x + best.dx;
      b.z = P.z + best.dz;
      W.setEnt(b.ent, b.x, b.z, b.ang);
      G.debug.step(0.05);
      return best;
    });
    assert(r, '没找到能投影到小地图位置的落点');
    await frames(4);
    r = await ev(() => { const c = document.querySelector('#execp .ep').getBoundingClientRect(); return { on: document.getElementById('execp').classList.contains('on'), l: c.left, t: c.top, r: c.right, b: c.bottom, w: innerWidth }; });
    assert(r.on && !(r.r > r.w - 190 && r.t < 190) && r.r <= r.w && r.t >= 0, '处决提示不应压在小地图上：' + JSON.stringify(r));
    // 首领没有名牌（信息都在首领血条上）
    await ev(() => { const P = G.player, b = window.__B; b.x = P.x + 5; b.z = P.z; G.world.setEnt(b.ent, b.x, b.z, b.ang); T.settle(); G.debug.step(0.05); });
    let pt = await ev(() => { const q = G.world.project(window.__B.x, 1.6, window.__B.z); return { x: Math.round(q.x), y: Math.round(q.y) }; });
    await page.mouse.move(pt.x, pt.y);
    await until(() => document.getElementById('reticle').className === 'enemy');
    await frames(3);
    assert(!(await ev(() => document.getElementById('nameplate').classList.contains('on'))), '准星指着首领时不应再弹出名牌');

    // 6. 小怪的名牌：停手细看是带血量的完整版；按着攻击键时缩成一行；精英在战斗中干脆不出（头顶本来就有名字和血条）
    await ev(() => {
      T.lane();
      window.__M = T.mob('husk', 4, 0);
      window.__M.shockT = 1e9;
      T.settle();
      G.debug.step(0.05);
    });
    pt = await ev(() => { const q = G.world.project(window.__M.x, 1, window.__M.z); return { x: Math.round(q.x), y: Math.round(q.y) }; });
    await page.mouse.move(pt.x, pt.y);
    await until(() => document.getElementById('nameplate').classList.contains('on') && !!document.querySelector('#nameplate .np-hp')).catch(() => {
      throw new Error('停手时指着小怪应显示完整名牌');
    });
    await ev(() => { G.debug.god(true); });
    await page.mouse.down();
    try {
      await until(() => document.getElementById('nameplate').classList.contains('mini')).catch(() => {
        throw new Error('按住攻击键时名牌应缩成一行');
      });
      r = await ev(() => ({ hp: !!document.querySelector('#nameplate .np-hp'), ail: document.querySelectorAll('#nameplate .ail .ico').length, h: T.rect('#nameplate').h, txt: document.getElementById('nameplate').innerText }));
      assert(!r.hp && r.ail === 1 && r.h < 26 && r.txt.includes('游魂') && r.txt.includes('Lv'), '战斗中的名牌应只有一行（名字、等级、异常图标）：' + JSON.stringify(r));
      await ev(() => { const P = G.player; window.__M.elite = true; window.__M.name = '精英游魂'; G.debug.step(0.05); });
      await until(() => !document.getElementById('nameplate').classList.contains('on') && G.state.hover === null).catch(() => {
        throw new Error('战斗中指着精英不应弹出名牌');
      });
    } finally {
      await page.mouse.up();
    }
    await ev(() => {
      delete window.__B;
      delete window.__M;
      T.arena();
      G.debug.god(true);
    });
    return '游魂单帧位移 ' + r0fmt + '；实打 / 估算秒伤 ' + dpsFmt;
  });

  await uiStep('战斗提示与帮助：连击 / 架势 / 处决三条提示按情境出现（处决提示会立刻顶上来），做到即消失；帮助页有对应说明', async () => {
    const shown = (id) => until((id) => G.ui.hints().current === id && G.ui.hints().state === 'show' && document.getElementById('coach').classList.contains('on'), id).catch(() => {
      throw new Error('提示「' + id + '」没有出现');
    });
    const seen = (id) => until((id) => !!G.save.tut[id], id).catch(() => {
      throw new Error('提示「' + id + '」没有在做到之后标记为看过');
    });
    await ev(() => {
      T.arena();
      G.debug.god(true);
      G.bindSkill(0, 'cleave');
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.computeStats();
      T.hintsSeen();
      delete G.save.tut.combo;
    });
    await frames(20);
    assert((await ev(() => G.ui.hints().current)) === null, '身边没有敌人时不应提示连击');
    await ev(() => { window.E = T.mob('husk', 3, 0); });
    await shown('combo');
    let txt = await ev(() => document.getElementById('coach').innerText);
    assert(txt.includes('三段') && txt.includes('终结技') && txt.includes('空格'), '连击提示的文字不对：' + txt);
    await ev(() => { for (let i = 0; i < 3; i++) T.swing(E); G.debug.step(0.5); });
    await seen('combo');
    // 架势：身边有精英 / 首领时出现，打出破绽即完成；处决提示不等间隔，立刻顶上来
    await ev(() => {
      G.clearEnemies();
      delete G.save.tut.poise;
      delete G.save.tut.execute;
      window.E = T.mob('brute', 4, 0, { elite: true });
    });
    await shown('poise');
    txt = await ev(() => document.getElementById('coach').innerText);
    assert(txt.includes('架势') && txt.includes('破绽'), '架势提示的文字不对：' + txt);
    await ev(() => { G.breakEnemy(E); G.debug.step(0.2); });
    await shown('execute');
    const st = await ev(() => ({ poise: !!G.save.tut.poise, txt: document.getElementById('coach').innerText }));
    assert(st.txt.includes('处决') && st.txt.includes('F'), '处决提示的文字不对：' + st.txt);
    await page.keyboard.press('KeyF');
    await ev(() => { let n = 0; while (G.player.exec && n++ < 200) G.tick(1 / 60); });
    await seen('execute');
    await ev(() => { G.breakEnemy(E); delete G.save.tut.poise; });
    await ev(() => { T.arena(); T.hintsSeen(); });
    // 帮助页
    await page.keyboard.press('KeyH');
    const help = await ev(() => T.bodyText());
    cleanText(help, '帮助页');
    for (const w of ['连击', '终结技', '架势', '破绽', '处决', '翻滚可以取消挥砍']) assert(help.includes(w), '帮助页缺少「' + w + '」的说明');
    await closePanel();
    // 技能页：裂石击的卡片列出三段倍率
    await page.keyboard.press('KeyG');
    const card = await ev(() => { const n = document.querySelector('.sk-combo'); return n ? n.innerText.replace(/\s+/g, ' ') : ''; });
    assert(/×0\.8/.test(card) && /终结 ×2\.2/.test(card), '技能卡没有列出连击倍率：' + card);
    await closePanel();
  });

  // ------------------------------------------------------------------ 区域 / 首领
  const ZONES = await ev(() => G.ZONES.map((z) => ({ id: z.id, name: z.name, level: z.level, boss: z.boss, mobs: z.mobs, patterns: G.BOSSES[z.boss].patterns })));
  for (let zi = 0; zi < ZONES.length; zi++) {
    const Z = ZONES[zi];
    await step('区域 ' + (zi + 1) + '「' + Z.name + '」：通过地图进入，布怪与画面正常，重复进入不泄漏', async () => {
      if (!(await ev(() => G.ui.isOpen()))) await page.keyboard.press('KeyM');
      assert((await ev(() => T.tab())) === 'map', '地图页没有打开');
      cleanText(await ev(() => T.bodyText()), '地图页');
      const sel = '[data-act="enter"][data-zone="' + zi + '"]';
      assert(await ev((s) => !!document.querySelector(s), sel), '区域 ' + zi + ' 还没解锁');
      if (zi < ZONES.length - 1) assert(!(await ev((s) => !!document.querySelector(s), '[data-act="enter"][data-zone="' + (zi + 1) + '"]')), '下一个区域不应提前解锁');
      await page.click(sel);
      await ev(() => {
        G.debug.hold(false);
        G.debug.god(true);
      });
      await frames(3); // 新区域的着色器 / 贴图
      const r = await ev(() => {
        G.debug.hold(true);
        const S = G.state, W = G.world, P = G.player;
        const out = {
          open: G.ui.isOpen(), idx: S.zoneIdx, tier: S.tier, level: S.zone.level, id: S.zone.def.id, n: S.enemies.length,
          boss: S.boss && S.boss.bossKind, bossLv: S.boss && S.boss.level,
          types: Array.from(new Set(S.enemies.filter((e) => !e.isBoss).map((e) => e.type))),
          bad: S.enemies.filter((e) => !W.walkable(e.x, e.z, 0) || Math.hypot(e.x - S.zone.start.x, e.z - S.zone.start.z) < 12).length,
          elites: S.enemies.filter((e) => e.elite).length,
          at: Math.hypot(P.x - S.zone.start.x, P.z - S.zone.start.z), full: P.life === P.maxLife && P.mana === P.maxMana,
          name: document.getElementById('zone-name').textContent, fr: T.frame(), last: G.save.lastZone,
          loose: S.loot.length + S.projectiles.length + S.telegraphs.length + S.timers.length, portal: S.portal,
        };
        // 泄漏检查：往场景里塞一堆东西后重进，场景对象数（扣除敌人）应不变
        const count = () => W.scene.children.length - S.enemies.length;
        const n1 = count();
        const clutter = () => {
          for (let i = 0; i < 6; i++) G.spawnLoot('item', G.rollItem(5, i % 3), 1, 1);
          G.spawnLoot('skill', { id: 'nova', lvl: 3 }, 2, 0);
          G.spawnLoot('cur', 'chaos', 2, 1);
          G.spawnProjectile({ owner: 'e', x: 1, z: 1, dx: 1, dz: 0, dmg: 1, dtype: 'fire' });
          G.spawnProjectile({ owner: 'p', x: 1, z: 1, dx: 0, dz: 1, ctx: G.skillCtx('ember'), color: 0xff8a3c });
          G.telegraph({ shape: 'circle', x: 2, z: 2, r: 3, dur: 5 });
          G.telegraph({ shape: 'rect', x: 2, z: 2, len: 8, w: 2, ang: 1, dur: 5 });
          G.after(1, () => { throw new Error('换区后旧计时器仍然触发'); });
          S.portal = { x: 3, z: 3, mesh: W.makePortal(3, 3), armed: true };
        };
        clutter();
        out.cluttered = count() - n1;
        W.render();
        G.enterZone(S.zoneIdx, S.tier);
        out.leak = count() - n1;
        G.debug.step(1.5);
        out.loose2 = S.loot.length + S.projectiles.length + S.telegraphs.length + S.timers.length + (S.portal ? 1 : 0);
        return out;
      });
      assert(!r.open, '进入区域后面板应关闭');
      assert(r.idx === zi && r.id === Z.id && r.level === Z.level && r.tier === 0 && r.last === zi, '进入的区域不对：' + JSON.stringify(r));
      assert(r.name === Z.name, 'HUD 区域名没有更新：' + r.name);
      assert(r.n >= 20 && r.elites <= 4, '怪物数量不对：' + r.n);
      assert(r.boss === Z.boss && r.bossLv === Z.level + 3, '首领不对：' + r.boss);
      assert(r.types.every((t) => Z.mobs.includes(t)), '出现了不属于该区域的怪：' + r.types);
      assert(r.bad === 0, r.bad + ' 只怪的位置不合法');
      assert(r.at < 0.01 && r.full, '玩家应在起点且满状态');
      assert(r.loose === 0 && !r.portal, '新区域里残留了上一个区域的东西');
      assert(r.fr.mean > 5 && r.fr.colors > 40, '画面像是黑屏：' + JSON.stringify(r.fr));
      assert(r.cluttered === 13, '杂物应往场景里加 13 个对象，实际 ' + r.cluttered);
      assert(r.leak === 0, '重新进入后场景里多了 ' + r.leak + ' 个对象');
      assert(r.loose2 === 0, '换区后仍有残留的运行时对象');
      return '怪物 ' + r.n + '，精英 ' + r.elites + '，亮度 ' + r.fr.mean.toFixed(1);
    });

    await step('首领「' + Z.boss + '」：苏醒，' + Z.patterns.join('/') + ' 全部放过（含狂暴），能伤到玩家', async () => {
      const r = await ev((need) => {
        const S = G.state, P = G.player, b = S.boss;
        G.debug.god(true);
        const asleep = !b.awake;
        G.debug.tpBoss();
        let t = 0;
        while (!b.awake && t < 3) { G.tick(1 / 60); t += 1 / 60; }
        const out = { asleep, awake: b.awake, wakeT: t };
        const run = (cap, list) => {
          const seen = {};
          let last = b.lastPattern, tt = 0, maxTel = 0, maxProj = 0, maxMobs = 0;
          const done = () => list.every((p) => seen[p]);
          let tail = 1.5; // 最后一招放出来之后再多跑一会儿，让延迟生效的部分（召唤、弹幕）落地
          while (tt < cap && (!done() || (tail -= 1 / 60) > 0)) {
            G.tick(1 / 60);
            tt += 1 / 60;
            if (b.lastPattern !== last) {
              last = b.lastPattern;
              seen[last] = (seen[last] || 0) + 1;
            }
            maxTel = Math.max(maxTel, S.telegraphs.length);
            maxProj = Math.max(maxProj, S.projectiles.length);
            maxMobs = Math.max(maxMobs, S.enemies.filter((e) => e.summoned && !e.dead).length);
          }
          return { seen, t: tt, maxTel, maxProj, maxMobs, done: done() };
        };
        out.p1 = run(240, need);
        b.hp = b.maxHp * 0.35;
        out.p2 = run(240, need.filter((p) => p !== 'summon'));
        out.enraged = b.enraged;
        G.debug.step(3); // 让在途的弹幕 / 预警结算完
        out.inZone = G.world.walkable(b.x, b.z, 0);
        return out;
      }, Z.patterns);
      assert(r.asleep && r.awake, '首领应先沉睡、玩家进场后苏醒');
      assert(r.p1.done, '常态下 240 秒内没放全：' + JSON.stringify(r.p1.seen));
      assert(r.enraged && r.p2.done, '狂暴后没放全：' + JSON.stringify(r.p2.seen));
      assert(r.p1.maxTel + r.p1.maxProj > 0, '没有任何预警圈或弹幕');
      if (Z.patterns.includes('summon')) assert(r.p1.maxMobs >= 1, '召唤没有刷出小怪');
      assert(r.inZone, '首领跑出了场地');
      // 带着预警圈 / 弹幕实际渲染几帧
      await ev(() => G.debug.hold(false));
      await frames(4);
      const h = await ev(() => {
        G.debug.hold(true);
        return { bar: document.getElementById('boss-box').classList.contains('on'), name: document.getElementById('boss-name').textContent, fr: T.frame() };
      });
      assert(h.bar && h.name.length >= 3, '首领血条没有显示');
      assert(h.fr.mean > 5, '首领战画面过暗');
      // 关掉无敌，站着不动应该会挨打
      const hurt = await ev(() => {
        const P = G.player;
        G.debug.god(false);
        P.life = P.maxLife;
        let ht = 0;
        while (ht < 40 && P.life >= P.maxLife && !P.dead) { G.tick(1 / 60); ht += 1 / 60; }
        const out = { t: ht, lost: P.maxLife - P.life, dead: P.dead };
        G.debug.god(true);
        if (P.dead) G.debug.step(2); // 高层首领可能把没穿装备的测试角色秒掉：等它重生
        P.life = P.maxLife;
        return out;
      });
      assert(hurt.lost > 0, '首领 40 秒内没有伤到站着不动的玩家');
      return '常态 ' + r.p1.t.toFixed(0) + 's，狂暴 ' + r.p2.t.toFixed(0) + 's，' + hurt.t.toFixed(1) + 's 后打掉 ' + hurt.lost.toFixed(0) + ' 生命';
    });

    await step('首领「' + Z.boss + '」：可被击杀，掉落战利品并出现传送门', async () => {
      const r = await ev(() => {
        const S = G.state, P = G.player, b = S.boss, save = G.save;
        G.debug.god(true);
        T.clearLoot();
        const pts0 = G.passivePoints().total;
        const first = !save.bossKills[b.bossKind];
        const lvl0 = save.level;
        // 用真实的技能上下文打出致命一击
        let n = 0;
        while (!b.dead && n < 50) { G.hitEnemy(b, G.skillCtx('cleave'), 1e5); n++; }
        const kinds = {};
        for (const l of S.loot) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
        const out = {
          dead: b.dead, kinds, rare: S.loot.some((l) => l.kind === 'item' && l.data.rarity === 2),
          minRarity: Math.min.apply(null, S.loot.filter((l) => l.kind === 'item').map((l) => l.data.rarity)),
          portal: S.portal && { x: S.portal.x, z: S.portal.z, mesh: !!S.portal.mesh.parent },
          bp: S.zone.bossPos, cleared: save.cleared[S.zone.def.id], kill: save.bossKills[b.bossKind],
          ptsGain: G.passivePoints().total - pts0 - (save.level - lvl0), first, eproj: S.projectiles.filter((p) => p.owner === 'e').length,
          maxTier: save.maxTier, toast: T.toasts(),
        };
        G.debug.step(1.2);
        out.removed = S.enemies.indexOf(b) < 0;
        out.tele = S.telegraphs.filter((t) => t.owner === b).length;
        // 走过每个掉落物：宝石 / 通货 / 魔法以上的物品应自动进包
        save.bag.length = Math.min(save.bag.length, 20);
        for (const l of S.loot.slice()) {
          T.tp(l.x, l.z);
          G.debug.step(0.1);
        }
        out.left = S.loot.length;
        T.tp(S.portal.x + 6, S.portal.z);
        G.debug.step(0.2);
        G.ui.close(); // 捡东西时可能踩到传送门
        return out;
      });
      assert(r.dead && r.removed, '首领没有死亡或尸体没有移除');
      assert(r.kinds.item >= 3 && r.kinds.cur >= 4 && r.kinds.skill >= 1 && r.kinds.support >= 1, '首领掉落不对：' + JSON.stringify(r.kinds));
      assert(!r.first || r.kinds.blank >= 1, '首领首杀应必掉一颗无铭技能宝石：' + JSON.stringify(r.kinds));
      assert(r.rare && r.minRarity >= 1, '首领应至少掉 1 件稀有，其余至少魔法');
      assert(r.portal && r.portal.mesh && Math.abs(r.portal.x - r.bp.x) < 1e-6, '没有在场地中央生成传送门');
      assert(r.cleared === 0 && r.kill === true, '通关记录没有写入');
      assert(r.first && r.ptsGain === 2, '首杀应获得 2 点天赋点，实际 ' + r.ptsGain);
      assert(r.eproj === 0 && r.tele === 0, '首领死后仍有敌方弹幕 / 预警');
      assert(r.left === 0, '走过首领掉落后还剩 ' + r.left + ' 个没捡起来');
      if (zi === ZONES.length - 1) assert(r.maxTier === 1 && r.toast.includes('轮回层级'), '击败最终首领应解锁轮回层级 1');
      else assert(r.maxTier === 0, '不应提前解锁轮回层级');
      return '掉落 ' + JSON.stringify(r.kinds);
    });

    await step('传送门：走近后打开地图' + (zi < ZONES.length - 1 ? '，下一个区域已解锁' : '，轮回层级 1 已解锁'), async () => {
      const r = await ev(() => {
        const S = G.state, P = G.player;
        T.tp(S.portal.x + 6, S.portal.z);
        G.debug.step(0.2);
        const far = G.ui.isOpen();
        T.tp(S.portal.x + 1, S.portal.z);
        G.debug.step(0.5);
        return { far, open: G.ui.isOpen(), tab: T.tab(), armed: S.portal.armed };
      });
      assert(!r.far, '离传送门还远时不应打开地图');
      assert(r.open && r.tab === 'map' && r.armed === false, '走近传送门没有打开地图：' + JSON.stringify(r));
      // 关掉地图后站在原地不会反复弹出，走开再回来才会
      await page.keyboard.press('Escape');
      const again = await ev(() => {
        const S = G.state;
        G.debug.step(0.5);
        const a = G.ui.isOpen();
        T.tp(S.portal.x + 5, S.portal.z);
        G.debug.step(0.2);
        T.tp(S.portal.x + 1, S.portal.z);
        G.debug.step(0.2);
        return { a, b: G.ui.isOpen() };
      });
      assert(!again.a && again.b, '传送门的重新待命逻辑不对：' + JSON.stringify(again));
      const m = await ev((zi) => ({
        next: !!document.querySelector('[data-act="enter"][data-zone="' + (zi + 1) + '"]'),
        cleared: document.querySelectorAll('.zone.cleared').length,
        tiers: document.querySelectorAll('[data-act="tier"]').length,
      }), zi);
      assert(m.cleared === zi + 1, '地图上的通关标记数量不对：' + m.cleared);
      if (zi < ZONES.length - 1) assert(m.next && m.tiers === 1, '下一个区域没有解锁');
      else assert(m.tiers === 2, '没有出现轮回层级 1 的按钮');
    });
  }

  await step('轮回：选择层级 1 进入灰烬荒原，怪物等级接着上一层的末区往上走（+TIER_LEVELS）', async () => {
    await page.click('[data-act="tier"][data-tier="1"]');
    const m = await ev(() => ({
      txt: T.bodyText(),
      locked: document.querySelectorAll('.zone.locked').length,
      enter: document.querySelectorAll('[data-act="enter"]').length,
    }));
    const lv = await ev(() => ({ step: G.TIER_LEVELS, first: G.ZONES[0].level, last: G.ZONES[G.ZONES.length - 1].level, n: G.ZONES.length }));
    const L1 = lv.first + lv.step, L9 = lv.last + lv.step;
    // 先进区域再断言：断言失败时不把地图面板留在那里，连累后面的步骤
    if (m.enter >= 1) await page.click('[data-act="enter"][data-zone="0"]');
    assert(new RegExp('怪物等级\\s*' + L1).test(m.txt) && new RegExp('怪物等级\\s*' + L9).test(m.txt), '层级 1 的地图没有显示怪物等级 ' + L1 + ' … ' + L9);
    assert(lv.first + lv.step > lv.last, '轮回层级 1 的首区（' + (lv.first + lv.step) + '）不应比层级 0 的末区（' + lv.last + '）低');
    assert(m.enter === 1 && m.locked === lv.n - 1, '层级 1 应只解锁第一个区域');
    const r = await ev(() => {
      const S = G.state;
      return { open: G.ui.isOpen(), tier: S.tier, level: S.zone.level, bossLv: S.boss.level, hp: S.boss.maxHp, saveTier: G.save.tier, sub: document.getElementById('zone-sub').textContent };
    });
    assert(!r.open && r.tier === 1 && r.level === L1 && r.bossLv === L1 + 3 && r.saveTier === 1, '轮回层级进入不对：' + JSON.stringify(r));
    await until((L1) => new RegExp(String(L1)).test(document.getElementById('zone-sub').textContent), L1).catch(() => {
      throw new Error('HUD 怪物等级没有更新');
    });
  });

  // ------------------------------------------------------------------ 死亡 / 重生
  await step('死亡与重生：倒下、遮罩、满状态重生（首领战在竞技场门外，其余回入口），怪物与首领复位，不掉经验和物品', async () => {
    const a = await ev(() => {
      const S = G.state, P = G.player, b = S.boss, save = G.save;
      G.debug.god(true);
      G.debug.tpBoss();
      let t = 0;
      while (!b.awake && t < 3) { G.tick(1 / 60); t += 1 / 60; }
      G.hitEnemy(b, G.skillCtx('cleave'), 1); // 打一下
      b.hp = b.maxHp * 0.5;
      G.debug.step(2);
      const before = { level: save.level, xp: save.xp, bag: save.bag.length, cur: JSON.stringify(save.cur) };
      G.debug.god(false);
      P.life = 1;
      let dt = 0;
      while (!P.dead && dt < 40) { G.tick(1 / 60); dt += 1 / 60; }
      const out = { before, dead: P.dead, dieT: dt, hidden: !P.ent.group.visible, toast: T.toasts(), deadT: P.deadT };
      P.deadT = 4; // 拉长一点，方便检查遮罩
      const x = P.x, z = P.z;
      G.input.keys.KeyD = true;
      G.debug.step(0.3);
      G.input.keys.KeyD = false;
      out.frozen = P.x === x && P.z === z;
      out.flask = G.useFlask('life');
      out.dodge = G.dodge();
      return out;
    });
    assert(a.dead && a.dieT < 40, '关掉无敌、只剩 1 点生命，40 秒内居然没死');
    assert(a.hidden && a.toast.includes('倒下'), '死亡表现不对');
    assert(a.frozen && !a.flask && !a.dodge, '死亡后不应还能移动 / 喝药 / 翻滚');
    await until(() => document.getElementById('death').classList.contains('on') && +getComputedStyle(document.getElementById('death')).opacity > 0.5).catch(() => {
      throw new Error('死亡遮罩没有显示');
    });
    const dtxt = await ev(() => document.getElementById('death').innerText);
    assert(dtxt.includes('你倒下了') && dtxt.includes('竞技场门外'), '死亡遮罩文字不对：' + dtxt);
    const b = await ev(() => {
      const S = G.state, P = G.player, boss = S.boss, save = G.save;
      G.debug.step(4.2);
      return {
        dead: P.dead, at: Math.hypot(P.x - S.zone.start.x, P.z - S.zone.start.z), full: P.life === P.maxLife && P.mana === P.maxMana,
        door: Math.hypot(P.x - S.zone.bossPos.x, P.z - S.zone.bossPos.z) - S.zone.bossR, walk: G.world.walkable(P.x, P.z, 0.5),
        flask: P.flask.life + P.flask.mana, shown: P.ent.group.visible,
        bossHp: boss.hp === boss.maxHp, bossAwake: boss.awake, bossHome: Math.hypot(boss.x - S.zone.bossPos.x, boss.z - S.zone.bossPos.z),
        awake: S.enemies.filter((e) => e.awake && Math.hypot(e.x - P.x, e.z - P.z) > 16).length, summoned: S.enemies.filter((e) => e.summoned).length,
        loose: S.projectiles.length + S.telegraphs.length,
        after: { level: save.level, xp: save.xp, bag: save.bag.length, cur: JSON.stringify(save.cur) },
        god: G.debug.god(true), // 门外可能有没清掉的怪，检查期间别让它们把人打死
      };
    });
    assert(!b.dead && b.full && b.flask === 6 && b.shown, '重生状态不对：' + JSON.stringify(b));
    assert(Math.abs(b.door - 2) < 0.01 && b.walk && b.at > 30, '倒在首领战里应重生在竞技场门外（离场地边缘 2），而不是区域入口：' + JSON.stringify(b));
    assert(b.bossHp && !b.bossAwake && b.bossHome < 0.01, '首领没有复位回满');
    assert(b.awake === 0 && b.summoned === 0 && b.loose === 0, '怪物 / 弹幕没有复位：' + JSON.stringify(b));
    assert(JSON.stringify(a.before) === JSON.stringify(b.after), '死亡不应损失经验或物品');
    await until(() => !document.getElementById('death').classList.contains('on')).catch(() => {
      throw new Error('重生后死亡遮罩没有消失');
    });
    // 不在首领战里倒下：回区域入口
    const c2 = await ev(() => {
      const S = G.state, P = G.player, c = S.zone.circles[1];
      T.tp(c.x, c.z);
      G.debug.god(false);
      P.iframe = 0;
      G.hurtPlayer(1e9, 'phys');
      const dead = P.dead, door = !!P.respawnAt;
      G.debug.step(0.1);
      const sub = document.getElementById('death').innerText;
      G.debug.step(2);
      return { dead, door, sub, alive: !P.dead, at: Math.hypot(P.x - S.zone.start.x, P.z - S.zone.start.z), full: P.life === P.maxLife };
    });
    await until(() => !document.getElementById('death').classList.contains('on')).catch(() => {
      throw new Error('第二次重生后死亡遮罩没有消失');
    });
    assert(c2.dead && !c2.door && c2.alive && c2.at < 0.01 && c2.full, '首领没醒时倒下应回到区域入口：' + JSON.stringify(c2));
    await ev(() => G.debug.god(true));
    return a.dieT.toFixed(1) + ' 秒后被首领打倒';
  });

  await step('资源：反复切换全部五个区域，几何体 / 贴图 / 场景对象不增长', async () => {
    const r = await ev(() => {
      const W = G.world, S = G.state;
      const cyc = () => {
        for (let i = 0; i < G.ZONES.length; i++) {
          G.enterZone(i, 0);
          G.debug.step(0.2);
          W.render();
        }
      };
      cyc();
      const m1 = Object.assign({}, W.renderer.info.memory), n1 = W.scene.children.length - S.enemies.length;
      cyc();
      cyc();
      const m2 = W.renderer.info.memory, n2 = W.scene.children.length - S.enemies.length;
      const out = { geo: m2.geometries - m1.geometries, tex: m2.textures - m1.textures, n: n2 - n1, g: m2.geometries, t: m2.textures };
      G.enterZone(0, 1);
      G.debug.god(true);
      return out;
    });
    assert(r.n === 0, '场景对象数变化 ' + r.n);
    assert(r.geo <= 3 && r.tex <= 1, '切换 10 次区域后几何体 +' + r.geo + '，贴图 +' + r.tex);
    return '几何体 ' + r.g + '（+' + r.geo + '），贴图 ' + r.t + '（+' + r.tex + '）';
  });

  // ------------------------------------------------------------------ 存档
  let snap = null;
  await step('存档：刷新页面后角色、装备、技能、天赋、进度完整恢复', async () => {
    snap = await ev(() => {
      const save = G.save;
      // 攒一个有内容的角色
      save.bag.length = Math.min(save.bag.length, 20);
      for (const slot of G.SLOTS) {
        // 武器用刃：拿着远程武器时右键是武器普攻，绑不上掷焰（那条另有步骤测）
        const it = G.debug.giveItem(2, slot, slot === 'weapon' ? 0 : undefined);
        G.equip(it);
      }
      G.allocPassive('dm0');
      G.allocPassive('dm1');
      G.socketSupport('ember', 0, 'multi');
      G.socketSupport('cleave', 2, 'brutal');
      G.bindSkill(0, 'cleave');
      G.bindSkill(1, 'ember');
      G.bindSkill(2, 'nova');
      G.bindSkill(3, 'blink');
      save.opts.autoWhite = true;
      G.debug.give('chaos', 7);
      G.ui.open('inv');
      G.ui.close(); // 关面板 = 存档
      const P = G.player;
      return {
        stored: T.canon(JSON.parse(localStorage.getItem('cinder-abyss-save-v1'))),
        live: T.canon(save),
        stats: { maxLife: P.maxLife, maxMana: P.maxMana, armour: P.armour, res: Object.assign({}, P.res), speed: P.speedMult, hit: G.avgHit(G.skillCtx('ember')) },
        zone: { idx: G.state.zoneIdx, tier: G.state.tier, level: G.state.zone.level },
        level: save.level,
      };
    });
    assert(snap.stored === snap.live, '关闭面板后 localStorage 里的存档与内存不一致');
    await page.reload({ timeout: 90000 }); // 机器负载高时软件渲染加载很慢
    await install();
    await ev(() => G.debug.hold(false));
    await frames(3);
    const r = await ev(() => {
      const P = G.player, save = G.save;
      const uids = save.bag.concat(Object.values(save.equip)).map((it) => it.uid);
      for (let i = 0; i < 5; i++) uids.push(G.rollItem(3, 1).uid);
      return {
        live: T.canon(save),
        stats: { maxLife: P.maxLife, maxMana: P.maxMana, armour: P.armour, res: Object.assign({}, P.res), speed: P.speedMult, hit: G.avgHit(G.skillCtx('ember')) },
        zone: { idx: G.state.zoneIdx, tier: G.state.tier, level: G.state.zone.level },
        open: G.ui.isOpen(), uniq: new Set(uids).size === uids.length, n: uids.length,
        bar: T.hudBar(),
        lv: document.getElementById('xp-lv').textContent, fr: T.frame(),
      };
    });
    if (r.live !== snap.live) {
      const A = JSON.parse(snap.live), B = JSON.parse(r.live);
      const keys = Object.keys(Object.assign({}, A, B)).filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k]));
      throw new Error('刷新后的存档与刷新前不一致：' + keys.map((k) => k + ' ' + JSON.stringify(A[k]).slice(0, 160) + ' → ' + JSON.stringify(B[k]).slice(0, 160)).join(' | '));
    }
    assert(JSON.stringify(r.stats) === JSON.stringify(snap.stats), '刷新后属性不一致：' + JSON.stringify(r.stats) + ' vs ' + JSON.stringify(snap.stats));
    assert(JSON.stringify(r.zone) === JSON.stringify(snap.zone), '刷新后没有回到上次的区域 / 层级：' + JSON.stringify(r.zone));
    assert(!r.open, '已看过开场卡片，刷新后不应再弹出');
    assert(r.uniq, '刷新后新生成的物品 uid 与旧物品冲突');
    assert(r.bar === 'cleave,ember,nova,blink' && r.lv === '等级 ' + snap.level, 'HUD 没有按存档恢复：' + r.bar + ' ' + r.lv);
    assert(r.fr.mean > 5, '刷新后画面过暗');
    // 自动存档：模拟里过 10 秒会写一次
    const auto = await ev(() => {
      G.debug.hold(true);
      G.debug.god(true);
      G.save.cur.dust = 4321;
      G.debug.step(10.5);
      return JSON.parse(localStorage.getItem('cinder-abyss-save-v1')).cur.dust;
    });
    assert(auto === 4321, '10 秒自动存档没有生效');
    return '背包 + 装备 ' + (r.n - 5) + ' 件，层级 ' + r.zone.tier;
  });

  await step('刷新后仍可正常游玩：移动、施法、面板', async () => {
    await ev(() => {
      T.arena();
      G.debug.god(true);
      T.dummy(2.4, 0);
      T.settle();
      G.debug.hold(false);
    });
    const pt = await ev(() => T.scr(T.d.x, T.d.z));
    await page.mouse.move(Math.round(pt.x), Math.round(pt.y));
    await page.mouse.down();
    try {
      await until(() => T.d.hp < T.d.maxHp);
    } finally {
      await page.mouse.up();
    }
    await page.keyboard.down('KeyA');
    try {
      await until(() => G.player.x < -1.5);
    } finally {
      await page.keyboard.up('KeyA');
    }
    for (const k of ['KeyI', 'KeyG', 'KeyP', 'KeyM', 'KeyH']) {
      await page.keyboard.press(k);
      cleanText(await ev(() => T.bodyText()), k + ' 页（满配角色）');
    }
    await closePanel();
    await ev(() => G.debug.hold(true));
  });

  // ---------------- 成长改版：角色一直成长到 60 级、经验曲线跟着怪物等级、更大的天赋盘、召唤物继承装备、16 级以上的怪物曲线 ----------------
  await step('成长：宝石 / 武器 / 基础生命不再在 20 / 27 级封顶，层级 0 用到的数值和改版前逐项相同', async () => {
    const r = await ev(() => {
      const keep = { level: G.save.level, skills: Object.assign({}, G.save.skills) };
      const out = { cap: G.MAX_GEM_LEVEL };
      const floorAt = (l) => { G.save.level = l; return G.gemFloor(); };
      out.floors = [1, 16, 27, 40, 60].map(floorAt);
      G.save.level = keep.level;
      // 武器：27 级以内和改版前的公式一样（1 + 0.12 × (等级 − 1)），之后接着线性涨
      const old = (b, l) => { const B = G.BASES.weapon[b]; const k = 1 + 0.12 * (Math.min(l, 27) - 1); const lo = Math.max(1, Math.round(B.dmg[0] * k)); return [lo, Math.max(lo + 1, Math.round(B.dmg[1] * k))].join('-'); };
      out.wSame = [1, 5, 13, 16, 24, 27].every((l) => [0, 3, 4, 7].every((b) => G.weaponBaseDmg(b, l).join('-') === old(b, l)));
      out.w = [27, 32, 48, 64].map((l) => G.weaponBaseDmg(0, l)[1]);
      // 基础生命 / 魔力：20 级以内和改版前一样（每级 +12 / +6），之后每级多给
      out.lifeSame = [1, 8, 16, 20].every((l) => G.baseLife(l) === 100 + 12 * (l - 1) && G.baseMana(l) === 60 + 6 * (l - 1));
      out.life = [20, 35, 50, 60].map(G.baseLife);
      // 宝石 20 级以上照样涨：法术 / 召唤物的基础伤害、召唤物生命
      const avg = (o) => Object.values(o).reduce((s, v) => s + (v[0] + v[1]) / 2, 0);
      out.ember = [20, 30, 45].map((l) => Math.round(avg(G.skillBase('ember', l))));
      out.emberSame = Math.abs(avg(G.skillBase('ember', 14)) - 14 * (1 + 0.2 * 13)) < 1e-9;
      out.thrall = [20, 30, 45].map((l) => Math.round(avg(G.skillBase('thrall', l))));
      // 掉落宝石 / 无铭宝石 / 存档里的宝石等级上限都跟着提高
      G.save.skills.ember = 44;
      G.persist();
      G.loadSave();
      out.loaded = G.save.skills.ember;
      G.save.level = keep.level;
      G.save.skills = keep.skills;
      G.syncGemLevels();
      G.computeStats();
      G.persist();
      return out;
    });
    assert(r.cap === 45 && r.floors.join() === '1,12,20,30,45', '宝石成长下限应一直涨到 45：' + JSON.stringify(r));
    assert(r.wSame && r.w[1] > r.w[0] && r.w[2] > r.w[1] && r.w[3] > r.w[2] && r.w[2] / r.w[0] > 1.5, '武器伤害应在 27 级以后继续成长、之前不变：' + JSON.stringify(r));
    assert(r.lifeSame && r.life[1] - r.life[0] > 15 * 20 && r.life[3] > r.life[2], '基础生命应在 20 级以后明显成长、之前不变：' + JSON.stringify(r));
    assert(r.emberSame && r.ember[1] > r.ember[0] * 1.3 && r.ember[2] > r.ember[1] && r.thrall[2] > r.thrall[1] && r.thrall[1] > r.thrall[0], '宝石 20 级以上的伤害应继续成长：' + JSON.stringify(r));
    assert(r.loaded === 44, '存档里 20 级以上的宝石不应被截回 20：' + r.loaded);
    return '宝石下限 ' + r.floors.join('/') + ' · 刃 ' + r.w.join('/') + ' · 基础生命 ' + r.life.join('/');
  });

  await step('经验：16 级以内的升级经验与改版前相同，之后跟着怪物经验同步成长；压级递减、越级封顶；五个区域、每层 +TIER_LEVELS（20），每个区域清一遍，角色等级始终比怪物高 2–7 级（到 60 级封顶为止）', async () => {
    const r = await ev(() => {
      const out = {};
      const poly = (l) => Math.round(40 + 30 * Math.pow(l, 1.5));
      out.needSame = [1, 5, 10, 16].every((l) => G.xpNeed(l) === poly(l));
      out.ratio = [20, 35, 55].map((l) => +(G.xpNeed(l + 1) / G.xpNeed(l)).toFixed(3));
      const e = (level, extra) => Object.assign({ level, def: G.MOBS.husk, elite: false, isBoss: false }, extra);
      out.k = [0, 3, 5, 8, 12, 30].map((d) => +(G.killXp(e(20), 20 + d) / G.mobXp(20)).toFixed(3));
      out.under = +(G.killXp(e(40), 20) / G.mobXp(28)).toFixed(3); // 高出 8 级以上的部分不再多给
      out.boss = +(G.killXp(e(20, { isBoss: true }), 20) / G.mobXp(20)).toFixed(1);
      // 每个区域按顺序清一遍（层级 0 → 2），只算经验
      const keep = { zi: G.state.zoneIdx, tier: G.state.tier };
      let lvl = 1, xp = 0;
      const gain = (v) => { xp += v; while (lvl < 60 && xp >= G.xpNeed(lvl)) { xp -= G.xpNeed(lvl); lvl++; } };
      out.rows = [];
      out.nz = G.ZONES.length;
      out.tl = G.TIER_LEVELS;
      for (let t = 0; t < 3; t++) for (let z = 0; z < G.ZONES.length; z++) {
        G.enterZone(z, t);
        const list = G.state.enemies.filter((q) => !q.dead).sort((a, b) => (a.isBoss - b.isBoss) || (a.level - b.level));
        for (const q of list) gain(G.killXp(q, lvl));
        out.rows.push({ zl: G.state.zone.level, lvl });
      }
      G.enterZone(keep.zi, keep.tier);
      return out;
    });
    assert(r.needSame, '16 级以内的升级经验应与改版前相同');
    assert(r.ratio.every((x) => Math.abs(x - 1.17) < 0.002), '16 级以上每级所需经验应按 1.17 倍增长：' + r.ratio);
    assert(r.k[0] === 1 && r.k[1] === 1 && r.k[2] < 0.6 && r.k[3] < 0.4 && r.k[4] < 0.1 && r.k[5] === 0.02, '压级经验应逐级递减并有下限：' + r.k);
    assert(r.under === 1 && r.boss === 20, '越级经验应封顶、首领 20 倍：' + JSON.stringify(r));
    assert(r.nz === 5 && r.tl === 20 && r.rows.length === 15, '应是五个区域、每层 +20：' + JSON.stringify({ nz: r.nz, tl: r.tl }));
    assert(r.rows.map((x) => x.zl).join() === '1,5,9,13,17,21,25,29,33,37,41,45,49,53,57', '各区域的怪物等级应是 1 / 5 / 9 / 13 / 17，每层 +20：' + r.rows.map((x) => x.zl));
    const off = r.rows.filter((x) => x.lvl < 60).map((x) => x.lvl - x.zl);
    assert(off.length >= 13 && off.every((d) => d >= 2 && d <= 7), '清完每个区域时角色应只比怪物高 2–7 级（60 级封顶的不算）：' + JSON.stringify(r.rows));
    // 前四个区域和改版前一样（19 级左右打完烬渊深处）；第五区打完 22–25 级；层级 1 末区（37–40 级的怪）打完 41–45 级
    assert(r.rows[3].lvl >= 18 && r.rows[3].lvl <= 21 && r.rows[4].lvl >= 22 && r.rows[4].lvl <= 25 && r.rows[9].lvl >= 41 && r.rows[9].lvl <= 45, '各层级末区的角色等级不对：' + JSON.stringify(r.rows));
    return '清完各区域后的等级：' + r.rows.map((x) => x.lvl + '@' + x.zl).join(' ');
  });

  await step('词缀：物品等级 31 / 38 / 46 / 55 解锁第 7–10 阶，按同样的倍率接着涨（抗性 / 速度类放缓）；24 级以内的 6 阶不变；高阶词缀在物品详情里显示 T7–T10', async () => {
    const r = await ev(() => {
      const out = { ilvl: G.TIER_ILVL.join() };
      const A = G.AFFIX_BY_ID;
      const oldR = (d, t) => { const k = Math.pow(d.g, t); const lo = Math.round(d.lo * k); return [lo, Math.max(lo, Math.round(d.hi * k))].join('-'); };
      out.same = G.AFFIXES.every((d) => [0, 1, 2, 3, 4, 5].every((t) => G.affixRange(d, t).join('-') === oldR(d, t)));
      out.life = [5, 6, 7, 8, 9].map((t) => G.affixRange(A.life, t)[1]);
      out.lifeExact = G.affixRange(A.life, 9).join('-') === oldR(A.life, 9);
      out.res = G.affixRange(A.resFire, 9)[1];
      out.resOld = Math.round(10 * Math.pow(1.3, 9));
      const top = (ilvl) => { let m = 0; for (let i = 0; i < 300; i++) for (const a of G.rollItem(ilvl, 2).affixes) m = Math.max(m, a.tier); return m; };
      out.top = [24, 30, 31, 38, 46, 55, 64].map(top);
      // 详情里的高阶标签
      let it = null;
      for (let i = 0; i < 200 && !it; i++) { const c = G.rollItem(60, 2, 'helm'); if (c.affixes.some((a) => a.tier === 9)) it = c; }
      G.save.bag.length = Math.min(G.save.bag.length, 30);
      G.save.bag.push(it);
      G.ui.open('inv');
      const card = document.querySelector('[data-item="' + it.uid + '"]');
      out.card = !!card;
      return out;
    });
    assert(r.ilvl === '1,5,9,13,18,24,31,38,46,55', '词缀阶的物品等级不对：' + r.ilvl);
    assert(r.same, '前 6 阶的数值应与改版前完全相同');
    assert(r.lifeExact && r.life.every((v, i) => i === 0 || v > r.life[i - 1]), '生命词缀的高阶应按同样的倍率接着涨：' + r.life);
    assert(r.res < r.resOld && r.res >= 45, '抗性词缀的高阶应放缓：' + r.res + ' vs ' + r.resOld);
    assert(r.top.join() === '5,5,6,7,8,9,9', '各物品等级能出的最高阶不对：' + r.top);
    assert(r.card, '背包里找不到那件高阶物品');
    const uid = await ev(() => G.save.bag[G.save.bag.length - 1].uid);
    await page.hover('[data-item="' + uid + '"]', { force: true });
    await until(() => document.getElementById('tip').classList.contains('on'));
    const tip = await ev(() => ({ t10: !!document.querySelector('#tip .ic-tier.t10'), txt: document.getElementById('tip').innerText }));
    assert(tip.t10 && tip.txt.includes('T10'), '高阶词缀在详情里应显示 T10：' + tip.txt.slice(0, 200));
    await ev(() => { G.save.bag.pop(); });
    await closePanel();
    return '各物品等级最高阶 ' + r.top.join('/') + ' · 生命词缀 T6–T10 上限 ' + r.life.join('/');
  });

  await step('天赋盘：128 个节点（8 个基石，远程改版加了枪械 / 弓各 4 个，焚骨祭司 3 个），原有 117 个节点的 id / 位置 / 连线不变，全部连通；满级的点数点不满', async () => {
    const r = await ev(() => {
      const T = G.TREE;
      const ids = Object.keys(T).filter((id) => id !== 'start');
      const kinds = {};
      for (const id of ids) kinds[T[id].kind] = (kinds[T[id].kind] || 0) + 1;
      const OLD = 'sm0-start sm0-sm1 sm1-sm2 sm2-sm3 sm2-sr0 sm3-sm4 sm4-sm5 sk-sm5 sl0-sm1 sl0-sl1 sl1-sl2 sr0-sr1 sr1-sr2 dm0-start dm0-dm1 dm1-dm2 dm2-dm3 dm2-dr0 dm3-dm4 dm4-dm5 dk-dm5 dl0-dm1 dl0-dl1 dl1-dl2 dr0-dr1 dr1-dr2 im0-start im0-im1 im1-im2 im2-im3 im2-ir0 im3-im4 im4-im5 ik-im5 il0-im1 il0-il1 il1-il2 ir0-ir1 ir1-ir2 mm0-start mm0-mm1 mm1-mm2 mm2-mm3 mm2-mr0 mm3-mm4 mk-mm4 ml0-mm1 ml0-ml1 mr0-mr1'.split(' ');
      const edgesOk = OLD.every((e) => { const [a, b] = e.split('-'); return T[a] && T[b] && T[a].links.includes(b) && T[b].links.includes(a); });
      const symmetric = ids.every((id) => T[id].links.every((l) => T[l] && T[l].links.includes(id)));
      const seen = new Set(['start']);
      const q = ['start'];
      while (q.length) for (const l of T[q.pop()].links) if (!seen.has(l)) { seen.add(l); q.push(l); }
      const keep = { level: G.save.level, kills: Object.assign({}, G.save.bossKills) };
      G.save.level = 60;
      for (const k of Object.keys(G.BOSSES)) G.save.bossKills[k] = true;
      const pts = G.passivePoints().total;
      G.save.level = keep.level;
      G.save.bossKills = keep.kills;
      return {
        n: ids.length, kinds, edgesOk, symmetric, all: seen.size === ids.length + 1, pts, bosses: Object.keys(G.BOSSES).length,
        ranged: ['gn0', 'gn1', 'gn2', 'gnn', 'bw0', 'bw1', 'bw2', 'bwn'].map((id) => T[id] ? Object.keys(T[id].stats).join('+') : '-').join(' '),
        // 新节点和别的节点都隔开至少 0.8 个单位（48 像素），面板上不挤
        gap: Math.round(Math.min(...['gn0', 'gn1', 'gn2', 'gnn', 'bw0', 'bw1', 'bw2', 'bwn', 'mp0', 'mp1', 'mpn'].map((a) => Math.min(...ids.filter((b) => b !== a).map((b) => Math.hypot(T[a].x - T[b].x, T[a].y - T[b].y)))))),
        sk: [Math.round(T.sk.x * 100) / 100, Math.round(T.sk.y * 100) / 100].join(), mr1: [Math.round(T.mr1.x * 100) / 100, Math.round(T.mr1.y * 100) / 100].join(),
        newK: ids.filter((id) => T[id].kind === 'keystone' && /2$/.test(id)).map((id) => T[id].name).join('/'),
      };
    });
    assert(r.n === 128 && r.kinds.keystone === 8 && r.kinds.notable === 27, '天赋盘的规模不对：' + JSON.stringify(r));
    assert(/heatGain/.test(r.ranged) && /heatDmg/.test(r.ranged) && /rDmg/.test(r.ranged) && /focusGain/.test(r.ranged) && /buffDur/.test(r.ranged) && /rangeDmg/.test(r.ranged) && r.gap >= 48, '远程的 8 个节点（热度 / 热度伤害 / 热度技；专注 / 增益时长 / 远距离）不对或挤在一起：' + r.ranged + ' 间距 ' + r.gap);
    assert(r.edgesOk && r.symmetric && r.all, '原有连线应保留、连线双向、所有节点与起点连通：' + JSON.stringify(r));
    assert(r.sk === '-400.1,231' && r.mr1 === '332.73,-46.76', '原有节点的位置不应移动：' + r.sk + ' ' + r.mr1);
    assert(r.pts === 59 + 2 * r.bosses && r.pts < r.n, '满级 60 级应有 59 + 每个首领 2 点、点不满整个盘：' + r.pts);
    return r.n + ' 个节点（核心 ' + r.kinds.notable + '、基石 ' + r.kinds.keystone + '：新增 ' + r.newK + '）· 满级 ' + r.pts + ' 点';
  });

  await step('天赋页：全览放得下整个盘；滚轮缩放、拖动平移、全览按钮复位；缩放后照常点亮与悬停提示，基石的代价标红', async () => {
    await ev(() => { G.debug.setLevel(30); G.resetPassives(); G.ui.open('tree'); });
    const vb = () => ev(() => document.getElementById('tree-svg').getAttribute('viewBox').split(' ').map(Number));
    const v0 = await vb();
    // 全览：每个节点都在视口里
    const inView = await ev(() => {
      const svg = document.getElementById('tree-svg').getBoundingClientRect();
      return Array.from(document.querySelectorAll('#tree-svg .tn .shape')).every((n) => { const r = n.getBoundingClientRect(); return r.left >= svg.left && r.right <= svg.right && r.top >= svg.top && r.bottom <= svg.bottom; });
    });
    assert(inView, '全览时应能看到全部节点');
    const box = await ev(() => { const r = document.getElementById('tree-svg').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(box.x - 120, box.y + 40);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -240);
    await frames(2);
    const v1 = await vb();
    assert(v1[2] < v0[2] * 0.75, '滚轮应放大：' + v0 + ' → ' + v1);
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + 50, { steps: 5 });
    await page.mouse.up();
    const v2 = await vb();
    assert(v2[2] === v1[2] && (v2[0] < v1[0] || v2[1] < v1[1]), '拖动应平移视口：' + v1 + ' → ' + v2);
    assert((await ev(() => G.save.passives.length)) === 1, '拖动松手不应点亮天赋');
    // 放大后点亮：起点旁的体魄
    await ev(() => { document.querySelector('[data-z="fit"]').click(); });
    await page.click('[data-z="in"]');
    await page.click('#tree-svg [data-node="sm0"] .hit', { force: true });
    assert(await ev(() => G.save.passives.includes('sm0')), '放大后应能照常点亮');
    const v3 = await vb();
    assert(v3[2] < v0[2], '点亮后重绘不应丢掉缩放');
    await page.click('[data-z="fit"]');
    const v4 = await vb();
    assert(v4.join() === v0.join(), '全览按钮应复位：' + v4);
    await page.hover('#tree-svg [data-node="mk2"] .hit', { force: true });
    await until(() => document.getElementById('tip').classList.contains('on'));
    const tip = await ev(() => ({ txt: document.getElementById('tip').innerText, bad: Array.from(document.querySelectorAll('#tip .tc-stat.bad')).map((n) => n.textContent) }));
    assert(tip.txt.includes('器魂共鸣') && tip.txt.includes('基石天赋') && tip.bad.length === 2 && tip.bad.some((t) => t.includes('最大生命额外 -15%')), '新基石的提示不对：' + JSON.stringify(tip));
    await page.hover('#tree-svg [data-node="sk2"] .hit', { force: true });
    await until(() => document.getElementById('tip').innerText.includes('不动如山'));
    const t2 = await ev(() => document.getElementById('tip').innerText);
    assert(t2.includes('移动速度降低 15%') && t2.includes('翻滚冷却延长 50%'), '负值的写法应换成反义词：' + t2);
    // 元素过载的抗性代价在 75% 上限之后才扣：溢出的抗性抵消不了
    await page.hover('#tree-svg [data-node="ik2"] .hit', { force: true });
    await until(() => document.getElementById('tip').innerText.includes('元素过载'));
    const t3 = await ev(() => Array.from(document.querySelectorAll('#tip .tc-stat.bad')).map((n) => n.textContent));
    assert(t3.length === 1 && t3[0].includes('上限之后'), '元素过载的代价应标红并写明在上限之后扣除：' + t3);
    const rl = await ev(() => {
      const st = G.TREE.start.stats;
      const P = G.player;
      G.TREE.start.stats = { resFire: 130, resCold: 40 };
      G.computeStats();
      const a = [P.res.fire, P.res.cold];
      G.TREE.start.stats = { resFire: 130, resCold: 40, resLoss: G.TREE.ik2.stats.resLoss };
      G.computeStats();
      const b = [P.res.fire, P.res.cold];
      G.TREE.start.stats = st;
      G.computeStats();
      return { a, b };
    });
    assert(rl.a[0] === 75 && rl.b[0] === 55 && rl.b[1] === rl.a[1] - 20, '元素过载：溢出的火抗也应从 75% 掉到 55%，其余抗性同样 -20：' + JSON.stringify(rl));
    await ev(() => G.resetPassives());
    await closePanel();
    return '全览 ' + v0.map(Math.round).join(' ') + ' · 放大到 ' + Math.round((v0[2] / v1[2]) * 100) + '%';
  });

  await step('旧存档：改版前点过的天赋原样保留并提示一次；物品等级 27 以上的旧武器按新成长放大一次；宝石补到新的成长下限；等级不变，经验条进度按新曲线折算', async () => {
    const r = await ev(() => {
      const KEY = 'cinder-abyss-save-v1';
      const keep = localStorage.getItem(KEY);
      const raw = JSON.parse(keep);
      delete raw.gv; // 改版前的存档没有 gv
      raw.level = 42;
      raw.xp = 1234;
      raw.bossKills = { golem: true, weaver: true, warden: true, lord: true };
      // 改版前：49 个节点全部点满（42 级 + 4 个首领 = 49 点）
      raw.passives = ['start'].concat(Object.keys(G.TREE).filter((id) => /^([sdi](m[0-5]|k|l[0-2]|r[0-2])|mm[0-4]|mk|ml[01]|mr[01])$/.test(id)));
      const w = G.rollItem(31, 2, 'weapon', 0);
      w.wbase = [33, 49]; // 改版前 27 级封顶时的平均成色
      w.uid = 'oldw31';
      raw.equip = Object.assign({}, raw.equip, { weapon: w });
      raw.skills = { cleave: 20, ember: 20, thrall: 20 };
      raw.sockets = { cleave: [null, null, null], ember: [null, null, null], thrall: [null, null, null] };
      raw.bar = ['cleave', 'ember', 'thrall', null];
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      G.computeStats();
      const s = G.save;
      const out = {
        level: s.level, xp: s.xp, n: s.passives.length - 1, mig: G.growthMigrated && G.growthMigrated.kept, gv: s.gv,
        frac0: 1234 / G.xpNeedOld(42), frac: s.xp / G.xpNeed(42),
        wbase: s.equip.weapon.wbase.join('-'), want: [Math.round(33 * G.weaponLvlK(31) / G.weaponLvlK(27)), Math.round(49 * G.weaponLvlK(31) / G.weaponLvlK(27))].join('-'),
        gems: [s.skills.cleave, s.skills.ember, s.skills.thrall].join(), free: G.passivePoints().free,
      };
      // 存档再读一遍：不会再放大第二次，也不再提示
      G.persist();
      G.loadSave();
      out.again = G.save.equip.weapon.wbase.join('-');
      out.xp2 = G.save.xp;
      out.mig2 = G.growthMigrated;
      out.keep = keep;
      return out;
    });
    assert(r.level === 42 && r.gv === 2 && Math.abs(r.frac - r.frac0) < 1e-9 && r.frac0 > 0.1 && Math.abs(r.xp2 - r.xp) < 1e-6, '等级应保持不变、经验条进度按新的升级所需经验折算一次：' + JSON.stringify(r));
    assert(r.n === 49 && r.mig === 49 && r.free === 0, '旧存档的 49 个天赋应全部保留：' + JSON.stringify(r));
    assert(r.wbase === r.want && r.again === r.want, '高物品等级的旧武器应按新成长放大一次：' + JSON.stringify(r));
    assert(r.gems === '32,32,32' && r.mig2 === null, '宝石应补到 42 级的成长下限 32，第二次读档不再提示：' + JSON.stringify(r));
    // 提示：读进旧存档后出现一次「成长改版」
    await ev(() => {
      const KEY = 'cinder-abyss-save-v1';
      const raw = JSON.parse(localStorage.getItem(KEY));
      delete raw.gv;
      raw.level = 45; // 多出 3 点可用天赋点
      // 其余提示都标成看过：只等这一条
      raw.tut = {};
      for (const id of G.ui.hints().all) if (id !== 'growth') raw.tut[id] = 1;
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      G.computeStats();
      G.clearEnemies();
      G.debug.hold(false);
    });
    await until(() => G.ui.hints().current === 'growth', null, 20000).catch(() => { throw new Error('读进旧存档后应提示一次成长改版'); });
    const txt = await ev(() => document.getElementById('coach').innerText);
    // 节点总数跟着天赋盘走（远程改版后是 125）
    const nTree = await ev(() => Object.keys(G.TREE).length - 1);
    assert(txt.includes(String(nTree)) && txt.includes('全部保留') && txt.includes('3'), '成长改版的提示不对：' + txt);
    await ev((keep) => {
      G.debug.hold(true);
      localStorage.setItem('cinder-abyss-save-v1', keep);
      G.loadSave();
      G.save.tut.growth = 1;
      G.computeStats();
      G.persist();
    }, r.keep);
    return '49 个旧天赋保留 · 旧武器 ' + r.wbase + ' · 宝石 Lv ' + r.gems;
  });

  await step('旧存档（第五区上线前）：打通过烬渊深处的 maxTier / 层级 / 通关记录原样保留，提示一次新区域（看过就不再提示）；在最高层级打烬渊深处不再开新层，打坠星裂谷才开；长弓改鹰眼长弓提示一次', async () => {
    const r = await ev(() => {
      const KEY = 'cinder-abyss-save-v1';
      const keep = localStorage.getItem(KEY);
      const raw = JSON.parse(keep);
      // 第五区上线前的老角色：层级 2 打通了烬渊深处（因此开了层级 3），站在层级 2 的烬渊深处
      raw.cleared = { ash: 2, frost: 2, storm: 2, abyss: 2 };
      raw.maxTier = 3;
      raw.tier = 2;
      raw.lastZone = 3;
      raw.tut = {};
      const bow = G.rollItem(30, 0, 'weapon', 5);
      bow.baseName = G.BOW_OLD_NAMES[1];
      bow.uid = 'oldbow';
      raw.bag = [bow];
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      const s = G.save;
      const out = { maxTier: s.maxTier, tier: s.tier, cleared: JSON.stringify(s.cleared), notice: G.newZoneNotice, bowMig: G.bowMigrated, bowName: s.bag[0].baseName };
      out.fresh = G.zoneNoticeFor(null) || G.zoneNoticeFor({ v: 1 }) || G.zoneNoticeFor({ v: 1, cleared: { abyss: 0, rift: 0 } }) || G.zoneNoticeFor({ v: 1, cleared: { abyss: 0 }, tut: { zone5: 1 } });
      // 地图：层级 2 里坠星裂谷已经能进（烬渊深处在层级 2 打通过），层级 3 里只开第一个区域
      G.ui.open('map');
      document.querySelector('[data-act="tier"][data-tier="2"]').click();
      out.lock2 = document.querySelectorAll('.zone.locked').length;
      out.cards = document.querySelectorAll('.map .zone').length;
      document.querySelector('[data-act="tier"][data-tier="3"]').click();
      out.lock3 = document.querySelectorAll('.zone.locked').length;
      out.txt3 = document.querySelector('.map').innerText;
      G.ui.close();
      // 在最高层级（3）打烬渊深处：不开新层；打坠星裂谷：开层级 4
      G.debug.god(true);
      const kill = (zi) => {
        G.enterZone(zi, 3);
        const b = G.state.boss;
        let n = 0;
        while (!b.dead && n < 50) { G.hitEnemy(b, G.skillCtx('cleave'), 1e6); n++; }
        return G.save.maxTier;
      };
      out.afterAbyss = kill(3);
      out.afterRift = kill(4);
      out.riftLv = G.state.zone.level;
      G.debug.god(false);
      // 改名后的存档在提示弹出前就存了一次再读（第一次会话很短）：长弓提示仍在
      G.persist();
      G.loadSave();
      out.bowMigKeep = G.bowMigrated + '/' + G.save.bowMig;
      // 看过提示后存档再读：不再提示
      G.save.tut.zone5 = 1;
      G.save.tut.bowmig = 1;
      G.persist();
      G.loadSave();
      out.notice2 = G.newZoneNotice;
      out.bowMig2 = G.bowMigrated;
      out.keep = keep;
      return out;
    });
    try {
      assert(r.maxTier === 3 && r.tier === 2 && r.cleared === '{"ash":2,"frost":2,"storm":2,"abyss":2}', '老角色的层级与通关记录应原样保留：' + JSON.stringify(r));
      assert(r.notice === true && r.notice2 === false && !r.fresh, '打通过烬渊深处、没打过坠星裂谷的老存档应提示一次，看过 / 新存档 / 已打过第五区的不提示：' + JSON.stringify(r));
      assert(r.cards === 5 && r.lock2 === 0 && r.lock3 === 4 && r.txt3.includes('坠星裂谷') && new RegExp('怪物等级\\s*' + (17 + 3 * 20)).test(r.txt3), '地图：层级 2 五个区域都能进、层级 3 只开首区，第五区怪物等级 77：' + JSON.stringify(r));
      assert(r.afterAbyss === 3 && r.afterRift === 4 && r.riftLv === 77, '在最高层级打烬渊深处不应开新层，打坠星裂谷才开：' + JSON.stringify(r));
      assert(r.bowMig === 1 && r.bowName === '鹰眼长弓' && r.bowMigKeep === '1/true' && r.bowMig2 === 0, '旧长弓应改成鹰眼长弓，提示看过之前重读存档也还在，看过后不再提示：' + JSON.stringify(r));
    } catch (err) {
      await ev((keep) => { localStorage.setItem('cinder-abyss-save-v1', keep); G.loadSave(); G.computeStats(); }, r.keep);
      throw err;
    }
    // 提示：其余提示都标成看过，等「新区域」和「远程改版」两条依次出现
    await ev(() => {
      const KEY = 'cinder-abyss-save-v1';
      const raw = JSON.parse(localStorage.getItem(KEY));
      raw.tut = {};
      for (const id of G.ui.hints().all) if (id !== 'zone5' && id !== 'bowmig') raw.tut[id] = 1;
      raw.cleared = { ash: 2, frost: 2, storm: 2, abyss: 2 };
      raw.maxTier = 3;
      const bow = G.rollItem(30, 0, 'weapon', 5);
      bow.baseName = G.BOW_OLD_NAMES[0];
      raw.bag = [bow];
      localStorage.setItem(KEY, JSON.stringify(raw));
      G.loadSave();
      G.computeStats();
      G.enterZone(0, 0);
      G.clearEnemies();
      G.debug.hold(false);
    });
    const seen = {};
    for (let i = 0; i < 2; i++) {
      await until(() => ['zone5', 'bowmig'].includes(G.ui.hints().current) && !G.save.tut[G.ui.hints().current], null, 40000).catch(() => { throw new Error('读进旧存档后应依次提示新区域与远程改版：' + JSON.stringify(seen)); });
      const h = await ev(() => ({ id: G.ui.hints().current, txt: document.getElementById('coach').innerText }));
      seen[h.id] = h.txt;
      await ev((id) => { G.save.tut[id] = 1; }, h.id);
    }
    await ev((keep) => {
      G.debug.hold(true);
      localStorage.setItem('cinder-abyss-save-v1', keep);
      G.loadSave();
      G.save.tut.zone5 = G.save.tut.bowmig = 1;
      G.computeStats();
      G.persist();
    }, r.keep);
    assert(seen.zone5 && seen.zone5.includes('坠星裂谷') && seen.zone5.includes('+20'), '新区域提示不对：' + JSON.stringify(seen));
    assert(seen.bowmig && seen.bowmig.includes('鹰眼长弓'), '远程改版提示不对：' + JSON.stringify(seen));
    return '层级 3 保留 · 打烬渊深处 → ' + r.afterAbyss + ' · 打坠星裂谷 → ' + r.afterRift + ' · 旧长弓 → ' + r.bowName;
  });

  await step('召唤物继承装备：武器伤害 / 护甲 / 抗性 / 装备生命按天赋比例继承（魂幡按倍数计、物品等级 12–46 之间折算），受击时护甲与抗性生效，技能卡写出明细', async () => {
    const r = await ev(() => {
      T.arena();
      const save = G.save, P = G.player;
      G.debug.setLevel(55);
      for (const k of Object.keys(G.BOSSES)) save.bossKills[k] = true;
      G.resetPassives();
      save.skills.thrall = save.skills.thrall || G.gemFloor();
      save.skills.colossus = save.skills.colossus || G.gemFloor();
      save.sockets.thrall = [null, null, null];
      save.sockets.colossus = [null, null, null];
      // 一把刃：物品等级 50，没有本地词缀
      const blade = G.rollItem(50, 0, 'weapon', 0);
      blade.wbase = [100, 140];
      G.refreshWeapon(blade);
      save.equip.weapon = blade;
      // 其余装备的物品等级临时改成 50（防御 / 生命的继承按它们的平均物品等级折算，50 ≥ 46 不打折）
      const ilvl0 = {};
      for (const sl of G.SLOTS) if (sl !== 'weapon' && save.equip[sl]) { ilvl0[sl] = save.equip[sl].ilvl; save.equip[sl].ilvl = 50; }
      G.computeStats();
      const base0 = G.skillCtx('thrall').base.phys.slice();
      const life0 = G.skillCtx('thrall').minion.life;
      const out = {};
      // 武器线：承锋 + 承锋 + 器灵（4 + 5 + 12 = 21%）
      for (const id of ['mm0', 'mm1', 'ml0', 'ml1', 'ml2', 'ml3', 'ml4']) G.allocPassive(id);
      let c = G.skillCtx('thrall');
      out.w = P.S.mWeapon;
      out.add = [c.base.phys[0] - base0[0], c.base.phys[1] - base0[1]].map((v) => Math.round(v * 100) / 100);
      out.addC = G.skillCtx('colossus').minion.inherit.add.map((v) => Math.round(v * 100) / 100);
      // 魂幡：武器伤害按 2.2 倍计；物品等级 29 只继承一半（12 级起折算，46 级才完整）
      const banner = G.rollItem(29, 0, 'weapon', 7);
      banner.wbase = [10, 20];
      G.refreshWeapon(banner);
      save.equip.weapon = banner;
      G.computeStats();
      c = G.skillCtx('thrall');
      out.banner = c.minion.inherit.add.map((v) => Math.round(v * 100) / 100);
      out.gate = c.minion.inherit.gate;
      out.gates = [5, 12, 14, 19, 29, 46, 60].map((l) => Math.round(G.inheritGate(l) * 1000) / 1000);
      save.equip.weapon = blade;
      // 防御线：骸甲 / 骸甲 / 承甲（6 + 8 + 20 = 34%）
      for (const id of ['mm2', 'mr0', 'mr1', 'mr2', 'mr3', 'mr4']) G.allocPassive(id);
      G.computeStats();
      c = G.skillCtx('thrall');
      out.def = P.S.mDef;
      out.arm = [c.minion.armour, Math.round(P.armour * 0.34)];
      out.res = [c.minion.res.fire, Math.min(75, P.res.fire * 0.34)].map((v) => Math.round(v * 100) / 100);
      out.gateDef = c.minion.inherit.gateDef;
      // 生命：同命（30%），装备生命 × 30%（再吃召唤物生命加成）
      for (const id of ['mr5', 'mr6']) G.allocPassive(id);
      G.computeStats();
      c = G.skillCtx('thrall');
      out.gearLife = P.gearLife;
      out.inhLife = c.minion.inherit.life;
      out.lifeWant = Math.round(P.gearLife * 0.3);
      out.lifeUp = c.minion.life > life0;
      // 受击：同一下物理 / 火焰伤害，继承了护甲和抗性的仆从受到的更少
      const m = G.summonMinion('thrall', P.x + 2, P.z);
      G.debug.step(1.2);
      const hit = (dtype) => { const hp = m.hp; G.hurtMinion(m, 50, dtype); const d = hp - m.hp; m.hp = m.maxHp; return Math.round(d * 100) / 100; };
      out.phys = hit('phys');
      out.fire = hit('fire');
      out.mArm = m.armour;
      out.mRes = m.res && m.res.fire;
      // 层级 0 的装备（物品等级 14）：防御 / 生命几乎继承不到（此时防御线已点到骸甲 ×3 + 承甲 = 42%）
      for (const sl in ilvl0) save.equip[sl].ilvl = 14;
      G.computeStats();
      c = G.skillCtx('thrall');
      out.low = { gateDef: Math.round(c.minion.inherit.gateDef * 1000) / 1000, arm: c.minion.armour, armWant: Math.round(P.armour * 0.42 * G.inheritGate(14)), life: c.minion.inherit.life };
      for (const sl in ilvl0) save.equip[sl].ilvl = 50;
      G.computeStats();
      // 技能卡
      G.ui.open('skills');
      const card = Array.from(document.querySelectorAll('.skill-card')).find((q) => q.querySelector('.sk-name') && q.querySelector('.sk-name').textContent.includes('烬骸仆从'));
      out.card = card ? card.querySelector('.sk-inh') && card.querySelector('.sk-inh').innerText : null;
      G.ui.close();
      G.clearMinions();
      for (const sl in ilvl0) save.equip[sl].ilvl = ilvl0[sl];
      G.computeStats();
      return out;
    });
    const near = (a, b) => Math.abs(a - b) < 0.02;
    assert(r.w === 21 && near(r.add[0], 100 * 0.21) && near(r.add[1], 140 * 0.21), '仆从每击应附加武器伤害 × 21%：' + JSON.stringify(r));
    assert(near(r.addC[0], 100 * 0.21 * 2.4) && near(r.addC[1], 140 * 0.21 * 2.4), '守像的继承系数应为 2.4：' + JSON.stringify(r.addC));
    assert(r.gate === 0.5 && near(r.banner[0], 10 * 0.21 * 0.5 * 2.2) && near(r.banner[1], 20 * 0.21 * 0.5 * 2.2), '魂幡 2.2 倍、物品等级 29 折算一半：' + JSON.stringify(r));
    assert(r.gates.join() === [0, 0, 0.059, 0.206, 0.5, 1, 1].join(), '继承折算：物品等级 12 以下为 0，46 级涨满：' + r.gates);
    assert(r.def === 34 && r.gateDef === 1 && r.arm[0] === r.arm[1] && r.arm[0] > 0 && r.res[0] === r.res[1], '护甲与抗性应按 34% 继承：' + JSON.stringify(r));
    assert(r.inhLife === r.lifeWant && r.gearLife > 0 && r.lifeUp, '装备生命应按 30% 继承：' + JSON.stringify(r));
    assert(r.low.gateDef === 0.059 && Math.abs(r.low.arm - r.low.armWant) <= 1 && Math.abs(r.low.life - r.gearLife * 0.3 * (2 / 34)) <= 1, '层级 0 的装备只继承约 6%：' + JSON.stringify(r.low));
    assert(r.mArm > 0 && r.phys < 50 && (r.mRes > 0 ? r.fire < 50 : true), '继承来的护甲 / 抗性在受击时应生效：' + JSON.stringify(r));
    assert(r.card && r.card.includes('继承装备') && r.card.includes('护甲') && r.card.includes('生命 +'), '技能卡上应写出继承明细：' + r.card);
    await ev(() => { G.resetPassives(); G.debug.setLevel(12); G.computeStats(); });
    return '刃 100–140 × 17% → +' + r.add.join('–') + ' / 每击 · 护甲 ' + r.arm[0] + ' · 物理 50 → ' + r.phys + ' · 卡片：' + r.card;
  });

  await step('怪物曲线：16 级以内（前四个区域）的生命 / 伤害与改版前逐级相同；17 级以上按新曲线平滑成长，比改版前平缓；每层 +20 级时 17–32 级照旧、33–40 / 41 级以上各换一档倍率', async () => {
    const r = await ev(() => {
      const out = {};
      out.same = Array.from({ length: 16 }, (_, i) => i + 1).every((l) => G.hpScale(l) === Math.pow(1.2, l - 1) && G.dmgScale(l) === Math.pow(1.15, l - 1));
      const lv = [16, 17, 20, 24, 32, 40, 48, 60, 64];
      // 每层 5 个区域、+20 级：17–32 级和每层 16 级时一样（1.09 / 1.10 每级），33–40 级每级 1.12 / 1.03，41 级以上 1.08 / 1.03
      const h16 = Math.pow(1.2, 15), d16 = Math.pow(1.15, 15);
      out.tl = G.TIER_LEVELS;
      out.mid = Array.from({ length: 16 }, (_, i) => i + 17).every((l) => Math.abs(G.hpScale(l) / (h16 * Math.pow(1.09, l - 16)) - 1) < 1e-9 && Math.abs(G.dmgScale(l) / (d16 * Math.pow(1.1, l - 16)) - 1) < 1e-9);
      const rk = (f, l) => +(f(l + 1) / f(l)).toFixed(4);
      out.step = [rk(G.hpScale, 35), rk(G.dmgScale, 35), rk(G.hpScale, 50), rk(G.dmgScale, 50)];
      out.hp = lv.map((l) => +G.hpScale(l).toFixed(1));
      out.dmg = lv.map((l) => +G.dmgScale(l).toFixed(1));
      out.mono = lv.every((l, i) => i === 0 || (G.hpScale(l) > G.hpScale(lv[i - 1]) && G.dmgScale(l) > G.dmgScale(lv[i - 1])));
      out.flatter = lv.slice(1).every((l) => G.hpScale(l) < Math.pow(1.2, l - 1) && G.dmgScale(l) < Math.pow(1.15, l - 1));
      // 实际生成的怪：层级 0 末区的巨躯生命与改版前一样
      const keep = { zi: G.state.zoneIdx, tier: G.state.tier };
      G.enterZone(3, 0);
      const e = G.spawnMob('brute', G.state.zone.start.x, G.state.zone.start.z, 15, {});
      out.brute = [e.maxHp, Math.round(100 * Math.pow(1.2, 14))];
      G.enterZone(keep.zi, keep.tier);
      return out;
    });
    assert(r.same && r.brute[0] === r.brute[1], '16 级以内的怪物曲线应与改版前完全相同：' + JSON.stringify(r));
    assert(r.mono && r.flatter, '17 级以上应单调成长且比改版前平缓：' + JSON.stringify(r));
    assert(r.tl === 20 && r.mid && r.step.join() === '1.12,1.03,1.08,1.03', '每层 +20 级的曲线分段不对：' + JSON.stringify(r));
    return '生命倍率 ' + r.hp.join('/') + ' · 伤害倍率 ' + r.dmg.join('/') + '（16/17/20/24/32/40/48/60/64 级）';
  });

  // ---------------- 烬铸武器（稀有度 3）----------------
  await step('烬铸：固定名字 / 武器类型 / 词缀行，数值在区间里掷（区间随物品等级走），完美度是各行位置的平均；基础伤害按物品等级成长', async () => {
    ({ n: G_CUR_N, c: G_UQ_COLOR, i: G_SOUL_INH, k: G_SOUL_K } = await ev(() => ({ n: G.CUR_IDS.length, c: G.RARITY_COLOR[3], i: G.SOULFIRE.inherit, k: G.SOULFIRE.k })));
    const r = await ev(() => {
      const out = { bad: [] };
      for (const id of G.UNIQUE_IDS) {
        const U = G.UNIQUES[id];
        for (const il of [21, 30, 44, 56]) {
          for (let k = 0; k < 30; k++) {
            const it = G.rollUnique(id, il);
            if (it.rarity !== 3 || it.uq !== id || it.name !== U.name || it.slot !== 'weapon' || it.baseIdx !== U.base) out.bad.push('身份 ' + id);
            if (it.affixes.length !== U.lines.length) out.bad.push('行数 ' + id);
            it.affixes.forEach((a, i) => {
              const rg = G.uniqueRange(it, i);
              if (a.id !== U.lines[i].id || !(a.v >= rg[0] && a.v <= rg[1]) || a.v !== Math.round(a.v)) out.bad.push(id + ' 第 ' + i + ' 行 ' + a.id + '=' + a.v + ' 不在 ' + rg);
            });
            const p = G.uniquePerfect(it);
            if (!(p >= 0 && p <= 1)) out.bad.push('完美度 ' + p);
          }
        }
        // 完美度：全取下限 0、全取上限 1、中间 0.5 左右
        const lo = G.rollUnique(id, 44, 0), hi = G.rollUnique(id, 44, 1), mid = G.rollUnique(id, 44, 0.5);
        out[id] = { lo: G.uniquePerfect(lo), hi: G.uniquePerfect(hi), mid: +G.uniquePerfect(mid).toFixed(2) };
        // 手算一件：第 0 行在下限、其余在上限 → 完美度 = (行数 − 1) / 行数（固定行不计）
        const one = G.rollUnique(id, 44, 1);
        one.affixes[0].v = G.uniqueRange(one, 0)[0];
        const n = U.lines.filter((l) => l.fixed === undefined).length;
        out[id].one = [+G.uniquePerfect(one).toFixed(4), +((n - 1) / n).toFixed(4)];
        // 区间随物品等级变宽变高；伤害按普通武器的公式（成色固定 UNIQUE_BASE_Q）
        const a = G.rollUnique(id, 24, 0.5), b = G.rollUnique(id, 48, 0.5);
        out[id].grow = G.uniqueRange(b, 0)[1] > G.uniqueRange(a, 0)[1] && b.dmg[1] > a.dmg[1];
        out[id].wbase = T.canon(b.wbase) === T.canon(G.weaponBaseDmg(U.base, 48, G.UNIQUE_BASE_Q));
        // 固定行（万魂旗的 +1 仆从上限）
        U.lines.forEach((l, i) => { if (l.fixed !== undefined && b.affixes[i].v !== l.fixed) out.bad.push('固定行 ' + id); });
      }
      out.color = G.RARITY_COLOR[3] !== G.RARITY_COLOR[2] && G.RARITY_NAME[3] === '烬铸';
      out.lines = G.itemLines(G.rollUnique('wanhun', 44, 0.5)).affixes.map((a) => a.text).join('；');
      return out;
    });
    assert(!r.bad.length, '烬铸掷骰有问题：' + r.bad.slice(0, 5).join(' | '));
    for (const id of ['jinduan', 'sanxiang', 'wanhun', 'rongxin', 'jinyu']) {
      const o = r[id];
      assert(o.lo === 0 && o.hi === 1 && Math.abs(o.mid - 0.5) < 0.08 && o.one[0] === o.one[1], id + ' 的完美度算错了：' + JSON.stringify(o));
      assert(o.grow && o.wbase, id + ' 的区间 / 伤害没有随物品等级成长：' + JSON.stringify(o));
    }
    assert(r.color && /仆从数量上限 \+1/.test(r.lines), JSON.stringify(r));
    return r.lines;
  });

  await uiStep('烬铸：所有通货（含琢刻石、重铸石）都拒绝，提示「烬铸武器无法改造」，拖上去时变暗；分解要点两次「分解」，固定给一把高阶通货；提示里有完美度和区间', async () => {
    const pre = await ev(() => {
      while (G.save.bag.length > 30) G.save.bag.pop();
      const it = G.debug.giveItem(3, 'jinduan', 0.6, 44);
      for (const c of G.CUR_IDS) G.debug.give(c, 2);
      const before = T.canon(it);
      const out = { uid: it.uid, can: G.CUR_IDS.filter((c) => G.canCraft(it, c)), msgs: G.CUR_IDS.map((c) => G.craft(it, c, 0).msg) };
      out.applied = G.CUR_IDS.filter((c) => G.applyCurrency(it, c, 0));
      out.same = T.canon(it) === before;
      out.cur = G.CUR_IDS.every((c) => G.save.cur[c] >= 2);
      out.toast = T.toasts();
      out.chisel = G.chiselable(it).some(Boolean);
      return out;
    });
    assert(!pre.can.length && !pre.applied.length && pre.same && pre.cur && !pre.chisel, '烬铸武器被通货改动了：' + JSON.stringify(pre));
    assert(pre.msgs.every((m) => m === '烬铸武器无法改造') && /烬铸武器无法改造/.test(pre.toast), '拒绝的提示不对：' + JSON.stringify(pre.msgs) + ' ' + pre.toast);
    // 界面：选中后详情里有完美度、区间、机制；拖琢刻石过去时这一格变暗并写明原因
    await ev(() => G.ui.open('inv'));
    await page.click('.cell[data-item="' + pre.uid + '"]');
    const card = await ev(() => document.querySelector('.detail-card').innerText + ' | ' + document.querySelector('.detail-card').parentElement.innerText);
    assert(/完美度 \d+%/.test(card) && /（\d+–\d+）/.test(card) && /残刃/.test(card) && /烬铸武器无法改造/.test(card), '详情卡片缺内容：' + card.slice(0, 300));
    let mid = null;
    await dragTo('.cur[data-cur="chisel"]', '.cell[data-item="' + pre.uid + '"]', async () => {
      mid = await ev((u) => ({ no: document.querySelector('.cell[data-item="' + u + '"]').classList.contains('drop-no'), cap: document.querySelector('#drag-ghost em') ? document.querySelector('#drag-ghost em').textContent : '' }), pre.uid);
    });
    assert(mid && mid.no && /烬铸武器无法改造/.test(mid.cap), '拖到烬铸武器上应变暗并写明原因：' + JSON.stringify(mid));
    assert(await ev((u) => G.save.cur.chisel >= 2 && !!G.save.bag.find((b) => b.uid === u), pre.uid), '拖放后琢刻石被消耗了');
    // 分解：第一次只上膛，第二次才分解，固定得到 UNIQUE_SALVAGE
    await page.click('.cell[data-item="' + pre.uid + '"]');
    const c0 = await ev(() => Object.assign({}, G.save.cur));
    await page.click('[data-act="salvage"]');
    const armed = await ev((u) => ({ still: !!G.save.bag.find((b) => b.uid === u), msg: document.querySelector('.inv-msg') ? document.querySelector('.inv-msg').textContent : '' }), pre.uid);
    assert(armed.still && /再点一次/.test(armed.msg), '第一次点分解不应直接分解：' + JSON.stringify(armed));
    await page.click('[data-act="salvage"]');
    const done = await ev((a) => ({ gone: !G.save.bag.find((b) => b.uid === a.u), d: Object.keys(G.UNIQUE_SALVAGE).every((k) => G.save.cur[k] - a.c0[k] === G.UNIQUE_SALVAGE[k]) }), { u: pre.uid, c0 });
    assert(done.gone && done.d, '第二次点分解应分解并给出固定通货：' + JSON.stringify(done));
    return '拒绝 ' + G_CUR_N + ' 种通货 · 分解得 ' + JSON.stringify(await ev(() => G.UNIQUE_SALVAGE));
  });

  await step('烬铸掉落：轮回层级 ≥ 1 的五个首领各掉各的那一把（巨像 → 熔芯、第五区首领 → 烬羽），层级 0 不掉；层级 1 约 15%、层级 2 起约 25%；连续 2 次没掉第 3 次必掉，掉了清零；带光柱、名牌颜色、大字提示', async () => {
    const r = await ev(() => {
      const S = G.state, U = G.save.uniq;
      const keep = { tier: S.tier };
      const P = G.player;
      const boss = (kind) => ({ bossKind: kind, x: P.x + 2, z: P.z - 2, isBoss: true, level: 40 });
      const out = {};
      T.clearLoot();
      U.pity = {};
      // 绑定关系与层级门槛
      T.fix(0);
      S.tier = 0;
      const kinds = G.ZONES.map((z) => z.boss);
      out.kinds = kinds.join();
      out.t0 = kinds.map((k) => !!G.uniqueDrop(boss(k), 40));
      out.pity0 = Object.keys(U.pity).length;
      S.tier = 1;
      out.t1 = kinds.map((k) => { const l = G.uniqueDrop(boss(k), 30); return l ? l.data.uq : null; });
      out.bow = G.UNIQUES.jinyu.boss === G.ZONES[G.ZONES.length - 1].boss && G.UNIQUE_BY_BOSS[G.UNIQUES.jinyu.boss] === 'jinyu';
      // 几率：层级 1 是 15%（随机数 0.14 掉、0.16 不掉），层级 2 起 25%（0.24 掉、0.26 不掉）。每次之间清掉保底计数，只看随机数
      T.fix(0.14);
      U.pity = {};
      out.c1a = !!G.uniqueDrop(boss('warden'), 30);
      T.fix(0.16);
      U.pity = {};
      out.c1b = !!G.uniqueDrop(boss('warden'), 30);
      S.tier = 2;
      U.pity = {};
      out.c2b0 = !!G.uniqueDrop(boss('warden'), 46);
      T.fix(0.24);
      U.pity = {};
      out.c2a = !!G.uniqueDrop(boss('warden'), 46);
      T.fix(0.26);
      U.pity = {};
      out.c2b = !!G.uniqueDrop(boss('warden'), 46);
      S.tier = 5;
      T.fix(0.2);
      U.pity = {};
      out.c5 = !!G.uniqueDrop(boss('warden'), 90);
      out.chance = [G.uniqueChance(0), G.uniqueChance(1), G.uniqueChance(2), G.uniqueChance(7)];
      // 保底：2 次没掉，第 3 次必掉，掉了清零（各首领分开计）；再来一轮还是第 3 次
      T.fix(0.999);
      S.tier = 1;
      U.pity = {};
      const seq = [];
      for (let i = 0; i < 6; i++) seq.push(!!G.uniqueDrop(boss('lord'), 32));
      out.seq = seq.map((x) => (x ? 1 : 0)).join('');
      out.pityAfter = U.pity.lord || 0;
      out.weaverUntouched = U.pity.weaver || 0;
      G.uniqueDrop(boss('weaver'), 32);
      out.weaver1 = U.pity.weaver;
      // 走一遍 G.dropLoot（首领的完整掉落里带上烬铸）
      T.unfix();
      T.clearLoot();
      U.pity.warden = G.UNIQUE_DROP.pity;
      G.dropLoot({ isBoss: true, bossKind: 'warden', level: 28, x: P.x, z: P.z - 3 });
      const l = S.loot.find((x) => x.kind === 'item' && x.data.rarity === 3);
      out.full = l ? { uq: l.data.uq, ilvl: l.data.ilvl, color: l.color, label: l.label, beam: l.mesh.children.length } : null;
      out.pityReset = U.pity.warden || 0;
      const bt = document.getElementById('big-toast');
      out.toast = bt ? { on: bt.classList.contains('on'), text: bt.innerText } : null;
      T.clearLoot();
      U.pity = {};
      S.tier = keep.tier;
      return out;
    });
    assert(r.t0.every((x) => !x) && r.pity0 === 0, '层级 0 不应掉落，也不计保底：' + JSON.stringify(r));
    assert(r.t1.join() === 'rongxin,sanxiang,jinduan,wanhun' + (r.t1.length > 4 ? ',jinyu' : '') && r.bow !== false, '首领与烬铸的绑定不对（巨像 → 熔芯、第五区首领 → 烬羽）：' + JSON.stringify([r.kinds, r.t1, r.bow]));
    assert(r.c1a && !r.c1b && r.c2b0 && r.c2a && !r.c2b && r.c5, '掉率不对：' + JSON.stringify(r));
    assert(r.chance.join() === '0,0.15,0.25,0.25', '掉率表不对：' + r.chance);
    assert(r.seq === '001001' && r.pityAfter === 0 && r.weaverUntouched === 0 && r.weaver1 === 1, '保底不对：' + JSON.stringify(r));
    assert(r.full && r.full.uq === 'jinduan' && r.full.ilvl === 28 && r.full.color === G_UQ_COLOR && r.full.beam >= 5 && r.pityReset === 0, '首领完整掉落里的烬铸不对：' + JSON.stringify(r.full));
    assert(r.toast && r.toast.on && /烬断/.test(r.toast.text), '应弹出屏幕中央的大字提示：' + JSON.stringify(r.toast));
    return '保底序列 ' + r.seq + ' · 名牌 ' + r.full.label;
  });

  await step('残刃（烬断）：你的暴击留下可见的残刃层数，叠满 5 层引爆 MARK.mult 倍武器伤害（必定暴击、吃物理伤害提高），波及 MARK.r 米内的别的敌人（MARK.splash 倍），带残刃的敌人倒下时残刃飞到附近的敌人身上；引爆和召唤物 / 异常的命中不叠层；R 上换成烬铸技「千刃归烬」', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state;
      const rare = G.rollItem(44, 2, 'weapon', 6);
      G.save.equip.weapon = rare;
      G.computeStats();
      const out = { wsRare: G.weaponSkill() };
      G.save.equip.weapon = G.rollUnique('jinduan', 44, 0.5);
      G.computeStats();
      out.wsUq = G.weaponSkill();
      out.mech = P.uMech;
      const e = T.mob('husk', 0, -3);
      const near = T.mob('husk', 1.6, -3);
      const far = T.mob('husk', -1 - e.r - G.MARK.r - 1.5, -3);
      for (const o of [e, near, far]) o.buTh = 1e15; // 不触发异常（感电的电弧会打到旁边的靶子，混进波及的伤害里）
      const ctx = G.skillCtx('cleave');
      T.fix(0); // 必定暴击、伤害取下限
      const hits = [];
      const b0 = S.stats.markBursts || 0;
      for (let i = 0; i < 4; i++) {
        const h0 = e.hp;
        G.hitEnemy(e, ctx, 1, { quiet: true });
        hits.push(h0 - e.hp);
      }
      out.marks4 = e.marks;
      G.world.update(1 / 60);
      out.shown = G.world.bladeMarkCount(e.ent);
      // 召唤物 / 异常的命中不叠层
      G.hitEnemy(e, ctx, 1, { quiet: true, minion: {} });
      G.hitEnemy(e, ctx, 1, { quiet: true, proc: true });
      out.marksStill = e.marks;
      const h5 = e.hp;
      G.hitEnemy(e, ctx, 1, { quiet: true });
      const d5 = h5 - e.hp;
      out.bursts = (S.stats.markBursts || 0) - b0;
      out.marksAfter = e.marks;
      out.shownAfter = G.world.bladeMarkCount(e.ent);
      const ws = G.weaponStats(G.save.equip.weapon);
      const PS = P.S;
      const expect = ws.min * G.MARK.mult * (1 + ((PS.incAll || 0) + (PS.incPhys || 0)) / 100) * (1 + (PS.moreDmg || 0) / 100) * (1 - Math.min(90, PS.ownLess || 0) / 100) * ((150 + (PS.critMulti || 0)) / 100);
      out.burst = [Math.round(d5 - hits[3]), Math.round(expect)];
      out.splash = [Math.round(near.maxHp - near.hp), Math.round(expect * G.MARK.splash)];
      out.far = Math.round(far.maxHp - far.hp);
      out.sp = G.MARK.splash;
      // 带残刃的敌人倒下：残刃飞到 MARK.jump 米内最近的敌人身上（远的不算）；够层数就地引爆
      const j1 = T.mob('husk', 0, -10), j2 = T.mob('husk', 2, -10), j3 = T.mob('husk', 2 + G.MARK.jump + 3, -10);
      j1.marks = 3;
      G.killEnemy(j1, {});
      out.jump = [j2.marks || 0, j3.marks || 0, j1.marks || 0];
      const j4 = T.mob('husk', 3, -11);
      j4.marks = G.MARK.max - 3;
      const bj = S.stats.markBursts || 0;
      G.killEnemy(j4, {});
      out.jumpBurst = [(S.stats.markBursts || 0) - bj, j2.marks || 0, Math.round(j2.maxHp - j2.hp) > 0];
      // 不是烬断时暴击不留残刃
      const e2 = T.mob('husk', 2, -3);
      G.save.equip.weapon = rare;
      G.computeStats();
      for (let i = 0; i < 6; i++) G.hitEnemy(e2, ctx, 1, { quiet: true });
      out.rareMarks = e2.marks || 0;
      T.unfix();
      T.arena();
      return out;
    });
    assert(r.mech === 'blade' && r.wsRare === 'flashcut' && r.wsUq === 'ashcuts', '拿着烬断时 R 应是千刃归烬：' + JSON.stringify(r));
    assert(r.marks4 === 4 && r.shown === 4 && r.marksStill === 4, '残刃层数不对（或召唤物 / 异常命中也叠了层）：' + JSON.stringify(r));
    assert(r.bursts === 1 && r.marksAfter === 0 && r.shownAfter === 0, '第 5 层应引爆并清零：' + JSON.stringify(r));
    assert(Math.abs(r.burst[0] - r.burst[1]) <= Math.max(2, r.burst[1] * 0.01), '引爆伤害应为 MARK.mult 倍武器伤害（暴击）：' + JSON.stringify(r.burst));
    assert(r.sp > 0 && Math.abs(r.splash[0] - r.splash[1]) <= Math.max(2, r.splash[1] * 0.01) && r.far === 0, '引爆应只波及周围的敌人（MARK.splash 倍）：' + JSON.stringify({ s: r.splash, far: r.far }));
    assert(r.jump.join() === '3,0,0' && r.jumpBurst[0] === 1 && r.jumpBurst[1] === 0 && r.jumpBurst[2], '倒下时残刃应飞到附近的敌人身上、够层数引爆：' + JSON.stringify({ j: r.jump, b: r.jumpBurst }));
    assert(r.rareMarks === 0, '普通武器不应留残刃');
    return '引爆 ' + r.burst[0] + ' · 波及 ' + r.splash[0];
  });

  await step('三相共鸣（三相之心）：任一元素触发时，半径 TRI.r 内的敌人（含它自己）获得另外两种各 TRI.k 条；共鸣灌满触发的异常不再共鸣（不会无限连锁），之后正常灌满照常共鸣；已感电的续满时间、被灌爆的爆燃沿用源头的火焰伤害；拿着它时首领的异常阈值不变高', async () => {
    const r = await ev(() => {
      T.arena();
      const S = G.state;
      G.save.equip.weapon = G.rollUnique('sanxiang', 44, 0.5);
      G.computeStats();
      const out = { mech: G.player.uMech, k: G.TRI.k };
      const a = T.mob('husk', 0, -4), b = T.mob('husk', 2, -5), far = T.mob('husk', 9, -4);
      const s0 = S.stats.triSpreads || 0;
      G.addBuildUp(a, { cold: a.buTh * 1.05 }, 0);
      out.spread1 = (S.stats.triSpreads || 0) - s0;
      out.a = [a.bu.fire, a.bu.cold, a.bu.light].map((v) => +v.toFixed(2));
      out.b = [b.bu.fire, b.bu.cold, b.bu.light].map((v) => +v.toFixed(2));
      out.far = [far.bu.fire, far.bu.cold, far.bu.light].join();
      out.frozen = a.freeze > 0;
      // 一圈敌人的三条都快满了：一次触发 → 共鸣把它们全部灌满、全部触发，但共鸣只发生这一次
      G.clearEnemies();
      const ring = [];
      for (let i = 0; i < 6; i++) ring.push(T.mob('husk', Math.sin(i) * 2, -5 + Math.cos(i) * 2));
      for (const e of ring) { e.bu.fire = e.bu.cold = e.bu.light = 0.9; e.buT.fire = e.buT.cold = e.buT.light = 3; }
      const s1 = S.stats.triSpreads || 0, f1 = S.stats.freezes || 0, k1 = S.stats.shocks || 0;
      G.addBuildUp(ring[0], { fire: ring[0].buTh * 0.2 }, 0);
      out.chainSpreads = (S.stats.triSpreads || 0) - s1;
      out.chainFreezes = (S.stats.freezes || 0) - f1;
      out.chainShocks = (S.stats.shocks || 0) - k1;
      // 之后玩家的命中正常灌满：照常共鸣
      const e = ring[1];
      e.freeze = 0;
      e.bu.cold = 0.9;
      G.addBuildUp(e, { cold: e.buTh * 0.2 }, 0);
      out.after = (S.stats.triSpreads || 0) - s1;
      // 已在感电中的：不灌，感电时间续满（TRI.refresh）；自己没攒过火焰伤害的被灌爆时按源头攒的火焰伤害爆燃（TRI.heat）
      const heatRun = (heat) => {
        G.clearEnemies();
        const keep = G.TRI.heat;
        G.TRI.heat = heat;
        const src = T.mob('husk', 0, -4), cold = T.mob('husk', -1.6, -4);
        src.buTh = cold.buTh = 1000; // 阈值放大，好让源头攒下一笔看得出的火焰伤害而不灌满
        G.addBuildUp(src, { fire: src.buTh * 0.1 }, 0);
        cold.bu.fire = 1.02 - G.TRI.k; cold.buT.fire = 3;
        const hp = cold.hp, bl = S.stats.blasts || 0;
        G.addBuildUp(src, { cold: src.buTh * 1.05 }, 0);
        G.TRI.heat = keep;
        return { blasts: (S.stats.blasts || 0) - bl, dmg: Math.round(hp - cold.hp) };
      };
      out.heatOn = heatRun(true);
      out.heatOff = heatRun(false);
      G.clearEnemies();
      const rs = T.mob('husk', 0, -4), sh = T.mob('husk', 1.6, -4);
      sh.shockT = 0.5;
      G.addBuildUp(rs, { cold: rs.buTh * 1.05 }, 0);
      out.refresh = +sh.shockT.toFixed(2);
      out.shockFull = G.BUILDUP.shock;
      // 首领：拿着三相之心时正常触发也不让阈值变高（TRI.grow = 0）；普通武器照常变高
      G.clearEnemies();
      const bb = T.mob('brute', 0, -6);
      bb.isBoss = true;
      G.addBuildUp(bb, { fire: bb.buTh * 1.05 }, 0);
      out.growTri = bb.buGrow.fire;
      // 不是三相之心时不共鸣
      G.save.equip.weapon = G.rollItem(44, 2, 'weapon', 1);
      G.computeStats();
      const c = T.mob('husk', -6, -4);
      const s2 = S.stats.triSpreads || 0;
      G.addBuildUp(c, { light: c.buTh * 1.05 }, 0);
      out.rare = (S.stats.triSpreads || 0) - s2;
      G.clearEnemies();
      const bb2 = T.mob('brute', 0, -6);
      bb2.isBoss = true;
      G.addBuildUp(bb2, { fire: bb2.buTh * 1.05 }, 0);
      out.growRare = bb2.buGrow.fire;
      out.grow = G.TRI.grow;
      T.arena();
      return out;
    });
    assert(r.mech === 'tri' && r.spread1 === 1 && r.frozen, '触发冻结应引发一次共鸣：' + JSON.stringify(r));
    assert(r.a[0] === r.k && r.a[2] === r.k && r.b[0] === r.k && r.b[2] === r.k && r.b[1] === 0 && r.far === '0,0,0', '共鸣灌的量 / 范围不对：' + JSON.stringify(r));
    assert(r.chainSpreads === 1 && r.chainFreezes >= 5 && r.chainShocks >= 5, '共鸣灌满触发的异常不应再共鸣：' + JSON.stringify(r));
    assert(r.after === 2 && r.rare === 0, '之后正常触发应照常共鸣、普通武器不共鸣：' + JSON.stringify(r));
    assert(r.refresh === r.shockFull && r.heatOn.blasts === 1 && r.heatOn.dmg > 0 && r.heatOff.blasts === 1 && r.heatOff.dmg === 0, '共鸣应续满感电、被灌爆的爆燃沿用源头的火焰伤害：' + JSON.stringify({ on: r.heatOn, off: r.heatOff, refresh: r.refresh }));
    assert(r.grow === 0 && r.growTri === 1 && r.growRare > 1, '拿着三相之心时首领的异常阈值不应变高：' + JSON.stringify({ t: r.growTri, r: r.growRare }));
    return '一次触发灌满 6 只：冻结 ' + r.chainFreezes + ' / 感电 ' + r.chainShocks + '，共鸣只 1 次';
  });

  await step('魂火轮回（万魂旗）：召唤物倒下炸开（最大生命的 SOULFIRE.k 倍火焰伤害），被替换 / 换区不算；自动召唤不耗魔力；继承武器伤害的比例最多 SOULFIRE.inherit 倍（提高的部分按武器物品等级折算）', async () => {
    const snap = await ev(() => T.buildSnap());
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, save = G.save;
      save.skills.thrall = Math.max(save.skills.thrall || 1, 20);
      save.sockets.thrall = [null, null, null];
      save.bar = ['cleave', 'thrall', null, null];
      const rare = G.rollItem(44, 2, 'weapon', 7);
      const uq = G.rollUnique('wanhun', 44, 0.5);
      const out = {};
      // 继承：同一个 mWeapon，换上万魂旗后比例翻倍
      save.equip.weapon = rare;
      G.computeStats();
      P.S.mWeapon = 40;
      out.inhRare = G.minionInherit(G.SKILLS.thrall).weapon;
      out.capRare = G.skillCtx('thrall').minion.cap;
      save.equip.weapon = uq;
      G.computeStats();
      P.S.mWeapon = 40;
      out.inhUq = G.minionInherit(G.SKILLS.thrall).weapon;
      out.want = 40 * (1 + (G.SOULFIRE.inherit - 1) * (G.SOULFIRE.gated ? G.inheritGate(44) : 1));
      // 物品等级到继承折算满了（46 级起）：比例提高满 SOULFIRE.inherit 倍
      save.equip.weapon = G.rollUnique('wanhun', 60, 0.5);
      G.computeStats();
      P.S.mWeapon = 40;
      out.inhFull = G.minionInherit(G.SKILLS.thrall).weapon;
      save.equip.weapon = uq;
      G.computeStats();
      out.capUq = G.skillCtx('thrall').minion.cap;
      // 魂火：贴着两只怪倒下
      const e1 = T.mob('husk', 0, -5), e2 = T.mob('husk', 1, -5.5), e3 = T.mob('husk', 10, -5);
      const m = G.summonMinion('thrall', P.x, P.z - 4);
      m.x = P.x; m.z = P.z - 5;
      const hp = [e1.hp, e2.hp, e3.hp];
      const sb = S.stats.soulBursts || 0;
      G.hurtMinion(m, 1e9, 'phys', { x: P.x, z: P.z - 8 });
      out.burst = (S.stats.soulBursts || 0) - sb;
      out.dmg = [hp[0] - e1.hp, hp[1] - e2.hp, hp[2] - e3.hp].map(Math.round);
      out.expect = Math.round(m.maxHp * G.SOULFIRE.k);
      // 被替换 / 散掉不算倒下
      const sb2 = S.stats.soulBursts || 0;
      G.clearMinions();
      out.quiet = (S.stats.soulBursts || 0) - sb2;
      // 自动召唤：魔力为 0 也照补（普通魂幡不补）
      G.save.autoSummon.thrall = true;
      G.autoSummonDelay(0);
      P.mana = 0;
      for (let i = 0; i < 90; i++) { P.mana = 0; G.debug.step(1 / 60); }
      out.freeN = G.minionCount('thrall');
      G.clearMinions();
      save.equip.weapon = rare;
      G.computeStats();
      for (let i = 0; i < 90; i++) { P.mana = 0; G.debug.step(1 / 60); }
      out.paidN = G.minionCount('thrall');
      // 普通魂幡：倒下不炸
      const m2 = G.summonMinion('thrall', P.x, P.z - 4);
      const sb3 = S.stats.soulBursts || 0;
      G.hurtMinion(m2, 1e9, 'phys', { x: P.x, z: P.z - 8 });
      out.rareBurst = (S.stats.soulBursts || 0) - sb3;
      G.save.autoSummon.thrall = false;
      T.arena();
      return out;
    });
    await ev((b) => T.buildRestore(b), snap);
    assert(r.inhRare === 40 && Math.abs(r.inhUq - r.want) < 1e-6 && r.inhUq > 40 && Math.abs(r.inhFull - 40 * G_SOUL_INH) < 1e-6 && r.capUq === r.capRare + 1, '继承比例 / 仆从上限不对：' + JSON.stringify(r));
    assert(r.burst === 1 && Math.abs(r.dmg[0] - r.expect) <= 1 && Math.abs(r.dmg[1] - r.expect) <= 1 && r.dmg[2] === 0, '魂火伤害 / 范围不对：' + JSON.stringify(r));
    assert(r.quiet === 0 && r.rareBurst === 0, '散掉的召唤物 / 普通魂幡不应炸：' + JSON.stringify(r));
    assert(r.freeN >= 1 && r.paidN === 0, '万魂旗的自动召唤应不耗魔力：' + JSON.stringify(r));
    return '魂火 ' + r.expect + '（最大生命 × ' + G_SOUL_K + '）· 继承 40% → ' + r.inhUq.toFixed(1) + '%（物品等级 44）/ ' + r.inhFull + '%（60）';
  });

  // ---------- 烬铸技 ----------
  await uiStep('烬铸技：拿着烬铸武器时 R 上的武器技换成它专属的烬铸技（烬断 → 千刃归烬、三相之心 → 三相天灾、万魂旗 → 万魂降临），换回同类普通武器 / 卸下就换回来；R 格带余烬光、写着「烬铸技」；武器提示与技能页写明替换了哪个武器技', async () => {
    await ev(() => { T.arena(); window.__keep = { keepW: G.save.equip.weapon, bag0: G.save.bag.slice() }; });
    const hud = () => ev(() => { const s = document.getElementById('wslot'); return { uskill: s.classList.contains('uskill'), key: s.querySelector('.s-key').textContent, skill: s.dataset.skill }; });
    const r = { pairs: [] };
    for (const uq of ['jinduan', 'sanxiang', 'wanhun']) {
      const p = await ev((uq) => {
        const save = G.save, U = G.UNIQUES[uq];
        const u = G.rollUnique(uq, 40, 0.5), n = G.rollItem(40, 2, 'weapon', U.base);
        save.bag.length = 0;
        save.bag.push(u, n);
        window.__pair = { u, n };
        G.equip(u);
        const ws = G.weaponSkill(), sk = G.SKILLS[ws], normal = G.BASES.weapon[U.base].wskill;
        return { uq, ws, replaces: sk && sk.replaces, normal, flag: !!(sk && sk.uskill && sk.weaponOnly && sk.wtype === G.SKILLS[normal].wtype), notGem: G.GEM_SKILLS.indexOf(ws) < 0, cd: [sk.cd, G.SKILLS[normal].cd] };
      }, uq);
      await frames(2);
      p.hud = await hud();
      p.back = await ev(() => { G.equip(window.__pair.n); return G.weaponSkill(); });
      await frames(2);
      p.hudBack = await hud();
      p.none = await ev(() => { G.unequip('weapon'); return G.weaponSkill(); });
      r.pairs.push(p);
    }
    await ev(() => { const save = G.save; save.bag.length = 0; const u = G.rollUnique('jinduan', 40, 0.5); save.bag.push(u); G.equip(u); });
    for (const p of r.pairs) {
      assert(p.ws === G_USK[p.uq] && p.flag && p.notGem && p.replaces === p.normal, '烬铸技不对：' + JSON.stringify(p));
      assert(p.back === p.normal && p.none === null, '换回普通武器 / 卸下时 R 应换回：' + JSON.stringify(p));
      assert(p.hud.uskill && /烬铸技/.test(p.hud.key) && p.hud.skill === p.ws && !p.hudBack.uskill && /武器技/.test(p.hudBack.key), 'R 格应带余烬光并写「烬铸技」：' + JSON.stringify(p));
      assert(p.cd[0] > p.cd[1], '烬铸技的冷却应比普通武器技长：' + JSON.stringify(p));
    }
    // 悬停身上的烬断：提示里有「烬铸技」与「替换……瞬断」
    await ev(() => { G.ui.open('inv'); });
    await frames(2);
    const eq = await ev(() => T.rect('.eq[data-slot="weapon"]') || T.rect('[data-tip^="eq:weapon"]') || T.rect('.eq'));
    let tip = '';
    if (eq) {
      await page.mouse.move(eq.x, eq.y);
      await frames(4);
      await sleep(450);
      tip = await ev(() => { const t = document.getElementById('tip'); return t ? t.innerText : ''; });
      await page.mouse.move(5, 5);
    }
    assert(/烬铸技/.test(tip) && /千刃归烬/.test(tip) && /瞬断/.test(tip), '武器提示应写明烬铸技替换了瞬断：' + tip.slice(0, 300));
    await ev(() => G.ui.open('skills'));
    await frames(2);
    const sk = await ev(() => { const c = document.querySelector('.wsk-card'); return { cls: c.className, text: c.innerText, bar: document.querySelector('.wbarslot').innerText }; });
    assert(/uskill/.test(sk.cls) && /烬铸技/.test(sk.text) && /替换「瞬断」/.test(sk.text) && /烬铸技/.test(sk.bar), '技能页的武器技一节应换成烬铸技卡片：' + JSON.stringify(sk).slice(0, 300));
    await ev(() => { G.ui.close(); const k = window.__keep; G.save.bag.length = 0; for (const b of k.bag0) G.save.bag.push(b); if (k.keepW) G.save.equip.weapon = k.keepW; G.computeStats(); });
    return r.pairs.map((p) => p.normal + ' → ' + p.ws).join(' · ');
  });

  await step('千刃归烬：附近没有敌人不施放；在敌人之间连闪至多 6 次（闪现途中无敌、落点可走），收刀时斩痕一齐炸开（同一敌人合成一击），带残刃的每层多一截伤害并吃掉残刃；冷却 10 秒；只剩一个目标时来回穿它', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, sk = G.SKILLS.ashcuts, out = {};
      G.save.equip.weapon = G.rollUnique('jinduan', 40, 0.5);
      G.computeStats();
      const run = (n, f) => { for (let i = 0; i < n; i++) { if (f) f(); G.tick(1 / 60); } };
      // 没有敌人：不施放
      P.mana = P.maxMana;
      const m0 = P.mana;
      G.input.tap[4] = 0.3;
      run(20);
      out.empty = { cast: !!P.cast, cd: P.cds.ashcuts || 0, mana: m0 - P.mana };
      // 一群：连闪
      const es = [T.mob('husk', 3, -3), T.mob('husk', -3, -4), T.mob('husk', 1, -7), T.mob('husk', -1, 4), T.mob('husk', 5, 2)];
      es[2].marks = 3;
      for (const e of es) e.buTh = 1e15;
      T.aim(es[0].x, es[0].z);
      for (const k of ['ashHops', 'ashBursts', 'ashCuts', 'ashMarks']) S.stats[k] = 0;
      const hp0 = es.map((e) => e.hp);
      G.input.tap[4] = 0.3;
      let iframeHop = false, walk = true, burstAt = -1, hopsAtBurst = 0;
      const dmgBefore = [];
      for (let i = 0; i < 150; i++) {
        G.tick(1 / 60);
        if (P.cast && P.cast.id === 'ashcuts' && P.cast.data && P.cast.data.mv && P.iframe > 0) iframeHop = true;
        if (!G.world.walkable(P.x, P.z, 0.3)) walk = false;
        if ((S.stats.ashBursts || 0) > 0 && burstAt < 0) { burstAt = i; hopsAtBurst = S.stats.ashHops; }
        if (burstAt < 0) dmgBefore[i] = es.map((e) => e.hp);
      }
      out.pack = { hops: S.stats.ashHops, bursts: S.stats.ashBursts, cuts: S.stats.ashCuts, marks: S.stats.ashMarks, iframeHop, walk, hopsAtBurst, cd: +(P.cdMax.ashcuts || 0).toFixed(2), left: P.cds.ashcuts || 0, mk2: es[2].marks || 0, dmg: es.map((e, i) => Math.round(hp0[i] - e.hp)), cast: !!P.cast };
      // 单体：6 闪都穿过它；炸开那一下 = 6 × cut 倍（合成一击）+ 残刃
      T.arena();
      G.save.equip.weapon = G.rollUnique('jinduan', 40, 0.5);
      G.computeStats();
      const b = T.mob('brute', 0, -4);
      b.buTh = 1e15;
      b.poiseMax = 0; // 不进破绽（破绽中受到的伤害更高）
      b.marks = 2;
      T.aim(b.x, b.z);
      for (const k of ['ashHops', 'ashBursts', 'ashCuts', 'ashMarks']) S.stats[k] = 0;
      T.fix(0.5); // 不暴击、取中值
      G.input.tap[4] = 0.3;
      let before = b.hp, burst = 0;
      for (let i = 0; i < 150; i++) {
        const h = b.hp;
        const n0 = S.stats.ashBursts || 0;
        G.tick(1 / 60);
        if ((S.stats.ashBursts || 0) > n0) burst = h - b.hp;
      }
      T.unfix();
      // 1 倍（不暴击、取中值）的一击
      const ctx = G.skillCtx('ashcuts');
      let pre = 0, ex = 0;
      for (const t in ctx.base) pre += ((ctx.base[t][0] + ctx.base[t][1]) / 2) * Math.max(0, 1 + (ctx.inc[t] || 0) / 100) * (ctx.moreType[t] === undefined ? 1 : ctx.moreType[t]);
      for (const t in ctx.extra) ex += ctx.extra[t];
      const k1 = pre * (1 + ex / 100) * ctx.more;
      out.single = { hops: S.stats.ashHops, cuts: S.stats.ashCuts, marks: S.stats.ashMarks, burst: Math.round(burst), expect: Math.round(k1 * (6 * sk.cut + 2 * sk.mark)), marksLeft: b.marks || 0, total: Math.round(before - b.hp) };
      T.arena();
      return out;
    });
    assert(!r.empty.cast && r.empty.cd === 0 && r.empty.mana === 0, '附近没有敌人时不应施放：' + JSON.stringify(r.empty));
    assert(r.pack.hops >= 4 && r.pack.hops <= 6 && r.pack.bursts === 1 && r.pack.hopsAtBurst === r.pack.hops && r.pack.iframeHop && r.pack.walk, '连闪 / 齐爆不对：' + JSON.stringify(r.pack));
    assert(r.pack.dmg.every((d) => d > 0) && r.pack.marks >= 3 && r.pack.mk2 < 3, '每个被闪到的敌人都应挨打、残刃应被吃掉（炸开那一下暴击可以再留一层）：' + JSON.stringify(r.pack));
    assert(Math.abs(r.pack.cd - 10) < 1e-6 && r.pack.left > 7 && !r.pack.cast, '冷却应为 10 秒、打完收刀：' + JSON.stringify(r.pack));
    assert(r.single.hops === 6 && r.single.cuts === 6 && r.single.marks === 2 && r.single.marksLeft === 0, '单体应来回穿 6 次：' + JSON.stringify(r.single));
    assert(Math.abs(r.single.burst - r.single.expect) <= Math.max(3, r.single.expect * 0.02), '齐爆伤害应为 6 × 斩痕 + 2 × 残刃倍率的武器伤害：' + JSON.stringify(r.single));
    return '怪群 ' + r.pack.hops + ' 闪 / ' + r.pack.cuts + ' 道斩痕 · 单体齐爆 ' + r.single.burst + '（' + r.single.total + ' 合计）';
  });

  await step('三相天灾：准星处 4 秒的风暴，火 / 冰 / 雷轮流落下（每种按自己的元素伤害加成），在怪群里接连触发冻结 / 爆燃 / 感电；首领的阈值照常变高（拿着三相之心也一样），首领不被冻结；冷却 12 秒', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, sk = G.SKILLS.tristorm, out = {};
      G.save.equip.weapon = G.rollUnique('sanxiang', 40, 0.5);
      G.computeStats();
      const es = [T.mob('husk', 0, -6, { hp: 5e4 }), T.mob('husk', 1.5, -7, { hp: 5e4 }), T.mob('husk', -1.5, -7, { hp: 5e4 }), T.mob('husk', 0.5, -8.5, { hp: 5e4 })];
      const far = T.mob('husk', 12, 6);
      T.aim(P.x, P.z - 7);
      for (const k of ['stormHits', 'freezes', 'blasts', 'shocks', 'storms']) S.stats[k] = 0;
      // 记下每一道落击的元素：包一层 hitEnemy（只数风暴自己的落击；感电放电、尸爆这类派生伤害带 proc 标记，不算）。
      // 按「落击」数而不是按「命中」数：一道落击砸中几个敌人只算一次，否则数出来的比例取决于怪群站位，测试会随机失败。
      // 三种元素各用一个上下文；装备上的附加伤害会让每个上下文都带上三种元素，所以按 stormCtx 最先写进 base 的那一种（落击本身的元素）认
      const byCtx = new Map();
      let frame = 0;
      const oh = G.hitEnemy;
      G.hitEnemy = function (e, ctx, m, info) {
        if (ctx && ctx.sk === sk && !(info && info.proc)) {
          if (!byCtx.has(ctx)) byCtx.set(ctx, new Set());
          byCtx.get(ctx).add(frame);
        }
        return oh.apply(this, arguments);
      };
      G.input.tap[4] = 0.3;
      let t = 0;
      try { while (t < 5.5) { frame++; G.tick(1 / 60); t += 1 / 60; } } finally { G.hitEnemy = oh; }
      const seen = {};
      for (const [c, frames] of byCtx) {
        const el = Object.keys(c.base)[0];
        seen[el] = (seen[el] || 0) + frames.size;
      }
      out.pack = { hits: S.stats.stormHits, storms: S.stats.storms, freezes: S.stats.freezes, blasts: S.stats.blasts, shocks: S.stats.shocks, seen, far: far.maxHp - far.hp, cd: P.cdMax.tristorm, dmg: es.map((e) => Math.round(e.maxHp - e.hp)) };
      // 首领：风暴打出来的触发照样让阈值变高，不会被冻结
      T.arena();
      G.save.equip.weapon = G.rollUnique('sanxiang', 40, 0.5);
      G.computeStats();
      const b = G.spawnMob('brute', P.x, P.z - 6, 30, { awake: true });
      b.isBoss = true; b.hp = b.maxHp = 1e6; b.atkCd = 1e9; b.speed = 0;
      G.initBuildUp(b);
      b.buTh = 30; // 门槛压低：每一击都能灌满
      T.aim(b.x, b.z);
      G.input.tap[4] = 0.3;
      let frozen = false;
      t = 0;
      const ue = G.updateEnemies;
      G.updateEnemies = () => {}; // 冒充首领的大块头没有首领的招式表：这段只看异常，不跑怪物 AI
      try { while (t < 5.5) { G.tick(1 / 60); t += 1 / 60; if (b.freeze > 0) frozen = true; } } finally { G.updateEnemies = ue; }
      out.boss = { grow: [b.buGrow.fire, b.buGrow.cold, b.buGrow.light].map((v) => +v.toFixed(2)), trig: [b.buTrig.fire, b.buTrig.cold, b.buTrig.light], frozen, grow0: G.TRI.grow };
      b.isBoss = false;
      T.arena();
      return out;
    });
    assert(r.pack.storms === 1 && r.pack.hits >= 15 && r.pack.far === 0, '风暴应落在准星一带、打出几十击：' + JSON.stringify(r.pack));
    assert(r.pack.seen.fire > 0 && r.pack.seen.cold > 0 && r.pack.seen.light > 0 && Math.min(r.pack.seen.fire, r.pack.seen.cold, r.pack.seen.light) >= 4 && Math.max(r.pack.seen.fire, r.pack.seen.cold, r.pack.seen.light) - Math.min(r.pack.seen.fire, r.pack.seen.cold, r.pack.seen.light) <= 3, '火 / 冰 / 雷应轮流落下（按落击数）：' + JSON.stringify(r.pack.seen));
    assert(r.pack.freezes > 0 && r.pack.blasts > 0 && r.pack.shocks > 0, '怪群里应接连触发冻结 / 爆燃 / 感电：' + JSON.stringify(r.pack));
    assert(Math.abs(r.pack.cd - 12) < 1e-6, '冷却应为 12 秒：' + r.pack.cd);
    assert(r.boss.grow0 === 0 && r.boss.grow.some((g) => g > 1) && !r.boss.frozen, '风暴触发的异常应让首领阈值照常变高、首领不被冻结：' + JSON.stringify(r.boss));
    return '怪群 ' + r.pack.hits + ' 击（火 ' + r.pack.seen.fire + ' / 冰 ' + r.pack.seen.cold + ' / 雷 ' + r.pack.seen.light + '）· 冻结 ' + r.pack.freezes + ' 爆燃 ' + r.pack.blasts + ' 感电 ' + r.pack.shocks + ' · 首领阈值 ×' + r.boss.grow.join('/');
  });

  await step('万魂降临：6 位英灵落在准星一带（按召唤物算、吃召唤物伤害加成、不占仆从上限），8 秒后消散（化作魂火）；现有召唤物治疗到满并狂热；冷却 15 秒', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, S = G.state, sk = G.SKILLS.soulhost, out = {};
      const keep = { skills: Object.assign({}, G.save.skills), sockets: Object.assign({}, G.save.sockets) };
      G.save.equip.weapon = G.rollUnique('wanhun', 40, 0.5);
      G.save.skills.thrall = 30; G.save.sockets.thrall = [null, null, null];
      G.computeStats();
      const th = [G.summonMinion('thrall', P.x - 1.5, P.z + 1.5), G.summonMinion('thrall', P.x + 1.5, P.z + 1.5)];
      for (let i = 0; i < 60; i++) G.tick(1 / 60);
      for (const m of th) m.hp = m.maxHp * 0.3;
      const e = T.mob('husk', 0, -7);
      T.aim(P.x, P.z - 6);
      for (const k of ['champions', 'soulBursts']) S.stats[k] = 0;
      const ctx = G.skillCtx('soulhost');
      out.ctx = { cap: ctx.minion.cap, life: ctx.minion.life, hit: Math.round(G.avgHit(ctx)), m0: Math.round(G.player.S.minionDmg || 0) };
      // 吃召唤物伤害加成
      G.player.S.minionDmg = (G.player.S.minionDmg || 0) + 100;
      out.ctx.hit2 = Math.round(G.avgHit(G.skillCtx('soulhost')));
      G.computeStats();
      G.input.tap[4] = 0.3;
      for (let i = 0; i < 70; i++) G.tick(1 / 60);
      const ws = S.minions.filter((m) => !m.dead && m.kind === 'wraith');
      out.spawn = { n: ws.length, nearCursor: ws.every((m) => Math.hypot(m.x - P.x, m.z - (P.z - 6)) < 5), thrallCount: G.minionCount('thrall'), healed: th.map((m) => +(m.hp / m.maxHp).toFixed(2)), frenzy: G.minionFrenzyState().mult, cd: P.cdMax.soulhost, champs: S.stats.champions, life: ws[0] && ws[0].maxHp, dmg: e.maxHp - e.hp };
      for (let i = 0; i < 9 * 60; i++) G.tick(1 / 60);
      out.after = { wraiths: S.minions.filter((m) => !m.dead && m.kind === 'wraith').length, thralls: G.minionCount('thrall'), soul: S.stats.soulBursts };
      Object.assign(G.save.skills, keep.skills); for (const k in G.save.skills) if (!(k in keep.skills)) delete G.save.skills[k];
      Object.assign(G.save.sockets, keep.sockets);
      T.arena();
      return out;
    });
    // +100% 召唤物伤害：倍率 = (200 + 原有加成) / (100 + 原有加成)（原有加成随前面步骤的装备而变）
    const want = (200 + r.ctx.m0) / (100 + r.ctx.m0);
    assert(r.ctx.cap === 6 && Math.abs(r.ctx.hit2 / r.ctx.hit - want) < 0.03 * want + 1 / r.ctx.hit, '英灵应按召唤物计算（吃召唤物伤害加成）：' + JSON.stringify(r.ctx));
    assert(r.spawn.n === 6 && r.spawn.champs === 6 && r.spawn.nearCursor && r.spawn.thrallCount === 2 && r.spawn.life === r.ctx.life, '应落下 6 位英灵（不占仆从）：' + JSON.stringify(r.spawn));
    assert(r.spawn.healed.every((f) => f > 0.98) && r.spawn.frenzy > 1, '现有召唤物应治疗到满并狂热：' + JSON.stringify(r.spawn));
    assert(Math.abs(r.spawn.cd - 15) < 1e-6 && r.spawn.dmg > 0, '冷却 15 秒、英灵落地应伤到敌人：' + JSON.stringify(r.spawn));
    assert(r.after.wraiths === 0 && r.after.thralls === 2 && r.after.soul >= 6, '8 秒后英灵应消散（魂火炸开），仆从留着：' + JSON.stringify(r.after));
    return '英灵生命 ' + r.ctx.life + ' · 每击 ' + r.ctx.hit + ' · 消散魂火 ' + r.after.soul;
  });

  await step('烬铸技换装冷却：千刃归烬进冷却后换成普通太刀，瞬断带着同样比例的冷却；马上换回烬断，千刃归烬的冷却不会被重置；反过来瞬断进冷却后换上烬断，千刃归烬也带着比例冷却', async () => {
    const r = await ev(() => {
      T.arena();
      const P = G.player, save = G.save, out = {};
      const bag0 = save.bag.slice();
      const run = (n, f) => { for (let i = 0; i < n; i++) { if (f) f(); G.tick(1 / 60); } };
      try {
        const u = G.rollUnique('jinduan', 40, 0.5), k = G.rollItem(40, 0, 'weapon', 6);
        save.bag.length = 0;
        save.bag.push(u, k);
        G.equip(u);
        const e = T.mob('brute', 0, -4);
        e.buTh = 1e15;
        T.aim(e.x, e.z);
        G.input.tap[4] = 0.3;
        run(150, () => T.aim(e.x, e.z));
        const a = P.cds.ashcuts || 0, aMax = P.cdMax.ashcuts || 1;
        G.equip(k);
        const f = P.cds.flashcut || 0, fMax = G.skillCtx('flashcut').cd;
        out.toNormal = { a: +a.toFixed(2), f: +f.toFixed(2), frac: +(f / fMax - a / aMax).toFixed(3) };
        G.input.tap[4] = 0.3;
        run(10, () => T.aim(e.x, e.z));
        out.toNormal.cast = !!(P.cast && P.cast.id === 'flashcut');
        G.equip(u);
        out.back = { a: +(P.cds.ashcuts || 0).toFixed(2), ws: G.weaponSkill() };
        // 反过来：瞬断进冷却后换上烬断
        T.arena();
        save.bag.length = 0;
        save.bag.push(u, k);
        G.equip(k);
        const e2 = T.mob('brute', 0, -4);
        e2.buTh = 1e15;
        G.input.tap[4] = 0.3;
        run(60, () => T.aim(e2.x, e2.z));
        const f2 = P.cds.flashcut || 0, f2Max = P.cdMax.flashcut || 1;
        G.equip(u);
        const a2 = P.cds.ashcuts || 0;
        out.toU = { f: +f2.toFixed(2), a: +a2.toFixed(2), frac: +(a2 / G.skillCtx('ashcuts').cd - f2 / f2Max).toFixed(3) };
      } finally {
        save.bag.length = 0;
        for (const b of bag0) save.bag.push(b);
        T.arena();
      }
      return out;
    });
    assert(r.toNormal.a > 7 && Math.abs(r.toNormal.frac) < 0.02 && !r.toNormal.cast, '换成普通太刀时瞬断应带着同比例的冷却：' + JSON.stringify(r.toNormal));
    assert(r.back.ws === 'ashcuts' && r.back.a >= r.toNormal.a - 0.3, '换回烬断时千刃归烬的冷却不应被重置：' + JSON.stringify(r.back));
    assert(r.toU.f > 3 && Math.abs(r.toU.frac) < 0.02, '瞬断冷却中换上烬断，千刃归烬应带着比例冷却：' + JSON.stringify(r.toU));
    return '千刃归烬 ' + r.toNormal.a + ' 秒 → 瞬断 ' + r.toNormal.f + ' 秒 → 换回 ' + r.back.a + ' 秒';
  });

  await step('存档：烬铸图鉴（拾到过、最高完美度）与保底计数刷新后保留；拾取烬铸记进图鉴；畸形数据被修正（未知 id 丢弃、数值夹回区间、计数截断）', async () => {
    const pre = await ev(() => {
      const save = G.save, P = G.player;
      while (save.bag.length > 30) save.bag.pop();
      save.uniq = { found: {}, best: {}, pity: {} };
      T.clearLoot();
      const it = G.rollUnique('sanxiang', 40, 0.25);
      const l = G.spawnLoot('item', it, P.x + 1, P.z);
      G.pickup(l);
      const it2 = G.rollUnique('sanxiang', 40, 0.75);
      G.pickup(G.spawnLoot('item', it2, P.x + 1, P.z));
      save.uniq.pity = { weaver: 2, warden: 1 };
      G.persist();
      return { uniq: T.canon(save.uniq), uid: it2.uid, pf: Math.round(G.uniquePerfect(it2) * 100) };
    });
    assert(/"found":\{"sanxiang":true\}/.test(pre.uniq) && pre.uniq.indexOf('"sanxiang":' + pre.pf) > 0, '拾取后图鉴没有记下：' + pre.uniq);
    await page.reload({ timeout: 90000 }); // 机器负载高时软件渲染加载很慢
    await install();
    await frames(2);
    const after = await ev((u) => ({ uniq: T.canon(G.save.uniq), item: !!G.save.bag.find((b) => b.uid === u && b.rarity === 3 && b.uq === 'sanxiang') }), pre.uid);
    assert(after.uniq === pre.uniq && after.item, '刷新后图鉴 / 烬铸武器没有保留：' + JSON.stringify(after) + ' vs ' + pre.uniq);
    // 畸形数据：未知烬铸 id 的物品丢弃，数值夹回区间，缺的行补中值；图鉴里的未知 id / 首领、越界数字被修正
    const bad = await ev((key) => {
      const raw = JSON.parse(localStorage.getItem(key));
      const u = raw.bag.find((b) => b.rarity === 3);
      u.affixes[0].v = 99999;
      u.affixes.splice(2, 1);
      u.name = '假名字';
      u.baseIdx = 0;
      raw.bag.push(Object.assign({}, u, { uid: 'zz1', uq: 'nope' }));
      raw.uniq = { found: { sanxiang: true, nope: true, wanhun: 'yes' }, best: { sanxiang: 250, jinduan: -3 }, pity: { weaver: 999, golem: 4, warden: 'x', lord: 2.7, zzz: 1 } };
      localStorage.setItem(key, JSON.stringify(raw));
      // 直接按读档的流程读一遍（刷新页面时游戏会先把内存里的存档写回去）
      G.loadSave();
      G.computeStats();
      return true;
    }, SAVE_KEY);
    assert(bad, '');
    const fixed = await ev(() => {
      const u = G.save.bag.find((b) => b.rarity === 3);
      return {
        n: G.save.bag.filter((b) => b.rarity === 3).length,
        name: u.name, base: u.baseIdx, lines: u.affixes.map((a) => a.id).join(),
        inRange: u.affixes.every((a, i) => { const r = G.uniqueRange(u, i); return a.v >= r[0] && a.v <= r[1]; }),
        top: u.affixes[0].v === G.uniqueRange(u, 0)[1],
        want: G.UNIQUES.sanxiang.lines.map((l) => l.id).join(),
        uniq: T.canon(G.save.uniq),
      };
    });
    assert(fixed.n === 2 && fixed.name === '三相之心' && fixed.base === 1 && fixed.lines === fixed.want && fixed.inRange && fixed.top, '畸形的烬铸武器没有修好：' + JSON.stringify(fixed));
    // 巨像现在也掉烬铸（熔芯）：它的保底计数照常保留、截到上限；不认识的首领丢弃
    assert(fixed.uniq === '{"best":{"sanxiang":100},"found":{"sanxiang":true},"pity":{"golem":2,"lord":2,"weaver":2}}', '畸形的图鉴没有修好：' + fixed.uniq);
    return fixed.uniq;
  });

  await step('删除存档：两步确认后回到全新角色', async () => {
    await page.keyboard.press('KeyM');
    await page.click('[data-act="del-save"]');
    assert(await ev(() => !!document.querySelector('[data-act="del-confirm"]') && G.save.level > 1), '删除存档应先要求确认');
    await page.click('[data-act="del-cancel"]');
    assert(await ev(() => !document.querySelector('[data-act="del-confirm"]')), '取消无效');
    await page.click('[data-act="del-save"]');
    await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.click('[data-act="del-confirm"]')]);
    await install();
    await frames(2);
    const r = await ev(() => ({ sum: G.debug.summary(), open: T.introOpen(), equip: Object.keys(G.save.equip).join(), maxTier: G.save.maxTier }));
    assert(r.sum.player.level === 1 && r.sum.bag === 0 && r.equip === 'weapon' && r.maxTier === 0, '删除后不是全新存档：' + JSON.stringify(r.sum.player));
    assert(r.sum.zone.idx === 0 && r.sum.zone.tier === 0, '删除后应回到第一个区域');
    assert(Object.keys(r.sum.skills).join() === 'cleave,ember' && r.sum.supports.length === 0, '删除后技能没有重置');
    assert(r.open, '全新存档应再次弹出开场卡片');
    await closePanel();
  });

  await step('坏存档：损坏的 JSON 与畸形字段都不会让游戏崩溃', async () => {
    await page.addInitScript((key) => {
      if (window.__badSaveDone) return;
      try {
        const mode = sessionStorage.getItem('__bad') || '0';
        if (mode === '0') localStorage.setItem(key, '{"v":1,"level":');
        else if (mode === '1')
          localStorage.setItem(key, JSON.stringify({
            v: 1, level: 'abc', xp: -5, seenHelp: true,
            bag: [null, 3, { slot: 'weapon', affixes: [{ id: 'nope', tier: 0, v: 1 }], rarity: 1, name: 'x', baseName: 'x', ilvl: 1, uid: 'q1' }, { slot: 'hat', affixes: [] }],
            equip: { weapon: { slot: 'helm', affixes: [] }, ring: { slot: 'ring', affixes: [{ id: 'life', tier: 99, v: 'x' }], rarity: 7, uid: 'q2' } },
            cur: { dust: -3, chaos: 'many' }, skills: { nope: 3, ember: 99 }, supports: ['multi', 'multi', 'zzz'],
            sockets: { ember: ['multi', 'multi', 'brutal'], cleave: 'x' }, bar: ['ember', 'ember', 'nope'],
            passives: ['sk', 'dm1', 'zzz'], cleared: { ash: 'x', frost: 2 }, bossKills: { golem: 1, zzz: 1 },
            tier: 50, maxTier: 2, lastZone: 99, opts: null,
          }));
        sessionStorage.setItem('__bad', String(+mode + 1));
      } catch (e) { /* 忽略 */ }
    }, SAVE_KEY);
    await page.reload({ timeout: 90000 }); // 机器负载高时软件渲染加载很慢
    await install();
    await frames(2);
    let r = await ev(() => ({ level: G.save.level, bar: G.save.bar.slice(), zone: G.state.zone.def.id }));
    assert(r.level === 1 && r.bar[0] === 'cleave' && r.zone === 'ash', '损坏的 JSON 应回退到新存档');
    await page.reload({ timeout: 90000 }); // 机器负载高时软件渲染加载很慢
    await install();
    await frames(2);
    r = await ev(() => {
      const s = G.save;
      G.ui.open('inv');
      const t1 = T.bodyText();
      G.ui.open('skills');
      G.ui.open('tree');
      G.ui.open('map');
      G.ui.close();
      G.debug.step(1);
      return {
        level: s.level, xp: s.xp, bag: s.bag.length, equip: Object.keys(s.equip).join(), dust: s.cur.dust, chaos: s.cur.chaos,
        skills: T.canon(s.skills), sups: s.supports.join(), sockets: T.canon(s.sockets), bar: s.bar.join(), passives: s.passives.join(),
        tier: s.tier, maxTier: s.maxTier, lastZone: s.lastZone, zone: G.state.zoneIdx, nz: G.ZONES.length, ok: !/undefined|NaN/.test(t1),
      };
    });
    assert(r.level === 1 && r.xp === 0 && r.bag === 0 && r.dust === 0 && r.chaos === 0, '畸形数值没有被修正：' + JSON.stringify(r));
    assert(r.skills === '{"ember":45}' && r.sups === 'multi' && r.sockets === '{"ember":["multi",null,null],"wbasic":[null,null,null]}' && r.bar === 'ember,,,', '畸形技能数据没有被修正：' + JSON.stringify(r));
    assert(r.passives === 'start' && r.tier === 2 && r.maxTier === 2 && r.lastZone === r.nz - 1 && r.zone === r.nz - 1 && r.ok, '畸形进度数据没有被修正：' + JSON.stringify(r));
  });

  await step('localStorage 不可用时游戏照常运行', async () => {
    await page.addInitScript(() => {
      const boom = () => { throw new Error('storage blocked'); };
      Storage.prototype.getItem = boom;
      Storage.prototype.setItem = boom;
      Storage.prototype.removeItem = boom;
    });
    await page.reload({ timeout: 90000 }); // 机器负载高时软件渲染加载很慢
    await install();
    await frames(2);
    const r = await ev(() => {
      const ok = G.persist();
      G.debug.step(1);
      G.ui.open('inv');
      G.ui.close();
      G.resetSave();
      return { ok, level: G.save.level, zone: G.state.zone.def.id, open: T.tab() };
    });
    assert(r.ok === false && r.level === 1 && r.zone === 'ash', JSON.stringify(r));
  });
}

main()
  .catch((e) => {
    failed++;
    console.log('FAIL 测试脚本自身出错 — ' + (e && e.stack ? e.stack : e));
  })
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    console.log('\n' + (failed ? '失败 ' + failed + ' 项，' : '') + '通过 ' + passed + ' 项');
    process.exit(failed ? 1 : 0);
  });
