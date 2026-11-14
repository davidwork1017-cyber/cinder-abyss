// 端到端冒烟测试：无头 Chrome 里把整个游戏流程走一遍。
// 每一步打印一行 ok / FAIL；任何一步失败或页面出现报错，进程以非 0 退出。
import { launch } from './harness.mjs';

const SAVE_KEY = 'cinder-abyss-save-v1';
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
      // 清空当前区域的敌人和杂物，玩家回到起点、满状态
      arena() {
        G.clearMinions(); // 上一步召出来的召唤物不带进这一步
        G.clearEnemies();
        G.respawn();
        T.clearLoot();
        P.iframe = 0;
        P.cds = {};
        G.computeStats();
        P.life = P.maxLife;
        P.mana = P.maxMana;
        P.flask.life = P.flask.mana = 3;
        T.settle();
      },
      // 一只打不死、不会动的靶子
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
        return JSON.stringify({ skills: s.skills, supports: s.supports, sockets: s.sockets, bar: s.bar });
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

const SKILL_IDS = ['cleave', 'ember', 'blade', 'nova', 'arc', 'meteor', 'blink', 'whirl', 'thrall', 'colossus'];
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
      out.sup = save.supports.length === 1 && S.loot.indexOf(sup) < 0;
      T.tp(cur.x, cur.z);
      G.debug.step(0.1);
      out.cur = save.cur[cur.data] === curN + 1 && S.loot.indexOf(cur) < 0;
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
  await step('learnAll：10 个技能与 19 个辅助宝石全部到手', async () => {
    const r = await ev(() => {
      G.debug.learnAll();
      return { skills: Object.keys(G.save.skills).length, sups: G.save.supports.length, bar: G.save.bar.slice() };
    });
    assert(r.skills === 10 && r.sups === 19 && r.bar.every((b) => b), JSON.stringify(r));
  });

  for (let i = 0; i < SKILL_IDS.length; i++) {
    const id = SKILL_IDS[i];
    const slot = i % 4;
    await step('技能：' + id + ' 绑定到' + INPUT_NAME[slot] + '，按住后对敌人造成伤害', async () => {
      const dist = id === 'cleave' || id === 'whirl' ? 2.4 : 5;
      const s = await ev(([id, slot, dist]) => {
        T.arena();
        G.debug.god(true);
        const ok = G.bindSkill(slot, id);
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
          px: G.player.x, awake: T.d.awake, chill: T.d.chill,
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
      if (id === 'nova') assert(r.chill > 0, '霜环没有施加冰缓');
      return '伤害 ' + Math.round(r.dmg) + '，消耗 ' + s.cost;
    });
  }

  await step('旋风斩：按住持续旋转、身边一圈全中、边转边走；松手 / 翻滚 / 换技能 / 魔力耗尽即停', async () => {
    const r = await ev(() => {
      T.arena();
      G.debug.god(true);
      const P = G.player, W = G.world, inp = G.input, out = {};
      const bar0 = G.save.bar.slice();
      G.bindSkill(0, 'whirl');
      G.bindSkill(2, 'nova');
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
        out.back = !!(P.cast && P.cast.channel); // 左键一直按着：放完霜环又转起来
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
    assert(r.interrupt === 'nova' && r.back, '按别的技能应打断旋转，放完继续转：' + JSON.stringify(r));
    assert(r.noMana, '魔力不足应停下：' + JSON.stringify(r));
    return '一秒转出 ' + r.pulses + ' 下，四周各受 ' + r.ringHit.join('/') + ' 伤害';
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
      G.debug.step(3);
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
    assert(r.nodes >= 8 && r.nodes <= 10, '统御支路应有 8–10 个节点：' + r.nodes);
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
        if (w.baseIdx === 0) { out.bladeN++; out.blade += has ? 1 : 0; } else { out.staffN++; out.staff += has ? 1 : 0; }
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

  await step('通货：7 种通货都能通过背包界面改造合适的物品', async () => {
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
    assert(s.btn.dust && s.btn.alch && !s.btn.augment && !s.btn.regal && !s.btn.exalt && !s.btn.chaos && !s.btn.divine, '普通物品的可用通货不对：' + JSON.stringify(s.btn));
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
        kinds: ['it-', 'cur-', 'sk-', 'sup-', 'ail-'].map((p) => keys.filter((k) => k.startsWith(p)).length).join(),
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
    assert(r.kinds === '31,7,10,19,5', '图标数量不对（装备 31 / 通货 7 / 技能 10 / 辅助 19 / 异常 5）：' + r.kinds);
    assert(r.cellIcons === 8 && r.cellOk && r.distinct === 8, '背包格图标不对：' + JSON.stringify(r));
    assert(r.minSize >= 44 && r.maxSize <= 64, '背包格图标应在 44–64 像素之间：' + r.minSize + '–' + r.maxSize);
    assert(r.eq === 8 && r.cur === 7 && r.craft === 7 && r.head && r.glyphLeft === 0, '装备栏 / 通货 / 改造按钮 / 详情没有全部换成图标：' + JSON.stringify(r));
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
        for (const id of save.bar) if (id) o[id] = G.skillDps(G.skillCtx(id));
        return o;
      };
      const snap = () => ({ dps: dps(), life: P.maxLife, armour: P.armour, res: P.res.fire + P.res.cold + P.res.light, mana: P.maxMana });
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
        // 秒伤变化不到 0.5% 的不单列一行（噪音）
        for (const id in a.dps) if (!(a.dps[id] > 0) || Math.abs(b.dps[id] / a.dps[id] - 1) >= 0.005) put(G.SKILLS[id].name + ' 秒伤', b.dps[id] - a.dps[id]);
        put('最大生命', b.life - a.life);
        put('护甲', b.armour - a.armour);
        put('元素抗性合计', b.res - a.res);
        put('最大魔力', b.mana - a.mana);
        const got = {};
        for (const l of v.lines) if (/秒伤$|^最大生命$|^护甲$|^元素抗性合计$|^最大魔力$/.test(l.label)) got[l.label] = parseFloat(l.text);
        const ser = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
        if (ser(want) !== ser(got)) out.wrong.push({ want, got });
        if ((v.badge === 'up') !== (v.score > 0.5) || (v.badge === 'down') !== (v.score < -0.5)) out.badgeBad++;
        if (v.lines.some((l) => l.good !== parseFloat(l.text) > 0)) out.badgeBad++;
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
    assert(r2.on && r2.rows === 6 && r2.now === 1 && r2.txt.includes('本阶范围'), '悬停词缀应说明各阶范围：' + JSON.stringify(r2));
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

  await step('技能页：界面绑定按键；镶嵌 / 取下辅助宝石会改变 G.skillCtx', async () => {
    await ev(() => {
      for (const id of Object.keys(G.save.sockets)) G.save.sockets[id] = [null, null, null];
      G.computeStats();
    });
    await page.keyboard.press('KeyG');
    cleanText(await ev(() => T.bodyText()), '技能页');
    assert((await ev(() => document.querySelectorAll('.skill-card').length)) === 10, '技能卡数量不对');
    await page.click('[data-act="bind"][data-skill="nova"][data-slot="2"]');
    let r = await ev(() => ({ bar: G.save.bar.slice(), on: document.querySelector('[data-act="bind"][data-skill="nova"][data-slot="2"]').classList.contains('on') }));
    assert(r.bar[2] === 'nova' && r.on && r.bar.filter((b) => b === 'nova').length === 1, '界面绑定失败：' + r.bar);
    await until(() => document.querySelectorAll('#slots .slot')[2].dataset.skill === 'nova').catch(() => {
      throw new Error('HUD 技能栏没有同步');
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
      echo: (G.socketSupport('nova', 0, 'echo'), G.skillCtx('nova').echo),
      area: (G.socketSupport('nova', 1, 'expanse'), G.skillCtx('nova').area),
      cdr: (G.socketSupport('meteor', 0, 'frugal'), G.skillCtx('meteor').cd),
    }));
    assert(misc.unfit === false && misc.echo === 1 && Math.abs(misc.area - 1.4) < 1e-9 && Math.abs(misc.cdr - 2.25) < 1e-9, '辅助效果不对：' + JSON.stringify(misc));
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
      mid = await ev(() => ({ lit: document.querySelectorAll('.sock.drop-ok').length, dim: document.querySelectorAll('.sock.drop-no').length, cap: document.querySelector('#drag-ghost em').textContent }));
    });
    assert(mid.lit === 6 && mid.dim === 24 && mid.cap === '镶进 掷焰', '拖辅助宝石时只有带「投射物」标签的技能的槽应亮起：' + JSON.stringify(mid));
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
    assert(r.txt.includes('霜环') && r.txt.includes('冰缓周围所有敌人') && r.txt.includes('新技能') && r.txt.includes('基础伤害'), '技能宝石的地面提示应说明它做什么');
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
      e.freeze = 1e9;
      e.shock = 1e9;
      e.burn = 0.001;
      e.burnT = 1e9;
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
    assert(r.cls.includes('elite') && r.txt.includes('精英巨躯') && r.txt.includes('Lv 3') && r.txt.includes('精英') && r.txt.includes('点燃') && r.txt.includes('冻结') && r.txt.includes('感电') && r.icons === 3, '名牌内容不对：' + r.txt);
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
      b.chill = 1e9; // 首领不会被冻结，用冰缓
      b.shock = 1e9;
      b.burn = 0.001;
      b.burnT = 1e9;
      b.hp = b.maxHp = 1e7;
    });
    await until(() => document.getElementById('boss-box').classList.contains('on') && document.querySelectorAll('#boss-ail .ail .ico').length === 3).catch(() => {
      throw new Error('首领血条上没有异常状态图标');
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
      G.save.tut = {};
      G.ui.refresh();
      G.debug.hold(false);
      return k;
    });
    await page.mouse.move(900, 450);
    await shown('move');
    let r = await hint();
    assert(r.txt.includes('移动') && r.all.length === 15, '第一条提示应是移动：' + r.txt);
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
      G.save.tut = { move: 1, attack: 1, bag: 1, craft: 1, support: 1, passive: 1, combo: 1, poise: 1 };
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
      G.save.tut = { move: 1, attack: 1, dodge: 1, combo: 1, poise: 1, loot: 1, bag: 1, craft: 1, support: 1, execute: 1, boss: 1, portal: 1 };
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
      T.fix(0.5); // 身上随机装备的附加元素伤害可能点燃 / 感电靶子，多出几跳伤害：随机数钉死
      const P = G.player;
      T.dummy(3, 0);
      G.input.mouse.wx = 3;
      G.input.mouse.wz = 0;
      P.mana = P.maxMana;
      const cost = G.skillCtx('nova').cost;
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
      G.socketSupport('nova', 0, null);
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
      G.hitEnemy = function (e, c, m) {
        hits.push(e);
        return hitEnemy(e, c, m);
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
      G.bindSkill(2, 'nova');
      G.bindSkill(3, null);
      for (const k of Object.keys(G.save.sockets)) G.save.sockets[k] = [null, null, null];
      G.computeStats();
      T.mob('husk', 2.4, 0);
      T.settle();
    });
    await aim();
    // 1. 挥砍途中按 Q：收招一到可取消的时刻就放出霜环
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })));
    let r = await ev(() => { for (let i = 0; i < 6; i++) G.tick(1 / 60); const c = G.player.cast; return { id: c && c.id, step: c && c.step, t: c && c.t, cancelT: c && c.cancelT, fireT: c && c.fireT }; });
    assert(r.id === 'cleave' && r.step === 0 && r.t < r.fireT, '点击左键没有开始第一段：' + JSON.stringify(r));
    await page.keyboard.press('KeyQ');
    let b = await ev(() => {
      const P = G.player;
      const c0 = P.cast, tap = G.input.tap[2];
      let at = -1, mana0 = P.mana;
      for (let i = 0; i < 60 && at < 0; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'nova') at = c0.t; }
      for (let i = 0; i < 40; i++) G.tick(1 / 60);
      return { tap, at, cancelT: c0.cancelT, dur: c0.dur, spent: mana0 - P.mana, held: !!G.input.keys.KeyQ };
    });
    assert(b.tap > 0.2 && !b.held, '按下 Q 应记入缓冲：' + JSON.stringify(b));
    assert(b.at >= b.cancelT - 1e-6 && b.at < b.cancelT + 0.06 && b.at < b.dur - 0.05 && b.spent > 5, '缓冲的霜环应在挥砍可取消的那一刻（' + b.cancelT.toFixed(2) + ' 秒）放出，实际 ' + b.at.toFixed(2) + '：' + JSON.stringify(b));
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
      for (let i = 0; i < 90 && at < 0; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'nova') at = c0.t; }
      for (let i = 0; i < 40; i++) G.tick(1 / 60);
      return { tap, at, cancelT: c0.cancelT, spent: m0 - P.mana, want: G.bufferTime('cast') };
    });
    assert(r.tap > r.cancelT - 0.06 && r.tap < 0.9, '终结技途中按下的输入，缓冲应覆盖到它可以接招为止：' + JSON.stringify(r));
    assert(r.at >= r.cancelT - 1e-6 && r.at < r.cancelT + 0.06 && r.spent > 5, '终结技起手时轻点的霜环应在可接招的那一刻放出：' + JSON.stringify(r));
    assert(Math.abs(r.want - 0.3) < 1e-6, '手上没有动作时缓冲应回到 0.3 秒：' + r.want);
    //    掷焰（法术）途中轻点 Q 也一样
    await ev(() => { G.debug.step(1); G.player.mana = G.player.maxMana; });
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })), { button: 'right' });
    r = await ev(() => { for (let i = 0; i < 2; i++) G.tick(1 / 60); const c = G.player.cast; return { id: c && c.id, t: c && c.t }; });
    assert(r.id === 'ember' && r.t < 0.06, '右键没有开始掷焰：' + JSON.stringify(r));
    await page.keyboard.press('KeyQ');
    r = await ev(() => { const P = G.player; let nova = false; for (let i = 0; i < 70; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'nova') nova = true; } return { nova }; });
    assert(r.nova, '掷焰起手时轻点的霜环被吃掉了');
    //    等不到的输入照样过期：技能还在冷却、离转好还远
    await ev(() => { const P = G.player; G.debug.step(1); P.mana = P.maxMana; P.cds.nova = 2; P.cdMax.nova = 2; });
    await page.keyboard.press('KeyQ');
    r = await ev(() => { const P = G.player; const tap = G.input.tap[2], m0 = P.mana; let nova = false; for (let i = 0; i < 200; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'nova') nova = true; } return { tap, nova, cd: P.cds.nova, spent: m0 - P.mana }; });
    assert(r.tap > 0.2 && r.tap < 0.35 && !r.nova && r.cd === 0, '过期的缓冲不应再放出技能：' + JSON.stringify(r));
    //    挥砍途中按了 Q 又翻滚：翻滚之前缓冲着的技能作废，滚完不会突然放出来
    await ev(() => { const P = G.player; P.mana = P.maxMana; P.roll.cd = 0; });
    await page.mouse.click(...Object.values(await ev(() => { const p = T.scr(G.player.x + 4, G.player.z); return { x: Math.round(p.x), y: Math.round(p.y) }; })));
    await ev(() => { for (let i = 0; i < 4; i++) G.tick(1 / 60); });
    await page.keyboard.press('KeyQ');
    r = await ev(() => ({ tap: G.input.tap[2], cast: G.player.cast && G.player.cast.id }));
    assert(r.tap > 0.2 && r.cast === 'cleave', '挥砍途中按 Q 应记入缓冲：' + JSON.stringify(r));
    await page.keyboard.press('Space');
    r = await ev(() => { const P = G.player; const o = { tap: G.input.tap[2], roll: P.roll.t > 0 }; let nova = false; for (let i = 0; i < 80; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'nova') nova = true; } o.nova = nova; return o; });
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
      for (let i = 0; i < 70; i++) { G.tick(1 / 60); if (P.cast && P.cast.id === 'nova') nova = true; }
      o.nova = nova;
      o.spent = m0 - P.mana;
      return o;
    });
    assert(r.tap === '0,0,0,0' && r.dodge === 0 && r.exec === 0 && !r.nova && r.spent <= 0, '打开面板后缓冲的输入应全部清空：' + JSON.stringify(r));
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
    assert(r.dead && r.tap === '0,0,0,0' && r.dodge === 0 && r.exec === 0, '倒下时应清空缓冲的输入：' + JSON.stringify(r));
    assert(r.stop === 0 && r.slow === 0 && r.k === 1, '倒下时顿帧 / 慢动作应一并结束：' + JSON.stringify(r));
    assert(r.alive && !r.acted, '重生后不应自动放出死前缓冲的动作：' + JSON.stringify(r));
    return '霜环在 ' + b.at.toFixed(2) + ' 秒接上（可取消时刻 ' + b.cancelT.toFixed(2) + '）';
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
    assert(!r.exec && r.slow === 0 && r.stop === 0 && r.k === 1 && r.tap === '0,0,0,0|0' && r.at < 0.01 && r.clip !== 'execute', '换区时处决 / 顿帧 / 慢动作 / 缓冲应全部清掉：' + JSON.stringify(r));
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
      window.__M.shock = 1e9;
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

  await step('轮回：选择层级 1 进入灰烬荒原，怪物等级接着上一层的末区往上走（+16）', async () => {
    await page.click('[data-act="tier"][data-tier="1"]');
    const m = await ev(() => ({
      txt: T.bodyText(),
      locked: document.querySelectorAll('.zone.locked').length,
      enter: document.querySelectorAll('[data-act="enter"]').length,
    }));
    assert(/怪物等级\s*17/.test(m.txt) && /怪物等级\s*29/.test(m.txt), '层级 1 的地图没有显示怪物等级 17 … 29');
    const lv = await ev(() => ({ step: G.TIER_LEVELS, first: G.ZONES[0].level, last: G.ZONES[G.ZONES.length - 1].level }));
    assert(lv.first + lv.step > lv.last, '轮回层级 1 的首区（' + (lv.first + lv.step) + '）不应比层级 0 的末区（' + lv.last + '）低');
    assert(m.enter === 1 && m.locked === 3, '层级 1 应只解锁第一个区域');
    await page.click('[data-act="enter"][data-zone="0"]');
    const r = await ev(() => {
      const S = G.state;
      return { open: G.ui.isOpen(), tier: S.tier, level: S.zone.level, bossLv: S.boss.level, hp: S.boss.maxHp, saveTier: G.save.tier, sub: document.getElementById('zone-sub').textContent };
    });
    assert(!r.open && r.tier === 1 && r.level === 17 && r.bossLv === 20 && r.saveTier === 1, '轮回层级进入不对：' + JSON.stringify(r));
    await until(() => /17/.test(document.getElementById('zone-sub').textContent)).catch(() => {
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

  await step('资源：反复切换四个区域，几何体 / 贴图 / 场景对象不增长', async () => {
    const r = await ev(() => {
      const W = G.world, S = G.state;
      const cyc = () => {
        for (let i = 0; i < 4; i++) {
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
    assert(r.geo <= 3 && r.tex <= 1, '切换 8 次区域后几何体 +' + r.geo + '，贴图 +' + r.tex);
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
        const it = G.debug.giveItem(2, slot);
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
    await page.reload();
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
    assert(r.live === snap.live, '刷新后的存档与刷新前不一致');
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
    await page.reload();
    await install();
    await frames(2);
    let r = await ev(() => ({ level: G.save.level, bar: G.save.bar.slice(), zone: G.state.zone.def.id }));
    assert(r.level === 1 && r.bar[0] === 'cleave' && r.zone === 'ash', '损坏的 JSON 应回退到新存档');
    await page.reload();
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
        tier: s.tier, maxTier: s.maxTier, lastZone: s.lastZone, zone: G.state.zoneIdx, ok: !/undefined|NaN/.test(t1),
      };
    });
    assert(r.level === 1 && r.xp === 0 && r.bag === 0 && r.dust === 0 && r.chaos === 0, '畸形数值没有被修正：' + JSON.stringify(r));
    assert(r.skills === '{"ember":20}' && r.sups === 'multi' && r.sockets === '{"ember":["multi",null,null]}' && r.bar === 'ember,,,', '畸形技能数据没有被修正：' + JSON.stringify(r));
    assert(r.passives === 'start' && r.tier === 2 && r.maxTier === 2 && r.lastZone === 3 && r.zone === 3 && r.ok, '畸形进度数据没有被修正：' + JSON.stringify(r));
  });

  await step('localStorage 不可用时游戏照常运行', async () => {
    await page.addInitScript(() => {
      const boom = () => { throw new Error('storage blocked'); };
      Storage.prototype.getItem = boom;
      Storage.prototype.setItem = boom;
      Storage.prototype.removeItem = boom;
    });
    await page.reload();
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
